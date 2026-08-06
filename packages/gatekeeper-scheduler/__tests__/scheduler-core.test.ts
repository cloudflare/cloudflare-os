import { describe, expect, it } from "vite-plus/test";
import {
  initialNextFire,
  normalizeCalendarRule,
  normalizeInterval,
  normalizeOneShot,
  normalizeRecurringScheduleOptions,
  normalizeScheduleOptions,
  nextFireAfter,
} from "../src/scheduler-core.js";
import type { ScheduleSpec } from "../src/schedule-types.js";
import type { RecurringScheduleOptions } from "../src/types.js";

const ms = (iso: string) => Date.parse(iso);
const MAX_DATE_MS = 8_640_000_000_000_000;

describe("schedule input validation", () => {
  it("trims valid presentation metadata", () => {
    expect(
      normalizeScheduleOptions({ title: "  Daily brief  ", description: "  Send it  " }),
    ).toEqual({ title: "Daily brief", description: "Send it" });
  });

  it("normalizes recurring occurrence limits", () => {
    const options = { title: "Brief", description: "Send it" };

    expect(
      normalizeRecurringScheduleOptions(
        { ...options, occurrences: { count: 3 } },
        normalizeInterval(3_600_000, 0),
        0,
      ),
    ).toEqual({ ...options, occurrences: { count: 3 } });

    const registeredAt = ms("2026-08-02T00:00:00Z");
    expect(
      normalizeRecurringScheduleOptions(
        {
          ...options,
          occurrences: {
            until: { timeZone: "America/New_York", year: 2026, month: 8, day: 3, hour: 9, minute: 0 },
          },
        },
        normalizeCalendarRule(
          { timeZone: "America/New_York", freq: "daily", hour: 8, minute: 0 },
          registeredAt,
        ),
        registeredAt,
      ),
    ).toEqual({ ...options, occurrences: { until: ms("2026-08-03T13:00:00Z") } });
  });

  it("rejects invalid recurring occurrence limits", () => {
    const options = { title: "Brief", description: "Send it" };
    const hourly = normalizeInterval(3_600_000, 0);
    const bound = (occurrences: unknown) =>
      normalizeRecurringScheduleOptions(
        { ...options, occurrences } as RecurringScheduleOptions,
        hourly,
        0,
      );

    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bound({ count })).toThrow("positive safe integer");
    }
    for (const shape of [{}, [], 5, "x", null, { until: undefined }]) {
      expect(() => bound(shape)).toThrow(TypeError);
    }
    expect(() => bound({ count: 3, until: 1_000 })).toThrow("not both");
    // A cutoff before the first occurrence would enable a schedule that can never run.
    expect(() => bound({ until: 1_000 })).toThrow("precedes the first occurrence");
  });

  it.each(["line\nbreak", "null\0byte", "delete\u007fbyte", "control\u0085byte"])(
    "rejects control characters in schedule titles",
    (title) => {
      expect(() => normalizeScheduleOptions({ title, description: "valid" })).toThrow("control");
    },
  );

  it("allows Markdown and newlines in schedule descriptions", () => {
    expect(
      normalizeScheduleOptions({
        title: "Daily brief",
        description: "## Summary\n\n- First item\n- Second item",
      }),
    ).toEqual({
      title: "Daily brief",
      description: "## Summary\n\n- First item\n- Second item",
    });
  });

  it.each([
    [{ title: "", description: "valid" }, "title"],
    [{ title: "x".repeat(201), description: "valid" }, "200"],
    [{ title: "valid", description: "  " }, "description"],
    [{ title: "valid", description: "x".repeat(2_001) }, "2000"],
  ])("rejects invalid presentation metadata", (options, message) => {
    expect(() => normalizeScheduleOptions(options)).toThrow(message);
  });

  it("requires at least a sixty-second elapsed interval", () => {
    expect(() => normalizeInterval(59_999, 0)).toThrow("60000");
    expect(normalizeInterval(60_000, 0)).toEqual({
      kind: "interval",
      everyMs: 60_000,
      anchorMs: 0,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite schedule input %s",
    (value) => {
      expect(() => normalizeInterval(value, 0)).toThrow("safe integer");
      expect(() => normalizeOneShot(value, 0)).toThrow("safe integer");
    },
  );

  it("requires an explicit actionable IANA timezone", () => {
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "",
          freq: "daily",
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("Ask the user");
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "Not/A_Zone",
          freq: "daily",
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("IANA timezone");
  });

  it("bounds timezone length and the public weekday array before deduplication", () => {
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "x".repeat(129),
          freq: "daily",
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("128");
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "UTC",
          freq: "weekly",
          byDay: ["MO", "MO", "MO", "MO", "MO", "MO", "MO", "MO"],
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("7");
  });

  it("validates frequency-specific fields", () => {
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "UTC",
          freq: "hourly",
          hour: 1,
          minute: 0,
        },
        0,
      ),
    ).toThrow("hour");
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "UTC",
          freq: "daily",
          minute: 0,
        },
        0,
      ),
    ).toThrow("hour");
    expect(() =>
      normalizeCalendarRule(
        {
          timeZone: "UTC",
          freq: "weekly",
          byDay: [],
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("weekday");
  });

  it.each([
    { freq: "hourly" as const, minute: 0 },
    { freq: "daily" as const, hour: 9, minute: 0 },
    { freq: "weekly" as const, byDay: ["MO" as const], hour: 9, minute: 0 },
  ])("rejects an unrepresentable $freq calendar interval", (rule) => {
    expect(() =>
      normalizeCalendarRule(
        { ...rule, timeZone: "UTC", interval: Number.MAX_SAFE_INTEGER },
        ms("2026-01-01T00:00:00Z"),
      ),
    ).toThrow();
  });
});

