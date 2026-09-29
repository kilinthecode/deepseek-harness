// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootCopy, bootCopyFor } from '../src/locales.ts'

afterEach(() => {
  document.documentElement.lang = ''
  vi.unstubAllGlobals()
})

describe('bootCopyFor', () => {
  it('selects English for a non-Chinese tag', () => {
    expect(bootCopyFor('en').pluginsLoading).toBe('Loading plugins…')
    expect(bootCopyFor('fr-FR').pluginsFailed).toBe('Failed to load plugins')
  })

  it('selects Simplified Chinese for any zh variant', () => {
    expect(bootCopyFor('zh').pluginsLoading).toBe('正在加载插件…')
    expect(bootCopyFor('zh-CN').pluginsFailed).toBe('插件加载失败')
    expect(bootCopyFor('ZH-Hant').pluginsLoading).toBe('正在加载插件…')
  })

  it('keeps the product name identical across locales', () => {
    expect(bootCopyFor('zh-CN').brandName).toBe(bootCopyFor('en').brandName)
  })
})

describe('bootCopy', () => {
  it('follows the document language', () => {
    document.documentElement.lang = 'zh-CN'
    expect(bootCopy().pluginsFailed).toBe('插件加载失败')
  })

  it('falls back to the browser language when the document has none', () => {
    document.documentElement.lang = ''
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    expect(bootCopy().pluginsFailed).toBe('插件加载失败')
  })
})
