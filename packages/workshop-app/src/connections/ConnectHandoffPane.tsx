import { HandoffMessage } from '@/blocks/HandoffMessage'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useApi } from '@/rpc/ApiContext'
import { useHandoffRedemption, type HandoffOutcome } from './useHandoffRedemption'

const INVALID: HandoffOutcome = { title: 'This link isn’t valid', detail: 'Go back to the app and start connecting again.' }
const DONE: HandoffOutcome = { title: 'Connected', detail: 'You can close this window.' }

export type ConnectHandoffPaneProps = {
  /** The ticket the page's address carried, or null when it carried none. */
  ticket: string | null
  /** The nonce this popup was given before it was sent on its way, or null when it was given none. */
  nonce: string | null
}

/**
 * The page a connect popup ends on, with its single-use ticket in the URL fragment. It redeems the
 * ticket with the flow's nonce, which only this popup has: what the app's window wrote into its
 * sessionStorage before sending it on its way (`openConnectWindow`) is readable again here, back
 * on the app's origin, and nowhere else. A handoff link opened any other way has no nonce, and is
 * said to be invalid without the server being asked.
 *
 * It is redeemed over this popup's own session, signed in as any window of the app is, and the
 * account then reaches the window that started the flow through `subscribeConnectedAccounts()`.
 * The route reads the ticket and the nonce, once (see `connect.handoff.tsx`).
 */
export const ConnectHandoffPane = ({ ticket, nonce }: ConnectHandoffPaneProps) => {
  const { api, reconnecting } = useApi()
  useDocumentTitle('Connecting')
  const outcome = useHandoffRedemption({
    over: ticket === null || nonce === null || reconnecting ? null : api,
    redeem: () => api.completeConnectHandoff(ticket!, nonce!),
    done: DONE,
    failed: 'Couldn’t finish connecting',
  })
  return <HandoffMessage outcome={ticket === null || nonce === null ? INVALID : outcome} />
}
