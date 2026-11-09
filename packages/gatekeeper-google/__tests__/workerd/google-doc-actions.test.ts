import { abortAllDurableObjects, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocActionTab } from "../../src/google";
import { MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import { officeFileError } from "../../src/office-conversion";
import type { DocsRange, GoogleDocsRequest, GoogleDocsTab } from "../../src/docs-api";
import type { GoogleDocSession } from "../../src/docs-types";
import {
  alignmentAt, applyDocsRequests, fontSizeAt, indentedParagraphs, pinnedHeaderRows,
} from "../docs-body-model";
import type { ModelParagraphStyle, ModelTextStyle } from "../docs-body-model";
import { buildTab, BULLET_LIST } from "../doc-fixture";

/** A request that changes content, or one of the two that create and delete a write marker. */
type BatchRequest =
  | GoogleDocsRequest
  | { createNamedRange: { name: string; range: DocsRange } }
  | { deleteNamedRange: { namedRangeId: string } };

/** A comment write: a comment attached to text, or a reply to a comment or a suggestion. */
type CommentRequest =
  | { insertComment: { content: string; range: DocsRange } }
  | {
    addCommentReply: {
      commentId?: string;
      suggestionId?: string;
      post: { content?: string; commentAction?: "RESOLVE" | "REOPEN" };
    };
  };

/** One post of a comment thread, as Docs returns it. */
type ModelPost = {
  postId: string;
  content: string;
  author: { displayName: string; me: boolean };
  createTime: string;
  commentAction?: "RESOLVE" | "REOPEN";
};

/** One comment thread, as Docs returns it: `anchorId` only when it is attached to text. */
type ModelThread = {
  commentId: string;
  anchorId?: string;
  plainTextQuote?: string;
  status: "OPEN" | "RESOLVED";
  headPost: ModelPost;
  replies: ModelPost[];
};

/**
 * The tab a request names. Every write coordinate names the tab it applies to, since tab bodies
 * index independently; a request that leaves it out has none.
 */
function requestTabId(
  request: Exclude<BatchRequest, { deleteNamedRange: unknown }>,
): string | undefined {
  if ("createNamedRange" in request) return request.createNamedRange.range.tabId;
  if ("insertText" in request) return request.insertText.location.tabId;
  if ("deleteContentRange" in request) return request.deleteContentRange.range.tabId;
  if ("updateTextStyle" in request) return request.updateTextStyle.range.tabId;
  if ("updateParagraphStyle" in request) return request.updateParagraphStyle.range.tabId;
  if ("createParagraphBullets" in request) return request.createParagraphBullets.range.tabId;
  if ("deleteParagraphBullets" in request) return request.deleteParagraphBullets.range.tabId;
  if ("insertTable" in request) return request.insertTable.location.tabId;
  if ("pinTableHeaderRows" in request) return request.pinTableHeaderRows.tableStartLocation.tabId;
  // A row or column request names its table, and the table's start names the tab.
  let cell = "insertTableRow" in request ? request.insertTableRow.tableCellLocation
    : "insertTableColumn" in request ? request.insertTableColumn.tableCellLocation
    : "deleteTableRow" in request ? request.deleteTableRow.tableCellLocation
    : request.deleteTableColumn.tableCellLocation;
  return cell.tableStartLocation.tabId;
}

type ModelListItem = { id: string; preset: string };
/** `"indented"` is the indent Google leaves on a paragraph whose bullet was removed. */
type ModelListSlot = ModelListItem | "indented" | null;

function isListItem(slot: ModelListSlot | undefined): slot is ModelListItem {
  return typeof slot === "object" && slot !== null;
}

/** One tab of the model document: its own text, and its place in the tab tree. */
type ModelTab = {
  id: string;
  title: string;
  parentId?: string;
  text: string;
  table?: { before: string; rows: string[][]; after: string };
  /** A body the shared model edits, with the list definitions its paragraphs reference. */
  body?: GoogleDocsTab["body"];
  lists?: GoogleDocsTab["lists"];
  links: { start: number; end: number; url: string }[];
  paragraphStyles?: string[];
  paragraphLists?: ModelListSlot[];
};
function withoutDeletedParagraphs<T>(
  text: string,
  values: T[],
  start: number,
  end: number,
): T[] {
  let kept: T[] = [];
  let paragraph = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index < start || index >= end) kept.push(values[paragraph]);
    paragraph++;
  }
  return kept;
}

/** Indexes of the plain-text paragraphs `range` touches. */
function paragraphsIn(text: string, range: { startIndex: number; endIndex: number }): number[] {
  let startIndex = 1;
  return text.split("\n").flatMap((paragraph, index) => {
    let endIndex = startIndex + paragraph.length + 1;
    let overlaps = range.startIndex < endIndex && range.endIndex > startIndex;
    startIndex = endIndex;
    return overlaps ? [index] : [];
  });
}

/** The tab a single-tab document has, and the one the tab-agnostic tests exercise. */
const MAIN_TAB = "tab-1";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Google's own words for refusing an Office file, which nothing of ours may repeat. */
const OFFICE_REFUSAL =
  "This operation is not supported for this document. The document must not be an Office file.";

/**
 * A batch either carries the edit and its marker, or deletes a marker on its own; or a create; or
 * a read, whose answer is fixed when it arrives, so holding it delivers what was then current.
 */
type RequestKind = "content" | "cleanup" | "create" | "read";

class DocsModel {
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  contentBatches = 0;
  /** The content requests of the last batch applied, without its marker. */
  lastContentRequests: GoogleDocsRequest[] = [];
  /** Whether a tab given a body copies into new cells the look Google copies. */
  copyStyles = false;
  maxMarkerCount = 0;
  /** Google withholds `revisionId` from a caller without edit access. */
  editable = true;
  /** Full `documents.get` calls, excluding the lightweight revision probe. */
  documentFetches = 0;
  revisionProbes = 0;
  /** Every provider request, of any kind. */
  fetches = 0;
  /** The body of each `documents.create` call. */
  readonly creates: unknown[] = [];
  /**
   * How many create calls to refuse with a 403, and full reads to answer with a 404, as a read
   * racing a new document's propagation can. Neither is retried by the client.
   */
  createFailures = 0;
  readFailures = 0;
  /** The bearer token of each Docs request, which names the account it was made as. */
  readonly authorizations: string[] = [];
  driveFetches = 0;
  /** Drive's modification time for the document. */
  driveModifiedTime = "2026-01-02T03:04:05Z";
  /** What Drive answers with instead of that time, if anything. */
  driveFailure: { status: number; reason?: string } | "malformed" | null = null;
  /** The file's type as Drive reports it, when it reports one. */
  driveMimeType: string | undefined;
  /** Whether Google refuses every content edit as it refuses one to an Office file. */
  refusesEdits = false;
  readonly deletedMarkerIds: string[] = [];
  /** Marker ID to its name and owning tab. */
  readonly markers = new Map<string, { name: string; tabId: string }>();
  /** Tab each write marker was anchored in, retained after cleanup deletes the marker. */
  readonly markerTabIds: string[] = [];
  /** Every tab in preorder; the first is the one a single-tab document has. */
  readonly tabs: ModelTab[] = [{ id: MAIN_TAB, title: "Main", text: "", links: [] }];
  /** The Doc's comment threads, in the order Docs lists them. */
  readonly threads: ModelThread[] = [];
  /** Suggestions made in Suggesting mode, with the notes posted on them. */
  readonly suggestions: { suggestionId: string; summaryText: string; notes: string[] }[] = [];
  /** Whether Drive says the account may comment; a viewer is also refused the threads read. */
  canComment = true;
  /** Comment threads reads, and comment writes (comments, replies, suggestions, notes). */
  threadReads = 0;
  commentWrites = 0;
  /** How many comment writes to apply and then answer with no response. */
  lostCommentResponses = 0;
  #nextPostId = 1;
  #revision = 1;
  #nextMarkerId = 1;
  #nextListId = 1;
  readonly #held = new Map<RequestKind, { reach: () => void; released: Promise<void> }>();

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      this.fetch(input, init)));
  }

  addMarker(name: string, id: string, tabId = MAIN_TAB): void {
    this.markers.set(id, { name, tabId });
    this.#recordMarkerCount();
  }

  addTab(id: string, title: string, parentId: string, text = ""): void {
    this.tabs.push({ id, title, parentId, text, links: [] });
  }

  removeTab(id: string): void {
    this.tabs.splice(this.tabs.findIndex(tab => tab.id === id), 1);
    this.#revision++;
  }

  setText(tabId: string, text: string): void {
    this.#tab(tabId).text = text;
  }

  setLinkedText(tabId: string, text: string, url: string): void {
    let tab = this.#tab(tabId);
    tab.text = text;
    tab.links = [{ start: 0, end: text.length, url }];
  }

  setParagraphs(
    tabId: string, paragraphs: { text: string; namedStyleType: string }[],
  ): void {
    let tab = this.#tab(tabId);
    tab.text = paragraphs.map(paragraph => paragraph.text).join("\n");
    tab.paragraphStyles = paragraphs.map(paragraph => paragraph.namedStyleType);
  }

  setNumberedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, "NUMBERED_DECIMAL_ALPHA_ROMAN");
  }

  setBulletedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, "BULLET_DISC_CIRCLE_SQUARE");
  }

  #setList(tabId: string, items: string[], preset: string): void {
    let tab = this.#tab(tabId);
    let list = { id: `list-${this.#nextListId++}`, preset };
    tab.text = items.join("\n");
    tab.paragraphLists = items.map(() => list);
  }
  interruptList(tabId: string, index: number): void {
    this.#tab(tabId).paragraphLists![index] = null;
  }

  setTable(tabId: string, before: string, rows: string[][], after: string): void {
    this.#tab(tabId).table = { before, rows, after };
  }

  /** Give a tab a body, which the shared model edits, and the lists its paragraphs reference. */
  setBody(tabId: string, body: GoogleDocsTab["body"], lists: GoogleDocsTab["lists"] = {}): void {
    let tab = this.#tab(tabId);
    tab.body = body;
    tab.lists = lists;
  }

  /** A collaborator's edit to a tab that has a body: the body is replaced, the revision moves. */
  externalBody(tabId: string, body: GoogleDocsTab["body"]): void {
    this.#tab(tabId).body = body;
    this.#revision++;
  }

  /** A collaborator replaces the text of the first paragraph of one cell of a tab's body. */
  externalCellEdit(
    table: number, row: number, column: number, text: string, tabId = MAIN_TAB,
  ): void {
    let [index] = this.cellParagraphs(table, row, column, tabId);
    let [first] = this.cellRuns(table, row, column, tabId);
    let old = first.content.replace(/\n$/, "");
    this.externalBody(tabId, applyDocsRequests(this.bodyTab(tabId), [
      { deleteContentRange: { range: { startIndex: index, endIndex: index + old.length, tabId } } },
      { insertText: { location: { index, tabId }, text } },
    ]).body);
  }

  /** A tab that has a body, as the shared model takes it. */
  bodyTab(tabId = MAIN_TAB): GoogleDocsTab {
    let tab = this.#tab(tabId);
    if (!tab.body) throw new Error(`Tab "${tabId}" has no body`);
    return {
      tabId: tab.id, title: tab.title, index: 0, nestingLevel: 0,
      body: tab.body, lists: tab.lists ?? {}, namedRanges: {},
    };
  }

  /** The tables of a tab's body, in order. */
  tables(tabId = MAIN_TAB) {
    return this.bodyTab(tabId).body.content.flatMap(element =>
      element.table ? [{ start: element.startIndex, rows: element.table.tableRows ?? [] }] : []);
  }

  /** The start index of each paragraph of one cell of a tab's body. */
  cellParagraphs(table: number, row: number, column: number, tabId = MAIN_TAB): number[] {
    let cell = this.tables(tabId)[table]?.rows[row]?.tableCells?.[column];
    if (!cell) throw new Error(`Table ${table} has no cell at row ${row}, column ${column}`);
    return (cell.content ?? []).flatMap(element => element.paragraph ? [element.startIndex] : []);
  }

  /** The text of one cell of a tab's body, its paragraphs joined by line breaks. */
  cellText(table: number, row: number, column: number, tabId = MAIN_TAB): string {
    return this.cellRuns(table, row, column, tabId).map(run => run.content).join("")
      .replace(/\n$/, "");
  }

  /** The text runs of one cell of a tab's body, in order. */
  cellRuns(table: number, row: number, column: number, tabId = MAIN_TAB) {
    let cell = this.tables(tabId)[table]?.rows[row]?.tableCells?.[column];
    if (!cell) throw new Error(`Table ${table} has no cell at row ${row}, column ${column}`);
    return (cell.content ?? []).flatMap(element =>
      element.paragraph?.elements.flatMap(part => part.textRun ?? []) ?? []);
  }

  text(tabId = MAIN_TAB): string {
    let tab = this.#tab(tabId);
    if (!tab.body) return tab.text;
    return tab.body.content.flatMap(element =>
      element.paragraph?.elements.flatMap(part => part.textRun?.content ?? []) ?? [],
    ).join("").replace(/\n$/, "");
  }

  renderedText(tabId = MAIN_TAB): string {
    let tab = this.#tab(tabId);
    let counts = new Map<string, number>();
    return tab.text.split("\n").map((text, index) => {
      let list = tab.paragraphLists?.[index];
      if (list === "indented") return `\t${text}`;
      if (!list) return text;
      let number = (counts.get(list.id) ?? 0) + 1;
      counts.set(list.id, number);
      return `${number}. ${text}`;
    }).join("\n");
  }

  clearMarkers(): void {
    this.markers.clear();
  }

  /**
   * Holds the next request of `kind` open, so another request can interleave with it mid-flight.
   *
   * `reached` resolves once the provider has the request in hand, before anything is applied.
   */
  hold(kind: RequestKind): { reached: Promise<void>; release: () => void } {
    let reach!: () => void;
    let release!: () => void;
    let reached = new Promise<void>(resolve => { reach = resolve; });
    let released = new Promise<void>(resolve => { release = resolve; });
    this.#held.set(kind, { reach, released });
    return { reached, release };
  }

  /** A collaborator edit: the document changes without this gatekeeper writing to it. */
  externalEdit(tabId = MAIN_TAB, text?: string): void {
    let tab = this.#tab(tabId);
    tab.text = text ?? tab.text + "collaborator";
    this.#revision++;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    this.fetches++;
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/batch/")) {
      this.driveFetches++;
      return this.#scopeNodes();
    }
    if (url.hostname === "www.googleapis.com") {
      this.driveFetches++;
      if (this.driveFailure === "malformed") {
        return Response.json({ id: "doc-1", name: "Test document" });
      }
      if (this.driveFailure) {
        let { status, reason } = this.driveFailure;
        return Response.json(
          { error: { code: status, errors: reason ? [{ reason }] : [] } }, { status });
      }
      return Response.json({
        id: "doc-1", name: "Test document", modifiedTime: this.driveModifiedTime,
        ...this.driveMimeType ? { mimeType: this.driveMimeType } : {},
      });
    }
    if (url.hostname !== "docs.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url}`);
    }
    this.authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
    if (url.pathname === "/v1/documents") {
      if (init?.method !== "POST") throw new Error("documents.create must be a POST");
      await this.#hold("create");
      this.creates.push(JSON.parse(String(init.body)));
      if (this.createFailures > 0) {
        this.createFailures--;
        return Response.json(
          { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } },
          { status: 403 });
      }
      return Response.json({ documentId: "doc-1" });
    }
    if (!url.pathname.endsWith(":batchUpdate") &&
        url.searchParams.get("commentsViewMode") === "COMMENTS_VIEW_MODE_INCLUDED") {
      return this.#threadsRead(url);
    }
    if (!url.pathname.endsWith(":batchUpdate")) {
      let fields = url.searchParams.get("fields");
      if (fields === null) {
        this.documentFetches++;
        if (this.readFailures > 0) {
          this.readFailures--;
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        }
      } else if (fields === "revisionId") this.revisionProbes++;
      let document = this.#document();
      await this.#hold("read");
      return Response.json(document);
    }

    let body = JSON.parse(String(init?.body)) as {
      requests: BatchRequest[];
      writeControl?: { requiredRevisionId?: string; writeMode?: "SUGGEST" };
    };
    let first = body.requests[0] as BatchRequest | CommentRequest | undefined;
    if (first && ("insertComment" in first || "addCommentReply" in first) ||
        body.writeControl?.writeMode === "SUGGEST") {
      return this.#commentWrite(
        body as { requests: (GoogleDocsRequest | CommentRequest)[]; writeControl?: typeof body.writeControl });
    }
    let isDelete = body.requests.length === 1 && "deleteNamedRange" in body.requests[0];
    await this.#hold(isDelete ? "cleanup" : "content");
    if (!isDelete && this.refusesEdits) {
      return Response.json({
        error: { code: 400, status: "FAILED_PRECONDITION", message: OFFICE_REFUSAL },
      }, { status: 400 });
    }
    if (isDelete && this.cleanupFailures > 0) {
      this.cleanupFailures--;
      throw new Error("cleanup failed");
    }
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return Response.json({ error: { code: 400, message: "revision mismatch" } }, { status: 400 });
    }

    // Google resolves an unqualified coordinate against a default tab, so a request that omits
    // the ID would edit whichever tab that happens to be.
    let contentRequests: GoogleDocsRequest[] = [];
    let bodyRequests = new Map<ModelTab, GoogleDocsRequest[]>();
    for (const request of body.requests) {
      if ("deleteNamedRange" in request) continue;
      let tabId = requestTabId(request);
      if (!tabId) {
        throw new Error(`Google Docs request is missing tabId: ${JSON.stringify(request)}`);
      }
      if ("createNamedRange" in request) continue;
      contentRequests.push(request);
      let tab = this.#tab(tabId);
      if (tab.body) bodyRequests.set(tab, [...bodyRequests.get(tab) ?? [], request]);
    }
    // A tab given a body is edited by the shared model: all of a batch, or none of it, the
    // marker included.
    let editedBodies = new Map<ModelTab, GoogleDocsTab["body"]>();
    for (const [tab, requests] of bodyRequests) {
      try {
        let edited = applyDocsRequests(
          this.bodyTab(tab.id), requests, { copyStyles: this.copyStyles });
        editedBodies.set(tab, edited.body);
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: { code: 400, status: "INVALID_ARGUMENT", message } }, { status: 400 });
      }
    }
    for (const [tab, edited] of editedBodies) tab.body = edited;

    let replies: unknown[] = [];
    let hasContent = contentRequests.length > 0;
    for (const request of body.requests) {
      if ("deleteNamedRange" in request) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
        continue;
      }

      let tab = this.#tab(requestTabId(request) ?? "");
      if ("createNamedRange" in request) {
        let id = `marker-${this.#nextMarkerId++}`;
        this.addMarker(request.createNamedRange.name, id, tab.id);
        this.markerTabIds.push(tab.id);
        replies.push({ createNamedRange: { namedRangeId: id } });
        continue;
      }

      // The shared model has applied the requests of a tab that has a body.
      if (!tab.body) this.#applyToText(tab, request);
      replies.push({});
    }
    if (hasContent) this.lastContentRequests = contentRequests;
    if (hasContent) this.contentBatches++;
    this.#revision++;
    this.#recordMarkerCount();

    if (hasContent && this.ambiguousContentResponses > 0) {
      this.ambiguousContentResponses--;
      throw new Error("content response lost");
    }
    return Response.json({
      replies,
      writeControl: { requiredRevisionId: `revision-${this.#revision}` },
    });
  }

  /** A comment made in the editor or through Drive, by someone else unless `me`. */
  addThread(content: string, { quote, resolved = false, me = false, author = "Ada Lovelace" }: {
    quote?: string; resolved?: boolean; me?: boolean; author?: string;
  } = {}): ModelThread {
    let id = `doco.t${this.#nextPostId++}`;
    let thread: ModelThread = {
      commentId: id,
      ...quote === undefined ? {} : { anchorId: `kix.${id}`, plainTextQuote: quote },
      status: resolved ? "RESOLVED" : "OPEN",
      headPost: this.#post(content, me, id, author),
      replies: [],
    };
    this.threads.push(thread);
    return thread;
  }

  thread(commentId: string): ModelThread {
    let thread = this.threads.find(candidate => candidate.commentId === commentId);
    if (!thread) throw new Error(`No comment ${commentId}`);
    return thread;
  }

  #post(content: string, me: boolean, postId?: string, author = "Me"): ModelPost {
    return {
      postId: postId ?? `doco.p${this.#nextPostId++}`, content: content.trim(),
      author: { displayName: me ? "Me" : author, me }, createTime: new Date().toISOString(),
    };
  }

  /** Drive's batch answer for the Doc's scope node: whether the account may comment on it. */
  #scopeNodes(): Response {
    let boundary = "batch_boundary";
    let body = {
      id: "doc-1", mimeType: "application/vnd.google-apps.document", trashed: false,
      capabilities: { canComment: this.canComment },
    };
    let text = [
      `--${boundary}`, "Content-Type: application/http", "Content-ID: <response-item-0>", "",
      "HTTP/1.1 200 OK", "Content-Type: application/json", "", JSON.stringify(body), "",
      `--${boundary}--`, "",
    ].join("\r\n");
    return new Response(text, { headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` } });
  }

  /** `documents.get` with comments included, as Google answers it. */
  #threadsRead(url: URL): Response {
    if (url.searchParams.get("suggestionsViewMode") !== "SUGGESTIONS_INLINE") {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT",
        message: "Comments may only be explicitly included if inline suggestions are also explicitly requested." } },
        { status: 400 });
    }
    if (!this.canComment) {
      return Response.json({ error: { code: 403, status: "PERMISSION_DENIED",
        message: "You do not have permission to access the document suggestions." } }, { status: 403 });
    }
    let fields = url.searchParams.get("fields");
    if (fields?.startsWith("documentId,comments(")) {
      this.threadReads++;
      return Response.json({ documentId: "doc-1", ...this.threads.length ? { comments: this.threads } : {} });
    }
    this.documentFetches++;
    return Response.json({
      ...this.#document(),
      ...this.threads.length ? { comments: this.threads } : {},
      suggestions: this.suggestions.map(({ suggestionId, summaryText, notes }) => ({
        suggestionId, summaryText,
        headPost: { content: "", author: { me: true }, createTime: new Date().toISOString() },
        replies: notes.map(content => ({ content, author: { me: true }, createTime: new Date().toISOString() })),
      })),
    });
  }

  /** A batch of comment writes, or one suggestion, as Docs applies it. */
  #commentWrite(body: {
    requests: (GoogleDocsRequest | CommentRequest)[];
    writeControl?: { requiredRevisionId?: string; writeMode?: "SUGGEST" };
  }): Response {
    let refuse = (code: number, status: string, message: string) =>
      Response.json({ error: { code, status, message } }, { status: code });
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return refuse(400, "INVALID_ARGUMENT", "The required revision ID does not match the latest revision.");
    }
    let replies: unknown[] = [];
    let suggestionResponses: unknown[] = [];
    if (body.writeControl?.writeMode === "SUGGEST") {
      let [remove, insert] = body.requests;
      if (!remove || !("deleteContentRange" in remove)) throw new Error("A suggestion starts with a deletion");
      let { startIndex, endIndex, tabId } = remove.deleteContentRange.range;
      let old = this.#tab(tabId!).text.slice(startIndex - 1, endIndex - 1);
      let id = `suggest.s${this.suggestions.length + 1}`;
      this.suggestions.push({
        suggestionId: id, notes: [],
        summaryText: insert && "insertText" in insert ? `Replace: “${old}” with “${insert.insertText.text}”` : `Delete: “${old}”`,
      });
      suggestionResponses.push({ createdSuggestionIds: [id] });
    }
    for (let request of body.requests) {
      if ("insertComment" in request) {
        let { content, range } = request.insertComment;
        let quote = this.#tab(range.tabId!).text.slice(range.startIndex - 1, range.endIndex - 1);
        let thread = this.addThread(content, { quote, me: true });
        replies.push({ insertComment: { commentThread: { commentId: thread.commentId } } });
      } else if ("addCommentReply" in request && request.addCommentReply.suggestionId) {
        let { suggestionId } = request.addCommentReply;
        let suggestion = this.suggestions.find(candidate => candidate.suggestionId === suggestionId);
        if (!suggestion) return refuse(404, "NOT_FOUND", "No such suggestion.");
        suggestion.notes.push(request.addCommentReply.post.content ?? "");
        replies.push({});
      } else if ("addCommentReply" in request) {
        let { commentId, post } = request.addCommentReply;
        let thread = this.threads.find(candidate => candidate.commentId === commentId);
        if (!thread) return refuse(404, "NOT_FOUND", `Comment with ID ${commentId} does not exist.`);
        if (!thread.anchorId) return refuse(400, "INVALID_ARGUMENT", "An error occurred while saving comments.");
        let made = this.#post(post.content ?? "", true);
        let action = post.commentAction ?? (thread.status === "RESOLVED" ? "REOPEN" : undefined);
        if (action) made.commentAction = action;
        thread.status = action === "RESOLVE" ? "RESOLVED" : "OPEN";
        thread.replies.push(made);
        replies.push({ addCommentReply: { post: made } });
      }
    }
    this.commentWrites++;
    this.#revision++;
    if (this.lostCommentResponses > 0) {
      this.lostCommentResponses--;
      throw new Error("comment response lost");
    }
    return Response.json({
      documentId: "doc-1", replies, suggestionResponses, commentUpdateState: "ALL_SAVED",
      writeControl: { requiredRevisionId: `revision-${this.#revision}` },
    });
  }

  /** Apply one content request to a tab that holds text, or a `setTable` table, and no body. */
  #applyToText(tab: ModelTab, request: GoogleDocsRequest): void {
    if ("insertText" in request) {
      this.#insertText(tab, request.insertText.location.index, request.insertText.text);
    } else if ("deleteContentRange" in request) {
      let { startIndex, endIndex } = request.deleteContentRange.range;
      this.#deleteText(tab, startIndex, endIndex);
    } else if ("updateParagraphStyle" in request) {
      let { range, paragraphStyle, fields } = request.updateParagraphStyle;
      if (typeof paragraphStyle.namedStyleType === "string") {
        this.#setParagraphStyle(tab, range, paragraphStyle.namedStyleType);
      }
      if (fields.split(",").includes("indentStart")) this.#clearIndent(tab, range);
    } else if ("deleteParagraphBullets" in request) {
      this.#setBullets(tab, request.deleteParagraphBullets.range);
    } else if ("createParagraphBullets" in request) {
      this.#setBullets(
        tab, request.createParagraphBullets.range, request.createParagraphBullets.bulletPreset);
    } else if ("updateTextStyle" in request) {
      let { range, textStyle, fields } = request.updateTextStyle;
      let { link } = textStyle;
      if (link || fields.includes("link")) {
        this.#setLink(
          tab, range.startIndex - 1, range.endIndex - 1,
          link && "url" in link ? link.url : undefined);
      }
    } else {
      throw new Error("Fixture cannot edit table structure");
    }
  }

  #insertText(tab: ModelTab, index: number, text: string): void {
    if (tab.table) {
      this.#replaceTableText(tab, index, index, text);
      return;
    }
    let offset = index - 1;
    let paragraph = tab.text.slice(0, offset).split("\n").length - 1;
    let insertedParagraphs = text.split("\n").length - 1;
    if (tab.paragraphStyles) {
      let style = tab.paragraphStyles[paragraph];
      tab.paragraphStyles.splice(paragraph, 0, ...Array(insertedParagraphs).fill(style));
    }
    if (tab.paragraphLists) {
      let list = tab.paragraphLists[paragraph] ?? null;
      tab.paragraphLists.splice(paragraph, 0, ...Array(insertedParagraphs).fill(list));
    }
    for (const link of tab.links) {
      if (link.start >= offset) {
        link.start += text.length;
        link.end += text.length;
      } else if (link.end > offset) {
        link.end += text.length;
      }
    }
    tab.text = tab.text.slice(0, offset) + text + tab.text.slice(offset);
  }

  #deleteText(tab: ModelTab, startIndex: number, endIndex: number): void {
    if (tab.table) {
      this.#replaceTableText(tab, startIndex, endIndex, "");
      return;
    }
    let start = startIndex - 1;
    let end = endIndex - 1;
    let removed = end - start;
    let fullText = `${tab.text}\n`;
    if (tab.paragraphStyles) {
      tab.paragraphStyles = withoutDeletedParagraphs(fullText, tab.paragraphStyles, start, end);
    }
    if (tab.paragraphLists) {
      tab.paragraphLists = withoutDeletedParagraphs(fullText, tab.paragraphLists, start, end);
    }
    let links: ModelTab["links"] = [];
    for (const link of tab.links) {
      if (link.end <= start) links.push(link);
      else if (link.start >= end) {
        links.push({ ...link, start: link.start - removed, end: link.end - removed });
      } else {
        if (link.start < start) links.push({ ...link, end: start });
        if (link.end > end) {
          links.push({ ...link, start, end: link.end - removed });
        }
      }
    }
    tab.links = this.#normalizeLinks(links);
    tab.text = tab.text.slice(0, start) + tab.text.slice(end);
  }

  #setBullets(
    tab: ModelTab,
    range: { startIndex: number; endIndex: number },
    preset?: string,
  ): void {
    let indexes = paragraphsIn(tab.text, range);
    if (!preset) {
      for (let index of indexes) if (tab.paragraphLists?.[index]) tab.paragraphLists[index] = "indented";
      return;
    }
    let lists = tab.paragraphLists ??= tab.text.split("\n").map(() => null);
    let first = indexes[0];
    if (first === undefined) return;
    let preceding = lists[first - 1];
    let id = isListItem(preceding) && preceding.preset === preset
      ? preceding.id : `list-${this.#nextListId++}`;
    for (let index of indexes) lists[index] = { id, preset };
  }

  #clearIndent(tab: ModelTab, range: { startIndex: number; endIndex: number }): void {
    let lists = tab.paragraphLists;
    for (let index of paragraphsIn(tab.text, range)) {
      if (lists?.[index] === "indented") lists[index] = null;
    }
  }

  #setLink(tab: ModelTab, start: number, end: number, url?: string): void {
    let links: ModelTab["links"] = [];
    for (const link of tab.links) {
      if (link.end <= start || link.start >= end) links.push(link);
      else {
        if (link.start < start) links.push({ ...link, end: start });
        if (link.end > end) links.push({ ...link, start: end });
      }
    }
    if (url) links.push({ start, end, url });
    tab.links = this.#normalizeLinks(links);
  }

  #normalizeLinks(links: ModelTab["links"]): ModelTab["links"] {
    links.sort((a, b) => a.start - b.start || a.end - b.end);
    let normalized: ModelTab["links"] = [];
    for (const link of links) {
      if (link.start === link.end) continue;
      let previous = normalized.at(-1);
      if (previous?.url === link.url && previous.end >= link.start) {
        previous.end = Math.max(previous.end, link.end);
      } else {
        normalized.push({ ...link });
      }
    }
    return normalized;
  }

  #setParagraphStyle(
    tab: ModelTab,
    range: { startIndex: number; endIndex: number },
    namedStyleType: string,
  ): void {
    let styles = tab.paragraphStyles ??=
      tab.text.split("\n").map(() => "NORMAL_TEXT");
    for (let index of paragraphsIn(tab.text, range)) styles[index] = namedStyleType;
  }

  #replaceTableText(
    tab: ModelTab, startIndex: number, endIndex: number, replacement: string,
  ): void {
    let table = tab.table;
    if (!table) throw new Error("Expected a table-backed tab");
    let start = this.#tableTextPoint(table, startIndex);
    let end = this.#tableTextPoint(table, endIndex);
    if (!start || !end || start.field !== end.field) {
      throw new Error("Fixture cannot edit table structure");
    }
    let text = table[start.field];
    table[start.field] = text.slice(0, start.offset) + replacement + text.slice(end.offset);
  }

  #tableTextPoint(table: NonNullable<ModelTab["table"]>, index: number): {
    field: "before" | "after";
    offset: number;
  } | undefined {
    let content = this.#tableBody(table).content;
    let paragraphs = [
      { field: "before" as const, element: content[1] },
      { field: "after" as const, element: content.at(-1)! },
    ];
    for (const { field, element } of paragraphs) {
      if (index >= element.startIndex && index <= element.endIndex - 1) {
        return { field, offset: index - element.startIndex };
      }
    }
  }

  #tableBody(table: NonNullable<ModelTab["table"]>): GoogleDocsTab["body"] {
    return buildTab([
      { runs: [`${table.before}\n`] },
      { table: table.rows.map(row => row.map(cell => `${cell}\n`)) },
      { runs: [`${table.after}\n`] },
    ]).body;
  }

  /** Blocks a held request until the test releases it. One hold, so a retry is never held twice. */
  async #hold(kind: RequestKind): Promise<void> {
    let held = this.#held.get(kind);
    if (!held) return;
    this.#held.delete(kind);
    held.reach();
    await held.released;
  }

  #recordMarkerCount(): void {
    this.maxMarkerCount = Math.max(this.maxMarkerCount, this.markers.size);
  }

  #tab(id: string): ModelTab {
    let tab = this.tabs.find(candidate => candidate.id === id);
    if (!tab) throw new Error(`Google Docs has no tab "${id}"`);
    return tab;
  }

  #documentTab(tab: ModelTab): unknown {
    let text = `${tab.text}\n`;
    let namedRanges: Record<string, { namedRanges: { namedRangeId: string; name: string }[] }> = {};
    for (const [namedRangeId, marker] of this.markers) {
      if (marker.tabId !== tab.id) continue;
      (namedRanges[marker.name] ??= { namedRanges: [] })
        .namedRanges.push({ namedRangeId, name: marker.name });
    }
    let body = tab.body;
    if (!body && tab.table) body = this.#tableBody(tab.table);
    let lists: GoogleDocsTab["lists"] = { ...tab.lists };
    let paragraphLists = tab.paragraphLists;
    let paragraphStyles = tab.paragraphStyles;
    // One paragraph per line, carrying whichever of the per-paragraph attributes this tab has.
    let paragraphBody = () => buildTab(tab.text.split("\n").map((paragraphText, index) => {
      let list = paragraphLists?.[index];
      return {
        runs: [`${paragraphText}\n`],
        namedStyleType: paragraphStyles?.[index],
        ...isListItem(list) ? { bullet: { listId: list.id } } : {},
      };
    }), lists).body;

    if (!body && paragraphLists) {
      for (let item of paragraphLists) {
        if (!isListItem(item)) continue;
        let level = item.preset.startsWith("BULLET_")
          ? { glyphSymbol: "●" } : { glyphType: "DECIMAL" };
        lists[item.id] ??= { listProperties: { nestingLevels: [level] } };
      }
      body = paragraphBody();
    }
    if (!body && tab.links.length > 0) {
      let textCursor = 0;
      let runs: ({ text: string; style: { link: { url: string } } } | string)[] = [];
      for (const link of tab.links) {
        if (link.start > textCursor) runs.push(text.slice(textCursor, link.start));
        runs.push({ text: text.slice(link.start, link.end), style: { link: { url: link.url } } });
        textCursor = link.end;
      }
      if (textCursor < text.length) runs.push(text.slice(textCursor));
      body = buildTab([{ runs, namedStyleType: paragraphStyles?.[0] }]).body;
    }
    if (!body && paragraphStyles) body = paragraphBody();
    body ??= buildTab([{ runs: [text] }]).body;
    return {
      tabProperties: { tabId: tab.id, title: tab.title },
      documentTab: { body, lists, namedRanges },
      childTabs: this.tabs.filter(child => child.parentId === tab.id)
        .map(child => this.#documentTab(child)),
    };
  }

  #document() {
    return {
      documentId: "doc-1",
      title: "Test document",
      ...this.editable ? { revisionId: `revision-${this.#revision}` } : {},
      tabs: this.tabs.filter(tab => tab.parentId === undefined)
        .map(tab => this.#documentTab(tab)),
    };
  }
}

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

