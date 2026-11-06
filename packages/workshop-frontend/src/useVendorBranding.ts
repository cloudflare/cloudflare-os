import { useMemo } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useGatekeeperVendors } from './hooks/useGatekeeperVendors'

/**
 * How a vendor asks to be shown: its logo, and the background that logo was drawn for.
 *
 * The two travel together because neither is much use alone. Several vendor logos are single-colour
 * glyphs meant for a specific backdrop — MCP's is white — so showing one without its colour makes it
 * invisible against a light surface.
 */
export type VendorBranding = {
  logoUrl?: string
  color?: string
}

/** Maps each vendor id to its branding so connection rows can show the service's icon. */
export function useVendorBranding(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
): Map<string, VendorBranding> {
  const vendors = useGatekeeperVendors(authenticatedApi)
  // Memoized on the catalog so the map keeps its identity across renders; the composer memoizes
  // its tokens on it.
  return useMemo(() => {
    const map = new Map<string, VendorBranding>()
    for (const vendor of vendors.values()) {
      const { logo, color } = vendor.description
      if (logo?.url || color) {
        map.set(vendor.id, { logoUrl: logo?.url, color })
      }
    }
    return map
  }, [vendors])
}
