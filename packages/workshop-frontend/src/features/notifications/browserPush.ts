import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, WebPushSubscription } from "@gadgets/workshop-shared/api";
import { inNativeApp } from "../native-app/nativeApp";

// The id of the user whose subscription this browser holds. Bookkeeping only: the notification
// service delivers to an endpoint for its latest registration alone.
const OWNER_KEY = "gadgets:notifications:browserPushOwner";

/** Whether this browser can offer push notifications, or why it doesn't. */
export const browserPushSupport = (): "supported" | "unsupported" | "appleMobile" | "android" => {
  // The native apps deliver their own push.
  if (inNativeApp()) return "unsupported";
  // The Cloudflare OS app pushes there, so a browser subscription would duplicate it. iPadOS
  // Safari reports itself as a Mac with touch.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)) {
    return "appleMobile";
  }
  // Likewise for the Android app, once its push ships.
  if (/Android/i.test(navigator.userAgent)) return "android";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    ? "supported" : "unsupported";
};

// Transitions run one at a time across tabs. Tabs restoring a session together would otherwise
// register concurrently, and the User DO could keep a superseded subscription the service no
// longer delivers to, silently ending this browser's push.
const withLock = <T>(transition: () => Promise<T>): Promise<T> =>
  navigator.locks.request("gadgets:notifications:browserPush", transition);

const registrationOf = (subscription: PushSubscription): WebPushSubscription => {
  // Always present on a push subscription.
  let keys = subscription.toJSON().keys!;
  return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
};

// The VAPID key a subscription was made with, as the base64url the deployment advertises.
const keyOf = ({ options: { applicationServerKey: key } }: PushSubscription) =>
  key && btoa(String.fromCharCode(...new Uint8Array(key)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const currentSubscription = async (): Promise<PushSubscription | null> =>
  (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription() ?? null;

// Subscribes with `publicKey`, first registering the service worker that shows pushes if need be.
const subscribe = async (publicKey: string): Promise<PushSubscription> => {
  await navigator.serviceWorker.register("/sw.js");
  return (await navigator.serviceWorker.ready).pushManager.subscribe(
    { userVisibleOnly: true, applicationServerKey: publicKey });
};

/** Whether this browser receives `userId`'s push notifications. */
export const browserPushEnabled = async (userId: string): Promise<boolean> =>
  localStorage.getItem(OWNER_KEY) === userId && await currentSubscription() !== null;

/**
 * Ask for notification permission and, once granted, subscribe this browser to `userId`'s push
 * notifications. Call it first in a click handler: the permission prompt needs the click.
 */
export const enableBrowserPush = async (
  api: RpcStub<AuthenticatedApi>, userId: string, publicKey: string,
): Promise<NotificationPermission> => {
  let permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;
  await withLock(async () => {
    // Another tab may have enabled push since this one read its status. subscribe() then returns
    // that working subscription, which a failed registration here must not end.
    let existing = await currentSubscription();
    let subscription = await subscribe(publicKey);
    try {
      await api.registerNotificationDevice(registrationOf(subscription));
    } catch (error) {
      // No account holds a subscription this attempt created, so it must not linger.
      if (!existing) await subscription.unsubscribe();
      throw error;
    }
    localStorage.setItem(OWNER_KEY, userId);
  });
  return permission;
};

const release = async () => {
  await (await currentSubscription())?.unsubscribe();
  localStorage.removeItem(OWNER_KEY);
};

/** Stop this browser's push. The user's subscription lapses at its next delivery. */
export const disableBrowserPush = async (): Promise<void> => {
  // At once, without queuing behind a registration: sign-out shows the login page without waiting,
  // and closing it drops a queued lock request. And under the lock, requested now so it keeps this
  // click's place among other tabs' transitions, for a subscription one under way makes meanwhile.
  await Promise.all([release(), withLock(release)]);
};

/**
 * Bring this browser's push in line with `userId`, who just signed in, and the deployment's
 * `publicKey`. While `userId` keeps push on here and permission stands, the browser holds a
 * subscription made with that key, registered again; otherwise it holds none.
 */
export const syncBrowserPush = (
  api: RpcStub<AuthenticatedApi>, userId: string, publicKey: string,
): Promise<void> => withLock(async () => {
  if (localStorage.getItem(OWNER_KEY) !== userId || Notification.permission !== "granted") {
    return release();
  }
  let subscription = await currentSubscription();
  // Subscribe again when the browser holds none (it lost it, or the last replacement failed) or one
  // made with a VAPID key the service no longer signs with. Permission stands, so no click is needed.
  if (!subscription || keyOf(subscription) !== publicKey) {
    await subscription?.unsubscribe();
    subscription = await subscribe(publicKey);
  }
  // Registering again renews a subscription the service expired after months without delivery,
  // which would otherwise read as on while nothing arrives.
  await api.registerNotificationDevice(registrationOf(subscription));
});
