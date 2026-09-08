import { Activity, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowClockwise, ArrowSquareOut, CheckCircle, Plugs, WarningCircle } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, RequiredConnectionStatus } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter } from './accountsSubscriber'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { WorkshopButton } from './components/WorkshopControls'
import { logRpcFailure } from './rpcErrors'
import { accountBrowserFlows } from './accountBrowserFlow'
import { AppLoadingSkeleton } from './components/AppLoadingSkeleton'

type RequiredConnectionsGateProps = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  pathname: string
  children: React.ReactNode
}

const ESCAPE_ROUTE_PREFIXES = [
  '/gatekeepers',
  '/admin',
  '/getting-started',
  '/workspaces',
  '/outputs',
  '/profile/providers',
  '/providers',
]

export function isRequiredConnectionsEscapeRoute(pathname: string): boolean {
  return ESCAPE_ROUTE_PREFIXES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

export function RequiredConnectionsGate({ authenticatedApi, pathname, children }: RequiredConnectionsGateProps) {
  const escapeRoute = isRequiredConnectionsEscapeRoute(pathname)
  const scope = useMemo(() => ({ authenticatedApi, escapeRoute }), [authenticatedApi, escapeRoute])
  const [result, setResult] = useState<{ scope: typeof scope; statuses: RequiredConnectionStatus[] | null; loadError?: string }>()
  // An old API's healthy result must never reveal children on the replacement's first render.
  const statuses = result?.scope === scope ? result.statuses : null
  const loadError = result?.scope === scope ? result.loadError : undefined
  const [checking, setChecking] = useState(false)
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    setChecking(true)
    try {
      const next = await authenticatedApi.getRequiredConnectionStatuses()
      if (generation !== refreshGeneration.current) return
      setResult({ scope, statuses: next })
    } catch (error) {
      logRpcFailure('Failed to check required gatekeeper connections:', error)
      if (generation !== refreshGeneration.current) return
      setResult({ scope, statuses: null, loadError: 'We could not check required connections. Try again in a moment.' })
    } finally {
      if (generation === refreshGeneration.current) setChecking(false)
    }
  }, [authenticatedApi, scope])

  useEffect(() => {
    if (escapeRoute) return
    void refresh()
    return () => { refreshGeneration.current += 1 }
  }, [escapeRoute, refresh])

  useEffect(() => {
    if (escapeRoute) return
    let cancelled = false
    let refreshScheduled = false
    let subscription: { [Symbol.dispose](): void } | null = null
    const scheduleRefresh = () => {
      if (cancelled || refreshScheduled) return
      refreshScheduled = true
      queueMicrotask(() => {
        refreshScheduled = false
        if (!cancelled) void refresh()
      })
    }
    const invalidateAndScheduleRefresh = () => {
      refreshGeneration.current += 1
      setResult({ scope, statuses: null })
      scheduleRefresh()
    }
    const subscriber = new AccountsSubscriberAdapter({
      add: (event) => {
        if (event.credentialsValid) scheduleRefresh()
        else invalidateAndScheduleRefresh()
      },
      remove: invalidateAndScheduleRefresh,
      ready: scheduleRefresh,
    })

    authenticatedApi.subscribeConnectedAccounts(subscriber, { includeForcedAutoProvisionedAccounts: true })
      .then((stub) => {
        if (cancelled) stub[Symbol.dispose]()
        else subscription = stub
      })
      .catch((error) => {
        logRpcFailure('Failed to subscribe for required connection refreshes:', error)
      })

    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
    }
  }, [authenticatedApi, escapeRoute, refresh])

  const unhealthy = useMemo(
    () => (statuses ?? []).filter((status) => status.state !== 'healthy'),
    [statuses],
  )

  const initialPending = statuses === null && !loadError
  const healthyRecheck = checking && statuses !== null && unhealthy.length === 0
  const pending = initialPending || (checking && !healthyRecheck)
  if (escapeRoute || pending || (statuses !== null && unhealthy.length === 0)) {
    return (
      <>
        {/* Keep this boundary stable; confirmed failures below deliberately discard the subtree.
            Home's healthy background rechecks must not hide it: React Activity tears down effects
            while hidden, interrupting the focused first-message composer during live updates. */}
        <Activity mode={!escapeRoute && pending ? 'hidden' : 'visible'}>{children}</Activity>
        {!escapeRoute && pending && <AppLoadingSkeleton label="Checking required connections" />}
      </>
    )
  }

  return (
    <RequiredConnectionsScreen
      authenticatedApi={authenticatedApi}
      checking={checking}
      loadError={loadError}
      requiredConnections={unhealthy}
      onRecheck={refresh}
    />
  )
}

