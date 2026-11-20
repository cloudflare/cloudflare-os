/**
 * How much an app moves: springs with some bounce, the same motion without the bounce, or
 * nothing but what appears and goes at once.
 */
export type MotionLevel = 'full' | 'calm' | 'off'

export const MOTION_LEVELS: readonly MotionLevel[] = ['full', 'calm', 'off']

/** Where the level in force comes from, and how to hear that it may have changed. */
export type MotionLevelSource = {
  read: () => MotionLevel
  subscribe: (onChange: () => void) => () => void
}

const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined

/** The system's reduce-motion setting as a level: `off` where it asks for reduced motion, else `full`. */
export const systemMotionLevel: MotionLevelSource = {
  read: () => (reduce?.matches ? 'off' : 'full'),
  subscribe: (onChange) => {
    reduce?.addEventListener('change', onChange)
    return () => reduce?.removeEventListener('change', onChange)
  },
}

// Module state rather than React context: what moves is also decided outside React, by a dialog's
// glide, a header bubble's slide and a menu's easing, which read the level as they run.
let source = systemMotionLevel

/**
 * Has the level come from `next` from now on, such as a choice the person made in the app's
 * settings. Call once, before anything is drawn. Until then it is the system's (`systemMotionLevel`).
 */
export const provideMotionLevel = (next: MotionLevelSource) => {
  source = next
}

/** The level in force. */
export const readMotionLevel = (): MotionLevel => source.read()

/** Calls `onChange` when the level may have changed. */
export const subscribeMotionLevel = (onChange: () => void) => source.subscribe(onChange)

/** Whether nothing should move, for code that has no React to ask `useMotionLevel`. */
export const isMotionOff = () => readMotionLevel() === 'off'

/**
 * Puts the level on the root (`:root[data-motion]`), which the CSS keys off, and keeps it in step.
 * Call once, before anything is drawn, after `provideMotionLevel` where there is one.
 */
export const watchMotionLevel = () => {
  const apply = () => {
    document.documentElement.dataset.motion = readMotionLevel()
  }
  apply()
  return subscribeMotionLevel(apply)
}
