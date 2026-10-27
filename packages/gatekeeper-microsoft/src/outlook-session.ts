// The sessions gadgets hold for an Outlook binding. Every operation follows the same order: prove
// each message or folder it names is inside the binding (`admits` in outlook-scope.ts, on the
// message's own metadata, read fresh), read it, apply pending changes (outlook-overlay.ts),
// authorize the observation with the access units it revealed (outlook-observers.ts), and only then
// return. A message outside the binding and one that doesn't exist are refused with the same words,
// so a refusal says nothing about the mailbox.
//
// Changes are checked as reads are, then staged for approval (outlook-actions.ts). A read-only
// binding hands out `OutlookReaderImpl`; `OutlookSessionImpl` adds the write methods, each of which
// checks the binding's access level (draft or send).

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionSubmitter, JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { TokenCursor } from "@gadgets/gatekeeper-kit/cursors";
import { ObservationGate, escapeObservationValue, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { isProvisional, OutsideBindingError } from "./binding";
import { DownloadTooLargeError, GraphApiError, type GraphApi } from "./graph-api";
import { graphInstant } from "./calendar-time";
import { organizationDomains } from "./directory";
import type { StoredIdentity } from "./microsoft-credentials";
import { MAX_BATCH, replaceOwnPart, type AttachedFile, type AttachmentUpload, type AutomaticRepliesSetting, type Composed, type FolderTarget, type Forwarded, type MessageState, type MessageTarget, type Origin, type OutlookAction, type OutlookActions, type RecipientNote } from "./outlook-actions";
import {
  MAX_SUBJECT_CHARS, attachmentBytes, checkBody, checkSubject, mailToMarkdown, markdownToMailHtml, parseRecipients, senderKind,
} from "./outlook-content";
import { MailApi, MESSAGE_SELECT, idPath, isMailId, mailboxPath, parseMessage, type GraphAddress, type GraphAttachment, type GraphFolder, type GraphMessage } from "./outlook-graph";
import { mailUnits } from "./outlook-observers";
import { OutlookOverlay, preview } from "./outlook-overlay";
import { kqlPhrase, listingRequest, odataString, passesFilters, type ListingFilters } from "./outlook-query";
import { folderPath as walkFolderPath } from "./outlook-resolve";
import {
  PRIVATE_WELL_KNOWN, admits, admitsFolder, allows, describeScope, isNarrowed, type FolderTree, type OutlookAccessLevel,
  type OutlookScope,
} from "./outlook-scope";
import type { OutlookHookTarget } from "./outlook-hooks";
import { convertBytes } from "./sharepoint-content";
import type {
  AttachmentContent, AttachmentInfo, AttachmentInput, AutomaticReplies, Category, Conversation, ConversationMessage, DraftPatch,
  EmailAddress, FolderInfo, ForwardOptions, ListMessagesOptions, MailboxInfo, MessageContent, MessageInfo, MessageInput,
  OutlookReader, OutlookSession, Person, ReadOptions, Recipient, ReplyOptions, MailSearchOptions,
} from "./outlook-types";

/** How long folder metadata and the mailbox's well-known folders are reused. */
const FOLDER_TTL_MS = 5 * 60 * 1000;
const WELL_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long the organization's domains, and whether the user has written to someone, are reused. */
const ORGANIZATION_TTL_MS = 24 * 60 * 60 * 1000;
const CORRESPONDENT_TTL_MS = 60 * 60 * 1000;
/** Bounds on what one read returns. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const DEFAULT_MAX_CHARS = 50_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 200_000;
const MAX_FOLDERS = 500;
const MAX_CONVERSATION_MESSAGES = 50;
const MAX_SEARCH_CHARS = 500;
const MAX_ATTACHMENT_READ_BYTES = 25 * 1024 * 1024;
/** Bounds on what one change carries: the approver reads all of it, and the journal stores it. */
const MAX_WRITE_BODY_CHARS = 100_000;
const MAX_STORED_HTML_CHARS = 400_000;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
const MAX_CATEGORIES = 25;
const MAX_RECIPIENTS = 100;
/** How much of a forwarded message's text the approver is shown. */
const MAX_FORWARDED_CHARS = 20_000;

/** The well-known names `FolderInfo` reports; Outlook's other own folders are plain folders to the agent. */
const NAMED_FOLDERS = new Set<NonNullable<FolderInfo["wellKnownName"]>>(["inbox", "drafts", "sentitems", "deleteditems", "archive", "junkemail", "outbox"]);
const isNamedFolder = (name: string): name is NonNullable<FolderInfo["wellKnownName"]> => (NAMED_FOLDERS as ReadonlySet<string>).has(name);

/** What the gatekeeper gives every session. */
export type OutlookSessionHost = {
  scope: OutlookScope;
  /** What the binding may do: its own level, never more than the deployment and grant allow. */
  access: OutlookAccessLevel;
  owner(): Promise<StoredIdentity>;
  read<T>(op: (api: GraphApi) => Promise<T>): Promise<T>;
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  pending(): JournalEntry<OutlookAction>[];
  resolve(id: string): string;
  allocate(kind: string): string;
  submit<K extends keyof OutlookActions>(queue: ActionSubmitter, kind: K, payload: OutlookActions[K]): Promise<number>;
  capture(bytes: Uint8Array): Promise<ActionFileReference>;
  /** Drafts this binding created, which it covers whatever its narrowing. */
  ownDrafts(): ReadonlySet<string>;
  subscribe(ctx: OutlookContext, hook: RpcStub<OutlookHookTarget>): Promise<void>;
  ai?: Ai;
};

/** Who a reply's conversation already includes, and Reply-To addresses that aren't the sender's. */
type ReplyContext = { participants: ReadonlySet<string>; replyToOf: ReadonlyMap<string, string> };

/** Refused: outside the binding, or not there at all. One message for both. */
export class OutsideMailboxError extends OutsideBindingError {
  constructor(what = "That message") {
    super("Outlook", what);
  }
}

const md = (text: string) => escapeObservationValue(text);

/** "Ada Lovelace — Quarterly numbers", for observations. */
function line(info: Pick<MessageInfo, "from" | "subject">): string {
  return `${md(info.from?.name ?? info.from?.address ?? "unknown sender")} — ${md(info.subject || "(no subject)")}`;
}

function listed(items: readonly MessageInfo[]): string {
  return items.slice(0, 20).map(line).join("; ") + (items.length > 20 ? "; …" : "");
}

/**
 * One capability's hold on the binding: its approval-queue stub, an observation gate, and the
 * binding's cached view of the mailbox (folders, the organization's domains).
 */
/** What {@link MailboxGuard} reads the mailbox with. */
export type MailboxGuardHost = Pick<OutlookSessionHost, "scope" | "owner" | "read" | "cached" | "ownDrafts">;

/**
 * The binding's mailbox as Exchange holds it now, and the scope's proofs over it. A session's
 * context reads folders through it, and so do the apply-time checks of the binding's actions, which
 * have no approval queue: a message or folder is proved covered the same way at proposal and at apply.
 */
export class MailboxGuard {
  readonly host: MailboxGuardHost;
  readonly folders: FolderTree;

  constructor(host: MailboxGuardHost) {
    this.host = host;
    this.folders = {
      parentOf: async id => (await this.folder(id))?.parentId ?? null,
      privateFolders: async () => {
        const known = await this.wellKnown();
        return new Set(PRIVATE_WELL_KNOWN.map(name => known[name]).filter((id): id is string => id !== undefined));
      },
    };
  }

  get scope(): OutlookScope {
    return this.host.scope;
  }

  /** Runs a read against the binding's mailbox. */
  mail<T>(op: (mail: MailApi) => Promise<T>): Promise<T> {
    return this.host.read(api => op(new MailApi(api, this.scope.mailbox)));
  }

  /** A folder's metadata, cached; null when it isn't in the mailbox. */
  folder(id: string): Promise<GraphFolder | null> {
    return this.host.cached(`folder:${id}`, FOLDER_TTL_MS, () => this.mail(mail => mail.folder(id)));
  }

  /** The IDs of Outlook's own folders, by well-known name, cached. */
  wellKnown(): Promise<Record<string, string>> {
    return this.host.cached("wellKnown", WELL_KNOWN_TTL_MS, async () => Object.fromEntries(await this.mail(mail => mail.wellKnownFolders())));
  }

  /** The mailbox's own address, lower-cased. */
  async address(): Promise<string> {
    if (this.scope.mailbox.kind === "shared") return this.scope.mailbox.address.toLowerCase();
    const me = await this.host.owner();
    return (me.email ?? me.username ?? "").toLowerCase();
  }

  /** Whether the binding covers a message, as Exchange holds it now; its own mail, sent under a legacy address, is its own. */
  async covers(message: GraphMessage): Promise<boolean> {
    const guarded = message.from === undefined || message.from.includes("@") ? message : { ...message, from: await this.address() };
    return await admits(this.scope, guarded, this.folders, { ownDrafts: this.host.ownDrafts() });
  }

  /** Whether the binding covers a folder: one mail may be moved into, or a folder made in. */
  async coversFolder(folderId: string): Promise<boolean> {
    return await admitsFolder(this.scope, folderId, this.folders);
  }
}

export class OutlookContext implements Disposable {
  readonly host: OutlookSessionHost;
  readonly queue: RpcStub<ApprovalQueue>;
  readonly gate: ObservationGate;
  readonly #observers: ObserverStrategy;
  readonly #mailbox: MailboxGuard;

  constructor(host: OutlookSessionHost, queue: RpcStub<ApprovalQueue>, observers: ObserverStrategy) {
    this.host = host;
    this.queue = queue;
    this.#observers = observers;
    this.gate = new ObservationGate(queue.dup(), observers);
    this.#mailbox = new MailboxGuard(host);
  }

  get folders(): FolderTree {
    return this.#mailbox.folders;
  }

  /** A context for another capability on the same binding, with its own queue stub and gate. */
  fork(): OutlookContext {
    return new OutlookContext(this.host, this.queue.dup(), this.#observers);
  }

  [Symbol.dispose](): void {
    this.gate[Symbol.dispose]();
    this.queue[Symbol.dispose]();
  }

  get scope(): OutlookScope {
    return this.host.scope;
  }

  /** Runs a read against the binding's mailbox. */
  mail<T>(op: (mail: MailApi) => Promise<T>): Promise<T> {
    return this.#mailbox.mail(op);
  }

  /** The object ID whose mailbox this is, for access units. */
  async mailboxUser(): Promise<string> {
    return this.scope.mailbox.kind === "shared" ? this.scope.mailbox.id : (await this.host.owner()).objectId;
  }

  /** Access-unit constructors for this mailbox. */
  async units() {
    return mailUnits(await this.mailboxUser());
  }

  /** The mailbox's address and display name. */
  async mailbox(): Promise<{ address: string; name: string }> {
    if (this.scope.mailbox.kind === "shared") {
      const { id, address } = this.scope.mailbox;
      return await this.host.cached(`mailboxName:${id}`, ORGANIZATION_TTL_MS, async () => {
        const user = await this.host.read(api => api.find<{ displayName?: unknown }>(mailboxPath(this.scope.mailbox), { query: { $select: "displayName" } }));
        return { address, name: typeof user?.displayName === "string" && user.displayName !== "" ? user.displayName : address };
      });
    }
    const me = await this.host.owner();
    return { address: (me.email ?? me.username ?? "").toLowerCase(), name: me.name };
  }

  /** The organization's verified domains: who counts as a colleague. */
  async orgDomains(): Promise<string[]> {
    return await this.host.cached("orgDomains", ORGANIZATION_TTL_MS, () => this.host.read(organizationDomains));
  }

  /** Authorizes an observation of what a read revealed; with no units, against the observer baseline. */
  async observe(title: string, description: string, revealed: readonly string[]): Promise<void> {
    await this.gate.authorize({ title, description },
      revealed.length > 0 ? { kind: "collections", ids: [...new Set(revealed)] } : { kind: "baseline" });
  }

  /** The pending actions, as reads see them. */
  overlay(): OutlookOverlay {
    return new OutlookOverlay(this.host.pending(), id => this.host.resolve(id));
  }

  // -- folders -------------------------------------------------------------------------------

  /** A folder's metadata, cached; null when it isn't in the mailbox. */
  folder(id: string): Promise<GraphFolder | null> {
    return this.#mailbox.folder(id);
  }

  /** The IDs of Outlook's own folders, by well-known name, cached. */
  wellKnown(): Promise<Record<string, string>> {
    return this.#mailbox.wellKnown();
  }

  /** "Inbox/Vendors": a folder's path from the top of the mailbox, for a pending `~N` folder too. */
  async folderPath(id: string): Promise<string> {
    if (isProvisional(id)) {
      const pending = this.overlay().folders.find(folder => folder.id === id);
      if (pending === undefined) return "";
      const parent = await this.folderPath(pending.parentId);
      return parent ? `${parent}/${pending.name}` : pending.name;
    }
    return await walkFolderPath(folderId => this.folder(folderId), (await this.wellKnown()).msgfolderroot, id);
  }

  /** A folder ID the agent passed, proven in scope: a real one, a well-known name, or a pending `~N`. */
  async scopedFolder(folderId: string): Promise<FolderTarget> {
    const resolved = this.host.resolve(folderId);
    if (isProvisional(resolved)) {
      const pending = this.overlay().folders.find(folder => folder.id === resolved);
      if (pending === undefined) throw new OutsideMailboxError("That folder");
      const parent = await this.scopedFolder(pending.parentId);
      return { id: resolved, name: pending.name, path: parent.path ? `${parent.path}/${pending.name}` : pending.name };
    }
    const known = await this.wellKnown();
    const id = known[resolved] ?? resolved;
    if (!isMailId(id)) throw new OutsideMailboxError("That folder");
    const folder = await this.folder(id);
    if (folder === null || !(await this.#mailbox.coversFolder(folder.id))) throw new OutsideMailboxError("That folder");
    return { id: folder.id, name: folder.name, path: await this.folderPath(folder.id) };
  }

  /**
   * A folder mail may be moved into or a folder created in: in scope, and a folder the user sees in
   * Outlook. Not the top of the mailbox itself, nothing hidden, nothing outside the visible tree
   * (Recoverable Items, which is purged, lives there), and not Outbox, Drafts or Deleted Items:
   * deleting goes through `delete`, which the approver sees as a deletion.
   */
  async destinationFolder(folderId: string): Promise<FolderTarget> {
    const target = await this.scopedFolder(folderId);
    if (isProvisional(target.id)) return target;
    const known = await this.wellKnown();
    const refused = new Set([known.msgfolderroot, known.outbox, known.drafts, known.deleteditems, known.syncissues, known.recoverableitemsdeletions]);
    let current: string | undefined = target.id;
    for (let depth = 0; depth < 32; depth++) {
      if (current === undefined || refused.has(current)) break;
      const folder: GraphFolder | null = await this.folder(current);
      if (folder === null || folder.hidden) break;
      if (folder.parentId === known.msgfolderroot) return target;
      current = folder.parentId;
    }
    throw new Error(`Mail can't be moved into ${target.name ? `"${target.name}"` : "that folder"} from here. Choose a folder you see in Outlook` +
      " (use delete to move mail to Deleted Items).");
  }

  // -- messages ------------------------------------------------------------------------------

  /** Whether the binding covers a message, as Exchange holds it now. */
  covers(message: GraphMessage): Promise<boolean> {
    return this.#mailbox.covers(message);
  }

  /** A message the agent named, proven in scope, as Exchange holds it now. */
  async guarded(id: string): Promise<GraphMessage> {
    const resolved = this.host.resolve(id);
    if (!isMailId(resolved)) throw new OutsideMailboxError();
    const message = await this.mail(mail => mail.message(resolved));
    if (message === null || !(await this.covers(message))) throw new OutsideMailboxError();
    return message;
  }

  /** Several messages, each proven in scope; the first one that isn't refuses them all. */
  async guardedAll(ids: readonly string[]): Promise<GraphMessage[]> {
    if (ids.length === 0) throw new Error("Pass at least one message ID.");
    if (ids.length > MAX_BATCH) throw new Error(`Pass at most ${MAX_BATCH} messages at a time.`);
    const unique = [...new Set(ids.map(id => this.host.resolve(id)))];
    if (unique.some(id => !isMailId(id))) throw new OutsideMailboxError("One of those messages");
    const found = await this.mail(mail => mail.messages(unique));
    const messages: GraphMessage[] = [];
    for (const id of unique) {
      const message = found.get(id);
      if (message === undefined || !(await this.covers(message))) throw new OutsideMailboxError("One of those messages");
      messages.push(message);
    }
    return messages;
  }

  /**
   * A message with its sender as an SMTP address. Exchange gives the mailbox's own sent mail and
   * drafts a legacy X.500 address (`/O=EXCHANGELABS/...`) as `from`, which is the mailbox itself.
   */
  own(message: GraphMessage, mailbox: { address: string }): GraphMessage {
    if (message.fromAddress === undefined || message.fromAddress.address.includes("@")) return message;
    const fromAddress = { address: mailbox.address, ...(message.fromAddress.name ? { name: message.fromAddress.name } : {}) };
    return { ...message, from: mailbox.address, fromAddress };
  }

  /** A message as the agent sees it, before the overlay. */
  async info(graphMessage: GraphMessage, mailbox: { address: string }, domains: readonly string[]): Promise<MessageInfo> {
    const message = this.own(graphMessage, mailbox);
    const info: MessageInfo = {
      id: message.id,
      conversationId: message.conversationId,
      folderId: message.parentFolderId,
      folder: await this.folderPath(message.parentFolderId),
      subject: message.subject,
      ...(message.fromAddress ? { from: message.fromAddress } : {}),
      ...(message.sender ? { sender: message.sender } : {}),
      senderKind: senderKind(message.from, mailbox.address, domains),
      to: message.to,
      cc: message.cc,
      ...(message.bcc.length ? { bcc: message.bcc } : {}),
      ...(message.replyTo.length ? { replyTo: message.replyTo } : {}),
      receivedAt: message.receivedAt,
      ...(message.sentAt ? { sentAt: message.sentAt } : {}),
      isRead: message.isRead,
      isDraft: message.isDraft,
      importance: message.importance,
      flag: message.flag,
      categories: [...message.categories],
      hasAttachments: message.hasAttachments,
      preview: message.preview,
      ...(message.focused !== undefined ? { focused: message.focused } : {}),
      webLink: message.webLink,
    };
    return info;
  }

  /** Messages as the agent sees them, pending changes applied. */
  async infos(messages: readonly GraphMessage[], overlay = this.overlay()): Promise<MessageInfo[]> {
    const [mailbox, domains] = await Promise.all([this.mailbox(), this.orgDomains()]);
    const paths = new Map<string, string>();
    for (const folderId of new Set(overlay.moved.values())) {
      paths.set(folderId, await this.folderPath(folderId).catch(() => ""));
    }
    const infos: MessageInfo[] = [];
    for (const message of messages) {
      infos.push(overlay.apply(await this.info(message, mailbox, domains), id => paths.get(id) ?? ""));
    }
    return infos;
  }

  /** A target for an action: the message as the approver will recognize it. */
  async target(graphMessage: GraphMessage): Promise<MessageTarget> {
    const message = this.own(graphMessage, await this.mailbox());
    return {
      id: message.id,
      subject: message.subject,
      ...(message.fromAddress ? { from: message.fromAddress.name ?? message.fromAddress.address } : {}),
      folderId: message.parentFolderId,
      folder: await this.folderPath(message.parentFolderId),
      receivedAt: message.receivedAt,
      conversationId: message.conversationId,
    };
  }

  // -- composing -----------------------------------------------------------------------------

  /** A message's text and attachments as an action stores them; attachments are captured now. */
  async compose(input: {
    to?: unknown; cc?: unknown; bcc?: unknown; subject: unknown; body: unknown; importance?: unknown; attachments?: unknown;
  }, base?: { to: GraphAddress[]; cc: GraphAddress[]; bcc: GraphAddress[] }): Promise<Composed> {
    const subject = checkSubject(input.subject as string);
    const markdown = checkBody(input.body as string);
    if (markdown.length > MAX_WRITE_BODY_CHARS) throw new Error(`A message body written here can be at most ${MAX_WRITE_BODY_CHARS.toLocaleString("en-US")} characters.`);
    const importance = input.importance ?? "normal";
    if (importance !== "low" && importance !== "normal" && importance !== "high") throw new Error('importance must be "low", "normal" or "high".');
    const merge = (existing: GraphAddress[], added: EmailAddress[]) => {
      const seen = new Set(existing.map(address => address.address.toLowerCase()));
      return [...existing, ...added.filter(address => !seen.has(address.address.toLowerCase()))];
    };
    const to = merge(base?.to ?? [], parseRecipients(input.to, "to", MAX_RECIPIENTS));
    const cc = merge(base?.cc ?? [], parseRecipients(input.cc, "cc", MAX_RECIPIENTS));
    const bcc = merge(base?.bcc ?? [], parseRecipients(input.bcc, "bcc", MAX_RECIPIENTS));
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS * 3) throw new Error("That is too many recipients for one message.");
    return { to, cc, bcc, subject, markdown, html: markdownToMailHtml(markdown), importance, attachments: await this.attachments(input.attachments) };
  }

  /** Checks attachments an agent passed and captures their bytes for the action. */
  async attachments(list: unknown): Promise<AttachmentUpload[]> {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error("attachments must be a list of { name, content }.");
    if (list.length > MAX_ATTACHMENTS) throw new Error(`A message can have at most ${MAX_ATTACHMENTS} attachments added at once.`);
    const checked = (list as AttachmentInput[]).map(attachmentBytes);
    const total = checked.reduce((sum, attachment) => sum + attachment.bytes.byteLength, 0);
    if (total > MAX_ATTACHMENTS_BYTES) throw new Error("Attachments can add up to at most 20 MB per message.");
    const uploads: AttachmentUpload[] = [];
    for (const attachment of checked) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", attachment.bytes));
      uploads.push({
        name: attachment.name, contentType: attachment.contentType, size: attachment.bytes.byteLength,
        sha256: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join(""),
        file: await this.host.capture(attachment.bytes),
      });
    }
    return uploads;
  }

  /** What the approver should weigh about each recipient before a send. */
  async recipientNotes(message: Composed, conversation?: ReplyContext): Promise<RecipientNote[]> {
    const [mailbox, domains] = await Promise.all([this.mailbox(), this.orgDomains()]);
    const notes: RecipientNote[] = [];
    for (const field of ["to", "cc", "bcc"] as const) {
      for (const recipient of message[field]) {
        const address = recipient.address.toLowerCase();
        const kind = senderKind(address, mailbox.address, domains);
        const reasons: string[] = [];
        if (kind === "external") reasons.push("outside your organization");
        if (kind !== "you" && !(await this.hasWrittenTo(address))) reasons.push("you haven't written to them before");
        if (conversation && !conversation.participants.has(address)) reasons.push("not already in this conversation");
        const sender = conversation?.replyToOf.get(address);
        if (sender !== undefined) reasons.push(`the message asked for replies here, though ${sender} sent it`);
        notes.push({ address: recipient.address, ...(recipient.name ? { name: recipient.name } : {}), field, notes: reasons });
      }
    }
    return notes;
  }

  /** Whether Sent Items holds anything to `address`: a first-time recipient is worth a second look. */
  async hasWrittenTo(address: string): Promise<boolean> {
    return await this.host.cached(`wroteTo:${address}`, CORRESPONDENT_TTL_MS, async () => {
      try {
        const page = await this.mail(mail => mail.get<{ value?: unknown[] }>("/mailFolders/sentitems/messages", {
          $search: kqlPhrase(`recipients:${address}`), $select: "id", $top: 1,
        }));
        return (page.value?.length ?? 0) > 0;
      } catch (error) {
        // Search can lag or fail; saying "first time" wrongly is safer than saying nothing.
        if (error instanceof GraphApiError) return false;
        throw error;
      }
    });
  }

  /** A fresh Internet Message-ID for a send, in the mailbox's domain, which Exchange keeps through sending. */
  async newMessageId(): Promise<string> {
    const { address } = await this.mailbox();
    const domain = address.slice(address.lastIndexOf("@") + 1) || "outlook.invalid";
    return `<gadgets.${crypto.randomUUID()}@${domain}>`;
  }
}

/** `maxChars`, checked, or the default. */
function maxCharsOf(options: ReadOptions | undefined): number {
  const value = options?.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(value) || value < MIN_MAX_CHARS || value > MAX_MAX_CHARS) {
    throw new Error(`maxChars must be a whole number from ${MIN_MAX_CHARS.toLocaleString("en-US")} to ${MAX_MAX_CHARS.toLocaleString("en-US")}.`);
  }
  return value;
}

function pageSizeOf(value: number | undefined): number {
  const size = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw new Error(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  return size;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO 8601 date or time.`);
  return new Date(value).toISOString();
}

/** The session a read-only binding hands out. */
@validateRpc()
export class OutlookReaderImpl extends RpcTarget implements OutlookReader {
  protected readonly ctx: OutlookContext;

  constructor(ctx: OutlookContext) {
    super();
    this.ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }

  async getMailbox(): Promise<MailboxInfo> {
    const ctx = this.ctx;
    const mailbox = await ctx.mailbox();
    const timeZone = await ctx.host.cached("timeZone", ORGANIZATION_TTL_MS, async () => {
      try {
        const body = await ctx.mail(mail => mail.get<{ value?: unknown }>("/mailboxSettings/timeZone"));
        return typeof body.value === "string" ? body.value : null;
      } catch (error) {
        if (error instanceof GraphApiError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    });
    const info: MailboxInfo = {
      address: mailbox.address,
      name: mailbox.name,
      kind: ctx.scope.mailbox.kind === "shared" ? "shared" : "own",
      ...(timeZone ? { timeZone } : {}),
      covers: describeScope(ctx.scope, mailbox.name),
      access: ctx.host.access,
    };
    // A narrowed binding in words names a folder, a conversation's subject or people: mail details,
    // shown only to those who can open the mailbox. "All mail" names nothing.
    await ctx.observe("Read the Outlook connection's mailbox", `Read which mailbox this connection covers: ${md(info.covers)}.`,
      isNarrowed(ctx.scope) ? [(await ctx.units()).mailbox()] : []);
    return info;
  }

  async listFolders(): Promise<FolderInfo[]> {
    const ctx = this.ctx;
    const known = await ctx.wellKnown();
    const wellKnownById = new Map(Object.entries(known).map(([name, id]) => [id, name]));
    const found: GraphFolder[] = [];
    const queue: (string | null)[] = [];
    if (ctx.scope.folder) {
      const top = await ctx.folder(ctx.scope.folder.id);
      if (top === null) throw new Error(`The folder ${ctx.scope.folder.name} this connection is for no longer exists.`);
      found.push(top);
      if (ctx.scope.folder.subfolders) queue.push(top.id);
    } else {
      queue.push(null);
    }
    while (queue.length > 0 && found.length < MAX_FOLDERS) {
      const parent = queue.shift()!;
      const children = await ctx.mail(mail => mail.childFolders(parent, MAX_FOLDERS - found.length));
      for (const child of children) {
        if (!(await admitsFolder(ctx.scope, child.id, ctx.folders))) continue;
        found.push(child);
        if (child.childCount > 0) queue.push(child.id);
      }
    }
    const paths = new Map<string, string>();
    for (const folder of found) {
      const parentPath = folder.parentId ? paths.get(folder.parentId) : undefined;
      paths.set(folder.id, parentPath !== undefined ? `${parentPath}/${folder.name}` : await ctx.folderPath(folder.id));
    }
    const folders: FolderInfo[] = found.map(folder => {
      const wellKnownName = wellKnownById.get(folder.id);
      return {
        id: folder.id, name: folder.name, path: paths.get(folder.id) ?? folder.name,
        ...(wellKnownName !== undefined && isNamedFolder(wellKnownName) ? { wellKnownName } : {}),
        ...(folder.parentId ? { parentId: folder.parentId } : {}),
        unreadCount: folder.unreadCount, totalCount: folder.totalCount, childCount: folder.childCount,
      };
    });
    for (const pending of ctx.overlay().folders) {
      const parentPath = paths.get(pending.parentId) ?? (pending.parentId === known.msgfolderroot ? "" : undefined);
      if (parentPath === undefined) continue;
      folders.push({
        id: pending.id, name: pending.name, path: parentPath ? `${parentPath}/${pending.name}` : pending.name, parentId: pending.parentId,
        unreadCount: 0, totalCount: 0, childCount: 0, pending: "create",
      });
    }
    const units = await ctx.units();
    await ctx.observe("Listed Outlook folders",
      `Listed ${found.length} folder${found.length === 1 ? "" : "s"}: ${found.slice(0, 20).map(folder => md(paths.get(folder.id) ?? folder.name)).join(", ")}${found.length > 20 ? ", …" : ""}.`,
      [units.mailbox(), ...found.map(folder => units.folder(folder.id))]);
    return folders;
  }

  async listMessages(options?: ListMessagesOptions): Promise<Cursor<MessageInfo>> {
    const ctx = this.ctx;
    const size = pageSizeOf(options?.pageSize);
    const filters: ListingFilters = {};
    if (options?.folderId !== undefined) {
      const folder = await ctx.scopedFolder(options.folderId);
      filters.folderId = folder.id;
    }
    if (options?.unread !== undefined) filters.unread = options.unread === true;
    if (options?.flagged !== undefined) filters.flagged = options.flagged === true;
    if (options?.from !== undefined) {
      if (!/^[^\s@]*@[^\s@]+$/.test(options.from)) throw new Error('from must be an address or "@domain".');
      filters.from = options.from.toLowerCase();
    }
    if (options?.category !== undefined) {
      if (options.category === "") throw new Error("category must be a category name.");
      filters.category = options.category;
    }
    if (options?.since !== undefined) filters.since = isoDate(options.since, "since");
    if (options?.focused !== undefined) filters.focused = options.focused === true;

    const overlay = ctx.overlay();
    const known = await ctx.wellKnown();
    // A pending folder holds nothing yet but what pending moves put there, and has no Graph path.
    const pendingFolder = filters.folderId !== undefined && isProvisional(filters.folderId);
    const request = pendingFolder ? undefined : listingRequest(ctx.scope, filters);
    // The folder listed, or none when the listing spans the mailbox.
    const listedFolder = filters.folderId ?? ctx.scope.folder?.id ?? (request?.path === "/messages" ? undefined : known.inbox);

    // Messages pending a move into this folder are fetched and guarded like any other, then listed first.
    const movedIn = listedFolder === undefined ? [] : [...overlay.moved].filter(([, to]) => to === listedFolder).map(([id]) => id);
    const drafts = listedFolder !== undefined && listedFolder === known.drafts
      ? overlay.pendingDrafts({ id: known.drafts, path: await ctx.folderPath(known.drafts) }, await ctx.mailbox()) : [];

    const walk = ctx.gate.lease();
    const units = await ctx.units();
    const where = listedFolder ? md(await ctx.folderPath(listedFolder)) : "the mailbox";
    let first = true;
    return new TokenCursor<MessageInfo>({
      pageSize: size,
      remotePageSize: size,
      dispose: () => walk[Symbol.dispose](),
      inject: {
        items: drafts,
        compare: (a, b) => b.receivedAt.localeCompare(a.receivedAt),
        identity: info => info.id,
      },
      fetchPage: async (token, perPage) => {
        let moved: GraphMessage[] = [];
        if (first) {
          first = false;
          if (movedIn.length) {
            const found = await ctx.mail(mail => mail.messages(movedIn.filter(isMailId)));
            for (const message of found.values()) if (await ctx.covers(message)) moved.push(message);
            moved = moved.filter(message => passesFilters(filters, { ...message, flagStatus: message.flag.status }));
          }
        }
        if (request === undefined) return { items: await ctx.infos(moved, overlay) };
        const page = await ctx.mail(mail => mail.page(token ?? request.path, parseMessage, "message",
          token ? undefined : { ...request.query, $select: MESSAGE_SELECT, $top: perPage }));
        const kept: GraphMessage[] = [];
        for (const message of page.items) {
          if (overlay.hides(message.id) || movedIn.includes(message.id)) continue;
          // Moved out of the listed folder by a pending action.
          const to = overlay.moved.get(message.id);
          if (listedFolder !== undefined && to !== undefined && to !== listedFolder) continue;
          if (!passesFilters(filters, { ...message, flagStatus: message.flag.status })) continue;
          if (await ctx.covers(message)) kept.push(message);
        }
        return { items: await ctx.infos([...moved, ...kept], overlay), ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
      },
      authorizePage: (items, { terminal }) => items.length === 0
        ? walk.authorize({ title: "Listed Outlook messages", description: `Listed messages in ${where}${terminal ? "; there were no more" : ""}.` },
          { kind: "collections", ids: [listedFolder && !isProvisional(listedFolder) ? units.folder(listedFolder) : units.mailbox()] })
        : walk.authorize({
          title: "Listed Outlook messages",
          description: `Listed ${items.length} message${items.length === 1 ? "" : "s"} in ${where}: ${listed(items)}.`,
        }, { kind: "collections", ids: items.map(item => units.message(item.id)) }),
    });
  }

  async search(query: string, options?: MailSearchOptions): Promise<Cursor<MessageInfo>> {
    const ctx = this.ctx;
    if (query.trim() === "") throw new Error("Pass something to search for.");
    if (query.length > MAX_SEARCH_CHARS) throw new Error(`A search can be at most ${MAX_SEARCH_CHARS} characters.`);
    // oxlint-disable-next-line no-control-regex -- a search is one line
    if (/[\u0000-\u001f\u007f]/.test(query)) throw new Error("A search can't contain line breaks or control characters.");
    const size = pageSizeOf(options?.pageSize);
    const folder = options?.folderId !== undefined ? await ctx.scopedFolder(options.folderId) : ctx.scope.folder ? { id: ctx.scope.folder.id } : undefined;
    if (folder && isProvisional(folder.id)) return new TokenCursor<MessageInfo>({ pageSize: size, fetchPage: async () => ({ items: [] }), authorizePage: async () => {} });
    const path = folder ? `/mailFolders/${idPath(folder.id)}/messages` : "/messages";
    const search = kqlPhrase(query.trim());
    const overlay = ctx.overlay();
    const walk = ctx.gate.lease();
    const units = await ctx.units();
    return new TokenCursor<MessageInfo>({
      pageSize: size,
      remotePageSize: size,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async token => {
        const page = await ctx.mail(mail => mail.page(token ?? path, parseMessage, "message",
          token ? undefined : { $search: search, $select: MESSAGE_SELECT, $top: size }));
        const kept: GraphMessage[] = [];
        for (const message of page.items) {
          if (!overlay.hides(message.id) && await ctx.covers(message)) kept.push(message);
        }
        return { items: await ctx.infos(kept, overlay), ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
      },
      authorizePage: (items, { terminal }) => items.length === 0
        ? walk.authorize({ title: "Searched Outlook", description: `Searched for ${md(query)}${terminal ? "; nothing more matched" : ""}.` },
          { kind: "collections", ids: [folder ? units.folder(folder.id) : units.mailbox()] })
        : walk.authorize({
          title: "Searched Outlook",
          description: `Searched for ${md(query)} and found ${items.length} message${items.length === 1 ? "" : "s"}: ${listed(items)}.`,
        }, { kind: "collections", ids: items.map(item => units.message(item.id)) }),
    });
  }

  async getMessage(id: string): Promise<MessageInfo> {
    const ctx = this.ctx;
    const draft = this.#pendingDraft(id);
    if (draft) return draft;
    const message = await ctx.guarded(id);
    const [info] = await ctx.infos([message]);
    await ctx.observe("Read an Outlook message's details", `Read the details of ${line(info!)}.`, [(await ctx.units()).message(message.id)]);
    return info!;
  }

  async readMessage(id: string, options?: ReadOptions): Promise<MessageContent> {
    const ctx = this.ctx;
    const maxChars = maxCharsOf(options);
    const draft = this.#pendingDraft(id);
    if (draft) {
      const pending = ctx.overlay().drafts.get(this.ctx.host.resolve(id))!;
      const edit = ctx.overlay().draftEdits.get(pending.id) ?? pending.message;
      return { info: draft, markdown: edit.markdown.slice(0, maxChars), links: [], removed: [], truncated: edit.markdown.length > maxChars,
        note: "This draft awaits approval; this is the text it will be saved with." };
    }
    const message = await ctx.guarded(id);
    const [info] = await ctx.infos([message]);
    const overlay = ctx.overlay();
    const edit = message.isDraft ? overlay.draftEdits.get(message.id) : undefined;
    const [body, attachments] = await Promise.all([
      edit ? Promise.resolve({ contentType: "html" as const, content: edit.html }) : ctx.mail(mail => mail.body(message.id)),
      message.hasAttachments ? ctx.mail(mail => mail.attachments(message.id)) : Promise.resolve([]),
    ]);
    const protectedBy = attachments.find(attachment => /^(message\.rpmsg|smime\.p7m)$/i.test(attachment.name));
    if (protectedBy) {
      info!.protection = "encrypted";
      await ctx.observe("Read an Outlook message", `Read ${line(info!)}, which is encrypted.`, [(await ctx.units()).message(message.id)]);
      return { info: info!, markdown: "", links: [], removed: [], truncated: false,
        note: "This message is encrypted (Microsoft Purview or S/MIME). Open it in Outlook to read it." };
    }
    const converted = mailToMarkdown(body, { maxChars });
    await ctx.observe("Read an Outlook message", `Read ${line(info!)}.`, [(await ctx.units()).message(message.id)]);
    return {
      info: info!, markdown: converted.markdown, links: converted.links, removed: converted.removed, truncated: converted.truncated,
      ...(edit ? { note: "A change to this draft awaits approval; this is the text it will have." } : {}),
    };
  }

  async readConversation(id: string, options?: ReadOptions): Promise<Conversation> {
    const ctx = this.ctx;
    const maxChars = maxCharsOf(options);
    const resolved = ctx.host.resolve(id);
    if (!isMailId(resolved)) throw new OutsideMailboxError("That conversation");
    // A message ID names its conversation; otherwise the ID is taken as the conversation's own.
    let conversationId = resolved;
    const named = await ctx.mail(mail => mail.message(resolved));
    if (named !== null) {
      if (!(await ctx.covers(named))) throw new OutsideMailboxError("That conversation");
      conversationId = named.conversationId;
    }
    const page = await ctx.mail(mail => mail.page("/messages", parseMessage, "message", {
      $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq ${odataString(conversationId)}`,
      // The latest messages, so a long thread's newest replies are never the ones left out.
      $orderby: "receivedDateTime desc", $select: MESSAGE_SELECT, $top: MAX_CONVERSATION_MESSAGES,
    }));
    const overlay = ctx.overlay();
    const covered: GraphMessage[] = [];
    for (const message of page.items.toReversed()) if (!overlay.hides(message.id) && await ctx.covers(message)) covered.push(message);
    if (covered.length === 0) throw new OutsideMailboxError("That conversation");
    const infos = await ctx.infos(covered, overlay);
    const messages: ConversationMessage[] = [];
    let budget = maxChars;
    for (const [index, message] of covered.entries()) {
      const body = await ctx.mail(mail => mail.body(message.id, true));
      const converted = mailToMarkdown(body, { maxChars: Math.max(MIN_MAX_CHARS, budget) });
      budget = Math.max(0, budget - converted.markdown.length);
      messages.push({ info: infos[index]!, markdown: converted.markdown, truncated: converted.truncated });
    }
    const units = await ctx.units();
    const subject = covered[0]!.subject || "(no subject)";
    await ctx.observe("Read an Outlook conversation",
      `Read ${covered.length} message${covered.length === 1 ? "" : "s"} of the conversation ${md(subject)}: ${listed(infos)}.`,
      covered.map(message => units.message(message.id)));
    return {
      id: conversationId, subject, messages,
      ...(page.items.length > covered.length ? { partial: true as const } : {}),
      ...(page.nextLink !== undefined ? { olderOmitted: true as const } : {}),
    };
  }

  async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const ctx = this.ctx;
    if (this.#pendingDraft(messageId)) return [];
    const message = await ctx.guarded(messageId);
    const attachments = await ctx.mail(mail => mail.attachments(message.id));
    const [info] = await ctx.infos([message]);
    await ctx.observe("Listed an Outlook message's attachments",
      `Listed ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} of ${line(info!)}${attachments.length ? `: ${attachments.slice(0, 20).map(attachment => md(attachment.name)).join(", ")}` : ""}.`,
      [(await ctx.units()).message(message.id)]);
    return attachments.map(({ contentId: _contentId, ...attachment }) => attachment);
  }

  async readAttachment(messageId: string, attachmentId: string, options?: ReadOptions): Promise<AttachmentContent> {
    const maxChars = maxCharsOf(options);
    const { info, bytes } = await this.#attachment(messageId, attachmentId, "Read an Outlook attachment");
    if (bytes === null) {
      return { info, format: "none", content: "", truncated: false,
        note: info.kind === "item" ? "This attachment is an email or event, which can't be read as a file." : "This attachment is a link to a file in the cloud; open it there." };
    }
    // An HTML attachment is the sender's too, so it is read as a body is, hidden text and all.
    if (info.contentType === "text/html" || /\.html?$/i.test(info.name)) {
      const cut = bytes.byteLength > maxChars * 4;
      const content = new TextDecoder("utf-8").decode(cut ? bytes.subarray(0, maxChars * 4) : bytes);
      const converted = mailToMarkdown({ contentType: "html", content }, { maxChars });
      return { info, format: "markdown", content: converted.markdown, truncated: cut || converted.truncated, links: converted.links, removed: converted.removed };
    }
    const converted = await convertBytes(this.ctx.host.ai, info.name, info.contentType, bytes, maxChars);
    return { info, ...converted };
  }

  async readAttachmentBytes(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const { info, bytes } = await this.#attachment(messageId, attachmentId, "Downloaded an Outlook attachment");
    if (bytes === null) throw new Error(`"${info.name}" isn't a file attachment, so it has no bytes to read.`);
    return bytes;
  }

  async listCategories(): Promise<Category[]> {
    const ctx = this.ctx;
    const body = await ctx.mail(mail => mail.get<{ value?: { displayName?: unknown; color?: unknown }[] }>("/outlook/masterCategories"));
    const categories = (body.value ?? []).flatMap(category => typeof category.displayName === "string"
      ? [{ name: category.displayName, color: typeof category.color === "string" ? category.color : "none" }] : []);
    await ctx.observe("Listed Outlook categories", `Listed the mailbox's ${categories.length} categories.`, [(await ctx.units()).mailbox()]);
    return categories;
  }

  async findPeople(query: string): Promise<Person[]> {
    const ctx = this.ctx;
    if (query.trim().length < 2) throw new Error("Pass at least two characters of a name or address.");
    if (query.length > 100) throw new Error("A name or address to look up can be at most 100 characters.");
    // People are the signed-in user's own relevance list, whichever mailbox the binding is for.
    const body = await ctx.host.read(api => api.get<{ value?: Record<string, unknown>[] }>("/me/people", {
      query: { $search: kqlPhrase(query.trim()), $top: 10, $select: "displayName,scoredEmailAddresses,jobTitle,department,personType" },
    }));
    const [mailbox, domains] = await Promise.all([ctx.mailbox(), ctx.orgDomains()]);
    const people: Person[] = [];
    for (const row of body.value ?? []) {
      const emails = Array.isArray(row.scoredEmailAddresses) ? row.scoredEmailAddresses as { address?: unknown }[] : [];
      const address = emails.map(email => email.address).find((value): value is string => typeof value === "string" && value.includes("@"));
      if (!address) continue;
      people.push({
        name: typeof row.displayName === "string" ? row.displayName : address,
        address,
        external: senderKind(address, mailbox.address, domains) === "external",
        ...(typeof row.jobTitle === "string" && row.jobTitle ? { jobTitle: row.jobTitle } : {}),
        ...(typeof row.department === "string" && row.department ? { department: row.department } : {}),
      });
    }
    const me = await ctx.host.owner();
    await ctx.observe("Looked up people in Microsoft 365",
      `Looked up ${md(query)} and found ${people.length}: ${people.slice(0, 10).map(person => md(person.name)).join(", ")}.`,
      [mailUnits(me.objectId).mailbox()]);
    return people;
  }

  async subscribeNewMessages(hook: RpcStub<OutlookHookTarget>): Promise<void> {
    await this.ctx.host.subscribe(this.ctx, hook);
  }

  /** A pending draft by its `~N` ID, as reads show it. */
  #pendingDraft(id: string): MessageInfo | undefined {
    if (typeof id !== "string") return undefined;
    const resolved = this.ctx.host.resolve(id);
    if (!isProvisional(resolved)) return undefined;
    const overlay = this.ctx.overlay();
    if (!overlay.drafts.has(resolved)) throw new OutsideMailboxError();
    // Pending drafts are this session's own: their folder path needs no read.
    return overlay.pendingDrafts({ id: "drafts", path: "Drafts" }, { address: "" }).find(draft => draft.id === resolved);
  }

  async #attachment(messageId: string, attachmentId: string, title: string): Promise<{ info: AttachmentInfo; bytes: Uint8Array | null }> {
    const ctx = this.ctx;
    const message = await ctx.guarded(messageId);
    if (!isMailId(attachmentId)) throw new OutsideMailboxError("That attachment");
    const attachments = await ctx.mail(mail => mail.attachments(message.id));
    const found = attachments.find(attachment => attachment.id === attachmentId);
    if (found === undefined) throw new OutsideMailboxError("That attachment");
    const { contentId: _contentId, ...info } = found;
    if (info.size > MAX_ATTACHMENT_READ_BYTES) throw new Error(`"${info.name}" is over 25 MB, which is more than can be read here.`);
    const [messageInfo] = await ctx.infos([message]);
    await ctx.observe(title, `${title === "Read an Outlook attachment" ? "Read" : "Downloaded"} ${md(info.name)} from ${line(messageInfo!)}.`,
      [(await ctx.units()).message(message.id)]);
    if (info.kind !== "file") return { info, bytes: null };
    try {
      const download = await ctx.mail(mail => mail.api.download(`${mail.base}/messages/${idPath(message.id)}/attachments/${idPath(info.id)}/$value`, MAX_ATTACHMENT_READ_BYTES));
      return { info, bytes: download.bytes };
    } catch (error) {
      if (error instanceof DownloadTooLargeError) throw new Error(`"${info.name}" is over 25 MB, which is more than can be read here.`, { cause: error });
      throw error;
    }
  }
}

