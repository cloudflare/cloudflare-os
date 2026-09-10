// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthVendorInfo, LoginAttempt, PublicApi } from '@gadgets/workshop-shared/api'
import { HANDOFF_KEY } from '../../connectHandoff'
import OAuthButtons from './OAuthButtons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VENDORS: AuthVendorInfo[] = [{ vendorId: 'github', displayName: 'GitHub' }]
const NONCE = 'b'.repeat(64)
const URL = 'https://gk.example/login'
const FEATURES = 'popup,width=520,height=680'
const TOKEN = 'alice@example.com:secret'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

// Lets pending promises and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
// One receive() poll tick.
const tick = () => act(() => vi.advanceTimersByTimeAsync(1000))

// A popup as window.open returns it: opened blank with its own storage, disowned, then navigated.
function fakePopup() {
  const store = new Map<string, string>()
  const popup = {
    closed: false,
    close: vi.fn<() => void>(),
    opener: window as Window | null,
    openerAtReplace: undefined as Window | null | undefined,
    sessionStorage: {
      store,
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => { store.set(key, value) }),
    },
    location: {
      replace: vi.fn<(url: string) => void>(() => { popup.openerAtReplace = popup.opener }),
    },
  }
  return popup
}

describe('OAuthButtons', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const receive = vi.fn<() => Promise<string | null>>()
  const attempt = { receive, [Symbol.dispose]() {} } as unknown as RpcStub<LoginAttempt>
  const rpcStub = {
    startGatekeeperLogin: async () => ({ url: URL, nonce: NONCE, attempt }),
  } as unknown as RpcStub<PublicApi>

  function mount(stub: RpcStub<PublicApi> = rpcStub, onSuccess = vi.fn<() => void>()) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<OAuthButtons rpcStub={stub} vendors={VENDORS} onSuccess={onSuccess} />))
    return onSuccess
  }

  const button = () => container!.querySelector('button')!
  const clickSignIn = () => act(async () => { button().click() })

  beforeEach(() => { vi.useFakeTimers() })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    receive.mockReset()
    localStorage.clear()
  })

  it('opens a fresh disowned popup carrying the nonce, then navigates it', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    receive.mockResolvedValue(null)
    mount()

    await clickSignIn()
    await settle()

    expect(open).toHaveBeenCalledExactlyOnceWith('', expect.stringMatching(/^gatekeeper-login-/), FEATURES)
    expect(open.mock.calls[0][2]).not.toContain('noopener')
    expect(popup.openerAtReplace).toBeNull()
    expect(popup.sessionStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      HANDOFF_KEY, JSON.stringify({ kind: 'login', nonce: NONCE }))
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(URL)
    // The nonce is written while the popup is still our about:blank, before the navigation.
    expect(popup.sessionStorage.setItem.mock.invocationCallOrder[0])
      .toBeLessThan(popup.location.replace.mock.invocationCallOrder[0])
    expect(button().disabled).toBe(true)
  })

  it('keeps the button pending while receive() answers null', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    receive.mockResolvedValue(null)
    const onSuccess = mount()

    await clickSignIn()
    await settle()
    await tick()
    await tick()

    expect(receive).toHaveBeenCalledTimes(2)
    expect(button().disabled).toBe(true)
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('stores the token receive() releases, closes the popup and stops polling', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    receive.mockResolvedValueOnce(null).mockResolvedValueOnce(TOKEN)
    const onSuccess = mount()

    await clickSignIn()
    await settle()
    await tick()
    expect(onSuccess).not.toHaveBeenCalled()
    await tick()

    expect(localStorage.getItem('authToken')).toBe(TOKEN)
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(popup.close).toHaveBeenCalled()
    await tick()
    await tick()
    expect(receive).toHaveBeenCalledTimes(2)
  })

  it('shows the failure and hands the buttons back when receive() rejects', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    receive.mockRejectedValue(new Error('This sign-in attempt has expired.'))
    const onSuccess = mount()

    await clickSignIn()
    await settle()
    await tick()

    expect(container!.textContent).toContain('This sign-in attempt has expired.')
    expect(button().disabled).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    await tick()
    expect(receive).toHaveBeenCalledOnce()
  })

  it('hands the buttons back when the popup reports closed, but keeps polling', async () => {
    // The popup closes itself after confirming, and a provider that swaps browsing context groups
    // (COOP) reports it closed while the flow is still running: neither is a cancellation.
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    receive.mockResolvedValue(null)
    const onSuccess = mount()

    await clickSignIn()
    await settle()
    expect(button().disabled).toBe(true)

    popup.closed = true
    await tick()
    expect(button().disabled).toBe(false)
    expect(container!.textContent).not.toMatch(/cancelled|Could not/)

    receive.mockResolvedValue(TOKEN)
    await tick()
    expect(localStorage.getItem('authToken')).toBe(TOKEN)
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('tears down the first attempt when a second sign-in starts after its popup reported closed', async () => {
    // The buttons come back while the first attempt still polls, so a second click is the natural
    // next move; only the newest attempt may then be listening, or the abandoned one could land a
    // token behind the user's back.
    const first = fakePopup()
    const second = fakePopup()
    vi.spyOn(window, 'open')
      .mockReturnValueOnce(first as unknown as Window)
      .mockReturnValueOnce(second as unknown as Window)
    const receiveFirst = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
    const receiveSecond = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
    const disposeFirst = vi.fn<() => void>()
    const attempts = [
      { receive: receiveFirst, [Symbol.dispose]: disposeFirst },
      { receive: receiveSecond, [Symbol.dispose]() {} },
    ]
    const stub = {
      startGatekeeperLogin: async () => ({ url: URL, nonce: NONCE, attempt: attempts.shift() }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(stub)

    await clickSignIn()
    await settle()
    first.closed = true
    await tick()
    expect(button().disabled).toBe(false)
    expect(receiveFirst).toHaveBeenCalledOnce()

    await clickSignIn()
    await settle()
    expect(disposeFirst).toHaveBeenCalledOnce()
    expect(second.location.replace).toHaveBeenCalledExactlyOnceWith(URL)

    receiveFirst.mockResolvedValue(TOKEN)
    await tick()
    await tick()
    expect(receiveFirst).toHaveBeenCalledOnce()
    expect(receiveSecond).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()

    receiveSecond.mockResolvedValue(TOKEN)
    await tick()
    expect(localStorage.getItem('authToken')).toBe(TOKEN)
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalled()
  })

  it('does not re-enter a receive() still in flight', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    const slow = deferred<string | null>()
    receive.mockReturnValue(slow.promise)
    const onSuccess = mount()

    await clickSignIn()
    await settle()
    await tick()
    await tick()
    await tick()
    expect(receive).toHaveBeenCalledOnce()

    slow.resolve(TOKEN)
    await settle()
    expect(localStorage.getItem('authToken')).toBe(TOKEN)
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('opens nothing if it was unmounted while the sign-in was starting', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(fakePopup() as unknown as Window)
    const start = deferred<{ url: string; nonce: string; attempt: RpcStub<LoginAttempt> }>()
    const dispose = vi.fn<() => void>()
    const stub = {
      startGatekeeperLogin: () => start.promise,
    } as unknown as RpcStub<PublicApi>
    mount(stub)

    await clickSignIn()
    act(() => root?.unmount())
    root = undefined
    start.resolve({
      url: URL,
      nonce: NONCE,
      attempt: { receive, [Symbol.dispose]: dispose } as unknown as RpcStub<LoginAttempt>,
    })
    await settle()

    expect(open).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
