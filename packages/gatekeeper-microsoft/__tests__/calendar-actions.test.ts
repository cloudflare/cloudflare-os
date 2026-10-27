// Applying and reverting Calendar actions against a fake Graph at `fetch`: what each kind sends,
// how it is fenced against a change made since it was proposed, and what its revert does.

import { describe, expect, it } from "vitest";
import { ActionApplyError } from "@gadgets/gatekeeper-kit/actions";
import { ProvisionalIds, type SimulationKv } from "@gadgets/gatekeeper-kit/simulation";
import {
  definitions, requiredAccess, revert, type CalendarAction, type CalendarActionHost, type CalendarActions, type CalendarRef, type EventTarget, type EventVersion,
} from "../src/calendar-actions";
import { GraphApi } from "../src/graph-api";

const ZONE = "America/Los_Angeles";
const CALENDAR: CalendarRef = { owner: { kind: "me" }, id: "AAMkCal", name: "Calendar" };
const SHARED: CalendarRef = { owner: { kind: "shared", id: "bbbbbbbb-0000-0000-0000-000000000002", address: "sarah@contoso.com" }, id: "AAMkSarahCal", name: "Team", ownerAddress: "sarah@contoso.com" };
const TARGET: EventTarget = { id: "AAMkEv", subject: "Standup", start: "2026-10-19T16:00:00.000Z", end: "2026-10-19T16:30:00.000Z", allDay: false, changeKey: "ck1" };

type Sent = { method: string; path: string; body?: Record<string, unknown>; ifMatch: string | null };

