// X's wire objects, and their translation into the agent-facing types.
//
// X is renaming "tweet" to "post" on the wire, and the two spellings coexist: OpenAPI 2.170 says
// `referenced_posts`, `edit_history_post_ids`, `post_count`, `note_post` and `includes.posts`,
// while the docs' examples and every Activity API payload say `referenced_tweets`,
// `edit_history_tweet_ids`, `tweet_count`, `note_tweet` and `includes.tweets`. Every reader here
// accepts both, so neither spelling going away breaks a read.

import type {
  XListInfo, XMediaInfo, XPollInfo, XPostInfo, XReferencedPost, XReplySettings, XUserInfo,
  XUserSummary,
} from "./types";
import { postUrl, profileUrl, listUrl } from "./x-urls";

type ReferenceType = "retweeted" | "quoted" | "replied_to";

/** A post as X sends it. */
export type WirePost = {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: ReferenceType; id: string }[];
  referenced_posts?: { type: ReferenceType; id: string }[];
  attachments?: { media_keys?: string[]; poll_ids?: string[] };
  entities?: WireEntities;
  public_metrics?: {
    like_count?: number; retweet_count?: number; repost_count?: number; reply_count?: number;
    quote_count?: number; bookmark_count?: number; impression_count?: number;
  };
  lang?: string;
  possibly_sensitive?: boolean;
  reply_settings?: string;
  note_tweet?: { text?: string; entities?: WireEntities };
  note_post?: { text?: string; entities?: WireEntities };
};

type WireEntities = {
  urls?: { url?: string; expanded_url?: string; unwound_url?: string; title?: string }[];
  mentions?: { username?: string }[];
  hashtags?: { tag?: string }[];
};

/** A user as X sends it. */
export type WireUser = {
  id: string;
  name?: string;
  username?: string;
  verified?: boolean;
  protected?: boolean;
  profile_image_url?: string;
  description?: string;
  location?: string;
  url?: string;
  created_at?: string;
  public_metrics?: {
    followers_count?: number; following_count?: number; tweet_count?: number;
    post_count?: number; listed_count?: number;
  };
  entities?: { url?: { urls?: { expanded_url?: string }[] } };
  connection_status?: string[];
  subscription_type?: string;
};

/** A media object as X sends it. */
export type WireMedia = {
  media_key: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
};

/** A poll as X sends it. */
export type WirePoll = {
  id: string;
  options?: { position?: number; label?: string; votes?: number }[];
  end_datetime?: string;
  voting_status?: string;
};

/** A List as X sends it. */
export type WireList = {
  id: string;
  name?: string;
  description?: string;
  private?: boolean;
  owner_id?: string;
  member_count?: number;
  follower_count?: number;
  created_at?: string;
};

/** The objects a response's expansions brought along. */
export type WireIncludes = {
  users?: WireUser[];
  tweets?: WirePost[];
  posts?: WirePost[];
  media?: WireMedia[];
  polls?: WirePoll[];
};

/** Expanded objects indexed by id, for resolving one response's references. */
export type Includes = {
  users: Map<string, WireUser>;
  posts: Map<string, WirePost>;
  media: Map<string, WireMedia>;
  polls: Map<string, WirePoll>;
};

/** Indexes a response's `includes`, merging both spellings of the post list. */
export function indexIncludes(includes: WireIncludes | undefined, extraUsers: WireUser[] = []): Includes {
  const index: Includes = { users: new Map(), posts: new Map(), media: new Map(), polls: new Map() };
  for (const user of [...extraUsers, ...includes?.users ?? []]) if (user?.id) index.users.set(user.id, user);
  for (const post of [...includes?.tweets ?? [], ...includes?.posts ?? []]) if (post?.id) index.posts.set(post.id, post);
  for (const item of includes?.media ?? []) if (item?.media_key) index.media.set(item.media_key, item);
  for (const item of includes?.polls ?? []) if (item?.id) index.polls.set(item.id, item);
  return index;
}

