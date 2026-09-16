/** The availability lookup scope chosen when this calendar connection was configured. */
export type CalendarAvailabilityMode = "thisCalendar" | "allVisible";

/** Capabilities enabled for this Google Calendar connection. */
export type GoogleCalendarCapabilities = {
  /**
   * `thisCalendar`: `checkAvailability` may only query the bound calendar's own free/busy.
   * `allVisible`: `checkAvailability` may query any calendar visible to the connected Google
   * account. Only busy time blocks are returned, never event details from other calendars.
   */
  availabilityMode: CalendarAvailabilityMode;
};

/** Metadata about the Google Calendar this session is scoped to. */
export type GoogleCalendarInfo = {
  /** Calendar ID, e.g. `primary` or `person@example.com`. */
  id: string;
  /** Human-readable calendar name. */
  summary: string;
  /** Optional calendar description. */
  description?: string;
  /** Calendar time zone, e.g. `America/Los_Angeles`. */
  timeZone?: string;
  /** User's Google Calendar access role on this calendar. */
  accessRole?: "none" | "freeBusyReader" | "reader" | "writerWithoutPrivateAccess" | "writer" | "owner";
  /** Whether this is the user's primary calendar. */
  primary?: boolean;
};

/**
 * A calendar date or date/time.
 *
 * All-day events use `{ kind: "date", date: "YYYY-MM-DD" }`. Google Calendar treats the end
 * date as exclusive, so a one-day all-day event on 2026-06-09 ends on 2026-06-10.
 *
 * Timed events use `{ kind: "dateTime", dateTime: Date, timeZone?: string }`.
 */
export type CalendarTime =
  | { kind: "date"; date: string }
  | { kind: "dateTime"; dateTime: Date; timeZone?: string };

/** An attendee on a calendar event. */
export type CalendarAttendee = {
  email: string;
  displayName?: string;
  optional?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  organizer?: boolean;
  self?: boolean;
};

/** Reminder setting for a calendar event. */
export type CalendarReminder = {
  method: "email" | "popup";
  minutes: number;
};

/** A Google Calendar event. */
export type CalendarEvent = {
  /**
   * Google Calendar event ID. Newly created events that have not yet been committed to Google
   * Calendar use a temporary ID of the form `pending:create:{n}`.
   */
  id: string;
  /** Event title. */
  title: string;
  /** Start date/time. */
  start: CalendarTime;
  /** End date/time. */
  end: CalendarTime;
  /** Event status. */
  status: "confirmed" | "tentative" | "cancelled";
  /** Event location, if any. */
  location?: string;
  /** Event description/body, if requested and visible. */
  description?: string;
  /** Attendees, if requested and visible. */
  attendees?: CalendarAttendee[];
  /** Link to open the event in Google Calendar. */
  htmlLink?: string;
  /** Whether the event blocks the calendar (`opaque`) or is shown as free (`transparent`). */
  transparency?: "opaque" | "transparent";
  /** Event visibility, if set. */
  visibility?: "default" | "public" | "private" | "confidential";
  /** Whether this event is part of a recurring series. */
  recurringEventId?: string;
  /** True for events that have been submitted but not yet committed to Google Calendar. */
  pending?: boolean;
};

/** Event fields accepted when creating a new event. */
export type CalendarEventDraft = {
  title: string;
  start: CalendarTime;
  end: CalendarTime;
  description?: string;
  location?: string;
  attendees?: { email: string; displayName?: string; optional?: boolean }[];
  reminders?: CalendarReminder[];
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
};

/** Options for listing events on the selected calendar. */
export type CalendarListEventsOptions = {
  /** Start of the time window to list. */
  timeMin: Date;
  /** End of the time window to list. */
  timeMax: Date;
  /** Include event descriptions/bodies. Defaults to false. */
  includeDescriptions?: boolean;
};

/** A busy interval returned by Google Calendar free/busy lookup. */
export type CalendarBusyBlock = {
  start: Date;
  end: Date;
};

/** Free/busy availability for one person or calendar. */
export type PersonAvailability = {
  /** Email address or calendar ID that was queried. */
  email: string;
  /** Busy intervals in the requested window. No event titles or details are included. */
  busy: CalendarBusyBlock[];
  /** Error reported by Google Calendar, if this person's free/busy data could not be returned. */
  error?: string;
};

/** Options for changing attendee notifications when modifying an event. */
export type CalendarSendUpdates = "all" | "externalOnly" | "none";

/**
 * Fields that can be changed on an existing event. Only the fields you set are changed; omitted
 * fields are left as-is.
 *
 * Note: `attendees` is a full replacement of the attendee list, not a merge. To add or remove an
 * attendee, first read the current attendees via `listEvents()` and pass the complete desired list.
 */
export type CalendarEventPatch = {
  title?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  description?: string;
  location?: string;
  attendees?: { email: string; displayName?: string; optional?: boolean }[];
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
};

/** Session interface for one selected Google Calendar. */
export interface GoogleCalendarSession {
  /** Return the optional capabilities enabled for this connection. */
  getCapabilities(): Promise<GoogleCalendarCapabilities>;

  /** Return metadata about the selected calendar. */
  getCalendar(): Promise<GoogleCalendarInfo>;

  /**
   * List all events on the selected calendar within the time window. The whole window is returned
   * (results are not paginated by the caller); a very dense window throws rather than truncating.
   *
   * Results include submitted creates/updates that have not yet been committed to Google Calendar,
   * shown as if they had already been applied. Event descriptions are omitted unless
   * `includeDescriptions` is true.
   */
  listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]>;

  /**
   * Check free/busy availability for people or calendars. Returns only busy time blocks, never
   * event titles, descriptions, locations, attendees, or conferencing details.
   * Calendar identifiers must be stable IDs or email addresses; the account-relative `primary`
   * alias is not accepted.
   *
   * If this connection's availability mode is `thisCalendar`, only the bound calendar's own
   * free/busy may be queried; querying anything else throws. With `allVisible`, collaborators can
   * observe the result only when their chosen Google account can independently see free/busy for
   * every calendar whose availability has been read.
   */
  checkAvailability(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]>;

  /**
   * Create a new event on the selected calendar.
   *
   * The event appears in subsequent `listEvents()` calls immediately with a temporary ID. Until it
   * has been committed to Google Calendar it has no real Google event ID, so it cannot yet be
   * targeted by `updateEvent()`.
   */
  createEvent(event: CalendarEventDraft, opts?: { sendUpdates?: CalendarSendUpdates }): Promise<void>;

  /**
   * Update an existing event on the selected calendar.
   *
   * Pass only the fields you want to change. To reschedule an event, set `start` and `end`. To
   * edit the agenda, set `description`. The change appears in subsequent `listEvents()` calls
   * immediately.
   *
   * `attendees` replaces the whole attendee list (see `CalendarEventPatch`). Only the fields you
   * set are written, so unrelated changes made elsewhere before the update is committed are
   * preserved; a change to a field you also set will be overwritten with your value.
   */
  updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void>;
}
