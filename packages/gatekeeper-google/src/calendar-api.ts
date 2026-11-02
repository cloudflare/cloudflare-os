import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarEventDraft,
  CalendarEventPatch,
  CalendarEventType,
  CalendarListEventsOptions,
  CalendarReminder,
  CalendarSendUpdates,
  CalendarTime,
  GoogleCalendarInfo,
  PersonAvailability,
} from "./calendar-types";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

const MAX_LIST_EVENTS = 2500;

/**
 * The private extended property every write this gatekeeper applies sets to a fresh value. Google
 * keeps a private property on the calendar's own copy of the event, and keeps it through edits made
 * elsewhere, so a change whose mark differs from the one last seen is one this gatekeeper wrote:
 * hooks drop those (see calendar-hooks.ts).
 */
export const CALENDAR_WRITE_MARK = "gadgetsWrite";

const EVENT_TYPES: readonly CalendarEventType[] = [
  "default", "outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail",
];

export type GoogleCalendarListOptions = {
  maxResults?: number;
};

// Google's calendar roles split "can edit the calendar" from "can see private event details":
// `writerWithoutPrivateAccess` edits events but sees private ones only as busy blocks. The two
// predicates below are the only places that distinction is encoded, so keep them together.

/**
 * Whether the connected account can create and edit events on the calendar. This is the bar for
 * choosing a calendar to operate on, in the picker and when checking a suggested calendar.
 */
export function hasCalendarWriteRole(calendar: GoogleCalendarInfo): boolean {
  return calendar.accessRole === "owner" || calendar.accessRole === "writer" ||
    calendar.accessRole === "writerWithoutPrivateAccess";
}

/**
 * Whether the account also sees private event details. A collaborator observing a bound calendar
 * must hold one of these roles, because the workspace may already hold private details read
 * through the owner's account; a limited writer could not see them on their own.
 */
export function hasCalendarPrivateAccessRole(calendar: GoogleCalendarInfo): boolean {
  return calendar.accessRole === "owner" || calendar.accessRole === "writer";
}

// The weakest role the picker offers. Must agree with `hasCalendarWriteRole`.
const CALENDAR_PICKER_MIN_ACCESS_ROLE = "writerWithoutPrivateAccess";

// Rank calendars so the ones the user is most likely to pick appear first
const CALENDAR_ACCESS_ROLE_RANK: Record<string, number> = {
  owner: 0,
  writer: 1,
  writerWithoutPrivateAccess: 2,
  reader: 3,
  freeBusyReader: 4,
  none: 5,
};

export function calendarPickerRank(calendar: GoogleCalendarInfo): number {
  if (calendar.primary) return -1;
  return CALENDAR_ACCESS_ROLE_RANK[calendar.accessRole ?? ""] ?? 6;
}

type GoogleCalendarTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarEvent = {
  id: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleCalendarTime;
  end?: GoogleCalendarTime;
  status?: "confirmed" | "tentative" | "cancelled";
  attendees?: CalendarAttendee[];
  reminders?: { useDefault: boolean; overrides?: CalendarReminder[] };
  htmlLink?: string;
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
  eventType?: string;
  recurringEventId?: string;
  recurrence?: string[];
  extendedProperties?: { private?: Record<string, string> };
};

export function encodeCalendarId(calendarId: string): string {
  return encodeURIComponent(calendarId);
}

function calendarTimeFromGoogle(value: GoogleCalendarTime | undefined): CalendarTime {
  if (!value) return { kind: "dateTime", dateTime: new Date(0) };
  if (value.date) return { kind: "date", date: value.date };
  if (value.dateTime) {
    return {
      kind: "dateTime",
      dateTime: new Date(value.dateTime),
      timeZone: value.timeZone,
    };
  }
  return { kind: "dateTime", dateTime: new Date(0) };
}

