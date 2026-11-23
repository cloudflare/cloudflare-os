// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectFlowStart } from '@gadgets/workshop-shared/api'
import { NativeConnectSession } from './features/native-app/connectSession'
import { NATIVE_AUTH_EVENT } from './features/native-app/authPopup'

const state = vi.hoisted(() => ({
  api: null as RpcStub<AuthenticatedApi> | null,
  toast: vi.fn<(toast: unknown) => void>(),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.api }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Cloudflare OS' }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: state.toast }),
}))
import { Route } from './routes/gatekeepers'
const GatekeepersPage = Route.options.component!
await GatekeepersPage.preload?.()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined, container: HTMLDivElement | undefined
const authentication = {
  open: vi.fn<(id: string, url: string) => void>(), close: vi.fn<(id: string) => void>(),
}
const result = (id: string, ticket?: string) => window.dispatchEvent(new CustomEvent(NATIVE_AUTH_EVENT, { detail: { id, ticket } }))
afterEach(async () => {
  await act(async () => {
    authentication.open.mock.calls.forEach(([id]) => result(id))
    root?.unmount()
  })
  container?.remove()
  root = undefined
  state.api = null
  state.toast.mockClear()
  authentication.open.mockClear()
  authentication.close.mockClear()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const renderPage = async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('location', { origin: 'https://workshop.example' })
  vi.stubGlobal('cloudflareOSNative', {
    version: 1, isAvailable: () => true, loginReady() {}, returnToInstalls() {}, authentication,
  })
  const api = {
    listAddableGatekeepers: async () => [],
    listGatekeeperVendors: async () => [{ id: 'example', description: { displayName: 'Example', url: 'https://example.com', tagline: 'Example service' }, supportedResources: [] }],
    subscribeConnectedAccounts: (subscriber: Parameters<AuthenticatedApi['subscribeConnectedAccounts']>[0]) => {
      subscriber.ready()
      return Object.assign(Promise.resolve(), { [Symbol.dispose]() {} })
    },
    connectAccount: vi.fn<() => Promise<ConnectFlowStart>>(async () => ({ url: 'https://workshop.example/gatekeeper/example/connect', nonce: 'a'.repeat(64) })),
    completeConnectHandoff: vi.fn<(ticket: string, nonce: string) => Promise<void>>(async () => {}),
    onRpcBroken: () => {},
  }
  new NativeConnectSession().track(api, Promise.resolve({ type: 'user', id: 'alice', name: 'Alice' }))
  state.api = api as unknown as RpcStub<AuthenticatedApi>
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<GatekeepersPage />))
  const vendor = Array.from(document.body.querySelectorAll<HTMLElement>('[role="button"]')).find(element => element.textContent?.includes('Example'))!
  await act(async () => vendor.click())
  return api
}
const button = (text: string) => Array.from(document.body.querySelectorAll('button')).find(element => element.textContent === text)!

describe('native connector modal cancellation', () => {
  it('lets the user cancel a dismissed auth tab and retry without waiting for expiry', async () => {
    const api = await renderPage()
    await act(async () => button('Continue to Example').click())
    const oldId = authentication.open.mock.calls[0][0]
    await act(async () => window.dispatchEvent(new Event('focus')))
    const cancel = button('Cancel connection')
    expect(cancel).toBeDefined()
    expect(cancel.disabled).toBe(false)
    await act(async () => cancel.click())
    expect(authentication.close).toHaveBeenCalledExactlyOnceWith(oldId)
    expect(button('Continue to Example').disabled).toBe(false)
    expect(state.toast).not.toHaveBeenCalled()

    await act(async () => button('Continue to Example').click())
    const newId = authentication.open.mock.calls[1][0]
    expect(newId).not.toBe(oldId)
    await act(async () => result(oldId, 'b'.repeat(64)))
    expect(api.completeConnectHandoff).not.toHaveBeenCalled()
    await act(async () => result(newId, 'c'.repeat(64)))
    expect(api.completeConnectHandoff).toHaveBeenCalledExactlyOnceWith('c'.repeat(64), 'a'.repeat(64))
    expect(document.body.textContent).not.toContain('Continue to Example')
  })

  it('cancels an open native flow when leaving the route', async () => {
    const api = await renderPage()
    await act(async () => button('Continue to Example').click())
    const id = authentication.open.mock.calls[0][0]
    await act(async () => { root!.unmount(); root = undefined })
    expect(authentication.close).toHaveBeenCalledExactlyOnceWith(id)
    await act(async () => result(id, 'b'.repeat(64)))
    expect(api.completeConnectHandoff).not.toHaveBeenCalled()
  })

  it('does not launch a late connect response after leaving the route', async () => {
    const api = await renderPage()
    let finishStart!: (flow: ConnectFlowStart) => void
    api.connectAccount.mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve }))
    await act(async () => button('Continue to Example').click())
    await act(async () => { root!.unmount(); root = undefined })
    await act(async () => finishStart({ url: 'https://workshop.example/gatekeeper/example/connect', nonce: 'a'.repeat(64) }))
    expect(authentication.open).not.toHaveBeenCalled()
    expect(state.toast).not.toHaveBeenCalled()
  })
})
