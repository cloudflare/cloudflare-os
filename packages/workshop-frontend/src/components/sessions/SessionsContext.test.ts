// @vitest-environment jsdom

import { StrictMode, act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import type { CodingSessionSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  github: { state: 'connected', accountId: 42, label: 'octo@example.com' } as { state: 'connected'; accountId: number; label: string } | { state: 'missing' },
  authenticatedApi: undefined as unknown,
  runtime: {
    kind: 'tauri',
    requestNotificationPermission: vi.fn<() => Promise<boolean>>(async () => true),
    sendNotification: vi.fn<(options: { title: string; body: string }) => Promise<void>>(async () => {}),
  },
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../../hooks/useGitHubConnection', () => ({
  useGitHubConnection: () => testState.github,
}))

vi.mock('../../runtime', () => ({
  getWorkshopRuntime: () => testState.runtime,
}))

import { openGitHubAccountPopup, SessionsProvider, useSessionsContext } from './SessionsContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function session(overrides: Partial<CodingSessionSummary> = {}): CodingSessionSummary {
  return {
    id: 'session-1',
    title: 'Fix Jarvis',
    repositories: ['jarvis'],
    runtime: 'opencode',
    status: 'running',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  }
}

function activity(overrides: Partial<CodingSessionActivity> = {}): CodingSessionActivity {
  return {
    id: 'activity-1',
    sessionId: 'session-1',
    vendorId: 'github',
    resourceTitle: 'Shell',
    type: 'action',
    description: { title: 'Run command', description: 'Needs approval' },
    state: 'pending',
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  }
}

function createApi() {
  return {
    listCodingSessions: vi.fn<() => Promise<CodingSessionSummary[]>>(async () => []),
    listCodingSessionActivity: vi.fn<() => Promise<CodingSessionActivity[]>>(async () => []),
    listCodingSessionRepositoryOptions: vi.fn<(query?: string) => Promise<[]>>(async () => []),
    createCodingSession: vi.fn<(request: unknown) => Promise<CodingSessionSummary>>(async () => session({ status: 'starting' })),
    stopCodingSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    restartCodingSession: vi.fn<(id: string) => Promise<CodingSessionSummary>>(async () => session({ status: 'starting' })),
    archiveCodingSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    approveCodingSessionAction: vi.fn<(id: string) => Promise<void>>(async () => {}),
    rejectCodingSessionAction: vi.fn<(id: string) => Promise<void>>(async () => {}),
    connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
  }
}

type ProviderContext = ReturnType<typeof useSessionsContext>

async function renderProvider({ loadRepositories = false, strictMode = false }: { loadRepositories?: boolean; strictMode?: boolean } = {}) {
  let latestContext: ProviderContext | undefined
  let root: Root | undefined
  const container = document.createElement('div')
  document.body.append(container)

  function Probe() {
    latestContext = useSessionsContext()
    return null
  }

  root = createRoot(container)
  await act(async () => {
    const props: ComponentProps<typeof SessionsProvider> = { loadRepositories, children: createElement(Probe) }
    const tree = createElement(SessionsProvider, props)
    root!.render(strictMode ? createElement(StrictMode, undefined, tree) : tree)
  })
  return {
    get context() {
      if (!latestContext) throw new Error('context not rendered')
      return latestContext
    },
    container,
    async rerender(next: { loadRepositories?: boolean } = {}) {
      await act(async () => {
        const props: ComponentProps<typeof SessionsProvider> = { loadRepositories: next.loadRepositories ?? loadRepositories, children: createElement(Probe) }
        const tree = createElement(SessionsProvider, props)
        root!.render(strictMode ? createElement(StrictMode, undefined, tree) : tree)
      })
    },
    async unmount() {
      await act(async () => root?.unmount())
      container.remove()
    },
  }
}

function fakePopup() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    location: { replace: vi.fn<(url: string) => void>() },
  }
}

