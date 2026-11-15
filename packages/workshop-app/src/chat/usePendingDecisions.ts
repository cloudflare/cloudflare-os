import { useCallback, useRef, useState } from 'react'
import type { CreationAction } from '@/connections/ApproveCreation'
import type { ActionItem } from './chatItems'

export type Decision = 'approve' | 'deny'

/** A run of decisions under way: how far it has got. */
export type DecisionProgress = { verb: 'Approving' | 'Denying'; done: number; total: number }

export type PendingDecisionsOptions = {
  /** Approves or denies one, rejecting with why it did not go (`ChatSession.decideAction`). */
  decide: (actionId: number, decision: Decision) => Promise<void>
  /** Approves a creation, in the user's account; resolves to false when it asks which first. */
  approveCreation: (action: CreationAction) => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Decides `actions` one at a time, in the order a connection applies them: approving oldest first,
 * so an edit never lands before the one it builds on, and denying newest first, so a file's
 * creation is denied after the edits to it. A creation that asks which account to make it in
 * stops the run there, as what builds on it waits for it. Stops at the first that fails, and
 * resolves to why, naming it; to nothing once all went, or the run stopped to ask.
 */
export const decideInOrder = async (
  actions: readonly ActionItem[],
  decision: Decision,
  { decide, approveCreation }: PendingDecisionsOptions,
  onProgress: (progress: DecisionProgress) => void = () => {},
): Promise<string | undefined> => {
  const ordered = actions.toSorted((a, b) => (decision === 'approve' ? a.actionId - b.actionId : b.actionId - a.actionId))
  const verb = decision === 'approve' ? 'Approving' : 'Denying'
  for (const [done, action] of ordered.entries()) {
    // A single one says nothing of a run.
    if (ordered.length > 1) onProgress({ verb, done, total: ordered.length })
    try {
      if (decision === 'approve' && action.creation) {
        const made = await approveCreation({ actionId: action.actionId, gatekeeperId: action.creation.gatekeeperId, title: action.title })
        if (!made) return undefined
      } else {
        await decide(action.actionId, decision)
      }
    } catch (error) {
      return `Couldn’t ${decision} “${action.title}”: ${messageOf(error)}`
    }
  }
  return undefined
}

/**
 * Decides approvals as one run (`decideInOrder`), for the tray and the review beside the chat,
 * saying how far it has got (`progress`) and, when it stopped short, which failed and why
 * (`problem`), with the rest left waiting. One run at a time.
 */
export const usePendingDecisions = (options: PendingDecisionsOptions) => {
  const [progress, setProgress] = useState<DecisionProgress>()
  const [problem, setProblem] = useState<string>()
  const running = useRef(false)
  const { decide, approveCreation } = options

  const run = useCallback(async (actions: readonly ActionItem[], decision: Decision) => {
    if (running.current || actions.length === 0) return
    running.current = true
    setProblem(undefined)
    try {
      setProblem(await decideInOrder(actions, decision, { decide, approveCreation }, setProgress))
    } finally {
      running.current = false
      setProgress(undefined)
    }
  }, [decide, approveCreation])

  return { run, progress, problem, dismissProblem: useCallback(() => setProblem(undefined), []) }
}
