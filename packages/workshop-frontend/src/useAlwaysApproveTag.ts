import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { Overseer } from '@gadgets/workshop-shared/api'
import { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/**
 * Enables an auto-approval rule for the action's (gatekeeperId, actionKind.tag), and tracks
 * which tags were just enabled so callers can hide the affordance immediately on every same-tag
 * pending row, rather than waiting for the action-log subscription to catch up.
 */
export function useAlwaysApproveTag(
    overseer: RpcStub<Overseer>,
    setProcessingActions: Dispatch<SetStateAction<Set<number>>>,
    // Invoked after a rule is successfully enabled, so other views (e.g. the Connections rule list)
    // can refresh without waiting to be re-opened.
    onEnabled?: () => void) {
  const toasts = useKumoToastManager()
  const [enabledTags, setEnabledTags] = useState<Set<string>>(new Set())

  // Enable auto-approval for the action's class. Returns true on success, false on failure (the
  // error is surfaced via a toast) so the caller can decide whether to dismiss a confirm dialog.
  const alwaysApproveTag = useCallback(
      async (actionId: number, gatekeeperId: number,
             actionKind: ActionKind): Promise<boolean> => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.setAutoApprovedActionKind(gatekeeperId, actionKind)
      setEnabledTags(prev => new Set(prev).add(`${gatekeeperId}:${actionKind.tag}`))
      onEnabled?.()
      return true
    } catch (err) {
      console.error('Failed to enable auto-approval:', err)
      toasts.add({ title: 'Failed to enable auto-approval', variant: 'error' })
      return false
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessingActions, toasts, onEnabled])

  const isTagAutoApproved = useCallback(
      (gatekeeperId: number, tag: string) => enabledTags.has(`${gatekeeperId}:${tag}`),
      [enabledTags])

  return { alwaysApproveTag, isTagAutoApproved }
}
