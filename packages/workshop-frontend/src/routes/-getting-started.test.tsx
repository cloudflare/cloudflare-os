// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, ConnectedAccountsSubscriber, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: {
    listModels: vi.fn<() => Promise<AiChatAuthorInfo[]>>(async () => [
      { type: 'agent' as const, id: 'team-pi-codex/gpt-6-astra', name: 'GPT-6 Astra' },
    ]),
    listGatekeeperVendors: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => [
      {
        id: 'jira',
        description: { displayName: 'Jira', url: 'https://example.test' },
        supportedResources: [],
      },
      { id: 'zendesk', description: { displayName: 'Zendesk', url: 'https://example.test' }, supportedResources: [] },
    ]),
    listAddableGatekeepers: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => []),
    connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://connect.example.test' })),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://reconnect.example.test' })),
    provisionAmbientAccount: vi.fn<(vendorId: string) => Promise<void>>(async () => {}),
    subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber, filter: { includeForcedAutoProvisionedAccounts: boolean }) => Promise<{ [Symbol.dispose](): void }>>(),
  },
  subscriber: undefined as ConnectedAccountsSubscriber | undefined,
  subscriptionDisposed: vi.fn<() => void>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import {
  GettingStartedPage,
  GettingStartedPageContent,
  isJarvisAccount,
  isTeamPiCodexModel,
  isWorkItemVendor,
} from './getting-started'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Getting started', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    testState.subscriber = undefined
    testState.subscriptionDisposed.mockClear()
    vi.clearAllMocks()
  })

  it('recognizes deployment-managed Team PI Codex models', () => {
    expect(isTeamPiCodexModel({ type: 'agent', id: 'team-pi-codex/gpt-5.6-sol', name: 'Managed' })).toBe(true)
    expect(isTeamPiCodexModel({ type: 'agent', id: 'openai/gpt-5', name: 'Team PI Codex fallback' })).toBe(false)
    expect(isTeamPiCodexModel({ type: 'agent', id: 'openai/gpt-5', name: 'GPT-5' })).toBe(false)
  })

  it('uses precise readiness predicates for JARVIS and native work item providers', () => {
    expect(isJarvisAccount({
      id: 1,
      accountDescription: { displayName: 'Management UI only', avatar: { url: '' }, providesUi: { title: 'JARVIS UI' } },
      vendorDescription: { displayName: 'Other', url: 'https://example.test' },
      vendorId: 'other',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isJarvisAccount({
      id: 4,
      accountDescription: { displayName: 'JARVIS unavailable', avatar: { url: '' } },
      vendorDescription: { displayName: 'JARVIS', url: 'https://example.test' },
      vendorId: 'jarvis',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isJarvisAccount({
      id: 2,
      accountDescription: { displayName: 'Repo knowledge', avatar: { url: '' }, singleton: { tsType: 'JarvisSession' } },
      vendorDescription: { displayName: 'Other', url: 'https://example.test' },
      vendorId: 'other',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(true)
    expect(isJarvisAccount({
      id: 3,
      accountDescription: { displayName: 'Context Library', avatar: { url: '' }, singleton: { tsType: 'ContextSession' } },
      vendorDescription: { displayName: 'Context', url: 'https://example.test' },
      vendorId: 'context',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isWorkItemVendor({ id: 'github' })).toBe(false)
    expect(isWorkItemVendor({ id: 'jira' })).toBe(true)
    expect(isWorkItemVendor({ id: 'zendesk' })).toBe(true)
  })

  it('clearly distinguishes model, JARVIS, production investigation, and Work Items paths', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent
        readiness={{
          models: [{ type: 'agent', id: 'team-pi-codex/gpt-6-astra', name: 'GPT-6 Astra' }],
          accounts: [{
            id: 1,
            accountDescription: {
              displayName: 'JARVIS',
              avatar: { url: '' },
              singleton: { tsType: 'JarvisSession' },
            },
            vendorDescription: { displayName: 'JARVIS', url: 'https://example.test', autoProvisionsAccount: true },
            vendorId: 'jarvis',
            supportedResources: [],
            credentialsValid: true,
          }],
          vendors: [
            {
              id: 'jira',
              description: { displayName: 'Jira', url: 'https://example.test' },
              supportedResources: [],
            },
            { id: 'zendesk', description: { displayName: 'Zendesk', url: 'https://example.test' }, supportedResources: [] },
            {
              id: 'github',
              description: { displayName: 'GitHub', url: 'https://example.test' },
              supportedResources: [],
            },
          ],
          addableGatekeepers: [],
          modelsLoaded: true,
          accountsLoaded: true,
          vendorsLoaded: true,
          loadError: false,
        }}
      />,
    ))

    expect(container.textContent).toContain('Team PI Codex is a deployment-managed model route')
    expect(container.textContent).toContain('Prompt links below only prepare text')
    expect(container.textContent).toContain('Prepare Codex prompt')
    expect(container.textContent).toContain('JARVIS is an ambient binding')
    expect(container.textContent).toContain('Never connect Odie directly to raw production MCP')
    expect(container.textContent).toContain('Provider writes remain approval-gated')
    expect(container.textContent).toContain('Developer setup')
    expect(container.textContent).toContain('Connect GitHub')
    expect(container.textContent).toContain('Route Jira and Zendesk')
    expect(container.textContent).toContain('Developer Delivery Kit')
    expect(container.textContent).toContain('Open a coding session')
    expect([...container.querySelectorAll('a')].some((link) => link.getAttribute('href') === '/gatekeepers')).toBe(true)
  })

  it('shows actionable developer setup without claiming unavailable integrations are connected', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent
        readiness={{
          models: [],
          accounts: [],
          vendors: [
            { id: 'github', description: { displayName: 'GitHub', url: 'https://github.test' }, supportedResources: [] },
            { id: 'mcp', description: { displayName: 'MCP Server', url: 'https://mcp.test' }, supportedResources: [] },
          ],
          addableGatekeepers: [],
          modelsLoaded: true,
          accountsLoaded: true,
          vendorsLoaded: true,
          loadError: false,
        }}
      />,
    ))

    expect(container.textContent).toContain('0 / 4')
    expect(container.textContent).toContain('Ask an administrator to install the native Jira and Zendesk providers')
    expect(container.textContent).toContain('Admin required')
    expect(container.textContent).not.toContain('Ready to build')
  })

  it('does not count an expired JARVIS account as ready', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent readiness={{
        models: [{ type: 'agent', id: 'team-pi-codex/gpt-5.6-sol', name: 'Managed' }],
        accounts: [{
          id: 9,
          accountDescription: { displayName: 'JARVIS', avatar: { url: '' }, singleton: { tsType: 'JarvisSession' } },
          vendorDescription: { displayName: 'JARVIS', url: 'https://jarvis.test' },
          vendorId: 'jarvis',
          supportedResources: [],
          credentialsValid: false,
        }],
        vendors: [],
        addableGatekeepers: [],
        modelsLoaded: true,
        accountsLoaded: true,
        vendorsLoaded: true,
        loadError: false,
      }} />,
    ))

    expect(container.textContent).toContain('1 / 4')
    expect(container.textContent).not.toContain('Ready to build')
  })

  it('reconnects an expired native Jira account instead of creating a duplicate', async () => {
    const popup = { location: { href: 'about:blank' }, close: vi.fn<() => void>() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent readiness={{
        models: [],
        accounts: [{
          id: 42,
          accountDescription: { displayName: 'Jira', avatar: { url: '' } },
          vendorDescription: { displayName: 'Jira', url: 'https://jira.test' },
          vendorId: 'jira',
          supportedResources: [],
          credentialsValid: false,
        }],
        vendors: [
          { id: 'jira', description: { displayName: 'Jira', url: 'https://jira.test' }, supportedResources: [] },
          { id: 'zendesk', description: { displayName: 'Zendesk', url: 'https://zendesk.test' }, supportedResources: [] },
        ],
        addableGatekeepers: [],
        modelsLoaded: true,
        accountsLoaded: true,
        vendorsLoaded: true,
        loadError: false,
      }} />,
    ))

    const reconnect = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Reconnect Jira'))
    expect(reconnect).toBeDefined()
    await act(async () => { reconnect!.click(); await Promise.resolve() })

    expect(testState.authenticatedApi.reconnectAccount).toHaveBeenCalledWith(42)
    expect(testState.authenticatedApi.connectAccount).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(popup.location.href).toBe('https://reconnect.example.test')
  })

  it('does not treat an unrelated connectable vendor as Work Items readiness', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent
        readiness={{
          models: [],
          accounts: [],
          vendors: [{
            id: 'github',
            description: { displayName: 'GitHub', url: 'https://example.test' },
            supportedResources: [],
          }],
          addableGatekeepers: [],
          modelsLoaded: true,
          accountsLoaded: true,
          vendorsLoaded: true,
          loadError: false,
        }}
      />,
    ))

    expect(container.textContent).toContain('Native Jira or Zendesk is not listed')
    expect(container.textContent).not.toContain('connect Jira and Zendesk before asking for provider reads')
  })

  it('subscribes to forced accounts and disposes the live RPC subscription on unmount', async () => {
    testState.authenticatedApi.subscribeConnectedAccounts.mockImplementation(async (subscriber, filter) => {
      testState.subscriber = subscriber as ConnectedAccountsSubscriber
      expect(filter).toEqual({ includeForcedAutoProvisionedAccounts: true })
      subscriber.ready()
      return { [Symbol.dispose]: testState.subscriptionDisposed }
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<GettingStartedPage />))

    expect(testState.authenticatedApi.listModels).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.listGatekeeperVendors).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.listAddableGatekeepers).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.subscribeConnectedAccounts).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Team PI Codex model')

    act(() => root!.unmount())
    expect(testState.subscriptionDisposed).toHaveBeenCalledOnce()
  })
})
