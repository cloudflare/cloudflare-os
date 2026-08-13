import { useEffect, useState } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from './AuthContext'

// Shared per-API-stub cache of the listGatekeeperApps() request, so multiple callers in one render
// cycle (e.g. the Header nav and the /gatekeepers/$appId page) share a single RPC instead of each
// firing their own. Keyed weakly by the stub, so it's dropped when the authenticated session ends.
const appsRequestByApi = new WeakMap<object, Promise<GatekeeperAppInfo[]>>()

// Mounted useGatekeeperApps() hooks register here so an explicit refresh can prompt them to refetch.
const refreshListeners = new Set<() => void>()

/**
 * Drop the cached apps request and prompt mounted hooks to refetch. Unlike connected accounts, the
 * apps list has no live subscription, so callers must invoke this after an action that changes which
 * gatekeepers provide a UI (opting into or disconnecting an optional ambient gatekeeper).
 */
export function refreshGatekeeperApps(api: object): void {
  appsRequestByApi.delete(api)
  for (const listener of refreshListeners) listener()
}

/**
 * The gatekeeper-served management apps available to the current user (one per gatekeeper that sets
 * `providesUi`, e.g. the Context Library). The Workshop hosts each at `/gatekeepers/$appId` and lists
 * them in the nav — no gatekeeper is hardcoded here; the set comes from the backend's discovery of
 * bound gatekeepers. Returns [] until authenticated/loaded. `GatekeeperAppInfo` is plain data
 * (id/title/icon), so it's safe to hold in state.
 */
export function useGatekeeperApps(): GatekeeperAppInfo[] {
  const auth = useOptionalAuthenticatedApi()
  const [apps, setApps] = useState<GatekeeperAppInfo[]>([])
  // Bumped by refreshGatekeeperApps() to re-run the fetch effect after the cache is invalidated.
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const listener = () => setRefreshTick((t) => t + 1)
    refreshListeners.add(listener)
    return () => { refreshListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!auth) {
      setApps([])
      return
    }
    const api: object = auth.authenticatedApi
    let request = appsRequestByApi.get(api)
    if (!request) {
      request = auth.authenticatedApi.listGatekeeperApps()
      appsRequestByApi.set(api, request)
      // Don't cache a failure permanently — drop it so a later mount can retry.
      request.catch(() => appsRequestByApi.delete(api))
    }
    let cancelled = false
    request
      .then((list) => {
        if (!cancelled) setApps(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [auth, refreshTick])

  return apps
}
