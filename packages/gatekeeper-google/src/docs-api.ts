// Google Docs REST API helpers.
//
// This file wraps the Google Docs API (v1) for use by the Google Docs gatekeeper.
// It follows the same pattern as google-api.ts (which wraps the Gmail API).

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { GoogleApiError, readGoogleJson } from "./google-response";

// ---------------------------------------------------------------------------
// Types modeling the Google Docs API response.
// These are internal — not exported to gadgets. Only the fields we actually
// use are included.
// ---------------------------------------------------------------------------

/**
 * A document from `documents.get`, with Google's recursive tab tree flattened in preorder.
 *
 * Content lives on the tabs: a document itself has none, and every tab body has its own index
 * space, so nothing outside one tab may be read or written with that tab's indices.
 */
export type GoogleDocsDocument = {
  documentId: string;
  title: string;
  /** Google populates this only for callers with edit access, so a reader sees no revision. */
  revisionId?: string;
  /** Every tab, depth-first, parents before children. Never empty. */
  tabs: GoogleDocsTab[];
}

/** One tab's content and its place in the document's tab tree. */
export type GoogleDocsTab = {
  /** Google's immutable tab ID, which every write coordinate into this tab must carry. */
  tabId: string;
  title: string;
  /** The containing tab, absent for a top-level tab. */
  parentTabId?: string;
  /** Position among the tabs sharing this parent. */
  index: number;
  /** Depth in the tab tree; 0 for a top-level tab. */
  nestingLevel: number;
  body: { content: StructuralElement[] };
  /** List definitions this tab's paragraphs reference. */
  lists: Record<string, DocList>;
  /** Named ranges anchored in this tab. */
  namedRanges: NamedRanges;
}

/** Named ranges grouped by name, as `documents.get` returns them. */
export type NamedRanges = Record<string, {
  namedRanges: { namedRangeId: string; name?: string }[];
}>

/** A list definition, referenced by paragraphs that are list items. */
export type DocList = {
  listProperties: {
    nestingLevels: NestingLevel[];
  };
}

/** Describes the glyph style for one nesting level of a list. */
export type NestingLevel = {
  /** If set, this is an ordered (numbered) list level. Values: "DECIMAL", "ALPHA", etc. */
  glyphType?: string;
  /** Number assigned to the first item at this level. */
  startNumber?: number;
  /** If set, this is an unordered (bullet) list level. e.g. "●" */
  glyphSymbol?: string;
}

/** A structural element in the document body. */
export type StructuralElement = {
  startIndex: number;
  endIndex: number;
  paragraph?: Paragraph;
  sectionBreak?: {};
  table?: Table;
  tableOfContents?: {};
}

// The collections in the table types below are optional: the API omits an empty one from its
// JSON rather than sending `[]`.

/** A table embedded in a document body or table cell. */
export type Table = {
  tableRows?: TableRow[];
}

/** One row in a Google Docs table. */
export type TableRow = {
  startIndex: number;
  endIndex: number;
  tableCells?: TableCell[];
}

/** One table cell, whose contents use the same recursive structure as the document body. */
export type TableCell = {
  startIndex: number;
  endIndex: number;
  content?: StructuralElement[];
  tableCellStyle?: {
    rowSpan?: number;
    columnSpan?: number;
  };
}

/** A paragraph (including headings, list items, etc.). */
export type Paragraph = {
  elements: ParagraphElement[];
  paragraphStyle: ParagraphStyle;
  bullet?: Bullet;
  /** Positioned objects tethered to this paragraph. */
  positionedObjectIds?: string[];
}

export type ParagraphStyle = {
  namedStyleType: string;
  /** Set on a title or heading paragraph, and only there: the target of a `#heading=` link. */
  headingId?: string;
}

/** Present on paragraphs that are list items. */
export type Bullet = {
  listId: string;
  nestingLevel?: number;
}

