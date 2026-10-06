// Client for the Cloudflare-operated notification service. Every request is signed with this
// installation's key; the service accepts only fixed, typed templates. See docs/notifications.md.

import type { UserNotification } from "@gadgets/workshop-shared/api";

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// The service rejects titles longer than 96 UTF-16 units or with surrounding whitespace.
function threadTitle(title: string): string | undefined {
  let bounded = "";
  for (let character of title.replace(/\s+/gu, " ").trim()) {
    if (bounded.length + character.length > 96) break;
    bounded += character;
  }
  return bounded.trimEnd() || undefined;
}

async function signedPost(
    env: Cloudflare.Env, pathname: string, payload: object): Promise<Response> {
  let {
    NOTIFICATION_SERVICE_URL: serviceUrl, CFOS_INSTALL_ID: installId,
    CFOS_INSTALL_KEY_ID: keyId, CFOS_INSTALL_PRIVATE_KEY: privateKey,
  } = env;
  if (!serviceUrl || !installId || !keyId || !privateKey) {
    throw new Error("Notification service is not configured.");
  }
  let url = new URL(pathname, serviceUrl);
  // The signature authenticates this install, not the service; only TLS keeps the request private.
  if (url.protocol !== "https:") throw new Error("Notification service URL must use HTTPS.");
  let body = JSON.stringify(payload);
  let digest = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  let timestamp = String(Math.floor(Date.now() / 1000));
  let nonce = crypto.randomUUID();
  let key = await crypto.subtle.importKey(
      "pkcs8", Uint8Array.from(atob(privateKey), character => character.charCodeAt(0)),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  let canonical = ["CFOS1", "POST", pathname, installId, keyId, timestamp, nonce, digest].join("\n");
  let signature = base64url(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(canonical)));
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cfos-content-digest": digest,
      "x-cfos-install-id": installId,
      "x-cfos-key-id": keyId,
      "x-cfos-nonce": nonce,
      "x-cfos-signature": signature,
      "x-cfos-timestamp": timestamp,
    },
    body,
    // A followed redirect would resend the signed request, possibly over plaintext; a 3xx is not
    // ok, so callers fail as for any other bad status. (Workers has no `redirect: "error"`.)
    redirect: "manual",
  });
}

// The service's ids are 64 lowercase hex characters. The device key indexes the stored
// subscriptions, so a missing one would merge every device into one entry; hold the service to it.
const isServiceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * Exchange the native app's one-time device registration for an install-bound subscription, along
 * with the install-scoped key of the device it reaches.
 */
export async function registerDevice(
    env: Cloudflare.Env, deviceRegistrationId: string,
): Promise<{ deviceKey: string; subscriptionId: string }> {
  let response = await signedPost(env, "/v1/subscriptions", { deviceRegistrationId });
  if (!response.ok) {
    throw new Error(`Notification registration failed with status ${response.status}.`);
  }
  let { deviceKey, subscriptionId } =
      await response.json<{ deviceKey?: unknown; subscriptionId?: unknown }>();
  if (!isServiceId(deviceKey) || !isServiceId(subscriptionId)) {
    throw new Error("Notification service returned an invalid subscription.");
  }
  return { deviceKey, subscriptionId };
}

/**
 * Push a notification to the device behind `subscriptionId`. Resolves to false when the service
 * reports it will never deliver to that subscription again.
 */
export async function deliver(
    env: Cloudflare.Env, subscriptionId: string,
    { id, kind, workspaceId, chatId, chatTitle }: UserNotification): Promise<boolean> {
  let response = await signedPost(env, "/v1/deliveries", {
    type: kind === "taskCompleted" ? "task_completed" : "permission_requested",
    eventId: id,
    taskId: `${workspaceId}:${chatId}`,
    threadTitle: threadTitle(chatTitle),
    path: `/workspace/${workspaceId}?chat=${chatId}&showChat=true`,
    subscriptionId,
  });
  if (response.ok) return true;
  // Only the service's verdict on the subscription retires it: a 401 can also mean a bad signature,
  // which must not discard every device's subscription.
  if (response.status === 401 || response.status === 410) {
    let { status } = await response.json<{ status?: unknown }>();
    if (status === "invalid_subscription" || status === "device_gone") return false;
  }
  throw new Error(`Notification delivery failed with status ${response.status}.`);
}
