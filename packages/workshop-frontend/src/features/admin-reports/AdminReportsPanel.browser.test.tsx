/* eslint-disable react/react-in-jsx-scope */

// The admin Reports tab in Chromium, for what jsdom does not model: the keyboard's way through the
// filters, the list and the composer, where focus goes after each change, how the choice of who
// reads an entry is announced, and how the tab lays out at a phone's width. What it shows of each
// report, and the calls it makes, are tested in its jsdom suite.

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
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent, type Locator } from 'vitest/browser'
import type { AdminApi, AdminIssueReport, IssueReportEntry } from '@gadgets/workshop-shared/api'
import '../../styles.css'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))

import { AdminReportsPanel } from './AdminReportsPanel'
import { reportSearchOf } from './reportFilter'

type Opened = AdminIssueReport & { entries: IssueReportEntry[] }

// Longer than a phone is wide, with nowhere to break.
const UNBROKEN = `https://example.test/${'a-very-long-path-segment/'.repeat(8)}`
const FILED = new Date('2026-10-12T09:30:00Z')

const report = (id: string, change: Partial<Opened> = {}): Opened => ({
  id,
  filedAt: FILED,
  updatedAt: FILED,
  reporter: { id: 'rita@example.test', name: 'Rita Reporter' },
  text: `Report ${id}: the export button does nothing when I press it`,
  priority: 'medium',
  context: { workspaceId: 'ws-1' },
  status: 'new',
  images: [],
  links: [],
  entries: [],
  ...change,
})

// The admins' API over reports it holds as the server does, newest first: `pageSize` reports to a
// page (all of them in one when absent).
const fakeAdmin = (reports: Opened[], options: { pageSize?: number } = {}) => {
  const held = new Map(reports.map((opened) => [opened.id, opened]))
  const ada = { id: 'ada@example.test', name: 'Ada Admin' }
  let entries = 0
  const addEntry = (id: string, entry: Pick<IssueReportEntry, 'text' | 'visibility' | 'status'>) => {
    const opened = held.get(id)!
    const added: IssueReportEntry = { id: `added-${++entries}`, at: new Date(), author: ada, via: 'api', ...entry }
    held.set(id, {
      ...opened, status: entry.status ?? opened.status, updatedAt: added.at, entries: [...opened.entries, added],
    })
    return added
  }
  return {
    listIssueReports: vi.fn<AdminApi['listIssueReports']>(async (query = {}) => {
      // A further page answers a few frames later, as a call over the network does: Load more is
      // drawn disabled meanwhile, which is when the browser takes focus from it.
      if (query.cursor !== undefined) await new Promise((resolve) => setTimeout(resolve, 100))
      const matching = [...held.values()].filter((opened) =>
        (query.status === undefined || opened.status === query.status)
        && (query.reporter === undefined || opened.reporter.id === query.reporter))
      const from = Number(query.cursor ?? 0)
      const to = from + (options.pageSize ?? matching.length)
      return {
        reports: matching.slice(from, to).map(({ entries: _entries, ...listed }) => listed),
        ...(to < matching.length ? { nextCursor: String(to) } : {}),
      }
    }),
    getIssueReport: async (id: string) => held.get(id)!,
    addIssueReportEntry: vi.fn<AdminApi['addIssueReportEntry']>(async (id, text, visibility) =>
      addEntry(id, { text, visibility })),
    // Each change answers a few frames later, as a call over the network does.
    setIssueReportStatus: vi.fn<AdminApi['setIssueReportStatus']>(async (id, status) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      addEntry(id, { text: '', visibility: 'public', status })
    }),
    setIssueReportLinks: vi.fn<AdminApi['setIssueReportLinks']>(async (id, links) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      held.set(id, { ...held.get(id)!, links })
    }),
    readIssueReportImage: async () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    setIssueReportRetentionDays: async () => {},
  }
}

let root: Root | undefined
let container: HTMLElement | undefined
let previousViewport: { width: number; height: number } | undefined

afterEach(async () => {
  act(() => root?.unmount())
  container?.remove()
  vi.restoreAllMocks()
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height)
    previousViewport = undefined
  }
})

const viewport = async (width: number, height: number) => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(width, height)
}

const rowLink = (id: string) => page.getByRole('link', { name: new RegExp(`Report ${id}`) })
const listing = () => page.getByRole('region', { name: 'Issue reports', exact: true })
const detail = () => page.getByRole('region', { name: 'Issue report', exact: true })
const statusFilter = () => page.getByRole('search').getByRole('combobox', { name: 'Status' })
const reportStatus = () => detail().getByRole('combobox', { name: 'Status' })
const backLink = () => page.getByRole('link', { name: 'All reports' })

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// Whether the page is no wider than the window, so that nothing scrolls sideways.
const fits = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)

