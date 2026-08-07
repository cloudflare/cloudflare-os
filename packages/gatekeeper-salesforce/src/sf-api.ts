// Salesforce REST /query client. Handles JWT token acquisition, caching, pagination via the
// `nextRecordsUrl` in the query response, and incremental queries keyed on SystemModstamp.
// Deletions use the sObject Get Deleted resource (recycle-bin window), not delta ID diffs.

import { authenticateWithJwt, type SalesforceAuthConfig, type SalesforceAccessToken } from "./sf-auth.js";
import type { SfRecord } from "./salesforce-types.js";
import { toSfId15 } from "./salesforce-types.js";

export type { SalesforceAuthConfig, SalesforceAccessToken } from "./sf-auth.js";

export interface SfQueryOptions {
  // A URL-encoded SOQL WHERE clause fragment, e.g. "SystemModstamp > 2026-08-01T00:00:00Z".
  sinceModstamp?: string;
  // Page size hint for REST query responses (Salesforce caps at 2000). Does NOT cap the total
  // result set — pagination via nextRecordsUrl continues until exhausted or maxRecords.
  pageSize?: number;
}

export class SfApiError extends Error {
  constructor(
    message: string,
    readonly soql: string,
    readonly status?: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "SfApiError";
  }
}

// A minimal Salesforce query result.
export interface SfQueryResult {
  records: SfRecord[];
  nextRecordsUrl?: string;
}

export type SfDeletedRecord = {
  id: string;
  deletedDate: string;
};

export type SfGetDeletedResult = {
  deletedRecords: SfDeletedRecord[];
  earliestDateAvailable?: string;
  latestDateCovered?: string;
};

/** Composite sync cursor: SystemModstamp + last Id so ties are not skipped. */
export type SyncCursor = {
  modstamp: string;
  id?: string;
};

/** Parse a stored cursor string (`modstamp` or `modstamp|id`). */
export function parseSyncCursor(raw: string | null | undefined): SyncCursor | null {
  if (!raw) return null;
  const pipe = raw.indexOf("|");
  if (pipe === -1) return { modstamp: raw };
  const modstamp = raw.slice(0, pipe);
  const id = raw.slice(pipe + 1);
  if (!modstamp) return null;
  return id ? { modstamp, id } : { modstamp };
}

/** Serialize a composite cursor for D1 storage. */
export function formatSyncCursor(modstamp: string, id?: string): string {
  return id ? `${modstamp}|${id}` : modstamp;
}

/**
 * Join Salesforce REST paths with the instance URL.
 *
 * `nextRecordsUrl` is an absolute path like `/services/data/v60.0/query/...` — concatenate
 * instanceUrl + path only. Relative API paths (e.g. `/query?q=...`) get the version prefix.
 */
