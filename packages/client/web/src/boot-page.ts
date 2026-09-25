/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Look up one generated class name; every class this module reads is defined in the stylesheet beside it. */
function klass(name: string): string {
  return css[name] ?? ''
}

/**
 * Tesseract geometry in the PortalMark 160–864 frame, mirrored here because
 * the boot page mounts before the UI package tree and stays dependency-free.
 */
const CENTER = 512
type Vertex = readonly [number, number]

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

/** Startup lettering: both words are typed in their reserved final positions. */
const WORD = 'PORTAL'
const PLATE = 'HARNESS'

/**
 * Each stroke grows along its fixed axis without moving either cell. HTML
 * stroke layers keep the drawing on the compositor during plugin activation.
 * Delays and durations are milliseconds from the first rendered frame.
 */
const STAGES = {
  spokes: { delay: 120, duration: 480 },
  inner: { delay: 600, duration: 400 },
  lifts: { delay: 1000, duration: 560 },
  outer: { delay: 1560, duration: 540 },
} as const

/** Lettering schedule in ms from mount; CSS runs it without per-letter timers. */
const LETTER_START_MS = 2180
const LETTER_STEP_MS = 100
const PLATE_MS = 2860
const PLATE_LETTER_START_MS = 3020
const PLATE_LETTER_STEP_MS = 80

/** Delay after which a boot still running earns the progress spinner and hint. */
const STATUS_MS = 4000
/**
 * Shortest brand moment held before the handoff. Typing ends at 3.58s,
 * followed by a still pause before the application fade.
 */
const MIN_HOLD_MS = 3800
/** Pause after the nameplate finishes before fading to the application. */
const BRAND_SETTLE_MS = 220
/** Leave fade, matching the dispose transition in the stylesheet. */
const LEAVE_MS = 400

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

/**
 * Draw a constant-width stroke from its first endpoint. The wrapper owns the
 * fixed position and rotation; only the child grows along that local axis.
 */
function stroke(
  from: Vertex,
  to: Vertex,
  width: number,
): HTMLDivElement {
  const [x, y] = from
  const dx = to[0] - x
  const dy = to[1] - y
  const edge = div(css.edge)
  edge.style.left = `${String((x - 160) / 704 * 100)}%`
  edge.style.top = `${String((y - 160) / 704 * 100)}%`
  edge.style.width = `${String(Math.hypot(dx, dy) / 704 * 100)}%`
  edge.style.height = `${String(width)}px`
  edge.style.marginTop = `${String(-width / 2)}px`
  edge.style.transform = `rotate(${String(Math.atan2(dy, dx))}rad)`
  edge.append(div(css.stroke))
  return edge
}

