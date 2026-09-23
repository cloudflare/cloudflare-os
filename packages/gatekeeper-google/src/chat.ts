// Google Chat gatekeeper: user-authenticated access to the connected account's conversations.
//
// Two resource granularities share this Durable Object class, distinguished by `props.spaceId`:
//
//   - Whole account (`GoogleChatSession`). Discovery and cross-space search, handing out narrower
//     space capabilities. Observers: strategy A — a Chat account spans direct messages and
//     unrelated conversations, so there is no baseline a collaborator could be verified against
//     and addObserver() always throws.
//   - One conversation (`GoogleChatSpace`). Observers: strategy B — the space is one atomic unit
//     with one ACL, so a collaborator is admitted exactly when their own Google account can open
//     the same space.
//
// Everything reachable here is a user-authenticated call. There is no Chat app identity, no
// `chat.bot` scope, no administrator access, and no import mode; see chat-api.ts.
//
// Every read authorizes an observation before returning anything, and every write is queued as
// an action and only reaches Google from applyAction(). Reads meanwhile answer as though the
// queued writes had already landed; chat-state.ts owns that simulation.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  ActionDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ChatApi, ChatMessageRaw, MAX_CHAT_MESSAGE_BYTES, MAX_CHAT_UPLOADS_PER_MESSAGE,
  MAX_CHAT_UPLOAD_BYTES, chatAttachmentInfoFromRaw, chatAttachmentMediaName, chatMessageParts,
  chatMessagesSearchFilter, chatSpaceId, chatUserName, isChatNoAccessError, validateChatEmoji,
  validateChatSpaceId,
} from "./chat-api";
import {
  ChatAction, ChatSendMessageAction, ChatUploadRecord, PendingChatAction, chatActionSpaceName,
  hasPendingLeave, isPendingMessageName, overlayMemberships, overlayMessage, overlayMessageList,
  overlayPins, overlayReactions, pendingMessageActionId,
  pendingMessageInfo, pendingMessageName,
} from "./chat-state";
import type {
  Cursor, GoogleChatAttachment, GoogleChatAttachmentEntry, GoogleChatAttachmentInfo,
  GoogleChatListEventsOptions, GoogleChatListMessagesOptions, GoogleChatListSpacesOptions,
  GoogleChatMembership, GoogleChatMessage, GoogleChatMessageEntry, GoogleChatMessageInfo,
  GoogleChatMessageSearch, GoogleChatNotificationSettings, GoogleChatNotificationSettingsPatch,
  GoogleChatReaction, GoogleChatSendOptions, GoogleChatSession,
  GoogleChatSpace, GoogleChatSpaceEntry, GoogleChatSpaceEvent, GoogleChatSpaceInfo,
  GoogleChatUpload, GoogleChatUser,
} from "./chat-types";
import { getGoogleAccountDescription, getGoogleAccountSubject } from "./google-api";
import { AccessTokenCache, AccessTokenRequest } from "./auth-retry";
import { CursorPager, Pager } from "./cursor";
import type { GoogleVerifierApi } from "./google-verifier-types";
import CHAT_TYPES_CODE from "./chat-types.txt";

type Env = Cloudflare.Env;

export type GoogleChatGatekeeperImplProps = {
  userObjectId: string;
  /** Present for a single-conversation binding; absent for a whole-account binding. */
  spaceId?: string;
};

/** Bytes of attachment content one stored chunk holds. */
const BLOB_CHUNK_BYTES = 128 * 1024;

const SEND_MESSAGE_ACTION: ActionKind = { tag: "chatSendMessage", label: "Send Chat messages" };
const EDIT_MESSAGE_ACTION: ActionKind = { tag: "chatEditMessage", label: "Edit Chat messages" };
const DELETE_MESSAGE_ACTION: ActionKind = {
  tag: "chatDeleteMessage", label: "Delete Chat messages",
};
const REACTION_ACTION: ActionKind = { tag: "chatReaction", label: "Chat reactions" };
const PIN_ACTION: ActionKind = { tag: "chatPin", label: "Pin and unpin Chat messages" };
const NOTIFICATION_ACTION: ActionKind = {
  tag: "chatNotificationSettings", label: "Chat notification settings",
};
const LEAVE_ACTION: ActionKind = { tag: "chatLeaveSpace", label: "Leave a Chat conversation" };

/**
 * The kinds a user may opt into auto-approving.
 *
 * Deleting a message and leaving a conversation are absent on purpose: neither can be undone by
 * this gatekeeper, so neither should ever happen without someone looking at it.
 */
const AUTO_APPROVABLE_ACTIONS: ActionKind[] = [
  SEND_MESSAGE_ACTION, EDIT_MESSAGE_ACTION, REACTION_ACTION, PIN_ACTION, NOTIFICATION_ACTION,
];

/** What an applied action needs in order to be undone. */
type ChatRevertInfo =
  | { type: "none" }
  | { type: "sentMessage"; messageName: string }
  | { type: "updatedMessage"; messageName: string; previousText: string }
  | { type: "addedReaction"; reactionName: string }
  | { type: "removedReaction"; messageName: string; emoji: string }
  | { type: "pinned"; messageName: string }
  | { type: "unpinned"; messageName: string }
  | { type: "notificationSettings"; spaceName: string; previous: GoogleChatNotificationSettings };

