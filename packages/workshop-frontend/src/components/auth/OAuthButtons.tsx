import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { Button, Banner } from '@cloudflare/kumo'
import { openDisownedPopup, uniquePopupName } from '../../connectHandoff'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

// What an attempt's promise rejects with when it is torn down from outside (unmount, or a newer
// attempt) rather than failing: the caller then has no state to update.
const CANCELLED = Symbol('sign-in cancelled')

// How often the login attempt is asked whether its token has been released.
const RECEIVE_POLL_MS = 1000

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking starts a login attempt and
 * opens the gatekeeper's OAuth URL as a disowned popup carrying the attempt's nonce in its own
 * sessionStorage (see connectHandoff.ts). When the flow finishes, the gatekeeper's final page lands
 * the popup on our /connect/handoff page, which confirms the single-use ticket together with the
 * nonce over the public API. That confirmation is what ties the session to this browser: the
 * sign-in URL alone can be finished by anyone. This component meanwhile polls
 * `attempt.receive()`, which releases the session token only once the ticket is confirmed and only
 * to the holder of the `attempt` capability; the popup never sees the token. On success the token
 * is stored and the app re-authenticates.
 *
 * A newer attempt waits for the previous one's in-flight `receive()` before tearing it down: the
 * server releases the token exactly once, so a call cancelled mid-flight could discard a token
 * that had already been handed out, leaving the user to sign in twice.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // The attempt in flight, if any, as the function that tears it down: waits for a receive() still
  // in flight, then stops the poll and disposes the login RPC (Cap'n Web treats this as a
  // best-effort cancel and frees the client-side pending call). Resolves to whether the attempt
  // ended up receiving the token, in which case its own continuation completes the login. Run when
  // the component unmounts mid-login (e.g. the user navigates away) and when a new attempt starts,
  // so at most one attempt is ever polling.
  const attemptRef = useRef<(() => Promise<boolean>) | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void attemptRef.current?.()
      attemptRef.current = null
    }
  }, [])

  if (vendors.length === 0) return null

  const start = async (vendorId: string) => {
    // Disable the buttons at once, then let the previous attempt finish a receive() it may have in
    // flight: if that call releases the token, the previous attempt completes the login and this
    // one has nothing to do.
    setPending(vendorId)
    const previousReceived = await attemptRef.current?.()
    if (!mountedRef.current || previousReceived) return
    setError(null)
    setPending(vendorId)
    try {
      const { url, nonce, attempt } = await rpcStub.startGatekeeperLogin(vendorId)
      // `attempt` is the capability to receive the session token.
      const dispose = () => {
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
      }
      if (!mountedRef.current) {
        // Unmounted while the RPC was in flight: the cleanup above has already run, so nothing may
        // be opened or registered now.
        dispose()
        return
      }
      // Disowned like connect popups: sign-in providers are admin-allowlisted, but the popup
      // traverses provider pages all the same, and none of them gets a handle on this tab. The
      // nonce rides along in the popup's own storage for the handoff page to present.
      let popup: Window
      try {
        popup = openDisownedPopup(url, uniquePopupName('gatekeeper-login'), { kind: 'login', nonce })
      } catch (err) {
        dispose()
        throw err
      }
      // Resolve once the attempt releases the token; reject if it fails or is torn down.
      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        let received = false
        // The receive() call in flight, if any, as a promise that settles once its outcome has been
        // handled here; never rejects.
        let inflight: Promise<void> | null = null
        const poll = window.setInterval(() => {
          // Not necessarily a cancellation: the popup closes itself after confirming, and a
          // provider that swaps browsing context groups (COOP) reports it closed while the flow is
          // still running. So just hand the buttons back and keep polling. If the user really
          // closed it, nothing arrives: the poll ends with the next attempt, on unmount, or when
          // the attempt expires server-side, which then shows as the expiry error. The buttons
          // stay disabled while a receive() is in flight, though: a second click at that moment
          // would tear down a call the server may be answering with the token.
          if (popup.closed && inflight === null && mountedRef.current) setPending(null)
          // A receive() still in flight is not re-entered.
          if (inflight !== null) return
          inflight = attempt.receive()
            .then(t => {
              inflight = null
              if (t !== null) {
                received = true
                finish(() => resolve(t))
              }
            })
            .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
        }, RECEIVE_POLL_MS)
        function finish(fn: () => void) {
          if (settled) return
          settled = true
          attemptRef.current = null
          clearInterval(poll)
          dispose()
          fn()
        }
        attemptRef.current = async () => {
          await inflight
          if (!settled) finish(() => reject(CANCELLED))
          return received
        }
      })
      // Best-effort: the page closes itself anyway, and a COOP swap leaves the handle dead.
      try { popup.close() } catch { /* severed */ }
      if (!mountedRef.current) return  // user navigated away mid-flow; drop the result
      localStorage.setItem('authToken', token)
      if (onSuccess) onSuccess()
      else window.location.reload()
    } catch (err) {
      if (err === CANCELLED || !mountedRef.current) return
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
