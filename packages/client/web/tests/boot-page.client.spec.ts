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

/** The status block only joins the card once boot outlasts the brand moment. */
const STATUS_MS = 1500

describe('BootPage', () => {
  it('draws the brand before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(el.textContent).toContain('PORTAL')
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Portal Harness')
  })

  it('reveals the mark as four staged groups from the centre outward', () => {
    const { el } = mount()
    const stages = [...el.querySelectorAll(`svg .${css.stage!}`)]
    expect(stages).toHaveLength(4)
    expect(stages.map(part => (part as SVGElement).style.animationDelay))
      .toEqual(['40ms', '200ms', '300ms', '380ms'])
    // Stage translucency rides on stroke-opacity, which the reveal keyframe's
    // own opacity would otherwise overwrite.
    expect(stages.some(part => part.getAttribute('opacity') !== null)).toBe(false)
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('types the wordmark, then trades the caret for the nameplate', () => {
    const { el } = mount()
    const spans = [...el.querySelectorAll('span')]
    const word = spans.filter(span => span.textContent !== '')
    const caret = spans.at(-1)!
    const plate = el.querySelector(`.${css.plate!}`)!
    expect(word).toHaveLength(6)
    for (const span of word) expect(span.className).not.toContain(css.in)

    vi.advanceTimersByTime(360)
    expect(caret.className).toContain(css.caretOn)
    vi.advanceTimersByTime(70)
    expect(word[0]!.className).toContain(css.in)
    expect(word[1]!.className).not.toContain(css.in)
    vi.advanceTimersByTime(5 * 55)
    for (const span of word) expect(span.className).toContain(css.in)
    expect(plate.className).not.toContain(css.in)

    vi.advanceTimersByTime(195)
    expect(caret.className).toContain(css.caretDone)
    expect(caret.className).not.toContain(css.caretOn)
    expect(plate.className).toContain(css.in)
  })

  it('reveals the finished brand immediately under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { el } = mount()
    expect(el.firstElementChild?.classList.contains(css.static!)).toBe(true)
    expect(el.querySelectorAll(`.${css.static!} svg .${css.stage!}`)).toHaveLength(4)
    // No lettering is scheduled, so the finished state comes from the stylesheet.
    vi.advanceTimersByTime(STATUS_MS)
    expect(el.querySelector(`.${css.letter!}.${css.in!}`)).toBeNull()
  })

  it('withholds the spinner until boot outlasts the brand moment', () => {
    const { el } = mount()
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.textContent).not.toContain('Loading plugins…')
    vi.advanceTimersByTime(STATUS_MS)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
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
    vi.advanceTimersByTime(1349)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
    vi.advanceTimersByTime(319)
    expect(el.firstElementChild).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.childNodes).toHaveLength(0)
  })

  it('releases every pending timer once it detaches', () => {
    const { page } = mount()
    page.dispose()
    vi.advanceTimersByTime(1350 + 320)
    expect(vi.getTimerCount()).toBe(0)
  })
})
