import type { RpcTarget } from "cloudflare:workers";

/**
 * A pagination cursor.
 *
 * Call `next()` repeatedly on the same RPC object and dispose it when finished. Drain it until
 * `next()` returns `null`; an empty array means only that this call made no visible progress.
 */
export interface Cursor<T> extends RpcTarget {
  /** The next batch, `[]` when more work remains, or `null` once exhausted. */
  next(): Promise<T[] | null>;
}

// ── Users and spaces ────────────────────────────────────────────────

/** A person or Chat app visible to the connected Google account. */
export type ChatUser = {
  /**
   * Stable opaque identity, such as `users/123`. Compare users by this, and pass it wherever a
   * method takes a user.
   */
  id: string;
  /** Display name, when Google Chat supplies one. Fall back to `id` when it is absent. */
  name?: string;
  /** Whether this identity is a person or a Chat app. */
  type: "human" | "app";
};

/** The kind of Google Chat conversation. */
export type ChatSpaceType = "space" | "groupChat" | "directMessage";

/** Metadata about a Google Chat space, group chat, or direct message. */
export type ChatSpaceInfo = {
  /** Opaque conversation ID, such as `spaces/AAAA1234`. */
  id: string;
  /**
   * Display name. Direct messages and most group chats have no name of their own:
   * `ChatSpace.getMetadata()` names them after their other participants (see `peer`), while
   * listings and lookups leave both absent.
   */
  name?: string;
  /**
   * For a direct message, the other participant. Present only in `ChatSpace.getMetadata()`
   * results, and only when Chat identifies exactly one other participant.
   */
  peer?: ChatUser;
  /** Browser URL for opening the conversation, when Google returns one. */
  url?: string;
  /** Kind of conversation. */
  type: ChatSpaceType;
  /**
   * Whether messages here are grouped into threads, which `listThreads()`, `getThread()`,
   * `ChatMessage.getThread()`, and `ChatMessage.reply()` require. Spaces, group chats, and direct
   * messages normally support threads; the exceptions are conversations Google keeps flat, such
   * as continuous meeting chat and some group chats created before 2022.
   */
  supportsThreads: boolean;
  /** Description of a named space, when one is set. */
  description?: string;
  /** When the space was created, when Google returns it. */
  createdAt?: Date;
  /** Time of the most recent activity, when Google returns it. */
  lastActiveAt?: Date;
  /**
   * Number of people who have directly joined, when Google returns it. `listMembers()` can
   * return more entries than this: it also lists Chat apps, invited members, and Google Groups.
   */
  memberCount?: number;
};

/** A listing result: space metadata plus a capability for that space. */
export type ChatSpaceEntry = {
  /** Metadata for this result. */
  info: ChatSpaceInfo;
  /** Capability for reading and acting in this conversation. */
  space: ChatSpace;
};

/** Options for listing conversations. */
export type ChatListSpacesOptions = {
  /** Only list conversations of any of these types. Defaults to all of them. */
  spaceTypes?: ChatSpaceType[];
};

/** One membership in a space: a person or Chat app, or a Google Group. */
export type ChatMembership = {
  /** Opaque membership ID. */
  id: string;
  /** Current membership state. */
  state: "joined" | "invited" | "notMember";
  /** The member's role in the space. */
  role: "member" | "assistantManager" | "manager";
} & (
  | {
    kind: "user";
    /** The person or Chat app. */
    user: ChatUser;
  }
  | {
    kind: "group";
    /** The Google Group's resource name, such as `groups/123`. */
    groupId: string;
  }
);

// ── Messages ────────────────────────────────────────────────────────

/** Metadata for a file attached to a Chat message. */
export type ChatAttachmentInfo = {
  /** Opaque attachment ID. */
  id: string;
  /** Original filename. */
  filename: string;
  /** MIME media type, such as `application/pdf`. */
  mimeType: string;
  /** Whether the file was uploaded to Chat or linked from Google Drive. */
  source: "uploaded" | "drive";
  /** Google Drive file ID, present only for Drive-linked attachments. */
  driveFileId?: string;
  /** Whether `ChatAttachment.getContent()` can read this file. */
  readable: boolean;
};

/** How many people reacted to a message with one emoji. */
export type ChatReactionSummary = {
  /** Unicode emoji, or `:name:` for a custom emoji. */
  emoji: string;
  /** Number of reactions using this emoji. */
  count: number;
};

