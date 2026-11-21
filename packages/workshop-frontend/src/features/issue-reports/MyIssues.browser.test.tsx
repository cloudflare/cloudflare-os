/* eslint-disable react/react-in-jsx-scope */

// The My issues page in Chromium, for what jsdom does not model: the keyboard's way through the
// list and a thread, where focus goes after a reply, after a grant changes and after a further page
// loads, and how the page lays out at a phone's width. What the page shows of each report and grant, and the calls it
// makes, are tested in its jsdom suite.

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
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent, type Locator } from 'vitest/browser'
import type {
  AdminAccessGrant,
  AuthenticatedApi,
  IssueReportEntry,
  IssueReportGrant,
  Overseer,
  OwnIssueReport,
} from '@gadgets/workshop-shared/api'
import '../../styles.css'

const mocks = vi.hoisted(() => ({ authenticatedApi: {} as unknown }))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ adminContentGrants: true }),
}))

import { MyIssues } from './MyIssues'

type Opened = OwnIssueReport & { entries: IssueReportEntry[] }

// Longer than a phone is wide, with nowhere to break.
const UNBROKEN = `https://example.com/${'a-very-long-path-segment/'.repeat(8)}`

const report = (id: string, change: Partial<Opened> = {}): Opened => ({
  id,
  filedAt: new Date('2026-10-12T09:30:00Z'),
  reporter: { id: 'profile-rita', name: 'Rita Reporter' },
  text: `Report ${id}: the export button does nothing when I press it`,
  priority: 'medium',
  context: { workspaceId: 'ws-1' },
  status: 'waitingOnReporter',
  images: [],
  unseen: false,
  entries: [{
    id: `${id}-e-1`,
    at: new Date('2026-10-12T10:00:00Z'),
    author: { name: 'Grace Admin' },
    visibility: 'public',
    via: 'api',
    text: `Which browser are you using? See ${UNBROKEN}`,
  }],
  ...change,
})

const liveGrant: IssueReportGrant = {
  id: 'grant-1',
  scope: 'workspace',
  expiresAt: new Date(Date.now() + 70 * 3_600_000),
}

// The reporter's API over reports it holds as the server does: `pageSize` reports to a page (all of
// them in one when absent), and the account-wide grant when the account holds one.
const fakeApi = (reports: Opened[], options: { pageSize?: number; account?: AdminAccessGrant } = {}) => {
  const held = new Map(reports.map((opened) => [opened.id, opened]))
  let account = options.account ?? null
  const setGrant = (change: Partial<IssueReportGrant>) => {
    for (const [id, opened] of held) {
      if (opened.grant !== undefined) held.set(id, { ...opened, grant: { ...opened.grant, ...change } })
    }
  }
  return {
    listIssueReports: vi.fn<AuthenticatedApi['listIssueReports']>(async (cursor) => {
      const all = [...held.values()].map(({ entries: _entries, ...listed }) => listed)
      // A further page answers a few frames later, as a call over the network does: Load more is
      // drawn disabled meanwhile, which is when the browser takes focus from it.
      if (cursor !== undefined) await new Promise((resolve) => setTimeout(resolve, 100))
      const from = Number(cursor ?? 0)
      const to = from + (options.pageSize ?? all.length)
      return { reports: all.slice(from, to), ...(to < all.length ? { nextCursor: String(to) } : {}) }
    }),
    getIssueReport: async (id: string) => held.get(id)!,
    markIssueReportSeen: async () => {},
    getUnseenIssueReportCount: async () => 0,
    getAccountAdminGrant: async () => account,
    revokeAccountAdminAccess: async () => {
      if (account !== null) account = { ...account, revokedAt: new Date() }
    },
    replyToIssueReport: vi.fn<AuthenticatedApi['replyToIssueReport']>(async (id, text) => ({
      id: `${id}-reply`,
      at: new Date(),
      author: { id: 'profile-rita', name: 'Rita Reporter' },
      visibility: 'public',
      text,
      status: 'withAdmin',
    })),
    // The promise of a workspace, as the page holds it: it calls a grant method and disposes it.
    openWorkspace: () => ({
      renewAdminAccess: async () => { setGrant({ expiresAt: new Date(Date.now() + 72 * 3_600_000) }) },
      revokeAdminAccess: (async () => { setGrant({ endedAt: new Date() }) }) satisfies Overseer['revokeAdminAccess'],
      [Symbol.dispose]: () => {},
    }),
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
const listing = () => page.getByRole('region', { name: 'Your issue reports' })
const detail = () => page.getByRole('region', { name: 'Issue report', exact: true })
const replyField = () => page.getByRole('textbox', { name: 'Reply to the admins' })
const sendButton = () => page.getByRole('button', { name: 'Send reply' })

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// Presses Tab until `target` has focus.
const tabTo = async (target: Locator) => {
  for (let presses = 0; presses < 30 && document.activeElement !== target.element(); presses++) {
    await input(() => userEvent.tab())
  }
  await expect.element(target).toHaveFocus()
}

// Shows the page at `url`, under a router that reads `report` from the URL as the route does.
const renderPage = async (reports: Opened[], url = '/issues', options?: Parameters<typeof fakeApi>[1]) => {
  const api = fakeApi(reports, options)
  mocks.authenticatedApi = api
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([issues, workspace]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
  await expect.element(page.getByRole('heading', { name: 'My issues' })).toBeVisible()
  return api
}

it('goes through the list and a thread by keyboard, and keeps focus in the reply field after a reply', async () => {
  await viewport(1280, 800)
  const api = await renderPage([report('r-1'), report('r-2')])

  await tabTo(rowLink('r-1'))
  await input(() => userEvent.tab())
  await expect.element(rowLink('r-2')).toHaveFocus()
  await input(() => userEvent.tab({ shift: true }))
  await expect.element(rowLink('r-1')).toHaveFocus()

  // Enter opens the report, and its thread takes focus: the list stays beside it.
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(detail()).toHaveFocus()
  await expect.element(rowLink('r-2')).toBeVisible()
  await expect.element(rowLink('r-1')).toHaveAttribute('aria-current', 'page')

  await tabTo(replyField())
  await expect.element(sendButton()).toBeDisabled()
  await input(() => userEvent.keyboard('Firefox, the latest.'))
  await input(() => userEvent.tab())
  await expect.element(sendButton()).toHaveFocus()
  await input(() => userEvent.keyboard('{Enter}'))

  expect(api.replyToIssueReport.mock.calls).toEqual([['r-1', 'Firefox, the latest.']])
  await expect.element(detail()).toMatchTextContent('Status: With the admins')
  await expect.element(replyField()).toHaveValue('')
  await expect.element(replyField()).toHaveFocus()
})

it('keeps focus on Renew, and moves it to what became of the grant when End access removes the button', async () => {
  await viewport(1280, 800)
  await renderPage([report('r-1', { grant: liveGrant })], '/issues?report=r-1')
  const renew = page.getByRole('button', { name: 'Renew' })
  const endAccess = page.getByRole('button', { name: 'End access' })

  await tabTo(renew)
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(renew).toHaveFocus()

  await tabTo(endAccess)
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(endAccess).not.toBeInTheDocument()
  const became = page.getByText(/This workspace\. Ended/)
  await expect.element(became).toHaveFocus()
})

it('moves focus to the first row a further page adds, and back to Load more when none could be loaded', async () => {
  await viewport(1280, 800)
  const api = await renderPage([report('r-1'), report('r-2'), report('r-3'), report('r-4')], '/issues', { pageSize: 1 })
  const loadMore = page.getByRole('button', { name: 'Load more' })

  // Another page remains: the button stays, and focus is on the row that was added.
  await tabTo(loadMore)
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(rowLink('r-2')).toHaveFocus()
  await expect.element(loadMore).toBeEnabled()

  // The page could not be loaded: focus is back on the button, for another try. The failure
  // answers as late as a page does, so the button is drawn disabled and loses focus meanwhile.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.listIssueReports.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('The store is unavailable.')), 100)
  }))
  await tabTo(loadMore)
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('alert')).toHaveTextContent('The store is unavailable.')
  await expect.element(loadMore).toHaveFocus()

  // The last page takes the button with it.
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(rowLink('r-3')).toHaveFocus()
  await tabTo(loadMore)
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(rowLink('r-4')).toHaveFocus()
  await expect.element(loadMore).not.toBeInTheDocument()
})

