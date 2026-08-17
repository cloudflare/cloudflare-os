import type {
  CloudflareObservabilityCalculationQuery,
  CloudflareObservabilityCalculationResult,
  CloudflareObservabilityDiscoveryOptions,
  CloudflareObservabilityEvent,
  CloudflareObservabilityEventsPage,
  CloudflareObservabilityEventsQuery,
  CloudflareObservabilityFilter,
  CloudflareObservabilityInvocation,
  CloudflareObservabilityInvocationsPage,
  CloudflareObservabilityInvocationsQuery,
  CloudflareObservabilityKey,
  CloudflareObservabilityStatistics,
  CloudflareObservabilityTrace,
  CloudflareObservabilityTraceOptions,
  CloudflareObservabilityTracesPage,
  CloudflareObservabilityTracesQuery,
  CloudflareObservabilityTraceSummary,
  CloudflareObservabilityValue,
  CloudflareObservabilityValueType,
} from "./types.js";
import { obsContext } from "./observability.js";
import { VENDOR_ID } from "./vendor.js";
import { assertCloudflareAccountId } from "./resources.js";

export type ObservabilityFilter = CloudflareObservabilityFilter;

const MAX_CALLER_FILTER_DEPTH = 2;
const MAX_CALLER_FILTER_NODES = 100;

function validateFilterExpression(expression: ObservabilityFilter): void {
  const pending: Array<{ filter: ObservabilityFilter; depth: number }> = [{ filter: expression, depth: 0 }];
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
  if (expression) filters.push(expression);
  return filters;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const DATASETS = ["cloudflare-workers"];
const DEFAULT_TIMEFRAME_MS = 60 * 60 * 1000;
const MAX_TIMEFRAME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 2_000;
const TRACE_PAGE_SIZE = 100;
const MAX_TRACE_PAGES = 3;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.observability-api", vendorId: VENDOR_ID,
});

type RawStatistics = {
  elapsed: number;
  rows_read: number;
  bytes_read: number;
  abr_level?: number;
};

type RawQueryResult = {
  statistics: RawStatistics;
  events?: { count?: number; events?: CloudflareObservabilityEvent[] };
  invocations?: Record<string, CloudflareObservabilityEvent[]>;
  traces?: Array<Omit<CloudflareObservabilityTraceSummary, "services"> & { service: string[] }>;
  calculations?: CloudflareObservabilityCalculationResult["calculations"];
};

type QueryResult = Omit<RawQueryResult, "statistics"> & {
  statistics: CloudflareObservabilityStatistics;
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
  page: CloudflareObservabilityEventsPage;
  rawCount: number;
  rawCursor?: string;
  totalCount?: number;
};

export class CloudflareObservabilityApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

function statistics(value: unknown): CloudflareObservabilityStatistics {
  if (!isRecord(value) || !isFiniteNumber(value.elapsed) ||
      !isFiniteNumber(value.rows_read) || !isFiniteNumber(value.bytes_read) ||
      (value.abr_level !== undefined && !isFiniteNumber(value.abr_level))) {
    throw invalidResponse();
  }
  return {
    elapsed: value.elapsed,
    rowsRead: value.rows_read,
    bytesRead: value.bytes_read,
    abrLevel: value.abr_level,
  };
}

function validatedLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_RESULT_LIMIT)) {
    throw new Error(`The observability limit must be an integer from 1 to ${MAX_RESULT_LIMIT}.`);
  }
  return value;
}

function invalidResponse(): CloudflareObservabilityApiError {
  return new CloudflareObservabilityApiError(502, "Cloudflare returned an invalid Workers Observability response.");
}

function invalidResponseStatus(response: Response): number {
  return response.ok ? 502 : response.status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    if (messages.length > 0) return new CloudflareObservabilityApiError(status, messages.join("; "));
  }
  return new CloudflareObservabilityApiError(
    status,
    `Cloudflare API request failed with status ${status}.`,
  );
}

