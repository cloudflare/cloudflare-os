import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthenticatedApi, CodingSessionRepository, CodingSessionRepositoryOption, CodingSessionRuntime, CodingSessionSummary } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import { useAuthenticatedApi } from '../../AuthContext'
import { useGitHubConnection } from '../../hooks/useGitHubConnection'
import { getWorkshopRuntime } from '../../runtime'
import { accountBrowserFlows } from '../../accountBrowserFlow'
import DeleteConfirmationDialog from '../DeleteConfirmationDialog'

export const CODING_SESSION_PRESETS: Array<{
  id: string
  title: string
  description: string
  repositories: CodingSessionRepository[]
}> = [
  {
    id: 'core',
    title: 'Core',
    description: 'Agentic, integrations, backend, and Zords.',
    repositories: ['agentic', 'unison-integrations', 'leviosa-backend', 'zords'],
  },
  {
    id: 'core-ml',
    title: 'Core + ML Ops',
    description: 'The core stack plus leviosa-ml-ops.',
    repositories: ['agentic', 'unison-integrations', 'leviosa-backend', 'zords', 'leviosa-ml-ops'],
  },
  { id: 'jarvis', title: 'JARVIS', description: 'A focused JARVIS repair session.', repositories: ['jarvis'] },
]

type SessionsContextValue = {
  github: ReturnType<typeof useGitHubConnection>
  sessions: CodingSessionSummary[]
  openSessions: CodingSessionSummary[]
  archivedSessions: CodingSessionSummary[]
  loaded: boolean
  error?: string
  creating: boolean
  title: string
  setTitle: (title: string) => void
  runtime: CodingSessionRuntime
  setRuntime: (runtime: CodingSessionRuntime) => void
  repositories: CodingSessionRepository[]
  setRepositories: (repositories: CodingSessionRepository[]) => void
  repositoryOptions: CodingSessionRepositoryOption[]
  repositorySearch: string
  setRepositorySearch: (query: string) => void
  repositoryLoading: boolean
  availablePresets: typeof CODING_SESSION_PRESETS
  activeId?: string
  setActiveId: (id: string | undefined) => void
  activeSession?: CodingSessionSummary
  activity: CodingSessionActivity[]
  refresh: () => void
  refreshActivity: () => void
  create: () => Promise<void>
  prepareSession: (title: string, initialInput: string) => void
  preparedInput?: string
  clearPreparedSession: () => void
  initialInput?: string
  markInitialInputSent: (sessionId: string) => void
  stopSession: (id: string) => Promise<void>
  restartSession: (id: string) => Promise<void>
  archiveSession: (id: string) => Promise<void>
  resolveActivity: (id: string, decision: 'approve' | 'reject') => Promise<void>
  connect: () => Promise<void>
  reconnect: (accountId: number) => Promise<void>
}

type GitHubAccountConnector = {
  connectAccount: (vendorId: string) => Promise<{ url: string }>
  reconnectAccount: (accountId: number) => Promise<{ url: string }>
}

export async function openGitHubAccountPopup(
  authenticatedApi: GitHubAccountConnector,
  request: { kind: 'connect' } | { kind: 'reconnect'; accountId: number },
): Promise<void> {
  const result = request.kind === 'connect'
    ? await accountBrowserFlows.connect(authenticatedApi as RpcStub<AuthenticatedApi>, 'github', undefined, { webPopup: 'preopen', webPreopenUrl: '', webNavigate: 'replace', webFallback: 'manual', requireWebPopup: true })
    : await accountBrowserFlows.reconnect(authenticatedApi as RpcStub<AuthenticatedApi>, request.accountId, { webPopup: 'preopen', webPreopenUrl: '', webNavigate: 'replace', webFallback: 'manual', requireWebPopup: true })
  if (result.popupBlocked) {
    throw new Error(`Allow pop-ups to ${request.kind === 'connect' ? 'connect' : 'reconnect'} GitHub, then try again.`)
  }
}

const SessionsContext = createContext<SessionsContextValue | null>(null)
const NOTIFICATION_BODY_MAX_LENGTH = 120

