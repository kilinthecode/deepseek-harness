/** The external kit module loads on the first conversion, not when the provider mounts. */
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { afterEach, expect, it, vi } from 'vitest'
import OfficeToPdf, { OfficeSourceKey, type OfficeToPdfRequest } from '../src/index.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>(), loads: 0 }))
vi.mock('@deepseek-ai/libreoffice-kit', () => {
  kit.loads += 1
  return { createConverter: kit.create }
})

const pdf = Buffer.from('%PDF-1.7\nlazy\n%%EOF\n')

function request(index: number): OfficeToPdfRequest {
  return {
    extension: 'docx',
    priority: 'foreground',
    source: {
      key: OfficeSourceKey(`lazy-${index}`),
      version: 'v1',
      bytes: 4,
      read: async () => ({ bytes: new Uint8Array([80, 75, 3, index]), version: 'v1' }),
    },
  }
}

const ctx = new Context()
afterEach(async () => { await ctx.fiber.dispose() })

it('imports the kit on the first conversion and reuses the module', async () => {
  kit.create.mockImplementation(async () => ({
    backend: 'native',
    render: vi.fn<Converter['render']>().mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, pdf)
      return { backend: 'native', missingFonts: [] }
    }),
    dispose: vi.fn<Converter['dispose']>().mockResolvedValue(undefined),
    renderImages: vi.fn<Converter['renderImages']>(),
    convert: vi.fn<Converter['convert']>(),
    recalculate: vi.fn<Converter['recalculate']>(),
  }))
  await ctx.plugin(OfficeToPdf, {})
  expect(kit.loads).toBe(0)

  await ctx.officeToPdf.convert(request(1))
  expect(kit.loads).toBe(1)
  await ctx.officeToPdf.convert(request(2))
  expect(kit.loads).toBe(1)
  expect(kit.create).toHaveBeenCalled()
})
