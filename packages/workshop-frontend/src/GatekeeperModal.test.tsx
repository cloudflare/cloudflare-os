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
  ready: null as boolean | null,
  collectedUrl: 'https://catalog.example.com/',
  toasts: [] as { title: string, variant: string }[],
  frameKeys: [] as number[],
  ensureResources: null as ((patterns: string[]) => Promise<boolean>) | null,
  configurator: null as {
    acceptedResourceUrlPatterns: readonly string[]
    initialResourceUrl?: string
    resourceUrlPattern?: string
  } | null,
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
    acceptedResourceUrlPatterns,
    initialResourceUrl,
    resourceUrlPattern,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
    onEnsureResources,
  }: {
    frame: object | null
    frameKey: number | null
    loading: boolean
    disabled: boolean
    acceptedResourceUrlPatterns: readonly string[]
    initialResourceUrl?: string
    resourceUrlPattern?: string
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    onEnsureResources?: (patterns: string[]) => Promise<boolean>
  }) => {
    useEffect(() => {
      testState.configurator = { acceptedResourceUrlPatterns, initialResourceUrl, resourceUrlPattern }
    }, [acceptedResourceUrlPatterns, initialResourceUrl, resourceUrlPattern])
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
      onCollectResourceUrlChange?.(() => Promise.resolve(testState.collectedUrl))
      testState.readinessEvents.push(testState.ready)
      onSelectionReadyChange?.(testState.ready)
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
  testState.ready = null
  testState.collectedUrl = 'https://catalog.example.com/'
  testState.toasts = []
  testState.frameKeys = []
  testState.ensureResources = null
  api.subscriber = null
  api.startResourceConfigurator.mockReset()
  api.ensureAccountResources.mockReset()
  openConnectWindow.mockReset()
  testState.configurator = null
  vi.unstubAllGlobals()
})

