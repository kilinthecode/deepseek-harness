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
const STATUS_MS = 4300
/** Reduced motion shows the brand complete from mount, so the status follows sooner. */
const REDUCED_STATUS_MS = 500
/** Hold used where the host reports no animations (jsdom), then the leave fade. */
const FALLBACK_HOLD_MS = 4095
const LEAVE_MS = 400
const SETTLE_REST_MS = 220
const MAX_SETTLE_MS = 4800

interface Timing { start: number; end: number }

/** Read the plate's inline animation window, in ms from the first animation frame. */
function scheduled(el: HTMLElement): Timing {
  const start = Number.parseFloat(el.style.animationDelay)
  return { start, end: start + Number.parseFloat(el.style.animationDuration) }
}

/** Read a window a page sets as custom properties, which its descendants and pseudo-elements inherit. */
function windowOf(el: HTMLElement, delay: string, duration: string): Timing {
  const start = Number.parseFloat(el.style.getPropertyValue(delay))
  return { start, end: start + Number.parseFloat(el.style.getPropertyValue(duration)) }
}

const strokeWindow = (layer: HTMLElement): Timing => windowOf(layer, '--dsh-stroke-delay', '--dsh-stroke-duration')
const keystroke = (letter: HTMLElement): Timing => windowOf(letter, '--dsh-letter-delay', '--dsh-letter-step')

type Point = readonly [number, number]

/** Convert a PortalMark frame point (160–864) to percent of the 96px mark box, to two decimals. */
function framePoint([x, y]: Point): Point {
  return [Math.round((x - 160) / 7.04 * 100) / 100, Math.round((y - 160) / 7.04 * 100) / 100]
}

/**
 * Recover one laid-out stroke's endpoints and thickness from the fixed
 * position, length, and rotation of its outer element, and the cap the
 * drawn inner element extends past each endpoint. The mark box is square,
 * so left, top, and width percentages share one unit.
 */
function strokeGeometry(edge: HTMLElement): { from: Point; to: Point; width: string; caps: string[] } {
  const left = Number.parseFloat(edge.style.left)
  const top = Number.parseFloat(edge.style.top)
  const length = Number.parseFloat(edge.style.width)
  const angle = Number.parseFloat(/rotate\((.+)rad\)/.exec(edge.style.transform)![1]!)
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    from: [round(left), round(top)],
    to: [round(left + length * Math.cos(angle)), round(top + length * Math.sin(angle))],
    width: edge.style.height,
    caps: [(edge.firstElementChild as HTMLElement).style.marginLeft, (edge.firstElementChild as HTMLElement).style.marginRight],
  }
}

const OUTER: readonly Point[] = [[512, 172], [806.4, 342], [806.4, 682], [512, 852], [217.6, 682], [217.6, 342]]
const INNER: readonly Point[] = [[512, 369.2], [635.6, 440.6], [635.6, 583.4], [512, 654.8], [388.4, 583.4], [388.4, 440.6]]

