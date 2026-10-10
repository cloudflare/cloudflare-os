// TypeScript API exposed to Gadgets by the X gatekeeper. X was formerly called Twitter, and a
// "post" was formerly called a "tweet".
//
// Four resource granularities are offered:
//   1. X Account (whole account)  -> `XAccountSession`: the connected account's timelines,
//      search, bookmarks and likes, publishing, and capabilities for any post, user, or List.
//   2. X Post (one post)          -> `XPost`: one post and the conversation it belongs to.
//   3. X List (one List)          -> `XList`: one List's posts and members.
//   4. X Profile (one user)       -> `XProfile`: one user's public profile and posts, read-only.
//
// Every read counts toward a daily read limit for the connected account. Ask for small pages, and
// use `sinceId` to fetch only what is new since the last read.

/**
 * Forward-only paginated results. This is an RPC object: call `next()` repeatedly on the same
 * cursor until it returns `null`. A page may be empty before the end, so stop on `null`, not on an
 * empty page. Dispose the cursor when finished, including when stopping early.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** How many results each page of a listing holds. */
export type XPageOptions = {
  /** Results per page, 1–100. Defaults to 20. */
  pageSize?: number;
};

/** Bounds for a listing ordered by time, newest first. Every bound is exclusive. */
export type XTimeRangeOptions = XPageOptions & {
  /**
   * Only posts newer than this post ID. Pass the newest post ID you have already seen to fetch
   * only the posts that arrived since.
   */
  sinceId?: string;
  /** Only posts older than this post ID. */
  untilId?: string;
  /** Only posts created after this time. */
  startTime?: Date;
  /** Only posts created before this time. */
  endTime?: Date;
};

/** Bounds for a user's timeline. */
export type XTimelineOptions = XTimeRangeOptions & {
  /** Leave out replies. */
  excludeReplies?: boolean;
  /** Leave out reposts. */
  excludeReposts?: boolean;
};

/** Options for `searchPosts`. */
export type XSearchOptions = XTimeRangeOptions & {
  /** "recency" (the default) orders newest first; "relevancy" orders by X's relevance. */
  sortOrder?: "recency" | "relevancy";
};

/** A user, as embedded in posts and listings. */
export type XUserSummary = {
  /** The user's numeric ID, as a string. Unlike a username, it never changes. */
  id: string;
  /** The user's handle, without the "@". */
  username: string;
  /** The user's display name. */
  name: string;
  /** Whether X shows a verified badge for this user. */
  verified: boolean;
  /** Whether only approved followers can see this user's posts. */
  protected: boolean;
  /** URL of the user's profile image. */
  profileImageUrl?: string;
};

/** A user's profile. */
export type XUserInfo = XUserSummary & {
  /** The user's profile on x.com. */
  url: string;
  /** The profile's bio. */
  description: string;
  /** The location the user entered, which may not be a real place. */
  location?: string;
  /** The website on the user's profile. */
  website?: string;
  /** When the account was created. */
  createdAt?: Date;
  followersCount: number;
  followingCount: number;
  postCount: number;
  /** How many Lists include this user. */
  listedCount: number;
  /**
   * How the connected account relates to this user. Absent for the connected account itself and
   * through an "X Profile" grant.
   */
  relationship?: {
    /** Whether the connected account follows this user. */
    following: boolean;
    /** Whether this user follows the connected account. */
    followedBy: boolean;
  };
};

/** Who may reply to a post. */
export type XReplySettings = "everyone" | "following" | "mentionedUsers" | "verified" | "subscribers";

/** A post that another post reposts, quotes, or replies to. */
export type XReferencedPost = {
  id: string;
  /** Link to the post on x.com. */
  url: string;
  text: string;
  author: XUserSummary;
  createdAt?: Date;
};

/** A photo, video, or GIF attached to a post. */
export type XMediaInfo = {
  type: "photo" | "video" | "animated_gif";
  /** The image itself for a photo; a preview image for a video or GIF. */
  url?: string;
  /** The description of the image for people who can't see it. */
  altText?: string;
  width?: number;
  height?: number;
  /** Length of a video, in milliseconds. */
  durationMs?: number;
};

/** A poll attached to a post. */
export type XPollInfo = {
  options: { label: string; votes: number }[];
  /** When voting closes. */
  endsAt?: Date;
  /** Whether voting is still open. */
  open: boolean;
};

