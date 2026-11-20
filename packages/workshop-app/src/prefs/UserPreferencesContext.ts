import { createContext, useContext, useSyncExternalStore } from 'react'
import { UserPreferences } from './UserPreferences'

/** What the user last chose in the app (`UserPreferences`), for the whole app. */
export const UserPreferencesContext = createContext<UserPreferences | null>(null)

// Outside `UserPreferencesProvider` (the gallery, the scripted chats): never started, so it stays
// empty and keeps no change.
const DETACHED = new UserPreferences()

/**
 * What the user last chose in the app, to change through `change` and read in handlers through
 * `getSnapshot`; for render, `usePreferencesSnapshot`. Empty, and keeping nothing, outside
 * `UserPreferencesProvider`.
 */
export const usePreferences = (): UserPreferences => useContext(UserPreferencesContext) ?? DETACHED

/** What the user last chose in the app, live: empty until the account has said. */
export const usePreferencesSnapshot = () => {
  const preferences = usePreferences()
  return useSyncExternalStore(preferences.subscribe, preferences.getSnapshot)
}
