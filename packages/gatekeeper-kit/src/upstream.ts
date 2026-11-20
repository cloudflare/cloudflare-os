/**
 * The client a gatekeeper sends its upstream calls through. It owns what every such call needs
 * and no provider differs in: a timeout per attempt, the retry of a request that is safe to send
 * twice, the redirect mode, a replay hook, and one subservice metric point per attempt
 * (`subservice/v1`, see `@gadgets/observability/metrics`). The gatekeeper owns the rest: its
 * vendor id, the table of its services, the names of its requests, what counts as a success,
 * auth, response schemas, provider errors, host allowlists and pagination.
 *
 * Every string of a point is a closed word. The gatekeeper's code spells out the vendor id, a
 * service, a key of a route tree, and a literal operation, reason or detail. This module writes
 * an HTTP method or `OTHER` for the operation of a request that has no name, and the reasons
 * `rate`, `http`, `timeout`, `network`, `parse` and `exception`. The client builds none from a
 * URL, a host, a header, a body or an error.
 *
 * The tally of the work that is running is kept in an `AsyncLocalStorage` from
 * `node:async_hooks`, so a Worker that imports this module needs that module: the `nodejs_als`
 * (or `nodejs_compat`) compatibility flag provides it.
 */

// oxlint-disable-next-line typescript/triple-slash-reference -- Types `node:async_hooks` in a program that has no Node types.
/// <reference path="../../observability/src/node-async-hooks.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks";
import {
  recordSubserviceCall, subserviceTally, type SubserviceCallInput, type SubserviceOutcome,
  type SubserviceTally,
} from "@gadgets/observability/metrics";
import { requirePositiveInt } from "./positive-int";
import { routeOperation, type Routes } from "./route-operation";

/**
 * A fetch implementation, called detached: `globalThis.fetch`, a service binding's (as
 * `binding.fetch.bind(binding)`), or a guarded one of the gatekeeper's own.
 */
export type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * How one call is counted, where its HTTP status alone does not say. `reason` and `detail` are
 * closed words, literals in the gatekeeper's code (by convention `api` is the reason of an error
 * that a successful status carries), never text taken from an answer. `providerCode` is the
 * service's numeric error code.
 */
export type CallAnswer = {
  outcome: SubserviceOutcome;
  reason?: string;
  detail?: string;
  providerCode?: number;
};

/**
 * What a request's `answer` hook is given of an answered attempt: the status of the answer and
 * a copy of its headers. It holds nothing of the body, which the hook can so neither read nor
 * lock, and what the hook does to the copy changes neither what the retry rule reads nor what
 * the caller is answered with.
 */
export type AnsweredWith = { status: number; headers: Headers };

/**
 * When a request is sent again after a transient failure. Members left out take the default:
 * 3 attempts, a base delay of 500 ms and a longest delay of 10 000 ms.
 */
export type RetryPolicy = {
  /** Sends of one request at most, the first included. A positive integer. Default 3. */
  attempts?: number;
  /**
   * The first backoff ceiling in milliseconds, doubled with each attempt: a wait is a random
   * share of it (full jitter). Not negative. Default 500.
   */
  baseDelayMs?: number;
  /**
   * The longest wait in milliseconds, a `Retry-After` included. Not negative. Default 10 000. No
   * wait is longer than 2 147 483 647 ms, the longest a timer takes.
   */
  maxDelayMs?: number;
  /**
   * Whether an attempt answered with `status` is sent again. The default sends again a request
   * that is idempotent (a GET or HEAD, or one marked `idempotent`) and was answered 429, 502, 503
   * or 504, so the policy never sends a write twice unless it is marked or this says so. It is
   * asked only while attempts remain and the body can be sent again, once about each answer as
   * it comes, and is not asked about an attempt that threw. That one is sent again only when the
   * request is idempotent, and so is one whose answer `read` could not read before its timeout,
   * where the status of that answer is a success. What it says of an answer of any other status
   * stands, though the body of that answer is then not read in time. `headers` are the answer's,
   * for a rule that turns on what the answer says beside its status, such as whether it names a
   * wait and how long a one.
   */
  retryable?: (
    status: number, request: { method: string; operation: string; idempotent: boolean },
    headers: Headers,
  ) => boolean;
  /**
   * The wait in milliseconds before the send after an answered attempt, for a provider that names
   * its wait otherwise than by a `Retry-After` in delta-seconds, or that waits by a rule of its
   * own where the answer names none. It is given the answer, whose body is cancelled, and how
   * many of the policy's `attempts` were made, the answered one included: a replay is none of
   * them. The wait is not negative and at most `maxDelayMs`. Undefined, a throw or what is no
   * number takes the wait `Upstream` describes. It is not asked about an attempt that threw.
   */
  delayMs?: (response: Response, attempts: number) => number | undefined;
};

