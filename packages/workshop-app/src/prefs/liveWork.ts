import { flag, watched } from './watched'

const store = watched('workshop-app:live-work-open', flag, false)

/**
 * Whether what the agent is doing (its thinking, the code it runs) is shown while it works on a
 * reply, rather than only its status. Kept for every chat alike, until it is put away or brought
 * back by a click on the status.
 */
export const readLiveWorkOpen = store.read
export const writeLiveWorkOpen = store.write
export const subscribeLiveWorkOpen = store.subscribe
