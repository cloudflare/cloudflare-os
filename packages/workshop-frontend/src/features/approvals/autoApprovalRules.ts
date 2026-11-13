import type { PendingChange } from './pendingChangeGroups'

/** Which auto-approval rules the workspace holds, and whether any of them can apply at all. */
export interface AutoApprovalRules {
  /** Whether a rule covers `tag` on `gatekeeperId`. From `listPreApprovableActions`, not inferred. */
  isEnabled: (gatekeeperId: number, tag: string) => boolean
  /**
   * The workspace's restricted-data latch. While set, the kernel refuses every rule, so no
   * surface may claim that anything will apply on its own.
   */
  restricted: boolean
}

/** What the rules are evaluated against: any request, pending or not. */
type Candidate = Pick<PendingChange, 'gatekeeperId' | 'description'>

/**
 * Whether a rule could cover this request at all: the gatekeeper marked it auto-approvable, it
 * carries a kind to key a rule on, and the workspace is not latched into restricted mode.
 *
 * Whether one actually does takes the rule list. This is what can still be said when that list
 * is missing — a list nobody could read is not a list that says no.
 */
export function couldBeAutoApproved(entry: Candidate, rules: AutoApprovalRules): boolean {
  return !rules.restricted && entry.description.autoApprovable === true &&
    entry.description.actionKind !== undefined
}

/**
 * Whether a request would be applied without a human.
 *
 * A client-side mirror of the kernel's `autoApprovalRule()`, which is *the* authority; this copy
 * exists only to explain why a request is still waiting, and never decides anything. Keep its
 * four conditions in step with that function: the gatekeeper's own `autoApprovable` verdict, an
 * action kind to key a rule on, a rule enabled for that kind on that connection, and no
 * restricted-data latch — which disables every rule at once.
 */
export function isAutoApproved(entry: Candidate, rules: AutoApprovalRules): boolean {
  return couldBeAutoApproved(entry, rules) &&
    rules.isEnabled(entry.gatekeeperId, entry.description.actionKind!.tag)
}

/**
 * Whether offering "Always approve" on this request would actually do anything.
 *
 * Enabling a rule only applies a request the gatekeeper already marked auto-approvable: anything
 * else stays a manual gate with the rule on, so the button would grant a standing permission and
 * leave the request sitting there. Offered only when no rule covers it yet — the chat surface
 * used to infer that from the request still being pending, which is wrong, since the drain stops
 * at the first manual gate and leaves covered requests queued behind it.
 */
export function canOfferAlwaysApprove(entry: Candidate, rules: AutoApprovalRules): boolean {
  const kind = entry.description.actionKind
  return !rules.restricted && entry.description.autoApprovable === true && kind !== undefined &&
    !rules.isEnabled(entry.gatekeeperId, kind.tag)
}

/**
 * The request holding up an auto-approved one, if any.
 *
 * The drain applies a connection's requests in id order and stops at the first one a human must
 * answer, never skipping ahead (`AutoApprovalDrainer`). So a request a rule covers can still be
 * pending, and the reason is always the oldest pending request on the same connection that no
 * rule covers. Without this, a covered request reads as broken: its rule is on, and nothing
 * happens.
 *
 * `siblings` is the connection's own pending requests, oldest first — which is exactly a group's
 * entries, since the tray groups every pending request in the workspace by connection.
 */
export function blockedBy(
  entry: PendingChange,
  siblings: readonly PendingChange[],
  rules: AutoApprovalRules,
): PendingChange | undefined {
  if (!isAutoApproved(entry, rules)) return undefined
  return siblings.find(other => other.id < entry.id && !isAutoApproved(other, rules))
}
