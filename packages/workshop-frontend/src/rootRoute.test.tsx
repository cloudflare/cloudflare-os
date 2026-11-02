// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  pathname: '/',
  isLoading: false,
  // A signed-in tab's stub: the shell would call `isOnboardingCompleted` first, so a popup routed
  // into the shell by mistake shows up as a call here.
  authenticatedApi: null as Record<string, () => Promise<unknown>> | null,
}))

// The root decides standalone-vs-shell from the pathname and the auth state alone; both are faked
// here, and the routed page is a marker so no real screen renders.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: testState.pathname } }),
  Outlet: () => <div data-testid="outlet">routed page</div>,
}))

vi.mock('./useAuth', () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: testState.authenticatedApi !== null,
    authenticatedApi: testState.authenticatedApi,
    isLoading: testState.isLoading,
    error: null,
    login: vi.fn<(token: string) => void>(),
    logout: vi.fn<() => void>(),
  }),
}))

vi.mock('./components/Header', () => ({ default: () => <header data-testid="header">Header</header> }))
vi.mock('./LoginPage', () => ({ default: () => <div data-testid="login">Login</div> }))
// The app chrome is a marker around the routed page, so a test can tell whether a page got it.
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }))

import { Route } from './routes/__root'
import { RpcContext } from './RpcContext'
import { HANDOFF_PATH } from './connectHandoff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RootComponent = Route.options.component as ComponentType

describe('root route standalone rendering', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const stub = {} as RpcStub<PublicApi>

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.pathname = '/'
    testState.isLoading = false
    testState.authenticatedApi = null
  })

  async function renderAt(pathname: string, isLoading = false) {
    testState.pathname = pathname
    testState.isLoading = isLoading
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <RootComponent />
        </RpcContext.Provider>,
      )
    })
    return container
  }

  it('renders the handoff page standalone, without waiting on auth', async () => {
    const page = await renderAt(HANDOFF_PATH, true)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
    expect(page.textContent).not.toContain('Loading')
  })

  it('renders the handoff page standalone for a signed-in popup, never the app shell', async () => {
    // The common case: a connect popup shares the tab's authToken, so it is authenticated. It must
    // still bypass the shell (onboarding gate, account modal, sidebar) and render the page itself.
    const isOnboardingCompleted = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    testState.authenticatedApi = { isOnboardingCompleted }
    const page = await renderAt(HANDOFF_PATH)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
    expect(isOnboardingCompleted).not.toHaveBeenCalled()
  })

  it('renders the handoff page headerless for a signed-out popup too', async () => {
    const page = await renderAt(HANDOFF_PATH)

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
  })

  it('still renders signup headerless', async () => {
    const page = await renderAt('/signup')

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="header"]')).toBeNull()
    expect(page.querySelector('[data-testid="login"]')).toBeNull()
  })

  it('shows the login page for a signed-out visitor elsewhere', async () => {
    const page = await renderAt('/')

    expect(page.querySelector('[data-testid="login"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="outlet"]')).toBeNull()
  })

  it.each([
    ['a workspace at its id', '/workspace/w1', 'fullscreen'],
    // Its route frames what it shows: the editor fullscreen, nothing being there in the chrome.
    ['a workspace’s address in a space', '/spaces/design/roadmap', 'unframed'],
    ['a space’s own page', '/spaces/design', 'in the app chrome'],
    ['the workspaces page', '/workspaces', 'in the app chrome'],
  ])('renders %s (%s) for a signed-in user %s', async (_page, pathname, frame) => {
    testState.authenticatedApi = {
      isOnboardingCompleted: async () => true,
      whoami: async () => ({ type: 'user', id: 'me@example.com', name: 'Me' }),
      amIAdmin: async () => false,
      getUiFeatureFlags: async () => ({}),
    }
    const page = await renderAt(pathname)
    // The shell renders once it knows the user needs no onboarding.
    await act(async () => {})

    const outlet = page.querySelector('[data-testid="outlet"]')!
    expect(outlet).not.toBeNull()
    expect(outlet.closest('[data-testid="app-shell"]') ? 'in the app chrome'
      : outlet.closest('main') ? 'fullscreen' : 'unframed').toBe(frame)
  })
})
