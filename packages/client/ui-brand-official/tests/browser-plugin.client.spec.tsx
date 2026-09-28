// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import {
  OfficialBrandMark,
  OfficialBrandName,
  PortalBrandMark,
  PortalBrandName,
  PortalHeroBrandMark,
} from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('leaves every slot empty outside a dressed build profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('dresses the sidebar alone for the upstream profile, whose hero keeps its own fallback', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    expect(subject.slots.entries('sidebar.brand.mark')).toHaveLength(1)
    expect(subject.slots.entries('sidebar.brand.name')).toHaveLength(1)
    expect(subject.slots.entries('conversation.hero.brand.mark')).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'portal')
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('keeps the sidebar brand when a composition declares no Conversation hero', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'portal')
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('sidebar.brand.mark')).toHaveLength(1)
    expect(slots.entries('sidebar.brand.name')).toHaveLength(1)
    expect(slots.entries('conversation.hero.brand.mark')).toHaveLength(0)
  })

  it('renders the upstream brand for the profile that keeps upstream identity', () => {
    const name = render(<OfficialBrandName />)
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('26 0 156 24')
    name.unmount()

    const mark = render(<OfficialBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 23.16 17.04')
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })

  it('renders the Portal mark for both marks and the wordmark with the nameplate as the name', () => {
    const name = render(<PortalBrandName t={() => 'PORTAL'} />)
    expect(name.container.textContent).toBe('PORTAL')
    expect(name.container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true')
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('129.348 0 52 24')

    // The name owns no copy: the bound dictionary value decides the rendered
    // wordmark, so the mark and nameplate never carry a second product string.
    name.rerender(<PortalBrandName t={() => 'PORTAL 品牌'} />)
    expect(name.container.textContent).toBe('PORTAL 品牌')
    name.unmount()

    const mark = render(<PortalBrandMark size={34} />)
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    mark.rerender(<PortalBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
    mark.unmount()

    const hero = render(<PortalHeroBrandMark size={34} className="heroMark" />)
    const heroSvg = hero.container.querySelector('svg')!
    expect(heroSvg.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(heroSvg.getAttribute('width')).toBe('34')
    expect(heroSvg.getAttribute('class')).toBe('heroMark')
  })
})
