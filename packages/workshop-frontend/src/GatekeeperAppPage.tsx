import { useEffect, useState } from 'react'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'
import { disposeGatekeeperUiFrame } from './gatekeeperUiFrameLifecycle'

/**
 * Renders a gatekeeper's full-page management app (a sandboxed SPA the gatekeeper serves).
 * Fetches the app frame (iframe HTML + `ui` capability) from the backend and hosts it.
 */
export default function GatekeeperAppPage({ appId }: { appId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{ frame: GatekeeperUiFrame } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let acquired: GatekeeperUiFrame | null = null
    let settled = false
    let requestDisposed = false
    setState(null)
    setError(null)
    const request = authenticatedApi.getGatekeeperApp(appId)
    Promise.resolve(request)
      .then((frame) => {
        settled = true
        if (!frame) {
          if (!cancelled) setError('This app is not available on this deployment.')
          return
        }
        if (cancelled && !requestDisposed) {
          disposeGatekeeperUiFrame(frame)
          return
        }
        if (cancelled) return
        acquired = frame
        setState({ frame })
      })
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        if (!cancelled) setError(`${err}`)
      })
    return () => {
      cancelled = true
      if (!settled) {
        const disposeRequest = (request as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]
        if (disposeRequest) {
          requestDisposed = true
          disposeRequest.call(request)
        }
      }
      disposeGatekeeperUiFrame(acquired)
    }
  }, [authenticatedApi, appId])

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
      <SandboxedGatekeeperApp frame={state.frame} gatekeeperVendorId={appId} />
    </div>
  )
}
