import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'
import { useConnectionLost, useRpcStub } from './RpcContext'
import { useAuth } from './useAuth'
import { readPopupHandoff, ticketFromHandoffFragment } from './connectHandoff'

/**
 * What the page tells the user once the outcome is known: a heading and one line of detail.
 * `failed` marks a redemption the server or the transport rejected, as opposed to one that never
 * reached the server (INVALID, SIGNED_OUT) or succeeded.
 */
type Outcome = { title: string; detail: string; failed?: true }

const INVALID: Outcome = {
  title: "This link isn't valid",
  detail: 'Reload the Workshop and start the connection again.',
}
const SIGNED_OUT: Outcome = {
  title: "You're signed out",
  detail: 'Sign in to the Workshop and start the connection again.',
}
const CLOSE_HINT = 'You can close this window.'

/**
 * The page a finished connect / sign-in popup lands on (HANDOFF_PATH), with the single-use ticket
 * in the URL fragment. It redeems the ticket together with the flow's nonce, which only this popup
 * holds: sessionStorage is per top-level browsing context and per origin, so what the Workshop tab
 * wrote into this popup before navigating it (`openDisownedPopup`) is readable again here, after
 * the trip through the gatekeeper and the provider, and nowhere else. A handoff link opened any
 * other way carries no nonce and is reported invalid without a call to the server.
 *
 * A connect is redeemed over this popup's own authenticated session (`completeConnectHandoff`),
 * established like any Workshop tab's (the shared 'authToken', or the Cloudflare Access identity
 * in an Access deployment); the account then reaches the tab that started the flow through
 * `subscribeConnectedAccounts()`. A sign-in popup has no session:
 * it confirms the ticket over the public API (`confirmLogin`), and the login tab collects the token
 * from its own `LoginAttempt`. The page therefore runs standalone, outside the app shell and
 * without waiting on the root's auth, with its own `useAuth` for the connect case.
 *
 * The fragment is stripped once read, and the storage record is spent as it is read, so neither a
 * reload nor a re-render can present the ticket twice. The one repeat is deliberate: a redemption
 * that failed is presented again over the next session, when the RPC connection has been replaced
 * after an outage (`main.tsx` swaps the stub once per reconnect, and `useAuth` re-authenticates on
 * it). That is safe because ticket and nonce are single-use server-side: if the first call did
 * reach the server, the repeat is refused as expired and changes nothing; if it died with the
 * socket, the repeat is the first the server hears of it. This page is the only surface a rejected
 * ticket is reported on, so the server's message is shown verbatim.
 */
export default function ConnectHandoffPage() {
  const rpcStub = useRpcStub()
  const connectionLost = useConnectionLost()
  const { authenticatedApi, isLoading } = useAuth(rpcStub)
  // Read once: the storage record is consumed by reading it, and the fragment is stripped below.
  const [{ ticket, handoff }] = useState(() => ({
    ticket: ticketFromHandoffFragment(window.location.hash),
    handoff: readPopupHandoff(),
  }))
  const [result, setResult] = useState<Outcome | null>(null)
  // The session the ticket was last presented over. It is presented at most once per session,
  // whatever re-renders or StrictMode replays, and again over a new session only if the previous
  // presentation failed.
  const sentWithRef = useRef<RpcStub<AuthenticatedApi> | RpcStub<PublicApi> | null>(null)

  // In an effect rather than during render: the router patches replaceState.
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])

  useEffect(() => {
    if (ticket === null || handoff === null) return
    let api: RpcStub<AuthenticatedApi> | RpcStub<PublicApi>
    let redeem: () => Promise<void>
    let done: Outcome
    let failed: string
    if (handoff.kind === 'connect') {
      if (isLoading || authenticatedApi === null) return
      api = authenticatedApi
      redeem = () => authenticatedApi.completeConnectHandoff(ticket, handoff.nonce)
      done = { title: 'Connected', detail: CLOSE_HINT }
      failed = 'Could not complete the connection'
    } else {
      api = rpcStub
      redeem = () => rpcStub.confirmLogin(ticket, handoff.nonce)
      done = { title: 'Signed in', detail: CLOSE_HINT }
      failed = 'Could not sign in'
    }
    if (sentWithRef.current === api) return
    if (sentWithRef.current !== null && !result?.failed) return
    sentWithRef.current = api
    setResult(null)
    redeem().then(
      () => {
        // Browsers may refuse to close a window a script did not open; the hint covers that.
        window.close()
        setResult(done)
      },
      (err: unknown) => {
        setResult({
          title: failed,
          detail: err instanceof Error ? err.message : String(err),
          failed: true,
        })
      },
    )
  }, [ticket, handoff, isLoading, authenticatedApi, rpcStub, result])

  let outcome = result
  if (ticket === null || handoff === null) outcome = INVALID
  // A failure while the connection is down is the socket's, not the server's: the redemption is
  // presented again once the session is back, so show the wait rather than a transient error.
  else if (outcome?.failed && connectionLost) outcome = null
  else if (outcome === null && handoff.kind === 'connect' && !isLoading && authenticatedApi === null) {
    outcome = SIGNED_OUT
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 bg-kumo-base p-6 text-center">
      <h1 className="text-lg font-semibold text-kumo-default">{outcome?.title ?? 'Finishing up…'}</h1>
      {outcome && <p className="text-sm text-kumo-subtle">{outcome.detail}</p>}
    </div>
  )
}
