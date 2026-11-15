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

/** What deciding one needs of it: a chat's card has it, as does a gadget's request. */
export type DecidedAction = Pick<ActionItem, 'actionId' | 'title' | 'creation'>

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Decides `actions` one at a time, in the order a connection applies them: approving oldest first,
 * so an edit never lands before the one it builds on, and denying newest first, so a file's
 * creation is denied after the edits to it. A creation that asks which account to make it in
 * stops the run there, as what builds on it waits for it, and hands what is left to `resume`
 * for once it is made. Stops at the first that fails, and resolves to why, naming it; to nothing
 * once all went, or the run stopped to ask.
 */
export const decideInOrder = async <A extends DecidedAction>(
  actions: readonly A[],
  decision: Decision,
  { decide, approveCreation }: PendingDecisionsOptions,
  onProgress: (progress: DecisionProgress) => void = () => {},
  resume: (rest: A[]) => void = () => {},
): Promise<string | undefined> => {
  const ordered = actions.toSorted((a, b) => (decision === 'approve' ? a.actionId - b.actionId : b.actionId - a.actionId))
  const verb = decision === 'approve' ? 'Approving' : 'Denying'
  for (const [done, action] of ordered.entries()) {
    // A single one says nothing of a run.
    if (ordered.length > 1) onProgress({ verb, done, total: ordered.length })
    try {
      if (decision === 'approve' && action.creation) {
        const rest = ordered.slice(done + 1)
        const made = await approveCreation({
          actionId: action.actionId,
          gatekeeperId: action.creation.gatekeeperId,
          title: action.title,
          onMade: rest.length > 0 ? () => resume(rest) : undefined,
        })
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
 * (`problem`), with the rest left waiting. One run at a time; one that stopped to ask where a
 * creation goes carries on once it is made.
 */
export const usePendingDecisions = (options: PendingDecisionsOptions) => {
  const [progress, setProgress] = useState<DecisionProgress>()
  const [problem, setProblem] = useState<string>()
  const running = useRef(false)
  const { decide, approveCreation } = options

  const run = useCallback(async (actions: readonly DecidedAction[], decision: Decision): Promise<void> => {
    if (running.current || actions.length === 0) return
    running.current = true
    setProblem(undefined)
    try {
      // What builds on a creation that asked first is approved once it is made.
      const resume = (rest: DecidedAction[]) => void run(rest, 'approve')
      setProblem(await decideInOrder(actions, decision, { decide, approveCreation }, setProgress, resume))
    } finally {
      running.current = false
      setProgress(undefined)
    }
  }, [decide, approveCreation])

  return { run, progress, problem, dismissProblem: useCallback(() => setProblem(undefined), []) }
}
