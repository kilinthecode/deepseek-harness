import { BrandNameplateArtwork } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrandArtworkProps } from './props.ts'

/** Wordmark coordinates of the HARNESS nameplate; both renderings place it at the same position. */
const HARNESS_NAMEPLATE_VIEWBOX = '129.348 0 52 24'

/** Nameplate width in wordmark coordinates, used to size the standalone rendering. */
const NAMEPLATE_WIDTH = 52

/**
 * Render the HARNESS nameplate artwork in wordmark coordinates.
 * @returns the plate and its knocked-out glyphs, for embedding in a larger brand svg.
 */
export function HarnessNameplateArtwork() {
  return (
    <>
      <rect x="129.348" y="5.5" width="52" height="14" rx="2" fill="currentColor"/>
      {/* The glyph geometry is shared with the full wordmark primitive. */}
      <BrandNameplateArtwork />
    </>
  )
}

/**
 * Render the HARNESS nameplate as a standalone brand mark.
 * @param props.size - height in px (default 24; width keeps the plate ratio).
 * @param props.className - extra class for layout placement.
 * @returns the nameplate svg (aria-hidden decorative brand art).
 */
export function HarnessNameplate({ size = 24, className }: BrandArtworkProps) {
  return (
    <svg
      width={(size * NAMEPLATE_WIDTH) / 24}
      height={size}
      className={className}
      viewBox={HARNESS_NAMEPLATE_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      <HarnessNameplateArtwork />
    </svg>
  )
}
