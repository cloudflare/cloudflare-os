import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarEventDraft,
  CalendarEventPatch,
  CalendarListEventsOptions,
  CalendarReminder,
  CalendarSendUpdates,
  CalendarTime,
  GoogleCalendarInfo,
  PersonAvailability,
} from "./calendar-types";
import { AccessTokenProvider, readCheckedWithAuthRetry } from "./auth-retry";
import { googleUpstream } from "./upstream";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

const MAX_LIST_EVENTS = 2500;

/** Most calendars Google answers in one free/busy query. */
export const MAX_FREE_BUSY_CALENDARS = 50;

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
 * Whether the account also sees private event details. A collaborator observing a calendar's
 * metadata or events must hold one of these roles, because what the workspace read through the
 * owner's account may include private details; a limited writer could not see them on their own.
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
  recurringEventId?: string;
  eventType?: string;
  attendeesOmitted?: boolean;
  organizer?: { self?: boolean };
  etag?: string;
};

/**
 * An event as one read reports it, with the fields that decide whether changing it reaches anyone
 * but the bound calendar: who organizes it, whether Google left attendees out of the list, and its
 * type (an out-of-office event can decline invitations on the user's behalf). The agent-facing
 * `CalendarEvent` omits them. `etag` identifies this version of the event, so a write can be made
 * conditional on nothing having changed since.
 */