/** Configures an `Upstream`. */
export type UpstreamOptions = {
  /**
   * The gatekeeper's vendor id, a metric word (a letter or digit, then letters, digits, `.`, `_`
   * and `-`) of at most 49 characters. The source of every point is `gatekeeper.<vendorId>.api`.
   */
  vendorId: string;
  /**
   * The service a request goes to: a literal, or a function returning a literal or a value of a
   * closed table, never a host. The function is given a copy of the request's URL, or undefined
   * where the URL cannot be parsed or the call has none; where it throws, the service is the
   * vendor id. Default `vendorId`.
   */
  service?: string | ((url: URL | undefined) => string);
  /** The paths the gatekeeper calls, by which a request is named (`routeOperation`). */
  routes?: Routes;
  /**
   * A namer of the gatekeeper's own, asked before `routes` with the method in upper case and a
   * copy of the request's URL. It returns a literal, or undefined for a request it does not
   * name. A request it throws on is named by its method.
   */
  operation?: (method: string, url: URL) => string | undefined;
  /**
   * Milliseconds each attempt may take, the reading of its body included. A positive integer, or
   * `null` for no timeout. Default 30 000.
   */
  timeoutMs?: number | null;
  /**
   * The retry policy, or `null` for none: the policy then sends no request again. A request's
   * `replay` hook is no part of the policy and still sends the request again, a write included.
   * Default: see `RetryPolicy`.
   */
  retry?: RetryPolicy | null;
  /**
   * The redirect mode handed to `fetch`. Default `"manual"`: a redirect is answered to the
   * caller and not followed. A redirect followed to another origin carries the request's other
   * headers there, a cookie or an API key included, and for a 307 or 308 its method and body.
   * `Authorization` is dropped, unless the Worker has the
   * `retain_authorization_on_cross_origin_redirect` compatibility flag or a compatibility date
   * from before the runtime dropped it. `"follow"` is for a provider whose redirects the
   * gatekeeper has checked are safe to follow: a gatekeeper that must keep its requests to the
   * origins it allows uses `"manual"` and checks each hop itself.
   */
  redirect?: "follow" | "manual";
  /**
   * Whether `status` is the success of the request named `operation`. Default: below 300 for a
   * request whose redirect mode is `"manual"`, and below 400 for one that follows redirects. It
   * answers at once: a throw, or what is no boolean (a promise is not awaited), is read as the
   * default. It says how an answer is counted and, under `read`, which answer is asked for again
   * where its body timed out (see `Upstream`, Retry).
   */
  succeeded?: (status: number, operation: string) => boolean;
  /** The fetch every attempt is sent with. Default `globalThis.fetch`, read at each attempt. */
  fetch?: UpstreamFetch;
  /**
   * How an attempt whose `fetch` threw is counted, asked with what it threw where the attempt
   * would be counted (see `Upstream`). `null` says that nothing was sent, as where a guard in
   * `fetch` refused the request: the attempt is not counted and the request is not sent again.
   * Undefined, or a throw, counts the attempt as a `timeout` or `network` error.
   */
  thrown?: (error: unknown) => CallAnswer | null | undefined;
};

/**
 * A request's own options, beside those of `fetch`. None of them is handed to `fetch`. The init is
 * any object `fetch` takes for one, a `Request` included: the members of a `fetch` init are read
 * of it by property (see `Upstream`, "What is sent").
 */
export type UpstreamRequestInit = RequestInit & {
  /**
   * The request's name, a literal, for a request its URL cannot name: a token's exchange and its
   * refresh share a URL, as every GraphQL request does.
   */
  operation?: string;
  /** The service the request goes to, a literal, in place of the upstream's. */
  service?: string;
  /** Asserts that this request, though no GET or HEAD, is safe to send twice. */
  idempotent?: boolean;
  /** This request's timeout per attempt, in place of the upstream's; `null` for none. */
  timeoutMs?: number | null;
  /**
   * This request's retry policy: its members replace the upstream's one by one (the default's,
   * where the upstream has none), and `null` is no policy for this request. A `replay` hook is
   * no part of the policy and still sends the request again: a request that must be sent once
   * gives no `replay`.
   */
  retry?: RetryPolicy | null;
  /**
   * This request's redirect mode, `"follow"` or `"manual"`, in place of the upstream's, which is
   * `"manual"` unless it says otherwise. It has the type `fetch` gives it, so that a `RequestInit`
   * is a request's init, and any other mode is handed to `fetch` as given.
   */
  redirect?: RequestInit["redirect"];
  /**
   * Headers for each attempt, asked anew before every one and set over the request's own. A
   * request that has it must not set the same headers itself. Where the caller's signal aborts
   * while it is asked for the headers of a send after the first, that send is not made.
   */
  authorize?: () => HeadersInit | Promise<HeadersInit>;
  /**
   * Asked about an answered attempt before the retry policy is: true sends the request again,
   * with `authorize` asked anew and no attempt of the retry policy used. The attempt is counted
   * before the hook is asked, except under `read`, which counts it afterwards. It is asked only
   * while the body can be sent again and fewer than two replays were made, whatever the
   * request's method and whether or not it has a retry policy. A rejection cancels the answer's
   * body and fails the request. It reads the body from a clone only: an answer that is not sent
   * again is the caller's to read.
   */
  replay?: (response: Response) => boolean | Promise<boolean>;
  /**
   * How an answered attempt is counted by what its status and headers say, asked for each before
   * it is counted. It is given those two alone (`AnsweredWith`) and not the answer, so it reads
   * no body. It answers at once: undefined, a throw or what is no answer counts the attempt by
   * its status, and a promise is no answer and is not awaited. An attempt is counted by what its
   * body says through `read`, whose own `answer` is given the parsed body.
   */
  answer?: (answered: AnsweredWith) => CallAnswer | undefined;
};

