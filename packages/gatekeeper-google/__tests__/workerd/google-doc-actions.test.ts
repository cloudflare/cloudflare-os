import { abortAllDurableObjects, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionField } from "@gadgets/workshop-shared/gatekeeper";
import { googleDocActionTab } from "../../src/doc-actions";
import { MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import { officeFileError } from "../../src/office-conversion";
import { DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE } from "../../src/resources";
import type { GoogleDocsTab } from "../../src/docs-api";
import type { GoogleDocSession } from "../../src/docs-types";
import { buildTab } from "../doc-fixture";
import { DriveFiles, DOC_MIME as DRIVE_DOC_MIME, FOLDER_MIME } from "../drive-files";
import { serveFakes, type ProviderFake } from "../slides-provider";
import { GoogleDocEditSessionImpl } from "../../src/docs";

/** Every write coordinate names the tab it applies to; tab bodies index independently. */
type DocCoordinate = { tabId?: string };

type BatchRequest = {
  createNamedRange?: { name: string; range: DocCoordinate };
  deleteNamedRange?: { namedRangeId: string; tabsCriteria?: { tabIds: string[] } };
  insertText?: { location: DocCoordinate & { index: number }; text: string };
  deleteContentRange?: { range: DocCoordinate & { startIndex: number; endIndex: number } };
  updateParagraphStyle?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    paragraphStyle: { namedStyleType?: string };
    fields: string;
  };
  createParagraphBullets?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    bulletPreset: string;
  };
  deleteParagraphBullets?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
  };
  updateTextStyle?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    textStyle?: { link?: { url: string } };
    fields?: string;
  };
  insertComment?: { content: string; range: DocCoordinate & { startIndex: number; endIndex: number } };
  addCommentReply?: {
    commentId?: string;
    suggestionId?: string;
    post: { content?: string; commentAction?: "RESOLVE" | "REOPEN" };
  };
  addDocumentTab?: { tabProperties: { title?: string; parentTabId?: string; index?: number } };
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
  body?: GoogleDocsTab["body"];
  links: { start: number; end: number; url: string }[];
  paragraphStyles?: string[];
  paragraphLists?: ModelListSlot[];
};
type BodyElement = GoogleDocsTab["body"]["content"][number];

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
 * a read, whose answer is fixed when it arrives, so holding it delivers what was then current;
 * Drive's batched read of the scope a binding proves an edit's file in.
 * `applied` holds a content batch after Google has applied it, before it answers.
 */
type RequestKind = "content" | "cleanup" | "create" | "read" | "applied" | "scope";

