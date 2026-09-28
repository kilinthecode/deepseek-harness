import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mailDirectory, mailShardDirectory, watchShardDirectory } from '../src/paths.ts'
import { readPresence, writePresence } from '../src/presence.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Hold one agent's step so it stays running while the test drives the service. */
function gate(harness: PeerHarness, id: string): () => void {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  harness.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id === id) await held
    return await next()
  })
  return release
}

/** Plant one valid envelope whose sender lives in the same repository as `fromRepo`. */
function envelopeFor(targetId: string, messageId: string, fromRepo: string): string {
  return `${JSON.stringify({
    version: 1,
    messageId,
    targetId,
    senderSessionId: 'peer-sender',
    senderName: 'peer-sender',
    fromRepo,
    relayDepth: 1,
    kind: 'peer-message',
    text: 'planted',
  })}\n`
}

/** Repository key one created agent published. */
async function repoKeyOf(harness: PeerHarness, id: string): Promise<string> {
  const row = await readPresence(harness.home, SessionId(id))
  if (row === undefined) throw new Error(`${id} published no presence row`)
  return row.repoKey
}

describe('peer service failure handling and edge paths', () => {
  it('orders listed peers by name, resolves a unique name, and refuses a shared or foreign one', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const row = await readPresence(harness.home, SessionId('peer-a'))
    if (row === undefined) throw new Error('peer-a published no presence row')
    const base = { version: 1 as const, cwd: row.cwd, repoKey: row.repoKey, status: 'idle' as const, pid: process.pid }
    await writePresence(harness.home, { ...base, sessionId: SessionId('peer-twin-1'), name: 'twin' })
    await writePresence(harness.home, { ...base, sessionId: SessionId('peer-twin-2'), name: 'twin' })
    await writePresence(harness.home, { ...base, sessionId: SessionId('peer-unique'), name: 'unique' })
    await writePresence(harness.home, { ...base, sessionId: SessionId('peer-elsewhere'), name: 'elsewhere', repoKey: 'dir:/elsewhere' })
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.name)).toEqual(['twin', 'twin', 'unique'])
    await expect(harness.ctx.peers.send(caller, { to: 'twin', message: 'hi' }))
      .rejects.toThrow('More than one peer is named "twin". Pass the session id.')
    await expect(harness.ctx.peers.send(caller, { to: 'elsewhere', message: 'hi' }))
      .rejects.toThrow('That peer is in a different repository.')
    await expect(harness.ctx.peers.send(caller, { to: 'unique', message: 'hi' }))
      .resolves.toMatchObject({ status: 'queued' })
    await expect(harness.ctx.peers.send(caller, { to: 'nobody', message: 'hi' }))
      .rejects.toThrow('No peer session named "nobody" is live in this repository.')
  })

  it('refuses a caller that is not a top-level peer', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const subagent = await harness.create('peer-sub', { meta: { origin: 'subagent' } })
    await expect(harness.ctx.peers.list(subagent))
      .rejects.toThrow('Only top-level sessions in this repository can message each other.')
    await expect(harness.ctx.peers.notifyIdle(subagent, { to: 'peer-a' }))
      .rejects.toThrow('Only top-level sessions in this repository can message each other.')
  })

  it('serves and ignores an agent whose peer state was retired', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await harness.create('peer-b')
    const bare = await harness.create('peer-bare', { cwd: null })
    // A duplicate disposal retires the state this service tracks for a live root.
    harness.ctx.emit('agent/disposed', { agent: caller })
    harness.ctx.emit('agent/disposed', { agent: caller })
    harness.ctx.emit('agent/status', { agent: caller, status: 'idle' })
    harness.ctx.emit('agent/disposed', { agent: bare })
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual(['peer-b'])
    let answered = false
    await harness.ctx.waterfall('user-questions/request', {
      questions: [{ id: 'q-ref', question: 'which ref?' }],
      agent: caller,
    }, async () => {
      answered = true
      return { answers: [] }
    })
    expect(answered).toBe(true)
  })

  it('publishes nothing for a question asked by a subagent', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const subagent = await harness.create('peer-sub', { meta: { origin: 'subagent' } })
    const answer = await harness.ctx.waterfall('user-questions/request', {
      questions: [{ id: 'q-ref', question: 'which ref?' }],
      agent: subagent,
    }, async () => ({ answers: [] }))
    expect(answer).toEqual({ answers: [] })
    expect(harness.events(subagent).filter(event => event.type.startsWith('approval/'))).toEqual([])
  })

  it('warns instead of failing when a presence row cannot be written', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await mkdir(join(harness.home, 'peers'), { recursive: true, mode: 0o700 })
    await writeFile(join(harness.home, 'peers', 'presence'), 'not a directory')
    await harness.create('peer-a')
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('publishing presence'))).toBe(true)
    })
  })

  it('warns instead of failing when a mailbox shard cannot be read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 } })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.create('peer-t')
    await mkdir(mailDirectory(harness.home), { recursive: true, mode: 0o700 })
    await writeFile(mailShardDirectory(harness.home, 'peer-t'), 'not a directory')
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('draining peer'))).toBe(true)
    })
  })

  it('renders a non-Error checkpoint failure as its own text', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const sender = await harness.create('peer-a')
    await harness.create('peer-b')
    let mode = 'string'
    harness.ctx.on('session/flush', (session) => {
      if (session.id !== 'peer-b') return
      if (mode === 'string') throw 'flush refused'
      throw { code: 'flush-refused' }
    })
    const first = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'one' })
    expect(typeof first.messageId).toBe('string')
    expect(warn.mock.calls.some(call => String(call[0]).includes('flush refused'))).toBe(true)
    mode = 'object'
    await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'two' })
    expect(warn.mock.calls.some(call => String(call[0]).includes('flush-refused'))).toBe(true)
  })

  it('retires unreadable watch files on reap, on idle, and on disposal', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 } })
    harnesses.push(harness)
    await harness.create('peer-w')
    const handle = await harness.createHandle('peer-t')
    const directory = watchShardDirectory(harness.home, 'peer-t')
    const plant = async (): Promise<void> => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'garbage.json'), '{not json')
    }
    await plant()
    await vi.waitFor(async () => {
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await plant()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await vi.waitFor(async () => {
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await plant()
    await handle.dispose()
    await vi.waitFor(async () => {
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('warns when an idle notice cannot fit the watcher mailbox', async () => {
    const harness = await mountPeerHarness({
      peer: { pollMs: 5, maxPendingPerTarget: 1, maxPendingPerSenderPerTarget: 1 },
    })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    try {
      target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(target.status).toBe('running') })
      expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
      await harness.plantMail('peer-w', 'planted.json', envelopeFor('peer-w', 'peer-message-planted', await repoKeyOf(harness, 'peer-w')))
    } finally {
      release()
    }
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('idle notice for peer'))).toBe(true)
    })
  })

  it('keeps an envelope whose splice is only pending after a creation idle flicker', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await harness.create('peer-a')
    await harness.plantMail('peer-t', 'peer-message-latched.json', envelopeFor('peer-t', 'peer-message-latched', await repoKeyOf(harness, 'peer-a')))
    const target = await harness.create('peer-t')
    await vi.waitFor(() => {
      expect(harness.userMessages(target).map(message => message.source.kind)).toEqual(['peer-message'])
    })
    expect(harness.userMessages(target)[0]?.source.kind).toBe('peer-message')
  })
})
