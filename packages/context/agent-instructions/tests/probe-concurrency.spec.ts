/**
 * Instruction discovery and reconciliation over a filesystem provider with
 * per-call latency: independent resolve/stat probes overlap, while results
 * keep candidate precedence and the first failure in probe order.
 * @module @deepseek-ai/dsh-agent-instructions/tests/probe-concurrency
 */

import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { resolveConfig } from '../src/config.ts'
import { findProjectRoot, loadBaselineInstructionSet } from '../src/files.ts'
import { reconcileInstructionContext, type InstructionVersionCache } from '../src/state.ts'

const PROBE_LATENCY_MS = 5

/** In-memory provider whose resolve and stat calls each take a fixed delay. */
class LatencyFileSystem extends FileSystem {
  override watch(): never { throw new Error('Fixture does not support watching') }
  entries = new Map<string, { type: FsInfo['type']; content?: string }>()
  throwOnStat = new Set<string>()
  inFlight = 0
  maxInFlight = 0
  calls = 0

  private async delay(): Promise<void> {
    this.calls++
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise(done => setTimeout(done, PROBE_LATENCY_MS))
    } finally {
      this.inFlight--
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    await this.delay()
    const absolute = resolve(opts?.cwd ?? '/', path)
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    await this.delay()
    if (this.throwOnStat.has(target.targetKey)) throw new Error(`stat failed: ${target.displayPath}`)
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined) return undefined
    return {
      version: FsVersion(`v:${target.targetKey}:${entry.content ?? ''}`),
      type: entry.type,
      ...entry.content === undefined ? {} : { size: Buffer.byteLength(entry.content, 'utf8') },
    }
  }

  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = this.entries.get(target.targetKey)?.content ?? ''
    return (async function* () { yield content })()
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }
  override contains(): boolean { throw new Error('not needed in probe tests') }
  override async lstat(): Promise<FsPathInfo | undefined> { throw new Error('not needed in probe tests') }
  override async readText(): Promise<string> { throw new Error('not needed in probe tests') }
  override async readBytes(): Promise<Uint8Array> { throw new Error('not needed in probe tests') }
  override async readByteRange(): Promise<Uint8Array> { throw new Error('not needed in probe tests') }
  override async listDir(): Promise<FsDirEntry[]> { throw new Error('not needed in probe tests') }
  override async writeText(): Promise<FsWriteOutcome> { throw new Error('not needed in probe tests') }
  override async editText(): Promise<FsEditOutcome> { throw new Error('not needed in probe tests') }
}

const agentCtx = new Context()
await mountAgentLoopTestDependencies(agentCtx)
const agentLoop = await mountAgentLoopTestHarness(agentCtx)
afterAll(() => agentCtx.fiber.dispose())

const root = resolve('/virtual/repo')
const cwd = join(root, 'pkg', 'leaf')
const home = resolve('/virtual/home')

async function seededFileSystem(): Promise<{ ctx: Context; fs: LatencyFileSystem }> {
  const ctx = new Context()
  await ctx.plugin(LatencyFileSystem)
  const fs = ctx.fs as LatencyFileSystem
  fs.entries.set(join(root, '.git'), { type: 'directory' })
  fs.entries.set(join(home, 'AGENTS.md'), { type: 'file', content: 'home rule' })
  fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'root rule' })
  fs.entries.set(join(root, 'pkg', 'CLAUDE.md'), { type: 'file', content: 'pkg rule' })
  fs.entries.set(join(cwd, 'AGENTS.md'), { type: 'file', content: 'leaf rule' })
  fs.entries.set(join(cwd, 'AGENTS.local.md'), { type: 'file', content: 'leaf local rule' })
  return { ctx, fs }
}

describe('instruction probes over a high-latency provider', () => {
  it('probes one directory\'s root markers together and keeps marker precedence', async () => {
    const { ctx, fs } = await seededFileSystem()
    try {
      fs.entries.set(join(cwd, 'package.json'), { type: 'file', content: '{}' })

      await expect(findProjectRoot(cwd, ['.git', '.hg', 'package.json'], fs)).resolves.toBe(cwd)
      expect(fs.maxInFlight).toBe(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an earlier marker failure even when a later marker exists', async () => {
    const { ctx, fs } = await seededFileSystem()
    try {
      fs.entries.set(join(cwd, 'package.json'), { type: 'file', content: '{}' })
      fs.throwOnStat.add(join(cwd, '.git'))

      await expect(findProjectRoot(cwd, ['.git', 'package.json'], fs)).rejects.toThrow(`stat failed: ${join(cwd, '.git')}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('overlaps baseline candidate probes and renders files in precedence order', async () => {
    const { ctx, fs } = await seededFileSystem()
    try {
      const loaded = await loadBaselineInstructionSet({ cwd, dshHome: home, maxBytes: 65536 }, fs)

      expect(loaded?.included.map(file => file.displayPath)).toEqual([
        '$DSH_HOME/AGENTS.md',
        'AGENTS.md',
        'pkg/CLAUDE.md',
        'pkg/leaf/AGENTS.md',
        'pkg/leaf/AGENTS.local.md',
      ])
      // Three directories times four candidates probe together once the root is known.
      expect(fs.maxInFlight).toBeGreaterThanOrEqual(12)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('overlaps reconciliation scope probes and keeps transition order', async () => {
    const { ctx, fs } = await seededFileSystem()
    try {
      const agent = await agentLoop.create(SessionId('probe-concurrency-reconcile'), {}, { cwd })
      agent.session.append('session/end-seed', {})
      const resolved = resolveConfig({ dshHome: home, maxBytes: 65536 })
      const cache: InstructionVersionCache = new WeakMap()

      const result = await reconcileInstructionContext(agent, resolved, cache, fs, {
        authorityMessages: [],
        scopeMessages: [],
        touchedPaths: [],
        includeBaselineScopes: true,
        projectRoot: root,
      })

      expect(result?.versionUpdates.map(update => update.change.path)).toEqual([
        '$DSH_HOME/AGENTS.md',
        'AGENTS.md',
        'pkg/CLAUDE.md',
        'pkg/leaf/AGENTS.md',
        'pkg/leaf/AGENTS.local.md',
      ])
      // The user-global scope plus three directories times four candidates all resolve together.
      expect(fs.maxInFlight).toBe(13)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects reconciliation with the cancellation reason once a probe observes it', async () => {
    const { ctx, fs } = await seededFileSystem()
    try {
      const agent = await agentLoop.create(SessionId('probe-concurrency-abort'), {}, { cwd })
      agent.session.append('session/end-seed', {})
      const abort = new AbortController()
      const reason = new Error('reconciliation cancelled')
      abort.abort(reason)

      await expect(reconcileInstructionContext(agent, resolveConfig({ dshHome: home, maxBytes: 65536 }), new WeakMap(), fs, {
        authorityMessages: [],
        scopeMessages: [],
        touchedPaths: [],
        includeBaselineScopes: true,
        projectRoot: root,
        signal: abort.signal,
      })).rejects.toBe(reason)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