function calendarTimeToGoogle(value: CalendarTime): GoogleCalendarTime {
  if (value.kind === "date") return { date: value.date };
  return {
    dateTime: value.dateTime.toISOString(),
    ...(value.timeZone ? { timeZone: value.timeZone } : {}),
  };
}

export function calendarEventFromGoogle(
  event: GoogleCalendarEvent,
  opts?: { includeDescriptions?: boolean; pending?: boolean },
): CalendarEvent {
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start: calendarTimeFromGoogle(event.start),
    end: calendarTimeFromGoogle(event.end),
    status: event.status ?? "confirmed",
    ...(event.location ? { location: event.location } : {}),
    ...(opts?.includeDescriptions && event.description ? { description: event.description } : {}),
    ...(event.attendees ? { attendees: event.attendees } : {}),
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    ...(event.transparency ? { transparency: event.transparency } : {}),
    ...(event.visibility ? { visibility: event.visibility } : {}),
    ...(EVENT_TYPES.includes(event.eventType as CalendarEventType)
      ? { eventType: event.eventType as CalendarEventType } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.recurrence?.length ? { recurrence: event.recurrence } : {}),
    ...(opts?.pending ? { pending: true } : {}),
  };
}

export function googleEventFromDraft(event: CalendarEventDraft): Partial<GoogleCalendarEvent> & {
  start: GoogleCalendarTime;
  end: GoogleCalendarTime;
} {
  return {
    summary: event.title,
    start: calendarTimeToGoogle(event.start),
    end: calendarTimeToGoogle(event.end),
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.attendees ? { attendees: event.attendees } : {}),
    ...(event.transparency ? { transparency: event.transparency } : {}),
    ...(event.visibility ? { visibility: event.visibility } : {}),
    ...(event.reminders ? {
      reminders: { useDefault: false, overrides: event.reminders },
    } : {}),
  };
}

/** The body fields that set an event's `CALENDAR_WRITE_MARK`, leaving its other private properties. */
function writeMarkPatch(writeMark: string): Pick<GoogleCalendarEvent, "extendedProperties"> {
  return { extendedProperties: { private: { [CALENDAR_WRITE_MARK]: writeMark } } };
}

/**
 * Build a Google Calendar PATCH body from a partial patch. Only fields present in the patch are
 * included, so omitted fields are left unchanged by the API.
 */
export function eventPatchToGoogle(patch: CalendarEventPatch): Partial<GoogleCalendarEvent> {
  let body: Partial<GoogleCalendarEvent> = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.start !== undefined) body.start = calendarTimeToGoogle(patch.start);
  if (patch.end !== undefined) body.end = calendarTimeToGoogle(patch.end);
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.attendees !== undefined) body.attendees = patch.attendees;
  if (patch.transparency !== undefined) body.transparency = patch.transparency;
  if (patch.visibility !== undefined) body.visibility = patch.visibility;
  return body;
}

function eventTimeMillis(value: CalendarTime): number {
  if (value.kind === "date") return Date.parse(value.date + "T00:00:00Z");
  return value.dateTime.valueOf();
}

export function calendarEventOverlaps(event: CalendarEvent, timeMin: Date, timeMax: Date): boolean {
  return eventTimeMillis(event.end) > timeMin.valueOf() && eventTimeMillis(event.start) < timeMax.valueOf();
}

export function calendarEventSortKey(event: CalendarEvent): number {
  return eventTimeMillis(event.start);
}

export function validateCalendarTimeWindow(timeMin: Date, timeMax: Date, maxDays: number) {
  if (!(timeMin instanceof Date) || Number.isNaN(timeMin.valueOf())) {
    throw new Error("timeMin must be a valid Date.");
  }
  if (!(timeMax instanceof Date) || Number.isNaN(timeMax.valueOf())) {
    throw new Error("timeMax must be a valid Date.");
  }
  if (timeMax.valueOf() <= timeMin.valueOf()) {
    throw new Error("timeMax must be after timeMin.");
  }
  let days = (timeMax.valueOf() - timeMin.valueOf()) / (24 * 60 * 60 * 1000);
  if (days > maxDays) {
    throw new Error(`Time window is too large; maximum is ${maxDays} days.`);
  }
}

