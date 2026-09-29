// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessNameplate } from '../src/client/HarnessNameplate.tsx'
import { PortalMark } from '../src/client/PortalMark.tsx'
import { PortalWordmark } from '../src/client/PortalWordmark.tsx'

afterEach(cleanup)

describe('PortalMark', () => {
  it('draws both tesseract cells, their spokes, and the edges between them', () => {
    const { container } = render(<PortalMark />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    const cells = container.querySelectorAll('polygon')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.getAttribute('points')).toContain('512,369.2')
    expect(cells[1]!.getAttribute('points')).toContain('512,172')
    expect(container.querySelectorAll('line')).toHaveLength(18)
  })

  it('sizes to the requested edge and holds every stroke against the frame', () => {
    const { container } = render(<PortalMark size={34} className="hero" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('34')
    expect(svg.getAttribute('height')).toBe('34')
    expect(svg.getAttribute('class')).toBe('hero')
    const strokes = container.querySelectorAll('polygon, line')
    expect([...strokes].every(element => element.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  })
})

describe('PortalWordmark', () => {
  it('renders the caller-supplied lettering as decorative text', () => {
    const { container } = render(<PortalWordmark text="PORTAL" />)
    const span = container.querySelector('span')!
    expect(span.textContent).toBe('PORTAL')
    expect(span.getAttribute('aria-hidden')).toBe('true')
  })

  it('scales by font size and takes a layout class', () => {
    const { container } = render(<PortalWordmark text="PORTAL" size={20} className="wide" />)
    const span = container.querySelector('span')!
    expect(span.style.fontSize).toBe('20px')
    expect(span.className).toContain('wide')
  })
})

describe('HarnessNameplate', () => {
  it('renders the nameplate alone at its wordmark position and ratio', () => {
    const view = render(<HarnessNameplate />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('52')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('129.348 0 52 24')
    expect(view.container.querySelectorAll('path')).toHaveLength(7)

    view.rerender(<HarnessNameplate size={12} className="tight" />)
    expect(svg.getAttribute('width')).toBe('26')
    expect(svg.getAttribute('height')).toBe('12')
    expect(svg.getAttribute('class')).toBe('tight')
  })
})
