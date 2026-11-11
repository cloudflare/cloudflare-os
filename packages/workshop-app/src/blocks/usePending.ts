import { useState } from 'react'

/** What a block's `on<Action>` may return: a promise keeps its controls waiting until it settles. */
export type ActionResult = void | Promise<void>

/**
 * Runs an action and reports whether it is still in flight, so the controls that started it can be
 * held until the answer is in and a second click cannot repeat it.
 */
export const usePending = () => {
  const [pending, setPending] = useState(false)
  const run = (action: () => ActionResult) => {
    const result = action()
    if (!(result instanceof Promise)) return
    setPending(true)
    void result.finally(() => setPending(false))
  }
  return [pending, run] as const
}
