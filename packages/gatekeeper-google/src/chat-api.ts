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
import { readGoogleJson } from "./google-response";
import type {
  ChatAttachmentInfo, ChatListMessagesOptions, ChatListSpacesOptions,
  ChatMembership, ChatMessageInfo, ChatMessageSearch, ChatPerson, ChatReaction,
  ChatSpaceInfo, ChatSpaceType, ChatUser, ChatWindow,
} from "./chat-types";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

type PeopleNameRaw = { displayName?: unknown; metadata?: { primary?: boolean } };
type PeopleEmailRaw = { value?: unknown; metadata?: { primary?: boolean } };
type PersonResponseRaw = { requestedResourceName?: unknown; person?: { names?: unknown } } | null;
type DirectoryPersonRaw = { resourceName?: unknown; names?: unknown; emailAddresses?: unknown };

/** A directory profile together with every email address it answers to. */
type DirectoryEntry = { person: ChatPerson; emails: string[] };

/** The primary name in a People `names` list. */
function peopleDisplayName(names: unknown): string | undefined {
  const entries = (Array.isArray(names) ? names : [])
    .filter((entry): entry is PeopleNameRaw => typeof entry === "object" && entry !== null);
  const name = (entries.find(entry => entry.metadata?.primary) ?? entries[0])?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** A directory profile, or undefined when it lacks the People id or email that identify it. */
function directoryEntryFromRaw(raw: DirectoryPersonRaw): DirectoryEntry | undefined {
  // A People id is the same number Chat names the person by.
  const id = /^people\/(\d{1,32})$/.exec(String(raw.resourceName))?.[1];
  // Primary first, so the address shown for a person is the one the directory leads with.
  const emails = (Array.isArray(raw.emailAddresses) ? raw.emailAddresses : [])
    .filter((entry): entry is PeopleEmailRaw => typeof entry === "object" && entry !== null)
    .toSorted((left, right) => Number(right.metadata?.primary === true) - Number(left.metadata?.primary === true))
    .flatMap(entry => typeof entry.value === "string" && entry.value.trim() ? [entry.value.trim()] : []);
  if (id === undefined || emails.length === 0) return undefined;
  const name = peopleDisplayName(raw.names);
  return { person: { id: `users/${id}`, ...(name ? { name } : {}), email: emails[0] }, emails };
}

/** Largest attachment body this gatekeeper will read back into memory. */
export const MAX_CHAT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Chat's own documented message size ceiling. */
export const MAX_CHAT_MESSAGE_BYTES = 32_000;

/** A status-only provider error, safe to log and to base retry decisions on. */
export class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    operation: string,
    public readonly rpcCode?: string,
  ) {
    super(`Google Chat API ${operation} failed [http=${status}${rpcCode ? ` ${rpcCode}` : ""}]`);
  }
}

/** The canonical google.rpc code names — a closed enum that can never carry caller content. */
const RPC_STATUS_NAMES = new Set([
  "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
  "PERMISSION_DENIED", "UNAUTHENTICATED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED",
  "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS",
]);

async function chatApiFailure(operation: string, response: Response): Promise<never> {
  // Chat error prose can quote message text and filter values, so only the HTTP status and the
  // canonical google.rpc code — whitelisted against the closed enum above — travel to the caller.
  let rpcCode: string | undefined;
  try {
    const body = await response.json<{ error?: { status?: string } }>();
    const status = body.error?.status;
    if (typeof status === "string" && RPC_STATUS_NAMES.has(status)) rpcCode = status;
  } catch {
    // Best effort; the status line is what matters.
  }
  throw new ChatApiError(response.status, operation, rpcCode);
}

/** A deliberately omitted app-authored message with a viewer narrower than its space. */
class PrivateChatMessageError extends Error {
  constructor() {
    super("This Google Chat message is not available through this connection.");
  }
}

/** A message Google Chat reports as deleted: its tombstone has no content to return. */
export class DeletedChatMessageError extends Error {
  constructor() {
    super("This Google Chat message has been deleted.");
  }
}

function isDeletedChatMessage(raw: ChatMessageRaw): boolean {
  return raw.deleteTime !== undefined || raw.deletionMetadata !== undefined;
}

/** Whether an error means "this identity cannot see that", rather than a transient failure. */
export function isChatNoAccessError(error: unknown): boolean {
  return error instanceof PrivateChatMessageError ||
    (error instanceof ChatApiError &&
      (error.status === 403 || error.status === 404));
}

