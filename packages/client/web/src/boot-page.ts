/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import stylesheet from './boot-page.module.css'

type BootClass =
  | 'boot' | 'static' | 'leaving' | 'card' | 'brand' | 'mark' | 'stage' | 'edge' | 'stroke' | 'row' | 'word'
  | 'letter' | 'plate' | 'status' | 'spinner' | 'hint' | 'failed' | 'failedTitle' | 'failedItem'

/** Generated class names; the stylesheet beside this module defines every class it reads. */
const css = stylesheet as Readonly<Record<BootClass, string>>

/**
 * Tesseract geometry in the PortalMark 160–864 frame, mirrored here because
 * the boot page mounts before the UI package tree and stays dependency-free.
 */
type Vertex = readonly [number, number]
const FRAME_ORIGIN = 160
const FRAME_SIZE = 704
const CENTER: Vertex = [512, 512]
const OUTER_VERTICES: ReadonlyArray<Vertex> = [
  [512, 172],
  [806.4, 342],
  [806.4, 682],
  [512, 852],
  [217.6, 682],
  [217.6, 342],
]
const INNER_VERTICES: ReadonlyArray<Vertex> = [
  [512, 369.2],
  [635.6, 440.6],
  [635.6, 583.4],
  [512, 654.8],
  [388.4, 583.4],
  [388.4, 440.6],
]
/** Stroke thickness in px; the outer cell is heavier than the lines inside it. */
const STROKE_PX = 1.9
const OUTER_STROKE_PX = 2.25

/** One line drawn from its first endpoint toward its second. */
type Stroke = readonly [from: Vertex, to: Vertex, width: number]

/** Draw each side of a closed cell as two halves meeting at its midpoint. */
function sides(vertices: ReadonlyArray<Vertex>, width: number): Stroke[] {
  return vertices.flatMap((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length] ?? vertex
    const midpoint: Vertex = [(vertex[0] + next[0]) / 2, (vertex[1] + next[1]) / 2]
    return [[vertex, midpoint, width], [next, midpoint, width]] as const
  })
}

/**
 * Brand schedule in ms from the first animation frame. Every step is a CSS
 * animation whose delay and duration are set inline from these values, so
 * the compositor runs the whole sequence and plugin loading on the main
 * thread cannot delay or bunch its steps. The mark draws alone from the
 * centre outward: spokes to the inner cell, the inner cell, lifts to the
 * outer vertices, then the outer cell, finishing at 2100ms.
 */
const STAGES: ReadonlyArray<{ delay: number; duration: number; strokes: readonly Stroke[] }> = [
  { delay: 120, duration: 480, strokes: INNER_VERTICES.map(vertex => [CENTER, vertex, STROKE_PX] as const) },
  { delay: 600, duration: 400, strokes: sides(INNER_VERTICES, STROKE_PX) },
  {
    delay: 1000,
    duration: 560,
    strokes: INNER_VERTICES.map((vertex, index) => [vertex, OUTER_VERTICES[index] ?? vertex, STROKE_PX] as const),
  },
  { delay: 1560, duration: 540, strokes: sides(OUTER_VERTICES, OUTER_STROKE_PX) },
]

/** Startup lettering: both words type one glyph per keystroke in their final positions. */
const WORD = 'PORTAL'
const PLATE = 'HARNESS'
/** The wordmark types after a beat on the finished mark. */
const WORD_START_MS = 2400
const WORD_STEP_MS = 110
/** The nameplate fades in after the wordmark's last keystroke, then its lettering types. */
const PLATE_DELAY_MS = 3160
const PLATE_MS = 180
const PLATE_START_MS = 3280
const PLATE_STEP_MS = 85
/** The nameplate's last keystroke ends at 3875ms, completing the brand sequence. */
const BRAND_END_MS = PLATE_START_MS + PLATE.length * PLATE_STEP_MS
/** Rest between the settled brand and the leave fade. */
const SETTLE_REST_MS = 220
/** Hold from mount used where the host cannot report animation progress. */
const FALLBACK_HOLD_MS = BRAND_END_MS + SETTLE_REST_MS
/** Longest wait for the brand animations to finish once the application is ready. */
const MAX_SETTLE_MS = 4800
/** Leave fade, matching the `.leaving` transition in the stylesheet. */
const LEAVE_MS = 400
/**
 * Delay after which a boot still running earns the progress spinner and hint.
 * It trails the brand sequence far enough that a late first frame still
 * finishes the typing before the status appears.
 */
