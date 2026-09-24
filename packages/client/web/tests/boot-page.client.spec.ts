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
const STATUS_MS = 2800
/** Hold used where the host reports no animations (jsdom), then the leave fade. */
const FALLBACK_HOLD_MS = 2600
const LEAVE_MS = 480
const SETTLE_REST_MS = 260
const MAX_SETTLE_MS = 4000

/** Report one controllable brand animation, as a host with Web Animations would. */
function stubBrandAnimation(el: HTMLElement) {
  let finish!: () => void
  let cancel!: () => void
  const animation: Pick<Animation, 'finished'> = {
    finished: new Promise<Animation>((resolve, reject) => {
      finish = () => { resolve(animation as Animation) }
      cancel = () => { reject(new DOMException('cancelled', 'AbortError')) }
    }),
  }
  const brand = el.querySelector<HTMLElement>('[role="img"]')!
  brand.getAnimations = () => [animation as Animation]
  return { finish, cancel }
}

describe('BootPage', () => {
  it('draws the brand before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(el.textContent).toContain('PORTAL')
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Portal Harness')
  })

  it('opens the mark as four stacked stage layers from the centre outward', () => {
    const { el } = mount()
    const mark = el.querySelector(`.${css.mark!}`)!
    const stages = [...mark.children]
    // Each stage is an outer <svg>, the element Chromium can composite.
    expect(stages.map(stage => stage.tagName)).toEqual(['svg', 'svg', 'svg', 'svg'])
    expect(stages.every(stage => stage.classList.contains(css.stage!))).toBe(true)
    expect(stages.map(stage => stage.getAttribute('viewBox'))).toEqual(Array(4).fill('160 160 704 704'))
    expect(stages.map(stage => (stage as SVGElement).style.animationDelay))
      .toEqual(['240ms', '350ms', '460ms', '570ms'])
    // Stage translucency rides on stroke-opacity, which the reveal keyframe's
    // own opacity would otherwise overwrite.
    expect(stages.some(stage => stage.getAttribute('opacity') !== null)).toBe(false)
    expect(mark.getAttribute('aria-hidden')).toBe('true')
  })

  it('schedules the lettering in the stylesheet rather than on main-thread timers', () => {
    const { el } = mount()
    const letters = [...el.querySelectorAll<HTMLElement>(`.${css.letter!}`)]
    expect(letters.map(letter => letter.textContent).join('')).toBe('PORTAL')
    expect(letters.map(letter => letter.style.animationDelay))
      .toEqual(['1060ms', '1145ms', '1230ms', '1315ms', '1400ms', '1485ms'])
    expect(el.querySelector<HTMLElement>(`.${css.caret!}`)?.style.animationDelay).toBe('980ms')
    expect(el.querySelector<HTMLElement>(`.${css.plate!}`)?.style.animationDelay).toBe('1900ms')
    // Only the status reveal waits on a timer; no step of the brand does.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('carries the caret from before the first letter past each letter as it appears', () => {
    // Lay the row out as a browser would: letter i spans [10i, 10i + 8], and
    // the 2px caret sits 4px past the last letter.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
      const caret = this.classList.contains(css.caret!)
      const left = caret ? 62 : 10 * [...this.parentElement?.children ?? []].indexOf(this)
      const width = caret ? 2 : 8
      return { x: left, y: 0, left, top: 0, width, height: 14, right: left + width, bottom: 14, toJSON: () => ({}) }
    })
    const animate = vi.fn<HTMLElement['animate']>()
    HTMLElement.prototype.animate = animate
    try {
      mount()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate')
      vi.restoreAllMocks()
    }
    expect(animate).toHaveBeenCalledOnce()
    const [keyframes, options] = animate.mock.calls[0]!
    const frames = keyframes as Keyframe[]
    // Waits before P (0 - 4 - 2 = -6px, relative to its 62px home), then lands
    // 4px past each letter, ending at home.
    expect([...new Set(frames.map(frame => frame.transform))]).toEqual([
      'translateX(-68px)', 'translateX(-50px)', 'translateX(-40px)', 'translateX(-30px)',
      'translateX(-20px)', 'translateX(-10px)', 'translateX(0px)',
    ])
    // Each hop starts as its letter appears: P at 1060ms, 80ms after the caret.
    expect(options).toEqual({ delay: 980, duration: 565, fill: 'both' })
    expect(frames[1]?.offset).toBeCloseTo(80 / 565)
    expect(frames[2]?.offset).toBeCloseTo(140 / 565)
    expect(frames.at(-1)?.offset).toBeCloseTo(1)
  })

  it('shows the finished brand and detaches at once under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { el, page } = mount()
    expect(el.firstElementChild?.classList.contains(css.static!)).toBe(true)
    page.leave()
    expect(el.childNodes).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('withholds the spinner until boot outlasts the brand moment', () => {
    const { el } = mount()
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.textContent).not.toContain('Loading plugins…')
    vi.advanceTimersByTime(STATUS_MS - 1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('never shows the spinner when the handoff already started', () => {
    const { el, page } = mount()
    page.leave()
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

  it('holds the brand moment through disposal, then detaches after the leave fade', async () => {
    const { el, page } = mount()
    page.leave()
    await vi.advanceTimersByTimeAsync(FALLBACK_HOLD_MS - 1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
    await vi.advanceTimersByTimeAsync(LEAVE_MS - 1)
    expect(el.firstElementChild).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(el.childNodes).toHaveLength(0)
  })

  it('waits for the brand animations to finish before it starts to leave', async () => {
    const { el, page } = mount()
    const brand = stubBrandAnimation(el)
    page.leave()
    // Well past the fixed hold: an unfinished sequence keeps the page up.
    await vi.advanceTimersByTimeAsync(FALLBACK_HOLD_MS + LEAVE_MS)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    brand.finish()
    await vi.advanceTimersByTimeAsync(SETTLE_REST_MS - 1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
    await vi.advanceTimersByTimeAsync(LEAVE_MS)
    expect(el.childNodes).toHaveLength(0)
  })

  it('treats a cancelled brand animation as settled', async () => {
    const { el, page } = mount()
    stubBrandAnimation(el).cancel()
    page.leave()
    await vi.advanceTimersByTimeAsync(SETTLE_REST_MS)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
  })

  it('leaves after the settle limit when the brand animations never finish', async () => {
    const { el, page } = mount()
    stubBrandAnimation(el)
    page.leave()
    await vi.advanceTimersByTimeAsync(MAX_SETTLE_MS + SETTLE_REST_MS - 1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
    await vi.advanceTimersByTimeAsync(LEAVE_MS)
    expect(el.childNodes).toHaveLength(0)
  })

  it('removes the page at once when disposed during the handoff', async () => {
    const { el, page } = mount()
    const root = el.firstElementChild!
    const brand = stubBrandAnimation(el)
    page.leave()
    await vi.advanceTimersByTimeAsync(1000)
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    // The interrupted hold schedules nothing and never fades the removed page.
    brand.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(MAX_SETTLE_MS + SETTLE_REST_MS + LEAVE_MS)
    expect(root.classList.contains(css.leaving!)).toBe(false)
    page.leave()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases every pending timer once it detaches', async () => {
    const { el, page } = mount()
    stubBrandAnimation(el).finish()
    page.leave()
    await vi.advanceTimersByTimeAsync(SETTLE_REST_MS + LEAVE_MS)
    expect(el.childNodes).toHaveLength(0)
    // The unused settle-limit and status timers go with the page.
    expect(vi.getTimerCount()).toBe(0)
  })
})
