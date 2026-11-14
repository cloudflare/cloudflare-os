import { useEffect, useState, type RefObject } from 'react'

// How long the scrollbars stay away after the last movement, in milliseconds. The system goes on
// showing a scrollbar for a while after what it scrolls last moved, so one let back sooner would
// come back showing, only to go again at the next movement or fade out by itself: a blink.
const LINGER = 1500

/**
 * For the element that `useScrollbarsAway` marks: no scrollbar in it is drawn while it is marked.
 * By colour, which is inherited and takes no room away, so nothing moves as they go and come back.
 */
export const SCROLLBARS_AWAY = 'data-scrollbars-away:[scrollbar-color:transparent_transparent]'

/** What keeps the scrollbars away. Each is stable. */
export type ScrollbarsAway = {
  /** The panes moved: by an animation, or under a handle. They stay away for a while after. */
  moved: () => void
  /** A handle was taken hold of. The scrollbars stay away until it is let go, moving or not. */
  hold: () => void
  release: () => void
  /**
   * The pointer has come into the gap between two panes, or has left it. There it is beside a
   * scrollbar without being after it. The scrollbars are back as soon as it leaves.
   */
  pointerInGap: (inside: boolean) => void
}

/**
 * Keeps scrollbars out of sight while panes are resized or slid away, and while the pointer is in
 * the gap between them. As a pane moves, what is in it is laid out again and scrolled to keep its
 * place, and the system shows the scrollbar for each of those scrolls; and it shows one for a
 * pointer that is merely beside it.
 *
 * Give `element`, which holds the panes, the `SCROLLBARS_AWAY` class.
 */
export const useScrollbarsAway = (element: RefObject<HTMLElement | null>): ScrollbarsAway => {
  const [away] = useState(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let held = false
    let inGap = false
    let lingering = false
    const mark = () => {
      const marked = element.current
      if (!marked) return
      if (held || inGap || lingering) marked.dataset.scrollbarsAway = ''
      else delete marked.dataset.scrollbarsAway
    }
    const moved = () => {
      lingering = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        lingering = false
        mark()
      }, LINGER)
      mark()
    }
    return {
      moved,
      hold: () => {
        held = true
        mark()
      },
      release: () => {
        held = false
        moved()
      },
      pointerInGap: (inside: boolean) => {
        inGap = inside
        mark()
      },
      stop: () => clearTimeout(timer),
    }
  })
  useEffect(() => away.stop, [away])
  return away
}
