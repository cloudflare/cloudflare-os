import { useSyncExternalStore } from 'react'
import { readLiveWorkOpen, subscribeLiveWorkOpen, writeLiveWorkOpen } from '@/prefs/liveWork'

/** Whether what the agent is doing is shown while it works, and the way to switch that. */
export const useLiveWorkOpen = () => [
  useSyncExternalStore(subscribeLiveWorkOpen, readLiveWorkOpen),
  writeLiveWorkOpen,
] as const