function markdownField(label: string, value: string) {
  return { label, kind: "text", value, syntax: "markdown" };
}

function htmlField(label: string, value: string) {
  return { label, kind: "text", value, syntax: "html" };
}

/** What a failed edit authorizes: the error says whether a tab, or what is in it, exists. */
const GENERIC_READ = "Read the content of one tab of the document.";

/** A model whose main tab has `body`, which the shared model of Google Docs edits. */
function docsWithBody(body: GoogleDocsTab["body"], lists: GoogleDocsTab["lists"] = {}): DocsModel {
  let docs = new DocsModel();
  docs.setBody(MAIN_TAB, body, lists);
  docs.install();
  return docs;
}

type WriteMethod = Parameters<ReturnType<typeof hooks>["submitEdit"]>[1];

/** Call one write method of a fresh session: the action it queued, and what it resolved to. */
function edit(facet: string, method: WriteMethod, ...args: unknown[]) {
  return Promise.resolve(hooks().submitEdit(facet, method, args));
}

/** Move the clock past the snapshot's time to live, so the next read asks Google again. */
function passSnapshotTtl(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
}

/** A table as `getContent()` writes it, from the inline HTML of each cell's one paragraph. */
function tableOf(rows: string[][]): string {
  let lines = rows.map(row =>
    "  <tr>\n" + row.map(cell => `    <td><p>${cell}</p></td>\n`).join("") + "  </tr>\n");
  return `<table>\n${lines.join("")}</table>`;
}

/** One row of a table as `getContent()` writes it, without its last line break. */
function rowOf(...cells: string[]): string {
  return "  <tr>\n" + cells.map(cell => `    <td><p>${cell}</p></td>\n`).join("") + "  </tr>";
}

/** `Before`, a table of two rows and two columns, and `After`. */
function tableBody(): GoogleDocsTab["body"] {
  return buildTab([
    { runs: ["Before\n"] },
    { table: [["Task\n", "Status\n"], ["Fix login\n", "Open\n"]] },
    { runs: ["After\n"] },
  ]).body;
}

/** How the tab of `tableBody()` reads. */
const TABLE_ROWS = [["Task", "Status"], ["Fix login", "Open"]];
const TABLE_CONTENT = `Before\n\n${tableOf(TABLE_ROWS)}\n\nAfter\n`;

/** What a row, column or delete change is refused with while table `other` reads as its own. */
const twin = (op: string, table: number, other: number) =>
  `${op}: table ${table} reads the same as table ${other} of this tab (numbers in square ` +
  "brackets and where numbered lists start aside), so the change could not be kept to the " +
  "table it is meant for. Make the two differ first, for example by changing the text of a " +
  `cell with replaceText(), then call ${op}() again.`;

/** The reasons a queued change is dropped with, by what happened to its table. */
const gone = (op: string) =>
  `${op}: the table no longer reads as it did when this change was queued, or it is gone.`;
const same = (op: string) =>
  `${op}: another table of the tab now reads the same as the table this change was queued ` +
  "for, so the change can no longer be kept to it.";
const gate = (op: string) =>
  `${op}: an earlier queued change to this tab's tables no longer applies, and this change ` +
  "named its table among the tables as that one left them.";

/** What adding to a tab's tables is refused with once they would hold `cells` cells. */
const room = (op: string, cells: number) =>
  `${op}: tables, rows and columns can be added only until the tables of a tab hold 5000 ` +
  `cells in all, a cell counting once for each paragraph in it, and those of this tab would ` +
  `hold ${cells}.`;

const paragraph = (text: string) => ({ runs: [`${text}\n`] });
const heading = (text: string) => ({ runs: [`${text}\n`], namedStyleType: "HEADING_2" });
const table = (...rows: string[][]) => ({ table: rows.map(row => row.map(cell => `${cell}\n`)) });

/** A cell that reads `Revenue[<number>]`: text and a footnote reference. */
const footnoteCell = (id: string, number: string) => ({
  paragraphs: [{ runs: ["Revenue", { footnote: { id, number } }, "\n"] }],
});

/** A list whose one level is numbered, keyed `L`, and an item of it. */
const NUMBERED_LIST: GoogleDocsTab["lists"] = {
  L: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
};
const numberedItem = (text: string) => ({ runs: [`${text}\n`], bullet: { listId: "L" } });

/** A list whose one level has no marker, keyed `N`, and an item of it. */
const UNMARKED_LIST: GoogleDocsTab["lists"] = {
  N: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
};
const unmarkedItem = (text: string) => ({ runs: [`${text}\n`], bullet: { listId: "N" } });

/** Marks the paragraph at `position` in a tab's body as the anchor of a positioned image. */
function anchorImage(tab: GoogleDocsTab, position: number): GoogleDocsTab {
  let anchor = tab.body.content[position].paragraph;
  if (!anchor) throw new Error(`Element ${position} is not a paragraph`);
  anchor.positionedObjectIds = ["image-1"];
  return tab;
}

/** Two tables that read differently, between three paragraphs. */
const TWO_CONTENT = `Before\n\n${tableOf([["Task", "Owner"]])}\n\nMid\n\n` +
  `${tableOf([["Risk", "Owner"]])}\n\nAfter\n`;
function twoTables(): DocsModel {
  return docsWithBody(buildTab([
    paragraph("Before"), table(["Task", "Owner"]), paragraph("Mid"), table(["Risk", "Owner"]),
    paragraph("After"),
  ]).body);
}

/** A row queued for the first table of `twoTables()`, and one for the second. */
const queueFirst = (facet: string) =>
  edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
const queueSecond = (facet: string) =>
  edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });

/** The runs of a paragraph whose text is bold. */
const bold = (text: string) => [{ text, style: { bold: true } }, "\n"];

/**
 * A heading in bold, a table whose rows each hold a bulleted item in bold and a heading, and a
 * paragraph: every cell a new row or column is added beside starts with a list item or a
 * heading, and a table added after the first line splits a heading.
 */
function styledBody(): GoogleDocsTab["body"] {
  return buildTab([
    { runs: bold("Results"), namedStyleType: "HEADING_2" },
    { table: ["one", "two"].map(name => [
      { paragraphs: [{ runs: bold(`Item ${name}`), bullet: { listId: "L1" } }] },
      { paragraphs: [heading(`Head ${name}`)] },
    ]) },
    { runs: ["After\n"] },
  ], BULLET_LIST).body;
}

/** The two cell lines of one row of `styledBody()`'s table, as `getContent()` writes them. */
const STYLED_ROW = (name: string) => [
  '    <td><ul style="list-style-type: none">' +
    `<li>● <strong>Item ${name}</strong></li></ul></td>\n`,
  `    <td><h2>Head ${name}</h2></td>\n`,
];
/** A table from the cell lines of each of its rows. */
const STYLED_TABLE = (rows: string[][]) =>
  `<table>\n${rows.map(cells => `  <tr>\n${cells.join("")}  </tr>\n`).join("")}</table>`;
/** The line of a cell that holds one plain paragraph. */
const PLAIN = (text: string) => `    <td><p>${text}</p></td>\n`;

/** Two tables that read the same, of two rows so that a row or a column can be deleted. */
const PAIR_ROWS = [["Task", "Owner"], ["Fix login", "Ana"]];
function pairBody(): GoogleDocsTab["body"] {
  return buildTab([
    paragraph("Before"), table(...PAIR_ROWS), paragraph("Mid"), table(...PAIR_ROWS),
    paragraph("After"),
  ]).body;
}
/** The replacement that sets the first table of `pairBody()` apart, quoted from the text above. */
const FIRST_OF_PAIR = ["Before\n\n<table>\n  <tr>\n    <td><p>Task</p></td>",
  "Before\n\n<table>\n  <tr>\n    <td><p>Task (A)</p></td>"] as const;

/** A header-only table, rows queued for it, a new table that reads as it did, and rows for that. */
async function queueBehindTwin(facet: string) {
  let docs = docsWithBody(
    buildTab([paragraph("Before"), table(["Task", "Owner"]), paragraph("After")]).body);
  let first = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
  let added = await edit(
    facet, "insertTable", { rows: 1, columns: 2, cells: [["Task", "Owner"]], after: "After" });
  expect(added.returned).toBe(1);
  let second = await edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });
  return { docs, first, added, second };
}

/** Apply a queued edit and return the read before it, which the read after it must equal. */
async function appliesAsRead(
  docs: DocsModel, facet: string, { actionId }: { actionId: number },
): Promise<string> {
  let preview = await hooks().readContent(facet);
  let batches = docs.contentBatches;
  expect(await hooks().applyAction(facet, actionId)).toBeNull();
  expect(docs.contentBatches).toBe(batches + 1);
  passSnapshotTtl();
  expect(await hooks().readContent(facet)).toBe(preview);
  return preview;
}

/** Queue one edit and apply it: the read before it applied, which the read after it equals. */
async function editApplies(
  docs: DocsModel, facet: string, method: WriteMethod, ...args: unknown[]
): Promise<string> {
  return appliesAsRead(docs, facet, await edit(facet, method, ...args));
}

/** The table of `tableBody()` with its first row pinned as a header row. */
function pinnedTable(): DocsModel {
  return docsWithBody(buildTab([
    paragraph("Before"),
    { table: [["Task\n", "Status\n"], ["Fix login\n", "Open\n"]], headerRows: 1 },
    paragraph("After"),
  ]).body);
}

/** The header row counts the last batch pinned, one for each request that pinned any. */
function headerPins(docs: DocsModel): number[] {
  return docs.lastContentRequests.flatMap(request =>
    "pinTableHeaderRows" in request ? [request.pinTableHeaderRows.pinnedHeaderRowsCount] : []);
}

/** A table between two typed captions that start `1. ` and `2. `, and a paragraph. */
function captioned(): DocsModel {
  return docsWithBody(buildTab([
    paragraph("1. Revenue by region"), table(["Cell"]), paragraph("2. Revenue by product"),
    paragraph("Notes"),
  ]).body);
}

/** A tab whose one table holds 4,990 cells: 499 rows of 10. */
function fullTab(...more: Parameters<typeof buildTab>[0]): GoogleDocsTab["body"] {
  let rows = Array.from({ length: 499 }, (_, row) =>
    Array.from({ length: 10 }, (__, column) => `${row}.${column}\n`));
  return buildTab([paragraph("Before"), { table: rows }, paragraph("After"), ...more]).body;
}

