import type { ScheduleSpec } from "./schedule-types.js";
import type { NormalizedScheduleOccurrences } from "./types.js";
import { initialNextFire, nextFireAfter } from "./scheduler-core.js";

/** Maximum callback attempts for one logical run. */
export const MAX_ATTEMPTS = 8;
/** Initial callback retry delay. */
export const RETRY_BASE_MS = 60_000;
/** Maximum callback retry delay. */
export const RETRY_MAX_MS = 3_600_000;
/** Recovery lease granted to one in-flight delivery attempt. */
export const RECOVERY_DELAY_MS = 5 * 60_000;

/** Immutable registration data retained by a hook controller. */
export type ScheduleRegistration = {
  workspaceId: string;
  scheduleId: string;
  spec: ScheduleSpec;
  occurrences?: NormalizedScheduleOccurrences;
};

type ScheduleProgress = ScheduleRegistration & {
  /** Logical occurrences started so far. Set only when `occurrences` bounds the recurrence. */
  occurrenceCount?: number;
};

/** An enabled schedule waiting for its next occurrence. */
export type ActiveSchedule = ScheduleProgress & {
  status: "active";
  nextFire: number;
};

/** A one-shot whose firing instant passed without delivery. */
export type ExpiredSchedule = ScheduleProgress & {
  status: "expired";
  expiredAt: number;
};

/** A logical run currently crossing an external delivery boundary. */
export type PendingSchedule = ScheduleProgress & {
  status: "pending";
  stage: "admission" | "delivery";
  runId: string;
  scheduledTime: number;
  attempts: number;
  leaseExpiresAt: number;
  nextFire?: number;
};

/** A logical run waiting for its next callback attempt. */
export type RetryingSchedule = ScheduleProgress & {
  status: "retrying";
  runId: string;
  scheduledTime: number;
  attempts: number;
  nextAttempt: number;
  nextFire?: number;
};

/** A logical run that exhausted its callback attempt budget. */
export type DeadSchedule = ScheduleProgress & {
  status: "dead";
  runId: string;
  attempts: number;
  failedAt: number;
  failureCode: "authorization_failed" | "callback_failed";
};

/** A one-shot that was delivered, or a bounded recurrence that used its last occurrence. */
export type CompletedSchedule = ScheduleProgress & {
  status: "completed";
  completedAt: number;
};

/** Persisted state for one enabled schedule. */
export type EnabledSchedule =
  | ActiveSchedule
  | PendingSchedule
  | RetryingSchedule
  | DeadSchedule
  | CompletedSchedule
  | ExpiredSchedule;

/** Creates enabled state without replaying occurrences at or before `now`. */
export function createSchedule(registration: ScheduleRegistration, now: number): EnabledSchedule {
  const common: ScheduleProgress = {
    ...copyProgress(registration),
    occurrenceCount: registration.occurrences ? 0 : undefined,
  };
  const nextFire = initialNextFire(registration.spec, now);
  // A bound that already passed leaves no slot to deliver, so this never ran: expired, not
  // completed. Reachable because enabling happens well after registration validated the bound.
  return nextFire === undefined || !withinLimit(common, nextFire)
    ? { ...common, status: "expired", expiredAt: now }
    : { ...common, status: "active", nextFire };
}

/** Starts a due occurrence or retry, maintaining one logical run per schedule. */
export function beginDueRun(
  schedule: EnabledSchedule,
  now: number,
  runId: string,
  leaseExpiresAt: number,
): EnabledSchedule {
  if (schedule.status === "active") {
    if (schedule.nextFire > now) return schedule;
    if (!runId) throw new TypeError("A run ID is required.");
    return {
      ...copyProgress(schedule),
      status: "pending",
      stage: "admission",
      runId,
      scheduledTime: schedule.nextFire,
      attempts: 0,
      occurrenceCount: schedule.occurrences ? (schedule.occurrenceCount ?? 0) + 1 : undefined,
      leaseExpiresAt,
      nextFire: undefined,
    };
  }
  if (schedule.status !== "retrying" || schedule.nextAttempt > now) return schedule;
  return {
    ...copyProgress(schedule),
    status: "pending",
    stage: "admission",
    runId: schedule.runId,
    scheduledTime: schedule.scheduledTime,
    attempts: schedule.attempts,
    leaseExpiresAt,
    nextFire: schedule.nextFire,
  };
}

