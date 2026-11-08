// Who may observe a workspace that read PagerDuty: an observer whose own connection is to the same
// account, with a base role that sees its objects, and which PagerDuty opens each reported object
// for. A 403 or 404 is a definite no; anything else fails the whole answer. Answers are reused per
// observer connection for a while, so a busy workspace doesn't probe PagerDuty on every read.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALICE, BOB, CAROL, DAVE, FakePagerDuty, POLICY, SCHEDULE, SERVICE, SHIFT_SCHEDULE, TEAM, accountStub, failure, hooks, json,
  seedAccount, sub, unwrap,
} from "./fake-pagerduty";
import type { GatekeeperProps } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An account binding owned by Alice that has read once, so it is pinned to her account. */
async function setup() {
  const pd = new FakePagerDuty().install();
  const props: GatekeeperProps = { userObjectId: await seedAccount(pd), region: "us", subdomain: "acme", resourceKind: "account" };
  const name = crypto.randomUUID();
  unwrap(await hooks().run(name, props, [["getMetadata"]]));
  return {
    pd,
    verify: async (observers: { id: string; userObjectId: string }[], subresources: string[]) =>
      await hooks().verifyObserverAccess(name, props, observers, subresources),
    unread: { name: crypto.randomUUID(), props },
    name, props,
  };
}

const SERVICE_ID = sub("service", SERVICE.id);

