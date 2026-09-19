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

/** Startup lettering, typed one letter at a time after the mark draws. */
const WORD = 'PORTAL'
const LETTER_START_MS = 1050
const LETTER_STEP_MS = 80
const CARET_FADE_MS = 2150
/**
 * Removal delay matching the dispose fade transition in the stylesheet, and
 * the shortest brand moment the page holds before handing off to a UI that
 * finished booting mid-animation (the mark settles at ~1.4s, the word at
 * ~1.7s, the caret at ~2.15s).
 */
const LEAVE_MS = 260
const MIN_HOLD_MS = 2250

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
 * Create one stroked tesseract part that draws itself in: `pathLength=1`
 * normalizes the dash sweep across parts of differing lengths.
 * @param delay - Draw start in ms from page mount.
 * @param duration - Draw length in ms.
 * @returns the element, hidden until its delay passes.
 */
function drawPart<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  delay: number,
  duration: number,
): SVGElementTagNameMap[K] {
  const el = svgElement(tag, { pathLength: 1, ...attributes })
  el.setAttribute('class', klass('draw'))
  el.style.animationDelay = `${String(delay)}ms`
  el.style.animationDuration = `${String(duration)}ms`
  return el
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
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private total = 0
  private failure: string | undefined
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
    this.card.append(this.brand, this.status)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
    if (!reduced) this.scheduleTyping()
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
   * Detach the page once the UI renderer takes the mount point. The page
   * stays on top while the brand moment finishes, then fades to reveal the
   * ready application; the typing timers keep running through the hold.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const remaining = this.reduced ? 0 : Math.max(0, this.mountedAt + MIN_HOLD_MS - Date.now())
    this.timers.push(setTimeout(() => {
      this.root.classList.add(klass('leaving'))
      this.timers.push(setTimeout(() => { this.root.remove() }, LEAVE_MS))
    }, remaining))
  }

  /** Build the tesseract mark and the typed wordmark beneath it. */
  private buildBrand(): HTMLDivElement {
    const brand = div(css.brand)
    brand.append(this.buildMark())
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
    brand.append(word)
    return brand
  }

  /** Build the mark svg, every part scheduled to draw from the center outward. */
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
    const lifts = svgElement('g', { opacity: 0.7 })
    for (const [i, [x1, y1, x2, y2]] of LIFT_EDGES.entries()) {
      lifts.append(drawPart('line', {
        x1, y1, x2, y2,
        'stroke-width': 1.5,
        'vector-effect': 'non-scaling-stroke',
      }, 640 + i * 35, 260))
    }
    const inner = svgElement('g', { opacity: 0.9 })
    for (const [i, [x, y]] of OUTER_VERTICES.entries()) {
      // One ray per outer vertex; the inner cell's spokes lie along these.
      inner.append(drawPart('line', {
        x1: CENTER, y1: CENTER, x2: x, y2: y,
        'stroke-width': 1.9,
        'vector-effect': 'non-scaling-stroke',
      }, 60 + i * 45, 420))
    }
    inner.append(drawPart('polygon', {
      points: INNER_VERTICES.map(([x, y]) => `${x},${y}`).join(' '),
      'stroke-width': 1.9,
      'vector-effect': 'non-scaling-stroke',
    }, 480, 520))
    const outer = svgElement('g', {})
    outer.append(drawPart('polygon', {
      points: OUTER_VERTICES.map(([x, y]) => `${x},${y}`).join(' '),
      'stroke-width': 2.25,
      'vector-effect': 'non-scaling-stroke',
    }, 800, 560))
    mark.append(lifts, inner, outer)
    return mark
  }

  /** Reveal the wordmark letters one at a time behind a blinking caret. */
  private scheduleTyping(): void {
    this.timers.push(setTimeout(() => { this.caret.classList.add(klass('caretOn')) }, LETTER_START_MS - 150))
    for (const [i, span] of this.letters.entries()) {
      this.timers.push(setTimeout(() => { span.classList.add(klass('in')) }, LETTER_START_MS + i * LETTER_STEP_MS))
    }
    this.timers.push(setTimeout(() => {
      this.caret.classList.remove(klass('caretOn'))
      this.caret.classList.add(klass('caretDone'))
    }, CARET_FADE_MS))
  }

  /** Redraw the state-dependent content below the brand. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.status.parentElement !== this.card) {
        this.card.replaceChildren(this.brand, this.status)
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
