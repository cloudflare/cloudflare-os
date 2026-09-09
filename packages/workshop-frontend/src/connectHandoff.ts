// The browser half of the gatekeeper connect handoff (see `GatekeeperVendor.connectAccount` in
// workshop-shared). A connect URL is a bearer capability, so the Workshop opens it as a popup; when
// the flow finishes, the gatekeeper's page delivers a single-use ticket back here — over a
// same-origin BroadcastChannel, or by postMessage to its opener where one is kept — and redeeming it
// over our authenticated session is what activates the grant.

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
 * The ticket a handoff envelope carries, or null unless `data` is a well-formed one. Origin is the
 * caller's business: a `message` event's must be checked (`connectHandoffTicket`), a BroadcastChannel
 * is same-origin by construction.
 */
export function parseHandoffEnvelope(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, ticket } = data as { type?: unknown; ticket?: unknown }
  if (type !== CONNECT_HANDOFF_MESSAGE_TYPE) return null
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return null
  return ticket
}

/**
 * The ticket a `message` event carries, or null unless it came from the gatekeeper origin with a
 * well-formed handoff envelope. Shared by the connect listener and the sign-in buttons, so both apply
 * exactly the same checks.
 */
export function connectHandoffTicket(event: MessageEvent): string | null {
  if (event.origin !== gatekeeperOrigin()) return null
  return parseHandoffEnvelope(event.data)
}

/**
 * Opens a connect / reconnect / ensure-resources URL as a popup. The popup is opened empty, disowned,
 * and only then navigated, so the provider's pages never hold `window.opener`: a connect flow can
 * land on pages the deployment does not vouch for — notably an MCP server the user pasted — and an
 * opener handle would let such a page navigate this authenticated tab to a phishing page (reverse
 * tabnabbing). Disowning is done by hand rather than with the `noopener` feature because that makes
 * `window.open()` return null even on success, which is indistinguishable from a pop-up block. The
 * completion page reaches us over a same-origin BroadcastChannel instead (`useConnectHandoffListener`).
 *
 * Under the Vite dev server the Workshop and the gatekeepers are on different origins, so a channel
 * could not reach us; there the popup keeps its opener and the page falls back to `postMessage`. A
 * provider that isolates its pages with COOP severs that opener too, and no channel crosses origins,
 * so such a connect ends in dev on "couldn't reach the Workshop"; production is unaffected, the
 * popup being disowned there anyway. Throws when the browser blocked the popup.
 */
export function openConnectWindow(url: string): Window {
  const popup = window.open('', 'gadgets-connect', 'popup,width=520,height=680')
  if (!popup) throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
  if (gatekeeperOrigin() === window.location.origin) popup.opener = null
  markConnectPending()
  popup.location.replace(url)
  return popup
}

/**
 * Set in this tab's `sessionStorage` by `openConnectWindow`, so `useConnectHandoffListener` knows a
 * broadcast ticket is one this tab asked for. Per-tab and reload-stable, which is exactly the scope
 * wanted: the tab that opened the popup redeems, its siblings stay quiet.
 */
const CONNECT_PENDING_KEY = 'gadgets.connectPending'

// Storage can be unavailable (a disabled cookie jar, a sandboxed frame); every access degrades to
// today's behaviour of redeeming whatever arrives rather than failing the connect.
function markConnectPending(): void {
  try { sessionStorage.setItem(CONNECT_PENDING_KEY, '1') } catch { /* fall back to redeeming all */ }
}

function hasPendingConnect(): boolean {
  try { return sessionStorage.getItem(CONNECT_PENDING_KEY) !== null } catch { return true }
}

function clearPendingConnect(): void {
  try { sessionStorage.removeItem(CONNECT_PENDING_KEY) } catch { /* nothing to clear */ }
}

/**
 * Listens for the ticket a connect popup delivers and redeems it on the user's session. Two
 * transports are watched: a BroadcastChannel named `CONNECT_HANDOFF_MESSAGE_TYPE` (a disowned popup
 * on our own origin; the browser scopes the channel to that origin) and `message` events from the
 * gatekeeper origin (a popup that kept its opener, as under the dev server). Only well-formed
 * envelopes are considered; anything else is ignored silently. A popup that posted is closed once
 * the Workshop has accepted the ticket; a broadcast has no source, so that page closes itself.
 *
 * Security rests on the ticket being scoped server-side to the user who started the flow, not on
 * which window sent it. The `sessionStorage` marker `openConnectWindow` sets only decides *which of
 * that user's tabs* redeems a broadcast: the one that opened the popup, surviving a reload, since
 * the storage is per-tab and reload-stable; its siblings stay silent instead of racing it and
 * toasting "expired". A connect whose tab was closed expires and is revoked like an abandoned one.
 * A phished handoff page opened directly in the victim's own browser broadcasts to
 * tabs none of which holds a marker, so nothing even reaches the server; a `message` event needs no
 * marker, its source being the popup this tab itself holds.
 *
 * Pass `null` to listen for nothing: a ticket must be redeemed exactly once, so only one listener may
 * be live per window (see `ConnectHandoffListener` and the blueprint page).
 */
export function useConnectHandoffListener(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
  onError: (message: string) => void,
): void {
  useEffect(() => {
    if (!authenticatedApi) return
    const redeem = (ticket: string, source: Window | null) => {
      authenticatedApi.completeConnectHandoff(ticket).then(
        () => { source?.close?.() },
        (err: unknown) => { onError(err instanceof Error ? err.message : String(err)) },
      )
    }
    const onMessage = (event: MessageEvent) => {
      const ticket = connectHandoffTicket(event)
      if (ticket !== null) redeem(ticket, event.source as Window | null)
    }
    window.addEventListener('message', onMessage)
    const channel = 'BroadcastChannel' in globalThis
      ? new BroadcastChannel(CONNECT_HANDOFF_MESSAGE_TYPE)
      : null
    channel?.addEventListener('message', (event: MessageEvent) => {
      const ticket = parseHandoffEnvelope(event.data)
      if (ticket === null || !hasPendingConnect()) return
      // One connect, one redemption: the marker is spent whether or not the server accepts.
      clearPendingConnect()
      redeem(ticket, null)
    })
    return () => {
      window.removeEventListener('message', onMessage)
      channel?.close()
    }
  }, [authenticatedApi, onError])
}
