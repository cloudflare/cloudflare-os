import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperConnectCallbackImpl, UserDurableObject } from "../src/user.js";
import { handoffTargetOrigin, PENDING_HANDOFF_LIFETIME_MS } from "../src/connect-handoff.js";
import type { FakeGatekeeperAccount } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const TARGET = "https://workshop.example";
const EXPIRED = "This connection attempt has expired. Please try again.";

// What a test reaches into the user DO for: the typed collections behind the public methods.
type UserInternals = UserDurableObject & {
  storage: {
    connectedAccounts: { get(id: number): Record<string, unknown> | undefined; put(record: unknown): void };
    pendingHandoffs: { list(): Iterable<{ expiresAt: Date }>; put(record: unknown): void };
    nextAccountId: { get(): number; put(n: number): void };
  };
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: { name: string; failRevoke?: boolean } })
        : Fetcher<FakeGatekeeperAccount>;
      TestConnectCallback(options: {
        props: { userId: string; accountId: number; vendorId: string };
      }): Fetcher<GatekeeperConnectCallbackImpl>;
    };
  };
};

let userCounter = 0;
function freshUser() {
  const stub = env.TEST_USER.getByName(`connect-handoff-${++userCounter}`);
  return {
    stub,
    inDo<T>(f: (user: UserInternals) => Promise<T>): Promise<T> {
      return runInDurableObject(stub, (instance: UserDurableObject) => f(instance as UserInternals));
    },
  };
}

// An account stub the DO can persist (a WorkerEntrypoint reached through ctx.exports, like a real
// gatekeeper's), viewed as the GatekeeperUser the kernel expects.
function fakeAccount(user: UserInternals, name: string, failRevoke?: boolean) {
  const account = user.ctx.exports.FakeGatekeeperAccount({ props: { name, failRevoke } });
  return { account: account as unknown as Fetcher<GatekeeperUser>, calls: () => account.calls() };
}

const STAGE_ID = "5".repeat(64);

// Redeems over the user's stub the way the browser does, reporting the outcome as a value: a native
// RPC promise left to `.rejects` is also flagged as an unhandled rejection by the pool.
async function redeem(stub: DurableObjectStub<UserDurableObject>, ticket: string): Promise<string> {
  try {
    await stub.completeConnectHandoff(ticket);
    return "ok";
  } catch (err) {
    return (err as Error).message;
  }
}

function pendingCount(user: UserInternals) {
  return [...user.storage.pendingHandoffs.list()].length;
}

// Age every pending record past its lifetime, as the alarm would find them.
function expirePending(user: UserInternals) {
  // Snapshot first: a put during kv.list() invalidates the iterator.
  const records = Array.from(user.storage.pendingHandoffs.list());
  for (const record of records) {
    user.storage.pendingHandoffs.put({ ...record, expiresAt: new Date(Date.now() - 1) });
  }
}

