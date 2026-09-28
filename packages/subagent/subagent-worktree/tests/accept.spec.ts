import { spawnSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { pathExists } from '../src/fs-util.ts'
import { reviewCheckoutPathFor } from '../src/paths.ts'
import { layoutForRepo, requireRecordLocation, updateExistingRecordAt } from '../src/records.ts'
import type { AcceptWorktreeRequest, WorktreeId, WorktreeOwner } from '../src/types.ts'
import { createWorktree, fakeAgent, git, initFixtureRepo, removeFixture, setup } from './harness.ts'
import type { TestConfig } from './harness.ts'
import { mountScriptedReviewer } from './scripted-reviewer.ts'
import type { ScriptedVerdict } from './scripted-reviewer.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

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
}

interface HarnessOptions {
  config?: Partial<TestConfig>
  verdicts?: readonly ScriptedVerdict[]
  onReviewerStart?: (request: SubagentStartRequest) => void
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await initFixtureRepo('dsh-accept-')
  cleanups.push(() => removeFixture(dir))
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
  const root = await scratchRoot()
  const { ctx, dispose } = await setup({
    root, reviewerProvider: REVIEWER_ROUTE.provider, reviewerModel: REVIEWER_ROUTE.model, ...options.config,
  })
  cleanups.push(dispose)
  await mountScriptedReviewer(ctx, {
    verdicts: options.verdicts ?? [PASS_VERDICT],
    ...options.onReviewerStart === undefined ? {} : { onStart: options.onReviewerStart },
  })
  return { ctx, dir, root }
}

function acceptRequest(id: WorktreeId, overrides: Partial<AcceptWorktreeRequest> = {}): AcceptWorktreeRequest {
  return { id, owner: OWNER, parent: fakeAgent('lead-agent', CALLER_ROUTE), signal, ...overrides }
}

describe('accept: empty', () => {
  it('reports empty and reopens when nothing changed in the worktree', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome).toMatchObject({ kind: 'empty' })
    expect(outcome.record.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: checks-failed', () => {
  it('stops before the reviewer when the check command fails', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarted = true } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      testCommand: [process.execPath, '-e', 'process.exit(1)'],
    }))
    expect(outcome.kind).toBe('checks-failed')
    if (outcome.kind !== 'checks-failed') throw new Error('unreachable')
    expect(outcome.exitCode).toBe(1)
    expect(outcome.record.state).toBe('open')
    expect(reviewerStarted).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('proceeds to the reviewer and merges when the check command passes', async () => {
    let reviewerStarted = false
    const { ctx, dir } = await harness({ onReviewerStart: () => { reviewerStarted = true } })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, {
      testCommand: [process.execPath, '-e', 'process.exit(0)'],
    }))
    expect(outcome.kind).toBe('merged')
    expect(reviewerStarted).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('accept: rejected', () => {
  it('does not merge when the reviewer fails the change', async () => {
    const { ctx, dir } = await harness({ verdicts: [FAIL_VERDICT] })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('unreachable')
    expect(outcome.verdict.findings).toEqual(['x.ts: broken'])
    expect(outcome.record.state).toBe('open')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
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

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id, { reviewer: otherReviewerRoute }))
    expect(outcome.kind).toBe('merged')
    expect(capturedRoute).toEqual(otherReviewerRoute)
  }, GIT_TEST_TIMEOUT_MS)

  it('keeps the merged record when removeOnMerge cleanup fails after a successful merge', async () => {
    const { ctx, dir } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    // A second worktree forced onto the same branch (git worktree add --force overrides the
    // "already checked out" guard) survives the worktree removal but blocks the branch delete,
    // so the merge fact must still stand even though the best-effort cleanup after it fails.
    const otherCheckout = await mkdtemp(join(tmpdir(), 'dsh-accept-other-checkout-'))
    cleanups.push(() => removeFixture(otherCheckout))
    git(dir, 'worktree', 'add', '--force', otherCheckout, provisioned.record.branch)

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))).rejects.toThrow()

    const relisted = await ctx.subagentWorktrees.list({ baseDir: dir, owner: OWNER, includeClosed: true })
    expect(relisted.find(r => r.id === provisioned.record.id)?.state).toBe('merged')
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
    await updateExistingRecordAt(located.path, provisioned.record.id, current => ({
      ...current, state: 'reviewing', reviewingPid: process.pid, reviewingStartedAt: Date.now(),
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
    await updateExistingRecordAt(located.path, provisioned.record.id, current => ({
      ...current, state: 'reviewing', reviewingPid: dead, reviewingStartedAt: 1,
    }))

    const outcome = await ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id))
    expect(outcome.kind).toBe('merged')
  }, GIT_TEST_TIMEOUT_MS)

  it('removes a leftover review checkout from a crashed accept before starting a new one', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const layout = layoutForRepo(root, provisioned.record.repoRoot)
    const stalePath = reviewCheckoutPathFor(layout, provisioned.record.id, 'stale')
    git(dir, 'worktree', 'add', '--detach', stalePath, 'HEAD')
    expect(await pathExists(stalePath)).toBe(true)
    // An entry for a different worktree id must survive the sweep: only this id's prefix is removed.
    const unrelatedPath = reviewCheckoutPathFor(layout, 'wt-unrelated0', 'stale')
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

  it('returns a still-reviewing record to open and rethrows on an infrastructure failure', async () => {
    const { ctx, dir } = await harness({ verdicts: [{ throws: 'reviewer infrastructure boom' }] })
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    await expect(ctx.subagentWorktrees.accept(acceptRequest(provisioned.record.id)))
      .rejects.toThrow('reviewer infrastructure boom')

    const relisted = await ctx.subagentWorktrees.list({ baseDir: dir, owner: OWNER })
    expect(relisted.find(r => r.id === provisioned.record.id)?.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)

  it('logs but does not fail accept when a stale review directory is not a real git worktree', async () => {
    const { ctx, dir, root } = await harness()
    const provisioned = await createWorktree(ctx, OWNER, dir, 'do the thing')
    await writeFile(join(provisioned.workDir, 'change.txt'), 'x')

    const layout = layoutForRepo(root, provisioned.record.repoRoot)
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

    const layout = layoutForRepo(root, provisioned.record.repoRoot)
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
})

describe('accept: unknown worktree', () => {
  it('fails loud for an id with no record', async () => {
    const { ctx } = await harness()
    await expect(ctx.subagentWorktrees.accept(acceptRequest('wt-00000000' as WorktreeId)))
      .rejects.toThrow('no worktree "wt-00000000"')
  })
})
