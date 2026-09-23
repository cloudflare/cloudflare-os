/**
 * A pagination cursor.
 *
 * Call `next()` repeatedly on the same RPC object and dispose it when finished. Drain it until
 * `next()` returns `null`; an empty array means only that this call made no visible progress.
 */
export interface Cursor<T> {
  /** The next batch, `[]` when more work remains, or `null` once exhausted. */
  next(): Promise<T[] | null>;
}

// ── Users and spaces ────────────────────────────────────────────────

/** A person or Chat app visible to the connected Google account. */
export type GoogleChatUser = {
  /** Stable Chat resource name, such as `users/123456789`. */
  name: string;
  /**
   * Display name, when Google makes it visible to the connected user. Google omits it for some
   * users the connected account has no prior contact with.
   */
  displayName?: string;
  /** Whether this identity is a person or a Chat app. */
  type: "human" | "app";
};

/** The kind of Google Chat conversation. */
export type GoogleChatSpaceType = "space" | "groupChat" | "directMessage";

/** Metadata about a Google Chat space, group chat, or direct message. */
export type GoogleChatSpaceInfo = {
  /** Stable resource name, such as `spaces/AAAA1234`. */
  name: string;
  /** User-visible name. Direct messages and most group chats have none. */
  displayName?: string;
  /** Browser URL for opening the conversation, when Google returns one. */
  url?: string;
  /** Kind of conversation. */
  type: GoogleChatSpaceType;
  /** Description of a named space, when one is set. */
  description?: string;
  /** Guidelines of a named space, when they are set. */
  guidelines?: string;
  /** When the space was created, when Google returns it. */
  createTime?: Date;
  /** Time of the most recent activity, when Google returns it. */
  lastActiveTime?: Date;
  /** Number of people who have directly joined, when Google returns it. */
  memberCount?: number;
  /** Whether people outside the owning organization are permitted. */
  externalUsersAllowed?: boolean;
};

/** A listing result: space metadata plus a capability for that space. */
export type GoogleChatSpaceEntry = {
  /** Metadata for this result. */
  info: GoogleChatSpaceInfo;
  /** Capability for reading and acting in this conversation. */
  space: GoogleChatSpace;
};

/** Options for listing conversations. */
export type GoogleChatListSpacesOptions = {
  /** Limit results to these conversation types. Defaults to all of them. */
  types?: GoogleChatSpaceType[];
};

/** One user's membership in a space. */
export type GoogleChatMembership = {
  /** Stable membership resource name. */
  name: string;
  /** The member, when the membership refers to a user or Chat app rather than a Google Group. */
  member?: GoogleChatUser;
  /** Google Group resource name, when this membership refers to a group. */
  groupName?: string;
  /** Current membership state. */
  state: "joined" | "invited" | "notMember";
  /** The member's role in the space. */
  role: "member" | "manager";
  /** When the membership was created, when Google returns it. */
  createTime?: Date;
};

// ── Messages ────────────────────────────────────────────────────────

/** Metadata for a file attached to a Chat message. */
export type GoogleChatAttachmentInfo = {
  /** Stable attachment resource name. */
  name: string;
  /** Original filename. */
  filename: string;
  /** MIME media type, such as `application/pdf`. */
  mimeType: string;
  /** Whether the file was uploaded to Chat or linked from Google Drive. */
  source: "uploaded" | "drive";
  /** Google Drive file ID, present only for Drive-linked attachments. */
  driveFileId?: string;
  /** Whether `GoogleChatAttachment.getContent()` can read this file. */
  readable: boolean;
};

/** How many people reacted to a message with one emoji. */
export type GoogleChatReactionSummary = {
  /** Unicode emoji, or `:name:` for a custom emoji. */
  emoji: string;
  /** Number of reactions using this emoji. */
  count: number;
};