class DocsModel {
  /** The document this model is, which a fake serving several answers by. */
  documentId = "doc-1";
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  /** How many content batches to fail before Google applies them, as a dropped connection can. */
  unsentContentRequests = 0;
  contentBatches = 0;
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
  readonly tabs: ModelTab[] = [{ id: MAIN_TAB, title: "Main", text: "", links: [] }];
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
  setBody(tabId: string, body: GoogleDocsTab["body"]): void {
    this.#tab(tabId).body = body;
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
    let first = body.requests[0];
    if (first?.insertComment || first?.addCommentReply || body.writeControl?.writeMode === "SUGGEST") {
      return this.#commentWrite(body);
    }
    let isDelete = body.requests.length === 1 && !!body.requests[0].deleteNamedRange;
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
    let deletion = isDelete ? body.requests[0].deleteNamedRange! : undefined;
    let markerTab = deletion && this.markers.get(deletion.namedRangeId)?.tabId;
    if (deletion && markerTab && this.tabs.length > 1 &&
        !deletion.tabsCriteria?.tabIds.includes(markerTab)) {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT",
        message: `Invalid requests[0].deleteNamedRange: No named range with ID: ${deletion.namedRangeId}` } },
        { status: 400 });
    }
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return Response.json({ error: { code: 400, message: "revision mismatch" } }, { status: 400 });
    }
    // Google checks a batch whole before it applies any of it.
    for (let { addDocumentTab } of body.requests) {
      let refusal = addDocumentTab && this.#addTabRefusal(addDocumentTab.tabProperties);
      if (refusal) {
        return Response.json(
          { error: { code: 400, status: "INVALID_ARGUMENT", message: refusal } }, { status: 400 });
      }
    }

    let replies: unknown[] = [];
    let hasContent = false;
    for (const request of body.requests) {
      if (request.deleteNamedRange) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
        continue;
      }
      if (request.addDocumentTab) {
        hasContent = true;
        replies.push({ addDocumentTab: { tabProperties: this.#addTab(request.addDocumentTab.tabProperties) } });
        continue;
      }

      // Google resolves an unqualified coordinate against a default tab, so a request that omits
      // the ID would edit whichever tab that happens to be.
      let coordinate = request.createNamedRange?.range ?? request.insertText?.location ??
        request.deleteContentRange?.range ?? request.updateParagraphStyle?.range ??
        request.createParagraphBullets?.range ?? request.deleteParagraphBullets?.range ??
        request.updateTextStyle?.range;
      if (!coordinate?.tabId) {
        throw new Error(`Google Docs request is missing tabId: ${JSON.stringify(request)}`);
      }
      let tab = this.#tab(coordinate.tabId);

      if (request.createNamedRange) {
        let id = `marker-${this.#nextMarkerId++}`;
        this.addMarker(request.createNamedRange.name, id, tab.id);
        this.markerTabIds.push(tab.id);
        replies.push({ createNamedRange: { namedRangeId: id } });
        continue;
      }

      hasContent = true;
      if (request.insertText) {
        this.#insertText(
          tab, request.insertText.location.index, request.insertText.text,
        );
      } else if (request.deleteContentRange) {
        let { startIndex, endIndex } = request.deleteContentRange.range;
        this.#deleteText(tab, startIndex, endIndex);
      } else if (request.updateParagraphStyle) {
        let { range, paragraphStyle, fields } = request.updateParagraphStyle;
        if (paragraphStyle.namedStyleType) {
          this.#setParagraphStyle(tab, range, paragraphStyle.namedStyleType);
        }
        if (fields.split(",").includes("indentStart")) this.#clearIndent(tab, range);
      } else if (request.deleteParagraphBullets) {
        this.#setBullets(tab, request.deleteParagraphBullets.range);
      } else if (request.createParagraphBullets) {
        this.#setBullets(
          tab, request.createParagraphBullets.range, request.createParagraphBullets.bulletPreset,
        );
      } else if (request.updateTextStyle && (
        request.updateTextStyle.textStyle?.link || request.updateTextStyle.fields?.includes("link")
      )) {
        let { startIndex, endIndex } = request.updateTextStyle.range;
        this.#setLink(
          tab, startIndex - 1, endIndex - 1,
          request.updateTextStyle.textStyle?.link?.url,
        );
      }
      replies.push({});
    }
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

  /** Adds an empty tab as `addDocumentTab` does, returning its properties as Google replies. */
  #addTab({ title, parentTabId, index }: { title?: string; parentTabId?: string; index?: number }) {
    let siblings = this.tabs.filter(tab => tab.parentId === parentTabId);
    let at = index ?? siblings.length;
    let tab: ModelTab = {
      id: `t.added-${this.#nextTabId++}`, title: title || `Tab ${this.tabs.length + 1}`,
      ...parentTabId === undefined ? {} : { parentId: parentTabId }, text: "", links: [],
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
    requests: BatchRequest[]; writeControl?: { requiredRevisionId?: string; writeMode?: "SUGGEST" };
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
      let [{ deleteContentRange }, insert] = body.requests;
      let { startIndex, endIndex, tabId } = deleteContentRange!.range;
      let old = this.#tab(tabId!).text.slice(startIndex - 1, endIndex - 1);
      let id = `suggest.s${this.suggestions.length + 1}`;
      this.suggestions.push({
        suggestionId: id, notes: [],
        summaryText: insert?.insertText ? `Replace: “${old}” with “${insert.insertText.text}”` : `Delete: “${old}”`,
      });
      suggestionResponses.push({ createdSuggestionIds: [id] });
    }
    for (let request of body.requests) {
      if (request.insertComment) {
        let { content, range } = request.insertComment;
        let quote = this.#tab(range.tabId!).text.slice(range.startIndex - 1, range.endIndex - 1);
        let thread = this.addThread(content, { quote, me: true });
        replies.push({ insertComment: { commentThread: { commentId: thread.commentId } } });
      } else if (request.addCommentReply?.suggestionId) {
        let suggestion = this.suggestions.find(
          candidate => candidate.suggestionId === request.addCommentReply!.suggestionId);
        if (!suggestion) return refuse(404, "NOT_FOUND", "No such suggestion.");
        suggestion.notes.push(request.addCommentReply.post.content ?? "");
        replies.push({});
      } else if (request.addCommentReply) {
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

  #insertText(tab: ModelTab, index: number, text: string): void {
    if (tab.body) {
      this.#replaceBodyText(tab, index, index, text);
      return;
    }
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
    if (tab.body) {
      this.#replaceBodyText(tab, startIndex, endIndex, "");
      return;
    }
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

  #replaceBodyText(
    tab: ModelTab, startIndex: number, endIndex: number, replacement: string,
  ): void {
    let content = tab.body!.content;
    for (let structureIndex = 0; structureIndex < content.length; structureIndex++) {
      let structure = content[structureIndex];
      let elements = structure.paragraph?.elements;
      if (!elements) continue;
      let elementIndex = elements.findIndex(element => element.textRun &&
        startIndex >= element.startIndex && endIndex <= element.endIndex);
      if (elementIndex < 0) continue;

      let element = elements[elementIndex];
      let text = element.textRun!.content;
      let start = startIndex - element.startIndex;
      let end = endIndex - element.startIndex;
      element.textRun!.content = text.slice(0, start) + replacement + text.slice(end);
      let delta = replacement.length - (endIndex - startIndex);
      element.endIndex += delta;
      for (let index = elementIndex + 1; index < elements.length; index++) {
        elements[index].startIndex += delta;
        elements[index].endIndex += delta;
      }
      structure.endIndex += delta;
      for (let index = structureIndex + 1; index < content.length; index++) {
        this.#shiftBodyElement(content[index], delta);
      }
      return;
    }
    throw new Error("Fixture cannot edit structured content");
  }

  #shiftBodyElement(element: BodyElement, delta: number): void {
    element.startIndex += delta;
    element.endIndex += delta;
    for (let part of element.paragraph?.elements ?? []) {
      part.startIndex += delta;
      part.endIndex += delta;
    }
    for (let row of element.table?.tableRows ?? []) {
      row.startIndex += delta;
      row.endIndex += delta;
      for (let cell of row.tableCells ?? []) {
        cell.startIndex += delta;
        cell.endIndex += delta;
        for (let child of cell.content ?? []) this.#shiftBodyElement(child, delta);
      }
    }
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
    if (tab.body) {
      for (let element of tab.body.content) {
        if (element.paragraph && range.startIndex < element.endIndex &&
            range.endIndex > element.startIndex) {
          element.paragraph.paragraphStyle.namedStyleType = namedStyleType;
        }
      }
      return;
    }
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
    let lists: GoogleDocsTab["lists"] = {};
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
      documentId: this.documentId,
      title: "Test document",
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
};

