import { useEffect, useState } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from './AuthContext'

// Shared per-API-stub cache of the listGatekeeperApps() request, so multiple callers in one render
// cycle (e.g. the Header nav and the /gatekeepers/$appId page) share a single RPC instead of each
// firing their own. Keyed weakly by the stub, so it's dropped when the authenticated session ends.
const appsRequestByApi = new WeakMap<object, Promise<GatekeeperAppInfo[]>>()

// Mounted useGatekeeperApps() hooks register here so an explicit refresh can prompt them to refetch.
const refreshListeners = new Set<() => void>()

/** Omits management apps intended only as capabilities of a composite app. */
export function navigableGatekeeperApps(apps: GatekeeperAppInfo[]): GatekeeperAppInfo[] {
  return apps.filter((app) => app.composition?.embeddedOnly !== true)
}

/** Selects explicitly declared embedded sources for one composite app, failing closed on bad metadata. */
export function isFirstPartyWorkItemsShell(app: GatekeeperAppInfo | undefined): app is GatekeeperAppInfo {
  // Vendor IDs are lowercased binding suffixes: GATEKEEPER_WORK_ITEMS -> work_items.
  return app?.vendorId === 'work_items'
    && app.composition?.kind === 'work-items'
    && app.composition.role === undefined
    && app.composition.embeddedOnly !== true
}

export function compositeSourceApps(
  shell: GatekeeperAppInfo,
  apps: GatekeeperAppInfo[],
): GatekeeperAppInfo[] {
  const kind = shell.composition?.kind
  if (typeof kind !== 'string' || kind.length === 0
      || kind === 'work-items' && !isFirstPartyWorkItemsShell(shell)
      || shell.composition?.role !== undefined || shell.composition?.embeddedOnly === true) {
    return []
  }
  return apps.filter((candidate) => {
    const composition = candidate.composition
    if (candidate.id === shell.id || composition?.kind !== kind || composition.embeddedOnly !== true) {
      return false
    }
    if (kind === 'work-items') {
      return (composition.role === 'jira' && candidate.vendorId === 'jira')
        || (composition.role === 'zendesk' && candidate.vendorId === 'zendesk')
    }
    return typeof composition.role === 'string' && composition.role.length > 0
  })
}

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
 * navigable apps without hardcoding any gatekeeper. Composite source apps are included only when
 * explicitly requested. Returns [] until authenticated/loaded.
 * `GatekeeperAppInfo` is plain data, so it's safe to hold in state.
 */
export function useGatekeeperApps(options?: { includeEmbedded?: boolean }): GatekeeperAppInfo[] {
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

  return options?.includeEmbedded
    ? apps
    : navigableGatekeeperApps(apps)
}
