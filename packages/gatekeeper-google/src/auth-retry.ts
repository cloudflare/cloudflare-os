// The Google gatekeeper's request helper, over its upstream client (`googleUpstream` in
// `upstream.ts`), which times, retries and counts each attempt. What this adds is the token.
//
// The access token we send can be stale or invalidated before its recorded expiry, e.g. after a
// re-consent/re-grant, an explicit revoke-then-reconnect, or a refresh-token rotation. The token
// is cached in the gatekeeper Durable Object's memory and in KV, so a stale-but-unexpired token
// would otherwise be served on every request and the 401 could not self-heal. On a 401 we mint a
// fresh token via `getAccessToken({ forceRefresh: true })` and replay exactly once. This is safe
// on any HTTP method: a 401 is rejected before the request takes effect, so a write is never
// applied twice.
//
// A 403 is an insufficient-scope error, so minting cannot fix it: the same grant produces the
// same scopes. A *re-grant* can, and it always arrives as a different stored token, so on a 403
// we re-read the authority's stored token and replay only if it actually changed, minting
// nothing. That is what lets a binding whose resource gained scopes recover from the user's
// reconnect instead of failing until the memoized token happens to expire.
//
// Neither replay uses an attempt of the retry of transient failures (a 429, a 5xx, a network
// failure or a timeout, of a request that is safe to send twice), so the worst case is a
// predictable `retries + 2` requests: `retries` transient attempts plus one each for the 401
// refresh and the 403 reload. A write is sent again after a transient failure only where its
// caller marks it `idempotent`, as one that carries an idempotency key of its own. Gmail's send
// (`X-Goog-Client-Request-Id`) and `events.insert` (a client-supplied event id) carry none, and
// are sent once.

import type {
  AnsweredWith, CallAnswer, UpstreamRequestInit,
} from "@gadgets/gatekeeper-kit/upstream";
import { googleUpstream, type NamedOperation } from "./upstream";

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

/** How `fetchWithAuthRetry` and `readWithAuthRetry` send one request, beside what `fetch` takes. */
export type FetchWithAuthRetryOptions = {
  /**
   * Mints the request's Bearer token. `null` for a request that carries none: one that obtains or
   * revokes a token, or whose URL is its own credential. Such a request is sent as given, with no
   * `Authorization` header added and nothing replayed with another token.
   */
  getAccessToken: AccessTokenProvider | null;
  /**
   * Total attempts for transient failures, including the first. Defaults to 3. The one-shot 401
   * refresh and 403 reload do not consume this budget, so the worst case is `retries + 2`
   * requests.
   */
  retries?: number;
  /**
   * Per-attempt abort timeout in milliseconds, the reading of the answer's body included.
   * Omitted means the client's 30 seconds; `null` means no timeout, for an answer read as a
   * stream at its reader's pace.
   */
  timeoutMs?: number | null;
  /**
   * Asserts this request is safe to replay on 429 / 5xx / timeout. Must only be set for a request
   * that performs no writes. Non-GET methods default to unsafe; this is the opt-in for a POST that
   * is still just a read (Drive's batch `files.get` envelope).
   */
  idempotent?: boolean;
  /**
   * The request's name in the metrics, one of a closed list. Left out, the name is read from the
   * method and URL (`googleOperation`), and is the HTTP method alone where the URL is not one that
   * can be read. Pass it only where the URL cannot say what the request does, as a token's
   * exchange and its refresh share one URL.
   */
  operation?: NamedOperation;
  /**
   * How an answered attempt is counted where its status and headers say what its status alone
   * does not, as an answer whose headers are not those the request was sent for. It answers at
   * once, of each attempt, and reads no body. Left out, or where it returns undefined, the
   * attempt is counted by its status.
   */
  answer?: (answered: AnsweredWith) => CallAnswer | undefined;
};

// What the client is given for one request: what `fetch` takes, the request's own options and,
// where it carries a token, the token of each attempt and the replay of a 401 and a 403.
function requestOf(init: RequestInit, opts: FetchWithAuthRetryOptions): UpstreamRequestInit {
  let { getAccessToken } = opts;
  let request = {
    ...init,
    operation: opts.operation,
    idempotent: opts.idempotent,
    timeoutMs: opts.timeoutMs,
    answer: opts.answer,
    ...(opts.retries === undefined ? {} : { retry: { attempts: opts.retries } }),
  };
  if (!getAccessToken) return request;

  // The token of the attempt to send: minted before the first, and kept until a 401 or a 403
  // replaces it.
  let token: string | undefined;
  // Takes `minted` for the next attempt, and says whether it is another than the one refused.
  let replaced = (minted: string) => {
    let changed = minted !== token;
    token = minted;
    return changed;
  };
  // One-shot each: a 401 buys one refreshed replay, a 403 one reloaded replay.
  let refreshed = false;
  let reloaded = false;
  return {
    ...request,
    authorize: async () => ({ Authorization: `Bearer ${token ??= await getAccessToken()}` }),
    replay: async response => {
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        // Naming the rejected token lets the authority collapse a concurrent burst of 401s into
        // a single token exchange (see AccessTokenRequest). A provider that cannot refresh (a
        // fixed token) hands back the one just rejected, which is not sent again.
        return replaced(await getAccessToken({ forceRefresh: true, staleToken: token }));
      }
      if (response.status === 403 && !reloaded) {
        // It replays only on a token that really changed: an unchanged one means the grant
        // itself is insufficient, and re-sending it would just 403 again.
        reloaded = true;
        return replaced(await getAccessToken({ reloadStored: true }));
      }
      return false;
    },
  };
}

