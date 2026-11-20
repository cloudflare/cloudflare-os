import { useSyncExternalStore } from 'react'
import { readMotionLevel, subscribeMotionLevel } from './motion'

/** How much the app moves, kept current as it is chosen. */
export const useMotionLevel = () => useSyncExternalStore(subscribeMotionLevel, readMotionLevel)
