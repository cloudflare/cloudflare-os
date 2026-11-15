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
  useNavigate,
} from '@tanstack/react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ISSUE_REPORT_ERROR_CODES,
  MAX_ISSUE_REPORT_LINKS,
  MAX_ISSUE_REPORT_RETENTION_DAYS,
  MAX_ISSUE_REPORT_THREAD_ENTRIES,
  createIssueReportError,
  type AdminApi,
  type AdminIssueReport,
  type AuthenticatedApi,
  type IssueReportEntry,
  type IssueReportGrant,
  type IssueReportImage,
} from '@gadgets/workshop-shared/api'
import type { ReportRetention } from './reportSettings'

const mocks = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
  // The reporter's API, as it answers an admin about somebody else's report.
  authenticatedApi: { readIssueReportImage: vi.fn<AuthenticatedApi['readIssueReportImage']>() },
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: mocks.addToast }),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi, isAdmin: true }),
}))

import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { AdminReportsPanel, REPORT_PAGE_SIZE } from './AdminReportsPanel'
import { reportSearchOf } from './reportFilter'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Opened = AdminIssueReport & { entries: IssueReportEntry[] }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const FILED = new Date('2026-10-12T09:30:00Z')

const report = (id: string, change: Partial<Opened> = {}): Opened => ({
  id,
  filedAt: FILED,
  updatedAt: FILED,
  reporter: { id: 'rita@example.test', name: 'Rita Reporter' },
  text: `Report ${id}\nIts second line.`,
  priority: 'medium',
  context: { workspaceId: 'ws-1' },
  status: 'new',
  images: [],
  links: [],
  entries: [],
  ...change,
})

const reporterEntry = (id: string, text: string, change: Partial<IssueReportEntry> = {}): IssueReportEntry => ({
  id,
  at: new Date('2026-10-12T11:00:00Z'),
  author: { id: 'rita@example.test', name: 'Rita Reporter' },
  visibility: 'public',
  text,
  ...change,
})

const adminEntry = (id: string, text: string, change: Partial<IssueReportEntry> = {}): IssueReportEntry => ({
  id,
  at: new Date('2026-10-12T10:00:00Z'),
  author: { id: 'grace@example.test', name: 'Grace Admin' },
  visibility: 'public',
  via: 'api',
  text,
  ...change,
})

const grant = (scope: IssueReportGrant['scope'], change: Partial<IssueReportGrant> = {}): IssueReportGrant => ({
  id: `grant-${scope}`,
  scope,
  expiresAt: new Date(Date.now() + 70 * HOUR + 30 * MINUTE),
  ...change,
})

const PNG: IssueReportImage = { id: 'img-png', type: 'image/png', byteLength: 3 }
const WEBP: IssueReportImage = { id: 'img-webp', type: 'image/webp', byteLength: 2 }

const streamOf = (bytes: number[]) => new ReadableStream<Uint8Array>({
  start: (controller) => {
    controller.enqueue(new Uint8Array(bytes))
    controller.close()
  },
})

// The admins' API over reports it holds as the server does, newest first: what a call changes,
// the next read returns. The signed-in admin is Ada.
const fakeAdmin = (reports: Opened[], options: { pageSize?: number } = {}) => {
  const held = new Map(reports.map((opened) => [opened.id, opened]))
  const get = (id: string) => {
    const opened = held.get(id)
    if (opened === undefined) throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound)
    return opened
  }
  const ada = { id: 'ada@example.test', name: 'Ada Admin' }
  let entries = 0
  const addEntry = (opened: Opened, entry: Omit<IssueReportEntry, 'id' | 'at' | 'author' | 'via'>) => {
    const added: IssueReportEntry = {
      id: `added-${++entries}`, at: new Date('2026-10-13T08:00:00Z'), author: ada, via: 'api', ...entry,
    }
    held.set(opened.id, { ...opened, ...(entry.status && { status: entry.status }), updatedAt: added.at, entries: [...opened.entries, added] })
    return added
  }
  return {
    held,
    listIssueReports: vi.fn<AdminApi['listIssueReports']>(async (query = {}) => {
      const matching = [...held.values()].filter((opened) =>
        (query.status === undefined || opened.status === query.status)
        && (query.priority === undefined || opened.priority === query.priority)
        && (query.reporter === undefined || opened.reporter.id === query.reporter)
        && (query.workspace === undefined || opened.context.workspaceId === query.workspace))
      const size = options.pageSize ?? query.limit ?? 50
      const from = query.cursor === undefined ? 0 : Number(query.cursor)
      const page = matching.slice(from, from + size).map(({ entries: _entries, ...listed }) => listed)
      return from + size < matching.length ? { reports: page, nextCursor: String(from + size) } : { reports: page }
    }),
    getIssueReport: vi.fn<AdminApi['getIssueReport']>(async (id) => get(id)),
    addIssueReportEntry: vi.fn<AdminApi['addIssueReportEntry']>(async (id, text, visibility) =>
      addEntry(get(id), { text, visibility })),
    setIssueReportStatus: vi.fn<AdminApi['setIssueReportStatus']>(async (id, status) => {
      addEntry(get(id), { text: '', visibility: 'public', status })
    }),
    // Keeps each link as the URL it parses to, as the server does.
    setIssueReportLinks: vi.fn<AdminApi['setIssueReportLinks']>(async (id, links) => {
      held.set(id, { ...get(id), links: links.map((link) => new URL(link).href) })
    }),
    readIssueReportImage: vi.fn<AdminApi['readIssueReportImage']>(async () => streamOf([1, 2, 3])),
    setIssueReportRetentionDays: vi.fn<AdminApi['setIssueReportRetentionDays']>(async () => {}),
  }
}