export function boundedNotificationBody(value: string, maxLength = NOTIFICATION_BODY_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export function pendingActivityNotificationBody(activity: CodingSessionActivity, sessions: CodingSessionSummary[]): string {
  const sessionTitle = sessions.find((session) => session.id === activity.sessionId)?.title
  const actionTitle = activity.description?.title || activity.resourceTitle || 'Action approval requested'
  return boundedNotificationBody([sessionTitle, actionTitle].filter(Boolean).join(' · '))
}

export function SessionsProvider({ children, loadRepositories = false }: { children: ReactNode; loadRepositories?: boolean }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const github = useGitHubConnection()
  const [sessions, setSessions] = useState<CodingSessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('Coordinated code change')
  const [launchInput, setLaunchInput] = useState<string>()
  const [pendingInitialInput, setPendingInitialInput] = useState<{ sessionId: string; input: string }>()
  const [runtime, setRuntime] = useState<CodingSessionRuntime>('opencode')
  const [repositories, setRepositories] = useState<CodingSessionRepository[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [activity, setActivity] = useState<CodingSessionActivity[]>([])
  const [repositorySearch, setRepositorySearch] = useState('')
  const [repositoryOptions, setRepositoryOptions] = useState<CodingSessionRepositoryOption[]>([])
  const [repositoryLoading, setRepositoryLoading] = useState(false)
  const [archiveRequest, setArchiveRequest] = useState<{ id: string; title: string }>()
  const [archiveSubmitting, setArchiveSubmitting] = useState(false)
  const [archiveError, setArchiveError] = useState<string>()
  const creatingRef = useRef(false)
  const sessionRefreshSequence = useRef(0)
  const sessionRefreshInFlight = useRef(false)
  const sessionRefreshPending = useRef(false)
  const activityRefreshSequence = useRef(0)
  const activityRefreshInFlight = useRef(false)
  const activityRefreshPending = useRef(false)
  const activityStateById = useRef<Map<string, CodingSessionActivity['state']> | undefined>(undefined)
  const notifiedPendingActivityIds = useRef<Set<string>>(new Set())
  const archiveSubmittingRef = useRef(false)
  const latestApiRef = useRef(authenticatedApi)
  const githubConnectedRef = useRef(github.state === 'connected')
  const lifecycleRef = useRef(0)
  const mountedRef = useRef(false)
  latestApiRef.current = authenticatedApi
  githubConnectedRef.current = github.state === 'connected'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleRef.current += 1
    }
  }, [])

  useEffect(() => {
    lifecycleRef.current += 1
    // RPC reads have no abort handle, so queued current-lifecycle reads wait for old reads to settle.
    // Starting replacements would violate the single physical in-flight request invariant.
    sessionRefreshPending.current = false
    activityRefreshPending.current = false
    setArchiveRequest(undefined)
    setArchiveError(undefined)
    if (github.state !== 'connected') {
      setSessions([])
      setLoaded(false)
      setActiveId(undefined)
      setActivity([])
      activityStateById.current = undefined
      notifiedPendingActivityIds.current.clear()
    }
  }, [authenticatedApi, github.state])

  const refresh = useCallback((options?: { background?: boolean }) => {
    void options
    if (!mountedRef.current || !githubConnectedRef.current) return
    if (sessionRefreshInFlight.current) {
      sessionRefreshPending.current = true
      return
    }
    const lifecycle = lifecycleRef.current
    const api = latestApiRef.current
    const requestId = ++sessionRefreshSequence.current
    sessionRefreshInFlight.current = true
    setError(undefined)
    api.listCodingSessions().then((items) => {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current || requestId !== sessionRefreshSequence.current) return
      setSessions(items)
      setLoaded(true)
      setActiveId((current) => items.some((session) => session.id === current && !session.archivedAt) ? current : undefined)
    }).catch((caught: unknown) => {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current || requestId !== sessionRefreshSequence.current) return
      setError(caught instanceof Error ? caught.message : 'Could not load coding sessions.')
      setLoaded(true)
    }).finally(() => {
      sessionRefreshInFlight.current = false
      if (mountedRef.current && githubConnectedRef.current && sessionRefreshPending.current) {
        sessionRefreshPending.current = false
        refresh({ background: true })
      } else {
        sessionRefreshPending.current = false
      }
    })
  }, [])

  const refreshActivity = useCallback(() => {
    if (!mountedRef.current || !githubConnectedRef.current) return
    if (activityRefreshInFlight.current) {
      activityRefreshPending.current = true
      return
    }
    const lifecycle = lifecycleRef.current
    const api = latestApiRef.current
    const requestId = ++activityRefreshSequence.current
    activityRefreshInFlight.current = true
    api.listCodingSessionActivity().then((items) => {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current || requestId !== activityRefreshSequence.current) return
      if (!activityStateById.current) {
        activityStateById.current = new Map(items.map((item) => [item.id, item.state] as const))
        for (const item of items) {
          if (item.state === 'pending') notifiedPendingActivityIds.current.add(item.id)
        }
      }
      setActivity(items)
    }).catch(() => {}).finally(() => {
      activityRefreshInFlight.current = false
      if (mountedRef.current && githubConnectedRef.current && activityRefreshPending.current) {
        activityRefreshPending.current = false
        refreshActivity()
      } else {
        activityRefreshPending.current = false
      }
    })
  }, [])

  useEffect(() => {
    if (github.state !== 'connected') return
    refresh()
    refreshActivity()
  }, [authenticatedApi, github.state, refresh, refreshActivity])

  useEffect(() => {
    if (github.state !== 'connected' || !loadRepositories) return
    const runtime = getWorkshopRuntime()
    if (runtime.kind === 'tauri') void runtime.requestNotificationPermission()
  }, [github.state, loadRepositories])

  useEffect(() => {
    const nextStates = new Map(activity.map((item) => [item.id, item.state] as const))
    if (!activityStateById.current) {
      return
    }
    const previousStates = activityStateById.current
    activityStateById.current = nextStates
    for (const item of activity) {
      if (item.state !== 'pending' || previousStates.get(item.id) === 'pending' || notifiedPendingActivityIds.current.has(item.id)) continue
      notifiedPendingActivityIds.current.add(item.id)
      void getWorkshopRuntime().sendNotification({
        title: 'Agent needs your approval',
        body: pendingActivityNotificationBody(item, sessions),
      })
    }
  }, [activity, sessions])

  useEffect(() => {
    if (github.state !== 'connected') return
    let cancelled = false
    let timer: number | undefined
    const poll = () => {
      if (cancelled) return
      refreshActivity()
      timer = window.setTimeout(poll, 3_000)
    }
    timer = window.setTimeout(poll, 3_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [github.state, refreshActivity])

  const activeSession = sessions.find((session) => session.id === activeId && !session.archivedAt)
  const hasTransitionalOpenSession = sessions.some(
    (session) => !session.archivedAt && (session.status === 'starting' || session.status === 'stopping'),
  )

  useEffect(() => {
    if (github.state !== 'connected') return
    if (!hasTransitionalOpenSession) return
    let cancelled = false
    let timer: number | undefined
    const poll = () => {
      if (cancelled) return
      refresh({ background: true })
      timer = window.setTimeout(poll, 2_000)
    }
    timer = window.setTimeout(poll, 1_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [github.state, hasTransitionalOpenSession, refresh])

  useEffect(() => {
    if (github.state !== 'connected') return
    if (!loadRepositories) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setRepositoryLoading(true)
      authenticatedApi.listCodingSessionRepositoryOptions(repositorySearch).then((options) => {
        if (!cancelled) setRepositoryOptions(options)
      }).catch((caught: unknown) => {
        if (!cancelled) {
          setRepositoryOptions([])
          setError(caught instanceof Error ? caught.message : 'Could not load GitHub repositories.')
        }
      }).finally(() => {
        if (!cancelled) setRepositoryLoading(false)
      })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [authenticatedApi, github.state, loadRepositories, repositorySearch])

  const connect = useCallback(async () => {
    await openGitHubAccountPopup(authenticatedApi, { kind: 'connect' })
  }, [authenticatedApi])

  const reconnect = useCallback(async (accountId: number) => {
    await openGitHubAccountPopup(authenticatedApi, { kind: 'reconnect', accountId })
  }, [authenticatedApi])

  const prepareSession = useCallback((nextTitle: string, initialInput: string) => {
    setTitle(nextTitle)
    setLaunchInput(initialInput)
    setActiveId(undefined)
  }, [])

  const clearPreparedSession = useCallback(() => setLaunchInput(undefined), [])

  const markInitialInputSent = useCallback((sessionId: string) => {
    setPendingInitialInput((current) => current?.sessionId === sessionId ? undefined : current)
  }, [])

  const create = useCallback(async () => {
    if (creatingRef.current || !repositories.length) return
    const api = authenticatedApi
    const lifecycle = lifecycleRef.current
    creatingRef.current = true
    setCreating(true)
    setError(undefined)
    try {
      const session = await api.createCodingSession({ title, repositories, runtime })
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      sessionRefreshSequence.current += 1
      setSessions((current) => [session, ...current])
      if (launchInput) {
        setPendingInitialInput({ sessionId: session.id, input: launchInput })
        setLaunchInput(undefined)
      }
      setActiveId(session.id)
    } catch (caught) {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      setError(caught instanceof Error ? caught.message : 'Could not create coding session.')
    } finally {
      creatingRef.current = false
      if (mountedRef.current) setCreating(false)
    }
  }, [authenticatedApi, launchInput, repositories, runtime, title])

  const stopSession = useCallback(async (id: string) => {
    const api = authenticatedApi
    const lifecycle = lifecycleRef.current
    sessionRefreshSequence.current += 1
    setSessions((current) => current.map((item) => item.id === id ? { ...item, status: 'stopping' } : item))
    await api.stopCodingSession(id)
    if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
    refresh({ background: true })
  }, [authenticatedApi, refresh])

  const restartSession = useCallback(async (id: string) => {
    const api = authenticatedApi
    const lifecycle = lifecycleRef.current
    setError(undefined)
    try {
      const session = await api.restartCodingSession(id)
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      sessionRefreshSequence.current += 1
      setSessions((current) => current.map((item) => item.id === id ? session : item))
      setActiveId(session.id)
    } catch (caught) {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      setError(caught instanceof Error ? caught.message : 'Could not restart coding session.')
    }
  }, [authenticatedApi])

  const archiveSession = useCallback(async (id: string) => {
    const session = sessions.find((item) => item.id === id)
    if (!session || session.archivedAt || archiveSubmitting) return
    setArchiveError(undefined)
    setArchiveRequest({ id, title: session.title })
  }, [archiveSubmitting, sessions])

  const confirmArchiveSession = useCallback(async () => {
    const request = archiveRequest
    if (!request || archiveSubmittingRef.current) return
    const api = authenticatedApi
    const lifecycle = lifecycleRef.current
    archiveSubmittingRef.current = true
    setArchiveSubmitting(true)
    setArchiveError(undefined)
    try {
      await api.archiveCodingSession(request.id)
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      sessionRefreshSequence.current += 1
      setSessions((current) => current.map((item) => item.id === request.id ? { ...item, archivedAt: new Date() } : item))
      setArchiveRequest(undefined)
      if (activeId === request.id) setActiveId(undefined)
      refresh()
    } catch (caught) {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      setArchiveError(caught instanceof Error ? caught.message : 'Could not archive coding session.')
    } finally {
      archiveSubmittingRef.current = false
      if (mountedRef.current) setArchiveSubmitting(false)
    }
  }, [activeId, archiveRequest, authenticatedApi, refresh])

  const resolveActivity = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    const api = authenticatedApi
    const lifecycle = lifecycleRef.current
    setError(undefined)
    try {
      if (decision === 'approve') await api.approveCodingSessionAction(id)
      else await api.rejectCodingSessionAction(id)
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      activityRefreshSequence.current += 1
      refreshActivity()
    } catch (caught) {
      if (api !== latestApiRef.current || lifecycle !== lifecycleRef.current || !githubConnectedRef.current) return
      setError(caught instanceof Error ? caught.message : 'Could not resolve tool action.')
    }
  }, [authenticatedApi, refreshActivity])

  const availableRepositoryNames = new Set(repositoryOptions.map((option) => option.repository))
  const availablePresets = CODING_SESSION_PRESETS.filter((preset) => preset.repositories.every((repo) => availableRepositoryNames.has(repo)))

  const value = useMemo<SessionsContextValue>(() => ({
    github,
    sessions,
    openSessions: sessions.filter((session) => !session.archivedAt),
    archivedSessions: sessions.filter((session) => !!session.archivedAt),
    loaded,
    error,
    creating,
    title,
    setTitle,
    runtime,
    setRuntime,
    repositories,
    setRepositories,
    repositoryOptions,
    repositorySearch,
    setRepositorySearch,
    repositoryLoading,
    availablePresets,
    activeId,
    setActiveId,
    activeSession,
    activity,
    refresh,
    refreshActivity,
    create,
    prepareSession,
    preparedInput: launchInput,
    clearPreparedSession,
    initialInput: pendingInitialInput && pendingInitialInput.sessionId === activeId
      ? pendingInitialInput.input
      : undefined,
    markInitialInputSent,
    stopSession,
    restartSession,
    archiveSession,
    resolveActivity,
    connect,
    reconnect,
  }), [
    activeId, activeSession, activity, archiveSession, availablePresets, connect, create, creating, error,
    clearPreparedSession, github, launchInput, loaded, markInitialInputSent, pendingInitialInput, prepareSession,
    reconnect, refresh, refreshActivity,
    repositories, repositoryLoading, repositoryOptions, repositorySearch, resolveActivity, restartSession,
    runtime, sessions, stopSession, title,
  ])

  return (
    <SessionsContext.Provider value={value}>
      {children}
      <DeleteConfirmationDialog
        open={Boolean(archiveRequest)}
        title="Archive session?"
        description={(
          <div className="space-y-2">
            <p><span className="font-medium text-kumo-default">{archiveRequest?.title ?? 'This session'}</span> will be moved out of your open Code sessions.</p>
            <p>Archiving stops the environment and discards any uncommitted sandbox changes.</p>
            {archiveError && <p role="alert" className="text-kumo-danger">{archiveError}</p>}
          </div>
        )}
        isDeleting={archiveSubmitting}
        confirmLabel="Archive"
        confirmingLabel="Archiving…"
        onOpenChange={(open) => {
          if (!open && !archiveSubmitting) {
            setArchiveRequest(undefined)
            setArchiveError(undefined)
          }
        }}
        onConfirm={() => { void confirmArchiveSession() }}
      />
    </SessionsContext.Provider>
  )
}

export function useSessionsContext(): SessionsContextValue {
  const context = useContext(SessionsContext)
  if (!context) throw new Error('useSessionsContext must be used inside SessionsProvider')
  return context
}
