import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { hashWebhookApiKey } from "../../src/notifications-webhook.js";
import type { NotificationTestHooks } from "../worker.js";
const accountId = "a".repeat(32);
const userObjectId = env.USER_ACCOUNT.idFromName("notification-test-account").toString();
const secret = "c".repeat(64);
const payload = JSON.stringify({
  account_id: accountId,
  alert_type: "test_alert",
  ts: 1234567890,
  data: { evidence: "test" },
});

beforeEach(async () => {
  await setGadgetBehavior();
});
async function setup(name: string, filter: { alertTypes?: string[] } = {}, hookId = "hook-1") {
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
    const exports = state.exports as unknown as {
      NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
    };
    // The narrow test initiator implements exactly the two methods the production receiver uses.
    await instance.enable(
      { accountId, userObjectId, hookId, filter },
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
  const stub = await setup("subscribe", { alertTypes: ["test_alert"] });
  expect(
    await stub.receiveWebhook(secret, "application/json", JSON.stringify({ text: "Hello World!" })),
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

  await sendAlert(stub);
  expect(await receivedAlerts()).toEqual(alerts);
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
  await setup("two-subscribers", {}, "hook-2");
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
  await stub.disable("hook-1");
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
  await stub.suspend();
  expect(await sendAlert(stub)).toBe(410);
  expect((await stub.getStatus()).suspended).toBe(true);
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
