// The only place this gatekeeper talks HTTP to X's API. Each request goes through the gatekeeper's
// upstream (`x-upstream.ts`), which gives it a timeout, follows no redirect, sends it once and
// counts it. This module adds the bearer token and a capped body read, and maps X's failures onto a
// few error classes the rest of the gatekeeper can act on: a credential rejection (401), a rate
// limit, exhausted credits, a refusal, and an outcome X never reported (a timeout or dropped
// connection).

import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import { X_API_ORIGIN } from "./x-env";
import type { WireIncludes } from "./x-normalize";
import { xUpstream } from "./x-upstream";

/** A page of 100 posts with every expansion is well under a megabyte; this is the ceiling. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** One of X's problem objects, from an error response or a 200's partial `errors`. */
export type XProblem = {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  message?: string;
  resource_type?: string;
  resource_id?: string;
};

/** Paging details X reports beside a listing. */
export type XMeta = { result_count?: number; next_token?: string; newest_id?: string; oldest_id?: string };

/** X's response envelope. A 200 may carry `errors` for rows it could not return. */
export type XEnvelope<T> = { data?: T; includes?: WireIncludes; meta?: XMeta; errors?: XProblem[] };

/** X refused a request. `message` is X's own explanation, which never carries credentials. */
export class XApiError extends Error {
  readonly status: number;
  /** X's problem `type` URI, when it sent one. */
  readonly problemType?: string;

  constructor(status: number, message: string, problemType?: string) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    this.problemType = problemType;
  }

  /** X refused the credentials, as opposed to the request. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** X refused a post as a duplicate of a recent one. */
  get isDuplicate(): boolean {
    return this.status === 403 && /duplicate/i.test(this.message);
  }
}

/** X's rate limit for this endpoint and account is spent until `resetAt`. */
export class XRateLimitError extends XApiError {
  /** When the window resets, in epoch milliseconds, if X said. */
  readonly resetAt?: number;

  constructor(message: string, resetAt?: number) {
    super(429, message);
    this.name = "XRateLimitError";
    this.resetAt = resetAt;
  }
}

/** The X app's credits are spent, or its spending limit reached. The operator must act. */
export class XCreditsError extends XApiError {
  constructor(status: number, problemType?: string) {
    super(status, "The X API credits for this deployment are used up, or its spending limit was " +
      "reached. Ask the administrator to add credits.", problemType);
    this.name = "XCreditsError";
  }
}

/**
 * The request may have reached X, but no answer came back: a timeout or a dropped connection.
 * Whether a write took effect is unknown.
 */
export class XTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XTransportError";
  }
}

/** Whether an error from anywhere in this gatekeeper is X refusing the credentials. */
export function isXAuthError(error: unknown): boolean {
  return error instanceof XApiError && error.isAuthError;
}

/** Whether a write's outcome is unknown: X may have applied it without saying so. */
export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof XTransportError || (error instanceof XApiError && error.status >= 500);
}

function problemsOf(body: unknown): XProblem[] {
  if (body === null || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.errors)) return record.errors as XProblem[];
  if (typeof record.title === "string" || typeof record.detail === "string") return [record as XProblem];
  if (typeof record.error === "string") {
    return [{ title: record.error, detail: String(record.error_description ?? record.error) }];
  }
  return [];
}

function describeProblem(problem: XProblem | undefined, status: number): string {
  const text = problem?.detail ?? problem?.message ?? problem?.title;
  return text ? `X: ${text}` : `X answered with HTTP ${status}.`;
}

