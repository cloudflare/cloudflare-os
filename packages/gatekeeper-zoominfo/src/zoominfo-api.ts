import "cloudflare:workers";
import type { CallAnswer, Upstream, UpstreamRequestInit } from "@gadgets/gatekeeper-kit/upstream";
import { createLogger } from "@gadgets/observability/logger";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import {
  DEFAULT_API_BASE_URL, zoominfoUpstream, zoominfoUpstreamAt, type TokenOperation,
} from "./zoominfo-upstream";

// ---------------------------------------------------------------------------
// OAuth (Authorization Code + PKCE) and a thin HTTP wrapper around the ZoomInfo GTM API.
//
// Auth is OAuth 2.0 Authorization Code flow WITH PKCE (ZoomInfo requires PKCE):
//   - `generateCodeVerifier()` / `deriveCodeChallenge()` produce the PKCE pair.
//   - `exchangeAuthCode()` trades the redirect `code` + verifier for access + refresh tokens.
//   - `refreshAccessToken()` trades the refresh token for a fresh access token.
//
// SECURITY: ZoomInfo enforces refresh-token rotation — every refresh returns a NEW refresh token
// and invalidates the old one. Callers MUST persist the returned refresh token on every refresh
// (see UserAccount in zoominfo.ts), or the account will break.
//
// The GTM API is JSON:API-shaped: request bodies are `{ data: { type, attributes } }` and responses
// are `{ data: [...] | {...}, meta, links }`. This wrapper stays generic (get/post returning the
// raw JSON:API document); zoominfo.ts maps documents into the clean types declared in types.d.ts.
//
// Every request goes through the upstream of zoominfo-upstream.ts, which gives each attempt its
// timeout, follows no redirect, sends a GET again after a transient failure and a POST once, and
// counts each attempt as a subservice call.

const DEFAULT_AUTHORIZE_URL = "https://api.zoominfo.com/gtm/oauth/v1/authorize";
const DEFAULT_TOKEN_URL = "https://api.zoominfo.com/gtm/oauth/v1/token";

type ZoomInfoTokenLogFields = {
  vendorId: string;
  grantType: string;
  requestScopePresent: boolean;
  requestedScopeCount: number;
  requestedScopes: string[];
  responseScopePresent: boolean;
  grantedScopes: string[];
  retainedScopes: string[];
  status: number;
  oauthError: string;
};

const logger = createLogger<ZoomInfoTokenLogFields>({ component: "gatekeeper.zoominfo", vendorId: "zoominfo" });

/** OAuth endpoints, overridable via env in case ZoomInfo changes hosts for a deployment. */
export type ZoomInfoOAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
};

export function resolveOAuthConfig(env: {
  ZOOMINFO_AUTHORIZE_URL?: string;
  ZOOMINFO_TOKEN_URL?: string;
  ZOOMINFO_API_BASE_URL?: string;
}): ZoomInfoOAuthConfig {
  return {
    authorizeUrl: env.ZOOMINFO_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
    tokenUrl: env.ZOOMINFO_TOKEN_URL || DEFAULT_TOKEN_URL,
    apiBaseUrl: stripTrailingSlashes(env.ZOOMINFO_API_BASE_URL || DEFAULT_API_BASE_URL),
  };
}

/** Result of a token exchange or refresh. */
export type ZoomInfoTokenGrant = {
  accessToken: string;
  /** New refresh token. Always persist this — ZoomInfo rotates refresh tokens on every use. */
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Granted scopes. */
  scopes: string[];
  /** OIDC ID token (JWT with user identity claims), when returned. */
  idToken: string | null;
};

export class ZoomInfoApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ZoomInfoApiError";
    this.status = status;
    this.details = details;
    // 401 = expired/invalid token. (403 is usually an entitlement/scope problem, not auth.)
    this.isAuthError = status === 401;
  }
}

