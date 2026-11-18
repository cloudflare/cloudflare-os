import { stored, stringList } from './stored'

const store = stored<string[]>('workshop-app:star-order', stringList, [])

/**
 * The order the starred workspaces were last put in on this device, as their ids. The server keeps
 * only whether each is starred, so the order is this device's.
 */
export const readStarOrder = store.read

export const writeStarOrder = store.write
