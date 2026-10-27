// What an agent is shown of an event: Exchange's event, cut to the binding's level of detail. This
// is the only place `EventInfo` is built from Graph's data, so a field the binding doesn't reveal
// can't reach the agent by another path. Each level shows what the Exchange sharing role of the
// same name shows a sharee: free/busy (times and show-as), limited (plus subject and location), full
// (everything). A private event, unless the binding shows them, is a busy block at any level.
//
// Also recurrence patterns, in words and as Graph writes them.

import type { DetailLevel } from "./calendar-scope";
import { DAY_MS, dateInZone, isoInZone, validDate } from "./calendar-time";
import { WEEKDAYS, type GraphEvent, type Weekday } from "./calendar-graph";
import type { EventInfo, Recurrence } from "./calendar-types";

/** How a binding shows events. */
export type EventView = {
  details: DetailLevel;
  /** Whether private events are shown in detail ("show") or as busy blocks ("busy"). */
  privateEvents: "busy" | "show";
  /** The user's zone: every time is written in it. */
  zone: string;
};

/**
 * Whether Exchange hides an event from people the calendar is shared with. Confidential is hidden
 * here too, though Exchange shows it: the side that reveals less.
 */
export function isPrivate(event: Pick<GraphEvent, "sensitivity">): boolean {
  return event.sensitivity === "private" || event.sensitivity === "confidential";
}

/** Whether a view hides this event's details, showing it as a busy block. */
export function hidesDetails(event: Pick<GraphEvent, "sensitivity">, view: EventView): boolean {
  return isPrivate(event) && view.privateEvents === "busy";
}

/** An event's start and end as the agent reads them: instants in the user's zone, or dates for an all-day event. */
export function eventTimes(event: Pick<GraphEvent, "startMs" | "endMs" | "allDay" | "originalZone">, zone: string): { start: string; end: string } {
  if (!event.allDay) return { start: isoInZone(event.startMs, zone), end: isoInZone(event.endMs, zone) };
  // An all-day event is midnight to midnight where it was made; its dates are read there.
  const where = event.originalZone ?? zone;
  const start = dateInZone(event.startMs, where);
  const end = dateInZone(Math.max(event.endMs, event.startMs + DAY_MS), where);
  return { start, end: end > start ? end : start };
}

/** An event at a view's level of detail. `calendarId` is set for bindings that span calendars. */
export function eventInfo(event: GraphEvent, view: EventView, calendarId?: string): EventInfo {
  const times = eventTimes(event, view.zone);
  const base: EventInfo = {
    id: event.id,
    ...(calendarId ? { calendarId } : {}),
    ...times,
    allDay: event.allDay,
    showAs: event.showAs,
  };
  // Free/busy is times and show-as, as Exchange's free/busy role shows them, and nothing else.
  if (view.details === "freeBusy") return base;
  const recurring = event.type === "occurrence" || event.type === "exception" ? { recurring: true as const } : {};
  if (hidesDetails(event, view)) return { ...base, ...recurring, private: true };
  const limited: EventInfo = {
    ...base,
    ...recurring,
    subject: event.subject,
    ...(event.location ? { location: event.location } : {}),
    ...(event.cancelled ? { cancelled: true as const } : {}),
  };
  if (view.details === "limited") return limited;
  const others = event.attendees.filter(attendee => attendee.address.toLowerCase() !== event.organizer?.address.toLowerCase());
  return {
    ...limited,
    ...(event.organizer ? { organizer: event.organizer } : {}),
    isOrganizer: event.isOrganizer,
    ...(others.length ? { attendees: event.attendees.map(({ address, name, type, response }) => ({ address, ...(name ? { name } : {}), type, response })) } : {}),
    ...(event.isOrganizer ? {} : { response: event.response, responseRequested: event.responseRequested }),
    ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}),
    ...(event.categories.length ? { categories: [...event.categories] } : {}),
    importance: event.importance,
    sensitivity: event.sensitivity,
    ...(event.preview ? { preview: event.preview } : {}),
    ...(event.webLink ? { webLink: event.webLink } : {}),
  };
}

/** Whether a view lets an event's subject and location be searched. */
export function searchable(event: GraphEvent, view: EventView): boolean {
  return view.details !== "freeBusy" && !hidesDetails(event, view);
}

// -- recurrence ---------------------------------------------------------------------------------