describe('openGitHubAccountPopup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    testState.runtime.requestNotificationPermission.mockClear()
    testState.runtime.sendNotification.mockClear()
    vi.clearAllTimers()
    vi.useRealTimers()
    testState.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.authenticatedApi = createApi()
  })

  testState.authenticatedApi = createApi()

  it('opens a popup synchronously and navigates it to the GitHub connect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.connectAccount).toHaveBeenCalledWith('github')

    await promise

    expect(popup.opener).toBeNull()
    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/connect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })

  it('opens a popup synchronously and navigates it to the GitHub reconnect OAuth URL', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    const promise = openGitHubAccountPopup(authenticatedApi, { kind: 'reconnect', accountId: 42 })

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(authenticatedApi.reconnectAccount).toHaveBeenCalledWith(42)

    await promise

    expect(popup.location.replace).toHaveBeenCalledWith('https://github.example.test/oauth/reconnect')
    expect(popup.close).not.toHaveBeenCalled()
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
  })

  it('closes the already-opened popup when the connect RPC fails', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const failure = new Error('GitHub connector is unavailable')
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => { throw failure }),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(failure)

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('rejects with useful copy when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const authenticatedApi = {
      connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/connect' })),
      reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://github.example.test/oauth/reconnect' })),
    }

    await expect(openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })).rejects.toThrow(
      'Allow pop-ups to connect GitHub, then try again.',
    )
    expect(authenticatedApi.connectAccount).not.toHaveBeenCalled()
    expect(authenticatedApi.reconnectAccount).not.toHaveBeenCalled()
  })
})

