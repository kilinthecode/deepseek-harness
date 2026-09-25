/** Shared props for the Portal brand artwork this package owns. */

/** Display options for one square brand mark. */
export interface BrandArtworkProps {
  /** Square edge in px; defaults to the mark's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
}
