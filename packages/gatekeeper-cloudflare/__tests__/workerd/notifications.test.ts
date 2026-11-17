import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm as runScheduledAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashWebhookApiKey, notificationReceiverName } from "../../src/notifications-webhook.js";
import type { CloudflareNotificationPolicySettings } from "../../src/types.js";
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

// The runtime helper fires a future alarm immediately; advance the policy deadline with it.
async function runDurableObjectAlarm(stub: Parameters<typeof runScheduledAlarm>[0]) {
  await runInDurableObject(stub, (_instance, state) => {
    if (state.storage.kv.get("policyCleanupAt") !== undefined)
      state.storage.kv.put("policyCleanupAt", Date.now() - 1);
  });
  return runScheduledAlarm(stub);
}

beforeEach(async () => {
  await setGadgetBehavior();
  mockProvider();
});
afterEach(() => vi.unstubAllGlobals());
function mockProvider(
  handler: (url: string, init: RequestInit) => Promise<Response> = async () => {
    throw new Error("Unexpected provider request");
  },
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "GET" && /\/destinations\/webhooks\/[a-f\d]{32}$/.test(url))
      return Response.json({
        success: true,
        result: {
          id: "d".repeat(32),
          url: `https://hooks.example/notifications/webhooks/${userObjectId}/${accountId}`,
        },
      });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function setup(
  name: string,
  alertType = "test_alert",
  hookId = "hook-1",
  seedPolicy = true,
  createPolicy = true,
  policy?: CloudflareNotificationPolicySettings,
) {
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
    state.storage.kv.put(
      "webhookUrl",
      `https://hooks.example/notifications/webhooks/${userObjectId}/${accountId}`,
    );
    state.storage.kv.put("owner", { accountId, userObjectId });
    if (seedPolicy)
      state.storage.kv.put(`policy:${alertType}`, { alertType, policyId: "b".repeat(32) });
    const exports = state.exports as unknown as {
      NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
    };
    // The narrow test initiator implements exactly the two methods the production receiver uses.
    await instance.enable(
      { accountId, userObjectId, hookId, alertType, createPolicy, policy },
      exports.NotificationTestHooks({ props: { hookId } }) as unknown as Parameters<
        typeof instance.enable
      >[1],
    );
  });
  return stub;
}
async function sendAlert(stub: Awaited<ReturnType<typeof setup>>, body = payload) {
  const status = await stub.receiveWebhook(secret, "application/json", body);
  await stub.deliverPending();
  return status;
}
async function retryPending(stub: Awaited<ReturnType<typeof setup>>) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE notification_deliveries SET next_attempt = 0");
  });
  await runDurableObjectAlarm(stub);
}
async function enableAdditionalHook(name: string) {
  const stub = env.NOTIFICATION_RECEIVER.getByName(name);
  await runInDurableObject(stub, async (instance, state) => {
    const exports = state.exports as unknown as {
      NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
    };
    await instance.enable(
      { accountId, userObjectId, hookId: "hook-2", alertType: "test_alert", createPolicy: false },
      exports.NotificationTestHooks({ props: { hookId: "hook-2" } }) as unknown as Parameters<
        typeof instance.enable
      >[1],
    );
  });
}
async function expectDisableFailure(stub: Awaited<ReturnType<typeof setup>>, message: string) {
  const error = await stub.disable("hook-1", "test_alert").then(
    () => undefined,
    (caught: Error) => caught,
  );
  expect(error?.message).toContain(message);
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
    await stub.receiveWebhook(
      secret,
      "application/json",
      JSON.stringify({
        text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.",
      }),
    ),
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
      description: expect.stringContaining(
        `policy ID: ${"b".repeat(32)}; event state: ALERT_STATE_EVENT_START`,
      ),
    }),
  ]);
  const [observation] = await env.NOTIFICATION_TEST_HOOKS.readObservations();
  expect(observation!.description).toContain(`account ${accountId}`);
  // Not restricted: a restricted workspace refuses pushes, and the Worker-issue fixer must push
  // its fix branch. What reaches a repository is guarded instead -- see the contributor binding.
  expect(observation!.containsRestrictedData).toBeUndefined();

  await sendAlert(stub);
  expect(await receivedAlerts()).toEqual(alerts);
});

it("retries policy-only alerts because routing requires an alert type", async () => {
  const stub = await setup("optional-fields", "test_alert", "hook-1", false, false);
  expect(
    await sendAlert(stub, JSON.stringify({ policy_id: "b".repeat(32), ts: 1234567890, data: {} })),
  ).toBe(500);
  expect(await receivedAlerts()).toEqual([]);
});

it("routes by alert type regardless of policy ID formatting", async () => {
  const stub = await setup("dashed-policy-id");
  // The API returns policy IDs without dashes; deliveries carry them dashed.
  const dashed = "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const body = JSON.stringify({ ...JSON.parse(payload), policy_id: dashed });

  const status = await sendAlert(stub, body);

  expect(status).toBe(204);
  expect(await receivedAlerts()).toEqual([expect.objectContaining({ policyId: dashed })]);
});

