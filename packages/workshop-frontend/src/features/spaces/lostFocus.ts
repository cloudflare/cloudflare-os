import { useEffect, useEffectEvent, useState } from 'react'

/**
 * Gives `element` the focus when nothing has it: when what had it has left the page, as the
 * button an action was started from does when the action replaces the page or the part of it
 * the button was in. Focus the user has put anywhere else stays where it is.
 */
export const takeLostFocus = (element: HTMLElement | null) => {
  const focused = document.activeElement
  if (!focused || focused === document.body || !focused.isConnected) element?.focus()
}

/**
 * For a control that its own action may take away, as a `Try again` goes once the read works
 * and a member's `Remove` goes with the member. The function returned is called when the action
 * has settled. After the render that follows, `restore` runs once, to give the focus the
 * control had to something that is still there (see `takeLostFocus`, which leaves focus the
 * user has put elsewhere where it is). The control is gone by that render when what takes it
 * away was set before the action settled; one that goes later still has the focus then, and
 * nothing is restored.
 */
export const useFocusAfterAction = (restore: () => void): (() => void) => {
  const [settled, setSettled] = useState(0)
  const restoreFocus = useEffectEvent(restore)
  useEffect(() => {
    if (settled > 0) restoreFocus()
  }, [settled])
  return () => setSettled(count => count + 1)
}
