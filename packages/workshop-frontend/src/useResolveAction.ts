import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { serializeException } from '@gadgets/error-reporting'
import type { RpcStub } from 'capnweb'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'
import { copyToClipboard } from './clipboard'

type ActionDecision = 'approve' | 'deny'

/** Build bounded diagnostics without copying arbitrary properties attached to the error. */
export function actionErrorDiagnostics(
  error: unknown,
  context: Readonly<{ actionId: number, decision: ActionDecision }>,
): string {
  return JSON.stringify({
    operation: `${context.decision}-action`,
    actionId: context.actionId,
    error: serializeException(error),
  }, null, 2)
}

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async function resolveAction(actionId: number, decision: ActionDecision) {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      const diagnostics = actionErrorDiagnostics(error, { actionId, decision })
      const toastId = toasts.add({
        title: `Failed to ${decision} action`,
        variant: 'error',
        actions: [{
          children: 'Try again',
          size: 'sm',
          variant: 'primary',
          onClick: () => {
            toasts.close(toastId)
            return resolveAction(actionId, decision)
          },
        }, {
          children: 'Copy error details',
          size: 'sm',
          variant: 'secondary',
          onClick: async () => {
            const copied = await copyToClipboard(diagnostics)
            toasts.add(copied
              ? { title: 'Error details copied', variant: 'success' }
              : { title: 'Could not copy error details', variant: 'error' })
          },
        }],
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
