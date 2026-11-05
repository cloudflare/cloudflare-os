// The trust boundary between Cloudflare's Workers Observability JSON and everything downstream.
//
// This matters more than a normal response check: the Worker-scope security filter in
// `observability-api.ts` reads `$metadata.service` off these objects to decide what a single-Worker
// binding is allowed to see. An unvalidated shape would make that filter throw a raw `TypeError`
// out of a security check instead of producing the typed 502 the rest of the module returns, so
// every element is narrowed here before any caller — or any filter — touches it.

import type {
  CloudflareObservabilityAggregate,
  CloudflareObservabilityCalculationSeries,
  CloudflareObservabilityEvent,
  CloudflareObservabilityKey,
  CloudflareObservabilityStatistics,
  CloudflareObservabilityTraceSummary,
  CloudflareObservabilityValue,
  CloudflareObservabilityValueType,
} from "./types.js";

/**
 * A Workers Observability failure, carrying the status callers switch on.
 *
 * `message` may contain provider text, which is fine to return to the caller who caused it but must
 * not reach logs: Cloudflare can echo a caller-supplied filter value back in an error, and filter
 * values are deliberately kept out of the audit trail (see `summarizeFilter`). `codes` exists so a
 * failure can be logged precisely without logging the message, and `fromProvider` is what tells the
 * two apart -- the absence of codes does not, since Cloudflare may return a message with no code.
 */
export class CloudflareObservabilityApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Cloudflare's own numeric error codes, when the response carried any. */
    readonly codes: readonly number[] = [],
    /**
     * Whether `message` was authored by Cloudflare rather than by us. Only a provider-derived
     * message needs withholding from logs, so any new construction that copies provider text must
     * set this; our own messages are safe to log in full.
     */
    readonly fromProvider: boolean = false,
  ) {
    super(message);
  }
}

/** The provider returned something we refuse to interpret; never echoes the body. */
export function invalidResponse(): CloudflareObservabilityApiError {
  return new CloudflareObservabilityApiError(
    502, "Cloudflare returned an invalid Workers Observability response.",
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isValueType(value: unknown): value is CloudflareObservabilityValueType {
  return value === "string" || value === "number" || value === "boolean";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrow the `statistics` block every view returns, mapping provider snake_case to camelCase. */
export function parseStatistics(value: unknown): CloudflareObservabilityStatistics {
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

/**
 * Narrow one telemetry event, requiring the fields the scope filter, cursors, and discovery
 * derivation depend on: `dataset`, `timestamp`, `$metadata.id`, and a string-or-absent
 * `$metadata.service`.
 */
function parseEvent(value: unknown): CloudflareObservabilityEvent {
  if (!isRecord(value) || typeof value.dataset !== "string" || !isFiniteNumber(value.timestamp) ||
      !isRecord(value.$metadata) || typeof value.$metadata.id !== "string" ||
      (value.$metadata.service !== undefined && typeof value.$metadata.service !== "string")) {
    throw invalidResponse();
  }
  // Validated above. Metadata beyond the load-bearing fields travels through as the provider sent
  // it, so a field Cloudflare adds stays readable via the type's index signature.
  return value as CloudflareObservabilityEvent;
}

export function parseEvents(value: unknown): CloudflareObservabilityEvent[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(parseEvent);
}

/** Narrow the `{count?, events?}` container the events view wraps its page in. */
export function parseEventsContainer(
  value: unknown,
): { count?: number; events: CloudflareObservabilityEvent[] } {
  if (value === undefined) return { events: [] };
  if (!isRecord(value)) throw invalidResponse();
  return {
    count: isFiniteNumber(value.count) ? value.count : undefined,
    events: value.events === undefined ? [] : parseEvents(value.events),
  };
}

/** Narrow the `Record<requestId, events>` map the invocations view returns. */
export function parseInvocationsContainer(
  value: unknown,
): Array<{ requestId: string; events: CloudflareObservabilityEvent[] }> {
  if (value === undefined) return [];
  if (!isRecord(value) || Array.isArray(value)) throw invalidResponse();
  return Object.entries(value).map(([requestId, events]) => ({
    requestId,
    events: parseEvents(events),
  }));
}

export function parseKeys(value: unknown): CloudflareObservabilityKey[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isValueType(entry.type)) {
      throw invalidResponse();
    }
    return {
      key: entry.key,
      type: entry.type,
      lastSeenAt: isFiniteNumber(entry.lastSeenAt) ? entry.lastSeenAt : undefined,
    };
  });
}

export function parseValues(value: unknown): CloudflareObservabilityValue[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isValueType(entry.type) ||
        !isPrimitive(entry.value)) {
      throw invalidResponse();
    }
    return {
      key: entry.key,
      type: entry.type,
      value: entry.value,
      dataset: optionalString(entry.dataset),
    };
  });
}

