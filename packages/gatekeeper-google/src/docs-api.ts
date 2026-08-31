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

/** Top-level document response from `documents.get`. */
export type GoogleDocsDocument = {
  documentId: string;
  title: string;
  revisionId: string;
  body: { content: StructuralElement[] };
  lists: Record<string, DocList>;
  namedRanges: Record<string, {
    namedRanges: { namedRangeId: string; name?: string }[];
  }>;
}

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

type GoogleDocsTabContent = Pick<GoogleDocsDocument, "body"> & {
  lists?: GoogleDocsDocument["lists"];
  namedRanges?: GoogleDocsDocument["namedRanges"];
};

type GoogleDocsTab = {
  documentTab?: GoogleDocsTabContent;
  childTabs?: GoogleDocsTab[];
};

type GoogleDocsResponse = Pick<
  GoogleDocsDocument, "documentId" | "title" | "revisionId"
> & { tabs?: GoogleDocsTab[] };

type GoogleDocsWriteMarker = { name: string; rangeStart: number };

function singleTabDocument(document: GoogleDocsResponse): GoogleDocsDocument {
  let tabs = document.tabs;
  if (!tabs || tabs.length === 0) {
    throw new Error("Google Docs returned no document tab");
  }

  let [tab] = tabs;
  if (tabs.length !== 1 || tab.childTabs?.length) {
    throw new Error("Multi-tab Google Docs are not supported");
  }
  let tabContent = tab.documentTab;
  if (!tabContent) {
    throw new Error("Google Docs returned a tab without document content");
  }

  return {
    documentId: document.documentId,
    title: document.title,
    revisionId: document.revisionId,
    body: tabContent.body,
    lists: tabContent.lists ?? {},
    namedRanges: tabContent.namedRanges ?? {},
  };
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

  /** Fetch and normalize a single-tab document. */
  async getDocument(documentId: string): Promise<GoogleDocsDocument> {
    let document = await this.#request<GoogleDocsResponse>(
      `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?includeTabsContent=true`,
      {},
      "get document",
    );
    if (document.documentId !== documentId) {
      throw new Error("Google Docs returned a different document");
    }
    return singleTabDocument(document);
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
   * Lightweight revision check. Uses the `fields` query parameter to request
   * only the revisionId, avoiding downloading the full document body.
   *
   * If the API doesn't support field filtering (returns the full doc anyway),
   * that's fine — we just parse revisionId from whatever comes back.
   */
  async getRevisionId(documentId: string): Promise<string> {
    let data = await this.#request<{ revisionId: string }>(
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
