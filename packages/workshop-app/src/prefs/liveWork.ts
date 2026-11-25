import { flag, watched } from './watched'

const store = watched('workshop-app:live-work-open', flag, false)

/**
 * Always show thinking: whether what the agent is doing (its thinking, the code it runs) is shown while
 * it works on a reply, rather than only its status, and how each reply came about above it. A chat opens
 * or puts away its own by a click on the status without changing this.
 */
export const readLiveWorkOpen = store.read
export const writeLiveWorkOpen = store.write
export const subscribeLiveWorkOpen = store.subscribe
