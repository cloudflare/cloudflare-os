// Context Library value/API types. Core treats these opaquely; agents get the read API via
// getTypeScriptTypes().

import type { RpcTarget } from "capnweb";

/** Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased). */
export const VENDOR_ID = "context";

// ---------------------------------------------------------------------------
// Read-session value types
//
// Keep these in sync with CONTEXT_LIBRARY_TYPES in library-gatekeeper.ts.
// ---------------------------------------------------------------------------

/** Search result. */
export type ContextSearchResult = {
  /** Opaque document identifier ("collectionId/path") to pass to read(). */
  docId: string;
  collectionId?: string;
  /** Document title. */
  title: string;
  /** Path within the collection (e.g. "billing/revenue.md"). */
  path?: string;
  /** When/why this document is relevant. */
  description?: string;
  /** A snippet showing the matched region, if available. */
  snippet?: string;
  /** Relevance score (higher is better). */
  score?: number;
};

/** A listing entry returned when browsing the content tree. */
export type ContextListingEntry = {
  type: "collection";
  /** A collectionId — pass to list()/search() to see inside it, not to read() (which takes a docId). */
  id: string;
  title: string;
  description?: string;
  documentCount: number;
} | {
  type: "directory";
  path: string;
  name: string;
} | {
  type: "document";
  docId: string;
  path: string;
  name: string;
  description?: string;
  /** MIME type, so the agent can tell text documents from embeddable binary ones (e.g. images). */
  contentType?: string;
};

/** Top-level collections or a collection subtree. */
export type ContextListing = {
  collectionId?: string;
  path?: string;
  entries: ContextListingEntry[];
};

/** Full document returned by read(); binary content is a data: URI. */
export type ContextReadResult = {
  docId: string;
  title: string;
  path?: string;
  description?: string;
  content: string;
};

/** Document IDs join the collection ID and path with a slash. */
export function encodeDocId(collectionId: string, path: string): string {
  return `${collectionId}/${path}`;
}

/** Invalid IDs resolve to no document. */
export function decodeDocId(docId: string): {collectionId: string; path: string} | null {
  let slashIndex = docId.indexOf("/");
  if (slashIndex < 0) return null;
  let collectionId = docId.slice(0, slashIndex);
  let path = docId.slice(slashIndex + 1);
  return collectionId && path ? {collectionId, path} : null;
}

// ---------------------------------------------------------------------------
// Stored data model
// ---------------------------------------------------------------------------

/** Collection visibility within a sharing domain. */
export type ContextCollectionVisibility = "public" | "private";
export const DEFAULT_GIT_BRANCH = "main";

export type ContextCollectionContent =
  // Content in this collection is managed via the web UI.
  | { source: "web" }
  // Content in this collection is managed via git.
  | { source: "git"; remote: string; branch: string; lastRefreshedAt: Date; commit?: string };

export type ContextCollectionMetadata = {
  /** Random hex ID. */
  id: string;

  /** Optional emoji icon. */
  icon?: string;

  /** Human-readable title. */
  title: string;

  /** Listed and used by agents to decide relevance. */
  description: string;

  visibility: ContextCollectionVisibility;

  created: Date;
  lastUpdated: Date;

  /** Number of documents in this collection. */
  documentCount: number;

  content: ContextCollectionContent;
};

export type ContextGitTokenInfo = {
  id: string;
  expiresAt: string;
};

export type ContextGitTokenList = {
  tokens: ContextGitTokenInfo[];
};

export type ContextGitTokenCreateResult = {
  id: string;
  plaintext: string;
  remote: string;
};

/** Collection summary for listings. */
export type ContextCollectionSummary = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  visibility: ContextCollectionVisibility;
  documentCount: number;
  lastUpdated: Date;
};

/** Stored document. Text bodies are literal text; binary bodies are base64 without a data: prefix. */
export type ContextDocument = {
  /** Primary key within the collection, using "/" separators. */
  path: string;

  /** File name derived from the path. */
  name: string;

  /** What this document covers and when to use it. */
  description: string;

  /** Determines whether `body` is text or base64. */
  contentType: string;

  /** Literal text for text content types; base64 for binary ones. */
  body: string;

  /** Set when this document is a valid skill. */
  skillName?: string;

  lastUpdated: Date;
};

