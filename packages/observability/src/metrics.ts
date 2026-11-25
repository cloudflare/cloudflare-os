import { env } from "cloudflare:workers";
import { createLogger } from "./logger.js";
import {
  ACTIVITY_V1_DISCRIMINATOR,
  ACTIVITY_V1_SLOTS,
  COMMON_SLOTS,
  activityIndex,
  type ActivityEventType,
  type BlobSlot,
  type DoubleSlot,
  type MetricScope,
  SUBSERVICE_EVENT_TYPES,
  SUBSERVICE_OUTCOMES,
  SUBSERVICE_V1_DISCRIMINATOR,
  SUBSERVICE_V1_SLOTS,
  subserviceIndex,
  type SubserviceEventType,
  type SubserviceOutcome,
  UNATTRIBUTED_ACTOR,
} from "./metrics-schema.js";

export * from "./metrics-schema.js";

/** Log fields owned by this module. */
type MetricsLogFields = { eventType?: ActivityEventType; family?: string };

const logger = createLogger<MetricsLogFields>({ component: "observability.metrics" });

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional Workers Analytics Engine binding for the `gadgets_metrics_v1` dataset. */
      METRICS?: AnalyticsEngineDataset;
      /**
       * `true` (trimmed, any case) to record subservice calls to `METRICS`. Anything else, or
       * unset, records none.
       */
      SUBSERVICE_METRICS?: string;
    }
  }
}

/**
 * One product activity event. Ids are the raw hex Durable Object ids; the encoder adds the
 * `usr_`/`ws_` prefixes. There is no outcome: activity is recorded only once the action succeeded.
 */
export type ActivityMetricInput = {
  eventType: ActivityEventType;
  /** The user who performed the action. Without one, the event's actor is `UNATTRIBUTED_ACTOR`. */
  actorId?: string;
  /** The owner of the workspace the action concerns. */
  ownerId?: string;
  /** The workspace (Overseer Durable Object) the action concerns. */
  workspaceId?: string;
  /** Event-specific qualifier, e.g. the source of a creation or the kind of an interaction. */
  detail?: string;
  /** The gadget workpiece the action concerns, within `workspaceId`. */
  gadgetId?: number;
};

/**
 * Encodes one activity event as its Analytics Engine points: always the canonical `actor` point,
 * plus one for each of the owner and workspace the event names. Columns the event leaves empty
 * are written as `""`, and reserved columns past the family's last one are not written at all.
 */
export function encodeActivityPoints(input: ActivityMetricInput): AnalyticsEngineDataPoint[] {
  const actorRef = input.actorId ? `usr_${input.actorId}` : UNATTRIBUTED_ACTOR;
  const ownerRef = input.ownerId ? `usr_${input.ownerId}` : undefined;
  const workspaceRef = input.workspaceId ? `ws_${input.workspaceId}` : undefined;
  const gadgetRef = workspaceRef && input.gadgetId !== undefined
      ? `${workspaceRef}/${input.gadgetId}` : undefined;

  const scopes: [MetricScope, string | undefined][] = [
    ["actor", actorRef],
    ["owner", ownerRef],
    ["workspace", workspaceRef],
  ];
  return scopes
      .filter(([, ref]) => ref !== undefined)
      .map(([scope, ref]) => ({
        indexes: [activityIndex(scope, ref)],
        blobs: columns<BlobSlot, string>({
          [COMMON_SLOTS.discriminator]: ACTIVITY_V1_DISCRIMINATOR,
          [COMMON_SLOTS.eventType]: input.eventType,
          [COMMON_SLOTS.scope]: scope,
          [COMMON_SLOTS.actorId]: actorRef,
          [COMMON_SLOTS.ownerId]: ownerRef,
          [COMMON_SLOTS.workspaceId]: workspaceRef,
          [COMMON_SLOTS.outcome]: "success",
          [ACTIVITY_V1_SLOTS.detail]: input.detail,
          [ACTIVITY_V1_SLOTS.gadgetRef]: gadgetRef,
        }, ""),
        doubles: columns<DoubleSlot, number>({
          [COMMON_SLOTS.durationMs]: 0,
          [COMMON_SLOTS.present]: 0,
        }, 0),
      }));
}

/**
 * Records one activity event to the `METRICS` Analytics Engine dataset. A no-op when the binding
 * is absent (local dev, self-hosted deployments). Writes are synchronous and fire-and-forget, so
 * there is nothing to `waitUntil`, and a failure is logged rather than surfaced to the caller.
 */
