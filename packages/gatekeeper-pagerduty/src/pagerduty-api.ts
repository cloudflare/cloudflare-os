// The only place the gatekeeper talks HTTP to PagerDuty's REST API. One request carries the bearer
// token, PagerDuty's versioned `Accept` header and, on writes, the `From` header naming the
// connected user; it has a timeout and a capped body read, never follows a redirect, and turns a
// non-2xx answer into a `PagerDutyApiError`.

import { HttpError } from "@gadgets/gatekeeper-kit/http-errors";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { apiOrigin, type Region } from "./pagerduty-env";

const REQUEST_TIMEOUT_MS = 30_000;
/** A page of 100 incidents with their references is well under this. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** PagerDuty's largest page. */
export const MAX_LIMIT = 100;
/** PagerDuty refuses a listing whose `offset + limit` exceeds this. */
export const MAX_OFFSET = 10_000;

/**
 * Where the REST API keeps one object of each kind; it answers with the object under a key named for
 * its kind. Schedules have a path per generation (see `schedulePath`).
 */
const OBJECT_PATHS = {
  team: "/teams/",
  service: "/services/",
  incident: "/incidents/",
  escalation_policy: "/escalation_policies/",
} as const;

/**
 * Where schedule `id` is kept: PagerDuty serves shift-based schedules from its v3 API and
 * layer-based ones from v2, by the same IDs.
 */
export const schedulePath = (id: string, shiftBased: boolean): string => `${shiftBased ? "/v3" : ""}/schedules/${id}`;

/** A query value; arrays are sent as PagerDuty's `name[]=a&name[]=b`. */
export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Record<string, QueryValue>;

/** PagerDuty's refusal of a request, with its numeric error code when it gave one. */
export class PagerDutyApiError extends HttpError {
  constructor(status: number, message: string, readonly code?: number) {
    super(status, message);
    this.name = "PagerDutyApiError";
  }
}

/** Whether PagerDuty refused the credentials themselves (an expired or revoked token). */
export function isAuthError(error: unknown): boolean {
  return error instanceof PagerDutyApiError && error.status === 401;
}

/** Whether PagerDuty said the user can't see what was asked for: a definite "no access". */
export function isDenial(error: unknown): boolean {
  return error instanceof PagerDutyApiError && (error.status === 403 || error.status === 404);
}

/**
 * Whether PagerDuty refused the request itself, so repeating it would only be refused again: any
 * 4xx but a credential rejection or a rate limit.
 */
export function isRefusal(error: unknown): error is PagerDutyApiError {
  return error instanceof PagerDutyApiError && error.status < 500 && error.status !== 401 && error.status !== 429;
}

/** One page of a classic offset listing. */
export type Page<T> = { items: T[]; more: boolean };

/** One listing a walk draws on: its rows from `offset`, at most `limit`. */
export type OffsetSource<T> = (api: PagerDutyApi, offset: number, limit: number) => Promise<Page<T>>;

/** The listing at `path`, whose rows PagerDuty returns under `key`, each converted. */
export const listing = <W, T>(path: string, key: string, query: Query, convert: (wire: W) => T): OffsetSource<T> =>
  async (api, offset, limit) => {
    const page = await api.page<W>(path, key, query, offset, limit);
    return { ...page, items: page.items.map(convert) };
  };

/** Schedules: layer-based ones, then shift-based ones, which PagerDuty lists apart. */
export const scheduleListings = <W, T>(query: Query, convert: (wire: W, shiftBased: boolean) => T): OffsetSource<T>[] =>
  [false, true].map(shiftBased =>
    listing<W, T>(shiftBased ? "/v3/schedules" : "/schedules", "schedules", query, wire => convert(wire, shiftBased)));

/**
 * Up to `limit` rows of `sources`, walked in turn from `token`, `<source>:<offset>`, where the last
 * page stopped. The next source starts once one runs out, or reaches PagerDuty's offset cap.
 * @throws Error for a token no walk of `sources` hands out.
 */
export async function chainedPage<T>(api: PagerDutyApi, sources: readonly OffsetSource<T>[], token: string | undefined,
                                     limit: number): Promise<{ items: T[]; nextToken?: string }> {
  let [index, offset] = token === undefined ? [0, 0] : token.split(":").map(Number) as [number, number];
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index < 0 || index >= sources.length
    || offset < 0 || offset >= MAX_OFFSET) {
    throw new Error("That page has expired. Try again.");
  }
  const items: T[] = [];
  while (index < sources.length && items.length < limit) {
    const page = await sources[index]!(api, offset, Math.min(MAX_LIMIT, limit - items.length, MAX_OFFSET - offset));
    items.push(...page.items);
    offset += page.items.length;
    if (!page.more || page.items.length === 0 || offset >= MAX_OFFSET) [index, offset] = [index + 1, 0];
  }
  return { items, ...(index < sources.length ? { nextToken: `${index}:${offset}` } : {}) };
}