/**
 * One gatekeeper's client for its upstream calls (`defineUpstream`).
 *
 * Every request is sent under these rules:
 * - **Names.** The operation is the request's own `operation`, else what the upstream's
 *   `operation` namer returns, else what its `routes` give (`routeOperation`), else the HTTP
 *   method in upper case (`OTHER` for one that is not HTTP's own), which also names a URL that
 *   cannot be parsed. The service is the request's own `service`, else the upstream's, else the
 *   vendor id.
 * - **Timeout.** Each attempt has a fresh `AbortSignal.timeout`, combined with the caller's
 *   signal. The signal is handed to `fetch` and so bounds the reading of the body too: a stream
 *   or a long download passes `null` or a higher value. The caller's signal is the init's
 *   `signal`, else that of a `Request` input. An init's `signal: null` clears the signal of a
 *   `Request` input, as it does for `fetch`: the request then has no caller's signal.
 * - **Retry.** An answered attempt is sent again while attempts remain, its body can be sent
 *   again and `retryable` says so. The body that decides is the init's `body` where that is
 *   neither undefined nor `null`, which can be sent again where it is a string, bytes, a `Blob`,
 *   `URLSearchParams` or `FormData` and not otherwise, as a stream cannot, and else that of a
 *   `Request` input, which never can be: a request with neither has none to send. An attempt
 *   that threw is sent again under the same conditions when the request is idempotent, unless
 *   the upstream's `thrown` says that nothing was sent. So is, under `read`, an attempt whose
 *   answer `parse` could not read once the attempt's own timeout had fired, after the wait of
 *   one that threw, where the status of that answer is a success: by `succeeded` and the
 *   redirect mode, as under Counting, and whatever the request's `answer` counts it as. An
 *   answer of any other status is not sent again for a body that timed out: this rule decided
 *   on it when it came, by `retryable`, and that stands. A write is never sent twice unless it is
 *   marked `idempotent`, the gatekeeper's `retryable` says so, or its `replay` hook does: a
 *   `retry` of `null` turns off this rule and not the Replay one, so a request that must be sent
 *   once gives no `replay`. Nothing is sent again once the caller's signal has aborted, whether
 *   before `authorize` is asked for the headers of that send or while it is. The wait is what
 *   the policy's `delayMs` gives for the answer, else what the answer's `Retry-After` asks for,
 *   either capped at `maxDelayMs`. A `Retry-After` asks for its count of seconds, or the time
 *   left until its HTTP date (in any of the three forms RFC 9110 gives one, as `Sun, 06 Nov 1994
 *   08:49:37 GMT`), which is nothing once the date is past. With no `Retry-After`, or one that
 *   is neither (a day that its month does not have makes no date), and after a throw, the wait
 *   is `Math.random() * min(baseDelayMs * 2 ** attempt, maxDelayMs)`. The body of the answer is
 *   cancelled before the wait, which ends at once when the caller's signal aborts, after an
 *   answer and after a throw alike.
 * - **Replay.** See `UpstreamRequestInit.replay`: at most two more sends of a request.
 * - **What is sent.** The input goes to `fetch` as given. The init is the caller's without the
 *   options of `UpstreamRequestInit`, with `headers` replaced by a `Headers` only where
 *   `authorize` is given, `signal` set where there is a timeout or a caller's signal, and
 *   `redirect` always set: the request's mode, else the upstream's, else `"manual"`, whatever
 *   the mode of a `Request` input. The caller's init is read by property: the enumerable
 *   properties it has of its own are handed on as they are, and so is each further member of a
 *   `fetch` init that it holds any other way and that is not undefined, behind a prototype's
 *   getter for one. A `Request` given for the init so sends its method, headers, body and
 *   signal. Its redirect mode is the request's unless it is `"follow"`, which a `Request` holds
 *   where it was given none and so declares nothing; the `"follow"` of any other object is a
 *   declaration and is handed on. An option that the runtime keeps inside a `Request` and
 *   exposes by no property (the Workers `encodeResponseBody` is one) is so not read from a
 *   `Request` given for the init, though `fetch` itself would read it there: such an option is
 *   passed in a plain init.
 * - **Counting.** Each attempt is one point (`recordCall`) with the milliseconds from its send
 *   to its answer or throw. An answered attempt is a `success` when `succeeded` says so, else
 *   `refused` with the reason `rate` for a 429, else an `error` with the reason `http`, each with
 *   its status, unless the request's `answer` says otherwise. The redirect mode that decides the
 *   default of `succeeded` is the one handed to `fetch`.
 *   An attempt that threw is an `error` with the reason `timeout` when the timeout fired or the
 *   caller's signal aborted with a `TimeoutError`, and with the reason `network` otherwise,
 *   unless the upstream's `thrown` says otherwise. It is not counted when the caller's signal had
 *   aborted before it was sent, nor when the caller aborted it for any other reason. Counting
 *   never throws, never waits and never changes what a request answers or throws.
 */
