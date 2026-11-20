// The only code that talks HTTP to Microsoft Graph and holds a token. Every request goes to
// graph.microsoft.com/v1.0 with a timeout and a capped body read, and never follows a redirect on
// its own: a file's `/content` redirect to a pre-authenticated download URL is followed by hand,
// only to SharePoint or its conversion host, without the token. Failures map onto a credential
// rejection (401), throttling, a refusal, and an unknown outcome (a timeout or dropped connection).
// Each request is sent through `graphUpstream` (graph-upstream.ts), which times every attempt out,
// sends again what is safe to, and counts each attempt as a subservice metric point.

import { ResponseTooLargeError, readBytesCapped, readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type {
  AnsweredWith, CallAnswer, RetryPolicy, Upstream, UpstreamFetch,
} from "@gadgets/gatekeeper-kit/upstream";
import { graphUpstream, type HostOperation } from "./graph-upstream";
import { obsContext } from "./observability";
import { GRAPH_BASE, VENDOR_ID } from "./vendor";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.graph", vendorId: VENDOR_ID });

/** A download's timeout per attempt: a file's bytes take longer than the 30 seconds of any other request. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The redirect statuses a download follows: Graph answers 302, and a 303 or 308 means the same for a GET. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** The redirect statuses a finished copy's monitor URL answers with, in place of its status. */
const COPY_FINISHED = new Set([302, 303]);
/** Graph's largest JSON page (999 list items with every field) is a few megabytes. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** How long a throttled request may be told to wait and still be retried here, not by the caller. */
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** Graph's own limit on requests in one `$batch`. */
export const MAX_BATCH_REQUESTS = 20;
/** How often a batch resends the requests Graph throttled, and the longest it waits between. */
const BATCH_THROTTLE_RETRIES = 3;
const MAX_BATCH_THROTTLE_WAIT_MS = 5_000;

/**
 * Microsoft asks ISVs to decorate their traffic so throttling can tell callers apart; see
 * "Best practices for avoiding throttling" in the SharePoint docs.
 */
const USER_AGENT = "ISV|Cloudflare|Gadgets/1.0";

/** Hosts a download redirect may lead to: SharePoint itself, and its media/conversion service. */
const DOWNLOAD_HOSTS = [/^[a-z0-9-]+\.sharepoint\.com$/, /^[a-z0-9-]+\.svc\.ms$/];

/** Graph refused a request. `message` is Graph's own explanation, which never carries credentials. */
export class GraphApiError extends Error {
  readonly status: number;
  /** Graph's error `code`, e.g. `itemNotFound`, `accessDenied`, `resourceModified`. */
  readonly code?: string;
  /** The innermost error code, which is often the precise one (`nameAlreadyExists`). */
  readonly innerCode?: string;
  /** Graph's `request-id`, which Microsoft support asks for. */
  readonly requestId?: string;

  constructor(status: number, message: string, details: { code?: string; innerCode?: string; requestId?: string } = {}) {
    super(message);
    this.name = "GraphApiError";
    this.status = status;
    this.code = details.code;
    this.innerCode = details.innerCode;
    this.requestId = details.requestId;
  }

  /** Graph refused the credentials, as opposed to the request. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** The object does not exist, or the user cannot see it: Graph does not say which. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** The object changed since the caller read it: a failed `If-Match` (412), or a 409 other than a name collision. */
  get isConflict(): boolean {
    return this.status === 412 || (this.status === 409 && this.code !== "nameAlreadyExists"
      && this.innerCode !== "nameAlreadyExists");
  }

  /** A name collided with an existing item. */
  get isNameConflict(): boolean {
    return this.status === 409 && (this.code === "nameAlreadyExists" || this.innerCode === "nameAlreadyExists");
  }
}

/** Graph is throttling this app or user, and asked to wait longer than is reasonable inline. */
export class GraphThrottledError extends GraphApiError {
  /** When to try again, in epoch milliseconds, if Graph said. */
  readonly retryAt?: number;

  constructor(status: number, retryAt: number | undefined, requestId?: string) {
    const when = retryAt === undefined ? "" : ` Try again after ${new Date(retryAt).toISOString().slice(11, 19)} UTC.`;
    super(status, `Microsoft 365 is limiting how fast this account can make requests.${when}`,
      { code: "throttled", requestId });
    this.name = "GraphThrottledError";
    this.retryAt = retryAt;
  }
}

/**
 * The request may have reached Graph, but no answer came back: a timeout or a dropped connection.
 * Whether a write took effect is unknown.
 */
export class GraphTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphTransportError";
  }
}

