// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { NativeConnectSession } from '../../features/native-app/connectSession'
import { NATIVE_AUTH_EVENT } from '../../features/native-app/authPopup'
import { NATIVE_CONNECT_COMPLETE_EVENT } from '../../connectHandoff'

const state = vi.hoisted(() => ({ auth: null as { authenticatedApi: RpcStub<AuthenticatedApi> } | null }))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => state.auth,
  useOptionalAuthenticatedApi: () => state.auth,
}))
vi.mock('../../ServerConfigContext', () => ({ useCloudflareLimitsEnabled: () => true }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
import UsageSettings from './UsageSettings'
import OutOfCreditsModal from './OutOfCreditsModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  state.auth = null
})

describe.each(['profile', 'out-of-credits'] as const)('%s native billing connection', panel => {
  it('refreshes usage and account choices after redemption, even when focus came first and RPC changed', async () => {
    let connected = false
    const usage = (): CloudflareUsageInfo => ({ cloudflareLimitsEnabled: true, unlimited: false,
      dailyUsed: 10, dailyLimit: 10, remaining: 0, connected, balance: null, needsAccountSelection: connected })
    const makeApi = () => ({
      getCloudflareUsage: vi.fn<() => Promise<CloudflareUsageInfo>>(async () => usage()),
      listCloudflareAccounts: vi.fn<() => Promise<CloudflareAccountOption[]>>(async () => [{ accountId: 'new', accountName: 'Newly connected account' }]),
      connectAccount: async () => ({ url: 'https://workshop.example/gatekeeper/cloudflare/connect', nonce: 'a'.repeat(64) }),
      completeConnectHandoff: vi.fn<(ticket: string, nonce: string) => Promise<void>>(async () => { connected = true }),
      onRpcBroken: () => {},
    })
    const first = makeApi(), next = makeApi(), session = new NativeConnectSession()
    const person = { type: 'user' as const, id: 'alice', name: 'Alice' }
    session.track(first, Promise.resolve(person))
    state.auth = { authenticatedApi: first as unknown as RpcStub<AuthenticatedApi> }
    const authentication = { open: vi.fn<(id: string, url: string) => void>(), close: vi.fn<(id: string) => void>() }
    vi.stubGlobal('location', { origin: 'https://workshop.example' })
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true, loginReady: vi.fn<() => void>(), returnToInstalls: vi.fn<() => void>(), authentication,
    })
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = () => root!.render(panel === 'profile' ? <UsageSettings /> : <OutOfCreditsModal open onClose={() => {}} />)
    await act(async () => render())
    const connect = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('Connect Cloudflare'))!
    await act(async () => connect.click())
    expect(authentication.open).toHaveBeenCalledOnce()
    let finishFocus!: (value: CloudflareUsageInfo) => void
    const staleUsage = usage()
    first.getCloudflareUsage.mockImplementationOnce(() => new Promise(resolve => { finishFocus = resolve }))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(connected).toBe(false)
    expect(first.getCloudflareUsage).toHaveBeenCalledTimes(2)

    session.track(next, Promise.resolve(person))
    state.auth = { authenticatedApi: next as unknown as RpcStub<AuthenticatedApi> }
    await act(async () => render())
    const beforeCompletion = next.getCloudflareUsage.mock.calls.length
    await act(async () => window.dispatchEvent(new CustomEvent(NATIVE_AUTH_EVENT, {
      detail: { id: authentication.open.mock.calls[0][0], ticket: 'b'.repeat(64) },
    })))
    expect(first.completeConnectHandoff).not.toHaveBeenCalled()
    expect(first.getCloudflareUsage).toHaveBeenCalledTimes(2)
    expect(next.completeConnectHandoff).toHaveBeenCalledOnce()
    expect(next.getCloudflareUsage).toHaveBeenCalledTimes(beforeCompletion + 1)
    expect(next.listCloudflareAccounts).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Newly connected account')
    await act(async () => finishFocus(staleUsage))
    expect(document.body.textContent).toContain('Newly connected account')

    // A later successful reconnect invalidates the cached account choices as well.
    next.listCloudflareAccounts.mockResolvedValue([{ accountId: 'other', accountName: 'Replacement account' }])
    await act(async () => window.dispatchEvent(new Event(NATIVE_CONNECT_COMPLETE_EVENT)))
    expect(document.body.textContent).toContain('Replacement account')
    expect(document.body.textContent).not.toContain('Newly connected account')
  })
})
