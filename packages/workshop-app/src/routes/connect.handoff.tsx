import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { readPopupHandoff, ticketFromHandoffFragment } from '@/connections/connectHandoff'
import { ConnectHandoffPane } from '@/connections/ConnectHandoffPane'
import { RpcGate } from '@/rpc/RpcGate'
import { SignInHandoffPane } from '@/rpc/SignInHandoffPane'
import { sharedConnection } from '@/rpc/sharedConnection'

/**
 * The ticket and the nonce are read once: reading the nonce takes it, and the fragment is taken
 * off the address, so neither reloading nor rendering again presents the ticket twice. A connect
 * is redeemed signed in; a sign-in, which has no session yet, is not.
 */
const HandoffPage = () => {
  const [{ ticket, handoff }] = useState(() => ({ ticket: ticketFromHandoffFragment(window.location.hash), handoff: readPopupHandoff() }))
  // In an effect rather than while rendering: the router has its own hold on `replaceState`.
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])
  return handoff?.kind === 'login' ? (
    <SignInHandoffPane connection={sharedConnection()} ticket={ticket} nonce={handoff.nonce} />
  ) : (
    <RpcGate connection={sharedConnection()}>
      <ConnectHandoffPane ticket={ticket} nonce={handoff?.nonce ?? null} />
    </RpcGate>
  )
}

/**
 * Where a connect or sign-in popup ends, on its own outside the app's frame. The service's last
 * page sends the popup here by this address, so it cannot be moved (see `docs/connect-handoff.md`).
 */
export const Route = createFileRoute('/connect/handoff')({
  component: HandoffPage,
})
