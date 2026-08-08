import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import type { EndpointIndex } from "../src/endpoint-index.js";
import { EndpointRegistry } from "../src/endpoint-registry.js";
import type { ReceiveInput } from "../src/endpoint-registry.js";
import type { WebhookEvent } from "../src/types.js";

vi.mock("@gadgets/backend-utils/error-reporting", () => ({ reportIssue: vi.fn() }));

type TestHooks = HookInitiator<never> & {
  configure(mode: "success" | "start-reject" | "authorization-reject" | "callback-reject"): Promise<void>;
  read(): Promise<{ events: string[]; received: WebhookEvent[]; disposedApprovalQueues: number }>;
  reset(): Promise<void>;
};

const testEnv = env as unknown as {
  ENDPOINT_REGISTRY: DurableObjectNamespace<EndpointRegistry>;
  ENDPOINT_INDEX: DurableObjectNamespace<EndpointIndex>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

const WORKSPACE = "workspace-1";
const REGISTRATION = { title: "Stripe", description: "Payment events", methods: ["POST"] };

let accountSeq = 0;

function newRegistry(): DurableObjectStub<EndpointRegistry> {
  return testEnv.ENDPOINT_REGISTRY.getByName(`account-${++accountSeq}`);
}

function testInitiator(registry: EndpointRegistry): Fetcher<TestHooks> {
  // The pool wraps env capabilities, so mint the persistable entrypoint inside the Worker.
  const exports = registry.ctx.exports as unknown as {
    TestHooks(options: object): Fetcher<TestHooks>;
  };
  return exports.TestHooks({});
}

function enable(
  registry: DurableObjectStub<EndpointRegistry>,
  endpointId: string,
  gadgetId?: number,
): Promise<void> {
  return runInDurableObject(registry, (instance) =>
    instance.enable(WORKSPACE, endpointId, testInitiator(instance) as never, gadgetId),
  );
}

function receiveInput(endpointId: string, token: string | null, overrides: Partial<ReceiveInput> = {}): ReceiveInput {
  return {
    endpointId,
    token,
    method: "POST",
    subPath: "",
    query: {},
    headers: { "content-type": "application/json" },
    body: '{"id":"evt_1"}',
    truncated: false,
    ...overrides,
  };
}

/**
 * Accepts a request whose delivery is due far in the future, so the registry arms its alarm for
 * later instead of firing it in the background. Tests then call `deliverNow()` to run exactly one
 * alarm pass at a moment of their choosing.
 */
function receiveDeferred(
  registry: DurableObjectStub<EndpointRegistry>,
  input: ReceiveInput,
): Promise<Awaited<ReturnType<EndpointRegistry["receive"]>>> {
  return registry.receive(input, Date.now() + 600_000);
}

/** Makes every queued delivery due, then runs one alarm pass. */
async function deliverNow(registry: DurableObjectStub<EndpointRegistry>): Promise<void> {
  await runInDurableObject(registry, (_instance, state) => {
    for (const [key, value] of state.storage.kv.list<{ dueAt: number }>({ prefix: "queue:" })) {
      state.storage.kv.put(key, { ...value, dueAt: 1 });
    }
  });
  expect(await runDurableObjectAlarm(registry)).toBe(true);
}

/**
 * Asserts that an RPC call rejects. `expect().rejects` leaves the underlying pipelined stub promise
 * looking unhandled to the pool, so attach the handler directly instead.
 */
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String(caught)).toMatch(pattern);
}

beforeEach(async () => {
  await testEnv.TEST_HOOKS.reset();
});

// Drop pool storage between tests, so a registry that still has an armed alarm cannot deliver into
// the next test — a late delivery surfaces as an unhandled rejection with no test to attribute it to.
afterEach(() => reset());

describe("registration", () => {
  it("mints a URL under BASE_URL and a token that is not stored in the clear", async () => {
    const registry = newRegistry();
    const credentials = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    expect(credentials.url).toBe("http://localhost:8787/gatekeeper/webhook/e/endpoint-1");
    expect(credentials.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await runInDurableObject(registry, (_instance, state) =>
      state.storage.kv.get<{ tokenHash: string }>(`endpoint:${WORKSPACE}:endpoint-1`),
    );
    expect(stored?.tokenHash).not.toContain(credentials.token);
  });

  it("starts disabled, so the URL exists but rejects deliveries", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    const result = await receiveDeferred(registry, receiveInput("endpoint-1", token));
    expect(result).toMatchObject({ accepted: false, status: 503 });

    const [summary] = await registry.listWorkspace(WORKSPACE);
    expect(summary.status).toBe("disabled");
  });

  it("enforces the per-workspace quota", async () => {
    const registry = newRegistry();
    for (let i = 0; i < 50; i++) {
      await registry.register(WORKSPACE, `endpoint-${i}`, REGISTRATION);
    }
    await expectRejection(
      registry.register(WORKSPACE, "overflow", REGISTRATION),
      /already has 50 webhook endpoints/,
    );
  });
});

