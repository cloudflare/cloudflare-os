// Microsoft Graph for calendars: the only Calendar code that builds requests. Every request asks
// for immutable IDs and for times in UTC (`Prefer: outlook.timezone="UTC"`), which are unambiguous
// and are put in the user's zone only when shown, and every response is parsed here into checked
// shapes: nothing from Graph is used unvalidated.
//
// Two of Graph's answers about where an event lives are wrong but plausible (verified live): an
// event path's calendar segment is ignored (`/calendars/{A}/events/{idInB}` answers 200), and
// `/events/{id}/calendar` names the default calendar for an event in any other. So an event's
// calendar is read from Exchange's own record of its parent folder, `PidTagParentEntryId`
// (`Binary 0x0E09`), compared with each calendar's `PidTagEntryId` (`Binary 0x0FFF`).

import { GraphApiError, MAX_BATCH_REQUESTS, type BatchRequest, type GraphApi } from "./graph-api";
import { malformed, optStr, parsePage, record, type GraphPage } from "./graph-parse";
import { graphInstant, ianaZone } from "./calendar-time";
import type { CalendarOwnerRef } from "./calendar-scope";
import { visibleText } from "./outlook-content";
import { idPath, isMailId, type GraphAddress } from "./outlook-graph";

/** The `Prefer` values every calendar request sends: immutable IDs, times in UTC. */
export const CALENDAR_PREFER = ['IdType="ImmutableId"', 'outlook.timezone="UTC"'];

/** An event's parent folder entry ID (`PidTagParentEntryId`): what membership is checked by. */
const PARENT_ENTRY_ID = "Binary 0x0E09";
/** A calendar folder's own entry ID (`PidTagEntryId`), compared with its events' parent. */
const ENTRY_ID = "Binary 0x0FFF";

/** The event fields every listing and read selects. */
const EVENT_SELECT = [
  "id", "changeKey", "subject", "start", "end", "isAllDay", "showAs", "sensitivity", "location", "organizer", "attendees",
  "responseStatus", "responseRequested", "isOrganizer", "isOnlineMeeting", "onlineMeeting", "categories", "importance",
  "bodyPreview", "webLink", "type", "seriesMasterId", "isCancelled", "allowNewTimeProposals", "originalStartTimeZone", "isReminderOn", "reminderMinutesBeforeStart",
].join(",");

const CALENDAR_SELECT = "id,name,hexColor,isDefaultCalendar,canEdit,owner";

/** A calendar, parsed. */
export type GraphCalendar = {
  id: string;
  /** Its `PidTagEntryId`, base64: what its events name as their parent. */
  entryId: string;
  name: string;
  owner: GraphAddress;
  isDefault: boolean;
  canEdit: boolean;
  color?: string;
};

export type GraphAttendee = GraphAddress & {
  type: "required" | "optional" | "resource";
  response: GraphResponse;
};

export type GraphResponse = "none" | "organizer" | "accepted" | "tentativelyAccepted" | "declined" | "notResponded";
export type GraphShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
export type GraphSensitivity = "normal" | "personal" | "private" | "confidential";

/** An event or occurrence, parsed. Times are instants; an all-day event's are midnights as Exchange holds them. */
export type GraphEvent = {
  id: string;
  changeKey: string;
  /** Its parent folder's entry ID, when the read expanded it: `event()` and `parents()` do, `view()` doesn't (its rows go through `parents()`). */
  parentEntryId?: string;
  subject: string;
  location: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** The zone it was made in (IANA), which decides an all-day event's dates. */
  originalZone?: string;
  showAs: GraphShowAs;
  sensitivity: GraphSensitivity;
  organizer?: GraphAddress;
  isOrganizer: boolean;
  attendees: GraphAttendee[];
  response: GraphResponse;
  responseRequested: boolean;
  joinUrl?: string;
  categories: string[];
  importance: "low" | "normal" | "high";
  preview: string;
  webLink: string;
  type: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string;
  cancelled: boolean;
  allowNewTimeProposals: boolean;
  /** Minutes before the start, or null for no reminder; absent when the read didn't say. */
  reminder?: number | null;
};