it("isolates legacy managed hooks from another policy with the same alert type", async () => {
  const stub = await setup("foreign-policy");
  const body = JSON.stringify({ ...JSON.parse(payload), policy_id: "e".repeat(32) });

  const status = await sendAlert(stub, body);

  expect(status).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
});

it("delivers Real-Time Issues sent through the destination's policy", async () => {
  const alertType = "workers_observability_real_time_issue";
  const stub = await setup("workers-issues-policy", alertType);
  const body = JSON.stringify({
    ...JSON.parse(payload),
    alert_type: alertType,
    policy_id: "b".repeat(32),
  });

  expect(await sendAlert(stub, body)).toBe(204);
  expect(await receivedAlerts()).toEqual([
    expect.objectContaining({ alertType, policyId: "b".repeat(32) }),
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

it("rejects unknown credentials without persisting receiver storage", async () => {
  const name = notificationReceiverName(userObjectId, accountId);
  const stub = await setup(name);
  const url = `http://localhost/notifications/webhooks/${userObjectId}/${accountId}`;
  const send = (key: string, body: string) =>
    SELF.fetch(url, {
      method: "POST",
      headers: { "cf-webhook-auth": key, "content-type": "application/json" },
      body,
    });

  expect((await send("wrong", "not json")).status).toBe(401);
  expect((await send("e".repeat(64), " ".repeat(512 * 1024 + 1))).status).toBe(401);
  expect(
    (
      await SELF.fetch(url.replace(userObjectId, "f".repeat(64)), {
        method: "POST",
        headers: { "cf-webhook-auth": secret, "content-type": "application/json" },
        body: "not json",
      })
    ).status,
  ).toBe(401);
  expect((await send(secret, payload)).status).toBe(204);
  await stub.deliverPending();
  expect(await receivedAlerts()).toHaveLength(1);
  const unknown = env.NOTIFICATION_RECEIVER.getByName(
    notificationReceiverName("f".repeat(64), accountId),
  );
  expect(
    await runInDurableObject(unknown, (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_receipts'",
        )
        .toArray(),
    ),
  ).toEqual([]);
  expect(
    await runInDurableObject(unknown, (_instance, state) => [...state.storage.kv.list()]),
  ).toEqual([]);
  expect((await stub.getStatus()).installed).toBe(true);
});

it("accepts durably and retries authorization and callback failures without ANS redelivery", async () => {
  const stub = await setup("recover");
  await setGadgetBehavior({ denyObservation: true });
  expect(await sendAlert(stub)).toBe(204);
  expect(await env.NOTIFICATION_TEST_HOOKS.read()).toEqual(["authorize"]);
  expect(await stub.getStatus()).toMatchObject({ pendingDeliveries: 1, retryingDeliveries: 1 });
  await setGadgetBehavior({ rejectCallback: true });
  await retryPending(stub);
  const attempted = await receivedAlerts();
  expect(attempted).toHaveLength(1);
  await setGadgetBehavior();
  await retryPending(stub);
  expect(await receivedAlerts()).toEqual(attempted);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("does not retrigger a successful subscriber when ANS retries a partial failure", async () => {
  const stub = await setup("two-subscribers");
  await setup("two-subscribers", "test_alert", "hook-2");
  await env.NOTIFICATION_TEST_HOOKS.reset(true, false, "hook-2");
  expect(await sendAlert(stub)).toBe(204);
  expect((await receivedAlerts()).map((alert) => alert.subscriber).toSorted()).toEqual([
    "hook-1",
    "hook-2",
  ]);
  await setGadgetBehavior();
  await retryPending(stub);
  expect((await receivedAlerts()).map((alert) => alert.subscriber)).toEqual(["hook-2"]);
  await setGadgetBehavior();
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
});

it("stops handing off after a hook is disabled or the connection is disconnected", async () => {
  const stub = await setup("disconnect");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, result: [] })),
  );
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
  mockProvider(async (input: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({
      url: input,
      method,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    if (method === "POST") {
      policyExists = true;
      return Response.json({ success: true, result: { id: "b".repeat(32) } });
    }
    if (method === "DELETE") {
      policyExists = false;
      return Response.json({ success: true, result: {} });
    }
    return Response.json({
      success: true,
      result: policyExists
        ? [
            {
              id: "b".repeat(32),
              description: `Cloudflare OS managed ${userObjectId} test_alert`,
              alert_type: "test_alert",
              mechanisms: { webhooks: [{ id: "d".repeat(32) }] },
            },
          ]
        : [],
    });
  });
  const stub = await setup("managed-policy", "test_alert", "hook-1", false);
  await setup("managed-policy", "test_alert", "hook-2", false);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
    alert_type: "test_alert",
    enabled: true,
    mechanisms: { webhooks: [{ id: "d".repeat(32) }] },
  });
  expect((await stub.getStatus()).policies).toEqual([
    { alertType: "test_alert", policyId: "b".repeat(32) },
  ]);
  await stub.disable("hook-1", "test_alert");
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  await stub.disable("hook-2", "test_alert");
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect((await stub.getStatus()).policies).toEqual([]);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it.each(["unavailable", "lost response"])(
  "retries last-subscriber cleanup after restart when DELETE has %s",
  async (failure) => {
    const name = `cleanup-${failure}`;
    const stub = await setup(name);
    let deletes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method !== "DELETE") return Response.json({ success: true, result: [] });
        deletes++;
        if (deletes === 1) {
          if (failure === "lost response") throw new Error("Lost DELETE response");
          return new Response("{}", { status: 503 });
        }
        // A lost response may mean that ANS already deleted the policy.
        return failure === "lost response"
          ? new Response("{}", { status: 404 })
          : Response.json({ success: true });
      }),
    );
    await expectDisableFailure(
      stub,
      failure === "lost response" ? "Lost DELETE response" : "HTTP 503",
    );
    expect((await stub.getStatus()).subscribers).toBe(0);
    expect(await sendAlert(stub)).toBe(204);
    expect(await receivedAlerts()).toEqual([]);
    expect(
      await runInDurableObject(stub, async (_instance, state) => ({
        pending: state.storage.kv.get("policy:test_alert"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toMatchObject({
      pending: { needsReconcile: true },
      alarm: expect.any(Number),
    });

    await abortAllDurableObjects();
    const restarted = env.NOTIFICATION_RECEIVER.getByName(name);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect(deletes).toBe(2);
    expect((await restarted.getStatus()).policies).toEqual([]);
    expect(
      await runInDurableObject(restarted, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
  },
);

it("keeps retrying with capped backoff and clears the retry state after recovery", async () => {
  const stub = await setup("cleanup-backoff");
  let available = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      available
        ? Response.json({ success: true, result: [] })
        : new Response("{}", { status: 503 }),
    ),
  );
  await expectDisableFailure(stub, "HTTP 503");
  for (const delay of [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]) {
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const pending = await runInDurableObject(stub, async (_instance, state) => ({
      delay: state.storage.kv.get("policyCleanupRetryDelay"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(pending.delay).toBe(delay);
    expect(pending.alarm).toBeGreaterThanOrEqual(before + delay);
    expect((await stub.getStatus()).policies).toHaveLength(1);
  }
  available = true;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect((await stub.getStatus()).policies).toEqual([]);
  expect(
    await runInDurableObject(stub, async (_instance, state) => ({
      delay: state.storage.kv.get("policyCleanupRetryDelay"),
      alarm: await state.storage.getAlarm(),
    })),
  ).toEqual({ delay: undefined, alarm: null });
});

it("does not delete a policy needed by a subscriber enabled before the cleanup retry", async () => {
  const name = "cleanup-reenabled";
  const stub = await setup(name);
  const fetch = mockProvider(async (_url: string, init: RequestInit) => {
    if (init.method === "DELETE") throw new Error("Lost DELETE response");
    if (init.method === "POST")
      return Response.json({ success: true, result: { id: "e".repeat(32) } });
    return Response.json({ success: true, result: [] });
  });
  await expectDisableFailure(stub, "Lost DELETE response");
  await setup(name, "test_alert", "hook-2", false);
  expect((await stub.getStatus()).policies).toEqual([
    { alertType: "test_alert", policyId: "e".repeat(32) },
  ]);
  expect(await runDurableObjectAlarm(stub)).toBe(false);
  fetch.mockClear();
  // A stale, already-dispatched alarm must also recheck the current subscribers.
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(fetch).not.toHaveBeenCalled();
  expect((await stub.getStatus()).subscribers).toBe(1);
});

it("continues cleaning other unused policies when one policy's retry fails", async () => {
  const stub = await setup("cleanup-independent");
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.kv.put("policy:orphan_alert", {
      alertType: "orphan_alert",
      policyId: "e".repeat(32),
    }),
  );
  const deleted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        if (url.endsWith("b".repeat(32))) return new Response("{}", { status: 503 });
        deleted.push(url);
      }
      return Response.json({ success: true, result: [] });
    }),
  );
  await expectDisableFailure(stub, "HTTP 503");
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(deleted).toEqual([expect.stringContaining(`/policies/${"e".repeat(32)}`)]);
  expect((await stub.getStatus()).policies).toEqual([
    { alertType: "test_alert", policyId: "b".repeat(32) },
  ]);
  expect(
    await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
  ).not.toBeNull();
  await stub.revokeWithToken(null);
});

it("cancels pending cleanup on disconnect and ignores a stale alarm", async () => {
  const stub = await setup("cleanup-disconnect");
  const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expectDisableFailure(stub, "HTTP 503");
  expect(
    await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
  ).not.toBeNull();
  await stub.revokeWithToken(null);
  expect(await runDurableObjectAlarm(stub)).toBe(false);
  fetch.mockClear();
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(fetch).not.toHaveBeenCalled();
  expect(await stub.getStatus()).toMatchObject({ suspended: true, installed: false, policies: [] });
});

it("clears a late successful receipt after disabling its hook", async () => {
  const stub = await setup("disable-race");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, result: [] })),
  );
  await env.NOTIFICATION_TEST_HOOKS.blockCallback();
  const delivery = sendAlert(stub);
  await env.NOTIFICATION_TEST_HOOKS.waitUntilCallbackBlocked();
  const disabled = Promise.resolve(stub.disable("hook-1", "test_alert"));
  await expect
    .poll(() =>
      runInDurableObject(
        stub,
        (_instance, state) => state.storage.kv.get("hook:hook-1") === undefined,
      ),
    )
    .toBe(true);
  await env.NOTIFICATION_TEST_HOOKS.releaseCallback();
  expect(await delivery).toBe(204);
  await disabled;
  const receipts = await runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS count FROM notification_receipts").one().count,
  );
  expect(receipts).toBe(0);
});

