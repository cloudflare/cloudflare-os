// The `--hooks subscription` driver of a generated gatekeeper: the webhooks it adds and deletes
// at the template's invented provider, faked at `fetch`, and the deliveries it takes. A hook's
// firing needs the Workshop's initiator, which this pool has no stand-in for, so an event is
// followed only as far as the driver's queue: what delivers it from there is the kit's registry,
// which its own suite covers.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcmeHookDriver } from "#gatekeeper/acme-hook-driver";

const BASE_URL = "https://gadgets.test/gatekeeper/acme";
const testEnv = env as any;

type Call = { method: string; id?: string };

/**
 * The provider's webhook calls: every one made, and the webhooks it now has, by id, which is
 * never used twice. `before` runs ahead of each call's answer, and may return a status to refuse
 * it with.
 */
function fakeProvider(before: (call: Call) => Promise<number | void> | number | void = () => {}) {
  const calls: string[] = [];
  const webhooks = new Map<string, { url: string; secret: string }>();
  let made = 0;
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    const [, id] = /^\/items\/[^/]+\/webhooks(?:\/([^/]+))?$/.exec(pathname) ?? [];
    calls.push(`${request.method} ${pathname} as ${request.headers.get("Authorization")}`);
    const refusal = await before({ method: request.method, id });
    if (refusal !== undefined) return new Response(null, { status: refusal });
    if (request.method === "POST" && id === undefined) {
      webhooks.set(`w${++made}`, await request.json());
      return Response.json({ id: `w${made}` });
    }
    if (request.method === "GET" && id !== undefined) {
      return webhooks.has(id) ? Response.json({ id }) : new Response(null, { status: 404 });
    }
    if (request.method === "DELETE" && id !== undefined) {
      webhooks.delete(id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake provider: ${request.method} ${pathname} is not routed`);
  });
  return { calls, webhooks };
}

/** A point a test holds a call at: `reached` settles when the call arrives, which waits for `release()`. */
function gate() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: arrived.promise,
    release: released.resolve,
    hold: async () => {
      arrived.resolve();
      await released.promise;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const accountOf = (id: string) => testEnv.USER_ACCOUNT.get(testEnv.USER_ACCOUNT.idFromString(id));

/** An account connected with `key`, the way a completed connect leaves one. */
async function connected(key = "key-alice"): Promise<string> {
  const id = testEnv.USER_ACCOUNT.newUniqueId().toString();
  await runInDurableObject(accountOf(id), async (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("credentials", { accessToken: key });
    state.storage.kv.put("identity", { userId: "u-alice", name: "Alice", fetchedAt: Date.now() });
  });
  return id;
}

/** The credential the account holds, if it is still connected. */
const credentials = (id: string) => runInDurableObject(accountOf(id),
  async (_instance: unknown, state: DurableObjectState) => state.storage.kv.get("credentials"));

/** Disconnects the account as the Workshop does, through its entrypoint. */
const disconnect = (id: string) => testEnv.TEST_HOOKS.get(testEnv.TEST_HOOKS.idFromName("hooks")).user(id, "revoke");

const driverOf = (account: string) => testEnv.ACME_HOOK_DRIVER.get(testEnv.ACME_HOOK_DRIVER.idFromName(account));

/** Runs `step` in the account's driver. */
const inDriver = <T>(account: string, step: (driver: AcmeHookDriver, state: DurableObjectState) => Promise<T>): Promise<T> =>
  runInDurableObject(driverOf(account), step);

/** Enables a hook, whose stubs are stand-ins: nothing here starts a firing. */
const enable = (account: string, key: string, itemId: string) => inDriver(account, driver =>
  driver.register(key, { userObjectId: account, itemId }, { delivery: {}, initiator: {} } as never));

const disable = (account: string, key: string) => inDriver(account, driver => driver.unregister(key));

/** Runs the driver's hourly check now. */
const check = (account: string) => inDriver(account, async (driver, state) => {
  state.storage.kv.put("checkAt", 0);
  await driver.alarm();
});

/** The driver's storage keys under `prefix`. */
const stored = (account: string, prefix: string) => inDriver(account, async (_driver, state) =>
  Array.from(state.storage.kv.list({ prefix }), ([key]) => key));

const event = (type: string, itemId: string) => ({ id: "e1", type, occurred_at: new Date().toISOString(), item: { id: itemId } });

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
    const account = await connected();
    await enable(account, "h1", "item1");
    await enable(account, "h2", "item1");

    expect(calls).toEqual(["POST /items/item1/webhooks as Bearer key-alice"]);
    const [{ url, secret }] = [...webhooks.values()];
    expect(url).toBe(`${BASE_URL}/webhook/${driverOf(account).id}`);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    await disable(account, "h1");
    expect(webhooks.size).toBe(1);
    await disable(account, "h2");
    expect(calls.at(-1)).toBe("DELETE /items/item1/webhooks/w1 as Bearer key-alice");
    expect(webhooks.size).toBe(0);
  });

  it("disables a hook whose enabling is still under way", async () => {
    const adding = gate();
    const { webhooks } = fakeProvider(({ method }) => method === "POST" ? adding.hold() : undefined);
    const account = await connected();
    const enabling = enable(account, "h1", "item1");
    await adding.reached;
    const disabling = disable(account, "h1");
    adding.release();
    await Promise.all([enabling, disabling]);

    expect(await stored(account, "reg:")).toEqual([]);
    expect(webhooks.size).toBe(0);
  });

  it("takes a delivery only at its driver's route, signed with that driver's secret", async () => {
    const { webhooks } = fakeProvider();
    const [alice, bob] = [await connected(), await connected("key-bob")];
    await enable(alice, "h1", "item1");
    await enable(bob, "h1", "item1");
    const route = (account: string) => driverOf(account).id.toString();
    const secret = webhooks.get("w1")!.secret;
    // Of a type no hook watches: verified and acknowledged, and nothing queued.
    const unwatched = event("item.viewed", "item1");

    expect(await deliver(route(alice), secret, unwatched)).toBe(204);
    expect(await deliver(route(alice), "0".repeat(64), unwatched)).toBe(401);
    // Another connection's driver has a secret of its own.
    expect(await deliver(route(bob), secret, unwatched)).toBe(401);
    // A driver that has added no webhook has none, and a route that names no driver is not one.
    expect(await deliver(route(await connected()), secret, unwatched)).toBe(404);
    expect(await deliver("not-a-driver", secret, unwatched)).toBe(404);
  });

  it("queues an event for the hooks on its item, and for no other", async () => {
    const { webhooks } = fakeProvider();
    const account = await connected();
    await enable(account, "h1", "item1");
    await enable(account, "h2", "item1");
    await enable(account, "h3", "item2");

    expect(await deliver(driverOf(account).id.toString(), webhooks.get("w1")!.secret, event("item.updated", "item1"))).toBe(204);
    expect(await stored(account, "msg:")).toEqual(["msg:h1:e1", "msg:h2:e1"]);
  });

  it("adds again, at its hourly check, a webhook that is gone, however often that takes", async () => {
    let failing = false;
    const { calls, webhooks } = fakeProvider(({ method }) => failing && method === "POST" ? 503 : undefined);
    const account = await connected();
    await enable(account, "h1", "item1");
    webhooks.clear();

    failing = true;
    await check(account);
    expect(webhooks.size).toBe(0);
    // Still on record, and still checked: the hook would otherwise wait for good on nothing.
    expect(await stored(account, "webhook:")).toEqual(["webhook:item1"]);
    expect(await inDriver(account, (_driver, state) => state.storage.getAlarm())).not.toBeNull();

    failing = false;
    await check(account);
    expect(calls.slice(-2)).toEqual([
      "GET /items/item1/webhooks/w1 as Bearer key-alice",
      "POST /items/item1/webhooks as Bearer key-alice",
    ]);
    expect([...webhooks.keys()]).toEqual(["w2"]);
  });

  it("leaves alone, at its hourly check, a webhook added since the check began", async () => {
    const reading = gate();
    const { webhooks } = fakeProvider(({ method, id }) => method === "GET" && id === "w1" ? reading.hold() : undefined);
    const account = await connected();
    await enable(account, "h1", "item1");
    await enable(account, "h2", "item2");

    // While the check reads item1's webhook, item2's is deleted with its hook and added for a new one.
    const checking = check(account);
    await reading.reached;
    const changing = [disable(account, "h2"), enable(account, "h3", "item2")];
    reading.release();
    await Promise.all([checking, ...changing]);

    expect([...webhooks.keys()]).toEqual(["w1", "w3"]);
    // Every webhook is on record, so disconnecting deletes them all.
    expect(await inDriver(account, driver => driver.revoke())).toBe(true);
    expect(webhooks.size).toBe(0);
  });

  it("stays connected while the provider may yet delete a webhook, and disconnects once it has", async () => {
    let failing = true;
    const { webhooks } = fakeProvider(({ method }) => failing && method === "DELETE" ? 503 : undefined);
    const account = await connected();
    await enable(account, "h1", "item1");

    expect(await disconnect(account)).toEqual({ error: expect.stringContaining("so it is still connected") });
    expect(await credentials(account)).toEqual({ accessToken: "key-alice" });
    // Its hooks are gone all the same, and none can be enabled.
    await expect(enable(account, "h2", "item1").then(() => "enabled", (error: Error) => error.message))
      .resolves.toContain("has been disconnected");

    failing = false;
    expect(await disconnect(account)).toEqual({ ok: undefined });
    expect(webhooks.size).toBe(0);
    expect(await credentials(account)).toBeUndefined();
  });

  // Each leaves the webhook at the provider, which nothing of this connection's can delete any more.
  it.each([
    ["the provider refuses to delete", 403],
    ["the credential has died", 401],
  ])("disconnects although %s", async (_why, status) => {
    fakeProvider(({ method }) => method === "DELETE" ? status : undefined);
    const account = await connected();
    await enable(account, "h1", "item1");

    expect(await disconnect(account)).toEqual({ ok: undefined });
    expect(await credentials(account)).toBeUndefined();
    expect(await stored(account, "webhook:")).toEqual([]);
  });
});