type FakeAdmin = ReturnType<typeof fakeAdmin>

// The Blobs object URLs were made of, in order: jsdom makes no object URLs of its own.
const realUrls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }
let blobs: Blob[]

let container: HTMLDivElement | undefined
let root: Root | undefined
let router: ReturnType<typeof createRouter> | undefined
let onSettingsChanged: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(() => {
  blobs = []
  URL.createObjectURL = vi.fn<(blob: Blob) => string>((blob) => `blob:test/${blobs.push(blob)}`)
  URL.revokeObjectURL = vi.fn<(url: string) => void>()
  onSettingsChanged = vi.fn<() => Promise<void>>(async () => {})
  mocks.authenticatedApi.readIssueReportImage.mockReset()
    .mockRejectedValue(createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound))
  // The router restores scroll through window.scrollTo, which jsdom does not implement.
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  URL.createObjectURL = realUrls.createObjectURL
  URL.revokeObjectURL = realUrls.revokeObjectURL
  mocks.addToast.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const RETENTION: ReportRetention = { effective: 90, chosen: 90, min: 90 }

// The panel at /admin, under a router that keeps the tab's filters and the open report in the
// URL as the admin page does.
const renderPanel = async (admin: FakeAdmin, url = '/admin?tab=reports', retention = RETENTION) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    validateSearch: (search: Record<string, unknown>) => ({ tab: 'reports' as const, ...reportSearchOf(search) }),
    component: function Admin() {
      const navigate = useNavigate()
      const { tab: _tab, report: reportId, ...filter } = adminRoute.useSearch()
      return (
        <AdminReportsPanel
          admin={admin as never}
          retention={retention}
          onSettingsChanged={onSettingsChanged}
          filter={filter}
          onFilterChange={(next) => void navigate({ to: '/admin', search: { tab: 'reports', ...next }, replace: true })}
          reportId={reportId}
        />
      )
    },
  })
  const workspace = createRoute({
    getParentRoute: () => rootRoute, path: '/admin/workspace/$workspaceId', component: () => null,
  })
  router = createRouter({
    routeTree: rootRoute.addChildren([adminRoute, workspace]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router!.load()
    root!.render(<RouterProvider router={router!} />)
  })
  // The list, the open report and its images each answer in turns of their own.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return admin
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const search = () => router!.state.location.search as Record<string, unknown>

const alerts = () => [...container!.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)
const listing = () => container!.querySelector<HTMLElement>('ul[aria-label="Issue reports"]')
const rows = () => [...listing()?.querySelectorAll<HTMLElement>(':scope > li') ?? []]
const rowTitles = () => rows().map((item) => item.querySelector('a')?.textContent)
const row = (id: string) => rows().find((item) => item.querySelector(`a[data-report-id="${id}"]`))!
const rowLink = (id: string) => row(id).querySelector('a')!
const heading = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>('h2, h3')].find((element) => element.textContent === name)
const detail = () => heading('Issue report')?.closest('section') ?? null
const thread = () => [...detail()!.querySelectorAll('ol[aria-label="Thread"] > li')]
// Whether the list is what the panel shows: an open report takes its place.
const listShown = () => !heading('Issue reports')!.closest('[hidden]')
// A card of the open report, by its heading.
const card = (name: string) => heading(name)!.closest('section')!

const findButton = (name: string, within: ParentNode = container!) => [...within.querySelectorAll('button')]
  .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
const button = (name: string, within?: ParentNode) => {
  const element = findButton(name, within)
  if (!element) throw new Error(`no button ${name}`)
  return element
}
const click = (element: HTMLElement) => act(async () => { element.click() })

const field = <T extends HTMLElement>(label: string, kind: new () => T): T => {
  const control = [...container!.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith(label))?.control
  if (!(control instanceof kind)) throw new Error(`no field ${label}`)
  return control
}
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})
const submit = (element: HTMLElement) => act(async () => {
  element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})

// The list's status and priority filters, and the open report's status, each by its trigger.
const filterSelect = (name: 'status' | 'priority') =>
  container!.querySelectorAll<HTMLElement>('[role="search"] [role="combobox"]')[name === 'status' ? 0 : 1]