/** An element within a paragraph (text run, smart chip, horizontal rule, etc.). */
export type ParagraphElement = {
  startIndex: number;
  endIndex: number;
  textRun?: TextRun;
  autoText?: {
    type?: string;
    textStyle?: TextStyle;
  };
  horizontalRule?: {};
  pageBreak?: { textStyle?: TextStyle };
  columnBreak?: { textStyle?: TextStyle };
  footnoteReference?: { footnoteId?: string; footnoteNumber?: string; textStyle?: TextStyle };
  equation?: {};
  inlineObjectElement?: { inlineObjectId?: string; textStyle?: TextStyle };
  person?: {
    textStyle?: TextStyle;
    personProperties?: { name?: string; email?: string };
  };
  richLink?: {
    textStyle?: TextStyle;
    richLinkProperties?: { title?: string; uri?: string };
  };
  dateElement?: {
    textStyle?: TextStyle;
    dateElementProperties?: { displayText?: string };
  };
}

export type TextRun = {
  content: string;
  textStyle: TextStyle;
}

type GoogleDocsLink =
  | { url: string }
  | { tabId: string }
  | { bookmark: { id: string; tabId: string } }
  | { heading: { id: string; tabId: string } }
  | { bookmarkId: string }
  | { headingId: string };

export type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: GoogleDocsLink;
}

type GoogleDocsResponse = Pick<
  GoogleDocsDocument, "documentId" | "title" | "revisionId"
> & { tabs?: unknown };

/** Where one write's marker range goes: one character at `rangeStart` inside tab `tabId`. */
type GoogleDocsWriteMarker = { name: string; rangeStart: number; tabId: string };

const INVALID_TAB = "Google Docs returned an invalid tab";

/** An optional provider collection, which must be a plain object when present. */
function tabCollection<T>(value: unknown): T {
  if (value === undefined) return {} as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID_TAB);
  return value as T;
}

/**
 * Flatten Google's recursive `tabs`/`childTabs` tree into a preorder list.
 *
 * Ancestry, sibling order and depth are derived from the tree actually returned rather than read
 * from `tabProperties`, and tab IDs must be unique document-wide, because everything downstream
 * addresses a tab by ID alone.
 */
function normalizeDocumentTabs(tabs: unknown): GoogleDocsTab[] {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw new Error("Google Docs returned no document tab");
  }

  let normalized: GoogleDocsTab[] = [];
  let seen = new Set<string>();

  let visit = (siblings: unknown[], parentTabId: string | undefined, nestingLevel: number) => {
    for (let [index, raw] of siblings.entries()) {
      if (!raw || typeof raw !== "object") throw new Error(INVALID_TAB);
      let { tabProperties, documentTab, childTabs } = raw as Record<string, unknown>;
      if (!tabProperties || typeof tabProperties !== "object") throw new Error(INVALID_TAB);
      let { tabId, title } = tabProperties as Record<string, unknown>;
      if (typeof tabId !== "string" || tabId.length === 0 || typeof title !== "string") {
        throw new Error(INVALID_TAB);
      }
      if (seen.has(tabId)) throw new Error("Google Docs returned a duplicate tab ID");
      seen.add(tabId);

      if (!documentTab || typeof documentTab !== "object") throw new Error(INVALID_TAB);
      let { body, lists, namedRanges } = documentTab as Record<string, unknown>;
      // A real body always holds at least a section break, and `bodyEndIndex` arithmetic assumes
      // it: an empty one would place an append at index -1.
      if (!body || typeof body !== "object" || !("content" in body) ||
          !Array.isArray(body.content) || body.content.length === 0) {
        throw new Error(INVALID_TAB);
      }
      // Structural elements stay unvalidated here; the converter reads them defensively.
      let content = body.content as StructuralElement[];

      normalized.push({
        tabId,
        title,
        ...parentTabId === undefined ? {} : { parentTabId },
        index,
        nestingLevel,
        body: { content },
        lists: tabCollection<GoogleDocsTab["lists"]>(lists),
        namedRanges: tabCollection<NamedRanges>(namedRanges),
      });

      if (childTabs === undefined) continue;
      if (!Array.isArray(childTabs)) throw new Error(INVALID_TAB);
      visit(childTabs, tabId, nestingLevel + 1);
    }
  };

  visit(tabs, undefined, 0);
  return normalized;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const DOCS_API_BASE = "https://docs.googleapis.com/v1/documents";
