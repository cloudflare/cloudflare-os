// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { inMobileApp, reportLoginReady, returnToInstalls } from './mobileAppNavigation'

describe('mobile app navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the versioned native object without URL or storage markers', () => {
    const loginReady = vi.fn<() => void>()
    const returnHome = vi.fn<() => void>()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: returnHome,
    })

    expect(inMobileApp()).toBe(true)
    reportLoginReady()
    returnToInstalls()
    expect(loginReady).toHaveBeenCalledOnce()
    expect(returnHome).toHaveBeenCalledOnce()
  })

  it('supports the legacy native handler during app upgrades', () => {
    const postMessage = vi.fn<(message: { type: string }) => void>()
    vi.stubGlobal('webkit', { messageHandlers: { cloudflareOSLoginReady: { postMessage } } })

    expect(inMobileApp()).toBe(true)
    reportLoginReady()
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('ignores malformed or unavailable native objects', () => {
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => false,
      loginReady: vi.fn<() => void>(),
      returnToInstalls: vi.fn<() => void>(),
    })
    expect(inMobileApp()).toBe(false)
  })
})
