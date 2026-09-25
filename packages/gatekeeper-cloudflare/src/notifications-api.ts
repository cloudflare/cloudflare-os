import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { assertCloudflareAccountId } from "./resources.js";

const API = "https://api.cloudflare.com/client/v4";

export type NotificationInstallation = { webhookId: string };
export type NotificationPolicy = { policyId: string };

/** A non-success provider response. Only numeric codes are kept: messages can quote inputs back. */
export class NotificationsApiError extends Error {
  constructor(readonly status: number, readonly codes: number[]) {
    super(`Cloudflare Notifications request failed (HTTP ${status}` +
      (codes.length ? `, codes ${codes.join(", ")}` : "") + ")." +
      (status === 401 || status === 403 ? " Check Notifications Write access to this account." : ""));
    this.name = "NotificationsApiError";
  }
}

/** The grant can no longer manage this account's notifications, so retrying cannot succeed. */
export function isNotificationAccessDenied(error: unknown): boolean {
  return error instanceof NotificationsApiError && (error.status === 401 || error.status === 403);
}

async function errorCodes(response: Response): Promise<number[]> {
  try {
    const envelope = object(JSON.parse(await readTextCapped(response)));
    if (!Array.isArray(envelope.errors)) return [];
    return envelope.errors.map((entry) => object(entry).code)
      .filter((code): code is number => Number.isSafeInteger(code)).slice(0, 10);
  } catch {
    return [];
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Cloudflare Notifications response.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
  ) {
    throw new Error("Invalid Cloudflare Notifications resource ID.");
  }
  return value;
}
async function requestEnvelope(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const init: RequestInit = {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${API}${path}`, init);
  if (method === "DELETE" && response.status === 404) {
    await response.body?.cancel();
    return { success: true };
  }
  if (!response.ok) throw new NotificationsApiError(response.status, await errorCodes(response));
  const envelope = object(JSON.parse(await readTextCapped(response)));
  if (envelope.success !== true) throw new Error("Cloudflare Notifications rejected the request.");
  return envelope;
}
async function request(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const envelope = await requestEnvelope(token, path, method, body);
  if (method === "DELETE") return undefined;
  if (!("result" in envelope)) throw new Error("Cloudflare Notifications returned no result.");
  return envelope.result;
}
async function list(token: string, path: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 1_000; page++) {
    const envelope = await requestEnvelope(token, page === 1 ? path : `${path}?page=${page}`);
    if (!Array.isArray(envelope.result))
      throw new Error("Cloudflare Notifications returned an invalid resource list.");
    items.push(...envelope.result.map(object));
    if (items.length > 20_000) throw new Error("Cloudflare Notifications resource list is too large.");
    // These endpoints currently document an unpaginated array. Follow pagination if Cloudflare
    // supplies v4 result_info, and fail closed if it is incomplete or inconsistent.
    if (envelope.result_info === undefined) {
      if (page > 1) throw new Error("Cloudflare Notifications omitted pagination metadata.");
      return items;
    }
    const info = object(envelope.result_info);
    const current = info.page;
    const perPage = info.per_page;
    const totalCount = info.total_count;
    const totalPages = info.total_pages === undefined &&
      Number.isSafeInteger(totalCount) && Number.isSafeInteger(perPage) &&
      (perPage as number) > 0
      ? Math.max(1, Math.ceil((totalCount as number) / (perPage as number)))
      : info.total_pages;
    const lastPage = totalPages === 0 && page === 1 && items.length === 0 ? 1 : totalPages;
    if (!Number.isSafeInteger(current) || current !== page ||
      !Number.isSafeInteger(lastPage) || (lastPage as number) < page ||
      (lastPage as number) > 1_000)
      throw new Error("Cloudflare Notifications returned invalid pagination metadata.");
    if (page === lastPage) return items;
  }
  throw new Error("Cloudflare Notifications resource list exceeded the page limit.");
}

/** Reconcile by the exact connection URL, never adopt another connection's similarly named webhook.
 */
export async function provisionNotificationInstallation(
  token: string,
  accountId: string,
  webhookUrl: string,
  apiKey: string,
): Promise<NotificationInstallation> {
  const root = `/accounts/${assertCloudflareAccountId(accountId)}/alerting/v3`;
  const matches = (await list(token, `${root}/destinations/webhooks`)).filter(
    (item) => item.url === webhookUrl,
  );
  if (matches.length > 1)
    throw new Error(
      "Multiple notification destinations use this connection URL. Remove the duplicate in Cloudflare and retry.",
    );
  const body = { name: "Cloudflare OS", type: "generic", url: webhookUrl, secret: apiKey };
  const webhookId = matches[0]
    ? id(matches[0].id)
    : id(object(await request(token, `${root}/destinations/webhooks`, "POST", body)).id);
  // Recover a previous interrupted attempt, replacing its unknowable provider-side secret.
  if (matches[0]) await request(token, `${root}/destinations/webhooks/${webhookId}`, "PUT", body);
  return { webhookId };
}

/** Recover provider-side resources after a lost creation response, then remove only this URL's resources. */
export async function removeNotificationConnection(
  token: string,
  accountId: string,
  webhookUrl: string,
  known?: NotificationInstallation,
): Promise<void> {
  const root = `/accounts/${assertCloudflareAccountId(accountId)}/alerting/v3`;
  const webhooks = (await list(token, `${root}/destinations/webhooks`)).filter(
    (item) => item.url === webhookUrl,
  );
  const webhookIds = new Set(webhooks.map((item) => id(item.id)));
  if (known) webhookIds.add(id(known.webhookId));
  for (const webhookId of webhookIds)
    await request(token, `${root}/destinations/webhooks/${webhookId}`, "DELETE");
}

function policyMarker(ownerId: string, alertType: string): string {
  if (!/^[a-f\d]{64}$/i.test(ownerId) || !/^[a-z][a-z0-9_]{0,99}$/.test(alertType))
    throw new Error("Invalid notification policy owner or alert type.");
  return `Cloudflare OS managed ${ownerId} ${alertType}`;
}

function policyWebhookIds(value: unknown): string[] {
  const mechanisms = object(value);
  if (!Array.isArray(mechanisms.webhooks)) return [];
  return mechanisms.webhooks.map((entry) => id(object(entry).id));
}

/** The marker survives an interrupted POST, so a retry can adopt only its own policy. */
export async function provisionNotificationPolicy(
  token: string,
  accountId: string,
  webhookId: string,
  alertType: string,
  ownerId: string,
): Promise<NotificationPolicy> {
  const root = `/accounts/${assertCloudflareAccountId(accountId)}/alerting/v3/policies`;
  const destination = id(webhookId);
  const description = policyMarker(ownerId, alertType);
  const matches = (await list(token, root)).filter((item) => item.description === description);
  if (matches.length > 1) throw new Error("Multiple Cloudflare OS policies match this alert type.");
  if (matches[0]) {
    if (matches[0].alert_type !== alertType || matches[0].enabled !== true ||
      !policyWebhookIds(matches[0].mechanisms).includes(destination))
      throw new Error("The managed notification policy was changed in Cloudflare.");
    return { policyId: id(matches[0].id) };
  }
  let policy: Record<string, unknown>;
  try {
    policy = object(await request(token, root, "POST", {
      name: `Cloudflare OS: ${alertType}`,
      description,
      alert_type: alertType,
      enabled: true,
      mechanisms: { webhooks: [{ id: destination }] },
    }));
  } catch (error) {
    if (error instanceof NotificationsApiError && error.status === 400)
      throw new Error(`${error.message} Check that ${alertType} is available to this account; ` +
        "alert types that require filters are not supported yet.", { cause: error });
    throw error;
  }
  return { policyId: id(policy.id) };
}

/** Remove only policies tagged for this connection and alert type, including a lost POST. */
export async function removeNotificationPolicy(
  token: string,
  accountId: string,
  ownerId: string,
  alertType: string,
  webhookId: string,
  known?: NotificationPolicy,
): Promise<void> {
  const root = `/accounts/${assertCloudflareAccountId(accountId)}/alerting/v3/policies`;
  const description = policyMarker(ownerId, alertType);
  const destination = id(webhookId);
  const matches = (await list(token, root)).filter((item) =>
    item.description === description && item.alert_type === alertType &&
    policyWebhookIds(item.mechanisms).includes(destination));
  const policyIds = new Set(matches.map((item) => id(item.id)));
  if (known) policyIds.add(id(known.policyId));
  for (const policyId of policyIds) await request(token, `${root}/${policyId}`, "DELETE");
}
