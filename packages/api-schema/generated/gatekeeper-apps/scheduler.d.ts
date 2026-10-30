// Generated from packages/gatekeeper-scheduler/src/management-types.ts (ScheduleManagementApi, named by its package.json's cloudflareOs.appApi) by
// packages/api-schema/scripts/generate.ts -- do not edit.
// The app UI of the scheduler gatekeeper: the `ui` of getGatekeeperApp("scheduler").
// Change that file and run `pnpm api-schema:generate`.

/**
 * The read-only management capability the Scheduled Tasks app UI holds: the account's schedules,
 * across all of its workspaces, without the authority to change them. Hook enablement stays in the
 * Workshop's Connections UI.
 */
export interface ScheduleManagementApi {
  /**
   * Lists the account's scheduled tasks, across its workspaces, one page of at most 100 at a time,
   * filtered by `options`; pass a page's `cursor` back for the next.
   */
  list(options?: Awaitable<ManagementListOptions>): Promise<ManagementSchedulePage>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/** Canonical calendar cadence returned by `list()`. */
export type CalendarCadence = {
  /** Cadence discriminator. */
  kind: "calendar";
  /** Validated normalized recurrence rule. */
  rule: NormalizedCalendarRule;
  /** IANA timezone used for wall-clock interpretation. */
  timeZone: string;
};

/** Canonical interval cadence returned by `list()`. */
export type IntervalCadence = {
  /** Registration instant anchoring the cadence, as Unix epoch milliseconds. */
  anchorMs: number;
  /** Elapsed milliseconds between occurrences. */
  everyMs: number;
  /** Cadence discriminator. */
  kind: "interval";
};

/** Read-only filters accepted by the Scheduler management capability. */
export type ManagementListOptions = {
  /** Opaque continuation token. Pages are weakly consistent if schedules change between requests. */
  cursor?: string;
  query?: string;
  statuses?: ScheduleStatus[];
};

/** Account-management projection of one schedule. */
export type ManagementSchedule = {
  /** Canonical recurrence/one-shot definition. */
  cadence: ScheduleCadence;
  /** Completion time. */
  completedAt: number;
  /** Approved display description. */
  description: string;
  /** The gadget within that workspace, when the schedule is pinned to one. */
  gadgetId?: number;
  /** Due slots started so far; present for a bounded recurrence. */
  occurrenceCount?: number;
  /** Finite recurrence bound, when configured. */
  occurrences?: NormalizedScheduleOccurrences;
  /** Stable registration ID. */
  scheduleId: string;
  /** A one-shot completed or a bounded recurrence reached its limit. */
  status: "completed";
  /** Approved display title. */
  title: string;
  /** The workspace this schedule delivers into. The host resolves its live title and route. */
  workspaceId: string;
} | {
  /** Canonical recurrence/one-shot definition. */
  cadence: ScheduleCadence;
  /** Approved display description. */
  description: string;
  /** Expiration time. */
  expiredAt: number;
  /** The gadget within that workspace, when the schedule is pinned to one. */
  gadgetId?: number;
  /** Due slots started so far; present for a bounded recurrence. */
  occurrenceCount?: number;
  /** Finite recurrence bound, when configured. */
  occurrences?: NormalizedScheduleOccurrences;
  /** Stable registration ID. */
  scheduleId: string;
  /** A one-shot, or a recurrence whose bound passed before it could run, never delivered. */
  status: "expired";
  /** Approved display title. */
  title: string;
  /** The workspace this schedule delivers into. The host resolves its live title and route. */
  workspaceId: string;
} | {
  /** Canonical recurrence/one-shot definition. */
  cadence: ScheduleCadence;
  /** Approved display description. */
  description: string;
  /** Exhaustion time. */
  failedAt: number;
  /** Fixed non-sensitive stage code for the failure. */
  failureCode: "authorization_failed" | "callback_failed";
  /** The gadget within that workspace, when the schedule is pinned to one. */
  gadgetId?: number;
  /** Due slots started so far; present for a bounded recurrence. */
  occurrenceCount?: number;
  /** Finite recurrence bound, when configured. */
  occurrences?: NormalizedScheduleOccurrences;
  /** Stable registration ID. */
  scheduleId: string;
  /** Callback delivery exhausted its retry budget. */
  status: "dead";
  /** Approved display title. */
  title: string;
  /** The workspace this schedule delivers into. The host resolves its live title and route. */
  workspaceId: string;
} | {
  /** Canonical recurrence/one-shot definition. */
  cadence: ScheduleCadence;
  /** Approved display description. */
  description: string;
  /** The gadget within that workspace, when the schedule is pinned to one. */
  gadgetId?: number;
  /** Next planned occurrence or retry, when one is currently known. */
  nextFire?: number;
  /** Due slots started so far; present for a bounded recurrence. */
  occurrenceCount?: number;
  /** Finite recurrence bound, when configured. */
  occurrences?: NormalizedScheduleOccurrences;
  /** Set when `nextFire` is a retry of a failed attempt, not a new occurrence. */
  retrying?: true;
  /** Stable registration ID. */
  scheduleId: string;
  /** The schedule can still run or retry. */
  status: "active";
  /** Approved display title. */
  title: string;
  /** The workspace this schedule delivers into. The host resolves its live title and route. */
  workspaceId: string;
};

/** One bounded page returned to the Scheduler management app. */
export type ManagementSchedulePage = {
  cursor?: string;
  schedules: ManagementSchedule[];
};

/** Canonical normalized calendar rule returned by `list()`. */
export type NormalizedCalendarRule = {
  /** Phase anchor. */
  anchorMs: number;
  /** Weekdays. */
  byDay: Weekday[];
  /** Rule discriminator. */
  freq: "weekly";
  /** Hour. */
  hour: number;
  /** Unit count. */
  interval: number;
  /** Minute. */
  minute: number;
} | {
  /** Phase anchor. */
  anchorMs: number;
  /** Rule discriminator. */
  freq: "daily";
  /** Hour. */
  hour: number;
  /** Unit count. */
  interval: number;
  /** Minute. */
  minute: number;
} | {
  /** Phase anchor. */
  anchorMs: number;
  /** Rule discriminator. */
  freq: "hourly";
  /** Unit count. */
  interval: number;
  /** Minute. */
  minute: number;
};

/** A validated recurrence bound returned by `list()`; `until` resolves to epoch milliseconds. */
export type NormalizedScheduleOccurrences = {
  count: number;
} | {
  until: number;
};

/** Canonical one-shot cadence returned by `list()`. */
export type OneShotCadence = {
  /** Absolute firing instant as Unix epoch milliseconds. */
  fireAt: number;
  /** Cadence discriminator. */
  kind: "once";
  /** IANA timezone used for display; `UTC` for numeric input. */
  timeZone: string;
};

/** Canonical cadence returned by `list()`. */
export type ScheduleCadence = CalendarCadence | IntervalCadence | OneShotCadence;

/**
 * Current state of an enabled schedule: recurring or pending work is `active`; exhausted callback
 * retries are `dead`; a delivered one-shot or a recurrence that used its bound is `completed`; and
 * a schedule whose firing window passed without delivery is `expired`.
 */
export type ScheduleStatus = "active" | "completed" | "dead" | "expired";

/** Day-of-week token, RRULE-style: `SU` is Sunday through `SA` for Saturday. */
export type Weekday = "FR" | "MO" | "SA" | "SU" | "TH" | "TU" | "WE";

/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, `root.set(root.get())`. And what a function or a method the caller
 * implements may return: its result as is, or from an `async` function.
 */
export type Awaitable<T> = T | Promise<T>;
