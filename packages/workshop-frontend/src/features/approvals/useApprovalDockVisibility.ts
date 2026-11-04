import { useState } from 'react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/**
 * Whether the approval dock is shown, and the controls that hide and show it. Hiding it records
 * the newest pending request, so a request queued after that brings the dock back on its own
 * (action ids count up in creation order).
 */
export function useApprovalDockVisibility(pending: readonly ActionLogEntry[]) {
  // The newest pending id when the dock was hidden; null while it is not hidden.
  const [hiddenThrough, setHiddenThrough] = useState<number | null>(null)
  const newest = pending.reduce((max, action) => Math.max(max, action.id), -Infinity)
  const shown = pending.length > 0 && (hiddenThrough === null || newest > hiddenThrough)
  return {
    shown,
    hide: () => setHiddenThrough(newest),
    show: () => setHiddenThrough(null),
  }
}
