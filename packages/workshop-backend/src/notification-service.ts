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

async function signedPost(env: Cloudflare.Env, pathname: string, payload: object) {
  let {
    NOTIFICATION_SERVICE_URL: serviceUrl, CFOS_INSTALL_ID: installId,
    CFOS_INSTALL_KEY_ID: keyId, CFOS_INSTALL_PRIVATE_KEY: privateKey,
  } = env;
  if (!serviceUrl || !installId || !keyId || !privateKey) {
    throw new Error("Notification service is not configured.");
  }
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
  let response = await fetch(new URL(pathname, serviceUrl), {
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
  });
  if (!response.ok) {
    throw new Error(`Notification service ${pathname} failed with status ${response.status}.`);
  }
  return response;
}

/** Exchange the native app's one-time device registration for an install-bound subscription id. */
export async function registerDevice(
    env: Cloudflare.Env, deviceRegistrationId: string): Promise<string> {
  let response = await signedPost(env, "/v1/subscriptions", { deviceRegistrationId });
  let { subscriptionId } = await response.json<{ subscriptionId?: unknown }>();
  // Stored as-is: an empty id would silently skip push, so hold the service to its id format.
  if (typeof subscriptionId !== "string" || !/^[0-9a-f]{64}$/.test(subscriptionId)) {
    throw new Error("Notification service returned an invalid subscription.");
  }
  return subscriptionId;
}

/** Push a notification to the device behind `subscriptionId`. */
export async function deliver(
    env: Cloudflare.Env, subscriptionId: string,
    { id, kind, workspaceId, chatId, chatTitle }: UserNotification): Promise<void> {
  await signedPost(env, "/v1/deliveries", {
    type: kind === "taskCompleted" ? "task_completed" : "permission_requested",
    eventId: id,
    taskId: `${workspaceId}:${chatId}`,
    threadTitle: threadTitle(chatTitle),
    path: `/workspace/${workspaceId}?chat=${chatId}`,
    subscriptionId,
  });
}