// Presses Tab until `target` has focus.
const tabTo = async (target: Locator) => {
  for (let presses = 0; presses < 40 && document.activeElement !== target.element(); presses++) {
    await input(() => userEvent.tab())
  }
  await expect.element(target).toHaveFocus()
}

// Shows the panel at `url`, under a router that keeps its filters and the open report in the URL
// as the admin page does.
const renderPanel = async (reports: Opened[], url = '/admin?tab=reports', options?: Parameters<typeof fakeAdmin>[1]) => {
  const admin = fakeAdmin(reports, options)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    validateSearch: (search: Record<string, unknown>) => ({ tab: 'reports' as const, ...reportSearchOf(search) }),
    component: function Admin() {
      const navigate = useNavigate()
      const { tab: _tab, report: reportId, ...filter } = adminRoute.useSearch()
      return (
        <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8">
          <AdminReportsPanel
            admin={admin as never}
            retention={{ effective: 90, chosen: 90, min: 90 }}
            onSettingsChanged={async () => {}}
            filter={filter}
            onFilterChange={(next) => void navigate({ to: '/admin', search: { tab: 'reports', ...next }, replace: true })}
            reportId={reportId}
          />
        </div>
      )
    },
  })
  const workspace = createRoute({
    getParentRoute: () => rootRoute, path: '/admin/workspace/$workspaceId', component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([adminRoute, workspace]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
  await expect.element(page.getByRole('heading', { name: /^Issue reports?$/ }).first()).toBeVisible()
  return admin
}

it('goes through the filters, the list and a report by keyboard', async () => {
  await viewport(1280, 900)
  const admin = await renderPanel([
    report('r-1'),
    report('r-2', { status: 'closed' }),
    report('r-3', { reporter: { id: 'omar@example.test', name: 'Omar Other' } }),
  ])

  // The status filter is chosen from its list, and keeps focus once the list closes.
  await tabTo(statusFilter())
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('option', { name: 'New', exact: true })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}{Enter}'))
  await expect.element(statusFilter()).toHaveTextContent('New')
  await expect.element(statusFilter()).toHaveFocus()
  await expect.element(rowLink('r-2')).not.toBeInTheDocument()

  // A row is its link, then its reporter and its workspace, each a button.
  await tabTo(rowLink('r-1'))
  await input(() => userEvent.tab())
  const byReporter = page.getByRole('button', { name: 'Show only Rita Reporter’s reports' })
  await expect.element(byReporter).toHaveFocus()
  await input(() => userEvent.tab())
  await expect.element(page.getByRole('button', { name: 'Show only reports naming workspace ws-1' }).first()).toHaveFocus()

  // Filtering by a reporter moves focus to the chip that shows the choice and removes it.
  await input(() => userEvent.tab({ shift: true }))
  await input(() => userEvent.keyboard('{Enter}'))
  const chip = page.getByRole('button', { name: 'Show every reporter, not only Rita Reporter' })
  await expect.element(chip).toHaveFocus()
  await expect.element(rowLink('r-3')).not.toBeInTheDocument()

  // Enter on a row opens its report, which takes focus in the list's place.
  await tabTo(rowLink('r-1'))
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(detail()).toHaveFocus()
  await expect.element(listing()).not.toBeInTheDocument()

  // The way back keeps the filters, and puts focus on the row that was open.
  await tabTo(backLink())
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(rowLink('r-1')).toHaveFocus()
  await expect.element(chip).toBeVisible()
  expect(admin.listIssueReports)
    .toHaveBeenLastCalledWith({ status: 'new', reporter: 'rita@example.test', limit: 50 })
})

it('announces who will read an entry as the choice is made, and is a note again, with focus in its field, after a reply', async () => {
  await viewport(1280, 900)
  const admin = await renderPanel([report('r-1')], '/admin?tab=reports&report=r-1')
  const choice = page.getByRole('group', { name: 'Who reads this' })
  const adminsOnly = choice.getByRole('radio', { name: 'Admins only' })
  const publicReply = choice.getByRole('radio', { name: 'Public' })
  // A live region, so the consequence of a choice is spoken when it changes.
  const consequence = detail().getByRole('status')

  await expect.element(adminsOnly).toBeChecked()
  await expect.element(consequence).toHaveTextContent('Only admins read this note. The reporter never sees it.')

  // The arrow keys move the choice, as in any radio group.
  await tabTo(adminsOnly)
  await input(() => userEvent.keyboard('{ArrowRight}'))
  await expect.element(publicReply).toBeChecked()
  await expect.element(publicReply).toHaveFocus()
  await expect.element(consequence).toHaveTextContent('The reporter will read this reply.')

  // The field and the button are named after the choice too.
  await input(() => userEvent.tab())
  const field = page.getByRole('textbox', { name: 'Reply to the reporter' })
  await expect.element(field).toHaveFocus()
  const send = page.getByRole('button', { name: 'Send public reply' })
  await expect.element(send).toBeDisabled()
  await input(() => userEvent.keyboard('Which browser are you using?'))
  await input(() => userEvent.tab())
  await expect.element(send).toHaveFocus()
  await input(() => userEvent.keyboard('{Enter}'))

  expect(admin.addIssueReportEntry.mock.calls).toEqual([['r-1', 'Which browser are you using?', 'public']])
  await expect.element(detail().getByRole('list', { name: 'Thread' })).toMatchTextContent('Which browser are you using?')

  // The reply sent, the choice is a note again and says so, and the field, emptied, keeps focus
  // under the name of what it takes.
  await expect.element(adminsOnly).toBeChecked()
  await expect.element(consequence).toHaveTextContent('Only admins read this note. The reporter never sees it.')
  const note = page.getByRole('textbox', { name: 'Note for the admins' })
  await expect.element(note).toHaveValue('')
  await expect.element(note).toHaveFocus()
  await expect.element(page.getByRole('button', { name: 'Add admins-only note' })).toBeDisabled()
})

it('keeps focus on the status select through a change, and gives it to the link field once a link is removed', async () => {
  await viewport(1280, 900)
  const admin = await renderPanel(
    [report('r-1', { links: ['https://example.test/42'] })],
    '/admin?tab=reports&report=r-1',
  )

  await tabTo(reportStatus())
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('option', { name: 'Investigating' })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}{Enter}'))

  await expect.element(reportStatus()).toHaveTextContent('Investigating')
  expect(admin.setIssueReportStatus.mock.calls).toEqual([['r-1', 'investigating']])
  await expect.element(reportStatus()).toHaveFocus()
  await expect.element(detail().getByRole('list', { name: 'Thread' }))
    .toMatchTextContent('Ada Admin set the status to Investigating')

  // The removed link takes its button with it.
  const remove = page.getByRole('button', { name: 'Remove the link https://example.test/42' })
  await tabTo(remove)
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(remove).not.toBeInTheDocument()
  await expect.element(page.getByRole('textbox', { name: 'Add a link' })).toHaveFocus()
})

