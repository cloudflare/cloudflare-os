import type { ActionLogEntry, ActionState } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/**
 * How an action's outcome reads to the user. A cascade-invalidated action was taken down by an
 * earlier rejection rather than refused on its own merits, so it must not read as a decision anyone
 * made about this action (see `cascadedFrom` in the API).
 *
 * Shared because deriving it per surface is what let the chat card and the Activity row disagree
 * about the same record.
 */
export function actionStatusLabel(action: { state: ActionState; cascadedFrom?: number }):
  'Pending' | 'Approved' | 'Denied' | 'Invalidated' {
  if (action.state === 'pending') return 'Pending'
  if (action.state === 'approved') return 'Approved'
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
 * not stop, in a workspace that has not read restricted data. (A non-auto-approvable action stays a
 * manual gate even with a rule; a stopped one needs an explicit retry; no rule fires while the
 * workspace is restricted; an auto-approvable action with an existing rule wouldn't still be
 * pending.)
 */
export function autoApproveTargetOf(
  log: ActionLogEntry & { type: 'action' },
  restricted: boolean | undefined,
): AutoApproveTarget | undefined {
  if (restricted || log.gatekeeperId === undefined || log.description.actionKind === undefined ||
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
