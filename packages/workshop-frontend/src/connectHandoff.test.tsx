// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE, CONNECT_HANDOFF_MESSAGE_TYPE,
} from '@gadgets/workshop-shared/gatekeeper'
import { gatekeeperOrigin, openConnectWindow, useConnectHandoffListener } from './connectHandoff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TICKET = 'a'.repeat(64)

function Listener({ api, onError }: { api: RpcStub<AuthenticatedApi> | null; onError: (m: string) => void }) {
  useConnectHandoffListener(api, onError)
  return null
}

function deliver(data: unknown, origin = gatekeeperOrigin(), source: Window | null = null) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
}

// Lets the RPC promise settle and React flush.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// What a disowned popup on our origin does: broadcast on the channel named after the message type.
// Delivery is asynchronous, so callers wait a tick before asserting.
async function broadcast(...messages: unknown[]) {
  const channel = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no targetOrigin.
  for (const message of messages) channel.postMessage(message)
  await new Promise(resolve => setTimeout(resolve, 20))
  channel.close()
}

// What `openConnectWindow` leaves behind in this tab: the marker that makes a broadcast ticket ours,
// stamped with when the popup was opened.
const CONNECT_PENDING_KEY = 'gadgets.connectPending'
const pending = (openedAt = Date.now()) => sessionStorage.setItem(CONNECT_PENDING_KEY, String(openedAt))

// The next acknowledgement posted on the channel, as the handoff page hears it (the page's own
// broadcasts pass this receiver too, so anything but an ack is skipped).
function nextAck(): Promise<unknown> {
  const receiver = new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
  return new Promise(resolve => {
    receiver.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type !== CONNECT_HANDOFF_ACK_MESSAGE_TYPE) return
      receiver.close()
      resolve(event.data)
    })
  })
}

describe('useConnectHandoffListener', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const completeConnectHandoff = vi.fn<(ticket: string) => Promise<void>>()
  const onError = vi.fn<(message: string) => void>()
  const api = { completeConnectHandoff } as unknown as RpcStub<AuthenticatedApi>

  function mount() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<Listener api={api} onError={onError} />))
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    completeConnectHandoff.mockReset()
    onError.mockReset()
    sessionStorage.clear()
  })

  it('redeems a well-formed ticket from the gatekeeper origin and closes the popup', async () => {
    completeConnectHandoff.mockResolvedValue(undefined)
    const popup = { close: vi.fn<() => void>() } as unknown as Window
    mount()

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET }, gatekeeperOrigin(), popup)
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(popup.close).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('redeems a ticket broadcast on the same-origin channel, closing nothing itself', async () => {
    // A disowned popup on our own origin has no opener to post to; it broadcasts and closes itself.
    completeConnectHandoff.mockResolvedValue(undefined)
    pending()
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a broadcast ticket when this tab opened no connect', async () => {
    // Every Workshop tab on the origin hears the channel; only the one that opened the popup redeems,
    // so the others neither race it nor toast that the attempt expired.
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('spends the marker on a successful broadcast redemption and acknowledges it', async () => {
    completeConnectHandoff.mockResolvedValue(undefined)
    const popup = { opener: null, location: { replace: vi.fn<(url: string) => void>() } }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const before = Date.now()
    mount()
    openConnectWindow('https://gk.example/connect')
    expect(Number(sessionStorage.getItem(CONNECT_PENDING_KEY))).toBeGreaterThanOrEqual(before)

    const heard = nextAck()
    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    // Spent: a later broadcast is not this tab's. The ack is what stops the page repeating.
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).toBeNull()
    expect(await heard).toEqual({ type: CONNECT_HANDOFF_ACK_MESSAGE_TYPE, ticket: TICKET })
    expect(onError).not.toHaveBeenCalled()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'b'.repeat(64) })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledOnce()
  })

  it('keeps the marker when a broadcast redemption fails, and tries each ticket once', async () => {
    // A sibling tab's or a sign-in ticket heard first is rejected by the server; that must not
    // cost this tab its own ticket, which is still on its way. The page repeats its broadcast until
    // acked, so a ticket already tried is ignored rather than toasted again.
    completeConnectHandoff
      .mockRejectedValueOnce(new Error('This connection attempt has expired.'))
      .mockResolvedValueOnce(undefined)
    pending()
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(onError).toHaveBeenCalledExactlyOnceWith('This connection attempt has expired.')
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).not.toBeNull()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'b'.repeat(64) })
    await settle()
    expect(completeConnectHandoff).toHaveBeenCalledTimes(2)
    expect(completeConnectHandoff).toHaveBeenLastCalledWith('b'.repeat(64))
    expect(sessionStorage.getItem(CONNECT_PENDING_KEY)).toBeNull()
  })

  it('ignores a marker older than the connect lifetime', async () => {
    // An abandoned popup's flow can no longer complete once its connect and OAuth nonces have both
    // expired, so its marker must stop this tab racing its siblings for their tickets.
    pending(Date.now() - 31 * 60 * 1000)
    mount()

    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a malformed broadcast', async () => {
    pending()
    mount()

    await broadcast(
      { type: 'gadgets.connect-handoff.v0', ticket: TICKET },
      { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'not-a-ticket' },
      'ticket',
    )
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores messages from any other origin, type, or shape', async () => {
    mount()

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET }, 'https://evil.example')
    deliver({ type: 'gadgets.connect-handoff.v0', ticket: TICKET })
    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: 'not-a-ticket' })
    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET.toUpperCase() })
    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE })
    deliver('ticket')
    deliver(null)
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a rejected ticket and leaves the popup open', async () => {
    completeConnectHandoff.mockRejectedValue(new Error('This connection attempt has expired.'))
    const popup = { close: vi.fn<() => void>() } as unknown as Window
    mount()

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET }, gatekeeperOrigin(), popup)
    await settle()

    expect(onError).toHaveBeenCalledExactlyOnceWith('This connection attempt has expired.')
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('listens for nothing when given no session', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<Listener api={null} onError={onError} />))

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted, on both transports', async () => {
    pending()
    mount()
    act(() => root?.unmount())
    root = undefined

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await broadcast({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
  })
})

describe('openConnectWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // A popup as window.open returns it: an opener pointing back at us, and a location to navigate.
  function fakePopup() {
    return {
      opener: window as Window | null,
      location: { replace: vi.fn<(url: string) => void>() },
    }
  }

  it('opens an empty popup, disowns it, then navigates it when the gatekeepers share our origin', () => {
    vi.stubEnv('VITE_BACKEND_HOST', window.location.host)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    expect(openConnectWindow('https://gk.example/connect')).toBe(popup)
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'gadgets-connect', 'popup,width=520,height=680')
    expect(open.mock.calls[0][2]).not.toContain('noopener')
    // Disowned before it is navigated, so no provider page ever sees window.opener.
    expect(popup.opener).toBeNull()
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
  })

  it('keeps the opener when the gatekeepers are on another origin, as under the dev server', () => {
    // A BroadcastChannel could not cross origins, so the page must be able to postMessage to us.
    expect(gatekeeperOrigin()).not.toBe(window.location.origin)
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    expect(openConnectWindow('https://gk.example/connect')).toBe(popup)
    expect(popup.opener).toBe(window)
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
  })

  it('tells the user when the browser blocked the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    expect(() => openConnectWindow('https://gk.example/connect'))
      .toThrow('Pop-up blocked. Please allow pop-ups and try again.')
  })
})
