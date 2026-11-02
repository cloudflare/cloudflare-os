/**
 * Gives `element` the focus when nothing has it: when what had it has left the page, as the
 * button an action was started from does when the action replaces the page or the part of it
 * the button was in. Focus the user has put anywhere else stays where it is.
 */
export const takeLostFocus = (element: HTMLElement | null) => {
  const focused = document.activeElement
  if (!focused || focused === document.body || !focused.isConnected) element?.focus()
}
