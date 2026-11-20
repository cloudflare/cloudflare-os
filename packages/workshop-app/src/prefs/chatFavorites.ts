import { useSyncExternalStore } from 'react'
import { stored, stringList } from './stored'

// As `workspaceId:chatId`, latest starred first.
const store = stored<string[]>('workshop-app:favorite-chats', stringList, [])
const listeners = new Set<() => void>()
let snapshot = store.read()

const changed = () => {
  snapshot = store.read()
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Starred in another tab too.
  if (listeners.size === 1) window.addEventListener('storage', changed)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', changed)
  }
}

const keyOf = (workspaceId: string, chatId: number) => `${workspaceId}:${chatId}`

/** With the chat starred, or no longer, as toggling it leaves it. */
export const withFavoriteToggled = (favorites: readonly string[], key: string): string[] =>
  favorites.includes(key) ? favorites.filter((each) => each !== key) : [key, ...favorites]

/**
 * The chats of a workspace the viewer starred on this device, which its list shows first, and the
 * way to star one or no longer. The server keeps no record of it.
 */
export const useChatFavorites = (workspaceId: string) => {
  const favorites = useSyncExternalStore(subscribe, () => snapshot)
  return {
    has: (chatId: number) => favorites.includes(keyOf(workspaceId, chatId)),
    toggle: (chatId: number) => {
      store.write(withFavoriteToggled(store.read(), keyOf(workspaceId, chatId)))
      changed()
    },
  }
}
