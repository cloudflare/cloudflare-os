import type { Transition } from 'motion/react'
import { readMotionLevel, type MotionLevel } from './motion'

/**
 * `transition` as `level` has it: as written for `full`; for `calm`, a spring that settles
 * without overshooting, over the same time; for `off`, over at once.
 */
export const resolveTransition = (transition: Transition, level: MotionLevel): Transition => {
  if (level === 'full') return transition
  if (level === 'off') return { duration: 0 }
  if (transition.type !== 'spring') return transition
  const { stiffness, damping, mass = 1 } = transition
  if (stiffness === undefined && damping === undefined) return { ...transition, bounce: 0 }
  // Springs given by their forces are critically damped, the least that does not overshoot.
  return { ...transition, damping: 2 * Math.sqrt((stiffness ?? 100) * mass) }
}

/** `transition` as the level now in force has it, for animations started from an event or an effect. */
export const motionTransition = (transition: Transition) => resolveTransition(transition, readMotionLevel())
