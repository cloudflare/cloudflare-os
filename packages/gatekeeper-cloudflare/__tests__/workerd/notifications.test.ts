import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashWebhookApiKey, notificationReceiverName } from "../../src/notifications-webhook.js";
import type { NotificationTestHooks } from "../worker.js";
const accountId = "a".repeat(32);
const userObjectId = env.USER_ACCOUNT.idFromName("notification-test-account").toString();
const secret = "c".repeat(64);
const payload = JSON.stringify({
  account_id: accountId,
  alert_type: "test_alert",
  policy_id: "b".repeat(32),
  alert_event: "ALERT_STATE_EVENT_START",
  ts: 1234567890,
  data: { evidence: "test" },
});

beforeEach(async () => {
  await setGadgetBehavior();
});
afterEach(() => vi.unstubAllGlobals());
async function setup(name: string, alertType = "test_alert", hookId = "hook-1", seedPolicy = true) {
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
  await runInDurableObject(account, (_instance, state) => {
    state.storage.kv.put("refreshToken", "test-refresh");
    state.storage.kv.put("accessToken", { token: "test-access", expires: Date.now() + 86400_000 });
    state.storage.kv.put("grantedScopes", ["notifications.write"]);
  });
  const stub = env.NOTIFICATION_RECEIVER.getByName(name);
  const authHash = await hashWebhookApiKey(secret);
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.kv.put("installation", {
      accountId,
      userObjectId,
      authHash,
      webhookId: "d".repeat(32),
    });
    state.storage.kv.put("setupComplete", true);
    state.storage.kv.put("owner", { accountId, userObjectId });
    if (seedPolicy)
      state.storage.kv.put(`policy:${alertType}`, { alertType, policyId: "b".repeat(32) });
    const exports = state.exports as unknown as {
      NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
    };
    // The narrow test initiator implements exactly the two methods the production receiver uses.
    await instance.enable(
      { accountId, userObjectId, hookId, alertType },
      exports.NotificationTestHooks({ props: { hookId } }) as unknown as Parameters<
        typeof instance.enable
      >[1],
    );
  });
  return stub;
}
function sendAlert(stub: Awaited<ReturnType<typeof setup>>, body = payload) {
  return stub.receiveWebhook(secret, "application/json", body);
}

// Reset the test Gadget's recorded calls and choose how it behaves on the next delivery.
function setGadgetBehavior({ rejectCallback = false, denyObservation = false } = {}) {
  return env.NOTIFICATION_TEST_HOOKS.reset(rejectCallback, denyObservation);
}

async function receivedAlerts() {
  return (await env.NOTIFICATION_TEST_HOOKS.read())
    .filter((event) => event.startsWith("callback:"))
    .map((event) => JSON.parse(event.slice("callback:".length)));
}

