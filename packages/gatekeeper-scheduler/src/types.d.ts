// Scheduled Tasks lets an agent register persistent callbacks that run later, without keeping the
// current agent session alive. The capability is scoped to the current workspace: registrations and
// `list()` never cross workspace boundaries, even though scheduling is coordinated per account.
//
// Registration creates a disabled hook. The user must enable it in Connections before it can run or
// appear in `list()`. Keep the returned schedule ID as the immediate registration receipt.
//
// Choose the entry point by how the user described the cadence:
//
// - `every()` uses elapsed UTC time, preserves its registration-time phase, and is appropriate for
//   arbitrary intervals such as "every 5 minutes".
// - `calendarAt()` uses local wall-clock fields and requires the user's explicit IANA timezone.
// - `runAt()` runs once, using either an absolute UTC epoch-millisecond timestamp or an explicit
//   timezone-aware wall-clock value.
//
// Recurring registrations may set `occurrences` to a total count or an inclusive final time. The
// bound counts due slots, not successful runs: a slot is consumed once it becomes due and takes a
// `runId`, even if delivery then fails. Retries reuse that `runId` and do not consume another.
//
// Recurring schedules skip missed occurrences instead of replaying them. Callback failures may be
// retried with the same `runId`, so callback work should be idempotent.

/** Day-of-week token, RRULE-style: `SU` is Sunday through `SA` for Saturday. */
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

/**
 * A timezone-aware wall-clock recurrence passed to `calendarAt()`.
 *
 * Ask the user for `timeZone`; never guess UTC or infer a timezone from locale. The every-N phase is
 * anchored to registration time, so callers do not supply an anchor:
 *
 * - `hourly` fires at `minute`; use `every()` for sub-hour or arbitrary elapsed intervals.
 * - `daily` fires at `hour`:`minute`.
 * - `weekly` fires on every weekday in `byDay`, at `hour`:`minute`.
 *
 * `interval` defaults to 1. For example, a weekly rule with `interval: 2` repeats every other week,
 * anchored to the week in which it was registered. Calendar schedules follow timezone transitions:
 * nonexistent local times shift forward by the gap, and an overlapping local time fires only once.
 *
 * @example
 * { timeZone: "America/Chicago", freq: "daily", hour: 7, minute: 0 }
 * { timeZone: "Europe/Paris", freq: "hourly", minute: 30 }
 * { timeZone: "Asia/Tokyo", freq: "weekly", byDay: ["MO", "TH"], hour: 9, minute: 15 }
 */
export type CalendarRule = {
  /**
   * IANA timezone used to interpret wall-clock fields, for example `America/New_York`.
   * If the user has not supplied it, ask them; do not guess UTC or infer it from locale.
   */
  timeZone: string;
  /** Calendar unit used by the recurrence. */
  freq: "hourly" | "daily" | "weekly";
  /** Number of frequency units between occurrences; defaults to 1. */
  interval?: number;
  /** Days used by weekly schedules; required for weekly and invalid otherwise. */
  byDay?: Weekday[];
  /** Wall-clock hour; required for daily/weekly and invalid for hourly. */
  hour?: number;
  /** Wall-clock minute within the selected hour. */
  minute: number;
};

/**
 * A timezone-aware wall-clock instant passed to `runAt()`.
 *
 * Ask the user for `timeZone`; never guess it. Provide all of `year`, `month`, and `day` for an
 * explicit local date, or omit all three for the next occurrence of the requested local time. A
 * date-less value resolves at registration to today when still ahead, otherwise tomorrow.
 *
 * @example
 * { timeZone: "America/New_York", hour: 17, minute: 19 }
 * { timeZone: "Europe/London", year: 2027, month: 3, day: 14, hour: 9, minute: 0 }
 */
export type OneShotTime = {
  /** Same timezone rules as `CalendarRule.timeZone`. */
  timeZone: string;
  /** Local four-digit year; provide year, month, and day together or omit all three. */
  year?: number;
  /** Local month from 1 through 12. */
  month?: number;
  /** Local day of month. */
  day?: number;
  /** Local hour from 0 through 23. */
  hour: number;
  /** Local minute from 0 through 59. */
  minute: number;
  /** Local second from 0 through 59; defaults to 0. */
  second?: number;
};

/** Presentation metadata shown when asking the user to approve a schedule. */
export interface ScheduleOptions {
  /** Short non-empty schedule title. */
  title: string;
  /** Non-empty explanation of what the callback does. */
  description: string;
}

/**
 * A finite bound accepted when registering a recurring schedule. Give `count` or `until`, never
 * both. A schedule that uses up its bound reports `completed`; one whose callback retries are
 * exhausted reports `dead` instead, whether or not the bound was reached.
 */
export type ScheduleOccurrences =
  | {
      /** Total logical scheduled occurrences. Retries do not increase this count. */
      count: number;
    }
  | {
      /** Inclusive final scheduled instant, expressed like a `runAt()` time. */
      until: OneShotTime | number;
    };

