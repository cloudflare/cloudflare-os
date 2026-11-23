// Every change a Calendar binding can make, as the kit's action set: what each action stores, how
// the approver sees it, and how it is applied and reverted. Sessions stage actions; they are
// applied only once approved.
//
// Changes are split by who hears about them. An event with nobody else on it (`createEvent`,
// `updateEvent`, `deleteEvent`) touches only the user's calendar, so it can be auto-approved. A
// meeting (`createMeeting`, `updateMeeting`, `cancelMeeting`) and a response to an invitation
// (`respond`) send mail to other people, which can't be called back, so a person always decides.
//
// Creation is idempotent through Graph's `transactionId`, fixed at proposal: a replay after a crash
// gets the event already made, not a second one (verified live). A change or deletion is fenced on
// the event's change key as it was proposed (If-Match), so what is changed is what the approver saw;
// one proposed against a temporary `~N` ID is fenced on the change key the creation, or the last
// approved change, left (`eventVersion:` in the binding's storage), so an event that gained
// attendees in Outlook meanwhile isn't quietly changed or cancelled as one nobody else is on;
// cancel and respond take no If-Match, so they compare the change key first. Meeting updates,
// cancellations and responses mail people and can't be made idempotent, so each is claimed before
// it is applied and a crash can't send it twice.

