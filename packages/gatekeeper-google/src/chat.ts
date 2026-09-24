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

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ChatApi, ChatApiError, ChatPage, MAX_CHAT_MESSAGE_BYTES,
  chatAttachmentInfoFromRaw, chatAttachmentMediaName, chatMessageParts, chatMessagesSearchFilter,
  chatSpaceId, chatUserName, isChatNoAccessError, validateChatEmoji, validateChatSpaceId,
} from "./chat-api";
import {
  ChatAction, ChatSendMessageAction, PendingChatAction, chatActionSpaceName,
  overlayMessage, overlayMessageList, overlayReactions, pendingMessageActionId,
  pendingMessageInfo, pendingMessageName,
} from "./chat-state";
import type {
  Cursor, GoogleChatAttachment, GoogleChatAttachmentEntry, GoogleChatAttachmentInfo,
  GoogleChatListMessagesOptions, GoogleChatListSpacesOptions,
  GoogleChatMembership, GoogleChatMessage, GoogleChatMessageEntry, GoogleChatMessageInfo,
  GoogleChatMessageSearch, GoogleChatReaction, GoogleChatSession,
  GoogleChatSpace, GoogleChatSpaceEntry, GoogleChatSpaceInfo, GoogleChatUser,
} from "./chat-types";
import { getGoogleAccountProfile } from "./google-api";
import { AccessTokenCache } from "./auth-retry";
import { CursorPager, CursorPagerOptions } from "./cursor";
import { ApprovalQueueRpcTarget, RpcCursor, SharedApprovalQueue } from "./shared-approval-queue";
import type { GoogleVerifierApi } from "./google-verifier-types";
import CHAT_TYPES_CODE from "./chat-types.txt";

type Env = Cloudflare.Env;

export type GoogleChatGatekeeperImplProps = {
  userObjectId: string;
  /** Present for a single-conversation binding; absent for a whole-account binding. */
  spaceId?: string;
};

const SEND_MESSAGE_ACTION: ActionKind = { tag: "chatSendMessage", label: "Send Chat messages" };
const EDIT_MESSAGE_ACTION: ActionKind = { tag: "chatEditMessage", label: "Edit Chat messages" };
const REACTION_ACTION: ActionKind = { tag: "chatReaction", label: "Chat reactions" };

/** The kinds a user may opt into auto-approving. */
const AUTO_APPROVABLE_ACTIONS: ActionKind[] = [
  SEND_MESSAGE_ACTION, EDIT_MESSAGE_ACTION, REACTION_ACTION,
];

/** What an applied action needs in order to be undone. */
type ChatRevertInfo =
  | { type: "none" }
  | { type: "sentMessage"; messageName: string }
  | { type: "updatedMessage"; messageName: string; previousText: string }
  | { type: "addedReaction"; reactionName: string }
  | { type: "removedReaction"; messageName: string; emoji: string };