it("tests the destination, receives matching alerts once, and ignores other alert types", async () => {
  const stub = await setup("subscribe");
  expect(
    await stub.receiveWebhook(secret, "application/json", JSON.stringify({ text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly." })),
  ).toBe(204);
  expect((await stub.getStatus()).lastTestAt).toBeDefined();
  expect(await receivedAlerts()).toEqual([]);

  const unrelated = JSON.stringify({ ...JSON.parse(payload), alert_type: "other_alert" });
  await sendAlert(stub, unrelated);
  await Promise.all([sendAlert(stub), sendAlert(stub)]);
  const alerts = await receivedAlerts();
  expect(alerts).toEqual([
    expect.objectContaining({
      accountId,
      alertType: "test_alert",
      timestamp: "2009-02-13T23:31:30.000Z",
      data: { evidence: "test" },
    }),
  ]);
  expect(await env.NOTIFICATION_TEST_HOOKS.read()).toEqual([
    "authorize",
    `callback:${JSON.stringify(alerts[0])}`,
  ]);
  expect(await env.NOTIFICATION_TEST_HOOKS.readObservations()).toEqual([
    expect.objectContaining({
      title: "Cloudflare notification: test_alert",
      description: expect.stringContaining(`policy ID: ${"b".repeat(32)}; event state: ALERT_STATE_EVENT_START`),
      containsRestrictedData: true,
    }),
  ]);
  expect((await env.NOTIFICATION_TEST_HOOKS.readObservations())[0]!.description)
    .toContain(`account ${accountId}`);

  await sendAlert(stub);
  expect(await receivedAlerts()).toEqual(alerts);
});

it("delivers an authenticated notification with no optional account or alert type when its policy ID matches", async () => {
  const stub = await setup("optional-fields");
  expect(await sendAlert(stub, JSON.stringify({ policy_id: "b".repeat(32), ts: 1234567890, data: { signal: "degraded" } })))
    .toBe(204);
  const [alert] = await receivedAlerts();
  expect(alert).toMatchObject({ accountId, data: { signal: "degraded" } });
  expect(alert.alertType).toBeUndefined();
  expect(await env.NOTIFICATION_TEST_HOOKS.readObservations()).toEqual([
    expect.objectContaining({
      title: "Cloudflare notification: not provided",
      containsRestrictedData: true,
    }),
  ]);
});

it("retries an alert with neither policy ID nor alert type instead of acknowledging its loss", async () => {
  const stub = await setup("unroutable-alert");
  const body = JSON.stringify({ ts: 1234567890, data: { signal: "degraded" } });
  expect(await sendAlert(stub, body)).toBe(500);
  expect(await receivedAlerts()).toEqual([]);
  expect((await stub.getStatus()).lastReceivedAt).toBeUndefined();
});

it("rejects unauthenticated or invalid deliveries without invoking the Gadget", async () => {
  const stub = await setup("invalid-delivery");
  for (const [key, type, body, status] of [
    ["", "application/json", payload, 401],
    [secret, "text/plain", payload, 415],
    [secret, "application/json", "{", 400],
    [secret, "application/json", " ".repeat(512 * 1024 + 1), 413],
  ] as const) {
    expect(await stub.receiveWebhook(key, type, body)).toBe(status);
  }
  expect(await receivedAlerts()).toEqual([]);
});

it("authenticates the routed webhook before admitting its body to a receiver", async () => {
  const name = notificationReceiverName(userObjectId, accountId);
  const registry = env.NOTIFICATION_REGISTRY.getByName(name.slice(0, 2));
  const stub = await setup(name);
  await registry.register(name, await hashWebhookApiKey(secret));
  const url = `http://localhost/notifications/webhooks/${userObjectId}/${accountId}`;
  const send = (key: string, body: string) => SELF.fetch(url, {
    method: "POST",
    headers: { "cf-webhook-auth": key, "content-type": "application/json" },
    body,
  });

  expect((await send("wrong", "not json")).status).toBe(401);
  expect((await SELF.fetch(url.replace(userObjectId, "f".repeat(64)), {
    method: "POST",
    headers: { "cf-webhook-auth": secret, "content-type": "application/json" },
    body: "not json",
  })).status).toBe(401);
  expect((await send(secret, payload)).status).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
  await registry.remove(name);
  expect((await send(secret, payload)).status).toBe(401);
  expect((await stub.getStatus()).installed).toBe(true);
});

it("returns failure until authorization and the Gadget recover on ANS redelivery", async () => {
  const stub = await setup("recover");
  await setGadgetBehavior({ denyObservation: true });
  expect(await sendAlert(stub)).toBe(500);
  expect(await env.NOTIFICATION_TEST_HOOKS.read()).toEqual(["authorize"]);
  await setGadgetBehavior({ rejectCallback: true });
  expect(await sendAlert(stub)).toBe(500);
  const attempted = await receivedAlerts();
  expect(attempted).toHaveLength(1);
  await setGadgetBehavior();
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual(attempted);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("does not retrigger a successful subscriber when ANS retries a partial failure", async () => {
  const stub = await setup("two-subscribers");
  await setup("two-subscribers", "test_alert", "hook-2");
  await env.NOTIFICATION_TEST_HOOKS.reset(true, false, "hook-2");
  expect(await sendAlert(stub)).toBe(500);
  expect((await receivedAlerts()).map((alert) => alert.subscriber).toSorted()).toEqual([
    "hook-1",
    "hook-2",
  ]);
  await setGadgetBehavior();
  expect(await sendAlert(stub)).toBe(204);
  expect((await receivedAlerts()).map((alert) => alert.subscriber)).toEqual(["hook-2"]);
  await setGadgetBehavior();
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
});

it("stops handing off after a hook is disabled or the connection is disconnected", async () => {
  const stub = await setup("disconnect");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: [] })));
  await stub.disable("hook-1", "test_alert");
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
  await stub.suspend();
  expect(await sendAlert(stub)).toBe(410);
  expect((await stub.getStatus()).suspended).toBe(true);
});

it("creates one policy for two hooks and removes it after the last hook is disabled", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let policyExists = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ url: input, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (method === "POST") {
      policyExists = true;
      return Response.json({ success: true, result: { id: "b".repeat(32) } });
    }
    if (method === "DELETE") {
      policyExists = false;
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: true, result: policyExists ? [{
      id: "b".repeat(32),
      description: `Cloudflare OS managed ${userObjectId} test_alert`,
      alert_type: "test_alert",
      mechanisms: { webhooks: [{ id: "d".repeat(32) }] },
    }] : [] });
  }));
  const stub = await setup("managed-policy", "test_alert", "hook-1", false);
  await setup("managed-policy", "test_alert", "hook-2", false);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
    alert_type: "test_alert", enabled: true,
    mechanisms: { webhooks: [{ id: "d".repeat(32) }] },
  });
  expect((await stub.getStatus()).policies).toEqual([{ alertType: "test_alert", policyId: "b".repeat(32) }]);
  await stub.disable("hook-1", "test_alert");
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  await stub.disable("hook-2", "test_alert");
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect((await stub.getStatus()).policies).toEqual([]);
});

