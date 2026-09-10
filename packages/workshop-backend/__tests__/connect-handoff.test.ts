import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperConnectCallbackImpl, UserDurableObject } from "../src/user.js";
import {
  CONNECT_FLOW_LIFETIME_MS, handoffTargetOrigin, hashSecret, PENDING_HANDOFF_LIFETIME_MS,
} from "../src/connect-handoff.js";
import type { FakeGatekeeperAccount } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const TARGET = "https://workshop.example";
const EXPIRED = "This connection attempt has expired. Please try again.";

// A collection of records that expire, as a test ages or counts them.
type Expiring<T extends { expiresAt: Date }> = { list(): Iterable<T>; put(record: unknown): void };

// What a test reaches into the user DO for: the typed collections behind the public methods.
type UserInternals = UserDurableObject & {
  storage: {
    connectedAccounts: { get(id: number): Record<string, unknown> | undefined; put(record: unknown): void };
    pendingHandoffs: Expiring<{ expiresAt: Date }>;
    pendingConnectFlows: Expiring<{ nonceHash: string; accountId: number; expiresAt: Date }>;
    nextAccountId: { get(): number; put(n: number): void };
  };
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: FakeAccountProps }): Fetcher<FakeGatekeeperAccount>;
      TestConnectCallback(options: {
        props: { userId: string; accountId: number; vendorId: string };
      }): Fetcher<GatekeeperConnectCallbackImpl>;
    };
  };
};

type FakeAccountProps = { name: string; failRevoke?: boolean; failDescribe?: boolean };

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
function fakeAccount(user: UserInternals, name: string, failing?: Omit<FakeAccountProps, "name">) {
  const account = user.ctx.exports.FakeGatekeeperAccount({ props: { name, ...failing } });
  return { account: account as unknown as Fetcher<GatekeeperUser>, calls: () => account.calls() };
}

const STAGE_ID = "5".repeat(64);

// Redeems over the user's stub the way the popup's page does, reporting the outcome as a value: a
// native RPC promise left to `.rejects` is also flagged as an unhandled rejection by the pool.
async function redeem(stub: DurableObjectStub<UserDurableObject>, ticket: string, nonce: string)
    : Promise<string> {
  try {
    await stub.completeConnectHandoff(ticket, nonce);
    return "ok";
  } catch (err) {
    return (err as Error).message;
  }
}

function pendingCount(user: UserInternals) {
  return [...user.storage.pendingHandoffs.list()].length;
}

function flowCount(user: UserInternals) {
  return [...user.storage.pendingConnectFlows.list()].length;
}

// Age every record of a collection past its lifetime, as the alarm would find them.
function expireAll(records: Expiring<{ expiresAt: Date }>) {
  // Snapshot first: a put during kv.list() invalidates the iterator.
  for (const record of Array.from(records.list())) {
    records.put({ ...record, expiresAt: new Date(Date.now() - 1) });
  }
}

