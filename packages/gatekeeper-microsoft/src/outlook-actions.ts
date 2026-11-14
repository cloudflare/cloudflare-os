// Every change an Outlook binding can make, as the kit's action set: what each action stores, how the
// approver sees it, and how it is applied and reverted. Sessions stage actions; nothing here runs
// before the user approves.
//
// Sends are idempotent without `claimBeforeApply`: each send fixes its own Internet Message-ID at
// submit, and apply looks for that ID across the mailbox before creating anything. A sent copy means
// it was sent; a draft means it was created and not yet sent. Exchange keeps a Message-ID set at
// creation through sending (verified live), so a replay after a crash finishes or finds the send and
// never repeats it.

import { ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionDefinition, type ActionPresentation, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { exchangeRefusal, isProvisional, realId } from "./binding";
import { GraphApiError, isOutcomeUnknown, type GraphApi } from "./graph-api";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";
import { MailApi, idPath, type GraphAddress } from "./outlook-graph";
import { odataString } from "./outlook-query";
import type { OutlookAccessLevel, OutlookMailboxRef } from "./outlook-scope";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.outlook.actions", vendorId: VENDOR_ID });

/** A message an action changes, as it was read when the action was proposed: for the approver and for revert. */
export type MessageTarget = {
  id: string;
  subject: string;
  from?: string;
  /** Its folder when proposed: where a revert moves it back to. */
  folderId: string;
  folder: string;
  receivedAt: string;
  conversationId?: string;
};

/** A folder an action names: a real one, or one an earlier pending action creates (`~N`). */
export type FolderTarget = { id: string; name: string; path: string };

/** An attachment an action adds, captured at submit. */
export type AttachmentUpload = { name: string; contentType: string; size: number; sha256: string; file: ActionFileReference };

/** A message as an action writes it. `html` is what Outlook gets; `markdown` is what the approver reads. */
export type Composed = {
  to: GraphAddress[];
  cc: GraphAddress[];
  bcc: GraphAddress[];
  subject: string;
  markdown: string;
  html: string;
  importance: "low" | "normal" | "high";
  attachments: AttachmentUpload[];
};

/** What a send or draft builds on: a new message, or a reply or forward of one the binding covers. */
export type Origin =
  | { kind: "new" }
  | { kind: "reply" | "replyAll"; source: MessageTarget }
  | { kind: "forward"; source: MessageTarget; forwarded: Forwarded };

/** What a forward carries along unchanged, for the approver: the source's text (bounded) and attachments. */
export type Forwarded = { markdown: string; truncated: boolean; attachments: AttachedFile[] };

/** An attachment a message already has, as the approver sees it. */
export type AttachedFile = { name: string; contentType: string; size: number };

/** A recipient as the approver sees it, with what to weigh before sending to them. */
export type RecipientNote = {
  address: string;
  name?: string;
  field: "to" | "cc" | "bcc";
  /** "outside your organization", "you've never written to them", "not in this conversation". */
  notes: string[];
};

/** A flag to set; `dueAt` (ISO 8601) only with "flagged". */
export type FlagChange = { status: "notFlagged" | "flagged" | "complete"; dueAt?: string };

/** A message's state before an update, which a revert restores. */
export type MessageState = { isRead: boolean; flag: FlagChange; categories: string[] };

/** The automatic replies setting, its replies as Markdown. */
export type AutomaticRepliesSetting = {
  status: "disabled" | "alwaysEnabled" | "scheduled";
  start?: string;
  end?: string;
  internalReply: string;
  externalReply: string;
  externalAudience: "none" | "contactsOnly" | "all";
};

/** What each kind of action stores. */
export type OutlookActions = {
  moveMessages: {
    mailbox: OutlookMailboxRef;
    messages: MessageTarget[];
    to: FolderTarget;
    /** How the change is put to the approver. */
    as: "move" | "archive" | "delete";
    /** The folder Exchange said the messages landed in, where an undo expects to still find them. */
    movedTo?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  updateMessages: {
    mailbox: OutlookMailboxRef;
    messages: (MessageTarget & { before: MessageState })[];
    change: { isRead?: boolean; flag?: FlagChange; addCategories?: string[]; removeCategories?: string[] };
    submittedAt: number;
    appliedAt?: number;
  };
  createFolder: {
    mailbox: OutlookMailboxRef;
    ref: string;
    /** The parent, or the top of the mailbox (`msgfolderroot`). */
    parent: FolderTarget;
    name: string;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  createDraft: {
    mailbox: OutlookMailboxRef;
    ref: string;
    origin: Origin;
    message: Composed;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  updateDraft: {
    mailbox: OutlookMailboxRef;
    /** A real draft ID, or the `~N` of one a pending action creates. */
    draftId: string;
    subject: string;
    message: Composed;
    before: Omit<Composed, "attachments">;
    removeAttachments: { id: string; name: string }[];
    /** The draft's change key when proposed; the update is refused if the user edited it since. */
    changeKey?: string;
    /**
     * The draft is a reply or forward not yet created when this was proposed, so `message.html` is
     * its own part alone: it replaces that part above the quoted original Outlook writes at creation.
     */
    keepsQuote?: true;
    submittedAt: number;
    addedAttachmentIds?: string[];
    /** The change key the update left, which its revert is fenced on. */
    appliedChangeKey?: string;
    appliedAt?: number;
  };
  deleteDraft: { mailbox: OutlookMailboxRef; draftId: string; subject: string; submittedAt: number; appliedAt?: number };
  send: {
    mailbox: OutlookMailboxRef;
    /** The Internet Message-ID fixed for the message at submit, which makes the send idempotent. */
    internetMessageId: string;
    /**
     * An existing draft to send, or none for a message composed here. A real draft is fenced on the
     * change key it had when proposed; a `~N` draft (`created`) on the change key its creation left,
     * so either way what is sent is what the approver saw.
     */
    draft?: { id: string; changeKey: string } | { id: string; created: true };
    origin: Origin;
    message: Composed;
    recipients: RecipientNote[];
    /** Attachments a draft being sent already has, for the approver. */
    attached?: AttachedFile[];
    submittedAt: number;
    sentId?: string;
    appliedAt?: number;
  };
  setAutomaticReplies: {
    mailbox: OutlookMailboxRef;
    replies: AutomaticRepliesSetting & { internalHtml: string; externalHtml: string };
    before: AutomaticRepliesSetting & { internalHtml: string; externalHtml: string };
    submittedAt: number;
    appliedAt?: number;
  };
};

/** One journaled Outlook action. */
export type OutlookAction = TaggedAction<OutlookActions>;

/** The change key a draft had after this binding last wrote it, and whether that write was an edit. */
export type DraftVersion = { changeKey: string; at: number; byEdit?: true };

/** What apply handlers may do. */
export type OutlookActionHost = {
  refs: ProvisionalIds<string>;
  graph<T>(op: (api: GraphApi) => Promise<T>, options?: { replayable?: boolean }): Promise<T>;
  readFile(file: ActionFileReference): Promise<Uint8Array>;
  releaseFile(file: ActionFileReference): void;
  invalidate(): Promise<void>;
  /** Notes a draft this binding created, which it then covers whatever its narrowing. */
  rememberDraft(id: string): void;
  /** Records the change key a draft has after this binding wrote it, or reads it back. */
  noteDraftVersion(id: string, version: DraftVersion): void;
  draftVersion(id: string): DraftVersion | undefined;
  /**
   * Proves what an action, or its undo, is about to write is still the binding's, as Exchange holds
   * it now, as its proposal proved it then: `messages` by ID (one since deleted is left to the
   * handler), and `folder` a destination or parent written into. Throws `ActionApplyError` for
   * anything that isn't.
   */
  inScope(check: { messages?: readonly string[]; folder?: string }): Promise<void>;
};

/** The access an action needs to apply, as its proposal needed: checked again at apply, since access may have been lowered since. */
export function requiredAccess(action: OutlookAction): OutlookAccessLevel {
  return action.kind === "send" || action.kind === "setAutomaticReplies" ? "send" : "draft";
}

/** The most messages one organize action changes. */
export const MAX_BATCH = 50;

// -- describing ---------------------------------------------------------------------------------

type Builder = ReturnType<typeof buildDescription>;

/** "Ada Lovelace — Quarterly numbers (Oct 17)", the way the approver recognizes a message. */
function messageLine(message: MessageTarget): string {
  const date = message.receivedAt ? ` (${message.receivedAt.slice(0, 10)})` : "";
  return `${message.from ?? "unknown sender"} — ${message.subject || "(no subject)"}${date}`;
}

function addressLine(address: GraphAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function mailboxNote(mailbox: OutlookMailboxRef): string {
  return mailbox.kind === "shared" ? ` in the shared mailbox ${codeSpan(mailbox.address)}` : "";
}

// Description prose is Markdown the approver reads in the gatekeeper's own voice, and subjects,
// sender names and folder names are written by whoever sent the mail or by the agent. So in prose
// they go through `plainInline`, which can't forge emphasis, links or structure; fields take them
// verbatim.

/** Untrusted text in description prose. `<` goes too, so it can't open raw HTML where that renders. */
function prose(text: string): string {
  return plainInline(text.replace(/</g, ""));
}

/** A name or subject in description prose, quoted. */
function named(text: string): string {
  return `"${prose(text || "(no subject)")}"`;
}

/** A message in description prose: its sender and subject, defused. */
function messageProse(message: MessageTarget): string {
  return `${prose(message.from ?? "unknown sender")}'s message ${named(message.subject)}`;
}

function addMessages(builder: Builder, label: string, messages: readonly MessageTarget[]): void {
  builder.list(label, messages.map(messageLine));
}

function addComposed(builder: Builder, message: Composed, recipients?: readonly RecipientNote[]): void {
  const noted = (field: "to" | "cc" | "bcc", list: readonly GraphAddress[]) => list.map(address => {
    const notes = recipients?.find(note => note.field === field && note.address.toLowerCase() === address.address.toLowerCase())?.notes ?? [];
    return notes.length ? `${addressLine(address)} — ${notes.join("; ")}` : addressLine(address);
  });
  if (message.to.length) builder.list("To", noted("to", message.to));
  if (message.cc.length) builder.list("Cc", noted("cc", message.cc));
  if (message.bcc.length) builder.list("Bcc", noted("bcc", message.bcc));
  builder.inline("Subject", message.subject || "(no subject)");
  if (message.importance !== "normal") builder.inline("Importance", message.importance);
  builder.verbatim("Message", message.markdown, "markdown");
  for (const attachment of message.attachments) {
    builder.file("Attachment", { name: attachment.name, mediaType: attachment.contentType, size: attachment.size, sha256: attachment.sha256, origin: "agent" });
  }
}

/** Attachments the message already carries: the draft's, or for a forward the source's. */
function addAttached(builder: Builder, label: string, attached: readonly AttachedFile[]): void {
  for (const attachment of attached) builder.file(label, { name: attachment.name, mediaType: attachment.contentType, size: attachment.size, origin: "provider" });
}

/** What a forward sends along besides the agent's text, which the approver should read too. */
function addOrigin(builder: Builder, origin: Origin): void {
  if (origin.kind !== "forward") return;
  builder.verbatim(origin.forwarded.truncated ? "Forwarded message (beginning)" : "Forwarded message", origin.forwarded.markdown, "markdown");
  addAttached(builder, "Forwarded attachment", origin.forwarded.attachments);
}

function originNote(origin: Origin): string {
  switch (origin.kind) {
    case "new": return "";
    case "reply": return ` It replies to ${messageProse(origin.source)}.`;
    case "replyAll": return ` It replies to everyone on ${messageProse(origin.source)}.`;
    case "forward": return ` It forwards ${messageProse(origin.source)}, shown below with its attachments.`;
  }
}

function flagWords(flag: FlagChange): string {
  if (flag.status === "notFlagged") return "Clear the flag on";
  if (flag.status === "complete") return "Mark complete";
  return flag.dueAt ? `Flag for follow-up by ${flag.dueAt.slice(0, 10)}` : "Flag for follow-up";
}

// -- applying -----------------------------------------------------------------------------------

/** A reply's or forward's `body` HTML with its own part replaced by `ownHtml`, keeping the quoted original. */
export function replaceOwnPart(currentHtml: string, ownHtml: string): string {
  // Outlook puts the quoted original after a rule, then `divRplyFwdMsg` (or `appendonsend` while
  // the original is still attached on send). Everything from that rule on is kept.
  const marker = currentHtml.search(/<div[^>]*id="?(?:divRplyFwdMsg|appendonsend)"?/i);
  if (marker === -1) return ownHtml;
  const before = currentHtml.slice(0, marker);
  const rule = before.lastIndexOf("<hr");
  const quoteStart = rule !== -1 && marker - rule < 400 ? rule : marker;
  // The document's own head and <body> stay too: Outlook keeps its styles there.
  const body = /<body[^>]*>/i.exec(before);
  const head = body ? before.slice(0, body.index + body[0].length) : "";
  return `${head}${ownHtml}${currentHtml.slice(quoteStart)}`;
}

function mail(api: GraphApi, mailbox: OutlookMailboxRef): MailApi {
  return new MailApi(api, mailbox);
}

function recipientsJson(list: readonly GraphAddress[]): { emailAddress: { address: string; name?: string } }[] {
  return list.map(({ address, name }) => ({ emailAddress: { address, ...(name ? { name } : {}) } }));
}

/** Uploads attachments to a draft (each at most 3 MB, which Graph takes inline). */
async function attach(api: MailApi, host: OutlookActionHost, draftId: string, attachments: readonly AttachmentUpload[]): Promise<string[]> {
  const ids: string[] = [];
  for (const attachment of attachments) {
    const bytes = await host.readFile(attachment.file);
    const created = await api.request<{ id?: unknown }>("POST", `/messages/${idPath(draftId)}/attachments`, {
      "@odata.type": "#microsoft.graph.fileAttachment", name: attachment.name, contentType: attachment.contentType,
      contentBytes: base64(bytes),
    });
    if (typeof created?.id === "string") ids.push(created.id);
  }
  return ids;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/**
 * The message carrying a send's Message-ID, anywhere in the mailbox: a draft not yet sent, a message
 * in Outbox that Exchange is sending, or the copy in Sent Items. Searching only Drafts and Sent Items
 * would miss the moments in Outbox between them, and a replay then would send twice.
 */
async function findByMessageId(api: MailApi, internetMessageId: string): Promise<{ id: string; isDraft: boolean; changeKey?: string } | undefined> {
  type Row = { id?: unknown; isDraft?: unknown; parentFolderId?: unknown; changeKey?: unknown };
  const [page, bin] = await Promise.all([
    api.get<{ value?: Row[] }>("/messages", {
      $filter: `internetMessageId eq ${odataString(internetMessageId)}`, $select: "id,isDraft,parentFolderId,changeKey", $top: 10,
    }),
    api.get<{ id?: unknown }>("/mailFolders/deleteditems", { $select: "id" }),
  ]);
  const found = (page.value ?? []).filter((row): row is Row & { id: string } => typeof row.id === "string");
  // A sent copy wins over a draft, wherever it is: it means the send happened. A draft in Deleted
  // Items is a leftover an earlier attempt discarded.
  const first = found.find(row => row.isDraft === false) ?? found.find(row => row.parentFolderId !== bin.id);
  if (first === undefined) return undefined;
  return { id: first.id, isDraft: first.isDraft !== false, ...(typeof first.changeKey === "string" ? { changeKey: first.changeKey } : {}) };
}

/** How long a refused submit waits for an earlier one to show as sent (verified live: under a second). */
const SUBMITTED_POLLS = 6;
const SUBMITTED_POLL_MS = 500;

type Sleep = (ms: number) => Promise<void>;
const pause: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Whether a message that still reads as a draft leaves Drafts within the polls: a submit was accepted for it. */
async function leavesDrafts(api: MailApi, id: string, sleep: Sleep): Promise<boolean> {
  for (let poll = 0; poll < SUBMITTED_POLLS; poll++) {
    await sleep(SUBMITTED_POLL_MS);
    const current = await api.find<{ isDraft?: unknown }>(`/messages/${idPath(id)}`, { $select: "isDraft" });
    if (current?.isDraft === false) return true;
  }
  return false;
}

/**
 * Submits a draft. For a moment after a submit is accepted, the message still reads as a draft in
 * Drafts, and Exchange refuses a second submit with 403 `ErrorAccessDenied` ("Cannot submit
 * message"), verified live. A replay that lands in that moment is told so; it then waits for the
 * message to read as sent, rather than reporting a send that happened as a failure.
 */
export async function submit(api: MailApi, draftId: string, sleep: Sleep = pause): Promise<void> {
  try {
    await api.request("POST", `/messages/${idPath(draftId)}/send`);
  } catch (error) {
    if (!(error instanceof GraphApiError && error.status === 403) || !(await leavesDrafts(api, draftId, sleep))) throw error;
  }
}

/**
 * Records a draft's change key after this binding wrote it, for a send of it to be fenced on. The
 * write it follows has landed, so a failed read can't fail the action: a retry would write again
 * (a second draft, or an edit the first left a key that no longer matches). The version goes
 * unrecorded instead, and a send of the draft is refused until the agent reads it again.
 */
async function noteVersion(host: OutlookActionHost, mailbox: OutlookMailboxRef, id: string, byEdit?: true): Promise<string | undefined> {
  let current: { changeKey?: unknown };
  try {
    current = await host.graph(api => mail(api, mailbox).get<{ changeKey?: unknown }>(`/messages/${idPath(id)}`, { $select: "changeKey" }), { replayable: true });
  } catch (error) {
    logger.warn("couldn't read the version a draft write left", { event: "outlook.draft.version.unread", error });
    return undefined;
  }
  if (typeof current.changeKey !== "string") return undefined;
  host.noteDraftVersion(id, { changeKey: current.changeKey, at: Date.now(), ...(byEdit ? { byEdit } : {}) });
  return current.changeKey;
}

/**
 * Proves the message a reply or forward is built from is still the binding's: Outlook copies its
 * text and attachments into the new draft, so one that has left the binding since the proposal
 * can't be cloned.
 */
async function requireSourceCovered(host: OutlookActionHost, origin: Origin): Promise<void> {
  if (origin.kind !== "new") await host.inScope({ messages: [origin.source.id] });
}

/** Creates the draft for a send or draft action: a new message, or Outlook's own reply or forward of the source. */
async function createComposed(api: MailApi, host: OutlookActionHost, origin: Origin, message: Composed, internetMessageId?: string): Promise<string> {
  const identity = internetMessageId ? { internetMessageId } : {};
  let draftId: string;
  if (origin.kind === "new") {
    const created = await api.request<{ id?: unknown }>("POST", "/messages", {
      ...identity, subject: message.subject, importance: message.importance,
      body: { contentType: "HTML", content: message.html },
      toRecipients: recipientsJson(message.to), ccRecipients: recipientsJson(message.cc), bccRecipients: recipientsJson(message.bcc),
    });
    if (typeof created?.id !== "string") throw new GraphApiError(502, "Outlook didn't say which draft it created.");
    draftId = created.id;
  } else {
    // Outlook writes the reply or forward itself: threading headers, the quoted original, and, for a
    // forward, the original's attachments. The agent's text goes above the quote as its `comment`.
    const action = origin.kind === "reply" ? "createReply" : origin.kind === "replyAll" ? "createReplyAll" : "createForward";
    const created = await api.request<{ id?: unknown }>("POST", `/messages/${idPath(origin.source.id)}/${action}`, {
      message: { ...identity, ...(origin.kind === "forward" ? { toRecipients: recipientsJson(message.to) } : {}) },
      comment: message.html,
    });
    if (typeof created?.id !== "string") throw new GraphApiError(502, "Outlook didn't say which draft it created.");
    draftId = created.id;
    // The recipients the session computed (the reply's own plus any added) and the importance.
    await api.request("PATCH", `/messages/${idPath(draftId)}`, {
      toRecipients: recipientsJson(message.to), ccRecipients: recipientsJson(message.cc), bccRecipients: recipientsJson(message.bcc),
      importance: message.importance,
    });
  }
  await attach(api, host, draftId, message.attachments);
  return draftId;
}

/** A message's categories with some added and some removed, matched regardless of case, as Outlook does. */
function categoriesAfter(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const categories = new Map(current.map(name => [name.toLowerCase(), name]));
  for (const name of add) categories.set(name.toLowerCase(), name);
  for (const name of remove) categories.delete(name.toLowerCase());
  return [...categories.values()];
}

/**
 * The messages' categories as Exchange holds them now, when a change touches categories: it is
 * merged into them, so a category given or taken in Outlook meanwhile stays as it is. A message
 * since deleted is absent.
 */
async function currentCategories(api: MailApi, messages: readonly { id: string }[], change: { addCategories?: readonly string[]; removeCategories?: readonly string[] }): Promise<Map<string, readonly string[]>> {
  if (!change.addCategories?.length && !change.removeCategories?.length) return new Map();
  const current = await api.messages(messages.map(message => message.id));
  return new Map([...current].map(([id, message]) => [id, message.categories]));
}

async function setState(api: MailApi, id: string, state: Partial<MessageState>): Promise<void> {
  await api.request("PATCH", `/messages/${idPath(id)}`, {
    ...(state.isRead !== undefined ? { isRead: state.isRead } : {}),
    ...(state.categories !== undefined ? { categories: state.categories } : {}),
    ...(state.flag !== undefined ? { flag: flagJson(state.flag) } : {}),
  });
}

function flagJson(flag: FlagChange): Record<string, unknown> {
  if (flag.status !== "flagged" || flag.dueAt === undefined) return { flagStatus: flag.status };
  const due = new Date(flag.dueAt);
  const start = new Date(Math.min(Date.now(), due.getTime()));
  return {
    flagStatus: "flagged",
    startDateTime: { dateTime: start.toISOString().replace(/Z$/, ""), timeZone: "UTC" },
    dueDateTime: { dateTime: due.toISOString().replace(/Z$/, ""), timeZone: "UTC" },
  };
}

function repliesJson(replies: OutlookActions["setAutomaticReplies"]["replies"]): Record<string, unknown> {
  return {
    automaticRepliesSetting: {
      status: replies.status,
      externalAudience: replies.externalAudience,
      internalReplyMessage: replies.internalHtml,
      externalReplyMessage: replies.externalHtml,
      ...(replies.status === "scheduled" && replies.start && replies.end ? {
        scheduledStartDateTime: { dateTime: replies.start.replace(/Z$/, ""), timeZone: "UTC" },
        scheduledEndDateTime: { dateTime: replies.end.replace(/Z$/, ""), timeZone: "UTC" },
      } : {}),
    },
  };
}

// -- the action set -----------------------------------------------------------------------------

const ORGANIZE = { tag: "outlook.organize", label: "Organize Outlook mail" } as const;

/** Each kind's definition, by itself for tests; `actions` is the set the facet binds. */
export const definitions = {
  moveMessages: {
    kind: ORGANIZE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const count = payload.messages.length;
      const what = `${count} message${count === 1 ? "" : "s"}`;
      const sentence = payload.as === "delete"
        ? `Move ${what} to Deleted Items${mailboxNote(payload.mailbox)}, from where they can be restored.`
        : payload.as === "archive" ? `Archive ${what}${mailboxNote(payload.mailbox)}.`
        : `Move ${what} to ${named(payload.to.path || payload.to.name)}${mailboxNote(payload.mailbox)}.`;
      const builder = buildDescription(sentence);
      addMessages(builder, "Messages", payload.messages);
      const verb = payload.as === "delete" ? "Delete" : payload.as === "archive" ? "Archive" : "Move";
      return {
        title: sanitizeTitle(count === 1 ? `${verb} "${payload.messages[0]!.subject || "(no subject)"}"` : `${verb} ${what}`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.to.id) ? [payload.to.id] : [],
    apply: async (payload, host) => {
      const to = realId(host.refs, payload.to.id, "The folder");
      // A message keeps its ID wherever it is moved, so it is proved still covered now, as is a
      // chosen destination; Deleted Items and Archive are Outlook's own.
      await host.inScope({ messages: payload.messages.map(message => message.id), ...(payload.as === "move" ? { folder: to } : {}) });
      const movedTo = await host.graph(async api => {
        const box = mail(api, payload.mailbox);
        let landed: string | undefined;
        for (const message of payload.messages) {
          try {
            // A move keeps the immutable ID, so a replay finds the message already there and moves it again harmlessly.
            const moved = await box.request<{ parentFolderId?: unknown }>("POST", `/messages/${idPath(message.id)}/move`, { destinationId: to });
            if (typeof moved?.parentFolderId === "string") landed ??= moved.parentFolderId;
          } catch (error) {
            if (error instanceof GraphApiError && error.status === 404) continue;
            exchangeRefusal(error, `"${message.subject}"`);
          }
        }
        return landed;
      }, { replayable: true });
      await host.invalidate();
      return { action: { ...payload, ...(movedTo ? { movedTo } : {}), appliedAt: Date.now() } };
    },
  },

  updateMessages: {
    kind: ORGANIZE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const count = payload.messages.length;
      const what = `${count} message${count === 1 ? "" : "s"}`;
      const { change } = payload;
      const parts: string[] = [];
      if (change.isRead !== undefined) parts.push(change.isRead ? "Mark as read" : "Mark as unread");
      if (change.flag) parts.push(flagWords(change.flag));
      if (change.addCategories?.length) parts.push(`Categorize as ${change.addCategories.map(named).join(", ")}`);
      if (change.removeCategories?.length) parts.push(`Remove the categor${change.removeCategories.length === 1 ? "y" : "ies"} ${change.removeCategories.map(named).join(", ")}`);
      const builder = buildDescription(`${parts.join("; ")}: ${what}${mailboxNote(payload.mailbox)}.`);
      addMessages(builder, "Messages", payload.messages);
      return {
        title: sanitizeTitle(`${parts[0] ?? "Update"}: ${count === 1 ? `"${payload.messages[0]!.subject || "(no subject)"}"` : what}`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      await host.inScope({ messages: payload.messages.map(message => message.id) });
      await host.graph(async api => {
        const box = mail(api, payload.mailbox);
        const { addCategories = [], removeCategories = [] } = payload.change;
        const current = await currentCategories(box, payload.messages, payload.change);
        for (const message of payload.messages) {
          const now = current.get(message.id);
          if ((addCategories.length || removeCategories.length) && now === undefined) continue;
          try {
            await setState(box, message.id, {
              ...(payload.change.isRead !== undefined ? { isRead: payload.change.isRead } : {}),
              ...(payload.change.flag ? { flag: payload.change.flag } : {}),
              ...(now !== undefined ? { categories: categoriesAfter(now, addCategories, removeCategories) } : {}),
            });
          } catch (error) {
            if (error instanceof GraphApiError && error.status === 404) continue;
            exchangeRefusal(error, `"${message.subject}"`);
          }
        }
      }, { replayable: true });
      await host.invalidate();
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  createFolder: {
    kind: ORGANIZE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Exchange refuses a duplicate name, so a replay would fail as a conflict: claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Create a folder named ${named(payload.name)} in ${named(payload.parent.path || payload.parent.name)}${mailboxNote(payload.mailbox)}.`);
      builder.inline("Name", payload.name);
      builder.inline("In", payload.parent.path || payload.parent.name);
      return { title: sanitizeTitle(`Create the Outlook folder "${payload.name}"`), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = realId(host.refs, payload.parent.id, "The parent folder");
      if (parent !== "msgfolderroot") await host.inScope({ folder: parent });
      let id: string;
      try {
        const created = await host.graph(api => mail(api, payload.mailbox).request<{ id?: unknown }>("POST",
          parent === "msgfolderroot" ? "/mailFolders" : `/mailFolders/${idPath(parent)}/childFolders`, { displayName: payload.name }));
        if (typeof created?.id !== "string") throw new GraphApiError(502, "Outlook didn't say which folder it created.");
        id = created.id;
      } catch (error) {
        exchangeRefusal(error, "The folder");
      }
      host.refs.bind(payload.ref, id);
      await host.invalidate();
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
  },

  createDraft: {
    kind: { tag: "outlook.drafts", label: "Write Outlook drafts" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Save a draft in Drafts${mailboxNote(payload.mailbox)}, where you can finish and send it yourself. ` +
        `Nothing is sent.${originNote(payload.origin)}`);
      addComposed(builder, payload.message);
      addOrigin(builder, payload.origin);
      return { title: sanitizeTitle(`Draft "${payload.message.subject || "(no subject)"}"`), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    apply: async (payload, host) => {
      await requireSourceCovered(host, payload.origin);
      let id: string;
      try {
        id = await host.graph(api => createComposed(mail(api, payload.mailbox), host, payload.origin, payload.message));
      } catch (error) {
        // Nothing identifies the draft for a retry to find, so one that may have been made isn't made again.
        if (isOutcomeUnknown(error)) throw new ActionOutcomeUnknownError("Outlook may have created the draft before the connection dropped. Check Drafts before trying again.");
        exchangeRefusal(error, payload.origin.kind === "new" ? "The draft" : "The message this replies to");
      }
      host.refs.bind(payload.ref, id);
      host.rememberDraft(id);
      await noteVersion(host, payload.mailbox, id);
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
      await host.invalidate();
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
    reject: async (payload, host) => {
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
    },
  },

  updateDraft: {
    kind: { tag: "outlook.drafts", label: "Write Outlook drafts" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Change the draft ${named(payload.subject)}${mailboxNote(payload.mailbox)}. Nothing is sent.` +
        (payload.changeKey ? " This applies only if the draft hasn't been edited since." : ""));
      addComposed(builder, payload.message);
      if (payload.removeAttachments.length) builder.list("Remove attachments", payload.removeAttachments.map(attachment => attachment.name));
      if (payload.before.markdown !== payload.message.markdown) builder.verbatim("Message before", payload.before.markdown, "markdown");
      return { title: sanitizeTitle(`Edit the draft "${payload.subject || "(no subject)"}"`), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.draftId) ? [payload.draftId] : [],
    apply: async (payload, host) => {
      const id = realId(host.refs, payload.draftId, "The draft");
      let added: string[] = [];
      let left: string | undefined;
      try {
        added = await host.graph(async api => {
          const box = mail(api, payload.mailbox);
          // Fenced on the key the approver's view was read at, or for a draft created by an earlier
          // action, the key this binding's last write left; a send of it would be fenced the same way.
          const current = await box.get<{ changeKey?: unknown; isDraft?: unknown; body?: { contentType?: unknown; content?: unknown } }>(`/messages/${idPath(id)}`,
            { $select: payload.keepsQuote ? "changeKey,isDraft,body" : "changeKey,isDraft" });
          if (current.isDraft === false) throw new ActionApplyError("The draft has been sent, so it wasn't changed.");
          const expected = payload.changeKey ?? host.draftVersion(id)?.changeKey;
          if (expected === undefined || current.changeKey !== expected) {
            throw new ActionApplyError("The draft changed after this was proposed, so it wasn't changed. Ask the agent to read it again.");
          }
          let html = payload.message.html;
          if (payload.keepsQuote) {
            if (typeof current.body?.content !== "string" || !/html/i.test(String(current.body.contentType))) throw new GraphApiError(502, "Outlook didn't return the draft's text.");
            html = replaceOwnPart(current.body.content, html);
          }
          await box.request("PATCH", `/messages/${idPath(id)}`, {
            subject: payload.message.subject, importance: payload.message.importance,
            body: { contentType: "HTML", content: html },
            toRecipients: recipientsJson(payload.message.to), ccRecipients: recipientsJson(payload.message.cc), bccRecipients: recipientsJson(payload.message.bcc),
          }, { ifMatch: expected });
          for (const attachment of payload.removeAttachments) {
            await box.request("DELETE", `/messages/${idPath(id)}/attachments/${idPath(attachment.id)}`, undefined, { allow: [404] });
          }
          return await attach(box, host, id, payload.message.attachments);
        });
        left = await noteVersion(host, payload.mailbox, id, true);
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        exchangeRefusal(error, "The draft");
      }
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
      await host.invalidate();
      return { action: { ...payload, addedAttachmentIds: added, ...(left !== undefined ? { appliedChangeKey: left } : {}), appliedAt: Date.now() } };
    },
    reject: async (payload, host) => {
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
    },
  },

  deleteDraft: {
    kind: { tag: "outlook.drafts", label: "Write Outlook drafts" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete the draft ${named(payload.subject)}${mailboxNote(payload.mailbox)}. It goes to Deleted Items, from where it can be restored.`);
      return { title: sanitizeTitle(`Delete the draft "${payload.subject || "(no subject)"}"`), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.draftId) ? [payload.draftId] : [],
    apply: async (payload, host) => {
      const id = realId(host.refs, payload.draftId, "The draft");
      try {
        await host.graph(async api => {
          const box = mail(api, payload.mailbox);
          // Sent from Outlook since, the message keeps its ID but is no longer the draft approved for deletion.
          const current = await box.find<{ isDraft?: unknown }>(`/messages/${idPath(id)}`, { $select: "isDraft" });
          if (current === null) return;
          if (current.isDraft === false) throw new ActionApplyError("The draft has been sent, so it wasn't deleted.");
          await box.request("POST", `/messages/${idPath(id)}/move`, { destinationId: "deleteditems" });
        }, { replayable: true });
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        if (!(error instanceof GraphApiError && error.status === 404)) exchangeRefusal(error, "The draft");
      }
      await host.invalidate();
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  send: {
    kind: { tag: "outlook.send", label: "Send Outlook mail" },
    // Never: what leaves the organization can't be called back, so a person always decides.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const flagged = payload.recipients.filter(recipient => recipient.notes.length > 0);
      const builder = buildDescription(`Send this message${payload.mailbox.kind === "shared" ? ` from the shared mailbox ${codeSpan(payload.mailbox.address)}` : ""}.` +
        `${originNote(payload.origin)} Once sent, it can't be called back.` +
        (flagged.length ? ` ${flagged.length} recipient${flagged.length === 1 ? " is" : "s are"} worth a second look; see the notes beside them.` : "") +
        (payload.draft ? " It is sent only if the draft is still exactly as shown here." : ""));
      addComposed(builder, payload.message, payload.recipients);
      if (payload.attached?.length) addAttached(builder, "Attachment", payload.attached);
      addOrigin(builder, payload.origin);
      return { title: sanitizeTitle(`Send "${payload.message.subject || "(no subject)"}"`), ...builder.finish(), implementsRevert: false } satisfies ActionPresentation;
    },
    dependsOn: payload => payload.draft && isProvisional(payload.draft.id) ? [payload.draft.id] : [],
    apply: async (payload, host) => {
      // A message composed here from a source is cloned from it on send; an existing draft was.
      if (payload.draft === undefined) await requireSourceCovered(host, payload.origin);
      let sentId: string;
      try {
        sentId = await host.graph(async api => {
          const box = mail(api, payload.mailbox);
          let draftId: string;
          if (payload.draft) {
            draftId = realId(host.refs, payload.draft.id, "The draft");
            // An existing draft keeps its own Message-ID, so a replay is recognized by the draft having
            // become a sent message (its immutable ID survives the send).
            const current = await box.get<{ changeKey?: unknown; isDraft?: unknown }>(`/messages/${idPath(draftId)}`, { $select: "changeKey,isDraft" });
            if (current.isDraft === false) return draftId;
            // Anything that touched the draft since what the approver saw (an edit in Outlook, a later
            // action of ours, even marking it read) changes its key, and then nothing is sent. An edit
            // of ours applied after this was proposed leaves a key we recorded, so it is refused by time.
            const version = "created" in payload.draft ? host.draftVersion(draftId) : { changeKey: payload.draft.changeKey, at: 0 };
            if (version === undefined || current.changeKey !== version.changeKey || (version.byEdit && version.at > payload.submittedAt)) {
              throw new ActionApplyError("The draft changed after this was proposed, so it wasn't sent. Ask the agent to read it again.");
            }
          } else {
            const existing = await findByMessageId(box, payload.internetMessageId);
            if (existing && !existing.isDraft) return existing.id;
            // A draft an earlier attempt left is sent only exactly as that attempt finished building it.
            // One cut short (missing an attachment, say) or touched since is discarded and built again.
            if (existing && existing.changeKey !== undefined && existing.changeKey === host.draftVersion(existing.id)?.changeKey) {
              draftId = existing.id;
            } else {
              // A leftover whose key changed may be one Exchange is sending: for a moment after a
              // submit it still reads as a draft, with a new key. Binning it then would send twice.
              if (existing && await leavesDrafts(box, existing.id, pause)) return existing.id;
              if (existing) await box.request("POST", `/messages/${idPath(existing.id)}/move`, { destinationId: "deleteditems" });
              draftId = await createComposed(box, host, payload.origin, payload.message, payload.internetMessageId);
              const built = await box.get<{ changeKey?: unknown }>(`/messages/${idPath(draftId)}`, { $select: "changeKey" });
              if (typeof built.changeKey === "string") host.noteDraftVersion(draftId, { changeKey: built.changeKey, at: Date.now() });
            }
          }
          await submit(box, draftId);
          return draftId;
        }, { replayable: true });
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        exchangeRefusal(error, payload.origin.kind === "new" ? "The message" : "The message this replies to");
      }
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
      await host.invalidate();
      return { action: { ...payload, sentId, appliedAt: Date.now() } };
    },
    reject: async (payload, host) => {
      for (const attachment of payload.message.attachments) host.releaseFile(attachment.file);
    },
  },

  setAutomaticReplies: {
    kind: { tag: "outlook.settings", label: "Change Outlook automatic replies" },
    // Never: an automatic reply answers everyone who writes, including people outside the organization.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const { replies } = payload;
      const when = replies.status === "disabled" ? "Turn off automatic replies."
        : replies.status === "alwaysEnabled" ? "Turn on automatic replies until they are turned off."
        : `Send automatic replies from ${replies.start} to ${replies.end}.`;
      const audience = replies.status === "disabled" ? "" : replies.externalAudience === "none" ? " Only colleagues get one."
        : replies.externalAudience === "contactsOnly" ? " People outside your organization get one only if they are your contacts."
        : " Everyone who writes gets one, including people outside your organization.";
      const builder = buildDescription(when + audience);
      if (replies.status !== "disabled") {
        builder.verbatim("Reply to colleagues", replies.internalReply, "markdown");
        if (replies.externalAudience !== "none") builder.verbatim("Reply to others", replies.externalReply, "markdown");
      }
      return { title: sanitizeTitle(replies.status === "disabled" ? "Turn off automatic replies" : "Set automatic replies"), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      try {
        await host.graph(api => mail(api, payload.mailbox).request("PATCH", "/mailboxSettings", repliesJson(payload.replies)), { replayable: true });
      } catch (error) {
        exchangeRefusal(error, "The automatic replies");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },
} satisfies { [K in keyof OutlookActions]: ActionDefinition<OutlookActions[K], OutlookActionHost> };

/** The action set the gatekeeper binds to its journal. */
export const actions = defineActions<OutlookActionHost, OutlookActions>(definitions, {
  // Every kind acts as one Microsoft 365 user, fenced on their stable (tenant, object) ID.
  fence: "authority",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  afterResolve: host => host.invalidate(),
  vendorId: VENDOR_ID,
});

// -- reverting ----------------------------------------------------------------------------------

/** What a revert reports when it couldn't fully undo an action; nothing when it did. */
export type RevertOutcome = void | { message?: string; canRetry?: boolean; restart?: boolean };

/** Re-proves what an undo is about to write is still the binding's; what has left it is left as it is. */
async function leftBinding(host: OutlookActionHost, check: Parameters<OutlookActionHost["inScope"]>[0]): Promise<{ message: string; canRetry: false } | undefined> {
  try {
    await host.inScope(check);
    return undefined;
  } catch (error) {
    if (!(error instanceof ActionApplyError)) throw error;
    return { message: error.message, canRetry: false };
  }
}

/**
 * Undoes an applied action. A message keeps its ID wherever it goes, so one an undo would write is
 * proved still covered, as applying did; drafts are the binding's own by construction.
 */
export async function revert(action: OutlookAction, host: OutlookActionHost): Promise<RevertOutcome> {
  switch (action.kind) {
    case "moveMessages": {
      const { payload } = action;
      // The move itself may have taken the messages out of the binding (a deletion or archive from
      // an Inbox-only one does), so what is undone is that move: each message is put back only if
      // it is still where the move left it. A move applied before that was recorded proves them covered.
      let messages = payload.messages;
      if (payload.movedTo === undefined) {
        const left = await leftBinding(host, { messages: messages.map(message => message.id) });
        if (left !== undefined) return left;
      } else {
        const landed = payload.movedTo;
        const still = await host.graph(async api => {
          const box = mail(api, payload.mailbox);
          const kept: typeof payload.messages = [];
          for (const message of payload.messages) {
            const current = await box.find<{ parentFolderId?: unknown }>(`/messages/${idPath(message.id)}`, { $select: "parentFolderId" });
            if (current === null) continue;
            if (current.parentFolderId !== landed) return `"${message.subject}" has been moved again since, so nothing was put back.`;
            kept.push(message);
          }
          return kept;
        }, { replayable: true });
        if (typeof still === "string") return { message: still, canRetry: false };
        messages = still;
      }
      // Back where each came from, which may have been a folder still to be created when this was
      // proposed; created by now, since the move into it applied before this one. Proved covered
      // now, as a chosen destination is when applying.
      const origin = (message: { folderId: string }) => host.refs.resolve(message.folderId);
      if (messages.some(message => isProvisional(origin(message)))) {
        return { message: "The folder a message came from was never created, so nothing was put back.", canRetry: false };
      }
      const origins = [...new Set(messages.map(origin))].map(folder => ({ folder }));
      for (const check of origins) {
        const left = await leftBinding(host, check);
        if (left !== undefined) return left;
      }
      await host.graph(async api => {
        const box = mail(api, payload.mailbox);
        for (const message of messages) {
          await box.request("POST", `/messages/${idPath(message.id)}/move`, { destinationId: origin(message) }).catch(error => {
            if (!(error instanceof GraphApiError && error.status === 404)) throw error;
          });
        }
      }, { replayable: true });
      return;
    }
    case "updateMessages": {
      const { payload } = action;
      const left = await leftBinding(host, { messages: payload.messages.map(message => message.id) });
      if (left !== undefined) return left;
      await host.graph(async api => {
        const box = mail(api, payload.mailbox);
        const current = await currentCategories(box, payload.messages, payload.change);
        for (const message of payload.messages) {
          // Given back: what the change took that the message had. Taken back: what it gave that the message lacked.
          const same = (name: string, other: string) => name.toLowerCase() === other.toLowerCase();
          const givenBack = message.before.categories.filter(before => (payload.change.removeCategories ?? []).some(name => same(name, before)));
          const takenBack = (payload.change.addCategories ?? []).filter(name => !message.before.categories.some(before => same(name, before)));
          const now = current.get(message.id);
          await setState(box, message.id, {
            ...(payload.change.isRead !== undefined ? { isRead: message.before.isRead } : {}),
            ...(payload.change.flag ? { flag: message.before.flag } : {}),
            ...(now !== undefined ? { categories: categoriesAfter(now, givenBack, takenBack) } : {}),
          }).catch(error => {
            if (!(error instanceof GraphApiError && error.status === 404)) throw error;
          });
        }
      }, { replayable: true });
      return;
    }
    case "createFolder": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "The folder was never created, so there is nothing to undo.", canRetry: false };
      const folder = await host.graph(api => mail(api, payload.mailbox).folder(payload.createdId!), { replayable: true });
      if (folder === null) return;
      const left = await leftBinding(host, { folder: payload.createdId });
      if (left !== undefined) return left;
      if (folder.totalCount > 0 || folder.childCount > 0) {
        return { message: `The folder "${payload.name}" isn't empty anymore, so it wasn't deleted. Move what's in it out first.`, canRetry: true };
      }
      await host.graph(api => mail(api, payload.mailbox).request("DELETE", `/mailFolders/${idPath(payload.createdId!)}`), { replayable: true })
        .catch(error => { if (!(error instanceof GraphApiError && error.status === 404)) throw error; });
      return;
    }
    case "createDraft": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "The draft was never created, so there is nothing to undo.", canRetry: false };
      const current = await host.graph(api => mail(api, payload.mailbox).find<{ isDraft?: unknown }>(`/messages/${idPath(payload.createdId!)}`, { $select: "isDraft" }), { replayable: true });
      if (current === null) return;
      if (current.isDraft === false) return { message: "The draft has been sent, so it can't be taken back.", canRetry: false };
      await host.graph(api => mail(api, payload.mailbox).request("POST", `/messages/${idPath(payload.createdId!)}/move`, { destinationId: "deleteditems" }), { replayable: true });
      return;
    }
    case "updateDraft": {
      const { payload } = action;
      const id = host.refs.resolve(payload.draftId);
      if (isProvisional(id)) return;
      // Fenced on the key the update left: a draft changed since (in Outlook, or sent) isn't rewound,
      // nor one whose key went unread after the edit, which may have been typed in since.
      if (payload.appliedChangeKey === undefined) {
        return { message: "Outlook didn't say which version this edit left, so it wasn't undone. Change the draft in Outlook if you need to.", canRetry: false };
      }
      const ifMatch = payload.appliedChangeKey;
      const restored = await host.graph(async api => {
        const box = mail(api, payload.mailbox);
        let html = payload.before.html;
        if (payload.keepsQuote) {
          // `before` is the draft's own part alone: it goes back above the quoted original the draft has now.
          const current = await box.find<{ body?: { content?: unknown } }>(`/messages/${idPath(id)}`, { $select: "body" });
          if (current === null) return true;
          if (typeof current.body?.content !== "string") throw new GraphApiError(502, "Outlook didn't return the draft's text.");
          html = replaceOwnPart(current.body.content, html);
        }
        const patched = await box.request("PATCH", `/messages/${idPath(id)}`, {
          subject: payload.before.subject, importance: payload.before.importance,
          body: { contentType: "HTML", content: html },
          toRecipients: recipientsJson(payload.before.to), ccRecipients: recipientsJson(payload.before.cc), bccRecipients: recipientsJson(payload.before.bcc),
        }, { ifMatch, allow: [404] }).then(() => true, error => {
          if (error instanceof GraphApiError && error.status === 412) return false;
          throw error;
        });
        if (!patched) return false;
        for (const attachmentId of payload.addedAttachmentIds ?? []) {
          await box.request("DELETE", `/messages/${idPath(id)}/attachments/${idPath(attachmentId)}`, undefined, { allow: [404] });
        }
        return true;
      }, { replayable: true });
      if (!restored) return { message: "The draft has been changed since, so its text wasn't restored.", canRetry: false };
      return payload.removeAttachments.length
        ? { message: `The draft's text and recipients are restored, but the attachments it removed (${payload.removeAttachments.map(attachment => attachment.name).join(", ")}) can't be put back.` }
        : undefined;
    }
    case "deleteDraft": {
      const { payload } = action;
      const id = host.refs.resolve(payload.draftId);
      if (isProvisional(id)) return;
      await host.graph(api => mail(api, payload.mailbox).request("POST", `/messages/${idPath(id)}/move`, { destinationId: "drafts" }), { replayable: true })
        .catch(error => {
          if (error instanceof GraphApiError && error.status === 404) return;
          throw error;
        });
      return;
    }
    case "send":
      return { message: "A sent message can't be called back.", canRetry: false };
    case "setAutomaticReplies": {
      const { payload } = action;
      await host.graph(api => mail(api, payload.mailbox).request("PATCH", "/mailboxSettings", repliesJson(payload.before)), { replayable: true });
      return;
    }
  }
}

/** An action's definition. `kind` and `payload` are correlated, which TypeScript can't follow across the union. */
function definitionOf(action: OutlookAction): ActionDefinition<OutlookAction["payload"], OutlookActionHost> {
  return definitions[action.kind] as ActionDefinition<OutlookAction["payload"], OutlookActionHost>;
}

/** The temporary IDs an action creates. */
export function providedRefs(action: OutlookAction): readonly string[] {
  return definitionOf(action).provides?.(action.payload) ?? [];
}

/** The temporary IDs an action builds on. */
export function dependedRefs(action: OutlookAction): readonly string[] {
  return definitionOf(action).dependsOn?.(action.payload) ?? [];
}

/** The captured files an action holds, so unreferenced ones can be swept. */
export function fileHandles(action: OutlookAction): string[] {
  switch (action.kind) {
    case "createDraft":
    case "updateDraft":
    case "send": return action.payload.message.attachments.map(attachment => attachment.file.handle);
    default: return [];
  }
}
