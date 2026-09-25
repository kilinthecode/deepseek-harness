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
const STATUS_MS = 3400
/** Reduced motion shows the brand complete from mount, so the status follows sooner. */
const REDUCED_STATUS_MS = 500
/** Hold used where the host reports no animations (jsdom), then the leave fade. */
const FALLBACK_HOLD_MS = 3340
const LEAVE_MS = 560
const SETTLE_REST_MS = 360
const MAX_SETTLE_MS = 4800

/** Read an element's inline animation window, in ms from the first animation frame. */
function scheduled(el: HTMLElement | SVGElement): { start: number; end: number } {
  const start = Number.parseFloat(el.style.animationDelay)
  return { start, end: start + Number.parseFloat(el.style.animationDuration) }
}

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

/**
 * Watch the card's children. A browser restarts every animation in a node
 * that leaves the document, even when the same node is appended again, so
 * `removed()` lists each node the card has lost, including re-attached ones.
 */
function watchCard(el: HTMLElement) {
  const brand = el.querySelector<HTMLElement>('[role="img"]')!
  const card = brand.parentElement!
  const lost: Node[] = []
  const collect = (records: MutationRecord[]) => { for (const record of records) lost.push(...record.removedNodes) }
  const observer = new MutationObserver(collect)
  observer.observe(card, { childList: true })
  return {
    brand,
    children: () => [...card.children],
    removed: () => {
      collect(observer.takeRecords())
      return lost
    },
  }
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

  it('opens the mark as three stacked stage layers, the outer one settling onto the spokes', () => {
    const { el } = mount()
    const mark = el.querySelector(`.${css.mark!}`)!
    const stages = [...mark.children] as SVGElement[]
    // Each stage is an outer <svg>, the element Chromium can composite.
    expect(stages.map(stage => stage.tagName)).toEqual(['svg', 'svg', 'svg'])
    expect(stages.every(stage => stage.classList.contains(css.stage!))).toBe(true)
    expect(stages.map(stage => stage.getAttribute('viewBox'))).toEqual(Array(3).fill('160 160 704 704'))
    // Spokes, the inner cell, then the six lifts with the outer cell they join.
    const sixLines = Array<string>(6).fill('line')
    expect(stages.map(stage => [...stage.children].map(part => part.tagName)))
      .toEqual([sixLines, ['polygon'], [...sixLines, 'polygon']])
    expect(stages.map(scheduled)).toEqual([
      { start: 240, end: 960 }, { start: 420, end: 1140 }, { start: 600, end: 1320 },
    ])
    // The outer cell's corners are the spoke tips, so it settles inward onto
    // them; the spokes and inner cell open outward from the centre.
    expect(stages.map(stage => stage.classList.contains(css.stageSettle!))).toEqual([false, false, true])
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
      .toEqual(['1460ms', '1580ms', '1700ms', '1820ms', '1940ms', '2060ms'])
    expect(letters.every(letter => letter.style.animationDuration === '420ms')).toBe(true)
    // The caret lasts until the last letter is in place.
    expect(scheduled(el.querySelector<HTMLElement>(`.${css.caret!}`)!)).toEqual({ start: 1160, end: 2480 })
    expect(scheduled(el.querySelector<HTMLElement>(`.${css.plate!}`)!)).toEqual({ start: 2420, end: 2980 })
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
    // Each hop starts as its letter appears: P at 1460ms, 300ms after the caret.
    expect(options).toEqual({ delay: 1160, duration: 960, fill: 'both' })
    expect(frames[1]?.offset).toBeCloseTo(300 / 960)
    expect(frames[2]?.offset).toBeCloseTo(360 / 960)
    expect(frames.at(-1)?.offset).toBeCloseTo(1)
  })

  it('lands each brand phase before the next begins, then holds the complete lockup', async () => {
    const { el, page } = mount()
    const stages = [...el.querySelectorAll<SVGElement>(`.${css.stage!}`)].map(scheduled)
    const letters = [...el.querySelectorAll<HTMLElement>(`.${css.letter!}`)].map(scheduled)
    const caret = scheduled(el.querySelector<HTMLElement>(`.${css.caret!}`)!)
    const plate = scheduled(el.querySelector<HTMLElement>(`.${css.plate!}`)!)
    const first = letters[0]!
    const last = letters.at(-1)!
    // Typing starts only after the last mark stage has finished its reveal.
    expect(first.start).toBeGreaterThanOrEqual(Math.max(...stages.map(stage => stage.end)))
    // The nameplate follows the last letter no sooner than another letter
    // would, and it settles last.
    expect(plate.start).toBeGreaterThanOrEqual(last.start + letters[1]!.start - first.start)
    const lockup = Math.max(...[...stages, ...letters, caret, plate].map(step => step.end))
    expect(plate.end).toBe(lockup)
    // The progress status never interrupts the sequence.
    await vi.advanceTimersByTimeAsync(lockup)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    // The complete lockup holds for the rest before the page starts to leave.
    page.leave()
    await vi.advanceTimersByTimeAsync(SETTLE_REST_MS - 1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(el.firstElementChild?.classList.contains(css.leaving!)).toBe(true)
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

  it('admits the spinner sooner under reduced motion, where the brand is complete from mount', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { el } = mount()
    vi.advanceTimersByTime(REDUCED_STATUS_MS - 1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('adds the status after the brand without re-attaching the brand', () => {
    const { el } = mount()
    const card = watchCard(el)
    vi.advanceTimersByTime(STATUS_MS)
    const [first, status, ...rest] = card.children()
    expect(first).toBe(card.brand)
    expect(status?.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    expect(rest).toHaveLength(0)
    expect(card.removed()).toHaveLength(0)
  })

  it('shows a failure report after the brand without re-attaching the brand', () => {
    const { el, page } = mount()
    const card = watchCard(el)
    page.fail('web boot: 1 entry did not activate')
    const [first, report, ...rest] = card.children()
    expect(first).toBe(card.brand)
    expect(report?.textContent).toContain('Failed to load plugins')
    expect(rest).toHaveLength(0)
    expect(card.removed()).toHaveLength(0)
  })

  it('replaces the status, then each earlier report, with the latest report after the brand', () => {
    const { el, page } = mount()
    const card = watchCard(el)
    vi.advanceTimersByTime(STATUS_MS)
    const status = card.children()[1]
    page.setState('a', 'failed')
    const entryReport = card.children()[1]
    page.fail('web boot: 1 entry did not activate')
    const [first, report, ...rest] = card.children()
    expect(first).toBe(card.brand)
    expect(report?.textContent).toContain('web boot: 1 entry did not activate')
    expect(rest).toHaveLength(0)
    const removed = card.removed()
    expect(removed).toHaveLength(2)
    expect(removed[0]).toBe(status)
    expect(removed[1]).toBe(entryReport)
  })

  it('drops the report once no entry has failed, keeping the brand in place', () => {
    const { el, page } = mount()
    const card = watchCard(el)
    page.setState('a', 'failed')
    const report = card.children()[1]
    page.setState('a', 'active')
    expect(card.children()).toHaveLength(1)
    expect(card.children()[0]).toBe(card.brand)
    const removed = card.removed()
    expect(removed).toHaveLength(1)
    expect(removed[0]).toBe(report)
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
