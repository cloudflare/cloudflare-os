// Thin wrapper around the Confluence Cloud REST API v2, the Atlassian OAuth 2.0 (3LO) helpers used
// by the connect flow, and the pure URL/CQL helpers used to route resource URLs and build queries.
//
// All product API calls go through the OAuth gateway:
//   https://api.atlassian.com/ex/confluence/{cloudId}/wiki/...
// v2 (`/wiki/api/v2/...`) requires granular scopes and is used for everything with a v2 equivalent.
// A few capabilities have no v2 endpoint (CQL search, label writes, attachment upload, restore);
// those fall back to the v1 (`/wiki/rest/api/...`) endpoints and degrade gracefully if Atlassian
// has also removed them.
//
// v2 response shapes are modelled with our own lean types (the confluence.js library only models
// the removed v1 shapes). Shapes are verified against the v2 reference and OpenAPI spec:
//   https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json
//
// Every request is sent through `confluenceUpstream` (`confluence-upstream.ts`), which gives each
// attempt its timeout, sends a read again after a transient failure, follows no redirect unless the
// request says so, and counts each attempt as a subservice metric.

import type {
  Attachment,
  Comment,
  ConfluenceUser,
  ContentMetadata,
  ContentStatus,
  ContentSummary,
  ContentType,
  SpaceMetadata,
  SpaceSummary,
  SpaceType,
} from "./types";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { CallAnswer, UpstreamRequestInit } from "@gadgets/gatekeeper-kit/upstream";
import { storageToMarkdown } from "./confluence-markdown";
import { ATLASSIAN_API, ATLASSIAN_AUTH, confluenceUpstream, type ConfluenceOperation } from "./confluence-upstream";

/**
 * OAuth scopes this gatekeeper requests. We use a hybrid of v2 + v1 endpoints, so the app needs
 * BOTH scope families:
 *  - **Granular** scopes authorize the Confluence v2 API (spaces, pages, blog posts, child pages,
 *    comments, labels, attachments) — v2 does not accept classic scopes.
 *  - **Classic** scopes authorize the v1 endpoints used where v2 has no equivalent: CQL search,
 *    label add/remove, attachment upload, and restore-from-trash — v1 does not accept granular
 *    scopes.
 * `read:me`/`offline_access` are account-level (user identity + refresh tokens).
 */
export const CONFLUENCE_SCOPES = [
  // Granular (v2 API).
  "read:space:confluence",
  "read:page:confluence",
  "write:page:confluence",
  "delete:page:confluence",
  "read:blogpost:confluence",
  "write:blogpost:confluence",
  "delete:blogpost:confluence",
  "read:comment:confluence",
  "write:comment:confluence",
  "delete:comment:confluence",
  "read:label:confluence",
  "write:label:confluence",
  "read:attachment:confluence",
  "write:attachment:confluence",
  "delete:attachment:confluence",
  "read:user:confluence",
  // The content tree (direct children and descendants of a page or folder), which the resource
  // configurator browses. A grant without it can still be used, with a pages-only tree.
  "read:hierarchical-content:confluence",

  // Classic (v1 fallbacks: search, label writes, attachment upload, restore).
  "search:confluence",
  "read:confluence-content.all",
  "read:confluence-content.summary",
  "read:confluence-space.summary",
  "write:confluence-content",
  "write:confluence-file",
  "readonly:content.attachment:confluence",
  "read:confluence-user",

  // Account-level.
  "read:me",
  "offline_access",
];

/** The scope that lets the configurator list folders, whiteboards and databases in the content tree. */
export const HIERARCHY_SCOPE = "read:hierarchical-content:confluence";

export class ConfluenceApiError extends Error {
  status: number;
  isAuthError: boolean;
  /** True when the underlying endpoint has been removed by Atlassian (HTTP 410 Gone). */
  isGone: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConfluenceApiError";
    this.status = status;
    this.isAuthError = status === 401;
    this.isGone = status === 410;
  }
}

/**
 * A creation that Confluence answered a success without naming what it created. The creation was
 * sent and may have been made, so it is not one to send again.
 */