// A native Doc is limited to roughly one million characters; 10 MiB bounds its expanded JSON form.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export class GoogleDocsApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<T> {
    let response = await fetchWithAuthRetry(
      url, init, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return readGoogleJson<T>(response, {
      provider: "Google Docs", operation, maxBytes: MAX_RESPONSE_BYTES,
    });
  }

  /** Create an empty document titled `title` in the caller's My Drive, returning its ID. */
  async createDocument(title: string): Promise<string> {
    let { documentId } = await this.#request<{ documentId?: unknown }>(
      `${DOCS_API_BASE}?fields=documentId`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
      "create document",
    );
    if (typeof documentId !== "string" || documentId.length === 0) {
      throw new Error("Google Docs returned no document ID");
    }
    return documentId;
  }

  /** Fetch a document and flatten its tab tree. */
  async getDocument(documentId: string): Promise<GoogleDocsDocument> {
    let { documentId: id, title, revisionId, tabs } = await this.#request<GoogleDocsResponse>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?includeTabsContent=true`,
      {},
      "get document",
    );
    if (id !== documentId) {
      throw new Error("Google Docs returned a different document");
    }
    return { documentId: id, title, revisionId, tabs: normalizeDocumentTabs(tabs) };
  }

  /**
   * Fetch document metadata without loading or validating tab content.
   *
   * `revisionId` comes along because callers need a change token: `documents.get` exposes no
   * modification time, so the revision is the only signal that the document actually changed.
   */
  async getDocumentMetadata(
    documentId: string,
  ): Promise<Pick<GoogleDocsDocument, "documentId" | "title" | "revisionId">> {
    let document = await this.#request<
      Pick<GoogleDocsDocument, "documentId" | "title" | "revisionId">
    >(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?fields=documentId,title,revisionId`,
      {},
      "get document metadata",
    );
    if (document.documentId !== documentId) {
      throw new Error("Google Docs returned a different document");
    }
    return document;
  }

  /**
   * Lightweight revision check, requesting only the revisionId rather than the whole body.
   *
   * Absent when the caller cannot edit the document, in which case there is no change token and
   * a reader has to refetch to see whether anything moved.
   */
  async getRevisionId(documentId: string): Promise<string | undefined> {
    let data = await this.#request<{ revisionId?: string }>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?fields=revisionId`,
      {},
      "get revision ID",
    );
    return data.revisionId;
  }

  /** Send document updates, revision-locking marked writes. */
  async batchUpdate(
    documentId: string,
    requests: unknown[],
    revisionId?: string,
    writeMarker?: GoogleDocsWriteMarker,
  ): Promise<{ revisionId: string; writeMarkerId?: string }> {
    let markedRequests = writeMarker
      ? [{
          createNamedRange: {
            name: writeMarker.name,
            range: {
              startIndex: writeMarker.rangeStart,
              endIndex: writeMarker.rangeStart + 1,
              tabId: writeMarker.tabId,
            },
          },
        }, ...requests]
      : requests;
    let body: {
      requests: unknown[];
      writeControl?: { requiredRevisionId: string } | { targetRevisionId: string };
    } = { requests: markedRequests };
    if (revisionId) {
      body.writeControl = writeMarker
        ? { requiredRevisionId: revisionId }
        : { targetRevisionId: revisionId };
    }

    let result = await this.#request<{
      replies?: { createNamedRange?: { namedRangeId?: string } }[];
      writeControl?: { requiredRevisionId?: string };
    }>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "batch update document",
    );
    let markerId = result.replies?.[0]?.createNamedRange?.namedRangeId;
    let update: { revisionId: string; writeMarkerId?: string } = {
      revisionId: result.writeControl?.requiredRevisionId ?? "",
    };
    if (writeMarker && typeof markerId === "string" && markerId.length > 0) {
      update.writeMarkerId = markerId;
    }
    return update;
  }

  /** Delete one named range by its exact provider ID. */
  async deleteNamedRange(documentId: string, namedRangeId: string): Promise<void> {
    await this.#request(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ deleteNamedRange: { namedRangeId } }] }),
      },
      "delete named range",
    );
  }

  /**
   * Fetch a document as a write must be based on it, suggestions inline, with the suggestion
   * threads the caller can see. Comment threads come along too but are not kept: Drive lists the
   * same comments under the same IDs.
   */
  async getDocumentWithSuggestions(
    documentId: string,
  ): Promise<{ document: GoogleDocsDocument; suggestions: DocsSuggestionRecord[] }> {
    let raw = await this.#request<GoogleDocsResponse & { suggestions?: unknown }>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?includeTabsContent=true&` +
        "suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED",
      {},
      "get document with suggestions",
    );
    if (raw.documentId !== documentId) throw new Error("Google Docs returned a different document");
    let { title, revisionId, tabs, suggestions } = raw;
    if (suggestions !== undefined && !Array.isArray(suggestions)) throw new Error(INVALID_THREADS);
    return {
      document: { documentId, title, revisionId, tabs: normalizeDocumentTabs(tabs) },
      suggestions: (suggestions ?? []).map(parseSuggestion),
    };
  }

  /**
   * Insert one comment anchored to `range`, refused unless the document is still at
   * `requiredRevisionId` when given. Returns the comment's ID, which Drive lists it under too.
   */
  async insertComment(
    documentId: string, content: string, range: DocsRange, requiredRevisionId?: string,
  ): Promise<string> {
    let result = await this.#write(documentId,
      [{ insertComment: { content, range } }], { requiredRevisionId }, "insert comment");
    let id = result.replies?.[0]?.insertComment?.commentThread?.commentId;
    if (typeof id !== "string" || !id) throw new Error("Google Docs returned no comment ID");
    return id;
  }

  /**
   * Send `requests` as one suggestion, refused unless the document is still at
   * `requiredRevisionId` when given. Returns the suggestion's ID.
   */
  async suggest(
    documentId: string, requests: unknown[], requiredRevisionId?: string,
  ): Promise<string> {
    let result = await this.#write(documentId, requests,
      { writeMode: "SUGGEST", requiredRevisionId }, "suggest edit");
    let created = new Set((result.suggestionResponses ?? [])
      .flatMap(response => response?.createdSuggestionIds ?? []));
    let [id, ...more] = created;
    if (typeof id !== "string" || !id || more.length) {
      throw new Error("Google Docs did not return the one suggestion it made");
    }
    return id;
  }

  /** Reply to suggestion `suggestionId`'s thread with `content`. */
  async replyToSuggestion(documentId: string, suggestionId: string, content: string): Promise<void> {
    await this.#write(documentId,
      [{ addCommentReply: { suggestionId, post: { content } } }], {}, "reply to suggestion");
  }

  async #write(
    documentId: string,
    requests: unknown[],
    writeControl: { writeMode?: "SUGGEST"; requiredRevisionId?: string | undefined },
    operation: string,
  ) {
    let control = Object.fromEntries(Object.entries(writeControl).filter(([, v]) => v !== undefined));
    return this.#request<{
      replies?: { insertComment?: { commentThread?: { commentId?: unknown } } }[];
      suggestionResponses?: { createdSuggestionIds?: unknown[] }[];
    }>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests, ...(Object.keys(control).length ? { writeControl: control } : {}),
        }),
      },
      operation,
    );
  }
}

