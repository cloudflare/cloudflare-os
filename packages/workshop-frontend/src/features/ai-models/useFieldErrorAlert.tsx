import { useState } from 'react'

/**
 * Makes a refused field's error heard. The error describes its field, so landing on the field
 * announces it. A field that already has focus fires no focus event, and its error is not a live
 * region, so its error is said by `alert` instead, which the form renders.
 */
export const useFieldErrorAlert = () => {
  // The error that focus could not announce, with the attempt that found it so that finding the
  // same error again says it again.
  const [unannounced, setUnannounced] = useState<{ error: string; attempt: number } | null>(null)
  return {
    /** Points at `field`, whose value was refused with `error`. */
    pointAt: (field: HTMLElement | null, error: string) => {
      if (field && field === document.activeElement) {
        setUnannounced((last) => ({ error, attempt: (last?.attempt ?? 0) + 1 }))
      } else {
        field?.focus()
      }
    },
    /** Drops the alert, as an edit to the form does. */
    clear: () => setUnannounced(null),
    /** The alert to render, while there is an error that focus could not announce. */
    alert: unannounced && (
      <p key={unannounced.attempt} role="alert" className="sr-only">
        {unannounced.error}
      </p>
    ),
  }
}
