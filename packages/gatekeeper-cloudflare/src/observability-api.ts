import type {
  CloudflareObservabilityCalculationQuery,
  CloudflareObservabilityCalculationResult,
  CloudflareObservabilityDiscoveryOptions,
  CloudflareObservabilityEvent,
  CloudflareObservabilityEventsPage,
  CloudflareObservabilityEventsQuery,
  CloudflareObservabilityFilter,
  CloudflareObservabilityInvocationsPage,
  CloudflareObservabilityInvocationsQuery,
  CloudflareObservabilityKey,
  CloudflareObservabilityStatistics,
  CloudflareObservabilityTrace,
  CloudflareObservabilityTraceOptions,
  CloudflareObservabilityTracesPage,
  CloudflareObservabilityTracesQuery,
  CloudflareObservabilityValue,
  CloudflareObservabilityValueType,
} from "./types.js";
import { obsContext } from "./observability.js";
import { VENDOR_ID } from "./vendor.js";
import { assertCloudflareAccountId } from "./resources.js";
import { deriveKeys, deriveValues } from "./observability-discovery.js";
import {
  CloudflareObservabilityApiError,
  invalidResponse,
  isFiniteNumber,
  isRecord,
  parseCalculations,
  parseEventsContainer,
  parseInvocationsContainer,
  parseKeys,
  parseStatistics,
  parseTraceSummaries,
  parseValues,
} from "./observability-parse.js";

export { CloudflareObservabilityApiError };

// Statuses that mean "this credential cannot read this resource". Cloudflare answers an account the
// caller cannot reach with 403 or 404, and an unknown account tag with 400.
const ACCESS_DENIED_STATUSES = new Set([400, 401, 403, 404]);

/**
 * Whether a failure means the credential lacks access, rather than the read having failed. Anything
 * else -- a 5xx, a transport error -- is our problem, not the caller's, and must never be reported as
 * a denial: mapping it to "denied" would be a silent authorization decision, and mapping it to
 * "allowed" would admit an unauthorized reader.
 */
export function deniesAccess(error: unknown): error is CloudflareObservabilityApiError {
  return error instanceof CloudflareObservabilityApiError &&
    ACCESS_DENIED_STATUSES.has(error.status);
}

export type ObservabilityFilter = CloudflareObservabilityFilter;

/**
 * Nesting levels allowed in a caller's filter expression, counting the expression itself as level 1.
 * The scope wrapper puts it inside one more group, so the wire payload is one level deeper. Bounds
 * both the recursion here and what the provider is asked to parse.
 */
const MAX_CALLER_FILTER_DEPTH = 3;
/** Total filter nodes allowed in a caller's expression, so a huge flat OR is rejected too. */
const MAX_CALLER_FILTER_NODES = 100;

