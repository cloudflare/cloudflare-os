import {
  ADMIN_AGENT_ACTIONS, ADMIN_GATEKEEPER_VENDOR_ID, adminAgentAction,
} from '@gadgets/workshop-shared/admin-agent'
import type { PendingChange } from './pendingChangeGroups'

/** Which auto-approval rules the workspace holds, and which kinds a rule can apply at all. */
export interface AutoApprovalRules {
  /** Whether a rule covers `tag` on `gatekeeperId`. From `listPreApprovableActions`, not inferred. */
  isEnabled: (gatekeeperId: number, tag: string) => boolean
  /**
   * Whether the stored rules were read, so that `isEnabled` says what the workspace holds. No
   * rule is offered until they were: one offered from an unread list may exist already, and
   * confirming it would replace who enabled it.
   */
  known: boolean
  /**
   * Whether the kernel lets a rule apply this kind as the workspace is now
   * (`PreApprovableAction.ruleApplies`). Every kind while the workspace is not restricted;
   * in a restricted one only what the kernel said, and no kind while its answer is unread.
   */
  applies: (gatekeeperId: number, tag: string) => boolean
  /**
   * The workspace's restricted-data latch. While set an approver vouches for what they read,
   * so every approve surface shows the notice and nothing is approved in bulk.
   */
  restricted: boolean
}

/** What the rules are evaluated against: any request, pending or not. */
type Candidate = Pick<PendingChange, 'gatekeeperId' | 'description'>

/**
 * Whether a rule could cover this request at all: the gatekeeper marked it auto-approvable, it
 * carries a kind to key a rule on, and the kernel lets a rule apply that kind in the workspace
 * as it is now.
 *
 * Whether one actually does takes the rule list. This is what can still be said when that list
 * is missing — a list nobody could read is not a list that says no.
 */
export function couldBeAutoApproved(entry: Candidate, rules: AutoApprovalRules): boolean {
  const kind = entry.description.actionKind
  return entry.description.autoApprovable === true && kind !== undefined &&
    rules.applies(entry.gatekeeperId, kind.tag)
}

/**
 * Whether a request would be applied without a human.
 *
 * A client-side mirror of the kernel's `autoApprovalRule()`, which is *the* authority; this copy
 * exists only to explain why a request is still waiting, and never decides anything. Keep its
 * four conditions in step with that function: the gatekeeper's own `autoApprovable` verdict, an
 * action kind to key a rule on, a rule enabled for that kind on that connection, and the
 * kernel's `ruleApplies()`, which under the restricted-data latch lets a rule apply only a few
 * kinds.
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
 * leave the request sitting there. Offered only when no rule covers it yet, read from the rule
 * list itself: a request still being pending says nothing about that, since the drain stops at
 * the first manual gate and leaves covered requests queued behind it.
 */
export function canOfferAlwaysApprove(entry: Candidate, rules: AutoApprovalRules): boolean {
  const kind = entry.description.actionKind
  return rules.known && entry.description.autoApprovable === true && kind !== undefined &&
    rules.applies(entry.gatekeeperId, kind.tag) && !rules.isEnabled(entry.gatekeeperId, kind.tag)
}

/**
 * Whether a rule might still apply this request under the restricted-data latch: its kind
 * is one the kernel's table lets a rule apply there. A reason to ask the kernel, never the
 * answer, which also depends on the connection and on what the workspace has read.
 */
export function mayApplyWhileRestricted(entry: Pick<Candidate, 'description'>): boolean {
  return tagAppliesWhileRestricted(entry.description.actionKind?.tag)
}

function tagAppliesWhileRestricted(tag: string | undefined): boolean {
  const kind = adminAgentAction(tag)
  return kind !== undefined && ADMIN_AGENT_ACTIONS[kind].autoApprovableWhileRestricted
}

/**
 * Whether a rule for `tag` on a connection of `vendorId` is one the person turning it on is
 * told keeps applying once the workspace has read sensitive data: a kind the kernel's table
 * lets a rule apply under the restricted-data latch, on the admin gatekeeper's connection. A
 * connection whose vendor is not known here is taken for that one: its tags are its own.
 */
export function keepsApplyingWhileRestricted(tag: string, vendorId: string | undefined): boolean {
  return (vendorId === undefined || vendorId === ADMIN_GATEKEEPER_VENDOR_ID) &&
    tagAppliesWhileRestricted(tag)
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
