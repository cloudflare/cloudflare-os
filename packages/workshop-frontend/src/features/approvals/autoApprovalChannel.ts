import { useCallback, useRef, useState } from 'react'

/**
 * How the surfaces that can change a workspace's auto-approval rules tell each other.
 *
 * Each surface reads the rule list through its own `useAutoApproval`, so a change made in one is
 * invisible to the others until they re-read. That matters beyond keeping lists in step: the
 * kernel starts a drain the moment it accepts a rule (`setAutoApprovedActionKind` ends in a
 * `waitUntil` on the drain), well before any surface has re-read anything. For that window the
 * tray's bulk run would see a request as its own manual gate while a drain is already applying
 * it, race the drain there, and stop on the workspace's refusal.
 *
 * So the window itself has to be visible, not only its end. A run that knows a change is in
 * flight gives the drain its turn on anything a rule could cover, exactly as it does when the
 * rule list cannot be read at all.
 *
 * This covers changes made in this browser view. A rule a collaborator enables is still learned
 * only on the next read, so a run can still race the drain to one of its requests; the workspace
 * refuses the run's decision there, and the run stops.
 */
export interface AutoApprovalChannel {
  /**
   * Bumped when a change has settled, whichever way it went, so other surfaces re-read the rule
   * list. A failed change leaves the rules in a state nobody here knows either.
   */
  reloadTrigger: number
  /** Whether a change is in flight, during which no surface's rule list is current. */
  changing: boolean
  /**
   * Marks a change in flight. Call the returned function when the server call has settled,
   * whichever way it went: a failed one leaves the rules in a state nobody here knows either.
   */
  begin: () => () => void
}

/** Holds the channel for one workspace view, which is the scope these surfaces share. */
export function useAutoApprovalChannel(): AutoApprovalChannel {
  const [{ reloadTrigger, inFlight }, setState] = useState({ reloadTrigger: 0, inFlight: 0 })
  // Pairs each begin with exactly one end, so a double call cannot leave the count stuck above
  // zero -- which would read as "a change is in flight" for the life of the view.
  const ended = useRef(new WeakSet<object>())

  const begin = useCallback(() => {
    const token = {}
    setState(previous => ({ ...previous, inFlight: previous.inFlight + 1 }))
    return () => {
      if (ended.current.has(token)) return
      ended.current.add(token)
      setState(previous => ({
        reloadTrigger: previous.reloadTrigger + 1,
        inFlight: previous.inFlight - 1,
      }))
    }
  }, [])

  return { reloadTrigger, changing: inFlight > 0, begin }
}