/** A post. */
export type XPostInfo = {
  /**
   * The post's ID. A post published by this session that X has not yet assigned an ID to carries a
   * temporary ID starting with "~", which works anywhere this API accepts a post ID.
   */
  id: string;
  /** Link to the post on x.com. Absent while the ID is temporary. */
  url?: string;
  /** The full text, also for long posts. Links appear in their t.co form; see `links`. */
  text: string;
  author: XUserSummary;
  /** When the post was created. */
  createdAt: Date;
  /** ID of the post that started this post's conversation (its own ID if it did). */
  conversationId: string;
  /** Present when this post is a reply. */
  replyTo?: { postId: string; userId: string };
  /**
   * Present when this post is a repost of another post. A repost waiting for approval is listed by
   * `listMyPosts()` under the reposted post's ID, since a repost has none until X makes it.
   */
  repostOf?: XReferencedPost;
  /** Present when this post quotes another post. */
  quoteOf?: XReferencedPost;
  /** Usernames mentioned in the text, without the "@". */
  mentions: string[];
  /** Hashtags in the text, without the "#". */
  hashtags: string[];
  /** Links in the text, expanded from their t.co form. */
  links: { url: string; title?: string }[];
  media: XMediaInfo[];
  poll?: XPollInfo;
  /** Engagement counts as X last reported them. */
  metrics: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    bookmarks: number;
    impressions: number;
  };
  replySettings: XReplySettings;
  /** The language X detected, as a BCP 47 tag. */
  lang?: string;
  /** Whether X marked links in this post as possibly sensitive. */
  possiblySensitive: boolean;
};

/** An image to attach to a post. */
export type XImageAttachment = {
  /** The image: JPEG, PNG, or WEBP bytes, at most 5 MB. */
  data: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** A description of the image for people who can't see it, at most 1,000 characters. */
  altText?: string;
};

/** The contents of a new post or reply. */
export type XPostDraft = {
  /**
   * The text: at most 280 characters, or 25,000 for an X Premium account. Each link counts as 23
   * characters, and some characters (most CJK characters and emoji) count as 2. May be empty when
   * `images` are given.
   */
  text: string;
  /** Up to 4 images. Cannot be combined with `poll`. */
  images?: XImageAttachment[];
  /** A poll: 2–4 options of 1–25 characters each, open for 5 to 10,080 minutes (7 days). */
  poll?: { options: string[]; durationMinutes: number };
  /** Who may reply. Defaults to "everyone". */
  replySettings?: XReplySettings;
  /** Set to true when an attached image was generated by AI; X then labels the post. */
  madeWithAi?: boolean;
};

/** A List. */
export type XListInfo = {
  /**
   * The List's ID. A List this session created that X has not yet assigned an ID to carries a
   * temporary ID starting with "~".
   */
  id: string;
  /** Link to the List on x.com. Absent while the ID is temporary. */
  url?: string;
  name: string;
  description: string;
  /** Whether only the owner can see the List. */
  private: boolean;
  owner: XUserSummary;
  memberCount: number;
  followerCount: number;
  createdAt?: Date;
};

/**
 * One post. Obtained from `XAccountSession.getPost()` or `XPost.getConversationPost()`, or granted
 * directly as the "X Post" resource, which reaches that post's conversation and nothing else.
 *
 * Dispose this stub when done.
 */
export interface XPost {
  /** Read the post. Throws if it was deleted or the connected account cannot see it. */
  getInfo(): Promise<XPostInfo>;

