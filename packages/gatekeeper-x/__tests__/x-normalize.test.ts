// Fixtures follow X's documented response shapes (source: docs, 2026-10). The live API is mid-way
// through renaming "tweet" to "post", so each shape appears in both spellings and must read the same.

import { describe, expect, it } from "vitest";
import {
  indexIncludes, isMutedStatus, mentionsProtectedAuthor, toListInfo, toPostInfo, toUserInfo,
  type WireIncludes, type WirePost, type WireUser,
} from "../src/x-normalize";

const alice: WireUser = { id: "1", username: "alice", name: "Alice", verified: true, protected: false };
const bob: WireUser = { id: "2", username: "bob", name: "Bob", protected: true };

/** A long reply quoting a protected account's post, in the docs' (tweet) spelling. */
const tweetSpelling: { post: WirePost; includes: WireIncludes } = {
  post: {
    id: "100",
    text: "Truncated text…",
    author_id: "1",
    created_at: "2026-10-01T12:00:00.000Z",
    conversation_id: "90",
    in_reply_to_user_id: "2",
    referenced_tweets: [{ type: "replied_to", id: "90" }, { type: "quoted", id: "80" }],
    note_tweet: {
      text: "The full long text, with a link https://t.co/x and @bob",
      entities: {
        urls: [{ url: "https://t.co/x", expanded_url: "https://example.com/x", title: "Example" }],
        mentions: [{ username: "bob" }],
        hashtags: [{ tag: "news" }],
      },
    },
    public_metrics: { like_count: 3, retweet_count: 2, reply_count: 1, quote_count: 0, bookmark_count: 4, impression_count: 99 },
    reply_settings: "following",
    lang: "en",
  },
  includes: {
    users: [alice, bob],
    tweets: [{ id: "80", text: "Bob's quoted post", author_id: "2", created_at: "2026-09-30T00:00:00.000Z" }],
  },
};

/** The same post in OpenAPI 2.170's (post) spelling. */
const postSpelling: { post: WirePost; includes: WireIncludes } = {
  post: {
    ...tweetSpelling.post,
    referenced_tweets: undefined,
    referenced_posts: tweetSpelling.post.referenced_tweets,
    note_tweet: undefined,
    note_post: tweetSpelling.post.note_tweet,
    public_metrics: { ...tweetSpelling.post.public_metrics, retweet_count: undefined, repost_count: 2 },
  },
  includes: { users: [alice, bob], posts: tweetSpelling.includes.tweets },
};

