// Google Chat gatekeeper: user-authenticated access to the connected account's conversations.
//
// Two resource granularities share this Durable Object class, distinguished by `props.spaceId`:
//
//   - Whole account (`GoogleChatSession`). Discovery and cross-space search, handing out narrower
//     space capabilities. Observers: strategy A — a Chat account spans direct messages and
//     unrelated conversations, so there is no baseline a collaborator could be verified against
//     and addObserver() always throws.
//   - One conversation (`ChatSpace`). Observers: strategy C — verify the space ACL plus any
//     People-sourced participant name used to label an otherwise unnamed direct message.
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
  chatAttachmentInfoFromRaw, chatAttachmentMediaName, chatMessageInfoFromRaw, chatMessageParts,
  chatMessagesSearchFilter, chatReactionParts,
  chatSpaceId, chatThreadParts, chatUserName, validateChatEmoji,
  validateChatSpaceId, validateChatWindow,
} from "./chat-api";
import {
  ChatAction, ChatSendMessageAction, PendingChatAction, chatActionSpaceName,
  overlayMessage, overlayMessageList, overlayReactions, pendingMessageActionId,
  pendingMessageInfo, pendingMessageName, pendingThreadActionId, pendingThreadName,
} from "./chat-state";
import type {
  Cursor, ChatAttachment, ChatAttachmentEntry, ChatAttachmentInfo,
  ChatListMessagesOptions, ChatListSpacesOptions,
  ChatMembership, ChatMessage, ChatMessageEntry, ChatMessageInfo,
  ChatMessageSearch, ChatReaction, GoogleChatSession,
  ChatSpace, ChatSpaceEntry, ChatSpaceInfo, ChatUser, ChatThread, ChatThreadEntry, ChatThreadInfo,
  ChatWindow,
} from "./chat-types";
import { getGoogleAccountProfile } from "./google-api";
import { AccessTokenCache } from "./auth-retry";
import { CursorPager, CursorPagerOptions } from "./cursor";
import { ApprovalQueueRpcTarget, RpcCursor, SharedApprovalQueue } from "./shared-approval-queue";
import type { GoogleVerifierApi } from "./google-verifier-types";
import CHAT_TYPES_CODE from "./chat-types.txt";
import { ChatDmNames, type ChatProfileName } from "./chat-dm-names";
import { chatNameObservers } from "./chat-name-observers";

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
type ChatRevertInfo = (
  | { type: "none" }
  | { type: "sentMessage"; messageName: string }
  | { type: "updatedMessage"; messageName: string; previousText: string }
  | { type: "addedReaction"; reactionName: string }
  | { type: "addedReaction"; messageName: string; emoji: string }
  | { type: "removedReaction"; messageName: string; emoji: string }
) & { threadScope?: string };