function validateFilterExpression(expression: ObservabilityFilter): void {
  const pending: Array<{ filter: ObservabilityFilter; depth: number }> = [{ filter: expression, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes++;
    if (nodes > MAX_CALLER_FILTER_NODES) throw new Error("The filter contains too many conditions.");
    if (current.depth > MAX_CALLER_FILTER_DEPTH) throw new Error("Filter nesting is too deep.");
    if (current.filter.kind === "group") {
      for (const child of current.filter.filters) {
        pending.push({ filter: child, depth: current.depth + 1 });
      }
    }
  }
}

/** The envelope prefix `listEvents` nests a caller's own log fields under. See the note below. */
const SOURCE_ENVELOPE_PREFIX = "source.";

/**
 * Map a field reference from the shape an event is *returned* in to the name it is *indexed* under.
 *
 * `listEvents` returns a caller's structured log fields nested under `source`, but they are filterable
 * only by their bare name (see `observability-discovery.ts`), so copying a path out of a result and
 * filtering on it would otherwise match nothing and report no error. Accepting both spellings cannot
 * widen a query: the binding's own `$metadata.service` condition is a separate `AND` term that is
 * never rewritten, and an extra condition on any other field can only narrow.
 */
export function observabilityFieldKey(key: string): string {
  return key.startsWith(SOURCE_ENVELOPE_PREFIX) ? key.slice(SOURCE_ENVELOPE_PREFIX.length) : key;
}

/**
 * Rewrite every key in a caller expression to its indexed name. Depth and node count are already
 * bounded by `validateFilterExpression`, which every caller runs first, so this recursion is finite.
 */
function normalizeFilterKeys(expression: ObservabilityFilter): ObservabilityFilter {
  if (expression.kind === "group") {
    return {
      kind: "group",
      filterCombination: expression.filterCombination,
      filters: expression.filters.map(normalizeFilterKeys),
    };
  }
  return { ...expression, key: observabilityFieldKey(expression.key) };
}

/**
 * Prepend the binding's immutable Worker condition to a caller filter. The provider honours these on
 * the `query` endpoint, and `#scopeEvents` re-checks the result regardless.
 */
export function scopeObservabilityFilters(
  workerName: string | undefined,
  expression?: ObservabilityFilter,
): ObservabilityFilter[] {
  if (expression) validateFilterExpression(expression);

  const filters: ObservabilityFilter[] = [];
  if (workerName) {
    filters.push({
      kind: "filter",
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: workerName,
    });
  }
  if (expression) filters.push(normalizeFilterKeys(expression));
  return filters;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const DATASETS = ["cloudflare-workers"];
const DEFAULT_TIMEFRAME_MS = 60 * 60 * 1000;
const MAX_TIMEFRAME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_LIMIT = 1000;
const DEFAULT_RESULT_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 2_000;
// The default pause before the single retry, used whenever the provider gave no usable `Retry-After`.
const RETRY_DELAY_MS = 250;
const TRACE_PAGE_SIZE = 100;
const MAX_TRACE_PAGES = 3;
// A bounded whole-operation budget for `getTrace`, which is the only method that issues more than one
// request. Without it three pages of request timeout plus retries could hold an agent for minutes.
const MAX_TRACE_DURATION_MS = 60_000;
// Events sampled to answer a discovery call that has to be constrained. Large enough to surface the
// long tail of indexed fields, small enough to stay one page.
const DISCOVERY_SAMPLE_SIZE = 500;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.observability-api", vendorId: VENDOR_ID,
});

type QueryResult = {
  statistics: CloudflareObservabilityStatistics;
  events?: unknown;
  invocations?: unknown;
  traces?: unknown;
  calculations?: unknown;
};

type QueryOptions = CloudflareObservabilityDiscoveryOptions & {
  cursor?: string;
  direction?: "next" | "prev";
  calculations?: CloudflareObservabilityCalculationQuery["calculations"];
  groupBys?: CloudflareObservabilityCalculationQuery["groupBys"];
  orderBy?: CloudflareObservabilityCalculationQuery["orderBy"];
  granularity?: number;
  includeSeries?: boolean;
};

type EventsPageResult = {
  /** The caller-visible page. `nextCursor` is the provider's cursor, never a post-filtered one. */
  page: CloudflareObservabilityEventsPage;
  /** Events the provider returned before scope re-checking, for bounding a paginated read. */
  rawCount: number;
  totalCount?: number;
};

function timeframe(value?: { from: Date; to: Date }): { from: number; to: number } {
  const to = value?.to.valueOf() ?? Date.now();
  const from = value?.from.valueOf() ?? to - DEFAULT_TIMEFRAME_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("The observability timeframe must have valid dates with from before to.");
  }
  if (to - from > MAX_TIMEFRAME_MS) {
    throw new Error("The observability timeframe cannot exceed seven days.");
  }
  if (value && to < Date.now() - MAX_TIMEFRAME_MS) {
    throw new Error("The observability timeframe is outside Cloudflare's seven-day retention window.");
  }
  return { from, to };
}

function validatedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESULT_LIMIT) {
    throw new Error(`The observability limit must be an integer from 1 to ${MAX_RESULT_LIMIT}.`);
  }
  return value;
}

