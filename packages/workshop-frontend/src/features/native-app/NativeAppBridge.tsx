import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import { nativeApp } from './nativeApp'
import { useUnreadState } from '../notifications/UnreadStateBridge'

/** Reports an authenticated embedded-web-view session to the single versioned native bridge. */
export const NativeAppBridge = () => {
  const { currentUser, isCurrentUserConfirmed } = useAuthenticatedApi()
  const unread = useUnreadState()?.state
  useEffect(() => {
    if (isCurrentUserConfirmed && currentUser?.type === 'user') nativeApp()?.loginReady()
  }, [currentUser, isCurrentUserConfirmed])

  // Login confirmation precedes the first badge, even if the snapshot arrived before whoami.
  useEffect(() => {
    if (!isCurrentUserConfirmed || currentUser?.type !== 'user' || !unread) return
    nativeApp()?.unreadStateChanged?.({unreadMessageCount: unread.unreadMessageCount})
  }, [currentUser, isCurrentUserConfirmed, unread])

  return null
}
