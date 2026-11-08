// Reads as if pending actions had been applied, as far as PagerDuty's data allows: an incident
// shows the status, title, priority, urgency and assignees its pending changes give it, with
// PagerDuty's side effects (acknowledging reassigns it to whoever acknowledges it, resolving
// resolves its alerts, and raising an acknowledged incident's urgency returns it to triggered),
// incidents and overrides a pending action creates are listed (a created override's user is in
// shifts, and on call where PagerDuty has someone on call it displaces), an override pending
// removal is gone from overrides (or, if under way, ends when the removal was staged), and a note
// waiting to be added is among the incident's notes. An incident a pending action opens starts as
// PagerDuty would open it: acknowledged if assigned to the connected user alone, and with the
// urgency its service's rule gives if none was chosen. Not shown: a reassignment to an escalation
// policy, whose assignees PagerDuty picks; the removal of an override PagerDuty already has from
// shifts and on-call entries, which don't say whom it displaced; an override for a time nobody is
// on call, in on-call entries; and any pending change in an incident's log. Every function is pure
// over the journal's pending entries.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { isProvisional, type NewIncident, type PagerDutyAction } from "./pagerduty-actions";
import type { WireService, WireSupportHours } from "./pagerduty-normalize";
import type {
  PagerDutyAlert, PagerDutyIncidentDetails, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyNote, PagerDutyOnCall,
  PagerDutyOverride, PagerDutyRef, PagerDutyShift, PagerDutyUrgency, PagerDutyUserRef,
} from "./types";

/** The journal's pending entries, in submission order. */
export type Pending = readonly JournalEntry<PagerDutyAction>[];

/** Maps a temporary ID to PagerDuty's once the action creating it applied, else returns it. */
export type Resolve = (id: string) => string;

/** The pending actions on the incident `id`, in order. */
function actionsOn(id: string, pending: Pending, resolve: Resolve): PagerDutyAction[] {
  return pending.map(({ action }) => action)
    .filter(action => "incident" in action.payload && resolve(action.payload.incident.id) === id);
}

/**
 * The incidents PagerDuty already has whose status, urgency or assignees pending actions change:
 * what PagerDuty's incident filters look at.
 */
export function changedIncidents(pending: Pending, resolve: Resolve): string[] {
  const ids = pending.flatMap(({ action }) => action.kind === "acknowledge" || action.kind === "resolve"
    || action.kind === "lowerUrgency" || action.kind === "raiseUrgency"
    || (action.kind === "reassign" && "users" in action.payload.to)
    ? [resolve(action.payload.incident.id)] : []);
  return [...new Set(ids)].filter(id => !isProvisional(id));
}

/** `incident` with its pending changes applied; `overlayAlert` applies them to its alerts. */
export function overlayIncident<T extends PagerDutyIncidentSummary>(
  incident: T, pending: Pending, resolve: Resolve, me: PagerDutyUserRef,
): T {
  let result = incident;
  for (const action of actionsOn(incident.id, pending, resolve)) {
    switch (action.kind) {
      case "acknowledge":
        // PagerDuty leaves a resolved incident as it is, and reassigns one to whoever acknowledges it.
        if (result.status === "resolved") break;
        if (!result.assignees.some(({ id }) => id === me.id)) result = { ...result, assignees: [me] };
        if (result.status === "triggered") {
          result = { ...result, status: "acknowledged" };
          if ("acknowledgers" in result) {
            const details = result as T & PagerDutyIncidentDetails;
            result = { ...details, acknowledgers: [...details.acknowledgers, { user: me, at: details.updatedAt }] };
          }
        }
        break;
      case "resolve":
        result = { ...result, status: "resolved", assignees: [] };
        break;
      case "setPriority":
        result = { ...result, priority: action.payload.priority?.name ?? null };
        break;
      case "setTitle":
        result = { ...result, title: action.payload.title };
        break;
      case "lowerUrgency":
        result = { ...result, urgency: "low" };
        break;
      case "raiseUrgency":
        // Raising a low-urgency incident someone acknowledged un-acknowledges it, and escalation resumes.
        if (result.urgency === "low" && result.status === "acknowledged") {
          result = { ...result, status: "triggered" };
          if ("acknowledgers" in result) result = { ...result, acknowledgers: [] };
        }
        result = { ...result, urgency: "high" };
        break;
      case "reassign":
        if ("users" in action.payload.to) {
          result = { ...result, assignees: action.payload.to.users.map(({ id, name }) => ({ id, name })) };
        }
        break;
    }
  }
  return result;
}

/** An alert of the incident `incidentId` as pending actions leave it: resolved with its incident. */
export function overlayAlert(alert: PagerDutyAlert, incidentId: string, pending: Pending, resolve: Resolve): PagerDutyAlert {
  return actionsOn(incidentId, pending, resolve).some(({ kind }) => kind === "resolve") ? { ...alert, status: "resolved" } : alert;
}

