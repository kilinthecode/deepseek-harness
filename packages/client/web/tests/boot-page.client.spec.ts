// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'
import css from '../src/boot-page.module.css'

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

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('160 160 704 704')
    expect(el.textContent).toContain('PORTAL')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('types the wordmark letters in sequence behind the caret', () => {
    vi.useFakeTimers()
    const { el } = mount()
    const spans = [...el.querySelectorAll('span')]
    const word = spans.filter(span => span.textContent !== '')
    const caret = spans.at(-1)!
    expect(word).toHaveLength(6)
    for (const span of word) expect(span.className).not.toContain(css.in)
    vi.advanceTimersByTime(1050)
    expect(word[0]!.className).toContain(css.in)
    expect(word[1]!.className).not.toContain(css.in)
    vi.advanceTimersByTime(5 * 80)
    for (const span of word) expect(span.className).toContain(css.in)
    expect(caret.className).toContain(css.caretOn)
    vi.advanceTimersByTime(2150 - 1050 - 400)
    expect(caret.className).toContain(css.caretDone)
    expect(caret.className).not.toContain(css.caretOn)
  })

  it('reveals the finished brand immediately under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { el } = mount()
    expect(el.firstElementChild?.classList.contains(css.static!)).toBe(true)
    expect(el.querySelectorAll(`.${css.static!} svg .${css.draw!}`)).toHaveLength(14)
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
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
    vi.useFakeTimers()
    const { el, page } = mount()
    page.dispose()
    expect(el.firstElementChild).not.toBeNull()
    vi.advanceTimersByTime(2250)
    expect(el.firstElementChild).not.toBeNull()
    vi.advanceTimersByTime(300)
    expect(el.childNodes).toHaveLength(0)
  })
})
