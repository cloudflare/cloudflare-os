import { useEffect, useState } from 'react'

// What the panes that are put away at an edge of the window, and had back from it, share
// (`SplitLayout`'s aside, `AppShell`'s sidebar).

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

/** Whether the edge's handle is out to show where the pane went: for a moment after it is put away. */
export const useEdgeHint = (shown: boolean) => {
  const [wasShown, setWasShown] = useState(shown)
  const [hinting, setHinting] = useState(false)
  if (wasShown !== shown) {
    setWasShown(shown)
    setHinting(!shown)
  }
  useEffect(() => {
    if (!hinting) return
    const timer = setTimeout(() => setHinting(false), HINT_TIME)
    return () => clearTimeout(timer)
  }, [hinting])
  return hinting
}
