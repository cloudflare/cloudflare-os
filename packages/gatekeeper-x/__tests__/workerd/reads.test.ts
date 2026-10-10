// Reads through the gatekeeper Durable Object, as a gadget makes them: one X request per page, the
// connection's daily read limit, the cache, simulation of pending actions, and which reads are
// private to the account (plans/x-gatekeeper.md §7).

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { XListInfo, XPostInfo, XUserInfo } from "../../src/types";
import { ALICE, BOB, CAROL, FakeX, accountStub, failure, hooks, json, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(x = new FakeX().install()) {
  const userObjectId = await seedAccount(x);
  const props: GatekeeperProps = { userObjectId, resourceKind: "account" };
  return { x, userObjectId, props, name: crypto.randomUUID() };
}

async function readsUsed(userObjectId: string): Promise<number | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<{ used: number }>("reads")?.used);
}

async function setReadsUsed(userObjectId: string, used: number, day = new Date().toISOString().slice(0, 10)) {
  await runInDurableObject(accountStub(userObjectId), async (_instance, state) => {
    state.storage.kv.put("reads", { day, used });
  });
}

describe("account reads", () => {
  it("reads the connected profile, authorizing it as a public read", async () => {
    const { props, name } = await setup();
    const profile = unwrap(await hooks().run(name, props, [["getProfile"]])) as XUserInfo;
    expect(profile).toMatchObject({ id: ALICE.id, username: "alice", followersCount: 10 });
    expect(profile.relationship).toBeUndefined();
    const { observations } = await hooks().queueLog(name);
    expect(observations).toEqual([{ title: "Read the connected X profile", description: "Read @alice's profile." }]);
  });

  it("walks a listing one X request per page", async () => {
    const { x, props, name } = await setup();
    for (let i = 0; i < 7; i++) x.post(BOB, `hey @alice ${i}`);
    const pages = unwrap(await hooks().run(name, props, [["listMentions", { pageSize: 5 }]], { pages: 5 })) as XPostInfo[][];
    expect(pages.map(page => page.length)).toEqual([5, 2]);
    const mentions = x.requests.filter(r => r.url.pathname.endsWith("/mentions"));
    expect(mentions).toHaveLength(2);
    expect(mentions[1].url.searchParams.get("pagination_token")).toBe("5");
    // One observation per page, each authorized before it was returned.
    expect((await hooks().queueLog(name)).observations.map(o => o.description))
      .toEqual(["Read 5 posts mentioning the connected account.", "Read 2 posts mentioning the connected account."]);
  });

  it("continues a search with next_token, at X's minimum page of 10", async () => {
    const { x, props, name } = await setup();
    for (let i = 0; i < 12; i++) x.post(BOB, `cats ${i}`);
    const pages = unwrap(await hooks().run(name, props, [["searchPosts", "cats", { pageSize: 5 }]], { pages: 2 })) as XPostInfo[][];
    expect(pages.map(page => page.length)).toEqual([10, 2]);
    const searches = x.requests.filter(r => r.url.pathname === "/2/tweets/search/recent");
    expect(searches.map(r => r.url.searchParams.get("max_results"))).toEqual(["10", "10"]);
    expect(searches[1].url.searchParams.get("next_token")).toBe("10");
  });

  it("refuses a page the approval queue refuses, and offers it again without re-reading X", async () => {
    const { x, props, name } = await setup();
    x.post(BOB, "hey @alice");
    await hooks().refuseObservations(name, true);
    expect(failure(await hooks().run(name, props, [["listMentions"]], { pages: 1 }))).toMatch(/refused this observation/);
    await hooks().refuseObservations(name, false);
  });

  it("serves a post from the cache within its TTL", async () => {
    const { x, props, name } = await setup();
    const post = x.post(BOB, "cached");
    unwrap(await hooks().run(name, props, [["getPost", post.id], ["getInfo"]]));
    unwrap(await hooks().run(name, props, [["getPost", `https://x.com/bob/status/${post.id}`], ["getInfo"]]));
    expect(x.count("GET", new RegExp(`^/2/tweets/${post.id}\\b`))).toBe(1);
  });

  it("reports X's rate limit without retrying", async () => {
    const { x, props, name } = await setup();
    x.on("GET", /\/mentions/, () => json({ title: "Too Many Requests" },
      { status: 429, headers: { "x-rate-limit-reset": String(Date.UTC(2026, 9, 10, 15, 0) / 1000) } }));
    expect(failure(await hooks().run(name, props, [["listMentions"]], { pages: 1 })))
      .toBe("X's rate limit for this request is used up for this account. It resets at 15:00 UTC.");
    expect(x.count("GET", /\/mentions/)).toBe(1);
  });
});

