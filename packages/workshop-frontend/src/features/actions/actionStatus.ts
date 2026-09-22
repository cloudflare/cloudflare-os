import type { ActionLogEntry, ActionState } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/**
 * How an action's outcome reads to the user. Two states do not describe a decision anyone made
 * about this action: a cascade-invalidated one was taken down by an earlier rejection (see
 * `cascadedFrom`), and a veto the gatekeeper refused leaves the record applied although the user
 * asked for the opposite (see `vetoRefused`). Both would otherwise read as someone's verdict.
 *
 * Shared because deriving it per surface is what let the chat card and the Activity row disagree
 * about the same record.
 */
export function actionStatusLabel(
  action: { state: ActionState; cascadedFrom?: number; vetoRefused?: true },
): 'Pending' | 'Approved' | 'Denied' | 'Invalidated' | 'Already applied' {
  if (action.state === 'pending') return 'Pending'
  if (action.state === 'approved') return action.vetoRefused ? 'Already applied' : 'Approved'
  return action.cascadedFrom === undefined ? 'Denied' : 'Invalidated'
}

/** What the "Always approve this type" confirmation needs to know about the action it came from. */
export type AutoApproveTarget = {
  actionId: number
  gatekeeperId: number
  resourceTitle: string
  actionKind: ActionKind
  actionLabel: string
}

/**
 * Offer "Always approve this type" only when enabling a rule would actually apply this action: a
 * tagged action on a connection that the gatekeeper marked auto-approvable, whose last attempt did
 * not stop. (A non-auto-approvable action stays a manual gate even with a rule; a stopped one needs
 * an explicit retry; an auto-approvable action with an existing rule wouldn't still be pending.)
 */
export function autoApproveTargetOf(
  log: ActionLogEntry & { type: 'action' },
): AutoApproveTarget | undefined {
  if (log.gatekeeperId === undefined || log.description.actionKind === undefined ||
      log.description.autoApprovable !== true || log.failure !== undefined) {
    return undefined
  }
  return {
    actionId: log.id,
    gatekeeperId: log.gatekeeperId,
    resourceTitle: log.resourceTitle,
    actionKind: log.description.actionKind,
    actionLabel: log.description.title,
  }
}
