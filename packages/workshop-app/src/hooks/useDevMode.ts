import { useSyncExternalStore } from 'react'
import { readDevMode, subscribeDevMode } from '@/prefs/devMode'

/** Whether developer mode is on, kept current as it is switched. */
export const useDevMode = () => useSyncExternalStore(subscribeDevMode, readDevMode)