export class ConfluenceUnnamedCreationError extends ConfluenceApiError {
  /**
   * @param what What was to be created, as the message names it.
   * @param cause What reading the answer threw, where that is why it names nothing.
   */
  constructor(what: string, cause?: unknown) {
    super(502, `Confluence did not name the ${what} it created.`);
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------------------------
// OAuth + identity

export type OAuthGrant = {
  accessToken: string;
  refreshToken?: string;
  /** Absolute epoch-ms expiry of the access token. */
  expiresAt: number;
  /** The scopes the grant holds, as Atlassian reported them. */
  scopes?: string[];
};

export type AccessibleResource = {
  /** The site's cloud ID. */
  id: string;
  name: string;
  /** The site's base URL, e.g. https://acme.atlassian.net */
  url: string;
  scopes: string[];
  avatarUrl?: string;
};

export type AtlassianIdentity = {
  accountId: string;
  name?: string;
  email?: string;
  picture?: string;
};

type TokenResponse = {
  access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
  error?: string; error_description?: string;
};

// Sends one token request, counted as `operation`. A POST, so it is sent once: a code is spent by
// its exchange, and Atlassian rotates a refresh token when it is used.
async function postToken(
  operation: Extract<ConfluenceOperation, "token.exchange" | "token.refresh">, body: Record<string, string>,
): Promise<OAuthGrant> {
  const { response, parsed } = await confluenceUpstream.read(`${ATLASSIAN_AUTH}/oauth/token`, {
    operation,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }, async answer => ({
    response: answer, parsed: (await answer.json().catch(() => null)) as TokenResponse | null,
  }),
  // A success that grants no access token is an error of the call.
  (answer, { status }) => status < 300 && !answer.parsed?.access_token ? { outcome: "error", reason: "api" } : undefined);
  if (!response.ok || !parsed?.access_token) {
    const message = [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") ||
      `Atlassian OAuth token request failed: ${response.status} ${response.statusText}`;
    throw new ConfluenceApiError(response.status, message);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    ...(typeof parsed.scope === "string" ? { scopes: parsed.scope.split(" ").filter(Boolean) } : {}),
  };
}

export function exchangeAuthCode(
  code: string, clientId: string, clientSecret: string, redirectUri: string,
): Promise<OAuthGrant> {
  return postToken("token.exchange", {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

export function refreshAccessToken(
  refreshToken: string, clientId: string, clientSecret: string,
): Promise<OAuthGrant> {
  return postToken("token.refresh", {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

// What a method's `read` made of the body of a success, or what it threw on it.
type Read<R> = { value: R } | { thrown: unknown };

// Reads the body of a success with a method's `read`. What that throws is returned, not thrown,
// so that the request is counted by it and is not sent again for it.
function reading<T, R>(read: (body: T) => R, body: T): Read<R> {
  try {
    return { value: read(body) };
  } catch (thrown) {
    return { thrown };
  }
}

// A success whose body its method's `read` threw on is not what the request was sent for.
const UNREAD: CallAnswer = { outcome: "error", reason: "api" };

// A GET of an account-level resource. `read` takes what the request was sent for out of the body
// of a success, within the request: a body it throws on is counted as an error of the API, and
// what it threw is thrown.
async function getJson<T, R>(url: string, token: string, read: (body: T) => R): Promise<R> {
  const made = await confluenceUpstream.read(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, async response => {
    if (!response.ok) {
      throw new ConfluenceApiError(response.status, `${response.status} ${response.statusText} for ${url}`);
    }
    return reading(read, (await response.json()) as T);
  }, answer => "thrown" in answer ? UNREAD : undefined);
  if ("thrown" in made) throw made.thrown;
  return made.value;
}

/** Lists the Confluence sites this token can access (each carries the cloud ID used for API calls). */
export async function getAccessibleResources(token: string): Promise<AccessibleResource[]> {
  return await getJson(`${ATLASSIAN_API}/oauth/token/accessible-resources`, token,
    // Only sites that granted at least one Confluence scope are usable here.
    (all: AccessibleResource[]) => all.filter(r => r.scopes.some(s => s.includes("confluence"))));
}

/** Fetches the authorizing user's identity (requires the `read:me` scope). */
export async function getAtlassianIdentity(token: string): Promise<AtlassianIdentity> {
  return await getJson(`${ATLASSIAN_API}/me`, token,
    (me: { account_id: string; name?: string; email?: string; picture?: string }): AtlassianIdentity =>
      ({ accountId: me.account_id, name: me.name, email: me.email, picture: me.picture }));
}

// ---------------------------------------------------------------------------------------------
// URL parsing (pure)

export type UrlClassification =
  | { kind: "content"; host: string; contentId: string; spaceKey?: string }
  | { kind: "space"; host: string; spaceKey: string }
  | { kind: "site"; host: string };

/** Classifies a Confluence Cloud URL into a site / space / content resource. */
export function classifyConfluenceUrl(url: string): UrlClassification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfluenceApiError(400, `Not a valid URL: ${url}`);
  }
  const host = parsed.hostname;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "wiki") segments.shift();

  const spaceKey = at(segments, "spaces");
  const pageId = at(segments, "pages");
  const pageIdParam = parsed.searchParams.get("pageId") ?? undefined;
  const blogId = segments.includes("blog") ? segments.filter(s => /^\d+$/.test(s)).at(-1) : undefined;

  const contentId = [pageId, blogId, pageIdParam].find(id => id && /^\d+$/.test(id));
  if (contentId) return { kind: "content", host, contentId, ...(spaceKey ? { spaceKey } : {}) };
  if (spaceKey) return { kind: "space", host, spaceKey };
  return { kind: "site", host };
}

const at = (segments: string[], marker: string): string | undefined => {
  const i = segments.indexOf(marker);
  return i >= 0 ? segments[i + 1] : undefined;
};

/**
 * The content ID a Confluence short link (`/wiki/x/<tinyId>`) names, or undefined when the URL isn't
 * one. The tiny ID is the content ID's little-endian bytes in base64, with `/` written `-`, `+`
 * written `_`, and trailing zero bytes and padding dropped.
 */
export function contentIdFromShortLink(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = /^\/wiki\/x\/([A-Za-z0-9_-]{1,12})\/?$/.exec(parsed.pathname);
  if (!match) return undefined;
  const base64 = match[1].replace(/-/g, "/").replace(/_/g, "+");
  let bytes: string;
  try {
    bytes = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "A"));
  } catch {
    return undefined;
  }
  let id = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(bytes.charCodeAt(i));
  return id > 0n ? id.toString() : undefined;
}

/** Resolves a content ID from a bare numeric ID or a Confluence URL. */
export function parseConfluenceContentId(idOrUrl: string): string {
  if (/^\d+$/.test(idOrUrl.trim())) return idOrUrl.trim();
  const classified = classifyConfluenceUrl(idOrUrl);
  if (classified.kind !== "content") {
    throw new ConfluenceApiError(400, `No content ID found in: ${idOrUrl}`);
  }
  return classified.contentId;
}

/** Resolves a space reference into a key or numeric ID, from a bare value or a Confluence URL. */
export function parseSpaceKeyOrId(keyOrIdOrUrl: string): { key: string } | { id: string } {
  const trimmed = keyOrIdOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const classified = classifyConfluenceUrl(trimmed);
    if ("spaceKey" in classified && classified.spaceKey) return { key: classified.spaceKey };
    throw new ConfluenceApiError(400, `No space found in: ${keyOrIdOrUrl}`);
  }
  return /^\d+$/.test(trimmed) ? { id: trimmed } : { key: trimmed };
}

// ---------------------------------------------------------------------------------------------
// CQL (pure) — used by the v1 search fallback.

/** Quotes and escapes a value for use in a CQL string literal (handles both `"` and `\`). */
export function escapeCqlString(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Builds a CQL query from simple options.
 *
 * `spaceKey` is a mandatory scope: when present, raw `cql` is rejected (it can't be safely
 * constrained to one space — a trailing `order by` or top-level `OR` would escape an AND wrapper),
 * so a space-scoped caller must use `text`/`type`, which stay restricted to that space. With no
 * `spaceKey` (site-level search), a raw `cql` is honored verbatim and takes precedence.
 */
export function buildCql(options: { text?: string; cql?: string; type?: ContentType; spaceKey?: string }): string {
  const rawCql = options.cql?.trim();
  if (rawCql && options.spaceKey) {
    throw new ConfluenceApiError(400,
      "Raw CQL is not supported on a space-scoped connection; use `text`/`type`, which are " +
      "restricted to this space.");
  }
  if (rawCql) return rawCql;

  const clauses: string[] = [];
  if (options.type) clauses.push(`type = ${options.type === "blogpost" ? "blogpost" : "page"}`);
  if (options.spaceKey) clauses.push(`space = ${escapeCqlString(options.spaceKey)}`);
  if (options.text?.trim()) clauses.push(`text ~ ${escapeCqlString(options.text.trim())}`);

  return clauses.length ? clauses.join(" AND ") : "type in (page, blogpost) order by lastmodified desc";
}

// ---------------------------------------------------------------------------------------------
// v2 response shapes (lean; verified against the v2 OpenAPI spec)

type V2Version = { number?: number; createdAt?: string; authorId?: string };
type V2Body = { storage?: { value?: string; representation?: string } };
type V2Links = { webui?: string; base?: string; next?: string; download?: string };

/** A v2 page or blog post. `type` is set by us based on the endpoint (v2 omits it from the object). */
export type ContentResponse = {
  id: string;
  type?: ContentType;
  status?: string;
  title: string;
  spaceId?: string;
  parentId?: string;
  parentType?: string;
  authorId?: string;
  createdAt?: string;
  /** `live` for a live doc. */
  subtype?: string | null;
  version?: V2Version;
  body?: V2Body;
  _links?: V2Links;
};

export type SpaceResponse = {
  id: string;
  key: string;
  name: string;
  type?: string;
  status?: string;
  homepageId?: string;
  description?: { plain?: { value?: string } };
  /** Present with `include-icon`. A personal space's icon is its owner's avatar, with no download link. */
  icon?: { path?: string; apiDownloadLink?: string };
  _links?: V2Links;
};

type ChildPageResponse = { id: string; status?: string; title: string; spaceId?: string };

/** The content types whose children Confluence's tree endpoints list. */
export type TreeParent = "pages" | "folders" | "whiteboards" | "databases" | "embeds";

/**
 * A node of the content tree, from `direct-children` or `descendants`: a page, folder, whiteboard,
 * database or embed (Smart Link), in the order Confluence's sidebar shows them.
 */
export type TreeNodeResponse = {
  id: string;
  title: string;
  type?: string;
  status?: string;
  /** `descendants` only. */
  parentId?: string;
  /** `descendants` only: 1 for a direct child. */
  depth?: number;
};

type CommentResponse = {
  id: string;
  status?: string;
  pageId?: string;
  blogPostId?: string;
  version?: V2Version;
  body?: V2Body;
};

export type AttachmentResponse = {
  id: string;
  title: string;
  mediaType?: string;
  fileSize?: number;
  createdAt?: string;
  pageId?: string;
  blogPostId?: string;
  customContentId?: string;
  version?: V2Version;
  downloadLink?: string;
  _links?: V2Links;
};

type V2List<T> = { results: T[]; _links?: V2Links };

/** A page of results plus an opaque cursor for the next page (undefined when exhausted). */
export type Paged<T> = { results: T[]; nextCursor?: string };

// v1 search (CQL) — the one read still served by v1.
type V1SearchResult = {
  content?: {
    id: string;
    type?: string;
    status?: string;
    title?: string;
    space?: { key?: string };
    history?: { createdDate?: string };
    version?: { when?: string };
    _links?: { webui?: string };
  };
};
type V1SearchResponse = { results: V1SearchResult[]; start?: number; limit?: number; size?: number; _links?: { next?: string } };

/** One v1 search result with the expansions `searchWithContext` asks for. */
export type SearchHit = {
  /** Space results only. */
  space?: { key?: string; name?: string; type?: string };
  content?: {
    id: string;
    type?: string;
    status?: string;
    title?: string;
    space?: { key?: string; name?: string; _expandable?: { homepage?: string } };
    ancestors?: { id: string; type?: string; title?: string }[];
    /** A page's child pages, as far as one expansion lists them. */
    children?: { page?: { size?: number } };
    _links?: { webui?: string };
  };
  title?: string;
  entityType?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string };
};

// ---------------------------------------------------------------------------------------------
// Converters (pure)

const contentTypeOf = (type: string | undefined): ContentType => (type === "blogpost" ? "blogpost" : "page");
const statusOf = (status: string | undefined): ContentStatus =>
  status === "draft" || status === "trashed" || status === "archived" ? status : "current";

// v2/v1 `webui` links are paths relative to the site's /wiki base (e.g. "/spaces/ENG/pages/123"),
// so they're appended to webBase rather than resolved as origin-relative URLs.
const publicUrl = (webui: string | undefined, webBase: string): string => {
  if (!webui) return webBase;
  if (/^https?:\/\//i.test(webui)) return webui;
  return `${webBase}${webui.startsWith("/") ? "" : "/"}${webui}`;
};

/**
 * v2 webui links look like "/spaces/ENG/pages/123/Title"; derive the space key from them so we
 * don't need an extra lookup (v2 content carries spaceId, not the human key).
 */
export function spaceKeyFromWebui(webui: string | undefined): string | undefined {
  if (!webui) return undefined;
  const m = webui.match(/\/spaces\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

const userRef = (accountId: string | undefined): ConfluenceUser | null =>
  accountId ? { accountId } : null;

export function contentToSummary(c: ContentResponse, webBase: string): ContentSummary {
  const summary: ContentSummary = {
    id: c.id,
    type: contentTypeOf(c.type),
    title: c.title,
    url: publicUrl(c._links?.webui, webBase),
    status: statusOf(c.status),
  };
  const spaceKey = spaceKeyFromWebui(c._links?.webui);
  if (spaceKey) summary.spaceKey = spaceKey;
  if (c.createdAt) summary.createdAt = new Date(c.createdAt);
  if (c.version?.createdAt) summary.lastUpdatedAt = new Date(c.version.createdAt);
  return summary;
}

export function contentToMetadata(c: ContentResponse, webBase: string): ContentMetadata {
  const created = c.createdAt ? new Date(c.createdAt) : new Date();
  return {
    ...contentToSummary(c, webBase),
    createdAt: created,
    lastUpdatedAt: c.version?.createdAt ? new Date(c.version.createdAt) : created,
    version: c.version?.number ?? 1,
    parentId: c.parentId ?? undefined,
    author: userRef(c.authorId),
    lastUpdatedBy: userRef(c.version?.authorId),
  };
}

/** A child page (minimal shape) summarized using the parent's space key for the URL. */
export function childPageToSummary(child: ChildPageResponse, webBase: string, spaceKey: string | undefined): ContentSummary {
  return {
    id: child.id,
    type: "page",
    title: child.title,
    spaceKey,
    url: spaceKey ? `${webBase}/spaces/${spaceKey}/pages/${child.id}` : `${webBase}/pages/${child.id}`,
    status: statusOf(child.status),
  };
}

export const contentBodyMarkdown = (c: ContentResponse): string =>
  storageToMarkdown(c.body?.storage?.value ?? "");

const spaceTypeOf = (type: string | undefined): SpaceType =>
  type === "personal" || type === "collaboration" || type === "knowledge_base" ? type : "global";

function spaceToSummary(s: SpaceResponse, webBase: string): SpaceSummary {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    type: spaceTypeOf(s.type),
    url: publicUrl(s._links?.webui, webBase),
  };
}

export function spaceToMetadata(s: SpaceResponse, webBase: string): SpaceMetadata {
  return {
    ...spaceToSummary(s, webBase),
    description: s.description?.plain?.value || undefined,
    homepageId: s.homepageId,
  };
}

export function commentToComment(c: CommentResponse, _webBase: string): Comment {
  return {
    id: c.id,
    text: storageToMarkdown(c.body?.storage?.value ?? ""),
    author: userRef(c.version?.authorId),
    createdAt: new Date(c.version?.createdAt ?? Date.now()),
  };
}

export function attachmentToAttachment(a: AttachmentResponse): Attachment {
  return {
    id: a.id,
    title: a.title,
    mediaType: a.mediaType ?? "application/octet-stream",
    fileSize: a.fileSize,
    version: a.version?.number ?? 1,
    createdAt: new Date(a.createdAt ?? a.version?.createdAt ?? Date.now()),
  };
}

/** Whether an attachment belongs to the given content (the capability's grant boundary). */
export function attachmentBelongsToContent(a: AttachmentResponse, contentId: string): boolean {
  return a.pageId === contentId || a.blogPostId === contentId;
}

function searchResultToSummary(content: NonNullable<V1SearchResult["content"]>, webBase: string): ContentSummary {
  const summary: ContentSummary = {
    id: content.id,
    type: contentTypeOf(content.type),
    title: content.title ?? "",
    url: publicUrl(content._links?.webui, webBase),
    status: statusOf(content.status),
  };
  if (content.space?.key) summary.spaceKey = content.space.key;
  if (content.history?.createdDate) summary.createdAt = new Date(content.history.createdDate);
  if (content.version?.when) summary.lastUpdatedAt = new Date(content.version.when);
  return summary;
}

/** Extract the opaque `cursor` query param from a v2 `_links.next` relative URL. */
export function cursorFromNext(next: string | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, "https://x").searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// API client

const V2 = "/wiki/api/v2";
const V1 = "/wiki/rest/api";
const PAGE_BODY = "body-format=storage";

/** `body: false` reads a page's or post's metadata alone, which is all a title or status check needs. */
export type ContentReadOptions = { body?: boolean };
const bodyQuery = (options: ContentReadOptions) => (options.body === false ? "" : `?${PAGE_BODY}`);

export class ConfluenceApi {
  readonly cloudId: string;
  readonly webBase: string;
  #getToken: () => Promise<string>;
  #refresh?: () => Promise<string>;

  constructor(opts: {
    cloudId: string;
    webBase: string;
    getToken: () => Promise<string>;
    refresh?: () => Promise<string>;
  }) {
    this.cloudId = opts.cloudId;
    this.webBase = opts.webBase;
    this.#getToken = opts.getToken;
    this.#refresh = opts.refresh;
  }

  #base(): string {
    return `${ATLASSIAN_API}/ex/confluence/${this.cloudId}`;
  }

  // Sends one request through the upstream and reads its answer with `parse`. Each send carries
  // the token that `token` gives when it is made. The request is named by its path
  // (`CONFLUENCE_ROUTES`) unless `init` names it, and `answer` counts what the status of the
  // answer does not say.
  #send<T>(
    method: string, url: string, token: () => string, init: UpstreamRequestInit | undefined,
    parse: (response: Response) => Promise<T>, answer?: (parsed: T) => CallAnswer | undefined,
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    return confluenceUpstream.read(url, {
      ...init, method, headers, authorize: () => ({ Authorization: `Bearer ${token()}` }),
    }, parse, answer);
  }

  // A request that answers the body of a success as it is.
  async #request<T>(method: string, path: string, init?: RequestInit): Promise<T> {
    return await this.#read<T, T>(method, path, init, body => body);
  }

  // A request that answers what `read` makes of the body of a success, and throws what it throws.
  async #read<T, R>(method: string, path: string, init: RequestInit | undefined, read: Reader<T, R>): Promise<R> {
    const made = await this.#attempt(method, path, init, read);
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }

  // Core request: `path` is the gateway-relative path (e.g. "/wiki/api/v2/pages/1"). Refreshes the
  // token once on a 401, then surfaces a clean error. `read` takes what the request was sent for
  // out of the body of a success, within the request: a body it throws on is counted as an error
  // of the API, and what it threw is answered, for the caller to throw.
  async #attempt<T, R>(method: string, path: string, init: RequestInit | undefined, read: Reader<T, R>): Promise<Read<R>> {
    const url = `${this.#base()}${path}`;
    let token = await this.#getToken();
    const refresh = this.#refresh;
    // The 401 that the one refresh was asked for after, with its error.
    const held: { unauthorized?: HeldError } = {};
    // The token of that refresh: whether it was given, whether the attempt last sent carries it,
    // and whether an attempt that carried it was answered, whatever the status of the answer.
    const fresh = { given: false, sent: false, answered: false };

    let answered: Answered<Read<R>>;
    try {
      answered = await this.#send<Answered<Read<R>>>(method, url, () => {
        fresh.sent = fresh.given;
        return token;
      }, {
        ...init,
        // Notes each answer as it comes, and counts none otherwise than by its status.
        answer: () => {
          if (fresh.sent) fresh.answered = true;
          return undefined;
        },
        // The 401's status decides the refresh and the second send: the refresh is asked for at
        // once, and neither waits for the 401's body, which is read meanwhile as far as its cap.
        // The sends before the 401 and after it share the attempts of one request's retry policy.
        replay: async response => {
          if (response.status !== 401 || !refresh || held.unauthorized) return false;
          const refreshing = (async () => refresh())();
          held.unauthorized = heldErrorOf(response);
          try {
            token = await refreshing;
          } catch {
            // A refresh that fails leaves the 401 as the answer.
            return false;
          }
          fresh.given = true;
          return true;
        },
      }, async response => {
        if (!response.ok) {
          if (held.unauthorized?.of !== response) return { error: await errorOf(response) };
          // The 401 that the refresh failed after: its error is the one its copy was read for.
          discard(response);
          return { error: await held.unauthorized.error };
        }
        if (response.status === 204) return { data: reading(read, undefined as T) };
        let body: T;
        try {
          body = (await response.json()) as T;
        } catch (cause) {
          // A success whose body cannot be read is thrown as what the reading threw, and counted
          // by the client, except where `read` says what such a success is: a creation's.
          throw read.undecoded?.(cause) ?? cause;
        }
        return { data: reading(read, body) };
      }, answer => answer.error === undefined && "thrown" in answer.data ? UNREAD : undefined);
    } catch (error) {
      // A request that fails before any 401 throws what it failed with. So does one of which a
      // send with the fresh token was answered, whatever the status of that answer: the 401 is
      // then not the last that Confluence said of the request, and an answer that could not be
      // read, or sends after it that got none, are the failure it ended with. Where no send with
      // the fresh token was answered, the 401 they were sent after is thrown, with what its body
      // said where that is within the cap. No other failure follows a 401 that is held: one whose
      // refresh failed is read, not thrown on.
      if (!held.unauthorized || fresh.answered) {
        held.unauthorized?.release();
        throw error;
      }
      throw await held.unauthorized.error;
    }
    held.unauthorized?.release();
    if (answered.error) throw answered.error;
    return answered.data;
  }

  #json(method: string, path: string, body: unknown): Promise<any> {
    return this.#request(method, path, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A request with a JSON body that answers what `read` makes of the body of a success.
  #jsonAs<T, R>(method: string, path: string, body: unknown, read: Reader<T, R>): Promise<R> {
    return this.#read(method, path, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, read);
  }

  #list<T>(path: string, params: Record<string, string | number | undefined>): Promise<Paged<T>> {
    return this.#listAs<T, Paged<T>>(path, params, paged => paged);
  }

  // A page of a listing, and what `read` makes of it within the request.
  async #listAs<T, R>(
    path: string, params: Record<string, string | number | undefined>, read: (paged: Paged<T>) => R,
  ): Promise<R> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    const qs = query.toString();
    return await this.#read("GET", `${path}${qs ? `?${qs}` : ""}`, undefined, (res: V2List<T>) => {
      // A page with no list is none: refused here, within the request, so that it is counted an
      // error and no reader of the page meets it. An empty list is a page.
      if (!Array.isArray(res.results)) {
        throw new ConfluenceApiError(502, "Confluence answered a listing with no list.");
      }
      return read({ results: res.results, nextCursor: cursorFromNext(res._links?.next) });
    });
  }

  // --- spaces ---

  listSpaces(params: {
    type?: string; status?: "current" | "archived"; sort?: string; includeIcon?: boolean;
    cursor?: string; limit?: number;
  }): Promise<Paged<SpaceResponse>> {
    return this.#list<SpaceResponse>(`${V2}/spaces`, {
      type: params.type,
      status: params.status,
      sort: params.sort,
      "include-icon": params.includeIcon ? "true" : undefined,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  /** The space with `key`, with its icon (see {@link SpaceResponse.icon}). */
  async getSpaceByKey(key: string): Promise<SpaceResponse> {
    const space = await this.#read(
      "GET", `${V2}/spaces?keys=${encodeURIComponent(key)}&limit=1&include-icon=true`, undefined,
      (res: V2List<SpaceResponse>): SpaceResponse | undefined => res.results[0]);
    if (!space) throw new ConfluenceApiError(404, `No such space: ${key}`);
    return space;
  }

  /** GET /spaces/{id} returns a single space (same shape as a getSpaceByKey result). */
  getSpaceById(id: string): Promise<SpaceResponse> {
    return this.#request<SpaceResponse>("GET", `${V2}/spaces/${encodeURIComponent(id)}`);
  }

  // --- content reads ---

  /** A page, with its storage-format body unless `body` is false. */
  async getPage(id: string, options: ContentReadOptions = {}): Promise<ContentResponse> {
    return await this.#read("GET", `${V2}/pages/${encodeURIComponent(id)}${bodyQuery(options)}`, undefined, tagOne("page"));
  }

  /** A blog post, with its storage-format body unless `body` is false. */
  async getBlogPost(id: string, options: ContentReadOptions = {}): Promise<ContentResponse> {
    return await this.#read("GET", `${V2}/blogposts/${encodeURIComponent(id)}${bodyQuery(options)}`, undefined, tagOne("blogpost"));
  }

  /** A content ID may be a page or a blog post (distinct v2 resources); try page, then blog post. */
  async getContentById(id: string, options: ContentReadOptions = {}): Promise<ContentResponse> {
    try {
      return await this.getPage(id, options);
    } catch (err) {
      if (err instanceof ConfluenceApiError && (err.status === 404 || err.status === 400)) {
        return await this.getBlogPost(id, options);
      }
      throw err;
    }
  }

  listPagesInSpace(params: {
    spaceId: string; depth?: "root" | "all"; cursor?: string; limit?: number;
  }): Promise<Paged<ContentResponse>> {
    return this.#listAs(`${V2}/spaces/${encodeURIComponent(params.spaceId)}/pages`, {
      depth: params.depth ?? "root",
      cursor: params.cursor,
      limit: params.limit,
    }, tagAll("page"));
  }

  listBlogPostsInSpace(params: {
    spaceId: string; sort?: string; cursor?: string; limit?: number;
  }): Promise<Paged<ContentResponse>> {
    return this.#listAs(`${V2}/blogposts`, {
      "space-id": params.spaceId,
      sort: params.sort,
      cursor: params.cursor,
      limit: params.limit,
    }, tagAll("blogpost"));
  }

  /** Up to 250 pages by ID in one read, with their subtype (a live doc's is "live") and version. */
  listPagesById(ids: string[]): Promise<Paged<ContentResponse>> {
    return this.#listAs(`${V2}/pages`, { id: ids.join(","), limit: 250 }, tagAll("page"));
  }

  listChildPages(id: string, params: { cursor?: string; limit?: number }): Promise<Paged<ChildPageResponse>> {
    return this.#list<ChildPageResponse>(`${V2}/pages/${encodeURIComponent(id)}/children`, {
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  /** A page's or folder's children of every type, in sidebar order. Needs {@link HIERARCHY_SCOPE}. */
  listDirectChildren(parent: TreeParent, id: string, params: { cursor?: string; limit?: number }): Promise<Paged<TreeNodeResponse>> {
    return this.#list<TreeNodeResponse>(`${V2}/${parent}/${encodeURIComponent(id)}/direct-children`, {
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  /** A page's or folder's descendants down to `depth` levels. Needs {@link HIERARCHY_SCOPE}. */
  listDescendants(parent: TreeParent, id: string, params: { depth: number; limit?: number }): Promise<Paged<TreeNodeResponse>> {
    return this.#list<TreeNodeResponse>(`${V2}/${parent}/${encodeURIComponent(id)}/descendants`, {
      depth: params.depth,
      limit: params.limit,
    });
  }

  /**
   * CQL search returning v1 results whole, with each content result's space (and, through its
   * expandable link, the space's home page), ancestors and child pages, and titles with their
   * matches highlighted.
   */
  async searchWithContext(cql: string, params: { cursor?: string; limit?: number }): Promise<Paged<SearchHit>> {
    const start = params.cursor ? Number(params.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new ConfluenceApiError(400, "That page of results has expired.");
    const limit = params.limit ?? 25;
    const query = new URLSearchParams({
      cql, start: String(start), limit: String(limit), excerpt: "highlight", expand: "content.space,content.ancestors,content.children.page",
    });
    let made: Read<Paged<SearchHit>>;
    try {
      made = await this.#attempt("GET", `${V1}/search?${query}`, undefined,
        (res: { results: SearchHit[]; _links?: { next?: string } }): Paged<SearchHit> => {
          // A page with no list is none, as in `#listAs`; an empty list is a page.
          if (!Array.isArray(res.results)) {
            throw new ConfluenceApiError(502, "Confluence answered a listing with no list.");
          }
          return { results: res.results, nextCursor: res._links?.next ? String(start + limit) : undefined };
        });
    } catch (err) {
      throw degradeIfGone(err, "Confluence search");
    }
    // What reading the answer threw is thrown as it is, not as an endpoint that is gone.
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }

  /**
   * Downloads a space icon from its `apiDownloadLink`. Confluence answers with a redirect to a signed
   * URL on Atlassian's media service, which is followed only there and without our token, and the
   * image is read only up to `maxBytes`.
   */
  async downloadSpaceIcon(apiDownloadLink: string, maxBytes: number): Promise<{ data: Uint8Array; mediaType: string }> {
    // Confluence writes the link from the site's root (`/wiki/rest/api/…`), or from `/wiki`.
    const link = apiDownloadLink.replace(/^\/wiki(?=\/rest\/api\/)/, "");
    if (!link.startsWith("/rest/api/")) throw new ConfluenceApiError(400, "Not a space icon link.");
    const url = `${this.#base()}/wiki${link}`;
    // Reads an answer as the icon, up to `maxBytes`, or as the error it is thrown as.
    const icon = async (response: Response): Promise<Answered<Download>> => {
      if (!response.ok) {
        return { error: new ConfluenceApiError(response.status, `Space icon download failed: ${response.status}`) };
      }
      try {
        return { data: { data: await readCapped(response, maxBytes), mediaType: response.headers.get("Content-Type") ?? "" } };
      } catch (error) {
        // An icon over the cap is refused here: the request that answered it did not fail.
        if (error instanceof ConfluenceApiError) return { error };
        throw error;
      }
    };
    // Confluence answers 406, not its redirect, to a request that accepts only images. The redirect
    // is not followed: it is answered here, as the signed URL to fetch.
    const locate = (token: string) => this.#send<Answered<Download> | { target: URL; error?: undefined }>("GET", url, () => token, {
      operation: "icons.get" satisfies ConfluenceOperation, headers: { Accept: "*/*" }, redirect: "manual",
    }, async response => {
      if (!isRedirect(response.status)) return icon(response);
      const location = response.headers.get("Location");
      const target = location ? new URL(location, url) : undefined;
      if (target?.protocol !== "https:" || target.hostname !== MEDIA_HOST) {
        return { error: new ConfluenceApiError(502, "A space icon redirected somewhere unexpected.") };
      }
      return { target };
    },
    // A redirect to the media service is what the request was sent for. One that is refused is
    // counted by its status, an error.
    located => "target" in located ? { outcome: "success" } : undefined);
    let located = await locate(await this.#getToken());
    if (located.error?.status === 401 && this.#refresh) located = await locate(await this.#refresh());
    // The signed URL is fetched without the token, and a redirect from the media service is the
    // answer, which is an error.
    const answered = "target" in located
      ? await confluenceUpstream.read(located.target, {
        operation: "icons.download" satisfies ConfluenceOperation, headers: { Accept: "image/*" }, redirect: "manual",
      }, icon)
      : located;
    if (answered.error) throw answered.error;
    return answered.data;
  }

  /**
   * CQL search — no v2 equivalent, so this uses the v1 search endpoint (start/limit paged; we
   * encode the next start offset as the opaque cursor). Degrades clearly if v1 search is removed.
   */
  async search(cql: string, params: { cursor?: string; limit?: number }): Promise<Paged<ContentSummary>> {
    const start = params.cursor ? Number(params.cursor) : 0;
    const limit = params.limit ?? 25;
    const query = `cql=${encodeURIComponent(cql)}&start=${start}&limit=${limit}`;
    let made: Read<Paged<ContentSummary>>;
    try {
      made = await this.#attempt("GET", `${V1}/search?${query}`, undefined, (res: V1SearchResponse): Paged<ContentSummary> => {
        const results = res.results
          .map(r => r.content)
          .filter((c): c is NonNullable<V1SearchResult["content"]> => !!c)
          .map(c => searchResultToSummary(c, this.webBase));
        const hasMore = Boolean(res._links?.next);
        return { results, nextCursor: hasMore ? String(start + limit) : undefined };
      });
    } catch (err) {
      throw degradeIfGone(err, "Confluence search");
    }
    // What reading the answer threw is thrown as it is, not as an endpoint that is gone.
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }

  // --- content writes ---

  createPage(body: {
    title: string; storageValue: string; status: "current" | "draft"; spaceId: string; parentId?: string;
  }): Promise<ContentResponse> {
    return this.#jsonAs("POST", `${V2}/pages`, {
      spaceId: body.spaceId,
      status: body.status,
      title: body.title,
      ...(body.parentId ? { parentId: body.parentId } : {}),
      body: { representation: "storage", value: body.storageValue },
    }, created("page", tagOne("page")));
  }

  createBlogPost(body: {
    title: string; storageValue: string; status: "current" | "draft"; spaceId: string;
  }): Promise<ContentResponse> {
    return this.#jsonAs("POST", `${V2}/blogposts`, {
      spaceId: body.spaceId,
      status: body.status,
      title: body.title,
      body: { representation: "storage", value: body.storageValue },
    }, created("blog post", tagOne("blogpost")));
  }

  updateContent(body: {
    id: string; type: ContentType; title: string; version: number; storageValue: string; status?: string;
  }): Promise<ContentResponse> {
    const path = body.type === "blogpost" ? "blogposts" : "pages";
    return this.#jsonAs("PUT", `${V2}/${path}/${encodeURIComponent(body.id)}`, {
      id: body.id,
      status: body.status ?? "current",
      title: body.title,
      body: { representation: "storage", value: body.storageValue },
      version: { number: body.version },
    }, tagOne(body.type));
  }

  async trashContent(id: string, type: ContentType): Promise<void> {
    const path = type === "blogpost" ? "blogposts" : "pages";
    await this.#request("DELETE", `${V2}/${path}/${encodeURIComponent(id)}`);
  }

  /** Restore from trash has no v2 endpoint; fall back to v1 and degrade if it's gone. */
  async restoreContent(id: string): Promise<void> {
    try {
      await this.#json("PUT", `${V1}/content/${encodeURIComponent(id)}?status=trashed`, { status: "current" });
    } catch (err) {
      throw degradeIfGone(err, "Restoring trashed content");
    }
  }

  // --- comments ---

  listComments(id: string, type: ContentType, params: { cursor?: string; limit?: number }): Promise<Paged<CommentResponse>> {
    const path = type === "blogpost" ? "blogposts" : "pages";
    return this.#list<CommentResponse>(`${V2}/${path}/${encodeURIComponent(id)}/footer-comments`, {
      "body-format": "storage",
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  addComment(containerId: string, storageValue: string, containerType: ContentType): Promise<CommentResponse> {
    const key = containerType === "blogpost" ? "blogPostId" : "pageId";
    return this.#jsonAs("POST", `${V2}/footer-comments`, {
      [key]: containerId,
      body: { representation: "storage", value: storageValue },
    }, created("comment", (comment: CommentResponse | null | undefined) => comment));
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.#request("DELETE", `${V2}/footer-comments/${encodeURIComponent(commentId)}`);
  }

  // --- labels ---

  async getLabels(id: string, type: ContentType): Promise<string[]> {
    const path = type === "blogpost" ? "blogposts" : "pages";
    return await this.#listAs(`${V2}/${path}/${encodeURIComponent(id)}/labels`, { limit: 250 },
      (res: Paged<{ name: string }>) => res.results.map(l => l.name));
  }

  /** Label writes have no v2 endpoint; use v1 and degrade if it's gone. */
  async addLabel(id: string, name: string): Promise<void> {
    try {
      await this.#json("POST", `${V1}/content/${encodeURIComponent(id)}/label`, [{ prefix: "global", name }]);
    } catch (err) {
      throw degradeIfGone(err, "Adding labels");
    }
  }

  async removeLabel(id: string, name: string): Promise<void> {
    try {
      await this.#request("DELETE", `${V1}/content/${encodeURIComponent(id)}/label?name=${encodeURIComponent(name)}`);
    } catch (err) {
      throw degradeIfGone(err, "Removing labels");
    }
  }

  // --- attachments ---

  listAttachments(id: string, type: ContentType, params: { cursor?: string; limit?: number }): Promise<Paged<AttachmentResponse>> {
    const path = type === "blogpost" ? "blogposts" : "pages";
    return this.#list<AttachmentResponse>(`${V2}/${path}/${encodeURIComponent(id)}/attachments`, {
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  getAttachmentInfo(id: string): Promise<AttachmentResponse> {
    return this.#request<AttachmentResponse>("GET", `${V2}/attachments/${encodeURIComponent(id)}`);
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.#request("DELETE", `${V2}/attachments/${encodeURIComponent(id)}`);
  }

  /** Attachment upload has no v2 endpoint; use v1 and degrade if it's gone. */
  async uploadAttachment(id: string, file: {
    filename: string; mediaType: string; data: Uint8Array; comment?: string;
  }): Promise<AttachmentResponse> {
    const form = new FormData();
    form.set("file", new Blob([file.data], { type: file.mediaType }), file.filename);
    if (file.comment) form.set("comment", file.comment);
    try {
      return await this.#read(
        "POST", `${V1}/content/${encodeURIComponent(id)}/child/attachment`, {
          headers: { "X-Atlassian-Token": "no-check" },
          body: form,
        }, created("attachment", (res: { results: AttachmentResponse[] }) => res.results[0]));
    } catch (err) {
      throw degradeIfGone(err, "Uploading attachments");
    }
  }

  /** Downloads attachment bytes via its `downloadLink` (relative to the site /wiki base). */
  async downloadAttachment(downloadLink: string): Promise<{ data: Uint8Array; mediaType: string }> {
    const url = `${this.#base()}/wiki${downloadLink}`;
    const download = (token: string) => this.#send<Answered<Download>>("GET", url, () => token, {
      operation: "attachments.download" satisfies ConfluenceOperation,
      headers: { Accept: "*/*" },
      // Confluence answers a download link with a redirect to a signed URL on Atlassian's media
      // service, where the attachment's bytes are.
      redirect: "follow",
    }, async response => {
      if (!response.ok) {
        return { error: new ConfluenceApiError(response.status, `Attachment download failed: ${response.status}`) };
      }
      return {
        data: {
          data: new Uint8Array(await response.arrayBuffer()),
          mediaType: response.headers.get("Content-Type") ?? "application/octet-stream",
        },
      };
    });
    let answered = await download(await this.#getToken());
    if (answered.error?.status === 401 && this.#refresh) answered = await download(await this.#refresh());
    if (answered.error) throw answered.error;
    return answered.data;
  }
}

