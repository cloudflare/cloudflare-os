// Shared fetch helper for the Google gatekeeper API clients.
//
// Two independent retry concerns compose here:
//
//   1. Auth (401). The access token we send can be stale or invalidated before its recorded expiry
//      — e.g. after a re-consent/re-grant, an explicit revoke-then-reconnect, or a refresh-token
//      rotation. The token is cached in the gatekeeper Durable Object's memory and in KV, so a
//      stale-but-unexpired token would otherwise be served on every request and the 401 could not
//      self-heal. On a 401 we mint a fresh token via `getAccessToken({ forceRefresh: true })` and
//      retry exactly once. This is safe on any HTTP method: a 401 is rejected before the request
//      takes effect, so a write is never applied twice.
//
//      A 403 is an insufficient-scope error, so minting cannot fix it: the same grant produces the
//      same scopes. A *re-grant* can, and it always arrives as a different stored token — so on a
//      403 we re-read the authority's stored token and replay only if it actually changed, minting
//      nothing. That is what lets a binding whose resource gained scopes recover from the user's
//      reconnect instead of failing until the memoized token happens to expire.
//
//   2. Transient failures (429 / 5xx / network timeout). Retried with exponential backoff plus full
//      jitter, honoring `Retry-After` when present, on requests that are safe to replay: GETs, and
//      non-GETs that opt in via `idempotent`. A 429, a 5xx and a timeout all leave it ambiguous
//      whether the server already applied a write. Retrying writes needs a per-request idempotency
//      key (`X-Goog-Client-Request-Id` on Gmail send, a client-supplied event id on
//      `events.insert`); that is a follow-up, not this change.
//
// Both concerns share a single attempt counter, so the worst case is a predictable `retries + 2`
// requests: `retries` transient attempts plus one each for the 401 refresh and the 403 reload.

/**
 * Options for requesting an access token.
 *
 * `forceRefresh` means "do not serve me a cached token" — the caller saw a 401, so any token cached
 * against its recorded expiry is known-bad.
 */
export type AccessTokenRequest = {
  forceRefresh?: boolean;
  /** The token the caller just had rejected. Never log this. */
  staleToken?: string;
  /**
   * Bypass the per-Durable-Object memo and answer from the authority's stored token, minting
   * nothing. The caller saw a 403, which only a re-granted scope can fix; a mint of the same grant
   * would cost a token exchange per failing call and return the same scopes.
   */
  reloadStored?: boolean;
};

export type AccessTokenProvider = (opts?: AccessTokenRequest) => Promise<string>;

export type FetchWithAuthRetryOptions = {
  /**
   * Total attempts for transient failures, including the first. Defaults to 3. The one-shot 401
   * refresh does not consume this budget, so the worst case is `retries + 1` requests.
   */
  retries?: number;
  /** Per-attempt abort timeout in milliseconds. Omitted means no timeout is imposed. */
  timeoutMs?: number;
  /**
   * Asserts this request is safe to replay on 429 / 5xx / timeout. Must only be set for a request
   * that performs no writes. Non-GET methods default to unsafe; this is the opt-in for a POST that
   * is still just a read (Drive's batch `files.get` envelope).
   */
  idempotent?: boolean;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/**
 * Whether a transient failure status is worth replaying.
 *
 * Neither a 429 nor a 5xx tells us whether the request took effect before the response, so both are
 * only replayed when the caller has asserted the request is safe to send twice.
 */
function canRetry(status: number, idempotent: boolean): boolean {
  if (status === 429 || (status >= 500 && status <= 599)) return idempotent;
  return false;
}

function backoffDelayMs(attempt: number, retryAfter: string | null): number {
  // Prefer the server's Retry-After when present, capped. Only the delta-seconds form is parsed;
  // the HTTP-date form yields NaN and falls through to exponential backoff, which is fine.
  if (retryAfter) {
    let seconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  // Exponential backoff with full jitter.
  let capped = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.random() * capped;
}

/**
 * Perform an authenticated fetch, injecting a Bearer token and applying both retry concerns
 * described at the top of this file. The `Authorization` header is set from the (possibly
 * refreshed) token on every attempt, so callers must NOT set it themselves; any other headers in
 * `init.headers` are preserved.
 */
export async function fetchWithAuthRetry(
  url: string,
  init: RequestInit,
  getAccessToken: AccessTokenProvider,
  opts: FetchWithAuthRetryOptions = {},
): Promise<Response> {
  let method = (init.method ?? "GET").toUpperCase();
  let retries = opts.retries ?? 3;
  let idempotent = method === "GET" || opts.idempotent === true;
  // A request can only be replayed if its body can be sent again. A string body (what every call
  // site uses today) re-serializes fine; a stream is consumed by the first attempt, so retrying it
  // would send an empty or errored body. Nothing to replay is likewise fine.
  let replayable = init.body === undefined || init.body === null || typeof init.body === "string";

  // One-shot each: a 401 buys one refreshed retry, a 403 one reloaded retry.
  let refreshed = false;
  let reloaded = false;
  let token = await getAccessToken();
  let attempt = 0;

  while (true) {
    // A fresh timeout signal per attempt so a retry gets the full budget, combined with any
    // caller-supplied signal.
    let signals: AbortSignal[] = [];
    if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
    if (init.signal) signals.push(init.signal);
    let signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    let headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Network error or timeout: ambiguous, so retry only when the request is safe to replay.
      if (replayable && idempotent && attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, backoffDelayMs(attempt, null)));
        attempt++;
        continue;
      }
      throw error;
    }

    if (response.status === 401 && !refreshed && replayable) {
      // Deliberately does not touch `attempt`: the refresh is one-shot, so it can add at most one
      // request to the budget rather than doubling it.
      refreshed = true;
      await response.body?.cancel();
      // Naming the rejected token lets the authority collapse a concurrent burst of 401s into a
      // single token exchange — see AccessTokenRequest.
      token = await getAccessToken({ forceRefresh: true, staleToken: token });
      continue;
    }

    if (response.status === 403 && !reloaded && replayable) {
      // Also one-shot, and it replays only on a token that really changed: an unchanged one means
      // the grant itself is insufficient, and re-sending it would just 403 again.
      reloaded = true;
      let stored = await getAccessToken({ reloadStored: true });
      if (stored !== token) {
        token = stored;
        await response.body?.cancel();
        continue;
      }
    }

    if (replayable && canRetry(response.status, idempotent) && attempt < retries - 1) {
      let delay = backoffDelayMs(attempt, response.headers.get("Retry-After"));
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
      continue;
    }

    return response;
  }
}

