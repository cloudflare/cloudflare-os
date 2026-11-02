import { useSyncExternalStore } from 'react'
import { useAuthenticatedApi } from '../../../AuthContext'

/** How the workspaces of a space are laid out: as the flat list, or as the space's tree. */
export type SpaceViewMode = 'list' | 'tree'

const DEFAULT_MODE: SpaceViewMode = 'list'

const storageKey = (userId: string) => `space-view:${userId}`

// Choices the browser's storage refused (private browsing, a full quota, storage disabled), which
// hold for the rest of the session, and one made before the signed-in user is known, which has no
// key to be stored under and holds only until the user is: their own choice then applies.
const unsaved = new Map<string | null, SpaceViewMode>()
const listeners = new Set<() => void>()

const parseMode = (value: string | null): SpaceViewMode | undefined =>
  value === 'list' || value === 'tree' ? value : undefined

const readMode = (key: string | null): SpaceViewMode => {
  const pending = unsaved.get(key)
  if (pending) return pending
  if (key === null) return DEFAULT_MODE
  try {
    return parseMode(localStorage.getItem(key)) ?? DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

const storeMode = (key: string, mode: SpaceViewMode): boolean => {
  try {
    localStorage.setItem(key, mode)
    return true
  } catch {
    return false
  }
}

const writeMode = (key: string | null, mode: SpaceViewMode) => {
  if (key !== null && storeMode(key, mode)) unsaved.delete(key)
  else unsaved.set(key, mode)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // A choice made in another tab arrives as a storage event.
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/**
 * The view of a space's workspaces the signed-in user last chose, remembered in this browser for
 * that user, and the way to choose another. It is the list until they choose. A choice made before
 * the user is known lasts only until they are, and one the browser will not store still holds
 * until the page is reloaded.
 */
export const useSpaceViewMode = (): [SpaceViewMode, (mode: SpaceViewMode) => void] => {
  const { currentUser } = useAuthenticatedApi()
  const key = currentUser ? storageKey(currentUser.id) : null
  const mode = useSyncExternalStore(subscribe, () => readMode(key), () => DEFAULT_MODE)
  return [mode, (next) => writeMode(key, next)]
}