export function recordActivity(input: ActivityMetricInput): void {
  try {
    const dataset = env.METRICS;
    if (!dataset) return;
    for (const point of encodeActivityPoints(input)) {
      dataset.writeDataPoint(point);
    }
  } catch (error) {
    logger.warn("metric write failed",
      { event: "metrics.write.failed", eventType: input.eventType, error });
  }
}

/**
 * One call to a service behind the deployment, or `calls` identical ones. Every string is a
 * closed word: a literal in the calling code or a value from a closed table, never a name, an id,
 * a URL or an error's message.
 */
export type SubserviceCallInput = {
  /** `call` unless given. */
  eventType?: SubserviceEventType;
  /** The recording logger's `component`. */
  source: string;
  /** The service called. */
  service: string;
  /** What was asked of it. */
  operation: string;
  /** How the call ended. */
  outcome: SubserviceOutcome;
  /** Why it did not succeed. */
  reason?: string;
  /** The operation's own qualifier. */
  detail?: string;
  /** The HTTP status answered, when there is one. */
  httpStatus?: number;
  /** The service's numeric error code, when there is one. */
  providerCode?: number;
  /** Milliseconds the call took, summed over `calls`. */
  durationMs?: number;
  /** How many identical calls this stands for. 1 unless given. */
  calls?: number;
  /** Payload bytes sent, summed over `calls`. */
  bytes?: number;
};

/**
 * Encodes one subservice call as its Analytics Engine point: the canonical `actor` point alone,
 * under `UNATTRIBUTED_ACTOR`, since a service call is recorded where no user or workspace is
 * known, indexed by its kind (see `subserviceIndex`). A `source`, `service`, `operation`, `reason` or `detail` that is not a word, and an
 * `eventType` or `outcome` its list does not have, is written as `invalid`, and a number that is
 * not a count as 0, so that a caller's mistake puts no URL, sentence or message in the dataset.
 */
export function encodeSubserviceCallPoint(input: SubserviceCallInput): AnalyticsEngineDataPoint {
  const call = written(input);
  const outcome = listed(SUBSERVICE_OUTCOMES, call.outcome);
  // An index holds 96 bytes. The words in use come to far less; three of the longest a word may
  // be would not, and such a point is indexed by its service alone.
  const kind = subserviceIndex(call.service, call.operation, outcome);
  return {
    indexes: [kind.length <= MAX_INDEX_BYTES ? kind : subserviceIndex(call.service)],
    blobs: columns<BlobSlot, string>({
      [COMMON_SLOTS.discriminator]: SUBSERVICE_V1_DISCRIMINATOR,
      [COMMON_SLOTS.eventType]: listed(SUBSERVICE_EVENT_TYPES, call.eventType),
      [COMMON_SLOTS.scope]: "actor",
      [COMMON_SLOTS.actorId]: UNATTRIBUTED_ACTOR,
      [COMMON_SLOTS.outcome]: outcome,
      [SUBSERVICE_V1_SLOTS.source]: call.source,
      [SUBSERVICE_V1_SLOTS.service]: call.service,
      [SUBSERVICE_V1_SLOTS.operation]: call.operation,
      [SUBSERVICE_V1_SLOTS.reason]: call.reason,
      [SUBSERVICE_V1_SLOTS.detail]: call.detail,
    }, ""),
    doubles: columns<DoubleSlot, number>({
      [COMMON_SLOTS.durationMs]: call.durationMs,
      [COMMON_SLOTS.present]: 0,
      [SUBSERVICE_V1_SLOTS.httpStatus]: call.httpStatus,
      [SUBSERVICE_V1_SLOTS.providerCode]: call.providerCode,
      [SUBSERVICE_V1_SLOTS.calls]: call.calls,
      [SUBSERVICE_V1_SLOTS.bytes]: call.bytes,
    }, 0),
  };
}

/**
 * Records one subservice call to the `METRICS` Analytics Engine dataset. A no-op unless the
 * binding is present and `SUBSERVICE_METRICS` is `true`. Like `recordActivity`, the write is
 * synchronous and fire-and-forget, and a failure is logged rather than surfaced to the caller.
 */
export function recordSubserviceCall(input: SubserviceCallInput): void {
  try {
    subserviceDataset()?.writeDataPoint(encodeSubserviceCallPoint(input));
  } catch (error) {
    logSubserviceWriteFailed(error);
  }
}

/** Subservice calls summed in memory, to be written as one point per kind of call. */
export type SubserviceTally = {
  /** Adds a call to the sum of the calls like it. Writes nothing, and never throws. */
  add(input: SubserviceCallInput): void;
  /** Writes one point per sum, as `recordSubserviceCall` would, and empties the tally. */
  flush(): void;
};

// Analytics Engine takes at most 250 data points from one invocation.
const MAX_TALLY_SUMS = 48;