/** An incident a pending action opens, as reads show it until PagerDuty has it. */
export function pendingIncident(payload: NewIncident, me: PagerDutyUserRef): PagerDutyIncidentDetails {
  // PagerDuty opens an incident its creator assigns to themselves already acknowledged, by them.
  const own = payload.assignTo?.length === 1 && payload.assignTo[0].id === me.id;
  return {
    id: payload.ref,
    // PagerDuty numbers an incident when it opens it.
    number: 0,
    title: payload.title,
    status: own ? "acknowledged" : "triggered",
    urgency: payload.urgency ?? payload.serviceUrgency,
    priority: payload.priority?.name ?? null,
    service: payload.service,
    team: payload.teams[0] ?? null,
    assignees: (payload.assignTo ?? []).map(({ id, name }) => ({ id, name })),
    createdAt: payload.stagedAt,
    updatedAt: payload.stagedAt,
    htmlUrl: "",
    details: payload.details ?? null,
    escalationPolicy: payload.escalationPolicy,
    acknowledgers: own ? [{ user: me, at: payload.stagedAt }] : [],
    incidentKey: payload.incidentKey ?? null,
    resolvedAt: null,
    alertCount: 0,
    firstAlert: null,
    conferenceUrl: null,
  };
}

/**
 * The urgency `service`'s rule gives an incident opened at `at` without one. A severity-based
 * urgency, which only events carry, and support hours in a time zone the runtime doesn't know
 * read as high.
 */
export function serviceUrgency({ incident_urgency_rule: rule, support_hours: hours }: WireService, at: Date): PagerDutyUrgency {
  let chosen: { urgency?: string } | undefined = rule;
  if (rule?.type === "use_support_hours") {
    const within = hours ? withinSupportHours(hours, at) : undefined;
    chosen = within === undefined ? undefined : within ? rule.during_support_hours : rule.outside_support_hours;
  }
  return chosen?.urgency === "low" ? "low" : "high";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Whether `at` falls within `hours` in their time zone, or undefined if the runtime doesn't know it. */
function withinSupportHours(hours: WireSupportHours, at: Date): boolean | undefined {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: hours.time_zone, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch {
    return undefined;
  }
  const part = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]));
  const time = `${part.hour}:${part.minute}:${part.second}`;
  // 1 is Monday; Sunday is 7, or 0.
  const day = WEEKDAYS.indexOf(part.weekday);
  return (hours.days_of_week.includes(day) || (day === 0 && hours.days_of_week.includes(7)))
    && hours.start_time <= time && time < hours.end_time;
}

/** The incidents pending actions open that PagerDuty doesn't have yet, with later changes applied. */
export function pendingIncidents(pending: Pending, resolve: Resolve, me: PagerDutyUserRef): PagerDutyIncidentDetails[] {
  return pending.flatMap(({ action }) => action.kind === "createIncident" && resolve(action.payload.ref) === action.payload.ref
    ? [overlayIncident(pendingIncident(action.payload, me), pending, resolve, me)] : []);
}

/** The filter a listing applies, with its defaults filled in. */
export type IncidentQuery = Required<Pick<PagerDutyIncidentFilter, "statuses">>
  & Pick<PagerDutyIncidentFilter, "urgencies" | "assignedToMe" | "serviceIds" | "since" | "until">;

/** Whether an incident, as simulated, still belongs in a listing made with `query`. */
export function matchesQuery(incident: PagerDutyIncidentSummary, query: IncidentQuery, me: PagerDutyUserRef): boolean {
  return query.statuses.includes(incident.status)
    && (!query.urgencies || query.urgencies.includes(incident.urgency))
    && (!query.assignedToMe || incident.assignees.some(({ id }) => id === me.id))
    && (!query.serviceIds || query.serviceIds.includes(incident.service.id))
    && (!query.since || Date.parse(incident.createdAt) >= Date.parse(query.since))
    && (!query.until || Date.parse(incident.createdAt) < Date.parse(query.until));
}

/** Newest first, as PagerDuty lists incidents. */
export const newestFirst = (a: PagerDutyIncidentSummary, b: PagerDutyIncidentSummary): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** The notes pending actions add to the incident `id`. */
export function pendingNotes(id: string, pending: Pending, resolve: Resolve, me: PagerDutyUserRef): PagerDutyNote[] {
  return actionsOn(id, pending, resolve).flatMap(action => action.kind === "addNote"
    ? [{ id: action.payload.ref, content: action.payload.content, author: me, createdAt: action.payload.stagedAt }] : []);
}

/** The overrides pending creation that PagerDuty doesn't have yet, each with its schedule. */
function createdOverrides(pending: Pending, resolve: Resolve): { scheduleId: string; override: PagerDutyOverride }[] {
  return pending.flatMap(({ action }) =>
    (action.kind === "createOverride" || action.kind === "createOverrideForOthers")
      && resolve(action.payload.ref) === action.payload.ref
      ? [{ scheduleId: action.payload.scheduleId, override: {
        id: action.payload.ref, user: { id: action.payload.user.id, name: action.payload.user.name },
        start: action.payload.start, end: action.payload.end,
      } }]
      : []);
}

