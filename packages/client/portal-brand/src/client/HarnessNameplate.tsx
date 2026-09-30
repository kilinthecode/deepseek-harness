import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrandArtworkProps } from './props.ts'

/**
 * Render the HARNESS nameplate as a standalone brand mark.
 * @param props.size - height in px (default 24; width keeps the plate ratio).
 * @param props.className - extra class for layout placement.
 * @returns the nameplate svg (aria-hidden decorative brand art).
 */
export function HarnessNameplate({ size = 24, className }: BrandArtworkProps) {
  return <BrandWordmark size={size} className={className} nameplateOnly />
}
