import { useCallback, useState } from 'react'

/**
 * How the surfaces that can change a workspace's auto-approval rules tell each other to re-read.
 *
 * Each surface reads the rule list for itself, so a change made in one is invisible to the
 * others until they read again. The Activity pane is the one place a standing rule is turned
 * off, and the tray labels its requests from the same rules, so a list left stale in either
 * misstates what the kernel will apply.
 */
export interface AutoApprovalChannel {
  /** Bumped each time a change settles, so the other surfaces re-read the rule list. */
  reloadTrigger: number
  /**
   * Reports that a change has settled, whichever way it went: a call that failed may still have
   * landed, which leaves the rules in a state nobody here knows.
   */
  changed: () => void
}

/** Holds the channel for one workspace view, which is the scope these surfaces share. */
export function useAutoApprovalChannel(): AutoApprovalChannel {
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const changed = useCallback(() => setReloadTrigger(previous => previous + 1), [])
  return { reloadTrigger, changed }
}