/** A heading, a table and a paragraph: the heading is the tab's first paragraph. */
const titledTable = () => docsWithBody(buildTab([
  { runs: ["Title\n"], namedStyleType: "HEADING_1" }, table(["Cell"]), paragraph("After"),
]).body);
const missingParagraph = (side: string) =>
  `replaceText: the paragraph ${side} this table is missing from the tab as it reads with ` +
  "the earlier changes that are still waiting, so nothing can be added there yet. Retry once " +
  "the earlier changes to this tab have been approved or rejected.";

/** A pending record for the main tab, as storage holds one under the current rendering. */
const storedAction = (id: number, action: Record<string, unknown>) => ({
  kind: "put" as const,
  key: `pending:action:${id}`,
  value: {
    tabId: MAIN_TAB, submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, ...action,
  },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google Doc auto-approval", () => {
  const EDIT_DOCUMENT = { tag: "editDocument", label: "Document edits" };

  const ADD_TABLES = { tag: "add-document-tables", label: "Adding tables, rows and columns" };
  const DELETE_TABLES =
    { tag: "delete-document-tables", label: "Deleting tables, rows and columns" };

  it("reports text edits, adding tables and Doc comments as its auto-approvable kinds", async () => {
    expect(await hooks().docAutoApprovable("verdict-kinds")).toEqual([
      EDIT_DOCUMENT, ADD_TABLES, { tag: "docComments", label: "Google Doc comments" },
    ]);
  });

  it("lets appending and replacing text be auto-approved as document edits", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Draft");
    docs.install();

    await hooks().submitAppend("verdict-edit", "added");
    expect(await hooks().lastActionVerdict)
      .toEqual({ actionKind: EDIT_DOCUMENT, autoApprovable: true });
    await hooks().submitReplace("verdict-edit", "Draft", "Final");
    expect(await hooks().lastActionVerdict)
      .toEqual({ actionKind: EDIT_DOCUMENT, autoApprovable: true });
  });

  it("lets a cell's text be replaced as a document edit", async () => {
    docsWithBody(tableBody());

    await edit("verdict-cell", "replaceText", "<td><p>Open</p></td>", "<td><p>Done</p></td>");
    expect(await hooks().lastActionVerdict)
      .toEqual({ actionKind: EDIT_DOCUMENT, autoApprovable: true });
  });

  it("lets tables, rows and columns be added without asking", async () => {
    docsWithBody(tableBody());

    for (let [method, argument] of [
      ["insertTable", { rows: 1, columns: 1 }],
      ["insertTableRows", { table: 0 }],
      ["insertTableColumns", { table: 0 }],
    ] as const) {
      await edit("verdict-add", method, argument);
      expect(await hooks().lastActionVerdict)
        .toEqual({ actionKind: ADD_TABLES, autoApprovable: true });
    }
  });

  it("always asks before deleting rows, columns or a table", async () => {
    docsWithBody(tableBody());

    for (let [method, argument] of [
      ["deleteTableRows", { table: 0, at: 1 }],
      ["deleteTableColumns", { table: 0, at: 1 }],
      ["deleteTable", 0],
    ] as const) {
      await edit("verdict-delete", method, argument);
      expect(await hooks().lastActionVerdict)
        .toEqual({ actionKind: DELETE_TABLES, autoApprovable: false });
    }
  });
});