function previewText(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/** How a conversation is named in approval and observation text. */
function spaceLabel(info: ChatSpaceInfo): string {
  if (info.name) return `"${info.name}" (${info.id})`;
  return info.type === "directMessage"
    ? `a direct message (${info.id})`
    : `an unnamed conversation (${info.id})`;
}

function userLabel(user: ChatUser | undefined): string {
  return user?.name ?? user?.id ?? "an unknown user";
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
    return this.list().filter(({ action }) => {
      if (chatActionSpaceName(action) !== spaceName) return false;
      if (action.type === "sendMessage" && action.threadName) {
        const root = pendingThreadActionId(this.threadName(action.threadName));
        if (root !== undefined && this.get(root)?.type !== "sendMessage") return false;
      }
      return true;
    })
      .map(entry => {
        const { action } = entry;
        if (action.type === "sendMessage" && action.threadName) {
          return { ...entry, action: { ...action, threadName: this.threadName(action.threadName) } };
        }
        if (action.type === "updateMessage") {
          const id = pendingMessageActionId(action.messageName);
          const messageName = id === undefined ? action.messageName
            : this.sentMessage(id) ?? action.messageName;
          return { ...entry, action: { ...action, messageName } };
        }
        return entry;
      });
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
  setSentMessage(actionId: number, message: ChatMessageInfo): void {
    this.#kv.put(`chat:sent:${actionId}`, message.id);
    if (message.threadId) this.#kv.put(`chat:thread:${actionId}`, message.threadId);
  }

  sentMessage(actionId: number): string | undefined {
    return this.#kv.get<string>(`chat:sent:${actionId}`);
  }

  /** A temporary thread reference continues to identify its thread after the root is sent. */
  threadName(name: string): string {
    const id = pendingThreadActionId(name);
    return id === undefined ? name : this.#kv.get<string>(`chat:thread:${id}`) ?? name;
  }
}

// ── Shared capability plumbing ──────────────────────────────────────

/** What every Chat capability needs, whatever granularity it came from. */
type ChatContext = {
  api: ChatApi;
  queue: SharedApprovalQueue;
  store: ChatStore;
  self: ChatUser;
  dmNames: ChatDmNames;
  nameObservers?: ReturnType<typeof chatNameObservers>;
  /** Set for a single-conversation binding: the only space any capability may reach. */
  readonly boundSpace?: string;
  /** Immutable thread boundary inherited by every capability descended from a thread. */
  readonly boundThread?: string;
};

type ChatScope = Pick<ChatContext, "store" | "boundSpace" | "boundThread">;

function requireInScope(ctx: Pick<ChatContext, "boundSpace">, spaceName: string): string {
  if (ctx.boundSpace !== undefined && spaceName !== ctx.boundSpace) {
    throw new Error("This connection only covers one Google Chat conversation.");
  }
  return spaceName;
}

function requireThreadInScope(ctx: ChatScope, threadName: string | undefined): void {
  if (ctx.boundThread !== undefined && (threadName === undefined ||
      ctx.store.threadName(threadName) !== ctx.store.threadName(ctx.boundThread))) {
    throw new Error("This capability only covers one Google Chat thread.");
  }
}

function requireMessageInScope(ctx: ChatScope, info: ChatMessageInfo): void {
  requireInScope(ctx, info.spaceId);
  requireThreadInScope(ctx, info.threadId);
}

async function observe(
  ctx: ChatContext, title: string, description: string, profiles: ChatProfileName[] = [],
): Promise<void> {
  const check = await ctx.nameObservers?.prepareObservation(profiles);
  await ctx.queue.authorizeObservation({ title, description, excludeObservers: check?.excludeObservers });
  check?.commit();
}

/** Queue one action for approval, dropping the local record if the queue refuses it. */
async function submitChatAction(
  ctx: ChatContext,
  action: ChatAction,
  description: ActionDescription,
): Promise<number> {
  if (ctx.boundThread !== undefined) action = { ...action, threadScope: ctx.boundThread };
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
  fetchPage: FetchPage<ChatMessageInfo>,
  title: string,
  describe: (count: number) => string,
): Cursor<ChatMessageEntry> {
  return chatCursor(ctx, {
    fetchPage,
    buildEntries: async items => {
      for (const info of items) requireMessageInScope(ctx, info);
      return items.map(info => ({ info, message: new ChatMessageImpl(ctx, info.id) }));
    },
    authorize: entries => observe(ctx, title, describe(entries.length)),
    disposeEntries: entries => {
      for (const entry of entries) (entry.message as ChatMessageImpl)[Symbol.dispose]();
    },
  });
}

/** A cursor of conversations, each paired with a capability disposed if its page is refused. */
function spaceCursor(
  ctx: ChatContext,
  fetchPage: FetchPage<ChatSpaceInfo>,
  title: string,
): Cursor<ChatSpaceEntry> {
  return chatCursor(ctx, {
    fetchPage,
    buildEntries: async items => items.map(info => ({ info, space: new ChatSpaceImpl(ctx, info.id) })),
    authorize: entries => observe(
      ctx, title,
      `Read the names and metadata of ${entries.length} conversation(s) this account can see.`),
    disposeEntries: entries => {
      for (const entry of entries) (entry.space as ChatSpaceImpl)[Symbol.dispose]();
    },
  });
}

/**
 * Where a message name currently points.
 *
 * A capability returned by `post` starts out naming a queued message; once that message
 * has been committed, the recorded provider name takes over, so the same capability keeps working
 * without the caller having to look the message up again.
 */
function resolveMessage(
  ctx: Pick<ChatContext, "store">,
  name: string,
): { committed: string } | { queued: number; action: ChatSendMessageAction } {
  const queued = pendingMessageActionId(name);
  if (queued === undefined) return { committed: name };
  const sent = ctx.store.sentMessage(queued);
  if (sent !== undefined) return { committed: sent };
  const action = ctx.store.get(queued);
  if (action?.type !== "sendMessage") throw new Error("This message was never created.");
  if (action.threadName) resolveThread(ctx, action.threadName);
  return { queued, action };
}

/** The conversation a message name belongs to, validating the name along the way. */
function messageSpaceName(ctx: ChatContext, name: string): string {
  const target = resolveMessage(ctx, name);
  return "committed" in target
    ? `spaces/${chatMessageParts(target.committed).spaceId}`
    : target.action.spaceName;
}

/** Resolve a thread within the originating binding, including a root still waiting to send. */
function resolveThread(ctx: ChatScope, name: string) {
  name = ctx.store.threadName(name);
  requireThreadInScope(ctx, name);
  const id = pendingThreadActionId(name);
  if (id !== undefined) {
    const action = ctx.store.get(id);
    if (action?.type !== "sendMessage" || !action.startsThread) {
      throw new Error("This thread's root message was never created.");
    }
    return { name, spaceName: requireInScope(ctx, action.spaceName), pending: true };
  }
  const spaceName = requireInScope(ctx, `spaces/${chatThreadParts(name).spaceId}`);
  return { name, spaceName, pending: false };
}

/** One history implementation for both space and thread capabilities. */
function messagePages(
  ctx: ChatContext, spaceName: string, options: ChatListMessagesOptions, threadName?: string,
): FetchPage<ChatMessageInfo> {
  threadName ??= ctx.boundThread;
  // Copy only public fields; a caller cannot inject a provider thread filter through extra keys.
  const window = { since: options.since, before: options.before, order: options.order };
  validateChatWindow(window);
  return async pageToken => {
    const thread = threadName === undefined ? undefined : resolveThread(ctx, threadName);
    const page: ChatPage<ChatMessageInfo> = thread?.pending ? { items: [] }
      : await ctx.api.listMessages(spaceName, { ...window, threadName: thread?.name, pageToken });
    return {
      ...page,
      // Re-read on each page/retry: an applied or rejected action must not leave a ghost behind.
      items: overlayMessageList(page.items, ctx.store.listForSpace(spaceName), {
        spaceName, self: ctx.self, options: window, threadName: thread?.name,
        first: pageToken === undefined, exhausted: page.nextPageToken === undefined,
      }),
    };
  };
}

/** Read one visible page without scanning the thread to enrich metadata or locate its root. */
async function readThreadPage(
  ctx: ChatContext, name: string,
  metadata = false,
): Promise<ChatMessageInfo[] | null> {
  const thread = resolveThread(ctx, name);
  const pager = new CursorPager({
    provider: "Google Chat",
    fetchPage: messagePages(ctx, thread.spaceName, { order: metadata ? "newestFirst" : "oldestFirst" }, name),
    buildEntries: async items => items,
    authorize: () => observe(ctx,
      metadata ? "Read Google Chat thread metadata" : "Open a Google Chat thread",
      `Read a page of messages in ${name}.`),
  });
  const page = await pager.next();
  if (page?.length === 0) {
    throw new Error("Thread lookup exceeded its page budget. Use listMessages() to scan the history.");
  }
  return page;
}

/** Undo a send, counting a message already removed in Google Chat as success. */
async function deleteMessageIfPresent(
  api: ChatApi, messageName: string, scope: ChatScope,
): Promise<void> {
  try {
    const message = await api.getMessage(messageName);
    requireMessageInScope(scope, message);
    if (message.deleted) return;
    await api.deleteMessage(messageName);
  } catch (error) {
    if (error instanceof ChatApiError && error.status === 404) return;
    throw error;
  }
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
 * Shared by space sends and thread/message replies; the only difference
 * between them is whether a thread is named.
 */
async function queueChatMessage(
  ctx: ChatContext,
  spaceName: string,
  text: string,
  destination?: { threadName: string } | { startThread: true },
): Promise<number> {
  const body = validateMessageText(text);
  const info = await ctx.api.getSpace(spaceName);
  if (destination && !info.supportsThreads) {
    throw new Error("This conversation does not support threaded replies.");
  }
  let threadName = destination && "threadName" in destination ? destination.threadName : undefined;
  requireInScope(ctx, spaceName);
  requireThreadInScope(ctx, threadName);
  if (threadName !== undefined) {
    const thread = resolveThread(ctx, threadName);
    if (thread.spaceName !== spaceName) throw new Error("That thread belongs to a different conversation.");
    threadName = thread.name;
  }
  const action: ChatSendMessageAction = {
    type: "sendMessage",
    spaceName,
    text: body,
    ...(threadName !== undefined ? { threadName } : {}),
    startsThread: threadName === undefined && info.supportsThreads,
    requestId: crypto.randomUUID(),
    submittedAt: Date.now(),
  };
  return submitChatAction(ctx, action, {
    title: `Send a Google Chat message to ${info.name ?? spaceName}`,
    description:
      `Post a message as ${userLabel(ctx.self)} in ${spaceLabel(info)}` +
      `${threadName !== undefined ? `, as a reply in thread ${threadName}` : ""}.` +
      `\n\n> ${previewText(body, 1000)}`,
    implementsRevert: true,
    actionKind: SEND_MESSAGE_ACTION,
    autoApprovable: true,
  });
}

// ── Account session ─────────────────────────────────────────────────

@validateRpc()
class GoogleChatSessionImpl extends ChatRpcTarget implements GoogleChatSession {
  async getCurrentUser(): Promise<ChatUser> {
    await observe(
      this.ctx,
      "Read the connected Google Chat identity",
      "Read the connected account's own Chat user name and display name.");
    return this.ctx.self;
  }

  async listSpaces(
    options: ChatListSpacesOptions = {},
  ): Promise<Cursor<ChatSpaceEntry>> {
    return spaceCursor(
      this.ctx,
      pageToken => this.ctx.api.listSpaces({
        ...(options.types ? { types: options.types } : {}),
        ...(pageToken ? { pageToken } : {}),
      }),
      "List Google Chat conversations");
  }

  async searchSpaces(name: string): Promise<Cursor<ChatSpaceEntry>> {
    return spaceCursor(
      this.ctx,
      pageToken => this.ctx.api.searchSpaces(name, pageToken ? { pageToken } : {}),
      "Search Google Chat conversations");
  }

  async findDirectMessage(user: string): Promise<ChatSpace | null> {
    const info = await this.ctx.api.findDirectMessage(user);
    await observe(
      this.ctx,
      "Find a Google Chat direct message",
      info
        ? `Found the direct message with ${chatUserName(user)} (${info.id}).`
        : `No direct message exists with ${chatUserName(user)}.`);
    return info ? new ChatSpaceImpl(this.ctx, info.id) : null;
  }

  async getSpace(id: string): Promise<ChatSpace> {
    const info = await this.ctx.api.getSpace(`spaces/${chatSpaceId(id)}`);
    await observe(
      this.ctx,
      "Open a Google Chat conversation",
      `Confirm the connected account can open ${spaceLabel(info)}.`);
    return new ChatSpaceImpl(this.ctx, info.id);
  }

  async searchMessages(query: ChatMessageSearch): Promise<Cursor<ChatMessageEntry>> {
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
class ChatSpaceImpl extends ChatRpcTarget implements ChatSpace {
  #spaceName: string;

  constructor(ctx: ChatContext, spaceName: string) {
    spaceName = requireInScope(ctx, `spaces/${chatSpaceId(spaceName)}`);
    super(ctx);
    this.#spaceName = spaceName;
  }

  async getMetadata(): Promise<ChatSpaceInfo> {
    const raw = await this.ctx.api.getSpace(this.#spaceName);
    requireInScope(this.ctx, raw.id);
    const [{ info, profile }] = await this.ctx.dmNames.resolve([raw], async () => this.ctx.self.id);
    await observe(
      this.ctx,
      "Read Google Chat conversation metadata",
      `Read the name, type, and description of ${spaceLabel(info)}.`, profile ? [profile] : []);
    return info;
  }

  async listMessages(
    options: ChatListMessagesOptions = {},
  ): Promise<Cursor<ChatMessageEntry>> {
    return messageCursor(
      this.ctx,
      messagePages(this.ctx, this.#spaceName, options),
      "Read Google Chat messages",
      count => `Read ${count} message(s) from ${this.#spaceName}, including sender, text, ` +
        "attachments, and reactions.");
  }

  async listThreads(window: ChatWindow = {}): Promise<Cursor<ChatThreadEntry>> {
    const fetchPage = messagePages(this.ctx, this.#spaceName, {
      since: window.since, before: window.before, order: "newestFirst",
    });
    const { supportsThreads } = await this.ctx.api.getSpace(this.#spaceName);
    let seen = new Set<string>();
    return chatCursor(this.ctx, {
      fetchPage: supportsThreads ? fetchPage : async () => ({ items: [] }),
      buildEntries: async items => {
        // Previously disclosed pending roots may have gained their provider names since last page.
        seen = new Set([...seen].map(name => this.ctx.store.threadName(name)));
        const fresh = new Map<string, ChatThreadInfo>();
        for (const message of items) {
          if (!message.threadId) continue;
          const thread = resolveThread(this.ctx, message.threadId);
          if (thread.spaceName !== this.#spaceName) {
            throw new Error("Google Chat returned a thread from a different conversation.");
          }
          if (seen.has(thread.name)) continue;
          let info = fresh.get(thread.name);
          if (!info) {
            info = { id: thread.name, spaceId: this.#spaceName, latestMessage: message };
            fresh.set(thread.name, info);
          }
          if (!message.isReply) info.rootMessage = message;
        }
        if (seen.size + fresh.size > 5_000) {
          throw new Error("Too many Google Chat threads. Use a narrower time window.");
        }
        return [...fresh.values()].map(info => ({
          info, thread: new ChatThreadImpl(this.ctx, info.id),
        }));
      },
      authorize: async entries => {
        await observe(this.ctx, "List Google Chat threads",
          `Read ${entries.length} thread(s) and their latest matching messages in ${this.#spaceName}.`);
        // A denied page must neither advance the provider cursor nor hide its threads on retry.
        for (const entry of entries) seen.add(entry.info.id);
      },
      disposeEntries: entries => {
        for (const entry of entries) entry.thread[Symbol.dispose]();
      },
    });
  }

  async getThread(id: string): Promise<ChatThread> {
    if (resolveThread(this.ctx, id).spaceName !== this.#spaceName) {
      throw new Error("That thread belongs to a different conversation.");
    }
    if (!(await this.ctx.api.getSpace(this.#spaceName)).supportsThreads) {
      throw new Error("This conversation does not support threaded replies.");
    }
    if (!(await readThreadPage(this.ctx, id))) throw new Error("This thread is not available.");
    return new ChatThreadImpl(this.ctx, id);
  }

  async getMessage(id: string): Promise<ChatMessage> {
    if (messageSpaceName(this.ctx, id) !== this.#spaceName) {
      throw new Error("That message belongs to a different conversation.");
    }
    const message = new ChatMessageImpl(this.ctx, id);
    try {
      if ((await message.getMetadata()).deleted) throw new Error("This message is no longer available.");
      return message;
    } catch (error) {
      message[Symbol.dispose]();
      throw error;
    }
  }

  async listMembers(): Promise<Cursor<ChatMembership>> {
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

  async findMember(user: string): Promise<ChatMembership | null> {
    const membership = await this.ctx.api.getMembership(this.#spaceName, user);
    await observe(
      this.ctx,
      "Look up a Google Chat conversation member",
      membership
        ? `${chatUserName(user)} is a ${membership.role} of ${this.#spaceName}.`
        : `${chatUserName(user)} is not a member of ${this.#spaceName}.`);
    return membership;
  }

  async post(text: string): Promise<ChatMessage> {
    const id = await queueChatMessage(this.ctx, this.#spaceName, text);
    return new ChatMessageImpl(this.ctx, pendingMessageName(id));
  }

  async startThread(text: string): Promise<ChatThread> {
    const id = await queueChatMessage(this.ctx, this.#spaceName, text, { startThread: true });
    return new ChatThreadImpl(this.ctx, pendingThreadName(id));
  }
}

// ── Thread capability ───────────────────────────────────────────────

@validateRpc()
class ChatThreadImpl extends ChatRpcTarget implements ChatThread {
  #name: string;

  constructor(ctx: ChatContext, name: string) {
    const thread = resolveThread(ctx, name);
    super({ ...ctx, boundSpace: thread.spaceName, boundThread: name });
    this.#name = name;
  }

  async getMetadata(): Promise<ChatThreadInfo> {
    const thread = resolveThread(this.ctx, this.#name);
    const messages = await readThreadPage(this.ctx, this.#name, true);
    if (!messages) throw new Error("This thread is not available.");
    const rootMessage = messages.find(message => !message.isReply);
    return {
      id: thread.name, spaceId: thread.spaceName, latestMessage: messages[0],
      ...(rootMessage ? { rootMessage } : {}),
    };
  }

  async getRootMessage(): Promise<ChatMessage | null> {
    const first = (await readThreadPage(this.ctx, this.#name))?.[0];
    return first && !first.isReply ? new ChatMessageImpl(this.ctx, first.id) : null;
  }

  async listMessages(options: ChatListMessagesOptions = {}): Promise<Cursor<ChatMessageEntry>> {
    const thread = resolveThread(this.ctx, this.#name);
    return messageCursor(this.ctx, messagePages(this.ctx, thread.spaceName, options, this.#name),
      "Read Google Chat thread messages", count => `Read ${count} message(s) in ${this.#name}.`);
  }

  async post(text: string): Promise<ChatMessage> {
    const thread = resolveThread(this.ctx, this.#name);
    const id = await queueChatMessage(this.ctx, thread.spaceName, text, { threadName: this.#name });
    return new ChatMessageImpl(this.ctx, pendingMessageName(id));
  }
}

// ── Message capability ──────────────────────────────────────────────

@validateRpc()
class ChatMessageImpl extends ChatRpcTarget implements ChatMessage {
  #name: string;

  constructor(ctx: ChatContext, name: string) {
    requireInScope(ctx, messageSpaceName(ctx, name));
    super(ctx);
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
  async #info(): Promise<ChatMessageInfo> {
    const target = resolveMessage(this.ctx, this.#name);
    const info = "queued" in target ? pendingMessageInfo(target.queued, target.action, this.ctx.self)
      : await this.ctx.api.getMessage(target.committed);
    requireMessageInScope(this.ctx, info);
    return overlayMessage(info, this.#pending());
  }

  async getMetadata(): Promise<ChatMessageInfo> {
    const info = await this.#info();
    await observe(
      this.ctx,
      "Read a Google Chat message",
      `Read the sender, text, attachments, and reactions of message ${info.id} in ` +
      `${info.spaceId}.`);
    return info;
  }

  async reply(text: string): Promise<ChatMessage> {
    const info = await this.#info();
    if (info.threadId === undefined) {
      throw new Error(
        "This conversation does not support threaded replies; send a new message instead.");
    }
    const id = await queueChatMessage(this.ctx, info.spaceId, text, { threadName: info.threadId });
    return new ChatMessageImpl(this.ctx, pendingMessageName(id));
  }

  async edit(text: string): Promise<void> {
    const body = validateMessageText(text);
    const current = await this.#info();
    await submitChatAction(this.ctx, {
      type: "updateMessage", messageName: current.id, spaceName: current.spaceId,
      text: body, submittedAt: Date.now(),
    }, {
      title: `Edit a Google Chat message in ${current.spaceId}`,
      description:
        `Replace the text of message ${current.id}, sent by ${userLabel(current.sender)}.` +
        `\n\n**Current:** ${previewText(current.text, 500)}` +
        `\n\n**New:** ${previewText(body, 500)}`,
      implementsRevert: true,
      actionKind: EDIT_MESSAGE_ACTION,
      autoApprovable: true,
    });
  }

  async listReactions(): Promise<Cursor<ChatReaction>> {
    const name = this.#committed("read for reactions");
    return chatCursor(this.ctx, {
      fetchPage: async pageToken => {
        // Reaction pages don't read the parent; recheck its thread and private-message boundary.
        await this.#info();
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

  async listAttachments(): Promise<ChatAttachmentEntry[]> {
    if ("queued" in resolveMessage(this.ctx, this.#name)) {
      await this.getMetadata();
      return [];
    }
    const name = this.#committed("read for attachments");
    const raw = await this.ctx.api.getRawMessage(name);
    requireMessageInScope(this.ctx, chatMessageInfoFromRaw(raw));
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
      attachment: new ChatAttachmentImpl(this.ctx, name, info.id, mediaName),
    }));
  }
}

// ── Attachment capability ───────────────────────────────────────────

@validateRpc()
class ChatAttachmentImpl extends ChatRpcTarget implements ChatAttachment {
  #messageName: string;
  #attachmentId: string;
  #mediaName: string | undefined;

  constructor(
    ctx: ChatContext,
    messageName: string,
    attachmentId: string,
    mediaName: string | undefined,
  ) {
    super(ctx);
    this.#messageName = messageName;
    this.#attachmentId = attachmentId;
    this.#mediaName = mediaName;
  }

  async getMetadata(): Promise<ChatAttachmentInfo> {
    const info = chatAttachmentInfoFromRaw(await this.#current());
    await observe(
      this.ctx,
      "Read Google Chat attachment metadata",
      `Read the filename and media type of ${info.filename || "an attachment"}.`);
    return info;
  }

  async getContent(): Promise<ArrayBuffer> {
    const info = chatAttachmentInfoFromRaw(await this.#current());
    if (info.source === "drive") {
      throw new Error(
        "This attachment is a Google Drive file. Read it through a Google Drive connection.");
    }
    if (!this.#mediaName) throw new Error("This attachment's content is not available.");

    const content = await this.ctx.api.downloadAttachment(this.#mediaName);
    await observe(
      this.ctx,
      "Read a Google Chat attachment",
      `Read the full contents of ${info.filename || "an attachment"} ` +
      `(${info.mimeType}, ${content.byteLength} bytes).`);
    return content;
  }

  /** An attachment cannot outlive its message, its thread grant, or the account's access. */
  async #current() {
    const message = await this.ctx.api.getRawMessage(this.#messageName);
    requireMessageInScope(this.ctx, chatMessageInfoFromRaw(message));
    const current = (message.attachment ?? []).find(attachment =>
      attachment.name === this.#attachmentId &&
      chatAttachmentMediaName(attachment) === this.#mediaName);
    if (!current) throw new Error("This attachment is no longer available on its message.");
    return current;
  }
}

// ── Gatekeeper Durable Object ───────────────────────────────────────

@validateRpc()
export class GoogleChatGatekeeperImpl
    extends DurableObject<Env, GoogleChatGatekeeperImplProps>
    implements Gatekeeper<GoogleChatSession | ChatSpace> {
  #self?: ChatUser;
  #tokens = new AccessTokenCache(async opts => {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let token = await account.getAccessToken(opts);
    // Every newly loaded token is checked before either Chat or People can use it, including a
    // refresh on a live session. A reconnect must never silently change this binding's authority.
    const profile = await getGoogleAccountProfile(async retry => {
      if (retry) token = await account.getAccessToken(retry);
      return token.token;
    });
    const pinned = this.ctx.storage.kv.get<string>("chat:accountSubject");
    if (pinned !== undefined && pinned !== profile.sub) {
      throw new Error("This Google Chat binding belongs to a different Google account. Reconnect the original account.");
    }
    if (pinned === undefined) this.ctx.storage.kv.put("chat:accountSubject", profile.sub);
    this.#self = { id: `users/${profile.sub}`, ...(profile.name ? { name: profile.name } : {}), type: "human" };
    return token;
  });

  #api(): ChatApi {
    return new ChatApi(opts => this.#tokens.get(opts));
  }

  #dmNames = new ChatDmNames(this.#api(), opts => this.#tokens.get(opts));

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
  async #getSelf(): Promise<ChatUser> {
    await this.#tokens.get({ reloadStored: true });
    return this.#self!;
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
    const title = info.name ??
      (info.type === "directMessage" ? "Google Chat direct message" : "Google Chat conversation");
    return {
      url: info.url ?? `https://chat.google.com/room/${chatSpaceId(boundSpace)}`,
      title,
      snippet: `Google Chat conversation: ${title}`,
      suggestedBindingName: "GOOGLE_CHAT_SPACE",
      tsType: "ChatSpace",
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
  ): Promise<GoogleChatSession | ChatSpace> {
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
      dmNames: this.#dmNames,
      ...(boundSpace ? { nameObservers: chatNameObservers(this.ctx.storage.kv, boundSpace) } : {}),
      ...(boundSpace !== undefined ? { boundSpace } : {}),
    };
    return boundSpace === undefined
      ? new GoogleChatSessionImpl(ctx)
      : new ChatSpaceImpl(ctx, boundSpace);
  }

  async applyAction(actionId: number): Promise<void> {
    const store = new ChatStore(this.ctx.storage);
    const action = store.get(actionId);
    if (!action) {
      if (store.getRevert(actionId)) return; // The completion response may have been lost.
      throw new Error(`Unknown pending Google Chat action: ${actionId}`);
    }
    const self = await this.#getSelf();
    const revert = await this.#perform(store, actionId, action, self);
    store.setRevert(actionId, { ...revert, threadScope: action.threadScope });
    store.remove(actionId);
  }

  /** Send one action to Google, returning what a later revert needs to know. */
  async #perform(
    store: ChatStore,
    actionId: number,
    action: ChatAction,
    self: ChatUser,
  ): Promise<ChatRevertInfo> {
    const api = this.#api();
    const scope = { store, boundSpace: this.#boundSpaceName(), boundThread: action.threadScope };
    // Persist undo intent before a write whose response can be lost. Retrying must not replace
    // the original text/reaction state with the result of the first attempt.
    const write = async <T>(info: ChatRevertInfo, perform: () => Promise<T>): Promise<T> => {
      const saved = store.getRevert(actionId);
      store.setRevert(actionId, saved ?? { ...info, threadScope: action.threadScope });
      try {
        return await perform();
      } catch (error) {
        // A definitive refusal on the first attempt is still rejectable. A later refusal cannot
        // settle an earlier lost response, so retain that attempt's intent for reconciliation.
        if (!saved && error instanceof ChatApiError && error.status >= 400 && error.status < 500) {
          store.clearRevert(actionId);
        }
        throw error;
      }
    };
    switch (action.type) {
      case "sendMessage": {
        const threadName = action.threadName === undefined
          ? undefined : resolveThread(scope, action.threadName).name;
        requireInScope(scope, action.spaceName);
        requireThreadInScope(scope, threadName);
        if (threadName && pendingThreadActionId(threadName) !== undefined) {
          throw new Error("Send the thread's root message before its replies.");
        }
        // The request id makes Chat itself idempotent, so a retry after a lost response returns
        // the message the first attempt created rather than posting a second one.
        let created = await write({ type: "none" }, () => api.createMessage(action.spaceName, {
          text: action.text,
          ...(threadName !== undefined ? { threadName } : {}),
        }, { requestId: action.requestId }));
        // Idempotent retries may echo only the submitted fields and assigned message ID.
        if (!created.threadId && (threadName || action.startsThread)) {
          created = await api.getMessage(created.id);
          if (!created.threadId) throw new Error("Google Chat did not return the created message's thread.");
        }
        requireMessageInScope(scope, created);
        store.setSentMessage(actionId, created);
        return { type: "sentMessage", messageName: created.id };
      }
      case "updateMessage": {
        const target = resolveMessage({ store }, action.messageName);
        if ("queued" in target) throw new Error("Post the message before applying its edits.");
        const previous = await api.getMessage(target.committed);
        requireMessageInScope(scope, previous);
        const revert: ChatRevertInfo = {
          type: "updatedMessage", messageName: target.committed, previousText: previous.text,
        };
        if (previous.text !== action.text) await write(revert, () => api.updateMessageText(target.committed, action.text));
        return store.getRevert(actionId) ?? revert;
      }
      case "addReaction": {
        // Re-fetching the message re-runs the private-message check at apply time.
        requireMessageInScope(scope, await api.getMessage(action.messageName));
        // Adding a reaction twice is an error, so a retry reuses the one already there.
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.id);
        if (existing) return store.getRevert(actionId) ?? { type: "none" };
        const revert: ChatRevertInfo = { type: "addedReaction", messageName: action.messageName, emoji: action.emoji };
        await write(revert, () => api.createReaction(action.messageName, action.emoji));
        return store.getRevert(actionId)!;
      }
      case "removeReaction": {
        requireMessageInScope(scope, await api.getMessage(action.messageName));
        const existing = await api.findOwnReaction(action.messageName, action.emoji, self.id);
        if (!existing) return store.getRevert(actionId) ?? { type: "none" };
        const revert: ChatRevertInfo = { type: "removedReaction", messageName: action.messageName, emoji: action.emoji };
        await write(revert, () => api.deleteReaction(existing.id));
        return store.getRevert(actionId)!;
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
    if (store.getRevert(actionId)) {
      throw new Error("This action may already have reached Google Chat. Retry applying it before undoing it.");
    }
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
    if (store.get(actionId)) throw new Error("Finish applying this Google Chat action before undoing it.");
    const self = await this.#getSelf();
    const api = this.#api();
    const scope = { store, boundSpace: this.#boundSpaceName(), boundThread: info.threadScope };
    const checkThread = async (messageName: string) => {
      if (info.threadScope !== undefined) {
        requireMessageInScope(scope, await api.getMessage(messageName));
      }
    };
    switch (info.type) {
      case "none":
        break;
      case "sentMessage":
        try {
          await deleteMessageIfPresent(api, info.messageName, scope);
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
        await checkThread(info.messageName);
        await api.updateMessageText(info.messageName, info.previousText);
        break;
      case "addedReaction": {
        let reactionName: string | undefined;
        if ("reactionName" in info) {
          // Undo receipts written before reaction intent was staged by message + emoji.
          const { spaceId, messageId } = chatReactionParts(info.reactionName);
          await checkThread(`spaces/${spaceId}/messages/${messageId}`);
          reactionName = info.reactionName;
        } else {
          await checkThread(info.messageName);
          reactionName = (await api.findOwnReaction(info.messageName, info.emoji, self.id))?.id;
        }
        if (reactionName) {
          try { await api.deleteReaction(reactionName); }
          catch (error) { if (!(error instanceof ChatApiError && error.status === 404)) throw error; }
        }
        break;
      }
      case "removedReaction": {
        await checkThread(info.messageName);
        const existing = await api.findOwnReaction(info.messageName, info.emoji, self.id);
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
   * single-space binding verifies the space and any People-sourced names already disclosed. The
   * tracker also checks existing observers before a new profile name is revealed.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const boundSpace = this.#boundSpaceName();
    if (boundSpace === undefined) {
      throw new Error(
        "A whole-account Google Chat connection covers direct messages and every conversation " +
        "the owner belongs to, so it cannot be shared with collaborators. Connect a single " +
        "conversation instead.");
    }
    await chatNameObservers(this.ctx.storage.kv, boundSpace)
      .addObserver(id, user as unknown as Fetcher<GoogleVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    const space = this.#boundSpaceName();
    if (space) chatNameObservers(this.ctx.storage.kv, space).removeObserver(id);
  }
}
