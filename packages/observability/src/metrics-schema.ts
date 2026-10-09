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