describe("Google Doc tables", () => {
  it("returns table cells with their row structure", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Status"], ["Alice", "Ready"]], "After");
    docs.install();

    await expect(hooks().readContent("table-read")).resolves.toContain(
      "<tr>\n    <td><p>Alice</p></td>\n    <td><p>Ready</p></td>\n  </tr>",
    );
  });

  it("refuses an append when the tab ends in a table", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ table: [["Cell\n"]] }]).body);
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("table-append", "added"),
    )).rejects.toThrow("appendText: the selected tab does not end in a paragraph");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  it("drops a queued append from replay when a table becomes last", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Before");
    docs.install();
    let actionId = await hooks().submitAppend("table-append-replay", "added");

    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { table: [["Cell\n"]] },
    ]).body);
    docs.externalEdit();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await hooks().readContent("table-append-replay")).not.toContain("added");
    expect(await hooks().applyAction("table-append-replay", actionId))
      .toContain("appendText: the selected tab does not end in a paragraph");
  });

  it("invalidates a queued append before writing when a table becomes last", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Before");
    docs.install();
    let actionId = await hooks().submitAppend("table-append-apply", "added");

    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { table: [["Cell\n"]] },
    ]).body);
    docs.externalEdit();

    expect(await hooks().applyAction("table-append-apply", actionId))
      .toContain("appendText: the selected tab does not end in a paragraph");
    expect(docs.contentBatches).toBe(0);
    expect(docs.markers.size).toBe(0);
  });

  it("applies and rereads text after a table", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Status"]], "After");
    docs.install();
    let actionId = await hooks().submitReplace("table-after", "After", "Later");

    expect(await hooks().applyAction("table-after", actionId)).toBeNull();
    expect(await hooks().readContent("table-after")).toContain("\n\nLater\n");
  });

  it("uses unchanged table context to disambiguate an edit", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Repeat", [["Owner"]], "Repeat");
    docs.install();
    let content = await hooks().readContent("table-context");
    let oldMarkdown = content.trimEnd();
    let newMarkdown = oldMarkdown.replace(/Repeat$/, "Updated");
    let actionId = await hooks().submitReplace("table-context", oldMarkdown, newMarkdown);

    expect(await hooks().readContent("table-context")).toBe(
      content.replace(/Repeat\n$/, "Updated\n"),
    );
    expect(await hooks().applyAction("table-context", actionId)).toBeNull();
    expect(await hooks().readContent("table-context")).toBe(
      content.replace(/Repeat\n$/, "Updated\n"),
    );
  });

  it("rejects an edit spanning a table before requesting approval", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Alice"]], "After");
    docs.install();
    await hooks().submitReplace("table-edit", "Before", "Long before");
    let content = await hooks().readContent("table-edit");

    await expect(Promise.resolve(
      hooks().submitReplace("table-edit", content.trimEnd(), "Updated"),
    )).rejects.toThrow(
      "replaceText: one replacement cannot change a table together with what is around it");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  // Every table change is simulated and applied through the shared model, so each case reads the
  // tab before applying and again from the document Google then holds.
  it.each<[string, WriteMethod, unknown[], string]>([
    ["a cell's text replaced", "replaceText",
      ["<td><p>Open</p></td>", "<td><p><strong>Done</strong> today</p></td>"],
      TABLE_CONTENT.replace("<p>Open</p>", "<p><strong>Done</strong> today</p>")],
    ["a table inserted after a paragraph", "insertTable",
      [{ rows: 2, columns: 2, cells: [["a", "b"], ["c"]], after: "Before" }],
      `Before\n\n${tableOf([["a", "b"], ["c", ""]])}\n\n\n\n${tableOf(TABLE_ROWS)}\n\nAfter\n`],
    ["a table inserted after a table", "insertTable",
      [{ rows: 1, columns: 1, cells: [["x"]], after: "<td><p>Open</p></td>" }],
      `Before\n\n${tableOf(TABLE_ROWS)}\n\n\n\n${tableOf([["x"]])}\n\nAfter\n`],
    ["a table inserted at the end of the tab", "insertTable",
      [{ rows: 1, columns: 2 }],
      `${TABLE_CONTENT}\n${tableOf([["", ""]])}\n\n\n`],
    ["rows inserted with text", "insertTableRows",
      [{ table: 0, at: 1, cells: [["Write docs", "Open"], ["Ship"]] }],
      `Before\n\n${tableOf([
        ["Task", "Status"], ["Write docs", "Open"], ["Ship", ""], ["Fix login", "Open"],
      ])}\n\nAfter\n`],
    ["columns inserted with text", "insertTableColumns",
      [{ table: 0, cells: [["Owner"], ["Ana"]] }],
      `Before\n\n${tableOf([
        ["Task", "Status", "Owner"], ["Fix login", "Open", "Ana"],
      ])}\n\nAfter\n`],
    ["rows deleted", "deleteTableRows", [{ table: 0, at: 1 }],
      `Before\n\n${tableOf([["Task", "Status"]])}\n\nAfter\n`],
    ["columns deleted", "deleteTableColumns", [{ table: 0, at: 0 }],
      `Before\n\n${tableOf([["Status"], ["Open"]])}\n\nAfter\n`],
    ["a table deleted", "deleteTable", [0], "Before\n\nAfter\n"],
  ])("applies %s as the read before it showed", async (name, method, args, expected) => {
    let docs = docsWithBody(tableBody());
    let facet = `table-change-${name}`;
    let { actionId } = await edit(facet, method, ...args);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(expected);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
  });

  // With nothing to copy that the Markdown shows, a fill that reset nothing would pass above. Here
  // Google copies a heading or a list item's indent into every new cell, and a heading's style
  // onto the paragraph a new table comes with, so only a fill that resets them reads plain.
  it.each<[string, WriteMethod, unknown[], string]>([
    ["a row before a row", "insertTableRows", [{ table: 0, at: 1, cells: [["Filled"]] }],
      `## **Results**\n\n${STYLED_TABLE([
        STYLED_ROW("one"), [PLAIN("Filled"), PLAIN("")], STYLED_ROW("two"),
      ])}\n\nAfter\n`],
    ["a row at the end", "insertTableRows", [{ table: 0, cells: [["", "Filled"]] }],
      `## **Results**\n\n${STYLED_TABLE([
        STYLED_ROW("one"), STYLED_ROW("two"), [PLAIN(""), PLAIN("Filled")],
      ])}\n\nAfter\n`],
    ["a column before a column", "insertTableColumns", [{ table: 0, at: 1, cells: [["Filled"]] }],
      `## **Results**\n\n${STYLED_TABLE([
        [STYLED_ROW("one")[0], PLAIN("Filled"), STYLED_ROW("one")[1]],
        [STYLED_ROW("two")[0], PLAIN(""), STYLED_ROW("two")[1]],
      ])}\n\nAfter\n`],
    ["a column at the end", "insertTableColumns", [{ table: 0, cells: [[], ["Filled"]] }],
      `## **Results**\n\n${STYLED_TABLE([
        [...STYLED_ROW("one"), PLAIN("")], [...STYLED_ROW("two"), PLAIN("Filled")],
      ])}\n\nAfter\n`],
    ["a table after a heading", "insertTable",
      [{ rows: 1, columns: 2, cells: [["Filled"]], after: "## **Results**" }],
      `## **Results**\n\n${tableOf([["Filled", ""]])}\n\n\n\n` +
      `${STYLED_TABLE([STYLED_ROW("one"), STYLED_ROW("two")])}\n\nAfter\n`],
    ["a table at the end of the tab", "insertTable",
      [{ rows: 1, columns: 2, cells: [["", "Filled"]] }],
      `## **Results**\n\n${STYLED_TABLE([STYLED_ROW("one"), STYLED_ROW("two")])}\n\nAfter\n\n` +
      `${tableOf([["", "Filled"]])}\n\n\n`],
  ])("resets what Google copies into %s", async (name, method, args, expected) => {
    let docs = docsWithBody(styledBody(), BULLET_LIST);
    docs.copyStyles = true;
    let facet = `table-styled-${name}`;
    let { actionId } = await edit(facet, method, ...args);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(expected);
    expect(indentedParagraphs(docs.bodyTab())).toEqual([]);
  });

  it("keeps the look of the cell beside a new row", async () => {
    let look: ModelTextStyle = { bold: true, fontSize: { magnitude: 18, unit: "PT" } };
    let tab = buildTab([
      { runs: ["Before\n"] },
      { table: [
        ["Region\n", "Total\n"],
        [{ paragraphs: [{ runs: [{ text: "North", style: look }, "\n"] }] }, "12\n"],
      ] },
      { runs: ["After\n"] },
    ]);
    let docs = docsWithBody(tab.body);
    docs.copyStyles = true;
    let [north] = docs.cellParagraphs(0, 1, 0);
    let centred: ModelParagraphStyle = { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" };
    for (let element of docs.tables()[0].rows[1].tableCells?.[0].content ?? []) {
      if (element.paragraph) element.paragraph.paragraphStyle = centred;
    }
    expect(alignmentAt(docs.bodyTab(), north)).toBe("CENTER");
    let facet = "table-look";

    let { actionId } = await edit(
      facet, "insertTableRows", { table: 0, cells: [["South", "7"]] });
    let preview = await hooks().readContent(facet);
    expect(preview).toContain(
      `${rowOf("<strong>North</strong>", "12")}\n${rowOf("South", "7")}\n</table>`);

    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
    // The row, then the text of each new cell and its four fields cleared, last cell first: a
    // cell beside normal text keeps its paragraph as Google made it.
    expect(docs.lastContentRequests.map(request => Object.keys(request))).toEqual([
      ["insertTableRow"], ["insertText"], ["updateTextStyle"], ["insertText"], ["updateTextStyle"],
    ]);
    expect(docs.lastContentRequests.flatMap(request =>
      "insertText" in request ? [request.insertText.text] : [])).toEqual(["7", "South"]);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);

    let [south] = docs.cellParagraphs(0, 2, 0);
    expect(docs.cellText(0, 2, 0)).toBe("South");
    expect(alignmentAt(docs.bodyTab(), south)).toBe("CENTER");
    expect(fontSizeAt(docs.bodyTab(), south)).toBe(18);
    let [text] = docs.cellRuns(0, 2, 0);
    expect(text).toMatchObject({ content: "South" });
    expect(text.textStyle.bold).toBeUndefined();
  });

  it("shows the approval card of a row insert", async () => {
    docsWithBody(tableBody());
    let cells = [["Ship docs", "Open"]];

    await edit("table-row-card", "insertTableRows", { table: 0, cells });

    expect(await hooks().lastActionTitle).toBe("Insert table rows in Google Doc");
    expect(await hooks().lastActionDescription).toBe(
      'Insert 1 row in a table of tab "Main" (tab-1), after its last row. ' +
      "It was table 1 of the tab when this change was requested.");
    expect(await hooks().lastActionFields).toEqual([
      { label: "New rows", kind: "json", value: JSON.stringify(cells, null, 2) },
      markdownField("Text before the table", "Before"),
      htmlField("First row of the table", rowOf("Task", "Status")),
      htmlField("Row above the new rows", rowOf("Fix login", "Open")),
    ]);
  });

  it("shows a cell replacement's card as table HTML", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-cell-card";

    let { actionId } = await edit(
      facet, "replaceText", "<td><p>Open</p></td>", "<td><p>**Done**</p></td>");

    expect(await hooks().lastActionTitle).toBe("Edit Google Doc");
    expect(await hooks().lastActionDescription).toBe(
      'Replace text in a table of tab "Main" (tab-1). The values below are the table\'s HTML: ' +
      "Markdown syntax in them is written to the cells as typed.");
    expect(await hooks().lastActionFields).toEqual([
      htmlField("Old", "<td><p>Open</p></td>"),
      htmlField("New", "<td><p>**Done**</p></td>"),
    ]);
    expect(await hooks().readContent(facet)).toContain("<td><p>**Done**</p></td>");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.cellText(0, 1, 1)).toBe("**Done**");

    // The same strings outside a table are Markdown, and the card says so.
    await edit(facet, "replaceText", "After", "**Later**");
    expect(await hooks().lastActionDescription).toBe('Replace text in tab "Main" (tab-1).');
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "After"),
      markdownField("New", "**Later**"),
    ]);
  });

  it("returns where a new table is", async () => {
    docsWithBody(tableBody());
    let facet = "table-position";

    let first = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["First"]], after: "Before" });
    expect(first.returned).toBe(0);
    let last = await edit(facet, "insertTable", { rows: 1, columns: 1, cells: [["Last"]] });
    expect(last.returned).toBe(2);

    await edit(facet, "insertTableRows", { table: last.returned, cells: [["Row"]] });
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${tableOf([["First"]])}\n\n\n\n${tableOf(TABLE_ROWS)}\n\nAfter\n\n` +
      `${tableOf([["Last"], ["Row"]])}\n\n\n`);
  });

  it("replays changes queued one after another on one table", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-chain";

    let added = await edit(
      facet, "insertTable", { rows: 1, columns: 2, cells: [["Name", "Total"]] });
    let rows = await edit(
      facet, "insertTableRows", { table: added.returned, cells: [["Ana", "3"]] });
    let cell = await edit(
      facet, "replaceText", "<td><p>Ana</p></td>", "<td><p><em>Ana</em></p></td>");
    let preview = await hooks().readContent(facet);
    expect(preview).toBe(
      `${TABLE_CONTENT}\n${tableOf([["Name", "Total"], ["<em>Ana</em>", "3"]])}\n\n\n`);

    for (let { actionId } of [added, rows, cell]) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(3);
  });

  it("drops changes built on a rejected one", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-reject-chain";
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["Ship docs", "Open"]] });
    let cell = await edit(
      facet, "replaceText", "<td><p>Ship docs</p></td>", "<td><p>Ship the docs</p></td>");

    await hooks().rejectAction(facet, rows.actionId);

    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT);
    expect(await hooks().applyAction(facet, cell.actionId))
      .toContain("replaceText: oldMarkdown was not found in the current simulated tab");
    expect(docs.contentBatches).toBe(0);
  });

  it("follows a table past a rejected insertion above it", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-reject-above";
    let above = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["New"]], after: "Before" });
    let rows = await edit(facet, "insertTableRows", { table: 1, cells: [["Ship docs", "Open"]] });

    // The number is the one thing on the card the rejection makes stale, so it is worded as past;
    // the text before the table and its first row are what name the table.
    expect(await hooks().lastActionDescription).toBe(
      'Insert 1 row in a table of tab "Main" (tab-1), after its last row. ' +
      "It was table 2 of the tab when this change was requested.");
    expect((await hooks().lastActionFields).slice(1, 3)).toEqual([
      markdownField("Text before the table", "Before"),
      htmlField("First row of the table", rowOf("Task", "Status")),
    ]);

    await hooks().rejectAction(facet, above.actionId);

    let preview = `Before\n\n${tableOf([...TABLE_ROWS, ["Ship docs", "Open"]])}\n\nAfter\n`;
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(1);
  });

  it("refuses a row, column or delete change while another table reads the same", async () => {
    let docs = docsWithBody(pairBody());
    let facet = "table-twin-refused";

    for (let [method, argument, target, other] of [
      ["insertTableRows", { table: 0, cells: [["a", "b"]] }, 0, 1],
      ["deleteTable", 1, 1, 0],
      ["insertTableColumns", { table: 0 }, 0, 1],
      ["deleteTableRows", { table: 0, at: 1 }, 0, 1],
      ["deleteTableColumns", { table: 0, at: 1 }, 0, 1],
    ] as const) {
      await expect(edit(facet, method, argument)).rejects.toThrow(twin(method, target, other));
      expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
      expect(await hooks().lastActionDescription).toBe("");
    }
    expect(docs.contentBatches).toBe(0);
  });

  it("takes the change once a cell sets the two tables apart", async () => {
    let docs = docsWithBody(pairBody());
    let facet = "table-twin-apart";

    let cell = await edit(facet, "replaceText", ...FIRST_OF_PAIR);
    expect(await hooks().lastActionVerdict).toMatchObject({ actionKind: { tag: "editDocument" } });
    let first = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
    let second = await edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });

    let preview = await hooks().readContent(facet);
    expect(preview).toBe(
      `Before\n\n${tableOf([["Task (A)", "Owner"], ["Fix login", "Ana"], ["a", "b"]])}\n\n` +
      `Mid\n\n${tableOf([...PAIR_ROWS, ["c", "d"]])}\n\nAfter\n`);
    for (let { actionId } of [cell, first, second]) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(3);
  });

  it("adds a second table that reads like the first", async () => {
    docsWithBody(buildTab([paragraph("Before"), paragraph("After")]).body);
    let facet = "table-twin-added";
    let header = { rows: 1, columns: 2, cells: [["Task", "Owner"]] };

    expect((await edit(facet, "insertTable", { ...header, after: "Before" })).returned).toBe(0);
    expect((await edit(facet, "insertTable", { ...header, after: "After" })).returned).toBe(1);
    let headerTable = tableOf([["Task", "Owner"]]);
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${headerTable}\n\n\n\nAfter\n\n${headerTable}\n\n\n`);

    let rows = { table: 0, cells: [["a", "b"]] };
    await expect(edit(facet, "insertTableRows", rows))
      .rejects.toThrow(twin("insertTableRows", 0, 1));
    await edit(facet, "replaceText", ...FIRST_OF_PAIR);
    await edit(facet, "insertTableRows", rows);
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${tableOf([["Task (A)", "Owner"], ["a", "b"]])}\n\n\n\nAfter\n\n` +
      `${headerTable}\n\n\n`);
  });

  // Compared as they read, the two tables differ and the row is queued for the first. A text edit
  // that takes `Checklist` out of the list, approved before it, then leaves the second table as
  // the one that starts at 2: the row would go there with nothing rejected and nobody else editing.
  it("refuses a row for one of two tables that differ only in a list number", async () => {
    let item = numberedItem;
    let step = { table: [[{ paragraphs: [item("Step")] }, "Notes\n"]] };
    let docs = docsWithBody(buildTab([
      item("Checklist"), heading("Team A"), step, heading("Team B"), step, paragraph("End"),
    ], NUMBERED_LIST).body, NUMBERED_LIST);
    let facet = "table-twin-list-number";

    let content = await hooks().readContent(facet);
    let firstCell = "<table>\n  <tr>\n    <td><ol";
    expect(content).toContain(`## Team A\n\n${firstCell} start="2"><li>Step</li></ol></td>`);
    expect(content).toContain(`## Team B\n\n${firstCell} start="3"><li>Step</li></ol></td>`);

    await expect(edit(facet, "insertTableRows", { table: 0, cells: [["x", "y"]] }))
      .rejects.toThrow(twin("insertTableRows", 0, 1));
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  it("refuses a row for one of two tables that differ only in a footnote number", async () => {
    docsWithBody(buildTab([
      paragraph("Intro"), heading("Q1"), { table: [[footnoteCell("f1", "1")]] },
      heading("Q2"), { table: [[footnoteCell("f2", "2")]] }, paragraph("End"),
    ]).body);
    let facet = "table-twin-footnote";

    let content = await hooks().readContent(facet);
    expect(content).toContain("<td><p>Revenue[1]</p></td>");
    expect(content).toContain("<td><p>Revenue[2]</p></td>");

    await expect(edit(facet, "insertTableRows", { table: 1, cells: [["x"]] }))
      .rejects.toThrow(twin("insertTableRows", 1, 0));
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("invalidates a change when a collaborator makes another table read the same", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-collaborator-twin";
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });

    docs.externalBody(MAIN_TAB, buildTab([
      paragraph("Before"), table(...TABLE_ROWS), paragraph("After"), table(...TABLE_ROWS),
      paragraph(""),
    ]).body);
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(`${TABLE_CONTENT}\n${tableOf(TABLE_ROWS)}\n\n\n`);
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  it("invalidates a change when a rejection leaves another table reading the same", async () => {
    let facet = "table-rejection-twin";
    let { docs, first, second } = await queueBehindTwin(facet);

    await hooks().rejectAction(facet, first.actionId);

    let headerTable = tableOf([["Task", "Owner"]]);
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${headerTable}\n\nAfter\n\n${headerTable}\n\n\n`);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // Left to one replay, the two rejections cancel out: one table reads as the rows recorded, the
  // one that was there all along, and the rows meant for the new table go to it.
  it("settles each rejection before the next", async () => {
    let facet = "table-rejections-in-turn";
    let { docs, first, added, second } = await queueBehindTwin(facet);

    await hooks().rejectAction(facet, first.actionId);
    await hooks().rejectAction(facet, added.actionId);

    expect(await hooks().applyAction(facet, second.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // The second rejection is replayed over the snapshot the first one kept.
  it("follows a table past two rejected insertions", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-two-rejections";
    let one = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["One"]], after: "Before" });
    let two = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["Two"]], after: "Before" });
    let rows = await edit(facet, "insertTableRows", { table: 2, cells: [["a", "b"]] });

    await hooks().rejectAction(facet, one.actionId);
    await hooks().rejectAction(facet, two.actionId);

    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${tableOf([...TABLE_ROWS, ["a", "b"]])}\n\nAfter\n`);
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
  });

  it("drops the table changes behind one that a collaborator's edit stops", async () => {
    let docs = twoTables();
    let facet = "table-gate-read";
    let first = await queueFirst(facet);
    let second = await queueSecond(facet);

    docs.externalCellEdit(0, 0, 0, "Chore");
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(TWO_CONTENT.replace("Task", "Chore"));
    expect(await hooks().applyAction(facet, first.actionId)).toContain(gone("insertTableRows"));
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    await hooks().rejectAction(facet, first.actionId);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  it("drops the table changes behind one that fails when it is approved", async () => {
    let docs = twoTables();
    let facet = "table-gate-apply";
    let first = await queueFirst(facet);
    let second = await queueSecond(facet);

    docs.externalCellEdit(0, 0, 0, "Chore");

    // Its requests are built against the document as it reads when the change is approved.
    expect(await hooks().applyAction(facet, first.actionId)).toBe(gone("insertTableRows"));
    await hooks().rejectAction(facet, first.actionId);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // Without the gate the fourth edit is the next pending one, finds exactly one table reading as
  // it recorded, the one under `## X`, and adds the row meant for the other.
  it("keeps a row off the other of two tables when the edit that set them apart is rejected", async () => {
    let docs = docsWithBody(buildTab([
      heading("X"), table(["Task", "Owner"]), heading("Y"), table(["Task", "Owner"]),
      paragraph("End"),
    ]).body);
    let facet = "table-gate-example";
    let task = "\n\n<table>\n  <tr>\n    <td><p>Task</p></td>";
    let done = task.replace("Task", "Task (done)");

    let cellOfY = await edit(facet, "replaceText", `## Y${task}`, `## Y${done}`);
    let rowsOfX = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
    let cellOfX = await edit(facet, "replaceText", `## X${task}`, `## X${done}`);
    let rowsOfY = await edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });
    expect(await hooks().readContent(facet)).toBe(
      `## X\n\n${tableOf([["Task (done)", "Owner"], ["a", "b"]])}\n\n` +
      `## Y\n\n${tableOf([["Task (done)", "Owner"], ["c", "d"]])}\n\nEnd\n`);

    await hooks().rejectAction(facet, cellOfY.actionId);

    expect(await hooks().applyAction(facet, rowsOfX.actionId)).toContain(same("insertTableRows"));
    expect(await hooks().applyAction(facet, cellOfX.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, rowsOfY.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(1);
    expect(docs.cellText(0, 0, 0)).toBe("Task (done)");
    expect(docs.tables()[0].rows).toHaveLength(1);
  });

  // The held snapshot is not always one the queue was replayed over: listing the tabs, or naming
  // a tab the document lacks, stores a newer read and replays nothing. With one replay after the
  // removal, over that read, exactly one table reads as `rows` recorded, the first, and approving
  // `rows` would write the row there.
  it.each<[string, (facet: string) => Promise<unknown>]>([
    ["listing the tabs", facet => Promise.resolve(hooks().listTabs(facet))],
    ["naming a tab the document lacks",
      facet => Promise.resolve(hooks().readContent(facet, "no-such-tab")).catch(() => {})],
  ])("settles what a read by %s brought before it settles a rejection", async (name, refresh) => {
    let docs = docsWithBody(pairBody());
    let facet = `table-reject-held-${name}`;
    let cell = await edit(facet, "replaceText", ...FIRST_OF_PAIR);
    let rows = await edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });
    let rowsKey = `pending:action:${rows.actionId}`;
    expect(await hooks().readContent(facet)).toContain(
      `Mid\n\n${tableOf([...PAIR_ROWS, ["c", "d"]])}`);
    let stored = await hooks().storedValueJsonLength(facet, rowsKey);

    docs.externalCellEdit(1, 0, 0, "Chore");
    passSnapshotTtl();
    await refresh(facet);
    // The edited document is the held snapshot, and nothing was replayed over it.
    expect(docs.documentFetches).toBe(2);
    expect(await hooks().storedValueJsonLength(facet, rowsKey)).toBe(stored);

    await hooks().rejectAction(facet, cell.actionId);

    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gone("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
    expect(docs.tables()[0].rows).toHaveLength(2);
  });

  const storedRows =
    { type: "insertTableRows", at: 2, cells: [["a", "b"]], expected: tableOf(TABLE_ROWS) };

  it("drops later table changes when a rejection has no read to replay over", async () => {
    docsWithBody(tableBody());
    let facet = "table-reject-unread";
    await hooks().applyStorage(facet, [
      storedAction(1, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      storedAction(2, storedRows),
      storedAction(3, { type: "insertTable", rows: 1, columns: 1, cells: [[""]] }),
      storedAction(4, { type: "replaceText", oldMarkdown: "After", newMarkdown: "Later" }),
    ]);
    let lengths = async () => [
      await hooks().storedValueJsonLength(facet, "pending:action:3"),
      await hooks().storedValueJsonLength(facet, "pending:action:4"),
    ];
    let before = await lengths();

    await hooks().rejectAction(facet, 1);

    expect(await hooks().applyAction(facet, 2)).toContain(gate("insertTableRows"));
    // Neither a new table nor a text edit names a table by how it read: neither carries a reason.
    expect(await lengths()).toEqual(before);
  });

  it("replays nothing when no later change names a table", async () => {
    docsWithBody(tableBody());
    let facet = "table-reject-text-only";
    let first = await edit(facet, "replaceText", "After", "Later");
    let second = await edit(facet, "replaceText", "Later", "Latest");
    await edit(facet, "insertTable", { rows: 1, columns: 1 });
    let key = `pending:action:${second.actionId}`;
    let length = await hooks().storedValueJsonLength(facet, key);

    await hooks().rejectAction(facet, first.actionId);

    // No reason was stored: the rejection replayed nothing. The next read's replay does.
    expect(await hooks().storedValueJsonLength(facet, key)).toBe(length);
    await hooks().readContent(facet);
    expect(await hooks().storedValueJsonLength(facet, key)).toBeGreaterThan(length ?? 0);
  });

  it("checks the revision after a rejection", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "reject-revision-check";
    let actionId = await hooks().submitAppend(facet, "added");
    expect(await hooks().readContent(facet)).toBe("base\n\nadded\n");
    expect(docs.documentFetches).toBe(1);
    let snapshot = await hooks().storedTimes(facet, "docSnapshot");

    await hooks().rejectAction(facet, actionId);

    // The rejection wrote the mark, not the snapshot.
    expect(snapshot).toEqual({ fetchedAt: expect.any(Number) });
    expect(await hooks().storedTimes(facet, "docSnapshot")).toEqual(snapshot);
    expect(await hooks().storedTimes(facet, "docSnapshotCheck"))
      .toEqual({ fetchedAt: snapshot?.fetchedAt, checkedAt: 0 });
    expect(await hooks().readContent(facet)).toBe("base\n");
    expect(docs.revisionProbes).toBe(1);
    expect(docs.documentFetches).toBe(1);

    // With a collaborator's edit since, the same read fetches the document again.
    let edited = "reject-revision-moved";
    let editedId = await hooks().submitAppend(edited, "added");
    await hooks().rejectAction(edited, editedId);
    docs.externalEdit(MAIN_TAB, "collaborator edit");
    expect(await hooks().readContent(edited)).toBe("collaborator edit\n");
    expect(docs.revisionProbes).toBe(2);
    expect(docs.documentFetches).toBe(3);
  });

  // Stored again after the check, the snapshot would carry a new `fetchedAt`; a value read back
  // from storage is written larger than it first was, so that rewrite doubles a stored table map.
  it("keeps the stored snapshot as it was fetched when the revision is unchanged", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "snapshot-stored-once";
    await hooks().readContent(facet);
    expect(docs.documentFetches).toBe(1);
    let snapshot = await hooks().storedTimes(facet, "docSnapshot");
    let length = await hooks().storedValueJsonLength(facet, "docSnapshot");
    expect(snapshot).toEqual({ fetchedAt: expect.any(Number) });
    expect(await hooks().storedTimes(facet, "docSnapshotCheck")).toBeUndefined();

    passSnapshotTtl();
    await hooks().readContent(facet);

    expect(docs.revisionProbes).toBe(1);
    expect(docs.documentFetches).toBe(1);
    expect(await hooks().storedTimes(facet, "docSnapshot")).toEqual(snapshot);
    expect(await hooks().storedValueJsonLength(facet, "docSnapshot")).toBe(length);
    let mark = await hooks().storedTimes(facet, "docSnapshotCheck");
    expect(mark).toEqual({ fetchedAt: snapshot?.fetchedAt, checkedAt: expect.any(Number) });
    expect(mark?.checkedAt).toBeGreaterThan(snapshot?.fetchedAt ?? Infinity);

    // The mark is what made the snapshot current: a read at once asks Google nothing.
    await hooks().readContent(facet);
    expect(docs.revisionProbes).toBe(1);
  });

  it("ignores a mark left by another snapshot", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "snapshot-foreign-mark";
    await hooks().readContent(facet);
    await hooks().applyStorage(facet, [{
      kind: "put", key: "docSnapshotCheck",
      value: { fetchedAt: 1, checkedAt: Date.now() + 3_600_000 },
    }]);

    passSnapshotTtl();
    await hooks().readContent(facet);

    // The mark names no stored snapshot, so the snapshot's own `fetchedAt` decides.
    expect(docs.revisionProbes).toBe(1);
  });

  // Were the record removed before a later step threw, the overseer would still hold an action
  // that this gatekeeper answers `Unknown pending Google Doc action` for, at every retry.
  it("leaves the record in place when a rejection cannot be settled", async () => {
    docsWithBody(tableBody());
    let facet = "table-reject-unsettled";
    await hooks().applyStorage(facet, [
      storedAction(1, { type: "deleteTableRows", at: 1, count: 1, expected: tableOf(TABLE_ROWS) }),
      storedAction(2, storedRows),
      // A snapshot that passes for one and cannot be replayed over: its tab has no source map.
      {
        kind: "put", key: "docSnapshot",
        value: {
          formatVersion: MARKDOWN_RENDERING_VERSION, title: "Test document", tabs: [{}],
          fetchedAt: Date.now(),
        },
      },
    ]);
    let lengths = async () => [
      await hooks().storedValueJsonLength(facet, "pending:action:1"),
      await hooks().storedValueJsonLength(facet, "pending:action:2"),
    ];
    let before = await lengths();

    await expect(Promise.resolve(hooks().rejectAction(facet, 1))).rejects.toThrow();
    expect(await lengths()).toEqual(before);

    // With no snapshot at all, the same rejection settles.
    await hooks().applyStorage(facet, [{ kind: "put", key: "docSnapshot", value: 0 }]);
    await hooks().rejectAction(facet, 1);
    expect(await hooks().storedValueJsonLength(facet, "pending:action:1")).toBeUndefined();
    expect(await hooks().applyAction(facet, 2)).toContain(gate("insertTableRows"));
  });

  it("invalidates a change whose table a collaborator edited", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-collaborator-edit";
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });

    docs.externalCellEdit(0, 1, 1, "Closed");
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT.replace("Open", "Closed"));
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gone("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // The text edit takes the item out of the list, so the cell's item becomes the list's first.
  // What the read showed for the table until then was the old number, and the change recorded
  // against it is dropped, not applied to a table that reads differently from its card.
  it("invalidates a table change when an earlier text edit moves a list number its table shows", async () => {
    let item = numberedItem;
    let docs = docsWithBody(buildTab([
      item("one"), { table: [[{ paragraphs: [item("two")] }, "Notes\n"]] }, paragraph("After"),
    ], NUMBERED_LIST).body, NUMBERED_LIST);
    let facet = "table-list-number-moved";
    // The table's one row, as it reads while its cell's item is the list's second.
    let second = "<table>\n  <tr>\n" +
      '    <td><ol start="2"><li>two</li></ol></td>\n    <td><p>Notes</p></td>\n  </tr>\n';
    expect(await hooks().readContent(facet)).toBe(`1. one\n\n${second}</table>\n\nAfter\n`);

    let text = await edit(facet, "replaceText", "1. one", "one");
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["x", "y"]] });
    expect(await hooks().readContent(facet)).toBe(
      `one\n\n${second}${rowOf("x", "y")}\n</table>\n\nAfter\n`);

    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(
      `one\n\n${second.replace(' start="2"', "")}</table>\n\nAfter\n`);
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gone("insertTableRows"));
    expect(docs.contentBatches).toBe(1);
  });

  it("replaces text beside a character Google would strip", async () => {
    // A private-use bullet, as a Word import leaves one: Google strips it from inserted text.
    let bullet = "\uF0B7";
    let docs = docsWithBody(
      buildTab([paragraph("Before"), table([`${bullet} Item one`]), paragraph("After")]).body);
    let facet = "table-kept-stripped-character";

    let { actionId } = await edit(facet, "replaceText",
      `<td><p>${bullet} Item one</p></td>`, `<td><p>${bullet} Item two</p></td>`);

    expect(await hooks().readContent(facet)).toContain(`<td><p>${bullet} Item two</p></td>`);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.cellText(0, 0, 0)).toBe(`${bullet} Item two`);
  });

  // The shared model refuses a deletion that starts between the halves of a surrogate pair, as
  // Google does, so a trim that kept the shared half of the two emoji fails here.
  it("replaces one status emoji with another that shares its high surrogate", async () => {
    let docs = docsWithBody(
      buildTab([paragraph("Before"), table(["🟢 On track"]), paragraph("After")]).body);
    let facet = "table-emoji";

    let { actionId } = await edit(facet, "replaceText",
      "<td><p>🟢 On track</p></td>", "<td><p>🔴 Blocked</p></td>");

    expect(await hooks().readContent(facet)).toContain("<td><p>🔴 Blocked</p></td>");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.cellText(0, 0, 0)).toBe("🔴 Blocked");
  });

  const MERGED = "this table has merged cells, so its rows and columns cannot be changed.";
  const BETWEEN_ITEMS = "insertTable: a table cannot be added between two items of a list. " +
    "Name the list's last item instead.";
  const POSITIONED_IMAGE = "insertTable: a table cannot be added beside a paragraph that holds " +
    "a positioned image. Name other text for the table to follow.";

  // Each is refused when it is called, with nothing queued. The last two are seen only in the
  // document, which is asked because nothing is queued before them.
  it.each<[string, () => GoogleDocsTab, [WriteMethod, unknown[], string][]]>([
    ["refuses row and column changes on a table with merged cells",
      () => buildTab([paragraph("Before"), { table: [
        [{ paragraphs: [paragraph("Head")], tableCellStyle: { columnSpan: 2 } }, "\n"],
        ["a\n", "b\n"],
      ] }, paragraph("After")]),
      [
        ["insertTableRows", [{ table: 0 }], `insertTableRows: ${MERGED}`],
        ["insertTableColumns", [{ table: 0 }], `insertTableColumns: ${MERGED}`],
        ["deleteTableRows", [{ table: 0, at: 1 }], `deleteTableRows: ${MERGED}`],
        ["deleteTableColumns", [{ table: 0, at: 1 }], `deleteTableColumns: ${MERGED}`],
      ]],
    ["refuses a replacement in a merged cell",
      () => buildTab([paragraph("Before"), { table: [
        [{ paragraphs: [paragraph("Head")], tableCellStyle: { columnSpan: 2 } }, "\n"],
        ["a\n", "b\n"],
      ] }, paragraph("After")]),
      [["replaceText", ["<p>Head</p>", "<p>Top</p>"],
        "replaceText: a merged cell, or a cell one covers, cannot be edited."]]],
    ["refuses a replacement in a cell holding a table",
      () => buildTab([paragraph("Before"), { table: [[
        { paragraphs: [paragraph("Outer"), table(["Inner"]), paragraph("")] },
      ]] }, paragraph("After")]),
      [["replaceText", ["<p>Outer</p>", "<p>Changed</p>"],
        "replaceText: a cell that holds another table cannot be edited."]]],
    ["refuses a table between two list items",
      () => buildTab([
        { runs: ["one\n"], bullet: { listId: "L1" } },
        { runs: ["two\n"], bullet: { listId: "L1" } },
      ], BULLET_LIST),
      [["insertTable", [{ rows: 1, columns: 1, after: "- one" }], BETWEEN_ITEMS]]],
    ["refuses deleting a row of numbered items while the numbered list goes on",
      () => buildTab([
        paragraph("Before"),
        { table: [[{ paragraphs: [numberedItem("Step")] }, "x\n"], ["y\n", "z\n"]] },
        numberedItem("Next"), paragraph("After"),
      ], NUMBERED_LIST),
      [["deleteTableRows", [{ table: 0, at: 0 }],
        "deleteTableRows: what would be deleted holds items of a numbered list, and a numbered " +
        "list follows it in the tab, which the deletion could renumber. That is not supported."]]],
    ["refuses deleting a row that holds a footnote",
      () => buildTab([
        paragraph("Before"), { table: [[footnoteCell("f1", "1")], ["x\n"]] }, paragraph("After"),
      ]),
      [["deleteTableRows", [{ table: 0, at: 0 }],
        "deleteTableRows: what would be deleted holds a footnote. Deleting a footnote renumbers " +
        "those after it, which is not supported."]]],
    ["refuses a table after an empty paragraph holding a positioned image",
      () => anchorImage(buildTab([paragraph("Before"), paragraph(""), paragraph("After")]), 2),
      [["insertTable", [{ rows: 1, columns: 1, after: "[Image]" }], POSITIONED_IMAGE]]],
    ["refuses a table after a table that a paragraph holding a positioned image follows",
      () => anchorImage(buildTab([paragraph("Before"), table(["Cell"]), paragraph("Caption")]), 3),
      [["insertTable", [{ rows: 1, columns: 1, after: "<td><p>Cell</p></td>" }],
        POSITIONED_IMAGE]]],
    ["refuses deleting a table between two items of a list with no marker",
      () => buildTab([unmarkedItem("A"), table(["Cell"]), unmarkedItem("B")], UNMARKED_LIST),
      [["deleteTable", [0],
        "deleteTable: this table sits between two items of one list, which deleting it would " +
        "join. That is not supported."]]],
    ["refuses a table after an item of a list with no marker whose next item is empty",
      () => buildTab([unmarkedItem("A"), unmarkedItem(""), paragraph("End")], UNMARKED_LIST),
      [["insertTable", [{ rows: 1, columns: 1, after: "A" }], BETWEEN_ITEMS]]],
  ])("%s", async (name, build, calls) => {
    let tab = build();
    let docs = docsWithBody(tab.body, tab.lists);
    let facet = `table-${name}`;

    for (let [method, args, message] of calls) {
      await expect(edit(facet, method, ...args)).rejects.toThrow(message);
      expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
      expect(await hooks().lastActionDescription).toBe("");
    }
    expect(docs.contentBatches).toBe(0);
  });

  // The paragraph is protected because it holds a chip, and its own text reads as the mark of a
  // positioned image. The document says which it is.
  it("adds a table beside a paragraph that only reads as holding a positioned image", async () => {
    let docs = docsWithBody(buildTab([
      { runs: ["[Image] ", { date: "Sep 16, 2026" }, "\n"] }, paragraph("After"),
    ]).body);

    let preview = await editApplies(docs, "table-typed-image-mark", "insertTable",
      { rows: 1, columns: 1, after: "[Image] Sep 16, 2026" });

    expect(preview).toBe(`[Image] Sep 16, 2026\n\n${tableOf([[""]])}\n\n\n\nAfter\n`);
  });

  // Cut at its line break, a paragraph keeps its positioned image on its text, before the table.
  it("adds a table after a paragraph whose text wraps a positioned image", async () => {
    let docs = docsWithBody(anchorImage(buildTab([paragraph("Figure one")]), 1).body);

    let preview = await editApplies(docs, "table-wrapped-image", "insertTable",
      { rows: 1, columns: 1, after: "[Image] Figure one" });

    expect(preview).toBe(`[Image] Figure one\n\n${tableOf([[""]])}\n\n\n`);
  });

  it("refuses a row beside a row whose cell holds only a dropdown", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"),
      { table: [
        ["Task\n", "Status\n"],
        ["Fix login\n", { paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] }],
      ] },
      paragraph("After"),
    ]).body);
    let facet = "table-lone-dropdown";
    // A lone dropdown shows nothing: the cell reads as an empty one.
    expect(await hooks().readContent(facet)).toContain(rowOf("Fix login", ""));

    await expect(edit(facet, "insertTableRows", { table: 0, cells: [["Ship docs", ""]] }))
      .rejects.toThrow(
        "insertTableRows: row 1 of this table, counting from 0, has a cell that holds a " +
        "dropdown or other smart chips and no text, and Google Docs may copy those into a row " +
        "added beside it. That is not supported: add the row in Google Docs.");
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);

    // A row beside the other row copies no chip, and a new column never copies one.
    await editApplies(docs, facet, "insertTableRows", { table: 0, at: 0, cells: [["a", "b"]] });
    let preview = await editApplies(
      docs, facet, "insertTableColumns", { table: 0, cells: [["x"], ["Owner"], ["Ana"]] });
    expect(preview).toContain(
      `${rowOf("a", "b", "x")}\n${rowOf("Task", "Status", "Owner")}\n` +
      rowOf("Fix login", "", "Ana"));
  });

  // The fields of a deletion show its cells as the content reads, where a dropdown shows nothing.
  it("says on a deletion's card that what is deleted holds a dropdown", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"),
      { table: [
        ["Task\n", "Status\n"],
        ["Fix login\n", { paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] }],
      ] },
      paragraph("After"),
    ]).body);
    let facet = "table-deleted-dropdown";

    let { actionId } = await edit(facet, "deleteTableColumns", { table: 0, at: 1 });
    expect(await hooks().lastActionDescription).toBe(
      'Delete column 2 of a table of tab "Main" (tab-1), with everything in it. What is deleted ' +
      "holds a dropdown or other smart chips that are not shown below: a cell that holds " +
      "nothing else reads as empty. It was table 1 of the tab when this change was requested.");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.tables()[0].rows.map(row => row.tableCells?.length)).toEqual([1, 1]);

    // What is left holds no chip, and the card of its deletion says nothing of one.
    await edit(facet, "deleteTable", 0);
    expect(await hooks().lastActionDescription).toBe(
      'Delete a table of tab "Main" (tab-1), with everything in it. It was table 1 of the tab ' +
      "when this change was requested.");
  });

  // A dropdown put into a cell changes nothing a read shows, so the table still reads as the
  // deletion recorded it, and the deletion's card said nothing of a chip.
  it("invalidates a queued deletion when what it removes comes to hold a dropdown", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"), table(["Task", "Status"], ["Fix login", ""]), paragraph("After"),
    ]).body);
    let facet = "table-dropdown-since";
    let rows = await edit(facet, "deleteTableRows", { table: 0, at: 1 });
    expect(await hooks().lastActionDescription).not.toContain("chips");
    let queued = await hooks().readContent(facet);
    expect(queued).not.toContain("Fix login");

    docs.externalBody(MAIN_TAB, buildTab([
      paragraph("Before"),
      { table: [
        ["Task\n", "Status\n"],
        ["Fix login\n", { paragraphs: [{ runs: [{ dropdown: "Blocked" }, "\n"] }] }],
      ] },
      paragraph("After"),
    ]).body);

    expect(await hooks().applyAction(facet, rows.actionId)).toContain(
      "deleteTableRows: what would be deleted has come to hold a dropdown or other smart " +
      "chips, which getContent() does not show, since this change was queued.");
    expect(docs.contentBatches).toBe(0);
    expect(docs.tables()[0].rows).toHaveLength(2);
    expect(await hooks().readContent(facet)).toContain(rowOf("Fix login", ""));

    // Requested again, the card says what goes with the row, and the row is deleted.
    let again = await edit(facet, "deleteTableRows", { table: 0, at: 1 });
    expect(await hooks().lastActionDescription).toContain("chips that are not shown below");
    expect(await hooks().applyAction(facet, again.actionId)).toBeNull();
    expect(docs.tables()[0].rows).toHaveLength(1);
  });

  it("refuses row and column changes on a table that holds a suggested row", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"),
      {
        table: [["Task\n", "Status\n"], ["Fix login\n", "Open\n"]],
        suggestedRows: { 1: "insertion" },
      },
      paragraph("After"),
    ]).body);
    let facet = "table-suggested-row";

    for (let [method, argument] of [
      ["insertTableRows", { table: 0 }],
      ["insertTableColumns", { table: 0 }],
      ["deleteTableRows", { table: 0, at: 0 }],
      ["deleteTableColumns", { table: 0, at: 0 }],
    ] as const) {
      await expect(edit(facet, method, argument)).rejects.toThrow(
        `${method}: this table holds suggested changes to its rows, columns or cells, so its ` +
        "rows and columns cannot be changed until they are accepted or rejected.");
      expect(await hooks().lastActionDescription).toBe("");
    }
    expect(docs.contentBatches).toBe(0);

    // The text of its cells is replaced as anywhere else, and the table can be deleted whole.
    await editApplies(docs, facet, "replaceText", "<p>Open</p>", "<p>Done</p>");
    expect(docs.cellText(0, 1, 1)).toBe("Done");
    let { actionId } = await edit(facet, "deleteTable", 0);
    expect(await hooks().lastActionDescription).toBe(
      'Delete a table of tab "Main" (tab-1), with everything in it. It holds suggested changes ' +
      "to its rows, columns or cells, which are deleted with it. It was table 1 of the tab " +
      "when this change was requested.");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.tables()).toEqual([]);
  });

  // A row added with a pinned row as its reference row is pinned too, so the batch pins the
  // header again at the count it read.
  it("keeps a table's pinned header rows at their count", async () => {
    let docs = pinnedTable();
    await editApplies(
      docs, "table-pinned-above", "insertTableRows", { table: 0, at: 0, cells: [["a", "b"]] });
    expect(Object.keys(docs.lastContentRequests.at(-1) ?? {})).toEqual(["pinTableHeaderRows"]);
    expect(headerPins(docs)).toEqual([1]);
    expect(pinnedHeaderRows(docs.bodyTab(), docs.tables()[0].start)).toBe(1);

    // Below the header, the reference row is not pinned and nothing is pinned again.
    docs = pinnedTable();
    await editApplies(
      docs, "table-pinned-below", "insertTableRows", { table: 0, at: 1, cells: [["a", "b"]] });
    expect(headerPins(docs)).toEqual([]);
    expect(pinnedHeaderRows(docs.bodyTab(), docs.tables()[0].start)).toBe(1);
  });

  it("refuses rows once the tab's tables would hold more than 5,000 cells", async () => {
    let docs = docsWithBody(fullTab());
    let facet = "table-full";

    await expect(edit(facet, "insertTableRows", { table: 0, count: 2 }))
      .rejects.toThrow(room("insertTableRows", 5010));
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");

    // One more row fills the tab, and the queued row counts against the next.
    await edit(facet, "insertTableRows", { table: 0 });
    await expect(edit(facet, "insertTableRows", { table: 0 }))
      .rejects.toThrow(room("insertTableRows", 5010));
    await expect(edit(facet, "insertTable", { rows: 1, columns: 1 }))
      .rejects.toThrow(room("insertTable", 5001));
    // The generic read alone: the new table's position was never read.
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    await edit(facet, "deleteTableRows", { table: 0, at: 0 });
    expect(docs.contentBatches).toBe(0);
  });

  it("invalidates a queued row when a collaborator has filled the tab", async () => {
    let docs = docsWithBody(fullTab());
    let facet = "table-filled-since";
    let rows = await edit(facet, "insertTableRows", { table: 0 });
    let before = await hooks().readContent(facet);

    docs.externalBody(MAIN_TAB, fullTab(table(["More"]), paragraph("")));

    expect(await hooks().applyAction(facet, rows.actionId))
      .toContain(room("insertTableRows", 5001));
    expect(docs.contentBatches).toBe(0);
    let after = await hooks().readContent(facet);
    expect(after.endsWith(`\n\nAfter\n\n${tableOf([["More"]])}\n\n\n`)).toBe(true);
    // The queued row is gone from the read: the big table has the rows it had.
    let emptyRow = rowOf(...Array.from({ length: 10 }, () => ""));
    expect(before).toContain(emptyRow);
    expect(after).not.toContain(emptyRow);
  });

  // Cells that hold only bullets of a list that numbers nothing can move no number.
  it("deletes a row of bulleted cells though a numbered list follows", async () => {
    let lists = { ...BULLET_LIST, ...NUMBERED_LIST };
    let docs = docsWithBody(buildTab([
      paragraph("Before"),
      { table: [
        [{ paragraphs: [{ runs: ["Point\n"], bullet: { listId: "L1" } }] }, "x\n"],
        ["y\n", "z\n"],
      ] },
      numberedItem("First"), numberedItem("Second"),
    ], lists).body, lists);

    let preview = await editApplies(
      docs, "table-bulleted-row", "deleteTableRows", { table: 0, at: 0 });

    expect(preview).toBe(`Before\n\n${tableOf([["y", "z"]])}\n\n1. First\n1. Second\n`);
  });

  // A replacement that drops a tab's last line break leaves the simulated Markdown without it,
  // while the tab keeps the paragraph: the new table still follows that paragraph.
  it("adds a table at the end after a replacement dropped the last line break", async () => {
    let docs = docsWithBody(buildTab([paragraph("Before"), paragraph("After")]).body);
    let facet = "table-after-dropped-break";
    let text = await edit(facet, "replaceText", "After\n", "Later");
    let added = await edit(facet, "insertTable", { rows: 1, columns: 1 });

    let preview = await hooks().readContent(facet);
    expect(preview).toBe(`Before\n\nLater\n\n${tableOf([[""]])}\n\n\n`);
    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, added.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(2);
  });

  it("deletes a table after a replacement removed the tab's first line", async () => {
    let docs = titledTable();
    let facet = "table-delete-after-removed-line";
    let text = await edit(facet, "replaceText", "# Title\n", "");
    let deleted = await edit(facet, "deleteTable", 0);

    let preview = await hooks().readContent(facet);
    expect(preview).toBe("\n\nAfter\n");
    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, deleted.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(2);
  });

  it("says to retry when a waiting edit removed the paragraph beside a table", async () => {
    let docs = titledTable();
    let facet = "table-edge-missing-paragraph";
    let text = await edit(facet, "replaceText", "# Title\n", "");
    let intro = ["<table>", "Intro\n\n<table>"] as const;

    await expect(edit(facet, "replaceText", ...intro)).rejects.toThrow(missingParagraph("before"));
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");

    // Once the first edit has applied, the tab shows its first paragraph, emptied.
    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    let preview = await editApplies(docs, facet, "replaceText", ...intro);
    expect(preview.startsWith("\n\nIntro\n\n<table>")).toBe(true);
  });

  it("says to retry, not that a paragraph is read-only, between two tables whose paragraph a waiting edit removed", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"), table(["a"]), paragraph("Mid"), table(["b"]), paragraph("After"),
    ]).body);
    let facet = "table-edge-between-tables";
    let text = await edit(facet, "replaceText", "Mid\n", "");
    expect(await hooks().readContent(facet)).toContain("</table>\n\n\n<table>");
    // The second table, quoted with its cell so that the match is unique.
    let intro = ["<table>\n  <tr>\n    <td><p>b</p></td>",
      "Intro\n\n<table>\n  <tr>\n    <td><p>b</p></td>"] as const;

    let refusal = await edit(facet, "replaceText", ...intro).then(
      () => "queued", (error: unknown) => String(error));
    expect(refusal).toContain(missingParagraph("before"));
    expect(refusal).not.toContain("read-only");
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");

    // Once the first edit has applied, the paragraph between the tables is there, emptied.
    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    let preview = await editApplies(docs, facet, "replaceText", ...intro);
    expect(preview).toContain("</table>\n\n\n\nIntro\n\n<table>");
  });

  const EDIT_KIND =
    { actionKind: { tag: "editDocument", label: "Document edits" }, autoApprovable: true };
  const PARAGRAPH_PROSE = 'Replace text in tab "Main" (tab-1).';

  it("adds a paragraph above a table from the table's first line", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-edge-above";

    let queued = await edit(facet, "replaceText", "<table>", "Intro\n\n<table>");
    expect(await hooks().lastActionVerdict).toEqual(EDIT_KIND);
    expect(await hooks().lastActionDescription).toBe(PARAGRAPH_PROSE);
    // The card shows one range of the tab: the match and the line the text is added to.
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "Before\n\n<table>"),
      markdownField("New", "Before\n\nIntro\n\n<table>"),
    ]);
    let preview = await appliesAsRead(docs, facet, queued);
    expect(preview).toBe(TABLE_CONTENT.replace("Before\n\n", "Before\n\nIntro\n\n"));

    // Text with no blank line between it and the table is no paragraph of its own.
    await expect(edit(facet, "replaceText", "<table>", "Intro <table>")).rejects.toThrow(
      "replaceText: text added directly above or below a table must be whole paragraphs, with " +
      "a blank line between them and the table.");
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("adds a paragraph below a table from its last line", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-edge-below";

    let queued = await edit(facet, "replaceText", "</table>", "</table>\n\nCaption");
    expect(await hooks().lastActionVerdict).toEqual(EDIT_KIND);
    let preview = await appliesAsRead(docs, facet, queued);
    expect(preview).toBe(TABLE_CONTENT.replace("\n\nAfter", "\n\nCaption\n\nAfter"));
  });

  // The strings share their first character with `<table>`, so compared character by character
  // the text reads as typed after the table's first character, one character into the table.
  it.each<[string, string, string, string]>([
    ["a placeholder", "<TODO: describe the figures>", "<table>", "<table>"],
    ["a comparison", "<50 employees only", "Before\n\n<table>", "Before\n\n<table>"],
  ])("adds a line that starts with < above a table: %s", async (name, line, quoted, kept) => {
    let docs = docsWithBody(tableBody());
    let facet = `table-edge-angle-${name}`;
    // The line goes in front of the table's first line, however much is quoted before it.
    let { actionId } = await edit(
      facet, "replaceText", quoted, kept.replace("<table>", `${line}\n\n<table>`));

    expect(await hooks().lastActionVerdict).toEqual(EDIT_KIND);
    expect(await hooks().lastActionDescription).toBe(PARAGRAPH_PROSE);
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "Before\n\n<table>"),
      markdownField("New", `Before\n\n${line}\n\n<table>`),
    ]);
    let preview = await hooks().readContent(facet);
    expect(preview).toBe(TABLE_CONTENT.replace("Before\n\n", `Before\n\n${line}\n\n`));
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    // The line is a paragraph of the body before the table, whose cells are as they were.
    expect(docs.text()).toBe(`Before\n${line}\nAfter`);
    expect(docs.cellText(0, 0, 0)).toBe("Task");
    expect(docs.cellText(0, 1, 1)).toBe("Open");
  });

  const BLANK_LINE = "replaceText: the replacement changes the blank line between a table and " +
    "the paragraph beside it, which has to stay.";
  const OTHER_SIDE = `${BLANK_LINE} To remove or rewrite that paragraph, take the blank line ` +
    "on its other side instead: end oldMarkdown at the last character of the paragraph before " +
    "the table, or start it at the first character of the paragraph after the table. If that " +
    "is refused too, empty the paragraph: it cannot be removed.";

  it("names the phrasing that removes a paragraph starting with < above a table", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("A"), paragraph("<TODO>"), table(["Cell"]), paragraph("After"),
    ]).body);
    let facet = "table-blank-line-angle";

    let refusal = await edit(facet, "replaceText", "<TODO>\n\n<table>", "<table>").then(
      () => "queued", (error: unknown) => String(error));
    expect(refusal).toContain(OTHER_SIDE);
    expect(refusal).not.toContain("one replacement cannot change a table together");

    let preview = await editApplies(docs, facet, "replaceText", "\n\n<TODO>", "");
    expect(preview).toBe(`A\n\n${tableOf([["Cell"]])}\n\nAfter\n`);
  });

  // The canonical replacement restores the blank line beside the changed line, so only the
  // paragraph changes, as it does without tables.
  it.each<[string, string, string]>([
    ["a changed paragraph", "</table>\nAfter!", "After!"],
    ["an added paragraph", "</table>\nCaption\n\nAfter", "Caption\n\nAfter"],
  ])("replaces text after a table quoted with one line break: %s", async (name, requested, after) => {
    let docs = docsWithBody(tableBody());
    let facet = `table-one-line-break-${name}`;

    let queued = await edit(facet, "replaceText", "</table>\n\nAfter", requested);
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "</table>\n\nAfter"),
      markdownField("Requested New", requested),
      markdownField("New", `</table>\n\n${after}`),
    ]);
    let preview = await appliesAsRead(docs, facet, queued);
    expect(preview).toBe(TABLE_CONTENT.replace("After\n", `${after}\n`));
  });

  it("refuses removing the paragraph above a table together with the table's blank line", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("A"), paragraph("B"), table(["Cell"]), paragraph("After"),
    ]).body);
    let facet = "table-blank-line-above";

    await expect(edit(facet, "replaceText", "B\n\n", "")).rejects.toThrow(OTHER_SIDE);
    expect(await hooks().lastActionDescription).toBe("");

    let preview = await editApplies(docs, facet, "replaceText", "\n\nB", "");
    expect(preview).toBe(`A\n\n${tableOf([["Cell"]])}\n\nAfter\n`);
  });

  it("says that the paragraph Google Docs keeps beside a table can only be emptied", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-blank-line-kept-paragraph";

    // `Before` is the tab's first paragraph: nothing stands on its other side.
    await expect(edit(facet, "replaceText", "Before\n\n<table>", "<table>")).rejects.toThrow(
      `${BLANK_LINE} Google Docs keeps a paragraph on each side of a table, so that paragraph ` +
      "can be emptied but not removed.");
    expect(await hooks().lastActionDescription).toBe("");

    let preview = await editApplies(docs, facet, "replaceText", "Before", "");
    expect(preview).toBe(TABLE_CONTENT.replace("Before", ""));
  });

  it("says that nothing can be added beside a read-only paragraph", async () => {
    let docs = docsWithBody(buildTab([
      { runs: ["Owner: ", { person: { name: "Ana", email: "ana@example.com" } }, "\n"] },
      table(["Cell"]), paragraph("After"),
    ]).body);
    let facet = "table-read-only-neighbour";
    let content = await hooks().readContent(facet);
    let owner = content.slice(0, content.indexOf("\n"));
    expect(owner).toContain("Ana");

    for (let [oldMarkdown, newMarkdown] of [
      ["<table>", "Intro\n\n<table>"],
      [`${owner}\n\n<table>`, "<table>"],
    ]) {
      await expect(edit(facet, "replaceText", oldMarkdown, newMarkdown)).rejects.toThrow(
        "replaceText: a paragraph before the table holds an image, smart chip or other element " +
        "and is read-only: it cannot be changed or removed, and nothing can be added between " +
        "it and the table.");
      expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
      expect(await hooks().lastActionDescription).toBe("");
    }

    let preview = await editApplies(
      docs, facet, "replaceText", "</table>", "</table>\n\nCaption");
    expect(preview).toBe(`${owner}\n\n${tableOf([["Cell"]])}\n\nCaption\n\nAfter\n`);
  });

  // Replayed as a replacement of the whole tab, the asterisk in the cell would pair with the one
  // in the appended text: every table line from there on would read with a blank line after it,
  // and the row insert would be refused for a table that is not laid out as one.
  it("keeps a table as it reads when text with an asterisk is appended", async () => {
    let docs = docsWithBody(buildTab([
      paragraph("Before"), table(["Field", "Required*"], ["Name", "yes"]), paragraph("After"),
    ]).body);
    let facet = "table-append-asterisk";
    let append = await hooks().submitAppend(facet, "*Source: finance.*");
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["Email", "no"]] });

    let preview = await hooks().readContent(facet);
    expect(preview).toBe(
      `Before\n\n${tableOf([["Field", "Required*"], ["Name", "yes"], ["Email", "no"]])}\n\n` +
      "After\n\n*Source: finance.*\n");
    expect(await hooks().applyAction(facet, append)).toBeNull();
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(2);
  });

  // Typed captions that start `1. ` and `2. ` read exactly like items of one list. With nothing
  // queued before the deletion the document says they are not; behind another edit only the
  // view can be asked.
  it("deletes a table between two paragraphs that only read as list items", async () => {
    let preview = await editApplies(captioned(), "table-captions", "deleteTable", 0);
    expect(preview).toBe("1. Revenue by region\n\n2. Revenue by product\n\nNotes\n");

    let docs = captioned();
    let facet = "table-captions-behind-edit";
    let text = await edit(facet, "replaceText", "Notes", "Sources");
    await expect(edit(facet, "deleteTable", 0)).rejects.toThrow(
      "deleteTable: the lines before and after this table read as list items, which deleting " +
      "it could join into one list. Retry once the earlier changes to this tab have been " +
      "approved or rejected: the document then shows whether they are items of one list.");
    expect(await hooks().lastActionDescription).toBe("");
    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    await editApplies(docs, facet, "deleteTable", 0);
  });

  it("stops queueing table changes once their recorded tables pass the limit", async () => {
    docsWithBody(tableBody());
    let facet = "table-queue-room";
    // Four waiting changes that record just under 4 MiB of tables between them.
    let recorded = "x".repeat(1024 * 1024 - 10);
    await hooks().applyStorage(facet, [1, 2, 3, 4].map(id =>
      storedAction(id, { type: "deleteTable", expected: recorded })));
    await hooks().applyStorage(facet, [{ kind: "put", key: "pending:nextActionId", value: 5 }]);
    let rows = { table: 0, cells: [["a", "b"]] };

    await expect(edit(facet, "insertTableRows", rows)).rejects.toThrow(
      "insertTableRows: the table changes already waiting on this document hold too much " +
      "table content for another. Retry once some of them have been approved or rejected.");
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");

    await hooks().rejectAction(facet, 1);
    expect((await edit(facet, "insertTableRows", rows)).actionId).toBe(5);
  });

  it("authorizes nothing for a table change it queues", async () => {
    docsWithBody(tableBody());
    let facet = "table-observations-none";

    for (let [method, argument] of [
      ["insertTableRows", { table: 0 }],
      ["insertTableColumns", { table: 0 }],
      ["deleteTableRows", { table: 0, at: 0 }],
      ["deleteTableColumns", { table: 0, at: 0 }],
      ["deleteTable", 0],
    ] as const) {
      await edit(facet, method, argument);
      expect(await hooks().lastObservations).toEqual([]);
    }
  });

  const POSITION_READ =
    'Read the position of a new table among the tables of tab "Main" (tab-1).';

  it("authorizes the position insertTable returns", async () => {
    docsWithBody(tableBody());

    await edit("table-observations-position", "insertTable", { rows: 1, columns: 1 });

    expect(await hooks().lastObservations).toEqual([POSITION_READ]);
  });

  // The position is read from the document, so the read is authorized before anything is stored:
  // where reads are refused, insertTable() queues nothing, and the other writes still queue.
  it("queues nothing when the read of a new table's position is refused", async () => {
    docsWithBody(buildTab([paragraph("Before")]).body);
    let facet = "table-position-refused";

    await expect(Promise.resolve(hooks().submitEdit(
      facet, "insertTable", [{ rows: 1, columns: 1 }], { refuseRead: true },
    ))).rejects.toThrow("Reads of this document are refused.");
    expect(await hooks().lastObservations).toEqual([POSITION_READ]);
    expect(await hooks().lastActionDescription).toBe("");
    expect(await hooks().readContent(facet)).toBe("Before\n");
    expect(await hooks().storedValueJsonLength(facet, "pending:action:1")).toBeUndefined();

    docsWithBody(tableBody());
    for (let [method, ...args] of [
      ["insertTableRows", { table: 0 }],
      ["insertTableColumns", { table: 0 }],
      ["deleteTableRows", { table: 0, at: 0 }],
      ["deleteTableColumns", { table: 0, at: 0 }],
      ["deleteTable", 0],
      ["appendText", "added"],
    ] as const) {
      let unread = `table-unread-${method}`;
      let queued = await hooks().submitEdit(unread, method, args, { refuseRead: true });
      expect(queued.actionId).toBe(1);
      expect(await hooks().lastObservations).toEqual([]);
    }
  });

  // Without the queue the append is stored while the table waits for its authorization: it is
  // received first, `added` reads above the table, and the read shows the append and no table.
  // With the writes queued and the reads not waiting, the read shows neither, and the metadata
  // lists no pending edit.
  it("takes calls in the order they were made while a table's position is authorized", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-call-order";
    // Every call replays the cached snapshot.
    await hooks().readContent(facet);
    let baseline = await hooks().readMetadata(facet);
    await scheduler.wait(2);

    let { received, returned, read, modified } = await hooks().callsDuringTableRead(
      facet, { rows: 1, columns: 1 }, "added");

    expect(received.map(action => action.title))
      .toEqual(["Insert a table in Google Doc", "Append to Google Doc"]);
    expect(received[0].actionId).toBeLessThan(received[1].actionId);
    expect(returned).toBe(1);
    // The append was checked against content that held the table, and the read waited for both.
    expect(read).toBe(`${TABLE_CONTENT}\n${tableOf([[""]])}\n\n\n\nadded\n`);
    // The metadata read waited too: its time counts the two changes stored meanwhile.
    expect(modified).toBeGreaterThan(baseline);

    for (let { actionId } of received) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(read);
    expect(docs.contentBatches).toBe(2);
  });

  it("authorizes a read when a table change is refused for what the tab holds", async () => {
    docsWithBody(tableBody());

    await expect(edit("table-observations-refused", "insertTableRows", { table: 3 }))
      .rejects.toThrow(
        'insertTableRows: tab "tab-1" has no table 3. It has 1 table, numbered from 0 in the ' +
        'order getContent("tab-1") shows them.');

    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
  });

  it("reads nothing when a table change's arguments are wrong", async () => {
    let docs = docsWithBody(tableBody());

    await expect(edit("table-arguments", "insertTable", { rows: 1, columns: 0 }))
      .rejects.toThrow("insertTable: columns must be a whole number from 1 to 20.");

    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastObservations).toEqual([]);
    expect(await hooks().lastActionDescription).toBe("");
  });
});