function previewText(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/** How a conversation is named in approval and observation text. */
function spaceLabel(info: GoogleChatSpaceInfo): string {
  if (info.displayName) return `"${info.displayName}" (${info.name})`;
  return info.type === "directMessage"
    ? `a direct message (${info.name})`
    : `an unnamed conversation (${info.name})`;
}

function selfLabel(self: GoogleChatUser): string {
  return self.displayName ?? self.name;
}

// ── Storage ─────────────────────────────────────────────────────────

class ChatStore {
  #kv: DurableObjectStorage["kv"];
  #sql: DurableObjectStorage["sql"];

  constructor(storage: DurableObjectStorage) {
    this.#kv = storage.kv;
    this.#sql = storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS chat_blobs (" +
      "blob_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk BLOB NOT NULL, " +
      "PRIMARY KEY (blob_id, seq))");
  }

  submit(action: ChatAction): number {
    const id = this.#kv.get<number>("chat:nextActionId") ?? 1;
    this.#kv.put("chat:nextActionId", id + 1);
    this.#kv.put(`chat:action:${id}`, action);
    return id;
  }

  get(id: number): ChatAction | undefined {
    return this.#kv.get<ChatAction>(`chat:action:${id}`);
  }

  list(): PendingChatAction[] {
    return [...this.#kv.list<ChatAction>({ prefix: "chat:action:" })]
      .map(([key, action]) => ({ id: Number(key.slice("chat:action:".length)), action }))
      .filter(({ id }) => Number.isSafeInteger(id))
      .toSorted((left, right) => left.id - right.id);
  }

  /** Pending actions affecting one conversation, which is all a space capability may simulate. */
  listForSpace(spaceName: string): PendingChatAction[] {
    return this.list().filter(({ action }) => chatActionSpaceName(action) === spaceName);
  }

  remove(id: number): void {
    const action = this.get(id);
    this.#kv.delete(`chat:action:${id}`);
    if (action?.type === "sendMessage") {
      for (const upload of action.uploads) this.deleteBlob(upload.blobId);
    }
  }

  setRevert(id: number, info: ChatRevertInfo): void {
    this.#kv.put(`chat:revert:${id}`, info);
  }

  getRevert(id: number): ChatRevertInfo | undefined {
    return this.#kv.get<ChatRevertInfo>(`chat:revert:${id}`);
  }

  clearRevert(id: number): void {
    this.#kv.delete(`chat:revert:${id}`);
  }

  /** Remember what a queued send became, so its capability keeps working once committed. */
  setSentMessage(actionId: number, messageName: string): void {
    this.#kv.put(`chat:sent:${actionId}`, messageName);
  }

  sentMessage(actionId: number): string | undefined {
    return this.#kv.get<string>(`chat:sent:${actionId}`);
  }

  putBlob(bytes: Uint8Array): string {
    const blobId = crypto.randomUUID();
    for (let offset = 0, seq = 0; offset < bytes.byteLength; offset += BLOB_CHUNK_BYTES, seq++) {
      this.#sql.exec(
        "INSERT INTO chat_blobs (blob_id, seq, chunk) VALUES (?, ?, ?)",
        blobId, seq, bytes.slice(offset, offset + BLOB_CHUNK_BYTES));
    }
    return blobId;
  }

  readBlob(blobId: string): Uint8Array {
    const chunks = [...this.#sql.exec<{ chunk: ArrayBuffer }>(
      "SELECT chunk FROM chat_blobs WHERE blob_id = ? ORDER BY seq", blobId)]
      .map(row => new Uint8Array(row.chunk));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (total === 0) throw new Error("The stored attachment content is no longer available.");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  deleteBlob(blobId: string): void {
    this.#sql.exec("DELETE FROM chat_blobs WHERE blob_id = ?", blobId);
  }
}

// ── Approval plumbing ───────────────────────────────────────────────

/**
 * One approval-queue stub shared by a session and every capability it hands out.
 *
 * A message or attachment capability outlives the session that produced it, so the stub is
 * reference-counted rather than owned by whichever object happened to be created first.
 */
class SharedApprovalQueue {
  #stub: RpcStub<ApprovalQueue>;
  // Starts at zero because nothing owns the stub until the first capability is constructed; the
  // session itself is just the first of those. Starting at one would leave the count permanently
  // above zero and the stub would never be released.
  #refs = 0;

  constructor(stub: RpcStub<ApprovalQueue>) {
    this.#stub = stub;
  }

  retain(): () => void {
    this.#refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#refs === 0) this.#stub[Symbol.dispose]();
    };
  }

  authorizeObservation(title: string, description: string): Promise<void> {
    return this.#stub.authorizeObservation({ title, description });
  }

  submitAction(actionId: number, description: ActionDescription): Promise<void> {
    return this.#stub.submitAction(actionId, description);
  }
}

/** What every Chat capability needs, whatever granularity it came from. */
type ChatContext = {
  api: ChatApi;
  queue: SharedApprovalQueue;
  store: ChatStore;
  self: GoogleChatUser;
  /** Set for a single-conversation binding: the only space any capability may reach. */
  boundSpace?: string;
};

function requireInScope(ctx: ChatContext, spaceName: string): string {
  if (ctx.boundSpace !== undefined && spaceName !== ctx.boundSpace) {
    throw new Error("This connection only covers one Google Chat conversation.");
  }
  return spaceName;
}

function observe(ctx: ChatContext, title: string, description: string): Promise<void> {
  return ctx.queue.authorizeObservation(title, description);
}

/** Queue one action for approval, undoing the local record if the queue refuses it. */
async function submitChatAction(
  ctx: ChatContext,
  action: ChatAction,
  description: ActionDescription,
): Promise<number> {
  const actionId = ctx.store.submit(action);
  try {
    await ctx.queue.submitAction(actionId, description);
    return actionId;
  } catch (error) {
    ctx.store.remove(actionId);
    throw error;
  }
}

/**
 * Base class for every Chat capability: holds the shared context and one reference to the
 * approval queue, released when the capability is disposed.
 */
@validateRpc()
class ChatRpcTarget extends RpcTarget {
  protected readonly ctx: ChatContext;
  #release: () => void;

  constructor(ctx: ChatContext) {
    super();
    this.ctx = ctx;
    this.#release = ctx.queue.retain();
  }

  [Symbol.dispose](): void {
    this.#release();
  }
}

@validateRpc()
class ChatCursor<Entry> extends ChatRpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;

  constructor(ctx: ChatContext, pager: Pager<Entry>) {
    super(ctx);
    this.#pager = pager;
  }

  // `next()` takes no arguments, so there is no argument surface to validate.
  @skipRpcValidation()
  next(): Promise<Entry[] | null> {
    return this.#pager.next();
  }
}

function disposeMessageEntries(entries: readonly GoogleChatMessageEntry[]): void {
  for (const entry of entries) (entry.message as GoogleChatMessageImpl)[Symbol.dispose]();
}

