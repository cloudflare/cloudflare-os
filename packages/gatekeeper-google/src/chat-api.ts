// Google Chat REST client for the user-authenticated Chat gatekeeper.
//
// Everything here is called with the connected user's own OAuth token. The Chat API also has an
// "app authentication" mode (the `chat.bot` scope and its `chat.app.*` siblings) in which calls
// are attributed to a configured Chat app rather than to a person; this gatekeeper deliberately
// implements none of it, and the two REST methods that require it -- `messages.replaceCards` and
// `messages.attachments.get` -- are therefore absent. Attachment metadata comes from the message
// resource instead, which user auth does return.
//
// Admin surfaces are absent for the same reason: no `useAdminAccess`, no `chat.admin.*` scope, no
// domain-wide delegation, and no import mode. A caller can only ever reach what the connected
// user could reach in the Chat UI.

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import type {
  GoogleChatAttachmentInfo, GoogleChatMembership, GoogleChatMessageInfo,
  GoogleChatNotificationSettings, GoogleChatNotificationSettingsPatch, GoogleChatReaction,
  GoogleChatSpaceEvent, GoogleChatSpaceEventType, GoogleChatSpaceInfo,
  GoogleChatSpaceType, GoogleChatMessageSearch, GoogleChatListMessagesOptions,
  GoogleChatListEventsOptions, GoogleChatUser,
} from "./chat-types";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";

/** Largest attachment this gatekeeper will upload on the caller's behalf. */
export const MAX_CHAT_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Attachments one message may carry through this gatekeeper. */
export const MAX_CHAT_UPLOADS_PER_MESSAGE = 5;
/** Largest attachment body this gatekeeper will read back into memory. */
export const MAX_CHAT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Chat's own documented message size ceiling. */
export const MAX_CHAT_MESSAGE_BYTES = 32_000;
/** Days of history `spaceEvents.list` retains, per Google's documentation. */
export const CHAT_EVENT_RETENTION_DAYS = 28;

/** A status-only provider error, safe to log and to base retry decisions on. */
export class ChatApiError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(`Google Chat API ${operation} failed [http=${status}]`);
  }
}

async function chatApiFailure(operation: string, response: Response): Promise<never> {
  // Chat error prose can quote message text and filter values, so only the status travels.
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; the status is what matters.
  }
  throw new ChatApiError(response.status, operation);
}

/** A deliberately omitted app-authored message with a viewer narrower than its space. */
class PrivateChatMessageError extends Error {
  constructor() {
    super("This Google Chat message is not available through this connection.");
  }
}

/** Whether an error means "this identity cannot see that", rather than a transient failure. */
export function isChatNoAccessError(error: unknown): boolean {
  return error instanceof PrivateChatMessageError ||
    (error instanceof ChatApiError &&
      (error.status === 401 || error.status === 403 || error.status === 404));
}

// ── Identifier validation ───────────────────────────────────────────
//
// Every id below is interpolated into a request path or a filter string, so each one is checked
// against the shape Google documents before it goes anywhere near a URL.

const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const THREAD_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const REACTION_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const USER_ID_RE = /^[A-Za-z0-9_.@+-]{1,320}$/;
const MEDIA_RESOURCE_RE = /^[A-Za-z0-9_./=+-]{1,1024}$/;

/** Validate a bare space id (the `AAAA1234` of `spaces/AAAA1234`). */
export function validateChatSpaceId(spaceId: string): string {
  if (!SPACE_ID_RE.test(spaceId)) throw new Error("Invalid Google Chat space ID.");
  return spaceId;
}

/** Split `spaces/{space}` into its id, rejecting anything else. */
export function chatSpaceId(spaceName: string): string {
  const match = /^spaces\/([^/]+)$/.exec(spaceName);
  if (!match) throw new Error("Expected a space resource name of the form spaces/{space}.");
  return validateChatSpaceId(match[1]);
}

/** Split `spaces/{space}/messages/{message}` into its parts, rejecting anything else. */
export function chatMessageParts(messageName: string): { spaceId: string; messageId: string } {
  const match = /^spaces\/([^/]+)\/messages\/([^/]+)$/.exec(messageName);
  if (!match) {
    throw new Error(
      "Expected a message resource name of the form spaces/{space}/messages/{message}.");
  }
  const messageId = match[2];
  if (!MESSAGE_ID_RE.test(messageId)) throw new Error("Invalid Google Chat message ID.");
  return { spaceId: validateChatSpaceId(match[1]), messageId };
}

/** Split `spaces/{space}/threads/{thread}` into its parts, rejecting anything else. */
export function chatThreadParts(threadName: string): { spaceId: string; threadId: string } {
  const match = /^spaces\/([^/]+)\/threads\/([^/]+)$/.exec(threadName);
  if (!match) {
    throw new Error("Expected a thread resource name of the form spaces/{space}/threads/{thread}.");
  }
  const threadId = match[2];
  if (!THREAD_ID_RE.test(threadId)) throw new Error("Invalid Google Chat thread ID.");
  return { spaceId: validateChatSpaceId(match[1]), threadId };
}

/** Split a thread name and require it to belong to `spaceName`. */
export function chatThreadPartsInSpace(
  spaceName: string,
  threadName: string,
): { spaceId: string; threadId: string } {
  const expectedSpaceId = chatSpaceId(spaceName);
  const parts = chatThreadParts(threadName);
  if (parts.spaceId !== expectedSpaceId) {
    throw new Error("That thread belongs to a different Google Chat conversation.");
  }
  return parts;
}