/** One person's free/busy, parsed from `getSchedule`. */
export type GraphSchedule = {
  address: string;
  items: { startMs: number; endMs: number; status: Exclude<GraphShowAs, "free" | "unknown"> }[];
  workingHours?: { days: Weekday[]; start: string; end: string; timeZone: string };
  /** Why Exchange gave nothing for this person. */
  error?: string;
};

/** One entry of a calendar's sharing list, as the owner reads it. */
export type GraphCalendarPermission = {
  /** Absent for the organization-wide default (`My Organization`) and for anonymous access. */
  address?: string;
  role: string;
  insideOrganization: boolean;
  removable: boolean;
};

/** Text an organizer wrote, as a person sees it: invisible characters dropped. */
function shown(value: unknown): string {
  return typeof value === "string" ? visibleText(value).trim() : "";
}

function address(value: unknown): GraphAddress | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const email = (value as { emailAddress?: unknown }).emailAddress;
  if (email === null || typeof email !== "object") return undefined;
  const { address: raw, name } = email as { address?: unknown; name?: unknown };
  if (typeof raw !== "string" || raw === "") return undefined;
  const display = shown(name);
  return { address: raw, ...(display !== "" && display !== raw ? { name: display } : {}) };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? value as T : fallback;
}

const RESPONSES = ["none", "organizer", "accepted", "tentativelyAccepted", "declined", "notResponded"] as const;
const SHOW_AS = ["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"] as const;
const SENSITIVITIES = ["normal", "personal", "private", "confidential"] as const;
const TYPES = ["singleInstance", "occurrence", "exception", "seriesMaster"] as const;

/** The value of one single-value extended property a read expanded. */
function extended(json: Record<string, unknown>, id: string): string | undefined {
  const list = json.singleValueExtendedProperties;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const { id: name, value } = entry as { id?: unknown; value?: unknown };
    // Graph echoes the ID with its own capitalization ("Binary 0xe09").
    if (typeof name === "string" && typeof value === "string" && name.toLowerCase().replace(/0x0*/, "0x") === id.toLowerCase().replace(/0x0*/, "0x")) return value;
  }
  return undefined;
}

/** Parses a calendar that was read with its entry ID expanded. */
function parseCalendar(row: unknown): GraphCalendar {
  const json = record(row, "calendar");
  const id = optStr(json, "id");
  const entryId = extended(json, ENTRY_ID);
  if (id === undefined || entryId === undefined) malformed("calendar");
  const owner = address({ emailAddress: json.owner }) ?? { address: "" };
  const color = optStr(json, "hexColor");
  return {
    id, entryId, name: shown(json.name) || "Calendar", owner,
    isDefault: json.isDefaultCalendar === true, canEdit: json.canEdit === true,
    ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color: color.toLowerCase() } : {}),
  };
}