/** A Google Chat message. */
export type GoogleChatMessageInfo = {
  /**
   * Stable message resource name, such as `spaces/AAAA1234/messages/BBBB5678`.
   *
   * A message that has been submitted but not yet committed to Google Chat instead has a
   * temporary name of the form `pending:send:{n}` and sets `pending`.
   */
  name: string;
  /** Resource name of the containing space. */
  spaceName: string;
  /** Resource name of the containing thread, when the message is in one. */
  threadName?: string;
  /** Who sent the message. */
  sender?: GoogleChatUser;
  /** Plain-text body. Empty for a message whose content is unavailable. */
  text: string;
  /** Body with Chat's formatting markup, when Google returns it. */
  formattedText?: string;
  /** When the message was created. */
  createTime: Date;
  /** When the message was last edited, when Google returns it. */
  lastUpdateTime?: Date;
  /** Whether this message is a reply within a thread. */
  threadReply: boolean;
  /** Whether the message has been deleted. Deleted messages expose no text. */
  deleted: boolean;
  /** Files attached to the message. */
  attachments: GoogleChatAttachmentInfo[];
  /** Reaction counts, grouped by emoji. */
  reactions: GoogleChatReactionSummary[];
  /**
   * True for a message that has been submitted but is not yet committed to Google Chat. Such a
   * message has no real Chat resource name yet, so it cannot be replied to, edited, deleted,
   * reacted to, or pinned until it has been committed.
   */
  pending?: boolean;
};

/** A message result: metadata plus a capability for that message. */
export type GoogleChatMessageEntry = {
  /** Metadata for this result. */
  info: GoogleChatMessageInfo;
  /** Capability for reading or changing this message. */
  message: GoogleChatMessage;
};

/** Options for listing the messages of one conversation. */
export type GoogleChatListMessagesOptions = {
  /** Only return messages created after this time. */
  createdAfter?: Date;
  /** Only return messages created before this time. */
  createdBefore?: Date;
  /** Only return messages in this thread, named by `GoogleChatMessageInfo.threadName`. */
  threadName?: string;
  /** Include records of deleted messages. Their text is unavailable. */
  includeDeleted?: boolean;
  /** Result order. Defaults to oldest first. */
  order?: "oldestFirst" | "newestFirst";
};

/**
 * Structured filters for searching messages. Every supplied field must match.
 *
 * Google's message search omits some messages by design: private messages, messages posted by
 * Chat apps, messages in Chat app direct messages, messages from blocked users, and messages in
 * conversations the connected user has muted. Search reflects committed provider state and does
 * not simulate pending sends or edits. Use `GoogleChatSpace.listMessages()` when complete history
 * for one known conversation is required.
 */
export type GoogleChatMessageSearch = {
  /** Words or quoted phrases the message must contain. */
  text?: string;
  /** Limit results to these conversations, named by `GoogleChatSpaceInfo.name`. */
  spaceNames?: string[];
  /** Limit results to conversations whose display name contains this text. */
  spaceDisplayNameContains?: string;
  /** Limit results to these conversation types. */
  spaceTypes?: GoogleChatSpaceType[];
  /** Limit results to messages sent by these users, named `users/{user}` or by email address. */
  senders?: string[];
  /** Limit results to messages mentioning these users, named `users/{user}` or by email address. */
  mentions?: string[];
  /** Only return messages created at or after this time. */
  createdAfter?: Date;
  /** Only return messages created before this time. */
  createdBefore?: Date;
  /** Only return messages the connected user has not read. */
  unreadOnly?: boolean;
  /** Only return messages that have at least one attachment. */
  hasAttachment?: boolean;
  /** Only return messages whose text contains at least one link. */
  hasLink?: boolean;
};

/** A file to upload and attach to a new message. */
export type GoogleChatUpload = {
  /** Filename, including its extension. */
  filename: string;
  /** MIME media type of the content. */
  mimeType: string;
  /** File content. At most 8 MiB per file. */
  content: ArrayBuffer;
};

/** Options for sending a message or a threaded reply. */
export type GoogleChatSendOptions = {
  /** Files to upload and attach to the message. At most 5. */
  attachments?: GoogleChatUpload[];
};

/** One person's reaction to a message. */
export type GoogleChatReaction = {
  /** Stable reaction resource name. */
  name: string;
  /** Unicode emoji, or `:name:` for a custom emoji. */
  emoji: string;
  /** Who reacted, when Google returns it. */
  user?: GoogleChatUser;
};

// ── Notification settings ───────────────────────────────────────────

/** The connected user's notification behavior for one conversation. */
export type GoogleChatNotificationSettings = {
  /**
   * Which activity notifies the connected user.
   *
   * - `all`: @mentions, followed threads, and the first message of every new thread.
   * - `mainConversations`: the same, but new threads are not followed automatically.
   * - `forYou`: @mentions and followed threads only.
   * - `off`: nothing.
   *
   * `mainConversations` and `forYou` are unavailable in 1:1 direct messages.
   */
  level: "all" | "mainConversations" | "forYou" | "off";
  /** Whether the conversation is muted, which suppresses notifications regardless of `level`. */
  muted: boolean;
};

