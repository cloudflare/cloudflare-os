// @vitest-environment jsdom

import React, { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({ type: 'button' }),
    },
  )
  return {
    Dialog,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./ResourceConfiguratorHost', () => ({
  default: ({ frame, onCollectResourceUrlChange, onSelectionReadyChange }: {
    frame: ResourceConfiguratorFrame | null
    onCollectResourceUrlChange: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange: (ready: boolean | null) => void
  }) => {
    useEffect(() => {
      if (frame) {
        onCollectResourceUrlChange(() => Promise.resolve('https://acme.atlassian.net/browse/ENG-1'))
        onSelectionReadyChange(true)
      } else {
        onCollectResourceUrlChange(null)
        onSelectionReadyChange(null)
      }
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange])
    return <div data-testid="resource-configurator">Configurator</div>
  },
}))

const auth = vi.hoisted(() => ({ api: undefined as unknown as RpcStub<AuthenticatedApi> }))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: auth.api }),
}))

vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(...args: unknown[]) => void>() }))
vi.mock('./rpcErrors', () => ({ logRpcFailure: vi.fn<(...args: unknown[]) => void>() }))

import GatekeeperModal from './GatekeeperModal'

const JIRA_VENDOR: VendorDescription = { displayName: 'Jira', url: 'https://www.atlassian.com/software/jira', color: '#0052cc' }
const GITHUB_VENDOR: VendorDescription = { displayName: 'GitHub', url: 'https://github.com', color: '#24292f' }
const JIRA_SITE: SupportedResource = {
  title: 'Jira site',
  description: 'Pick an authorized Jira site.',
  urlPattern: 'https://:site.atlassian.net/*',
  grantable: true,
}
const JIRA_ISSUE: SupportedResource = {
  title: 'Jira issue',
  description: 'Pick an authorized Jira issue.',
  urlPattern: 'https://:site.atlassian.net/browse/:issueKey',
  grantable: true,
}
const GITHUB_REPO: SupportedResource = {
  title: 'GitHub repo',
  description: 'Pick a repository.',
  urlPattern: 'https://github.com/:owner/:repo',
  grantable: true,
}

function makeApi() {
  const startResourceConfigurator = vi.fn<(
    accountId: number,
    resourceUrlPattern: string,
  ) => Promise<ResourceConfiguratorFrame>>(async () => ({
    iframeHtml: '<div></div>',
    ui: { [Symbol.dispose]() {} },
  }))
  const newGatekeeper = vi.fn<(
    accountId: number,
    resourceUrl: string,
  ) => Promise<RpcStub<GatekeeperClient<any>>>>(async () => ({
    getId: async () => 17,
    [Symbol.dispose]() {},
  } as unknown as RpcStub<GatekeeperClient<any>>))
  const connectAccount = vi.fn<(
    vendorId: string,
    resourceUrlPatterns?: string[],
  ) => Promise<{ url: string }>>()
  const api = {
    listModels: async () => [],
    listGatekeeperVendors: async () => [
      { id: 'jira', description: JIRA_VENDOR, supportedResources: [JIRA_SITE, JIRA_ISSUE] },
      { id: 'github', description: GITHUB_VENDOR, supportedResources: [GITHUB_REPO] },
    ],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      const description: AccountDescription = {
        displayName: 'Jacob Jira',
        uniqueName: 'jacob@jira',
        avatar: { url: 'https://acme.atlassian.net/avatar.png' },
        grantedResourceUrlPatterns: [JIRA_SITE.urlPattern, JIRA_ISSUE.urlPattern],
      }
      subscriber.add(3, description, JIRA_VENDOR, [JIRA_SITE, JIRA_ISSUE], true, 'jira')
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    },
    connectAccount,
    ensureAccountResources: vi.fn<(
      accountId: number,
      resourceUrlPatterns: string[],
    ) => Promise<{ url?: string }>>(),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(),
    startResourceConfigurator,
  } as unknown as RpcStub<AuthenticatedApi> & {
    startResourceConfigurator: typeof startResourceConfigurator
    connectAccount: typeof connectAccount
  }
  const overseer = {
    newGatekeeper,
  } as unknown as RpcStub<Overseer> & { newGatekeeper: typeof newGatekeeper }
  return { api, overseer, startResourceConfigurator, newGatekeeper }
}

describe('GatekeeperModal requestConnection accept flow', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverMock
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function renderVendorOnly() {
    const harness = makeApi()
    auth.api = harness.api
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={() => harness.overseer}
          onCreated={vi.fn<(gk: RpcStub<GatekeeperClient<any>>) => Promise<void>>(async () => {})}
          initialVendorId="jira"
        />,
      )
    })
    await act(async () => { await Promise.resolve() })
    return harness
  }

  it('shows only the requested vendor and waits for an explicit resource choice', async () => {
    await renderVendorOnly()

    expect(container!.textContent).toContain('Choose which Jira resource to grant.')
    expect(container!.textContent).toContain('Jira site')
    expect(container!.textContent).toContain('Jira issue')
    expect(container!.textContent).not.toContain('GitHub repo')
    expect(container!.textContent).not.toContain('AI Model')
  })

  it('reuses an existing authorized account after the user chooses a vendor resource', async () => {
    const harness = await renderVendorOnly()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const issueButton = Array.from(container!.querySelectorAll('button')).toReversed()
      .find(button => button.textContent?.includes('Jira issue'))
    expect(issueButton).toBeDefined()
    expect(issueButton!.textContent).toContain('Pick an authorized Jira issue.')

    await act(async () => { issueButton!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container!.textContent).toContain('Account')
    expect(harness.api.connectAccount).not.toHaveBeenCalled()
    expect(harness.startResourceConfigurator).toHaveBeenCalledWith(3, JIRA_ISSUE.urlPattern)
    expect(container!.textContent).toContain('jacob@jira')
  })
})
