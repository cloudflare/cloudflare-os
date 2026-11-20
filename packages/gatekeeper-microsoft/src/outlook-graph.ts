// Microsoft Graph requests for one mailbox, and the parsers for their responses. Every request asks
// for immutable IDs (`Prefer: IdType="ImmutableId"`), since default IDs change whenever a message
// moves, and every response is parsed into checked shapes.

import { GraphApiError, MAX_BATCH_REQUESTS, refusesPath, type BatchRequest, type GraphApi, type RequestOptions } from "./graph-api";
import { optStr, parsePage, record, str, type GraphPage } from "./graph-parse";
import { visibleText } from "./outlook-content";
import type { GuardedMessage, OutlookMailboxRef } from "./outlook-scope";

/** The `Prefer` value every request to a mailbox carries: IDs that stay the same when an item moves. */
export const IMMUTABLE_IDS = 'IdType="ImmutableId"';

/** A Graph ID as Exchange issues it: URL-safe base64, never a path or query. */
const GRAPH_ID = /^[A-Za-z0-9+/=_-]{1,512}$/;

/** Whether `id` can be a Graph mail ID, before it goes in a path. */
export function isMailId(id: unknown): id is string {
  return typeof id === "string" && GRAPH_ID.test(id);
}

/** A mailbox's Graph path: `/me`, or `/users/{id}` for a shared mailbox. */
export function mailboxPath(mailbox: OutlookMailboxRef): string {
  return mailbox.kind === "me" ? "/me" : `/users/${encodeURIComponent(mailbox.id)}`;
}

/** An immutable ID as it goes in a path: checked, then encoded (base64 has `/` and `+`). */
export function idPath(id: string): string {
  if (!isMailId(id)) throw new GraphApiError(400, "That isn't an Outlook ID.");
  return encodeURIComponent(id);
}

/** The message fields every listing and read selects. */
export const MESSAGE_SELECT = [
  "id", "conversationId", "parentFolderId", "subject", "from", "sender", "toRecipients", "ccRecipients",
  "bccRecipients", "replyTo", "receivedDateTime", "sentDateTime", "isRead", "isDraft", "importance", "flag",
  "categories", "hasAttachments", "bodyPreview", "inferenceClassification", "webLink", "internetMessageId",
].join(",");

/** A parsed email address; `name` only when it is visible and differs from the address. */
export type GraphAddress = { address: string; name?: string };

/** A message's metadata, parsed. */
export type GraphMessage = GuardedMessage & {
  subject: string;
  fromAddress?: GraphAddress;
  sender?: GraphAddress;
  to: GraphAddress[];
  cc: GraphAddress[];
  bcc: GraphAddress[];
  replyTo: GraphAddress[];
  categories: readonly string[];
  receivedAt: string;
  sentAt?: string;
  isRead: boolean;
  importance: "low" | "normal" | "high";
  flag: { status: "notFlagged" | "flagged" | "complete"; dueAt?: string; completedAt?: string };
  hasAttachments: boolean;
  preview: string;
  focused?: boolean;
  webLink: string;
  internetMessageId?: string;
};

/** A mail folder's metadata, parsed. */
export type GraphFolder = {
  id: string;
  name: string;
  parentId?: string;
  childCount: number;
  unreadCount: number;
  totalCount: number;
  /** Hidden from Outlook's folder list (sync issues, conversation settings and the like). */
  hidden: boolean;
};

/** An attachment's metadata, parsed. `contentId` names an inline image's `cid:`. */
export type GraphAttachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: "file" | "item" | "link";
  inline: boolean;
  contentId?: string;
};

/** A message body as Graph returns it. */
export type GraphBody = { contentType: "html" | "text"; content: string };