it("clears a late successful receipt after disabling its hook", async () => {
  const stub = await setup("disable-race");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: [] })));
  await env.NOTIFICATION_TEST_HOOKS.blockCallback();
  const delivery = sendAlert(stub);
  await env.NOTIFICATION_TEST_HOOKS.waitUntilCallbackBlocked();
  const disabled = Promise.resolve(stub.disable("hook-1", "test_alert"));
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.kv.get("hook:hook-1") === undefined)).toBe(true);
  await env.NOTIFICATION_TEST_HOOKS.releaseCallback();
  expect(await delivery).toBe(204);
  await disabled;
  const receipts = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS count FROM notification_receipts").one().count);
  expect(receipts).toBe(0);
});

it("rejects delivery when notification credentials are removed", async () => {
  const stub = await setup("expired");
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
  await runInDurableObject(account, (_instance, state) =>
    state.storage.kv.put("grantedScopes", []),
  );
  expect(await sendAlert(stub)).toBe(500);
  expect(await receivedAlerts()).toEqual([]);
});

it("does not report interrupted setup as complete", async () => {
  const stub = await setup("incomplete-setup");
  await runInDurableObject(stub, (_instance, state) => state.storage.kv.delete("setupComplete"));
  expect(await stub.getStatus()).toMatchObject({ installed: false, webhookId: "d".repeat(32) });
});

// Revoke removes the credential under the owner's real receiver name, not the test DO's name.
const ownerReceiverName = notificationReceiverName(userObjectId, accountId);
async function registerCredential() {
  const registry = env.NOTIFICATION_REGISTRY.getByName(ownerReceiverName.slice(0, 2));
  await registry.register(ownerReceiverName, await hashWebhookApiKey(secret));
  return registry;
}

it("completes disconnect locally when the grant can no longer manage the account", async () => {
  for (const [label, token] of [["denied", "test-access"], ["expired", null]] as const) {
    const name = `revoke-${label}`;
    const stub = await setup(name);
    const registry = await registerCredential();
    const fetch = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await stub.revokeWithToken(token);
    if (token === null) expect(fetch).not.toHaveBeenCalled();
    expect(await registry.authorize(ownerReceiverName, secret)).toBe(false);
    expect(await stub.getStatus()).toMatchObject({ suspended: true, installed: false, subscribers: 0 });
    expect(await sendAlert(stub)).toBe(410);
  }
});

it("keeps state for retry when disconnect cleanup fails transiently", async () => {
  const name = "revoke-transient";
  const stub = await setup(name);
  const registry = await registerCredential();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const error = await stub.revokeWithToken("test-access").then(() => undefined, (caught: Error) => caught);
  expect(error?.message).toContain("HTTP 503");
  expect(await registry.authorize(ownerReceiverName, secret)).toBe(true);
  await registry.remove(ownerReceiverName);
  expect(await stub.getStatus()).toMatchObject({
    suspended: true,
    policies: [{ alertType: "test_alert", policyId: "b".repeat(32) }],
  });
});

it("retries an orphaned policy's removal when another hook is enabled", async () => {
  const name = "orphaned-policy";
  const orphanId = "e".repeat(32);
  await runInDurableObject(env.NOTIFICATION_RECEIVER.getByName(name), (_instance, state) =>
    state.storage.kv.put("policy:orphan_alert", { alertType: "orphan_alert", policyId: orphanId }));
  const deleted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    if (init.method === "DELETE") deleted.push(input);
    return Response.json({ success: true, result: [] });
  }));
  const stub = await setup(name);
  expect(deleted).toEqual([expect.stringMatching(new RegExp(`/policies/${orphanId}$`))]);
  expect((await stub.getStatus()).policies).toEqual([
    { alertType: "test_alert", policyId: "b".repeat(32) },
  ]);
});
