import type { ConnectFlowStart } from '@gadgets/workshop-shared/api'

// The browser half of a connect flow's handoff (docs/connect-handoff.md), as `workshop-frontend`'s
// `connectHandoff.ts` has it, for a desktop browser. A connect URL is a bearer capability, so it is
// opened as a disowned popup that holds the flow's nonce in its own sessionStorage. The flow ends
// with that popup on HANDOFF_PATH here, the ticket in its fragment, and the handoff page redeems
// ticket and nonce together over the popup's own session. Only that activates the grant.
//
// The native shells' system-browser transport is not here: they load `workshop-frontend`.

/**
 * Path on this origin a finished connect popup lands on, with the ticket in the URL fragment.
 * gatekeeper-kit and `workshop-frontend` have the same literal; the backend sends the popup to the
 * deployment's `PUBLIC_BASE_URL`, so this app completes flows only where it is served from there.
 */
export const HANDOFF_PATH = '/connect/handoff'

/** sessionStorage key under which the opening tab writes a `PopupHandoff` into its popup. */
export const HANDOFF_KEY = 'gadgets.handoff'

/** Which kind of flow a popup runs, and the flow's nonce, which its handoff page presents with the ticket. */
export type PopupHandoff = { kind: 'connect' | 'login'; nonce: string }

const HEX_256 = /^[0-9a-f]{64}$/
const FEATURES = 'popup,width=520,height=680'

/**
 * The ticket a handoff URL's fragment carries (with or without its `#`, percent-encoded or not),
 * or nothing unless it is 64 lowercase hex characters.
 */
export const ticketFromHandoffFragment = (hash: string): string | null => {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash
  try {
    const ticket = decodeURIComponent(encoded)
    return HEX_256.test(ticket) ? ticket : null
  } catch {
    return null
  }
}

/**
 * The `PopupHandoff` the opening tab wrote into this document's sessionStorage, removed as it is
 * read, so that it is spent here as the ticket is on the server; or nothing, when there is none,
 * it is not one, or storage cannot be read.
 */
export const readPopupHandoff = (storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage): PopupHandoff | null => {
  let raw: string | null
  try {
    raw = storage.getItem(HANDOFF_KEY)
    storage.removeItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, nonce } = parsed as { kind?: unknown; nonce?: unknown }
  if ((kind !== 'connect' && kind !== 'login') || typeof nonce !== 'string' || !HEX_256.test(nonce)) return null
  return { kind, nonce }
}

/**
 * Opens `url` in a popup that holds `handoff` and nothing else of this tab. The popup is opened
 * empty (an about:blank of this origin, whose storage is this tab's to write), disowned, given the
 * nonce, and only then sent on its way, so no page in the flow ever holds `window.opener`, with
 * which a page the deployment does not vouch for could send this tab elsewhere. The nonce goes into
 * the popup's storage, never this tab's: a handoff link opened any other way holds none, and
 * redeems nothing. The `noopener` feature would do the disowning, but makes `window.open()` return
 * null even when it opened, which cannot be told from being blocked.
 *
 * Each popup needs a name no other has had: `window.open('', name)` with one still parked on a
 * provider's page hands that window back, unnavigated, and its storage is another origin's.
 *
 * Throws when the popup was blocked or its storage refused: without the nonce the flow could never
 * finish, so it is not started.
 */
export const openDisownedPopup = (url: string, handoff: PopupHandoff, name = `gadgets-connect-${crypto.randomUUID()}`): Window => {
  const popup = window.open('', name, FEATURES)
  if (!popup) throw new Error('The pop-up was blocked. Allow pop-ups for this site and try again.')
  popup.opener = null
  try {
    popup.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  } catch {
    popup.close()
    throw new Error('This browser blocks storage in pop-ups, so the connection can’t finish. Allow site data for this site and try again.')
  }
  popup.location.replace(url)
  return popup
}

// The connect popup this document opened last, closed before the next opens: one still parked on
// a provider's page would otherwise be left behind the new one.
let lastPopup: Window | undefined

/**
 * Opens a connect, reconnect or more-access flow (`connectAccount`, `reconnectAccount`,
 * `ensureAccountResources`) as a disowned popup with its nonce. The popup redeems the ticket
 * itself; the account arrives through `subscribeConnectedAccounts()`, as anywhere else.
 */
export const openConnectWindow = (flow: ConnectFlowStart) => {
  try {
    lastPopup?.close()
  } catch {
    // Already gone, or another origin's.
  }
  lastPopup = openDisownedPopup(flow.url, { kind: 'connect', nonce: flow.nonce })
}

