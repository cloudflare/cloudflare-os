// A Gmail binding shared with the members of one Google Group.
//
// The group's conversations are read live from the owner's mailbox, and every message passes
// `admitsGroupMessage` before anything about it leaves this module. Everything a member sees is
// built from admitted messages alone: Gmail's own thread snippet, counts and labels describe the
// owner's whole thread, so none of them is passed through. Nothing here writes to the mailbox.
//
// Any current direct member of the group may see every admitted message, including mail from
// before they joined, as a Chat conversation shows a new member its history. See
// `plans/gmail-group-sharing.md`.

import {RpcStub, RpcTarget} from "cloudflare:workers";
import {validateRpc} from "capnweb-validate";
import type {ApprovalQueue} from "@gadgets/workshop-shared/gatekeeper";
import {sanitizeTitle} from "@gadgets/gatekeeper-kit/action-description";
import {
  enumerateGmailAttachments, GmailApi, GmailApiError, MAX_GMAIL_ATTACHMENT_BYTES,
  parseGmailMessageMetadata, type GmailAttachmentSnapshot, type GmailMessageFull,
} from "./google-api";
import type {
  EmailAddress, EmailContent, GmailAttachment, GmailAttachmentEntry, GmailAttachmentInfo,
  GmailGroupMessage, GmailGroupMessageEntry, GmailGroupMessageInfo,
  GmailGroupSession, GmailGroupThread, GmailGroupThreadEntry, GmailGroupThreadInfo,
} from "./types";
import {combineGmailQueries, validateGmailGroupQuery} from "./gmail-validate";
import {admitsGroupMessage, GMAIL_GROUP_ADMISSION_HEADERS, gmailGroupCandidates} from "./gmail-group-admission";
import type {CloudIdentityGroup} from "./cloud-identity-api";
import {CursorPager} from "./cursor";
import {ApprovalQueueRpcTarget, RpcCursor, SharedApprovalQueue} from "./shared-approval-queue";
import type {GmailMessageHookTarget, GmailScreenedHookDelivery} from "./gmail-hooks";

const MESSAGES_PER_PAGE = 20;
// Each thread on a page costs a request, and a member's reads spend the owner's Gmail quota.
const MAX_PROVIDER_PAGES_PER_CALL = 5;
const MAX_THREAD_MESSAGES = 1000;
const GMAIL_ID_RE = /^[a-f0-9]{1,256}$/i;
const NOT_THE_GROUPS = "This isn't one of the group's messages.";

// -- state ---------------------------------------------------------------------------------------

const GROUP_KEY = "gmailGroup:group";

/** What a group binding remembers: its group. */
export class GmailGroupState {
  #kv: DurableObjectStorage["kv"];

  constructor(storage: DurableObjectStorage) {
    this.#kv = storage.kv;
  }

  /**
   * The group as last resolved. Its name is the one first connected, so a group recreated at its
   * address is not taken for it; its addresses may be one resolution stale.
   */
  get pinnedGroup(): CloudIdentityGroup | undefined {
    return this.#kv.get<CloudIdentityGroup>(GROUP_KEY);
  }

  pinGroup(group: CloudIdentityGroup): void {
    this.#kv.put(GROUP_KEY, group);
  }
}

// -- admission -----------------------------------------------------------------------------------

/** What every capability of a group binding shares. */
export type GmailGroupReadContext = {
  /** The owner's mailbox. */
  api: GmailApi;
  group: CloudIdentityGroup;
};

export type GmailGroupContext = GmailGroupReadContext & {
  approvalQueue: SharedApprovalQueue;
  subscribe(hook: RpcStub<GmailMessageHookTarget>): Promise<void>;
};

const arrival = (message: GmailMessageFull) => Number(message.internalDate);

/** The messages members may see. */
function admitted(ctx: GmailGroupReadContext, messages: readonly GmailMessageFull[]): GmailMessageFull[] {
  return messages.filter(message => Number.isFinite(arrival(message)) && admitsGroupMessage(ctx.group, message));
}

function validateGmailId(id: string): void {
  if (!GMAIL_ID_RE.test(id)) throw new TypeError("Invalid Gmail ID.");
}

/** The candidates: what Gmail lists for the group, narrowed by `caller`. Admission still decides. */
function groupQuery(ctx: GmailGroupReadContext, caller?: string): string {
  return combineGmailQueries(gmailGroupCandidates(ctx.group), caller)!;
}

// -- what members see ----------------------------------------------------------------------------

function messageInfo(message: GmailMessageFull): GmailGroupMessageInfo {
  const {id, threadId, from, to, cc, subject} = parseGmailMessageMetadata(message);
  return {id, threadId, from, to, cc, subject, timestamp: new Date(arrival(message))};
}

