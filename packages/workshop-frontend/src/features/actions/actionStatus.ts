import type { ActionState } from '@gadgets/workshop-shared/api'

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
