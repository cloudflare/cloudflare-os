// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAppBridge } from './NativeAppBridge'
import { inNativeApp, returnToInstalls } from './nativeApp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native app bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses only the versioned native object for login and navigation', async () => {
    const loginReady = vi.fn<() => void>()
    const returnHome = vi.fn<() => void>()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: returnHome,
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<NativeAppBridge />))

    expect(inNativeApp()).toBe(true)
    expect(loginReady).toHaveBeenCalledOnce()
    returnToInstalls()
    expect(returnHome).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it('ignores malformed, unavailable, and legacy-only bridges', () => {
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => false,
      loginReady: vi.fn<() => void>(),
      returnToInstalls: vi.fn<() => void>(),
    })
    vi.stubGlobal('webkit', { messageHandlers: { cloudflareOSLoginReady: {} } })
    expect(inNativeApp()).toBe(false)
  })
})