const STATUS_MS = 4300
/**
 * Status delay under reduced motion, where the brand is complete from mount:
 * a slow boot reports progress promptly, and a fast one still shows no spinner.
 */
const REDUCED_STATUS_MS = 500

/** Whether the host exposes a reduced-motion preference (jsdom does not). */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Create a div with one module class and optional text. */
function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Convert one PortalMark frame coordinate or length to a percentage of the mark box. */
function percent(value: number): string {
  return `${String(value / FRAME_SIZE * 100)}%`
}

/**
 * Lay out one stroke at its fixed position, rotation, and thickness. The
 * outer element never moves; the inner element grows from the first endpoint
 * along that axis on `transform` alone, so the drawing composites while
 * plugins load on the main thread. The inner element reaches half its
 * thickness past both endpoints, as the mark's SVG round line caps do, so two
 * halves meeting mid-side overlap instead of pinching to a gap.
 */
function strokeElement([from, to, width]: Stroke): HTMLDivElement {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const edge = div(css.edge)
  edge.style.left = percent(from[0] - FRAME_ORIGIN)
  edge.style.top = percent(from[1] - FRAME_ORIGIN)
  edge.style.width = percent(Math.hypot(dx, dy))
  edge.style.height = `${String(width)}px`
  edge.style.marginTop = `${String(-width / 2)}px`
  edge.style.transform = `rotate(${String(Math.atan2(dy, dx))}rad)`
  const line = div(css.stroke)
  line.style.marginLeft = `${String(-width / 2)}px`
  line.style.marginRight = `${String(-width / 2)}px`
  edge.append(line)
  return edge
}

/**
 * Lay out one word whose glyphs appear one keystroke at a time. Hidden glyphs
 * keep their width, so the row never reflows. Each keystroke window is set as
 * custom properties because the caret that follows the glyph is its `::after`
 * pseudo-element, which inline styles cannot reach.
 */
