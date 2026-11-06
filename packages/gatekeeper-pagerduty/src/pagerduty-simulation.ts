// Reads as if every pending action had been applied: an incident shows the status, title,
// priority, urgency and assignees its pending changes give it, incidents and overrides a pending
// action creates are listed, an override pending removal is not, and a note waiting to be added is
// among the incident's notes. Every function is pure over the journal's pending entries.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { NewIncident, PagerDutyAction } from "./pagerduty-actions";
import type {
  PagerDutyIncidentDetails, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyNote,
  PagerDutyOverride, PagerDutyShift, PagerDutyUserRef,
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

/** `incident` with its pending changes applied. */
export function overlayIncident<T extends PagerDutyIncidentSummary>(
  incident: T, pending: Pending, resolve: Resolve, me: PagerDutyUserRef,
): T {
  let result = incident;
  for (const action of actionsOn(incident.id, pending, resolve)) {
    switch (action.kind) {
      case "acknowledge":
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
      case "setUrgency":
        result = { ...result, urgency: action.payload.urgency };
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

/** An incident a pending action opens, as reads show it until PagerDuty has it. */
export function pendingIncident(payload: NewIncident): PagerDutyIncidentDetails {
  return {
    id: payload.ref,
    // PagerDuty numbers an incident when it opens it.
    number: 0,
    title: payload.title,
    status: "triggered",
    urgency: payload.urgency ?? "high",
    priority: payload.priority?.name ?? null,
    service: payload.service,
    team: payload.team,
    assignees: (payload.assignTo ?? []).map(({ id, name }) => ({ id, name })),
    createdAt: payload.stagedAt,
    updatedAt: payload.stagedAt,
    htmlUrl: "",
    details: payload.details ?? null,
    escalationPolicy: payload.escalationPolicy,
    acknowledgers: [],
    incidentKey: payload.incidentKey ?? null,
    resolvedAt: null,
    alertCount: 0,
    firstAlert: null,
    conferenceUrl: null,
  };
}

/** The incidents pending actions open that PagerDuty doesn't have yet, with later changes applied. */
export function pendingIncidents(pending: Pending, resolve: Resolve, me: PagerDutyUserRef): PagerDutyIncidentDetails[] {
  return pending.flatMap(({ action }) => action.kind === "createIncident" && resolve(action.payload.ref) === action.payload.ref
    ? [overlayIncident(pendingIncident(action.payload), pending, resolve, me)] : []);
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

/** The pending overrides on schedule `scheduleId` PagerDuty doesn't have yet. */
function pendingOverrides(scheduleId: string, pending: Pending, resolve: Resolve): PagerDutyOverride[] {
  return pending.flatMap(({ action }) =>
    (action.kind === "createOverride" || action.kind === "createOverrideForOthers")
      && action.payload.scheduleId === scheduleId && resolve(action.payload.ref) === action.payload.ref
      ? [{ id: action.payload.ref, user: { id: action.payload.user.id, name: action.payload.user.name },
        start: action.payload.start, end: action.payload.end }]
      : []);
}

/** Whether two ISO 8601 spans overlap. */
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

/**
 * A schedule's overrides in `window` as if pending ones were made and removed: those pending
 * removal dropped, those pending creation added, ordered by start.
 */
export function overlayOverrides(
  overrides: readonly PagerDutyOverride[], scheduleId: string, window: { since: string; until: string },
  pending: Pending, resolve: Resolve,
): PagerDutyOverride[] {
  const removed = new Set(pending.flatMap(({ action }) =>
    action.kind === "deleteOverride" && action.payload.scheduleId === scheduleId ? [resolve(action.payload.overrideId)] : []));
  const span = { start: window.since, end: window.until };
  return [...overrides, ...pendingOverrides(scheduleId, pending, resolve).filter(override => overlaps(override, span))]
    .filter(override => !removed.has(override.id))
    .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * A schedule's shifts as if the overrides pending creation were made: each covers whatever it
 * overlaps, cut at its ends. An override pending removal can't be undone from the shifts alone,
 * since they don't say who it displaced.
 */
export function overlayShifts(
  shifts: readonly PagerDutyShift[], scheduleId: string, window: { since: string; until: string },
  pending: Pending, resolve: Resolve,
): PagerDutyShift[] {
  let result = [...shifts];
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const override of pendingOverrides(scheduleId, pending, resolve)) {
    const start = Math.max(Date.parse(override.start), Date.parse(window.since));
    const end = Math.min(Date.parse(override.end), Date.parse(window.until));
    if (!(start < end)) continue;
    const span = { start: iso(start), end: iso(end) };
    result = result.flatMap(shift => !overlaps(shift, span) ? [shift] : [
      ...(Date.parse(shift.start) < start ? [{ ...shift, end: span.start }] : []),
      ...(Date.parse(shift.end) > end ? [{ ...shift, start: span.end }] : []),
    ]);
    result.push({ user: override.user, ...span });
  }
  return result.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
