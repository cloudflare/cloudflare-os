import { nativeApp } from './nativeApp'

export const NATIVE_AUTH_EVENT = 'cloudflare-os:auth-popup'
export const NATIVE_AUTH_KEY = 'gadgets.nativeAuthPopup'
const START_PREFIX = '#native-auth='
// App-owned return endpoint, not an install URL. Other native clients must register their own
// callback with their shell and domain associations as well as changing this protocol constant.
const CALLBACK = 'https://os.cloudflare.app/authpopup'
const HEX = /^[0-9a-f]{64}$/
const LIFETIME = 30 * 60 * 1000

export type AuthPopup = Pick<Window, 'close' | 'closed'> & { completion?: Promise<void> }

const gatekeeperUrl = (value: string): URL => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== window.location.origin ||
      !url.pathname.startsWith('/gatekeeper/') || url.username || url.password) {
    throw new Error('Authentication must start at a gatekeeper on this install.')
  }
  return url
}

/** A browser relay carries only correlation state; the flow nonce and app session stay in-app. */
export const nativeAuthStartUrl = (url: string, id: string): string => {
  gatekeeperUrl(url)
  return `${window.location.origin}/connect/handoff${START_PREFIX}${encodeURIComponent(JSON.stringify({ id, url }))}`
}

/** Returns null in ordinary browsers or older native apps, preserving the desktop popup flow. */
export const openNativeAuthPopup = (
  url: string, complete: (ticket: string, signal: AbortSignal) => Promise<void>,
): AuthPopup | null => {
  const bridge = nativeApp()?.authentication
  if (!bridge) return null
  const id = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '')
  const startUrl = nativeAuthStartUrl(url, id)
  let closed = false
  const controller = new AbortController()
  let rejectCompletion: (error: Error) => void
  let timer: ReturnType<typeof setTimeout>
  const cleanup = () => {
    window.removeEventListener(NATIVE_AUTH_EVENT, receive)
    clearTimeout(timer)
    closed = true
  }
  const receive = (event: Event) => {
    const result: unknown = (event as CustomEvent).detail
    if (!result || typeof result !== 'object' || !('id' in result) || result.id !== id) return
    window.removeEventListener(NATIVE_AUTH_EVENT, receive)
    if ('ticket' in result && typeof result.ticket === 'string' && HEX.test(result.ticket)) {
      const ticket = result.ticket
      void Promise.resolve().then(() => complete(ticket, controller.signal))
        .then(resolveCompletion, rejectCompletion).finally(cleanup)
    } else {
      cleanup()
      rejectCompletion(new AuthPopupCancelledError())
    }
  }
  let resolveCompletion: () => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  window.addEventListener(NATIVE_AUTH_EVENT, receive)
  timer = setTimeout(() => {
    cleanup()
    controller.abort(new Error('Authentication expired. Please try again.'))
    try { bridge.close(id) } catch { /* Expiry must settle even if the native browser is already gone. */ }
    rejectCompletion(new Error('Authentication expired. Please try again.'))
  }, LIFETIME)
  try { bridge.open(id, startUrl) } catch (error) {
    cleanup()
    throw error
  }
  return {
    get closed() { return closed },
    close: () => {
      if (closed) return
      cleanup()
      controller.abort(new AuthPopupCancelledError())
      try { bridge.close(id) } catch { /* Closing the browser is best-effort; cancellation must settle. */ }
      rejectCompletion(new AuthPopupCancelledError())
    },
    completion,
  }
}

export type NativeAuthRelay = { destination: string; record: string | null }

/** Only the browser tab launched by native carries the state needed to return a handoff ticket. */
export const nativeAuthRelay = (hash: string, stored: string | null, now: number): NativeAuthRelay | null => {
  try {
    if (hash.startsWith(START_PREFIX)) {
      const data = JSON.parse(decodeURIComponent(hash.slice(START_PREFIX.length)))
      if (typeof data.id !== 'string' || !HEX.test(data.id) || typeof data.url !== 'string') return null
      const url = gatekeeperUrl(data.url)
      // Reconstruct from the trusted origin and validated gatekeeper path, not an arbitrary URL.
      return { destination: window.location.origin + url.pathname + url.search + url.hash,
        record: JSON.stringify({ id: data.id, expiresAt: now + LIFETIME }) }
    }
    if (!HEX.test(hash.slice(1)) || !stored) return null
    const data = JSON.parse(stored)
    if (typeof data.id !== 'string' || !HEX.test(data.id) ||
        typeof data.expiresAt !== 'number' || data.expiresAt <= now || data.expiresAt > now + LIFETIME) return null
    const fragment = new URLSearchParams({ id: data.id, ticket: hash.slice(1) })
    return { destination: `${CALLBACK}#${fragment}`, record: null }
  } catch { return null }
}

/** A user cancellation is not a gatekeeper failure and must not be sent to issue reporting. */
export class AuthPopupCancelledError extends Error {
  constructor() { super('Authentication was cancelled.'); this.name = 'AuthPopupCancelledError' }
}