function disposeSpaceEntries(entries: readonly GoogleChatSpaceEntry[]): void {
  for (const entry of entries) (entry.space as GoogleChatSpaceImpl)[Symbol.dispose]();
}

// ── Validation shared by the write paths ────────────────────────────

function validateMessageText(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("A message needs some text.");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_CHAT_MESSAGE_BYTES) {
    throw new Error(`A Chat message must be at most ${MAX_CHAT_MESSAGE_BYTES} bytes.`);
  }
  return text;
}

function validateUploads(uploads: GoogleChatUpload[] | undefined): GoogleChatUpload[] {
  if (!uploads || uploads.length === 0) return [];
  if (uploads.length > MAX_CHAT_UPLOADS_PER_MESSAGE) {
    throw new Error(`At most ${MAX_CHAT_UPLOADS_PER_MESSAGE} attachments per message.`);
  }
  for (const upload of uploads) {
    // oxlint-disable-next-line no-control-regex -- the filename travels in a MIME header
    if (!upload.filename || /[/\\\r\n\x00-\x1f\x7f]/.test(upload.filename) ||
        upload.filename.length > 255) {
      throw new Error("Invalid attachment filename.");
    }
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(upload.mimeType)) {
      throw new Error("Invalid attachment media type.");
    }
    if (upload.content.byteLength > MAX_CHAT_UPLOAD_BYTES) {
      throw new Error(`Each attachment must be at most ${MAX_CHAT_UPLOAD_BYTES} bytes.`);
    }
  }
  return uploads;
}

function describeUploads(uploads: readonly ChatUploadRecord[]): string {
  if (uploads.length === 0) return "";
  return `\n\nAttachments: ${uploads
    .map(upload => `${upload.filename} (${upload.mimeType}, ${upload.size} bytes)`)
    .join(", ")}`;
}

/**
 * Queue one outgoing message, holding its attachment bytes locally until approval.
 *
 * Shared by `GoogleChatSpace.sendMessage()` and `GoogleChatMessage.reply()`; the only difference
 * between them is whether a thread is named.
 */
async function queueChatMessage(
  ctx: ChatContext,
  spaceName: string,
  text: string,
  options: GoogleChatSendOptions,
  threadName?: string,
): Promise<GoogleChatMessage> {
  const body = validateMessageText(text);
  const uploads = validateUploads(options.attachments);
  if (hasPendingLeave(ctx.store.listForSpace(spaceName), spaceName)) {
    throw new Error("This conversation is queued to be left, so a message cannot be sent to it.");
  }
  const info = await ctx.api.getSpace(spaceName);
  // Held here rather than uploaded now: an upload is itself a transfer of the caller's data to
  // Google, so it waits for the same approval the message does.
  const stored: ChatUploadRecord[] = uploads.map(upload => ({
    blobId: ctx.store.putBlob(new Uint8Array(upload.content)),
    filename: upload.filename,
    mimeType: upload.mimeType,
    size: upload.content.byteLength,
  }));
  const action: ChatSendMessageAction = {
    type: "sendMessage",
    spaceName,
    text: body,
    ...(threadName !== undefined ? { threadName } : {}),
    uploads: stored,
    requestId: crypto.randomUUID(),
    submittedAt: Date.now(),
  };
  let actionId: number;
  try {
    actionId = await submitChatAction(ctx, action, {
      title: `Send a Google Chat message to ${info.displayName ?? spaceName}`,
      description:
        `Post a message as ${selfLabel(ctx.self)} in ${spaceLabel(info)}` +
        `${threadName !== undefined ? `, as a reply in thread ${threadName}` : ""}.` +
        `\n\n> ${previewText(body, 1000)}${describeUploads(stored)}`,
      implementsRevert: true,
      actionKind: SEND_MESSAGE_ACTION,
      autoApprovable: true,
    });
  } catch (error) {
    for (const upload of stored) ctx.store.deleteBlob(upload.blobId);
    throw error;
  }
  return new GoogleChatMessageImpl(ctx, pendingMessageName(actionId));
}

// ── Account session ─────────────────────────────────────────────────

@validateRpc()
class GoogleChatSessionImpl extends ChatRpcTarget implements GoogleChatSession {
  async getCurrentUser(): Promise<GoogleChatUser> {
    await observe(
      this.ctx,
      "Read the connected Google Chat identity",
      "Read the connected account's own Chat user name and display name.");
    return this.ctx.self;
  }