/** Parses an event or occurrence. */
export function parseEvent(row: unknown): GraphEvent {
  const json = record(row, "event");
  const id = optStr(json, "id");
  const startMs = graphInstant(json.start);
  const endMs = graphInstant(json.end);
  if (id === undefined || startMs === undefined || endMs === undefined) malformed("event");
  const location = json.location !== null && typeof json.location === "object" ? shown((json.location as { displayName?: unknown }).displayName) : "";
  const responseStatus = json.responseStatus !== null && typeof json.responseStatus === "object" ? (json.responseStatus as { response?: unknown }).response : undefined;
  const meeting = json.onlineMeeting !== null && typeof json.onlineMeeting === "object" ? (json.onlineMeeting as { joinUrl?: unknown }).joinUrl : undefined;
  const organizer = address(json.organizer);
  const attendees = Array.isArray(json.attendees) ? json.attendees.flatMap((entry): GraphAttendee[] => {
    const who = address(entry);
    if (who === undefined) return [];
    const { type, status } = entry as { type?: unknown; status?: unknown };
    const response = status !== null && typeof status === "object" ? (status as { response?: unknown }).response : undefined;
    return [{ ...who, type: oneOf(type, ["required", "optional", "resource"], "required"), response: oneOf(response, RESPONSES, "none") }];
  }) : [];
  const parent = extended(json, PARENT_ENTRY_ID);
  const originalZone = ianaZone(optStr(json, "originalStartTimeZone"));
  return {
    id,
    changeKey: optStr(json, "changeKey") ?? "",
    ...(parent ? { parentEntryId: parent } : {}),
    subject: shown(json.subject),
    location,
    startMs,
    endMs,
    allDay: json.isAllDay === true,
    ...(originalZone ? { originalZone } : {}),
    showAs: oneOf(json.showAs, SHOW_AS, "busy"),
    // Anything unrecognized is treated as private, the side that reveals less.
    sensitivity: json.sensitivity === undefined ? "normal" : oneOf(json.sensitivity, SENSITIVITIES, "private"),
    ...(organizer ? { organizer } : {}),
    isOrganizer: json.isOrganizer === true,
    attendees,
    response: oneOf(responseStatus, RESPONSES, "none"),
    responseRequested: json.responseRequested === true,
    ...(json.isOnlineMeeting === true && typeof meeting === "string" && meeting.startsWith("https://") ? { joinUrl: meeting } : {}),
    categories: Array.isArray(json.categories) ? json.categories.filter((name): name is string => typeof name === "string") : [],
    importance: oneOf(json.importance, ["low", "normal", "high"], "normal"),
    preview: shown(json.bodyPreview),
    webLink: optStr(json, "webLink") ?? "",
    type: oneOf(json.type, TYPES, "singleInstance"),
    ...(optStr(json, "seriesMasterId") ? { seriesMasterId: optStr(json, "seriesMasterId") } : {}),
    cancelled: json.isCancelled === true,
    allowNewTimeProposals: json.allowNewTimeProposals === true,
    ...(json.isReminderOn === false ? { reminder: null }
      : json.isReminderOn === true && typeof json.reminderMinutesBeforeStart === "number" ? { reminder: json.reminderMinutesBeforeStart } : {}),
  };
}

const BUSY_STATUSES = ["tentative", "busy", "oof", "workingElsewhere"] as const;

/** One `getSchedule` answer. Subjects and locations are never kept, even where Exchange gave them. */
export function parseSchedule(row: unknown): GraphSchedule {
  const json = record(row, "schedule");
  // Lowercased: what an availability unit is keyed on.
  const addressValue = optStr(json, "scheduleId")?.toLowerCase();
  if (addressValue === undefined) malformed("schedule");
  const error = json.error !== null && typeof json.error === "object" ? json.error as { message?: unknown; responseCode?: unknown } : undefined;
  if (error) return { address: addressValue, items: [], error: scheduleError(error.responseCode) };
  // A person who shares nothing gets no `error`, just a view of nothing but "4" (no information), or none.
  if (/^4*$/.test(optStr(json, "availabilityView") ?? "")) return { address: addressValue, items: [], error: "Their free/busy isn't shared with you." };
  const items = Array.isArray(json.scheduleItems) ? json.scheduleItems.flatMap(entry => {
    if (entry === null || typeof entry !== "object") return [];
    const { status, start, end } = entry as { status?: unknown; start?: unknown; end?: unknown };
    const startMs = graphInstant(start);
    const endMs = graphInstant(end);
    if (startMs === undefined || endMs === undefined || endMs <= startMs) return [];
    if (!(BUSY_STATUSES as readonly unknown[]).includes(status)) return [];
    return [{ startMs, endMs, status: status as (typeof BUSY_STATUSES)[number] }];
  }) : [];
  items.sort((a, b) => a.startMs - b.startMs);
  const workingHours = parseWorkingHours(json.workingHours);
  return {
    address: addressValue,
    items,
    ...(workingHours ? { workingHours } : {}),
  };
}