describe("Google Doc structured elements", () => {
  it("rejects a rich-link URL edit before requesting approval", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      "See ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " today\n",
    ] }]).body);
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "chip-url", "https://docs.google.com/document/d/plan", "https://example.com/new",
    ))).rejects.toThrow("replaceText: structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  it("rejects insertion at a protected paragraph boundary", async () => {
    let docs = new DocsModel();
    let tab = buildTab([{ runs: ["Caption\n"] }]);
    tab.body.content[1].paragraph!.positionedObjectIds = ["image-1"];
    docs.setBody(MAIN_TAB, tab.body);
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "image-boundary", "[Image] Caption", "X[Image] Caption",
    ))).rejects.toThrow("structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("applies a heading immediately before structured content", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { runs: [{ date: "Sep 16, 2026" }, "\n"] },
    ]).body);
    docs.install();
    let actionId = await hooks().submitReplace("heading-before-chip", "Before", "# Before");

    expect(await hooks().applyAction("heading-before-chip", actionId)).toBeNull();
    expect(await hooks().readContent("heading-before-chip")).toBe(
      "# Before\n\nSep 16, 2026\n",
    );
  });
});

describe("Google Doc list edits", () => {
  it("prepends an item to the existing numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["Existing"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "prepend-list", "1. Existing", "1. New\n1. Existing",
    );

    await hooks().applyAction("prepend-list", actionId);

    expect(docs.renderedText()).toBe("1. New\n2. Existing");
  });

  it("rewrites multiple items in one numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "rewrite-list", "1. First\n1. Second", "1. Changed first\n1. Changed second",
    );

    expect(await hooks().applyAction("rewrite-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. Changed first\n2. Changed second");
  });

  it("normalizes an unsupported interrupted numbered-list start", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "prose", "Second"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "restart-list", "2. Second", "3. Second",
    );
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "2. Second"),
      markdownField("Requested New", "3. Second"),
      markdownField("New", "1. Second"),
    ]);
    let preview = await hooks().readContent("restart-list");

    expect(preview).toBe("1. First\n\nprose\n\n1. Second\n");
    expect(await hooks().applyAction("restart-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. First\nprose\n1. Second");
    expect(await hooks().readContent("restart-list")).toBe(preview);
  });

  it("rewrites a list item and the prose after it", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Body"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "list-prose", "1. First\n\nBody", "1. Changed\n\nUpdated",
    );
    let preview = await hooks().readContent("list-prose");

    expect(preview).toBe("1. Changed\n\nUpdated\n");
    expect(await hooks().applyAction("list-prose", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. Changed\nUpdated");
    expect(await hooks().readContent("list-prose")).toBe(preview);
  });

  it("keeps one list while rewriting the section around it", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["Intro", "Ship", "Docs", "Owner"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.interruptList(MAIN_TAB, 3);
    docs.install();
    let actionId = await hooks().submitReplace(
      "section", "Intro\n\n- Ship\n- Docs\n\nOwner",
      "Intro edited\n\n- Ship now\n- Docs\n- Launch\n\nOwner: Bob",
    );
    let preview = await hooks().readContent("section");

    expect(preview).toBe("Intro edited\n\n- Ship now\n- Docs\n- Launch\n\nOwner: Bob\n");
    expect(await hooks().applyAction("section", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("Intro edited\n1. Ship now\n2. Docs\n3. Launch\nOwner: Bob");
    expect(await hooks().readContent("section")).toBe(preview);
  });

  it("restores a kept paragraph's style after deleting the final paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "Kept", namedStyleType: "TITLE" },
      { text: "Removed", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let actionId = await hooks().submitReplace("final", "# Kept\n\nRemoved", "# Added\n\n# Kept");
    let preview = await hooks().readContent("final");

    expect(preview).toBe("# Added\n\n# Kept\n");
    expect(await hooks().applyAction("final", actionId)).toBeNull();
    expect(await hooks().readContent("final")).toBe(preview);
  });

  let paragraphs = (...texts: string[]) => (docs: DocsModel) => docs.setParagraphs(
    MAIN_TAB, texts.map(text => ({ text, namedStyleType: "NORMAL_TEXT" })));
  let bullets = (...texts: string[]) => (docs: DocsModel) => docs.setBulletedList(MAIN_TAB, texts);
  it.each<[string, (docs: DocsModel) => void, string, string, string]>([
    ["split-around-empties", paragraphs("ab"), "ab", "a\n\n\n\n\n\nb", "a\n\n\n\n\n\nb\n"],
    ["merge", paragraphs("a", "b"), "a\n\nb", "ab", "ab\n"],
    ["drop-empty", paragraphs("a", "", "b"), "a\n\n\n\nb", "a\n\nb", "a\n\nb\n"],
    ["expand", paragraphs("a", "b", "c"), "b", "x\n\n\n\ny", "a\n\nx\n\n\n\ny\n\nc\n"],
    ["empty-list-gap", bullets("a", "b"), "- a\n- b", "- a\n\n\n\n- b", "- a\n\n\n\n- b\n"],
    ["end-list", bullets("a", "b"), "- a\n- b", "- a\n\nb", "- a\n\nb\n"],
    ["split-list-item", bullets("ab"), "- ab", "- a\n\nb", "- a\n\nb\n"],
    ["split-heading", docs => docs.setParagraphs(MAIN_TAB, [{ text: "Hx", namedStyleType: "HEADING_1" }]),
      "# Hx", "# H\n\nx", "# H\n\nx\n"],
    ["make-list", paragraphs("a", "b", "c"), "a\n\nb\n\nc", "- a\n- b\n- c", "- a\n- b\n- c\n"],
  ])("applies the %s paragraph structure it previews", async (facet, setup, from, to, expected) => {
    let docs = new DocsModel();
    setup(docs);
    docs.install();
    let actionId = await hooks().submitReplace(facet, from, to);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(expected);
  });

  let styled = (namedStyleType: string) => (docs: DocsModel) =>
    docs.setParagraphs(MAIN_TAB, [{ text: "Plan", namedStyleType }]);
  it.each<[string, (docs: DocsModel) => void, string, string]>([
    ["heading", styled("HEADING_1"), "Notes", "# Plan\n\nNotes\n"],
    ["title", styled("TITLE"), "Notes", "# Plan\n\nNotes\n"],
    ["numbered-list", docs => docs.setNumberedList(MAIN_TAB, ["one"]), "Notes", "1. one\n\nNotes\n"],
    ["bulleted-list", bullets("one"), "a\n\nb", "- one\n\na\n\nb\n"],
    ["list-continuation", bullets("one"), "- two", "- one\n- two\n"],
  ])("appends after a %s as previewed", async (name, setup, markdown, expected) => {
    let docs = new DocsModel();
    setup(docs);
    docs.install();
    let facet = `append-after-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(expected);
  });

  it("replays a dependent edit after appending adjacent mixed lists", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["base"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.install();
    let facet = "mixed-list-replay";
    let appendId = await hooks().submitAppend(facet, "- one\n1. two");
    let replaceId = await hooks().submitReplace(facet, "1. two", "1. changed");

    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
    expect(await hooks().applyAction(facet, appendId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
    expect(await hooks().applyAction(facet, replaceId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
  });

  it("joins a plain paragraph added to the preceding numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "join-list", "Second", "1. Second",
    );
    let preview = await hooks().readContent("join-list");

    expect(preview).toBe("1. First\n1. Second\n");
    expect(await hooks().applyAction("join-list", actionId)).toBeNull();
    expect(await hooks().readContent("join-list")).toBe(preview);
  });

  it("separates a paragraph removed from a numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "leave-list", "1. Second", "Second",
    );
    let preview = await hooks().readContent("leave-list");

    expect(preview).toBe("1. First\n\nSecond\n");
    expect(await hooks().applyAction("leave-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. First\nSecond");
    expect(await hooks().readContent("leave-list")).toBe(preview);
  });

  it("separates adjacent lists when an item changes list type", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "change-list-type", "- First", "1. First",
    );
    let preview = await hooks().readContent("change-list-type");

    expect(preview).toBe("1. First\n\n- Second\n");
    expect(await hooks().applyAction("change-list-type", actionId)).toBeNull();
    expect(await hooks().readContent("change-list-type")).toBe(preview);
  });
});

describe("Google Doc write receipts", () => {
  it("applies content once and immediately deletes its exact marker", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("normal", "first");

    await hooks().applyAction("normal", actionId);

    expect(docs.text()).toContain("first");
    expect(docs.contentBatches).toBe(1);
    expect(docs.deletedMarkerIds).toEqual(["marker-1"]);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("normal", actionId)).toMatch(/Unknown pending/);
  });

  it("replays a queued edit after applying an escaped parenthesized link", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let link = "[link](https://en.wikipedia.org/wiki/Function_\\(mathematics\\))";
    let firstId = await hooks().submitReplace("escaped-link-replay", "target", link);
    let secondId = await hooks().submitReplace(
      "escaped-link-replay", link, `${link} after`,
    );

    expect(await hooks().applyAction("escaped-link-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("escaped-link-replay", secondId)).toBeNull();
    expect(await hooks().readContent("escaped-link-replay")).toContain(`${link} after`);
  });

  it("replays a queued edit using its rendered Markdown", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let firstId = await hooks().submitReplace("escaped-replay", "target", String.raw`\* literal`);
    let rendered = await hooks().readContent("escaped-replay");
    let secondId = await hooks().submitReplace("escaped-replay", rendered.trimEnd(), "updated");

    expect(rendered).toBe("* literal\n");
    expect(await hooks().applyAction("escaped-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("escaped-replay", secondId)).toBeNull();
    expect(await hooks().readContent("escaped-replay")).toBe("updated\n");
  });

  it("replays an edit after inserting a paragraph between separators", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "A", namedStyleType: "NORMAL_TEXT" },
      { text: "B", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let facet = "separator-insert-replay";
    let firstId = await hooks().submitReplace(facet, "A\n\nB", "A\n\nX\n\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, "X\n\nB", "Y\n\nB");

    expect(preview).toBe("A\n\nX\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(docs.text()).toBe("A\nX\nB");
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("A\n\nY\n\nB\n");
  });

  it("replays an edit after splitting a paragraph with an odd separator", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "AB", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "odd-separator-replay";
    let firstId = await hooks().submitReplace(facet, "AB", "A\n\n\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\n\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(docs.text()).toBe("A\n\nB");
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("queues a dependent edit with canonical replacement formatting", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let facet = "formatted-link-replacement";
    await hooks().submitReplace(facet, "target", "**[x](https://e.com)**");
    let rendered = await hooks().readContent(facet);
    await hooks().submitReplace(facet, rendered.trimEnd(), "updated");

    expect(rendered).toBe("[**x**](https://e.com)\n");
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after extending a paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "A", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "extended-paragraph-replay";
    let firstId = await hooks().submitReplace(facet, "A", "A\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after splitting existing paragraph text", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "AB", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "split-paragraph-replay";
    let firstId = await hooks().submitReplace(facet, "AB", "A\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after inserting a paragraph between contextual blocks", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "A", namedStyleType: "NORMAL_TEXT" },
      { text: "B", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let facet = "paragraph-boundary-replay";
    let firstId = await hooks().submitReplace(facet, "A\n\nB", "A\nX\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nX\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("invalidates a canonical no-op after its target vanishes", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      { text: "x", style: { italic: true } }, "\n",
    ] }]).body);
    docs.install();
    let facet = "canonical-no-op-invalidation";
    await hooks().submitReplace(facet, "*x*", String.raw`\*x\*`);
    let appendId = await hooks().submitAppend(facet, "after");

    docs.setBody(MAIN_TAB, buildTab([{ runs: ["gone\n"] }]).body);
    docs.externalEdit(MAIN_TAB, "gone");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await hooks().readContent(facet)).toBe("gone\n\nafter\n");
    expect(await hooks().applyAction(facet, appendId)).toBeNull();
    expect(docs.text()).toBe("gone\nafter");
  });

  it("rejects a range that splits an escaped linked-label character", async () => {
    let docs = new DocsModel();
    docs.setLinkedText(MAIN_TAB, "a]b", "https://e.com");
    docs.install();

    await expect(Promise.resolve(
      hooks().submitReplace("split-linked-escape", "]b", "x]b"),
    )).rejects.toThrow("replaceText: Markdown escape syntax cannot be edited partially");
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("materializes a link added to bracketed text", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "[x]");
    docs.install();
    let facet = "bracketed-link-replacement";
    let actionId = await hooks().submitReplace(facet, "[x]", "[x](https://e.com)");
    let preview = await hooks().readContent(facet);

    expect(preview).toBe("[x](https://e.com)\n");
    await hooks().applyAction(facet, actionId);
    expect(docs.text()).toBe("x");
    expect(await hooks().readContent(facet)).toBe(preview);
  });

  it("matches literal backslashes exactly", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, String.raw`Path \*.txt`);
    docs.install();
    let actionId = await hooks().submitReplace("literal-backslash", String.raw`\*.txt`, "files");

    expect(await hooks().applyAction("literal-backslash", actionId)).toBeNull();
    expect(await hooks().readContent("literal-backslash")).toBe("Path files\n");
  });

  it("applies the replacement its approval shows for literal escapes", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      { text: "x", style: { italic: true } }, "\n",
    ] }]).body);
    docs.install();
    let facet = "literal-markdown-approval";
    let actionId = await hooks().submitReplace(facet, "*x*", String.raw`\*x\*`);

    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "*x*"),
      markdownField("Requested New", String.raw`\*x\*`),
      markdownField("New", "*x*"),
    ]);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.text()).toBe("x");
  });

  it("commits whitespace when replacing a heading", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "Title", namedStyleType: "HEADING_1" }]);
    docs.install();
    let actionId = await hooks().submitReplace("heading-whitespace", "# Title", "   ");

    expect(await hooks().readContent("heading-whitespace")).toBe("   \n");
    await hooks().applyAction("heading-whitespace", actionId);

    expect(docs.text()).toBe("   ");
    expect(await hooks().readContent("heading-whitespace")).toBe("   \n");
  });

  it("resets subtitle style on paragraphs split from a subtitle", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "Subtitle", namedStyleType: "SUBTITLE" }]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "subtitle-expansion", "*Subtitle*", "*first*\n\nsecond",
    );

    expect(await hooks().readContent("subtitle-expansion")).toBe("*first*\n\nsecond\n");
    await hooks().applyAction("subtitle-expansion", actionId);

    expect(await hooks().readContent("subtitle-expansion")).toBe("*first*\n\nsecond\n");
  });

  it("commits the same escaped replacement it simulates", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "x*");
    docs.install();
    let actionId = await hooks().submitReplace("escaped-suffix", "x*", String.raw`y\*`);

    expect(await hooks().readContent("escaped-suffix")).toBe("y*\n");
    await hooks().applyAction("escaped-suffix", actionId);

    expect(docs.text()).toBe("y*");
    expect(await hooks().readContent("escaped-suffix")).toBe("y*\n");
  });

  it("preserves paragraph styles through a same-count rewrite", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "Old", namedStyleType: "HEADING_1" },
      { text: "Body", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "styled-rewrite", "# Old\n\nBody", "# New\n\nChanged",
    );

    expect(await hooks().applyAction("styled-rewrite", actionId)).toBeNull();
    expect(await hooks().readContent("styled-rewrite")).toBe("# New\n\nChanged\n");
  });

  it("preserves a closing bracket in a linked label through a heading rewrite", async () => {
    let docs = new DocsModel();
    docs.setLinkedText(MAIN_TAB, "a]b", "https://e.com");
    docs.install();
    let link = "[a\\]b](https://e.com)";
    let actionId = await hooks().submitReplace("linked-heading", link, `# ${link}`);

    expect(await hooks().readContent("linked-heading")).toBe(`# ${link}\n`);
    await hooks().applyAction("linked-heading", actionId);

    expect(await hooks().readContent("linked-heading")).toBe(`# ${link}\n`);
  });

  it("replays an insertion inside an escaped link label", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let link = "[a\\]b](https://example.com)";
    let editedLink = "[a\\]c](https://example.com)";
    let firstId = await hooks().submitReplace("linked-label-replay", "target", link);
    let secondId = await hooks().submitReplace("linked-label-replay", link, editedLink);

    expect(await hooks().applyAction("linked-label-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("linked-label-replay", secondId)).toBeNull();
    expect(await hooks().readContent("linked-label-replay")).toBe(`${editedLink}\n`);
  });

  it("replays an append containing an escaped link label", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let link = "[a\\]b](https://example.com)";
    let editedLink = "[a\\]c](https://example.com)";
    let firstId = await hooks().submitAppend("linked-label-append", link);
    let secondId = await hooks().submitReplace("linked-label-append", link, editedLink);

    expect(await hooks().applyAction("linked-label-append", firstId)).toBeNull();
    expect(await hooks().applyAction("linked-label-append", secondId)).toBeNull();
    expect(await hooks().readContent("linked-label-append")).toBe(`base\n${editedLink}\n`);
  });

  it("simulates an append with canonical formatting nesting", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    await hooks().submitAppend("formatted-link-append", "**[x](https://e.com)**");
    await hooks().submitReplace(
      "formatted-link-append", "[**x**](https://e.com)", "[**y**](https://e.com)",
    );

    expect(await hooks().readContent("formatted-link-append")).toBe(
      "base\n\n[**y**](https://e.com)\n",
    );
  });

  it("drops an append stored under an earlier Markdown version", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "legacy-append-rendering";
    await hooks().applyStorage(facet, [{
      kind: "put",
      key: "pending:action:1",
      value: {
        type: "appendText",
        documentId: "doc-1",
        tabId: MAIN_TAB,
        submittedAt: 0,
        markdown: String.raw`\* literal`,
      },
    }]);

    expect(await hooks().readContent(facet)).toBe("base\n");
  });

  it("stores one copy of an append payload", async () => {
    let docs = new DocsModel();
    docs.install();
    let facet = "append-storage";
    let markdown = "abcdef ".repeat(10_000);

    let actionId = await hooks().submitAppend(facet, markdown);
    let storedLength = await hooks().storedValueJsonLength(
      facet, `pending:action:${actionId}`,
    );

    expect(storedLength).toBeLessThan(markdown.length + 512);
    await hooks().rejectAction(facet, actionId);
  });

  it("rejects an oversized UTF-8 append before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("oversized-append", "é".repeat(600_000)),
    )).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("rejects an oversized aggregate replacement before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "oversized-replacement", "x".repeat(600_000), "y".repeat(600_000),
    ))).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("rejects complex Markdown before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("complex-append", "*x* ".repeat(2_501)),
    )).rejects.toThrow(/5000-formatting-token complexity limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("shows literal Markdown escapes in the append approval", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().submitAppend("literal-append-approval", String.raw`\# title`);

    expect(await hooks().lastActionFields).toEqual([
      markdownField("Requested", String.raw`\# title`),
      markdownField("Resulting", "# title"),
    ]);
  });

  it.each([
    ["bold", String.raw`\*\*literal\*\*`, "**literal**"],
    ["heading", String.raw`\# title`, "# title"],
    ["numbered", String.raw`1\. item`, "1. item"],
  ])("appends escaped Markdown as literal text", async (name, markdown, expected) => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = `escaped-append-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(`base\n\n${expected}\n`);
    await hooks().applyAction(facet, actionId);

    expect(docs.text()).toBe(`base\n${expected}`);
    expect(await hooks().readContent(facet)).toBe(`base\n\n${expected}\n`);
  });

  it.each([
    ["spaces", "   ", "base\n\n   \n"],
    ["tab", "\t", "base\n\n\t\n"],
    ["multiple lines", "  \n\t", "base\n\n  \n\n\t\n"],
  ])("preserves a whitespace-only append with %s", async (name, markdown, rendered) => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = `whitespace-append-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(rendered);
    await hooks().applyAction(facet, actionId);

    expect(docs.text()).toBe(`base\n${markdown}`);
    expect(await hooks().readContent(facet)).toBe(rendered);
  });

  it("simulates an append ending in an empty paragraph exactly", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let actionId = await hooks().submitAppend("appended-empty-paragraph", "added\n\n");
    let preview = await hooks().readContent("appended-empty-paragraph");

    expect(preview).toBe("base\n\nadded\n\n\n");
    await hooks().applyAction("appended-empty-paragraph", actionId);
    expect(await hooks().readContent("appended-empty-paragraph")).toBe(preview);
  });

  it("replays a dependent edit after appending to a trailing empty paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "base", namedStyleType: "NORMAL_TEXT" },
      { text: "", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let firstId = await hooks().submitAppend("trailing-empty-append", "added");
    let content = await hooks().readContent("trailing-empty-append");
    let secondId = await hooks().submitReplace(
      "trailing-empty-append", content.trimEnd(), "changed",
    );

    expect(await hooks().applyAction("trailing-empty-append", firstId)).toBeNull();
    expect(await hooks().applyAction("trailing-empty-append", secondId)).toBeNull();
    expect(await hooks().readContent("trailing-empty-append")).toBe("changed\n");
  });

  it("reconciles a committed write after its response is lost", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("ambiguous", "first");

    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/content response lost/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("ambiguous", actionId);

    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/Unknown pending/);
  });

  it("cleans a retained receipt after restart before the next write", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 1;
    docs.install();
    let firstId = await hooks().submitAppend("restart", "first");
    await hooks().applyAction("restart", firstId);
    expect(docs.markers.size).toBe(1);

    await abortAllDurableObjects();
    let secondId = await hooks().submitAppend("restart", "second");
    await hooks().applyAction("restart", secondId);

    expect(docs.text()).toContain("first");
    expect(docs.text()).toContain("second");
    expect(docs.contentBatches).toBe(2);
    expect(docs.maxMarkerCount).toBe(1);
    expect(docs.markers.size).toBe(0);
  });

  it("keeps the next action pending while receipt cleanup fails", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 2;
    docs.install();
    let firstId = await hooks().submitAppend("repeated-cleanup", "first");
    await hooks().applyAction("repeated-cleanup", firstId);
    let secondId = await hooks().submitAppend("repeated-cleanup", "second");

    expect(await hooks().applyAction("repeated-cleanup", secondId)).toMatch(/cleanup failed/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("repeated-cleanup", secondId);
    expect(docs.contentBatches).toBe(2);
    expect(docs.markers.size).toBe(0);
  });

  it("fails closed when the current marker name has multiple IDs", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = new DocsModel();
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-1");
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-2");
    docs.install();
    let actionId = await hooks().submitAppend("duplicates", "first");

    expect(await hooks().applyAction("duplicates", actionId)).toMatch(
      /multiple write markers/,
    );
    expect(docs.contentBatches).toBe(0);

    docs.clearMarkers();
    await hooks().applyAction("duplicates", actionId);
    expect(docs.contentBatches).toBe(1);
  });

  it("rejects an unapplied action without creating a write receipt", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("reject", "first");

    await hooks().rejectAction("reject", actionId);

    expect(docs.contentBatches).toBe(0);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("reject", actionId)).toMatch(/Unknown pending/);
  });

  // The overseer marks a record approved only after applyAction() returns, so a second approval of
  // one action can arrive while the first is mid-write. It must not reach the provider at all.
  it("holds a second approval of one action behind the first", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("concurrent", "first");
    let write = docs.hold("content");

    let first = hooks().applyAction("concurrent", actionId);
    await write.reached;
    let second = hooks().applyAction("concurrent", actionId);
    await scheduler.wait(5);
    write.release();

    expect(await first).toBeNull();
    expect(await second).toMatch(/Unknown pending/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text().match(/first/g)).toHaveLength(1);
    expect(docs.markers.size).toBe(0);
  });

  // Between the handoff and the marker cleanup the edit is committed and its action is gone, so
  // nothing is left to overlay the snapshot the submission cached: it must not be served.
  it("stops serving the pre-write snapshot once the write is committed", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("cleanup-read", "first");
    let cleanup = docs.hold("cleanup");

    let apply = hooks().applyAction("cleanup-read", actionId);
    await cleanup.reached;
    let content = await hooks().readContent("cleanup-read");
    cleanup.release();

    expect(content).toContain("first");
    expect(await apply).toBeNull();
  });

  // A read that asked Google before the write landed gets the old document back after the handoff
  // removed the edit from the queue: replayed over, it would show the approved edit missing.
  it("refetches a read that Google answered before a write landed", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("stale-read", "first");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    let staleAnswer = docs.hold("read");

    let read = hooks().readContent("stale-read");
    await staleAnswer.reached;
    expect(await hooks().applyAction("stale-read", actionId)).toBeNull();
    staleAnswer.release();

    expect(await read).toContain("first");
    expect(await hooks().readContent("stale-read")).toContain("first");
  });

  it("reads a lost-response append once, not once per replay", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("lost-response", "first");
    expect(await hooks().applyAction("lost-response", actionId))
      .toMatch(/content response lost/);
    expect(docs.markers.size).toBe(1);

    // Past the snapshot TTL, so the next read refetches the document -- which holds the append
    // the lost response never confirmed, while its action is still pending.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let content = await hooks().readContent("lost-response");

    expect(content.match(/first/g)).toHaveLength(1);
  });

  it("reconciles a row insert whose response is lost", async () => {
    let docs = docsWithBody(tableBody());
    docs.ambiguousContentResponses = 1;
    let facet = "table-ambiguous";
    let { actionId } = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });

    expect(await hooks().applyAction(facet, actionId)).toMatch(/content response lost/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);
    expect(docs.tables()[0].rows).toHaveLength(3);

    // The marker proves the write landed: the retry sends nothing but its cleanup.
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(docs.tables()[0].rows).toHaveLength(3);
    expect(await hooks().applyAction(facet, actionId)).toMatch(/Unknown pending/);
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${tableOf([...TABLE_ROWS, ["a", "b"]])}\n\nAfter\n`);
  });

  it("reads a lost-response table change once", async () => {
    let docs = docsWithBody(tableBody());
    docs.ambiguousContentResponses = 1;
    let facet = "table-lost-response";
    let { actionId } = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
    expect(await hooks().applyAction(facet, actionId)).toMatch(/content response lost/);

    // Past the snapshot TTL the read fetches the document, which holds the row while its
    // action is still pending.
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${tableOf([...TABLE_ROWS, ["a", "b"]])}\n\nAfter\n`);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
  });
});

