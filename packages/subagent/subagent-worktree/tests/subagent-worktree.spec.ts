import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SubagentWorktrees from '../src/index.ts'
import type { WorktreeId, WorktreeOwner } from '../src/types.ts'
import { git, initFixtureRepo, removeFixture, setup } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  vi.unstubAllEnvs()
  cleanups.length = 0
})

const signal = new AbortController().signal
const OWNER: WorktreeOwner = { kind: 'session', sessionId: SessionId('lead') }
const REVIEWER_ROUTE = { provider: 'reviewer-provider', model: 'reviewer-model' }
const GIT_TEST_TIMEOUT_MS = 20_000

async function scratchRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-service-root-'))
  cleanups.push(() => removeFixture(dir))
  return dir
}

describe('constructor: root resolution', () => {
  it('resolves the default root under $DSH_HOME when Config.root is omitted', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-service-home-'))
    cleanups.push(() => removeFixture(dshHome))
    vi.stubEnv('DSH_HOME', dshHome)
    const dir = await initFixtureRepo('dsh-service-default-root-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentWorktrees, {
      branchPrefix: 'dsh/worktree/', maxWorktrees: 16, requireDistinctReviewer: true, reviewDiffMaxBytes: 1024, removeOnMerge: true,
    })
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })
    expect(provisioned.record.path.startsWith(join(dshHome, 'worktrees'))).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('fails loud at load when a configured root is not absolute', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(SubagentWorktrees, {
      root: 'relative/worktrees', branchPrefix: 'dsh/worktree/', maxWorktrees: 16,
      requireDistinctReviewer: true, reviewDiffMaxBytes: 1024, removeOnMerge: true,
    })).rejects.toThrow('subagent-worktree: configured root "relative/worktrees" must be an absolute path')
  })
})

describe('attach', () => {
  it('records the worker session id and route on an open worktree', async () => {
    const dir = await initFixtureRepo('dsh-attach-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })

    const updated = await ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('worker-1'), workerRoute: { provider: 'p', model: 'm' },
    })
    expect(updated.workerSessionIds).toEqual(['worker-1'])
    expect(updated.workerRoute).toEqual({ provider: 'p', model: 'm' })
  }, GIT_TEST_TIMEOUT_MS)

  it('appends to existing attached workers rather than replacing them', async () => {
    const dir = await initFixtureRepo('dsh-attach-multi-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w1') })
    const updated = await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w2') })
    expect(updated.workerSessionIds).toEqual(['w1', 'w2'])
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a different session and a terminal (discarded) worktree', async () => {
    const dir = await initFixtureRepo('dsh-attach-guard-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })

    await expect(ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: { kind: 'session', sessionId: SessionId('other') }, workerSessionId: SessionId('w1'),
    })).rejects.toThrow('belongs to another session')

    await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    await expect(ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w1') }))
      .rejects.toThrow(`worktree ${provisioned.record.id} is discarded`)
  }, GIT_TEST_TIMEOUT_MS)

  it('fails loud for an unknown id', async () => {
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    await expect(ctx.subagentWorktrees.attach({ id: 'wt-00000000' as WorktreeId, owner: OWNER, workerSessionId: SessionId('w1') }))
      .rejects.toThrow('no worktree "wt-00000000"')
  })
})

