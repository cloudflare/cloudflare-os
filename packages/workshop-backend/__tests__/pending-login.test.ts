import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  LOGIN_PENDING_LIFETIME_MS, type LoginConnectCallbackImpl, type PendingLogin,
} from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import {
  hashPresentedSecret, hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS,
} from "../src/connect-handoff.js";
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

// The DO as startGatekeeperLogin() names it (the hash newSecretToken() pairs with the nonce) and as
// confirmLogin() finds it again (hashPresentedSecret of the nonce the popup presents): both
// derivations must name the same DO, or every real popup would confirm against one that never began.
async function forNonce() {
  const { secret, hash } = await newSecretToken();
  const nonce = secret.toHex();
  expect(await hashPresentedSecret(nonce)).toBe(hash);
  return { nonce, stub: env.TEST_PENDING_LOGIN.getByName(hash) };
}

// Confirms over the stub the way the popup's page does, reporting the outcome as a value (a native
// RPC promise left to `.rejects` is also flagged as an unhandled rejection by the pool).
async function confirm(stub: DurableObjectStub<PendingLogin>, ticket: string): Promise<string> {
  try {
    await stub.confirm(ticket);
    return "ok";
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

// Polls over the stub the way the login tab does, reporting the outcome as a value.
async function receive(stub: DurableObjectStub<PendingLogin>): Promise<string> {
  try {
    const token = await stub.receive();
    return token === null ? "null" : `token:${token}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

const EXPIRED = "error:This sign-in attempt has expired. Please try again.";

// Age the stored result without running the alarm; the result is the DO's only entry here.
const age = (stub: DurableObjectStub<PendingLogin>) =>
  runInDurableObject(stub, async (instance: PendingLogin) => {
    const [[key, stored]] = [...instance.ctx.storage.kv.list()] as [string, { expiresAt: number }][];
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    instance.ctx.storage.kv.put(key, { ...stored, expiresAt: Date.now() - 1 });
  });

describe("PendingLogin", () => {
  it("releases the token once, and only after the popup confirms the matching ticket", async () => {
    const { stub } = await forNonce();
    await stub.begin();
    expect(await receive(stub)).toBe("null");

    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(
        Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    });
    // Holding the attempt is not enough: the token stays parked until the popup confirms it.
    expect(await receive(stub)).toBe("null");

    expect(await confirm(stub, secret.toHex())).toBe("ok");
    expect(await receive(stub)).toBe("token:alice@example.com:session");
    expect(await receive(stub)).toBe(EXPIRED);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
      expect([...instance.ctx.storage.kv.list()]).toEqual([]);
    });
  });

  it("refuses a wrong or malformed ticket without spending the result", async () => {
    // A guess must not consume what the right ticket is about to confirm.
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    expect(await confirm(stub, (await newSecretToken()).secret.toHex())).toBe(EXPIRED);
    expect(await confirm(stub, "not-a-ticket")).toBe(EXPIRED);
    expect(await confirm(stub, secret.toHex().toUpperCase())).toBe(EXPIRED);
    expect(await receive(stub)).toBe("null");

    expect(await confirm(stub, secret.toHex())).toBe("ok");
    expect(await receive(stub)).toBe("token:alice@example.com:session");
  });

  it("refuses a ticket before delivery and keeps the attempt pending", async () => {
    // A ticket cannot precede the delivery that minted it, so one arriving while the user is still
    // at the provider's consent screen is a guess: it must neither settle the attempt as expired nor
    // confirm anything; the attempt keeps waiting.
    const stub = fresh();
    await stub.begin();
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      // The wait for the gatekeeper outlives a delivered result, which has the shorter lifetime.
      expect(await instance.ctx.storage.getAlarm()).toBeGreaterThan(
        Date.now() + PENDING_HANDOFF_LIFETIME_MS);
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(
        Date.now() + LOGIN_PENDING_LIFETIME_MS);
    });
    expect(await confirm(stub, (await newSecretToken()).secret.toHex())).toBe(EXPIRED);
    expect(await confirm(stub, "not-a-ticket")).toBe(EXPIRED);
    expect(await receive(stub)).toBe("null");

    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);
    expect(await confirm(stub, secret.toHex())).toBe("ok");
    expect(await receive(stub)).toBe("token:alice@example.com:session");
  });

  it("expires an attempt that never delivered", async () => {
    const stub = fresh();
    await stub.begin();
    await age(stub);

    expect(await receive(stub)).toBe(EXPIRED);
    expect(await confirm(stub, (await newSecretToken()).secret.toHex())).toBe(EXPIRED);
  });

  it("reports the gatekeeper's failure to whoever confirms or receives", async () => {
    const reason = "This account has no verified email, so it can't be used to sign in.";
    const confirming = fresh();
    await confirming.fail(reason);
    expect(await confirm(confirming, "f".repeat(64))).toBe(`error:${reason}`);
    expect(await receive(confirming)).toBe(EXPIRED);

    const receiving = fresh();
    await receiving.fail(reason);
    expect(await receive(receiving)).toBe(`error:${reason}`);
    expect(await confirm(receiving, "f".repeat(64))).toBe(EXPIRED);
  });

  it("wipes an unconfirmed and an unreceived token from the alarm", async () => {
    const unconfirmed = fresh();
    const { secret, hash } = await newSecretToken();
    await unconfirmed.deliver("alice@example.com:session", hash);
    await runInDurableObject(unconfirmed, (instance: PendingLogin) => instance.alarm());
    expect(await confirm(unconfirmed, secret.toHex())).toBe(EXPIRED);

    const unreceived = fresh();
    await unreceived.deliver("alice@example.com:session", hash);
    expect(await confirm(unreceived, secret.toHex())).toBe("ok");
    await runInDurableObject(unreceived, (instance: PendingLogin) => instance.alarm());
    expect(await receive(unreceived)).toBe(EXPIRED);
  });

  it("refuses a result past its lifetime even if the alarm has not fired", async () => {
    // Validity must not depend on the alarm. Confirming rewrites only the result key, keeping its
    // expiry, so the aged entry is the one it finds.
    const { secret, hash } = await newSecretToken();

    const unconfirmed = fresh();
    await unconfirmed.deliver("alice@example.com:session", hash);
    await age(unconfirmed);
    expect(await confirm(unconfirmed, secret.toHex())).toBe(EXPIRED);

    const unreceived = fresh();
    await unreceived.deliver("alice@example.com:session", hash);
    expect(await confirm(unreceived, secret.toHex())).toBe("ok");
    await age(unreceived);
    expect(await receive(unreceived)).toBe(EXPIRED);
  });

  it("keeps the account link after the result is confirmed, received or swept", async () => {
    // The link is what lets the gatekeeper's callback reach the linked account for the rest of its
    // life, so neither redeeming the sign-in nor the expiry sweep may take it with the result.
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.link("user-do-id", 3);
    await stub.deliver("alice@example.com:session", hash);
    expect(await confirm(stub, secret.toHex())).toBe("ok");
    expect(await stub.getLink()).toEqual({ userId: "user-do-id", accountId: 3 });
    expect(await receive(stub)).toBe("token:alice@example.com:session");
    expect(await stub.getLink()).toEqual({ userId: "user-do-id", accountId: 3 });

    await stub.deliver("alice@example.com:again", hash);
    await runInDurableObject(stub, (instance: PendingLogin) => instance.alarm());
    expect(await receive(stub)).toBe(EXPIRED);
    expect(await stub.getLink()).toEqual({ userId: "user-do-id", accountId: 3 });
  });

  it("stores only the ticket's hash, before and after confirmation", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    const atRest = () => runInDurableObject(stub, async (instance: PendingLogin) => {
      const stored = JSON.stringify([...instance.ctx.storage.kv.list()]);
      expect(stored).not.toContain(secret.toHex());
      expect(stored).toContain(await hashSecret(secret));
    });
    await atRest();
    expect(await confirm(stub, secret.toHex())).toBe("ok");
    await atRest();
  });

  it("refuses to confirm an attempt that never began, and stores nothing for it", async () => {
    // confirmLogin() addresses the DO by the nonce's hash, so any nonce names some DO: one that no
    // startGatekeeperLogin() began holds no result and must not gain one.
    const { stub } = await forNonce();
    expect(await confirm(stub, "f".repeat(64))).toBe(EXPIRED);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect([...instance.ctx.storage.kv.list()]).toEqual([]);
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
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
