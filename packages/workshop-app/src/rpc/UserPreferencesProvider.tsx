import { useLayoutEffect, useState, type ReactNode } from 'react'
import { UserPreferences } from '@/prefs/UserPreferences'
import { UserPreferencesContext } from '@/prefs/UserPreferencesContext'
import { useApi } from './ApiContext'

/**
 * Keeps what the user last chose in the app live for everything beneath it (`usePreferences`): one
 * subscription for the whole app, made again on each new connection without clearing what is shown.
 */
export const UserPreferencesProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [preferences] = useState(() => new UserPreferences())
  // Attach before descendants' passive effects make changes (an output opened), including on the first mount.
  useLayoutEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    preferences.start({
      subscribe: (listener) => api.subscribeToPreferences(listener),
      update: (update) => api.updatePreferences(update),
    })
    return () => preferences.stop()
  }, [api, reconnecting, preferences])
  return <UserPreferencesContext value={preferences}>{children}</UserPreferencesContext>
}
