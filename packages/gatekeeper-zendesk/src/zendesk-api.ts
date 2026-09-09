const REQUEST_TIMEOUT_MS = 25_000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export { MAX_ATTACHMENT_BYTES, REQUEST_TIMEOUT_MS, SUBDOMAIN_RE };

export class ZendeskApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ZendeskApiError";
  }
  get isAuthError(): boolean { return this.status === 401 || this.status === 403; }
  get isNotFound(): boolean { return this.status === 404; }
}

export type ZendeskOAuthGrant = { accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string };
export type ZendeskIdentity = { id: number; name?: string | null; email?: string | null; photo?: { content_url?: string | null } | null };
export type ZendeskTicket = {
  id: number; url?: string; external_id?: string | null; type?: string | null; subject?: string | null; raw_subject?: string | null;
  description?: string | null; priority?: string | null; status?: string | null; requester_id?: number | null; assignee_id?: number | null;
  submitter_id?: number | null; organization_id?: number | null; group_id?: number | null; brand_id?: number | null; tags?: string[];
  custom_fields?: Array<{ id: number; value: string | number | boolean | null | string[] }>; fields?: Array<{ id: number; value: string | number | boolean | null | string[] }>;
  created_at?: string | null; updated_at?: string | null; generated_timestamp?: number | null;
};
export type ZendeskUser = { id: number; name?: string | null; email?: string | null; photo?: { content_url?: string | null } | null };
export type ZendeskComment = { id: number; type?: string; author_id?: number | null; body?: string | null; html_body?: string | null; plain_body?: string | null; public?: boolean; created_at?: string | null; attachments?: ZendeskAttachment[] };
export type ZendeskAttachment = { id: number; file_name?: string | null; content_type?: string | null; size?: number | null; content_url?: string | null; mapped_content_url?: string | null; created_at?: string | null };
export type ZendeskAudit = { id: number; created_at?: string | null; author_id?: number | null; events?: Array<{ type?: string; field_name?: string; value?: unknown; body?: string }> };
export type ZendeskUpload = { token: string; expires_at?: string; attachment: ZendeskAttachment };
/** Cursor-paginated page returned by the Zendesk Export Search Results endpoint. */
export type ZendeskExportSearchPage = { results: ZendeskTicket[]; meta?: { has_more?: boolean; after_cursor?: string | null } | null; links?: { next?: string | null } | null };

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number | null; scope?: string; error?: string; error_description?: string };

function baseUrl(subdomain: string): string {
  if (!SUBDOMAIN_RE.test(subdomain)) throw new Error("Zendesk subdomain must be a DNS label under zendesk.com.");
  return `https://${subdomain}.zendesk.com`;
}

export function normalizeSubdomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const host = trimmed.includes("//") ? new URL(trimmed).hostname : trimmed.replace(/\/+$/g, "");
  const subdomain = host.endsWith(".zendesk.com") ? host.slice(0, -".zendesk.com".length) : host;
  if (!SUBDOMAIN_RE.test(subdomain) || subdomain === "www" || subdomain === "api") {
    throw new Error("Enter a valid Zendesk subdomain, for example `acme` or `acme.zendesk.com`.");
  }
  return subdomain;
}

export function ticketUrl(subdomain: string, id: string | number): string { return `${baseUrl(subdomain)}/agent/tickets/${id}`; }

export function buildAuthorizeUrl(options: { subdomain: string; clientId: string; redirectUri: string; state: string; scope: string }): string {
  const url = new URL(`${baseUrl(options.subdomain)}/oauth/authorizations/new`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("state", options.state);
  return url.toString();
}

function grantFromTokenResponse(json: TokenResponse): ZendeskOAuthGrant {
  if (json.error || !json.access_token) throw new ZendeskApiError(400, [json.error, json.error_description].filter(Boolean).join(": ") || "Zendesk OAuth failed", json);
  if (json.expires_in != null && (!Number.isFinite(json.expires_in) || json.expires_in <= 0)) throw new ZendeskApiError(502, "Zendesk returned an invalid token lifetime.");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in == null ? null : Date.now() + json.expires_in * 1000, scope: json.scope };
}

