import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type * as AtomicWrite from '@deepseek-ai/dsh-atomic-write'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { acceptWorktree } from '../src/accept.ts'
import type { AcceptDeps } from '../src/accept.ts'
import { pathExists } from '../src/fs-util.ts'
import { GitRunner } from '../src/git.ts'
import type * as Git from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import type { Config } from '../src/index.ts'
import { reviewCheckoutPathFor } from '../src/paths.ts'
import { isStaleReviewing, requireRecordLocation, updateExistingRecordAt } from '../src/records.ts'
import type { AcceptWorktreeRequest, WorktreeId, WorktreeOwner } from '../src/types.ts'
import { expireSignal, KILLED_RESULT } from './cleanup-signals.ts'
import { createWorktree, fakeAgent, git, initFixtureRepo, removeFixture, resolveTestConfig, setup } from './harness.ts'
import type { TestConfig } from './harness.ts'
import { mountScriptedReviewer } from './scripted-reviewer.ts'
import type { ScriptedVerdict } from './scripted-reviewer.ts'

/**
 * Scripted faults for record writes: the next `skip` writes pass through, then the next `fail` writes reject.
 * The mock wraps the real `writeFileAtomic`, so every other write behaves exactly as in production.
 */
const writeFaults = vi.hoisted(() => ({ skip: 0, fail: 0 }))
vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicWrite>()
  return {
    ...actual,
    writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (writeFaults.skip > 0) {
        writeFaults.skip -= 1
      } else if (writeFaults.fail > 0) {
        writeFaults.fail -= 1
        return Promise.reject(new Error('scripted write failure'))
      }
      return actual.writeFileAtomic(...args)
    },
  }
})

// Cleanup signals never run out on their own here, so a test can make one run out at a chosen moment.
vi.mock('../src/git.ts', async importOriginal => (
  (await import('./cleanup-signals.ts')).withExpirableCleanupSignals(await importOriginal<typeof Git>())
))

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  writeFaults.skip = 0
  writeFaults.fail = 0
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A promise plus the function that settles it, for holding one step of a scenario until another has happened. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

const OPERATOR: WorktreeOwner = { kind: 'operator' }

const signal = new AbortController().signal
const CALLER_ROUTE = { provider: 'caller-provider', model: 'caller-model' }
const REVIEWER_ROUTE = { provider: 'reviewer-provider', model: 'reviewer-model' }
const OWNER: WorktreeOwner = { kind: 'session', sessionId: SessionId('lead') }
const PASS_VERDICT: ScriptedVerdict = { structured: { verdict: 'pass', summary: 'ok', checks: ['tests: ok'], findings: [] } }
const FAIL_VERDICT: ScriptedVerdict = { structured: { verdict: 'fail', summary: 'bad', checks: [], findings: ['x.ts: broken'] } }

// Every case runs several real git subprocesses (worktree add/remove, commit, merge); generous under concurrent CI load.
const GIT_TEST_TIMEOUT_MS = 20_000

async function scratchRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-accept-root-'))
  cleanups.push(() => removeFixture(dir))
  return dir
}

interface Harness {
  ctx: Context
  dir: string
  root: string
  /** The complete configuration the service was mounted with. */
  config: Config
}

interface HarnessOptions {
  /** `sha256` runs the scenario in a SHA-256 repository, whose commit ids have 64 digits. */
  objectFormat?: 'sha1' | 'sha256'
  config?: Partial<TestConfig>
  verdicts?: readonly ScriptedVerdict[]
  onReviewerStart?: (request: SubagentStartRequest) => void
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await initFixtureRepo('dsh-accept-', options.objectFormat)
  cleanups.push(() => removeFixture(dir))
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
  const root = await scratchRoot()
  const testConfig: TestConfig = { root, reviewerProvider: REVIEWER_ROUTE.provider, reviewerModel: REVIEWER_ROUTE.model, ...options.config }
  const { ctx, dispose } = await setup(testConfig)
  cleanups.push(dispose)
  await mountScriptedReviewer(ctx, {
    verdicts: options.verdicts ?? [PASS_VERDICT],
    ...options.onReviewerStart === undefined ? {} : { onStart: options.onReviewerStart },
  })
  return { ctx, dir, root, config: resolveTestConfig(testConfig) }
}

function acceptRequest(id: WorktreeId, overrides: Partial<AcceptWorktreeRequest> = {}): AcceptWorktreeRequest {
  return { id, owner: OWNER, parent: fakeAgent('lead-agent', CALLER_ROUTE), signal, ...overrides }
}

/** Rewrite a record file as `discarded`, the way another process discarding the worktree would. */
function markDiscardedOnDisk(path: string): void {
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...stored, state: 'discarded' }))
}

