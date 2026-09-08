/**
 * Conformance suite for the kit's assembly.
 *
 * The other workerd suites test one leaf each. This one drives a gatekeeper built from all of them
 * at once, because the contracts that matter to a new consumer are the ones that only appear when
 * the pieces are wired together: a fence captured in one module and checked in another, a cursor
 * whose authorization outlives the call that made it, an action whose provider outcome is unknown.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { RpcStub } from "cloudflare:workers";
import type { ConformanceAccount, ConformanceResource } from "./conformance/gatekeeper";
import {
  advertised,
  FixtureQueue,
  observations,
  overseer,
  provider,
  resetProvider,
  submissions,
} from "./conformance/gatekeeper";

let seq = 0;

/** A fresh account and resource pair, so no test inherits another's durable state. */
function bind() {
  seq += 1;
  const account = env.CONFORMANCE_ACCOUNT.getByName(`account-${seq}`);
  const resource = env.CONFORMANCE_RESOURCE.getByName(`resource-${seq}`);
  return { account, resource };
}

/** Binds the way the overseer hands a session its queue: borrowed for the call, not given away. */
async function bindResource(
  resource: DurableObjectStub<ConformanceResource>,
  account: DurableObjectStub<ConformanceAccount>,
): Promise<void> {
  using queue = new RpcStub(new FixtureQueue());
  await resource.bind(account, queue);
}

/** Runs a full connect handshake, as a user clicking through the connect page does. */
async function connect(account: DurableObjectStub<ConformanceAccount>): Promise<void> {
  const initiation = await account.beginConnect();
  const oauth = await account.beginOAuth(initiation);
  expect(await account.completeConnect(oauth!)).toBe(true);
}

beforeEach(() => {
  resetProvider();
  provider.projects.set("project-a", { id: "project-a", name: "Alpha", spaceId: "space-1" });
  provider.projects.set("project-b", { id: "project-b", name: "Beta", spaceId: "space-2" });
});

describe("credentials and connect", () => {
  it("completes a handshake and serves credentials without refresh material", async () => {
    const { account } = bind();
    await connect(account);

    const read = await account.getCredentials();
    expect(read.creds.accessToken).toMatch(/^user-a-access/);
    expect(read.identity).not.toBe("");
    // The account is the only holder: a resource facet must never see this.
    expect(read.creds).not.toHaveProperty("refreshToken");
  });

  it("survives repeated rotation, which a response-shaped record would not", async () => {
    // The provider omits unchanged fields and rotates the refresh token, so a consumer that stored
    // the response verbatim would lose `scopes` immediately and fail the *second* refresh.
    const { account } = bind();
    await connect(account);
    const first = await account.getCredentials();

    for (let round = 0; round < 3; round++) {
      await account.reportCredentialsRejected((await account.getCredentials()).identity);
    }

    const latest = await account.getCredentials();
    expect(latest.creds.scopes).toEqual(["projects:read", "projects:write"]);
    expect(latest.identity).not.toBe(first.identity);
    // Each rotation revokes the token it replaced, so this is what proves all three refreshed —
    // comparing only the first and last identity passes on one rotation and two no-ops.
    expect(provider.revoked.size).toBe(3);
  });

  it("reports a grant the provider revoked as expiry, not as a recycled 401", async () => {
    // Only the refresh frame can tell the two apart. Left as an ordinary auth error, the account
    // adjudicates "unavailable" and the dead grant stays adoptable as cache authority.
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    provider.controls.grantDead = true;
    provider.controls.rejectCredentials = true;

    await expect(async () => { await resource.searchProjects("Alpha"); })
      .rejects.toThrow(/Reconnect the conformance account/);
  });

  it("refuses a completion whose connection was replaced while it exchanged", async () => {
    // The real race: the disconnect lands *inside* the token exchange, not before it. Checked
    // before the exchange instead of after, this would pass while the window stayed open.
    const { account } = bind();
    await connect(account);
    const initiation = await account.beginConnect();
    const stale = await account.beginOAuth(initiation);

    // The revoke lands inside the exchange, not before it. Checked before the exchange instead of
    // after, this would pass while the window stayed open.
    expect(await account.completeConnect(stale!, true)).toBe(false);
    expect(await account.isConnected()).toBe(false);
  });

  it("refuses a callback whose nonce a newer attempt replaced", async () => {
    const { account } = bind();
    const first = await account.beginConnect();
    const firstOAuth = await account.beginOAuth(first);
    // The user starts over; the handshake holds one attempt, so the first is now dead.
    const second = await account.beginConnect();
    await account.beginOAuth(second);

    expect(await account.completeConnect(firstOAuth!)).toBe(false);
  });
});