describe("elapsed recurrence", () => {
  it("preserves registration phase and is strictly after the threshold", () => {
    const spec = normalizeInterval(60_000, 15_000);
    expect(nextFireAfter(spec, 15_000)).toBe(75_000);
    expect(nextFireAfter(spec, 74_999)).toBe(75_000);
    expect(nextFireAfter(spec, 75_000)).toBe(135_000);
  });

  it("returns the anchor when the threshold precedes registration", () => {
    expect(nextFireAfter(normalizeInterval(60_000, 60_000), 0)).toBe(60_000);
  });

  it("rejects timestamps and results outside the supported range", () => {
    expect(() => normalizeInterval(60_000, -1)).toThrow("timestamp");
    expect(() => nextFireAfter(normalizeInterval(60_000, MAX_DATE_MS), MAX_DATE_MS)).toThrow();
  });
});

describe("calendar recurrence", () => {
  it("alternates Sunday and Wednesday across phase-aligned weeks", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "weekly",
        byDay: ["SU", "WE"],
        hour: 9,
        minute: 0,
      },
      ms("2026-01-04T08:00:00Z"),
    );

    const sunday = nextFireAfter(spec, ms("2026-01-04T08:00:00Z"));
    const wednesday = nextFireAfter(spec, sunday!);
    const nextSunday = nextFireAfter(spec, wednesday!);

    expect([sunday, wednesday, nextSunday]).toEqual([
      ms("2026-01-04T09:00:00Z"),
      ms("2026-01-07T09:00:00Z"),
      ms("2026-01-11T09:00:00Z"),
    ]);
  });

  it("selects Monday at a Monday-morning threshold before Sunday", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "weekly",
        byDay: ["SU", "MO"],
        hour: 9,
        minute: 0,
      },
      ms("2026-01-04T08:00:00Z"),
    );

    expect(nextFireAfter(spec, ms("2026-01-05T08:00:00Z"))).toBe(ms("2026-01-05T09:00:00Z"));
  });

  it("preserves hourly registration phase", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "hourly",
        interval: 2,
        minute: 15,
      },
      ms("2026-01-01T10:45:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-01-01T10:45:00Z"))).toBe(ms("2026-01-01T12:15:00Z"));
  });

  it("preserves every-N daily registration phase", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "daily",
        interval: 2,
        hour: 9,
        minute: 0,
      },
      ms("2026-01-02T13:00:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-01-02T13:00:00Z"))).toBe(ms("2026-01-04T09:00:00Z"));
  });

  it("supports multiple weekdays in each phase-aligned week", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "weekly",
        interval: 2,
        byDay: ["FR", "WE", "WE"],
        hour: 9,
        minute: 0,
      },
      ms("2026-01-07T12:00:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-01-08T00:00:00Z"))).toBe(ms("2026-01-09T09:00:00Z"));
    expect(nextFireAfter(spec, ms("2026-01-09T09:00:00Z"))).toBe(ms("2026-01-21T09:00:00Z"));
  });

  it("shifts a spring-forward gap by the transition duration", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "America/New_York",
        freq: "daily",
        hour: 2,
        minute: 30,
      },
      ms("2026-03-01T00:00:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-03-07T08:00:00Z"))).toBe(ms("2026-03-08T07:30:00Z"));
  });

  it("chooses the earlier fall-back instant and does not fire twice", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "America/New_York",
        freq: "daily",
        hour: 1,
        minute: 30,
      },
      ms("2026-10-01T00:00:00Z"),
    );
    const first = ms("2026-11-01T05:30:00Z");
    expect(nextFireAfter(spec, ms("2026-10-31T06:00:00Z"))).toBe(first);
    expect(nextFireAfter(spec, first)).toBe(ms("2026-11-02T06:30:00Z"));
  });

  it("advances hourly recurrence past the repeated fall-back hour", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "America/New_York",
        freq: "hourly",
        minute: 30,
      },
      ms("2026-10-01T00:00:00Z"),
    );
    const first = ms("2026-11-01T05:30:00Z");
    expect(nextFireAfter(spec, ms("2026-11-01T04:45:00Z"))).toBe(first);
    expect(nextFireAfter(spec, first)).toBe(ms("2026-11-01T07:30:00Z"));
  });

  it("handles fractional-offset zones", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "Asia/Kathmandu",
        freq: "hourly",
        minute: 10,
      },
      ms("2026-01-01T00:00:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-01-01T00:00:00Z"))).toBe(ms("2026-01-01T00:25:00Z"));
  });

  it("shifts through Lord Howe's half-hour DST gap", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "Australia/Lord_Howe",
        freq: "daily",
        hour: 2,
        minute: 15,
      },
      ms("2026-10-01T00:00:00Z"),
    );
    expect(nextFireAfter(spec, ms("2026-10-03T15:00:00Z"))).toBe(ms("2026-10-03T15:45:00Z"));
  });

  it("handles a historical skipped local date without duplicating it", () => {
    const spec = normalizeCalendarRule(
      {
        timeZone: "Pacific/Apia",
        freq: "daily",
        hour: 9,
        minute: 0,
      },
      ms("2011-12-01T00:00:00Z"),
    );
    const shifted = ms("2011-12-30T19:00:00Z");
    expect(nextFireAfter(spec, ms("2011-12-29T20:00:00Z"))).toBe(shifted);
    expect(nextFireAfter(spec, shifted)).toBe(ms("2011-12-31T19:00:00Z"));
  });
});

