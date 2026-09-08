import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp, { type GatekeeperAppDependency } from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'
import { compositeSourceApps, isFirstPartyWorkItemsShell, useGatekeeperApps } from './useGatekeeperApps'
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
  const apps = useGatekeeperApps({includeEmbedded: true})
  const app = apps.find((candidate) => candidate.id === appId)
  const gatekeeperVendorId = app?.vendorId ?? appId
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{
    frame: GatekeeperUiFrame
    dependencies: GatekeeperAppDependency[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const acquired: GatekeeperUiFrame[] = []
    setError(null)
    setState(null)
    const load = async () => {
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
      const sourceApps = app ? compositeSourceApps(app, apps) : []
      const dependencies = (await Promise.all(sourceApps.map(async (sourceApp) => {
        try {
          const sourceFrame = await authenticatedApi.getGatekeeperApp(sourceApp.id) as GatekeeperUiFrame | null
          if (!sourceFrame) return null
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
          return null
        }
      }))).filter((dependency): dependency is GatekeeperAppDependency => dependency !== null)
      if (cancelled) return
      setState({ frame, dependencies })
    }
    load()
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId,
        })
        if (!cancelled) setError(`${err}`)
      })
    return () => {
      cancelled = true
      for (const frame of acquired) disposeFrame(frame)
    }
  }, [app, appId, apps, authenticatedApi, gatekeeperVendorId])

  const requestCodingSession = useCallback((target: WorkItemTarget, title: string) => {
    sessions.prepareSession(title, codingSessionInputForWorkItem(target))
    void navigate({ to: '/sessions' })
  }, [navigate, sessions])

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-kumo-subtle">{error}</div>
    )
  }
  if (!state) {
    return <div className="px-4 py-16 text-center text-sm text-kumo-subtle">Loading…</div>
  }

  // Fill the routed area below the header so the embedded app can manage its own internal layout.
  return (
    <div className="h-full">
      <SandboxedGatekeeperApp
        frame={state.frame}
        gatekeeperVendorId={gatekeeperVendorId}
        dependencies={state.dependencies}
        routeState={routeState}
        setRouteState={setRouteState}
        codingSessionAvailable={sessions.github.state === 'connected'}
        workItemHandoffs={isFirstPartyWorkItemsShell(app)}
        onRequestCodingSession={requestCodingSession}
      />
    </div>
  )
}
