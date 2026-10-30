import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDraft } from "../../src/calendar-types";
import { TEST_CALENDAR_ID } from "../calendar-hooks";

type GoogleEvent = {
  id: string;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
  attendees?: { email: string; self?: boolean }[];
  visibility?: string;
  eventType?: string;
  organizer?: { email: string; self?: boolean };
  etag?: string;
};

/**
 * A Google Calendar API fake holding the bound calendar's events. Each read reports the event's
 * version as its etag, and a PATCH carrying a stale If-Match fails with 412 as Google's does.
 */
class CalendarModel {
  readonly events = new Map<string, GoogleEvent>();
  readonly patches: { eventId: string; body: unknown }[] = [];
  readonly versions = new Map<string, number>();
  /** Runs after each GET, to change an event between the gatekeeper's read and its write. */
  afterRead?: (event: GoogleEvent) => void;

  /** Changes an event the way a collaborator editing it in Google would, giving it a new etag. */
  edit(id: string, change: Partial<GoogleEvent>): void {
    Object.assign(this.events.get(id)!, change);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  add(id: string, extra: Partial<GoogleEvent> = {}): void {
    this.events.set(id, {
      id,
      summary: "Focus",
      start: { dateTime: "2026-01-05T09:00:00Z" },
      end: { dateTime: "2026-01-05T10:00:00Z" },
      organizer: { email: TEST_CALENDAR_ID, self: true },
      ...extra,
    });
  }

  install(): void {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      let prefix = `/calendar/v3/calendars/${encodeURIComponent(TEST_CALENDAR_ID)}/events/`;
      if (!url.pathname.startsWith(prefix)) throw new Error(`Unexpected request: ${request.url}`);
      let eventId = decodeURIComponent(url.pathname.slice(prefix.length));
      let event = this.events.get(eventId);
      if (!event) return new Response("Not Found", { status: 404 });
      let etag = () => `"${this.versions.get(eventId) ?? 0}"`;
      if (request.method === "PATCH") {
        let ifMatch = request.headers.get("If-Match");
        if (ifMatch !== null && ifMatch !== etag()) {
          return new Response("Precondition Failed", { status: 412 });
        }
        let body = await request.json<Partial<GoogleEvent>>();
        this.patches.push({ eventId, body });
        this.edit(eventId, body);
        return Response.json({ ...event, etag: etag() });
      }
      let read = { ...event, etag: etag() };
      this.afterRead?.(event);
      return Response.json(read);
    }));
  }
}

const draft: CalendarEventDraft = {
  title: "Focus",
  start: { kind: "dateTime", dateTime: new Date("2026-01-05T09:00:00Z") },
  end: { kind: "dateTime", dateTime: new Date("2026-01-05T10:00:00Z") },
};

const OWN_EVENT = { tag: "calendar-events", label: "Add and change calendar events" };
const INVITATION = { tag: "calendar-invitations", label: "Send event invitations and updates" };