it("rejects delivery when notification credentials are removed", async () => {
  const stub = await setup("expired");
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
  await runInDurableObject(account, (_instance, state) =>
    state.storage.kv.put("grantedScopes", []),
  );
  expect(await sendAlert(stub)).toBe(503);
  expect(await stub.getStatus()).toMatchObject({ credentials: "reconnect_required" });
  expect(await receivedAlerts()).toEqual([]);
});

it("does not report interrupted setup as complete", async () => {
  const stub = await setup("incomplete-setup");
  await runInDurableObject(stub, (_instance, state) => state.storage.kv.delete("setupComplete"));
  expect(await stub.getStatus()).toMatchObject({ installed: false, webhookId: "d".repeat(32) });
});

it("completes disconnect locally when the grant can no longer manage the account", async () => {
  for (const [label, token] of [
    ["denied", "test-access"],
    ["expired", null],
  ] as const) {
    const name = `revoke-${label}`;
    const stub = await setup(name);
    const fetch = mockProvider(async () => new Response("{}", { status: 403 }));
    await stub.revokeWithToken(token);
    if (token === null) expect(fetch).not.toHaveBeenCalled();
    expect(await stub.getStatus()).toMatchObject({
      suspended: true,
      installed: false,
      subscribers: 0,
    });
    expect(await sendAlert(stub)).toBe(410);
  }
});

