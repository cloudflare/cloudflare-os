import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

type ActionDecision = 'approve' | 'deny'

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
) {
  const toasts = useKumoToastManager()

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      toasts.add({ title: `Failed to ${decision} action`, variant: 'error' })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