/** Exchange's working hours: days, a start and end ("08:00"), and the zone they are in (often a Windows name). */
function parseWorkingHours(value: unknown): GraphSchedule["workingHours"] {
  if (value === null || typeof value !== "object") return undefined;
  const hours = value as Record<string, unknown>;
  const zoneName = hours.timeZone !== null && typeof hours.timeZone === "object" ? (hours.timeZone as { name?: unknown }).name : undefined;
  const clock = (time: unknown) => typeof time === "string" && /^\d\d:\d\d/.test(time) ? time.slice(0, 5) : undefined;
  const start = clock(hours.startTime);
  const end = clock(hours.endTime);
  const days = Array.isArray(hours.daysOfWeek) ? hours.daysOfWeek.filter((day): day is Weekday => typeof day === "string" && (WEEKDAYS as readonly string[]).includes(day)) : [];
  return start && end && days.length > 0 && typeof zoneName === "string" ? { days, start, end, timeZone: zoneName } : undefined;
}

/** Exchange's reason codes for a schedule it couldn't give, in words. Its messages ("Proxy web request failed.") say nothing useful. */
function scheduleError(code: unknown): string {
  switch (code) {
    case "5016":
    case "5009": return "Not found in your organization, or their free/busy isn't available from here.";
    case "5006": return "Their calendar isn't shared, even as free/busy.";
    default: return "Their free/busy couldn't be read.";
  }
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Parses one entry of a calendar's sharing list. */
export function parsePermission(row: unknown): GraphCalendarPermission {
  const json = record(row, "calendar permission");
  const email = json.emailAddress !== null && typeof json.emailAddress === "object" ? json.emailAddress as { address?: unknown } : {};
  const addressValue = typeof email.address === "string" && email.address.includes("@") ? email.address.toLowerCase() : undefined;
  return {
    ...(addressValue ? { address: addressValue } : {}),
    role: typeof json.role === "string" ? json.role : "none",
    insideOrganization: json.isInsideOrganization === true,
    removable: json.isRemovable !== false,
  };
}


/** A calendar owner's Graph path: `/me`, or `/users/{id}` for someone else's. */
function ownerPath(owner: CalendarOwnerRef): string {
  return owner.kind === "me" ? "/me" : `/users/${encodeURIComponent(owner.id)}`;
}

export { idPath, isMailId as isCalendarId };

/** Graph for one person's calendars. Cheap to construct; holds only the client and the owner. */
export class CalendarApi {
  readonly base: string;

  constructor(readonly api: GraphApi, readonly owner: CalendarOwnerRef) {
    this.base = ownerPath(owner);
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return await this.api.get<T>(this.base + path, { query: query ?? {}, prefer: CALENDAR_PREFER });
  }

  /** A GET answering null for 400, 403 and 404: an ID that isn't Exchange's, isn't here, or can't be opened. */
  async find<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
    return await this.api.request<T>("GET", this.base + path, { query: query ?? {}, prefer: CALENDAR_PREFER, allow: [400, 403, 404] });
  }

  async request<T>(method: string, path: string, body?: unknown, ifMatch?: string): Promise<T | null> {
    return await this.api.request<T>(method, this.base + path, {
      ...(body === undefined ? {} : { body }), ...(ifMatch ? { ifMatch } : {}), prefer: CALENDAR_PREFER,
    });
  }

  async page<T>(pathOrNext: string, parse: (row: unknown) => T, what: string, query?: Record<string, string | number | undefined>): Promise<GraphPage<T>> {
    const body = pathOrNext.startsWith("https://")
      ? await this.api.get<unknown>(pathOrNext, { prefer: CALENDAR_PREFER })
      : await this.get<unknown>(pathOrNext, query);
    return parsePage(body, parse, what);
  }

  /** Every calendar in the owner's list, with entry IDs. */
  async calendars(): Promise<GraphCalendar[]> {
    const calendars: GraphCalendar[] = [];
    let next: string | undefined = "/calendars";
    let query: Record<string, string | number> | undefined = {
      $select: CALENDAR_SELECT, $top: 100, $expand: `singleValueExtendedProperties($filter=id eq '${ENTRY_ID}')`,
    };
    while (next !== undefined && calendars.length < 500) {
      const page: GraphPage<GraphCalendar> = await this.page(next, parseCalendar, "calendar", query);
      calendars.push(...page.items);
      next = page.nextLink;
      query = undefined;
    }
    return calendars;
  }

  /** One calendar by ID, or the default (`calendar`), or null when it isn't the owner's or can't be opened. */
  async calendar(id: string | "default"): Promise<GraphCalendar | null> {
    const path = id === "default" ? "/calendar" : `/calendars/${idPath(id)}`;
    const body = await this.find<unknown>(path, { $select: CALENDAR_SELECT, $expand: `singleValueExtendedProperties($filter=id eq '${ENTRY_ID}')` });
    return body === null ? null : parseCalendar(body);
  }

  /** One event or occurrence with its parent's entry ID, or null when it isn't in this mailbox. */
  async event(id: string): Promise<GraphEvent | null> {
    if (!isMailId(id)) return null;
    const body = await this.find<unknown>(`/events/${idPath(id)}`, {
      $select: EVENT_SELECT, $expand: `singleValueExtendedProperties($filter=id eq '${PARENT_ENTRY_ID}')`,
    });
    return body === null ? null : parseEvent(body);
  }

  /**
   * What undoing a change to an event turns on: its parent's entry ID, and whether the user
   * organizes it with attendees, so a change would mail them. Null when it is gone.
   */
  async placement(id: string): Promise<{ parentEntryId?: string; ownMeeting: boolean } | null> {
    if (!isMailId(id)) return null;
    const body = await this.find<unknown>(`/events/${idPath(id)}`, {
      $select: "isOrganizer,attendees", $expand: `singleValueExtendedProperties($filter=id eq '${PARENT_ENTRY_ID}')`,
    });
    if (body === null) return null;
    const json = record(body, "event");
    const parent = extended(json, PARENT_ENTRY_ID);
    return { ...(parent ? { parentEntryId: parent } : {}), ownMeeting: json.isOrganizer === true && Array.isArray(json.attendees) && json.attendees.length > 0 };
  }

  /**
   * Each event's parent folder entry ID, read in batches: how a listing's rows are checked against
   * the calendar it was listed from. An event Graph can't find, or gives no parent for, is absent.
   */
  async parents(ids: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const expand = encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${PARENT_ENTRY_ID}')`);
    for (let start = 0; start < ids.length; start += MAX_BATCH_REQUESTS) {
      const chunk = ids.slice(start, start + MAX_BATCH_REQUESTS);
      const requests: BatchRequest[] = chunk.map((id, index) => ({
        id: String(index), method: "GET", url: `${this.base.slice(1)}/events/${idPath(id)}?$select=id&$expand=${expand}`,
        headers: { prefer: CALENDAR_PREFER.join(", ") },
      }));
      const answers = await this.api.batch(requests);
      chunk.forEach((id, index) => {
        const answer = answers.get(String(index));
        if (answer === undefined) throw new GraphApiError(502, "Microsoft Graph left an event out of a batch.");
        if (answer.status === 200) {
          const parent = extended(record(answer.body, "event"), PARENT_ENTRY_ID);
          if (parent !== undefined) found.set(id, parent);
        } else if (![400, 403, 404].includes(answer.status)) {
          throw new GraphApiError(answer.status, "Microsoft Graph couldn't read some events. Try again shortly.");
        }
      });
    }
    return found;
  }

  /** A page of one calendar's events and occurrences overlapping a window, earliest first. */
  async view(calendarId: string, startMs: number, endMs: number, top: number, next?: string): Promise<GraphPage<GraphEvent>> {
    return await this.page(next ?? `/calendars/${idPath(calendarId)}/calendarView`, parseEvent, "event", next ? undefined : {
      startDateTime: new Date(startMs).toISOString(), endDateTime: new Date(endMs).toISOString(),
      $select: EVENT_SELECT, $orderby: "start/dateTime", $top: top,
    });
  }

  async body(id: string): Promise<{ contentType: "html" | "text"; content: string }> {
    const json = record(await this.get<unknown>(`/events/${idPath(id)}`, { $select: "body" }), "event");
    const body = json.body !== null && typeof json.body === "object" ? json.body as { contentType?: unknown; content?: unknown } : {};
    return { contentType: body.contentType === "html" ? "html" : "text", content: typeof body.content === "string" ? body.content : "" };
  }

  /** A series' recurrence, as Graph gives it (parsed by the caller), or null. */
  async recurrence(seriesId: string): Promise<unknown> {
    const json = await this.find<{ recurrence?: unknown }>(`/events/${idPath(seriesId)}`, { $select: "recurrence" });
    return json?.recurrence ?? null;
  }

  /** People's free/busy over a window, at most 20 at a time. Always asked of the signed-in user's own calendar. */
  async schedules(addresses: readonly string[], startMs: number, endMs: number): Promise<GraphSchedule[]> {
    const found: GraphSchedule[] = [];
    for (let start = 0; start < addresses.length; start += 20) {
      const chunk = addresses.slice(start, start + 20);
      const body = await this.api.request<{ value?: unknown }>("POST", "/me/calendar/getSchedule", {
        body: {
          schedules: chunk,
          startTime: { dateTime: new Date(startMs).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
          endTime: { dateTime: new Date(endMs).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
          availabilityViewInterval: 15,
        },
        prefer: CALENDAR_PREFER,
      });
      const rows = Array.isArray(body?.value) ? body.value : [];
      const parsed = rows.map(parseSchedule);
      // Matched back by address: Exchange answers in order, but nothing says it must.
      for (const wanted of chunk) {
        const answer = parsed.find(schedule => schedule.address.toLowerCase() === wanted.toLowerCase());
        found.push(answer ?? { address: wanted, items: [], error: "Their free/busy couldn't be read." });
      }
    }
    return found;
  }

  /** The whole sharing list of one of the signed-in user's own calendars: an observer's own entry may be on any page. */
  async permissions(calendarId: string): Promise<GraphCalendarPermission[]> {
    const permissions: GraphCalendarPermission[] = [];
    let next: string | undefined = `/calendars/${idPath(calendarId)}/calendarPermissions`;
    while (next !== undefined && permissions.length < 500) {
      const page: GraphPage<GraphCalendarPermission> = await this.page(next, parsePermission, "calendar permission");
      permissions.push(...page.items);
      next = page.nextLink;
    }
    return permissions;
  }

  /**
   * The signed-in user's time zone and working hours: times are shown in the zone of whoever the
   * connection belongs to, whosever calendar it is.
   */
  async settings(): Promise<{ timeZone?: string; workingHours?: GraphSchedule["workingHours"] }> {
    const json = await this.api.request<Record<string, unknown>>("GET", "/me/mailboxSettings", {
      query: { $select: "timeZone,workingHours" }, allow: [403, 404],
    });
    if (json === null) return {};
    const workingHours = parseWorkingHours(json.workingHours);
    return {
      ...(typeof json.timeZone === "string" && json.timeZone !== "" ? { timeZone: json.timeZone } : {}),
      ...(workingHours ? { workingHours } : {}),
    };
  }
}
