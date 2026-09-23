/** OAuth 2.0 token-endpoint client: PKCE, code exchange, refresh, and revocation. */

import { base64url } from "jose";
import { CredentialsExpiredError, type RefreshCredentials } from "./credentials";
import { requirePositiveInt } from "./positive-int";
import { readTextCapped } from "./response-body";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

// RFC 6749 §5.2: `error` is NQSCHAR, i.e. printable ASCII other than `"` and `\`.
const OAUTH_ERROR = /^[\x20\x21\x23-\x5B\x5D-\x7E]{1,64}$/;
const MAX_DESCRIPTION_LENGTH = 256;
// RFC 7636 §4.1.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

const RESERVED_BODY_KEYS = [
  "grant_type", "code", "redirect_uri", "code_verifier", "refresh_token", "scope", "token",
  "token_type_hint", "client_id", "client_secret",
] as const;
const RESERVED_AUTHORIZE_KEYS = [
  "response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge",
  "code_challenge_method",
] as const;
const RESERVED_HEADERS = ["authorization", "content-type"] as const;

/**
 * A PKCE (RFC 7636) verifier and its S256 challenge. Field names mirror the wire parameters, and
 * the value is JSON-safe, so the verifier can ride `advanceToOAuth`'s metadata to the callback.
 */
export type Pkce = { codeVerifier: string; codeChallenge: string; codeChallengeMethod: "S256" };

/**
 * Creates a fresh PKCE verifier and its S256 challenge.
 * @param options `verifierBytes` is the verifier's entropy, 32 to 96 bytes (43 to 128 characters).
 * @returns The verifier, challenge, and challenge method.
 */
export async function createPkce(options: { verifierBytes?: number } = {}): Promise<Pkce> {
  const bytes = options.verifierBytes ?? 32;
  if (!Number.isInteger(bytes) || bytes < 32 || bytes > 96) {
    throw new Error(`verifierBytes must be an integer from 32 to 96, got ${bytes}.`);
  }
  const codeVerifier = base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
  return { codeVerifier, codeChallenge: await pkceChallenge(codeVerifier), codeChallengeMethod: "S256" };
}

/**
 * Derives the S256 challenge of a PKCE verifier.
 * @param codeVerifier RFC 7636 verifier: 43 to 128 unreserved characters.
 * @returns The unpadded base64url SHA-256 digest of the verifier.
 */