  async listSpaces(
    options: GoogleChatListSpacesOptions = {},
  ): Promise<Cursor<GoogleChatSpaceEntry>> {
    return this.#spaceCursor(
      pageToken => this.ctx.api.listSpaces({
        ...(options.types ? { types: options.types } : {}),
        ...(pageToken ? { pageToken } : {}),
      }),
      "List Google Chat conversations");
  }

  async searchSpaces(displayName: string): Promise<Cursor<GoogleChatSpaceEntry>> {
    return this.#spaceCursor(
      pageToken => this.ctx.api.searchSpaces(displayName, {
        ...(pageToken ? { pageToken } : {}),
      }),
      "Search Google Chat conversations");
  }

  async findDirectMessage(user: string): Promise<GoogleChatSpace | null> {
    const info = await this.ctx.api.findDirectMessage(user);
    await observe(
      this.ctx,
      "Find a Google Chat direct message",
      info
        ? `Found the direct message with ${chatUserName(user)} (${info.name}).`
        : `No direct message exists with ${chatUserName(user)}.`);
    return info ? new GoogleChatSpaceImpl(this.ctx, info.name) : null;
  }

  async findGroupChats(users: string[]): Promise<Cursor<GoogleChatSpaceEntry>> {
    return this.#spaceCursor(
      pageToken => this.ctx.api.findGroupChats(users, { ...(pageToken ? { pageToken } : {}) }),
      "Find Google Chat group chats");
  }

  async openSpace(name: string): Promise<GoogleChatSpace> {
    const info = await this.ctx.api.getSpace(`spaces/${chatSpaceId(name)}`);
    await observe(
      this.ctx,
      "Open a Google Chat conversation",
      `Confirm the connected account can open ${spaceLabel(info)}.`);
    return new GoogleChatSpaceImpl(this.ctx, info.name);
  }

  async searchMessages(query: GoogleChatMessageSearch): Promise<Cursor<GoogleChatMessageEntry>> {
    const filter = chatMessagesSearchFilter(query);
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatMessageInfo, GoogleChatMessageEntry>({
      provider: "Google Chat",
      fetchPage: pageToken => this.ctx.api.searchMessages("spaces/-", {
        filter, ...(pageToken ? { pageToken } : {}),
      }),
      // Search is provider-backed rather than simulated: overlaying pending edits after Google
      // applies its filter can return non-matches and cannot discover newly matching messages.
      buildEntries: async items => items.map(info => ({
        info, message: new GoogleChatMessageImpl(this.ctx, info.name),
      })),
      authorize: entries => observe(
        this.ctx,
        "Search Google Chat messages",
        `Read ${entries.length} message(s) matching a search across the conversations this ` +
        "account can see."),
      disposeEntries: disposeMessageEntries,
    }));
  }

  #spaceCursor(
    fetchPage: (pageToken: string | undefined) => Promise<{
      items: GoogleChatSpaceInfo[];
      nextPageToken?: string;
    }>,
    title: string,
  ): Cursor<GoogleChatSpaceEntry> {
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatSpaceInfo, GoogleChatSpaceEntry>({
      provider: "Google Chat",
      fetchPage,
      buildEntries: async items => items.map(info => ({
        info, space: new GoogleChatSpaceImpl(this.ctx, info.name),
      })),
      authorize: entries => observe(
        this.ctx,
        title,
        `Read the names and metadata of ${entries.length} conversation(s) this account can see.`),
      disposeEntries: disposeSpaceEntries,
    }));
  }
}

// ── Space capability ────────────────────────────────────────────────

@validateRpc()
class GoogleChatSpaceImpl extends ChatRpcTarget implements GoogleChatSpace {
  #spaceName: string;

  constructor(ctx: ChatContext, spaceName: string) {
    super(ctx);
    this.#spaceName = requireInScope(ctx, `spaces/${chatSpaceId(spaceName)}`);
  }

  #pending(): PendingChatAction[] {
    return this.ctx.store.listForSpace(this.#spaceName);
  }