/** A Graph that answers each request with the next scripted reply, recording what was sent. */
function harness(replies: { status: number; body?: unknown }[] = []) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({
      method: init?.method ?? "GET", path: `${url.pathname.replace(/^\/v1\.0/, "")}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, ifMatch: new Headers(init?.headers).get("if-match"),
    });
    const reply = replies.shift() ?? { status: 204 };
    return reply.status === 204 ? new Response(null, { status: 204 }) : Response.json(reply.body ?? {}, { status: reply.status });
  };
  const api = new GraphApi("token", { fetch });
  const store = new Map<string, unknown>();
  const kv = {
    get: (key: string) => store.get(key), put: (key: string, value: unknown) => { store.set(key, value); },
    delete: (key: string) => store.delete(key), list: () => store.entries(),
  } as unknown as SimulationKv;
  let invalidated = 0;
  const versions = new Map<string, EventVersion>();
  const host: CalendarActionHost = {
    refs: new ProvisionalIds<string>(kv, { namespace: "refs:", isProvisional: id => id.startsWith("~") }),
    graph: op => op(api),
    invalidate: async () => { invalidated += 1; },
    noteEventVersion: (id, changeKey) => { versions.set(id, { changeKey, at: Date.now() }); },
    eventVersion: id => versions.get(id),
  };
  return { host, sent, invalidated: () => invalidated, versions };
}

/** What an undo reads first: where the event is and whether it is the user's meeting, then the calendar the action was approved for. */
const placed = (body: Record<string, unknown> = {}, parent = "entry-cal") => ({ status: 200, body: { isOrganizer: true, attendees: [], singleValueExtendedProperties: [{ id: "Binary 0x0E09", value: parent }], ...body } });
const boundCalendar = { status: 200, body: { id: "AAMkCal", name: "Calendar", singleValueExtendedProperties: [{ id: "Binary 0x0FFF", value: "entry-cal" }] } };

const conflict = { status: 412, body: { error: { code: "ErrorIrresolvableConflict", message: "The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item." } } };

const createPayload: CalendarActions["createEvent"] = {
  calendar: CALENDAR, ref: "~1", transactionId: "7d1c0b1e-6c5e-4f0e-9d7c-000000000001", zone: ZONE, submittedAt: 1,
  event: { subject: "Focus", start: "2026-10-19T16:00:00.000Z", end: "2026-10-19T17:00:00.000Z", allDay: false, reminder: null, categories: ["Deep work"] },
};

describe("creating", () => {
  it("posts into the chosen calendar in the user's zone, under its transaction ID, and binds the temporary ID", async () => {
    const { host, sent, invalidated } = harness([{ status: 201, body: { id: "AAMkNew" } }]);
    const { action } = await definitions.createEvent.apply(createPayload, host);
    expect(sent[0]).toMatchObject({
      method: "POST", path: "/me/calendars/AAMkCal/events",
      body: {
        subject: "Focus", isAllDay: false, isReminderOn: false, categories: ["Deep work"], transactionId: createPayload.transactionId,
        start: { dateTime: "2026-10-19T09:00:00", timeZone: ZONE }, end: { dateTime: "2026-10-19T10:00:00", timeZone: ZONE },
      },
    });
    expect(action.createdId).toBe("AAMkNew");
    expect(host.refs.resolve("~1")).toBe("AAMkNew");
    expect(invalidated()).toBe(1);
  });

  it("writes an all-day event as dates, and a shared calendar through its owner", async () => {
    const { host, sent } = harness([{ status: 201, body: { id: "AAMkNew" } }]);
    await definitions.createEvent.apply({ ...createPayload, calendar: SHARED, event: { subject: "Offsite", start: "2026-10-19", end: "2026-10-21", allDay: true } }, host);
    expect(sent[0]).toMatchObject({
      path: `/users/${SHARED.owner.kind === "shared" ? SHARED.owner.id : ""}/calendars/AAMkSarahCal/events`,
      body: { isAllDay: true, start: { dateTime: "2026-10-19T00:00:00", timeZone: ZONE }, end: { dateTime: "2026-10-21T00:00:00", timeZone: ZONE } },
    });
  });

  it("sends a meeting's attendees and Teams link", async () => {
    const { host, sent } = harness([{ status: 201, body: { id: "AAMkNew" } }]);
    await definitions.createMeeting.apply({
      ...createPayload,
      event: { ...createPayload.event, onlineMeeting: true, attendees: [{ address: "sarah@contoso.com", name: "Sarah", notes: [] }, { address: "ada@fabrikam.com", optional: true, notes: ["outside your organization"] }] },
    }, host);
    expect(sent[0]!.body).toMatchObject({
      isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness",
      attendees: [{ emailAddress: { address: "sarah@contoso.com", name: "Sarah" }, type: "required" }, { emailAddress: { address: "ada@fabrikam.com" }, type: "optional" }],
    });
  });

  it("fails for good on a refusal, and leaves an answer without an ID to be retried", async () => {
    const refused = harness([{ status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } }]);
    await expect(definitions.createEvent.apply(createPayload, refused.host)).rejects.toBeInstanceOf(ActionApplyError);
    const odd = harness([{ status: 201, body: {} }]);
    const error = await definitions.createEvent.apply(createPayload, odd.host).catch(caught => caught);
    expect(error).not.toBeInstanceOf(ActionApplyError);
  });
});

describe("changing and deleting", () => {
  const updatePayload: CalendarActions["updateEvent"] = {
    calendar: CALENDAR, target: TARGET, zone: ZONE, submittedAt: 1,
    changes: { subject: "Standup (moved)", start: "2026-10-19T17:00:00.000Z", end: "2026-10-19T17:30:00.000Z", allDay: false },
    before: { subject: "Standup", start: TARGET.start, end: TARGET.end, allDay: false },
  };

  it("patches only what changed, fenced on the change key it was proposed with", async () => {
    const { host, sent } = harness([{ status: 200, body: {} }]);
    await definitions.updateEvent.apply(updatePayload, host);
    expect(sent[0]).toEqual({
      method: "PATCH", path: "/me/events/AAMkEv", ifMatch: 'W/"ck1"',
      body: { subject: "Standup (moved)", isAllDay: false, start: { dateTime: "2026-10-19T10:00:00", timeZone: ZONE }, end: { dateTime: "2026-10-19T10:30:00", timeZone: ZONE } },
    });
  });

  it("changes nothing when the event changed since, and says so", async () => {
    const { host } = harness([conflict]);
    await expect(definitions.updateEvent.apply(updatePayload, host)).rejects.toThrow(new ActionApplyError("The event changed after this was proposed, so it was not applied. Ask the agent to read it again."));
  });

  const provisional: CalendarActions["deleteEvent"] = { calendar: CALENDAR, target: { ...TARGET, id: "~1", changeKey: "" }, zone: ZONE, submittedAt: 2 };

  it("changes an event created earlier in the same batch by its real ID, fenced on the version its creation left", async () => {
    const { host, sent } = harness([{ status: 201, body: { id: "AAMkNew", changeKey: "ckA" } }, placed(), { status: 200, body: { changeKey: "ckB" } }, placed()]);
    const { action: made } = await definitions.createEvent.apply(createPayload, host);
    expect(made.createdChangeKey).toBe("ckA");
    await definitions.updateEvent.apply({ ...updatePayload, target: provisional.target }, host);
    expect(sent[2]).toMatchObject({ method: "PATCH", path: "/me/events/AAMkNew", ifMatch: 'W/"ckA"' });
    // The next action on it is fenced on what that change left.
    await definitions.deleteEvent.apply(provisional, host);
    expect(sent[4]).toMatchObject({ method: "DELETE", path: "/me/events/AAMkNew", ifMatch: 'W/"ckB"' });
    await expect(definitions.updateEvent.apply({ ...updatePayload, target: { ...TARGET, id: "~2" } }, harness().host)).rejects.toThrow();
  });

  it("won't change or delete a real event once an invitation proposed before it was approved, which made it a meeting", async () => {
    const invited = placed({ attendees: [{ emailAddress: { address: "sarah@contoso.com" } }] });
    const { host, sent } = harness([invited, invited]);
    host.noteEventVersion(TARGET.id, "ckAfterInvite");
    await expect(definitions.updateEvent.apply({ ...updatePayload, submittedAt: 1 }, host)).rejects.toThrow(/become a meeting/);
    await expect(definitions.deleteEvent.apply({ ...provisional, target: TARGET, submittedAt: 1 }, host)).rejects.toThrow(/become a meeting/);
    expect(sent.filter(request => request.method !== "GET")).toHaveLength(0);
  });

  it("won't change or delete an event it created once a later-approved invitation made it a meeting, whatever version that left", async () => {
    const invited = placed({ attendees: [{ emailAddress: { address: "sarah@contoso.com" } }] });
    const { host, sent } = harness([{ status: 201, body: { id: "AAMkNew", changeKey: "ckA" } }, invited, invited]);
    await definitions.createEvent.apply(createPayload, host);
    host.noteEventVersion("AAMkNew", "ckAfterInvite");
    await expect(definitions.updateEvent.apply({ ...updatePayload, target: provisional.target }, host)).rejects.toThrow(/become a meeting/);
    await expect(definitions.deleteEvent.apply(provisional, host)).rejects.toThrow(/become a meeting/);
    expect(sent.filter(request => request.method !== "GET")).toHaveLength(1);
  });

  it("won't delete an event it created once Outlook changed it, as it may have become a meeting", async () => {
    const { host } = harness([{ status: 201, body: { id: "AAMkNew", changeKey: "ckA" } }, placed(), conflict]);
    await definitions.createEvent.apply(createPayload, host);
    await expect(definitions.deleteEvent.apply(provisional, host))
      .rejects.toThrow(new ActionApplyError("The event changed after this was proposed, so it was not applied. Ask the agent to read it again."));
    // Nor without knowing what version its creation left.
    const unknown = harness();
    unknown.host.refs.bind("~1", "AAMkNew");
    await expect(definitions.deleteEvent.apply(provisional, unknown.host)).rejects.toThrow(/version since it was created isn't known/);
    expect(unknown.sent).toEqual([]);
  });

  const undoable = { ...updatePayload, appliedChangeKey: "ckB", appliedAt: 2 };

  it("reverts a change by patching back just the fields it changed, fenced on the version the change left", async () => {
    const { host, sent } = harness([placed(), boundCalendar, { status: 200, body: {} }]);
    await revert({ kind: "updateEvent", payload: { ...undoable, before: { ...updatePayload.before, location: "never touched" } } }, host);
    expect(sent.slice(0, 2).map(request => request.path.replace(/\?.*/, ""))).toEqual(["/me/events/AAMkEv", "/me/calendars/AAMkCal"]);
    expect(sent[2]).toMatchObject({ method: "PATCH", path: "/me/events/AAMkEv", ifMatch: 'W/"ckB"', body: { subject: "Standup", start: { dateTime: "2026-10-19T09:00:00" } } });
    expect(sent[2]!.body).not.toHaveProperty("location");
    const edited = harness([placed(), boundCalendar, conflict]);
    expect(await revert({ kind: "updateEvent", payload: undoable }, edited.host)).toMatchObject({ message: expect.stringContaining("changed since"), canRetry: false });
    const unknown = harness([]);
    expect(await revert({ kind: "updateEvent", payload: updatePayload }, unknown.host)).toMatchObject({ message: expect.stringContaining("which version"), canRetry: false });
    expect(unknown.sent).toEqual([]);
  });

  it("records the version a change leaves, for its undo", async () => {
    const { host } = harness([{ status: 200, body: { changeKey: "ckB" } }]);
    const { action } = await definitions.updateEvent.apply(updatePayload, host);
    expect(action.appliedChangeKey).toBe("ckB");
  });

  it("won't revert a change once the event has become a meeting the user organizes, as that would mail everyone on it", async () => {
    const meeting = placed({ attendees: [{ emailAddress: { address: "sarah@contoso.com" } }] });
    const changed = harness([meeting, boundCalendar]);
    expect(await revert({ kind: "updateEvent", payload: undoable }, changed.host)).toMatchObject({ message: expect.stringContaining("become a meeting"), canRetry: false });
    expect(changed.sent.map(request => request.method)).toEqual(["GET", "GET"]);
    const created = harness([meeting, boundCalendar]);
    expect(await revert({ kind: "createEvent", payload: { ...createPayload, createdId: "AAMkNew", createdChangeKey: "ckA" } }, created.host)).toMatchObject({ canRetry: false });
    expect(created.sent.map(request => request.method)).toEqual(["GET", "GET"]);
  });

  it("leaves alone an event that has left the calendar the action was approved for, or whose calendar is gone", async () => {
    const elsewhere = harness([placed({}, "entry-other"), boundCalendar]);
    expect(await revert({ kind: "updateEvent", payload: undoable }, elsewhere.host)).toEqual({ message: expect.stringContaining("no longer in the calendar"), canRetry: false });
    expect(elsewhere.sent.map(request => request.method)).toEqual(["GET", "GET"]);
    const noCalendar = harness([placed(), { status: 404, body: { error: { code: "ErrorItemNotFound", message: "x" } } }]);
    expect(await revert({ kind: "createEvent", payload: { ...createPayload, createdId: "AAMkNew", createdChangeKey: "ckA" } }, noCalendar.host)).toEqual({ message: expect.stringContaining("no longer in the calendar"), canRetry: false });
    expect(noCalendar.sent.map(request => request.method)).toEqual(["GET", "GET"]);
  });

  it("still reverts the user's own fields on someone else's invitation, which tells nobody", async () => {
    const { host, sent } = harness([placed({ isOrganizer: false, attendees: [{ emailAddress: { address: "me@contoso.com" } }] }), boundCalendar, { status: 200, body: {} }]);
    await revert({ kind: "updateEvent", payload: { ...undoable, changes: { categories: ["Vendors"] }, before: { categories: [] } } }, host);
    expect(sent[2]).toMatchObject({ method: "PATCH", body: { categories: [] } });
  });

  it("deletes fenced on the change key, and takes an event already gone as deleted", async () => {
    const payload: CalendarActions["deleteEvent"] = { calendar: CALENDAR, target: TARGET, zone: ZONE, submittedAt: 5, snapshot: { subject: "Standup", start: TARGET.start, end: TARGET.end, allDay: false, location: "Room 1" } };
    const { host, sent } = harness([{ status: 404, body: { error: { code: "ErrorItemNotFound", message: "x" } } }]);
    await definitions.deleteEvent.apply(payload, host);
    expect(sent[0]).toMatchObject({ method: "DELETE", path: "/me/events/AAMkEv", ifMatch: 'W/"ck1"' });
    await expect(definitions.deleteEvent.apply(payload, harness([conflict]).host)).rejects.toBeInstanceOf(ActionApplyError);
  });

  it("puts a deleted event back as a new event, under a transaction ID a retried revert reuses", async () => {
    const payload: CalendarActions["deleteEvent"] = { calendar: CALENDAR, target: TARGET, zone: ZONE, submittedAt: 5, snapshot: { subject: "Standup", start: TARGET.start, end: TARGET.end, allDay: false, location: "Room 1" } };
    const first = harness([{ status: 201, body: { id: "AAMkBack" } }]);
    const outcome = await revert({ kind: "deleteEvent", payload }, first.host);
    expect(outcome).toEqual({ message: expect.stringContaining("as a new event") });
    const second = harness([{ status: 201, body: { id: "AAMkBack" } }]);
    await revert({ kind: "deleteEvent", payload }, second.host);
    expect(first.sent[0]!.body).toMatchObject({ subject: "Standup", location: { displayName: "Room 1" }, transactionId: "revert-AAMkEv-5" });
    expect(second.sent[0]!.body!.transactionId).toBe(first.sent[0]!.body!.transactionId);
    expect(await revert({ kind: "deleteEvent", payload: { ...payload, snapshot: undefined } }, harness().host)).toMatchObject({ canRetry: false });
  });

  it("reverts a creation by deleting what it created, fenced on the version it left, even if it is already gone", async () => {
    const gone = { status: 404, body: { error: { code: "ErrorItemNotFound", message: "x" } } };
    const { host, sent } = harness([gone, gone]);
    expect(await revert({ kind: "createEvent", payload: { ...createPayload, createdId: "AAMkNew", createdChangeKey: "ckA" } }, host)).toBeUndefined();
    expect(sent[1]).toMatchObject({ method: "DELETE", path: "/me/events/AAMkNew", ifMatch: 'W/"ckA"' });
    const edited = harness([placed(), boundCalendar, conflict]);
    expect(await revert({ kind: "createEvent", payload: { ...createPayload, createdId: "AAMkNew", createdChangeKey: "ckA" } }, edited.host)).toMatchObject({ message: expect.stringContaining("changed since it was created"), canRetry: false });
    const unknown = harness([]);
    expect(await revert({ kind: "createEvent", payload: { ...createPayload, createdId: "AAMkNew" } }, unknown.host)).toMatchObject({ message: expect.stringContaining("which version"), canRetry: false });
    expect(unknown.sent).toEqual([]);
  });
});

describe("what tells other people", () => {
  const notified = [{ address: "sarah@contoso.com", notes: [] }];

  it("cancels only if the meeting is unchanged, with the message", async () => {
    const payload: CalendarActions["cancelMeeting"] = { calendar: CALENDAR, target: TARGET, message: "Sorry", notified, zone: ZONE, submittedAt: 1 };
    const { host, sent } = harness([{ status: 200, body: { changeKey: "ck1" } }, { status: 202 }]);
    await definitions.cancelMeeting.apply(payload, host);
    expect(sent.map(request => `${request.method} ${request.path}`)).toEqual(["GET /me/events/AAMkEv?%24select=changeKey", "POST /me/events/AAMkEv/cancel"]);
    expect(sent[1]!.body).toEqual({ comment: "Sorry" });

    const changed = harness([{ status: 200, body: { changeKey: "ck2" } }]);
    await expect(definitions.cancelMeeting.apply(payload, changed.host)).rejects.toThrow("so nothing was sent");
    expect(changed.sent.map(request => request.method)).toEqual(["GET"]);
  });

  it("responds only if the invitation is unchanged, proposing a time in UTC", async () => {
    const payload: CalendarActions["respond"] = {
      calendar: CALENDAR, target: { ...TARGET, organizer: "Ada" }, response: "tentative", notify: true, message: "Later?",
      propose: { start: "2026-10-19T17:00:00.000Z", end: "2026-10-19T18:00:00.000Z" }, zone: ZONE, submittedAt: 1,
    };
    const { host, sent } = harness([{ status: 200, body: { changeKey: "ck1" } }, { status: 202 }]);
    await definitions.respond.apply(payload, host);
    expect(sent[1]).toMatchObject({
      method: "POST", path: "/me/events/AAMkEv/tentativelyAccept",
      body: { comment: "Later?", sendResponse: true, proposedNewTime: { start: { dateTime: "2026-10-19T17:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-10-19T18:00:00.000", timeZone: "UTC" } } },
    });
    const gone = harness([{ status: 404, body: { error: { code: "ErrorItemNotFound", message: "x" } } }]);
    await expect(definitions.respond.apply(payload, gone.host)).rejects.toThrow("no longer exists");
    const changed = harness([{ status: 200, body: { changeKey: "ck2" } }]);
    await expect(definitions.respond.apply(payload, changed.host)).rejects.toThrow("so nothing was sent");
    expect(changed.sent.map(request => request.method)).toEqual(["GET"]);
  });

  it("updates a meeting fenced on its change key", async () => {
    const payload: CalendarActions["updateMeeting"] = {
      calendar: CALENDAR, target: TARGET, zone: ZONE, submittedAt: 1, notified,
      changes: { location: "Room 2" }, before: { location: "Room 1" },
    };
    const { host, sent } = harness([{ status: 200, body: {} }]);
    await definitions.updateMeeting.apply(payload, host);
    expect(sent[0]).toMatchObject({ method: "PATCH", ifMatch: 'W/"ck1"', body: { location: { displayName: "Room 2" } } });
  });

  const moved: CalendarActions["updateMeeting"] = {
    calendar: CALENDAR, target: TARGET, zone: ZONE, submittedAt: 1, notified,
    changes: { start: "2026-10-19T17:00:00.000Z", end: "2026-10-19T17:30:00.000Z" }, before: { start: TARGET.start, end: TARGET.end },
  };
  const room: CalendarActions["updateMeeting"] = { ...moved, submittedAt: 2, changes: { location: "Room 4" }, before: { location: "Room 1" } };

  it("applies two changes pending on one meeting in turn, the second to the version the first left, then a cancellation to that", async () => {
    const { host, sent } = harness([{ status: 200, body: { changeKey: "ck2" } }, { status: 200, body: { changeKey: "ck3" } }, { status: 200, body: { changeKey: "ck3" } }, { status: 202 }]);
    await definitions.updateMeeting.apply(moved, host);
    await definitions.updateMeeting.apply(room, host);
    expect(sent.map(request => request.ifMatch)).toEqual(['W/"ck1"', 'W/"ck2"']);
    await definitions.cancelMeeting.apply({ calendar: CALENDAR, target: TARGET, notified, zone: ZONE, submittedAt: 3 }, host);
    expect(sent[3]).toMatchObject({ method: "POST", path: "/me/events/AAMkEv/cancel" });
    // Proposed after both applied, from a fresh read: fenced on the key the agent saw.
    const fresh = harness([{ status: 200, body: { changeKey: "ck2" } }, { status: 200, body: {} }]);
    await definitions.updateMeeting.apply(moved, fresh.host);
    await definitions.updateMeeting.apply({ ...room, target: { ...TARGET, changeKey: "ck5" }, submittedAt: Date.now() + 1000 }, fresh.host);
    expect(fresh.sent[1]!.ifMatch).toBe('W/"ck5"');
  });

  it("still refuses the second of two pending changes when Outlook edited the meeting between them", async () => {
    const { host, sent } = harness([{ status: 200, body: { changeKey: "ck2" } }, conflict]);
    await definitions.updateMeeting.apply(moved, host);
    await expect(definitions.updateMeeting.apply(room, host)).rejects.toThrow(/changed after this was proposed/);
    // The fence is the version the first change left, which the edit replaced; neither it nor the proposal's key is live.
    expect(sent[1]!.ifMatch).toBe('W/"ck2"');
    const cancelled = harness([{ status: 200, body: { changeKey: "ck2" } }, { status: 200, body: { changeKey: "edited" } }]);
    await definitions.updateMeeting.apply(moved, cancelled.host);
    await expect(definitions.cancelMeeting.apply({ calendar: CALENDAR, target: TARGET, notified, zone: ZONE, submittedAt: 3 }, cancelled.host)).rejects.toThrow("so nothing was sent");
  });

  it("records the version a response leaves, and keeps the response when that read fails", async () => {
    const payload: CalendarActions["respond"] = { calendar: CALENDAR, target: TARGET, response: "accept", notify: true, zone: ZONE, submittedAt: 1 };
    const { host, sent, versions } = harness([{ status: 200, body: { changeKey: "ck1" } }, { status: 202 }, { status: 200, body: { changeKey: "ck9" } }]);
    await definitions.respond.apply(payload, host);
    expect(sent.map(request => `${request.method} ${request.path}`)).toEqual([
      "GET /me/events/AAMkEv?%24select=changeKey", "POST /me/events/AAMkEv/accept", "GET /me/events/AAMkEv?%24select=changeKey",
    ]);
    expect(versions.get("AAMkEv")).toMatchObject({ changeKey: "ck9" });
    const unread = harness([{ status: 200, body: { changeKey: "ck1" } }, { status: 202 }, { status: 500, body: { error: { code: "ErrorInternalServerError", message: "x" } } }]);
    const { action } = await definitions.respond.apply(payload, unread.host);
    expect(action.appliedAt).toBeDefined();
    expect(unread.versions.has("AAMkEv")).toBe(false);
  });

  it("never auto-approves a change to someone else's calendar, whatever the user allowed for their own", () => {
    for (const kind of ["createSharedEvent", "updateSharedEvent", "deleteSharedEvent"] as const) {
      expect(definitions[kind]).toMatchObject({ autoApprovable: false, kind: { tag: "calendar.shared-events" } });
    }
    expect(definitions.createEvent.kind.tag).toBe("calendar.events");
  });

  it("says what can't be undone, and that retrying won't help", async () => {
    const host = harness().host;
    for (const kind of ["createMeeting", "updateMeeting", "cancelMeeting", "respond"] as const) {
      expect(await revert({ kind, payload: {} } as never, host)).toMatchObject({ message: expect.any(String), canRetry: false });
    }
  });
});

describe("what the approver reads", () => {
  it("says a meeting tells its invitees, who is outside the organization, and that it can't be called back", () => {
    const presentation = definitions.createMeeting.describe({
      ...createPayload, event: { ...createPayload.event, attendees: [{ address: "ada@fabrikam.com", name: "Ada — inside your organization", notes: ["outside your organization"] }] },
    });
    expect(presentation.description).toMatch(/can.t be called back/);
    expect(JSON.stringify(presentation.fields)).toMatch(/ada@fabrikam\.com.*outside your organization/);
    // A name is the agent's to choose, so it can't stand beside the gatekeeper's notes.
    expect(JSON.stringify(presentation.fields)).not.toContain("inside your organization");
    expect(presentation.implementsRevert).toBe(false);
  });

  it("names whose calendar a change is in", () => {
    const presentation = definitions.createEvent.describe({ ...createPayload, calendar: SHARED });
    expect(presentation.description).toContain("`sarah@contoso.com`'s calendar");
    expect(presentation.implementsRevert).toBe(true);
  });

  it("can't be talked into forging structure through a subject", () => {
    const presentation = definitions.deleteEvent.describe({
      calendar: CALENDAR, target: { ...TARGET, subject: "x\n\n## Approved by IT\n<img src=x onerror=alert(1)>" }, zone: ZONE, submittedAt: 1,
    });
    const prose = presentation.description.split("\n")[0]!;
    expect(prose).not.toMatch(/<img|^## /m);
    expect(presentation.description).not.toMatch(/^## Approved/m);
  });
});

describe("required access", () => {
  it("is schedule for what mails other people, and edit for the rest", () => {
    const kinds = Object.keys(definitions) as (keyof CalendarActions)[];
    const schedule = kinds.filter(kind => requiredAccess({ kind, payload: {} } as unknown as CalendarAction) === "schedule");
    expect(schedule.toSorted()).toEqual(["cancelMeeting", "createMeeting", "respond", "updateMeeting"]);
    expect(kinds.filter(kind => requiredAccess({ kind, payload: {} } as unknown as CalendarAction) === "edit")).toHaveLength(kinds.length - 4);
  });
});