export interface Upstream {
  /** The gatekeeper's vendor id. */
  readonly vendorId: string;
  /** The source of every point: `gatekeeper.<vendorId>.api`. */
  readonly source: string;
  /**
   * The name a request gets from the upstream's namer and routes, with no request made.
   * @param method The HTTP method, in either case; GET where none is given.
   * @param url The request's URL.
   * @returns The operation, which is the method in upper case (`OTHER` for one that is not
   * HTTP's own) for a request neither names and for a URL that cannot be parsed. Never throws.
   */
  operationOf(method: string | undefined, url: string | URL): string;
  /**
   * Sends one request under the rules above, and counts every attempt.
   * @param input The URL or `Request`, handed to `fetch` as given.
   * @param init The `fetch` init and this request's own options.
   * @returns The answer of the last attempt, whatever its status. Its body is the caller's to
   * read: where the timeout cuts that reading off, the reading fails and the request is not sent
   * again, as it is under `read`.
   * @throws What `fetch`, `authorize`, `replay` or `retryable` threw; the reason of the caller's
   * signal, where that had aborted when the request was to be sent again; and an `Error` for a
   * `timeoutMs` or `retry` that is not valid.
   */
  request(input: string | URL | Request, init?: UpstreamRequestInit): Promise<Response>;
  /**
   * Sends as `request` does, then parses the answer and counts its attempt by what was parsed,
   * which is how an error inside a 200 is counted. The attempts before the last are counted as
   * `request` counts them, but one whose answer `parse` threw on, which is counted as below.
   * @param input The URL or `Request`.
   * @param init The `fetch` init and this request's own options.
   * @param parse Reads the answer. When it throws, what is left of the body is cancelled and the
   * error propagates, unless the Retry rule sends the request again, the attempt's own timeout
   * having fired: `parse` is then asked to read the last answer of what is sent. The attempt is
   * counted, either way, as `request` counts its answer, by the status or by what the request's
   * `answer` says, where that is no `success`. Where it is a `success`, the attempt is an `error`
   * with the reason `parse`, unless the reading was cut off, which the attempt's signal does to
   * it: it is an `error` with the reason `timeout` once the timeout has fired or the caller's
   * signal has aborted with a `TimeoutError`, and is not counted once the caller's signal has
   * aborted for any other reason. What `parse` threw is read for none of this, and the signals
   * alone are: whatever `parse` throws once the attempt's timeout has fired is taken for a
   * reading that the timeout cut off.
   * @param answer How the parsed answer is counted, which is how an attempt is counted by what
   * its body says: the request's own `answer` reads no body. Undefined, a throw or what is no
   * answer (a promise is not awaited) counts it as `request` counts its answer. By convention an
   * error inside a success is an `error` with the reason `api`.
   * @returns What `parse` returned of the last answer.
   */
  read<T>(
    input: string | URL | Request,
    init: UpstreamRequestInit | undefined,
    parse: (response: Response) => T | Promise<T>,
    answer?: (parsed: T, response: Response) => CallAnswer | undefined,
  ): Promise<T>;
  /**
   * Counts one call that is no HTTP request, such as an RPC binding's method or a WebSocket
   * command, with the milliseconds `work` took. It imposes no timeout and sends nothing again.
   * @param operation The call's name, a literal.
   * @param work Makes the call.
   * @param hooks `service` names the service, in place of the upstream's. `answer` counts a
   * result otherwise than as a `success`. `thrown` counts an error: `null` leaves it uncounted,
   * and undefined counts it as an `error` with the reason `timeout` when it is named
   * `TimeoutError` and `exception` otherwise.
   * @returns What `work` returned; what it threw propagates.
   */
  call<T>(
    operation: string,
    work: () => T | Promise<T>,
    hooks?: {
      service?: string;
      answer?: (result: T) => CallAnswer | undefined;
      thrown?: (error: unknown) => CallAnswer | null | undefined;
    },
  ): Promise<T>;
  /**
   * Runs `work` with every call counted in it, however deep and across awaits, summed and
   * written as one point per kind of call when `work` returns or throws or, where it returns a
   * `Promise`, when that settles. An operation that pages through hundreds of requests so stays
   * under the 250 points Analytics Engine takes from one invocation. Under a tally that is
   * running, `work` sums into that one and nothing is written here. Work that `work` leaves
   * running once it has settled is outside the tally: each of its calls is written at once, and
   * a `summed` in it starts a tally of its own. A thenable that is no `Promise` is returned as
   * any other value is, and its `then` is not called.
   * @param work The work whose calls are summed.
   * @returns What `work` returned.
   */
  summed<T>(work: () => T): T;
  /**
   * A fetch-shaped function for code that takes one, such as a remote key set, an SDK or a git
   * transport: each call is `request(input, { ...init, ...defaults })`. Of a call's own init
   * only what `fetch` takes is read, by property as `request` reads its own: a member named as
   * one of a request's own options is dropped, so that the code handed the function sets none of
   * them.
   * @param defaults Options of every request it sends. A `redirect` in a call's own init is used
   * where `defaults` has none.
   * @returns The function. It never throws: a call that fails rejects the promise it returned,
   * as `fetch` does, a member of the init that throws on being read included.
   */
  fetcher(defaults?: Pick<UpstreamRequestInit,
    "operation" | "service" | "idempotent" | "timeoutMs" | "retry" | "redirect" | "authorize"
    | "replay" | "answer">,
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * An upstream of the same vendor with some options replaced, such as the service of calls to
   * an identity provider or a binding's `fetch`. It sums into the same running tally.
   * @param overrides The options to replace. One given as undefined takes its default.
   * @returns The new upstream.
   */
  with(overrides: Partial<Omit<UpstreamOptions, "vendorId">>): Upstream;
}

// A string column's value, as the metrics write it: anything else is written as `invalid`.
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The methods that name a request neither the namer nor the routes do.
const HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRIED_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY: Required<RetryPolicy> = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryable: (status, request) => request.idempotent && RETRIED_STATUSES.has(status),
  delayMs: () => undefined,
};
// A replay answers a 401 with a fresh token and a 403 with a reloaded one: two, and no loop.
const MAX_REPLAYS = 2;
// The longest wait a timer takes: a longer one fires at once.
const LONGEST_TIMER_MS = 2 ** 31 - 1;
// A request's own options, which are not `fetch`'s: `send` hands none of them on.
const OWN_OPTIONS: ReadonlySet<string> = new Set([
  "operation", "service", "idempotent", "timeoutMs", "retry", "authorize", "replay", "answer",
] satisfies (keyof UpstreamRequestInit)[]);
// The members `fetch` reads of its init: those the Fetch standard gives a `RequestInit`, and the
// Workers runtime's own.
const FETCH_MEMBERS = [
  "method", "headers", "body", "referrer", "referrerPolicy", "mode", "credentials", "cache",
  "redirect", "integrity", "keepalive", "signal", "duplex", "priority", "window", "cf", "fetcher",
  "encodeResponseBody",
];

// The tally of the work that is running, when `summedInto` or `Upstream.summed` started one.
const runningTally = new AsyncLocalStorage<SubserviceTally>();
// The tallies `Upstream.summed` has written. Work left running under one is outside it.
const writtenTallies = new WeakSet<SubserviceTally>();

