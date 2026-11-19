// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type * as Router from '@tanstack/react-router'
import { ADMIN_GATEKEEPER_VENDOR_ID } from '@gadgets/workshop-shared/admin-agent'
import { type AdminApi, type AdminResourceVendor, type AdminSettingsView, type AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import type * as ServerConfigContext from './ServerConfigContext'
import type * as PendingApprovals from './features/admin-grants/PendingApprovalsCard'

type CardProps = ComponentProps<typeof PendingApprovals.PendingApprovalsCard>

const mocks = vi.hoisted(() => {
  // The AdminApi the page is handed. The pending approvals card is replaced below and calls
  // nothing.
  const admin = {
    getSettings: vi.fn<() => Promise<Partial<AdminSettingsView>>>(),
    getUpdateStatus: vi.fn<() => Promise<null>>(async () => null),
    setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async () => {}),
  }
  return {
    admin,
    authenticatedApi: {
      getAdminApi: vi.fn<() => Promise<typeof admin>>(async () => admin),
    },
    // The session's identity, as AuthProvider holds it for this connection.
    identity: { currentUser: { type: 'user', id: 'alice', name: 'Alice' } as AiChatAuthorInfo | null, isCurrentUserConfirmed: true },
    search: { tab: 'access' } as Record<string, unknown>,
    addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
    navigate: vi.fn<(to: unknown) => Promise<void>>(async () => {}),
    // What the page handed the pending approvals card, one entry for each time it rendered.
    cardProps: [] as unknown[],
    // What the page last handed the audit panel.
    panelProps: null as { onRefresh?: () => void } | null,
  }
})

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: mocks.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi, isAdmin: true, ...mocks.identity }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}))

// A name the settings do not hold, so that a card named after it took the shell's name rather than
// the saved one.
vi.mock('./ServerConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerConfigContext>()),
  useSiteName: () => 'Shell name',
}))

vi.mock('./features/deployment-updates/probeRouterTag', () => ({ probeRouterTag: async () => {} }))

vi.mock('./features/admin-grants/PendingApprovalsCard', () => ({
  PendingApprovalsCard: (props: CardProps) => {
    mocks.cardProps.push(props)
    return <div data-testid="pending-approvals" />
  },
}))