// An approval lists the pending edits and then awaits Google, and a write can be stored during
// any of those waits. These tests hold a provider request open to store one there. They stand
// after the restart test above: the runtime does not survive a restart of the Durable Objects
// that follows a held request.
describe("Google Doc table changes stored during an approval", () => {
  // An edit stored while the approval waits for the document was recorded behind the one being
  // approved, like any other, though the approval listed the pending edits before it.
  it("drops a table change stored while the one before it was failing at approval", async () => {
    let docs = twoTables();
    let facet = "table-gate-apply-late";
    let first = await queueFirst(facet);
    // The snapshot is fresh, so the next write asks Google nothing.
    expect(await hooks().readContent(facet)).toBe(
      TWO_CONTENT.replace("</table>", `${rowOf("a", "b")}\n</table>`));
    docs.externalCellEdit(0, 0, 0, "Chore");
    let read = docs.hold("read");

    let applying = hooks().applyAction(facet, first.actionId);
    await read.reached;
    let second = await queueSecond(facet);
    read.release();

    expect(await applying).toBe(gone("insertTableRows"));
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    await hooks().rejectAction(facet, first.actionId);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // The replay after a write runs over the refreshed document, where `first` fails. `second` was
  // stored after the approval listed its edits, so it is dropped with `first` only if they are
  // listed again for that replay.
  it("replays a table change stored while the one before it was being written", async () => {
    let docs = twoTables();
    let facet = "table-gate-write-late";
    let append = await hooks().submitAppend(facet, "note");
    let first = await queueFirst(facet);
    await hooks().readContent(facet);
    let content = docs.hold("content");
    let cleanup = docs.hold("cleanup");

    let applying = hooks().applyAction(facet, append);
    await content.reached;
    let second = await queueSecond(facet);
    content.release();
    // The append is written, its marker not yet removed.
    await cleanup.reached;
    docs.externalCellEdit(0, 0, 0, "Chore");
    cleanup.release();

    expect(await applying).toBeNull();
    expect(await hooks().applyAction(facet, first.actionId)).toContain(gone("insertTableRows"));
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    await hooks().rejectAction(facet, first.actionId);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(1);
  });
});

// The write queue belongs to the document, not to a session: a call takes its turn behind the
// calls made before it, from whichever session it comes. The test holds a provider request, so it
// stands after the restart test like the ones above.
describe("Google Doc writes from several sessions", () => {
  // Every call below is a session of its own. With a queue for each session the replacement is
  // checked while the append it quotes still waits for Google, and is refused for text the tab
  // does not hold; the second append is stored first, and the read shows only that one.
  it("takes the calls of different sessions in the order they were made", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Start");
    docs.install();
    let facet = "write-order-sessions";
    await hooks().readContent(facet);
    // Past the snapshot's time to live a write asks Google for the revision: the first one's
    // request is held, inside its turn.
    passSnapshotTtl();
    let probe = docs.hold("read");

    let first = edit(facet, "appendText", "one");
    await probe.reached;
    let second = edit(facet, "replaceText", "one", "two");
    let third = edit(facet, "appendText", "three");
    let reading = Promise.resolve(hooks().readContent(facet));
    let settled: string[] = [];
    for (let [name, call] of Object.entries({ second, third, reading })) {
      let note = () => { settled.push(name); };
      call.then(note, note);
    }
    // Listing the tabs takes no turn, so it answers while the first write is held. The pause
    // after it gives the three calls sent before it the time to settle, if nothing held them.
    expect(await hooks().listTabs(facet)).toHaveLength(1);
    await scheduler.wait(20);
    expect(settled).toEqual([]);
    expect(await hooks().storedValueJsonLength(facet, "pending:action:1")).toBeUndefined();
    probe.release();

    let queued = await Promise.all([first, second, third]);
    expect(queued.map(({ actionId }) => actionId)).toEqual([1, 2, 3]);
    // The replacement found the text of the append before it, and the read waited for all three.
    let read = await reading;
    expect(read).toBe("Start\n\ntwo\n\nthree\n");

    for (let { actionId } of queued) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(read);
    expect(docs.contentBatches).toBe(3);
  });
});

// The rendering before the current one differs from it only inside tables, where it could queue
// nothing, so the text edits it previewed still apply as previewed.
describe("Google Doc edits stored under an earlier rendering", () => {
  const PREVIOUS_RENDERING = 6;
  const STRUCTURED = "replaceText: structured content cannot be edited";
  const previous = (action: Record<string, unknown>) =>
    [storedAction(1, { ...action, markdownVersion: PREVIOUS_RENDERING })];

  it("applies a text replacement stored under the previous rendering", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "previous-rendering-replace";
    await hooks().applyStorage(
      facet, previous({ type: "replaceText", oldMarkdown: "base", newMarkdown: "changed" }));

    expect(await hooks().readContent(facet)).toBe("changed\n");
    expect(await hooks().applyAction(facet, 1)).toBeNull();
    expect(docs.text()).toBe("changed");
  });

  it("applies an append stored under the previous rendering", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "previous-rendering-append";
    await hooks().applyStorage(facet, previous({ type: "appendText", markdown: "added" }));

    expect(await hooks().readContent(facet)).toBe("base\n\nadded\n");
    expect(await hooks().applyAction(facet, 1)).toBeNull();
    expect(docs.text()).toBe("base\nadded");
  });

  it("keeps a previous-rendering replacement out of tables", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "previous-rendering-cell";
    await hooks().applyStorage(
      facet, previous({ type: "replaceText", oldMarkdown: "Open", newMarkdown: "Done" }));

    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT);
    expect(await hooks().applyAction(facet, 1)).toContain(STRUCTURED);
    expect(docs.contentBatches).toBe(0);
  });

  // Its card showed Markdown, so it is never applied as the HTML of a cell.
  it("keeps a replacement queued for a paragraph out of tables", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "paragraph-replacement-cell";
    await hooks().applyStorage(facet, [
      storedAction(1, { type: "replaceText", oldMarkdown: "Open", newMarkdown: "**Done**" }),
    ]);

    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT);
    expect(await hooks().applyAction(facet, 1)).toContain(STRUCTURED);
    expect(docs.contentBatches).toBe(0);
  });

  // The previous rendering could queue no table change, so nothing vouches for one stored under it.
  it("refuses a table change stored under the previous rendering", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "previous-rendering-table";
    await hooks().applyStorage(facet, previous({
      type: "insertTableRows", at: 2, cells: [["a", "b"]], expected: tableOf(TABLE_ROWS),
    }));

    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT);
    expect(await hooks().applyAction(facet, 1))
      .toContain("was queued under an earlier Markdown format");
    expect(docs.contentBatches).toBe(0);
  });

  it("drops a table replacement whose text left the table", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-replacement-moved";
    let { actionId } = await edit(facet, "replaceText", "Fix login", "Fix logout");
    expect(await hooks().readContent(facet)).toContain("<td><p>Fix logout</p></td>");

    docs.externalBody(MAIN_TAB, buildTab([
      paragraph("Fix login"), table(["Task", "Status"], ["Other", "Open"]), paragraph("After"),
    ]).body);
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(
      `Fix login\n\n${tableOf([["Task", "Status"], ["Other", "Open"]])}\n\nAfter\n`);
    expect(await hooks().applyAction(facet, actionId)).toContain(
      "replaceText: this change was queued for text in a table, and that text is no longer " +
      "in one.");
    expect(docs.contentBatches).toBe(0);
  });

  // The seed is one a read would serve but for its version: fresh, at the document's revision,
  // and reading text the document does not hold. A stale seed would be refetched either way.
  it("discards a snapshot cached under the previous rendering", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let seed = (formatVersion: number) => [{
      kind: "put" as const,
      key: "docSnapshot",
      value: {
        formatVersion, title: "Test document", revisionId: "revision-1",
        tabs: [tabSnapshot(MAIN_TAB, "Main")], fetchedAt: Date.now(),
      },
    }];

    await hooks().applyStorage("previous-rendering-snapshot", seed(PREVIOUS_RENDERING));
    expect(await hooks().readContent("previous-rendering-snapshot")).toBe("base\n");
    expect(docs.documentFetches).toBe(1);
    expect(docs.revisionProbes).toBe(0);

    // The same value under the current rendering is served, so the fetch above was the version's.
    await hooks().applyStorage("current-rendering-snapshot", seed(MARKDOWN_RENDERING_VERSION));
    expect(await hooks().readContent("current-rendering-snapshot")).toBe("shared\n");
    expect(docs.documentFetches).toBe(1);
  });
});

