import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'Portal Harness',
    short_name: 'Portal',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [{
      src: 'favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  // The light-scheme mark is a dark tile with light strokes and the dark-scheme
  // mark inverts both, so each keeps its contrast against the browser chrome.
  // Each pair maps a dark-scheme color attribute to its light-scheme value.
  const palette: ReadonlyArray<readonly [dark: string, light: string]> = [
    ['stop-color="#f7f8fa"', 'stop-color="#262a34"'],
    ['stop-color="#e9ebf1"', 'stop-color="#191c23"'],
    ['stroke="#191c23"', 'stroke="#e9ebf1"'],
  ]
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="url(#lift)"')
  for (const [darkColor, lightColor] of palette) {
    expect(light).toContain(lightColor)
    expect(dark).toContain(darkColor)
  }
  expect(palette.reduce((svg, [darkColor, lightColor]) => svg.replace(darkColor, lightColor), dark)).toBe(light)
})
