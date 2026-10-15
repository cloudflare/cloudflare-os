// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  ConnectedAccountsSubscriber,
  ConnectFlowStart,
  ModelKind,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  collectResourceUrl: () => Promise.resolve(
    'https://calendar.google.com/calendar/recipient%40example.com/?availability=thisCalendar',
  ),
  selectionReady: (_resourceUrl?: string): boolean => true,
  configuratorMounts: [] as {
    initialResourceUrl?: string,
    resourceUrlPattern?: string,
  }[],
  // The mounted configurator frame and the access-request handler its host was given.
  configurator: null as {
    frame: ResourceConfiguratorFrame
    ensureResources: ((patterns: string[]) => Promise<boolean>) | undefined
  } | null,
}))

const openConnectWindow = vi.hoisted(() =>
  vi.fn<(flow: ConnectFlowStart, api: unknown) => Promise<'opened' | 'connected'>>(
    async () => 'opened'))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: 'blueprint-one' }),
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./connectHandoff', () => ({ openConnectWindow }))

vi.mock('./ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    frame,
    loading,
    disabled,
    initialResourceUrl,
    resourceUrlPattern,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
    onEnsureResources,
  }: {
    frame: ResourceConfiguratorFrame | null
    loading: boolean
    disabled: boolean
    initialResourceUrl?: string
    resourceUrlPattern?: string
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    onEnsureResources?: (patterns: string[]) => Promise<boolean>
  }) => {
    const mounted = Boolean(frame && !loading && !disabled)
    useEffect(() => {
      testState.configurator = frame ? { frame, ensureResources: onEnsureResources } : null
    }, [frame, onEnsureResources])
    useEffect(() => {
      if (!mounted) return
      testState.configuratorMounts.push({ initialResourceUrl, resourceUrlPattern })
      onCollectResourceUrlChange?.(() => testState.collectResourceUrl())
      onSelectionReadyChange?.(testState.selectionReady(initialResourceUrl))
      return () => {
        onCollectResourceUrlChange?.(null)
        onSelectionReadyChange?.(null)
      }
    }, [mounted, initialResourceUrl, resourceUrlPattern,
      onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { default: ResourceConfiguratorHost }
})

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const DECISION_MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'decision-one',
  name: 'Decision one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

const CALENDAR_PATTERN = 'https://calendar.google.com/calendar/:calendarId/*'
const GMAIL_PATTERN = 'https://mail.google.com/*'
const CREATOR_CALENDAR_URL =
  'https://calendar.google.com/calendar/creator%40example.com/?availability=thisCalendar'
const CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: CALENDAR_PATTERN,
  title: 'Google Calendar',
  description: 'Read and manage one selected calendar.',
  grantable: true,
}
const GOOGLE_VENDOR: VendorDescription = {
  displayName: 'Google',
  url: 'https://google.com',
}
const CALENDAR_BLUEPRINT = {
  ...BLUEPRINT,
  metadata: {
    ...BLUEPRINT.metadata,
    title: 'Calendar blueprint',
    description: 'Requires Google Calendar.',
    bindings: {
      CALENDAR: {
        type: 'gatekeeper',
        title: 'Google Calendar',
        description: '',
        gatekeeperName: 'google',
        typeUrlPattern: CALENDAR_PATTERN,
        resourceUrl: CREATOR_CALENDAR_URL,
      },
    },
  },
} satisfies BlueprintPublicInfo

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  return {
    listModels: async (kind?: ModelKind) => kind === 'decision' ? [DECISION_MODEL] : [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
  } as unknown as RpcStub<AuthenticatedApi>
}

function publicApi(blueprint: BlueprintPublicInfo): RpcStub<PublicApi> {
  return {
    getBlueprint: async () => blueprint,
  } as unknown as RpcStub<PublicApi>
}

function findButton(label: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent === label)
}