/** Records successful admission before authorization or callback delivery. */
export function admitRun(
  schedule: EnabledSchedule,
  runId: string,
  now: number,
  leaseExpiresAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "admission")) return schedule;
  return {
    ...schedule,
    stage: "delivery",
    attempts: schedule.attempts + 1,
    leaseExpiresAt,
    nextFire: recurringNextFire(schedule, now),
  };
}

/** Abandons a run after admission rejects without consuming a callback attempt. */
export function rejectRun(
  schedule: EnabledSchedule,
  runId: string,
  rejectedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "admission")) return schedule;
  const common = copyProgress(schedule);
  if (schedule.spec.kind === "once") {
    return { ...common, status: "expired", expiredAt: rejectedAt };
  }
  const nextFire = recurringNextFire(schedule, rejectedAt);
  return nextFire === undefined
    ? { ...common, status: "completed", completedAt: rejectedAt }
    : { ...common, status: "active", nextFire };
}

/** Schedules a callback retry or marks an exhausted logical run dead. */
export function failRun(
  schedule: EnabledSchedule,
  runId: string,
  failureCode: "authorization_failed" | "callback_failed",
  failedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "delivery")) return schedule;
  if (schedule.attempts >= MAX_ATTEMPTS) {
    return {
      ...copyProgress(schedule),
      status: "dead",
      runId,
      attempts: schedule.attempts,
      failedAt,
      failureCode,
    };
  }
  return {
    ...copyProgress(schedule),
    status: "retrying",
    runId,
    scheduledTime: schedule.scheduledTime,
    attempts: schedule.attempts,
    nextAttempt: checkedAdd(failedAt, retryDelay(schedule.attempts)),
    nextFire: recurringNextFire(schedule, failedAt),
  };
}

/** Completes a logical run and advances recurring cadence from completion time. */
export function completeRun(
  schedule: EnabledSchedule,
  runId: string,
  completedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "delivery")) return schedule;
  const common = copyProgress(schedule);
  const nextFire = recurringNextFire(schedule, completedAt);
  return nextFire === undefined
    ? { ...common, status: "completed", completedAt }
    : { ...common, status: "active", nextFire };
}

/** Returns exponential callback retry delay for an already-consumed attempt. */
export function retryDelay(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new RangeError(`Attempts must be an integer from 1 through ${MAX_ATTEMPTS}.`);
  }
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

function isPending(
  schedule: EnabledSchedule,
  runId: string,
  stage?: PendingSchedule["stage"],
): schedule is PendingSchedule {
  return (
    schedule.status === "pending" &&
    schedule.runId === runId &&
    (stage === undefined || schedule.stage === stage)
  );
}

function recurringNextFire(schedule: ScheduleProgress, now: number): number | undefined {
  if (schedule.spec.kind === "once") return undefined;
  const nextFire = nextFireAfter(schedule.spec, now);
  return nextFire !== undefined && withinLimit(schedule, nextFire) ? nextFire : undefined;
}

function copyProgress(
  { workspaceId, scheduleId, spec, occurrences, occurrenceCount }: ScheduleProgress,
): ScheduleProgress {
  return { workspaceId, scheduleId, spec, occurrences, occurrenceCount };
}

function withinLimit(schedule: ScheduleProgress, nextFire: number): boolean {
  const limit = schedule.occurrences;
  if (!limit) return true;
  return "count" in limit
    ? (schedule.occurrenceCount ?? 0) < limit.count
    : nextFire <= limit.until;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Retry deadline exceeds the supported range.");
  }
  return result;
}
