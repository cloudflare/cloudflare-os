import { useSyncExternalStore } from 'react'
import { HandoffMessage } from '@/blocks/HandoffMessage'
import { useHandoffRedemption, type HandoffOutcome } from '@/connections/useHandoffRedemption'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import type { Connection } from './Connection'

const INVALID: HandoffOutcome = { title: 'This link isn’t valid', detail: 'Go back to the app and sign in again.' }
const DONE: HandoffOutcome = { title: 'Signed in', detail: 'You can close this window.' }

export type SignInHandoffPaneProps = {
  connection: Connection
  /** The ticket the page's address carried, or null when it carried none. */
  ticket: string | null
  /** The nonce this popup was given when the sign-in was started (`GatekeeperSignIn`). */
  nonce: string
}

/**
 * The page a sign-in popup ends on. The popup has no session, so it confirms the ticket over the
 * public API (`confirmLogin`) with the nonce only it was given, and the window that started the
 * sign-in then collects the session token from its own attempt: this window never sees it.
 */
export const SignInHandoffPane = ({ connection, ticket, nonce }: SignInHandoffPaneProps) => {
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  useDocumentTitle('Signing in')
  const outcome = useHandoffRedemption({
    over: ticket === null ? null : publicApi,
    redeem: () => publicApi!.confirmLogin(ticket!, nonce),
    done: DONE,
    failed: 'Couldn’t sign in',
  })
  return <HandoffMessage outcome={ticket === null ? INVALID : outcome} />
}