/** A Google Chat message. */
export type ChatMessageInfo = {
  /**
   * Opaque message ID, such as `spaces/AAAA1234/messages/BBBB5678`.
   *
   * A message you posted that is still pending has a temporary ID of the form
   * `pending:send:{n}` instead. Keep using it: it continues to identify the message after it
   * is committed.
   */
  id: string;
  /** ID of the containing conversation. */
  spaceId: string;
  /**
   * Containing thread ID, such as `spaces/AAAA1234/threads/CCCC`. Only meaningful where the
   * conversation's `supportsThreads` is true. A top-level message you just posted names its new
   * thread with a temporary `pending:thread:{n}` ID until it is committed.
   */
  threadId?: string;
  /** Who sent the message. */
  sender?: ChatUser;
  /**
   * Message body in Google Chat's formatting syntax (see `ChatSpace.post()`). Committed mentions
   * read back as `@Name`, with `mentions` listing who they refer to; a pending message keeps the
   * `<users/{user}>` form you posted. Empty when the message has no text, such as an
   * attachment-only message.
   */
  text: string;
  /** Users @mentioned in the message. Empty for a pending message until it is committed. */
  mentions: ChatUser[];
  /** When the message was created. */
  createdAt: Date;
  /** When the message was last edited, when Google returns it. */
  editedAt?: Date;
  /** Whether this message is a reply in a thread rather than the thread's first message. */
  isReply: boolean;
  /** Files attached to the message. */
  attachments: ChatAttachmentInfo[];
  /** Reaction counts, grouped by emoji. */
  reactions: ChatReactionSummary[];
  /**
   * True for a message you posted that is not committed yet. Its `createdAt` is provisional:
   * the committed message carries the time Google assigns. You can reply to it and edit it right
   * away; reactions can be added once it is committed.
   */
  pending?: boolean;
};

/** A message result: metadata plus a capability for that message. */
export type ChatMessageEntry = {
  /** Metadata for this result. */
  info: ChatMessageInfo;
  /** Capability for reading or changing this message. */
  message: ChatMessage;
};

/** Messages created within `[since, before)`, at millisecond precision. */
export type ChatWindow = {
  /** Include messages created at or after this time. */
  since?: Date;
  /** Include messages created before this time. */
  before?: Date;
};

/**
 * Options for reading a conversation's or thread's history. Deleted messages, and messages a
 * Chat app showed only to you, are omitted.
 */
export type ChatListMessagesOptions = ChatWindow & {
  /**
   * Result order. `ChatSpace.listMessages()` defaults to `"newestFirst"`;
   * `ChatThread.listMessages()` defaults to `"oldestFirst"`.
   */
  order?: "newestFirst" | "oldestFirst";
};

/**
 * Filters for searching messages within one conversation. Every supplied field must match;
 * within a list-valued field, a message matches if it matches any entry.
 *
 * Search covers committed messages only: your pending posts and edits don't appear, and the
 * search index can lag recent edits and deletions by minutes. It never returns messages posted
 * by Chat apps, messages in direct messages with Chat apps, messages from blocked users,
 * messages a Chat app showed only to you, or messages in conversations you have muted. Use
 * `ChatSpace.listMessages()` when you need complete, current history for one conversation.
 *
 * Google rejects a search whose combined filters exceed 1,000 characters.
 */
export type ChatSpaceMessageSearch = ChatWindow & {
  /**
   * Words and "quoted phrases" the message must all contain, such as `budget "Q3 plan"`. Each
   * word or phrase is at most 500 characters; an unmatched `"` is an error.
   */
  text?: string;
  /** Only messages sent by any of these users, each `users/{user}` or an email address. */
  senders?: string[];
  /**
   * Only messages mentioning any of these users, each `users/{user}` or an email address;
   * `users/me` is you. Cannot be combined with `mentionsMe`.
   */
  mentions?: string[];
  /** Only messages that mention you. Cannot be combined with `mentions`. */
  mentionsMe?: boolean;
  /** Only messages with at least one attachment. */
  hasAttachment?: boolean;
  /** Only messages whose text contains at least one link. */
  hasLink?: boolean;
};

/**
 * Filters for searching across conversations, adding conversation selectors. Supply at least one.
 */
export type ChatMessageSearch = ChatSpaceMessageSearch & {
  /**
   * Only messages in any of these conversations, by `ChatSpaceInfo.id`. To search conversations
   * by name, find them with `ChatSession.searchSpaces()` first.
   */
  spaceIds?: string[];
  /**
   * Only messages you have not read. Your read state is yours alone, so only account-wide search
   * offers this; pass `spaceIds` to narrow it to one conversation.
   */
  unreadOnly?: boolean;
  /** Only messages in conversations of any of these types. */
  spaceTypes?: ChatSpaceType[];
};

