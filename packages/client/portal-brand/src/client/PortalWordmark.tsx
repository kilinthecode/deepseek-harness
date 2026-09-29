// PortalWordmark: the lettered half of the product brand — wide-tracked
// capitals sized to sit beside the PortalMark tesseract on the 24px brand row.

import clsx from 'clsx'
import css from './PortalWordmark.module.css'

/** Display options for the Portal wordmark. */
export interface PortalWordmarkProps {
  /** Wordmark text, supplied by the caller so this primitive owns no copy. */
  text: string
  /** Font size in px (default 15; cap height optically centers against a 24px PortalMark). */
  size?: number | undefined
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the Portal wordmark.
 *
 * The span is `aria-hidden` brand art: the surrounding control carries the
 * accessible name, so the caller supplies `text` rather than this primitive
 * owning a fallback string.
 * @param props.text - wordmark text owned by the caller's locale dictionary.
 * @param props.size - font size in px (default 15).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark span.
 */
export function PortalWordmark({ text, size = 15, className }: PortalWordmarkProps) {
  return (
    <span
      className={clsx(css.wordmark, className)}
      style={{ fontSize: `${String(size)}px` }}
      aria-hidden="true"
    >
      {text}
    </span>
  )
}