/** Whether an error from anywhere in this gatekeeper is Graph refusing the credentials. */
export function isGraphAuthError(error: unknown): boolean {
  return error instanceof GraphApiError && error.isAuthError;
}

/** Whether a write's outcome is unknown: Graph may have applied it without saying so. */
export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof GraphTransportError
    || (error instanceof GraphApiError && error.status >= 500 && !(error instanceof GraphThrottledError));
}

type GraphErrorBody = { error?: { code?: unknown; message?: unknown; innerError?: unknown; innererror?: unknown } };

/** The deepest `code` in Graph's nested `innerError` chain. */
function innermostCode(error: GraphErrorBody["error"]): string | undefined {
  let code: string | undefined;
  let inner: unknown = error?.innerError ?? error?.innererror;
  for (let depth = 0; depth < 8 && inner !== null && typeof inner === "object"; depth++) {
    const record = inner as Record<string, unknown>;
    if (typeof record.code === "string") code = record.code;
    inner = record.innerError ?? record.innererror;
  }
  return code;
}

/** The plain-language refusal for a status Graph explained badly or not at all. */
function fallbackMessage(status: number): string {
  switch (status) {
    case 401: return "Microsoft 365 did not accept this connection's credentials.";
    case 403: return "You don't have permission to do that in Microsoft 365.";
    case 404: return "That item doesn't exist, or you don't have access to it.";
    case 409: return "That conflicts with something that already exists.";
    case 412: return "It changed since it was last read.";
    case 423: return "It is locked, probably because someone has it open for editing.";
    case 507: return "The site or OneDrive is out of storage.";
    default: return `Microsoft Graph answered with HTTP ${status}.`;
  }
}

/** The longest a Retry-After is believed: an absurd one would otherwise make an unrepresentable date. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long an answer's `Retry-After` says to wait, in milliseconds from `now`, at most a day; undefined where it names no wait. */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const header = headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  const at = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(header);
  return Number.isFinite(at) ? Math.min(at, now + MAX_RETRY_AFTER_MS) - now : undefined;
}

/** Whether an answer is Graph throttling the request, which it then never processed: a 429, or a 503 that names a wait. */
function isThrottle(status: number, headers: Headers): boolean {
  return status === 429 || (status === 503 && headers.has("retry-after"));
}

/**
 * When `GraphApi.request`, a download and a read of a copy's progress send a request again, and
 * after how long. A throttled request was never processed, so it is sent again whatever its
 * method, after the wait Graph names, unless that is longer than `MAX_RETRY_WAIT_MS`: such a
 * throttle is handed back to the caller, since Graph throttles for longer a caller that keeps
 * sending. A 503 or 504 that is no throttle is sent again only for a GET, since a write may have
 * landed. Where no wait is named, the wait is a second for each attempt made.
 */
const THROTTLE_RETRY = {
  attempts: MAX_ATTEMPTS,
  maxDelayMs: MAX_RETRY_WAIT_MS,
  retryable: (status, request, headers) => {
    if (isThrottle(status, headers)) return (retryAfterMs(headers, Date.now()) ?? 0) <= MAX_RETRY_WAIT_MS;
    return request.method === "GET" && (status === 503 || status === 504);
  },
  delayMs: (response, attempts) =>
    (isThrottle(response.status, response.headers) ? retryAfterMs(response.headers, Date.now()) : undefined) ?? 1000 * attempts,
} satisfies RetryPolicy;

/**
 * How a success this client cannot read is counted: one that is no JSON, a batch's that holds no
 * responses, and one that starts no copy whose progress can be read.
 */
const MALFORMED: CallAnswer = { outcome: "error", reason: "parse" };
/**
 * How a success is counted that was read and is not what its request was sent for: one its
 * caller's `read` threw on or its caller's `unusable` refuses, one that holds nothing for a caller
 * that is answered no `null` (`GraphApi.get`), and a batch's that leaves out a request whose
 * caller takes no answer for none.
 */
const REJECTED: CallAnswer = { outcome: "error", reason: "api" };
/** How an attempt Graph throttled is counted, a 503 as a 429: the request was declined for its rate. */
const THROTTLED: CallAnswer = { outcome: "refused", reason: "rate" };
/** How a download larger than its caller's cap is counted: the file was served, and this client refused its size. */
const TOO_LARGE: CallAnswer = { outcome: "error", reason: "size" };