describe("one-shot recurrence", () => {
  it("normalizes numeric instants as UTC and permits past values", () => {
    expect(normalizeOneShot(1_000, 2_000)).toEqual({
      kind: "once",
      fireAt: 1_000,
      timeZone: "UTC",
    });
    expect(initialNextFire(normalizeOneShot(1_000, 2_000), 2_000)).toBeUndefined();
  });

  it("resolves an explicit local date", () => {
    expect(
      normalizeOneShot(
        {
          timeZone: "America/New_York",
          year: 2026,
          month: 7,
          day: 4,
          hour: 9,
          minute: 30,
        },
        0,
      ),
    ).toEqual({
      kind: "once",
      fireAt: ms("2026-07-04T13:30:00Z"),
      timeZone: "America/New_York",
    });
  });

  it("resolves a date-less wall time to the next local occurrence", () => {
    expect(
      normalizeOneShot(
        {
          timeZone: "America/New_York",
          hour: 9,
          minute: 0,
        },
        ms("2026-07-04T14:00:00Z"),
      ),
    ).toEqual({
      kind: "once",
      fireAt: ms("2026-07-05T13:00:00Z"),
      timeZone: "America/New_York",
    });
  });

  it("rejects partial and invalid explicit dates", () => {
    expect(() =>
      normalizeOneShot(
        {
          timeZone: "UTC",
          year: 2026,
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow("year, month, and day");
    expect(() =>
      normalizeOneShot(
        {
          timeZone: "UTC",
          year: 2026,
          month: 2,
          day: 30,
          hour: 9,
          minute: 0,
        },
        0,
      ),
    ).toThrow();
  });
});

describe("plain-data compatibility", () => {
  it.each<ScheduleSpec>([
    { kind: "interval", everyMs: 60_000, anchorMs: 1_000 },
    normalizeCalendarRule(
      {
        timeZone: "UTC",
        freq: "weekly",
        byDay: ["MO", "FR"],
        hour: 9,
        minute: 15,
      },
      1_000,
    ),
    normalizeOneShot(2_000, 1_000),
  ])("round-trips canonical specs through structured JSON", (spec) => {
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
});
