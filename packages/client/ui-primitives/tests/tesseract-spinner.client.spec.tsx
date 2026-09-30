// @vitest-environment jsdom
/** The shared loading spinner: a decorative tesseract wireframe sized by its caller. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TesseractSpinner } from '../src/TesseractSpinner.tsx'

afterEach(cleanup)

describe('TesseractSpinner', () => {
  it('draws the tesseract figure as a decorative mark at the default size', () => {
    const { container } = render(<TesseractSpinner />)
    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('the spinner must render an svg')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    // Outer cell, inner cell, and the four edges between them.
    expect(container.querySelectorAll('path').length).toBe(3)
  })

  it('takes its size and layout class from the caller', () => {
    const { container } = render(<TesseractSpinner size={28} className="seat" />)
    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('the spinner must render an svg')
    expect(svg.getAttribute('width')).toBe('28')
    expect(svg.getAttribute('height')).toBe('28')
    expect(svg.getAttribute('class')).toContain('seat')
  })
})