const statusSelect = () => detail()!.querySelector<HTMLElement>('[role="combobox"]')!
// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom
// lacks, so the window has a stand-in for as long as the choice takes.
const choose = async (trigger: HTMLElement, label: string) => {
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger)
  const list = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
  const option = [...list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []]
    .find((element) => element.textContent === label)
  if (!option) throw new Error(`no option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  const previous = view.PointerEvent
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    view.PointerEvent = previous
  }
  await settle()
}

const radios = () => [...detail()!.querySelectorAll<HTMLElement>('[role="radio"]')]
const radioName = (radio: HTMLElement) => radio.closest('label')!.textContent!.trim()
const chosenVisibility = () =>
  radios().filter((radio) => radio.getAttribute('aria-checked') === 'true').map(radioName)
// Through the radio's own input: the visible control clicks it with a PointerEvent, which jsdom
// lacks.
const chooseVisibility = (name: string) => act(async () => {
  radios().find((radio) => radioName(radio) === name)!.closest('label')!.querySelector('input')!.click()
})
const composerField = () => detail()!.querySelector('form textarea') as HTMLTextAreaElement
const consequence = () => detail()!.querySelector('form [role="status"]')?.textContent

describe('the list', () => {
  it('lists each report by its first line, with where it stands, who filed it, where and when', async () => {
    const updated = new Date('2026-10-13T08:00:00Z')
    await renderPanel(fakeAdmin([
      report('r-1', { status: 'withAdmin', priority: 'high', updatedAt: updated }),
      report('r-2', { status: 'waitingOnReporter', priority: 'low', context: {} }),
    ]))

    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2'])
    expect(container!.textContent).not.toContain('Its second line.')
    expect(row('r-1').textContent).toContain('With the admins')
    expect(row('r-1').textContent).toContain('High priority')
    expect(row('r-1').textContent).toContain('Rita Reporter')
    expect(row('r-1').textContent).toContain('ws-1')
    expect(row('r-1').textContent).toContain(`Filed ${formatFullTimestamp(FILED)}`)
    expect(row('r-1').textContent).toContain(`Updated ${formatFullTimestamp(updated)}`)
    // Named as the admins read it, and with no workspace to filter by.
    expect(row('r-2').textContent).toContain('Waiting on the reporter')
    expect(row('r-2').textContent).toContain('Low priority')
    expect(findButton('Show only reports naming workspace ws-1', row('r-2'))).toBeUndefined()
    // Nothing was written in its thread since it was filed.
    expect(row('r-2').textContent).not.toContain('Updated')
  })

  it('counts a report’s images in its row, and shows no count for a report with none', async () => {
    await renderPanel(fakeAdmin([
      report('r-1', { images: [PNG, WEBP] }),
      report('r-2', { images: [PNG] }),
      report('r-3'),
    ]))

    expect(row('r-1').textContent).toContain('2 images')
    expect(row('r-2').textContent).toContain('1 image')
    expect(row('r-2').textContent).not.toContain('1 images')
    expect(row('r-3').textContent).not.toMatch(/image/)
  })

  it('says what the grant given with a report covers and how long it has left, or how it ended', async () => {
    await renderPanel(fakeAdmin([
      report('r-1', { grant: grant('workspace') }),
      report('r-2', { grant: grant('account', { expiresAt: new Date(Date.now() + 20 * MINUTE + 30_000) }) }),
      report('r-3', { grant: grant('workspace', { endedAt: new Date(Date.now() - HOUR) }) }),
      report('r-4', { grant: grant('account', { expiresAt: new Date(Date.now() - MINUTE) }) }),
      report('r-5'),
    ]))

    expect(row('r-1').textContent).toContain('Content: this workspace, 70 hours left')
    expect(row('r-2').textContent).toContain('Content: all the reporter’s workspaces, 20 minutes left')
    expect(row('r-3').textContent).toContain('Content: this workspace, ended')
    expect(row('r-4').textContent).toContain('Content: all the reporter’s workspaces, expired')
    expect(row('r-5').textContent).not.toContain('Content:')
  })

  it('asks for the newest page with no filter, and says when nobody has filed a report', async () => {
    const admin = await renderPanel(fakeAdmin([]))

    expect(admin.listIssueReports.mock.calls).toEqual([[{ limit: REPORT_PAGE_SIZE }]])
    expect(container!.textContent).toContain('Nobody has filed an issue report yet.')
    expect(findButton('Clear filters')).toBeUndefined()
  })

  it('sends the filters the URL holds, and says when no report matches them', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1')]),
      '/admin?tab=reports&status=closed&priority=high&reporter=rita%40example.test&workspace=ws-9',
    )

    expect(admin.listIssueReports.mock.calls).toEqual([[{
      status: 'closed', priority: 'high', reporter: 'rita@example.test', workspace: 'ws-9', limit: REPORT_PAGE_SIZE,
    }]])
    expect(container!.textContent).toContain('No issue report matches these filters.')
    expect(filterSelect('status').textContent).toBe('Closed')
    expect(filterSelect('priority').textContent).toBe('High')
  })

  it('filters by a status and a priority chosen, in the query and in the URL', async () => {
    const admin = await renderPanel(fakeAdmin([
      report('r-1', { status: 'withAdmin', priority: 'high' }),
      report('r-2', { status: 'withAdmin' }),
      report('r-3'),
    ]))

    await choose(filterSelect('status'), 'With the admins')

    expect(admin.listIssueReports).toHaveBeenLastCalledWith({ status: 'withAdmin', limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports', status: 'withAdmin' })
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2'])

    await choose(filterSelect('priority'), 'High')

    expect(admin.listIssueReports)
      .toHaveBeenLastCalledWith({ status: 'withAdmin', priority: 'high', limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports', status: 'withAdmin', priority: 'high' })
    expect(rowTitles()).toEqual(['Report r-1'])

    await choose(filterSelect('status'), 'Any status')

    expect(admin.listIssueReports).toHaveBeenLastCalledWith({ priority: 'high', limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports', priority: 'high' })
  })

  it('filters by a row’s reporter, by id, and names the chip that removes the filter after them', async () => {
    const admin = await renderPanel(fakeAdmin([
      report('r-1'),
      report('r-2', { reporter: { id: 'omar@example.test', name: 'Omar Other' } }),
    ]))

    await click(button('Show only Omar Other’s reports', row('r-2')))
    await settle()

    expect(admin.listIssueReports).toHaveBeenLastCalledWith({ reporter: 'omar@example.test', limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports', reporter: 'omar@example.test' })
    expect(rowTitles()).toEqual(['Report r-2'])
    const chip = button('Show every reporter, not only Omar Other')
    expect(chip.textContent).toBe('Reporter: Omar Other')
    expect(document.activeElement).toBe(chip)

    await click(chip)
    await settle()

    expect(admin.listIssueReports).toHaveBeenLastCalledWith({ limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports' })
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2'])
    expect(document.activeElement).toBe(filterSelect('status'))
  })

  it('filters by a row’s workspace, and clears every filter at once', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1'), report('r-2', { context: { workspaceId: 'ws-2' } })]),
      '/admin?tab=reports&priority=medium',
    )

    await click(button('Show only reports naming workspace ws-2', row('r-2')))
    await settle()

    expect(admin.listIssueReports)
      .toHaveBeenLastCalledWith({ priority: 'medium', workspace: 'ws-2', limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports', priority: 'medium', workspace: 'ws-2' })
    expect(rowTitles()).toEqual(['Report r-2'])
    const chip = button('Show every workspace, not only ws-2')
    expect(chip.textContent).toBe('Workspace: ws-2')
    expect(document.activeElement).toBe(chip)

    await click(button('Clear filters'))
    await settle()

    expect(admin.listIssueReports).toHaveBeenLastCalledWith({ limit: REPORT_PAGE_SIZE })
    expect(search()).toEqual({ tab: 'reports' })
    expect(findButton('Clear filters')).toBeUndefined()
  })

  it('loads a further page after the rows shown, under the same filter, until none is left', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1'), report('r-2'), report('r-3'), report('r-4', { priority: 'low' })], { pageSize: 2 }),
      '/admin?tab=reports&priority=medium',
    )
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2'])

    await click(button('Load more'))
    await settle()

    expect(admin.listIssueReports)
      .toHaveBeenLastCalledWith({ priority: 'medium', cursor: '2', limit: REPORT_PAGE_SIZE })
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2', 'Report r-3'])
    expect(findButton('Load more')).toBeUndefined()
  })

  it('keeps the rows shown and says why when a further page cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = await renderPanel(fakeAdmin([report('r-1'), report('r-2')], { pageSize: 1 }))
    admin.listIssueReports.mockRejectedValueOnce(new Error('The store is unavailable.'))

    await click(button('Load more'))
    await settle()

    expect(alerts()).toEqual(['The store is unavailable.'])
    expect(rowTitles()).toEqual(['Report r-1'])

    await click(button('Load more'))
    await settle()

    expect(alerts()).toEqual([])
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-2'])
  })

  it('says when the list cannot be loaded, and loads it on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = fakeAdmin([report('r-1')])
    admin.listIssueReports.mockRejectedValueOnce(new Error('unavailable'))
    await renderPanel(admin)

    expect(alerts()).toEqual(['Couldn’t load the issue reports.'])
    expect(listing()).toBeNull()

    await click(button('Retry'))
    await settle()

    expect(alerts()).toEqual([])
    expect(rowTitles()).toEqual(['Report r-1'])
  })

  it('reads the list again on Refresh, which shows a report filed since', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]))
    admin.held.set('r-0', report('r-0'))

    await click(button('Refresh'))
    await settle()

    expect(admin.listIssueReports).toHaveBeenCalledTimes(2)
    expect(rowTitles()).toEqual(['Report r-1', 'Report r-0'])
  })
})

describe('an open report', () => {
  it('opens from its row in place of the list, and returns to the list as it was', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1'), report('r-2')]), '/admin?tab=reports&priority=medium')

    await click(rowLink('r-2'))
    await settle()

    expect(search()).toEqual({ tab: 'reports', priority: 'medium', report: 'r-2' })
    expect(admin.getIssueReport.mock.calls).toEqual([['r-2']])
    expect(listShown()).toBe(false)
    expect(detail()!.textContent).toContain('Report r-2\nIts second line.')
    expect(document.activeElement).toBe(detail())

    const back = [...detail()!.querySelectorAll('a')].find((link) => link.textContent === 'All reports')!
    expect(back.getAttribute('aria-current')).toBeNull()
    await click(back)
    await settle()

    expect(search()).toEqual({ tab: 'reports', priority: 'medium' })
    expect(detail()).toBeNull()
    expect(listShown()).toBe(true)
    // The list was kept, not read again, and the row that was open takes focus.
    expect(admin.listIssueReports).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(rowLink('r-2'))
  })

  it('shows the whole thread, marking an entry for admins alone and one made through the CLI', async () => {
    await renderPanel(fakeAdmin([report('r-1', { status: 'withAdmin', entries: [
      adminEntry('e-1', 'Which browser are you using?'),
      reporterEntry('e-2', 'Firefox.', { status: 'withAdmin' }),
      adminEntry('e-3', 'Looks like the export worker.', { visibility: 'admins', via: 'cli' }),
    ] })]), '/admin?tab=reports&report=r-1')

    expect(thread().map((entry) => entry.querySelector('p')?.textContent))
      .toEqual(['Which browser are you using?', 'Firefox.', 'Looks like the export worker.'])
    const [publicReply, reporterReply, note] = thread()
    expect(publicReply.textContent).toContain('Grace Admin')
    expect(publicReply.textContent).not.toContain('Admins only')
    expect(publicReply.textContent).not.toContain('via the CLI')
    expect(reporterReply.textContent).toContain('Rita Reporter')
    expect(reporterReply.textContent).toContain('Status: With the admins')
    expect(reporterReply.textContent).not.toContain('Admins only')
    expect(note.textContent).toContain('Admins only')
    expect(note.textContent).toContain('via the CLI')
    // Set apart from the entries the reporter reads by more than its label.
    expect(note.className).not.toBe(publicReply.className)
  })

  it('names a status as the admins read it, in the thread and in its select', async () => {
    await renderPanel(fakeAdmin([report('r-1', { status: 'waitingOnReporter', entries: [
      adminEntry('e-1', '', { status: 'waitingOnReporter', at: new Date('2026-10-12T10:05:00Z') }),
    ] })]), '/admin?tab=reports&report=r-1')

    expect(thread()[0].textContent).toBe(
      `Grace Admin set the status to Waiting on the reporter${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`)
    expect(statusSelect().textContent).toBe('Waiting on the reporter')
  })

  it('says when a status was set through the CLI', async () => {
    await renderPanel(fakeAdmin([report('r-1', { status: 'closed', entries: [
      adminEntry('e-1', '', { status: 'investigating', at: new Date('2026-10-12T10:05:00Z') }),
      adminEntry('e-2', '', { status: 'closed', via: 'cli', at: new Date('2026-10-12T10:10:00Z') }),
    ] })]), '/admin?tab=reports&report=r-1')

    expect(thread().map((entry) => entry.textContent)).toEqual([
      `Grace Admin set the status to Investigating${formatFullTimestamp(new Date('2026-10-12T10:05:00Z'))}`,
      `Grace Admin set the status to Closedvia the CLI${formatFullTimestamp(new Date('2026-10-12T10:10:00Z'))}`,
    ])
  })

  it('sets the status, which adds a line naming the admin who set it, and shows it in the list', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1'), report('r-2')]))
    await click(rowLink('r-1'))
    await settle()

    await choose(statusSelect(), 'Investigating')

    expect(admin.setIssueReportStatus.mock.calls).toEqual([['r-1', 'investigating']])
    expect(statusSelect().textContent).toBe('Investigating')
    expect(thread().map((entry) => entry.textContent)).toEqual([
      `Ada Admin set the status to Investigating${formatFullTimestamp(new Date('2026-10-13T08:00:00Z'))}`,
    ])
    expect(document.activeElement).toBe(statusSelect())

    await click([...detail()!.querySelectorAll('a')].find((link) => link.textContent === 'All reports')!)
    await settle()

    // The row shows what the report's last read returned, with no further read of the list.
    expect(admin.listIssueReports).toHaveBeenCalledTimes(1)
    expect(row('r-1').textContent).toContain('Investigating')
    expect(row('r-1').textContent).toContain('Updated')
    expect(row('r-2').textContent).toContain('New')
  })

  it('makes no call for the status the report already has', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    await choose(statusSelect(), 'New')

    expect(admin.setIssueReportStatus).not.toHaveBeenCalled()
  })

  it('says why a status could not be set, and keeps the one the report has', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    admin.setIssueReportStatus.mockRejectedValueOnce(createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound))

    await choose(statusSelect(), 'Closed')

    expect(alerts()).toEqual(['No such issue report.'])
    expect(statusSelect().textContent).toBe('New')
  })

  it('says a report that is not kept could not be loaded', async () => {
    await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=gone')

    expect(alerts()).toEqual(['No such issue report.'])
    expect(detail()!.querySelector('textarea')).toBeNull()
  })

  it('says so when a change was saved and the report could not be read again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    admin.getIssueReport.mockRejectedValueOnce(new Error('The store is unavailable.'))

    await choose(statusSelect(), 'Closed')

    expect(admin.setIssueReportStatus).toHaveBeenCalledTimes(1)
    expect(alerts()).toEqual([
      'Your change was saved, but what is shown here is from before it. The store is unavailable.Read the report again',
    ])

    const again = button('Read the report again')
    again.focus()
    await click(again)
    await settle()

    expect(alerts()).toEqual([])
    expect(statusSelect().textContent).toBe('Closed')
    // The button went with its notice, and the status took focus from it.
    expect(again.isConnected).toBe(false)
    expect(document.activeElement).toBe(statusSelect())
  })

  it('keeps the notice, and focus on its button, while the report still cannot be read again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    admin.getIssueReport.mockRejectedValueOnce(new Error('The store is unavailable.'))
      .mockRejectedValueOnce(new Error('The store is still unavailable.'))
    await choose(statusSelect(), 'Closed')

    const again = button('Read the report again')
    again.focus()
    await click(again)
    await settle()

    expect(alerts()).toEqual([
      'Your change was saved, but what is shown here is from before it. The store is still unavailable.Read the report again',
    ])
    expect(document.activeElement).toBe(again)
  })
})

describe('the composer', () => {
  it('starts as a note for admins alone, and writes one', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    expect(chosenVisibility()).toEqual(['Admins only'])
    expect(consequence()).toBe('Only admins read this note. The reporter never sees it.')
    expect(findButton('Add admins-only note')!.disabled).toBe(true)

    await type(composerField(), '  Looks like the export worker.  ')
    await submit(composerField())
    await settle()

    expect(admin.addIssueReportEntry.mock.calls).toEqual([['r-1', 'Looks like the export worker.', 'admins']])
    expect(thread()).toHaveLength(1)
    expect(thread()[0].textContent).toContain('Ada Admin')
    expect(thread()[0].textContent).toContain('Admins only')
    expect(thread()[0].querySelector('p')?.textContent).toBe('Looks like the export worker.')
    expect(composerField().value).toBe('')
    // The next entry is a note again unless the admin says otherwise.
    expect(chosenVisibility()).toEqual(['Admins only'])
  })

  it('says the reporter will read a public reply, and writes one', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    await chooseVisibility('Public')

    expect(chosenVisibility()).toEqual(['Public'])
    expect(consequence()).toBe('The reporter will read this reply.')
    expect(findButton('Add admins-only note')).toBeUndefined()

    await type(composerField(), 'Which browser are you using?')
    await click(button('Send public reply'))
    await settle()

    expect(admin.addIssueReportEntry.mock.calls).toEqual([['r-1', 'Which browser are you using?', 'public']])
    expect(thread()[0].textContent).not.toContain('Admins only')
    // A reply sent leaves the next entry a note: only a choice made for it makes it public.
    expect(chosenVisibility()).toEqual(['Admins only'])
    expect(consequence()).toBe('Only admins read this note. The reporter never sees it.')
    expect(findButton('Send public reply')).toBeUndefined()
    // It changed no status.
    expect(admin.setIssueReportStatus).not.toHaveBeenCalled()
    expect(statusSelect().textContent).toBe('New')
  })

  it('keeps what was typed and says why when the entry is refused', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    admin.addIssueReportEntry.mockRejectedValueOnce(createIssueReportError(ISSUE_REPORT_ERROR_CODES.threadFull))

    await type(composerField(), 'A note.')
    await submit(composerField())
    await settle()

    expect(alerts()).toEqual(['This issue report\'s thread is full.'])
    expect(composerField().value).toBe('A note.')
    expect(thread()).toHaveLength(0)
  })

  it('says when the admins’ entries of the chosen kind are full, and still takes the other kind', async () => {
    const notes = Array.from({ length: MAX_ISSUE_REPORT_THREAD_ENTRIES }, (_, index) =>
      adminEntry(`note-${index}`, `Note ${index}`, { visibility: 'admins' }))
    // Neither the reporter's replies nor a bare change of status fills the admins' side.
    const others = [
      ...Array.from({ length: MAX_ISSUE_REPORT_THREAD_ENTRIES }, (_, index) => reporterEntry(`reply-${index}`, 'Me too.')),
      adminEntry('status-1', '', { status: 'investigating' }),
    ]
    const admin = await renderPanel(
      fakeAdmin([report('r-1', { status: 'investigating', entries: [...notes, ...others] })]),
      '/admin?tab=reports&report=r-1',
    )

    await type(composerField(), 'One more.')

    expect(detail()!.textContent)
      .toContain(`This thread holds ${MAX_ISSUE_REPORT_THREAD_ENTRIES} admins-only notes, which is as many as it takes.`)
    expect(button('Add admins-only note').disabled).toBe(true)
    await submit(composerField())
    expect(admin.addIssueReportEntry).not.toHaveBeenCalled()

    await chooseVisibility('Public')

    expect(detail()!.textContent).not.toContain('as many as it takes')
    expect(button('Send public reply').disabled).toBe(false)

    // A full thread never refuses a change of status.
    await choose(statusSelect(), 'Closed')
    expect(admin.setIssueReportStatus.mock.calls).toEqual([['r-1', 'closed']])
  })
})

const links = () => [...card('Links').querySelectorAll('a')]
const linkField = () => field('Add a link', HTMLInputElement)

describe('the links', () => {
  it('attaches a link and renders it with the href the server returned, unchanged', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1', { links: ['https://tickets.example.test/42?tab=activity#c7'] })]),
      '/admin?tab=reports&report=r-1',
    )

    await type(linkField(), '  HTTPS://Example.test/pull/7  ')
    await submit(linkField())
    await settle()

    expect(admin.setIssueReportLinks.mock.calls).toEqual([[
      'r-1', ['https://tickets.example.test/42?tab=activity#c7', 'HTTPS://Example.test/pull/7'],
    ]])
    // What the server kept, not what was typed.
    expect(links().map((link) => link.getAttribute('href')))
      .toEqual(['https://tickets.example.test/42?tab=activity#c7', 'https://example.test/pull/7'])
    expect(links().map((link) => link.textContent))
      .toEqual(['https://tickets.example.test/42?tab=activity#c7', 'https://example.test/pull/7'])
    for (const link of links()) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    }
    expect(linkField().value).toBe('')
  })

  it.each([
    'javascript:alert(1)', 'ftp://files.example.test/report', 'example.test/42', 'data:text/html,<p>hi</p>',
  ])('refuses %s without a call', async (typed) => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    await type(linkField(), typed)
    await submit(linkField())

    expect(alerts()).toEqual(['Enter a link that starts with http:// or https://.'])
    expect(admin.setIssueReportLinks).not.toHaveBeenCalled()
    expect(links()).toEqual([])
    expect(linkField().value).toBe(typed)
  })

  it('says why the server refused a link, and keeps what was typed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    admin.setIssueReportLinks.mockRejectedValueOnce(new TypeError('Invalid link.'))

    await type(linkField(), 'https://example.test/42')
    await submit(linkField())
    await settle()

    expect(alerts()).toEqual(['Invalid link.'])
    expect(links()).toEqual([])
    expect(linkField().value).toBe('https://example.test/42')
  })

  it('removes one link, leaving the others in their order', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1', { links: ['https://a.example.test/', 'https://b.example.test/', 'https://c.example.test/'] })]),
      '/admin?tab=reports&report=r-1',
    )

    await click(button('Remove the link https://b.example.test/'))
    await settle()

    expect(admin.setIssueReportLinks.mock.calls).toEqual([['r-1', ['https://a.example.test/', 'https://c.example.test/']]])
    expect(links().map((link) => link.getAttribute('href'))).toEqual(['https://a.example.test/', 'https://c.example.test/'])
  })

  it('takes no further link once the report holds as many as it may', async () => {
    const held = Array.from({ length: MAX_ISSUE_REPORT_LINKS }, (_, index) => `https://example.test/${index}`)
    await renderPanel(fakeAdmin([report('r-1', { links: held })]), '/admin?tab=reports&report=r-1')

    expect(links()).toHaveLength(MAX_ISSUE_REPORT_LINKS)
    expect(card('Links').querySelector('input')).toBeNull()
    expect(card('Links').textContent).toContain(`A report holds at most ${MAX_ISSUE_REPORT_LINKS} links.`)
  })

  // The server keeps http and https links only. One of another kind is never something to press.
  it('shows a stored link that is not a web link as text', async () => {
    await renderPanel(
      fakeAdmin([report('r-1', { links: ['javascript:alert(1)', 'https://example.test/42'] })]),
      '/admin?tab=reports&report=r-1',
    )

    expect(links().map((link) => link.getAttribute('href'))).toEqual(['https://example.test/42'])
    expect(card('Links').textContent).toContain('javascript:alert(1)')
  })
})