describe("authentication", () => {
  it("rejects a missing or wrong token before revealing anything else", async () => {
    const registry = newRegistry();
    await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");

    expect(await receiveDeferred(registry, receiveInput("endpoint-1", null))).toMatchObject({ status: 401 });
    expect(await receiveDeferred(registry, receiveInput("endpoint-1", "wrong"))).toMatchObject({
      status: 401,
    });
    // A wrong token on a method the endpoint doesn't accept still reports 401, not 405.
    expect(
      await receiveDeferred(registry, receiveInput("endpoint-1", "wrong", { method: "DELETE" })),
    ).toMatchObject({ status: 401 });
  });

  it("rejects an unknown endpoint with 404", async () => {
    const registry = newRegistry();
    expect(await receiveDeferred(registry, receiveInput("missing", "t"))).toMatchObject({ status: 404 });
  });

  it("rejects a method the endpoint was not registered for", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    expect(
      await receiveDeferred(registry, receiveInput("endpoint-1", token, { method: "DELETE" })),
    ).toMatchObject({ status: 405 });
  });

  it("rotates a token, invalidating the previous one and keeping the URL", async () => {
    const registry = newRegistry();
    const first = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    const second = await registry.rotateToken("endpoint-1", WORKSPACE);

    expect(second.url).toBe(first.url);
    expect(second.token).not.toBe(first.token);
    expect(await receiveDeferred(registry, receiveInput("endpoint-1", first.token))).toMatchObject({
      status: 401,
    });
    expect(await receiveDeferred(registry, receiveInput("endpoint-1", second.token))).toMatchObject({
      accepted: true,
    });
  });
});

describe("delivery", () => {
  it("queues an accepted request and delivers the event on the alarm", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1", 7);

    const result = await receiveDeferred(
      registry,
      receiveInput("endpoint-1", token, { subPath: "/payments", query: { a: "1" } }),
    );
    expect(result).toMatchObject({ accepted: true });

    await deliverNow(registry);
    const { events, received } = await testEnv.TEST_HOOKS.read();
    expect(events.some((event) => event.startsWith("authorize:Webhook delivery"))).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      endpointId: "endpoint-1",
      method: "POST",
      subPath: "/payments",
      query: { a: "1" },
      attempt: 1,
    });
    expect(received[0].json).toEqual({ id: "evt_1" });

    const [summary] = await registry.listWorkspace(WORKSPACE);
    expect(summary).toMatchObject({ deliveryCount: 1, failedCount: 0, status: "active" });
    const [delivery] = await registry.listDeliveries("endpoint-1", WORKSPACE);
    expect(delivery).toMatchObject({ outcome: "delivered", attempts: 1 });
  });

  it("never puts the payload in the observation description", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await receiveDeferred(registry, receiveInput("endpoint-1", token, { body: '{"secret":"hunter2"}' }));
    await deliverNow(registry);

    const { events } = await testEnv.TEST_HOOKS.read();
    expect(events.join("\n")).not.toContain("hunter2");
  });

  it("retries a throwing callback instead of dropping the delivery", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await testEnv.TEST_HOOKS.configure("callback-reject");
    await receiveDeferred(registry, receiveInput("endpoint-1", token));
    await deliverNow(registry);

    const [delivery] = await registry.listDeliveries("endpoint-1", WORKSPACE);
    expect(delivery).toMatchObject({ outcome: "queued", attempts: 1 });
    expect(delivery.error).toBeDefined();
    // Still queued, so the alarm was re-armed for the backoff rather than cleared.
    expect(
      await runInDurableObject(registry, (_i, state) => state.storage.getAlarm()),
    ).not.toBeNull();
  });

  it("drops queued deliveries when the hook is disabled", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await receiveDeferred(registry, receiveInput("endpoint-1", token));
    await registry.disable(WORKSPACE, "endpoint-1");

    await runDurableObjectAlarm(registry);
    const { received } = await testEnv.TEST_HOOKS.read();
    expect(received).toHaveLength(0);
  });

  it("fails a delivery terminally when its capability vanished mid-flight", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await receiveDeferred(registry, receiveInput("endpoint-1", token));
    // Simulate the narrow race disable() cannot cover: the capability is gone but the queue is not.
    await runInDurableObject(registry, (_instance, state) => {
      for (const [key] of state.storage.kv.list({ prefix: "caps:" })) state.storage.kv.delete(key);
    });
    await deliverNow(registry);

    const [delivery] = await registry.listDeliveries("endpoint-1", WORKSPACE);
    expect(delivery).toMatchObject({ outcome: "failed" });
    expect((await testEnv.TEST_HOOKS.read()).received).toHaveLength(0);
  });

  it("marks an endpoint failing once a delivery exhausts its attempts", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await testEnv.TEST_HOOKS.configure("authorization-reject");
    await receiveDeferred(registry, receiveInput("endpoint-1", token));

    // Force the queued delivery to its final attempt so one alarm pass exhausts it.
    await runInDurableObject(registry, (_instance, state) => {
      for (const [key, value] of state.storage.kv.list<{ attempt: number }>({ prefix: "queue:" })) {
        state.storage.kv.put(key, { ...value, attempt: 7 });
      }
    });
    await deliverNow(registry);

    const [summary] = await registry.listWorkspace(WORKSPACE);
    expect(summary).toMatchObject({ failedCount: 1, status: "failing" });
    const [delivery] = await registry.listDeliveries("endpoint-1", WORKSPACE);
    expect(delivery).toMatchObject({ outcome: "failed", error: "Observation authorization was denied." });
  });

  it("sheds a flood past the per-minute limit", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    // One fixed instant, far enough ahead that nothing is due while the window fills.
    const now = Date.now() + 600_000;
    for (let i = 0; i < 60; i++) {
      expect(await registry.receive(receiveInput("endpoint-1", token), now)).toMatchObject({
        accepted: true,
      });
    }
    expect(await registry.receive(receiveInput("endpoint-1", token), now)).toMatchObject({
      status: 429,
    });
  });
});

