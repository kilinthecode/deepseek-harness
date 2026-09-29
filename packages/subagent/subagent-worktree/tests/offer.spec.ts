/** Isolation offers: counted registrations, the flip event, and listener containment. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentWorktrees from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * A service built as `dsh-base` builds it, on a context whose `offer-changed` events a listener records: the
 * value each event carried, and what `offersIsolation` read at the moment the listener ran.
 */
function serviceWithEvents(): { ctx: Context; service: SubagentWorktrees; flips: boolean[]; readDuringEvent: boolean[] } {
  const ctx = new Context()
  contexts.push(ctx)
  const flips: boolean[] = []
  const readDuringEvent: boolean[] = []
  const service = new SubagentWorktrees(ctx, SubagentWorktrees.Config())
  ctx.on('subagent-worktree/offer-changed', (offered) => {
    flips.push(offered)
    readDuringEvent.push(service.offersIsolation)
  })
  return { ctx, service, flips, readDuringEvent }
}

describe('isolation offers', () => {
  it('offers nothing until an offer is registered', () => {
    const { service, flips } = serviceWithEvents()

    expect(service.offersIsolation).toBe(false)
    expect(flips).toEqual([])
  })

  it('stands while any registration is live: two offers, one withdrawn, still offered; both withdrawn, not', () => {
    const { service } = serviceWithEvents()

    const first = service.offerIsolation()
    const second = service.offerIsolation()
    expect(service.offersIsolation).toBe(true)

    first()
    expect(service.offersIsolation).toBe(true)
    second()
    expect(service.offersIsolation).toBe(false)
  })

  it('fires offer-changed only when the offer flips, carrying the new value', () => {
    const { service, flips } = serviceWithEvents()

    const first = service.offerIsolation()
    expect(flips).toEqual([true])
    const second = service.offerIsolation()
    first()
    // The offer stayed on through the second registration and the first withdrawal.
    expect(flips).toEqual([true])
    second()
    expect(flips).toEqual([true, false])
    service.offerIsolation()()
    expect(flips).toEqual([true, false, true, false])
  })

  it('reports a flip after the count changed, so a listener reading offersIsolation sees the new value', () => {
    const { service, flips, readDuringEvent } = serviceWithEvents()

    service.offerIsolation()()

    expect(flips).toEqual([true, false])
    expect(readDuringEvent).toEqual([true, false])
  })

  it('withdraws a registration once, so a repeated disposer call cannot end another registration\'s offer', () => {
    const { service, flips } = serviceWithEvents()
    const first = service.offerIsolation()
    const second = service.offerIsolation()

    first()
    first()

    expect(service.offersIsolation).toBe(true)
    expect(flips).toEqual([true])
    second()
    expect(service.offersIsolation).toBe(false)
    expect(flips).toEqual([true, false])
  })

  it('keeps the count and hands back the disposer when a listener throws or rejects, and still notifies the others', async () => {
    const { ctx, service, flips } = serviceWithEvents()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('subagent-worktree/offer-changed', () => { throw new Error('remount failed') })
    // oxlint-disable-next-line typescript/no-misused-promises -- a listener that breaks the void return type must not break the offer
    ctx.on('subagent-worktree/offer-changed', () => Promise.reject(new Error('async remount failed')))
    const seen: boolean[] = []
    ctx.on('subagent-worktree/offer-changed', (offered) => { seen.push(offered) })

    const withdraw = service.offerIsolation()
    expect(service.offersIsolation).toBe(true)
    expect(flips).toEqual([true])
    expect(seen).toEqual([true])
    withdraw()
    expect(service.offersIsolation).toBe(false)
    expect(seen).toEqual([true, false])

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener threw: Error: remount failed'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener rejected: Error: async remount failed'))
    })
  })

  it('counts each service instance on its own', () => {
    const { service: first } = serviceWithEvents()
    const { service: second } = serviceWithEvents()

    first.offerIsolation()

    expect(first.offersIsolation).toBe(true)
    expect(second.offersIsolation).toBe(false)
  })
})
