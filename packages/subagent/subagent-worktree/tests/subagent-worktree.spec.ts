import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SubagentWorktrees from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { pathExists } from '../src/fs-util.ts'
import { GitRunner } from '../src/git.ts'
import type { GitRunOptions } from '../src/git.ts'
import { requireRecordLocation } from '../src/records.ts'
import type { WorktreeId, WorktreeOwner } from '../src/types.ts'
import { createWorktree, fakeAgent, git, initFixtureRepo, removeFixture, setup } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  cleanups.length = 0
})

const signal = new AbortController().signal
const OWNER: WorktreeOwner = { kind: 'session', sessionId: SessionId('lead') }
const WORKER_ROUTE = { provider: 'worker-provider', model: 'worker-model' }
const REVIEWER_ROUTE = { provider: 'reviewer-provider', model: 'reviewer-model' }
const GIT_TEST_TIMEOUT_MS = 20_000

/** Config fields a raw `ctx.plugin(SubagentWorktrees, ...)` call must always supply. */
const RAW_BASE_CONFIG: Omit<Config, 'root'> = {
  branchPrefix: 'dsh/worktree/',
  maxWorktrees: 16,
  requireDistinctReviewer: false,
  testCommand: [],
  checkTimeoutMs: 60_000,
  reviewDiffMaxBytes: 1024,
  removeOnMerge: true,
}

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
    await ctx.plugin(SubagentWorktrees, RAW_BASE_CONFIG)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    expect(provisioned.record.path.startsWith(join(dshHome, 'worktrees'))).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('fails loud at load when a configured root is not absolute', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(SubagentWorktrees, { root: 'relative/worktrees', ...RAW_BASE_CONFIG }))
      .rejects.toThrow('subagent-worktree: configured root "relative/worktrees" must be an absolute path')
  })

  it('fails loud at load when reviewerProvider and reviewerModel are half-set', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(SubagentWorktrees, { root: await scratchRoot(), ...RAW_BASE_CONFIG, reviewerProvider: 'p' }))
      .rejects.toThrow('subagent-worktree: configured reviewerProvider and reviewerModel must be set together')
  })

  it('fails loud at load when reviewerReasoningEffort is set without a reviewer route', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(SubagentWorktrees, { root: await scratchRoot(), ...RAW_BASE_CONFIG, reviewerReasoningEffort: 'high' }))
      .rejects.toThrow('subagent-worktree: configured reviewerReasoningEffort requires reviewerProvider and reviewerModel')
  })

  it('fails loud at load when commitAuthorName and commitAuthorEmail are half-set', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(SubagentWorktrees, { root: await scratchRoot(), ...RAW_BASE_CONFIG, commitAuthorName: 'Bot' }))
      .rejects.toThrow('subagent-worktree: configured commitAuthorName and commitAuthorEmail must be set together')
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
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')

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
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    await ctx.subagentWorktrees.attach({ id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w1'), workerRoute: WORKER_ROUTE })
    const updated = await ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w2'), workerRoute: WORKER_ROUTE,
    })
    expect(updated.workerSessionIds).toEqual(['w1', 'w2'])
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a different session and a terminal (discarded) worktree', async () => {
    const dir = await initFixtureRepo('dsh-attach-guard-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')

    await expect(ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: { kind: 'session', sessionId: SessionId('other') }, workerSessionId: SessionId('w1'), workerRoute: WORKER_ROUTE,
    })).rejects.toThrow('belongs to another session')

    await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    await expect(ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w1'), workerRoute: WORKER_ROUTE,
    })).rejects.toThrow(`worktree ${provisioned.record.id} is discarded`)
  }, GIT_TEST_TIMEOUT_MS)

  it('fails loud for an unknown id', async () => {
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    await expect(ctx.subagentWorktrees.attach({
      id: 'wt-00000000' as WorktreeId, owner: OWNER, workerSessionId: SessionId('w1'), workerRoute: WORKER_ROUTE,
    })).rejects.toThrow('no worktree "wt-00000000"')
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
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')

    const updated = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    expect(updated.state).toBe('discarded')
    expect(git(dir, 'worktree', 'list')).not.toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects owner mismatch, and a second discard of an already-discarded worktree returns it unchanged', async () => {
    const dir = await initFixtureRepo('dsh-discard-guard-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    const other: WorktreeOwner = { kind: 'session', sessionId: SessionId('other') }

    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: other, signal }))
      .rejects.toThrow('belongs to another session')

    // An attached worker id absent from the live registry (never started here) does not block discard;
    // packages/subagent/subagent-worktree/tests/workers.spec.ts covers the running-worker refusal directly.
    await ctx.subagentWorktrees.attach({
      id: provisioned.record.id, owner: OWNER, workerSessionId: SessionId('never-started'), workerRoute: WORKER_ROUTE,
    })
    const first = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    const second = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })

    expect(first.state).toBe('discarded')
    expect(second).toEqual(first)
    // The retry is still an authorized operation.
    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: other, signal }))
      .rejects.toThrow('belongs to another session')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('worktree id validation at every public method', () => {
  it.each(['attach', 'accept', 'discard'] as const)('%s rejects an id that is not a worktree id before touching the filesystem', async (method) => {
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const id = '../../etc/x' as WorktreeId
    const attempts = {
      attach: () => ctx.subagentWorktrees.attach({ id, owner: OWNER, workerSessionId: SessionId('w'), workerRoute: WORKER_ROUTE }),
      accept: () => ctx.subagentWorktrees.accept({ id, owner: OWNER, parent: fakeAgent('parent', WORKER_ROUTE), signal }),
      discard: () => ctx.subagentWorktrees.discard({ id, owner: OWNER, signal }),
    }
    await expect(attempts[method]()).rejects.toThrow('"../../etc/x" is not a worktree id')
    expect(await readdir(root)).toEqual([])
  })
})

