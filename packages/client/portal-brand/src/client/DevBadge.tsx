// DevBadge: the dev-channel chip beside the Portal wordmark, so a dev build is
// never mistaken for the production one.

import clsx from 'clsx'
import css from './DevBadge.module.css'

/** Display options for the dev-channel chip. */
export interface DevBadgeProps {
  /** Chip text, supplied by the caller so this primitive owns no copy. */
  label: string
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the dev-channel chip.
 *
 * The chip fills with `--dsw-alias-brand-primary`, which the dev variant's
 * theme layer recolors, and reads `aria-hidden` like the wordmark beside it:
 * the surrounding surface names the product.
 * @param props.label - chip text owned by the caller's locale dictionary.
 * @param props.className - extra class for layout placement.
 * @returns the chip span.
 */
export function DevBadge({ label, className }: DevBadgeProps) {
  return (
    <span className={clsx(css.badge, className)} aria-hidden="true">
      {label}
    </span>
  )
}
