/**
 * IMEs use Enter and arrow keys while composing candidate text. React exposes the standard
 * `isComposing` flag on the native keyboard event; keyCode 229 covers older browsers/WebViews
 * that only report the legacy "process key" value.
 */
export function isImeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}
