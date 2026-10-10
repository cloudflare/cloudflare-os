import { describe, expect, it } from "vitest";
import type { XListInfo, XPostInfo, XUserInfo } from "../src/types";
import type { XAction } from "../src/x-actions";
import type { StoredIdentity } from "../src/x-credentials";
import {
  overlayFollowing, overlayList, overlayMuted, overlayOwnedLists, overlayPost, overlayPosts, overlayUser,
  pendingList, pendingPosts, pendingTexts, type Pending,
} from "../src/x-simulation";

const me: StoredIdentity = { id: "1", username: "alice", name: "Alice", protected: false, verified: false, fetchedAt: 0 };

function post(id: string, extra: Partial<XPostInfo> = {}): XPostInfo {
  return {
    id, url: `https://x.com/bob/status/${id}`, text: `post ${id}`,
    author: { id: "2", username: "bob", name: "Bob", verified: false, protected: false },
    createdAt: new Date(0), conversationId: id, mentions: [], hashtags: [], links: [], media: [],
    metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, impressions: 0 },
    replySettings: "everyone", possiblySensitive: false, ...extra,
  };
}

function user(id: string, extra: Partial<XUserInfo> = {}): XUserInfo {
  return {
    id, username: `user${id}`, name: `User ${id}`, verified: false, protected: false, url: `https://x.com/user${id}`,
    description: "", followersCount: 0, followingCount: 0, postCount: 0, listedCount: 0,
    relationship: { following: false, followedBy: false }, ...extra,
  };
}

const list: XListInfo = {
  id: "70", url: "https://x.com/i/lists/70", name: "Friends", description: "", private: false,
  owner: { id: "1", username: "alice", name: "Alice", verified: false, protected: false }, memberCount: 0, followerCount: 0,
};

function pending(...actions: XAction[]): Pending {
  return actions.map((action, index) => ({ id: index + 1, action }));
}

const unresolved = (id: string) => id;

const thread: XAction = {
  kind: "createPost",
  payload: { refs: ["~1", "~2"], drafts: [{ text: "first" }, { text: "second https://a.co" }], submittedAt: 1000 },
};

describe("pending posts", () => {
  it("shows a pending thread newest first, each post replying to the one before", () => {
    const [second, first] = pendingPosts(pending(thread), me, unresolved);
    expect(first).toMatchObject({ id: "~1", text: "first", conversationId: "~1", author: { id: "1", username: "alice" } });
    expect(first.replyTo).toBeUndefined();
    expect(second).toMatchObject({ id: "~2", conversationId: "~1", replyTo: { postId: "~1", userId: "1" } });
    expect(second.links).toEqual([{ url: "https://a.co" }]);
  });

  it("stops showing a post once X has assigned its ID, and points at the real one", () => {
    const resolve = (id: string) => id === "~1" ? "100" : id;
    const shown = pendingPosts(pending(thread), me, resolve);
    expect(shown.map(item => item.id)).toEqual(["~2"]);
    expect(shown[0]).toMatchObject({ conversationId: "100", replyTo: { postId: "100" } });
  });

  it("joins only the newest page of the account's own posts", () => {
    const page = [post("10", { author: { ...post("10").author, id: "1" } })];
    const context = { me, resolve: unresolved };
    expect(overlayPosts(page, pending(thread), { kind: "mine" }, { ...context, newestPage: true }).map(item => item.id))
      .toEqual(["~2", "~1", "10"]);
    expect(overlayPosts(page, pending(thread), { kind: "mine" }, { ...context, newestPage: false }).map(item => item.id))
      .toEqual(["10"]);
  });

  it("joins a reply only to its parent's listing", () => {
    const reply: XAction = {
      kind: "reply",
      payload: { ref: "~3", draft: { text: "hi" }, parent: { id: "50", info: post("50") }, conversationId: "50", submittedAt: 0 },
    };
    const context = { me, resolve: unresolved, newestPage: true };
    expect(overlayPosts([], pending(reply), { kind: "replies", parentId: "50" }, context).map(item => item.id)).toEqual(["~3"]);
    expect(overlayPosts([], pending(reply), { kind: "replies", parentId: "51" }, context)).toEqual([]);
    expect(overlayPosts([], pending(reply), { kind: "conversation", conversationId: "50" }, context).map(item => item.id))
      .toEqual(["~3"]);
  });
});

