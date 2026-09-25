import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_V1_SLOTS,
  COMMON_SLOTS,
  encodeActivityPoints,
  recordActivity,
  type ActivityMetricInput,
} from "../src/metrics.js";

const ACTOR = "a".repeat(64);
const OWNER = "b".repeat(64);
const WORKSPACE = "c".repeat(64);
const OCCURRED_AT = 1_790_000_000_000;

const FULL: ActivityMetricInput = {
  eventType: "gadget.created",
  actorId: ACTOR,
  ownerId: OWNER,
  workspaceId: WORKSPACE,
  detail: "blank",
  gadgetId: 7,
  gadgetState: "pending",
};

// The WAE column a named slot occupies, read back out of an encoded point.
function column(point: AnalyticsEngineDataPoint, slot: string): unknown {
  const [, kind, n] = /^(blob|double)(\d+)$/.exec(slot)!;
  return (kind === "blob" ? point.blobs : point.doubles)![Number(n) - 1];
}

describe("activity/v1 schema", () => {
  it("assigns every field its own column", () => {
    const slots = Object.values({ ...COMMON_SLOTS, ...ACTIVITY_V1_SLOTS });
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe("encodeActivityPoints", () => {
  it("writes one point per scope, in the golden layout", () => {
    const points = encodeActivityPoints(FULL, OCCURRED_AT);
    expect(points.map(point => point.indexes)).toEqual([
      ["activity|fleet"],
      [`activity|actor|usr_${ACTOR}`],
      [`activity|owner|usr_${OWNER}`],
      [`activity|workspace|ws_${WORKSPACE}`],
    ]);
    expect(points[1]).toEqual({
      indexes: [`activity|actor|usr_${ACTOR}`],
      blobs: [
        "activity/v1", "gadget.created", "actor", `usr_${ACTOR}`, `usr_${OWNER}`,
        `ws_${WORKSPACE}`, "success", "blank", `ws_${WORKSPACE}/7`, "pending",
      ],
      doubles: [OCCURRED_AT, 0, 0],
    });
    for (const point of points) {
      expect(point.blobs!.length).toBeLessThanOrEqual(20);
      expect(new TextEncoder().encode(point.indexes![0] as string).length)
          .toBeLessThanOrEqual(96);
    }
  });

  it("places each named field at its declared slot", () => {
    const [point] = encodeActivityPoints(FULL, OCCURRED_AT);
    expect(column(point, COMMON_SLOTS.discriminator)).toBe("activity/v1");
    expect(column(point, COMMON_SLOTS.eventType)).toBe("gadget.created");
    expect(column(point, COMMON_SLOTS.scope)).toBe("fleet");
    expect(column(point, COMMON_SLOTS.actorId)).toBe(`usr_${ACTOR}`);
    expect(column(point, COMMON_SLOTS.ownerId)).toBe(`usr_${OWNER}`);
    expect(column(point, COMMON_SLOTS.workspaceId)).toBe(`ws_${WORKSPACE}`);
    expect(column(point, COMMON_SLOTS.outcome)).toBe("success");
    expect(column(point, COMMON_SLOTS.occurredAt)).toBe(OCCURRED_AT);
    expect(column(point, COMMON_SLOTS.durationMs)).toBe(0);
    expect(column(point, COMMON_SLOTS.present)).toBe(0);
    expect(column(point, ACTIVITY_V1_SLOTS.detail)).toBe("blank");
    expect(column(point, ACTIVITY_V1_SLOTS.gadgetRef)).toBe(`ws_${WORKSPACE}/7`);
    expect(column(point, ACTIVITY_V1_SLOTS.gadgetState)).toBe("pending");
  });

  it("omits the scopes of ids the event lacks, and blanks their columns", () => {
    const points = encodeActivityPoints(
        { eventType: "user.authenticated", actorId: ACTOR, detail: "password" }, OCCURRED_AT);
    expect(points.map(point => point.indexes![0])).toEqual([
      "activity|fleet", `activity|actor|usr_${ACTOR}`,
    ]);
    expect(points[0].blobs).toEqual([
      "activity/v1", "user.authenticated", "fleet", `usr_${ACTOR}`, "", "", "success",
      "password", "", "",
    ]);
  });

  it("writes only the fleet point for an anonymous event", () => {
    const points = encodeActivityPoints({ eventType: "connection.removed" }, OCCURRED_AT);
    expect(points.map(point => point.indexes![0])).toEqual(["activity|fleet"]);
  });

  it("leaves the gadget ref blank without a workspace to qualify it", () => {
    const [point] = encodeActivityPoints({ eventType: "gadget.created", gadgetId: 3 }, OCCURRED_AT);
    expect(column(point, ACTIVITY_V1_SLOTS.gadgetRef)).toBe("");
  });
});

describe("recordActivity", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset };
  afterEach(() => {
    delete ambient.METRICS;
    vi.restoreAllMocks();
  });

  it("writes every encoded point to the binding", () => {
    const writeDataPoint = vi.fn();
    ambient.METRICS = { writeDataPoint };
    recordActivity(FULL);
    expect(writeDataPoint.mock.calls.map(([point]) => point.indexes[0])).toEqual([
      "activity|fleet",
      `activity|actor|usr_${ACTOR}`,
      `activity|owner|usr_${OWNER}`,
      `activity|workspace|ws_${WORKSPACE}`,
    ]);
  });

  it("is a no-op without the binding", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordActivity(FULL);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs rather than throws when a write fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ambient.METRICS = { writeDataPoint: () => { throw new Error("dataset down"); } };
    expect(() => recordActivity(FULL)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "metrics.write.failed", eventType: FULL.eventType, error: "Error: dataset down",
    }));
  });
});
