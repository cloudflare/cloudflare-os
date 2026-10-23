import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
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

beforeEach(async () => {
  await setGadgetBehavior();
});
afterEach(() => vi.unstubAllGlobals());
async function setup(name: string, alertType = "test_alert", hookId = "hook-1", seedPolicy = true, createPolicy = true, policy?: CloudflareNotificationPolicySettings) {
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
    state.storage.kv.put("webhookUrl", `https://hooks.example/notifications/webhooks/${userObjectId}/${accountId}`);
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
    }),
  ]);
  const [observation] = await env.NOTIFICATION_TEST_HOOKS.readObservations();
  expect(observation!.description).toContain(`account ${accountId}`);
  // A restricted observation would permanently stop the workspace from taking actions, so an alert
  // could never lead to a fix being pushed.
  expect(observation!.containsRestrictedData).toBeUndefined();

  await sendAlert(stub);
  expect(await receivedAlerts()).toEqual(alerts);
});

it("retries policy-only alerts because routing requires an alert type", async () => {
  const stub = await setup("optional-fields", "test_alert", "hook-1", false, false);
  expect(await sendAlert(stub, JSON.stringify({ policy_id: "b".repeat(32), ts: 1234567890, data: {} }))).toBe(500);
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
  const body = JSON.stringify({ ...JSON.parse(payload), alert_type: alertType, policy_id: "b".repeat(32) });

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
  const unknown = env.NOTIFICATION_RECEIVER.getByName(notificationReceiverName("f".repeat(64), accountId));
  expect(await runInDurableObject(unknown, (_instance, state) =>
    state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_receipts'").toArray())).toEqual([]);
  expect(await runInDurableObject(unknown, (_instance, state) => [...state.storage.kv.list()])).toEqual([]);
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

it("completes disconnect locally when the grant can no longer manage the account", async () => {
  for (const [label, token] of [["denied", "test-access"], ["expired", null]] as const) {
    const name = `revoke-${label}`;
    const stub = await setup(name);
    const fetch = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await stub.revokeWithToken(token);
    if (token === null) expect(fetch).not.toHaveBeenCalled();
    expect(await stub.getStatus()).toMatchObject({ suspended: true, installed: false, subscribers: 0 });
    expect(await sendAlert(stub)).toBe(410);
  }
});

it("keeps state for retry when disconnect cleanup fails transiently", async () => {
  const name = "revoke-transient";
  const stub = await setup(name);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const error = await stub.revokeWithToken("test-access").then(() => undefined, (caught: Error) => caught);
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

it("uses an existing destination without creating a policy and routes its alerts", async () => {
  const fetch = vi.fn(async () => { throw new Error("No provider calls expected"); });
  vi.stubGlobal("fetch", fetch);
  const stub = await setup("external-policy", "test_alert", "hook-1", false, false);
  expect(fetch).not.toHaveBeenCalled();
  expect((await stub.getStatus()).policies).toEqual([]);
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
  await stub.disable("hook-1", "test_alert");
  expect(fetch).not.toHaveBeenCalled();
});

it("removes a managed policy when only external-policy subscribers remain", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: [] })));
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
    state.storage.kv.put("webhookUrl", `https://hooks.example/old/webhooks/${userObjectId}/${accountId}`));
  const oldPath = `/old/webhooks/${userObjectId}/${accountId}`;
  expect((await SELF.fetch(`https://hooks.example${oldPath}`, {
    method: "POST", headers: { "cf-webhook-auth": secret, "content-type": "application/json" }, body: payload,
  })).status).toBe(204);
  expect(await stub.receiveWebhook(secret, "application/json", payload, `/unrelated/webhooks/${userObjectId}/${accountId}`)).toBe(404);
  const calls: { url: string; method?: string; body: { url: string; secret: string } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body as string) });
    if (calls.length === 1) throw new Error("Lost update response");
    return Response.json({ success: true, result: { id: "d".repeat(32) } });
  }));
  const enable = () => runInDurableObject(stub, async (instance, state) => {
    const exports = state.exports as unknown as { NotificationTestHooks(options: object): Fetcher<NotificationTestHooks> };
    await instance.enable({ accountId, userObjectId, hookId: "hook-2", alertType: "test_alert" },
      exports.NotificationTestHooks({ props: { hookId: "hook-2" } }) as unknown as Parameters<typeof instance.enable>[1]);
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
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.kv.get("addressMigration"))).toBeUndefined();
  expect((await stub.getStatus()).webhookId).toBe("d".repeat(32));
});


