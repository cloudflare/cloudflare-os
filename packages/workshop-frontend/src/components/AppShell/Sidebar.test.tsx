// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The sidebar's My issues item, with the real Sidebar and the real MyIssuesSummary: that the item
// is in the primary navigation, and that it follows the sidebar when it collapses. The sidebar's
// other regions are stood in for.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticatedApi: { getUnseenIssueReportCount: (): Promise<number> => Promise.resolve(0) },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params: _params, children, ...rest }: {
    to: string
    params?: unknown
    children?: ReactNode
  }) => <a href={to} {...rest}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => null,
}))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))
vi.mock('../SiteLogo', () => ({ default: () => null }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../../features/notifications/UnreadSummary', () => ({ UnreadSummary: () => null }))

import Sidebar from './Sidebar'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let container: HTMLDivElement | undefined
let root: Root | undefined

// A session of its own for each test: the count is kept with the session that read it.
const signIn = (count: number) => {
  mocks.authenticatedApi = { getUnseenIssueReportCount: () => Promise.resolve(count) }
}

beforeEach(() => signIn(2))

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
})

const render = async (collapsed: boolean) => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    root!.render(<Sidebar collapsed={collapsed} onToggleCollapsed={() => {}} />)
  })
}

const issueLinks = () => [...container!.querySelectorAll<HTMLAnchorElement>('nav a[href="/issues"]')]

it('lists My issues in the primary navigation with its count beside it', async () => {
  await render(false)

  expect(issueLinks()).toHaveLength(1)
  const [link] = issueLinks()
  expect(link.querySelector('span.truncate')?.textContent).toBe('My issues')
  expect(link.querySelector('[role="img"]')?.textContent).toBe('2')
  expect(link.textContent).toBe('My issues2')
  expect(link.hasAttribute('title')).toBe(false)
})

it('keeps the link when collapsed, named by its title, with no label or count', async () => {
  await render(true)

  expect(issueLinks()).toHaveLength(1)
  const [link] = issueLinks()
  expect(link.getAttribute('title')).toBe('My issues')
  expect(link.textContent).toBe('')
  expect(link.querySelector('[role="img"]')).toBeNull()
})

it('shows the link and no badge for a count of zero', async () => {
  signIn(0)
  await render(false)

  const [link] = issueLinks()
  expect(link.textContent).toBe('My issues')
  expect(link.querySelector('[role="img"]')).toBeNull()
})