describe("toPostInfo", () => {
  it("reads both spellings the same", () => {
    const fromTweets = toPostInfo(tweetSpelling.post, indexIncludes(tweetSpelling.includes));
    const fromPosts = toPostInfo(postSpelling.post, indexIncludes(postSpelling.includes));
    expect(fromPosts).toEqual(fromTweets);
  });

  it("takes the full text of a long post, and resolves its references", () => {
    const info = toPostInfo(tweetSpelling.post, indexIncludes(tweetSpelling.includes));
    expect(info).toMatchObject({
      id: "100",
      url: "https://x.com/alice/status/100",
      text: "The full long text, with a link https://t.co/x and @bob",
      author: { id: "1", username: "alice", verified: true, protected: false },
      conversationId: "90",
      replyTo: { postId: "90", userId: "2" },
      quoteOf: { id: "80", url: "https://x.com/bob/status/80", text: "Bob's quoted post", author: { username: "bob", protected: true } },
      mentions: ["bob"],
      hashtags: ["news"],
      links: [{ url: "https://example.com/x", title: "Example" }],
      metrics: { likes: 3, reposts: 2, replies: 1, quotes: 0, bookmarks: 4, impressions: 99 },
      replySettings: "following",
      lang: "en",
      possiblySensitive: false,
    });
    expect(info.repostOf).toBeUndefined();
  });

  it("reads a post whose author X did not expand as a bare ID", () => {
    const info = toPostInfo({ id: "5", text: "hi", author_id: "77" }, indexIncludes(undefined));
    expect(info.author).toEqual({ id: "77", username: "", name: "", verified: false, protected: false });
    expect(info.url).toBe("https://x.com/i/web/status/5");
    expect(info.conversationId).toBe("5");
    expect(info.replySettings).toBe("everyone");
  });

  it("resolves media and polls, ordering poll options", () => {
    const info = toPostInfo(
      { id: "6", text: "vote", attachments: { media_keys: ["3_1", "7_2"], poll_ids: ["p1"] }, lang: "und" },
      indexIncludes({
        media: [
          { media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/a.jpg", alt_text: "A cat", width: 10, height: 20 },
          { media_key: "7_2", type: "video", preview_image_url: "https://pbs.twimg.com/b.jpg", duration_ms: 5000 },
        ],
        polls: [{
          id: "p1", voting_status: "closed", end_datetime: "2026-10-02T00:00:00.000Z",
          options: [{ position: 2, label: "No", votes: 1 }, { position: 1, label: "Yes", votes: 5 }],
        }],
      }));
    expect(info.media).toEqual([
      { type: "photo", url: "https://pbs.twimg.com/a.jpg", altText: "A cat", width: 10, height: 20 },
      { type: "video", url: "https://pbs.twimg.com/b.jpg", durationMs: 5000 },
    ]);
    expect(info.poll).toEqual({
      options: [{ label: "Yes", votes: 5 }, { label: "No", votes: 1 }],
      endsAt: new Date("2026-10-02T00:00:00.000Z"),
      open: false,
    });
    expect(info.lang).toBeUndefined();
  });
});

describe("mentionsProtectedAuthor", () => {
  it("flags a page that discloses a protected account's post, quoted or not", () => {
    const quoting = toPostInfo(tweetSpelling.post, indexIncludes(tweetSpelling.includes));
    const plain = toPostInfo({ id: "7", text: "hi", author_id: "1" }, indexIncludes({ users: [alice] }));
    const byBob = toPostInfo({ id: "8", text: "hi", author_id: "2" }, indexIncludes({ users: [bob] }));
    expect(mentionsProtectedAuthor([plain])).toBe(false);
    expect(mentionsProtectedAuthor([plain, quoting])).toBe(true);
    expect(mentionsProtectedAuthor([byBob])).toBe(true);
  });
});

describe("toUserInfo", () => {
  const user: WireUser = {
    ...alice,
    description: "Bio",
    url: "https://t.co/site",
    entities: { url: { urls: [{ expanded_url: "https://alice.example" }] } },
    public_metrics: { followers_count: 10, following_count: 2, post_count: 30, listed_count: 1 },
    connection_status: ["following", "muting"],
  };

  it("reports the relationship only when asked", () => {
    expect(toUserInfo(user, true).relationship).toEqual({ following: true, followedBy: false });
    expect(toUserInfo(user, false).relationship).toBeUndefined();
  });

  it("reads counts in either spelling, and the expanded website", () => {
    const info = toUserInfo(user, false);
    expect(info).toMatchObject({ followersCount: 10, followingCount: 2, postCount: 30, website: "https://alice.example" });
    expect(toUserInfo({ id: "3", username: "c", public_metrics: { tweet_count: 4 } }, false).postCount).toBe(4);
  });

  it("reads the mute state from connection_status", () => {
    expect(isMutedStatus(user)).toBe(true);
    expect(isMutedStatus(alice)).toBe(false);
  });
});

describe("toListInfo", () => {
  it("resolves the owner from includes", () => {
    const info = toListInfo(
      { id: "9", name: "Friends", private: true, owner_id: "1", member_count: 3, follower_count: 0 },
      indexIncludes({ users: [alice] }));
    expect(info).toEqual({
      id: "9", url: "https://x.com/i/lists/9", name: "Friends", description: "", private: true,
      owner: { id: "1", username: "alice", name: "Alice", verified: true, protected: false },
      memberCount: 3, followerCount: 0,
    });
  });
});
