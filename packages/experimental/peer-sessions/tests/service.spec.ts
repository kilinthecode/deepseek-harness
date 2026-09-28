import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import PeerService, { Config, PeerError } from '../src/index.ts'

describe('PeerService configuration', () => {
  it('ships the documented peer limits and inbound mode', () => {
    expect(Config({})).toEqual({
      pollMs: 1_000,
      maxPendingPerTarget: 8,
      maxPendingPerSenderPerTarget: 4,
      maxMessageBytes: 8_192,
      maxIdleWatches: 32,
      peerInbound: 'steer',
    })
  })

  it('accepts stated limits and an explicit deferred inbound mode', () => {
    expect(() => new PeerService(new Context(), Config({
      pollMs: 250,
      maxPendingPerTarget: 8,
      maxPendingPerSenderPerTarget: 8,
      maxMessageBytes: 1_024,
      maxIdleWatches: 1,
      peerInbound: 'deferred',
    }))).not.toThrow()
    expect(() => new PeerService(new Context(), {})).not.toThrow()
  })

  it('rejects a limit that is not a positive safe integer', () => {
    expect(() => new PeerService(new Context(), { pollMs: 0 }))
      .toThrow(/pollMs must be a positive safe integer/)
    expect(() => new PeerService(new Context(), { maxPendingPerTarget: 1.5 }))
      .toThrow(/maxPendingPerTarget must be a positive safe integer/)
    expect(() => new PeerService(new Context(), { maxMessageBytes: Number.NaN }))
      .toThrow(/maxMessageBytes must be a positive safe integer/)
  })

  it('rejects an unknown inbound mode and a sender cap above the target cap', () => {
    expect(() => new PeerService(new Context(), { peerInbound: 'sometimes' as never }))
      .toThrow(/peerInbound must be 'steer' or 'deferred'/)
    expect(() => new PeerService(new Context(), { maxPendingPerSenderPerTarget: 9 }))
      .toThrow(/maxPendingPerSenderPerTarget must not exceed maxPendingPerTarget/)
  })

  it('registers ctx.peers for a loaded fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PeerService, { pollMs: 5 })
    try {
      expect(ctx.peers).toBeInstanceOf(PeerService)
      expect(typeof ctx.peers.list).toBe('function')
      expect(typeof ctx.peers.send).toBe('function')
      expect(typeof ctx.peers.notifyIdle).toBe('function')
    } finally {
      await fiber.dispose()
    }
  })

  it('declares the schema as the plugin config slot', () => {
    expect(PeerService.Config).toBe(Config)
  })
})

describe('PeerService methods', () => {
  it('rejects every unimplemented method until the mailbox provider lands', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PeerService, {})
    try {
      await expect(ctx.peers.list(undefined as never)).rejects.toThrow('not implemented')
      await expect(ctx.peers.send(undefined as never, { to: 'peer', message: 'hello' }))
        .rejects.toThrow('not implemented')
      await expect(ctx.peers.notifyIdle(undefined as never, { to: 'peer' }))
        .rejects.toThrow('not implemented')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('PeerError', () => {
  it('carries the code and presents the exact model-visible message', () => {
    const message = 'No peer session named "missing" is live in this repository.'
    const error = new PeerError('PEER_NOT_FOUND', message)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PeerError')
    expect(error.code).toBe('PEER_NOT_FOUND')
    expect(error.message).toBe(message)
  })
})