function hooks() {
  return env.CALENDAR_TEST_HOOKS.getByName("hooks");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google Calendar auto-approval", () => {
  it("reports only the kind that can be auto-approved", async () => {
    expect(await hooks().autoApprovable("kinds")).toEqual([OWN_EVENT]);
  });

  it("lets creating an event with nobody on it be auto-approved", async () => {
    let call = await hooks().createEvent("create-own", draft);
    expect(call.action).toMatchObject({ actionKind: OWN_EVENT, autoApprovable: true });
  });

  it("holds creating a public event", async () => {
    let call = await hooks().createEvent("create-public", { ...draft, visibility: "public" });
    expect(call.action).toMatchObject({ actionKind: OWN_EVENT, autoApprovable: false });
  });

  it("never auto-approves creating a meeting", async () => {
    let call = await hooks().createEvent(
      "create-meeting", { ...draft, attendees: [{ email: "guest@example.com" }] });
    expect(call.action).toMatchObject({ actionKind: INVITATION, autoApprovable: false });
  });

  it("judges an update by who is on the event in Google", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.add("meeting", {
      attendees: [{ email: TEST_CALENDAR_ID, self: true }, { email: "guest@example.com" }],
    });
    calendar.add("away", { eventType: "outOfOffice" });
    calendar.add("private", { visibility: "private" });
    calendar.install();

    expect((await hooks().updateEvent("update", "own", { title: "Deep work" })).action)
      .toMatchObject({ actionKind: OWN_EVENT, autoApprovable: true });
    expect((await hooks().updateEvent("update", "meeting", { title: "Moved" })).action)
      .toMatchObject({ actionKind: INVITATION, autoApprovable: false });
    expect((await hooks().updateEvent(
      "update", "own", { attendees: [{ email: "guest@example.com" }] })).action)
      .toMatchObject({ actionKind: INVITATION, autoApprovable: false });
    expect((await hooks().updateEvent("update", "away", { title: "Away" })).action)
      .toMatchObject({ actionKind: OWN_EVENT, autoApprovable: false });
    expect((await hooks().updateEvent("update", "private", { visibility: "default" })).action)
      .toMatchObject({ actionKind: OWN_EVENT, autoApprovable: false });
  });

  it("judges an update queued behind one that adds guests as reaching them", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.install();

    let invite = await hooks().updateEvent(
      "queued", "own", { attendees: [{ email: "guest@example.com" }] });
    expect(invite.action).toMatchObject({ autoApprovable: false });
    let move = await hooks().updateEvent("queued", "own", { title: "Moved" });
    expect(move.action).toMatchObject({ actionKind: INVITATION, autoApprovable: false });
  });

  it("refuses an auto-approvable update once the event has gained guests", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.install();

    let call = await hooks().updateEvent("recheck", "own", { title: "Deep work" });
    expect(call.action).toMatchObject({ autoApprovable: true });
    calendar.events.get("own")!.attendees = [{ email: "guest@example.com" }];

    expect(await hooks().applyAction("recheck", call.actionId!))
      .toMatch(/now has other people on it.*Nothing was changed/);
    expect(calendar.patches).toEqual([]);
  });

  it("refuses an auto-approvable update that would now widen visibility", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.install();

    let call = await hooks().updateEvent("recheck-visibility", "own", { visibility: "default" });
    expect(call.action).toMatchObject({ autoApprovable: true });
    calendar.events.get("own")!.visibility = "private";

    expect(await hooks().applyAction("recheck-visibility", call.actionId!))
      .toMatch(/widen who can see it/);
    expect(calendar.patches).toEqual([]);
  });

  it("refuses an auto-approvable update when guests are added between its read and its write", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.install();

    let call = await hooks().updateEvent("race", "own", { title: "Deep work" });
    expect(call.action).toMatchObject({ autoApprovable: true });
    calendar.afterRead = () => calendar.edit("own", { attendees: [{ email: "guest@example.com" }] });

    expect(await hooks().applyAction("race", call.actionId!))
      .toMatch(/now has other people on it.*Nothing was changed/);
    expect(calendar.patches).toEqual([]);
  });

  it("applies an auto-approvable update while the event is still the calendar's own", async () => {
    let calendar = new CalendarModel();
    calendar.add("own");
    calendar.install();

    let call = await hooks().updateEvent("apply-own", "own", { title: "Deep work" });
    expect(await hooks().applyAction("apply-own", call.actionId!)).toBeNull();
    expect(calendar.patches).toEqual([{ eventId: "own", body: { summary: "Deep work" } }]);
  });

  it("applies an update a person approved as a meeting without judging it again", async () => {
    let calendar = new CalendarModel();
    calendar.add("meeting", { attendees: [{ email: "guest@example.com" }] });
    calendar.install();

    let call = await hooks().updateEvent("apply-meeting", "meeting", { title: "Moved" });
    expect(call.action).toMatchObject({ autoApprovable: false });
    expect(await hooks().applyAction("apply-meeting", call.actionId!)).toBeNull();
    expect(calendar.patches).toEqual([{ eventId: "meeting", body: { summary: "Moved" } }]);
  });
});
