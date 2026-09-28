/**
 * Presence folds that only the approval, question, and disposal lifecycles reach.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { watchShardDirectory } from '../src/paths.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

describe('awaiting-user presence', () => {
  it('reports awaiting-user while an approval is undecided and running once it is decided', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id === 'peer-b') await held
      return await next()
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    const requestId = brandString<ApprovalRequestId>('approval-shared-ref')
    target.session.append('approval/asked', { id: requestId, toolName: 'bash' })
    try {
      await vi.waitFor(async () => {
        expect((await harness.ctx.peers.list(caller)).map(peer => peer.status)).toEqual(['awaiting-user'])
      })
      target.session.append('approval/decided', { id: requestId, outcome: 'allowed-once' })
      await vi.waitFor(async () => {
        expect((await harness.ctx.peers.list(caller)).map(peer => peer.status)).toEqual(['running'])
      })
    } finally {
      release()
    }
    await target.whenIdle()
  })

  it('leaves a question that names no agent to the rest of the answerer chain', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    let answered = false
    const answer = await harness.ctx.waterfall('user-questions/request', {
      questions: [{ id: 'q-ref', question: 'which ref?' }],
    }, async () => {
      answered = true
      return { answers: [] }
    })
    expect(answered).toBe(true)
    expect(answer).toEqual({ answers: [] })
  })

  it('skips a peer with no working directory while resolving the others', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    await harness.create('peer-nocwd', { cwd: null })
    const caller = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    expect((await harness.ctx.peers.send(caller, { to: 'peer-b', message: 'hi' })).status).toBe('delivered')
    await target.whenIdle()
    expect(harness.userMessages(target)).toHaveLength(1)
  })

  it('deletes an unreadable watch file when its target is disposed', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const handle = await harness.createHandle('peer-t')
    const shard = watchShardDirectory(harness.home, 'peer-t')
    await mkdir(shard, { recursive: true, mode: 0o700 })
    const invalid = join(shard, 'peer-watch-garbage.json')
    await writeFile(invalid, '{ not a watch')
    await handle.dispose()
    await vi.waitFor(async () => {
      await expect(stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
