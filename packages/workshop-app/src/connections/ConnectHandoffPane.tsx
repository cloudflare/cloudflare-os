import { useEffect, useRef, useState } from 'react'
import { CheckCircleIcon, LinkBreakIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useApi } from '@/rpc/ApiContext'
import { readPopupHandoff, ticketFromHandoffFragment } from './connectHandoff'

type Outcome = 'connected' | 'invalid' | { failed: string }

/**
 * The page a finished connect popup lands on (`HANDOFF_PATH`), with the single-use ticket in its
 * fragment. It redeems the ticket with the flow's nonce, which only this popup holds: what the tab
 * that opened it wrote into its sessionStorage, before sending it to the service, is readable
 * again here and nowhere else. A link to it opened any other way holds no nonce, and is said to be
 * no good without asking the server.
 *
 * It is redeemed over this popup's own session, signed in as any tab of the app is, and the
 * account then reaches the tab that started the flow as every account does. The ticket is read and
 * the fragment cleared at once, and the nonce is spent as it is read, so nothing can present them
 * twice, but for one repeat on purpose: one that failed is presented again over the next
 * connection, should the last one have dropped. That is safe, as the server spends both whether
 * the rest goes through or not.
 */
export const ConnectHandoffPane = () => {
  const { api, reconnecting } = useApi()
  const [{ ticket, handoff }] = useState(() => ({ ticket: ticketFromHandoffFragment(window.location.hash), handoff: readPopupHandoff() }))
  const [outcome, setOutcome] = useState<Outcome>()
  // The API it was last presented over, at most once each.
  const sentWith = useRef<unknown>(undefined)
  useDocumentTitle(outcome === 'connected' ? 'Connected' : 'Connecting')

  // In an effect: the router keeps its own record of the address.
  useEffect(() => window.history.replaceState(window.history.state, '', window.location.pathname), [])

  const valid = ticket !== null && handoff?.kind === 'connect'
  const failed = typeof outcome === 'object'
  useEffect(() => {
    if (!valid || reconnecting || sentWith.current === api || (sentWith.current !== undefined && !failed)) return
    sentWith.current = api
    api.completeConnectHandoff(ticket, handoff.nonce).then(
      () => {
        setOutcome('connected')
        // A browser may refuse to close what a script did not open; the page says it can be.
        window.close()
      },
      (error: unknown) => setOutcome({ failed: error instanceof Error ? error.message : String(error) }),
    )
  }, [valid, ticket, handoff, api, reconnecting, failed])

  const shown: Outcome | undefined = valid ? outcome : 'invalid'
  return (
    <div className="flex h-full flex-col">
      {shown === undefined || (failed && reconnecting) ? (
        <PaneNotice title="Finishing up…" />
      ) : shown === 'connected' ? (
        <PaneNotice icon={CheckCircleIcon} title="Connected" description="You can close this window." />
      ) : shown === 'invalid' ? (
        <PaneNotice icon={LinkBreakIcon} title="This link isn’t valid" description="Go back to the app and start connecting again." />
      ) : (
        <PaneNotice icon={WarningCircleIcon} title="Couldn’t finish connecting" description={shown.failed} />
      )}
    </div>
  )
}
