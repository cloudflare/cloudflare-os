import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/** The auto-approval rule an "Always approve" control would enable, and what its dialog names. */
export type AlwaysApproveTarget = {
  actionId: number
  gatekeeperId: number
  resourceTitle: string
  actionKind: ActionKind
  actionLabel: string
}

/**
 * The rule to offer for a pending action, only when enabling it would actually apply the action:
 * a tagged action on a connection whose gatekeeper marked it auto-approvable. (A non-auto-approvable
 * action stays a manual gate even with a rule; an auto-approvable one with a rule would not still
 * be pending.) Never offered while the workspace is restricted, where actions are never
 * auto-approved.
 */
export const alwaysApproveTarget = (
  entry: ActionLogEntry, restricted: boolean,
): AlwaysApproveTarget | undefined => {
  if (restricted || entry.type !== 'action' || entry.gatekeeperId === undefined) return undefined
  const { actionKind, autoApprovable, title } = entry.description
  if (actionKind === undefined || autoApprovable !== true) return undefined
  return {
    actionId: entry.id,
    gatekeeperId: entry.gatekeeperId,
    resourceTitle: entry.resourceTitle,
    actionKind,
    actionLabel: title,
  }
}