/**
 * Whether a token-endpoint failure is ZoomInfo refusing the grant itself, which a reconnect alone
 * recovers: RFC 6749's `invalid_grant` in a 4xx other than 429, as the kit's `isInvalidGrant`
 * reads one. Keyed on the OAuth error code rather than the status, which a client misconfiguration
 * (`invalid_client`) or a proxy's error page shares.
 */
export function isGrantRefused(error: unknown): boolean {
  return error instanceof ZoomInfoApiError && error.status >= 400 && error.status < 500 && error.status !== 429
    && (error.details as { error?: unknown } | null | undefined)?.error === "invalid_grant";
}

// ---------------------------------------------------------------------------
// PKCE helpers

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a high-entropy PKCE `code_verifier` (43–128 chars, base64url). */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
}

/** Derive the PKCE `code_challenge` = base64url(SHA-256(code_verifier)). */
export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

// Whether a token answer holds an access token: one that holds none, inside a success, is an
// error of the API, an OAuth `error` included.
function holdsAccessToken(parsed: unknown): boolean {
  return Boolean((parsed as { access_token?: unknown } | null | undefined)?.access_token);
}

// The refresh token a token answer holds, or null for one that holds none.
function refreshTokenOf(parsed: unknown): string | null {
  return (parsed as { refresh_token?: string } | null | undefined)?.refresh_token ?? null;
}

// The ID token a token answer holds, or null for one that holds none.
function idTokenOf(parsed: unknown): string | null {
  return (parsed as { id_token?: string } | null | undefined)?.id_token ?? null;
}

/**
 * Whether a grant's refresh token is one. A code's exchange is sent for a refresh token: its
 * answer is counted as an error of the API where this says it holds none, and the connect flow
 * refuses that grant by this same check. A refresh may hold none: the one it was sent with is kept.
 * @param refreshToken The refresh token of a grant.
 * @returns Whether the grant holds a refresh token.
 */
export function isRefreshToken(refreshToken: string | null): refreshToken is string {
  return Boolean(refreshToken);
}

// Whether the answer of a code's exchange holds the grant a connection is made of: a refresh
// token, and an ID token that names its user to this client. The connect flow refuses a grant by
// these same two checks (`isRefreshToken`, `readIdToken`), so an answer that fails either is
// counted as an error of the API. A refresh is held to neither: it keeps the refresh token it was
// sent with and the user its grant names.
function holdsConnection(parsed: unknown, clientId: string): boolean {
  return isRefreshToken(refreshTokenOf(parsed)) && Boolean(readIdToken(idTokenOf(parsed), clientId).userId);
}

/** How an ID token's claims name its user for display. Either name may change. */
export type IdTokenIdentity = {
  displayName?: string;
  uniqueName?: string;
};

/**
 * Decodes the OIDC ID token ZoomInfo's token endpoint returns with every grant. It came straight
 * from that endpoint over TLS, answering this client's own authenticated request, so its signature
 * needs no check (OpenID Connect Core §3.1.3.7), though it must be addressed to this client. Its
 * `sub`, which the identity provider never reassigns, is the connected user's ID (`userId`); the
 * other claims only name them for display, and may change.
 * @param idToken The ID token of a grant, or null for a grant that holds none.
 * @param clientId The OAuth client the token must be addressed to.
 * @returns The user's ID and display names. The ID is absent where there is no token, it cannot
 * be decoded, it names no user, or it is addressed to another client.
 */
export function readIdToken(idToken: string | null, clientId: string): { userId?: string; identity: IdTokenIdentity } {
  if (!idToken) return { identity: {} };
  try {
    const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)))) as {
      aud?: string | string[];
      name?: string;
      email?: string;
      preferred_username?: string;
      sub?: string;
    };
    if (![json.aud].flat().includes(clientId)) return { identity: {} };
    return {
      userId: typeof json.sub === "string" && json.sub !== "" ? json.sub : undefined,
      identity: {
        displayName: json.name || json.email || json.preferred_username,
        uniqueName: json.email || json.preferred_username || json.sub,
      },
    };
  } catch {
    return { identity: {} };
  }
}