describe('the grant given with a report', () => {
  const GRANT_CARD = 'Access given with this report'
  const LAST_REPORTED = 'As the workspace last reported. The workspace decides when you ask for content.'

  it('shows what it covers, the time it has left and that it is the workspace’s last word', async () => {
    const given = grant('workspace')
    await renderPanel(fakeAdmin([report('r-1', { grant: given })]), '/admin?tab=reports&report=r-1')

    expect(card(GRANT_CARD).textContent).toContain('Content: this workspace, 70 hours left')
    expect(card(GRANT_CARD).querySelector('time')?.getAttribute('datetime')).toBe(given.expiresAt.toISOString())
    expect(card(GRANT_CARD).textContent).toContain(LAST_REPORTED)
  })

  it('names an account-wide grant as covering all the reporter’s workspaces', async () => {
    await renderPanel(
      fakeAdmin([report('r-1', { grant: grant('account', { expiresAt: new Date(Date.now() + HOUR + MINUTE) }) })]),
      '/admin?tab=reports&report=r-1',
    )

    expect(card(GRANT_CARD).textContent).toContain('Content: all the reporter’s workspaces, 1 hour left')
    expect(card(GRANT_CARD).textContent).toContain(LAST_REPORTED)
  })

  it('says a grant the reporter ended has ended, and one past its end has expired', async () => {
    const admin = fakeAdmin([
      report('r-1', { grant: grant('workspace', { endedAt: new Date(Date.now() - HOUR) }) }),
      report('r-2', { grant: grant('workspace', { expiresAt: new Date(Date.now() - HOUR) }) }),
    ])
    await renderPanel(admin, '/admin?tab=reports&report=r-1')

    expect(card(GRANT_CARD).textContent).toContain('Content: this workspace, ended')
    expect(card(GRANT_CARD).querySelector('time')).toBeNull()
    expect(card(GRANT_CARD).textContent).toContain(LAST_REPORTED)

    await act(async () => { await router!.navigate({ to: '/admin', search: { tab: 'reports', report: 'r-2' } }) })
    await settle()

    expect(card(GRANT_CARD).textContent).toContain('Content: this workspace, expired')
  })

  it('says when the reporter gave none', async () => {
    await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    expect(card(GRANT_CARD).textContent).toContain('The reporter gave no access to content with this report.')
    expect(card(GRANT_CARD).textContent).not.toContain(LAST_REPORTED)
  })
})

