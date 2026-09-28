/** Brand occupants for the generic browser-brand slots, one set per build profile. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  OfficialBrandMark,
  OfficialBrandName,
  PortalBrandMark,
  PortalBrandName,
  PortalHeroBrandMark,
} from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/** Build profile that selects the Portal product identity. */
const PORTAL_BUILD_PROFILE = 'portal'
/** Build profile that keeps the upstream product identity. */
const OFFICIAL_BUILD_PROFILE = 'official'

/**
 * Fill the brand slots for the active build profile as declaration-aware
 * registrations. The sidebar pair installs as one set so its mark and name
 * never mix across HMR; the Portal hero mark waits on its own declaration,
 * because a composition without a Conversation still shows the sidebar brand.
 *
 * The `official` profile renders the shipped upstream brand — the fish mark and
 * the `DeepSeek Harness` wordmark, which the committed expectations pin — and
 * every other dressed profile shows this fork's brand. A profile this package
 * does not dress leaves every slot on its declaring package's fallback. The
 * Portal name entry declares the shared `common` namespace so the render
 * machinery synthesizes the `t` seat that carries its wordmark copy.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const profile = process.env.DSH_CLIENT_BUILD_PROFILE
  const upstream = profile === OFFICIAL_BUILD_PROFILE
  if (!upstream && profile !== PORTAL_BUILD_PROFILE) return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      if (upstream) {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
        return
      }
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PortalBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: 'common' }, PortalBrandName)
    }))
  if (upstream) return
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PortalHeroBrandMark))
}
