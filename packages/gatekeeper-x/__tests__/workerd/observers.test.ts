// Who may observe a workspace that reads X (plans/x-gatekeeper.md §7). Every read reports what
// restricts who may see it: nothing for a public read, and for one private to the account the X
// user the connection is pinned to, `user/<id>`, which verifyObserverAccess() grants only to
// observers connected as that same X user, without asking X. What reads recorded before they
// reported subresources -- only ever the `owner` collection -- is still guarded by addObserver() and
// exported by getHistoricalSubresources().

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { scopesFor } from "../../src/x-env";
import { ALICE, BOB, CAROL, FakeX, accountStub, failure, hooks, json, reconnectAs, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What every read private to Alice's account reports. */
const ALICE_USER = `user/${ALICE.id}`;
const DAY_MS = 24 * 60 * 60 * 1000;

async function accountBinding(x: FakeX) {
  const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
  return { props, name: crypto.randomUUID() };
}

async function subresources(name: string): Promise<(string[] | undefined)[]> {
  return (await hooks().queueLog(name)).observations.map(o => o.subresources);
}

async function readsUsed(userObjectId: string): Promise<number | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<{ used: number }>("reads")?.used);
}

/** An observer whose connection is gone: its account no longer names anyone. */
async function disconnected(x: FakeX): Promise<string> {
  const gone = await seedAccount(x, ALICE);
  await runInDurableObject(accountStub(gone), async (_instance, state) => state.storage.kv.delete("identity"));
  return gone;
}

/** An observer whose grant X refused for good, though its identity remains. */
async function deadGrant(x: FakeX, user = ALICE): Promise<string> {
  const dead = await seedAccount(x, user, { expiresInMs: 0 });
  await hooks().installCallback(dead, generateNonce(), scopesFor());
  x.on("POST", /^\/2\/oauth2\/token/, () => json({ error: "invalid_grant", error_description: "Token was revoked." }, { status: 400 }));
  return dead;
}

