import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Returns whether a React keyboard event belongs to an active IME composition. */
export function isImeComposing(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}