/**
 * A Google Calendar API request that failed with HTTP status `status`. The message names Google's
 * reason codes, such as `notFound` or `rateLimitExceeded`, but never quotes the response, whose
 * prose can repeat calendar and event details into logs.
 */
export class GoogleCalendarApiError extends Error {
  constructor(readonly status: number, reasons: readonly string[]) {
    super(`Google Calendar API request failed [http=${status}]` +
      (reasons.length > 0 ? ` (${reasons.join(", ")})` : ""));
  }
}

/** The reason codes of a failed response's errors, keeping only ones shaped as codes are. */
async function errorReasons(response: Response): Promise<string[]> {
  try {
    const body = await response.json<{ error?: { errors?: { reason?: unknown }[] } }>();
    return (body.error?.errors ?? [])
      .map(error => error.reason)
      .filter((reason): reason is string => typeof reason === "string" && /^[\w.]{1,64}$/.test(reason))
      .slice(0, 3);
  } catch {
    // Not JSON: the status alone says what failed.
    return [];
  }
}

/** One event `listEventChanges()` reports, with only what tells what kind of change it was. */
export type CalendarChangeRecord = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  /** Changes with every change to the event. */
  etag?: string;
  recurringEventId?: string;
  /** The `CALENDAR_WRITE_MARK` the event carries, if any; Google omits it from a deleted event. */
  writeMark?: string;
};

/**
 * Where `listEventChanges()` reads: the changes since a sync token, or, to start from, every event
 * ending after `timeMin` (which a sync token then follows).
 */
export type CalendarChangesQuery = { syncToken: string } | { timeMin: string };

