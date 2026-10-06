/** Supported UI locales. English is the source/default. */
export type Locale = 'en' | 'ko'

export const LOCALES: readonly Locale[] = ['en', 'ko'] as const

/** Nested message catalog shape (string leaves only). */
export type MessageTree = { readonly [key: string]: string | MessageTree }

export type TranslateVars = Record<string, string | number>
