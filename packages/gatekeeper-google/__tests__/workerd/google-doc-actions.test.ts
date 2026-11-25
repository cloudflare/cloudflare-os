import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import {
  afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from "vitest";
import type { ActionField } from "@gadgets/workshop-shared/gatekeeper";
import {
  docTabToMarkdown, LIST_LEVEL_TOO_DEEP, MARKDOWN_RENDERING_VERSION, POSITIONED_ITEM_BEFORE,
  TABBED_ITEM_BEFORE,
} from "../../src/markdown-converter";
import { officeFileError } from "../../src/office-conversion";
import { DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE } from "../../src/resources";
import {
  blankDocsTab, type DocsRange, type GoogleDocsAddTabRequest, type GoogleDocsBatchRequest,
  type GoogleDocsRequest, type GoogleDocsTab, type NestingLevel, type Paragraph,
} from "../../src/docs-api";
import type { GoogleDocSession } from "../../src/docs-types";
import { applyDocsRequests, replayCost, unindexedTabRefusal } from "../../src/docs-model";
import {
  DOC_COPY_EXPIRY_PASS_KEY, DRIVE_DOC_COPY_EXPIRY_MS, MAX_DRIVE_DOC_COPIES, MAX_DRIVE_DOC_COPY_BYTES,
} from "../../src/docs-copy";
import { DOC_DERIVED } from "../../src/docs-derived";
import {
  DOC_COPY_APPROVAL_GRAIN_MS, DOC_ROW_BYTES, DocPieceError, DocStore, docStoreCost,
} from "../../src/docs-store";
import { DOC_COPY_UNREADABLE, pruneTab } from "../../src/docs-replica";
import { RUN_SIZES } from "../../src/docs-runs";
import { MAX_TAB_TABLE_CELLS } from "../../src/docs-tables";
import type { ModelParagraphStyle } from "../../src/docs-model";
import {
  buildTab, BULLET_LIST, cardField, grid, heading, para, presetLevels, seeded, sized,
  thrownMessage,
} from "../doc-fixture";
import { docsGetResponse } from "../docs-fields";
import { DriveFiles, DOC_MIME as DRIVE_DOC_MIME, FOLDER_MIME } from "../drive-files";
import { serveFakes, type ProviderFake } from "../slides-provider";
import { DOC_REVISION_PIN_MS, DOC_SNAPSHOT_TTL_MS } from "../../src/doc-actions";
import { WIDER } from "../wider-run";
import { GoogleDocEditSessionImpl } from "../../src/docs";

/** A request in a batch: a content change, a tab's add, or a write marker's create or delete. */
type BatchRequest =
  | GoogleDocsBatchRequest
  | { createNamedRange: { name: string; range: DocsRange } }
  | { deleteNamedRange: { namedRangeId: string; tabsCriteria?: { tabIds: string[] } } };

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

/** The tab a request names, as tab bodies index independently; none where it leaves it out. */
function requestTabId(
  request: Exclude<BatchRequest, { deleteNamedRange: unknown } | GoogleDocsAddTabRequest>,
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
  if ("updateTableColumnProperties" in request) {
    return request.updateTableColumnProperties.tableStartLocation.tabId;
  }
  if ("updateTableRowStyle" in request) return request.updateTableRowStyle.tableStartLocation.tabId;
  if ("mergeTableCells" in request) {
    return request.mergeTableCells.tableRange.tableCellLocation.tableStartLocation.tabId;
  }
  if ("unmergeTableCells" in request) {
    return request.unmergeTableCells.tableRange.tableCellLocation.tableStartLocation.tabId;
  }
  if ("updateTableCellStyle" in request) {
    return request.updateTableCellStyle.tableRange.tableCellLocation.tableStartLocation.tabId;
  }
  // A row or column request names its table, and the table's start names the tab.
  let cell = "insertTableRow" in request ? request.insertTableRow.tableCellLocation
    : "insertTableColumn" in request ? request.insertTableColumn.tableCellLocation
    : "deleteTableRow" in request ? request.deleteTableRow.tableCellLocation
    : request.deleteTableColumn.tableCellLocation;
  return cell.tableStartLocation.tabId;
}

/** One tab of the fake document: its content as Google returns it, and its place in the tab tree. */
type ModelTab = {
  id: string;
  title: string;
  parentId?: string;
  body: GoogleDocsTab["body"];
  /** The list definitions the body's paragraphs reference. */
  lists: GoogleDocsTab["lists"];
  namedStyles?: GoogleDocsTab["namedStyles"];
};

/** A body of one paragraph per line of `text`. */
function bodyOfLines(text: string): GoogleDocsTab["body"] {
  return buildTab(text.split("\n").map(line => ({ runs: [`${line}\n`] }))).body;
}

/** The tab a single-tab document has, and the one the tab-agnostic tests exercise. */
const MAIN_TAB = "tab-1";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Google's own words for refusing an Office file, which nothing of ours may repeat. */
const OFFICE_REFUSAL =
  "This operation is not supported for this document. The document must not be an Office file.";

/**
 * A batch either carries the edit and its marker, or deletes a marker on its own; or a create; or
 * a read, whose answer is fixed when it arrives, so holding it delivers what was then current;
 * Drive's batched read of the scope a binding proves an edit's file in.
 * `applied` holds a content batch after Google has applied it, before it answers.
 */
type RequestKind = "content" | "cleanup" | "create" | "read" | "applied" | "scope";

/**
 * The full `documents.get` calls of this test that carried no field mask: 0 at its end, unless
 * Google refused the mask and the read was made again.
 */
let unmaskedFetches = 0;

class DocsModel {
  /** The document this model is, which a fake serving several answers by. */
  documentId = "doc-1";
  /** The document's title, as every read of it answers. */
  title = "Test document";
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  /** How many content batches to fail before Google applies them, as a dropped connection can. */
  unsentContentRequests = 0;
  contentBatches = 0;
  /** The content requests of the last batch applied, without its marker. */
  lastContentRequests: GoogleDocsRequest[] = [];
  maxMarkerCount = 0;
  /**
   * The status of the refusal of a content batch whose `requiredRevisionId` is not the latest
   * revision; `undefined` for a refusal that carries none, which does not say whether the batch
   * applied.
   */
  stalePinStatus: string | undefined = "INVALID_ARGUMENT";
  /** Google withholds `revisionId` from a caller without edit access. */
  editable = true;
  /** Full `documents.get` calls, excluding the lightweight revision probe. */
  documentFetches = 0;
  revisionProbes = 0;
  /** Every provider request, of any kind. */
  fetches = 0;
  /** The UTF-8 length of every request body received, and of every response body sent. */
  requestBytes = 0;
  responseBytes = 0;
  /** The body of each `documents.create` call. */
  readonly creates: unknown[] = [];
  /**
   * How many create calls to refuse with a 403, and reads of the document's tabs (a full read,
   * or one of the tab IDs alone) to answer with a 404, as a read racing a new document's
   * propagation can. Neither is retried by the client.
   */
  createFailures = 0;
  readFailures = 0;
  /**
   * How many full reads that carry a field mask to answer as Google answers a mask it does not
   * take, with a 400. Each counts in `documentFetches`, as the request it is.
   */
  refusedMasks = 0;
  /** The bearer token of each Docs request, which names the account it was made as. */
  readonly authorizations: string[] = [];
  driveFetches = 0;
  /** Drive's modification time for the document. */
  driveModifiedTime = "2026-01-02T03:04:05Z";
  /** What Drive answers with instead of that time, if anything. */
  driveFailure: { status: number; reason?: string } | "malformed" | null = null;
  /**
   * The file's type as Drive reports it, when it reports one: a Drive binding opens the file only
   * as the type it is, so a run through Drive has Drive report it.
   */
  driveMimeType: string | undefined = run.drive ? DOC_MIME : undefined;
  /** Whether Google refuses every content edit as it refuses one to an Office file. */
  refusesEdits = false;
  readonly deletedMarkerIds: string[] = [];
  /** Marker ID to its name and owning tab. */
  readonly markers = new Map<string, { name: string; tabId: string }>();
  /** Tab each write marker was anchored in, retained after cleanup deletes the marker. */
  readonly markerTabIds: string[] = [];
  /** Every tab in preorder; the first is the one a single-tab document has. */
  readonly tabs: ModelTab[] = [
    { id: MAIN_TAB, title: "Main", body: bodyOfLines(""), lists: {} },
  ];
  /** The Doc's comment threads, in the order Docs lists them. */
  readonly threads: ModelThread[] = [];
  /** Suggestions made in Suggesting mode, with the notes posted on them. */
  readonly suggestions: { suggestionId: string; summaryText: string; notes: string[] }[] = [];
  /** Whether Drive says the account may comment; a viewer is also refused the threads read. */
  canComment = true;
  /** Whether Drive says the account may edit the Doc, which a Drive binding's edits are held to. */
  canEdit = true;
  /** Comment threads reads, and comment writes (comments, replies, suggestions, notes). */
  threadReads = 0;
  commentWrites = 0;
  /** How many comment writes to apply and then answer with no response. */
  lostCommentResponses = 0;
  #nextPostId = 1;
  #nextTabId = 1;
  /** Moved by every method that changes what `documents.get` answers. */
  #revision = 1;
  #nextMarkerId = 1;
  readonly #held = new Map<RequestKind, { reach: () => void; released: Promise<void> }>();

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      this.fetch(input, init)));
  }

  addMarker(name: string, id: string, tabId = MAIN_TAB): void {
    this.markers.set(id, { name, tabId });
    this.#recordMarkerCount();
    this.#revision++;
  }

  addTab(id: string, title: string, parentId: string, text = ""): void {
    this.tabs.push({ id, title, parentId, body: bodyOfLines(text), lists: {} });
    this.#revision++;
  }

  removeTab(id: string): void {
    this.tabs.splice(this.tabs.findIndex(tab => tab.id === id), 1);
    this.#revision++;
  }

  /** Give a tab one paragraph per line of `text`. */
  setText(tabId: string, text: string): void {
    this.setBody(tabId, bodyOfLines(text));
  }

  /** Give a tab one paragraph, whose text is one link. */
  setLinkedText(tabId: string, text: string, url: string): void {
    this.setBody(tabId, buildTab([{ runs: [{ text, style: { link: { url } } }, "\n"] }]).body);
  }

  setParagraphs(
    tabId: string, paragraphs: { text: string; namedStyleType: string }[],
  ): void {
    this.setBody(tabId, buildTab(paragraphs.map(({ text, namedStyleType }) => (
      { runs: [`${text}\n`], namedStyleType }))).body);
  }

  setNumberedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, presetLevels(true));
  }

  setBulletedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, presetLevels());
  }

  /** Give a tab one list item per entry, all of one list that has the levels a preset makes. */
  #setList(tabId: string, items: string[], nestingLevels: NestingLevel[]): void {
    let listId = "list-1";
    this.setBody(
      tabId, buildTab(items.map(item => ({ runs: [`${item}\n`], bullet: { listId } }))).body,
      { [listId]: { listProperties: { nestingLevels } } });
  }

  /** Take the bullet off one paragraph of a tab, counted from the first. */
  interruptList(tabId: string, index: number): void {
    let paragraphs = this.#tab(tabId).body.content.flatMap(element => element.paragraph ?? []);
    delete paragraphs[index].bullet;
    this.#revision++;
  }

  /** Give a tab a paragraph, a table of plain cells and a paragraph. */
  setTable(tabId: string, before: string, rows: string[][], after: string): void {
    this.setBody(tabId, buildTab([
      { runs: [`${before}\n`] },
      { table: rows.map(row => row.map(cell => `${cell}\n`)) },
      { runs: [`${after}\n`] },
    ]).body);
  }

  /** Give a tab a body, the lists its paragraphs reference and the named styles it has. */
  setBody(
    tabId: string, body: GoogleDocsTab["body"], lists: GoogleDocsTab["lists"] = {},
    namedStyles?: GoogleDocsTab["namedStyles"],
  ): void {
    Object.assign(this.#tab(tabId), { body, lists, namedStyles });
    this.#revision++;
  }

  /** A collaborator's change this test made through a field of the model: the revision moves. */
  touch(): void {
    this.#revision++;
  }

  /** A collaborator's edit to a tab: the body is replaced, the revision moves. */
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

  /** A tab as the model takes it. */
  bodyTab(tabId = MAIN_TAB): GoogleDocsTab {
    let { id, title, body, lists, namedStyles } = this.#tab(tabId);
    return {
      tabId: id, title, index: 0, nestingLevel: 0, body, lists, namedRanges: {},
      ...namedStyles ? { namedStyles } : {},
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

  /** The text of each paragraph of a tab's body outside its tables. */
  #lines(tabId: string): { text: string; paragraph: Paragraph }[] {
    return this.#tab(tabId).body.content.flatMap(({ paragraph }) => paragraph ? [{
      paragraph,
      text: paragraph.elements.map(part => part.textRun?.content ?? "").join("")
        .replace(/\n$/, ""),
    }] : []);
  }

  text(tabId = MAIN_TAB): string {
    return this.#lines(tabId).map(line => line.text).join("\n");
  }

  /**
   * A tab's text with a number in front of each list item, counted per list and whatever the
   * list's glyph, and a tab in front of a paragraph left indented where its bullet stood.
   */
  renderedText(tabId = MAIN_TAB): string {
    let counts = new Map<string, number>();
    return this.#lines(tabId).map(({ text, paragraph }) => {
      let { bullet } = paragraph;
      let style: ModelParagraphStyle = paragraph.paragraphStyle;
      if (!bullet) return style.indentStart?.magnitude ? `\t${text}` : text;
      let number = (counts.get(bullet.listId) ?? 0) + 1;
      counts.set(bullet.listId, number);
      return `${number}. ${text}`;
    }).join("\n");
  }

  clearMarkers(): void {
    this.markers.clear();
    this.#revision++;
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
    if (text !== undefined) {
      this.setText(tabId, text);
      return;
    }
    let last = this.#tab(tabId).body.content.findLast(element => element.paragraph)!;
    this.externalBody(tabId, applyDocsRequests(this.bodyTab(tabId), [
      { insertText: { location: { index: last.endIndex - 1, tabId }, text: "collaborator" } },
    ]).body);
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let body = init?.body;
    this.requestBytes += typeof body === "string" ? new TextEncoder().encode(body).byteLength
      : body instanceof Uint8Array ? body.byteLength : 0;
    let response = await this.#answer(input, init);
    // Counted from a copy, beside the caller's read: the response is not held for the count.
    void response.clone().arrayBuffer().then(sent => { this.responseBytes += sent.byteLength; });
    return response;
  }

  async #answer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    this.fetches++;
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/batch/")) {
      this.driveFetches++;
      await this.#hold("scope");
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
        // Only to the request that asks whether the account may comment on the file.
        ...url.searchParams.get("fields")?.includes("canComment")
          ? { capabilities: { canComment: this.canComment } } : {},
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
      let masked = new Headers(init?.headers).has("X-Goog-FieldMask");
      if (fields === null) {
        this.documentFetches++;
        if (!masked) unmaskedFetches++;
      } else if (fields === "revisionId") this.revisionProbes++;
      if ((fields === null || fields.includes("tabs(")) && this.readFailures > 0) {
        this.readFailures--;
        return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
      }
      if (fields === null && masked && this.refusedMasks > 0) {
        this.refusedMasks--;
        return Response.json({
          error: {
            code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.",
          },
        }, { status: 400 });
      }
      let document = this.#document();
      await this.#hold("read");
      return docsGetResponse(url, new Headers(init?.headers), document);
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
    let [only] = body.requests;
    let deletion = body.requests.length === 1 && "deleteNamedRange" in only
      ? only.deleteNamedRange : undefined;
    let isDelete = deletion !== undefined;
    await this.#hold(isDelete ? "cleanup" : "content");
    if (!isDelete && this.refusesEdits) {
      return Response.json({
        error: { code: 400, status: "FAILED_PRECONDITION", message: OFFICE_REFUSAL },
      }, { status: 400 });
    }
    if (!isDelete && this.unsentContentRequests > 0) {
      this.unsentContentRequests--;
      throw new Error("connection dropped before the request reached Google");
    }
    if (isDelete && this.cleanupFailures > 0) {
      this.cleanupFailures--;
      throw new Error("cleanup failed");
    }
    // Once there are several tabs, Google finds a named range only in the tabs a deletion names.
    let markerTab = deletion && this.markers.get(deletion.namedRangeId)?.tabId;
    if (deletion && markerTab && this.tabs.length > 1 &&
        !deletion.tabsCriteria?.tabIds.includes(markerTab)) {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT",
        message: `Invalid requests[0].deleteNamedRange: No named range with ID: ${deletion.namedRangeId}` } },
        { status: 400 });
    }
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return Response.json({
        error: {
          code: 400,
          ...this.stalePinStatus ? { status: this.stalePinStatus } : {},
          message: "The required revision ID does not match the latest revision.",
        },
      }, { status: 400 });
    }
    // Google checks a batch whole before it applies any of it.
    for (let request of body.requests) {
      let refusal = "addDocumentTab" in request &&
        this.#addTabRefusal(request.addDocumentTab.tabProperties);
      if (refusal) {
        return Response.json(
          { error: { code: 400, status: "INVALID_ARGUMENT", message: refusal } }, { status: 400 });
      }
    }

    // Google resolves an unqualified coordinate against a default tab, so a request that omits
    // the ID would edit whichever tab that happens to be.
    let contentRequests: GoogleDocsRequest[] = [];
    let tabRequests = new Map<ModelTab, GoogleDocsRequest[]>();
    for (const request of body.requests) {
      // The add of a tab changes no tab's content: the model is never given one.
      if ("deleteNamedRange" in request || "addDocumentTab" in request) continue;
      let tabId = requestTabId(request);
      if (!tabId) {
        throw new Error(`Google Docs request is missing tabId: ${JSON.stringify(request)}`);
      }
      if ("createNamedRange" in request) continue;
      contentRequests.push(request);
      let tab = this.#tab(tabId);
      tabRequests.set(tab, [...tabRequests.get(tab) ?? [], request]);
    }
    // The gatekeeper sends an add alone, with its marker.
    if (contentRequests.length > 0 && body.requests.some(request => "addDocumentTab" in request)) {
      throw new Error("A Google Docs batch that adds a tab changed content too");
    }
    // The model applies each tab's requests: all of a batch, or none of it, the marker included.
    let edited = new Map<ModelTab, GoogleDocsTab>();
    for (const [tab, requests] of tabRequests) {
      try {
        edited.set(tab, applyDocsRequests(this.bodyTab(tab.id), requests));
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: { code: 400, status: "INVALID_ARGUMENT", message } }, { status: 400 });
      }
    }
    for (const [tab, applied] of edited) {
      Object.assign(tab, { body: applied.body, lists: applied.lists });
    }

    let replies: unknown[] = [];
    let hasContent = contentRequests.length > 0;
    for (const request of body.requests) {
      if ("deleteNamedRange" in request) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
        continue;
      }
      if ("addDocumentTab" in request) {
        hasContent = true;
        replies.push({ addDocumentTab: { tabProperties: this.#addTab(request.addDocumentTab.tabProperties) } });
        continue;
      }

      let tab = this.#tab(requestTabId(request) ?? "");
      if ("createNamedRange" in request) {
        let id = `marker-${this.#nextMarkerId++}`;
        // A batch's marker is part of its one revision, which moves below.
        this.markers.set(id, { name: request.createNamedRange.name, tabId: tab.id });
        this.#recordMarkerCount();
        this.markerTabIds.push(tab.id);
        replies.push({ createNamedRange: { namedRangeId: id } });
        continue;
      }

      replies.push({});
    }
    if (hasContent) this.lastContentRequests = contentRequests;
    if (hasContent) this.contentBatches++;
    this.#revision++;
    this.#recordMarkerCount();
    if (hasContent) await this.#hold("applied");

    if (hasContent && this.ambiguousContentResponses > 0) {
      this.ambiguousContentResponses--;
      throw new Error("content response lost");
    }
    return Response.json({
      replies,
      writeControl: { requiredRevisionId: `revision-${this.#revision}` },
    });
  }

  /** Why Google would refuse to add a tab placed so, if it would. */
  #addTabRefusal({ parentTabId, index }: { parentTabId?: string; index?: number }): string | undefined {
    if (parentTabId !== undefined && !this.tabs.some(tab => tab.id === parentTabId)) {
      return `A parent tab with ID "${parentTabId}" does not exist.`;
    }
    let children = this.tabs.filter(tab => tab.parentId === parentTabId).length;
    if (index !== undefined && index > children) {
      return "Index must be less than or equal to the number of tabs within the specified parent tab.";
    }
  }

  /**
   * Adds an empty tab as `addDocumentTab` does, answering its properties: `blankDocsTab`'s content,
   * so it reads once added as the replay showed it while its add waited.
   */
  #addTab({ title, parentTabId, index }: { title?: string; parentTabId?: string; index?: number }) {
    let siblings = this.tabs.filter(tab => tab.parentId === parentTabId);
    let at = index ?? siblings.length;
    let id = `t.added-${this.#nextTabId++}`;
    let { title: named, body, lists, namedStyles } =
      blankDocsTab(id, title || `Tab ${this.tabs.length + 1}`);
    let tab: ModelTab = {
      id, title: named, ...parentTabId === undefined ? {} : { parentId: parentTabId },
      body, lists, namedStyles,
    };
    // Siblings keep the order of this list, so the tab goes before the one it displaces.
    if (at < siblings.length) this.tabs.splice(this.tabs.indexOf(siblings[at]), 0, tab);
    else this.tabs.push(tab);
    return {
      tabId: tab.id, title: tab.title, index: at,
      ...parentTabId === undefined ? {} : { parentTabId },
    };
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
      capabilities: { canComment: this.canComment, canEdit: this.canEdit },
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
      let old = this.text(this.#tab(tabId!).id).slice(startIndex - 1, endIndex - 1);
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
        let quote = this.text(this.#tab(range.tabId!).id)
          .slice(range.startIndex - 1, range.endIndex - 1);
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
    let namedRanges: Record<string, { namedRanges: { namedRangeId: string; name: string }[] }> = {};
    for (const [namedRangeId, marker] of this.markers) {
      if (marker.tabId !== tab.id) continue;
      (namedRanges[marker.name] ??= { namedRanges: [] })
        .namedRanges.push({ namedRangeId, name: marker.name });
    }
    let { body, lists, namedStyles } = tab;
    return {
      tabProperties: { tabId: tab.id, title: tab.title },
      documentTab: { body, lists, namedRanges, ...namedStyles ? { namedStyles } : {} },
      childTabs: this.tabs.filter(child => child.parentId === tab.id)
        .map(child => this.#documentTab(child)),
    };
  }

  #document() {
    return {
      documentId: this.documentId,
      title: this.title,
      ...this.editable ? { revisionId: `revision-${this.#revision}` } : {},
      tabs: this.tabs.filter(tab => tab.parentId === undefined)
        .map(tab => this.#documentTab(tab)),
    };
  }
}

/**
 * How a suite reaches doc-1: bound directly, or opened from a read and write Drive file binding,
 * whose facets the hooks tell apart by their `drive:` prefix. Through Drive, every card names the
 * file first, every kind's label says it covers each Doc the binding reaches, a fresh session
 * opens the file before anything else, and the read that prepares an edit is authorized; `hooks()`
 * checks each and takes it off what it reports, so the suite's assertions hold for both runs.
 * What is left to differ is a parameter of the run.
 */
type Run = {
  name: string;
  drive: boolean;
  /** The refusal of an approval while edit `earlier` waits before edit `later`. */
  outOfOrder(earlier: number, later: number): string;
  /**
   * Checks what approving an applied edit again answers: a Doc's own store has forgotten it, and a
   * Drive binding's journal remembers it was applied and settles (brief §3.9).
   */
  appliedAgain(answer: string | null): void;
  /**
   * What approving an edit that could not be applied answers after the first time: a Doc's own
   * store keeps the reason it recorded, and the journal the error the approval failed with.
   */
  unapplied(reason: string): string;
  /** What `insertTable()` authorizes beyond the read that prepares it, given the position read. */
  positionReads(read: string): string[];
};

const STANDALONE: Run = {
  name: "bound directly",
  drive: false,
  outOfOrder: (earlier, later) =>
    `Google Doc edits must be approved in order. Approve earlier edit ${earlier} before edit ${later}.`,
  appliedAgain: answer => expect(answer).toMatch(/Unknown pending/),
  unapplied: reason => `Pending Google Doc edit could not be applied: ${reason}`,
  positionReads: read => [read],
};

const THROUGH_DRIVE: Run = {
  name: "opened from a read and write Drive binding",
  drive: true,
  outOfOrder: () => "Changes to one file apply in the order they were queued. Approve or reject " +
    "the earlier change to this file first.",
  appliedAgain: answer => expect(answer).toBeNull(),
  unapplied: reason => reason,
  // The read that prepares the table is the authorization of the position it returns.
  positionReads: () => [],
};

/**
 * The runs of a block that asserts what the engine does. A test runs bound directly alone when
 * it is about what only a Doc's own binding has (its storage, the replay a rejection makes over
 * its stored copy, a change past the 100 KiB a Drive binding stores).
 */
const RUNS = [STANDALONE, THROUGH_DRIVE];

/** The run the current test is in. */
let run: Run = STANDALONE;

const DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_GRANTED = [GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_WRITES_GRANT];
const DRIVE_LABEL = ", in any Doc this connection reaches";
const DRIVE_OPEN = "Check current metadata for Drive file doc-1 and open it as a Google Doc.";
const DRIVE_PREPARE = /^Read tab .* to change it\.$/;

/** Runs the tests of the enclosing describe block in `current`. */
function inRun(current: Run): void {
  beforeEach(async () => {
    run = current;
    if (current.drive) await rawHooks().setDriveGrants(DRIVE_GRANTED);
  });
  afterEach(async () => {
    if (current.drive) {
      await rawHooks().setDriveGrants([]);
      // Ended, so the facets of a second run do not add to what one activation of the hooks holds.
      for (let facet of driveFacets) await rawHooks().restartDrive(facet);
      driveFacets.clear();
    }
    run = STANDALONE;
  });
}

function rawHooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

/** The facets a test in a run through Drive reached. */
const driveFacets = new Set<string>();

/** The Doc hooks that name a facet first. */
const FACET_HOOKS = new Set([
  "submitAppend", "submitReplace", "submitEdit", "callsDuringTableRead", "readMetadata",
  "readContent", "listTabs", "applyAction", "rejectAction", "callDoc", "describe",
  "docAutoApprovable",
]);

/** `fields` without the two a Drive binding's card names the file by, which it checks. */
function withoutFileFields(fields: ActionField[]): ActionField[] {
  if (fields.length === 0) return fields;
  let [file, name, ...rest] = fields;
  expect([file, name]).toMatchObject([
    { label: "File", value: "doc-1" }, { label: "File name", value: "Test document" },
  ]);
  return rest;
}

function hooks() {
  let stub = rawHooks();
  if (!run.drive) return stub;
  return new Proxy(stub, {
    get(target, property) {
      let value = Reflect.get(target, property);
      if (property === "lastActionFields") {
        return Promise.resolve(target.lastActionFields).then(withoutFileFields);
      }
      if (property === "lastActionVerdict") {
        return Promise.resolve(target.lastActionVerdict).then(verdict => {
          let { actionKind } = verdict;
          if (!actionKind) return verdict;
          expect(actionKind.label.endsWith(DRIVE_LABEL)).toBe(true);
          return { ...verdict, actionKind: { ...actionKind, label: actionKind.label.slice(0, -DRIVE_LABEL.length) } };
        });
      }
      if (property === "lastObservations") {
        return Promise.resolve(target.lastObservations).then(observations =>
          observations.filter(observed => observed !== DRIVE_OPEN && !DRIVE_PREPARE.test(observed)));
      }
      if (typeof property === "string" && FACET_HOOKS.has(property)) {
        // Called on the stub itself: an RPC method's own `call` would be a remote property.
        return (facet: string, ...args: unknown[]) => {
          driveFacets.add(`drive:${facet}`);
          // A plain promise, so a rejection the test handles is not reported again unhandled.
          return Promise.resolve((target as unknown as Record<string, (...all: unknown[]) => unknown>)[
            property](`drive:${facet}`, ...args));
        };
      }
      return value;
    },
  }) as typeof stub;
}

function markdownField(label: string, value: string) {
  return { label, kind: "text", value, syntax: "markdown" };
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

/** What a request to the Docs API is, as the approval tests order them; `undefined` for another host's. */
function docsRequestKind(
  input: string | URL | Request, init?: RequestInit,
): "read" | "probe" | "content" | "cleanup" | "other" | undefined {
  let url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname !== "docs.googleapis.com") return undefined;
  if (url.pathname.endsWith(":batchUpdate")) {
    let { requests } = JSON.parse(String(init?.body)) as { requests: object[] };
    return requests.every(request => "deleteNamedRange" in request) ? "cleanup" : "content";
  }
  if (url.searchParams.get("fields") === "revisionId") return "probe";
  // As the model counts `documentFetches`: a read with no `fields` parameter, comments aside.
  return url.searchParams.has("fields") || url.searchParams.has("commentsViewMode") ? "other" : "read";
}

/** How many requests the installed model has been sent. */
const requestsMade = () => vi.mocked(fetch).mock.calls.length;

/**
 * The Docs API requests after the first `from` the model received, in order: a full read, a
 * revision probe, a content batch (applied or refused) and a marker's deletion.
 */
const docsRequestsSince = (from: number) => vi.mocked(fetch).mock.calls.slice(from)
  .flatMap(([input, init]) => docsRequestKind(input, init) ?? []);

/** `docsRequestsSince`, with a read of the title and revision alone told apart as `"title"`. */
const docsReadsSince = (from: number) => vi.mocked(fetch).mock.calls.slice(from)
  .flatMap(([input, init]) => {
    let kind = docsRequestKind(input, init);
    if (kind !== "other") return kind ?? [];
    let url = new URL(input instanceof Request ? input.url : input.toString());
    return url.searchParams.get("fields") === "documentId,title,revisionId" ? "title" : kind;
  });

/** Makes `change` once, when the next batch that carries content is on its way to Google. */
function whileWriting(change: () => void): void {
  let model = globalThis.fetch;
  let waiting = true;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (waiting && docsRequestKind(input, init) === "content") {
      waiting = false;
      change();
    }
    return model(input, init);
  }));
}

/** The lines logged of a batch built from the copy held that was not accepted. */
const copyRefusals = (warn: MockInstance<typeof console.warn>) =>
  warn.mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter(line => line?.event === "google.doc.action.apply.copy-refused");

/** The UTF-16 code units of `text`, in hex: a test's message cannot print half of a surrogate pair. */
const units = (text: string) => Array.from(text, unit => unit.charCodeAt(0).toString(16));

/**
 * A document of two paragraphs, read, with an append queued and read again. Through Drive the
 * second read fetches the snapshot a write may be built from: the first predates the edit.
 */
async function queuedOnCopy(facet: string, arrange: (docs: DocsModel) => void = () => {}) {
  let docs = new DocsModel();
  docs.setText(MAIN_TAB, "Alpha\nBeta");
  arrange(docs);
  docs.install();
  expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n");
  let actionId = await hooks().submitAppend(facet, "Appended");
  expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
  return { docs, actionId };
}
/** Approves one more append, queued on a read made now and read once more, and tells its requests. */
async function nextOnCopy(facet: string): Promise<string[]> {
  await hooks().readContent(facet);
  let actionId = await hooks().submitAppend(facet, "Third");
  await hooks().readContent(facet);
  let from = requestsMade();
  expect(await hooks().applyAction(facet, actionId)).toBeNull();
  return docsRequestsSince(from);
}

/** `queuedOnCopy`'s document once a collaborator has changed its first paragraph. */
const COLLABORATOR = "Alpha by a collaborator\nBeta";

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
  `${op}: tables, rows and columns can be added, and cells merged, only until the tables of a ` +
  "tab hold 5000 " +
  `cells in all, a cell counting once for each paragraph in it, and those of this tab would ` +
  `hold ${cells}.`;

/** A list whose one level is numbered, keyed `L`, and an item of it. */
const NUMBERED_LIST: GoogleDocsTab["lists"] = {
  L: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
};
const numberedItem = (text: string) => ({ runs: [`${text}\n`], bullet: { listId: "L" } });

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
    para("Before"), grid(["Task", "Owner"]), para("Mid"), grid(["Risk", "Owner"]),
    para("After"),
  ]).body);
}

/** A row queued for the first table of `twoTables()`, and one for the second. */
const queueFirst = (facet: string) =>
  edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
const queueSecond = (facet: string) =>
  edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });

/** What `failMarking()` makes a storage write throw. */
const STORAGE_FAILURE = "The storage write failed";

/**
 * Makes the storage write that marks pending edit `actionId` invalid throw, in every Durable
 * Object of the test, until the function it resolves to is called.
 */
function failMarking(actionId: number): Promise<() => void> {
  return runInDurableObject(hooks(), (_instance: unknown, state: DurableObjectState) => {
    let kv = Object.getPrototypeOf(state.storage.kv) as { put: DurableObjectStorage["kv"]["put"] };
    let { put } = kv;
    kv.put = function (this: DurableObjectStorage["kv"], key: string, value: unknown) {
      if (key === `pending:action:${actionId}` &&
          (value as { invalidatedReason?: string }).invalidatedReason) {
        throw new Error(STORAGE_FAILURE);
      }
      put.call(this, key, value);
    };
    return () => { kv.put = put; };
  });
}

/** Two tables that read the same, of two rows so that a row or a column can be deleted. */
const PAIR_ROWS = [["Task", "Owner"], ["Fix login", "Ana"]];
function pairBody(): GoogleDocsTab["body"] {
  return buildTab([
    para("Before"), grid(...PAIR_ROWS), para("Mid"), grid(...PAIR_ROWS),
    para("After"),
  ]).body;
}
/** The replacement that sets the first table of `pairBody()` apart, quoted from the text above. */
const FIRST_OF_PAIR = ["Before\n\n<table>\n  <tr>\n    <td><p>Task</p></td>",
  "Before\n\n<table>\n  <tr>\n    <td><p>Task (A)</p></td>"] as const;

/** A header-only table, rows queued for it, a new table that reads as it did, and rows for that. */
async function queueBehindTwin(facet: string) {
  let docs = docsWithBody(
    buildTab([para("Before"), grid(["Task", "Owner"]), para("After")]).body);
  let first = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
  let added = await edit(
    facet, "insertTable", { rows: 1, columns: 2, cells: [["Task", "Owner"]], after: "After" });
  expect(added.returned).toBe(1);
  let second = await edit(facet, "insertTableRows", { table: 1, cells: [["c", "d"]] });
  return { docs, first, added, second };
}

/** A tab whose one table holds 4,990 cells: 499 rows of 10. */
function fullTab(...more: Parameters<typeof buildTab>[0]): GoogleDocsTab["body"] {
  let rows = Array.from({ length: 499 }, (_, row) =>
    Array.from({ length: 10 }, (__, column) => `${row}.${column}\n`));
  return buildTab([para("Before"), { table: rows }, para("After"), ...more]).body;
}

/** A pending record for the main tab, as storage holds one under the current rendering. */
const storedAction = (id: number, action: Record<string, unknown>) => ({
  kind: "put" as const,
  key: `pending:action:${id}`,
  value: {
    tabId: MAIN_TAB, submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, ...action,
  },
});

beforeEach(() => {
  unmaskedFetches = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // A full read without a field mask is a path that asks Google for every field of a document.
  expect(unmaskedFetches).toBe(0);
});

const ADD_DOCUMENT_TAB = { tag: "addDocumentTab", label: "New document tabs" };

describe.each(RUNS)("Google Doc auto-approval, $name", r => {
  inRun(r);

  const EDIT_DOCUMENT = { tag: "editDocument", label: "Document edits" };

  const TABLE_CHANGES = { tag: "document-tables", label: "Table changes" };

  // A Drive binding's catalog is its own (drive-editors.test.ts).
  it.skipIf(r.drive)("reports document edits, new tabs, table changes and Doc comments as its auto-approvable kinds", async () => {
    expect(await hooks().docAutoApprovable("verdict-kinds")).toEqual([
      EDIT_DOCUMENT, ADD_DOCUMENT_TAB, TABLE_CHANGES,
      { tag: "docComments", label: "Google Doc comments" },
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

});

describe.each(RUNS)("Google Doc tables, $name", r => {
  inRun(r);

  it("returns table cells with their row structure", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Status"], ["Alice", "Ready"]], "After");
    docs.install();

    await expect(hooks().readContent("table-read")).resolves.toContain(
      "<tr>\n    <td><p>Alice</p></td>\n    <td><p>Ready</p></td>\n  </tr>",
    );
  });

  // The second preparation finds what the first stored; through Drive there is only one.
  it("makes the table an insertTable adds once, though it prepares it twice", async () => {
    docsWithBody(tableBody());
    let facet = "table-insert-made-once";
    await hooks().readContent(facet);
    let before = { stored: docStoreCost.resultsStored, clones: replayCost.tabClones };

    let { returned } = await edit(facet, "insertTable", { rows: 1, columns: 1, cells: [["nw001"]] });

    expect({
      stored: docStoreCost.resultsStored - before.stored,
      clones: replayCost.tabClones - before.clones,
    // Made once, and no tab copied for it: the model changes the runs its batch touches.
    }).toEqual({ stored: 1, clones: 0 });
    // The position it answers is the one a read then shows.
    let shown = shownTables(await hooks().readContent(facet));
    expect(shown[returned!]).toEqual([[{ attributes: "", word: "nw001" }]]);
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
      "replaceText: this replacement changes a table together with what is around it");
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

  it("applies a look change and a row change queued after it, and reads them as Google does", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-look-then-rows";
    let restyled = await edit(facet, "setTableCellStyle", {
      table: 0, row: 1, column: 0, columns: 2, style: { background: "#ffcc00", borders: { top: { width: 2 } } },
    });
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["Ship docs", "Done"]] });
    let preview = await hooks().readContent(facet);
    // Four of the six cells are shaded and have a 2pt top: the table now says both.
    expect(preview).toContain(
      '<table style="background-color:#ffcc00;border-top:2pt solid #000000">\n  <tr>\n' +
      '    <td style="background-color:transparent;border-top:1pt solid #000000;' +
      'border-bottom:2pt solid #000000"><p>Task</p></td>');
    expect(preview).toContain("    <td><p>Ship docs</p></td>");

    for (let { actionId } of [restyled, rows]) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(2);
  });

  it("merges cells, then splits them, and reads each as Google does", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-merge-split";
    let merged = await edit(facet, "mergeTableCells", { table: 0, row: 1, column: 0, rows: 1, columns: 2 });
    expect(await hooks().lastActionVerdict)
      .toEqual({ actionKind: { tag: "document-tables", label: "Table changes" }, autoApprovable: true });
    let mergedRead = await hooks().readContent(facet);
    expect(mergedRead).toContain(
      '  <tr>\n    <td colspan="2">\n      <p>Fix login</p>\n      <p>Open</p>\n    </td>\n' +
      "    <td><p></p></td>\n  </tr>");
    expect(await hooks().applyAction(facet, merged.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(mergedRead);
    let split = await edit(facet, "unmergeTableCells", { table: 0, row: 1, column: 0 });
    let splitRead = await hooks().readContent(facet);
    expect(await hooks().applyAction(facet, split.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(splitRead);
    expect(docs.contentBatches).toBe(2);
  });

  it("keeps a row change queued for a table a collaborator restyles meanwhile", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-restyled-meanwhile";
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["Ship docs", "Open"]] });
    let body = structuredClone(docs.bodyTab().body);
    let table = body.content.find(element => element.table)!.table!;
    let cell = table.tableRows![0].tableCells![0];
    cell.tableCellStyle = { ...cell.tableCellStyle, backgroundColor: { color: { rgbColor: { red: 1 } } } };
    docs.externalBody(MAIN_TAB, body);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toContain('<td style="background-color:#ff0000"><p>Task</p></td>');
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
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

  // Bound alone: it asserts what the replay over the stored copy keeps behind a rejection.
  it.skipIf(r.drive)("follows a table past a rejected insertion above it", async () => {
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
      cardField("Text before the table", "Before", "markdown"),
      cardField("First row of the table", rowOf("Task", "Status"), "html"),
    ]);

    await hooks().rejectAction(facet, above.actionId);

    let preview = `Before\n\n${tableOf([...TABLE_ROWS, ["Ship docs", "Open"]])}\n\nAfter\n`;
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(1);
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

  it("invalidates a change when a collaborator makes another table read the same", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-collaborator-twin";
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });

    docs.externalBody(MAIN_TAB, buildTab([
      para("Before"), grid(...TABLE_ROWS), para("After"), grid(...TABLE_ROWS),
      para(""),
    ]).body);
    passSnapshotTtl();

    expect(await hooks().readContent(facet)).toBe(`${TABLE_CONTENT}\n${tableOf(TABLE_ROWS)}\n\n\n`);
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // Bound alone: it asserts what the replay over the stored copy keeps behind a rejection.
  it.skipIf(r.drive)("invalidates a change when a rejection leaves another table reading the same", async () => {
    let facet = "table-rejection-twin";
    let { docs, first, second } = await queueBehindTwin(facet);

    await hooks().rejectAction(facet, first.actionId);

    let headerTable = tableOf([["Task", "Owner"]]);
    expect(await hooks().readContent(facet)).toBe(
      `Before\n\n${headerTable}\n\nAfter\n\n${headerTable}\n\n\n`);
    expect(await hooks().applyAction(facet, second.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // Bound alone. Left to one replay, the two rejections cancel out and the new table's rows go to
  // the table that was there all along.
  it.skipIf(r.drive)("settles each rejection before the next", async () => {
    let facet = "table-rejections-in-turn";
    let { docs, first, added, second } = await queueBehindTwin(facet);

    await hooks().rejectAction(facet, first.actionId);
    await hooks().rejectAction(facet, added.actionId);

    expect(await hooks().applyAction(facet, second.actionId)).toContain(same("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // The second rejection is replayed over the snapshot the first one kept.
  // Bound alone: it asserts what the replay over the stored copy keeps behind a rejection.
  it.skipIf(r.drive)("follows a table past two rejected insertions", async () => {
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

  // The marks of a failed approval are stored one after the other. One that fails leaves the
  // marks before it stored, and a read made before the approval remembers the queue without them.
  it.skipIf(r.drive)("stops showing a change that failed at approval where dropping the one behind it fails", async () => {
    let docs = twoTables();
    let facet = "table-gate-apply-mark-fails";
    let first = await queueFirst(facet);
    let second = await queueSecond(facet);
    let withSecond =
      TWO_CONTENT.replace("</table>\n\nAfter", `${rowOf("c", "d")}\n</table>\n\nAfter`);
    expect(await hooks().readContent(facet))
      .toBe(withSecond.replace("</table>", `${rowOf("a", "b")}\n</table>`));

    docs.externalCellEdit(0, 0, 0, "Chore");
    let restore = await failMarking(second.actionId);
    try {
      expect(await hooks().applyAction(facet, first.actionId)).toBe(STORAGE_FAILURE);
    } finally {
      restore();
    }

    // The first change is stored as dropped, and the second, whose mark was not stored, is not.
    expect(await hooks().readContent(facet)).toBe(withSecond.replace("Task", "Chore"));
    expect(await hooks().applyAction(facet, first.actionId)).toContain(gone("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // Ungated, the fourth edit would find only the table under `## X` reading as recorded, and add
  // the row meant for the other. Bound alone: it holds the replay over the stored copy.
  it.skipIf(r.drive)("keeps a row off the other of two tables when the edit that set them apart is rejected", async () => {
    let docs = docsWithBody(buildTab([
      heading("X"), grid(["Task", "Owner"]), heading("Y"), grid(["Task", "Owner"]),
      para("End"),
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

  // Listing the tabs, or naming a tab the document lacks, stores a newer read and replays no
  // tab's edits: the rejection settles what that read brought before it removes the change.
  // Bound alone: it asserts what the replay over the stored copy keeps behind a rejection.
  it.skipIf(r.drive).each<[string, (facet: string) => Promise<unknown>]>([
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
    await refresh(facet).catch(() => {});
    // The edited document is the copy held, and `rows` is stored as it was queued.
    expect(docs.documentFetches).toBe(2);
    expect(await hooks().storedValueJsonLength(facet, rowsKey)).toBe(stored);

    await hooks().rejectAction(facet, cell.actionId);

    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gone("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
    expect(docs.tables()[0].rows).toHaveLength(2);
  });

  const storedRows =
    { type: "insertTableRows", at: 2, cells: [["a", "b"]], expected: tableOf(TABLE_ROWS) };

  it.skipIf(r.drive)("drops later table changes when a rejection has no read to replay over", async () => {
    docsWithBody(tableBody());
    let facet = "table-reject-unread";
    await hooks().applyStorage(facet, [
      storedAction(1, {
        type: "replaceText", oldMarkdown: "<td><p>Open</p></td>",
        newMarkdown: "<td><p>Done</p></td>", inTable: true,
      }),
      storedAction(2, { ...storedRows, expected: tableOf([["Task", "Status"], ["Fix login", "Done"]]) }),
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

  // The tables read as the later changes recorded them whether or not the rejected change is
  // made, so the next replay checks those changes as it checks any.
  it.skipIf(r.drive)("keeps later table changes queued when a rejection with no read to " +
    "replay over changed no table", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-reject-unread-text";
    await hooks().applyStorage(facet, [
      storedAction(1, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      storedAction(2, storedRows),
    ]);
    let length = await hooks().storedValueJsonLength(facet, "pending:action:2");

    await hooks().rejectAction(facet, 1);

    expect(await hooks().storedValueJsonLength(facet, "pending:action:2")).toBe(length);
    expect(await hooks().readContent(facet))
      .toBe(`Before\n\n${tableOf([...TABLE_ROWS, ["a", "b"]])}\n\nAfter\n`);
    expect(await hooks().applyAction(facet, 2)).toBeNull();
    expect(docs.contentBatches).toBe(1);
  });

  it.skipIf(r.drive)("replays nothing when no later change names a table", async () => {
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

  // The rejection's replay is of the whole queue, so it finds what a collaborator's change to
  // another tab made unreplayable, though no read of that tab has.
  it.skipIf(r.drive)("marks an unreplayable edit of another tab at a rejection that replays the queue", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, tableBody());
    docs.addTab(SECOND_TAB, "Notes", MAIN_TAB, "shared");
    docs.install();
    let facet = "table-reject-other-tab";
    let cell = await edit(
      facet, "replaceText", "<td><p>Open</p></td>", "<td><p>Done</p></td>", MAIN_TAB);
    await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] }, MAIN_TAB);
    let other = await edit(facet, "replaceText", "shared", "changed", SECOND_TAB);
    let key = `pending:action:${other.actionId}`;
    expect(await hooks().readContent(facet, MAIN_TAB)).toContain("<td><p>Done</p></td>");
    expect(await hooks().readContent(facet, SECOND_TAB)).toBe("changed\n");
    let stored = await hooks().storedValueJsonLength(facet, key);

    docs.externalEdit(SECOND_TAB, "rewritten");
    passSnapshotTtl();
    // A read of the main tab replays the main tab alone.
    expect(await hooks().readContent(facet, MAIN_TAB)).toContain("<td><p>Done</p></td>");
    expect(await hooks().storedValueJsonLength(facet, key)).toBe(stored);

    await hooks().rejectAction(facet, cell.actionId);

    expect(await hooks().storedValueJsonLength(facet, key)).toBeGreaterThan(stored ?? 0);
    expect(await hooks().applyAction(facet, other.actionId)).toBe(droppedByRead(
      `replaceText: oldMarkdown was not found in the current simulated tab "${SECOND_TAB}". ` +
      `Make sure the text exactly matches content returned by getContent("${SECOND_TAB}").`));
    expect(docs.contentBatches).toBe(0);
    expect(docs.text(SECOND_TAB)).toBe("rewritten");
  });

  it.skipIf(r.drive)("drops later table changes when the copy held at a rejection cannot be read back", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "table-reject-unreadable";
    // The first edit leaves the table reading as the second records it: replayed without it,
    // the second finds its table in the stored summaries and decodes the piece around it.
    let added = await edit(facet, "insertTable", { rows: 1, columns: 1 });
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
    expect(await hooks().readContent(facet)).toContain("<td><p>a</p></td>");
    // The main tab's run, as the store holds it, is no list of a tab's elements.
    let head = (await hooks().docCopyHead(facet))!;
    let version = head.versions[head.outline.findIndex(({ tabId }) => tabId === MAIN_TAB)];
    expect(version).toEqual(expect.any(String));
    await hooks().docStoreExec(
      facet,
      "UPDATE doc_run SET json = '\"not a tab\"' WHERE id IN (SELECT run FROM doc_seq WHERE version = ?)",
      version);

    await hooks().rejectAction(facet, added.actionId);

    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  });

  // A rendering of the document may be left under these two keys. The gatekeeper's constructor
  // ran before the seed below was stored, so the facet is restarted for it to meet them.
  it.skipIf(r.drive)("deletes a rendering left in storage without reading it", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "fresh");
    docs.install();
    let facet = "rendering-left-in-storage";
    let lengths = async () => [
      await hooks().storedValueJsonLength(facet, "docSnapshot"),
      await hooks().storedValueJsonLength(facet, "docSnapshotCheck"),
    ];
    await hooks().applyStorage(facet, [
      { kind: "put", key: "docSnapshot", value: { markdown: "stale\n", fetchedAt: Date.now() } },
      { kind: "put", key: "docSnapshotCheck", value: { checkedAt: Date.now() } },
    ]);
    expect(await lengths()).toEqual([expect.any(Number), expect.any(Number)]);

    await hooks().restartDoc(facet);

    expect(await hooks().readContent(facet)).toBe("fresh\n");
    expect(docs.documentFetches).toBe(1);
    expect(await lengths()).toEqual([undefined, undefined]);
  });

  it.skipIf(r.drive)("checks the revision after a rejection", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "reject-revision-check";
    let actionId = await hooks().submitAppend(facet, "added");
    expect(await hooks().readContent(facet)).toBe("base\n\nadded\n");
    expect(docs.documentFetches).toBe(1);

    await hooks().rejectAction(facet, actionId);

    // The copy was kept, and only its revision checked.
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

  // The approval read the document to refuse the edit, and that reading is not the copy's to keep.
  it.skipIf(r.drive)("checks the revision after an approval that could not be applied", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Before");
    docs.install();
    let facet = "unapplyable-revision-check";
    let actionId = await hooks().submitAppend(facet, "added");
    expect(await hooks().readContent(facet)).toBe("Before\n\nadded\n");

    // A collaborator ends the tab in a table, inside the copy's TTL.
    docs.setBody(MAIN_TAB, buildTab([{ runs: ["Before\n"] }, { table: [["Cell\n"]] }]).body);
    docs.externalEdit();
    expect(await hooks().applyAction(facet, actionId))
      .toContain("appendText: the selected tab does not end in a paragraph");
    let fetches = docs.documentFetches;
    let probes = docs.revisionProbes;

    expect(await hooks().readContent(facet)).toBe(`Beforecollaborator\n\n${tableOf([["Cell"]])}\n`);
    expect(docs.revisionProbes).toBe(probes + 1);
    expect(docs.documentFetches).toBe(fetches + 1);
  });

  /** Removes the runs only the first edit's version lists; those it shares with the base stay. */
  async function loseFirstEditsVersion(facet: string): Promise<void> {
    let [base] = (await hooks().docCopyHead(facet))!.versions;
    await hooks().docStoreExec(facet,
      "DELETE FROM doc_run WHERE id IN (SELECT run FROM doc_seq WHERE version IN " +
      "(SELECT child FROM doc_result WHERE version = ?1)) " +
      "AND id NOT IN (SELECT run FROM doc_seq WHERE version = ?1)", base);
  }

  // A rejection replays over the versions the pending edits made. One that cannot be read back
  // must neither mark an edit nor fail the rejection, which would then fail at every retry.
  it.skipIf(r.drive)("a rejection drops the copy and the table changes behind it when a " +
    "version cannot be read", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "reject-version-unreadable";
    await edit(facet, "replaceText", "Before", "Earlier");
    let rejected = await edit(facet, "insertTable", { rows: 1, columns: 1 });
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] });
    await hooks().readContent(facet);
    await loseFirstEditsVersion(facet);
    let fetches = docs.documentFetches;

    expect(await hooks().rejectAction(facet, rejected.actionId)).toEqual({ restart: true });

    // As a rejection with no copy to replay over: the change that names a table is dropped.
    expect(await hooks().docCopyHead(facet)).toBeNull();
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(
      `Pending Google Doc edits could not be replayed after edit ${rejected.actionId} was ` +
      `rejected: ${gate("insertTableRows")}`);
    expect(docs.documentFetches).toBe(fetches);
    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT.replace("Before", "Earlier"));
    expect(docs.documentFetches).toBe(fetches + 1);
  });

  it.skipIf(r.drive)("a read that finds a version unreadable marks no pending edit", async () => {
    let docs = docsWithBody(tableBody());
    let facet = "read-version-unreadable";
    await edit(facet, "replaceText", "Before", "Earlier");
    await edit(facet, "replaceText", "After", "Later");
    let content = await hooks().readContent(facet);
    // The second edit is to be made again, in a version whose run is gone.
    await loseFirstEditsVersion(facet);
    await hooks().docStoreExec(facet,
      "DELETE FROM doc_result WHERE version IN (SELECT child FROM doc_result)");
    let fetches = docs.documentFetches;

    await expect(Promise.resolve(hooks().readContent(facet))).rejects.toThrow(
      "The stored copy of this Google Doc could not be read back. Read it again.");

    // The copy is gone, and both edits are as they were: the next read fetches and shows them.
    expect(await hooks().docCopyHead(facet)).toBeNull();
    for (let key of ["pending:action:1", "pending:action:2"]) {
      let { kv = "{}" } = await hooks().storedValue(facet, "doc", key);
      expect(JSON.parse(kv)).not.toHaveProperty("invalidatedReason");
    }
    expect(await hooks().readContent(facet)).toBe(content);
    expect(docs.documentFetches).toBe(fetches + 1);
  });

  // A record removed before a later step threw would be answered as unknown at every retry.
  it.skipIf(r.drive)("leaves the record in place when a rejection cannot be settled", async () => {
    docsWithBody(tableBody());
    let facet = "table-reject-unsettled";
    await hooks().applyStorage(facet, [
      storedAction(1, { type: "deleteTableRows", at: 1, count: 1, expected: tableOf(TABLE_ROWS) }),
      storedAction(2, storedRows),
      { kind: "put", key: "pending:action:3", value: null },
    ]);
    let lengths = async () => [
      await hooks().storedValueJsonLength(facet, "pending:action:1"),
      await hooks().storedValueJsonLength(facet, "pending:action:2"),
    ];
    let before = await lengths();

    await expect(Promise.resolve(hooks().rejectAction(facet, 1))).rejects.toThrow();
    expect(await lengths()).toEqual(before);

    // With an action in record 3, the same rejection settles.
    await hooks().applyStorage(facet, [storedAction(3, storedRows)]);
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

  // The text edit takes an item out of the list, making the cell's item its first. The read shows
  // that number while the edit waits, so a change queued behind records the table as it will read.
  it("shows a list number an earlier text edit moves in a table, and applies a change recorded against it", async () => {
    let item = numberedItem;
    let docs = docsWithBody(buildTab([
      item("one"), { table: [[{ paragraphs: [item("two")] }, "Notes\n"]] }, para("After"),
    ], NUMBERED_LIST).body, NUMBERED_LIST);
    let facet = "table-list-number-moved";
    // The table's one row, as it reads while its cell's item is the list's second.
    let second = "<table>\n  <tr>\n" +
      '    <td><ol start="2"><li>two</li></ol></td>\n    <td><p>Notes</p></td>\n  </tr>\n';
    expect(await hooks().readContent(facet)).toBe(`1. one\n\n${second}</table>\n\nAfter\n`);

    let text = await edit(facet, "replaceText", "1. one", "one");
    let first = second.replace(' start="2"', "");
    expect(await hooks().readContent(facet)).toBe(`one\n\n${first}</table>\n\nAfter\n`);
    let rows = await edit(facet, "insertTableRows", { table: 0, cells: [["x", "y"]] });
    let pending = `one\n\n${first}${rowOf("x", "y")}\n</table>\n\nAfter\n`;
    expect(await hooks().readContent(facet)).toBe(pending);

    expect(await hooks().applyAction(facet, text.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(pending);
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    expect(docs.contentBatches).toBe(2);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(pending);
  });

  // The cells are counted in the tab as it will read: a row that waits takes its room.
  // Bound alone: the row records a table of 4,990 cells, past the 100 KiB of a Drive change.
  it.skipIf(r.drive)("counts a queued row against the next once the tab's tables are full", async () => {
    let docs = docsWithBody(fullTab());
    let facet = "table-full";

    await edit(facet, "insertTableRows", { table: 0 });
    await expect(edit(facet, "insertTableRows", { table: 0 }))
      .rejects.toThrow(room("insertTableRows", 5010));
    await expect(edit(facet, "insertTable", { rows: 1, columns: 1 }))
      .rejects.toThrow(room("insertTable", 5001));
    // The generic read alone: the new table's position was never read.
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    // A deletion adds no cell, and is queued.
    await edit(facet, "deleteTableRows", { table: 0, at: 0 });
    expect(docs.contentBatches).toBe(0);
  });

  // Bound alone: the row records a table of 4,990 cells, past the 100 KiB of a Drive change.
  it.skipIf(r.drive)("invalidates a queued row when a collaborator has filled the tab", async () => {
    let docs = docsWithBody(fullTab());
    let facet = "table-filled-since";
    let rows = await edit(facet, "insertTableRows", { table: 0 });
    let before = await hooks().readContent(facet);

    docs.externalBody(MAIN_TAB, fullTab(grid(["More"]), para("")));

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

  it.skipIf(r.drive)("stops queueing table changes once their recorded tables pass the limit", async () => {
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

    expect(await hooks().lastObservations).toEqual(r.positionReads(POSITION_READ));
  });

  // The position's read is authorized before anything is stored: refused, insertTable() queues
  // nothing and the other writes still queue. Bound alone: through Drive the read that prepares any
  // edit is refused, which its own test holds.
  it.skipIf(r.drive)("queues nothing when the read of a new table's position is refused", async () => {
    docsWithBody(buildTab([para("Before")]).body);
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

  // The append waits behind the table's authorization, and the read and the metadata wait for both.
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

  it.skipIf(r.drive)("reads nothing when a table change's arguments are wrong", async () => {
    let docs = docsWithBody(tableBody());

    await expect(edit("table-arguments", "insertTable", { rows: 1, columns: 0 }))
      .rejects.toThrow("insertTable: columns must be a whole number from 1 to 20.");

    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastObservations).toEqual([]);
    expect(await hooks().lastActionDescription).toBe("");
  });
});

/** What a read's replay stores with an edit it drops for `reason`. */
const droppedByRead = (reason: string) =>
  `Pending Google Doc edit could not be replayed against the current document: ${reason} ` +
  "This edit was dropped from the document. Reject it and retry if it is still needed.";

describe.each(RUNS)("Google Doc edits replayed on the copy of the document, $name", r => {
  inRun(r);

  it.skipIf(r.drive)("keeps a tab larger than one stored value", async () => {
    let lines = Array.from({ length: 4_000 }, (_, line) => `line ${line} ${"x".repeat(700)}`);
    let docs = docsWithBody(buildTab(lines.map(para)).body);
    let facet = "copy-larger-than-one-value";
    let stored = new TextEncoder().encode(JSON.stringify(pruneTab(docs.bodyTab()))).length;
    expect(stored).toBeGreaterThan(3 * 1024 * 1024);

    let content = await hooks().readContent(facet);
    expect(content).toBe(lines.map(line => `${line}\n`).join("\n"));
    let { actionId } = await edit(facet, "replaceText", "line 2000 ", "changed 2000 ");
    let pending = content.replace("line 2000 ", "changed 2000 ");
    expect(await hooks().readContent(facet)).toBe(pending);

    // Another activation has only what was stored: the read comes out of the stored copy.
    await hooks().restartDoc(facet);
    expect(await hooks().readContent(facet)).toBe(pending);
    expect(docs.documentFetches).toBe(1);
    expect(docs.revisionProbes).toBe(0);

    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(pending);
    expect(await hooks().readContent(facet)).toBe(pending);
  });

  it("reads a document whole when Google refuses the fields asked of it", async () => {
    let error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.refusedMasks = 1;
    docs.install();
    let facet = "fields-refused";

    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n");
    expect(docsRequestsSince(0)).toEqual(["read", "read"]);
    expect(docs.documentFetches).toBe(2);
    expect(unmaskedFetches).toBe(1);
    unmaskedFetches = 0;
    let refusals = error.mock.calls.map(([line]) => line as Record<string, unknown>)
      .filter(line => line.event === "google.doc.read.fields-refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      component: "gatekeeper.google.docs", fallback: "unmasked", httpStatus: 400,
      providerStatus: "INVALID_ARGUMENT",
    });
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/Alpha|Beta|tabProperties|doc-1/);

    // The copy made of the whole answer takes an edit as any other.
    let { actionId } = await edit(facet, "replaceText", "Alpha", "Gamma");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.text()).toBe("Gamma\nBeta");
  });

  it("reads text cut inside a surrogate pair as it was queued, and finds it quoted back", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha");
    docs.install();
    let facet = "half-pair";
    await hooks().readContent(facet);
    await hooks().submitAppend(facet, "tail \ud83d end");

    // The first read after the edit and every later one, which storage serves.
    let pending = units("Alpha\n\ntail \ud83d end\n");
    for (let read = 0; read < 3; read++) {
      expect(units(await hooks().readContent(facet)), `read ${read}`).toEqual(pending);
    }

    await hooks().submitReplace(facet, "tail \ud83d end", "tail end");
    expect(await hooks().readContent(facet)).toBe("Alpha\n\ntail end\n");
  });

  it("reads a tab the model cannot index and takes no edit to it", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let words = ["Zebra", "Quokka", "Wombat", "Numbat", "Bilby", "Dingo"];
    let docs = docsWithBody(buildTab([
      para("Zebra"), grid(["Quokka", "Wombat"], ["Numbat", "Bilby"]), para("Dingo"),
    ]).body);
    docs.addTab("notes", "Notes", MAIN_TAB, "Other");
    let facet = "tab-unindexed";
    let content = await hooks().readContent(facet, MAIN_TAB);
    let rowsOut = await edit(facet, "deleteTableRows", { table: 0, at: 1 }, MAIN_TAB);
    let rowsIn = await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] }, MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).not.toBe(content);

    // A collaborator's edit leaves an empty text run, which the model does not index.
    let body = structuredClone(docs.bodyTab().body);
    let first = body.content.find(element => element.paragraph)!;
    first.paragraph!.elements.unshift({
      startIndex: first.startIndex, endIndex: first.startIndex,
      textRun: { content: "", textStyle: {} },
    });
    docs.externalBody(MAIN_TAB, body);
    passSnapshotTtl();

    // The tab reads as it is, and both table changes are dropped for the one reason: the first
    // closes no gate for the second.
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe(content);
    for (let [{ actionId }, type] of [[rowsOut, "deleteTableRows"], [rowsIn, "insertTableRows"]] as const) {
      expect(await hooks().applyAction(facet, actionId))
        .toBe(droppedByRead(unindexedTabRefusal(type).message));
    }
    expect(docs.contentBatches).toBe(0);

    await expect(edit(facet, "replaceText", "Zebra", "Okapi", MAIN_TAB))
      .rejects.toThrow(unindexedTabRefusal("replaceText").message);
    await expect(edit(facet, "appendText", "more", MAIN_TAB))
      .rejects.toThrow(unindexedTabRefusal("appendText").message);
    await expect(edit(facet, "insertTable", { rows: 1, columns: 1 }, MAIN_TAB))
      .rejects.toThrow(unindexedTabRefusal("insertTable").message);
    // The other tab takes edits.
    let appended = await edit(facet, "appendText", "more", "notes");
    expect(await hooks().readContent(facet, "notes")).toBe("Other\n\nmore\n");
    expect(await hooks().applyAction(facet, appended.actionId)).toBeNull();

    // A line is logged for each refused call and each dropped edit, and none holds the tab's text.
    let logged = warn.mock.calls.map(([line]) => line as Record<string, unknown>)
      .filter(line => line?.event === "google.doc.tab.unindexed");
    expect(logged.map(({ actionId, operation }) => ({ actionId, operation }))).toEqual([
      { actionId: rowsOut.actionId, operation: "deleteTableRows" },
      { actionId: rowsIn.actionId, operation: "insertTableRows" },
      { actionId: undefined, operation: "replaceText" },
      { actionId: undefined, operation: "appendText" },
      { actionId: undefined, operation: "insertTable" },
    ]);
    let written = JSON.stringify(warn.mock.calls);
    for (let word of words) expect(written).not.toContain(word);
  });

  it("drops the edits queued for a tab when a write to it is refused because the model cannot index it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let docs = docsWithBody(buildTab([para("Zebra"), para("Dingo")]).body);
    let facet = "tab-unindexed-write";
    await hooks().readContent(facet, MAIN_TAB);
    let earlier = await edit(facet, "replaceText", "Zebra", "Okapi", MAIN_TAB);

    let body = structuredClone(docs.bodyTab().body);
    let first = body.content.find(element => element.paragraph)!;
    first.paragraph!.elements.unshift({
      startIndex: first.startIndex, endIndex: first.startIndex,
      textRun: { content: "", textStyle: {} },
    });
    docs.externalBody(MAIN_TAB, body);
    passSnapshotTtl();

    // No read comes between: the refused write is what replays the tab.
    await expect(edit(facet, "appendText", "more", MAIN_TAB))
      .rejects.toThrow(unindexedTabRefusal("appendText").message);
    expect(await hooks().applyAction(facet, earlier.actionId))
      .toBe(droppedByRead(unindexedTabRefusal("replaceText").message));
    expect(docs.contentBatches).toBe(0);
  });

  it("takes an edit to a subtitle while another edit to its tab waits", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([
      para("Other text"), { runs: ["Notes here\n"], namedStyleType: "SUBTITLE" }, para("After"),
    ]).body, {}, {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } },
        { namedStyleType: "SUBTITLE", textStyle: { bold: true } },
      ],
    });
    docs.install();
    let facet = "subtitle-behind-an-edit";
    let content = await hooks().readContent(facet);

    let waiting = await edit(facet, "replaceText", "Other text", "Elsewhere");
    let subtitle = await edit(facet, "replaceText", "Notes here", "*Notes* here");

    // Italic is written, since the subtitle's style does not give it.
    expect(await hooks().lastActionFields).toEqual([
      cardField("Old", "Notes here", "markdown"),
      cardField("New", "*Notes* here", "markdown"),
    ]);
    let pending = content.replace("Other text", "Elsewhere").replace("Notes here", "*Notes* here");
    expect(await hooks().readContent(facet)).toBe(pending);
    expect(await hooks().applyAction(facet, waiting.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, subtitle.actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(pending);
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(pending);
  });

  it.skipIf(r.drive)("refuses at the call an append that approval would refuse", async () => {
    // A top-level item behind a nested one that anchors an image could only be placed by
    // rewriting that item, which the request builder refuses.
    let lists = { "list-1": { listProperties: { nestingLevels: presetLevels() } } };
    let tab = buildTab([
      { runs: ["a\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["b\n"], bullet: { listId: "list-1", nestingLevel: 1 } },
    ], lists);
    docsWithBody(anchorImage(tab, tab.body.content.length - 1).body, lists);
    let facet = "append-refused-at-the-call";

    await expect(edit(facet, "appendText", "- c")).rejects.toThrow(POSITIONED_ITEM_BEFORE);
    expect(await hooks().storedValueJsonLength(facet, "pending:action:1")).toBeUndefined();
    // An item at the nested one's level rewrites nothing, and is queued.
    expect((await edit(facet, "appendText", "    - c")).actionId).toBe(1);
  });

  it.skipIf(r.drive)("drops an edit a read finds will not apply, and shows the tab without it", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta\nGamma");
    docs.install();
    let facet = "edit-dropped-by-a-read";
    let first = await edit(facet, "replaceText", "Alpha", "First");
    let third = await edit(facet, "replaceText", "Gamma", "Third");
    expect(await hooks().readContent(facet)).toBe("First\n\nBeta\n\nThird\n");
    let key = `pending:action:${third.actionId}`;
    let queued = await hooks().storedValueJsonLength(facet, key);

    // A collaborator's edit removes what the second edit quotes.
    docs.externalEdit(MAIN_TAB, "Alpha\nBeta\nDelta");
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe("First\n\nBeta\n\nDelta\n");

    let dropped = await hooks().storedValueJsonLength(facet, key);
    expect(dropped).toBeGreaterThan(queued ?? Infinity);
    expect(await hooks().applyAction(facet, third.actionId)).toBe(droppedByRead(
      `replaceText: oldMarkdown was not found in the current simulated tab "${MAIN_TAB}". ` +
      `Make sure the text exactly matches content returned by getContent("${MAIN_TAB}").`));
    expect(await hooks().readContent(facet)).toBe("First\n\nBeta\n\nDelta\n");
    expect(await hooks().storedValueJsonLength(facet, key)).toBe(dropped);
    expect(await hooks().applyAction(facet, first.actionId)).toBeNull();
    expect(docs.contentBatches).toBe(1);
  });

  it.skipIf(r.drive)("asks Google nothing more after an edit that sent nothing is approved with nothing behind it", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    // A single line break is written as the paragraph break the tab already has there.
    let unchanged = ["replaceText", "Alpha\n\nBeta", "Alpha\nBeta"] as const;
    let facet = "apply-sends-nothing";
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n");
    let alone = await edit(facet, ...unchanged);
    expect(docs.documentFetches).toBe(1);

    expect(await hooks().applyAction(facet, alone.actionId)).toBeNull();
    expect(docs.contentBatches).toBe(0);
    // The approval fetched the document for itself, and nothing for a replay nobody needs.
    expect(docs.documentFetches).toBe(2);
    expect(docs.revisionProbes).toBe(0);
    // The copy is kept, and is due a check of its revision.
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n");
    expect(docs.revisionProbes).toBe(1);
    expect(docs.documentFetches).toBe(2);

    // With an edit behind it, the approval replays the queue over the copy once it is checked.
    let behind = "apply-sends-nothing-behind";
    expect(await hooks().readContent(behind)).toBe("Alpha\n\nBeta\n");
    let first = await edit(behind, ...unchanged);
    await edit(behind, "appendText", "more");
    let fetches = docs.documentFetches;
    let probes = docs.revisionProbes;
    expect(await hooks().applyAction(behind, first.actionId)).toBeNull();
    expect(docs.contentBatches).toBe(0);
    expect(docs.documentFetches).toBe(fetches + 1);
    expect(docs.revisionProbes).toBe(probes + 1);
    expect(await hooks().readContent(behind)).toBe("Alpha\n\nBeta\n\nmore\n");
    expect(docs.documentFetches).toBe(fetches + 1);
    expect(docs.revisionProbes).toBe(probes + 1);
  });
});

// A queue nobody wrote by hand

const SECOND_TAB = "tab-2";
const GENERATED_TABS = [MAIN_TAB, SECOND_TAB];
const GENERATED_LISTS: GoogleDocsTab["lists"] = {
  bullets: { listProperties: { nestingLevels: presetLevels() } },
  numbers: { listProperties: { nestingLevels: presetLevels(true) } },
};

/** The kinds of edit the generator proposes, each once for a seed, in the seed's order. */
const GENERATED_KINDS = [
  "replace a paragraph word", "replace a cell's text", "append a paragraph", "append a list item",
  "insertTableRows", "insertTableColumns", "deleteTableRows", "deleteTableColumns",
  "mergeTableCells", "unmergeTableCells", "setTableCellStyle", "setTableColumnWidths",
  "setTableRowHeights", "insertTable", "deleteTable",
] as const;
type GeneratedKind = typeof GENERATED_KINDS[number];

/** A word of the generated documents: two letters and three digits, so none is part of another. */
const GENERATED_WORD = /[a-z]{2}\d{3}/g;

/** A tab of distinct words: paragraphs, a bulleted and a numbered list, and `tables` tables. */
function generatedTab(letter: string, tables: 1 | 2): GoogleDocsTab["body"] {
  let count = 0;
  let word = () => `${letter}w${String(count++).padStart(3, "0")}`;
  let item = (listId: string) => ({ runs: [`${word()}\n`], bullet: { listId } });
  let words = (rows: number, columns: number) => grid(...Array.from({ length: rows }, () =>
    Array.from({ length: columns }, word)));
  return buildTab([
    para(word()), item("bullets"), item("bullets"), para(word()), words(3, 2),
    para(word()), item("numbers"), item("numbers"), para(word()),
    ...(tables === 2 ? [words(2, 3), para(word())] : []),
  ], GENERATED_LISTS).body;
}

/** The tables a read shows: for each, its rows as the attributes and the word of every cell. */
function shownTables(content: string): { attributes: string; word?: string }[][][] {
  return [...content.matchAll(/<table[\s\S]*?<\/table>/g)].map(([html]) =>
    html.split("<tr").slice(1).map(row =>
      [...row.matchAll(/<td([^>]*)>(?:<p>([a-z]{2}\d{3})<\/p><\/td>)?/g)]
        .map(([, attributes, word]) => ({ attributes, ...(word ? { word } : {}) }))));
}

/** One edit the generator proposed, or the add of a tab queued among them, and what became of it. */
type GeneratedEdit = {
  kind: GeneratedKind | "add a tab"; tabId: string; method?: WriteMethod; args?: unknown[];
  outcome: string;
};

/** One seed by default, two in the wider run, which between them queue every kind of edit. */
const SEEDS = ([
  { seed: 1, mode: "approve or reject" }, { seed: 60, mode: "approve all" },
] as const).slice(0, WIDER ? 2 : 1);

// A read of a queue of generated edits shows what approving it does. The fake applies each batch
// with the replay's model, so this holds read, cards and document to one another, not to Google.
describe.each(RUNS)("a queue of generated edits, $name", r => {
  inRun(r);

  /** The kinds the seeds that ran queued between them. */
  const queuedKinds = new Set<GeneratedKind>();
  /** The kinds of which a card said what the edit leaves, and the read was held to it. */
  const comparedKinds = new Set<GeneratedKind>();
  let seedsRun = 0;

  /**
   * Queues every kind of edit once, in the seed's order, and settles the queue from its head.
   * `addsTab` adds a tab once three edits are queued, with two edits of its own, the kinds left
   * picking among the three tabs; `restarts` ends the activation before each step.
   */
  async function settleGenerated(
    { seed, mode }: typeof SEEDS[number], addsTab = false, restarts = false,
  ): Promise<void> {
    let random = seeded(seed);
    let pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    let below = (limit: number) => Math.floor(random() * limit);
    let fresh = 0;
    let word = () => `nw${String(fresh++).padStart(3, "0")}`;
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, generatedTab("a", 2), GENERATED_LISTS);
    docs.addTab(SECOND_TAB, "Second", MAIN_TAB);
    docs.setBody(SECOND_TAB, generatedTab("b", 1), GENERATED_LISTS);
    docs.install();
    let facet = `generated-${addsTab ? "added-tab" : "queue"}-${seed}${restarts ? "-restarts" : ""}`;
    let proposed: GeneratedEdit[] = [];
    /** The tabs the queue has: the document's, and the one a queued add makes, by the ID given. */
    let tabs: string[] = GENERATED_TABS;
    /** The tab Google made for each add that applied, by the ID the add was given. */
    let made = new Map<string, string>();
    let readBoth = async (): Promise<Record<string, string>> => Object.fromEntries(
      await Promise.all(tabs.map(async tabId =>
        [tabId, await hooks().readContent(facet, tabId)] as const)));
    let applied = () => Object.fromEntries(tabs.flatMap(tabId => {
      let inDocument = GENERATED_TABS.includes(tabId) ? tabId : made.get(tabId);
      return inDocument === undefined ? []
        : [[tabId, docTabToMarkdown(docs.bodyTab(inDocument)).markdown] as const];
    }));
    /**
     * Reads every tab, ends the activation, and reads every tab again: the object that starts over
     * answers the same from storage alone, fetching nothing.
     */
    let acrossRestart = async () => {
      if (!restarts) return;
      let before = await readBoth();
      let fetches = docs.documentFetches;
      let stored = docStoreCost.resultsStored;
      await hooks().restartDoc(facet);
      expect(await readBoth(), "the reads after a restart").toEqual(before);
      expect(docs.documentFetches, "fetches across a restart").toBe(fetches);
      expect(docStoreCost.resultsStored, "results made across a restart").toBe(stored);
    };

    /** The call of `kind` that a read of a tab suggests, or nothing where it suggests none. */
    let callOf = (kind: GeneratedKind, content: string): [WriteMethod, ...unknown[]] | undefined => {
      let tables = shownTables(content);
      let outside = content.replace(/<table[\s\S]*?<\/table>/g, "");
      let once = (text: string) => [...new Set(text.match(GENERATED_WORD))]
        .filter(candidate => content.split(candidate).length === 2);
      let at = below(Math.max(tables.length, 1));
      let rows = tables[at] ?? [];
      let row = below(Math.max(rows.length, 1));
      let column = below(Math.max(rows[0]?.length ?? 0, 1));
      let needsTable = kind !== "replace a paragraph word" && kind !== "append a paragraph" &&
        kind !== "append a list item" && kind !== "insertTable";
      if (needsTable && tables.length === 0) return undefined;
      switch (kind) {
        case "replace a paragraph word": {
          let words = once(outside);
          return words.length === 0 ? undefined : ["replaceText", pick(words), word()];
        }
        case "replace a cell's text": {
          let words = rows.flat().flatMap(cell => cell.word ?? []).filter(candidate =>
            content.split(candidate).length === 2);
          return words.length === 0 ? undefined
            : ["replaceText", `<p>${pick(words)}</p>`, `<p>${word()}</p>`];
        }
        case "append a paragraph":
          return ["appendText", `${word()} ${word()}`];
        case "append a list item":
          return ["appendText", `${pick(["-", "1."])} ${word()}`];
        case "insertTableRows":
          return ["insertTableRows", {
            table: at, at: below(rows.length + 1), cells: [rows[0].map(() => word())],
          }];
        case "insertTableColumns":
          return ["insertTableColumns", {
            table: at, at: below(rows[0].length + 1), cells: rows.map(() => [word()]),
          }];
        case "deleteTableRows":
          return ["deleteTableRows", { table: at, at: row }];
        case "deleteTableColumns":
          return ["deleteTableColumns", { table: at, at: column }];
        case "mergeTableCells":
          return ["mergeTableCells", {
            table: at, row, column, ...pick([{ rows: 1, columns: 2 }, { rows: 2, columns: 1 }]),
          }];
        case "unmergeTableCells": {
          // A merged cell the read shows, in any table of the tab.
          let merged = tables.flatMap((shown, index) => shown.flatMap((cells, line) =>
            cells.flatMap((cell, position) => /(row|col)span=/.test(cell.attributes)
              ? [{ table: index, row: line, column: position }] : [])));
          return ["unmergeTableCells", merged.length === 0 ? { table: at, row, column } : pick(merged)];
        }
        case "setTableCellStyle":
          return ["setTableCellStyle", {
            table: at, row, column, style: { background: `#${String(100000 + below(899999))}` },
          }];
        case "setTableColumnWidths":
          return ["setTableColumnWidths", { table: at, at: column, width: 40 + below(100) }];
        case "setTableRowHeights":
          return ["setTableRowHeights", { table: at, at: row, height: 20 + below(40) }];
        case "insertTable": {
          let words = once(outside);
          return ["insertTable", {
            rows: 1 + below(2), columns: 2, cells: [[word(), word()]],
            ...(words.length > 0 && random() < 0.5 ? { after: pick(words) } : {}),
          }];
        }
        case "deleteTable":
          return ["deleteTable", at];
      }
    };

    try {
      // Queue: every kind once, in the seed's order, each built from what a read shows.
      let kinds = [...GENERATED_KINDS];
      for (let index = kinds.length - 1; index > 0; index--) {
        let other = below(index + 1);
        [kinds[index], kinds[other]] = [kinds[other], kinds[index]];
      }
      let queue: { edit: GeneratedEdit; actionId: number; pending: Record<string, string> }[] = [];
      /** What is still to propose: a kind, or a call already made up for a tab. */
      let steps: { kind: GeneratedKind; tabId?: string; call?: [WriteMethod, ...unknown[]] }[] =
        kinds.map(kind => ({ kind }));
      for (let step; (step = steps.shift()) !== undefined;) {
        let { kind } = step;
        await acrossRestart();
        let tabId = step.tabId ?? pick(tabs);
        let call = step.call ?? callOf(kind, await hooks().readContent(facet, tabId));
        let entry: GeneratedEdit = { kind, tabId, outcome: "nothing to propose" };
        proposed.push(entry);
        if (!call) continue;
        let [method, ...args] = call;
        Object.assign(entry, { method, args });
        let queued = await edit(facet, method, ...args, tabId).catch((error: Error) => error);
        if (queued instanceof Error) {
          entry.outcome = `refused: ${queued.message}`;
          continue;
        }
        entry.outcome = `queued as ${queued.actionId}`;
        // The card of this edit, taken before a read: the hooks hold the card of the last call.
        let fields = await hooks().lastActionFields;
        let pending = await readBoth();
        // What the card says the edit leaves is in the read.
        let shows = method === "replaceText" ? ["New"]
          : method === "appendText" ? ["Content", "Resulting"]
          : ["Resulting", "Resulting (first lines)"];
        let shown = fields.filter(field => shows.includes(field.label));
        // A text edit's card always says what it leaves; a table change's, where it adds a line.
        if (method === "replaceText" || method === "appendText") {
          expect(shown, `the card of edit ${queued.actionId}`).toHaveLength(1);
        }
        for (let field of shown) {
          if (field.kind !== "text") throw new Error(`${field.label} is not a text field`);
          expect(pending[tabId], `${field.label} of edit ${queued.actionId}`).toContain(field.value);
        }
        queue.push({ edit: entry, actionId: queued.actionId, pending });
        if (!addsTab) queuedKinds.add(kind);
        if (!addsTab && shown.length > 0) comparedKinds.add(kind);
        if (addsTab && queue.length === 3) {
          let added = await addTab(facet, "Added");
          tabs = [...tabs, added.tabId];
          let add: GeneratedEdit =
            { kind: "add a tab", tabId: added.tabId, outcome: `queued as ${added.actionId}` };
          proposed.push(add);
          queue.push({ edit: add, actionId: added.actionId, pending: await readBoth() });
          // Every seed has edits in the tab still waiting for its add.
          steps.unshift(
            { kind: "append a paragraph", tabId: added.tabId, call: ["appendText", word()] },
            { kind: "insertTable", tabId: added.tabId, call: ["insertTable", { rows: 1, columns: 2 }] });
        }
      }
      expect(queue.length).toBeGreaterThanOrEqual(6);

      // Settle from the head, in order.
      let expected = queue.at(-1)!.pending;
      let rejected = false;
      for (let { edit: entry, actionId, pending } of queue) {
        await acrossRestart();
        if (mode === "approve or reject" && random() < 1 / 3) {
          let restart = await hooks().rejectAction(facet, actionId);
          entry.outcome += ", rejected";
          rejected = true;
          if (entry.kind === "add a tab") {
            // The tab goes, and the edits queued for it answer a reason at their approval.
            expect(restart).toEqual({ restart: true });
            tabs = tabs.filter(tabId => tabId !== entry.tabId);
          }
          // What the rejection leaves is what the later approvals must keep.
          expected = await readBoth();
          continue;
        }
        let batches = docs.contentBatches;
        let answer = await hooks().applyAction(facet, actionId);
        if (answer === null) {
          entry.outcome += ", approved";
          // Reads by the ID the add was given go on: they show the tab Google made.
          if (entry.kind === "add a tab") made.set(entry.tabId, docs.tabs.at(-1)!.id);
          // The document holds what the read showed of the queue as far as this edit.
          if (mode === "approve all") expect(applied(), `after edit ${actionId}`).toEqual(pending);
        } else {
          // Only an edit a rejection invalidated answers with a reason, and it sends nothing.
          entry.outcome += `, answered: ${answer}`;
          expect(rejected, `edit ${actionId} answered: ${answer}`).toBe(true);
          expect(docs.contentBatches).toBe(batches);
          await hooks().rejectAction(facet, actionId);
        }
        expect(await readBoth(), `the read after edit ${actionId}`).toEqual(expected);
      }

      // Nothing is pending: a read of the document is the document.
      passSnapshotTtl();
      expect(await readBoth()).toEqual(applied());
      if (!addsTab) seedsRun++;
    } catch (cause) {
      throw new Error(
        `seed ${seed} (${mode}) failed: ${cause instanceof Error ? cause.message : cause}\n` +
        JSON.stringify(proposed, null, 2), { cause });
    }
  }

  it.each(SEEDS)("reads as approving it leaves the document: seed $seed, $mode",
    seed => settleGenerated(seed));

  // A Drive binding adds no tab.
  it.skipIf(r.drive).each(SEEDS)(
    "reads as approving it leaves the document, with a tab added in mid-queue: seed $seed, $mode",
    seed => settleGenerated(seed, true));

  // An activation that starts over reads every pending state from storage alone: the copy, each
  // pending edit's result and each rendering, a pending add's tab and the edits in it included.
  it.skipIf(r.drive)("reads every pending state the same after the object starts again " +
    "between two steps", () => settleGenerated(SEEDS[0], true, true));

  // The sweep in an approval's handoff and in a rejection keeps the blank tab a pending add
  // makes and what the edits queued in it made.
  it.skipIf(r.drive)("makes no result twice across approvals and rejections", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, generatedTab("a", 2), GENERATED_LISTS);
    docs.addTab(SECOND_TAB, "Second", MAIN_TAB);
    docs.setBody(SECOND_TAB, generatedTab("b", 1), GENERATED_LISTS);
    docs.install();
    let facet = "generated-no-result-twice";
    let first = await edit(facet, "appendText", "nw900 nw901", MAIN_TAB);
    let second = await edit(facet, "appendText", "nw902", SECOND_TAB);
    let added = await addTab(facet, "Added");
    await edit(facet, "appendText", "nw903", added.tabId);
    await edit(facet, "insertTable", { rows: 1, columns: 2 }, added.tabId);
    let content = await hooks().readContent(facet, added.tabId);
    expect(content).toContain("nw903");
    /** What a read of the added tab makes: no result, and no tab. */
    let readAdded = async () => {
      let before = { stored: docStoreCost.resultsStored, clones: replayCost.tabClones };
      expect(await hooks().readContent(facet, added.tabId)).toBe(content);
      return {
        stored: docStoreCost.resultsStored - before.stored,
        clones: replayCost.tabClones - before.clones,
      };
    };

    expect(await readAdded()).toEqual({ stored: 0, clones: 0 });
    expect(await hooks().applyAction(facet, first.actionId)).toBeNull();
    expect(await readAdded()).toEqual({ stored: 0, clones: 0 });
    await hooks().rejectAction(facet, second.actionId);
    expect(await readAdded()).toEqual({ stored: 0, clones: 0 });
  });

  it("queues every kind of edit between its seeds", context => {
    // Says nothing of a run that left seeds out, or of the default run's one seed.
    if (!WIDER || seedsRun !== SEEDS.length) context.skip();
    expect([...queuedKinds].toSorted()).toEqual(GENERATED_KINDS.toSorted());
    // A deletion adds no line to the tab, so its card has no result to hold the read to.
    expect([...comparedKinds].toSorted()).toEqual(
      GENERATED_KINDS.filter(kind => !kind.startsWith("delete")).toSorted());
  });
});

describe.each(RUNS)("Google Doc structured elements, $name", r => {
  inRun(r);

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

/** Each paragraph of the main tab: its text, and the list and level it is an item of. */
function storedParagraphs(docs: DocsModel) {
  return docs.bodyTab().body.content.flatMap(element => element.paragraph ? [{
    text: element.paragraph.elements.map(part => part.textRun?.content ?? "").join(""),
    bullet: element.paragraph.bullet,
  }] : []);
}

describe.each(RUNS)("Google Doc list edits, $name", r => {
  inRun(r);

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

  it("reads a list written through approval as Google would store it", async () => {
    let docs = new DocsModel();
    docs.install();
    let facet = "stored-list";
    let nestedId = await hooks().submitAppend(facet, "- a\n  - b\n    - c");
    expect(await hooks().applyAction(facet, nestedId)).toBeNull();

    // Google makes one list of the preset's nine levels, takes the tabs that carried each item's
    // level off its text, and keeps none of the empty paragraph the levels were counted from
    // (recorded: `nesting-outdent / a nested list`).
    let listId = storedParagraphs(docs)[0].bullet?.listId;
    expect(storedParagraphs(docs)).toEqual([
      { text: "a\n", bullet: { listId } },
      { text: "b\n", bullet: { listId, nestingLevel: 1 } },
      { text: "c\n", bullet: { listId, nestingLevel: 2 } },
    ]);
    expect(docs.bodyTab().lists).toEqual({
      [listId!]: { listProperties: { nestingLevels: presetLevels() } },
    });

    // An item appended after the nested ones joins their list, at the level it is written at
    // (recorded: `nesting-outdent / a top-level item appended after the nested one`).
    let joinedId = await hooks().submitAppend(facet, "- d");
    expect(await hooks().applyAction(facet, joinedId)).toBeNull();
    expect(storedParagraphs(docs)).toEqual([
      { text: "a\n", bullet: { listId } },
      { text: "b\n", bullet: { listId, nestingLevel: 1 } },
      { text: "c\n", bullet: { listId, nestingLevel: 2 } },
      { text: "d\n", bullet: { listId } },
    ]);
    expect(Object.keys(docs.bodyTab().lists)).toEqual([listId]);
    expect(await hooks().readContent(facet)).toBe("- a\n  - b\n    - c\n- d\n");
  });

  it("reads a numbered item added after a numbered list with the list's next number", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["a", "b", "c"]);
    docs.install();
    let actionId = await hooks().submitAppend("next-number", "1. d");

    expect(await hooks().applyAction("next-number", actionId)).toBeNull();
    // The item counts on from the list's third only because it is an item of that list
    // (recorded: `bullets-numbering-2 / a fourth item appended`).
    let lists = storedParagraphs(docs).map(item => item.bullet?.listId);
    expect(lists).toEqual(Array(4).fill(lists[0]));
    expect(docs.renderedText()).toBe("1. a\n2. b\n3. c\n4. d");
  });

  it("shows an item written in front of a list as a list of its own, waiting and applied", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["Lead", "one", "two"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.install();
    let facet = "item-before-list";
    let actionId = await hooks().submitReplace(facet, "Lead", "- Lead");

    // Google never joins a new item to the list after it: the item is a list of its own, so a
    // blank line stays between the two (recorded: `bullets-never-following / the paragraph
    // becomes an item`).
    expect(await hooks().readContent(facet)).toBe("- Lead\n\n- one\n- two\n");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("- Lead\n\n- one\n- two\n");
    expect(docs.renderedText()).toBe("1. Lead\n1. one\n2. two");
  });

  it("shows two items rewritten together as items of the one list, waiting and applied", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["Intro", "a", "b", "c", "Outro"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.interruptList(MAIN_TAB, 4);
    docs.install();
    let facet = "two-items-rewritten";
    let actionId = await hooks().submitReplace(facet, "- a\n- b", "- x\n- y");

    // A text edit inside a list item leaves its bullet, and this batch edits only text inside
    // each item, so the three stay one list (recorded: `list-text-edits / bold inside a nested
    // item`).
    expect(await hooks().readContent(facet)).toBe("Intro\n\n- x\n- y\n- c\n\nOutro\n");
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.lastContentRequests.filter(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request)).toEqual([]);
    expect(await hooks().readContent(facet)).toBe("Intro\n\n- x\n- y\n- c\n\nOutro\n");
    expect(docs.renderedText()).toBe("Intro\n1. x\n2. y\n3. c\nOutro");
  });

  it("removes a list item quoted without its line break, and reads the list whole", async () => {
    let lists = { "list-1": { listProperties: { nestingLevels: presetLevels() } } };
    let docs = docsWithBody(buildTab([
      { runs: ["a\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["b\n"], bullet: { listId: "list-1", nestingLevel: 1 } },
      { runs: ["c\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["d\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      para("End"),
    ], lists).body, lists);
    let facet = "item-removed";

    // A nested item quoted from its marker: the card shows the line the change took.
    let nested = await edit(facet, "replaceText", "- b", "");
    expect(await hooks().lastActionFields).toEqual([
      cardField("Old", "  - b\n", "markdown"),
      cardField("Requested New", "  \n", "markdown"),
      cardField("New", "", "markdown"),
    ]);
    expect(await hooks().readContent(facet)).toBe("- a\n- c\n- d\n\nEnd\n");

    let top = await edit(facet, "replaceText", "- c", "");
    expect(await hooks().lastActionFields).toEqual([
      cardField("Old", "- c\n", "markdown"),
      cardField("Requested New", "\n", "markdown"),
      cardField("New", "", "markdown"),
    ]);
    let pending = await hooks().readContent(facet);
    expect(pending).toBe("- a\n- d\n\nEnd\n");

    expect(await hooks().applyAction(facet, nested.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, top.actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(pending);
  });

  it("writes an item at the blank line behind a nested item at its level", async () => {
    let lists = { "list-1": { listProperties: { nestingLevels: presetLevels() } } };
    let docs = docsWithBody(buildTab([
      { runs: ["p\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["a\n"], bullet: { listId: "list-1", nestingLevel: 1 } },
      para("End"),
    ], lists).body, lists);
    let facet = "item-behind-nested";

    // Google nests a bulleted range from the item it joins (recorded: `bullets-nesting`), so the
    // item is bulleted from the nested item's level.
    let sibling = await edit(facet, "replaceText", "\n\nEnd", "\n  - x\n\nEnd");
    expect(await hooks().readContent(facet)).toBe("- p\n  - a\n  - x\n\nEnd\n");

    let top = await edit(facet, "replaceText", "\n\nEnd", "\n- y\n\nEnd");
    // The card shows the item as it was written: what will read is what was asked for.
    expect(await hooks().lastActionFields).toEqual([
      cardField("Old", "\n\nEnd", "markdown"),
      cardField("New", "\n- y\n\nEnd", "markdown"),
    ]);
    let pending = await hooks().readContent(facet);
    expect(pending).toBe("- p\n  - a\n  - x\n- y\n\nEnd\n");

    expect(await hooks().applyAction(facet, sibling.actionId)).toBeNull();
    expect(await hooks().applyAction(facet, top.actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(pending);
  });

  it("refuses at the call a list item written past the ninth level", async () => {
    let lists = { "list-1": { listProperties: { nestingLevels: presetLevels() } } };
    docsWithBody(buildTab([
      para("Intro"),
      { runs: ["p\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["a\n"], bullet: { listId: "list-1", nestingLevel: 8 } },
      para("End"),
    ], lists).body, lists);
    let facet = "item-past-the-ninth-level";
    let ninthIndent = " ".repeat(16);
    let tenthIndent = " ".repeat(18);
    let before = await hooks().readContent(facet);
    expect(before).toBe(`Intro\n\n- p\n${ninthIndent}- a\n\nEnd\n`);

    // Appended, a paragraph made an item, and an item written behind the ninth-level one.
    await expect(edit(facet, "appendText", `${tenthIndent}- x`)).rejects.toThrow(LIST_LEVEL_TOO_DEEP);
    await expect(edit(facet, "replaceText", "Intro", `${tenthIndent}- Intro`))
      .rejects.toThrow(LIST_LEVEL_TOO_DEEP);
    await expect(edit(facet, "replaceText", "\n\nEnd", `\n${tenthIndent}- x\n\nEnd`))
      .rejects.toThrow(LIST_LEVEL_TOO_DEEP);
    expect(await hooks().readContent(facet)).toBe(before);

    // A sibling of the ninth-level item is queued, and reads at that level.
    await edit(facet, "replaceText", "\n\nEnd", `\n${ninthIndent}- x\n\nEnd`);
    expect(await hooks().readContent(facet))
      .toBe(`Intro\n\n- p\n${ninthIndent}- a\n${ninthIndent}- x\n\nEnd\n`);
  });

  it("writes list items whose text starts with a tab, and refuses a shallower item behind one before the lines it changes", async () => {
    let lists = { "list-1": { listProperties: { nestingLevels: presetLevels() } } };
    let tab = buildTab([
      { runs: ["a\n"], bullet: { listId: "list-1", nestingLevel: 0 } },
      { runs: ["\tb\n"], bullet: { listId: "list-1", nestingLevel: 1 } },
    ], lists);
    let docs = docsWithBody(tab.body, lists);
    let facet = "item-text-starts-with-a-tab";
    let before = await hooks().readContent(facet);
    expect(before).toBe("- a\n  - \tb\n");

    // Placing a top-level item would bullet the nested one again, and the append holds no text
    // of that item to write its tab back from. Nothing is queued.
    await expect(edit(facet, "appendText", "- c")).rejects.toThrow(TABBED_ITEM_BEFORE);
    expect(await hooks().readContent(facet)).toBe(before);

    // At the nested item's level nothing is bulleted again; the card shows the item as written.
    let nested = await edit(facet, "appendText", "  - \tc");
    expect(await hooks().lastActionFields).toEqual([cardField("Content", "  - \tc", "markdown")]);
    expect(await hooks().readContent(facet)).toBe("- a\n  - \tb\n  - \tc\n");

    // Both nested items are bulleted again with the item behind them, and keep their tabs.
    let again = await edit(facet, "replaceText", "  - \tb\n  - \tc", "  - \tB\n  - \tc\n- d");
    expect(await hooks().readContent(facet)).toBe("- a\n  - \tB\n  - \tc\n- d\n");

    let typed = await edit(facet, "replaceText", "- a", "- \ta");
    let pending = await hooks().readContent(facet);
    expect(pending).toBe("- \ta\n  - \tB\n  - \tc\n- d\n");

    for (let { actionId } of [nested, again, typed]) {
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
    }
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(pending);
  });
});

describe.each(RUNS)("Google Doc write receipts, $name", r => {
  inRun(r);

  it("applies content once and immediately deletes its exact marker", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("normal", "first");

    await hooks().applyAction("normal", actionId);

    expect(docs.text()).toContain("first");
    expect(docs.contentBatches).toBe(1);
    expect(docs.deletedMarkerIds).toEqual(["marker-1"]);
    expect(docs.markers.size).toBe(0);
    run.appliedAgain(await hooks().applyAction("normal", actionId));
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
    // An append is a paragraph of its own, set off by a blank line
    // (recorded: `around-tables / text appended`).
    expect(await hooks().readContent("linked-label-append")).toBe(`base\n\n${editedLink}\n`);
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

  it.skipIf(r.drive)("drops an append stored under an earlier Markdown version", async () => {
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

  it.skipIf(r.drive)("stores one copy of an append payload", async () => {
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

  it.skipIf(r.drive)("rejects an oversized UTF-8 append before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("oversized-append", "é".repeat(600_000)),
    )).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it.skipIf(r.drive)("rejects an oversized aggregate replacement before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "oversized-replacement", "x".repeat(600_000), "y".repeat(600_000),
    ))).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  // What a card shows beyond the edit's own texts is stored with the edit, so it is held to a
  // size of its own. Not run through Drive, where the 100 KiB of a record refuses first.
  it.skipIf(r.drive)("refuses a replacement whose card would show more than 1 MiB of the tab", async () => {
    // Splitting the second item renumbers the third, so the card shows the third whole, before
    // and after: twice the padding.
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["a", "b", `c ${"x".repeat(600_000)}`]);
    docs.install();
    let facet = "oversized-card";

    await expect(Promise.resolve(hooks().submitReplace(facet, "b", "b\n\nplain"))).rejects.toThrow(
      "replaceText: what this edit's approval card would show exceeds the 1048576-byte safe " +
      "submission limit. Split the edit into smaller ones.");
    // Refused by the check against the tab, so the read it took is authorized.
    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(await hooks().lastActionDescription).toBe("");
    expect((await hooks().storedKeys(facet, "doc")).filter(key => key.startsWith("pending:action:")))
      .toEqual([]);
    expect(docs.contentBatches).toBe(0);
  });

  it.skipIf(r.drive)("rejects complex Markdown before reading the document", async () => {
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
    run.appliedAgain(await hooks().applyAction("ambiguous", actionId));
  });

  // An approved edit built from the copy held

  it("applies an approved edit from the copy held, reading no document before the write", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let facet = "copy-apply";
    let { docs, actionId } = await queuedOnCopy(facet);
    let from = requestsMade();
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    // The batch and the deletion of its marker: nothing is queued behind to read the document for.
    expect(docsRequestsSince(from)).toEqual(["content", "cleanup"]);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(docs.text()).toBe("Alpha\nBeta\nAppended");
    expect(copyRefusals(warn)).toEqual([]);
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
  });

  // The suggestion is a batch of the document, so the copy read before it is a revision behind:
  // a batch pinned to it would be refused with nobody else editing.
  // Bound alone: a Drive binding's comment writes are its session's, tried in the Drive block.
  it.skipIf(r.drive).each(["suggestEdit", "comment"] as const)(
    "reads the document for an approved edit once the connection's own %s has been applied",
    async method => {
      let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let facet = `copy-own-${method}`;
      let { docs, actionId } = await queuedOnCopy(facet);
      let own = await hooks().callDoc(facet, method,
        method === "comment" ? ["Really?", { quote: "Alpha" }] : ["Beta", "Gamma"]);
      expect(await hooks().applyAction(facet, own.actionId!)).toBeNull();

      let from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
      expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
      expect(copyRefusals(warn)).toEqual([]);
      expect(docs.contentBatches).toBe(1);
      // A copy read after it builds a write again.
      expect(await nextOnCopy(facet)).toEqual(["content", "cleanup"]);
    });

  // The read fetches the document with the first edit's marker still in it, and the deletion
  // then moves the revision: nothing else tells that copy from a current one. The answer can
  // also reach the connection after the deletion's has.
  it.each([
    ["while the marker was being deleted", false],
    ["before the marker was deleted, in an answer that came after", true],
  ] as const)("reads the document for an approved edit when the copy was read %s", async (_when, late) => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let facet = `copy-read-in-cleanup-${late ? "late" : "inside"}`;
    let { docs, actionId } = await queuedOnCopy(facet);
    let second = await hooks().submitAppend(facet, "Second");
    await hooks().readContent(facet);

    let model = globalThis.fetch;
    let markersRead: number[] = [];
    let reading: Promise<string> | undefined;
    let answered: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let kind = docsRequestKind(input, init);
      if (markersRead.length === 0 && kind === "cleanup") {
        markersRead.push(docs.markers.size);
        if (late) {
          let asked = new Promise<void>(resolve => { answered = resolve; });
          reading = hooks().readContent(facet);
          await asked;
        } else {
          await hooks().readContent(facet);
        }
      } else if (answered && kind === "read") {
        let deliver = answered;
        answered = undefined;
        let answer = await model(input, init);
        deliver();
        // A timer, which a Drive binding's apply does not hang on as it does on a held promise.
        await new Promise(resolve => setTimeout(resolve, 50));
        return answer;
      }
      return model(input, init);
    }));
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    await reading;
    expect(markersRead).toEqual([1]);

    let from = requestsMade();
    expect(await hooks().applyAction(facet, second)).toBeNull();
    expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
    expect(copyRefusals(warn)).toEqual([]);
    expect(docs.text()).toBe("Alpha\nBeta\nAppended\nSecond");
    // A copy read after the deletion builds a write again.
    expect(await nextOnCopy(facet)).toEqual(["content", "cleanup"]);
  });

  describe("a revision id returned 24 hours ago", () => {
    const T = Date.UTC(2026, 0, 1);

    it("builds an approved edit from a copy fetched exactly 24 hours ago", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      let facet = "copy-day-old";
      let { docs, actionId } = await queuedOnCopy(facet);
      vi.setSystemTime(T + DOC_REVISION_PIN_MS);
      let from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
      expect(docsRequestsSince(from)).toEqual(["content", "cleanup"]);
      expect(docs.contentBatches).toBe(1);
      expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
    });

    it("reads the document for one fetched a millisecond before that", async () => {
      let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      let facet = "copy-older-than-a-day";
      let { docs, actionId } = await queuedOnCopy(facet);
      vi.setSystemTime(T + DOC_REVISION_PIN_MS + 1);
      // Past the TTL the copy is confirmed by its revision and not fetched: it is still the copy
      // held, and the check that confirmed it does not make its revision id younger.
      let from = requestsMade();
      expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
      expect(docsRequestsSince(from)).toEqual(["probe"]);

      from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
      expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
      expect(docs.contentBatches).toBe(1);
      expect(copyRefusals(warn)).toEqual([]);
      expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
    });
  });

  it("writes nothing over a collaborator's edit that lands while the write is on its way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let facet = "copy-raced";
    let { docs, actionId } = await queuedOnCopy(facet);
    whileWriting(() => docs.externalEdit(MAIN_TAB, COLLABORATOR));
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    // The batch built from the copy was refused, and the edit applied on top of the collaborator's.
    expect(docsRequestsSince(0)).toEqual(["content", "read", "content", "cleanup"]);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text()).toBe(`${COLLABORATOR}\nAppended`);

    // The collaborator takes the text the edit replaces: it fails as it does on a fresh read.
    let taken = new DocsModel();
    taken.setText(MAIN_TAB, "Alpha\nBeta");
    taken.install();
    facet = "copy-raced-taken";
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n");
    let replaced = await hooks().submitReplace(facet, "Beta", "Gamma");
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nGamma\n");
    whileWriting(() => taken.externalEdit(MAIN_TAB, "Alpha\nDelta"));
    expect(await hooks().applyAction(facet, replaced))
      .toContain("replaceText: oldMarkdown was not found");
    expect(docsRequestsSince(0)).toEqual(["content", "read"]);
    expect(taken.contentBatches).toBe(0);
    expect(taken.text()).toBe("Alpha\nDelta");
  });

  it("settles a write whose answer was lost from the copy a read stored since", async () => {
    let facet = "copy-holds-marker";
    let { docs, actionId } = await queuedOnCopy(facet, model => { model.ambiguousContentResponses = 1; });
    expect(await hooks().applyAction(facet, actionId)).toMatch(/content response lost/);
    expect(docs.contentBatches).toBe(1);

    // The read fetches the document the write moved: its copy holds the write's marker.
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe("Alpha\n\nBeta\n\nAppended\n");
    let from = requestsMade();
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    // Settled from the copy: nothing is read or written before the marker is deleted.
    expect(docsRequestsSince(from)).toEqual(["cleanup"]);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(docs.text()).toBe("Alpha\nBeta\nAppended");
  });

  // Bound alone: a rejection through a Drive binding replays nothing, since no document is in
  // hand there.
  it.skipIf(r.drive)("replays the queue over the copy held when an edit is rejected after its approval failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let docs = docsWithBody(tableBody());
    docs.unsentContentRequests = 1;
    let facet = "copy-kept-for-rejection";
    let above = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["New"]], after: "Before" });
    let rows = await edit(facet, "insertTableRows", { table: 1, cells: [["Ship docs", "Open"]] });

    // The batch built from the copy never reached Google. The copy is not retired with it.
    expect(await hooks().applyAction(facet, above.actionId)).toMatch(/connection dropped/);
    expect(docs.contentBatches).toBe(0);
    await hooks().rejectAction(facet, above.actionId);

    // As in 'follows a table past a rejected insertion above it': the change behind is kept.
    let preview = `Before\n\n${tableOf([...TABLE_ROWS, ["Ship docs", "Open"]])}\n\nAfter\n`;
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(await hooks().applyAction(facet, rows.actionId)).toBeNull();
    passSnapshotTtl();
    expect(await hooks().readContent(facet)).toBe(preview);
    expect(docs.contentBatches).toBe(1);
  });

  // Restarts every object, the Drive binding's receipt included (drive-editors.test.ts).
  it.skipIf(r.drive)("cleans a retained receipt after restart before the next write", async () => {
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
  // Not run through Drive: a Docs request held by a promise the test releases hangs a Drive
  // binding's apply in this harness, though a timer's does not (see the Drive block's run).
  it.skipIf(r.drive)("holds a second approval of one action behind the first", async () => {
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
    run.appliedAgain(await second);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text().match(/first/g)).toHaveLength(1);
    expect(docs.markers.size).toBe(0);
  });

  // Between the handoff and the marker cleanup the edit is committed and its action is gone, so
  // nothing is left to overlay the snapshot the submission cached: it must not be served.
  // Not run through Drive: a Docs request held by a promise the test releases hangs a Drive
  // binding's apply in this harness, though a timer's does not (see the Drive block's run).
  it.skipIf(r.drive)("stops serving the pre-write snapshot once the write is committed", async () => {
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
  // Not run through Drive: a Docs request held by a promise the test releases hangs a Drive
  // binding's apply in this harness, though a timer's does not (see the Drive block's run).
  it.skipIf(r.drive)("refetches a read that Google answered before a write landed", async () => {
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
    r.appliedAgain(await hooks().applyAction(facet, actionId));
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

// A write stored while an approval awaits Google, by holding a provider request open. After the
// restart test above: the runtime does not survive a restart that follows a held request.
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

// The write queue is the document's: a call waits behind the earlier calls of every session. After
// the restart test, as it holds a provider request.
describe("Google Doc writes from several sessions", () => {
  // Each call is a session of its own. Per-session queues would check the replacement before the
  // append it quotes reached Google, and store the second append first.
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
    // A stored record's read takes no turn, so it answers while the first write is held; the pause
    // after it lets the three calls before it settle, if nothing held them.
    expect(await hooks().storedValueJsonLength(facet, "pending:action:1")).toBeUndefined();
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

  // 6 read an upright subtitle as italic, so a quote unique under it can be unique under the
  // current rendering as another paragraph's. Neither kind is replayed or sent.
  it.each([
    ["an append", { type: "appendText", markdown: "added" }],
    ["a replacement", { type: "replaceText", oldMarkdown: "base", newMarkdown: "BASE" }],
  ])("refuses %s stored under the previous rendering, and sends nothing", async (_kind, action) => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = `previous-rendering-${action.type}`;
    await hooks().applyStorage(facet, previous(action));

    expect(await hooks().readContent(facet)).toBe("base\n");
    expect(await hooks().applyAction(facet, 1)).toContain("queued under an earlier Markdown format");
    expect(docs.text()).toBe("base");
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

/** What approving a replacement of "shared" in the tab `metrics` answers once that text is gone. */
const NOT_IN_METRICS =
  'replaceText: oldMarkdown was not found in the current simulated tab "metrics". ' +
  'Make sure the text exactly matches content returned by getContent("metrics").';

describe.each(RUNS)("Google Doc tab isolation, $name", r => {
  inRun(r);

  it("applies every tab's batch with the model, or none of it", async () => {
    let docs = nestedDocs();
    let documentUrl = "https://docs.googleapis.com/v1/documents/doc-1";
    /** One batch that inserts an `x` at an index of each tab named. */
    let batch = (...inserts: [tabId: string, index: number][]) => docs.fetch(
      `${documentUrl}:batchUpdate`, { method: "POST", body: JSON.stringify({
        requests: inserts.map(([tabId, index]) => (
          { insertText: { location: { index, tabId }, text: "x" } })),
      }) });
    let revision = async () => (await docs.fetch(`${documentUrl}?fields=revisionId`)).json();
    let before = await revision();

    // The second tab's index lies past its only paragraph, which Google refuses.
    let refused = await batch([MAIN_TAB, 1], ["details", 99]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: {
      code: 400, status: "INVALID_ARGUMENT",
      message: "The insertion index must be inside the bounds of an existing paragraph. " +
        "You can still create new paragraphs by inserting newlines.",
    } });
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
    expect(await revision()).toEqual(before);

    expect((await batch([MAIN_TAB, 1], ["details", 7])).status).toBe(200);
    expect(docs.text(MAIN_TAB)).toBe("xshared");
    expect(docs.text("details")).toBe("sharedx");
    expect(await revision()).not.toEqual(before);
  });

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

  it("removes each marker from its tab, so the next edit applies too", async () => {
    let docs = nestedDocs();
    let first = await hooks().submitAppend("tabs-cleanup", "one", "metrics");
    let second = await hooks().submitAppend("tabs-cleanup", "two", MAIN_TAB);

    expect(await hooks().applyAction("tabs-cleanup", first)).toBeNull();
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("tabs-cleanup", second)).toBeNull();
    expect(docs.markers.size).toBe(0);
    expect(docs.deletedMarkerIds).toHaveLength(2);
    expect(docs.text("metrics")).toBe("shared\none");
    expect(docs.text(MAIN_TAB)).toBe("shared\ntwo");
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
    let repeated = run.unapplied(
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
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

  // An edit is replayed with its tab. One that a collaborator's change has left unreplayable is
  // found when its tab is read or changed, at an approval that leaves changes queued, or when
  // it is approved itself; until then it is the next change to approve.
  it("holds a later edit behind an unreplayable edit of a tab no read has replayed, until that edit is approved and fails", async () => {
    let docs = nestedDocs();
    let facet = "tabs-held-behind";
    let stale = await hooks().submitReplace(facet, "shared", "changed", "metrics");
    let later = await hooks().submitAppend(facet, "beta", MAIN_TAB);
    docs.externalEdit("metrics", "rewritten");
    passSnapshotTtl();
    // The main tab alone is read, and shows its own edit.
    expect(await hooks().readContent(facet, MAIN_TAB)).toContain("beta");

    expect(await hooks().applyAction(facet, later)).toBe(run.outOfOrder(stale, later));
    expect(docs.contentBatches).toBe(0);
    expect(await hooks().applyAction(facet, stale)).toBe(NOT_IN_METRICS);
    expect(await hooks().applyAction(facet, stale)).toBe(run.unapplied(NOT_IN_METRICS));
    expect(docs.contentBatches).toBe(0);

    expect(await hooks().applyAction(facet, later)).toBeNull();
    expect(docs.contentBatches).toBe(1);
    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("metrics")).toBe("rewritten");
  });

  it("marks an unreplayable edit of another tab at the next approval that leaves changes queued", async () => {
    let docs = nestedDocs();
    let facet = "tabs-marked-at-approval";
    let first = await hooks().submitAppend(facet, "alpha", MAIN_TAB);
    let stale = await hooks().submitReplace(facet, "shared", "changed", "metrics");
    let last = await hooks().submitAppend(facet, "beta", MAIN_TAB);
    docs.externalEdit("metrics", "rewritten");
    passSnapshotTtl();
    expect(await hooks().readContent(facet, MAIN_TAB)).toContain("beta");

    // The replay after this approval is of every tab that has changes queued.
    expect(await hooks().applyAction(facet, first)).toBeNull();
    // No read of the other tab since: its edit no longer holds the one queued after it.
    expect(await hooks().applyAction(facet, last)).toBeNull();
    // The reason that replay stored, which both hosts answer with.
    expect(await hooks().applyAction(facet, stale)).toBe(
      `Pending Google Doc edits could not be replayed after edit ${first} was applied: ` +
      `${NOT_IN_METRICS} This edit was dropped from the document. ` +
      "Reject it and retry if it is still needed.");
    expect(docs.contentBatches).toBe(2);
    expect(docs.text(MAIN_TAB)).toBe("shared\nalpha\nbeta");
    expect(docs.text("metrics")).toBe("rewritten");
  });

  it("does not mark another tab's edit at a listing of the tabs", async () => {
    let docs = nestedDocs();
    let facet = "tabs-listing-marks-none";
    let stale = await hooks().submitReplace(facet, "shared", "changed", "metrics");
    /** The edit as it is stored, or, through Drive, that it still awaits a decision. */
    let queued = async () => run.drive
      ? rawHooks().driveQueued(`drive:${facet}`, { scope: { kind: "file", fileId: "doc-1" }, access: "write" })
      : hooks().storedValue(facet, "doc", `pending:action:${stale}`);
    let before = await queued();
    docs.externalEdit("metrics", "rewritten");
    passSnapshotTtl();
    let fetches = docs.documentFetches;

    expect(await hooks().listTabs(facet)).toHaveLength(3);

    expect(docs.documentFetches).toBe(fetches + 1);
    expect(await queued()).toEqual(before);
    expect(before).toEqual(
      run.drive ? [stale] : expect.objectContaining({ kv: expect.stringContaining('"changed"') }));
  });

  // Bound alone: through Drive each fetch gives the snapshot a view with its tabs decoded afresh,
  // the unchanged ones included.
  it.skipIf(r.drive)("replays a tab's edit over a fetch that brought the tab unchanged", async () => {
    let docs = nestedDocs();
    let facet = "tabs-unchanged-replayed";
    await hooks().submitAppend(facet, "beta", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("shared\n\nbeta\n");
    docs.externalEdit("metrics", "rewritten");
    passSnapshotTtl();
    let before = { folds: replayCost.folds, fetches: docs.documentFetches };

    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("shared\n\nbeta\n");

    // Fetched again: the read replays the tab's one edit over the tab it brought.
    expect(docs.documentFetches).toBe(before.fetches + 1);
    expect(replayCost.folds).toBe(before.folds + 1);
    expect(await hooks().readContent(facet, "metrics")).toBe("rewritten\n");
  });

  it("serializes a tab's queue to queue an edit only where the read that prepares it is authorized", async () => {
    nestedDocs();
    let facet = "tabs-queue-serialized";
    let before = replayCost.fingerprints;

    await hooks().submitReplace(facet, "shared", "changed", MAIN_TAB);

    // Through Drive the queue is serialized at the check and again once the read was authorized,
    // to refuse an edit whose queue moved between the two. A bound Doc authorizes no such read.
    expect(replayCost.fingerprints).toBe(before + (r.drive ? 2 : 0));
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("changed\n");
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

/** Queues `addTab(title, options)` on `facet`, returning its provisional ID and action. */
async function addTab(facet: string, title: string, options?: { parentTabId?: string; index?: number }) {
  let call = await hooks().callDoc(facet, "addTab", options ? [title, options] : [title]);
  if (call.error !== undefined) throw new Error(call.error);
  return { tabId: call.value as string, actionId: call.actionId!, action: call.action! };
}

describe("adding a Google Doc tab", () => {
  it("queues an empty tab that edits fill before it is added, and applies them in order", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Intro");
    docs.install();

    let added = await addTab("add-tab", "Notes");
    expect(added.tabId).toMatch(/^pending-tab-[0-9a-f-]{36}$/);
    expect(added.action).toMatchObject({
      title: "Add tab to Google Doc",
      description: "Add a new, empty tab at the top level, after the tabs already there.",
      fields: [{ label: "Title", kind: "inline", value: "Notes" }],
      actionKind: ADD_DOCUMENT_TAB,
      autoApprovable: true,
      implementsRevert: false,
    });
    expect(await hooks().listTabs("add-tab")).toEqual([
      { id: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { id: added.tabId, title: "Notes", index: 1, nestingLevel: 0 },
    ]);
    expect(await hooks().readContent("add-tab", added.tabId)).toBe("\n");
    let appendId = await hooks().submitAppend("add-tab", "Hello", added.tabId);
    // The approval names the tab by its title: its provisional ID names nothing the user can find.
    expect(await hooks().lastActionDescription)
      .toBe('Append content to the end of tab "Notes" (new tab).');
    expect(await hooks().readContent("add-tab", added.tabId)).toBe("Hello\n");
    // The document now has two tabs, so a tab must be named.
    await expect(Promise.resolve(hooks().readContent("add-tab")))
      .rejects.toThrow("tabId is required for documents with multiple tabs");
    expect(await hooks().applyAction("add-tab", appendId))
      .toMatch(`Approve earlier edit ${added.actionId}`);
    expect(docs.contentBatches).toBe(0);

    expect(await hooks().applyAction("add-tab", added.actionId)).toBeNull();
    let made = docs.tabs[1];
    expect(made).toMatchObject({ title: "Notes" });
    expect(docs.text(made.id)).toBe("");
    expect(docs.markerTabIds).toEqual([MAIN_TAB]);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("add-tab", appendId)).toBeNull();
    expect(docs.text(made.id)).toBe("Hello");
    expect(docs.markerTabIds).toEqual([MAIN_TAB, made.id]);

    expect((await hooks().listTabs("add-tab")).map(tab => tab.id)).toEqual([MAIN_TAB, made.id]);
    // The ID the agent was given keeps reaching the tab.
    expect(await hooks().readContent("add-tab", added.tabId)).toBe("Hello\n");
    let laterId = await hooks().submitAppend("add-tab", "More", added.tabId);
    expect(await hooks().applyAction("add-tab", laterId)).toBeNull();
    expect(docs.text(made.id)).toBe("Hello\nMore");
  });

  it("finds a new tab by the ID the simulation lists when its add applied after the replay", async () => {
    let docs = new DocsModel();
    docs.install();
    let added = await addTab("add-tab-alias-gap", "Notes");
    expect((await hooks().listTabs("add-tab-alias-gap")).map(tab => tab.id))
      .toEqual([MAIN_TAB, added.tabId]);
    // The state a handoff leaves between a replay and the read that uses it: Google's ID recorded
    // for the provisional one, while the replay still lists the tab under the provisional one.
    await hooks().applyStorage("add-tab-alias-gap", [
      { kind: "put", key: "docAddedTabs", value: { [added.tabId]: "t.google" } },
    ]);

    expect(await hooks().readContent("add-tab-alias-gap", added.tabId)).toBe("\n");
    let child = await addTab("add-tab-alias-gap", "Child", { parentTabId: added.tabId });
    expect(child.action.description).toBe(
      'Add a new, empty tab under tab "Notes" (new tab), after the tabs already there.');
  });

  it("reads a new tab's queued edits while the replay lists it beside the tab Google made", async () => {
    let docs = new DocsModel();
    docs.install();
    let added = await addTab("add-tab-alias-both", "Notes");
    await hooks().submitAppend("add-tab-alias-both", "Hello", added.tabId);
    // The add has landed, its reply not yet in: the replay lists Google's tab and the provisional
    // one carrying the queued edit. Then the handoff records Google's ID before the read looks.
    docs.addTab("t.google", "Notes", undefined as unknown as string);
    docs.externalEdit();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    expect((await hooks().listTabs("add-tab-alias-both")).map(tab => tab.id))
      .toEqual([MAIN_TAB, "t.google", added.tabId]);
    await hooks().applyStorage("add-tab-alias-both", [
      { kind: "put", key: "docAddedTabs", value: { [added.tabId]: "t.google" } },
    ]);

    expect(await hooks().readContent("add-tab-alias-both", added.tabId)).toBe("Hello\n");
  });

  it("places a tab at an index and nests one under a tab still waiting", async () => {
    let docs = new DocsModel();
    docs.addTab("tab-2", "Second", undefined as unknown as string);
    docs.install();

    let first = await addTab("add-tab-place", "First", { index: 0 });
    expect(first.action.description).toBe(
      "Add a new, empty tab at the top level, at position 1 of 3.");
    let child = await addTab("add-tab-place", "Child", { parentTabId: first.tabId });
    expect(child.action.description).toBe(
      'Add a new, empty tab under tab "First" (new tab), after the tabs already there.');
    expect(await hooks().listTabs("add-tab-place")).toEqual([
      { id: first.tabId, title: "First", index: 0, nestingLevel: 0 },
      { id: child.tabId, title: "Child", parentTabId: first.tabId, index: 0, nestingLevel: 1 },
      { id: MAIN_TAB, title: "Main", index: 1, nestingLevel: 0 },
      { id: "tab-2", title: "Second", index: 2, nestingLevel: 0 },
    ]);

    expect(await hooks().applyAction("add-tab-place", first.actionId)).toBeNull();
    expect(await hooks().applyAction("add-tab-place", child.actionId)).toBeNull();
    let [made, , , madeChild] = docs.tabs;
    expect(made).toMatchObject({ title: "First" });
    expect(madeChild).toMatchObject({ title: "Child", parentId: made.id });
    // The child's marker went in its parent, which by then existed.
    expect(docs.markerTabIds).toEqual([MAIN_TAB, made.id]);
    expect(await hooks().listTabs("add-tab-place")).toEqual([
      { id: made.id, title: "First", index: 0, nestingLevel: 0 },
      { id: madeChild.id, title: "Child", parentTabId: made.id, index: 0, nestingLevel: 1 },
      { id: MAIN_TAB, title: "Main", index: 1, nestingLevel: 0 },
      { id: "tab-2", title: "Second", index: 2, nestingLevel: 0 },
    ]);
  });

  it.each([
    ["an empty title", [""], "addTab: title must not be empty."],
    ["a title Google would cut", ["x".repeat(51)], "at most 50 characters"],
    ["an unknown parent", ["X", { parentTabId: "nope" }], 'no tab with ID "nope" exists'],
    ["an index past the last tab", ["X", { index: 2 }], "from 0 to 1, the number of tabs at the top level"],
  ] as const)("refuses %s before queuing anything", async (_case, args, message) => {
    let docs = new DocsModel();
    docs.install();

    let call = await hooks().callDoc("add-tab-refused", "addTab", [...args]);
    expect(call.error).toContain(message);
    expect(call.actionId).toBeUndefined();
  });

  it("drops the edits queued for a tab whose add is rejected", async () => {
    let docs = new DocsModel();
    docs.install();
    let added = await addTab("add-tab-reject", "Notes");
    let appendId = await hooks().submitAppend("add-tab-reject", "Hello", added.tabId);

    expect(await hooks().rejectAction("add-tab-reject", added.actionId)).toEqual({ restart: true });
    expect((await hooks().listTabs("add-tab-reject")).map(tab => tab.id)).toEqual([MAIN_TAB]);
    expect(await hooks().applyAction("add-tab-reject", appendId))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    expect(docs.tabs).toHaveLength(1);
    expect(docs.contentBatches).toBe(0);
  });

  /** A tab queued on `facet`, and three edits queued for it: a table, a row of it, a cell's text. */
  async function queueTableInNewTab(facet: string) {
    let added = await addTab(facet, "Notes");
    let table = await edit(facet, "insertTable",
      { rows: 2, columns: 2, cells: [["Task", "Owner"], ["Fix login", "Ana"]] }, added.tabId);
    expect(table.returned).toBe(0);
    let rows = await edit(
      facet, "insertTableRows", { table: 0, cells: [["Ship", "Ben"]] }, added.tabId);
    // Bold is read against a tab's named styles, which the tab still to be added has as a new
    // document's are.
    let cell = await edit(
      facet, "replaceText", "<p>Ana</p>", "<p><strong>Anna</strong></p>", added.tabId);
    let edits = [table.actionId, rows.actionId, cell.actionId];
    /** The tab each of the three stored records names. */
    let storedTabs = () => Promise.all(edits.map(async id => {
      let { kv } = await hooks().storedValue(facet, "doc", `pending:action:${id}`);
      return (JSON.parse(kv!) as { tabId?: string }).tabId;
    }));
    return { added, edits, storedTabs };
  }

  it("changes a table in a tab still waiting for its add, and reads the same once all of it applied", async () => {
    let docs = new DocsModel();
    docs.install();
    let facet = "add-tab-table";
    let { added, edits, storedTabs } = await queueTableInNewTab(facet);

    let pending = await hooks().readContent(facet, added.tabId);
    expect(pending).toContain(tableOf(
      [["Task", "Owner"], ["Fix login", "<strong>Anna</strong>"], ["Ship", "Ben"]]));
    expect(await storedTabs()).toEqual([added.tabId, added.tabId, added.tabId]);

    // The tab's edits wait for its add.
    expect(await hooks().applyAction(facet, edits[0]))
      .toBe(STANDALONE.outOfOrder(added.actionId, edits[0]));
    expect(docs.contentBatches).toBe(0);

    expect(await hooks().applyAction(facet, added.actionId)).toBeNull();
    // The handoff points the three at the tab Google made, and both IDs read it.
    let made = docs.tabs[1].id;
    expect(await storedTabs()).toEqual([made, made, made]);
    expect(await hooks().readContent(facet, added.tabId)).toBe(pending);
    expect(await hooks().readContent(facet, made)).toBe(pending);

    // An approval moves one edit from the queue into the document, and the read does not change.
    for (let id of edits) {
      expect(await hooks().applyAction(facet, id)).toBeNull();
      expect(await hooks().readContent(facet, made)).toBe(pending);
    }
    expect((await hooks().storedKeys(facet, "doc")).filter(key => key.startsWith("pending:action:")))
      .toEqual([]);
    expect(docTabToMarkdown(docs.bodyTab(made)).markdown).toBe(pending);
    expect(await hooks().readContent("add-tab-table-quiet", made)).toBe(pending);
  });

  it("drops the table changes queued for a tab whose add is rejected", async () => {
    let docs = new DocsModel();
    docs.install();
    let facet = "add-tab-table-reject";
    let { added, edits } = await queueTableInNewTab(facet);

    expect(await hooks().rejectAction(facet, added.actionId)).toEqual({ restart: true });
    expect((await hooks().listTabs(facet)).map(tab => tab.id)).toEqual([MAIN_TAB]);
    for (let id of edits) {
      expect(await hooks().applyAction(facet, id), `edit ${id}`)
        .toContain(`no tab with ID "${added.tabId}" exists`);
    }
    expect(docs.tabs).toHaveLength(1);
    expect(docs.contentBatches).toBe(0);
  });

  it("refuses an add whose reply was lost, leaving the tab it made in the document", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let added = await addTab("add-tab-lost", "Notes");
    let appendId = await hooks().submitAppend("add-tab-lost", "Hello", added.tabId);

    expect(await hooks().applyAction("add-tab-lost", added.actionId)).toMatch(/content response lost/);
    let made = docs.tabs[1];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    // Read meanwhile, the add still shows as pending, beside the tab Google made: only an approval
    // can tell its reply was lost, rather than still to come.
    expect((await hooks().listTabs("add-tab-lost")).map(tab => tab.id))
      .toEqual([MAIN_TAB, made.id, added.tabId]);
    expect(await hooks().readContent("add-tab-lost", added.tabId)).toBe("Hello\n");

    expect(await hooks().applyAction("add-tab-lost", added.actionId))
      .toContain('Google Docs added the tab "Notes", but its reply was lost');
    expect(await hooks().applyAction("add-tab-lost", appendId))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    expect(docs.tabs).toHaveLength(2);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text(made.id)).toBe("");
  });

  it("keeps an add, and the edits for its tab, that a read sees landing before its reply", async () => {
    let docs = new DocsModel();
    docs.install();
    let added = await addTab("add-tab-in-flight", "Notes");
    let appendId = await hooks().submitAppend("add-tab-in-flight", "Hello", added.tabId);

    let held = docs.hold("applied");
    let approval = Promise.resolve(hooks().applyAction("add-tab-in-flight", added.actionId));
    await held.reached;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    // The marker is in the document while the approval still awaits Google's reply.
    expect((await hooks().listTabs("add-tab-in-flight")).map(tab => tab.id))
      .toContain(added.tabId);
    held.release();

    expect(await approval).toBeNull();
    expect(await hooks().applyAction("add-tab-in-flight", appendId)).toBeNull();
    expect(docs.text(docs.tabs[1].id)).toBe("Hello");
  });

  it("refuses a lost add whose tab was replaced by a collaborator's with its title", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let added = await addTab("add-tab-replaced", "Notes");
    let appendId = await hooks().submitAppend("add-tab-replaced", "Hello", added.tabId);

    expect(await hooks().applyAction("add-tab-replaced", added.actionId))
      .toMatch(/content response lost/);
    // The marker stays in the first tab while the tab the add made is replaced.
    docs.removeTab(docs.tabs[1].id);
    docs.addTab("t.collaborator", "Notes", undefined as unknown as string, "Theirs");
    expect(docs.markers.size).toBe(1);

    expect(await hooks().applyAction("add-tab-replaced", added.actionId))
      .toContain("its reply was lost, and nothing else tells which tab it is");
    expect(await hooks().applyAction("add-tab-replaced", appendId))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    expect(docs.text("t.collaborator")).toBe("Theirs");
  });

  it("refuses to adopt a collaborator's tab bearing the title of one renamed since", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let added = await addTab("add-tab-renamed", "Notes");
    let appendId = await hooks().submitAppend("add-tab-renamed", "Hello", added.tabId);

    expect(await hooks().applyAction("add-tab-renamed", added.actionId))
      .toMatch(/content response lost/);
    docs.tabs[1].title = "Renamed";
    docs.touch();
    docs.addTab("t.collaborator", "Notes", undefined as unknown as string);
    docs.externalEdit();

    expect(await hooks().applyAction("add-tab-renamed", added.actionId))
      .toContain("its reply was lost, and nothing else tells which tab it is");
    expect(await hooks().applyAction("add-tab-renamed", appendId))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    expect(docs.text("t.collaborator")).toBe("");
  });

  it("refuses a lost add whose marker's tab was deleted, rather than guess or add another",
    async () => {
      let docs = new DocsModel();
      docs.addTab("tab-2", "Second", undefined as unknown as string);
      docs.ambiguousContentResponses = 1;
      docs.install();
      let added = await addTab("add-tab-host-gone", "Notes");
      let appendId = await hooks().submitAppend("add-tab-host-gone", "Hello", added.tabId);

      expect(await hooks().applyAction("add-tab-host-gone", added.actionId))
        .toMatch(/content response lost/);
      // The marker went in the first tab, which a collaborator now deletes.
      expect(docs.markerTabIds).toEqual([MAIN_TAB]);
      docs.removeTab(MAIN_TAB);

      expect(await hooks().applyAction("add-tab-host-gone", added.actionId))
        .toContain("no marker of it is left, and a tab has appeared in the document since");
      expect(docs.tabs.filter(tab => tab.title === "Notes")).toHaveLength(1);
      expect(docs.contentBatches).toBe(1);
      expect(await hooks().applyAction("add-tab-host-gone", appendId))
        .toContain(`no tab with ID "${added.tabId}" exists`);
      expect(docs.text(docs.tabs.find(tab => tab.title === "Notes")!.id)).toBe("");
    });

  it("refuses a lost add whose tab was moved under another parent, rather than add another",
    async () => {
      let docs = new DocsModel();
      docs.addTab("tab-2", "Second", undefined as unknown as string);
      docs.ambiguousContentResponses = 1;
      docs.install();
      let added = await addTab("add-tab-moved", "Notes");

      expect(await hooks().applyAction("add-tab-moved", added.actionId))
        .toMatch(/content response lost/);
      // A collaborator moves the new tab under "Second", then deletes the tab holding the marker.
      docs.tabs.find(tab => tab.title === "Notes")!.parentId = "tab-2";
      docs.touch();
      docs.removeTab(MAIN_TAB);

      expect(await hooks().applyAction("add-tab-moved", added.actionId))
        .toContain("no marker of it is left, and a tab has appeared in the document since");
      expect(docs.tabs.filter(tab => tab.title === "Notes")).toHaveLength(1);
      expect(docs.contentBatches).toBe(1);
    });

  it("refuses to adopt a collaborator's tab after a send that never reached Google", async () => {
    let docs = new DocsModel();
    docs.unsentContentRequests = 1;
    docs.setText(MAIN_TAB, "Intro");
    docs.install();
    let added = await addTab("add-tab-unsent", "Notes");
    let appendId = await hooks().submitAppend("add-tab-unsent", "Hello", added.tabId);

    expect(await hooks().applyAction("add-tab-unsent", added.actionId))
      .toMatch(/connection dropped/);
    expect(docs.tabs).toHaveLength(1);
    docs.addTab("t.collaborator", "Notes", undefined as unknown as string, "Theirs");
    docs.externalEdit();

    expect(await hooks().applyAction("add-tab-unsent", added.actionId))
      .toContain("whether it was added is unknown");
    expect(await hooks().applyAction("add-tab-unsent", appendId))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    expect(docs.text("t.collaborator")).toBe("Theirs");
    expect(docs.tabs).toHaveLength(2);
  });

  it("sends an add again after a send that never reached Google, when no tab appeared", async () => {
    let docs = new DocsModel();
    docs.unsentContentRequests = 1;
    docs.install();
    let added = await addTab("add-tab-resend", "Notes");

    expect(await hooks().applyAction("add-tab-resend", added.actionId))
      .toMatch(/connection dropped/);
    expect(await hooks().applyAction("add-tab-resend", added.actionId)).toBeNull();
    expect(docs.tabs.map(tab => tab.title)).toEqual(["Main", "Notes"]);
  });

  // Denying always withdraws (#857): no refusal on this path may leave an action that cannot be
  // denied, or hold back the edits queued behind it for other tabs.
  it.each([
    ["an ambiguous adoption", (docs: DocsModel): (() => void) | undefined => {
      docs.ambiguousContentResponses = 1;
      return () => docs.addTab("t.collaborator", "Notes", undefined as unknown as string);
    }],
    ["a send with no known outcome and no marker left", (docs: DocsModel): (() => void) | undefined => {
      docs.unsentContentRequests = 1;
      return () => docs.addTab("t.collaborator", "Notes", undefined as unknown as string);
    }],
    ["a lost reply that is denied instead of retried", (docs: DocsModel): (() => void) | undefined => {
      docs.ambiguousContentResponses = 1;
      return undefined;
    }],
  ] as const)("withdraws an add, and the edits for its tab, on deny after %s", async (_case, arrange) => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Intro");
    let interfere = arrange(docs);
    docs.install();
    let facet = `add-tab-deny-${_case.replace(/\W+/g, "-")}`;
    let added = await addTab(facet, "Notes");
    let appendToNew = await hooks().submitAppend(facet, "Hello", added.tabId);
    let appendToMain = await hooks().submitAppend(facet, "Still applies", MAIN_TAB);

    expect(await hooks().applyAction(facet, added.actionId)).not.toBeNull();
    if (interfere) {
      interfere();
      docs.externalEdit();
      expect(await hooks().applyAction(facet, added.actionId)).not.toBeNull();
    }

    await expect(Promise.resolve(hooks().rejectAction(facet, added.actionId))).resolves.not.toThrow();
    expect(await hooks().applyAction(facet, appendToNew))
      .toContain(`no tab with ID "${added.tabId}" exists`);
    await expect(Promise.resolve(hooks().rejectAction(facet, appendToNew))).resolves.not.toThrow();
    expect(await hooks().applyAction(facet, appendToMain)).toBeNull();
    expect(docs.text(MAIN_TAB)).toContain("Still applies");
    // Nothing is left pending to block a later approval.
    expect(await hooks().applyAction(facet, added.actionId)).toMatch(/Unknown pending/);
  });

  it("sends a refused add again rather than adopt a tab with its title", async () => {
    let docs = new DocsModel();
    docs.refusesEdits = true;
    docs.install();
    let added = await addTab("add-tab-refused-send", "Notes");

    expect(await hooks().applyAction("add-tab-refused-send", added.actionId)).not.toBeNull();
    docs.refusesEdits = false;
    docs.addTab("t.collaborator", "Notes", undefined as unknown as string);
    docs.externalEdit();

    expect(await hooks().applyAction("add-tab-refused-send", added.actionId)).toBeNull();
    expect(docs.tabs.map(tab => tab.title)).toEqual(["Main", "Notes", "Notes"]);
    expect((await hooks().listTabs("add-tab-refused-send")).map(tab => tab.id))
      .toEqual([MAIN_TAB, "t.collaborator", docs.tabs[2].id]);
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

  it("keeps a tab queued against the blank document, and the edits queued for it", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().createResource("create-doc-tab", DOC_PATTERN, "Plan");
    let added = await addTab("create-doc-tab", "Notes", { parentTabId: "t.0" });
    let appendId = await hooks().submitAppend("create-doc-tab", "Hello", added.tabId);
    expect((await hooks().listTabs("create-doc-tab")).map(tab => tab.id))
      .toEqual(["t.0", added.tabId]);

    expect(await hooks().applyCreation("create-doc-tab")).toEqual({ resourceUrl: CREATED_DOC_URL });
    await hooks().adoptCreated("create-doc-tab");

    // Nested under "t.0", the tab replays only if its parent was moved onto the created tab.
    expect(await hooks().listTabs("create-doc-tab")).toEqual([
      { id: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { id: added.tabId, title: "Notes", parentTabId: MAIN_TAB, index: 0, nestingLevel: 1 },
    ]);
    expect(await hooks().applyAction("create-doc-tab", added.actionId)).toBeNull();
    expect(await hooks().applyAction("create-doc-tab", appendId)).toBeNull();
    expect(docs.tabs[1]).toMatchObject({ title: "Notes", parentId: MAIN_TAB });
    expect(docs.text(docs.tabs[1].id)).toBe("Hello");
  });

  it("asks only for the tab IDs of the document it created", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().createResource("create-doc-tab-ids", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("create-doc-tab-ids"))
      .toEqual({ resourceUrl: CREATED_DOC_URL });

    let reads = vi.mocked(fetch).mock.calls
      .map(([input, init]) => (
        { url: new URL(input instanceof Request ? input.url : input.toString()), init }))
      .filter(({ url, init }) =>
        url.hostname === "docs.googleapis.com" && (init?.method ?? "GET") === "GET");
    expect(reads.map(({ url }) => `${url.pathname}${decodeURIComponent(url.search)}`)).toEqual([
      "/v1/documents/doc-1?includeTabsContent=true&prettyPrint=false" +
        "&fields=documentId,tabs(tabProperties(tabId))",
    ]);
    expect(new Headers(reads[0].init?.headers).has("X-Goog-FieldMask")).toBe(false);
    expect(docs.documentFetches).toBe(0);
    expect(docs.fetches).toBe(2);
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
      .toEqual({ error: "Google Docs get tab IDs failed [http=404]" });
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

    expect(await hooks().applyCreation("create-doc-approvers", "user-a"))
      .toEqual({ error: "Google Docs get tab IDs failed [http=404]" });
    expect(await hooks().applyCreation("create-doc-approvers", "user-b"))
      .toEqual({ resourceUrl: CREATED_DOC_URL });
    expect(docs.creates).toHaveLength(1);
    await hooks().adoptCreated("create-doc-approvers");
    await hooks().readContent("create-doc-approvers");

    expect(new Set(docs.authorizations)).toEqual(new Set([tokenOf("user-a")]));
  });

  it("applies a table queued against a document not created yet", async () => {
    // What a new document holds: one empty paragraph.
    let docs = docsWithBody(buildTab([para("")]).body);
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

  // A suggestion changes what the text reads as, so the copy read before it is not served after
  // it; a comment changes no text, and the copy is.
  it.each([["a suggestion", true], ["a comment", false]] as const)(
    "reads the document again after the connection posts %s only if it is a suggestion", async (_kind, again) => {
      let docs = model();
      let facet = `fresh-after-${again ? "suggestion" : "comment"}`;
      expect(await call(facet, "getContent")).toMatchObject({ value: expect.any(String) });
      let own = again
        ? await call(facet, "suggestEdit", "May", "June")
        : await call(facet, "comment", "Sure?", { quote: "May" });
      expect(await hooks().applyAction(facet, own.actionId!)).toBeNull();
      let before = docs.documentFetches;
      expect(await call(facet, "getContent")).toMatchObject({ value: expect.any(String) });
      expect(docs.documentFetches - before).toBe(again ? 1 : 0);
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

  // The quote of a comment or a suggestion is looked for in the binding's stored copy of the
  // Doc, a run at a time: a copy inside its TTL is read, and otherwise the Doc is fetched, with
  // no revision probe. The card's file name is Google's: the fetch's own, or one read of it.
  describe("the lookup of quoted text", () => {
    const START = Date.UTC(2026, 0, 1, 10);
    /** The two writes that quote the Doc, each queued by a fresh session of `facet`. */
    const QUOTING = [
      ["a comment", (facet: string) => call(facet, "comment", "Hm.", { quote: "May" })],
      ["a suggestion", (facet: string) => call(facet, "suggestEdit", "May", "June")],
    ] as const;
    /** The name the card of what `queued` queued shows for the Doc. */
    const fileName = (queued: Awaited<ReturnType<typeof call>>) => {
      let field = queued.action?.fields?.find(({ label }) => label === "File name");
      return field && "value" in field ? field.value : undefined;
    };

    it.each(QUOTING)("reads the stored copy for %s inside the copy's TTL: one read of the " +
        "title, and no documents.get", async (name, queue) => {
      let docs = model();
      let facet = `comment-lookup-fresh-${name.length}`;
      expect(await hooks().readContent(facet)).toBe(`${TEXT}\n`);
      let from = requestsMade();
      let queued = await queue(facet);
      expect(queued.error).toBeUndefined();
      expect(queued.reports).toEqual([
        { title: "Read Google Doc content", subresources: ["docs/document/doc-1"] },
      ]);
      expect(docsReadsSince(from)).toEqual(["title"]);
      expect(docs.documentFetches).toBe(1);
    });

    it.each(QUOTING)("fetches the Doc once for %s where no copy is fresh, and asks nothing " +
        "else", async (name, queue) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      let docs = model();
      let facet = `comment-lookup-fetch-${name.length}`;
      // No copy is stored.
      let from = requestsMade();
      expect((await queue(facet)).error).toBeUndefined();
      expect(docsReadsSince(from)).toEqual(["read"]);
      // The copy that lookup kept serves a read inside its TTL.
      expect(await hooks().readContent(facet)).toBe(`${TEXT}\n`);
      expect(docs.documentFetches).toBe(1);
      // Past its TTL the Doc is fetched again, and never confirmed with a revision probe.
      vi.setSystemTime(START + DOC_SNAPSHOT_TTL_MS);
      from = requestsMade();
      expect((await queue(facet)).error).toBeUndefined();
      expect(docsReadsSince(from)).toEqual(["read"]);
      expect(docs.revisionProbes).toBe(0);
    });

    it("fetches the Doc for a quote once a write of the binding has landed", async () => {
      let docs = model();
      let facet = "comment-lookup-written";
      let replaced = await hooks().submitReplace(facet, "May", "June");
      expect(await hooks().applyAction(facet, replaced)).toBeNull();
      let from = requestsMade();
      let queued = await call(facet, "comment", "Sure?", { quote: "June" });
      expect(queued.error).toBeUndefined();
      expect(docsReadsSince(from)).toEqual(["read"]);
      expect(docs.text()).toContain("June");
    });

    it("names the Doc on the card by the title Google has", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      let docs = model();
      let facet = "comment-lookup-title";
      expect(await hooks().readContent(facet)).toBe(`${TEXT}\n`);
      // Inside the TTL the copy answers the quote, and Google is asked for the title.
      docs.title = "Renamed once";
      expect(fileName(await QUOTING[0][1](facet))).toBe("Renamed once");
      expect(fileName(await QUOTING[1][1](facet))).toBe("Renamed once");
      // Past it the title is the fetch's own.
      docs.title = "Renamed twice";
      vi.setSystemTime(START + DOC_SNAPSHOT_TTL_MS);
      expect(fileName(await QUOTING[0][1](facet))).toBe("Renamed twice");
      expect(docs.documentFetches).toBe(2);
    });

    it("stores the Doc's title nowhere but in the records of the writes queued", async () => {
      let docs = model();
      docs.title = "Titled nowhere else";
      let facet = "comment-lookup-untitled";
      // The first lookup fetches, and the title is its answer's; the second asks for it.
      let queued = [await QUOTING[0][1](facet), await QUOTING[1][1](facet)];
      expect(queued.map(fileName)).toEqual([docs.title, docs.title]);
      let tables = (await hooks().docStoreExec(
        facet, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc\\_%' ESCAPE '\\'",
      )).map(({ name }) => String(name));
      let rows = JSON.stringify(await Promise.all(tables.map(table =>
        hooks().docStoreExec(facet, `SELECT * FROM ${table}`))));
      // The search reads the rows' text: the Doc's own is found in it.
      expect(rows).toContain("The launch is in May.");
      expect(rows).not.toContain(docs.title);
      let titled: string[] = [];
      for (let key of await hooks().storedKeys(facet, "doc")) {
        let { kv = "" } = await hooks().storedValue(facet, "doc", key);
        if (kv.includes(docs.title)) titled.push(key);
      }
      expect(titled).toEqual(queued.map(({ actionId }) => `docComments:action:${actionId}`));
    });

    // A paragraph past a stored row: no read of the binding answers such a Doc, and the lookup
    // is a read.
    describe("in a Doc the binding cannot keep a copy of", () => {
      const pastRow = () =>
        buildTab([para("The launch is in May."), para("a".repeat(DOC_ROW_BYTES + 1))]).body;
      const TOO_LARGE = "of this Google Doc is too large to keep a copy of: ";
      /** The keys of the edits and of the comment writes `facet` holds queued. */
      const queuedKeys = async (facet: string) =>
        (await hooks().storedKeys(facet, "doc")).filter(key => /:action:\d+$/.test(key));

      it("refuses a comment's quote and a suggestion with the read's own error, once the " +
          "read is authorized, and queues nothing", async () => {
        let docs = model();
        docs.setBody(MAIN_TAB, pastRow());
        let facet = "comment-past-row";
        let read = await call(facet, "getContent");
        expect(read.error).toContain(`A paragraph of tab "${MAIN_TAB}" ${TOO_LARGE}`);
        let rows = await hooks().docStoreRows(facet);
        for (let [, queue] of QUOTING) {
          let from = requestsMade();
          let refused = await queue(facet);
          expect(refused.error).toBe(read.error);
          expect(refused.actionId).toBeUndefined();
          expect(refused.reports).toEqual([
            { title: "Read Google Doc content", subresources: ["docs/document/doc-1"] },
          ]);
          // The one fetch, and no read of the title after it.
          expect(docsReadsSince(from)).toEqual(["read"]);
        }
        expect(docs.documentFetches).toBe(3);
        expect(await hooks().docStoreRows(facet)).toEqual(rows);
        expect(await queuedKeys(facet)).toEqual([]);
      });

      it("refuses a quote in another tab than the one that holds the paragraph, and queues " +
          "a reply and a resolve, which read no document", async () => {
        let docs = model();
        docs.addTab("tab-2", "Notes", MAIN_TAB);
        docs.setBody("tab-2", pastRow());
        let theirs = docs.addThread("Is this date right?", { quote: "May" });
        let facet = "comment-past-row-elsewhere";
        // The copy is of the document: a tab that reads is not kept without the one that does not.
        let refused = await call(facet, "comment", "Hm.", { quote: "May", tabId: MAIN_TAB });
        expect(refused.error).toContain(`A paragraph of tab "tab-2" ${TOO_LARGE}`);
        expect(refused.actionId).toBeUndefined();
        expect(docs.documentFetches).toBe(1);

        let reply = await call(facet, "reply", theirs.commentId, "Yes, it is.");
        expect(reply.error).toBeUndefined();
        let resolve = await call(facet, "resolve", theirs.commentId);
        expect(resolve.error).toBeUndefined();
        expect(await queuedKeys(facet)).toEqual(
          [reply, resolve].map(({ actionId }) => `docComments:action:${actionId}`));
        expect(docs.documentFetches).toBe(1);
      });
    });
  });
});

// What a bound Doc stores, by its literal keys, so that moving its code cannot move its storage.
describe("Google Doc stored layout", () => {
  /** The value under `key`, as the synchronous KV and the asynchronous API each read it. */
  const stored = async (facet: string, key: string): Promise<{ kv?: unknown; async?: unknown }> => {
    let { kv, async } = await hooks().storedValue(facet, "doc", key);
    return {
      ...kv === undefined ? {} : { kv: JSON.parse(kv) },
      ...async === undefined ? {} : { async: JSON.parse(async) },
    };
  };

  it("keeps its edits, counter, receipt and revision under the keys it has always used, and the copy of the document in the store's tables", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.cleanupFailures = 1;
    docs.install();
    let facet = "stored-layout-doc";
    let storedKeys = () => hooks().storedKeys(facet, "doc");
    // The copy: one record, and its one tab as a version, a run list, two runs (its body, and its
    // lists and styles) and a rendering.
    let copyRows = { doc_copy: 1, doc_md: 1, doc_result: 0, doc_run: 2, doc_seq: 1, doc_version: 1 };
    // With what the edit prepared made: its result, and its version's run list, body and rendering.
    let editRows = { doc_copy: 1, doc_md: 2, doc_result: 1, doc_run: 3, doc_seq: 2, doc_version: 2 };

    let first = await hooks().submitAppend(facet, "first");
    await hooks().readMetadata(facet);
    // The read that prepared the edit stored the copy of the document and what the edit made
    // of it, in rows and in no key.
    expect(await hooks().docStoreRows(facet)).toEqual(editRows);
    expect(await storedKeys()).toEqual([
      "docMetadataRevision", "pending:action:1", "pending:nextActionId",
    ]);
    expect((await stored(facet, "pending:nextActionId")).kv).toBe(2);
    expect((await stored(facet, "pending:action:1")).kv).toEqual({
      type: "appendText", tabId: MAIN_TAB, submittedAt: expect.any(Number),
      markdownVersion: MARKDOWN_RENDERING_VERSION, baseRevisionId: expect.any(String),
      writeId: expect.any(String), markdown: "first",
      // Display only: what the card names the tab by, as the card is built from the record.
      display: { tab: `"Main" (${MAIN_TAB})` },
    });
    expect((await stored(facet, "docMetadataRevision")).kv)
      .toEqual({ revisionId: expect.any(String), observedAt: expect.any(Number) });

    // The marker's cleanup fails, so the write's receipt stays for the next write to settle.
    expect(await hooks().applyAction(facet, first)).toBeNull();
    // The copy lacked the write, so it was retired with the write's record: its rows stay for
    // the next fetch to be compared with, marked as a copy no read and no rejection is given.
    // What the edit made went with its record.
    expect(await storedKeys())
      .toEqual(["docMetadataRevision", "docWriteReceipt", "pending:nextActionId"]);
    expect(await hooks().docCopyHead(facet)).toMatchObject({ stale: true });
    expect(await hooks().docStoreRows(facet)).toEqual(copyRows);
    expect((await stored(facet, "docWriteReceipt")).kv)
      .toEqual({ actionId: first, markerId: expect.any(String) });

    // A rejection keeps the copy, for the next read to use once it has checked its revision.
    let second = await hooks().submitAppend(facet, "second");
    let third = await hooks().submitAppend(facet, "third");
    let fetches = docs.documentFetches;
    expect(await hooks().rejectAction(facet, third)).toBeUndefined();
    expect(await hooks().docCopyHead(facet)).toMatchObject({ stale: false });
    expect(await hooks().docCopyHead(facet)).not.toHaveProperty("checkedAt");
    expect(await storedKeys()).toEqual([
      "docMetadataRevision", "docWriteReceipt", `pending:action:${second}`, "pending:nextActionId",
    ]);
    let probes = docs.revisionProbes;
    expect(await hooks().readContent(facet)).toBe("base\n\nfirst\n\nsecond\n");
    expect([docs.documentFetches, docs.revisionProbes]).toEqual([fetches, probes + 1]);
    expect(await hooks().docCopyHead(facet)).toMatchObject({ checkedAt: expect.any(Number) });

    // The record is what a read goes by: one whose age a test takes away is checked again.
    await hooks().touchDocCopy(facet, { checkedAt: null });
    expect(await hooks().readContent(facet)).toBe("base\n\nfirst\n\nsecond\n");
    expect([docs.documentFetches, docs.revisionProbes]).toEqual([fetches, probes + 2]);
    // No key of the object holds any of the document.
    expect((await storedKeys()).filter(key => key.startsWith("docCopy:"))).toEqual([]);

    // A comment write is numbered by the edits' counter, under a prefix of its own.
    let comment = await hooks().callDoc(facet, "comment", ["Why?", { quote: "base" }]);
    expect(comment.actionId).toBe(4);
    expect((await stored(facet, "pending:nextActionId")).kv).toBe(5);
    expect((await stored(facet, "docComments:action:4")).kv).toMatchObject({
      v: 2, state: "pending", action: { kind: "createComment" },
    });
  });

  it("reads a copy stored under another format as absent, and approves over the document fetched in its place", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "stored-layout-no-markers";
    expect(await hooks().readContent(facet)).toBe("base\n");
    let actionId = await hooks().submitAppend(facet, "first");
    expect(await hooks().docCopyHead(facet)).toMatchObject({ stale: false });

    // Rows another format's code left, which hold no write markers this code reads: never read.
    await hooks().docStoreExec(facet, "UPDATE doc_format SET format = 'another'");
    await hooks().restartDoc(facet);

    let from = requestsMade();
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    // No copy could build the write, so the document was fetched before it.
    expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
    expect(docs.text()).toBe("base\nfirst");

    expect(await hooks().readContent(facet)).toBe("base\n\nfirst\n");
    expect(await hooks().docCopyHead(facet)).toMatchObject({ stale: false });
  });

  it("fetches the document again over a stored record whose outline does not list its tabs", async () => {
    let docs = nestedDocs();
    let facet = "stored-layout-outline-mismatch";
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("shared\n");
    let listed = (await hooks().docCopyHead(facet))!.outline.length;
    // The outline as the record holds it, one tab short of the versions listed beside it.
    await hooks().docStoreExec(facet, "UPDATE doc_copy SET outline = ? WHERE doc = 'doc'", JSON.stringify([
      { tabId: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { tabId: "details", title: "Details", parentTabId: MAIN_TAB, index: 0, nestingLevel: 1 },
    ]));
    expect(listed).toBeGreaterThan(2);
    await hooks().restartDoc(facet);
    let fetches = docs.documentFetches;

    // Such a record names no copy, so the read fetches the document and keeps it over the record.
    expect(await hooks().docCopyHead(facet)).toBeNull();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("shared\n");
    expect(docs.documentFetches).toBe(fetches + 1);
    expect(await hooks().readContent(facet, "metrics")).toBe("shared\n");
    expect((await hooks().docCopyHead(facet))!.outline).toHaveLength(listed);
  });

  it("reads and applies every stored edit shape, seeded before the Doc first starts", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "stored-layout-legacy";
    let row = (id: number, value: Record<string, unknown>) =>
      ({ kind: "put" as const, key: `pending:action:${id}`, value });
    await hooks().writeStored(facet, "doc", [
      // Stored before tabs and Markdown versions: neither its tab nor its rendering is known.
      row(1, { type: "appendText", submittedAt: 0, baseRevisionId: "revision-1", markdown: "one" }),
      row(2, {
        type: "appendText", tabId: MAIN_TAB, submittedAt: 0,
        markdownVersion: MARKDOWN_RENDERING_VERSION, markdown: "two",
        invalidatedReason: "Dropped earlier.",
      }),
      // Stored before write IDs: apply gives it one before it writes.
      row(3, {
        type: "appendText", tabId: MAIN_TAB, submittedAt: 0,
        markdownVersion: MARKDOWN_RENDERING_VERSION, markdown: "three",
      }),
      row(4, {
        type: "appendText", documentId: "doc-1", tabId: MAIN_TAB, submittedAt: 0,
        markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "write-4", markdown: "four",
      }),
      // A field this code does not know is carried and ignored.
      row(5, {
        type: "replaceText", tabId: MAIN_TAB, submittedAt: 0,
        markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "write-5",
        oldMarkdown: "base", newMarkdown: "BASE", displayTab: "Main",
      }),
      { kind: "put", key: "pending:nextActionId", value: 6 },
    ], "kv");
    await hooks().restartFacet(facet);

    expect(await hooks().readContent(facet)).toBe("BASE\n\nthree\n\nfour\n");
    // The read records why the first can no longer be replayed, in its own record.
    let first = (await stored(facet, "pending:action:1")).kv as Record<string, unknown>;
    expect(first.invalidatedReason).toContain("queued under an earlier Markdown format");
    expect(first).toMatchObject({ type: "appendText", markdown: "one" });

    expect(await hooks().applyAction(facet, 1)).toContain("queued under an earlier Markdown format");
    expect(await hooks().applyAction(facet, 2)).toBe("Dropped earlier.");
    for (let id of [3, 4, 5]) expect(await hooks().applyAction(facet, id)).toBeNull();
    expect(docs.text()).toBe("BASE\nthree\nfour");
    expect(docs.contentBatches).toBe(3);
    expect(await hooks().rejectAction(facet, 1)).toBeUndefined();
    expect(await hooks().rejectAction(facet, 2)).toBeUndefined();

    expect(await hooks().submitAppend(facet, "six")).toBe(6);
  });

  it("keeps a created document's first tab until the real class takes over", async () => {
    new DocsModel().install();
    let facet = "stored-layout-created";
    await hooks().createResource(facet, DOC_PATTERN, "Plan");
    expect(await hooks().applyCreation(facet)).toEqual({ resourceUrl: CREATED_DOC_URL });
    expect((await stored(facet, "createdDocTab")).kv).toBe(MAIN_TAB);

    await hooks().adoptCreated(facet);
    expect(await hooks().readContent(facet)).toBe("\n");
    expect(await hooks().storedKeys(facet, "doc")).not.toContain("createdDocTab");
  });

  it("reads through the synchronous KV what the asynchronous API wrote, and the reverse", async () => {
    new DocsModel().install();
    let facet = "stored-layout-apis";
    let value = { formatVersion: 1, fetchedAt: 7 };
    await hooks().writeStored(facet, "doc", [{ kind: "put", key: "docSnapshot", value }], "async");
    expect(await stored(facet, "docSnapshot")).toEqual({ kv: value, async: value });
    await hooks().writeStored(
      facet, "doc", [{ kind: "put", key: "docSnapshotCheck", value: { fetchedAt: 7, checkedAt: 0 } }],
      "kv");
    expect((await stored(facet, "docSnapshotCheck")).async).toEqual({ fetchedAt: 7, checkedAt: 0 });
  });
});

/** A Docs API serving `models`, each answering for its own document, for a fake beside Drive's. */
function docsProvider(...models: DocsModel[]): ProviderFake {
  return {
    async handle(request) {
      let url = new URL(request.url);
      if (url.hostname !== "docs.googleapis.com") return undefined;
      let id = /^\/v1\/documents\/([^/:]+)/.exec(url.pathname)?.[1];
      let model = models.find(candidate => candidate.documentId === id) ?? models[0];
      let body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      return model.fetch(request.url, { method: request.method, body, headers: request.headers });
    },
  };
}

/** How many times `text` occurs in `content`. */
function occurrences(content: string, text: string): number {
  return content.split(text).length - 1;
}

// What a queue of edits to two large documents spends, phase by phase, in both hosts: counts under
// a frozen clock, never times. The table of every phase is printed once the block has run.
describe("Google Doc replay cost", () => {
  /** The edits queued for the large tab, each followed by a read of it. */
  const N = 4;
  const TABLES = 10;
  /** The Drive binding the hooks open the document through in the run through Drive. */
  const DRIVE_DOC = { scope: { kind: "file", fileId: "doc-1" }, access: "write" } as const;

  /** What a phase is measured in, in the order the table prints them. */
  const MEASURES = [
    "renders", "tabClones", "fullReindexes", "folds", "queueReads", "fingerprints",
    "lookupSteps", "documentFetches", "revisionProbes", "fetches", "requestBytes",
    "responseBytes", "rowsWritten", "runsDecoded", "runsRendered", "runsKeyed", "resultsStored",
    "resultsFound",
  ] as const;
  type Measure = typeof MEASURES[number];
  type Row = { phase: string; pending: number } & Record<Measure, number>;

  const padded = (number: number, width: number) => String(number).padStart(width, "0");

  /**
   * The two documents, each with a second tab of 20 short paragraphs. `body` is the large tab.
   * `texts(i)` is what edit `i` of the large tab replaces and with what, `dropped` the text of
   * edit 2 and what a collaborator makes of it, and `last` queues edit `N`.
   */
  const DOCUMENTS = {
    // 20,000 paragraphs, each a line of its own. Edit `i` replaces line `i * 100`.
    paragraphs: {
      body: () => buildTab(Array.from(
        { length: 20_000 }, (_, line) => para(`line ${padded(line, 5)} alpha`))).body,
      texts: (i: number) =>
        [`line ${padded(i * 100, 5)} alpha`, `line ${padded(i * 100, 5)} edited`] as const,
      dropped: ["line 00200 alpha", "line 00200 omega"],
      last: (facet: string) =>
        edit(facet, "replaceText", ...DOCUMENTS.paragraphs.texts(N), MAIN_TAB),
    },
    // Ten tables that hold the most cells a tab's tables may, one word to a cell, and a paragraph
    // between each two. Edit 1 replaces a cell of the first table, edit 2 the paragraph after the
    // fifth, edit 3 a cell of the second, and each edit after it a cell of the next table.
    cells: {
      body: () => buildTab(Array.from({ length: TABLES }, (_, table) => [
        ...table === 0 ? [] : [para(`between ${padded(table - 1, 2)} gamma`)],
        sized(MAX_TAB_TABLE_CELLS / TABLES / 20, 20, `t${table}r`),
      ]).flat()).body,
      texts: (i: number) => {
        if (i === 2) return ["between 04 gamma", "between 04 edited"] as const;
        let word = `t${i === 1 ? 0 : i - 2}r1c1`;
        return [`<td><p>${word}</p></td>`, `<td><p>${word}x</p></td>`] as const;
      },
      dropped: ["between 04 gamma", "between 04 omega"],
      // Names the last table, which no queued replacement touches, and adds no cell.
      last: (facet: string) =>
        edit(facet, "setTableColumnWidths", { table: TABLES - 1, width: 100 }, MAIN_TAB),
    },
  };
  type Shape = keyof typeof DOCUMENTS;

  /** The fake Google holding the document `shape` names. */
  function documentOf(shape: Shape): DocsModel {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, DOCUMENTS[shape].body());
    docs.addTab(SECOND_TAB, "Notes", MAIN_TAB,
      Array.from({ length: 20 }, (_, line) => `note ${padded(line, 2)} beta`).join("\n"));
    docs.install();
    return docs;
  }

  /** A collaborator rewrites the paragraph reading `from` to a text as long, so no index moves. */
  function rewrite(docs: DocsModel, [from, to]: string[]): void {
    let { body } = docs.bodyTab(MAIN_TAB);
    let text = body.content.flatMap(element => element.paragraph?.elements ?? [])
      .find(part => part.textRun?.content === `${from}\n`)?.textRun;
    if (!text || from.length !== to.length) throw new Error(`No paragraph to rewrite: ${from}`);
    text.content = `${to}\n`;
    docs.externalBody(MAIN_TAB, body);
  }

  /** The edits `facet` holds for approval, oldest first, a dropped one with its reason. */
  async function queued(facet: string): Promise<{ id: number; reason?: string }[]> {
    if (run.drive) {
      let ids = await rawHooks().driveQueued(`drive:${facet}`, DRIVE_DOC);
      return ids.map(id => ({ id }));
    }
    let keys = (await hooks().storedKeys(facet, "doc"))
      .filter(key => key.startsWith("pending:action:"));
    let records = await Promise.all(keys.map(async key => {
      let { kv = "{}" } = await hooks().storedValue(facet, "doc", key);
      let { invalidatedReason: reason } = JSON.parse(kv) as { invalidatedReason?: string };
      return { id: Number(key.slice("pending:action:".length)), ...reason ? { reason } : {} };
    }));
    return records.toSorted((a, b) => a.id - b.id);
  }

  const measured: { name: string; rows: Row[] }[] = [];

  afterAll(() => {
    if (measured.length === 0) return;
    let header = ["document, host", "phase", ...MEASURES, "pending"];
    let lines = measured.flatMap(({ name, rows }) => rows.map(row =>
      [name, row.phase, ...MEASURES.map(column => String(row[column])), String(row.pending)]));
    let widths = header.map((title, column) =>
      Math.max(title.length, ...lines.map(line => line[column].length)));
    let print = (line: string[]) =>
      line.map((cell, column) => column < 2 ? cell.padEnd(widths[column])
        : cell.padStart(widths[column])).join("  ");
    console.log([
      "Google Doc replay cost",
      `${N} edits of the large tab queued behind one of the other tab. rowsWritten is the rows ` +
      "the Doc store wrote, as storage bills them, without the pending records' own writes; " +
      "runsDecoded and runsRendered are the runs it parsed from their rows and rendered, " +
      "runsKeyed the runs whose rendering's key it worked out from a stored summary, " +
      "resultsStored and resultsFound the edits' results it stored and found stored; pending " +
      "is the edits queued that no replay has dropped. The fake Google applies an approved batch with the same model, " +
      "so the approval rows hold its clone and re-indexes, and it answers each read with the " +
      "fields asked of it, which responseBytes counts.",
      print(header), ...lines.map(print),
    ].join("\n"));
  });

  /** Runs the queue over `shape`'s document in the current run's host: the row of each phase. */
  async function measure(shape: Shape): Promise<Row[]> {
    // Frozen, so that no count depends on how long the machine took: the copy's time to live
    // passes only where a phase moves the clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    let docs = documentOf(shape);
    let facet = `replay-cost-${shape}`;
    let { texts, dropped, last } = DOCUMENTS[shape];
    let totals = (): Record<Measure, number> => ({
      ...replayCost,
      documentFetches: docs.documentFetches, revisionProbes: docs.revisionProbes,
      fetches: docs.fetches, requestBytes: docs.requestBytes, responseBytes: docs.responseBytes,
      rowsWritten: docStoreCost.rowsWritten, runsDecoded: docStoreCost.runsDecoded,
      runsRendered: docStoreCost.runsRendered, runsKeyed: docStoreCost.runsKeyed,
      resultsStored: docStoreCost.resultsStored, resultsFound: docStoreCost.resultsFound,
    });
    /** The edits queued that no replay has dropped, oldest first. */
    let active = async () =>
      (await queued(facet)).filter(({ reason }) => !reason).map(({ id }) => id);
    let rows: Row[] = [];
    /** Runs one phase and records what it added to each measure. */
    let phase = async (name: string, body: () => Promise<unknown>) => {
      let before = totals();
      await body();
      let after = totals();
      let spent = Object.fromEntries(MEASURES.map(column =>
        [column, after[column] - before[column]])) as Record<Measure, number>;
      rows.push({ phase: name, ...spent, pending: (await active()).length });
    };
    let read = () => hooks().readContent(facet, MAIN_TAB);
    let ids: number[] = [];
    let queue = async (submitted: Promise<{ actionId: number }>) => {
      ids.push((await submitted).actionId);
    };

    await phase("cold read", read);
    await phase("queue", async () => {
      await queue(edit(facet, "replaceText", "note 07 beta", "note 07 edited", SECOND_TAB));
      await hooks().readContent(facet, SECOND_TAB);
      // As an agent reads after each edit.
      for (let i = 1; i <= N; i++) {
        await queue(i === N ? last(facet) : edit(facet, "replaceText", ...texts(i), MAIN_TAB));
        await read();
      }
    });
    expect(await queued(facet)).toEqual(ids.map(id => ({ id })));
    let [other, first, stale, rejected] = ids;

    await phase("reads", async () => {
      for (let i = 0; i < 3; i++) await read();
    });

    await phase("dropped edit", async () => {
      rewrite(docs, dropped);
      passSnapshotTtl();
      await read();
    });
    // A bound Doc keeps the dropped edit with its reason, and a Drive binding fails it.
    expect(await queued(facet)).toEqual(ids.flatMap(id => id !== stale ? [{ id }]
      : run.drive ? [] : [{ id, reason: expect.stringContaining("oldMarkdown was not found") }]));

    await phase("rejection", () => Promise.resolve(hooks().rejectAction(facet, rejected)));
    // A Drive binding fails the change that names a table with the cell replacement before it.
    let failed = run.drive && shape === "cells" ? [ids[N]] : [];
    expect(await active())
      .toEqual(ids.filter(id => ![stale, rejected, ...failed].includes(id)));

    await phase("read after rejection", read);
    await phase("approval (other tab)", async () =>
      expect(await hooks().applyAction(facet, other)).toBeNull());
    await phase("approval", async () =>
      expect(await hooks().applyAction(facet, first)).toBeNull());
    await phase("read after approval", read);

    measured.push({ name: `${shape}, ${run.name}`, rows });
    return rows;
  }

  /**
   * What each phase spends, in the order of `MEASURES` and then `pending`: counts a change must not
   * raise without saying so. The edit a collaborator's change drops is a replacement outside
   * tables, so it is the only edit its replay drops. The rejected edit of the tables document has a
   * change that names a table queued behind it, so a bound Doc's rejection replays the queue there
   * and not in the paragraphs document, while a Drive binding fails that change instead.
   *
   * A read folds the queue of the tab it reads over that tab's stored version, a step per edit:
   * `reads`, three reads of the large tab's four edits, holds twelve. An edit's check folds the
   * edits before it in its tab, and the read after it those and the edit: `queue` holds one step
   * for the other tab's edit and 1, 3, 5 and 7 for the large tab's. A step looks up its edit's
   * result in the version before it (`resultsFound`) and makes the edit only where none is stored
   * (`resultsStored`): `queue` stores five and finds seventeen, `reads` finds twelve and stores
   * none. `dropped edit` folds the large tab's four edits once, over one read of the queue, and
   * none of the other tab's: the tab came back changed, so each is made again. The bound
   * `rejection` of the tables document reads the queue twice, once a replay, and each replay folds
   * every tab with an edit queued: the other tab's edit and the large tab's three with the rejected
   * edit, then the other tab's and the large tab's two without it, of which the one behind the
   * rejected edit is made again; the read after it finds those two. The bound `approval (other
   * tab)` folds the large tab's two queued edits after its fetch, which brought the large tab as
   * stored: the tab is not stored again, and both results are found. `read after approval` folds
   * the one edit left.
   *
   * `rowsWritten` counts rows as storage bills them. A tab is stored as runs cut by its content:
   * the paragraphs document's large tab is 125 runs, the tables document's 20 (each table alone,
   * and each stretch between two), the other tab one. The cold read keeps the two tabs (each run
   * with its rendering and its row in the run list), the two versions, their shared context and
   * the copy's record. A queued edit stores its result and its version: the runs it changed with
   * their renderings, and a run list, a row a run. A read of a state read before writes nothing
   * (`reads`). A fetch that brought one tab changed writes that tab's rows and the record, and
   * removes the version it replaces with what the edits made in it, which the replay stores again
   * (`dropped edit`, and each approval after the row that retires the copy its write outdated). A
   * rejection writes the record and removes what the rejected edit alone reached, the run lists of
   * the versions made from it included; a revision check writes the record alone.
   *
   * `runsDecoded`: a tab's runs are decoded only where an edit is made in it, and of a text edit
   * only the runs that hold the closure of its own elements, which the model takes as decoded; a
   * chain of edits made again decodes as much at each step. `queue` decodes one run for each of the
   * paragraphs document's five edits. A table change or a cell replacement decodes the piece around
   * its table: the tables document's `queue` decodes 37 runs, its last edit (a table change) the
   * nine of its piece where the tab is twenty-one. A bound Doc's cold read, `reads`, an approval
   * that sends a stored result and a rejection with no table change behind it decode nothing, and
   * nothing decoded outlives the request. A read through Drive that fetched decodes the document's
   * runs twice, its trial and its keep each reading back the bytes it fetched: `cold read` (the two
   * tabs' runs, twice), and `queue` five times over, once a fetch. A document stored as it is read,
   * as an approval's fetch after its write is, is decoded by nothing. An approval that builds its
   * write from a document it fetched makes the edit in the copy stored of it, and finds the
   * replay's result where the edit's tab came back as it was: through Drive, `approval`.
   *
   * `runsRendered`: a tab stored beside no earlier version of it has each run rendered alone: the
   * cold read renders the two tabs' 126 runs, and no read after it renders any. A made edit renders
   * its piece for the builders and, to be stored, the runs it changed: `queue` renders 5 and 5.
   * `dropped edit` renders the one run the fetch changed, the piece of each of the three edits that
   * still apply and the one run each changed; the fourth is refused by the scan of the tab's stored
   * Markdown, which finds its text gone and decodes nothing.
   *
   * `runsKeyed`: the runs after those an edit or a fetch changed whose rendering's key was worked
   * out from a stored summary, up to where the carry is the stored version's again (asked before a
   * later run is read). `queue` keys none: each of its edits leaves the carry as it was.
   *
   * `documentFetches`: where an approved write was built. A bound Doc's two approvals read the
   * document once each, after the write, for the edits queued behind it: the write is the edit's
   * stored result, pinned to the copy's revision, so nothing is read or decoded before it. Through
   * Drive `approval (other tab)` builds from the snapshot the read before it left, and reads once,
   * after the write. Its `approval` follows a write that landed, so no snapshot may build it: the
   * document is read before the write and stored as read, in a trial that keeps nothing, where the
   * edit's result is found; the stored copy lacks the other tab as the approval before left it, so
   * the trial writes that tab's rows, renders its one run and removes them: ten rows. The
   * paragraphs document is read after the write too, one edit being still queued. A revision probe
   * answers the revision alone, so `responseBytes` holds whole documents only where
   * `documentFetches` counts one.
   *
   * Through Drive the sessions share the document's source, stored once the read that fetched it
   * is authorized; until then the read replays over it in a trial that writes the tabs' rows and
   * removes them, so `cold read` writes them twice and renders each run twice. `reads` fetches no
   * document (its requests are each read's scope check) and finds the large tab's four results at
   * each read. `queue` fetches once an edit, at the read after it, which finds an edit queued since
   * the snapshot and folds the tab's queue over the fetch in a trial: the document came back
   * unchanged, so the trial finds every result and the read keeps the snapshot, on which the next
   * edit is prepared, so each edit is made once. (An edit queued straight after another, with no
   * read between, is made twice; the Drive tests hold that.) `dropped edit` probes the revision
   * before it fetches, and makes the large tab's edits in a trial that leaves no row of them: the
   * paragraphs document's `read after rejection` reuses the snapshot kept since and makes the two
   * edits still queued once more, where the tables document's finds the newest queued edit gone
   * and fetches. An approval's replay after its write fetches with no scope check and keeps
   * nothing, so `read after approval` makes its edit once more.
   *
   * `tabClones`, `fullReindexes` and `renders`: NO EDIT COPIES A TAB. The model changes in place
   * the runs its batch touches, and the one clone in these rows is the tests' Google, which applies
   * an approved batch with the whole-tab model. `renders` counts a tab rendered whole, which no
   * phase does. A step that finds its result stored decodes and renders nothing, and a read joins
   * the stored Markdown of its runs. A bound Doc's `approval` of a large-tab edit makes the edit
   * behind it in the tab as Google returned it, another version than the model's, stored beside
   * the base with only its changed run rendered; the read after it finds the result. That is the
   * one make an approval costs each edit still queued in the tab it wrote: a fetch that brings a
   * tab under another marker, title or place brings the same version. An edit recomputes the
   * indexes of the runs its batch touches once, after its requests, and none before them; the
   * tables document's last edit sets widths and moves no index, so it recomputes none.
   *
   * `fingerprints`: a bound Doc serializes no queue to queue an edit; through Drive each queued
   * edit serializes its tab's queue twice, at its check and once that check's read was authorized.
   *
   * `lookupSteps`: a lookup halves its way to its place: 14 or 15 comparisons to a paragraph of the
   * paragraphs document's 20,000, and 13 to 16 to a cell's paragraph in the tables document
   * (through the body's 20 elements, a table's 25 rows and a row's 20 cells). A request that writes
   * text makes two lookups, the paragraph it names and the code unit before its index; the one
   * after is read only after a high surrogate, which none here is. The replay and the tests'
   * Google both count.
   */
  const EXPECTED: Record<string, Record<string, number[]>> = {
    "paragraphs, bound directly": {
      "cold read": [0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 4278245, 653, 0, 126, 0, 0, 0, 0],
      "queue": [0, 0, 5, 17, 10, 0, 252, 0, 0, 0, 0, 0, 536, 5, 10, 0, 5, 17, 5],
      "reads": [0, 0, 0, 12, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 5],
      "dropped edit": [0, 0, 3, 4, 1, 0, 164, 1, 1, 2, 0, 4278272, 1173, 3, 7, 1, 4, 0, 4],
      "rejection": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 260, 0, 0, 0, 0, 0, 3],
      "read after rejection": [0, 0, 1, 2, 1, 0, 44, 0, 1, 1, 0, 27, 133, 1, 2, 0, 1, 1, 3],
      "approval (other tab)": [0, 1, 2, 2, 1, 0, 28, 1, 0, 3, 599, 4278584, 17, 0, 1, 0, 0, 3, 2],
      "approval": [0, 1, 3, 1, 1, 0, 128, 1, 0, 3, 610, 4278737, 650, 1, 3, 1, 1, 1, 1],
      "read after approval": [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    },
    "cells, bound directly": {
      "cold read": [0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1273180, 128, 0, 21, 0, 0, 0, 0],
      "queue": [0, 0, 4, 17, 10, 0, 109, 0, 0, 0, 0, 0, 116, 37, 42, 0, 5, 17, 5],
      "reads": [0, 0, 0, 12, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 5],
      "dropped edit": [0, 0, 2, 4, 1, 0, 73, 1, 1, 2, 0, 1273207, 228, 25, 29, 1, 4, 0, 4],
      "rejection": [0, 0, 0, 7, 2, 0, 1, 0, 0, 0, 0, 0, 71, 9, 10, 0, 1, 6, 3],
      "read after rejection": [0, 0, 0, 2, 1, 0, 0, 0, 1, 1, 0, 27, 1, 0, 0, 0, 0, 2, 3],
      "approval (other tab)": [0, 1, 2, 2, 1, 0, 28, 1, 0, 3, 599, 1273519, 17, 0, 1, 0, 0, 3, 2],
      "approval": [0, 1, 2, 1, 1, 0, 47, 1, 0, 3, 515, 1273665, 125, 9, 11, 1, 1, 1, 1],
      "read after approval": [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    },
    "paragraphs, opened from a read and write Drive binding": {
      "cold read": [0, 0, 0, 0, 1, 0, 0, 1, 0, 2, 0, 4278370, 1668, 252, 252, 0, 0, 0, 0],
      "queue": [0, 0, 5, 17, 10, 10, 252, 5, 0, 20, 2200, 21393915, 541, 1265, 10, 0, 5, 17, 5],
      "reads": [0, 0, 0, 12, 3, 0, 0, 0, 0, 3, 0, 375, 0, 0, 0, 0, 0, 12, 5],
      "dropped edit": [0, 0, 3, 4, 1, 0, 164, 1, 1, 3, 0, 4278397, 1813, 255, 8, 2, 4, 0, 4],
      "rejection": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
      "read after rejection": [0, 0, 2, 2, 1, 0, 100, 0, 0, 1, 0, 125, 264, 2, 4, 0, 2, 0, 3],
      "approval (other tab)": [0, 1, 2, 2, 1, 0, 28, 1, 0, 5, 1479, 4279160, 10, 0, 1, 0, 0, 3, 2],
      "approval": [0, 1, 3, 1, 1, 0, 128, 2, 0, 6, 1490, 8557708, 533, 1, 4, 1, 1, 1, 1],
      "read after approval": [0, 0, 1, 1, 1, 0, 44, 1, 0, 2, 0, 4278673, 798, 253, 6, 2, 1, 0, 1],
    },
    "cells, opened from a read and write Drive binding": {
      "cold read": [0, 0, 0, 0, 1, 0, 0, 1, 0, 2, 0, 1273305, 303, 42, 42, 0, 0, 0, 0],
      "queue": [0, 0, 4, 17, 10, 10, 109, 5, 0, 20, 2200, 6368590, 121, 247, 42, 0, 5, 17, 5],
      "reads": [0, 0, 0, 12, 3, 0, 0, 0, 0, 3, 0, 375, 0, 0, 0, 0, 0, 12, 5],
      "dropped edit": [0, 0, 2, 4, 1, 0, 73, 1, 1, 3, 0, 1273332, 331, 67, 30, 2, 4, 0, 4],
      "rejection": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      "read after rejection": [0, 0, 1, 1, 1, 0, 36, 1, 0, 2, 0, 1273305, 28, 47, 6, 0, 1, 0, 2],
      "approval (other tab)": [0, 1, 2, 1, 1, 0, 28, 1, 0, 5, 1479, 1274095, 10, 0, 1, 0, 0, 2, 1],
      "approval": [0, 1, 2, 0, 0, 0, 46, 1, 0, 5, 1395, 1274092, 34, 0, 1, 0, 0, 1, 0],
      "read after approval": [0, 0, 0, 0, 1, 0, 0, 1, 0, 2, 0, 1273604, 117, 42, 4, 2, 0, 0, 0],
    },
  };

  describe.each(RUNS)("$name", r => {
    inRun(r);

    it.each(["paragraphs", "cells"] as const)(
      "replays a queue on the document of %s for the counts recorded", async shape => {
        let rows = await measure(shape);
        expect(Object.fromEntries(rows.map(row =>
          [row.phase, [...MEASURES.map(column => row[column]), row.pending]])))
          .toEqual(EXPECTED[`${shape}, ${r.name}`]);
      });
  });

  /** What `body` adds to the store's counts (widenings too), model clones and Google's reads. */
  async function costOf(docs: DocsModel, body: () => Promise<unknown>) {
    let totals = () => ({
      runsDecoded: docStoreCost.runsDecoded, runsRendered: docStoreCost.runsRendered,
      rowsWritten: docStoreCost.rowsWritten, resultsStored: docStoreCost.resultsStored,
      resultsFound: docStoreCost.resultsFound, tabClones: replayCost.tabClones,
      viewWidenings: docStoreCost.viewWidenings, documentFetches: docs.documentFetches,
    });
    let before = totals();
    await body();
    let after = totals();
    return Object.fromEntries(Object.entries(after).map(([measure, count]) =>
      [measure, count - before[measure as keyof typeof before]])) as typeof before;
  }

  /** The document of paragraphs, read once under a frozen clock, and what queues an edit of it. */
  async function largeDocument(facet: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    let docs = documentOf("paragraphs");
    let read = () => hooks().readContent(facet, MAIN_TAB);
    await read();
    /** Queues edit `i` of the large tab. */
    let queue = async (i: number) =>
      (await edit(facet, "replaceText", ...DOCUMENTS.paragraphs.texts(i), MAIN_TAB)).actionId;
    return { docs, read, queue };
  }

  // What the store saves a bound Doc, on a tab of 20,000 paragraphs: counted in the object
  // itself, which runs in the test's isolate.
  describe("a tab of 20,000 paragraphs, bound directly", () => {
    inRun(STANDALONE);

    it("a pending read decodes no run and renders none", async () => {
      let facet = "large-pending-read";
      let { docs, read, queue } = await largeDocument(facet);
      for (let i = 1; i <= 3; i++) await queue(i);
      let content = await read();
      expect(content).toContain(DOCUMENTS.paragraphs.texts(3)[1]);
      let renders = replayCost.renders;

      let cost = await costOf(docs, async () => expect(await read()).toBe(content));

      expect(cost).toEqual({
        runsDecoded: 0, runsRendered: 0, rowsWritten: 0, resultsStored: 0, resultsFound: 3,
        tabClones: 0, viewWidenings: 0, documentFetches: 0,
      });
      expect(replayCost.renders).toBe(renders);
    });

    it("an approval builds its write from the stored result and decodes no run", async () => {
      let facet = "large-approval";
      let { docs, read, queue } = await largeDocument(facet);
      let first = await queue(1);
      await read();
      let from = requestsMade();

      let cost = await costOf(docs, async () =>
        expect(await hooks().applyAction(facet, first)).toBeNull());

      // No document is read before the write, and none after it: nothing is left pending.
      expect(docsRequestsSince(from)).toEqual(["content", "cleanup"]);
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, resultsFound: 1, documentFetches: 0 });
      expect(docs.text()).toContain(DOCUMENTS.paragraphs.texts(1)[1]);
    });

    it("a rejection decodes no run of a tab it does not change", async () => {
      let facet = "large-rejection";
      let { docs, read, queue } = await largeDocument(facet);
      let other = (await edit(
        facet, "replaceText", "note 07 beta", "note 07 edited", SECOND_TAB)).actionId;
      await queue(1);
      let last = await queue(2);
      let content = await read();

      // An edit of the other tab: the large tab's two results are found by the read after it.
      let cost = await costOf(docs, async () => {
        await hooks().rejectAction(facet, other);
        expect(await read()).toBe(content);
      });
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, resultsStored: 0, resultsFound: 2 });

      // The large tab's last edit: the tab is read as the edit before it left it, which is stored.
      cost = await costOf(docs, async () => {
        await hooks().rejectAction(facet, last);
        expect(await read()).not.toContain(DOCUMENTS.paragraphs.texts(2)[1]);
      });
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, resultsStored: 0, resultsFound: 1 });
    });

    it("queues N edits and stores N results", async () => {
      let facet = "large-queue";
      let { docs, read, queue } = await largeDocument(facet);

      let cost = await costOf(docs, async () => {
        for (let i = 1; i <= N; i++) {
          await queue(i);
          await read();
        }
      });

      // Each edit decodes one of the tab's 125 runs, its piece's, which the model takes as decoded.
      // No tab is copied.
      expect(cost).toMatchObject({
        resultsStored: N, runsDecoded: N, tabClones: 0, documentFetches: 0,
      });
    });
  });

  // A Doc opened through Drive fetches at the first read after an edit is queued, and reads the
  // document it fetched in a trial. What that costs in edits made again, and what it does not.
  describe("a tab of 20,000 paragraphs, opened from a read and write Drive binding", () => {
    inRun(THROUGH_DRIVE);

    it("a pending read after the snapshot is reused decodes no run", async () => {
      let facet = "large-drive-reused";
      let { docs, read, queue } = await largeDocument(facet);
      for (let i = 1; i <= 2; i++) {
        await queue(i);
        await read();
      }

      let cost = await costOf(docs, read);

      expect(cost).toMatchObject({
        runsDecoded: 0, runsRendered: 0, resultsStored: 0, resultsFound: 2, tabClones: 0,
        documentFetches: 0,
      });
    });

    it("a fetch that brings the document unchanged makes no pending edit again", async () => {
      let facet = "large-drive-unchanged";
      let { docs, read, queue } = await largeDocument(facet);
      // Prepared on the copy the first read kept.
      await queue(1);

      // An edit was queued since the snapshot, so the read fetches, and tries what it fetched.
      expect(await costOf(docs, read)).toMatchObject(
        { documentFetches: 1, tabClones: 0, resultsStored: 0, resultsFound: 1 });
      // The read after it reuses the snapshot that one kept.
      expect(await costOf(docs, read)).toMatchObject(
        { documentFetches: 0, resultsStored: 0, resultsFound: 1 });
    });

    it("makes an edit prepared after an approved read once", async () => {
      let facet = "large-drive-read-between";
      let { docs, read, queue } = await largeDocument(facet);
      await queue(1);
      await read();

      expect(await costOf(docs, () => queue(2))).toMatchObject(
        { documentFetches: 0, resultsStored: 1 });
      expect(await costOf(docs, read)).toMatchObject(
        { documentFetches: 1, resultsStored: 0, resultsFound: 2 });
    });

    it("makes an edit prepared in a trial once more at the next read, and never after", async () => {
      let facet = "large-drive-back-to-back";
      let { docs, read, queue } = await largeDocument(facet);
      await queue(1);

      // No read was approved since the first edit was queued: the preparation fetches, and runs
      // in a trial, which leaves nothing of an edit that is not pending yet.
      expect(await costOf(docs, () => queue(2))).toMatchObject(
        { documentFetches: 1, resultsStored: 1, resultsFound: 1 });
      // The read finds it pending and makes it once more, for good.
      expect(await costOf(docs, read)).toMatchObject(
        { documentFetches: 1, resultsStored: 1, resultsFound: 1 });
      expect(await costOf(docs, read)).toMatchObject(
        { documentFetches: 0, resultsStored: 0, resultsFound: 2 });
    });

    it("makes one queued edit in the run its batch touches, through Drive", async () => {
      let facet = "large-drive-one-edit";
      let { docs, queue } = await largeDocument(facet);

      // Prepared on the copy the first read kept, so nothing is fetched: of the tab's 125
      // runs ONE is decoded, for the piece the builders read, and the model takes it.
      expect(await costOf(docs, () => queue(1))).toMatchObject({
        documentFetches: 0, resultsStored: 1, tabClones: 0, viewWidenings: 0, runsDecoded: 1,
      });
    });

    // The upper bound: 2N - 1 makes for N edits, where a bound Doc makes N. A read between two
    // edits brings it back to N ("makes an edit prepared after an approved read once").
    it("queues N edits back to back through Drive and makes each but the first twice", async () => {
      let facet = "large-drive-queue";
      let { docs, read, queue } = await largeDocument(facet);

      let cost = await costOf(docs, async () => {
        for (let i = 1; i <= N; i++) await queue(i);
        await read();
      });

      expect(cost.resultsStored).toBe(2 * N - 1);
      expect(await costOf(docs, read)).toMatchObject({ resultsStored: 0, resultsFound: N });

      // What a fetch decodes with nothing to make, measured beside it: the document it holds,
      // read back a run at a time by its trial and by the keep after it.
      let beside = await largeDocument("large-drive-fetch");
      await beside.queue(1);
      let fetch = await costOf(beside.docs, beside.read);
      expect(fetch).toMatchObject({ documentFetches: 1, resultsStored: 0, resultsFound: 1 });
      // Each of the 2N - 1 makings decodes its piece's one run, and each of the N fetches what a
      // fetch decodes. No tab is copied and no batch widens.
      expect(cost).toMatchObject({
        documentFetches: N, tabClones: 0, viewWidenings: 0,
        runsDecoded: (2 * N - 1) + N * fetch.runsDecoded,
      });
    });
  });
});

// An approval whose pinned batch Google refused builds its write from the document it then
// fetches, stored as it is read, in a trial that keeps nothing. What cannot be stored fails
// the approval and leaves the edit pending; what the renderer throws on, and what the edit
// itself refuses, records the edit as one that cannot be applied.
describe.each(RUNS)("an approved Google Doc edit built from the document its approval fetched, $name", r => {
  inRun(r);

  const BINDING = { scope: { kind: "file", fileId: "doc-1" }, access: "write" } as const;
  /** The other tab of the document, which the edit does not name. */
  const OTHER_TAB = "details";
  /** One statement run on the connection's storage, and its rows. */
  const exec = (facet: string, statement: string) => r.drive
    ? rawHooks().driveDocStoreExec(`drive:${facet}`, BINDING, statement)
    : hooks().docStoreExec(facet, statement);
  /**
   * Every row of the store's tables, in the order of their keys, but when the copy was last
   * confirmed: an edit recorded as one that cannot be applied makes the next read confirm it.
   */
  const storedRows = async (facet: string): Promise<string[]> => (await Promise.all([
    "SELECT doc, id, revision, fetched_at, stale, folder, approved, made, outline, markers, versions " +
      "FROM doc_copy ORDER BY doc",
    "SELECT * FROM doc_md ORDER BY run, context, carry",
    "SELECT * FROM doc_result ORDER BY version, edit",
    "SELECT * FROM doc_run ORDER BY id",
    "SELECT * FROM doc_seq ORDER BY version, seq",
    "SELECT * FROM doc_version ORDER BY doc, id",
  ].map(async (statement, table) =>
    (await exec(facet, statement)).map(row => `${table}: ${JSON.stringify(row)}`)))).flat();
  /** What Google sent of the stored copy, as a digest. */
  const baseRows = (facet: string) => r.drive
    ? rawHooks().driveDocBaseRows(`drive:${facet}`, BINDING, "doc-1")
    : hooks().docBaseRows(facet);
  /**
   * Expects that `facet`'s store holds no row it did not hold when `before` was taken, and the
   * copy as Google sent it then. An edit that is failed takes what it alone reached with it,
   * so rows may have gone.
   */
  async function expectNothingStoredSince(
    facet: string, before: { rows: string[]; base: string },
  ): Promise<void> {
    let held = new Set(before.rows);
    let rows = await storedRows(facet);
    expect(rows.filter(row => !held.has(row))).toEqual([]);
    // A Doc's own connection sweeps at its next read, so its rows are the same ones.
    if (!r.drive) expect(rows).toEqual(before.rows);
    expect(await baseRows(facet)).toBe(before.base);
  }
  /** The edits `facet` holds for approval that none has failed, oldest first. */
  async function pending(facet: string): Promise<number[]> {
    if (r.drive) return rawHooks().driveQueued(`drive:${facet}`, BINDING);
    let keys = (await hooks().storedKeys(facet, "doc")).filter(key => key.startsWith("pending:action:"));
    let records = await Promise.all(keys.map(async key => {
      let { kv = "{}" } = await hooks().storedValue(facet, "doc", key);
      let { invalidatedReason } = JSON.parse(kv) as { invalidatedReason?: string };
      return invalidatedReason ? [] : [Number(key.slice("pending:action:".length))];
    }));
    return records.flat().toSorted((a, b) => a - b);
  }
  /** The lines logged of an edit recorded as one that cannot be applied. */
  const unapplyableLines = (error: MockInstance<typeof console.error>) =>
    error.mock.calls.map(([line]) => line as Record<string, unknown>)
      .filter(line => line?.event === "google.doc.action.apply.unapplyable");

  /** A body with a paragraph too large for one stored row. */
  const pastRow = () => buildTab([para("Alpha"), para("a".repeat(DOC_ROW_BYTES + 1))]).body;
  /** A tab with a list item the renderer throws on: its nesting level is -1. */
  function unrendered(): GoogleDocsTab {
    return buildTab(
      [para("Alpha"), { runs: ["Listed\n"], bullet: { listId: "L1", nestingLevel: -1 } }, para("Beta")],
      BULLET_LIST);
  }
  /** The message of what the renderer throws on `tab`. */
  const rendererSays = (tab: GoogleDocsTab): string => thrownMessage(() => docTabToMarkdown(tab));

  /**
   * A document of two tabs, read, with an append to the first queued and read again: the
   * copy a write is built from is stored. With the rows stored then.
   */
  async function queuedOnTwoTabs(facet: string) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.addTab(OTHER_TAB, "Details", MAIN_TAB, "Notes");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let actionId = await hooks().submitAppend(facet, "Appended", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n\nAppended\n");
    return { docs, actionId, logged, rows: await storedRows(facet) };
  }
  /** The rows `facet`'s store holds, and the digest of the copy as Google sent it. */
  const stored = async (facet: string) =>
    ({ rows: await storedRows(facet), base: await baseRows(facet) });

  it.each([
    ["the edit's tab", MAIN_TAB],
    ["the other tab", OTHER_TAB],
  ])("leaves the edit pending when the document its approval fetched cannot be stored: a paragraph past a row in %s",
    async (_name, tabId) => {
      let facet = `fallback-unstored-${tabId}`;
      let { docs, actionId, logged, rows } = await queuedOnTwoTabs(facet);
      docs.setBody(tabId, pastRow());
      let from = requestsMade();
      let answer = await hooks().applyAction(facet, actionId);
      expect(answer).toContain(`A paragraph of tab "${tabId}" of this Google Doc is too large to keep a copy of: `);
      expect(answer).not.toContain("Pending Google Doc edit could not be applied");
      // The batch pinned to the copy, which Google refused, and the read: no batch after it.
      expect(docsRequestsSince(from)).toEqual(["content", "read"]);
      expect(docs.contentBatches).toBe(0);
      expect(await pending(facet)).toEqual([actionId]);
      expect(unapplyableLines(logged)).toEqual([]);
      expect(await storedRows(facet)).toEqual(rows);

      // Approved again once the document can be stored, the edit applies.
      docs.setText(tabId, tabId === MAIN_TAB ? "Alpha\nBeta again" : "Notes again");
      from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBeNull();
      expect(docsRequestsSince(from).slice(0, 3)).toEqual(["read", "content", "cleanup"]);
      expect(docs.contentBatches).toBe(1);
      expect(docs.text(MAIN_TAB)).toBe(tabId === MAIN_TAB ? "Alpha\nBeta again\nAppended" : "Alpha\nBeta\nAppended");
    });

  // The edit's own tab is held in doc-actions.test.ts.
  it.each([
    ["the other tab", OTHER_TAB],
  ])("records the edit as unapplyable when the renderer throws on the document its approval fetched: a list item in %s",
    async (_name, tabId) => {
      let facet = `fallback-unrendered-${tabId}`;
      let { docs, actionId, logged } = await queuedOnTwoTabs(facet);
      let behind = await hooks().submitAppend(facet, "Behind", MAIN_TAB);
      expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n\nAppended\n\nBehind\n");
      let before = await stored(facet);
      let says = rendererSays(unrendered());
      docs.setBody(tabId, unrendered().body, BULLET_LIST);
      let from = requestsMade();

      expect(await hooks().applyAction(facet, actionId)).toBe(says);
      expect(docsRequestsSince(from)).toEqual(["content", "read"]);
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(unapplyableLines(logged)[0]).toMatchObject({ actionId });
      // Approving it again repeats the reason, and asks Google nothing.
      from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBe(run.unapplied(says));
      expect(docsRequestsSince(from)).toEqual([]);
      expect(docs.contentBatches).toBe(0);
      await expectNothingStoredSince(facet, before);
      // The edit queued behind it is not held back by it.
      expect(await pending(facet)).toEqual([behind]);
      expect(await hooks().applyAction(facet, behind)).not.toBe(run.outOfOrder(actionId, behind));
    });

  // The trial removes what neither the stored copy nor a queued edit reaches, so it is told
  // of every queued edit: what a read stored of them, in either tab, is there after it.
  it("keeps what the queued edits reach in the store when the document its approval fetched refuses the edit",
    async () => {
      let facet = "fallback-refused";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let docs = new DocsModel();
      docs.setText(MAIN_TAB, "Alpha\nBeta");
      docs.addTab(OTHER_TAB, "Details", MAIN_TAB, "Notes");
      docs.install();
      expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
      let actionId = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
      let behind = await hooks().submitAppend(facet, "Appended", OTHER_TAB);
      expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n");
      expect(await hooks().readContent(facet, OTHER_TAB)).toBe("Notes\n\nAppended\n");
      let before = await stored(facet);

      // The text the edit replaces is gone from the document at Google.
      docs.setText(MAIN_TAB, "Alpha\nDelta");
      let from = requestsMade();
      expect(await hooks().applyAction(facet, actionId)).toBe(
        `replaceText: oldMarkdown was not found in the current simulated tab "${MAIN_TAB}". ` +
        `Make sure the text exactly matches content returned by getContent("${MAIN_TAB}").`);
      // The trial stored the document and ran to its end: the edit refused the copy it gave.
      expect(docsRequestsSince(from)).toEqual(["content", "read"]);
      expect(docs.contentBatches).toBe(0);
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(await pending(facet)).toEqual([behind]);
      await expectNothingStoredSince(facet, before);
    });

  it.each<[string, () => { body: GoogleDocsTab["body"]; lists?: GoogleDocsTab["lists"] }]>([
    ["a list item the renderer throws on", () => ({ body: unrendered().body, lists: BULLET_LIST })],
  ])("records an edit whose tab is gone with its own refusal, where the document holds %s",
    async (name, other) => {
      let facet = `fallback-tab-gone-${name.length}`;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let docs = new DocsModel();
      docs.setText(MAIN_TAB, "Alpha\nBeta");
      docs.addTab(OTHER_TAB, "Details", MAIN_TAB, "Notes");
      docs.addTab("metrics", "Metrics", MAIN_TAB, "Counted");
      docs.install();
      expect(await hooks().readContent(facet, "metrics")).toBe("Counted\n");
      let actionId = await hooks().submitAppend(facet, "Appended", "metrics");
      expect(await hooks().readContent(facet, "metrics")).toBe("Counted\n\nAppended\n");
      let before = await stored(facet);

      // The edit's tab is deleted, and a tab that is still there cannot be stored or rendered.
      docs.removeTab("metrics");
      let { body, lists } = other();
      docs.setBody(OTHER_TAB, body, lists);
      let from = requestsMade();
      let refusal = 'appendText: no tab with ID "metrics" exists in this document. ' +
        "Call listTabs() to refresh the tab list.";
      expect(await hooks().applyAction(facet, actionId)).toBe(refusal);
      expect(docsRequestsSince(from)).toEqual(["content", "read"]);
      expect(docs.contentBatches).toBe(0);
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(await pending(facet)).toEqual([]);
      expect(await hooks().applyAction(facet, actionId)).toBe(run.unapplied(refusal));
      await expectNothingStoredSince(facet, before);
    });

  // A BATCH PAST ITS PIECE, AND A PIECE THAT CANNOT BE MADE, refuse the edit: each recurs at every
  // rebuild in the same version, so neither may fail a read, rejection or approval as faults do.
  // A spy on the store's `piece` makes them.
  const MODEL_FAULT = (operation: string) =>
    `${operation}: this change cannot be shown as it will read once applied, so it cannot be ` +
    "made through this connection. Make it in Google Docs.";
  /** Makes every piece the store answers leave out what its batch names, or fail to be made. */
  function faultyPieces(fault: "leaves" | "unmade") {
    let piece = DocStore.prototype.piece;
    return vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      if (fault === "unmade") throw new DocPieceError("A piece that cannot be made.");
      let made = piece.call(this, version, at);
      let { inner } = made.at;
      return { ...made, at: { ...made.at, first: false, inner: { from: inner.to, to: inner.to } } };
    });
  }
  /** The lines logged for `event`. */
  const linesOf = (error: MockInstance<typeof console.error>, event: string) =>
    error.mock.calls.map(([line]) => line as Record<string, unknown>).filter(line => line?.event === event);

  it.each([
    ["a batch that leaves the piece it was built from", "leaves", "google.doc.piece.overreach"],
    ["a piece that cannot be made", "unmade", "google.doc.prepare.model-refused"],
  ] as const)("records as unapplyable an edit whose build from the fetched document gives %s",
    async (_name, fault, event) => {
      let facet = `fallback-piece-${fault}`;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let docs = new DocsModel();
      docs.setText(MAIN_TAB, "Alpha\nBeta");
      docs.addTab(OTHER_TAB, "Details", MAIN_TAB, "Notes");
      docs.install();
      expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
      // A replacement in the tab's first paragraph: its batch names an index before the
      // start of the piece's last element, which is all the narrowed piece keeps.
      let actionId = await hooks().submitReplace(facet, "Alpha", "Gamma", MAIN_TAB);
      let behind = await hooks().submitAppend(facet, "Appended", OTHER_TAB);
      expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Gamma\n\nBeta\n");
      expect(await hooks().readContent(facet, OTHER_TAB)).toBe("Notes\n\nAppended\n");
      // No result is stored for the edit in the copy's version: the approval builds it.
      await exec(facet, "DELETE FROM doc_result");
      let from = requestsMade();

      let pieces = faultyPieces(fault);
      let answer = await hooks().applyAction(facet, actionId);
      pieces.mockRestore();

      // The copy answers nothing for it, so the approval reads the document, and the edit
      // built from what it fetched is refused in the words of a change that cannot be shown.
      expect(answer).toBe(MODEL_FAULT("replaceText"));
      expect(docsRequestsSince(from)).toEqual(["read"]);
      expect(docs.contentBatches).toBe(0);
      let marked = linesOf(logged, event);
      expect(marked).toHaveLength(1);
      if (fault === "leaves") expect(marked[0]).toMatchObject({ operation: "replaceText", side: "before" });
      else expect(marked[0]).toMatchObject({ operation: "replaceText", outcome: "DocPieceError" });
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(unapplyableLines(logged)[0]).toMatchObject({ actionId });
      // Nothing of the document is in what was logged.
      expect(JSON.stringify(marked)).not.toMatch(/Alpha|Beta|Gamma/);
      expect(linesOf(logged, fault === "leaves" ? "google.doc.prepare.model-refused" : "google.doc.piece.overreach"))
        .toEqual([]);
      // The edit behind it stops waiting, and approving the refused one again repeats the reason.
      expect(await pending(facet)).toEqual([behind]);
      expect(await hooks().applyAction(facet, actionId)).toBe(run.unapplied(MODEL_FAULT("replaceText")));
    });

  it("answers a read whose replay builds a batch past its piece, and drops that edit alone", async () => {
    let facet = "read-overreach";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let replaced = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
    let appended = await hooks().submitAppend(facet, "Appended", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n\nAppended\n");

    // The document changes at Google, so the next read fetches and makes the edits again.
    docs.setText(MAIN_TAB, "Alpha\nBeta\nNew");
    passSnapshotTtl();
    let pieces = faultyPieces("leaves");
    let content = await hooks().readContent(facet, MAIN_TAB);
    pieces.mockRestore();

    // The read answers the tab as fetched with the edit behind the refused one made in it:
    // an append names no index before its piece.
    expect(content).toBe("Alpha\n\nBeta\n\nNew\n\nAppended\n");
    let marked = linesOf(logged, "google.doc.piece.overreach");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ actionId: replaced, operation: "replaceText", side: "before" });
    expect(await pending(facet)).toEqual([appended]);
    // A second read builds nothing again: the record carries its reason.
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe(content);
    expect(linesOf(logged, "google.doc.piece.overreach")).toHaveLength(1);
  });

  // A COPY THAT LOST A ROW is storage's fault, and is told as one wherever the row is met.
  /** Removes, beneath the store, every run of the copy and every stored rendering. */
  const loseRuns = async (facet: string) => {
    await exec(facet, "DELETE FROM doc_md");
    await exec(facet, "DELETE FROM doc_run WHERE json NOT LIKE '%\"lists\"%'");
  };

  it("answers a read with an edit pending over a copy that lost a row from a fresh fetch", async () => {
    let facet = "unreadable-read";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let actionId = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
    await loseRuns(facet);
    await exec(facet, "DELETE FROM doc_result");

    // The read's replay meets the missing row, and the copy is dropped. A bound Doc's read
    // says so, and the next one fetches and replays; through Drive the read fetches again
    // itself. The edit stays pending either way.
    let first = await Promise.resolve(hooks().readContent(facet, MAIN_TAB))
      .catch((error: Error) => error.message);
    let second = await hooks().readContent(facet, MAIN_TAB);
    if (r.drive) expect(first).toBe("Alpha\n\nGamma\n");
    else expect(first).toContain(DOC_COPY_UNREADABLE);
    expect(second).toBe("Alpha\n\nGamma\n");
    expect(await pending(facet)).toEqual([actionId]);
  });

  it("falls back to a fetch where the copy an approval builds from lost a row", async () => {
    let facet = "unreadable-approval";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let actionId = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n");
    await exec(facet, "DELETE FROM doc_result");
    await loseRuns(facet);
    let from = requestsMade();

    // The copy answers nothing, so the approval reads the document and builds from that.
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docsRequestsSince(from).slice(0, 2)).toEqual(["read", "content"]);
    expect(docs.text(MAIN_TAB)).toBe("Alpha\nGamma");
    // The copy stored now reads back.
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n");
  });

  it("fails an approval whose fetched copy loses a row as it is read, and lands it when approved again", async () => {
    let facet = "unreadable-trial";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let actionId = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n");
    await exec(facet, "DELETE FROM doc_result");
    // The document moved at Google, so the batch pinned to the copy is refused and the
    // approval builds from the document it fetches, in a trial.
    docs.setText(MAIN_TAB, "Alpha\nBeta\nNew");

    // Inside the trial, once Google was asked, the copy does not read back: what the store
    // throws for a missing row, where the piece is made.
    let piece = DocStore.prototype.piece;
    let from = requestsMade();
    let pieces = vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      if (requestsMade() > from) throw new Error(DOC_COPY_UNREADABLE);
      return piece.call(this, version, at);
    });
    let answer = await hooks().applyAction(facet, actionId);
    pieces.mockRestore();

    expect(answer).toContain(DOC_COPY_UNREADABLE);
    expect(unapplyableLines(logged)).toEqual([]);
    expect(await pending(facet)).toEqual([actionId]);
    expect(docs.contentBatches).toBe(0);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.text(MAIN_TAB)).toBe("Alpha\nGamma\nNew");
  });

  it("builds an approval's write from the copy and keeps no row until the write lands", async () => {
    let facet = "copy-built-write";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Alpha\nBeta");
    docs.install();
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nBeta\n");
    let actionId = await hooks().submitReplace(facet, "Beta", "Gamma", MAIN_TAB);
    expect(await hooks().readContent(facet, MAIN_TAB)).toBe("Alpha\n\nGamma\n");
    // No result is stored for the edit in the copy's version, whose renderings are all
    // stored: the approval builds its write from the piece of the tab around the edit.
    await exec(facet, "DELETE FROM doc_result");
    let built = vi.spyOn(DocStore.prototype, "piece");
    let fetched = docs.fetch.bind(docs);
    let written = docStoreCost.rowsWritten, atWrite: number | undefined;
    vi.spyOn(docs, "fetch").mockImplementation((input, init) => {
      if (docsRequestKind(input, init) === "content") atWrite ??= docStoreCost.rowsWritten;
      return fetched(input, init);
    });
    let from = requestsMade();

    expect(await hooks().applyAction(facet, actionId)).toBeNull();

    // The batch is the first request: no document was read to build it.
    expect(docsRequestsSince(from)[0]).toBe("content");
    expect(built).toHaveBeenCalled();
    // Made and checked as a replay makes it, in a transaction that is undone: its two rows, the
    // deleted result among them, are not kept, and nothing else is written.
    expect(atWrite! - written).toBe(2);
    expect(docs.text(MAIN_TAB)).toBe("Alpha\nGamma");
    built.mockRestore();
  });

  /** A tab with a table, read, with two replacements and a table change queued, in that order. */
  async function queuedBeforeATable(facet: string) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let docs = docsWithBody(buildTab([
      para("Zebra"), para("Yak"), grid(["Quokka", "Wombat"], ["Numbat", "Bilby"]), para("Dingo"),
    ]).body);
    await hooks().readContent(facet, MAIN_TAB);
    let first = (await edit(facet, "replaceText", "Zebra", "Okapi", MAIN_TAB)).actionId;
    let second = (await edit(facet, "replaceText", "Yak", "Gnu", MAIN_TAB)).actionId;
    let rows = (await edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] }, MAIN_TAB)).actionId;
    expect(await hooks().readContent(facet, MAIN_TAB)).toContain("Okapi\n\nGnu\n");
    return { docs, logged, first, second, rows };
  }

  // A bound Doc's rejection replays the queue where a change that names a table is behind
  // the rejected edit; a Drive binding fails that change with the rejection.
  it.skipIf(r.drive)("rejects an edit though the edit behind it then builds a batch past its piece", async () => {
    let facet = "reject-overreach";
    let { logged, first, second, rows } = await queuedBeforeATable(facet);

    let pieces = faultyPieces("leaves");
    await hooks().rejectAction(facet, first);
    pieces.mockRestore();

    // The rejected edit is gone. The replacement behind it, made again, left its piece and
    // is dropped with the fixed reason; the fold goes on, and the table change behind that,
    // built from the piece around its table, left its piece too and is dropped the same way.
    expect(await pending(facet)).toEqual([]);
    expect(linesOf(logged, "google.doc.piece.overreach")).toMatchObject([
      { actionId: second, operation: "replaceText", side: "before" },
      { actionId: rows, operation: "insertTableRows", side: "before" },
    ]);
    expect(await hooks().applyAction(facet, second)).toContain(MODEL_FAULT("replaceText"));
    expect(await hooks().applyAction(facet, rows)).toContain(MODEL_FAULT("insertTableRows"));
    // The copy was not dropped: a read answers from it, with no document fetched.
    let from = requestsMade();
    let content = await hooks().readContent(facet, MAIN_TAB);
    expect(content).toContain("Zebra\n\nYak\n");
    expect(content).not.toContain("<td><p>a</p></td>");
    expect(docsRequestsSince(from).filter(request => request === "read")).toEqual([]);
    await hooks().rejectAction(facet, second);
    await hooks().rejectAction(facet, rows);
    expect(await pending(facet)).toEqual([]);
  });

  it.skipIf(r.drive)("rejects an edit though its replay meets a row the copy lost, and drops the copy", async () => {
    let facet = "reject-unreadable";
    let { first, second, rows } = await queuedBeforeATable(facet);
    // Every run of the copy is there and none reads back: the rows a rejection checks
    // before it replays are found, and the piece of the edit made again is what meets them.
    await exec(facet, "UPDATE doc_run SET json = 'not a run' WHERE json NOT LIKE '%\"lists\"%'");

    await hooks().rejectAction(facet, first);

    // The rejection succeeds, and what its replay marked before it met the run is undone: the
    // replacement behind stays pending, and so does the table change behind that, since the
    // rejected edit changed no table.
    expect(await pending(facet)).toEqual([second, rows]);
    // The copy is dropped: the next read fetches the document, once, and replays the queue.
    let from = requestsMade();
    let content = await hooks().readContent(facet, MAIN_TAB);
    expect(content).toContain("Zebra\n\nGnu\n");
    expect(content).toContain("<td><p>a</p></td>");
    expect(docsRequestsSince(from).filter(request => request === "read")).toHaveLength(1);
  });
});

// What the store holds of a Doc's pending edits across a marker's removal, preparations that are
// never queued, and a deploy that changes the code that derives a stored result.
describe.each(RUNS)("what the store keeps of a Google Doc's pending edits, $name", r => {
  inRun(r);

  /** The Drive binding the hooks open the document through in the run through Drive. */
  const BINDING = { scope: { kind: "file", fileId: "doc-1" }, access: "write" } as const;
  /** The key of the document in its connection's store. */
  const KEY = r.drive ? "doc-1" : "doc";
  /** How many rows each table of the store holds. */
  const rowsOf = (facet: string): Promise<Record<string, number>> => r.drive
    ? rawHooks().driveDocStoreRows(`drive:${facet}`, BINDING, "doc-1")
    : hooks().docStoreRows(facet);
  /** One statement run on the connection's storage, and its rows. */
  const exec = (facet: string, statement: string, ...bindings: (string | number)[]) => r.drive
    ? rawHooks().driveDocStoreExec(`drive:${facet}`, BINDING, statement, ...bindings)
    : hooks().docStoreExec(facet, statement, ...bindings);
  const headOf = (facet: string) => r.drive
    ? rawHooks().driveDocStoreHead(`drive:${facet}`, BINDING, "doc-1")
    : hooks().docCopyHead(facet);
  const baseRows = (facet: string) => r.drive
    ? rawHooks().driveDocBaseRows(`drive:${facet}`, BINDING, "doc-1")
    : hooks().docBaseRows(facet);
  const frozen = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  };
  /** What the store made, found and wrote, and what Google was asked, so far. */
  const counts = (docs: DocsModel) => ({
    stored: docStoreCost.resultsStored, found: docStoreCost.resultsFound,
    written: docStoreCost.rowsWritten, fetches: docs.documentFetches, probes: docs.revisionProbes,
  });
  const since = (docs: DocsModel, before: ReturnType<typeof counts>) => {
    let after = counts(docs);
    return Object.fromEntries(Object.entries(after).map(([name, count]) =>
      [name, count - before[name as keyof typeof before]])) as ReturnType<typeof counts>;
  };

  // A version's name leaves the tab's write markers out, so a tab fetched again with a marker
  // gone is the version it was, and what the pending edits made in it is found.
  it.skipIf(r.drive)("makes no pending edit again when a fetch brings a tab unchanged under " +
    "another marker", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    // The first write's marker stays in the document: its cleanup fails.
    docs.cleanupFailures = 1;
    docs.install();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let facet = "store-marker-removed";
    let first = await hooks().submitAppend(facet, "one");
    await hooks().submitAppend(facet, "two");
    await hooks().submitAppend(facet, "three");
    let content = await hooks().readContent(facet);
    expect(content).toBe("base\n\none\n\ntwo\n\nthree\n");

    // The tab as Google returned it is another version than the one the model made: the two
    // edits still pending are made in it, once.
    let before = counts(docs);
    expect(await hooks().applyAction(facet, first)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(content);
    expect(since(docs, before).stored).toBe(2);
    expect((await hooks().docCopyHead(facet))!.writeMarkers[0]).toHaveLength(1);

    // The marker goes and the revision moves with it: the read fetches the same tab.
    docs.clearMarkers();
    passSnapshotTtl();
    before = counts(docs);
    expect(await hooks().readContent(facet)).toBe(content);
    expect(since(docs, before)).toMatchObject({ fetches: 1, stored: 0, found: 2 });
    expect((await hooks().docCopyHead(facet))!.writeMarkers[0]).toEqual([]);
  });

  // A preparation stores what it makes before the edit is queued, and the call may still fail:
  // here the approval queue refuses the read that authorizes a new table's position.
  it("keeps the rows of one preparation however many fail after they stored", async () => {
    frozen();
    let docs = docsWithBody(tableBody());
    let facet = "store-preparations-unqueued";
    await hooks().readContent(facet);
    let kept = await rowsOf(facet);
    let table = (word: string) => ({ rows: 1, columns: 1, cells: [[word]] });

    let one: Record<string, number> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(Promise.resolve(hooks().submitEdit(
        facet, "insertTable", [table(`nw00${attempt}`)], { refuseRead: true })))
        .rejects.toThrow("Reads of this document are refused.");
      // One result and one version beside the copy's, whatever the calls before left.
      let rows = await rowsOf(facet);
      expect(rows).toMatchObject({ doc_result: 1, doc_version: kept.doc_version + 1 });
      expect(rows).toEqual(one ??= rows);
    }

    // A call that succeeds queues its edit, whose result the next read finds.
    await edit(facet, "insertTable", table("nw009"));
    let before = counts(docs);
    expect(await hooks().readContent(facet)).toContain("<td><p>nw009</p></td>");
    expect(since(docs, before)).toMatchObject({ stored: 0, found: 1 });
    expect(await rowsOf(facet)).toMatchObject({ doc_result: 1, doc_version: kept.doc_version + 1 });
  });

  // What code derived of a stored tab is served only under the digest of that code. Rows left
  // by other code are made again from the stored copy, and Google is asked nothing.
  it("folds the pending edits once more under another digest and asks Google nothing", async () => {
    frozen();
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.addTab(SECOND_TAB, "Notes", MAIN_TAB, "note");
    docs.install();
    let facet = "store-other-digest";
    let read = () => hooks().readContent(facet, MAIN_TAB);
    await read();
    await hooks().readContent(facet, SECOND_TAB);
    const COUNT = 3;
    let ids: number[] = [];
    for (let i = 1; i <= COUNT; i++) {
      ids.push((await edit(facet, "appendText", `edit ${i}`, MAIN_TAB)).actionId);
      await read();
    }
    let content = await read();

    // Every derived row as other code would have left it.
    for (let statement of [
      "UPDATE doc_result SET made = 'other'",
      "UPDATE doc_md SET made = 'other'",
      "UPDATE doc_version SET derived = json_set(derived, '$.made', 'other')",
      "UPDATE doc_copy SET made = 'other'",
    ]) await exec(facet, statement);
    // What Google sent, kept byte for byte.
    let base = await baseRows(facet);

    let before = counts(docs);
    expect(await read()).toBe(content);
    expect(since(docs, before)).toMatchObject({ fetches: 0, probes: 0, found: 0, stored: COUNT });
    before = counts(docs);
    expect(await read()).toBe(content);
    expect(since(docs, before)).toMatchObject({ fetches: 0, found: COUNT, stored: 0 });
    expect(await baseRows(facet)).toBe(base);

    // A rejection sweeps: no row another digest made is left to be read.
    await hooks().rejectAction(facet, ids[COUNT - 1]);
    for (let table of ["doc_result", "doc_md"]) {
      expect(await exec(facet, `SELECT count(*) AS rows FROM ${table} WHERE made = 'other'`))
        .toEqual([{ rows: 0 }]);
    }
    expect(await exec(facet, "SELECT made FROM doc_copy WHERE doc = ?", KEY))
      .toEqual([{ made: DOC_DERIVED }]);
    expect(await baseRows(facet)).toBe(base);
    // Whether the model indexes a tab is said again where a fold asked it: of the tab with
    // pending edits, and not of the other, whose record no one read.
    let { versions } = (await headOf(facet))!;
    let derivedBy = async (id: string) => (await exec(
      facet, "SELECT json_extract(derived, '$.made') AS made FROM doc_version WHERE doc = ? AND id = ?",
      KEY, id))[0].made;
    expect([await derivedBy(versions[0]), await derivedBy(versions[1])]).toEqual([DOC_DERIVED, "other"]);
  });
});

describe("Google Doc edits through a read and write Drive binding", () => {
  inRun(THROUGH_DRIVE);

  type Binding = { scope: { kind: "account" } | { kind: "folder"; folderId: string } |
    { kind: "file"; fileId: string }; access?: "write"; deployment?: "read" };
  const DRIVE_DOC: Binding = { scope: { kind: "file", fileId: "doc-1" }, access: "write" };
  const READ_ONLY_DEPLOYMENT: Binding = { ...DRIVE_DOC, deployment: "read" };
  const ROOT = "folder-root";
  const FOLDER: Binding = { scope: { kind: "folder", folderId: ROOT }, access: "write" };
  const ACCOUNT: Binding = { scope: { kind: "account" }, access: "write" };
  const RECEIPT = "driveDocs:receipt:doc-1";
  const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
  const DEPLOYMENT_READ_ONLY =
    "This deployment keeps Google Drive read-only, so no Google Drive connection can make " +
    "changes, and none can be connected with read and write access. Only the deployment's " +
    "administrator can change that.";

  /** A document reading `text`, which the model answers Drive's requests for too. */
  function draft(text = "Draft"): DocsModel {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, text);
    docs.install();
    return docs;
  }

  /** The stored record of action `id` of the Drive facet `facet`, as `binding` holds it. */
  async function record(facet: string, id: number, binding = DRIVE_DOC) {
    let stored = await rawHooks().driveStored(`drive:${facet}`, binding, `drive:action:${id}`);
    return stored === null ? null : JSON.parse(stored) as {
      state: string; error?: string;
      action: { kind: string; payload: { change: { writeId: string } } };
    };
  }

  // The snapshot the binding's sessions share builds a write under the rules that let a read
  // reuse it: fetched since the newest edit was queued, and no write landed since.
  it("builds an approved edit from the snapshot its sessions share only while a read could reuse it", async () => {
    let docs = draft();
    let facet = "drive-copy-apply";
    let appended = await hooks().submitAppend(facet, "Appended");
    expect(await hooks().readContent(facet)).toBe("Draft\n\nAppended\n");
    let from = requestsMade();
    expect(await hooks().applyAction(facet, appended)).toBeNull();
    expect(docsRequestsSince(from)).toEqual(["content", "cleanup"]);

    // Queued on the read that prepared it, with no read since: the document is fetched.
    let replaced = await hooks().submitReplace(facet, "Draft", "Final");
    from = requestsMade();
    expect(await hooks().applyAction(facet, replaced)).toBeNull();
    expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
    expect(docs.text()).toBe("Final\nAppended");
    expect(docs.contentBatches).toBe(2);
  });

  // The binding's own suggestion is a batch of the document, which no count of its edits tells.
  it.each([
    ["suggestEdit", ["doc-1", "Draft", "Final"]],
    ["comment", ["doc-1", "Really?", { quote: "Draft" }]],
  ] as const)("reads the document for an approved edit once the binding's own %s has been applied", async (method, args) => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let docs = draft();
    let facet = `drive-copy-own-${method}`;
    let appended = await hooks().submitAppend(facet, "Appended");
    expect(await hooks().readContent(facet)).toBe("Draft\n\nAppended\n");
    let own = await rawHooks().callDrive(`drive:${facet}`, DRIVE_DOC, method, [...args]);
    expect(own.error).toBeUndefined();
    expect(await hooks().applyAction(facet, own.actionId!)).toBeNull();

    let from = requestsMade();
    expect(await hooks().applyAction(facet, appended)).toBeNull();
    expect(docsRequestsSince(from)).toEqual(["read", "content", "cleanup"]);
    expect(copyRefusals(warn)).toEqual([]);
    expect(docs.contentBatches).toBe(1);
  });

  // The write has landed and the action set has retired the record, so nothing replays the
  // append; its marker is still in the document. Reads are made from inside the marker's deletion
  // and inside the read of the new revision that follows it, as an overlapping read would land.
  it("reads an appended text once while its approval completes", async () => {
    let docs = draft();
    let facet = "drive-read-in-window";
    let appended = await hooks().submitAppend(facet, "Appended");
    let replaced = await hooks().submitReplace(facet, "Draft", "Final");

    let model = globalThis.fetch;
    let inside = false;
    let cleaning = false;
    let reads: { during: string; read: string; retired?: boolean; markers: number }[] = [];
    let readDuring = async (during: string, retired?: boolean) => {
      inside = true;
      try {
        let read = await hooks().readContent(facet);
        reads.push({ during, read, retired, markers: docs.markers.size });
      } finally {
        inside = false;
      }
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      if (!inside && url.hostname === "docs.googleapis.com") {
        if (url.pathname.endsWith(":batchUpdate") &&
            (await request.clone().text()).includes("deleteNamedRange")) {
          cleaning = true;
          await readDuring("cleanup", await record(facet, appended) === null);
        } else if (cleaning && request.method === "GET" && !url.searchParams.has("fields")) {
          cleaning = false;
          await readDuring("refresh");
        }
      }
      return model(input, init);
    });

    expect(await hooks().applyAction(facet, appended)).toBeNull();
    // The record goes before the marker does; each read shows the append once and the
    // replacement still queued.
    expect(reads.map(({ during, retired, markers }) => ({ during, retired, markers }))).toEqual([
      { during: "cleanup", retired: true, markers: 1 },
      { during: "refresh", retired: undefined, markers: 0 },
    ]);
    for (let { read } of reads) {
      expect(occurrences(read, "Appended")).toBe(1);
      expect(read).toContain("Final");
    }
    expect((await record(facet, replaced))?.state).toBe("pending");
    expect(await hooks().applyAction(facet, replaced)).toBeNull();
    expect(occurrences(docs.text(), "Appended")).toBe(1);
    expect(docs.text()).toContain("Final");
  });

  it("settles from its receipt an edit whose approval ended before its record was retired", async () => {
    let docs = draft();
    let facet = "drive-receipt-crash";
    let id = await hooks().submitAppend(facet, "Once");
    let { writeId } = (await record(facet, id))!.action.payload.change;
    // The write landed with its marker and its receipt was recorded; the activation ended there.
    docs.setText(MAIN_TAB, "Draft\nOnce");
    docs.addMarker(`gadgets-write-${writeId}`, "marker-landed");
    await rawHooks().writeDriveStored(
      `drive:${facet}`, DRIVE_DOC, RECEIPT, JSON.stringify({ actionId: id, markerId: "marker-landed" }));
    await rawHooks().restartDrive(`drive:${facet}`);

    expect(await hooks().applyAction(facet, id)).toBeNull();
    // Nothing written again, and its marker deleted only once the record was retired.
    expect(docs.contentBatches).toBe(0);
    expect(docs.deletedMarkerIds).toEqual(["marker-landed"]);
    expect(await record(facet, id)).toBeNull();
    expect(await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT)).toBeNull();
    expect(docs.text()).toBe("Draft\nOnce");
  });

  it("keeps a receipt whose marker cleanup failed for the next edit to settle", async () => {
    let docs = draft();
    docs.cleanupFailures = 1;
    let facet = "drive-receipt-cleanup";
    let first = await hooks().submitAppend(facet, "first");
    // Queued before the first applies, so no session starts while no edit of the Doc waits.
    let second = await hooks().submitAppend(facet, "second");
    expect(await hooks().applyAction(facet, first)).toBeNull();
    expect(JSON.parse((await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT))!))
      .toMatchObject({ actionId: first });
    expect(docs.markers.size).toBe(1);

    expect(await hooks().applyAction(facet, second)).toBeNull();
    expect(docs.markers.size).toBe(0);
    expect(docs.maxMarkerCount).toBe(1);
    expect(await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT)).toBeNull();
    expect(docs.text()).toContain("first");
    expect(docs.text()).toContain("second");
  });

  // A receipt left behind names a marker whose deletion failed: the next edit of the Doc deletes it.
  it("keeps a receipt across sessions with no edit of its Doc, for the next edit to settle", async () => {
    draft();
    let facet = "drive-receipt-sweep";
    let receipt = JSON.stringify({ actionId: 999, markerId: "marker-old" });
    await rawHooks().writeDriveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT, receipt);
    await hooks().readContent(facet);
    await hooks().readContent(facet);
    expect(await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT)).toBe(receipt);

    let id = await hooks().submitAppend(facet, "next");
    expect(await hooks().applyAction(facet, id)).toBeNull();
    expect(await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, RECEIPT)).toBeNull();
  });

  // The engine's run holds the write with a promise the test releases, which hangs a Drive binding's
  // apply in this harness; a timer slows it here instead, with the second approval sent meanwhile.
  it("holds a second approval of one edit behind the first, the write slowed", async () => {
    let docs = draft();
    let facet = "drive-overlap";
    let id = await hooks().submitAppend(facet, "first");
    let model = globalThis.fetch;
    let write: "unsent" | "sending" | "sent" = "unsent";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).pathname.endsWith(":batchUpdate") && write === "unsent") {
        write = "sending";
        await scheduler.wait(100);
        let response = await model(input, init);
        write = "sent";
        return response;
      }
      return model(input, init);
    });
    let first = hooks().applyAction(facet, id);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.waitUntil(() => write !== "unsent" || settled, { interval: 1, timeout: 5000 });
    // An approval that failed before writing says why, rather than timing out.
    if (write === "unsent") expect(await first).toBeNull();
    let second = hooks().applyAction(facet, id);
    // The second approval is sent while the first's write is in flight.
    expect(write).toBe("sending");

    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(docs.contentBatches).toBe(1);
    expect(docs.text().match(/first/g)).toHaveLength(1);
    expect(docs.markers.size).toBe(0);
  });

  // The first edit's check of the file is slowed: the second, sent behind it, still takes its turn
  // after it, and is prepared with the first queued.
  it("queues edits in the order they were sent, the first's proof slowed", async () => {
    draft();
    let facet = "drive-doc-order";
    let model = globalThis.fetch;
    let proofs = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).pathname.startsWith("/batch/") && proofs++ === 0) {
        await scheduler.wait(50);
      }
      return model(input, init);
    });
    let { outcomes, submitted } = await rawHooks().callDriveNativeTwice(
      `drive:${facet}`, DRIVE_DOC, "openGoogleDoc", "doc-1",
      ["appendText", "one"], ["appendText", "two"]);

    expect(outcomes).toEqual([{}, {}]);
    expect(proofs).toBe(2);
    expect(submitted.map(({ actionId }) => actionId)).toEqual([1, 2]);
    let read = await hooks().readContent(facet);
    expect(read.indexOf("one")).toBeGreaterThan(-1);
    expect(read.indexOf("two")).toBeGreaterThan(read.indexOf("one"));
  });

  it("queues a write of one tab while a read of another drops an edit that tab no longer takes", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "shared");
    docs.addTab("details", "Details", MAIN_TAB, "shared");
    let drive = new DriveFiles({
      [ROOT]: { name: "Reports", mimeType: FOLDER_MIME, parents: ["my-root"] },
      "doc-1": { name: "Test document", mimeType: DRIVE_DOC_MIME, parents: [ROOT] },
    });
    serveFakes([drive, docsProvider(docs)]);
    let facet = "drive-doc-other-tab-dropped";
    let stale = await rawHooks().callDriveNative(
      `drive:${facet}`, FOLDER, "openGoogleDoc", "doc-1", "replaceText",
      ["shared", "changed", "details"]);
    expect(stale.error).toBeUndefined();
    // A collaborator leaves that edit nothing to replace, and no read has seen it.
    docs.externalEdit("details", "other text");
    passSnapshotTtl();

    // Holds the read at its first proof of the file, and the write at the proof that follows its
    // check of the queue.
    let model = globalThis.fetch;
    let held = { read: Promise.withResolvers<void>(), write: Promise.withResolvers<void>() };
    let released = { read: Promise.withResolvers<void>(), write: Promise.withResolvers<void>() };
    let awaited: "read" | "fetch" | "write" | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      if (awaited === "fetch") {
        if (url.hostname === "docs.googleapis.com" && request.method === "GET") awaited = "write";
      } else if (awaited && url.pathname.startsWith("/batch/")) {
        let call = awaited;
        awaited = undefined;
        held[call].resolve();
        await released[call].promise;
      }
      return model(input, init);
    });
    let state = async () => (await record(facet, stale.actionId!, FOLDER))?.state;

    let reading = Promise.resolve(rawHooks().callDriveNativeAfter(
      `drive:${facet}`, FOLDER, "openGoogleDoc", "doc-1", "getContent", ["details"], [],
      async () => { awaited = "read"; }));
    await held.read.promise;
    awaited = "fetch";
    let writing = Promise.resolve(rawHooks().callDriveNative(
      `drive:${facet}`, FOLDER, "openGoogleDoc", "doc-1", "replaceText",
      ["shared", "mine", MAIN_TAB]));
    await held.write.promise;
    // The write's check replayed its own tab alone: the other tab's edit is still queued.
    expect(await state()).toBe("pending");

    // The read replays the other tab while the write awaits its authorization.
    released.read.resolve();
    expect((await reading).value).toBe("other text\n");
    expect(await state()).toBe("failed");
    released.write.resolve();
    let queued = await writing;
    expect(queued.error).toBeUndefined();
    expect(queued.actionId).toBe(stale.actionId! + 1);
  });

  it("refuses every write of a Doc that left the folder before any Docs request", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Draft");
    let drive = new DriveFiles({
      [ROOT]: { name: "Reports", mimeType: FOLDER_MIME, parents: ["my-root"] },
      "doc-1": { name: "Test document", mimeType: DRIVE_DOC_MIME, parents: [ROOT] },
    });
    serveFakes([drive, docsProvider(docs)]);
    let facet = `drive:drive-doc-left-folder`;
    let args: Record<string, unknown[]> = {
      replaceText: ["Draft", "Final"],
      appendText: ["More"],
      // Each with arguments its own check accepts, so that the refusal is the scope's.
      insertTable: [{ rows: 1, columns: 1 }],
      insertTableRows: [{ table: 0 }],
      insertTableColumns: [{ table: 0 }],
      deleteTableRows: [{ table: 0, at: 0 }],
      deleteTableColumns: [{ table: 0, at: 0 }],
      deleteTable: [0],
      setTableCellStyle: [{ table: 0, row: 0, column: 0, style: { background: "#ffcc00" } }],
      setTableColumnWidths: [{ table: 0, width: 100 }],
      setTableRowHeights: [{ table: 0, height: 20 }],
      mergeTableCells: [{ table: 0, row: 0, column: 0, rows: 1, columns: 2 }],
      unmergeTableCells: [{ table: 0, row: 0, column: 0 }],
    };
    let reads = new Set(["constructor", "getMetadata", "listTabs", "getContent"]);
    let writes = Object.getOwnPropertyNames(GoogleDocEditSessionImpl.prototype)
      .filter(name => !reads.has(name));
    expect(writes.toSorted()).toEqual(Object.keys(args).toSorted());

    for (let method of writes) {
      let refused = await rawHooks().callDriveNativeAfter(
        facet, FOLDER, "openGoogleDoc", "doc-1", method, args[method], [],
        async () => { drive.files.get("doc-1")!.parents = ["elsewhere"]; });
      drive.files.get("doc-1")!.parents = [ROOT];
      expect(refused.error, method).toBe(OUT_OF_SCOPE);
      expect(refused.actionId, method).toBeUndefined();
      expect(docs.fetches, method).toBe(0);
    }

    // One queued before the file left fails for good at approval, with nothing sent.
    let queued = await rawHooks().callDriveNative(
      facet, FOLDER, "openGoogleDoc", "doc-1", "appendText", ["More"]);
    expect(queued.error).toBeUndefined();
    let fetched = docs.fetches;
    drive.files.get("doc-1")!.parents = ["elsewhere"];
    expect(await rawHooks().applyDrive(facet, FOLDER, queued.actionId!)).toBe(OUT_OF_SCOPE);
    expect(await rawHooks().applyDrive(facet, FOLDER, queued.actionId!)).toBe(OUT_OF_SCOPE);
    expect(docs.fetches).toBe(fetched);
    expect(docs.contentBatches).toBe(0);
  });

  it("opens a Doc with no comment method: the binding's own comment writes reach it", async () => {
    draft();
    for (let [method, args] of [
      ["listComments", []], ["comment", ["Hi", { quote: "Draft" }]],
      ["suggestEdit", ["Draft", "Final"]], ["reply", ["c1", "Hi"]], ["resolve", ["c1"]],
    ] as const) {
      let called = await rawHooks().callDriveNative(
        "drive:drive-doc-comments", DRIVE_DOC, "openGoogleDoc", "doc-1", method, [...args]);
      expect(called.error, method).toMatch(`does not implement the method "${method}"`);
    }
  });

  it("holds an edit through Drive to 100 KiB, where the Doc's own binding takes more", async () => {
    draft();
    let big = "x".repeat(60_000);
    await expect(hooks().submitAppend("drive-doc-big", big)).rejects.toThrow(
      /^This change is too large to queue \(\d+ bytes, limit 102400\)\. Split it up\.$/);
    expect(await rawHooks().submitAppend("standalone-doc-big", big)).toBeTypeOf("number");
  });

  /** A numbered list of three items, the second and third padded to `second` and `third` characters. */
  function paddedList(second: number, third: number) {
    let docs = new DocsModel();
    let item = `b${"y".repeat(second)}`;
    docs.setNumberedList(MAIN_TAB, ["a", item, `c${"z".repeat(third)}`]);
    docs.install();
    return { docs, item };
  }

  // Replacing a numbered item by an item and a paragraph renumbers the item after it, so the card
  // shows that item too. Only that is stored beside the edit: its own texts are stored once.
  it("stores with an edit through Drive what its card shows around it, never the edit's texts again", async () => {
    let { item } = paddedList(44_000, 0);
    let facet = "drive-doc-card-context";
    let content = await hooks().readContent(facet);
    let third = content.slice(content.indexOf(item) + item.length).trimEnd();
    expect(third).toMatch(/^\n\d+\. c$/);

    let actionId = await hooks().submitReplace(facet, item, "b\n\nplain");
    let fields = await hooks().lastActionFields;

    let { change } = (await record(facet, actionId))!.action.payload as unknown as {
      change: { oldMarkdown: string; newMarkdown: string; display: Record<string, unknown> };
    };
    // The edit alone is close to what one record may hold.
    expect(2 * JSON.stringify({ ...change, display: undefined }).length).toBeGreaterThan(88_000);
    let rendered = (await hooks().readContent(facet)).slice(content.indexOf(item)).trimEnd();
    expect(rendered).toMatch(/^b\n\nplain\n\n\d+\. c$/);
    expect(change.display).toEqual({
      tab: `"Main" (${MAIN_TAB})`, context: { before: "", after: third }, rendered,
    });
    expect(fields).toEqual([
      cardField("Old", item + third, "markdown"),
      cardField("Requested New", `b\n\nplain${third}`, "markdown"),
      cardField("New", rendered, "markdown"),
    ]);
  });

  // The third item is shown twice, as it reads before and after, and both are in the record.
  it("refuses through Drive an edit whose record passes 100 KiB with what its card shows", async () => {
    let { item } = paddedList(30_000, 12_000);
    let facet = "drive-doc-card-too-big";
    let content = await hooks().readContent(facet);
    expect(2 * JSON.stringify({ oldMarkdown: item, newMarkdown: "b\n\nplain" }).length)
      .toBeLessThan(70_000);

    await expect(hooks().submitReplace(facet, item, "b\n\nplain")).rejects.toThrow(
      /^This change is too large to queue \(\d+ bytes, limit 102400\)\. Split it up\.$/);

    expect(await hooks().lastActionDescription).toBe("");
    expect(await rawHooks().driveStoredKeys(`drive:${facet}`, DRIVE_DOC, "drive:action:")).toEqual([]);
    expect(await hooks().readContent(facet)).toBe(content);
    // The Doc's own binding stores the same edit.
    expect(await rawHooks().submitReplace("standalone-doc-card-big", item, "b\n\nplain"))
      .toBeTypeOf("number");
  });

  it("fails at the next read an edit left behind a rejected one that it was built on", async () => {
    draft();
    let facet = "drive-doc-behind-rejected";
    let first = await hooks().submitReplace(facet, "Draft", "Final");
    let second = await hooks().submitReplace(facet, "Final", "Done");
    let third = await hooks().submitAppend(facet, "More");
    expect(await hooks().readContent(facet)).toBe("Done\n\nMore\n");

    expect(await hooks().rejectAction(facet, first)).toEqual({ restart: true });
    // Nothing is replayed at the rejection: no document is in hand there.
    expect((await record(facet, second))!.state).toBe("pending");

    expect(await hooks().readContent(facet)).toBe("Draft\n\nMore\n");
    expect(await record(facet, second)).toMatchObject({
      state: "failed",
      error: droppedByRead(
        `replaceText: oldMarkdown was not found in the current simulated tab "${MAIN_TAB}". ` +
        `Make sure the text exactly matches content returned by getContent("${MAIN_TAB}").`),
    });
    expect((await record(facet, third))!.state).toBe("pending");
  });

  // The approval reads the document again once its write has landed and replays what is still
  // queued over it, so an edit that no longer applies is failed there, before any read.
  it("fails at an approval an edit queued behind it that the document no longer takes", async () => {
    let docs = draft();
    let facet = "drive-doc-behind-approved";
    let first = await hooks().submitAppend(facet, "More");
    let second = await hooks().submitReplace(facet, "Draft", "Final");
    let third = await hooks().submitAppend(facet, "Last");

    // A collaborator's edit removes what the second edit quotes.
    docs.externalEdit(MAIN_TAB, "Other");
    expect(await hooks().applyAction(facet, first)).toBeNull();

    expect(await record(facet, second)).toMatchObject({
      state: "failed",
      error: `Pending Google Doc edits could not be replayed after edit ${first} was applied: ` +
        `replaceText: oldMarkdown was not found in the current simulated tab "${MAIN_TAB}". ` +
        `Make sure the text exactly matches content returned by getContent("${MAIN_TAB}"). ` +
        "This edit was dropped from the document. Reject it and retry if it is still needed.",
    });
    expect((await record(facet, third))!.state).toBe("pending");
    expect(await hooks().readContent(facet)).toBe("Other\n\nMore\n\nLast\n");
  });

  it("shows a landed write once in the reads around its approval", async () => {
    let docs = draft();
    let facet = "drive-doc-fold-across-write";
    let first = await hooks().submitAppend(facet, "First");
    let second = await hooks().submitAppend(facet, "Second");
    let pending = "Draft\n\nFirst\n\nSecond\n";
    expect(await hooks().readContent(facet)).toBe(pending);

    expect(await hooks().applyAction(facet, first)).toBeNull();
    // The write is in the document and no longer in the queue: folded again, not replayed over.
    expect(docs.text()).toBe("Draft\nFirst");
    expect(await hooks().readContent(facet)).toBe(pending);
    expect(await hooks().applyAction(facet, second)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(pending);
    expect(docs.contentBatches).toBe(2);
  });

  // The binding keeps one source for each document: the sessions it opens on the document read
  // one snapshot, and so share one copy of it.
  it("reads a document once for the sessions that open it within its time to live", async () => {
    let docs = draft();
    let facet = "drive-doc-source-reads";
    for (let session = 0; session < 3; session++) {
      expect(await hooks().readContent(facet)).toBe("Draft\n");
    }
    expect(docs.documentFetches).toBe(1);
  });

  /**
   * One document more than a binding keeps sources of, `doc-1` first, each reading its own
   * number, and the calls of a fresh session of each through the account's binding `facet`.
   */
  function documentsPastSources(facet: string) {
    let models = Array.from({ length: 5 }, (_, at) => {
      let docs = new DocsModel();
      docs.documentId = `doc-${at + 1}`;
      docs.setText(MAIN_TAB, `Text ${at + 1}`);
      return docs;
    });
    let drive = new DriveFiles(Object.fromEntries(models.map(({ documentId }) =>
      [documentId, { name: documentId, mimeType: DRIVE_DOC_MIME, parents: ["my-root"] }])));
    serveFakes([drive, docsProvider(...models)]);
    let call = (docs: DocsModel, method: string, ...args: unknown[]) => rawHooks().callDriveNative(
      facet, ACCOUNT, "openGoogleDoc", docs.documentId, method, args);
    return { models, call };
  }

  it("keeps the sources of the documents opened most recently", async () => {
    let { models, call } = documentsPastSources("drive:drive-doc-sources-kept");
    let fetches = () => models.map(docs => docs.documentFetches);
    for (let [at, docs] of models.entries()) {
      expect((await call(docs, "getContent")).value).toBe(`Text ${at + 1}\n`);
    }
    expect(fetches()).toEqual([1, 1, 1, 1, 1]);

    // The last is read from the source the binding kept, and the first, whose source went when
    // the last was opened, is fetched; that lets go of the second's.
    await call(models[4], "getContent");
    expect(fetches()).toEqual([1, 1, 1, 1, 1]);
    await call(models[0], "getContent");
    expect(fetches()).toEqual([2, 1, 1, 1, 1]);
    await call(models[1], "getContent");
    expect(fetches()).toEqual([2, 2, 1, 1, 1]);

    // Opening a document whose source is held makes it the most recent: the fourth is read from
    // its source, so the third, fetched after it, lets go of the fifth's and not of the fourth's.
    await call(models[3], "getContent");
    await call(models[2], "getContent");
    expect(fetches()).toEqual([2, 2, 2, 1, 1]);
    await call(models[3], "getContent");
    expect(fetches()).toEqual([2, 2, 2, 1, 1]);
  });

  // The binding goes on counting the writes of a document whose source it let go: a session
  // still open on that source does not reuse a snapshot from before a write that landed since.
  it("reads again a document a write landed in after the binding let its source go", async () => {
    let facet = "drive:drive-doc-sources-write";
    let { models, call } = documentsPastSources(facet);
    let [first, ...others] = models;
    let one = (await call(first, "appendText", "One")).actionId!;
    let two = (await call(first, "appendText", "Two")).actionId!;
    expect((await call(first, "appendText", "Three")).error).toBeUndefined();
    let pending = "Text 1\n\nOne\n\nTwo\n\nThree\n";

    // One write is counted and a snapshot fetched after it, within its time to live from here on.
    expect(await rawHooks().applyDrive(facet, ACCOUNT, one)).toBeNull();
    expect((await call(first, "getContent")).value).toBe(pending);

    // The newest edit queued stays the same one, so only the second write counted tells the
    // session that its snapshot is behind the document.
    let read = await rawHooks().callDriveNativeAfter(
      facet, ACCOUNT, "openGoogleDoc", first.documentId, "getContent", [], [], async () => {
        for (let docs of others) await call(docs, "getContent");
        expect(await rawHooks().applyDrive(facet, ACCOUNT, two)).toBeNull();
      });
    expect(first.text()).toBe("Text 1\nOne\nTwo");
    expect(read.value).toBe(pending);
  });

  // A binding's sessions on a Doc share its source: one left open reads what later sessions read.
  it("reads the same on a session left open while a queue of text and table changes over two tabs is approved and rejected", async () => {
    let docs = draft("Intro");
    const SECOND = "second";
    docs.addTab(SECOND, "Second", MAIN_TAB);
    docs.setBody(SECOND, buildTab([para("Aside"), grid(["Task", "Owner"]), para("End")]).body);
    let facet = "drive-doc-held-session";
    let tabs = [MAIN_TAB, SECOND];
    /** Both tabs as the session left open reads them, which every other session reads the same. */
    let read = async () => {
      let held = [];
      for (let tab of tabs) {
        held.push(await rawHooks().readHeldDoc(tab));
        expect(held.at(-1)).toBe(await hooks().readContent(facet, tab));
      }
      return held;
    };
    let first = tableOf([["Task", "Owner"], ["Fix login", "Ana"]]);

    await rawHooks().holdDoc(`drive:${facet}`);
    try {
      expect(await read()).toEqual(["Intro\n", `Aside\n\n${tableOf([["Task", "Owner"]])}\n\nEnd\n`]);
      let opening = await hooks().submitReplace(facet, "Intro", "Opening", MAIN_TAB);
      let row = await edit(
        facet, "insertTableRows", { table: 0, cells: [["Fix login", "Ana"]] }, SECOND);
      let table = await edit(
        facet, "insertTable", { rows: 1, columns: 2, cells: [["Risk", "Level"]], after: "End" },
        SECOND);
      expect(table.returned).toBe(1);
      let aside = await hooks().submitAppend(facet, "Two", SECOND);
      let risk = await edit(
        facet, "insertTableRows", { table: 1, cells: [["Outage", "High"]] }, SECOND);
      let shade = await edit(facet, "setTableCellStyle",
        { table: 1, row: 0, column: 0, style: { background: "#ffcc00" } }, SECOND);
      // Replaces text the first replacement wrote.
      let start = await hooks().submitReplace(facet, "Opening", "Start", MAIN_TAB);
      let one = await hooks().submitAppend(facet, "One", MAIN_TAB);
      /** The second tab's new table as it reads with its row and its cell's shading. */
      let shaded = /<td style="[^"]*#ffcc00[^"]*"><p>Risk<\/p><\/td>\n {4}<td[^>]*><p>Level<\/p><\/td>\n {2}<\/tr>\n {2}<tr>\n {4}<td[^>]*><p>Outage<\/p><\/td>/;
      let queued = await read();
      expect(queued[0]).toBe("Start\n\nOne\n");
      expect(queued[1]).toContain(`Aside\n\n${first}\n\nEnd\n`);
      expect(queued[1]).toMatch(shaded);
      expect(queued[1].endsWith("Two\n")).toBe(true);

      // A table change written with the session open: the replay after it keeps those behind.
      expect(await hooks().applyAction(facet, opening)).toBeNull();
      expect(await read()).toEqual(queued);
      expect(await hooks().applyAction(facet, row.actionId)).toBeNull();
      expect(await read()).toEqual(queued);

      // The append changes no table, so nothing queued behind it is failed.
      expect(await hooks().rejectAction(facet, aside)).toEqual({ restart: true });
      expect((await record(facet, risk.actionId))!.state).toBe("pending");
      expect((await record(facet, shade.actionId))!.state).toBe("pending");
      let withoutAppend = await read();
      expect(withoutAppend[1]).toMatch(shaded);
      expect(withoutAppend[1]).not.toContain("Two");

      // The new table goes, and with it the two changes that named it.
      expect(await hooks().rejectAction(facet, table.actionId)).toEqual({ restart: true });
      for (let [id, method] of [
        [risk.actionId, "insertTableRows"], [shade.actionId, "setTableCellStyle"],
      ] as const) {
        let failed = (await record(facet, id))!;
        expect(failed.state).toBe("failed");
        expect(failed.error).toContain(gate(method));
        expect(await hooks().applyAction(facet, id)).toContain(gate(method));
      }
      expect((await record(facet, start))!.state).toBe("pending");
      expect((await record(facet, one))!.state).toBe("pending");
      expect(docs.contentBatches).toBe(2);
      // The queue now holds what will be applied.
      let settled = ["Start\n\nOne\n", `Aside\n\n${first}\n\nEnd\n`];
      expect(await read()).toEqual(settled);

      for (let actionId of [start, one]) {
        expect(await hooks().applyAction(facet, actionId)).toBeNull();
        expect(await read()).toEqual(settled);
      }
      expect(docs.contentBatches).toBe(4);
      // A connection that queued nothing reads the document so.
      for (let [at, tab] of tabs.entries()) {
        expect(await hooks().readContent("drive-doc-held-quiet", tab)).toBe(settled[at]);
      }
    } finally {
      await rawHooks().releaseDoc();
    }
  });

  // A Drive rejection replays nothing, as no document is in hand, so it fails the changes behind it
  // that named a table as it left it; a bound Doc replays and keeps those that still apply.
  it("fails the table changes queued behind a rejected table change, and none behind a rejected text edit", async () => {
    let docs = docsWithBody(tableBody());
    let row = { table: 0, cells: [["Ship docs", "Open"]] };
    let withRow = `Before\n\n${tableOf([...TABLE_ROWS, ["Ship docs", "Open"]])}\n\nAfter\n`;

    let facet = "drive-doc-table-reject";
    let above = await edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["New"]], after: "Before" });
    let rows = await edit(facet, "insertTableRows", { ...row, table: 1 });
    expect(await hooks().rejectAction(facet, above.actionId)).toEqual({ restart: true });
    let failed = (await record(facet, rows.actionId))!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain(gate("insertTableRows"));
    expect(await hooks().applyAction(facet, rows.actionId)).toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
    expect(await hooks().readContent(facet)).toBe(TABLE_CONTENT);

    // The failed change no longer shows in what a read returns: dismissing it fails nothing
    // queued behind it.
    let behindFailed = await edit(facet, "insertTableRows", row);
    await hooks().rejectAction(facet, rows.actionId);
    expect((await record(facet, behindFailed.actionId))!.state).toBe("pending");

    // A paragraph's text is no table's: the row behind it still names its table as it reads.
    let text = "drive-doc-table-reject-text";
    let replaced = await hooks().submitReplace(text, "Before", "Above");
    let behindText = await edit(text, "insertTableRows", row);
    expect(await hooks().rejectAction(text, replaced)).toEqual({ restart: true });
    expect((await record(text, behindText.actionId))!.state).toBe("pending");
    expect(await hooks().applyAction(text, behindText.actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(withRow);

    // Nor does a table's look change how it is named.
    docs = docsWithBody(tableBody());
    let look = "drive-doc-table-reject-look";
    let width = await edit(look, "setTableColumnWidths", { table: 0, width: 100 });
    let behindLook = await edit(look, "insertTableRows", row);
    expect(await hooks().rejectAction(look, width.actionId)).toEqual({ restart: true });
    expect((await record(look, behindLook.actionId))!.state).toBe("pending");
    expect(await hooks().applyAction(look, behindLook.actionId)).toBeNull();
    expect(docTabToMarkdown(docs.bodyTab()).markdown).toBe(withRow);
  });

  /**
   * A Doc in the folder `ROOT` with the table of `tableBody()`, and, queued through the folder's
   * binding, a replacement of a cell's text and a row for the same table behind it.
   */
  async function queueInFolder(facet: string) {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, tableBody());
    let drive = new DriveFiles({
      [ROOT]: { name: "Reports", mimeType: FOLDER_MIME, parents: ["my-root"] },
      "doc-1": { name: "Test document", mimeType: DRIVE_DOC_MIME, parents: [ROOT] },
    });
    serveFakes([drive, docsProvider(docs)]);
    let queue = (method: string, ...args: unknown[]) => rawHooks().callDriveNative(
      `drive:${facet}`, FOLDER, "openGoogleDoc", "doc-1", method, args);
    let cell = await queue("replaceText", "<p>Open</p>", "<p>Done</p>");
    let rows = await queue("insertTableRows", { table: 0, cells: [["Ship docs", "Open"]] });
    expect([cell.error, rows.error]).toEqual([undefined, undefined]);
    return { docs, drive, cell: cell.actionId!, rows: rows.actionId! };
  }

  /**
   * What an approval of `cell` refused for good leaves, having answered `answer`: both records
   * failed, the row for the change it stood behind, and no Docs request since `fetched`.
   */
  async function expectRefusedWithRowBehind(
    facet: string, queued: Awaited<ReturnType<typeof queueInFolder>>, answer: string | null,
    fetched: number,
  ) {
    let { docs, drive, cell, rows } = queued;
    expect(answer).toBe(OUT_OF_SCOPE);
    expect((await record(facet, cell, FOLDER))!.state).toBe("failed");
    let behind = (await record(facet, rows, FOLDER))!;
    expect(behind.state).toBe("failed");
    expect(behind.error).toContain(gate("insertTableRows"));
    expect(docs.fetches).toBe(fetched);
    expect(docs.contentBatches).toBe(0);

    // Back within reach, the row is not approved over a table the replacement never changed.
    drive.files.get("doc-1")!.parents = [ROOT];
    expect(await rawHooks().applyDrive(`drive:${facet}`, FOLDER, rows))
      .toContain(gate("insertTableRows"));
    expect(docs.contentBatches).toBe(0);
  }

  it("fails the table changes behind an edit refused before its approval ran", async () => {
    let facet = "drive-doc-refused-before";
    let queued = await queueInFolder(facet);
    let { docs, drive, cell } = queued;
    let batches = drive.batches().length;
    let fetched = docs.fetches;

    drive.files.get("doc-1")!.parents = ["elsewhere"];
    let answer = await rawHooks().applyDrive(`drive:${facet}`, FOLDER, cell);

    // Refused by the one scope read made before the action set claims the record.
    expect(drive.batches()).toHaveLength(batches + 1);
    await expectRefusedWithRowBehind(facet, queued, answer, fetched);
  });

  it("fails the table changes behind an edit refused inside its approval", async () => {
    let facet = "drive-doc-refused-inside";
    let queued = await queueInFolder(facet);
    let { docs, drive, cell } = queued;
    let batches = drive.batches().length;
    let fetched = docs.fetches;

    // The file leaves between the approval's two scope reads: the first answers within reach,
    // so the action set runs the edit, whose own proof then refuses.
    let first = drive.holdNextBatch();
    let applying = Promise.resolve(rawHooks().applyDrive(`drive:${facet}`, FOLDER, cell));
    await first.reached;
    let second = drive.holdNextBatch();
    first.release();
    await second.reached;
    drive.files.get("doc-1")!.parents = ["elsewhere"];
    second.release();
    let answer = await applying;

    expect(drive.batches()).toHaveLength(batches + 2);
    await expectRefusedWithRowBehind(facet, queued, answer, fetched);
  });

  // Through Drive the read preparing an edit, which names the tab, authorizes the position
  // insertTable() returns; a bound Doc authorizes a read of the position alone.
  it("authorizes the read that prepares a table, and no second read of its position", async () => {
    docsWithBody(tableBody());
    let facet = "drive-doc-table-reads";
    driveFacets.add(`drive:${facet}`);

    let added = await rawHooks().submitEdit(
      `drive:${facet}`, "insertTable", [{ rows: 1, columns: 1, cells: [["New"]] }]);
    expect(await rawHooks().lastObservations)
      .toEqual([DRIVE_OPEN, `Read tab "Main" (${MAIN_TAB}) to change it.`]);
    expect((await rawHooks().lastObservations)[1]).toMatch(DRIVE_PREPARE);
    let shown = [...(await hooks().readContent(facet)).matchAll(/<table>[\s\S]*?<\/table>/g)];
    expect(shown[added.returned!][0]).toBe(tableOf([["New"]]));

    // Refused, the read that prepares any edit queues nothing.
    let refused = "drive-doc-table-reads-refused";
    driveFacets.add(`drive:${refused}`);
    for (let [method, ...args] of [
      ["insertTable", { rows: 1, columns: 1 }], ["insertTableRows", { table: 0 }],
      ["appendText", "added"],
    ] as const) {
      await expect(Promise.resolve(rawHooks().submitEdit(
        `drive:${refused}`, method, args, { refuseRead: true },
      )), method).rejects.toThrow("Reads of this document are refused.");
      expect(await rawHooks().lastActionDescription, method).toBe("");
    }
    expect(await rawHooks().driveStoredKeys(`drive:${refused}`, DRIVE_DOC, "drive:action:"))
      .toEqual([]);
  });

  it("keeps a deployment's read-only setting: no editable Doc, no kind, and a queued edit waits", async () => {
    let docs = draft();
    let facet = "drive-doc-read-only-deployment";
    let id = await hooks().submitAppend(facet, "More");
    await rawHooks().restartDrive(`drive:${facet}`);

    let opened = await rawHooks().callDriveNative(
      `drive:${facet}`, READ_ONLY_DEPLOYMENT, "openGoogleDoc", "doc-1", "appendText", ["Again"]);
    expect(opened.error).toMatch('does not implement the method "appendText"');
    expect(await rawHooks().driveAutoApprovable(`drive:${facet}`, READ_ONLY_DEPLOYMENT)).toEqual([]);
    expect(await rawHooks().applyDrive(`drive:${facet}`, READ_ONLY_DEPLOYMENT, id))
      .toBe(DEPLOYMENT_READ_ONLY);
    expect(docs.contentBatches).toBe(0);

    await rawHooks().restartDrive(`drive:${facet}`);
    expect(await hooks().applyAction(facet, id)).toBeNull();
    expect(docs.text()).toContain("More");
  });

  it("keeps what a Doc's queued edits made when a session that cannot edit reads it", async () => {
    draft();
    let facet = "drive-doc-read-only-rows";
    for (let text of ["One", "Two", "Three"]) {
      await hooks().submitAppend(facet, text);
      await hooks().readContent(facet);
    }
    let rows = () => rawHooks().driveDocStoreRows(`drive:${facet}`, DRIVE_DOC, "doc-1");
    let queued = await rows();
    expect(queued.doc_result).toBe(3);
    await rawHooks().restartDrive(`drive:${facet}`);

    // The read fetches, and its keep sweeps with the three edits still pending.
    let read = await rawHooks().callDriveNative(
      `drive:${facet}`, READ_ONLY_DEPLOYMENT, "openGoogleDoc", "doc-1", "getContent", []);
    expect(read.error).toBeUndefined();
    expect(await rows()).toEqual(queued);

    // Once writes return, the queue is read from what was stored: no result is made again.
    await rawHooks().restartDrive(`drive:${facet}`);
    let before = { ...docStoreCost };
    expect(await hooks().readContent(facet)).toBe("Draft\n\nOne\n\nTwo\n\nThree\n");
    expect(docStoreCost.resultsStored - before.resultsStored).toBe(0);
    expect(docStoreCost.resultsFound - before.resultsFound).toBe(3);
  });

  it("keeps two Docs' edits, order and receipts apart on one binding", async () => {
    let one = new DocsModel();
    one.setText(MAIN_TAB, "One");
    one.cleanupFailures = 1;
    let two = new DocsModel();
    two.documentId = "doc-2";
    two.setText(MAIN_TAB, "Two");
    let drive = new DriveFiles({
      "doc-1": { name: "First", mimeType: DRIVE_DOC_MIME, parents: ["my-root"] },
      "doc-2": { name: "Second", mimeType: DRIVE_DOC_MIME, parents: ["my-root"] },
    });
    serveFakes([drive, docsProvider(one, two)]);
    let facet = "drive:drive-two-docs";
    let queue = async (fileId: string, text: string) => (await rawHooks().callDriveNative(
      facet, ACCOUNT, "openGoogleDoc", fileId, "appendText", [text])).actionId!;
    let read = async (fileId: string) => (await rawHooks().callDriveNative(
      facet, ACCOUNT, "openGoogleDoc", fileId, "getContent", [])).value as string;
    let a1 = await queue("doc-1", "A1");
    let b1 = await queue("doc-2", "B1");
    let a2 = await queue("doc-1", "A2");
    expect([a1, b1, a2]).toEqual([1, 2, 3]);
    expect(await read("doc-2")).not.toContain("A1");
    expect(await read("doc-1")).not.toContain("B1");

    expect(await rawHooks().applyDrive(facet, ACCOUNT, a2)).toBe(THROUGH_DRIVE.outOfOrder(a1, a2));
    // The other Doc's earlier edit holds nothing back.
    expect(await rawHooks().applyDrive(facet, ACCOUNT, b1)).toBeNull();
    expect([one.contentBatches, two.contentBatches]).toEqual([0, 1]);
    expect(await rawHooks().applyDrive(facet, ACCOUNT, a1)).toBeNull();
    // The first Doc's marker cleanup failed: its receipt stays, and only its.
    expect(await rawHooks().driveStoredKeys(facet, ACCOUNT, "driveDocs:receipt:"))
      .toEqual(["driveDocs:receipt:doc-1"]);
    expect(await rawHooks().applyDrive(facet, ACCOUNT, a2)).toBeNull();
    expect(await rawHooks().driveStoredKeys(facet, ACCOUNT, "driveDocs:receipt:")).toEqual([]);
    expect(one.text()).toContain("A2");
    expect(two.text()).toContain("B1");
  });

  describe("the copy a Drive connection keeps of a Doc", () => {
    const SUB = "folder-sub";
    const OTHER = "folder-other";
    const INNER = "folder-inner";
    const OUTSIDE = "The requested file is outside this Drive binding.";
    const UNAVAILABLE = "The requested Drive file is unavailable to the connected account.";
    const READ_ONLY_FOLDER: Binding = { scope: { kind: "folder", folderId: ROOT } };

    /**
     * A Drive of a bound folder that holds two folders, one of which holds a third, with doc-1,
     * reading "Draft", in `parent`.
     */
    function library(parent: string = ROOT) {
      let docs = new DocsModel();
      docs.setText(MAIN_TAB, "Draft");
      let drive = new DriveFiles({
        "my-root": { name: "My Drive", mimeType: FOLDER_MIME, parents: [] },
        [ROOT]: { name: "Reports", mimeType: FOLDER_MIME, parents: ["my-root"] },
        [SUB]: { name: "Drafts", mimeType: FOLDER_MIME, parents: [ROOT] },
        [OTHER]: { name: "Final", mimeType: FOLDER_MIME, parents: [ROOT] },
        [INNER]: { name: "Notes", mimeType: FOLDER_MIME, parents: [SUB] },
        elsewhere: { name: "Elsewhere", mimeType: FOLDER_MIME, parents: ["my-root"] },
        "doc-1": { name: "Test document", mimeType: DRIVE_DOC_MIME, parents: [parent] },
      });
      serveFakes([drive, docsProvider(docs)]);
      /** Moves a file or a folder into folder `into`. */
      let move = (id: string, into: string) => { drive.files.get(id)!.parents = [into]; };
      return { docs, drive, move };
    }

    /** A connection over its own storage, reached as `binding` says, and what it stores of doc-1. */
    function connection(name: string, binding: Binding) {
      let facet = `drive:${name}`;
      driveFacets.add(facet);
      let call = (method: string, args: unknown[] = [], path: string[] = [], file = "doc-1") =>
        rawHooks().callDriveNative(facet, binding, "openGoogleDoc", file, method, args, path);
      return {
        facet, call,
        /** What a fresh session, opened through the folders of `path`, reads of `file`, or its refusal. */
        read: async (path: string[] = [], file = "doc-1") => {
          let { value, error } = await call("getContent", [], path, file);
          return error ?? value as unknown as string;
        },
        /** `read`, with `before` run between the Doc's open and its read. */
        readAfter: async (before: () => void, path: string[] = []) => {
          let { value, error } = await rawHooks().callDriveNativeAfter(
            facet, binding, "openGoogleDoc", "doc-1", "getContent", [], path, async () => before());
          return error ?? value as unknown as string;
        },
        head: () => rawHooks().driveDocStoreHead(facet, binding, "doc-1"),
        rows: (file = "doc-1") => rawHooks().driveDocStoreRows(facet, binding, file),
        tables: () => rawHooks().driveDocTables(facet, binding),
        /** Runs one statement on the connection's storage and answers its rows. */
        exec: (statement: string, ...bindings: SqlStorageValue[]) =>
          rawHooks().driveDocStoreExec(facet, binding, statement, ...bindings),
        apply: (id: number) => rawHooks().applyDrive(facet, binding, id),
        /** The copy as two states of it are compared: its record and the store's row counts. */
        stored: async () => ({
          head: await rawHooks().driveDocStoreHead(facet, binding, "doc-1"),
          rows: await rawHooks().driveDocStoreRows(facet, binding, "doc-1"),
        }),
      };
    }

    it.each([
      ["a read and write binding", FOLDER],
      ["a read-only connection", READ_ONLY_FOLDER],
    ])("stores the copy of a Doc opened through %s in the connection's storage, under the " +
        "file's id, once its read is authorized", async (name, binding) => {
      let { docs } = library();
      let files = connection(`drive-store-${name.length}`, binding);
      expect(await files.tables()).toEqual([]);
      expect(await files.read()).toBe("Draft\n");
      expect(await files.head()).toMatchObject({ stale: false, outline: [{ tabId: MAIN_TAB }] });
      expect(await files.rows()).toMatchObject({
        doc_copy: 1, doc_version: 1, "doc_copy of the file": 1, "doc_version of the file": 1,
      });
      expect(docs.documentFetches).toBe(1);
    });

    it("leaves no row of a Doc whose first read the scope check refuses", async () => {
      let { docs, move } = library();
      let files = connection("drive-store-refused-first", FOLDER);
      // In scope when the read begins, and out of it once the document has been fetched.
      let model = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init);
        if (new URL(request.url).hostname === "docs.googleapis.com") move("doc-1", "elsewhere");
        return model(request);
      });
      expect(await files.read()).toBe(OUTSIDE);
      expect(docs.documentFetches).toBe(1);
      let rows = await files.rows();
      expect(Object.keys(rows).length).toBeGreaterThan(0);
      expect(Object.values(rows).every(count => count === 0)).toBe(true);
      expect(await files.head()).toBeNull();
    });

    it("records the folder and the hour of a copy's last approved read", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      let now = Date.UTC(2026, 0, 1, 10, 20);
      vi.setSystemTime(now);
      library(SUB);
      let files = connection("drive-store-folder", FOLDER);
      expect(await files.read([SUB])).toBe("Draft\n");
      let head = await files.head();
      expect(head).toMatchObject({ folder: SUB, approvedAt: now - now % DOC_COPY_APPROVAL_GRAIN_MS });
      // The first read rendered the tab in its trial, which left no row; the read after it
      // stores that rendering, and one more says what the record says already.
      expect(await files.read([SUB])).toBe("Draft\n");
      vi.setSystemTime(now + 1_000);
      let stored = await files.stored();
      expect(await files.read([SUB])).toBe("Draft\n");
      expect(await files.stored()).toEqual(stored);

      // A connection bound to the file itself stands on no folder.
      let file = connection("drive-store-file", DRIVE_DOC);
      expect(await file.read()).toBe("Draft\n");
      let unplaced = await file.head();
      expect(unplaced?.approvedAt).toBe(now - now % DOC_COPY_APPROVAL_GRAIN_MS);
      expect("folder" in unplaced!).toBe(false);
    });

    it("creates no table on a connection that stored no Doc when an open is refused", async () => {
      let { move } = library();
      move("doc-1", "elsewhere");
      for (let [name, binding] of [["write", FOLDER], ["read", READ_ONLY_FOLDER]] as const) {
        let files = connection(`drive-store-no-table-${name}`, binding);
        expect(await files.tables()).toEqual([]);
        expect(await files.read()).toBe(OUTSIDE);
        expect(await files.tables()).toEqual([]);
      }
    });

    // The text a comment quotes, or a suggestion replaces, is looked for in the connection's
    // copy of the Doc: read where the binding's snapshot is inside its TTL, and otherwise
    // fetched, tried while the scope check is out and kept once the read is authorized.
    describe("the lookup of the text a comment or a suggestion quotes", () => {
      const QUOTING = [
        ["a comment", "comment", ["doc-1", "Really?", { quote: "Draft" }]],
        ["a suggestion", "suggestEdit", ["doc-1", "Draft", "Final"]],
      ] as const;
      const CONTENT_READ = "Read Google Doc content";
      const queue = (
        files: ReturnType<typeof connection>, method: "comment" | "suggestEdit",
        args: readonly unknown[],
      ) => rawHooks().callDrive(files.facet, FOLDER, method, [...args]);
      const titles = (called: { reports: { title: string }[] }) =>
        called.reports.map(({ title }) => title);

      it.each(QUOTING)("reads the connection's copy for %s, with no request of the Doc " +
          "inside the TTL", async (name, method, args) => {
        let { docs, drive } = library();
        let files = connection(`drive-quote-fresh-${name.length}`, FOLDER);
        expect(await files.read()).toBe("Draft\n");
        // What the same write asks of Drive on a connection that never read the file.
        let control = connection(`drive-quote-fresh-control-${name.length}`, FOLDER);
        let asked = drive.requests.length;
        expect((await queue(control, method, args)).error).toBeUndefined();
        let unread = drive.requests.slice(asked);

        let from = requestsMade();
        asked = drive.requests.length;
        let queued = await queue(files, method, args);
        expect(queued.error).toBeUndefined();
        expect(queued.actionId).toBeDefined();
        expect(docsReadsSince(from)).toEqual([]);
        expect(drive.requests.slice(asked)).toEqual(unread);
        expect(titles(queued)).toContain(CONTENT_READ);
        expect(docs.documentFetches).toBe(2);
      });

      // A suggestion changes what the text reads as, so the copy read before it is not served
      // after it; a comment changes no text, and the copy is.
      it.each(QUOTING)("reads the Doc again after the connection posts %s only if it is a " +
          "suggestion", async (name, method, args) => {
        let { docs } = library();
        let files = connection(`drive-fresh-after-${name.length}`, FOLDER);
        expect(await files.read()).toBe("Draft\n");
        let queued = await queue(files, method, args);
        expect(await rawHooks().applyDrive(files.facet, FOLDER, queued.actionId!)).toBeNull();
        let before = docs.documentFetches;
        expect(await files.read()).toBe("Draft\n");
        expect(docs.documentFetches - before).toBe(method === "suggestEdit" ? 1 : 0);
      });

      it.each(QUOTING)("fetches once for a first %s, and keeps the copy once its read is " +
          "authorized", async (name, method, args) => {
        let { docs } = library();
        let files = connection(`drive-quote-first-${name.length}`, FOLDER);
        let from = requestsMade();
        let queued = await queue(files, method, args);
        expect(queued.error).toBeUndefined();
        expect(docsReadsSince(from)).toEqual(["read"]);
        expect(await files.head()).toMatchObject({
          stale: false, folder: ROOT, outline: [{ tabId: MAIN_TAB }],
        });
        // The copy the lookup kept serves the read after it.
        expect(await files.read()).toBe("Draft\n");
        expect(docs.documentFetches).toBe(1);
      });

      it("stores nothing of the Doc for a comment whose scope check refuses", async () => {
        let { docs, move } = library();
        let files = connection("drive-quote-refused", FOLDER);
        // In scope when the lookup begins, and out of it once the document has been fetched.
        let model = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          let request = new Request(input, init);
          if (new URL(request.url).hostname === "docs.googleapis.com") move("doc-1", "elsewhere");
          return model(request);
        });
        let refused = await queue(files, "comment", QUOTING[0][2]);
        expect(refused.error).toBe(OUTSIDE);
        expect(refused.actionId).toBeUndefined();
        expect(titles(refused)).not.toContain(CONTENT_READ);
        expect(docs.documentFetches).toBe(1);
        let rows = await files.rows();
        expect(Object.keys(rows).length).toBeGreaterThan(0);
        expect(Object.values(rows).every(count => count === 0)).toBe(true);
        expect(await files.head()).toBeNull();
      });

      it("keeps the copy of a Doc in which the quote is not found", async () => {
        let { docs } = library();
        let files = connection("drive-quote-absent", FOLDER);
        let refused = await queue(files, "comment", ["doc-1", "Really?", { quote: "Absent" }]);
        expect(refused.error).toContain(`That text was not found in tab ${MAIN_TAB}.`);
        expect(refused.actionId).toBeUndefined();
        // The search read the Doc, whatever it found: the read is authorized and the copy kept.
        expect(titles(refused)).toContain(CONTENT_READ);
        expect(await files.head()).toMatchObject({ stale: false, outline: [{ tabId: MAIN_TAB }] });
        expect(await files.read()).toBe("Draft\n");
        expect(docs.documentFetches).toBe(1);
      });

      // A paragraph past a stored row: no read through the connection answers such a Doc,
      // and the lookup is a read.
      describe("in a Doc the connection cannot keep a copy of", () => {
        const pastRow = () => buildTab([para("Draft"), para("a".repeat(DOC_ROW_BYTES + 1))]).body;

        it("refuses a comment's quote and a suggestion with the read's own error, " +
            "authorizes no read of the Doc's content and stores nothing", async () => {
          let { docs } = library();
          docs.setBody(MAIN_TAB, pastRow());
          let files = connection("drive-quote-past-row", FOLDER);
          let read = await files.read();
          expect(read).toContain(
            `A paragraph of tab "${MAIN_TAB}" of this Google Doc is too large to keep a copy of: `);
          // What a comment with no quote, which reads no document, reports.
          let plain = await queue(files, "comment", ["doc-1", "Note"]);
          expect(plain.error).toBeUndefined();
          expect(docs.documentFetches).toBe(1);

          for (let [, method, args] of QUOTING) {
            let fetches = docs.documentFetches;
            let refused = await queue(files, method, args);
            expect(refused.error).toBe(read);
            expect(refused.actionId).toBeUndefined();
            // The comment target's own observations, and none of the Doc's content.
            expect(titles(refused)).toEqual(titles(plain));
            expect(titles(refused)).not.toContain(CONTENT_READ);
            expect(docs.documentFetches).toBe(fetches + 1);
          }
          expect(await files.head()).toBeNull();
          expect(Object.values(await files.rows()).every(count => count === 0)).toBe(true);
          expect(await rawHooks().driveQueued(files.facet, FOLDER)).toEqual([plain.actionId]);
        });

      });
    });

    // A folder session that is refused a file the connection stores a copy of asks Drive at
    // most once, for the file's parent folder, and the copy goes where that shows the
    // connection does not reach the file.
    describe("a refusal of a file the connection does not reach removes its copy", () => {
      // A read-only connection is the one the mid-fetch and the trash tests below use.
      const BINDINGS = [["a read and write binding", FOLDER]] as const;
      const NO_ROW = { "doc_copy of the file": 0, "doc_version of the file": 0 };
      let info: MockInstance<typeof console.info>;
      /** The removals the connection logged, each line whole. */
      const removals = () => info.mock.calls.map(([line]) => line as Record<string, unknown>)
        .filter(line => String(line.event).startsWith("google.doc.copy."));
      const unreachable = (fileId: string, reason: string) => ({
        component: "gatekeeper.google.drive.editors", vendorId: "google",
        event: "google.doc.copy.unreachable", fileId, reason,
        message: "removed a Google Doc's stored copy",
      });

      /**
       * `library(parent)`, with a second Doc, doc-2, reading "Second", in the bound folder
       * (`second` is its model), the clock held in one hour, and what each call asked of Drive.
       */
      function twoDocs(parent: string = ROOT) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.UTC(2026, 0, 1, 10, 20));
        info = vi.spyOn(console, "info").mockImplementation(() => {});
        let fakes = library(parent);
        let second = new DocsModel();
        second.documentId = "doc-2";
        second.setText(MAIN_TAB, "Second");
        fakes.drive.files.set("doc-2", { name: "Second", mimeType: DRIVE_DOC_MIME, parents: [ROOT] });
        serveFakes([fakes.drive, docsProvider(fakes.docs, second)]);
        /** Runs `call`, which must be refused, and answers the requests Drive was sent for it. */
        let refused = async (call: () => Promise<string>) => {
          let before = fakes.drive.requests.length;
          expect(await call()).toBe(OUTSIDE);
          return fakes.drive.requests.slice(before);
        };
        /** The batched scope reads among `requests` that ask for folder `id` and nothing else. */
        let lookups = (requests: string[], id: string) =>
          requests.filter(request => request === `BATCH ${id}`).length;
        return { ...fakes, second, refused, lookups };
      }

      /** Storage holds what a connection that read the second file alone holds. */
      async function expectNeverRead(
        files: ReturnType<typeof connection>, name: string, binding: Binding,
      ) {
        expect(await files.head()).toBeNull();
        expect(await files.rows()).toMatchObject(NO_ROW);
        let control = connection(`${name}-control`, binding);
        expect(await control.read([], "doc-2")).toBe("Second\n");
        // Once more, as the connection read it: the read after the first stores the rendering.
        expect(await control.read([], "doc-2")).toBe("Second\n");
        expect(await files.rows("doc-2")).toEqual(await control.rows("doc-2"));
        expect(await rawHooks().driveDocBaseRows(files.facet, binding, "doc-2"))
          .toBe(await rawHooks().driveDocBaseRows(control.facet, binding, "doc-2"));
        for (let table of ["doc_copy", "doc_version", "doc_seq", "doc_run", "doc_md", "doc_result"]) {
          expect(await files.exec(`SELECT count(*) AS rows FROM ${table}`), table)
            .toEqual(await control.exec(`SELECT count(*) AS rows FROM ${table}`));
        }
      }

      it.each(BINDINGS)("when the file has left the folder and is read again (%s)", async (name, binding) => {
        let { move, refused, lookups } = twoDocs();
        let facet = `drive-reach-left-${name.length}`;
        // What the same refusal asks of Drive on a connection that stores no copy of the file.
        let unread = connection(`${facet}-unread`, binding);
        let base = await refused(() => unread.readAfter(() => move("doc-1", "elsewhere")));
        move("doc-1", ROOT);

        let files = connection(facet, binding);
        for (let file of ["doc-1", "doc-2", "doc-2"]) await files.read([], file);
        expect(await files.head()).toMatchObject({ folder: ROOT });
        let requests = await refused(() => files.readAfter(() => move("doc-1", "elsewhere")));

        // One request more than the refusal alone makes: the file's parent folder.
        expect(lookups(requests, "elsewhere")).toBe(1);
        expect(requests.filter(request => request !== "BATCH elsewhere")).toEqual(base);
        expect(removals()).toEqual([unreachable("doc-1", "moved-out")]);
        await expectNeverRead(files, facet, binding);
      });

      it("removes the stored copy, and keeps nothing of the document just fetched, when the file leaves while it is fetched", async () => {
        let { docs, move, refused, lookups } = twoDocs();
        let facet = "drive-reach-left-mid-fetch";
        // A read-only connection's session has a source of its own, which fetches at its read.
        let files = connection(facet, READ_ONLY_FOLDER);
        for (let file of ["doc-1", "doc-2", "doc-2"]) await files.read([], file);
        let model = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          let request = new Request(input, init);
          if (new URL(request.url).hostname === "docs.googleapis.com") move("doc-1", "elsewhere");
          return model(request);
        });

        let requests = await refused(() => files.read());

        expect(docs.documentFetches).toBe(2);
        expect(lookups(requests, "elsewhere")).toBe(1);
        expect(removals()).toEqual([unreachable("doc-1", "moved-out")]);
        vi.stubGlobal("fetch", model);
        await expectNeverRead(files, facet, READ_ONLY_FOLDER);
      });

      it.each(BINDINGS)("asks Drive once, and keeps the copy, when the file moved to another folder of the binding (%s)", async (name, binding) => {
        let { move, refused, lookups } = twoDocs(SUB);
        let files = connection(`drive-reach-moved-within-${name.length}`, binding);
        expect(await files.read([SUB])).toBe("Draft\n");
        let stored = await files.stored();
        move("doc-1", OTHER);

        // The old folder's session is refused: the file's parent is a folder of the binding.
        let requests = await refused(() => files.read([SUB]));

        expect(lookups(requests, OTHER)).toBe(1);
        expect(await files.stored()).toEqual(stored);
        expect(removals()).toEqual([]);
      });

      it("asks nothing of other files", async () => {
        let { drive, move, refused } = twoDocs();
        move("doc-2", SUB);
        let files = connection("drive-reach-other-files", FOLDER);
        expect(await files.read()).toBe("Draft\n");
        expect(await files.read([SUB], "doc-2")).toBe("Second\n");
        let other = await files.rows("doc-2");
        expect(other).toMatchObject({ doc_copy: 2, "doc_copy of the file": 1 });
        move("doc-1", "elsewhere");

        let requests = await refused(() => files.read());

        // The root session's path, the refused file, the root's shortcuts, and that file's
        // parent: no request names the other stored Doc or the folder it stands in.
        expect(requests).toEqual([
          `BATCH ${ROOT}`, "GET /drive/v3/files/doc-1", `SHORTCUTS ${ROOT}`, "BATCH elsewhere",
        ]);
        expect(drive.requests.length).toBeGreaterThan(requests.length);
        expect(removals()).toEqual([unreachable("doc-1", "moved-out")]);
        expect(await files.rows("doc-2")).toMatchObject({ doc_copy: 1, "doc_copy of the file": 1 });
        expect(await files.read([SUB], "doc-2")).toBe("Second\n");
      });

      it.each([
        ["in the trash", "trashed", (drive: DriveFiles) => { drive.files.get("doc-1")!.trashed = true; }],
        ["the account cannot see", "invisible", (drive: DriveFiles) => { drive.files.delete("doc-1"); }],
      ] as const)("removes the copy of a file %s with no lookup", async (_name, reason, change) => {
        let { drive, refused } = twoDocs();
        let facet = `drive-reach-${reason}`;
        let files = connection(facet, READ_ONLY_FOLDER);
        for (let file of ["doc-1", "doc-2", "doc-2"]) await files.read([], file);
        change(drive);
        let unread = connection(`${facet}-unread`, READ_ONLY_FOLDER);
        let base = await refused(() => unread.read());

        // What the refusal itself read says so: the same requests as with no copy stored.
        expect(await refused(() => files.read())).toEqual(base);

        expect(removals()).toEqual([unreachable("doc-1", reason)]);
        await expectNeverRead(files, facet, READ_ONLY_FOLDER);
      });

      it("removes the copy, with pending edits, of a file that left, and refuses the edit's approval while the file is away", async () => {
        let { docs, move, refused, lookups } = twoDocs();
        let files = connection("drive-reach-pending", FOLDER);
        let { actionId, error } = await files.call("appendText", ["More"]);
        expect(error).toBeUndefined();
        let pending = await files.read();
        expect(pending).toBe("Draft\n\nMore\n");
        expect(await files.rows()).toMatchObject({ doc_result: 1 });
        move("doc-1", "elsewhere");

        expect(lookups(await refused(() => files.read()), "elsewhere")).toBe(1);

        // The copy went with what its pending edit made; the edit's record waits in the journal.
        expect(removals()).toEqual([unreachable("doc-1", "moved-out")]);
        expect(await files.head()).toBeNull();
        expect(await files.rows()).toMatchObject({ ...NO_ROW, doc_result: 0 });
        // Approved while the file is out of reach, the edit is refused by its own proof.
        expect(await files.apply(actionId!)).toBe(OUT_OF_SCOPE);
        expect(docs.contentBatches).toBe(0);
      });

      it("makes a file's pending edit again, from one fetch, when the file comes back", async () => {
        let { docs, move, refused } = twoDocs();
        let files = connection("drive-reach-came-back-pending", FOLDER);
        let { actionId, error } = await files.call("appendText", ["More"]);
        expect(error).toBeUndefined();
        let pending = await files.read();
        move("doc-1", "elsewhere");
        await refused(() => files.read());
        move("doc-1", ROOT);
        let fetches = docs.documentFetches;
        let before = { stored: docStoreCost.resultsStored, found: docStoreCost.resultsFound };

        expect(await files.read()).toBe(pending);

        expect(docs.documentFetches - fetches).toBe(1);
        // The edit's result went with the copy: it is made again, once, in the trial of the
        // document fetched, and none is found. The read after it stores what it makes.
        expect({
          stored: docStoreCost.resultsStored - before.stored,
          found: docStoreCost.resultsFound - before.found,
        }).toEqual({ stored: 1, found: 0 });
        expect(await files.read()).toBe(pending);
        expect(docs.documentFetches - fetches).toBe(1);
        expect(await files.rows()).toMatchObject({ "doc_copy of the file": 1, doc_result: 1 });
        expect(await files.apply(actionId!)).toBeNull();
        expect(docs.text()).toContain("More");
      });
    });

    describe("a refusal that leaves the file in the connection's reach changes nothing in storage", () => {
      it("when a session standing on another folder of the binding is refused it", async () => {
        let { docs } = library(SUB);
        let files = connection("drive-store-two-sessions", FOLDER);
        expect(await files.read([SUB])).toBe("Draft\n");
        // Once more, which stores the rendering of the tab the first read kept.
        expect(await files.read([SUB])).toBe("Draft\n");
        let stored = await files.stored();
        for (let again = 0; again < 2; again++) {
          // The file is no direct child of the bound folder, which the root session stands on.
          expect(await files.read()).toBe(OUTSIDE);
          expect(await files.stored()).toEqual(stored);
          expect(await files.read([SUB])).toBe("Draft\n");
          expect(docs.documentFetches).toBe(1);
        }
        expect(await files.stored()).toEqual(stored);
      });

      it("when a session whose saved path fails its proof is refused", async () => {
        let { move } = library(SUB);
        let files = connection("drive-store-stale-path", FOLDER);
        expect(await files.read([SUB])).toBe("Draft\n");
        let stored = await files.stored();
        // The folder the session was opened under moves within the binding.
        expect(await files.readAfter(() => move(SUB, OTHER), [SUB])).toBe(OUTSIDE);
        expect(await files.stored()).toEqual(stored);
      });

      it.each([
        ["a read and write binding", "first", FOLDER],
        ["a read-only connection", "second", READ_ONLY_FOLDER],
      ] as const)("whichever session is refused first after the file moved to another folder " +
          "of the binding (%s, the old folder's session refused %s)", async (name, order, binding) => {
        let { docs, move } = library(SUB);
        let files = connection(`drive-store-moved-${name.length}-${order}`, binding);
        expect(await files.read([SUB])).toBe("Draft\n");
        let fetches = docs.documentFetches;
        move("doc-1", OTHER);

        /** The session under the old folder is refused, and the copy is as it was. */
        let refused = async () => {
          let stored = await files.stored();
          expect(await files.read([SUB])).toBe(OUTSIDE);
          expect(await files.stored()).toEqual(stored);
        };
        if (order === "first") await refused();
        expect(await files.read([OTHER])).toBe("Draft\n");
        if (order === "second") await refused();
        // The binding's sessions share one source of the file, which no refusal emptied; a
        // read-only session has a source of its own, which fetches at its first read.
        expect(docs.documentFetches - fetches).toBe(binding === FOLDER ? 0 : 1);
        expect((await files.head())?.folder).toBe(OTHER);
      });

      it.each([
        ["the file", DRIVE_DOC, "Google Drive API request failed: 404 (notFound)"],
        ["the whole account", ACCOUNT, UNAVAILABLE],
      ] as const)("when a connection bound to %s is refused it", async (name, binding, refusal) => {
        let { drive } = library("my-root");
        let files = connection(`drive-store-unavailable-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");
        let stored = await files.stored();
        drive.files.delete("doc-1");
        expect(await files.read()).toBe(refusal);
        expect(await files.stored()).toEqual(stored);
      });

      it("when an approval's proof finds a stale folder path", async () => {
        let { docs, move } = library(SUB);
        let files = connection("drive-store-stale-approval", FOLDER);
        let { actionId, error } = await files.call("appendText", ["More"], [SUB]);
        expect(error).toBeUndefined();
        let stored = await files.stored();
        expect(stored.head).toMatchObject({ folder: SUB });
        move(SUB, OTHER);
        expect(await files.apply(actionId!)).toBe(OUT_OF_SCOPE);
        expect(await files.stored()).toEqual(stored);
        expect(docs.contentBatches).toBe(0);
      });
    });

    // The connection's own caps, in its own Durable Object. A connection is brought to a cap
    // by its records, which is all the caps read of a copy: one real read, records seeded
    // beside it, and one more real read.
    describe("at the connection's caps", () => {
      const BINDINGS = [
        ["a read and write binding", FOLDER],
        ["a read-only connection", READ_ONLY_FOLDER],
      ] as const;
      /**
       * Seeds ?1 records of copies beside the copy of the file ?3, each of ?2 bytes, with no
       * version, read under the same folder and approved an hour after that copy.
       */
      const SEED = `
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
        INSERT INTO doc_copy (doc, id, revision, fetched_at, checked_at, stale, folder, approved,
                              made, bytes, outline, markers, versions)
        SELECT 'seeded-' || i, 'seeded', NULL, c.fetched_at + i, NULL, 0, c.folder,
               c.approved + ${DOC_COPY_APPROVAL_GRAIN_MS}, c.made, ?2, '[]', '[]', '[]'
        FROM n, doc_copy AS c WHERE c.doc = ?3`;
      const NO_ROW = { "doc_copy of the file": 0, "doc_version of the file": 0 };
      let info: MockInstance<typeof console.info>;
      /** The removals the connection logged, each line whole. */
      const removals = () => info.mock.calls.map(([line]) => line as Record<string, unknown>)
        .filter(line => String(line.event).startsWith("google.doc.copy."));
      const evicted = (fileId: string, reason: string) => ({
        component: "gatekeeper.google.drive.editors", vendorId: "google",
        event: "google.doc.copy.evicted", fileId, reason,
        message: "removed a Google Doc's stored copy",
      });
      const copies = async (files: ReturnType<typeof connection>) =>
        (await files.exec("SELECT doc FROM doc_copy ORDER BY doc")).map(row => row.doc);

      /**
       * `library()`, with a second Doc, doc-2, reading "Second", in the bound folder (`second`
       * is its model), and the clock held in one hour.
       */
      function twoDocs() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.UTC(2026, 0, 1, 10, 20));
        info = vi.spyOn(console, "info").mockImplementation(() => {});
        let fakes = library();
        let second = new DocsModel();
        second.documentId = "doc-2";
        second.setText(MAIN_TAB, "Second");
        fakes.drive.files.set("doc-2", { name: "Second", mimeType: DRIVE_DOC_MIME, parents: [ROOT] });
        serveFakes([fakes.drive, docsProvider(fakes.docs, second)]);
        return { ...fakes, second };
      }

      it.each([BINDINGS[0]])("a keep that brings %s to 201 documents removes the copy read first", async (name, binding) => {
        let { docs, second } = twoDocs();
        let files = connection(`drive-cap-count-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");
        await files.exec(SEED, MAX_DRIVE_DOC_COPIES - 1, 1, "doc-1");
        expect(await files.exec("SELECT count(*) AS copies FROM doc_copy")).toEqual([{ copies: MAX_DRIVE_DOC_COPIES }]);

        expect(await files.read([], "doc-2")).toBe("Second\n");

        // The first file's copy went, every row of it: storage holds what a connection that
        // read the second file alone, beside the same records, holds.
        expect(removals()).toEqual([evicted("doc-1", "count")]);
        expect(await files.rows()).toMatchObject(NO_ROW);
        let control = connection(`drive-cap-count-control-${name.length}`, binding);
        expect(await control.read([], "doc-2")).toBe("Second\n");
        await control.exec(SEED, MAX_DRIVE_DOC_COPIES - 1, 1, "doc-2");
        expect(await files.rows("doc-2")).toEqual(await control.rows("doc-2"));
        expect(await files.rows("doc-2")).toMatchObject({
          doc_copy: MAX_DRIVE_DOC_COPIES, "doc_copy of the file": 1, "doc_version of the file": 1,
        });
        // One fetch a read so far, the control's included.
        expect([docs.documentFetches, second.documentFetches]).toEqual([1, 2]);

        // The first file read again fetches once and reads the same; its keep removes the
        // copy whose approval is then the oldest, the second file's.
        info.mockClear();
        expect(await files.read()).toBe("Draft\n");
        expect([docs.documentFetches, second.documentFetches]).toEqual([2, 2]);
        expect(removals()).toEqual([evicted("doc-2", "count")]);
        expect(await files.rows()).toMatchObject({
          doc_copy: MAX_DRIVE_DOC_COPIES, "doc_copy of the file": 1, "doc_version of the file": 1,
        });
        expect(await files.rows("doc-2")).toMatchObject(NO_ROW);
      });

      it.each([BINDINGS[1]])("a keep that finds %s over 512 MiB removes the copy read first", async (name, binding) => {
        let { docs, second } = twoDocs();
        let files = connection(`drive-cap-bytes-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");
        // One record that says its copy is the whole cap: no megabyte of content is written.
        await files.exec(SEED, 1, MAX_DRIVE_DOC_COPY_BYTES, "doc-1");
        expect(await copies(files)).toEqual(["doc-1", "seeded-1"]);

        expect(await files.read([], "doc-2")).toBe("Second\n");

        // Three records, far under the count, and over the bytes: the oldest approval goes,
        // and then the seeded record, since the connection is still over. The file kept stays.
        expect(removals()).toEqual([evicted("doc-1", "bytes"), evicted("seeded-1", "bytes")]);
        expect(await copies(files)).toEqual(["doc-2"]);
        expect(await files.rows()).toMatchObject(NO_ROW);
        let control = connection(`drive-cap-bytes-control-${name.length}`, binding);
        expect(await control.read([], "doc-2")).toBe("Second\n");
        expect(await files.rows("doc-2")).toEqual(await control.rows("doc-2"));
        expect([docs.documentFetches, second.documentFetches]).toEqual([1, 2]);
      });

      it("a read at the cap that the scope check refuses evicts nothing", async () => {
        let { second, move } = twoDocs();
        let files = connection("drive-cap-refused", FOLDER);
        expect(await files.read()).toBe("Draft\n");
        await files.exec(SEED, MAX_DRIVE_DOC_COPIES - 1, 1, "doc-1");
        let stored = await files.stored();
        // In scope when the read begins, and out of it once the document has been fetched.
        let model = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          let request = new Request(input, init);
          if (new URL(request.url).hostname === "docs.googleapis.com") move("doc-2", "elsewhere");
          return model(request);
        });

        expect(await files.read([], "doc-2")).toBe(OUTSIDE);

        // The document was fetched and tried, and nothing of it is kept: the connection
        // holds its 200 records, the first file's rows as they were.
        expect(second.documentFetches).toBe(1);
        expect(await files.stored()).toEqual(stored);
        expect(stored.rows).toMatchObject({ doc_copy: MAX_DRIVE_DOC_COPIES, "doc_copy of the file": 1 });
        expect(await files.rows("doc-2")).toMatchObject(NO_ROW);
        expect(removals()).toEqual([]);
      });
    });

    // The expiry: a copy goes the next time its connection is used, whatever that use is, and
    // not before, since nothing wakes the connection's object.
    describe("a copy no read was allowed of for 7 days", () => {
      const BINDINGS = [
        ["a read and write binding", FOLDER],
        ["a read-only connection", READ_ONLY_FOLDER],
      ] as const;
      const START = Date.UTC(2026, 0, 1, 10, 20);
      const HOUR = DOC_COPY_APPROVAL_GRAIN_MS, DAY = 24 * HOUR;
      /** Seven days and an hour: past the expiry of a copy approved in the hour of `START`. */
      const PAST = DRIVE_DOC_COPY_EXPIRY_MS + HOUR;
      const hourOf = (clock: number) => clock - clock % HOUR;
      /** What the hooks answer of a connection whose tables hold no row. */
      const EMPTY = {
        doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0,
        "doc_copy of the file": 0, "doc_version of the file": 0,
      };
      let info: MockInstance<typeof console.info>;
      /** The removals the connection logged, each line whole. */
      const removals = () => info.mock.calls.map(([line]) => line as Record<string, unknown>)
        .filter(line => String(line.event).startsWith("google.doc.copy."));
      const expired = (fileId: string) => ({
        component: "gatekeeper.google.drive.editors", vendorId: "google",
        event: "google.doc.copy.expired", fileId, reason: "unapproved",
        message: "removed a Google Doc's stored copy",
      });

      /**
       * `library()`, with a second Doc, doc-2, reading "Second", in the bound folder (`second`
       * is its model), and the clock at `START`.
       */
      function aged() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START);
        info = vi.spyOn(console, "info").mockImplementation(() => {});
        let fakes = library();
        let second = new DocsModel();
        second.documentId = "doc-2";
        second.setText(MAIN_TAB, "Second");
        fakes.drive.files.set("doc-2", { name: "Second", mimeType: DRIVE_DOC_MIME, parents: [ROOT] });
        serveFakes([fakes.drive, docsProvider(fakes.docs, second), COMMENTS]);
        return { ...fakes, second };
      }
      /** A Drive that takes a comment on any file, and answers it as posted. */
      const COMMENTS: ProviderFake = {
        async handle(request) {
          let posted = /^\/drive\/v3\/files\/[^/]+\/comments$/.test(new URL(request.url).pathname);
          if (request.method !== "POST" || !posted) return undefined;
          let { content } = await request.json<{ content: string }>();
          let at = new Date().toISOString();
          return Response.json({
            id: "comment-1", content, author: { displayName: "Test user", me: true },
            createdTime: at, modifiedTime: at, resolved: false, deleted: false, replies: [],
          });
        },
      };
      /** A request of the connection that reads no Doc: a session started, which reads a file's metadata. */
      const use = async (files: ReturnType<typeof connection>, binding: Binding) => {
        let entry = await rawHooks().callDrive(files.facet, binding, "getEntry", ["doc-1"]);
        expect(entry.error).toBeUndefined();
      };

      it.each([BINDINGS[0]])("goes from %s at the next request, one that reads no Doc", async (name, binding) => {
        let { docs } = aged();
        let files = connection(`drive-expiry-other-use-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");

        // An hour short of the limit, a request removes nothing.
        vi.setSystemTime(START + DRIVE_DOC_COPY_EXPIRY_MS - HOUR);
        await use(files, binding);
        expect(await files.rows()).toMatchObject({ "doc_copy of the file": 1 });
        expect(removals()).toEqual([]);

        vi.setSystemTime(START + PAST);
        await use(files, binding);

        // Every row of the file is gone, and nothing was fetched for it.
        expect(await files.rows()).toEqual(EMPTY);
        expect(await files.head()).toBeNull();
        expect(removals()).toEqual([expired("doc-1")]);
        expect(docs.documentFetches).toBe(1);

        // A later request finds nothing more to remove.
        vi.setSystemTime(START + PAST + HOUR);
        await use(files, binding);
        expect(removals()).toEqual([expired("doc-1")]);
      });

      it.each([BINDINGS[1]])("goes from %s at the next read of the file itself, which fetches once", async (name, binding) => {
        let { docs } = aged();
        let files = connection(`drive-expiry-own-read-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");
        let first = await files.head();

        vi.setSystemTime(START + PAST);
        expect(await files.read()).toBe("Draft\n");

        expect(removals()).toEqual([expired("doc-1")]);
        expect(docs.documentFetches).toBe(2);
        // The copy kept is this read's: fetched and approved at this clock.
        expect(await files.head()).toMatchObject({
          id: first!.id, fetchedAt: START + PAST, approvedAt: hourOf(START + PAST), stale: false,
        });
        expect(await files.rows()).toMatchObject({ doc_copy: 1, "doc_version of the file": 1 });
      });

      it.each([BINDINGS[0]])("goes from %s at a read of a session started before the limit", async (name, binding) => {
        let { docs } = aged();
        let files = connection(`drive-expiry-open-session-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");

        // The session is started and the Doc opened at `START`, where nothing is due: the
        // pass that removes the copy is the read's own.
        expect(await files.readAfter(() => { vi.setSystemTime(START + PAST); })).toBe("Draft\n");

        expect(removals()).toEqual([expired("doc-1")]);
        expect(docs.documentFetches).toBe(2);
        expect(await files.head()).toMatchObject({
          fetchedAt: START + PAST, approvedAt: hourOf(START + PAST), stale: false,
        });
      });

      it("goes at an approval, whose write is built from a fetch", async () => {
        let { docs } = aged();
        let files = connection("drive-expiry-approval", FOLDER);
        let { actionId } = await files.call("appendText", ["More"]);
        expect(await files.read()).toBe("Draft\n\nMore\n");
        expect(await files.rows()).toMatchObject({ "doc_copy of the file": 1, doc_result: 1 });
        let fetches = docs.documentFetches;
        let batches = docs.contentBatches;

        vi.setSystemTime(START + PAST);
        // Decided through the connection itself: no session is started, so the pass is the
        // decision's own.
        expect(await files.apply(actionId!)).toBeNull();

        expect(removals()).toEqual([expired("doc-1")]);
        // The one fetch the write was built from, which is tried and not kept.
        expect(docs.documentFetches).toBe(fetches + 1);
        expect(docs.contentBatches).toBe(batches + 1);
        expect(await files.rows()).toEqual(EMPTY);
        expect(await files.read()).toBe("Draft\n\nMore\n");
        expect(docs.documentFetches).toBe(fetches + 2);
      });

      it("goes at a rejection", async () => {
        let { docs } = aged();
        let files = connection("drive-expiry-rejection", FOLDER);
        let { actionId } = await files.call("appendText", ["More"]);
        expect(await files.read()).toBe("Draft\n\nMore\n");
        let fetches = docs.documentFetches;

        vi.setSystemTime(START + PAST);
        expect(await rawHooks().rejectDriveEdit(files.facet, FOLDER, actionId!)).toBeNull();

        expect(removals()).toEqual([expired("doc-1")]);
        expect(await files.rows()).toEqual(EMPTY);
        // A rejection fetches nothing; the next read fetches once.
        expect(docs.documentFetches).toBe(fetches);
        expect(await files.read()).toBe("Draft\n");
        expect(docs.documentFetches).toBe(fetches + 1);
      });

      describe.each([
        ["an approval", (facet: string, id: number) => rawHooks().applyDrive(facet, FOLDER, id)],
      ] as const)("at %s of a record that is no Doc edit", (_decision, decide) => {
        it("goes when the record is a comment", async () => {
          let { docs } = aged();
          let files = connection(`drive-expiry-comment-${_decision.length}`, FOLDER);
          expect(await files.read()).toBe("Draft\n");
          // A comment with no quote fetches no document.
          let queued = await rawHooks().callDrive(files.facet, FOLDER, "comment", ["doc-1", "Note"]);
          expect(queued.error).toBeUndefined();
          expect(docs.documentFetches).toBe(1);
          // A connection that queued the same comment and never read the file.
          let control = connection(`drive-expiry-comment-control-${_decision.length}`, FOLDER);
          let unread = await rawHooks().callDrive(control.facet, FOLDER, "comment", ["doc-1", "Note"]);

          vi.setSystemTime(START + PAST);
          let answered = await decide(files.facet, queued.actionId!);

          // The decision is made, as the control's is, and the copy is gone all the same.
          expect(answered).toBeNull();
          expect(await decide(control.facet, unread.actionId!)).toBeNull();
          expect(await files.rows()).toEqual(EMPTY);
          expect(await control.tables()).toEqual([]);
          expect(removals()).toEqual([expired("doc-1")]);
          expect(docs.documentFetches).toBe(1);
        });

        it("goes at a decision of an action the connection does not hold", async () => {
          let { docs } = aged();
          let files = connection(`drive-expiry-unknown-${_decision.length}`, FOLDER);
          expect(await files.read()).toBe("Draft\n");
          let control = connection(`drive-expiry-unknown-control-${_decision.length}`, FOLDER);

          vi.setSystemTime(START + PAST);
          let answered = await decide(files.facet, 9_999);

          expect(answered).toBe(await decide(control.facet, 9_999));
          expect(await files.rows()).toEqual(EMPTY);
          expect(removals()).toEqual([expired("doc-1")]);
          expect(docs.documentFetches).toBe(1);
        });
      });

      // The binding's sessions share the file's source, which confirms the copy's revision.
      it.each([
        ["a read and write binding", FOLDER, 1],
      ] as const)("is renewed in %s by a read", async (name, binding, fetches) => {
        let { docs } = aged();
        let files = connection(`drive-expiry-renewed-${name.length}`, binding);
        expect(await files.read()).toBe("Draft\n");

        vi.setSystemTime(START + 6 * DAY);
        expect(await files.read()).toBe("Draft\n");
        expect(docs.documentFetches).toBe(fetches);
        expect((await files.head())?.approvedAt).toBe(hourOf(START + 6 * DAY));

        // Eight days after the first read, and two after the second: the copy stays.
        vi.setSystemTime(START + 8 * DAY);
        await use(files, binding);
        expect(await files.rows()).toMatchObject({ "doc_copy of the file": 1 });
        expect(removals()).toEqual([]);

        // Seven days after the read that renewed it, to the hour.
        vi.setSystemTime(hourOf(START + 13 * DAY) - 1);
        await use(files, binding);
        expect(removals()).toEqual([]);
        vi.setSystemTime(hourOf(START + 13 * DAY));
        await use(files, binding);
        expect(removals()).toEqual([expired("doc-1")]);
        expect(await files.rows()).toEqual(EMPTY);
        expect(docs.documentFetches).toBe(fetches);
      });

      it.each([BINDINGS[1]])("keeps the hour of its pass in %s only once it stores a Doc", async (name, binding) => {
        aged();
        let files = connection(`drive-expiry-key-${name.length}`, binding);
        let passed = () => rawHooks().driveStored(files.facet, binding, DOC_COPY_EXPIRY_PASS_KEY);

        // A connection that stores no Doc: no table is made for the pass, and no key written.
        await use(files, binding);
        expect(await files.tables()).toEqual([]);
        expect(await passed()).toBeNull();

        // The Doc is stored in an hour the connection has passed, with nothing to pass over.
        expect(await files.read()).toBe("Draft\n");
        expect(await passed()).toBeNull();

        // The next hour's first request passes over the copy, and writes its hour.
        vi.setSystemTime(START + HOUR);
        await use(files, binding);
        expect(await passed()).toBe(JSON.stringify(hourOf(START + HOUR)));
        expect(removals()).toEqual([]);
      });

    });

    it("leaves the stored copy as it was when a read fails for a reason that is not its scope", async () => {
      let { docs } = library();
      let files = connection("drive-store-failed-read", FOLDER);
      expect(await files.read()).toBe("Draft\n");
      let stored = await files.stored();
      let model = globalThis.fetch;
      let failing = true;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init);
        if (failing && new URL(request.url).pathname.startsWith("/batch/")) {
          return Response.json({ error: { code: 500, message: "Backend Error" } }, { status: 500 });
        }
        return model(request);
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      let failed = await files.read();
      expect(failed).not.toBe("Draft\n");
      expect(failed).not.toBe(OUTSIDE);
      failing = false;
      expect(await files.stored()).toEqual(stored);
      expect(await files.read()).toBe("Draft\n");
      expect(docs.documentFetches).toBe(1);
    });

    it("marks the copy stale when an approved edit lands, and stores the next read's document over it", async () => {
      let { docs } = library();
      let files = connection("drive-store-landed", FOLDER);
      expect(await files.read()).toBe("Draft\n");
      let { actionId } = await files.call("appendText", ["More"]);
      expect(await files.read()).toBe("Draft\n\nMore\n");
      let before = await files.head();
      expect(before?.stale).toBe(false);
      let fetches = docs.documentFetches;

      expect(await files.apply(actionId!)).toBeNull();
      // The queue is empty, so nothing was fetched after the write: the copy lacks it.
      expect(docs.documentFetches).toBe(fetches);
      expect(await files.head()).toEqual({ ...before, stale: true });

      expect(await files.read()).toBe("Draft\n\nMore\n");
      expect(docs.documentFetches).toBe(fetches + 1);
      let after = await files.head();
      expect(after?.stale).toBe(false);
      expect(after?.id).not.toBe(before?.id);
      expect(await files.rows()).toMatchObject({ "doc_copy of the file": 1, "doc_version of the file": 1 });
    });

    // What an edit made goes with its decision, whether or not the file is opened again: the
    // connection sweeps the file's rows once the record is retired.
    describe("cleanup with the decision", () => {
      /** The file's results and versions, and the connection's runs and renderings. */
      const cleanupRows = async (files: ReturnType<typeof connection>) => {
        let rows = await files.rows();
        return {
          results: rows.doc_result, versions: rows["doc_version of the file"],
          runs: rows.doc_run, renderings: rows.doc_md,
        };
      };
      /** A connection that read doc-1 and kept it, with the rendering of its tab stored. */
      async function keptCopy(name: string) {
        let { docs } = library();
        let files = connection(name, FOLDER);
        expect(await files.read()).toBe("Draft\n");
        expect(await files.read()).toBe("Draft\n");
        return { docs, files, kept: await cleanupRows(files) };
      }
      /** Queues an append of `text`, and reads the tab. */
      async function appendAndRead(files: ReturnType<typeof connection>, text: string) {
        let { actionId } = await files.call("appendText", [text]);
        await files.read();
        return actionId!;
      }

      it("leaves nothing of an approved edit once the queue is empty", async () => {
        let { docs, files, kept } = await keptCopy("drive-store-approved-swept");
        let actionId = await appendAndRead(files, "More");
        // The edit's result, the version it gives, and that version's run and rendering.
        expect(await cleanupRows(files)).toEqual({
          results: 1, versions: kept.versions + 1, runs: kept.runs + 1, renderings: kept.renderings + 1,
        });
        let fetches = docs.documentFetches;

        expect(await files.apply(actionId)).toBeNull();

        // With no read after it, and nothing fetched: no edit was left pending.
        expect(await cleanupRows(files)).toEqual(kept);
        expect(docs.documentFetches).toBe(fetches);
      });

      it("leaves nothing of a rejected edit in the middle of the queue, nor of the chain behind it", async () => {
        let { docs, files, kept } = await keptCopy("drive-store-rejected-swept");
        await appendAndRead(files, "One");
        let second = await appendAndRead(files, "Two");
        await appendAndRead(files, "Three");
        expect(await cleanupRows(files)).toMatchObject({ results: 3, versions: kept.versions + 3 });

        await rawHooks().rejectDriveEdit(files.facet, FOLDER, second);

        // The first edit's result and the version it gives stay.
        expect(await cleanupRows(files)).toEqual({
          results: 1, versions: kept.versions + 1, runs: kept.runs + 1, renderings: kept.renderings + 1,
        });
        // The read after it makes the third edit once, in the version the first gives, over the
        // snapshot it holds: the newest edit queued is the one it was fetched after.
        let before = { stored: docStoreCost.resultsStored, found: docStoreCost.resultsFound };
        let fetches = docs.documentFetches;
        expect(await files.read()).toBe("Draft\n\nOne\n\nThree\n");
        expect({
          stored: docStoreCost.resultsStored - before.stored,
          found: docStoreCost.resultsFound - before.found,
        }).toEqual({ stored: 1, found: 1 });
        expect(docs.documentFetches).toBe(fetches);
      });

      it("sweeps after an approval that fails its edit for good", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        let { docs, files, kept } = await keptCopy("drive-store-failed-swept");
        let { actionId } = await files.call("replaceText", ["Draft", "Final"]);
        await files.read();
        await appendAndRead(files, "More");
        expect(await cleanupRows(files)).toMatchObject({ results: 2, versions: kept.versions + 2 });
        // A collaborator rewrites the text the first edit replaces.
        docs.externalEdit(MAIN_TAB, "Rewritten");

        expect(await files.apply(actionId!)).toContain("oldMarkdown was not found");

        // The failed edit's chain is gone, and nothing the edit still pending made was made in
        // a version the copy holds.
        expect(await cleanupRows(files)).toMatchObject({ results: 0, versions: kept.versions });
        // The read after it makes that edit in the copy's tab, which is inside its time to live.
        let stored = docStoreCost.resultsStored;
        expect(await files.read()).toBe("Draft\n\nMore\n");
        expect(docStoreCost.resultsStored).toBe(stored + 1);
        expect(await cleanupRows(files)).toMatchObject({ results: 1, versions: kept.versions + 1 });
      });
    });
  });
});

// What a session takes in hand on a tab of 2,000 paragraphs with a table in its middle: the
// store's counters and peaks around each call, and the requests the Docs API was sent.
describe.each(RUNS)("what a Google Doc session takes in hand, $name", r => {
  inRun(r);

  const LINES = 2_000;
  /** The runs the tab is kept as. */
  const TAB_RUNS = 36;
  const lineOf = (at: number) =>
    `line ${String(at).padStart(4, "0")} ${"lorem ipsum dolor sit amet ".repeat(4)}`.slice(0, 99) + ".";
  const REPLACEMENT = ["line 0700", "Changed 0700"] as const;

  /** The fake Google holding the tab, under a frozen clock: the copy's revision pins. */
  function document(): DocsModel {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    return docsWithBody(buildTab([
      ...Array.from({ length: LINES / 2 }, (_, at) => para(lineOf(at))), grid(["Task", "Owner"]),
      ...Array.from({ length: LINES / 2 }, (_, at) => para(lineOf(LINES / 2 + at))),
    ]).body);
  }

  type Taken = {
    runsDecoded: number; runsRendered: number; pieceWidenings: number;
    peakRun: number; peakMarkdown: number; requests: string[];
  };
  /** What `step` moved of the store's counters, and the requests the Docs API was sent. */
  async function taken(step: () => Promise<unknown>): Promise<Taken> {
    let before = { ...docStoreCost }, from = requestsMade();
    docStoreCost.peakRunBytesInHand = 0;
    docStoreCost.peakMarkdownCharsInHand = 0;
    await step();
    return {
      runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      pieceWidenings: docStoreCost.pieceWidenings - before.pieceWidenings,
      peakRun: docStoreCost.peakRunBytesInHand, peakMarkdown: docStoreCost.peakMarkdownCharsInHand,
      requests: docsRequestsSince(from),
    };
  }
  const counts = ({ runsDecoded, runsRendered, pieceWidenings, requests }: Taken) =>
    ({ runsDecoded, runsRendered, pieceWidenings, requests });
  const counted = (runsDecoded: number, runsRendered: number, pieceWidenings = 0, requests: string[] = []) =>
    ({ runsDecoded, runsRendered, pieceWidenings, requests });
  /**
   * A step that builds an edit holds one run's JSON at a time and, as Markdown, the runs of
   * its piece or its text and a run: a run of several elements is at most `RUN_SIZES.most`
   * of JSON, and its Markdown is shorter. Never the tab's Markdown.
   */
  function expectPiece(step: Taken, pieceRuns: number, text: number, tab: number): void {
    expect(step.peakRun).toBeLessThanOrEqual(2 * RUN_SIZES.most);
    expect(step.peakMarkdown).toBeLessThanOrEqual(pieceRuns * RUN_SIZES.most + text);
    expect(step.peakMarkdown).toBeLessThan(tab / 4);
  }

  // Each edit decodes the runs of its piece, never the tab; through Drive a preparation that
  // follows a queued edit also fetches and reads the held copy back in a trial.
  it("each queued edit decodes its piece, and a rejection the pieces of the edits left", async () => {
    let facet = "piece-queue";
    document();
    let read = () => hooks().readContent(facet, MAIN_TAB);
    let content = await read();
    let first = 0;
    let replaced = await taken(async () => {
      first = (await edit(facet, "replaceText", ...REPLACEMENT, MAIN_TAB)).actionId;
    });
    let appended = await taken(() => edit(facet, "appendText", "More", MAIN_TAB));
    let row = await taken(() => edit(facet, "insertTableRows", { table: 0, cells: [["a", "b"]] }, MAIN_TAB));
    let table = await taken(() => edit(
      facet, "insertTable", { rows: 1, columns: 1, cells: [["new"]], after: lineOf(300) }, MAIN_TAB));
    expect([replaced, appended, row, table].map(counts)).toEqual(r.drive
      ? [
        counted(1, 2), counted(TAB_RUNS + 1, 2, 0, ["read"]),
        counted(TAB_RUNS + 1 + 4, 2 + 5, 2, ["read"]), counted(TAB_RUNS + 4 + 2, 5 + 5, 2, ["read"]),
      ]
      : [counted(1, 2), counted(1, 2), counted(1 + 3, 1 + 3 + 1, 2), counted(1 + 2, 1 + 3 + 2)]);
    expectPiece(replaced, 1, REPLACEMENT[1].length, content.length);
    expectPiece(appended, 1, 4, content.length);
    expectPiece(row, 3, 2, content.length);
    expectPiece(table, 2, lineOf(300).length, content.length);

    let pending = await taken(read);
    expect(counts(pending)).toEqual(r.drive ? counted(TAB_RUNS + 1, 4, 0, ["read"]) : counted(0, 0));
    let rejection = await taken(() => Promise.resolve(hooks().rejectAction(facet, first)));
    let after = await taken(read);
    // The append, the row and the table, made again: 1 + 4 + 1 runs decoded, and each with
    // the runs cut from its slice rendered (2 + 5 + 4).
    let replayed = counted(1 + 4 + 1, 2 + 5 + 4, 2);
    expect([rejection, after].map(counts)).toEqual(r.drive
      ? [counted(0, 0), replayed] : [replayed, counted(0, 0, 0, ["probe"])]);
    // The read through Drive that replays them also answers the tab's Markdown.
    if (!r.drive) expectPiece(rejection, 3, lineOf(300).length, content.length);
    expect((r.drive ? after : rejection).peakRun).toBeLessThanOrEqual(2 * RUN_SIZES.most);
  });

  // An add of a tab reads the document: its request is built from the tabs' identities, with
  // no run of the stored copy decoded and none rendered.
  it.runIf(!r.drive)("the approval of an add of a tab reads no stored run and renders none", async () => {
    let facet = "piece-add-tab";
    document();
    await hooks().readContent(facet, MAIN_TAB);
    let added = await addTab(facet, "Notes");

    let approval = await taken(async () => expect(await hooks().applyAction(facet, added.actionId)).toBeNull());

    expect(approval).toEqual({ ...counted(0, 0, 0, ["read", "content", "cleanup"]), peakRun: 0, peakMarkdown: 0 });
  });

  // The collaborator's edit changes the tab's last paragraph, so Google refuses the pin: one
  // `documents.get`, stored as read (rendering its one run not stored yet), and the batch made from
  // the piece around the edit as a replay makes it, which renders the run the edit gives too.
  it("an approval whose pin Google refuses reads the document once and builds from the piece", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let facet = "piece-fallback";
    let docs = document();
    let read = () => hooks().readContent(facet, MAIN_TAB);
    let content = await read();
    let { actionId } = await edit(facet, "replaceText", ...REPLACEMENT, MAIN_TAB);
    await read();
    docs.externalEdit();

    let fallback = await taken(async () => expect(await hooks().applyAction(facet, actionId)).toBeNull());

    expect(counts(fallback)).toEqual(counted(1, 1 + 1 + 1, 0, ["content", "read", "content", "cleanup"]));
    expectPiece(fallback, 1, REPLACEMENT[1].length, content.length);
    expect(docs.text()).toContain(REPLACEMENT[1]);
  });
});