/** Split `spaces/{space}/messages/{message}/reactions/{reaction}`, rejecting anything else. */
export function chatReactionParts(
  reactionName: string,
): { spaceId: string; messageId: string; reactionId: string } {
  const match = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions\/([^/]+)$/.exec(reactionName);
  if (!match) throw new Error("Invalid Google Chat reaction resource name.");
  if (!REACTION_ID_RE.test(match[2])) throw new Error("Invalid Google Chat reaction ID.");
  return { ...chatMessageParts(match[1]), reactionId: match[2] };
}

/**
 * Normalize a caller-supplied user reference to `users/{user}`.
 *
 * Chat accepts either a People API id or an email address in the `{user}` position, so both are
 * allowed through; anything with a slash or a character outside that alphabet is not.
 */
export function chatUserName(user: string): string {
  const bare = user.startsWith("users/") ? user.slice("users/".length) : user;
  if (!USER_ID_RE.test(bare)) throw new Error("Invalid Google Chat user reference.");
  return `users/${bare}`;
}

/**
 * Validate a Unicode emoji for a reaction.
 *
 * Chat's reaction API takes either a Unicode emoji or a custom-emoji resource; this gatekeeper
 * only offers the Unicode form, so `:shortcode:` input is rejected rather than silently sent as
 * text that Chat would not recognize.
 */