/** One page of `listEventChanges()`: the last has `nextSyncToken`, any other `nextPageToken`. */
export type CalendarChangesPage = {
  records: CalendarChangeRecord[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export class GoogleCalendarApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #fetch<T>(path: string, init?: RequestInit): Promise<T> {
    // Built from the caller's headers so anything they set wins; these are only defaults. Note a
    // plain `{...init?.headers}` would silently drop everything if a caller passed a Headers.
    let headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response = await fetchWithAuthRetry(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      headers,
    }, this.getAccessToken);

    if (!response.ok) throw new GoogleCalendarApiError(response.status, await errorReasons(response));

    if (response.status === 204) return undefined as T;
    return await response.json<T>();
  }

  async listCalendars(opts: GoogleCalendarListOptions = {}): Promise<GoogleCalendarInfo[]> {
    let cap = opts.maxResults ?? 250;
    let calendars: GoogleCalendarInfo[] = [];
    let pageToken: string | undefined;

    do {
      let params = new URLSearchParams({
        maxResults: "250",
        // Only surface calendars the user can edit. Google filters on its role ordering, so a
        // limited writer's calendars are included but a reader's are not.
        minAccessRole: CALENDAR_PICKER_MIN_ACCESS_ROLE,
        fields: "items(id,summary,description,timeZone,accessRole,primary),nextPageToken",
      });
      if (pageToken) params.set("pageToken", pageToken);

      let body = await this.#fetch<{items?: GoogleCalendarInfo[]; nextPageToken?: string}>(
        `/users/me/calendarList?${params}`);
      calendars.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken && calendars.length < cap);

    return calendars
      .toSorted((a, b) =>
        calendarPickerRank(a) - calendarPickerRank(b) ||
        (a.summary ?? a.id).localeCompare(b.summary ?? b.id))
      .slice(0, cap);
  }

  async getCalendar(calendarId: string): Promise<GoogleCalendarInfo> {
    let cal = await this.#fetch<GoogleCalendarInfo>(
      `/users/me/calendarList/${encodeCalendarId(calendarId)}`,
    );
    return {
      id: cal.id,
      summary: cal.summary ?? cal.id,
      ...(cal.description ? { description: cal.description } : {}),
      ...(cal.timeZone ? { timeZone: cal.timeZone } : {}),
      ...(cal.accessRole ? { accessRole: cal.accessRole } : {}),
      ...(cal.primary ? { primary: cal.primary } : {}),
    };
  }

  /**
   * Returns whether the connected account can write the exact calendar. A calendar that is not on
   * the account's list (404) is reported as unwritable; any other failure is rethrown so a
   * transient error is not mistaken for missing access.
   */
  async canWriteCalendar(calendarId: string): Promise<boolean> {
    try {
      return hasCalendarWriteRole(await this.getCalendar(calendarId));
    } catch (error) {
      if (error instanceof GoogleCalendarApiError && error.status === 404) return false;
      throw error;
    }
  }

  /** Lists all events in the window, paginating fully. */
  async listEvents(calendarId: string, opts: CalendarListEventsOptions): Promise<CalendarEvent[]> {
    let events: CalendarEvent[] = [];
    let pageToken: string | undefined;

    do {
      let params = new URLSearchParams({
        timeMin: opts.timeMin.toISOString(),
        timeMax: opts.timeMax.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "2500",
      });
      if (pageToken) params.set("pageToken", pageToken);

      let body = await this.#fetch<{items?: GoogleCalendarEvent[]; nextPageToken?: string}>(
        `/calendars/${encodeCalendarId(calendarId)}/events?${params}`);
      let items = body.items ?? [];
      if (events.length + items.length > MAX_LIST_EVENTS) {
        throw new Error(
          "Too many events in the requested window. Narrow timeMin/timeMax and try again.");
      }
      for (let event of items) {
        events.push(calendarEventFromGoogle(event, {
          includeDescriptions: opts.includeDescriptions,
        }));
      }
      pageToken = body.nextPageToken;
    } while (pageToken);

    return events;
  }

  async freeBusy(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]> {
    let body = await this.#fetch<{
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: {reason?: string; domain?: string}[] }>;
    }>("/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: opts.timeMin.toISOString(),
        timeMax: opts.timeMax.toISOString(),
        ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        items: opts.people.map(id => ({ id })),
      }),
    });

    let calendars = body.calendars ?? {};
    return opts.people.map(email => {
      let entry = calendars[email];
      let error = entry
          ? entry.errors?.map(item => item.reason ?? item.domain ?? "unknown").join(", ")
          : "notFound";
      return {
        email,
        busy: (entry?.busy ?? []).map(block => ({
          start: new Date(block.start),
          end: new Date(block.end),
        })),
        ...(error ? { error } : {}),
      };
    });
  }

  async hasFreeBusyAccess(calendarId: string): Promise<boolean> {
    let timeMin = new Date();
    let [availability] = await this.freeBusy({
      people: [calendarId],
      timeMin,
      timeMax: new Date(timeMin.valueOf() + 60_000),
    });
    if (!availability || availability.error === "notFound") return false;
    if (availability.error) {
      throw new Error(
        `Google Calendar free/busy access check failed for ${calendarId}: ${availability.error}`);
    }
    return true;
  }

  /** Create the event, setting `writeMark` as its `CALENDAR_WRITE_MARK`. */
  async createEvent(
    calendarId: string,
    event: CalendarEventDraft,
    sendUpdates: CalendarSendUpdates,
    writeMark: string,
  ): Promise<CalendarEvent> {
    let created = await this.#fetch<GoogleCalendarEvent>(
      `/calendars/${encodeCalendarId(calendarId)}/events?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      { method: "POST", body: JSON.stringify({ ...googleEventFromDraft(event), ...writeMarkPatch(writeMark) }) },
    );
    return calendarEventFromGoogle(created, { includeDescriptions: true });
  }

  /** Patch the event, setting `writeMark` as its `CALENDAR_WRITE_MARK`. */
  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<GoogleCalendarEvent>,
    sendUpdates: CalendarSendUpdates,
    writeMark: string,
  ): Promise<CalendarEvent> {
    let updated = await this.#fetch<GoogleCalendarEvent>(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      { method: "PATCH", body: JSON.stringify({ ...patch, ...writeMarkPatch(writeMark) }) },
    );
    return calendarEventFromGoogle(updated, { includeDescriptions: true });
  }

  /** The event, cancelled ones included, with its description unless `includeDescriptions` is false. */
  async getEvent(calendarId: string, eventId: string,
                 opts: { includeDescriptions?: boolean } = {}): Promise<CalendarEvent> {
    let event = await this.#fetch<GoogleCalendarEvent>(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return calendarEventFromGoogle(event, { includeDescriptions: opts.includeDescriptions ?? true });
  }

  /**
   * One page of the calendar's events, with only what tells changes apart. Recurring events are
   * listed as their series and the occurrences that differ from it, not expanded, so a change to a
   * series is one record. Throws a 410 `GoogleCalendarApiError` once Google no longer honours the
   * sync token.
   */
  async listEventChanges(calendarId: string, query: CalendarChangesQuery,
                         pageToken?: string): Promise<CalendarChangesPage> {
    let params = new URLSearchParams({
      singleEvents: "false",
      maxResults: "2500",
      fields: "items(id,status,etag,recurringEventId,extendedProperties/private),nextPageToken,nextSyncToken",
    });
    if ("syncToken" in query) params.set("syncToken", query.syncToken);
    else params.set("timeMin", query.timeMin);
    if (pageToken) params.set("pageToken", pageToken);
    let body = await this.#fetch<{
      items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string;
    }>(`/calendars/${encodeCalendarId(calendarId)}/events?${params}`);
    return {
      records: (body.items ?? []).map(item => ({
        id: item.id,
        ...(item.status ? { status: item.status } : {}),
        ...(item.etag ? { etag: item.etag } : {}),
        ...(item.recurringEventId ? { recurringEventId: item.recurringEventId } : {}),
        ...(item.extendedProperties?.private?.[CALENDAR_WRITE_MARK] !== undefined
          ? { writeMark: item.extendedProperties.private[CALENDAR_WRITE_MARK] } : {}),
      })),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
      ...(body.nextSyncToken ? { nextSyncToken: body.nextSyncToken } : {}),
    };
  }

  /**
   * Open a push channel that has Google post to `address` whenever the calendar's events change,
   * with `token` in each post's `X-Goog-Channel-Token` header. Returns when it expires, which may
   * be sooner than `ttlSeconds`.
   */
  async watchEvents(calendarId: string, channel: {
    id: string; token: string; address: string; ttlSeconds: number;
  }): Promise<{ resourceId: string; expiration: number }> {
    let opened = await this.#fetch<{ resourceId?: string; expiration?: string | number }>(
      `/calendars/${encodeCalendarId(calendarId)}/events/watch`,
      {
        method: "POST",
        body: JSON.stringify({
          id: channel.id, type: "web_hook", address: channel.address, token: channel.token,
          params: { ttl: String(channel.ttlSeconds) },
        }),
      },
    );
    let expiration = Number(opened.expiration);
    if (!opened.resourceId || !Number.isFinite(expiration)) {
      throw new Error("Google Calendar opened a push channel without saying what it watches or until when.");
    }
    return { resourceId: opened.resourceId, expiration };
  }

  /** Stop a push channel; one Google no longer has counts as stopped. */
  async stopChannel(id: string, resourceId: string): Promise<void> {
    try {
      await this.#fetch<void>("/channels/stop", { method: "POST", body: JSON.stringify({ id, resourceId }) });
    } catch (error) {
      if (!(error instanceof GoogleCalendarApiError && error.status === 404)) throw error;
    }
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: CalendarSendUpdates = "all",
  ): Promise<void> {
    await this.#fetch<void>(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      { method: "DELETE" },
    );
  }
}