type ErrorBody = { error?: { code?: unknown; message?: unknown; errors?: unknown } };

/** A display-safe error for a non-2xx answer. */
function errorFor(response: Response, text: string): PagerDutyApiError {
  if (response.status === 429) {
    const reset = Number(response.headers.get("ratelimit-reset"));
    const wait = Number.isFinite(reset) && reset > 0 ? `in ${Math.ceil(reset)} seconds` : "shortly";
    return new PagerDutyApiError(429, `PagerDuty is rate limiting this connection; try again ${wait}.`, 2020);
  }
  let body: ErrorBody = {};
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    // Not JSON: the status alone describes it.
  }
  const { code, message, errors } = body.error ?? {};
  const details = [
    typeof message === "string" ? message : undefined,
    ...(Array.isArray(errors) ? errors.filter(error => typeof error === "string") : []),
  ].filter(Boolean).join("; ").slice(0, 500);
  return new PagerDutyApiError(response.status,
    `PagerDuty answered HTTP ${response.status}${details ? `: ${details}` : "."}`,
    typeof code === "number" ? code : undefined);
}

/** A REST client for one account, acting as one user. */
export class PagerDutyApi {
  readonly #token: string;
  readonly #origin: string;
  readonly #from?: string;

  /**
   * @param token The user's OAuth access token.
   * @param region The account's region, which picks the REST host.
   * @param from The user's email, which PagerDuty requires on writes.
   */
  constructor(token: string, region: Region, from?: string) {
    this.#token = token;
    this.#origin = apiOrigin(region);
    this.#from = from;
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.#send<T>("GET", path, query);
  }

  /** A change, attributed by `From` to the connected user. */
  write<T = unknown>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!this.#from) throw new Error("A PagerDuty write needs the connected user's email.");
    return this.#send<T>(method, path, {}, body);
  }

  /**
   * Schedule `id`, read without parameters from the API of its generation, and whether it is
   * shift-based. v3 is asked first, as PagerDuty recommends: it answers 400 for a layer-based
   * schedule, which v2 then serves.
   */
  async schedule<T>(id: string): Promise<{ body: T; shiftBased: boolean }> {
    try {
      return { body: await this.get<T>(schedulePath(id, true)), shiftBased: true };
    } catch (error) {
      if (!(error instanceof PagerDutyApiError && error.status === 400)) throw error;
    }
    return { body: await this.get<T>(schedulePath(id, false)), shiftBased: false };
  }

  /** The object `id` of `kind`, under a key named for its kind; a schedule of either generation. */
  async object(kind: keyof typeof OBJECT_PATHS | "schedule", id: string): Promise<Record<string, unknown>> {
    return kind === "schedule"
      ? (await this.schedule<Record<string, unknown>>(id)).body
      : await this.get<Record<string, unknown>>(`${OBJECT_PATHS[kind]}${id}`);
  }

  /** One page of the listing at `path`, whose rows PagerDuty returns under `key`. */
  async page<T>(path: string, key: string, query: Query, offset: number, limit: number): Promise<Page<T>> {
    const body = await this.get<Record<string, unknown>>(path, { ...query, offset, limit });
    const items = body[key];
    if (!Array.isArray(items)) throw new Error(`PagerDuty's listing of ${key} was malformed.`);
    return { items: items as T[], more: body.more === true };
  }

  /** Every row of a listing, up to `max` and PagerDuty's offset cap. */
  async all<T>(path: string, key: string, query: Query = {}, max = MAX_OFFSET): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; offset < Math.min(max, MAX_OFFSET);) {
      const limit = Math.min(MAX_LIMIT, max - offset, MAX_OFFSET - offset);
      const { items, more } = await this.page<T>(path, key, query, offset, limit);
      rows.push(...items);
      if (!more || items.length === 0) break;
      offset += items.length;
    }
    return rows;
  }

  async #send<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    const url = new URL(path, this.#origin);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(`${name}[]`, item);
      else url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.pagerduty+json;version=2",
    };
    if (method !== "GET") headers.From = this.#from!;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new Error(timedOut ? "PagerDuty did not answer in time; please try again." : "Could not reach PagerDuty; please try again.",
        { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new PagerDutyApiError(response.status, "PagerDuty answered with an unexpected redirect.");
    }
    let text: string;
    try {
      text = await readTextCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw new Error("PagerDuty's response could not be read; please try again.", { cause: error });
    }
    if (!response.ok) throw errorFor(response, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error("PagerDuty answered with a response that is not JSON.", { cause: error });
    }
  }
}