/** Read access plus changes, each proposed for approval. */
@validateRpc()
export class OutlookSessionImpl extends OutlookReaderImpl implements OutlookSession {
  // -- organize (access "draft") ---------------------------------------------------------------

  async move(ids: string[], folderId: string): Promise<MessageInfo[]> {
    this.#require("draft", "move mail");
    const to = await this.ctx.destinationFolder(folderId);
    return await this.#move(ids, to, "move");
  }

  async archive(ids: string[]): Promise<MessageInfo[]> {
    this.#require("draft", "archive mail");
    const known = await this.ctx.wellKnown();
    if (known.archive === undefined) throw new Error("This mailbox has no Archive folder.");
    return await this.#move(ids, { id: known.archive, name: "Archive", path: "Archive" }, "archive");
  }

  async delete(ids: string[]): Promise<void> {
    this.#require("draft", "delete mail");
    const known = await this.ctx.wellKnown();
    if (known.deleteditems === undefined) throw new Error("This mailbox has no Deleted Items folder.");
    await this.#move(ids, { id: known.deleteditems, name: "Deleted Items", path: "Deleted Items" }, "delete");
  }

  async markRead(ids: string[], read = true): Promise<MessageInfo[]> {
    this.#require("draft", "mark mail read");
    return await this.#update(ids, { isRead: read });
  }

