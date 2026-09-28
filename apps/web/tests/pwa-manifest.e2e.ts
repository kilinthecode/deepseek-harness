import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Portal Harness',
    short_name: 'Portal',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships a favicon that inverts its palette under a dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The base palette is a dark rounded tile carrying light tesseract strokes,
  // and the dark-scheme query must flip both the tile stops and the stroke or
  // the mark loses contrast against dark browser chrome. Each override is
  // asserted inside the media query, so dropping the query, the palette
  // variables, or the gradient binding fails this test.
  expect(favicon).toContain('<rect x="0" y="0" width="64" height="64" rx="14.4" fill="url(#lift)"/>')
  expect(favicon).toMatch(/<radialGradient id="lift"[^>]*>\s*<stop[^>]*stop-color="var\(--dsh-favicon-tile-inner\)"\/>/u)
  expect(favicon).toMatch(/--dsh-favicon-stroke: #e9ebf1;/u)
  expect(favicon).toMatch(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*--dsh-favicon-tile-inner: #f7f8fa;[^}]*--dsh-favicon-stroke: #191c23;/u,
  )
  expect(favicon).toMatch(/<g stroke="var\(--dsh-favicon-stroke\)"/u)
})
