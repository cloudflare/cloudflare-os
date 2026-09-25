import { afterEach, expect, it, vi } from "vitest";
import {
  isNotificationAccessDenied,
  NotificationsApiError,
  provisionNotificationInstallation,
  provisionNotificationPolicy,
  removeNotificationConnection,
  removeNotificationPolicy,
} from "../src/notifications-api.js";

const account = "a".repeat(32);
const webhook = "b".repeat(32);
const otherWebhook = "c".repeat(32);
const policy = "d".repeat(32);
const ownerId = "e".repeat(64);
const url = "https://os.example/gatekeeper/cloudflare/webhooks/connection/account";

afterEach(() => vi.unstubAllGlobals());

function mock(results: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      calls.push({ url: input, init });
      const result = results.shift();
      if (result instanceof Response) return result;
      return Response.json({ success: true, result });
    }),
  );

  return calls;
}

it("creates a generic webhook destination", async () => {
  const calls = mock([[], { id: webhook }]);
  expect(await provisionNotificationInstallation("token", account, url, "secret")).toEqual({
    webhookId: webhook,
  });
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
    name: "Cloudflare OS",
    type: "generic",
    url,
    secret: "secret",
  });
});

it("rejects redirects without following them with the account token", async () => {
  const calls = mock([
    new Response(null, { status: 302, headers: { Location: "https://other.example" } }),
  ]);

  await expect(provisionNotificationInstallation("token", account, url, "secret")).rejects.toThrow(
    "302",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.init.redirect).toBe("manual");
});

it("recovers an interrupted creation by reusing the destination and replacing its secret", async () => {
  const calls = mock([[{ id: webhook, url }], { id: webhook }]);

  expect(await provisionNotificationInstallation("token", account, url, "new-secret")).toEqual({
    webhookId: webhook,
  });
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT"]);
  expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ url, secret: "new-secret" });
});

it("refuses ambiguous destinations and malformed responses", async () => {
  mock([
    [
      { id: webhook, url },
      { id: otherWebhook, url },
    ],
  ]);

  await expect(provisionNotificationInstallation("token", account, url, "secret")).rejects.toThrow(
    "Multiple",
  );

  mock([{}, null]);

  await expect(provisionNotificationInstallation("token", account, url, "secret")).rejects.toThrow(
    "invalid resource list",
  );
});

it("tolerates an already-deleted destination during disconnect", async () => {
  const calls = mock([[], new Response(null, { status: 404 })]);

  await removeNotificationConnection("token", account, url, { webhookId: webhook });
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "DELETE"]);
  expect(calls[1]!.url).toContain(`/webhooks/${webhook}`);
});