/** How an answered attempt is counted by its status and headers, or undefined for one counted by its status alone. */
type Counting = (answered: AnsweredWith) => CallAnswer | undefined;

/**
 * Counts each answered attempt of a request to Microsoft: a throttle (`isThrottle`) as a request
 * refused for its rate, whether or not it is then sent again, and any other answer by `otherwise`,
 * which is asked about no throttle.
 */
function throttledOr(otherwise?: Counting): Counting {
  return answered => isThrottle(answered.status, answered.headers) ? THROTTLED : otherwise?.(answered);
}

/** Counts a redirect as the success it is for a request whose answer is expected to be one. */
function redirectedTo(statuses: ReadonlySet<number>, allowed: (location: string) => boolean): Counting {
  return answered => statuses.has(answered.status) && allowed(answered.headers.get("location") ?? "")
    ? { outcome: "success" } : undefined;
}

/** Whether an answer is a copy that started: a 202 that links to where SharePoint reports its progress. */
function startedCopy(answered: AnsweredWith): boolean {
  return answered.status === 202 && isDownloadHost(answered.headers.get("location") ?? "");
}

/** Maps a failed response onto this gatekeeper's error classes. */
export function errorForResponse(response: Response, body: unknown): GraphApiError {
  const requestId = response.headers.get("request-id") ?? undefined;
  if (isThrottle(response.status, response.headers)) {
    const now = Date.now();
    const wait = retryAfterMs(response.headers, now);
    return new GraphThrottledError(response.status, wait === undefined ? undefined : now + wait, requestId);
  }
  const error = (body !== null && typeof body === "object" ? (body as GraphErrorBody).error : undefined);
  const code = typeof error?.code === "string" ? error.code : undefined;
  const innerCode = innermostCode(error);
  const graphMessage = typeof error?.message === "string" ? error.message.trim() : "";
  // Graph's messages for 401/403/404 name nothing useful ("The resource could not be found."), and
  // some carry server-relative paths, so those statuses get fixed wording.
  const message = graphMessage && response.status !== 404 && response.status !== 403 && response.status !== 401
    ? graphMessage : fallbackMessage(response.status);
  return new GraphApiError(response.status, message, { code, innerCode, requestId });
}

/**
 * What an answer was read as: what the caller's `read` returned of it or threw on it, whether the
 * answer is a success, which alone is counted by what was read, whether it is one that is no JSON,
 * and whether it holds nothing where its caller is answered no `null`.
 */
type Read<R> = ({ value: R } | { thrown: unknown }) & { success: boolean; noJson: boolean; nothing: boolean };

/** Says of what a success was read as whether it is not what its request was sent for (see `GraphApi.request`). */
type Unusable<R> = (value: R) => boolean;

/** Counts a success that `unusable` refuses as an error of the API. */
function refusing<R>(unusable: Unusable<R> | undefined): ((value: R) => CallAnswer | undefined) | undefined {
  return unusable && (value => unusable(value) ? REJECTED : undefined);
}

/** A `$batch` entry that answers a request: its ID and status, with the body and headers it came with. */
type BatchEntry = { id: string; status: number; body: unknown; headers: unknown };

/** The entries of a `$batch` answer that answer a request, in the order they came. */
function batchEntries(responses: readonly unknown[]): BatchEntry[] {
  const entries: BatchEntry[] = [];
  for (const entry of responses) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, status, body, headers } = entry as { id?: unknown; status?: unknown; body?: unknown; headers?: unknown };
    if (typeof id === "string" && typeof status === "number") entries.push({ id, status, body, headers });
  }
  return entries;
}

/** A request inside a `$batch`. Its `url` is relative to the Graph version root. */
export type BatchRequest = {
  id: string;
  method: "GET";
  url: string;
  headers?: Record<string, string>;
};

/** One answer from a `$batch`, matched to its request by `id`. */
export type BatchResponse = { id: string; status: number; body: unknown };

