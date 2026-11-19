import type { Transition } from 'motion/react'
import { resolveTransition } from './motionTransition'
import { useMotionLevel } from './useMotionLevel'

/** `transition` as the level in force has it, for a `transition` prop. */
export const useMotionTransition = (transition: Transition) => resolveTransition(transition, useMotionLevel())
