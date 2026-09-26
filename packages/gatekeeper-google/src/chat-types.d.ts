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
  /** Stable opaque identity for joins and API calls. Prefer name for display when available. */
  id: string;
  /**
   * Display name supplied by Google Chat when visible to the connected account. May be omitted.
   */
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
   * Space name, or the other participant's name for a DM when available. Listings may omit DM
   * names; call that entry's space.getMetadata() when you need a human-readable DM label.
   */
  name?: string;
  /** Browser URL for opening the conversation, when Google returns one. */
  url?: string;
  /** Kind of conversation. */
  type: ChatSpaceType;
  /** Whether this conversation supports thread discovery and threaded replies. */
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
  /** Metadata for this result. For an unnamed DM, space.getMetadata() can resolve its participant's name. */
  info: ChatSpaceInfo;
  /** Capability for reading and acting in this conversation. */
  space: ChatSpace;
};

/** Options for listing conversations. */
export type ChatListSpacesOptions = {
  /** Limit results to these conversation types. Defaults to all of them. */
  types?: ChatSpaceType[];
};

/** One user's membership in a space. */
export type ChatMembership = {
  /** Opaque membership ID. */
  id: string;
  /** The member, when the membership refers to a user or Chat app rather than a Google Group. */
  member?: ChatUser;
  /** Google Group ID, when this membership refers to a group. */
  groupId?: string;
  /** Current membership state. */
  state: "joined" | "invited" | "notMember";
  /** The member's role in the space. */
  role: "member" | "manager";
};

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
   * A message that has been submitted but not yet committed to Google Chat instead has a
   * temporary ID of the form `pending:send:{n}` and sets `pending`.
   */
  id: string;
  /** ID of the containing conversation. */
  spaceId: string;
  /**
   * Containing thread ID. Chat assigns one to every message, but it only means something in a
   * conversation whose `supportsThreads` is true; ignore it elsewhere. A newly posted root uses
   * a temporary pending:thread:{n} ID.
   */
  threadId?: string;
  /** Who sent the message. */
  sender?: ChatUser;
  /** Plain-text body. Empty for a message whose content is unavailable. */
  text: string;
  /** Body with Chat's formatting markup, when Google returns it. */
  formattedText?: string;
  /** When the message was created. */
  createdAt: Date;
  /** When the message was last edited, when Google returns it. */
  editedAt?: Date;
  /** Whether this message is a reply within a thread. */
  isReply: boolean;
  /** Whether the message has been deleted. Deleted messages expose no text. */
  deleted: boolean;
  /** Files attached to the message. */
  attachments: ChatAttachmentInfo[];
  /** Reaction counts, grouped by emoji. */
  reactions: ChatReactionSummary[];
  /**
   * True for a message that has been submitted but is not yet committed to Google Chat. Such a
   * message's `createdAt` is provisional: the committed message carries the timestamp Google
   * assigns at commit. Replies and edits can be queued immediately; reactions require the post
   * to complete. Its capability and temporary ID remain usable after posting completes.
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

/** A creation-time window including since and excluding before. Times use millisecond precision. */
export type ChatWindow = {
  /** Include messages created at or after this time. */
  since?: Date;
  /** Include messages created before this time. */
  before?: Date;
};

/** Options for conversation or thread history. Deleted and private messages are omitted. */
export type ChatListMessagesOptions = ChatWindow & {
  /** Result order. Defaults to oldest first. */
  order?: "oldestFirst" | "newestFirst";
};

/**
 * Structured filters for searching messages within one conversation. Every supplied field must
 * match.
 *
 * Google's message search omits some messages by design: private messages, messages posted by
 * Chat apps, messages in Chat app direct messages, messages from blocked users, and messages in
 * conversations the connected user has muted. Search reflects committed provider state — it does
 * not simulate pending sends or edits, and its index can lag recent edits and deletions by
 * minutes. Use `ChatSpace.listMessages()` when complete, current history for one known
 * conversation is required.
 */
export type ChatSpaceMessageSearch = ChatWindow & {
  /** Words or quoted phrases the message must contain. */
  text?: string;
  /** Limit results to messages sent by these users, named `users/{user}` or by email address. */
  senders?: string[];
  /** Limit results to messages mentioning these users, named `users/{user}` or by email address. */
  mentions?: string[];
  /** Only return messages the connected user has not read. */
  unreadOnly?: boolean;
  /** Only return messages that have at least one attachment. */
  hasAttachment?: boolean;
  /** Only return messages whose text contains at least one link. */
  hasLink?: boolean;
};