describe('accept: empty', () => {
  it('reports empty and reopens when nothing changed in the worktree, releasing the accept claim', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome).toMatchObject({ kind: 'empty' })
    expect(outcome.record.state).toBe('open')
    expect((await requireRecordLocation(root, provisioned.record.id)).record).not.toHaveProperty('reviewingPid')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: checks-failed', () => {
  it('stops before the reviewer when the check command fails', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarted = true } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: OPERATOR, testCommand: [process.execPath, '-e', 'process.exit(1)'],
    }))
    expect(outcome.kind).toBe('checks-failed')
    if (outcome.kind !== 'checks-failed') throw new Error('unreachable')
    expect(outcome.exitCode).toBe(1)
    expect(outcome.record.state).toBe('open')
    expect(reviewerStarted).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('uses the configured check command when the request sets none', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({
      config: { testCommand: [process.execPath, '-e', 'process.stderr.write("configured check ran"); process.exit(2)'] },
      onReviewerStart: () => { reviewerStarted = true },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('checks-failed')
    if (outcome.kind !== 'checks-failed') throw new Error('unreachable')
    expect(outcome.exitCode).toBe(2)
    expect(outcome.output).toContain('configured check ran')
    expect(reviewerStarted).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports a check that outlives Config.checkTimeoutMs as checks-failed with a timeout notice, leaving the worktree open', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({
      config: { checkTimeoutMs: 1_000 },
      onReviewerStart: () => { reviewerStarted = true },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: OPERATOR, testCommand: [process.execPath, '-e', 'process.stdout.write("still going"); setInterval(() => {}, 1000)'],
    }))
    expect(outcome.kind).toBe('checks-failed')
    if (outcome.kind !== 'checks-failed') throw new Error('unreachable')
    expect(outcome.output).toContain('still going')
    expect(outcome.output).toContain('exceeded checkTimeoutMs (1000 ms) and was terminated')
    expect(outcome.record.state).toBe('open')
    expect(reviewerStarted).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('proceeds to the reviewer and merges when the check command passes', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarted = true } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: OPERATOR, testCommand: [process.execPath, '-e', 'process.exit(0)'],
    }))
    expect(outcome.kind).toBe('merged')
    expect(reviewerStarted).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: rejected', () => {
  it('does not merge when the reviewer fails the change, and releases the accept claim', async () => {
    const { ctx, dir, root } = await harness({ verdicts: [FAIL_VERDICT] })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('unreachable')
    expect(outcome.verdict.findings).toEqual(['x.ts: broken'])
    expect(outcome.record.state).toBe('open')
    expect((await requireRecordLocation(root, provisioned.record.id)).record).not.toHaveProperty('reviewingPid')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not reopen a record that changed state while the review ran, and reports it as stored', async () => {
    const pendingChange: { path: string | undefined } = { path: undefined }
    const { ctx, dir, root } = await harness({
      verdicts: [FAIL_VERDICT],
      onReviewerStart: () => {
        if (pendingChange.path !== undefined) markDiscardedOnDisk(pendingChange.path)
      },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    pendingChange.path = (await requireRecordLocation(root, provisioned.record.id)).path

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('rejected')
    expect(outcome.record.state).toBe('discarded')
    expect((await requireRecordLocation(root, provisioned.record.id)).record.state).toBe('discarded')
  }, GIT_TEST_TIMEOUT_MS)

  it('fails closed (rejects) when the reviewer returns a malformed structured verdict', async () => {
    const { ctx, dir } = await harness({ verdicts: [{ structured: { verdict: 'yes-ish' } }] })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('unreachable')
    expect(outcome.verdict.findings).toEqual(['the reviewer returned no structured verdict'])
  }, GIT_TEST_TIMEOUT_MS)

  it.each(['error', 'aborted', 'max-tokens', 'refusal'] as const)(
    'fails closed on a %s reviewer stop even when a passing structured verdict came with it',
    async (stopReason) => {
      const { ctx, dir } = await harness({ verdicts: [{ ...PASS_VERDICT, stopReason }] })
      const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
      await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
      const headBefore = git(dir, 'rev-parse', 'HEAD').trim()

      const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind !== 'rejected') throw new Error('unreachable')
      expect(outcome.verdict.verdict).toBe('fail')
      expect(outcome.verdict.findings).toEqual(['the reviewer returned no structured verdict'])
      expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    },
    GIT_TEST_TIMEOUT_MS,
  )
})