function RequiredConnectionsScreen({
  authenticatedApi,
  checking,
  loadError,
  requiredConnections,
  onRecheck,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  checking: boolean
  loadError?: string
  requiredConnections: RequiredConnectionStatus[]
  onRecheck: () => Promise<void>
}) {
  return (
    <main className="min-h-screen bg-kumo-tint/30 px-4 py-10 text-kumo-default sm:px-6" aria-labelledby="required-connections-title">
      <section className="mx-auto w-full max-w-3xl overflow-hidden rounded-3xl border border-kumo-line bg-kumo-base shadow-sm">
        <div className="border-b border-kumo-line bg-kumo-elevated px-6 py-6 sm:px-8">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-kumo-fill text-kumo-brand" aria-hidden="true">
              <Plugs size={24} weight="bold" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.55px] text-kumo-subtle">Setup required</p>
              <h1 id="required-connections-title" className="mt-1 text-2xl font-semibold tracking-tight text-kumo-default sm:text-3xl">
                Connect required services to continue
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-kumo-subtle">
                Chat, workspaces, and Code sessions are paused until these required connections are healthy. You can still open connectors, admin, outputs, profile providers, and getting started pages to recover access.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-6 sm:px-8">
          {loadError && (
            <div className="rounded-xl border border-kumo-danger/25 bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger" role="alert">
              {loadError}
            </div>
          )}

          <div className="space-y-3">
            {requiredConnections.map((connection) => (
              <RequiredConnectionCard key={`${connection.vendorId}:${connection.accountId ?? 'missing'}`} authenticatedApi={authenticatedApi} connection={connection} onRecheck={onRecheck} />
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-kumo-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-wrap gap-2 text-sm" aria-label="Recovery pages">
              <Link to="/gatekeepers" className="rounded-lg border border-kumo-line px-3 py-2 font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Connectors</Link>
              <Link to="/getting-started" className="rounded-lg border border-kumo-line px-3 py-2 font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Getting started</Link>
              <Link to="/providers" className="rounded-lg border border-kumo-line px-3 py-2 font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Profile providers</Link>
            </nav>
            <WorkshopButton onClick={() => void onRecheck()} disabled={checking}>
              <ArrowClockwise size={14} /> {checking ? 'Checking…' : 'Recheck'}
            </WorkshopButton>
          </div>
        </div>
      </section>
    </main>
  )
}

function RequiredConnectionCard({
  authenticatedApi,
  connection,
  onRecheck,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  connection: RequiredConnectionStatus
  onRecheck: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [manualUrl, setManualUrl] = useState<string>()
  const [popupBlocked, setPopupBlocked] = useState(false)
  const expired = connection.state === 'expired'
  const unavailable = connection.state === 'unavailable'

  const actionLabel = expired ? `Reconnect ${connection.displayName}` : `Connect ${connection.displayName}`

  const startConnection = async () => {
    if (unavailable) return
    setBusy(true)
    setActionError(undefined)
    setPopupBlocked(false)
    try {
      const result = expired && connection.accountId !== undefined
        ? await accountBrowserFlows.reconnect(authenticatedApi, connection.accountId, { webPopup: 'preopen', webFallback: 'manual' })
        : await accountBrowserFlows.connect(authenticatedApi, connection.vendorId, undefined, { webPopup: 'preopen', webFallback: 'manual' })
      setManualUrl(result.url)
      if (result.popupBlocked) setPopupBlocked(true)
    } catch (error) {
      logRpcFailure(`Could not start required ${expired ? 'reconnect' : 'connect'} flow:`, error)
      setActionError(`Could not start ${expired ? 'reconnect' : 'connect'} flow. Try again in a moment.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="rounded-2xl border border-kumo-line bg-kumo-base p-4" aria-labelledby={`required-${connection.vendorId}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <GatekeeperIcon vendorId={connection.vendorId} fallbackText={connection.displayName} className="h-11 w-11 rounded-2xl" size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`required-${connection.vendorId}`} className="text-base font-semibold text-kumo-default">{connection.displayName}</h2>
            <StatusBadge state={connection.state} />
          </div>
          <p className="mt-1 text-sm leading-5 text-kumo-subtle">
            {connection.message ?? statusCopy(connection.state, connection.displayName)}
          </p>
          {actionError && <p className="mt-3 rounded-lg border border-kumo-danger/25 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">{actionError}</p>}
          {(manualUrl || popupBlocked) && (
            <div className="mt-3 rounded-lg border border-kumo-warning/25 bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-warning" role="status">
              {popupBlocked ? 'Your browser blocked the popup. ' : 'A new tab should open. '}
              {manualUrl && <a href={manualUrl} target="_blank" rel="noreferrer" className="font-semibold underline">Open authorization manually</a>}
              <span className="text-kumo-subtle">, then recheck when it finishes.</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {unavailable ? (
            <Link to="/admin" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-kumo-line px-3 text-[13px] font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
              Admin settings <ArrowSquareOut size={13} />
            </Link>
          ) : (
            <WorkshopButton tone="primary" onClick={() => void startConnection()} disabled={busy}>
              {busy ? 'Opening…' : actionLabel}
            </WorkshopButton>
          )}
          <WorkshopButton onClick={() => void onRecheck()} disabled={busy}>
            Recheck
          </WorkshopButton>
        </div>
      </div>
    </article>
  )
}

function StatusBadge({ state }: { state: RequiredConnectionStatus['state'] }) {
  const healthy = state === 'healthy'
  const className = healthy
    ? 'bg-kumo-success-tint text-kumo-success'
    : state === 'unavailable'
      ? 'bg-kumo-danger-tint text-kumo-danger'
      : 'bg-kumo-warning-tint text-kumo-warning'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.35px] ${className}`}>
      {healthy ? <CheckCircle size={12} weight="fill" /> : <WarningCircle size={12} weight="fill" />}
      {state}
    </span>
  )
}

function statusCopy(state: RequiredConnectionStatus['state'], displayName: string): string {
  if (state === 'expired') return `${displayName} needs to be reauthorized before you continue.`
  if (state === 'unavailable') return `${displayName} is required but is not currently available. An admin may need to enable it.`
  if (state === 'missing') return `${displayName} must be connected before you continue.`
  return `${displayName} is connected.`
}