export function validateChatEmoji(emoji: string): string {
  if (emoji.startsWith(":") && emoji.endsWith(":")) {
    throw new Error("Only Unicode emoji are supported; custom emoji shortcodes are not.");
  }
  // oxlint-disable-next-line no-control-regex -- reactions are interpolated into filter strings
  if (!emoji || emoji.length > 16 || /[\s"\\\x00-\x1f\x7f]/.test(emoji)) {
    throw new Error("Invalid reaction emoji.");
  }
  return emoji;
}

// ── Raw provider shapes ─────────────────────────────────────────────

export type ChatUserRaw = {
  name?: string;
  displayName?: string;
  type?: string;
};

export type ChatSpaceRaw = {
  name?: string;
  displayName?: string;
  spaceType?: string;
  spaceUri?: string;
  spaceDetails?: { description?: string; guidelines?: string };
  createTime?: string;
  lastActiveTime?: string;
  membershipCount?: { joinedDirectHumanUserCount?: number };
  externalUserAllowed?: boolean;
};

export type ChatEmojiRaw = {
  unicode?: string;
  customEmoji?: { uid?: string; emojiName?: string };
};

export type ChatAttachmentRaw = {
  name?: string;
  contentName?: string;
  contentType?: string;
  source?: string;
  attachmentDataRef?: { resourceName?: string; attachmentUploadToken?: string };
  driveDataRef?: { driveFileId?: string };
};

export type ChatMessageRaw = {
  name?: string;
  sender?: ChatUserRaw;
  createTime?: string;
  lastUpdateTime?: string;
  deleteTime?: string;
  text?: string;
  formattedText?: string;
  thread?: { name?: string };
  space?: { name?: string };
  attachment?: ChatAttachmentRaw[];
  emojiReactionSummaries?: { emoji?: ChatEmojiRaw; reactionCount?: number }[];
  threadReply?: boolean;
  deletionMetadata?: { deletionType?: string };
  /** Set only for an app-authored message visible to one user in an otherwise shared space. */
  privateMessageViewer?: ChatUserRaw;
};

export type ChatMembershipRaw = {
  name?: string;
  state?: string;
  role?: string;
  member?: ChatUserRaw;
  groupMember?: { name?: string };
  createTime?: string;
};

export type ChatReactionRaw = {
  name?: string;
  user?: ChatUserRaw;
  emoji?: ChatEmojiRaw;
};

export type ChatMessagePinRaw = { name?: string; message?: string };

export type ChatSpaceEventRaw = {
  name?: string;
  eventTime?: string;
  eventType?: string;
  messageCreatedEventData?: { message?: ChatMessageRaw };
  messageUpdatedEventData?: { message?: ChatMessageRaw };
  messageDeletedEventData?: { message?: ChatMessageRaw };
  messageBatchCreatedEventData?: { messages?: { message?: ChatMessageRaw }[] };
  messageBatchUpdatedEventData?: { messages?: { message?: ChatMessageRaw }[] };
  messageBatchDeletedEventData?: { messages?: { message?: ChatMessageRaw }[] };
  reactionCreatedEventData?: { reaction?: ChatReactionRaw };
  reactionDeletedEventData?: { reaction?: ChatReactionRaw };
  reactionBatchCreatedEventData?: { reactions?: { reaction?: ChatReactionRaw }[] };
  reactionBatchDeletedEventData?: { reactions?: { reaction?: ChatReactionRaw }[] };
  membershipCreatedEventData?: { membership?: ChatMembershipRaw };
  membershipUpdatedEventData?: { membership?: ChatMembershipRaw };
  membershipDeletedEventData?: { membership?: ChatMembershipRaw };
  membershipBatchCreatedEventData?: { memberships?: { membership?: ChatMembershipRaw }[] };
  membershipBatchUpdatedEventData?: { memberships?: { membership?: ChatMembershipRaw }[] };
  membershipBatchDeletedEventData?: { memberships?: { membership?: ChatMembershipRaw }[] };
  spaceUpdatedEventData?: { space?: ChatSpaceRaw };
  spaceBatchUpdatedEventData?: { spaces?: { space?: ChatSpaceRaw }[] };
};

/** One page of results plus the provider's continuation token. */
export type ChatPage<T> = { items: T[]; nextPageToken?: string };

// ── Mapping to the agent-facing shapes ──────────────────────────────

function chatTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

const SPACE_TYPES: Record<string, GoogleChatSpaceType> = {
  SPACE: "space",
  GROUP_CHAT: "groupChat",
  DIRECT_MESSAGE: "directMessage",
};

const SPACE_TYPE_ENUMS: Record<GoogleChatSpaceType, string> = {
  space: "SPACE",
  groupChat: "GROUP_CHAT",
  directMessage: "DIRECT_MESSAGE",
};

export function chatUserFromRaw(raw: ChatUserRaw | undefined): GoogleChatUser | undefined {
  if (!raw?.name) return undefined;
  return {
    name: raw.name,
    ...(raw.displayName ? { displayName: raw.displayName } : {}),
    type: raw.type === "BOT" ? "app" : "human",
  };
}

export function chatSpaceInfoFromRaw(raw: ChatSpaceRaw): GoogleChatSpaceInfo {
  if (!raw.name) throw new Error("Google Chat returned a space with no resource name.");
  const createTime = chatTime(raw.createTime);
  const lastActiveTime = chatTime(raw.lastActiveTime);
  const memberCount = raw.membershipCount?.joinedDirectHumanUserCount;
  return {
    name: raw.name,
    ...(raw.displayName ? { displayName: raw.displayName } : {}),
    ...(raw.spaceUri ? { url: raw.spaceUri } : {}),
    type: SPACE_TYPES[raw.spaceType ?? ""] ?? "space",
    ...(raw.spaceDetails?.description ? { description: raw.spaceDetails.description } : {}),
    ...(raw.spaceDetails?.guidelines ? { guidelines: raw.spaceDetails.guidelines } : {}),
    ...(createTime ? { createTime } : {}),
    ...(lastActiveTime ? { lastActiveTime } : {}),
    ...(typeof memberCount === "number" ? { memberCount } : {}),
    ...(raw.externalUserAllowed !== undefined
      ? { externalUsersAllowed: raw.externalUserAllowed }
      : {}),
  };
}

function chatEmojiFromRaw(raw: ChatEmojiRaw | undefined): string {
  if (raw?.unicode) return raw.unicode;
  const custom = raw?.customEmoji;
  if (custom?.emojiName) return custom.emojiName;
  if (custom?.uid) return `:${custom.uid}:`;
  return "";
}

export function chatAttachmentInfoFromRaw(raw: ChatAttachmentRaw): GoogleChatAttachmentInfo {
  const source = raw.source === "DRIVE_FILE" ? "drive" as const : "uploaded" as const;
  const resourceName = raw.attachmentDataRef?.resourceName;
  return {
    name: raw.name ?? "",
    filename: raw.contentName ?? "",
    mimeType: raw.contentType ?? "application/octet-stream",
    source,
    ...(raw.driveDataRef?.driveFileId ? { driveFileId: raw.driveDataRef.driveFileId } : {}),
    readable: source === "uploaded" && !!resourceName,
  };
}

/** The media resource name used to download one uploaded attachment, when it has one. */
export function chatAttachmentMediaName(raw: ChatAttachmentRaw): string | undefined {
  return raw.source === "DRIVE_FILE" ? undefined : raw.attachmentDataRef?.resourceName;
}

export function chatMessageInfoFromRaw(raw: ChatMessageRaw): GoogleChatMessageInfo {
  // App-authored private messages have a message-level ACL narrower than their containing space.
  // This user-authenticated integration deliberately omits them everywhere rather than exposing
  // owner-only content through a shareable space capability.
  if (raw.privateMessageViewer !== undefined) throw new PrivateChatMessageError();
  if (!raw.name) throw new Error("Google Chat returned a message with no resource name.");
  const { spaceId } = chatMessageParts(raw.name);
  const createTime = chatTime(raw.createTime);
  const lastUpdateTime = chatTime(raw.lastUpdateTime);
  const sender = chatUserFromRaw(raw.sender);
  return {
    name: raw.name,
    spaceName: raw.space?.name ?? `spaces/${spaceId}`,
    ...(raw.thread?.name ? { threadName: raw.thread.name } : {}),
    ...(sender ? { sender } : {}),
    text: raw.text ?? "",
    ...(raw.formattedText ? { formattedText: raw.formattedText } : {}),
    createTime: createTime ?? new Date(0),
    ...(lastUpdateTime ? { lastUpdateTime } : {}),
    threadReply: raw.threadReply === true,
    deleted: raw.deleteTime !== undefined || raw.deletionMetadata !== undefined,
    attachments: (raw.attachment ?? []).map(chatAttachmentInfoFromRaw),
    reactions: (raw.emojiReactionSummaries ?? []).map(summary => ({
      emoji: chatEmojiFromRaw(summary.emoji),
      count: summary.reactionCount ?? 0,
    })),
  };
}

export function chatMembershipFromRaw(raw: ChatMembershipRaw): GoogleChatMembership {
  if (!raw.name) throw new Error("Google Chat returned a membership with no resource name.");
  const member = chatUserFromRaw(raw.member);
  const createTime = chatTime(raw.createTime);
  const state = raw.state === "INVITED"
    ? "invited" as const
    : raw.state === "NOT_A_MEMBER" ? "notMember" as const : "joined" as const;
  return {
    name: raw.name,
    ...(member ? { member } : {}),
    ...(raw.groupMember?.name ? { groupName: raw.groupMember.name } : {}),
    state,
    role: raw.role === "ROLE_MANAGER" ? "manager" : "member",
    ...(createTime ? { createTime } : {}),
  };
}

export function chatReactionFromRaw(raw: ChatReactionRaw): GoogleChatReaction {
  if (!raw.name) throw new Error("Google Chat returned a reaction with no resource name.");
  const user = chatUserFromRaw(raw.user);
  return {
    name: raw.name,
    emoji: chatEmojiFromRaw(raw.emoji),
    ...(user ? { user } : {}),
  };
}

const NOTIFICATION_LEVELS: Record<string, GoogleChatNotificationSettings["level"]> = {
  ALL: "all",
  MAIN_CONVERSATIONS: "mainConversations",
  FOR_YOU: "forYou",
  OFF: "off",
};

const NOTIFICATION_LEVEL_ENUMS: Record<GoogleChatNotificationSettings["level"], string> = {
  all: "ALL",
  mainConversations: "MAIN_CONVERSATIONS",
  forYou: "FOR_YOU",
  off: "OFF",
};

export function chatNotificationSettingsFromRaw(
  raw: { notificationSetting?: string; muteSetting?: string },
): GoogleChatNotificationSettings {
  return {
    level: NOTIFICATION_LEVELS[raw.notificationSetting ?? ""] ?? "all",
    muted: raw.muteSetting === "MUTED",
  };
}

const EVENT_TYPES: Record<string, GoogleChatSpaceEventType> = {
  "google.workspace.chat.message.v1.created": "messageCreated",
  "google.workspace.chat.message.v1.updated": "messageUpdated",
  "google.workspace.chat.message.v1.deleted": "messageDeleted",
  "google.workspace.chat.message.v1.batchCreated": "messageCreated",
  "google.workspace.chat.message.v1.batchUpdated": "messageUpdated",
  "google.workspace.chat.message.v1.batchDeleted": "messageDeleted",
  "google.workspace.chat.reaction.v1.created": "reactionCreated",
  "google.workspace.chat.reaction.v1.deleted": "reactionDeleted",
  "google.workspace.chat.reaction.v1.batchCreated": "reactionCreated",
  "google.workspace.chat.reaction.v1.batchDeleted": "reactionDeleted",
  "google.workspace.chat.membership.v1.created": "membershipCreated",
  "google.workspace.chat.membership.v1.updated": "membershipUpdated",
  "google.workspace.chat.membership.v1.deleted": "membershipDeleted",
  "google.workspace.chat.membership.v1.batchCreated": "membershipCreated",
  "google.workspace.chat.membership.v1.batchUpdated": "membershipUpdated",
  "google.workspace.chat.membership.v1.batchDeleted": "membershipDeleted",
  "google.workspace.chat.space.v1.updated": "spaceUpdated",
  "google.workspace.chat.space.v1.batchUpdated": "spaceUpdated",
};

/** The provider event-type strings one agent-facing category subscribes to. */
export const CHAT_EVENT_TYPE_FILTERS: Record<GoogleChatSpaceEventType, string> = {
  messageCreated: "google.workspace.chat.message.v1.created",
  messageUpdated: "google.workspace.chat.message.v1.updated",
  messageDeleted: "google.workspace.chat.message.v1.deleted",
  reactionCreated: "google.workspace.chat.reaction.v1.created",
  reactionDeleted: "google.workspace.chat.reaction.v1.deleted",
  membershipCreated: "google.workspace.chat.membership.v1.created",
  membershipUpdated: "google.workspace.chat.membership.v1.updated",
  membershipDeleted: "google.workspace.chat.membership.v1.deleted",
  spaceUpdated: "google.workspace.chat.space.v1.updated",
};

/**
 * Flatten one raw event into the agent-facing shape, expanding Google's batch events.
 *
 * Google returns a batch event whenever several of the same kind happened close together, and
 * subscribing to the single form implicitly subscribes to the batch form, so callers would
 * otherwise have to understand two payload shapes for one category.
 */
export function chatSpaceEventsFromRaw(raw: ChatSpaceEventRaw): GoogleChatSpaceEvent[] {
  const type = EVENT_TYPES[raw.eventType ?? ""];
  if (!type || !raw.name) return [];
  const eventTime = chatTime(raw.eventTime) ?? new Date(0);
  const base = { name: raw.name, type, eventTime };

  const messagePayloads = [
    raw.messageCreatedEventData?.message,
    raw.messageUpdatedEventData?.message,
    raw.messageDeletedEventData?.message,
    ...(raw.messageBatchCreatedEventData?.messages ?? []).map(item => item.message),
    ...(raw.messageBatchUpdatedEventData?.messages ?? []).map(item => item.message),
    ...(raw.messageBatchDeletedEventData?.messages ?? []).map(item => item.message),
  ];
  if (messagePayloads.some(item => item !== undefined)) {
    return messagePayloads
      .filter((item): item is ChatMessageRaw =>
        item !== undefined && item.name !== undefined && item.privateMessageViewer === undefined)
      .map(message => ({ ...base, message: chatMessageInfoFromRaw(message) }));
  }

  const reactions = [
    raw.reactionCreatedEventData?.reaction,
    raw.reactionDeletedEventData?.reaction,
    ...(raw.reactionBatchCreatedEventData?.reactions ?? []).map(item => item.reaction),
    ...(raw.reactionBatchDeletedEventData?.reactions ?? []).map(item => item.reaction),
  ].filter((item): item is ChatReactionRaw => item !== undefined && item.name !== undefined);
  if (reactions.length > 0) {
    return reactions.map(reaction => ({ ...base, reaction: chatReactionFromRaw(reaction) }));
  }

  const memberships = [
    raw.membershipCreatedEventData?.membership,
    raw.membershipUpdatedEventData?.membership,
    raw.membershipDeletedEventData?.membership,
    ...(raw.membershipBatchCreatedEventData?.memberships ?? []).map(item => item.membership),
    ...(raw.membershipBatchUpdatedEventData?.memberships ?? []).map(item => item.membership),
    ...(raw.membershipBatchDeletedEventData?.memberships ?? []).map(item => item.membership),
  ].filter((item): item is ChatMembershipRaw => item !== undefined && item.name !== undefined);
  if (memberships.length > 0) {
    return memberships.map(membership => ({
      ...base, membership: chatMembershipFromRaw(membership),
    }));
  }

  const spaces = [
    raw.spaceUpdatedEventData?.space,
    ...(raw.spaceBatchUpdatedEventData?.spaces ?? []).map(item => item.space),
  ].filter((item): item is ChatSpaceRaw => item !== undefined && item.name !== undefined);
  if (spaces.length > 0) {
    return spaces.map(space => ({ ...base, space: chatSpaceInfoFromRaw(space) }));
  }

  return [base];
}

// ── Filter construction ─────────────────────────────────────────────
//
// Chat's filters are a small query language, so every interpolated value is either a validated
// identifier or a quoted RFC-3339 timestamp. Free text is quoted and its quotes and backslashes
// escaped, so a caller's search phrase can never introduce another term.

function quoteChatString(value: string): string {
  // oxlint-disable-next-line no-control-regex -- filter strings must not carry control characters
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Search text must not contain control characters.");
  }
  if (value.length > 500) throw new Error("Search text is too long.");
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function chatTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error(`${label} must be a valid Date.`);
  }
  return `"${value.toISOString()}"`;
}

