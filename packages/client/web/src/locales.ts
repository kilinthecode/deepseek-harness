/**
 * Pre-locale product copy for the boot page.
 *
 * The boot page mounts before the client locale plugin activates and stays on
 * screen when that plugin is one of the failures it reports, so it cannot take
 * the typed `t` seat. This dictionary owns the copy for that window instead of
 * leaving literals in the view, and the language is chosen from the document
 * and browser rather than from the user's saved setting.
 * @module @deepseek-ai/dsh-client-web/src/locales
 */

/** Product copy the boot page renders before the locale plugin can own it. */
export type BootCopyKey = 'brandName' | 'pluginsLoading' | 'pluginsFailed'

/** Already-localized boot copy handed to the boot page as a prop. */
export type BootCopy = Record<BootCopyKey, string>

/** English boot copy; the key source every other locale is checked against. */
const en = {
  brandName: 'Portal Harness',
  pluginsLoading: 'Loading plugins…',
  pluginsFailed: 'Failed to load plugins',
} satisfies Record<BootCopyKey, string>

/** Simplified Chinese boot copy. */
const zh: Record<BootCopyKey, string> = {
  brandName: 'Portal Harness',
  pluginsLoading: '正在加载插件…',
  pluginsFailed: '插件加载失败',
}

/**
 * Resolve boot copy for a BCP 47 language tag.
 * @param lang - Document or browser language; any `zh` variant selects Simplified Chinese.
 * @returns The copy set for `lang`, falling back to English.
 */
export function bootCopyFor(lang: string): Record<BootCopyKey, string> {
  return lang.toLowerCase().startsWith('zh') ? zh : en
}

/**
 * Resolve boot copy for the current document.
 * @returns The copy set matching `document.documentElement.lang` or the browser language.
 */
export function bootCopy(): Record<BootCopyKey, string> {
  return bootCopyFor(document.documentElement.lang || navigator.language)
}