/** Notification fields to change. Omitted fields are left as they are. */
export type GoogleChatNotificationSettingsPatch = {
  /** Replacement notification level. */
  level?: GoogleChatNotificationSettings["level"];
  /** Whether to mute the conversation. */
  muted?: boolean;
};

// ── Recent activity ─────────────────────────────────────────────────

/** A category of recent activity in a conversation. */
export type GoogleChatSpaceEventType =
  | "messageCreated"
  | "messageUpdated"
  | "messageDeleted"
  | "reactionCreated"
  | "reactionDeleted"
  | "membershipCreated"
  | "membershipUpdated"
  | "membershipDeleted"
  | "spaceUpdated";

/**
 * One past event in a conversation.
 *
 * Each event carries the current state of the thing it refers to, not the state at the time of
 * the event. Google retains only the last 28 days of events.
 */
export type GoogleChatSpaceEvent = {
  /** Stable event resource name. */
  name: string;
  /** What happened. */
  type: GoogleChatSpaceEventType;
  /** When it happened. */
  eventTime: Date;
  /** Current state of the message, for the message event types. */
  message?: GoogleChatMessageInfo;
  /** Current state of the reaction, for the reaction event types. */
  reaction?: GoogleChatReaction;
  /** Current state of the membership, for the membership event types. */
  membership?: GoogleChatMembership;
  /** Current state of the space, for `spaceUpdated`. */
  space?: GoogleChatSpaceInfo;
};

/** Options for listing recent activity. */
export type GoogleChatListEventsOptions = {
  /** Event categories to return. At least one is required. */
  types: GoogleChatSpaceEventType[];
  /** Exclusive start time. Must be within the last 28 days. Defaults to 28 days ago. */
  startTime?: Date;
  /** Inclusive end time. Defaults to now. */
  endTime?: Date;
};

// ── Capability interfaces ───────────────────────────────────────────
// These are RPC stubs — all methods are async. Capabilities can be passed across Worker
// boundaries and retain their access rights.

/**
 * Google Chat access for the connected account.
 *
 * Use this to find conversations and search across them, then use the `GoogleChatSpace`
 * capabilities it returns to read and act inside one conversation.
 */
export interface GoogleChatSession {
  /** Return the connected account's own Chat identity. */
  getCurrentUser(): Promise<GoogleChatUser>;

  /**
   * List conversations the connected user has joined.
   *
   * Group chats and direct messages appear only once they contain a message.
   */
  listSpaces(options?: GoogleChatListSpacesOptions): Promise<Cursor<GoogleChatSpaceEntry>>;

  /**
   * Find joined named spaces whose display name matches `displayName`.
   *
   * The text is matched token by token, case-insensitively, against any part of the name, so
   * `proj rev` matches "Project review". Group chats and direct messages have no display name
   * and are never returned; use {@link listSpaces}, {@link findDirectMessage}, or
   * {@link findGroupChats} for those.
   */
  searchSpaces(displayName: string): Promise<Cursor<GoogleChatSpaceEntry>>;

  /**
   * Open the existing direct message between the connected user and `user`, named
   * `users/{user}` or by email address. Returns `null` when no direct message exists.
   */
  findDirectMessage(user: string): Promise<GoogleChatSpace | null>;

  /**
   * Find group chats whose joined members are exactly the connected user plus `users`, each
   * named `users/{user}` or by email address. At most 49 users.
   */
  findGroupChats(users: string[]): Promise<Cursor<GoogleChatSpaceEntry>>;

  /**
   * Open a conversation by its stable `spaces/{space}` resource name.
   *
   * Throws when the connected user cannot access it.
   */
  openSpace(name: string): Promise<GoogleChatSpace>;

  /**
   * Search messages across the conversations available to the connected user.
   *
   * See {@link GoogleChatMessageSearch} for the messages Google's search leaves out.
   */
  searchMessages(query: GoogleChatMessageSearch): Promise<Cursor<GoogleChatMessageEntry>>;
}

/** Access to one Google Chat space, group chat, or direct message. */
export interface GoogleChatSpace {
  /** Return current metadata about this conversation. */
  getMetadata(): Promise<GoogleChatSpaceInfo>;

