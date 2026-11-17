import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { autoApprovalKey } from '../../useAutoApproval'
import { useRuleCatalog, type RuleCatalogWants } from './useRuleCatalog'

const NO_RULES: ReadonlySet<string> = new Set()

/**
 * The workspace's standing auto-approval rules, as the tray needs them, with the vendor behind
 * each connection, for its logo, and whether the kernel lets a rule apply each kind.
 *
 * Two reads with very different costs. The rule list is a storage read in the workspace, and it is
 * all a bulk run depends on. The rest comes from the auto-approval catalog, which is read only as
 * `want` asks (see `useRuleCatalog`). Its failure costs logos, since a connection with no known
 * vendor shows its resource title's initial, and under the restricted-data latch every rule
 * offer.
 */
export function useStandingRules(overseer: RpcStub<Overseer> | null, want: RuleCatalogWants) {
  const [rules, setRules] = useState(NO_RULES)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const generation = useRef(0)
  const { vendorIdByGatekeeper, ruleApplies, reread } = useRuleCatalog(overseer, want)

  const readRules = useCallback(async (): Promise<boolean> => {
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

  // Not `refresh()`: no answer of the catalog is on show yet, and forgetting one that is being
  // read would only read it twice.
  useEffect(() => {
    setIsLoading(true)
    void readRules()
  }, [readRules])

  /**
   * Re-reads the rule list, and with it the kernel's answer on what a rule applies under the
   * latch. Resolves to whether this read of the list is the one that landed: one overtaken by a
   * later read, or one that failed, returns false, having put no authoritative list in place.
   * A caller holding an optimistic overlay knows from that not to retire it — against an empty
   * list, a rule the user has just enabled would read as off.
   */
  const refresh = useCallback((): Promise<boolean> => {
    reread()
    return readRules()
  }, [readRules, reread])

  return {
    /** `${gatekeeperId}:${tag}` for each standing rule. */
    enabledRuleKeys: rules,
    vendorIdByGatekeeper,
    /** Whether the kernel lets a rule apply `tag` on `gatekeeperId` as the workspace is now. */
    ruleApplies,
    isLoading,
    loadError,
    refresh,
  }
}
