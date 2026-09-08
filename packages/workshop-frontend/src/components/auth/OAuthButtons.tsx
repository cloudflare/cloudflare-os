import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { Button, Banner } from '@cloudflare/kumo'
import { connectHandoffTicket } from '../../connectHandoff'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking opens the gatekeeper's
 * OAuth popup with this window as its opener; when the flow finishes, the popup posts a handoff
 * ticket back here, which is redeemed over RPC for the session token. The ticket is what ties the
 * session to this browser: the sign-in URL alone can be finished by anyone (see connectHandoff.ts).
 * On success the token is stored and the app re-authenticates.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // Track the pop-up-poll interval, the handoff listener, the in-flight login RPC, and mounted state
  // so we can stop a sign-in attempt that's still running if the component unmounts (e.g. the user
  // navigates away mid-login): clear the poller and listener, dispose the RPC (Cap'n Web treats this
  // as a best-effort cancel and frees the client-side pending call), and avoid updating state on an
  // unmounted component.
  const pollRef = useRef<number | null>(null)
  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const loginRpcRef = useRef<Disposable | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (listenerRef.current) {
        window.removeEventListener('message', listenerRef.current)
        listenerRef.current = null
      }
      if (loginRpcRef.current) {
        try { loginRpcRef.current[Symbol.dispose]() } catch { /* already settled/disposed */ }
        loginRpcRef.current = null
      }
    }
  }, [])

  if (vendors.length === 0) return null

  const start = async (vendorId: string) => {
    setError(null)
    setPending(vendorId)
    try {
      const { url, attempt } = await rpcStub.startGatekeeperLogin(vendorId)
      if (!mountedRef.current) {
        // Unmounted while the RPC was in flight: the cleanup above has already run, so nothing may
        // be opened or registered now.
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
        return
      }
      // `attempt` is the capability to redeem the session token; track it so we can dispose it if
      // the component unmounts mid-login.
      loginRpcRef.current = attempt as unknown as Disposable
      // Unlike account-connect popups (see openConnectWindow), a login popup deliberately keeps this
      // window as its opener: sign-in providers are admin-allowlisted, and the opener is both how the
      // ticket comes back (postMessage) and what lets us watch for the user closing the popup. Don't
      // pass "noopener" — window.open() returns null with it, indistinguishable from a pop-up block.
      const popup = window.open(url, 'gatekeeper-login', 'popup,width=520,height=680')
      if (!popup) {
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
        loginRpcRef.current = null
        throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
      }
      // Resolve once the popup posts its ticket and the claim succeeds, or reject if the user closes
      // the pop-up first.
      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        const stopPolling = () => {
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
        }
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          stopPolling()
          if (listenerRef.current) {
            window.removeEventListener('message', listenerRef.current)
            listenerRef.current = null
          }
          try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already settled */ }
          loginRpcRef.current = null
          fn()
        }
        pollRef.current = window.setInterval(() => {
          if (popup.closed) finish(() => reject(new Error('Sign-in was cancelled.')))
        }, 500)
        const onMessage = (event: MessageEvent) => {
          // Unlike the connect listener, this page holds the popup handle, so a ticket from any
          // other window (say, an account-connect popup that outlived a logout) is not ours: claiming
          // it would only burn this attempt.
          if (event.source !== popup) return
          const ticket = connectHandoffTicket(event)
          if (ticket === null) return
          // The popup closes itself shortly after posting; that is no longer a cancellation.
          stopPolling()
          attempt.claim(ticket)
            .then(t => finish(() => resolve(t)))
            .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
        }
        listenerRef.current = onMessage
        window.addEventListener('message', onMessage)
      })
      popup.close()
      if (!mountedRef.current) return  // user navigated away mid-flow; drop the result
      localStorage.setItem('authToken', token)
      if (onSuccess) onSuccess()
      else window.location.reload()
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Could not sign in')
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner variant="error" title={error} />}
      {vendors.map((vendor) => (
        <Button
          key={vendor.vendorId}
          variant="secondary"
          onClick={() => start(vendor.vendorId)}
          loading={pending === vendor.vendorId}
          disabled={pending !== null}
          className="w-full justify-center"
        >
          {vendor.logo && (
            <img
              src={vendor.logo.url}
              alt=""
              className="mr-1"
              style={{ height: 18, width: 'auto' }}
            />
          )}
          Continue with {vendor.displayName}
        </Button>
      ))}
    </div>
  )
}
