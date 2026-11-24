// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from '@gadgets/workshop-shared/feature-flags'
import { switchToNextUi } from './useNextUiSwitch'

const NEXT_UI_COOKIE = `${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}`

const clearCookie = () => {
  document.cookie = `${NEXT_UI_COOKIE}; Path=/; Max-Age=0`
}

describe('switchToNextUi', () => {
  afterEach(() => {
    clearCookie()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('sets the cookie and reloads', () => {
    const reload = vi.fn<() => void>()
    switchToNextUi(reload)
    expect(document.cookie).toContain(NEXT_UI_COOKIE)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads at most once per tab, even where the cookie does not stick', () => {
    const reload = vi.fn<() => void>()
    switchToNextUi(reload)
    clearCookie()
    switchToNextUi(reload)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does nothing when the cookie is already set', () => {
    document.cookie = `${NEXT_UI_COOKIE}; Path=/`
    const reload = vi.fn<() => void>()
    switchToNextUi(reload)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does nothing without sessionStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const reload = vi.fn<() => void>()
    switchToNextUi(reload)
    expect(document.cookie).not.toContain(NEXT_UI_COOKIE)
    expect(reload).not.toHaveBeenCalled()
  })
})
