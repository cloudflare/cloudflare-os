// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  github: { state: 'missing' } as
    | { state: 'missing' }
    | { state: 'expired'; accountId: number; label: string }
    | { state: 'connected'; accountId: number; label: string },
  activity: [] as Array<{ state: string }>,
  pathname: '/',
  authenticatedApi: {
    listCodingSessionActivity: vi.fn<() => Promise<never[]>>(async () => []),
    productFeedbackAvailable: vi.fn<() => Promise<boolean>>(async () => true),
    listProductFeedbackStatuses: vi.fn<() => Promise<never[]>>(async () => []),
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to, title, ...props }: { children: ReactNode; to: string; title?: string }) => (
    <a href={to} title={title} {...props}>{children}</a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: testState.pathname } }),
}))

vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }) }))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ themeMode: 'system', resolvedThemeMode: 'light', setThemeMode: vi.fn<(mode: string) => void>() }) }))
vi.mock('../sessions/SessionsContext', () => ({ useSessionsContext: () => ({ github: testState.github, activity: testState.activity }) }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('../UserMenu', () => ({ default: () => <button type="button">User</button> }))
vi.mock('../sessions/SessionsSidebar', () => ({ default: () => <div>Sessions list</div> }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  SidebarWorkspacesTools: () => <div>Workspace tools</div>,
  SidebarWorkspacesLists: () => <div>Workspace lists</div>,
}))

import Sidebar from './Sidebar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Sidebar Code navigation', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    testState.github = { state: 'missing' }
    testState.activity = []
    testState.pathname = '/'
    vi.clearAllMocks()
  })

  async function renderSidebar(collapsed = false) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Sidebar collapsed={collapsed} onToggleCollapsed={() => {}} />))
    return container
  }

  it.each([
    ['missing', { state: 'missing' }],
    ['expired', { state: 'expired', accountId: 42, label: 'octo@example.com' }],
    ['connected', { state: 'connected', accountId: 42, label: 'octo@example.com' }],
  ] as const)('renders Chat and a /sessions Code link when GitHub is %s', async (_label, github) => {
    testState.github = github

    const rendered = await renderSidebar()

    const chatLink = Array.from(rendered.querySelectorAll('a[href="/"]')).find((link) => link.textContent?.includes('Chat'))
    const codeLink = rendered.querySelector('a[href="/sessions"]')
    expect(chatLink?.textContent).toContain('Chat')
    expect(codeLink?.textContent).toContain('Code')
    expect(codeLink?.getAttribute('href')).toBe('/sessions')
  })

  it('keeps feedback permanently visible in both sidebar states', async () => {
    let rendered = await renderSidebar()
    const expandedFeedback = rendered.querySelector('button[aria-label="Share feedback"]')
    expect(expandedFeedback?.textContent).toContain('Help improve Odie')
    expect(expandedFeedback?.className).toContain('w-full')
    expect(expandedFeedback?.className).toContain('bg-kumo-brand')

    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    rendered = await renderSidebar(true)
    expect(rendered.querySelector('button[aria-label="Share feedback"]')).toBeTruthy()
  })

  it.each(['/outputs', '/explore', '/blueprints', '/blueprint/example'])('keeps Library active at %s', async (pathname) => {
    testState.pathname = pathname

    const rendered = await renderSidebar()

    const libraryLink = rendered.querySelector('a[href="/outputs"]')
    expect(libraryLink?.textContent).toContain('Library')
    expect(libraryLink?.className).toContain('bg-kumo-fill')
    expect(libraryLink?.getAttribute('aria-current')).toBe('page')
    expect(rendered.querySelector('a[href="/explore"]')).toBeNull()
  })

  it('uses SessionsProvider activity for Code badges without starting a duplicate activity poll', async () => {
    testState.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.activity = [{ state: 'pending' }, { state: 'approved' }, { state: 'pending' }]

    const rendered = await renderSidebar()

    const codeLink = rendered.querySelector('a[href="/sessions"]')
    expect(codeLink?.textContent).toContain('2')
    expect(testState.authenticatedApi.listCodingSessionActivity).not.toHaveBeenCalled()
  })
})
