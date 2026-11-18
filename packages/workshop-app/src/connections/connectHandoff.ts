// This app's half of the connect handoff (see `AuthenticatedApi.connectAccount` in workshop-shared,
// and `docs/connect-handoff.md`). A connect URL is a bearer capability, so it is opened in a popup
// that is disowned and carries the flow's nonce in its own sessionStorage. When the flow is over,
// the service's last page sends that popup to `/connect/handoff` on the Workshop's origin with a
// single-use ticket in the URL fragment, and the page there redeems ticket and nonce together
// over the popup's own session (`ConnectHandoffPane`). Redeeming is what connects the account.
// Signing in with a service ends the same way, but the popup has no session then: it confirms the
// ticket over the public API (`SignInHandoffPane`), and the window that started it collects the
// token (`GatekeeperSignIn`).
//
// Ported from `workshop-frontend`'s `connectHandoff.ts`, without the native app's path.

import type { ConnectFlowStart } from '@gadgets/workshop-shared/api'

const HEX_256 = /^[0-9a-f]{64}$/

/**
 * Where the popup's sessionStorage has what it was opened for. As `workshop-frontend` has it, so
 * that either app's handoff page can finish a flow the other started on the same origin.
 */
export const HANDOFF_KEY = 'gadgets.handoff'

/**
 * What the popup is given before it is sent on its way: which kind of flow it is (connecting an
 * account, or signing in), and its nonce.
 */
export type PopupHandoff = { kind: 'connect' | 'login'; nonce: string }

/**
 * The ticket a handoff page's URL fragment carries (`location.hash`, with or without its `#`,
 * percent-encoded or not), or null unless it is 64 lowercase hex characters.
 */
export const ticketFromHandoffFragment = (hash: string): string | null => {
  let ticket: string
  try {
    ticket = decodeURIComponent(hash.startsWith('#') ? hash.slice(1) : hash)
  } catch {
    return null
  }
  return HEX_256.test(ticket) ? ticket : null
}

/** What a popup was given, from how it was kept, or null for anything else. */
export const parsePopupHandoff = (raw: string | null): PopupHandoff | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, nonce } = parsed as { kind?: unknown; nonce?: unknown }
  return (kind === 'connect' || kind === 'login') && typeof nonce === 'string' && HEX_256.test(nonce) ? { kind, nonce } : null
}

/**
 * What this window was given when it was opened as a popup, which is taken as it is read, so that
 * it is used once here as it is on the server. Null when there is nothing, or storage cannot be read.
 */
export const readPopupHandoff = (): PopupHandoff | null => {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY)
    sessionStorage.removeItem(HANDOFF_KEY)
    return parsePopupHandoff(raw)
  } catch {
    return null
  }
}

// A name no popup this origin still has open can have. One counted up from zero would start over
// with the page, while a popup from before, left on a service's page, keeps its name, and
// `window.open('', thatName)` gives that window back. Not `crypto.randomUUID()`, which a page
// that is not served securely does not have.
const popupName = (kind: PopupHandoff['kind']) => `gadgets-${kind}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`

/**
 * Opens a flow that ends on `/connect/handoff` in a popup that holds the flow's nonce and nothing
 * else of this window, and returns the popup.
 *
 * The popup is opened empty (an `about:blank` of this origin, so its sessionStorage is ours to
 * write), disowned, given the nonce, and only then sent to `url`, so that no page of the flow ever
 * has `window.opener`: a flow can pass through pages the deployment does not vouch for, and one
 * with a handle on this window could send it to a page made to look like the app. The nonce is in
 * the popup's storage, not this window's, so that a handoff link opened any other way has none and
 * redeems nothing.
 *
 * Disowned by hand rather than with `noopener`, with which `window.open()` returns null whether it
 * opened or was blocked. Throws when the popup was blocked, or its storage could not be written:
 * the flow could not be finished, so it is not started.
 */
export const openHandoffWindow = (url: string, handoff: PopupHandoff): Window => {
  const popup = window.open('', popupName(handoff.kind), 'popup,width=520,height=680')
  if (!popup) throw new Error('The pop-up was blocked. Allow pop-ups for this site and try again.')
  popup.opener = null
  try {
    popup.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  } catch {
    popup.close()
    const what = handoff.kind === 'login' ? 'sign-in' : 'connection'
    throw new Error(`This browser keeps nothing for pop-ups, so the ${what} could not be finished. Allow site data for this site and try again.`)
  }
  popup.location.replace(url)
  return popup
}

// The connect popup opened last, closed before the next opens, or it is left behind it on a service's page.
let lastPopup: Window | undefined

/**
 * Opens a connect, reconnect or more-access flow (`openHandoffWindow`). The account arrives here
 * through `subscribeConnectedAccounts()` once the popup has redeemed its ticket.
 */
export const openConnectWindow = (flow: ConnectFlowStart) => {
  try {
    lastPopup?.close()
  } catch {
    // Already gone.
  }
  lastPopup = openHandoffWindow(flow.url, { kind: 'connect', nonce: flow.nonce })
}
