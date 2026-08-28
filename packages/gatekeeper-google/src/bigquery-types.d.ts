/** A single field in a BigQuery schema. RECORD fields contain nested fields. */
export type BigQueryField = {
  /** Field name. */
  name: string;
  /** BigQuery data type, e.g. "STRING", "INT64", "TIMESTAMP", "RECORD", "DATE". */
  type: string;
  /** Field mode: "NULLABLE" (default), "REQUIRED", or "REPEATED". */
  mode: "NULLABLE" | "REQUIRED" | "REPEATED";
  /** Description/comment on the field, if any. */
  description?: string;
  /** Nested fields, present when `type` is "RECORD" (a.k.a. STRUCT). */
  fields?: BigQueryField[];
};

/** A GCP project this BigQuery session is scoped to. */
export type BigQueryProject = {
  /** Project ID, e.g. "my-project". This is the canonical identifier used in queries. */
  projectId: string;
  /** Human-readable project name, if set. */
  friendlyName?: string;
  /** Numeric project number (legacy identifier, rarely needed). */
  numericId?: string;
};

/** A BigQuery dataset within a project. */
export type BigQueryDataset = {
  /** Dataset ID (e.g. "analytics"). */
  datasetId: string;
  /** Project ID the dataset belongs to. */
  projectId: string;
  /** Friendly display name, if set. */
  friendlyName?: string;
  /** Dataset description, if set. */
  description?: string;
  /** Dataset location (e.g. "US", "EU"). */
  location?: string;
};

/** A BigQuery table or view. */
export type BigQueryTable = {
  /** Table ID (e.g. "customer"). */
  tableId: string;
  /** Dataset ID the table belongs to. */
  datasetId: string;
  /** Project ID. */
  projectId: string;
  /** Either "TABLE", "VIEW", "MATERIALIZED_VIEW", or "EXTERNAL". */
  type: string;
  /** Friendly display name, if set. */
  friendlyName?: string;
  /** Table description, if set. */
  description?: string;
  /** Approximate row count, if known. */
  numRows?: number;
  /** Approximate size in bytes, if known. */
  numBytes?: number;
  /** When the table was created (Unix milliseconds). */
  creationTime?: number;
  /** When the table was last modified (Unix milliseconds). */
  lastModifiedTime?: number;
};

/** Result of a BigQuery query. */
export type BigQueryQueryResult = {
  /** Schema of the result columns. */
  schema: BigQueryField[];
  /** Result rows. Each row maps column name to a JSON-serializable value.
   * REPEATED fields are arrays; RECORD/STRUCT fields are nested objects.
   * INT64, NUMERIC, and TIMESTAMP values are returned as strings to preserve
   * full precision (the BigQuery REST API behavior); cast on the caller side
   * as needed. */
  rows: Record<string, unknown>[];
  /** Total rows in the result set (may exceed `rows.length` if truncated by `maxResults`). */
  totalRows: number;
  /** Bytes processed by the query (used for cost estimation). */
  bytesProcessed: number;
  /** Whether the result was served from BigQuery's query cache. */
  cacheHit: boolean;
  /** Job ID, useful for debugging or fetching more pages. */
  jobId: string;
};

/** Result of a query dry run — used to validate and estimate cost without executing. */
export type BigQueryDryRunResult = {
  /** Bytes that would be processed if the query were executed. */
  bytesProcessed: number;
  /** Tables the query would read from, as fully-qualified `project.dataset.table` strings. */
  referencedTables: string[];
  /** Routines referenced by the query. Scoped bindings reject routines before execution. */
  referencedRoutines: string[];
  /** Schema of the result the query would produce. */
  schema: BigQueryField[];
};

/** A typed query parameter for `BigQueryQueryOptions.params`.
 *
 * - `string` values are sent as `STRING`.
 * - `number` values are sent as `INT64` if integer, `FLOAT64` otherwise.
 * - `boolean` values are sent as `BOOL`.
 * - Use the object form when you need an explicit BigQuery type that can't be inferred from
 *   the JS value, e.g. `{ value: "2024-01-01T00:00:00Z", type: "TIMESTAMP" }` or
 *   `{ value: "12345678", type: "INT64" }` to force a numeric string into INT64. */
export type BigQueryParam = string | number | boolean | { value: string; type: string };

