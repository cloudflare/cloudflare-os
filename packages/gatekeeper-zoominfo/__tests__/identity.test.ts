// Which ZoomInfo user each read reports. A connection keeps its user's ID, the `sub` of the ID
// token ZoomInfo returns with every grant; a connection made before it was kept learns it from its
// next refresh, or must be reconnected. What the binding stored -- enrichment outcomes, cached
// lookups -- keeps the user it came from across reconnects, and what has no recorded user is never
// attributed to whoever the connection acts for now. ZoomInfo is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  ALICE, BOB, CLIENT_ID, FakeZoomInfo, accountStub, accountValue, failure, hooks, reconnectAs,
  seedAccount, unwrap,
} from "./fake-zoominfo";
import type { GatekeeperProps, Step } from "./worker";

const ALICE_ID = "user/00u1alice";
const BOB_ID = "user/00u2bob";

const ENRICH: Step = ["enrichCompanies", [{ companyId: "7" }], ["name"]];

type Ticket = { id: number; kind: string; summary: string };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A binding to the connection `userObjectId`, its queue's log, and its gatekeeper's calls. */
function binding(userObjectId: string) {
  const props: GatekeeperProps = { userObjectId };
  const name = crypto.randomUUID();
  return {
    run: (step: Step) => hooks().run(name, props, step),
    apply: (ticket: Ticket) => hooks().applyAction(name, props, ticket.id),
    reject: (ticket: Ticket) => hooks().rejectAction(name, props, ticket.id),
    seed: (entries: Record<string, unknown>) => hooks().seedStorage(name, props, entries),
    /** The subresources each observation since the last call reported. */
    reported: (() => {
      let seen = 0;
      return async () => {
        const { observations } = await hooks().queueLog(name);
        return observations.slice(seen, seen = observations.length).map(observation => observation.subresources);
      };
    })(),
  };
}

/** Runs a first connect in which Alice signs in, ZoomInfo's ID token saying `claims`. */
async function connect(fake: FakeZoomInfo, claims: Record<string, unknown> | null) {
  fake.idToken = () => claims;
  const id = env.USER_ACCOUNT.newUniqueId().toString();
  const initiation = generateNonce();
  await hooks().installCallback(id, initiation);
  const accepted = await runInDurableObject(accountStub(id), async instance => {
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the connect did not start");
    return await instance.acceptAuthCode(fake.code(ALICE), flow.oauthNonce).then(
      handoff => ({ ok: handoff }), (error: Error) => ({ error: error.message }));
  });
  return { id, accepted };
}

/** A connection as Alice whose binding holds an approved result, a pending request and a cached lookup. */
async function aliceWithHistory(fake: FakeZoomInfo) {
  const id = await seedAccount(fake, ALICE);
  const zoominfo = binding(id);
  const done = unwrap(await zoominfo.run(ENRICH)) as Ticket;
  unwrap(await zoominfo.apply(done));
  const pending = unwrap(await zoominfo.run(ENRICH)) as Ticket;
  unwrap(await zoominfo.run(["lookup", "industries"]));
  await zoominfo.reported();
  return { id, zoominfo, done, pending };
}

describe("connecting", () => {
  it.each([
    ["no ID token", null],
    ["an ID token naming no user", { aud: CLIENT_ID, email: ALICE.email }],
    ["an ID token for another client", { sub: ALICE.sub, aud: "another-client" }],
  ])("is refused on %s, leaving no credentials", async (_label, claims) => {
    const fake = new FakeZoomInfo().install();
    const { id, accepted } = await connect(fake, claims);
    expect(failure(accepted)).toMatch(/did not identify the user who signed in/);
    expect(await accountValue(id, "refreshToken")).toBeUndefined();
    expect(await accountValue(id, "userId")).toBeUndefined();
  });
});

