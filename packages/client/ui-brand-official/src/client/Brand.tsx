import { HarnessNameplate, PortalMark, PortalWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Portal mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Portal tesseract mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <PortalMark size={size} />
}

/**
 * Render the product name without its independently slotted mark: the Portal
 * wordmark followed by the HARNESS nameplate on the same brand row.
 * @returns the Portal wordmark with its Harness nameplate.
 */
export function OfficialBrandName() {
  return (
    <>
      <PortalWordmark />
      <HarnessNameplate />
    </>
  )
}

/**
 * Render the Portal mark where the blank-session hero places and sizes it.
 * @param props - Host-supplied hero mark presentation.
 * @returns the Portal tesseract mark.
 */
export function OfficialHeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <PortalMark size={size} className={className} />
}