describe('discard cleanup', () => {
  it('finishes after the worktree directory was deleted out from under it, pruning the stale registration first', async () => {
    const dir = await initFixtureRepo('dsh-discard-missing-dir-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    await rm(provisioned.record.path, { recursive: true, force: true })
    // git still lists the deleted worktree and refuses to delete its checked-out branch until it is pruned.
    expect(git(dir, 'worktree', 'list')).toContain(provisioned.record.path)
    expect(() => git(dir, 'branch', '-D', provisioned.record.branch)).toThrow()

    const updated = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })

    expect(updated.state).toBe('discarded')
    expect(git(dir, 'worktree', 'list')).not.toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('finishes when both the directory and the branch are already gone', async () => {
    const dir = await initFixtureRepo('dsh-discard-all-gone-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    git(dir, 'worktree', 'remove', '--force', provisioned.record.path)
    git(dir, 'branch', '-D', provisioned.record.branch)

    const updated = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })
    expect(updated.state).toBe('discarded')
  }, GIT_TEST_TIMEOUT_MS)

  it('claims the record before any git change, so a failing removal leaves it discarded rather than open', async () => {
    const dir = await initFixtureRepo('dsh-discard-claims-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    // git refuses to remove a locked worktree, so the removal after the claim fails.
    git(dir, 'worktree', 'lock', provisioned.record.path)
    cleanups.push(async () => { git(dir, 'worktree', 'unlock', provisioned.record.path) })

    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      .rejects.toThrow('git worktree remove failed')

    const [record] = await ctx.subagentWorktrees.list({ baseDir: dir, includeClosed: true })
    expect(record?.state).toBe('discarded')
    expect(await pathExists(provisioned.record.path)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('finishes the cleanup when discard is retried after a removal failed, leaving the record discarded', async () => {
    const dir = await initFixtureRepo('dsh-discard-retry-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    git(dir, 'worktree', 'lock', provisioned.record.path)
    await expect(ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal }))
      .rejects.toThrow('git worktree remove failed')
    expect(await pathExists(provisioned.record.path)).toBe(true)
    git(dir, 'worktree', 'unlock', provisioned.record.path)

    const retried = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal })

    expect(retried.state).toBe('discarded')
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(dir, 'worktree', 'list')).not.toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('removes the directory and the branch on fresh signals when the caller is cancelled as the first sweep command starts', async () => {
    const dir = await initFixtureRepo('dsh-discard-cancelled-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    const controller = new AbortController()
    // The `discarded` write is discard's point of no return: from the first sweep command on, the caller's signal
    // must not decide whether the worktree and branch are removed.
    let sweepSignal: AbortSignal | undefined
    const spy = vi.spyOn(GitRunner.prototype, 'run')
    spy.mockImplementation(async function (this: GitRunner, args: readonly string[], options: GitRunOptions) {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        sweepSignal = options.signal
        controller.abort()
      }
      spy.mockRestore()
      return this.run(args, options)
    })

    const discarded = await ctx.subagentWorktrees.discard({ id: provisioned.record.id, owner: OWNER, signal: controller.signal })

    expect(controller.signal.aborted).toBe(true)
    expect(discarded.state).toBe('discarded')
    expect(sweepSignal).toBeDefined()
    expect(sweepSignal).not.toBe(controller.signal)
    expect(await pathExists(provisioned.record.path)).toBe(false)
    expect(git(dir, 'worktree', 'list')).not.toContain(provisioned.record.path)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('linked-worktree bases', () => {
  it('shares one records directory, slot count, and listing with the repository the base is a linked worktree of', async () => {
    const dir = await initFixtureRepo('dsh-linked-base-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const linkedParent = await mkdtemp(join(tmpdir(), 'dsh-linked-base-wt-'))
    cleanups.push(() => removeFixture(linkedParent))
    const linked = join(linkedParent, 'wt')
    git(dir, 'worktree', 'add', '-q', '-b', 'linked-branch', linked)
    const { ctx, dispose } = await setup({ root: await scratchRoot(), maxWorktrees: 2 })
    cleanups.push(dispose)

    const fromMain = await createWorktree(ctx, OWNER, dir, 'from main')
    const fromLinked = await createWorktree(ctx, OWNER, linked, 'from linked')

    // Each record keeps its own checkout as its merge target ...
    expect(fromMain.record.repoRoot).toBe(await realpath(dir))
    expect(fromLinked.record.repoRoot).toBe(await realpath(linked))
    // ... while both live under one repository directory, are listed from either base, and share the slot count.
    expect(dirname(fromLinked.record.path)).toBe(dirname(fromMain.record.path))
    const expected = [fromMain.record.id, fromLinked.record.id].sort()
    expect((await ctx.subagentWorktrees.list({ baseDir: dir })).map(r => r.id).sort()).toEqual(expected)
    expect((await ctx.subagentWorktrees.list({ baseDir: linked })).map(r => r.id).sort()).toEqual(expected)
    await expect(createWorktree(ctx, OWNER, linked, 'third')).rejects.toThrow('2 worktrees are already open')
    await expect(createWorktree(ctx, OWNER, dir, 'third')).rejects.toThrow('2 worktrees are already open')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('offersIsolation', () => {
  it('is off by default: the schema resolves an omitted field to false, and a config without it reads false', async () => {
    expect(SubagentWorktrees.Config.dict?.offerIsolation?.meta.default).toBe(false)
    expect(SubagentWorktrees.Config({ ...RAW_BASE_CONFIG }).offerIsolation).toBe(false)

    const { ctx, dispose } = await setup({ root: await scratchRoot() })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.offersIsolation).toBe(false)
  })

  it('reads false for a service constructed directly from a config that omits the field', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const service = new SubagentWorktrees(ctx, { ...RAW_BASE_CONFIG, root: await scratchRoot() })
    expect(service.offersIsolation).toBe(false)
  })

  it('reads the configured value when the deployment turns isolation on', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), offerIsolation: true })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.offersIsolation).toBe(true)
  })

  it('reads false when the deployment sets it to false explicitly', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), offerIsolation: false })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.offersIsolation).toBe(false)
  })
})