/**
 * How far ahead of an access token's recorded expiry we treat it as already expired, so a token
 * doesn't lapse mid-request. Shared by `AccessTokenCache` and `UserAccount.getAccessToken`, which
 * must agree — otherwise the caching layer happily serves a token the authoritative layer would
 * already have replaced.
 */
export const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

/**
 * Mints an access token, bypassing any cache of its own when `forceRefresh` is set.
 */
export type MintedAccessToken = { token: string; expires: Date };

export type MintAccessToken = (opts?: AccessTokenRequest) => Promise<MintedAccessToken>;

/**
 * Per-Durable-Object memo of the access token minted by the `UserAccount`, so a gatekeeper doesn't
 * pay an RPC on every API call. The token is re-minted once it is within `skewMs` of expiring, and
 * `forceRefresh` discards it outright — which is what makes the 401 retry in `fetchWithAuthRetry`
 * able to heal a token that Google invalidated ahead of its recorded expiry.
 *
 * Each gatekeeper Durable Object holds its own instance, so these can briefly diverge: two
 * gatekeepers may sit on different vintages of a token, both valid. They converge because every miss
 * goes to the same `UserAccount`, which is the single authority and the only thing that mints.
 *
 * Divergence stops being harmless once a resource's scopes grow: the memo would keep serving a token
 * minted under the narrower grant, and Google answers that with a 403 no mint can repair. So
 * `reloadStored` bypasses the memo without asking the authority to mint, which is how the 403 retry
 * picks up the token a reconnect just stored.
 */
export class AccessTokenCache {
  #cached: MintedAccessToken | undefined;
  #mint: MintAccessToken;
  #skewMs: number;

  constructor(mint: MintAccessToken, skewMs: number = ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
    this.#mint = mint;
    this.#skewMs = skewMs;
  }

  /**
   * Whether the memoized token can answer this request.
   *
   * The `staleToken` arm mirrors the re-check the authority performs, one layer up: a caller whose
   * token was just rejected can be served locally if this cache has already moved past that token,
   * because some earlier caller in the same 401 burst already replaced it.
   *
   * `reloadStored` is never satisfiable here: its whole purpose is to find out whether the authority
   * holds something newer than this memo.
   */
  #satisfies(cached: MintedAccessToken | undefined, opts?: AccessTokenRequest)
      : cached is MintedAccessToken {
    if (!cached) return false;
    if (opts?.reloadStored) return false;
    if (cached.expires.valueOf() <= Date.now() + this.#skewMs) return false;
    if (opts?.staleToken !== undefined) return cached.token !== opts.staleToken;
    return !opts?.forceRefresh;
  }

  async get(opts?: AccessTokenRequest): Promise<string> {
    let cached = this.#cached;
    if (!this.#satisfies(cached, opts)) {
      cached = await this.#mint(opts);
      this.#cached = cached;
    }
    return cached.token;
  }
}