describe('BlueprintLandingPage model configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  // Opens the model picker of the blueprint's binding, returning the picker's trigger.
  const openModelPicker = async (blueprint = BLUEPRINT) => {
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi(blueprint)} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Configure')!
    await act(async () => configure.click())

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!
    await act(async () => trigger.click())
    return trigger
  }

  it('portals model options above the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    const trigger = await openModelPicker()

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    const portalHost = option.closest('[data-base-ui-portal]')!.parentElement!
    expect(portalHost.parentElement).toBe(document.body)
    expect(portalHost.style.position).toBe('relative')
    expect(portalHost.style.zIndex).toBe('1100')

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Save connection')!
    expect(save.disabled).toBe(false)
  })

  it.each([
    { kind: 'language', modelKind: undefined, options: ['Model one'] },
    { kind: 'decision', modelKind: 'decision' as const, options: ['Decision one'] },
  ])('offers a $kind model binding only models of its kind', async ({ modelKind, options }) => {
    await openModelPicker({
      ...BLUEPRINT,
      metadata: {
        ...BLUEPRINT.metadata,
        bindings: { AI: { type: 'aiModel', title: 'Model', description: '', modelKind } },
      },
    })

    expect(Array.from(document.body.querySelectorAll('[role="option"]'), option => option.textContent))
      .toEqual(options)
  })
})

type GatekeeperApiHarness = ReturnType<typeof gatekeeperApi>

function googleAccount(id: number, grantedResourceUrlPatterns: string[]): AccountDescription {
  return {
    displayName: `Recipient ${id}`,
    uniqueName: `recipient-${id}@example.com`,
    avatar: { url: 'https://example.com/avatar' },
    grantedResourceUrlPatterns,
  }
}

function gatekeeperApi(initialGrants: string[] | null, secondAccountGrants?: string[]) {
  let subscriber: ConnectedAccountsSubscriber | null = null
  const startResourceConfigurator = vi.fn<
    (accountId: number, resourceUrlPattern: string) => Promise<ResourceConfiguratorFrame>
  >().mockResolvedValue({
    iframeHtml: '<!doctype html>',
    ui: { [Symbol.dispose]() {} } as ResourceConfiguratorFrame['ui'],
  })
  const ensureAccountResources = vi.fn<
    (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
  >().mockResolvedValue({ url: 'https://accounts.example.com/grant', nonce: 'g'.repeat(64) })
  const connectAccount = vi.fn<
    (vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>
  >().mockResolvedValue({ url: 'https://accounts.example.com/connect', nonce: 'c'.repeat(64) })
  const reconnectAccount = vi.fn<
    (accountId: number) => Promise<ConnectFlowStart>
  >().mockResolvedValue({ url: 'https://accounts.example.com/reconnect', nonce: 'r'.repeat(64) })
  const api = {
    ...(authenticatedApi() as object),
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: GOOGLE_VENDOR,
      supportedResources: [CALENDAR_RESOURCE],
    }],
    subscribeConnectedAccounts: (nextSubscriber: ConnectedAccountsSubscriber) => {
      subscriber = nextSubscriber
      if (initialGrants) {
        subscriber.add(7, googleAccount(7, initialGrants), GOOGLE_VENDOR, [CALENDAR_RESOURCE], true, 'google')
      }
      if (secondAccountGrants) {
        subscriber.add(8, googleAccount(8, secondAccountGrants), GOOGLE_VENDOR, [CALENDAR_RESOURCE], true, 'google')
      }
      subscriber.ready()
      return subscription()
    },
    startResourceConfigurator,
    ensureAccountResources,
    connectAccount,
    reconnectAccount,
  } as unknown as RpcStub<AuthenticatedApi>

  return {
    api,
    startResourceConfigurator,
    ensureAccountResources,
    connectAccount,
    reconnectAccount,
    updateGrants(grants: string[]) {
      if (!subscriber) throw new Error('account subscriber is not ready')
      subscriber.add(7, googleAccount(7, grants), GOOGLE_VENDOR, [CALENDAR_RESOURCE], true, 'google')
    },
    addAccount(id: number, grants: string[]) {
      if (!subscriber) throw new Error('account subscriber is not ready')
      subscriber.add(id, googleAccount(id, grants), GOOGLE_VENDOR, [CALENDAR_RESOURCE], true, 'google')
    },
    removeAccount(id: number) {
      if (!subscriber) throw new Error('account subscriber is not ready')
      subscriber.remove(id)
    },
  }
}

