import { useEffect, useState } from 'react'

// What the aside, which is put away at the window's far edge and had back from it, is moved by
// (`SplitLayout`).

/**
 * The gap held open at the edge for the handle, with the pane away. Wider than the gap between
 * the cards, so that the handle stands clear of the page.
 */
export const EDGE_GAP = 24
/** Dragged shut, the pane is dimmed by this much to say that letting go closes it. */
export const CLOSING_DIM = 0.6
/**
 * A pointer that moved less than this between pressing the edge's handle and letting go only
 * clicked, which opens the pane.
 */
export const CLICK_SLOP = 4
/** The pane coming and going: setting off gently, rather than all at once. */
export const OPENING_TIMING = { type: 'spring', duration: 0.4, bounce: 0 } as const
// How long the edge's handle stays out after the pane is put away, counted from when it starts to go.
const HINT_TIME = 700

/**
 * Whether the edge's handle is out to show where the pane went: for a moment after it is put away.
 * Not after it was left as the page (`alone`): it was never at the edge to have gone there.
 */
export const useEdgeHint = (shown: boolean, alone = false) => {
  const [was, setWas] = useState({ shown, alone })
  const [hinting, setHinting] = useState(false)
  if (was.shown !== shown || was.alone !== alone) {
    setWas({ shown, alone })
    if (was.shown !== shown) setHinting(!shown && !was.alone)
  }
  useEffect(() => {
    if (!hinting) return
    const timer = setTimeout(() => setHinting(false), HINT_TIME)
    return () => clearTimeout(timer)
  }, [hinting])
  return hinting
}