function previewText(text: string, maxLength: number): string {
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

function userLabel(user: GoogleChatUser | undefined): string {
  return user?.displayName ?? user?.name ?? "an unknown user";
}

// ── Storage ─────────────────────────────────────────────────────────

class ChatStore {
  #kv: DurableObjectStorage["kv"];

  constructor(storage: DurableObjectStorage) {
    this.#kv = storage.kv;
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
      .toSorted((left, right) => left.id - right.id);
  }

  /** Pending actions affecting one conversation, which is all a space capability may simulate. */
  listForSpace(spaceName: string): PendingChatAction[] {
    return this.list().filter(({ action }) => chatActionSpaceName(action) === spaceName);
  }

  remove(id: number): void {
    this.#kv.delete(`chat:action:${id}`);
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
}

// ── Shared capability plumbing ──────────────────────────────────────

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
  return ctx.queue.authorizeObservation({ title, description });
}

/** Queue one action for approval, dropping the local record if the queue refuses it. */
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

/** Base class for every Chat capability: the shared context plus one approval-queue reference. */
class ChatRpcTarget extends ApprovalQueueRpcTarget {
  protected readonly ctx: ChatContext;

  constructor(ctx: ChatContext) {
    super(ctx.queue);
    this.ctx = ctx;
  }
}

function chatCursor<Item, Entry>(
  ctx: ChatContext,
  options: Omit<CursorPagerOptions<Item, Entry>, "provider">,
): Cursor<Entry> {
  return new RpcCursor(new CursorPager({ provider: "Google Chat", ...options }), ctx.queue);
}

type FetchPage<Item> = (pageToken: string | undefined) => Promise<ChatPage<Item>>;

/** A cursor of messages, each paired with a capability that is disposed if its page is refused. */
function messageCursor(
  ctx: ChatContext,
  fetchPage: FetchPage<GoogleChatMessageInfo>,
  title: string,
  describe: (count: number) => string,
): Cursor<GoogleChatMessageEntry> {
  return chatCursor(ctx, {
    fetchPage,
    buildEntries: async items => items.map(info => ({
      info, message: new GoogleChatMessageImpl(ctx, info.name),
    })),
    authorize: entries => observe(ctx, title, describe(entries.length)),
    disposeEntries: entries => {
      for (const entry of entries) (entry.message as GoogleChatMessageImpl)[Symbol.dispose]();
    },
  });
}

/** A cursor of conversations, each paired with a capability disposed if its page is refused. */
function spaceCursor(
  ctx: ChatContext,
  fetchPage: FetchPage<GoogleChatSpaceInfo>,
  title: string,
): Cursor<GoogleChatSpaceEntry> {
  return chatCursor(ctx, {
    fetchPage,
    buildEntries: async items => items.map(info => ({
      info, space: new GoogleChatSpaceImpl(ctx, info.name),
    })),
    authorize: entries => observe(
      ctx, title,
      `Read the names and metadata of ${entries.length} conversation(s) this account can see.`),
    disposeEntries: entries => {
      for (const entry of entries) (entry.space as GoogleChatSpaceImpl)[Symbol.dispose]();
    },
  });
}

/**
 * Where a message name currently points.
 *
 * A capability returned by `sendMessage` starts out naming a queued message; once that message
 * has been committed, the recorded provider name takes over, so the same capability keeps working
 * without the caller having to look the message up again.
 */
function resolveMessage(
  ctx: ChatContext,
  name: string,
): { committed: string } | { queued: number; action: ChatSendMessageAction } {
  const queued = pendingMessageActionId(name);
  if (queued === undefined) return { committed: name };
  const sent = ctx.store.sentMessage(queued);
  if (sent !== undefined) return { committed: sent };
  const action = ctx.store.get(queued);
  if (action?.type !== "sendMessage") throw new Error("This message was never created.");
  return { queued, action };
}

/** The conversation a message name belongs to, validating the name along the way. */
function messageSpaceName(ctx: ChatContext, name: string): string {
  const target = resolveMessage(ctx, name);
  return "committed" in target
    ? `spaces/${chatMessageParts(target.committed).spaceId}`
    : target.action.spaceName;
}

/** Undo a send, counting a message already removed in Google Chat as success. */
async function deleteMessageIfPresent(api: ChatApi, messageName: string): Promise<void> {
  try {
    if ((await api.getMessage(messageName)).deleted) return;
  } catch (error) {
    if (isChatNoAccessError(error)) return;
    throw error;
  }
  await api.deleteMessage(messageName);
}

// ── Outgoing messages ───────────────────────────────────────────────

function validateMessageText(text: string): string {
  if (text.trim().length === 0) throw new Error("A message needs some text.");
  if (new TextEncoder().encode(text).byteLength > MAX_CHAT_MESSAGE_BYTES) {
    throw new Error(`A Chat message must be at most ${MAX_CHAT_MESSAGE_BYTES} bytes.`);
  }
  return text;
}

/**
 * Queue one outgoing text message for approval.
 *
 * Shared by `GoogleChatSpace.sendMessage()` and `GoogleChatMessage.reply()`; the only difference
 * between them is whether a thread is named.
 */
async function queueChatMessage(
  ctx: ChatContext,
  spaceName: string,
  text: string,
  threadName?: string,
): Promise<GoogleChatMessage> {
  const body = validateMessageText(text);
  const info = await ctx.api.getSpace(spaceName);
  const action: ChatSendMessageAction = {
    type: "sendMessage",
    spaceName,
    text: body,
    ...(threadName !== undefined ? { threadName } : {}),
    requestId: crypto.randomUUID(),
    submittedAt: Date.now(),
  };
  const actionId = await submitChatAction(ctx, action, {
    title: `Send a Google Chat message to ${info.displayName ?? spaceName}`,
    description:
      `Post a message as ${userLabel(ctx.self)} in ${spaceLabel(info)}` +
      `${threadName !== undefined ? `, as a reply in thread ${threadName}` : ""}.` +
      `\n\n> ${previewText(body, 1000)}`,
    implementsRevert: true,
    actionKind: SEND_MESSAGE_ACTION,
    autoApprovable: true,
  });
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
    return spaceCursor(
      this.ctx,
      pageToken => this.ctx.api.listSpaces({
        ...(options.types ? { types: options.types } : {}),
        ...(pageToken ? { pageToken } : {}),
      }),
      "List Google Chat conversations");
  }

  async searchSpaces(displayName: string): Promise<Cursor<GoogleChatSpaceEntry>> {
    return spaceCursor(
      this.ctx,
      pageToken => this.ctx.api.searchSpaces(displayName, pageToken ? { pageToken } : {}),
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
    // Search is provider-backed rather than simulated: overlaying pending edits after Google has
    // applied its filter can return non-matches and cannot discover newly matching messages.
    return messageCursor(
      this.ctx,
      pageToken => this.ctx.api.searchMessages("spaces/-", {
        filter, ...(pageToken ? { pageToken } : {}),
      }),
      "Search Google Chat messages",
      count => `Read ${count} message(s) matching a search across the conversations this ` +
        "account can see.");
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
    return messageCursor(
      this.ctx,
      async pageToken => {
        const page = await this.ctx.api.listMessages(this.#spaceName, {
          ...options, ...(pageToken ? { pageToken } : {}),
        });
        // Pending actions are re-read for every page so that an action applied or rejected
        // mid-walk is reflected by the next page rather than shown twice or as a ghost.
        return {
          ...page,
          items: overlayMessageList(page.items, this.ctx.store.listForSpace(this.#spaceName), {
            spaceName: this.#spaceName,
            self: this.ctx.self,
            options,
            first: pageToken === undefined,
            exhausted: page.nextPageToken === undefined,
          }),
        };
      },
      "Read Google Chat messages",
      count => `Read ${count} message(s) from ${this.#spaceName}, including sender, text, ` +
        "attachments, and reactions.");
  }

  async getMessage(name: string): Promise<GoogleChatMessage> {
    if (messageSpaceName(this.ctx, name) !== this.#spaceName) {
      throw new Error("That message belongs to a different conversation.");
    }
    return new GoogleChatMessageImpl(this.ctx, name);
  }

  async listMembers(): Promise<Cursor<GoogleChatMembership>> {
    return chatCursor(this.ctx, {
      fetchPage: pageToken =>
        this.ctx.api.listMembers(this.#spaceName, pageToken ? { pageToken } : {}),
      buildEntries: async items => items,
      authorize: entries => observe(
        this.ctx,
        "List Google Chat conversation members",
        `Read ${entries.length} membership(s) of ${this.#spaceName}, including each member's ` +
        "identity and role."),
    });
  }

  async findMember(user: string): Promise<GoogleChatMembership | null> {
    const membership = await this.ctx.api.getMembership(this.#spaceName, user);
    await observe(
      this.ctx,
      "Look up a Google Chat conversation member",
      membership
        ? `${chatUserName(user)} is a ${membership.role} of ${this.#spaceName}.`
        : `${chatUserName(user)} is not a member of ${this.#spaceName}.`);
    return membership;
  }

  async sendMessage(text: string): Promise<GoogleChatMessage> {
    return queueChatMessage(this.ctx, this.#spaceName, text);
  }
}

// ── Message capability ──────────────────────────────────────────────

@validateRpc()
class GoogleChatMessageImpl extends ChatRpcTarget implements GoogleChatMessage {
  #name: string;

  constructor(ctx: ChatContext, name: string) {
    super(ctx);
    requireInScope(ctx, messageSpaceName(ctx, name));
    this.#name = name;
  }

  /** The provider name, for operations Chat can only perform on a committed message. */
  #committed(operation: string): string {
    const target = resolveMessage(this.ctx, this.#name);
    if ("queued" in target) {
      throw new Error(
        `This message has not been committed to Google Chat yet, so it cannot be ${operation}.`);
    }
    return target.committed;
  }

  #pending(): PendingChatAction[] {
    return this.ctx.store.listForSpace(messageSpaceName(this.ctx, this.#name));
  }

  /** The message as the caller should currently see it, queued changes included. */
  async #info(): Promise<GoogleChatMessageInfo> {
    const target = resolveMessage(this.ctx, this.#name);
    if ("queued" in target) return pendingMessageInfo(target.queued, target.action, this.ctx.self);
    return overlayMessage(await this.ctx.api.getMessage(target.committed), this.#pending());
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
    return new GoogleChatSpaceImpl(this.ctx, messageSpaceName(this.ctx, this.#name));
  }

  async reply(text: string): Promise<GoogleChatMessage> {
    const info = await this.ctx.api.getMessage(this.#committed("replied to"));
    if (info.threadName === undefined) {
      throw new Error(
        "This conversation does not support threaded replies; send a new message instead.");
    }
    return queueChatMessage(this.ctx, info.spaceName, text, info.threadName);
  }

  async updateText(text: string): Promise<void> {
    const name = this.#committed("edited");
    const body = validateMessageText(text);
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "updateMessage", messageName: name, text: body, submittedAt: Date.now(),
    }, {
      title: `Edit a Google Chat message in ${current.spaceName}`,
      description:
        `Replace the text of message ${name}, sent by ${userLabel(current.sender)}.` +
        `\n\n**Current:** ${previewText(current.text, 500)}` +
        `\n\n**New:** ${previewText(body, 500)}`,
      implementsRevert: true,
      actionKind: EDIT_MESSAGE_ACTION,
      autoApprovable: true,
    });
  }

  async listReactions(): Promise<Cursor<GoogleChatReaction>> {
    const name = this.#committed("read for reactions");
    // Fetched only to run the private-message check: reactions.list itself never reads the
    // parent, so without this a reaction listing would be the one surface reachable for a
    // message every other read refuses to expose.
    await this.ctx.api.getMessage(name);
    return chatCursor(this.ctx, {
      fetchPage: async pageToken => {
        const page = await this.ctx.api.listReactions(name, pageToken ? { pageToken } : {});
        return {
          ...page,
          items: overlayReactions(page.items, this.#pending(), {
            messageName: name,
            self: this.ctx.self,
            exhausted: page.nextPageToken === undefined,
          }),
        };
      },
      buildEntries: async items => items,
      authorize: entries => observe(
        this.ctx,
        "List Google Chat reactions",
        `Read ${entries.length} reaction(s) on message ${name}, including who reacted.`),
    });
  }

  async addReaction(emoji: string): Promise<void> {
    const name = this.#committed("reacted to");
    const value = validateChatEmoji(emoji);
    // Reading the message both runs the private-message check — reactions.create never reads the
    // parent — and names the sender in the approval description.
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "addReaction", messageName: name, emoji: value, submittedAt: Date.now(),
    }, {
      title: `React ${value} to a Google Chat message`,
      description:
        `Add the reaction ${value} to message ${name}, sent by ${userLabel(current.sender)}, ` +
        `as ${userLabel(this.ctx.self)}.`,
      implementsRevert: true,
      actionKind: REACTION_ACTION,
      autoApprovable: true,
    });
  }

  async removeReaction(emoji: string): Promise<void> {
    const name = this.#committed("reacted to");
    const value = validateChatEmoji(emoji);
    // Same as addReaction: the read is the private-message check.
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "removeReaction", messageName: name, emoji: value, submittedAt: Date.now(),
    }, {
      title: `Remove the ${value} reaction from a Google Chat message`,
      description:
        `Remove ${userLabel(this.ctx.self)}'s own ${value} reaction from message ${name}, ` +
        `sent by ${userLabel(current.sender)}.`,
      implementsRevert: true,
      actionKind: REACTION_ACTION,
      autoApprovable: true,
    });
  }

  async attachments(): Promise<GoogleChatAttachmentEntry[]> {
    const name = this.#committed("read for attachments");
    const raw = await this.ctx.api.getRawMessage(name);
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
  #tokens = new AccessTokenCache(opts => {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  #api(): ChatApi {
    return new ChatApi(opts => this.#tokens.get(opts));
  }

  #boundSpaceName(): string | undefined {
    const spaceId = this.ctx.props.spaceId;
    return spaceId === undefined ? undefined : `spaces/${validateChatSpaceId(spaceId)}`;
  }

  /**
   * The connected account's own Chat identity.
   *
   * The account's stable subject is pinned on first use, so a binding whose credentials later
   * follow a reconnect to a different Google account refuses to run instead of answering as
   * though it were still the original one — "my own messages" would otherwise silently mean
   * somebody else's.
   */
  async #getSelf(): Promise<GoogleChatUser> {
    const profile = await getGoogleAccountProfile(await this.#tokens.get());
    const pinned = this.ctx.storage.kv.get<string>("chat:accountSubject");
    if (pinned === undefined) {
      this.ctx.storage.kv.put("chat:accountSubject", profile.sub);
    } else if (pinned !== profile.sub) {
      throw new Error(
        "This Google Chat binding belongs to a different Google account. Reconnect the " +
        "original account.");
    }
    return {
      name: `users/${profile.sub}`,
      ...(profile.name ? { displayName: profile.name } : {}),
      type: "human",
    };
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
    const revert = await this.#perform(store, actionId, action);
    store.setRevert(actionId, revert);
    store.remove(actionId);
  }

  /** Send one action to Google, returning what a later revert needs to know. */
  async #perform(
    store: ChatStore,
    actionId: number,
    action: ChatAction,
  ): Promise<ChatRevertInfo> {
    const api = this.#api();
    switch (action.type) {
      case "sendMessage": {
        // The request id makes Chat itself idempotent, so a retry after a lost response returns
        // the message the first attempt created rather than posting a second one.
        const created = await api.createMessage(action.spaceName, {
          text: action.text,
          ...(action.threadName !== undefined ? { threadName: action.threadName } : {}),
        }, { requestId: action.requestId });
        store.setSentMessage(actionId, created.name);
        return { type: "sentMessage", messageName: created.name };
      }
      case "updateMessage": {
        const previous = await api.getMessage(action.messageName);
        await api.updateMessageText(action.messageName, action.text);
        return {
          type: "updatedMessage", messageName: action.messageName, previousText: previous.text,
        };
      }
      case "addReaction": {
        // Re-fetching the message re-runs the private-message check at apply time.
        await api.getMessage(action.messageName);
        // Adding a reaction twice is an error, so a retry reuses the one already there.
        const self = await this.#getSelf();
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.name);
        if (existing) return { type: "none" };
        const reaction = await api.createReaction(action.messageName, action.emoji);
        return { type: "addedReaction", reactionName: reaction.name };
      }
      case "removeReaction": {
        await api.getMessage(action.messageName);
        const self = await this.#getSelf();
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.name);
        if (!existing) return { type: "none" };
        await api.deleteReaction(existing.name);
        return { type: "removedReaction", messageName: action.messageName, emoji: action.emoji };
      }
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
        try {
          await deleteMessageIfPresent(api, info.messageName);
        } catch (error) {
          // Chat refuses a non-force delete of a message with threaded replies, and force would
          // cascade into deleting other people's replies. Leave the revert record so a retry
          // works once the replies are gone.
          if (error instanceof ChatApiError && error.rpcCode === "FAILED_PRECONDITION") {
            return {
              message: "This message has threaded replies, so it cannot be un-sent " +
                "automatically. Delete it in Google Chat.",
              canRetry: true,
            };
          }
          throw error;
        }
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
