// What the approver is shown, and what is refused before it reaches them. The apply paths need X and
// a Durable Object, and are covered by the workerd suite.

import { describe, expect, it } from "vitest";
import type { ActionDescription, ActionField } from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { XPostDraft, XPostInfo, XUserInfo } from "../src/types";
import {
  actions, dependedRefs, imageHandles, providedRefs, validateDraft, type StoredDraft, type XAction, type XActionHost,
  type XActions,
} from "../src/x-actions";
import type { StoredIdentity } from "../src/x-credentials";
import { fakeKv } from "./fake-kv";

const me: StoredIdentity = {
  id: "1", username: "alice", name: "Alice", protected: false, verified: false, fetchedAt: 0,
};
const premium: StoredIdentity = { ...me, subscriptionType: "Premium" };

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const IMAGE = { handle: "0d6f0f2e-7c0b-4c1e-9b43-5f2d6d1f8a10", size: 6, digest: "a".repeat(64) };

const theirPost: XPostInfo = {
  id: "50", url: "https://x.com/bob/status/50", text: "Bob's post", author: {
    id: "2", username: "bob", name: "Bob", verified: false, protected: false,
  },
  createdAt: new Date(0), conversationId: "50", mentions: [], hashtags: [], links: [], media: [],
  metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, impressions: 0 },
  replySettings: "everyone", possiblySensitive: false,
};

const bob: XUserInfo = {
  ...theirPost.author, url: "https://x.com/bob", description: "", followersCount: 0, followingCount: 0,
  postCount: 0, listedCount: 0,
};

/** Submits through the real action set, capturing what the approver would be shown. */
async function describeAction<K extends keyof XActions>(kind: K, payload: XActions[K]): Promise<ActionDescription> {
  const journal = new ActionJournal<XAction>(fakeKv(), { namespace: "x" });
  const host = { me: async () => me } as unknown as XActionHost;
  const shown: ActionDescription[] = [];
  const queue = { submitAction: async (_id: number, description: ActionDescription) => void shown.push(description) };
  await actions.bind(journal, host).submit(queue as never, kind, payload, { fence: { generation: me.id } });
  return shown[0];
}

function field(description: ActionDescription, label: string): ActionField | undefined {
  return description.fields?.find(candidate => candidate.label === label);
}

const draft = (text: string, extra: Partial<StoredDraft> = {}): StoredDraft => ({ text, ...extra });

describe("descriptions", () => {
  it("names the acting account and shows a post's every value in fields", async () => {
    const description = await describeAction("createPost", {
      refs: ["~1"], drafts: [draft("Hi @bob, see https://example.com")], submittedAt: 0,
    });
    expect(description.title).toBe("Post on X as @alice");
    expect(description.description).toContain("as @alice");
    expect(description.description).toContain("bills posts with links");
    expect(field(description, "Post")).toEqual({ label: "Post", kind: "text", value: "Hi @bob, see https://example.com" });
    expect(field(description, "Post: mentions")).toMatchObject({ kind: "list", items: ["@bob"] });
    expect(field(description, "Post: links")).toMatchObject({ kind: "list", items: ["https://example.com"] });
    expect(description.descriptionIsComplete).toBe(true);
    expect(description.implementsRevert).toBe(true);
    expect(description.actionKind).toEqual({ tag: "x.post.create", label: "Publish X posts" });
    expect(description.autoApprovable).toBe(false);
  });

  it("can't call a post with images complete: the approver can't read the bytes", async () => {
    const description = await describeAction("createPost", {
      refs: ["~1"],
      drafts: [draft("Look", { images: [{ file: IMAGE, mediaType: "image/png", altText: "A chart" }] })],
      submittedAt: 0,
    });
    expect(field(description, "Post: image 1")).toMatchObject({
      kind: "file", name: "image-1.png", mediaType: "image/png", size: 6, sha256: IMAGE.digest, origin: "agent",
    });
    expect(field(description, "Post: image 1 alt text")).toMatchObject({ kind: "text", value: "A chart" });
    expect(description.descriptionIsComplete).toBeUndefined();
  });

  it("numbers a thread's posts", async () => {
    const description = await describeAction("createPost", {
      refs: ["~1", "~2"], drafts: [draft("one"), draft("two", { poll: { options: ["a", "b"], durationMinutes: 60 } })],
      submittedAt: 0,
    });
    expect(description.title).toBe("Post a 2-post thread on X as @alice");
    expect(field(description, "Post 1")).toMatchObject({ value: "one" });
    expect(field(description, "Post 2: poll options")).toMatchObject({ items: ["a", "b"] });
    expect(field(description, "Post 2: poll open for")).toMatchObject({ value: "60 minutes" });
  });

  it("shows what a reply answers, as context", async () => {
    const description = await describeAction("reply", {
      ref: "~1", draft: draft("Agreed"), parent: { id: "50", info: theirPost }, conversationId: "50", submittedAt: 0,
    });
    expect(description.title).toBe("Reply on X to @bob as @alice");
    expect(field(description, "Replying to")).toMatchObject({ value: "https://x.com/bob/status/50" });
    expect(field(description, "Their post")).toMatchObject({ value: "Bob's post" });
    expect(field(description, "Reply")).toMatchObject({ value: "Agreed" });
  });

  it("shows the target of an engagement", async () => {
    const like = await describeAction("like", { post: { id: "50", info: theirPost }, on: true });
    expect(like.title).toBe("Like a post by @bob on X");
    expect(field(like, "Post")).toMatchObject({ value: "https://x.com/bob/status/50" });
    expect(field(like, "Post text")).toMatchObject({ value: "Bob's post" });
    expect(like.autoApprovable).toBe(false);

    const follow = await describeAction("follow", { user: { ...bob, protected: true }, on: true });
    expect(follow.description).toContain("follow request");
    expect(follow.autoApprovable).toBe(false);
  });

  it("offers only private, reversible actions for auto-approval", async () => {
    expect((await describeAction("bookmark", { post: { id: "50", info: theirPost }, on: true })).autoApprovable).toBe(true);
    expect((await describeAction("mute", { user: bob, on: true })).autoApprovable).toBe(true);
    const journal = new ActionJournal<XAction>(fakeKv(), { namespace: "x" });
    const kinds = actions.bind(journal, {} as XActionHost).autoApprovableKinds().map(kind => kind.tag).toSorted();
    expect(kinds).toEqual(["x.post.bookmark", "x.post.hide", "x.user.mute"]);
  });

  it("refuses to stage an action without the X user it is fenced to", async () => {
    const journal = new ActionJournal<XAction>(fakeKv(), { namespace: "x" });
    const set = actions.bind(journal, { me: async () => me } as unknown as XActionHost);
    await expect(set.submit({ submitAction: async () => {} } as never, "like", { post: { id: "50", info: theirPost }, on: true }))
      .rejects.toThrow(/authority-fenced/);
  });
});