/** What `request()` takes beyond the method and path. */
export type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Bytes or text sent as-is, with `contentType`. */
  rawBody?: Uint8Array | string;
  contentType?: string;
  /** Applies the change only if the object's eTag still matches. */
  ifMatch?: string;
  /** Graph `Prefer` values, e.g. `HonorNonIndexedQueriesWarningMayFailRandomly`. */
  prefer?: string[];
  /** Statuses answered with `null` rather than thrown, for existence checks. */
  allow?: readonly number[];
  /**
   * Ends the request once it aborts: the send in flight, the pause before the next and the reading
   * of the answer, each of which fails as a request that got no answer does. A caller that waits a
   * bounded time passes what is left of its wait, so that a request sent again does not outlast it.
   * The pause after an answer that throttled the request fails so too (`GraphTransportError`, not
   * `GraphThrottledError`): a write ended there reads as one whose outcome is unknown
   * (`isOutcomeUnknown`), though Graph did not process it.
   */
  signal?: AbortSignal;
};

/** A downloaded file's bytes, capped, with what Graph said about them. */
export type Download = { bytes: Uint8Array; contentType: string | null };

/** A copy's progress: its status, the new item's ID once it has finished, and SharePoint's explanation where it failed. */
export type CopyProgress = { status: string; resourceId?: string; error?: string };

/** The download would exceed the cap the caller set. */
export class DownloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB this can read.`);
    this.name = "DownloadTooLargeError";
  }
}

/**
 * A download refused for its size: the error `download()` throws for it and, where the answer's
 * headers declared the size, the body of that answer, which is not read and is still to release.
 */
type Oversized = { tooLarge: DownloadTooLargeError; unreadBody?: ReadableStream<Uint8Array> | null };

/** Whether `url` is a Graph URL this client may request: the pinned origin and version. */
export function isGraphUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(GRAPH_BASE).origin && parsed.pathname.startsWith("/v1.0/")
      && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The URL a path is requested at: an `https:` URL, as a `nextLink` is, as it is, and any other path under Graph's version root. */
function urlOf(path: string): string {
  return /^https:/i.test(path) ? path : `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Whether `GraphApi` refuses to request `path`, which it checks before it sends anything: an
 * `https:` URL that is not Graph's pinned origin and version. A page that links to its next page
 * at such a URL holds no way on, which the `unusable` of the request that answers the page says
 * by this check.
 */
export function refusesPath(path: string): boolean {
  return !isGraphUrl(urlOf(path));
}

/** Whether a download redirect may be followed: https, to SharePoint or its media service, no credentials. */
export function isDownloadHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      && (parsed.port === "" || parsed.port === "443")
      && DOWNLOAD_HOSTS.some(pattern => pattern.test(parsed.hostname));
  } catch {
    return false;
  }
}

/** Waits `ms`, before a batch sends its throttled requests again. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The name of a read of a copy's monitor URL, which is on a SharePoint host and has no Graph path. */
const COPY_PROGRESS: HostOperation = "copy.progress";
/** The name of a read of the pre-authenticated URL a content request redirects to. */
const CONTENT_DOWNLOAD: HostOperation = "content.download";

/**
 * Runs one Graph operation with a client for `accessToken`. The requests it makes are summed, so
 * an operation that pages or batches writes one metric point per kind of request when it ends.
 * @param accessToken The token the operation's requests carry.
 * @param op The operation.
 * @returns What `op` returned.
 */
export function withGraph<T>(accessToken: string, op: (api: GraphApi) => Promise<T>): Promise<T> {
  return graphUpstream.summed(() => op(new GraphApi(accessToken)));
}

/** A Graph client for one access token. Cheap to construct; holds no state beyond the token. */
export class GraphApi {
  readonly #token: string;
  readonly #upstream: Upstream;

  /**
   * @param accessToken The token every request to Graph carries.
   * @param options `fetch` sends the requests in place of the global one, through the same upstream.
   */
  constructor(accessToken: string, options: { fetch?: UpstreamFetch } = {}) {
    this.#token = accessToken;
    this.#upstream = options.fetch ? graphUpstream.with({ fetch: options.fetch }) : graphUpstream;
  }

  /**
   * A GET returning JSON. `path` is relative to `/v1.0`, or a full Graph URL from a `nextLink`.
   * It answers what the request was sent for: a success that holds nothing (no content, an empty
   * body, a JSON `null`) is none, and is counted as an error of the API whatever is made of the
   * `null` it is read as. A caller that takes nothing for an answer asks with `find` or `request`.
   * @param read Reads the answer inside the request (see `request`).
   * @param unusable Says whether what was read is not what was asked for (see `request`).
   */
  async get<T, R = T>(path: string, options: Omit<RequestOptions, "body" | "rawBody"> = {}, read?: (answer: T) => R, unusable?: Unusable<R>): Promise<R> {
    return await this.#request("GET", path, options, read, refusing(unusable), true);
  }

