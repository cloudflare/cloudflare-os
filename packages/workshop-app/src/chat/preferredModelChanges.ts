const listeners = new Set<() => void>()

/**
 * Says that the user chose another model to answer by default, so that a page that read it when it
 * opened (`useDefaultModel`) reads it again: its next message goes to the one chosen, wherever
 * that was chosen, not only after another page is opened.
 */
export const preferredModelChanged = () => {
  for (const listener of listeners) listener()
}

/** Calls `onChange` each time another model is chosen. Returns the way to stop. */
export const subscribePreferredModelChanges = (onChange: () => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
