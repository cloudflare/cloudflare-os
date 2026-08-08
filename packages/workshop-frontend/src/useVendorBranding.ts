import { logRpcFailure } from './rpcErrors'
import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

// How a vendor asks to be shown: its logo, and the background that logo was drawn for.
//
// The two travel together because neither is much use alone. Several vendor logos are single-colour
// glyphs meant for a specific backdrop — MCP's is white — so showing one without its colour makes it
// invisible against a light surface.
export type VendorBranding = {
  logoUrl?: string
  color?: string
}

// Shared per-session cache so every consumer reuses a single fetch.
const cachedPromises = new WeakMap<RpcStub<AuthenticatedApi>, Promise<Map<string, VendorBranding>>>()

const EMPTY: Map<string, VendorBranding> = new Map()

// Maps each vendor id to its branding so connection rows can show the service's icon.
export function useVendorBranding(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
): Map<string, VendorBranding> {
  const [branding, setBranding] = useState<Map<string, VendorBranding>>(EMPTY)

  useEffect(() => {
    if (!authenticatedApi) return
    let cancelled = false

    let promise = cachedPromises.get(authenticatedApi)
    if (!promise) {
      const api = authenticatedApi
      promise = (async () => {
        const vendors = await api.listGatekeeperVendors()
        const map = new Map<string, VendorBranding>()
        for (const vendor of vendors) {
          const { logo, color } = vendor.description
          if (logo?.url || color) {
            map.set(vendor.id, { logoUrl: logo?.url, color })
          }
        }
        return map
      })().catch((err) => {
        cachedPromises.delete(api)
        throw err
      })
      cachedPromises.set(api, promise)
    }

    promise
      .then((map) => { if (!cancelled) setBranding(map) })
      .catch((err) => {
        logRpcFailure('Failed to load vendor branding:', err)
      })

    return () => { cancelled = true }
  }, [authenticatedApi])

  return branding
}
