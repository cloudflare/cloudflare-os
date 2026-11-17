// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ISSUE_REPORT_ERROR_CODES,
  ISSUE_REPORT_STATUSES,
  MAX_ISSUE_REPORT_TEXT_LENGTH,
  createIssueReportError,
  issueReportStatusForReporter,
  type AdminAccessGrant,
  type AuthenticatedApi,
  type IssueReportEntry,
  type IssueReportGrant,
  type Overseer,
  type OwnIssueReport,
  type OwnIssueReportPage,
  type ServerConfig,
} from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => ({
  authenticatedApi: {} as unknown,
  serverConfig: {} as unknown,
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => mocks.serverConfig,
}))

import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { ADMIN_ISSUE_STATUS_NAMES, ISSUE_STATUS_NAMES, reporterReads } from './issueLabels'
import { MyIssues } from './MyIssues'
import { useIssueReportCount } from './useIssueReportCount'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Opened = OwnIssueReport & { entries: IssueReportEntry[] }

const HOUR = 3_600_000

const report = (id: string, change: Partial<OwnIssueReport> = {}): OwnIssueReport => ({
  id,
  filedAt: new Date('2026-10-12T09:30:00Z'),
  reporter: { id: 'profile-rita', name: 'Rita Reporter' },
  text: `Report ${id}\nIts second line.`,
  priority: 'medium',
  context: { workspaceId: 'ws-1' },
  status: 'new',
  images: [],
  unseen: false,
  ...change,
})

// An admin's entry as the reporter reads one: the author's name and no id.
const adminEntry = (id: string, text: string, change: Partial<IssueReportEntry> = {}): IssueReportEntry => ({
  id,
  at: new Date('2026-10-12T10:00:00Z'),
  author: { name: 'Grace Admin' },
  visibility: 'public',
  via: 'api',
  text,
  ...change,
})

const ownEntry = (id: string, text: string, change: Partial<IssueReportEntry> = {}): IssueReportEntry => ({
  id,
  at: new Date('2026-10-12T11:00:00Z'),
  author: { id: 'profile-rita', name: 'Rita Reporter' },
  visibility: 'public',
  text,
  ...change,
})

const liveGrant = (scope: IssueReportGrant['scope'], id = `grant-${scope}`): IssueReportGrant => ({
  id,
  scope,
  expiresAt: new Date(Date.now() + 70 * HOUR),
})

const accountGrant = (change: Partial<AdminAccessGrant> = {}): AdminAccessGrant => ({
  id: 'grant-account',
  level: 'content',
  source: 'owner',
  scope: 'account',
  grantedBy: { id: 'profile-rita', name: 'Rita Reporter' },
  grantedAt: new Date(Date.now() - 2 * HOUR),
  expiresAt: new Date(Date.now() + 70 * HOUR),
  ...change,
})

// The workspace openWorkspace() promises, as the page holds it: it calls a grant method on it and
// disposes it.
const fakeWorkspace = (held: { reports: Map<string, Opened> }) => {
  const setGrant = (grantId: string, change: Partial<IssueReportGrant>) => {
    for (const [id, opened] of held.reports) {
      if (opened.grant?.id === grantId) held.reports.set(id, { ...opened, grant: { ...opened.grant, ...change } })
    }
  }
  return {
    renewAdminAccess: vi.fn<Overseer['renewAdminAccess']>(async (grantId) => {
      setGrant(grantId, { expiresAt: new Date(Date.now() + 72 * HOUR) })
      return accountGrant({ id: grantId, scope: 'workspace' })
    }),
    revokeAdminAccess: vi.fn<Overseer['revokeAdminAccess']>(async (grantId) => {
      setGrant(grantId, { endedAt: new Date() })
    }),
    grantAdminAccess: vi.fn<Overseer['grantAdminAccess']>(async (options) => {
      const opened = held.reports.get(options!.reportId!)!
      held.reports.set(opened.id, { ...opened, grant: liveGrant('workspace', 'grant-again') })
      return accountGrant({ id: 'grant-again', scope: 'workspace' })
    }),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
}

// The reporter's API over reports it holds as the server does: what a call changes, the next read
// returns. `calls` is every call to the report methods, in the order they were made.
const fakeApi = (options: {
  pages?: OwnIssueReportPage[]
  opened?: Opened[]
  account?: AdminAccessGrant | null
} = {}) => {
  const held = {
    reports: new Map((options.opened ?? []).map((opened) => [opened.id, opened])),
    account: options.account ?? null,
  }
  // With no pages given, the one page lists the reports held, as they are when it is read.
  const pages = () => options.pages
    ?? [{ reports: [...held.reports.values()].map(({ entries: _entries, ...listed }) => listed) }]
  const calls: string[] = []
  const workspaces: ReturnType<typeof fakeWorkspace>[] = []
  const setAccountGrantOnReports = (change: Partial<IssueReportGrant>) => {
    for (const [id, opened] of held.reports) {
      if (opened.grant?.scope === 'account') held.reports.set(id, { ...opened, grant: { ...opened.grant, ...change } })
    }
  }
  return {
    held,
    calls,
    /** Every workspace the page opened, in order. */
    workspaces,
    listIssueReports: vi.fn<AuthenticatedApi['listIssueReports']>(async (cursor) => {
      const page = pages()[cursor === undefined ? 0 : Number(cursor)]
      if (page === undefined) throw new Error(`no page ${cursor}`)
      return page
    }),
    getIssueReport: vi.fn<AuthenticatedApi['getIssueReport']>(async (id) => {
      calls.push('getIssueReport')
      const opened = held.reports.get(id)
      if (opened === undefined) throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound)
      return opened
    }),
    markIssueReportSeen: vi.fn<AuthenticatedApi['markIssueReportSeen']>(async (id) => {
      calls.push('markIssueReportSeen')
      const opened = held.reports.get(id)
      if (opened !== undefined) held.reports.set(id, { ...opened, unseen: false })
    }),
    getUnseenIssueReportCount: vi.fn<AuthenticatedApi['getUnseenIssueReportCount']>(async () => {
      calls.push('getUnseenIssueReportCount')
      return [...held.reports.values()].filter((opened) => opened.unseen).length
    }),
    replyToIssueReport: vi.fn<AuthenticatedApi['replyToIssueReport']>(async (id, text) => {
      const opened = held.reports.get(id)!
      const reopens = opened.status === 'answered' || opened.status === 'waitingOnReporter'
      const entry = ownEntry(`reply-${opened.entries.length + 1}`, text, reopens ? { status: 'withAdmin' } : {})
      held.reports.set(id, {
        ...opened,
        status: reopens ? 'withAdmin' : opened.status,
        entries: [...opened.entries, entry],
      })
      return entry
    }),
    readIssueReportImage: vi.fn<AuthenticatedApi['readIssueReportImage']>(
      async () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })),
    getAccountAdminGrant: vi.fn<AuthenticatedApi['getAccountAdminGrant']>(async () => held.account),
    grantAccountAdminAccess: vi.fn<AuthenticatedApi['grantAccountAdminAccess']>(async (given) => {
      const renewed = held.account !== null && held.account.revokedAt === undefined
      held.account = renewed
        ? { ...held.account!, expiresAt: new Date(Date.now() + 72 * HOUR) }
        : accountGrant({ id: 'grant-account-again', expiresAt: new Date(Date.now() + 72 * HOUR) })
      if (renewed) setAccountGrantOnReports({ expiresAt: held.account.expiresAt })
      const linked = given?.reportId === undefined ? undefined : held.reports.get(given.reportId)
      if (linked !== undefined) {
        held.reports.set(linked.id, {
          ...linked,
          grant: { id: held.account.id, scope: 'account', expiresAt: held.account.expiresAt },
        })
      }
      return held.account
    }),
    revokeAccountAdminAccess: vi.fn<AuthenticatedApi['revokeAccountAdminAccess']>(async () => {
      if (held.account === null) return
      held.account = { ...held.account, revokedAt: new Date() }
      setAccountGrantOnReports({ endedAt: held.account.revokedAt })
    }),
    openWorkspace: vi.fn<(id: string) => unknown>(() => {
      const workspace = fakeWorkspace(held)
      workspaces.push(workspace)
      return workspace
    }),
  }
}