it('moves focus to the first row a further page adds', async () => {
  await viewport(1280, 900)
  await renderPanel([report('r-1'), report('r-2'), report('r-3')], '/admin?tab=reports', { pageSize: 2 })
  const loadMore = page.getByRole('button', { name: 'Load more' })

  await tabTo(loadMore)
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(rowLink('r-3')).toHaveFocus()
  await expect.element(loadMore).not.toBeInTheDocument()
})

it('fits a phone’s width: the list, then the report in its place, with nothing cut off', async () => {
  await viewport(360, 740)
  await renderPanel([
    report('r-1', {
      context: { workspaceId: `ws-${'0123456789abcdef'.repeat(6)}` },
      links: [UNBROKEN],
      grant: { id: 'grant-1', scope: 'account', expiresAt: new Date(Date.now() + 70 * 3_600_000) },
      entries: [{
        id: 'e-1',
        at: new Date('2026-10-12T10:00:00Z'),
        author: { id: 'grace@example.test', name: 'Grace Admin' },
        visibility: 'admins',
        via: 'cli',
        text: `See ${UNBROKEN}`,
      }],
    }),
    report('r-2'),
  ])
  await expect.element(rowLink('r-1')).toBeVisible()
  // A row keeps to one line of the report and cuts a long workspace id short, inside the page.
  expect(rowLink('r-1').element().getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  const byWorkspace = page.getByRole('button', { name: /^Show only reports naming workspace ws-0123/ })
  expect(byWorkspace.element().getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  fits()

  await input(() => userEvent.click(rowLink('r-1')))

  // The report replaces the list, and takes focus with it.
  await expect.element(detail()).toHaveFocus()
  await expect.element(listing()).not.toBeInTheDocument()
  await expect.element(page.getByRole('textbox', { name: 'Note for the admins' })).toBeVisible()

  // An entry and a link with nowhere to break wrap inside the page.
  const entry = page.getByText(new RegExp(`^See ${UNBROKEN.slice(0, 30)}`)).element()
  const bubble = entry.closest('li')!
  expect(entry.getBoundingClientRect().right).toBeLessThanOrEqual(bubble.getBoundingClientRect().right)
  expect(bubble.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  const link = page.getByRole('link', { name: UNBROKEN }).element()
  expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1)
  fits()

  // The way back to the list, whose row takes focus when it returns.
  await input(() => userEvent.click(backLink()))
  await expect.element(rowLink('r-1')).toHaveFocus()
  await expect.element(detail()).not.toBeInTheDocument()
  fits()
})
