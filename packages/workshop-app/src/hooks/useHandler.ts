import { useLayoutEffect, useRef, useState } from 'react'

/**
 * `handler`, as one function that stays the same for as long as the component is there and calls
 * whichever `handler` it was last rendered with. For what is handed to a block that is memoized, or
 * drawn once for many renders, so that a new closure each render does not draw it again. Only for
 * what is called from an event or an effect: called while rendering, it would still be the last
 * render's.
 */
export const useHandler = <Args extends unknown[], Result>(handler: (...args: Args) => Result) => {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  const [stable] = useState(() => (...args: Args) => latest.current(...args))
  return stable
}