it("keeps state for retry when disconnect cleanup fails transiently", async () => {
  const name = "revoke-transient";
  const stub = await setup(name);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const error = await stub.revokeWithToken("test-access").then(
    () => undefined,
    (caught: Error) => caught,
  );
  expect(error?.message).toContain("HTTP 503");
  expect(await stub.getStatus()).toMatchObject({
    suspended: true,
    policies: [{ alertType: "test_alert", policyId: "b".repeat(32) }],
  });
});

it("retries an orphaned policy's removal when another hook is enabled", async () => {
  const name = "orphaned-policy";
  const orphanId = "e".repeat(32);
  await runInDurableObject(env.NOTIFICATION_RECEIVER.getByName(name), (_instance, state) =>
    state.storage.kv.put("policy:orphan_alert", { alertType: "orphan_alert", policyId: orphanId }),
  );
  const deleted: string[] = [];
  mockProvider(async (input: string, init: RequestInit) => {
    if (init.method === "DELETE") deleted.push(input);
    return Response.json({ success: true, result: [] });
  });
  const stub = await setup(name);
  expect(deleted).toEqual([expect.stringMatching(new RegExp(`/policies/${orphanId}$`))]);
  expect((await stub.getStatus()).policies).toEqual([
    { alertType: "test_alert", policyId: "b".repeat(32) },
  ]);
});

