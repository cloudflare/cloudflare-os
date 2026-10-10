// The only place this gatekeeper talks HTTP to X's API. One `request()` carries the bearer token,
// a timeout and a capped body read, never follows a redirect, and maps X's failures onto a few
// error classes the rest of the gatekeeper can act on: a credential rejection (401), a rate limit,
// exhausted credits, a refusal, and an outcome X never reported (a timeout or dropped connection).

import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { X_API_ORIGIN } from "./x-env";
import type { WireIncludes } from "./x-normalize";

const REQUEST_TIMEOUT_MS = 30_000;
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
  const type = problem?.type ?? "";
  const status = /not-found/.test(type) ? 404 : /not-authorized|forbidden|unavailable/.test(type) ? 403 : 400;
  throw new XApiError(status, status === 404
    ? `X has no ${what} with that ID, or it was deleted.`
    : status === 403
      ? `The connected X account can't see this ${what}.`
      : describeProblem(problem, status), type);
}

type QueryValue = string | number | boolean | undefined;

/** A client for X's API as one user, with the access token of that user's connection. */
export class XApi {
  readonly #token: string;

  constructor(accessToken: string) {
    this.#token = accessToken;
  }

  get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<XEnvelope<T>> {
    return this.#json("GET", path, query);
  }

  post<T>(path: string, body: unknown = {}): Promise<XEnvelope<T>> {
    return this.#json("POST", path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<XEnvelope<T>> {
    return this.#json("PUT", path, {}, body);
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
    const envelope = await this.#send<{ id?: string }>("POST", "/2/media/upload", {}, form);
    const id = envelope.data?.id;
    if (!id) throw new XApiError(502, "X accepted the image upload without returning a media ID.");
    return id;
  }

  #json<T>(method: string, path: string, query: Record<string, QueryValue>, body?: unknown): Promise<XEnvelope<T>> {
    return this.#send<T>(method, path, query, body === undefined ? undefined : JSON.stringify(body));
  }

  async #send<T>(method: string, path: string, query: Record<string, QueryValue>,
                 body?: string | FormData): Promise<XEnvelope<T>> {
    const url = new URL(path, X_API_ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new XTransportError("X did not answer in time; please try again.", { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new XApiError(response.status, "X answered with an unexpected redirect.");
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
        if (response.ok) throw new XApiError(502, "X answered with a response that is not JSON.");
      }
    }
    if (!response.ok) throw errorForResponse(response, parsed);
    return (parsed ?? {}) as XEnvelope<T>;
  }
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
