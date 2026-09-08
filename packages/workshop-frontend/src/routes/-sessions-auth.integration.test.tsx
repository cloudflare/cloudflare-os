// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, ConnectedAccountsSubscriber, CodingSessionPiCommand, CodingSessionPiConnection, CodingSessionSummary, RequiredConnectionStatus } from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { AuthProvider, useAuthenticatedApi } from '../AuthContext'
import { SessionsProvider, useSessionsContext } from '../components/sessions/SessionsContext'
import { SessionsPage } from './sessions'
import { RequiredConnectionsGate } from '../RequiredConnectionsGate'

vi.mock('../runtime', () => ({ getWorkshopRuntime: () => ({ kind: 'web', requestNotificationPermission: async () => false }) }))
vi.mock('../FeatureFlagsContext', () => ({ useUiFeatureFlag: () => ({ enabled: true, loading: false }) }))
// Navigation is not under test; the gate itself and all session providers are real.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const session: CodingSessionSummary = {
  id: 'shared-session-id', title: 'Repair', repositories: ['jarvis'], runtime: 'opencode', status: 'running',
  createdAt: new Date(), lastActiveAt: new Date(),
}
const owner = (id = 'alice'): AiChatAuthorInfo => ({ id, name: id, type: 'user' })

function createApi(runtime: CodingSessionSummary['runtime'] = 'opencode') {
  const identity = deferred<AiChatAuthorInfo>()
  const subscribers = new Set<ConnectedAccountsSubscriber>()
  let githubStatus: boolean | 'missing' | undefined
  const publish = (subscriber: ConnectedAccountsSubscriber) => {
    if (githubStatus === undefined) return
    if (githubStatus === 'missing') subscriber.remove(42)
    else subscriber.add(42, { displayName: 'GitHub' } as AccountDescription, { displayName: 'GitHub' } as VendorDescription, [], githubStatus, 'github')
    subscriber.ready()
  }
  const disposals: ReturnType<typeof vi.fn>[] = []
  const api = {
    whoami: vi.fn<() => Promise<AiChatAuthorInfo>>(() => identity.promise),
    amIAdmin: vi.fn<() => Promise<boolean>>(async () => false),
    getRequiredConnectionStatuses: vi.fn<() => Promise<RequiredConnectionStatus[]>>(async () => []),
    subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>(async (subscriber) => {
      subscribers.add(subscriber)
      publish(subscriber)
      const dispose = vi.fn<() => void>(() => { subscribers.delete(subscriber) })
      disposals.push(dispose)
      return { [Symbol.dispose]: dispose }
    }),
    listCodingSessions: vi.fn<() => Promise<CodingSessionSummary[]>>(async () => [{ ...session, runtime }]),
    listCodingSessionActivity: vi.fn<() => Promise<[]>>(async () => []),
    listCodingSessionRepositoryOptions: vi.fn<() => Promise<[]>>(async () => []),
    codingSessionEditorAvailable: vi.fn<() => Promise<boolean>>(async () => false),
    mintCodingSessionEditorCapability: vi.fn<(id: string) => Promise<{ url: string; expiresAt: Date }>>(async (_id) => ({ url: 'https://editor.example/session', expiresAt: new Date(Date.now() + 60_000) })),
    mintCodingSessionOpenCodeCapability: vi.fn<() => Promise<{ url: string; expiresAt: Date }>>(async () => ({ url: `${window.location.origin}/opencode/`, expiresAt: new Date(Date.now() + 60_000) })),
    connectCodingSessionPi: vi.fn<() => Promise<CodingSessionPiConnection>>(async () => ({ mode: 'rpc', runtime: runtime === 'prime-agent' ? 'prime' : 'pi', capabilities: { messages: 'current-context', history: runtime === 'pi' ? 'persisted-entries' : 'unavailable', tree: runtime === 'pi', settlement: runtime === 'pi' ? 'agent_settled' : 'unavailable', messageUpdates: runtime === 'pi' ? 'delta' : 'cumulative' }, version: 1, connectionId: 'handle', expiresAt: new Date(Date.now() + 60_000) })),
    callCodingSessionPi: vi.fn<(id: string, handle: string, command: CodingSessionPiCommand) => Promise<{ json: string }>>(async (_id, _handle, command) => ({ json: JSON.stringify(
      command.type === 'events' ? { cursor: 0, truncated: false, dead: false, events: [], dialogs: [] }
        : command.type === 'get_messages' ? { messages: [] } : command.type === 'get_entries' ? { entries: [] } : command.type === 'get_tree' ? { tree: [] } : { isStreaming: false },
    ) })),
    createCodingSession: vi.fn<() => Promise<CodingSessionSummary>>(async () => ({ ...session, runtime })),
    stopCodingSession: vi.fn<() => Promise<void>>(async () => {}),
    restartCodingSession: vi.fn<() => Promise<CodingSessionSummary>>(async () => session),
    archiveCodingSession: vi.fn<() => Promise<void>>(async () => {}),
    approveCodingSessionAction: vi.fn<() => Promise<void>>(async () => {}),
    rejectCodingSessionAction: vi.fn<() => Promise<void>>(async () => {}),
  }
  return {
    api, identity, disposals,
    async github(valid: boolean | 'missing' = true) {
      await act(async () => {
        githubStatus = valid
        const activeSubscribers = [...subscribers]
        for (const subscriber of activeSubscribers) publish(subscriber)
      })
    },
  }
}

