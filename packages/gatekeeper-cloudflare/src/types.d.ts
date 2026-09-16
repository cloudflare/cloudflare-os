// Workers Observability provides read-only telemetry for either one Cloudflare account or one
// Worker, depending on the binding the user granted. The binding enforces that boundary; callers do
// not pass account IDs or Worker names, and a Worker binding never returns another Worker's events.
//
// Start unfamiliar queries with `listKeys()` to discover indexed field names and types, then use
// `listValues()` to discover actual values before constructing filters or calculations. Do not guess
// field names or types. Queries default to the last hour; pass an explicit timeframe when the user
// asks about an earlier period. Cloudflare retains at most seven days of telemetry.
//
// Choose the query method by the result the user needs:
//
// - `listEvents()` returns individual logs, exceptions, spans, and other telemetry records.
// - `listInvocations()` groups events by Worker request/invocation ID.
// - `listTraces()` returns cross-service trace summaries and is available only on account bindings.
// - `getTrace()` retrieves events for a known trace ID and works on both binding types.
// - `calculate()` computes counts, percentiles, and other aggregate or time-series metrics.
//
// Event, invocation, and trace-list queries are paginated. When `nextCursor` is present, pass it as
// `cursor` with `direction: "next"`; do not restart the query or infer a cursor from other fields.
// A cursor is only a continuation position, not proof that another non-empty page exists. Stop when
// no cursor is returned or the next page is empty.
//
// Always inspect `statistics.abrLevel` before describing completeness. A value greater than 1 means
// Cloudflare answered from adaptively sampled telemetry: report how many records were returned and
// the sampling level, but do not call that number the exact total or claim that every matching event
// was found. Use `calculate()` for aggregate questions and still report its sampling metadata.

/** A JSON value stored in a custom log field or event source. */
export type CloudflareObservabilityJson =
  | null
  | boolean
  | number
  | string
  | CloudflareObservabilityJson[]
  | { [key: string]: CloudflareObservabilityJson };

/** The indexed primitive types supported by Workers Observability. */
export type CloudflareObservabilityValueType = "string" | "number" | "boolean";

/**
 * A time range to query. `from` must precede `to`, the span cannot exceed seven days, and the range
 * cannot end entirely before Cloudflare's seven-day retention window.
 */
export type CloudflareObservabilityTimeframe = {
  /** Inclusive start of the requested range. */
  from: Date;
  /** End of the requested range. */
  to: Date;
};

/** A comparison operation supported by Workers Observability filters. */
export type CloudflareObservabilityFilterOperation =
  | "includes" | "not_includes" | "starts_with" | "regex"
  | "exists" | "is_null" | "in" | "not_in"
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

/**
 * A recursive filter expression. Discover exact field names and types with `listKeys()` rather than
 * guessing them. To apply multiple conditions, provide one `group` expression containing the leaf
 * filters and choose `and` or `or`. Omit `value` only for operations such as `exists` and `is_null`.
 * A filter may nest up to three levels deep and contain at most 100 conditions in total.
 *
 * @example
 * { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "error" }
 *
 * @example
 * {
 *   kind: "group",
 *   filterCombination: "or",
 *   filters: [
 *     { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "error" },
 *     { kind: "filter", key: "$metadata.statusCode", operation: "gte", type: "number", value: 500 },
 *   ],
 * }
 */
export type CloudflareObservabilityFilter = {
  /** Discriminator for one field comparison. */
  kind: "filter";
  /**
   * Exact indexed field name returned by `listKeys()`.
   *
   * Note that your own structured log fields are indexed under their bare name, even though
   * `listEvents()` returns them nested under `source`: a field logged as `{event: "x"}` is filtered
   * as `event`. `source.event` is accepted as an alias for convenience, but `listKeys()` reports the
   * indexed name and is the reliable source.
   */
  key: string;
  operation: CloudflareObservabilityFilterOperation;
  /** Must match the type reported by `listKeys()`. */
  type: CloudflareObservabilityValueType;
  value?: string | number | boolean;
} | {
  /** Discriminator for a logical combination of filters. */
  kind: "group";
  filterCombination: "and" | "or";
  filters: CloudflareObservabilityFilter[];
};

