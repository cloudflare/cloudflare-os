import { createContext, useContext, useSyncExternalStore } from 'react'
import type { SummariesSnapshot, WorkspaceSummaries } from './WorkspaceSummaries'

/** Every workspace's summary (`WorkspaceSummaries`), for the whole app. */
export const WorkspaceSummariesContext = createContext<WorkspaceSummaries | null>(null)

const UNKNOWN: SummariesSnapshot = { known: false, workspaces: new Map() }
const unsubscribed = () => () => {}
const unknown = () => UNKNOWN

/** Every workspace's summary, live; nothing known outside `WorkspaceSummariesProvider`. */
export const useWorkspaceSummaries = (): SummariesSnapshot => {
  const store = useContext(WorkspaceSummariesContext)
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.getSnapshot ?? unknown)
}
