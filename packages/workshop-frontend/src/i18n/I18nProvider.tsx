import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import {
  LOCALE_STORAGE_KEY,
  applyDocumentLang,
  getLocale,
  setLocale as persistLocale,
  translate,
  type Locale,
  type TranslateVars,
} from './runtime'

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, vars?: TranslateVars) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function getInitialLocale(): Locale {
  const locale = getLocale()
  applyDocumentLang(locale)
  return locale
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale)

  useEffect(() => {
    applyDocumentLang(locale)
  }, [locale])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return
      const next = getLocale()
      setLocaleState((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setLocale = useCallback((next: Locale) => {
    persistLocale(next)
    applyDocumentLang(next)
    setLocaleState(next)
  }, [])

  const t = useCallback(
    (key: string, vars?: TranslateVars) => translate(locale, key, vars),
    [locale],
  )

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used within I18nProvider')
  return context
}

/** Convenience hook: translator bound to the active locale. */
export function useT() {
  return useI18n().t
}