/** Full-text search applied across event fields; use a structured `filter` for known field values. */
export type CloudflareObservabilitySearch = {
  /** Text or primitive value to find across event fields. */
  value: string | number | boolean;
  /** Interpret a string value as a regular expression. */
  isRegex?: boolean;
  /** Match string case exactly; defaults to case-insensitive matching. */
  matchCase?: boolean;
};

/** Options shared by telemetry discovery operations. */
export type CloudflareObservabilityDiscoveryOptions = {
  /** Defaults to the hour ending when the request starts. */
  timeframe?: CloudflareObservabilityTimeframe;
  /** One leaf or group expression. Combine multiple conditions inside a group. */
  filter?: CloudflareObservabilityFilter;
  /** Free-text match across event content; narrows which events the result is drawn from. */
  search?: CloudflareObservabilitySearch;
  /** Maximum results, from 1 through 1000. Defaults to 100. */
  limit?: number;
};

/** One indexed telemetry field returned by `listKeys()`. */
export type CloudflareObservabilityKey = {
  /** Indexed field name to pass to `listValues()`, filters, groups, or calculations. */
  key: string;
  /** Primitive type indexed for this field. */
  type: CloudflareObservabilityValueType;
  /** Unix epoch milliseconds when this field was most recently observed, when reported. */
  lastSeenAt?: number;
};

/** One field value returned by `listValues()`. */
export type CloudflareObservabilityValue = {
  /** Indexed field name. */
  key: string;
  /** Indexed primitive type. */
  type: CloudflareObservabilityValueType;
  /** One observed field value. */
  value: string | number | boolean;
  /** Cloudflare telemetry dataset containing the value, when reported. */
  dataset?: string;
};

/** Query cost and execution details reported by Workers Observability. */
export type CloudflareObservabilityStatistics = {
  /** Provider-reported query execution time. */
  elapsed: number;
  /** Number of telemetry rows scanned. */
  rowsRead: number;
  /** Number of telemetry bytes scanned. */
  bytesRead: number;
  /**
   * Adaptive sampling level used by Cloudflare. Omitted means level 1. Values greater than 1 mean
   * returned records are sampled and must not be reported as an exhaustive or exact total.
   */
  abrLevel?: number;
};

/** Common indexed metadata attached to a telemetry event. */
export type CloudflareObservabilityMetadata = {
  /** Stable event identifier, also used as an event-page cursor. */
  id: string;
  /** Worker request or invocation identifier. */
  requestId?: string;
  /** Distributed trace identifier. */
  traceId?: string;
  /** Span identifier within a distributed trace. */
  spanId?: string;
  /** Parent span identifier, when this event represents a child span. */
  parentSpanId?: string;
  /** Worker service that emitted the event. */
  service?: string;
  /** Provider event classification. */
  type?: string;
  /** Log severity, for example `debug`, `info`, `warn`, or `error`. */
  level?: string;
  /** Indexed log or event message. */
  message?: string;
  /** Indexed error text. */
  error?: string;
  /** Trigger that started the Worker invocation. */
  trigger?: string;
  /** Origin classification reported by Cloudflare. */
  origin?: string;
  /** HTTP status code associated with the event. */
  statusCode?: number;
  /** Duration reported for the event or invocation. */
  duration?: number;
  /** URL associated with the event, when indexed. */
  url?: string;
  /** Cloudflare region associated with the event. */
  region?: string;
  /** Operation name for a trace span. */
  spanName?: string;
  /** Name of the transaction the event belongs to. */
  transactionName?: string;
  /** Message with variable parts removed, for grouping similar logs. */
  messageTemplate?: string;
  /** Error text with variable parts removed, for grouping similar errors. */
  errorTemplate?: string;
  /** Stable grouping hash Cloudflare derives for similar events. */
  fingerprint?: string;
  /** Cloudflare account tag associated with the event. */
  account?: string;
  /** Reported latency in milliseconds. */
  latency?: number;
  /** End-to-end duration of the event's trace, in milliseconds. */
  traceDuration?: number;
  /** Event or span start as Unix epoch milliseconds. */
  startTime?: number;
  /** Event or span end as Unix epoch milliseconds. */
  endTime?: number;
  /**
   * Fields Cloudflare indexes that are not named above. Discover them with `listKeys()`; a value
   * read this way is `unknown`, so narrow it before use.
   */
  [key: string]: unknown;
};