async function renderModal(props: {
  initialVendorId?: string
  initialResourceUrl?: string
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

describe('GatekeeperModal grouped resource types', () => {
  const CATALOG = {
    urlPattern: 'https://catalog.example.com/:path+',
    title: 'Whole catalog',
    description: 'Every service',
    grantable: true,
  }
  const SERVICE = {
    urlPattern: 'https://catalog.example.com/services/:id',
    title: 'Service',
    description: 'One service',
    grantable: true,
    groupedWith: CATALOG.urlPattern,
  }
  // The catalog's pattern also matches a service's URL, as a GitLab project's matches a merge
  // request's, so the vendor declares the more specific type first: resolving a URL takes the first
  // match.
  const GROUPED = { resource: SERVICE, otherResources: [CATALOG] }
  const BOTH_GRANTED = [CATALOG.urlPattern, SERVICE.urlPattern]

  const buttons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
  const buttonLabels = () => buttons().map(button => button.textContent)
  const button = (label: string) => buttons().find(candidate => candidate.textContent === label)!

  it('lists grouped types as one card', async () => {
    await renderModal({}, { ...GROUPED, granted: BOTH_GRANTED })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-controls="connection-group-panel-vendor:catalog"]')).not.toBeNull()
    })
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[aria-controls="connection-group-panel-vendor:catalog"]')!.click())

    expect(Array.from(document.getElementById('connection-group-panel-vendor:catalog')!
      .querySelectorAll('button p:first-child'), title => title.textContent)).toEqual([CATALOG.title])
  })

  // The agent asked for a service, so the card that picks services opens on it, while the user may
  // still choose anything the card offers.
  it('opens an agent request for a grouped type on its card, pre-filled', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    const initialResourceUrl = 'https://catalog.example.com/services/s1'
    await renderModal(
      { initialVendorId: 'catalog', initialResourceUrl, initialResourceUrlPattern: SERVICE.urlPattern },
      { ...GROUPED, granted: BOTH_GRANTED },
    )

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
    })
    expect(api.startResourceConfigurator.mock.calls).toEqual([[1, CATALOG.urlPattern]])
    expect(testState.configurator).toEqual({
      acceptedResourceUrlPatterns: [SERVICE.urlPattern, CATALOG.urlPattern],
      initialResourceUrl,
      resourceUrlPattern: SERVICE.urlPattern,
    })
  })

  it('asks an account holding none of a card\'s types for all of them before the configurator opens', async () => {
    stubResizeObserver()
    api.ensureAccountResources.mockResolvedValue(null)
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: CATALOG.urlPattern }, {
      ...GROUPED,
      granted: [],
    })

    await vi.waitFor(() => expect(buttonLabels()).toContain('Grant access'))
    expect(document.body.querySelector('[data-testid="resource-configurator"]')).toBeNull()
    await act(async () => button('Grant access').click())
    expect(api.ensureAccountResources.mock.calls).toEqual([[1, [SERVICE.urlPattern, CATALOG.urlPattern]]])
  })

  // Grouping grants nothing: an account that granted the catalog before services joined its card
  // keeps connecting the catalog, and is asked for services only when it wants them.
  it('offers an account the grouped types it has granted, asks for the rest, then offers them too', async () => {
    stubResizeObserver()
    api.ensureAccountResources.mockResolvedValue(null)
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: CATALOG.urlPattern }, {
      ...GROUPED,
      granted: [CATALOG.urlPattern],
    })

    await vi.waitFor(() => expect(testState.frameKeys).toHaveLength(1))
    expect(testState.configurator?.acceptedResourceUrlPatterns).toEqual([CATALOG.urlPattern])
    await act(async () => button('Grant access').click())
    expect(api.ensureAccountResources.mock.calls).toEqual([[1, [SERVICE.urlPattern]]])

    await act(async () => api.subscriber!.add(
      1, accountDescription(1, BOTH_GRANTED), VENDOR, [SERVICE, CATALOG], true, 'catalog'))
    await vi.waitFor(() => expect(testState.frameKeys).toHaveLength(2))
    expect(testState.configurator?.acceptedResourceUrlPatterns).toEqual([SERVICE.urlPattern, CATALOG.urlPattern])
  })

  // A type that isn't separately grantable is covered by the account's connection, so the card
  // offers it without waiting for the types that are.
  it('offers a card\'s type that isn\'t separately grantable before its grantable types are granted', async () => {
    stubResizeObserver()
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: CATALOG.urlPattern }, {
      resource: SERVICE,
      otherResources: [{ ...CATALOG, grantable: false }],
      granted: [],
    })

    await vi.waitFor(() => expect(testState.frameKeys).toHaveLength(1))
    expect(testState.configurator?.acceptedResourceUrlPatterns).toEqual([CATALOG.urlPattern])
    expect(buttonLabels()).toContain('Grant access')
  })

  // A configurator should offer only the types the account holds; one that returns another anyway
  // does not get it connected.
  it('refuses to connect a grouped type the account has not granted', async () => {
    stubResizeObserver()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    testState.ready = true
    testState.collectedUrl = 'https://catalog.example.com/services/s1'
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: CATALOG.urlPattern }, {
      ...GROUPED,
      granted: [CATALOG.urlPattern],
    })

    await vi.waitFor(() => expect(button('Add connection').disabled).toBe(false))
    await act(async () => button('Add connection').click())
    expect(testState.toasts).toEqual([{ title: 'Grant access to Service to connect it.', variant: 'error' }])
  })

  // A URL no narrower type names binds the whole-instance catch-all, which the check must see too.
  it('refuses to connect a grouped catch-all type the account has not granted', async () => {
    stubResizeObserver()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    testState.ready = true
    testState.collectedUrl = 'https://catalog.example.com/'
    const wholeInstance = { ...CATALOG, urlPattern: 'https://*' }
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: wholeInstance.urlPattern }, {
      resource: { ...SERVICE, groupedWith: wholeInstance.urlPattern },
      otherResources: [wholeInstance],
      granted: [SERVICE.urlPattern],
    })

    await vi.waitFor(() => expect(button('Add connection').disabled).toBe(false))
    await act(async () => button('Add connection').click())
    expect(testState.toasts).toEqual([{ title: 'Grant access to Whole catalog to connect it.', variant: 'error' }])
  })

  it('finds a grouped card by searching for any type on it', async () => {
    await renderModal({}, {
      resource: { ...SERVICE, title: 'Pipeline', description: 'One pipeline' },
      otherResources: [CATALOG],
      granted: BOTH_GRANTED,
    })
    const search = await vi.waitFor(() =>
      document.body.querySelector<HTMLInputElement>('input[placeholder="Search services, apps, data sources..."]')!)

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'pipeline')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(Array.from(document.body.querySelectorAll('button p:first-child'), title => title.textContent))
      .toEqual([CATALOG.title])
  })
})

describe('GatekeeperModal agent spawner request', () => {
  // The chat's accept flow keeps the modal mounted and opens it for each request.
  it('opens on the Agent form when reopened for an agent spawner request', async () => {
    testState.authenticatedApi = authenticatedApi()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = (open: boolean) => act(async () => root!.render(<GatekeeperModal
      open={open}
      onClose={() => {}}
      getOverseer={() => { throw new Error('not called') }}
      onCreated={() => Promise.resolve()}
      initialVendorId={open ? 'agent-spawner' : undefined}
    />))

    await render(false)
    await render(true)

    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-label="Agent display name"]')).not.toBeNull()
    })
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
