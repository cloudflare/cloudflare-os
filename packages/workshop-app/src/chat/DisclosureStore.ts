import { useMemo, useSyncExternalStore } from 'react'

const SEPARATOR = '\u0000'

/**
 * Which of a chat's rows are open. Kept outside the rows themselves, because the message list
 * unmounts rows far off screen and a row must come back the way it was left.
 */
export class DisclosureStore {
  #open = new Set<string>()
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  isOpen = (key: string) => this.#open.has(key)

  toggle = (key: string) => {
    if (!this.#open.delete(key)) this.#open.add(key)
    this.#listeners.forEach((listener) => listener())
  }
}

/** The open ones among `keys`. The caller renders again only when that set changes. */
export const useOpenKeys = (store: DisclosureStore, keys: readonly string[]): ReadonlySet<string> => {
  const open = useSyncExternalStore(store.subscribe, () => keys.filter(store.isOpen).join(SEPARATOR))
  return useMemo(() => new Set(open ? open.split(SEPARATOR) : []), [open])
}
