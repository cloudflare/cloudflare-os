// Derives indexed field names and values from telemetry events.
//
// Why this exists: Cloudflare's `/telemetry/keys` and `/telemetry/values` endpoints ignore the
// `filters` they are sent. That was verified against the live API — a `$metadata.service eq <other>`
// filter still returns this account's other services, and the same filter on `/telemetry/query`
// correctly returns nothing. So on a single-Worker binding those two endpoints cannot be constrained
// at the provider, and a naive discovery call would hand an agent every Worker's field values.
//
// Deriving from a service-filtered events sample is correct by construction: the events have already
// passed both the provider's filter and this module's own scope filter, so nothing another Worker
// emitted can appear in the result.

import type {
  CloudflareObservabilityEvent,
  CloudflareObservabilityKey,
  CloudflareObservabilityValue,
  CloudflareObservabilityValueType,
} from "./types.js";

type Primitive = string | number | boolean;

// How each container in the response envelope maps onto the name a field is actually *indexed* under.
// `$metadata` and `$workers` are addressed by their dotted path, but the caller's own structured log
// payload is not: Cloudflare indexes `console.log({event: "x"})` under the bare name `event` and only
// nests it beneath `source` when returning it. Verified against the live `/telemetry/keys`, which
// reports `event`/`component`/`level` and no `source.*` key at all, and documented under "Logging
// structured JSON objects" in
// https://developers.cloudflare.com/workers/observability/logs/workers-logs/.
//
// Discovery therefore has to report the filterable name, not the envelope path. Reporting
// `source.event` was a silent trap: the provider accepts an unknown key, matches nothing, and returns
// an empty page with no error, so an agent filtering on a field it had just discovered got zero
// results after scanning the whole timeframe.
const INDEXED_NAMESPACES: ReadonlyArray<{
  container: "$metadata" | "$workers" | "source";
  prefix: string;
}> = [
  { container: "$metadata", prefix: "$metadata" },
  { container: "$workers", prefix: "$workers" },
  { container: "source", prefix: "" },
];

// Bounds the walk of an arbitrarily deep user-authored `source` payload.
const MAX_FIELD_DEPTH = 6;

/** Joins a field path, treating an unprefixed namespace's empty prefix as no leading segment. */
function fieldPath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

function* scalarFields(value: unknown, path: string, depth: number): Generator<[string, Primitive]> {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    // An unprefixed namespace whose container is itself a scalar has no field name to report.
    if (path !== "") yield [path, value];
    return;
  }
  // Arrays are not indexed as scalar fields, so they are not walked.
  if (depth >= MAX_FIELD_DEPTH || !value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [name, child] of Object.entries(value)) {
    yield* scalarFields(child, fieldPath(path, name), depth + 1);
  }
}

/** Every indexed field name in one event, paired with its observed scalar value. */
function* eventFields(event: CloudflareObservabilityEvent): Generator<[string, Primitive]> {
  for (const { container, prefix } of INDEXED_NAMESPACES) {
    yield* scalarFields(event[container], prefix, 0);
  }
}

/** Indexed fields present in a sample, most recently observed first. */
export function deriveKeys(
  events: CloudflareObservabilityEvent[],
  limit?: number,
): CloudflareObservabilityKey[] {
  const keys = new Map<string, CloudflareObservabilityKey>();
  for (const event of events) {
    for (const [key, value] of eventFields(event)) {
      const existing = keys.get(key);
      if (existing) {
        existing.lastSeenAt = Math.max(existing.lastSeenAt ?? 0, event.timestamp);
      } else {
        keys.set(key, { key, type: typeof value as CloudflareObservabilityValueType, lastSeenAt: event.timestamp });
      }
    }
  }
  return [...keys.values()]
    .toSorted((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0))
    .slice(0, limit);
}

/** Distinct values observed at one indexed field within a sample. */
export function deriveValues(
  events: CloudflareObservabilityEvent[],
  key: string,
  type: CloudflareObservabilityValueType,
  limit?: number,
): CloudflareObservabilityValue[] {
  const values = new Map<Primitive, CloudflareObservabilityValue>();
  for (const event of events) {
    for (const [name, value] of eventFields(event)) {
      if (name !== key || typeof value !== type || values.has(value)) continue;
      values.set(value, { key, type, value, dataset: event.dataset });
    }
  }
  return [...values.values()].slice(0, limit);
}
