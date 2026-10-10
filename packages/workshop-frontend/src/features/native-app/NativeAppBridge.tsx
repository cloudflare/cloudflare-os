import { useEffect } from 'react'
import { nativeApp } from './nativeApp'

/** Reports an authenticated embedded-web-view session to the single versioned native bridge. */
export const NativeAppBridge = () => {
  useEffect(() => {
    nativeApp()?.loginReady()
  }, [])

  return null
}
