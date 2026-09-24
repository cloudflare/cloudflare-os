import { abortAllDurableObjects, env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebhookReceiver } from "../../src/webhook.js";
import type { TestHooks } from "../worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    WEBHOOK_RECEIVER: DurableObjectNamespace<WebhookReceiver>;
    TEST_HOOKS: Fetcher<TestHooks>;
  }
}

const receiverName = "00000000-0000-4000-8000-000000000001";
const accountId = "account-one";

async function issue(
  receiver: DurableObjectStub<WebhookReceiver>,
  endpointName: string,
  headerName = "Authorization",
  valuePrefix = "Bearer ",
): Promise<string> {
  expect(await receiver.claim(accountId, endpointName)).toBe(true);
  const reservation = await receiver.reserveCredential(accountId);
  expect(reservation).not.toBeNull();
  const headerValue = `${valuePrefix}${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(headerValue));
  const valueHash = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  expect(await receiver.commitCredential(accountId, endpointName, reservation!, { headerName, valueHash }))
    .toBe(true);
  return headerValue;
}

async function post(
  endpointId: string,
  credential: string,
  headers: Record<string, string> = {},
  body = "{}",
) {
  return SELF.fetch(`http://localhost/gatekeeper/webhook/hooks/${endpointId}`, {
    method: "POST",
    headers: { Authorization: credential, "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("WebhookReceiver credentials", () => {
  it("rotates endpoint credentials when issuance is retried", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(receiverName);
    const first = await issue(receiver, receiverName);
    expect((await post(receiverName, first)).status).toBe(409);
    expect((await post(receiverName, "0".repeat(64))).status).toBe(401);
    const second = await issue(receiver, receiverName);
    expect((await post(receiverName, first)).status).toBe(401);
    expect((await post(receiverName, second)).status).toBe(409);
  });

  it("serializes concurrent credential issuance", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(`${receiverName}:concurrent`);
    await receiver.claim(accountId, `${receiverName}:concurrent`);
    const results = await Promise.allSettled([
      Promise.resolve(receiver.reserveCredential(accountId)),
      Promise.resolve(receiver.reserveCredential(accountId)),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "fulfilled" && result.value !== null))
      .toHaveLength(1);
  });

  it("prevents another account from claiming a copied endpoint ID", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(
      "00000000-0000-4000-8000-000000000007",
    );
    expect(await receiver.claim(accountId, "00000000-0000-4000-8000-000000000007")).toBe(true);
    expect(await receiver.claim(accountId, "00000000-0000-4000-8000-000000000007")).toBe(true);
    expect(await receiver.claim("account-two", "00000000-0000-4000-8000-000000000007")).toBe(false);
    expect(await receiver.reserveCredential("account-two")).toBeNull();
  });

  it("isolates credentials between named endpoints", async () => {
    const first = env.WEBHOOK_RECEIVER.getByName("00000000-0000-4000-8000-000000000002");
    const second = env.WEBHOOK_RECEIVER.getByName("00000000-0000-4000-8000-000000000003");
    const firstKey = await issue(first, "00000000-0000-4000-8000-000000000002");
    const secondKey = await issue(second, "00000000-0000-4000-8000-000000000003");

    expect((await post("00000000-0000-4000-8000-000000000002", firstKey)).status).toBe(409);
    expect((await post("00000000-0000-4000-8000-000000000002", secondKey)).status).toBe(401);
    expect((await post("00000000-0000-4000-8000-000000000003", firstKey)).status).toBe(401);
    expect((await post("00000000-0000-4000-8000-000000000003", secondKey)).status).toBe(409);
  });

  it("rejects a credential issued for another endpoint over HTTP", async () => {
    const firstId = "00000000-0000-4000-8000-000000000004";
    const secondId = "00000000-0000-4000-8000-000000000005";
    const first = env.WEBHOOK_RECEIVER.getByName(firstId);
    const second = env.WEBHOOK_RECEIVER.getByName(secondId);
    const firstKey = await issue(first, firstId);
    await issue(second, secondId);
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${secondId}`,
      {
        method: "POST",
        headers: {
          Authorization: firstKey,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(401);
  });

  it("accepts nested valid JSON without a second validation pass", async () => {
    const nestedEndpointId = "00000000-0000-4000-8000-000000000008";
    const receiver = env.WEBHOOK_RECEIVER.getByName(nestedEndpointId);
    const headerValue = await issue(receiver, nestedEndpointId);
    const body = "[".repeat(100) + "null" + "]".repeat(100);
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${nestedEndpointId}`,
      {
        method: "POST",
        headers: {
          Authorization: headerValue,
          "Content-Type": "application/json",
        },
        body,
      },
    );
    expect(response.status).toBe(409);
  });

  it("accepts a raw secret in a provider-specific header", async () => {
    const providerEndpointId = "00000000-0000-4000-8000-000000000006";
    const receiver = env.WEBHOOK_RECEIVER.getByName(providerEndpointId);
    const headerValue = await issue(receiver, providerEndpointId, "cf-webhook-auth", "");
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${providerEndpointId}`,
      {
        method: "POST",
        headers: {
          "cf-webhook-auth": headerValue,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(409);
    const wrongHeader = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${providerEndpointId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${headerValue}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(wrongHeader.status).toBe(401);
  });
});

describe("Webhook delivery lifecycle", () => {
  async function configured() {
    await env.TEST_HOOKS.reset();
    const endpointId = crypto.randomUUID();
    const receiver = env.WEBHOOK_RECEIVER.getByName(endpointId);
    const credential = await issue(receiver, endpointId);
    await runInDurableObject(receiver, instance => {
      const exports = instance.ctx.exports as unknown as {
        TestHooks(options: object): Fetcher<TestHooks>;
      };
      return instance.enable(accountId, "hook-one", exports.TestHooks({}));
    });
    return { endpointId, receiver, credential };
  }

  it("starts, authorizes, invokes, and disposes a real hook session", async () => {
    const { endpointId, credential } = await configured();
    expect((await post(endpointId, credential)).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).events).toEqual(["start", "authorize", "callback"]);
    await expect.poll(async () => {
      const state = await env.TEST_HOOKS.read();
      return [state.disposedCallbacks, state.disposedQueues];
    }).toEqual([1, 1]);
  });

  it("replaces a stale subscription and ignores its late disable", async () => {
    const { endpointId, receiver, credential } = await configured();
    await runInDurableObject(receiver, instance => {
      const exports = instance.ctx.exports as unknown as {
        TestHooks(options: object): Fetcher<TestHooks>;
      };
      return instance.enable(accountId, "hook-two", exports.TestHooks({}));
    });
    await receiver.disable("hook-one");
    expect((await post(endpointId, credential)).status).toBe(204);
  });

  it("treats identical bodies as distinct without Idempotency-Key", async () => {
    const { endpointId, credential } = await configured();
    expect((await post(endpointId, credential)).status).toBe(204);
    expect((await post(endpointId, credential)).status).toBe(204);
    const { deliveries } = await env.TEST_HOOKS.read();
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.id).not.toBe(deliveries[1]!.id);
  });

  it("deduplicates retries that supply Idempotency-Key", async () => {
    const { endpointId, credential } = await configured();
    const headers = { "Idempotency-Key": "provider-delivery-1" };
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
  });

  it("deduplicates retries with long idempotency keys", async () => {
    const { endpointId, credential } = await configured();
    const headers = { "Idempotency-Key": "k".repeat(201) };
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
  });

  it("does not store receipts for unkeyed requests", async () => {
    const { endpointId, receiver, credential } = await configured();
    expect((await post(endpointId, credential)).status).toBe(204);
    expect((await post(endpointId, credential)).status).toBe(204);
    const count = await runInDurableObject(receiver, (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS count FROM webhook_receipts").one().count);
    expect(count).toBe(0);
  });

  it("coalesces concurrent retries while a callback is running", async () => {
    const { endpointId, credential } = await configured();
    await env.TEST_HOOKS.blockCallback();
    const headers = { "Idempotency-Key": "concurrent-delivery" };
    const first = post(endpointId, credential, headers);
    await env.TEST_HOOKS.waitUntilCallbackBlocked();
    const second = post(endpointId, credential, headers);
    await env.TEST_HOOKS.releaseCallback();
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
  });

  it("retains endpoint and receipt state across Durable Object resets", async () => {
    const { endpointId, credential } = await configured();
    const headers = { "Idempotency-Key": "reset-delivery" };
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    await abortAllDurableObjects();
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
  });

  it("returns callback failures and permits the sender to retry", async () => {
    const { endpointId, credential } = await configured();
    await env.TEST_HOOKS.configure("callback-reject");
    const headers = { "Idempotency-Key": "retryable" };
    expect((await post(endpointId, credential, headers)).status).toBe(502);
    await env.TEST_HOOKS.configure("success");
    expect((await post(endpointId, credential, headers)).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(2);
  });

  it.each(["start-reject", "authorization-reject"] as const)(
    "returns %s failures without recording a receipt",
    async mode => {
      const { endpointId, credential } = await configured();
      const headers = { "Idempotency-Key": mode };
      await env.TEST_HOOKS.configure(mode);
      expect((await post(endpointId, credential, headers)).status).toBe(502);
      await env.TEST_HOOKS.configure("success");
      expect((await post(endpointId, credential, headers)).status).toBe(204);
      expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
    },
  );

  it("rejects invalid credentials before reading or parsing the body", async () => {
    const { endpointId } = await configured();
    const response = await post(endpointId, "wrong", {}, "[not-json");
    expect(response.status).toBe(401);
    expect((await env.TEST_HOOKS.read()).events).toEqual([]);
    expect((await post(endpointId, "x".repeat(1_000), {}, "[not-json")).status).toBe(401);
  });

  it("rejects unknown endpoint IDs without initializing their receiver", async () => {
    const endpointId = crypto.randomUUID();
    const receiver = env.WEBHOOK_RECEIVER.getByName(endpointId);
    const response = await post(endpointId, "attacker-controlled", {}, "[not-json");
    expect(response.status).toBe(401);
    const initialized = await runInDurableObject(receiver, (_instance, state) => ({
      endpoint: state.storage.kv.get("state"),
      receiptTables: state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_receipts'",
      ).toArray().length,
    }));
    expect(initialized).toEqual({ endpoint: undefined, receiptTables: 0 });
  });

  it("does not let an expired receipt suppress a new delivery", async () => {
    const { endpointId, receiver, credential } = await configured();
    const key = "old-delivery";
    const digest = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`key:${key}`),
    );
    const eventId = [...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(receiver, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO webhook_receipts VALUES (?, ?)", eventId, Date.now() - 16 * 24 * 60 * 60 * 1000,
      );
    });
    expect((await post(endpointId, credential, { "Idempotency-Key": key })).status).toBe(204);
    expect((await post(endpointId, credential, { "Idempotency-Key": key })).status).toBe(204);
    expect((await env.TEST_HOOKS.read()).deliveries).toHaveLength(1);
  });

  it("permanently tombstones a revoked endpoint", async () => {
    const { endpointId, receiver, credential } = await configured();
    await receiver.disableAll(accountId, endpointId);
    expect((await post(endpointId, credential)).status).toBe(401);
    expect(await receiver.claim(accountId, endpointId)).toBe(false);
    expect(await receiver.reserveCredential(accountId)).toBeNull();
  });

  it("clears receipts after an admitted keyed callback finishes during revocation", async () => {
    const { endpointId, receiver, credential } = await configured();
    await env.TEST_HOOKS.blockCallback();
    const delivery = post(endpointId, credential, { "Idempotency-Key": "revoked-delivery" });
    await env.TEST_HOOKS.waitUntilCallbackBlocked();
    const revocation = Promise.resolve(receiver.disableAll(accountId, endpointId));
    await expect.poll(() => runInDurableObject(receiver, (_instance, state) =>
      (state.storage.kv.get("state") as { status?: string } | undefined)?.status))
      .toBe("revoked");
    await env.TEST_HOOKS.releaseCallback();
    expect((await delivery).status).toBe(204);
    await revocation;
    const receipts = await runInDurableObject(receiver, (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS count FROM webhook_receipts").one().count);
    expect(receipts).toBe(0);
    expect((await post(endpointId, credential)).status).toBe(401);
  });

  it("waits for an unkeyed callback before revocation completes", async () => {
    const { endpointId, receiver, credential } = await configured();
    await env.TEST_HOOKS.blockCallback();
    const delivery = post(endpointId, credential);
    await env.TEST_HOOKS.waitUntilCallbackBlocked();
    let revoked = false;
    const revocation = Promise.resolve(receiver.disableAll(accountId, endpointId))
      .then(() => { revoked = true; });
    await expect.poll(() => runInDurableObject(receiver, (_instance, state) =>
      (state.storage.kv.get("state") as { status?: string } | undefined)?.status))
      .toBe("revoked");
    expect(revoked).toBe(false);
    await env.TEST_HOOKS.releaseCallback();
    expect((await delivery).status).toBe(204);
    await revocation;
    expect(revoked).toBe(true);
  });

  it("rejects a credential rotated after the router admitted a request", async () => {
    const { endpointId, receiver, credential } = await configured();
    const replacement = await issue(receiver, endpointId);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
    const oldHash = [...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    expect(await receiver.deliver(oldHash, {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(), payload: {},
    })).toBe(401);
    expect((await post(endpointId, replacement)).status).toBe(204);
  });
});