describe('BlueprintLandingPage gatekeeper configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    testState.collectResourceUrl = () => Promise.resolve(
      'https://calendar.google.com/calendar/recipient%40example.com/?availability=thisCalendar',
    )
    testState.selectionReady = () => true
    testState.configuratorMounts = []
    openConnectWindow.mockReset()
  })

  async function render(
    harness: GatekeeperApiHarness,
    blueprint: BlueprintPublicInfo = CALENDAR_BLUEPRINT,
  ) {
    testState.authenticatedApi = harness.api
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(
      <BlueprintLandingPage rpcStub={publicApi(blueprint)} />,
    ))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }

  const RECIPIENT_CALENDAR_URL =
    'https://calendar.google.com/calendar/recipient%40example.com/?availability=thisCalendar'

  async function saveCalendarConnection() {
    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(findButton('Save connection')!.disabled).toBe(false))
    await act(async () => findButton('Save connection')!.click())
    await vi.waitFor(() => expect(findButton('Create Gadget')).toBeDefined())
  }

  it('shows the recommendation without prefilling it into the configurator', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN])
    await render(harness)
    expect(findButton('Configure 1 remaining connection')).toBeDefined()

    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(testState.configuratorMounts).toEqual([{
      initialResourceUrl: undefined,
      resourceUrlPattern: CALENDAR_PATTERN,
    }]))
    expect(document.body.textContent).toContain('calendar/creator%40example.com')
  })

  it('reopens a saved connection prefilled with the saved resource', async () => {
    testState.selectionReady = resourceUrl => resourceUrl !== undefined
    const harness = gatekeeperApi([CALENDAR_PATTERN])
    await render(harness)
    testState.selectionReady = () => true
    await saveCalendarConnection()

    testState.configuratorMounts = []
    await act(async () => findButton('Change')!.click())
    await vi.waitFor(() => expect(testState.configuratorMounts).toEqual([{
      initialResourceUrl: RECIPIENT_CALENDAR_URL,
      resourceUrlPattern: CALENDAR_PATTERN,
    }]))
  })

  it('clears the saved resource when switching accounts', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN], [CALENDAR_PATTERN])
    await render(harness)
    await saveCalendarConnection()

    testState.selectionReady = resourceUrl => resourceUrl !== undefined
    await act(async () => findButton('Change')!.click())
    const secondAccount = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('recipient-8@example.com'))!
    await act(async () => secondAccount.click())

    await vi.waitFor(() => expect(
      testState.configuratorMounts.at(-1)?.initialResourceUrl,
    ).toBeUndefined())
    expect(findButton('Save connection')!.disabled).toBe(true)
  })

  it('invalidates a saved connection when its account disconnects', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN], [CALENDAR_PATTERN])
    await render(harness)
    await saveCalendarConnection()

    await act(async () => harness.removeAccount(7))

    await vi.waitFor(() => expect(findButton('Configure 1 remaining connection')).toBeDefined())
    expect(findButton('Change')).toBeUndefined()
  })

  it('keeps a saved connection while a restarted subscription replays its accounts', async () => {
    const harness = gatekeeperApi([GMAIL_PATTERN], [CALENDAR_PATTERN])
    await render(harness)
    await saveCalendarConnection()

    // A new session whose subscription has replayed account 7 but not yet account 8 or ready().
    testState.authenticatedApi = {
      ...(harness.api as object),
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        subscriber.add(7, googleAccount(7, [GMAIL_PATTERN]), GOOGLE_VENDOR, [CALENDAR_RESOURCE], true, 'google')
        return subscription()
      },
    } as unknown as RpcStub<AuthenticatedApi>
    await act(async () => root!.render(
      <BlueprintLandingPage rpcStub={publicApi(CALENDAR_BLUEPRINT)} />,
    ))

    expect(findButton('Create Gadget')).toBeDefined()
  })

  it('invalidates a saved connection when its account loses the required grant', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN])
    await render(harness)
    await saveCalendarConnection()

    await act(async () => harness.updateGrants([GMAIL_PATTERN]))

    await vi.waitFor(() => expect(findButton('Configure 1 remaining connection')).toBeDefined())
    expect(findButton('Change')).toBeUndefined()
  })

  it('expands a Gmail-only account before starting the Calendar configurator', async () => {
    const harness = gatekeeperApi([GMAIL_PATTERN])
    await render(harness)

    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(findButton('Grant access')).toBeDefined())
    expect(harness.startResourceConfigurator).not.toHaveBeenCalled()

    await act(async () => findButton('Grant access')!.click())
    expect(harness.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(7, [CALENDAR_PATTERN])
    expect(harness.reconnectAccount).not.toHaveBeenCalled()
    expect(openConnectWindow).toHaveBeenCalledExactlyOnceWith({
      url: 'https://accounts.example.com/grant',
      nonce: 'g'.repeat(64),
    }, testState.authenticatedApi)

    await act(async () => harness.updateGrants([GMAIL_PATTERN, CALENDAR_PATTERN]))
    await vi.waitFor(() => expect(harness.startResourceConfigurator)
      .toHaveBeenCalledExactlyOnceWith(7, CALENDAR_PATTERN))
    await vi.waitFor(() => expect(testState.configuratorMounts).toEqual([{
      initialResourceUrl: undefined,
      resourceUrlPattern: CALENDAR_PATTERN,
    }]))
  })

  it('requests only Calendar access when connecting a new account', async () => {
    const harness = gatekeeperApi(null)
    await render(harness)

    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(findButton('Connect Google')).toBeDefined())
    await act(async () => findButton('Connect Google')!.click())

    expect(harness.connectAccount).toHaveBeenCalledExactlyOnceWith('google', [CALENDAR_PATTERN])
  })

  it('unblocks configuration when the server says the resource is already granted', async () => {
    const harness = gatekeeperApi([GMAIL_PATTERN])
    harness.ensureAccountResources.mockResolvedValueOnce(null)
    await render(harness)

    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(findButton('Grant access')).toBeDefined())
    await act(async () => findButton('Grant access')!.click())

    await vi.waitFor(() => expect(harness.startResourceConfigurator)
      .toHaveBeenCalledExactlyOnceWith(7, CALENDAR_PATTERN))
    expect(openConnectWindow).not.toHaveBeenCalled()

    await act(async () => harness.addAccount(8, [CALENDAR_PATTERN]))
    expect(findButton('Grant access')).toBeUndefined()
    expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
  })

  it('selects an account that already holds the grant over one listed first', async () => {
    const harness = gatekeeperApi([GMAIL_PATTERN], [CALENDAR_PATTERN])
    await render(harness)

    await act(async () => findButton('Configure')!.click())

    await vi.waitFor(() => expect(harness.startResourceConfigurator)
      .toHaveBeenCalledExactlyOnceWith(8, CALENDAR_PATTERN))
    expect(harness.ensureAccountResources).not.toHaveBeenCalled()
  })

  it('matches the gatekeeper name case-insensitively', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN])
    await render(harness, {
      ...CALENDAR_BLUEPRINT,
      metadata: {
        ...CALENDAR_BLUEPRINT.metadata,
        bindings: {
          CALENDAR: { ...CALENDAR_BLUEPRINT.metadata.bindings.CALENDAR, gatekeeperName: 'Google' },
        },
      },
    })

    await act(async () => findButton('Configure')!.click())

    await vi.waitFor(() => expect(harness.startResourceConfigurator)
      .toHaveBeenCalledExactlyOnceWith(7, CALENDAR_PATTERN))
  })

  it('expands the account whose Grant access button was clicked', async () => {
    const harness = gatekeeperApi([CALENDAR_PATTERN], [GMAIL_PATTERN])
    await render(harness, {
      ...CALENDAR_BLUEPRINT,
      metadata: {
        ...CALENDAR_BLUEPRINT.metadata,
        bindings: {
          CALENDAR: {
            ...CALENDAR_BLUEPRINT.metadata.bindings.CALENDAR,
            resourceUrl: undefined,
          },
        },
      },
    })

    await act(async () => findButton('Configure')!.click())
    await vi.waitFor(() => expect(findButton('Grant access')).toBeDefined())
    await act(async () => findButton('Grant access')!.click())

    expect(harness.ensureAccountResources).toHaveBeenCalledExactlyOnceWith(8, [CALENDAR_PATTERN])
  })

  it('disables every grant action while an authorization flow is starting', async () => {
    const harness = gatekeeperApi([GMAIL_PATTERN], [GMAIL_PATTERN])
    let resolveGrant: ((flow: ConnectFlowStart | null) => void) | undefined
    harness.ensureAccountResources.mockReturnValueOnce(new Promise(resolve => { resolveGrant = resolve }))
    await render(harness)

    await act(async () => findButton('Configure')!.click())
    let grantButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .filter(candidate => candidate.textContent === 'Grant access')
    expect(grantButtons).toHaveLength(2)
    act(() => grantButtons[0].click())

    await vi.waitFor(() => {
      grantButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .filter(candidate => candidate.textContent === 'Grant access')
      expect(grantButtons).toHaveLength(1)
      expect(grantButtons[0].disabled).toBe(true)
    })

    await act(async () => resolveGrant!(null))
  })
})