describe("the daily read limit", () => {
  it("counts what X returned, not what was asked for", async () => {
    const { x, userObjectId, props, name } = await setup();
    x.post(BOB, "hey @alice");
    unwrap(await hooks().run(name, props, [["listMentions", { pageSize: 20 }]], { pages: 1 }));
    // One post and its author.
    expect(await readsUsed(userObjectId)).toBe(2);
  });

  it("refuses reads past the deployment's limit, naming when it resets", async () => {
    const { userObjectId, props, name } = await setup();
    await setReadsUsed(userObjectId, 50);
    expect(failure(await hooks().run(name, props, [["getProfile"]])))
      .toBe("This X connection has used today's 50 reads; the limit resets at 00:00 UTC.");
  });

  it("is one budget for every binding of a connection", async () => {
    const { x, userObjectId, props } = await setup();
    await setReadsUsed(userObjectId, 49);
    const post = x.post(BOB, "one more");
    unwrap(await hooks().run(crypto.randomUUID(), props, [["getPost", post.id], ["getInfo"]]));
    const other: GatekeeperProps = { userObjectId, resourceKind: "post", postId: post.id };
    expect(failure(await hooks().run(crypto.randomUUID(), other, [["listReplies"]], { pages: 1 }))).toMatch(/used today's 50 reads/);
  });

  it("settles a read begun before midnight against that day, not the next", async () => {
    const { userObjectId } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T23:59:59Z"));
    const late = unwrap(await hooks().account(userObjectId, "reserveReads", 20)) as { day: string };
    vi.setSystemTime(new Date("2026-10-11T00:00:01Z"));
    const early = unwrap(await hooks().account(userObjectId, "reserveReads", 20)) as { day: string };
    unwrap(await hooks().account(userObjectId, "settleReads", 20, 20, early.day));
    // The read from before midnight returned nothing, which changes nothing about the new day.
    unwrap(await hooks().account(userObjectId, "settleReads", 20, 0, late.day));
    expect(await readsUsed(userObjectId)).toBe(20);
  });

  it("resets at UTC midnight", async () => {
    const { userObjectId, props, name } = await setup();
    await setReadsUsed(userObjectId, 50, "2000-01-01");
    unwrap(await hooks().run(name, props, [["getProfile"]]));
    expect(await readsUsed(userObjectId)).toBe(1);
  });
});

describe("what a read discloses", () => {
  /** A binding with an observer connected as `observer`'s X account. */
  async function observed(observer = BOB) {
    const context = await setup();
    const observerAccount = await seedAccount(context.x, observer);
    unwrap(await hooks().addObserver(context.name, context.props, "observer", observerAccount));
    return context;
  }

  async function exclusions(name: string): Promise<(string[] | undefined)[]> {
    return (await hooks().queueLog(name)).observations.map(o => o.excludeObservers);
  }

  it("shares public reads with any observer", async () => {
    const { x, props, name } = await observed();
    x.post(BOB, "hey @alice");
    unwrap(await hooks().run(name, props, [["getProfile"]]));
    unwrap(await hooks().run(name, props, [["listMentions"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([undefined, undefined]);
  });

  it("withholds the account's private reads from another X user", async () => {
    const { x, props, name } = await observed();
    const post = x.post(BOB, "saved");
    x.bookmarks.add(`${ALICE.id}:${post.id}`);
    x.likes.add(`${ALICE.id}:${post.id}`);
    unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 }));
    unwrap(await hooks().run(name, props, [["listLikedPosts"]], { pages: 1 }));
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["isMuted"]]));
    expect(await exclusions(name)).toEqual([["observer"], ["observer"], ["observer"]]);
  });

  it("withholds a page that discloses a protected account's post", async () => {
    const { x, props, name } = await observed();
    x.following.add(`${ALICE.id}:${CAROL.id}`);
    x.post(CAROL, "for followers only, @alice");
    unwrap(await hooks().run(name, props, [["listMentions"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([["observer"]]);
  });

  it("withholds posts whose authors X didn't say were public", async () => {
    const { x, props, name } = await observed();
    // A 200 that failed to hydrate the author expansion, as X may answer.
    const post = x.post(CAROL, "for followers only, @alice");
    const unhydrated = { data: [post], errors: [{ title: "Partial Error", resource_id: CAROL.id }], meta: { result_count: 1 } };
    x.on("GET", /\/mentions/, () => json(unhydrated));
    x.on("GET", new RegExp(`^/2/tweets/${post.id}\\b`), () => json({ ...unhydrated, data: post }));
    const [page] = unwrap(await hooks().run(name, props, [["listMentions"]], { pages: 1 })) as XPostInfo[][];
    expect(page[0].author.protected).toBe(false);
    unwrap(await hooks().run(name, props, [["getPost", post.id], ["getInfo"]]));
    expect(await exclusions(name)).toEqual([["observer"], ["observer"]]);
  });

  it("withholds a pending repost of a post whose author X didn't describe", async () => {
    const { x, props, name } = await observed();
    const post = x.post(CAROL, "for followers only");
    x.on("GET", new RegExp(`^/2/tweets/${post.id}\\b`), () => json({ data: post }));
    unwrap(await hooks().run(name, props, [["getPost", post.id], ["repost"]]));
    unwrap(await hooks().run(name, props, [["listMyPosts"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([["observer"]]);
  });

  it("withholds a protected account's relationships, as it does its follow lists", async () => {
    const x = new FakeX().install();
    const props: GatekeeperProps = {
      userObjectId: await seedAccount(x, ALICE, { identity: { protected: true } }), resourceKind: "account",
    };
    const name = crypto.randomUUID();
    unwrap(await hooks().addObserver(name, props, "observer", await seedAccount(x, BOB)));
    x.following.add(`${ALICE.id}:${BOB.id}`);
    const bob = unwrap(await hooks().run(name, props, [["getUser", "bob"], ["getInfo"]])) as XUserInfo;
    expect(bob.relationship).toEqual({ following: true, followedBy: false });
    // Its own profile carries no relationship, so it stays public.
    unwrap(await hooks().run(name, props, [["getUser", "alice"], ["getInfo"]]));
    expect(await exclusions(name)).toEqual([["observer"], undefined]);
  });

  it("decides a List's privacy afresh for each page", async () => {
    const { x, props, name } = await observed();
    vi.useFakeTimers({ toFake: ["Date"] });
    x.lists.set("77", { id: "77", name: "Open", private: false, owner_id: ALICE.id, member_count: 2 });
    x.listMembers.set("77", new Set([BOB.id, CAROL.id]));
    let pages = 0;
    x.on("GET", /^\/2\/lists\/77\/members/, () => {
      // Made private while the cursor is open, and the List as cached gone stale.
      if (++pages === 2) {
        x.lists.get("77")!.private = true;
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      }
      return undefined;
    });
    unwrap(await hooks().run(name, props, [["getList", "77"], ["listMembers", { pageSize: 1 }]], { pages: 2 }));
    expect(await exclusions(name)).toEqual([undefined, ["observer"]]);
  });

  it("shares private reads with an observer connected as the same X user", async () => {
    const { x, props, name } = await observed(ALICE);
    x.bookmarks.add(`${ALICE.id}:${x.post(BOB, "saved").id}`);
    unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([undefined]);
  });

  it("withholds a private List's details", async () => {
    const { x, props, name } = await observed();
    x.lists.set("77", { id: "77", name: "Secret", private: true, owner_id: ALICE.id, member_count: 0 });
    const list = unwrap(await hooks().run(name, props, [["getList", "77"], ["getInfo"]])) as XListInfo;
    expect(list).toMatchObject({ name: "Secret", private: true });
    expect(await exclusions(name)).toEqual([["observer"]]);
  });

  it("withholds a List whose privacy X didn't report", async () => {
    const { x, props, name } = await observed();
    // A 200 that failed to hydrate the List's `private` field.
    x.lists.set("78", { id: "78", name: "Unclear", owner_id: ALICE.id, member_count: 0 });
    expect(unwrap(await hooks().run(name, props, [["getList", "78"], ["getInfo"]]))).toMatchObject({ private: true });
    unwrap(await hooks().run(name, props, [["listOwnedLists"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([["observer"], ["observer"]]);
  });

  it("keeps withholding a private List while a change making it public waits", async () => {
    const { x, props, name } = await observed();
    x.lists.set("77", { id: "77", name: "Secret", private: true, owner_id: ALICE.id, member_count: 1 });
    x.listMembers.set("77", new Set([BOB.id]));
    x.post(BOB, "listed");
    unwrap(await hooks().run(name, props, [["getList", "77"], ["update", { private: false }]]));
    const list = unwrap(await hooks().run(name, props, [["getList", "77"], ["getInfo"]])) as XListInfo;
    // The gadget sees its change, but X has not made the List public yet.
    expect(list.private).toBe(false);
    unwrap(await hooks().run(name, props, [["getList", "77"], ["listMembers"]], { pages: 1 }));
    unwrap(await hooks().run(name, props, [["getList", "77"], ["listPosts"]], { pages: 1 }));
    unwrap(await hooks().run(name, props, [["listOwnedLists"]], { pages: 1 }));
    expect(await exclusions(name)).toEqual([["observer"], ["observer"], ["observer"], ["observer"]]);
  });
});

describe("pending actions in reads", () => {
  it("shows a post waiting for approval as if it were published", async () => {
    const { x, props, name } = await setup();
    const pending = unwrap(await hooks().run(name, props, [["createPost", { text: "Draft one" }], ["getInfo"]])) as XPostInfo;
    expect(pending).toMatchObject({ id: "~1", text: "Draft one", author: { username: "alice" } });
    expect(pending.url).toBeUndefined();
    const [page] = unwrap(await hooks().run(name, props, [["listMyPosts"]], { pages: 1 })) as XPostInfo[][];
    expect(page.map(post => post.id)).toEqual(["~1"]);
    // Nothing was sent to X but reads.
    expect(x.requests.every(r => r.method === "GET")).toBe(true);
  });

  it("shows a pending bookmark and follow", async () => {
    const { x, props, name } = await setup();
    const post = x.post(BOB, "worth keeping");
    unwrap(await hooks().run(name, props, [["getPost", post.id], ["bookmark"]]));
    unwrap(await hooks().run(name, props, [["getUser", "bob"], ["follow"]]));
    const [bookmarks] = unwrap(await hooks().run(name, props, [["listBookmarks"]], { pages: 1 })) as XPostInfo[][];
    expect(bookmarks.map(item => item.id)).toEqual([post.id]);
    const bob = unwrap(await hooks().run(name, props, [["getUser", "bob"], ["getInfo"]])) as XUserInfo;
    expect(bob.relationship).toEqual({ following: true, followedBy: false });
  });

  it("hides a post waiting for approval once its deletion is waiting too", async () => {
    const { props, name } = await setup();
    unwrap(await hooks().run(name, props, [["createPost", { text: "Second thoughts" }]]));
    unwrap(await hooks().run(name, props, [["getPost", "~1"], ["delete"]]));
    expect(failure(await hooks().run(name, props, [["getPost", "~1"], ["getInfo"]]))).toBe("This post has been deleted.");
    const [page] = unwrap(await hooks().run(name, props, [["listMyPosts"]], { pages: 1 })) as XPostInfo[][];
    expect(page).toEqual([]);
  });

  it("shows a pending repost among the account's posts, unless reposts are excluded", async () => {
    const { x, props, name } = await setup();
    const post = x.post(BOB, "worth sharing");
    unwrap(await hooks().run(name, props, [["getPost", post.id], ["repost"]]));
    const [page] = unwrap(await hooks().run(name, props, [["listMyPosts"]], { pages: 1 })) as XPostInfo[][];
    expect(page).toEqual([expect.objectContaining({
      id: post.id, author: expect.objectContaining({ username: "alice" }),
      repostOf: expect.objectContaining({ id: post.id, text: "worth sharing", author: expect.objectContaining({ username: "bob" }) }),
    })]);
    const [withoutReposts] = unwrap(await hooks().run(name, props, [["listMyPosts", { excludeReposts: true }]], { pages: 1 })) as XPostInfo[][];
    expect(withoutReposts).toEqual([]);
  });

  it("authorizes the profiles of a pending List's members, which were read from X", async () => {
    const { props, name } = await setup();
    unwrap(await hooks().run(name, props, [["createList", "Friends"]]));
    unwrap(await hooks().run(name, props, [["getList", "~1"], ["addMember", "bob"]]));
    await hooks().refuseObservations(name, true);
    expect(failure(await hooks().run(name, props, [["getList", "~1"], ["listMembers"]], { pages: 1 })))
      .toMatch(/refused this observation/);
    await hooks().refuseObservations(name, false);
    const [members] = unwrap(await hooks().run(name, props, [["getList", "~1"], ["listMembers"]], { pages: 1 })) as XUserInfo[][];
    expect(members.map(member => member.username)).toEqual(["bob"]);
    expect((await hooks().queueLog(name)).observations.at(-1))
      .toEqual({ title: "Read an X List's members", description: 'Read 1 member of the List "Friends".' });
  });

  it("refuses a post X would refuse before it is queued", async () => {
    const { props, name } = await setup();
    expect(failure(await hooks().run(name, props, [["createPost", { text: "a".repeat(281) }]])))
      .toMatch(/281 characters as X counts them/);
    unwrap(await hooks().run(name, props, [["createPost", { text: "Same words" }]]));
    expect(failure(await hooks().run(name, props, [["createPost", { text: "Same  words" }]]))).toMatch(/already waiting/);
    expect((await hooks().queueLog(name)).submitted).toHaveLength(1);
  });
});
