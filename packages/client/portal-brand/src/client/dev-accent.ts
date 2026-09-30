/**
 * The dev variant's theme layer: a token-override stack applied on top of the
 * active base palette, mirroring how `ui-theme` mounts its stylesheet layers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'

/** Source id of the dev accent layer, named so the stack stays attributable. */
const DEV_ACCENT_SOURCE = 'portal-brand.dev'

/**
 * The dev accent: the brand accent and link recolored to violet on both
 * palette modes, so a dev build reads differently at a glance while every
 * surface stacked on those tokens stays legible in light and dark.
 */
const DEV_ACCENT_TOKENS = {
  '--dsw-alias-brand-primary': { light: 'rgb(124, 58, 237)', dark: 'rgb(167, 139, 250)' },
  '--dsw-alias-link': { light: 'rgb(124, 58, 237)', dark: 'rgb(167, 139, 250)' },
} as const

/**
 * Stack the dev accent layer for the calling plugin's lifetime.
 *
 * The theme service is read as an optional service: every shipped roster that
 * builds the dev profile composes `ui-theme`, and a composition without it
 * keeps the base accent while the dev chip still marks the build.
 * @param ctx - Client root context whose theme service carries the layer.
 */
export function applyDevAccent(ctx: ClientContext): void {
  const theme = ctx.get('theme')
  if (theme === undefined) return
  ctx.effect(() => theme.overrideTokens(DEV_ACCENT_SOURCE, DEV_ACCENT_TOKENS), 'portal-brand: dev accent layer')
}