/** Build the `filter` for `spaces.list`. */
export function chatSpacesListFilter(types: GoogleChatSpaceType[] | undefined): string | undefined {
  if (!types || types.length === 0) return undefined;
  const unique = [...new Set(types)];
  return unique.map(type => `spaceType = "${SPACE_TYPE_ENUMS[type]}"`).join(" OR ");
}

/** Build the `query` for a non-admin `spaces.search`, which only ever matches named spaces. */
export function chatSpacesSearchQuery(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error("A display name to search for is required.");
  return `spaceType = "SPACE" AND displayName:${quoteChatString(trimmed)}`;
}

/** Build the `filter` for `messages.list`. */
export function chatMessagesListFilter(options: GoogleChatListMessagesOptions): string | undefined {
  const terms: string[] = [];
  if (options.createdAfter) {
    terms.push(`createTime > ${chatTimestamp(options.createdAfter, "createdAfter")}`);
  }
  if (options.createdBefore) {
    terms.push(`createTime < ${chatTimestamp(options.createdBefore, "createdBefore")}`);
  }
  if (options.threadName !== undefined) {
    const { spaceId, threadId } = chatThreadParts(options.threadName);
    terms.push(`thread.name = spaces/${spaceId}/threads/${threadId}`);
  }
  return terms.length > 0 ? terms.join(" AND ") : undefined;
}