  async getMetadata(): Promise<GoogleChatSpaceInfo> {
    const info = await this.ctx.api.getSpace(this.#spaceName);
    await observe(
      this.ctx,
      "Read Google Chat conversation metadata",
      `Read the name, type, and description of ${spaceLabel(info)}.`);
    return info;
  }

  async listMessages(
    options: GoogleChatListMessagesOptions = {},
  ): Promise<Cursor<GoogleChatMessageEntry>> {
    const pending = this.#pending();
    // Queued messages belong at the end of the history, so the overlay needs to know when the
    // provider has run out of pages. `exhausted` is set by fetchPage and read by buildEntries,
    // which the pager always runs in that order for one page.
    let exhausted = false;
    let firstPage = true;
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatMessageInfo, GoogleChatMessageEntry>({
      provider: "Google Chat",
      fetchPage: async pageToken => {
        const page = await this.ctx.api.listMessages(this.#spaceName, {
          ...options, ...(pageToken ? { pageToken } : {}),
        });
        exhausted = page.nextPageToken === undefined;
        return page;
      },
      buildEntries: async items => {
        const overlaid = overlayMessageList(items, pending, {
          spaceName: this.#spaceName,
          self: this.ctx.self,
          options,
          exhausted,
          firstPage,
        });
        firstPage = false;
        return overlaid.map(info => ({
          info, message: new GoogleChatMessageImpl(this.ctx, info.name),
        }));
      },
      authorize: entries => observe(
        this.ctx,
        "Read Google Chat messages",
        `Read ${entries.length} message(s) from ${this.#spaceName}, including sender, text, ` +
        "attachments, and reactions."),
      disposeEntries: disposeMessageEntries,
    }));
  }

  async getMessage(name: string): Promise<GoogleChatMessage> {
    if (isPendingMessageName(name)) {
      const actionId = pendingMessageActionId(name);
      const sent = actionId === undefined ? undefined : this.ctx.store.sentMessage(actionId);
      if (sent !== undefined) {
        if (`spaces/${chatMessageParts(sent).spaceId}` !== this.#spaceName) {
          throw new Error("That message does not belong to this conversation.");
        }
      } else {
        const action = actionId === undefined ? undefined : this.ctx.store.get(actionId);
        if (action?.type !== "sendMessage" || action.spaceName !== this.#spaceName) {
          throw new Error("That message does not belong to this conversation.");
        }
      }
    } else {
      const { spaceId } = chatMessageParts(name);
      if (`spaces/${spaceId}` !== this.#spaceName) {
        throw new Error("That message belongs to a different conversation.");
      }
    }
    return new GoogleChatMessageImpl(this.ctx, name);
  }

  async listMembers(): Promise<Cursor<GoogleChatMembership>> {
    const pending = this.#pending();
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatMembership, GoogleChatMembership>({
      provider: "Google Chat",
      fetchPage: pageToken => this.ctx.api.listMembers(this.#spaceName, {
        ...(pageToken ? { pageToken } : {}),
      }),
      buildEntries: async items => overlayMemberships(items, pending, this.#spaceName),
      authorize: entries => observe(
        this.ctx,
        "List Google Chat conversation members",
        `Read ${entries.length} membership(s) of ${this.#spaceName}, including each member's ` +
        "identity and role."),
    }));
  }

  async findMember(user: string): Promise<GoogleChatMembership | null> {
    const membership = await this.ctx.api.getMembership(this.#spaceName, user);
    const simulated = membership
      ? overlayMemberships([membership], this.#pending(), this.#spaceName)[0] ?? null
      : null;
    await observe(
      this.ctx,
      "Look up a Google Chat conversation member",
      simulated
        ? `${chatUserName(user)} is a ${simulated.role} of ${this.#spaceName}.`
        : `${chatUserName(user)} is not a member of ${this.#spaceName}.`);
    return simulated;
  }

  async sendMessage(
    text: string,
    options: GoogleChatSendOptions = {},
  ): Promise<GoogleChatMessage> {
    return queueChatMessage(this.ctx, this.#spaceName, text, options);
  }

  async listPinnedMessages(): Promise<Cursor<GoogleChatMessageEntry>> {
    const pending = this.#pending();
    let exhausted = false;
    return new ChatCursor(this.ctx, new CursorPager<string, GoogleChatMessageEntry>({
      provider: "Google Chat",
      fetchPage: async pageToken => {
        // A pin is only a message name, so each one costs a message read to describe. The page
        // is kept small to stay well inside one invocation's subrequest budget.
        const page = await this.ctx.api.listMessagePins(this.#spaceName, {
          pageSize: 20, ...(pageToken ? { pageToken } : {}),
        });
        exhausted = page.nextPageToken === undefined;
        return page;
      },
      buildEntries: async names => {
        const entries: GoogleChatMessageEntry[] = [];
        for (const name of overlayPins(names, pending, {
          spaceName: this.#spaceName, exhausted,
        })) {
          let raw: GoogleChatMessageInfo;
          try {
            raw = await this.ctx.api.getMessage(name);
          } catch (error) {
            // A pin can outlive the message it points at for a moment. One stale entry must not
            // fail the whole page.
            if (isChatNoAccessError(error)) continue;
            throw error;
          }
          const info = overlayMessage(raw, pending);
          if (info) {
            entries.push({ info, message: new GoogleChatMessageImpl(this.ctx, info.name) });
          }
        }
        return entries;
      },
      authorize: entries => observe(
        this.ctx,
        "List pinned Google Chat messages",
        `Read ${entries.length} pinned message(s) from ${this.#spaceName}.`),
      disposeEntries: disposeMessageEntries,
    }));
  }

  async updateNotificationSettings(patch: GoogleChatNotificationSettingsPatch): Promise<void> {
    if (patch.level === undefined && patch.muted === undefined) {
      throw new Error("Nothing to change.");
    }
    const info = await this.ctx.api.getSpace(this.#spaceName);
    const changes = [
      ...(patch.level !== undefined ? [`notifications → ${patch.level}`] : []),
      ...(patch.muted !== undefined ? [patch.muted ? "muted" : "unmuted"] : []),
    ].join("; ");
    await submitChatAction(this.ctx, {
      type: "updateNotificationSettings",
      spaceName: this.#spaceName,
      patch,
      submittedAt: Date.now(),
    }, {
      title: `Change Google Chat notifications for ${info.displayName ?? this.#spaceName}`,
      description:
        `Change the connected account's own notification settings for ${spaceLabel(info)}: ` +
        `${changes}. Nobody else in the conversation is affected.`,
      implementsRevert: true,
      actionKind: NOTIFICATION_ACTION,
      autoApprovable: true,
    });
  }

  async listEvents(options: GoogleChatListEventsOptions): Promise<Cursor<GoogleChatSpaceEvent>> {
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatSpaceEvent, GoogleChatSpaceEvent>({
      provider: "Google Chat",
      fetchPage: pageToken => this.ctx.api.listSpaceEvents(this.#spaceName, {
        ...options, ...(pageToken ? { pageToken } : {}),
      }),
      buildEntries: async items => items,
      authorize: entries => observe(
        this.ctx,
        "Read recent Google Chat activity",
        `Read ${entries.length} recent event(s) of type ${options.types.join(", ")} from ` +
        `${this.#spaceName}, including the current content of the messages, reactions, or ` +
        "memberships they refer to."),
    }));
  }

  async leave(): Promise<void> {
    const info = await this.ctx.api.getSpace(this.#spaceName);
    const membership = await this.ctx.api.getMembership(this.#spaceName, this.ctx.self.name);
    if (!membership) throw new Error("The connected account is not a member of this conversation.");
    await submitChatAction(this.ctx, {
      type: "leaveSpace",
      spaceName: this.#spaceName,
      membershipName: membership.name,
      submittedAt: Date.now(),
    }, {
      title: `Leave the Google Chat conversation ${info.displayName ?? this.#spaceName}`,
      description:
        `Remove ${selfLabel(this.ctx.self)} from ${spaceLabel(info)}. Only the connected ` +
        "account's own membership is removed; nobody else is affected. Rejoining may need an " +
        "invitation, so this cannot be undone automatically.",
      implementsRevert: false,
      actionKind: LEAVE_ACTION,
    });
  }
}

// ── Message capability ──────────────────────────────────────────────

@validateRpc()
class GoogleChatMessageImpl extends ChatRpcTarget implements GoogleChatMessage {
  #name: string;

  constructor(ctx: ChatContext, name: string) {
    super(ctx);
    if (!isPendingMessageName(name)) {
      requireInScope(ctx, `spaces/${chatMessageParts(name).spaceId}`);
    }
    this.#name = name;
  }

  /**
   * The provider resource name this capability currently refers to.
   *
   * A capability returned by `sendMessage` starts out naming a queued message; once that message
   * has been committed the recorded provider name takes over, so the same capability keeps
   * working without the caller having to look the message up again.
   */
  #resolved(): { name: string; pendingId?: number } {
    const pendingId = pendingMessageActionId(this.#name);
    if (pendingId === undefined) return { name: this.#name };
    const sent = this.ctx.store.sentMessage(pendingId);
    if (sent) return { name: sent };
    if (!this.ctx.store.get(pendingId)) throw new Error("This message was never created.");
    return { name: this.#name, pendingId };
  }

  #requireCommitted(operation: string): string {
    const { name, pendingId } = this.#resolved();
    if (pendingId !== undefined) {
      throw new Error(
        `This message has not been committed to Google Chat yet, so it cannot be ${operation}.`);
    }
    return name;
  }

  #spaceName(): string {
    const { name, pendingId } = this.#resolved();
    if (pendingId === undefined) return `spaces/${chatMessageParts(name).spaceId}`;
    const action = this.ctx.store.get(pendingId);
    if (action?.type !== "sendMessage") throw new Error("This message was never created.");
    return action.spaceName;
  }

  #pending(): PendingChatAction[] {
    return this.ctx.store.listForSpace(this.#spaceName());
  }

  async #info(): Promise<GoogleChatMessageInfo> {
    const { name, pendingId } = this.#resolved();
    if (pendingId !== undefined) {
      const action = this.ctx.store.get(pendingId);
      if (action?.type !== "sendMessage") throw new Error("This message was never created.");
      return pendingMessageInfo(pendingId, action, this.ctx.self);
    }
    const info = overlayMessage(
      await this.ctx.api.getMessage(name), this.#pending(), { includeDeleted: true });
    if (!info) throw new Error("This message no longer exists.");
    return info;
  }

  async getMetadata(): Promise<GoogleChatMessageInfo> {
    const info = await this.#info();
    await observe(
      this.ctx,
      "Read a Google Chat message",
      `Read the sender, text, attachments, and reactions of message ${info.name} in ` +
      `${info.spaceName}.`);
    return info;
  }

  async space(): Promise<GoogleChatSpace> {
    return new GoogleChatSpaceImpl(this.ctx, this.#spaceName());
  }

  async reply(text: string, options: GoogleChatSendOptions = {}): Promise<GoogleChatMessage> {
    const info = await this.#info();
    if (info.pending) {
      throw new Error(
        "This message has not been committed to Google Chat yet, so it cannot be replied to.");
    }
    if (info.threadName === undefined) {
      throw new Error(
        "This conversation does not support threaded replies; send a new message instead.");
    }
    return queueChatMessage(this.ctx, info.spaceName, text, options, info.threadName);
  }

  async updateText(text: string): Promise<void> {
    const name = this.#requireCommitted("edited");
    const body = validateMessageText(text);
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "updateMessage", messageName: name, text: body, submittedAt: Date.now(),
    }, {
      title: `Edit a Google Chat message in ${current.spaceName}`,
      description:
        `Replace the text of message ${name}, sent by ` +
        `${current.sender?.displayName ?? current.sender?.name ?? "an unknown sender"}.` +
        `\n\n**Current:** ${previewText(current.text, 500)}` +
        `\n\n**New:** ${previewText(body, 500)}`,
      implementsRevert: true,
      actionKind: EDIT_MESSAGE_ACTION,
      autoApprovable: true,
    });
  }

  async delete(): Promise<void> {
    const name = this.#requireCommitted("deleted");
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "deleteMessage", messageName: name, submittedAt: Date.now(),
    }, {
      title: `Delete a Google Chat message in ${current.spaceName}`,
      description:
        `Permanently delete message ${name}, sent by ` +
        `${current.sender?.displayName ?? current.sender?.name ?? "an unknown sender"}. ` +
        "Threaded replies to it are deleted with it, and this cannot be undone." +
        `\n\n> ${previewText(current.text, 500)}`,
      implementsRevert: false,
      actionKind: DELETE_MESSAGE_ACTION,
    });
  }

  async listReactions(): Promise<Cursor<GoogleChatReaction>> {
    const name = this.#requireCommitted("read for reactions");
    const pending = this.#pending();
    const seenOwnEmojis = new Set<string>();
    let exhausted = false;
    return new ChatCursor(this.ctx, new CursorPager<GoogleChatReaction, GoogleChatReaction>({
      provider: "Google Chat",
      fetchPage: async pageToken => {
        const page = await this.ctx.api.listReactions(name, {
          ...(pageToken ? { pageToken } : {}),
        });
        exhausted = page.nextPageToken === undefined;
        return page;
      },
      buildEntries: async items => overlayReactions(items, pending, {
        messageName: name,
        self: this.ctx.self,
        exhausted,
        seenOwnEmojis,
      }),
      authorize: entries => observe(
        this.ctx,
        "List Google Chat reactions",
        `Read ${entries.length} reaction(s) on message ${name}, including who reacted.`),
    }));
  }

  async addReaction(emoji: string): Promise<void> {
    const name = this.#requireCommitted("reacted to");
    const value = validateChatEmoji(emoji);
    await submitChatAction(this.ctx, {
      type: "addReaction", messageName: name, emoji: value, submittedAt: Date.now(),
    }, {
      title: `React ${value} to a Google Chat message`,
      description: `Add the reaction ${value} to message ${name} as ${selfLabel(this.ctx.self)}.`,
      implementsRevert: true,
      actionKind: REACTION_ACTION,
      autoApprovable: true,
    });
  }

  async removeReaction(emoji: string): Promise<void> {
    const name = this.#requireCommitted("reacted to");
    const value = validateChatEmoji(emoji);
    await submitChatAction(this.ctx, {
      type: "removeReaction", messageName: name, emoji: value, submittedAt: Date.now(),
    }, {
      title: `Remove the ${value} reaction from a Google Chat message`,
      description:
        `Remove ${selfLabel(this.ctx.self)}'s own ${value} reaction from message ${name}.`,
      implementsRevert: true,
      actionKind: REACTION_ACTION,
      autoApprovable: true,
    });
  }

  async attachments(): Promise<GoogleChatAttachmentEntry[]> {
    const name = this.#requireCommitted("read for attachments");
    const raw: ChatMessageRaw = await this.ctx.api.getRawMessage(name);
    const attachments = (raw.attachment ?? []).map(attachment => ({
      info: chatAttachmentInfoFromRaw(attachment),
      mediaName: chatAttachmentMediaName(attachment),
    }));
    await observe(
      this.ctx,
      "List Google Chat message attachments",
      `Read the filenames and media types of ${attachments.length} attachment(s) on message ` +
      `${name}.`);
    return attachments.map(({ info, mediaName }) => ({
      info,
      attachment: new GoogleChatAttachmentImpl(this.ctx, name, info, mediaName),
    }));
  }

  async pin(): Promise<void> {
    const name = this.#requireCommitted("pinned");
    const spaceName = this.#spaceName();
    await submitChatAction(this.ctx, {
      type: "pinMessage", spaceName, messageName: name, submittedAt: Date.now(),
    }, {
      title: `Pin a Google Chat message in ${spaceName}`,
      description: `Pin message ${name} so everyone in ${spaceName} sees it in the pinned list.`,
      implementsRevert: true,
      actionKind: PIN_ACTION,
      autoApprovable: true,
    });
  }

  async unpin(): Promise<void> {
    const name = this.#requireCommitted("unpinned");
    const spaceName = this.#spaceName();
    await submitChatAction(this.ctx, {
      type: "unpinMessage", spaceName, messageName: name, submittedAt: Date.now(),
    }, {
      title: `Unpin a Google Chat message in ${spaceName}`,
      description: `Remove the pin from message ${name} in ${spaceName}.`,
      implementsRevert: true,
      actionKind: PIN_ACTION,
      autoApprovable: true,
    });
  }
}

