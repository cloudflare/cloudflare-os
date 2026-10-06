// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { I18nProvider, useI18n } from './I18nProvider'
import { LOCALE_STORAGE_KEY } from './runtime'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  window.localStorage.clear()
})

const LanguageControls = () => {
  const { t, setLocale } = useI18n()
  return <>
    <output>{t('common.save')}</output>
    <button onClick={() => setLocale('ko')}>한국어</button>
  </>
}

const mount = () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<I18nProvider><LanguageControls /></I18nProvider>))
}

it('updates visible copy, document language and the saved preference immediately', () => {
  mount()
  expect(container!.querySelector('output')!.textContent).toBe('Save')
  act(() => container!.querySelector('button')!.click())
  expect(container!.querySelector('output')!.textContent).toBe('저장')
  expect(document.documentElement.lang).toBe('ko')
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko')
})

it('applies a preference changed in another browser tab', () => {
  mount()
  act(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ko')
    window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'ko' }))
  })
  expect(container!.querySelector('output')!.textContent).toBe('저장')
  expect(document.documentElement.lang).toBe('ko')
})