/** Document info without body. */
export type ContextDocumentSummary = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  skillName?: string;
  lastUpdated: Date;
};

/** A user's record of one of their own (private) collections. */
export type OwnedCollectionRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  lastUpdated: Date;
};

/** Collections an account's agents can use: own private plus all public. */
export type EnabledCollectionInfo = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  source: "private" | "public";
  lastUpdated: Date;
};

// ---------------------------------------------------------------------------
// Content-type helpers for context documents
// ---------------------------------------------------------------------------

export const DEFAULT_DOCUMENT_CONTENT_TYPE = "text/markdown";

/** UTF-8 bytes of stored body; base64 overhead caps raw binary around 1 MB. */
export const MAX_DOCUMENT_BODY_BYTES = 1_400_000;

// Map of file extensions (without the dot, lowercased) to MIME types we recognize.
//
// Active types are only returned over RPC, never served from an HTTP origin. Sanitize if that changes.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  text: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  // Code & config, treated as plain text (rendered in the source editor, not the markdown view).
  js: "text/plain",
  mjs: "text/plain",
  cjs: "text/plain",
  jsx: "text/plain",
  ts: "text/plain",
  mts: "text/plain",
  cts: "text/plain",
  tsx: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cc: "text/plain",
  cpp: "text/plain",
  hpp: "text/plain",
  cs: "text/plain",
  php: "text/plain",
  swift: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  zsh: "text/plain",
  sql: "text/plain",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  properties: "text/plain",
  lua: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
};

/** Derive a MIME type from a path's file extension, defaulting to markdown. */
export function contentTypeFromPath(path: string): string {
  let dot = path.lastIndexOf(".");
  if (dot < 0) return DEFAULT_DOCUMENT_CONTENT_TYPE;
  let ext = path.slice(dot + 1).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
}

/** Text bodies are literal/searchable; everything else is base64. SVG is treated as an image. */
export function isTextContentType(contentType: string): boolean {
  contentType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (contentType.startsWith("text/")) return true;
  return (
    contentType === "application/json" ||
    contentType === "application/yaml" ||
    contentType === "application/x-yaml" ||
    contentType === "application/xml"
  );
}

/** Whether a content type is an image we can preview / embed as a data: URI. */
export function isImageContentType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/**
 * Whether a content type is Markdown, which the document viewer renders as prose in View mode
 * (all other text is shown as source). Everything else falls back to the source editor.
 */
export function isMarkdownContentType(contentType: string): boolean {
  return contentType === "text/markdown";
}

// ---------------------------------------------------------------------------
// Per-user management capability (ContextApi)
// ---------------------------------------------------------------------------

/** Per-account management API exposed to the gatekeeper app iframe. */
export interface ContextApi extends RpcTarget {
  /** Gates creating/editing public collections and offering Git-backed collections. */
  getViewerInfo(): Promise<{ isAdmin: boolean; supportsGitCollections: boolean }>;

  createContextCollection(
    title: string, description: string, visibility: ContextCollectionVisibility, icon?: string,
    source?: ContextCollectionContent["source"],
  ): Promise<ContextCollectionMetadata>;
  updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void>;
  syncContextCollectionArtifactSource(collectionId: string): Promise<void>;
  createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult>;
  listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList>;
  revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean>;
  deleteContextCollection(collectionId: string): Promise<void>;
  getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null>;
  listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]>;
  getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null>;
  /** The document's display name is always derived from its path (the file name), so it's not passed. */
  putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void>;
  deleteContextDocument(collectionId: string, path: string): Promise<void>;
  moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void>;
  /** Own private collections plus every public one. */
  listEnabledContextCollections(): Promise<EnabledCollectionInfo[]>;
  /** Whether the viewer may edit this collection: own private collection, or public collection as admin. */
  canWriteContextCollection(collectionId: string): Promise<boolean>;
}
