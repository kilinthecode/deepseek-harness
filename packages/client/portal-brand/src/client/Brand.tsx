/**
 * Portal brand occupants for the generic browser-brand slots.
 *
 * This package is fork-owned: it exists so the fork's product identity lives
 * outside the upstream brand packages, which upstream keeps editing. The
 * upstream occupants in `@deepseek-ai/dsh-client-ui-brand-official` register
 * only for the `official` build profile, so the two never contend for a slot.
 */

import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { HarnessNameplate } from './HarnessNameplate.tsx'
import { PortalMark } from './PortalMark.tsx'
import { PortalWordmark } from './PortalWordmark.tsx'
import type { NS } from './locales.ts'

/** Props of the Portal brand name: its own locale seat supplies the wordmark copy. */
export type PortalBrandNameProps = PropsLocale<typeof NS>

/**
 * Render the Portal mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Portal tesseract mark.
 */
export function PortalBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <PortalMark size={size} />
}

/**
 * Render the product name without its independently slotted mark: the Portal
 * wordmark followed by the HARNESS nameplate on the same brand row.
 * @param props.t - translate seat bound to this package's brand namespace.
 * @returns the Portal wordmark with its Harness nameplate.
 */
export function PortalBrandName({ t }: PortalBrandNameProps) {
  return (
    <>
      <PortalWordmark text={t('portal')} />
      <HarnessNameplate />
    </>
  )
}

/**
 * Render the Portal mark where the blank-session hero places and sizes it.
 * @param props - Host-supplied hero mark presentation.
 * @returns the Portal tesseract mark.
 */
export function PortalHeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <PortalMark size={size} className={className} />
}