it("recovers cleanup after a lost creation response without touching another connection", async () => {
  const calls = mock([
    [
      { id: webhook, url },
      { id: otherWebhook, url: "https://other.example/webhook" },
    ],
    {},
  ]);

  await removeNotificationConnection("token", account, url);
  expect(calls.filter((call) => call.init.method === "DELETE").map((call) => call.url)).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${account}/alerting/v3/destinations/webhooks/${webhook}`,
  ]);
});

it("creates an enabled policy for one alert type and the managed destination", async () => {
  const calls = mock([[], { id: policy }]);
  expect(await provisionNotificationPolicy("token", account, webhook, "incident_alert", ownerId))
    .toEqual({ policyId: policy });
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST"]);
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
    name: "Cloudflare OS: incident_alert",
    description: `Cloudflare OS managed ${ownerId} incident_alert`,
    alert_type: "incident_alert",
    enabled: true,
    mechanisms: { webhooks: [{ id: webhook }] },
  });
});

it("recovers a lost policy creation response and refuses a changed policy", async () => {
  const matching = {
    id: policy, description: `Cloudflare OS managed ${ownerId} incident_alert`,
    alert_type: "incident_alert", enabled: true,
    mechanisms: { webhooks: [{ id: webhook }] },
  };
  const calls = mock([[matching]]);
  expect(await provisionNotificationPolicy("token", account, webhook, "incident_alert", ownerId))
    .toEqual({ policyId: policy });
  expect(calls.map((call) => call.init.method)).toEqual(["GET"]);
  mock([[{ ...matching, mechanisms: { webhooks: [{ id: otherWebhook }] } }]]);
  await expect(provisionNotificationPolicy("token", account, webhook, "incident_alert", ownerId))
    .rejects.toThrow("changed");
  mock([[{ ...matching, enabled: false }]]);
  await expect(provisionNotificationPolicy("token", account, webhook, "incident_alert", ownerId))
    .rejects.toThrow("changed");
});

it("finds a managed destination on a later provider page", async () => {
  const calls = mock([
    Response.json({ success: true, result: [{ id: otherWebhook, url: "https://other.example" }],
      result_info: { page: 1, per_page: 1, total_count: 2 } }),
    Response.json({ success: true, result: [{ id: webhook, url }],
      result_info: { page: 2, per_page: 1, total_count: 2 } }),
    { id: webhook },
  ]);
  expect(await provisionNotificationInstallation("token", account, url, "secret"))
    .toEqual({ webhookId: webhook });
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET", "PUT"]);
  expect(calls[1]!.url).toContain("?page=2");
});

it("finds a managed policy on a later provider page", async () => {
  const calls = mock([
    Response.json({ success: true, result: [{ id: otherWebhook, description: "Other" }],
      result_info: { page: 1, total_pages: 2 } }),
    Response.json({ success: true, result: [{
      id: policy, description: `Cloudflare OS managed ${ownerId} incident_alert`,
      alert_type: "incident_alert", enabled: true,
      mechanisms: { webhooks: [{ id: webhook }] },
    }], result_info: { page: 2, total_pages: 2 } }),
  ]);
  expect(await provisionNotificationPolicy("token", account, webhook, "incident_alert", ownerId))
    .toEqual({ policyId: policy });
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET"]);
  expect(calls[1]!.url).toContain("?page=2");
});

it("refuses inconsistent pagination instead of creating a duplicate", async () => {
  const calls = mock([
    Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 2 } }),
    Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 2 } }),
  ]);
  await expect(provisionNotificationInstallation("token", account, url, "secret"))
    .rejects.toThrow("pagination metadata");
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET"]);
});

it("deletes only this hook's policy, including a known ID after its description changes", async () => {
  const calls = mock([[
    { id: policy, description: `Cloudflare OS managed ${ownerId} incident_alert`,
      alert_type: "incident_alert", mechanisms: { webhooks: [{ id: webhook }] } },
    { id: otherWebhook, description: "Another policy" },
  ], {}]);
  await removeNotificationPolicy("token", account, ownerId, "incident_alert", webhook, { policyId: policy });
  expect(calls.filter((call) => call.init.method === "DELETE").map((call) => call.url))
    .toEqual([`https://api.cloudflare.com/client/v4/accounts/${account}/alerting/v3/policies/${policy}`]);
});

it("reports provider error codes without echoing provider messages", async () => {
  mock([
    [],
    Response.json({ success: false, errors: [{ code: 17000, message: `bad ${ownerId}` }] },
      { status: 400 }),
  ]);
  const error = await provisionNotificationPolicy("token", account, webhook, "test_alert", ownerId)
    .catch((caught: unknown) => caught as Error);
  expect(error.message).toContain("HTTP 400, codes 17000");
  expect(error.message).toContain("require filters");
  expect(error.message).not.toContain(ownerId);
  expect(isNotificationAccessDenied(error.cause)).toBe(false);
});

it("classifies 401 and 403 as access denied, and other failures as retryable", async () => {
  for (const [status, denied] of [[401, true], [403, true], [500, false], [429, false]] as const) {
    mock([new Response("{}", { status })]);
    const error = await removeNotificationPolicy("token", account, ownerId, "test_alert", webhook)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationsApiError);
    expect(isNotificationAccessDenied(error)).toBe(denied);
  }
});
