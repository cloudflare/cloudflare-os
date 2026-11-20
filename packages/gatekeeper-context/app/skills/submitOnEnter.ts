import type { KeyboardEvent } from 'react'

/**
 * What Enter in a one-line field of a dialog does: `submit`, as a form's would. The frame is
 * sandboxed without `allow-forms`, so a form there never fires `submit`; a dialog is a plain
 * element, its primary button calls `submit` on click, and this goes on the element around its
 * fields. Enter in several lines is a new line, and Enter while composing text finishes composing.
 */
export const submitOnEnter = (submit: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return
  event.preventDefault()
  submit()
}
