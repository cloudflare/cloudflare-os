import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { serializeException } from '@gadgets/error-reporting'
import type { RpcStub } from 'capnweb'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'
import { copyToClipboard } from './clipboard'

type ActionDecision = 'approve' | 'deny'

const inFlightActions = new WeakMap<RpcStub<Overseer>, Set<number>>()

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  const currentOverseer = useRef<RpcStub<Overseer> | null>(overseer)
  const closeFailureToast = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    currentOverseer.current = overseer
    return () => {
      currentOverseer.current = null
      closeFailureToast.current?.()
    }
  }, [overseer])

  return useCallback(async function resolveAction(actionId: number, decision: ActionDecision) {
    if (currentOverseer.current !== overseer) return
    closeFailureToast.current?.()
    const inFlight = inFlightActions.get(overseer) ?? new Set<number>()
    if (inFlight.has(actionId)) return
    inFlightActions.set(overseer, inFlight)
    inFlight.add(actionId)

    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      if (currentOverseer.current !== overseer) return
      closeFailureToast.current?.()
      const diagnostics = JSON.stringify({
        operation: `${decision}-action`,
        actionId,
        error: serializeException(error),
      }, null, 2)
      const close = () => {
        toasts.close(toastId)
        closeFailureToast.current = undefined
      }
      const toastId = toasts.add({
        title: `Failed to ${decision} action`,
        variant: 'error',
        timeout: 0,
        actions: [{
          children: 'Try again',
          size: 'sm',
          variant: 'primary',
          onClick: () => {
            if (closeFailureToast.current !== close) return
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
      closeFailureToast.current = close
    } finally {
      inFlight.delete(actionId)
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
