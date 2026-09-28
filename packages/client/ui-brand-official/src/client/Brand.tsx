import { BrandWordmark, FishLogo, HarnessNameplate, PortalMark, PortalWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the upstream mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the shipped whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the upstream name artwork without its independently slotted mark.
 * @returns the shipped DeepSeek Harness wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}

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
 * @param props.t - translate seat the sidebar name registration binds to the shared brand vocabulary.
 * @returns the Portal wordmark with its Harness nameplate.
 */
export function PortalBrandName({ t }: PropsLocale<'common'>) {
  return (
    <>
      <PortalWordmark text={t('brand.wordmark')} />
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
