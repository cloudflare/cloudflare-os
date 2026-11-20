// The column layout of the Gadgets metrics dataset. Deliberately import-free (not even
// `cloudflare:workers`), so dashboards-as-code can resolve column names from this file rather
// than hardcoding `blobN`/`doubleN`.

/** Name of the Workers Analytics Engine dataset every Gadgets metric point is written to. */
export const METRIC_DATASET = "gadgets_metrics_v1";

type SlotNumber =
    1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

/** A Workers Analytics Engine string column. */
export type BlobSlot = `blob${SlotNumber}`;

/** A Workers Analytics Engine numeric column. */
export type DoubleSlot = `double${SlotNumber}`;

/**
 * Columns shared by every metric family. blob1 discriminates the family and its version, so
 * families can share one dataset and still be decoded unambiguously.
 */
export const COMMON_SLOTS = {
  discriminator: "blob1",
  eventType: "blob2",
  scope: "blob3",
  actorId: "blob4",
  ownerId: "blob5",
  workspaceId: "blob6",
  outcome: "blob7",
  durationMs: "double1",
  present: "double2",
} as const satisfies Record<string, BlobSlot | DoubleSlot>;

/** Family-specific columns of `activity/v1`, after the common ones. blob10..20 are reserved. */
export const ACTIVITY_V1_SLOTS = {
  detail: "blob8",
  gadgetRef: "blob9",
} as const satisfies Record<string, BlobSlot>;

/** The blob1 value of every `activity/v1` point. */
export const ACTIVITY_V1_DISCRIMINATOR = "activity/v1";

/** Every event type an `activity/v1` point can carry in its `eventType` column. */
export const ACTIVITY_EVENT_TYPES = [
  "account.created",
  "user.authenticated",
  "workspace.created",
  "workspace.opened",
  "workspace.deleted",
  "workspace.interaction",
  "gadget.created",
  "gadget.proposed",
  "connection.created",
  "connection.removed",
  "blueprint.created",
  "blueprint.imported",
] as const;

/** A product activity event recorded as `activity/v1`. */
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * The entities an event is copied to, one point each. The actor copy is canonical: every event
 * has exactly one, so count events there. The owner and workspace copies exist only so
 * per-entity queries (one workspace's history) read their own index.
 */
export const METRIC_SCOPES = ["actor", "owner", "workspace"] as const;

/** The entity a metric point is indexed under. */
export type MetricScope = (typeof METRIC_SCOPES)[number];

/**
 * The actor ref of an event no user performed, so that it still has its canonical actor copy.
 * Exclude it from distinct-user counts.
 */
export const UNATTRIBUTED_ACTOR = "sys_unattributed";

/**
 * The index of an `activity/v1` point: `activity|<scope>|<entityRef>`. Omit `entityRef` to get
 * the prefix shared by a scope's points.
 */
export function activityIndex(scope: MetricScope, entityRef?: string): string {
  return entityRef === undefined ? `activity|${scope}` : `activity|${scope}|${entityRef}`;
}

/**
 * Family-specific columns of `subservice/v1`, after the common ones: the calls a deployment makes
 * to the services behind it. Every string column holds a closed word, never anything of a user's.
 */
export const SUBSERVICE_V1_SLOTS = {
  /** The recording logger's `component`. */
  source: "blob8",
  /** The service called, from a closed set. */
  service: "blob9",
  /** What was asked of it, a literal. */
  operation: "blob10",
  /** A closed word for why it did not succeed, or `""`. */
  reason: "blob11",
  /** An operation's own qualifier, or `""`. */
  detail: "blob12",
  /** 0 when there is none. */
  httpStatus: "double3",
  /** The service's numeric error code, 0 when there is none. */
  providerCode: "double4",
  /** How many identical calls the point stands for. */
  calls: "double5",
  /** Payload bytes sent, summed over `calls`. */
  bytes: "double6",
} as const satisfies Record<string, BlobSlot | DoubleSlot>;

/** The blob1 value of every `subservice/v1` point. */
export const SUBSERVICE_V1_DISCRIMINATOR = "subservice/v1";

/** Every event type a `subservice/v1` point can carry in its `eventType` column. */
export const SUBSERVICE_EVENT_TYPES = ["call", "release"] as const;

/** What a `subservice/v1` point counts: a call made, or something a service held being let go. */
export type SubserviceEventType = (typeof SUBSERVICE_EVENT_TYPES)[number];

/** Every outcome of a `subservice/v1` point. `refused` is declined for rate or capacity. */
export const SUBSERVICE_OUTCOMES = ["success", "refused", "error"] as const;

/** How a call recorded as `subservice/v1` ended. */
export type SubserviceOutcome = (typeof SUBSERVICE_OUTCOMES)[number];

/**
 * The index of a `subservice/v1` point: `subservice|<service>|<operation>|<outcome>`, or as much
 * of it as is given, which is the prefix shared by those points. Analytics Engine samples rows
 * by index, so each kind of call has an index of its own: a rare kind (a PDF opened again) is
 * then not sampled away among a frequent one of the same service.
 */
export function subserviceIndex(service?: string, operation?: string, outcome?: string): string {
  let index = "subservice";
  for (const part of [service, operation, outcome]) {
    if (part === undefined) break;
    index += `|${part}`;
  }
  return index;
}