export function resolveSfUrl(instanceUrl: string, apiVersion: string, path: string): string {
  const base = instanceUrl.replace(/\/$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/services/")) return `${base}${path}`;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}/services/data/${apiVersion}${normalized}`;
}

/** Build the incremental WHERE clause without dropping same-SystemModstamp ties. */
export function buildModifiedWhere(cursor: SyncCursor | null): string | undefined {
  if (!cursor) return undefined;
  const ts = isoQuote(cursor.modstamp);
  if (cursor.id) {
    const id = toSfId15(cursor.id).replace(/'/g, "\\'");
    return `(SystemModstamp > ${ts} OR (SystemModstamp = ${ts} AND Id > '${id}'))`;
  }
  // Legacy modstamp-only cursor: inclusive lower bound so prior `>` runs don't drop ties.
  return `SystemModstamp >= ${ts}`;
}

/** Advance the composite cursor from the last record in an ordered page. */
export function cursorFromRecords(
  records: SfRecord[],
  fallback?: SyncCursor | null,
): SyncCursor | null {
  if (records.length === 0) return fallback ?? null;
  const last = records[records.length - 1];
  const modstamp = String(last.SystemModstamp ?? "");
  if (!modstamp) return fallback ?? null;
  return { modstamp, id: toSfId15(last.Id) };
}

// Salesforce getDeleted windows cannot exceed 15 days.
const GET_DELETED_MAX_MS = 15 * 24 * 60 * 60 * 1000;

export class SalesforceClient {
  #token: SalesforceAccessToken | null = null;
  #tokenPromise: Promise<SalesforceAccessToken> | null = null;
  #config: SalesforceAuthConfig;
  // REST page-size hint (Sforce-Query-Options batchSize). Not a total-result cap.
  readonly queryPageSize: number;

  constructor(
    config: SalesforceAuthConfig,
    queryPageSize = 200,
    /** Optional pre-seeded token (unit tests). */
    seedToken?: SalesforceAccessToken | null,
  ) {
    this.#config = config;
    this.queryPageSize = Math.min(Math.max(queryPageSize, 1), 2000);
    if (seedToken) this.#token = seedToken;
  }

  /** @deprecated Use queryPageSize — this was never a safe total-row LIMIT. */
  get queryLimit(): number {
    return this.queryPageSize;
  }

  #isExpired(): boolean {
    return !this.#token || this.#token.expiresAt <= Date.now();
  }

  async #getToken(): Promise<SalesforceAccessToken> {
    if (!this.#isExpired()) return this.#token!;
    // Deduplicate concurrent auth attempts.
    this.#tokenPromise ??= (async () => {
      const token = await authenticateWithJwt(this.#config);
      this.#token = token;
      return token;
    })();
    try {
      return await this.#tokenPromise;
    } finally {
      this.#tokenPromise = null;
    }
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.#getToken();
    const url = resolveSfUrl(token.instanceUrl, token.apiVersion, path);
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "Sforce-Query-Options": `batchSize=${this.queryPageSize}`,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      let errorCode: string | undefined;
      let message = `Salesforce API ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string; errorCode?: string };
        if (body.message) message = body.message;
        if (body.errorCode) errorCode = body.errorCode;
      } catch {
        // Ignore malformed error bodies.
      }
      throw new SfApiError(message, path, response.status, errorCode);
    }
    return response;
  }

  /** Runs a SOQL query, returning the first page and its continuation URL. */
  async query(soql: string): Promise<SfQueryResult> {
    const response = await this.#request(`/query?q=${encodeURIComponent(soql)}`);
    const body = (await response.json()) as {
      done: boolean;
      totalSize: number;
      records: SfRecord[];
      nextRecordsUrl?: string;
    };
    return { records: body.records, nextRecordsUrl: body.done ? undefined : body.nextRecordsUrl };
  }

  /** Fetches the next page of a large query via its continuation URL. */
  async queryMore(nextRecordsUrl: string): Promise<SfQueryResult> {
    const response = await this.#request(nextRecordsUrl);
    const body = (await response.json()) as {
      done: boolean;
      records: SfRecord[];
      nextRecordsUrl?: string;
    };
    return { records: body.records, nextRecordsUrl: body.done ? undefined : body.nextRecordsUrl };
  }

  /**
   * Queries all records matching SOQL. Page size comes from Sforce-Query-Options — there is no
   * SOQL LIMIT that would cap the whole result set. Pagination continues until Salesforce is
   * exhausted or `maxRecords` is reached (safety valve; omit / Infinity for unbounded).
   */
  async queryAll(
    soqlSelect: string,
    objectType: string,
    where?: string,
    maxRecords = Number.POSITIVE_INFINITY,
  ): Promise<{ records: SfRecord[]; truncated: boolean }> {
    let soql = `SELECT ${soqlSelect} FROM ${objectType}`;
    if (where) soql += ` WHERE ${where}`;
    // Id tie-break keeps SystemModstamp collisions ordered and cursor-advance safe.
    soql += ` ORDER BY SystemModstamp ASC NULLS LAST, Id ASC`;

    const all: SfRecord[] = [];
    let page = await this.query(soql);
    let truncated = false;
    while (true) {
      all.push(...page.records);
      if (all.length >= maxRecords) {
        truncated = true;
        break;
      }
      if (!page.nextRecordsUrl) break;
      page = await this.queryMore(page.nextRecordsUrl);
      if (page.records.length === 0) break;
    }
    return {
      records: Number.isFinite(maxRecords) ? all.slice(0, maxRecords) : all,
      truncated,
    };
  }

  /**
   * Incrementally queries records modified since the composite cursor (or everything on initial
   * bulk load). Uses `>=` / Id ordering so same-SystemModstamp ties are not dropped.
   */
  async queryModified(
    objectType: string,
    selectFields: string[],
    since?: SyncCursor | string | null,
    maxRecords = Number.POSITIVE_INFINITY,
  ): Promise<{ records: SfRecord[]; truncated: boolean }> {
    const cursor = typeof since === "string" ? parseSyncCursor(since) : since ?? null;
    const select = [...selectFields, "SystemModstamp"].filter((f, i, a) => a.indexOf(f) === i);
    return this.queryAll(select.join(", "), objectType, buildModifiedWhere(cursor), maxRecords);
  }

  /**
   * Returns Salesforce IDs deleted in `[start, end]` via the recycle-bin Get Deleted API.
   * Windows longer than 15 days are walked in chunks.
   */
  async getDeleted(
    objectType: string,
    startIso: string,
    endIso: string = new Date().toISOString(),
  ): Promise<SfDeletedRecord[]> {
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return [];
    }

    const out: SfDeletedRecord[] = [];
    let windowStart = startMs;
    while (windowStart < endMs) {
      const windowEnd = Math.min(windowStart + GET_DELETED_MAX_MS, endMs);
      const startParam = encodeURIComponent(new Date(windowStart).toISOString());
      const endParam = encodeURIComponent(new Date(windowEnd).toISOString());
      const response = await this.#request(
        `/sobjects/${encodeURIComponent(objectType)}/deleted/?start=${startParam}&end=${endParam}`,
      );
      const body = (await response.json()) as SfGetDeletedResult;
      for (const row of body.deletedRecords ?? []) {
        if (row?.id) out.push({ id: row.id, deletedDate: row.deletedDate });
      }
      // Advance past this window; if SF covered less than requested, still move forward by chunk.
      windowStart = windowEnd;
    }
    return out;
  }
}

// Quote an ISO-8601 timestamp for use in SOQL datetime literal position. Salesforce SOQL accepts
// bare ISO 8601 datetimes (e.g. 2026-08-01T00:00:00Z) next to comparison operators.
export function isoQuote(value: string): string {
  return value.replace(/'/g, "''");
}
