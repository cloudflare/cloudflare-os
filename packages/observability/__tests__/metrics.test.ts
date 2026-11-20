import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_V1_SLOTS,
  COMMON_SLOTS,
  encodeActivityPoints,
  encodeSubserviceCallPoint,
  UNATTRIBUTED_ACTOR,
  recordActivity,
  recordSubserviceCall,
  SUBSERVICE_V1_SLOTS,
  subserviceIndex,
  subserviceTally,
  type ActivityMetricInput,
  type SubserviceCallInput,
} from "../src/metrics.js";

const ACTOR = "a".repeat(64);
const OWNER = "b".repeat(64);
const WORKSPACE = "c".repeat(64);

const FULL: ActivityMetricInput = {
  eventType: "gadget.created",
  actorId: ACTOR,
  ownerId: OWNER,
  workspaceId: WORKSPACE,
  detail: "blueprint",
  gadgetId: 7,
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
    const points = encodeActivityPoints(FULL);
    expect(points.map(point => point.indexes)).toEqual([
      [`activity|actor|usr_${ACTOR}`],
      [`activity|owner|usr_${OWNER}`],
      [`activity|workspace|ws_${WORKSPACE}`],
    ]);
    expect(points[0]).toEqual({
      indexes: [`activity|actor|usr_${ACTOR}`],
      blobs: [
        "activity/v1", "gadget.created", "actor", `usr_${ACTOR}`, `usr_${OWNER}`,
        `ws_${WORKSPACE}`, "success", "blueprint", `ws_${WORKSPACE}/7`,
      ],
      doubles: [0, 0],
    });
    for (const point of points) {
      expect(point.blobs!.length).toBeLessThanOrEqual(20);
      expect(new TextEncoder().encode(point.indexes![0] as string).length)
          .toBeLessThanOrEqual(96);
    }
  });

  it("places each named field at its declared slot", () => {
    const [point] = encodeActivityPoints(FULL);
    expect(column(point, COMMON_SLOTS.discriminator)).toBe("activity/v1");
    expect(column(point, COMMON_SLOTS.eventType)).toBe("gadget.created");
    expect(column(point, COMMON_SLOTS.scope)).toBe("actor");
    expect(column(point, COMMON_SLOTS.actorId)).toBe(`usr_${ACTOR}`);
    expect(column(point, COMMON_SLOTS.ownerId)).toBe(`usr_${OWNER}`);
    expect(column(point, COMMON_SLOTS.workspaceId)).toBe(`ws_${WORKSPACE}`);
    expect(column(point, COMMON_SLOTS.outcome)).toBe("success");
    expect(column(point, COMMON_SLOTS.durationMs)).toBe(0);
    expect(column(point, COMMON_SLOTS.present)).toBe(0);
    expect(column(point, ACTIVITY_V1_SLOTS.detail)).toBe("blueprint");
    expect(column(point, ACTIVITY_V1_SLOTS.gadgetRef)).toBe(`ws_${WORKSPACE}/7`);
  });

  it("omits the scopes of ids the event lacks, and blanks their columns", () => {
    const points = encodeActivityPoints(
        { eventType: "user.authenticated", actorId: ACTOR, detail: "password" });
    expect(points.map(point => point.indexes![0])).toEqual([`activity|actor|usr_${ACTOR}`]);
    expect(points[0].blobs).toEqual([
      "activity/v1", "user.authenticated", "actor", `usr_${ACTOR}`, "", "", "success",
      "password", "",
    ]);
  });

  it("attributes an event with no actor to the unattributed sentinel", () => {
    const points = encodeActivityPoints(
        { eventType: "gadget.proposed", workspaceId: WORKSPACE, gadgetId: 2 });
    expect(points.map(point => point.indexes![0])).toEqual([
      `activity|actor|${UNATTRIBUTED_ACTOR}`, `activity|workspace|ws_${WORKSPACE}`,
    ]);
    expect(column(points[0], COMMON_SLOTS.actorId)).toBe(UNATTRIBUTED_ACTOR);
  });

  it("leaves the gadget ref blank without a workspace to qualify it", () => {
    const [point] = encodeActivityPoints({ eventType: "gadget.created", gadgetId: 3 });
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

const CALL: SubserviceCallInput = {
  source: "gatekeeper.google.api",
  service: "google-drive",
  operation: "files.get",
  outcome: "refused",
  reason: "rate",
  detail: "first",
  httpStatus: 429,
  providerCode: 8,
  durationMs: 120,
  calls: 3,
  bytes: 2048,
};

// One call with nothing optional given, for the tally to sum.
const BAND: SubserviceCallInput = {
  source: "gatekeeper.google.drive", service: "workers-ai", operation: "vision.band",
  outcome: "success",
};

describe("subservice/v1 schema", () => {
  it("assigns every field its own column", () => {
    const slots = [...Object.values(COMMON_SLOTS), ...Object.values(SUBSERVICE_V1_SLOTS)];
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("indexes a point by its service, operation and outcome, and gives their prefixes", () => {
    expect(subserviceIndex()).toBe("subservice");
    expect(subserviceIndex("google-drive")).toBe("subservice|google-drive");
    expect(subserviceIndex("google-drive", "files.get")).toBe("subservice|google-drive|files.get");
    expect(subserviceIndex("google-drive", "files.get", "refused"))
        .toBe("subservice|google-drive|files.get|refused");
  });
});

describe("encodeSubserviceCallPoint", () => {
  it("writes one unattributed actor point, in the golden layout", () => {
    expect(encodeSubserviceCallPoint(CALL)).toEqual({
      indexes: ["subservice|google-drive|files.get|refused"],
      blobs: [
        "subservice/v1", "call", "actor", "sys_unattributed", "", "", "refused",
        "gatekeeper.google.api", "google-drive", "files.get", "rate", "first",
      ],
      doubles: [120, 0, 429, 8, 3, 2048],
    });
  });

  it("places each named field at its declared slot", () => {
    const point = encodeSubserviceCallPoint(CALL);
    expect(column(point, COMMON_SLOTS.discriminator)).toBe("subservice/v1");
    expect(column(point, COMMON_SLOTS.eventType)).toBe("call");
    expect(column(point, COMMON_SLOTS.scope)).toBe("actor");
    expect(column(point, COMMON_SLOTS.actorId)).toBe(UNATTRIBUTED_ACTOR);
    expect(column(point, COMMON_SLOTS.ownerId)).toBe("");
    expect(column(point, COMMON_SLOTS.workspaceId)).toBe("");
    expect(column(point, COMMON_SLOTS.outcome)).toBe("refused");
    expect(column(point, COMMON_SLOTS.durationMs)).toBe(120);
    expect(column(point, COMMON_SLOTS.present)).toBe(0);
    expect(column(point, SUBSERVICE_V1_SLOTS.source)).toBe("gatekeeper.google.api");
    expect(column(point, SUBSERVICE_V1_SLOTS.service)).toBe("google-drive");
    expect(column(point, SUBSERVICE_V1_SLOTS.operation)).toBe("files.get");
    expect(column(point, SUBSERVICE_V1_SLOTS.reason)).toBe("rate");
    expect(column(point, SUBSERVICE_V1_SLOTS.detail)).toBe("first");
    expect(column(point, SUBSERVICE_V1_SLOTS.httpStatus)).toBe(429);
    expect(column(point, SUBSERVICE_V1_SLOTS.providerCode)).toBe(8);
    expect(column(point, SUBSERVICE_V1_SLOTS.calls)).toBe(3);
    expect(column(point, SUBSERVICE_V1_SLOTS.bytes)).toBe(2048);
  });

  it("counts one call, and blanks what the call leaves out", () => {
    expect(encodeSubserviceCallPoint({
      eventType: "release", source: "pdf-renderer", service: "pdf-renderer",
      operation: "document", outcome: "success", reason: "",
    })).toEqual({
      indexes: ["subservice|pdf-renderer|document|success"],
      blobs: [
        "subservice/v1", "release", "actor", "sys_unattributed", "", "", "success",
        "pdf-renderer", "pdf-renderer", "document", "", "",
      ],
      doubles: [0, 0, 0, 0, 1, 0],
    });
  });

  it("writes `invalid` for a string that is not a word", () => {
    const point = encodeSubserviceCallPoint({
      source: "https://www.googleapis.com/drive/v3/files/1aBcD",
      service: "the file could not be read",
      operation: "a".repeat(65),
      outcome: "error",
      reason: "someone@example.com",
      detail: "rate\n",
    });
    expect(point.indexes).toEqual(["subservice|invalid|invalid|error"]);
    expect(point.blobs!.slice(7)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);

    const edges = encodeSubserviceCallPoint(
        { source: "", service: ".hidden", operation: "a".repeat(64), outcome: "error" });
    expect(edges.blobs!.slice(7)).toEqual(["invalid", "invalid", "a".repeat(64), "", ""]);
  });

  it("indexes a point by its service alone when its kind would not fit an index", () => {
    const fits = encodeSubserviceCallPoint(
        { source: "s", service: "a".repeat(38), operation: "b".repeat(38), outcome: "refused" });
    expect(fits.indexes).toEqual([`subservice|${"a".repeat(38)}|${"b".repeat(38)}|refused`]);
    expect(fits.indexes![0]).toHaveLength(96);

    const long = encodeSubserviceCallPoint(
        { source: "s", service: "a".repeat(38), operation: "b".repeat(39), outcome: "refused" });
    expect(long.indexes).toEqual([`subservice|${"a".repeat(38)}`]);
    const longest = encodeSubserviceCallPoint(
        { source: "s", service: "a".repeat(64), operation: "b".repeat(64), outcome: "success" });
    expect(longest.indexes).toEqual([`subservice|${"a".repeat(64)}`]);
  });

  it("writes 0 for a number that is not a count", () => {
    const point = encodeSubserviceCallPoint({
      ...CALL, httpStatus: -1, providerCode: Number.NaN, durationMs: Number.POSITIVE_INFINITY,
      calls: -3, bytes: Number.NEGATIVE_INFINITY,
    });
    expect(point.doubles).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("writes `invalid` for an event type or an outcome outside its list", () => {
    const point = encodeSubserviceCallPoint({
      ...CALL,
      eventType: "https://www.googleapis.com/drive/v3/files/1aBcD" as never,
      outcome: "the file could not be read" as never,
    });
    expect(column(point, COMMON_SLOTS.eventType)).toBe("invalid");
    expect(column(point, COMMON_SLOTS.outcome)).toBe("invalid");

    const words = encodeSubserviceCallPoint(
        { ...CALL, eventType: "reopen" as never, outcome: "retried" as never });
    expect(column(words, COMMON_SLOTS.eventType)).toBe("invalid");
    expect(column(words, COMMON_SLOTS.outcome)).toBe("invalid");
  });
});

describe("subservice/v1 writes", () => {
  // The variable as a deployment's vars may spell it: a JSON `true` or `false` is no string.
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: unknown };
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.restoreAllMocks();
  });

  // Binds a dataset and returns the points written to it.
  function dataset(): AnalyticsEngineDataPoint[] {
    const points: AnalyticsEngineDataPoint[] = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    return points;
  }

  // Each way the family is off: whether the dataset is bound, and the variable. Before any test
  // that could log a failed write, since that is logged once a minute.
  it.each([
    [true, undefined], [true, ""], [true, "false"], [true, "1"], [true, "true-ish"], [true, false],
    [false, "true"],
  ])("writes and logs nothing with the binding %j and the variable %j", (bound, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const points = bound ? dataset() : [];
    if (value !== undefined) ambient.SUBSERVICE_METRICS = value;
    const tally = subserviceTally();
    tally.add(CALL);
    expect(() => recordSubserviceCall(CALL)).not.toThrow();
    expect(() => tally.flush()).not.toThrow();
    expect(points).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([" True ", true])("writes the encoded point when the variable is %j", value => {
    const points = dataset();
    ambient.SUBSERVICE_METRICS = value;
    recordSubserviceCall(CALL);
    expect(points).toEqual([encodeSubserviceCallPoint(CALL)]);
  });

  describe("subserviceTally", () => {
    it("writes nothing until its flush, then one point per sum", () => {
      const points = dataset();
      ambient.SUBSERVICE_METRICS = "true";
      const tally = subserviceTally();
      tally.add({ ...BAND, durationMs: 100, bytes: 10 });
      tally.add({ ...BAND, durationMs: 250, bytes: 30, calls: 2 });
      tally.add(CALL);
      tally.add({ ...BAND, durationMs: 1, bytes: 2 });
      expect(points).toEqual([]);
      tally.flush();
      expect(points).toEqual([
        encodeSubserviceCallPoint({ ...BAND, calls: 4, durationMs: 351, bytes: 42 }),
        encodeSubserviceCallPoint(CALL),
      ]);
    });

    it("sums apart the calls that differ in any column but the three it adds", () => {
      const points = dataset();
      ambient.SUBSERVICE_METRICS = "true";
      const kinds: SubserviceCallInput[] = [
        BAND,
        { ...BAND, eventType: "release" },
        { ...BAND, source: "gatekeeper.google.gmail" },
        { ...BAND, service: "pdf-renderer" },
        { ...BAND, operation: "vision.page" },
        { ...BAND, outcome: "error" },
        { ...BAND, reason: "rate" },
        { ...BAND, detail: "truncated" },
        { ...BAND, httpStatus: 429 },
        { ...BAND, providerCode: 3040 },
      ];
      const tally = subserviceTally();
      for (const kind of [...kinds, ...kinds]) tally.add(kind);
      tally.flush();
      expect(points).toEqual(kinds.map(kind => encodeSubserviceCallPoint({ ...kind, calls: 2 })));
    });

    it("is emptied by a flush, whether or not the flush wrote", () => {
      const points = dataset();
      const tally = subserviceTally();
      tally.add(BAND);
      tally.flush();
      ambient.SUBSERVICE_METRICS = "true";
      tally.flush();
      expect(points).toEqual([]);

      tally.add(BAND);
      tally.flush();
      tally.flush();
      expect(points).toEqual([encodeSubserviceCallPoint(BAND)]);
    });

    it("sums a call that would begin a 49th sum under the operation `other`", () => {
      const points = dataset();
      ambient.SUBSERVICE_METRICS = "true";
      const tally = subserviceTally();
      for (let n = 1; n <= 48; n++) tally.add({ ...BAND, operation: `op-${n}` });
      tally.add({
        ...BAND, operation: "op-49", outcome: "error", reason: "http", detail: "partway",
        httpStatus: 500, providerCode: 7, durationMs: 10, bytes: 1,
      });
      tally.add({
        ...BAND, operation: "op-50", outcome: "error", reason: "stream", httpStatus: 502,
        durationMs: 20, bytes: 2,
      });
      tally.add({ ...BAND, operation: "op-51" });
      tally.add({ ...BAND, operation: "op-1" });
      tally.flush();
      expect(points).toHaveLength(50);
      expect(points[0])
          .toEqual(encodeSubserviceCallPoint({ ...BAND, operation: "op-1", calls: 2 }));
      expect(points.slice(48)).toEqual([
        encodeSubserviceCallPoint({
          ...BAND, operation: "other", outcome: "error", calls: 2, durationMs: 30, bytes: 3,
        }),
        encodeSubserviceCallPoint({ ...BAND, operation: "other" }),
      ]);
    });

    it("drops a call it cannot sum, and never throws", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const points = dataset();
      ambient.SUBSERVICE_METRICS = "true";
      const tally = subserviceTally();
      tally.add(BAND);
      expect(() => tally.add(undefined as never)).not.toThrow();
      tally.flush();
      expect(points).toEqual([encodeSubserviceCallPoint(BAND)]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("logs a failing dataset once a minute, and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Past any failure this isolate has logged so far.
    const start = Date.now() + 120_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    ambient.METRICS = { writeDataPoint: () => { throw new Error("dataset down"); } };
    ambient.SUBSERVICE_METRICS = "true";

    expect(() => recordSubserviceCall(CALL)).not.toThrow();
    const tally = subserviceTally();
    tally.add(CALL);
    expect(() => tally.flush()).not.toThrow();
    expect(warn.mock.calls).toEqual([[expect.objectContaining({
      event: "metrics.write.failed", family: "subservice/v1", error: "Error: dataset down",
    })]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CALL.service);

    now.mockReturnValue(start + 59_999);
    recordSubserviceCall(CALL);
    expect(warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + 60_000);
    recordSubserviceCall(CALL);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