describe("observations", () => {
  it("excludes a collaborator from the spaces they cannot see", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    provider.access.set("limited", new Set(["space-1"]));
    await resource.addObserver("limited", "limited");

    using cursor = await resource.listProjects();
    expect((await cursor.next())?.length).toBe(2);

    // Both spaces were disclosed and the collaborator holds only one, so they are excluded.
    expect(observations[0]?.excludeObservers).toEqual(["limited"]);
  });

  it("excludes a collaborator from a search that covered a space they cannot see", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    provider.access.set("limited", new Set(["space-1"]));
    await resource.addObserver("limited", "limited");

    // Only the space-1 project matches, but the search read space-2 as well: the miss there is
    // disclosure too, so naming only the matched space would leak it.
    expect((await resource.searchProjects("Alpha")).map(project => project.id))
      .toEqual(["project-a"]);
    expect(observations[0]?.excludeObservers).toEqual(["limited"]);
  });

  it("authorizes a zero-result search, which is an existence oracle", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    expect(await resource.searchProjects("nothing-matches")).toEqual([]);

    // Absence is provider data: it must not reach the gadget unrecorded.
    expect(observations).toHaveLength(1);
    expect(observations[0]?.description).toMatch(/nothing-matches/);
  });

  it("authorizes the terminal answer of a walk that returned nothing", async () => {
    const { account, resource } = bind();
    provider.projects.clear();
    await connect(account);
    await bindResource(resource, account);

    using cursor = await resource.listProjects();
    expect(await cursor.next()).toBeNull();

    expect(observations.map(sent => sent.description))
      .toEqual(["Listed projects; there were none."]);
  });

  it("authorizes every page of a walk, including one served from the buffer", async () => {
    const { account, resource } = bind();
    for (const index of [1, 2, 3, 4, 5]) {
      provider.projects.set(`extra-${index}`,
        { id: `extra-${index}`, name: `Extra ${index}`, spaceId: "space-1" });
    }
    await connect(account);
    await bindResource(resource, account);

    using cursor = await resource.listProjects();
    let pages = 0;
    while (await cursor.next() !== null) pages += 1;

    // One observation per returned page, and fewer provider fetches than pages — so at least one
    // authorized page was served from the buffer with no fetch behind it.
    expect(observations).toHaveLength(pages);
    expect(pages).toBeGreaterThan(1);
    expect(provider.listCalls).toBeLessThan(pages);
  });

  it("stops a walk whose connection was replaced between pages", async () => {
    // A continuation token is provider state scoped to one account. Presenting it under the next
    // connection would page through the new principal's projects from the old one's offset.
    const { account, resource } = bind();
    for (const index of [1, 2, 3, 4, 5]) {
      provider.projects.set(`extra-${index}`,
        { id: `extra-${index}`, name: `Extra ${index}`, spaceId: "space-1" });
    }
    await connect(account);
    await bindResource(resource, account);

    using cursor = await resource.listProjects();
    expect(await cursor.next()).not.toBeNull();
    await account.disconnect();
    await connect(account);

    await expect(async () => { await cursor.next(); })
      .rejects.toThrow(/walk was started under a connection/);
  });

  it("refuses a held page whose connection was replaced before the retry", async () => {
    // A refused page is held rather than refetched, so the retry never re-enters the fetch where
    // the walk's authority is checked. Without a second check it would disclose the previous
    // connection's rows under the new one.
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    using cursor = await resource.listProjects();
    overseer.refuseNext = true;
    await expect(async () => { await cursor.next(); }).rejects.toThrow(/overseer refused/);

    await account.disconnect();
    await connect(account);

    await expect(async () => { await cursor.next(); })
      .rejects.toThrow(/walk was started under a connection/);
  });
});