it("uses an existing destination without creating a policy and routes its alerts", async () => {
  const fetch = mockProvider();
  const stub = await setup("external-policy", "test_alert", "hook-1", false, false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![1].method).toBe("GET");
  expect((await stub.getStatus()).policies).toEqual([]);
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
  await stub.disable("hook-1", "test_alert");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "recreates a deleted destination without losing existing subscribers (lost response: %s)",
  async (loseResponse) => {
    const name = `deleted-destination-${loseResponse}`;
    let stub = await setup(name, "test_alert", "hook-1", false, false);
    const replacementId = "e".repeat(32);
    let created: { id: string; url: string; secret: string } | undefined;
    let posts = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith(`/webhooks/${"d".repeat(32)}`)) return new Response(null, { status: 404 });
      if (init.method === "GET")
        return Response.json({
          success: true,
          result: url.endsWith(`/webhooks/${replacementId}`) ? created : created ? [created] : [],
        });
      if (init.method === "POST") {
        posts++;
        created = { ...JSON.parse(init.body as string), id: replacementId };
        if (loseResponse) throw new Error("Lost destination creation response");
      } else if (init.method === "PUT") {
        created = { ...JSON.parse(init.body as string), id: replacementId };
      } else throw new Error("Unexpected provider request");
      return Response.json({ success: true, result: { id: replacementId } });
    });
    vi.stubGlobal("fetch", fetch);
    if (loseResponse) {
      await expect(enableAdditionalHook(name)).rejects.toThrow(
        "Lost destination creation response",
      );
      expect(await stub.getStatus()).toMatchObject({ installed: false, subscribers: 1 });
      await abortAllDurableObjects();
      stub = env.NOTIFICATION_RECEIVER.getByName(name);
    }
    await enableAdditionalHook(name);
    expect(posts).toBe(1);
    expect(await stub.getStatus()).toMatchObject({
      installed: true,
      webhookId: replacementId,
      subscribers: 2,
      policies: [],
    });
    expect(await sendAlert(stub)).toBe(401);
    expect(await stub.receiveWebhook(created!.secret, "application/json", payload)).toBe(204);
    await stub.deliverPending();
    expect((await receivedAlerts()).map((alert) => alert.subscriber).toSorted()).toEqual([
      "hook-1",
      "hook-2",
    ]);
    expect(fetch.mock.calls.every(([url]) => !url.includes("/policies"))).toBe(true);
  },
);

it.each([403, 503])(
  "does not replace a destination or enable a hook when its live lookup fails with HTTP %s",
  async (status) => {
    const name = `destination-lookup-${status}`;
    const stub = await setup(name, "test_alert", "hook-1", false, false);
    const fetch = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(enableAdditionalHook(name)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await stub.getStatus()).toMatchObject({ webhookId: "d".repeat(32), subscribers: 1 });
  },
);

it("removes a managed policy when only external-policy subscribers remain", async () => {
  mockProvider(async () => Response.json({ success: true, result: [] }));
  const stub = await setup("mixed-policy");
  await setup("mixed-policy", "test_alert", "hook-2", false, false);
  await stub.disable("hook-1", "test_alert");
  expect((await stub.getStatus()).policies).toEqual([]);
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toEqual([expect.objectContaining({ subscriber: "hook-2" })]);
});

it("retries an interrupted address migration in place with the same pending secret", async () => {
  const stub = await setup(notificationReceiverName(userObjectId, accountId));
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.kv.put(
      "webhookUrl",
      `https://hooks.example/old/webhooks/${userObjectId}/${accountId}`,
    ),
  );
  const oldPath = `/old/webhooks/${userObjectId}/${accountId}`;
  expect(
    (
      await SELF.fetch(`https://hooks.example${oldPath}`, {
        method: "POST",
        headers: { "cf-webhook-auth": secret, "content-type": "application/json" },
        body: payload,
      })
    ).status,
  ).toBe(404);
  expect(
    await stub.receiveWebhook(
      secret,
      "application/json",
      payload,
      `/unrelated/webhooks/${userObjectId}/${accountId}`,
    ),
  ).toBe(404);
  const calls: { url: string; method?: string; body: { url: string; secret: string } }[] = [];
  mockProvider(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body as string) });
    if (calls.length === 1) throw new Error("Lost update response");
    return Response.json({ success: true, result: { id: "d".repeat(32) } });
  });
  const enable = () =>
    runInDurableObject(stub, async (instance, state) => {
      const exports = state.exports as unknown as {
        NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
      };
      await instance.enable(
        { accountId, userObjectId, hookId: "hook-2", alertType: "test_alert" },
        exports.NotificationTestHooks({ props: { hookId: "hook-2" } }) as unknown as Parameters<
          typeof instance.enable
        >[1],
      );
    });
  await expect(enable()).rejects.toThrow("Lost update response");
  expect(await sendAlert(stub)).toBe(204);
  expect(await stub.receiveWebhook(calls[0]!.body.secret, "application/json", payload)).toBe(204);
  await enable();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]!.url).toMatch(/destinations\/webhooks\/dddddddddddddddddddddddddddddddd$/);
  expect(calls[0]!.method).toBe("PUT");
  expect(await stub.receiveWebhook(calls[0]!.body.secret, "application/json", payload)).toBe(204);
  expect(await sendAlert(stub)).toBe(401);
  expect(
    await runInDurableObject(stub, (_instance, state) => state.storage.kv.get("addressMigration")),
  ).toBeUndefined();
  expect((await stub.getStatus()).webhookId).toBe("d".repeat(32));
});