  async flag(ids: string[], flag: { status: "flagged" | "complete" | "notFlagged"; dueAt?: string }): Promise<MessageInfo[]> {
    this.#require("draft", "flag mail");
    if (flag.dueAt !== undefined && flag.status !== "flagged") throw new Error("Only a flag being set can have a due date.");
    return await this.#update(ids, { flag: { status: flag.status, ...(flag.dueAt !== undefined ? { dueAt: isoDate(flag.dueAt, "dueAt") } : {}) } });
  }

  async categorize(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<MessageInfo[]> {
    this.#require("draft", "categorize mail");
    const names = (list: unknown, field: string) => {
      if (list === undefined) return undefined;
      if (!Array.isArray(list) || list.length > MAX_CATEGORIES) throw new Error(`${field} must be a list of at most ${MAX_CATEGORIES} category names.`);
      for (const name of list) {
        // oxlint-disable-next-line no-control-regex -- a category name is one line
        if (typeof name !== "string" || name.trim() === "" || name.length > 255 || /[\u0000-\u001f\u007f,;]/.test(name)) {
          throw new Error(`${field}: "${String(name)}" isn't a category name.`);
        }
      }
      return [...new Set(list as string[])];
    };
    const add = names(change?.add, "add");
    const remove = names(change?.remove, "remove");
    if (!add?.length && !remove?.length) throw new Error("Pass categories to add or remove.");
    return await this.#update(ids, { ...(add?.length ? { addCategories: add } : {}), ...(remove?.length ? { removeCategories: remove } : {}) });
  }

  async createFolder(parentId: string, name: string): Promise<FolderInfo> {
    this.#require("draft", "create folders");
    const ctx = this.ctx;
    if (name.trim() === "" || name.length > 255) throw new Error("A folder name must be 1 to 255 characters.");
    // oxlint-disable-next-line no-control-regex -- a folder name is one line
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("A folder name can't contain line breaks or control characters.");
    const known = await ctx.wellKnown();
    const atTop = parentId === "msgfolderroot" || parentId === known.msgfolderroot;
    if (atTop && isNarrowed(ctx.scope)) throw new OutsideMailboxError("The top of the mailbox");
    const parent = atTop ? { id: known.msgfolderroot!, name: "the top of the mailbox", path: "" } : await ctx.destinationFolder(parentId);
    if (!isProvisional(parent.id)) {
      const siblings = await ctx.mail(mail => mail.childFolders(parent.id === known.msgfolderroot ? null : parent.id));
      if (siblings.some(folder => folder.name.toLowerCase() === name.trim().toLowerCase())) {
        throw new Error(`${parent.path || "The mailbox"} already has a folder named "${name.trim()}".`);
      }
    }
    if (ctx.overlay().folders.some(folder => folder.parentId === parent.id && folder.name.toLowerCase() === name.trim().toLowerCase())) {
      throw new Error(`A folder named "${name.trim()}" is already waiting to be created there.`);
    }
    const ref = ctx.host.allocate("folder");
    await ctx.host.submit(ctx.queue, "createFolder", { mailbox: ctx.scope.mailbox, ref, parent, name: name.trim(), submittedAt: Date.now() });
    return {
      id: ref, name: name.trim(), path: parent.path ? `${parent.path}/${name.trim()}` : name.trim(), parentId: parent.id,
      unreadCount: 0, totalCount: 0, childCount: 0, pending: "create",
    };
  }

  // -- drafts ----------------------------------------------------------------------------------

  async createDraft(message: MessageInput): Promise<MessageInfo> {
    this.#require("draft", "write drafts");
    const composed = await this.ctx.compose(message);
    return await this.#stageDraft({ kind: "new" }, composed);
  }

  async createReplyDraft(messageId: string, body: string, options?: ReplyOptions): Promise<MessageInfo> {
    this.#require("draft", "write drafts");
    const { origin, composed } = await this.#reply(messageId, body, options);
    return await this.#stageDraft(origin, composed);
  }

  async createForwardDraft(messageId: string, to: Recipient[], body?: string, options?: ForwardOptions): Promise<MessageInfo> {
    this.#require("draft", "write drafts");
    const { origin, composed } = await this.#forward(messageId, to, body, options);
    return await this.#stageDraft(origin, composed);
  }

  async updateDraft(draftId: string, patch: DraftPatch): Promise<MessageInfo> {
    this.#require("draft", "write drafts");
    const ctx = this.ctx;
    const draft = await this.#draft(draftId, { own: true });
    this.#refuseWhileSending(draft.id);
    // A created draft is read from Outlook, which a pending edit hasn't reached: a second edit would
    // start from the old text and be fenced on a version the first edit moves.
    if (!draft.provisional && ctx.overlay().draftEdits.has(draft.id)) {
      throw new Error("This draft already has an edit waiting for approval. Wait until it's approved or rejected before changing it again.");
    }
    const removals = patch.removeAttachments ?? [];
    if (removals.some(id => !isMailId(id))) throw new Error("removeAttachments must be a list of attachment IDs.");
    const existing = draft.provisional || removals.length === 0 ? [] : await ctx.mail(mail => mail.attachments(draft.id));
    const removeAttachments = removals.map(id => {
      const found = existing.find(attachment => attachment.id === id);
      if (found === undefined) throw new OutsideMailboxError("That attachment");
      return { id, name: found.name };
    });
    const next = await ctx.compose({
      to: patch.to ?? draft.message.to.map(format), cc: patch.cc ?? draft.message.cc.map(format), bcc: patch.bcc ?? draft.message.bcc.map(format),
      subject: patch.subject ?? draft.message.subject, body: patch.body ?? draft.message.markdown,
      importance: patch.importance ?? draft.message.importance, attachments: patch.attachments,
    });
    if (patch.subject !== undefined && draft.isReplyOrForward) throw new Error("A reply's or forward's subject is Outlook's own and can't be changed here.");
    // For a reply or forward, the new text replaces the draft's own part; Outlook's quoted original stays.
    const html = patch.body === undefined ? draft.message.html : draft.isReplyOrForward ? replaceOwnPart(draft.message.html, next.html) : next.html;
    if (html.length > MAX_STORED_HTML_CHARS) throw new Error("This draft is too large to edit here. Edit it in Outlook instead.");
    const message: Composed = { ...next, html, attachments: [...(draft.provisional ? draft.message.attachments : []), ...next.attachments] };
    if (draft.provisional) {
      // A draft not yet created is edited by replacing what its creation will write.
      await ctx.host.submit(ctx.queue, "updateDraft", {
        mailbox: ctx.scope.mailbox, draftId: draft.id, subject: draft.message.subject, message: { ...message, attachments: next.attachments },
        before: { ...draft.message }, removeAttachments: [], ...(draft.isReplyOrForward ? { keepsQuote: true as const } : {}), submittedAt: Date.now(),
      });
    } else {
      await ctx.host.submit(ctx.queue, "updateDraft", {
        mailbox: ctx.scope.mailbox, draftId: draft.id, subject: draft.message.subject, message: { ...message, attachments: next.attachments },
        before: { to: draft.message.to, cc: draft.message.cc, bcc: draft.message.bcc, subject: draft.message.subject, markdown: draft.message.markdown,
          html: draft.message.html, importance: draft.message.importance },
        removeAttachments, ...(draft.changeKey ? { changeKey: draft.changeKey } : {}), submittedAt: Date.now(),
      });
    }
    return await this.#draftInfo(draft.id);
  }

  async deleteDraft(draftId: string): Promise<void> {
    this.#require("draft", "delete drafts");
    const draft = await this.#draft(draftId, { own: true });
    this.#refuseWhileSending(draft.id);
    await this.ctx.host.submit(this.ctx.queue, "deleteDraft", { mailbox: this.ctx.scope.mailbox, draftId: draft.id, subject: draft.message.subject, submittedAt: Date.now() });
  }

  // -- sending ---------------------------------------------------------------------------------

  async send(draftId: string): Promise<MessageInfo> {
    this.#require("send", "send mail");
    const ctx = this.ctx;
    const draft = await this.#draft(draftId);
    const overlay = ctx.overlay();
    if (overlay.sending.has(draft.id)) throw new Error("This draft is already waiting to be sent.");
    // The send is fenced on the draft as the approver sees it, which a pending edit would change.
    if (overlay.draftEdits.has(draft.id)) {
      throw new Error("This draft has an edit waiting for approval. Send it once that edit is approved, or send a new message with sendMail.");
    }
    const message = draft.message;
    if (message.to.length + message.cc.length + message.bcc.length === 0) throw new Error("The draft has no recipients.");
    let fence: { id: string; changeKey: string } | { id: string; created: true };
    let origin: Origin = { kind: "new" };
    let attached: AttachedFile[];
    if (draft.provisional) {
      const pending = overlay.drafts.get(draft.id)!;
      // Outlook writes the quoted original under a reply or forward when the draft is created, and
      // that quote is what the complete-draft check below reads: until then it can't be shown.
      if (pending.origin.kind !== "new") {
        throw new Error("This reply or forward draft hasn't been created yet, so what Outlook will quote under it can't be shown to the approver. " +
          "Send it once it has been created, or send directly with reply or forward.");
      }
      fence = { id: draft.id, created: true };
      origin = pending.origin;
      attached = pending.message.attachments.map(({ name, contentType, size }) => ({ name, contentType, size }));
    } else {
      // The approver reads the draft as Markdown, which leaves out hidden text: a stylesheet in a
      // quoted original can hide the reply's own words. What would be sent must be what is shown.
      if (draft.incomplete) {
        throw new Error("This draft has text that doesn't show when it's read, or is too long to show in full, so its approval couldn't show everything it would send. " +
          "Send a new reply or message with reply or sendMail instead, or send the draft from Outlook.");
      }
      if (draft.changeKey === undefined) throw new Error("Outlook didn't say which version of this draft it is, so it can't be sent from here. Send it in Outlook.");
      fence = { id: draft.id, changeKey: draft.changeKey };
      attached = attachedFiles(await ctx.mail(mail => mail.attachments(draft.id)));
    }
    await ctx.host.submit(ctx.queue, "send", {
      mailbox: ctx.scope.mailbox, internetMessageId: await ctx.newMessageId(), draft: fence,
      origin, message: { ...message, attachments: [] }, recipients: await ctx.recipientNotes(message),
      ...(attached.length ? { attached } : {}), submittedAt: Date.now(),
    });
    return await this.#draftInfo(draft.id);
  }

  async sendMail(message: MessageInput): Promise<MessageInfo> {
    this.#require("send", "send mail");
    const composed = await this.ctx.compose(message);
    return await this.#stageSend({ kind: "new" }, composed);
  }

  async reply(messageId: string, body: string, options?: ReplyOptions): Promise<MessageInfo> {
    this.#require("send", "send mail");
    const { origin, composed, conversation } = await this.#reply(messageId, body, options);
    return await this.#stageSend(origin, composed, conversation);
  }

  async forward(messageId: string, to: Recipient[], body?: string, options?: ForwardOptions): Promise<MessageInfo> {
    this.#require("send", "send mail");
    const { origin, composed } = await this.#forward(messageId, to, body, options);
    return await this.#stageSend(origin, composed);
  }

  // -- automatic replies -------------------------------------------------------------------------

  async getAutomaticReplies(): Promise<AutomaticReplies> {
    this.#require("draft", "read automatic replies");
    const current = await this.#automaticReplies();
    await this.ctx.observe("Read Outlook automatic replies", `Read the mailbox's automatic replies (${current.status}).`, [(await this.ctx.units()).mailbox()]);
    const { internalHtml: _internal, externalHtml: _external, ...replies } = current;
    return replies;
  }

  async setAutomaticReplies(replies: AutomaticReplies): Promise<void> {
    // An automatic reply sends its text to whoever writes, outside the organization too: a send.
    this.#require("send", "change automatic replies");
    const internalReply = checkBody(replies.internalReply ?? "");
    const externalReply = checkBody(replies.externalReply ?? "");
    if (internalReply.length > 8_000 || externalReply.length > 8_000) throw new Error("An automatic reply can be at most 8,000 characters.");
    let start: string | undefined;
    let end: string | undefined;
    if (replies.status === "scheduled") {
      start = isoDate(replies.start, "start");
      end = isoDate(replies.end, "end");
      if (Date.parse(end) <= Date.parse(start)) throw new Error("end must be after start.");
      if (Date.parse(end) <= Date.now()) throw new Error("end is in the past.");
    }
    const before = await this.#automaticReplies();
    const setting: AutomaticRepliesSetting = {
      status: replies.status, internalReply, externalReply, externalAudience: replies.externalAudience, ...(start ? { start } : {}), ...(end ? { end } : {}),
    };
    await this.ctx.host.submit(this.ctx.queue, "setAutomaticReplies", {
      mailbox: this.ctx.scope.mailbox,
      replies: { ...setting, internalHtml: markdownToMailHtml(internalReply), externalHtml: markdownToMailHtml(externalReply) },
      before, submittedAt: Date.now(),
    });
  }

  // -- helpers ---------------------------------------------------------------------------------

  #require(level: OutlookAccessLevel, what: string): void {
    if (!allows(this.ctx.host.access, level)) {
      throw new Error(`This Outlook connection can ${this.ctx.host.access === "read" ? "only read mail" : `only ${this.ctx.host.access} mail`}, so it can't ${what}. Its owner can widen it in the connection's settings.`);
    }
  }