/** One record from Cloudflare's broad telemetry events view. */
export type CloudflareObservabilityEvent = {
  /** Cloudflare telemetry dataset containing the record. */
  dataset: string;
  /** Unix epoch milliseconds; render with `new Date(timestamp).toISOString()`. */
  timestamp: number;
  /**
   * The original structured payload of the log, exactly as it was emitted.
   *
   * These fields are indexed — and so must be filtered, grouped, and aggregated — under their **bare**
   * name, without this `source.` prefix: a field logged as `{event: "x"}` appears here as
   * `source.event` but is queried as `event`. `listKeys()` reports the queryable names.
   */
  source: CloudflareObservabilityJson;
  /** Common indexed fields used for filtering and correlation. */
  $metadata: CloudflareObservabilityMetadata;
  /**
   * Worker-specific structured fields, when present. Commonly includes `wallTimeMs`, `cpuTimeMs`,
   * `outcome`, `eventType`, and `scriptName`; confirm with `listKeys()` before relying on one.
   */
  $workers?: CloudflareObservabilityJson;
};

/** Options shared by paginated event, invocation, and trace queries. */
export type CloudflareObservabilityEventsQuery = CloudflareObservabilityDiscoveryOptions & {
  /** Opaque `nextCursor` from the preceding page. */
  cursor?: string;
  /** Pass `next` together with `cursor`; omit both fields for the first page. */
  direction?: "next";
};

/** A page from the telemetry events view. Continue with `nextCursor` and `direction: "next"`. */
export type CloudflareObservabilityEventsPage = {
  /** Events in this page, constrained to the granted binding. */
  events: CloudflareObservabilityEvent[];
  /**
   * Provider-reported count of events matching the query, when available. Already constrained to
   * this binding. Not necessarily exact when `abrLevel > 1`, and not a count of `events` in this
   * page — use `events.length` for that.
   */
  count?: number;
  /** Opaque cursor for the next page. */
  nextCursor?: string;
  statistics: CloudflareObservabilityStatistics;
};

/** Options for listing Worker invocations. */
export type CloudflareObservabilityInvocationsQuery = CloudflareObservabilityEventsQuery;

/** Telemetry grouped under one Worker invocation/request ID. */
export type CloudflareObservabilityInvocation = {
  /** Worker request identifier used to group the events. */
  requestId: string;
  /** Telemetry records associated with this invocation in the current page. */
  events: CloudflareObservabilityEvent[];
};

/**
 * A page of Worker invocations. A page boundary may split related invocation data. Continue with
 * `nextCursor` and `direction: "next"` when a cursor is present.
 */
export type CloudflareObservabilityInvocationsPage = {
  /** Invocation groups in this page. */
  invocations: CloudflareObservabilityInvocation[];
  /** Opaque cursor for the next page. */
  nextCursor?: string;
  statistics: CloudflareObservabilityStatistics;
};

/** Options for listing distributed traces. */
export type CloudflareObservabilityTracesQuery = CloudflareObservabilityEventsQuery;

/** A distributed trace summary. */
export type CloudflareObservabilityTraceSummary = {
  /** Distributed trace identifier accepted by `getTrace()`. */
  traceId: string;
  /** Trace start as Unix epoch milliseconds. */
  traceStartMs: number;
  /** Trace end as Unix epoch milliseconds. */
  traceEndMs: number;
  /** End-to-end trace duration in milliseconds. */
  traceDurationMs: number;
  /** Name of the trace's root span. */
  rootSpanName: string;
  /** Name of the root transaction. */
  rootTransactionName: string;
  /** Worker services represented in the trace. */
  services: string[];
  /** Number of spans in the trace. */
  spans: number;
  /** Error summaries associated with the trace. */
  errors?: string[];
};

