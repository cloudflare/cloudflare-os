import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointIndex } from "../src/endpoint-index.js";
import type { EndpointRegistry } from "../src/endpoint-registry.js";
import { MAX_BODY_BYTES } from "../src/endpoint-core.js";
import type { WebhookEvent } from "../src/types.js";

vi.mock("@gadgets/backend-utils/error-reporting", () => ({ reportIssue: vi.fn() }));

type TestHooks = {
  read(): Promise<{ events: string[]; received: WebhookEvent[] }>;
  reset(): Promise<void>;
};

const testEnv = env as unknown as {
  ENDPOINT_REGISTRY: DurableObjectNamespace<EndpointRegistry>;
  ENDPOINT_INDEX: DurableObjectNamespace<EndpointIndex>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

const BASE = "http://localhost:8787/gatekeeper/webhook";
const WORKSPACE = "workspace-1";
const REGISTRATION = { title: "Stripe", description: "Payment events", methods: ["POST"] };

let seq = 0;

/** Registers an enabled endpoint, wiring the public index the way the session normally would. */
async function liveEndpoint(): Promise<{ endpointId: string; token: string; account: string }> {
  const account = `account-${++seq}`;
  // Endpoint IDs must match the receiver's 22-character base64url pattern.
  const endpointId = `receiver${String(seq).padStart(2, "0")}aaaaaaaaaaaa`;
  const registry = testEnv.ENDPOINT_REGISTRY.getByName(account);
  const { token } = await registry.register(WORKSPACE, endpointId, REGISTRATION);
  await testEnv.ENDPOINT_INDEX.getByName(endpointId).claim(account);
  await runInDurableObject(registry, (instance) =>
    instance.enable(
      WORKSPACE,
      endpointId,
      (instance.ctx.exports as unknown as { TestHooks(o: object): never }).TestHooks({}),
    ),
  );
  return { endpointId, token, account };
}

function post(endpointId: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/e/${endpointId}`, {
    body: '{"id":"evt_1"}',
    ...init,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Accepted requests are queued and delivered on the registry's alarm, which fires on its own
 * shortly after. Poll rather than driving the alarm by hand so the test exercises the same path
 * production takes — and match on the event itself, since a previous test's delivery can still be
 * in flight when this one starts.
 */
async function waitForDelivery(match: (event: WebhookEvent) => boolean): Promise<WebhookEvent> {
  for (let i = 0; i < 200; i++) {
    const { received } = await testEnv.TEST_HOOKS.read();
    const found = received.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a matching webhook delivery.");
}

beforeEach(async () => {
  await testEnv.TEST_HOOKS.reset();
});

describe("public receiver", () => {
  it("accepts an authenticated request with 202 and a delivery ID", async () => {
    const { endpointId, token } = await liveEndpoint();
    const response = await post(endpointId, token);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("delivers the request to the workspace callback", async () => {
    const { endpointId, token } = await liveEndpoint();
    await post(endpointId, token, { headers: { "x-hub-signature-256": "sha256=abc" } });
    const event = await waitForDelivery((e) => e.headers["x-hub-signature-256"] !== undefined);
    expect(event.json).toEqual({ id: "evt_1" });
    // The signature header survives so a gadget can verify the payload...
    expect(event.headers["x-hub-signature-256"]).toBe("sha256=abc");
    // ...while the endpoint's own credential never reaches the workspace.
    expect(event.headers).not.toHaveProperty("authorization");
  });

  it("rejects a request with no or wrong credentials", async () => {
    const { endpointId, token } = await liveEndpoint();
    const anonymous = await post(endpointId, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="webhook"');
    expect((await post(endpointId, `${token}x`)).status).toBe(401);
  });

  it("404s an unclaimed or malformed endpoint ID without touching a registry", async () => {
    expect((await post("a".repeat(22), "token")).status).toBe(404);
    expect((await post("too-short", "token")).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/elsewhere`)).status).toBe(404);
  });

  it("405s a method the endpoint was not registered for", async () => {
    const { endpointId, token } = await liveEndpoint();
    const response = await SELF.fetch(`${BASE}/e/${endpointId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(405);
  });

  it("passes a sub-path and query through to the event", async () => {
    const { endpointId, token } = await liveEndpoint();
    await SELF.fetch(`${BASE}/e/${endpointId}/payments?tenant=acme`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    const event = await waitForDelivery((e) => e.subPath === "/payments");
    expect(event).toMatchObject({ subPath: "/payments", query: { tenant: "acme" } });
  });

  it("truncates an oversized body instead of rejecting or buffering it", async () => {
    const { endpointId, token } = await liveEndpoint();
    const response = await post(endpointId, token, {
      body: "x".repeat(MAX_BODY_BYTES + 5_000),
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(202);
    const event = await waitForDelivery((e) => e.truncated === true);
    expect(new TextEncoder().encode(event.body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(event.json).toBeUndefined();
  });
});