describe("verifyObserverAccess", () => {
  it("allows only observers connected as the binding's X user, without a request to X", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    x.bookmarks.add(`${ALICE.id}:${x.post(BOB, "saved").id}`);
    unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 }));
    expect(await subresources(name)).toEqual([[ALICE_USER]]);

    // Identities a day old, which a read of the identity would refresh at X.
    const aliceElsewhere = await seedAccount(x, ALICE, { identity: { fetchedAt: Date.now() - 2 * DAY_MS } });
    const bob = await seedAccount(x, BOB, { identity: { fetchedAt: Date.now() - 2 * DAY_MS } });
    const before = x.requests.length;
    expect(unwrap(await hooks().verifyObserverAccess(name, props, [
      { id: "alice-elsewhere", userObjectId: aliceElsewhere },
      { id: "bob", userObjectId: bob },
    ], [ALICE_USER]))).toEqual({ allowedObserverIds: ["alice-elsewhere"] });
    expect(x.requests).toHaveLength(before);
    expect(await readsUsed(aliceElsewhere)).toBeUndefined();
    expect(await readsUsed(bob)).toBeUndefined();
  });

  it("fails the whole call when an observer's connection can't say who they are", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["isMuted"]]));
    const owner = { id: "alice-elsewhere", userObjectId: await seedAccount(x, ALICE) };
    for (const userObjectId of [await disconnected(x), await deadGrant(x)]) {
      expect(failure(await hooks().verifyObserverAccess(name, props, [owner, { id: "alice", userObjectId }], [ALICE_USER])))
        .toMatch(/X connection has expired\. They need to reconnect it/);
    }
  });

  it("fails the whole call when an observer's account can't answer, rather than deny them", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["isMuted"]]));
    const flaky = await seedAccount(x, ALICE, { expiresInMs: 0 });
    x.on("POST", /^\/2\/oauth2\/token/, () => json({ error: "temporarily_unavailable" }, { status: 503 }));
    const message = failure(await hooks().verifyObserverAccess(name, props, [{ id: "alice", userObjectId: flaky }], [ALICE_USER]));
    expect(message).not.toMatch(/expired/);
  });

  it("refuses every ID but the binding's own X user", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    unwrap(await hooks().run(name, props, [["getProfile"]]));
    const observers = [{ id: "alice-elsewhere", userObjectId: await seedAccount(x, ALICE) }];
    for (const id of [
      `user/${BOB.id}`,
      // Not the canonical spelling, a handle, or not a user at all.
      "user/%31001",
      "user/alice",
      "user/@alice",
      "users/1001",
      "x/user/1001",
      "user/1001/post/5",
      "post/1001",
      "list/77",
      "owner",
      // Other gatekeepers' IDs.
      "gmail/user/1001",
      "server/1001",
    ]) {
      expect(failure(await hooks().verifyObserverAccess(name, props, observers, [ALICE_USER, id])), id)
        .toMatch(/subresource ID/);
    }
    expect(failure(await hooks().verifyObserverAccess(name, props, observers, []))).toMatch(/no subresources/);
  });

  it("refuses to answer for a binding that has never named its X user", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    const observers = [{ id: "alice-elsewhere", userObjectId: await seedAccount(x, ALICE) }];
    expect(failure(await hooks().verifyObserverAccess(name, props, observers, [ALICE_USER])))
      .toMatch(/has not read anything as its X account/);
  });

  it("names the same X user across same-user reconnects, the binding's and the observer's", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["isMuted"]]));
    const observer = await seedAccount(x, ALICE);
    for (const account of [props.userObjectId, observer]) {
      await hooks().installCallback(account, generateNonce(), scopesFor());
      const { handoff } = await reconnectAs(x, account, ALICE) as { handoff: { ticket: string } };
      unwrap(await hooks().account(account, "commitReconnect", handoff.ticket));
    }
    // A reconnect as anyone else is refused, so neither pin moves.
    await hooks().installCallback(observer, generateNonce(), scopesFor());
    expect(await reconnectAs(x, observer, BOB)).toMatchObject({ refused: expect.anything() });
    hooks().restart(name);
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["isMuted"]]));
    expect(await subresources(name)).toEqual([[ALICE_USER], [ALICE_USER]]);
    expect(unwrap(await hooks().verifyObserverAccess(name, props, [{ id: "alice", userObjectId: observer }], [ALICE_USER])))
      .toEqual({ allowedObserverIds: ["alice"] });
  });
});

describe("a Post or List binding", () => {
  it("reports what the bound post discloses, and asks X nothing about an observer", async () => {
    const x = new FakeX().install();
    x.following.add(`${ALICE.id}:${CAROL.id}`);
    const protectedPost = x.post(CAROL, "followers only");
    const publicPost = x.post(BOB, "public");
    const bob = await seedAccount(x, BOB);
    for (const [post, expected] of [[protectedPost, [ALICE_USER]], [publicPost, []]] as const) {
      const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "post", postId: post.id };
      const name = crypto.randomUUID();
      unwrap(await hooks().run(name, props, [["getInfo"]]));
      expect(await subresources(name)).toEqual([expected]);
      const before = x.requests.length;
      // Bob can't see Carol's post, and nothing asks whether he can.
      unwrap(await hooks().addObserver(name, props, "bob", bob));
      expect(x.requests).toHaveLength(before);
    }
    expect(await readsUsed(bob)).toBeUndefined();
  });

  it("reports a private List as the account's, and admits observers without asking X about it", async () => {
    const x = new FakeX().install();
    x.lists.set("5", { id: "5", name: "Mine", private: true, owner_id: ALICE.id, member_count: 0 });
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "list", listId: "5" };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["getInfo"]]));
    expect(await subresources(name)).toEqual([[ALICE_USER]]);
    const bob = await seedAccount(x, BOB);
    const before = x.requests.length;
    unwrap(await hooks().addObserver(name, props, "bob", bob));
    expect(unwrap(await hooks().verifyObserverAccess(name, props, [{ id: "bob", userObjectId: bob }], [ALICE_USER])))
      .toEqual({ allowedObserverIds: [] });
    expect(x.requests).toHaveLength(before);
  });
});

