// @vitest-environment jsdom
// GenericToolCard's gallery claim, read from the props it hands ToolRow: a
// card replaces the IN/OUT body that renders the gallery, and every card
// hides `output` too, so the DOM is identical either way and only the props
// show whether the image blocks stayed in `output`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { ToolRowProps } from '../src/client/tool/components/ToolRow.tsx'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'

const rows = vi.hoisted((): ToolRowProps[] => [])
vi.mock('../src/client/tool/components/ToolRow.tsx', () => ({
  ToolRow: (props: ToolRowProps) => {
    rows.push(props)
    return null
  },
}))

afterEach(() => {
  cleanup()
  rows.length = 0
})

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)
const image = {
  type: 'image',
  attachment: { attachmentId: 'sha256:claim', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

function rowFor(name: string, argsRaw: string, meta?: Record<string, unknown>): ToolRowProps {
  const block: ToolResultNode = {
    kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', call: { name, argsRaw }, callTime: 1_000,
    content: [{ type: 'text', text: 'done' }, image as never], isError: false, subCalls: [],
    ...meta === undefined ? {} : { meta },
  }
  render(
    <GenericToolCard
      useDisclosure={() => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() })}
      t={t}
      callId="c1"
      toolName={name}
      phase="result"
      block={block}
      openFile={vi.fn()}
      loadImage={vi.fn(() => Promise.reject(new Error('not used')))}
      renderResultImages={() => null}
    />,
  )
  return rows.at(-1)!
}

describe('GenericToolCard gallery claim', () => {
  it('claims the images for the IN/OUT body when no card renders the result', () => {
    const row = rowFor('mcp_screenshot', '{}')
    expect(row.resultImages?.images).toEqual([{ attachment: image.attachment }])
    expect(row.resultImages?.text).toBe(JSON.stringify(image, null, 2))
    expect(row.output).toBe('done')
  })

  it.each([
    ['diff', 'write', '{"file_path":"a.ts","content":"x"}', undefined],
    ['search', 'glob', '{"pattern":"*.png"}', { truncated: false, total: 1, shape: 'paths', paths: ['a.png'] }],
    ['web', 'web_fetch', '{"url":"https://example.com"}', { truncated: false, url: 'https://example.com', statusCode: 200 }],
  ] as const)('claims no images beside a %s card and keeps them in output', (card, name, argsRaw, meta) => {
    const row = rowFor(name, argsRaw, meta)
    expect(row[card]).not.toBeNull()
    expect(row.resultImages).toBeNull()
    expect(row.output).toBe(`done\n${JSON.stringify(image, null, 2)}`)
  })
})
