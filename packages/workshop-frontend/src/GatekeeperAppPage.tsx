import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp, { type GatekeeperAppDependency } from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'
import { compositeSourceApps, isFirstPartyWorkItemsShell } from './useGatekeeperApps'
import { useSessionsContext } from './components/sessions/SessionsContext'
import { codingSessionInputForWorkItem, type WorkItemTarget } from './workItemNavigation'

// The frame's `ui` is an RPC stub at runtime; dispose it to release the server-side capability.
function disposeFrame(frame: GatekeeperUiFrame | null) {
  (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
}

/**
 * Renders a gatekeeper's full-page management app (a sandboxed SPA the gatekeeper serves).
 * Fetches the app frame (iframe HTML + `ui` capability) from the backend and hosts it.
 */
export default function GatekeeperAppPage({
  appId,
  routeState,
  setRouteState,
}: {
  appId: string,
  routeState?: string,
  setRouteState?: (value: string) => void,
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const sessions = useSessionsContext()
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{
    frame: GatekeeperUiFrame
    dependencies: GatekeeperAppDependency[]
    app?: GatekeeperAppInfo
    discoveryFailed: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    const acquired: GatekeeperUiFrame[] = []
    setError(null)
    setState(null)
    const load = async () => {
      let discoveryFailed = false
      // Discover afresh: the navigation cache may predate an existing account's UI declaration.
      const availableApps = authenticatedApi.listGatekeeperApps().catch((err) => {
        discoveryFailed = true
        reportIssue('gatekeeper-app.discovery', err, { gatekeeperVendorId: appId })
        return [] as GatekeeperAppInfo[]
      })
      const frame = await authenticatedApi.getGatekeeperApp(appId)
      if (!frame) {
        if (!cancelled) setError('This app is not available on this deployment.')
        return
      }
      if (cancelled) {
        disposeFrame(frame)
        return
      }
      acquired.push(frame)
      const apps = await availableApps
      if (cancelled) return
      const currentApp = apps.find((candidate) => candidate.id === appId)
      const sourceApps = currentApp ? compositeSourceApps(currentApp, apps) : []
      const dependencies = (await Promise.all(sourceApps.map(async (sourceApp) => {
        try {
          const sourceFrame = await authenticatedApi.getGatekeeperApp(sourceApp.id) as GatekeeperUiFrame | null
          if (!sourceFrame) return { app: sourceApp, capability: null, error: `${sourceApp.title} is unavailable. Check its connection in Connectors, then retry.` }
          if (cancelled) {
            disposeFrame(sourceFrame)
            return null
          }
          acquired.push(sourceFrame)
          return {app: sourceApp, capability: sourceFrame.ui} satisfies GatekeeperAppDependency
        } catch (err) {
          console.error(`Failed to load composite gatekeeper app source ${sourceApp.vendorId}:`, err)
          reportIssue('gatekeeper-app.composite-source.load', err, {
            gatekeeperVendorId: sourceApp.vendorId,
          })
          return { app: sourceApp, capability: null, error: `Could not load ${sourceApp.title}. Retry, or check its connection in Connectors.` }
        }
      }))).filter((dependency): dependency is GatekeeperAppDependency => dependency !== null)
      if (cancelled) return
      setState({ frame, dependencies, app: currentApp, discoveryFailed })
    }
    load()
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        if (!cancelled) setError(`${err}`)
      })
    return () => {
      cancelled = true
      for (const frame of acquired) disposeFrame(frame)
    }
  }, [appId, authenticatedApi, reload])

  const requestCodingSession = useCallback((target: WorkItemTarget, title: string) => {
    sessions.prepareSession(title, codingSessionInputForWorkItem(target))
    void navigate({ to: '/sessions' })
  }, [navigate, sessions])

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-kumo-subtle">
        <p role="alert">{error}</p>
        <button className="mt-4 underline" type="button" onClick={() => setReload((value) => value + 1)}>Retry loading app</button>
      </div>
    )
  }
  if (!state) {
    return <div className="px-4 py-16 text-center text-sm text-kumo-subtle">Loading…</div>
  }

  // Fill the routed area below the header so the embedded app can manage its own internal layout.
  return (
    <div className="flex h-full flex-col">
      {state.discoveryFailed && (
        <div className="shrink-0 px-4 py-2 text-sm text-kumo-subtle">
          <span role="status">Provider discovery is unavailable. Connected app capabilities could not be loaded.</span>{' '}
          <button type="button" className="underline" onClick={() => setReload((value) => value + 1)}>Retry provider discovery</button>
        </div>
      )}
      <div className="min-h-0 flex-1">
      <SandboxedGatekeeperApp
        frame={state.frame}
        gatekeeperVendorId={state.app?.vendorId ?? appId}
        dependencies={state.dependencies}
        routeState={routeState}
        setRouteState={setRouteState}
        codingSessionAvailable={sessions.github.state === 'connected'}
        workItemHandoffs={isFirstPartyWorkItemsShell(state.app)}
        onRequestCodingSession={requestCodingSession}
        onRetryProviders={() => setReload((value) => value + 1)}
      />
      </div>
    </div>
  )
}
