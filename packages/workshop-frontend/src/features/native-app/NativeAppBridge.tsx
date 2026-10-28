import { useEffect, useRef } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import { nativeApp } from './nativeApp'
import { useUnreadState } from '../notifications/UnreadStateBridge'
import { logRpcFailure } from '../../rpcErrors'

/** Reports an authenticated embedded-web-view session to the single versioned native bridge. */
export const NativeAppBridge = () => {
  const { currentUser, isCurrentUserConfirmed } = useAuthenticatedApi()
  const unread = useUnreadState()?.state
  // Legacy native bridge ordering is local to this web view, not stored in the User DO.
  const badgeRevision = useRef(0)

  useEffect(() => {
    if (!isCurrentUserConfirmed) return
    try {
      if (currentUser?.type === 'user') nativeApp()?.loginReady()
      else nativeApp()?.sessionEnded?.()
    } catch (cause) { logRpcFailure('Native session update failed:', cause) }
  }, [currentUser, isCurrentUserConfirmed])

  // Login confirmation precedes the first badge, even if the snapshot arrived before whoami.
  useEffect(() => {
    if (!isCurrentUserConfirmed || currentUser?.type !== 'user' || !unread) return
    try { nativeApp()?.unreadStateChanged?.({...unread, revision: ++badgeRevision.current}) }
    catch (cause) { logRpcFailure('Native unread-state update failed:', cause) }
  }, [currentUser, isCurrentUserConfirmed, unread])

  return null
}
