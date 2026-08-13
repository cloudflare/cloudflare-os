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
import { storageToMarkdown } from "./confluence-markdown";

const ATLASSIAN_AUTH = "https://auth.atlassian.com";
const ATLASSIAN_API = "https://api.atlassian.com";
const REQUEST_TIMEOUT_MS = 30_000;

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

// ---------------------------------------------------------------------------------------------
// OAuth + identity

export type OAuthGrant = {
  accessToken: string;
  refreshToken?: string;
  /** Absolute epoch-ms expiry of the access token. */
  expiresAt: number;
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

async function postToken(body: Record<string, string>): Promise<OAuthGrant> {
  const response = await fetch(`${ATLASSIAN_AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const parsed = (await response.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;
  if (!response.ok || !parsed?.access_token) {
    const message = [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") ||
      `Atlassian OAuth token request failed: ${response.status} ${response.statusText}`;
    throw new ConfluenceApiError(response.status, message);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
}

export function exchangeAuthCode(
  code: string, clientId: string, clientSecret: string, redirectUri: string,
): Promise<OAuthGrant> {
  return postToken({
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
  return postToken({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ConfluenceApiError(response.status, `${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

/** Lists the Confluence sites this token can access (each carries the cloud ID used for API calls). */
export async function getAccessibleResources(token: string): Promise<AccessibleResource[]> {
  const all = await getJson<AccessibleResource[]>(`${ATLASSIAN_API}/oauth/token/accessible-resources`, token);
  // Only sites that granted at least one Confluence scope are usable here.
  return all.filter(r => r.scopes.some(s => s.includes("confluence")));
}

/** Fetches the authorizing user's identity (requires the `read:me` scope). */
export async function getAtlassianIdentity(token: string): Promise<AtlassianIdentity> {
  const me = await getJson<{ account_id: string; name?: string; email?: string; picture?: string }>(
    `${ATLASSIAN_API}/me`, token);
  return { accountId: me.account_id, name: me.name, email: me.email, picture: me.picture };
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
  version?: V2Version;
  body?: V2Body;
  _links?: V2Links;
};

type SpaceResponse = {
  id: string;
  key: string;
  name: string;
  type?: string;
  status?: string;
  homepageId?: string;
  description?: { plain?: { value?: string } };
  _links?: V2Links;
};

type ChildPageResponse = { id: string; status?: string; title: string; spaceId?: string };

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

  async #send(method: string, url: string, token: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    return await fetch(url, { ...init, method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  // Core request: `path` is the gateway-relative path (e.g. "/wiki/api/v2/pages/1"). Refreshes the
  // token once on a 401, then surfaces a clean error.
  async #request<T>(method: string, path: string, init?: RequestInit): Promise<T> {
    const url = `${this.#base()}${path}`;
    let token = await this.#getToken();
    let response = await this.#send(method, url, token, init);
    if (response.status === 401 && this.#refresh) {
      try {
        token = await this.#refresh();
        response = await this.#send(method, url, token, init);
      } catch { /* fall through with the original 401 */ }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ConfluenceApiError(response.status, errorMessage(response, detail));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  #json(method: string, path: string, body: unknown): Promise<any> {
    return this.#request(method, path, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #list<T>(path: string, params: Record<string, string | number | undefined>): Promise<Paged<T>> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    const qs = query.toString();
    const res = await this.#request<V2List<T>>("GET", `${path}${qs ? `?${qs}` : ""}`);
    return { results: res.results, nextCursor: cursorFromNext(res._links?.next) };
  }

  // --- spaces ---

  listSpaces(params: { type?: string; cursor?: string; limit?: number }): Promise<Paged<SpaceResponse>> {
    return this.#list<SpaceResponse>(`${V2}/spaces`, {
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  async getSpaceByKey(key: string): Promise<SpaceResponse> {
    const res = await this.#request<V2List<SpaceResponse>>(
      "GET", `${V2}/spaces?keys=${encodeURIComponent(key)}&limit=1`);
    const space = res.results[0];
    if (!space) throw new ConfluenceApiError(404, `No such space: ${key}`);
    return space;
  }

  /** GET /spaces/{id} returns a single space (same shape as a getSpaceByKey result). */
  getSpaceById(id: string): Promise<SpaceResponse> {
    return this.#request<SpaceResponse>("GET", `${V2}/spaces/${encodeURIComponent(id)}`);
  }

  // --- content reads ---

  async getPage(id: string): Promise<ContentResponse> {
    const c = await this.#request<ContentResponse>("GET", `${V2}/pages/${encodeURIComponent(id)}?${PAGE_BODY}`);
    c.type = "page";
    return c;
  }

  async getBlogPost(id: string): Promise<ContentResponse> {
    const c = await this.#request<ContentResponse>("GET", `${V2}/blogposts/${encodeURIComponent(id)}?${PAGE_BODY}`);
    c.type = "blogpost";
    return c;
  }

  /** A content ID may be a page or a blog post (distinct v2 resources); try page, then blog post. */
  async getContentById(id: string): Promise<ContentResponse> {
    try {
      return await this.getPage(id);
    } catch (err) {
      if (err instanceof ConfluenceApiError && (err.status === 404 || err.status === 400)) {
        return await this.getBlogPost(id);
      }
      throw err;
    }
  }

  listPagesInSpace(params: {
    spaceId: string; depth?: "root" | "all"; cursor?: string; limit?: number;
  }): Promise<Paged<ContentResponse>> {
    return this.#list<ContentResponse>(`${V2}/spaces/${encodeURIComponent(params.spaceId)}/pages`, {
      depth: params.depth ?? "root",
      cursor: params.cursor,
      limit: params.limit,
    }).then(tagAll("page"));
  }

  listBlogPostsInSpace(params: { spaceId: string; cursor?: string; limit?: number }): Promise<Paged<ContentResponse>> {
    return this.#list<ContentResponse>(`${V2}/blogposts`, {
      "space-id": params.spaceId,
      cursor: params.cursor,
      limit: params.limit,
    }).then(tagAll("blogpost"));
  }

  listChildPages(id: string, params: { cursor?: string; limit?: number }): Promise<Paged<ChildPageResponse>> {
    return this.#list<ChildPageResponse>(`${V2}/pages/${encodeURIComponent(id)}/children`, {
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  /**
   * CQL search — no v2 equivalent, so this uses the v1 search endpoint (start/limit paged; we
   * encode the next start offset as the opaque cursor). Degrades clearly if v1 search is removed.
   */
  async search(cql: string, params: { cursor?: string; limit?: number }): Promise<Paged<ContentSummary>> {
    const start = params.cursor ? Number(params.cursor) : 0;
    const limit = params.limit ?? 25;
    const query = `cql=${encodeURIComponent(cql)}&start=${start}&limit=${limit}`;
    let res: V1SearchResponse;
    try {
      res = await this.#request<V1SearchResponse>("GET", `${V1}/search?${query}`);
    } catch (err) {
      throw degradeIfGone(err, "Confluence search");
    }
    const results = res.results
      .map(r => r.content)
      .filter((c): c is NonNullable<V1SearchResult["content"]> => !!c)
      .map(c => searchResultToSummary(c, this.webBase));
    const hasMore = Boolean(res._links?.next);
    return { results, nextCursor: hasMore ? String(start + limit) : undefined };
  }

  // --- content writes ---

  createPage(body: {
    title: string; storageValue: string; status: "current" | "draft"; spaceId: string; parentId?: string;
  }): Promise<ContentResponse> {
    return this.#json("POST", `${V2}/pages`, {
      spaceId: body.spaceId,
      status: body.status,
      title: body.title,
      ...(body.parentId ? { parentId: body.parentId } : {}),
      body: { representation: "storage", value: body.storageValue },
    }).then(tagOne("page"));
  }

  createBlogPost(body: {
    title: string; storageValue: string; status: "current" | "draft"; spaceId: string;
  }): Promise<ContentResponse> {
    return this.#json("POST", `${V2}/blogposts`, {
      spaceId: body.spaceId,
      status: body.status,
      title: body.title,
      body: { representation: "storage", value: body.storageValue },
    }).then(tagOne("blogpost"));
  }

  updateContent(body: {
    id: string; type: ContentType; title: string; version: number; storageValue: string; status?: string;
  }): Promise<ContentResponse> {
    const path = body.type === "blogpost" ? "blogposts" : "pages";
    return this.#json("PUT", `${V2}/${path}/${encodeURIComponent(body.id)}`, {
      id: body.id,
      status: body.status ?? "current",
      title: body.title,
      body: { representation: "storage", value: body.storageValue },
      version: { number: body.version },
    }).then(tagOne(body.type));
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
    return this.#json("POST", `${V2}/footer-comments`, {
      [key]: containerId,
      body: { representation: "storage", value: storageValue },
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.#request("DELETE", `${V2}/footer-comments/${encodeURIComponent(commentId)}`);
  }

  // --- labels ---

  async getLabels(id: string, type: ContentType): Promise<string[]> {
    const path = type === "blogpost" ? "blogposts" : "pages";
    const res = await this.#list<{ name: string }>(`${V2}/${path}/${encodeURIComponent(id)}/labels`, { limit: 250 });
    return res.results.map(l => l.name);
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
      const res = await this.#request<{ results: AttachmentResponse[] }>(
        "POST", `${V1}/content/${encodeURIComponent(id)}/child/attachment`, {
          headers: { "X-Atlassian-Token": "no-check" },
          body: form,
        });
      return res.results[0];
    } catch (err) {
      throw degradeIfGone(err, "Uploading attachments");
    }
  }

  /** Downloads attachment bytes via its `downloadLink` (relative to the site /wiki base). */
  async downloadAttachment(downloadLink: string): Promise<{ data: Uint8Array; mediaType: string }> {
    const url = `${this.#base()}/wiki${downloadLink}`;
    let token = await this.#getToken();
    let response = await this.#send("GET", url, token, { headers: { Accept: "*/*" } });
    if (response.status === 401 && this.#refresh) {
      token = await this.#refresh();
      response = await this.#send("GET", url, token, { headers: { Accept: "*/*" } });
    }
    if (!response.ok) throw new ConfluenceApiError(response.status, `Attachment download failed: ${response.status}`);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }
}

// Tag a fetched content object / list with its kind (v2 omits `type` from page/blogpost objects).
const tagOne = (type: ContentType) => (c: ContentResponse): ContentResponse => ((c.type = type), c);
const tagAll = (type: ContentType) => (paged: Paged<ContentResponse>): Paged<ContentResponse> => {
  for (const c of paged.results) c.type = type;
  return paged;
};

// Turn a removed-endpoint error into a clear "capability unavailable" message.
function degradeIfGone(err: unknown, capability: string): ConfluenceApiError {
  if (err instanceof ConfluenceApiError && (err.isGone || err.status === 404)) {
    return new ConfluenceApiError(err.status,
      `${capability} is not available: the underlying Confluence endpoint has been removed.`);
  }
  return err instanceof ConfluenceApiError ? err : new ConfluenceApiError(500, String(err));
}

function errorMessage(response: Response, detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { message?: string; errors?: { title?: string }[] };
    const msg = parsed.message ?? parsed.errors?.[0]?.title;
    if (msg) return `${response.status}: ${msg}`;
  } catch { /* not JSON */ }
  return `${response.status} ${response.statusText}`;
}
