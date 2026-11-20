import { useSyncExternalStore } from 'react'
import { stringList } from './stored'
import { watched } from './watched'

const store = watched<string[]>('workshop-app:star-order', stringList, [])

// Kept, so that what is read is the same array until it changes.
let snapshot = store.read()
store.subscribe(() => {
  snapshot = store.read()
})

/**
 * The order the pinned workspaces were last put in on this device, as their ids. The server keeps
 * only whether each is pinned, so the order is this device's.
 */
export const readStarOrder = () => snapshot

/** Puts the pinned workspaces in another order, which whatever draws them (`useStarOrder`) follows. */
export const writeStarOrder = store.write

/** The pinned workspaces' order, as `readStarOrder`, kept in step wherever it is changed. */
export const useStarOrder = () => useSyncExternalStore(store.subscribe, readStarOrder)
