// The browser half of the gatekeeper connect handoff (see `GatekeeperVendor.connectAccount` in
// workshop-shared). A connect URL is a bearer capability, so the Workshop opens it as a popup that
// keeps this window as its opener; when the flow finishes, the gatekeeper's page posts a single-use
// ticket back here, and redeeming it over our authenticated session is what activates the grant.

import { useEffect } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { CONNECT_HANDOFF_MESSAGE_TYPE } from '@gadgets/workshop-shared/gatekeeper'

/** Host the backend (and, through the router, every gatekeeper) is served from. */
export function getBackendHost(): string {
  // Only the Vite dev server is hosted separately from the backend. Built assets are served from
  // the same origin in both production and run-local mode.
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  }
  return window.location.host
}

/**
 * Origin the handoff message arrives from: the gatekeeper connect pages are served under
 * `/gatekeeper/*` on the backend host, so in production this is the Workshop's own origin.
 */
export function gatekeeperOrigin(): string {
  return `${window.location.protocol}//${getBackendHost()}`
}

const TICKET_PATTERN = /^[0-9a-f]{64}$/

/**
 * The ticket a `message` event carries, or null unless it came from the gatekeeper origin with a
 * well-formed handoff envelope. Shared by the connect listener and the sign-in buttons, so both apply
 * exactly the same checks.
 */
export function connectHandoffTicket(event: MessageEvent): string | null {
  if (event.origin !== gatekeeperOrigin()) return null
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return null
  const { type, ticket } = data as { type?: unknown; ticket?: unknown }
  if (type !== CONNECT_HANDOFF_MESSAGE_TYPE) return null
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return null
  return ticket
}

/**
 * Opens a connect / reconnect / ensure-resources URL as a popup that keeps this window as its
 * opener — the opener *is* the channel the completion ticket comes back on, so `noopener` (which
 * `noreferrer` implies) must not be used here. Throws when the browser blocked the popup.
 */
export function openConnectWindow(url: string): Window {
  // NB: with "noopener", window.open() returns null even on success, so a block would be
  // indistinguishable from a successful open.
  const popup = window.open(url, 'gadgets-connect', 'popup,width=520,height=680')
  if (!popup) throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
  return popup
}

/**
 * Listens for the ticket a connect popup posts to this window and redeems it on the user's
 * session. Only messages from the gatekeeper origin carrying a well-formed envelope are considered;
 * anything else is ignored silently. The popup is closed once the Workshop has accepted the ticket
 * (the page closes itself a moment later regardless). Security rests on the ticket being scoped to
 * the user who started the flow, not on which window sent it, so a Workshop tab that reloaded
 * mid-flow (and has no popup handle) still completes.
 */
export function useConnectHandoffListener(
  authenticatedApi: RpcStub<AuthenticatedApi>,
  onError: (message: string) => void,
): void {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const ticket = connectHandoffTicket(event)
      if (ticket === null) return
      const source = event.source
      authenticatedApi.completeConnectHandoff(ticket).then(
        () => { (source as Window | null)?.close?.() },
        (err: unknown) => { onError(err instanceof Error ? err.message : String(err)) },
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [authenticatedApi, onError])
}
