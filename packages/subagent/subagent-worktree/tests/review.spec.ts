import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { GitRunner } from '../src/git.ts'
import { callerRouteOf, runReviewer } from '../src/review.ts'
import { fakeAgent, git, initFixtureRepo, removeFixture } from './harness.ts'
import { mountScriptedReviewer } from './scripted-reviewer.ts'
import type { ScriptedVerdict } from './scripted-reviewer.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function setup(verdicts: readonly ScriptedVerdict[], onStart?: (request: SubagentStartRequest) => void) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SubagentRuntime)
  await mountScriptedReviewer(ctx, { verdicts, ...onStart === undefined ? {} : { onStart } })
  return { ctx, git: new GitRunner(ctx.subprocess) }
}

const signal = new AbortController().signal
const REVIEWER_ROUTE = { provider: 'reviewer-provider', model: 'reviewer-model' }

/** A real two-commit fixture repo: `base` is empty, `head` adds one file — a valid diffable range. */
async function diffOfSize(byteLength: number): Promise<{ dir: string; base: string; head: string }> {
  const dir = await initFixtureRepo('dsh-review-diff-')
  cleanups.push(() => removeFixture(dir))
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD').trim()
  await writeFile(join(dir, 'change.txt'), 'a'.repeat(byteLength))
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  return { dir, base, head }
}

