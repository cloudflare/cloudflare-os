import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import { nativeApp } from './nativeApp'
import { useUnreadState } from '../notifications/UnreadStateBridge'
import { logRpcFailure } from '../../rpcErrors'

/** Reports an authenticated embedded-web-view session to the single versioned native bridge. */
export const NativeAppBridge = () => {
  const { currentUser, isCurrentUserConfirmed } = useAuthenticatedApi()
  const unread = useUnreadState()?.state

  useEffect(() => {
    if (!isCurrentUserConfirmed) return
    if (currentUser?.type === 'user') nativeApp()?.loginReady()
    else nativeApp()?.sessionEnded?.()
  }, [currentUser, isCurrentUserConfirmed])

  // Login confirmation precedes the first badge, even if the snapshot arrived before whoami.
  useEffect(() => {
    if (!isCurrentUserConfirmed || currentUser?.type !== 'user' || !unread ||
        unread.unavailableWorkspaceIds?.length) return
    try { nativeApp()?.unreadStateChanged?.(unread) }
    catch (cause) { logRpcFailure('Native unread-state update failed:', cause) }
  }, [currentUser, isCurrentUserConfirmed, unread])

  return null
}