/** Maps a failed response onto this gatekeeper's error classes. */
export function errorForResponse(response: Response, body: unknown): XApiError {
  const problems = problemsOf(body);
  const first = problems[0];
  const type = first?.type;
  if (response.status === 402 || /usage-capped|credits/i.test(type ?? "")) {
    return new XCreditsError(response.status, type);
  }
  if (response.status === 429) {
    const reset = Number(response.headers.get("x-rate-limit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
    const when = resetAt ? ` It resets at ${new Date(resetAt).toISOString().slice(11, 16)} UTC.` : "";
    return new XRateLimitError(`X's rate limit for this request is used up for this account.${when}`, resetAt);
  }
  return new XApiError(response.status, describeProblem(first, response.status), type);
}

/**
 * The single resource a lookup asked for, or the error X reported in its place. X answers a lookup
 * of a missing or hidden resource with a 200 whose `errors` say why, not with a 404.
 */
export function requireData<T>(envelope: XEnvelope<T>, what: string): T {
  if (envelope.data !== undefined && envelope.data !== null) return envelope.data;
  const problem = envelope.errors?.[0];
  const status = problemStatus(problem);
  throw new XApiError(status, status === 404
    ? `X has no ${what} with that ID, or it was deleted.`
    : status === 403
      ? `The connected X account can't see this ${what}.`
      : describeProblem(problem, status), problem?.type ?? "");
}

/**
 * A listing page, or the error X reported in place of its rows. X can answer a listing it couldn't
 * read with a 200 holding only `errors`, which taken as an empty page would end the listing as if
 * nothing were left.
 */
export function requirePage<T>(envelope: XEnvelope<T[]>): XEnvelope<T[]> {
  const problem = envelope.data ? undefined : envelope.errors?.[0];
  if (!problem) return envelope;
  const status = problemStatus(problem);
  throw new XApiError(status, describeProblem(problem, status), problem.type);
}

/**
 * The status a problem X reported in place of what a request asked for stands for: not found, not
 * allowed, a request X refused as invalid, or else `otherwise`.
 */
function problemStatus(problem: XProblem | undefined, otherwise = 400): number {
  const type = problem?.type ?? "";
  return /not-found/.test(type) ? 404
    : /not-authorized|forbidden|unavailable/.test(type) ? 403
    : /invalid-request/.test(type) ? 400
    : otherwise;
}

/**
 * A write's answer, or the error X reported in place of its result: X can answer a write it didn't
 * make with a 200 holding only `errors`, which taken as done would record the change as applied. A
 * problem of no telling kind is a 502, so the write is tried again rather than refused for good.
 */
export function requireResult<T>(envelope: XEnvelope<T>): XEnvelope<T> {
  const problem = envelope.data === undefined ? envelope.errors?.[0] : undefined;
  if (!problem) return envelope;
  const status = problemStatus(problem, 502);
  throw new XApiError(status, describeProblem(problem, status), problem.type);
}

/**
 * The ID of what a create made, with an error X reported in its place classified as a write's is
 * (`requireResult`). X can answer a create with a 201 holding only an internal error, and may have
 * made the post or List all the same, so that and an answer without an ID are 502s: the send is
 * looked for before it is made again, rather than refused for good.
 */
export function requireCreated(envelope: XEnvelope<{ id: string }>, what: string): string {
  const id = requireResult(envelope).data?.id;
  if (!id) throw new XApiError(502, `X accepted the ${what} without returning its ID.`);
  return id;
}

type QueryValue = string | number | boolean | undefined;

/** A client for X's API as one user, with the access token of that user's connection. */
export class XApi {
  readonly #token: string;

  constructor(accessToken: string) {
    this.#token = accessToken;
  }

  /**
   * Reads `path`.
   * @param read Takes from X's envelope what the request was sent for, within the request: what
   * it throws is thrown to the caller, and counts a request X answered a success an error of the
   * call.
   * @returns X's envelope, or what `read` made of it.
   */
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<XEnvelope<T>>;
  get<T, R>(path: string, query: Record<string, QueryValue>, read: (envelope: XEnvelope<T>) => R): Promise<R>;
  get<T, R>(path: string, query: Record<string, QueryValue> = {},
            read?: (envelope: XEnvelope<T>) => R): Promise<XEnvelope<T> | R> {
    return read ? this.#send("GET", path, query, undefined, read) : this.#json("GET", path, query);
  }

  post<T>(path: string, body: unknown = {}): Promise<XEnvelope<T>> {
    return this.#json("POST", path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<XEnvelope<T>> {
    return this.#json("PUT", path, {}, body);
  }

  /**
   * Creates what `path` creates, and resolves to the ID X names for it. A success that names none
   * is thrown as `requireCreated` throws it, from within the request, so that it is counted an
   * error of the API; whoever sent it reconciles what it may have made.
   * @param what What is created, as the error names it.
   */
  create(path: string, body: unknown, what: string): Promise<string> {
    return this.#send("POST", path, {}, JSON.stringify(body),
      (envelope: XEnvelope<{ id: string }>) => requireCreated(envelope, what));
  }

  delete<T>(path: string): Promise<XEnvelope<T>> {
    return this.#json("DELETE", path, {});
  }

  /**
   * Uploads one image for a post.
   * @returns The media ID to attach with `media.media_ids`.
   */
  async uploadImage(bytes: Uint8Array, mediaType: string): Promise<string> {
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: mediaType }), "image");
    form.append("media_category", "tweet_image");
    return this.#send("POST", "/2/media/upload", {}, form, (envelope: XEnvelope<{ id?: string }>) => {
      const id = envelope.data?.id;
      if (!id) throw new XApiError(502, "X accepted the image upload without returning a media ID.");
      return id;
    });
  }

  #json<T>(method: string, path: string, query: Record<string, QueryValue>, body?: unknown): Promise<XEnvelope<T>> {
    return this.#send<T>(method, path, query, body === undefined ? undefined : JSON.stringify(body));
  }

  // Sends one request and resolves to X's envelope, or to what `read` makes of it. A method that
  // takes from the envelope what its request was sent for does so in `read`: what `read` throws is
  // thrown to the caller, and counts a request X answered a success an error of the call.
  #send<T>(method: string, path: string, query: Record<string, QueryValue>,
           body?: string | FormData): Promise<XEnvelope<T>>;
  #send<T, R>(method: string, path: string, query: Record<string, QueryValue>,
              body: string | FormData | undefined, read: (envelope: XEnvelope<T>) => R): Promise<R>;
  async #send<T, R>(method: string, path: string, query: Record<string, QueryValue>,
                    body?: string | FormData, read?: (envelope: XEnvelope<T>) => R): Promise<XEnvelope<T> | R> {
    const url = new URL(path, X_API_ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    // What is thrown before X answered is the request not reaching X, or X not answering in time.
    let answered = false;
    let answer: XEnvelope<T> | XApiError;
    let made: Made<R> | undefined;
    try {
      ({ answer, made } = await xUpstream.read(url.toString(), { method, headers, body }, async response => {
        answered = true;
        const envelope = await readAnswer<T>(response);
        // The method reads the envelope this helper returns: no error an answer stands for.
        return { answer: envelope, made: read && !(envelope instanceof XApiError) ? madeOf(envelope, read) : undefined };
      }, counted => (counted.made && "thrown" in counted.made
        ? { outcome: "error", reason: "api" } : countedAs(counted.answer))));
    } catch (error) {
      if (answered) throw error;
      throw new XTransportError("X did not answer in time; please try again.", { cause: error });
    }
    if (answer instanceof XApiError) throw answer;
    if (!made) return answer;
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }
}