/**
 * Perform a fetch to Google through `googleUpstream`, injecting a Bearer token and replaying a
 * 401 and a 403 as described at the top of this file. The `Authorization` header is set from the
 * (possibly refreshed) token on every attempt, so callers must NOT set it themselves; any other
 * headers in `init.headers` are preserved. A request with no token provider gets no header and
 * no replay with another token. No redirect is followed unless `init.redirect` is `"follow"`.
 *
 * The attempt returned is counted by its status when its headers arrive, so this is for a request
 * whose success holds nothing that is read here: a stream handed on unread, or a body that is let
 * go. A success that is read goes through `readWithAuthRetry`.
 * @param url The request's URL.
 * @param init What `fetch` takes: the method, headers, body, signal and redirect mode.
 * @param opts The token provider, and the request's attempts, timeout and name.
 * @returns The answer of the last attempt, whatever its status.
 */
export function fetchWithAuthRetry(
  url: string | URL,
  init: RequestInit,
  opts: FetchWithAuthRetryOptions,
): Promise<Response> {
  return googleUpstream.request(url, requestOf(init, opts));
}

/**
 * Sends a request as `fetchWithAuthRetry` does and reads its answer inside the client's `read`,
 * so that the attempt is counted once `parse` has read it, by whether it could be read. An answer
 * `parse` throws on is counted by its status where that is no success. Where it is one, the
 * attempt is an `error` with the reason `parse`, or `timeout` where a timeout cut the reading
 * off, and is not counted where its caller gave the request up. A request that is safe to send
 * twice is sent again where its own timeout cut the reading off.
 * @param url The request's URL.
 * @param init What `fetch` takes: the method, headers, body, signal and redirect mode.
 * @param opts The token provider, and the request's attempts, timeout and name.
 * @param parse Reads the last attempt's answer, whatever its status. What it throws propagates.
 * @param answer How the parsed answer is counted where its status alone does not say, given what
 * `parse` returned and the answer's status and headers: an error inside a success is an `error`
 * with the reason `api`. Left out, or where it returns undefined, the answer is counted by its
 * status.
 * @returns What `parse` returned.
 */
export function readWithAuthRetry<T>(
  url: string | URL,
  init: RequestInit,
  opts: FetchWithAuthRetryOptions,
  parse: (response: Response) => T | Promise<T>,
  answer?: (parsed: T, answered: AnsweredWith) => CallAnswer | undefined,
): Promise<T> {
  return googleUpstream.read(url, requestOf(init, opts), parse, answer);
}

// What `readCheckedWithAuthRetry` reads of an answer: what `check` made of it, or what `check`
// threw.
type Checked<T> = { made: T } | { unusable: unknown };

/**
 * Sends a request as `readWithAuthRetry` does, and gives what `parse` read of its answer to
 * `check`, within the request: the check of the method that sent it, which makes of the answer
 * what the request was sent for and throws where the answer holds no such thing. An answer
 * `check` throws on is counted an `error` with the reason `api` where its status is from 200 to
 * 299, and by its status otherwise, and what `check` threw is thrown once the attempt is counted.
 * The request is sent no more often for it: only what `parse` throws is an answer that could not
 * be read.
 * @param url The request's URL.
 * @param init What `fetch` takes: the method, headers, body, signal and redirect mode.
 * @param opts The token provider, and the request's attempts, timeout and name.
 * @param parse Reads the last attempt's answer, whatever its status. What it throws propagates.
 * @param check Makes of what `parse` read what the request was sent for, or throws. What it
 * returns is awaited, and a rejection is what it threw.
 * @param own Whether what `check` threw is the gatekeeper's own refusal of an answer that holds
 * what was asked for, as one it does not show: such an answer is counted by its status.
 * @returns What `check` returned.
 */
export async function readCheckedWithAuthRetry<P, T>(
  url: string | URL,
  init: RequestInit,
  opts: FetchWithAuthRetryOptions,
  parse: (response: Response) => P | Promise<P>,
  check: (parsed: P) => T | Promise<T>,
  own?: (error: unknown) => boolean,
): Promise<T> {
  let read = await readWithAuthRetry(url, init, opts, async (response): Promise<Checked<T>> => {
    let parsed = await parse(response);
    try {
      return { made: await check(parsed) };
    } catch (unusable) {
      return { unusable };
    }
  }, (checked, { status }) => "unusable" in checked && status >= 200 && status <= 299 &&
    !own?.(checked.unusable) ? { outcome: "error", reason: "api" } : undefined);
  if ("unusable" in read) throw read.unusable;
  return read.made;
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
