// What each kind of binding is: which URL makes which binding, how it describes itself, what its
// session can do, and how a Profile binding stays on the user it was made for.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { XPostInfo, XUserInfo } from "../../src/types";
import { ACCOUNT_URL, BASE_SCOPES, RESOURCES } from "../../src/x-env";
import { ALICE, BOB, CAROL, FakeX, failure, hooks, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGatekeeperClassFor", () => {
  it("makes each kind of link its own binding", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    const resourceFor = async (url: string) =>
      (unwrap(await hooks().user(id, "getGatekeeperClassFor", url)) as { resource: { urlPattern: string } }).resource.urlPattern;
    expect(await resourceFor("https://x.com/bob/status/20")).toBe(RESOURCES.post.urlPattern);
    expect(await resourceFor("https://twitter.com/i/lists/5")).toBe(RESOURCES.list.urlPattern);
    expect(await resourceFor("https://x.com/bob/media")).toBe(RESOURCES.profile.urlPattern);
    // The connected user's own profile is a Profile binding, the narrower reading.
    expect(await resourceFor("https://x.com/alice")).toBe(RESOURCES.profile.urlPattern);
    expect(await resourceFor(ACCOUNT_URL)).toBe(RESOURCES.account.urlPattern);
  });

  it("binds the account URL to whichever account resolves it, as a blueprint does", async () => {
    const x = new FakeX().install();
    const other = await seedAccount(x, BOB);
    const resolved = unwrap(await hooks().user(other, "getGatekeeperClassFor", ACCOUNT_URL)) as { resource: { urlPattern: string } };
    expect(resolved.resource.urlPattern).toBe(RESOURCES.account.urlPattern);
  });

  it("refuses links it cannot bind, rather than widening to the account", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    for (const url of ["https://x.com/home", "https://example.com/bob/status/20", "https://x.com/bob/likes"]) {
      expect(failure(await hooks().user(id, "getGatekeeperClassFor", url))).toMatch(/Not an X link this gatekeeper can bind/);
    }
  });
});

describe("ensureResources", () => {
  it("asks for more only when the grant lacks a resource type's scopes", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { scopes: [...BASE_SCOPES] });
    expect(unwrap(await hooks().user(id, "ensureResources", [RESOURCES.profile.urlPattern]))).toEqual({});
    const widened = unwrap(await hooks().user(id, "ensureResources", [RESOURCES.list.urlPattern])) as { url?: string };
    expect(widened.url).toMatch(new RegExp(`^http://localhost:8787/gatekeeper/x/${id}/[0-9a-f]+$`));
  });
});

describe("describe", () => {
  it("names the account by handle, with no read", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const description = unwrap(await hooks().describe(crypto.randomUUID(), { userObjectId, resourceKind: "account" }));
    expect(description).toEqual({
      url: ACCOUNT_URL, title: "@alice", snippet: "Alice", suggestedBindingName: "X", tsType: "XAccountSession",
    });
    expect(x.requests).toHaveLength(0);
  });

  it.each(["post", "list"] as const)("describes a %s without disclosing protected or cached content", async resourceKind => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const bob = await seedAccount(x, BOB);
    x.following.add(`${ALICE.id}:${CAROL.id}`);
    const post = x.post(CAROL, "followers only");
    x.lists.set("5", { id: "5", name: "Secret List", private: true, owner_id: ALICE.id, member_count: 1 });
    const name = crypto.randomUUID();
    const props: GatekeeperProps = resourceKind === "post"
      ? { userObjectId, resourceKind, postId: post.id }
      : { userObjectId, resourceKind, listId: "5" };
    const expected = resourceKind === "post" ? {
      url: `https://x.com/i/web/status/${post.id}`, title: `X post ${post.id}`,
      suggestedBindingName: "X_POST", tsType: "XPost", snippet: "",
    } : {
      url: "https://x.com/i/lists/5", title: "X List 5", suggestedBindingName: "X_LIST", tsType: "XList", snippet: "",
    };
    expect(unwrap(await hooks().describe(name, props))).toEqual(expected);
    // Earlier deployments kept data here without reporting an observation. Upgrading must not
    // expose it to a collaborator newly admitted without the old Post/List visibility probe.
    await hooks().putStorage(name, props, "description", {
      ...expected, title: "Private title", snippet: "Private text", url: "https://x.com/carol/status/1",
    });
    await hooks().restart(name);
    unwrap(await hooks().addObserver(name, props, "bob", bob));
    expect(unwrap(await hooks().describe(name, props))).toEqual(expected);
    await hooks().restart(name);
    expect(unwrap(await hooks().describe(name, props))).toEqual(expected);
    expect(x.requests).toHaveLength(0);
    expect((await hooks().queueLog(name)).observations).toEqual([]);
    expect(unwrap(await hooks().historicalSubresources(name, props))).toEqual([]);

    // The actual data still crosses the observation boundary with the unchanged private ID.
    unwrap(await hooks().run(name, props, [["getInfo"]]));
    expect((await hooks().queueLog(name)).observations.at(-1)?.subresources).toEqual([`user/${ALICE.id}`]);
    expect(unwrap(await hooks().verifyObserverAccess(name, props, [{ id: "bob", userObjectId: bob }], [`user/${ALICE.id}`])))
      .toEqual({ allowedObserverIds: [] });
  });

  it("describes a profile using public profile fields", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    expect(unwrap(await hooks().describe(crypto.randomUUID(), { userObjectId, resourceKind: "profile", username: "alice" })))
      .toMatchObject({ title: "@alice", snippet: "Alice · 10 followers", url: "https://x.com/alice", tsType: "XProfile" });
  });

  it("describes an inaccessible post without reading it, but refuses to return its content", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const hidden = x.post(CAROL, "followers only");
    const name = crypto.randomUUID();
    const props: GatekeeperProps = { userObjectId, resourceKind: "post", postId: hidden.id };
    expect(unwrap(await hooks().describe(name, props))).toMatchObject({ title: `X post ${hidden.id}` });
    expect(x.requests).toHaveLength(0);
    expect(failure(await hooks().run(name, props, [["getInfo"]]))).toMatch(/no post with that ID/);
  });
});