describe('where the reporter was', () => {
  const CONTEXT_CARD = 'Where the reporter was'
  const said = (term: string) => [...card(CONTEXT_CARD).querySelectorAll('dt')]
    .find((dt) => dt.textContent === term)?.nextElementSibling?.textContent ?? null
  const adminView = () => [...card(CONTEXT_CARD).querySelectorAll('a')]
    .find((link) => link.textContent === 'Open the workspace’s admin view')

  it('shows the reporter and the ids they were at, with the way into the workspace’s admin view', async () => {
    await renderPanel(fakeAdmin([report('r-1', {
      context: { workspaceId: 'ws-7', chatId: 12, gadgetId: 3, appVersion: '2026.10.1' },
    })]), '/admin?tab=reports&report=r-1')

    expect(said('Reporter')).toBe('Rita Reporterrita@example.test')
    expect(said('Workspace')).toBe('ws-7')
    expect(said('Chat')).toBe('12')
    expect(said('Gadget')).toBe('3')
    expect(said('App version')).toBe('2026.10.1')
    // The admin page for that workspace starts its reason from the report.
    expect(adminView()?.getAttribute('href')).toBe('/admin/workspace/ws-7?report=r-1')
    // The workspace itself is its owner's to open: the report links to no member page.
    expect([...detail()!.querySelectorAll('a')].map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('/workspace/'))).toEqual([])
  })

  it('offers no admin view for a report filed outside a workspace', async () => {
    await renderPanel(fakeAdmin([report('r-1', { context: {} })]), '/admin?tab=reports&report=r-1')

    expect(said('Workspace')).toBe('None: filed outside a workspace')
    expect(said('Chat')).toBeNull()
    expect(said('Gadget')).toBeNull()
    expect(said('App version')).toBeNull()
    expect(adminView()).toBeUndefined()
  })
})

