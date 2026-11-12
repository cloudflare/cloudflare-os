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
  /**
   * The tab's named styles, which say what text in a paragraph of each style is unless its own
   * style says otherwise. Absent only where a test builds a tab without them.
   */
  namedStyles?: NamedStyles;
}

/** A tab's named styles, as `documents.get` returns them. */
export type NamedStyles = {
  styles?: { namedStyleType?: string; textStyle?: Pick<TextStyle, "bold" | "italic" | "strikethrough"> }[];
};

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

/**
 * A table embedded in a document body or table cell.
 *
 * A table sits between two paragraphs of its container: it is never the container's first or
 * last element, and never directly beside another table. Its position is the `startIndex` of
 * the structural element that holds it, which is the exact value a `TableCellLocation` must
 * name. A table takes one index for its start, before its first row, and one for its end, after
 * its last row.
 */
export type Table = {
  tableRows?: TableRow[];
  /**
   * The width of each column: `FIXED_WIDTH` with its `width`, or `EVENLY_DISTRIBUTED`, sharing
   * what the fixed columns leave of the page's width.
   */
  tableStyle?: { tableColumnProperties?: { widthType?: string; width?: Dimension }[] };
  /** IDs of the suggestions that would insert this table; empty or absent for a table that exists. */
  suggestedInsertionIds?: string[];
  /** IDs of the suggestions that would delete this table. */
  suggestedDeletionIds?: string[];
}

/**
 * One row in a Google Docs table.
 *
 * A row takes one index for its start, before its first cell, and `endIndex` is the end of its
 * last cell. A row that is only suggested, or suggested for deletion, is listed and indexed like
 * any other, marked by its suggestion IDs.
 */
export type TableRow = {
  startIndex: number;
  endIndex: number;
  tableCells?: TableCell[];
  /**
   * The row's style: `tableHeader` is true on a row pinned as a header row that repeats on
   * every page, and `minRowHeight` is the least height the row takes, 0 left out.
   */
  tableRowStyle?: { tableHeader?: boolean; minRowHeight?: Dimension };
  /** IDs of the suggestions that would insert this row; empty or absent for a row that exists. */
  suggestedInsertionIds?: string[];
  /** IDs of the suggestions that would delete this row. */
  suggestedDeletionIds?: string[];
}

/** A length; Google leaves out a magnitude of 0. Table lengths are in points (`PT`). */
export type Dimension = { magnitude?: number; unit?: string };

/** A colour that may be none: `color` left out, or with no `rgbColor`, is none. */
export type OptionalColor = { color?: { rgbColor?: { red?: number; green?: number; blue?: number } } };

/**
 * One edge of a table cell. Google refuses an edge without a colour or a `dashStyle` (`SOLID`,
 * `DOT` or `DASH`), and draws none for one 0 wide.
 */
export type TableCellBorder = { color?: OptionalColor; width?: Dimension; dashStyle?: string };

/**
 * A table cell's style. A field Google leaves out is the default an inserted table has:
 * no shading, top alignment, 5pt of padding on each side, and a 1pt solid black border.
 */
export type TableCellStyle = {
  rowSpan?: number;
  columnSpan?: number;
  backgroundColor?: OptionalColor;
  /** `TOP`, `MIDDLE` or `BOTTOM`. */
  contentAlignment?: string;
  paddingTop?: Dimension;
  paddingRight?: Dimension;
  paddingBottom?: Dimension;
  paddingLeft?: Dimension;
  borderTop?: TableCellBorder;
  borderRight?: TableCellBorder;
  borderBottom?: TableCellBorder;
  borderLeft?: TableCellBorder;
};

/**
 * One table cell, whose contents use the same recursive structure as the document body.
 *
 * A cell takes one index for its start and then holds its content, which is never empty: a cell
 * holds at least one paragraph, so an empty cell spans two indexes. Text goes into a paragraph
 * of the cell, never at the cell's own index. A cell that is only suggested, or suggested for
 * deletion, is listed and indexed like any other, marked by its suggestion IDs.
 */
