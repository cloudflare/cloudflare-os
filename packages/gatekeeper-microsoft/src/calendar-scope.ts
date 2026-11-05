// What a Calendar binding covers, as plain data: every calendar the user has, availability only, or
// one calendar at a level of detail. Also the resource URL grammar
// (`https://outlook.office.com/calendar/…`) and the ladder of Exchange sharing roles that observers
// are admitted by: a role passes if it sees as much as a binding revealed. See
// plans/microsoft-calendar.md.

import { isMailId } from "./outlook-graph";

/** What a binding may do, least to most. */
export const CALENDAR_ACCESS_LEVELS = ["read", "edit", "schedule"] as const;
export type CalendarAccessLevel = (typeof CALENDAR_ACCESS_LEVELS)[number];

/** How much of each event a calendar binding reveals, least to most; Exchange's own sharing levels. */
export const DETAIL_LEVELS = ["freeBusy", "limited", "full"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Whose calendar: the user's own, or one shared with them, by its owner's object ID. */
export type CalendarOwnerRef = { kind: "me" } | { kind: "shared"; id: string; address: string };

/** One calendar, by immutable ID and by its MAPI entry ID (what its events name as their parent). */
export type BoundCalendar = { id: string; entryId: string; name: string };

/** What a Calendar binding covers, resolved to IDs, and what it may do. */
export type CalendarScope = { access: CalendarAccessLevel } & (
  | { kind: "all" }
  | { kind: "availability" }
  | {
    kind: "calendar";
    owner: CalendarOwnerRef;
    calendar: BoundCalendar;
    details: DetailLevel;
    /** "busy" shows a private event as a busy block, as Exchange shows it to everyone but the owner and private-access delegates. */
    privateEvents: "busy" | "show";
  }
);

/** The lesser of two access levels. */
export function lowerAccess(a: CalendarAccessLevel, b: CalendarAccessLevel): CalendarAccessLevel {
  return CALENDAR_ACCESS_LEVELS.indexOf(a) <= CALENDAR_ACCESS_LEVELS.indexOf(b) ? a : b;
}

/** Whether `access` includes `needed`. */
export function allows(access: CalendarAccessLevel, needed: CalendarAccessLevel): boolean {
  return CALENDAR_ACCESS_LEVELS.indexOf(access) >= CALENDAR_ACCESS_LEVELS.indexOf(needed);
}

/** The most a binding can be allowed to do: nothing it can't fully see can be changed through it. */
export function accessCeiling(scope: CalendarScope): CalendarAccessLevel {
  if (scope.kind === "availability") return "read";
  if (scope.kind === "calendar" && scope.details !== "full") return "read";
  return "schedule";
}

// -- sharing roles ------------------------------------------------------------------------------

/**
 * Exchange's calendar sharing roles, least to most. A role sees everything the ones before it do:
 * free/busy, then titles and locations, then all details; editors and delegates see all details,
 * and only delegates with private access see private events.
 */
export const SHARING_ROLES = [
  "none", "freeBusyRead", "limitedRead", "read", "write", "delegateWithoutPrivateEventAccess", "delegateWithPrivateEventAccess",
] as const;
export type SharingRole = (typeof SHARING_ROLES)[number];

/** What a read revealed of a calendar: a detail level, or a private event in detail. */
export type RevealLevel = DetailLevel | "private";

/** The least role that sees as much as each reveal level. */
const ROLE_FOR: Record<RevealLevel, SharingRole> = {
  freeBusy: "freeBusyRead", limited: "limitedRead", full: "read", private: "delegateWithPrivateEventAccess",
};

/** A role as Graph names it; anything unknown (`custom`, a future one) counts as none. */
export function sharingRole(value: unknown): SharingRole {
  return (SHARING_ROLES as readonly unknown[]).includes(value) ? value as SharingRole : "none";
}

/** Whether a role sees what a reveal level showed. */
export function roleSees(role: SharingRole, level: RevealLevel): boolean {
  return SHARING_ROLES.indexOf(role) >= SHARING_ROLES.indexOf(ROLE_FOR[level]);
}

// -- the URL grammar ----------------------------------------------------------------------------

/** The origin binding URLs are written with; two other Outlook origins are read too. */
export const CALENDAR_ORIGIN = "https://outlook.office.com";
const ORIGINS = new Set([CALENDAR_ORIGIN, "https://outlook.office365.com", "https://outlook.cloud.microsoft"]);

/** A binding URL that can't be bound; the message says why, for the user. */
export class CalendarUrlError extends Error {}

/** A binding URL as written, before IDs are resolved: what `calendar-resolve.ts` turns into a scope. */
export type CalendarUrlTarget =
  | { kind: "all"; access?: CalendarAccessLevel }
  | { kind: "availability" }
  | {
    kind: "calendar";
    /** The owner's address; absent for the user's own. */
    owner?: string;
    /** `default`, or an immutable calendar ID. */
    calendar: "default" | { id: string };
    details: DetailLevel;
    privateEvents: "busy" | "show";
    access?: CalendarAccessLevel;
  };

const ADDRESS = /^[^\s@<>()",;:/]+@[^\s@<>()",;:/]+\.[^\s@<>()",;:/]+$/;

/** Reads a binding URL. Throws `CalendarUrlError`, saying what is wrong, for anything else. */
export function parseCalendarUrl(url: string): CalendarUrlTarget {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new CalendarUrlError("That isn't a URL.");
  }
  if (!ORIGINS.has(parsed.origin)) throw new CalendarUrlError("Calendar links start with https://outlook.office.com/calendar/.");
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    throw new CalendarUrlError("That calendar link is garbled.");
  }
  if (segments.shift() !== "calendar") throw new CalendarUrlError("Only Outlook calendar links can be connected here: https://outlook.office.com/calendar/…");
  const access = accessParam(parsed.searchParams.get("access"));
  // Outlook on the web's own views (`/calendar/view/week`) are the whole calendar app.
  if (segments.length === 0 || segments[0] === "view") return { kind: "all", ...(access ? { access } : {}) };
  if (segments[0] === "availability") {
    if (segments.length > 1) throw new CalendarUrlError("An availability link is just https://outlook.office.com/calendar/availability.");
    if (access !== undefined && access !== "read") throw new CalendarUrlError("Availability can only be read.");
    return { kind: "availability" };
  }
  const owner = ADDRESS.test(segments[0]!) ? segments.shift()!.toLowerCase() : undefined;
  let calendar: "default" | { id: string };
  if (segments.length === 1 && segments[0] === "default") calendar = "default";
  else if (segments.length === 2 && segments[0] === "id" && isMailId(segments[1])) calendar = { id: segments[1] };
  else throw new CalendarUrlError("A calendar link names one calendar: …/calendar/default, or …/calendar/id/<calendar ID>, after the owner's address for someone else's.");
  const details = parsed.searchParams.get("details") ?? "full";
  if (!(DETAIL_LEVELS as readonly string[]).includes(details)) throw new CalendarUrlError('details must be "freeBusy", "limited" or "full".');
  const privateParam = parsed.searchParams.get("private") ?? "busy";
  if (privateParam !== "busy" && privateParam !== "show") throw new CalendarUrlError('private must be "busy" or "show".');
  if (privateParam === "show" && details !== "full") throw new CalendarUrlError("Private events can only be shown with full details.");
  if (access !== undefined && access !== "read" && details !== "full") {
    throw new CalendarUrlError("Only a binding that shows full details can change events.");
  }
  return {
    kind: "calendar", ...(owner ? { owner } : {}), calendar, details: details as DetailLevel,
    privateEvents: privateParam, ...(access ? { access } : {}),
  };
}

