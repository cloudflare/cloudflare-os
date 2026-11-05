// The capabilities gadgets hold for a Calendar binding. Every operation follows the same order:
// prove each event it names is inside the binding (its parent folder's entry ID, read fresh, is the
// bound calendar's, or one of the user's for an "all" binding), cut it to the binding's level of
// detail (calendar-events.ts), apply the changes awaiting approval (calendar-overlay.ts), authorize
// the observation with the units it revealed (calendar-observers.ts), and only then return. An event
// outside the binding and one that doesn't exist are refused with the same words.
//
// Changes are checked as reads are, then staged for approval (calendar-actions.ts).
// `CalendarReaderImpl` is what a read-only binding hands out; `CalendarSessionImpl` adds the write
// methods, each of which also checks the access level: "edit" for events only the user sees,
// "schedule" for anything that mails other people.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionSubmitter, JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { TokenCursor } from "@gadgets/gatekeeper-kit/cursors";
import { ObservationGate, escapeObservationValue, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { isProvisional, OutsideBindingError } from "./binding";
import type { GraphApi } from "./graph-api";
import { organizationDomains } from "./directory";
import type { StoredIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";
import { type CalendarAction, type CalendarActions, type CalendarRef, type EventTarget, type EventWrite, type InviteNote } from "./calendar-actions";
import { CalendarApi, isCalendarId, type GraphCalendar, type GraphEvent, type GraphSchedule, type Weekday } from "./calendar-graph";
import { checkRecurrence, eventInfo, eventTimes, hidesDetails, isPrivate, recurrenceWords, searchable, type EventView } from "./calendar-events";
import { freeTimes, type Attendance } from "./calendar-free";
import { calendarUnits } from "./calendar-observers";
import { CalendarOverlay } from "./calendar-overlay";
import { allows, describeScope, type CalendarAccessLevel, type CalendarScope, type RevealLevel } from "./calendar-scope";
import {
  DAY_MS, MINUTE_MS, TimeError, dateInZone, ianaZone, isoInZone, nextDate, parseDate, parseInstant, startOfDate,
} from "./calendar-time";
import { checkBody, checkSubject, mailToMarkdown, markdownToMailHtml, parseRecipient, senderKind } from "./outlook-content";
import type {
  Availability, CalendarInfo, CalendarOverview, CalendarReader, CalendarSession, EventChangeOptions, EventChanges, EventContent,
  EventInfo, EventInput, FreeTimeOptions, FreeTimes, ListEventsOptions, Person, RespondOptions, ShowAs, WorkingHours,
} from "./calendar-types";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.calendar", vendorId: VENDOR_ID });

// How long settings, the calendar list and the organization's domains are reused. A calendar that
// left the user's list, or was unshared, keeps admitting its events for up to CALENDARS_TTL_MS: the
// same window a removed share keeps counting for observers (ACL_TTL_MS in calendar-gatekeeper.ts).
const SETTINGS_TTL_MS = 60 * 60 * 1000;
const CALENDARS_TTL_MS = 2 * 60 * 1000;
const ORGANIZATION_TTL_MS = 24 * 60 * 60 * 1000;
// Bounds on what one read covers and returns.
const MAX_WINDOW_DAYS = 62;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** The most events one listing reads before it asks for a narrower window. */
const MAX_LISTED_EVENTS = 1000;
const MAX_PEOPLE = 20;
const MAX_SLOTS = 50;
const DEFAULT_SLOTS = 10;
const MAX_BODY_READ_CHARS = 50_000;
// Bounds on what one change carries: the approver reads all of it, and the journal stores it.
const MAX_WRITE_BODY_CHARS = 50_000;
const MAX_LOCATION_CHARS = 255;
const MAX_ATTENDEES = 100;
const MAX_CATEGORIES = 25;
const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;
const MAX_EVENT_DAYS = 31;
const MAX_MESSAGE_CHARS = 10_000;
const SHOW_AS_VALUES: readonly ShowAs[] = ["free", "tentative", "busy", "oof", "workingElsewhere"];
const SENSITIVITY_VALUES = ["normal", "personal", "private", "confidential"] as const;

/** What the facet gives every session. */
export type CalendarSessionHost = {
  scope: CalendarScope;
  /** What the binding may do: its own level, never more than the deployment and grant allow. */
  access: CalendarAccessLevel;
  owner(): Promise<StoredIdentity>;
  read<T>(op: (api: GraphApi) => Promise<T>): Promise<T>;
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  pending(): JournalEntry<CalendarAction>[];
  resolve(id: string): string;
  allocate(kind: string): string;
  submit<K extends keyof CalendarActions>(queue: ActionSubmitter, kind: K, payload: CalendarActions[K]): Promise<number>;
};

/** Refused: outside the binding, or not there at all. One message for both. */
export class OutsideCalendarError extends OutsideBindingError {
  constructor(what = "That event") {
    super("Calendar", what);
  }
}

const md = (text: string) => escapeObservationValue(text);

/** An event admitted by the guard, with the calendar it is in. */
type Guarded = { event: GraphEvent; calendar: GraphCalendar };

/**
 * One capability's hold on the binding: its approval-queue stub, an observation gate, and the
 * binding's cached view of the user's settings and calendars.
 */
export class CalendarContext implements Disposable {
  readonly host: CalendarSessionHost;
  readonly queue: RpcStub<ApprovalQueue>;
  readonly gate: ObservationGate;

  constructor(host: CalendarSessionHost, queue: RpcStub<ApprovalQueue>, observers: ObserverStrategy) {
    this.host = host;
    this.queue = queue;
    this.gate = new ObservationGate(queue.dup(), observers);
  }

  [Symbol.dispose](): void {
    this.gate[Symbol.dispose]();
    this.queue[Symbol.dispose]();
  }

  get scope(): CalendarScope {
    return this.host.scope;
  }

  /** Runs a read against the calendars the binding is for: the user's, or the bound calendar's owner's. */
  calendarApi<T>(op: (api: CalendarApi) => Promise<T>): Promise<T> {
    const owner = this.scope.kind === "calendar" ? this.scope.owner : { kind: "me" as const };
    return this.host.read(api => op(new CalendarApi(api, owner)));
  }

  /**
   * The signed-in user's address, time zone and working hours. The address is their main calendar's
   * owner, which is how Exchange names them as organizer, attendee and calendar owner, whatever
   * their sign-in name; the connection's own identity stands in only when the calendar can't be read.
   */
  async settings(): Promise<{ address: string; zone: string; workingHours?: WorkingHours & { days: Weekday[] } }> {
    return await this.host.cached("settings", SETTINGS_TTL_MS, async () => {
      const [[settings, main], identity] = await Promise.all([
        this.host.read(api => { const me = new CalendarApi(api, { kind: "me" }); return Promise.all([me.settings(), me.calendar("default")]); }),
        this.host.owner(),
      ]);
      const address = (main?.owner.address || identity.email || identity.username || "").toLowerCase();
      const zone = ianaZone(settings.timeZone) ?? "UTC";
      const hours = settings.workingHours;
      const hoursZone = hours ? ianaZone(hours.timeZone) ?? zone : zone;
      return { address, zone, ...(hours ? { workingHours: { days: hours.days, start: hours.start, end: hours.end, timeZone: hoursZone } } : {}) };
    });
  }

  async zone(): Promise<string> {
    return (await this.settings()).zone;
  }

  /** The user's own address (see `settings`) and name: the organizer of what this session creates. */
  async me(): Promise<{ address: string; name: string }> {
    const [{ address }, { name }] = await Promise.all([this.settings(), this.host.owner()]);
    return { address, name };
  }

  async units() {
    return calendarUnits((await this.host.owner()).objectId);
  }

  /** The units of the bound calendar, by its owner. */
  async boundUnits() {
    if (this.scope.kind !== "calendar") throw new Error("Not a calendar binding.");
    return calendarUnits(this.scope.owner.kind === "shared" ? this.scope.owner.id : (await this.host.owner()).objectId);
  }

  /** The organization's verified domains: who counts as a colleague. */
  async orgDomains(): Promise<string[]> {
    return await this.host.cached("orgDomains", ORGANIZATION_TTL_MS, () => this.host.read(organizationDomains));
  }

  async observe(title: string, description: string, revealed: readonly string[]): Promise<void> {
    await this.gate.authorize({ title, description },
      revealed.length > 0 ? { kind: "collections", ids: [...new Set(revealed)] } : { kind: "baseline" });
  }

  overlay(): CalendarOverlay {
    return new CalendarOverlay(this.host.pending(), id => this.host.resolve(id));
  }

  // -- calendars -----------------------------------------------------------------------------

  /**
   * The calendars the binding covers, as Exchange holds them now: the bound one (refused if it has
   * gone, or is now a different folder), or every one in the user's list.
   */
  async calendars(): Promise<GraphCalendar[]> {
    const scope = this.scope;
    if (scope.kind === "availability") return [];
    if (scope.kind === "all") {
      return await this.host.cached("calendars", CALENDARS_TTL_MS, () => this.calendarApi(api => api.calendars()));
    }
    const bound = await this.host.cached(`calendar:${scope.calendar.id}`, CALENDARS_TTL_MS, () => this.calendarApi(api => api.calendar(scope.calendar.id)));
    if (bound === null || bound.entryId !== scope.calendar.entryId) {
      throw new Error(`The calendar "${scope.calendar.name}" this connection is for no longer exists, or you no longer have access to it.`);
    }
    return [bound];
  }

  /** Whether the user owns a calendar, rather than having it shared with them (added to their list, in an "all" binding). */
  async owns(calendar: GraphCalendar): Promise<boolean> {
    const scope = this.scope;
    if (scope.kind === "calendar") return scope.owner.kind === "me";
    return calendar.owner.address.toLowerCase() === (await this.me()).address;
  }

  /** A calendar the agent named (or the default one), proven in scope. */
  async scopedCalendar(calendarId: string | undefined): Promise<GraphCalendar> {
    const calendars = await this.calendars();
    if (calendarId === undefined) {
      const chosen = this.scope.kind === "calendar" ? calendars[0] : calendars.find(calendar => calendar.isDefault) ?? calendars[0];
      if (chosen === undefined) throw new Error("There's no calendar here.");
      return chosen;
    }
    const found = calendars.find(calendar => calendar.id === calendarId);
    if (found === undefined) throw new OutsideCalendarError("That calendar");
    return found;
  }

  /** How the binding shows events of a calendar. An "all" binding shows the user's own private events, and others' as busy time. */
  async view(calendar: GraphCalendar): Promise<EventView> {
    const zone = await this.zone();
    const scope = this.scope;
    if (scope.kind === "calendar") return { details: scope.details, privateEvents: scope.privateEvents, zone };
    return { details: "full", privateEvents: await this.owns(calendar) ? "show" : "busy", zone };
  }

  /** Records a read of one event, as `getEvent` does: what a change returns describes the event too. */
  async observeEvent(event: GraphEvent, calendar: GraphCalendar, view: EventView): Promise<void> {
    const info = this.info(event, calendar, view, this.overlay());
    await this.observe("Read a calendar event", `Read ${info.subject !== undefined ? `"${md(info.subject || "(no title)")}"` : "an event"} on ${md(info.start.slice(0, 16).replace("T", " "))}.`,
      [await this.calendarUnit(calendar, this.revealed([event], view))]);
  }

  /** The unit a read of a calendar's events revealed, at the level it revealed. */
  async calendarUnit(calendar: GraphCalendar, level: RevealLevel): Promise<string> {
    if (this.scope.kind !== "calendar") return (await this.units()).everything();
    return (await this.boundUnits()).calendar(calendar.id, level);
  }

  /** What a read of these events revealed of their calendar: the binding's level, or private events in detail. */
  revealed(events: readonly GraphEvent[], view: EventView): RevealLevel {
    if (view.details !== "freeBusy" && view.privateEvents === "show" && events.some(isPrivate)) return "private";
    return view.details;
  }

  // -- events --------------------------------------------------------------------------------

  /**
   * An event the agent named, proven in scope, as Exchange holds it now. Its parent folder must be
   * the bound calendar, or one of the user's calendars for an "all" binding; an availability binding
   * has no events at all.
   */
  async guarded(id: string): Promise<Guarded> {
    if (this.scope.kind === "availability") throw new Error("This Calendar connection covers availability only, not events.");
    const resolved = this.host.resolve(id);
    if (!isCalendarId(resolved)) throw new OutsideCalendarError();
    const [event, calendars] = await Promise.all([this.calendarApi(api => api.event(resolved)), this.calendars()]);
    const calendar = event?.parentEntryId === undefined ? undefined : calendars.find(candidate => candidate.entryId === event.parentEntryId);
    if (event === null || calendar === undefined) throw new OutsideCalendarError();
    return { event, calendar };
  }

  /** The series an occurrence belongs to, proven in the same calendar. */
  async series(guarded: Guarded): Promise<Guarded> {
    if (guarded.event.type === "seriesMaster") return guarded;
    if (guarded.event.seriesMasterId === undefined) throw new Error("That event isn't part of a series.");
    const series = await this.guarded(guarded.event.seriesMasterId);
    if (series.calendar.id !== guarded.calendar.id) throw new OutsideCalendarError();
    return series;
  }

  /**
   * Listed events, each confirmed in the calendar it was listed from. A calendar-scoped listing is
   * confined to that calendar (verified live); this checks every row anyway, by its parent's entry
   * ID, so a listing can never return an event the guard would refuse.
   */
  async confirmed(events: readonly GraphEvent[], calendar: GraphCalendar): Promise<GraphEvent[]> {
    const real = events.filter(event => !isProvisional(event.id));
    if (real.length === 0) return [...events];
    const parents = await this.calendarApi(api => api.parents(real.map(event => event.id)));
    return events.filter(event => isProvisional(event.id) || parents.get(event.id) === calendar.entryId);
  }

  /**
   * An event as the agent sees it in this binding, pending changes applied. A pending change can't
   * lower what the binding hides: an event Exchange holds as private stays a busy block until a
   * change making it otherwise has applied, since that change may yet be refused.
   */
  info(event: GraphEvent, calendar: GraphCalendar, view: EventView, overlay: CalendarOverlay): EventInfo {
    const applied = isProvisional(event.id) ? { event, pending: "create" as const } : overlay.apply(event);
    const shown = hidesDetails(event, view) ? { ...applied.event, sensitivity: event.sensitivity } : applied.event;
    const { pending } = applied;
    const info = eventInfo(shown, view, this.scope.kind === "all" ? calendar.id : undefined);
    return pending && view.details !== "freeBusy" ? { ...info, pending } : info;
  }

  /** The calendar an action changes, as the approver will recognize it. */
  calendarRef(calendar: GraphCalendar): CalendarRef {
    const owner = this.scope.kind === "calendar" ? this.scope.owner : { kind: "me" as const };
    return {
      owner, id: calendar.id, name: calendar.name,
      ...(owner.kind === "shared" ? { ownerAddress: owner.address } : {}),
    };
  }

  /** An event an action changes, as the approver will recognize it. */
  async target(event: GraphEvent, scope?: "series"): Promise<EventTarget> {
    const times = event.allDay ? eventTimes(event, await this.zone()) : { start: new Date(event.startMs).toISOString(), end: new Date(event.endMs).toISOString() };
    const organizer = event.organizer ? event.organizer.name ? `${event.organizer.name} <${event.organizer.address}>` : event.organizer.address : undefined;
    return {
      id: event.id, subject: event.subject, ...times, allDay: event.allDay, changeKey: event.changeKey,
      ...(scope === "series" ? { series: true as const } : event.type === "occurrence" || event.type === "exception" ? { occurrence: true as const } : {}),
      ...(organizer ? { organizer } : {}),
    };
  }

  /**
   * Whom a new meeting invites, while a pending change takes everyone off it: that change may be
   * rejected, so what follows it is still a change to a meeting (and is refused until it is decided).
   */
  invitedAtCreation(event: Pick<GraphEvent, "id">): InviteNote[] {
    if (!isProvisional(event.id)) return [];
    return this.overlay().created.find(pending => pending.id === event.id)?.event.attendees ?? [];
  }

  /**
   * Refuses to tell a meeting's attendees anything more while a pending action is still changing
   * who they are: until it is decided, nobody can say who an update or cancellation would reach.
   */
  requireInvitesSettled(event: Pick<GraphEvent, "id">): void {
    if ((this.overlay().changes.get(event.id) ?? []).some(change => change.changes.attendees !== undefined)) {
      throw new Error("A pending action is still changing who's invited to this meeting. Wait until it's approved or rejected before changing the meeting again.");
    }
  }

  async invites(attendees: readonly { address: string; name?: string; optional?: boolean }[]): Promise<InviteNote[]> {
    const [domains, me] = await Promise.all([this.orgDomains(), this.me()]);
    return attendees.map(attendee => ({
      address: attendee.address, ...(attendee.name ? { name: attendee.name } : {}), ...(attendee.optional ? { optional: true } : {}),
      notes: senderKind(attendee.address.toLowerCase(), me.address, domains) === "external" ? ["outside your organization"] : [],
    }));
  }

  // -- free/busy -----------------------------------------------------------------------------

  /** People's free/busy, as the user is given it. */
  async schedules(addresses: readonly string[], startMs: number, endMs: number): Promise<GraphSchedule[]> {
    return await this.host.read(api => new CalendarApi(api, { kind: "me" }).schedules(addresses, startMs, endMs));
  }

  /** The people availability may be asked about: anyone ("all", "availability"), or just the user for their own default calendar. */
  async checkPeople(people: unknown, includeMe: boolean): Promise<string[]> {
    const me = await this.me();
    if (people !== undefined && !Array.isArray(people)) throw new Error("people must be a list of addresses.");
    const list = (people as unknown[] | undefined) ?? [];
    if (list.length > MAX_PEOPLE) throw new Error(`Ask about at most ${MAX_PEOPLE} people at a time.`);
    const addresses = list.map((entry, index) => {
      try {
        return parseRecipient(entry as string).address.toLowerCase();
      } catch (error) {
        throw new Error(`people[${index}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    });
    const all = [...new Set([...(includeMe ? [me.address] : []), ...addresses])];
    if (all.length === 0) throw new Error("Pass at least one person.");
    const scope = this.scope;
    if (scope.kind === "calendar") {
      const calendar = (await this.calendars())[0]!;
      if (scope.owner.kind === "shared" || !calendar.isDefault || all.some(address => address !== me.address)) {
        throw new Error("This Calendar connection is for one calendar, so it can only show when that calendar is free: use findFreeTimes without people.");
      }
    }
    return all;
  }
}

// -- input checks -------------------------------------------------------------------------------

function pageSizeOf(value: number | undefined): number {
  const size = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw new Error(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  return size;
}

/** A window an agent passed, as instants: at most `MAX_WINDOW_DAYS`. */
function windowOf(start: unknown, end: unknown, zone: string, defaults: { startMs: number; days: number }): { startMs: number; endMs: number } {
  const startMs = start === undefined ? defaults.startMs : parseInstant(start, zone, "start");
  const endMs = end === undefined ? startMs + defaults.days * DAY_MS : parseInstant(end, zone, "end");
  if (endMs <= startMs) throw new Error("end must be after start.");
  if (endMs - startMs > MAX_WINDOW_DAYS * DAY_MS) throw new Error(`A window can be at most ${MAX_WINDOW_DAYS} days.`);
  return { startMs, endMs };
}

/** Runs a check, turning a time that can't be read into the error the agent sees. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof TimeError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

function oneLine(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  // oxlint-disable-next-line no-control-regex -- one line of text
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} can't contain line breaks or control characters.`);
  if (value.length > max) throw new Error(`${field} can be at most ${max} characters.`);
  return value;
}

function attendeesOf(list: unknown, me: string): { address: string; name?: string; optional?: boolean }[] {
  if (!Array.isArray(list)) throw new Error("attendees must be a list of addresses, or { address, optional }.");
  if (list.length > MAX_ATTENDEES) throw new Error(`A meeting can invite at most ${MAX_ATTENDEES} people at once.`);
  const seen = new Set<string>();
  const result: { address: string; name?: string; optional?: boolean }[] = [];
  list.forEach((entry, index) => {
    const raw = typeof entry === "string" ? entry : entry !== null && typeof entry === "object" ? (entry as { address?: unknown }).address : undefined;
    const optional = entry !== null && typeof entry === "object" && (entry as { optional?: unknown }).optional === true;
    let parsed;
    try {
      parsed = parseRecipient(raw as string);
    } catch (error) {
      throw new Error(`attendees[${index}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const key = parsed.address.toLowerCase();
    // The organizer isn't an attendee of their own meeting.
    if (key === me || seen.has(key)) return;
    seen.add(key);
    result.push({ ...parsed, ...(optional ? { optional: true } : {}) });
  });
  return result;
}

/**
 * The fields of an event an agent passed, checked, as an action writes them. `base` is the event
 * being changed, so a change of only its start keeps its length.
 */
function eventFields(input: EventChanges, zone: string, me: string, base?: GraphEvent): Partial<EventWrite> {
  const write: Partial<EventWrite> = {};
  if (input.subject !== undefined) write.subject = checkSubject(input.subject);
  if (input.start !== undefined || input.end !== undefined || input.allDay !== undefined) {
    const allDay = input.allDay ?? base?.allDay ?? false;
    if (base && allDay !== base.allDay && (input.start === undefined || input.end === undefined)) {
      throw new Error("Pass both start and end when changing whether an event is all day.");
    }
    if (allDay) {
      const start = input.start !== undefined ? checked(() => parseDate(input.start, "start")) : eventTimes(base!, zone).start;
      const length = base ? Math.max(1, Math.round((startOfDate(eventTimes(base, zone).end, zone) - startOfDate(eventTimes(base, zone).start, zone)) / DAY_MS)) : 1;
      const end = input.end !== undefined ? checked(() => parseDate(input.end, "end")) : nextDate(start, length);
      if (end <= start) throw new Error("An all-day event's end must be after its start: an event on the 18th alone ends on the 19th.");
      if (Date.parse(end) - Date.parse(start) > MAX_EVENT_DAYS * DAY_MS) throw new Error(`An event can last at most ${MAX_EVENT_DAYS} days.`);
      Object.assign(write, { start, end, allDay });
    } else {
      const startMs = input.start !== undefined ? checked(() => parseInstant(input.start, zone, "start")) : base!.startMs;
      const endMs = input.end !== undefined ? checked(() => parseInstant(input.end, zone, "end")) : startMs + (base ? base.endMs - base.startMs : 30 * MINUTE_MS);
      if (endMs <= startMs) throw new Error("end must be after start.");
      if (endMs - startMs > MAX_EVENT_DAYS * DAY_MS) throw new Error(`An event can last at most ${MAX_EVENT_DAYS} days.`);
      Object.assign(write, { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), allDay });
    }
  }
  if (input.location !== undefined) write.location = oneLine(input.location, "location", MAX_LOCATION_CHARS);
  if (input.body !== undefined) {
    const markdown = checkBody(input.body);
    if (markdown.length > MAX_WRITE_BODY_CHARS) throw new Error(`A description can be at most ${MAX_WRITE_BODY_CHARS.toLocaleString("en-US")} characters.`);
    write.markdown = markdown;
    write.html = markdownToMailHtml(markdown);
  }
  if (input.attendees !== undefined) write.attendees = attendeesOf(input.attendees, me).map(attendee => ({ ...attendee, notes: [] }));
  if (input.onlineMeeting !== undefined) {
    if (input.onlineMeeting) write.onlineMeeting = true;
  }
  if (input.showAs !== undefined) {
    if (!SHOW_AS_VALUES.includes(input.showAs)) throw new Error(`showAs must be one of ${SHOW_AS_VALUES.map(value => `"${value}"`).join(", ")}.`);
    write.showAs = input.showAs;
  }
  if (input.sensitivity !== undefined) {
    if (!(SENSITIVITY_VALUES as readonly string[]).includes(input.sensitivity)) throw new Error('sensitivity must be "normal", "personal", "private" or "confidential".');
    write.sensitivity = input.sensitivity;
  }
  if (input.reminder !== undefined) {
    if (input.reminder !== null && (!Number.isInteger(input.reminder) || input.reminder < 0 || input.reminder > MAX_REMINDER_MINUTES)) {
      throw new Error(`reminder must be minutes before the start, from 0 to ${MAX_REMINDER_MINUTES}, or null for none.`);
    }
    write.reminder = input.reminder;
  }
  if (input.categories !== undefined) {
    if (input.categories.length > MAX_CATEGORIES) throw new Error(`categories must be a list of at most ${MAX_CATEGORIES} names.`);
    write.categories = [...new Set(input.categories.map(name => oneLine(name, "A category", 255)))];
  }
  return write;
}

function messageOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("message must be text.");
  if (value.length > MAX_MESSAGE_CHARS) throw new Error(`A message can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`);
  return value;
}

/** Whether an event has anyone on it but its organizer: a meeting, which changes mail people. */
function hasOthers(event: Pick<GraphEvent, "attendees" | "organizer">): boolean {
  const organizer = event.organizer?.address.toLowerCase();
  return event.attendees.some(attendee => attendee.address.toLowerCase() !== organizer);
}

/** The fields of an event as they are now, for the ones a change touches: what a revert restores. */
function before(event: GraphEvent, changes: Partial<EventWrite>, zone: string, body?: { markdown: string; html: string }): Partial<EventWrite> {
  const was: Partial<EventWrite> = {};
  if (changes.subject !== undefined) was.subject = event.subject;
  if (changes.start !== undefined || changes.end !== undefined) {
    const times = event.allDay ? eventTimes(event, zone) : { start: new Date(event.startMs).toISOString(), end: new Date(event.endMs).toISOString() };
    Object.assign(was, times, { allDay: event.allDay });
  }
  if (changes.location !== undefined) was.location = event.location;
  if (changes.markdown !== undefined && body) Object.assign(was, body);
  if (changes.attendees !== undefined) was.attendees = event.attendees.map(({ address, name, type }) => ({ address, ...(name ? { name } : {}), ...(type === "optional" ? { optional: true } : {}), notes: [] }));
  if (changes.showAs !== undefined) was.showAs = event.showAs;
  if (changes.sensitivity !== undefined) was.sensitivity = event.sensitivity;
  if (changes.reminder !== undefined && event.reminder !== undefined) was.reminder = event.reminder;
  if (changes.categories !== undefined) was.categories = [...event.categories];
  return was;
}

/** "Standup (2026-10-18 09:00); private (2026-10-18 11:00)", for observations. */
function describeEvents(infos: readonly EventInfo[]): string {
  const line = (info: EventInfo) => `${info.subject !== undefined ? md(info.subject || "(no title)") : info.private ? "private" : md(info.showAs)} (${md(info.start.slice(0, 16).replace("T", " "))})`;
  return infos.slice(0, 20).map(line).join("; ") + (infos.length > 20 ? "; …" : "");
}

/** What a read-only binding hands out. */
@validateRpc()
export class CalendarReaderImpl extends RpcTarget implements CalendarReader {
  protected readonly ctx: CalendarContext;

  constructor(ctx: CalendarContext) {
    super();
    this.ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }

  async getOverview(): Promise<CalendarOverview> {
    const ctx = this.ctx;
    const [settings, me] = await Promise.all([ctx.settings(), ctx.me()]);
    const scope = ctx.scope;
    const calendar = scope.kind === "calendar" ? (await ctx.calendars())[0] : undefined;
    const overview: CalendarOverview = {
      covers: describeScope(scope, me.name),
      kind: scope.kind,
      ...(calendar ? { calendar: await this.#calendarInfo(calendar) } : {}),
      details: scope.kind === "calendar" ? scope.details : scope.kind === "availability" ? "freeBusy" : "full",
      access: ctx.host.access,
      timeZone: settings.zone,
      ...(settings.workingHours ? { workingHours: settings.workingHours } : {}),
    };
    const units = await ctx.units();
    // The calendar's name, and the user's working hours, which anyone given their free/busy sees.
    await ctx.observe("Read the Calendar connection's overview", `Read which calendar this connection covers: ${md(overview.covers)}.`, [
      ...(calendar ? [await ctx.calendarUnit(calendar, "freeBusy")] : []),
      ...(settings.workingHours ? [units.availability(me.address)] : []),
    ]);
    return overview;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const ctx = this.ctx;
    if (ctx.scope.kind === "availability") throw new Error("This Calendar connection covers availability only, not calendars.");
    const calendars = await ctx.calendars();
    const infos = await Promise.all(calendars.map(calendar => this.#calendarInfo(calendar)));
    await ctx.observe("Listed calendars", `Listed ${infos.length} calendar${infos.length === 1 ? "" : "s"}: ${infos.map(info => md(info.name)).join(", ")}.`,
      ctx.scope.kind === "calendar" ? [await ctx.calendarUnit(calendars[0]!, "freeBusy")] : [(await ctx.units()).everything()]);
    return infos;
  }

  async listEvents(options?: ListEventsOptions): Promise<Cursor<EventInfo>> {
    const ctx = this.ctx;
    if (ctx.scope.kind === "availability") throw new Error("This Calendar connection covers availability only, not events. Use getAvailability or findFreeTimes.");
    const size = pageSizeOf(options?.pageSize);
    const zone = await ctx.zone();
    const window = checked(() => windowOf(options?.start, options?.end, zone, { startMs: Date.now(), days: DEFAULT_WINDOW_DAYS }));
    if (options?.search !== undefined && (options.search.trim() === "" || options.search.length > 255)) {
      throw new Error("search must be some text to look for, at most 255 characters.");
    }
    const search = options?.search?.trim().toLowerCase();
    if (search !== undefined && ctx.scope.kind === "calendar" && ctx.scope.details === "freeBusy") {
      throw new Error("search isn't available at free/busy detail: this connection shows no titles or locations.");
    }
    const calendars = options?.calendarId !== undefined ? [await ctx.scopedCalendar(options.calendarId)] : await ctx.calendars();
    const overlay = ctx.overlay();
    const me = await ctx.me();
    const views = new Map(await Promise.all(calendars.map(async calendar => [calendar.id, await ctx.view(calendar)] as const)));

    // Every event in the window is read up front, at most 1,000, then served a page at a time; each
    // page is confirmed against its calendar and authorized as it is served.
    type Row = { event: GraphEvent; calendar: GraphCalendar };
    let rows: Row[] | undefined;
    const load = async (): Promise<Row[]> => {
      const all: Row[] = [];
      for (const calendar of calendars) {
        const view = views.get(calendar.id)!;
        let next: string | undefined;
        do {
          const page = await ctx.calendarApi(api => api.view(calendar.id, window.startMs, window.endMs, 100, next));
          for (const event of page.items) {
            if (overlay.hides(event) || event.type === "seriesMaster") continue;
            if (search !== undefined && !(searchable(event, view) && `${event.subject}\n${event.location}`.toLowerCase().includes(search))) continue;
            all.push({ event, calendar });
          }
          if (all.length > MAX_LISTED_EVENTS) throw new Error(`There are more than ${MAX_LISTED_EVENTS.toLocaleString("en-US")} events in that window. Ask for a shorter one.`);
          next = page.nextLink;
        } while (next !== undefined);
      }
      for (const pending of overlay.pendingEvents(window, new Set(calendars.map(calendar => calendar.id)), me)) {
        const calendar = calendars.find(candidate => candidate.id === pending.calendarId)!;
        if (search !== undefined && !`${pending.event.subject}\n${pending.event.location}`.toLowerCase().includes(search)) continue;
        all.push({ event: pending.event, calendar });
      }
      return all.toSorted((a, b) => a.event.startMs - b.event.startMs || a.event.endMs - b.event.endMs);
    };

    const walk = ctx.gate.lease();
    const where = calendars.length === 1 ? `"${md(calendars[0]!.name)}"` : "all calendars";
    const when = `${md(isoInZone(window.startMs, zone).slice(0, 16))} to ${md(isoInZone(window.endMs, zone).slice(0, 16))}`;
    // The rows of the page being authorized, by event ID, for the units they revealed.
    const served = new Map<string, Row>();
    return new TokenCursor<EventInfo>({
      pageSize: size,
      remotePageSize: size,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async (token, perPage) => {
        const all = rows ??= await load();
        const offset = token === undefined ? 0 : Number(token);
        let kept: Row[] = [];
        // Rows that aren't in the calendar they were listed from are dropped for good, so offsets
        // stay true; a page is never empty while rows remain, since an echoed token ends a walk.
        while (kept.length === 0 && offset < all.length) {
          const slice = all.slice(offset, offset + perPage);
          const confirmed = new Set<GraphEvent>();
          for (const calendar of new Set(slice.map(row => row.calendar))) {
            const events = slice.filter(row => row.calendar === calendar).map(row => row.event);
            for (const event of await ctx.confirmed(events, calendar)) confirmed.add(event);
          }
          kept = slice.filter(row => confirmed.has(row.event));
          if (kept.length < slice.length) {
            logger.error("a calendar listing returned events from another calendar", { event: "calendar.listing.foreign", count: slice.length - kept.length });
          }
          all.splice(offset, slice.length, ...kept);
        }
        for (const row of kept) served.set(row.event.id, row);
        const end = offset + kept.length;
        return {
          items: kept.map(row => ctx.info(row.event, row.calendar, views.get(row.calendar.id)!, overlay)),
          ...(end < all.length ? { nextToken: String(end) } : {}),
        };
      },
      authorizePage: async (items, { terminal }) => {
        const units = new Set<string>();
        for (const calendar of calendars) {
          const shown = items.map(item => served.get(item.id)).filter((row): row is Row => row?.calendar.id === calendar.id);
          // A listing reveals when the calendar is free, so even an empty one names the calendar.
          if (shown.length > 0 || items.length === 0) units.add(await ctx.calendarUnit(calendar, ctx.revealed(shown.map(row => row.event), views.get(calendar.id)!)));
        }
        await walk.authorize({
          title: "Listed calendar events",
          description: items.length === 0
            ? `Listed events in ${where} from ${when}${terminal ? "; there were no more" : ""}.`
            : `Listed ${items.length} event${items.length === 1 ? "" : "s"} in ${where} from ${when}: ${describeEvents(items)}.`,
        }, { kind: "collections", ids: [...units] });
      },
    });
  }

  async getEvent(eventId: string): Promise<EventContent> {
    const ctx = this.ctx;
    const overlay = ctx.overlay();
    const resolved = typeof eventId === "string" ? ctx.host.resolve(eventId) : eventId;
    if (typeof resolved === "string" && isProvisional(resolved)) return await this.#pendingEvent(resolved, overlay);
    const { event, calendar } = await ctx.guarded(eventId);
    if (overlay.hides(event)) throw new OutsideCalendarError();
    const view = await ctx.view(calendar);
    const info = ctx.info(event, calendar, view, overlay);
    let content: EventContent = { ...info, body: "", links: [], removed: [], truncated: false };
    if (view.details === "full" && !hidesDetails(event, view)) {
      const seriesId = event.type === "seriesMaster" ? event.id : event.seriesMasterId;
      const [body, pattern] = await Promise.all([
        ctx.calendarApi(api => api.body(event.id)),
        seriesId ? ctx.calendarApi(api => api.recurrence(seriesId)) : Promise.resolve(null),
      ]);
      // The organizer wrote this: hidden text, scripts and tracking go, as for mail. A pending
      // change of ours reads back as applied, as the rest of the event does.
      const converted = mailToMarkdown(body, { maxChars: MAX_BODY_READ_CHARS });
      const pendingBody = overlay.pendingBody(event);
      const recurrence = recurrenceWords(pattern);
      content = {
        ...content,
        ...(pendingBody === undefined
          ? { body: converted.markdown, links: converted.links, removed: converted.removed, truncated: converted.truncated }
          : { body: pendingBody }),
        ...(recurrence ? { recurrence } : {}),
        ...(event.seriesMasterId ? { seriesId: event.seriesMasterId } : {}),
      };
    }
    await ctx.observeEvent(event, calendar, view);
    return content;
  }

  async getAvailability(people: string[], start: string, end: string): Promise<Availability[]> {
    const ctx = this.ctx;
    const zone = await ctx.zone();
    const window = checked(() => windowOf(start, end, zone, { startMs: Date.now(), days: 1 }));
    const addresses = await ctx.checkPeople(people, false);
    const schedules = await ctx.schedules(addresses, window.startMs, window.endMs);
    const result = schedules.map(schedule => availability(schedule, zone));
    const units = await ctx.units();
    const seen = schedules.filter(schedule => schedule.error === undefined);
    await ctx.observe("Checked availability", `Checked when ${addresses.map(md).join(", ")} ${addresses.length === 1 ? "is" : "are"} free, ` +
      `${md(isoInZone(window.startMs, zone).slice(0, 16))} to ${md(isoInZone(window.endMs, zone).slice(0, 16))}.`,
    seen.map(schedule => units.availability(schedule.address)));
    return result;
  }

  async findFreeTimes(options: FreeTimeOptions): Promise<FreeTimes> {
    const ctx = this.ctx;
    const zone = await ctx.zone();
    const window = checked(() => windowOf(options.start, options.end, zone, { startMs: Date.now(), days: DEFAULT_WINDOW_DAYS }));
    if (!Number.isInteger(options.duration) || options.duration < 5 || options.duration > 24 * 60) throw new Error("duration must be whole minutes, from 5 to 1440.");
    const limit = options.limit ?? DEFAULT_SLOTS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SLOTS) throw new Error(`limit must be a whole number from 1 to ${MAX_SLOTS}.`);
    const workingHoursOnly = options.workingHoursOnly !== false;
    const tentativeIsFree = options.tentativeIsFree === true;
    // Never in the past.
    const from = { startMs: Math.max(window.startMs, Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS), endMs: window.endMs };
    if (from.endMs <= from.startMs) return { slots: [] };
    const settings = await ctx.settings();

    let people: Attendance[];
    let unknown: { address: string; error: string }[] = [];
    let revealed: string[];
    let who: string;
    if (ctx.scope.kind === "calendar" && options.people === undefined) {
      // One calendar's own free time: its events, as the binding sees them at free/busy.
      const calendar = (await ctx.calendars())[0]!;
      const overlay = ctx.overlay();
      const events: GraphEvent[] = [];
      let next: string | undefined;
      do {
        const page = await ctx.calendarApi(api => api.view(calendar.id, from.startMs, from.endMs, 100, next));
        events.push(...page.items.filter(event => !overlay.hides(event) && event.type !== "seriesMaster").map(event => overlay.apply(event).event));
        if (events.length > MAX_LISTED_EVENTS) throw new Error("That calendar is too full to search over that window. Ask for a shorter one.");
        next = page.nextLink;
      } while (next !== undefined);
      events.push(...overlay.pendingEvents(from, new Set([calendar.id])).map(pending => pending.event));
      const confirmed = await ctx.confirmed(events, calendar);
      const own = await ctx.owns(calendar);
      people = [{
        busy: confirmed.filter(event => event.showAs !== "free").map(event => ({ startMs: event.startMs, endMs: event.endMs, status: event.showAs })),
        ...(own && settings.workingHours ? { hours: { ...settings.workingHours, zone: settings.workingHours.timeZone } } : {}),
      }];
      revealed = [await ctx.calendarUnit(calendar, "freeBusy")];
      who = `"${md(calendar.name)}"`;
    } else {
      const addresses = await ctx.checkPeople(options.people, options.includeMe !== false);
      const schedules = await ctx.schedules(addresses, from.startMs, from.endMs);
      unknown = schedules.filter(schedule => schedule.error !== undefined).map(schedule => ({ address: schedule.address, error: schedule.error! }));
      const readable = schedules.filter(schedule => schedule.error === undefined);
      if (readable.length === 0) return { slots: [], unknown };
      people = readable.map(schedule => {
        const hoursZone = schedule.workingHours ? ianaZone(schedule.workingHours.timeZone) : null;
        return {
          busy: schedule.items.map(item => ({ startMs: item.startMs, endMs: item.endMs, status: item.status })),
          ...(schedule.workingHours && hoursZone ? { hours: { days: schedule.workingHours.days, start: schedule.workingHours.start, end: schedule.workingHours.end, zone: hoursZone } } : {}),
        };
      });
      const units = await ctx.units();
      revealed = readable.map(schedule => units.availability(schedule.address));
      who = readable.map(schedule => md(schedule.address)).join(", ");
    }
    const slots = freeTimes({ window: from, durationMs: options.duration * MINUTE_MS, people, workingHoursOnly, tentativeIsFree, limit })
      .map(slot => ({ start: isoInZone(slot.startMs, zone), end: isoInZone(slot.endMs, zone) }));
    await ctx.observe("Found free times", `Found ${slots.length} time${slots.length === 1 ? "" : "s"} when ${who} ${people.length === 1 ? "is" : "are"} free for ${options.duration} minutes.`, revealed);
    return { slots, ...(unknown.length ? { unknown } : {}) };
  }

  async findPeople(query: string): Promise<Person[]> {
    const ctx = this.ctx;
    if (typeof query !== "string" || query.trim().length < 2) throw new Error("Pass at least two characters of a name or address.");
    if (query.length > 100) throw new Error("A name or address to look up can be at most 100 characters.");
    const body = await ctx.host.read(api => api.get<{ value?: Record<string, unknown>[] }>("/me/people", {
      query: { $search: `"${query.trim().replace(/["\\]/g, "")}"`, $top: 10, $select: "displayName,scoredEmailAddresses,jobTitle,department" },
    }));
    const [me, domains] = await Promise.all([ctx.me(), ctx.orgDomains()]);
    const people: Person[] = [];
    for (const row of body.value ?? []) {
      const emails = Array.isArray(row.scoredEmailAddresses) ? row.scoredEmailAddresses as { address?: unknown }[] : [];
      const address = emails.map(email => email.address).find((value): value is string => typeof value === "string" && value.includes("@"));
      if (!address) continue;
      people.push({
        name: typeof row.displayName === "string" ? row.displayName : address,
        address,
        external: senderKind(address.toLowerCase(), me.address, domains) === "external",
        ...(typeof row.jobTitle === "string" && row.jobTitle ? { jobTitle: row.jobTitle } : {}),
        ...(typeof row.department === "string" && row.department ? { department: row.department } : {}),
      });
    }
    // The People API ranks the user's own contacts: only the user sees that.
    await ctx.observe("Looked up people in Microsoft 365", `Looked up ${md(query)} and found ${people.length}: ${people.map(person => md(person.name)).join(", ")}.`,
      [(await ctx.units()).everything()]);
    return people;
  }

  async #calendarInfo(calendar: GraphCalendar): Promise<CalendarInfo> {
    const owner = this.ctx.scope.kind === "calendar" && this.ctx.scope.owner.kind === "shared" ? { address: this.ctx.scope.owner.address } : calendar.owner;
    return {
      id: calendar.id, name: calendar.name, owner, isDefault: calendar.isDefault,
      canEdit: calendar.canEdit && allows(this.ctx.host.access, "edit"),
      ...(calendar.color ? { color: calendar.color } : {}),
    };
  }

  async #pendingEvent(id: string, overlay: CalendarOverlay): Promise<EventContent> {
    const ctx = this.ctx;
    const pending = overlay.pendingEvent(id, await ctx.me());
    if (pending === undefined) throw new OutsideCalendarError();
    const calendar = await ctx.scopedCalendar(pending.calendarId);
    const view = await ctx.view(calendar);
    const info = ctx.info(pending.event, calendar, view, overlay);
    // This session's own proposals: nothing Exchange holds is revealed.
    const body = overlay.pendingBody({ id }) ?? overlay.created.find(created => created.id === id)?.event.markdown ?? "";
    return { ...info, body: view.details === "full" ? body : "", links: [], removed: [], truncated: false };
  }
}

/** A schedule as the agent sees it: busy blocks in the user's zone, working hours in IANA terms. */
function availability(schedule: GraphSchedule, zone: string): Availability {
  if (schedule.error !== undefined) return { address: schedule.address, busy: [], error: schedule.error };
  const hoursZone = schedule.workingHours ? ianaZone(schedule.workingHours.timeZone) : null;
  return {
    address: schedule.address,
    busy: schedule.items.map(item => ({ start: isoInZone(item.startMs, zone), end: isoInZone(item.endMs, zone), showAs: item.status })),
    ...(schedule.workingHours && hoursZone ? { workingHours: { ...schedule.workingHours, timeZone: hoursZone } } : {}),
  };
}

/** What an "edit" or "schedule" binding hands out. */
@validateRpc()
export class CalendarSessionImpl extends CalendarReaderImpl implements CalendarSession {
  #require(level: CalendarAccessLevel, what: string): void {
    if (!allows(this.ctx.host.access, level)) {
      throw new Error(level === "schedule"
        ? `This Calendar connection can't ${what}: that sends mail to other people, which needs the "schedule" access level.`
        : `This Calendar connection can't ${what}; it can only read.`);
    }
  }

  /** An event this session may change: in scope, not a private event it shows only as busy time, in a calendar the user can edit. */
  async #changeable(eventId: string): Promise<{ event: GraphEvent; calendar: GraphCalendar; view: EventView }> {
    const ctx = this.ctx;
    const resolved = typeof eventId === "string" ? ctx.host.resolve(eventId) : eventId;
    if (typeof resolved === "string" && isProvisional(resolved)) {
      const pending = ctx.overlay().pendingEvent(resolved, await ctx.me());
      if (pending === undefined) throw new OutsideCalendarError();
      const calendar = await ctx.scopedCalendar(pending.calendarId);
      return { event: pending.event, calendar, view: await ctx.view(calendar) };
    }
    const { event, calendar } = await ctx.guarded(eventId);
    return await this.#checkChangeable(event, calendar);
  }

  /**
   * The checks every event a change names must pass, as Exchange holds it. A whole-series change
   * passes its series through them too: a private series can have an exception that isn't.
   */
  async #checkChangeable(event: GraphEvent, calendar: GraphCalendar): Promise<{ event: GraphEvent; calendar: GraphCalendar; view: EventView }> {
    const ctx = this.ctx;
    if (ctx.overlay().hides(event)) throw new OutsideCalendarError();
    const view = await ctx.view(calendar);
    if (hidesDetails(event, view)) throw new Error("That event is private. This connection shows it only as busy time, so it can't change it.");
    if (!calendar.canEdit) throw new Error(`You can't change events in "${calendar.name}".`);
    return { event, calendar, view };
  }

  async createEvent(input: EventInput): Promise<EventInfo> {
    const ctx = this.ctx;
    this.#require("edit", "create events");
    if (input.subject === undefined || input.start === undefined || input.end === undefined) throw new Error("An event needs a subject, a start and an end.");
    const [zone, me] = await Promise.all([ctx.zone(), ctx.me()]);
    const calendar = await ctx.scopedCalendar(input.calendarId);
    if (!calendar.canEdit) throw new Error(`You can't add events to "${calendar.name}".`);
    const fields = eventFields(input, zone, me.address);
    if (fields.onlineMeeting && !fields.attendees?.length) throw new Error("An online meeting needs someone to meet: add attendees.");
    const event: EventWrite = { ...fields, subject: fields.subject!, start: fields.start!, end: fields.end!, allDay: fields.allDay! };
    if (input.recurrence !== undefined) {
      const startDate = event.allDay ? event.start : dateInZone(Date.parse(event.start), zone);
      event.recurrence = checkRecurrence(input.recurrence, startDate);
    }
    const meeting = (event.attendees?.length ?? 0) > 0;
    if (meeting) {
      this.#require("schedule", "invite people");
      event.attendees = await ctx.invites(event.attendees!);
    }
    const ref = ctx.host.allocate("event");
    const payload: CalendarActions["createEvent"] = {
      calendar: ctx.calendarRef(calendar), ref, transactionId: crypto.randomUUID(), event, zone, submittedAt: Date.now(),
    };
    await ctx.host.submit(ctx.queue, meeting ? "createMeeting" : await ctx.owns(calendar) ? "createEvent" : "createSharedEvent", payload);
    return ctx.info(ctx.overlay().pendingEvent(ref, me)!.event, calendar, await ctx.view(calendar), ctx.overlay());
  }

  async updateEvent(eventId: string, changes: EventChanges, options?: EventChangeOptions): Promise<EventInfo> {
    const ctx = this.ctx;
    this.#require("edit", "change events");
    if (Object.keys(changes).length === 0) throw new Error("Pass at least one field to change.");
    if ("recurrence" in changes || "calendarId" in changes) throw new Error("An event's recurrence and calendar can't be changed here.");
    const series = options?.series === true;
    if (options?.message !== undefined) throw new Error("A message can only go with a cancellation. Outlook sends the update itself.");
    let { event, calendar, view } = await this.#changeable(eventId);
    if (series) {
      if (changes.start !== undefined || changes.end !== undefined || changes.allDay !== undefined) {
        throw new Error("A series' times can't be changed here: change one occurrence at a time, or delete the series and create it again.");
      }
      if (isProvisional(event.id)) throw new Error("That event hasn't been created yet.");
      const master = await ctx.series({ event, calendar });
      ({ event, calendar, view } = await this.#checkChangeable(master.event, master.calendar));
    }
    const [zone, me] = await Promise.all([ctx.zone(), ctx.me()]);
    const fields = eventFields(changes, zone, me.address, event);
    // Outlook keeps a Teams meeting's join details in its description, and drops the meeting with them.
    if (fields.markdown !== undefined && event.joinUrl !== undefined) {
      throw new Error("This is a Teams meeting, whose description holds its join details. Change the description in Outlook, which keeps them.");
    }
    const target = await ctx.target(event, series ? "series" : undefined);
    const othersBefore = hasOthers(event) ? event.attendees : ctx.invitedAtCreation(event);
    const meetingBefore = othersBefore.length > 0;
    const meetingAfter = fields.attendees !== undefined ? fields.attendees.length > 0 : meetingBefore;
    if (!event.isOrganizer && meetingBefore) {
      // Someone else's meeting: only what stays on the user's own calendar.
      const local = new Set(["categories", "showAs", "reminder"]);
      const other = Object.keys(fields).find(key => !local.has(key));
      if (other !== undefined) throw new Error("Only the organizer can change this meeting. Use respond to accept, decline or propose another time.");
    }
    if (fields.onlineMeeting) throw new Error("An online meeting link can only be added when the event is created.");
    let body: { markdown: string; html: string } | undefined;
    if (fields.markdown !== undefined && !isProvisional(event.id)) {
      const current = await ctx.calendarApi(api => api.body(event.id));
      body = { markdown: mailToMarkdown(current, { maxChars: MAX_WRITE_BODY_CHARS * 4 }).markdown, html: current.content };
    }
    await ctx.observeEvent(event, calendar, view);
    const payload: CalendarActions["updateEvent"] = {
      calendar: ctx.calendarRef(calendar), target, changes: fields, before: before(event, fields, zone, body), zone, submittedAt: Date.now(),
    };
    // Someone else's meeting was limited above to fields that stay on this calendar.
    if ((event.isOrganizer || !meetingBefore) && (meetingBefore || meetingAfter)) {
      this.#require("schedule", "change meetings");
      ctx.requireInvitesSettled(event);
      if (fields.attendees) fields.attendees = await ctx.invites(fields.attendees);
      const kept = fields.attendees ?? othersBefore.filter(attendee => attendee.address.toLowerCase() !== me.address);
      const notified = await ctx.invites(kept);
      const removed = (payload.before.attendees ?? []).filter(was => !kept.some(now => now.address.toLowerCase() === was.address.toLowerCase()));
      // Someone added gets the whole invitation, description included, not just what changed.
      const wasInvited = (address: string) => event.attendees.some(attendee => attendee.address.toLowerCase() === address.toLowerCase());
      await ctx.host.submit(ctx.queue, "updateMeeting", {
        ...payload, changes: fields,
        notified: [
          ...notified.map(invite => wasInvited(invite.address) ? invite : { ...invite, notes: [...invite.notes, "newly invited: gets the meeting with its description"] }),
          ...removed.map(was => ({ ...was, notes: [...was.notes, "removed: told they're no longer invited"] })),
        ],
      });
    } else {
      // A pending invitation would make this a change to a meeting, told to everyone on it.
      ctx.requireInvitesSettled(event);
      await ctx.host.submit(ctx.queue, await ctx.owns(calendar) ? "updateEvent" : "updateSharedEvent", payload);
    }
    const overlay = ctx.overlay();
    const shown = isProvisional(event.id) ? overlay.pendingEvent(event.id, me)!.event : event;
    return ctx.info(shown, calendar, view, overlay);
  }

  async deleteEvent(eventId: string, options?: EventChangeOptions): Promise<void> {
    const ctx = this.ctx;
    this.#require("edit", "delete events");
    const series = options?.series === true;
    const message = messageOf(options?.message);
    let { event, calendar } = await this.#changeable(eventId);
    if (series) {
      if (isProvisional(event.id)) throw new Error("That event hasn't been created yet.");
      const master = await ctx.series({ event, calendar });
      ({ event, calendar } = await this.#checkChangeable(master.event, master.calendar));
    }
    const [zone, me] = await Promise.all([ctx.zone(), ctx.me()]);
    const target = await ctx.target(event, series ? "series" : undefined);
    const others = hasOthers(event) ? event.attendees : ctx.invitedAtCreation(event);
    if (others.length > 0) {
      if (!event.isOrganizer) throw new Error("That's someone else's meeting. Use respond to decline it instead.");
      this.#require("schedule", "cancel meetings");
      ctx.requireInvitesSettled(event);
      const notified = await ctx.invites(others.filter(attendee => attendee.address.toLowerCase() !== me.address));
      await ctx.host.submit(ctx.queue, "cancelMeeting", {
        calendar: ctx.calendarRef(calendar), target, ...(message ? { message } : {}), notified, zone, submittedAt: Date.now(),
      });
      return;
    }
    if (message !== undefined) throw new Error("Nobody else is on this event, so there's nobody to send a message to.");
    // A pending invitation would make this a cancellation, told to everyone on it.
    ctx.requireInvitesSettled(event);
    // A single event can be recreated on revert; an occurrence or series can't be put back as it was.
    let snapshot: EventWrite | undefined;
    if (event.type === "singleInstance" && !isProvisional(event.id)) {
      const body = await ctx.calendarApi(api => api.body(event.id));
      const times = event.allDay ? eventTimes(event, zone) : { start: new Date(event.startMs).toISOString(), end: new Date(event.endMs).toISOString() };
      snapshot = {
        subject: event.subject, ...times, allDay: event.allDay, location: event.location,
        markdown: mailToMarkdown(body, { maxChars: MAX_WRITE_BODY_CHARS * 4 }).markdown, html: body.content,
        showAs: event.showAs === "unknown" ? "busy" : event.showAs, sensitivity: event.sensitivity,
        ...(event.reminder !== undefined ? { reminder: event.reminder } : {}), categories: [...event.categories],
      };
    }
    await ctx.host.submit(ctx.queue, await ctx.owns(calendar) ? "deleteEvent" : "deleteSharedEvent", {
      calendar: ctx.calendarRef(calendar), target, ...(snapshot ? { snapshot } : {}), zone, submittedAt: Date.now(),
    });
  }

  async respond(eventId: string, response: "accept" | "tentative" | "decline", options?: RespondOptions): Promise<EventInfo> {
    const ctx = this.ctx;
    this.#require("schedule", "respond to invitations");
    if (response !== "accept" && response !== "tentative" && response !== "decline") throw new Error('response must be "accept", "tentative" or "decline".');
    const { event, calendar, view } = await this.#changeable(eventId);
    if (isProvisional(event.id) || event.isOrganizer || !hasOthers(event)) throw new Error("That isn't an invitation from someone else, so there's nothing to respond to.");
    const zone = await ctx.zone();
    const message = messageOf(options?.message);
    const notify = options?.notify ?? event.responseRequested;
    if (message !== undefined && !notify) throw new Error("A message needs the organizer to be told: leave notify on.");
    let propose: { start: string; end: string } | undefined;
    if (options?.propose !== undefined) {
      if (response === "accept") throw new Error("A new time can only be proposed when tentatively accepting or declining.");
      if (!event.allowNewTimeProposals) throw new Error("The organizer doesn't accept proposals of new times for this meeting.");
      if (!notify) throw new Error("Proposing a new time tells the organizer: leave notify on.");
      const proposed = options.propose;
      const startMs = checked(() => parseInstant(proposed?.start, zone, "propose.start"));
      const endMs = checked(() => parseInstant(proposed?.end, zone, "propose.end"));
      if (endMs <= startMs) throw new Error("propose.end must be after propose.start.");
      if (endMs - startMs > MAX_EVENT_DAYS * DAY_MS) throw new Error(`A meeting can last at most ${MAX_EVENT_DAYS} days.`);
      propose = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
    }
    await ctx.observeEvent(event, calendar, view);
    await ctx.host.submit(ctx.queue, "respond", {
      calendar: ctx.calendarRef(calendar), target: await ctx.target(event), response, ...(message ? { message } : {}), notify,
      ...(propose ? { propose } : {}), zone, submittedAt: Date.now(),
    });
    return ctx.info(event, calendar, view, ctx.overlay());
  }
}

