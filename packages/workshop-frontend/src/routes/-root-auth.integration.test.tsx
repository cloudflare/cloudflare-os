// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthenticatedApi } from '../AuthContext'
import { useAuth } from '../useAuth'
import { Route } from './__root'

const runtime = vi.hoisted(() => ({
  readSessionSecret: vi.fn<() => Promise<string | null>>(),
  writeSessionSecret: vi.fn(async () => {}),
  clearSessionSecret: vi.fn(async () => {}),
}))
let publicApi: Parameters<typeof useAuth>[0]
vi.mock('../useAuth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../useAuth')>()
  return { ...original, useAuth: vi.fn(original.useAuth) }
})
vi.mock('../RpcContext', () => ({ useRpcStub: () => publicApi, useConnectionLost: () => true }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof import('@tanstack/react-router')>(),
  useRouterState: () => '/sessions',
  Outlet: () => <Probe />,
}))
vi.mock('@cloudflare/kumo', () => ({ TooltipProvider: PassThrough, Toasty: PassThrough }))
vi.mock('../FeatureFlagsContext', () => ({ FeatureFlagsProvider: PassThrough }))
vi.mock('../HubContext', () => ({ HubProvider: PassThrough }))
vi.mock('../ServerConfigContext', () => ({ useEnabledHubs: () => [] }))
vi.mock('../components/AppShell/AppShell', () => ({ default: PassThrough }))
vi.mock('../components/Header', () => ({ default: () => null }))
vi.mock('../components/billing/AccountSelectionModal', () => ({ default: () => null }))
vi.mock('../OnboardingWizard', () => ({ default: () => <div>Onboarding</div> }))
vi.mock('../LoginPage', () => ({ default: () => <div>Login</div> }))
vi.mock('../components/AppLoadingSkeleton', () => ({ AppLoadingSkeleton: ({ label }: { label: string }) => <div role="status">{label}</div> }))
vi.mock('../components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('../hooks/useGitHubConnection', () => ({ useGitHubConnection: () => ({ state: 'loading' }) }))
vi.mock('../runtime', () => ({
  getWorkshopRuntime: () => ({ kind: 'web', ...runtime }),
  addNativeLoginTokenListener: () => () => {},
}))
vi.mock('../errorReporting', () => ({ setReportedUserId: vi.fn() }))

function PassThrough({ children }: { children: ReactNode }) { return children }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let cleanups: ReturnType<typeof vi.fn<() => void>>
function Probe() {
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [draft, setDraft] = useState('fresh')
  useEffect(() => {
    const poll = () => { void authenticatedApi.isOnboardingCompleted() }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { clearInterval(timer); cleanups() }
  }, [authenticatedApi])
  return <div data-probe>
    <button onClick={() => setDraft('saved')}>{draft}</button>
    <button onClick={logout}>Logout</button>
  </div>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function connection(owner = 'alice') {
  const required = deferred<[]>()
  const disposeSubscription = vi.fn()
  let disposed = false
  const afterDisposal = vi.fn()
  function guard() {
    if (disposed) {
      afterDisposal()
      throw new Error('Call on disposed authenticated API')
    }
  }
  const api = {
    whoami: vi.fn(async () => { guard(); return { id: owner, name: owner, type: 'user' as const } }),
    amIAdmin: vi.fn(async () => { guard(); return false }),
    isOnboardingCompleted: vi.fn(async () => { guard(); return true }),
    getFinanceHubStatus: vi.fn(async () => { guard(); return { authorized: false, canCreate: false } }),
    getRequiredConnectionStatuses: vi.fn(() => { guard(); return required.promise }),
    subscribeConnectedAccounts: vi.fn(async () => { guard(); return { [Symbol.dispose]: disposeSubscription } }),
    [Symbol.dispose]: vi.fn(() => { disposed = true }),
  }
  return { api, required, disposeSubscription, afterDisposal, guard }
}

describe('root auth loading boundary (real AuthProvider, required gate and SessionsProvider)', () => {
  let root: Root
  let container: HTMLDivElement
  let auth: ReturnType<typeof useAuth>
  const RootComponent = Route.options.component!

  async function render(patch: Partial<typeof auth>) {
    auth = { ...auth, ...patch }
    vi.mocked(useAuth).mockReturnValue(auth)
    await act(async () => root.render(<RootComponent />))
  }

  async function authenticate(next: ReturnType<typeof connection>) {
    await render({ isLoading: false, isAuthenticated: true, error: null,
      authenticatedApi: next.api as unknown as NonNullable<typeof auth.authenticatedApi> })
    await act(async () => next.required.resolve([]))
  }

  beforeEach(() => {
    vi.mocked(useAuth).mockReset()
    runtime.readSessionSecret.mockReset()
    vi.useFakeTimers()
    cleanups = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    auth = { token: 'token', authenticatedApi: null, isAuthenticated: false, isLoading: true,
      error: null, login: vi.fn(), logout: () => { void render({ token: null, authenticatedApi: null, isAuthenticated: false, isLoading: false }) } }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function saveDraft() {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-probe] button')!.click())
    expect(container.querySelector('[data-probe]')?.textContent).toContain('saved')
  }

  function expectHiddenProbe() {
    const probe = container.querySelector('[data-probe]')
    expect(probe).not.toBeNull()
    expect(probe!.closest('[style*="display: none"]')).not.toBeNull()
  }

  async function renderPublicApi(next: ReturnType<typeof connection>) {
    const authenticate = vi.fn(() => next.api)
    publicApi = { authenticate } as unknown as Parameters<typeof useAuth>[0]
    await act(async () => root.render(<RootComponent />))
    return authenticate
  }

  it.each(['same token', 'empty', 'rejected'] as const)('real useAuth awaits a replacement token read: %s', async (result) => {
    const original = await vi.importActual<typeof import('../useAuth')>('../useAuth')
    vi.mocked(useAuth).mockImplementation(original.useAuth)
    runtime.readSessionSecret.mockResolvedValueOnce('same-token')
    const first = connection()
    first.required.resolve([])
    const firstAuthenticate = await renderPublicApi(first)
    expect(firstAuthenticate).toHaveBeenCalledWith('same-token')
    await saveDraft()

    const read = deferred<string | null>()
    runtime.readSessionSecret.mockReturnValueOnce(read.promise)
    const next = connection()
    const identity = deferred<Awaited<ReturnType<typeof next.api.whoami>>>()
    next.api.whoami.mockImplementation(() => { next.guard(); return identity.promise })
    const cleanupCount = cleanups.mock.calls.length
    const nextAuthenticate = await renderPublicApi(next)
    expect(runtime.readSessionSecret).toHaveBeenCalledTimes(2)
    expect(first.api[Symbol.dispose]).toHaveBeenCalled()
    expect(first.disposeSubscription).toHaveBeenCalled()
    expect(cleanups.mock.calls.length).toBeGreaterThan(cleanupCount)
    expect(container.textContent).toContain('Waiting for server')
    expectHiddenProbe()
    const calls = Object.values(first.api).map((fn) => fn.mock.calls.length)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(nextAuthenticate).not.toHaveBeenCalled()
    expect(Object.values(first.api).map((fn) => fn.mock.calls.length)).toEqual(calls)
    expect(first.afterDisposal).not.toHaveBeenCalled()

    if (result === 'same token') {
      await act(async () => read.resolve('same-token'))
      expect(nextAuthenticate).toHaveBeenCalledWith('same-token')
      expect(next.api.whoami).toHaveBeenCalled()
      expect(container.textContent).toContain('Checking required connections')
      expectHiddenProbe()
      // Identity and required-connection checks are independently pending. Neither is
      // resolved by the token read; keep the real gate closed until its own check finishes.
      await act(async () => identity.resolve({ id: 'alice', name: 'alice', type: 'user' }))
      expectHiddenProbe()
      await act(async () => next.required.resolve([]))
      const probe = container.querySelector('[data-probe]')
      expect(probe).not.toBeNull()
      expect(probe!.closest('[style*="display: none"]')).toBeNull()
      expect(probe!.textContent).toContain('saved')
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(next.api.isOnboardingCompleted.mock.calls.length).toBeGreaterThan(1)
    } else {
      await act(async () => {
        if (result === 'empty') read.resolve(null)
        else read.reject(new Error('Session read failed'))
      })
      expect(container.textContent).toContain(result === 'empty' ? 'Login' : 'Authentication error: Session read failed')
      expect(container.querySelector('[data-probe]')).toBeNull()
      expect(nextAuthenticate).not.toHaveBeenCalled()
      runtime.readSessionSecret.mockResolvedValueOnce('same-token')
      const recovered = connection()
      recovered.required.resolve([])
      await renderPublicApi(recovered)
      expect(container.querySelector('[data-probe]')?.textContent).toContain('fresh')
    }
    expect(Object.values(first.api).map((fn) => fn.mock.calls.length)).toEqual(calls)
    expect(first.afterDisposal).not.toHaveBeenCalled()
  })

  it('holds null-API loading without old calls, then restores same-owner state with only the new API', async () => {
    const first = connection()
    await authenticate(first)
    await saveDraft()
    const cleanupCount = cleanups.mock.calls.length
    await render({ authenticatedApi: null, isAuthenticated: false, isLoading: true })
    expect(container.textContent).toContain('Waiting for server')
    expectHiddenProbe()
    expect(cleanups.mock.calls.length).toBeGreaterThan(cleanupCount)
    expect(first.disposeSubscription).toHaveBeenCalled()
    const calls = Object.values(first.api).map((fn) => fn.mock.calls.length)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(Object.values(first.api).map((fn) => fn.mock.calls.length)).toEqual(calls)

    const next = connection()
    await render({ authenticatedApi: next.api as unknown as NonNullable<typeof auth.authenticatedApi>, isAuthenticated: true, isLoading: false })
    expect(container.textContent).toContain('Checking required connections')
    expectHiddenProbe()
    await act(async () => next.required.resolve([]))
    expect(container.querySelector('[data-probe]')?.textContent).toContain('saved')
    expect(container.querySelector('[data-probe]')?.closest('[style*="display: none"]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(Object.values(first.api).map((fn) => fn.mock.calls.length)).toEqual(calls)
    expect(next.api.isOnboardingCompleted.mock.calls.length).toBeGreaterThan(1)
  })

  it.each(['logout', 'error', 'owner change'] as const)('discards state on %s', async (reason) => {
    await authenticate(connection())
    await saveDraft()
    if (reason === 'logout') {
      await act(async () => auth.logout())
      expect(container.textContent).toContain('Login')
      expect(container.querySelector('[data-probe]')).toBeNull()
    } else {
      await render({ authenticatedApi: null, isAuthenticated: false, isLoading: true })
      if (reason === 'error') {
        await render({ isLoading: false, error: 'Session read failed' })
        expect(container.textContent).toContain('Authentication error: Session read failed')
        expect(container.querySelector('[data-probe]')).toBeNull()
      }
    }
    await authenticate(connection(reason === 'owner change' ? 'bob' : 'alice'))
    expect(container.querySelector('[data-probe]')?.textContent).toContain('fresh')
    expect(container.querySelector('[data-probe]')?.textContent).not.toContain('saved')
  })
})