describe('SessionsProvider responsiveness', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    testState.runtime.requestNotificationPermission.mockClear()
    testState.runtime.sendNotification.mockClear()
    testState.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.authenticatedApi = createApi()
  })

  it('selects a newly created session even while it is starting', async () => {
    const api = createApi()
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())

    expect(api.createCodingSession).toHaveBeenCalledWith({ title: 'Coordinated code change', repositories: ['jarvis'], runtime: 'opencode' })
    expect(rendered.context.activeId).toBe('session-1')
    expect(rendered.context.activeSession?.status).toBe('starting')

    await rendered.unmount()
  })

  it('guards against duplicate create requests before the creating render commits', async () => {
    const api = createApi()
    const pending = deferred<CodingSessionSummary>()
    api.createCodingSession.mockReturnValue(pending.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = rendered.context.create()
      second = rendered.context.create()
      await Promise.resolve()
    })
    expect(api.createCodingSession).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(session({ status: 'starting' })))
    await Promise.all([first, second])

    await rendered.unmount()
  })

  it('carries a prepared Work Item prompt into the newly created terminal once', async () => {
    const api = createApi()
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => {
      rendered.context.prepareSession('Work on AI-3540', 'Read AI-3540 before making changes.')
      rendered.context.setRepositories(['jarvis'])
    })
    expect(rendered.context.preparedInput).toBe('Read AI-3540 before making changes.')
    await act(async () => rendered.context.create())

    expect(api.createCodingSession).toHaveBeenCalledWith({
      title: 'Work on AI-3540',
      repositories: ['jarvis'],
      runtime: 'opencode',
    })
    expect(rendered.context.preparedInput).toBeUndefined()
    expect(rendered.context.initialInput).toBe('Read AI-3540 before making changes.')
    await act(async () => rendered.context.markInitialInputSent('another-session'))
    expect(rendered.context.initialInput).toBe('Read AI-3540 before making changes.')
    await act(async () => rendered.context.markInitialInputSent('session-1'))
    expect(rendered.context.initialInput).toBeUndefined()

    await rendered.unmount()
  })

  it('does not let an older session refresh clear a newer starting session', async () => {
    const api = createApi()
    const initialList = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(initialList.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => initialList.resolve([]))

    expect(rendered.context.activeId).toBe('session-1')
    expect(rendered.context.sessions.map((item) => item.id)).toEqual(['session-1'])

    await rendered.unmount()
  })

  it('ignores a delayed create response after GitHub access is revoked', async () => {
    const api = createApi()
    const createRead = deferred<CodingSessionSummary>()
    api.createCodingSession.mockReturnValueOnce(createRead.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    let createPromise!: Promise<void>
    await act(async () => {
      createPromise = rendered.context.create()
      await Promise.resolve()
    })
    expect(api.createCodingSession).toHaveBeenCalledOnce()

    testState.github = { state: 'missing' }
    await rendered.rerender()
    await act(async () => createRead.resolve(session({ id: 'stale-session', status: 'starting' })))
    await createPromise
    await act(async () => {})

    expect(rendered.context.sessions).toEqual([])
    expect(rendered.context.activeId).toBeUndefined()
    expect(rendered.context.preparedInput).toBeUndefined()

    await rendered.unmount()
  })

  it('polls starting session metadata without overlapping requests', async () => {
    vi.useFakeTimers()
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([])
    const poll = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(poll.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTime(6_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    api.listCodingSessions.mockResolvedValueOnce([session({ status: 'running' })])
    await act(async () => poll.resolve([session({ status: 'starting' })]))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(3)
    await act(async () => {})
    expect(rendered.context.activeSession?.status).toBe('running')

    await rendered.unmount()
  })

  it('polls non-active transitional session metadata without overlapping requests', async () => {
    vi.useFakeTimers()
    const api = createApi()
    const transitionalSession = session({ id: 'session-2', status: 'starting' })
    api.listCodingSessions.mockResolvedValueOnce([transitionalSession])
    const poll = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(poll.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    expect(rendered.context.activeSession).toBeUndefined()
    expect(rendered.context.sessions.find((item) => item.id === 'session-2')?.status).toBe('starting')

    await act(async () => vi.advanceTimersByTime(1_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTime(6_000))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(2)

    api.listCodingSessions.mockResolvedValueOnce([session({ id: 'session-2', status: 'running' })])
    await act(async () => poll.resolve([transitionalSession]))
    expect(api.listCodingSessions).toHaveBeenCalledTimes(3)
    await act(async () => {})
    expect(rendered.context.sessions.find((item) => item.id === 'session-2')?.status).toBe('running')

    await rendered.unmount()
  })

  it('keeps loaded true during background refreshes', async () => {
    vi.useFakeTimers()
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([])
    const poll = deferred<CodingSessionSummary[]>()
    api.listCodingSessions.mockReturnValueOnce(poll.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    expect(rendered.context.loaded).toBe(true)
    await act(async () => rendered.context.setRepositories(['jarvis']))
    await act(async () => rendered.context.create())
    await act(async () => vi.advanceTimersByTime(1_000))

    expect(rendered.context.loaded).toBe(true)

    await rendered.unmount()
  })

  it('does not let stale activity overwrite activity after an action decision', async () => {
    const api = createApi()
    const initialActivity = deferred<CodingSessionActivity[]>()
    api.listCodingSessionActivity.mockReturnValueOnce(initialActivity.promise)
    api.listCodingSessionActivity.mockResolvedValueOnce([])
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.resolveActivity('activity-1', 'approve'))
    await act(async () => initialActivity.resolve([activity()]))
    await act(async () => {})

    expect(api.approveCodingSessionAction).toHaveBeenCalledWith('activity-1')
    expect(rendered.context.activity).toEqual([])

    await rendered.unmount()
  })

  it('coalesces timer and manual activity refreshes without overlapping endpoint reads', async () => {
    vi.useFakeTimers()
    const api = createApi()
    const initialActivity = deferred<CodingSessionActivity[]>()
    api.listCodingSessionActivity.mockReturnValueOnce(initialActivity.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    expect(api.listCodingSessionActivity).toHaveBeenCalledOnce()
    await act(async () => {
      rendered.context.refreshActivity()
      vi.advanceTimersByTime(9_000)
      await Promise.resolve()
    })
    expect(api.listCodingSessionActivity).toHaveBeenCalledOnce()

    api.listCodingSessionActivity.mockResolvedValueOnce([activity({ id: 'activity-2' })])
    await act(async () => initialActivity.resolve([]))
    await act(async () => {})

    expect(api.listCodingSessionActivity).toHaveBeenCalledTimes(2)
    expect(rendered.context.activity.map((item) => item.id)).toEqual(['activity-2'])

    await rendered.unmount()
  })

  it('ignores delayed session and activity reads after GitHub access is revoked', async () => {
    const api = createApi()
    const sessionsRead = deferred<CodingSessionSummary[]>()
    const activityRead = deferred<CodingSessionActivity[]>()
    api.listCodingSessions.mockReturnValueOnce(sessionsRead.promise)
    api.listCodingSessionActivity.mockReturnValueOnce(activityRead.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    testState.github = { state: 'missing' }
    await rendered.rerender()
    expect(rendered.context.github.state).toBe('missing')
    expect(rendered.context.sessions).toEqual([])
    expect(rendered.context.activity).toEqual([])

    await act(async () => {
      sessionsRead.resolve([session()])
      activityRead.resolve([activity()])
    })
    await act(async () => {})

    expect(rendered.context.sessions).toEqual([])
    expect(rendered.context.activity).toEqual([])
    expect(testState.runtime.sendNotification).not.toHaveBeenCalled()

    await rendered.unmount()
  })

  it('clears a pending archive confirmation when GitHub access is revoked', async () => {
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([session()])
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.archiveSession('session-1'))
    expect(document.body.textContent).toContain('Archive session?')

    testState.github = { state: 'missing' }
    await rendered.rerender()

    expect(document.body.textContent).not.toContain('Archive session?')
    expect(api.archiveCodingSession).not.toHaveBeenCalled()

    await rendered.unmount()
  })

  it('does not refresh sessions when a delayed stop resolves after unmount', async () => {
    const api = createApi()
    const stopped = deferred<void>()
    api.listCodingSessions.mockResolvedValueOnce([session()])
    api.stopCodingSession.mockReturnValueOnce(stopped.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    let stopPromise!: Promise<void>
    await act(async () => {
      stopPromise = rendered.context.stopSession('session-1')
      await Promise.resolve()
    })
    expect(api.stopCodingSession).toHaveBeenCalledOnce()

    await rendered.unmount()
    await act(async () => stopped.resolve())
    await stopPromise

    expect(api.listCodingSessions).toHaveBeenCalledOnce()
  })

  it('does not refresh activity when a delayed action decision resolves after unmount', async () => {
    const api = createApi()
    const approved = deferred<void>()
    api.approveCodingSessionAction.mockReturnValueOnce(approved.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    let resolvePromise!: Promise<void>
    await act(async () => {
      resolvePromise = rendered.context.resolveActivity('activity-1', 'approve')
      await Promise.resolve()
    })
    expect(api.approveCodingSessionAction).toHaveBeenCalledOnce()

    await rendered.unmount()
    await act(async () => approved.resolve())
    await resolvePromise

    expect(api.listCodingSessionActivity).toHaveBeenCalledOnce()
  })

  it('ignores queued old activity reads when the authenticated API switches', async () => {
    const oldApi = createApi()
    const oldActivity = deferred<CodingSessionActivity[]>()
    oldApi.listCodingSessionActivity.mockReturnValueOnce(oldActivity.promise)
    testState.authenticatedApi = oldApi
    const rendered = await renderProvider()

    rendered.context.refreshActivity()
    const newApi = createApi()
    newApi.listCodingSessions.mockResolvedValueOnce([])
    newApi.listCodingSessionActivity.mockResolvedValueOnce([activity({ id: 'new-activity' })])
    testState.authenticatedApi = newApi
    await rendered.rerender()
    expect(newApi.listCodingSessionActivity).not.toHaveBeenCalled()
    await act(async () => oldActivity.resolve([activity({ id: 'old-activity' })]))
    await act(async () => {})

    expect(oldApi.listCodingSessionActivity).toHaveBeenCalledOnce()
    expect(newApi.listCodingSessionActivity).toHaveBeenCalledOnce()
    expect(rendered.context.activity.map((item) => item.id)).toEqual(['new-activity'])

    await rendered.unmount()
  })

  it('notifies once when an observed activity becomes pending without bursting initial pending actions', async () => {
    const api = createApi()
    api.listCodingSessionActivity.mockResolvedValueOnce([activity({ id: 'initial-pending' })])
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => {})
    expect(testState.runtime.sendNotification).not.toHaveBeenCalled()

    await act(async () => {
      api.listCodingSessionActivity.mockResolvedValueOnce([
        activity({ id: 'initial-pending' }),
        activity({ id: 'activity-2', description: { title: 'Deploy a very long command '.repeat(20), description: 'not included' } }),
      ])
      rendered.context.refreshActivity()
    })
    await act(async () => {})
    await act(async () => {
      api.listCodingSessionActivity.mockResolvedValueOnce([
        activity({ id: 'initial-pending' }),
        activity({ id: 'activity-2', description: { title: 'Deploy a very long command '.repeat(20), description: 'not included' } }),
      ])
      rendered.context.refreshActivity()
    })
    await act(async () => {})

    expect(testState.runtime.sendNotification).toHaveBeenCalledOnce()
    expect(testState.runtime.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent needs your approval',
      body: expect.stringMatching(/^Deploy a very long command/),
    }))
    expect(testState.runtime.sendNotification.mock.calls[0][0].body.length).toBeLessThanOrEqual(120)

    await rendered.unmount()
  })

  it('requests notification permission when entering Sessions', async () => {
    testState.authenticatedApi = createApi()
    const rendered = await renderProvider({ loadRepositories: true })

    expect(testState.runtime.requestNotificationPermission).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('still starts connected reads when React StrictMode replays effect cleanup and setup', async () => {
    const api = createApi()
    testState.authenticatedApi = api

    const rendered = await renderProvider({ strictMode: true })

    expect(api.listCodingSessions).toHaveBeenCalled()
    expect(api.listCodingSessionActivity).toHaveBeenCalled()
    expect(rendered.context.github.state).toBe('connected')

    await rendered.unmount()
  })

  it('loads repository options only when enabled by the sessions route', async () => {
    vi.useFakeTimers()
    const api = createApi()
    testState.authenticatedApi = api
    const outsideSessions = await renderProvider({ loadRepositories: false })

    await act(async () => vi.advanceTimersByTime(250))
    expect(api.listCodingSessionRepositoryOptions).not.toHaveBeenCalled()
    await outsideSessions.unmount()

    const insideSessions = await renderProvider({ loadRepositories: true })
    await act(async () => vi.advanceTimersByTime(250))

    expect(api.listCodingSessionRepositoryOptions).toHaveBeenCalledOnce()

    await insideSessions.unmount()
  })

  it('opens an archive confirmation and cancels without calling the archive RPC', async () => {
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([session()])
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.archiveSession('session-1'))

    expect(api.archiveCodingSession).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Archive session?')
    expect(document.body.textContent).toContain('Fix Jarvis')
    expect(document.body.textContent).toContain('uncommitted sandbox changes')

    const cancel = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')
    await act(async () => cancel?.click())

    expect(api.archiveCodingSession).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Archive session?')
    await rendered.unmount()
  })

  it('archives once from the confirmation and clears the active session after success', async () => {
    const api = createApi()
    const pending = deferred<void>()
    api.listCodingSessions.mockResolvedValueOnce([session()])
    api.archiveCodingSession.mockReturnValue(pending.promise)
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.setActiveId('session-1'))
    await act(async () => rendered.context.archiveSession('session-1'))
    const archive = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Archive')
    await act(async () => {
      archive?.click()
      archive?.click()
      await Promise.resolve()
    })

    expect(api.archiveCodingSession).toHaveBeenCalledOnce()
    expect(api.archiveCodingSession).toHaveBeenCalledWith('session-1')
    expect(document.body.textContent).toContain('Archiving…')

    await act(async () => pending.resolve())
    await act(async () => {})

    expect(rendered.context.activeId).toBeUndefined()
    expect(document.body.textContent).not.toContain('Archive session?')
    await rendered.unmount()
  })

  it('keeps the archive dialog open and exposes an error when archiving fails', async () => {
    const api = createApi()
    api.listCodingSessions.mockResolvedValueOnce([session()])
    api.archiveCodingSession.mockRejectedValueOnce(new Error('Archive failed'))
    testState.authenticatedApi = api
    const rendered = await renderProvider()

    await act(async () => rendered.context.archiveSession('session-1'))
    const archive = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Archive')
    await act(async () => archive?.click())
    await act(async () => {})

    expect(api.archiveCodingSession).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Archive session?')
    expect(document.body.textContent).toContain('Archive failed')
    expect(rendered.context.activeId).toBeUndefined()
    await rendered.unmount()
  })
})
