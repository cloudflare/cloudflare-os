// The only code that talks HTTP to Microsoft Graph and holds a token. Every request goes to
// graph.microsoft.com/v1.0 with a timeout and a capped body read, and never follows a redirect on
// its own: a file's `/content` redirect to a pre-authenticated download URL is followed by hand,
// only to SharePoint or its conversion host, without the token. Failures map onto a credential
// rejection (401), throttling, a refusal, and an unknown outcome (a timeout or dropped connection).

import { ResponseTooLargeError, readBytesCapped, readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { GRAPH_BASE, VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.graph", vendorId: VENDOR_ID });

const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The redirect statuses a download follows: Graph answers 302, and a 303 or 308 means the same for a GET. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
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

/** When a throttled response says to retry, in epoch milliseconds, at most a day out. */
function retryAtOf(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  const at = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(header);
  return Number.isFinite(at) ? Math.min(at, Date.now() + MAX_RETRY_AFTER_MS) : undefined;
}

/** Maps a failed response onto this gatekeeper's error classes. */
export function errorForResponse(response: Response, body: unknown): GraphApiError {
  const requestId = response.headers.get("request-id") ?? undefined;
  if (response.status === 429 || (response.status === 503 && response.headers.has("retry-after"))) {
    return new GraphThrottledError(response.status, retryAtOf(response), requestId);
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
};

/** A downloaded file's bytes, capped, with what Graph said about them. */
export type Download = { bytes: Uint8Array; contentType: string | null };

/** The download would exceed the cap the caller set. */
export class DownloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB this can read.`);
    this.name = "DownloadTooLargeError";
  }
}

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

/** Waits `ms`, for a throttled retry. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A Graph client for one access token. Cheap to construct; holds no state beyond the token. */
export class GraphApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(accessToken: string, options: { fetch?: typeof fetch } = {}) {
    this.#token = accessToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** A GET returning JSON. `path` is relative to `/v1.0`, or a full Graph URL from a `nextLink`. */
  async get<T>(path: string, options: Omit<RequestOptions, "body" | "rawBody"> = {}): Promise<T> {
    return await this.request<T>("GET", path, options) as T;
  }

  /** A GET that answers `null` for a 404 or 403 rather than throwing. */
  async find<T>(path: string, options: Omit<RequestOptions, "body" | "rawBody" | "allow"> = {}): Promise<T | null> {
    return await this.request<T>("GET", path, { ...options, allow: [403, 404] });
  }

  /**
   * One request, retried inline while Graph throttles it for a short while. A throttled request
   * was never processed, so retrying it is safe whatever the method. A 503/504 without
   * `Retry-After` is retried only for a GET, since a write may have landed.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | null> {
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

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GraphTransportError("Microsoft Graph did not answer in time.", { cause: error });
      }
      if (response.status === 204) return null;
      const parsed = await this.#readJson(response);
      if (response.ok) return parsed as T;
      if (options.allow?.includes(response.status)) return null;
      const error = errorForResponse(response, parsed);
      const retryable = error instanceof GraphThrottledError
        || (method === "GET" && (response.status === 503 || response.status === 504));
      const wait = error instanceof GraphThrottledError && error.retryAt !== undefined
        ? error.retryAt - Date.now() : 1000 * attempt;
      if (retryable && attempt < MAX_ATTEMPTS && wait <= MAX_RETRY_WAIT_MS) {
        await sleep(Math.max(0, wait));
        continue;
      }
      if (response.status >= 500 || error instanceof GraphThrottledError) {
        logger.warn("Graph request failed", {
          event: "graph.request.failed", status: response.status, graphCode: error.code, requestId: error.requestId,
        });
      }
      throw error;
    }
  }

  /**
   * Starts Graph's asynchronous copy of a drive item and returns the monitor URL its progress is
   * read from. The copy is SharePoint's own, so it keeps the file's metadata and sensitivity label.
   */
  async startCopy(path: string, body: unknown, query?: Record<string, string>): Promise<string> {
    const response = await this.#fetch(this.#url(path, query), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`, accept: "application/json", "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(error => {
      throw new GraphTransportError("Microsoft Graph did not answer in time.", { cause: error });
    });
    if (response.status !== 202) throw errorForResponse(response, await this.#readJson(response));
    const location = response.headers.get("location");
    if (location === null || !isDownloadHost(location)) {
      throw new GraphApiError(502, "Microsoft Graph sent no usable progress link for the copy.");
    }
    return location;
  }

  /**
   * Reads a copy's progress. The monitor URL is pre-authenticated and served by SharePoint, so it is
   * fetched without the credential, and only from a SharePoint host.
   */
  async copyProgress(monitorUrl: string): Promise<{ status: string; resourceId?: string; error?: string }> {
    if (!isDownloadHost(monitorUrl)) throw new GraphApiError(502, "Refusing to follow a copy's progress link outside SharePoint.");
    const response = await this.#fetch(monitorUrl, {
      headers: { accept: "application/json", "user-agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(error => {
      throw new GraphTransportError("SharePoint did not report the copy's progress in time.", { cause: error });
    });
    // A finished copy may answer with a redirect to the new item instead of its status.
    if (response.status === 303 || response.status === 302) {
      const id = /\/items\/([^/?]+)/.exec(response.headers.get("location") ?? "")?.[1];
      return id ? { status: "completed", resourceId: decodeURIComponent(id) } : { status: "completed" };
    }
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
   * caller probing access reads a 403 or 404 per item.
   */
  async batch(requests: readonly BatchRequest[]): Promise<Map<string, BatchResponse>> {
    if (requests.length === 0) return new Map();
    if (requests.length > MAX_BATCH_REQUESTS) throw new Error(`A Graph batch holds at most ${MAX_BATCH_REQUESTS} requests.`);
    for (const request of requests) {
      if (request.url.startsWith("/") || /^[a-z]+:/i.test(request.url)) {
        throw new Error("A batched request's URL must be relative to the Graph version root.");
      }
    }
    const responses = new Map<string, BatchResponse>();
    // Exchange runs at most four requests per mailbox at once and answers the rest of a batch 429,
    // each with its own Retry-After: those are sent again, alone, after the longest wait asked.
    let pending = requests;
    for (let attempt = 0; pending.length > 0; attempt++) {
      const answer = await this.request<{ responses?: unknown }>("POST", "/$batch", { body: { requests: pending } });
      if (!answer || !Array.isArray(answer.responses)) throw new GraphApiError(502, "Microsoft Graph sent a malformed batch answer.");
      let wait = 0;
      const throttled = new Set<string>();
      for (const entry of answer.responses as unknown[]) {
        if (entry === null || typeof entry !== "object") continue;
        const { id, status, body, headers } = entry as { id?: unknown; status?: unknown; body?: unknown; headers?: unknown };
        if (typeof id !== "string" || typeof status !== "number") continue;
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
   * never handed to anyone.
   * @param path The `/content` path, relative to `/v1.0`, with any `format` in `query`.
   * @throws DownloadTooLargeError past `maxBytes`.
   */
  async download(path: string, maxBytes: number, query?: Record<string, string>): Promise<Download> {
    const url = this.#url(path, query);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${this.#token}`, "user-agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null || !isDownloadHost(location)) {
          throw new GraphApiError(502, "Microsoft Graph redirected the download somewhere unexpected.");
        }
        // No Authorization header: the URL itself is the credential, and the host is not Graph.
        response = await this.#fetch(location, {
          headers: { "user-agent": USER_AGENT },
          redirect: "manual",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      }
    } catch (error) {
      if (error instanceof GraphApiError) throw error;
      throw new GraphTransportError("Microsoft 365 did not send the file in time.", { cause: error });
    }
    if (!response.ok) {
      throw errorForResponse(response, await this.#readJson(response).catch(() => null));
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new DownloadTooLargeError(maxBytes);
    }
    try {
      return { bytes: await readBytesCapped(response, maxBytes), contentType: response.headers.get("content-type") };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new DownloadTooLargeError(maxBytes);
      throw new GraphTransportError("The file download was interrupted.", { cause: error });
    }
  }

  /** The full URL for `path`, refusing anything that is not Graph's pinned origin and version. */
  #url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = /^https:/i.test(path) ? path : `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    if (!isGraphUrl(url)) throw new Error("Refusing to send a Microsoft 365 credential outside Microsoft Graph.");
    if (query === undefined) return url;
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
  }

  async #readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await readTextCapped(response, MAX_JSON_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new GraphApiError(502, "Microsoft Graph sent an answer too large to read.");
      throw new GraphTransportError("Microsoft Graph's answer was cut off.", { cause: error });
    }
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON body (an HTML error page from a proxy) is answered by status alone.
      return null;
    }
  }
}