/** Options for executing a query. */
export type BigQueryQueryOptions = {
  /** Default dataset for unqualified table references. Defaults to the scoped dataset, if any. */
  defaultDataset?: string;
  /** Named query parameters, bound server-side by BigQuery. Use `@name` placeholders in SQL.
   * Pass plain JS values (string/number/boolean) or the object form for explicit typing
   * (e.g. `{ value: "...", type: "TIMESTAMP" }`). See `BigQueryParam` for details. */
  params?: Record<string, BigQueryParam>;
  /** Maximum rows to return in a single response. BigQuery may truncate beyond this; use
   * `totalRows` from the result to detect truncation. Defaults to 1000. */
  maxResults?: number;
  /** Maximum bytes the query is allowed to bill. Queries that would exceed this are rejected
   * before execution. Defaults to 100 GB to prevent runaway costs. */
  maximumBytesBilled?: number;
};

/** Session interface for querying BigQuery. All operations are read-only.
 *
 * Scoping: every session is scoped to one Google Cloud project via the URL passed to the
 * connection. The URL may narrow access further to one dataset or one table. Queries are
 * validated server-side (via dry-run table reference analysis) to ensure they only reference
 * allowed tables, and `defaultDataset` is enforced for dataset-scoped sessions. BigQuery reports
 * the underlying tables referenced by views, so querying a view may be rejected if the view reads
 * tables outside this binding's scope.
 *
 * BigQuery uses Google Standard SQL by default. Legacy SQL is not supported.
 */
export interface BigQuerySession {
  /** Execute a Standard SQL query and return the result.
   *
   * Queries must be read-only (SELECT, WITH). DDL and DML are rejected. Every query is
   * dry-run first to verify it stays within the session's scope and to enforce
   * `maximumBytesBilled` (default 100 GB).
   *
   * Every query must reference at least one table: a query that reads no table data (e.g.
   * `SELECT 1` or a bare scalar function call) is rejected, because its access cannot be
   * attributed to a dataset. Run such computations in gadget code instead.
   *
   * For parameterized queries, use `@name` placeholders with `opts.params` — BigQuery binds
   * them server-side, preventing SQL injection.
   *
   * @example
   * session.query(
   *   "SELECT * FROM `my-project.analytics.customers` WHERE account_id = @id",
   *   { params: { id: { value: "12345678", type: "INT64" } } }
   * )
   *
   * @param sql - Standard SQL query (legacy SQL is not supported).
   * @param opts - Optional query options.
   */
  query(sql: string, opts?: BigQueryQueryOptions): Promise<BigQueryQueryResult>;

  /** Validate a query and estimate its cost without executing it.
   *
   * Useful for showing users the bytes-processed estimate before running an expensive query,
   * or for programmatically inspecting which tables a query would touch. Like `query()`, the
   * query must reference at least one table.
   *
   * @param sql - Standard SQL query.
   * @param opts - Optional query options (params and defaultDataset; other options ignored).
   */
  dryRun(sql: string, opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">):
      Promise<BigQueryDryRunResult>;

  /** Return the GCP project this session is scoped to. */
  getProject(): Promise<BigQueryProject>;

  /** List datasets visible to the authenticated user in a project.
   *
   * If the session is scoped to a specific dataset, only that dataset is returned.
   *
   * @param projectId - Project to list datasets in. Defaults to the scoped project.
   */
  listDatasets(projectId?: string): Promise<BigQueryDataset[]>;

  /** List tables and views in a dataset.
   *
   * If the session is scoped to a specific table, only that table is returned.
   *
   * @param datasetId - Dataset ID. Defaults to the scoped dataset, if any.
   * @param projectId - Project ID. Defaults to the scoped project.
   */
  listTables(datasetId?: string, projectId?: string): Promise<BigQueryTable[]>;

  /** Get the schema and metadata for a specific table or view.
   *
   * @param tableId - Table ID. Defaults to the scoped table, if any.
   * @param datasetId - Dataset ID. Defaults to the scoped dataset, if any.
   * @param projectId - Project ID. Defaults to the scoped project.
   */
  describeTable(tableId?: string, datasetId?: string, projectId?: string):
      Promise<{ table: BigQueryTable; schema: BigQueryField[] }>;
}