  /**
   * A GET that answers `null` for a 404 or 403 rather than throwing.
   * @param read Reads the answer inside the request (see `request`), `null` for a 404 or 403.
   * @param unusable Says whether what was read is not what was asked for (see `request`).
   */
  async find<T, R = T | null>(path: string, options: Omit<RequestOptions, "body" | "rawBody" | "allow"> = {}, read?: (answer: T | null) => R,
                              unusable?: Unusable<R>): Promise<R> {
    return await this.request("GET", path, { ...options, allow: [403, 404] }, read, unusable);
  }

  /**
   * One request, retried inline while Graph throttles it for a short while. A throttled request
   * was never processed, so retrying it is safe whatever the method. A 503/504 without
   * `Retry-After` is retried only for a GET, since a write may have landed, and so is a GET that
   * got no answer at all. An answer among `allow` is never sent again, and nothing is once
   * `options.signal` has aborted. A success that is no JSON answers `null`, and is counted as an
   * answer that could not be read. A success that holds nothing (no content, an empty body, a
   * JSON `null`) answers `null` as well, and is counted by what its caller makes of that: an
   * error of the API where `read` throws on it or `unusable` refuses it, and else the success
   * its status says (`get` alone takes no nothing for an answer).
   * @param read Reads what the request was sent for out of the answer, inside the request: it is
   * given what the request answers without it (the JSON of a success, `null` for a success that
   * holds none and for a status among `allow`), what it returns is what the request answers, and
   * what it throws the request throws as it is. A success it throws on is counted as an error of
   * the API, with the status of the answer, so a caller that checks what an answer holds makes
   * the check here. It decides nothing about an answer that is what was asked for: what the
   * caller then makes of that is read from what the request answers.
   * @param unusable Says of what a success was read as whether it is not what the request was sent
   * for, for a caller that is answered with it all the same: a page whose link to the next it
   * will not follow, a row with no ID that it reads as absent, a fault of the answer that it
   * throws later than here. Such a success is counted as one `read` throws on is, and the request
   * answers what was read.
   */
  async request<T, R = T | null>(method: string, path: string, options: RequestOptions = {}, read?: (answer: T | null) => R,
                                 unusable?: Unusable<R>): Promise<R> {
    return await this.#request(method, path, options, read, refusing(unusable));
  }