describe("Google Doc metadata", () => {
  it("holds the modification time steady while the document is unchanged", async () => {
    let docs = new DocsModel();
    docs.install();

    let first = await hooks().readMetadata("metadata");
    await scheduler.wait(2);
    let second = await hooks().readMetadata("metadata");

    expect(second).toBe(first);

    docs.externalEdit();
    expect(await hooks().readMetadata("metadata")).toBeGreaterThan(first);
  });

  it("reports a pending edit as the latest modification", async () => {
    let docs = new DocsModel();
    docs.install();
    let baseline = await hooks().readMetadata("metadata-pending");
    await scheduler.wait(2);

    await hooks().submitAppend("metadata-pending", "first");

    expect(await hooks().readMetadata("metadata-pending")).toBeGreaterThan(baseline);
  });

  // Without edit access Google reports no revision, so Drive's own timestamp is the only signal
  // that a collaborator changed anything.
  it("reports Drive's modification time when there is no revision", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    let first = await hooks().readMetadata("metadata-read-only");
    expect(first).toBe(new Date("2026-01-02T03:04:05Z").valueOf());

    await scheduler.wait(2);
    expect(await hooks().readMetadata("metadata-read-only")).toBe(first);

    docs.driveModifiedTime = "2026-01-02T04:00:00Z";
    expect(await hooks().readMetadata("metadata-read-only"))
      .toBe(new Date("2026-01-02T04:00:00Z").valueOf());
  });

  it("holds the modification time steady when Drive metadata is not granted", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = { status: 403, reason: "insufficientPermissions" };
    docs.install();

    let first = await hooks().readMetadata("metadata-no-drive");
    await scheduler.wait(2);

    expect(await hooks().readMetadata("metadata-no-drive")).toBe(first);
    expect(docs.driveFetches).toBe(2);
  });

  // Dating the document from a transient failure would report it unchanged for as long as Drive
  // stayed unhealthy, and the stored observation would outlive the incident.
  it.each([
    ["an outage", "metadata-drive-outage", { status: 500 }],
    ["a quota refusal", "metadata-drive-quota", { status: 403, reason: "userRateLimitExceeded" }],
    ["a malformed reply", "metadata-drive-malformed", "malformed"],
  ] as const)("fails a metadata read rather than dating a document from %s", async (
    _case, facetName, failure,
  ) => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = failure;
    docs.install();

    await expect(Promise.resolve(hooks().readMetadata(facetName))).rejects.toThrow();

    docs.driveFailure = null;
    expect(await hooks().readMetadata(facetName))
      .toBe(new Date("2026-01-02T03:04:05Z").valueOf());
  });
});

// Google withholds revisionId from a caller without edit access, which is the ordinary case for
// a Doc shared read-only.
describe("Google Doc with no revision ID", () => {
  it("reuses its snapshot inside the TTL and refetches once expired", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    await hooks().readContent("no-revision");
    await hooks().readContent("no-revision");
    expect(docs.documentFetches).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    docs.externalEdit(MAIN_TAB, "collaborator edit");

    expect(await hooks().readContent("no-revision")).toContain("collaborator edit");
    expect(docs.documentFetches).toBe(2);
    // Nothing to compare, so the probe is not worth a request.
    expect(docs.revisionProbes).toBe(0);
  });
});

/** A nested document whose three tabs all hold the same text, so an edit cannot be mistaken. */
function nestedDocs(): DocsModel {
  let docs = new DocsModel();
  docs.setText(MAIN_TAB, "shared");
  docs.addTab("details", "Details", MAIN_TAB, "shared");
  docs.addTab("metrics", "Metrics", "details", "shared");
  docs.install();
  return docs;
}

describe("Google Doc tab isolation", () => {
  it("lists the tab tree and appends only to the tab it names", async () => {
    let docs = nestedDocs();

    expect(await hooks().listTabs("tabs-append")).toEqual([
      { id: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { id: "details", title: "Details", parentTabId: MAIN_TAB, index: 0, nestingLevel: 1 },
      { id: "metrics", title: "Metrics", parentTabId: "details", index: 0, nestingLevel: 2 },
    ]);

    let actionId = await hooks().submitAppend("tabs-append", "added", "metrics");
    expect(await hooks().readContent("tabs-append", "metrics")).toContain("added");
    expect(await hooks().readContent("tabs-append", MAIN_TAB)).not.toContain("added");

    expect(await hooks().applyAction("tabs-append", actionId)).toBeNull();

    // The marker must be anchored in the tab that was edited: a marker left in another tab is
    // invisible to the retry lookup, which would re-apply the write after a lost response.
    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("replaces identical text in the selected tab only", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitReplace("tabs-replace", "shared", "changed", "metrics");

    expect(await hooks().applyAction("tabs-replace", actionId)).toBeNull();

    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toBe("changed");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("submits nothing for an omitted or unknown tab", async () => {
    let docs = nestedDocs();

    await expect(Promise.resolve(hooks().submitAppend("tabs-selector", "added")))
      .rejects.toThrow(/tabId is required for documents with multiple tabs/);
    await expect(Promise.resolve(
      hooks().submitReplace("tabs-selector", "shared", "changed", "ghost"),
    )).rejects.toThrow(/no tab with ID "ghost"/);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text("metrics")).toBe("shared");
  });

  // A failed edit still tells the caller whether a tab, or the text in it, exists. Leaving the
  // write paths ungated would let a caller ask through appendText what getContent refuses.
  it.each([
    ["an omitted tab", () => hooks().submitAppend("tabs-write-oracle", "added"),
      /tabId is required for documents with multiple tabs/],
    ["an unknown tab", () => hooks().submitAppend("tabs-write-oracle", "added", "ghost"),
      /no tab with ID "ghost"/],
    ["unmatched text",
      () => hooks().submitReplace("tabs-write-oracle", "absent", "changed", "metrics"),
      /was not found in the current simulated tab/],
  ] as const)("authorizes a generic observation when an edit fails on %s", async (
    _case, submit, message,
  ) => {
    let docs = nestedDocs();

    await expect(Promise.resolve(submit())).rejects.toThrow(message);

    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(docs.contentBatches).toBe(0);
  });

  it("is not suppressed by a same-named write marker in another tab", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = nestedDocs();
    docs.addMarker("gadgets-write-fixed-write-id", "other-1", MAIN_TAB);

    let actionId = await hooks().submitAppend("tabs-foreign-marker", "added", "metrics");
    expect(await hooks().applyAction("tabs-foreign-marker", actionId)).toBeNull();

    expect(docs.contentBatches).toBe(1);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
  });

  it("refuses an edit whose tab is deleted before approval", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitAppend("tabs-deleted", "added", "metrics");

    docs.removeTab("metrics");
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");

    // Approving it again must not report success for a write that never happened, and must not
    // decay into "unknown action" either — rejecting is the way out.
    let repeated = "Pending Google Doc edit could not be applied: " +
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.";
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  // Actions are approved in one global order, but each replays against only its own tab, so
  // neither edit may shift or shadow the other.
  it("replays edits queued on different tabs independently", async () => {
    let docs = nestedDocs();
    let metricsId = await hooks().submitAppend("tabs-interleaved", "alpha", "metrics");
    let mainId = await hooks().submitAppend("tabs-interleaved", "beta", MAIN_TAB);

    let metricsPreview = await hooks().readContent("tabs-interleaved", "metrics");
    let mainPreview = await hooks().readContent("tabs-interleaved", MAIN_TAB);
    expect(metricsPreview).toContain("alpha");
    expect(metricsPreview).not.toContain("beta");
    expect(mainPreview).toContain("beta");
    expect(mainPreview).not.toContain("alpha");

    expect(await hooks().applyAction("tabs-interleaved", metricsId)).toBeNull();
    expect(await hooks().applyAction("tabs-interleaved", mainId)).toBeNull();

    expect(docs.text("metrics")).toBe("shared\nalpha");
    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("details")).toBe("shared");
  });

  it("invalidates only the edit whose own tab moved", async () => {
    let docs = nestedDocs();
    await hooks().submitReplace("tabs-invalidate", "shared", "changed", "metrics");
    let mainId = await hooks().submitAppend("tabs-invalidate", "beta", MAIN_TAB);
    // A collaborator rewrites Metrics, so the replace no longer matches. The append targets a
    // different tab whose text never moved, so it must survive and stop waiting behind it.
    docs.externalEdit("metrics", "rewritten");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let metricsPreview = await hooks().readContent("tabs-invalidate", "metrics");
    expect(metricsPreview).not.toContain("changed");
    expect(metricsPreview).not.toContain("beta");
    expect(await hooks().readContent("tabs-invalidate", MAIN_TAB)).toContain("beta");

    expect(await hooks().applyAction("tabs-invalidate", mainId)).toBeNull();

    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("metrics")).toBe("rewritten");
  });

  // Titles are user-authored, need not be unique and may be empty, so the approval a user
  // consents to has to carry the ID the write actually targets.
  it("names the target tab by ID when two tabs share a title", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "shared");
    docs.addTab("notes-a", "Notes", MAIN_TAB, "shared");
    docs.addTab("notes-b", "Notes", MAIN_TAB, "shared");
    docs.install();

    await hooks().submitAppend("tabs-duplicate-title", "added", "notes-b");

    expect(await hooks().lastActionDescription).toContain('tab "Notes" (notes-b)');
  });
});

function tabSnapshot(tabId: string, title: string) {
  return {
    tabId, title, index: 0, nestingLevel: 0,
    markdown: "shared\n", sourceMap: { blocks: [], protectedRanges: [], tables: [] }, bodyEndIndex: 8,
    committedWriteIds: [],
  };
}

