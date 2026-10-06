// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyDocumentLang, getBrowserLocale, getLocale, LOCALE_STORAGE_KEY,
  setLocale, translate,
} from './runtime'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  document.documentElement.lang = 'en'
})

const browserLanguages = (languages: string[]) => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '')
}

describe('locale selection', () => {
  it('honors a saved choice before the browser preference', () => {
    browserLanguages(['ko-KR'])
    setLocale('en')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
    expect(getLocale()).toBe('en')
  })

  it('uses the first supported browser language, including regional variants', () => {
    browserLanguages(['fr-FR', 'ko-KR', 'en-US'])
    expect(getBrowserLocale()).toBe('ko')
    expect(getLocale()).toBe('ko')
  })

  it('falls back to English for unsupported languages and invalid saved values', () => {
    browserLanguages(['fr-FR'])
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'unsupported')
    expect(getLocale()).toBe('en')
  })

  it('still selects a locale when browser storage is blocked', () => {
    browserLanguages(['ko-KR'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => setLocale('ko')).not.toThrow()
    expect(getLocale()).toBe('ko')
  })
})

describe('message lookup', () => {
  it('renders Korean UI copy and updates the document language', () => {
    expect(translate('ko', 'common.save')).toBe('저장')
    applyDocumentLang('ko')
    expect(document.documentElement.lang).toBe('ko')
  })

  it('interpolates values without reinterpreting their contents', () => {
    expect(translate('en', 'observerModal.accountFallback', { id: 42 })).toBe('Account 42')
    expect(translate('ko', 'observerModal.accountFallback', { id: 42 })).toContain('42')
    expect(translate('en', 'observerModal.accountFallback', { id: '{other}' })).toBe('Account {other}')
  })

  it('preserves unresolved variables and exposes missing keys', () => {
    expect(translate('en', 'observerModal.accountFallback')).toBe('Account {id}')
    expect(translate('ko', 'unknown.message')).toBe('unknown.message')
  })
})
