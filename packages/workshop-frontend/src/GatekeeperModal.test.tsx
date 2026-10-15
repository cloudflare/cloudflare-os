// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AuthenticatedApi, ConnectedAccountsSubscriber, ConnectFlowStart, ModelKind,
} from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { AuthPopupCancelledError } from './features/native-app/authPopup'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  readinessEvents: [] as (boolean | null)[],
  toasts: [] as { title: string, variant: string }[],
  frameKeys: [] as number[],
  ensureResources: null as ((patterns: string[]) => Promise<boolean>) | null,
}))

const { openConnectWindow } = vi.hoisted(() => ({
  openConnectWindow: vi.fn<(flow: ConnectFlowStart, api: unknown) => Promise<'opened' | 'connected'>>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({
    add: (toast: { title: string, variant: string }) => { testState.toasts.push(toast) },
  }),
}))

vi.mock('./connectHandoff', () => ({ openConnectWindow }))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('./ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    frame,
    frameKey,
    loading,
    disabled,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
    onEnsureResources,
  }: {
    frame: object | null
    frameKey: number | null
    loading: boolean
    disabled: boolean
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    onEnsureResources?: (patterns: string[]) => Promise<boolean>
  }) => {
    const mounted = Boolean(frame && !loading && !disabled)
    useEffect(() => {
      testState.ensureResources = mounted ? onEnsureResources ?? null : null
    }, [mounted, onEnsureResources])
    // The real host keys its iframe by frameKey, so a new key is a restarted configurator.
    useEffect(() => {
      if (mounted && frameKey !== null) testState.frameKeys.push(frameKey)
    }, [mounted, frameKey])
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => Promise.resolve('https://catalog.example.com/'))
      testState.readinessEvents.push(null)
      onSelectionReadyChange?.(null)
      return () => onCollectResourceUrlChange?.(null)
    }, [mounted, onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { default: ResourceConfiguratorHost }
})

import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE = {
  urlPattern: 'https://catalog.example.com/*',
  title: 'Service catalog',
  description: 'Example service catalog',
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

const IMPORT_GRANT = 'https://catalog.example.com/import'

const CHAT_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'chat-model', name: 'Chat model' }
const DECISION_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'decision-model', name: 'Decision model' }

const VENDOR = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }

function accountDescription(id: number, grantedResourceUrlPatterns?: string[]) {
  return {
    displayName: `Catalog account ${id}`,
    avatar: { url: 'https://catalog.example.com/avatar' },
    grantedResourceUrlPatterns,
  }
}

const api = vi.hoisted(() => ({
  subscriber: null as ConnectedAccountsSubscriber | null,
  startResourceConfigurator: vi.fn<(accountId: number, resourceUrlPattern: string) => Promise<object>>(),
  ensureAccountResources: vi.fn<(accountId: number, patterns: string[]) => Promise<ConnectFlowStart | null>>(),
}))

function authenticatedApi({ resource = RESOURCE, otherResources = [], accountIds = [1], granted }: {
  resource?: SupportedResource
  otherResources?: SupportedResource[]
  accountIds?: number[]
  granted?: string[]
} = {}): RpcStub<AuthenticatedApi> {
  const resources = [resource, ...otherResources]
  api.startResourceConfigurator.mockImplementation(async () => ({
    iframeHtml: '<!doctype html>',
    ui: { [Symbol.dispose]() {} },
  }))
  return {
    listModels: async (kind?: ModelKind) => kind === 'decision' ? [DECISION_MODEL] : [CHAT_MODEL],
    listGatekeeperVendors: async () => [{
      id: 'catalog',
      description: VENDOR,
      supportedResources: resources,
    }],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      api.subscriber = subscriber
      for (const id of accountIds) {
        subscriber.add(id, accountDescription(id, granted), VENDOR, resources, true, 'catalog')
      }
      subscriber.ready()
      return subscription()
    },
    startResourceConfigurator: api.startResourceConfigurator,
    ensureAccountResources: api.ensureAccountResources,
  } as unknown as RpcStub<AuthenticatedApi>
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  testState.authenticatedApi = null
  testState.readinessEvents = []
  testState.toasts = []
  testState.frameKeys = []
  testState.ensureResources = null
  api.subscriber = null
  api.startResourceConfigurator.mockReset()
  api.ensureAccountResources.mockReset()
  openConnectWindow.mockReset()
  vi.unstubAllGlobals()
})

