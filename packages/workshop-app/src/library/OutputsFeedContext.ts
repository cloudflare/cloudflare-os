import { createContext, useContext, useSyncExternalStore } from 'react'
import { LOADING_OUTPUTS, type LibraryState, type OutputsFeed } from './OutputsFeed'

/** The library, live (`OutputsFeed`), for the whole app. */
export const OutputsFeedContext = createContext<OutputsFeed | null>(null)

const unsubscribed = () => () => {}
const loading = () => LOADING_OUTPUTS

/**
 * Everything the user's workspaces, and those shared with them, have made, most recently active
 * first; loading outside `OutputsFeedProvider`.
 */
export const useLibrary = (): LibraryState => {
  const store = useContext(OutputsFeedContext)
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.getSnapshot ?? loading).library
}
