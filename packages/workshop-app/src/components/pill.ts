import { useSpring, useTransform, useVelocity, type MotionValue } from 'motion/react'

// The pills that are taken hold of and pulled, the divider's (`ResizeHandle`) and the header's
// bar (`Grabber`), look and answer alike.

/** How long the pill is with the pointer at the edge of where it shows, and right on it. */
export const IDLE_LENGTH = [12, 40] as const
/** How long it is held, likewise. */
export const HELD_LENGTH = [40, 52] as const
export const IDLE_OPACITY = 0.25
export const HELD_OPACITY = 0.7
/** Taken hold of, it springs out, and overshoots as it does. */
export const BOUNCY = { type: 'spring', mass: 0.7, stiffness: 500, damping: 18 } as const
export const SMOOTH = { duration: 0.2, bounce: 0 } as const

export const between = ([from, to]: readonly [number, number], amount: number) => from + (to - from) * amount

/**
 * 1 while the pointer moving a pill is still or slow, down to 0.5 as it goes faster: a pill
 * dragged fast lightens, so it does not smear across what it passes over.
 */
export const useCalm = (pointerX: MotionValue<number>, pointerY: MotionValue<number>) => {
  const velocityX = useVelocity(pointerX)
  const velocityY = useVelocity(pointerY)
  return useSpring(useTransform(() => Math.max(0.5, 1 - Math.hypot(velocityX.get(), velocityY.get()) / 5000)), SMOOTH)
}
