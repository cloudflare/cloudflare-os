import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { useAlwaysApproveTag } from '../../useAlwaysApproveTag'
import type { AutoApprovalChannel } from './autoApprovalChannel'
import type { AutoApprovalRules } from './autoApprovalRules'
import type { RuleCatalogWants } from './useRuleCatalog'
import { useStandingRules } from './useStandingRules'

/**
 * The workspace's auto-approval rules as a surface that offers "Always approve" reads them, and
 * the call that turns one on. The chat's tray and the Activity pane both show the workspace's
 * pending requests, so both read the rules here: an offer made from anything less than the
 * stored list is made for a rule that may already exist, and confirming it replaces who
 * enabled that rule.
 *
 * A rule counts as enabled when the stored list has it, or when this surface has just turned
 * it on and the list has not been read since, so that the offer goes at the click.
 */
export const useAutoApprovalRules = (
  overseer: RpcStub<Overseer>,
  want: RuleCatalogWants,
  setProcessingActions: Dispatch<SetStateAction<Set<number>>>,
  channel: AutoApprovalChannel | undefined,
) => {
  // The server applies the requests a new rule covers through its drain, and each turns
  // "approved" through the actions subscription, so nothing is marked approved here.
  const { alwaysApproveTag, isTagAutoApproved, forgetOptimisticTags } =
    useAlwaysApproveTag(overseer, setProcessingActions, channel?.changed)
  const { enabledRuleKeys, vendorIdByGatekeeper, ruleApplies, isLoading, loadError, refresh } =
    useStandingRules(overseer, want)

  // Re-read whenever a change settles anywhere in this view. The refreshed list is authoritative,
  // including about a rule someone has just turned off, so the optimistic overlay has nothing left
  // to add and must stop outranking it -- unless the read was overtaken or failed, which set
  // nothing: retiring the overlay against a list that never landed would read a just-enabled rule
  // as off.
  const reloadTrigger = channel?.reloadTrigger
  const rulesReadFor = useRef(reloadTrigger)
  useEffect(() => {
    if (reloadTrigger === rulesReadFor.current) return
    rulesReadFor.current = reloadTrigger
    void refresh().then(applied => {
      if (applied) forgetOptimisticTags()
    })
  }, [reloadTrigger, refresh, forgetOptimisticTags])

  const rules: AutoApprovalRules = useMemo(() => ({
    isEnabled: (gatekeeperId, tag) =>
      enabledRuleKeys.has(`${gatekeeperId}:${tag}`) || isTagAutoApproved(gatekeeperId, tag),
    applies: ruleApplies,
    restricted: want.restricted,
  }), [enabledRuleKeys, isTagAutoApproved, ruleApplies, want.restricted])

  return {
    rules,
    alwaysApproveTag,
    vendorIdByGatekeeper,
    /** The stored rule list is still being read for the first time. */
    isLoading,
    /** The last read of the stored rule list failed, and `rules` holds none of it. */
    loadError,
  }
}