function typedWord(className: string, text: string, start: number, step: number): HTMLDivElement {
  const word = div(className)
  for (const [index, glyph] of Array.from(text).entries()) {
    const letter = document.createElement('span')
    letter.className = css.letter
    letter.textContent = glyph
    letter.style.setProperty('--dsh-letter-delay', `${String(start + index * step)}ms`)
    letter.style.setProperty('--dsh-letter-step', `${String(step)}ms`)
    word.append(letter)
  }
  return word
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly brand: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private total = 0
  private failure: string | undefined
  /** Whether the progress spinner and hint belong in the card yet. */
  private statusShown = false
  /** Whether the hold-and-fade handoff has started. */
  private leaving = false
  /** Whether the page left the document and released its timers. */
  private detached = false
  private readonly reduced = prefersReducedMotion()
  private readonly mountedAt = Date.now()

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    if (this.reduced) this.root.classList.add(css.static)
    this.card = div(css.card)
    this.brand = this.buildBrand()
    this.status = div(css.status)
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.status.append(this.spinner, this.hint)
    this.card.append(this.brand)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
    // A boot that outlasts the brand moment owes the reader progress; one that
    // finishes inside it never shows a spinner at all.
    this.timers.push(setTimeout(() => { this.revealStatus() }, this.reduced ? REDUCED_STATUS_MS : STATUS_MS))
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /**
   * Hand the mount point to the UI renderer. The page stays on top until every
   * brand animation has finished, rests briefly, then dissolves to reveal the
   * ready application. Reduced motion detaches at once.
   */
  leave(): void {
    if (this.leaving) return
    this.leaving = true
    if (this.reduced) {
      this.detach()
      return
    }
    void this.settled().then(() => {
      if (!this.detached) this.root.classList.add(css.leaving)
      return this.wait(LEAVE_MS)
    }).then(() => { this.detach() })
  }

  /** Remove the page at once, cutting short a handoff in progress, and release every timer. */
  dispose(): void {
    this.detach()
  }

  /**
   * Resolve once the brand sequence has played out. Hosts that report
   * animations wait for the finite brand animations to finish, bounded by
   * {@link MAX_SETTLE_MS} for throttled background documents; others hold
   * until {@link FALLBACK_HOLD_MS} after mount.
   */
  private async settled(): Promise<void> {
    if (typeof this.brand.getAnimations !== 'function') {
      await this.wait(Math.max(0, this.mountedAt + FALLBACK_HOLD_MS - Date.now()))
      return
    }
    const finishing = this.brand.getAnimations({ subtree: true })
      .map(animation => animation.finished.then(() => undefined, (_cancelled: unknown) => {
        // A cancelled animation has stopped moving, which is all the hold waits for.
      }))
    await Promise.race([Promise.all(finishing), this.wait(MAX_SETTLE_MS)])
    await this.wait(SETTLE_REST_MS)
  }

  /**
   * Resolve after `ms`, registering the timer so detaching can release it.
   * A detached page schedules nothing and resolves at once, so a handoff cut
   * short by {@link dispose} ends without touching the document again.
   */
  private wait(ms: number): Promise<void> {
    if (this.detached) return Promise.resolve()
    return new Promise((resolve) => { this.timers.push(setTimeout(resolve, ms)) })
  }

  /** Remove the page and release every pending timer. */
  private detach(): void {
    if (this.detached) return
    this.detached = true
    this.root.remove()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.length = 0
  }

  /** Build the tesseract mark, the typed wordmark, and the nameplate beside it. */
  private buildBrand(): HTMLDivElement {
    const brand = div(css.brand)
    // The lettering is brand artwork drawn glyph by glyph, so the row carries
    // one name rather than letting a reader spell it out.
    brand.setAttribute('role', 'img')
    brand.setAttribute('aria-label', 'Portal Harness')
    brand.append(this.buildMark())
    const row = div(css.row)
    const plate = typedWord(css.plate, PLATE, PLATE_START_MS, PLATE_STEP_MS)
    plate.style.animationDelay = `${String(PLATE_DELAY_MS)}ms`
    plate.style.animationDuration = `${String(PLATE_MS)}ms`
    row.append(typedWord(css.word, WORD, WORD_START_MS, WORD_STEP_MS), plate)
    brand.append(row)
    return brand
  }

  /** Build the mark as one layer per drawing stage over the same 96px box. */
  private buildMark(): HTMLDivElement {
    const mark = div(css.mark)
    mark.setAttribute('aria-hidden', 'true')
    for (const { delay, duration, strokes } of STAGES) {
      const layer = div(css.stage)
      layer.style.setProperty('--dsh-stroke-delay', `${String(delay)}ms`)
      layer.style.setProperty('--dsh-stroke-duration', `${String(duration)}ms`)
      layer.append(...strokes.map(strokeElement))
      mark.append(layer)
    }
    return mark
  }

  /** Admit the progress spinner and hint, unless the handoff already started. */
  private revealStatus(): void {
    if (this.leaving || this.statusShown) return
    this.statusShown = true
    this.render()
  }

  /** Redraw the state-dependent content below the brand. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      this.showBelowBrand(this.statusShown ? this.status : undefined)
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.showBelowBrand(report)
  }

  /**
   * Make `content` the card's only element after the brand. The brand node
   * never leaves the card: re-attaching it would restart every animation in
   * it, replaying a finished brand and holding {@link settled} for the replay.
   * @param content - Status block or failure report, or `undefined` for the brand alone.
   */
  private showBelowBrand(content: HTMLDivElement | undefined): void {
    // The brand always leads, so the trailing element is the current content.
    const trailing = this.card.lastElementChild
    if (trailing === content) return
    if (trailing !== this.brand) trailing?.remove()
    if (content !== undefined) this.card.append(content)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
