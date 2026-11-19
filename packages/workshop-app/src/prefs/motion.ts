import { isRecord, stored } from './stored'

/**
 * How much the app moves: springs with some bounce, the same motion without the bounce, or
 * nothing but what appears and goes at once.
 */
export type MotionLevel = 'full' | 'calm' | 'off'

export const MOTION_LEVELS: readonly MotionLevel[] = ['full', 'calm', 'off']

const store = stored<{ level: MotionLevel } | undefined>(
  'workshop-app:motion',
  (value) => (isRecord(value) && MOTION_LEVELS.includes(value.level as MotionLevel) ? { level: value.level as MotionLevel } : undefined),
  undefined,
)

const system = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined

/** What the person chose on this device, if they have: until then the system's reduce-motion setting decides. */
export const readMotionChoice = () => store.read()?.level

/** The level in force: the choice, or `off` where the system asks for reduced motion, or else `full`. */
export const readMotionLevel = (): MotionLevel => readMotionChoice() ?? (system?.matches ? 'off' : 'full')

/** Whether nothing should move, for code that has no React to ask `useMotionLevel`. */
export const isMotionOff = () => readMotionLevel() === 'off'

const listeners = new Set<() => void>()

// The level also stands on the root, for CSS to key off (`:root[data-motion='off']`).
const apply = () => {
  document.documentElement.dataset.motion = readMotionLevel()
  for (const listener of listeners) listener()
}

/** Keeps the level for this device and has the page take it on now. */
export const writeMotionLevel = (level: MotionLevel) => {
  store.write({ level })
  apply()
}

/** Calls `onChange` when the level may have changed: a new choice here, in another tab, or in the system. */
export const subscribeMotionLevel = (onChange: () => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Puts the level on the root and keeps it in step. Call once, before anything is drawn. */
export const watchMotionLevel = () => {
  apply()
  system?.addEventListener('change', apply)
  addEventListener('storage', apply)
}
