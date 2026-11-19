import { useSyncExternalStore } from 'react'
import { readMotionLevel, subscribeMotionLevel } from '@/prefs/motion'

/** How much the app moves, kept current as it is chosen. */
export const useMotionLevel = () => useSyncExternalStore(subscribeMotionLevel, readMotionLevel)
