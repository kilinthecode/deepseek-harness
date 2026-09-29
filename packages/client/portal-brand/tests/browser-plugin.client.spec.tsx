// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PortalBrandMark, PortalBrandName, PortalHeroBrandMark } from '../src/client/Brand.tsx'
import type { PortalBrandNameProps } from '../src/client/Brand.tsx'
import { apply, inject, PORTAL_BRAND_PROFILE } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

/** Translate stub for the one key the brand name reads. */
const brandT: PortalBrandNameProps['t'] = key => (key === 'portal' ? 'PORTAL' : key)

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const

/** The real locale service; `apply` registers this package's own dictionary. */
function brandLocale(ctx: Context): void {
  ctx.provide('locale', new LocaleRuntime(ctx))
}

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  brandLocale(ctx)
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('Portal browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('leaves every slot empty outside the portal build profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', PORTAL_BRAND_PROFILE)
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
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', PORTAL_BRAND_PROFILE)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    brandLocale(ctx)
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

  it('renders the Portal mark for both marks and the wordmark with the nameplate as the name', () => {
    const name = render(<PortalBrandName t={brandT} />)
    expect(name.container.textContent).toBe('PORTAL')
    expect(name.container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true')
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('129.348 0 52 24')
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