/** A page of distributed trace summaries. Continue with `nextCursor` when one is present. */
export type CloudflareObservabilityTracesPage = {
  /** Distributed trace summaries in this page. */
  traces: CloudflareObservabilityTraceSummary[];
  /** Opaque cursor for the next page. */
  nextCursor?: string;
  statistics: CloudflareObservabilityStatistics;
};

/** Options for retrieving one trace. */
export type CloudflareObservabilityTraceOptions = {
  /** Defaults to the last hour. Expand it when retrieving an older trace ID. */
  timeframe?: CloudflareObservabilityTimeframe;
};

/**
 * Telemetry records for one distributed trace. Worker bindings return only events emitted by that
 * Worker; account bindings may return events from every service in the account.
 */
export type CloudflareObservabilityTrace = {
  /** Requested distributed trace identifier. */
  traceId: string;
  /** Trace events visible through the granted binding. */
  events: CloudflareObservabilityEvent[];
  /** Number of returned events. */
  count: number;
  /** True when the bounded trace read reached its cap and may have omitted matching events. */
  truncated: boolean;
  statistics: CloudflareObservabilityStatistics;
};

/**
 * An aggregate calculation over matching telemetry. `count` does not require a key. For field
 * calculations, use a key and type returned by `listKeys()`. Set a short `alias` when the result
 * will be referenced by `orderBy` or when requesting several calculations.
 *
 * @example
 * { operator: "count", alias: "requests" }
 *
 * @example
 * { operator: "p99", key: "$metadata.duration", keyType: "number", alias: "p99Duration" }
 */
export type CloudflareObservabilityCalculation = {
  /** Counts matching events and needs no field. */
  operator: "count";
  /** Stable result name used by `orderBy` and returned calculation metadata. */
  alias?: string;
} | {
  /** Aggregate function to apply to `key`. */
  operator:
    | "uniq" | "max" | "min" | "sum" | "avg" | "median"
    | "p001" | "p01" | "p05" | "p10" | "p25" | "p75" | "p90"
    | "p95" | "p99" | "p999" | "stddev" | "variance";
  /** Indexed field to aggregate. */
  key: string;
  /** Indexed type of `key`; use the type returned by `listKeys()`. */
  keyType: CloudflareObservabilityValueType;
  /** Stable result name used by `orderBy` and returned calculation metadata. */
  alias?: string;
};

/** A field used to group aggregate results; use a field and type discovered with `listKeys()`. */
export type CloudflareObservabilityGroupBy = {
  /** Exact indexed field name. */
  value: string;
  type: CloudflareObservabilityValueType;
};

/** Options for calculating aggregate telemetry metrics. */
export type CloudflareObservabilityCalculationQuery = CloudflareObservabilityDiscoveryOptions & {
  /** One or more aggregate calculations to perform over the same matched telemetry. */
  calculations: CloudflareObservabilityCalculation[];
  groupBys?: CloudflareObservabilityGroupBy[];
  /** Sort grouped results by a calculation alias. */
  orderBy?: { value: string; order?: "asc" | "desc" };
  /**
   * Number of time-series buckets to divide the timeframe into — a count, not a duration. Supplying
   * it enables time-series results by default.
   */
  granularity?: number;
  /** Include time-series results. Defaults to true when `granularity` is provided, otherwise false. */
  includeSeries?: boolean;
};

/** One aggregate or time-series data point. */
export type CloudflareObservabilityAggregate = {
  /** Calculated aggregate value. */
  value: number;
  /** Number of matching source values represented by the aggregate. */
  count: number;
  /** Sampling correction interval reported by Cloudflare; preserve it when interpreting estimates. */
  interval: number;
  /** Source sampling interval reported by Cloudflare; preserve it when interpreting estimates. */
  sampleInterval: number;
  /** Group field/value pairs for this aggregate. */
  groups?: { key: string; value: string | number | boolean }[];
};

/** Results for one requested calculation. */
export type CloudflareObservabilityCalculationSeries = {
  /** Provider calculation identifier, usually the requested operator. */
  calculation: string;
  /** Caller-provided calculation alias. */
  alias?: string;
  /** Aggregate results across the complete timeframe. */
  aggregates: CloudflareObservabilityAggregate[];
  /** Time-bucketed results; empty when series were not requested. */
  series: { time: string; data: CloudflareObservabilityAggregate[] }[];
};

