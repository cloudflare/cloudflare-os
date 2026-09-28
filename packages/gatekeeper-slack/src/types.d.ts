/** Forward-only paginated results. Call `next()` until it returns `null`; dispose the cursor when
 *  finished, including when stopping early. */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

// ── Plain data types ────────────────────────────────────────────────

/** A Slack user (a human member or a bot/app user). */
export type SlackUser = {
  /** Slack user ID, e.g. "U012AB3CD". */
  id: string;
  /** The `@handle` username, e.g. "jane.doe". */
  username: string;
  /** The user's chosen display name, if set. */
  displayName?: string;
  /** The user's real name, if available. */
  realName?: string;
  /** Whether Slack identifies this as a bot or built-in system user; false does not guarantee a
   *  human. */
  isBot: boolean;
};

/** An emoji reaction on a message. `name` is the emoji short name (without colons), e.g. "thumbsup". */
export type SlackReaction = {
  name: string;
  count: number;
};

/** The kind of conversation a channel/DM represents. */
export type SlackConversationKind =
  | "public_channel"
  | "private_channel"
  | "im"
  | "mpim";

/** Metadata describing a conversation (channel, DM, or group DM). */
export type SlackConversationInfo = {
  /** Slack conversation ID, e.g. "C012AB3CD" (channel) or "D012AB3CD" (DM). */
  id: string;
  kind: SlackConversationKind;
  /** Channel name without the leading "#". Absent for DMs and group DMs. */
  name?: string;
  /** The channel topic, if set. */
  topic?: string;
  /** The channel purpose/description, if set. */
  purpose?: string;
  /** Number of members, when known. */
  memberCount?: number;
  /** True if the channel has been archived. */
  isArchived: boolean;
  /** For a one-to-one direct message (`kind === "im"`), the other participant. This is the reliable
   *  way to identify who a DM is with; `members()` on an IM may only report the connected user. */
  peer?: SlackUser;
};

/** A file shared in a message. Content is not downloaded; use `permalink` to view it in Slack. */
export type SlackFile = {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  /** Size in bytes, when known. */
  size?: number;
  /** Slack permalink to the file. */
  permalink?: string;
};

/** A single message posted in a conversation. */
export type SlackMessage = {
  /** The message timestamp/ID (e.g. "1701361200.123456"). Unique within a conversation and used
   *  to identify threads (a thread's ID is its root message's `ts`). */
  ts: string;
  /** The message author, or null for some system/automated messages. */
  author: SlackUser | null;
  /** The message text. User/channel mentions are resolved to readable names where possible. */
  text: string;
  /** When the message was posted. */
  timestamp: Date;
  /** Set when thread metadata is available; equals the thread root's `ts`. */
  threadTs?: string;
  /** For a thread's root message, the number of replies (excluding the root). Absent for messages
   *  returned by `search()`, which does not report reply counts. */
  replyCount?: number;
  reactions: SlackReaction[];
  files: SlackFile[];
  /** Slack permalink to this message. */
  permalink?: string;
};

/** Basic information about the connected Slack workspace (team). */
export type SlackWorkspaceInfo = {
  teamId: string;
  name: string;
  /** The workspace's `*.slack.com` subdomain. */
  domain: string;
};

// ── Cursor entry types ──────────────────────────────────────────────
// Entries returned by list/search methods bundle metadata together with a capability for the
// resource, so you can act on it directly without a separate lookup.

/** One conversation from a listing, with a capability to read it. */
export type SlackConversationEntry = {
  info: SlackConversationInfo;
  /** Capability for this conversation. Dispose it when finished. */
  conversation: SlackConversation;
};

/** One message from a listing/search, with a capability to its thread when applicable. */
export type SlackMessageEntry = {
  message: SlackMessage;
  /** Present when thread metadata is available for this message. Dispose it when finished. */
  thread?: SlackThread;
};

// ── Capability interfaces ───────────────────────────────────────────

/**
 * A session bound to an entire Slack workspace. Provides read-only access to the channels and
 * direct messages the connected user can see, the workspace's users, and message search.
 */
export interface SlackWorkspaceSession {
  /** Get basic workspace metadata (team ID, name, domain). */
  getInfo(): Promise<SlackWorkspaceInfo>;

  /** List the public and private channels the connected user is a member of. */
  listChannels(): Promise<Cursor<SlackConversationEntry>>;

  /** List the direct messages and group direct messages the connected user participates in. */
  listDirectMessages(): Promise<Cursor<SlackConversationEntry>>;

  /** List the members of the workspace. */
  listUsers(): Promise<Cursor<SlackUser>>;

  /** Look up a single user by their Slack user ID. */
  getUser(userId: string): Promise<SlackUser>;

  /** Get a capability to a specific conversation (channel or DM) by its Slack ID. Dispose it when
   *  finished. Throws if the connected user cannot access it. */
  getConversation(conversationId: string): Promise<SlackConversation>;

  /** Search messages across the workspace using Slack search syntax (e.g.
   *  "from:@bob in:#engineering budget"). The query must be non-empty and at most 1,000 UTF-8
   *  bytes. */
  search(query: string): Promise<Cursor<SlackMessageEntry>>;
}

/**
 * A session bound to a single conversation — a channel, a DM, or a group DM. Provides read-only
 * access to that conversation's messages, threads, and members.
 */
export interface SlackConversation {
  /** Get metadata about this conversation (kind, name, topic, member count, ...). */
  getInfo(): Promise<SlackConversationInfo>;

  /** List the members of this conversation. Note: for a one-to-one DM (`kind === "im"`) Slack may
   *  report only the connected user here; use `getInfo().peer` to identify the other participant. */
  members(): Promise<Cursor<SlackUser>>;

  /** List this conversation's messages, most recent first. Thread replies are not interleaved;
   *  use `getThread()` (or a message entry's `thread`) to read a thread's replies. */
  listMessages(): Promise<Cursor<SlackMessageEntry>>;

  /** Get a capability to the thread containing the given message `ts`. You may pass either the
   *  thread's root `ts` or the `ts` of any reply within it — both give you the same thread. Dispose
   *  it when finished. */
  getThread(threadTs: string): Promise<SlackThread>;

  /** Search messages within this conversation using Slack search syntax. Results are always limited
   *  to this conversation regardless of the query (any `in:` qualifier the caller supplies cannot
   *  broaden it). The query must be non-empty and at most 1,000 UTF-8 bytes. */
  search(query: string): Promise<Cursor<SlackMessageEntry>>;
}

/**
 * A session bound to a single thread within a conversation: the root message and its replies.
 */
export interface SlackThread {
  /** Get the thread's root (parent) message. */
  getRoot(): Promise<SlackMessage>;

  /** List up to 1,000 thread messages, oldest first, including the root as the first element. */
  listReplies(): Promise<SlackMessage[]>;
}