export type LiveCalendarEvent = CalendarEvent & {
  eventType?: string;
  attendeesOmitted?: boolean;
  organizer?: { self?: boolean };
  etag?: string;
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
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
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

export class GoogleCalendarApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Google Calendar API request failed: ${status} ${body}`);
  }
}

export class GoogleCalendarApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  // One request, whose answer's JSON is given to `made`, the reading of the method that sent it.
  // Both are read within the request, which so counts a success that cannot be read, or that
  // `made` throws on, as the failure it is thrown as.
  async #fetch<T, R>(path: string, init: RequestInit | undefined, made: (answer: T) => R): Promise<R> {
    // Built from the caller's headers so anything they set wins; these are only defaults. Note a
    // plain `{...init?.headers}` would silently drop everything if a caller passed a Headers.
    let headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return readCheckedWithAuthRetry(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      headers,
    }, { getAccessToken: this.getAccessToken }, async response => {
      if (!response.ok) {
        let text = await response.text();
        throw new GoogleCalendarApiError(response.status, text);
      }

      if (response.status === 204) return undefined as T;
      return await response.json<T>();
    }, made);
  }

  async listCalendars(opts: GoogleCalendarListOptions = {}): Promise<GoogleCalendarInfo[]> {
    return googleUpstream.summed(async () => {
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

        // A page's calendars are taken within the request: a page whose `items` is no list is an
        // answer the request is counted an error for.
        pageToken = await this.#fetch(
          `/users/me/calendarList?${params}`, undefined,
          (body: {items?: GoogleCalendarInfo[]; nextPageToken?: string}) => {
            calendars.push(...(body.items ?? []));
            return body.nextPageToken;
          });
      } while (pageToken && calendars.length < cap);

      return calendars
        .toSorted((a, b) =>
          calendarPickerRank(a) - calendarPickerRank(b) ||
          (a.summary ?? a.id).localeCompare(b.summary ?? b.id))
        .slice(0, cap);
    });
  }

  async getCalendar(calendarId: string): Promise<GoogleCalendarInfo> {
    return this.#fetch(
      `/users/me/calendarList/${encodeCalendarId(calendarId)}`, undefined,
      (cal: GoogleCalendarInfo) => ({
        id: cal.id,
        summary: cal.summary ?? cal.id,
        ...(cal.description ? { description: cal.description } : {}),
        ...(cal.timeZone ? { timeZone: cal.timeZone } : {}),
        ...(cal.accessRole ? { accessRole: cal.accessRole } : {}),
        ...(cal.primary ? { primary: cal.primary } : {}),
      }));
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
    return googleUpstream.summed(async () => {
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

        // A page's events are read within the request, unless they are more than a listing
        // holds: that is this client's own limit of an answer Google gave, and is thrown below.
        let page = await this.#fetch(
          `/calendars/${encodeCalendarId(calendarId)}/events?${params}`, undefined,
          (body: {items?: GoogleCalendarEvent[]; nextPageToken?: string}) => {
            let items = body.items ?? [];
            if (events.length + items.length > MAX_LIST_EVENTS) return undefined;
            let found: CalendarEvent[] = [];
            for (let event of items) {
              found.push(calendarEventFromGoogle(event, {
                includeDescriptions: opts.includeDescriptions,
              }));
            }
            return { found, nextPageToken: body.nextPageToken };
          });
        if (!page) {
          throw new Error(
            "Too many events in the requested window. Narrow timeMin/timeMax and try again.");
        }
        for (let event of page.found) events.push(event);
        pageToken = page.nextPageToken;
      } while (pageToken);

      return events;
    });
  }

  async freeBusy(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]> {
    return this.#freeBusy(opts, availability => availability);
  }

  // One free/busy query. `made` is given each calendar's availability, with the error Google
  // reports for it, within the request: a query whose caller throws on such an error is so
  // counted as the failure it is thrown as, and one whose caller hands the errors on is not.
  async #freeBusy<R>(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }, made: (availability: PersonAvailability[]) => R): Promise<R> {
    if (opts.people.length > MAX_FREE_BUSY_CALENDARS) {
      throw new Error(`At most ${MAX_FREE_BUSY_CALENDARS} people/calendars can be checked at once.`);
    }
    return this.#fetch("/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: opts.timeMin.toISOString(),
        timeMax: opts.timeMax.toISOString(),
        ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        items: opts.people.map(id => ({ id })),
      }),
    }, (body: {
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: {reason?: string; domain?: string}[] }>;
    }) => {
      let calendars = body.calendars ?? {};
      return made(opts.people.map(email => {
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
      }));
    });
  }

  /**
   * Whether the connected account can see each calendar's free/busy information, in order: false
   * where Google reports the calendar `notFound`, and a throw for any other error it reports for
   * one. Takes at most MAX_FREE_BUSY_CALENDARS calendars, as every free/busy query does.
   */
  async hasFreeBusyAccess(calendarIds: readonly string[]): Promise<boolean[]> {
    let timeMin = new Date();
    return this.#freeBusy({
      people: [...calendarIds],
      timeMin,
      timeMax: new Date(timeMin.valueOf() + 60_000),
    }, availability => availability.map(({email, error}) => {
      if (error === "notFound") return false;
      if (error) {
        throw new Error(`Google Calendar free/busy access check failed for ${email}: ${error}`);
      }
      return true;
    }));
  }

  async createEvent(
    calendarId: string,
    event: CalendarEventDraft,
    sendUpdates: CalendarSendUpdates = "all",
  ): Promise<CalendarEvent> {
    return this.#fetch(
      `/calendars/${encodeCalendarId(calendarId)}/events?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      { method: "POST", body: JSON.stringify(googleEventFromDraft(event)) },
      (created: GoogleCalendarEvent) => calendarEventFromGoogle(created, { includeDescriptions: true }),
    );
  }

  /**
   * Applies `patch` to the event. With `ifMatch`, Google applies it only while the event is still
   * at that etag and answers 412 otherwise.
   */
  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<GoogleCalendarEvent>,
    sendUpdates: CalendarSendUpdates = "all",
    ifMatch?: string,
  ): Promise<CalendarEvent> {
    return this.#fetch(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
        ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
      },
      (updated: GoogleCalendarEvent) => calendarEventFromGoogle(updated, { includeDescriptions: true }),
    );
  }

  async getEvent(calendarId: string, eventId: string): Promise<LiveCalendarEvent> {
    return this.#fetch(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}`, undefined,
      (event: GoogleCalendarEvent): LiveCalendarEvent => ({
        ...calendarEventFromGoogle(event, { includeDescriptions: true }),
        ...(event.eventType ? { eventType: event.eventType } : {}),
        ...(event.attendeesOmitted ? { attendeesOmitted: true } : {}),
        ...(event.organizer ? { organizer: { self: event.organizer.self === true } } : {}),
        ...(event.etag ? { etag: event.etag } : {}),
      }));
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: CalendarSendUpdates = "all",
  ): Promise<void> {
    await this.#fetch(
      `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
      { method: "DELETE" }, () => undefined,
    );
  }
}
