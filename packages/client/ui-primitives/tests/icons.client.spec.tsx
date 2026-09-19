// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconAlarmClockOutline16, IconApiOutline14, IconArchiveOutline20, IconFolderClose16,
  IconGoalOutline16, IconSendOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('ic_ds_ icon set', () => {
  it('exports the full icon set (46 deepsuite + 21 figma extracts + fourteen product glyphs outside those sets)', () => {
    expect(iconNames.length).toBe(81)
    // The composer menu's own glyphs, pinned by name.
    expect(iconNames).toEqual(expect.arrayContaining(['IconPlanOutline14', 'IconCompactOutline16', 'IconShieldOutline16']))
  })

  it('the permission selector composes its marks over the shield contour exported here', () => {
    const { container } = render(<primitives.IconShieldOutline16 />)
    expect(container.querySelector('path')?.getAttribute('d')).toBe(primitives.SHIELD_OUTLINE_PATH)
    expect(container.querySelector('path')?.getAttribute('stroke-width')).toBe(primitives.SHIELD_OUTLINE_STROKE)
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutline14 size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutline14 />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderClose16 />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutline20 />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
    const alarm = render(<IconAlarmClockOutline16 />)
    expect(alarm.container.querySelector('svg')!.getAttribute('width')).toBe('16')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutline16 /><IconGoalOutline16 /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })
})

describe('FishLogo', () => {
  it('renders the fish path in currentColor at the native ratio', () => {
    const { container } = render(<primitives.FishLogo />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(Number(svg.getAttribute('height'))).toBeCloseTo(17.66, 1)
    expect(svg.getAttribute('viewBox')).toBe('0 0 23.16 17.04')
    expect(container.querySelectorAll('path')).toHaveLength(1)
    expect(container.innerHTML).toContain('currentColor')
    expect(container.innerHTML).not.toContain('M0 0L23.16')
  })
})

describe('BrandWordmark', () => {
  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('182')
    expect(svg.getAttribute('viewBox')).toBe('0 0 182 24')

    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(svg.getAttribute('width')).toBe('156')
    expect(svg.getAttribute('viewBox')).toBe('26 0 156 24')
  })
})

describe('PortalMark', () => {
  it('draws both tesseract cells, their spokes, and the edges between them', () => {
    const { container } = render(<primitives.PortalMark />)
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
    const { container } = render(<primitives.PortalMark size={34} className="hero" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('34')
    expect(svg.getAttribute('height')).toBe('34')
    expect(svg.getAttribute('class')).toBe('hero')
    const strokes = container.querySelectorAll('polygon, line')
    expect([...strokes].every(element => element.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  })
})

describe('PortalWordmark', () => {
  it('renders the tracked brand lettering as decorative text', () => {
    const { container } = render(<primitives.PortalWordmark />)
    const span = container.querySelector('span')!
    expect(span.textContent).toBe('PORTAL')
    expect(span.getAttribute('aria-hidden')).toBe('true')
  })

  it('scales by font size and takes a layout class', () => {
    const { container } = render(<primitives.PortalWordmark size={20} className="wide" />)
    const span = container.querySelector('span')!
    expect(span.style.fontSize).toBe('20px')
    expect(span.className).toContain('wide')
  })
})

describe('HarnessNameplate', () => {
  it('renders the nameplate alone at its wordmark position and ratio', () => {
    const view = render(<primitives.HarnessNameplate />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('52')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('129.348 0 52 24')
    expect(view.container.querySelectorAll('path')).toHaveLength(7)

    view.rerender(<primitives.HarnessNameplate size={12} className="tight" />)
    expect(svg.getAttribute('width')).toBe('26')
    expect(svg.getAttribute('height')).toBe('12')
    expect(svg.getAttribute('class')).toBe('tight')
  })
})
