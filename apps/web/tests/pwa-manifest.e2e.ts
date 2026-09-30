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
  // The base palette draws a dark tile with light strokes, and the dark-scheme
  // query must override both so the mark keeps its contrast against dark
  // browser chrome. Asserting the light-scheme stroke beside the dark-scheme one
  // fails if either palette or the media query is dropped.
  expect(favicon).toContain('@media (prefers-color-scheme: dark)')
  expect(favicon).toContain('--dsh-favicon-stroke: #e9ebf1')
  expect(favicon).toContain('--dsh-favicon-stroke: #191c23')
  expect(favicon).toContain('fill="url(#lift)"')
})
