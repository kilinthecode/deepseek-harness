/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

const SVG_NS = 'http://www.w3.org/2000/svg' as const

/** Look up one generated class name; every class this module reads is defined in the stylesheet beside it. */
function klass(name: string): string {
  return css[name] ?? ''
}

/**
 * Tesseract geometry in the PortalMark 160–864 frame, mirrored here because
 * the boot page mounts before the UI package tree and stays dependency-free.
 */
const CENTER = 512
const OUTER_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [512, 172],
  [806.4, 342],
  [806.4, 682],
  [512, 852],
  [217.6, 682],
  [217.6, 342],
]
const INNER_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [512, 369.2],
  [635.6, 440.6],
  [635.6, 583.4],
  [512, 654.8],
  [388.4, 583.4],
  [388.4, 440.6],
]
const LIFT_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
  [512, 172, 512, 369.2],
  [806.4, 342, 635.6, 440.6],
  [806.4, 682, 635.6, 583.4],
  [512, 852, 512, 654.8],
  [217.6, 682, 388.4, 583.4],
  [217.6, 342, 388.4, 440.6],
]

/** Startup lettering: the typed wordmark and the nameplate that lands beside it. */
const WORD = 'PORTAL'
const PLATE = 'HARNESS'

/**
 * Brand schedule in ms from the first animation frame. Every step is a CSS
 * animation with an inline delay, so the compositor runs the whole sequence
 * and plugin loading on the main thread cannot delay or bunch its steps.
 * The lead-in keeps the first frames still while the document finishes its
 * first paint; the four mark stages then open outward from the centre
 * (spokes, inner cell, lifts, outer cell).
 */
const STAGE_DELAY_MS = [240, 350, 460, 570] as const
/** Caret visible while the word types, fading out as the nameplate lands. */
const CARET_DELAY_MS = 980
const LETTER_DELAY_MS = 1060
const LETTER_STEP_MS = 85
/** Time the caret takes to hop past a letter as that letter appears. */
const CARET_HOP_MS = 60
/** Easing shared with every arrival in the stylesheet (`--dsh-boot-ease-out`). */
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const PLATE_DELAY_MS = 1900
/**
 * Hold used where the host cannot report animation progress: the plate
 * settles at ~2340ms, followed by a short rest before the handoff.
 */
const FALLBACK_HOLD_MS = 2600
/** Rest between the settled brand and the leave fade. */
const SETTLE_REST_MS = 260
/** Longest wait for the brand animations to finish once the application is ready. */
const MAX_SETTLE_MS = 4000
/** Leave fade, matching the dispose transition in the stylesheet. */
const LEAVE_MS = 480
/** Delay after which a boot still running earns the progress spinner and hint. */
const STATUS_MS = 2800

/** Whether the host exposes a reduced-motion preference (jsdom does not). */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Create an SVG element with the given attributes. */
function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value))
  return el
}

/**
 * Create one mark stage as its own `<svg>` layer. Chromium composites
 * opacity and transform animations on an outer `<svg>` element but runs them
 * on the main thread for shapes inside one, so each stage is a separate
 * layer over the same viewBox.
 * @param delay - Reveal start in ms from the first animation frame.
 * @param parts - Stroked shapes drawn by this stage.
 * @returns the stage layer, hidden until its delay passes.
 */
function stage(delay: number, parts: readonly SVGElement[]): SVGSVGElement {
  const layer = svgElement('svg', {
    viewBox: '160 160 704 704',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })
  layer.setAttribute('class', klass('stage'))
  layer.style.animationDelay = `${String(delay)}ms`
  layer.append(...parts)
  return layer
}