function num(json: Record<string, unknown>, key: string): number {
  const value = json[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function address(value: unknown): GraphAddress | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const email = (value as { emailAddress?: unknown }).emailAddress;
  if (email === null || typeof email !== "object") return undefined;
  const { address: raw, name } = email as { address?: unknown; name?: unknown };
  if (typeof raw !== "string" || raw === "") return undefined;
  // Names, subjects and previews are the sender's to choose, so what a person can't see is dropped.
  const shown = typeof name === "string" ? visibleText(name).trim() : "";
  return { address: raw, ...(shown !== "" && shown !== raw ? { name: shown } : {}) };
}

function addresses(value: unknown): GraphAddress[] {
  return Array.isArray(value) ? value.map(address).filter((entry): entry is GraphAddress => entry !== undefined) : [];
}

/** A Graph `dateTimeTimeZone` as ISO 8601. Graph returns flag dates in UTC when asked for nothing else. */
function dateTimeZone(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
  if (typeof dateTime !== "string") return undefined;
  return timeZone === "UTC" && !/Z|[+-]\d\d:\d\d$/.test(dateTime) ? `${dateTime.replace(/\.\d+$/, "")}Z` : dateTime;
}

/** Parses a message selected with `MESSAGE_SELECT`; throws on one without an ID. */
export function parseMessage(row: unknown): GraphMessage {
  const json = record(row, "message");
  const id = str(json, "id", "message");
  const flag = json.flag !== null && typeof json.flag === "object" ? json.flag as Record<string, unknown> : {};
  const status = flag.flagStatus === "flagged" || flag.flagStatus === "complete" ? flag.flagStatus : "notFlagged";
  const dueAt = dateTimeZone(flag.dueDateTime);
  const completedAt = dateTimeZone(flag.completedDateTime);
  const importance = json.importance === "low" || json.importance === "high" ? json.importance : "normal";
  const from = address(json.from);
  const sender = address(json.sender);
  return {
    id,
    parentFolderId: optStr(json, "parentFolderId") ?? "",
    conversationId: optStr(json, "conversationId") ?? "",
    ...(from ? { from: from.address.toLowerCase(), fromAddress: from } : {}),
    ...(sender && from && sender.address.toLowerCase() !== from.address.toLowerCase() ? { sender } : {}),
    categories: Array.isArray(json.categories) ? json.categories.filter((name): name is string => typeof name === "string") : [],
    receivedAt: optStr(json, "receivedDateTime") ?? optStr(json, "createdDateTime") ?? "",
    isDraft: json.isDraft === true,
    subject: typeof json.subject === "string" ? visibleText(json.subject) : "",
    to: addresses(json.toRecipients),
    cc: addresses(json.ccRecipients),
    bcc: addresses(json.bccRecipients),
    replyTo: addresses(json.replyTo),
    ...(optStr(json, "sentDateTime") ? { sentAt: optStr(json, "sentDateTime") } : {}),
    isRead: json.isRead === true,
    importance,
    flag: { status, ...(dueAt ? { dueAt } : {}), ...(completedAt ? { completedAt } : {}) },
    hasAttachments: json.hasAttachments === true,
    // Outlook shows this line, preheader text included, under the subject in its message list.
    preview: typeof json.bodyPreview === "string" ? visibleText(json.bodyPreview) : "",
    ...(json.inferenceClassification === "focused" ? { focused: true } : json.inferenceClassification === "other" ? { focused: false } : {}),
    webLink: optStr(json, "webLink") ?? "",
    ...(optStr(json, "internetMessageId") ? { internetMessageId: optStr(json, "internetMessageId") } : {}),
  };
}

/** Parses a mail folder; throws on one without an ID. */
export function parseFolder(row: unknown): GraphFolder {
  const json = record(row, "folder");
  return {
    id: str(json, "id", "folder"),
    name: typeof json.displayName === "string" ? json.displayName : "",
    ...(optStr(json, "parentFolderId") ? { parentId: optStr(json, "parentFolderId") } : {}),
    childCount: num(json, "childFolderCount"),
    unreadCount: num(json, "unreadItemCount"),
    totalCount: num(json, "totalItemCount"),
    hidden: json.isHidden === true,
  };
}

/** Parses an attachment; throws on one without an ID. */
function parseAttachment(row: unknown): GraphAttachment {
  const json = record(row, "attachment");
  const type = optStr(json, "@odata.type") ?? "";
  return {
    id: str(json, "id", "attachment"),
    name: typeof json.name === "string" && visibleText(json.name).trim() !== "" ? visibleText(json.name).trim() : "attachment",
    contentType: optStr(json, "contentType") ?? "application/octet-stream",
    size: num(json, "size"),
    kind: type.endsWith("itemAttachment") ? "item" : type.endsWith("referenceAttachment") ? "link" : "file",
    inline: json.isInline === true,
    ...(optStr(json, "contentId") ? { contentId: optStr(json, "contentId") } : {}),
  };
}

/** Parses a `body` or `uniqueBody`; anything malformed reads as empty text. */
function parseBody(value: unknown): GraphBody {
  if (value === null || typeof value !== "object") return { contentType: "text", content: "" };
  const { contentType, content } = value as { contentType?: unknown; content?: unknown };
  return { contentType: contentType === "html" ? "html" : "text", content: typeof content === "string" ? content : "" };
}

const FOLDER_SELECT = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden";

/** Outlook's own folders, by the names Graph addresses them with. */
const WELL_KNOWN_FOLDERS = [
  "inbox", "drafts", "sentitems", "deleteditems", "archive", "junkemail", "outbox", "conversationhistory", "msgfolderroot",
  "syncissues", "recoverableitemsdeletions",
] as const;

/** The most attachments one message is read with; Outlook's own limit is far lower. */
const MAX_ATTACHMENTS_LISTED = 500;

/** Whether a page is asked for by the `nextLink` a previous page gave, which Graph is asked for as it is, and not by a path under its owner. */
export function isNextLink(pathOrNext: string): boolean {
  return pathOrNext.startsWith("https://");
}

/**
 * Whether a page links to its next page at a URL the client refuses to request (`refusesPath`),
 * which leaves a caller that pages on with an error and nothing sent. The `unusable` of the
 * request that answers a page, by the check the client makes of the link once it is followed.
 */
export function strands(page: GraphPage<unknown>): boolean {
  return page.nextLink !== undefined && isNextLink(page.nextLink) && refusesPath(page.nextLink);
}

/** Graph for one mailbox. Cheap to construct. */
export class MailApi {
  readonly base: string;

  constructor(readonly api: GraphApi, readonly mailbox: OutlookMailboxRef) {
    this.base = mailboxPath(mailbox);
  }

  /**
   * A GET of a path under the mailbox, returning JSON; a missing resource throws.
   * @param read Reads the answer inside the request (see `GraphApi.request`).
   * @param unusable Says whether what was read is not what was asked for (see `GraphApi.request`).
   */
  async get<T, R = T>(path: string, query?: Record<string, string | number | undefined>, prefer: string[] = [], read?: (answer: T) => R,
                      unusable?: (value: R) => boolean): Promise<R> {
    return await this.api.get(this.base + path, { query: query ?? {}, prefer: [IMMUTABLE_IDS, ...prefer] }, read, unusable);
  }

  /**
   * A GET answering null for a 404 or 403, which Exchange gives for an ID in another mailbox, and
   * for a 400, which it gives for an ID that isn't one of its own (`ErrorInvalidIdMalformed`).
   * @param read Reads the answer inside the request (see `GraphApi.request`), null for those statuses.
   */
  async find<T, R = T | null>(path: string, query?: Record<string, string | number | undefined>, read?: (answer: T | null) => R): Promise<R> {
    return await this.api.request("GET", this.base + path, { query: query ?? {}, prefer: [IMMUTABLE_IDS], allow: [400, 403, 404] }, read);
  }

  /**
   * A write (or any other method) on a path under the mailbox, with a JSON body; null for a 204.
   * @param read Reads the answer inside the request (see `GraphApi.request`).
   */
  async request<T, R = T | null>(method: string, path: string, body?: unknown, options: Pick<RequestOptions, "ifMatch" | "allow"> = {},
                                 read?: (answer: T | null) => R): Promise<R> {
    return await this.api.request(method, this.base + path, { ...options, ...(body === undefined ? {} : { body }), prefer: [IMMUTABLE_IDS] }, read);
  }

  /**
   * A page of results from a path in this mailbox, or the `nextLink` a previous page gave. A page
   * whose `nextLink` leaves Graph is returned as it came, and its request is counted as an error
   * of the API (`strands`): the client refuses that link once it is asked for the page after.
   */
  async page<T>(pathOrNext: string, parse: (row: unknown) => T, what: string, query?: Record<string, string | number | undefined>, prefer: string[] = []): Promise<GraphPage<T>> {
    const read = (body: unknown) => parsePage(body, parse, what);
    return isNextLink(pathOrNext)
      ? await this.api.get(pathOrNext, { prefer: [IMMUTABLE_IDS, ...prefer] }, read, strands)
      : await this.get(pathOrNext, query, prefer, read, strands);
  }

  /** One message's metadata, or null when it isn't in this mailbox. */
  async message(id: string): Promise<GraphMessage | null> {
    return await this.find(`/messages/${idPath(id)}`, { $select: MESSAGE_SELECT }, (body: unknown) => body === null ? null : parseMessage(body));
  }

  /**
   * A draft in one read, so its version (`changeKey`) names exactly the recipients and body read with
   * it: separate reads could fence a send on a version nobody saw. Null when it isn't in this mailbox.
   */
  async draft(id: string): Promise<{ message: GraphMessage; body: GraphBody; changeKey?: string; conversationIndex: string } | null> {
    return await this.find(`/messages/${idPath(id)}`, { $select: `${MESSAGE_SELECT},body,changeKey,conversationIndex` }, (row: unknown) => {
      if (row === null) return null;
      const json = record(row, "message");
      return {
        message: parseMessage(json), body: parseBody(json.body),
        ...(typeof json.changeKey === "string" ? { changeKey: json.changeKey } : {}),
        conversationIndex: typeof json.conversationIndex === "string" ? json.conversationIndex : "",
      };
    });
  }

  /** Several messages' metadata in one round trip, by ID; a message not in the mailbox is absent. */
  async messages(ids: readonly string[]): Promise<Map<string, GraphMessage>> {
    const found = new Map<string, GraphMessage>();
    for (let start = 0; start < ids.length; start += MAX_BATCH_REQUESTS) {
      const chunk = ids.slice(start, start + MAX_BATCH_REQUESTS);
      const requests: BatchRequest[] = chunk.map((id, index) => ({
        id: String(index), method: "GET", url: `${this.base.slice(1)}/messages/${idPath(id)}?$select=${MESSAGE_SELECT}`,
        headers: { prefer: IMMUTABLE_IDS },
      }));
      const answers = await this.api.batch(requests, { whole: true });
      chunk.forEach((id, index) => {
        const answer = answers.get(String(index));
        if (answer === undefined) throw new GraphApiError(502, "Microsoft Graph left a message out of a batch.");
        if (answer.status === 200) found.set(id, parseMessage(answer.body));
        else if (answer.status !== 404 && answer.status !== 403 && answer.status !== 400) {
          throw new GraphApiError(answer.status, "Microsoft Graph couldn't read some messages. Try again shortly.");
        }
      });
    }
    return found;
  }

  /** A folder by ID or well-known name, or null when it isn't in this mailbox. */
  async folder(idOrWellKnown: string): Promise<GraphFolder | null> {
    const segment = (WELL_KNOWN_FOLDERS as readonly string[]).includes(idOrWellKnown) ? idOrWellKnown : idPath(idOrWellKnown);
    return await this.find(`/mailFolders/${segment}`, { $select: FOLDER_SELECT }, (body: unknown) => body === null ? null : parseFolder(body));
  }

  /** A folder's subfolders, every page. */
  async childFolders(id: string | null, limit = 500): Promise<GraphFolder[]> {
    const folders: GraphFolder[] = [];
    let next: string | undefined = id === null ? "/mailFolders" : `/mailFolders/${idPath(id)}/childFolders`;
    let query: Record<string, string | number> | undefined = { $select: FOLDER_SELECT, $top: 100, includeHiddenFolders: "false" };
    while (next !== undefined && folders.length < limit) {
      const page: GraphPage<GraphFolder> = await this.page(next, parseFolder, "folder", query);
      folders.push(...page.items);
      next = page.nextLink;
      query = undefined;
    }
    return folders;
  }

  /** The IDs of Outlook's own folders, by well-known name, in one round trip. */
  async wellKnownFolders(): Promise<Map<string, string>> {
    const requests: BatchRequest[] = WELL_KNOWN_FOLDERS.map(name => ({
      id: name, method: "GET", url: `${this.base.slice(1)}/mailFolders/${name}?$select=id`, headers: { prefer: IMMUTABLE_IDS },
    }));
    const answers = await this.api.batch(requests, { whole: true });
    const ids = new Map<string, string>();
    for (const name of WELL_KNOWN_FOLDERS) {
      const answer = answers.get(name);
      // A folder left out would read as absent, and a narrowed binding then admits what it holds.
      if (answer === undefined) throw new GraphApiError(502, "Microsoft Graph left a folder out of a batch.");
      if (answer.status === 200) ids.set(name, str(record(answer.body, "folder"), "id", "folder"));
      // A mailbox that lacks one (no Archive yet, say) answers 404, or 400 for a name it doesn't know.
      else if (answer.status !== 404 && answer.status !== 400) throw new GraphApiError(answer.status, "Microsoft Graph couldn't list the mailbox's folders.");
    }
    return ids;
  }

  /** A message's body, or with `unique` only what it added to its conversation (`uniqueBody`). */
  async body(id: string, unique = false): Promise<GraphBody> {
    const field = unique ? "uniqueBody" : "body";
    return await this.get(`/messages/${idPath(id)}`, { $select: field }, [], (body: unknown) => parseBody(record(body, "message")[field]));
  }

  /** A message's attachments' metadata, every page up to `MAX_ATTACHMENTS_LISTED`. */
  async attachments(id: string): Promise<GraphAttachment[]> {
    const attachments: GraphAttachment[] = [];
    let next: string | undefined = `/messages/${idPath(id)}/attachments`;
    let query: Record<string, string | number> | undefined = { $select: "id,name,contentType,size,isInline", $top: 100 };
    while (next !== undefined && attachments.length < MAX_ATTACHMENTS_LISTED) {
      const page: GraphPage<GraphAttachment> = await this.page(next, parseAttachment, "attachment", query);
      attachments.push(...page.items);
      next = page.nextLink;
      query = undefined;
    }
    return attachments;
  }
}