describe('Config schema', () => {
  it('defaults the check deadline to fifteen minutes', () => {
    expect(SubagentWorktrees.Config.dict?.checkTimeoutMs?.meta.default).toBe(900_000)
  })

  it('accepts a one second check deadline and rejects a shorter one', () => {
    expect(SubagentWorktrees.Config({ ...RAW_BASE_CONFIG, checkTimeoutMs: 1_000 }).checkTimeoutMs).toBe(1_000)
    expect(() => SubagentWorktrees.Config({ ...RAW_BASE_CONFIG, checkTimeoutMs: 999 })).toThrow()
  })
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
    const first = await createWorktree(ctx, OWNER, dir, 'first')
    const second = await createWorktree(ctx, ownerB, dir, 'second')
    await ctx.subagentWorktrees.discard({ id: second.record.id, owner: ownerB, signal })
    const third = await createWorktree(ctx, OWNER, dir, 'third')

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

describe('stray files beside worktree records', () => {
  /**
   * One repository with an open worktree, a stray file in the worktree root that
   * lists before every repository directory, and a stray `.json` file in the
   * repository's records directory.
   */
  async function strayFixture() {
    const dir = await initFixtureRepo('dsh-stray-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const { ctx, dispose } = await setup({ root })
    cleanups.push(dispose)
    const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
    const { layout } = await requireRecordLocation(root, provisioned.record.id)
    const strayInRoot = join(root, '.DS_Store')
    await writeFile(strayInRoot, '')
    const strayRecord = join(layout.recordsDir, 'notes.json')
    await writeFile(strayRecord, '{}')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    return { ctx, dir, provisioned, strayInRoot, strayRecord, warn }
  }

  it('lists a repository past a stray file in its records directory, logging the skip', async () => {
    const f = await strayFixture()

    const listed = await f.ctx.subagentWorktrees.list({ baseDir: f.dir })

    expect(listed.map(r => r.id)).toEqual([f.provisioned.record.id])
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(f.strayRecord))
  }, GIT_TEST_TIMEOUT_MS)

  it('creates a worktree past a stray file in the records directory, logging the skip', async () => {
    const f = await strayFixture()

    const second = await createWorktree(f.ctx, OWNER, f.dir, 'second')

    expect(second.record.state).toBe('open')
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(f.strayRecord))
  }, GIT_TEST_TIMEOUT_MS)

  it('attaches a worker past a stray file in the worktree root, logging the skip', async () => {
    const f = await strayFixture()

    const updated = await f.ctx.subagentWorktrees.attach({
      id: f.provisioned.record.id, owner: OWNER, workerSessionId: SessionId('w1'), workerRoute: WORKER_ROUTE,
    })

    expect(updated.workerSessionIds).toEqual(['w1'])
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(f.strayInRoot))
  }, GIT_TEST_TIMEOUT_MS)

  it('discards a worktree past a stray file in the worktree root, logging the skip', async () => {
    const f = await strayFixture()

    const discarded = await f.ctx.subagentWorktrees.discard({ id: f.provisioned.record.id, owner: OWNER, signal })

    expect(discarded.state).toBe('discarded')
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(f.strayInRoot))
  }, GIT_TEST_TIMEOUT_MS)

  it('reaches the ownership check of accept past a stray file in the worktree root, logging the skip', async () => {
    const f = await strayFixture()

    await expect(f.ctx.subagentWorktrees.accept({
      id: f.provisioned.record.id, owner: { kind: 'session', sessionId: SessionId('other') }, parent: fakeAgent('parent', WORKER_ROUTE), signal,
    })).rejects.toThrow('belongs to another session')

    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(f.strayInRoot))
  }, GIT_TEST_TIMEOUT_MS)
})