/** Aggregate query results. */
export type CloudflareObservabilityCalculationResult = {
  /** One result series for each requested calculation. */
  calculations: CloudflareObservabilityCalculationSeries[];
  statistics: CloudflareObservabilityStatistics;
};

/**
 * Read-only access to Workers logs, invocations, metrics, and traces for one granted binding.
 *
 * Use the binding directly from the agent environment. The user may grant an account binding or a
 * single-Worker binding. Account bindings can query every Worker in that account; Worker bindings
 * automatically constrain all returned events and reject `listTraces()` because trace summaries can
 * disclose other services. Use `listEvents()` to discover a trace ID and `getTrace()` to inspect the
 * bound Worker's events for that trace.
 *
 * Discover fields before filtering or aggregating. Keep the timeframe and limit as narrow as the
 * task allows, inspect `statistics` for query cost, and follow `nextCursor` only when more data is
 * needed. If `abrLevel` is greater than 1, say "returned N matching records at sampling level X"
 * rather than "found N total". Convert numeric event timestamps with `new Date(value).toISOString()`.
 *
 * @example
 * const keys = await observability.listKeys({ limit: 100 });
 * const errors = await observability.listEvents({
 *   filter: {
 *     kind: "filter",
 *     key: "$metadata.level",
 *     operation: "eq",
 *     type: "string",
 *     value: "error",
 *   },
 *   limit: 100,
 * });
 * console.log(errors.events);
 */
export interface CloudflareObservabilitySession {
  /**
   * Discover indexed fields and their types for this binding and timeframe. Call this before using
   * an unfamiliar field in `listValues()`, a filter, grouping, or calculation.
   */
  listKeys(options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityKey[]>;

  /**
   * Discover observed values for an indexed field. Pass the exact key and type returned by
   * `listKeys()` and use the result to build a structured filter without guessing values.
   */
  listValues(key: string, type: CloudflareObservabilityValueType,
    options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityValue[]>;

  /**
   * List records from Cloudflare's events view. A record may be an invocation/custom log,
   * exception, or trace span; inspect its metadata to distinguish those kinds. Paginate until no
   * cursor remains or a page is empty, but treat `events.length` as returned records, not an exact
   * total, whenever `statistics.abrLevel` is greater than 1.
   */
  listEvents(query?: CloudflareObservabilityEventsQuery): Promise<CloudflareObservabilityEventsPage>;

  /**
   * List matching Worker invocations with telemetry grouped by request ID. Prefer this over
   * `listEvents()` when the user asks about requests, executions, or invocation-level failures.
   */
  listInvocations(query?: CloudflareObservabilityInvocationsQuery):
    Promise<CloudflareObservabilityInvocationsPage>;

  /**
   * List account-wide distributed trace summaries. Worker-scoped bindings reject this operation
   * because each summary contains cross-service data; discover trace IDs with `listEvents()` and
   * call `getTrace()` instead.
   */
  listTraces(query?: CloudflareObservabilityTracesQuery): Promise<CloudflareObservabilityTracesPage>;

  /**
   * Retrieve bounded events for one known trace ID within the requested timeframe. Expand the
   * default one-hour timeframe when the trace is older. Throws when no event is found; check
   * `truncated` because very large traces are capped.
   */
  getTrace(traceId: string, options?: CloudflareObservabilityTraceOptions):
    Promise<CloudflareObservabilityTrace>;

  /**
   * Calculate aggregate metrics and optional grouped time series over matching telemetry. Discover
   * field names and types first; use aliases when ordering grouped results or requesting multiple
   * calculations.
   *
   * On a Worker binding this is scoped by the same immutable `$metadata.service` condition as every
   * other read, but unlike events the result cannot be re-checked afterwards -- an aggregate
   * computed across services could not be un-mixed. Treat a surprisingly large aggregate as a
   * question to raise with the user rather than a fact about the bound Worker.
   */
  calculate(query: CloudflareObservabilityCalculationQuery):
    Promise<CloudflareObservabilityCalculationResult>;
}