function invalidResponseStatus(response: Response): number {
  return response.ok ? 502 : response.status;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CloudflareObservabilityApiError(
      invalidResponseStatus(response), "The Workers Observability response is too large.",
    );
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CloudflareObservabilityApiError(
        invalidResponseStatus(response), "The Workers Observability response is too large.",
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CloudflareObservabilityApiError(
      invalidResponseStatus(response),
      `Cloudflare API request failed with status ${invalidResponseStatus(response)}: invalid JSON response.`,
    );
  }
}

function providerError(data: unknown, status: number): CloudflareObservabilityApiError {
  if (isRecord(data) && Array.isArray(data.errors)) {
    const messages = data.errors
      .flatMap(error => isRecord(error) &&
        typeof error.message === "string" ? [error.message.slice(0, 200)] : [])
      .slice(0, 3);
    const codes = data.errors
      .flatMap(error => isRecord(error) && isFiniteNumber(error.code) ? [error.code] : [])
      .slice(0, 3);
    if (messages.length > 0) {
      // `true`: this message is Cloudflare's, so it must not be logged.
      return new CloudflareObservabilityApiError(status, messages.join("; "), codes, true);
    }
  }
  return new CloudflareObservabilityApiError(
    status,
    `Cloudflare API request failed with status ${status}.`,
  );
}

/**
 * How long to wait before one retry, or null when the provider asked for longer than the budget
 * allows. Retrying a 429 sooner than `Retry-After` only guarantees a second 429, so we fail fast and
 * let the caller decide instead of burning the request.
 */
