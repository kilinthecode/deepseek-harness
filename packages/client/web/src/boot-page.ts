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
 * Mark reveal schedule in ms from mount. The four stages bloom outward from
 * the mark's center — spokes, inner cell, lifts, outer cell — and each one
 * animates opacity and transform alone, so the sequence keeps its frame rate
 * while the plugin roster loads on the same main thread.
 */
const STAGE_MS = 340
const STAGE_DELAY_MS = { spokes: 40, inner: 200, lifts: 300, outer: 380 } as const

/** Lettering schedule in ms from mount; the caret leaves as the nameplate lands. */
const CARET_ON_MS = 360
const LETTER_START_MS = 430
const LETTER_STEP_MS = 55
const CARET_OFF_MS = 900
const PLATE_MS = 900

/** Delay after which a boot still running earns the progress spinner and hint. */
const STATUS_MS = 1500
/**
 * Shortest brand moment held before the handoff, covering a sequence that
 * settles at ~1.16s: the mark completes at ~720ms, the word at ~965ms, and the
 * nameplate at ~1160ms.
 */
const MIN_HOLD_MS = 1350
/** Leave fade, matching the dispose transition in the stylesheet. */
const LEAVE_MS = 320

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
 * Create one mark stage that scales up from the mark's center as it fades in.
 * Stage translucency rides on `stroke-opacity`, which the reveal keyframe's
 * `opacity` does not overwrite.
 * @param delay - Reveal start in ms from page mount.
 * @returns the element, hidden until its delay passes.
 */
function stage<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  delay: number,
): SVGElementTagNameMap[K] {
  const el = svgElement(tag, attributes)
  el.setAttribute('class', klass('stage'))
  el.style.animationDelay = `${String(delay)}ms`
  el.style.animationDuration = `${String(STAGE_MS)}ms`
  return el
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
  private readonly letters: HTMLSpanElement[] = []
  private caret!: HTMLSpanElement
  private plate!: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private total = 0
  private failure: string | undefined
  /** Whether the progress spinner and hint belong in the card yet. */
  private statusShown = false
  private disposed = false
  private readonly reduced = prefersReducedMotion()
  private readonly mountedAt = Date.now()

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    const reduced = this.reduced
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    if (reduced) this.root.classList.add(klass('static'))
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
    if (!reduced) this.scheduleLettering()
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
   * Detach the page once the UI renderer takes the mount point. The page stays
   * on top while the brand moment finishes, then dissolves to reveal the ready
   * application; the lettering timers keep running through the hold.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const remaining = this.reduced ? 0 : Math.max(0, this.mountedAt + MIN_HOLD_MS - Date.now())
    this.timers.push(setTimeout(() => {
      this.root.classList.add(klass('leaving'))
      this.timers.push(setTimeout(() => {
        this.root.remove()
        this.clearTimers()
      }, this.reduced ? 0 : LEAVE_MS))
    }, remaining))
  }

  /** Release every pending timer once the page is detached. */
  private clearTimers(): void {
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
    const word = div(css.word)
    for (const letter of WORD) {
      const span = document.createElement('span')
      span.className = klass('letter')
      span.textContent = letter
      this.letters.push(span)
      word.append(span)
    }
    this.caret = document.createElement('span')
    this.caret.className = klass('caret')
    word.append(this.caret)
    this.plate = div(css.plate, PLATE)
    row.append(word, this.plate)
    brand.append(row)
    return brand
  }

  /** Build the mark svg as four stages revealed from the center outward. */
  private buildMark(): SVGSVGElement {
    const mark = svgElement('svg', {
      viewBox: '160 160 704 704',
      width: 96,
      height: 96,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
    mark.setAttribute('class', klass('mark'))
    mark.setAttribute('aria-hidden', 'true')
    const spokes = stage('g', {}, STAGE_DELAY_MS.spokes)
    for (const [x, y] of OUTER_VERTICES) {
      // One ray per outer vertex; the inner cell's spokes lie along these.
      spokes.append(svgElement('line', {
        x1: CENTER, y1: CENTER, x2: x, y2: y,
        'stroke-width': 1.9,
        'stroke-opacity': 0.9,
        'vector-effect': 'non-scaling-stroke',
      }))
    }
    const inner = stage('polygon', {
      points: points(INNER_VERTICES),
      'stroke-width': 1.9,
      'stroke-opacity': 0.9,
      'vector-effect': 'non-scaling-stroke',
    }, STAGE_DELAY_MS.inner)
    const lifts = stage('g', {}, STAGE_DELAY_MS.lifts)
    for (const [x1, y1, x2, y2] of LIFT_EDGES) {
      lifts.append(svgElement('line', {
        x1, y1, x2, y2,
        'stroke-width': 1.5,
        'stroke-opacity': 0.7,
        'vector-effect': 'non-scaling-stroke',
      }))
    }
    const outer = stage('polygon', {
      points: points(OUTER_VERTICES),
      'stroke-width': 2.25,
      'vector-effect': 'non-scaling-stroke',
    }, STAGE_DELAY_MS.outer)
    mark.append(spokes, inner, lifts, outer)
    return mark
  }

  /** Reveal the wordmark letters one at a time, then hand the row to the nameplate. */
  private scheduleLettering(): void {
    this.timers.push(setTimeout(() => { this.caret.classList.add(klass('caretOn')) }, CARET_ON_MS))
    for (const [i, span] of this.letters.entries()) {
      this.timers.push(setTimeout(() => { span.classList.add(klass('in')) }, LETTER_START_MS + i * LETTER_STEP_MS))
    }
    this.timers.push(setTimeout(() => {
      this.caret.classList.remove(klass('caretOn'))
      this.caret.classList.add(klass('caretDone'))
    }, CARET_OFF_MS))
    this.timers.push(setTimeout(() => { this.plate.classList.add(klass('in')) }, PLATE_MS))
  }

  /** Admit the progress spinner and hint, unless the handoff already started. */
  private revealStatus(): void {
    if (this.disposed || this.statusShown) return
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