/** Each side of a closed cell as two halves drawn from its vertices to its midpoint. */
function halves(cell: readonly Point[]): Array<[Point, Point]> {
  return cell.flatMap((vertex, index): Array<[Point, Point]> => {
    const next = cell[(index + 1) % cell.length]!
    const midpoint: Point = [(vertex[0] + next[0]) / 2, (vertex[1] + next[1]) / 2]
    return [[vertex, midpoint], [next, midpoint]]
  })
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
    expect(el.querySelector(`.${css.mark!}`)?.getAttribute('aria-hidden')).toBe('true')
    expect(el.textContent).toContain('PORTAL')
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Portal Harness')
  })

  it('draws the mark from the centre outward, each stroke continuing where the last stage ended', () => {
    const { el } = mount()
    const mark = el.querySelector(`.${css.mark!}`)!
    const layers = [...mark.children] as HTMLElement[]
    expect(layers.every(layer => layer.classList.contains(css.stage!))).toBe(true)
    const geometry = layers.map(layer => [...layer.children].map((edge) => {
      // The outer element holds the fixed placement; only the inner one animates.
      expect(edge.classList.contains(css.edge!)).toBe(true)
      expect(edge.firstElementChild?.classList.contains(css.stroke!)).toBe(true)
      return strokeGeometry(edge as HTMLElement)
    }))
    // Every stroke reaches half its thickness past both endpoints, as SVG
    // round caps do, so the two halves of a side overlap at its midpoint.
    const drawn = (strokes: Array<[Point, Point]>, width: string, cap: string) =>
      strokes.map(([from, to]) => ({ from: framePoint(from), to: framePoint(to), width, caps: [cap, cap] }))
    expect(geometry).toEqual([
      // Spokes from the centre to the inner vertices, the inner cell, the
      // lifts from the inner to the outer vertices, then the outer cell.
      drawn(INNER.map(vertex => [[512, 512], vertex]), '1.9px', '-0.95px'),
      drawn(halves(INNER), '1.9px', '-0.95px'),
      drawn(INNER.map((vertex, index) => [vertex, OUTER[index]!]), '1.9px', '-0.95px'),
      drawn(halves(OUTER), '2.25px', '-1.125px'),
    ])
    // Each stage starts as the one before it finishes.
    expect(layers.map(strokeWindow)).toEqual([
      { start: 120, end: 600 }, { start: 600, end: 1000 }, { start: 1000, end: 1560 }, { start: 1560, end: 2100 },
    ])
  })

  it('types the wordmark, then the nameplate, one glyph per keystroke in the stylesheet', () => {
    const { el } = mount()
    const [word, plate] = [...el.querySelector('[role="img"]')!.lastElementChild!.children] as HTMLElement[]
    const typed = (parent: HTMLElement) => [...parent.children].map(letter => ({
      glyph: letter.textContent,
      letter: letter.classList.contains(css.letter!),
      ...keystroke(letter as HTMLElement),
    }))
    const keystrokes = (text: string, start: number, step: number) => Array.from(text, (glyph, index) => ({
      glyph, letter: true, start: start + index * step, end: start + (index + 1) * step,
    }))
    expect(word?.classList.contains(css.word!)).toBe(true)
    expect(typed(word!)).toEqual(keystrokes('PORTAL', 2400, 110))
    expect(plate?.classList.contains(css.plate!)).toBe(true)
    expect(scheduled(plate!)).toEqual({ start: 3160, end: 3340 })
    expect(typed(plate!)).toEqual(keystrokes('HARNESS', 3280, 85))
    // Only the status reveal waits on a timer; no step of the brand does.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('lands each brand phase before the next begins, then holds the complete lockup', async () => {
    const { el, page } = mount()
    const mark = [...el.querySelectorAll<HTMLElement>(`.${css.stage!}`)].map(strokeWindow)
    const [word, nameplate] = [...el.querySelector('[role="img"]')!.lastElementChild!.children] as HTMLElement[]
    const wordLetters = [...word!.children].map(letter => keystroke(letter as HTMLElement))
    const plateLetters = [...nameplate!.children].map(letter => keystroke(letter as HTMLElement))
    const plate = scheduled(nameplate!)
    const markEnd = Math.max(...mark.map(stage => stage.end))
    // The finished mark holds for a beat before the first keystroke.
    expect(wordLetters[0]!.start).toBeGreaterThan(markEnd)
    // The nameplate arrives after the wordmark's last keystroke and types on itself.
    expect(plate.start).toBeGreaterThanOrEqual(wordLetters.at(-1)!.end)
    expect(plateLetters[0]!.start).toBeGreaterThanOrEqual(plate.start)
    const lockup = Math.max(...[...mark, ...wordLetters, plate, ...plateLetters].map(step => step.end))
    expect(plateLetters.at(-1)!.end).toBe(lockup)
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
