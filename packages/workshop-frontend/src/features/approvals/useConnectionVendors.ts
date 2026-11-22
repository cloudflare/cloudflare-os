import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

const NO_VENDORS: ReadonlyMap<number, string> = new Map()

/**
 * The vendor behind each of the workspace's connections, for the tray's logos.
 *
 * They come from the auto-approval catalog, which starts every gatekeeper a gadget binds and fails
 * whole if any one of them does. So the catalog is read once per workspace connection, only once
 * there is a tray to show (`wanted`), and its failure costs only logos: a connection with no known
 * vendor shows its resource title's initial.
 */
export function useConnectionVendors(
  overseer: RpcStub<Overseer> | null,
  wanted: boolean,
): ReadonlyMap<number, string> {
  // Kept with the stub it was read through, so a new workspace connection reads its own rather
  // than showing the last one's logos. Wrapped, because a stub cannot be a state value itself.
  const [vendors, setVendors] = useState<{ from: RpcStub<Overseer> | null, map: ReadonlyMap<number, string> }>(
    { from: null, map: NO_VENDORS })
  useEffect(() => {
    if (!overseer || !wanted || vendors.from === overseer) return
    let live = true
    overseer.listPreApprovableActions().then(catalog => {
      if (!live) return
      const map = new Map<number, string>()
      for (const action of catalog) {
        if (action.vendorId) map.set(action.gatekeeperId, action.vendorId)
      }
      setVendors({ from: overseer, map })
    }, (error: unknown) => {
      if (live) console.error('Failed to load connection vendors:', error)
    })
    return () => { live = false }
  }, [overseer, wanted, vendors.from])

  return vendors.from === overseer ? vendors.map : NO_VENDORS
}