describe('resolveReviewer', () => {
  const CALLER_ROUTE = { provider: 'caller', model: 'caller-model' }
  const CONFIGURED_ROUTE = { provider: 'configured', model: 'configured-model' }
  const OVERRIDE_ROUTE = { provider: 'override', model: 'override-model' }

  it('carries a configured reviewerReasoningEffort into the resolved route', async () => {
    const { ctx, dispose } = await setup({
      root: await scratchRoot(),
      reviewerProvider: CONFIGURED_ROUTE.provider,
      reviewerModel: CONFIGURED_ROUTE.model,
      reviewerReasoningEffort: 'high',
    })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE }))
      .toEqual({ ...CONFIGURED_ROUTE, reasoningEffort: 'high' })
  })

  it('prefers override, then Config.reviewerProvider/Model, then the caller route', async () => {
    const { ctx, dispose } = await setup({
      root: await scratchRoot(), reviewerProvider: CONFIGURED_ROUTE.provider, reviewerModel: CONFIGURED_ROUTE.model,
    })
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

  it('leaves requireDistinctReviewer off by default, so a worker on the accepting agent route is reviewed on it', async () => {
    expect(SubagentWorktrees.Config.dict?.requireDistinctReviewer?.meta.default).toBe(false)
    // Resolve a config that omits the flag through the real schema, so the shipped default is what applies.
    const { requireDistinctReviewer: _omitted, ...withoutFlag } = RAW_BASE_CONFIG
    const root = await scratchRoot()
    const resolved = SubagentWorktrees.Config({ ...withoutFlag, root } as Config)
    expect(resolved.requireDistinctReviewer).toBe(false)

    const { ctx, dispose } = await setup({ ...resolved, root })
    cleanups.push(dispose)
    expect(ctx.subagentWorktrees.resolveReviewer({ workerRoute: CALLER_ROUTE, callerRoute: CALLER_ROUTE })).toEqual(CALLER_ROUTE)
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

  it('ignores reasoning effort when comparing the reviewer route to the worker route', async () => {
    const { ctx, dispose } = await setup({ root: await scratchRoot(), requireDistinctReviewer: true })
    cleanups.push(dispose)
    const workerRoute = { ...CALLER_ROUTE, reasoningEffort: 'low' as never }
    const callerRoute = { ...CALLER_ROUTE, reasoningEffort: 'high' as never }
    expect(() => ctx.subagentWorktrees.resolveReviewer({ workerRoute, callerRoute }))
      .toThrow('so the review would not be independent')
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
      root, ...RAW_BASE_CONFIG, reviewerProvider: REVIEWER_ROUTE.provider, reviewerModel: REVIEWER_ROUTE.model,
    })
    await createWorktree(ctx, OWNER, dir, 'x')
    expect(ctx.get('subagentWorktrees')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('subagentWorktrees')).toBeUndefined()

    await ctx.plugin(SubagentWorktrees, {
      root, ...RAW_BASE_CONFIG, reviewerProvider: REVIEWER_ROUTE.provider, reviewerModel: REVIEWER_ROUTE.model,
    })
    cleanups.push(() => ctx.fiber.dispose())
    const second = await createWorktree(ctx, OWNER, dir, 'y')
    expect(second.record.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)
})
