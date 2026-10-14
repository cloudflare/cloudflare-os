import { nativeApp } from './nativeApp'

export const NATIVE_AUTH_EVENT = 'cloudflare-os:auth-popup'
export const NATIVE_AUTH_KEY = 'gadgets.nativeAuthPopup'
const START_PREFIX = '#native-auth='
const CALLBACK = 'https://os.cloudflare.app/authpopup'
const HEX = /^[0-9a-f]{64}$/
const LIFETIME = 30 * 60 * 1000

export type AuthPopup = Pick<Window, 'close' | 'closed'> & { completion?: Promise<void> }

const secureUrl = (value: string): URL => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid authentication URL.')
  return url
}

/** A browser relay carries only correlation state; the flow nonce and app session stay in-app. */
export const nativeAuthStartUrl = (url: string, id: string): string => {
  secureUrl(url)
  return `${window.location.origin}/connect/handoff${START_PREFIX}${encodeURIComponent(JSON.stringify({ id, url }))}`
}

/** Returns null in ordinary browsers or older native apps, preserving the desktop popup flow. */
export const openNativeAuthPopup = (
  url: string, complete: ((ticket: string) => Promise<void>) | undefined,
): AuthPopup | null => {
  const bridge = nativeApp()?.authentication
  if (!bridge) return null
  if (!complete) throw new Error('This authentication flow is missing its completion handler.')
  const id = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '')
  const startUrl = nativeAuthStartUrl(url, id)
  let closed = false
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
    cleanup()
    if ('ticket' in result && typeof result.ticket === 'string' && HEX.test(result.ticket)) {
      const ticket = result.ticket
      void Promise.resolve().then(() => complete(ticket)).then(resolveCompletion, rejectCompletion)
    } else {
      rejectCompletion(new Error('Authentication was cancelled or could not be completed. Please try again.'))
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
    bridge.close(id)
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
      bridge.close(id)
      rejectCompletion(new Error('Authentication was cancelled.'))
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
      secureUrl(data.url)
      return { destination: data.url, record: JSON.stringify({ id: data.id, expiresAt: now + LIFETIME }) }
    }
    if (!HEX.test(hash.slice(1)) || !stored) return null
    const data = JSON.parse(stored)
    if (typeof data.id !== 'string' || !HEX.test(data.id) ||
        typeof data.expiresAt !== 'number' || data.expiresAt <= now || data.expiresAt > now + LIFETIME) return null
    const fragment = new URLSearchParams({ id: data.id, ticket: hash.slice(1) })
    return { destination: `${CALLBACK}#${fragment}`, record: null }
  } catch { return null }
}
