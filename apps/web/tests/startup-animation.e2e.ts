/** Browser frames for the framework-free startup drawing and renderer handoff. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/startup-animation/frames.json', import.meta.url))
let scaffold: WebScaffold
let browser: Browser
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold({})
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  // Freeze the real CSS timeline before its first paint; CI scheduling must
  // not decide which letters or line segments belong to a sampled frame.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const boot = document.querySelector('[data-dsh-boot]')
      if (boot === null) return
      for (const animation of boot.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = 0
      }
      observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.waitForSelector('[data-composer-input]', { timeout: 30_000 })
})

afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    await scaffold?.close()
  }
})

it('draws from the center, types in place, and waits for the last letter before revealing the app', async () => {
  const frames = []
  let positions: unknown
  // Sampled through the designed sequence: the four mark stages, the beat
  // after the mark settles, then PORTAL and HARNESS typing one word at a time.
  for (const time of [0, 350, 800, 1300, 1800, 2120, 2600, 3000, 3400, 3900]) {
    const frame = await page.evaluate((ms) => {
      const boot = document.querySelector('[data-dsh-boot]')!
      for (const animation of boot.getAnimations({ subtree: true })) animation.currentTime = ms
      const brand = boot.querySelector('[role="img"]')!
      const mark = brand.firstElementChild!
      const row = brand.lastElementChild!
      const words = [...row.children].map(word => [...word.children]
        .filter(letter => getComputedStyle(letter).opacity === '1' && getComputedStyle(word).opacity === '1')
        .map(letter => letter.textContent).join(''))
      const strokes = [...mark.children].map((stage) => {
        const scales = [...stage.children].map(edge =>
          new DOMMatrix(getComputedStyle(edge.firstElementChild!).transform).a)
        return {
          hidden: scales.filter(scale => scale === 0).length,
          drawing: scales.filter(scale => scale > 0 && scale < 1).length,
          finished: scales.filter(scale => scale === 1).length,
        }
      })
      const boxes = [brand, mark, row, ...row.querySelectorAll('span')].map((element) => {
        const rect = element.getBoundingClientRect()
        return [rect.x, rect.y, rect.width, rect.height]
      })
      return { words, strokes, boxes }
    }, time)
    positions ??= frame.boxes
    expect(frame.boxes, `fixed artwork and glyph positions at ${time}ms`).toEqual(positions)
    frames.push({ time, words: frame.words, strokes: frame.strokes })
  }
  await compareOrRefreshGolden(EXPECTED, JSON.stringify(frames, null, 2), webSnapshotMode())
  expect(await page.locator('[data-dsh-boot]').count()).toBe(1)
  await page.evaluate(() => {
    for (const animation of document.querySelector('[data-dsh-boot]')!.getAnimations({ subtree: true })) {
      animation.finish()
    }
  })
  await page.locator('[data-dsh-boot]').waitFor({ state: 'detached', timeout: 15_000 })
  expect(await page.locator('[data-composer-input]').isVisible()).toBe(true)
})