  async #move(ids: string[], to: FolderTarget, as: "move" | "archive" | "delete"): Promise<MessageInfo[]> {
    const ctx = this.ctx;
    const guarded = await ctx.guardedAll(ids);
    // Already there once pending moves apply: a message with a move pending reads from where it is going.
    const moved = ctx.overlay().moved;
    const messages = guarded.filter(message => (moved.get(message.id) ?? message.parentFolderId) !== to.id);
    if (messages.length === 0) return await this.#shown(guarded, await ctx.infos(guarded));
    // Drafts stay in Drafts, and only one this binding wrote is its to remove: deleteDraft checks that.
    if (messages.some(message => message.isDraft)) throw new Error("Drafts stay in Drafts; use deleteDraft to remove one this connection wrote.");
    // A message with a move pending comes from where that move puts it: that is where undoing this one returns it.
    const targets = await Promise.all(messages.map(async message => {
      const from = moved.get(message.id);
      const target = await ctx.target(message);
      return from === undefined ? target : { ...target, folderId: from, folder: await ctx.folderPath(from) };
    }));
    await this.#shown(messages, await ctx.infos(messages));
    await ctx.host.submit(ctx.queue, "moveMessages", { mailbox: ctx.scope.mailbox, messages: targets, to, as, submittedAt: Date.now() });
    return as === "delete" ? [] : await ctx.infos(messages);
  }

  /** Records `infos` as read, as `getMessage` does: what a change returns describes the messages too. */
  async #shown(messages: readonly GraphMessage[], infos: MessageInfo[]): Promise<MessageInfo[]> {
    const units = await this.ctx.units();
    await this.ctx.observe("Read Outlook messages' details", `Read the details of ${listed(infos)}.`, messages.map(message => units.message(message.id)));
    return infos;
  }

  async #update(ids: string[], change: OutlookActions["updateMessages"]["change"]): Promise<MessageInfo[]> {
    const ctx = this.ctx;
    const messages = await ctx.guardedAll(ids);
    const overlay = ctx.overlay();
    const current = await ctx.infos(messages, overlay);
    const targets = await Promise.all(messages.map(async (message, index) => {
      // `before` is the state a revert returns to: as it reads now, pending changes included.
      const info = current[index]!;
      const before: MessageState = { isRead: info.isRead, flag: info.flag.dueAt ? { status: info.flag.status, dueAt: info.flag.dueAt } : { status: info.flag.status }, categories: info.categories };
      return { ...(await ctx.target(message)), before };
    }));
    await this.#shown(messages, current);
    await ctx.host.submit(ctx.queue, "updateMessages", { mailbox: ctx.scope.mailbox, messages: targets, change, submittedAt: Date.now() });
    return await ctx.infos(messages);
  }

  /** A draft waiting to be sent stays as the approver of that send saw it. */
  #refuseWhileSending(draftId: string): void {
    if (this.ctx.overlay().sending.has(draftId)) throw new Error("This draft is waiting to be sent, so it can't be changed until that send is decided.");
  }

  /**
   * A draft the agent named, proven in scope, with its current content. With `own`, a real draft
   * must be one this binding wrote: its changes can be auto-approved, and a change to a draft the
   * user is about to send from Outlook would go out unseen.
   */
  async #draft(draftId: string, options: { own?: boolean } = {}): Promise<{ id: string; provisional: boolean; message: Composed; changeKey?: string; isReplyOrForward: boolean; incomplete?: true }> {
    const ctx = this.ctx;
    const resolved = ctx.host.resolve(draftId);
    const overlay = ctx.overlay();
    if (isProvisional(resolved)) {
      const pending = overlay.drafts.get(resolved);
      if (pending === undefined || overlay.deletedDrafts.has(resolved)) throw new OutsideMailboxError("That draft");
      return { id: resolved, provisional: true, message: overlay.draftEdits.get(resolved) ?? pending.message, isReplyOrForward: pending.origin.kind !== "new" };
    }
    if (!isMailId(resolved) || (options.own && !ctx.host.ownDrafts().has(resolved))) throw new OutsideMailboxError("That draft");
    const read = await ctx.mail(mail => mail.draft(resolved));
    if (read === null || !(await ctx.covers(read.message))) throw new OutsideMailboxError("That draft");
    const { message, body, changeKey, conversationIndex } = read;
    if (!message.isDraft) throw new Error("That message has been sent; only drafts can be changed.");
    if (overlay.deletedDrafts.has(message.id)) throw new OutsideMailboxError("That draft");
    const html = body.contentType === "html" ? body.content : markdownToMailHtml(body.content);
    if (html.length > MAX_STORED_HTML_CHARS) throw new Error("This draft is too large to change here. Change it in Outlook instead.");
    const converted = mailToMarkdown(body, { maxChars: MAX_WRITE_BODY_CHARS });
    const units = await ctx.units();
    await ctx.observe("Read an Outlook draft", `Read the draft ${md(message.subject || "(no subject)")}.`, [units.message(message.id)]);
    // A conversation index longer than a new message's 22 bytes means Outlook threaded it: a reply or forward.
    return {
      id: message.id, provisional: false,
      message: { to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, markdown: converted.markdown, html, importance: message.importance, attachments: [] },
      ...(changeKey !== undefined ? { changeKey } : {}),
      ...(converted.hidesText || converted.truncated ? { incomplete: true as const } : {}),
      isReplyOrForward: conversationIndex.length > 32 || /divRplyFwdMsg|appendonsend/i.test(html),
    };
  }

  async #draftInfo(id: string): Promise<MessageInfo> {
    if (isProvisional(id)) return await this.getMessage(id);
    const message = await this.ctx.guarded(id);
    return (await this.ctx.infos([message]))[0]!;
  }

  async #stageDraft(origin: Origin, composed: Composed): Promise<MessageInfo> {
    const ctx = this.ctx;
    const ref = ctx.host.allocate("draft");
    await ctx.host.submit(ctx.queue, "createDraft", { mailbox: ctx.scope.mailbox, ref, origin, message: composed, submittedAt: Date.now() });
    return await this.getMessage(ref);
  }

  async #stageSend(origin: Origin, composed: Composed, conversation?: ReplyContext): Promise<MessageInfo> {
    const ctx = this.ctx;
    if (composed.to.length + composed.cc.length + composed.bcc.length === 0) throw new Error("Pass at least one recipient.");
    const mailbox = await ctx.mailbox();
    await ctx.host.submit(ctx.queue, "send", {
      mailbox: ctx.scope.mailbox, internetMessageId: await ctx.newMessageId(), origin, message: composed,
      recipients: await ctx.recipientNotes(composed, conversation), submittedAt: Date.now(),
    });
    const at = new Date().toISOString();
    return {
      id: "", conversationId: origin.kind === "new" ? "" : origin.source.conversationId ?? "", folderId: "", folder: "Sent Items",
      subject: composed.subject, from: mailbox, senderKind: "you", to: composed.to, cc: composed.cc, ...(composed.bcc.length ? { bcc: composed.bcc } : {}),
      receivedAt: at, isRead: true, isDraft: false, importance: composed.importance, flag: { status: "notFlagged" }, categories: [],
      hasAttachments: composed.attachments.length > 0, preview: preview(composed.markdown), webLink: "", pending: "send",
    };
  }

  /** A reply's recipients and text: the sender (or everyone), plus any the agent adds. */
  async #reply(messageId: string, body: string, options?: ReplyOptions): Promise<{ origin: Origin; composed: Composed; conversation: ReplyContext }> {
    const ctx = this.ctx;
    const mailbox = await ctx.mailbox();
    const source = ctx.own(await ctx.guarded(messageId), mailbox);
    if (source.isDraft) throw new Error("That message is a draft; reply to a message that was sent or received.");
    // The reply the gadget gets back carries the source's subject and correspondents: a read of it.
    const [info] = await ctx.infos([source]);
    await ctx.observe("Read an Outlook message", `Read ${line(info!)}, to reply to it.`, [(await ctx.units()).message(source.id)]);
    const self = mailbox.address.toLowerCase();
    const replyAll = options?.replyAll === true;
    const fromAddress = source.replyTo.length ? source.replyTo : source.fromAddress ? [source.fromAddress] : [];
    // Replying to your own sent message goes to its recipients, as Outlook does.
    const to = fromAddress.every(address => address.address.toLowerCase() === self) ? source.to : fromAddress;
    const others = (list: GraphAddress[]) => list.filter(address => address.address.toLowerCase() !== self);
    const base = { to: others(replyAll ? [...to, ...source.to.filter(address => !to.some(t => t.address.toLowerCase() === address.address.toLowerCase()))] : to),
      cc: replyAll ? others(source.cc) : [], bcc: [] };
    const subject = /^re:/i.test(source.subject) ? source.subject : `RE: ${source.subject}`;
    const composed = await ctx.compose({ to: options?.to, cc: options?.cc, bcc: options?.bcc, subject: subject.slice(0, MAX_SUBJECT_CHARS), body, attachments: options?.attachments }, base);
    const participants = new Set([source.fromAddress, ...source.to, ...source.cc, ...source.replyTo].flatMap(address => address ? [address.address.toLowerCase()] : []));
    // A Reply-To that isn't the sender sends the reply somewhere the From line doesn't say.
    const sender = source.fromAddress?.address.toLowerCase();
    const replyToOf = new Map(source.replyTo.flatMap(address => {
      const at = address.address.toLowerCase();
      return sender !== undefined && at !== sender ? [[at, source.fromAddress!.address] as const] : [];
    }));
    const origin: Origin = { kind: replyAll ? "replyAll" : "reply", source: await ctx.target(source) };
    return { origin, composed, conversation: { participants, replyToOf } };
  }

  async #forward(messageId: string, to: Recipient[], body: string | undefined, options?: ForwardOptions): Promise<{ origin: Origin; composed: Composed }> {
    const ctx = this.ctx;
    const source = await ctx.guarded(messageId);
    if (source.isDraft) throw new Error("That message is a draft; forward a message that was sent or received.");
    if (to.length === 0) throw new Error("Pass at least one recipient to forward to.");
    const subject = /^fw:/i.test(source.subject) ? source.subject : `FW: ${source.subject}`;
    const composed = await ctx.compose({ to, cc: options?.cc, bcc: options?.bcc, subject: subject.slice(0, MAX_SUBJECT_CHARS), body: body ?? "", attachments: options?.attachments });
    // Outlook forwards the source's text and attachments whole; the approver sees what goes.
    const [sourceBody, attachments, [info]] = await Promise.all([
      ctx.mail(mail => mail.body(source.id)),
      source.hasAttachments ? ctx.mail(mail => mail.attachments(source.id)) : Promise.resolve([]),
      ctx.infos([source]),
    ]);
    const converted = mailToMarkdown(sourceBody, { maxChars: MAX_FORWARDED_CHARS });
    await ctx.observe("Read an Outlook message", `Read ${line(info!)}, to forward it.`, [(await ctx.units()).message(source.id)]);
    const forwarded: Forwarded = { markdown: converted.markdown, truncated: converted.truncated, attachments: attachedFiles(attachments) };
    return { origin: { kind: "forward", source: await ctx.target(source), forwarded }, composed };
  }

  async #automaticReplies(): Promise<AutomaticRepliesSetting & { internalHtml: string; externalHtml: string }> {
    const ctx = this.ctx;
    if (isNarrowed(ctx.scope)) throw new Error("Automatic replies belong to the whole mailbox, which this connection doesn't cover.");
    const body = await ctx.mail(mail => mail.get<{ automaticRepliesSetting?: Record<string, unknown> }>("/mailboxSettings", { $select: "automaticRepliesSetting" }));
    const setting = body.automaticRepliesSetting ?? {};
    const status = setting.status === "alwaysEnabled" || setting.status === "scheduled" ? setting.status : "disabled";
    const externalAudience = setting.externalAudience === "contactsOnly" || setting.externalAudience === "all" ? setting.externalAudience : "none";
    const internalHtml = typeof setting.internalReplyMessage === "string" ? setting.internalReplyMessage : "";
    const externalHtml = typeof setting.externalReplyMessage === "string" ? setting.externalReplyMessage : "";
    // A schedule set in Outlook is a wall time in a Windows zone; one this binding set is UTC.
    const when = (value: unknown) => {
      const ms = graphInstant(value);
      return ms === undefined ? undefined : new Date(ms).toISOString();
    };
    const start = when(setting.scheduledStartDateTime);
    const end = when(setting.scheduledEndDateTime);
    return {
      status, externalAudience, internalHtml, externalHtml,
      internalReply: mailToMarkdown({ contentType: "html", content: internalHtml }, { maxChars: 8_000 }).markdown,
      externalReply: mailToMarkdown({ contentType: "html", content: externalHtml }, { maxChars: 8_000 }).markdown,
      ...(start ? { start } : {}), ...(end ? { end } : {}),
    };
  }
}

function format(address: GraphAddress): string {
  return address.name ? `"${address.name.replace(/["\\]/g, "")}" <${address.address}>` : address.address;
}

/** Attachments a message already has, as an action shows them. */
function attachedFiles(attachments: readonly GraphAttachment[]): AttachedFile[] {
  return attachments.map(({ name, contentType, size }) => ({ name, contentType, size }));
}