describe("references between actions", () => {
  it("tracks what a create provides and what depends on it", () => {
    const create: XAction = { kind: "createPost", payload: { refs: ["~1", "~2"], drafts: [], submittedAt: 0 } };
    const like: XAction = { kind: "like", payload: { post: { id: "~2", info: theirPost }, on: true } };
    const likeReal: XAction = { kind: "like", payload: { post: { id: "50", info: theirPost }, on: true } };
    expect(providedRefs(create)).toEqual(["~1", "~2"]);
    expect(dependedRefs(like)).toEqual(["~2"]);
    expect(dependedRefs(likeReal)).toEqual([]);
  });

  it("names the images a pending post holds", () => {
    const create: XAction = {
      kind: "createPost",
      payload: { refs: ["~1"], drafts: [draft("x", { images: [{ file: IMAGE, mediaType: "image/png" }] })], submittedAt: 0 },
    };
    expect(imageHandles(create)).toEqual([IMAGE.handle]);
  });
});

describe("validateDraft", () => {
  const none = new Set<string>();
  const valid = (overrides: Partial<XPostDraft>): XPostDraft => ({ text: "hello", ...overrides });

  it("accepts an ordinary post", () => {
    expect(() => validateDraft(valid({}), me, none)).not.toThrow();
    expect(() => validateDraft(valid({ text: "", images: [{ data: JPEG, mediaType: "image/jpeg" }] }), me, none)).not.toThrow();
  });

  it("measures text as X does, against the account's own limit", () => {
    expect(() => validateDraft(valid({ text: "a".repeat(281) }), me, none)).toThrow(/281 characters.*280-character limit for @alice/);
    expect(() => validateDraft(valid({ text: "a".repeat(281) }), premium, none)).not.toThrow();
    expect(() => validateDraft(valid({ text: `${"a".repeat(257)} https://example.com/long` }), me, none)).toThrow(/281/);
  });

  it("refuses what X would refuse", () => {
    expect(() => validateDraft(valid({ text: "  " }), me, none)).toThrow(/text or at least one image/);
    const image = { data: PNG, mediaType: "image/png" as const };
    expect(() => validateDraft(valid({ images: [image, image, image, image, image] }), me, none)).toThrow(/at most 4/);
    expect(() => validateDraft(valid({ images: [image], poll: { options: ["a", "b"], durationMinutes: 60 } }), me, none))
      .toThrow(/both a poll and images/);
    expect(() => validateDraft(valid({ images: [{ data: PNG, mediaType: "image/jpeg" }] }), me, none))
      .toThrow(/don't match its mediaType, image\/jpeg/);
    expect(() => validateDraft(valid({ images: [{ data: new Uint8Array(), mediaType: "image/png" }] }), me, none))
      .toThrow(/empty/);
    expect(() => validateDraft(valid({ poll: { options: ["only"], durationMinutes: 60 } }), me, none)).toThrow(/2 to 4/);
    expect(() => validateDraft(valid({ poll: { options: ["a", "b"], durationMinutes: 1 } }), me, none)).toThrow(/5 to 10,080/);
  });

  it("refuses a duplicate of a post already waiting, as X refuses duplicates", () => {
    expect(() => validateDraft(valid({ text: "Hello  world https://a.co" }), me, new Set(["Hello world"])))
      .toThrow(/already waiting/);
  });
});
