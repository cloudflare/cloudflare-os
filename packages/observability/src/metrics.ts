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
} from "./metrics-schema.js";

export * from "./metrics-schema.js";

/** Log fields owned by this module. */
type MetricsLogFields = { eventType?: ActivityEventType };

const logger = createLogger<MetricsLogFields>({ component: "observability.metrics" });

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional Workers Analytics Engine binding for the `gadgets_metrics_v1` dataset. */
      METRICS?: AnalyticsEngineDataset;
    }
  }
}

/**
 * One product activity event. Ids are the raw hex Durable Object ids; the encoder adds the
 * `usr_`/`ws_` prefixes. There is no outcome: activity is recorded only once the action succeeded.
 */
export type ActivityMetricInput = {
  eventType: ActivityEventType;
  /** The user who performed the action. */
  actorId?: string;
  /** The owner of the workspace the action concerns. */
  ownerId?: string;
  /** The workspace (Overseer Durable Object) the action concerns. */
  workspaceId?: string;
  /** Event-specific qualifier, e.g. the source of a creation or the kind of an interaction. */
  detail?: string;
  /** The gadget workpiece the action concerns, within `workspaceId`. */
  gadgetId?: number;
  /** Whether that gadget is still provisional to a chat. */
  gadgetState?: "pending" | "permanent";
};

/**
 * Encodes one activity event as its Analytics Engine points: always a `fleet` point, plus one
 * for each of the actor, owner, and workspace the event names. Columns the event leaves empty
 * are written as `""`, and reserved columns past the family's last one are not written at all.
 */
export function encodeActivityPoints(
    input: ActivityMetricInput, occurredAt: number): AnalyticsEngineDataPoint[] {
  const actorRef = input.actorId ? `usr_${input.actorId}` : undefined;
  const ownerRef = input.ownerId ? `usr_${input.ownerId}` : undefined;
  const workspaceRef = input.workspaceId ? `ws_${input.workspaceId}` : undefined;
  const gadgetRef = workspaceRef && input.gadgetId !== undefined
      ? `${workspaceRef}/${input.gadgetId}` : undefined;

  const scopes: [MetricScope, string | undefined][] = [
    ["fleet", undefined],
    ["actor", actorRef],
    ["owner", ownerRef],
    ["workspace", workspaceRef],
  ];
  return scopes
      .filter(([scope, ref]) => scope === "fleet" || ref !== undefined)
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
          [ACTIVITY_V1_SLOTS.gadgetState]: input.gadgetState,
        }, ""),
        doubles: columns<DoubleSlot, number>({
          [COMMON_SLOTS.occurredAt]: occurredAt,
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
    for (const point of encodeActivityPoints(input, Date.now())) {
      dataset.writeDataPoint(point);
    }
  } catch (error) {
    logger.warn("metric write failed",
      { event: "metrics.write.failed", eventType: input.eventType, error });
  }
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