// ── Attachment capability ───────────────────────────────────────────

@validateRpc()
class GoogleChatAttachmentImpl extends ChatRpcTarget implements GoogleChatAttachment {
  #messageName: string;
  #info: GoogleChatAttachmentInfo;
  #mediaName: string | undefined;

  constructor(
    ctx: ChatContext,
    messageName: string,
    info: GoogleChatAttachmentInfo,
    mediaName: string | undefined,
  ) {
    super(ctx);
    requireInScope(ctx, `spaces/${chatMessageParts(messageName).spaceId}`);
    this.#messageName = messageName;
    this.#info = info;
    this.#mediaName = mediaName;
  }

  async getMetadata(): Promise<GoogleChatAttachmentInfo> {
    await observe(
      this.ctx,
      "Read Google Chat attachment metadata",
      `Read the filename and media type of ${this.#info.filename || "an attachment"}.`);
    return this.#info;
  }

  async getContent(): Promise<ArrayBuffer> {
    if (this.#info.source === "drive") {
      throw new Error(
        "This attachment is a Google Drive file. Read it through a Google Drive connection.");
    }
    if (!this.#mediaName) throw new Error("This attachment's content is not available.");

    // Re-read the parent before downloading so an old attachment capability cannot outlive the
    // message, its attachment, the connected account's access, or the private-message filter.
    const message = await this.ctx.api.getRawMessage(this.#messageName);
    const current = (message.attachment ?? []).find(attachment =>
      attachment.name === this.#info.name &&
      chatAttachmentMediaName(attachment) === this.#mediaName);
    if (!current) throw new Error("This attachment is no longer available on its message.");

    const content = await this.ctx.api.downloadAttachment(this.#mediaName);
    await observe(
      this.ctx,
      "Read a Google Chat attachment",
      `Read the full contents of ${this.#info.filename || "an attachment"} ` +
      `(${this.#info.mimeType}, ${content.byteLength} bytes).`);
    return content;
  }
}

// ── Gatekeeper Durable Object ───────────────────────────────────────

@validateRpc()
export class GoogleChatGatekeeperImpl
    extends DurableObject<Env, GoogleChatGatekeeperImplProps>
    implements Gatekeeper<GoogleChatSession | GoogleChatSpace> {
  #self?: GoogleChatUser;
  #tokens = new AccessTokenCache(opts => {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  #api(): ChatApi {
    return new ChatApi(opts => this.#getAccessToken(opts));
  }

  #boundSpaceName(): string | undefined {
    const spaceId = this.ctx.props.spaceId;
    return spaceId === undefined ? undefined : `spaces/${validateChatSpaceId(spaceId)}`;
  }

  /**
   * The connected account's own Chat identity.
   *
   * Pinned on first use: a binding that quietly followed a reconnect to a different Google
   * account would keep answering as though it were still the original one, and "my own messages"
   * would silently mean somebody else's.
   */
  async #getSelf(): Promise<GoogleChatUser> {
    if (this.#self) return this.#self;
    const token = await this.#getAccessToken();
    const subject = await getGoogleAccountSubject(token);
    const cached = this.ctx.storage.kv.get<GoogleChatUser>("chat:self");
    if (cached) {
      if (cached.name !== `users/${subject}`) {
        throw new Error(
          "This Google Chat binding belongs to a different Google account. Reconnect the " +
          "original account.");
      }
      this.#self = cached;
      return cached;
    }
    const description = await getGoogleAccountDescription(token);
    const self: GoogleChatUser = {
      name: `users/${subject}`,
      ...(description.displayName ? { displayName: description.displayName } : {}),
      type: "human",
    };
    this.ctx.storage.kv.put("chat:self", self);
    this.#self = self;
    return self;
  }

  async describe(): Promise<ResourceDescription> {
    const boundSpace = this.#boundSpaceName();
    if (boundSpace === undefined) {
      return {
        url: "https://chat.google.com/",
        title: "Google Chat",
        snippet: "Find conversations, read and search messages, and post as the connected account.",
        suggestedBindingName: "GOOGLE_CHAT",
        tsType: "GoogleChatSession",
      };
    }
    const info = await this.#api().getSpace(boundSpace);
    const title = info.displayName ??
      (info.type === "directMessage" ? "Google Chat direct message" : "Google Chat conversation");
    return {
      url: info.url ?? `https://chat.google.com/room/${chatSpaceId(boundSpace)}`,
      title,
      snippet: `Google Chat conversation: ${title}`,
      suggestedBindingName: "GOOGLE_CHAT_SPACE",
      tsType: "GoogleChatSpace",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CHAT_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return AUTO_APPROVABLE_ACTIONS;
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GoogleChatSession | GoogleChatSpace> {
    const self = await this.#getSelf();
    const boundSpace = this.#boundSpaceName();
    await approvalQueue.authorizeObservation({
      title: "Open a Google Chat session",
      description: boundSpace === undefined
        ? "Resolve the connected Google account behind this Chat connection."
        : `Resolve the connected Google account and open ${boundSpace}.`,
    });
    const ctx: ChatContext = {
      api: this.#api(),
      queue: new SharedApprovalQueue(approvalQueue.dup()),
      store: new ChatStore(this.ctx.storage),
      self,
      ...(boundSpace !== undefined ? { boundSpace } : {}),
    };
    return boundSpace === undefined
      ? new GoogleChatSessionImpl(ctx)
      : new GoogleChatSpaceImpl(ctx, boundSpace);
  }

  async applyAction(actionId: number): Promise<void> {
    const store = new ChatStore(this.ctx.storage);
    const action = store.get(actionId);
    if (!action) throw new Error(`Unknown pending Google Chat action: ${actionId}`);
    const api = this.#api();

    switch (action.type) {
      case "sendMessage": {
        // A retried apply must not post twice. The recorded provider name short-circuits a retry
        // whose first attempt already succeeded, and the request id makes Chat itself idempotent
        // for the case where the first attempt's response was lost.
        if (store.sentMessage(actionId)) {
          store.remove(actionId);
          return;
        }
        const tokens: string[] = [];
        for (const upload of action.uploads) {
          tokens.push(await api.uploadAttachment(action.spaceName, {
            filename: upload.filename,
            mimeType: upload.mimeType,
            content: store.readBlob(upload.blobId),
          }));
        }
        const created = await api.createMessage(action.spaceName, {
          text: action.text,
          ...(action.threadName !== undefined ? { threadName: action.threadName } : {}),
          ...(tokens.length > 0 ? { attachmentUploadTokens: tokens } : {}),
        }, { requestId: action.requestId });
        store.setSentMessage(actionId, created.name);
        store.setRevert(actionId, { type: "sentMessage", messageName: created.name });
        store.remove(actionId);
        return;
      }
      case "updateMessage": {
        const previous = await api.getMessage(action.messageName);
        await api.updateMessageText(action.messageName, action.text);
        store.setRevert(actionId, {
          type: "updatedMessage",
          messageName: action.messageName,
          previousText: previous.text,
        });
        store.remove(actionId);
        return;
      }
      case "deleteMessage":
        await api.deleteMessage(action.messageName);
        store.remove(actionId);
        return;
      case "addReaction": {
        const self = await this.#getSelf();
        // Adding a reaction twice is an error, so a retry reuses the one already there.
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.name);
        if (existing) {
          store.setRevert(actionId, { type: "none" });
        } else {
          const reaction = await api.createReaction(action.messageName, action.emoji);
          store.setRevert(actionId, { type: "addedReaction", reactionName: reaction.name });
        }
        store.remove(actionId);
        return;
      }
      case "removeReaction": {
        const self = await this.#getSelf();
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.name);
        if (existing) {
          await api.deleteReaction(existing.name);
          store.setRevert(actionId, {
            type: "removedReaction", messageName: action.messageName, emoji: action.emoji,
          });
        } else {
          store.setRevert(actionId, { type: "none" });
        }
        store.remove(actionId);
        return;
      }
      case "pinMessage":
        await api.createMessagePin(action.messageName);
        store.setRevert(actionId, { type: "pinned", messageName: action.messageName });
        store.remove(actionId);
        return;
      case "unpinMessage":
        await api.deleteMessagePin(action.messageName);
        store.setRevert(actionId, { type: "unpinned", messageName: action.messageName });
        store.remove(actionId);
        return;
      case "updateNotificationSettings": {
        const previous = await api.getNotificationSettings(action.spaceName);
        await api.updateNotificationSettings(action.spaceName, action.patch);
        store.setRevert(actionId, {
          type: "notificationSettings", spaceName: action.spaceName, previous,
        });
        store.remove(actionId);
        return;
      }
      case "leaveSpace":
        await api.deleteMembership(action.membershipName);
        store.remove(actionId);
        return;
      default:
        action satisfies never;
        throw new Error("Unknown Google Chat action.");
    }
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const store = new ChatStore(this.ctx.storage);
    const pending = store.list();
    const index = pending.findIndex(entry => entry.id === actionId);
    if (index === -1) throw new Error(`Unknown pending Google Chat action: ${actionId}`);
    store.remove(actionId);
    // Anything queued behind this action was written against a simulation that included it, so
    // the gadget has to start again rather than keep building on a world that will not exist.
    return index < pending.length - 1 ? { restart: true } : undefined;
  }

  async revertAction(
    actionId: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const store = new ChatStore(this.ctx.storage);
    const info = store.getRevert(actionId);
    if (!info) {
      return {
        message:
          "This Google Chat action can no longer be undone automatically. Undo it in Google Chat.",
      };
    }
    const api = this.#api();
    switch (info.type) {
      case "none":
        break;
      case "sentMessage":
        await api.deleteMessage(info.messageName);
        break;
      case "updatedMessage":
        await api.updateMessageText(info.messageName, info.previousText);
        break;
      case "addedReaction":
        await api.deleteReaction(info.reactionName);
        break;
      case "removedReaction": {
        const self = await this.#getSelf();
        const existing = await api.findOwnReaction(info.messageName, info.emoji, self.name);
        if (!existing) await api.createReaction(info.messageName, info.emoji);
        break;
      }
      case "pinned":
        await api.deleteMessagePin(info.messageName);
        break;
      case "unpinned":
        await api.createMessagePin(info.messageName);
        break;
      case "notificationSettings":
        await api.updateNotificationSettings(info.spaceName, {
          level: info.previous.level, muted: info.previous.muted,
        });
        break;
      default:
        info satisfies never;
        throw new Error("Unknown Google Chat revert record.");
    }
    store.clearRevert(actionId);
  }

  /**
   * Observer admission.
   *
   * A whole-account binding reaches direct messages and every conversation the owner belongs to,
   * so there is nothing a collaborator could be verified against — strategy A, always refuse. A
   * single-space binding is one ACL, so it is enough that the collaborator's own Google account
   * can open the same space; the overseer re-runs this on every open, so losing access to the
   * space locks them out promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const boundSpace = this.#boundSpaceName();
    if (boundSpace === undefined) {
      throw new Error(
        "A whole-account Google Chat connection covers direct messages and every conversation " +
        "the owner belongs to, so it cannot be shared with collaborators. Connect a single " +
        "conversation instead.");
    }
    const verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasChatSpaceAccess(boundSpace))) {
      throw new Error(
        "This collaborator cannot open the bound Google Chat conversation, so they cannot be " +
        "allowed to observe what this workspace has read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}
