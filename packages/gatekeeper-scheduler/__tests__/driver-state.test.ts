import { describe, expect, it } from "vite-plus/test";
import {
  MAX_ATTEMPTS,
  admitRun,
  beginDueRun,
  completeRun,
  createSchedule,
  failRun,
  rejectRun,
  retryDelay,
  type ScheduleRegistration,
} from "../src/driver-state.js";

const recurring: ScheduleRegistration = {
  workspaceId: "workspace-a",
  scheduleId: "schedule-a",
  spec: { kind: "interval", everyMs: 60_000, anchorMs: 0 },
};

const oneShot: ScheduleRegistration = {
  workspaceId: "workspace-a",
  scheduleId: "one-shot",
  spec: { kind: "once", fireAt: 120_000, timeZone: "UTC" },
};

describe("schedule state", () => {
  it("creates enabled state from the original phase and expires a past one-shot", () => {
    expect(createSchedule(recurring, 90_000)).toEqual({
      ...recurring,
      status: "active",
      nextFire: 120_000,
    });
    expect(createSchedule(oneShot, 120_000)).toEqual({
      ...oneShot,
      status: "expired",
      expiredAt: 120_000,
    });

    expect(
      createSchedule({ ...recurring, presentationOnly: "discarded" } as ScheduleRegistration, 0),
    ).not.toHaveProperty("presentationOnly");
  });

  it("reuses one run ID across retry and coalesces elapsed occurrences", () => {
    const begun = beginDueRun(createSchedule(recurring, 0), 60_000, "run-1", 360_000);
    expect(begun).toMatchObject({
      status: "pending",
      stage: "admission",
      runId: "run-1",
      scheduledTime: 60_000,
      attempts: 0,
      leaseExpiresAt: 360_000,
    });

    const admitted = admitRun(begun, "run-1", 66_000, 366_000);
    expect(admitted).toMatchObject({
      status: "pending",
      stage: "delivery",
      attempts: 1,
      nextFire: 120_000,
      leaseExpiresAt: 366_000,
    });

    const retrying = failRun(admitted, "run-1", "callback_failed", 72_000);
    expect(retrying).toMatchObject({
      status: "retrying",
      runId: "run-1",
      scheduledTime: 60_000,
      attempts: 1,
      nextAttempt: 72_000 + retryDelay(1),
      nextFire: 120_000,
    });

    const readmitted = beginDueRun(
      retrying,
      retrying.status === "retrying" ? retrying.nextAttempt : 0,
      "ignored",
      400_000,
    );
    expect(readmitted).toMatchObject({
      status: "pending",
      stage: "admission",
      runId: "run-1",
      attempts: 1,
      leaseExpiresAt: 400_000,
    });
  });

  it("uses eight attempts with exponential backoff capped at one hour", () => {
    expect(Array.from({ length: 7 }, (_, index) => retryDelay(index + 1))).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
    ]);

    let state = createSchedule(recurring, 0);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      state = beginDueRun(state, alarmTime(state), `run-${attempt}`, 10_000 + attempt);
      const runId = state.status === "pending" ? state.runId : "";
      state = admitRun(state, runId, attempt * 10, 20_000 + attempt);
      state = failRun(state, runId, "callback_failed", attempt * 100);
      if (attempt < MAX_ATTEMPTS) expect(state.status).toBe("retrying");
    }
    expect(state).toMatchObject({
      status: "dead",
      attempts: MAX_ATTEMPTS,
      failureCode: "callback_failed",
      failedAt: 800,
    });
  });

  it("completes recurring and one-shot runs into their appropriate states", () => {
    const recurringRun = admitRun(
      beginDueRun(createSchedule(recurring, 0), 60_000, "recurring-run", 360_000),
      "recurring-run",
      66_000,
      366_000,
    );
    expect(completeRun(recurringRun, "recurring-run", 90_000)).toEqual({
      ...recurring,
      status: "active",
      nextFire: 120_000,
    });

    const oneShotRun = admitRun(
      beginDueRun(createSchedule(oneShot, 0), 120_000, "one-shot-run", 420_000),
      "one-shot-run",
      126_000,
      426_000,
    );
    expect(completeRun(oneShotRun, "one-shot-run", 132_000)).toEqual({
      ...oneShot,
      status: "completed",
      completedAt: 132_000,
    });
  });

  it("abandons rejected admission without consuming an attempt or replaying occurrences", () => {
    const recurringRun = beginDueRun(createSchedule(recurring, 0), 60_000, "run-1", 360_000);
    expect(rejectRun(recurringRun, "run-1", 90_000)).toEqual({
      ...recurring,
      status: "active",
      nextFire: 120_000,
    });

    const oneShotRun = beginDueRun(createSchedule(oneShot, 0), 120_000, "run-2", 420_000);
    expect(rejectRun(oneShotRun, "run-2", 126_000)).toEqual({
      ...oneShot,
      status: "expired",
      expiredAt: 126_000,
    });
  });

  it("keeps a retry authoritative when later recurrence times become due", () => {
    const admitted = admitRun(
      beginDueRun(createSchedule(recurring, 0), 60_000, "run-1", 360_000),
      "run-1",
      66_000,
      366_000,
    );
    const retrying = failRun(admitted, "run-1", "callback_failed", 72_000);

    expect(beginDueRun(retrying, 10_000, "run-2", 15_000)).toBe(retrying);
  });

  it("counts logical occurrences once across retries and stops at the count", () => {
    const bounded: ScheduleRegistration = { ...recurring, occurrences: { count: 2 } };
    const first = beginDueRun(createSchedule(bounded, 0), 60_000, "run-1", 360_000);
    expect(first).toMatchObject({ status: "pending", occurrenceCount: 1 });

    const admitted = admitRun(first, "run-1", 60_000, 360_000);
    const retrying = failRun(admitted, "run-1", "callback_failed", 60_000);
    expect(retrying.status).toBe("retrying");
    const retry = beginDueRun(
      retrying,
      retrying.status === "retrying" ? retrying.nextAttempt : NaN,
      "ignored",
      500_000,
    );
    expect(retry).toMatchObject({ status: "pending", runId: "run-1", occurrenceCount: 1 });

    const readmitted = admitRun(retry, "run-1", 80_000, 500_000);
    const active = completeRun(readmitted, "run-1", 90_000);
    const second = beginDueRun(active, 120_000, "run-2", 420_000);
    expect(second).toMatchObject({ status: "pending", occurrenceCount: 2 });
    expect(rejectRun(second, "run-2", 130_000)).toMatchObject({
      status: "completed",
      occurrenceCount: 2,
      completedAt: 130_000,
    });
  });

  it("fires a count of one exactly once, then completes on delivery", () => {
    const once: ScheduleRegistration = { ...recurring, occurrences: { count: 1 } };
    const run = beginDueRun(createSchedule(once, 0), 60_000, "run-1", 360_000);
    expect(run).toMatchObject({ status: "pending", occurrenceCount: 1 });

    const completed = completeRun(admitRun(run, "run-1", 60_000, 360_000), "run-1", 90_000);
    expect(completed).toMatchObject({ status: "completed", occurrenceCount: 1 });
    // Terminal: a later due instant must not revive it.
    expect(beginDueRun(completed, 120_000, "run-2", 420_000)).toBe(completed);
  });

  it("reports dead, not completed, when retries exhaust on a bounded schedule", () => {
    const bounded: ScheduleRegistration = { ...recurring, occurrences: { count: 1 } };
    let state = createSchedule(bounded, 0);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      state = beginDueRun(state, alarmTime(state), "run-1", 10_000 + attempt);
      state = admitRun(state, "run-1", attempt * 10, 20_000 + attempt);
      state = failRun(state, "run-1", "callback_failed", attempt * 100);
    }
    // The bound is fully spent, but exhausted retries win: dead, not completed.
    expect(state).toMatchObject({ status: "dead", occurrenceCount: 1, attempts: MAX_ATTEMPTS });
  });

  it("expires a bound that already passed rather than reporting a completed run", () => {
    const stale: ScheduleRegistration = { ...recurring, occurrences: { until: 30_000 } };

    // Enabling happens long after registration validated the cutoff, so this is reachable.
    expect(createSchedule(stale, 0)).toEqual({
      ...stale,
      occurrenceCount: 0,
      status: "expired",
      expiredAt: 0,
    });
  });

  it("includes an occurrence exactly at the until cutoff", () => {
    const bounded: ScheduleRegistration = {
      ...recurring,
      occurrences: { until: 120_000 },
    };
    const first = admitRun(
      beginDueRun(createSchedule(bounded, 0), 60_000, "run-1", 360_000),
      "run-1",
      60_000,
      360_000,
    );
    const active = completeRun(first, "run-1", 90_000);
    expect(active).toMatchObject({ status: "active", nextFire: 120_000 });

    const second = admitRun(
      beginDueRun(active, 120_000, "run-2", 420_000),
      "run-2",
      120_000,
      420_000,
    );
    expect(completeRun(second, "run-2", 130_000)).toMatchObject({
      status: "completed",
      occurrenceCount: 2,
    });
  });

  it("fences continuations by exact pending run ID and stage", () => {
    const active = createSchedule(recurring, 0);
    const pending = beginDueRun(active, 60_000, "current", 360_000);

    expect(admitRun(pending, "stale", 66_000, 366_000)).toBe(pending);
    expect(failRun(pending, "current", "callback_failed", 72_000)).toBe(pending);
    expect(completeRun(pending, "current", 72_000)).toBe(pending);

    const admitted = admitRun(pending, "current", 66_000, 366_000);
    expect(rejectRun(admitted, "stale", 72_000)).toBe(admitted);
    expect(completeRun(admitted, "stale", 72_000)).toBe(admitted);
  });
});

function alarmTime(state: ReturnType<typeof createSchedule>): number {
  if (state.status === "active") return state.nextFire;
  if (state.status === "retrying") return state.nextAttempt;
  throw new Error(`Unexpected state: ${state.status}`);
}