  /** List messages in this conversation, oldest first unless `order` says otherwise. */
  listMessages(
    options?: GoogleChatListMessagesOptions,
  ): Promise<Cursor<GoogleChatMessageEntry>>;

  /** Open one message in this conversation by its stable resource name. */
  getMessage(name: string): Promise<GoogleChatMessage>;

  /** List the people, Google Groups, and Chat apps in this conversation. */
  listMembers(): Promise<Cursor<GoogleChatMembership>>;

  /**
   * Look up one member by `users/{user}` resource name or email address. Returns `null` when
   * that user is not a member.
   */
  findMember(user: string): Promise<GoogleChatMembership | null>;

  /**
   * Send a plain-text message to this conversation as the connected user.
   *
   * Chat attributes the message to the user, not to an app. Formatting markup in `text` is
   * rendered by Chat. The message, including any attachments, must be under 32,000 bytes of
   * text; attachments are limited to 8 MiB each and 5 per message.
   */
  sendMessage(text: string, options?: GoogleChatSendOptions): Promise<GoogleChatMessage>;

  /** List the messages currently pinned in this conversation. */
  listPinnedMessages(): Promise<Cursor<GoogleChatMessageEntry>>;

  /** Change the connected user's notification or mute settings for this conversation. */
  updateNotificationSettings(patch: GoogleChatNotificationSettingsPatch): Promise<void>;

  /** List recent activity Google still retains for this conversation. */
  listEvents(options: GoogleChatListEventsOptions): Promise<Cursor<GoogleChatSpaceEvent>>;

  /**
   * Remove the connected user from this conversation.
   *
   * This only ever removes the connected user; it cannot remove anyone else or change another
   * member's role.
   */
  leave(): Promise<void>;
}

/** Access to one message in a Google Chat conversation. */
export interface GoogleChatMessage {
  /** Return the message's current sender, text, timestamps, attachments, and reaction counts. */
  getMetadata(): Promise<GoogleChatMessageInfo>;

  /** Open the conversation containing this message. */
  space(): Promise<GoogleChatSpace>;

  /**
   * Reply in this message's thread as the connected user.
   *
   * Direct messages and group chats are not threaded, so replying there fails; send a new
   * message with `GoogleChatSpace.sendMessage()` instead.
   */
  reply(text: string, options?: GoogleChatSendOptions): Promise<GoogleChatMessage>;

  /**
   * Replace the text of this message.
   *
   * Google permits this only for messages the connected user may edit, which in practice means
   * their own; it fails otherwise.
   */
  updateText(text: string): Promise<void>;

  /**
   * Delete this message.
   *
   * Google permits this only for messages the connected user may delete, which means their own
   * messages, or any message when they manage the space; it fails otherwise. Threaded replies to
   * a deleted message are deleted with it.
   */
  delete(): Promise<void>;

  /** List the individual reactions to this message. */
  listReactions(): Promise<Cursor<GoogleChatReaction>>;

  /** React to this message as the connected user with one Unicode emoji. */
  addReaction(emoji: string): Promise<void>;

  /** Remove the connected user's own reaction with this Unicode emoji. */
  removeReaction(emoji: string): Promise<void>;

  /** List this message's attachments with capabilities for reading their content. */
  attachments(): Promise<GoogleChatAttachmentEntry[]>;

  /** Pin this message in its conversation. */
  pin(): Promise<void>;

  /** Remove this message's pin from its conversation. */
  unpin(): Promise<void>;
}

/** An attachment result: metadata plus a capability for reading its content. */
export type GoogleChatAttachmentEntry = {
  /** Metadata for this attachment. */
  info: GoogleChatAttachmentInfo;
  /** Capability for reading this attachment's content. */
  attachment: GoogleChatAttachment;
};

/** Read access to one file attached to a Chat message. */
export interface GoogleChatAttachment {
  /** Return the attachment's filename, media type, source, and readability. */
  getMetadata(): Promise<GoogleChatAttachmentInfo>;

  /**
   * Read the file's content.
   *
   * Check `GoogleChatAttachmentInfo.readable` first: this throws for a Drive-linked attachment,
   * which must be read through a Google Drive connection instead, and for content above the
   * 25 MiB safe-read limit.
   */
  getContent(): Promise<ArrayBuffer>;
}
