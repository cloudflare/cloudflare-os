// Google Docs REST API helpers.
//
// This file wraps the Google Docs API (v1) for use by the Google Docs gatekeeper.
// It follows the same pattern as google-api.ts (which wraps the Gmail API).

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { readGoogleJson } from "./google-response";

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
  /** If set, this is an unordered (bullet) list level. e.g. "●" */
  glyphSymbol?: string;
}

/** A structural element in the document body. */
export type StructuralElement = {
  startIndex: number;
  endIndex: number;
  paragraph?: Paragraph;
  sectionBreak?: {};
  table?: {};
  tableOfContents?: {};
}

/** A paragraph (including headings, list items, etc.). */
export type Paragraph = {
  elements: ParagraphElement[];
  paragraphStyle: ParagraphStyle;
  bullet?: Bullet;
}

export type ParagraphStyle = {
  namedStyleType: string;
}

/** Present on paragraphs that are list items. */
export type Bullet = {
  listId: string;
  nestingLevel: number;
}

/** An element within a paragraph (text run, horizontal rule, etc.). */
export type ParagraphElement = {
  startIndex: number;
  endIndex: number;
  textRun?: TextRun;
  horizontalRule?: {};
}

export type TextRun = {
  content: string;
  textStyle: TextStyle;
}

export type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: { url: string };
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
}
