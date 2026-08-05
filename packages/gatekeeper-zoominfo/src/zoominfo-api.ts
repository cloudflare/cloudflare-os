import "cloudflare:workers";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

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

const DEFAULT_API_BASE_URL = "https://api.zoominfo.com/gtm";
const DEFAULT_AUTHORIZE_URL = "https://api.zoominfo.com/gtm/oauth/v1/authorize";
const DEFAULT_TOKEN_URL = "https://api.zoominfo.com/gtm/oauth/v1/token";
const REQUEST_TIMEOUT_MS = 30_000;

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

async function tokenRequest(
  body: URLSearchParams,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<ZoomInfoTokenGrant> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (parsed && typeof parsed === "object") {
      const details = parsed as { error?: string; error_description?: string };
      message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
    }
    throw new ZoomInfoApiError(response.status, message, parsed);
  }

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

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresIn: result.expires_in ?? 3600,
    scopes: result.scope ? result.scope.split(" ").filter(Boolean) : [],
    idToken: result.id_token ?? null,
  };
}

/** Exchange an authorization `code` (+ PKCE verifier) for tokens. */
export async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<ZoomInfoTokenGrant> {
  return await tokenRequest(
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

/** Exchange a refresh token for a fresh access token (and a rotated refresh token). */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<ZoomInfoTokenGrant> {
  return await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    tokenUrl,
    clientId,
    clientSecret,
  );
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

  constructor(getToken: () => Promise<string>, baseUrl: string = DEFAULT_API_BASE_URL) {
    this.#getToken = getToken;
    this.#baseUrl = stripTrailingSlashes(baseUrl);
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

    const token = await this.#getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.api+json, application/json",
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), init);

    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new ZoomInfoApiError(response.status, formatApiError(response, parsed), parsed);
    }
    return (parsed ?? { data: null }) as JsonApiDoc;
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
