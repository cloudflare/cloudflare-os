import { useMotionLevel } from './useMotionLevel'

/**
 * Whether nothing should move: the person turned motion off, or has not chosen and their system
 * asks for it. Use this, not `motion/react`'s, which hears only of the system.
 */
export const useReducedMotion = () => useMotionLevel() === 'off'