/** One person's reaction to a message. */
export type ChatReaction = {
  /** Opaque reaction ID. */
  id: string;
  /** Unicode emoji, or `:name:` for a custom emoji. */
  emoji: string;
  /** Who reacted, when Google returns it. */
  user?: ChatUser;
};

/** A thread: a first message together with zero or more replies. */
export type ChatThreadInfo = {
  /**
   * Thread ID, such as `spaces/AAAA1234/threads/CCCC`, or a temporary `pending:thread:{n}` for
   * a thread whose first message is still pending.
   */
  id: string;
  /** ID of the containing conversation. */
  spaceId: string;
  /** The newest message; in `listThreads()` results, the newest within the listing's window. */
  latestMessage: ChatMessageInfo;
  /**
   * The thread's first message. Absent only when that message was deleted or is hidden from
   * you; the replies remain readable.
   */
  rootMessage?: ChatMessageInfo;
};

/** A discovered thread, its newest matching message, and access to the full thread. */
export type ChatThreadEntry = {
  /** Summary for this result. */
  info: ChatThreadInfo;
  /** Access to the whole thread, including messages outside the discovery window. */
  thread: ChatThread;
};

// ── Capability interfaces ───────────────────────────────────────────

/**
 * A session bound to the connected Google Chat account.
 *
 * Use this to find conversations and search across them, then use the `ChatSpace`
 * capabilities it returns to read and act inside one conversation.
 */
export interface ChatSession extends RpcTarget {
  /** Return the connected account's own Chat identity. */
  getCurrentUser(): Promise<ChatUser>;

  /**
   * List conversations the connected user has joined. Group chats and direct messages appear
   * only once they contain a message.
   */
  listSpaces(options?: ChatListSpacesOptions): Promise<Cursor<ChatSpaceEntry>>;

  /**
   * Find joined spaces whose display name matches `name`: at most 100, returned as one page.
   *
   * The text is matched token by token, case-insensitively, against the start of any word in the
   * name, so `proj rev` matches "Project review" but `ject` does not.
   * Only spaces are searched; group chats (even named ones) and direct messages are never
   * returned. Use {@link listSpaces} or {@link findDirectMessage} for those.
   */
  searchSpaces(name: string): Promise<Cursor<ChatSpaceEntry>>;

  /**
   * Open the existing direct message between the connected user and `user`, named
   * `users/{user}` or by email address. Returns `null` when no direct message exists or the
   * user cannot be found.
   */
  findDirectMessage(user: string): Promise<ChatSpaceEntry | null>;

  /**
   * Open a conversation, with its current metadata, by its ID (`spaces/AAAA1234` or bare
   * `AAAA1234`) or by a Google Chat link to it or to a message in it, from chat.google.com or
   * Chat in Gmail. Throws when the connected user cannot access it.
   */
  getSpace(idOrUrl: string): Promise<ChatSpaceEntry>;

  /**
   * Search messages across the conversations available to the connected user, newest first.
   *
   * See {@link ChatMessageSearch} for what search covers.
   */
  searchMessages(query: ChatMessageSearch): Promise<Cursor<ChatMessageEntry>>;
}

/**
 * A session bound to one Google Chat space, group chat, or direct message: its messages,
 * threads, and members. Call `post()` to send a new message to it.
 */
export interface ChatSpace extends RpcTarget {
  /**
   * Return current metadata. For a direct message or unnamed group chat this also names the
   * conversation after its other participants, and identifies a direct message's `peer`.
   */
  getMetadata(): Promise<ChatSpaceInfo>;

  /** Return the connected account's own Chat identity, the sender of anything posted here. */
  getCurrentUser(): Promise<ChatUser>;

  /**
   * List messages in this conversation, newest first unless `order` says otherwise.
   *
   * Thread replies are interleaved with top-level messages by creation time; group by
   * `threadId`, or use {@link listThreads}, to follow individual threads.
   */
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;

  /**
   * Search messages in this conversation, newest first.
   *
   * See {@link ChatSpaceMessageSearch} for what search covers.
   */
  searchMessages(query: ChatSpaceMessageSearch): Promise<Cursor<ChatMessageEntry>>;

  /**
   * List threads with messages posted within the window, newest matching message first.
   * Includes zero-reply threads and older threads with new replies; each thread appears once.
   * Your pending posts appear ahead of committed history, with provisional timestamps. Edits
   * and reactions do not count as new messages. Throws when `supportsThreads` is false; use
   * {@link listMessages} there. At most 5,000 threads per cursor; use a narrower window if that
   * limit is reached.
   */
  listThreads(window?: ChatWindow): Promise<Cursor<ChatThreadEntry>>;