vi.mock('./features/admin-audit/AdminAuditPanel', () => ({
  AdminAuditPanel: (props: { onRefresh?: () => void }) => {
    mocks.panelProps = props
    return <div data-testid="audit-panel" />
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
const settingsView = (overrides: Partial<AdminSettingsView> = {}): AdminSettingsView => ({
  signupsEnabled: true,
  userSearchEnabled: false,
  snapshotSharingEnabled: true,
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

const cards = () => [...document.querySelectorAll('[data-testid="pending-approvals"]')]
const lastCardProps = () => mocks.cardProps.at(-1)

let root: Root | undefined
let container: HTMLDivElement | undefined

// Renders the page and waits for its settings.
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
  mocks.search = { tab: 'access' }
  mocks.cardProps.length = 0
  mocks.panelProps = null
  mocks.identity = { currentUser: { type: 'user', id: 'alice', name: 'Alice' }, isCurrentUserConfirmed: true }
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AdminPage pending approvals', () => {
  it('mounts the card on the Audit tab, above its panel, for the signed-in admin', async () => {
    mocks.search = { tab: 'audit' }
    const page = await renderPage(settingsView())

    expect(cards()).toHaveLength(1)
    const card = cards()[0]!
    const panel = page.querySelector('[data-testid="audit-panel"]')!
    expect(card.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(lastCardProps()).toMatchObject({ admin: mocks.admin, userId: 'alice', refreshes: 0 })
  })

  it('lists the pending approvals again on the Audit tab\'s Refresh', async () => {
    mocks.search = { tab: 'audit' }
    await renderPage(settingsView())
    act(() => mocks.panelProps!.onRefresh!())
    expect(lastCardProps()).toMatchObject({ userId: 'alice', refreshes: 1 })
  })

  it('keeps the card to the Audit tab', async () => {
    await renderPage(settingsView())
    expect(cards()).toHaveLength(0)
  })

  it.each([
    { state: 'not yet confirmed for this connection', identity: { currentUser: { type: 'user', id: 'alice', name: 'Alice' } as AiChatAuthorInfo, isCurrentUserConfirmed: false } },
    { state: 'unknown', identity: { currentUser: null, isCurrentUserConfirmed: false } },
  ])('leaves the tab without the card while the session\'s identity is $state', async ({ identity }) => {
    mocks.search = { tab: 'audit' }
    mocks.identity = identity
    const page = await renderPage(settingsView())

    expect(page.querySelector('[data-testid="audit-panel"]')).not.toBeNull()
    expect(cards()).toHaveLength(0)
  })
})

it.each([
  { outcome: 'succeeds', refreshFails: false },
  { outcome: 'fails', refreshFails: true },
])('reports a saved resource toggle accurately when policy refresh $outcome', async ({ refreshFails }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  mocks.search.tab = 'gatekeepers'
  const retired = 'https://example.com/retired/*'
  const current = [
    { resourceTypeId: 'repository', urlPattern: 'https://example.com/:repo', title: 'Repository',
      description: 'Read code', enabled: false },
    { resourceTypeId: 'issue', urlPattern: 'https://example.com/:repo/issues/:id', title: 'Issue',
      description: 'Read issues', enabled: false },
  ]
  const vendor = { vendorId: 'example', displayName: 'Example', enabled: true,
    autoProvisions: false, resources: [...current,
      { urlPattern: retired, title: 'Unavailable resource type', description: 'Old restriction', enabled: false }],
  } satisfies AdminResourceVendor
  const settings = settingsView({ siteName: '', resourceVendors: [vendor] })
  const { getSettings, setResourceEnabled } = mocks.admin
  getSettings.mockResolvedValueOnce(settings).mockResolvedValue({ ...settings,
    resourceVendors: [{ ...vendor, resources: current.map(r => ({ ...r, enabled: true })) }],
  })
  if (refreshFails) getSettings.mockRejectedValueOnce(new Error('Settings unavailable'))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const row = (title: string) => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.querySelector('p')?.textContent === title)!
  try {
    await act(async () => { root.render(<AdminPage />) })
    expect(row('Repository').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { row('Unavailable resource type').click() })
    expect(setResourceEnabled).toHaveBeenCalledWith('example', retired, true)
    expect(row('Unavailable resource type') !== undefined).toBe(refreshFails)
    for (const title of ['Repository', 'Issue']) {
      expect(row(title).querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(String(!refreshFails))
    }
    expect(mocks.addToast.mock.calls).toEqual(refreshFails ? [[{
        title: 'Change saved, but resource settings could not be refreshed. Reload this page.',
        variant: 'error',
    }]] : [])
    expect(getSettings).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    mocks.search.tab = 'access'
    getSettings.mockReset()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  }
})

// An auto-provisioned vendor's block of the Gatekeepers tab: its name, its mode buttons and
// whatever is said between.
const vendorBlock = (page: HTMLElement, name: string) =>
  [...page.querySelectorAll('h3')].find((heading) => heading.textContent === name)!.parentElement!.parentElement!

// The label and the hint of each mode button, in order.
const modeOptions = (block: HTMLElement) =>
  [...block.querySelectorAll('button')].map((option) => [...option.querySelectorAll('span')].map((line) => line.textContent))

// The Gatekeepers tab of a deployment with two auto-provisioned gatekeepers, the admin
// gatekeeper among them.
const renderGatekeepers = () => {
  mocks.search = { tab: 'gatekeepers' }
  return renderPage(settingsView({
    resourceVendors: [
      { vendorId: 'context', displayName: 'Context Library', autoProvisions: true, ambientMode: 'optional' },
      { vendorId: ADMIN_GATEKEEPER_VENDOR_ID, displayName: 'Deployment admin', autoProvisions: true, ambientMode: 'disabled' },
    ],
  }))
}

describe('AdminPage Gatekeepers tab', () => {
  const ADMINS_ONLY_LINE = 'An admin adds it to a workspace as a connection. Only deployment admins can open a '
    + 'workspace that has it, or that has read through it.'

  it('says of the admin gatekeeper’s modes that they reach admins alone, and how a workspace gets it', async () => {
    const block = vendorBlock(await renderGatekeepers(), 'Deployment admin')

    expect(modeOptions(block)).toEqual([
      ['Disabled', 'Off for everyone'],
      ['Optional', 'Deployment admins can add it themselves'],
      ['Enabled', 'On for every deployment admin automatically'],
    ])
    expect([...block.querySelectorAll('p')].map((line) => line.textContent)).toEqual([ADMINS_ONLY_LINE])
  })

  it('words another auto-provisioned gatekeeper’s modes for every user, with no such line', async () => {
    const block = vendorBlock(await renderGatekeepers(), 'Context Library')

    expect(modeOptions(block)).toEqual([
      ['Disabled', 'Off for everyone'],
      ['Optional', 'Users can add it themselves'],
      ['Enabled', 'On for everyone automatically'],
    ])
    expect(block.querySelector('p')).toBeNull()
  })
})
