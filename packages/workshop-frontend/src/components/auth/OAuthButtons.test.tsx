// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthVendorInfo, LoginAttempt, PublicApi } from '@gadgets/workshop-shared/api'
import { CONNECT_HANDOFF_MESSAGE_TYPE } from '@gadgets/workshop-shared/gatekeeper'
import { gatekeeperOrigin } from '../../connectHandoff'
import OAuthButtons from './OAuthButtons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VENDORS: AuthVendorInfo[] = [{ vendorId: 'github', displayName: 'GitHub' }]
const TICKET = 'b'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

// Lets pending promises and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('OAuthButtons', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const claim = vi.fn<(ticket: string) => Promise<string>>()
  const attempt = { claim, [Symbol.dispose]() {} } as unknown as RpcStub<LoginAttempt>
  const popup = { closed: false, close: vi.fn<() => void>() } as unknown as Window

  function mount(rpcStub: RpcStub<PublicApi>, onSuccess = vi.fn<() => void>()) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<OAuthButtons rpcStub={rpcStub} vendors={VENDORS} onSuccess={onSuccess} />))
    return onSuccess
  }

  const clickSignIn = () => act(async () => { container!.querySelector('button')!.click() })

  const deliver = (source: Window | null, ticket = TICKET) => window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket }, origin: gatekeeperOrigin(), source,
    }))

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    claim.mockReset()
    localStorage.clear()
  })

  it('claims only the ticket its own popup posts', async () => {
    vi.spyOn(window, 'open').mockReturnValue(popup)
    claim.mockResolvedValue('alice@example.com:secret')
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)

    await clickSignIn()
    await settle()
    expect(window.open).toHaveBeenCalledWith(
      'https://gk.example/login', 'gatekeeper-login', 'popup,width=520,height=680')

    // A ticket from some other window (an account-connect popup, say) is not this attempt's.
    deliver({ close() {} } as unknown as Window)
    await settle()
    expect(claim).not.toHaveBeenCalled()

    deliver(popup)
    await settle()
    expect(claim).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(popup.close).toHaveBeenCalled()
  })

  it('keeps listening after the popup handle dies, and claims a broadcast ticket', async () => {
    // A provider that isolates its pages with COOP severs the opener mid-flow: the handle reports
    // closed while the flow is still running, and the handoff page reaches us over the channel.
    const severed = { closed: false, close: vi.fn<() => void>() } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(severed)
    claim.mockResolvedValue('alice@example.com:secret')
    const rpcStub = {
      startGatekeeperLogin: async () => ({ url: 'https://gk.example/login', attempt }),
    } as unknown as RpcStub<PublicApi>
    const onSuccess = mount(rpcStub)
    const button = () => container!.querySelector('button')!

    await clickSignIn()
    await settle()
    expect(button().disabled).toBe(true)

    ;(severed as { closed: boolean }).closed = true
    await act(() => new Promise(resolve => setTimeout(resolve, 600)))
    // Not treated as a cancellation: the buttons come back, the attempt stays live.
    expect(button().disabled).toBe(false)
    expect(container!.textContent).not.toContain('cancelled')
    expect(claim).not.toHaveBeenCalled()

    const sender = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
    sender.postMessage({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    sender.close()
    await vi.waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(TICKET))
    await settle()
    expect(localStorage.getItem('authToken')).toBe('alice@example.com:secret')
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('opens nothing if it was unmounted while the sign-in was starting', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    const start = deferred<{ url: string; attempt: RpcStub<LoginAttempt> }>()
    const dispose = vi.fn<() => void>()
    const rpcStub = {
      startGatekeeperLogin: () => start.promise,
    } as unknown as RpcStub<PublicApi>
    mount(rpcStub)

    await clickSignIn()
    act(() => root?.unmount())
    root = undefined
    start.resolve({
      url: 'https://gk.example/login',
      attempt: { claim, [Symbol.dispose]: dispose } as unknown as RpcStub<LoginAttempt>,
    })
    await settle()

    expect(open).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
