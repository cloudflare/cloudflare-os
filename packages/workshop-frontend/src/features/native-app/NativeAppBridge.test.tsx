// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../AuthContext'
import { NativeAppBridge } from './NativeAppBridge'
import { inNativeApp, returnToInstalls } from './nativeApp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user: AiChatAuthorInfo = { type: 'user', id: 'tester@example.com', name: 'Tester' }

const pendingWhoami = () => {
  let resolve!: (info: AiChatAuthorInfo) => void
  let reject!: (error: Error) => void
  const promise = new Promise<AiChatAuthorInfo>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const apiWithWhoami = (whoami: () => Promise<AiChatAuthorInfo>) => ({
  whoami,
  amIAdmin: async () => false,
}) as RpcStub<AuthenticatedApi>

describe('native app bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports login only after whoami confirms a user, then uses the versioned native object for navigation', async () => {
    const loginReady = vi.fn<() => void>()
    const returnHome = vi.fn<() => void>()
    const identity = pendingWhoami()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: returnHome,
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(() => identity.promise)} onLogout={() => {}}>
        <NativeAppBridge />
      </AuthProvider>
    ))

    expect(inNativeApp()).toBe(true)
    expect(loginReady).not.toHaveBeenCalled()
    await act(async () => identity.resolve(user))
    expect(loginReady).toHaveBeenCalledOnce()
    returnToInstalls()
    expect(returnHome).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it('does not report login when authentication is rejected', async () => {
    const loginReady = vi.fn<() => void>()
    const identity = pendingWhoami()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: vi.fn<() => void>(),
    })
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(() => identity.promise)} onLogout={() => {}}>
        <NativeAppBridge />
      </AuthProvider>
    ))

    await act(async () => identity.reject(new Error('session expired')))
    expect(loginReady).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('does not reuse a prior confirmed identity while a new session is pending', async () => {
    const loginReady = vi.fn<() => void>()
    const nextIdentity = pendingWhoami()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: vi.fn<() => void>(),
    })
    const firstApi = apiWithWhoami(async () => user)
    const nextApi = apiWithWhoami(() => nextIdentity.promise)
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(
      <AuthProvider authenticatedApi={firstApi} onLogout={() => {}}>
        <NativeAppBridge />
      </AuthProvider>
    ))
    expect(loginReady).toHaveBeenCalledOnce()

    await act(async () => root.render(
      <AuthProvider authenticatedApi={nextApi} onLogout={() => {}}>
        <NativeAppBridge />
      </AuthProvider>
    ))
    expect(loginReady).toHaveBeenCalledOnce()
    await act(async () => nextIdentity.resolve(user))
    expect(loginReady).toHaveBeenCalledTimes(2)
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
