// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { localizeAutoReviewDenial, normalizeAutoReviewReason } from '../src/client/tool/models/auto-review-denial.ts'
import {
  classifyTool, formatToolBody, resultText, toolRowModel,
} from '../src/client/tool/models/tool-call-model.ts'
import { ToolRow, type ToolRowResultImages } from '../src/client/tool/components/ToolRow.tsx'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)

const running = (over?: Partial<StartedToolCall>): StartedToolCall => ({
  phase: 'start' as const, callId: 'c1', name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}',
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const result = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' },
  callTime: 1_000,
  content: [], isError: false, subCalls: [], ...over,
})

describe('tool-call-model', () => {
  it('classifies known tools and falls back to others', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('pwsh')).toBe('bash')
    expect(classifyTool('read')).toBe('read')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('write')).toBe('write')
    expect(classifyTool('edit')).toBe('edit')
    expect(classifyTool('cordis_runtime_inspect')).toBe('read')
    // The v3 run-control verbs: `others` is the decided intent, not an
    // unclassified default (there is no program to show and no file to open).
    expect(classifyTool('cordis_run')).toBe('others')
    expect(classifyTool('cordis_stop')).toBe('others')
    expect(classifyTool('cordis_undefine')).toBe('others')
    expect(classifyTool('todo_write')).toBe('others')
  })

  it('names each cordis verb instead of leaving it a bare tool call', () => {
    // Every define/run pair the model makes puts a row in the flow, so the
    // generic "Tool call · cordis_run · dyn-1" fallback is user-visible slop.
    const titleOf = (name: string) => toolRowModel(name, running({ name, argsRaw: '{"id":"dyn-1"}' }))
    expect(t(titleOf('cordis_run').titleKey)).toBe('运行 Cordis 插件')
    expect(t(titleOf('cordis_stop').titleKey)).toBe('停止 Cordis 插件')
    expect(t(titleOf('cordis_undefine').titleKey)).toBe('移除 Cordis 插件')
    // An owned title takes the tool name out of the summary slot, leaving the
    // package id as the only mutable text.
    expect(titleOf('cordis_run').summary).toBe('dyn-1')
  })

  it('leaves cordis_define to its own keyed toolview', () => {
    // ui-cordis registers a keyed `tool.call.toolview` entry for cordis_define,
    // and a keyed hit replaces the generic row (this model is only reached
    // through the dispatch fallback). A mapping here would be unreachable, and a
    // title here would be a second answer to what the card already renders.
    const model = toolRowModel('cordis_define', running({ name: 'cordis_define', argsRaw: '{"name":"clock"}' }))
    expect(model.variant).toBe('others')
    expect(t(model.titleKey)).toBe('工具调用')
  })

  it('renders cordis mount verbs no shipped tool implements as generic calls', () => {
    // No shipped tool implements these cordis mount verbs, so a mapping would
    // be unreachable.
    expect(classifyTool('cordis_mount')).toBe('others')
    expect(t(toolRowModel('cordis_mount', running({ name: 'cordis_mount', argsRaw: '{}' })).titleKey)).toBe('工具调用')
    expect(t(toolRowModel('cordis_unmount', running({ name: 'cordis_unmount', argsRaw: '{}' })).titleKey)).toBe('工具调用')
  })

  it('gives the pwsh shell row the bash family treatment and localized command title', () => {
    const m = toolRowModel('pwsh', running())
    expect(m.variant).toBe('bash')
    expect(t(m.titleKey)).toBe('运行命令')
  })

  it('derives state across running/ok/error/interrupted', () => {
    expect(toolRowModel('bash', running()).state).toBe('running')
    expect(toolRowModel('bash', result()).state).toBe('ok')
    expect(toolRowModel('bash', result({ isError: true })).state).toBe('error')
    expect(toolRowModel('bash', result({ isError: true, error: { name: 'E', code: 'interrupted' } })).state).toBe('stopped')
  })

  it('derives the bash summary from description over command', () => {
    const m = toolRowModel('bash', running())
    expect(t(m.titleKey)).toBe('运行命令')
    expect(m.summary).toBe('List files')
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"pwd"}' })).summary).toBe('pwd')
  })

  it('keeps summaries single-line and falls back for opaque args', () => {
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"a\\nb"}' })).summary).toBe('a')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/tmp/x.ts"}' })).summary).toBe('/tmp/x.ts')
    expect(toolRowModel('write', running({ name: 'write', argsRaw: '{"file_path":"src/x.ts"}' })).summary).toBe('src/x.ts')
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"src/x.ts"}' })).summary).toBe('src/x.ts')
    // Other rows prefix the real tool name into the summary slot (figma
    // flows: static "Tool call" title, the name rides the mutable summary).
    expect(toolRowModel('x', running({ argsRaw: '{"n":1}' })).summary).toBe('x · {"n":1}')
    expect(toolRowModel('x', running({ argsRaw: 'not json' })).summary).toBe('x · not json')
    expect(toolRowModel('x', running({ argsRaw: '' })).summary).toBe('x · c1')
    expect(toolRowModel('', running({ argsRaw: '' })).summary).toBe('c1')
  })

  it('joins multi-query web search arguments in the summary', () => {
    expect(toolRowModel('web_search', running({
      name: 'web_search',
      argsRaw: '{"queries":["first query","second\\nquery"]}',
    })).summary).toBe('first query, second')
    // An empty (or all-blank-filtered) queries array falls through to the
    // ordinary args-object summary fallback instead of joining nothing.
    expect(toolRowModel('web_search', running({
      name: 'web_search',
      argsRaw: '{"queries":[]}',
    })).summary).toBe('{"queries":[]}')
  })

  it('exposes filePath for path/file_path args and skips URL-only reads', () => {
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('write', running({ name: 'write', argsRaw: '{"file_path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('web_fetch', running({ name: 'web_fetch', argsRaw: '{"url":"https://example.com"}' })).filePath)
      .toBeUndefined()
    expect(toolRowModel('bash', running()).filePath).toBeUndefined()
  })

  it('displays workspace-rooted paths relative to the session cwd', () => {
    const cwd = '/Users/u/ws/'
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"/Users/u/ws/src/x.ts"}' }), cwd).summary).toBe('src/x.ts')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/ws/a.md"}' }), cwd).summary).toBe('a.md')
    // Paths outside the workspace (and non-path summaries) stay verbatim.
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/etc/hosts"}' }), cwd).summary).toBe('/etc/hosts')
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"pwd"}' }), cwd).summary).toBe('pwd')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/ws/a.md"}' }), '').summary).toBe('/Users/u/ws/a.md')
  })

  it('abbreviates leftover POSIX home paths after cwd relativization', () => {
    const home = '/Users/u'
    const cwd = '/tmp/ws'
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u"}' }), cwd, home).summary).toBe('~')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/notes.md"}' }), cwd, home).summary)
      .toBe('~/notes.md')
    // Workspace-relative wins: a home-and-cwd descendant stays short, not `~/…`.
    expect(toolRowModel(
      'read',
      running({ name: 'read', argsRaw: '{"path":"/Users/u/proj/src/a.ts"}' }),
      '/Users/u/proj',
      home,
    ).summary).toBe('src/a.ts')
    // Prefix boundary: `/Users/u2` is not under `/Users/u`.
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u2/a.ts"}' }), cwd, home).summary)
      .toBe('/Users/u2/a.ts')
    expect(toolRowModel(
      'read',
      running({ name: 'read', argsRaw: '{"path":"C:\\\\Users\\\\u\\\\a.ts"}' }),
      cwd,
      home,
    ).summary).toBe('C:\\Users\\u\\a.ts')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/a.ts"}' }), cwd).summary)
      .toBe('/Users/u/a.ts')
  })

  it('body pretty-prints JSON args, keeps raw non-JSON, null when empty', () => {
    expect(formatToolBody('bash', toolRowModel('bash', running({ argsRaw: '{"a":1}' })).bodyRaw ?? ''))
      .toBe('{\n  "a": 1\n}')
    expect(formatToolBody('bash', toolRowModel('bash', running({ argsRaw: 'raw' })).bodyRaw ?? ''))
      .toBe('raw')
    expect(formatToolBody('bash', '')).toBeNull()
    expect(toolRowModel('bash', running({ argsRaw: '' })).bodyRaw).toBeNull()
    expect(toolRowModel('bash', result({ call: null })).bodyRaw).toBeNull()
  })

  it('a code row with an empty program falls back to the args JSON envelope', () => {
    const model = toolRowModel('run_code', running({ name: 'run_code', argsRaw: '{"code":""}' }))
    expect(formatToolBody(model.variant, model.bodyRaw ?? ''))
      .toBe('{\n  "code": ""\n}')
  })

  it('resultText flattens text blocks verbatim, other shapes as JSON, empty error content to name: code', () => {
    expect(resultText(result({ content: [{ type: 'text', text: 'a\nb' }] }))).toBe('a\nb')
    expect(resultText(result({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' } as never] })))
      .toBe(`a\n${JSON.stringify({ type: 'image', data: 'x' }, null, 2)}`)
    expect(resultText(result({ content: [], isError: true, error: { name: 'ToolError', code: 'denied' } })))
      .toBe('ToolError: denied')
    expect(resultText(result({ content: [] }))).toBe('')
  })

  it('resultText only drops image blocks when the caller opts in with skipImages', () => {
    const mixed = result({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' } as never] })
    expect(resultText(mixed)).toBe(`a\n${JSON.stringify({ type: 'image', data: 'x' }, null, 2)}`)
    expect(resultText(mixed, { skipImages: true })).toBe('a')
    // A default-arg call and an explicit false both keep the flattened JSON.
    expect(resultText(mixed, {})).toBe(`a\n${JSON.stringify({ type: 'image', data: 'x' }, null, 2)}`)
    expect(resultText(mixed, { skipImages: false })).toBe(`a\n${JSON.stringify({ type: 'image', data: 'x' }, null, 2)}`)
    // An image-only result with skipImages drops to the empty string, not a blank JSON line.
    expect(resultText(result({ content: [{ type: 'image', data: 'x' } as never] }), { skipImages: true })).toBe('')
  })

  it('derives output from the settled result and null while running or blank', () => {
    expect(toolRowModel('bash', result({ content: [{ type: 'text', text: 'out' }] })).output).toBe('out')
    expect(toolRowModel('bash', running()).output).toBeNull()
    expect(toolRowModel('bash', result({ content: [] })).output).toBeNull()
  })

  it('derives resultImages only from a fully well-formed, non-empty gallery, and skips those blocks in output', () => {
    const sampleImage = {
      attachmentId: 'sha256:gallery', mediaType: 'image/png', bytes: 10, width: 2, height: 2,
    }
    const claim = { claimImages: true }
    const withImage = toolRowModel('mcp_screenshot', result({
      content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', attachment: sampleImage } as never],
    }), undefined, undefined, claim)
    expect(withImage.resultImages).toEqual({
      images: [sampleImage],
      text: JSON.stringify({ type: 'image', attachment: sampleImage }, null, 2),
    })
    expect(withImage.output).toBe('took a screenshot')

    // A malformed image block (missing attachmentId) declines the gallery
    // entirely and keeps the ordinary JSON flattening — no information loss.
    const malformed = toolRowModel('mcp_screenshot', result({
      content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', attachment: { ...sampleImage, attachmentId: '' } } as never],
    }), undefined, undefined, claim)
    expect(malformed.resultImages).toBeNull()
    expect(malformed.output).toBe(`took a screenshot\n${JSON.stringify({ type: 'image', attachment: { ...sampleImage, attachmentId: '' } }, null, 2)}`)

    // No image block at all: same null gallery, unaffected text output.
    expect(toolRowModel('bash', result({ content: [{ type: 'text', text: 'out' }] }), undefined, undefined, claim).resultImages).toBeNull()
    // Running calls carry no content yet.
    expect(toolRowModel('mcp_screenshot', running(), undefined, undefined, claim).resultImages).toBeNull()
    // An error result's images still claim the gallery (error first line stays independent).
    const errored = toolRowModel('mcp_screenshot', result({
      isError: true,
      content: [{ type: 'text', text: 'capture failed' }, { type: 'image', attachment: sampleImage } as never],
    }), undefined, undefined, claim)
    expect(errored.resultImages?.images).toEqual([sampleImage])
    expect(errored.errorSummary).toBe('capture failed')
  })

  it('declines the whole gallery when an image block beside a well-formed one is malformed, keeping both in output', () => {
    const valid = { attachmentId: 'sha256:valid', mediaType: 'image/png', bytes: 10, width: 2, height: 2 }
    const malformed: unknown[] = [
      null, [], 'ref',
      { ...valid, attachmentId: '' },
      { ...valid, mediaType: 'text/html' },
      { ...valid, bytes: 0 },
      { ...valid, width: 1.5 },
      { ...valid, height: 'tall' },
      { ...valid, name: 5 },
      { ...valid, originalDimensions: [] },
      { ...valid, originalDimensions: { width: 4, height: 0 } },
    ]
    for (const attachment of malformed) {
      for (const images of [
        [{ type: 'image', attachment: valid }, { type: 'image', attachment }],
        [{ type: 'image', attachment }, { type: 'image', attachment: valid }],
      ]) {
        const model = toolRowModel('mcp_screenshot', result({
          content: [{ type: 'text', text: 'two shots' }, ...images] as never,
        }), undefined, undefined, { claimImages: true })
        expect(model.resultImages).toBeNull()
        expect(model.output).toBe(['two shots', ...images.map(block => JSON.stringify(block, null, 2))].join('\n'))
      }
    }
  })

  it('resultImages skips a non-object content entry as wire noise instead of declining the gallery', () => {
    // Unlike read_image's stricter imageCardModel (which pre-declines the
    // whole card via fullyRendered), the generic row's claim only requires
    // every IMAGE block to be well-formed: a stray non-object entry elsewhere
    // in the content is skipped by imageReferences, not fatal to the gallery.
    const sampleImage = {
      attachmentId: 'sha256:stray', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const model = toolRowModel('mcp_screenshot', result({
      content: [{ type: 'text', text: 'noted' }, 'stray-string', { type: 'image', attachment: sampleImage }] as never,
    }), undefined, undefined, { claimImages: true })
    expect(model.resultImages?.images).toEqual([sampleImage])
    expect(model.output).toBe('noted\n"stray-string"')
  })

  it('claims no images for a caller that does not render the gallery, keeping them in the output JSON', () => {
    const sampleImage = {
      attachmentId: 'sha256:keyed', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const content = [{ type: 'text', text: 'caption' }, { type: 'image', attachment: sampleImage }] as never
    const model = toolRowModel('read_image', result({ content }))
    expect(model.resultImages).toBeNull()
    expect(model.output).toBe(`caption\n${JSON.stringify({ type: 'image', attachment: sampleImage }, null, 2)}`)
  })

  it('derives errorSummary as the first output line on error rows only', () => {
    const failed = result({ content: [{ type: 'text', text: 'boom\ndetail' }], isError: true })
    expect(toolRowModel('bash', failed).errorSummary).toBe('boom')
    expect(toolRowModel('bash', result({ content: [{ type: 'text', text: 'boom' }] })).errorSummary).toBeNull()
    expect(toolRowModel('bash', result({ content: [], isError: true })).errorSummary).toBeNull()
    expect(toolRowModel('bash', running()).errorSummary).toBeNull()
  })

  it('derives Auto-review denial only from the exact structured error identity', () => {
    const denied = result({
      parentCallId: 'outer:code:1',
      isError: true,
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: ' raw\nreason ' },
    })
    expect(toolRowModel('bash', denied).autoReviewDenial).toEqual({ reason: ' raw\nreason ' })
    expect(toolRowModel('bash', result({
      isError: true,
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
    })).autoReviewDenial).toEqual({ reason: null })
    expect(toolRowModel('bash', result({
      isError: true,
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: 42 },
    } as never)).autoReviewDenial).toEqual({ reason: null })
    expect(toolRowModel('bash', result({
      isError: true,
      error: { name: 'AutoReviewDeniedError', code: 'OTHER' },
    })).autoReviewDenial).toBeNull()
    expect(toolRowModel('bash', result({
      isError: true,
      error: { name: 'OtherError', code: 'AUTO_REVIEW_DENIED' },
    })).autoReviewDenial).toBeNull()
    expect(toolRowModel('bash', result({
      isError: false,
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
    })).autoReviewDenial).toBeNull()
    expect(toolRowModel('bash', running()).autoReviewDenial).toBeNull()
  })

  it('normalizes Auto-review reasons only for localized display and falls back when blank', () => {
    expect(normalizeAutoReviewReason('  first\r\n\nsecond\u2028\u2029third  ')).toBe('first second third')
    expect(normalizeAutoReviewReason(' \r\n\u2028 ')).toBeNull()
    expect(normalizeAutoReviewReason(null)).toBeNull()
    expect(localizeAutoReviewDenial({ reason: null }, t)).toEqual({
      summary: 'Auto review 已拒绝',
      output: '工具未执行。原因：Auto review 未授权此次操作',
    })
  })

  it('gives Cordis lifecycle tools action titles over their generic variants', () => {
    expect(toolRowModel('cordis_runtime_inspect', running({
      name: 'cordis_runtime_inspect',
      argsRaw: '{"what":"api","name":"tools"}',
    }))).toMatchObject({
      variant: 'read',
      titleKey: 'tool.title.inspect',
      summary: 'api',
    })
    expect(toolRowModel('cordis_run', running({
      name: 'cordis_run',
      argsRaw: '{"id":"dyn-2"}',
    }))).toMatchObject({
      variant: 'others',
      titleKey: 'tool.title.runCordis',
      summary: 'dyn-2',
    })
    expect(toolRowModel('cordis_undefine', result({
      call: { name: 'cordis_undefine', argsRaw: '{"id":"dyn-2"}' },
    }))).toMatchObject({
      variant: 'others',
      titleKey: 'tool.title.removeCordis',
      summary: 'dyn-2',
    })
  })
})

describe('ToolRow', () => {
  const rowProps = {
    useDisclosure,
    t,
    variant: 'bash' as const, icon: <i data-testid="tool-icon" />, title: 'Bash',
    summary: 'List files', bodyRaw: '{"a":1}', state: 'ok' as const,
  }

  it('renders leading icon, title and summary while collapsed', () => {
    const view = render(<ToolRow {...rowProps} />)
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('row click expands: chevron leading, summary kept inline, body in the scrolling card', () => {
    const view = render(<ToolRow {...rowProps} />)
    fireEvent.click(view.getByRole('button'))
    expect(view.queryByTestId('tool-icon')).toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.getByText(/"a": 1/)).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
    expect(view.getByText('List files')).toBeTruthy()
  })

  it('shows totals once and shared context once when an edit expands', () => {
    const view = render(<ToolRow {...rowProps} variant="edit" title="Edit" summary="settings.ts" diff={{
      card: { diffs: [{
        path: 'settings.ts',
        oldText: 'start\nsecond\nthird\nold\nfourth\nfifth\nend',
        newText: 'start\nsecond\nthird\nnew\nfourth\nfifth\nend',
      }] },
    }} />)
    expect(view.getByText('+1 -1')).toBeTruthy()
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(view.getAllByText('+1 -1')).toHaveLength(1)
    expect(view.getAllByText('start')).toHaveLength(1)
    expect(view.getAllByText('end')).toHaveLength(1)
    expect(view.getByText('old', { exact: true })).toBeTruthy()
    expect(view.getByText('new', { exact: true })).toBeTruthy()
    expect(view.queryByRole('button', { name: /展开其余/ })).toBeNull()
  })

  it('formats the argument body only while expanding it', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const bodyFormatCalls = () => stringify.mock.calls.filter(
      ([value, replacer, space]) => typeof value === 'object'
        && value !== null
        && 'a' in value
        && (value as { a?: unknown }).a === 1
        && replacer === null
        && space === 2,
    ).length
    const view = render(<ToolRow {...rowProps} />)
    expect(bodyFormatCalls()).toBe(0)

    fireEvent.click(view.getByRole('button'))
    expect(bodyFormatCalls()).toBe(1)
    expect(view.getByText(/"a": 1/)).toBeTruthy()

    fireEvent.click(view.getByRole('button'))
    expect(bodyFormatCalls()).toBe(1)
    expect(view.queryByText(/"a": 1/)).toBeNull()
  })

  it('keeps the business icon across running and error states', () => {
    const runningView = render(<ToolRow {...rowProps} state="running" />)
    expect(runningView.queryByTestId('tool-icon')).not.toBeNull()
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    const errorView = render(<ToolRow {...rowProps} state="error" />)
    expect(errorView.container.querySelector('[data-testid="tool-icon"]')).not.toBeNull()
    expect(errorView.container.querySelector('[class*="chevronHover"]')).not.toBeNull()
  })

  it('non-expandable rows render a passive leading slot and no row button', () => {
    const view = render(<ToolRow {...rowProps} bodyRaw={null} />)
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
  })

  it('the row toggles from Enter and Space, ignoring other keys', () => {
    const view = render(<ToolRow {...rowProps} />)
    const row = view.getByRole('button')
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('file rows expand from the row while the path link opens without toggling', () => {
    const open = vi.fn()
    const view = render(
      <ToolRow {...rowProps} variant="read" title="Read" summary="src/a.ts" filePath="src/a.ts" onOpenFile={open} />,
    )
    const row = view.getByRole('button', { name: /Read/ })
    const path = view.getByText('src/a.ts')
    for (const key of ['Enter', ' ', 'Tab']) {
      fireEvent.keyDown(path, { key })
      expect(row.getAttribute('aria-expanded')).toBe('false')
    }
    // Path click opens the file and leaves the row collapsed.
    fireEvent.click(path)
    expect(open).toHaveBeenCalledWith('src/a.ts')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    // Row click (outside the link) expands the args body.
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/"a": 1/)).toBeTruthy()
  })

  it('a file path without onOpenFile renders a plain summary on an expandable row', () => {
    const view = render(
      <ToolRow {...rowProps} variant="write" title="Write" summary="作文.md" filePath="作文.md" />,
    )
    expect(view.container.querySelector('button')).toBeNull()
    const row = view.getByRole('button')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/"a": 1/)).toBeTruthy()
  })

  it('non-file rows do not open anything when the summary is clicked', () => {
    const open = vi.fn()
    const view = render(<ToolRow {...rowProps} onOpenFile={open} />)
    fireEvent.click(view.getByText('List files'))
    expect(open).not.toHaveBeenCalled()
  })

  it('an error row shows the failure first line in the collapsed summary and the full text expanded', () => {
    const view = render(
      <ToolRow {...rowProps} state="error" errorSummary="boom" output={'boom\ndetail'} />,
    )
    expect(view.getByText('boom')).toBeTruthy()
    expect(view.queryByText('List files')).toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText(/detail/)).toBeTruthy()
    expect(view.container.querySelector('[data-error]')).not.toBeNull()
  })

  it('an error row without an error summary keeps the args summary', () => {
    const view = render(<ToolRow {...rowProps} state="error" errorSummary={null} />)
    const summary = view.getByText('List files')
    expect(summary.parentElement?.className).toContain('errorSummary')
  })

  it('renders summarySuffix outside the ellipsized summary span, and drops it on a failure line', () => {
    const view = render(<ToolRow {...rowProps} summarySuffix="+2" />)
    const summary = view.getByText('List files')
    const suffix = view.getByText('+2')
    // Separate spans: .summary truncates, the suffix must not travel inside it.
    expect(summary.contains(suffix)).toBe(false)
    view.unmount()
    // The failure line replaces the summary wholesale, so the suffix goes with it.
    const failed = render(
      <ToolRow {...rowProps} state="error" errorSummary="boom" summarySuffix="+2" />,
    )
    expect(failed.queryByText('+2')).toBeNull()
  })

  it('an error file row drops the open-file link (the summary is failure prose, not the path)', () => {
    const open = vi.fn()
    const view = render(
      <ToolRow
        {...rowProps}
        variant="write" title="Write" state="error" errorSummary="cannot overwrite"
        filePath="src/a.ts" onOpenFile={open}
      />,
    )
    fireEvent.click(view.getByText('cannot overwrite'))
    expect(open).not.toHaveBeenCalled()
    // The failure line renders as plain text, not the underlined link button.
    expect(view.container.querySelector('[class*="fileLink"]')).toBeNull()
  })

  it('the expanded body carries a hover Inspect pill that fires the callback', () => {
    const inspect = vi.fn()
    const view = render(<ToolRow {...rowProps} inspect={inspect} />)
    // Collapsed: no pill.
    expect(view.queryByText('查看')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /Bash/ }))
    const pill = view.getByText('查看')
    fireEvent.click(pill)
    expect(inspect).toHaveBeenCalledTimes(1)
    // The pill click must not collapse the row (body is a .row sibling).
    expect(view.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('no inspect callback, no pill', () => {
    const view = render(<ToolRow {...rowProps} />)
    fireEvent.click(view.getByRole('button'))
    expect(view.queryByText('查看')).toBeNull()
  })

  it('the expanded card gutter-labels each section it carries (IN / OUT)', () => {
    const both = render(<ToolRow {...rowProps} output="result text" />)
    fireEvent.click(both.getByRole('button'))
    expect(both.getByText('输入')).toBeTruthy()
    expect(both.getByText('输出')).toBeTruthy()
    expect(both.getByText('result text')).toBeTruthy()
    cleanup()
    const inputOnly = render(<ToolRow {...rowProps} />)
    fireEvent.click(inputOnly.getByRole('button'))
    expect(inputOnly.getByText('输入')).toBeTruthy()
    expect(inputOnly.queryByText('输出')).toBeNull()
    cleanup()
    const outputOnly = render(<ToolRow {...rowProps} bodyRaw={null} output="only out" />)
    fireEvent.click(outputOnly.getByRole('button'))
    expect(outputOnly.queryByText('输入')).toBeNull()
    expect(outputOnly.getByText('输出')).toBeTruthy()
    expect(outputOnly.getByText('only out')).toBeTruthy()
  })

  const sampleImage = { attachment: { attachmentId: 'sha256:g1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  const claimed = (
    renderImages: ToolRowResultImages['render'],
    images: readonly unknown[] = [sampleImage],
  ): ToolRowResultImages => ({ images: images as never, text: '{"type": "image"}', render: renderImages })

  it('renders the generic-row gallery below the output text inside the IO card', () => {
    const renderResultImages = vi.fn((owner: { images: readonly unknown[]; align: 'start' | 'end' }) => (
      <div data-testid="gallery">{owner.images.length}</div>
    ))
    const view = render(
      <ToolRow
        {...rowProps}
        bodyRaw={null}
        output="took a screenshot"
        resultImages={claimed(renderResultImages)}
      />,
    )
    expect(view.queryByTestId('gallery')).toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(renderResultImages).toHaveBeenCalledWith({ images: [sampleImage], align: 'start' }, expect.anything())
    const gallery = view.getByTestId('gallery')
    expect(gallery.textContent).toBe('1')
    // The gallery sits inside the same IO card, after the OUT section.
    const ioCard = view.container.querySelector('[class*="ioCard"]')
    expect(ioCard?.contains(gallery)).toBe(true)
    const output = view.getByText('took a screenshot')
    const position = gallery.compareDocumentPosition(output)
    expect(Boolean(position & Node.DOCUMENT_POSITION_PRECEDING)).toBe(true)
  })

  it('an image-only result (no args body, no output text) is still expandable', () => {
    const renderResultImages = vi.fn(() => <div data-testid="gallery" />)
    const view = render(
      <ToolRow
        {...rowProps}
        bodyRaw={null}
        output={null}
        resultImages={claimed(renderResultImages)}
      />,
    )
    expect(view.container.querySelector('[aria-expanded]')).not.toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(view.getByTestId('gallery')).toBeTruthy()
  })

  it('shows the omitted image JSON in the gallery position when no attachment plugin fills the slot', () => {
    const view = render(
      <ToolRow
        {...rowProps}
        bodyRaw={null}
        output="took a screenshot"
        resultImages={claimed((_owner, fallback) => fallback)}
      />,
    )
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText('took a screenshot')).toBeTruthy()
    expect(view.getByText('{"type": "image"}')).toBeTruthy()
  })

  it('an empty, null, or absent resultImages renders no gallery', () => {
    const renderResultImages = vi.fn(() => <div data-testid="gallery" />)
    for (const resultImages of [claimed(renderResultImages, []), null, undefined]) {
      const view = render(<ToolRow {...rowProps} resultImages={resultImages} />)
      fireEvent.click(view.getByRole('button'))
      expect(view.queryByTestId('gallery')).toBeNull()
      cleanup()
    }
    expect(renderResultImages).not.toHaveBeenCalled()
  })

  it('accepts a claimed gallery only with its fallback text and dispatcher (compile-time; body never runs)', () => {
    const negatives = (renderImages: ToolRowResultImages['render']) => [
      // @ts-expect-error without its text, an unfilled slot would show nothing for images `output` omitted
      <ToolRow key="text" {...rowProps} resultImages={{ images: [], render: renderImages }} />,
      // @ts-expect-error without its dispatcher, the images `output` omitted would render nowhere
      <ToolRow key="render" {...rowProps} resultImages={{ images: [], text: '' }} />,
    ]
    expect(negatives).toBeTypeOf('function')
  })
})

describe('GenericToolCard', () => {
  const props = (toolName: string, block: StartedToolCall | ToolResultNode): GenericToolCardProps => ({
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    useDisclosure, callId: 'c1', toolName, ...('kind' in block ? { phase: 'result' as const, block: block } : { phase: block.phase, block: block }), openFile: vi.fn(), t,
  })

  it('renders the classified variant row from the frozen slice', () => {
    const view = render(<GenericToolCard {...props('bash', result())} />)
    expect(view.getByText('运行命令')).toBeTruthy()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="bash"]')).not.toBeNull()
  })

  it.each([
    'bash', 'read', 'grep', 'write', 'run_code', 'unknown_tool',
  ] as const)('keeps the %s business family artwork on failure', (toolName) => {
    const failed = result({
      call: { name: toolName, argsRaw: '{}' },
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    })
    const view = render(<GenericToolCard {...props(toolName, failed)} />)
    const root = view.container.querySelector(`[data-tool="${toolName}"]`)!
    expect(root.querySelector('[data-disclosure-row] > :first-child svg')).not.toBeNull()
    expect(root.querySelector('[data-state]')).toBeNull()
  })

  it('unknown tools land on the others variant titled Tool call', () => {
    const view = render(
      <GenericToolCard {...props('custom_tool', running({ name: 'custom_tool', argsRaw: '{"note":"x"}' }))} />,
    )
    expect(view.getByText('工具调用')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('renders edit with its dedicated title, icon variant, and path summary', () => {
    const view = render(
      <GenericToolCard {...props('edit', running({
        name: 'edit',
        argsRaw: '{"file_path":"src/x.ts","old_string":"before","new_string":"after"}',
      }))} />,
    )
    expect(view.getByText('编辑')).toBeTruthy()
    expect(view.getByText('src/x.ts')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="edit"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('renders write with its dedicated title, icon variant, and path summary', () => {
    const view = render(
      <GenericToolCard {...props('write', running({
        name: 'write',
        argsRaw: '{"file_path":"src/x.ts","content":"hello"}',
      }))} />,
    )
    expect(view.getByText('写入')).toBeTruthy()
    expect(view.getByText('src/x.ts')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="write"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('passes the owner inspect callback through to the expanded row pill', () => {
    const inspect = vi.fn()
    const view = render(<GenericToolCard {...props('bash', result())} inspect={inspect} />)
    fireEvent.click(view.getByRole('button', { name: /运行命令/ }))
    fireEvent.click(view.getByText('查看'))
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('file-path summary click reaches openFile; bash summary does not', () => {
    const file = props('read', running({ name: 'read', argsRaw: '{"path":"src/x.ts"}' }))
    const fileView = render(<GenericToolCard {...file} />)
    fireEvent.click(fileView.getByText('src/x.ts'))
    expect(file.openFile).toHaveBeenCalledWith('src/x.ts')

    const bash = props('bash', result())
    const bashView = render(<GenericToolCard {...bash} />)
    fireEvent.click(bashView.getByText('List files'))
    expect(bash.openFile).not.toHaveBeenCalled()
  })

  it('renders a nested Auto denial as one localized OUT line without formatting its input', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const denied = result({
      parentCallId: 'outer',
      call: { name: 'mystery', argsRaw: '{"path":"secret"}' },
      content: [{ type: 'text', text: 'Tool execution rejected by user' }],
      isError: true,
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: '  scope\r\nwas not authorized  ' },
    })
    const view = render(<GenericToolCard {...props('mystery', denied)} />)
    expect(view.getByText('Auto review 已拒绝')).toBeTruthy()
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText('工具未执行。原因：scope was not authorized')).toBeTruthy()
    expect(view.queryByText('输入')).toBeNull()
    expect(view.getAllByText('输出')).toHaveLength(1)
    expect(stringify.mock.calls.some(([value]) => (
      typeof value === 'object' && value !== null && 'path' in value
    ))).toBe(false)
    expect(view.queryByText('Tool execution rejected by user')).toBeNull()
    expect(view.queryByText(/"path"/)).toBeNull()
  })

  it('claims a well-formed image block into the gallery and skips it from the output text', () => {
    const sampleImage = {
      attachmentId: 'sha256:g1', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const renderResultImages = vi.fn((owner: { images: readonly unknown[]; align: 'start' | 'end' }) => (
      <div data-testid="gallery">{owner.align}</div>
    ))
    const settled = result({
      call: { name: 'mcp_screenshot', argsRaw: '{}' },
      content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', attachment: sampleImage } as never],
    })
    const view = render(
      <GenericToolCard {...props('mcp_screenshot', settled)} renderResultImages={renderResultImages} />,
    )
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText('took a screenshot')).toBeTruthy()
    expect(view.queryByText(/"attachmentId"/)).toBeNull()
    expect(renderResultImages).toHaveBeenCalledWith({ images: [{ attachment: sampleImage }], align: 'start' }, expect.anything())
    expect(view.getByTestId('gallery')).toBeTruthy()
  })

  it('keeps a malformed image block as ordinary JSON output and renders no gallery', () => {
    const badAttachment = { attachmentId: '', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    const renderResultImages = vi.fn(() => <div data-testid="gallery" />)
    const settled = result({
      call: { name: 'mcp_screenshot', argsRaw: '{}' },
      content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', attachment: badAttachment } as never],
    })
    const view = render(
      <GenericToolCard {...props('mcp_screenshot', settled)} renderResultImages={renderResultImages} />,
    )
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText(/"attachmentId": ""/)).toBeTruthy()
    expect(renderResultImages).not.toHaveBeenCalled()
    expect(view.queryByTestId('gallery')).toBeNull()
  })

  it('renders images on an error result alongside its unchanged error first line', () => {
    const sampleImage = {
      attachmentId: 'sha256:g2', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const renderResultImages = vi.fn(() => <div data-testid="gallery" />)
    const failed = result({
      call: { name: 'mcp_screenshot', argsRaw: '{}' },
      isError: true,
      content: [{ type: 'text', text: 'capture failed' }, { type: 'image', attachment: sampleImage } as never],
    })
    const view = render(
      <GenericToolCard {...props('mcp_screenshot', failed)} renderResultImages={renderResultImages} />,
    )
    expect(view.getByText('capture failed')).toBeTruthy()
    fireEvent.click(view.getByRole('button'))
    expect(renderResultImages).toHaveBeenCalledWith({ images: [{ attachment: sampleImage }], align: 'start' }, expect.anything())
    expect(view.getByTestId('gallery')).toBeTruthy()
  })

  it('without renderResultImages, a well-formed image block stays in the output JSON and renders no gallery', () => {
    const sampleImage = {
      attachmentId: 'sha256:g3', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const settled = result({
      call: { name: 'mcp_screenshot', argsRaw: '{}' },
      content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', attachment: sampleImage } as never],
    })
    const view = render(<GenericToolCard {...props('mcp_screenshot', settled)} />)
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText(/took a screenshot/)).toBeTruthy()
    expect(view.getByText(/"attachmentId": "sha256:g3"/)).toBeTruthy()
  })
})