const shownImages = () => [...detail()!.querySelectorAll('img')]

describe('the images', () => {
  it('reads each image through the admin API, in order and once, and shows it as its declared type', async () => {
    const admin = await renderPanel(
      fakeAdmin([report('r-1', { images: [PNG, WEBP] })]),
      '/admin?tab=reports&report=r-1',
    )
    await settle()

    expect(admin.readIssueReportImage.mock.calls).toEqual([['r-1', 'img-png'], ['r-1', 'img-webp']])
    // The reporter's method answers an admin `notFound` for somebody else's report.
    expect(mocks.authenticatedApi.readIssueReportImage).not.toHaveBeenCalled()
    expect(shownImages().map((image) => image.getAttribute('src'))).toEqual(['blob:test/1', 'blob:test/2'])
    expect(blobs.map((blob) => blob.type)).toEqual(['image/png', 'image/webp'])
    expect(alerts()).toEqual([])
  })

  it('renders no image and reads nothing for a report with none', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')
    await settle()

    expect(shownImages()).toEqual([])
    expect(admin.readIssueReportImage).not.toHaveBeenCalled()
    expect(mocks.authenticatedApi.readIssueReportImage).not.toHaveBeenCalled()
  })

  it('shows an image’s error in its place when its read is refused, and still shows the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = fakeAdmin([report('r-1', { images: [PNG, WEBP] })])
    admin.readIssueReportImage.mockRejectedValueOnce(createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound))
    await renderPanel(admin, '/admin?tab=reports&report=r-1')
    await settle()

    const items = [...detail()!.querySelectorAll('ul[aria-label="Images"] > li')]
    expect(items).toHaveLength(2)
    expect(items[0].querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load image 1 of 2.')
    expect(items[0].querySelector('img')).toBeNull()
    expect(items[1].querySelector('img')?.getAttribute('src')).toBe('blob:test/1')
    expect(blobs.map((blob) => blob.type)).toEqual(['image/webp'])
    expect(admin.readIssueReportImage.mock.calls).toEqual([['r-1', 'img-png'], ['r-1', 'img-webp']])
  })

  it('does not read the images again when the report is read again after a change', async () => {
    const admin = await renderPanel(fakeAdmin([report('r-1', { images: [PNG] })]), '/admin?tab=reports&report=r-1')
    await settle()

    await choose(statusSelect(), 'Investigating')

    expect(admin.getIssueReport).toHaveBeenCalledTimes(2)
    expect(admin.readIssueReportImage).toHaveBeenCalledTimes(1)
  })
})