describe("connect handoff", () => {
  it("stages a connect and activates it only when its ticket is redeemed", async () => {
    const { stub, inDo } = freshUser();
    const handoff = await inDo(async user => {
      const { account } = fakeAccount(user, "octocat");
      user.storage.nextAccountId.put(1);
      const staged = await user.stagePendingConnect(0, account, "github", new Date("2027-01-01"));
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      const [pending] = Array.from(user.storage.pendingHandoffs.list());
      expect(pending).toBeDefined();
      expect(pendingCount(user)).toBe(1);
      // The sweep is armed for the record's expiry, which is within the lifetime.
      expect(await user.ctx.storage.getAlarm()).toBe(pending.expiresAt.getTime());
      expect(pending.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PENDING_HANDOFF_LIFETIME_MS);
      // Only the ticket's hash is at rest.
      for (const [, value] of user.ctx.storage.kv.list()) {
        expect(JSON.stringify(value)).not.toContain(staged.ticket);
      }
      return staged;
    });
    expect(handoff.targetOrigin).toBe(TARGET);
    expect(handoff.ticket).toMatch(/^[0-9a-f]{64}$/);

    // Redeemed the way the browser does it: over the user's own stub.
    await stub.completeConnectHandoff(handoff.ticket);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toMatchObject({
        id: 0, vendorId: "github", description: { displayName: "octocat" },
        credentialExpiresAt: new Date("2027-01-01"),
      });
      expect(await fakeAccount(user, "octocat").calls()).toEqual(["describe"]);
      expect(pendingCount(user)).toBe(0);
    });
  });

  it("rejects a ticket that is unknown, malformed, already redeemed, or another user's", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(user =>
      user.stagePendingConnect(0, fakeAccount(user, "a").account, "github"));

    expect(await redeem(stub, "f".repeat(64))).toBe(EXPIRED);
    expect(await redeem(stub, "not-a-ticket")).toBe(EXPIRED);
    expect(await redeem(stub, ticket.toUpperCase())).toBe(EXPIRED);
    // The victim's session: a different user's DO knows nothing of the attacker's ticket.
    expect(await redeem(freshUser().stub, ticket)).toBe(EXPIRED);
    // A failed redemption leaves the ticket redeemable by the right user...
    expect(await redeem(stub, ticket)).toBe("ok");
    // ...exactly once.
    expect(await redeem(stub, ticket)).toBe(EXPIRED);
  });

  it("refuses an expired ticket, revoking the unconfirmed grant whether redeemed or swept", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(user =>
      user.stagePendingConnect(0, fakeAccount(user, "expired").account, "github"));
    await inDo(async user => {
      await user.stagePendingConnect(1, fakeAccount(user, "swept").account, "github");
      expirePending(user);
    });

    expect(await redeem(stub, ticket)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      // The refused redemption consumed its record — and revoked the grant it could no longer
      // activate, which the alarm would otherwise never see; the alarm sweeps the other.
      expect(await fakeAccount(user, "expired").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(1);
      await user.alarm();
      expect(pendingCount(user)).toBe(0);
      expect(await fakeAccount(user, "swept").calls()).toEqual(["describe", "revoke"]);
      expect(await user.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("revokes a staged connect it failed to persist, and reports the failure", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(async user => {
      user.storage.nextAccountId.put(1);
      // The same identity is already connected, so persisting runs the dedupe path, whose revoke of
      // the duplicate grant fails here — the one way putConnectedAccount itself can throw.
      user.storage.connectedAccounts.put({
        id: 0, account: fakeAccount(user, "dup").account, vendorId: "github",
        description: { displayName: "dup", uniqueName: "dup" },
      });
      return user.stagePendingConnect(1, fakeAccount(user, "dup", true).account, "github");
    });

    expect(await redeem(stub, ticket)).toBe("revoke failed");
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(1)).toBeUndefined();
      expect(pendingCount(user)).toBe(0);
      // The dedupe revoke that threw, then the best-effort revoke of the dropped grant.
      expect(await fakeAccount(user, "dup").calls()).toEqual(["describe", "revoke", "revoke"]);
    });
    // The ticket was consumed by the attempt.
    expect(await redeem(stub, ticket)).toBe(EXPIRED);
  });

  it("commits a staged reconnect and then marks the credentials restored", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(async user => {
      const { account } = fakeAccount(user, "renewed");
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, account, vendorId: "github", description: { displayName: "old" },
        credentialsExpired: true,
      });
      const handoff = await user.stagePendingRestore(0, STAGE_ID, new Date("2027-06-01"));
      expect(await fakeAccount(user, "renewed").calls()).toEqual([]);
      expect(user.storage.connectedAccounts.get(0)?.credentialsExpired).toBe(true);
      return handoff;
    });

    await stub.completeConnectHandoff(ticket);
    await inDo(async user => {
      // The commit names the stage this ticket was minted for, not "whatever is staged".
      expect(await fakeAccount(user, "renewed").calls())
        .toEqual([`commitReconnect(${STAGE_ID})`, "describe"]);
      expect(user.storage.connectedAccounts.get(0)).toMatchObject({
        credentialsExpired: false, credentialExpiresAt: new Date("2027-06-01"),
        description: { displayName: "renewed" },
      });
    });
  });

  it("drops an expired reconnect stage without touching the live account", async () => {
    const { inDo } = freshUser();
    await inDo(async user => {
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, account: fakeAccount(user, "live").account, vendorId: "github",
        description: { displayName: "live" },
      });
      await user.stagePendingRestore(0, STAGE_ID);
      expirePending(user);
      await user.alarm();
      expect(pendingCount(user)).toBe(0);
      expect(await fakeAccount(user, "live").calls()).toEqual([]);
      expect(user.storage.connectedAccounts.get(0)?.description).toEqual({ displayName: "live" });
    });
  });

  it("derives the target origin from PUBLIC_BASE_URL only, failing closed without it", () => {
    expect(handoffTargetOrigin({ PUBLIC_BASE_URL: `${TARGET}/some/path` } as Cloudflare.Env))
      .toBe(TARGET);
    expect(() => handoffTargetOrigin({} as Cloudflare.Env)).toThrow("PUBLIC_BASE_URL");
  });

  it("stages through the gatekeeper-facing callback exactly as a connector calls it", async () => {
    const { stub, inDo } = freshUser();
    const handoff = await inDo(async user => {
      user.storage.nextAccountId.put(1);
      const callback = user.ctx.exports.TestConnectCallback({
        props: { userId: user.ctx.id.toString(), accountId: 0, vendorId: "github" },
      });
      const staged = await callback.complete(fakeAccount(user, "via-callback").account);
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      return staged;
    });
    expect(handoff.targetOrigin).toBe(TARGET);

    await stub.completeConnectHandoff(handoff.ticket);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)?.vendorId).toBe("github");
      // A reconnect finishing on the same callback stages a restore, not a second account.
      const callback = user.ctx.exports.TestConnectCallback({
        props: { userId: user.ctx.id.toString(), accountId: 0, vendorId: "github" },
      });
      await callback.reconnectComplete(STAGE_ID);
      expect(pendingCount(user)).toBe(1);
      expect(user.storage.nextAccountId.get()).toBe(1);
    });
  });
});
