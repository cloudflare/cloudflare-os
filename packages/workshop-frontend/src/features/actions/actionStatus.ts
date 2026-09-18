import type { ActionState } from '@gadgets/workshop-shared/api'

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
