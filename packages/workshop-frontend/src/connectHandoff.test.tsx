// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { CONNECT_HANDOFF_MESSAGE_TYPE } from '@gadgets/workshop-shared/gatekeeper'
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

  it('stops listening once unmounted', async () => {
    mount()
    act(() => root?.unmount())
    root = undefined

    deliver({ type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: TICKET })
    await settle()

    expect(completeConnectHandoff).not.toHaveBeenCalled()
  })
})

describe('openConnectWindow', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens a popup that keeps this window as its opener', () => {
    const popup = {} as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)

    expect(openConnectWindow('https://gk.example/connect')).toBe(popup)
    expect(open).toHaveBeenCalledWith(
      'https://gk.example/connect', 'gadgets-connect', 'popup,width=520,height=680')
    expect(open.mock.calls[0][2]).not.toContain('noopener')
  })

  it('tells the user when the browser blocked the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    expect(() => openConnectWindow('https://gk.example/connect'))
      .toThrow('Pop-up blocked. Please allow pop-ups and try again.')
  })
})