/** A validated recurrence bound returned by `list()`; `until` resolves to epoch milliseconds. */
export type NormalizedScheduleOccurrences =
  | { count: number }
  | { until: number };

/** Registration metadata for an elapsed or calendar recurrence. */
export interface RecurringScheduleOptions extends ScheduleOptions {
  /** Optional finite bound. Counted occurrences are due logical runs, including failed delivery. */
  occurrences?: ScheduleOccurrences;
}

/** Canonical interval cadence returned by `list()`. */
export type IntervalCadence = {
  /** Cadence discriminator. */
  kind: "interval";
  /** Elapsed milliseconds between occurrences. */
  everyMs: number;
  /** Registration instant anchoring the cadence, as Unix epoch milliseconds. */
  anchorMs: number;
};

/** Canonical normalized calendar rule returned by `list()`. */
export type NormalizedCalendarRule =
  | {
      /** Rule discriminator. */ freq: "hourly";
      /** Unit count. */ interval: number;
      /** Minute. */ minute: number;
      /** Phase anchor. */ anchorMs: number;
    }
  | {
      /** Rule discriminator. */ freq: "daily";
      /** Unit count. */ interval: number;
      /** Hour. */ hour: number;
      /** Minute. */ minute: number;
      /** Phase anchor. */ anchorMs: number;
    }
  | {
      /** Rule discriminator. */ freq: "weekly";
      /** Unit count. */ interval: number;
      /** Weekdays. */ byDay: Weekday[];
      /** Hour. */ hour: number;
      /** Minute. */ minute: number;
      /** Phase anchor. */ anchorMs: number;
    };

/** Canonical calendar cadence returned by `list()`. */
export type CalendarCadence = {
  /** Cadence discriminator. */
  kind: "calendar";
  /** IANA timezone used for wall-clock interpretation. */
  timeZone: string;
  /** Validated normalized recurrence rule. */
  rule: NormalizedCalendarRule;
};

/** Canonical one-shot cadence returned by `list()`. */
export type OneShotCadence = {
  /** Cadence discriminator. */
  kind: "once";
  /** Absolute firing instant as Unix epoch milliseconds. */
  fireAt: number;
  /** IANA timezone used for display; `UTC` for numeric input. */
  timeZone: string;
};

/** Canonical cadence returned by `list()`. */
export type ScheduleCadence = IntervalCadence | CalendarCadence | OneShotCadence;

/**
 * Current state of an enabled schedule: recurring or pending work is `active`; exhausted callback
 * retries are `dead`; a delivered one-shot or a recurrence that used its bound is `completed`; and
 * a schedule whose firing window passed without delivery is `expired`.
 */
export type ScheduleStatus = "active" | "dead" | "completed" | "expired";

/** A plain-data snapshot of an enabled schedule belonging to the current workspace. */
export type ScheduleSummary = {
  /** Stable registration ID. */
  scheduleId: string;
  /** Approved display title. */
  title: string;
  /** Approved display description. */
  description: string;
  /** Canonical recurrence/one-shot definition. */
  cadence: ScheduleCadence;
  /** Finite recurrence bound, when configured. */
  occurrences?: NormalizedScheduleOccurrences;
  /** Due slots started so far; present for a bounded recurrence. */
  occurrenceCount?: number;
} & (
  | {
      /** The schedule can still run or retry. */
      status: "active";
      /** Next planned occurrence or retry, when one is currently known. */
      nextFire?: number;
      /** Set when `nextFire` is a retry of a failed attempt, not a new occurrence. */
      retrying?: true;
    }
  | {
      /** Callback delivery exhausted its retry budget. */
      status: "dead";
      /** Exhaustion time. */
      failedAt: number;
      /** Fixed non-sensitive stage code for the failure. */
      failureCode: "authorization_failed" | "callback_failed";
    }
  | {
      /** A one-shot completed or a bounded recurrence reached its limit. */
      status: "completed";
      /** Completion time. */
      completedAt: number;
    }
  | {
      /** A one-shot, or a recurrence whose bound passed before it could run, never delivered. */
      status: "expired";
      /** Expiration time. */
      expiredAt: number;
    }
);

/**
 * Metadata delivered to a scheduled callback. `scheduledTime` and `actualTime` are Unix epoch
 * milliseconds; use `timeZone` when rendering them as local wall-clock time, for example:
 *
 * `new Intl.DateTimeFormat(undefined, { timeZone: firing.timeZone }).format(firing.actualTime)`
 */
export interface ScheduledFiring {
  /** Stable registration ID. */
  scheduleId: string;
  /** Stable ID reused by retries of this logical occurrence. */
  runId: string;
  /** Planned occurrence time as Unix epoch milliseconds. */
  scheduledTime: number;
  /** Delivery-attempt time as Unix epoch milliseconds; may be later than `scheduledTime`. */
  actualTime: number;
  /** Schedule timezone, or `UTC` for elapsed intervals and numeric one-shots. */
  timeZone: string;
}