/** The users overrides pending creation put on call, where PagerDuty doesn't list them yet. */
export const overridingUsers = (pending: Pending, resolve: Resolve): string[] =>
  createdOverrides(pending, resolve).map(({ override }) => override.user.id);

/**
 * `overrides` on schedule `scheduleId` as if pending ones were made and removed: those pending
 * creation added, and those pending removal gone. As PagerDuty does, a removal cuts one already
 * under way short at the time it was staged, and leaves one already over.
 */
function withPending(overrides: readonly PagerDutyOverride[], scheduleId: string, pending: Pending,
                     resolve: Resolve): PagerDutyOverride[] {
  const created = createdOverrides(pending, resolve).flatMap(made => made.scheduleId === scheduleId ? [made.override] : []);
  const removedAt = new Map(pending.flatMap(({ action }) =>
    action.kind === "deleteOverride" && action.payload.scheduleId === scheduleId
      ? [[resolve(action.payload.overrideId), action.payload.stagedAt] as const] : []));
  return [...overrides, ...created].flatMap(override => {
    const at = override.id === null ? undefined : removedAt.get(override.id);
    if (at === undefined || Date.parse(override.end) <= Date.parse(at)) return [override];
    return Date.parse(override.start) < Date.parse(at) ? [{ ...override, end: at }] : [];
  });
}

/** A span between ISO 8601 times. */
type Span = { start: string; end: string };

const overlaps = (a: Span, b: Span): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

/** `span` with its part within `cut` replaced by `within(part)`; its parts outside `cut` stay as they were. */
function replaceWithin<S extends Span>(span: S, cut: Span, within: (part: S) => S[]): S[] {
  if (!overlaps(span, cut)) return [span];
  const before = Date.parse(span.start) < Date.parse(cut.start);
  const after = Date.parse(span.end) > Date.parse(cut.end);
  return [
    ...(before ? [{ ...span, end: cut.start }] : []),
    ...within({ ...span, ...(before ? { start: cut.start } : {}), ...(after ? { end: cut.end } : {}) }),
    ...(after ? [{ ...span, start: cut.end }] : []),
  ];
}

/** A schedule's overrides in `window` as if pending ones were made and removed, ordered by start. */
export function overlayOverrides(
  overrides: readonly PagerDutyOverride[], scheduleId: string, window: { since: string; until: string },
  pending: Pending, resolve: Resolve,
): PagerDutyOverride[] {
  return withPending(overrides, scheduleId, pending, resolve)
    .filter(override => overlaps(override, { start: window.since, end: window.until }))
    .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * A schedule's shifts as if the overrides pending creation were made, less any pending removal
 * takes back: each covers whatever it overlaps, cut at its ends. Removing an override PagerDuty
 * already has can't be undone from the shifts alone, since they don't say who it displaced.
 */
export function overlayShifts(
  shifts: readonly PagerDutyShift[], scheduleId: string, window: { since: string; until: string },
  pending: Pending, resolve: Resolve,
): PagerDutyShift[] {
  let result = [...shifts];
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const override of withPending([], scheduleId, pending, resolve)) {
    const start = Math.max(Date.parse(override.start), Date.parse(window.since));
    const end = Math.min(Date.parse(override.end), Date.parse(window.until));
    if (!(start < end)) continue;
    const span = { start: iso(start), end: iso(end) };
    result = [...result.flatMap(shift => replaceWithin(shift, span, () => [])), { user: override.user, ...span }];
  }
  return result.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** An on-call entry a schedule gives for a span. */
type ScheduledOnCall = PagerDutyOnCall & Span & { schedule: PagerDutyRef };

const scheduled = (entry: PagerDutyOnCall): entry is ScheduledOnCall =>
  entry.schedule !== null && entry.start !== null && entry.end !== null;

/**
 * On-call entries as if the overrides pending creation were made, less any pending removal takes
 * back: an entry of an override's schedule keeps its user outside the override, and the part the
 * override covers goes to the override's user at the entry's escalation policy and level. Entries
 * without a schedule or times are left alone, and so is an override PagerDuty already has that a
 * removal is pending for, since the entries don't say who it displaced. An override spanning two
 * entries shows as a piece of each.
 */
export function overlayOnCalls(entries: readonly PagerDutyOnCall[], pending: Pending, resolve: Resolve): PagerDutyOnCall[] {
  return entries.flatMap(entry => !scheduled(entry) ? [entry]
    : withPending([], entry.schedule.id, pending, resolve).reduce<ScheduledOnCall[]>((parts, override) =>
      parts.flatMap(part => replaceWithin(part, override, covered => [{ ...covered, user: override.user }])), [entry]));
}
