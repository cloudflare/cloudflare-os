// Changes awaiting approval, as reads see them: an event being created lists with a `~N` ID, a
// change reads back as made, a deleted event is gone, and a response shows as given. Nothing here
// reads Graph. The overlay works on Graph's own event shape, before the binding's view cuts it to
// a level of detail (calendar-events.ts), so a simulated change is redacted exactly as a real one
// would be. It changes only events the guard already admitted, and adds only the session's own.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { CalendarAction, EventWrite } from "./calendar-actions";
import type { GraphEvent, GraphResponse } from "./calendar-graph";
import { startOfDate } from "./calendar-time";
import type { EventInfo } from "./calendar-types";

type Pending = readonly JournalEntry<CalendarAction>[];

/** An event a pending action creates. */
export type PendingEvent = { id: string; calendarId: string; event: EventWrite; zone: string };

const RESPONDED: Record<"accept" | "tentative" | "decline", GraphResponse> = {
  accept: "accepted", tentative: "tentativelyAccepted", decline: "declined",
};

/** An event as an action writes it, in Graph's shape, so the view cuts it as any other. */
function writtenEvent(id: string, write: EventWrite, zone: string, organizer?: { address: string; name?: string }): GraphEvent {
  return {
    id,
    changeKey: "",
    subject: write.subject,
    location: write.location ?? "",
    startMs: write.allDay ? startOfDate(write.start, zone) : Date.parse(write.start),
    endMs: write.allDay ? startOfDate(write.end, zone) : Date.parse(write.end),
    allDay: write.allDay,
    originalZone: zone,
    showAs: write.showAs ?? "busy",
    sensitivity: write.sensitivity ?? "normal",
    ...(organizer ? { organizer } : {}),
    isOrganizer: true,
    attendees: (write.attendees ?? []).map(invite => ({
      address: invite.address, ...(invite.name ? { name: invite.name } : {}), type: invite.optional ? "optional" : "required", response: "none",
    })),
    response: "organizer",
    responseRequested: true,
    categories: write.categories ?? [],
    importance: "normal",
    preview: (write.markdown ?? "").replace(/[#>*_`~|[\]()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 255),
    webLink: "",
    type: write.recurrence ? "seriesMaster" : "singleInstance",
    cancelled: false,
    allowNewTimeProposals: true,
  };
}

/** A pending change's fields over an event as Exchange holds it. */
function changed(event: GraphEvent, changes: Partial<EventWrite>, zone: string): GraphEvent {
  const allDay = changes.allDay ?? event.allDay;
  const time = (value: string) => allDay ? startOfDate(value, zone) : Date.parse(value);
  return {
    ...event,
    ...(changes.subject !== undefined ? { subject: changes.subject } : {}),
    ...(changes.location !== undefined ? { location: changes.location } : {}),
    ...(changes.start !== undefined ? { startMs: time(changes.start), allDay, originalZone: zone } : {}),
    ...(changes.end !== undefined ? { endMs: time(changes.end) } : {}),
    ...(changes.showAs !== undefined ? { showAs: changes.showAs } : {}),
    ...(changes.sensitivity !== undefined ? { sensitivity: changes.sensitivity } : {}),
    ...(changes.categories !== undefined ? { categories: changes.categories } : {}),
    ...(changes.attendees !== undefined ? {
      attendees: changes.attendees.map(invite => ({
        address: invite.address, ...(invite.name ? { name: invite.name } : {}), type: invite.optional ? "optional" as const : "required" as const,
        response: event.attendees.find(attendee => attendee.address.toLowerCase() === invite.address.toLowerCase())?.response ?? "none",
      })),
    } : {}),
    ...(changes.markdown !== undefined ? { preview: changes.markdown.replace(/\s+/g, " ").trim().slice(0, 255) } : {}),
  };
}

/** The pending actions of a binding, indexed for reads. */
export class CalendarOverlay {
  readonly created: PendingEvent[] = [];
  /** Pending changes by event ID (real, or `~N`); a series' changes are filed under the series. */
  readonly changes = new Map<string, { changes: Partial<EventWrite>; zone: string }[]>();
  /** Events, and whole series, pending deletion or cancellation. */
  readonly deleted = new Set<string>();
  readonly responses = new Map<string, "accept" | "tentative" | "decline">();

  constructor(pending: Pending, resolve: (id: string) => string) {
    for (const { action } of pending) {
      switch (action.kind) {
        case "createEvent":
        case "createSharedEvent":
        case "createMeeting":
          this.created.push({ id: action.payload.ref, calendarId: action.payload.calendar.id, event: action.payload.event, zone: action.payload.zone });
          break;
        case "updateEvent":
        case "updateSharedEvent":
        case "updateMeeting": {
          const id = resolve(action.payload.target.id);
          this.changes.set(id, [...(this.changes.get(id) ?? []), { changes: action.payload.changes, zone: action.payload.zone }]);
          break;
        }
        case "deleteEvent":
        case "deleteSharedEvent":
        case "cancelMeeting":
          this.deleted.add(resolve(action.payload.target.id));
          break;
        case "respond":
          this.responses.set(action.payload.target.id, action.payload.response);
          break;
      }
    }
  }

  /** Whether reads should leave an event out: it, or its series, is being deleted. */
  hides(event: Pick<GraphEvent, "id" | "seriesMasterId">): boolean {
    return this.deleted.has(event.id) || (event.seriesMasterId !== undefined && this.deleted.has(event.seriesMasterId));
  }

  /** The description the latest pending change gives an event, its series' changes included; undefined when none changes it. */
  pendingBody(event: Pick<GraphEvent, "id" | "seriesMasterId">): string | undefined {
    const fromSeries = event.seriesMasterId === undefined ? [] : (this.changes.get(event.seriesMasterId) ?? []);
    return [...fromSeries, ...(this.changes.get(event.id) ?? [])].map(change => change.changes.markdown).filter(body => body !== undefined).at(-1);
  }

  /** An event as it will be once the pending changes apply, and which kind of change is pending. */
  apply(event: GraphEvent): { event: GraphEvent; pending?: EventInfo["pending"] } {
    let result = event;
    let pending: EventInfo["pending"];
    const own = this.changes.get(event.id) ?? [];
    // A series' changes reach each occurrence, except its times: an occurrence keeps its own.
    const fromSeries = event.seriesMasterId === undefined ? [] : (this.changes.get(event.seriesMasterId) ?? [])
      .map(({ changes: { start: _start, end: _end, allDay: _allDay, ...rest }, zone }) => ({ changes: rest, zone }));
    for (const change of [...fromSeries, ...own]) {
      result = changed(result, change.changes, change.zone);
      pending = "update";
    }
    const response = this.responses.get(event.id) ?? (event.seriesMasterId ? this.responses.get(event.seriesMasterId) : undefined);
    if (response) {
      result = { ...result, response: RESPONDED[response], showAs: response === "accept" ? "busy" : response === "tentative" ? "tentative" : "free" };
      pending = "respond";
    }
    return { event: result, ...(pending ? { pending } : {}) };
  }

  /** Events pending creation overlapping a window, in one calendar or any, as Graph events. */
  pendingEvents(window: { startMs: number; endMs: number }, calendarIds: ReadonlySet<string> | null, organizer?: { address: string; name?: string }): { event: GraphEvent; calendarId: string }[] {
    return this.created
      .filter(pending => !this.deleted.has(pending.id) && (calendarIds === null || calendarIds.has(pending.calendarId)))
      .map(pending => ({ event: this.apply(writtenEvent(pending.id, pending.event, pending.zone, organizer)).event, calendarId: pending.calendarId }))
      .filter(({ event }) => event.endMs > window.startMs && event.startMs < window.endMs);
  }

  /** One event pending creation, by its `~N`. */
  pendingEvent(id: string, organizer?: { address: string; name?: string }): { event: GraphEvent; calendarId: string } | undefined {
    const pending = this.created.find(created => created.id === id);
    if (pending === undefined || this.deleted.has(id)) return undefined;
    return { event: this.apply(writtenEvent(pending.id, pending.event, pending.zone, organizer)).event, calendarId: pending.calendarId };
  }
}