/** Filters for searching across conversations, adding conversation selectors. */
export type ChatMessageSearch = ChatSpaceMessageSearch & {
  /** Limit results to these conversations, identified by `ChatSpaceInfo.id`. */
  spaceIds?: string[];
  /** Limit results to conversations whose display name contains this text. */
  spaceNameContains?: string;
  /** Limit results to these conversation types. */
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

/** A thread snapshot: a top-level message together with zero or more replies. */
export type ChatThreadInfo = {
  /** Canonical spaces/{space}/threads/{thread}, or pending:thread:{n} for a new root. */
  id: string;
  /** ID of the containing conversation; this alone confers no access to it. */
  spaceId: string;
  /** Newest visible message; in discovery results, the newest within the listing's window. */
  latestMessage: ChatMessageInfo;
  /**
   * Root content when it was available in the page already read. Omission does not mean the
   * root is missing; use getRootMessage() when it is needed explicitly.
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
 * Google Chat access for the connected account.
 *
 * Use this to find conversations and search across them, then use the `ChatSpace`
 * capabilities it returns to read and act inside one conversation.
 */
export interface GoogleChatSession extends RpcTarget {
  /** Return the connected account's own Chat identity. */
  getCurrentUser(): Promise<ChatUser>;

  /**
   * List conversations the connected user has joined.
   *
   * Group chats and direct messages appear only once they contain a message.
   * DM participant names are not resolved by this listing. If info.type is "directMessage"
   * and info.name is absent, call entry.space.getMetadata() when you need its display name.
   */
  listSpaces(options?: ChatListSpacesOptions): Promise<Cursor<ChatSpaceEntry>>;

  /**
   * Find joined named spaces whose display name matches `name`.
   *
   * The text is matched loosely: token by token, case-insensitively, against any part of the
   * name, so `proj rev` matches "Project review" — and partial tokens can match inside words.
   * Group chats and direct messages have no display name and are never returned; use
   * {@link listSpaces} or {@link findDirectMessage} for those.
   */
  searchSpaces(name: string): Promise<Cursor<ChatSpaceEntry>>;

  /**
   * Open the existing direct message between the connected user and `user`, named
   * `users/{user}` or by email address. Returns `null` when no direct message exists or the
   * user cannot be found. The entry's info omits the DM name; see {@link ChatSpaceEntry}.
   */
  findDirectMessage(user: string): Promise<ChatSpaceEntry | null>;

  /**
   * Get a conversation by its opaque ID, such as `spaces/{space}`, with its current metadata.
   *
   * Throws when the connected user cannot access it.
   */
  getSpace(id: string): Promise<ChatSpaceEntry>;

  /**
   * Search messages across the conversations available to the connected user.
   *
   * See {@link ChatMessageSearch} for the messages Google's search leaves out.
   */
  searchMessages(query: ChatMessageSearch): Promise<Cursor<ChatMessageEntry>>;
}

/** Access to one Google Chat space, group chat, or direct message. */
export interface ChatSpace extends RpcTarget {
  /**
   * Return current metadata. For an unnamed DM, resolve the other participant's display name
   * on demand. Call this when a listing omits a DM name and you need a human-readable label.
   * If the name is unavailable, name remains absent; use the conversation ID as a fallback.
   */
  getMetadata(): Promise<ChatSpaceInfo>;

  /** Return the connected account's own Chat identity, the sender of anything posted here. */
  getCurrentUser(): Promise<ChatUser>;

  /** List messages in this conversation, oldest first unless `order` says otherwise. */
  listMessages(
    options?: ChatListMessagesOptions,
  ): Promise<Cursor<ChatMessageEntry>>;

  /**
   * Search messages in this conversation, newest first.
   *
   * See {@link ChatSpaceMessageSearch} for the messages Google's search leaves out.
   */
  searchMessages(query: ChatSpaceMessageSearch): Promise<Cursor<ChatMessageEntry>>;

  /**
   * List threads with messages posted within the window, newest matching message first.
   * Includes zero-reply roots and older threads with new replies; each thread appears once.
   * Pending sends appear ahead of committed history, with provisional timestamps.
   * Edits and reactions do not count as new messages. Throws when supportsThreads is false;
   * use listMessages() there. At most 5,000 threads per cursor; use a narrower window if that
   * limit is reached.
   */
  listThreads(window?: ChatWindow): Promise<Cursor<ChatThreadEntry>>;

  /**
   * Get an accessible thread in this conversation by its canonical or temporary ID, with its
   * current metadata. Throws if the thread is unavailable or belongs to another conversation.
   */
  getThread(id: string): Promise<ChatThreadEntry>;

  /**
   * Get a message by its ID, with its current metadata. Throws if unavailable or outside this
   * conversation.
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
   * Post a top-level text message to this conversation as the connected user.
   *
   * Chat attributes the message to the user, not to an app. Formatting markup in `text` is
   * rendered by Chat. The message must be at most 32,000 bytes of text. The returned entry
   * describes the new message, including its temporary ID until it is committed.
   */
  post(text: string): Promise<ChatMessageEntry>;

  /**
   * Post a root message and return its thread, ready for reading and further posts.
   * Throws without posting if this conversation does not support threads.
   */
  startThread(text: string): Promise<ChatThreadEntry>;
}

/** Access to one thread's root and replies, including future replies, without the parent space. */
export interface ChatThread extends RpcTarget {
  /**
   * Return current identity and latest-message metadata, with root content when cheaply
   * available. Throws if no visible messages remain in the thread.
   */
  getMetadata(): Promise<ChatThreadInfo>;

  /** Return the root message, or null if it is unavailable. Never substitutes a surviving reply. */
  getRootMessage(): Promise<ChatMessageEntry | null>;

  /** List only this thread's messages, oldest first unless order says otherwise. */
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;

  /** Post in this thread as the connected user. Fails rather than starting a new thread. */
  post(text: string): Promise<ChatMessageEntry>;
}

/**
 * Access to one message in a Google Chat conversation. A capability obtained through a thread
 * remains restricted to that thread, including its replies and attachment capabilities.
 */
export interface ChatMessage extends RpcTarget {
  /** Return the message's current sender, text, timestamps, attachments, and reaction counts. */
  getMetadata(): Promise<ChatMessageInfo>;

  /**
   * Reply in this message's thread as the connected user.
   *
   * Direct messages and group chats are not threaded, so replying there fails; send a new
   * message with `ChatSpace.post()` instead. This does not grant read access to siblings.
   */
  reply(text: string): Promise<ChatMessageEntry>;

  /**
   * Replace the text of this message.
   *
   * Google permits this only for messages the connected user may edit, which in practice means
   * their own; it fails otherwise. Also works immediately on a newly posted message.
   */
  edit(text: string): Promise<void>;

  /** List the individual reactions to this message. */
  listReactions(): Promise<Cursor<ChatReaction>>;

  /** React to this message as the connected user with one Unicode emoji. */
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
