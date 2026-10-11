import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import { nativeApp } from './nativeApp'

/** Reports an authenticated embedded-web-view session to the single versioned native bridge. */
export const NativeAppBridge = () => {
  const { currentUser, isCurrentUserConfirmed } = useAuthenticatedApi()

  useEffect(() => {
    if (isCurrentUserConfirmed && currentUser?.type === 'user') nativeApp()?.loginReady()
  }, [currentUser, isCurrentUserConfirmed])

  return null
}
