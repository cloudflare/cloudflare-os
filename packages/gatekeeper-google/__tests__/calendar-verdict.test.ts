import { describe, expect, it } from "vitest";
import type { LiveCalendarEvent } from "../src/calendar-api";
import type { CalendarEventDraft, CalendarEventPatch } from "../src/calendar-types";
import {
  CALENDAR_EVENTS_ACTION, CALENDAR_INVITATIONS_ACTION, createEventVerdict, involvesOtherPeople,
  updateEventVerdict, widensVisibility,
} from "../src/calendar-verdict";

const draft: CalendarEventDraft = {
  title: "Focus",
  start: { kind: "dateTime", dateTime: new Date("2026-01-05T09:00:00Z") },
  end: { kind: "dateTime", dateTime: new Date("2026-01-05T10:00:00Z") },
};

const personal: LiveCalendarEvent = {
  id: "event-1",
  title: "Focus",
  start: draft.start,
  end: draft.end,
  status: "confirmed",
  organizer: { self: true },
};

const ownEvent = { actionKind: CALENDAR_EVENTS_ACTION, autoApprovable: true };
const heldOwnEvent = { actionKind: CALENDAR_EVENTS_ACTION, autoApprovable: false };
const invitation = { actionKind: CALENDAR_INVITATIONS_ACTION, autoApprovable: false };

describe("Calendar action kinds", () => {
  it("are distinct tags with their own labels", () => {
    expect(CALENDAR_EVENTS_ACTION).toEqual(
      { tag: "calendar-events", label: "Add and change calendar events" });
    expect(CALENDAR_INVITATIONS_ACTION).toEqual(
      { tag: "calendar-invitations", label: "Send event invitations and updates" });
  });
});

describe("createEventVerdict", () => {
  it("lets an event with nobody on it be auto-approved", () => {
    expect(createEventVerdict(draft)).toEqual(ownEvent);
    expect(createEventVerdict({ ...draft, attendees: [] })).toEqual(ownEvent);
    expect(createEventVerdict({ ...draft, visibility: "default" })).toEqual(ownEvent);
    expect(createEventVerdict({ ...draft, visibility: "private" })).toEqual(ownEvent);
  });

  it("holds a public event", () => {
    expect(createEventVerdict({ ...draft, visibility: "public" })).toEqual(heldOwnEvent);
  });

  it("makes an event with attendees an invitation", () => {
    expect(createEventVerdict({ ...draft, attendees: [{ email: "guest@example.com" }] }))
      .toEqual(invitation);
  });

  // The session does not validate agent input at runtime, so these reach the predicate as sent.
  it("holds an event whose visibility it does not recognise", () => {
    for (let visibility of ["PUBLIC", "Public", "public ", "__proto__", "toString", 2]) {
      expect(createEventVerdict({ ...draft, visibility } as unknown as CalendarEventDraft))
        .toEqual(heldOwnEvent);
    }
  });

  it("makes attendees that are not a list an invitation", () => {
    for (let attendees of [{}, { length: 0 }, null, "guest@example.com"]) {
      expect(createEventVerdict({ ...draft, attendees } as unknown as CalendarEventDraft))
        .toEqual(invitation);
    }
  });
});

describe("involvesOtherPeople", () => {
  it("ignores the calendar's own attendee entry", () => {
    expect(involvesOtherPeople(personal)).toBe(false);
    expect(involvesOtherPeople({
      ...personal, attendees: [{ email: "me@example.com", self: true, organizer: true }],
    })).toBe(false);
  });

  it("counts any other attendee", () => {
    expect(involvesOtherPeople({
      ...personal,
      attendees: [{ email: "me@example.com", self: true }, { email: "guest@example.com" }],
    })).toBe(true);
  });

  it("counts attendees Google left out of the list", () => {
    expect(involvesOtherPeople({ ...personal, attendeesOmitted: true })).toBe(true);
  });

  it("counts an organizer who is someone else", () => {
    expect(involvesOtherPeople({ ...personal, organizer: { self: false } })).toBe(true);
  });

  it("counts attendees that are not a list", () => {
    for (let attendees of [{}, { length: 0 }, null]) {
      expect(involvesOtherPeople({ ...personal, attendees } as unknown as LiveCalendarEvent))
        .toBe(true);
    }
  });
});

