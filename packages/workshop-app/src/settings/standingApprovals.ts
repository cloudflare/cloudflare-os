import type { PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/** A rule a workspace has: actions of one kind, on one of its connections, are approved as they are made. */
export type ApprovalRuleRecord = { gatekeeperId: number; actionKind: ActionKind }

/** One kind of action a workspace could approve without asking, and whether it does. */
export type StandingApproval = {
  /** Which it is among its workspace's: its connection and its kind's tag. */
  key: string
  gatekeeperId: number
  actionKind: ActionKind
  /** What its connection is called, or nothing for one the workspace no longer has. */
  connection: string
  vendorId?: string
  enabled: boolean
  /**
   * The rule is there, but nothing in the workspace offers its kind any more. Still listed, so
   * that a standing approval can always be taken back.
   */
  orphaned: boolean
}

export const standingApprovalKey = ({ gatekeeperId, actionKind }: ApprovalRuleRecord) => `${gatekeeperId}:${actionKind.tag}`

/**
 * What a workspace could approve without asking (`catalog`, from its connections) together with
 * what it does (`rules`): each kind once, on if either says so. A rule for a kind that is no
 * longer offered is kept, after the rest. Within each, by connection and then by what the kind
 * is called.
 */
export const standingApprovals = (catalog: readonly PreApprovableAction[], rules: readonly ApprovalRuleRecord[]): StandingApproval[] => {
  const byKey = new Map<string, StandingApproval>()
  for (const { gatekeeperId, actionKind, resourceTitle, vendorId, alreadyEnabled } of catalog) {
    const key = standingApprovalKey({ gatekeeperId, actionKind })
    byKey.set(key, { key, gatekeeperId, actionKind, connection: resourceTitle, vendorId, enabled: alreadyEnabled, orphaned: false })
  }
  for (const { gatekeeperId, actionKind } of rules) {
    const key = standingApprovalKey({ gatekeeperId, actionKind })
    const offered = byKey.get(key)
    if (offered) offered.enabled = true
    else byKey.set(key, { key, gatekeeperId, actionKind, connection: '', enabled: true, orphaned: true })
  }
  return [...byKey.values()].toSorted(
    (a, b) =>
      Number(a.orphaned) - Number(b.orphaned) ||
      a.connection.localeCompare(b.connection) ||
      a.gatekeeperId - b.gatekeeperId ||
      a.actionKind.label.localeCompare(b.actionKind.label),
  )
}

/** `approvals` with the one `key` names switched to `enabled`. */
export const withApproval = (approvals: readonly StandingApproval[], key: string, enabled: boolean): StandingApproval[] =>
  approvals.map((approval) => (approval.key === key ? { ...approval, enabled } : approval))
