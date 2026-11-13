import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
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
  /** For how the bubble sits in its header, e.g. that it may shrink. */
  className?: string
}

// The named bubbles on screen, each with the state it is in, and once it has gone, where it was.
const onScreen = new Map<string, { state: unknown; left?: number }>()

// Sliding to its place from where the bubble it carries on from was, in step with what it carries
// on doing there, such as the workspace crumb growing or drawing in its title (`duration-300 ease-out`).
const SLIDE = { duration: 300, easing: 'cubic-bezier(0, 0, 0.2, 1)' }

/**
 * Plays a bubble's leaving after React has removed it, on a copy left where it was. Called while
 * the bubble is still in the document.
 */
const popOut = (element: HTMLElement, name: string | undefined) => {
  // One that cannot be seen has nothing to show leaving, as when what it is in faded out first.
  if (element.checkVisibility?.({ opacityProperty: true }) === false) return
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
export const HeaderBubble = <State,>({ name, state, children, className }: HeaderBubbleProps<State>) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [predecessor] = useState(() => (name === undefined ? undefined : onScreen.get(name)))

  // Layout effects, so a bubble that is leaving can tell in the same commit that it is followed,
  // and where it was: its cleanup runs while it is still in the document.
  useLayoutEffect(() => {
    if (name === undefined) return
    const element = ref.current!
    const entry: { state: unknown; left?: number } = { state }
    onScreen.set(name, entry)
    return () => {
      entry.left = element.getBoundingClientRect().left
      if (onScreen.get(name) === entry) onScreen.delete(name)
    }
  }, [name, state])
  // Carrying on from one that was elsewhere along the header, such as where the page before had a
  // button ahead of it, it slides over rather than jumping. By `translate`, which leaves `scale`
  // to the popping.
  useLayoutEffect(() => {
    const from = predecessor?.left
    if (from === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const element = ref.current!
    const offset = from - element.getBoundingClientRect().left
    if (Math.abs(offset) < 1) return
    const slide = element.animate([{ translate: `${offset}px 0` }, { translate: '0 0' }], SLIDE)
    return () => slide.cancel()
  }, [predecessor])
  useLayoutEffect(() => {
    const element = ref.current!
    return () => popOut(element, name)
  }, [name])

  return (
    <span ref={ref} data-bubble={predecessor ? undefined : 'arriving'} className={cn('header-bubble relative inline-flex', className)}>
      {typeof children === 'function' ? children(predecessor?.state as State | undefined) : children}
    </span>
  )
}