export async function pkceChallenge(codeVerifier: string): Promise<string> {
  if (!CODE_VERIFIER.test(codeVerifier)) {
    throw new Error("A PKCE code verifier must be 43 to 128 unreserved characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64url.encode(new Uint8Array(digest));
}

/**
 * How the client authenticates to the token and revocation endpoints.
 * - `basic` sends HTTP Basic credentials, by default as the raw base64 of the UTF-8 `id:secret`,
 *   which is what providers document. `encoding: "form"` form-encodes the id and secret first, as
 *   RFC 6749 §2.3.1 specifies, for a server that decodes them (Ory Hydra does). The two differ only
 *   for characters form encoding escapes, such as a base64 `+`, `/` or `=`, and each fails against
 *   the other kind of server. A raw id may not contain `:` (RFC 7617).
 * - `post` sends `client_id` and `client_secret` in the request body.
 * - `none` sends only `client_id`, for public clients.
 */
export type OAuthClientAuth =
  | { method: "none"; id: string }
  | { method: "basic"; id: string; secret: string; encoding?: "raw" | "form" }
  | { method: "post"; id: string; secret: string };

/** Configures an `OAuthClient`. */
export type OAuthClientOptions = {
  /** Display-safe provider name, used in error messages. */
  label: string;
  /** Client credentials and how they are sent. */
  client: OAuthClientAuth;
  /** HTTPS token endpoint. Its query string is kept. */
  tokenEndpoint: string;
  /** HTTPS authorization endpoint; required by `authorizationUrl`. */
  authorizationEndpoint?: string;
  /** HTTPS RFC 7009 revocation endpoint; required by `revoke`. */
  revocationEndpoint?: string;
  /** Request body encoding. Default `"form"`; `"json"` suits endpoints that only accept JSON. */
  bodyEncoding?: "form" | "json";
  /** Extra request headers, such as `User-Agent`. May not set `Authorization` or `Content-Type`. */
  headers?: Record<string, string>;
  /** Access-token lifetime in seconds, applied when a response omits a valid `expires_in`. */
  defaultExpiresIn?: number;
  /** Joins requested scopes (default `" "`) and splits granted ones (default any whitespace). */
  scopeSeparator?: string;
  /** Per-request timeout, revocation included. Default 30 seconds. */
  timeoutMs?: number;
  /** Response size cap. Default 64 KiB. */
  maxResponseBytes?: number;
  /**
   * Fetch implementation, called detached. Default `globalThis.fetch`, read at each request. Pass a
   * service binding as `binding.fetch.bind(binding)`.
   */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

/** A parsed token response. Plain, structured-clone-safe data; absent fields stay absent. */
export type OAuthTokens = {
  /** Access token. */
  accessToken: string;
  /** Reported token type, not validated. */
  tokenType?: string;
  /** Refresh token, when the provider issued or rotated one. */
  refreshToken?: string;
  /** Absolute access-token expiry in epoch milliseconds, anchored at the request's start. */
  expiresAt?: number;
  /**
   * Granted scopes. Absent means the provider did not say and the caller decides, except that
   * `refresh` reports the scopes it requested, which RFC 6749 §5.1 lets a response omit.
   */
  scopes?: string[];
  /** OpenID Connect ID token, unverified. */
  idToken?: string;
  /** The whole response body, for provider extras. */
  raw: Record<string, unknown>;
};

/**
 * A token or revocation endpoint's rejection, or a malformed success. The message carries only the
 * label, the HTTP status, and a validated `oauthError`. Deliberately not an `HttpError`, and its
 * fields are named so neither `isNoAccessError` (which reads `status`) nor the kit's credential
 * marks (which read `code`) can mistake a token-endpoint failure for their own.
 */
export class OAuthResponseError extends Error {
  /** HTTP status; 3xx for an unfollowed redirect, 2xx for a malformed or error-bearing success. */
  readonly httpStatus: number;
  /** The RFC 6749 §5.2 `error` code, kept only when NQSCHAR-clean and at most 64 characters. */
  declare readonly oauthError?: string;
  /**
   * The provider's sanitized, capped `error_description`. Non-enumerable, and provider-authored:
   * evidence for a gatekeeper's `isGrantDeath`, never for logs or display.
   */
  declare readonly description?: string;

  /**
   * Creates a token-endpoint error.
   * @param label Display-safe provider name.
   * @param httpStatus Response status.
   * @param oauthError Provider `error` code; dropped unless NQSCHAR-clean and at most 64 chars.
   * @param description Provider `error_description`.
   */
  constructor(label: string, httpStatus: number, oauthError?: string, description?: string) {
    const code = oauthError !== undefined && OAUTH_ERROR.test(oauthError) ? oauthError : undefined;
    super(code === undefined && httpStatus >= 200 && httpStatus < 300
      ? `${label} returned a malformed OAuth response.`
      : `${label} rejected the OAuth request (HTTP ${httpStatus}${code ? `, ${code}` : ""}).`);
    this.name = "OAuthResponseError";
    this.httpStatus = httpStatus;
    if (code !== undefined) this.oauthError = code;
    if (description !== undefined) {
      Object.defineProperty(this, "description", {
        value: description.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_DESCRIPTION_LENGTH),
      });
    }
  }
}

/**
 * The default grant-death predicate: an RFC 6749 §5.2 `invalid_grant` below HTTP 500, other than
 * a 429. Only meaningful for a refresh; an `invalid_grant` answering a code exchange is a failed
 * connect.
 * @param error Caught value.
 * @returns Whether the error proves the refresh grant is dead.
 */
export function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthResponseError && error.oauthError === "invalid_grant"
    && error.httpStatus < 500 && error.httpStatus !== 429;
}

/**
 * Talks to one provider's OAuth 2.0 authorization, token, and revocation endpoints. Every request
 * refuses redirects (a followed 307 would re-POST the secret and code), caps the response, and
 * times out. A non-2xx response, or a 2xx body carrying an `error` and no non-empty
 * `access_token`, throws `OAuthResponseError`; network, abort, timeout, and `ResponseTooLargeError`
 * failures propagate unchanged. The client holds no state between calls and classifies nothing as
 * grant death: `oauthRefresh` does.
 *
 * @example
 * ```ts
 * const client = new OAuthClient({
 *   label: "Vendor",
 *   client: { method: "basic", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
 *   authorizationEndpoint: "https://vendor.example/oauth/authorize",
 *   tokenEndpoint: "https://vendor.example/oauth/token",
 * });
 * const tokens = await client.exchangeCode({ code, redirectUri, codeVerifier });
 * ```
 */
export class OAuthClient {
  readonly #label: string;
  readonly #client: OAuthClientAuth;
  readonly #tokenEndpoint: string;
  readonly #authorizationEndpoint: string | undefined;
  readonly #revocationEndpoint: string | undefined;
  readonly #bodyEncoding: "form" | "json";
  readonly #headers: Record<string, string>;
  readonly #defaultExpiresIn: number | undefined;
  readonly #scopeSeparator: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: OAuthClientOptions["fetch"];

  /**
   * Creates a client, validating its configuration up front.
   * @param options Provider endpoints, client credentials, and request policy.
   */
  constructor(options: OAuthClientOptions) {
    this.#label = options.label;
    const client = options.client;
    if (client.method === "basic" && client.encoding !== "form" && client.id.includes(":")) {
      throw new Error("A raw HTTP Basic client id may not contain \":\"; use encoding \"form\".");
    }
    this.#client = client;
    this.#tokenEndpoint = httpsEndpoint("tokenEndpoint", options.tokenEndpoint);
    this.#authorizationEndpoint = options.authorizationEndpoint === undefined
      ? undefined
      : httpsEndpoint("authorizationEndpoint", options.authorizationEndpoint);
    this.#revocationEndpoint = options.revocationEndpoint === undefined
      ? undefined
      : httpsEndpoint("revocationEndpoint", options.revocationEndpoint);
    this.#bodyEncoding = options.bodyEncoding ?? "form";
    this.#headers = options.headers ?? {};
    rejectReserved("headers", Object.keys(this.#headers).map(key => key.toLowerCase()), RESERVED_HEADERS);
    this.#defaultExpiresIn = options.defaultExpiresIn === undefined
      ? undefined
      : requirePositiveInt("defaultExpiresIn", options.defaultExpiresIn);
    if (options.scopeSeparator === "") throw new Error("scopeSeparator must not be empty.");
    this.#scopeSeparator = options.scopeSeparator;
    this.#timeoutMs = requirePositiveInt("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#maxResponseBytes = requirePositiveInt(
      "maxResponseBytes", options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.#fetch = options.fetch;
  }

  /**
   * Builds an authorization-code request URL. The endpoint's own query parameters are kept; append
   * multi-valued parameters to the returned URL.
   * @param request `scopes` are omitted when absent or empty; `codeChallenge` is sent as S256;
   * `params` may not set a parameter this method owns.
   * @returns The URL to send the browser to.
   */
  authorizationUrl(request: {
    redirectUri: string;
    state: string;
    scopes?: readonly string[];
    codeChallenge?: string;
    params?: Record<string, string>;
  }): URL {
    if (this.#authorizationEndpoint === undefined) {
      throw new Error(`${this.#label} has no authorization endpoint configured.`);
    }
    const params = request.params ?? {};
    rejectReserved("authorization parameters", Object.keys(params), RESERVED_AUTHORIZE_KEYS);
    const url = new URL(this.#authorizationEndpoint);
    const query: Record<string, string> = {
      ...params,
      response_type: "code",
      client_id: this.#client.id,
      redirect_uri: request.redirectUri,
      state: request.state,
    };
    if (request.scopes?.length) query.scope = request.scopes.join(this.#scopeSeparator ?? " ");
    if (request.codeChallenge !== undefined) {
      query.code_challenge = request.codeChallenge;
      query.code_challenge_method = "S256";
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /**
   * Redeems an authorization code. An `invalid_grant` here is a failed connect, never grant death.
   * @param request The callback's `code`, the `redirectUri` the authorization used, and the PKCE
   * verifier when one was sent.
   * @returns The parsed tokens.
   */
  async exchangeCode(request: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    params?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<OAuthTokens> {
    const body = this.#body(request.params, {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
    });
    if (request.codeVerifier !== undefined) body.code_verifier = request.codeVerifier;
    return this.#token(body, request.signal);
  }

  /**
   * Redeems a refresh token. Prefer `oauthRefresh`, which classifies grant death.
   * @param request The refresh token and, optionally, a narrowed scope set.
   * @returns The parsed tokens, carrying the requested scopes when the response omits `scope`. A
   * provider that does not rotate omits `refreshToken`.
   */
  async refresh(request: {
    refreshToken: string;
    scopes?: readonly string[];
    params?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<OAuthTokens> {
    const body = this.#body(request.params, {
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
    });
    const scopes = request.scopes?.length ? [...request.scopes] : undefined;
    if (scopes) body.scope = scopes.join(this.#scopeSeparator ?? " ");
    const tokens = await this.#token(body, request.signal);
    if (scopes && tokens.scopes === undefined) tokens.scopes = scopes;
    return tokens;
  }

  /**
   * Revokes a token at the RFC 7009 revocation endpoint. Any 2xx response succeeds unless its body
   * carries an `error`.
   * @param request The token and an optional type hint.
   */
  async revoke(request: {
    token: string;
    tokenTypeHint?: "access_token" | "refresh_token";
    params?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<void> {
    const body = this.#body(request.params, { token: request.token });
    if (request.tokenTypeHint !== undefined) body.token_type_hint = request.tokenTypeHint;
    await this.#post(this.#revocation(), body, request.signal);
  }

  /**
   * Escape hatch: POSTs arbitrary parameters with this client's authentication, hardening, and
   * error detection, but no reserved-key checks and no `access_token` check. Pair it with
   * `parseTokenResponse` for providers whose token requests or responses are non-standard.
   * @param endpoint Which configured endpoint to call.
   * @param params Body parameters; client authentication is added.
   * @param options Optional abort signal.
   * @returns The JSON response body, or `{}` when a 2xx body is not a JSON object.
   */
  async request(
    endpoint: "token" | "revocation",
    params: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const url = endpoint === "token" ? this.#tokenEndpoint : this.#revocation();
    return (await this.#post(url, { ...params }, options.signal)).body;
  }

  #revocation(): string {
    if (this.#revocationEndpoint === undefined) {
      throw new Error(`${this.#label} has no revocation endpoint configured.`);
    }
    return this.#revocationEndpoint;
  }

  #body(params: Record<string, string> = {}, fields: Record<string, string>): Record<string, string> {
    rejectReserved("request parameters", Object.keys(params), RESERVED_BODY_KEYS);
    return { ...params, ...fields };
  }

  async #token(body: Record<string, string>, signal?: AbortSignal): Promise<OAuthTokens> {
    const requestedAt = Date.now();
    const response = await this.#post(this.#tokenEndpoint, body, signal);
    if (!hasAccessToken(response.body)) throw new OAuthResponseError(this.#label, response.status);
    return parseTokenResponse(response.body, {
      requestedAt,
      defaultExpiresIn: this.#defaultExpiresIn,
      scopeSeparator: this.#scopeSeparator,
    });
  }

  async #post(
    url: string, body: Record<string, string>, signal?: AbortSignal,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers = new Headers({ Accept: "application/json" });
    for (const [key, value] of Object.entries(this.#headers)) headers.set(key, value);
    const client = this.#client;
    if (client.method === "basic") {
      headers.set("Authorization", `Basic ${basicCredentials(client)}`);
    } else {
      body.client_id = client.id;
      if (client.method === "post") body.client_secret = client.secret;
    }
    let encoded: string | URLSearchParams;
    if (this.#bodyEncoding === "json") {
      headers.set("Content-Type", "application/json");
      encoded = JSON.stringify(body);
    } else {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      encoded = new URLSearchParams(body);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const fetch = this.#fetch ?? globalThis.fetch;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: encoded,
      redirect: "manual",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    const { status } = response;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new OAuthResponseError(this.#label, status);
    }
    const parsed = jsonObject(await readTextCapped(response, this.#maxResponseBytes));
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const description = typeof parsed.error_description === "string"
      ? parsed.error_description
      : undefined;
    if (!response.ok || (error !== undefined && !hasAccessToken(parsed))) {
      throw new OAuthResponseError(this.#label, status, error, description);
    }
    return { status, body: parsed };
  }
}

/**
 * Parses a token response body. The escape hatch for nested or renamed payloads: pass the object
 * that holds the standard fields (Slack's `authed_user`, for example).
 * @param body Response object holding `access_token` and the other RFC 6749 §5.1 fields.
 * @param options `requestedAt` anchors `expiresAt` (take it before sending the request);
 * `defaultExpiresIn` (seconds) applies when `expires_in` is absent or invalid;
 * `scopeSeparator` splits `scope`, default any whitespace.
 * @returns The parsed tokens.
 * @throws When `access_token` is missing or empty.
 */
export function parseTokenResponse(
  body: Record<string, unknown>,
  options: { requestedAt: number; defaultExpiresIn?: number; scopeSeparator?: string },
): OAuthTokens {
  const { access_token, token_type, refresh_token, expires_in, scope, id_token } = body;
  if (typeof access_token !== "string" || access_token === "") {
    throw new Error("The token response carried no access_token.");
  }
  const tokens: OAuthTokens = { accessToken: access_token, raw: body };
  if (typeof token_type === "string") tokens.tokenType = token_type;
  if (typeof refresh_token === "string" && refresh_token !== "") tokens.refreshToken = refresh_token;
  const lifetime = expiresInSeconds(expires_in) ?? options.defaultExpiresIn;
  if (lifetime !== undefined) tokens.expiresAt = options.requestedAt + lifetime * 1000;
  if (typeof scope === "string") {
    tokens.scopes = scope.split(options.scopeSeparator ?? /\s+/).filter(Boolean);
  }
  if (typeof id_token === "string") tokens.idToken = id_token;
  return tokens;
}

/**
 * Adapts an `OAuthClient` refresh to the `RefreshCredentials` contract `CredentialCoordinator`
 * expects. Throws `CredentialsExpiredError` only on proof of grant death, with the provider error
 * as its `cause`; every other failure is rethrown as the same instance. Single-flight is the
 * coordinator's, so the adapter adds no lock. A token whose lifetime is within the coordinator's
 * `refreshSkewMs` refreshes on every read: keep the skew below the provider's shortest lifetime.
 * @param client Client for the provider's token endpoint.
 * @param options `refreshToken` reads the stored refresh token, and a missing one throws
 * `CredentialsExpiredError` without a request; `merge` returns the **complete** replacement record,
 * usually via `mergeOAuthTokens`; `isGrantDeath` replaces the default `isInvalidGrant` on
 * provider evidence, so widen it by composing (`isInvalidGrant(error) || …`); `request` adds scopes
 * or parameters per refresh; `expiredMessage` is the display-safe expiry message.
 * @returns A refresh for `fresh`, `rotate`, `snapshot`, and `adjudicateRejection`.
 *
 * @example
 * ```ts
 * const refresh = oauthRefresh<Grant>(client, {
 *   refreshToken: grant => grant.refreshToken,
 *   merge: mergeOAuthTokens,
 *   expiredMessage: "Reconnect your Vendor account.",
 * });
 * const grant = await this.#creds.fresh(refresh);
 * ```
 */
export function oauthRefresh<Creds>(client: OAuthClient, options: {
  refreshToken(current: Creds): string | undefined;
  merge(current: Creds, tokens: OAuthTokens): Creds;
  isGrantDeath?(error: OAuthResponseError): boolean;
  request?(current: Creds): { scopes?: readonly string[]; params?: Record<string, string> };
  expiredMessage: string;
}): RefreshCredentials<Creds> {
  const isGrantDeath = options.isGrantDeath ?? isInvalidGrant;
  return async current => {
    const refreshToken = options.refreshToken(current);
    if (!refreshToken) throw new CredentialsExpiredError(options.expiredMessage);
    let tokens: OAuthTokens;
    try {
      tokens = await client.refresh({ ...options.request?.(current), refreshToken });
    } catch (error) {
      if (error instanceof OAuthResponseError && isGrantDeath(error)) {
        throw new CredentialsExpiredError(options.expiredMessage, { cause: error });
      }
      throw error;
    }
    return options.merge(current, tokens);
  };
}

/** The grant fields `mergeOAuthTokens` maintains. */
export type OAuthGrant = Pick<OAuthTokens, "accessToken" | "refreshToken" | "expiresAt" | "scopes">;

/**
 * The canonical refresh merge. Keeps every other field of `current`, an unrotated refresh token,
 * and unreported scopes; replaces `expiresAt`, removing it when the response carries none, since a
 * stale past expiry would refresh on every read. A grant type that requires `expiresAt` needs a
 * client with `defaultExpiresIn`.
 * @param current The stored grant.
 * @param tokens The refresh response.
 * @returns The complete replacement grant.
 */
export function mergeOAuthTokens<G extends OAuthGrant>(current: G, tokens: OAuthTokens): G {
  const merged: OAuthGrant = { ...current, accessToken: tokens.accessToken };
  if (tokens.refreshToken !== undefined) merged.refreshToken = tokens.refreshToken;
  if (tokens.scopes !== undefined) merged.scopes = tokens.scopes;
  if (tokens.expiresAt === undefined) delete merged.expiresAt;
  else merged.expiresAt = tokens.expiresAt;
  return merged as G;
}

function httpsEndpoint(label: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an absolute URL.`, { cause: error });
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  // The serialized form percent-encodes a literal `#` everywhere but the fragment delimiter.
  if (url.username || url.password || url.href.includes("#")) {
    throw new Error(`${label} must not include credentials or a fragment.`);
  }
  return url.href;
}

function rejectReserved(what: string, keys: readonly string[], reserved: readonly string[]): void {
  const key = keys.find(candidate => reserved.includes(candidate));
  if (key !== undefined) throw new Error(`OAuth ${what} may not set the reserved key "${key}".`);
}

function basicCredentials(
  { id, secret, encoding }: Extract<OAuthClientAuth, { method: "basic" }>,
): string {
  const encode = (value: string) => encoding === "form" ? formEncode(value) : value;
  const bytes = new TextEncoder().encode(`${encode(id)}:${encode(secret)}`);
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

/** `application/x-www-form-urlencoded` encoding of a single value (RFC 6749 Appendix B). */
function formEncode(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON: an HTML error page, a form-encoded body, or nothing at all.
  }
  return {};
}

function hasAccessToken(body: Record<string, unknown>): boolean {
  return typeof body.access_token === "string" && body.access_token !== "";
}

function expiresInSeconds(value: unknown): number | undefined {
  const seconds = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  // Checked in milliseconds, where a finite lifetime can still overflow to an Infinity `expiresAt`.
  return typeof seconds === "number" && seconds > 0 && Number.isFinite(seconds * 1000)
    ? seconds : undefined;
}
