import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { ACTION_ERROR_MESSAGES, getActionErrorCode } from '@gadgets/workshop-shared/api'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'

type ActionDecision = 'approve' | 'deny'

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      const code = getActionErrorCode(error)
      toasts.add({
        title: code === undefined
          ? 'Couldn’t confirm the action’s outcome. Check its status.'
          : ACTION_ERROR_MESSAGES[code],
        variant: 'error',
      })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