function date(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function references(post: WirePost): { type: ReferenceType; id: string }[] {
  return post.referenced_tweets ?? post.referenced_posts ?? [];
}

const REPLY_SETTINGS: ReadonlySet<string> = new Set([
  "everyone", "following", "mentionedUsers", "verified", "subscribers",
]);

/** A user as embedded in posts. An author X did not expand reads as a bare id. */
export function toUserSummary(user: WireUser | undefined, fallbackId = ""): XUserSummary {
  if (!user) {
    return { id: fallbackId, username: "", name: "", verified: false, protected: false };
  }
  return {
    id: user.id,
    username: user.username ?? "",
    name: user.name ?? user.username ?? "",
    verified: user.verified === true,
    protected: user.protected === true,
    ...(user.profile_image_url ? { profileImageUrl: user.profile_image_url } : {}),
  };
}

/**
 * A full profile.
 * @param withRelationship Whether to report the connected account's relationship to the user,
 * from `connection_status`. Off through a Profile binding, and for the connected account itself.
 */
export function toUserInfo(user: WireUser, withRelationship: boolean): XUserInfo {
  const metrics = user.public_metrics ?? {};
  const website = user.entities?.url?.urls?.[0]?.expanded_url ?? user.url;
  const created = date(user.created_at);
  const status = new Set(user.connection_status ?? []);
  return {
    ...toUserSummary(user),
    url: profileUrl(user.username ?? user.id),
    description: user.description ?? "",
    ...(user.location ? { location: user.location } : {}),
    ...(website ? { website } : {}),
    ...(created ? { createdAt: created } : {}),
    followersCount: metrics.followers_count ?? 0,
    followingCount: metrics.following_count ?? 0,
    postCount: metrics.post_count ?? metrics.tweet_count ?? 0,
    listedCount: metrics.listed_count ?? 0,
    ...(withRelationship
      ? { relationship: { following: status.has("following"), followedBy: status.has("followed_by") } }
      : {}),
  };
}

/** Whether `connection_status` reports the connected account muting this user. */
export function isMutedStatus(user: WireUser): boolean {
  return (user.connection_status ?? []).includes("muting");
}

function referenced(id: string, includes: Includes): XReferencedPost | undefined {
  const post = includes.posts.get(id);
  if (!post) return undefined;
  const author = includes.users.get(post.author_id ?? "");
  const created = date(post.created_at);
  return {
    id,
    url: postUrl(id, author?.username),
    text: fullText(post),
    author: toUserSummary(author, post.author_id),
    ...(created ? { createdAt: created } : {}),
  };
}

function fullText(post: WirePost): string {
  return post.note_tweet?.text ?? post.note_post?.text ?? post.text ?? "";
}

function media(post: WirePost, includes: Includes): XMediaInfo[] {
  const items: XMediaInfo[] = [];
  for (const key of post.attachments?.media_keys ?? []) {
    const item = includes.media.get(key);
    if (!item) continue;
    const type = item.type === "video" || item.type === "animated_gif" ? item.type : "photo";
    const url = item.url ?? item.preview_image_url;
    items.push({
      type,
      ...(url ? { url } : {}),
      ...(item.alt_text ? { altText: item.alt_text } : {}),
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.duration_ms ? { durationMs: item.duration_ms } : {}),
    });
  }
  return items;
}

function poll(post: WirePost, includes: Includes): XPollInfo | undefined {
  const id = post.attachments?.poll_ids?.[0];
  const found = id ? includes.polls.get(id) : undefined;
  if (!found) return undefined;
  const endsAt = date(found.end_datetime);
  return {
    options: [...found.options ?? []]
      .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(option => ({ label: option.label ?? "", votes: option.votes ?? 0 })),
    ...(endsAt ? { endsAt } : {}),
    open: found.voting_status !== "closed",
  };
}

/** A post, with its author, references, media and poll resolved from `includes`. */
export function toPostInfo(post: WirePost, includes: Includes): XPostInfo {
  const author = includes.users.get(post.author_id ?? "");
  const entities = post.note_tweet?.entities ?? post.note_post?.entities ?? post.entities ?? {};
  const refs = references(post);
  const repliedTo = refs.find(ref => ref.type === "replied_to");
  const reposted = refs.find(ref => ref.type === "retweeted");
  const quoted = refs.find(ref => ref.type === "quoted");
  const repostOf = reposted && referenced(reposted.id, includes);
  const quoteOf = quoted && referenced(quoted.id, includes);
  const metrics = post.public_metrics ?? {};
  const attachedPoll = poll(post, includes);
  const replySettings = REPLY_SETTINGS.has(post.reply_settings ?? "")
    ? post.reply_settings as XReplySettings
    : "everyone";
  return {
    id: post.id,
    url: postUrl(post.id, author?.username),
    text: fullText(post),
    author: toUserSummary(author, post.author_id),
    createdAt: date(post.created_at) ?? new Date(0),
    conversationId: post.conversation_id ?? post.id,
    ...(repliedTo
      ? { replyTo: { postId: repliedTo.id, userId: post.in_reply_to_user_id ?? "" } }
      : {}),
    ...(repostOf ? { repostOf } : {}),
    ...(quoteOf ? { quoteOf } : {}),
    mentions: (entities.mentions ?? []).map(mention => mention.username ?? "").filter(Boolean),
    hashtags: (entities.hashtags ?? []).map(hashtag => hashtag.tag ?? "").filter(Boolean),
    links: (entities.urls ?? []).flatMap(link => {
      const url = link.unwound_url ?? link.expanded_url ?? link.url;
      return url ? [{ url, ...(link.title ? { title: link.title } : {}) }] : [];
    }),
    media: media(post, includes),
    ...(attachedPoll ? { poll: attachedPoll } : {}),
    metrics: {
      likes: metrics.like_count ?? 0,
      reposts: metrics.repost_count ?? metrics.retweet_count ?? 0,
      replies: metrics.reply_count ?? 0,
      quotes: metrics.quote_count ?? 0,
      bookmarks: metrics.bookmark_count ?? 0,
      impressions: metrics.impression_count ?? 0,
    },
    replySettings,
    ...(post.lang && post.lang !== "und" ? { lang: post.lang } : {}),
    possiblySensitive: post.possibly_sensitive === true,
  };
}

/** A List, with its owner resolved from `includes`. */
export function toListInfo(list: WireList, includes: Includes): XListInfo {
  const created = date(list.created_at);
  return {
    id: list.id,
    url: listUrl(list.id),
    name: list.name ?? "",
    description: list.description ?? "",
    private: list.private === true,
    owner: toUserSummary(includes.users.get(list.owner_id ?? ""), list.owner_id),
    memberCount: list.member_count ?? 0,
    followerCount: list.follower_count ?? 0,
    ...(created ? { createdAt: created } : {}),
  };
}

/** Whether any of these posts, or a post they reference, was written by a protected account. */
export function mentionsProtectedAuthor(posts: readonly XPostInfo[]): boolean {
  return posts.some(post => post.author.protected
    || post.repostOf?.author.protected === true
    || post.quoteOf?.author.protected === true);
}
