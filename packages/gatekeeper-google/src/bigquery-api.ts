// BigQuery REST API wrapper.
//
// Implements the methods needed by BigQuerySession against the public BigQuery REST API
// (https://cloud.google.com/bigquery/docs/reference/rest), authenticating with the user's
// OAuth access token. All real operations are read-only. Dry-runs use jobs.insert with
// `dryRun: true`; BigQuery's parser metadata is the authority for read-only and scope checks.

import type {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryParam, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQueryTable,
} from "./bigquery-types";
import { AccessTokenProvider, readCheckedWithAuthRetry } from "./auth-retry";
import { googleUpstream } from "./upstream";

const API_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const REQUEST_TIMEOUT_MS = 60_000;
// Give the client-side AbortSignal headroom over the server-side `timeoutMs` so the server
// finishes long-poll responses cleanly instead of racing into an AbortError.
const REQUEST_ABORT_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 10_000;
const DEFAULT_MAX_RESULTS = 1000;
export const DEFAULT_MAX_BYTES_BILLED = 100 * 1024 * 1024 * 1024;  // 100 GB

// Hard cap on pagination for list* methods: bounds memory and subrequest budget against
// accounts with very large numbers of projects/datasets/tables. Page size is 1000, so this
// caps each list response at 5,000 entries; callers needing more should narrow the scope
// or paginate at a higher layer.
const LIST_MAX_PAGES = 5;

type ListOptions = {
  maxPages?: number;
  maxResults?: number;
};

/**
 * A query's options as the session passes them: the agent's, with the default dataset resolved to
 * the project it lives in, which is the data's project and not necessarily the one the job runs in.
 */
export type BigQueryJobOptions = Omit<BigQueryQueryOptions, "defaultDataset"> & {
  defaultDataset?: { projectId: string; datasetId: string };
};

function listPageLimit(options?: ListOptions): number {
  return Math.max(1, Math.min(LIST_MAX_PAGES, Math.floor(options?.maxPages ?? LIST_MAX_PAGES)));
}

function listMaxResults(options?: ListOptions): string {
  return String(Math.max(1, Math.min(DEFAULT_MAX_RESULTS, Math.floor(options?.maxResults ?? DEFAULT_MAX_RESULTS))));
}

// =============================================================================
// REST shapes (only the fields we actually consume).

type GoogleErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
  };
};

/**
 * A failed BigQuery REST request, with its HTTP status and the first `reason` Google gave: what
 * tells a denial (`accessDenied`) apart from the other refusals BigQuery also answers with 403,
 * such as a rate limit, a quota or a missing scope.
 */
export class BigQueryApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string | undefined) {
    super(message);
  }
}

type RestField = {
  name: string;
  type: string;
  mode?: string;
  description?: string;
  fields?: RestField[];
};

type RestSchema = { fields?: RestField[] };

// Shared shape returned by both `jobs.query` (synchronous query API) and `jobs.getQueryResults`
// (used to poll long-running queries). The two endpoints return the same fields.
type RestQueryResultsResponse = {
  jobReference: { jobId: string; projectId: string; location?: string };
  jobComplete: boolean;
  schema?: RestSchema;
  rows?: RestRow[];
  totalRows?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
  errors?: { reason?: string; message?: string }[];
  pageToken?: string;
};

type RestRow = {
  f: { v: RestCellValue }[];
};

type RestCellValue = string | null | { v: RestCellValue }[] | RestRow;

type RestJob = {
  jobReference?: { jobId: string; projectId: string; location?: string };
  status?: {
    state: string;
    errorResult?: { reason?: string; message?: string };
    errors?: { reason?: string; message?: string }[];
  };
  statistics?: {
    query?: {
      totalBytesProcessed?: string;
      referencedTables?: { projectId: string; datasetId: string; tableId: string }[];
      referencedRoutines?: { projectId: string; datasetId: string; routineId: string }[];
      schema?: RestSchema;
      statementType?: string;
      ddlOperationPerformed?: string;
      scriptStatistics?: unknown;
      dmlStats?: unknown;
    };
  };
};

type RestDatasetsListResponse = {
  datasets?: {
    datasetReference: { projectId: string; datasetId: string };
    location?: string;
    friendlyName?: string;
  }[];
};