// Posts a form to the token endpoint, sent once and counted under `operation`.
async function tokenRequest(
  operation: TokenOperation,
  body: URLSearchParams,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<ZoomInfoTokenGrant> {
  const parsed = await zoominfoUpstream.read(tokenUrl, {
    method: "POST",
    operation,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
    },
    body: body.toString(),
  }, async response => {
    const answered = await parseBody(response);
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      if (answered && typeof answered === "object") {
        const details = answered as { error?: string; error_description?: string };
        message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
      }
      throw new ZoomInfoApiError(response.status, message, answered);
    }
    return answered;
  }, (answered): CallAnswer | undefined =>
    holdsAccessToken(answered) && (operation !== "token.exchange" || holdsConnection(answered, clientId))
      ? undefined : { outcome: "error", reason: "api" });

  const result = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!result.access_token) {
    throw new ZoomInfoApiError(400, "ZoomInfo token exchange did not return an access token.", parsed);
  }

  const scopes = result.scope ? result.scope.split(" ").filter(Boolean) : [];
  const requestedScopes = body.get("scope")?.split(" ").filter(Boolean) ?? [];
  const grantType = body.get("grant_type") ?? undefined;
  logger.info("ZoomInfo token scopes received", {
    event: "zoominfo.token.scopes",
    grantType,
    requestScopePresent: body.has("scope"),
    requestedScopeCount: requestedScopes.length,
    requestedScopes,
    responseScopePresent: result.scope !== undefined,
    grantedScopes: scopes,
    retainedScopes: grantType === "refresh_token" && scopes.length === 0 ? requestedScopes : undefined,
  });

  return {
    accessToken: result.access_token,
    refreshToken: refreshTokenOf(result),
    expiresIn: result.expires_in ?? 3600,
    scopes,
    idToken: idTokenOf(result),
  };
}

/** Exchange an authorization `code` (+ PKCE verifier) for tokens. Counted as `token.exchange`. */
export async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<ZoomInfoTokenGrant> {
  return await tokenRequest(
    "token.exchange",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
    tokenUrl,
    clientId,
    clientSecret,
  );
}

