import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './HeaderBubble.css'

export type HeaderBubbleProps<State> = {
  /**
   * What the bubble stands for. A page's header is its own, so going from one page to another
   * unmounts one bubble and mounts the next: when both have the same name the second carries on
   * from the first, and neither pops. Without a name a bubble always pops in and out.
   */
  name?: string
  /** How the bubble looks, for the one that carries on from it. */
  state?: State
  /** As a function, it is given the `state` of the bubble this one carries on from, if any. */
  children: ReactNode | ((previous: State | undefined) => ReactNode)
}

// The named bubbles on screen, each with the state it is in.
const onScreen = new Map<string, { state: unknown }>()

/**
 * Plays a bubble's leaving after React has removed it, on a copy left where it was. Called while
 * the bubble is still in the document.
 */
const popOut = (element: HTMLElement, name: string | undefined) => {
  const box = element.getBoundingClientRect()
  // By the middle of its left edge, which it scales from, so it is placed right even when it is
  // caught still popping in.
  const top = box.top + (box.height - element.offsetHeight) / 2
  const ghost = element.cloneNode(true) as HTMLElement
  // Once the commit that removes it is through, and the page replacing its own is in place.
  queueMicrotask(() => {
    // It was not removed after all, or another of its name has taken its place.
    if (element.isConnected || (name !== undefined && onScreen.has(name))) return
    ghost.inert = true
    ghost.dataset.bubble = 'leaving'
    Object.assign(ghost.style, { position: 'fixed', left: `${box.left}px`, top: `${top}px` })
    // First in the document, so that it is under the bubbles of the page that has replaced its own.
    document.body.prepend(ghost)
    // Settles at once when there is no animation, as with reduced motion.
    void Promise.allSettled(ghost.getAnimations().map(({ finished }) => finished)).then(() => ghost.remove())
  })
}

/** One of the rounded buttons a page's header is made of. It pops in when it appears and out when it goes. */
export const HeaderBubble = <State,>({ name, state, children }: HeaderBubbleProps<State>) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [predecessor] = useState(() => (name === undefined ? undefined : onScreen.get(name)))

  // Layout effects, so a bubble that is leaving can tell in the same commit that it is followed.
  useLayoutEffect(() => {
    if (name === undefined) return
    const entry = { state }
    onScreen.set(name, entry)
    return () => {
      if (onScreen.get(name) === entry) onScreen.delete(name)
    }
  }, [name, state])
  useLayoutEffect(() => {
    const element = ref.current!
    return () => popOut(element, name)
  }, [name])

  return (
    <span ref={ref} data-bubble={predecessor ? undefined : 'arriving'} className="header-bubble relative inline-flex">
      {typeof children === 'function' ? children(predecessor?.state as State | undefined) : children}
    </span>
  )
}