type RestProjectsListResponse = {
  projects?: {
    id: string;
    friendlyName?: string;
    numericId?: string;
    projectReference?: { projectId?: string };
  }[];
  nextPageToken?: string;
};

type RestDatasetResource = {
  datasetReference: { projectId: string; datasetId: string };
  friendlyName?: string;
  description?: string;
  location?: string;
};

type RestTablesListResponse = {
  tables?: {
    tableReference: { projectId: string; datasetId: string; tableId: string };
    type?: string;
    friendlyName?: string;
    creationTime?: string;
  }[];
};

type RestTableResource = {
  tableReference: { projectId: string; datasetId: string; tableId: string };
  type?: string;
  friendlyName?: string;
  description?: string;
  numRows?: string;
  numBytes?: string;
  creationTime?: string;
  lastModifiedTime?: string;
  schema?: RestSchema;
};

// =============================================================================
// Helpers

function convertField(f: RestField): BigQueryField {
  return {
    name: f.name,
    type: f.type,
    mode: (f.mode as BigQueryField["mode"]) ?? "NULLABLE",
    description: f.description,
    fields: f.fields ? f.fields.map(convertField) : undefined,
  };
}

function convertSchema(s: RestSchema | undefined): BigQueryField[] {
  return s?.fields ? s.fields.map(convertField) : [];
}

// Convert a BigQuery REST cell value to a plain JS value, recursing into nested STRUCTs and
// REPEATED fields. INT64/NUMERIC/TIMESTAMP scalars are kept as strings (precision).
function convertCell(value: RestCellValue, field: RestField): unknown {
  if (value === null || value === undefined) return null;

  if (field.mode === "REPEATED") {
    // Repeated values come as arrays of {v: ...} wrappers. We need to recurse with the
    // same field but treating it as scalar-of-element-type for each entry.
    if (!Array.isArray(value)) return null;
    let elementField = { ...field, mode: "NULLABLE" as const };
    return value.map(entry => {
      // Each entry is { v: ... }
      let entryV = (entry as { v: RestCellValue }).v;
      return convertCell(entryV, elementField);
    });
  }

  if (field.type === "RECORD" || field.type === "STRUCT") {
    // STRUCTs come as { f: [{v: ...}, ...] }
    let row = value as RestRow;
    let result: Record<string, unknown> = {};
    let subfields = field.fields ?? [];
    for (let i = 0; i < subfields.length; i++) {
      let cell = row.f[i];
      result[subfields[i].name] = cell ? convertCell(cell.v, subfields[i]) : null;
    }
    return result;
  }

  // Scalar — BigQuery returns everything as a string. Decode booleans natively, leave
  // numerics/timestamps as strings.
  if (field.type === "BOOLEAN" || field.type === "BOOL") {
    return value === "true";
  }
  return value;
}

function convertRow(row: RestRow, schema: RestField[]): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (let i = 0; i < schema.length; i++) {
    let cell = row.f[i];
    out[schema[i].name] = cell ? convertCell(cell.v, schema[i]) : null;
  }
  return out;
}

function buildQueryParameters(params: Record<string, BigQueryParam> | undefined): unknown[] | undefined {
  if (!params) return undefined;
  return Object.entries(params).map(([name, raw]) => {
    let value: string;
    let type: string;
    if (typeof raw === "string") {
      value = raw;
      type = "STRING";
    } else if (typeof raw === "number") {
      value = String(raw);
      type = Number.isInteger(raw) ? "INT64" : "FLOAT64";
    } else if (typeof raw === "boolean") {
      value = raw ? "true" : "false";
      type = "BOOL";
    } else {
      value = raw.value;
      type = raw.type;
    }
    return {
      name,
      parameterType: { type },
      parameterValue: { value },
    };
  });
}

// What the answer to a query's submission, or to a poll of its results, holds: the query's
// result where its job is complete, and else the job to poll.
type QueryAnswer =
  | { result: BigQueryQueryResult }
  | { job: { projectId: string; jobId: string; location?: string } };

