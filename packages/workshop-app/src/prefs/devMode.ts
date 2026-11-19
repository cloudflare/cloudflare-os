import { writeLiveWorkOpen } from './liveWork'
import { flag, watched } from './watched'

const store = watched('workshop-app:developer-mode', flag, false)

/** Whether the app shows what is for those who build on it: the model, the context, costs, technical details. */
export const readDevMode = store.read
export const subscribeDevMode = store.subscribe

/**
 * Turns developer mode on or off for this device. Turning it on also opens what the agent is doing
 * while it works, once: from then on that is the viewer's to put away, as it is for anyone, and
 * turning developer mode off leaves it as it is.
 */
export const writeDevMode = (on: boolean) => {
  if (on && !store.read()) writeLiveWorkOpen(true)
  store.write(on)
}
