import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AgentsWaiting } from './AgentsWaiting'

/** How many of each workspace's agents' runs are waiting on a person (`AgentsWaiting`). */
export const AgentsWaitingContext = createContext<AgentsWaiting | null>(null)

const NONE: ReadonlyMap<string, number> = new Map()
const unsubscribed = () => () => {}
const none = () => NONE

/** How many runs wait in each workspace that has said, by its id; none outside the provider. */
export const useAgentsWaiting = (): ReadonlyMap<string, number> => {
  const store = useContext(AgentsWaitingContext)
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.snapshot ?? none)
}

/** Where an open workspace says how many of its runs wait, as it changes. */
export const useReportAgentsWaiting = () => useContext(AgentsWaitingContext)