const MEDIA_HOST = "api.media.atlassian.com";

// One answer, read: what its body holds, or the error its status is thrown as.
type Answered<T> = { data: T; error?: undefined } | { error: ConfluenceApiError };

// The bytes of a download and the media type its answer names.
type Download = { data: Uint8Array; mediaType: string };

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

// Reads a body, refusing one longer than `maxBytes` rather than buffering it whole.
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ConfluenceApiError(413, "The download is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConfluenceApiError(413, "The download is too large.");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

// Tag a fetched content object / list with its kind (v2 omits `type` from page/blogpost objects).
const tagOne = (type: ContentType) => (c: ContentResponse): ContentResponse => ((c.type = type), c);
const tagAll = (type: ContentType) => (paged: Paged<ContentResponse>): Paged<ContentResponse> => {
  for (const c of paged.results) c.type = type;
  return paged;
};

// What a creation's answer holds once `read` has read it, which must name what was created: its
// ID is what the action that asked for the creation records. An answer that names nothing is none
// to record: refused here, within the request, though the creation it answers may have been made.
// So is one that `read` throws on, which holds nothing to read a name from: whatever a success
// lacks, the creation it answers was sent.
// Nor does a success whose body could not be read or decoded name anything: `undecoded` gives
// the error that one is thrown as.
const created = <T, R extends { id: string }>(what: string, read: (body: T) => R | null | undefined) =>
  Object.assign((body: T): R => {
    let made: R | null | undefined;
    try {
      made = read(body);
    } catch (cause) {
      throw new ConfluenceUnnamedCreationError(what, cause);
    }
    // Confluence names what it made by a string: anything else is no name a later action can use.
    if (typeof made?.id !== "string" || made.id.length === 0) throw new ConfluenceUnnamedCreationError(what);
    return made;
  }, { undecoded: (cause: unknown): Error => new ConfluenceUnnamedCreationError(what, cause) });

// A reader of the body of a success, which may say what a success whose body could not be
// decoded is thrown as.
type Reader<T, R> = ((body: T) => R) & { undecoded?: (cause: unknown) => Error };

// Turn a removed-endpoint error into a clear "capability unavailable" message.
function degradeIfGone(err: unknown, capability: string): ConfluenceApiError {
  if (err instanceof ConfluenceApiError && (err.isGone || err.status === 404)) {
    return new ConfluenceApiError(err.status,
      `${capability} is not available: the underlying Confluence endpoint has been removed.`);
  }
  return err instanceof ConfluenceApiError ? err : new ConfluenceApiError(500, String(err));
}

// The error an answer that is no success is thrown as, with what its body says: `body` gives the
// text of it.
async function errorOf(
  response: Response, body: Promise<string> = response.text(),
): Promise<ConfluenceApiError> {
  const detail = await body.catch(() => "");
  return new ConfluenceApiError(response.status, errorMessage(response, detail));
}

/**
 * The most bytes of a 401's body that are kept for its error while a fresh token is asked for and
 * sent. An error of Confluence's is a few hundred bytes: a 401 with a longer body is thrown by its
 * status alone.
 */
export const MAX_HELD_ERROR_BYTES = 16 * 1024;

// The error of a 401 whose body is read from a copy while a fresh token is asked for and sent:
// `release` stops that reading and lets go of the copy.
type HeldError = { of: Response; error: Promise<ConfluenceApiError>; release: () => void };

// Starts reading a copy of `response` for its error, which nothing waits for until `error` is.
// The reading starts here because the runtime fails whatever is read of an answer, a copy of it
// included, once the timeout of its attempt has fired: an error asked for after that holds what
// the body said all the same. At most `MAX_HELD_ERROR_BYTES` are kept: the reading of a longer
// body stops with the piece that passes the cap, its copy is let go there, and its error is that
// of the status alone.
function heldErrorOf(response: Response): HeldError {
  const reader = response.clone().body?.getReader();
  // Not waited for: the cancelling of one side of a copied body ends only once the other side is
  // cancelled too.
  const release = () => void reader?.cancel().catch(() => undefined);
  // The copy as the capped reader takes it, with the length the answer declares. The reader waits
  // for the cancelling of the body it reads, so this one's cancelling lets go of the copy and
  // waits for nothing. It asks the copy for bytes only as it is read.
  const copy = new Response(reader && new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: release,
  }, { highWaterMark: 0 }), { headers: response.headers });
  return { of: response, error: errorOf(response, readTextCapped(copy, MAX_HELD_ERROR_BYTES)), release };
}

// Lets go of the body of an answer that nothing reads, so that its connection is not held.
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function errorMessage(response: Response, detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { message?: string; errors?: { title?: string }[] };
    const msg = parsed.message ?? parsed.errors?.[0]?.title;
    if (msg) return `${response.status}: ${msg}`;
  } catch { /* not JSON */ }
  return `${response.status} ${response.statusText}`;
}