describe('accept: SHA-256 repositories', () => {
  it('creates, reviews, and merges in a repository whose commit ids have 64 digits', async () => {
    const { ctx, dir } = await harness({ objectFormat: 'sha256' })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(provisioned.record.baseCommit).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(outcome.commit).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.mergeCommit).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.record.mergedCommit).toBe(outcome.mergeCommit)
    expect(await readFile(join(dir, 'change.txt'), 'utf8')).toBe('x')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: commit identity', () => {
  it('commits with the configured author when set', async () => {
    const { ctx, dir } = await harness({ config: { commitAuthorName: 'Harness Bot', commitAuthorEmail: 'harness-bot@example.com' } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(git(dir, 'log', '-1', '--pretty=%an <%ae>', outcome.commit).trim()).toBe('Harness Bot <harness-bot@example.com>')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: merge outcomes', () => {
  it('merges a passing change with --no-ff and reports the merge commit', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'from worker')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(outcome.removed).toBe(true)
    expect(await readFile(join(dir, 'change.txt'), 'utf8')).toBe('from worker')
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    expect(outcome.record.state).toBe('merged')
    expect(outcome.record.mergedCommit).toBe(outcome.mergeCommit)
  }, GIT_TEST_TIMEOUT_MS)

  it('merges into the linked checkout a worktree was created from, not the repository that checkout links to', async () => {
    const { ctx, dir } = await harness()
    const linkedParent = await mkdtemp(join(tmpdir(), 'dsh-accept-linked-'))
    cleanups.push(() => removeFixture(linkedParent))
    const linked = join(linkedParent, 'wt')
    git(dir, 'worktree', 'add', '-q', '-b', 'linked-branch', linked)
    const provisioned = await createWorktree(ctx, OWNER, linked, 'from linked')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'from worker')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('merged')
    expect(await readFile(join(linked, 'change.txt'), 'utf8')).toBe('from worker')
    expect(await pathExists(join(dir, 'change.txt'))).toBe(false)
    expect(git(linked, 'log', '-1', '--pretty=%s').trim()).toContain(`Merge worktree ${provisioned.record.id}`)
  }, GIT_TEST_TIMEOUT_MS)

  it('keeps the worktree and branch when removeOnMerge is false', async () => {
    const { ctx, dir } = await harness({ config: { removeOnMerge: false } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'from worker')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(outcome.removed).toBe(false)
    expect(git(dir, 'worktree', 'list')).toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('honors an operator reviewer override for one accept', async () => {
    const otherReviewerRoute = { provider: 'other-reviewer-provider', model: 'other-reviewer-model' }
    let capturedRoute: unknown
    const { ctx, dir } = await harness({
      onReviewerStart: (request) => { capturedRoute = request.agentOptions },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: OPERATOR, reviewer: otherReviewerRoute,
    }))
    expect(outcome.kind).toBe('merged')
    expect(capturedRoute).toEqual(otherReviewerRoute)
  }, GIT_TEST_TIMEOUT_MS)

  it('returns merged with removed: false and a warning when cleanup fails after a successful merge, and discard finishes it', async () => {
    const { ctx, dir } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    // A second worktree forced onto the same branch (git worktree add --force overrides the
    // "already checked out" guard) survives the worktree removal but blocks the branch delete,
    // so the merge fact must still stand even though the cleanup after it fails.
    const otherCheckout = await mkdtemp(join(tmpdir(), 'dsh-accept-other-checkout-'))
    cleanups.push(() => removeFixture(otherCheckout))
    git(dir, 'worktree', 'add', '--force', otherCheckout, provisioned.record.branch)

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(outcome.removed).toBe(false)
    expect(outcome.record.state).toBe('merged')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(outcome.mergeCommit)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`worktree ${provisioned.record.id} merged as ${outcome.mergeCommit}, but removing its worktree and branch failed`))
    const relisted = await ctx.subagentWorktrees.list({ baseDir: dir, owner: OWNER, includeClosed: true })
    expect(relisted.find(r => r.id === provisioned.record.id)?.state).toBe('merged')
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')

    // Once the extra checkout is gone, discard sweeps the leftover branch and leaves the state merged.
    git(dir, 'worktree', 'remove', '--force', otherCheckout)
    const swept = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    expect(swept.state).toBe('merged')
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('never reopens the record when recording a landed merge fails, and says the merge landed', async () => {
    const { ctx, dir, root } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const { layout } = await requireRecordLocation(root, provisioned.record.id)

    // A post-merge hook runs inside `git merge`, after the merge commit exists and before accept
    // records it: it makes the records directory read-only, so the merged-state write fails.
    const hook = join(dir, '.git', 'hooks', 'post-merge')
    await writeFile(hook, `#!/bin/sh\nchmod 555 '${layout.recordsDir}'\n`, { mode: 0o755 })
    cleanups.push(() => chmod(layout.recordsDir, 0o755))

    const failure = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)).then(
      () => new Error('accept resolved although its merged-record write was blocked'),
      (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
    )
    const mergeCommit = git(dir, 'rev-parse', 'HEAD').trim()
    expect(failure.message).toContain(
      `the merge of worktree ${provisioned.record.id} landed in the base checkout as ${mergeCommit}, but recording it failed`,
    )
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    // No reopen was attempted: the record was left as accept last wrote it.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('could not reopen'))
    await chmod(layout.recordsDir, 0o755)
    expect((await requireRecordLocation(root, provisioned.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it('releases the merge lock before it removes the merged worktree and branch', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const { layout } = await requireRecordLocation(root, provisioned.record.id)

    // `git branch -D` (the last cleanup step) fires reference-transaction with an all-zero new
    // value; this hook records whether the merge lock file exists at that moment. Ref updates
    // that are not a worktree-branch deletion (the worker's commit, the merge into the base
    // branch, which legitimately holds the lock) are ignored.
    const observed = join(await mkdtemp(join(tmpdir(), 'dsh-accept-lock-observed-')), 'observed.txt')
    cleanups.push(() => removeFixture(join(observed, '..')))
    const hook = [
      '#!/bin/sh',
      '[ "$1" = prepared ] || exit 0',
      'while read old new ref; do',
      '  case "$ref" in',
      '    refs/heads/dsh/worktree/*)',
      '      case "$new" in',
      '        *[!0]*) ;;',
      `        *) if [ -e '${layout.mergeLockPath}.lock' ]; then echo "$ref held" >> '${observed}'; else echo "$ref free" >> '${observed}'; fi ;;`,
      '      esac ;;',
      '  esac',
      'done',
      '',
    ].join('\n')
    await writeFile(join(dir, '.git', 'hooks', 'reference-transaction'), hook, { mode: 0o755 })

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome).toMatchObject({ kind: 'merged', removed: true })
    // git may run the hook more than once for one deletion; every observation must find the lock free.
    const observations = (await readFile(observed, 'utf8')).trim().split('\n')
    expect(observations.length).toBeGreaterThanOrEqual(1)
    expect(observations.every(line => line === `refs/heads/${provisioned.record.branch} free`)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('waits for a contended merge lock instead of failing at the default lock timeout', async () => {
    const release = deferred()
    const acquired = deferred()
    let reviewStartedAt = 0
    const { ctx, dir, root } = await harness({
      onReviewerStart: () => {
        // The reviewer starts just before the merge step, so releasing three seconds after it
        // leaves accept waiting longer than withFileLock's two second default.
        reviewStartedAt = Date.now()
        setTimeout(release.resolve, 3_000)
      },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const { layout } = await requireRecordLocation(root, provisioned.record.id)

    const holder = withFileLock(layout.mergeLockPath, async () => {
      acquired.resolve()
      await release.promise
    })
    await acquired.promise

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    await holder
    expect(outcome.kind).toBe('merged')
    expect(Date.now() - reviewStartedAt).toBeGreaterThanOrEqual(2_500)
  }, GIT_TEST_TIMEOUT_MS)

  it('merges two parallel worktrees on distinct files, the second landing as a true (non-fast-forward) merge', async () => {
    const { ctx, dir } = await harness()
    const first = await createWorktree(ctx, OWNER, dir, 'first change')
    const second = await createWorktree(ctx, OWNER, dir, 'second change')
    await writeFile(join(first.workDir, 'first.txt'), 'first')
    await writeFile(join(second.workDir, 'second.txt'), 'second')

    const firstOutcome = await ctx.subagentWorktrees.accept(acceptRequest(first.record.id))
    expect(firstOutcome.kind).toBe('merged')
    const secondOutcome = await ctx.subagentWorktrees.accept(acceptRequest(second.record.id))
    expect(secondOutcome.kind).toBe('merged')

    expect(await readFile(join(dir, 'first.txt'), 'utf8')).toBe('first')
    expect(await readFile(join(dir, 'second.txt'), 'utf8')).toBe('second')
    // Both merges are real merge commits: the second worktree's branch could not
    // fast-forward once the first had already advanced main.
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('2')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports conflict, aborts, and keeps the branch when two worktrees touch the same line', async () => {
    const { ctx, dir } = await harness()
    await writeFile(join(dir, 'shared.txt'), 'base\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'add shared.txt')
    const first = await createWorktree(ctx, OWNER, dir, 'first change')
    const second = await createWorktree(ctx, OWNER, dir, 'second change')
    await writeFile(join(first.workDir, 'shared.txt'), 'from first\n')
    await writeFile(join(second.workDir, 'shared.txt'), 'from second\n')

    expect((await ctx.subagentWorktrees.accept(acceptRequest(first.record.id))).kind).toBe('merged')
    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(second.record.id))
    expect(outcome.kind).toBe('conflict')
    if (outcome.kind !== 'conflict') throw new Error('unreachable')
    expect(outcome.files).toEqual(['shared.txt'])
    expect(outcome.record.state).toBe('open')
    // The branch survives the aborted merge and can still be inspected or retried.
    expect(git(dir, 'branch', '--list', second.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked when an uncommitted base checkout change would be overwritten', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'shared.txt'), 'from worker\n')
    // An untracked local file at the same path the merge would create.
    await writeFile(join(dir, 'shared.txt'), 'local uncommitted\n')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('unreachable')
    expect(outcome.reason.length).toBeGreaterThan(0)
    expect(outcome.record.state).toBe('open')
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('local uncommitted\n')
  }, GIT_TEST_TIMEOUT_MS)

  it('is blocked by, and never aborts, a merge the user already has in progress in the base checkout', async () => {
    const { ctx, dir } = await harness()
    // The user's own conflicting merge: MERGE_HEAD exists and f.txt holds conflict markers.
    git(dir, 'checkout', '-q', '-b', 'side')
    await writeFile(join(dir, 'f.txt'), 'side\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'side')
    git(dir, 'checkout', '-q', 'main')
    await writeFile(join(dir, 'f.txt'), 'main\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main')
    try {
      git(dir, 'merge', 'side')
    } catch {
      // A conflicting merge exits nonzero by design; the half-finished merge it leaves is what this test needs.
    }
    const mergeHead = git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()
    const conflicted = await readFile(join(dir, 'f.txt'), 'utf8')
    expect(conflicted).toContain('<<<<<<<')

    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('unreachable')
    expect(outcome.reason).toContain('MERGE_HEAD')
    expect(outcome.record.state).toBe('open')
    // The user's merge is exactly as they left it.
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(mergeHead)
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe(conflicted)
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('f.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('is blocked, and merges nothing, when the base checkout has a detached HEAD', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    git(dir, 'checkout', '-q', '--detach')
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('unreachable')
    expect(outcome.reason).toContain('detached')
    expect(outcome.record.state).toBe('open')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('0')
    expect(await pathExists(join(dir, 'change.txt'))).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('skips the reviewer on re-accept of an already-passed commit (retried after a blocked merge)', async () => {
    let reviewerCalls = 0
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerCalls += 1 } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'shared.txt'), 'from worker\n')
    await writeFile(join(dir, 'shared.txt'), 'local uncommitted\n')

    const blocked = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(blocked.kind).toBe('blocked')
    expect(reviewerCalls).toBe(1)

    // Clear the local obstruction (shared.txt was never committed in dir's own
    // history): retrying now finds the same commit, already recorded as a
    // pass, and must not pay for a second review.
    await rm(join(dir, 'shared.txt'))

    const merged = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(merged.kind).toBe('merged')
    expect(reviewerCalls).toBe(1)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: owner authority', () => {
  it('rejects a different session and allows the operator', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: { kind: 'session', sessionId: SessionId('someone-else') },
    }))).rejects.toThrow('belongs to another session')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, { owner: { kind: 'operator' } }))
    expect(outcome.kind).toBe('empty')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['testCommand', { testCommand: [process.execPath, '-e', 'process.exit(0)'] }],
    ['reviewer', { reviewer: { provider: 'other-provider', model: 'other-model' } }],
  ] as const)('rejects the %s override from the session that owns the worktree, before committing anything', async (_name, override) => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, override)))
      .rejects.toThrow('the testCommand and reviewer overrides of accept are operator-only')

    expect(git(provisioned.record.path, 'status', '--porcelain')).toContain('change.txt')
    const [record] = await ctx.subagentWorktrees.list({ baseDir: dir })
    expect(record?.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a testCommand override from another session as operator-only, ahead of the ownership check', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: { kind: 'session', sessionId: SessionId('someone-else') }, testCommand: [process.execPath, '-e', '0'],
    }))).rejects.toThrow('operator-only')
  }, GIT_TEST_TIMEOUT_MS)

  it('lets the operator set both overrides on a worktree a session owns', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      owner: OPERATOR,
      testCommand: [process.execPath, '-e', 'process.exit(0)'],
      reviewer: { provider: 'other-provider', model: 'other-model' },
    }))
    expect(outcome.kind).toBe('merged')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: overlapping operations', () => {
  it('refuses a second accept while the first is mid-review, and lets the first still merge', async () => {
    const gate = deferred()
    const reviewing = deferred()
    const { ctx, dir } = await harness({
      verdicts: [{ ...PASS_VERDICT, holdUntil: gate.promise }],
      onReviewerStart: () => { reviewing.resolve() },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const first = ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    await reviewing.promise
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worktree ${provisioned.record.id} is already being accepted`)

    gate.resolve()
    expect((await first).kind).toBe('merged')
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses to attach a worker to a worktree an in-flight accept holds', async () => {
    const gate = deferred()
    const reviewing = deferred()
    const { ctx, dir } = await harness({
      verdicts: [{ ...PASS_VERDICT, holdUntil: gate.promise }],
      onReviewerStart: () => { reviewing.resolve() },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const accepting = ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    await reviewing.promise
    await expect(ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('late-worker'), workerRoute: { provider: 'p', model: 'm' },
    })).rejects.toThrow(`worktree ${provisioned.record.id} is reviewing`)

    gate.resolve()
    const outcome = await accepting
    expect(outcome.kind).toBe('merged')
    expect(outcome.record.workerSessionIds).toEqual([])
  }, GIT_TEST_TIMEOUT_MS)

  it('lets exactly one of two simultaneous accepts run, reviewing and merging once', async () => {
    let reviewerCalls = 0
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerCalls += 1 } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const settled = await Promise.allSettled([
      ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)),
      ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)),
    ])

    const fulfilled = settled.filter(result => result.status === 'fulfilled')
    const rejected = settled.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toContain('already being accepted')
    expect(reviewerCalls).toBe(1)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses to discard a worktree an in-flight accept holds, leaving its directory and branch in place', async () => {
    const gate = deferred()
    const reviewing = deferred()
    const { ctx, dir } = await harness({
      verdicts: [{ ...PASS_VERDICT, holdUntil: gate.promise }],
      onReviewerStart: () => { reviewing.resolve() },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const accepting = ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    await reviewing.promise
    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      .rejects.toThrow(`worktree ${provisioned.record.id} is already being accepted`)
    expect(await pathExists(provisioned.record.path)).toBe(true)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')

    gate.resolve()
    expect((await accepting).kind).toBe('merged')
  }, GIT_TEST_TIMEOUT_MS)

  it('leaves an accept that lost the race to a completed discard rejected as discarded, changing nothing', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worktree ${provisioned.record.id} is discarded`)
    expect(await pathExists(join(dir, 'change.txt'))).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)
})

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * Hold one record's writer lock while `during` runs, then release it. `during` starts an operation that has
 * already read the record (so it passes every check made outside the lock), waits for it to queue on the
 * lock, and changes the record underneath it: only a check made under the lock can see the change.
 */
async function holdingRecordLock(recordPath: string, during: () => Promise<void>): Promise<void> {
  const acquired = deferred()
  const release = deferred()
  const holder = withFileLock(recordPath, async () => {
    acquired.resolve()
    await release.promise
  })
  await acquired.promise
  await during()
  release.resolve()
  await holder
}

/** Settle an operation into its error message, or `resolved`, so a rejection cannot go unhandled while a lock is held. */
function outcomeOf(operation: Promise<unknown>): Promise<string> {
  return operation.then(
    () => 'resolved',
    (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
  )
}

describe('record lock: state and worker checks run under the lock', () => {
  const WORKER_ROUTE = { provider: 'p', model: 'm' }

  async function stored(recordPath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
  }

  it('refuses an accept that lost the claim to another accept while it waited for the record lock', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const { path } = await requireRecordLocation(root, provisioned.record.id)
    const before = await stored(path)

    let pending: Promise<string> = Promise.resolve('never started')
    await holdingRecordLock(path, async () => {
      pending = outcomeOf(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      await sleep(300)
      writeFileSync(path, JSON.stringify({ ...before, state: 'reviewing', reviewingPid: process.pid }))
    })

    expect(await pending).toContain(`worktree ${provisioned.record.id} is already being accepted`)
    expect(git(provisioned.record.path, 'status', '--porcelain')).toContain('change.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses an accept when a worker starts running while it waits for the record lock', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const workerId = SessionId('late-runner')
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: workerId, workerRoute: WORKER_ROUTE })
    let status: 'running' | 'idle' = 'idle'
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => (id === workerId ? { status } as Agent : undefined))
    const { path } = await requireRecordLocation(root, provisioned.record.id)

    let pending: Promise<string> = Promise.resolve('never started')
    await holdingRecordLock(path, async () => {
      pending = outcomeOf(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      await sleep(300)
      status = 'running'
    })

    expect(await pending).toContain(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)
    expect((await stored(path)).state).toBe('open')
    expect(git(provisioned.record.path, 'status', '--porcelain')).toContain('change.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses a discard that lost the claim to an accept while it waited for the record lock, removing nothing', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const { path } = await requireRecordLocation(root, provisioned.record.id)
    const before = await stored(path)

    let pending: Promise<string> = Promise.resolve('never started')
    await holdingRecordLock(path, async () => {
      pending = outcomeOf(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      await sleep(300)
      writeFileSync(path, JSON.stringify({ ...before, state: 'reviewing', reviewingPid: process.pid }))
    })

    expect(await pending).toContain(`worktree ${provisioned.record.id} is already being accepted`)
    expect(await pathExists(provisioned.record.path)).toBe(true)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses a discard when a worker starts running while it waits for the record lock, removing nothing', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const workerId = SessionId('late-runner')
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: workerId, workerRoute: WORKER_ROUTE })
    let status: 'running' | 'idle' = 'idle'
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => (id === workerId ? { status } as Agent : undefined))
    const { path } = await requireRecordLocation(root, provisioned.record.id)

    let pending: Promise<string> = Promise.resolve('never started')
    await holdingRecordLock(path, async () => {
      pending = outcomeOf(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      await sleep(300)
      status = 'running'
    })

    expect(await pending).toContain(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)
    expect((await stored(path)).state).toBe('open')
    expect(await pathExists(provisioned.record.path)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses an attach that lost the worktree to an accept while it waited for the record lock', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const { path } = await requireRecordLocation(root, provisioned.record.id)
    const before = await stored(path)

    let pending: Promise<string> = Promise.resolve('never started')
    await holdingRecordLock(path, async () => {
      pending = outcomeOf(ctx.subagentWorktrees.attach({
        id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('late-worker'), workerRoute: WORKER_ROUTE,
      }))
      await sleep(300)
      writeFileSync(path, JSON.stringify({ ...before, state: 'reviewing', reviewingPid: process.pid }))
    })

    expect(await pending).toContain(`worktree ${provisioned.record.id} is reviewing`)
    expect((await stored(path)).workerSessionIds).toEqual([])
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: running workers', () => {
  it('refuses while an attached worker is running and proceeds once it is idle, never claiming the record in between', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const workerId = SessionId('running-worker')
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: workerId, workerRoute: { provider: 'p', model: 'm' } })

    let status: 'running' | 'idle' = 'running'
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => (id === workerId ? { status } as Agent : undefined))

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)
    // Refused inside the record lock, before any state change: the record is still open and uncommitted.
    expect((await ctx.subagentWorktrees.list({ baseDir: dir }))[0]?.state).toBe('open')
    expect(git(provisioned.record.path, 'status', '--porcelain')).toContain('change.txt')

    status = 'idle'
    expect((await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))).kind).toBe('merged')
  }, GIT_TEST_TIMEOUT_MS)

  /** An attached worker that reads `idle` for its first `idleChecks` status checks and `running` afterwards. */
  async function workerRunningAfter(ctx: Context, id: WorktreeId, idleChecks: number): Promise<SessionId> {
    const workerId = SessionId('restarted-worker')
    await ctx.subagentWorktrees.attach({ id, owner: OWNER, workerSessionId: workerId, workerRoute: { provider: 'p', model: 'm' } })
    let checks = 0
    vi.spyOn(ctx.agents, 'get').mockImplementation((asked) => {
      if (asked !== workerId) return undefined
      checks += 1
      return { status: checks > idleChecks ? 'running' : 'idle' } as Agent
    })
    return workerId
  }

  it('checks again right before git add: a worker that starts after the claim stops the accept before it commits', async () => {
    let reviewerStarts = 0
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarts += 1 } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    // The first check (under the claim) reads idle; the check right before `git add` reads running.
    const workerId = await workerRunningAfter(ctx, provisioned.record.id, 1)

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)

    expect(reviewerStarts).toBe(0)
    expect(git(provisioned.record.path, 'status', '--porcelain')).toContain('change.txt')
    expect((await ctx.subagentWorktrees.list({ baseDir: dir }))[0]?.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)

  it('checks again right before git merge: a worker that starts during the review stops the accept before it merges', async () => {
    let reviewerStarts = 0
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarts += 1 } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    // The checks under the claim and before `git add` read idle; the check right before `git merge` reads running.
    const workerId = await workerRunningAfter(ctx, provisioned.record.id, 2)

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)

    expect(reviewerStarts).toBe(1)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('0')
    expect(await pathExists(join(dir, 'change.txt'))).toBe(false)
    const [record] = await ctx.subagentWorktrees.list({ baseDir: dir })
    expect(record?.state).toBe('open')
    expect(record?.lastVerdict?.verdict).toBe('pass')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses to discard while an attached worker is running, changing nothing', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const workerId = SessionId('running-worker')
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: workerId, workerRoute: { provider: 'p', model: 'm' } })
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => (id === workerId ? { status: 'running' } as Agent : undefined))

    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      .rejects.toThrow(`worker ${workerId} of worktree ${provisioned.record.id} is still running`)
    expect((await ctx.subagentWorktrees.list({ baseDir: dir }))[0]?.state).toBe('open')
    expect(await pathExists(provisioned.record.path)).toBe(true)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: state machine', () => {
  it.each(['merged', 'discarded'] as const)('rejects accept on a terminal %s worktree', async (state) => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    if (state === 'discarded') {
      await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    } else {
      await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
      await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    }
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worktree ${provisioned.record.id} is ${state}`)
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a concurrent accept: a live reviewingPid means another accept owns the transition', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    // Simulate the moment right after another process's accept() claimed the
    // worktree: 'reviewing' with a pid this host can still observe (itself).
    const located = await requireRecordLocation(root, provisioned.record.id)
    await updateExistingRecordAt(located.layout, provisioned.record.id, current => ({
      ...current, state: 'reviewing', reviewingPid: process.pid,
    }))

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`worktree ${provisioned.record.id} is already being accepted`)
  }, GIT_TEST_TIMEOUT_MS)

  it('recovers a reviewing worktree whose accepting process has exited (stale recovery)', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    if (dead === undefined) throw new Error('expected a spawned pid')
    const located = await requireRecordLocation(root, provisioned.record.id)
    await updateExistingRecordAt(located.layout, provisioned.record.id, current => ({
      ...current, state: 'reviewing', reviewingPid: dead,
    }))

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
  }, GIT_TEST_TIMEOUT_MS)

  it('removes a leftover review checkout from a crashed accept before starting a new one', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const { layout } = await requireRecordLocation(root, provisioned.record.id)
    const stalePath = reviewCheckoutPathFor(layout, provisioned.record.id, 'stale')
    git(dir, 'worktree', 'add', '--detach', stalePath, 'HEAD')
    expect(await pathExists(stalePath)).toBe(true)
    // An entry for a different worktree id must survive the sweep: only this id's prefix is removed.
    const unrelatedPath = reviewCheckoutPathFor(layout, 'wt-99999999', 'stale')
    await mkdir(unrelatedPath, { recursive: true })
    // A matching entry that readdir lists but no longer exists by the time it is checked
    // (here, a broken symlink) is skipped rather than handed to git worktree remove.
    const brokenPath = reviewCheckoutPathFor(layout, provisioned.record.id, 'broken')
    await symlink(join(layout.reviewsDir, 'does-not-exist'), brokenPath)

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    expect(await pathExists(stalePath)).toBe(false)
    expect(await pathExists(unrelatedPath)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('returns a still-reviewing record to open, releasing the accept claim, and rethrows on an infrastructure failure', async () => {
    const { ctx, dir, root } = await harness({ verdicts: [{ throws: 'reviewer infrastructure boom' }] })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow('reviewer infrastructure boom')

    const relisted = await ctx.subagentWorktrees.list({ baseDir: dir, owner: OWNER })
    expect(relisted.find(r => r.id === provisioned.record.id)?.state).toBe('open')
    expect((await requireRecordLocation(root, provisioned.record.id)).record).not.toHaveProperty('reviewingPid')
  }, GIT_TEST_TIMEOUT_MS)

  it('removes the review checkout on a fresh signal even when the caller cancelled the accept during the review', async () => {
    const controller = new AbortController()
    const { ctx, dir, root } = await harness({ onReviewerStart: () => { controller.abort() } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, { signal: controller.signal }))).rejects.toThrow()

    const { layout } = await requireRecordLocation(root, provisioned.record.id)
    expect(controller.signal.aborted).toBe(true)
    expect(await readdir(layout.reviewsDir)).toEqual([])
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(2)
    expect((await ctx.subagentWorktrees.list({ baseDir: dir }))[0]?.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)

  it('logs but does not fail accept when a stale review directory is not a real git worktree', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const { layout } = await requireRecordLocation(root, provisioned.record.id)
    const bogusStalePath = reviewCheckoutPathFor(layout, provisioned.record.id, 'bogus')
    await mkdir(bogusStalePath, { recursive: true })

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
    // git refused to remove a plain directory it never registered as a worktree; the failure was logged, not thrown.
    expect(await pathExists(bogusStalePath)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('propagates a non-ENOENT failure listing the reviews directory', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const { layout } = await requireRecordLocation(root, provisioned.record.id)
    await writeFile(layout.reviewsDir, '') // a file where a directory is expected: readdir fails with ENOTDIR

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))).rejects.toThrow()
  }, GIT_TEST_TIMEOUT_MS)

  it('logs but does not mask the original error when the best-effort reopen also fails', async () => {
    const pendingDelete: { path: string | undefined } = { path: undefined }
    const { ctx, dir, root } = await harness({
      verdicts: [{ throws: 'reviewer infrastructure boom' }],
      onReviewerStart: () => {
        // Fire synchronously: the record must already be gone by the time run.result
        // rejects and the outer catch tries to reopen it, or the race is non-deterministic.
        if (pendingDelete.path !== undefined) unlinkSync(pendingDelete.path)
      },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const located = await requireRecordLocation(root, provisioned.record.id)
    pendingDelete.path = located.path

    // The original reviewer failure surfaces even though the recovery attempt
    // that follows it (reopening a now-deleted record) also fails.
    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow('reviewer infrastructure boom')
  }, GIT_TEST_TIMEOUT_MS)

  it('releases the accept claim when the reopen write fails, so a live process id does not pin the record', async () => {
    const { ctx, dir, root } = await harness({
      verdicts: [{ throws: 'reviewer infrastructure boom' }],
      // The first record write after the reviewer starts is the reopen.
      onReviewerStart: () => { writeFaults.skip = 0; writeFaults.fail = 1 },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow('reviewer infrastructure boom')

    const { record } = await requireRecordLocation(root, provisioned.record.id)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not reopen worktree ${provisioned.record.id}`))
    // The record is still `reviewing`, but with no claim it reads as stale: the next accept or discard recovers it.
    expect(record.state).toBe('reviewing')
    expect(record).not.toHaveProperty('reviewingPid')
    expect(isStaleReviewing(record)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not reopen a record that changed state while the failing accept was running', async () => {
    const pendingChange: { path: string | undefined } = { path: undefined }
    const { ctx, dir, root } = await harness({
      verdicts: [{ throws: 'reviewer infrastructure boom' }],
      onReviewerStart: () => {
        // Someone else moved the record on while this accept was mid-review (here: discarded it).
        if (pendingChange.path !== undefined) markDiscardedOnDisk(pendingChange.path)
      },
    })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    pendingChange.path = (await requireRecordLocation(root, provisioned.record.id)).path

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow('reviewer infrastructure boom')
    expect((await requireRecordLocation(root, provisioned.record.id)).record.state).toBe('discarded')
  }, GIT_TEST_TIMEOUT_MS)
})

