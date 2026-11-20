// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectFlowStart,
  ConnectedAccountsSubscriber,
  ObserverAccountChoice,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div data-testid="account-select">{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Select,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ObserverConfigModal from './ObserverConfigModal'

const VENDOR = {
  displayName: 'Google',
  color: '#4285f4',
} as VendorDescription

const DOC_RESOURCE: SupportedResource = {
  urlPattern: 'https://docs.google.com/document/d/:docId/*',
  title: 'Google Doc',
  description: 'Read and edit documents you choose.',
  grantable: true,
}

const GMAIL_RESOURCE_PATTERN = 'https://mail.google.com/*'

const NEED: ObserverBindingNeed = {
  gatekeeperId: 12,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

function account(
  id: number,
  uniqueName: string,
  grantedResourceUrlPatterns?: string[],
  credentialsValid = true,
) {
  return {
    id,
    credentialsValid,
    description: {
      displayName: uniqueName,
      uniqueName,
      grantedResourceUrlPatterns,
    } as AccountDescription,
  }
}

type ApiOverrides = {
  subscribeConnectedAccounts?: Mock<(
    subscriber: ConnectedAccountsSubscriber,
  ) => Promise<{ [Symbol.dispose](): void }>>
  connectAccount?: Mock<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>
  ensureAccountResources?: Mock<(
    accountId: number,
    resourceUrlPatterns: string[],
  ) => Promise<ConnectFlowStart | null>>
  reconnectAccount?: Mock<(accountId: number) => Promise<ConnectFlowStart>>
}

function fakeApi(
  accountEntries: ReturnType<typeof account>[],
  overrides: ApiOverrides = {},
  resources: SupportedResource[] = [DOC_RESOURCE],
): RpcStub<AuthenticatedApi> {
  return {
    subscribeConnectedAccounts: overrides.subscribeConnectedAccounts ?? ((subscriber: ConnectedAccountsSubscriber) => {
      for (const entry of accountEntries) {
        subscriber.add(
          entry.id, entry.description, VENDOR, resources, entry.credentialsValid, 'google')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
        [Symbol.dispose]() {},
      })
    }),
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: VENDOR,
      supportedResources: resources,
    }],
    listAddableGatekeepers: async () => [],
    connectAccount: overrides.connectAccount ??
      vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>(),
    ensureAccountResources: overrides.ensureAccountResources ??
      vi.fn<(accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>>(),
    reconnectAccount: overrides.reconnectAccount ??
      vi.fn<(accountId: number) => Promise<ConnectFlowStart>>(),
  } as unknown as RpcStub<AuthenticatedApi>
}

// The flow a connect / ensure-resources fake starts: the URL to open and the nonce the popup carries.
const FLOW: ConnectFlowStart = { url: 'https://accounts.google.test/oauth', nonce: 'a'.repeat(64) }

// The popup openConnectWindow gets back: opened blank, given the nonce, then navigated to the URL.
function mockConnectPopup() {
  const popup = {
    close() {},
    opener: window as Window | null,
    sessionStorage: { setItem: vi.fn<(key: string, value: string) => void>(), removeItem: vi.fn<(key: string) => void>() },
    location: { replace: vi.fn<(url: string) => void>() },
  }
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window)
  return popup
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === name)
}