// Analytics Engine takes an index of at most 96 bytes. A word is ASCII, so its length is its bytes.
const MAX_INDEX_BYTES = 96;

/**
 * Starts a tally, for work that makes more calls than one invocation may write points. Calls that
 * agree in every string column, `eventType`, `outcome`, `httpStatus` and `providerCode` are one
 * sum of their `calls`, `durationMs` and `bytes`. A tally begins at most 48 such sums: a call
 * that would begin another is summed by `source`, `service`, `eventType` and `outcome` alone,
 * under the operation `other`. So what a service answers cannot take a flush past the limit: past
 * the 48, a flush grows only with the sources and services its callers name.
 */
export function subserviceTally(): SubserviceTally {
  const sums = new Map<string, Required<SubserviceCallInput>>();
  return {
    add(input) {
      try {
        const given = written(input);
        const call = sums.has(tallyKey(given)) || sums.size < MAX_TALLY_SUMS ? given : {
          ...given, operation: "other", reason: "", detail: "", httpStatus: 0, providerCode: 0,
        };
        const key = tallyKey(call);
        const sum = sums.get(key);
        if (!sum) {
          sums.set(key, call);
          return;
        }
        sum.calls += call.calls;
        sum.durationMs += call.durationMs;
        sum.bytes += call.bytes;
      } catch {
        // Nothing the types allow gets here. The call is left uncounted rather than failed, and
        // nothing is logged, since the family may be off.
      }
    },
    flush() {
      const calls = [...sums.values()];
      sums.clear();
      try {
        const dataset = subserviceDataset();
        if (!dataset) return;
        for (const call of calls) dataset.writeDataPoint(encodeSubserviceCallPoint(call));
      } catch (error) {
        logSubserviceWriteFailed(error);
      }
    },
  };
}

// The dataset subservice calls are written to, read anew each time: undefined unless the
// deployment has both bound it and turned the family on. `String`, because a deployment's vars
// may spell the variable as a JSON `true` or `false`, which is no string.
function subserviceDataset(): AnalyticsEngineDataset | undefined {
  const dataset = env.METRICS;
  return dataset && String(env.SUBSERVICE_METRICS).trim().toLowerCase() === "true"
      ? dataset : undefined;
}

// When this isolate last logged a failed subservice write. A dataset that refuses one write
// refuses the thousands that follow, so the failure is logged at most once a minute.
let subserviceFailureLoggedAt = Number.NEGATIVE_INFINITY;

function logSubserviceWriteFailed(error: unknown): void {
  const now = Date.now();
  if (now - subserviceFailureLoggedAt < 60_000) return;
  subserviceFailureLoggedAt = now;
  logger.warn("metric write failed",
    { event: "metrics.write.failed", family: SUBSERVICE_V1_DISCRIMINATOR, error });
}

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A string column's value: the word given, or `invalid` for anything that is not one.
function word(value: string): string {
  return typeof value === "string" && WORD.test(value) ? value : "invalid";
}

// A closed column's value: the one given, or `invalid` for anything its list does not have.
function listed(list: readonly string[], value: string): string {
  return list.includes(value) ? value : "invalid";
}

// A numeric column's value: the count given, or 0 for anything that is not one.
function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

// A call as it is written: every default filled in, every word and count checked. Writing the
// result again changes nothing, which is what lets a tally keep its sums in this form.
function written(input: SubserviceCallInput): Required<SubserviceCallInput> {
  return {
    eventType: input.eventType ?? "call",
    source: word(input.source),
    service: word(input.service),
    operation: word(input.operation),
    outcome: input.outcome,
    reason: input.reason ? word(input.reason) : "",
    detail: input.detail ? word(input.detail) : "",
    httpStatus: count(input.httpStatus),
    providerCode: count(input.providerCode),
    durationMs: count(input.durationMs),
    calls: input.calls === undefined ? 1 : count(input.calls),
    bytes: count(input.bytes),
  };
}

// The columns a tally sums by.
function tallyKey(call: Required<SubserviceCallInput>): string {
  return JSON.stringify([
    call.eventType, call.source, call.service, call.operation, call.outcome, call.reason,
    call.detail, call.httpStatus, call.providerCode,
  ]);
}

// Lays named slots out positionally (`blob3` is index 2), filling gaps up to the last set slot.
function columns<S extends BlobSlot | DoubleSlot, V>(
    values: Partial<Record<S, V | undefined>>, empty: V): V[] {
  const out: V[] = [];
  for (const [slot, value] of Object.entries(values) as [S, V | undefined][]) {
    out[Number(slot.replace(/^\D+/, "")) - 1] = value ?? empty;
  }
  return Array.from(out, value => value ?? empty);
}