type FakeApi = ReturnType<typeof fakeApi>

let container: HTMLDivElement | undefined
let root: Root | undefined
let router: ReturnType<typeof createRouter> | undefined

beforeEach(() => {
  mocks.serverConfig = { adminContentGrants: true } satisfies Partial<ServerConfig>
  // The router restores scroll through window.scrollTo, which jsdom does not implement.
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Something else on the page that reads the count again, as the sidebar does when the window
// regains focus.
const CountReader = () => {
  const { refresh } = useIssueReportCount()
  return <button type="button" onClick={refresh}>Read the count</button>
}

// The page at /issues, under a router that reads `report` from the URL as the route does.
const renderPage = async (api: FakeApi, url = '/issues') => {
  mocks.authenticatedApi = api
  const rootRoute = createRootRoute({ component: () => <><CountReader /><Outlet /></> })
  const issues = createRoute({
    getParentRoute: () => rootRoute,
    path: '/issues',
    validateSearch: (search: Record<string, unknown>) => ({
      report: typeof search.report === 'string' ? search.report : undefined,
    }),
    component: function Issues() {
      return <MyIssues reportId={issues.useSearch().report} />
    },
  })
  const workspace = createRoute({ getParentRoute: () => rootRoute, path: '/workspace/$id', component: () => null })
  router = createRouter({
    routeTree: rootRoute.addChildren([issues, workspace]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router!.load()
    root!.render(<RouterProvider router={router!} />)
  })
  return api
}

const text = () => container!.textContent ?? ''
const alerts = () => [...container!.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)
const rows = () => [...container!.querySelectorAll<HTMLAnchorElement>('section[aria-label="Your issue reports"] li a')]
const row = (id: string) => rows().find((link) => link.getAttribute('href')?.includes(id))!
const detail = () => container!.querySelector<HTMLElement>('section[aria-label="Issue report"]')!
const thread = () => [...detail().querySelectorAll('ol[aria-label="Thread"] > li')]
const threadTexts = () => thread().map((entry) => entry.querySelector('p')?.textContent)
const dot = (id: string) => row(id).querySelector('[aria-label="New reply"]')

const findButton = (name: string, within: ParentNode = container!) => [...within.querySelectorAll('button')]
  .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
const button = (name: string, within?: ParentNode) => {
  const element = findButton(name, within)
  if (!element) throw new Error(`no button ${name}`)
  return element
}
const click = (element: HTMLElement) => act(async () => { element.click() })

const replyField = () => {
  const control = [...container!.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith('Reply to the admins'))?.control
  if (!(control instanceof HTMLTextAreaElement)) throw new Error('no reply field')
  return control
}
const typeReply = (value: string) => act(async () => {
  const element = replyField()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

// The card of the grant given with the open report, and the card of the account-wide grant.
const reportGrant = () => detail().querySelector<HTMLElement>('section[aria-labelledby="report-grant-heading"]')
const accountCard = () => container!.querySelector<HTMLElement>('section[aria-labelledby="account-grant-heading"]')

describe('the list', () => {
  it('lists each report by its first line, with its status, priority and filing date', async () => {
    await renderPage(fakeApi({ pages: [{ reports: [
      report('r-1', { status: 'waitingOnReporter', priority: 'high' }),
      report('r-2', { status: 'withAdmin', priority: 'low' }),
      report('r-3', { status: 'closed' }),
    ] }] }))

    expect(rows().map((link) => link.querySelector('.truncate')?.textContent))
      .toEqual(['Report r-1', 'Report r-2', 'Report r-3'])
    expect(row('r-1').textContent).toContain('Waiting on you')
    expect(row('r-1').textContent).toContain('High priority')
    expect(row('r-2').textContent).toContain('With the admins')
    expect(row('r-2').textContent).toContain('Low priority')
    expect(row('r-3').textContent).toContain('Closed')
    expect(row('r-1').querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12T09:30:00.000Z')
    expect(text()).not.toContain('Its second line.')
  })

  it('calls a proposed fix "Fix in review", and a report sent as with the admins "With the admins"', async () => {
    await renderPage(fakeApi({ pages: [{ reports: [
      report('r-1', { status: 'fixProposed' }),
      // What the server sends for a report whose fix is suggested or in progress.
      report('r-2', { status: 'withAdmin' }),
      // What the server never sends a reporter: the names are the last guard if it did.
      report('r-3', { status: 'fixSuggested' }),
      report('r-4', { status: 'fixInProgress' }),
    ] }] }))

    expect(row('r-1').textContent).toContain('Fix in review')
    for (const id of ['r-2', 'r-3', 'r-4']) expect(row(id).textContent).toContain('With the admins')
    expect(text()).not.toMatch(/Fix (suggested|in progress|proposed)/)
  })

  it('puts a dot on a report that holds a reply the reporter has not seen, and on no other', async () => {
    await renderPage(fakeApi({ pages: [{ reports: [
      report('r-1', { unseen: true }),
      // Its status changed, which alone does not make a report unseen.
      report('r-2', { status: 'investigating', unseen: false }),
    ] }] }))

    expect(dot('r-1')).not.toBeNull()
    expect(row('r-2').querySelector('[role="img"]')).toBeNull()
    expect(row('r-2').textContent).toContain('Investigating')
  })

  it('loads the next page on request, with the cursor the last page gave, until there is none', async () => {
    const api = await renderPage(fakeApi({ pages: [
      { reports: [report('r-1'), report('r-2')], nextCursor: '1' },
      { reports: [report('r-3')] },
    ] }))
    expect(api.listIssueReports.mock.calls).toEqual([[]])
    expect(rows()).toHaveLength(2)

    await click(button('Load more'))

    expect(api.listIssueReports.mock.calls).toEqual([[], ['1']])
    expect(rows().map((link) => link.querySelector('.truncate')?.textContent))
      .toEqual(['Report r-1', 'Report r-2', 'Report r-3'])
    expect(findButton('Load more')).toBeUndefined()
  })

  it('offers no further page when the first is the last', async () => {
    await renderPage(fakeApi({ pages: [{ reports: [report('r-1')] }] }))

    expect(findButton('Load more')).toBeUndefined()
  })

  it('says why a further page could not be loaded, and keeps the rows it has', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = await renderPage(fakeApi({ pages: [{ reports: [report('r-1')], nextCursor: '7' }] }))

    await click(button('Load more'))

    expect(api.listIssueReports).toHaveBeenLastCalledWith('7')
    expect(alerts()).toEqual(['no page 7'])
    expect(rows()).toHaveLength(1)
    expect(findButton('Load more')).toBeDefined()
  })

  it('reads the first page again when the count is read, over the pages it has loaded', async () => {
    const api = await renderPage(fakeApi({ pages: [
      { reports: [report('r-3'), report('r-2')], nextCursor: '1' },
      { reports: [report('r-1')] },
    ] }))
    await click(button('Load more'))
    // An admin replied to r-3, and the reporter has filed r-4 since.
    api.listIssueReports.mockResolvedValue({ reports: [report('r-4'), report('r-3', { unseen: true })], nextCursor: '1' })
    api.getUnseenIssueReportCount.mockResolvedValue(1)

    await click(button('Read the count'))

    expect(api.listIssueReports.mock.calls).toEqual([[], ['1'], []])
    expect(rows().map((link) => link.querySelector('.truncate')?.textContent))
      .toEqual(['Report r-4', 'Report r-3', 'Report r-2', 'Report r-1'])
    expect(dot('r-3')).not.toBeNull()
    // Every page was loaded, and still is.
    expect(findButton('Load more')).toBeUndefined()
  })

  it('lists a report filed while the page is open, though the count is read again and is the same', async () => {
    const api = await renderPage(fakeApi())
    expect(text()).toContain('You have reported no issues')

    // Filing a report asks for the count, which a report with no reply leaves at zero.
    api.held.reports.set('r-1', { ...report('r-1'), entries: [] })
    await click(button('Read the count'))

    expect(api.listIssueReports).toHaveBeenCalledTimes(2)
    expect(rows().map((link) => link.querySelector('.truncate')?.textContent)).toEqual(['Report r-1'])
    expect(text()).not.toContain('You have reported no issues')

    api.held.reports.set('r-2', { ...report('r-2'), entries: [] })
    await click(button('Read the count'))

    expect(api.listIssueReports).toHaveBeenCalledTimes(3)
    expect(rows()).toHaveLength(2)
  })

  it('keeps the rows it has, with no error, when reading the first page again fails', async () => {
    const api = await renderPage(fakeApi({ pages: [{ reports: [report('r-1')] }] }))
    api.listIssueReports.mockRejectedValue(new Error('The store is unavailable.'))
    api.getUnseenIssueReportCount.mockResolvedValue(1)

    await click(button('Read the count'))

    expect(api.listIssueReports).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(1)
    expect(alerts()).toEqual([])
  })

  it('says where Report issue is when the user has filed nothing', async () => {
    await renderPage(fakeApi())

    expect(rows()).toHaveLength(0)
    expect(text()).toContain('You have reported no issues')
    expect(text()).toContain('choose Report issue in your account menu or in a workspace’s menu')
  })

  it('says that the reports could not be loaded, and loads them on another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = fakeApi({ pages: [{ reports: [report('r-1')] }] })
    api.listIssueReports.mockRejectedValueOnce(new Error('The store is unavailable.'))
    await renderPage(api)
    expect(alerts()).toEqual(['The store is unavailable.Try again'])
    expect(text()).not.toContain('You have reported no issues')

    await click(button('Try again'))

    expect(alerts()).toEqual([])
    expect(rows()).toHaveLength(1)
  })
})

describe('what each reader calls a status', () => {
  it.each([
    ['fixSuggested', 'With the admins'],
    ['fixInProgress', 'With the admins'],
    ['fixProposed', 'Fix in review'],
    ['waitingOnReporter', 'Waiting on you'],
  ] as const)('says that the reporter reads %s as "%s", where the admins read another name', (status, name) => {
    expect(reporterReads(status)).toBe(name)
  })

  it.each(['new', 'investigating', 'answered', 'withAdmin', 'closed'] as const)(
    'says nothing of %s, which both read by one name',
    (status) => {
      expect(reporterReads(status)).toBeUndefined()
    },
  )

  // The property, so that a status added later is covered or fails here.
  it.each(ISSUE_REPORT_STATUSES)('says what the reporter reads of %s exactly when it is not what the admins read', (status) => {
    const forReporter = ISSUE_STATUS_NAMES[issueReportStatusForReporter(status)]

    expect(reporterReads(status)).toBe(forReporter === ADMIN_ISSUE_STATUS_NAMES[status] ? undefined : forReporter)
  })

  it.each(ISSUE_REPORT_STATUSES)('names %s for the reporter as the status the reporter reads in its place', (status) => {
    expect(ISSUE_STATUS_NAMES[status]).toBe(ISSUE_STATUS_NAMES[issueReportStatusForReporter(status)])
  })
})

// An admin's reply to r-1 that the store holds once the report was opened and marked seen.
const arrive = (api: FakeApi) => {
  const held = api.held.reports.get('r-1')!
  api.held.reports.set('r-1', {
    ...held,
    unseen: true,
    entries: [...held.entries, adminEntry('e-2', 'And which version?')],
  })
}

// A report with a reply from an admin that its reporter has not seen.
const opened = (change: Partial<Opened> = {}): Opened => ({
  ...report('r-1', { unseen: true }),
  entries: [adminEntry('e-1', 'Which browser are you using?')],
  ...change,
})

describe('an open report', () => {
  it('opens the report a row names, and gives its thread focus', async () => {
    const api = await renderPage(fakeApi({ opened: [opened(), opened({ id: 'r-2' })] }))
    expect(container!.querySelector('section[aria-label="Issue report"]')).toBeNull()
    expect(api.getIssueReport).not.toHaveBeenCalled()

    await click(row('r-1'))

    expect(router!.state.location.search).toEqual({ report: 'r-1' })
    expect(detail().textContent).toContain('Its second line.')
    expect(threadTexts()).toEqual(['Which browser are you using?'])
    expect(row('r-1').getAttribute('aria-current')).toBe('page')
    expect(row('r-2').hasAttribute('aria-current')).toBe(false)
    expect(detail().querySelector('a[href="/issues"]')?.hasAttribute('aria-current')).toBe(false)
    expect(document.activeElement).toBe(detail())
  })

  it('shows a report the URL names that is on no loaded page', async () => {
    const api = await renderPage(fakeApi({
      pages: [{ reports: [report('r-2')], nextCursor: '1' }],
      opened: [opened({ id: 'r-old', text: 'An older report' })],
    }), '/issues?report=r-old')

    expect(rows().map((link) => link.querySelector('.truncate')?.textContent)).toEqual(['Report r-2'])
    expect(api.getIssueReport).toHaveBeenCalledWith('r-old')
    expect(detail().textContent).toContain('An older report')
    expect(thread()).toHaveLength(1)
  })

  it('says so when the URL names no report of the reporter’s, and marks nothing', async () => {
    const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-gone')

    expect(alerts()).toEqual(['No such issue report.'])
    expect(api.markIssueReportSeen).not.toHaveBeenCalled()
  })

  it('names the workspace the report was filed in as a link to it', async () => {
    await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')

    expect(detail().querySelector('a[href="/workspace/ws-1"]')?.textContent).toBe('this workspace')
  })

  it('says a report from the home page was filed outside a workspace', async () => {
    await renderPage(fakeApi({ opened: [opened({ context: {} })] }), '/issues?report=r-1')

    expect(detail().textContent).toContain('outside a workspace')
    expect(detail().querySelector('a[href^="/workspace/"]')).toBeNull()
  })

  it('names an admin by name alone, and never renders a missing id', async () => {
    await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')

    expect(thread()[0].textContent).toContain('Grace Admin')
    expect(text()).not.toContain('undefined')
  })

  it('marks an admin’s entry as an admin’s, and the reporter’s own as nothing', async () => {
    await renderPage(fakeApi({ opened: [opened({ entries: [
      // A name that does not say what the badge says.
      adminEntry('e-1', 'Which browser are you using?', { author: { name: 'Grace Hopper' } }),
      ownEntry('e-2', 'Firefox, the latest.'),
    ] })] }), '/issues?report=r-1')

    const [admins, own] = thread()
    expect(admins.textContent).toBe(
      `Grace HopperAdmin${formatFullTimestamp(new Date('2026-10-12T10:00:00Z'))}Which browser are you using?`)
    expect(own.textContent).toBe(
      `Rita Reporter${formatFullTimestamp(new Date('2026-10-12T11:00:00Z'))}Firefox, the latest.`)
  })

  it('shows a bare change of status as one line naming the admin, with no bubble', async () => {
    await renderPage(fakeApi({ opened: [opened({
      status: 'investigating',
      entries: [
        adminEntry('e-1', 'Looking into it.'),
        adminEntry('e-2', '', { status: 'investigating', at: new Date('2026-10-12T10:05:00Z') }),
      ],
    })] }), '/issues?report=r-1')

    expect(thread()).toHaveLength(2)
    const [written, statusLine] = thread()
    expect(written.querySelector('p')?.textContent).toBe('Looking into it.')
    expect(statusLine.textContent).toBe(
      `Grace Admin set the status to Investigating${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`)
    expect(statusLine.querySelector('p')).toBeNull()
    expect(statusLine.className).not.toContain('border')
  })

  it('reads a proposed fix as "Fix in review", on the report and on the line that set it', async () => {
    await renderPage(fakeApi({ opened: [opened({
      status: 'fixProposed',
      entries: [adminEntry('e-1', '', { status: 'fixProposed', at: new Date('2026-10-12T10:05:00Z') })],
    })] }), '/issues?report=r-1')

    expect(detail().textContent).toContain('Fix in review')
    expect(thread()[0].textContent).toBe(
      `Grace Admin set the status to Fix in review${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`)
    expect(text()).not.toContain('Fix proposed')
  })

  it.each(['fixSuggested', 'fixInProgress'] as const)(
    'reads "%s" as "With the admins", on the report and on a line that set it',
    async (status) => {
      await renderPage(fakeApi({ opened: [opened({
        status,
        entries: [adminEntry('e-1', '', { status, at: new Date('2026-10-12T10:05:00Z') })],
      })] }), '/issues?report=r-1')

      expect(detail().textContent).toContain('With the admins')
      expect(thread()[0].textContent).toBe(
        `Grace Admin set the status to With the admins${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`)
      expect(text()).not.toMatch(/Fix (suggested|in progress)/)
    },
  )

  it('names an agent’s entry and its change of status as the agent’s, for the admin it wrote for', async () => {
    await renderPage(fakeApi({ opened: [opened({
      status: 'answered',
      entries: [
        adminEntry('e-1', 'Which browser are you using?'),
        adminEntry('e-2', 'It is fixed in the next release.', { via: 'gatekeeper' }),
        adminEntry('e-3', '', { via: 'gatekeeper', status: 'answered', at: new Date('2026-10-12T10:05:00Z') }),
      ],
    })] }), '/issues?report=r-1')

    const [person, agent, statusLine] = thread()
    expect(person.textContent).toBe(
      `Grace AdminAdmin${formatFullTimestamp(new Date('2026-10-12T10:00:00Z'))}Which browser are you using?`)
    expect(agent.textContent).toBe(
      `Agent, for Grace AdminAdmin${formatFullTimestamp(new Date('2026-10-12T10:00:00Z'))}It is fixed in the next release.`)
    expect(statusLine.textContent).toBe(
      `Agent, for Grace Admin, set the status to Answered${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`)
  })

  it('shows the reporter no origin and no link for an agent’s entry', async () => {
    // The server sends the reporter no origin. One that reached the page is not shown either.
    const agent = { workspaceId: 'ws-triage', chatId: 4 }
    await renderPage(fakeApi({ opened: [opened({
      status: 'answered',
      entries: [
        adminEntry('e-1', 'It is fixed in the next release.', { via: 'gatekeeper', agent }),
        adminEntry('e-2', '', { via: 'gatekeeper', agent, status: 'answered' }),
      ],
    })] }), '/issues?report=r-1')

    expect(thread()).toHaveLength(2)
    expect(thread()[0].textContent).toContain('Agent, for Grace Admin')
    expect(detail().querySelector('ol[aria-label="Thread"] dl')).toBeNull()
    expect(detail().querySelector('ol[aria-label="Thread"] a')).toBeNull()
    expect(text()).not.toMatch(/ws-triage|From workspace|From chat|Open chat/)
  })

  it('shows the status a written reply set beneath its text', async () => {
    await renderPage(fakeApi({ opened: [opened({
      status: 'withAdmin',
      entries: [ownEntry('e-1', 'It still fails.', { status: 'withAdmin' })],
    })] }), '/issues?report=r-1')

    expect([...thread()[0].querySelectorAll('p')].map((line) => line.textContent))
      .toEqual(['It still fails.', 'Status: With the admins'])
  })

  it('renders an entry’s text as plain text', async () => {
    await renderPage(fakeApi({ opened: [opened({
      entries: [adminEntry('e-1', '**Try** <img src=x onerror=alert(1)> [this](https://example.com)')],
    })] }), '/issues?report=r-1')

    const [entry] = thread()
    expect(entry.querySelector('p')?.textContent).toBe('**Try** <img src=x onerror=alert(1)> [this](https://example.com)')
    expect(entry.querySelector('img, a, strong')).toBeNull()
  })

  it('renders nothing that only admins read, even if the answer carried it', async () => {
    const carried = {
      ...opened({ entries: [adminEntry('e-1', 'On it.', { author: { id: 'grace@example.com', name: 'Grace Admin' } })] }),
      links: ['https://tickets.example.com/4812'],
      updatedAt: new Date('2026-10-13T00:00:00Z'),
    }
    await renderPage(fakeApi({ opened: [carried] }), '/issues?report=r-1')

    expect(thread()[0].textContent).toContain('Grace Admin')
    expect(text()).not.toContain('grace@example.com')
    expect(text()).not.toContain('tickets.example.com')
    expect(container!.querySelector('a[href^="https://tickets"]')).toBeNull()
  })

  it('renders nothing for a change of assignee, even if the answer carried one, and offers no assignment', async () => {
    const carried = {
      ...opened({ entries: [
        adminEntry('e-1', 'On it.'),
        adminEntry('e-2', '', { visibility: 'admins', assignment: 'claimed' }),
        adminEntry('e-3', '', { visibility: 'admins', assignment: 'takenOver', via: 'gatekeeper' }),
        adminEntry('e-4', '', { visibility: 'admins', assignment: 'released' }),
      ] }),
      assignee: { id: 'grace@example.com', name: 'Grace Assignee', at: new Date('2026-10-12T12:00:00Z'), via: 'api' },
    }
    await renderPage(fakeApi({ opened: [carried] }), '/issues?report=r-1')

    expect(thread()).toHaveLength(1)
    expect(threadTexts()).toEqual(['On it.'])
    expect(text()).not.toMatch(/took this report|released this report/)
    expect(text()).not.toMatch(/Assignee|Unassigned|Held by/)
    expect(text()).not.toContain('grace@example.com')
    expect(findButton('Assign to me')).toBeUndefined()
    expect(findButton('Release')).toBeUndefined()
  })

  it('reads the report’s images through the reporter’s API', async () => {
    const realCreate = URL.createObjectURL
    URL.createObjectURL = () => 'blob:test/1'
    try {
      const api = await renderPage(fakeApi({ opened: [opened({
        images: [{ id: 'image-1', type: 'image/png', byteLength: 4 }],
      })] }), '/issues?report=r-1')

      expect(api.readIssueReportImage.mock.calls).toEqual([['r-1', 'image-1']])
      expect(detail().querySelector('img')?.getAttribute('src')).toBe('blob:test/1')
    } finally {
      URL.createObjectURL = realCreate
    }
  })

  describe('marking it seen', () => {
    it('reads the report, marks it seen, reads it again, then refreshes the count', async () => {
      const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')

      expect(api.calls).toEqual([
        'getIssueReport', 'markIssueReportSeen', 'getIssueReport', 'getUnseenIssueReportCount',
      ])
      expect(api.markIssueReportSeen.mock.calls).toEqual([['r-1']])
      expect(dot('r-1')).toBeNull()
    })

    it('shows an entry that landed between the read and the mark', async () => {
      const api = fakeApi({ opened: [opened()] })
      const second = adminEntry('e-2', 'And which version?')
      const mark = Promise.withResolvers<void>()
      let shownAtMark: (string | null | undefined)[] | undefined
      api.markIssueReportSeen.mockImplementation(() => {
        api.calls.push('markIssueReportSeen')
        shownAtMark = threadTexts()
        // The store when the mark arrives: it holds one more entry by then, which the mark covers.
        api.held.reports.set('r-1', opened({ unseen: false, entries: [...opened().entries, second] }))
        return mark.promise
      })
      await renderPage(api, '/issues?report=r-1')

      // The mark was sent once the first read was on screen.
      expect(shownAtMark).toEqual(['Which browser are you using?'])
      // It has not answered: the first read is still what is shown, and the second is not sent.
      expect(threadTexts()).toEqual(['Which browser are you using?'])
      expect(api.calls).toEqual(['getIssueReport', 'markIssueReportSeen'])

      await act(async () => { mark.resolve() })

      expect(threadTexts()).toEqual(['Which browser are you using?', 'And which version?'])
      expect(api.calls).toEqual([
        'getIssueReport', 'markIssueReportSeen', 'getIssueReport', 'getUnseenIssueReportCount',
      ])
      expect(api.markIssueReportSeen).toHaveBeenCalledOnce()
    })

    it('keeps what the first read showed, with no error, when the second read fails', async () => {
      const api = fakeApi({ opened: [opened()] })
      api.getIssueReport
        .mockImplementationOnce(async () => opened())
        .mockRejectedValueOnce(new Error('The store is unavailable.'))
      await renderPage(api, '/issues?report=r-1')

      expect(api.getIssueReport).toHaveBeenCalledTimes(2)
      expect(threadTexts()).toEqual(['Which browser are you using?'])
      expect(alerts()).toEqual([])
      expect(dot('r-1')).toBeNull()
      expect(api.getUnseenIssueReportCount).toHaveBeenCalledOnce()
    })

    it('reads nothing again when the mark fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const api = fakeApi({ opened: [opened()] })
      api.markIssueReportSeen.mockRejectedValue(new Error('The store is unavailable.'))
      await renderPage(api, '/issues?report=r-1')

      expect(api.getIssueReport).toHaveBeenCalledOnce()
      expect(thread()).toHaveLength(1)
      expect(alerts()).toEqual([])
      expect(dot('r-1')).not.toBeNull()
    })

    it('marks each report once as the reporter goes from one to another', async () => {
      const api = await renderPage(fakeApi({ opened: [
        opened(),
        opened({ id: 'r-2', text: 'The second report', entries: [] }),
      ] }), '/issues?report=r-1')

      await click(row('r-2'))

      expect(detail().textContent).toContain('The second report')
      expect(detail().textContent).toContain('Nobody has replied yet.')
      expect(api.markIssueReportSeen.mock.calls).toEqual([['r-1'], ['r-2']])
    })

    it('marks nothing seen of a report its reporter left before its first read answered', async () => {
      const api = fakeApi({ opened: [opened(), opened({ id: 'r-2', unseen: false, entries: [] })] })
      const read = Promise.withResolvers<Opened>()
      api.getIssueReport.mockImplementationOnce(() => read.promise)
      await renderPage(api, '/issues?report=r-1')

      await click(row('r-2'))
      await act(async () => { read.resolve(opened()) })

      // The reply to r-1 was never on screen: it keeps its dot, and its count.
      expect(api.markIssueReportSeen.mock.calls).toEqual([['r-2']])
      expect(dot('r-1')).not.toBeNull()
    })

    it('clears the dot of a report its reporter left while the mark was on its way', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const api = fakeApi({ opened: [opened(), opened({ id: 'r-2', unseen: false, entries: [] })] })
      // The count cannot be read, so the list is not read again: the mark's answer alone is what
      // says that r-1 was seen.
      api.getUnseenIssueReportCount.mockRejectedValue(new Error('The store is unavailable.'))
      const mark = Promise.withResolvers<void>()
      api.markIssueReportSeen.mockImplementationOnce((id) => {
        api.held.reports.set(id, { ...api.held.reports.get(id)!, unseen: false })
        return mark.promise
      })
      await renderPage(api, '/issues?report=r-1')

      await click(row('r-2'))
      expect(dot('r-1')).not.toBeNull()

      await act(async () => { mark.resolve() })

      expect(dot('r-1')).toBeNull()
      expect(detail().textContent).toContain('Nobody has replied yet.')
    })
  })

  describe('a reply that arrives while the report is open', () => {
    const onceOpened = ['getIssueReport', 'markIssueReportSeen', 'getIssueReport', 'getUnseenIssueReportCount']

    it('opens the report again when the list read after the count says it holds one', async () => {
      const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')
      arrive(api)

      await click(button('Read the count'))

      expect(threadTexts()).toEqual(['Which browser are you using?', 'And which version?'])
      expect(api.calls).toEqual([...onceOpened, 'getUnseenIssueReportCount', ...onceOpened])
      expect(dot('r-1')).toBeNull()
    })

    it('opens the report again when its row is pressed', async () => {
      const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')
      arrive(api)

      await click(row('r-1'))

      expect(threadTexts()).toEqual(['Which browser are you using?', 'And which version?'])
      expect(api.calls).toEqual([...onceOpened, ...onceOpened])
    })

    it('keeps the report on screen, with no error, when opening it again fails', async () => {
      const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')
      api.getIssueReport.mockRejectedValueOnce(new Error('The store is unavailable.'))

      await click(row('r-1'))

      expect(api.getIssueReport).toHaveBeenCalledTimes(3)
      expect(threadTexts()).toEqual(['Which browser are you using?'])
      expect(alerts()).toEqual([])
      expect(api.markIssueReportSeen).toHaveBeenCalledOnce()
    })
  })

  describe('replying', () => {
    it('sends the trimmed reply, shows it, and shows the status it left', async () => {
      const api = await renderPage(
        fakeApi({ opened: [opened({ status: 'waitingOnReporter' })] }), '/issues?report=r-1')
      const reads = api.getIssueReport.mock.calls.length

      await typeReply('  Firefox, the latest.  ')
      await click(button('Send reply'))

      expect(api.replyToIssueReport.mock.calls).toEqual([['r-1', 'Firefox, the latest.']])
      expect(thread()).toHaveLength(2)
      expect([...thread()[1].querySelectorAll('p')].map((line) => line.textContent))
        .toEqual(['Firefox, the latest.', 'Status: With the admins'])
      expect(thread()[1].textContent).toContain('Rita Reporter')
      expect(row('r-1').textContent).toContain('With the admins')
      expect(replyField().value).toBe('')
      // The reply's answer is what is shown: a read would show entries that were never marked seen.
      expect(api.getIssueReport).toHaveBeenCalledTimes(reads)
    })

    it('keeps a reply sent while the report was being read, in the thread and in the list', async () => {
      const waiting = opened({ status: 'waitingOnReporter' })
      const api = fakeApi({ opened: [waiting] })
      const second = Promise.withResolvers<Opened>()
      api.getIssueReport
        .mockImplementationOnce(async () => waiting)
        .mockImplementationOnce(() => second.promise)
      await renderPage(api, '/issues?report=r-1')

      await typeReply('Firefox, the latest.')
      await click(button('Send reply'))
      // The read answers as the store was before the reply reached it.
      await act(async () => { second.resolve({ ...waiting, unseen: false }) })

      expect(threadTexts()).toEqual(['Which browser are you using?', 'Firefox, the latest.'])
      expect(row('r-1').textContent).toContain('With the admins')
      expect(detail().textContent).not.toContain('Waiting on you')
    })

    it('shows a reply once when a read that holds it answers before the reply’s own call', async () => {
      const api = fakeApi({ opened: [opened({ status: 'waitingOnReporter' })] })
      const answer = Promise.withResolvers<void>()
      const store = api.replyToIssueReport.getMockImplementation()!
      api.replyToIssueReport.mockImplementation(async (id, written) => {
        // The store holds the reply from here; its answer reaches the page later.
        const entry = await store(id, written)
        await answer.promise
        return entry
      })
      await renderPage(api, '/issues?report=r-1')

      await typeReply('Firefox, the latest.')
      await click(button('Send reply'))
      // Opening the report again reads it with the reply in it.
      await click(row('r-1'))
      expect(threadTexts()).toEqual(['Which browser are you using?', 'Firefox, the latest.'])

      await act(async () => { answer.resolve() })

      expect(threadTexts()).toEqual(['Which browser are you using?', 'Firefox, the latest.'])
      expect(row('r-1').textContent).toContain('With the admins')
      expect(replyField().value).toBe('')
    })

    it('says why a reply was refused, and keeps what was written', async () => {
      const api = fakeApi({ opened: [opened()] })
      api.replyToIssueReport.mockRejectedValue(createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyReplies))
      await renderPage(api, '/issues?report=r-1')

      await typeReply('Once more.')
      await click(button('Send reply'))

      expect(alerts()).toEqual(['You have replied to issue reports too many times today. Try again tomorrow.'])
      expect(replyField().value).toBe('Once more.')
      expect(thread()).toHaveLength(1)
    })

    it('keeps what was written while a reply was being sent, and clears a field left as it was sent', async () => {
      const api = fakeApi({ opened: [opened()] })
      const answer = Promise.withResolvers<void>()
      const store = api.replyToIssueReport.getMockImplementation()!
      api.replyToIssueReport.mockImplementationOnce(async (id, written) => {
        await answer.promise
        return store(id, written)
      })
      await renderPage(api, '/issues?report=r-1')

      await typeReply('Firefox.')
      await click(button('Send reply'))
      await typeReply('Firefox. And Safari.')
      await act(async () => { answer.resolve() })

      expect(threadTexts()).toEqual(['Which browser are you using?', 'Firefox.'])
      expect(replyField().value).toBe('Firefox. And Safari.')

      await click(button('Send reply'))

      expect(threadTexts()).toEqual(['Which browser are you using?', 'Firefox.', 'Firefox. And Safari.'])
      expect(replyField().value).toBe('')
    })

    it('sends nothing blank', async () => {
      const api = await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')
      expect(button('Send reply').disabled).toBe(true)

      await typeReply('   \n ')

      expect(button('Send reply').disabled).toBe(true)
      expect(api.replyToIssueReport).not.toHaveBeenCalled()
    })

    it('bounds a reply as the server counts it, on the trimmed text', async () => {
      await renderPage(fakeApi({ opened: [opened()] }), '/issues?report=r-1')

      await typeReply(`${'a'.repeat(MAX_ISSUE_REPORT_TEXT_LENGTH)}   `)
      expect(button('Send reply').disabled).toBe(false)
      expect(text()).toContain(`${MAX_ISSUE_REPORT_TEXT_LENGTH} of ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters`)

      await typeReply('a'.repeat(MAX_ISSUE_REPORT_TEXT_LENGTH + 1))
      expect(button('Send reply').disabled).toBe(true)
      expect(text()).toContain(`${MAX_ISSUE_REPORT_TEXT_LENGTH + 1} of ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters`)
    })

    it('takes no reply to a closed report, and says why', async () => {
      await renderPage(fakeApi({ opened: [opened({ status: 'closed' })] }), '/issues?report=r-1')

      expect(replyField().disabled).toBe(true)
      expect(button('Send reply').disabled).toBe(true)
      expect(detail().textContent).toContain('This report is closed, so it takes no more replies.')
    })
  })
})

const withGrant = (grant: IssueReportGrant, change: Partial<Opened> = {}): Opened => ({
  ...report('r-1'),
  entries: [],
  grant,
  ...change,
})
const until = (grant: IssueReportGrant) => formatFullTimestamp(grant.expiresAt)

describe('the grant given with a report', () => {
  it('shows no grant for a report that came with none', async () => {
    await renderPage(fakeApi({ opened: [{ ...report('r-1'), entries: [] }] }), '/issues?report=r-1')

    expect(reportGrant()).toBeNull()
  })

  it('says what a live grant covers and until when', async () => {
    const grant = liveGrant('workspace')
    await renderPage(fakeApi({ opened: [withGrant(grant)] }), '/issues?report=r-1')

    expect(reportGrant()!.textContent).toContain(`This workspace, until ${until(grant)}`)
    // It speaks of this grant only: another one, given with another report or for all
    // workspaces, still lets admins read.
    expect(reportGrant()!.textContent).toContain(
      'End access ends this grant alone: admins can read nothing more under it from their next call. '
        + 'Any other grant you gave stays until you end it too.')
    expect(reportGrant()!.textContent).not.toContain('no longer')
  })

  it('renews a workspace’s grant on the workspace, disposes it, and reads the report again', async () => {
    const api = await renderPage(fakeApi({ opened: [withGrant(liveGrant('workspace'))] }), '/issues?report=r-1')
    const reads = api.getIssueReport.mock.calls.length

    await click(button('Renew', reportGrant()!))

    expect(api.openWorkspace.mock.calls).toEqual([['ws-1']])
    const [workspace] = api.workspaces
    expect(workspace.renewAdminAccess.mock.calls).toEqual([['grant-workspace']])
    expect(workspace[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(api.getIssueReport).toHaveBeenCalledTimes(reads + 1)
    expect(reportGrant()!.textContent).toContain(`until ${until(api.held.reports.get('r-1')!.grant!)}`)
    expect(api.markIssueReportSeen).toHaveBeenCalledOnce()
    expect(alerts()).toEqual([])
  })

  it('ends a workspace’s grant on the workspace, disposes it, and shows that it ended', async () => {
    const api = await renderPage(fakeApi({ opened: [withGrant(liveGrant('workspace'))] }), '/issues?report=r-1')

    await click(button('End access', reportGrant()!))

    const [workspace] = api.workspaces
    expect(workspace.revokeAdminAccess.mock.calls).toEqual([['grant-workspace']])
    expect(workspace[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(reportGrant()!.textContent).toContain(
      `This workspace. Ended ${formatFullTimestamp(api.held.reports.get('r-1')!.grant!.endedAt!)}`)
    expect(findButton('End access', reportGrant()!)).toBeUndefined()
    expect(findButton('Renew', reportGrant()!)).toBeUndefined()
    expect(alerts()).toEqual([])
  })

  it('takes of the report read after a change its grant alone', async () => {
    const api = await renderPage(fakeApi({ opened: [withGrant(liveGrant('workspace'))] }), '/issues?report=r-1')
    // An admin's reply that landed since the report was opened: it was not marked seen.
    const held = api.held.reports.get('r-1')!
    api.held.reports.set('r-1', { ...held, entries: [adminEntry('e-late', 'A late reply.')] })

    await click(button('Renew', reportGrant()!))

    expect(text()).not.toContain('A late reply.')
    expect(api.markIssueReportSeen).toHaveBeenCalledOnce()
  })

  it('disposes the workspace and says why when ending the grant is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = fakeApi({ opened: [withGrant(liveGrant('workspace'))] })
    const refused = fakeWorkspace(api.held)
    refused.revokeAdminAccess.mockRejectedValue(new Error('The workspace is unavailable.'))
    api.openWorkspace.mockReturnValue(refused)
    await renderPage(api, '/issues?report=r-1')

    await click(button('End access', reportGrant()!))

    expect(refused[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(alerts()).toEqual(['The workspace is unavailable.'])
    expect(findButton('End access', reportGrant()!)).toBeDefined()
  })

  it('renews and ends an account-wide grant in the account, opening no workspace', async () => {
    const api = await renderPage(fakeApi({
      opened: [withGrant(liveGrant('account', 'grant-account'))],
      account: accountGrant(),
    }), '/issues?report=r-1')
    expect(reportGrant()!.textContent).toContain('All my workspaces, until')
    expect(reportGrant()!.textContent).toContain(
      'End access ends this grant alone: admins can read nothing more under it within a minute.')

    await click(button('Renew', reportGrant()!))
    expect(api.grantAccountAdminAccess.mock.calls).toEqual([[]])

    await click(button('End access', reportGrant()!))
    expect(api.revokeAccountAdminAccess.mock.calls).toEqual([[]])
    expect(reportGrant()!.textContent).toContain('All my workspaces. Ended')
    expect(api.openWorkspace).not.toHaveBeenCalled()
    // The account-wide card shows the same grant, and went with it.
    expect(accountCard()).toBeNull()
  })

  it('gives a workspace’s ended grant again with the report, and shows the grant that replaced it', async () => {
    const ended = { ...liveGrant('workspace'), endedAt: new Date(Date.now() - HOUR) }
    const api = await renderPage(fakeApi({ opened: [withGrant(ended)] }), '/issues?report=r-1')
    expect(findButton('Renew', reportGrant()!)).toBeUndefined()

    await click(button('Give access again', reportGrant()!))

    const [workspace] = api.workspaces
    expect(workspace.grantAdminAccess.mock.calls).toEqual([[{ reportId: 'r-1' }]])
    expect(workspace[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(reportGrant()!.textContent).toContain('This workspace, until')
    expect(findButton('End access', reportGrant()!)).toBeDefined()
  })

  it('gives an ended account-wide grant again with the report', async () => {
    const ended = { ...liveGrant('account', 'grant-account'), endedAt: new Date(Date.now() - HOUR) }
    const api = await renderPage(fakeApi({ opened: [withGrant(ended, { context: {} })] }), '/issues?report=r-1')

    await click(button('Give access again', reportGrant()!))

    expect(api.grantAccountAdminAccess.mock.calls).toEqual([[{ reportId: 'r-1' }]])
    expect(reportGrant()!.textContent).toContain('All my workspaces, until')
    expect(accountCard()).not.toBeNull()
  })

  it('says a grant past its end expired', async () => {
    const expired = { ...liveGrant('workspace'), expiresAt: new Date(Date.now() - HOUR) }
    await renderPage(fakeApi({ opened: [withGrant(expired)] }), '/issues?report=r-1')

    expect(reportGrant()!.textContent).toContain('This workspace. Expired')
    expect(findButton('End access', reportGrant()!)).toBeUndefined()
    expect(findButton('Give access again', reportGrant()!)).toBeDefined()
  })

  it('offers no grant again where the deployment does not let content be read', async () => {
    mocks.serverConfig = {}
    const ended = { ...liveGrant('workspace'), endedAt: new Date(Date.now() - HOUR) }
    await renderPage(fakeApi({ opened: [withGrant(ended)] }), '/issues?report=r-1')

    expect(reportGrant()!.textContent).toContain('Ended')
    expect(findButton('Give access again')).toBeUndefined()
  })
})

describe('the account-wide grant', () => {
  it('has a card of its own while it is live, whatever reports there are', async () => {
    const grant = accountGrant()
    await renderPage(fakeApi({ account: grant }))

    expect(accountCard()!.textContent).toContain('Admins can read the content of all your workspaces')
    expect(accountCard()!.textContent).toContain(`All my workspaces, until ${formatFullTimestamp(grant.expiresAt)}`)
  })

  it.each([
    ['none was given', null],
    ['it was ended', accountGrant({ revokedAt: new Date(Date.now() - HOUR) })],
    ['it expired', accountGrant({ expiresAt: new Date(Date.now() - HOUR) })],
  ])('has no card when %s', async (_name, grant) => {
    await renderPage(fakeApi({ account: grant }))

    expect(accountCard()).toBeNull()
  })

  it('renews it from the card, and shows its later end', async () => {
    const api = await renderPage(fakeApi({ account: accountGrant() }))

    await click(button('Renew', accountCard()!))

    expect(api.grantAccountAdminAccess.mock.calls).toEqual([[]])
    expect(api.getAccountAdminGrant).toHaveBeenCalledTimes(2)
    expect(accountCard()!.textContent).toContain(`until ${formatFullTimestamp(api.held.account!.expiresAt)}`)
  })

  it('ends it from the card, which goes, and the open report that shows it says it ended', async () => {
    const api = await renderPage(fakeApi({
      opened: [{ ...report('r-1'), entries: [], grant: liveGrant('account', 'grant-account') }],
      account: accountGrant(),
    }), '/issues?report=r-1')

    await click(button('End access', accountCard()!))

    expect(api.revokeAccountAdminAccess.mock.calls).toEqual([[]])
    expect(accountCard()).toBeNull()
    expect(reportGrant()!.textContent).toContain('All my workspaces. Ended')
    expect(api.openWorkspace).not.toHaveBeenCalled()
  })
})