const STANDALONE: Run = {
  name: "bound directly",
  drive: false,
  outOfOrder: (earlier, later) =>
    `Google Doc edits must be approved in order. Approve earlier edit ${earlier} before edit ${later}.`,
  appliedAgain: answer => expect(answer).toMatch(/Unknown pending/),
  unapplied: reason => `Pending Google Doc edit could not be applied: ${reason}`,
};

const THROUGH_DRIVE: Run = {
  name: "opened from a read and write Drive binding",
  drive: true,
  outOfOrder: () => "Changes to one file apply in the order they were queued. Approve or reject " +
    "the earlier change to this file first.",
  appliedAgain: answer => expect(answer).toBeNull(),
  unapplied: reason => reason,
};

/**
 * The runs of a block that asserts what the engine does. A block runs bound directly alone when it
 * is about what only a Doc's own binding has: metadata dated by the revisions it observed, edits
 * stored in its own store under an earlier rendering or before tabs, creating a Doc, an Office
 * file connected as a Doc, its comments, and its stored layout. Within a block that runs twice, a
 * test that reads or writes the bound Doc's storage, or counts the fetches of its stored snapshot,
 * runs bound directly alone, and says why where that is not the reason.
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ADD_DOCUMENT_TAB = { tag: "addDocumentTab", label: "New document tabs" };

describe.each(RUNS)("Google Doc auto-approval, $name", r => {
  inRun(r);

  const EDIT_DOCUMENT = { tag: "editDocument", label: "Document edits" };

  // A Drive binding's catalog is its own (drive-editors.test.ts).
  it.skipIf(r.drive)("reports document edits, new tabs and Doc comments as its auto-approvable kinds", async () => {
    expect(await hooks().docAutoApprovable("verdict-kinds")).toEqual([
      EDIT_DOCUMENT, ADD_DOCUMENT_TAB, { tag: "docComments", label: "Google Doc comments" },
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
    )).rejects.toThrow("replaceText: structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
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

  // Queues the next edit only once the first is applied: a Drive binding's next session then drops
  // the receipt, no edit of its Doc being left to approve (brief §3.3, and the Drive block below).
  it.skipIf(r.drive)("keeps the next action pending while receipt cleanup fails", async () => {
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
  // Not run through Drive: holding a Docs request from the test hangs a Drive binding's apply in
  // this harness, for a reason not yet found; the direct run covers the engine both share.
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
  // Not run through Drive: holding a Docs request from the test hangs a Drive binding's apply in
  // this harness, for a reason not yet found; the direct run covers the engine both share.
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
  // Not run through Drive: holding a Docs request from the test hangs a Drive binding's apply in
  // this harness, for a reason not yet found; the direct run covers the engine both share.
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

describe.each(RUNS)("Google Doc tab isolation, $name", r => {
  inRun(r);

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
  const GENERIC_READ = "Read the content of one tab of the document.";

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
    markdown: "shared\n", sourceMap: { blocks: [], protectedRanges: [] }, bodyEndIndex: 8,
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
    expect(made).toMatchObject({ title: "Notes", text: "" });
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

  it("keeps its edits, counter, snapshot, receipt and revision under the keys it has always used", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.cleanupFailures = 1;
    docs.install();
    let facet = "stored-layout-doc";

    let first = await hooks().submitAppend(facet, "first");
    await hooks().readMetadata(facet);
    expect(await hooks().storedKeys(facet, "doc")).toEqual([
      "docMetadataRevision", "docSnapshot", "pending:action:1", "pending:nextActionId",
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
    expect(await hooks().storedKeys(facet, "doc")).toEqual([
      "docMetadataRevision", "docWriteReceipt", "pending:nextActionId",
    ]);
    expect((await stored(facet, "docWriteReceipt")).kv)
      .toEqual({ actionId: first, markerId: expect.any(String) });

    // A rejection drops the snapshot: the next read fetches the document again.
    let second = await hooks().submitAppend(facet, "second");
    let third = await hooks().submitAppend(facet, "third");
    expect(await hooks().rejectAction(facet, third)).toBeUndefined();
    expect(await hooks().storedKeys(facet, "doc")).toEqual([
      "docMetadataRevision", "docWriteReceipt", `pending:action:${second}`, "pending:nextActionId",
    ]);

    // A comment write is numbered by the edits' counter, under a prefix of its own.
    let comment = await hooks().callDoc(facet, "comment", ["Why?", { quote: "base" }]);
    expect(comment.actionId).toBe(4);
    expect((await stored(facet, "pending:nextActionId")).kv).toBe(5);
    expect((await stored(facet, "docComments:action:4")).kv).toMatchObject({
      v: 2, state: "pending", action: { kind: "createComment" },
    });
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

  /** The stored record of action `id` of the Drive facet `facet`. */
  async function record(facet: string, id: number) {
    let stored = await rawHooks().driveStored(`drive:${facet}`, DRIVE_DOC, `drive:action:${id}`);
    return stored === null ? null : JSON.parse(stored) as {
      state: string; error?: string;
      action: { kind: string; payload: { change: { writeId: string } } };
    };
  }

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
});