/**
 * Exchange a refresh token, requesting only its recorded granted scopes when known. Counted as
 * `token.refresh`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  scopes: readonly string[],
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<ZoomInfoTokenGrant> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  // An unknown scope list stays omitted; connect-time defaults could exceed an older grant.
  if (scopes.length > 0) body.set("scope", scopes.join(" "));
  try {
    return await tokenRequest("token.refresh", body, tokenUrl, clientId, clientSecret);
  } catch (error) {
    const oauthError = error instanceof ZoomInfoApiError
      ? (error.details as { error?: unknown } | null | undefined)?.error : undefined;
    logger.error("ZoomInfo token refresh failed", {
      event: "zoominfo.token.refresh.failed",
      // Provider descriptions and transport messages may echo secrets; log only the error kind.
      error: error instanceof Error ? error.name : typeof error,
      status: error instanceof ZoomInfoApiError ? error.status : undefined,
      oauthError: typeof oauthError === "string" ? oauthError : undefined,
      requestScopePresent: body.has("scope"),
      requestedScopeCount: scopes.length,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON:API HTTP wrapper

/** One JSON:API resource object. */
export type JsonApiResource = {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

/** A JSON:API document: `data` may be a list (search/enrich) or a single resource. */
export type JsonApiDoc = {
  data: JsonApiResource[] | JsonApiResource | null;
  meta?: {
    totalResults?: number;
    page?: { number?: number; total?: number };
    [k: string]: unknown;
  };
  links?: { first?: string; last?: string; prev?: string; next?: string };
};

/** Query value(s). Arrays and undefined are handled by the wrapper. */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Thin ZoomInfo GTM API client. Construct with a token getter that returns a valid bearer token
 * (refreshing as needed). Methods return the raw JSON:API document for zoominfo.ts to map.
 */
export class ZoomInfoApi {
  #getToken: () => Promise<string>;
  #baseUrl: string;
  #upstream: Upstream;

  constructor(getToken: () => Promise<string>, baseUrl: string = DEFAULT_API_BASE_URL) {
    this.#getToken = getToken;
    this.#baseUrl = stripTrailingSlashes(baseUrl);
    this.#upstream = zoominfoUpstreamAt(this.#baseUrl);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<JsonApiDoc> {
    const url = new URL(this.#baseUrl + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.api+json, application/json",
    };
    const init: UpstreamRequestInit = {
      method,
      headers,
      // Asked before each attempt, so that a GET sent again carries the token of that moment.
      authorize: async () => ({ Authorization: `Bearer ${await this.#getToken()}` }),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const answered = await this.#upstream.read<Answered>(url.toString(), init, async response => {
      const parsed = await parseBody(response);
      if (!response.ok) {
        throw new ZoomInfoApiError(response.status, formatApiError(response, parsed), parsed);
      }
      // A success whose body is no JSON:API document, a login page or JSON that cannot be read
      // included, is refused here, within the request: no caller takes it for one with no data.
      if (parsed !== undefined && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
        throw new ZoomInfoApiError(502, "ZoomInfo answered with no JSON:API document.", undefined);
      }
      if (parsed === undefined) return { doc: { data: null } };
      // A document that holds errors in place of its data, or no data at all, answers nothing the
      // request was sent for: it is refused, so that no caller takes it for one that matched
      // nothing, and counted an error of the API.
      if (!holdsData(parsed)) {
        // In fixed words: what the provider said is neither copied into an error, which is stored,
        // nor bounded.
        return { refused: new ZoomInfoApiError(502, "ZoomInfo answered with no data.") };
      }
      return { doc: parsed };
    }, answer => "refused" in answer ? { outcome: "error", reason: "api" } : undefined);
    if ("refused" in answered) throw answered.refused;
    return answered.doc;
  }

  /** POST a JSON:API request body `{ data: { type, attributes } }`. */
  async post(
    path: string,
    type: string,
    attributes: Record<string, unknown>,
    query?: QueryParams,
  ): Promise<JsonApiDoc> {
    return await this.#request("POST", path, { query, body: { data: { type, attributes } } });
  }

  /** GET a JSON:API document. */
  async get(path: string, query?: QueryParams): Promise<JsonApiDoc> {
    return await this.#request("GET", path, { query });
  }
}

// A JSON:API request's answer, read: the document, or the error a document that answers nothing
// the request was sent for is thrown as.
type Answered = { doc: JsonApiDoc } | { refused: ZoomInfoApiError };

// Whether a JSON:API document answers what it was asked: data (a list of resources, which may be
// empty, one resource, or `null` for none), or, as JSON:API allows, meta alone. One that holds
// errors in place of data, or neither data nor meta, answers nothing.
function holdsData(doc: object): doc is JsonApiDoc {
  const { data, errors, meta } = doc as { data?: unknown; errors?: unknown; meta?: unknown };
  if (Array.isArray(errors) && errors.length > 0 && (data === undefined || data === null)) return false;
  if (data === undefined) return typeof meta === "object" && meta !== null;
  return data === null || typeof data === "object";
}

function formatApiError(response: Response, parsed: unknown): string {
  const base = `${response.status} ${response.statusText}`;
  if (parsed && typeof parsed === "object") {
    const doc = parsed as {
      detail?: string;
      title?: string;
      errors?: { detail?: string; title?: string }[];
    };
    const fromErrors = doc.errors
      ?.map(e => e.detail || e.title)
      .filter(Boolean)
      .join("; ");
    const message = fromErrors || doc.detail || doc.title;
    if (message) return `${base}: ${message}`;
  }
  return base;
}