describe('callerRouteOf', () => {
  it('maps the parent Agent\'s effective options to a WorktreeRoute', () => {
    const parent = fakeAgent('caller-1', { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') })
    expect(callerRouteOf(parent)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('omits reasoningEffort when the parent has none', () => {
    const parent = fakeAgent('caller-2', { provider: 'p', model: 'm' })
    expect(callerRouteOf(parent)).toEqual({ provider: 'p', model: 'm' })
  })

  it('throws when the parent has no effective provider and model', () => {
    const parent = fakeAgent('caller-3', {})
    expect(() => callerRouteOf(parent)).toThrow(
      'subagent-worktree: cannot resolve a reviewer route because the accepting agent has no effective provider and model yet',
    )
  })
})

describe('runReviewer', () => {
  it('returns a pass verdict bound to the exact commit and reviewer identity', async () => {
    const { dir, base, head } = await diffOfSize(10)
    const { ctx, git: runner } = await setup([{ structured: { verdict: 'pass', summary: 'looks good', checks: ['tests: ok'], findings: [] } }])
    const parent = fakeAgent('parent-pass')
    const verdict = await runReviewer(ctx, runner, {
      parent, reviewDir: dir, commit: head, baseCommit: base, task: 'do it',
      label: 'do it', reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes: 1024, signal,
    })
    expect(verdict.verdict).toBe('pass')
    expect(verdict.summary).toBe('looks good')
    expect(verdict.commit).toBe(head)
    expect(verdict.reviewerRoute).toEqual(REVIEWER_ROUTE)
    expect(typeof verdict.reviewerSessionId).toBe('string')
    expect(verdict.at).toBeGreaterThan(0)
  }, 20_000)

  it('forwards reviewerRoute.reasoningEffort to the reviewer child\'s agentOptions', async () => {
    const { dir, base, head } = await diffOfSize(10)
    let captured: SubagentStartRequest | undefined
    const { ctx, git: runner } = await setup(
      [{ structured: { verdict: 'pass', summary: 's', checks: [], findings: [] } }],
      (request) => { captured = request },
    )
    await runReviewer(ctx, runner, {
      parent: fakeAgent('parent-effort'), reviewDir: dir, commit: head, baseCommit: base, task: 'do it', label: 'do it',
      reviewerRoute: { ...REVIEWER_ROUTE, reasoningEffort: ReasoningEffortId('high') }, reviewDiffMaxBytes: 1024, signal,
    })
    expect(captured?.agentOptions).toEqual({ provider: REVIEWER_ROUTE.provider, model: REVIEWER_ROUTE.model, reasoningEffort: 'high' })
  })

  it('returns a fail verdict with the reviewer\'s findings', async () => {
    const { dir, base, head } = await diffOfSize(10)
    const { ctx, git: runner } = await setup([{ structured: { verdict: 'fail', summary: 'broken', checks: [], findings: ['x.ts: does not compile'] } }])
    const verdict = await runReviewer(ctx, runner, {
      parent: fakeAgent('parent-fail'), reviewDir: dir, commit: head, baseCommit: base,
      task: 'do it', label: 'do it', reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes: 1024, signal,
    })
    expect(verdict).toMatchObject({ verdict: 'fail', findings: ['x.ts: does not compile'] })
  }, 20_000)

  it('fails closed when the reviewer returns no structured value', async () => {
    const { dir, base, head } = await diffOfSize(10)
    const { ctx, git: runner } = await setup([{}])
    const verdict = await runReviewer(ctx, runner, {
      parent: fakeAgent('parent-missing'), reviewDir: dir, commit: head, baseCommit: base,
      task: 'do it', label: 'do it', reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes: 1024, signal,
    })
    expect(verdict.verdict).toBe('fail')
    expect(verdict.findings).toEqual(['the reviewer returned no structured verdict'])
  }, 20_000)

  it('fails closed when the structured value does not match the verdict shape', async () => {
    const { dir, base, head } = await diffOfSize(10)
    const { ctx, git: runner } = await setup([{ structured: { verdict: 'maybe', summary: 1, checks: 'nope' } }])
    const verdict = await runReviewer(ctx, runner, {
      parent: fakeAgent('parent-malformed'), reviewDir: dir, commit: head, baseCommit: base,
      task: 'do it', label: 'do it', reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes: 1024, signal,
    })
    expect(verdict.verdict).toBe('fail')
    expect(verdict.findings).toEqual(['the reviewer returned no structured verdict'])
  }, 20_000)

  it('fails closed when the run does not complete (no structured capture)', async () => {
    const { dir, base, head } = await diffOfSize(10)
    const { ctx, git: runner } = await setup([{ stopReason: 'error' }])
    const verdict = await runReviewer(ctx, runner, {
      parent: fakeAgent('parent-error'), reviewDir: dir, commit: head, baseCommit: base,
      task: 'do it', label: 'do it', reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes: 1024, signal,
    })
    expect(verdict.verdict).toBe('fail')
  }, 20_000)

  describe('reviewer diff bounds', () => {
    async function reviewedPrompt(
      dir: string, base: string, head: string, reviewDiffMaxBytes: number,
    ): Promise<{ prompt: string; verdict: string }> {
      let captured: SubagentStartRequest | undefined
      const { ctx, git: runner } = await setup(
        [{ structured: { verdict: 'pass', summary: 's', checks: [], findings: [] } }],
        (request) => { captured = request },
      )
      const verdict = await runReviewer(ctx, runner, {
        parent: fakeAgent('parent-diff'), reviewDir: dir, commit: head, baseCommit: base, task: 'do it', label: 'do it',
        reviewerRoute: REVIEWER_ROUTE, reviewDiffMaxBytes, signal,
      })
      const block = captured?.prompt[0]
      const prompt = block?.type === 'text' ? block.text : ''
      return { prompt, verdict: verdict.verdict }
    }

    it('embeds a tiny diff in full, with no truncation notice', async () => {
      const { dir, base, head } = await diffOfSize(10)
      const { prompt } = await reviewedPrompt(dir, base, head, 1024)
      expect(prompt).toContain('a'.repeat(10))
      expect(prompt).not.toContain('[diff truncated')
    }, 20_000)

    it('embeds a diff exactly at the byte bound in full, with no truncation notice', async () => {
      const { dir, base, head } = await diffOfSize(200)
      // The exact byte length of the complete diff text is the tightest possible non-truncating bound.
      const rawDiff = git(dir, 'diff', `${base}..${head}`)
      const exactBudget = Buffer.byteLength(rawDiff, 'utf8')
      const { prompt } = await reviewedPrompt(dir, base, head, exactBudget)
      expect(prompt).not.toContain('[diff truncated')
    }, 20_000)

    it('truncates an oversized diff and appends the truncation notice naming the exact git diff command', async () => {
      const { dir, base, head } = await diffOfSize(5000)
      const { prompt } = await reviewedPrompt(dir, base, head, 200)
      expect(prompt).toContain(`[diff truncated; read the remaining changes with \`git diff ${base}..${head}\`]`)
    }, 20_000)

    it('cuts a multibyte character at the byte bound on a UTF-8 boundary, never splitting it', async () => {
      const dir = await initFixtureRepo('dsh-review-diff-multibyte-')
      cleanups.push(() => removeFixture(dir))
      git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
      const base = git(dir, 'rev-parse', 'HEAD').trim()
      // Each 'é' is 2 UTF-8 bytes; enough repeats to exceed any small bound.
      await writeFile(join(dir, 'change.txt'), 'é'.repeat(2000))
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change')
      const head = git(dir, 'rev-parse', 'HEAD').trim()

      const { prompt } = await reviewedPrompt(dir, base, head, 201)
      expect(prompt).toContain('[diff truncated')
      // The retained diff text (everything before the truncation notice) must decode
      // as complete characters: no U+FFFD replacement character from a split code point.
      const noticeIndex = prompt.indexOf('\n[diff truncated')
      const retained = prompt.slice(0, noticeIndex)
      expect(retained).not.toContain('�')
    }, 20_000)
  })
})
