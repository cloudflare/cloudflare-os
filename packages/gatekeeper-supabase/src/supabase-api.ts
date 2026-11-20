import "cloudflare:workers";
import type { CallAnswer, UpstreamRequestInit } from "@gadgets/gatekeeper-kit/upstream";
import { SUPABASE_API_ORIGIN, supabaseUpstream, type SupabaseTokenOperation } from "./supabase-upstream";

/**
 * Thin wrapper around the Supabase Management API (https://api.supabase.com) plus helpers for the
 * OAuth2 authorization-code flow. All access is performed with an OAuth bearer access token.
 *
 * Every request goes through `supabaseUpstream` (`supabase-upstream.ts`), which gives each attempt
 * its timeout, follows no redirect, sends a GET again after a transient failure (a 429, 502, 503
 * or 504, a network failure or a timeout) and counts every attempt as a subservice call.
 */

const TOKEN_URL = `${SUPABASE_API_ORIGIN}/v1/oauth/token`;
const REVOKE_URL = `${SUPABASE_API_ORIGIN}/v1/oauth/revoke`;
const USER_AGENT = "Cloudflare-Gadgets";
// Cap on a single read-only query result, to protect the calling Gadget (and the RPC channel) from
// unbounded payloads. Measured in characters of the JSON response body. Callers paginate past this.
const MAX_QUERY_RESULT_BYTES = 16 * 1024 * 1024;

/** Result of an OAuth token exchange or refresh. */
export type SupabaseOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: string;
};

export class SupabaseApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "SupabaseApiError";
    this.status = status;
    this.details = details;
    // A dead/revoked refresh token makes the token endpoint return 400 `invalid_grant`, so treat
    // that as an auth error too (not just 401) — otherwise expiry goes undetected.
    const invalidGrant = status === 400
      && typeof (details as { error?: string } | undefined)?.error === "string"
      && (details as { error?: string }).error === "invalid_grant";
    this.isAuthError = status === 401 || invalidGrant;
  }
}

// ---------------------------------------------------------------------------
// Raw Management API response shapes (only the fields we consume).

export type OrganizationResponse = {
  slug: string;
  name: string;
};

export type ProjectResponse = {
  ref: string;
  name: string;
  organization_slug: string;
  region: string;
  status: string;
  created_at: string;
  database?: {
    host?: string;
    version?: string;
  };
};

export type FunctionResponse = {
  slug: string;
  name: string;
  status: "ACTIVE" | "REMOVED" | "THROTTLED";
  version: number;
  verify_jwt?: boolean;
  created_at: number;
  updated_at: number;
};

export type StorageBucketResponse = {
  id: string;
  name: string;
  public: boolean;
  created_at: string;
  updated_at: string;
};

export type ServiceHealthResponse = {
  name: string;
  status: "COMING_UP" | "ACTIVE_HEALTHY" | "UNHEALTHY";
  error?: string;
};

/** A single row returned by a SQL query. */
export type SqlRow = Record<string, unknown>;