  /**
   * Sends `request()`'s request, and reads its answer with `read`, where one is given: the answer
   * is else what the request answers. `counted` counts a success that was so read otherwise than
   * as one, by what was read. `answersSomething` says that the caller is answered no `null`: a
   * success that holds nothing is then counted as an error of the API.
   */
  async #request<A, R>(
    method: string, path: string, options: RequestOptions, read: ((answer: A) => R) | undefined, counted?: (value: R) => CallAnswer | undefined,
    answersSomething = false,
  ): Promise<R> {
    const url = this.#url(path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (options.ifMatch !== undefined) headers["if-match"] = options.ifMatch;
    if (options.prefer?.length) headers.prefer = options.prefer.join(", ");
    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers["content-type"] = options.contentType ?? "application/octet-stream";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    const { allow } = options;
    const retry: RetryPolicy = allow === undefined ? THROTTLE_RETRY : {
      ...THROTTLE_RETRY,
      retryable: (status, request, answered) => !allow.includes(status) && THROTTLE_RETRY.retryable(status, request, answered),
    };
    // Reads an answer with the caller's `read`. What that throws is returned, not thrown, so that
    // the request is counted by it and no rule of the client's sends the request again for it.
    const reading = (answer: unknown, success: boolean, noJson = false): Read<R> => {
      const nothing = answersSomething && answer === null;
      try {
        return { value: read === undefined ? answer as R : read(answer as A), success, noJson, nothing };
      } catch (thrown) {
        return { thrown, success, noJson, nothing };
      }
    };
    // How an answer is counted by what was read of it. A success alone is: any other answer is
    // counted by its status. One that is no JSON is counted as that, and one that holds nothing
    // for a caller that is answered no `null` as answered with what was not asked for.
    const countedAs = (answer: Read<R>): CallAnswer | undefined => {
      if (!answer.success) return undefined;
      if (answer.noJson) return MALFORMED;
      return "thrown" in answer || answer.nothing ? REJECTED : counted?.(answer.value);
    };
    let answered: Read<R>;
    try {
      answered = await this.#upstream.read<Read<R>>(url, { method, headers, body, signal: options.signal, retry, answer: throttledOr() }, async response => {
        if (response.status === 204) return reading(null, true);
        const { json, noJson } = await this.#readBody(response);
        if (response.ok) return reading(json, true, noJson);
        if (allow?.includes(response.status)) return reading(null, false);
        const error = errorForResponse(response, json);
        if (response.status >= 500 || error instanceof GraphThrottledError) {
          logger.warn("Graph request failed", {
            event: "graph.request.failed", status: response.status, graphCode: error.code, requestId: error.requestId,
          });
        }
        throw error;
      }, countedAs);
    } catch (error) {
      // What reading the answer threw is Graph's refusal or a cut-off answer; anything else is a request that got no answer.
      if (error instanceof GraphApiError || error instanceof GraphTransportError) throw error;
      throw new GraphTransportError("Microsoft Graph did not answer in time.", { cause: error });
    }
    if ("thrown" in answered) throw answered.thrown;
    return answered.value;
  }

  /**
   * Starts Graph's asynchronous copy of a drive item and returns the monitor URL its progress is
   * read from. The copy is SharePoint's own, so it keeps the file's metadata and sensitivity label.
   */
  async startCopy(path: string, body: unknown, query?: Record<string, string>): Promise<string> {
    const response = await this.#upstream.request(this.#url(path, query), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`, accept: "application/json", "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      // A copy is started by a 202 that links to its progress: any other success, and a 202 without
      // a link its progress can be read from, is one the caller cannot use.
      answer: throttledOr(started => started.status < 300 && !startedCopy(started) ? MALFORMED : undefined),
    }).catch(error => {
      throw new GraphTransportError("Microsoft Graph did not answer in time.", { cause: error });
    });
    if (response.status !== 202) throw errorForResponse(response, await this.#readJson(response));
    const location = response.headers.get("location");
    if (location === null || !startedCopy(response)) {
      throw new GraphApiError(502, "Microsoft Graph sent no usable progress link for the copy.");
    }
    return location;
  }

  /**
   * Reads a copy's progress. The monitor URL is pre-authenticated and served by SharePoint, so it is
   * fetched without the credential, and only from a SharePoint host. The status is read inside the
   * request that answers it, so that it is counted by whether it could be read, and is asked again
   * for a status its timeout cut off.
   * @param monitorUrl The copy's monitor URL, as `startCopy` returned it.
   * @param signal Ends the read once it aborts: the send in flight, the pause before the next and
   * the reading of the answer. A caller that waits a bounded time for the copy passes what is left
   * of its wait, so that a read sent again for want of an answer does not outlast it.
   * @returns The copy's status, with the new item's ID once it has finished and SharePoint's
   * explanation where it failed.
   * @throws GraphTransportError where no answer came, whether the request failed or `signal`
   * aborted, or the answer stopped short, and GraphApiError for an answer that holds no status.
   */
  async copyProgress(monitorUrl: string, signal?: AbortSignal): Promise<CopyProgress> {
    if (!isDownloadHost(monitorUrl)) throw new GraphApiError(502, "Refusing to follow a copy's progress link outside SharePoint.");
    // What reading an answer threw, which is thrown as it is: any other failure is a request that got no answer.
    const unread = new Set<unknown>();
    let answer: Response | CopyProgress;
    try {
      answer = await this.#upstream.read<Response | CopyProgress>(monitorUrl, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal,
        operation: COPY_PROGRESS,
        retry: THROTTLE_RETRY,
        // The redirect a finished copy answers with is read below, and is this request's success.
        answer: throttledOr(redirectedTo(COPY_FINISHED, () => true)),
      }, async response => {
        // A finished copy's redirect holds no status to read.
        if (COPY_FINISHED.has(response.status)) return response;
        try {
          return await this.#copyStatus(response);
        } catch (error) {
          unread.add(error);
          throw error;
        }
      });
    } catch (error) {
      if (unread.has(error)) throw error;
      throw new GraphTransportError("SharePoint did not report the copy's progress in time.", { cause: error });
    }
    if (!(answer instanceof Response)) return answer;
    // A finished copy may answer with a redirect to the new item instead of its status.
    const id = /\/items\/([^/?]+)/.exec(answer.headers.get("location") ?? "")?.[1];
    return id ? { status: "completed", resourceId: decodeURIComponent(id) } : { status: "completed" };
  }

  /**
   * Reads the status a copy's monitor URL answers with.
   * @throws GraphApiError for an answer that is no success or holds no status, and
   * GraphTransportError for one that stops short.
   */
  async #copyStatus(response: Response): Promise<CopyProgress> {
    const body = await this.#readJson(response) as { status?: unknown; resourceId?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok || body === null || typeof body.status !== "string") {
      throw new GraphApiError(response.status >= 400 ? response.status : 502, "SharePoint sent an unreadable copy status.");
    }
    return {
      status: body.status,
      ...(typeof body.resourceId === "string" ? { resourceId: body.resourceId } : {}),
      ...(typeof body.error?.message === "string" ? { error: body.error.message } : {}),
    };
  }

  /**
   * Runs up to `MAX_BATCH_REQUESTS` GETs in one round trip. Each answer keeps its own status, so a
   * caller probing access reads a 403 or 404 per item. A send of the batch is one request,
   * counted by its own answer and not by what its requests are answered.
   * @param options.whole Whether the caller takes no answer for none: it refuses a batch that
   * leaves a request out, so a send whose answer leaves one out is counted as an error of the API.
   * A caller that reads a request left out as absent gives none, and the send is a success.
   */
  async batch(requests: readonly BatchRequest[], options: { whole?: boolean } = {}): Promise<Map<string, BatchResponse>> {
    if (requests.length === 0) return new Map();
    if (requests.length > MAX_BATCH_REQUESTS) throw new Error(`A Graph batch holds at most ${MAX_BATCH_REQUESTS} requests.`);
    for (const request of requests) {
      if (request.url.startsWith("/") || /^[a-z]+:/i.test(request.url)) {
        throw new Error("A batched request's URL must be relative to the Graph version root.");
      }
    }
    // Each send of the batch is one request, counted as one: its sub-requests are no attempts.
    return await this.#upstream.summed(() => this.#batch(requests, options.whole === true));
  }

  /** Sends a batch, and again the requests of it that Graph throttled, until each has an answer. */
  async #batch(requests: readonly BatchRequest[], whole: boolean): Promise<Map<string, BatchResponse>> {
    const responses = new Map<string, BatchResponse>();
    // Exchange runs at most four requests per mailbox at once and answers the rest of a batch 429,
    // each with its own Retry-After: those are sent again, alone, after the longest wait asked.
    let pending = requests;
    for (let attempt = 0; pending.length > 0; attempt++) {
      const sent = pending;
      // The entries are read inside the request, which is so counted by whether its answer holds
      // any and, for a caller that takes no answer for none, by whether one answers each request.
      const entries = await this.#request("POST", "/$batch", { body: { requests: sent } },
        (answer: { responses?: unknown } | null) => Array.isArray(answer?.responses) ? batchEntries(answer.responses) : undefined,
        answered => answered === undefined ? MALFORMED
          : whole && sent.some(request => !answered.some(entry => entry.id === request.id)) ? REJECTED : undefined);
      if (entries === undefined) throw new GraphApiError(502, "Microsoft Graph sent a malformed batch answer.");
      let wait = 0;
      const throttled = new Set<string>();
      for (const { id, status, body, headers } of entries) {
        if (status === 429 && attempt < BATCH_THROTTLE_RETRIES) {
          throttled.add(id);
          const after = Number((headers as Record<string, unknown> | undefined)?.["Retry-After"] ?? (headers as Record<string, unknown> | undefined)?.["retry-after"]);
          wait = Math.max(wait, Number.isFinite(after) ? Math.min(after * 1000, MAX_BATCH_THROTTLE_WAIT_MS) : 500);
          continue;
        }
        responses.set(id, { id, status, body });
      }
      pending = pending.filter(request => throttled.has(request.id));
      if (pending.length > 0) await sleep(wait);
    }
    return responses;
  }

  /**
   * Downloads a file's bytes. Graph answers `/content` with a redirect to a pre-authenticated URL,
   * which is a bearer capability: it is followed here, once, only to SharePoint's own hosts, and
   * never handed to anyone. The bytes are read inside the request that serves them, so that it is
   * counted by whether they arrived, and is asked again for bytes its timeout cut off.
   * @param path The `/content` path, relative to `/v1.0`, with any `format` in `query`.
   * @throws DownloadTooLargeError past `maxBytes`.
   */
  async download(path: string, maxBytes: number, query?: Record<string, string>): Promise<Download> {
    const url = this.#url(path, query);
    // What reading an answer threw, which is thrown as it is: any other failure is a request that got no answer.
    const unread = new Set<unknown>();
    const read = async (response: Response): Promise<Download | Oversized> => {
      try {
        return await this.#downloaded(response, maxBytes);
      } catch (error) {
        unread.add(error);
        throw error;
      }
    };
    const tooLarge = (answer: Response | Download | Oversized) => "tooLarge" in answer ? TOO_LARGE : undefined;
    let served: Download | Oversized;
    try {
      const answer = await this.#upstream.read<Response | Download | Oversized>(url, {
        headers: { authorization: `Bearer ${this.#token}`, "user-agent": USER_AGENT },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        retry: THROTTLE_RETRY,
        // The redirect to a download host is followed below, and is this request's success.
        answer: throttledOr(redirectedTo(REDIRECTS, isDownloadHost)),
      }, response => REDIRECTS.has(response.status) ? response : read(response), tooLarge);
      if (answer instanceof Response) {
        const location = answer.headers.get("location");
        await answer.body?.cancel();
        if (location === null || !isDownloadHost(location)) {
          throw new GraphApiError(502, "Microsoft Graph redirected the download somewhere unexpected.");
        }
        // No Authorization header: the URL itself is the credential, and the host is not Graph.
        served = await this.#upstream.read(location, {
          headers: { "user-agent": USER_AGENT },
          operation: CONTENT_DOWNLOAD,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          retry: THROTTLE_RETRY,
          answer: throttledOr(),
        }, read, tooLarge);
      } else {
        served = answer;
      }
    } catch (error) {
      if (unread.has(error) || error instanceof GraphApiError) throw error;
      throw new GraphTransportError("Microsoft 365 did not send the file in time.", { cause: error });
    }
    if ("tooLarge" in served) {
      // Released outside the request: the file is refused whatever the release does, so one that
      // fails is thrown as it is and is no reason to count the request otherwise or to send it again.
      await served.unreadBody?.cancel();
      throw served.tooLarge;
    }
    return served;
  }

  /**
   * Reads the answer that serves a download. A file larger than `maxBytes` is returned with the
   * error `download()` throws for it, so that its request is counted as that refusal and not as
   * an answer that could not be read. One whose headers declare that size is returned unread,
   * with its body for `download()` to release.
   * @throws GraphApiError for an answer that is no success, and GraphTransportError for bytes that stop short.
   */
  async #downloaded(response: Response, maxBytes: number): Promise<Download | Oversized> {
    if (!response.ok) {
      throw errorForResponse(response, await this.#readJson(response).catch(() => null));
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { tooLarge: new DownloadTooLargeError(maxBytes), unreadBody: response.body };
    }
    try {
      return { bytes: await readBytesCapped(response, maxBytes), contentType: response.headers.get("content-type") };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) return { tooLarge: new DownloadTooLargeError(maxBytes) };
      throw new GraphTransportError("The file download was interrupted.", { cause: error });
    }
  }

  /** The full URL for `path`, refusing anything that is not Graph's pinned origin and version. */
  #url(path: string, query?: Record<string, string | number | undefined>): string {
    if (refusesPath(path)) throw new Error("Refusing to send a Microsoft 365 credential outside Microsoft Graph.");
    const url = urlOf(path);
    if (query === undefined) return url;
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
  }

  /** The JSON an answer holds, or `null` for one that holds none: an empty body, and one that is no JSON. */
  async #readJson(response: Response): Promise<unknown> {
    return (await this.#readBody(response)).json;
  }

  /**
   * Reads an answer's body as JSON. `noJson` says that it holds what is no JSON (an HTML page from
   * a proxy), which is read as `null`, as an empty body is: such an answer is answered by its
   * status alone.
   * @throws GraphApiError for a body too large to read, and GraphTransportError for one that stops short.
   */
  async #readBody(response: Response): Promise<{ json: unknown; noJson: boolean }> {
    let text: string;
    try {
      text = await readTextCapped(response, MAX_JSON_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new GraphApiError(502, "Microsoft Graph sent an answer too large to read.");
      throw new GraphTransportError("Microsoft Graph's answer was cut off.", { cause: error });
    }
    if (text === "") return { json: null, noJson: false };
    try {
      return { json: JSON.parse(text), noJson: false };
    } catch {
      return { json: null, noJson: true };
    }
  }
}