it("isolates configured policies, shares canonical settings, and cleans up only the last managed subscriber", async () => {
  const policies = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  let nextId = 1;
  mockProvider(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      const id = String(nextId++).padStart(32, "0");
      policies.set(id, { ...JSON.parse(init.body as string), id });
      return Response.json({ success: true, result: { id } });
    }
    if (init.method === "DELETE") {
      const id = url.split("/").at(-1)!;
      deleted.push(id);
      policies.delete(id);
      return Response.json({ success: true });
    }
    return Response.json({ success: true, result: [...policies.values()] });
  });
  const first = { filters: { product: ["workers"], limit: ["100"] }, alertInterval: "30m" };
  const second = { filters: { product: ["workers"], limit: ["200"] }, alertInterval: "30m" };
  const stub = await setup("configured", "test_alert", "a", false, true, first);
  await setup("configured", "test_alert", "b", false, true, second);
  await setup("configured", "test_alert", "a-shared", false, true, {
    alertInterval: "30m",
    filters: { limit: ["100"], product: ["workers"] },
  });
  await setup("configured", "test_alert", "external", false, false);
  expect(policies.size).toBe(2);
  const ids = [...policies.keys()];
  const body = (id: string) => JSON.stringify({ ...JSON.parse(payload), policy_id: id });
  expect(await sendAlert(stub, body(ids[0]!))).toBe(204);
  expect((await receivedAlerts()).map((alert) => alert.subscriber).toSorted()).toEqual([
    "a",
    "a-shared",
    "external",
  ]);
  await setGadgetBehavior();
  expect(await sendAlert(stub, body(ids[1]!))).toBe(204);
  expect((await receivedAlerts()).map((alert) => alert.subscriber).toSorted()).toEqual([
    "b",
    "external",
  ]);
  await stub.disable("a", "test_alert");
  expect(deleted).toEqual([]);
  await stub.disable("a-shared", "test_alert");
  expect(deleted).toEqual([ids[0]]);
  expect(policies.size).toBe(1);
  await stub.revokeWithToken("test-access");
  expect(deleted).toContain(ids[1]);
  expect((await stub.getStatus()).subscribers).toBe(0);
});

it("recovers a configured policy after a lost POST without duplicating or widening it", async () => {
  let created: Record<string, unknown> | undefined;
  let posts = 0;
  mockProvider(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts++;
      created = { ...JSON.parse(init.body as string), id: "b".repeat(32) };
      throw new Error("Lost POST response");
    }
    return Response.json({ success: true, result: created ? [created] : [] });
  });
  const policy = { filters: { limit: ["100"], product: ["workers"] } };
  await expect(
    setup("lost-configured", "test_alert", "hook-1", false, true, policy),
  ).rejects.toThrow("Lost POST");
  const pending = env.NOTIFICATION_RECEIVER.getByName("lost-configured");
  expect(
    await runInDurableObject(pending, (_instance, state) => state.storage.getAlarm()),
  ).not.toBeNull();
  const stub = await setup("lost-configured", "test_alert", "hook-1", false, true, policy);
  expect(posts).toBe(1);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
});

it("rejects invalid settings before creating a hook or calling the provider", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("Unexpected provider call");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    setup("invalid-config", "test_alert", "hook", false, true, {
      filters: { threshold: ["10"] },
    } as unknown as CloudflareNotificationPolicySettings),
  ).rejects.toThrow("Unsupported ANS filter");
  await expect(
    setup("external-config", "test_alert", "hook", false, false, { alertInterval: "30m" }),
  ).rejects.toThrow("External notification");
  expect(fetch).not.toHaveBeenCalled();
});

it("shows exact configured settings at approval without provisioning and validates before binding", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("Unexpected provider call before approval");
  });
  vi.stubGlobal("fetch", fetch);
  const accountId = "9".repeat(32);
  const test = env.TEST_HOOKS.getByName("notification-approval");
  const settings = { filters: { product: ["workers"], limit: ["100"] }, alertInterval: "30m" };
  const { descriptions, error } = await test.subscribeNotification(
    { accountId, userObjectId },
    {
      alertType: "billing_usage_alert",
      policy: settings,
    },
  );
  expect(error).toBeNull();
  expect(descriptions).toHaveLength(1);
  expect(descriptions[0]!.description).toContain(
    JSON.stringify(
      { alertInterval: "30m", filters: { limit: ["100"], product: ["workers"] } },
      null,
      2,
    )
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );
  expect(descriptions[0]!.title).toContain(accountId);
  expect(descriptions[0]!.description).toContain("only that policy");
  const status = await env.NOTIFICATION_RECEIVER.getByName(
    notificationReceiverName(userObjectId, accountId),
  ).getStatus();
  expect(status).toMatchObject({ installed: false, subscribers: 0, policies: [] });
  expect(fetch).not.toHaveBeenCalled();
  const invalid = await test.subscribeNotification(
    { accountId, userObjectId },
    {
      alertType: "billing_usage_alert",
      createPolicy: false,
      policy: settings,
    },
  );
  expect(invalid.error).toContain("External notification");
  expect(invalid.descriptions).toEqual([]);
});

