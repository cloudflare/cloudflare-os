// Actions, from staging to apply, revert and reject: nothing reaches X before approval; a thread
// resumes where a failure stopped it; a send X never confirmed is reconciled rather than repeated;
// what builds on a pending post waits for it, and falls with it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { XListInfo, XPostInfo } from "../../src/types";
import { scopesFor } from "../../src/x-env";
import { ALICE, BOB, FakeX, failure, hooks, json, reconnectAs, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function setup(x = new FakeX().install()) {
  const userObjectId = await seedAccount(x);
  const props: GatekeeperProps = { userObjectId, resourceKind: "account" };
  const name = crypto.randomUUID();
  return {
    x, userObjectId, props, name,
    run: async (steps: Step[]) => unwrap(await hooks().run(name, props, steps)),
    attempt: async (steps: Step[]) => await hooks().run(name, props, steps),
    submitted: async (): Promise<Array<{ actionId: number; description: ActionDescription }>> =>
      (await hooks().queueLog(name)).submitted,
    apply: async (actionId: number) => await hooks().applyAction(name, props, actionId),
    reject: async (actionId: number) => await hooks().rejectAction(name, props, actionId),
    revert: async (actionId: number) => await hooks().revertAction(name, props, actionId),
  };
}

const postsBy = (x: FakeX, userId: string) => [...x.posts.values()].filter(post => post.author_id === userId);

describe("publishing", () => {
  it("sends nothing until approved, then binds the temporary ID to the post X made", async () => {
    const t = await setup();
    const pending = await t.run([["createPost", { text: "Hello, X" }], ["getInfo"]]) as XPostInfo;
    expect(pending.id).toBe("~1");
    expect(postsBy(t.x, ALICE.id)).toHaveLength(0);
    const [{ actionId, description }] = await t.submitted();
    expect(description.title).toBe("Post on X as @alice");

    unwrap(await t.apply(actionId));
    const [published] = postsBy(t.x, ALICE.id);
    expect(published.text).toBe("Hello, X");
    const info = await t.run([["getPost", "~1"], ["getInfo"]]) as XPostInfo;
    expect(info).toMatchObject({ id: published.id, url: `https://x.com/alice/status/${published.id}`, text: "Hello, X" });

    unwrap(await t.revert(actionId));
    expect(t.x.posts.has(published.id)).toBe(false);
  });

  it("uploads a thread's images only once it is approved, each post replying to the one before", async () => {
    const t = await setup();
    await t.run([["createThread", [
      { text: "One", images: [{ data: PNG, mediaType: "image/png", altText: "A chart" }] },
      { text: "Two" },
    ]]]);
    expect(t.x.count("POST", /^\/2\/media/)).toBe(0);
    const [{ actionId, description }] = await t.submitted();
    expect(description.descriptionIsComplete).toBeUndefined();

    unwrap(await t.apply(actionId));
    const [mediaId] = [...t.x.media.keys()];
    expect(t.x.media.get(mediaId)).toEqual({ type: "image/png", altText: "A chart" });
    expect(t.x.requests.find(r => r.url.pathname === "/2/media/upload")?.form?.get("media_category")).toBe("tweet_image");
    const [first, second] = postsBy(t.x, ALICE.id);
    expect(first).toMatchObject({ text: "One", attachments: { media_keys: [`3_${mediaId}`] } });
    expect(second).toMatchObject({ text: "Two", referenced_tweets: [{ type: "replied_to", id: first.id }] });
  });

  it("resumes a thread where a passing failure stopped it", async () => {
    const t = await setup();
    await t.run([["createThread", [{ text: "One" }, { text: "Two" }, { text: "Three" }]]]);
    let creates = 0;
    t.x.on("POST", /^\/2\/tweets$/, () => ++creates === 2 ? json({ title: "Too Many Requests" }, { status: 429 }) : undefined);
    const [{ actionId }] = await t.submitted();
    expect(failure(await t.apply(actionId))).toMatch(/rate limit/);
    expect(postsBy(t.x, ALICE.id).map(post => post.text)).toEqual(["One"]);

    unwrap(await t.apply(actionId));
    const [one, two, three] = postsBy(t.x, ALICE.id);
    expect([one.text, two.text, three.text]).toEqual(["One", "Two", "Three"]);
    expect(two.referenced_tweets).toEqual([{ type: "replied_to", id: one.id }]);
    expect(three.referenced_tweets).toEqual([{ type: "replied_to", id: two.id }]);
  });

  it("binds a post X made though its answer was lost, rather than posting it twice", async () => {
    const t = await setup();
    await t.run([["createPost", { text: "Only once" }]]);
    let lost = false;
    t.x.on("POST", /^\/2\/tweets$/, request => {
      if (lost) return undefined;
      lost = true;
      t.x.post(ALICE, JSON.parse(request.body!).text);
      throw new TypeError("connection reset");
    });
    const [{ actionId }] = await t.submitted();
    unwrap(await t.apply(actionId));
    const posts = postsBy(t.x, ALICE.id);
    expect(posts).toHaveLength(1);
    expect(await t.run([["getPost", "~1"], ["getInfo"]])).toMatchObject({ id: posts[0].id });
  });

  it("won't let a post X may have made be rejected, and posts it on the next approval if it didn't", async () => {
    const t = await setup();
    await t.run([["createPost", { text: "Maybe" }]]);
    let failed = false;
    t.x.on("POST", /^\/2\/tweets$/, () => {
      if (failed) return undefined;
      failed = true;
      return new Response("upstream error", { status: 503 });
    });
    const [{ actionId }] = await t.submitted();
    expect(failure(await t.apply(actionId))).toMatch(/did not confirm whether this post was published/);
    expect(failure(await t.reject(actionId))).toMatch(/never confirmed whether this post was published/);
    unwrap(await t.apply(actionId));
    expect(postsBy(t.x, ALICE.id).map(post => post.text)).toEqual(["Maybe"]);
  });

  it("replies through a Post binding, confined to that conversation", async () => {
    const x = new FakeX().install();
    const root = x.post(BOB, "What do you think?");
    const t = await setup(x);
    const props: GatekeeperProps = { userObjectId: t.userObjectId, resourceKind: "post", postId: root.id };
    const name = crypto.randomUUID();
    const reply = unwrap(await hooks().run(name, props, [["reply", { text: "Agreed" }], ["getInfo"]])) as XPostInfo;
    expect(reply).toMatchObject({ id: "~1", conversationId: root.id, replyTo: { postId: root.id, userId: BOB.id } });
    const [{ actionId, description }] = (await hooks().queueLog(name)).submitted;
    expect(description.title).toBe("Reply on X to @bob as @alice");
    unwrap(await hooks().applyAction(name, props, actionId));
    const [posted] = postsBy(x, ALICE.id);
    expect(posted).toMatchObject({ text: "Agreed", conversation_id: root.id, referenced_tweets: [{ type: "replied_to", id: root.id }] });
  });

  it("deletes only the account's own posts", async () => {
    const t = await setup();
    const theirs = t.x.post(BOB, "not yours");
    expect(failure(await t.attempt([["getPost", theirs.id], ["delete"]]))).toMatch(/Only the connected account's own posts/);
    const mine = t.x.post(ALICE, "mine");
    await t.run([["getPost", mine.id], ["delete"]]);
    expect(failure(await t.attempt([["getPost", mine.id], ["getInfo"]]))).toMatch(/has been deleted/);
    const [{ actionId, description }] = await t.submitted();
    expect(description.implementsRevert).toBe(false);
    unwrap(await t.apply(actionId));
    expect(t.x.posts.has(mine.id)).toBe(false);
    expect(unwrap(await t.revert(actionId))).toEqual({ message: "A deleted post can't be restored.", canRetry: false });
  });
});

describe("actions on a pending post", () => {
  it("wait for the post, and fall with it when it is rejected", async () => {
    const t = await setup();
    await t.run([["createPost", { text: "Soon" }]]);
    await t.run([["getPost", "~1"], ["like"]]);
    const [create, like] = await t.submitted();
    expect(failure(await t.apply(like.actionId))).toMatch(/depends on ~1, which is not applied yet/);

    expect(unwrap(await t.reject(create.actionId))).toEqual({ restart: true });
    expect(failure(await t.apply(like.actionId))).toMatch(/needed action 1, which did not complete/);
    expect(t.x.likes.size).toBe(0);
  });

  it("apply once the post exists, against the ID X gave it", async () => {
    const t = await setup();
    await t.run([["createPost", { text: "Soon" }]]);
    await t.run([["getPost", "~1"], ["bookmark"]]);
    const [create, bookmark] = await t.submitted();
    unwrap(await t.apply(create.actionId));
    unwrap(await t.apply(bookmark.actionId));
    const [post] = postsBy(t.x, ALICE.id);
    expect([...t.x.bookmarks]).toEqual([`${ALICE.id}:${post.id}`]);
  });

  it("is rejected without a restart when nothing builds on it", async () => {
    const t = await setup();
    await t.run([["createPost", { text: "Never mind" }]]);
    const [create] = await t.submitted();
    expect(unwrap(await t.reject(create.actionId))).toBeUndefined();
    expect(failure(await t.attempt([["getPost", "~1"], ["getInfo"]]))).toMatch(/may have been rejected/);
  });
});

describe("engagement", () => {
  it("likes, follows and mutes, and undoes each", async () => {
    const t = await setup();
    const post = t.x.post(BOB, "nice");
    await t.run([["getPost", post.id], ["like"]]);
    await t.run([["getUser", "@bob"], ["follow"]]);
    await t.run([["getUser", "bob"], ["mute"]]);
    const [like, follow, mute] = await t.submitted();
    expect(mute.description.autoApprovable).toBe(true);
    expect(like.description.autoApprovable).toBe(false);
    for (const { actionId } of [like, follow, mute]) unwrap(await t.apply(actionId));
    expect([...t.x.likes, ...t.x.following, ...t.x.muting])
      .toEqual([`${ALICE.id}:${post.id}`, `${ALICE.id}:${BOB.id}`, `${ALICE.id}:${BOB.id}`]);
    for (const { actionId } of [like, follow, mute]) unwrap(await t.revert(actionId));
    expect(t.x.likes.size + t.x.following.size + t.x.muting.size).toBe(0);
  });

  it("refuses to act on the connected account itself", async () => {
    const t = await setup();
    expect(failure(await t.attempt([["getUser", "alice"], ["follow"]]))).toMatch(/connected account itself/);
  });

  it("fails for good when X refuses, without asking X again", async () => {
    const t = await setup();
    const post = t.x.post(BOB, "soon gone");
    await t.run([["getPost", post.id], ["like"]]);
    t.x.posts.delete(post.id);
    const [{ actionId }] = await t.submitted();
    const message = failure(await t.apply(actionId));
    expect(message).toMatch(/X refused to like this post/);
    const requests = t.x.requests.length;
    expect(failure(await t.apply(actionId))).toBe(message);
    expect(t.x.requests).toHaveLength(requests);
  });

  it("survives a reconnect as the same X user, being fenced to the user rather than the connection", async () => {
    const t = await setup();
    const post = t.x.post(BOB, "keep");
    await t.run([["getPost", post.id], ["like"]]);
    await hooks().installCallback(t.userObjectId, generateNonce(), scopesFor());
    const reconnected = await reconnectAs(t.x, t.userObjectId, ALICE) as { handoff: { ticket: string } };
    unwrap(await hooks().account(t.userObjectId, "commitReconnect", reconnected.handoff.ticket));
    const [{ actionId }] = await t.submitted();
    unwrap(await t.apply(actionId));
    expect(t.x.likes.has(`${ALICE.id}:${post.id}`)).toBe(true);
  });
});

describe("Lists", () => {
  it("creates a List, adds to it before it exists, and deletes it on revert", async () => {
    const t = await setup();
    const created = await t.run([["createList", "Friends", { private: true }], ["getInfo"]]) as XListInfo;
    expect(created).toMatchObject({ id: "~1", name: "Friends", private: true, owner: { username: "alice" } });
    await t.run([["getList", "~1"], ["addMember", "@bob"]]);
    const [create, add] = await t.submitted();
    unwrap(await t.apply(create.actionId));
    unwrap(await t.apply(add.actionId));
    const [list] = [...t.x.lists.values()];
    expect(list).toMatchObject({ name: "Friends", private: true, owner_id: ALICE.id });
    expect([...t.x.listMembers.get(list.id)!]).toEqual([BOB.id]);
    unwrap(await t.revert(create.actionId));
    expect(t.x.lists.size).toBe(0);
  });

  it("restores a List's details on revert", async () => {
    const t = await setup();
    t.x.lists.set("5", { id: "5", name: "Old", description: "before", private: false, owner_id: ALICE.id });
    await t.run([["getList", "5"], ["update", { name: "New" }]]);
    expect(await t.run([["getList", "5"], ["getInfo"]])).toMatchObject({ name: "New", description: "before" });
    const [{ actionId }] = await t.submitted();
    unwrap(await t.apply(actionId));
    expect(t.x.lists.get("5")).toMatchObject({ name: "New" });
    unwrap(await t.revert(actionId));
    expect(t.x.lists.get("5")).toMatchObject({ name: "Old", description: "before", private: false });
  });

  it("changes only Lists the account owns", async () => {
    const t = await setup();
    t.x.lists.set("6", { id: "6", name: "Bob's", owner_id: BOB.id });
    expect(failure(await t.attempt([["getList", "6"], ["update", { name: "Mine now" }]]))).toMatch(/Only Lists the connected account owns/);
  });
});