describe("a connection made before its user's ID was kept", () => {
  it("learns its user from the ID token of an early refresh, and reports them", async () => {
    const fake = new FakeZoomInfo().install();
    const id = await seedAccount(fake, ALICE, { legacy: true });
    const zoominfo = binding(id);
    unwrap(await zoominfo.run(["searchCompanies", {}]));
    expect(fake.count(/^POST \/gtm\/oauth\/v1\/token$/)).toBe(1);
    expect(await zoominfo.reported()).toEqual([[ALICE_ID]]);
    expect(await accountValue(id, "userId")).toBe(ALICE.sub);
    // Once known, the user is read with the token, with no further refresh.
    unwrap(await zoominfo.run(["getCreditUsage"]));
    expect(fake.count(/^POST \/gtm\/oauth\/v1\/token$/)).toBe(1);
  });

  it("must be reconnected when ZoomInfo's refresh doesn't identify the user, and returns nothing", async () => {
    const fake = new FakeZoomInfo().install();
    const id = await seedAccount(fake, ALICE, { legacy: true });
    fake.idToken = () => null;
    const zoominfo = binding(id);
    expect(failure(await zoominfo.run(["searchCompanies", {}]))).toMatch(/Please reconnect the account/);
    expect(fake.count(/^POST \/gtm\/data\//)).toBe(0);
    expect(await zoominfo.reported()).toEqual([]);
    expect(await hooks().expiredNotices(id)).toBe(1);

    fake.idToken = user => ({ sub: user.sub, aud: CLIENT_ID });
    await reconnectAs(fake, id, ALICE);
    unwrap(await zoominfo.run(["searchCompanies", {}]));
    expect(await zoominfo.reported()).toEqual([[ALICE_ID]]);
  });

  it("spends nothing on an approval until it is identified, leaving the enrichment pending", async () => {
    const fake = new FakeZoomInfo().install();
    const id = await seedAccount(fake, ALICE, { legacy: true });
    fake.idToken = () => null;
    const zoominfo = binding(id);
    const ticket = unwrap(await zoominfo.run(ENRICH)) as Ticket;
    expect(failure(await zoominfo.apply(ticket))).toMatch(/Please reconnect the account/);
    expect(fake.count(/enrich$/)).toBe(0);

    fake.idToken = user => ({ sub: user.sub, aud: CLIENT_ID });
    await reconnectAs(fake, id, ALICE);
    expect(unwrap(await zoominfo.run(["getEnrichmentResult", ticket]))).toEqual({ status: "pending" });
    unwrap(await zoominfo.apply(ticket));
    expect(unwrap(await zoominfo.run(["getEnrichmentResult", ticket]))).toMatchObject({ status: "ready" });
    expect(await zoominfo.reported()).toEqual([[ALICE_ID], [ALICE_ID]]);
  });

  it("returns no stored outcome it can't attribute, and serves no cached lookup it can't", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = binding(await seedAccount(fake, ALICE));
    const ticket = unwrap(await zoominfo.run(ENRICH)) as Ticket;
    // As an earlier version left them: an outcome and a cache entry naming no user.
    await zoominfo.seed({
      [`enrich:result:${ticket.id}`]: { status: "ready", result: [] },
      "cache:lookup:industries:{}": { value: [{ id: "1", type: "Value", name: "old value" }], fetchedAt: Date.now() },
    });
    expect(failure(await zoominfo.run(["getEnrichmentResult", ticket])))
      .toMatch(/stored without the ZoomInfo user who retrieved it/);
    expect(unwrap(await zoominfo.run(["lookup", "industries"]))).toEqual([
      { id: "1", type: "Value", name: "Alice's value", attributes: {} },
    ]);
    expect(await zoominfo.reported()).toEqual([[ALICE_ID]]);
  });
});

describe("a refresh", () => {
  it("whose ID token names another user fails closed, keeping the connection's user", async () => {
    const fake = new FakeZoomInfo().install();
    const id = await seedAccount(fake, ALICE, { expiresInMs: 0 });
    fake.idToken = () => ({ sub: BOB.sub, aud: CLIENT_ID });
    const zoominfo = binding(id);
    expect(failure(await zoominfo.run(["searchCompanies", {}]))).toMatch(/different user/);
    expect(fake.count(/^POST \/gtm\/data\//)).toBe(0);
    expect(await accountValue(id, "userId")).toBe(ALICE.sub);
  });
});

describe("enrichment outcomes", () => {
  it("each report the user they belong to: the result's producer, else the connection's", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = binding(await seedAccount(fake, ALICE));
    const tickets: Ticket[] = [];
    for (let i = 0; i < 4; i++) tickets.push(unwrap(await zoominfo.run(ENRICH)) as Ticket);
    // The fourth stays pending.
    const [ready, failed, rejected] = tickets;
    unwrap(await zoominfo.apply(ready));
    fake.failEnrichment = true;
    unwrap(await zoominfo.apply(failed));
    unwrap(await zoominfo.reject(rejected));
    const outcomes = [];
    for (const ticket of tickets) outcomes.push(unwrap(await zoominfo.run(["getEnrichmentResult", ticket])));
    expect(outcomes).toEqual([
      { status: "ready", kind: "companies", result: [expect.objectContaining({ status: "matched" })] },
      { status: "failed", message: expect.stringMatching(/503/) },
      { status: "rejected" },
      { status: "pending" },
    ]);
    expect(await zoominfo.reported()).toEqual([[ALICE_ID], [ALICE_ID], [ALICE_ID], [ALICE_ID]]);
  });
});

describe("reconnecting", () => {
  it("as the same user keeps reporting that user, cache hits included", async () => {
    const fake = new FakeZoomInfo().install();
    const { id, zoominfo, done, pending } = await aliceWithHistory(fake);
    await reconnectAs(fake, id, ALICE);
    const lookups = fake.count(/^GET \/gtm\/data\/v1\/lookup\//);
    unwrap(await zoominfo.run(["lookup", "industries"]));
    expect(fake.count(/^GET \/gtm\/data\/v1\/lookup\//)).toBe(lookups);
    unwrap(await zoominfo.run(["getEnrichmentResult", done]));
    unwrap(await zoominfo.run(["getEnrichmentResult", pending]));
    expect(await zoominfo.reported()).toEqual([[ALICE_ID], [ALICE_ID], [ALICE_ID]]);
  });

  it("as another user reports new reads as them, never what earlier credentials returned", async () => {
    const fake = new FakeZoomInfo().install();
    const { id, zoominfo, done, pending } = await aliceWithHistory(fake);
    await reconnectAs(fake, id, BOB);
    // The ID token's `sub` is kept as the user; its name and email only display them.
    expect(await accountValue(id, "userId")).toBe(BOB.sub);
    expect(await accountValue(id, "identity")).toEqual({ displayName: BOB.name, uniqueName: BOB.email });

    // Alice's result stays hers; Bob's connection doesn't make it his.
    expect(unwrap(await zoominfo.run(["getEnrichmentResult", done]))).toMatchObject({
      status: "ready", result: [{ record: { fields: { enrichedFor: "Alice" } } }],
    });
    // Alice's cached lookup isn't served to Bob: his entitlements are fetched with his token.
    expect(unwrap(await zoominfo.run(["lookup", "industries"]))).toEqual([
      { id: "1", type: "Value", name: "Bob's value", attributes: {} },
    ]);
    // The pending request holds nothing yet; once approved it spends Bob's credits on Bob's data.
    expect(unwrap(await zoominfo.run(["getEnrichmentResult", pending]))).toEqual({ status: "pending" });
    unwrap(await zoominfo.apply(pending));
    expect(unwrap(await zoominfo.run(["getEnrichmentResult", pending]))).toMatchObject({
      status: "ready", result: [{ record: { fields: { enrichedFor: "Bob" } } }],
    });
    expect(await zoominfo.reported()).toEqual([[ALICE_ID], [BOB_ID], [BOB_ID], [BOB_ID]]);
  });
});
