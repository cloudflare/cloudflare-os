// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, UnreadStateSubscriber, UserUnreadState } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuthenticatedApi } from '../../AuthContext'
import { NativeAppBridge } from './NativeAppBridge'
import { inNativeApp, returnToInstalls } from './nativeApp'
import { UnreadStateBridge } from '../notifications/UnreadStateBridge'

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

  it('reports login again only after the reconnected session confirms its identity', async () => {
    const loginReady = vi.fn<() => void>()
    const sessionEnded = vi.fn<() => void>()
    const nextIdentity = pendingWhoami()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      sessionEnded,
      returnToInstalls: vi.fn<() => void>(),
    })
    const firstApi = apiWithWhoami(async () => ({ ...user }))
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
    expect(sessionEnded).not.toHaveBeenCalled()
    // A real RPC call materializes a fresh profile object for the new connection.
    await act(async () => nextIdentity.resolve({ ...user }))
    expect(loginReady).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })

  it('clears the native session only after a confirmed non-user identity', async () => {
    const identity = pendingWhoami()
    const sessionEnded = vi.fn<() => void>()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true, loginReady: vi.fn<() => void>(), sessionEnded,
      returnToInstalls: vi.fn<() => void>(),
    })
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(() => identity.promise)} onLogout={() => {}}>
        <NativeAppBridge />
      </AuthProvider>
    ))
    expect(sessionEnded).not.toHaveBeenCalled()
    await act(async () => identity.resolve({type: 'agent', id: 'agent', name: 'Agent'}))
    expect(sessionEnded).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it('does not let a failed optional native bridge prevent logout', async () => {
    const logoutError = new Error('native bridge unavailable')
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true, loginReady: vi.fn<() => void>(),
      sessionEnded: () => { throw logoutError }, returnToInstalls: vi.fn<() => void>(),
    })
    let logout!: () => void
    const CaptureLogout = () => { logout = useAuthenticatedApi().logout; return null }
    const onLogout = vi.fn<() => void>()
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(async () => user)} onLogout={onLogout}>
        <CaptureLogout />
      </AuthProvider>
    ))
    expect(() => logout()).not.toThrow()
    expect(onLogout).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it.each([user, {type: 'agent', id: 'agent', name: 'Agent'}] satisfies AiChatAuthorInfo[])(
    'keeps the app mounted when the native identity callback throws for $type', async identity => {
      const unavailable = vi.fn<() => void>(() => { throw new Error('native bridge unavailable') })
      vi.stubGlobal('cloudflareOSNative', {
        version: 1, isAvailable: () => true, loginReady: unavailable, sessionEnded: unavailable,
        returnToInstalls: vi.fn<() => void>(),
      })
      const container = document.createElement('div')
      const root = createRoot(container)
      await act(async () => root.render(
        <AuthProvider authenticatedApi={apiWithWhoami(async () => identity)} onLogout={() => {}}>
          <NativeAppBridge /><span>App content</span>
        </AuthProvider>
      ))
      expect(unavailable).toHaveBeenCalledOnce()
      expect(container.textContent).toBe('App content')
      act(() => root.unmount())
    },
  )

  it('forwards a snapshot that arrived before login confirmation, in login-then-badge order', async () => {
    const identity = pendingWhoami()
    const calls: string[] = []
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true,
      loginReady: () => calls.push('login'), unreadStateChanged: () => calls.push('badge'),
      returnToInstalls: () => {},
    })
    let subscriber!: RpcStub<UnreadStateSubscriber>
    const api = {...apiWithWhoami(() => identity.promise),
      subscribeToUnreadState: (value: RpcStub<UnreadStateSubscriber>) => {
        subscriber = value
        return Object.assign(Promise.resolve(), {[Symbol.dispose]: () => {}})
      },
    } as unknown as RpcStub<AuthenticatedApi>
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(
      <AuthProvider authenticatedApi={api} onLogout={() => {}}>
        <UnreadStateBridge authenticatedApi={api}><NativeAppBridge /></UnreadStateBridge>
      </AuthProvider>
    ))
    const state: UserUnreadState = {unreadMessageCount: 8, unreadChatCount: 1, chats: []}
    await act(async () => subscriber.updated(state))
    expect(calls).toEqual([])
    await act(async () => identity.resolve(user))
    expect(calls).toEqual(['login', 'badge'])
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
