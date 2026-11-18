import type { WebPushSubscription } from '@gadgets/workshop-shared/api'

// The id of the user whose subscription this browser holds, under the old app's key, so that the
// two agree on one origin. Bookkeeping only: the notification service delivers to an endpoint for
// its latest registration alone.
const OWNER_KEY = 'gadgets:notifications:browserPushOwner'

/** What registers a browser's subscription with the account (`registerNotificationDevice`). */
export type PushRegistrar = { registerNotificationDevice(registration: WebPushSubscription): Promise<void> }

/**
 * Whether this browser can be sent notifications, or why not: on an iPhone or iPad the Cloudflare
 * OS app is sent them, and a browser's subscription would only repeat them, as it would on
 * Android once its app is.
 */
export type BrowserPushSupport = 'supported' | 'unsupported' | 'appleMobile' | 'android'

/** Whether this browser can be sent notifications, or why not (`BrowserPushSupport`). */
export const browserPushSupport = (): BrowserPushSupport => {
  // iPadOS Safari says it is a Mac, with touch.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'appleMobile'
  if (/Android/i.test(navigator.userAgent)) return 'android'
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'supported' : 'unsupported'
}

// One change at a time across tabs. Tabs signing in together would otherwise register at once, and
// the account could keep a subscription the service has replaced and no longer delivers to.
const withLock = <T>(change: () => Promise<T>): Promise<T> => navigator.locks.request('gadgets:notifications:browserPush', change)

/** A subscription as the account takes it. */
export const registrationOf = (subscription: Pick<PushSubscription, 'endpoint' | 'toJSON'>): WebPushSubscription => {
  // A push subscription always has its keys.
  const keys = subscription.toJSON().keys!
  return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

/** The key a subscription was made with, in the base64url the deployment gives it in. */
export const keyOf = ({ options: { applicationServerKey: key } }: Pick<PushSubscription, 'options'>) =>
  key && btoa(String.fromCharCode(...new Uint8Array(key))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const currentSubscription = async (): Promise<PushSubscription | null> =>
  (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() ?? null

// Subscribes with `publicKey`, registering the service worker that shows what is pushed first.
const subscribe = async (publicKey: string): Promise<PushSubscription> => {
  await navigator.serviceWorker.register('/sw.js')
  return (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
}

/** Whether this browser is sent `userId`'s notifications. */
export const browserPushEnabled = async (userId: string): Promise<boolean> =>
  localStorage.getItem(OWNER_KEY) === userId && (await currentSubscription()) !== null

/**
 * Asks to show notifications and, allowed, subscribes this browser to `userId`'s. Call it first
 * thing in a click: the browser asks only from one.
 */
export const enableBrowserPush = async (api: PushRegistrar, userId: string, publicKey: string): Promise<NotificationPermission> => {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission
  await withLock(async () => {
    // Another tab may have turned it on since: subscribing again gives that tab's subscription,
    // which a failed registration here must not end.
    const existing = await currentSubscription()
    const subscription = await subscribe(publicKey)
    try {
      await api.registerNotificationDevice(registrationOf(subscription))
    } catch (error) {
      // No account has one this made, so it must not stay.
      if (!existing) await subscription.unsubscribe()
      throw error
    }
    localStorage.setItem(OWNER_KEY, userId)
  })
  return permission
}

const release = async () => {
  await (await currentSubscription())?.unsubscribe()
  localStorage.removeItem(OWNER_KEY)
}

/** Stops this browser being sent notifications. The account's subscription lapses at its next delivery. */
export const disableBrowserPush = async (): Promise<void> => {
  // At once, without waiting for a registration under way, as signing out does not wait; and under
  // the lock too, asked for now so that it keeps its place, for a subscription one makes meanwhile.
  await Promise.all([release(), withLock(release)])
}

/**
 * Brings this browser in line with `userId`, who has just signed in, and the deployment's
 * `publicKey`: while they have notifications on here and the browser still allows them, it holds a
 * subscription made with that key, registered again; otherwise none.
 */
export const syncBrowserPush = (api: PushRegistrar, userId: string, publicKey: string): Promise<void> =>
  withLock(async () => {
    if (localStorage.getItem(OWNER_KEY) !== userId || Notification.permission !== 'granted') return release()
    let subscription = await currentSubscription()
    // Again where the browser lost it, or it was made with a key the service no longer signs with.
    // Allowed already, so no click is needed.
    if (!subscription || keyOf(subscription) !== publicKey) {
      await subscription?.unsubscribe()
      subscription = await subscribe(publicKey)
    }
    // Registering again renews one the service let lapse after months with nothing sent, which
    // would otherwise look on while nothing arrives.
    await api.registerNotificationDevice(registrationOf(subscription))
  })

