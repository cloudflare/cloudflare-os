import { describe, expect, it } from "vite-plus/test";
import { formatCadence, formatOccurrences, formatTiming } from "./format";
import type { ManagementSchedule } from "../src/management-types";

const common = {
  scheduleId: "schedule-a",
  title: "Morning brief",
  description: "Prepare the morning brief.",
  workspaceId: "a".repeat(64),
};

describe("formatCadence", () => {
  it("describes interval, weekday, and one-shot schedules", () => {
    expect(formatCadence({ kind: "interval", everyMs: 3_600_000, anchorMs: 0 })).toBe("Every hour");
    expect(
      formatCadence({
        kind: "calendar",
        timeZone: "America/Chicago",
        rule: {
          freq: "weekly",
          interval: 1,
          byDay: ["MO", "TU", "WE", "TH", "FR"],
          hour: 8,
          minute: 0,
          anchorMs: 0,
        },
      }),
    ).toBe("Weekdays at 8:00 AM");
    expect(
      formatCadence({
        kind: "once",
        fireAt: Date.UTC(2026, 6, 30, 14),
        timeZone: "America/Chicago",
      }),
    ).toBe("Once on Jul 30, 2026 at 9:00 AM");
  });
});

describe("formatTiming", () => {
  it("uses bounded status copy and relative timestamps", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 2 * 3_600_000,
    };
    const dead: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "dead",
      failedAt: now - 60_000,
      failureCode: "authorization_failed",
    };

    expect(formatTiming(active, now).relative).toBe("Next run in 2 hours");
    expect(formatTiming(dead, now)).toMatchObject({
      relative: "Failed 1 minute ago",
      diagnostic: "Authorization failed after retries.",
    });
  });

  it("does not invent an absolute time while the next run is pending", () => {
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
    };

    expect(formatTiming(active, Date.UTC(2026, 6, 30, 12))).toEqual({
      relative: "Next run pending",
    });
  });

  it("marks a retry so it is not mistaken for a new occurrence", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const retrying: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 5 * 60_000,
      retrying: true,
    };

    expect(formatTiming(retrying, now).relative).toBe("Next run in 5 minutes (retry)");
  });
});

describe("formatOccurrences", () => {
  const hourly = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "active",
    nextFire: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("reports progress toward a counted bound", () => {
    expect(formatOccurrences({ ...hourly, occurrences: { count: 3 }, occurrenceCount: 1 }))
      .toBe("1 of 3 occurrences");
    expect(formatOccurrences({ ...hourly, occurrences: { count: 1 } }))
      .toBe("0 of 1 occurrence");
  });

  it("renders a time bound in the schedule's own timezone", () => {
    const until = Date.UTC(2026, 7, 3, 13);
    const calendar: ManagementSchedule = {
      ...hourly,
      cadence: {
        kind: "calendar",
        timeZone: "America/New_York",
        rule: { freq: "daily", interval: 1, hour: 9, minute: 0, anchorMs: 0 },
      },
      occurrences: { until },
    };

    // Rendered in the cadence's zone, not UTC: 13:00Z is 9am in New York.
    expect(formatOccurrences(calendar)).toContain("Aug 3, 2026");
    expect(formatOccurrences(calendar)).toContain("EDT");
  });

  it("omits a bound the schedule does not have", () => {
    expect(formatOccurrences(hourly)).toBeUndefined();
  });
});

describe("formatTiming terminal copy", () => {
  const base = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "completed",
    completedAt: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("distinguishes a used bound from a delivered one-shot", () => {
    expect(formatTiming({ ...base, occurrences: { count: 2 } }, 0).diagnostic)
      .toBe("This recurring task used its last scheduled occurrence.");
    expect(
      formatTiming(
        { ...base, cadence: { kind: "once", fireAt: 0, timeZone: "UTC" } },
        0,
      ).diagnostic,
    ).toBe("This one-time task completed.");
  });

  it("explains a recurrence that expired before its first occurrence", () => {
    const expired = { ...base, status: "expired", expiredAt: 0 } as ManagementSchedule;

    expect(formatTiming(expired, 0).diagnostic)
      .toBe("This recurring task's cutoff passed before its first occurrence.");
  });
});