it('moves focus to the page’s heading when End access takes the account-wide grant’s card away', async () => {
  await viewport(1280, 800)
  await renderPage([report('r-1')], '/issues', { account: {
    id: 'grant-account',
    level: 'content',
    source: 'owner',
    scope: 'account',
    grantedBy: { id: 'profile-rita', name: 'Rita Reporter' },
    grantedAt: new Date(Date.now() - 3_600_000),
    expiresAt: new Date(Date.now() + 70 * 3_600_000),
  } })
  const endAccess = page.getByRole('button', { name: 'End access' })

  await tabTo(endAccess)
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(endAccess).not.toBeInTheDocument()
  await expect.element(page.getByRole('heading', { name: 'My issues' })).toHaveFocus()
  // The list is what follows the heading.
  await input(() => userEvent.tab())
  await expect.element(rowLink('r-1')).toHaveFocus()
})

it('shows the list alone at a phone’s width, then the report alone, with nothing cut off', async () => {
  await viewport(360, 740)
  await renderPage([report('r-1'), report('r-2')])
  await expect.element(rowLink('r-1')).toBeVisible()
  // A row keeps to one line of the report, cut short inside the page.
  expect(rowLink('r-1').element().getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)

  await input(() => userEvent.click(rowLink('r-1')))

  // The report replaces the list, and takes focus with it.
  await expect.element(detail()).toHaveFocus()
  await expect.element(listing()).not.toBeInTheDocument()
  expect(rowLink('r-1').query()?.checkVisibility() ?? false).toBe(false)
  await expect.element(replyField()).toBeVisible()

  // An entry with nowhere to break wraps inside its bubble and the page.
  const entry = page.getByText(/Which browser are you using\?/).element()
  const bubble = entry.closest('li')!
  expect(entry.getBoundingClientRect().right).toBeLessThanOrEqual(bubble.getBoundingClientRect().right)
  expect(bubble.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  expect(entry.scrollWidth).toBeLessThanOrEqual(entry.clientWidth + 1)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)

  // The way back to the list, which takes focus when it returns.
  await input(() => userEvent.click(page.getByRole('link', { name: 'All issues' })))
  await expect.element(listing()).toHaveFocus()
  await expect.element(rowLink('r-2')).toBeVisible()
  await expect.element(detail()).not.toBeInTheDocument()
})

it('hides the way back to the list where the list is beside the report', async () => {
  await viewport(1280, 800)
  await renderPage([report('r-1')], '/issues?report=r-1')
  await expect.element(replyField()).toBeVisible()

  await expect.element(page.getByRole('link', { name: 'All issues' })).not.toBeInTheDocument()
  const list = listing().element().getBoundingClientRect()
  expect(list.right).toBeLessThanOrEqual(detail().element().getBoundingClientRect().left)
})
