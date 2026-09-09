// @vitest-environment jsdom

import React, { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const testState = vi.hoisted(() => ({
  reconnect: vi.fn<(...args: unknown[]) => Promise<{ url: string }>>(async () => ({ url: 'https://reconnect.test' })),
  connect: vi.fn<(...args: unknown[]) => Promise<{ url: string }>>(async () => ({ url: 'https://connect.test' })),
  grant: vi.fn<(...args: unknown[]) => Promise<{ url?: string }>>(async () => ({})),
  disconnectAccount: vi.fn<(accountId: number) => Promise<void>>(async () => {}),
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) =>
      React.createElement('div', { 'data-testid': 'connect-modal' }, children),
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({ type: 'button' }),
    },
  )
  return {
    Dialog,
    Switch: ({ 'aria-label': label }: { 'aria-label'?: string }) => (
      <input type="checkbox" aria-label={label} readOnly />
    ),
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('../accountBrowserFlow', () => ({
  accountBrowserFlows: {
    connect: (...args: unknown[]) => testState.connect(...args),
    grant: (...args: unknown[]) => testState.grant(...args),
    reconnect: (...args: unknown[]) => testState.reconnect(...args),
  },
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('../useGatekeeperApps', () => ({ refreshGatekeeperApps: vi.fn<(api: unknown) => void>() }))
vi.mock('../rpcErrors', () => ({ logRpcFailure: vi.fn<(...args: unknown[]) => void>() }))

const authState = vi.hoisted(() => ({ api: undefined as unknown }))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: authState.api }),
}))

import { ConnectorsPage } from './gatekeepers'

const JIRA_VENDOR: VendorDescription = { displayName: 'Jira', url: 'https://www.atlassian.com/software/jira' }
const GITHUB_VENDOR: VendorDescription = { displayName: 'GitHub', url: 'https://github.com' }
const ZENDESK_VENDOR: VendorDescription = { displayName: 'Zendesk', url: 'https://www.zendesk.com' }

const JIRA_SITE: SupportedResource = {
  title: 'Jira site',
  description: 'Pick an authorized Jira site.',
  urlPattern: 'https://:site.atlassian.net/*',
  grantable: true,
}

function accountDescription(displayName: string, uniqueName: string): AccountDescription {
  return { displayName, uniqueName, avatar: { url: 'https://example.test/avatar.png' } }
}

const JIRA_ACCOUNT_ID = 3
const GITHUB_ACCOUNT_ID = 4
const ZENDESK_ACCOUNT_ID = 5

function makeApi() {
  return {
    listAddableGatekeepers: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => []),
    listGatekeeperVendors: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => [
      { id: 'jira', description: JIRA_VENDOR, supportedResources: [JIRA_SITE] },
      { id: 'github', description: GITHUB_VENDOR, supportedResources: [] },
      { id: 'zendesk', description: ZENDESK_VENDOR, supportedResources: [] },
    ]),
    disconnectAccount: testState.disconnectAccount,
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscriber.add(
        JIRA_ACCOUNT_ID,
        { ...accountDescription('Jacob Jira', 'acme.atlassian.net'), grantedResourceUrlPatterns: [JIRA_SITE.urlPattern] },
        JIRA_VENDOR,
        [JIRA_SITE],
        true,
        'jira',
      )
      subscriber.add(GITHUB_ACCOUNT_ID, accountDescription('Jacob GitHub', 'jacob'), GITHUB_VENDOR, [], true, 'github')
      subscriber.add(ZENDESK_ACCOUNT_ID, accountDescription('Jacob Zendesk', 'acme'), ZENDESK_VENDOR, [], false, 'zendesk')
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    },
  }
}

describe('Connections page reconnect wiring', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.clearAllMocks()
    testState.reconnect.mockImplementation(async () => ({ url: 'https://reconnect.test' }))
  })

  async function renderPage() {
    authState.api = makeApi()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(<ConnectorsPage />) })
    await act(async () => { await Promise.resolve() })
  }

  const modal = () => container!.querySelector('[data-testid="connect-modal"]')
  const modalButton = (label: string) =>
    [...(modal()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label)

  async function openManageModal(name: string) {
    const card = [...container!.querySelectorAll('[role="button"]')].find((el) =>
      el.textContent?.includes(name),
    )
    expect(card, `no connected card for ${name}`).toBeDefined()
    await act(async () => { (card as HTMLElement).click() })
  }

  it('offers reconnect on a healthy Jira connection and routes it through the OAuth flow', async () => {
    await renderPage()
    await openManageModal('Jira')

    const reconnect = modalButton('Reconnect')
    expect(reconnect).toBeDefined()

    await act(async () => { reconnect!.click() })

    expect(testState.reconnect).toHaveBeenCalledTimes(1)
    expect(testState.reconnect.mock.calls[0][1]).toBe(JIRA_ACCOUNT_ID)
    expect(testState.reconnect.mock.calls[0][2]).toEqual({ webPopup: 'preopen' })
    // Reconnect is non-destructive: nothing gets disconnected on the way through.
    expect(testState.disconnectAccount).not.toHaveBeenCalled()
  })

  it('leaves other healthy connections untouched', async () => {
    await renderPage()
    await openManageModal('GitHub')

    expect(modalButton('Reconnect')).toBeUndefined()
    expect(modalButton('Close')).toBeDefined()
    expect(modalButton('Disconnect')).toBeDefined()
  })

  it('still offers reconnect for an expired connection of any vendor', async () => {
    await renderPage()
    await openManageModal('Zendesk')

    expect(modalButton('Reconnect')).toBeDefined()
  })

  it('disables the conflicting manage actions while the reconnect flow is open', async () => {
    let release: (() => void) | undefined
    testState.reconnect.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ url: 'https://reconnect.test' })
      }),
    )

    await renderPage()
    await openManageModal('Jira')
    await act(async () => { modalButton('Reconnect')!.click() })

    expect(modalButton('Reconnect')).toBeUndefined()
    expect(modalButton('Opening...')!.disabled).toBe(true)
    expect(modalButton('Disconnect')!.disabled).toBe(true)

    await act(async () => { release!(); await Promise.resolve() })

    expect(modalButton('Reconnect')!.disabled).toBe(false)
    expect(modalButton('Disconnect')!.disabled).toBe(false)
  })
})