describe("verifyObserverAccess", () => {
  it("allows a colleague PagerDuty opens each object for, and denies one it refuses with 403 or 404", async () => {
    const t = await setup();
    t.pd.hide(BOB.id, SERVICE.id, 403);
    const observers = [
      { id: "alice", userObjectId: await seedAccount(t.pd, ALICE) },
      { id: "bob", userObjectId: await seedAccount(t.pd, BOB) },
    ];
    expect(unwrap(await t.verify(observers, [sub(), SERVICE_ID]))).toEqual({ allowedObserverIds: ["alice"] });
    expect(unwrap(await t.verify(observers, [sub()]))).toEqual({ allowedObserverIds: ["alice", "bob"] });
    t.pd.hide(ALICE.id, SERVICE.id, 404);
    const later = [{ id: "alice", userObjectId: await seedAccount(t.pd, ALICE) }];
    expect(unwrap(await t.verify(later, [sub(), SERVICE_ID]))).toEqual({ allowedObserverIds: [] });
  });

  it("opens each kind of object where PagerDuty keeps it, denying the whole set for one refusal", async () => {
    const t = await setup();
    const incident = t.pd.incident(SERVICE);
    const objects = [
      sub("team", TEAM.id), sub("incident", incident.id), sub("schedule", SCHEDULE.id), sub("escalation_policy", POLICY.id),
    ];
    const bob = [{ id: "bob", userObjectId: await seedAccount(t.pd, BOB) }];
    expect(unwrap(await t.verify(bob, [sub(), ...objects]))).toEqual({ allowedObserverIds: ["bob"] });
    // A layer-based schedule is opened by v2 once v3 refuses it.
    expect(t.pd.matching("GET", /./, BOB.id).map(r => r.url.pathname).filter(path => path !== "/users/me").toSorted()).toEqual([
      `/escalation_policies/${POLICY.id}`, `/incidents/${incident.id}`, `/schedules/${SCHEDULE.id}`, `/teams/${TEAM.id}`,
      `/v3/schedules/${SCHEDULE.id}`,
    ]);
    t.pd.hide(ALICE.id, SCHEDULE.id);
    const alice = [{ id: "alice", userObjectId: await seedAccount(t.pd, ALICE) }];
    expect(unwrap(await t.verify(alice, [sub(), ...objects]))).toEqual({ allowedObserverIds: [] });
  });

  it("opens a shift-based schedule through PagerDuty's v3 API, denying an observer it refuses", async () => {
    const t = await setup();
    t.pd.hide(BOB.id, SHIFT_SCHEDULE.id, 404);
    const observers = [
      { id: "alice", userObjectId: await seedAccount(t.pd, ALICE) },
      { id: "bob", userObjectId: await seedAccount(t.pd, BOB) },
    ];
    expect(unwrap(await t.verify(observers, [sub(), sub("schedule", SHIFT_SCHEDULE.id)]))).toEqual({ allowedObserverIds: ["alice"] });
    expect(t.pd.matching("GET", /^\/schedules\//)).toEqual([]);
  });

  it("denies an observer connected to another account, without asking PagerDuty about its objects", async () => {
    const t = await setup();
    const dave = await seedAccount(t.pd, DAVE);
    expect(unwrap(await t.verify([{ id: "dave", userObjectId: dave }], [sub(), SERVICE_ID]))).toEqual({ allowedObserverIds: [] });
    expect(t.pd.matching("GET", /^\/services\//, DAVE.id)).toHaveLength(0);
  });

  it("denies a Limited Stakeholder the account, whose role sees none of its objects", async () => {
    const t = await setup();
    const carol = await seedAccount(t.pd, CAROL);
    const bob = await seedAccount(t.pd, BOB);
    expect(unwrap(await t.verify([{ id: "carol", userObjectId: carol }, { id: "bob", userObjectId: bob }], [sub()])))
      .toEqual({ allowedObserverIds: ["bob"] });
  });

  it.each([undefined, "billing_manager"])("denies an observer the account when PagerDuty gives their role as %s, not one known to see its objects", async role => {
    const t = await setup();
    const bob = await seedAccount(t.pd, BOB);
    t.pd.users.get(BOB.id)!.role = role;
    expect(unwrap(await t.verify([{ id: "bob", userObjectId: bob }], [sub()]))).toEqual({ allowedObserverIds: [] });
  });

  it("reuses an observer connection's answers rather than probing again", async () => {
    const t = await setup();
    const bob = await seedAccount(t.pd, BOB);
    const carol = await seedAccount(t.pd, CAROL);
    for (let i = 0; i < 2; i++) {
      expect(unwrap(await t.verify([{ id: "bob", userObjectId: bob }, { id: "carol", userObjectId: carol }], [sub(), SERVICE_ID])))
        .toEqual({ allowedObserverIds: ["bob"] });
    }
    expect(t.pd.matching("GET", /^\/services\/PSVC001$/, BOB.id)).toHaveLength(1);
    expect(t.pd.matching("GET", /^\/users\/me$/, BOB.id)).toHaveLength(1);
    expect(t.pd.matching("GET", /^\/users\/me$/, CAROL.id)).toHaveLength(1);
  });

  it("fails the whole answer when PagerDuty can't say, rather than deny", async () => {
    const t = await setup();
    const bob = await seedAccount(t.pd, BOB);
    t.pd.on("GET", /^\/services\//, () => json({ error: { message: "Internal error" } }, { status: 500 }));
    expect(failure(await t.verify([{ id: "bob", userObjectId: bob }], [sub(), SERVICE_ID]))).toMatch(/HTTP 500/);
  });

  it("refreshes an observer token PagerDuty refuses, and fails rather than deny once the grant is dead", async () => {
    const t = await setup();
    /** Makes PagerDuty refuse Bob's tokens, those starting with `prefix`. */
    const revoke = (prefix: string) => {
      for (const [token, owner] of t.pd.tokens) if (owner === BOB.id && token.startsWith(prefix)) t.pd.tokens.delete(token);
    };
    const healed = await seedAccount(t.pd, BOB);
    revoke("access-");
    expect(unwrap(await t.verify([{ id: "bob", userObjectId: healed }], [sub(), SERVICE_ID]))).toEqual({ allowedObserverIds: ["bob"] });
    expect(t.pd.matching("POST", /^\/oauth\/token$/)).toHaveLength(1);

    const dead = await seedAccount(t.pd, BOB);
    revoke("");
    expect(failure(await t.verify([{ id: "bob", userObjectId: dead }], [sub(), SERVICE_ID]))).toMatch(/Reconnect the PagerDuty account/);
    // Read inside the account: a rejection crossing RPC also reports as unhandled.
    expect(await runInDurableObject(accountStub(dead), instance => instance.getCredentials().then(() => "live", (error: Error) => error.message)))
      .toMatch(/Reconnect the PagerDuty account/);
  });

  it("refuses IDs of another account, and IDs that aren't PagerDuty's", async () => {
    const t = await setup();
    const observers = [{ id: "bob", userObjectId: await seedAccount(t.pd, BOB) }];
    expect(failure(await t.verify(observers, [sub(), "region/eu/account/PACME01"]))).toMatch(/another PagerDuty account/);
    expect(failure(await t.verify(observers, [sub(), "region/us/account/POTHER1/service/PSVC001"]))).toMatch(/another PagerDuty account/);
    for (const id of [
      "region/us/account/PACME01/user/PALICE1",
      "region/us/account/PACME01/service/psvc001",
      "region/ca/account/PACME01",
      "account/PACME01",
      "pagerduty/region/us/account/PACME01",
      "region/us/account/PACME01/service/PSVC001/incident/PINC001",
    ]) {
      expect(failure(await t.verify(observers, [sub(), id])), id).toMatch(/Not a PagerDuty subresource ID/);
    }
  });

  it("refuses to answer for a binding that has read nothing yet", async () => {
    const t = await setup();
    const observers = [{ id: "bob", userObjectId: await seedAccount(t.pd, BOB) }];
    expect(failure(await hooks().verifyObserverAccess(t.unread.name, t.unread.props, observers, [sub()])))
      .toMatch(/has not read anything yet/);
  });

  it("has no legacy history to export", async () => {
    const t = await setup();
    expect(unwrap(await hooks().historicalSubresources(t.name, t.props))).toEqual([]);
  });
});