describe("actions", () => {
  it("applies a create, then its dependent rename against the real provider id", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    const create = await resource.submit("createProject",
      { ref: "~new", name: "Gamma", spaceId: "space-1" });
    const rename = await resource.submit("renameProject",
      { target: "~new", name: "Gamma Renamed" });

    await resource.apply(create);
    await resource.apply(rename);

    // The provisional reference resolved to whatever the provider minted.
    expect([...provider.projects.values()].map(project => project.name))
      .toContain("Gamma Renamed");
  });

  it("puts every staged action through the approval queue with its rendered description", async () => {
    // Without this the whole queue seam is untested: a consumer that stopped calling
    // `submitAction` would still allocate a journal record and still apply.
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    const id = await resource.submit("createProject",
      { ref: "~queued", name: "Iota", spaceId: "space-1" });

    expect(submissions).toEqual([[id, {
      title: 'Create project "Iota"',
      description: "Creates **Iota** in space space-1.",
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag: "create-project", label: "Create a project" },
    }]]);
  });

  it("refuses to dispatch a dependent whose reference is still provisional", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    await resource.submit("createProject",
      { ref: "~later", name: "Delta", spaceId: "space-1" });
    const rename = await resource.submit("renameProject",
      { target: "~later", name: "Delta Renamed" });

    // Passing "~later" to the provider is what must not happen.
    await expect(async () => { await resource.apply(rename); }).rejects.toThrow(/not applied yet/);
  });

  it("records an ambiguous provider outcome without claiming the effect did not land", async () => {
    // The create reaches the provider, which commits it and then times out. Marking this
    // "not applied" would be a lie, and replaying it would create a second project.
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    provider.controls.timeoutAfterCreate = true;
    const create = await resource.submit("createProject",
      { ref: "~ghost", name: "Epsilon", spaceId: "space-1" });

    await expect(async () => { await resource.apply(create); }).rejects.toThrow(/timed out/);

    expect(await resource.record(create)).toMatchObject({ state: "failed", outcome: "unknown" });

    // Terminal: a second approval is refused before the provider is reached, so the effect that
    // did land stays a single one.
    provider.controls.timeoutAfterCreate = false;
    await expect(async () => { await resource.apply(create); }).rejects.toThrow(/timed out/);
    expect([...provider.projects.values()].filter(project => project.name === "Epsilon"))
      .toHaveLength(1);
  });

  it("keeps a dependent decidable when its provider's outcome is unknown", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    provider.controls.timeoutAfterCreate = true;
    const create = await resource.submit("createProject",
      { ref: "~maybe", name: "Zeta", spaceId: "space-1" });
    const rename = await resource.submit("renameProject",
      { target: "~maybe", name: "Zeta Renamed" });

    await expect(async () => { await resource.apply(create); }).rejects.toThrow(/timed out/);

    // The project may exist, so retiring the rename would destroy viable work.
    expect((await resource.record(rename))?.state).toBe("pending");
  });
});