// What the method that sent a request made of the envelope `XApi` hands it: what it read from the
// envelope, or what it threw for one that lacks what the request was sent for.
type Made<R> = { value: R } | { thrown: unknown };

// Reads an envelope as the method that sent the request does, keeping what `read` throws for the
// request to be counted by and for `XApi` to throw.
function madeOf<T, R>(envelope: XEnvelope<T>, read: (envelope: XEnvelope<T>) => R): Made<R> {
  try {
    return { value: read(envelope) };
  } catch (error) {
    return { thrown: error };
  }
}

/**
 * Reads X's answer: its envelope, or the error the answer stands for, which is returned for the
 * request to be counted by (`countedAs`) and thrown by `XApi`. An answer that could not be read is
 * thrown.
 */
async function readAnswer<T>(response: Response): Promise<XEnvelope<T> | XApiError> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return new XApiError(response.status, "X answered with an unexpected redirect.");
  }
  let text: string;
  try {
    text = await readTextCapped(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    throw new XTransportError("X's response could not be read; please try again.", { cause: error });
  }
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unread, as far as billing goes: X may have returned, and billed, rows in it.
      if (response.ok) throw new XTransportError("X answered with a response that is not JSON.");
    }
  }
  if (!response.ok) return errorForResponse(response, parsed);
  return (parsed ?? {}) as XEnvelope<T>;
}