describe('ObserverConfigModal account selection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(
    accountEntries: ReturnType<typeof account>[],
    options: {
      api?: RpcStub<AuthenticatedApi>
      needs?: ObserverBindingNeed[]
      onConfirm?: (choices: ObserverAccountChoice[]) => void
    } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal
          needs={options.needs ?? [NEED]}
          authenticatedApi={options.api ?? fakeApi(accountEntries)}
          onConfirm={options.onConfirm ?? (() => {})}
          onCancel={() => {}}
          subject="workspace"
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('shows a single matching account directly instead of putting it in a dropdown', async () => {
    const rendered = await render([account(1, 'dan@cloudflare.com')])

    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.querySelector('[data-testid="account-select"]')).toBeNull()
  })

  it('disposes a pending account subscription on unmount', async () => {
    const dispose = vi.fn<() => void>()
    const pendingSubscription = Object.assign(new Promise<{ [Symbol.dispose](): void }>(() => {}), {
      [Symbol.dispose]: dispose,
    })
    const subscribeConnectedAccounts = vi.fn<
      (subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>
    >().mockReturnValue(pendingSubscription)
    await render([], { api: fakeApi([], { subscribeConnectedAccounts }) })

    act(() => root!.unmount())
    root = undefined

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the account dropdown when multiple accounts match', async () => {
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
  })

  it.each([true, false])('requests the observer scope when connecting a new account (connectable: %s)', async connectable => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const rendered = await render([], {
      api: fakeApi([], { connectAccount }, [{ ...DOC_RESOURCE, connectable, creatable: true }]),
    })

    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    expect(connectAccount).toHaveBeenCalledWith('google', [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
  })

  it.each([true, false])('expands an observer account grant before verification (connectable: %s)', async connectable => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }, [{ ...DOC_RESOURCE, connectable, creatable: true }]),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()
    expect(rendered.textContent).not.toContain('Ready')

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
    expect(rendered.textContent).not.toContain('Ready')
    expect(verify?.disabled).toBe(true)
  })

  it.each([
    { scenario: 'overlapping patterns', urlPattern: DOC_RESOURCE.urlPattern },
    { scenario: 'changed pattern', urlPattern: 'https://docs.example.test/new/:document' },
  ])('uses the stored type ID for an observer grant with $scenario', async ({ urlPattern }) => {
    const ensureAccountResources = vi.fn<AuthenticatedApi['ensureAccountResources']>()
      .mockResolvedValue(FLOW)
    mockConnectPopup()
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      needs: [{ ...NEED, resourceTypeId: 'document' }],
      api: fakeApi([underScoped], { ensureAccountResources }, [
        { ...DOC_RESOURCE, id: 'other' },
        { ...DOC_RESOURCE, id: 'document', urlPattern },
      ]),
    })
    const grant = findButton(rendered, 'Grant the access needed to verify this resource')
    expect(grant).toBeDefined()
    await act(async () => grant!.click())
    expect(ensureAccountResources).toHaveBeenCalledWith(1, ['document'])
  })

  it('checks the resource grant when legacy account metadata omits it', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
  })

  it('allows verification when the gatekeeper confirms an unknown grant needs no OAuth', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(null)
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    await act(async () => grant!.click())

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(rendered.textContent).toContain('Ready')
    expect(verify?.disabled).toBe(false)
  })

  it('allows verification when the account already has the required grant', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], { onConfirm })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(verify?.disabled).toBe(false)
    expect(rendered.textContent).toContain('Ready')

    await act(async () => verify!.click())
    expect(onConfirm).toHaveBeenCalledWith([{ gatekeeperId: 12, accountId: 1 }])
  })

  it('applies one account choice to every connection of a vendor', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const second = { ...NEED, gatekeeperId: 13, resourceTitle: 'Q4 planning', resourceUrl: 'https://docs.google.com/document/d/q4' }
    const rendered = await render([granted, account(2, 'dan.personal@gmail.com', [DOC_RESOURCE.urlPattern])], {
      needs: [NEED, second],
      onConfirm,
    })

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
    await act(async () => findButton(rendered, 'Verify and open')!.click())
    expect(onConfirm).toHaveBeenCalledWith([
      { gatekeeperId: 12, accountId: 1 },
      { gatekeeperId: 13, accountId: 1 },
    ])
  })

  describe('a vendor whose connections need different resource types', () => {
    const SHEET_RESOURCE: SupportedResource = {
      urlPattern: 'https://docs.google.com/spreadsheets/d/:sheetId/*',
      title: 'Google Sheet',
      description: 'Read and edit spreadsheets you choose.',
      grantable: true,
    }
    const RESOURCES = [DOC_RESOURCE, SHEET_RESOURCE]
    const SHEET_NEED: ObserverBindingNeed = {
      gatekeeperId: 13,
      vendorId: 'google',
      resourceTitle: 'Budget',
      resourceUrl: 'https://docs.google.com/spreadsheets/d/budget',
    }

    it('requests every type the connections need when connecting', async () => {
      const connectAccount = vi.fn<AuthenticatedApi['connectAccount']>().mockResolvedValue(FLOW)
      mockConnectPopup()
      const rendered = await render([], {
        needs: [NEED, SHEET_NEED],
        api: fakeApi([], { connectAccount }, RESOURCES),
      })

      await act(async () => findButton(rendered, 'Connect')!.click())
      expect(connectAccount).toHaveBeenCalledWith('google', [DOC_RESOURCE.urlPattern, SHEET_RESOURCE.urlPattern])
    })

    it('withholds Ready until the account holds both types, and grants only the missing one', async () => {
      const ensureAccountResources = vi.fn<AuthenticatedApi['ensureAccountResources']>().mockResolvedValue(FLOW)
      mockConnectPopup()
      const docsOnly = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
      const rendered = await render([docsOnly], {
        needs: [NEED, SHEET_NEED],
        api: fakeApi([docsOnly], { ensureAccountResources }, RESOURCES),
      })

      expect(rendered.textContent).not.toContain('Ready')
      expect(findButton(rendered, 'Verify and open')?.disabled).toBe(true)
      await act(async () => findButton(rendered, 'Grant the access needed to verify these resources')!.click())
      expect(ensureAccountResources).toHaveBeenCalledWith(1, [SHEET_RESOURCE.urlPattern])
    })

    it('is Ready once the account holds both types', async () => {
      const both = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern, SHEET_RESOURCE.urlPattern])
      const rendered = await render([both], { needs: [NEED, SHEET_NEED], api: fakeApi([both], {}, RESOURCES) })

      expect(rendered.textContent).toContain('Ready')
      expect(findButton(rendered, 'Verify and open')?.disabled).toBe(false)
    })

    it('on a retry, warns only about the refused connection and offers to re-authenticate its account', async () => {
      const both = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern, SHEET_RESOURCE.urlPattern])
      const rendered = await render([both], {
        needs: [{ ...NEED, failure: { accountId: 1, reason: 'Access was revoked.' } }, SHEET_NEED],
        api: fakeApi([both], {}, RESOURCES),
      })

      const warnings = [...rendered.querySelectorAll('.text-kumo-warning')].map(el => el.textContent)
      expect(warnings).toEqual([expect.stringContaining('Q3 planning · dan@cloudflare.com — Access was revoked.')])
      expect(rendered.textContent).not.toContain('Ready')
      expect(findButton(rendered, 'Re-authenticate this account')).toBeDefined()
    })

    it('words the retry by distinct accounts when one account was refused twice', async () => {
      const both = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern, SHEET_RESOURCE.urlPattern])
      const failure = { accountId: 1, reason: 'Access was revoked.' }
      const rendered = await render([both], {
        needs: [{ ...NEED, failure }, { ...SHEET_NEED, failure }],
        api: fakeApi([both], {}, RESOURCES),
      })

      expect(rendered.textContent).toContain('the reasons below, re-authenticate this account')
      expect(rendered.textContent).toContain('share the resources that your account can’t access')
    })
  })

  // A popup flow can end without this dialog ever hearing about it: the user closes it, the
  // provider refuses, or it signs in as an account the user already has (which adds no account).
  // None of these may leave the dialog waiting with every way forward disabled.
  it('lets a connect be started again when the first one never produces an account', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>
    >().mockResolvedValue(FLOW)
    mockConnectPopup()
    const rendered = await render([], { api: fakeApi([], { connectAccount }) })

    await act(async () => findButton(rendered, 'Connect')!.click())
    expect(findButton(rendered, 'Connect')?.disabled).toBe(false)

    await act(async () => findButton(rendered, 'Connect')!.click())
    expect(connectAccount).toHaveBeenCalledTimes(2)
  })

  it('lets re-authentication be started again when the first attempt never completes', async () => {
    const reconnectAccount = vi.fn<(accountId: number) => Promise<ConnectFlowStart>>()
      .mockResolvedValue(FLOW)
    mockConnectPopup()
    const expired = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern], false)
    const rendered = await render([expired], { api: fakeApi([expired], { reconnectAccount }) })
    const reauthenticate = () =>
      findButton(rendered, 'This account has expired — click to re-authenticate')

    await act(async () => reauthenticate()!.click())
    expect(reauthenticate()?.disabled).toBe(false)

    await act(async () => reauthenticate()!.click())
    expect(reconnectAccount).toHaveBeenCalledTimes(2)
  })

  it('lets a resource grant be requested again when the first attempt never completes', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    mockConnectPopup()
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })
    const grant = () => findButton(rendered, 'Grant the access needed to verify this resource')

    await act(async () => grant()!.click())
    expect(grant()?.disabled).toBe(false)

    await act(async () => grant()!.click())
    expect(ensureAccountResources).toHaveBeenCalledTimes(2)
  })

  it('does not present an account refused with valid credentials as ready or as signed out', async () => {
    const refusal = 'This collaborator does not have access to the bound Google Doc.'
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], {
      needs: [{ ...NEED, failure: { accountId: 1, reason: refusal } }],
    })

    expect(rendered.textContent).toContain(refusal)
    expect(rendered.textContent).not.toContain('Ready')
    expect(rendered.textContent).toContain('ask the workspace owner')
    // Checking again stays possible (the owner may since have shared it), and re-authenticating
    // stays on offer for a gatekeeper that refused on an auth error without reporting the expiry.
    expect(findButton(rendered, 'Verify again')?.disabled).toBe(false)
    expect(findButton(rendered, 'Re-authenticate this account')).toBeDefined()
  })
})