export type TableCell = {
  startIndex: number;
  endIndex: number;
  content?: StructuralElement[];
  /**
   * The cell's row and column spans. A merged cell is the top-left of the cells it merges: it
   * carries a `rowSpan` or `columnSpan` above 1 and the content of every cell it covers. The
   * covered cells stay in their rows' `tableCells`, empty and with spans of 1 like a cell that is
   * not merged, so every row lists as many cells as the table has columns.
   */
  tableCellStyle?: TableCellStyle;
  /**
   * IDs of the suggestions that would insert this cell; empty or absent for a cell that exists.
   * A suggested column marks its cells, not the rows that hold them.
   */
  suggestedInsertionIds?: string[];
  /**
   * IDs of the suggestions that would delete this cell. A row suggested for deletion marks its
   * cells as well as the row.
   */
  suggestedDeletionIds?: string[];
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
  /** A dropdown chip, which takes one index. */
  dropdown?: {
    dropdownId?: string;
    textStyle?: TextStyle;
    dropdownProperties?: {
      dropdownDefinitionId?: string;
      selectedOptionId?: string;
      displayValue?: string;
    };
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
      let { body, lists, namedRanges, namedStyles } = documentTab as Record<string, unknown>;
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
        ...namedStyles === undefined ? {} : { namedStyles: tabCollection<NamedStyles>(namedStyles) },
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
// Types modeling the `documents.batchUpdate` requests the gatekeeper sends.
// ---------------------------------------------------------------------------

/** A position in one tab. Every write coordinate names its tab: tab bodies index independently. */
export type DocsLocation = { index: number; tabId: string };

/** A half-open range in one tab. */
export type DocsRange = { startIndex: number; endIndex: number; tabId: string };

/** One cell of a table, named by the table's start index and the cell's row and column. */
export type TableCellLocation = {
  tableStartLocation: DocsLocation;
  rowIndex: number;
  columnIndex: number;
};

/** The `documents.batchUpdate` requests the Docs gatekeeper sends. */
export type GoogleDocsRequest =
  | { insertText: { location: DocsLocation; text: string } }
  | { deleteContentRange: { range: DocsRange } }
  | { updateTextStyle: { range: DocsRange; textStyle: TextStyle; fields: string } }
  | {
    updateParagraphStyle: {
      range: DocsRange; paragraphStyle: Record<string, unknown>; fields: string;
    };
  }
  | { createParagraphBullets: { range: DocsRange; bulletPreset: string } }
  | { deleteParagraphBullets: { range: DocsRange } }
  | { insertTable: { rows: number; columns: number; location: DocsLocation } }
  | { insertTableRow: { tableCellLocation: TableCellLocation; insertBelow: boolean } }
  | { insertTableColumn: { tableCellLocation: TableCellLocation; insertRight: boolean } }
  | { deleteTableRow: { tableCellLocation: TableCellLocation } }
  | { deleteTableColumn: { tableCellLocation: TableCellLocation } }
  | { pinTableHeaderRows: { tableStartLocation: DocsLocation; pinnedHeaderRowsCount: number } }
  | {
    updateTableCellStyle: {
      tableRange: { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number };
      tableCellStyle: TableCellStyle;
      fields: string;
    };
  }
  | {
    mergeTableCells: {
      tableRange: { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number };
    };
  }
  | {
    unmergeTableCells: {
      tableRange: { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number };
    };
  }
  | {
    updateTableRowStyle: {
      tableStartLocation: DocsLocation;
      rowIndices: number[];
      tableRowStyle: { minRowHeight: { magnitude: number; unit: "PT" } };
      fields: string;
    };
  }
  | {
    updateTableColumnProperties: {
      tableStartLocation: DocsLocation;
      columnIndices: number[];
      tableColumnProperties: {
        widthType: "FIXED_WIDTH" | "EVENLY_DISTRIBUTED"; width?: { magnitude: number; unit: "PT" };
      };
      fields: string;
    };
  };

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const DOCS_API_BASE = "https://docs.googleapis.com/v1/documents";
// A document is read whole, and its JSON, asked for without indentation, is mostly structure: a
// paragraph or a table cell takes far more bytes than its text. 10 MiB bounds that answer, which
// is parsed in memory.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The longest a Docs write's requests can take before it settles or is abandoned: three attempts
 * (the first, one after an auth refresh, one after a reconnect changed the stored token).
 */
export const DOCS_WRITE_MAX_MS = 3 * REQUEST_TIMEOUT_MS;

/**
 * A Docs write Google answered with success while reporting that its comment update was not
 * saved (`commentUpdateState`), so that comment or reply was not posted.
 */
export class DocsCommentNotSavedError extends Error {}

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

  /**
   * Fetch a document and flatten its tab tree.
   *
   * The answer is requested as compact JSON. Google indents it otherwise, and since the answer
   * is mostly structure, the indentation would bring a document with tables to
   * `MAX_RESPONSE_BYTES` far sooner.
   */
  async getDocument(documentId: string): Promise<GoogleDocsDocument> {
    let { documentId: id, title, revisionId, tabs } = await this.#request<GoogleDocsResponse>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?includeTabsContent=true&prettyPrint=false`,
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
    requests: readonly GoogleDocsRequest[],
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
      requests: readonly unknown[];
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
    requireCommentSaved(result.commentUpdateState);
    let id = result.replies?.[0]?.insertComment?.commentThread?.commentId;
    if (typeof id !== "string" || !id) throw new Error("Google Docs returned no comment ID");
    return id;
  }

  /**
   * Send `requests` as one suggestion, refused unless the document is still at
   * `requiredRevisionId` when given. Returns the suggestion's ID, and whether Google saved its
   * comment thread (`commentUpdateState`): the suggestion is made either way, but a note can be
   * posted only on a saved thread.
   */
  async suggest(
    documentId: string, requests: unknown[], requiredRevisionId?: string,
  ): Promise<{ id: string; threadSaved: boolean }> {
    let result = await this.#write(documentId, requests,
      { writeMode: "SUGGEST", requiredRevisionId }, "suggest edit");
    let created = new Set((result.suggestionResponses ?? [])
      .flatMap(response => response?.createdSuggestionIds ?? []));
    let [id, ...more] = created;
    if (typeof id !== "string" || !id || more.length) {
      throw new Error("Google Docs did not return the one suggestion it made");
    }
    return { id, threadSaved: result.commentUpdateState !== COMMENT_NOT_SAVED_STATE };
  }

  /** Reply to suggestion `suggestionId`'s thread with `content`. */
  async replyToSuggestion(documentId: string, suggestionId: string, content: string): Promise<void> {
    let result = await this.#write(documentId,
      [{ addCommentReply: { suggestionId, post: { content } } }], {}, "reply to suggestion");
    requireCommentSaved(result.commentUpdateState);
  }

  /**
   * The document's comment threads, every one the caller can see, anchored or not, and nothing
   * else: one small read. Google lists comments only with suggestions inline, which it refuses an
   * account that can only view the document (403 `PERMISSION_DENIED`), and leaves deleted threads
   * and posts out rather than flagging them.
   */
  async getCommentThreads(documentId: string): Promise<DocsCommentRecord[]> {
    let raw = await this.#request<{ documentId?: unknown; comments?: unknown }>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?includeTabsContent=true&` +
        "suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED&" +
        `fields=${encodeURIComponent(COMMENT_THREADS_FIELDS)}`,
      {},
      "get comment threads",
    );
    if (raw.documentId !== documentId) throw new Error("Google Docs returned a different document");
    if (raw.comments !== undefined && !Array.isArray(raw.comments)) throw new Error(INVALID_COMMENTS);
    return (raw.comments ?? []).map(parseCommentThread);
  }

  /**
   * Reply to comment `commentId` with `content`, resolving or reopening it with `action`. Google
   * refuses a reply to a comment attached to no text (one made through Drive) as invalid, and one
   * to a deleted comment as not found. Returns the reply's post ID.
   */
  async replyToComment(
    documentId: string, commentId: string, content: string, action?: "RESOLVE" | "REOPEN",
  ): Promise<string> {
    let result = await this.#write(documentId, [{
      addCommentReply: { commentId, post: { content, ...(action ? { commentAction: action } : {}) } },
    }], {}, "reply to comment");
    requireCommentSaved(result.commentUpdateState);
    let id = result.replies?.[0]?.addCommentReply?.post?.postId;
    if (typeof id !== "string" || !id) throw new Error("Google Docs returned no reply ID");
    return id;
  }

  async #write(
    documentId: string,
    requests: unknown[],
    writeControl: { writeMode?: "SUGGEST"; requiredRevisionId?: string | undefined },
    operation: string,
  ) {
    let control = Object.fromEntries(Object.entries(writeControl).filter(([, v]) => v !== undefined));
    return this.#request<{
      replies?: {
        insertComment?: { commentThread?: { commentId?: unknown } };
        addCommentReply?: { post?: { postId?: unknown } };
      }[];
      suggestionResponses?: { createdSuggestionIds?: unknown[] }[];
      commentUpdateState?: unknown;
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

/** The `commentUpdateState` of a write whose comment update Google did not save. */
const COMMENT_NOT_SAVED_STATE = "ALL_FAILED_UNKNOWN_REASON";

/** Refuses a comment update Google answered as not saved. */
function requireCommentSaved(state: unknown): void {
  if (state === COMMENT_NOT_SAVED_STATE) {
    throw new DocsCommentNotSavedError("Google Docs did not save the comment.");
  }
}

/**
 * How a Docs write failed: refused before it applied (`absent`), refused for rate (`rateLimited`),
 * or with no answer that says whether it applied (`unknown`). Google checks a batch whole before
 * it applies any of it, so every answer of a status it gives is a refusal.
 */
export function docsWriteFailure(error: unknown): "absent" | "rateLimited" | "unknown" {
  // Google said what it did not save, and nothing else was in the batch.
  if (error instanceof DocsCommentNotSavedError) return "absent";
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

/** One post of a comment thread: the comment itself, or a reply to it. */
export type DocsCommentPost = {
  postId: string;
  /** As sent, but for white space at its ends, which Google trims. */
  content: string;
  author: { displayName: string; me: boolean };
  createTime: string;
  updateTime?: string;
  /** Set on a post that resolved or reopened its thread; a plain reply to a resolved one reopens it. */
  action?: "resolve" | "reopen";
};

/** One comment thread, as `documents.get` shows it to the caller. Its ID is Drive's for it too. */
export type DocsCommentRecord = {
  commentId: string;
  /**
   * Whether it is attached to text, as one made in the editor or with `insertComment` is. It
   * stays attached after its text is deleted. Google Docs takes replies only to these.
   */
  anchored: boolean;
  /** The text it was attached to, when it was. */
  quote?: string;
  resolved: boolean;
  headPost: DocsCommentPost;
  replies: DocsCommentPost[];
};

/** What a comment threads read asks Google for: the threads alone, not the document. */
const COMMENT_POST_FIELDS =
  "postId,content,author(displayName,me),createTime,updateTime,commentAction";
const COMMENT_THREADS_FIELDS = "documentId,comments(commentId,anchorId,status,plainTextQuote," +
  `headPost(${COMMENT_POST_FIELDS}),replies(${COMMENT_POST_FIELDS}))`;

const INVALID_COMMENTS = "Google Docs returned invalid comments";

const COMMENT_ACTIONS: Record<string, DocsCommentPost["action"]> = {
  RESOLVE: "resolve", REOPEN: "reopen",
};

function parseCommentPost(value: unknown): DocsCommentPost {
  if (!value || typeof value !== "object") throw new Error(INVALID_COMMENTS);
  let { postId, content, author, createTime, updateTime, commentAction } =
    value as Record<string, unknown>;
  if (typeof postId !== "string" || !postId || typeof createTime !== "string") {
    throw new Error(INVALID_COMMENTS);
  }
  let { displayName, me } = author && typeof author === "object"
    ? author as Record<string, unknown> : {};
  let action = typeof commentAction === "string" ? COMMENT_ACTIONS[commentAction] : undefined;
  return {
    postId,
    content: typeof content === "string" ? content : "",
    author: { displayName: typeof displayName === "string" ? displayName : "", me: me === true },
    createTime,
    ...(typeof updateTime === "string" ? { updateTime } : {}),
    ...(action ? { action } : {}),
  };
}

function parseCommentThread(value: unknown): DocsCommentRecord {
  if (!value || typeof value !== "object") throw new Error(INVALID_COMMENTS);
  let { commentId, anchorId, status, plainTextQuote, headPost, replies } =
    value as Record<string, unknown>;
  if (typeof commentId !== "string" || !commentId) throw new Error(INVALID_COMMENTS);
  if (replies !== undefined && !Array.isArray(replies)) throw new Error(INVALID_COMMENTS);
  let anchored = typeof anchorId === "string" && anchorId.length > 0;
  return {
    commentId,
    anchored,
    ...(anchored && typeof plainTextQuote === "string" ? { quote: plainTextQuote } : {}),
    resolved: status === "RESOLVED",
    headPost: parseCommentPost(headPost),
    replies: (replies ?? []).map(parseCommentPost),
  };
}

/** The reads a Google Doc session makes. */
export type GoogleDocReader = Pick<GoogleDocsApi,
  "getDocument" | "getDocumentMetadata" | "getRevisionId" | "getCommentThreads">;

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

  /** A document not yet created has no comments. */
  async getCommentThreads(): Promise<DocsCommentRecord[]> {
    return [];
  }
}
