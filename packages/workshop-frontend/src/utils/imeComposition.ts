import type {KeyboardEvent as ReactKeyboardEvent} from 'react'

// True while an input method editor is composing text — e.g. the Enter that commits a Japanese
// kana-kanji conversion, or the arrow keys that pick a candidate. Those keystrokes belong to the
// IME, so handlers that treat Enter as "submit" must ignore them, or the first conversion in a
// message sends it half-written.
//
// `isComposing` covers modern browsers; keyCode 229 is the legacy signal some IMEs still emit for
// keydown during composition (notably Safari, where `isComposing` can be false on the commit key).
export function isComposingKeyEvent(
    event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || native.keyCode === 229
}
