/** Portal brand occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PortalBrandMark, PortalBrandName, PortalDevBrandName, PortalHeroBrandMark } from './Brand.tsx'
import { applyDevAccent } from './dev-accent.ts'
import { en, NS, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/** Build profile that selects the fork's product identity. */
export const PORTAL_BRAND_PROFILE = 'portal'

/** Build profile that selects the fork's dev-channel identity. */
export const PORTAL_DEV_BRAND_PROFILE = 'portal-dev'

/**
 * Fill every brand slot as declaration-aware registrations.
 *
 * The occupants install only for a fork build profile — `portal`, or its
 * dev-channel sibling `portal-dev`. The upstream occupants install only for
 * `official`, so exactly one of the two ever occupies a `single` slot. The dev
 * profile registers the dev-channel name and stacks its accent layer over
 * whatever base palette the user chose.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const profile = process.env.DSH_CLIENT_BUILD_PROFILE
  const dev = profile === PORTAL_DEV_BRAND_PROFILE
  if (profile !== PORTAL_BRAND_PROFILE && !dev) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'portal-brand:dictionaries')
  if (dev) applyDevAccent(ctx)
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PortalBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, dev ? PortalDevBrandName : PortalBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PortalHeroBrandMark))
}
