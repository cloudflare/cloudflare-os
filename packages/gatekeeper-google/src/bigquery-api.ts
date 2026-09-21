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
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

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

async function callRest<T>(
  url: string,
  init: RequestInit,
  getAccessToken: AccessTokenProvider,
): Promise<T> {
  let headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  // retries: 1 — no transient retry. query() promises a single absolute deadline covering the submit
  // and every poll, and a retried submit would burn it before the first poll, leaving the caller
  // with "query took too long" for a query that never ran.
  let response = await fetchWithAuthRetry(url, {
    ...init,
    headers,
  }, getAccessToken, { timeoutMs: REQUEST_ABORT_TIMEOUT_MS, retries: 1 });

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
    throw new Error(`BigQuery API error: ${detail}`);
  }
  if (!isJson) {
    throw new Error(`BigQuery API: expected JSON, got ${contentType}`);
  }
  return response.json() as Promise<T>;
}

// =============================================================================
// Public API

export class BigQueryApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async listProjects(options?: ListOptions): Promise<BigQueryProject[]> {
    let projects: BigQueryProject[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let pageLimit = listPageLimit(options);
    do {
      let url = new URL(`${API_BASE}/projects`);
      url.searchParams.set("maxResults", listMaxResults(options));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let resp = await callRest<RestProjectsListResponse>(
        url.toString(), { method: "GET" }, this.getAccessToken);
      for (let p of resp.projects ?? []) {
        projects.push({
          projectId: p.projectReference?.projectId ?? p.id,
          friendlyName: p.friendlyName,
          numericId: p.numericId,
        });
      }
      pageToken = resp.nextPageToken;
      pages++;
    } while (pageToken && pages < pageLimit);
    return projects;
  }

  async #getQueryResults(
    projectId: string,
    jobId: string,
    location: string | undefined,
    maxResults: number | undefined,
    timeoutMs: number,
  ): Promise<RestQueryResultsResponse> {
    let url = new URL(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/queries/${encodeURIComponent(jobId)}`);
    url.searchParams.set("timeoutMs", String(timeoutMs));
    if (location) url.searchParams.set("location", location);
    if (maxResults !== undefined) url.searchParams.set("maxResults", String(maxResults));
    return callRest<RestQueryResultsResponse>(
      url.toString(), { method: "GET" }, this.getAccessToken);
  }

  async #cancelJob(projectId: string, jobId: string, location?: string): Promise<void> {
    let url = new URL(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/jobs/${encodeURIComponent(jobId)}/cancel`);
    if (location) url.searchParams.set("location", location);
    await callRest<unknown>(url.toString(), { method: "POST" }, this.getAccessToken);
  }

  /** Run a synchronous query via jobs.query. */
  async query(
    billingProject: string,
    sql: string,
    opts: BigQueryQueryOptions = {},
  ): Promise<BigQueryQueryResult> {
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

    if (opts.defaultDataset) {
      body.defaultDataset = { projectId: billingProject, datasetId: opts.defaultDataset };
    }

    let parameters = buildQueryParameters(opts.params);
    if (parameters) {
      body.queryParameters = parameters;
      body.parameterMode = "NAMED";
    }

    let url = `${API_BASE}/projects/${encodeURIComponent(billingProject)}/queries`;
    let resp = await callRest<RestQueryResultsResponse>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, this.getAccessToken);

    if (resp.errors && resp.errors.length > 0) {
      throw new Error(`BigQuery query failed: ${resp.errors[0].message ?? "unknown error"}`);
    }

    while (!resp.jobComplete) {
      let remaining = deadline - Date.now();
      if (remaining <= 0) break;
      resp = await this.#getQueryResults(
        resp.jobReference.projectId,
        resp.jobReference.jobId,
        resp.jobReference.location,
        opts.maxResults ?? DEFAULT_MAX_RESULTS,
        remaining,
      );
      if (resp.errors && resp.errors.length > 0) {
        throw new Error(
          `BigQuery query failed: ${resp.errors[0].message ?? "unknown error"}`);
      }
    }

    if (!resp.jobComplete) {
      await this.#cancelJob(
        resp.jobReference.projectId,
        resp.jobReference.jobId,
        resp.jobReference.location,
      ).catch(() => {});
      throw new Error(
        "Query took too long to complete. Try a more selective WHERE clause or a smaller LIMIT.");
    }

    let schema = convertSchema(resp.schema);
    let restFields = resp.schema?.fields ?? [];
    let rows = (resp.rows ?? []).map(r => convertRow(r, restFields));

    return {
      schema,
      rows,
      totalRows: resp.totalRows ? Number(resp.totalRows) : rows.length,
      bytesProcessed: resp.totalBytesProcessed ? Number(resp.totalBytesProcessed) : 0,
      cacheHit: !!resp.cacheHit,
      jobId: resp.jobReference.jobId,
    };
  }

  async dryRun(
    billingProject: string,
    sql: string,
    opts: Pick<BigQueryQueryOptions, "defaultDataset" | "params"> = {},
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
    if (opts.defaultDataset) {
      queryConfig.defaultDataset = {
        projectId: billingProject,
        datasetId: opts.defaultDataset,
      };
    }
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
    let resp = await callRest<RestJob>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, this.getAccessToken);

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
  }

  async listDatasets(projectId: string, options?: ListOptions): Promise<BigQueryDataset[]> {
    let datasets: BigQueryDataset[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let pageLimit = listPageLimit(options);
    do {
      let url = new URL(
          `${API_BASE}/projects/${encodeURIComponent(projectId)}/datasets`);
      url.searchParams.set("maxResults", listMaxResults(options));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let resp = await callRest<RestDatasetsListResponse & { nextPageToken?: string }>(
        url.toString(), { method: "GET" }, this.getAccessToken);
      for (let d of resp.datasets ?? []) {
        datasets.push({
          datasetId: d.datasetReference.datasetId,
          projectId: d.datasetReference.projectId,
          friendlyName: d.friendlyName,
          location: d.location,
        });
      }
      pageToken = resp.nextPageToken;
      pages++;
    } while (pageToken && pages < pageLimit);
    return datasets;
  }

  async getDataset(projectId: string, datasetId: string): Promise<BigQueryDataset> {
    let url =
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(datasetId)}`;
    let resp = await callRest<RestDatasetResource>(url, { method: "GET" }, this.getAccessToken);
    return {
      datasetId: resp.datasetReference.datasetId,
      projectId: resp.datasetReference.projectId,
      friendlyName: resp.friendlyName,
      description: resp.description,
      location: resp.location,
    };
  }

  async listTables(projectId: string, datasetId: string, options?: ListOptions): Promise<BigQueryTable[]> {
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
      let resp = await callRest<RestTablesListResponse & { nextPageToken?: string }>(
        url.toString(), { method: "GET" }, this.getAccessToken);
      for (let t of resp.tables ?? []) {
        tables.push({
          tableId: t.tableReference.tableId,
          datasetId: t.tableReference.datasetId,
          projectId: t.tableReference.projectId,
          type: t.type ?? "TABLE",
          friendlyName: t.friendlyName,
          creationTime: t.creationTime ? Number(t.creationTime) : undefined,
        });
      }
      pageToken = resp.nextPageToken;
      pages++;
    } while (pageToken && pages < pageLimit);
    return tables;
  }

  async getTable(projectId: string, datasetId: string, tableId: string):
      Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    let url =
        `${API_BASE}/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(datasetId)}` +
        `/tables/${encodeURIComponent(tableId)}`;
    let resp = await callRest<RestTableResource>(url, { method: "GET" }, this.getAccessToken);
    return {
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
    };
  }
}