async function tokenRequest(subdomain: string, body: unknown): Promise<ZendeskOAuthGrant> {
  const res = await fetch(`${baseUrl(subdomain)}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    redirect: "error",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await boundedJson<TokenResponse>(res);
  if (json?.error === "invalid_grant") throw new ZendeskApiError(401, "Zendesk authorization has expired or been revoked. Reconnect Zendesk.");
  if (!res.ok) throw new ZendeskApiError(res.status, json?.error_description ?? json?.error ?? res.statusText, json);
  return grantFromTokenResponse(json ?? {});
}

export function exchangeAuthCode(input: { subdomain: string; code: string; clientId: string; clientSecret: string; redirectUri: string; scope: string }): Promise<ZendeskOAuthGrant> {
  return tokenRequest(input.subdomain, { grant_type: "authorization_code", code: input.code, client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, scope: input.scope });
}

export function refreshAccessToken(input: { subdomain: string; refreshToken: string; clientId: string; clientSecret: string; scope: string }): Promise<ZendeskOAuthGrant> {
  return tokenRequest(input.subdomain, { grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId, client_secret: input.clientSecret, scope: input.scope });
}

async function boundedJson<T>(res: Response): Promise<T | undefined> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_JSON_BYTES) throw new ZendeskApiError(res.status, "Zendesk response exceeded the configured size limit.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new ZendeskApiError(res.status, "Zendesk response exceeded the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ZendeskApiError(res.status, "Zendesk returned malformed JSON.", error);
  }
}

export class ZendeskApi {
  constructor(private readonly subdomain: string, private readonly getToken: () => Promise<string>) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/v2/") && path !== "/api/v2/users/me.json") throw new Error("Unsupported Zendesk API path.");
    const token = await this.getToken();
    const res = await fetch(`${baseUrl(this.subdomain)}${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204) return undefined as T;
    const json = await boundedJson<T & { error?: string; description?: string; details?: unknown }>(res);
    if (!res.ok) throw new ZendeskApiError(res.status, json?.description ?? json?.error ?? res.statusText, json);
    if (json === undefined) throw new ZendeskApiError(res.status, "Zendesk returned an unparseable response.");
    return json;
  }

  async me(): Promise<{ user: ZendeskIdentity }> {
    const result = await this.request<{ user: ZendeskIdentity }>("/api/v2/users/me.json");
    if (!Number.isSafeInteger(result.user?.id) || result.user.id <= 0) throw new ZendeskApiError(401, "Zendesk did not return a signed-in user. Reconnect Zendesk.");
    return result;
  }
  async showTicket(id: string): Promise<ZendeskTicket | null> { try { return (await this.request<{ ticket: ZendeskTicket }>(`/api/v2/tickets/${encodeURIComponent(id)}.json`)).ticket; } catch (e) { if (e instanceof ZendeskApiError && e.isNotFound) return null; throw e; } }
  searchTickets(query: string, page: number, perPage: number): Promise<{ results: ZendeskTicket[]; count?: number; next_page?: string | null }> { return this.request(`/api/v2/search.json?query=${encodeURIComponent(`type:ticket ${query}`.trim())}&page=${page}&per_page=${perPage}`); }
  /**
   * Export Search Results (`GET /api/v2/search/export`), the only Zendesk search endpoint that pages past the
   * 1,000-result ceiling of `/api/v2/search.json`. `filter[type]=ticket` keeps the export scoped to the same single
   * object type as {@link searchTickets}; `after` is the opaque `meta.after_cursor` from the previous page, which
   * Zendesk expires after one hour. Results are ordered by `created_at` only; `sort_by`/`sort_order` are unsupported.
   */
  searchTicketsExport(query: string, perPage: number, after?: string): Promise<ZendeskExportSearchPage> {
    if (!query.trim()) throw new Error("Zendesk export search requires a query. Add search terms or use My work before loading all matches.");
    if (/\btype\s*:/i.test(query)) throw new Error("Zendesk export search does not accept type: terms. Remove the type filter; this search already returns only tickets.");
    const params = new URLSearchParams({ "filter[type]": "ticket", query: query.trim(), "page[size]": String(perPage) });
    if (after) params.set("page[after]", after);
    return this.request(`/api/v2/search/export?${params.toString()}`);
  }
  async comments(id: string): Promise<{ comments: ZendeskComment[]; users: ZendeskUser[] }> {
    const result = await this.#ticketHistory<ZendeskComment>(id, "comments");
    return { comments: result.items, users: result.users };
  }
  async audits(id: string): Promise<{ audits: ZendeskAudit[]; users: ZendeskUser[] }> {
    const result = await this.#ticketHistory<ZendeskAudit>(id, "audits");
    return { audits: result.items, users: result.users };
  }
  async #ticketHistory<T>(id: string, kind: "comments" | "audits"): Promise<{ items: T[]; users: ZendeskUser[] }> {
    const path = `/api/v2/tickets/${encodeURIComponent(id)}/${kind}`;
    const first = new URL(`${baseUrl(this.subdomain)}${path}.json?page[size]=100&${kind === "comments" ? "include=users" : "include_boundary_indicators=true"}`);
    let url = first;
    const seen = new Set<string>();
    const items: T[] = [];
    const users: ZendeskUser[] = [];
    let bytes = 0;
    while (true) {
      if (seen.has(url.href) || seen.size >= 100) throw new Error("Zendesk ticket history pagination exceeded its limit or repeated a page; no partial history returned.");
      seen.add(url.href);
      const page = await this.request<Partial<Record<typeof kind, T[]>> & { users?: ZendeskUser[]; next_page?: string | null; links?: { next?: string | null }; meta?: { has_more?: boolean } }>(url.pathname + url.search);
      bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
      if (bytes > 8_000_000) throw new Error("Zendesk ticket history exceeded its size limit; no partial history returned.");
      const records = page[kind];
      if (!Array.isArray(records) || (page.users !== undefined && !Array.isArray(page.users))) throw new Error("Zendesk returned malformed ticket history.");
      items.push(...records);
      users.push(...(page.users ?? []));
      const next = page.meta?.has_more === false ? null : page.links?.next ?? page.next_page;
      if (!next) {
        if (page.meta?.has_more) throw new Error("Zendesk ticket history is missing its next page.");
        return { items, users };
      }
      url = new URL(next, first);
      // A provider pagination link must not expand this single-ticket capability.
      if (url.origin !== first.origin || url.username || url.password || url.hash || ![path, `${path}.json`].includes(url.pathname)) throw new Error("Zendesk ticket history link is outside the requested ticket.");
    }
  }
  async upload(input: { name: string; contentType: string; data: Uint8Array }): Promise<ZendeskUpload> {
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Zendesk attachments are limited to 5 MiB through this gatekeeper.");
    const res = await fetch(`${baseUrl(this.subdomain)}/api/v2/uploads.json?filename=${encodeURIComponent(input.name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": input.contentType, Accept: "application/json" },
      redirect: "error",
      body: input.data as BodyInit,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await boundedJson<{ upload: ZendeskUpload }>(res);
    if (!res.ok || !json) throw new ZendeskApiError(res.status, "Zendesk upload failed.", json);
    return json.upload;
  }
  updateTicket(id: string, ticket: Record<string, unknown>, safeUpdate?: { updateStamp?: string }): Promise<{ ticket: ZendeskTicket }> {
    if (!safeUpdate?.updateStamp) throw new Error("Zendesk ticket update stamp is required for a safe update.");
    const guarded = { ...ticket, safe_update: true, updated_stamp: safeUpdate.updateStamp };
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: guarded }) });
  }
  async downloadAttachment(url: string, maxBytes = MAX_ATTACHMENT_BYTES): Promise<{ data: Uint8Array; contentType?: string }> {
    const parsed = new URL(url);
    if (parsed.origin !== baseUrl(this.subdomain) || parsed.username || parsed.password) throw new Error("Attachment URL is outside the connected Zendesk subdomain.");
    const res = await fetch(parsed.toString(), { headers: { Authorization: `Bearer ${await this.getToken()}` }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new ZendeskApiError(res.status, `Zendesk attachment download failed: ${res.statusText}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > maxBytes) throw new Error("Zendesk attachment exceeded the configured size limit.");
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error("Zendesk attachment exceeded the configured size limit.");
    return { data, contentType: res.headers.get("content-type") ?? undefined };
  }
}