describe("connect handoff", () => {
  it("stages a connect and activates it only when its ticket is redeemed", async () => {
    const { stub, inDo } = freshUser();
    const { handoff, nonce } = await inDo(async user => {
      const { account } = fakeAccount(user, "octocat");
      user.storage.nextAccountId.put(1);
      // The flow opens when the popup does, well before the gatekeeper finishes.
      const opened = await user.openConnectFlow(0);
      const [flow] = Array.from(user.storage.pendingConnectFlows.list());
      expect(flow).toMatchObject({ accountId: 0, nonceHash: await hashSecret(Uint8Array.fromHex(opened)) });
      expect(flow.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(CONNECT_FLOW_LIFETIME_MS);
      expect(await user.ctx.storage.getAlarm()).toBe(flow.expiresAt.getTime());

      const staged = await user.stagePendingConnect(0, account, "github", new Date("2027-01-01"));
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      const [pending] = Array.from(user.storage.pendingHandoffs.list());
      expect(pending).toBeDefined();
      expect(pendingCount(user)).toBe(1);
      // The sweep is armed for the soonest expiry: the record's, which is within the lifetime.
      expect(await user.ctx.storage.getAlarm()).toBe(pending.expiresAt.getTime());
      expect(pending.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PENDING_HANDOFF_LIFETIME_MS);
      // Only the ticket's and the nonce's hashes are at rest.
      for (const [, value] of user.ctx.storage.kv.list()) {
        expect(JSON.stringify(value)).not.toContain(staged.ticket);
        expect(JSON.stringify(value)).not.toContain(opened);
      }
      return { handoff: staged, nonce: opened };
    });
    expect(handoff.targetOrigin).toBe(TARGET);
    expect(handoff.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);

    // Redeemed the way the popup's page does it: over the user's own stub, with the flow's nonce.
    await stub.completeConnectHandoff(handoff.ticket, nonce);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toMatchObject({
        id: 0, vendorId: "github", description: { displayName: "octocat" },
        credentialExpiresAt: new Date("2027-01-01"),
      });
      expect(await fakeAccount(user, "octocat").calls()).toEqual(["describe"]);
      expect(pendingCount(user)).toBe(0);
      expect(flowCount(user)).toBe(0);
    });
  });

  it("rejects a ticket that is unknown, malformed, already redeemed, or another user's", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(user =>
      user.stagePendingConnect(0, fakeAccount(user, "a").account, "github"));
    const nonce = await stub.openConnectFlow(0);

    // A nonce that is nobody's, so these spend neither the ticket nor the flow.
    const unknownNonce = "e".repeat(64);
    expect(await redeem(stub, "f".repeat(64), unknownNonce)).toBe(EXPIRED);
    expect(await redeem(stub, "not-a-ticket", unknownNonce)).toBe(EXPIRED);
    expect(await redeem(stub, ticket.toUpperCase(), unknownNonce)).toBe(EXPIRED);
    // The victim's session: a different user's DO knows nothing of the attacker's ticket or nonce.
    expect(await redeem(freshUser().stub, ticket, nonce)).toBe(EXPIRED);
    // A redemption that found neither record leaves the pair redeemable by the right user...
    expect(await redeem(stub, ticket, nonce)).toBe("ok");
    // ...exactly once.
    expect(await redeem(stub, ticket, nonce)).toBe(EXPIRED);
  });

  it("refuses an expired ticket, revoking the unconfirmed grant whether redeemed or swept", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(user =>
      user.stagePendingConnect(0, fakeAccount(user, "expired").account, "github"));
    const nonce = await stub.openConnectFlow(0);
    await inDo(async user => {
      await user.stagePendingConnect(1, fakeAccount(user, "swept").account, "github");
      expireAll(user.storage.pendingHandoffs);
    });

    expect(await redeem(stub, ticket, nonce)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      // The refused redemption consumed its record — and revoked the grant it could no longer
      // activate, which the alarm would otherwise never see; the alarm sweeps the other.
      expect(await fakeAccount(user, "expired").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(1);
      expect(flowCount(user)).toBe(0);
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
      return user.stagePendingConnect(1, fakeAccount(user, "dup", { failRevoke: true }).account, "github");
    });
    const nonce = await stub.openConnectFlow(1);

    expect(await redeem(stub, ticket, nonce)).toBe("revoke failed");
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(1)).toBeUndefined();
      expect(pendingCount(user)).toBe(0);
      // The dedupe revoke that threw, then the best-effort revoke of the dropped grant.
      expect(await fakeAccount(user, "dup").calls()).toEqual(["describe", "revoke", "revoke"]);
    });
    // The ticket was consumed by the attempt.
    expect(await redeem(stub, ticket, nonce)).toBe(EXPIRED);
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
    const nonce = await stub.openConnectFlow(0);

    await stub.completeConnectHandoff(ticket, nonce);
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

  it("marks a committed reconnect restored even when the description cannot be refreshed", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(async user => {
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, account: fakeAccount(user, "stale", { failDescribe: true }).account, vendorId: "github",
        description: { displayName: "old" }, credentialsExpired: true,
      });
      return user.stagePendingRestore(0, STAGE_ID, new Date("2027-06-01"));
    });
    const nonce = await stub.openConnectFlow(0);

    // The credentials went live at the commit; a failed describe() must not leave the account
    // showing as expired, which would send the user back through a reconnect that changes nothing.
    expect(await redeem(stub, ticket, nonce)).toBe("ok");
    await inDo(async user => {
      expect(await fakeAccount(user, "stale").calls())
        .toEqual([`commitReconnect(${STAGE_ID})`, "describe"]);
      expect(user.storage.connectedAccounts.get(0)).toMatchObject({
        credentialsExpired: false, credentialExpiresAt: new Date("2027-06-01"),
        description: { displayName: "old" },
      });
    });
  });

  it("stages a new connect although an old pending record cannot be listed", async () => {
    // A record whose stub no longer deserializes (its Worker was unbound) fails every listing, and
    // cannot be deleted without one. Staging must not depend on it, and the sweep must keep retrying
    // rather than failing the alarm forever.
    const { stub, inDo } = freshUser();
    const before = Date.now();
    const { ticket, nonce } = await inDo(async user => {
      user.ctx.storage.kv.put(`pendingHandoffs:${"0".repeat(64)}`, null);
      expect(() => pendingCount(user)).toThrow();
      const opened = await user.openConnectFlow(0);
      const staged = await user.stagePendingConnect(0, fakeAccount(user, "listable").account, "github");
      const alarm = await user.ctx.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + PENDING_HANDOFF_LIFETIME_MS);
      await user.alarm();
      expect(await user.ctx.storage.getAlarm()).toBeGreaterThanOrEqual(before + PENDING_HANDOFF_LIFETIME_MS);
      return { ticket: staged.ticket, nonce: opened };
    });

    expect(await redeem(stub, ticket, nonce)).toBe("ok");
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)?.vendorId).toBe("github");
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
      expireAll(user.storage.pendingHandoffs);
      await user.alarm();
      expect(pendingCount(user)).toBe(0);
      expect(await fakeAccount(user, "live").calls()).toEqual([]);
      expect(user.storage.connectedAccounts.get(0)?.description).toEqual({ displayName: "live" });
    });
  });

  it("rejects another flow's nonce, spending the ticket and the nonce alike", async () => {
    // Two flows for two accounts, each finished. A ticket presented with the nonce of the other
    // flow — equally, the right nonce paired with the other account's ticket — is refused.
    const { stub, inDo } = freshUser();
    const nonceA = await stub.openConnectFlow(0);
    const nonceB = await stub.openConnectFlow(1);
    const [ticketA, ticketB] = await inDo(async user => {
      user.storage.nextAccountId.put(2);
      const a = await user.stagePendingConnect(0, fakeAccount(user, "flow-a").account, "github");
      const b = await user.stagePendingConnect(1, fakeAccount(user, "flow-b").account, "github");
      return [a.ticket, b.ticket];
    });

    expect(await redeem(stub, ticketA, nonceB)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      // The refused connect is revoked like an expired one, and both records it touched are spent.
      expect(await fakeAccount(user, "flow-a").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(1);
      expect(flowCount(user)).toBe(1);
    });
    // A's ticket is gone, so its own nonce redeems nothing (and is spent by the try)...
    expect(await redeem(stub, ticketA, nonceA)).toBe(EXPIRED);
    // ...and B's nonce is gone, so B's own ticket cannot be redeemed with it.
    expect(await redeem(stub, ticketB, nonceB)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(1)).toBeUndefined();
      expect(await fakeAccount(user, "flow-b").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(0);
      expect(flowCount(user)).toBe(0);
    });
  });

  it("rejects a malformed or expired nonce, spending the ticket", async () => {
    const { stub, inDo } = freshUser();
    const { ticket } = await inDo(user =>
      user.stagePendingConnect(0, fakeAccount(user, "malformed").account, "github"));
    const nonce = await stub.openConnectFlow(0);
    expect(await redeem(stub, ticket, "not-a-nonce")).toBe(EXPIRED);
    // A wrong nonce still spends the ticket, so the right one arrives too late.
    expect(await redeem(stub, ticket, nonce)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(0)).toBeUndefined();
      expect(await fakeAccount(user, "malformed").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(0);
      expect(flowCount(user)).toBe(0);
    });

    const stale = await stub.openConnectFlow(1);
    const { ticket: lateTicket } = await inDo(async user => {
      user.storage.nextAccountId.put(2);
      expireAll(user.storage.pendingConnectFlows);
      return user.stagePendingConnect(1, fakeAccount(user, "stale-flow").account, "github");
    });
    expect(await redeem(stub, lateTicket, stale)).toBe(EXPIRED);
    await inDo(async user => {
      expect(user.storage.connectedAccounts.get(1)).toBeUndefined();
      expect(await fakeAccount(user, "stale-flow").calls()).toEqual(["describe", "revoke"]);
      expect(pendingCount(user)).toBe(0);
      expect(flowCount(user)).toBe(0);
    });
  });

  it("sweeps expired flows from the alarm and leaves live ones", async () => {
    const { inDo } = freshUser();
    await inDo(async user => {
      const stale = await user.openConnectFlow(0);
      await user.openConnectFlow(1);
      const staleHash = await hashSecret(Uint8Array.fromHex(stale));
      const flows = Array.from(user.storage.pendingConnectFlows.list());
      const staleFlow = flows.find(flow => flow.nonceHash === staleHash);
      expect(staleFlow).toMatchObject({ accountId: 0 });
      user.storage.pendingConnectFlows.put({ ...staleFlow, expiresAt: new Date(Date.now() - 1) });

      await user.alarm();
      const [live] = Array.from(user.storage.pendingConnectFlows.list());
      expect(flowCount(user)).toBe(1);
      expect(live.accountId).toBe(1);
      expect(await user.ctx.storage.getAlarm()).toBe(live.expiresAt.getTime());
    });
  });

  it("derives the target origin from PUBLIC_BASE_URL only, failing closed without it", () => {
    expect(handoffTargetOrigin({ PUBLIC_BASE_URL: `${TARGET}/some/path` } as Cloudflare.Env))
      .toBe(TARGET);
    expect(() => handoffTargetOrigin({} as Cloudflare.Env)).toThrow("PUBLIC_BASE_URL");
  });

  it("pairs the nonce a reconnect or expansion returns with that account's ticket", async () => {
    // The pairing the popup relies on: the flow opened alongside the url names the account whose
    // ticket the gatekeeper will later stage. (connectAccount pairs the same way for the id it
    // reserves; it needs a vendor binding, so it is not driven here.)
    const { stub, inDo } = freshUser();
    await inDo(async user => {
      user.storage.nextAccountId.put(2);
      for (const id of [0, 1]) {
        user.storage.connectedAccounts.put({
          id, account: fakeAccount(user, `acct-${id}`).account, vendorId: "github",
          description: { displayName: `acct-${id}`, uniqueName: `acct-${id}` },
        });
      }
    });

    const reconnect = await stub.reconnectAccount(1);
    expect(reconnect.url).toBe("https://gk.example/reconnect/acct-1");
    const restore = await stub.stagePendingRestore(1, STAGE_ID);
    expect(await redeem(stub, restore.ticket, reconnect.nonce)).toBe("ok");

    expect(await stub.ensureAccountResources(0, [])).toBeNull();
    const expansion = await stub.ensureAccountResources(0, ["https://api.github.com/repos/*"]);
    expect(expansion?.url).toBe("https://gk.example/expand/acct-0");
    const expanded = await stub.stagePendingRestore(0, STAGE_ID);
    expect(await redeem(stub, expanded.ticket, expansion!.nonce)).toBe("ok");
    await inDo(async user => {
      expect(await fakeAccount(user, "acct-1").calls()).toContain(`commitReconnect(${STAGE_ID})`);
      expect(await fakeAccount(user, "acct-0").calls()).toEqual(
        expect.arrayContaining(["ensureResources()", `commitReconnect(${STAGE_ID})`]));
      // The empty request opened no flow: only the two redeemed ones ever existed, both spent.
      expect([...user.storage.pendingConnectFlows.list()]).toEqual([]);
    });
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

    await stub.completeConnectHandoff(handoff.ticket, await stub.openConnectFlow(0));
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
