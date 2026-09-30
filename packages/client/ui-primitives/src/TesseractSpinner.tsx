import clsx from 'clsx'
import css from './TesseractSpinner.module.css'

/**
 * Indeterminate loading spinner: the tesseract wireframe — an outer cell, its
 * inner cell, and the four edges between them — turning once per cycle. The
 * figure rotates rigidly so both cells and their edges stay one projection at
 * every angle. Decorative (`aria-hidden`), so the render site owns the name.
 * @param props.size - rendered box in px (default 16).
 * @param props.className - extra class for layout placement.
 * @returns the spinning tesseract svg.
 */
export function TesseractSpinner({ size = 16, className }: {
  size?: number | undefined
  className?: string | undefined
}) {
  return (
    <svg
      className={clsx(css.spinner, className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2 2H14V14H2Z" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.75 5.75H10.25V10.25H5.75Z" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M2 2 5.75 5.75M14 2 10.25 5.75M14 14 10.25 10.25M2 14 5.75 10.25"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  )
}