it("routes and cleans up historical hooks that lack configuration identity without recreating their policy", async () => {
  const stub = await setup("legacy-hook");
  await runInDurableObject(stub, (_instance, state) => {
    const stored = state.storage.kv.get<{
      props: { policyKey?: string };
      initiator: Fetcher<NotificationTestHooks>;
    }>("hook:hook-1")!;
    delete stored.props.policyKey;
    state.storage.kv.put("hook:hook-1", stored);
    (stored.initiator as Fetcher<NotificationTestHooks> & Partial<Disposable>)[Symbol.dispose]?.();
  });
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method}:${url}`);
      return Response.json({ success: true, result: [] });
    }),
  );
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
  expect(calls).toEqual([]);
  await stub.disable("hook-1", "test_alert");
  expect(calls.filter((call) => call.startsWith("DELETE:"))).toEqual([
    expect.stringContaining(`/policies/${"b".repeat(32)}`),
  ]);
});

it("rejects an enable from another connection owner before provider calls or delivery changes", async () => {
  const stub = await setup("owner-isolation");
  const fetch = vi.fn(async () => {
    throw new Error("Unexpected provider call");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    runInDurableObject(stub, async (instance, state) => {
      const exports = state.exports as unknown as {
        NotificationTestHooks(options: object): Fetcher<NotificationTestHooks>;
      };
      await instance.enable(
        { accountId, userObjectId: "f".repeat(64), hookId: "foreign", alertType: "test_alert" },
        exports.NotificationTestHooks({ props: { hookId: "foreign" } }) as unknown as Parameters<
          typeof instance.enable
        >[1],
      );
    }),
  ).rejects.toThrow("another account");
  expect(fetch).not.toHaveBeenCalled();
  expect((await stub.getStatus()).subscribers).toBe(1);
});

it("accepts before a blocked callback and lets disable finish without waiting for it", async () => {
  const stub = await setup("async-acceptance", "test_alert", "hook-1", false, false);
  await env.NOTIFICATION_TEST_HOOKS.blockCallback();
  expect(await stub.receiveWebhook(secret, "application/json", payload)).toBe(204);
  expect(await receivedAlerts()).toEqual([]);
  expect(await stub.getStatus()).toMatchObject({ pendingDeliveries: 1 });
  const delivery = stub.deliverPending();
  await env.NOTIFICATION_TEST_HOOKS.waitUntilCallbackBlocked();
  await stub.disable("hook-1", "test_alert");
  expect(await stub.getStatus()).toMatchObject({ subscribers: 0, pendingDeliveries: 0 });
  await env.NOTIFICATION_TEST_HOOKS.releaseCallback();
  await delivery;
});

it("does not let an unrelated managed alert type reject an external-policy notification", async () => {
  const name = "independent-routing";
  const stub = await setup(name, "other_alert");
  await setup(name, "test_alert", "external", false, false);
  const { policy_id: _policy, ...withoutPolicy } = JSON.parse(payload);
  expect(await sendAlert(stub, JSON.stringify(withoutPolicy))).toBe(204);
  expect(await receivedAlerts()).toEqual([expect.objectContaining({ subscriber: "external" })]);
});

it("retains accepted work across receiver restart", async () => {
  const name = "durable-handoff";
  const stub = await setup(name);
  expect(await stub.receiveWebhook(secret, "application/json", payload)).toBe(204);
  await abortAllDurableObjects();
  const restarted = env.NOTIFICATION_RECEIVER.getByName(name);
  await runDurableObjectAlarm(restarted);
  expect(await receivedAlerts()).toHaveLength(1);
  expect(await restarted.getStatus()).toMatchObject({ pendingDeliveries: 0 });
});

it("rejects over-capacity enqueue without acknowledging lost work", async () => {
  const stub = await setup("bounded-handoff");
  await sendAlert(stub);
  await runInDurableObject(stub, (_instance, state) => {
    for (let i = 0; i < 1000; ++i)
      state.storage.sql.exec(
        "INSERT INTO notification_deliveries VALUES (?, ?, ?, 0, ?)",
        `queued-${i}`,
        "hook-1",
        payload,
        Date.now() + 60_000,
      );
  });
  const body = JSON.stringify({ ...JSON.parse(payload), ts: 1234567891 });
  expect(await stub.receiveWebhook(secret, "application/json", body)).toBe(503);
  expect(await stub.getStatus()).toMatchObject({ pendingDeliveries: 1000 });
});

it("durably retries a disconnected account's transient provider cleanup failure", async () => {
  const stub = await setup(notificationReceiverName(userObjectId, accountId));
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
  await account.registerNotificationAccount(accountId);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const error = await account.revoke().then(
    () => undefined,
    (caught: Error) => caught,
  );
  expect(error?.message).toContain("HTTP 503");
  expect(
    await runInDurableObject(account, (_instance, state) => state.storage.getAlarm()),
  ).not.toBeNull();
  expect(await account.hasNotificationGrant()).toBe(false);
  expect(await sendAlert(stub)).toBe(410);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, result: [] })),
  );
  await runDurableObjectAlarm(account);
  expect(
    await runInDurableObject(account, (_instance, state) => [...state.storage.kv.list()]),
  ).toEqual([]);
  expect(await stub.getStatus()).toMatchObject({
    installed: false,
    suspended: true,
    subscribers: 0,
  });
});

it("finishes disconnect after a lost webhook deletion response and receiver restart", async () => {
  const account = env.USER_ACCOUNT.getByName("lost-webhook-deletion-response");
  const owner = { userObjectId: account.id.toString(), accountId };
  const name = notificationReceiverName(owner.userObjectId, accountId);
  const stub = env.NOTIFICATION_RECEIVER.getByName(name);
  const webhookUrl = `https://hooks.example/notifications/webhooks/${owner.userObjectId}/${accountId}`;
  await runInDurableObject(account, (_instance, state) => {
    state.storage.kv.put("refreshToken", "test-refresh");
    state.storage.kv.put("accessToken", { token: "test-access", expires: Date.now() + 86400_000 });
    state.storage.kv.put("grantedScopes", ["notifications.write"]);
  });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.kv.put("owner", owner);
    state.storage.kv.put("installation", { ...owner, webhookId: "d".repeat(32) });
    state.storage.kv.put("webhookUrl", webhookUrl);
    state.storage.kv.put("setupComplete", true);
  });
  await account.registerNotificationAccount(accountId);
  let deleted = false;
  const fetch = mockProvider(async (_url, init) => {
    if (init.method === "DELETE") {
      deleted = true;
      return Response.json({ success: false, errors: [{ code: 15000 }] }, { status: 500 });
    }
    return Response.json({
      success: true,
      result: deleted
        ? []
        : [
            {
              id: "d".repeat(32),
              url: webhookUrl,
            },
          ],
    });
  });
  const error = await account.revoke().then(
    () => undefined,
    (caught: Error) => caught,
  );
  expect(error?.message).toContain("HTTP 500");
  expect(await account.hasNotificationGrant()).toBe(false);
  expect(await sendAlert(stub)).toBe(410);
  await abortAllDurableObjects();
  const restarted = env.USER_ACCOUNT.getByName("lost-webhook-deletion-response");
  await runDurableObjectAlarm(restarted);
  expect(fetch.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
  expect(
    await runInDurableObject(restarted, (_instance, state) => [...state.storage.kv.list()]),
  ).toEqual([]);
  expect(await env.NOTIFICATION_RECEIVER.getByName(name).getStatus()).toMatchObject({
    installed: false,
    suspended: true,
    subscribers: 0,
  });
});

