import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, ActionState, CreationApproval, Overseer,
} from '@gadgets/workshop-shared/api'
import { CreationAccountModal } from './components/CreationAccountModal'
import { isPush, reviewsBeforeApproving } from './features/approvals/pushApproval'
import { PushReviewDialog } from './features/push-review/PushReviewDialog'
import { rpcFailureDescription } from './rpcErrors'

type ActionDecision = 'approve' | 'deny'

/**
 * Returns `resolveAction` for an action's approve/deny controls and `reviewPush` for a push's
 * "Review commits", with two dialogs for the caller to render. `creationAccountModal`:
 * approving a creation first asks which account to create it in, and how. `pushReviewDialog`:
 * the commits and files a push will send.
 *
 * `restricted` says whether the workspace holds restricted data, and every caller has to say:
 * there, approving a push opens its review, which carries Approve and Deny, instead of
 * approving it. That holds whatever control the caller renders (see `reviewsBeforeApproving`
 * for a workspace whose mark is not known yet).
 */
export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  restricted: boolean | undefined,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  const [creation, setCreation] = useState<ActionLogEntry | null>(null)
  const [reviewing, setReviewing] = useState<ActionLogEntry | null>(null)

  const resolve = useCallback(async (
    actionId: number, decision: ActionDecision, approval?: CreationApproval,
  ) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId, approval)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      toasts.add({
        title: `Failed to ${decision} action`,
        description: rpcFailureDescription(error),
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

  const resolveAction = useCallback(async (action: ActionLogEntry, decision: ActionDecision) => {
    if (decision !== 'approve') await resolve(action.id, decision)
    else if (reviewsBeforeApproving(action, restricted)) setReviewing(action)
    else if (action.type === 'action' && action.creation) setCreation(action)
    else await resolve(action.id, decision)
  }, [resolve, restricted])

  const reviewPush = useCallback((action: ActionLogEntry) => {
    if (isPush(action)) setReviewing(action)
  }, [])

  const creationAccountModal = creation && (
    <CreationAccountModal
      overseer={overseer}
      gatekeeperId={creation.gatekeeperId!}
      onChoose={approval => {
        setCreation(null)
        void resolve(creation.id, 'approve', approval)
      }}
      onCancel={() => setCreation(null)}
    />
  )

  // A decision closes the dialog, so it never shows one in flight; the request's own controls,
  // back in view, do.
  const pushReviewDialog = reviewing && (
    <PushReviewDialog
      key={reviewing.id}
      overseer={overseer}
      record={reviewing}
      restricted={restricted === true}
      processing={false}
      onApprove={() => {
        setReviewing(null)
        void resolve(reviewing.id, 'approve')
      }}
      onReject={() => {
        setReviewing(null)
        void resolve(reviewing.id, 'deny')
      }}
      onClose={() => setReviewing(null)}
    />
  )

  return { resolveAction, reviewPush, creationAccountModal, pushReviewDialog }
}
