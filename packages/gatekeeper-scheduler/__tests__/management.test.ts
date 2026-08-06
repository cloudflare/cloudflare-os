import { describe, expect, it } from "vite-plus/test";
import {
  MANAGEMENT_PAGE_SIZE,
  paginateManagementSchedules,
  type ManagementScheduleEntry,
} from "../src/management.js";

function entry(
  key: string,
  status: "active" | "dead" | "completed" | "expired",
  timestamp: number,
  title = key,
): ManagementScheduleEntry {
  const common = {
    key,
    schedule: {
      scheduleId: key,
      title,
      description: `Description for ${title}`,
      cadence: { kind: "interval" as const, everyMs: 60_000, anchorMs: 0 },
      target: { title: "Workspace", url: "/gadget/workspace" },
    },
  };
  if (status === "active") {
    return { ...common, schedule: { ...common.schedule, status, nextFire: timestamp } };
  }
  if (status === "dead") {
    return {
      ...common,
      schedule: {
        ...common.schedule,
        status,
        failedAt: timestamp,
        failureCode: "callback_failed",
      },
    };
  }
  if (status === "completed") {
    return { ...common, schedule: { ...common.schedule, status, completedAt: timestamp } };
  }
  return { ...common, schedule: { ...common.schedule, status, expiredAt: timestamp } };
}

describe("paginateManagementSchedules", () => {
  it("orders active schedules first by next run, then failures and finished schedules newest first", () => {
    const page = paginateManagementSchedules([
      entry("finished-old", "completed", 10),
      entry("active-later", "active", 40),
      entry("dead-old", "dead", 20),
      entry("finished-new", "expired", 50),
      entry("active-soon", "active", 30),
      entry("dead-new", "dead", 60),
    ]);

    expect(page.schedules.map(({ scheduleId }) => scheduleId)).toEqual([
      "active-soon",
      "active-later",
      "dead-new",
      "dead-old",
      "finished-new",
      "finished-old",
    ]);
  });

  it("normalizes title and description search and validates status filters", () => {
    const schedules = [
      entry("one", "active", 10, "  Morning Brief  "),
      entry("two", "dead", 20, "Weekly roundup"),
    ];

    expect(
      paginateManagementSchedules(schedules, { query: "  morning BRIEF " }).schedules,
    ).toHaveLength(1);
    expect(
      paginateManagementSchedules(schedules, { query: "description FOR weekly" }).schedules,
    ).toHaveLength(1);
    expect(
      paginateManagementSchedules(schedules, { statuses: ["dead", "dead"] }).schedules,
    ).toHaveLength(1);
    expect(() =>
      paginateManagementSchedules(schedules, { statuses: ["paused" as "active"] }),
    ).toThrow("Invalid schedule status");
  });

  it("returns fixed-size pages and binds an opaque cursor to normalized filters", () => {
    const schedules = Array.from({ length: MANAGEMENT_PAGE_SIZE + 1 }, (_, index) =>
      entry(`schedule-${index.toString().padStart(3, "0")}`, "active", index),
    );
    const first = paginateManagementSchedules(schedules, {
      query: " schedule ",
      statuses: ["active"],
    });

    expect(first.schedules).toHaveLength(MANAGEMENT_PAGE_SIZE);
    expect(first.cursor).toEqual(expect.any(String));
    expect(
      paginateManagementSchedules(schedules, {
        cursor: first.cursor,
        query: "SCHEDULE",
        statuses: ["active"],
      }).schedules,
    ).toHaveLength(1);
    expect(() =>
      paginateManagementSchedules(schedules, { cursor: first.cursor, statuses: ["active"] }),
    ).toThrow("Cursor does not match");
  });

  it("rejects oversized queries and malformed cursors", () => {
    expect(() => paginateManagementSchedules([], { query: "x".repeat(201) })).toThrow(
      "at most 200",
    );
    expect(() => paginateManagementSchedules([], { cursor: "not-a-cursor" })).toThrow(
      "Invalid management cursor",
    );
    expect(() => paginateManagementSchedules([], { cursor: "x".repeat(1_025) })).toThrow(
      "Invalid management cursor",
    );
  });
});