async function renderModal(props: {
  initialVendorId?: string
  initialResourceUrlPattern?: string
  initialAccountId?: number
} = {}, apiOptions: Parameters<typeof authenticatedApi>[0] = {}) {
  testState.authenticatedApi = authenticatedApi(apiOptions)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => root!.render(<GatekeeperModal
    open
    onClose={() => {}}
    getOverseer={() => { throw new Error('not called') }}
    onCreated={() => Promise.resolve()}
    {...props}
  />))
}

describe('GatekeeperModal configurator readiness', () => {
  it('keeps Add connection disabled for a lifecycle null readiness event', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: RESOURCE.urlPattern })

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
      expect(testState.readinessEvents).toEqual([null])
    })

    const addConnection = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Add connection')!
    expect(addConnection.disabled).toBe(true)
  })
})

describe('GatekeeperModal model pickers', () => {
  // A decision model can back an AI Model binding but can't run an agent. The AI Model picker labels
  // each model with its kind.
  it.each([
    { groupKey: 'platform:ai-model', picker: 'Select an AI model',
      options: ['Language models: Chat model', 'Decision models: Decision model'] },
    { groupKey: 'platform:agent-spawner', picker: 'Agent model', options: ['None (no agent)', 'Chat model'] },
  ])('offers $options in the $groupKey picker', async ({ groupKey, picker, options }) => {
    await renderModal()

    const group = document.body.querySelector<HTMLButtonElement>(
      `[aria-controls="connection-group-panel-${groupKey}"]`)!
    await act(async () => group.click())
    await act(async () => document.getElementById(`connection-group-panel-${groupKey}`)!
      .querySelector('button')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[aria-label="${picker}"]`)!.click())

    expect(Array.from(document.body.querySelectorAll('[role="option"]'), option => {
      const heading = option.closest('[role="group"]')?.getAttribute('aria-labelledby')
      return heading ? `${document.getElementById(heading)!.textContent}: ${option.textContent}` : option.textContent
    })).toEqual(options)
  })
})

function stubResizeObserver() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
}

async function renderConfigurator(props: { initialAccountId?: number } = {},
  apiOptions: Parameters<typeof authenticatedApi>[0] = {}) {
  stubResizeObserver()
  await renderModal({
    initialVendorId: 'catalog', initialResourceUrlPattern: RESOURCE.urlPattern, ...props,
  }, apiOptions)
  await vi.waitFor(() => expect(testState.ensureResources).not.toBeNull())
  return testState.ensureResources!
}

const FLOW: ConnectFlowStart = { url: 'https://catalog.example.com/consent', nonce: 'n'.repeat(64) }

describe('GatekeeperModal configurator access requests', () => {
  it('resolves true without a pop-up when the account already holds the grants', async () => {
    api.ensureAccountResources.mockResolvedValue(null)
    const ensureResources = await renderConfigurator()

    await expect(ensureResources([IMPORT_GRANT])).resolves.toBe(true)

    expect(api.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(1, [IMPORT_GRANT])
    expect(openConnectWindow).not.toHaveBeenCalled()
    expect(testState.toasts).toEqual([])
  })

  it.each([
    { outcome: 'opened' as const, toast: 'Grant the additional access in the pop-up window.' },
    { outcome: 'connected' as const, toast: 'Access granted.' },
  ])('resolves false when the consent pop-up resolves $outcome', async ({ outcome, toast }) => {
    api.ensureAccountResources.mockResolvedValue(FLOW)
    openConnectWindow.mockResolvedValue(outcome)
    const ensureResources = await renderConfigurator()

    await expect(ensureResources([IMPORT_GRANT])).resolves.toBe(false)

    expect(openConnectWindow).toHaveBeenCalledExactlyOnceWith(FLOW, testState.authenticatedApi)
    expect(testState.toasts).toEqual([{ title: toast, variant: 'success' }])
  })

  it('rejects to the configurator when the user cancels the pop-up, without a toast', async () => {
    api.ensureAccountResources.mockResolvedValue(FLOW)
    openConnectWindow.mockRejectedValue(new AuthPopupCancelledError())
    const ensureResources = await renderConfigurator()

    await expect(ensureResources([IMPORT_GRANT])).rejects.toBeInstanceOf(AuthPopupCancelledError)
    expect(testState.toasts).toEqual([])
  })

  it('rejects to the configurator when the request fails', async () => {
    api.ensureAccountResources.mockRejectedValue(new Error('Unknown resource pattern.'))
    const ensureResources = await renderConfigurator()

    await expect(ensureResources([IMPORT_GRANT])).rejects.toThrow('Unknown resource pattern.')
    expect(openConnectWindow).not.toHaveBeenCalled()
  })

  it('asks for the account the configurator was started on', async () => {
    api.ensureAccountResources.mockResolvedValue(null)
    const ensureResources = await renderConfigurator({ initialAccountId: 2 }, { accountIds: [1, 2] })

    expect(api.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(2, RESOURCE.urlPattern)
    await ensureResources([IMPORT_GRANT])
    expect(api.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(2, [IMPORT_GRANT])
  })

  it('keeps the configurator running when a grant arrives for its account', async () => {
    await renderConfigurator()
    expect(testState.frameKeys).toHaveLength(1)

    await act(async () => api.subscriber!.add(
      1, accountDescription(1, [IMPORT_GRANT]), VENDOR, [RESOURCE], true, 'catalog'))

    expect(api.startResourceConfigurator).toHaveBeenCalledTimes(1)
    expect(testState.frameKeys).toHaveLength(1)
    expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
  })
})

describe('GatekeeperModal initial account', () => {
  it('selects the first valid account when none is given', async () => {
    await renderConfigurator({}, { accountIds: [1, 2] })

    expect(api.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(1, RESOURCE.urlPattern)
  })

  it('ignores an account the connection has no match for', async () => {
    await renderConfigurator({ initialAccountId: 7 }, { accountIds: [1, 2] })

    expect(api.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(1, RESOURCE.urlPattern)
  })

  it('does not apply to a connection the user picks themselves', async () => {
    const OTHER = { urlPattern: 'https://catalog.example.com/items/*', title: 'Catalog items', description: 'Items' }
    stubResizeObserver()
    // No connection matches the pre-seeded pattern, so the user picks one from the list.
    await renderModal(
      { initialVendorId: 'catalog', initialResourceUrlPattern: 'https://elsewhere.example.com/*', initialAccountId: 2 },
      { otherResources: [OTHER], accountIds: [1, 2] },
    )
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[aria-controls="connection-group-panel-vendor:catalog"]')!.click())
    const item = Array.from(document.getElementById('connection-group-panel-vendor:catalog')!
      .querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes(OTHER.title))!
    await act(async () => item.click())

    await vi.waitFor(() => expect(testState.ensureResources).not.toBeNull())
    expect(api.startResourceConfigurator).toHaveBeenLastCalledWith(1, OTHER.urlPattern)
    expect(api.startResourceConfigurator.mock.calls.map(([accountId]) => accountId)).not.toContain(2)
  })
})

describe('GatekeeperModal resource grant step', () => {
  const GRANTABLE = { ...RESOURCE, grantable: true }

  async function clickGrantAccess() {
    stubResizeObserver()
    await renderModal(
      { initialVendorId: 'catalog', initialResourceUrlPattern: GRANTABLE.urlPattern },
      { resource: GRANTABLE, granted: [] },
    )
    const grant = await vi.waitFor(() => {
      const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find(candidate => candidate.textContent === 'Grant access')
      expect(button).toBeDefined()
      return button!
    })
    await act(async () => grant.click())
  }

  it('opens the consent pop-up for the missing grant', async () => {
    api.ensureAccountResources.mockResolvedValue(FLOW)
    openConnectWindow.mockResolvedValue('opened')
    await clickGrantAccess()

    expect(api.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(1, [GRANTABLE.urlPattern])
    expect(openConnectWindow).toHaveBeenCalledExactlyOnceWith(FLOW, testState.authenticatedApi)
    expect(testState.toasts).toEqual([
      { title: 'Grant the additional access in the pop-up window.', variant: 'success' },
    ])
    expect(api.startResourceConfigurator).not.toHaveBeenCalled()
  })

  it('stays quiet when the user cancels the pop-up', async () => {
    api.ensureAccountResources.mockResolvedValue(FLOW)
    openConnectWindow.mockRejectedValue(new AuthPopupCancelledError())
    await clickGrantAccess()

    expect(testState.toasts).toEqual([])
  })

  it('shows the error when the request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      api.ensureAccountResources.mockRejectedValue(new Error('Account is gone.'))
      await clickGrantAccess()

      expect(openConnectWindow).not.toHaveBeenCalled()
      expect(testState.toasts).toEqual([{ title: 'Account is gone.', variant: 'error' }])
    } finally {
      consoleError.mockRestore()
    }
  })
})
