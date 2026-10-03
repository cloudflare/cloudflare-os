import type {
  PermissionRequestedDelivery, TaskCompletedDelivery,
} from "@gadgets/workshop-shared/notification-delivery";

/** Install key material injected by the trusted Cloudflare OS installer. */
export type InstallSigningIdentity = {
  /** Stable account-and-router identifier registered centrally for this installation. */
  installId: string;
  /** Active signing-key generation. */
  keyId: string;
  /** Base64-encoded PKCS#8 P-256 private key. */
  privateKey: string;
};

/** JSON body sent from an install-local proxy to the central service. */
export type TaskCompletedRequest = {
  /** Typed template the service is allowed to render. */
  type: "task_completed";
  /** Stable identifier used to deduplicate delivery attempts. */
  eventId: string;
  /** Install-local identifier for the workspace/chat task. */
  taskId: string;
  /** Bounded human-readable thread title rendered by the central APNs template. */
  threadTitle: string;
  /** Same-origin path the native app opens when the push is selected. */
  path: string;
  /** Install-bound device subscription held only by the install-local proxy. */
  subscriptionId: string;
};

/** Fixed permission-request template using the same install-bound delivery envelope. */
export type PermissionRequestedRequest = Omit<TaskCompletedRequest, "type"> & {
  /** Only this permission-request template may be rendered, never caller-supplied push text. */
  type: "permission_requested";
};

const notificationThreadTitle = (value: string): string => {
  let normalized = value.replace(/\s+/gu, " ").trim();
  return [...normalized].slice(0, 96).join("") || "Task";
};

/** Convert the RPC delivery value into the central service's versioned wire format. */
export const taskCompletedRequest = (
  delivery: Pick<TaskCompletedDelivery, "id" | "workspaceId" | "chatId" | "chatTitle">,
  subscriptionId: string,
): TaskCompletedRequest => ({
  type: "task_completed",
  eventId: delivery.id,
  taskId: `${delivery.workspaceId}:${delivery.chatId}`,
  threadTitle: notificationThreadTitle(delivery.chatTitle),
  path: `/workspace/${encodeURIComponent(delivery.workspaceId)}?chat=${delivery.chatId}`,
  subscriptionId,
});

/** Serialize a permission prompt without exposing its resource, reason, or action contents. */
export const permissionRequestedRequest = (
  delivery: PermissionRequestedDelivery,
  subscriptionId: string,
): PermissionRequestedRequest => ({
  ...taskCompletedRequest(delivery, subscriptionId),
  type: "permission_requested",
});

const base64ToBytes = (value: string): Uint8Array => {
  let binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const base64url = (value: ArrayBuffer): string => btoa(
  String.fromCharCode(...new Uint8Array(value)),
).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const notificationEndpoint = (serviceUrl: string, pathname: string): URL => {
  let url = new URL(serviceUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("NOTIFICATION_SERVICE_URL must be an HTTPS origin.");
  }
  url.pathname = pathname;
  return url;
};

/** Canonical signed request shared with the central verifier. */
export const canonicalNotificationRequest = (
  pathname: string,
  identity: Pick<InstallSigningIdentity, "installId" | "keyId">,
  timestamp: string,
  nonce: string,
  contentDigest: string,
): string => [
  "CFOS1", "POST", pathname, identity.installId, identity.keyId,
  timestamp, nonce, contentDigest,
].join("\n");

const signedPost = async (
  serviceUrl: string,
  pathname: string,
  identity: InstallSigningIdentity,
  body: string,
  fetcher: typeof fetch,
): Promise<Response> => {
  let url = notificationEndpoint(serviceUrl, pathname);
  let contentDigest = base64url(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(body),
  ));
  let timestamp = String(Math.floor(Date.now() / 1000));
  let nonce = crypto.randomUUID();
  let key = await crypto.subtle.importKey(
    "pkcs8", base64ToBytes(identity.privateKey),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  let canonical = canonicalNotificationRequest(
    url.pathname, identity, timestamp, nonce, contentDigest,
  );
  let signature = base64url(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonical),
  ));
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cfos-content-digest": contentDigest,
      "x-cfos-install-id": identity.installId,
      "x-cfos-key-id": identity.keyId,
      "x-cfos-nonce": nonce,
      "x-cfos-signature": signature,
      "x-cfos-timestamp": timestamp,
    },
    body,
  });
};

/** Exchange one native-app device registration for an install-bound subscription. */
export const registerDevice = async (
  serviceUrl: string,
  identity: InstallSigningIdentity,
  deviceRegistrationId: string,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  if (!/^[0-9a-f]{64}$/.test(deviceRegistrationId)) {
    throw new Error("Invalid notification device registration.");
  }
  let response = await signedPost(
    serviceUrl, "/v1/subscriptions", identity,
    JSON.stringify({ deviceRegistrationId }), fetcher,
  );
  if (!response.ok) {
    throw new Error(`Notification service refused registration with status ${response.status}.`);
  }
  let result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("subscriptionId" in result) ||
      typeof result.subscriptionId !== "string" || !/^[0-9a-f]{64}$/.test(result.subscriptionId)) {
    throw new Error("Notification service returned an invalid subscription.");
  }
  return result.subscriptionId;
};

/** Deliver one typed notification through the centrally operated service. */
export const sendTaskCompleted = async (
  serviceUrl: string,
  identity: InstallSigningIdentity,
  subscriptionId: string,
  delivery: TaskCompletedDelivery,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  await sendDelivery(serviceUrl, identity, taskCompletedRequest(delivery, subscriptionId), fetcher);
};

/** Deliver one permission-request alert using the install's existing subscription. */
export const sendPermissionRequested = async (
  serviceUrl: string,
  identity: InstallSigningIdentity,
  subscriptionId: string,
  delivery: PermissionRequestedDelivery,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  await sendDelivery(
    serviceUrl, identity, permissionRequestedRequest(delivery, subscriptionId), fetcher,
  );
};

const sendDelivery = async (
  serviceUrl: string,
  identity: InstallSigningIdentity,
  delivery: TaskCompletedRequest | PermissionRequestedRequest,
  fetcher: typeof fetch,
): Promise<void> => {
  let response = await signedPost(
    serviceUrl, "/v1/deliveries", identity, JSON.stringify(delivery), fetcher,
  );
  if (!response.ok) {
    throw new Error(`Notification service refused delivery with status ${response.status}.`);
  }
};