/**
 * Narrow trace summaries and rename the provider's `service` array to `services`. A silent shape
 * change here would corrupt every summary, so the rename is validated rather than destructured.
 */
export function parseTraceSummaries(value: unknown): CloudflareObservabilityTraceSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.traceId !== "string" ||
        !Array.isArray(entry.service) || entry.service.some(name => typeof name !== "string") ||
        !isFiniteNumber(entry.traceStartMs) || !isFiniteNumber(entry.traceEndMs) ||
        !isFiniteNumber(entry.traceDurationMs) || !isFiniteNumber(entry.spans)) {
      throw invalidResponse();
    }
    return {
      traceId: entry.traceId,
      traceStartMs: entry.traceStartMs,
      traceEndMs: entry.traceEndMs,
      traceDurationMs: entry.traceDurationMs,
      rootSpanName: optionalString(entry.rootSpanName) ?? "",
      rootTransactionName: optionalString(entry.rootTransactionName) ?? "",
      services: entry.service as string[],
      spans: entry.spans,
      errors: Array.isArray(entry.errors)
        ? entry.errors.filter((error): error is string => typeof error === "string")
        : undefined,
    };
  });
}

/**
 * Narrow aggregate results.
 *
 * `aggregates` and `series` are declared non-optional, so a cast would hand the agent an object whose
 * type guarantees arrays that are not there -- turning a malformed provider response into a raw
 * `TypeError` inside gadget code instead of the typed 502 this module exists to produce. The numeric
 * leaves are checked for the same reason: `value`/`count` reach the agent as numbers it will format
 * and reason about.
 */
export function parseCalculations(value: unknown): CloudflareObservabilityCalculationSeries[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.calculation !== "string" ||
        !Array.isArray(entry.series)) {
      throw invalidResponse();
    }
    return {
      calculation: entry.calculation,
      alias: optionalString(entry.alias),
      aggregates: parseAggregates(entry.aggregates),
      series: entry.series.map(bucket => {
        if (!isRecord(bucket) || typeof bucket.time !== "string") throw invalidResponse();
        return { time: bucket.time, data: parseAggregates(bucket.data) };
      }),
    };
  });
}

function parseAggregates(value: unknown): CloudflareObservabilityAggregate[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || !isFiniteNumber(entry.value) || !isFiniteNumber(entry.count) ||
        !isFiniteNumber(entry.interval) || !isFiniteNumber(entry.sampleInterval)) {
      throw invalidResponse();
    }
    return {
      value: entry.value,
      count: entry.count,
      interval: entry.interval,
      sampleInterval: entry.sampleInterval,
      // Group identity, so it is validated rather than passed through: a Worker-scoped caller may
      // read it to tell which service an aggregate belongs to.
      groups: entry.groups === undefined ? undefined : parseAggregateGroups(entry.groups),
    };
  });
}

function parseAggregateGroups(
  value: unknown,
): NonNullable<CloudflareObservabilityAggregate["groups"]> {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isPrimitive(entry.value)) {
      throw invalidResponse();
    }
    return { key: entry.key, value: entry.value };
  });
}