/** Real git, except that once a merge has succeeded the next `failures` reads of the landing commit (`git rev-list`) fail. */
class LandingCommitReadFailsGit extends GitRunner {
  private merged = false
  private remainingFailures: number

  constructor(subprocessRuntime: ConstructorParameters<typeof GitRunner>[0], failures: number) {
    super(subprocessRuntime)
    this.remainingFailures = failures
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    const result = await super.run(args, options)
    if (args[0] === 'merge' && args[1] !== '--abort' && result.exitCode === 0) this.merged = true
    if (this.merged && args[0] === 'rev-list' && this.remainingFailures > 0) {
      this.remainingFailures -= 1
      return { exitCode: 128, stdout: '', stderr: 'fatal: scripted read failure\n', stdoutLossy: false }
    }
    return result
  }
}

/** The collaborators `acceptWorktree` needs, with a caller-chosen git runner. */
function directDeps(h: Harness, command: GitRunner): AcceptDeps {
  return {
    ctx: h.ctx,
    git: command,
    root: h.root,
    config: h.config,
    commitAuthor: undefined,
    resolveReviewer: request => h.ctx.subagentWorktrees.resolveReviewer(request),
  }
}

/**
 * Real git, except that a command `spendsItsSignal` names completes and then runs its own cleanup signal out. Like
 * the subprocess runtime, it never runs a command started on an aborted signal.
 */