/**
 * How a Docs write failed: refused before it applied (`absent`), refused for rate (`rateLimited`),
 * or with no answer that says whether it applied (`unknown`). Google checks a batch whole before
 * it applies any of it, so every answer of a status it gives is a refusal.
 */
export function docsWriteFailure(error: unknown): "absent" | "rateLimited" | "unknown" {
  if (!(error instanceof GoogleApiError)) return "unknown";
  let { providerStatus, providerReasons } = error;
  if (providerStatus === "RESOURCE_EXHAUSTED" ||
      providerReasons.some(reason => /rate.?limit/i.test(reason))) {
    return "rateLimited";
  }
  return providerStatus !== undefined && DOCS_REFUSALS.has(providerStatus) ? "absent" : "unknown";
}

const DOCS_REFUSALS = new Set([
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "PERMISSION_DENIED", "NOT_FOUND", "UNAUTHENTICATED",
]);

/** Whether a Docs request was refused because the token lacks a scope it needs. */
export function docsLacksScope(error: unknown): boolean {
  return error instanceof GoogleApiError &&
    error.providerReasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
}

/** Whether a Docs request was refused because the document is gone or not shown to the caller. */
export function docsFileInvisible(error: unknown): boolean {
  return error instanceof GoogleApiError && !docsLacksScope(error) &&
    (error.providerStatus === "NOT_FOUND" || error.providerStatus === "PERMISSION_DENIED");
}