it("bounds a hanging handoff without blocking disable or losing its durable retry", async () => {
  const stub = await setup("handoff-timeout", "test_alert", "hook-1", false, false);
  await env.NOTIFICATION_TEST_HOOKS.blockCallback();
  expect(await stub.receiveWebhook(secret, "application/json", payload)).toBe(204);
  try {
    const delivery = stub.deliverPending();
    await env.NOTIFICATION_TEST_HOOKS.waitUntilCallbackBlocked();
    await delivery;
    expect(await stub.getStatus()).toMatchObject({ pendingDeliveries: 1, retryingDeliveries: 1 });
    await stub.disable("hook-1", "test_alert");
  } finally {
    await env.NOTIFICATION_TEST_HOOKS.releaseCallback();
  }
}, 15_000);

it("pauses accepted handoffs after grant expiry and resumes after reauthorization", async () => {
  const stub = await setup("queued-grant-expiry");
  expect(await stub.receiveWebhook(secret, "application/json", payload)).toBe(204);
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
  await runInDurableObject(account, (_instance, state) =>
    state.storage.kv.put("credentialsExpired", true),
  );
  await stub.deliverPending();
  expect(await receivedAlerts()).toEqual([]);
  expect(await stub.getStatus()).toMatchObject({
    pendingDeliveries: 1,
    credentials: "reconnect_required",
  });
  await runInDurableObject(account, (_instance, state) =>
    state.storage.kv.delete("credentialsExpired"),
  );
  await retryPending(stub);
  expect(await receivedAlerts()).toHaveLength(1);
});

it("does not accelerate policy-cleanup backoff when a delivery alarm fires", async () => {
  const name = "independent-alarm-deadlines";
  const stub = await setup(name);
  await setup(name, "test_alert", "hook-2", false, false);
  const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expectDisableFailure(stub, "HTTP 503");
  fetch.mockClear();
  expect(await stub.receiveWebhook(secret, "application/json", payload)).toBe(204);
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect(await receivedAlerts()).toEqual([expect.objectContaining({ subscriber: "hook-2" })]);
  expect(fetch).not.toHaveBeenCalled();
  expect(await stub.getStatus()).toMatchObject({
    pendingDeliveries: 0,
    policies: [{ policyId: "b".repeat(32) }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, result: [] })),
  );
  await runDurableObjectAlarm(stub);
  expect(await stub.getStatus()).toMatchObject({ policies: [] });
});
