// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, CloudflareAccountOption, CloudflareUsageInfo } from '@gadgets/workshop-shared/api'
import { NATIVE_CONNECT_COMPLETE_EVENT } from '../../connectHandoff'

const state = vi.hoisted(() => ({ auth: null as { authenticatedApi: RpcStub<AuthenticatedApi> } | null }))
vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => state.auth }))
vi.mock('../../ServerConfigContext', () => ({ useCloudflareLimitsEnabled: () => true }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
import AccountSelectionModal from './AccountSelectionModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement | undefined
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  state.auth = null
})

const usage = (connected: boolean): CloudflareUsageInfo => ({
  cloudflareLimitsEnabled: true, unlimited: false, dailyUsed: 0, dailyLimit: 10,
  remaining: 10, connected, balance: null, needsAccountSelection: connected,
})
const makeApi = () => ({
  getCloudflareUsage: vi.fn<() => Promise<CloudflareUsageInfo>>(async () => usage(false)),
  listCloudflareAccounts: vi.fn<() => Promise<CloudflareAccountOption[]>>(async () => [
    { accountId: 'new', accountName: 'Newly connected account' },
  ]),
  selectCloudflareAccount: vi.fn<(id: string) => Promise<void>>(async () => {}),
})
const render = async (api: ReturnType<typeof makeApi>) => {
  state.auth = { authenticatedApi: api as unknown as RpcStub<AuthenticatedApi> }
  await act(async () => root!.render(<AccountSelectionModal />))
}
const complete = async () => {
  await act(async () => window.dispatchEvent(new Event(NATIVE_CONNECT_COMPLETE_EVENT)))
}

describe('global native billing account selection', () => {
  it.each(['focus', 'native completion', 'auth change'])('handles an explicit billing choice after %s', async refresh => {
    const api = makeApi()
    api.getCloudflareUsage.mockResolvedValue(usage(true))
    api.listCloudflareAccounts.mockResolvedValue([
      { accountId: 'first', accountName: 'First account' },
      { accountId: 'second', accountName: 'Second account' },
    ])
    await render(api)
    const second = document.body.querySelector<HTMLInputElement>('input[value="second"]')!
    await act(async () => second.click())
    expect(second.checked).toBe(true)

    let finishList!: (list: CloudflareAccountOption[]) => void
    api.listCloudflareAccounts.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve }))
    if (refresh === 'focus') {
      await act(async () => window.dispatchEvent(new Event('focus')))
    } else if (refresh === 'native completion') {
      await complete()
    } else {
      await render(api)
    }
    expect(Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Save')!.disabled).toBe(true)
    await act(async () => finishList([
      { accountId: 'first', accountName: 'First account' },
      { accountId: 'second', accountName: 'Second account' },
    ]))
    const save = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Save')!
    await act(async () => save.click())
    expect(api.selectCloudflareAccount).toHaveBeenCalledExactlyOnceWith(refresh === 'focus' ? 'second' : 'first')
  })

  it('does not preserve a billing choice removed from the refreshed account list', async () => {
    const api = makeApi()
    api.getCloudflareUsage.mockResolvedValue(usage(true))
    api.listCloudflareAccounts.mockResolvedValue([
      { accountId: 'first', accountName: 'First account' },
      { accountId: 'second', accountName: 'Second account' },
    ])
    await render(api)
    await act(async () => document.body.querySelector<HTMLInputElement>('input[value="second"]')!.click())
    api.listCloudflareAccounts.mockResolvedValue([{ accountId: 'first', accountName: 'First account' }])
    await act(async () => window.dispatchEvent(new Event('focus')))
    const save = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Save')!
    await act(async () => save.click())
    expect(api.selectCloudflareAccount).toHaveBeenCalledExactlyOnceWith('first')
  })

  it.each([false, true])('opens after redemption despite a late pre-redemption focus response (reconnected: %s)', async reconnected => {
    const first = makeApi(), next = reconnected ? makeApi() : first
    await render(first)
    expect(document.body.textContent).not.toContain('Choose a Cloudflare account')
    let finishFocus!: (value: CloudflareUsageInfo) => void
    first.getCloudflareUsage.mockImplementationOnce(() => new Promise(resolve => { finishFocus = resolve }))
    await act(async () => window.dispatchEvent(new Event('focus')))
    if (reconnected) await render(next)
    next.getCloudflareUsage.mockResolvedValue(usage(true))
    await complete()
    expect(document.body.textContent).toContain('Newly connected account')
    await act(async () => finishFocus(usage(false)))
    expect(document.body.textContent).toContain('Newly connected account')
    expect(first.listCloudflareAccounts).toHaveBeenCalledTimes(reconnected ? 0 : 1)
    expect(next.listCloudflareAccounts).toHaveBeenCalledOnce()
  })

  it('invalidates pending and cached choices on later native completion and saves only a current choice', async () => {
    const api = makeApi()
    await render(api)
    api.getCloudflareUsage.mockResolvedValue(usage(true))
    let finishOldList!: (value: CloudflareAccountOption[]) => void
    api.listCloudflareAccounts.mockImplementationOnce(() => new Promise(resolve => { finishOldList = resolve }))
    await complete()
    await complete()
    expect(document.body.textContent).toContain('Newly connected account')
    await act(async () => finishOldList([{ accountId: 'old', accountName: 'Obsolete account' }]))
    expect(document.body.textContent).not.toContain('Obsolete account')

    api.listCloudflareAccounts.mockResolvedValue([{ accountId: 'replacement', accountName: 'Replacement account' }])
    await complete()
    expect(document.body.textContent).toContain('Replacement account')
    expect(document.body.textContent).not.toContain('Newly connected account')
    const save = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Save')!
    await act(async () => save.click())
    expect(api.selectCloudflareAccount).toHaveBeenCalledWith('replacement')
    expect(document.body.textContent).not.toContain('Choose a Cloudflare account')
  })

  it('lets the user retry a failed account-list read', async () => {
    const api = makeApi()
    api.getCloudflareUsage.mockResolvedValue(usage(true))
    api.listCloudflareAccounts.mockRejectedValueOnce(new Error('Temporary failure'))
    await render(api)
    expect(document.body.textContent).toContain('No accounts available')
    const retry = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(document.body.textContent).toContain('Newly connected account')
  })
})