// The tally that is running, or undefined where there is none or it has been written.
function openTally(): SubserviceTally | undefined {
  const tally = runningTally.getStore();
  return tally && !writtenTallies.has(tally) ? tally : undefined;
}

/**
 * Records one subservice call: summed into the tally of the running work (`summedInto`,
 * `Upstream.summed`), written at once (`recordSubserviceCall`) outside one and once
 * `Upstream.summed` has written its tally. For a point a gatekeeper counts itself; the calls an
 * `Upstream` makes are counted by it. Never throws.
 * @param input The call. Every string is a closed word.
 */
export function recordCall(input: SubserviceCallInput): void {
  try {
    const tally = openTally();
    if (tally) tally.add(input);
    else recordSubserviceCall(input);
  } catch {
    // The call goes uncounted: a metric cannot fail the work it counts.
  }
}

/**
 * Runs `work` with every `recordCall` made in it, however deep and across awaits, summed into
 * `tally` rather than written. For work that owns a tally, adds points of its own to it and
 * flushes it itself; `Upstream.summed` is the one that flushes for its caller. Work left running
 * once `work` has settled sums there still, and what it records after the tally's last flush is
 * never written. A stream that `work` returns is read outside it.
 * @param tally The tally to sum into, in place of any already running.
 * @param work The work whose calls are summed.
 * @returns What `work` returned.
 */
export function summedInto<T>(tally: SubserviceTally, work: () => T): T {
  return runningTally.run(tally, work);
}

/**
 * Creates a gatekeeper's client for its upstream calls.
 * @param options The vendor id, how requests are named, and the timeout, retry and redirect
 * policy of every request.
 * @returns The client. See `Upstream` for the rules of a request.
 * @throws When `vendorId` is no metric word of at most 49 characters, `timeoutMs` is neither a
 * positive integer nor `null`, or `retry` has `attempts` below 1 or a delay that is negative or
 * not finite.
 *
 * @example
 * ```ts
 * const upstream = defineUpstream({
 *   vendorId: "vendor",
 *   routes: [["https://api.vendor.example/v1/", { threads: { [ID]: { modify: "POST" } } }]],
 * });
 * // Counted as `threads.get` of the service `vendor`, under `gatekeeper.vendor.api`.
 * const response = await upstream.request("https://api.vendor.example/v1/threads/18c2", {
 *   authorize: async () => ({ Authorization: `Bearer ${await accessToken()}` }),
 * });
 * ```
 */
