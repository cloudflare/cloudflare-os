import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AgentsWaiting, WorkspaceWaiting } from './AgentsWaiting'

/** What in each workspace is waiting on a person: its agents' runs and its chats (`AgentsWaiting`). */
export const AgentsWaitingContext = createContext<AgentsWaiting | null>(null)

const NONE: ReadonlyMap<string, WorkspaceWaiting> = new Map()
const unsubscribed = () => () => {}
const none = () => NONE

/** What waits in each workspace that has said, by its id; nothing outside the provider. */
export const useAgentsWaiting = (): ReadonlyMap<string, WorkspaceWaiting> => {
  const store = useContext(AgentsWaitingContext)
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.snapshot ?? none)
}

/** Where an open workspace says what in it waits, as it changes. */
export const useReportAgentsWaiting = () => useContext(AgentsWaitingContext)
