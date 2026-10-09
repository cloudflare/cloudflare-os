import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ActionState, Overseer } from '@gadgets/workshop-shared/api'
import { CreationAccountModal } from './components/CreationAccountModal'

type ActionDecision = 'approve' | 'deny'

/**
 * Returns `resolveAction` for an action's approve/deny controls, and `creationAccountModal` for
 * the caller to render: approving a creation first asks which account to create it in.
 */
export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  const [creation, setCreation] = useState<ActionLogEntry | null>(null)

  const resolve = useCallback(async (
    actionId: number, decision: ActionDecision, accountId?: number,
  ) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId, accountId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
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

  const resolveAction = useCallback(async (action: ActionLogEntry, decision: ActionDecision) => {
    if (decision === 'approve' && action.type === 'action' && action.creation) setCreation(action)
    else await resolve(action.id, decision)
  }, [resolve])

  const creationAccountModal = creation && (
    <CreationAccountModal
      overseer={overseer}
      gatekeeperId={creation.gatekeeperId!}
      onChoose={accountId => {
        setCreation(null)
        void resolve(creation.id, 'approve', accountId)
      }}
      onCancel={() => setCreation(null)}
    />
  )

  return { resolveAction, creationAccountModal }
}