/** Build the `filter` for `messages.search`. */
export function chatMessagesSearchFilter(query: GoogleChatMessageSearch): string {
  const terms: string[] = [];
  if (query.text !== undefined && query.text.trim()) terms.push(quoteChatString(query.text.trim()));
  if (query.spaceNames && query.spaceNames.length > 0) {
    terms.push(`(${query.spaceNames
      .map(name => `space.name = "spaces/${chatSpaceId(name)}"`)
      .join(" OR ")})`);
  }
  if (query.spaceDisplayNameContains !== undefined && query.spaceDisplayNameContains.trim()) {
    terms.push(`space.display_name:${quoteChatString(query.spaceDisplayNameContains.trim())}`);
  }
  if (query.spaceTypes && query.spaceTypes.length > 0) {
    terms.push(`(${[...new Set(query.spaceTypes)]
      .map(type => `space.space_type = "${SPACE_TYPE_ENUMS[type]}"`)
      .join(" OR ")})`);
  }
  if (query.senders && query.senders.length > 0) {
    terms.push(`(${query.senders
      .map(sender => `sender.name = "${chatUserName(sender)}"`)
      .join(" OR ")})`);
  }
  if (query.mentions && query.mentions.length > 0) {
    terms.push(`(${query.mentions
      .map(user => `annotations.user_mentions.user.name:"${chatUserName(user)}"`)
      .join(" OR ")})`);
  }
  if (query.createdAfter) {
    terms.push(`createTime >= ${chatTimestamp(query.createdAfter, "createdAfter")}`);
  }
  if (query.createdBefore) {
    terms.push(`createTime < ${chatTimestamp(query.createdBefore, "createdBefore")}`);
  }
  if (query.unreadOnly) terms.push("is_unread()");
  if (query.hasAttachment) terms.push("attachment:*");
  if (query.hasLink) terms.push("has_link()");
  if (terms.length === 0) {
    throw new Error("A message search needs at least one filter.");
  }
  return terms.join(" AND ");
}

/** Build the required `filter` for `spaceEvents.list`. */
export function chatSpaceEventsFilter(options: GoogleChatListEventsOptions): string {
  const types = [...new Set(options.types ?? [])];
  if (types.length === 0) throw new Error("At least one event type is required.");
  for (const type of types) {
    if (!(type in CHAT_EVENT_TYPE_FILTERS)) throw new Error(`Unknown event type: ${type}`);
  }
  const terms: string[] = [];
  if (options.startTime) {
    terms.push(`startTime=${chatTimestamp(options.startTime, "startTime")}`);
  }
  if (options.endTime) terms.push(`endTime=${chatTimestamp(options.endTime, "endTime")}`);
  terms.push(`(${types
    .map(type => `eventTypes:"${CHAT_EVENT_TYPE_FILTERS[type]}"`)
    .join(" OR ")})`);
  return terms.join(" AND ");
}

// ── Client ──────────────────────────────────────────────────────────

export type ChatListSpacesOptions = {
  types?: GoogleChatSpaceType[];
  pageToken?: string;
  pageSize?: number;
};

export type ChatListMessagesRequest = GoogleChatListMessagesOptions & {
  pageToken?: string;
  pageSize?: number;
};

export type ChatSearchMessagesRequest = {
  filter: string;
  pageToken?: string;
  pageSize?: number;
};

