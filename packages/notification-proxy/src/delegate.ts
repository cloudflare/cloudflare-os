import type { UserNotification } from "@gadgets/workshop-shared/api";

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// The central template rejects titles longer than 96 UTF-16 units or with surrounding whitespace.
const threadTitle = (title: string): string | undefined => {
  let bounded = "";
  for (let character of title.replace(/\s+/gu, " ").trim()) {
    if (bounded.length + character.length > 96) break;
    bounded += character;
  }
  return bounded.trimEnd() || undefined;
};

const signedPost = async (env: Cloudflare.Env, pathname: string, payload: object) => {
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
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  let canonical = ["CFOS1", "POST", pathname, installId, keyId, timestamp, nonce, digest].join("\n");
  let signature = base64url(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(canonical),
  ));
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
};

/** Exchange a one-time native device registration for an install-bound subscription id. */
export const registerDevice = async (
  env: Cloudflare.Env,
  deviceRegistrationId: string,
): Promise<string> => {
  let response = await signedPost(env, "/v1/subscriptions", { deviceRegistrationId });
  let { subscriptionId } = await response.json<{ subscriptionId?: unknown }>();
  if (typeof subscriptionId !== "string") {
    throw new Error("Notification service returned an invalid subscription.");
  }
  return subscriptionId;
};

/** Push a notification through the central service's fixed templates. */
export const deliver = async (
  env: Cloudflare.Env,
  subscriptionId: string,
  { id, kind, workspaceId, chatId, chatTitle }: UserNotification,
): Promise<void> => {
  await signedPost(env, "/v1/deliveries", {
    type: kind === "taskCompleted" ? "task_completed" : "permission_requested",
    eventId: id,
    taskId: `${workspaceId}:${chatId}`,
    threadTitle: threadTitle(chatTitle),
    path: `/workspace/${workspaceId}?chat=${chatId}`,
    subscriptionId,
  });
};