describe('the retention setting', () => {
  const LABEL = 'Keep issue reports for (days)'
  const retentionField = () => field(LABEL, HTMLInputElement)

  it('shows the retention enforced and the deployment’s minimum, which the field takes no less than', async () => {
    const admin = await renderPanel(fakeAdmin([]), '/admin?tab=reports', { effective: 120, chosen: 120, min: 100 })

    expect(retentionField().value).toBe('120')
    expect(container!.textContent).toContain('kept for 120 days from filing')
    expect(container!.textContent).toContain(
      'This deployment keeps at least 100 days, which its ISSUE_REPORT_RETENTION_MIN_DAYS variable sets.')

    await type(retentionField(), '99')
    await submit(retentionField())

    expect(retentionField().closest('form')!.textContent)
      .toContain(`Enter a whole number of days from 100 to ${MAX_ISSUE_REPORT_RETENTION_DAYS}`)
    expect(admin.setIssueReportRetentionDays).not.toHaveBeenCalled()
  })

  it('saves a retention and re-reads the settings', async () => {
    const admin = await renderPanel(fakeAdmin([]))

    await type(retentionField(), '180')
    await submit(retentionField())
    await settle()

    expect(admin.setIssueReportRetentionDays.mock.calls).toEqual([[180]])
    expect(onSettingsChanged).toHaveBeenCalledTimes(1)
    expect(mocks.addToast).not.toHaveBeenCalled()
  })

  it('reports a retention the server refused, and re-reads nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = await renderPanel(fakeAdmin([]))
    admin.setIssueReportRetentionDays.mockRejectedValueOnce(new Error('Retention must be at least 90 days.'))

    await type(retentionField(), '180')
    await submit(retentionField())
    await settle()

    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
      title: `Couldn’t update “${LABEL}”`, variant: 'error',
    }))
    expect(onSettingsChanged).not.toHaveBeenCalled()
  })

  it('says when the deployment’s minimum holds up a lower retention set here', async () => {
    await renderPanel(fakeAdmin([]), '/admin?tab=reports', { effective: 90, chosen: 30, min: 90 })

    expect(container!.textContent).toContain(
      'The retention set here is 30 days, so this deployment’s minimum of 90 days is what holds it up.')
    expect(container!.textContent).toContain('ISSUE_REPORT_RETENTION_MIN_DAYS, 30 days applies again')
  })

  it('leaves the setting with the list: an open report shows the report alone', async () => {
    await renderPanel(fakeAdmin([report('r-1')]), '/admin?tab=reports&report=r-1')

    expect(retentionField().closest('[hidden]')).not.toBeNull()
    expect(listShown()).toBe(false)
  })
})
