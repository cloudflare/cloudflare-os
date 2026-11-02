// Finds times people are free, from their free/busy and working hours. Graph's `findMeetingTimes`
// isn't used: it answered "OrganizerUnavailable" with no suggestions for a window the organizer was
// free in (verified live). This is deterministic, and every slot can be explained from the busy
// blocks `getAvailability` shows.

import { MINUTE_MS, dateInZone, localToInstant, nextDate } from "./calendar-time";
import { WEEKDAYS, type Weekday } from "./calendar-graph";

/** A half-open span of time, [startMs, endMs). */
export type Span = { startMs: number; endMs: number };

/** When someone works, in their own zone. */
export type Hours = { days: readonly Weekday[]; start: string; end: string; zone: string };

/** One person, as the solver sees them. */
export type Attendance = {
  busy: readonly (Span & { status: string })[];
  hours?: Hours;
};

/** What `freeTimes` solves for. */
export type FreeTimeQuery = {
  window: Span;
  durationMs: number;
  people: readonly Attendance[];
  workingHoursOnly: boolean;
  tentativeIsFree: boolean;
  limit: number;
  /** Slots start on this boundary (15 minutes by default), the way people schedule. */
  stepMs?: number;
};

/** Sorted, non-overlapping spans covering the same time as `spans`. */
export function merge(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(span => span.endMs > span.startMs).toSorted((a, b) => a.startMs - b.startMs);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

/** The time in both sorted span lists. */
export function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const result: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i]!.startMs, b[j]!.startMs);
    const endMs = Math.min(a[i]!.endMs, b[j]!.endMs);
    if (endMs > startMs) result.push({ startMs, endMs });
    if (a[i]!.endMs < b[j]!.endMs) i++;
    else j++;
  }
  return result;
}

/** The time in sorted `spans` not in sorted `removed`. */
export function subtract(spans: readonly Span[], removed: readonly Span[]): Span[] {
  const result: Span[] = [];
  let j = 0;
  for (const span of spans) {
    let cursor = span.startMs;
    while (j < removed.length && removed[j]!.endMs <= cursor) j++;
    let k = j;
    while (k < removed.length && removed[k]!.startMs < span.endMs) {
      if (removed[k]!.startMs > cursor) result.push({ startMs: cursor, endMs: removed[k]!.startMs });
      cursor = Math.max(cursor, removed[k]!.endMs);
      k++;
    }
    if (cursor < span.endMs) result.push({ startMs: cursor, endMs: span.endMs });
  }
  return result;
}

/**
 * Someone's working hours over a window, as spans. Hours that end at or before they start (a night
 * shift) run into the next day. Each day's hours are placed in the person's own zone, so a
 * colleague in another zone is free at their own 9 to 5.
 */
export function workingSpans(hours: Hours, window: Span): Span[] {
  const spans: Span[] = [];
  // From the day before, so a night shift that began yesterday is counted.
  let date = nextDate(dateInZone(window.startMs, hours.zone), -1);
  const last = dateInZone(window.endMs, hours.zone);
  const overnight = hours.end <= hours.start;
  for (let days = 0; date <= last && days < 400; days++, date = nextDate(date)) {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
    if (!hours.days.includes(weekday)) continue;
    const startMs = localToInstant(`${date}T${hours.start}`, hours.zone);
    const endMs = localToInstant(`${overnight ? nextDate(date) : date}T${hours.end}`, hours.zone);
    spans.push({ startMs, endMs });
  }
  return intersect(merge(spans), [window]);
}

/**
 * Windows everyone is free for at least the duration, earliest first, each starting on a step
 * boundary. A person's tentative time is busy unless `tentativeIsFree`; working elsewhere is free,
 * as Outlook's scheduling assistant counts it. With `workingHoursOnly`, only time inside everyone's
 * working hours counts; people whose hours aren't known don't narrow it.
 */
export function freeTimes(query: FreeTimeQuery): Span[] {
  const step = query.stepMs ?? 15 * MINUTE_MS;
  let free: Span[] = [query.window];
  for (const person of query.people) {
    if (query.workingHoursOnly && person.hours) free = intersect(free, workingSpans(person.hours, query.window));
    const busy = merge(person.busy.filter(block => block.status !== "workingElsewhere" && !(query.tentativeIsFree && block.status === "tentative")));
    free = subtract(free, busy);
  }
  const slots: Span[] = [];
  for (const span of free) {
    const startMs = Math.ceil(span.startMs / step) * step;
    if (span.endMs - startMs >= query.durationMs) slots.push({ startMs, endMs: span.endMs });
    if (slots.length >= query.limit) break;
  }
  return slots;
}

