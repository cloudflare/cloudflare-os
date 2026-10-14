import { useEffect, useRef, useState } from 'react'
import BrowserConnectHandoffPage from './BrowserConnectHandoffPage'
import { NATIVE_AUTH_KEY, nativeAuthRelay } from './features/native-app/authPopup'

// The external browser never receives the native WebView's authToken or flow nonce. It returns
// only the ticket and correlation id; the initiating WebView redeems them over its own session.
const ConnectHandoffPage = () => {
  const [relay] = useState(() => {
    try { return nativeAuthRelay(window.location.hash, sessionStorage.getItem(NATIVE_AUTH_KEY), Date.now()) }
    catch { return null }
  })
  const redirected = useRef(false)
  useEffect(() => {
    if (!relay || redirected.current) return
    redirected.current = true
    if (relay.record) sessionStorage.setItem(NATIVE_AUTH_KEY, relay.record)
    else sessionStorage.removeItem(NATIVE_AUTH_KEY)
    window.history.replaceState(window.history.state, '', window.location.pathname)
    window.location.replace(relay.destination)
  }, [relay])
  return relay ? <p role="status">Returning to Cloudflare OS…</p> : <BrowserConnectHandoffPage />
}

export default ConnectHandoffPage
