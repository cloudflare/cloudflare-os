import { useState } from 'react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * Whether the approval dock is shown, and the controls that hide and show it. Hiding it records
 * the newest pending request, so a request queued after that brings the dock back on its own
 * (action ids count up in creation order). `workspaceId` scopes that record, since each workspace
 * numbers its actions from the start.
 */
export function useApprovalDockVisibility(pending: readonly ActionLogEntry[], workspaceId: string) {
  // Where the dock was hidden: the workspace and its newest pending id then. Null when not hidden.
  const [hidden, setHidden] = useState<{ workspaceId: string, through: number } | null>(null)
  const newest = pending.reduce((max, action) => Math.max(max, action.id), -Infinity)
  const hiddenThrough = hidden?.workspaceId === workspaceId ? hidden.through : null
  const shown = pending.length > 0 && (hiddenThrough === null || newest > hiddenThrough)
  return {
    shown,
    hide: () => setHidden({ workspaceId, through: newest }),
    show: () => setHidden(null),
  }
}
