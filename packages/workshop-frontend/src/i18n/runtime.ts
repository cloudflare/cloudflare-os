import en from './en'
import ko from './ko'
import type { Locale, MessageTree, TranslateVars } from './types'
export type { Locale, MessageTree, TranslateVars } from './types'
export { LOCALES } from './types'

export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'cfos.locale'

const catalogs: Record<Locale, MessageTree> = { en, ko }

function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'ko'
}

export function getBrowserLocale(): Locale | null {
  try {
    const candidates = [...(navigator.languages ?? []), navigator.language].filter(
      Boolean,
    ) as string[]
    for (const raw of candidates) {
      const lower = raw.toLowerCase()
      if (lower === 'ko' || lower.startsWith('ko-')) return 'ko'
      if (lower === 'en' || lower.startsWith('en-')) return 'en'
    }
  } catch {
    // Ignore (SSR / locked-down environments).
  }
  return null
}

/** Read persisted locale, then browser preference, else English. */
export function getLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // Ignore storage failures.
  }
  return getBrowserLocale() ?? DEFAULT_LOCALE
}

/** @deprecated Prefer getLocale() */
export const readLocale = getLocale

export function setLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Ignore; session still applies.
  }
}

/** @deprecated Prefer setLocale() */
export const writeLocale = setLocale

export function applyDocumentLang(locale: Locale): void {
  try {
    document.documentElement.lang = locale
  } catch {
    // Ignore.
  }
}

function lookup(dict: MessageTree, path: string): string | undefined {
  const parts = path.split('.')
  let cur: string | MessageTree | undefined = dict
  for (const part of parts) {
    if (cur == null || typeof cur === 'string') return undefined
    cur = cur[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

/** Resolve key with `{name}` interpolation; falls back to English then the key. */
export function translate(locale: Locale, key: string, vars?: TranslateVars): string {
  const raw =
    lookup(catalogs[locale], key) ??
    (locale !== 'en' ? lookup(catalogs.en, key) : undefined) ??
    key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] != null ? String(vars[name]) : `{${name}}`,
  )
}

export function getCatalog(locale: Locale): MessageTree {
  return catalogs[locale]
}
