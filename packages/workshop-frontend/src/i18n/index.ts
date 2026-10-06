export type { Locale, MessageTree, TranslateVars } from './types'
export { LOCALES } from './types'
export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  applyDocumentLang,
  getBrowserLocale,
  getCatalog,
  getLocale,
  readLocale,
  setLocale,
  translate,
  writeLocale,
} from './runtime'
export { I18nProvider, useI18n, useT } from './I18nProvider'
/** Alias for older partial wiring. */
export { I18nProvider as LocaleProvider } from './I18nProvider'

export { localizeBlueprintDisplay, localizeVendorDisplay, localizeFormatOutput, localizeAccountDisplayName, localizeGatekeeperAppTitle, localizeSupportedResource, tOr } from './localizeDisplay'
