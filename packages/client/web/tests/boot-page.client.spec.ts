// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'
import css from '../src/boot-page.module.css'

// Every case drives the page's own schedule, so no pending reveal escapes into
// the next one.
beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

function finishBrand(el: HTMLElement): void {
  el.querySelector(`.${css.plate!} .${css.letter!}:last-child`)!.dispatchEvent(new Event('animationend', { bubbles: true }))
}

/** The status block only joins the card once boot outlasts the brand moment. */
const STATUS_MS = 4000

describe('BootPage', () => {
  it('draws the brand before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.querySelector(`.${css.mark!}`)?.getAttribute('aria-hidden')).toBe('true')
    expect(el.textContent).toContain('PORTAL')
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Portal Harness')
  })

  it('draws the center spokes before connecting the inner and outer cells', () => {
    const { el } = mount()
    const stages = [...el.querySelectorAll<HTMLElement>(`.${css.stage!}`)]
    expect(stages).toHaveLength(4)
    expect(stages.map(part => part.style.getPropertyValue('--dsh-stroke-delay')))
      .toEqual(['120ms', '600ms', '1000ms', '1560ms'])
    expect(stages.map(part => part.childElementCount)).toEqual([6, 12, 6, 12])
    for (const edge of stages[0]!.querySelectorAll<HTMLElement>(`.${css.edge!}`)) {
      expect(edge.style.left).toBe('50%')
      expect(edge.style.top).toBe('50%')
      expect(edge.firstElementChild?.classList.contains(css.stroke!)).toBe(true)
    }
  })

  it('types both words after drawing the mark, with each glyph reserving its width', () => {
    const { el } = mount()
    const letters = [...el.querySelectorAll<HTMLElement>(`.${css.letter!}`)]
    expect(letters.map(letter => letter.textContent).join('')).toBe('PORTALHARNESS')
    expect(letters.map(letter => letter.style.getPropertyValue('--dsh-letter-delay')))
      .toEqual(['2400ms', '2510ms', '2620ms', '2730ms', '2840ms', '2950ms',
        '3280ms', '3365ms', '3450ms', '3535ms', '3620ms', '3705ms', '3790ms'])
  })

  it('reveals the finished brand immediately under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { el } = mount()
    expect(el.firstElementChild?.classList.contains(css.static!)).toBe(true)
    expect(el.querySelectorAll(`.${css.static!} .${css.stage!}`)).toHaveLength(4)
    vi.advanceTimersByTime(499)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
  })

  it('withholds the spinner until boot outlasts the brand moment', () => {
    const { el } = mount()
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.textContent).not.toContain('Loading plugins…')
    vi.advanceTimersByTime(3875)
    finishBrand(el)
    vi.advanceTimersByTime(124)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('waits for the rendered brand when startup delays its animation', () => {
    const { el, page } = mount()
    vi.advanceTimersByTime(STATUS_MS)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    finishBrand(el)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    page.dispose()
    vi.advanceTimersByTime(219)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
  })

  it('never shows the spinner when the handoff already started', () => {
    const { el, page } = mount()
    page.dispose()
    vi.advanceTimersByTime(STATUS_MS)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    finishBrand(el)
    vi.advanceTimersByTime(STATUS_MS)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    finishBrand(el)
    vi.advanceTimersByTime(STATUS_MS)
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('holds the brand moment through disposal, then detaches after the leave fade', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.firstElementChild).not.toBeNull()
    vi.advanceTimersByTime(3875)
    finishBrand(el)
    vi.advanceTimersByTime(224)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
    vi.advanceTimersByTime(399)
    expect(el.firstElementChild).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.childNodes).toHaveLength(0)
  })

  it('releases every pending timer once it detaches', () => {
    const { el, page } = mount()
    page.dispose()
    vi.advanceTimersByTime(3875)
    finishBrand(el)
    vi.advanceTimersByTime(700)
    expect(vi.getTimerCount()).toBe(0)
  })
})