  /**
   * Get a thread in this conversation by its ID, including a temporary `pending:thread:{n}`,
   * with its current metadata. Throws if the thread is unavailable, belongs to another
   * conversation, or this conversation does not support threads.
   */
  getThread(id: string): Promise<ChatThreadEntry>;

  /**
   * Get a message by its ID, with its current metadata. Throws if it has been deleted, is
   * unavailable, or is outside this conversation.
   */
  getMessage(id: string): Promise<ChatMessageEntry>;

  /** List the people, Google Groups, and Chat apps in this conversation. */
  listMembers(): Promise<Cursor<ChatMembership>>;

  /**
   * Look up one member by `users/{user}` resource name or email address. Returns `null` when
   * that user is not a member or cannot be found.
   */
  findMember(user: string): Promise<ChatMembership | null>;

  /**
   * Post a top-level message to this conversation as the connected user.
   *
   * `text` uses Google Chat's formatting syntax: `*bold*`, `_italic_`, `~strikethrough~`,
   * `` `code` ``, ```` ``` ```` code blocks, lines starting with `* ` or `- ` for bullets,
   * `<https://example.com|label>` for a link, `<users/{user}>` to @mention someone, and
   * `<users/all>` to mention everyone. Markdown such as `**bold**` or `[label](url)` is not
   * rendered. At most 32,000 bytes.
   *
   * Where `supportsThreads` is true, the message starts a new thread; call
   * `entry.message.getThread()` to continue it. The returned entry describes the new message,
   * with its temporary ID until it is committed.
   */
  post(text: string): Promise<ChatMessageEntry>;
}

/**
 * A session bound to one thread: its first message, its replies, and future replies. Call
 * `post()` to reply in it.
 */
export interface ChatThread extends RpcTarget {
  /**
   * Return the thread's ID, first message, and newest message. Throws if no messages you can
   * see remain in the thread.
   */
  getMetadata(): Promise<ChatThreadInfo>;

  /** Return the connected account's own Chat identity, the sender of anything posted here. */
  getCurrentUser(): Promise<ChatUser>;

  /** Return the thread's first message, or `null` if it was deleted or is hidden from you. */
  getRootMessage(): Promise<ChatMessageEntry | null>;

  /** List this thread's messages, oldest first unless `order` says otherwise. */
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;

  /**
   * Reply in this thread as the connected user. `text` uses the formatting described on
   * `ChatSpace.post()`. Fails rather than starting a new thread.
   */
  post(text: string): Promise<ChatMessageEntry>;
}

/**
 * Access to one message in a Google Chat conversation and to its thread, but not to the rest
 * of the conversation.
 */
export interface ChatMessage extends RpcTarget {
  /**
   * Return the message's current sender, text, mentions, timestamps, attachments, and reaction
   * counts. Throws if it has been deleted.
   */
  getMetadata(): Promise<ChatMessageInfo>;

  /**
   * Return this message's thread, with its current metadata. Throws where the conversation's
   * `supportsThreads` is false.
   */
  getThread(): Promise<ChatThreadEntry>;

  /**
   * Reply in this message's thread as the connected user. `text` uses the formatting described
   * on `ChatSpace.post()`. Throws where the conversation's `supportsThreads` is false; post a
   * new message with `ChatSpace.post()` there.
   */
  reply(text: string): Promise<ChatMessageEntry>;

  /**
   * Replace the text of one of your own messages, including one that is still pending. `text`
   * uses the formatting described on `ChatSpace.post()`. Throws for anyone else's message.
   */
  edit(text: string): Promise<void>;

  /** List the individual reactions to this message. A pending message has none. */
  listReactions(): Promise<Cursor<ChatReaction>>;

  /**
   * React to this message as the connected user with one Unicode emoji. Throws while the
   * message is still pending.
   */
  addReaction(emoji: string): Promise<void>;

  /** Remove the connected user's own reaction with this Unicode emoji. */
  removeReaction(emoji: string): Promise<void>;

  /**
   * Get one of this message's attachments by its `ChatAttachmentInfo.id`, for reading its
   * content. Throws if the message has no such attachment.
   */
  getAttachment(id: string): Promise<ChatAttachment>;
}

/** Read access to one file attached to a Chat message. */
export interface ChatAttachment extends RpcTarget {
  /** Return the attachment's filename, media type, source, and readability. */
  getMetadata(): Promise<ChatAttachmentInfo>;

  /**
   * Read the file's content.
   *
   * Check `ChatAttachmentInfo.readable` first: this throws for a Drive-linked attachment,
   * which must be read through a Google Drive connection instead, and for content above the
   * 25 MiB safe-read limit.
   */
  getContent(): Promise<ArrayBuffer>;
}
