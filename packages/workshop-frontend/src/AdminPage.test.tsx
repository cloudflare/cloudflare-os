// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type * as Router from '@tanstack/react-router'
import { DEFAULT_SITE_NAME, type AdminSettingsView, type AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import type * as ServerConfigContext from './ServerConfigContext'
import type * as PasskeysCard from './features/admin-writes/AdminPasskeysCard'

type CardProps = ComponentProps<typeof PasskeysCard.AdminPasskeysCard>

const mocks = vi.hoisted(() => {
  // The AdminApi the page is handed. The passkeys card is replaced below and calls nothing, so a
  // call to one of the five passkey methods could only be the page's own.
  const admin = {
    getSettings: vi.fn<() => Promise<Partial<AdminSettingsView>>>(),
    getUpdateStatus: vi.fn<() => Promise<null>>(async () => null),
    listAdminPasskeys: vi.fn<() => Promise<never>>(),
    beginAdminPasskeyEnrolment: vi.fn<() => Promise<never>>(),
    beginAdminPasskeyRemoval: vi.fn<() => Promise<never>>(),
    addAdminPasskey: vi.fn<() => Promise<never>>(),
    removeAdminPasskey: vi.fn<() => Promise<never>>(),
  }
  return {
    admin,
    authenticatedApi: {
      whoami: vi.fn<() => Promise<AiChatAuthorInfo>>(async () => ({ type: 'user', id: 'alice', name: 'Alice' })),
      getAdminApi: vi.fn<() => Promise<typeof admin>>(async () => admin),
    },
    search: { tab: 'access' },
    // What the page handed the passkeys card, one entry for each time it rendered.
    cardProps: [] as unknown[],
  }
})

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi, isAdmin: true }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useSearch: () => mocks.search,
  useNavigate: () => vi.fn<() => Promise<void>>(),
}))

// A name the settings do not hold, so that a card named after it took the shell's name rather than
// the saved one.
vi.mock('./ServerConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerConfigContext>()),
  useSiteName: () => 'Shell name',
}))

vi.mock('./features/deployment-updates/probeRouterTag', () => ({ probeRouterTag: async () => {} }))

vi.mock('./features/admin-writes/AdminPasskeysCard', () => ({
  AdminPasskeysCard: (props: CardProps) => {
    mocks.cardProps.push(props)
    return <div data-testid="passkeys-card" />
  },
}))

import AdminPage from './AdminPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

// A whole settings view. Its type names every field, so one the page reads cannot be left out.
const settingsView = (
  overrides: Pick<AdminSettingsView, 'adminWorkspaceWrites'> & Partial<AdminSettingsView>,
): AdminSettingsView => ({
  signupsEnabled: true,
  userSearchEnabled: false,
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'metadata' },
  adminAuditRetentionDays: { effective: 90, chosen: 90, min: 90 },
  siteName: 'Example OS',
  instanceInstructions: '',
  announcement: '',
  banner: { text: '', color: 'neutral' },
  accentColor: '',
  restrictedWebFetchHosts: [],
  restrictedWebFetchApprovals: false,
  resourceVendors: [],
  formats: [],
  ...overrides,
})

const PASSKEY_METHODS = [
  'listAdminPasskeys', 'beginAdminPasskeyEnrolment', 'beginAdminPasskeyRemoval', 'addAdminPasskey',
  'removeAdminPasskey',
] as const

const cards = () => [...document.querySelectorAll('[data-testid="passkeys-card"]')]
const lastCardProps = () => mocks.cardProps.at(-1)

describe('AdminPage passkeys card', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  // Renders the page and waits for its settings and the admin's profile.
  const renderPage = async (view: Partial<AdminSettingsView>) => {
    mocks.admin.getSettings.mockResolvedValue(view)
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(<AdminPage />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return container
  }

  beforeEach(() => {
    // The page's tabs measure themselves with one, and jsdom has none.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    mocks.search.tab = 'access'
    mocks.cardProps.length = 0
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts the card after the user-search card, for the signed-in admin, while writes are on', async () => {
    const page = await renderPage(settingsView({ adminWorkspaceWrites: true }))

    expect(cards()).toHaveLength(1)
    const userSearch = page.querySelector('[aria-label="Allow user search"]')!
    expect(userSearch.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lastCardProps()).toEqual({
      admin: mocks.admin,
      user: { id: 'alice', name: 'Alice' },
      siteName: 'Example OS',
      writesOn: true,
    })
    // The page's own capability, not a second one minted for the card.
    expect((lastCardProps() as CardProps).admin).toBe(mocks.admin)
    expect(mocks.authenticatedApi.getAdminApi).toHaveBeenCalledTimes(1)
    for (const method of PASSKEY_METHODS) expect(mocks.admin[method]).not.toHaveBeenCalled()
  })

  it('mounts the card while writes are off, and leaves what to show to it', async () => {
    await renderPage(settingsView({ adminWorkspaceWrites: false }))

    expect(cards()).toHaveLength(1)
    expect(lastCardProps()).toMatchObject({ writesOn: false, user: { id: 'alice', name: 'Alice' } })
  })

  it('mounts no card, and calls no passkey method, on a backend whose settings lack the field', async () => {
    const { adminWorkspaceWrites: _, ...older } = settingsView({ adminWorkspaceWrites: false })

    const page = await renderPage(older)

    expect(page.querySelector('[aria-label="Allow user search"]')).not.toBeNull()
    expect(cards()).toHaveLength(0)
    expect(mocks.cardProps).toEqual([])
    for (const method of PASSKEY_METHODS) expect(mocks.admin[method]).not.toHaveBeenCalled()
  })

  it('keeps the card to the Access tab', async () => {
    mocks.search.tab = 'general'

    await renderPage(settingsView({ adminWorkspaceWrites: true }))

    expect(cards()).toHaveLength(0)
    expect(mocks.cardProps).toEqual([])
  })

  it('names the card after the saved site name while another is typed and not saved', async () => {
    mocks.search.tab = 'general'
    const page = await renderPage(settingsView({ adminWorkspaceWrites: true }))
    const field = page.querySelector<HTMLInputElement>(`input[placeholder="${DEFAULT_SITE_NAME}"]`)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Unsaved name')
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    expect(field.value).toBe('Unsaved name')

    mocks.search.tab = 'access'
    await act(async () => root!.render(<AdminPage />))

    expect(cards()).toHaveLength(1)
    expect(lastCardProps()).toMatchObject({ siteName: 'Example OS' })
  })

  it('names the card after the default site name while none is saved', async () => {
    await renderPage(settingsView({ adminWorkspaceWrites: true, siteName: '' }))

    expect(lastCardProps()).toMatchObject({ siteName: DEFAULT_SITE_NAME })
  })

  it('leaves the tab without the card when the admin\'s profile cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('profile unavailable')
    mocks.authenticatedApi.whoami.mockRejectedValueOnce(failure)

    const page = await renderPage(settingsView({ adminWorkspaceWrites: true }))

    expect(page.querySelector('[aria-label="Allow user search"]')).not.toBeNull()
    expect(cards()).toHaveLength(0)
    expect(logged).toHaveBeenCalledWith('Failed to read the admin’s profile:', failure)
  })
})