// A stored edit with no tab predates tab support. No current write path produces one, so this is
// the only place the migration refusal can be reached.
describe("Google Doc edits stored before tab support", () => {
  const snapshot = {
    formatVersion: MARKDOWN_RENDERING_VERSION as typeof MARKDOWN_RENDERING_VERSION,
    title: "Test document",
    revisionId: "revision-1",
    tabs: [tabSnapshot(MAIN_TAB, "Main")],
    fetchedAt: 0,
  };

  const storedAppend = {
    type: "appendText" as const,
    documentId: "doc-1",
    submittedAt: 0,
    baseRevisionId: "revision-1",
    markdown: "added",
  };

  // The old code refused to read a multi-tab document, so a stored record was approved against
  // the one tab such a document had.
  it("retargets a record naming no tab when the document still has exactly one", () => {
    expect(googleDocActionTab(snapshot, storedAppend).tabId).toBe(MAIN_TAB);
  });

  it("refuses a record naming no tab once the document has gained tabs", () => {
    let grown = { ...snapshot, tabs: [...snapshot.tabs, tabSnapshot("second", "Second")] };
    expect(() => googleDocActionTab(grown, storedAppend)).toThrow(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  });

  it("refuses a vanished tab rather than retargeting to the first", () => {
    expect(() => googleDocActionTab(snapshot, { ...storedAppend, tabId: "ghost" })).toThrow(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
  });

  it("resolves a record that names a live tab", () => {
    expect(googleDocActionTab(snapshot, { ...storedAppend, tabId: MAIN_TAB }).title).toBe("Main");
  });
});

const DOC_PATTERN = "https://docs.google.com/document/d/:docId/*";
const CREATED_DOC_URL = "https://docs.google.com/document/d/doc-1/edit";

/** The bearer token the test worker's `UserAccount` named `userName` hands out. */
function tokenOf(userName: string): string {
  return `Bearer test-access-token:${env.USER_ACCOUNT.idFromName(userName)}`;
}

describe("creating a Google Doc", () => {
  it("simulates a blank document, then creates it and applies the edit queued against it", async () => {
    let docs = new DocsModel();
    docs.install();

    let created = await hooks().createResource("create-doc", DOC_PATTERN, "Plan");
    expect(created).toMatchObject({
      action: {
        title: "Create Google Doc: Plan",
        fields: [{ label: "Title", kind: "inline", value: "Plan" }],
        implementsRevert: false,
        autoApprovable: false,
      },
    });
    expect(created).not.toHaveProperty("action.actionKind");
    expect(await hooks().describe("create-doc"))
      .toMatchObject({ title: "Plan", url: "https://docs.google.com/document/" });
    expect(await hooks().readContent("create-doc")).toBe("\n");
    expect((await hooks().listTabs("create-doc")).map(tab => tab.id)).toEqual(["t.0"]);
    let actionId = await hooks().submitAppend("create-doc", "added");
    expect(await hooks().readContent("create-doc")).toBe("added\n");
    expect(await hooks().applyAction("create-doc", actionId)).toMatch(/doesn't exist yet/);
    expect(docs.fetches).toBe(0);

    expect(await hooks().applyCreation("create-doc")).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toEqual([{ title: "Plan" }]);
    await hooks().adoptCreated("create-doc");

    // The model's only tab is "tab-1", so the edit replays only if it was moved off "t.0".
    expect(await hooks().readContent("create-doc")).toBe("added\n");
    expect(await hooks().describe("create-doc"))
      .toMatchObject({ title: "Test document", url: CREATED_DOC_URL });
    expect(await hooks().applyAction("create-doc", actionId)).toBeNull();
    expect(docs.text()).toBe("added");
    expect(await hooks().applyCreation("create-doc"))
      .toEqual({ error: "This Google Doc already exists." });
  });

  it("moves an edit queued after creation, before the restart, onto the created tab", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().createResource("create-doc-late-edit", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-late-edit"))
      .toEqual({ resourceUrl: CREATED_DOC_URL });
    let actionId = await hooks().submitAppend("create-doc-late-edit", "late");
    await hooks().adoptCreated("create-doc-late-edit");

    expect(await hooks().applyAction("create-doc-late-edit", actionId)).toBeNull();
    expect(docs.text()).toBe("late");
    expect(docs.markerTabIds).toEqual([MAIN_TAB]);
  });

  it("binds the same document when an approval is retried after a lost success", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().createResource("create-doc-retry", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-retry")).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(await hooks().applyCreation("create-doc-retry")).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(1);
  });

  it("creates one document for two concurrent approvals", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().createResource("create-doc-concurrent", DOC_PATTERN, "Plan");
    let create = docs.hold("create");

    let first = hooks().applyCreation("create-doc-concurrent");
    await create.reached;
    let second = hooks().applyCreation("create-doc-concurrent");
    await scheduler.wait(5);
    create.release();

    expect(await first).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(await second).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(1);
  });

  it("does not create again when reading the new document back fails", async () => {
    let docs = new DocsModel();
    docs.readFailures = 1;
    docs.install();
    await hooks().createResource("create-doc-readback", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-readback"))
      .toEqual({ error: "Google Docs get document failed [http=404]" });
    expect(await hooks().applyCreation("create-doc-readback")).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(1);
  });

  it("creates again after Google refused the create", async () => {
    let docs = new DocsModel();
    docs.createFailures = 1;
    docs.install();
    await hooks().createResource("create-doc-refused", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-refused"))
      .toEqual({ error: "Google Docs create document failed [http=403]" });
    expect(await hooks().applyCreation("create-doc-refused")).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(2);
  });

  // What the first approval completing would have done: the document is already in user-a's Drive.
  it("binds the first approver's account when a different approver retries", async () => {
    let docs = new DocsModel();
    docs.readFailures = 1;
    docs.install();
    await hooks().createResource("create-doc-approvers", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-approvers", "user-a")).toHaveProperty("error");
    expect(await hooks().applyCreation("create-doc-approvers", "user-b"))
      .toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(1);
    await hooks().adoptCreated("create-doc-approvers");
    await hooks().readContent("create-doc-approvers");

    expect(new Set(docs.authorizations)).toEqual(new Set([tokenOf("user-a")]));
  });

  it("applies a table queued against a document not created yet", async () => {
    // What a new document holds: one empty paragraph.
    let docs = docsWithBody(buildTab([paragraph("")]).body);
    let facet = "create-doc-table";
    await hooks().createResource(facet, DOC_PATTERN, "Plan");

    let added = await edit(
      facet, "insertTable", { rows: 1, columns: 2, cells: [["Name", "Total"]] });
    expect(added.returned).toBe(0);
    expect(await hooks().lastObservations).toEqual(
      ['Read the position of a new table among the tables of tab "Tab 1" (t.0).']);
    let rows = await edit(
      facet, "insertTableRows", { table: added.returned, cells: [["Ana", "3"]] });
    let preview = `\n\n${tableOf([["Name", "Total"], ["Ana", "3"]])}\n\n\n`;
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.fetches).toBe(0);

    expect(await hooks().applyCreation(facet)).toEqual({ resourceUrl: CREATED_DOC_URL });
    await hooks().adoptCreated(facet);

    expect(await hooks().readContent(facet)).toBe(preview);
    expect(await hooks().applyAction(facet, added.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    expect(docs.tables().map(({ rows: tableRows }) => tableRows.length)).toEqual([2]);
    expect([docs.cellText(0, 0, 0), docs.cellText(0, 1, 1)]).toEqual(["Name", "3"]);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
  });
});

describe("appending to an empty Google Doc", () => {
  it("fills the empty paragraph instead of following it", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("empty-doc-append", "added");

    expect(await hooks().readContent("empty-doc-append")).toBe("added\n");
    expect(await hooks().applyAction("empty-doc-append", actionId)).toBeNull();
    expect(docs.text()).toBe("added");
    expect(await hooks().readContent("empty-doc-append")).toBe("added\n");
  });

  // The replace leaves the simulation empty, but the real tab keeps its final, now empty, paragraph.
  it("fills the paragraph a pending replace emptied", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "hello");
    docs.install();
    let replaceId = await hooks().submitReplace("emptied-doc-append", "hello\n", "");
    let appendId = await hooks().submitAppend("emptied-doc-append", "added");
    let preview = await hooks().readContent("emptied-doc-append");

    expect(preview).toBe("added\n");
    expect(await hooks().applyAction("emptied-doc-append", replaceId)).toBeNull();
    expect(await hooks().applyAction("emptied-doc-append", appendId)).toBeNull();
    expect(docs.text()).toBe("added");
    expect(await hooks().readContent("emptied-doc-append")).toBe(preview);
  });

  // A chip with no label renders as nothing, yet its paragraph is not empty: the append follows it.
  it("follows a paragraph whose only content is an unlabelled chip", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [{ date: "" }, "\n"] }]).body);
    docs.install();
    let actionId = await hooks().submitAppend("chip-doc-append", "added");

    expect(await hooks().readContent("chip-doc-append")).toBe("\n\nadded\n");
    expect(await hooks().applyAction("chip-doc-append", actionId)).toBeNull();
    expect(docs.text()).toBe("\nadded");
  });
});

// Docs reads a .docx as though it were native and refuses only edits, so describe() asks Drive.
describe("a Google Doc that is an Office file", () => {
  it("refuses to describe a file Drive reports as an Office document", async () => {
    let docs = new DocsModel();
    docs.driveMimeType = DOCX;
    docs.install();

    await expect(Promise.resolve(hooks().describe("office-docx")))
      .rejects.toThrow(officeFileError("doc").message);
    expect(docs.driveFetches).toBe(1);
  });

  it("describes a native Doc after Drive confirms its type", async () => {
    let docs = new DocsModel();
    docs.driveMimeType = "application/vnd.google-apps.document";
    docs.install();

    expect(await hooks().describe("office-native"))
      .toMatchObject({ title: "Test document", url: "https://docs.google.com/document/d/doc-1/edit" });
    expect(docs.driveFetches).toBe(1);
  });

  it.each([
    ["a grant without the Drive scope", { status: 403, reason: "insufficientPermissions" }],
    ["a Drive outage", { status: 500 }],
  ] as const)("describes the document as it reads when Drive cannot answer, as with %s", async (
    _case, failure,
  ) => {
    let docs = new DocsModel();
    docs.driveFailure = failure;
    docs.install();

    expect(await hooks().describe(`office-drive-${failure.status}`))
      .toMatchObject({ title: "Test document" });
  });

  it("explains an approved edit Google refuses on a bound Office file", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("office-edit", "added");
    docs.driveMimeType = DOCX;
    docs.refusesEdits = true;

    let message = await hooks().applyAction("office-edit", actionId);

    expect(message).toBe(officeFileError("doc").message);
    expect(message).not.toContain(OFFICE_REFUSAL);
    expect(docs.text()).toBe("");
  });

  it("keeps Google's status for a refused edit on a native Doc", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("office-edit-native", "added");
    docs.driveMimeType = "application/vnd.google-apps.document";
    docs.refusesEdits = true;

    expect(await hooks().applyAction("office-edit-native", actionId))
      .toBe("Google Docs batch update document failed [http=400]");
  });
});

describe("Google Doc comments", () => {
  const DOC_COMMENTS = { tag: "docComments", label: "Google Doc comments" };
  const TEXT = "The launch is in May. Costs are final.";
  const call = (facet: string, method: string, ...args: unknown[]) =>
    hooks().callDoc(facet, method as keyof GoogleDocSession, args);

  function model(text = TEXT): DocsModel {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, text);
    docs.install();
    return docs;
  }

  it("queues a comment on quoted text, lists it pending, and posts it attached there", async () => {
    let docs = model();
    let queued = await call("comment-flow", "comment", "Should this be June?",
      { quote: "The launch is in May." });
    expect(queued.error).toBeUndefined();
    expect(queued.value).toMatchObject({
      id: `pending:${queued.actionId}`, text: "Should this be June?",
      quotedText: "The launch is in May.", resolved: false, replies: [], pending: true,
    });
    expect(queued.action).toMatchObject({
      title: "Comment on a Google Doc", actionKind: DOC_COMMENTS, autoApprovable: true,
    });
    expect(queued.action!.fields).toEqual([
      { label: "Comment", kind: "text", value: "Should this be June?" },
      { label: "Quoted text", kind: "text", value: "The launch is in May." },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Test document" },
      { label: "Tab", kind: "inline", value: MAIN_TAB },
    ]);
    expect(queued.reports).toEqual([
      { title: "Read Google Doc content", subresources: ["docs/document/doc-1"] },
    ]);

    let listed = await call("comment-flow", "listComments");
    expect(listed.value).toEqual([expect.objectContaining({ id: `pending:${queued.actionId}` })]);
    expect(listed.reports).toEqual([
      { title: "List Google Doc comments", subresources: ["docs/document/doc-1"] },
    ]);

    expect(await hooks().applyAction("comment-flow", queued.actionId!)).toBeNull();
    expect(docs.threads).toEqual([expect.objectContaining({
      anchorId: expect.any(String), plainTextQuote: "The launch is in May.",
      headPost: expect.objectContaining({ content: "Should this be June?" }),
    })]);
    expect((await call("comment-flow", "listComments")).value).toEqual([expect.objectContaining({
      id: docs.threads[0].commentId, text: "Should this be June?",
      quotedText: "The launch is in May.", author: { displayName: "Me", me: true },
    })]);
    // Approving it again posts nothing more.
    expect(await hooks().applyAction("comment-flow", queued.actionId!)).toBeNull();
    expect(docs.commentWrites).toBe(1);
  });

  it("replies to, resolves and reopens someone else's comment, each from queue to apply", async () => {
    let docs = model();
    let theirs = docs.addThread("Is this date right?", { quote: "May" });

    let reply = await call("comment-answers", "reply", theirs.commentId, "Yes, it is.");
    expect(reply.value).toMatchObject({ id: `pending:${reply.actionId}`, text: "Yes, it is.", pending: true });
    expect(reply.action).toMatchObject({ title: "Reply to a Google Doc comment", actionKind: DOC_COMMENTS });
    expect(reply.action!.description).toContain("Reply to a comment on Google Doc `doc-1`");
    expect(reply.action!.fields).toEqual(expect.arrayContaining([
      { label: "Comment author", kind: "inline", value: "Ada Lovelace" },
      { label: "Comment text", kind: "text", value: "Is this date right?" },
    ]));
    let listed = (await call("comment-answers", "listComments")).value as { replies: unknown[] }[];
    expect(listed[0].replies).toEqual([expect.objectContaining({ id: `pending:${reply.actionId}` })]);
    expect(await hooks().applyAction("comment-answers", reply.actionId!)).toBeNull();
    expect(theirs.replies.map(post => post.content)).toEqual(["Yes, it is."]);

    let resolve = await call("comment-answers", "resolve", theirs.commentId, "Done.");
    expect(resolve.action).toMatchObject({ title: "Resolve a Google Doc comment" });
    expect(await hooks().applyAction("comment-answers", resolve.actionId!)).toBeNull();
    expect(theirs.status).toBe("RESOLVED");
    expect(theirs.replies.at(-1)).toMatchObject({ content: "Done.", commentAction: "RESOLVE" });
    expect((await call("comment-answers", "resolve", theirs.commentId)).error)
      .toBe("That comment is already resolved.");

    // A reply to a resolved comment reopens it, and its card says so.
    let reopen = await call("comment-answers", "reply", theirs.commentId, "One more thing.");
    expect(reopen.value).toMatchObject({ action: "reopen" });
    expect(reopen.action!.description).toContain("This reopens the resolved comment.");
    expect(await hooks().applyAction("comment-answers", reopen.actionId!)).toBeNull();
    expect(theirs.status).toBe("OPEN");
    expect(theirs.replies.at(-1)).toMatchObject({ content: "One more thing.", commentAction: "REOPEN" });
  });

  it("suggests an edit with a note, as one suggestion with the note on its thread", async () => {
    let docs = model();
    let queued = await call("comment-suggest", "suggestEdit", "May", "June", { note: "It moved." });
    expect(queued.value).toMatchObject({
      id: `pending:${queued.actionId}`, tabId: MAIN_TAB, oldText: "May", newText: "June",
      note: "It moved.", pending: true,
    });
    expect(queued.action).toMatchObject({ title: "Suggest an edit in a Google Doc", actionKind: DOC_COMMENTS });
    expect(await hooks().applyAction("comment-suggest", queued.actionId!)).toBeNull();
    expect(docs.suggestions).toEqual([
      { suggestionId: "suggest.s1", summaryText: "Replace: “May” with “June”", notes: ["It moved."] },
    ]);
    expect(docs.text()).toBe(TEXT);
  });

  it("refuses an answer to a comment attached to no text, naming the Drive connection last", async () => {
    let docs = model();
    let drive = docs.addThread("Whole-file remark");
    let refusal = "That comment is attached to no text in the Doc (it was made in Google Drive, " +
      "or on the whole file), and Google Docs takes replies only to comments attached to text. " +
      "A Google Drive connection to the file with read and write access can answer it. Request " +
      "one with this resource URL: https://drive.google.com/file/d/doc-1/view?access=write";
    expect((await call("comment-unanchored", "reply", drive.commentId, "Noted.")).error).toBe(refusal);
    expect((await call("comment-unanchored", "resolve", drive.commentId)).error).toBe(refusal);
    // It is still listed, with no quote.
    let listed = (await call("comment-unanchored", "listComments")).value as { quotedText?: string }[];
    expect(listed).toEqual([expect.objectContaining({ id: drive.commentId, text: "Whole-file remark" })]);
    expect(listed[0]).not.toHaveProperty("quotedText");
    expect(docs.commentWrites).toBe(0);
  });

  it("holds a reply and a resolve's words to the Docs limit of 2048 bytes", async () => {
    let docs = model();
    let theirs = docs.addThread("Date?", { quote: "May" });
    let refusal = "The reply is 2050 bytes of UTF-8; Google Docs allows at most 2048.";
    expect((await call("comment-limit", "reply", theirs.commentId, "é".repeat(1025))).error).toBe(refusal);
    expect((await call("comment-limit", "resolve", theirs.commentId, "é".repeat(1025))).error).toBe(refusal);
    expect((await call("comment-limit", "reply", theirs.commentId, "é".repeat(1024))).error).toBeUndefined();
  });

  it("refuses a viewer every comment read and write, in its own words", async () => {
    let docs = model();
    docs.canComment = false;
    let viewOnly = "The connected account can only view this Google Doc, and Google shows a " +
      "Doc's comments only to accounts that can comment on it, so they can be neither read nor " +
      "written here.";
    expect((await call("comment-viewer", "listComments")).error).toBe(viewOnly);
    expect((await call("comment-viewer", "comment", "Hm.", { quote: "May" })).error).toBe(viewOnly);
    expect((await call("comment-viewer", "suggestEdit", "May", "June")).error).toBe(viewOnly);
    expect(docs.commentWrites).toBe(0);
  });

  it("matches a quote against the saved Doc, refusing text only a pending edit has", async () => {
    let docs = model();
    let edit = await hooks().submitReplace("comment-pending-quote", "May", "June");
    let result = await call("comment-pending-quote", "comment", "Sure?", { quote: "June" });
    expect(result.error).toBe("That text is only in an edit waiting for approval, and a comment " +
      "or suggestion is placed on the Doc as Google has saved it. Quote text the Doc has now, or " +
      "try again once the edit is approved.");
    expect(result.actionId).toBeUndefined();
    expect(await hooks().applyAction("comment-pending-quote", edit)).toBeNull();
    expect((await call("comment-pending-quote", "comment", "Sure?", { quote: "June" })).error)
      .toBeUndefined();
    expect(docs.text()).toContain("June");
  });

  it("requires a tab for a quote in a Doc with several tabs, as the binding's edits do", async () => {
    let docs = model();
    docs.addTab("tab-2", "Notes", MAIN_TAB, "May notes");
    expect((await call("comment-tabs", "comment", "Hm.", { quote: "May notes" })).error).toBe(
      "comment: tabId is required for documents with multiple tabs. Call listTabs() to choose a tab.");
    expect((await call("comment-tabs", "suggestEdit", "May", "June")).error).toBe(
      "suggestEdit: tabId is required for documents with multiple tabs. Call listTabs() to choose a tab.");
    let queued = await call("comment-tabs", "comment", "Hm.", { quote: "May notes", tabId: "tab-2" });
    expect(queued.value).toMatchObject({ quotedText: "May notes" });
  });

  it("routes interleaved edit and comment IDs, unique and rising, while edits keep their order", async () => {
    let docs = model();
    let first = await hooks().submitAppend("comment-ids", "One.");
    let comment = (await call("comment-ids", "comment", "Hm.", { quote: "Costs are final." })).actionId!;
    let second = await hooks().submitAppend("comment-ids", "Two.");
    let reply = docs.addThread("Date?", { quote: "May" });
    let answer = (await call("comment-ids", "reply", reply.commentId, "Yes.")).actionId!;
    expect([first, comment, second, answer]).toEqual([1, 2, 3, 4]);

    // An edit still waits for the edit before it; a comment waits for nothing.
    expect(await hooks().applyAction("comment-ids", second)).toMatch(/must be approved in order/);
    expect(await hooks().applyAction("comment-ids", answer)).toBeNull();
    expect(await hooks().applyAction("comment-ids", first)).toBeNull();
    expect(await hooks().applyAction("comment-ids", second)).toBeNull();
    expect(docs.text()).toBe(`${TEXT}\nOne.\nTwo.`);
    // Rejecting a comment restarts nothing; an unknown ID is refused as before.
    expect(await hooks().rejectAction("comment-ids", comment)).toBeUndefined();
    expect(docs.threads.map(thread => thread.headPost.content)).toEqual(["Date?"]);
    expect(await hooks().applyAction("comment-ids", 99)).toBe("Unknown pending Google Doc action: 99");
  });

  it("finds a reply whose answer was lost, and does not send it again", async () => {
    let docs = model();
    let theirs = docs.addThread("Date?", { quote: "May" });
    let id = (await call("comment-lost", "reply", theirs.commentId, "Yes.")).actionId!;
    docs.lostCommentResponses = 1;
    expect(await hooks().applyAction("comment-lost", id)).toMatch(/did not confirm whether this was posted/);
    expect(await hooks().applyAction("comment-lost", id)).toBeNull();
    expect(theirs.replies.map(post => post.content)).toEqual(["Yes."]);
    expect(docs.commentWrites).toBe(1);
  });

  it("clears a comment write on deny from every state", async () => {
    let docs = model();
    let theirs = docs.addThread("Date?", { quote: "May" });
    // Undecided.
    let undecided = (await call("comment-deny", "comment", "Hm.", { quote: "May" })).actionId!;
    expect(await hooks().rejectAction("comment-deny", undecided)).toBeUndefined();
    // Failed for good: the comment it answers was edited after it was queued.
    let stale = (await call("comment-deny", "reply", theirs.commentId, "Yes.")).actionId!;
    theirs.headPost.content = "Date? (edited)";
    expect(await hooks().applyAction("comment-deny", stale)).toBe(
      "That comment was edited after this was queued. Queue it again to answer the comment as it is now.");
    expect(await hooks().rejectAction("comment-deny", stale)).toBeUndefined();
    // Left with an unknown outcome: its answer was lost and its thread then deleted.
    theirs.headPost.content = "Date?";
    let unknown = (await call("comment-deny", "reply", theirs.commentId, "Yes.")).actionId!;
    docs.lostCommentResponses = 1;
    expect(await hooks().applyAction("comment-deny", unknown)).toMatch(/did not confirm/);
    docs.threads.splice(0);
    expect(await hooks().applyAction("comment-deny", unknown)).toMatch(/can't be checked/);
    expect(await hooks().rejectAction("comment-deny", unknown)).toBeUndefined();
    expect((await call("comment-deny", "listComments")).value).toEqual([]);
    for (let id of [undecided, stale, unknown]) {
      expect(await hooks().applyAction("comment-deny", id)).toBe(`Unknown pending Google Doc action: ${id}`);
    }
  });

  it("lists no comments and takes none on a Doc not created yet, and both once it is", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, TEXT);
    docs.install();
    await hooks().createResource("comment-create", DOC_PATTERN, "Plan");
    expect((await call("comment-create", "getMetadata")).value).toMatchObject({ id: "", title: "Plan" });
    expect((await call("comment-create", "listComments")).value).toEqual([]);
    expect((await call("comment-create", "comment", "Hm.", { quote: "May" })).error).toBe(
      "This Google Doc is not created yet, so it has no text to comment on. Comment once it is created.");
    expect(docs.fetches).toBe(0);
    expect(await hooks().applyCreation("comment-create")).toEqual({ resourceUrl: CREATED_DOC_URL });
    await hooks().adoptCreated("comment-create");
    expect((await call("comment-create", "getMetadata")).value).toMatchObject({ id: "doc-1" });
    let queued = await call("comment-create", "comment", "Hm.", { quote: "May" });
    expect(await hooks().applyAction("comment-create", queued.actionId!)).toBeNull();
    expect(docs.threads).toHaveLength(1);
  });
});
