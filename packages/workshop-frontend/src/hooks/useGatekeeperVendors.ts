import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../rpcErrors'

type VendorsById = ReadonlyMap<string, GatekeeperVendorInfo>

// Shared per-session cache so every consumer reuses a single fetch.
const cachedVendors = new WeakMap<RpcStub<AuthenticatedApi>, Promise<VendorsById>>()

const NO_VENDORS: VendorsById = new Map()

/**
 * Maps each vendor id to its catalog entry: display metadata and resource types. Fetched once per
 * session, and again by the next consumer after a failure.
 */
export const useGatekeeperVendors = (authenticatedApi: RpcStub<AuthenticatedApi> | null): VendorsById => {
  const [vendors, setVendors] = useState(NO_VENDORS)

  useEffect(() => {
    if (!authenticatedApi) return
    let cancelled = false
    let promise = cachedVendors.get(authenticatedApi)
    if (!promise) {
      promise = authenticatedApi.listGatekeeperVendors().then(
        (list): VendorsById => new Map(list.map(vendor => [vendor.id, vendor])),
        (err: unknown) => {
          cachedVendors.delete(authenticatedApi)
          throw err
        },
      )
      cachedVendors.set(authenticatedApi, promise)
    }
    promise
      .then((map) => { if (!cancelled) setVendors(map) })
      .catch((err: unknown) => { logRpcFailure('Failed to load gatekeeper vendors:', err) })
    return () => { cancelled = true }
  }, [authenticatedApi])

  return vendors
}