/**
 * How an answer is counted where its status alone does not say. One saying that the deployment's
 * credits are used up or its spending limit reached, which is the one read as an `XCreditsError`,
 * is X declining for capacity, whatever its status. Any other error is counted by its status. X
 * answers a lookup, a listing or a write it did not make with a 2xx holding `errors` in place of
 * `data`, which is an error of the call. Rows with partial `errors` beside them are a success.
 */
function countedAs(answer: XEnvelope<unknown> | XApiError): CallAnswer | undefined {
  if (answer instanceof XCreditsError) return { outcome: "refused", reason: "capacity" };
  if (answer instanceof XApiError) return undefined;
  const failed = (answer.data === undefined || answer.data === null)
    && Array.isArray(answer.errors) && answer.errors.length > 0;
  return failed ? { outcome: "error", reason: "api" } : undefined;
}

/** Fields every post read asks for, as one place to tune what each read costs. */
export const POST_FIELDS: Record<string, string> = {
  "tweet.fields": [
    "created_at", "author_id", "conversation_id", "in_reply_to_user_id", "referenced_tweets",
    "attachments", "entities", "public_metrics", "lang", "possibly_sensitive", "reply_settings",
    "note_tweet",
  ].join(","),
  expansions: [
    "author_id", "referenced_tweets.id", "referenced_tweets.id.author_id", "attachments.media_keys",
    "attachments.poll_ids",
  ].join(","),
  "user.fields": "id,name,username,verified,protected,profile_image_url",
  "media.fields": "type,url,preview_image_url,alt_text,width,height,duration_ms",
  "poll.fields": "options,end_datetime,voting_status",
};

/** Fields every profile read asks for; `connection_status` gives the relationship and mute state. */
export const USER_FIELDS: Record<string, string> = {
  "user.fields": "id,name,username,verified,protected,profile_image_url,description,location,url," +
    "created_at,public_metrics,entities,connection_status",
};

/** Fields every List read asks for. */
export const LIST_FIELDS: Record<string, string> = {
  "list.fields": "id,name,description,private,owner_id,member_count,follower_count,created_at",
  expansions: "owner_id",
  "user.fields": "id,name,username,verified,protected,profile_image_url",
};

/**
 * What a listing asks X for: a page size inside the endpoint's bounds, and where to resume. Search
 * takes its continuation as `next_token`; every other listing as `pagination_token`.
 */
export function pageQuery(
  pageSize: number, token: string | undefined, bounds: { min: number; max: number },
  tokenParam: "pagination_token" | "next_token" = "pagination_token",
): Record<string, QueryValue> {
  return {
    max_results: Math.min(bounds.max, Math.max(bounds.min, pageSize)),
    ...(token ? { [tokenParam]: token } : {}),
  };
}

/** X's timestamp form: RFC 3339 to the second. */
export function xTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** How many resources a response returned, which is what X bills a read by. */
export function billableResources(envelope: XEnvelope<unknown>): number {
  const data = envelope.data;
  const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
  const includes = envelope.includes;
  return rows + (includes?.users?.length ?? 0) + (includes?.tweets?.length ?? 0)
    + (includes?.posts?.length ?? 0);
}
