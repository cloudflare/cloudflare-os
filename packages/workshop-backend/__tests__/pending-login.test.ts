import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LoginConnectCallbackImpl, PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import { hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from "../src/connect-handoff.js";
import type { FakeGatekeeperAccount } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// What a test reaches into the user DO for: the collections behind the callback's effects.
type UserInternals = UserDurableObject & {
  storage: {
    connectedAccounts: { get(id: number): Record<string, unknown> | undefined; put(record: unknown): void };
    pendingHandoffs: { list(): Iterable<Record<string, unknown>> };
    nextAccountId: { put(n: number): void };
  };
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: { name: string } }): Fetcher<FakeGatekeeperAccount>;
      TestLoginCallback(options: { props: { pendingId: string; vendorId: string } })
        : Fetcher<LoginConnectCallbackImpl>;
    };
  };
};

let counter = 0;
const fresh = () => env.TEST_PENDING_LOGIN.getByName(`pending-login-${++counter}`);

// Claims over the stub the way the browser does, reporting the outcome as a value (a native RPC
// promise left to `.rejects` is also flagged as an unhandled rejection by the pool).
async function claim(stub: DurableObjectStub<PendingLogin>, ticket: string): Promise<string> {
  try {
    const token = await stub.claim(ticket);
    return token === null ? "null" : `token:${token}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

describe("PendingLogin", () => {
  it("releases the token once, and only to the matching ticket", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(
        Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    });

    // Holding the attempt is not enough: the attacker's own tab never sees the ticket. And a ticket
    // for some other attempt (the window hears every same-origin broadcast) neither releases the
    // token nor spends the result, so the right ticket still can.
    const other = fresh();
    await other.deliver("victim@example.com:session", hash);
    expect(await claim(other, (await newSecretToken()).secret.toHex())).toBe("null");
    expect(await claim(other, "not-a-ticket")).toBe("null");
    expect(await claim(other, secret.toHex())).toBe("token:victim@example.com:session");

    expect(await claim(stub, secret.toHex())).toBe("token:alice@example.com:session");
    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
      expect([...instance.ctx.storage.kv.list()]).toEqual([]);
    });
  });

  it("reports the gatekeeper's failure to whoever claims", async () => {
    const stub = fresh();
    await stub.fail("This account has no verified email, so it can't be used to sign in.");

    expect(await claim(stub, "f".repeat(64)))
      .toBe("error:This account has no verified email, so it can't be used to sign in.");
    expect(await claim(stub, "f".repeat(64)))
      .toBe("error:This sign-in attempt has expired. Please try again.");
  });

  it("wipes an unclaimed token from the alarm", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    await runInDurableObject(stub, (instance: PendingLogin) => instance.alarm());
    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
  });

  it("refuses a claim past the lifetime even if the alarm has not fired", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);
    // Age the stored result without running the alarm: validity must not depend on it.
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      const [[key, stored]] = [...instance.ctx.storage.kv.list()] as [string, { expiresAt: number }][];
      expect(stored.expiresAt).toBeGreaterThan(Date.now());
      instance.ctx.storage.kv.put(key, { ...stored, expiresAt: Date.now() - 1 });
    });

    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
  });

  it("keeps the account link after the result is claimed or swept", async () => {
    // The link is what lets the gatekeeper's callback reach the linked account for the rest of its
    // life, so neither redeeming the sign-in nor the expiry sweep may take it with the result.
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.link("user-do-id", 3);
    await stub.deliver("alice@example.com:session", hash);
    expect(await claim(stub, secret.toHex())).toBe("token:alice@example.com:session");
    expect(await stub.getLink()).toEqual({ userId: "user-do-id", accountId: 3 });

    await stub.deliver("alice@example.com:again", hash);
    await runInDurableObject(stub, (instance: PendingLogin) => instance.alarm());
    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
    expect(await stub.getLink()).toEqual({ userId: "user-do-id", accountId: 3 });
  });

  it("stores only the ticket's hash", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    await runInDurableObject(stub, async (instance: PendingLogin) => {
      const stored = JSON.stringify([...instance.ctx.storage.kv.list()]);
      expect(stored).not.toContain(secret.toHex());
      expect(stored).toContain(await hashSecret(secret));
    });
  });
});

describe("LoginConnectCallbackImpl", () => {
  const STAGE_ID = "5".repeat(64);

  // The callback as the gatekeeper holds it, minted inside the user DO (whose `ctx.exports` is the
  // only way to reach a callback entrypoint from a test).
  function callbackFor(user: UserInternals, pendingId: string) {
    return user.ctx.exports.TestLoginCallback({ props: { pendingId, vendorId: "cloudflare" } });
  }

  it("routes a linked account's reconnect and expiry to its user", async () => {
    // Cloudflare sign-in persists a connected account whose callback is this object for life, so
    // the account must be able to reconnect and be marked expired like one connected the usual way.
    const pending = fresh();
    const userStub = env.TEST_USER.getByName("login-callback-linked");
    await pending.link(userStub.id.toString(), 0);
    const pendingId = pending.id.toString();
    await runInDurableObject(userStub, async (instance: UserDurableObject) => {
      const user = instance as UserInternals;
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, account: user.ctx.exports.FakeGatekeeperAccount({ props: { name: "cf" } }),
        vendorId: "cloudflare", description: { displayName: "cf" },
      });
      const callback = callbackFor(user, pendingId);

      const handoff = await callback.reconnectComplete(STAGE_ID, new Date("2027-01-01"));
      expect(handoff.ticket).toMatch(/^[0-9a-f]{64}$/);
      expect([...user.storage.pendingHandoffs.list()]).toMatchObject([
        { kind: "restore", accountId: 0, stageId: STAGE_ID },
      ]);
      expect(user.storage.connectedAccounts.get(0)?.credentialsExpired).toBeUndefined();

      await callback.credentialsExpired();
      expect(user.storage.connectedAccounts.get(0)?.credentialsExpired).toBe(true);
      await callback.credentialsRestored(new Date("2027-02-01"));
      expect(user.storage.connectedAccounts.get(0)).toMatchObject({
        credentialsExpired: false, credentialExpiresAt: new Date("2027-02-01"),
      });
    });
  });

  it("has nothing to reconnect or update for a transient sign-in grant", async () => {
    const pendingId = fresh().id.toString();
    const userStub = env.TEST_USER.getByName("login-callback-unlinked");
    await runInDurableObject(userStub, async (instance: UserDurableObject) => {
      const user = instance as UserInternals;
      const callback = callbackFor(user, pendingId);
      let outcome = "ok";
      try {
        await callback.reconnectComplete(STAGE_ID);
      } catch (err) {
        outcome = (err as Error).message;
      }
      expect(outcome).toBe("Sign-in flows cannot be reconnected.");
      await callback.credentialsExpired();
      expect([...user.storage.pendingHandoffs.list()]).toEqual([]);
    });
  });
});