// Coerce the query endpoint's JSON response into rows. We deliberately do NOT post-process values:
// the endpoint returns plain JSON with no column type/OID metadata, so a real `bytea` value and a
// `jsonb` value that happens to look like a serialized Node Buffer are indistinguishable on the
// wire. Any shape-based "normalization" would silently corrupt legitimate JSON, so values are
// passed through exactly as the endpoint returned them.
function toRows(result: unknown): SqlRow[] {
  return Array.isArray(result) ? (result as SqlRow[]) : [];
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

function errorMessage(status: number, statusText: string, parsed: unknown): string {
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { message?: string; error?: string; error_description?: string };
    const message = obj.message
      ?? [obj.error, obj.error_description].filter(Boolean).join(": ");
    if (message) return message;
  }
  return `${status} ${statusText}`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

// Throws what Supabase answered in place of a success, as the error callers act on.
async function throwApiError(response: Response): Promise<never> {
  const parsed = await parseBody(response);
  throw new SupabaseApiError(response.status, errorMessage(response.status, response.statusText, parsed), parsed);
}

// How a token answer with a successful status is counted: one that holds no grant is an error of
// the API, which the caller throws.
function countGrant(parsed: unknown): CallAnswer | undefined {
  const grant = typeof parsed === "object" && parsed !== null
    && "access_token" in parsed && "refresh_token" in parsed
    && Boolean(parsed.access_token) && Boolean(parsed.refresh_token);
  return grant ? undefined : { outcome: "error", reason: "api" };
}

// Posts a form to the token endpoint, once: a second send would spend a code or a refresh token
// that the first may have used.
async function postTokenForm(
  operation: Extract<SupabaseTokenOperation, "token.exchange" | "token.refresh">,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<SupabaseOAuthGrant> {
  const parsed = await supabaseUpstream.read(TOKEN_URL, {
    method: "POST",
    operation,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: body.toString(),
  }, async response => {
    if (!response.ok) return await throwApiError(response);
    return await parseBody(response);
  }, countGrant);

  const result = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!result.access_token || !result.refresh_token) {
    throw new SupabaseApiError(400, "Supabase OAuth token response was missing tokens.", parsed);
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresIn: result.expires_in ?? 3600,
    tokenType: result.token_type ?? "Bearer",
  };
}

/** Exchange an authorization code for an access + refresh token. */
export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<SupabaseOAuthGrant> {
  return await postTokenForm(
    "token.exchange",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    clientId,
    clientSecret,
  );
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<SupabaseOAuthGrant> {
  return await postTokenForm(
    "token.refresh",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    clientId,
    clientSecret,
  );
}

/** Revoke a refresh token (and the access tokens derived from it). */
export async function revokeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const operation: SupabaseTokenOperation = "token.revoke";
  const response = await supabaseUpstream.request(REVOKE_URL, {
    method: "POST",
    operation,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    // A token Supabase does not know is one that is revoked already: no failure of the revocation.
    answer: ({ status }) => status === 404 ? { outcome: "success" } : undefined,
  });
  if (!response.ok && response.status !== 404) await throwApiError(response);
}

// What `SupabaseApi` reads of a successful answer: its value, the refusal of a result over the
// size cap, or what the method's `read` threw on a body that is not what the method asked for.
// The refusal is the gatekeeper's own, of an answer Supabase gave, so it is thrown once the call
// is counted as the success it was. What `read` threw is thrown once the call is counted an error.
type Answer = { value: unknown } | { refusal: Error } | { unread: unknown };

// A success whose body the method that asked for it refused: an error of the API.
const UNREAD: CallAnswer = { outcome: "error", reason: "api" };

// The rows of a listing Supabase answers as a list. An answer that is none is refused within the
// request, so that it is counted an error and no reader of the rows meets it; an empty list is a
// listing.
function listedRows(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new SupabaseApiError(502, "Supabase answered a listing with no list.");
  return body;
}

// The rows of a read-only query's result: a list, which may be empty. A body that is none says
// nothing of what the query found, and is refused within the request, not taken for zero rows.
function queryRows(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new SupabaseApiError(502, "Supabase answered a query with no list of rows.");
  return body;
}

// A count of characters as megabytes, rounded.
function mb(n: number): number {
  return Math.round(n / (1024 * 1024));
}

// The refusal of a query result of more than `maxBytes` characters.
function tooMuchData(text: string, maxBytes: number): Error {
  let rowCount = "many";
  try {
    const sample = JSON.parse(text);
    if (Array.isArray(sample)) rowCount = String(sample.length);
  } catch {
    // ignore; just report bytes
  }
  return new Error(
    `Query returned too much data (~${mb(text.length)} MB across ${rowCount} rows). ` +
    `Re-run with a LIMIT (and OFFSET to page) or select fewer columns; results must stay ` +
    `under ${mb(maxBytes)} MB.`,
  );
}

/**
 * Authenticated client for the Supabase Management API.
 *
 * The constructor takes a token getter rather than a raw token so that the caller (the
 * `UserAccount` DO) can transparently refresh expired tokens.
 */
export class SupabaseApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  // Sends one request and answers the body of a success: as it is, or what `read` makes of it
  // where a method gives one. `read` runs within the request: a body it throws on is counted as
  // an error of the API, the request is not sent again for it, and what it threw is thrown.
  async #request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | string[] | undefined>;
      body?: unknown;
      acceptText?: boolean;
      // When set, reject (without fully deserializing twice) a success body larger than this many
      // characters. Used to bound query result size.
      maxBytes?: number;
      // The request's retry policy, in place of the upstream's: `null` sends it once.
      retry?: UpstreamRequestInit["retry"];
    } = {},
    read?: (body: unknown) => unknown,
  ): Promise<T> {
    const url = new URL(path, SUPABASE_API_ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, item);
      }
    }

    const headers: Record<string, string> = {
      Accept: options.acceptText ? "text/plain, application/json" : "application/json",
      "User-Agent": USER_AGENT,
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const { maxBytes } = options;
    const answer = await supabaseUpstream.read<Answer>(url.toString(), {
      method,
      headers,
      body,
      retry: options.retry,
      // Asked before every send, so a request sent again carries the token of that moment.
      authorize: async () => ({ Authorization: `Bearer ${await this.#getToken()}` }),
    }, async response => {
      if (!response.ok) return await throwApiError(response);
      let value: unknown;
      if (maxBytes === undefined) {
        value = await parseBody(response);
      } else {
        // Read the body as text so we can size-check it without serializing the parsed result twice.
        const text = await response.text();
        if (text.length > maxBytes) return { refusal: tooMuchData(text, maxBytes) };
        value = text.length === 0 ? undefined : JSON.parse(text);
      }
      if (!read) return { value };
      try {
        return { value: read(value) };
      } catch (unread) {
        return { unread };
      }
    }, parsed => "unread" in parsed ? UNREAD : undefined);
    if ("refusal" in answer) throw answer.refusal;
    if ("unread" in answer) throw answer.unread;
    return answer.value as T;
  }

  async listOrganizations(): Promise<OrganizationResponse[]> {
    return await this.#request<OrganizationResponse[]>("GET", "/v1/organizations", {}, listedRows);
  }

  async listProjects(): Promise<ProjectResponse[]> {
    return await this.#request<ProjectResponse[]>("GET", "/v1/projects", {}, listedRows);
  }

  async getProject(ref: string): Promise<ProjectResponse> {
    return await this.#request<ProjectResponse>("GET", `/v1/projects/${encodeURIComponent(ref)}`);
  }

  /**
   * Runs a read-only SQL statement against the project database. Executes as a restricted
   * read-only Postgres role, so write/DDL statements fail. Returns the result rows.
   */
  async runReadOnlyQuery(ref: string, query: string, parameters?: unknown[]): Promise<SqlRow[]> {
    const result = await this.#request<unknown>(
      "POST",
      `/v1/projects/${encodeURIComponent(ref)}/database/query/read-only`,
      {
        body: parameters && parameters.length > 0 ? { query, parameters } : { query },
        maxBytes: MAX_QUERY_RESULT_BYTES,
      },
      queryRows,
    );
    return toRows(result);
  }

  /**
   * Runs a (potentially mutating) SQL statement against the project database and returns any rows
   * it produces (e.g. from `RETURNING`). The statement is sent once, whatever comes of it: a second
   * send could apply a write twice.
   */
  async runQuery(ref: string, query: string, parameters?: unknown[]): Promise<SqlRow[]> {
    const result = await this.#request<unknown>(
      "POST",
      `/v1/projects/${encodeURIComponent(ref)}/database/query`,
      { body: parameters && parameters.length > 0 ? { query, parameters } : { query }, retry: null },
    );
    return toRows(result);
  }

  async listFunctions(ref: string): Promise<FunctionResponse[]> {
    return await this.#request<FunctionResponse[]>(
      "GET", `/v1/projects/${encodeURIComponent(ref)}/functions`, {}, listedRows);
  }

  async getFunctionBody(ref: string, slug: string): Promise<string> {
    const result = await this.#request<unknown>(
      "GET",
      `/v1/projects/${encodeURIComponent(ref)}/functions/${encodeURIComponent(slug)}/body`,
      { acceptText: true },
    );
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  async listStorageBuckets(ref: string): Promise<StorageBucketResponse[]> {
    return await this.#request<StorageBucketResponse[]>(
      "GET",
      `/v1/projects/${encodeURIComponent(ref)}/storage/buckets`,
      {},
      listedRows,
    );
  }

  async getServicesHealth(ref: string, services: string[]): Promise<ServiceHealthResponse[]> {
    return await this.#request<ServiceHealthResponse[]>(
      "GET",
      `/v1/projects/${encodeURIComponent(ref)}/health`,
      { query: { services } },
      listedRows,
    );
  }
}