/** Render one polygon's vertices as an SVG `points` list. */
function points(vertices: ReadonlyArray<readonly [number, number]>): string {
  return vertices.map(([x, y]) => `${String(x)},${String(y)}`).join(' ')
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
    if (this.reduced) this.root.classList.add(klass('static'))
    this.card = div(css.card)
    const { brand, letters, caret } = this.buildBrand()
    this.brand = brand
    this.status = div(css.status)
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.status.append(this.spinner, this.hint)
    this.card.append(this.brand)
    this.root.append(this.card)
    container.append(this.root)
    if (!this.reduced) this.followTyping(letters, caret)
    this.updateProgress()
    // A boot that outlasts the brand moment owes the reader progress; one that
    // finishes inside it never shows a spinner at all.
    this.timers.push(setTimeout(() => { this.revealStatus() }, STATUS_MS))
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
      if (!this.detached) this.root.classList.add(klass('leaving'))
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
  private buildBrand(): { brand: HTMLDivElement; letters: HTMLSpanElement[]; caret: HTMLSpanElement } {
    const brand = div(css.brand)
    // The lettering is brand artwork drawn glyph by glyph, so the row carries
    // one name rather than letting a reader spell it out.
    brand.setAttribute('role', 'img')
    brand.setAttribute('aria-label', 'Portal Harness')
    brand.append(this.buildMark())
    const row = div(css.row)
    const word = div(css.word)
    const letters = Array.from(WORD, (letter, i) => {
      const span = document.createElement('span')
      span.className = klass('letter')
      span.textContent = letter
      span.style.animationDelay = `${String(LETTER_DELAY_MS + i * LETTER_STEP_MS)}ms`
      return span
    })
    const caret = document.createElement('span')
    caret.className = klass('caret')
    caret.style.animationDelay = `${String(CARET_DELAY_MS)}ms`
    word.append(...letters, caret)
    const plate = div(css.plate, PLATE)
    plate.style.animationDelay = `${String(PLATE_DELAY_MS)}ms`
    row.append(word, plate)
    brand.append(row)
    return { brand, letters, caret }
  }

  /**
   * Carry the caret along the typing: it waits before the first letter, then
   * hops past each letter as that letter appears, ending in its laid-out place
   * after the word. The hops animate `transform` alone, so they composite like
   * the rest of the brand. Positions are measured once from the laid-out row;
   * letters hold their space while hidden, so the measurements stay valid.
   * Hosts without Web Animations leave the caret in its laid-out place.
   * @param letters - Wordmark letters in typing order.
   * @param caret - Caret laid out after the last letter.
   */
  private followTyping(letters: readonly HTMLSpanElement[], caret: HTMLSpanElement): void {
    const first = letters[0]
    const last = letters.at(-1)
    if (typeof caret.animate !== 'function' || first === undefined || last === undefined) return
    const home = caret.getBoundingClientRect()
    // The caret sits `gap` past a letter's box, as it does after the last one.
    const gap = home.left - last.getBoundingClientRect().right
    const shift = (x: number): string => `translateX(${String(x - home.left)}px)`
    const duration = LETTER_DELAY_MS + (letters.length - 1) * LETTER_STEP_MS + CARET_HOP_MS - CARET_DELAY_MS
    const at = (ms: number): number => (ms - CARET_DELAY_MS) / duration
    let from = shift(first.getBoundingClientRect().left - gap - home.width)
    const keyframes: Keyframe[] = [{ offset: 0, transform: from }]
    for (const [i, letter] of letters.entries()) {
      const appears = LETTER_DELAY_MS + i * LETTER_STEP_MS
      const to = shift(letter.getBoundingClientRect().right + gap)
      keyframes.push(
        { offset: at(appears), transform: from, easing: EASE_OUT },
        { offset: at(appears + CARET_HOP_MS), transform: to },
      )
      from = to
    }
    caret.animate(keyframes, { delay: CARET_DELAY_MS, duration, fill: 'both' })
  }

  /** Build the mark as four stacked stage layers revealed from the centre outward. */
  private buildMark(): HTMLDivElement {
    const mark = div(css.mark)
    mark.setAttribute('aria-hidden', 'true')
    const spokes = OUTER_VERTICES.map(([x, y]) => svgElement('line', {
      // One ray per outer vertex; the inner cell's spokes lie along these.
      x1: CENTER, y1: CENTER, x2: x, y2: y,
      'stroke-width': 1.9,
      'stroke-opacity': 0.9,
      'vector-effect': 'non-scaling-stroke',
    }))
    const inner = svgElement('polygon', {
      points: points(INNER_VERTICES),
      'stroke-width': 1.9,
      'stroke-opacity': 0.9,
      'vector-effect': 'non-scaling-stroke',
    })
    const lifts = LIFT_EDGES.map(([x1, y1, x2, y2]) => svgElement('line', {
      x1, y1, x2, y2,
      'stroke-width': 1.5,
      'stroke-opacity': 0.7,
      'vector-effect': 'non-scaling-stroke',
    }))
    const outer = svgElement('polygon', {
      points: points(OUTER_VERTICES),
      'stroke-width': 2.25,
      'vector-effect': 'non-scaling-stroke',
    })
    mark.append(
      stage(STAGE_DELAY_MS[0], spokes),
      stage(STAGE_DELAY_MS[1], [inner]),
      stage(STAGE_DELAY_MS[2], lifts),
      stage(STAGE_DELAY_MS[3], [outer]),
    )
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
      const wanted = this.statusShown ? [this.brand, this.status] : [this.brand]
      // The brand always leads, so the trailing element identifies the content.
      if (this.card.childElementCount !== wanted.length || this.card.lastElementChild !== wanted.at(-1)) {
        this.card.replaceChildren(...wanted)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.brand, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
