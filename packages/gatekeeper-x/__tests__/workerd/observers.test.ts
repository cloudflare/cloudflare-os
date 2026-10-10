// Who may observe a workspace that reads X (plans/x-gatekeeper.md §7). Every binding admits an
// observer with an X connection of their own; a Post or List binding also requires their account
// to see the bound post or List; and the account's private reads -- bookmarks, likes, mutes, private
// Lists, protected accounts' posts -- are for the same X user only, forwards and backwards.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE, BOB, CAROL, FakeX, accountStub, failure, hooks, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admission", () => {
  it("admits anyone with a working X connection to a public-only workspace", async () => {
    const x = new FakeX().install();
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["getProfile"]]));
    unwrap(await hooks().addObserver(name, props, "bob", await seedAccount(x, BOB)));
  });

  it("refuses an observer whose X connection is gone", async () => {
    const x = new FakeX().install();
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
    const gone = await seedAccount(x, BOB);
    await runInDurableObject(accountStub(gone), async (_instance, state) => state.storage.kv.delete("identity"));
    expect(failure(await hooks().addObserver(crypto.randomUUID(), props, "bob", gone))).toMatch(/X connection has expired/);
  });

  it("refuses another X user once the workspace has read the account's private data", async () => {
    const x = new FakeX().install();
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
    const name = crypto.randomUUID();
    x.bookmarks.add(`${ALICE.id}:${x.post(BOB, "saved").id}`);
    unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 }));
    expect(failure(await hooks().addObserver(name, props, "bob", await seedAccount(x, BOB))))
      .toMatch(/isn't connected as the X account this workspace read private data from/);
    unwrap(await hooks().addObserver(name, props, "alice-elsewhere", await seedAccount(x, ALICE)));
  });
});

describe("a Post binding", () => {
  it("admits only observers whose own account can see the post", async () => {
    const x = new FakeX().install();
    x.following.add(`${ALICE.id}:${CAROL.id}`);
    const post = x.post(CAROL, "followers only");
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "post", postId: post.id };
    const name = crypto.randomUUID();
    expect(failure(await hooks().addObserver(name, props, "bob", await seedAccount(x, BOB))))
      .toMatch(/can't see the post this workspace is bound to/);
    x.following.add(`${BOB.id}:${CAROL.id}`);
    unwrap(await hooks().addObserver(name, props, "bob", await seedAccount(x, BOB)));
  });

  it("remembers an admission for an hour, since each check is a billed read", async () => {
    const x = new FakeX().install();
    const post = x.post(BOB, "public");
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "post", postId: post.id };
    const name = crypto.randomUUID();
    const observer = await seedAccount(x, CAROL);
    unwrap(await hooks().addObserver(name, props, "carol", observer));
    unwrap(await hooks().addObserver(name, props, "carol", observer));
    expect(x.count("GET", new RegExp(`^/2/tweets/${post.id}`))).toBe(1);
    // The probe drew on the observer's budget, not the owner's.
    const used = await runInDurableObject(accountStub(observer), async (_instance, state) =>
      state.storage.kv.get<{ used: number }>("reads")?.used);
    expect(used).toBe(1);
  });

  it("needs no check for an observer connected as the binding's own X user", async () => {
    const x = new FakeX().install();
    const post = x.post(BOB, "public");
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "post", postId: post.id };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["getInfo"]]));
    const before = x.requests.length;
    unwrap(await hooks().addObserver(name, props, "alice", await seedAccount(x, ALICE)));
    expect(x.requests).toHaveLength(before);
  });
});

describe("a List binding", () => {
  it("admits only observers who can see the List", async () => {
    const x = new FakeX().install();
    x.lists.set("5", { id: "5", name: "Mine", private: true, owner_id: ALICE.id });
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "list", listId: "5" };
    expect(failure(await hooks().addObserver(crypto.randomUUID(), props, "bob", await seedAccount(x, BOB))))
      .toMatch(/can't see the List/);
  });
});
