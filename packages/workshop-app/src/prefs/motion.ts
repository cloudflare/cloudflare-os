import { MOTION_LEVELS, systemMotionLevel, type MotionLevel, type MotionLevelSource } from '@gadgets/ui'
import { isRecord, stored } from './stored'

const store = stored<{ level: MotionLevel } | undefined>(
  'workshop-app:motion',
  (value) => (isRecord(value) && MOTION_LEVELS.includes(value.level as MotionLevel) ? { level: value.level as MotionLevel } : undefined),
  undefined,
)

const listeners = new Set<() => void>()

/**
 * The level the person chose on this device, for `provideMotionLevel`: until they choose, the
 * system's reduce-motion setting decides. It may change with a new choice here, in another tab,
 * or in the system.
 */
export const chosenMotionLevel: MotionLevelSource = {
  read: () => store.read()?.level ?? systemMotionLevel.read(),
  subscribe: (onChange) => {
    listeners.add(onChange)
    const stopSystem = systemMotionLevel.subscribe(onChange)
    addEventListener('storage', onChange)
    return () => {
      listeners.delete(onChange)
      stopSystem()
      removeEventListener('storage', onChange)
    }
  },
}

/** Keeps the level for this device and has the page take it on now. */
export const writeMotionLevel = (level: MotionLevel) => {
  store.write({ level })
  for (const listener of listeners) listener()
}