/** Whether a Docs write was refused as invalid, which a document changed since it was read is too. */
export function docsWriteInvalid(error: unknown): boolean {
  return error instanceof GoogleApiError && error.providerStatus === "INVALID_ARGUMENT";
}

/** A range of one tab's body, in UTF-16 code units. */
export type DocsRange = { startIndex: number; endIndex: number; tabId: string };

/** One post of a suggestion thread, as `documents.get` shows it to the caller. */
export type DocsPostRecord = {
  content: string;
  /** Whether the caller wrote it. */
  me: boolean;
  createTime: string;
  deleted: boolean;
};

/** One suggestion thread, as `documents.get` shows it with comments included. */
export type DocsSuggestionRecord = {
  suggestionId: string;
  /** What the suggestion changes, as Google sums it up, such as `Replace: “a” with “b”`. */
  summaryText: string;
  headPost: DocsPostRecord;
  replies: DocsPostRecord[];
};

const INVALID_THREADS = "Google Docs returned invalid suggestions";

function parsePost(value: unknown): DocsPostRecord {
  if (!value || typeof value !== "object") throw new Error(INVALID_THREADS);
  let { content, author, createTime, deleted } = value as Record<string, unknown>;
  let me = !!author && typeof author === "object" && (author as Record<string, unknown>).me === true;
  if (typeof createTime !== "string") throw new Error(INVALID_THREADS);
  return {
    content: typeof content === "string" ? content : "", me, createTime, deleted: deleted === true,
  };
}

function parseSuggestion(value: unknown): DocsSuggestionRecord {
  if (!value || typeof value !== "object") throw new Error(INVALID_THREADS);
  let { suggestionId, summaryText, headPost, replies } = value as Record<string, unknown>;
  if (typeof suggestionId !== "string" || !suggestionId) throw new Error(INVALID_THREADS);
  if (replies !== undefined && !Array.isArray(replies)) throw new Error(INVALID_THREADS);
  return {
    suggestionId,
    summaryText: typeof summaryText === "string" ? summaryText : "",
    headPost: parsePost(headPost),
    replies: (replies ?? []).map(parsePost),
  };
}

/** The reads a Google Doc session makes. */
export type GoogleDocReader = Pick<GoogleDocsApi, "getDocument" | "getDocumentMetadata" | "getRevisionId">;

/** The tab ID Google gives a new document's only tab, and so the blank stand-in's. */
export const BLANK_DOC_TAB_ID = "t.0";

/** Revision of the blank stand-in, which never changes. */
const BLANK_DOC_REVISION = "blank";

/**
 * A document not yet created, read as Google returns a new one: one tab holding one empty
 * paragraph. Makes no request.
 */
export class BlankGoogleDoc implements GoogleDocReader {
  constructor(private title: string) {}

  async getDocument(documentId: string): Promise<GoogleDocsDocument> {
    let tab: GoogleDocsTab = {
      tabId: BLANK_DOC_TAB_ID,
      title: "Tab 1",
      index: 0,
      nestingLevel: 0,
      lists: {},
      namedRanges: {},
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          {
            startIndex: 1,
            endIndex: 2,
            paragraph: {
              elements: [{ startIndex: 1, endIndex: 2, textRun: { content: "\n", textStyle: {} } }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          },
        ],
      },
    };
    return { documentId, title: this.title, revisionId: BLANK_DOC_REVISION, tabs: [tab] };
  }

  async getDocumentMetadata(
    documentId: string,
  ): Promise<Pick<GoogleDocsDocument, "documentId" | "title" | "revisionId">> {
    return { documentId, title: this.title, revisionId: BLANK_DOC_REVISION };
  }

  async getRevisionId(): Promise<string | undefined> {
    return BLANK_DOC_REVISION;
  }
}
