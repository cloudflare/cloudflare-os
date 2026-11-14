import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { autoApprovalKey } from '../../useAutoApproval'

const NO_RULES: ReadonlySet<string> = new Set()
const NO_VENDORS: ReadonlyMap<number, string> = new Map()

/**
 * The workspace's standing auto-approval rules, as the tray needs them, and the vendor behind each
 * connection, for its logo.
 *
 * Two reads with very different costs. The rule list is a storage read in the workspace, and it is
 * all a bulk run depends on. The vendors come from the auto-approval catalog, which starts every
 * gatekeeper a gadget binds and fails whole if any one of them does. So the catalog is read once
 * per workspace connection, only once there is a tray to show, and its failure costs only logos: a
 * connection with no known vendor shows its resource title's initial.
 */
export function useStandingRules(overseer: RpcStub<Overseer> | null, wantVendors: boolean) {
  const [rules, setRules] = useState(NO_RULES)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const generation = useRef(0)

  /**
   * Re-reads the rule list. Resolves to whether this read is the one that landed: one overtaken
   * by a later read, or one that failed, returns false, having put no authoritative list in place.
   * A caller holding an optimistic overlay knows from that not to retire it — against an empty
   * list, a rule the user has just enabled would read as off.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    const current = ++generation.current
    if (!overseer) {
      setRules(NO_RULES)
      setLoadError(false)
      setIsLoading(false)
      return true
    }
    try {
      const list = await overseer.listAutoApprovedActionKinds()
      if (current !== generation.current) return false
      setRules(new Set(list.map(autoApprovalKey)))
      setLoadError(false)
      setIsLoading(false)
      return true
    } catch (error) {
      if (current !== generation.current) return false
      console.error('Failed to load auto-approval rules:', error)
      setRules(NO_RULES)
      setLoadError(true)
      setIsLoading(false)
      return false
    }
  }, [overseer])

  useEffect(() => {
    setIsLoading(true)
    void refresh()
  }, [refresh])

  // Kept with the stub it was read through, so a new workspace connection reads its own rather
  // than showing the last one's logos. Wrapped, because a stub cannot be a state value itself.
  const [vendors, setVendors] = useState<{ from: RpcStub<Overseer> | null, map: ReadonlyMap<number, string> }>(
    { from: null, map: NO_VENDORS })
  useEffect(() => {
    if (!overseer || !wantVendors || vendors.from === overseer) return
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
  }, [overseer, wantVendors, vendors.from])

  return {
    /** `${gatekeeperId}:${tag}` for each standing rule. */
    enabledRuleKeys: rules,
    vendorIdByGatekeeper: vendors.from === overseer ? vendors.map : NO_VENDORS,
    isLoading,
    loadError,
    refresh,
  }
}
