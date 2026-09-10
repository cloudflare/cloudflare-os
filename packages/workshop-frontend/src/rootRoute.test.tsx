// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  pathname: '/',
  isLoading: false,
  // A signed-in tab's stub: the shell would call this first, so a popup routed into the shell by
  // mistake shows up as a call here.
  authenticatedApi: null as { isOnboardingCompleted: () => Promise<boolean> } | null,
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
})
