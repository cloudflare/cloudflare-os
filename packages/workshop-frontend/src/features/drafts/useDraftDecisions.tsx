import { useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { CreationApproval, Overseer } from '@gadgets/workshop-shared/api'
import { CreationAccountModal } from '../../components/CreationAccountModal'
import { rpcFailureDescription } from '../../rpcErrors'
import type { Draft } from './drafts'

export type DraftDecision = 'apply' | 'discard'

/** Where a run of decisions stands: going, stopped on a failure, or neither. */
export type DecisionRun =
  | { status: 'idle' }
  | { status: 'working'; decision: DraftDecision; done: number; total: number }
  | { status: 'failed'; decision: DraftDecision; done: number; total: number; failed: Draft; reason?: string; rest: Draft[] }

type CreationPrompt = { draft: Draft; resolve: (approval: CreationApproval | null) => void }

/**
 * Applies or discards drafts as one run. Applying goes oldest first, the order the connection
 * replays them in, so an edit never lands before the one it builds on; discarding goes newest
 * first, so a file's creation is discarded after the edits made to it. The run stops at the
 * first failure, which `retry` picks up from. A creation asks which account to make it in first.
 */
export const useDraftDecisions = (
  overseer: RpcStub<Overseer>,
  onDecided?: (draft: Draft, decision: DraftDecision) => void,
) => {
  const [run, setRun] = useState<DecisionRun>({ status: 'idle' })
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [creation, setCreation] = useState<CreationPrompt | null>(null)
  const running = useRef(false)
  const onDecidedRef = useRef(onDecided)
  onDecidedRef.current = onDecided

  const decide = async (drafts: readonly Draft[], decision: DraftDecision): Promise<boolean> => {
    if (running.current || drafts.length === 0) return false
    running.current = true
    const ordered = drafts.toSorted((a, b) => decision === 'apply' ? a.id - b.id : b.id - a.id)
    setBusy(new Set(ordered.map(draft => draft.id)))
    try {
      for (const [done, draft] of ordered.entries()) {
        setRun({ status: 'working', decision, done, total: ordered.length })
        try {
          if (decision === 'discard') {
            await overseer.rejectAction(draft.id)
          } else if (draft.creation) {
            const approval = await new Promise<CreationApproval | null>(resolve => setCreation({ draft, resolve }))
            setCreation(null)
            if (!approval) {
              setRun({ status: 'idle' })
              return false
            }
            await overseer.approveAction(draft.id, approval)
          } else {
            await overseer.approveAction(draft.id)
          }
        } catch (error) {
          console.error(`Failed to ${decision} a draft:`, error)
          setRun({
            status: 'failed', decision, done, total: ordered.length, failed: draft,
            reason: rpcFailureDescription(error), rest: ordered.slice(done),
          })
          return false
        }
        onDecidedRef.current?.(draft, decision)
        setBusy(previous => {
          const next = new Set(previous)
          next.delete(draft.id)
          return next
        })
      }
      setRun({ status: 'idle' })
      return true
    } finally {
      running.current = false
      setBusy(new Set())
    }
  }

  const retry = () => run.status === 'failed' ? decide(run.rest, run.decision) : Promise.resolve(false)
  const dismissFailure = () => setRun(current => current.status === 'failed' ? { status: 'idle' } : current)

  const creationAccountModal = creation && (
    <CreationAccountModal
      overseer={overseer}
      gatekeeperId={creation.draft.gatekeeperId!}
      onChoose={approval => creation.resolve(approval)}
      onCancel={() => creation.resolve(null)}
    />
  )

  return { run, busy, working: run.status === 'working', decide, retry, dismissFailure, creationAccountModal }
}

/** The decisions of one place drafts are decided (see useDraftDecisions). */
export type DraftDecisions = ReturnType<typeof useDraftDecisions>