export function defineUpstream(options: UpstreamOptions): Upstream {
  const { vendorId } = options;
  const source = `gatekeeper.${vendorId}.api`;
  if (typeof vendorId !== "string" || !WORD.test(vendorId) || !WORD.test(source)) {
    throw new Error("vendorId must be a metric word of at most 49 characters.");
  }
  const upstreamTimeoutMs = timeoutOf(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const upstreamRetry = retryOf(options.retry, DEFAULT_RETRY);

  // A request's name, from the upstream's namer and routes. Never throws.
  function nameOf(method: string, url: URL | undefined): string {
    // A method is a name only where it is one of HTTP's own, so that no other word a caller
    // passes for one is written.
    const fallback = HTTP_METHODS.has(method) ? method : "OTHER";
    if (!url) return fallback;
    try {
      // A copy, so that a namer that changes its URL changes nothing of what is sent.
      const named = options.operation?.(method, new URL(url));
      if (typeof named === "string") return named;
      return (options.routes && routeOperation(options.routes, method, url)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // The service of a request or call. Never throws.
  function serviceOf(own: string | undefined, url: URL | undefined): string {
    if (own !== undefined) return own;
    const { service } = options;
    if (typeof service !== "function") return service ?? vendorId;
    try {
      return service(url && new URL(url)) ?? vendorId;
    } catch {
      return vendorId;
    }
  }

  // Whether `status` is the success of `operation`. The hook answers at once, as every hook that
  // only counts does: a throw, or what is no boolean, is read as the default.
  function succeeded(status: number, operation: string, manual: boolean): boolean {
    try {
      const given: unknown = options.succeeded?.(status, operation);
      if (typeof given === "boolean") return given;
      // A promise is not awaited, and its rejection is handled so that none is left unhandled.
      if (given instanceof Promise) given.catch(() => undefined);
    } catch {
      // Read as the default.
    }
    return status < (manual ? 300 : 400);
  }

  // Sends one request, attempt after attempt. Every attempt is counted as it ends but, with
  // `deferred`, the one returned: its caller counts that through `count`, once.
  async function send(
    input: string | URL | Request, init: UpstreamRequestInit, deferred: boolean,
  ): Promise<Sent> {
    const {
      operation: named, service: ownService, idempotent: marked, timeoutMs: ownTimeoutMs,
      retry: ownRetry, authorize, replay, answer, ...own
    } = init;
    const rest = asFetchReads(own, init);
    const request = input instanceof Request ? input : undefined;
    const method = (rest.method ?? request?.method ?? "GET").toUpperCase();
    const url = parsedUrl(input instanceof Request ? input.url : input);
    const operation = named ?? nameOf(method, url);
    const idempotent = method === "GET" || method === "HEAD" || marked === true;
    const timeoutMs = timeoutOf(ownTimeoutMs, upstreamTimeoutMs);
    const retry = retryOf(ownRetry, upstreamRetry);
    // No redirect is followed unless the request or the upstream says so.
    const redirect = rest.redirect ?? options.redirect ?? "manual";
    const manual = redirect === "manual";
    // The signal of a `Request` input is the caller's only where the init gives none: a `null`
    // there clears it, as it does for `fetch`.
    const caller = (rest.signal === undefined ? request?.signal : rest.signal) ?? undefined;
    // The body that decides is the one the init gives, and else that of a `Request` input, which
    // is a stream. A `null` gives none: what `fetch` then sends of the input differs by runtime.
    const resendable = rest.body === undefined || rest.body === null
      ? !request?.body : canResend(rest.body);
    const call = { source, service: serviceOf(ownService, url), operation };

    let attempt = 0;
    let replays = 0;
    // Sends attempt after attempt, from the one that is next, until one is returned.
    const sending = async (): Promise<Sent> => {
      for (;;) {
        // Nothing is sent again once the caller's signal has aborted, and no header is asked for.
        const resend = attempt + replays > 0;
        if (resend) caller?.throwIfAborted();
        const sent: RequestInit = { ...rest };
        if (authorize) {
          const headers = new Headers(rest.headers ?? request?.headers);
          new Headers(await authorize()).forEach((value, name) => headers.set(name, value));
          sent.headers = headers;
          // Nor where it aborted while the headers were asked for. A first send goes to `fetch`
          // with the signal as it is.
          if (resend) caller?.throwIfAborted();
        }
        // A fresh timeout for each attempt, so that a retry has the whole of it.
        const timeout = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
        if (timeout) sent.signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
        sent.redirect = redirect;

        // An attempt begun once its caller's signal has aborted is failed by `fetch` unsent.
        const unsent = caller?.aborted === true;
        const startedAt = Date.now();
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)(input, sent);
        } catch (error) {
          // A request its caller gave up is not one the service failed, and is not counted. A
          // caller that times its own wait aborts with a `TimeoutError`, though, and that is the
          // service not answering, unless the wait ran out before this attempt was sent.
          const waitedOut = errorName(caller?.reason) === "TimeoutError";
          const durationMs = Date.now() - startedAt;
          const counted = !unsent && (!caller?.aborted || waitedOut);
          // A `null` is the gatekeeper saying that nothing was sent: there is no attempt to count
          // or to make again.
          const given = counted ? askedNow(() => options.thrown?.(error)) : undefined;
          if (counted && given !== null) {
            count({ ...call, durationMs }, given ?? {
              outcome: "error", reason: timeout?.aborted || waitedOut ? "timeout" : "network",
            });
          }
          // Whether the service applied the request is not known, so it is sent again only when
          // that is safe.
          if (given !== null && resendable && idempotent && retry && attempt < retry.attempts - 1
              && !caller?.aborted) {
            await pause(backoffMs(retry, attempt, null), caller);
            attempt++;
            continue;
          }
          throw error;
        }

        const { status } = response;
        const answered = { ...call, durationMs: Date.now() - startedAt, httpStatus: status };
        // Whether the status is a success, which no hook that only counts an answer changes.
        const success = succeeded(status, operation, manual);
        // The hook answers at once: nothing between an answer and its count is waited for. It is
        // given the status and the headers alone, so that it leaves the body as it came.
        const verdict = askedNow(() => answer?.({ status, headers: new Headers(response.headers) }))
          ?? byStatus(status, success);
        let counted = false;
        const countOnce = (given: CallAnswer) => {
          if (counted) return;
          counted = true;
          count(answered, given);
        };
        if (!deferred) countOnce(verdict);
        // Asks a hook whether to send again. An answer that is not returned is counted here, and
        // its body cancelled, whether the hook says yes or throws.
        const sendsAgain = async (hook: () => boolean | Promise<boolean>): Promise<boolean> => {
          try {
            if (!await hook()) return false;
          } catch (error) {
            countOnce(verdict);
            release(response);
            throw error;
          }
          countOnce(verdict);
          release(response);
          return true;
        };

        if (replay && resendable && replays < MAX_REPLAYS && await sendsAgain(() => replay(response))) {
          replays++;
          continue;
        }
        if (resendable && retry && attempt < retry.attempts - 1
            && await sendsAgain(() => retry.retryable(
              response.status, { method, operation, idempotent }, response.headers))) {
          await pause(backoffMs(retry, attempt, response), caller);
          attempt++;
          continue;
        }
        return {
          response,
          verdict,
          count: countOnce,
          // The attempt's signal bounds the reading of its answer too, and is read as it is for an
          // attempt that threw: a caller's abort first, which is no failure of the service.
          cutOff: () => {
            if (caller?.aborted && errorName(caller.reason) !== "TimeoutError") return "abort";
            return timeout?.aborted || caller?.aborted ? "timeout" : undefined;
          },
          // A success that the attempt's own timeout kept from being read is an attempt that
          // timed out, and is sent again as one that threw is. An answer that is no success was
          // put to the retry rule when it came, and what the rule said of it stands.
          again: () => {
            if (!success || !timeout?.aborted || caller?.aborted || !resendable || !idempotent
                || !retry || attempt >= retry.attempts - 1) return undefined;
            return pause(backoffMs(retry, attempt++, null), caller).then(sending);
          },
        };
      }
    };
    return sending();
  }

  const upstream: Upstream = {
    vendorId,
    source,
    operationOf(method, url) {
      return nameOf(typeof method === "string" ? method.toUpperCase() : "GET", parsedUrl(url));
    },
    async request(input, init) {
      return (await send(input, init ?? {}, false)).response;
    },
    async read(input, init, parse, answer) {
      let sent = await send(input, init ?? {}, true);
      for (;;) {
        const { response, verdict, count: countLast, cutOff, again } = sent;
        try {
          // Only `parse` throws here: the asking of `answer` and the counting never do.
          const parsed = await parse(response);
          countLast(askedNow(() => answer?.(parsed, response)) ?? verdict);
          return parsed;
        } catch (error) {
          // An answer counted a `success` that could not be read is a malformed one only where
          // its reading was not cut off.
          if (verdict.outcome !== "success") {
            countLast(verdict);
          } else {
            const cut = cutOff();
            if (cut !== "abort") countLast({ outcome: "error", reason: cut ?? "parse" });
          }
          release(response);
          const resent = again();
          if (!resent) throw error;
          sent = await resent;
        }
      }
    },
    call(operation, work, hooks) {
      const call = { source, service: serviceOf(hooks?.service, undefined), operation };
      const startedAt = Date.now();
      return settling(work).then(
        result => {
          count({ ...call, durationMs: Date.now() - startedAt },
            askedNow(() => hooks?.answer?.(result)) ?? { outcome: "success" });
          return result;
        },
        error => {
          const given = askedNow(() => hooks?.thrown?.(error));
          if (given !== null) {
            count({ ...call, durationMs: Date.now() - startedAt }, given ?? {
              outcome: "error",
              reason: errorName(error) === "TimeoutError" ? "timeout" : "exception",
            });
          }
          throw error;
        },
      );
    },
    summed(work) {
      if (openTally()) return work();
      const tally = subserviceTally();
      const flush = () => {
        writtenTallies.add(tally);
        try {
          tally.flush();
        } catch {
          // Nothing is written: a metric cannot fail the work it counts.
        }
      };
      let result: ReturnType<typeof work>;
      try {
        result = runningTally.run(tally, work);
      } catch (error) {
        flush();
        throw error;
      }
      // Only a `Promise` is waited for: the `then` of any other thenable may be what starts its
      // work, and the caller is the one to call it.
      if (result instanceof Promise) result.then(flush, flush);
      else flush();
      return result;
    },
    fetcher(defaults = {}) {
      const given = Object.fromEntries(
        Object.entries(defaults).filter(([, value]) => value !== undefined));
      // An async function, so that a member of the init that throws on being read fails the call
      // as it fails a `fetch`: by a rejection.
      return async (input, init) =>
        (await send(input, { ...fetchInit(init), ...given }, false)).response;
    },
    with(overrides) {
      return defineUpstream({ ...options, ...overrides, vendorId });
    },
  };
  return upstream;
}

// The answer of a request's last attempt, how its status counts, the counting of it, how the
// reading of it was cut off where the attempt's signal has aborted, and the sending of the request
// again where its reading failed: undefined unless the status of the answer is a success, the
// attempt's own timeout has fired and an attempt that threw would be sent again, and else the last
// answer of what is then sent, after the wait.
type Sent = {
  response: Response;
  verdict: CallAnswer;
  count: (answer: CallAnswer) => void;
  cutOff: () => "timeout" | "abort" | undefined;
  again: () => Promise<Sent> | undefined;
};

// The init of a `fetcher`'s caller, read by property, without what is named as one of a
// request's own options.
function fetchInit(init: RequestInit | undefined): RequestInit {
  const given = init ?? {};
  return asFetchReads(
    Object.fromEntries(Object.entries(given).filter(([name]) => !OWN_OPTIONS.has(name))), given);
}

// An init read by property: `own`, a copy of the enumerable properties that `init` has of its
// own, with each member of a `fetch` init that `init` holds any other way, where it is not
// undefined. `fetch` reads an init that is no `Request` by property, so it finds the members that
// a prototype's getters expose, as a `Request` given for an init exposes those it has a getter
// for. A plain init holds none so, and its copy is returned as it is.
function asFetchReads(own: RequestInit, init: RequestInit): RequestInit {
  // A `Request` holds `follow` where it was given no mode: that is no word to follow redirects.
  // Any other object's `follow` is one.
  const request = init instanceof Request;
  for (const member of FETCH_MEMBERS) {
    if (Object.hasOwn(own, member)) continue;
    const value: unknown = Reflect.get(init, member);
    if (request && member === "redirect" && value === "follow") continue;
    if (value !== undefined) Object.assign(own, { [member]: value });
  }
  return own;
}

// The words of a call that are the same whatever its answer.
type CountedCall = {
  source: string; service: string; operation: string; durationMs: number; httpStatus?: number;
};

// Counts one call. Only the four members of an answer are read, so that a hook's answer can
// replace no other column. Never throws.
function count(call: CountedCall, answer: CallAnswer): void {
  try {
    recordCall({
      ...call,
      outcome: answer.outcome,
      reason: answer.reason,
      detail: answer.detail,
      providerCode: answer.providerCode,
    });
  } catch {
    // The call goes uncounted.
  }
}

// How an answered attempt counts by its status alone.
function byStatus(status: number, success: boolean): CallAnswer {
  if (success) return { outcome: "success" };
  return status === 429 ? { outcome: "refused", reason: "rate" } : { outcome: "error", reason: "http" };
}

// What a counting hook answers, or undefined where it answers nothing or throws. Every such
// hook answers at once. A `null` is passed on: a `thrown` hook answers it.
function askedNow<A extends CallAnswer | null | undefined>(hook: () => A): A | undefined {
  try {
    const given = hook();
    return given === null ? given : answerOf(given);
  } catch {
    return undefined;
  }
}

// A hook's answer, where it is one: an object with an outcome. A promise is none, whatever it
// holds: it is not awaited, and its rejection is handled here so that none is left unhandled.
function answerOf<A>(given: A): A | undefined {
  if (given instanceof Promise) {
    given.catch(() => undefined);
    return undefined;
  }
  return typeof given === "object" && given !== null && "outcome" in given
    && typeof given.outcome === "string" ? given : undefined;
}

// The promise of what `work` returns or throws, a throw before its first await included.
function settling<T>(work: () => T | Promise<T>): Promise<T> {
  return new Promise<T>(resolve => resolve(work()));
}

// The name of an error or an abort reason, read from nothing else of it. Never throws.
function errorName(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
    return typeof error.name === "string" ? error.name : undefined;
  } catch {
    return undefined;
  }
}

// The URL of a request, or undefined for what is not one. Never throws.
function parsedUrl(url: string | URL): URL | undefined {
  try {
    return typeof url === "string" ? URL.parse(url) ?? undefined : url;
  } catch {
    return undefined;
  }
}

// Whether a body can be sent a second time. A stream is consumed by its first send, as an
// iterator may be, so only what `fetch` serializes anew each time counts.
function canResend(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || typeof body === "string"
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob
    || body instanceof URLSearchParams || body instanceof FormData;
}

// A timeout: the one given, validated, or the one inherited where none is given.
function timeoutOf(given: number | null | undefined, inherited: number | null): number | null {
  if (given === undefined) return inherited;
  return given === null ? null : requirePositiveInt("timeoutMs", given);
}

// A retry policy: the members given, validated, over the one inherited (the defaults, where that
// is none). Null is no policy.
function retryOf(
  given: RetryPolicy | null | undefined, inherited: Required<RetryPolicy> | null,
): Required<RetryPolicy> | null {
  if (given === undefined) return inherited;
  if (given === null) return null;
  const base = inherited ?? DEFAULT_RETRY;
  return {
    attempts: requirePositiveInt("retry.attempts", given.attempts ?? base.attempts),
    baseDelayMs: delayOf("retry.baseDelayMs", given.baseDelayMs ?? base.baseDelayMs),
    maxDelayMs: delayOf("retry.maxDelayMs", given.maxDelayMs ?? base.maxDelayMs),
    retryable: given.retryable ?? base.retryable,
    delayMs: given.delayMs ?? base.delayMs,
  };
}

function delayOf(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite number of milliseconds, not negative, got ${value}.`);
  }
  return value;
}

// The wait before the attempt after `attempt`, whose answer is `response` (null where it threw):
// what the policy's `delayMs` gives for the answer, else what the server's `Retry-After` asks
// for, else exponential backoff with full jitter. Never longer than the policy's longest delay.
function backoffMs(retry: Required<RetryPolicy>, attempt: number, response: Response | null): number {
  const own = response ? ownDelayMs(retry, response, attempt + 1) : undefined;
  if (own !== undefined) return Math.min(Math.max(own, 0), retry.maxDelayMs);
  const retryAfter = response ? response.headers.get("Retry-After") : null;
  const askedFor = retryAfter === null ? undefined : retryAfterMs(retryAfter);
  if (askedFor !== undefined) return Math.min(askedFor, retry.maxDelayMs);
  return Math.random() * Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
}

// The wait the policy's `delayMs` gives for an answer, or undefined where it gives none, throws
// or gives what is no number.
function ownDelayMs(
  retry: Required<RetryPolicy>, response: Response, attempts: number,
): number | undefined {
  try {
    const given = retry.delayMs(response, attempts);
    return typeof given === "number" && !Number.isNaN(given) ? given : undefined;
  } catch {
    return undefined;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = `(?<month>${MONTHS.join("|")})`;
const TIME = "(?<hour>[01]\\d|2[0-3]):(?<minute>[0-5]\\d):(?<second>[0-5]\\d|60)";
// The three forms of an HTTP date, each of which a recipient is to take (RFC 9110, 5.6.7): the
// one a server is to send, as `Sun, 06 Nov 1994 08:49:37 GMT`, and the two obsolete ones, as
// `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`. All three are in GMT. The day
// of the week is matched and not read: the date is the one its day, month and year give.
const HTTP_DATES = [
  `(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\\d{2}) ${MONTH} (?<year>\\d{4}) ${TIME} GMT`,
  `(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<day>\\d{2})-${MONTH}-(?<year>\\d{2}) ${TIME} GMT`,
  `(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} (?<day>\\d{2}| \\d) ${TIME} (?<year>\\d{4})`,
].map(form => new RegExp(`^${form}$`));

// The milliseconds a `Retry-After` asks to wait: its count of seconds, or the time left until
// its HTTP date, which is nothing once that is past. Undefined for what is neither.
function retryAfterMs(retryAfter: string): number | undefined {
  if (/^\s*\d+\s*$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const at = httpDate(retryAfter.trim());
  return at === undefined ? undefined : Math.max(at - Date.now(), 0);
}

// The time an HTTP date gives, in milliseconds. Undefined for what is in none of the three forms,
// and for a day that its month does not have.
function httpDate(value: string): number | undefined {
  const date = HTTP_DATES.map(form => form.exec(value)?.groups).find(found => found !== undefined);
  if (!date) return undefined;
  let year = Number(date.year);
  if (date.year.length === 2) {
    // A year of two digits is one of this century, or of the century before where that one would
    // be more than 50 years on.
    const now = new Date().getUTCFullYear();
    year += now - now % 100;
    if (year > now + 50) year -= 100;
  }
  const month = MONTHS.indexOf(date.month);
  const day = Number(date.day);
  // `Date.UTC` would read a day past the end of its month as a day of the next.
  if (day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) return undefined;
  return Date.UTC(year, month, day, Number(date.hour), Number(date.minute), Number(date.second));
}

// Waits `ms`, or until `signal` aborts. A wait of nothing sets no timer, and no wait is longer
// than a timer takes.
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, LONGEST_TIMER_MS));
    signal?.addEventListener("abort", done);
  });
}

// Cancels what is left of an answer's body, so that its connection is not held. The cancelling
// is not waited for: that of a body a hook cloned ends only once the clone is read. Never throws.
function release(response: Response): void {
  try {
    // A body that is locked or errored has nothing left to release.
    response.body?.cancel().catch(() => undefined);
  } catch {
    // Nor has one whose cancelling throws.
  }
}