function retryDelay(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_DELAY_MS);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS)
    : 250;
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
        const error = timedOut
          ? new CloudflareObservabilityApiError(504, "Cloudflare Workers Observability request timed out.")
          : caught;
        const status = error instanceof CloudflareObservabilityApiError
          ? error.status
          : response?.status ?? 0;
        logger.warn("Workers Observability request failed", {
          event: "observability.request.failed", path, status, attempt, error,
        });
        if (attempt === 1 && (timedOut || (response && RETRYABLE_STATUSES.has(response.status)))) {
          await wait(timedOut || !response ? 250 : retryDelay(response));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unreachable Workers Observability retry state.");
  }

  #discoveryParameters(options?: CloudflareObservabilityDiscoveryOptions) {
    const filters = scopeObservabilityFilters(this.workerName, options?.filter);
    return {
      datasets: DATASETS,
      filters: filters.length === 0 ? [] : [{
        kind: "group" as const,
        filterCombination: "and" as const,
        filters,
      }],
      needle: options?.search,
    };
  }

  async #query(
    view: "events" | "invocations" | "traces" | "calculations",
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const limit = validatedLimit(options?.limit);
    const includeSeries = options?.includeSeries ?? options?.granularity !== undefined;
    const result = await this.#request("query", {
      queryId: `gadgets-${crypto.randomUUID()}`,
      view,
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
        needle: options?.search,
        calculations: options?.calculations,
        groupBys: options?.groupBys,
        orderBy: options?.orderBy,
        limit,
      },
    });
    if (!isRecord(result)) throw invalidResponse();
    return { ...(result as RawQueryResult), statistics: statistics(result.statistics) };
  }

  async listKeys(options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityKey[]> {
    const range = timeframe(options?.timeframe);
    const result = await this.#request("keys", {
      ...range,
      ...this.#discoveryParameters(options),
      limit: validatedLimit(options?.limit),
    });
    if (!Array.isArray(result)) throw invalidResponse();
    return result as CloudflareObservabilityKey[];
  }

  async listValues(
    key: string,
    type: CloudflareObservabilityValueType,
    options?: CloudflareObservabilityDiscoveryOptions,
  ): Promise<CloudflareObservabilityValue[]> {
    const result = await this.#request("values", {
      timeframe: timeframe(options?.timeframe),
      ...this.#discoveryParameters(options),
      key,
      type,
      limit: validatedLimit(options?.limit),
    });
    if (!Array.isArray(result)) throw invalidResponse();
    return result as CloudflareObservabilityValue[];
  }

  async #listEventsPage(options?: CloudflareObservabilityEventsQuery): Promise<EventsPageResult> {
    const result = await this.#query("events", options);
    if (result.events !== undefined &&
        (!isRecord(result.events) ||
         (result.events.events !== undefined && !Array.isArray(result.events.events)))) {
      throw invalidResponse();
    }
    const rawEvents = result.events?.events ?? [];
    const events = rawEvents.filter(event =>
      !this.workerName || event.$metadata.service === this.workerName);
    return {
      page: {
        events,
        count: this.workerName ? events.length : result.events?.count,
        nextCursor: events.at(-1)?.$metadata.id,
        statistics: result.statistics,
      },
      rawCount: rawEvents.length,
      rawCursor: rawEvents.at(-1)?.$metadata.id,
      totalCount: result.events?.count,
    };
  }

  async listEvents(options?: CloudflareObservabilityEventsQuery): Promise<CloudflareObservabilityEventsPage> {
    return (await this.#listEventsPage(options)).page;
  }

  async listInvocations(
    options?: CloudflareObservabilityInvocationsQuery,
  ): Promise<CloudflareObservabilityInvocationsPage> {
    const result = await this.#query("invocations", options);
    if (result.invocations !== undefined &&
        (!isRecord(result.invocations) || Array.isArray(result.invocations) ||
         Object.values(result.invocations).some(events => !Array.isArray(events)))) {
      throw invalidResponse();
    }
    const invocations: CloudflareObservabilityInvocation[] = Object.entries(result.invocations ?? {})
      .map(([requestId, events]) => ({
        requestId,
        events: events.filter(event => !this.workerName || event.$metadata.service === this.workerName),
      }))
      .filter(invocation => invocation.events.length > 0);
    return {
      invocations,
      nextCursor: invocations.at(-1)?.events.at(-1)?.$metadata.id,
      statistics: result.statistics,
    };
  }

  async listTraces(options?: CloudflareObservabilityTracesQuery): Promise<CloudflareObservabilityTracesPage> {
    if (this.workerName) {
      throw new Error("Trace summaries are available only from an account-scoped observability binding.");
    }
    const result = await this.#query("traces", options);
    if (result.traces !== undefined && !Array.isArray(result.traces)) throw invalidResponse();
    const traces = (result.traces ?? []).map(({ service, ...trace }) => ({
      ...trace,
      services: service,
    }));
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
    const events: CloudflareObservabilityEvent[] = [];
    let cursor: string | undefined;
    let truncated = false;
    let rawEventsRead = 0;
    let totalCount: number | undefined;
    let combinedStatistics: CloudflareObservabilityStatistics = {
      elapsed: 0, rowsRead: 0, bytesRead: 0,
    };
    for (let pageNumber = 0; pageNumber < MAX_TRACE_PAGES; pageNumber++) {
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
      combinedStatistics = {
        elapsed: combinedStatistics.elapsed + page.statistics.elapsed,
        rowsRead: combinedStatistics.rowsRead + page.statistics.rowsRead,
        bytesRead: combinedStatistics.bytesRead + page.statistics.bytesRead,
        abrLevel: page.statistics.abrLevel ?? combinedStatistics.abrLevel,
      };
      if (totalCount !== undefined && rawEventsRead >= totalCount) break;
      if (result.rawCount < TRACE_PAGE_SIZE || !result.rawCursor || result.rawCursor === cursor) break;
      cursor = result.rawCursor;
      if (pageNumber === MAX_TRACE_PAGES - 1) {
        truncated = totalCount === undefined || rawEventsRead < totalCount;
      }
    }
    if (events.length === 0) {
      throw new Error(`Trace ${traceId} was not found in the requested timeframe.`);
    }
    return { traceId, events, count: events.length, truncated, statistics: combinedStatistics };
  }

  async calculate(
    options: CloudflareObservabilityCalculationQuery,
  ): Promise<CloudflareObservabilityCalculationResult> {
    const result = await this.#query("calculations", options);
    if (result.calculations !== undefined && !Array.isArray(result.calculations)) {
      throw invalidResponse();
    }
    return {
      calculations: result.calculations ?? [],
      statistics: result.statistics,
    };
  }
}