/** Each glyph reserves its width before its single-step reveal and caret. */
function typedWord(text: string, className: string | undefined, start: number, step: number): HTMLDivElement {
  const word = div(className)
  for (const [index, letter] of Array.from(text).entries()) {
    const span = document.createElement('span')
    span.className = klass('letter')
    span.textContent = letter
    span.style.setProperty('--dsh-letter-delay', `${String(start + index * step)}ms`)
    span.style.setProperty('--dsh-letter-step', `${String(step)}ms`)
    word.append(span)
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
  private plate!: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private total = 0
  private failure: string | undefined
  /** Whether the progress spinner and hint belong in the card yet. */
  private statusShown = false
  private statusDue = false
  private brandFinished = false
  private brandSettled = false
  private holdFinished = false
  private leaveStarted = false
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
    if (reduced) {
      this.brandFinished = true
      this.brandSettled = true
    } else {
      const finish = (event: Event): void => {
        if (event.target === this.plate.lastElementChild) this.finishBrand()
      }
      this.plate.addEventListener('animationend', finish)
      this.plate.addEventListener('animationcancel', (event) => {
        if (event.target === this.plate.lastElementChild && prefersReducedMotion()) this.finishBrand()
      })
    }
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
    this.timers.push(setTimeout(() => {
      this.statusDue = true
      this.revealStatus()
    }, reduced ? 500 : STATUS_MS))
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
   * application; CSS keeps the lettering in sequence through the hold.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const remaining = this.reduced ? 0 : Math.max(0, this.mountedAt + MIN_HOLD_MS - Date.now())
    if (remaining === 0) this.holdFinished = true
    else this.timers.push(setTimeout(() => {
      this.holdFinished = true
      this.beginLeave()
    }, remaining))
    this.beginLeave()
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
    const word = typedWord(WORD, css.word, LETTER_START_MS, LETTER_STEP_MS)
    this.plate = typedWord(PLATE, css.plate, PLATE_LETTER_START_MS, PLATE_LETTER_STEP_MS)
    this.plate.style.animationDelay = `${String(PLATE_MS)}ms`
    row.append(word, this.plate)
    brand.append(row)
    return brand
  }

  /** Trace the mark from the center through the inner cell to the outer cell. */
  private buildMark(): HTMLDivElement {
    const mark = div(css.mark)
    mark.setAttribute('aria-hidden', 'true')
    for (const [name, timing] of Object.entries(STAGES)) {
      const group = div(css.stage)
      group.style.setProperty('--dsh-stroke-delay', `${String(timing.delay)}ms`)
      group.style.setProperty('--dsh-stroke-duration', `${String(timing.duration)}ms`)
      if (name === 'spokes' || name === 'lifts') {
        for (const [index, vertex] of INNER_VERTICES.entries()) {
          group.append(name === 'spokes'
            ? stroke([CENTER, CENTER], vertex, 1.9)
            : stroke(vertex, OUTER_VERTICES[index] as Vertex, 1.9))
        }
      } else {
        const vertices = name === 'inner' ? INNER_VERTICES : OUTER_VERTICES
        const width = name === 'inner' ? 1.9 : 2.25
        for (const [index, vertex] of vertices.entries()) {
          const next = vertices[(index + 1) % vertices.length] as Vertex
          const midpoint = [(vertex[0] + next[0]) / 2, (vertex[1] + next[1]) / 2] as const
          group.append(stroke(vertex, midpoint, width), stroke(next, midpoint, width))
        }
      }
      mark.append(group)
    }
    return mark
  }

  /** Keep the handoff behind the last CSS frame when boot blocks early paints. */
  private finishBrand(): void {
    if (this.brandFinished) return
    this.brandFinished = true
    this.revealStatus()
    this.timers.push(setTimeout(() => {
      this.brandSettled = true
      this.beginLeave()
    }, BRAND_SETTLE_MS))
  }

  /** Start the fade after both the minimum hold and the rendered brand settle. */
  private beginLeave(): void {
    if (!this.disposed || !this.holdFinished || !this.brandSettled || this.leaveStarted) return
    this.leaveStarted = true
    this.root.classList.add(klass('leaving'))
    this.timers.push(setTimeout(() => {
      this.root.remove()
      this.clearTimers()
    }, this.reduced ? 0 : LEAVE_MS))
  }

  /** Admit the progress spinner and hint after its deadline and the brand reveal. */
  private revealStatus(): void {
    if (this.disposed || this.statusShown || !this.statusDue || !this.brandFinished) return
    this.statusShown = true
    this.render()
  }

  /** Redraw the state-dependent content below the brand. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.statusShown) {
        if (this.card.lastElementChild !== this.status) {
          if (this.card.lastElementChild !== this.brand) this.card.lastElementChild?.remove()
          this.card.append(this.status)
        }
      } else if (this.card.lastElementChild !== this.brand) {
        this.card.lastElementChild?.remove()
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    // Retain the brand node; reattaching it restarts every CSS reveal.
    if (this.card.lastElementChild !== this.brand) this.card.lastElementChild?.remove()
    this.card.append(report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
