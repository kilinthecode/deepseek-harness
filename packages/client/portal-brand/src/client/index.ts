/** Portal brand occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PortalBrandMark, PortalBrandName, PortalHeroBrandMark } from './Brand.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/** Build profile that selects the fork's product identity. */
export const PORTAL_BRAND_PROFILE = 'portal'

/**
 * Fill every brand slot as declaration-aware registrations.
 *
 * The occupants install only for the fork's build profile. The upstream
 * occupants install only for `official`, so exactly one of the two ever
 * occupies a `single` slot.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== PORTAL_BRAND_PROFILE) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'portal-brand:dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PortalBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, PortalBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PortalHeroBrandMark))
}