/** A thread as its admitted messages describe it, `messages` oldest first. */
function threadInfo(threadId: string, messages: readonly GmailMessageFull[]): GmailGroupThreadInfo {
  const infos = messages.map(messageInfo);
  const latest = infos[infos.length - 1];
  const participants: EmailAddress[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    for (const person of [info.from, ...info.to, ...info.cc]) {
      const key = person.address.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      participants.push(person);
    }
  }
  return {
    id: threadId,
    subject: infos[0].subject,
    messageCount: infos.length,
    latestMessageId: latest.id,
    timestamp: latest.timestamp,
    participants,
  };
}

function observation(title: string, description: string) {
  return {title: sanitizeTitle(title), description, containsRestrictedData: true};
}

/** The messages members may see in a thread, oldest first; none when the thread isn't the group's. */
async function threadMessages(ctx: GmailGroupReadContext, threadId: string): Promise<GmailMessageFull[]> {
  const messages = await ctx.api.getThreadHeaders(threadId, GMAIL_GROUP_ADMISSION_HEADERS);
  const shown = admitted(ctx, messages);
  // Only after admission, so a thread that isn't the group's can't be told apart by how it fails.
  if (shown.length === 0) return [];
  if (messages.length > MAX_THREAD_MESSAGES) throw new Error("This Gmail thread is too long to read.");
  if (messages.some(message => message.threadId !== threadId)) {
    throw new Error("Gmail returned a message from another thread.");
  }
  return shown.toSorted((a, b) => arrival(a) - arrival(b));
}

/** Mail that isn't in the owner's mailbox must read the same as mail that isn't the group's. */
async function notTheGroupsIfMissing<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- a cause would tell the two apart.
      throw new Error(NOT_THE_GROUPS);
    }
    throw error;
  }
}

// -- capabilities --------------------------------------------------------------------------------

@validateRpc()
export class GmailGroupSessionImpl extends ApprovalQueueRpcTarget implements GmailGroupSession {
  #ctx: GmailGroupContext;