import { ActionApplyError, defineActions, type ActionDefinition, type ActionPresentation, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { exchangeRefusal, isProvisional, realId } from "./binding";
import { GraphApiError, type GraphApi } from "./graph-api";
import { CalendarApi, idPath } from "./calendar-graph";
import { describeRecurrence, recurrenceJson } from "./calendar-events";
import type { CalendarAccessLevel, CalendarOwnerRef } from "./calendar-scope";
import { DAY_MS, durationWords, humanTime, localWallTime } from "./calendar-time";
import type { Recurrence, ShowAs } from "./calendar-types";
import { VENDOR_ID } from "./microsoft-env";

/** The calendar an action changes. */
export type CalendarRef = {
  owner: CalendarOwnerRef;
  id: string;
  name: string;
  /** Whose it is, by address, when it isn't the user's own: for the approver. */
  ownerAddress?: string;
};

/**
 * An event's fields as an action writes them. A timed event's `start` and `end` are UTC instants
 * (ISO 8601); an all-day event's are dates, `end` exclusive. `markdown` is what the approver reads;
 * `html` is what Outlook gets.
 */
export type EventWrite = {
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  markdown?: string;
  html?: string;
  attendees?: InviteNote[];
  onlineMeeting?: boolean;
  showAs?: ShowAs;
  sensitivity?: "normal" | "personal" | "private" | "confidential";
  /** Minutes before; null for none. */
  reminder?: number | null;
  categories?: string[];
  recurrence?: Recurrence;
};

/** Someone a meeting invites, with what to weigh before inviting them. */
export type InviteNote = { address: string; name?: string; optional?: boolean; notes: string[] };

/** An event an action changes, as it was read when proposed. */
export type EventTarget = {
  id: string;
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  /** Its change key when proposed: the change applies only if it is still this. */
  changeKey: string;
  /** One occurrence of a series. */
  occurrence?: true;
  /** The whole series. */
  series?: true;
  organizer?: string;
};

/** What each kind of action stores. `zone` is the user's, which times are written and shown in. */
export type CalendarActions = {
  createEvent: {
    calendar: CalendarRef; ref: string; transactionId: string; event: EventWrite; zone: string; submittedAt: number; createdId?: string; appliedAt?: number;
    /** The change key the creation left: an undo deletes the event only while it is still that version. */
    createdChangeKey?: string;
  };
  createMeeting: { calendar: CalendarRef; ref: string; transactionId: string; event: EventWrite; zone: string; submittedAt: number; createdId?: string; appliedAt?: number };
  /** The `*Event` kinds in a calendar someone else owns: the same change, never auto-approved. */
  createSharedEvent: CalendarActions["createEvent"];
  updateSharedEvent: CalendarActions["updateEvent"];
  deleteSharedEvent: CalendarActions["deleteEvent"];
  updateEvent: {
    calendar: CalendarRef; target: EventTarget; changes: Partial<EventWrite>; before: Partial<EventWrite>; zone: string;
    submittedAt: number; appliedAt?: number;
    /** The change key the update left: an undo writes the old values back only over that version. */
    appliedChangeKey?: string;
  };
  updateMeeting: {
    calendar: CalendarRef; target: EventTarget; changes: Partial<EventWrite>; before: Partial<EventWrite>; zone: string;
    /** Everyone on the meeting after the change, who Outlook sends the update to. */
    notified: InviteNote[];
    submittedAt: number; appliedAt?: number;
  };
  deleteEvent: {
    calendar: CalendarRef; target: EventTarget;
    /** The event as it was, to recreate it on revert (single events only). */
    snapshot?: EventWrite;
    zone: string; submittedAt: number; appliedAt?: number;
  };
  cancelMeeting: { calendar: CalendarRef; target: EventTarget; message?: string; notified: InviteNote[]; zone: string; submittedAt: number; appliedAt?: number };
  respond: {
    calendar: CalendarRef; target: EventTarget; response: "accept" | "tentative" | "decline"; message?: string; notify: boolean;
    propose?: { start: string; end: string };
    zone: string; submittedAt: number; appliedAt?: number;
  };
};

/** Any one Calendar action, tagged with its kind. */
export type CalendarAction = TaggedAction<CalendarActions>;

/** The change key an event had after this binding last wrote it, and when that was recorded. */
export type EventVersion = { changeKey: string; at: number };

/** What apply handlers may do. */
export type CalendarActionHost = {
  refs: ProvisionalIds<string>;
  graph<T>(op: (api: GraphApi) => Promise<T>, options?: { replayable?: boolean }): Promise<T>;
  invalidate(): Promise<void>;
  /** Records the change key an event has after this binding wrote it, stamped with now, or reads it back. */
  noteEventVersion(id: string, changeKey: string): void;
  eventVersion(id: string): EventVersion | undefined;
};

/** The access an action needs to apply, as its proposal needed: checked again at apply, since access may have been lowered since. */
export function requiredAccess(action: CalendarAction): CalendarAccessLevel {
  switch (action.kind) {
    case "createMeeting":
    case "updateMeeting":
    case "cancelMeeting":
    case "respond":
      return "schedule";
    default:
      return "edit";
  }
}

// -- describing ---------------------------------------------------------------------------------

// Description prose is Markdown the approver reads in the gatekeeper's own voice, and subjects,
// names and locations are written by whoever organized the event or by the agent. So in prose they
// go through `plainInline` (and lose `<`), which can't forge emphasis, links or structure; fields
// take them verbatim.

function prose(text: string): string {
  return plainInline(text.replace(/</g, ""));
}

function named(text: string): string {
  return `"${prose(text || "(no title)")}"`;
}

function calendarNote(calendar: CalendarRef): string {
  return calendar.ownerAddress ? ` in ${codeSpan(calendar.ownerAddress)}'s calendar ${named(calendar.name)}` : ` in your calendar ${named(calendar.name)}`;
}

/** "Sat, Oct 18, 2026, 9:00 AM PDT – 10:00 AM PDT (1 hour)" or "Sat, Oct 18, 2026 (all day)". */
function whenWords(event: Pick<EventWrite, "start" | "end" | "allDay">, zone: string): string {
  if (event.allDay) {
    const startMs = Date.parse(`${event.start}T00:00:00Z`);
    const days = Math.round((Date.parse(`${event.end}T00:00:00Z`) - startMs) / DAY_MS);
    const first = humanTime(startMs, zone, true);
    return days <= 1 ? `${first} (all day)` : `${first} – ${humanTime(startMs + (days - 1) * DAY_MS, zone, true)} (${days} days)`;
  }
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  return `${humanTime(startMs, zone)} – ${humanTime(endMs, zone)} (${durationWords(endMs - startMs)})`;
}

/** The address alone: a display name is the agent's to choose, and could read as one of the notes. */
function inviteLine(invite: InviteNote): string {
  const notes = [...(invite.optional ? ["optional"] : []), ...invite.notes];
  return notes.length ? `${invite.address} — ${notes.join("; ")}` : invite.address;
}

function addEvent(builder: ReturnType<typeof buildDescription>, event: Partial<EventWrite>, zone: string): void {
  if (event.subject !== undefined) builder.inline("Title", event.subject || "(no title)");
  if (event.start !== undefined && event.end !== undefined && event.allDay !== undefined) builder.inline("When", whenWords(event as EventWrite, zone));
  if (event.recurrence && event.start !== undefined) {
    const startDate = event.allDay ? event.start : localWallTime(Date.parse(event.start), zone).slice(0, 10);
    builder.inline("Repeats", describeRecurrence(event.recurrence, startDate, zone));
  }
  if (event.location !== undefined) builder.inline("Location", event.location || "(none)");
  if (event.attendees?.length) builder.list("Invites", event.attendees.map(inviteLine));
  if (event.onlineMeeting) builder.inline("Online meeting", "Teams meeting link added");
  if (event.showAs !== undefined) builder.inline("Show as", event.showAs);
  if (event.sensitivity !== undefined && event.sensitivity !== "normal") builder.inline("Sensitivity", event.sensitivity);
  if (event.reminder !== undefined) builder.inline("Reminder", event.reminder === null ? "none" : `${event.reminder} minutes before`);
  if (event.categories?.length) builder.list("Categories", event.categories);
  if (event.markdown !== undefined) builder.verbatim("Description", event.markdown, "markdown");
}

function addChanges(builder: ReturnType<typeof buildDescription>, payload: CalendarActions["updateEvent"]): void {
  addEvent(builder, payload.changes, payload.zone);
  const lines: string[] = [];
  if (payload.changes.subject !== undefined) lines.push(`Title: ${payload.before.subject || "(no title)"}`);
  if (payload.changes.start !== undefined && payload.before.start !== undefined && payload.before.end !== undefined && payload.before.allDay !== undefined) {
    lines.push(`When: ${whenWords(payload.before as EventWrite, payload.zone)}`);
  }
  if (payload.changes.location !== undefined) lines.push(`Location: ${payload.before.location || "(none)"}`);
  if (payload.changes.showAs !== undefined) lines.push(`Show as: ${payload.before.showAs ?? "busy"}`);
  if (payload.changes.attendees !== undefined) lines.push(`Invites: ${(payload.before.attendees ?? []).map(invite => invite.address).join(", ") || "(none)"}`);
  if (lines.length) builder.list("Before", lines);
  if (payload.changes.markdown !== undefined && payload.before.markdown !== undefined) builder.verbatim("Description before", payload.before.markdown, "markdown");
}

function targetLine(target: EventTarget, zone: string): string {
  return `${target.subject || "(no title)"} — ${whenWords(target, zone)}${target.series ? " (every occurrence)" : target.occurrence ? " (this occurrence)" : ""}`;
}

function title(verb: string, subject: string): string {
  return sanitizeTitle(`${verb} "${subject || "(no title)"}"`);
}

const RESPONSE_WORDS = { accept: "Accept", tentative: "Tentatively accept", decline: "Decline" } as const;

// -- applying -----------------------------------------------------------------------------------

function calendarApi(api: GraphApi, calendar: CalendarRef): CalendarApi {
  return new CalendarApi(api, calendar.owner);
}

/** A time as Graph writes it: in the user's zone, so a series keeps its wall-clock time across daylight saving. */
function timeJson(value: string, allDay: boolean, zone: string): { dateTime: string; timeZone: string } {
  return { dateTime: allDay ? `${value}T00:00:00` : localWallTime(Date.parse(value), zone), timeZone: zone };
}

/** An event's fields as Graph's JSON. Only what `write` has is included, so it serves creation and updates. */
function eventJson(write: Partial<EventWrite>, zone: string): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  if (write.subject !== undefined) json.subject = write.subject;
  if (write.start !== undefined && write.allDay !== undefined) json.start = timeJson(write.start, write.allDay, zone);
  if (write.end !== undefined && write.allDay !== undefined) json.end = timeJson(write.end, write.allDay, zone);
  if (write.allDay !== undefined) json.isAllDay = write.allDay;
  if (write.location !== undefined) json.location = { displayName: write.location };
  if (write.html !== undefined) json.body = { contentType: "HTML", content: write.html };
  if (write.attendees !== undefined) {
    json.attendees = write.attendees.map(invite => ({
      emailAddress: { address: invite.address, ...(invite.name ? { name: invite.name } : {}) }, type: invite.optional ? "optional" : "required",
    }));
  }
  if (write.onlineMeeting) Object.assign(json, { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" });
  if (write.showAs !== undefined) json.showAs = write.showAs;
  if (write.sensitivity !== undefined) json.sensitivity = write.sensitivity;
  if (write.reminder !== undefined) {
    Object.assign(json, write.reminder === null ? { isReminderOn: false } : { isReminderOn: true, reminderMinutesBeforeStart: write.reminder });
  }
  if (write.categories !== undefined) json.categories = write.categories;
  if (write.recurrence !== undefined && write.start !== undefined && write.allDay !== undefined) {
    const startDate = write.allDay ? write.start : localWallTime(Date.parse(write.start), zone).slice(0, 10);
    json.recurrence = recurrenceJson(write.recurrence, startDate, zone);
  }
  return json;
}

/** The weak ETag Graph's If-Match wants for a change key. */
function etag(changeKey: string): string | undefined {
  return changeKey ? `W/"${changeKey}"` : undefined;
}

/**
 * The change key an action's target must still have: the one the approver saw, unless a change of
 * this binding's own applied after the proposal left another (two changes pending on one event
 * apply in turn, the second to the version the first left), or the event was proposed against its
 * temporary ID, when the version its creation or last approved change left is the only one known.
 * An edit made in Outlook meanwhile matches neither. Empty when the proposal had none to fence on.
 */
function expectedVersion(host: CalendarActionHost, target: EventTarget, id: string, submittedAt: number): string {
  const version = host.eventVersion(id);
  if (version !== undefined && version.at > submittedAt) return version.changeKey;
  if (!isProvisional(target.id)) return target.changeKey;
  if (version === undefined) throw new ActionApplyError("The event's version since it was created isn't known, so nothing was changed. Ask the agent to read it again.");
  return version.changeKey;
}

/**
 * Records the version a response left the event at, for a change pending on the same event. The
 * response has been sent, so a failed read can't fail it: the version goes unrecorded, and that
 * change is fenced on the key its approver saw, which refuses it until the agent reads again.
 */
async function noteVersionLeft(host: CalendarActionHost, calendar: CalendarRef, id: string): Promise<void> {
  try {
    const current = await host.graph(api => calendarApi(api, calendar).find<{ changeKey?: unknown }>(`/events/${idPath(id)}`, { $select: "changeKey" }), { replayable: true });
    if (typeof current?.changeKey === "string") host.noteEventVersion(id, current.changeKey);
  } catch {
    // Left unrecorded, as above.
  }
}

async function create<P extends CalendarActions["createEvent"]>(payload: P, host: CalendarActionHost): Promise<{ action: P }> {
  let created: { id: string; changeKey?: string };
  try {
    const body = await host.graph(api => calendarApi(api, payload.calendar).request<{ id?: unknown; changeKey?: unknown }>("POST",
      `/calendars/${idPath(payload.calendar.id)}/events`, { ...eventJson(payload.event, payload.zone), transactionId: payload.transactionId }), { replayable: true });
    if (typeof body?.id !== "string") throw new GraphApiError(502, "Outlook didn't say which event it created.");
    created = { id: body.id, ...(typeof body.changeKey === "string" ? { changeKey: body.changeKey } : {}) };
  } catch (error) {
    exchangeRefusal(error, "The event");
  }
  host.refs.bind(payload.ref, created.id);
  if (created.changeKey !== undefined) host.noteEventVersion(created.id, created.changeKey);
  await host.invalidate();
  return { action: { ...payload, createdId: created.id, ...(created.changeKey ? { createdChangeKey: created.changeKey } : {}), appliedAt: Date.now() } };
}

/**
 * A change or deletion that tells nobody is fenced on the version a change of this binding's own
 * left when one applied after it was proposed (or, proposed against an event's temporary ID, the
 * version its creation left), which an invitation approved meanwhile may have moved: Outlook would
 * then send this change to the invitees. The live event is checked instead.
 */
async function requireStillPersonal(host: CalendarActionHost, calendar: CalendarRef, target: EventTarget, id: string, submittedAt: number): Promise<void> {
  const version = host.eventVersion(id);
  if (!isProvisional(target.id) && !(version !== undefined && version.at > submittedAt)) return;
  const placement = await host.graph(api => calendarApi(api, calendar).placement(id), { replayable: true });
  if (placement?.ownMeeting) {
    throw new ActionApplyError("The event has become a meeting since this was proposed, so nothing was changed. Ask the agent to read it again.");
  }
}

async function update<P extends CalendarActions["updateEvent"]>(payload: P, host: CalendarActionHost): Promise<{ action: P }> {
  const id = realId(host.refs, payload.target.id, "The event");
  const ifMatch = etag(expectedVersion(host, payload.target, id, payload.submittedAt));
  if (!("notified" in payload)) await requireStillPersonal(host, payload.calendar, payload.target, id, payload.submittedAt);
  let appliedChangeKey: string | undefined;
  try {
    const updated = await host.graph(api => calendarApi(api, payload.calendar).request<{ changeKey?: unknown }>("PATCH", `/events/${idPath(id)}`,
      eventJson(payload.changes, payload.zone), ifMatch));
    if (typeof updated?.changeKey === "string") appliedChangeKey = updated.changeKey;
    // An action pending on the same event is fenced on what this change left.
    if (appliedChangeKey !== undefined) host.noteEventVersion(id, appliedChangeKey);
  } catch (error) {
    exchangeRefusal(error, "The event");
  }
  await host.invalidate();
  return { action: { ...payload, ...(appliedChangeKey ? { appliedChangeKey } : {}), appliedAt: Date.now() } };
}

/** Fails unless the event still has the change key it was proposed with: for operations Graph won't fence itself. */
async function requireUnchanged(api: CalendarApi, host: CalendarActionHost, target: EventTarget, id: string, submittedAt: number): Promise<void> {
  const expected = expectedVersion(host, target, id, submittedAt);
  if (expected === "") return;
  const current = await api.find<{ changeKey?: unknown }>(`/events/${idPath(id)}`, { $select: "changeKey" });
  if (current === null) throw new ActionApplyError("The event no longer exists, or you no longer have access to it.");
  if (current.changeKey !== expected) {
    throw new ActionApplyError("The event changed after this was proposed, so nothing was sent. Ask the agent to read it again.");
  }
}

// -- the action set -----------------------------------------------------------------------------

const EVENTS = { tag: "calendar.events", label: "Change your own calendar events" } as const;
const INVITATIONS = { tag: "calendar.invitations", label: "Send meeting invitations, updates and cancellations" } as const;
const RESPONSES = { tag: "calendar.responses", label: "Respond to meeting invitations" } as const;
const SHARED_EVENTS = { tag: "calendar.shared-events", label: "Change events in other people's calendars" } as const;

const ownDefinitions = {
  createEvent: {
    kind: EVENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Add an event${calendarNote(payload.calendar)}. Nobody else is invited, so nobody is told.`);
      addEvent(builder, payload.event, payload.zone);
      return { title: title("Add the event", payload.event.subject), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    apply: create,
  },

  createMeeting: {
    kind: INVITATIONS,
    // Never: an invitation lands in other people's inboxes and can't be called back.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const invited = payload.event.attendees ?? [];
      const flagged = invited.filter(invite => invite.notes.length > 0);
      const builder = buildDescription(`Send a meeting invitation to ${invited.length} ${invited.length === 1 ? "person" : "people"}` +
        `${calendarNote(payload.calendar)}. Once sent, it can't be called back.` +
        (flagged.length ? ` ${flagged.length} ${flagged.length === 1 ? "invitee is" : "invitees are"} worth a second look; see the notes beside them.` : ""));
      addEvent(builder, payload.event, payload.zone);
      return { title: title("Send the invitation", payload.event.subject), ...builder.finish(), implementsRevert: false } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    apply: create,
  },

  updateEvent: {
    kind: EVENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Change ${named(payload.target.subject)}${calendarNote(payload.calendar)}` +
        `${payload.target.series ? ", every occurrence" : payload.target.occurrence ? ", this occurrence only" : ""}. ` +
        "Nobody else is told. It applies only if the event hasn't changed since.");
      builder.inline("Event", targetLine(payload.target, payload.zone));
      addChanges(builder, payload);
      return { title: title("Change the event", payload.target.subject), ...builder.finish(), implementsRevert: true } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.target.id) ? [payload.target.id] : [],
    apply: update,
  },

  updateMeeting: {
    kind: INVITATIONS,
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Change the meeting ${named(payload.target.subject)}${calendarNote(payload.calendar)}` +
        `${payload.target.series ? ", every occurrence" : payload.target.occurrence ? ", this occurrence only" : ""}. ` +
        `Outlook sends the update to ${payload.notified.length} ${payload.notified.length === 1 ? "person" : "people"}, and it can't be called back. ` +
        "It applies only if the meeting hasn't changed since.");
      builder.inline("Meeting", targetLine(payload.target, payload.zone));
      addChanges(builder, payload);
      builder.list("Told about the change", payload.notified.map(inviteLine));
      return { title: title("Update the meeting", payload.target.subject), ...builder.finish(), implementsRevert: false } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.target.id) ? [payload.target.id] : [],
    // A replay after a crash would send the update twice.
    claimBeforeApply: true,
    apply: update,
  },

  deleteEvent: {
    kind: EVENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete ${named(payload.target.subject)}${calendarNote(payload.calendar)}` +
        `${payload.target.series ? ", every occurrence" : payload.target.occurrence ? ", this occurrence only" : ""}. Nobody else is told.`);
      builder.inline("Event", targetLine(payload.target, payload.zone));
      return { title: title("Delete the event", payload.target.subject), ...builder.finish(), implementsRevert: payload.snapshot !== undefined } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.target.id) ? [payload.target.id] : [],
    apply: async (payload, host) => {
      const id = realId(host.refs, payload.target.id, "The event");
      const ifMatch = etag(expectedVersion(host, payload.target, id, payload.submittedAt));
      await requireStillPersonal(host, payload.calendar, payload.target, id, payload.submittedAt);
      try {
        await host.graph(api => calendarApi(api, payload.calendar).request("DELETE", `/events/${idPath(id)}`, undefined, ifMatch), { replayable: true });
      } catch (error) {
        // Already gone: a replay of this deletion, or removed in Outlook meanwhile.
        if (!(error instanceof GraphApiError && error.status === 404)) exchangeRefusal(error, "The event");
      }
      await host.invalidate();
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  cancelMeeting: {
    kind: INVITATIONS,
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Cancel the meeting ${named(payload.target.subject)}${calendarNote(payload.calendar)}` +
        `${payload.target.series ? ", every occurrence" : payload.target.occurrence ? ", this occurrence only" : ""}. ` +
        `Outlook tells ${payload.notified.length} ${payload.notified.length === 1 ? "person" : "people"}, and it can't be undone.`);
      builder.inline("Meeting", targetLine(payload.target, payload.zone));
      builder.list("Told about the cancellation", payload.notified.map(inviteLine));
      if (payload.message) builder.verbatim("Message to them", payload.message);
      return { title: title("Cancel the meeting", payload.target.subject), ...builder.finish(), implementsRevert: false } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.target.id) ? [payload.target.id] : [],
    claimBeforeApply: true,
    apply: async (payload, host) => {
      const id = realId(host.refs, payload.target.id, "The event");
      try {
        await host.graph(async api => {
          const calendar = calendarApi(api, payload.calendar);
          await requireUnchanged(calendar, host, payload.target, id, payload.submittedAt);
          await calendar.request("POST", `/events/${idPath(id)}/cancel`, { comment: payload.message ?? "" });
        });
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        exchangeRefusal(error, "The event");
      }
      await host.invalidate();
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  respond: {
    kind: RESPONSES,
    // Never: the organizer gets the response by mail.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    describe: payload => {
      const verb = RESPONSE_WORDS[payload.response];
      const proposal = payload.propose ? `, proposing ${whenWords({ ...payload.propose, allDay: false }, payload.zone)} instead` : "";
      const told = payload.notify
        ? ` ${payload.target.organizer ? prose(payload.target.organizer) : "The organizer"} is told, and it can't be called back.`
        : " The organizer isn't told; only your calendar changes.";
      const builder = buildDescription(`${verb} the invitation ${named(payload.target.subject)}${proposal}.${told}`);
      builder.inline("Meeting", targetLine(payload.target, payload.zone));
      if (payload.target.organizer) builder.inline("Organizer", payload.target.organizer);
      if (payload.propose) builder.inline("Proposed time", whenWords({ ...payload.propose, allDay: false }, payload.zone));
      if (payload.message) builder.verbatim("Message to the organizer", payload.message);
      return { title: title(verb, payload.target.subject), ...builder.finish(), implementsRevert: false } satisfies ActionPresentation;
    },
    claimBeforeApply: true,
    apply: async (payload, host) => {
      const action = payload.response === "accept" ? "accept" : payload.response === "tentative" ? "tentativelyAccept" : "decline";
      try {
        await host.graph(async api => {
          const calendar = calendarApi(api, payload.calendar);
          await requireUnchanged(calendar, host, payload.target, payload.target.id, payload.submittedAt);
          await calendar.request("POST", `/events/${idPath(payload.target.id)}/${action}`, {
            comment: payload.message ?? "", sendResponse: payload.notify,
            ...(payload.propose ? {
              proposedNewTime: {
                start: { dateTime: new Date(payload.propose.start).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
                end: { dateTime: new Date(payload.propose.end).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
              },
            } : {}),
          });
        });
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        exchangeRefusal(error, "The event");
      }
      // Responding changes the event's key; a change of the user's own copy pending on it must know.
      await noteVersionLeft(host, payload.calendar, payload.target.id);
      await host.invalidate();
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },
} satisfies { [K in Exclude<keyof CalendarActions, `${string}SharedEvent`>]: ActionDefinition<CalendarActions[K], CalendarActionHost> };

/** Every kind's definition. A change to someone else's calendar is never auto-approved: "your own events" doesn't cover it. */
export const definitions = {
  ...ownDefinitions,
  createSharedEvent: { ...ownDefinitions.createEvent, kind: SHARED_EVENTS, autoApprovable: false },
  updateSharedEvent: { ...ownDefinitions.updateEvent, kind: SHARED_EVENTS, autoApprovable: false },
  deleteSharedEvent: { ...ownDefinitions.deleteEvent, kind: SHARED_EVENTS, autoApprovable: false },
} satisfies { [K in keyof CalendarActions]: ActionDefinition<CalendarActions[K], CalendarActionHost> };

/** The Calendar action set. */
export const actions = defineActions<CalendarActionHost, CalendarActions>(definitions, {
  // Every kind acts as one Microsoft 365 user, fenced on their stable (tenant, object) ID.
  fence: "authority",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  afterResolve: host => host.invalidate(),
  vendorId: VENDOR_ID,
});

// -- reverting ----------------------------------------------------------------------------------

/** What a revert reports: nothing, a note about what happened, or why it failed. */
export type RevertOutcome = void | { message?: string; canRetry?: boolean; restart?: boolean };

const BECAME_MEETING = {
  message: "The event has become a meeting since, so undoing this would send everyone on it an update. Change it in Outlook instead.",
  canRetry: false,
} as const;

const LEFT_CALENDAR = {
  message: "The event is no longer in the calendar this connection covers, so it was left as it is.",
  canRetry: false,
} as const;

/**
 * What stands in the way of undoing a change to an event: it has left the calendar the action was
 * approved for, which is what proved it the binding's, or it has become a meeting the user
 * organizes, whose undo would mail everyone invited. One that is gone is left to the handler, whose
 * write finds nothing.
 */
async function blocksUndo(api: CalendarApi, calendar: CalendarRef, id: string): Promise<typeof LEFT_CALENDAR | typeof BECAME_MEETING | undefined> {
  const placed = await api.placement(id);
  if (placed === null) return undefined;
  const bound = await api.calendar(calendar.id);
  if (bound === null || placed.parentEntryId !== bound.entryId) return LEFT_CALENDAR;
  return placed.ownMeeting ? BECAME_MEETING : undefined;
}

/** Undoes an applied action where nobody else was told. Invitations, updates and responses can't be unsent. */
export async function revert(action: CalendarAction, host: CalendarActionHost): Promise<RevertOutcome> {
  switch (action.kind) {
    case "createEvent":
    case "createSharedEvent": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "The event was never created, so there is nothing to undo.", canRetry: false };
      const createdId = payload.createdId;
      // Fenced on the version the creation left: edited since, the user's later work stays.
      const createdChangeKey = payload.createdChangeKey;
      if (createdChangeKey === undefined) {
        return { message: "Outlook didn't say which version the creation left, so it wasn't undone. Delete the event in Outlook if you need to.", canRetry: false };
      }
      return await host.graph(async api => {
        const calendar = calendarApi(api, payload.calendar);
        // Deleting a meeting the user organizes cancels it for everyone.
        const blocked = await blocksUndo(calendar, payload.calendar, createdId);
        if (blocked !== undefined) return blocked;
        try {
          await calendar.request("DELETE", `/events/${idPath(createdId)}`, undefined, etag(createdChangeKey));
        } catch (error) {
          if (error instanceof GraphApiError && error.status === 404) return undefined;
          if (error instanceof GraphApiError && error.status === 412) {
            return { message: "The event has been changed since it was created, so it wasn't deleted. Delete it in Outlook if you need to.", canRetry: false as const };
          }
          throw error;
        }
        return undefined;
      }, { replayable: true });
    }
    case "updateEvent":
    case "updateSharedEvent": {
      const { payload } = action;
      const id = host.refs.resolve(payload.target.id);
      if (isProvisional(id)) return;
      const before: Partial<EventWrite> = {};
      for (const key of Object.keys(payload.changes) as (keyof EventWrite)[]) (before as Record<string, unknown>)[key] = payload.before[key];
      // Times are restored with the all-day flag they had.
      if (before.start !== undefined) before.allDay = payload.before.allDay;
      // Fenced on the version the change left: edited since, the user's later edits stay.
      const appliedChangeKey = payload.appliedChangeKey;
      if (appliedChangeKey === undefined) {
        return { message: "Outlook didn't say which version this change left, so it wasn't undone. Change the event in Outlook if you need to.", canRetry: false };
      }
      return await host.graph(async api => {
        const calendar = calendarApi(api, payload.calendar);
        const blocked = await blocksUndo(calendar, payload.calendar, id);
        if (blocked !== undefined) return blocked;
        try {
          await calendar.request("PATCH", `/events/${idPath(id)}`, eventJson(before, payload.zone), etag(appliedChangeKey));
        } catch (error) {
          if (error instanceof GraphApiError && error.status === 412) {
            return { message: "The event has been changed since, so it wasn't undone. Change it in Outlook if you need to.", canRetry: false as const };
          }
          throw error;
        }
        return undefined;
      }, { replayable: true });
    }
    case "deleteEvent":
    case "deleteSharedEvent": {
      const { payload } = action;
      if (payload.snapshot === undefined) return { message: "A deleted occurrence or series can't be put back automatically.", canRetry: false };
      // Recreated under a transaction ID derived from the deletion, so a retried revert can't make two.
      const created = await host.graph(api => calendarApi(api, payload.calendar).request<{ id?: unknown }>("POST",
        `/calendars/${idPath(payload.calendar.id)}/events`, { ...eventJson(payload.snapshot!, payload.zone), transactionId: `revert-${payload.target.id.slice(-40)}-${payload.submittedAt}` }), { replayable: true });
      return typeof created?.id === "string"
        ? { message: "The event is back, as a new event: anything that linked to the old one won't find it." }
        : undefined;
    }
    case "createMeeting":
      return { message: "The invitation has been sent and can't be called back. Cancel the meeting instead.", canRetry: false };
    case "updateMeeting":
      return { message: "The update has been sent to everyone on the meeting and can't be called back.", canRetry: false };
    case "cancelMeeting":
      return { message: "A cancelled meeting can't be restored. Send a new invitation instead.", canRetry: false };
    case "respond":
      return { message: "The response has been sent. Respond again to change it.", canRetry: false };
  }
}

/** The temporary IDs an action creates. */
export function providedRefs(action: CalendarAction): string[] {
  return action.kind === "createEvent" || action.kind === "createSharedEvent" || action.kind === "createMeeting" ? [action.payload.ref] : [];
}

/** The temporary IDs an action builds on. */
export function dependedRefs(action: CalendarAction): string[] {
  switch (action.kind) {
    case "updateEvent":
    case "updateSharedEvent":
    case "updateMeeting":
    case "deleteEvent":
    case "deleteSharedEvent":
    case "cancelMeeting":
      return isProvisional(action.payload.target.id) ? [action.payload.target.id] : [];
    default: return [];
  }
}