// Reads the answer to a query's submission, or to a poll of its results. A query BigQuery
// rejected inside the 200 it answered with is thrown.
function queryAnswer(resp: RestQueryResultsResponse): QueryAnswer {
  if (resp.errors && resp.errors.length > 0) {
    throw new Error(`BigQuery query failed: ${resp.errors[0].message ?? "unknown error"}`);
  }
  if (!resp.jobComplete) {
    return {
      job: {
        projectId: resp.jobReference.projectId,
        jobId: resp.jobReference.jobId,
        location: resp.jobReference.location,
      },
    };
  }

  let schema = convertSchema(resp.schema);
  let restFields = resp.schema?.fields ?? [];
  let rows = (resp.rows ?? []).map(r => convertRow(r, restFields));
  return {
    result: {
      schema,
      rows,
      totalRows: resp.totalRows ? Number(resp.totalRows) : rows.length,
      bytesProcessed: resp.totalBytesProcessed ? Number(resp.totalBytesProcessed) : 0,
      cacheHit: !!resp.cacheHit,
      jobId: resp.jobReference.jobId,
    },
  };
}

// Sends one request and gives the JSON of its answer to `made`, the check of the method that
// sent it, within the request: what `made` throws on a 200 is thrown, and the attempt is counted
// an error with the reason `api`, so that the point says what the caller is told.
async function callRest<T, R>(
  url: string,
  init: RequestInit,
  getAccessToken: AccessTokenProvider,
  made: (answer: T) => R,
): Promise<R> {
  let headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  // retries: 1 — no transient retry. query() promises a single absolute deadline covering the submit
  // and every poll, and a retried submit would burn it before the first poll, leaving the caller
  // with "query took too long" for a query that never ran. The answer is read within the request,
  // which so counts a success that cannot be read as the failure it is thrown as.
  return readCheckedWithAuthRetry(url, {
    ...init,
    headers,
  }, { getAccessToken, timeoutMs: REQUEST_ABORT_TIMEOUT_MS, retries: 1 }, async response => {
    let contentType = response.headers.get("Content-Type") ?? "";
    let isJson = contentType.includes("application/json");
    if (!response.ok) {
      let detail: string;
      let rawBody: GoogleErrorResponse = {};
      if (isJson) {
        rawBody = (await response.json().catch(() => ({}))) as GoogleErrorResponse;
        detail = rawBody.error?.message ?? `${response.status} ${response.statusText}`;
      } else {
        detail = (await response.text().catch(() => "")).slice(0, 500)
            || `${response.status} ${response.statusText}`;
      }
      detail += ` [http=${response.status}]`;
      if (rawBody.error?.status) {
        detail += ` [status=${rawBody.error.status}]`;
      }
      if (rawBody.error?.errors && rawBody.error.errors.length > 0) {
        detail += ` [errors=${rawBody.error.errors.map(
            e => `${e.reason ?? "?"}:${e.message ?? "?"}`).join(" | ")}]`;
      }
      throw new BigQueryApiError(
          `BigQuery API error: ${detail}`, response.status, rawBody.error?.errors?.[0]?.reason);
    }
    if (!isJson) {
      throw new Error(`BigQuery API: expected JSON, got ${contentType}`);
    }
    return response.json() as Promise<T>;
  }, made);
}

// =============================================================================
// Public API

export class BigQueryApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async listProjects(options?: ListOptions): Promise<BigQueryProject[]> {
    return googleUpstream.summed(async () => {
      let projects: BigQueryProject[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      let pageLimit = listPageLimit(options);
      do {
        let url = new URL(`${API_BASE}/projects`);
        url.searchParams.set("maxResults", listMaxResults(options));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        let page = await callRest(
          url.toString(), { method: "GET" }, this.getAccessToken, (resp: RestProjectsListResponse) => {
            let found: BigQueryProject[] = [];
            for (let p of resp.projects ?? []) {
              found.push({
                projectId: p.projectReference?.projectId ?? p.id,
                friendlyName: p.friendlyName,
                numericId: p.numericId,
              });
            }
            return { found, nextPageToken: resp.nextPageToken };
          });
        projects.push(...page.found);
        pageToken = page.nextPageToken;
        pages++;
      } while (pageToken && pages < pageLimit);
      return projects;
    });
  }