  constructor(ctx: GmailGroupContext) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
  }

  async getGroupAddress(): Promise<EmailAddress> {
    const {address, displayName} = this.#ctx.group;
    return displayName === address ? {address} : {address, name: displayName};
  }

  async listThreads(): Promise<RpcCursor<GmailGroupThreadEntry>> {
    return groupThreadCursor(this.#ctx);
  }

  async searchThreads(query: string): Promise<RpcCursor<GmailGroupThreadEntry>> {
    validateGmailGroupQuery(query);
    return groupThreadCursor(this.#ctx, query);
  }

  async getThread(id: string): Promise<GmailGroupThreadStub> {
    validateGmailId(id);
    const messages = await notTheGroupsIfMissing(threadMessages(this.#ctx, id));
    if (messages.length === 0) throw new Error(NOT_THE_GROUPS);
    return new GmailGroupThreadStub(this.#ctx, id);
  }

  async getMessage(id: string): Promise<GmailGroupMessageStub> {
    validateGmailId(id);
    const message = await notTheGroupsIfMissing(
      this.#ctx.api.getMessageHeaders(id, GMAIL_GROUP_ADMISSION_HEADERS));
    if (message.id !== id || admitted(this.#ctx, [message]).length === 0) throw new Error(NOT_THE_GROUPS);
    return new GmailGroupMessageStub(this.#ctx, id, message.threadId);
  }

  async subscribeNewMessages(hook: RpcStub<GmailMessageHookTarget>): Promise<void> {
    await this.#ctx.subscribe(hook);
  }
}

type OwnedThreadEntry = Omit<GmailGroupThreadEntry, "thread"> & {thread: GmailGroupThreadStub};

/**
 * Whether a message names recipients members aren't shown: the owner's own Bcc. A search can match
 * on them, so such a message is never what lists a conversation in search results.
 */
function hidesRecipients(message: GmailMessageFull): boolean {
  return parseGmailMessageMetadata(message).bcc.length > 0;
}

/**
 * The group's conversations matching `caller`, newest first. Messages are searched rather than
 * threads, which Gmail matches as a whole, so a conversation is listed only when a message that
 * matched is itself one members may see: no other message can be what made it match.
 */
function groupThreadCursor(ctx: GmailGroupContext, caller?: string): RpcCursor<GmailGroupThreadEntry> {
  const query = groupQuery(ctx, caller);
  const listed = new Set<string>();
  return new RpcCursor(new CursorPager<{id: string; threadId: string}, OwnedThreadEntry>({
    provider: "Gmail",
    maxProviderPagesPerCall: MAX_PROVIDER_PAGES_PER_CALL,
    fetchPage: async pageToken => {
      const page = await ctx.api.listMessages(MESSAGES_PER_PAGE, query, pageToken);
      return {items: page.messages, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
    },
    buildEntries: async items => {
      const matched = new Map<string, Set<string>>();
      for (const {id, threadId} of items) {
        validateGmailId(id);
        validateGmailId(threadId);
        if (!listed.has(threadId)) matched.set(threadId, (matched.get(threadId) ?? new Set()).add(id));
      }
      const threads = await Promise.all([...matched].map(async ([threadId, ids]) => {
        const messages = await threadMessages(ctx, threadId);
        return {threadId, ids, messages};
      }));
      const entries: OwnedThreadEntry[] = [];
      for (const {threadId, ids, messages} of threads) {
        if (!messages.some(message => ids.has(message.id) && (!caller || !hidesRecipients(message)))) continue;
        entries.push({
          info: threadInfo(threadId, messages),
          thread: new GmailGroupThreadStub(ctx, threadId),
        });
      }
      return entries;
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation(observation(
        `Read ${entries.length} ${ctx.group.address} conversations`,
        "Read the subject, participants and time of each conversation sent to the group."));
      // A conversation matched on several pages is listed once.
      for (const entry of entries) listed.add(entry.info.id);
    },
    disposeEntries: entries => {
      for (const entry of entries) entry.thread[Symbol.dispose]();
    },
  }), ctx.approvalQueue);
}

@validateRpc()
class GmailGroupThreadStub extends ApprovalQueueRpcTarget implements GmailGroupThread {
  #ctx: GmailGroupContext;
  #threadId: string;

  constructor(ctx: GmailGroupContext, threadId: string) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#threadId = threadId;
  }

  async #shown(): Promise<GmailMessageFull[]> {
    const shown = await threadMessages(this.#ctx, this.#threadId);
    if (shown.length === 0) throw new Error("None of this conversation's messages are the group's now.");
    return shown;
  }

  async getMetadata(): Promise<GmailGroupThreadInfo> {
    const info = threadInfo(this.#threadId, await this.#shown());
    await this.#ctx.approvalQueue.authorizeObservation(observation(
      `${this.#ctx.group.address} conversation: ${info.subject}`,
      "Read the subject, participants and time of a conversation sent to the group."));
    return info;
  }

  async messages(): Promise<GmailGroupMessageEntry[]> {
    const shown = await this.#shown();
    const entries = shown.map(message => ({
      info: messageInfo(message),
      message: new GmailGroupMessageStub(this.#ctx, message.id, this.#threadId),
    }));
    try {
      await this.#ctx.approvalQueue.authorizeObservation(observation(
        `Read ${entries.length} messages in a ${this.#ctx.group.address} conversation`,
        "Read the sender, recipients, subject and time of each message sent to the group."));
    } catch (error) {
      for (const entry of entries) entry.message[Symbol.dispose]();
      throw error;
    }
    return entries;
  }
}

@validateRpc()
class GmailGroupMessageStub extends ApprovalQueueRpcTarget implements GmailGroupMessage {
  #ctx: GmailGroupContext;
  #messageId: string;
  #threadId: string;

  constructor(ctx: GmailGroupContext, messageId: string, threadId: string) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
  }

  /**
   * The message, re-admitted: the group may have changed, or the message may have been moved to
   * spam or trash.
   */
  async #shown(full: boolean): Promise<GmailMessageFull> {
    const message = full
      ? await this.#ctx.api.getMessageFull(this.#messageId)
      : await this.#ctx.api.getMessageHeaders(this.#messageId, GMAIL_GROUP_ADMISSION_HEADERS);
    if (message.id !== this.#messageId || message.threadId !== this.#threadId) {
      throw new Error("Gmail message identity changed unexpectedly.");
    }
    const [shown] = admitted(this.#ctx, [message]);
    if (!shown) throw new Error(NOT_THE_GROUPS);
    return shown;
  }

  async getMetadata(): Promise<GmailGroupMessageInfo> {
    const info = messageInfo(await this.#shown(false));
    await this.#ctx.approvalQueue.authorizeObservation(observation(
      `${this.#ctx.group.address} message: ${info.subject}`,
      "Read the sender, recipients, subject and time of a message sent to the group."));
    return info;
  }

  async thread(): Promise<GmailGroupThreadStub> {
    return new GmailGroupThreadStub(this.#ctx, this.#threadId);
  }

  async getContent(): Promise<EmailContent> {
    const message = await this.#shown(true);
    const content = await this.#ctx.api.getMessageContent(message);
    await this.#ctx.approvalQueue.authorizeObservation(observation(
      `Read ${this.#ctx.group.address} message: ${messageInfo(message).subject}`,
      "Read the text of a message sent to the group."));
    return content;
  }

  async attachments(): Promise<GmailAttachmentEntry[]> {
    const message = await this.#shown(true);
    const snapshots = enumerateGmailAttachments(this.#messageId, message.payload);
    const entries = snapshots.map(snapshot => ({
      info: snapshot.info,
      attachment: new GmailGroupAttachmentStub(this.#ctx, snapshot, () => this.#shown(false)),
    }));
    try {
      await this.#ctx.approvalQueue.authorizeObservation(observation(
        `List ${entries.length} attachments of a ${this.#ctx.group.address} message`,
        "Read the name, type and size of each attachment."));
    } catch (error) {
      for (const entry of entries) entry.attachment[Symbol.dispose]();
      throw error;
    }
    return entries;
  }
}

@validateRpc()
class GmailGroupAttachmentStub extends ApprovalQueueRpcTarget implements GmailAttachment {
  #ctx: GmailGroupContext;
  #snapshot: GmailAttachmentSnapshot;
  #readmit: () => Promise<unknown>;

  constructor(ctx: GmailGroupContext, snapshot: GmailAttachmentSnapshot, readmit: () => Promise<unknown>) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#snapshot = snapshot;
    this.#readmit = readmit;
  }

  async getMetadata(): Promise<GmailAttachmentInfo> {
    await this.#readmit();
    await this.#ctx.approvalQueue.authorizeObservation(observation(
      "Read an attachment's details", "Read the name, type and size of an attachment sent to the group."));
    return this.#snapshot.info;
  }

  async getContent(): Promise<ArrayBuffer> {
    const {info} = this.#snapshot;
    if (!info.readable || info.size > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is unavailable or exceeds the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe limit.`);
    }
    await this.#readmit();
    const content = await this.#ctx.api.getAttachmentContent(this.#snapshot);
    await this.#ctx.approvalQueue.authorizeObservation(observation(
      "Read an attachment", `Read ${content.byteLength} bytes of an attachment sent to the group.`));
    return content;
  }
}

// -- hooks ---------------------------------------------------------------------------------------

/** A new message's headers, or nothing once it has been deleted. */
async function newMessage(read: GmailGroupReadContext, messageId: string): Promise<GmailMessageFull | undefined> {
  validateGmailId(messageId);
  let message: GmailMessageFull;
  try {
    message = await read.api.getMessageHeaders(messageId, GMAIL_GROUP_ADMISSION_HEADERS);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return undefined;
    throw error;
  }
  if (message.id !== messageId) throw new Error("Gmail message identity changed unexpectedly.");
  return message;
}

/** What a group binding's hook delivers: each new message, when it is the group's. */
@validateRpc()
export class GmailGroupHookDelivery extends RpcTarget implements GmailScreenedHookDelivery {
  constructor(
    /** The group resolved fresh. */
    private readonly readContext: () => Promise<GmailGroupReadContext>,
    /** The group and mailbox as last resolved, so screening each of the owner's messages costs only its read. */
    private readonly screenContext: () => Promise<GmailGroupReadContext>,
    private readonly context: (read: GmailGroupReadContext, approvalQueue: RpcStub<ApprovalQueue>) => GmailGroupContext,
  ) {
    super();
  }

  /**
   * The cached addresses may be one resolution stale: `deliver` resolves the group again, and mail
   * to an alias added since is left for reads to show.
   */
  async screen(messageId: string): Promise<boolean> {
    const read = await this.screenContext();
    const message = await newMessage(read, messageId);
    return message !== undefined && admitted(read, [message]).length > 0;
  }

  async deliver(callback: RpcStub<GmailMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                messageId: string): Promise<void> {
    const read = await this.readContext();
    const message = await newMessage(read, messageId);
    if (!message) return;
    const [shown] = admitted(read, [message]);
    if (!shown) return;

    // Only now, so a message that isn't the group's takes no reference to the approval queue.
    const ctx = this.context(read, approvalQueue);
    const info = messageInfo(shown);
    const stub = new GmailGroupMessageStub(ctx, messageId, shown.threadId);
    try {
      await ctx.approvalQueue.authorizeObservation(observation(
        `New ${ctx.group.address} message: ${info.subject}`,
        "Read the sender, recipients, subject and time of a new message sent to the group."));
    } catch (error) {
      stub[Symbol.dispose]();
      throw error;
    }
    await callback.receiveMessage({info, message: stub});
  }
}
