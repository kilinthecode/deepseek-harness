import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activityFileKey, listActivity, readActivity } from '../src/activity.ts'
import { activityDirectory, activityPath } from '../src/paths.ts'
import PeerService, { type Config } from '../src/index.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** The next turn number of one session, so every appended turn is a fresh one. */
const turns = new WeakMap<Session, number>()

/** Append one completed turn of a session and return its number. */
function openTurn(agent: Agent): number {
  const session = agent.session
  const turn = (turns.get(session) ?? 0) + 1
  turns.set(session, turn)
  session.append('turn/start', { turn })
  return turn
}

/** Append one whole tool call and its result, the way the agent loop logs them. */
function toolTurn(agent: Agent, name: string, args: unknown, failed = false): void {
  const session = agent.session
  const turn = openTurn(agent)
  const callId = ToolCallId(`${agent.id}-call-${turn}`)
  session.append('step/start', { turn, step: 1 })
  session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: failed ? 'failed' : 'done' }],
      isError: failed,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append one complete todo list inside its own turn. */
function todoTurn(agent: Agent, todos: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[]): void {
  const turn = openTurn(agent)
  agent.session.append('todo/write', { todos: [...todos] })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The recorded path keys of one session's row, newest first. */
async function recordedPaths(harness: PeerHarness, id: string): Promise<readonly string[]> {
  return (await readActivity(harness.home, id))?.files.map(file => file.p) ?? []
}

/** One activity row body as a reader validates it, for rows this process did not write. */
function rowBody(options: {
  readonly sessionId: string
  readonly version?: number
  readonly pid: number
  readonly root: string
}): string {
  return `${JSON.stringify({
    version: options.version ?? 1,
    sessionId: options.sessionId,
    repoKey: `dir:${options.root}`,
    root: options.root,
    cwd: options.root,
    name: options.sessionId,
    status: 'idle',
    pid: options.pid,
    updatedAt: Date.now(),
    files: [],
  })}\n`
}

describe('activityFileKey', () => {
  it('keys a path inside the checkout relative to it', () => {
    expect(activityFileKey('/repo', '/repo', 'src/a.ts')).toBe('rel:src/a.ts')
    expect(activityFileKey('/repo', '/repo/packages/x', 'a.ts')).toBe('rel:packages/x/a.ts')
    // A name that merely starts with two dots is still inside the checkout.
    expect(activityFileKey('/repo', '/repo', '..config/a.ts')).toBe('rel:..config/a.ts')
    expect(activityFileKey('/repo', '/other', '/repo/src/a.ts')).toBe('rel:src/a.ts')
  })

  it('keys every path outside the checkout absolute', () => {
    expect(activityFileKey('/repo', '/repo', '../outside/a.ts')).toBe('abs:/outside/a.ts')
    expect(activityFileKey('/repo', '/repo', '/other/a.ts')).toBe('abs:/other/a.ts')
    // The checkout root itself is not a file inside it.
    expect(activityFileKey('/repo', '/repo', '.')).toBe('abs:/repo')
  })
})

describe('peer activity rows', () => {
  it('publishes a row at creation and unlinks it when the session is disposed', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const handle = await harness.createHandle('peer-a')
    const row = await readActivity(harness.home, 'peer-a')
    expect(row).toMatchObject({
      version: 1,
      sessionId: 'peer-a',
      name: 'peer-a',
      status: 'idle',
      cwd: harness.workdir,
      root: await realpathNormalize(harness.workdir),
      pid: process.pid,
      files: [],
    })
    await handle.dispose()
    await vi.waitFor(async () => { expect(await readActivity(harness.home, 'peer-a')).toBeUndefined() })
    await expect(stat(activityPath(harness.home, 'peer-a'))).rejects.toThrow()
  })

  it('records exactly the successful writes of a mutating tool call', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const peer = await harness.create('peer-a')
    toolTurn(peer, 'read', { file_path: 'src/read.ts' })
    toolTurn(peer, 'str_replace_editor', { command: 'view', path: 'src/view.ts' })
    toolTurn(peer, 'write', { file_path: 'src/failed.ts', content: 'x' }, true)
    toolTurn(peer, 'write', { file_path: 'src/empty.ts' })
    toolTurn(peer, 'write', { file_path: 'src/a.ts', content: 'x' })
    await vi.waitFor(async () => { expect(await recordedPaths(harness, 'peer-a')).toEqual(['rel:src/a.ts']) })
    const [file] = (await readActivity(harness.home, 'peer-a'))?.files ?? []
    expect(typeof file?.at).toBe('number')
  })

  it('keys each worktree of one repository against its own root', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    // One repository whose two worktrees reach it through their own gitfiles.
    const mainGit = join(harness.workdir, '.git')
    await mkdir(mainGit, { recursive: true })
    const checkouts = await Promise.all(['checkout-a', 'checkout-b'].map(async (name) => {
      const checkout = join(harness.workdir, name)
      const gitdir = join(mainGit, 'worktrees', name)
      await mkdir(checkout, { recursive: true })
      await mkdir(gitdir, { recursive: true })
      await writeFile(join(gitdir, 'commondir'), '../..\n')
      await writeFile(join(checkout, '.git'), `gitdir: ${gitdir}\n`)
      return await realpathNormalize(checkout)
    }))
    const [first, second] = checkouts as [string, string]
    const one = await harness.create('peer-a', { cwd: first })
    const two = await harness.create('peer-b', { cwd: second })
    toolTurn(one, 'write', { file_path: 'src/a.ts', content: 'x' })
    toolTurn(two, 'write', { file_path: 'src/a.ts', content: 'x' })
    await vi.waitFor(async () => { expect(await recordedPaths(harness, 'peer-b')).toEqual(['rel:src/a.ts']) })
    const rows = await Promise.all(['peer-a', 'peer-b'].map(async id => await readActivity(harness.home, id)))
    expect(rows.map(row => row?.files.map(file => file.p))).toEqual([['rel:src/a.ts'], ['rel:src/a.ts']])
    expect(rows.map(row => row?.root)).toEqual([first, second])
    expect(rows[0]?.repoKey).toBe(`git:${await realpathNormalize(mainGit)}`)
    expect(rows[1]?.repoKey).toBe(rows[0]?.repoKey)
  })

  it('resolves a nested working directory against its own checkout', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await mkdir(join(harness.workdir, '.git'), { recursive: true })
    const nested = join(harness.workdir, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    const nestedPeer = await harness.create('peer-nested', { cwd: nested })
    toolTurn(nestedPeer, 'write', { file_path: 'a.ts', content: 'x' })
    await vi.waitFor(async () => { expect(await recordedPaths(harness, 'peer-nested')).toEqual(['rel:packages/x/a.ts']) })
    expect((await readActivity(harness.home, 'peer-nested'))?.root).toBe(await realpathNormalize(harness.workdir))
  })

  it('keys a path outside the checkout absolute', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const checkout = join(harness.workdir, 'checkout')
    await mkdir(join(checkout, '.git'), { recursive: true })
    const outside = join(harness.workdir, 'outside', 'a.ts')
    const peer = await harness.create('peer-a', { cwd: checkout })
    toolTurn(peer, 'write', { file_path: outside, content: 'x' })
    await vi.waitFor(async () => {
      expect(await recordedPaths(harness, 'peer-a')).toEqual([`abs:${outside}`])
    })
  })

  it('records a subagent\'s writes on its root and gives the subagent no row', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await mkdir(join(harness.workdir, '.git'), { recursive: true })
    await harness.create('peer-a')
    const subagent = await harness.create('peer-sub', {
      meta: { origin: 'subagent', parentSession: SessionId('peer-a'), delegationDepth: 1 },
    })
    const orphan = await harness.create('peer-orphan', {
      meta: { origin: 'subagent', parentSession: SessionId('peer-missing'), delegationDepth: 1 },
    })
    toolTurn(subagent, 'write', { file_path: 'src/a.ts', content: 'x' })
    toolTurn(orphan, 'write', { file_path: 'src/orphan.ts', content: 'x' })
    await vi.waitFor(async () => { expect(await recordedPaths(harness, 'peer-a')).toEqual(['rel:src/a.ts']) })
    expect((await listActivity(harness.home)).map(row => row.sessionId)).toEqual(['peer-a'])
    toolTurn(subagent, 'write', { file_path: 'src/b.ts', content: 'x' }, true)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await recordedPaths(harness, 'peer-a')).toEqual(['rel:src/a.ts'])
  })

  it('takes `doing` from the todo list the root itself wrote', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await harness.create('peer-a')
    const peer = await harness.create('peer-b')
    const subagent = await harness.create('peer-sub', {
      meta: { origin: 'subagent', parentSession: SessionId('peer-b'), delegationDepth: 1 },
    })
    todoTurn(peer, [
      { content: 'read the notes', status: 'pending' },
      { content: 'wire the mailbox', status: 'in_progress' },
    ])
    await vi.waitFor(async () => { expect((await readActivity(harness.home, 'peer-b'))?.doing).toBe('wire the mailbox') })
    todoTurn(peer, [{ content: 'wire the mailbox', status: 'completed' }])
    await vi.waitFor(async () => {
      expect(await readActivity(harness.home, 'peer-b')).not.toHaveProperty('doing')
    })
    todoTurn(subagent, [{ content: 'child work', status: 'in_progress' }])
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await readActivity(harness.home, 'peer-b')).not.toHaveProperty('doing')
  })

  it('keeps the newest files of a session and drops the oldest past the cap', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const peer = await harness.create('peer-a')
    for (let index = 1; index <= 13; index += 1) {
      toolTurn(peer, 'write', { file_path: `src/f${index}.ts`, content: 'x' })
    }
    const newest = Array.from({ length: 12 }, (_, index) => `rel:src/f${13 - index}.ts`)
    await vi.waitFor(async () => { expect(await recordedPaths(harness, 'peer-a')).toEqual(newest) })
  })

  it.skipIf(process.platform === 'win32')('unlinks a row whose process exited', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const exited = spawnSync(process.execPath, ['-e', ''])
    const pid = exited.pid
    if (pid === undefined) throw new Error('spawn produced no pid')
    await mkdir(activityDirectory(harness.home), { recursive: true })
    await writeFile(activityPath(harness.home, 'peer-dead'), rowBody({
      sessionId: 'peer-dead',
      pid,
      root: harness.workdir,
    }))
    expect(await listActivity(harness.home)).toEqual([])
    await expect(stat(activityPath(harness.home, 'peer-dead'))).rejects.toThrow()
  })

  it('skips a row of another version without deleting it', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await harness.create('peer-a')
    const file = activityPath(harness.home, 'peer-newer')
    await mkdir(activityDirectory(harness.home), { recursive: true })
    await writeFile(file, rowBody({ sessionId: 'peer-newer', version: 2, pid: process.pid, root: harness.workdir }))
    await writeFile(activityPath(harness.home, 'peer-broken'), 'not json\n')
    expect((await listActivity(harness.home)).map(row => row.sessionId)).toEqual(['peer-a'])
    expect(await readFile(file, 'utf8')).toContain('"version":2')
  })

})

describe('peer activity configuration', () => {
  /** The exact rejection text one configuration produces. */
  function rejection(config: Config): string {
    try {
      new PeerService(new Context(), config)
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('the service accepted an invalid configuration')
  }

  it('rejects every invalid activity value with its own message', () => {
    const cases: readonly (readonly [Config, string])[] = [
      [{ activityTtlMs: 0 }, 'peer-sessions: activityTtlMs must be a positive safe integer, got 0'],
      [{ maxActivityFiles: 1.5 }, 'peer-sessions: maxActivityFiles must be a positive safe integer, got 1.5'],
      [{ maxActivityPeers: -1 }, 'peer-sessions: maxActivityPeers must be a positive safe integer, got -1'],
      [{ maxActivityBytes: Number.NaN }, 'peer-sessions: maxActivityBytes must be a positive safe integer, got NaN'],
      // A deployment may state any string; the service rejects the unknown mode at load.
      [{ overlap: 'sometimes' as 'warn' }, "peer-sessions: overlap must be 'warn' or 'off', got sometimes"],
    ]
    for (const [config, message] of cases) expect(rejection(config)).toBe(message)
  })
})