  async #getQueryResults(
    projectId: string,
    jobId: string,
    location: string | undefined,
    maxResults: number | undefined,
    timeoutMs: number,
  ): Promise<QueryAnswer> {
    let url = new URL(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/queries/${encodeURIComponent(jobId)}`);
    url.searchParams.set("timeoutMs", String(timeoutMs));
    if (location) url.searchParams.set("location", location);
    if (maxResults !== undefined) url.searchParams.set("maxResults", String(maxResults));
    return callRest(url.toString(), { method: "GET" }, this.getAccessToken, queryAnswer);
  }

  async #cancelJob(projectId: string, jobId: string, location?: string): Promise<void> {
    let url = new URL(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/jobs/${encodeURIComponent(jobId)}/cancel`);
    if (location) url.searchParams.set("location", location);
    await callRest(url.toString(), { method: "POST" }, this.getAccessToken, () => undefined);
  }

  /** Run a synchronous query via jobs.query, as a job in `billingProject`. */
  async query(
    billingProject: string,
    sql: string,
    opts: BigQueryJobOptions = {},
  ): Promise<BigQueryQueryResult> {
    return googleUpstream.summed(async () => {
      // Single absolute deadline for the whole query (initial submit + any poll iterations).
      // Each individual server call is capped at the remaining time so total wall-clock stays
      // bounded.
      let deadline = Date.now() + REQUEST_TIMEOUT_MS;

      let body: Record<string, unknown> = {
        query: sql,
        useLegacySql: false,
        maxResults: opts.maxResults ?? DEFAULT_MAX_RESULTS,
        maximumBytesBilled: String(opts.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED),
        timeoutMs: REQUEST_TIMEOUT_MS,
      };

      if (opts.defaultDataset) body.defaultDataset = opts.defaultDataset;

      let parameters = buildQueryParameters(opts.params);
      if (parameters) {
        body.queryParameters = parameters;
        body.parameterMode = "NAMED";
      }

      let url = `${API_BASE}/projects/${encodeURIComponent(billingProject)}/queries`;
      // Each answer is read within its request, which so counts one that rejects the query, or
      // that holds neither a result nor a job to poll, as the failure it is thrown as.
      let answer = await callRest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, this.getAccessToken, queryAnswer);

      while ("job" in answer) {
        let remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let { job } = answer;
        answer = await this.#getQueryResults(
          job.projectId,
          job.jobId,
          job.location,
          opts.maxResults ?? DEFAULT_MAX_RESULTS,
          remaining,
        );
      }

      if ("job" in answer) {
        let { job } = answer;
        await this.#cancelJob(job.projectId, job.jobId, job.location).catch(() => {});
        throw new Error(
          "Query took too long to complete. Try a more selective WHERE clause or a smaller LIMIT.");
      }

      return answer.result;
    });
  }

  /**
   * Validate `sql` and estimate its cost as a dry-run job in `billingProject`. `signal` ends the
   * request it is in flight for, and keeps a retry from being sent.
   */
  async dryRun(
    billingProject: string,
    sql: string,
    opts: Pick<BigQueryJobOptions, "defaultDataset" | "params"> & { signal?: AbortSignal } = {},
  ): Promise<BigQueryDryRunResult & {
    statementType?: string;
    ddlOperationPerformed?: string;
    hasScript: boolean;
    hasDmlStats: boolean;
    referencedRoutines: string[];
  }> {
    let queryConfig: Record<string, unknown> = {
      query: sql,
      useLegacySql: false,
    };
    if (opts.defaultDataset) queryConfig.defaultDataset = opts.defaultDataset;
    let parameters = buildQueryParameters(opts.params);
    if (parameters) {
      queryConfig.queryParameters = parameters;
      queryConfig.parameterMode = "NAMED";
    }

    let body = {
      configuration: {
        dryRun: true,
        query: queryConfig,
      },
    };

    let url = `${API_BASE}/projects/${encodeURIComponent(billingProject)}/jobs`;
    return callRest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    }, this.getAccessToken, (resp: RestJob) => {
      // A job BigQuery failed inside the 200 it answered with.
      if (resp.status?.errorResult) {
        throw new Error(
          `BigQuery dry run failed: ${resp.status.errorResult.message ?? "unknown error"}`);
      }

      let stats = resp.statistics?.query;
      let referencedTables = (stats?.referencedTables ?? []).map(
          t => `${t.projectId}.${t.datasetId}.${t.tableId}`);
      let referencedRoutines = (stats?.referencedRoutines ?? []).map(
          r => `${r.projectId}.${r.datasetId}.${r.routineId}`);

      return {
        bytesProcessed: stats?.totalBytesProcessed ? Number(stats.totalBytesProcessed) : 0,
        referencedTables,
        referencedRoutines,
        schema: convertSchema(stats?.schema),
        statementType: stats?.statementType,
        ddlOperationPerformed: stats?.ddlOperationPerformed,
        hasScript: !!stats?.scriptStatistics,
        hasDmlStats: !!stats?.dmlStats,
      };
    });
  }

  async listDatasets(projectId: string, options?: ListOptions): Promise<BigQueryDataset[]> {
    return googleUpstream.summed(async () => {
      let datasets: BigQueryDataset[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      let pageLimit = listPageLimit(options);
      do {
        let url = new URL(
            `${API_BASE}/projects/${encodeURIComponent(projectId)}/datasets`);
        url.searchParams.set("maxResults", listMaxResults(options));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        let page = await callRest(
          url.toString(), { method: "GET" }, this.getAccessToken,
          (resp: RestDatasetsListResponse & { nextPageToken?: string }) => {
            let found: BigQueryDataset[] = [];
            for (let d of resp.datasets ?? []) {
              found.push({
                datasetId: d.datasetReference.datasetId,
                projectId: d.datasetReference.projectId,
                friendlyName: d.friendlyName,
                location: d.location,
              });
            }
            return { found, nextPageToken: resp.nextPageToken };
          });
        datasets.push(...page.found);
        pageToken = page.nextPageToken;
        pages++;
      } while (pageToken && pages < pageLimit);
      return datasets;
    });
  }

  async getDataset(projectId: string, datasetId: string): Promise<BigQueryDataset> {
    let url =
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(datasetId)}`;
    return callRest(url, { method: "GET" }, this.getAccessToken, (resp: RestDatasetResource) => ({
      datasetId: resp.datasetReference.datasetId,
      projectId: resp.datasetReference.projectId,
      friendlyName: resp.friendlyName,
      description: resp.description,
      location: resp.location,
    }));
  }

  async listTables(projectId: string, datasetId: string, options?: ListOptions): Promise<BigQueryTable[]> {
    return googleUpstream.summed(async () => {
      let tables: BigQueryTable[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      let pageLimit = listPageLimit(options);
      do {
        let url = new URL(
            `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
            `/datasets/${encodeURIComponent(datasetId)}/tables`);
        url.searchParams.set("maxResults", listMaxResults(options));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        let page = await callRest(
          url.toString(), { method: "GET" }, this.getAccessToken,
          (resp: RestTablesListResponse & { nextPageToken?: string }) => {
            let found: BigQueryTable[] = [];
            for (let t of resp.tables ?? []) {
              found.push({
                tableId: t.tableReference.tableId,
                datasetId: t.tableReference.datasetId,
                projectId: t.tableReference.projectId,
                type: t.type ?? "TABLE",
                friendlyName: t.friendlyName,
                creationTime: t.creationTime ? Number(t.creationTime) : undefined,
              });
            }
            return { found, nextPageToken: resp.nextPageToken };
          });
        tables.push(...page.found);
        pageToken = page.nextPageToken;
        pages++;
      } while (pageToken && pages < pageLimit);
      return tables;
    });
  }

  async getTable(projectId: string, datasetId: string, tableId: string):
      Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    let url =
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(datasetId)}` +
        `/tables/${encodeURIComponent(tableId)}`;
    return callRest(url, { method: "GET" }, this.getAccessToken, (resp: RestTableResource) => ({
      table: {
        tableId: resp.tableReference.tableId,
        datasetId: resp.tableReference.datasetId,
        projectId: resp.tableReference.projectId,
        type: resp.type ?? "TABLE",
        friendlyName: resp.friendlyName,
        description: resp.description,
        numRows: resp.numRows ? Number(resp.numRows) : undefined,
        numBytes: resp.numBytes ? Number(resp.numBytes) : undefined,
        creationTime: resp.creationTime ? Number(resp.creationTime) : undefined,
        lastModifiedTime: resp.lastModifiedTime ? Number(resp.lastModifiedTime) : undefined,
      },
      schema: convertSchema(resp.schema),
    }));
  }
}