const DAY_NAMES: Record<Weekday, string> = {
  sunday: "Sunday", monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday",
};
const ORDINALS: Record<string, string> = { first: "first", second: "second", third: "third", fourth: "fourth", last: "last" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1]?.slice(0, 3) ?? ""} ${day}, ${year}`;
}

/** A Graph `patternedRecurrence` in words, "Every 2 weeks on Monday and Thursday, until Dec 31, 2026". Null if unreadable. */
export function recurrenceWords(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const { pattern, range } = value as { pattern?: Record<string, unknown>; range?: Record<string, unknown> };
  if (!pattern || typeof pattern.type !== "string") return null;
  const interval = typeof pattern.interval === "number" && pattern.interval > 1 ? pattern.interval : 1;
  const days = Array.isArray(pattern.daysOfWeek)
    ? pattern.daysOfWeek.filter((day): day is Weekday => (WEEKDAYS as readonly unknown[]).includes(day)).map(day => DAY_NAMES[day]) : [];
  const every = (unit: string) => interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  const ordinal = typeof pattern.index === "string" ? ORDINALS[pattern.index] ?? "first" : "first";
  const month = typeof pattern.month === "number" ? MONTHS[pattern.month - 1] : undefined;
  let words: string;
  switch (pattern.type) {
    case "daily": words = every("day"); break;
    case "weekly": words = `${every("week")}${days.length ? ` on ${list(days)}` : ""}`; break;
    case "absoluteMonthly": words = `${every("month")} on day ${String(pattern.dayOfMonth ?? "")}`; break;
    case "relativeMonthly": words = `${every("month")} on the ${ordinal} ${list(days)}`; break;
    case "absoluteYearly": words = `${every("year")} on ${month ?? ""} ${String(pattern.dayOfMonth ?? "")}`; break;
    case "relativeYearly": words = `${every("year")} on the ${ordinal} ${list(days)} of ${month ?? ""}`; break;
    default: return null;
  }
  if (range?.type === "endDate" && typeof range.endDate === "string" && /^\d{4}-\d\d-\d\d$/.test(range.endDate)) words += `, until ${shortDate(range.endDate)}`;
  else if (range?.type === "numbered" && typeof range.numberOfOccurrences === "number") words += `, ${range.numberOfOccurrences} times`;
  return words;
}

/** The day of the week of a date, as Graph names it. */
function weekdayOf(date: string): Weekday {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}

/** The most occurrences a series made here may have. */
const MAX_OCCURRENCES = 500;
const MAX_INTERVAL = 99;

/**
 * Checks a recurrence an agent passed. Throws, saying what is wrong.
 * @param startDate The first occurrence's date in the user's zone, which a monthly or yearly series repeats on.
 */
export function checkRecurrence(input: unknown, startDate: string): Recurrence {
  if (input === null || typeof input !== "object") throw new Error("recurrence must be { every, interval?, days?, count?, until? }.");
  const { every, interval, days, count, until } = input as Record<string, unknown>;
  if (every !== "day" && every !== "week" && every !== "month" && every !== "year") throw new Error('recurrence.every must be "day", "week", "month" or "year".');
  if (interval !== undefined && (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > MAX_INTERVAL)) {
    throw new Error(`recurrence.interval must be a whole number from 1 to ${MAX_INTERVAL}.`);
  }
  let checkedDays: Weekday[] | undefined;
  if (every === "week") {
    const given = days ?? [weekdayOf(startDate)];
    if (!Array.isArray(given) || given.length === 0 || given.some(day => !(WEEKDAYS as readonly unknown[]).includes(day))) {
      throw new Error('recurrence.days must list days like "monday", "thursday".');
    }
    checkedDays = [...new Set(given as Weekday[])];
  } else if (days !== undefined) {
    throw new Error("recurrence.days is only for weekly recurrence.");
  }
  if (count !== undefined && until !== undefined) throw new Error("Pass recurrence.count or recurrence.until, not both.");
  if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_OCCURRENCES)) {
    throw new Error(`recurrence.count must be a whole number from 1 to ${MAX_OCCURRENCES}.`);
  }
  if (until !== undefined && (typeof until !== "string" || !validDate(until) || until < startDate)) {
    throw new Error("recurrence.until must be a date (2026-12-31) on or after the first occurrence.");
  }
  return {
    every,
    ...(interval !== undefined && interval !== 1 ? { interval: interval as number } : {}),
    ...(checkedDays ? { days: checkedDays } : {}),
    ...(count !== undefined ? { count: count as number } : {}),
    ...(until !== undefined ? { until: until as string } : {}),
  };
}

/** A checked recurrence as Graph's `patternedRecurrence`, starting on `startDate` in `zone`. */
export function recurrenceJson(recurrence: Recurrence, startDate: string, zone: string): Record<string, unknown> {
  const [, month, day] = startDate.split("-").map(Number) as [number, number, number];
  const interval = recurrence.interval ?? 1;
  const pattern = recurrence.every === "day" ? { type: "daily", interval }
    : recurrence.every === "week" ? { type: "weekly", interval, daysOfWeek: recurrence.days, firstDayOfWeek: "sunday" }
    : recurrence.every === "month" ? { type: "absoluteMonthly", interval, dayOfMonth: day }
    : { type: "absoluteYearly", interval, dayOfMonth: day, month };
  const range = recurrence.count !== undefined ? { type: "numbered", startDate, numberOfOccurrences: recurrence.count, recurrenceTimeZone: zone }
    : recurrence.until !== undefined ? { type: "endDate", startDate, endDate: recurrence.until, recurrenceTimeZone: zone }
    : { type: "noEnd", startDate, recurrenceTimeZone: zone };
  return { pattern, range };
}

/** A checked recurrence in words, for the approver. */
export function describeRecurrence(recurrence: Recurrence, startDate: string, zone: string): string {
  return recurrenceWords(recurrenceJson(recurrence, startDate, zone)) ?? "Repeating";
}
