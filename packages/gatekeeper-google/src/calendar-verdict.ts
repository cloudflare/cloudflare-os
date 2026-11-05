import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { LiveCalendarEvent } from "./calendar-api";
import type { CalendarEventDraft, CalendarEventPatch } from "./calendar-types";

// Which Google Calendar changes a user may auto-approve. Adding or changing an event that only the
// bound calendar holds may be; anything Google would send to other people (invitations, updates,
// cancellations) or that widens who can see an event always waits for a person.

/** Adding or changing an event nobody but the bound calendar is on. */
export const CALENDAR_EVENTS_ACTION: ActionKind = {
  tag: "calendar-events",
  label: "Add and change calendar events",
};

/** Creating or changing a meeting, which Google tells its attendees about. Never auto-approved. */
export const CALENDAR_INVITATIONS_ACTION: ActionKind = {
  tag: "calendar-invitations",
  label: "Send event invitations and updates",
};

/** The kind and auto-approval verdict of one Calendar action. */
export type CalendarVerdict = { actionKind: ActionKind; autoApprovable: boolean };

const INVITATION: CalendarVerdict = { actionKind: CALENDAR_INVITATIONS_ACTION, autoApprovable: false };

type Visibility = NonNullable<CalendarEventPatch["visibility"]>;

// How widely each visibility shows an event's details. `default` follows the calendar's sharing,
// which is at most public; `confidential` is Google's older name for `private`.
const VISIBILITY_REACH: Record<Visibility, number> = {
  private: 0,
  confidential: 0,
  default: 1,
  public: 2,
};

// The session takes agent input without runtime validation, so the predicates below fail closed:
// a visibility they do not recognise counts as wider than any other, and attendees that are present but not
// a list count as other people.

/** How widely `visibility` shows an event; anything unrecognised counts as wider than public. */
function visibilityReach(visibility: unknown): number {
  return typeof visibility === "string" && Object.hasOwn(VISIBILITY_REACH, visibility)
    ? VISIBILITY_REACH[visibility as Visibility]
    : Infinity;
}

/** Whether an agent-supplied attendee list is present and not empty, or is not a list at all. */
function namesAnyAttendee(attendees: unknown): boolean {
  return attendees !== undefined && (!Array.isArray(attendees) || attendees.length > 0);
}

/** Whether `attendees` names anyone besides the bound calendar's own entry. */
function namesOtherAttendees(attendees: unknown): boolean {
  if (attendees === undefined) return false;
  if (!Array.isArray(attendees)) return true;
  return attendees.some((attendee: { self?: unknown } | null | undefined) => attendee?.self !== true);
}

/**
 * Whether anyone besides the bound calendar is on the event or may be: an attendee other than the
 * calendar itself, attendees Google left out of the list, or an organizer that is someone else.
 */
export function involvesOtherPeople(event: LiveCalendarEvent): boolean {
  return event.attendeesOmitted === true ||
    (event.organizer !== undefined && event.organizer.self !== true) ||
    namesOtherAttendees(event.attendees);
}

/**
 * Whether the patch shows the event to more people than its current visibility does. Narrowing
 * or restating it does not. An event whose current visibility is unrecognised counts as the
 * narrowest, so any visibility other than a private one widens it.
 */
export function widensVisibility(event: LiveCalendarEvent, patch: CalendarEventPatch): boolean {
  if (patch.visibility === undefined) return false;
  let current = event.visibility ?? "default";
  let currentReach = Object.hasOwn(VISIBILITY_REACH, current) ? VISIBILITY_REACH[current] : 0;
  return visibilityReach(patch.visibility) > currentReach;
}

/**
 * A new event with attendees is an invitation. One without may be auto-approved unless it is
 * public; a `default` event follows the calendar's sharing, which the user chose.
 */
export function createEventVerdict(event: CalendarEventDraft): CalendarVerdict {
  if (namesAnyAttendee(event.attendees)) return INVITATION;
  return {
    actionKind: CALENDAR_EVENTS_ACTION,
    autoApprovable: visibilityReach(event.visibility ?? "default") < VISIBILITY_REACH.public,
  };
}

/**
 * A change to an event other people are on, or that adds some, reaches them. Otherwise it may be
 * auto-approved unless it widens the event's visibility or the event is not a plain one: an
 * out-of-office or focus-time event can decline other people's invitations as the user.
 * `event` is the event as Google holds it with this binding's pending changes laid over it.
 */
export function updateEventVerdict(event: LiveCalendarEvent, patch: CalendarEventPatch): CalendarVerdict {
  if (involvesOtherPeople(event) || namesAnyAttendee(patch.attendees)) return INVITATION;
  let plain = event.eventType === undefined || event.eventType === "default";
  return {
    actionKind: CALENDAR_EVENTS_ACTION,
    autoApprovable: plain && !widensVisibility(event, patch),
  };
}