class SignalSpendingGit extends GitRunner {
  constructor(
    subprocessRuntime: ConstructorParameters<typeof GitRunner>[0],
    private readonly spendsItsSignal: (args: readonly string[]) => boolean,
  ) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    if (options.signal?.aborted === true) return KILLED_RESULT
    const result = await super.run(args, options)
    if (this.spendsItsSignal(args)) expireSignal(options.signal)
    return result
  }
}

const isWorktreeRemoval = (args: readonly string[]): boolean => args[0] === 'worktree' && args[1] === 'remove'

describe('accept: cleanup signals', () => {
  it('removes a merged worktree and then its branch on separate fresh signals, so a removal that ran out of time cannot abort the branch deletion', async () => {
    const h = await harness()
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const command = new SignalSpendingGit(h.ctx.subprocess, isWorktreeRemoval)

    const outcome = await acceptWorktree(directDeps(h, command), acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', removed: true })
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(h.dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)
})

/** Real git, except that `git merge --abort` fails without aborting, so the merge it was asked to abort stays in progress. */
class AbortFailsGit extends GitRunner {
  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    if (args[0] === 'merge' && args[1] === '--abort') {
      return { exitCode: 128, stdout: '', stderr: 'fatal: scripted abort failure\n', stdoutLossy: false }
    }
    return super.run(args, options)
  }
}

describe('accept: a merge that cannot be aborted', () => {
  it('throws that the base checkout is left mid-merge, without its path, reopens the record, and logs the path', async () => {
    const h = await harness()
    const logged = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
    await writeFile(join(h.dir, 'shared.txt'), 'base\n')
    git(h.dir, 'add', '-A'); git(h.dir, 'commit', '-q', '-m', 'add shared.txt')
    const first = await createWorktree(h.ctx, OWNER, h.dir, 'first change')
    const second = await createWorktree(h.ctx, OWNER, h.dir, 'second change')
    await writeFile(join(first.workDir, 'shared.txt'), 'from first\n')
    await writeFile(join(second.workDir, 'shared.txt'), 'from second\n')
    expect((await h.ctx.subagentWorktrees.accept(acceptRequest(first.record.id))).kind).toBe('merged')

    const failure = await acceptWorktree(directDeps(h, new AbortFailsGit(h.ctx.subprocess)), acceptRequest(second.record.id))
      .catch((error: unknown) => error)

    // No outcome that says nothing was merged: the base checkout really is left mid-merge, and the error says so.
    expect(String(failure)).toContain('could not be aborted: the base checkout is left mid-merge and must be aborted there with "git merge --abort"')
    expect(String(failure)).not.toContain(second.record.repoRoot)
    expect(String(failure)).not.toContain(h.dir)
    expect(git(h.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).not.toBe('')
    // The path stays in the host log, and the record is reopened for a retry once the checkout is clean.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`in "${second.record.repoRoot}" could not be aborted and is still in progress`))
    expect((await requireRecordLocation(h.root, second.record.id)).record.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: a merge that landed', () => {
  it('reads the landing commit again when the first read fails, and still records merged with it', async () => {
    const h = await harness()
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const command = new LandingCommitReadFailsGit(h.ctx.subprocess, 1)
    const outcome = await acceptWorktree(directDeps(h, command), acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    const head = git(h.dir, 'rev-parse', 'HEAD').trim()
    expect(outcome.mergeCommit).toBe(head)
    expect(outcome.record).toMatchObject({ state: 'merged', mergedCommit: head })
  }, GIT_TEST_TIMEOUT_MS)

  it('records merged without a commit id, and says the merge landed, when the landing commit cannot be read at all', async () => {
    const h = await harness()
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(acceptWorktree(directDeps(h, new LandingCommitReadFailsGit(h.ctx.subprocess, 2)), acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`the merge of worktree ${provisioned.record.id} landed in the base checkout and is recorded merged, but its commit id could not be read`)

    const { record } = await requireRecordLocation(h.root, provisioned.record.id)
    expect(record.state).toBe('merged')
    expect(record.mergedCommit).toBeUndefined()
    expect(record).not.toHaveProperty('reviewingPid')
    expect(git(h.dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)

  it('records the reviewed commit, never a later HEAD, when git merge finds the change already contained in the base checkout', async () => {
    const h = await harness()
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    // The worker committed its change on the branch, and a user then fast-forwarded the base checkout onto it and went on.
    await writeFile(join(provisioned.workDir, 'a.txt'), 'a')
    git(provisioned.record.path, 'add', '-A')
    git(provisioned.record.path, 'commit', '-q', '-m', 'work')
    const commit = git(provisioned.record.path, 'rev-parse', 'HEAD').trim()
    git(h.dir, 'merge', '--ff-only', provisioned.record.branch)
    git(h.dir, 'commit', '--allow-empty', '-q', '-m', 'later work')
    const head = git(h.dir, 'rev-parse', 'HEAD').trim()

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', commit, mergeCommit: commit })
    expect(outcome.record).toMatchObject({ state: 'merged', mergedCommit: commit })
    expect(commit).not.toBe(head)
    // git merge found nothing to do, so the base checkout is exactly where the user left it.
    expect(git(h.dir, 'rev-parse', 'HEAD').trim()).toBe(head)
  }, GIT_TEST_TIMEOUT_MS)

  it('releases its claim when recording the merge fails, so a live process id does not pin the record', async () => {
    const h = await harness({ onReviewerStart: () => { writeFaults.skip = 1; writeFaults.fail = 1 } })
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`the merge of worktree ${provisioned.record.id} landed in the base checkout as`)

    const { record } = await requireRecordLocation(h.root, provisioned.record.id)
    expect(record.state).toBe('reviewing')
    expect(record).not.toHaveProperty('reviewingPid')
    expect(git(h.dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)

  it('says the merge landed, without a commit id, when the id cannot be read and recording the merge also fails', async () => {
    const h = await harness({ onReviewerStart: () => { writeFaults.skip = 1; writeFaults.fail = 1 } })
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(acceptWorktree(directDeps(h, new LandingCommitReadFailsGit(h.ctx.subprocess, 2)), acceptRequest(provisioned.record.id)))
      .rejects.toThrow(`the merge of worktree ${provisioned.record.id} landed in the base checkout, but recording it failed`)

    const { record } = await requireRecordLocation(h.root, provisioned.record.id)
    expect(record.state).toBe('reviewing')
    expect(record).not.toHaveProperty('reviewingPid')
  }, GIT_TEST_TIMEOUT_MS)

  /** An accept whose merge landed but whose `merged` write failed, leaving the record stale `reviewing`. */
  async function crashedAfterMerge(options: HarnessOptions = {}): Promise<{
    h: Harness
    provisioned: Awaited<ReturnType<typeof createWorktree>>
    mergeCommit: string
    reviewerStarts: () => number
  }> {
    let starts = 0
    const h = await harness({
      ...options,
      onReviewerStart: () => {
        starts += 1
        if (starts === 1) { writeFaults.skip = 1; writeFaults.fail = 1 }
      },
    })
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    await expect(h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))).rejects.toThrow('landed in the base checkout')
    return { h, provisioned, mergeCommit: git(h.dir, 'rev-parse', 'HEAD').trim(), reviewerStarts: () => starts }
  }

  it('records merged, with no second review or merge, when a later accept finds the reviewed commit already landed', async () => {
    const { h, provisioned, mergeCommit, reviewerStarts } = await crashedAfterMerge()
    // The base branch moved on after the crash, so the merge commit is no longer HEAD: it has to be looked up.
    git(h.dir, 'commit', '--allow-empty', '-q', '-m', 'later work')
    expect(git(h.dir, 'rev-parse', 'HEAD').trim()).not.toBe(mergeCommit)

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', mergeCommit, removed: true })
    expect(outcome.record).toMatchObject({ state: 'merged', mergedCommit: mergeCommit })
    expect(git(h.dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    expect(reviewerStarts()).toBe(1)
    // The crashed accept never removed the worktree or branch; the recovery sweeps them.
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(h.dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('records merged, and sweeps the leftovers, when a discard finds the reviewed commit already landed', async () => {
    const { h, provisioned, mergeCommit } = await crashedAfterMerge()

    const record = await h.ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })

    expect(record).toMatchObject({ state: 'merged', mergedCommit: mergeCommit })
    expect(git(h.dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(h.dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('reviews newer unreviewed work instead of recording it merged because an older commit of the worktree landed', async () => {
    const { h, provisioned, reviewerStarts } = await crashedAfterMerge({ verdicts: [PASS_VERDICT, FAIL_VERDICT] })
    // The worker kept going after the crashed accept and left a change nobody reviewed.
    await writeFile(join(provisioned.workDir, 'newer.txt'), 'newer')

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('rejected')
    expect(outcome.record.state).toBe('open')
    expect(reviewerStarts()).toBe(2)
    expect(await pathExists(provisioned.record.path)).toBe(true)
    expect(git(h.dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('discards, without recording it merged, a stale worktree that holds newer unreviewed work', async () => {
    const { h, provisioned } = await crashedAfterMerge()
    await writeFile(join(provisioned.workDir, 'newer.txt'), 'newer')

    const record = await h.ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })

    expect(record.state).toBe('discarded')
    expect(record).not.toHaveProperty('mergedCommit')
  }, GIT_TEST_TIMEOUT_MS)

  it('leaves the worktree in place when the recovered merge is found and removeOnMerge is off', async () => {
    const { h, provisioned } = await crashedAfterMerge({ config: { removeOnMerge: false } })

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', removed: false })
    expect(await pathExists(provisioned.record.path)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('sweeps a recovered merge\'s leftovers with a fresh signal for each command, so a removal that ran out of time cannot abort the rest', async () => {
    const { h, provisioned } = await crashedAfterMerge()
    const command = new SignalSpendingGit(h.ctx.subprocess, isWorktreeRemoval)

    const outcome = await acceptWorktree(directDeps(h, command), acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', removed: true })
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(h.dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports removed: false and a warning when sweeping a recovered merge\'s leftovers fails', async () => {
    const { h, provisioned, mergeCommit } = await crashedAfterMerge()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    // git refuses to remove a locked worktree, so the sweep fails after the merge was recorded.
    git(h.dir, 'worktree', 'lock', provisioned.record.path)
    cleanups.push(async () => { git(h.dir, 'worktree', 'unlock', provisioned.record.path) })

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', mergeCommit, removed: false })
    expect(outcome.record.state).toBe('merged')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`was already merged as ${mergeCommit}, but removing its worktree and branch failed`))
  }, GIT_TEST_TIMEOUT_MS)

  it('records the reviewed commit as the merge commit when it landed by fast-forward, so no merge commit lists it', async () => {
    const h = await harness()
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'a.txt'), 'a')
    git(provisioned.record.path, 'add', '-A')
    git(provisioned.record.path, 'commit', '-q', '-m', 'work')
    const commit = git(provisioned.record.path, 'rev-parse', 'HEAD').trim()
    // A user fast-forwards the base branch onto the worker's commit by hand.
    git(h.dir, 'merge', '--ff-only', provisioned.record.branch)
    // An accept that died before it recorded anything: reviewing on a dead process id, with a passing verdict for that commit.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    if (dead === undefined) throw new Error('expected a spawned pid')
    const { layout } = await requireRecordLocation(h.root, provisioned.record.id)
    await updateExistingRecordAt(layout, provisioned.record.id, current => ({
      ...current,
      state: 'reviewing',
      reviewingPid: dead,
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: [], findings: [], commit, reviewerSessionId: SessionId('reviewer'), reviewerRoute: REVIEWER_ROUTE, at: 1,
      },
    }))

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome).toMatchObject({ kind: 'merged', commit, mergeCommit: commit })
    expect(outcome.record).toMatchObject({ state: 'merged', mergedCommit: commit })
  }, GIT_TEST_TIMEOUT_MS)

  it('does not treat a stale record as landed when its reviewed commit is not in the base history', async () => {
    let reviewerStarts = 0
    const h = await harness({ verdicts: [FAIL_VERDICT, PASS_VERDICT], onReviewerStart: () => { reviewerStarts += 1 } })
    const provisioned = await createWorktree(h.ctx, OWNER, h.dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    expect((await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))).kind).toBe('rejected')

    // A crashed accept: reviewing on a dead process id, with a verdict for a commit that never merged.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    if (dead === undefined) throw new Error('expected a spawned pid')
    const { layout } = await requireRecordLocation(h.root, provisioned.record.id)
    await updateExistingRecordAt(layout, provisioned.record.id, current => ({ ...current, state: 'reviewing', reviewingPid: dead }))

    const outcome = await h.ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))

    expect(outcome.kind).toBe('merged')
    expect(reviewerStarts).toBe(2)
    expect(git(h.dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: unknown worktree', () => {
  it('fails loud for an id with no record', async () => {
    const { ctx } = await harness()
    await expect(ctx.subagentWorktrees.accept(acceptRequest('wt-00000000' as WorktreeId)))
      .rejects.toThrow('no worktree "wt-00000000"')
  })
})
