import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@gadgets/ui'
import { ShimmerText } from './ShimmerText'
import './ShimmerSwitchText.css'

export type ShimmerSwitchTextProps = {
  children: string
  /** Whether it shimmers, as `ShimmerText` does; otherwise the words are as they are. Defaults to true. */
  active?: boolean
  /**
   * Its colour, for the words, as `ShimmerText`'s. How long the new words take to come in
   * (`--fade-enter`, 240ms) and how long after the old begin to go they begin (`--fade-lag`, 60ms) are
   * set on something around it.
   */
  className?: string
  /** Cut what does not fit with an ellipsis, as `truncate` does, rather than let it run on. */
  truncate?: boolean
}

// How long the old words are kept while they go, with room to spare over how long they take.
const LEAVING_FOR = 400

/**
 * `ShimmerText` for words that change, such as a status or the label of a step: the old words fade out
 * and the new fade in, so that words that change are not a flicker. Quiet, with nothing moving and no
 * blur. Nothing plays as the first words are drawn, and with motion off the new words are simply there.
 */
export const ShimmerSwitchText = ({ children, active = true, className, truncate }: ShimmerSwitchTextProps) => {
  const root = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  // The words before these, kept for a moment while they go. Held with the words they were replaced
  // by, as that is when they are known: while it is rendered.
  const [shown, setShown] = useState({ text: children, leaving: undefined as string | undefined, round: 0 })
  if (children !== shown.text) setShown({ text: children, leaving: shown.text, round: shown.round + 1 })

  useEffect(() => {
    if (shown.leaving === undefined) return
    const timer = setTimeout(() => setShown((now) => (now.round === shown.round ? { ...now, leaving: undefined } : now)), LEAVING_FOR)
    return () => clearTimeout(timer)
  }, [shown.leaving, shown.round])

  // The shimmer of each set of words runs from when they were made, so the band would start again
  // with the new words, and with the old as they go. Starting every shimmer at the timeline's origin
  // keeps it where it was, whenever the words began.
  useLayoutEffect(() => {
    for (const animation of root.current?.getAnimations?.({ subtree: true }) ?? []) {
      if (animation instanceof CSSAnimation && animation.animationName === 'shimmer-text') animation.startTime = 0
    }
  }, [shown.text, shown.leaving, active])

  return (
    <span ref={root} data-first={shown.round === 0 || undefined} data-truncate={truncate || undefined} className="shimmer-switch">
      {/* Remade for each set of words, so that they come in again. */}
      <span key={shown.round} className="shimmer-switch-live">
        <ShimmerText active={active} className={className}>{shown.text}</ShimmerText>
      </span>
      {shown.leaving !== undefined && !reduced && (
        <span key={`gone:${shown.round}`} aria-hidden="true" className="shimmer-switch-leaving">
          <ShimmerText active={active} className={className}>{shown.leaving}</ShimmerText>
        </span>
      )}
    </span>
  )
}