describe("auto-approvable actions", () => {
  it("lists only what each binding can submit", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const tags = async (props: GatekeeperProps) =>
      (unwrap(await hooks().autoApprovable(crypto.randomUUID(), props)) as { tag: string }[]).map(kind => kind.tag).toSorted();
    expect(await tags({ userObjectId, resourceKind: "account" })).toEqual(["x.post.bookmark", "x.post.hide", "x.user.mute"]);
    expect(await tags({ userObjectId, resourceKind: "post", postId: "1" })).toEqual(["x.post.bookmark", "x.post.hide"]);
    expect(await tags({ userObjectId, resourceKind: "list", listId: "1" })).toEqual([]);
    expect(await tags({ userObjectId, resourceKind: "profile", username: "bob" })).toEqual([]);
  });
});

describe("a Profile binding", () => {
  it("reads without a relationship, and can't act", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const props: GatekeeperProps = { userObjectId, resourceKind: "profile", username: "bob" };
    const name = crypto.randomUUID();
    const info = unwrap(await hooks().run(name, props, [["getInfo"]])) as XUserInfo;
    expect(info).toMatchObject({ id: BOB.id, username: "bob" });
    expect(info.relationship).toBeUndefined();
    expect(failure(await hooks().run(name, props, [["follow"]]))).toBeTruthy();
    expect((await hooks().queueLog(name)).submitted).toHaveLength(0);
  });

  it("stays on the user it was made for, though they are renamed and another takes the handle", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const props: GatekeeperProps = { userObjectId, resourceKind: "profile", username: "bob" };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["getInfo"]]));
    x.users.set(BOB.id, { ...BOB, username: "robert" });
    x.users.set("1009", { id: "1009", username: "bob", name: "Impostor" });
    const info = unwrap(await hooks().run(name, props, [["getInfo"]])) as XUserInfo;
    expect(info).toMatchObject({ id: BOB.id, username: "robert" });
    x.post(x.users.get(BOB.id)!, "still me");
    const [posts] = unwrap(await hooks().run(name, props, [["listPosts"]], { pages: 1 })) as XPostInfo[][];
    expect(posts.map(post => post.author.id)).toEqual([BOB.id]);
  });
});

describe("a Post binding", () => {
  it("reaches the bound post's conversation and nothing else", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const root = x.post(BOB, "root");
    const reply = x.post(ALICE, "reply", {
      conversation_id: root.id, referenced_tweets: [{ type: "replied_to", id: root.id }], in_reply_to_user_id: BOB.id,
    });
    const elsewhere = x.post(BOB, "elsewhere");
    const props: GatekeeperProps = { userObjectId, resourceKind: "post", postId: root.id };
    const name = crypto.randomUUID();
    expect(unwrap(await hooks().run(name, props, [["getInfo"]]))).toMatchObject({ id: root.id, text: "root" });
    expect(unwrap(await hooks().run(name, props, [["getConversationPost", reply.id], ["getInfo"]])))
      .toMatchObject({ id: reply.id, replyTo: { postId: root.id } });
    expect(failure(await hooks().run(name, props, [["getConversationPost", elsewhere.id], ["getInfo"]])))
      .toMatch(/isn't part of the conversation/);
    const [replies] = unwrap(await hooks().run(name, props, [["listReplies"]], { pages: 1 })) as XPostInfo[][];
    expect(replies.map(post => post.id)).toEqual([reply.id]);
  });
});
