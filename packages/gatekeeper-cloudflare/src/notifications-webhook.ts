import { assertCloudflareAccountId } from "./resources.js";
import { constantTimeEqual, generateNonce, hexEncode } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { CloudflareJson, CloudflareNotification } from "./types.js";

const API_KEY_BYTES = 32;
export const MAX_NOTIFICATION_BODY_BYTES = 512 * 1024;

export function generateWebhookApiKey(): string {
  return generateNonce();
}

export async function hashWebhookApiKey(apiKey: string): Promise<string> {
  return hexEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))),
  );
}

export async function matchesWebhookApiKey(apiKey: string, expectedHash: string): Promise<boolean> {
  if (apiKey.length !== API_KEY_BYTES * 2 || !/^[a-f\d]+$/i.test(apiKey)) return false;
  return constantTimeEqual(await hashWebhookApiKey(apiKey), expectedHash);
}

export function notificationReceiverName(userObjectId: string, accountId: string): string {
  return `${userObjectId}:${accountId}`;
}

export function parseNotificationWebhookPath(
  pathname: string,
  basePath: string,
): { userObjectId: string; accountId: string } | null {
  const prefix = `${basePath}/webhooks/`;
  if (!pathname.startsWith(prefix)) return null;
  const match = /^([a-f\d]{64})\/([a-f\d]{32})$/i.exec(pathname.slice(prefix.length));
  if (!match) return null;
  return { userObjectId: match[1]!.toLowerCase(), accountId: match[2]!.toLowerCase() };
}

/** Recognize Cloudflare's documented destination-test message, which is not an alert. */
export function isWebhookTest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 1 && "text" in value && typeof value.text === "string";
}

/** Parse the generic ANS envelope. No fixed alert-type enumeration or event_id assumption. */
export async function parseNotificationWebhook(
  body: string,
  expectedAccountId: string,
): Promise<CloudflareNotification> {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid notification envelope.");
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.account_id !== "string" ||
    assertCloudflareAccountId(payload.account_id) !== expectedAccountId
  ) {
    throw new Error("Notification account does not match the binding.");
  }
  if (typeof payload.alert_type !== "string" || payload.alert_type.length === 0) {
    throw new Error("Invalid notification alert type.");
  }
  if (typeof payload.ts !== "number" || payload.ts < 0) {
    throw new Error("Invalid notification timestamp.");
  }
  const timestamp = new Date(payload.ts * 1000);
  if (Number.isNaN(timestamp.valueOf())) throw new Error("Invalid notification timestamp.");
  if (!("data" in payload)) throw new Error("Missing notification evidence.");
  // JSON.parse has validated JSON recursively; hashing the entire envelope distinguishes policy,
  // event state and evidence even when correlation IDs are shared. Identical retries collapse.
  const id = await hashWebhookApiKey(JSON.stringify(payload));
  const result: CloudflareNotification = {
    id,
    accountId: expectedAccountId,
    alertType: payload.alert_type,
    timestamp: timestamp.toISOString(),
    data: payload.data as CloudflareJson,
  };
  const fields = {
    policy_id: "policyId",
    policy_name: "policyName",
    name: "name",
    text: "text",
    alert_correlation_id: "correlationId",
    alert_event: "event",
  } as const;
  for (const [source, target] of Object.entries(fields)) {
    if (payload[source] !== undefined) {
      if (typeof payload[source] !== "string") throw new Error("Invalid notification metadata.");
      result[target] = payload[source];
    }
  }
  return result;
}
