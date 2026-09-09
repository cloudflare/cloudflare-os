import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { CONNECT_HANDOFF_MESSAGE_TYPE } from '@gadgets/workshop-shared/gatekeeper'
import { Button, Banner } from '@cloudflare/kumo'
import { connectHandoffTicket, parseHandoffEnvelope } from '../../connectHandoff'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

// What an attempt's promise rejects with when it is torn down from outside (unmount, or a newer
// attempt) rather than failing: the caller then has no state to update.
const CANCELLED = Symbol('sign-in cancelled')

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking opens the gatekeeper's
 * OAuth popup with this window as its opener; when the flow finishes, the popup delivers a handoff
 * ticket back here, which is redeemed over RPC for the session token. The ticket is what ties the
 * session to this browser: the sign-in URL alone can be finished by anyone (see connectHandoff.ts).
 * On success the token is stored and the app re-authenticates.
 *
 * The ticket arrives over one of two transports. Normally the popup posts it to its opener. A
 * provider that isolates its pages with COOP severs that opener mid-flow, though (Google stages
 * this), and the handoff page then falls back to a same-origin BroadcastChannel — which reaches us
 * because in production the login page shares an origin with the handoff page. A broadcast has no
 * source to filter on, so a ticket heard there may be another tab's sign-in or an account-connect
 * ticket; the server answers such a claim with null, and we keep listening for ours.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // The attempt in flight, if any, as the function that tears it down: stops the popup poll, drops
  // both ticket listeners and disposes the login RPC (Cap'n Web treats this as a best-effort cancel
  // and frees the client-side pending call). Run when the component unmounts mid-login (e.g. the
  // user navigates away) and when a new attempt starts, so at most one attempt is ever listening.
  const attemptRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current?.()
      attemptRef.current = null
    }
  }, [])

  if (vendors.length === 0) return null

  const start = async (vendorId: string) => {
    attemptRef.current?.()
    attemptRef.current = null
    setError(null)
    setPending(vendorId)
    try {
      const { url, attempt } = await rpcStub.startGatekeeperLogin(vendorId)
      // `attempt` is the capability to redeem the session token.
      const dispose = () => {
        try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already disposed */ }
      }
      if (!mountedRef.current) {
        // Unmounted while the RPC was in flight: the cleanup above has already run, so nothing may
        // be opened or registered now.
        dispose()
        return
      }
      // Unlike account-connect popups (see openConnectWindow), a login popup deliberately keeps this
      // window as its opener: sign-in providers are admin-allowlisted, and the opener is how the
      // ticket normally comes back (postMessage). Don't pass "noopener" — window.open() returns null
      // with it, indistinguishable from a pop-up block.
      const popup = window.open(url, 'gatekeeper-login', 'popup,width=520,height=680')
      if (!popup) {
        dispose()
        throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
      }
      // Resolve once a ticket arrives and the claim succeeds; reject if the claim fails or the
      // attempt is torn down.
      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        let poll: number | null = null
        const channel = 'BroadcastChannel' in globalThis
          ? new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
          : null

        function stopPolling() {
          if (poll !== null) { clearInterval(poll); poll = null }
        }
        function finish(fn: () => void) {
          if (settled) return
          settled = true
          attemptRef.current = null
          stopPolling()
          window.removeEventListener('message', onMessage)
          channel?.close()
          dispose()
          fn()
        }
        // Claims may overlap: a foreign ticket answered with null must not hold up the real one
        // behind it, and `finish` settles only once.
        function claimTicket(ticket: string) {
          if (settled) return
          stopPolling()
          attempt.claim(ticket)
            .then(t => { if (t !== null) finish(() => resolve(t)) })
            .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
        }
        function onMessage(event: MessageEvent) {
          // Unlike the connect listener, this page holds the popup handle, so a ticket from any
          // other window (say, an account-connect popup that outlived a logout) is not ours: claiming
          // it would only burn this attempt.
          if (event.source !== popup) return
          const ticket = connectHandoffTicket(event)
          if (ticket !== null) claimTicket(ticket)
        }

        window.addEventListener('message', onMessage)
        channel?.addEventListener('message', (event: MessageEvent) => {
          const ticket = parseHandoffEnvelope(event.data)
          if (ticket !== null) claimTicket(ticket)
        })
        poll = window.setInterval(() => {
          if (!popup.closed) return
          // Not necessarily a cancellation: a provider that swaps browsing context groups (COOP)
          // reports the popup closed while the flow is still running, and its ticket will arrive over
          // the channel. So just hand the buttons back and keep listening; if the user really closed
          // it, nothing arrives and the attempt ends with the next one or on unmount.
          stopPolling()
          if (mountedRef.current) setPending(null)
        }, 500)
        attemptRef.current = () => finish(() => reject(CANCELLED))
      })
      // Best-effort: after a COOP swap the handle is dead, and the page closes itself anyway.
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