describe("addObserver", () => {
  it("admits anyone, working X connection or not, when no read recorded private data before", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    x.bookmarks.add(`${ALICE.id}:${x.post(BOB, "saved").id}`);
    unwrap(await hooks().run(name, props, [["getProfile"]]));
    // A private read now reports the X user instead of recording it here.
    unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 }));
    const observers = [await seedAccount(x, BOB), await disconnected(x), await deadGrant(x, BOB)];
    const before = x.requests.length;
    for (const [index, observer] of observers.entries()) {
      unwrap(await hooks().addObserver(name, props, `observer-${index}`, observer));
    }
    expect(x.requests).toHaveLength(before);
    expect(unwrap(await hooks().historicalSubresources(name, props))).toEqual([]);
  });

  it.each([["observed", "observed"], ["pending", "pending"], ["legacy true", true]] as const)(
    "keeps a private read recorded before reads reported subresources (%s) for the same X user",
    async (_label, recorded) => {
      const x = new FakeX().install();
      const { props, name } = await accountBinding(x);
      unwrap(await hooks().run(name, props, [["getProfile"]]));
      await hooks().putStorage(name, props, "observed:owner", recorded);
      expect(failure(await hooks().addObserver(name, props, "bob", await seedAccount(x, BOB))))
        .toMatch(/isn't connected as the X account this workspace read private data from/);
      expect(failure(await hooks().addObserver(name, props, "gone", await disconnected(x))))
        .toMatch(/X connection has expired/);
      unwrap(await hooks().addObserver(name, props, "alice-elsewhere", await seedAccount(x, ALICE)));
    });
});

describe("getHistoricalSubresources", () => {
  it.each([["observed", "observed"], ["pending", "pending"], ["legacy true", true]] as const)(
    "exports a private read recorded before reads reported subresources (%s) as the pinned X user",
    async (_label, recorded) => {
      const x = new FakeX().install();
      const { props, name } = await accountBinding(x);
      unwrap(await hooks().run(name, props, [["getProfile"]]));
      await hooks().putStorage(name, props, "observed:owner", recorded);
      const exported = unwrap(await hooks().historicalSubresources(name, props));
      expect(exported).toEqual([ALICE_USER]);
      // Every exported ID is one verifyObserverAccess() checks.
      expect(unwrap(await hooks().verifyObserverAccess(name, props, [
        { id: "alice-elsewhere", userObjectId: await seedAccount(x, ALICE) },
        { id: "bob", userObjectId: await seedAccount(x, BOB) },
      ], exported))).toEqual({ allowedObserverIds: ["alice-elsewhere"] });
    });

  it("exports nothing for a binding that recorded no private read, whatever it reads now", async () => {
    const x = new FakeX().install();
    x.lists.set("5", { id: "5", name: "Mine", private: true, owner_id: ALICE.id, member_count: 0 });
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "list", listId: "5" };
    const name = crypto.randomUUID();
    expect(unwrap(await hooks().historicalSubresources(name, props))).toEqual([]);
    unwrap(await hooks().run(name, props, [["getInfo"]]));
    expect(unwrap(await hooks().historicalSubresources(name, props))).toEqual([]);
  });

  it("refuses to export a recorded private read with no X user to name", async () => {
    const x = new FakeX().install();
    const { props, name } = await accountBinding(x);
    await hooks().putStorage(name, props, "observed:owner", "observed");
    expect(failure(await hooks().historicalSubresources(name, props))).toMatch(/has not read anything as its X account/);
  });
});