  /**
   * Direct replies to this post from the last 7 days, newest first. Replies the author hid still
   * appear here.
   */
  listReplies(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;

  /** Every post in this post's conversation from the last 7 days, newest first. */
  listConversation(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;

  /** Posts that quote this post, newest first. */
  listQuotes(options?: XPageOptions): Promise<Cursor<XPostInfo>>;

  /**
   * A capability for another post in this post's conversation, such as one of its replies, so it
   * can be read and acted on. Fetches nothing until used; its methods throw if the post belongs to
   * a different conversation. Dispose the returned stub when done.
   */
  getConversationPost(postId: string): XPost;

  /** Reply to this post as the connected account. Returns the new reply. */
  reply(draft: XPostDraft): Promise<XPost>;

  /** Like this post as the connected account. */
  like(): Promise<void>;
  /** Remove the connected account's like from this post. */
  unlike(): Promise<void>;
  /** Repost this post to the connected account's followers. */
  repost(): Promise<void>;
  /** Undo the connected account's repost of this post. */
  undoRepost(): Promise<void>;
  /** Bookmark this post. Bookmarks are private to the connected account. */
  bookmark(): Promise<void>;
  /** Remove this post from the connected account's bookmarks. */
  removeBookmark(): Promise<void>;

  /** Permanently delete this post. Only the connected account's own posts can be deleted. */
  delete(): Promise<void>;

  /**
   * Hide this reply. Only replies in a conversation the connected account started can be hidden.
   */
  hide(): Promise<void>;
  /** Unhide this reply. */
  unhide(): Promise<void>;
}

/**
 * One user's public profile and posts, read-only. Granted directly as the "X Profile" resource,
 * through which nothing about the connected account is visible.
 *
 * Dispose this stub when done.
 */
export interface XProfile {
  /** Read the user's profile. */
  getInfo(): Promise<XUserInfo>;

  /** The user's posts, newest first, up to their most recent 3,200. */
  listPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;
}

/**
 * One user as the connected account sees them: their profile and posts, plus the connected
 * account's relationship to them. Obtained from `XAccountSession.getUser()` or `getUserById()`.
 *
 * Dispose this stub when done.
 */
export interface XUser extends XProfile {
  /** Whether the connected account has muted this user. */
  isMuted(): Promise<boolean>;

  /**
   * Follow this user as the connected account. Following a protected account sends a follow
   * request, so `relationship.following` stays false until the user accepts.
   */
  follow(): Promise<void>;
  /** Stop following this user. */
  unfollow(): Promise<void>;
  /** Mute this user, hiding their posts from the connected account. Mutes are private. */
  mute(): Promise<void>;
  /** Unmute this user. */
  unmute(): Promise<void>;
}

/**
 * One List. Obtained from `XAccountSession.getList()` or `createList()`, or granted directly as the
 * "X List" resource. Only Lists the connected account owns can be changed.
 *
 * Dispose this stub when done.
 */
export interface XList {
  /** Read the List's details. */
  getInfo(): Promise<XListInfo>;

  /** Posts from the List's members, newest first. */
  listPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>>;

  /** The List's members. */
  listMembers(options?: XPageOptions): Promise<Cursor<XUserInfo>>;

  /** Add a user to the List. `username` may include the "@". */
  addMember(username: string): Promise<void>;
  /** Remove a user from the List. `username` may include the "@". */
  removeMember(username: string): Promise<void>;

  /** Change the List's name, description, or privacy. Omitted fields are left unchanged. */
  update(changes: { name?: string; description?: string; private?: boolean }): Promise<void>;

  /** Permanently delete the List. */
  delete(): Promise<void>;
}

/**
 * The connected X account, granted as the whole-account "X Account" resource. Hands out narrower
 * `XPost`, `XUser`, and `XList` capabilities.
 */
export interface XAccountSession {
  /** The connected account's own profile. */
  getProfile(): Promise<XUserInfo>;

  /**
   * Posts from the accounts the connected account follows, newest first: the last 7 days, at most
   * 3,200 posts.
   */
  listHomeTimeline(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;

  /** Posts that mention the connected account, newest first, up to the most recent 800. */
  listMentions(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;

  /** The connected account's own posts and reposts, newest first. */
  listMyPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;

  /**
   * Posts from the last 7 days matching an X search query, at most 512 characters. The query uses
   * X's search syntax: keywords, "exact phrases", OR, -negation, and operators such as `from:`,
   * `to:`, `@`, `#`, `lang:`, `is:reply`, `-is:retweet`, `has:links`, and `has:media`. For
   * example: `"workers ai" from:cloudflare -is:retweet`.
   */
  searchPosts(query: string, options?: XSearchOptions): Promise<Cursor<XPostInfo>>;

  /** The connected account's bookmarks, most recently bookmarked first. */
  listBookmarks(options?: XPageOptions): Promise<Cursor<XPostInfo>>;

  /** Posts the connected account liked, most recently liked first. */
  listLikedPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>>;

  /** The users the connected account follows, most recently followed first. */
  listFollowing(options?: XPageOptions): Promise<Cursor<XUserInfo>>;

  /** The users who follow the connected account, most recent first. */
  listFollowers(options?: XPageOptions): Promise<Cursor<XUserInfo>>;

  /** The Lists the connected account owns. */
  listOwnedLists(options?: XPageOptions): Promise<Cursor<XListInfo>>;

  /**
   * A capability for a post, by ID or by x.com or twitter.com link. Fetches nothing until used.
   * Dispose the returned stub when done.
   */
  getPost(idOrUrl: string): XPost;

  /**
   * A capability for a user, by username (with or without the "@") or profile link. Fetches
   * nothing until used. Dispose the returned stub when done.
   */
  getUser(usernameOrUrl: string): XUser;

  /** A capability for a user by numeric ID. Dispose the returned stub when done. */
  getUserById(userId: string): XUser;

  /** A capability for a List, by ID or link. Dispose the returned stub when done. */
  getList(idOrUrl: string): XList;

  /** Publish a post as the connected account. Returns the new post. */
  createPost(draft: XPostDraft): Promise<XPost>;

  /**
   * Publish a thread: the first draft as a post, then each following draft as a reply to the one
   * before it. At most 25 posts. Returns the new posts, in order.
   */
  createThread(drafts: XPostDraft[]): Promise<XPost[]>;

  /** Create a List owned by the connected account. Lists are public unless `private` is set. */
  createList(name: string, options?: { description?: string; private?: boolean }): Promise<XList>;
}
