import { afterEach, expect, it, vi } from "vitest";
import {
  provisionNotificationInstallation,
  removeNotificationConnection,
} from "../src/notifications-api.js";

const account = "a".repeat(32);
const webhook = "b".repeat(32);
const otherWebhook = "c".repeat(32);
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