describe("lifecycle", () => {
  it("keeps the URL and token across a disable/enable cycle", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await enable(registry, "endpoint-1");
    await registry.disable(WORKSPACE, "endpoint-1");
    expect(await receiveDeferred(registry, receiveInput("endpoint-1", token))).toMatchObject({ status: 503 });

    await enable(registry, "endpoint-1");
    expect(await receiveDeferred(registry, receiveInput("endpoint-1", token))).toMatchObject({
      accepted: true,
    });
  });

  it("makes a revoked endpoint stop resolving", async () => {
    const registry = newRegistry();
    const { token } = await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await testEnv.ENDPOINT_INDEX.getByName("endpoint-1").claim("account-x");
    await enable(registry, "endpoint-1");
    await registry.revokeEndpoint("endpoint-1", WORKSPACE);

    expect(await receiveDeferred(registry, receiveInput("endpoint-1", token))).toMatchObject({ status: 404 });
    expect(await testEnv.ENDPOINT_INDEX.getByName("endpoint-1").resolve()).toBeNull();
    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(0);
  });

  it("ignores enablement of an endpoint that was already revoked", async () => {
    const registry = newRegistry();
    await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await registry.revokeEndpoint("endpoint-1", WORKSPACE);
    await enable(registry, "endpoint-1");
    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(0);
  });

  it("revokes the whole account, releasing every public ID", async () => {
    const registry = newRegistry();
    await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await testEnv.ENDPOINT_INDEX.getByName("endpoint-1").claim("account-y");
    await registry.revoke();

    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(0);
    expect(await testEnv.ENDPOINT_INDEX.getByName("endpoint-1").resolve()).toBeNull();
    // Call in-process: a rejection crossing the RPC boundary is reported twice by the test pool.
    const caught = await runInDurableObject(registry, (instance) =>
      instance
        .register(WORKSPACE, "endpoint-2", REGISTRATION)
        .then(() => "", (error: unknown) => String(error)),
    );
    expect(caught).toMatch(/disconnected/);
  });

  it("scopes listings to one workspace", async () => {
    const registry = newRegistry();
    await registry.register(WORKSPACE, "endpoint-1", REGISTRATION);
    await registry.register("workspace-2", "endpoint-2", REGISTRATION);

    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(1);
    expect((await registry.listAccount()).endpoints).toHaveLength(2);
    // A workspace cannot read another workspace's delivery history through the shared account.
    expect(await registry.listDeliveries("endpoint-2", WORKSPACE)).toHaveLength(0);
  });
});