describe("widensVisibility", () => {
  it("does not count leaving, restating or narrowing visibility", () => {
    expect(widensVisibility(personal, {})).toBe(false);
    expect(widensVisibility(personal, { visibility: "default" })).toBe(false);
    expect(widensVisibility(personal, { visibility: "private" })).toBe(false);
    expect(widensVisibility({ ...personal, visibility: "public" }, { visibility: "default" }))
      .toBe(false);
    expect(widensVisibility({ ...personal, visibility: "private" }, { visibility: "confidential" }))
      .toBe(false);
  });

  it("counts showing the event to more people", () => {
    expect(widensVisibility(personal, { visibility: "public" })).toBe(true);
    expect(widensVisibility({ ...personal, visibility: "private" }, { visibility: "default" }))
      .toBe(true);
    expect(widensVisibility({ ...personal, visibility: "confidential" }, { visibility: "public" }))
      .toBe(true);
  });

  it("counts a visibility it does not recognise as widening", () => {
    for (let visibility of ["PUBLIC", "Public", "public ", "__proto__", "toString", null]) {
      expect(widensVisibility(personal, { visibility } as unknown as CalendarEventPatch)).toBe(true);
      expect(widensVisibility(
        { ...personal, visibility: "public" }, { visibility } as unknown as CalendarEventPatch,
      )).toBe(true);
    }
  });

  it("treats an event whose current visibility it does not recognise as private", () => {
    let unknown = { ...personal, visibility: "PUBLIC" } as unknown as LiveCalendarEvent;
    expect(widensVisibility(unknown, { visibility: "private" })).toBe(false);
    expect(widensVisibility(unknown, { visibility: "default" })).toBe(true);
  });
});

describe("updateEventVerdict", () => {
  it("lets a change to an event nobody else is on be auto-approved", () => {
    expect(updateEventVerdict(personal, { title: "Deep work" })).toEqual(ownEvent);
    expect(updateEventVerdict({ ...personal, eventType: "default" }, { start: draft.start }))
      .toEqual(ownEvent);
    expect(updateEventVerdict(personal, { attendees: [] })).toEqual(ownEvent);
    expect(updateEventVerdict(personal, { visibility: "private" })).toEqual(ownEvent);
  });

  it("makes a change to a meeting an invitation", () => {
    expect(updateEventVerdict(
      { ...personal, attendees: [{ email: "guest@example.com" }] }, { title: "Moved" },
    )).toEqual(invitation);
    // Removing everyone still sends them a cancellation.
    expect(updateEventVerdict(
      { ...personal, attendees: [{ email: "guest@example.com" }] }, { attendees: [] },
    )).toEqual(invitation);
    expect(updateEventVerdict({ ...personal, attendeesOmitted: true }, { title: "Moved" }))
      .toEqual(invitation);
    expect(updateEventVerdict({ ...personal, organizer: { self: false } }, { title: "Moved" }))
      .toEqual(invitation);
  });

  it("makes adding attendees an invitation", () => {
    expect(updateEventVerdict(personal, { attendees: [{ email: "guest@example.com" }] }))
      .toEqual(invitation);
  });

  it("holds a change that widens visibility", () => {
    expect(updateEventVerdict(personal, { visibility: "public" })).toEqual(heldOwnEvent);
    expect(updateEventVerdict({ ...personal, visibility: "private" }, { visibility: "default" }))
      .toEqual(heldOwnEvent);
  });

  it("holds a change whose visibility it does not recognise", () => {
    for (let visibility of ["PUBLIC", "__proto__"]) {
      expect(updateEventVerdict(personal, { visibility } as unknown as CalendarEventPatch))
        .toEqual(heldOwnEvent);
    }
  });

  it("makes a change with attendees that are not a list an invitation", () => {
    for (let attendees of [{}, { length: 0 }, null]) {
      expect(updateEventVerdict(personal, { attendees } as unknown as CalendarEventPatch))
        .toEqual(invitation);
    }
  });

  it("holds a change to an event that is not a plain one", () => {
    expect(updateEventVerdict({ ...personal, eventType: "outOfOffice" }, { end: draft.end }))
      .toEqual(heldOwnEvent);
    expect(updateEventVerdict({ ...personal, eventType: "focusTime" }, { title: "Focus" }))
      .toEqual(heldOwnEvent);
  });
});