function retryDelay(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return RETRY_DELAY_MS;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(requested)) return RETRY_DELAY_MS;
  if (requested > MAX_RETRY_DELAY_MS) return null;
  return Math.max(requested, 0);
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class CloudflareObservabilityApi {
  private readonly accountId: string;

  constructor(
    private readonly getToken: () => Promise<string | null>,
    accountId: string,
    private readonly workerName?: string,
  ) {
    this.accountId = assertCloudflareAccountId(accountId);
  }

  async #request(path: string, body: unknown): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new CloudflareObservabilityApiError(401, "Cloudflare credentials have expired.");

    const url = `${API_BASE}/accounts/${encodeURIComponent(this.accountId)}` +
      `/workers/observability/telemetry/${path}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const data = await readJson(response);
        if (!response.ok || !isRecord(data) || data.success !== true) {
          throw providerError(data, response.status);
        }
        if (!("result" in data) || data.result === undefined || data.result === null) {
          throw invalidResponse();
        }
        return data.result;
      } catch (caught) {
        const timedOut = isTimeout(caught);
        // A connection reset or DNS failure is not an `AbortError` and not a typed provider error, so
        // normalize it here rather than letting a raw TypeError reach callers that switch on status.
        const error = timedOut
          ? new CloudflareObservabilityApiError(504, "Cloudflare Workers Observability request timed out.")
          : caught instanceof CloudflareObservabilityApiError
            ? caught
            : new CloudflareObservabilityApiError(
              502, "Could not reach the Cloudflare Workers Observability API.");
        // The provider's own message is deliberately absent here: Cloudflare can echo a
        // caller-supplied filter value back in an error, and filter values are kept out of the audit
        // trail for exactly that reason (see `summarizeFilter`). Cloudflare's numeric codes identify
        // the failure without carrying caller text. Our own messages are safe, so a timeout or
        // transport failure is still logged in full.
        //
        // The discriminator is provenance, not `codes.length`: Cloudflare can return a message with
        // no numeric code at all, and keying on the codes would have logged exactly the text this is
        // meant to withhold. When a provider error carries no codes, the status is all that is left,
        // and that is the fail-closed answer.
        logger.warn("Workers Observability request failed", {
          event: "observability.request.failed", path, status: error.status, attempt,
          ...(error.codes.length > 0 ? { providerCodes: error.codes.join(",") } : {}),
          ...(error.fromProvider ? {} : { error }),
        });
        if (attempt === 2) throw error;
        // A timeout or transport failure gets one fast retry; a provider status only retries when it
        // is retryable and its own backoff hint fits the budget. Timeouts are checked first because a
        // body-read timeout arrives with an already-successful status, which is not itself retryable.
        const delay = timedOut || response === undefined
          ? RETRY_DELAY_MS
          : RETRYABLE_STATUSES.has(response.status) ? retryDelay(response) : null;
        if (delay === null) throw error;
        await wait(delay);
      }
    }
    throw new Error("Unreachable Workers Observability retry state.");
  }

  /**
   * Drop anything the binding must not disclose, reporting whether anything was dropped.
   *
   * The provider honours the scope filter on the `query` endpoint, so this normally removes nothing.
   * It is the authoritative check regardless, because a filter the provider silently ignored would
   * otherwise leak another Worker's telemetry -- and this provider has three separate documented
   * behaviours that return wrong-but-plausible data with no error, so "it accepted the filter" is
   * not evidence it applied it.
   *
   * `dropped` is what the rest of the module keys its distrust off: a single foreign event proves the
   * filter was not applied, which invalidates every *other* value on the same response that we
   * cannot re-derive ourselves -- see `#listEventsPage`. It is deliberately not a hard failure. The
   * events we return are filtered and therefore safe, and this provider has surprised us often
   * enough that converting a hypothetical disclosure into a guaranteed outage is the worse trade.
   */
  #scopeEvents(
    events: CloudflareObservabilityEvent[],
  ): { events: CloudflareObservabilityEvent[]; dropped: boolean } {
    if (!this.workerName) return { events, dropped: false };
    const scoped = events.filter(event => event.$metadata.service === this.workerName);
    if (scoped.length !== events.length) {
      // An operational alarm, not a routine event: it means the provider's filtering changed under
      // us and every aggregate this binding can return has silently widened.
      logger.error("Cloudflare did not honour the Worker observability scope filter", {
        event: "observability.scope.filter.ignored",
        droppedEvents: events.length - scoped.length,
      });
    }
    return { events: scoped, dropped: scoped.length !== events.length };
  }

  async #query(
    view: "events" | "invocations" | "traces" | "calculations",
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const limit = validatedLimit(options?.limit);
    const includeSeries = options?.includeSeries ?? options?.granularity !== undefined;
    const result = await this.#request("query", {
      queryId: `gadgets-${view}`,
      view,
      // Keeps this query out of the user's saved-query history; it is a read, not a saved view.
      dry: true,
      timeframe: timeframe(options?.timeframe),
      limit,
      offset: options?.cursor,
      offsetDirection: options?.direction,
      granularity: options?.granularity,
      ...(view === "calculations" ? { chart: includeSeries, ignoreSeries: !includeSeries } : {}),
      parameters: {
        datasets: DATASETS,
        filterCombination: "and",
        filters: scopeObservabilityFilters(this.workerName, options?.filter),
        needle: options?.search && {
          value: options.search.value,
          isRegex: options.search.isRegex,
          matchCase: options.search.matchCase,
        },
        // Rebuilt field-by-field rather than forwarded: extra properties are allowed to survive
        // RPC validation, and this is a trust boundary into the provider's query parser.
        calculations: options?.calculations?.map(calculation => calculation.operator === "count"
          ? { operator: calculation.operator, alias: calculation.alias }
          : {
            operator: calculation.operator,
            key: observabilityFieldKey(calculation.key),
            keyType: calculation.keyType,
            alias: calculation.alias,
          }),
        groupBys: options?.groupBys?.map(
          ({ value, type }) => ({ value: observabilityFieldKey(value), type })),
        orderBy: options?.orderBy && {
          value: options.orderBy.value, order: options.orderBy.order,
        },
        limit,
      },
    });
    if (!isRecord(result)) throw invalidResponse();
    return {
      statistics: parseStatistics(result.statistics),
      events: result.events,
      invocations: result.invocations,
      traces: result.traces,
      calculations: result.calculations,
    };
  }

  /**
   * Whether a discovery call has to be answered from an events sample rather than the dedicated
   * endpoints. `/keys` and `/values` ignore the filters they are sent (verified against the live
   * API; see `observability-discovery.ts`), so any request that must be *constrained* -- by this
   * binding's Worker scope or by a caller filter -- cannot be answered there.
   */
  #requiresDerivedDiscovery(options?: CloudflareObservabilityDiscoveryOptions): boolean {
    return this.workerName !== undefined || options?.filter !== undefined;
  }

  async #discoverySample(
    options?: CloudflareObservabilityDiscoveryOptions,
  ): Promise<CloudflareObservabilityEvent[]> {
    const { page } = await this.#listEventsPage({ ...options, limit: DISCOVERY_SAMPLE_SIZE });
    return page.events;
  }

  async listKeys(options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityKey[]> {
    const limit = validatedLimit(options?.limit);
    if (this.#requiresDerivedDiscovery(options)) {
      return deriveKeys(await this.#discoverySample(options), limit);
    }
    return parseKeys(await this.#request("keys", {
      ...timeframe(options?.timeframe),
      datasets: DATASETS,
      needle: options?.search,
      limit,
    }));
  }

  async listValues(
    key: string,
    type: CloudflareObservabilityValueType,
    options?: CloudflareObservabilityDiscoveryOptions,
  ): Promise<CloudflareObservabilityValue[]> {
    const limit = validatedLimit(options?.limit);
    const field = observabilityFieldKey(key);
    if (this.#requiresDerivedDiscovery(options)) {
      return deriveValues(await this.#discoverySample(options), field, type, limit);
    }
    return parseValues(await this.#request("values", {
      timeframe: timeframe(options?.timeframe),
      datasets: DATASETS,
      needle: options?.search,
      key: field,
      type,
      limit,
    }));
  }

  async #listEventsPage(options?: CloudflareObservabilityEventsQuery): Promise<EventsPageResult> {
    const result = await this.#query("events", options);
    const { count, events: rawEvents } = parseEventsContainer(result.events);
    const { events, dropped } = this.#scopeEvents(rawEvents);
    return {
      page: {
        events,
        // The provider's own count, which is only scoped if it applied the filter. `dropped` proves
        // it did not, and a count of the whole account's matching telemetry is exactly the kind of
        // volume this binding must not disclose -- so it is withheld rather than reported wrong.
        // Declared optional for this reason; `events.length` is always available to the caller.
        count: dropped ? undefined : count,
        // Derived from the provider's own events, not the scoped ones: a page whose events all
        // belonged to another service would otherwise end pagination while data remained.
        nextCursor: rawEvents.at(-1)?.$metadata.id,
        // Kept even when `dropped`: this describes what our own query cost, not how much telemetry
        // matched it, and callers are told to read it for cost. It does widen with an unhonoured
        // filter, which is why the drop is logged as an error rather than silently absorbed.
        statistics: result.statistics,
      },
      rawCount: rawEvents.length,
      totalCount: dropped ? undefined : count,
    };
  }

  async listEvents(options?: CloudflareObservabilityEventsQuery): Promise<CloudflareObservabilityEventsPage> {
    return (await this.#listEventsPage(options)).page;
  }

  async listInvocations(
    options?: CloudflareObservabilityInvocationsQuery,
  ): Promise<CloudflareObservabilityInvocationsPage> {
    const result = await this.#query("invocations", options);
    const groups = parseInvocationsContainer(result.invocations);
    // The provider returns a request-ID map, so iteration order is not a page order. Take the oldest
    // event as the cursor: results run newest-first, so that is the page's continuation point.
    const oldest = groups
      .flatMap(group => group.events)
      .reduce<CloudflareObservabilityEvent | undefined>(
        (last, event) => !last || event.timestamp < last.timestamp ? event : last, undefined);
    const invocations = groups
      .map(({ requestId, events }) => ({ requestId, events: this.#scopeEvents(events).events }))
      .filter(invocation => invocation.events.length > 0);
    return {
      invocations,
      nextCursor: oldest?.$metadata.id,
      statistics: result.statistics,
    };
  }

  async listTraces(options?: CloudflareObservabilityTracesQuery): Promise<CloudflareObservabilityTracesPage> {
    if (this.workerName) {
      throw new Error("Trace summaries are available only from an account-scoped observability binding.");
    }
    const result = await this.#query("traces", options);
    const traces = parseTraceSummaries(result.traces);
    return {
      traces,
      nextCursor: traces.at(-1)?.traceId,
      statistics: result.statistics,
    };
  }

  async getTrace(
    traceId: string,
    options?: CloudflareObservabilityTraceOptions,
  ): Promise<CloudflareObservabilityTrace> {
    const filter: CloudflareObservabilityFilter = {
      kind: "filter",
      key: "$metadata.traceId",
      operation: "eq",
      type: "string",
      value: traceId,
    };
    const deadline = Date.now() + MAX_TRACE_DURATION_MS;
    const events: CloudflareObservabilityEvent[] = [];
    let cursor: string | undefined;
    let truncated = false;
    let rawEventsRead = 0;
    let totalCount: number | undefined;
    let statistics: CloudflareObservabilityStatistics = { elapsed: 0, rowsRead: 0, bytesRead: 0 };
    for (let pageNumber = 0; pageNumber < MAX_TRACE_PAGES; pageNumber++) {
      // The enforced fields follow the spread so a caller option cannot override the trace filter,
      // the page size, or the cursor.
      const result = await this.#listEventsPage({
        ...options,
        filter,
        limit: TRACE_PAGE_SIZE,
        cursor,
      });
      const page = result.page;
      events.push(...page.events);
      rawEventsRead += result.rawCount;
      totalCount = result.totalCount ?? totalCount;
      statistics = {
        elapsed: statistics.elapsed + page.statistics.elapsed,
        rowsRead: statistics.rowsRead + page.statistics.rowsRead,
        bytesRead: statistics.bytesRead + page.statistics.bytesRead,
        abrLevel: page.statistics.abrLevel ?? statistics.abrLevel,
      };
      if (totalCount !== undefined && rawEventsRead >= totalCount) break;
      const exhausted = result.rawCount < TRACE_PAGE_SIZE || !page.nextCursor ||
        page.nextCursor === cursor;
      if (exhausted) break;
      cursor = page.nextCursor;
      // Any bound we stop on other than "read everything" may have omitted matching events.
      if (pageNumber === MAX_TRACE_PAGES - 1 || Date.now() >= deadline) {
        truncated = true;
        break;
      }
    }
    if (events.length === 0) {
      throw new CloudflareObservabilityApiError(
        404, `Trace ${traceId} was not found in the requested timeframe.`);
    }
    return { traceId, events, count: events.length, truncated, statistics };
  }

  /**
   * Aggregate over the matched telemetry.
   *
   * Unlike every other read here, a Worker-scoped binding's safety rests *solely* on the
   * `$metadata.service` filter injected by `scopeObservabilityFilters`. An aggregate cannot be
   * re-checked the way `#scopeEvents` re-checks events: there is no way to un-mix a median or a
   * `uniq` that was computed across services. So if the provider ever stopped honouring the filter,
   * this would widen silently, and the `dropped` alarm on the events path is the only thing that
   * would say so.
   *
   * That asymmetry is accepted rather than overlooked. `query` honouring filters is verified against
   * a live account and is already load-bearing elsewhere (it is why `observability-discovery.ts`
   * exists at all), and the alternatives are worse: refusing aggregates to Worker bindings removes
   * the most valuable question the tier can answer, and recomputing them from a sampled page would
   * return confidently wrong numbers. The scopable-but-unverifiable fix -- grouping by
   * `$metadata.service` and keeping this binding's own group, whose value *is* the scoped answer --
   * is deliberately left out of this change: it rewrites `limit`/`orderBy` semantics for every
   * caller and needs its own review.
   */
  async calculate(
    options: CloudflareObservabilityCalculationQuery,
  ): Promise<CloudflareObservabilityCalculationResult> {
    const result = await this.#query("calculations", options);
    return {
      calculations: parseCalculations(result.calculations),
      statistics: result.statistics,
    };
  }
}