// Switches the binding to the second account and waits for its configurator.
const selectSecondAccount = async () => {
  const account = Array.from(document.body.querySelectorAll('button'))
    .find(button => button.textContent?.startsWith('account-2'))!
  await act(async () => account.click())
  await vi.waitFor(() => expect(testState.configurator?.frame.iframeHtml).toBe('frame-2'))
  return testState.configurator!.ensureResources!
}

describe('BlueprintLandingPage configurator access requests', () => {
  const RESOURCE = {
    urlPattern: 'https://catalog.example.com/*',
    title: 'Service catalog',
    description: 'Example service catalog',
  }
  const IMPORT_GRANT = 'https://catalog.example.com/import'
  const VENDOR = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }
  const GATEKEEPER_BLUEPRINT: BlueprintPublicInfo = {
    ...BLUEPRINT,
    metadata: {
      ...BLUEPRINT.metadata,
      bindings: {
        CATALOG: {
          type: 'gatekeeper',
          title: 'Catalog',
          description: '',
          gatekeeperName: 'catalog',
          typeUrlPattern: RESOURCE.urlPattern,
        },
      },
    },
  }

  const startResourceConfigurator = vi.fn<(accountId: number, pattern: string) => Promise<object>>()
  const ensureAccountResources =
    vi.fn<(accountId: number, patterns: string[]) => Promise<ConnectFlowStart | null>>()

  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    testState.configurator = null
    startResourceConfigurator.mockReset()
    ensureAccountResources.mockReset()
    openConnectWindow.mockClear()
  })

  // Opens the binding's configuration, which starts a configurator on the first account.
  const openBinding = async () => {
    startResourceConfigurator.mockImplementation(async accountId => ({
      iframeHtml: `frame-${accountId}`,
      ui: { [Symbol.dispose]() {} },
    }))
    testState.authenticatedApi = {
      ...authenticatedApi(),
      listGatekeeperVendors: async () => [{ id: 'catalog', description: VENDOR, supportedResources: [RESOURCE] }],
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        for (const id of [1, 2]) {
          subscriber.add(id, { uniqueName: `account-${id}`, avatar: { url: VENDOR.url } }, VENDOR, [RESOURCE], true, 'catalog')
        }
        subscriber.ready()
        return subscription()
      },
      startResourceConfigurator,
      ensureAccountResources,
    } as unknown as RpcStub<AuthenticatedApi>
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi(GATEKEEPER_BLUEPRINT)} />))
    await act(async () => { await Promise.resolve() })
    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Configure')!
    await act(async () => configure.click())
    await vi.waitFor(() => expect(testState.configurator?.frame.iframeHtml).toBe('frame-1'))
  }

  it('resolves true without a pop-up when the account already holds the grants', async () => {
    ensureAccountResources.mockResolvedValue(null)
    await openBinding()

    await expect(testState.configurator!.ensureResources!([IMPORT_GRANT])).resolves.toBe(true)

    expect(ensureAccountResources).toHaveBeenCalledExactlyOnceWith(1, [IMPORT_GRANT])
    expect(openConnectWindow).not.toHaveBeenCalled()
  })

  it('asks for the account the configurator was started on', async () => {
    ensureAccountResources.mockResolvedValue(null)
    await openBinding()
    const ensureResources = await selectSecondAccount()

    expect(startResourceConfigurator).toHaveBeenLastCalledWith(2, RESOURCE.urlPattern)
    await ensureResources([IMPORT_GRANT])
    expect(ensureAccountResources).toHaveBeenCalledExactlyOnceWith(2, [IMPORT_GRANT])
  })
})
