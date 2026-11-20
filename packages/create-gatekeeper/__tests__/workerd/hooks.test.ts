// The `--hooks subscription` driver of a generated gatekeeper: the webhooks it adds and deletes
// at the template's invented provider, faked at `fetch`, and the deliveries it takes. A hook's
// firing needs the Workshop's initiator, which this pool has no stand-in for, so no event is
// queued here: what delivers one is the kit's registry, which its own suite covers.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcmeHookDriver } from "#gatekeeper/acme-hook-driver";
import type { Outcome } from "./worker";

const BASE_URL = "https://gadgets.test/gatekeeper/acme";
const testEnv = env as any;

/** The provider's webhook calls: every one made, and the webhooks it now has, by id. */
function fakeProvider(refuseDelete?: () => number | undefined) {
  const calls: string[] = [];
  const webhooks = new Map<string, { url: string; secret: string }>();
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push(`${request.method} ${pathname} as ${request.headers.get("Authorization")}`);
    const id = /^\/items\/[^/]+\/webhooks\/([^/]+)$/.exec(pathname)?.[1];
    if (request.method === "POST" && /^\/items\/[^/]+\/webhooks$/.test(pathname)) {
      const made = `w${webhooks.size + 1}`;
      webhooks.set(made, await request.json());
      return Response.json({ id: made });
    }
    if (id !== undefined && request.method === "GET") {
      return webhooks.has(id) ? Response.json({ id }) : new Response(null, { status: 404 });
    }
    if (id !== undefined && request.method === "DELETE") {
      const refusal = refuseDelete?.();
      if (refusal !== undefined) return new Response(null, { status: refusal });
      webhooks.delete(id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake provider: ${request.method} ${pathname} is not routed`);
  });
  return { calls, webhooks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An account connected with `key`, the way a completed connect leaves one. */
async function connected(key: string): Promise<string> {
  const id = testEnv.USER_ACCOUNT.newUniqueId().toString();
  await runInDurableObject(testEnv.USER_ACCOUNT.get(testEnv.USER_ACCOUNT.idFromString(id)),
    async (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("credentials", { accessToken: key });
      state.storage.kv.put("identity", { userId: "u-alice", name: "Alice", fetchedAt: Date.now() });
    });
  return id;
}

const driverOf = (account: string) => testEnv.ACME_HOOK_DRIVER.get(testEnv.ACME_HOOK_DRIVER.idFromName(account));

/** Runs `step` in the account's driver. A hook's stubs are stand-ins: nothing here starts a firing. */
const inDriver = <T>(account: string, step: (driver: AcmeHookDriver) => Promise<T>): Promise<T> =>
  runInDurableObject(driverOf(account), step);

const enable = (account: string, key: string, itemId: string) => inDriver(account, driver =>
  driver.register(key, { userObjectId: account, itemId }, { delivery: {}, initiator: {} } as never));

async function deliver(route: string, secret: string, payload: object): Promise<number> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const response = await SELF.fetch(`${BASE_URL}/webhook/${route}`, {
    method: "POST", body, headers: { "X-Acme-Signature": Array.from(mac, byte => byte.toString(16).padStart(2, "0")).join("") },
  });
  return response.status;
}

describe("a gatekeeper that adds its own webhooks", () => {
  it("adds one webhook for an item's hooks, as the connection, and deletes it with the last", async () => {
    const { calls, webhooks } = fakeProvider();
    const account = await connected("key-alice");
    await enable(account, "h1", "item1");
    await enable(account, "h2", "item1");

    expect(calls).toEqual(["POST /items/item1/webhooks as Bearer key-alice"]);
    const [{ url, secret }] = [...webhooks.values()];
    expect(url).toBe(`${BASE_URL}/webhook/${driverOf(account).id}`);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    await inDriver(account, driver => driver.unregister("h1"));
    expect(webhooks.size).toBe(1);
    await inDriver(account, driver => driver.unregister("h2"));
    expect(calls.at(-1)).toBe("DELETE /items/item1/webhooks/w1 as Bearer key-alice");
    expect(webhooks.size).toBe(0);
  });

  it("takes a delivery only at its driver's route, signed with that driver's secret", async () => {
    const { webhooks } = fakeProvider();
    const account = await connected("key-alice");
    await enable(account, "h1", "item1");
    const route = driverOf(account).id.toString();
    const { secret } = webhooks.get("w1")!;
    // An event of a type no hook watches: verified and acknowledged, and nothing queued.
    const ping = { id: "e1", type: "item.viewed", occurred_at: new Date().toISOString(), item: { id: "item1" } };

    expect(await deliver(route, secret, ping)).toBe(204);
    expect(await deliver(route, "0".repeat(64), ping)).toBe(401);
    // Another connection's driver has no secret, and a route that names no driver is not one.
    expect(await deliver(driverOf(await connected("key-bob")).id.toString(), secret, ping)).toBe(404);
    expect(await deliver("not-a-driver", secret, ping)).toBe(404);
  });

  it("adds again, at its hourly check, a webhook that is gone", async () => {
    const { calls, webhooks } = fakeProvider();
    const account = await connected("key-alice");
    await enable(account, "h1", "item1");
    webhooks.clear();

    await runInDurableObject(driverOf(account), async (driver: AcmeHookDriver, state: DurableObjectState) => {
      state.storage.kv.put("checkAt", 0);
      await driver.alarm();
    });
    expect(calls.slice(1)).toEqual([
      "GET /items/item1/webhooks/w1 as Bearer key-alice",
      "POST /items/item1/webhooks as Bearer key-alice",
    ]);
    expect(webhooks.size).toBe(1);
  });

  it("stays connected while the provider may yet delete a webhook, and disconnects once it has", async () => {
    let status: number | undefined = 503;
    const { webhooks } = fakeProvider(() => status);
    const account = await connected("key-alice");
    await enable(account, "h1", "item1");
    const hooks = testEnv.TEST_HOOKS.get(testEnv.TEST_HOOKS.idFromName("hooks"));
    const credentials = () => runInDurableObject(testEnv.USER_ACCOUNT.get(testEnv.USER_ACCOUNT.idFromString(account)),
      async (_instance: unknown, state: DurableObjectState) => state.storage.kv.get("credentials"));

    const refused = await hooks.user(account, "revoke") as Outcome<unknown>;
    expect(refused).toEqual({ error: expect.stringContaining("so it is still connected") });
    expect(await credentials()).toEqual({ accessToken: "key-alice" });
    // Its hooks are gone all the same, and none can be enabled.
    await expect(enable(account, "h2", "item1").then(() => "enabled", (error: Error) => error.message))
      .resolves.toContain("has been disconnected");

    status = undefined;
    expect(await hooks.user(account, "revoke")).toEqual({ ok: undefined });
    expect(webhooks.size).toBe(0);
    expect(await credentials()).toBeUndefined();
  });

  it("gives up on a webhook the provider refuses to delete, and disconnects", async () => {
    fakeProvider(() => 403);
    const account = await connected("key-alice");
    await enable(account, "h1", "item1");
    expect(await inDriver(account, driver => driver.revoke())).toBe(true);
  });
});