describe("pending changes to existing posts", () => {
  it("drops a post a pending deletion removes, everywhere", () => {
    const deletion: XAction = { kind: "deletePost", payload: { post: { id: "10", info: post("10") } } };
    expect(overlayPosts([post("10"), post("11")], pending(deletion), { kind: "others" },
      { me, resolve: unresolved, newestPage: true }).map(item => item.id)).toEqual(["11"]);
    expect(overlayPost(post("10"), pending(deletion), unresolved)).toBeNull();
  });

  it("replays bookmark toggles, the last one winning", () => {
    const on: XAction = { kind: "bookmark", payload: { post: { id: "20", info: post("20") }, on: true } };
    const off: XAction = { kind: "bookmark", payload: { post: { id: "21", info: post("21") }, on: false } };
    const context = { me, resolve: unresolved, newestPage: true };
    expect(overlayPosts([post("21")], pending(on, off), { kind: "bookmarks" }, context).map(item => item.id)).toEqual(["20"]);
    const undone: XAction = { kind: "bookmark", payload: { post: { id: "20", info: post("20") }, on: false } };
    expect(overlayPosts([], pending(on, undone), { kind: "bookmarks" }, context)).toEqual([]);
  });

  it("drops an undone repost from the account's own posts", () => {
    const repostRow = post("30", { repostOf: { id: "40", url: "", text: "", author: post("40").author } });
    const undo: XAction = { kind: "repost", payload: { post: { id: "40", info: post("40") }, on: false } };
    expect(overlayPosts([repostRow], pending(undo), { kind: "mine" }, { me, resolve: unresolved, newestPage: false }))
      .toEqual([]);
  });
});

describe("pending changes to users", () => {
  it("replays follows onto the relationship, but not to a protected account", () => {
    const follow = (target: XUserInfo): XAction => ({ kind: "follow", payload: { user: target, on: true } });
    expect(overlayUser(user("5"), pending(follow(user("5")))).relationship?.following).toBe(true);
    const locked = user("6", { protected: true });
    expect(overlayUser(locked, pending(follow(locked))).relationship?.following).toBe(false);
    expect(overlayFollowing([], pending(follow(user("5")), follow(locked)), true).map(item => item.id)).toEqual(["5"]);
  });

  it("replays mutes, the last one winning", () => {
    const mute = (on: boolean): XAction => ({ kind: "mute", payload: { user: user("5"), on } });
    expect(overlayMuted(false, pending(mute(true)), "5")).toBe(true);
    expect(overlayMuted(true, pending(mute(true), mute(false)), "5")).toBe(false);
    expect(overlayMuted(true, pending(), "5")).toBe(true);
  });
});

describe("pending changes to Lists", () => {
  const create: XAction = {
    kind: "createList",
    payload: { ref: "~1", name: "New", private: true, owner: list.owner, submittedAt: 0 },
  };

  it("shows a pending List, with later changes replayed", () => {
    const rename: XAction = { kind: "updateList", payload: { list: { id: "~1", info: list }, changes: { name: "Renamed" } } };
    expect(pendingList("~1", pending(create, rename), unresolved)).toMatchObject({ id: "~1", name: "Renamed", private: true });
    expect(overlayOwnedLists([list], pending(create), unresolved, true).map(item => item.id)).toEqual(["~1", "70"]);
    expect(overlayOwnedLists([list], pending(create), unresolved, false).map(item => item.id)).toEqual(["70"]);
  });

  it("drops a List a pending deletion removes", () => {
    const deletion: XAction = { kind: "deleteList", payload: { list: { id: "70", info: list } } };
    expect(overlayList(list, pending(deletion), unresolved)).toBeNull();
  });
});

describe("pendingTexts", () => {
  it("collects texts as duplicates are compared", () => {
    expect([...pendingTexts(pending(thread))]).toEqual(["first", "second"]);
  });
});
