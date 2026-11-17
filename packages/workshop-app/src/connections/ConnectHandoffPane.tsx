import { useEffect, useRef, useState } from 'react'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useApi } from '@/rpc/ApiContext'
import { readPopupHandoff, ticketFromHandoffFragment } from './connectHandoff'

/** What the page says once it is known how it went. `failed` is a redemption that was turned down, or never arrived. */
type Outcome = { title: string; detail: string; failed?: true }

const INVALID: Outcome = { title: 'This link isn’t valid', detail: 'Go back to the app and start connecting again.' }
const DONE: Outcome = { title: 'Connected', detail: 'You can close this window.' }

/**
 * The page a connect popup ends on, with its single-use ticket in the URL fragment. It redeems the
 * ticket with the flow's nonce, which only this popup has: what the app's window wrote into its
 * sessionStorage before sending it on its way (`openConnectWindow`) is readable again here, back
 * on the app's origin, and nowhere else. A handoff link opened any other way has no nonce, and is
 * said to be invalid without the server being asked.
 *
 * It is redeemed over this popup's own session, signed in as any window of the app is, and the
 * account then reaches the window that started the flow through `subscribeConnectedAccounts()`.
 *
 * The fragment is taken off the address once read, and the nonce is taken as it is read, so
 * neither reloading nor rendering again presents the ticket twice. It is presented again only
 * after a redemption that failed, over the next connection to the backend: both are single-use
 * there, so if the first did arrive the second is turned down and changes nothing, and if it was
 * lost with the connection the second is the first the server hears of. Nowhere else says that a
 * ticket was turned down, so what the server says of it is shown as it is.
 */
export const ConnectHandoffPane = () => {
  const { api, reconnecting } = useApi()
  // Read once: reading the nonce takes it, and the fragment is taken off below.
  const [{ ticket, handoff }] = useState(() => ({ ticket: ticketFromHandoffFragment(window.location.hash), handoff: readPopupHandoff() }))
  const [result, setResult] = useState<Outcome>()
  // The connection's API the ticket was last presented over: once each, however often this renders.
  const sentWith = useRef<object>(null)
  useDocumentTitle('Connecting')

  // In an effect rather than while rendering: the router has its own hold on `replaceState`.
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])

  useEffect(() => {
    if (ticket === null || handoff === null || reconnecting) return
    if (sentWith.current === api) return
    if (sentWith.current !== null && !result?.failed) return
    sentWith.current = api
    setResult(undefined)
    api.completeConnectHandoff(ticket, handoff.nonce).then(
      () => {
        // A browser may not let a page close a window it did not open, which the page then says to do.
        window.close()
        setResult(DONE)
      },
      (error: unknown) => setResult({ title: 'Couldn’t finish connecting', detail: error instanceof Error ? error.message : String(error), failed: true }),
    )
  }, [ticket, handoff, api, reconnecting, result])

  // A failure while the connection is down is the connection's: it is presented again once that is back.
  const outcome = ticket === null || handoff === null ? INVALID : result?.failed && reconnecting ? undefined : result

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-medium text-kumo-default">{outcome?.title ?? 'Finishing up…'}</h1>
      {outcome && <p className="text-base text-kumo-subtle">{outcome.detail}</p>}
    </div>
  )
}