describe("assembly", () => {
  it("advertises a commit through the gate rather than a raw queue stub", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    await resource.advertiseHead("abc123");

    expect(advertised).toEqual(["abc123"]);
  });

  it("repartitions the cache when the account reconnects as another principal", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    expect((await resource.searchProjects("Alpha")).map(project => project.id))
      .toEqual(["project-a"]);

    // The provider now answers as someone else, and the account reconnects to them. A cache keyed
    // on a last-seen fence would keep serving the previous principal's hit for the whole TTL.
    provider.principal = "user-b";
    provider.projects.set("project-c", { id: "project-c", name: "Alpha two", spaceId: "space-9" });
    await account.disconnect();
    await connect(account);

    expect((await resource.searchProjects("Alpha")).map(project => project.id))
      .toEqual(["project-a", "project-c"]);
  });

  it("stops a warm facet reading a grant another facet's rejection buried", async () => {
    const { account, resource } = bind();
    const other = env.CONFORMANCE_RESOURCE.getByName(`resource-${seq}-b`);
    await connect(account);
    await bindResource(resource, account);
    await bindResource(other, account);

    // The second facet vouches for the grant and warms its cache under it.
    expect((await other.searchProjects("Alpha")).map(project => project.id)).toEqual(["project-a"]);

    provider.controls.grantDead = true;
    provider.controls.rejectCredentials = true;
    await expect(async () => { await resource.searchProjects("Alpha"); })
      .rejects.toThrow(/Reconnect the conformance account/);

    // The account recorded the death, so the warm facet must refuse rather than serve its hit --
    // nothing about the grant's own hour-long expiry says it is dead.
    await expect(async () => { await other.searchProjects("Alpha"); })
      .rejects.toThrow(/credentials have expired/);

    provider.controls.grantDead = false;
    provider.controls.rejectCredentials = false;
    await account.disconnect();
    await connect(account);

    expect((await other.searchProjects("Alpha")).map(project => project.id)).toEqual(["project-a"]);
  });

  it("keeps a cursor's lease walking after its resource rebinds", async () => {
    const { account, resource } = bind();
    for (const index of [1, 2, 3]) {
      provider.projects.set(`extra-${index}`,
        { id: `extra-${index}`, name: `Extra ${index}`, spaceId: "space-1" });
    }
    await connect(account);
    await bindResource(resource, account);

    using cursor = await resource.listProjects();
    expect(await cursor.next()).not.toBeNull();
    const authorized = observations.length;

    // Rebinding releases the queue and gate the previous bind made; the cursor's lease owns its
    // own dup and must outlive both.
    await bindResource(resource, account);

    expect(await cursor.next()).not.toBeNull();
    expect(observations).toHaveLength(authorized + 1);
  });

  it("refreshes and retries a read whose stored access token the provider has rotated", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    // The provider issues a newer token, so the stored one now 401s exactly as a stale one does.
    provider.mint();

    expect((await resource.searchProjects("Alpha")).map(project => project.id))
      .toEqual(["project-a"]);
    // The rotating refresh revokes the token it replaced, so this proves the read went through a
    // refresh rather than being served by a token the provider should have rejected.
    expect(provider.revoked.size).toBe(1);
  });

  it("refuses an action approved under a connection that has since been replaced", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    const staged = await resource.submit("createProject",
      { ref: "~fenced", name: "Fenced", spaceId: "space-1" });

    await account.disconnect();
    await connect(account);

    await expect(async () => { await resource.apply(staged); })
      .rejects.toThrow(/has since been replaced/);
    expect((await resource.record(staged))?.state).toBe("failed");
  });

  it("refuses a reconnect landing after apply's entry check but before the provider call", async () => {
    // The entry check passes under connection A and the provider call would run under B. Only the
    // handler comparing its own read against the fence closes this; nothing earlier can.
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);
    const staged = await resource.submit("createProject",
      { ref: "~raced", name: "Raced", spaceId: "space-1" });

    await expect(async () => { await resource.apply(staged, true); })
      .rejects.toThrow(/has since been replaced/);
    // The provider was never called, so no project was created under the new connection — and the
    // record is terminal, not restored to pending under a fence that can never match again.
    expect([...provider.projects.values()].map(project => project.name)).not.toContain("Raced");
    expect((await resource.record(staged))?.state).toBe("failed");
  });

  it("keeps two journals over one Durable Object from seeing each other", async () => {
    const { account, resource } = bind();
    await connect(account);
    await bindResource(resource, account);

    const { ids, names } = await resource.isolation();

    // Each journal issues id 1 and reads back its own payload. Sharing a keyspace would make the
    // second allocation collide with the first and both would read the same record.
    expect(ids).toEqual([1, 1]);
    expect(names).toEqual(["left-project", "right-project"]);
  });
});
