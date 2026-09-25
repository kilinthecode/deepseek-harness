/** Portal brand dictionaries. */

/** Locale namespace owned by the Portal brand occupants. */
export const NS = 'portal-brand'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  portal: 'PORTAL',
} satisfies Record<string, string>

/** The Portal brand key union. */
export type PortalBrandKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  portal: 'PORTAL',
} satisfies Record<PortalBrandKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Portal brand copy. */
    'portal-brand': PortalBrandKey
  }
}