describe('discard', () => {
  it('removes the worktree directory and branch, and records discarded', async () => {
    const dir = await initFixtureRepo('dsh-discard-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })

    const updated = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    expect(updated.state).toBe('discarded')
    expect(git(dir, 'worktree', 'list')).not.toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects owner mismatch and a second discard of an already-discarded worktree', async () => {
    const dir = await initFixtureRepo('dsh-discard-guard-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })

    await expect(ctx.subagentWorktrees.discard({
      id: provisioned.record.id, owner: { kind: 'session', sessionId: SessionId('other') }, signal,
    })).rejects.toThrow('belongs to another session')

    // An attached worker id absent from the live registry (never started here) does not block discard;
    // packages/subagent/subagent-worktree/tests/workers.spec.ts covers the running-worker refusal directly.
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('never-started') })
    await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      .rejects.toThrow(`worktree ${provisioned.record.id} is discarded`)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('list', () => {
  it('orders by createdAt, filters by owner, and hides closed records by default', async () => {
    const dir = await initFixtureRepo('dsh-list-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)

    const ownerB: WorktreeOwner = { kind: 'session', sessionId: SessionId('other-session') }
    const first = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'first', task: 'first', signal })
    const second = await ctx.subagentWorktrees.create({ owner: ownerB, baseDir: dir, label: 'second', task: 'second', signal })
    await ctx.subagentWorktrees.discard({ id: second.record.id, owner: ownerB, signal })
    const third = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'third', task: 'third', signal })

    const defaultView = await ctx.subagentWorktrees.list({ baseDir: dir })
    expect(defaultView.map(r => r.id)).toEqual([first.record.id, third.record.id])

    const withClosed = await ctx.subagentWorktrees.list({ baseDir: dir, includeClosed: true })
    expect(withClosed.map(r => r.id)).toEqual([first.record.id, second.record.id, third.record.id])

    const ownerFiltered = await ctx.subagentWorktrees.list({ baseDir: dir, owner: ownerB, includeClosed: true })
    expect(ownerFiltered.map(r => r.id)).toEqual([second.record.id])

    const operatorFiltered = await ctx.subagentWorktrees.list({ baseDir: dir, owner: { kind: 'operator' } })
    expect(operatorFiltered).toEqual([])
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a base directory outside any git work tree', async () => {
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-list-nongit-'))
    cleanups.push(() => removeFixture(outside))
    await expect(ctx.subagentWorktrees.list({ baseDir: outside }))
      .rejects.toThrow(`subagent-worktree: "${outside}" is not inside a git work tree`)
  })
})

describe('resolveReviewer', () => {
  const CALLER_ROUTE = { provider: 'caller', model: 'caller-model' }
  const CONFIGURED_ROUTE = { provider: 'configured', model: 'configured-model' }
  const OVERRIDE_ROUTE = { provider: 'override', model: 'override-model' }

  it('prefers override, then Config.reviewer, then the caller route', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), reviewer: CONFIGURED_ROUTE })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE, override: OVERRIDE_ROUTE }))
      .toEqual(OVERRIDE_ROUTE)
    expect(ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE }))
      .toEqual(CONFIGURED_ROUTE)

    const { ctx: ctxNoConfig, dispose: disposeNoConfig } = await setup({ root: await scratchRoot() })
    cleanups.push(disposeNoConfig)
    expect(ctxNoConfig.subagentWorktrees.resolveReviewer({ workerRoute: { provider: 'w', model: 'm' }, callerRoute: CALLER_ROUTE }))
      .toEqual(CALLER_ROUTE)
  })

  it('rejects a reviewer route equal to the worker route when requireDistinctReviewer is set', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), requireDistinctReviewer: true })
    cleanups.push(dispose)
    expect(() => ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE }))
      .toThrow('so the review would not be independent')
  })

  it('allows an equal route when requireDistinctReviewer is false', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), requireDistinctReviewer: false })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE })).toEqual(CALLER_ROUTE)
  })
})

describe('HMR / disposal', () => {
  it('disposes cleanly and a fresh mount serves requests again', async () => {
    const dir = await initFixtureRepo('dsh-hmr-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()

    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(SubagentWorktrees, {
      root, branchPrefix: 'dsh/worktree/', maxWorktrees: 16, requireDistinctReviewer: true, reviewDiffMaxBytes: 1024,
      removeOnMerge: true, reviewer: REVIEWER_ROUTE,
    })
    await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'x', task: 'x', signal })
    expect(ctx.get('subagentWorktrees')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('subagentWorktrees')).toBeUndefined()

    await ctx.plugin(SubagentWorktrees, {
      root, branchPrefix: 'dsh/worktree/', maxWorktrees: 16, requireDistinctReviewer: true, reviewDiffMaxBytes: 1024,
      removeOnMerge: true, reviewer: REVIEWER_ROUTE,
    })
    cleanups.push(() => ctx.fiber.dispose())
    const second = await ctx.subagentWorktrees.create({ owner: OWNER, baseDir: dir, label: 'y', task: 'y', signal })
    expect(second.record.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)
})
