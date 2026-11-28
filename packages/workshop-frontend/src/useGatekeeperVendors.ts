import { logRpcFailure } from './rpcErrors'
import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

// Shared per-session cache so every consumer reuses a single fetch.
const cachedPromises = new WeakMap<RpcStub<AuthenticatedApi>, Promise<GatekeeperVendorInfo[]>>()

const EMPTY: readonly GatekeeperVendorInfo[] = []

/** The deployment's vendors (listGatekeeperVendors), read once per session. Empty until loaded. */
export function useGatekeeperVendors(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
): readonly GatekeeperVendorInfo[] {
  const [vendors, setVendors] = useState(EMPTY)

  useEffect(() => {
    if (!authenticatedApi) return
    let cancelled = false

    let promise = cachedPromises.get(authenticatedApi)
    if (!promise) {
      const api = authenticatedApi
      promise = (async () => await api.listGatekeeperVendors())().catch((err: unknown) => {
        cachedPromises.delete(api)
        throw err
      })
      cachedPromises.set(api, promise)
    }

    promise
      .then((list) => { if (!cancelled) setVendors(list) })
      .catch((err) => {
        logRpcFailure('Failed to load vendors:', err)
      })

    return () => { cancelled = true }
  }, [authenticatedApi])

  return vendors
}