describe('authenticated session workbench transitions', () => {
  let root: Root
  let container: HTMLDivElement
  let context: ReturnType<typeof useSessionsContext>
  let identity: AiChatAuthorInfo | null
  let calls: Array<{ path: string; body?: unknown; signal?: AbortSignal | null }>

  function Probe() {
    context = useSessionsContext()
    identity = useAuthenticatedApi().currentUser
    return null
  }

  async function render(connection: ReturnType<typeof createApi>) {
    await act(async () => root.render(
      <AuthProvider authenticatedApi={connection.api as unknown as ComponentProps<typeof AuthProvider>['authenticatedApi']} onLogout={() => {}}>
        <RequiredConnectionsGate authenticatedApi={connection.api as unknown as ComponentProps<typeof RequiredConnectionsGate>['authenticatedApi']} pathname="/sessions">
          <SessionsProvider loadRepositories>
            <Probe />
            <SessionsPage />
          </SessionsProvider>
        </RequiredConnectionsGate>
      </AuthProvider>,
    ))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal })
      const data = path.endsWith('/session') ? [{ id: 'older', title: 'Older', updatedAt: '2026-01-01' }, { id: 'newer', title: 'Newer', updatedAt: '2026-02-01' }]
        : path.endsWith('/status') ? {} : []
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }))
    class ImageReader {
      result = 'data:image/png;base64,iVBORw0KGgo='
      listener: (() => void) | null = null
      addEventListener(type: string, listener: () => void) { if (type === 'load') this.listener = listener }
      readAsDataURL() { this.listener?.() }
    }
    vi.stubGlobal('FileReader', ImageReader)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function selectSession() {
    await act(async () => context.setActiveId(session.id))
  }

  async function draft() {
    await act(async () => {
      const textarea = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Private draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['png'], 'private.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      const transcript = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
      transcript.value = 'older'
      transcript.dispatchEvent(new Event('change', { bubbles: true }))
      context.setRepositories(['jarvis'])
      context.setTitle('Private title')
    })
  }

  async function assertPaused(api: ReturnType<typeof createApi>['api']) {
    expect(context.github.state).toBe('loading')
    expect(container.textContent).toContain('Checking GitHub connection')
    await assertNoWork(api)
  }

  async function assertNoWork(api: ReturnType<typeof createApi>['api']) {
    const textarea = container.querySelector('textarea')!
    expect(textarea.closest('[style*="display: none"]')).not.toBeNull()
    const count = calls.length
    await act(async () => {
      context.refresh()
      context.refreshActivity()
      await context.create()
      await context.stopSession(session.id)
      await context.restartSession(session.id)
      await context.archiveSession(session.id)
      await context.resolveActivity('action', 'approve')
      await context.resolveActivity('action', 'reject')
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
      editorButton()?.click()
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(calls).toHaveLength(count)
    assertNoSessionCalls(api)
  }

  async function assertRequiredPaused(previous: ReturnType<typeof createApi>['api'], next: ReturnType<typeof createApi>['api']) {
    expect(container.textContent).toContain('Checking required connections')
    const before = Object.values(previous).map((mock) => mock.mock.calls.length)
    await assertNoWork(next)
    // The captured provider context and hidden DOM must not use the old API either.
    expect(Object.values(previous).map((mock) => mock.mock.calls.length)).toEqual(before)
  }

  function assertNoSessionCalls(api: ReturnType<typeof createApi>['api']) {
    for (const name of ['listCodingSessions', 'listCodingSessionActivity', 'listCodingSessionRepositoryOptions', 'codingSessionEditorAvailable', 'mintCodingSessionEditorCapability', 'mintCodingSessionOpenCodeCapability', 'connectCodingSessionPi', 'callCodingSessionPi', 'createCodingSession', 'stopCodingSession', 'restartCodingSession', 'archiveCodingSession', 'approveCodingSessionAction', 'rejectCodingSessionAction'] as const) {
      expect(api[name]).not.toHaveBeenCalled()
    }
  }

  function sessionCallCounts(api: ReturnType<typeof createApi>['api']) {
    return ['listCodingSessions', 'listCodingSessionActivity', 'listCodingSessionRepositoryOptions', 'codingSessionEditorAvailable', 'mintCodingSessionEditorCapability', 'mintCodingSessionOpenCodeCapability', 'connectCodingSessionPi', 'callCodingSessionPi', 'createCodingSession', 'stopCodingSession', 'restartCodingSession', 'archiveCodingSession', 'approveCodingSessionAction', 'rejectCodingSessionAction']
      .map((name) => api[name as keyof typeof api].mock.calls.length)
  }

  function editorButton() {
    return container.querySelector<HTMLButtonElement>('[aria-label="Open browser VS Code"]')!
  }

  function mockPopup() {
    const popup = { opener: null, location: { replace: vi.fn<(url: string) => void>() }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    return popup
  }

  it('blocks editor entry through preserved hidden DOM while identity or GitHub is loading', async () => {
    const first = createApi()
    first.api.codingSessionEditorAvailable.mockResolvedValue(true)
    const popup = mockPopup()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    expect(editorButton().disabled).toBe(false)
    const next = createApi()
    await render(next)
    await act(async () => editorButton().click())
    await act(async () => next.identity.resolve(owner()))
    await act(async () => editorButton().click())
    expect(window.open).not.toHaveBeenCalled()
    expect(popup.location.replace).not.toHaveBeenCalled()
    expect(first.api.mintCodingSessionEditorCapability).not.toHaveBeenCalled()
    assertNoSessionCalls(next.api)
  })

  it.each(['resolve', 'reject'])('discards stale editor %s after hide without clearing a resumed request’s busy state', async (outcome) => {
    const first = createApi()
    first.api.codingSessionEditorAvailable.mockResolvedValue(true)
    const pending = deferred<Awaited<ReturnType<typeof first.api.mintCodingSessionEditorCapability>>>()
    first.api.mintCodingSessionEditorCapability.mockReturnValue(pending.promise)
    const popup = mockPopup()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    await act(async () => editorButton().click())
    expect(first.api.mintCodingSessionEditorCapability).toHaveBeenCalledWith(session.id)
    const next = createApi()
    next.api.codingSessionEditorAvailable.mockResolvedValue(true)
    const resumed = deferred<Awaited<ReturnType<typeof next.api.mintCodingSessionEditorCapability>>>()
    next.api.mintCodingSessionEditorCapability.mockReturnValue(resumed.promise)
    await render(next)
    expect(popup.close).toHaveBeenCalledOnce()
    await assertPaused(next.api)
    await act(async () => next.identity.resolve(owner()))
    await assertPaused(next.api)
    await next.github()
    expect(editorButton().disabled).toBe(false)
    const freshPopup = mockPopup()
    await act(async () => editorButton().click())
    expect(editorButton().disabled).toBe(true)
    await act(async () => {
      if (outcome === 'resolve') pending.resolve({ url: 'https://editor.example/stale', expiresAt: new Date() })
      else pending.reject(new Error('Stale editor failure'))
    })
    expect(popup.location.replace).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Stale editor failure')
    expect(editorButton().disabled).toBe(true)
    await act(async () => resumed.resolve({ url: 'https://editor.example/fresh', expiresAt: new Date() }))
    expect(freshPopup.location.replace).toHaveBeenCalledWith('https://editor.example/fresh')
    expect(editorButton().disabled).toBe(false)
  })

  it.each(['missing', 'expired'] as const)('closes pending editor on confirmed %s and requires setup after same-owner verification', async (state) => {
    const first = createApi()
    first.api.codingSessionEditorAvailable.mockResolvedValue(true)
    const pending = deferred<Awaited<ReturnType<typeof first.api.mintCodingSessionEditorCapability>>>()
    first.api.mintCodingSessionEditorCapability.mockReturnValue(pending.promise)
    const popup = mockPopup()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    await act(async () => editorButton().click())
    await first.github(state === 'missing' ? 'missing' : false)
    expect(context.github.state).toBe(state)
    expect(popup.close).toHaveBeenCalledOnce()
    await act(async () => pending.resolve({ url: 'https://editor.example/stale', expiresAt: new Date() }))
    expect(popup.location.replace).not.toHaveBeenCalled()

    const next = createApi()
    await render(next)
    await next.github(state === 'missing' ? 'missing' : false)
    await act(async () => next.identity.resolve(owner()))
    expect(identity!).toEqual(owner())
    expect(context.github.state).toBe(state)
    expect(container.textContent).toContain('Set up Code')
    expect(container.querySelector('[aria-label="Workbench tools"]')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect([...container.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual([state === 'missing' ? 'Connect GitHub' : 'Reconnect GitHub'])
    const count = calls.length
    await act(async () => {
      context.setActiveId(session.id)
      context.refresh()
      context.refreshActivity()
      await context.create()
      await context.stopSession(session.id)
      await context.restartSession(session.id)
      await context.archiveSession(session.id)
      await context.resolveActivity('action', 'approve')
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(calls).toHaveLength(count)
    assertNoSessionCalls(next.api)
    expect(container.querySelector('[aria-label="Workbench tools"]')).toBeNull()
  })

  it('closes a pending editor when the active session changes', async () => {
    const first = createApi()
    first.api.codingSessionEditorAvailable.mockResolvedValue(true)
    const pending = deferred<Awaited<ReturnType<typeof first.api.mintCodingSessionEditorCapability>>>()
    first.api.mintCodingSessionEditorCapability.mockReturnValue(pending.promise)
    const popup = mockPopup()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    await act(async () => editorButton().click())
    await act(async () => context.setActiveId(undefined))
    expect(popup.close).toHaveBeenCalledOnce()
    await selectSession()
    expect(editorButton().disabled).toBe(false)
    await act(async () => pending.resolve({ url: 'https://editor.example/stale', expiresAt: new Date() }))
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('preserves the Changes surface after a verified same-owner reconnect', async () => {
    const first = createApi()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    const changes = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((button) => button.textContent?.includes('Changes'))!
    await act(async () => changes().click())
    expect(changes().getAttribute('aria-pressed')).toBe('true')
    const next = createApi()
    const required = deferred<RequiredConnectionStatus[]>()
    next.api.getRequiredConnectionStatuses.mockReturnValue(required.promise)
    await render(next)
    await next.github()
    await act(async () => next.identity.resolve(owner()))
    assertNoSessionCalls(next.api)
    expect(container.textContent).toContain('Checking required connections')
    await act(async () => required.resolve([]))
    expect(changes().getAttribute('aria-pressed')).toBe('true')
  })

  it.each(['identity-first', 'github-first'])('preserves real draft, attachments and selection, gates calls, and isolates a changed owner (%s)', async (order) => {
    const first = createApi()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    await draft()
    expect(container.querySelector('textarea')!.value).toBe('Private draft')
    const oldContext = context
    const next = createApi()
    const required = deferred<RequiredConnectionStatus[]>()
    next.api.getRequiredConnectionStatuses.mockReturnValue(required.promise)
    await render(next)
    await assertRequiredPaused(first.api, next.api)
    await act(async () => required.resolve([]))
    expect(identity!).toBeNull()
    expect(first.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(context.activeId).toBe(session.id)
    await assertPaused(next.api)
    if (order === 'identity-first') await act(async () => next.identity.resolve(owner()))
    else await next.github()
    await assertPaused(next.api)
    if (order === 'identity-first') await next.github()
    else await act(async () => next.identity.resolve(owner()))

    expect(identity!).toEqual(owner())
    expect(context.github.state).toBe('connected')
    expect(context.activeId).toBe(session.id)
    expect(context.title).toBe('Private title')
    expect(context.repositories).toEqual(['jarvis'])
    expect(container.querySelector('textarea')!.value).toBe('Private draft')
    expect(container.querySelector('[aria-label="Image attachments"]')!.textContent).toContain('private.png')
    expect(container.querySelector('[aria-label="Image attachments"]')!.textContent).not.toContain('Reading')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!.value).toBe('older')
    expect(next.api.mintCodingSessionOpenCodeCapability).toHaveBeenCalledOnce()
    expect(first.api.whoami).toHaveBeenCalledOnce()
    expect(next.api.whoami).toHaveBeenCalledOnce()
    const previousStops = first.api.stopCodingSession.mock.calls.length
    await act(async () => oldContext.stopSession(session.id))
    expect(first.api.stopCodingSession).toHaveBeenCalledTimes(previousStops)

    const other = createApi()
    await render(other)
    await other.github()
    await assertPaused(other.api)
    await act(async () => other.identity.resolve(owner('bob')))
    await other.github()
    expect(context.activeId).toBeUndefined()
    expect(context.title).toBe('Coordinated code change')
    expect(context.repositories).toEqual([])
    expect(container.textContent).not.toContain('private.png')
    await selectSession() // Deliberately identical session/transcript IDs under another owner.
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(container.querySelector('[aria-label="Image attachments"]')).toBeNull()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!.value).toBe('newer')
    expect(other.api.whoami).toHaveBeenCalledOnce()
  })

  it('keeps identity failures closed and ignores a superseded whoami result', async () => {
    const first = createApi()
    await render(first)
    const failed = createApi()
    await render(failed)
    await failed.github()
    await act(async () => {
      failed.identity.reject(new Error('Unavailable'))
      first.identity.resolve(owner())
    })
    expect(identity!).toBeNull()
    expect(context.github.state).toBe('loading')
    expect(failed.api.listCodingSessions).not.toHaveBeenCalled()
    expect(failed.api.codingSessionEditorAvailable).not.toHaveBeenCalled()
  })

  it.each(['missing', 'error'])('destructively resets a confirmed required-connection %s, even for the same owner and session IDs', async (failure) => {
    const first = createApi()
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    await draft()
    const required = deferred<RequiredConnectionStatus[]>()
    first.api.getRequiredConnectionStatuses.mockReturnValue(required.promise)
    await first.github()
    expect(container.textContent).not.toContain('Checking required connections')
    expect(context.activeId).toBe(session.id)
    expect(context.title).toBe('Private title')
    expect(context.repositories).toEqual(['jarvis'])
    expect(container.querySelector('textarea')!.value).toBe('Private draft')
    expect(container.querySelector('[aria-label="Image attachments"]')!.textContent).toContain('private.png')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!.value).toBe('older')
    await act(async () => {
      if (failure === 'error') required.reject(new Error('offline'))
      else required.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
    })
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('Connect required services to continue')
    const before = sessionCallCounts(first.api)
    const transportCount = calls.length
    await act(async () => {
      context.refresh()
      context.refreshActivity()
      await context.create()
      await context.stopSession(session.id)
      await context.restartSession(session.id)
      await context.archiveSession(session.id)
      await context.resolveActivity('action', 'approve')
      await context.resolveActivity('action', 'reject')
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(sessionCallCounts(first.api)).toEqual(before)
    expect(calls).toHaveLength(transportCount)
    first.api.getRequiredConnectionStatuses.mockResolvedValue([])
    await first.github()
    // Resubscribing the resumed provider sends its own ready snapshot, not a gate refresh.
    expect(first.api.getRequiredConnectionStatuses).toHaveBeenCalledTimes(4)
    expect(context.activeId).toBeUndefined()
    expect(context.title).toBe('Coordinated code change')
    await selectSession()
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(container.querySelector('[aria-label="Image attachments"]')).toBeNull()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!.value).toBe('newer')
  })

  it.each(['pi', 'prime-agent'] as const)('preserves the actual %s draft, stops its polling while checking, and resets it for a new owner', async (runtime) => {
    const first = createApi(runtime)
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await selectSession()
    // Resolve the route's real lazy Pi import before interacting.
    await act(async () => { await import('../components/sessions/PiWorkbench') })
    await act(async () => {
      const textarea = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Private Pi draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const count = first.api.callCodingSessionPi.mock.calls.length
    const next = createApi(runtime)
    const required = deferred<RequiredConnectionStatus[]>()
    next.api.getRequiredConnectionStatuses.mockReturnValue(required.promise)
    await render(next)
    await assertRequiredPaused(first.api, next.api)
    await act(async () => required.resolve([]))
    await assertPaused(next.api)
    await next.github()
    await assertPaused(next.api)
    expect(first.api.callCodingSessionPi).toHaveBeenCalledTimes(count)
    await act(async () => next.identity.resolve(owner()))
    expect(container.querySelector('textarea')!.value).toBe('Private Pi draft')
    expect(next.api.connectCodingSessionPi).toHaveBeenCalledOnce()
    expect(next.api.callCodingSessionPi.mock.calls.some(([, , command]) => command.type === 'prompt')).toBe(false)
    const other = createApi(runtime)
    await render(other)
    await act(async () => other.identity.resolve(owner('bob')))
    await other.github()
    expect(context.activeId).toBeUndefined()
    await selectSession()
    expect(container.querySelector('textarea')!.value).toBe('')
  })

  it('creates an opted-in Prime session through the real provider then attaches and sends only explicitly', async () => {
    const first = createApi('prime-agent')
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await act(async () => {
      context.setRuntime('prime-agent')
      context.setRepositories(['jarvis'])
      context.prepareSession('Prime task', 'Prepared Prime input')
    })
    await act(async () => context.create())
    await act(async () => { await import('../components/sessions/PiWorkbench') })
    expect(first.api.createCodingSession).toHaveBeenCalledWith({ title: 'Prime task', repositories: ['jarvis'], runtime: 'prime-agent', piWorkbench: true })
    expect(first.api.connectCodingSessionPi).toHaveBeenCalledWith(session.id)
    expect(container.querySelector('[aria-label="Prime workbench"]')).not.toBeNull()
    expect(container.querySelector('textarea')!.value).toBe('Prepared Prime input')
    expect(first.api.callCodingSessionPi.mock.calls.some(([, , command]) => command.type === 'prompt')).toBe(false)
    const send = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Send to Prime')!
    await act(async () => send.click())
    expect(first.api.callCodingSessionPi).toHaveBeenCalledWith(session.id, 'handle', { type: 'prompt', message: 'Prepared Prime input' })
    expect(first.api.createCodingSession).toHaveBeenCalledOnce()
  })

  it.each(['alice', 'bob'])('aborts pending transport on hide and only resumes prepared input for its owner (%s)', async (nextOwner) => {
    const first = createApi()
    const pendingStatus = deferred<Response>()
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/status')) {
        signal = init?.signal
        return pendingStatus.promise
      }
      return normalFetch(input, init)
    })
    await render(first)
    await act(async () => first.identity.resolve(owner()))
    await first.github()
    await act(async () => {
      context.prepareSession('Prepared title', 'Queued private input')
      context.setRepositories(['jarvis'])
    })
    await act(async () => context.create())
    expect(context.initialInput).toBe('Queued private input')
    expect(signal?.aborted).toBe(false)
    const next = createApi()
    await render(next)
    expect(signal?.aborted).toBe(true)
    await act(async () => pendingStatus.resolve(new Response('{}')))
    await assertPaused(next.api)
    await next.github()
    await assertPaused(next.api)
    expect(context.initialInput).toBe('Queued private input')
    vi.mocked(fetch).mockImplementation(normalFetch)
    await act(async () => next.identity.resolve(owner(nextOwner)))
    if (nextOwner !== 'alice') {
      await next.github()
    }
    expect(context.activeId).toBe(nextOwner === 'alice' ? session.id : undefined)
    expect(context.initialInput).toBeUndefined()
    expect(context.preparedInput).toBeUndefined()
    await selectSession()
    const writes = calls.filter(({ path }) => path.endsWith('/prompt_async'))
    expect(writes.map(({ body }) => body)).toEqual(nextOwner === 'alice' ? [{ parts: [{ type: 'text', text: 'Queued private input' }] }] : [])
    expect(context.initialInput).toBeUndefined()
  })
})
