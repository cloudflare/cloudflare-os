// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  isLoading: false,
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: testState.authenticatedApi !== null,
    authenticatedApi: testState.authenticatedApi,
    isLoading: testState.isLoading,
    login: vi.fn<(token: string) => void>(),
    logout: vi.fn<() => void>(),
  }),
}))

import ConnectHandoffPage from './ConnectHandoffPage'
import { RpcContext } from './RpcContext'
import { HANDOFF_KEY, HANDOFF_PATH } from './connectHandoff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TICKET = 'a'.repeat(64)
const NONCE = 'b'.repeat(64)

// Lets the RPC promise settle and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('ConnectHandoffPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const completeConnectHandoff = vi.fn<(ticket: string, nonce: string) => Promise<void>>()
  const confirmLogin = vi.fn<(ticket: string, nonce: string) => Promise<void>>()
  const stub = { confirmLogin } as unknown as RpcStub<PublicApi>
  const close = vi.fn<() => void>()
  // What the RpcContext provider hands the page; a reconnect replaces `stub` with a new object.
  let provider: { stub: RpcStub<PublicApi>; connectionLost: boolean }

  beforeEach(() => {
    vi.spyOn(window, 'close').mockImplementation(close)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    completeConnectHandoff.mockReset()
    confirmLogin.mockReset()
    close.mockReset()
    testState.isLoading = false
    testState.authenticatedApi = null
    provider = { stub, connectionLost: false }
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  // The popup's state as the gatekeeper's final page leaves it: the ticket in the fragment, and the
  // record the Workshop tab wrote before navigating it.
  function arrive(hash: string | null, record: unknown) {
    window.history.replaceState(null, '', hash === null ? HANDOFF_PATH : `${HANDOFF_PATH}#${hash}`)
    if (record !== undefined) {
      sessionStorage.setItem(HANDOFF_KEY, typeof record === 'string' ? record : JSON.stringify(record))
    }
  }

  // `strict` mounts under StrictMode as main.tsx does, which double-invokes the state initializer
  // that spends the storage record and replays the effects.
  let strictMode = false
  function tree() {
    const page = (
      <RpcContext.Provider value={provider}>
        <ConnectHandoffPage />
      </RpcContext.Provider>
    )
    return strictMode ? <StrictMode>{page}</StrictMode> : page
  }

  async function render({ strict = false } = {}) {
    strictMode = strict
    provider = { stub, connectionLost: false }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(tree()) })
    await settle()
    return container
  }

  const rerender = () => act(async () => { root!.render(tree()) })

  const signedIn = () => {
    testState.authenticatedApi = { completeConnectHandoff } as unknown as RpcStub<AuthenticatedApi>
  }

  it('redeems a connect ticket with the nonce once, strips the fragment, spends the record, and closes', async () => {
    completeConnectHandoff.mockResolvedValue(undefined)
    signedIn()
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render({ strict: true })
    await rerender()
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe(HANDOFF_PATH)
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
    expect(close).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('Connected')
    expect(page.textContent).toContain('You can close this window.')
    expect(confirmLogin).not.toHaveBeenCalled()
  })

  it('shows the server message when a connect ticket is rejected', async () => {
    completeConnectHandoff.mockRejectedValue(new Error('This connection attempt has expired.'))
    signedIn()
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render()

    expect(page.textContent).toContain('Could not complete the connection')
    expect(page.textContent).toContain('This connection attempt has expired.')
    expect(close).not.toHaveBeenCalled()
  })

  it('reports the link invalid and calls nothing without a storage record', async () => {
    signedIn()
    arrive(TICKET, undefined)

    const page = await render()

    expect(page.textContent).toContain("This link isn't valid")
    expect(page.textContent).toContain('Reload the Workshop and start the connection again.')
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(confirmLogin).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  it('reports the link invalid for a malformed fragment', async () => {
    signedIn()
    arrive('not-a-ticket', { kind: 'connect', nonce: NONCE })

    const page = await render()

    expect(page.textContent).toContain("This link isn't valid")
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
  })

  it('confirms a sign-in ticket over the public API and closes', async () => {
    confirmLogin.mockResolvedValue(undefined)
    arrive(TICKET, { kind: 'login', nonce: NONCE })

    const page = await render()

    expect(confirmLogin).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('Signed in')
    expect(page.textContent).toContain('You can close this window.')
  })

  it('shows the server message when a sign-in ticket is rejected', async () => {
    confirmLogin.mockRejectedValue(new Error('This sign-in attempt has expired.'))
    arrive(TICKET, { kind: 'login', nonce: NONCE })

    const page = await render()

    expect(page.textContent).toContain('Could not sign in')
    expect(page.textContent).toContain('This sign-in attempt has expired.')
    expect(close).not.toHaveBeenCalled()
  })

  it('tells a signed-out connect popup to sign in first, calling nothing', async () => {
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render()

    expect(page.textContent).toContain("You're signed out")
    expect(page.textContent).toContain('Sign in to the Workshop and start the connection again.')
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(confirmLogin).not.toHaveBeenCalled()
  })

  it('waits for auth before redeeming a connect ticket', async () => {
    completeConnectHandoff.mockResolvedValue(undefined)
    testState.isLoading = true
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render()
    expect(page.textContent).toContain('Finishing up…')
    expect(completeConnectHandoff).not.toHaveBeenCalled()

    testState.isLoading = false
    signedIn()
    await rerender()
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(page.textContent).toContain('Connected')
  })

  it('retries over the reconnected session when the first attempt died with the socket', async () => {
    // capnweb rejects every call pending on a socket that closes, and main.tsx then publishes a
    // stub for the replacement connection on which useAuth re-authenticates. The redemption is
    // presented again over that session; ticket and nonce are single-use server-side, so a repeat
    // of a call that did land is refused as expired and changes nothing.
    completeConnectHandoff
      .mockRejectedValueOnce(new Error('RPC session was broken'))
      .mockResolvedValueOnce(undefined)
    signedIn()
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render()
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(page.textContent).toContain('Could not complete the connection')

    provider = { stub, connectionLost: true }
    await rerender()
    expect(page.textContent).toContain('Finishing up…')
    expect(page.textContent).not.toContain('Could not complete the connection')
    expect(completeConnectHandoff).toHaveBeenCalledOnce()

    provider = { stub: { confirmLogin } as unknown as RpcStub<PublicApi>, connectionLost: false }
    signedIn()
    await rerender()
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledTimes(2)
    expect(completeConnectHandoff).toHaveBeenLastCalledWith(TICKET, NONCE)
    expect(page.textContent).toContain('Connected')
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not retry on a re-render with the same session', async () => {
    completeConnectHandoff.mockRejectedValue(new Error('This connection attempt has expired.'))
    signedIn()
    arrive(TICKET, { kind: 'connect', nonce: NONCE })

    const page = await render({ strict: true })
    await rerender()
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('This connection attempt has expired.')
  })

  it('retries a sign-in confirmation over the reconnected session', async () => {
    confirmLogin
      .mockRejectedValueOnce(new Error('RPC session was broken'))
      .mockResolvedValueOnce(undefined)
    arrive(TICKET, { kind: 'login', nonce: NONCE })

    const page = await render()
    expect(confirmLogin).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    expect(page.textContent).toContain('Could not sign in')

    // The same session again: nothing is re-sent.
    await rerender()
    await settle()
    expect(confirmLogin).toHaveBeenCalledOnce()

    provider = { stub: { confirmLogin } as unknown as RpcStub<PublicApi>, connectionLost: false }
    await rerender()
    await settle()

    expect(confirmLogin).toHaveBeenCalledTimes(2)
    expect(confirmLogin).toHaveBeenLastCalledWith(TICKET, NONCE)
    expect(page.textContent).toContain('Signed in')
  })
})