export type ChatUploadedAttachment = {
  filename: string;
  mimeType: string;
  content: Uint8Array;
};

export class ChatApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(
    operation: string,
    path: string,
    init?: RequestInit & { idempotent?: boolean },
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const { idempotent, ...rest } = init ?? {};
    const response = await fetchWithAuthRetry(
      `${CHAT_API_BASE}${path}`,
      { ...rest, headers },
      this.getAccessToken,
      idempotent === undefined ? {} : { idempotent },
    );
    if (!response.ok) await chatApiFailure(operation, response);
    if (response.status === 204) return undefined as T;
    try {
      return await response.json<T>();
    } catch {
      throw new Error(`Google Chat API ${operation} returned invalid JSON.`);
    }
  }

  // ── Spaces ────────────────────────────────────────────────────────

  async listSpaces(options: ChatListSpacesOptions = {}): Promise<ChatPage<GoogleChatSpaceInfo>> {
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 100) });
    const filter = chatSpacesListFilter(options.types);
    if (filter) params.set("filter", filter);
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{ spaces?: ChatSpaceRaw[]; nextPageToken?: string }>(
      "spaces.list", `/spaces?${params}`);
    return {
      items: (body.spaces ?? []).map(chatSpaceInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /**
   * Search named spaces the connected user has joined.
   *
   * Google populates `nextPageToken` only for administrator searches, which this gatekeeper never
   * performs, so a non-admin search is inherently one page.
   */
  async searchSpaces(
    displayName: string,
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ChatPage<GoogleChatSpaceInfo>> {
    const params = new URLSearchParams({
      query: chatSpacesSearchQuery(displayName),
      pageSize: String(options.pageSize ?? 100),
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{
      results?: { space?: ChatSpaceRaw }[];
      spaces?: ChatSpaceRaw[];
      nextPageToken?: string;
    }>("spaces.search", `/spaces:search?${params}`);
    const spaces = body.results !== undefined
      ? body.results.map(result => result.space).filter((s): s is ChatSpaceRaw => s !== undefined)
      : body.spaces ?? [];
    return {
      items: spaces.map(chatSpaceInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async getSpace(spaceName: string): Promise<GoogleChatSpaceInfo> {
    const spaceId = chatSpaceId(spaceName);
    return chatSpaceInfoFromRaw(
      await this.#request<ChatSpaceRaw>("spaces.get", `/spaces/${spaceId}`));
  }

  /** Returns null when the connected user has no direct message with `user`. */
  async findDirectMessage(user: string): Promise<GoogleChatSpaceInfo | null> {
    const params = new URLSearchParams({ name: chatUserName(user) });
    try {
      return chatSpaceInfoFromRaw(await this.#request<ChatSpaceRaw>(
        "spaces.findDirectMessage", `/spaces:findDirectMessage?${params}`));
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 404) return null;
      throw error;
    }
  }

  async findGroupChats(
    users: string[],
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ChatPage<GoogleChatSpaceInfo>> {
    if (users.length === 0) throw new Error("At least one other user is required.");
    if (users.length > 49) throw new Error("At most 49 other users can be named.");
    const params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 30),
      spaceView: "SPACE_VIEW_EXPANDED",
    });
    for (const user of users) params.append("users", chatUserName(user));
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{ spaces?: ChatSpaceRaw[]; nextPageToken?: string }>(
      "spaces.findGroupChats", `/spaces:findGroupChats?${params}`);
    return {
      items: (body.spaces ?? []).map(chatSpaceInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  // ── Messages ──────────────────────────────────────────────────────

  async listMessages(
    spaceName: string,
    options: ChatListMessagesRequest = {},
  ): Promise<ChatPage<GoogleChatMessageInfo>> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 50) });
    const filter = chatMessagesListFilter(options);
    if (filter) params.set("filter", filter);
    params.set("orderBy", options.order === "newestFirst" ? "createTime DESC" : "createTime ASC");
    if (options.includeDeleted) params.set("showDeleted", "true");
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{ messages?: ChatMessageRaw[]; nextPageToken?: string }>(
      "messages.list", `/spaces/${spaceId}/messages?${params}`);
    return {
      items: (body.messages ?? [])
        .filter(message => message.privateMessageViewer === undefined)
        .map(chatMessageInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** `parent` is `spaces/-` to search everything the user can reach, or one space. */
  async searchMessages(
    parent: string,
    request: ChatSearchMessagesRequest,
  ): Promise<ChatPage<GoogleChatMessageInfo>> {
    const parentPath = parent === "spaces/-" ? "spaces/-" : `spaces/${chatSpaceId(parent)}`;
    const body = await this.#request<{
      results?: { message?: ChatMessageRaw }[];
      nextPageToken?: string;
    }>("messages.search", `/${parentPath}/messages:search`, {
      method: "POST",
      // A search is a read; opting in lets a 429 or 5xx be retried like a GET.
      idempotent: true,
      body: JSON.stringify({
        filter: request.filter,
        pageSize: request.pageSize ?? 50,
        orderBy: "createTime desc",
        ...(request.pageToken ? { pageToken: request.pageToken } : {}),
      }),
    });
    return {
      items: (body.results ?? [])
        .map(result => result.message)
        .filter((message): message is ChatMessageRaw =>
          message !== undefined && message.privateMessageViewer === undefined)
        .map(chatMessageInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async getMessage(messageName: string): Promise<GoogleChatMessageInfo> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    return chatMessageInfoFromRaw(await this.#request<ChatMessageRaw>(
      "messages.get", `/spaces/${spaceId}/messages/${messageId}`));
  }

  /** The raw message, needed where attachment data references matter. */
  async getRawMessage(messageName: string): Promise<ChatMessageRaw> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    const raw = await this.#request<ChatMessageRaw>(
      "messages.get", `/spaces/${spaceId}/messages/${messageId}`);
    if (raw.privateMessageViewer !== undefined) throw new PrivateChatMessageError();
    return raw;
  }

  /**
   * Create a message as the connected user.
   *
   * `requestId` makes the write idempotent, so a retry after a lost response returns the message
   * the first attempt created rather than posting a second one.
   */
  async createMessage(
    spaceName: string,
    message: { text: string; threadName?: string; attachmentUploadTokens?: string[] },
    options: { requestId?: string } = {},
  ): Promise<GoogleChatMessageInfo> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams();
    if (options.requestId) params.set("requestId", options.requestId);
    if (message.threadName !== undefined) {
      params.set("messageReplyOption", "REPLY_MESSAGE_OR_FAIL");
    }
    const query = params.toString();
    const body: Record<string, unknown> = { text: message.text };
    if (message.threadName !== undefined) {
      const { spaceId: threadSpaceId, threadId } = chatThreadParts(message.threadName);
      if (threadSpaceId !== spaceId) {
        throw new Error("The thread named does not belong to this space.");
      }
      body.thread = { name: `spaces/${threadSpaceId}/threads/${threadId}` };
    }
    if (message.attachmentUploadTokens?.length) {
      body.attachment = message.attachmentUploadTokens.map(token => ({
        attachmentDataRef: { attachmentUploadToken: token },
      }));
    }
    return chatMessageInfoFromRaw(await this.#request<ChatMessageRaw>(
      "messages.create",
      `/spaces/${spaceId}/messages${query ? `?${query}` : ""}`,
      { method: "POST", body: JSON.stringify(body) }));
  }

  async updateMessageText(messageName: string, text: string): Promise<GoogleChatMessageInfo> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    return chatMessageInfoFromRaw(await this.#request<ChatMessageRaw>(
      "messages.patch",
      `/spaces/${spaceId}/messages/${messageId}?updateMask=text`,
      { method: "PATCH", body: JSON.stringify({ text }) }));
  }

  async deleteMessage(messageName: string): Promise<void> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    await this.#request<void>(
      "messages.delete", `/spaces/${spaceId}/messages/${messageId}`, { method: "DELETE" });
  }

  // ── Memberships ───────────────────────────────────────────────────

  async listMembers(
    spaceName: string,
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ChatPage<GoogleChatMembership>> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 100),
      showGroups: "true",
      showInvited: "true",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{
      memberships?: ChatMembershipRaw[];
      nextPageToken?: string;
    }>("members.list", `/spaces/${spaceId}/members?${params}`);
    return {
      items: (body.memberships ?? []).map(chatMembershipFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** Returns null when the named user is not a member of the space. */
  async getMembership(spaceName: string, user: string): Promise<GoogleChatMembership | null> {
    const spaceId = chatSpaceId(spaceName);
    const member = chatUserName(user).slice("users/".length);
    try {
      return chatMembershipFromRaw(await this.#request<ChatMembershipRaw>(
        "members.get", `/spaces/${spaceId}/members/${encodeURIComponent(member)}`));
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 404) return null;
      throw error;
    }
  }

  async deleteMembership(membershipName: string): Promise<void> {
    const match = /^spaces\/([^/]+)\/members\/([^/]+)$/.exec(membershipName);
    if (!match) throw new Error("Invalid Google Chat membership resource name.");
    const spaceId = validateChatSpaceId(match[1]);
    if (!USER_ID_RE.test(match[2])) throw new Error("Invalid Google Chat membership ID.");
    await this.#request<void>(
      "members.delete",
      `/spaces/${spaceId}/members/${encodeURIComponent(match[2])}`,
      { method: "DELETE" });
  }

  // ── Reactions ─────────────────────────────────────────────────────

  async listReactions(
    messageName: string,
    options: { pageToken?: string; pageSize?: number; filter?: string } = {},
  ): Promise<ChatPage<GoogleChatReaction>> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 100) });
    if (options.filter) params.set("filter", options.filter);
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{ reactions?: ChatReactionRaw[]; nextPageToken?: string }>(
      "reactions.list", `/spaces/${spaceId}/messages/${messageId}/reactions?${params}`);
    return {
      items: (body.reactions ?? []).map(chatReactionFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async createReaction(messageName: string, emoji: string): Promise<GoogleChatReaction> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    return chatReactionFromRaw(await this.#request<ChatReactionRaw>(
      "reactions.create",
      `/spaces/${spaceId}/messages/${messageId}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji: { unicode: validateChatEmoji(emoji) } }) }));
  }

  async deleteReaction(reactionName: string): Promise<void> {
    const { spaceId, messageId, reactionId } = chatReactionParts(reactionName);
    await this.#request<void>(
      "reactions.delete",
      `/spaces/${spaceId}/messages/${messageId}/reactions/${reactionId}`,
      { method: "DELETE" });
  }

  /** Find the connected user's own reaction with one emoji, so it can be removed. */
  async findOwnReaction(
    messageName: string,
    emoji: string,
    selfName: string,
  ): Promise<GoogleChatReaction | undefined> {
    const filter =
      `emoji.unicode = "${validateChatEmoji(emoji)}" AND user.name = "${chatUserName(selfName)}"`;
    const page = await this.listReactions(messageName, { filter, pageSize: 10 });
    return page.items[0];
  }

  // ── Pins ──────────────────────────────────────────────────────────

  async listMessagePins(
    spaceName: string,
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ChatPage<string>> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 100) });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{
      messagePins?: ChatMessagePinRaw[];
      nextPageToken?: string;
    }>("messagePins.list", `/spaces/${spaceId}/messagePins?${params}`);
    return {
      items: (body.messagePins ?? [])
        .map(pin => pin.message)
        .filter((name): name is string => name !== undefined),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async createMessagePin(messageName: string): Promise<void> {
    const { spaceId } = chatMessageParts(messageName);
    await this.#request<ChatMessagePinRaw>(
      "messagePins.create",
      `/spaces/${spaceId}/messagePins`,
      { method: "POST", body: JSON.stringify({ message: messageName }) });
  }

  async deleteMessagePin(messageName: string): Promise<void> {
    // A pin's id component is the message's id component, which is what makes unpinning
    // addressable without first listing the space's pins.
    const { spaceId, messageId } = chatMessageParts(messageName);
    await this.#request<void>(
      "messagePins.delete", `/spaces/${spaceId}/messagePins/${messageId}`, { method: "DELETE" });
  }

  // ── Notification settings ─────────────────────────────────────────

  async getNotificationSettings(spaceName: string): Promise<GoogleChatNotificationSettings> {
    const spaceId = chatSpaceId(spaceName);
    return chatNotificationSettingsFromRaw(await this.#request<{
      notificationSetting?: string;
      muteSetting?: string;
    }>(
      "spaceNotificationSetting.get",
      `/users/me/spaces/${spaceId}/spaceNotificationSetting`));
  }

  async updateNotificationSettings(
    spaceName: string,
    patch: GoogleChatNotificationSettingsPatch,
  ): Promise<GoogleChatNotificationSettings> {
    const spaceId = chatSpaceId(spaceName);
    const mask: string[] = [];
    const body: Record<string, string> = {};
    if (patch.level !== undefined) {
      const value = NOTIFICATION_LEVEL_ENUMS[patch.level];
      if (!value) throw new Error(`Unknown notification level: ${patch.level}`);
      body.notificationSetting = value;
      mask.push("notificationSetting");
    }
    if (patch.muted !== undefined) {
      body.muteSetting = patch.muted ? "MUTED" : "UNMUTED";
      mask.push("muteSetting");
    }
    if (mask.length === 0) throw new Error("No notification settings were supplied.");
    return chatNotificationSettingsFromRaw(await this.#request<{
      notificationSetting?: string;
      muteSetting?: string;
    }>(
      "spaceNotificationSetting.patch",
      `/users/me/spaces/${spaceId}/spaceNotificationSetting?updateMask=${mask.join(",")}`,
      { method: "PATCH", body: JSON.stringify(body) }));
  }

  // ── Events ────────────────────────────────────────────────────────

  async listSpaceEvents(
    spaceName: string,
    options: GoogleChatListEventsOptions & { pageToken?: string; pageSize?: number },
  ): Promise<ChatPage<GoogleChatSpaceEvent>> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams({
      filter: chatSpaceEventsFilter(options),
      pageSize: String(options.pageSize ?? 50),
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{
      spaceEvents?: ChatSpaceEventRaw[];
      nextPageToken?: string;
    }>("spaceEvents.list", `/spaces/${spaceId}/spaceEvents?${params}`);
    return {
      items: (body.spaceEvents ?? []).flatMap(chatSpaceEventsFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  // ── Media ─────────────────────────────────────────────────────────

  /**
   * Upload one attachment and return the opaque token that attaches it to a message.
   *
   * Uploading is itself a transfer of the caller's data to Google, so this runs only from
   * applyAction(), never at submit time.
   */
  async uploadAttachment(
    spaceName: string,
    attachment: ChatUploadedAttachment,
  ): Promise<string> {
    const spaceId = chatSpaceId(spaceName);
    if (attachment.content.byteLength > MAX_CHAT_UPLOAD_BYTES) {
      throw new Error(
        `Attachment exceeds the ${MAX_CHAT_UPLOAD_BYTES}-byte limit for this connection.`);
    }
    const boundary = `gadgets-chat-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify({ filename: attachment.filename })}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${attachment.mimeType}\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + attachment.content.byteLength + tail.length);
    body.set(head, 0);
    body.set(attachment.content, head.length);
    body.set(tail, head.length + attachment.content.byteLength);

    const response = await fetchWithAuthRetry(
      `${CHAT_UPLOAD_BASE}/spaces/${spaceId}/attachments:upload?uploadType=multipart`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Accept": "application/json",
        },
        body,
      },
      this.getAccessToken);
    if (!response.ok) await chatApiFailure("media.upload", response);
    const parsed = await response.json<{
      attachmentDataRef?: { attachmentUploadToken?: string };
    }>();
    const token = parsed.attachmentDataRef?.attachmentUploadToken;
    if (!token) throw new Error("Google Chat accepted the upload but returned no attachment token.");
    return token;
  }

  /** Download one uploaded attachment's bytes. Drive-backed attachments are not downloadable. */
  async downloadAttachment(resourceName: string): Promise<ArrayBuffer> {
    if (!MEDIA_RESOURCE_RE.test(resourceName)) {
      throw new Error("Invalid Google Chat attachment resource name.");
    }
    const response = await fetchWithAuthRetry(
      `${CHAT_API_BASE}/media/${resourceName.split("/").map(encodeURIComponent).join("/")}` +
        "?alt=media",
      {},
      this.getAccessToken);
    if (!response.ok) await chatApiFailure("media.download", response);
    const declared = Number(response.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_CHAT_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new Error(
        `Attachment exceeds the ${MAX_CHAT_DOWNLOAD_BYTES}-byte safe-read limit.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_CHAT_DOWNLOAD_BYTES) {
      throw new Error(`Attachment exceeds the ${MAX_CHAT_DOWNLOAD_BYTES}-byte safe-read limit.`);
    }
    return bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
