import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { assertCloudflareAccountId } from "./resources.js";

const API = "https://api.cloudflare.com/client/v4";

export type NotificationInstallation = { webhookId: string };

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
async function request(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
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
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Cloudflare Notifications request failed (${response.status}). Check Notifications Write access and webhook eligibility.`,
    );
  }
  const envelope = object(JSON.parse(await readTextCapped(response)));
  if (envelope.success !== true) throw new Error("Cloudflare Notifications rejected the request.");
  if (method === "DELETE") return undefined;
  if (!("result" in envelope)) throw new Error("Cloudflare Notifications returned no result.");
  return envelope.result;
}
async function list(token: string, path: string): Promise<Record<string, unknown>[]> {
  const result = await request(token, path);
  if (!Array.isArray(result))
    throw new Error("Cloudflare Notifications returned an invalid resource list.");
  return result.map(object);
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