it("isolates configured policies, shares canonical settings, and cleans up only the last managed subscriber", async () => {
  const policies = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  let nextId = 1;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
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
  }));
  const first = { filters: { product: ["workers"], limit: ["100"] }, alertInterval: "30m" };
  const second = { filters: { product: ["workers"], limit: ["200"] }, alertInterval: "30m" };
  const stub = await setup("configured", "test_alert", "a", false, true, first);
  await setup("configured", "test_alert", "b", false, true, second);
  await setup("configured", "test_alert", "a-shared", false, true,
    { alertInterval: "30m", filters: { limit: ["100"], product: ["workers"] } });
  await setup("configured", "test_alert", "external", false, false);
  expect(policies.size).toBe(2);
  const ids = [...policies.keys()];
  const body = (id: string) => JSON.stringify({ ...JSON.parse(payload), policy_id: id });
  expect(await sendAlert(stub, body(ids[0]!))).toBe(204);
  expect((await receivedAlerts()).map(alert => alert.subscriber).toSorted()).toEqual(["a", "a-shared", "external"]);
  await setGadgetBehavior();
  expect(await sendAlert(stub, body(ids[1]!))).toBe(204);
  expect((await receivedAlerts()).map(alert => alert.subscriber).toSorted()).toEqual(["b", "external"]);
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
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts++;
      created = { ...JSON.parse(init.body as string), id: "b".repeat(32) };
      throw new Error("Lost POST response");
    }
    return Response.json({ success: true, result: created ? [created] : [] });
  }));
  const policy = { filters: { limit: ["100"], product: ["workers"] } };
  await expect(setup("lost-configured", "test_alert", "hook-1", false, true, policy)).rejects.toThrow("Lost POST");
  const stub = await setup("lost-configured", "test_alert", "hook-1", false, true, policy);
  expect(posts).toBe(1);
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
});

it("rejects invalid settings before creating a hook or calling the provider", async () => {
  const fetch = vi.fn(async () => { throw new Error("Unexpected provider call"); });
  vi.stubGlobal("fetch", fetch);
  await expect(setup("invalid-config", "test_alert", "hook", false, true,
    { filters: { threshold: ["10"] } } as unknown as CloudflareNotificationPolicySettings)).rejects.toThrow("Unsupported ANS filter");
  await expect(setup("external-config", "test_alert", "hook", false, false,
    { alertInterval: "30m" })).rejects.toThrow("External notification");
  expect(fetch).not.toHaveBeenCalled();
});


it("shows exact configured settings at approval without provisioning and validates before binding", async () => {
  const fetch = vi.fn(async () => { throw new Error("Unexpected provider call before approval"); });
  vi.stubGlobal("fetch", fetch);
  const accountId = "9".repeat(32);
  const test = env.TEST_HOOKS.getByName("notification-approval");
  const settings = { filters: { product: ["workers"], limit: ["100"] }, alertInterval: "30m" };
  const { descriptions, error } = await test.subscribeNotification({ accountId, userObjectId }, {
    alertType: "billing_usage_alert", policy: settings,
  });
  expect(error).toBeNull();
  expect(descriptions).toHaveLength(1);
  expect(descriptions[0]!.description).toContain(JSON.stringify({ alertInterval: "30m", filters: { limit: ["100"], product: ["workers"] } }, null, 2).split("\n").map(line => `    ${line}`).join("\n"));
  expect(descriptions[0]!.title).toContain(accountId);
  expect(descriptions[0]!.description).toContain("only that policy");
  const status = await env.NOTIFICATION_RECEIVER.getByName(notificationReceiverName(userObjectId, accountId)).getStatus();
  expect(status).toMatchObject({ installed: false, subscribers: 0, policies: [] });
  expect(fetch).not.toHaveBeenCalled();
  const invalid = await test.subscribeNotification({ accountId, userObjectId }, {
    alertType: "billing_usage_alert", createPolicy: false, policy: settings,
  });
  expect(invalid.error).toContain("External notification");
  expect(invalid.descriptions).toEqual([]);
});

it("routes and cleans up historical hooks that lack configuration identity without recreating their policy", async () => {
  const stub = await setup("legacy-hook");
  await runInDurableObject(stub, (_instance, state) => {
    const stored = state.storage.kv.get<{ props: { policyKey?: string }; initiator: Fetcher<NotificationTestHooks> }>("hook:hook-1")!;
    delete stored.props.policyKey;
    state.storage.kv.put("hook:hook-1", stored);
    (stored.initiator as Fetcher<NotificationTestHooks> & Partial<Disposable>)[Symbol.dispose]?.();
  });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method}:${url}`);
    return Response.json({ success: true, result: [] });
  }));
  expect(await sendAlert(stub)).toBe(204);
  expect(await receivedAlerts()).toHaveLength(1);
  expect(calls).toEqual([]);
  await stub.disable("hook-1", "test_alert");
  expect(calls.filter(call => call.startsWith("DELETE:"))).toEqual([
    expect.stringContaining(`/policies/${"b".repeat(32)}`),
  ]);
});

it("rejects an enable from another connection owner before provider calls or delivery changes", async () => {
  const stub = await setup("owner-isolation");
  const fetch = vi.fn(async () => { throw new Error("Unexpected provider call"); });
  vi.stubGlobal("fetch", fetch);
  await expect(runInDurableObject(stub, async (instance, state) => {
    const exports = state.exports as unknown as { NotificationTestHooks(options: object): Fetcher<NotificationTestHooks> };
    await instance.enable({ accountId, userObjectId: "f".repeat(64), hookId: "foreign", alertType: "test_alert" },
      exports.NotificationTestHooks({ props: { hookId: "foreign" } }) as unknown as Parameters<typeof instance.enable>[1]);
  })).rejects.toThrow("another account");
  expect(fetch).not.toHaveBeenCalled();
  expect((await stub.getStatus()).subscribers).toBe(1);
});