function accessParam(value: string | null): CalendarAccessLevel | undefined {
  if (value === null) return undefined;
  if (!(CALENDAR_ACCESS_LEVELS as readonly string[]).includes(value)) throw new CalendarUrlError('access must be "read", "edit" or "schedule".');
  return value as CalendarAccessLevel;
}

/** The binding URL for a scope, by ID, as the configurator writes it and `parseCalendarUrl` reads it back. */
export function calendarUrl(scope: CalendarScope): string {
  if (scope.kind === "availability") return `${CALENDAR_ORIGIN}/calendar/availability`;
  const query = new URLSearchParams();
  if (scope.kind === "all") {
    query.set("access", scope.access);
    return `${CALENDAR_ORIGIN}/calendar/?${query}`;
  }
  const owner = scope.owner.kind === "shared" ? `${encodeURIComponent(scope.owner.address)}/` : "";
  query.set("details", scope.details);
  if (scope.privateEvents === "show") query.set("private", "show");
  query.set("access", scope.access);
  return `${CALENDAR_ORIGIN}/calendar/${owner}id/${encodeURIComponent(scope.calendar.id)}?${query}`;
}

const DETAIL_WORDS: Record<DetailLevel, string> = {
  freeBusy: "free/busy only (times, no titles)",
  limited: "titles and locations",
  full: "all details",
};

/** What a binding covers, in words, for its description and the agent. */
export function describeScope(scope: CalendarScope, ownerName: string): string {
  switch (scope.kind) {
    case "all": return `All of ${ownerName}'s calendars, and when people in the organization are free.`;
    case "availability": return "When people in the organization are free or busy, without any event's details.";
    case "calendar": {
      const whose = scope.owner.kind === "shared" ? `${scope.owner.address}'s calendar` : `${ownerName}'s calendar`;
      const privacy = scope.details === "freeBusy" ? "" : scope.privateEvents === "show" ? ", private events included" : ", private events as busy time";
      return `${whose} "${scope.calendar.name}": ${DETAIL_WORDS[scope.details]}${privacy}.`;
    }
  }
}
