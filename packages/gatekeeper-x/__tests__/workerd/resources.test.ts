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

  it("describes a post once, then from storage", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const post = x.post(BOB, `A long post ${"word ".repeat(40)}`);
    const name = crypto.randomUUID();
    const props: GatekeeperProps = { userObjectId, resourceKind: "post", postId: post.id };
    const description = unwrap(await hooks().describe(name, props)) as { title: string; snippet: string; url: string };
    expect(description).toMatchObject({
      url: `https://x.com/bob/status/${post.id}`, title: "Post by @bob", suggestedBindingName: "X_POST", tsType: "XPost",
    });
    expect([...description.snippet]).toHaveLength(100);
    await hooks().restart(name);
    unwrap(await hooks().describe(name, props));
    expect(x.count("GET", /^\/2\/tweets\//)).toBe(1);
  });

  it("describes a List and a profile", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    x.lists.set("5", { id: "5", name: "Friends", owner_id: BOB.id, member_count: 1 });
    expect(unwrap(await hooks().describe(crypto.randomUUID(), { userObjectId, resourceKind: "list", listId: "5" })))
      .toMatchObject({ title: "Friends", snippet: "List by @bob · 1 member", url: "https://x.com/i/lists/5", tsType: "XList" });
    expect(unwrap(await hooks().describe(crypto.randomUUID(), { userObjectId, resourceKind: "profile", username: "alice" })))
      .toMatchObject({ title: "@alice", snippet: "Alice · 10 followers", url: "https://x.com/alice", tsType: "XProfile" });
  });

  it("refuses to describe a post the account can't see", async () => {
    const x = new FakeX().install();
    const userObjectId = await seedAccount(x);
    const hidden = x.post(CAROL, "followers only");
    expect(failure(await hooks().describe(crypto.randomUUID(), { userObjectId, resourceKind: "post", postId: hidden.id })))
      .toMatch(/no post with that ID/);
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