/**
 * Hook implemented by workspace code and made persistent with `ctx.restore()` before registration.
 */
export interface ScheduledTaskHook {
  /**
   * Handles a scheduled occurrence. Only one logical run is active per schedule; recurring
   * occurrences due while it is pending or retrying are skipped. Bounded retries may invoke this
   * callback more than once with the same `runId`; eventual delivery is not guaranteed, so use
   * `runId` to make work idempotent.
   */
  onSchedule(firing: ScheduledFiring): Promise<void>;
}

/**
 * Workspace-scoped Scheduled Tasks capability.
 *
 * Define the callback in the Gadget's `[restore]()` method. Then call `ctx.restore()` directly from
 * `executeCode` and pass the resulting persistent stub to a registration method. Do not call
 * `this.ctx.restore()` inside a Gadget method invoked through an `env` Gadget binding; that facet
 * stub does not carry the required restore context. The parameters passed to `ctx.restore()` must
 * be serializable; the system passes them to `[restore]()` both immediately and when restoring the
 * callback later. The restored `RpcTarget` is a separate object and does not inherit the Gadget's
 * `ctx`; pass any required dependencies, such as `this.ctx.storage`, to it from `[restore]()`.
 *
 * Use the Scheduler binding shown in the agent environment directly; it does not need to be saved as
 * a Gadget binding. Registration returns a stable schedule ID immediately, but the schedule remains
 * disabled and absent from `list()` until the user enables it in Connections. The callback itself
 * runs through the restored Gadget and does not need the Scheduler binding.
 *
 * Every successful registration call creates a distinct hook; registration is not idempotent.
 *
 * @example
 * // server.js
 * import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
 * export class Gadget extends DurableObject {
 *   async [restore](params) {
 *     if (params.type === "dailyBrief") return new DailyBrief(this.ctx.storage);
 *     throw new TypeError(`Unknown restore type: ${params.type}`);
 *   }
 * }
 * class DailyBrief extends RpcTarget {
 *   constructor(storage) {
 *     super();
 *     this.storage = storage;
 *   }
 *   async onSchedule(firing) { /* ... *\/ }
 * }
 *
 * // executeCode
 * const callback = await ctx.restore({ type: "dailyBrief" });
 * const scheduleId = await scheduler.calendarAt(
 *   { timeZone: "America/Chicago", freq: "daily", hour: 7, minute: 0 },
 *   callback,
 *   { title: "Daily brief", description: "Prepare the morning activity summary." },
 * );
 * console.log("Schedule registered:", scheduleId);
 */
export interface ScheduleSession {
  /**
   * Registers an elapsed-time recurring callback. `everyMs` must be a positive safe integer of at
   * least 60,000. Occurrences stay aligned to registration time; delayed or missed occurrences are
   * skipped rather than replayed.
   *
   * @param callback A persistent `ScheduledTaskHook` stub created with `ctx.restore()`.
   * @returns The stable schedule ID and immediate registration receipt. The schedule is not listed
   * or run until the user enables it in Connections.
   */
  every(
    everyMs: number,
    callback: RpcStub<ScheduledTaskHook>,
    options: RecurringScheduleOptions,
  ): Promise<string>;

  /**
   * Registers a timezone-aware wall-clock recurrence. Ask the user for `rule.timeZone`; do not guess
   * or infer it. See `CalendarRule` for supported hourly, daily, and weekly shapes.
   *
   * @param callback A persistent `ScheduledTaskHook` stub created with `ctx.restore()`.
   * @returns The stable schedule ID and immediate registration receipt. The schedule is not listed
   * or run until the user enables it in Connections.
   */
  calendarAt(
    rule: CalendarRule,
    callback: RpcStub<ScheduledTaskHook>,
    options: RecurringScheduleOptions,
  ): Promise<string>;

  /**
   * Registers a one-shot callback. A numeric `when` is an absolute Unix epoch-millisecond timestamp
   * in UTC. A wall-clock `when` requires an explicit IANA timezone; ask the user rather than guessing.
   *
   * @param callback A persistent `ScheduledTaskHook` stub created with `ctx.restore()`.
   * @returns The stable schedule ID and immediate registration receipt. The schedule is not listed
   * or run until the user enables it in Connections.
   */
  runAt(
    when: OneShotTime | number,
    callback: RpcStub<ScheduledTaskHook>,
    options: ScheduleOptions,
  ): Promise<string>;

  /**
   * Lists only enabled schedules belonging to the current workspace. A newly registered schedule is
   * absent until the user enables it in Connections, so do not call this method in the same turn to
   * confirm registration: the ID returned by the registration method is the confirmation. Persist
   * that ID immediately. This method cannot confirm registration or detect duplicates among disabled
   * hooks. Use the returned cadence and status metadata to inspect enabled and terminal schedules.
   */
  list(): Promise<ScheduleSummary[]>;
}
