// PortalWordmark: the lettered half of the product brand — wide-tracked
// capitals sized to sit beside the PortalMark tesseract on the 24px brand row.

import clsx from 'clsx'
import css from './PortalWordmark.module.css'

/** Display options for the Portal wordmark. */
export interface PortalWordmarkProps {
  /** Font size in px (default 15; cap height optically centers against a 24px PortalMark). */
  size?: number | undefined
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the Portal wordmark.
 * @param props.size - font size in px (default 15).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark span (aria-hidden decorative brand art; pair it with visible product text elsewhere on the page).
 */
export function PortalWordmark({ size = 15, className }: PortalWordmarkProps) {
  return (
    <span
      className={clsx(css.wordmark, className)}
      style={{ fontSize: `${String(size)}px` }}
      aria-hidden="true"
    >
      PORTAL
    </span>
  )
}