/**
 * Whether Google found nothing for a user reference. Besides 404, the reference's shape was
 * validated before sending, so a 400 can only mean it names no real account: the same answer.
 */
function isChatUserNotFound(error: unknown): boolean {
  return error instanceof ChatApiError && (error.status === 400 || error.status === 404);
}

// ── Identifier validation ───────────────────────────────────────────
//
// Every id below is interpolated into a request path or a filter string, so each one is checked
// against the shape Google documents before it goes anywhere near a URL.

const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Dots are legal inside these ids, but a bare `.` or `..` would be collapsed out of the URL path
// by the fetch layer and reach a different endpoint, so each id must contain something else.
/** Message, thread, and reaction ids share one documented shape. */
const ITEM_ID_RE = /^(?=.*[^.])[A-Za-z0-9_.-]{1,256}$/;
const USER_ID_RE = /^(?=.*[^.])[A-Za-z0-9_.@+-]{1,320}$/;
/** Slash-separated, so every segment must avoid `.` and `..`. */
const MEDIA_RESOURCE_RE = /^(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9_./=+-]{1,1024}$/;

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

const CHAT_SPACE_REFERENCE_RES = [
  /^spaces\/([A-Za-z0-9_-]{1,128})$/,
  /^https:\/\/chat\.google\.com\/(?:room|dm)\/([A-Za-z0-9_-]{1,128})(?:\/[^/?#]+){0,2}\/?(?:\?[^#]*)?$/,
  /^https:\/\/mail\.google\.com\/(?:chat|mail)(?:\/u\/\d+)?\/?(?:\?[^#]*)?#chat\/(?:space|dm)\/([A-Za-z0-9_-]{1,128})(?:\/[^/?#]+){0,2}\/?$/,
];

/**
 * The space id in `spaces/{space}`, or in a chat.google.com room/dm link or a Gmail `#chat/`
 * link to a conversation or to a thread or message in it; undefined for anything else,
 * including a bare id.
 */
export function chatSpaceIdFromReference(reference: string): string | undefined {
  const trimmed = reference.trim();
  return CHAT_SPACE_REFERENCE_RES.map(re => re.exec(trimmed)?.[1]).find(Boolean);
}

/** `spaces/{space}` for any conversation reference an agent may pass, including a bare id. */
export function chatSpaceNameFromIdOrUrl(idOrUrl: string): string {
  const bare = idOrUrl.trim();
  const id = chatSpaceIdFromReference(idOrUrl) ?? (SPACE_ID_RE.test(bare) ? bare : undefined);
  if (id === undefined) {
    throw new Error(
      "Expected a Google Chat conversation: spaces/{space}, its bare ID, or a Google Chat link to it.");
  }
  return `spaces/${id}`;
}

/** Split `spaces/{space}/messages/{message}` into its parts, rejecting anything else. */
export function chatMessageParts(messageName: string): { spaceId: string; messageId: string } {
  const match = /^spaces\/([^/]+)\/messages\/([^/]+)$/.exec(messageName);
  if (!match) {
    throw new Error(
      "Expected a message resource name of the form spaces/{space}/messages/{message}.");
  }
  const messageId = match[2];
  if (!ITEM_ID_RE.test(messageId)) throw new Error("Invalid Google Chat message ID.");
  return { spaceId: validateChatSpaceId(match[1]), messageId };
}

/** Validate a bare thread id (the `TTT` of `spaces/{space}/threads/TTT`). */
export function validateChatThreadId(threadId: string): string {
  if (!ITEM_ID_RE.test(threadId)) throw new Error("Invalid Google Chat thread ID.");
  return threadId;
}

/** Split `spaces/{space}/threads/{thread}` into its parts, rejecting anything else. */
export function chatThreadParts(threadName: string): { spaceId: string; threadId: string } {
  const match = /^spaces\/([^/]+)\/threads\/([^/]+)$/.exec(threadName);
  if (!match) {
    throw new Error("Expected a thread resource name of the form spaces/{space}/threads/{thread}.");
  }
  return { spaceId: validateChatSpaceId(match[1]), threadId: validateChatThreadId(match[2]) };
}

/** Split `spaces/{space}/messages/{message}/reactions/{reaction}`, rejecting anything else. */
export function chatReactionParts(
  reactionName: string,
): { spaceId: string; messageId: string; reactionId: string } {
  const match = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions\/([^/]+)$/.exec(reactionName);
  if (!match) throw new Error("Invalid Google Chat reaction resource name.");
  if (!ITEM_ID_RE.test(match[2])) throw new Error("Invalid Google Chat reaction ID.");
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
  spaceThreadingState?: string;
  spaceUri?: string;
  spaceDetails?: { description?: string };
  createTime?: string;
  lastActiveTime?: string;
  membershipCount?: { joinedDirectHumanUserCount?: number };
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
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: { driveFileId?: string };
};

export type ChatMessageRaw = {
  name?: string;
  sender?: ChatUserRaw;
  createTime?: string;
  lastUpdateTime?: string;
  deleteTime?: string;
  text?: string;
  thread?: { name?: string };
  space?: { name?: string };
  attachment?: ChatAttachmentRaw[];
  emojiReactionSummaries?: { emoji?: ChatEmojiRaw; reactionCount?: number }[];
  threadReply?: boolean;
  deletionMetadata?: { deletionType?: string };
  /** Set only for an app-authored message visible to one user in an otherwise shared space. */
  privateMessageViewer?: ChatUserRaw;
  annotations?: { type?: string; userMention?: { user?: ChatUserRaw; type?: string } }[];
};

export type ChatMembershipRaw = {
  name?: string;
  state?: string;
  role?: string;
  member?: ChatUserRaw;
  groupMember?: { name?: string };
};

export type ChatReactionRaw = {
  name?: string;
  user?: ChatUserRaw;
  emoji?: ChatEmojiRaw;
};

/** One page of results plus the provider's continuation token. */
export type ChatPage<T> = { items: T[]; nextPageToken?: string };

// ── Mapping to the agent-facing shapes ──────────────────────────────

/** Google reports an unset timestamp, such as a conversation's never-set last activity, as the epoch. */
function chatTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return parsed.valueOf() > 0 ? parsed : undefined;
}

const SPACE_TYPES: Record<string, ChatSpaceType> = {
  SPACE: "space",
  GROUP_CHAT: "groupChat",
  DIRECT_MESSAGE: "directMessage",
};

const SPACE_TYPE_ENUMS: Record<ChatSpaceType, string> = {
  space: "SPACE",
  groupChat: "GROUP_CHAT",
  directMessage: "DIRECT_MESSAGE",
};

export function chatUserFromRaw(raw: ChatUserRaw | undefined): ChatUser | undefined {
  if (!raw?.name) return undefined;
  return {
    id: raw.name,
    ...(raw.displayName ? { name: raw.displayName } : {}),
    type: raw.type === "BOT" ? "app" : "human",
  };
}

export function chatSpaceInfoFromRaw(raw: ChatSpaceRaw): ChatSpaceInfo {
  if (!raw.name) throw new Error("Google Chat returned a space with no resource name.");
  const createTime = chatTime(raw.createTime);
  const lastActiveTime = chatTime(raw.lastActiveTime);
  const memberCount = raw.membershipCount?.joinedDirectHumanUserCount;
  return {
    id: raw.name,
    ...(raw.displayName ? { name: raw.displayName } : {}),
    ...(raw.spaceUri ? { url: raw.spaceUri } : {}),
    type: SPACE_TYPES[raw.spaceType ?? ""] ?? "space",
    supportsThreads: raw.spaceThreadingState === "THREADED_MESSAGES" ||
      raw.spaceThreadingState === "GROUPED_MESSAGES",
    ...(raw.spaceDetails?.description ? { description: raw.spaceDetails.description } : {}),
    ...(createTime ? { createdAt: createTime } : {}),
    ...(lastActiveTime ? { lastActiveAt: lastActiveTime } : {}),
    ...(typeof memberCount === "number" ? { memberCount } : {}),
  };
}

function chatEmojiFromRaw(raw: ChatEmojiRaw | undefined): string {
  if (raw?.unicode) return raw.unicode;
  const custom = raw?.customEmoji;
  if (custom?.emojiName) return custom.emojiName;
  if (custom?.uid) return `:${custom.uid}:`;
  return "";
}

export function chatAttachmentInfoFromRaw(raw: ChatAttachmentRaw): ChatAttachmentInfo {
  const source = raw.source === "DRIVE_FILE" ? "drive" as const : "uploaded" as const;
  const resourceName = raw.attachmentDataRef?.resourceName;
  return {
    id: raw.name ?? "",
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

/** Each user a message @mentions, once, in order of first mention; both ADD and MENTION kinds count. */
function chatMentionsFromRaw(raw: ChatMessageRaw): ChatUser[] {
  const byId = new Map<string, ChatUser>();
  for (const annotation of raw.annotations ?? []) {
    if (annotation.type !== "USER_MENTION") continue;
    const user = chatUserFromRaw(annotation.userMention?.user);
    if (user && !byId.has(user.id)) byId.set(user.id, user);
  }
  return [...byId.values()];
}

export function chatMessageInfoFromRaw(raw: ChatMessageRaw): ChatMessageInfo {
  // App-authored private messages have a message-level ACL narrower than their containing space.
  // This user-authenticated integration deliberately omits them everywhere rather than exposing
  // owner-only content through a shareable space capability.
  if (raw.privateMessageViewer !== undefined) throw new PrivateChatMessageError();
  if (isDeletedChatMessage(raw)) throw new DeletedChatMessageError();
  if (!raw.name) throw new Error("Google Chat returned a message with no resource name.");
  const { spaceId } = chatMessageParts(raw.name);
  const createTime = chatTime(raw.createTime);
  const lastUpdateTime = chatTime(raw.lastUpdateTime);
  const sender = chatUserFromRaw(raw.sender);
  return {
    id: raw.name,
    spaceId: `spaces/${spaceId}`,
    ...(raw.thread?.name ? { threadId: raw.thread.name } : {}),
    ...(sender ? { sender } : {}),
    text: raw.text ?? "",
    mentions: chatMentionsFromRaw(raw),
    createdAt: createTime ?? new Date(0),
    ...(lastUpdateTime ? { editedAt: lastUpdateTime } : {}),
    isReply: raw.threadReply === true,
    attachments: (raw.attachment ?? []).map(chatAttachmentInfoFromRaw),
    reactions: (raw.emojiReactionSummaries ?? []).map(summary => ({
      emoji: chatEmojiFromRaw(summary.emoji),
      count: summary.reactionCount ?? 0,
    })),
  };
}

/** Map one membership; undefined when Chat names neither a user nor a group. */
export function chatMembershipFromRaw(raw: ChatMembershipRaw): ChatMembership | undefined {
  if (!raw.name) throw new Error("Google Chat returned a membership with no resource name.");
  const state = raw.state === "INVITED"
    ? "invited" as const
    : raw.state === "NOT_A_MEMBER" ? "notMember" as const : "joined" as const;
  const role = raw.role === "ROLE_MANAGER" ? "manager" as const
    : raw.role === "ROLE_ASSISTANT_MANAGER" ? "assistantManager" as const : "member" as const;
  const user = chatUserFromRaw(raw.member);
  if (user) return { id: raw.name, state, role, kind: "user", user };
  if (raw.groupMember?.name) return { id: raw.name, state, role, kind: "group", groupId: raw.groupMember.name };
  return undefined;
}

/** The `users/{user}` id of a person this membership puts in the conversation, if it does. */
function personIn(membership: ChatMembership | null): string | undefined {
  return membership?.kind === "user" && membership.user.type === "human" && membership.state !== "notMember"
    ? membership.user.id : undefined;
}

export function chatReactionFromRaw(raw: ChatReactionRaw): ChatReaction {
  if (!raw.name) throw new Error("Google Chat returned a reaction with no resource name.");
  const user = chatUserFromRaw(raw.user);
  return {
    id: raw.name,
    emoji: chatEmojiFromRaw(raw.emoji),
    ...(user ? { user } : {}),
  };
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

/** Split search text into bare words and "quoted phrases"; a message must contain every one. */
function chatSearchKeywords(text: string): string[] {
  if ((text.match(/"/g)?.length ?? 0) % 2 !== 0) {
    throw new Error('Search text has an unmatched double quote (").');
  }
  return [...text.matchAll(/"([^"]*)"|([^\s"]+)/g)]
    .map(match => (match[1] ?? match[2]).trim())
    .filter(keyword => keyword.length > 0);
}

/** One mention term; the caller alias is unquoted, the form Google documents for it. */
function chatMentionTerm(user: string): string {
  const name = chatUserName(user);
  return name === "users/me"
    ? "annotations.user_mentions.user.name:users/me"
    : `annotations.user_mentions.user.name:"${name}"`;
}

function chatTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error(`${label} must be a valid Date.`);
  }
  return `"${value.toISOString()}"`;
}

/** Build the `filter` for `spaces.list`. */
export function chatSpacesListFilter(types: ChatSpaceType[] | undefined): string | undefined {
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

/** Validate the public half-open window before any provider or simulated read. */
export function validateChatWindow(window: ChatWindow): void {
  if (window.since) chatTimestamp(window.since, "since");
  if (window.before) chatTimestamp(window.before, "before");
  if (window.since && window.before && window.since >= window.before) {
    throw new Error("since must be earlier than before.");
  }
}

/** Apply the public time boundary after widening the provider's exclusive lower bound. */
export function chatTimeInWindow(time: Date, window: ChatWindow): boolean {
  return (!window.since || time >= window.since) && (!window.before || time < window.before);
}

/** Build the `filter` for `messages.list`. */
export function chatMessagesListFilter(options: ChatListMessagesRequest): string | undefined {
  validateChatWindow(options);
  const terms: string[] = [];
  if (options.since) {
    // Google documents only strict >/< here. Re-filter after decoding to honor [since, before).
    terms.push(`createTime > ${chatTimestamp(new Date(options.since.valueOf() - 1), "since")}`);
  }
  if (options.before) {
    terms.push(`createTime < ${chatTimestamp(options.before, "before")}`);
  }
  if (options.threadName !== undefined) {
    const { spaceId, threadId } = chatThreadParts(options.threadName);
    terms.push(`thread.name = spaces/${spaceId}/threads/${threadId}`);
  }
  return terms.length > 0 ? terms.join(" AND ") : undefined;
}

/** Build the `filter` for `messages.search`. */
export function chatMessagesSearchFilter(query: ChatMessageSearch): string {
  validateChatWindow(query);
  if (query.mentionsMe && query.mentions && query.mentions.length > 0) {
    throw new Error('Pass mentions or mentionsMe, not both. Include "users/me" in mentions to match either.');
  }
  const terms: string[] = [];
  if (query.text !== undefined) terms.push(...chatSearchKeywords(query.text).map(quoteChatString));
  if (query.spaceIds && query.spaceIds.length > 0) {
    terms.push(`(${query.spaceIds
      .map(name => `space.name = "spaces/${chatSpaceId(name)}"`)
      .join(" OR ")})`);
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
    terms.push(`(${query.mentions.map(chatMentionTerm).join(" OR ")})`);
  }
  if (query.mentionsMe) terms.push(chatMentionTerm("users/me"));
  if (query.since) {
    terms.push(`createTime >= ${chatTimestamp(query.since, "since")}`);
  }
  if (query.before) {
    terms.push(`createTime < ${chatTimestamp(query.before, "before")}`);
  }
  if (query.unreadOnly) terms.push("is_unread()");
  if (query.hasAttachment) terms.push("attachment:*");
  if (query.hasLink) terms.push("has_link()");
  if (terms.length === 0) {
    throw new Error("A message search needs at least one filter.");
  }
  return terms.join(" AND ");
}

// ── Client ──────────────────────────────────────────────────────────

export type ChatListSpacesRequest = ChatListSpacesOptions & {
  pageToken?: string;
  pageSize?: number;
};

export type ChatListMessagesRequest = ChatListMessagesOptions & {
  /** Bound by the thread capability, never supplied by its caller. */
  threadName?: string;
  pageToken?: string;
  pageSize?: number;
};

export type ChatSearchMessagesRequest = {
  filter: string;
  pageToken?: string;
  pageSize?: number;
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

  async listSpaces(options: ChatListSpacesRequest = {}): Promise<ChatPage<ChatSpaceInfo>> {
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 100) });
    const filter = chatSpacesListFilter(options.spaceTypes);
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
  ): Promise<ChatPage<ChatSpaceInfo>> {
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

  async getSpace(spaceName: string): Promise<ChatSpaceInfo> {
    const spaceId = chatSpaceId(spaceName);
    return chatSpaceInfoFromRaw(
      await this.#request<ChatSpaceRaw>("spaces.get", `/spaces/${spaceId}`));
  }

  /** Returns null when the connected user has no direct message with `user`. */
  async findDirectMessage(user: string): Promise<ChatSpaceInfo | null> {
    const params = new URLSearchParams({ name: chatUserName(user) });
    try {
      return chatSpaceInfoFromRaw(await this.#request<ChatSpaceRaw>(
        "spaces.findDirectMessage", `/spaces:findDirectMessage?${params}`));
    } catch (error) {
      if (isChatUserNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * The group chat with exactly the connected user and `users`, and those people's `users/{user}`
   * ids, or null when there is none. Google matches human members only, so a match may also hold
   * a Chat app; and with no full match, it offers group chats without whoever blocks the connected
   * user or is blocked by them. So each match is checked, every page of them.
   */
  async findGroupChat(users: readonly string[]): Promise<{ spaceName: string; ids: string[] } | null> {
    // A person an email address resolved to in one match is the same person in the next.
    const resolved = new Map<string, string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: "30", ...(pageToken ? { pageToken } : {}) });
      for (const user of users) params.append("users", chatUserName(user));
      type Page = { spaces?: ChatSpaceRaw[]; nextPageToken?: string };
      const page = await this.#request<Page>("spaces.findGroupChats", `/spaces:findGroupChats?${params}`)
        .catch((error: unknown): Page => {
          if (isChatUserNotFound(error)) return {};
          throw error;
        });
      for (const { name } of page.spaces ?? []) {
        if (name === undefined) continue;
        const spaceName = `spaces/${chatSpaceId(name)}`;
        const ids = await this.#onlyIn(spaceName, users, resolved);
        if (ids) return { spaceName, ids };
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return null;
  }

  /** The `users/{user}` ids of `users`, if they and the connected user are everyone in `spaceName`. */
  async #onlyIn(
    spaceName: string, users: readonly string[], resolved: Map<string, string>,
  ): Promise<string[] | null> {
    const present = await this.audienceIn(spaceName);
    if (present.size !== users.length + 1) return null;
    const ids = new Set<string>();
    // A `users/{user}` id is its own membership's; only an email address needs looking up, one at a
    // time, as Chat allows 15 reads a second per space.
    for (const user of users.map(chatUserName)) {
      const id = present.has(user) || !user.includes("@")
        ? user : resolved.get(user) ?? personIn(await this.getMembership(spaceName, user));
      if (id === undefined || !present.has(id)) return null;
      resolved.set(user, id);
      ids.add(id);
    }
    // Two references to one person would leave room for someone else.
    return ids.size === users.length ? [...ids] : null;
  }

  /**
   * Create the direct message (one member) or group chat (several) between the connected user and
   * `members`, returning its name. An existing direct message is returned rather than duplicated,
   * and `requestId` makes a retry return what the first attempt created. Google silently leaves
   * out of a group chat anyone who blocks the caller, so check its members before posting.
   */
  async setupConversation(members: readonly string[], requestId: string): Promise<string> {
    const space = members.length === 1
      ? { spaceType: "DIRECT_MESSAGE", singleUserBotDm: false }
      : { spaceType: "GROUP_CHAT" };
    const raw = await this.#request<ChatSpaceRaw>("spaces.setup", "/spaces:setup", {
      method: "POST",
      body: JSON.stringify({
        space,
        requestId,
        memberships: members.map(user => ({ member: { name: chatUserName(user), type: "HUMAN" } })),
      }),
      idempotent: true,
    });
    if (!raw.name) throw new Error("Google Chat returned a space with no resource name.");
    return `spaces/${chatSpaceId(raw.name)}`;
  }

  // ── Directory ─────────────────────────────────────────────────────

  /**
   * People in the connected user's Workspace directory whose name or email address starts with
   * `query`. Only domain profiles are searched, never contacts, so nobody outside the
   * organization is returned.
   */
  async searchDirectory(
    query: string,
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ChatPage<ChatPerson>> {
    const page = await this.#searchDirectory(query, options);
    return { ...page, items: page.items.map(entry => entry.person) };
  }

  /**
   * The directory profile with this email address, or null when the organization has none.
   * Throws when more profiles match than one page holds and none of those has it.
   */
  async findDirectoryPerson(email: string): Promise<ChatPerson | null> {
    const wanted = email.toLowerCase();
    // Google documents a prefix search but not its ordering, so a further page leaves absence unconfirmed.
    const { items, nextPageToken } = await this.#searchDirectory(email, { pageSize: 10 });
    const match = items.find(entry => entry.emails.some(address => address.toLowerCase() === wanted));
    if (match) return match.person;
    if (nextPageToken) {
      throw new Error(`Couldn't confirm that ${email} is in your organization's directory: too many ` +
        "profiles match it.");
    }
    return null;
  }

  async #searchDirectory(
    query: string,
    options: { pageToken?: string; pageSize?: number },
  ): Promise<ChatPage<DirectoryEntry>> {
    const params = new URLSearchParams({
      query,
      readMask: "names,emailAddresses",
      sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
      pageSize: String(options.pageSize ?? 50),
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const response = await fetchWithAuthRetry(`${PEOPLE_API_BASE}/people:searchDirectoryPeople?${params}`,
      { headers: { Accept: "application/json" } }, this.getAccessToken);
    const body = await readGoogleJson<{ people?: DirectoryPersonRaw[]; nextPageToken?: string }>(response, {
      provider: "Google People", operation: "people.searchDirectoryPeople", maxBytes: 256 * 1024,
    });
    return {
      items: (body.people ?? []).flatMap(raw => directoryEntryFromRaw(raw) ?? []),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  // ── Messages ──────────────────────────────────────────────────────

  async listMessages(
    spaceName: string,
    options: ChatListMessagesRequest = {},
  ): Promise<ChatPage<ChatMessageInfo>> {
    const spaceId = chatSpaceId(spaceName);
    if (options.threadName && chatThreadParts(options.threadName).spaceId !== spaceId) {
      throw new Error("That thread belongs to a different conversation.");
    }
    const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 50) });
    const filter = chatMessagesListFilter(options);
    if (filter) params.set("filter", filter);
    params.set("orderBy", options.order === "newestFirst" ? "createTime DESC" : "createTime ASC");
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const body = await this.#request<{ messages?: ChatMessageRaw[]; nextPageToken?: string }>(
      "messages.list", `/spaces/${spaceId}/messages?${params}`);
    return {
      items: (body.messages ?? [])
        .filter(message => message.privateMessageViewer === undefined && !isDeletedChatMessage(message))
        .map(chatMessageInfoFromRaw)
        .filter(message => message.spaceId === spaceName &&
          (!options.threadName || message.threadId === options.threadName) &&
          chatTimeInWindow(message.createdAt, options)),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** Google only searches `spaces/-`; the filter's `space.name` terms narrow it to a space. */
  async searchMessages(request: ChatSearchMessagesRequest): Promise<ChatPage<ChatMessageInfo>> {
    const body = await this.#request<{
      results?: { message?: ChatMessageRaw }[];
      nextPageToken?: string;
    }>("messages.search", "/spaces/-/messages:search", {
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
          message !== undefined && message.privateMessageViewer === undefined &&
          !isDeletedChatMessage(message))
        .map(chatMessageInfoFromRaw),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async getMessage(messageName: string): Promise<ChatMessageInfo> {
    return chatMessageInfoFromRaw(await this.getRawMessage(messageName));
  }

  /** The raw message, needed where attachment data references matter. */
  async getRawMessage(messageName: string): Promise<ChatMessageRaw> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    const raw = await this.#request<ChatMessageRaw>(
      "messages.get", `/spaces/${spaceId}/messages/${messageId}`);
    if (raw.privateMessageViewer !== undefined) throw new PrivateChatMessageError();
    if (isDeletedChatMessage(raw)) throw new DeletedChatMessageError();
    return raw;
  }

  /**
   * Create a message as the connected user.
   *
   * `requestId` makes the write idempotent, so a retry after a lost response returns the message
   * the first attempt created rather than posting a second one. `messageId` names the message,
   * which can then be read by that name.
   */
  async createMessage(
    spaceName: string,
    message: { text: string; threadName?: string },
    options: { requestId?: string; messageId?: string } = {},
  ): Promise<ChatMessageInfo> {
    const spaceId = chatSpaceId(spaceName);
    const params = new URLSearchParams();
    if (options.requestId) params.set("requestId", options.requestId);
    if (options.messageId) params.set("messageId", options.messageId);
    // Google documents this as named-space only, but a live DM reply threaded correctly.
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
    return chatMessageInfoFromRaw(await this.#request<ChatMessageRaw>(
      "messages.create",
      `/spaces/${spaceId}/messages${query ? `?${query}` : ""}`,
      { method: "POST", body: JSON.stringify(body), idempotent: options.requestId !== undefined }));
  }

  /** Returns the text as Chat stored it. */
  async updateMessageText(messageName: string, text: string): Promise<string> {
    const { spaceId, messageId } = chatMessageParts(messageName);
    const updated = await this.#request<ChatMessageRaw>(
      "messages.patch",
      `/spaces/${spaceId}/messages/${messageId}?updateMask=text`,
      { method: "PATCH", body: JSON.stringify({ text }), idempotent: true });
    return updated.text ?? text;
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
  ): Promise<ChatPage<ChatMembership>> {
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
      items: (body.memberships ?? []).flatMap(raw => chatMembershipFromRaw(raw) ?? []),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /**
   * Everyone a message in a direct message or group chat reaches: the `users/{user}` ids of its
   * people and Chat apps, the connected user's among them, and the `groups/{group}` name of any
   * Google Group.
   */
  async audienceIn(spaceName: string): Promise<Set<string>> {
    const audience = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.listMembers(spaceName, pageToken ? { pageToken } : {});
      for (const membership of page.items) {
        if (membership.state === "notMember") continue;
        audience.add(membership.kind === "group" ? membership.groupId : membership.user.id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return audience;
  }

  /** Returns null when the named user is not a member of the space or does not exist. */
  async getMembership(spaceName: string, user: string): Promise<ChatMembership | null> {
    const spaceId = chatSpaceId(spaceName);
    // A person's membership ID is their user ID.
    const member = chatUserName(user).slice("users/".length);
    try {
      return chatMembershipFromRaw(await this.#request<ChatMembershipRaw>(
        "members.get", `/spaces/${spaceId}/members/${encodeURIComponent(member)}`)) ?? null;
    } catch (error) {
      // 404 is "not a member".
      if (isChatUserNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Profile names from the People API, keyed by `users/{user}`, for people Chat left unnamed.
   * Users whose profile the connected user cannot see are absent, as is everyone when the People
   * API refuses the request; network failures and malformed responses throw. At most 200 users.
   */
  async profileNames(users: readonly string[]): Promise<Map<string, string>> {
    const byResource = new Map<string, string>(users.flatMap(user => {
      const id = /^users\/(\d{1,32})$/.exec(user)?.[1];
      return id ? [[`people/${id}`, user] as const] : [];
    }));
    const names = new Map<string, string>();
    if (byResource.size === 0) return names;
    const params = new URLSearchParams({ personFields: "names", sources: "READ_SOURCE_TYPE_PROFILE" });
    for (const resource of byResource.keys()) params.append("resourceNames", resource);
    const response = await fetchWithAuthRetry(`${PEOPLE_API_BASE}/people:batchGet?${params}`,
      { headers: { Accept: "application/json" } }, this.getAccessToken);
    if (!response.ok) {
      await response.body?.cancel();
      return names;
    }
    const body = await readGoogleJson<{ responses?: unknown } | null>(response, {
      provider: "Google People", operation: "people.batchGet", maxBytes: 256 * 1024,
    });
    for (const entry of (Array.isArray(body?.responses) ? body.responses : []) as PersonResponseRaw[]) {
      // A profile linked to a contact can answer under a different resource name, so match each
      // response by the name that was requested.
      const user = byResource.get(String(entry?.requestedResourceName));
      const name = peopleDisplayName(entry?.person?.names);
      if (user && name) names.set(user, name);
    }
    return names;
  }

  // ── Reactions ─────────────────────────────────────────────────────

  async listReactions(
    messageName: string,
    options: { pageToken?: string; pageSize?: number; filter?: string } = {},
  ): Promise<ChatPage<ChatReaction>> {
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

  async createReaction(messageName: string, emoji: string): Promise<ChatReaction> {
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
  ): Promise<ChatReaction | undefined> {
    const filter =
      `emoji.unicode = "${validateChatEmoji(emoji)}" AND user.name = "${chatUserName(selfName)}"`;
    const page = await this.listReactions(messageName, { filter, pageSize: 10 });
    return page.items[0];
  }

  // ── Media ─────────────────────────────────────────────────────────

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
    const reader = response.body?.getReader();
    if (!reader) return new ArrayBuffer(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CHAT_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`Attachment exceeds the ${MAX_CHAT_DOWNLOAD_BYTES}-byte safe-read limit.`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }
}
