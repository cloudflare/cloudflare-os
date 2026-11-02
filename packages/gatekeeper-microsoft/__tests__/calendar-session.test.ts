// A Calendar session end to end against a fake Graph, at the `fetch` boundary, so the real Graph
// client, parsing, guard, redaction, overlay, observations and staging all run: what each binding
// shows, what it refuses, what it names to observers, and what it proposes.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import type { ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { definitions, type CalendarAction, type CalendarActions } from "../src/calendar-actions";
import type { CalendarAccessLevel, CalendarScope } from "../src/calendar-scope";
import { CalendarContext, CalendarReaderImpl, CalendarSessionImpl, type CalendarSessionHost } from "../src/calendar-session";
import type { EventInfo } from "../src/calendar-types";
import { GraphApi } from "../src/graph-api";
import { resolveCalendarUrl } from "../src/calendar-resolve";
import type { StoredIdentity } from "../src/microsoft-credentials";

/** Signed in under a name that isn't the mailbox's address: Exchange knows Phillip as phillip@contoso.com, his main calendar's owner. */
const ME: StoredIdentity = { tenantId: "t", objectId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", email: "phillip.signin@contoso.onmicrosoft.com", fetchedAt: 0 };
const DEFAULT = { id: "AAMkCalDefault0000000000", entryId: "ENTRY-DEFAULT", name: "Calendar", isDefault: true };
const TEAM = { id: "AAMkCalTeam000000000000", entryId: "ENTRY-TEAM", name: "Team", isDefault: false };
/** Sarah's calendar, added to Phillip's list: his to change, but not his own. */
const SARAHS = { id: "AAMkCalSarahs0000000000", entryId: "ENTRY-SARAHS", name: "Sarah's", isDefault: false, owner: "sarah@contoso.com" };
/** A calendar that isn't in Phillip's list at all, whose events Graph still answers by ID. */
const ELSEWHERE = { id: "AAMkCalElsewhere0000000", entryId: "ENTRY-ELSEWHERE", name: "Elsewhere", isDefault: false };
const DAY = "2026-10-19";

// findFreeTimes never offers the past, so the clock is pinned to the seeded day.
beforeAll(() => vi.useFakeTimers({ now: new Date(`${DAY}T00:00:00Z`), toFake: ["Date"] }));
afterAll(() => vi.useRealTimers());

type Seeded = { id: string; calendar: typeof DEFAULT; fields: Record<string, unknown> };

function seedEvent(id: string, calendar: typeof DEFAULT, start: string, end: string, fields: Record<string, unknown> = {}): Seeded {
  return {
    id, calendar, fields: {
      id, changeKey: `ck-${id}`, subject: id, start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" },
      isAllDay: false, showAs: "busy", sensitivity: "normal", type: "singleInstance", isOrganizer: true,
      organizer: { emailAddress: { address: "phillip@contoso.com", name: "Phillip" } }, attendees: [], responseStatus: { response: "organizer" },
      categories: [], importance: "normal", bodyPreview: "", webLink: "", ...fields,
    },
  };
}

/** The seeded mailbox: two calendars of Phillip's, with events. */
function seed(): Seeded[] {
  return [
    seedEvent("AAMkEvStandup", TEAM, `${DAY}T16:00:00`, `${DAY}T16:30:00`, { subject: "Standup **now**", location: { displayName: "Room 1" } }),
    seedEvent("AAMkEvTeamPrivate", TEAM, `${DAY}T18:00:00`, `${DAY}T19:00:00`, { subject: "Offsite planning", sensitivity: "private" }),
    seedEvent("AAMkEvDoctor", DEFAULT, `${DAY}T20:00:00`, `${DAY}T21:00:00`, { subject: "Doctor", sensitivity: "private" }),
    seedEvent("AAMkEvInvite", DEFAULT, `${DAY}T17:00:00`, `${DAY}T18:00:00`, {
      subject: "Vendor sync", isOrganizer: false, organizer: { emailAddress: { address: "ada@fabrikam.com", name: "Ada" } },
      attendees: [{ emailAddress: { address: "phillip@contoso.com" }, type: "required", status: { response: "notResponded" } }],
      responseStatus: { response: "notResponded" }, responseRequested: true, allowNewTimeProposals: true,
    }),
    seedEvent("AAMkEvMyMeeting", DEFAULT, `${DAY}T22:00:00`, `${DAY}T22:30:00`, {
      subject: "1:1", attendees: [{ emailAddress: { address: "sarah@contoso.com", name: "Sarah" }, type: "required", status: { response: "accepted" } }],
    }),
    seedEvent("AAMkEvElsewhere", ELSEWHERE, `${DAY}T12:00:00`, `${DAY}T13:00:00`),
    // A series whose master is in one calendar and an occurrence in another, the day after, outside the listing window.
    seedEvent("AAMkEvSeries", DEFAULT, "2026-10-20T16:00:00", "2026-10-20T16:30:00", { type: "seriesMaster" }),
    seedEvent("AAMkEvSeriesOcc", TEAM, "2026-10-20T16:00:00", "2026-10-20T16:30:00", { type: "occurrence", seriesMasterId: "AAMkEvSeries" }),
    // A private series with an exception that isn't, and a Teams meeting; both outside the listing window.
    seedEvent("AAMkEvPrivateSeries", TEAM, "2026-10-21T16:00:00", "2026-10-21T16:30:00", { type: "seriesMaster", sensitivity: "private" }),
    seedEvent("AAMkEvPrivateSeriesOcc", TEAM, "2026-10-21T16:00:00", "2026-10-21T16:30:00", { type: "exception", seriesMasterId: "AAMkEvPrivateSeries" }),
    // A series that isn't private with an exception that is; outside the listing window.
    seedEvent("AAMkEvTeamSeries", TEAM, "2026-10-22T16:00:00", "2026-10-22T16:30:00", { type: "seriesMaster", subject: "Weekly" }),
    seedEvent("AAMkEvTeamSeriesOcc", TEAM, "2026-10-22T16:00:00", "2026-10-22T16:30:00", { type: "exception", seriesMasterId: "AAMkEvTeamSeries", sensitivity: "private", subject: "Doctor" }),
    seedEvent("AAMkEvTeams", DEFAULT, "2026-10-21T18:00:00", "2026-10-21T18:30:00", {
      subject: "Design review", isOnlineMeeting: true, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
      attendees: [{ emailAddress: { address: "sarah@contoso.com", name: "Sarah" }, type: "required", status: { response: "accepted" } }],
    }),
  ];
}

type Call = { method: string; path: string; body?: unknown; ifMatch?: string | null };

/** Graph, faked at `fetch`. `leak` adds an event of another calendar to a calendar's listing, as a misbehaving Graph would. */
function fakeGraph(events: Seeded[], options: { leak?: { into: string; event: Seeded } } = {}) {
  const calls: Call[] = [];
  const calendars: (typeof DEFAULT & { owner?: string })[] = [DEFAULT, TEAM, SARAHS];
  const calendarRow = (calendar: typeof DEFAULT & { owner?: string }) => ({
    id: calendar.id, name: calendar.name, isDefaultCalendar: calendar.isDefault, canEdit: true, hexColor: "",
    owner: { address: calendar.owner ?? "phillip@contoso.com", name: "Phillip" }, singleValueExtendedProperties: [{ id: "Binary 0xfff", value: calendar.entryId }],
  });
  const eventRow = (event: Seeded) => ({ ...event.fields, singleValueExtendedProperties: [{ id: "Binary 0xe09", value: event.calendar.entryId }] });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = () => json(404, { error: { code: "ErrorItemNotFound", message: "Not found" } });

  const route = (method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body: unknown } => {
    if (path === "/me/mailboxSettings") {
      return { status: 200, body: { timeZone: "Pacific Standard Time", workingHours: { daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], startTime: "08:00:00.0000000", endTime: "17:00:00.0000000", timeZone: { name: "Pacific Standard Time" } } } };
    }
    if (path === "/organization") return { status: 200, body: { value: [{ verifiedDomains: [{ name: "contoso.com" }] }] } };
    if (path === "/me/calendars") return { status: 200, body: { value: calendars.map(calendarRow) } };
    if (path === "/me/calendar") return { status: 200, body: calendarRow(DEFAULT) };
    const calendar = /^\/me\/calendars\/([^/]+)(\/calendarView)?$/.exec(path);
    if (calendar) {
      const found = calendars.find(candidate => candidate.id === decodeURIComponent(calendar[1]!));
      if (!found) return { status: 404, body: {} };
      if (!calendar[2]) return { status: 200, body: calendarRow(found) };
      const start = Date.parse(query.get("startDateTime")!);
      const end = Date.parse(query.get("endDateTime")!);
      const listed = events.filter(event => event.calendar === found).concat(options.leak?.into === found.id ? [options.leak.event] : [])
        .filter(event => Date.parse(`${(event.fields.end as { dateTime: string }).dateTime}Z`) > start && Date.parse(`${(event.fields.start as { dateTime: string }).dateTime}Z`) < end);
      return { status: 200, body: { value: listed.map(event => event.fields) } };
    }
    const event = /^\/me\/events\/([^/]+)$/.exec(path);
    if (event) {
      const found = events.find(candidate => candidate.id === decodeURIComponent(event[1]!)) ?? (options.leak?.event.id === decodeURIComponent(event[1]!) ? options.leak.event : undefined);
      if (!found) return { status: 404, body: {} };
      if (method === "GET") return { status: 200, body: query.get("$select") === "body" ? { body: { contentType: "html", content: `<p>Body of ${found.id}</p><p style="display:none">hidden</p>` } } : eventRow(found) };
    }
    if (path === "/me/calendar/getSchedule") {
      const asked = (body as { schedules: string[] }).schedules;
      return {
        status: 200, body: {
          value: asked.map(address => address === "nobody@contoso.com"
            ? { scheduleId: address, error: { message: "Proxy web request failed.", responseCode: "5016" } }
            : address === "hidden@contoso.com" ? { scheduleId: address, availabilityView: "4444", scheduleItems: [] }
            : {
              scheduleId: address, availabilityView: "0220",
              scheduleItems: [{ status: "busy", subject: "SECRET SUBJECT", start: { dateTime: `${DAY}T16:00:00`, timeZone: "UTC" }, end: { dateTime: `${DAY}T17:00:00`, timeZone: "UTC" } }],
              workingHours: { daysOfWeek: ["monday"], startTime: "08:00:00.0000000", endTime: "17:00:00.0000000", timeZone: { name: "Pacific Standard Time" } },
            }),
        },
      };
    }
    if (path === "/me/people") return { status: 200, body: { value: [{ displayName: "Sarah", scoredEmailAddresses: [{ address: "sarah@contoso.com" }] }] } };
    return { status: 404, body: { error: { code: "unrouted", message: `${method} ${path}` } } };
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/v1\.0/, "");
    if (path === "/$batch") {
      const responses = (body as { requests: { id: string; method: string; url: string }[] }).requests.map(request => {
        const inner = new URL(`https://graph.microsoft.com/v1.0/${request.url}`);
        calls.push({ method: request.method, path: inner.pathname.replace(/^\/v1\.0/, "") });
        const answer = route(request.method, inner.pathname.replace(/^\/v1\.0/, ""), inner.searchParams, undefined);
        return { id: request.id, status: answer.status, body: answer.body };
      });
      return json(200, { responses });
    }
    calls.push({ method, path, body, ifMatch: new Headers(init?.headers).get("if-match") });
    const answer = route(method, path, url.searchParams, body);
    return answer.status === 404 ? notFound() : json(answer.status, answer.body);
  };
  return { api: new GraphApi("token", { fetch }), calls };
}

/** A session over a scope, recording what it observes and proposes. */
function session(scope: CalendarScope, access: CalendarAccessLevel = "read", options: Parameters<typeof fakeGraph>[1] = {}) {
  const graph = fakeGraph(seed(), options);
  const observations: ObservationDescription[] = [];
  const prepared: string[][] = [];
  const submitted: { kind: keyof CalendarActions; payload: CalendarActions[keyof CalendarActions] }[] = [];
  let sequence = 0;
  const host: CalendarSessionHost = {
    scope, access,
    owner: async () => ME,
    read: op => op(graph.api),
    cached: (_key, _ttl, load) => load(),
    pending: () => submitted.map((action, index) => ({ id: index + 1, action: action as CalendarAction })) as never,
    resolve: id => id,
    allocate: () => `~${++sequence}`,
    submit: async (_queue, kind, payload) => {
      submitted.push({ kind, payload });
      return submitted.length;
    },
  };
  const queue = {
    dup() { return queue; },
    authorizeObservation: async (description: ObservationDescription) => { observations.push(description); },
    [Symbol.dispose]() {},
  } as unknown as RpcStub<ApprovalQueue>;
  const observers: ObserverStrategy = {
    aclChecks: "per-read",
    prepare: async ids => { prepared.push([...ids]); return { commit() {} }; },
    addObserver: async () => {},
    removeObserver: async () => {},
    prepareWithheld: () => ({ commit() {} }),
  };
  const ctx = new CalendarContext(host, queue, observers);
  const reader = access === "read" ? new CalendarReaderImpl(ctx) : new CalendarSessionImpl(ctx);
  return { reader, writer: reader as CalendarSessionImpl, graph, observations, prepared, submitted };
}

const teamBinding = (details: "freeBusy" | "limited" | "full", privateEvents: "busy" | "show" = "busy", access: CalendarAccessLevel = "read"): CalendarScope => ({
  kind: "calendar", owner: { kind: "me" }, calendar: { id: TEAM.id, entryId: TEAM.entryId, name: TEAM.name }, details, privateEvents, access,
});
const defaultBinding = (details: "freeBusy" | "limited" | "full" = "full"): CalendarScope => ({
  kind: "calendar", owner: { kind: "me" }, calendar: { id: DEFAULT.id, entryId: DEFAULT.entryId, name: DEFAULT.name }, details, privateEvents: "busy", access: "read",
});
const window = { start: `${DAY}T00:00:00Z`, end: `${DAY}T23:59:00Z` };

async function all(cursor: { next(): Promise<EventInfo[] | null> }): Promise<EventInfo[]> {
  const items: EventInfo[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) items.push(...page);
  return items;
}

const teamUnit = (level: string) => `calendar:${ME.objectId}:${TEAM.id}:${level}`;

describe("a calendar binding", () => {
  it("lists only its calendar, at free/busy: times and show-as, no titles", async () => {
    const { reader, prepared, observations } = session(teamBinding("freeBusy"));
    const events = await all(await reader.listEvents(window));
    expect(events).toEqual([
      { id: "AAMkEvStandup", start: "2026-10-19T09:00:00-07:00", end: "2026-10-19T09:30:00-07:00", allDay: false, showAs: "busy" },
      { id: "AAMkEvTeamPrivate", start: "2026-10-19T11:00:00-07:00", end: "2026-10-19T12:00:00-07:00", allDay: false, showAs: "busy" },
    ]);
    expect(JSON.stringify(observations)).not.toMatch(/Standup|Offsite/);
    expect(prepared.at(-1)).toEqual([teamUnit("freeBusy")]);
  });

  it("shows titles at limited, and a private event as a busy block", async () => {
    const { reader, prepared } = session(teamBinding("limited"));
    const events = await all(await reader.listEvents(window));
    expect(events.map(event => event.subject ?? (event.private ? "(private)" : "?"))).toEqual(["Standup **now**", "(private)"]);
    expect(prepared.at(-1)).toEqual([teamUnit("limited")]);
  });

  it("names private events to observers when it shows them", async () => {
    const { reader, prepared } = session(teamBinding("full", "show"));
    const events = await all(await reader.listEvents(window));
    expect(events.map(event => event.subject)).toEqual(["Standup **now**", "Offsite planning"]);
    expect(prepared.at(-1)).toEqual([teamUnit("private")]);
  });

  it("escapes what organizers wrote in observation descriptions", async () => {
    const { reader, observations } = session(teamBinding("limited"));
    await all(await reader.listEvents(window));
    expect(observations.at(-1)!.description).toContain("Standup \\*\\*now\\*\\*");
  });

  it("refuses an event of another calendar, and a missing one, in the same words", async () => {
    const { reader, observations } = session(teamBinding("full"));
    await expect(reader.getEvent("AAMkEvDoctor")).rejects.toThrow("That event is outside what this Calendar connection covers, or doesn't exist.");
    await expect(reader.getEvent("AAMkEvNothing")).rejects.toThrow("That event is outside what this Calendar connection covers, or doesn't exist.");
    await expect(reader.getEvent("../../users/x")).rejects.toThrow("That event is outside what this Calendar connection covers");
    expect(observations).toEqual([]);
  });

  it("drops an event Graph lists from another calendar, and says so in the logs", async () => {
    const leak = { into: TEAM.id, event: seed().find(event => event.id === "AAMkEvDoctor")! };
    const { reader } = session(teamBinding("full"), "read", { leak });
    const events = await all(await reader.listEvents(window));
    expect(events.map(event => event.id)).toEqual(["AAMkEvStandup", "AAMkEvTeamPrivate"]);
  });

  it("reads an event's description as safe Markdown at full, and none below", async () => {
    const full = await session(teamBinding("full")).reader.getEvent("AAMkEvStandup");
    expect(full.body).toContain("Body of AAMkEvStandup");
    expect(full.body).not.toContain("hidden");
    const limited = await session(teamBinding("limited")).reader.getEvent("AAMkEvStandup");
    expect(limited).toMatchObject({ subject: "Standup **now**", body: "" });
    const privateOne = await session(teamBinding("full")).reader.getEvent("AAMkEvTeamPrivate");
    expect(privateOne).toMatchObject({ private: true, body: "" });
    expect(privateOne).not.toHaveProperty("subject");
  });

  it("answers availability only for its own calendar's owner, and only for the main calendar", async () => {
    await expect(session(teamBinding("freeBusy")).reader.getAvailability(["phillip@contoso.com"], window.start, window.end)).rejects.toThrow(/only show when that calendar is free/);
    await expect(session(defaultBinding("freeBusy")).reader.getAvailability(["sarah@contoso.com"], window.start, window.end)).rejects.toThrow(/only show when that calendar is free/);
    const own = await session(defaultBinding("freeBusy")).reader.getAvailability(["phillip@contoso.com"], window.start, window.end);
    expect(own).toHaveLength(1);
  });

  it("refuses to search at free/busy, rather than finding nothing", async () => {
    await expect(session(teamBinding("freeBusy")).reader.listEvents({ ...window, search: "Standup" })).rejects.toThrow(/search isn't available at free\/busy/);
    expect(await all(await session(teamBinding("limited")).reader.listEvents({ ...window, search: "standup" }))).toHaveLength(1);
  });

  it("finds free time in its own calendar", async () => {
    const { reader, prepared } = session(teamBinding("freeBusy"));
    const free = await reader.findFreeTimes({ duration: 60, start: `${DAY}T16:00:00Z`, end: `${DAY}T20:00:00Z`, workingHoursOnly: false });
    expect(free.slots).toEqual([
      { start: "2026-10-19T09:30:00-07:00", end: "2026-10-19T11:00:00-07:00" },
      { start: "2026-10-19T12:00:00-07:00", end: "2026-10-19T13:00:00-07:00" },
    ]);
    expect(prepared.at(-1)).toEqual([teamUnit("freeBusy")]);
  });
});

describe("an availability binding", () => {
  const scope: CalendarScope = { kind: "availability", access: "read" };

  it("has no events or calendars", async () => {
    const { reader } = session(scope);
    await expect(reader.listEvents(window)).rejects.toThrow(/availability only/);
    await expect(reader.getEvent("AAMkEvStandup")).rejects.toThrow(/availability only/);
    await expect(reader.listCalendars()).rejects.toThrow(/availability only/);
  });

  it("gives busy blocks without subjects, says who couldn't be read, and names only those it read", async () => {
    const { reader, prepared } = session(scope);
    const result = await reader.getAvailability(["sarah@contoso.com", "nobody@contoso.com"], window.start, window.end);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result[0]).toEqual({
      address: "sarah@contoso.com", busy: [{ start: "2026-10-19T09:00:00-07:00", end: "2026-10-19T10:00:00-07:00", showAs: "busy" }],
      workingHours: { days: ["monday"], start: "08:00", end: "17:00", timeZone: "America/Los_Angeles" },
    });
    expect(result[1]).toMatchObject({ address: "nobody@contoso.com", busy: [], error: expect.stringMatching(/Not found/) });
    expect(prepared.at(-1)).toEqual(["availability:sarah@contoso.com"]);
  });

  it("finds times everyone is free in their working hours, never in the past", async () => {
    const { reader } = session(scope);
    const free = await reader.findFreeTimes({ people: ["sarah@contoso.com"], duration: 30, start: `${DAY}T15:00:00Z`, end: `${DAY}T20:00:00Z` });
    // Both work 08:00-17:00 Los Angeles (15:00-24:00 UTC); both busy 16:00-17:00 UTC.
    expect(free.slots).toEqual([
      { start: "2026-10-19T08:00:00-07:00", end: "2026-10-19T09:00:00-07:00" },
      { start: "2026-10-19T10:00:00-07:00", end: "2026-10-19T13:00:00-07:00" },
    ]);
  });

  it("leaves out someone whose free/busy isn't shared, instead of scheduling over them, and doesn't count them as read", async () => {
    const { reader, prepared } = session(scope);
    const free = await reader.findFreeTimes({ people: ["sarah@contoso.com", "hidden@contoso.com"], duration: 30, start: `${DAY}T15:00:00Z`, end: `${DAY}T20:00:00Z` });
    expect(free.unknown).toEqual([{ address: "hidden@contoso.com", error: "Their free/busy isn't shared with you." }]);
    expect(free.slots).toHaveLength(2);
    expect(prepared.at(-1)).toEqual(["availability:phillip@contoso.com", "availability:sarah@contoso.com"]);
    const before = prepared.length;
    const checked = await reader.getAvailability(["hidden@contoso.com"], window.start, window.end);
    expect(checked[0]).toMatchObject({ busy: [], error: expect.stringMatching(/isn't shared/) });
    // Nothing of theirs was revealed, so no unit is named.
    expect(prepared).toHaveLength(before);
  });

  it("refuses more people than one request can answer, and anything that isn't an address", async () => {
    const { reader } = session(scope);
    await expect(reader.getAvailability(Array.from({ length: 21 }, (_, index) => `p${index}@contoso.com`), window.start, window.end)).rejects.toThrow(/at most 20/);
    await expect(reader.getAvailability(["not an address"], window.start, window.end)).rejects.toThrow(/people\[0\]/);
    await expect(reader.getAvailability(["a@contoso.com"], `${DAY}T00:00:00Z`, "2027-01-30T00:00:00Z")).rejects.toThrow(/at most 62 days/);
  });
});

describe("an all-calendars binding", () => {
  const scope = (access: CalendarAccessLevel = "schedule"): CalendarScope => ({ kind: "all", access });

  it("shows the user's own private events, says which calendar each is in, and names everything as the user's alone", async () => {
    const { reader, prepared } = session(scope("read"));
    const events = await all(await reader.listEvents(window));
    expect(events.map(event => [event.subject, event.calendarId])).toEqual([
      ["Standup **now**", TEAM.id], ["Vendor sync", DEFAULT.id], ["Offsite planning", TEAM.id], ["Doctor", DEFAULT.id], ["1:1", DEFAULT.id],
    ]);
    expect(prepared.at(-1)).toEqual([`calendars:${ME.objectId}`]);
  });

  it("refuses an event whose calendar isn't in the user's list, and a series whose master is in another calendar", async () => {
    const { writer } = session(scope(), "schedule");
    await expect(writer.getEvent("AAMkEvElsewhere")).rejects.toThrow(/outside what this Calendar connection covers/);
    await expect(writer.updateEvent("AAMkEvSeriesOcc", { subject: "Renamed" }, { series: true })).rejects.toThrow(/outside what this Calendar connection covers/);
    await expect(writer.deleteEvent("AAMkEvSeriesOcc", { series: true })).rejects.toThrow(/outside what this Calendar connection covers/);
  });

  it("proposes an event without attendees as one only the user sees", async () => {
    const { writer, submitted } = session(scope("edit"), "edit");
    const created = await writer.createEvent({ subject: "Focus", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: TEAM.id });
    expect(created).toMatchObject({ id: "~1", subject: "Focus", start: "2026-10-19T09:00:00-07:00", end: "2026-10-19T10:00:00-07:00", calendarId: TEAM.id, pending: "create" });
    expect(submitted[0]).toMatchObject({ kind: "createEvent", payload: { calendar: { id: TEAM.id }, event: { start: "2026-10-19T16:00:00.000Z", allDay: false } } });
    expect((submitted[0]!.payload as CalendarActions["createEvent"]).transactionId).toMatch(/^[0-9a-f-]{36}$/);
    // And reads back as made.
    const listed = await all(await writer.listEvents(window));
    expect(listed.map(event => event.id)).toContain("~1");
  });

  it("holds a whole-series change to the checks its exception passed, so a shown exception can't change a private series", async () => {
    const { writer, submitted } = session(teamBinding("full", "busy", "edit"), "edit");
    await writer.updateEvent("AAMkEvPrivateSeriesOcc", { subject: "This one only" });
    expect(submitted.map(action => action.kind)).toEqual(["updateEvent"]);
    await expect(writer.updateEvent("AAMkEvPrivateSeriesOcc", { subject: "All of them" }, { series: true })).rejects.toThrow(/private/);
    await expect(writer.deleteEvent("AAMkEvPrivateSeriesOcc", { series: true })).rejects.toThrow(/private/);
    expect(submitted).toHaveLength(1);
  });

  it("won't rewrite a Teams meeting's description, which holds its join details", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await expect(writer.updateEvent("AAMkEvTeams", { body: "Agenda: the new design." })).rejects.toThrow(/Teams meeting/);
    await writer.updateEvent("AAMkEvTeams", { subject: "Design review (moved)" });
    expect(submitted.map(action => action.kind)).toEqual(["updateMeeting"]);
  });

  it("reads back a pending change to an event's description, as it does the rest of the event", async () => {
    const { writer } = session(scope("edit"), "edit");
    await writer.updateEvent("AAMkEvStandup", { body: "New description" });
    expect(await writer.getEvent("AAMkEvStandup")).toMatchObject({ body: "New description", pending: "update" });
    // And of one not yet created, over what its creation said.
    await writer.createEvent({ subject: "Focus", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: TEAM.id, body: "First" });
    await writer.updateEvent("~1", { body: "Second" });
    expect((await writer.getEvent("~1")).body).toBe("Second");
  });

  it("tells a meeting's attendees nothing more while a change to who they are is pending, since nobody can say whom it would reach", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await writer.createEvent({ subject: "Sync", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: TEAM.id, attendees: ["sarah@contoso.com"] });
    await writer.updateEvent("~1", { attendees: ["ada@fabrikam.com"] });
    const pending = /still changing who's invited/;
    await expect(writer.updateEvent("~1", { subject: "Sync (renamed)" })).rejects.toThrow(pending);
    await expect(writer.deleteEvent("~1")).rejects.toThrow(pending);
    expect(submitted.map(action => action.kind)).toEqual(["createMeeting", "updateMeeting"]);
    // A removal of everyone, which may be rejected, still makes what follows a change to a meeting: refused the same way, never auto-approved as nobody else's.
    const removal = session(scope(), "schedule");
    await removal.writer.createEvent({ subject: "Sync", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: TEAM.id, attendees: ["sarah@contoso.com"] });
    await removal.writer.updateEvent("~1", { attendees: [] });
    await expect(removal.writer.updateEvent("~1", { subject: "Sync (renamed)" })).rejects.toThrow(pending);
    await expect(removal.writer.deleteEvent("~1")).rejects.toThrow(pending);
    expect(removal.submitted.map(action => action.kind)).toEqual(["createMeeting", "updateMeeting"]);
    // An invitation pending on an event nobody else is on yet: a change or deletion proposed behind it would reach the invitees once it is approved.
    const invited = session(scope(), "schedule");
    await invited.writer.updateEvent("AAMkEvStandup", { attendees: ["sarah@contoso.com"] });
    await expect(invited.writer.updateEvent("AAMkEvStandup", { subject: "Standup (renamed)" })).rejects.toThrow(pending);
    await expect(invited.writer.deleteEvent("AAMkEvStandup")).rejects.toThrow(pending);
    expect(invited.submitted.map(action => action.kind)).toEqual(["updateMeeting"]);
  });

  it("keeps a private exception a busy block while a series change that would unhide it is pending", async () => {
    const { reader, writer } = session(teamBinding("full", "busy", "edit"), "edit");
    const before = await reader.getEvent("AAMkEvTeamSeriesOcc");
    expect(before).toMatchObject({ private: true });
    expect(before).not.toHaveProperty("subject");
    await writer.updateEvent("AAMkEvTeamSeries", { sensitivity: "normal" }, { series: true });
    const after = await reader.getEvent("AAMkEvTeamSeriesOcc");
    expect(after).toMatchObject({ private: true });
    expect(after).not.toHaveProperty("subject");
    // The master itself was never private, so its own change reads back.
    expect(await reader.getEvent("AAMkEvTeamSeries")).toMatchObject({ subject: "Weekly", sensitivity: "normal", pending: "update" });
  });

  it("proposes an event in a calendar someone else owns as a change that is never auto-approved", async () => {
    const { writer, submitted } = session(scope("edit"), "edit");
    await writer.createEvent({ subject: "Cover for Sarah", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: SARAHS.id });
    await writer.createEvent({ subject: "Mine", start: `${DAY}T11:00`, end: `${DAY}T12:00`, calendarId: TEAM.id });
    expect(submitted.map(action => action.kind)).toEqual(["createSharedEvent", "createEvent"]);
  });

  it("needs schedule to invite anyone, and notes who is outside the organization", async () => {
    const edit = session(scope("edit"), "edit");
    await expect(edit.writer.createEvent({ subject: "Kickoff", start: `${DAY}T09:00`, end: `${DAY}T10:00`, attendees: ["sarah@contoso.com"] })).rejects.toThrow(/"schedule" access level/);
    const { writer, submitted } = session(scope(), "schedule");
    await writer.createEvent({ subject: "Kickoff", start: `${DAY}T09:00`, end: `${DAY}T10:00`, attendees: ["sarah@contoso.com", { address: "ada@fabrikam.com", optional: true }, "phillip@contoso.com"] });
    expect(submitted[0]!.kind).toBe("createMeeting");
    expect((submitted[0]!.payload as CalendarActions["createMeeting"]).event.attendees).toEqual([
      { address: "sarah@contoso.com", notes: [] },
      { address: "ada@fabrikam.com", optional: true, notes: ["outside your organization"] },
    ]);
  });

  it("records what a change shows of the event as a read, before proposing it", async () => {
    const { writer, prepared, submitted } = session(scope("edit"), "edit");
    const shown = await writer.updateEvent("AAMkEvStandup", { location: "Room 2" });
    expect(shown).toMatchObject({ subject: "Standup **now**", location: "Room 2" });
    expect(prepared).toEqual([[`calendars:${ME.objectId}`]]);
    expect(submitted).toHaveLength(1);
  });

  it("lets only the organizer change a meeting, but lets anyone recategorize their copy", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await expect(writer.updateEvent("AAMkEvInvite", { subject: "Mine now" })).rejects.toThrow(/Only the organizer/);
    await writer.updateEvent("AAMkEvInvite", { categories: ["Vendors"] });
    expect(submitted.at(-1)).toMatchObject({ kind: "updateEvent", payload: { changes: { categories: ["Vendors"] }, before: { categories: [] }, target: { changeKey: "ck-AAMkEvInvite" } } });
  });

  it("sends a change to a meeting the user organizes as an update everyone on it gets", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    const moved = await writer.updateEvent("AAMkEvMyMeeting", { start: `${DAY}T16:00` });
    // Keeps its length.
    expect(moved).toMatchObject({ start: "2026-10-19T16:00:00-07:00", end: "2026-10-19T16:30:00-07:00", pending: "update" });
    expect(submitted.at(-1)).toMatchObject({ kind: "updateMeeting", payload: { notified: [{ address: "sarah@contoso.com" }] } });
  });

  it("tells the approver who a meeting update newly invites, as they get its description too", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await writer.updateEvent("AAMkEvMyMeeting", { attendees: ["sarah@contoso.com", "ada@fabrikam.com"] });
    const { notified } = submitted.at(-1)!.payload as CalendarActions["updateMeeting"];
    expect(notified.find(invite => invite.address === "sarah@contoso.com")!.notes).toEqual([]);
    expect(notified.find(invite => invite.address === "ada@fabrikam.com")!.notes).toEqual(["outside your organization", "newly invited: gets the meeting with its description"]);
  });

  it("refuses to delete someone else's meeting, pointing to respond, and cancels the user's own", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await expect(writer.deleteEvent("AAMkEvInvite")).rejects.toThrow(/decline/);
    await writer.deleteEvent("AAMkEvMyMeeting", { message: "Sorry, moving this" });
    expect(submitted.at(-1)).toMatchObject({ kind: "cancelMeeting", payload: { message: "Sorry, moving this", notified: [{ address: "sarah@contoso.com" }] } });
    const listed = await all(await writer.listEvents(window));
    expect(listed.map(event => event.id)).not.toContain("AAMkEvMyMeeting");
  });

  it("deletes an event only the user sees, keeping what it needs to recreate it", async () => {
    const { writer, submitted } = session(scope("edit"), "edit");
    await writer.deleteEvent("AAMkEvStandup");
    expect(submitted.at(-1)).toMatchObject({ kind: "deleteEvent", payload: { snapshot: { subject: "Standup **now**", location: "Room 1" } } });
  });

  it("responds to an invitation, and to nothing else", async () => {
    const { writer, submitted } = session(scope(), "schedule");
    await expect(writer.respond("AAMkEvMyMeeting", "accept")).rejects.toThrow(/isn't an invitation/);
    await expect(writer.respond("AAMkEvInvite", "accept", { propose: { start: `${DAY}T10:00`, end: `${DAY}T11:00` } })).rejects.toThrow(/only be proposed when tentatively/);
    const answered = await writer.respond("AAMkEvInvite", "tentative", { propose: { start: `${DAY}T10:00`, end: `${DAY}T11:00` }, message: "Later?" });
    expect(answered).toMatchObject({ response: "tentativelyAccepted", showAs: "tentative", pending: "respond" });
    expect(submitted.at(-1)).toMatchObject({ kind: "respond", payload: { response: "tentative", notify: true, propose: { start: "2026-10-19T17:00:00.000Z" } } });
  });
});

describe("a calendar binding that can change events", () => {
  it("can't change a private event it shows only as busy time", async () => {
    const { writer } = session(teamBinding("full", "busy", "edit"), "edit");
    await expect(writer.updateEvent("AAMkEvTeamPrivate", { subject: "x" })).rejects.toThrow(/private/);
    await expect(writer.deleteEvent("AAMkEvTeamPrivate")).rejects.toThrow(/private/);
  });

  it("creates events only in its own calendar", async () => {
    const { writer } = session(teamBinding("full", "busy", "edit"), "edit");
    await expect(writer.createEvent({ subject: "x", start: `${DAY}T09:00`, end: `${DAY}T10:00`, calendarId: DEFAULT.id })).rejects.toThrow(/That calendar is outside what this Calendar connection covers/);
  });

  it("checks what it is asked to write", async () => {
    const { writer } = session(teamBinding("full", "busy", "edit"), "edit");
    const base = { subject: "x", start: `${DAY}T09:00`, end: `${DAY}T10:00` };
    await expect(writer.createEvent({ ...base, end: `${DAY}T08:00` })).rejects.toThrow(/end must be after start/);
    await expect(writer.createEvent({ ...base, subject: "two\nlines" })).rejects.toThrow(/line breaks/);
    await expect(writer.createEvent({ ...base, start: "tomorrow" })).rejects.toThrow(/ISO 8601/);
    await expect(writer.createEvent({ ...base, allDay: true, start: DAY, end: DAY })).rejects.toThrow(/ends on the 19th/);
    await expect(writer.createEvent({ ...base, reminder: -5 })).rejects.toThrow(/reminder/);
    await expect(writer.createEvent({ ...base, onlineMeeting: true })).rejects.toThrow(/needs someone to meet/);
  });
});

describe("what the approver sees", () => {
  it("defuses what organizers and agents wrote in the description's prose", () => {
    const presentation = definitions.respond.describe({
      calendar: { owner: { kind: "me" }, id: DEFAULT.id, name: "Calendar" },
      target: { id: "x", subject: "**Approve** [this](https://evil.example)", start: "2026-10-19T17:00:00.000Z", end: "2026-10-19T18:00:00.000Z", allDay: false, changeKey: "k", organizer: "<b>Ada</b>" },
      response: "accept", notify: true, zone: "America/Los_Angeles", submittedAt: 0,
    });
    expect(presentation.description).not.toMatch(/\*\*Approve\*\*|\]\(https|<b>/);
    expect(presentation.description).toContain("can't be called back");
  });

  it("never offers mail-sending kinds for automatic approval", () => {
    expect(definitions.createMeeting.autoApprovable).toBe(false);
    expect(definitions.updateMeeting.autoApprovable).toBe(false);
    expect(definitions.cancelMeeting.autoApprovable).toBe(false);
    expect(definitions.respond.autoApprovable).toBe(false);
    expect(definitions.createEvent.autoApprovable).toBe(true);
  });
});

describe("binding a calendar", () => {
  const calendarRow = (id: string, owner: string, isDefault = false) => ({
    id, name: id, isDefaultCalendar: isDefault, canEdit: true, owner: { address: owner },
    singleValueExtendedProperties: [{ id: "Binary 0xfff", value: `ENTRY-${id}` }],
  });
  const SARAH_ID = "bbbbbbbb-0000-0000-0000-000000000002";
  const api = new GraphApi("token", {
    fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v1\.0/, "");
      const rows: Record<string, unknown> = {
        "/me/calendar": calendarRow("AAMkCalDefault0000000000", "Phillip@Contoso.com", true),
        "/me/calendars/AAMkCalTeam000000000000": calendarRow("AAMkCalTeam000000000000", "phillip@contoso.com"),
        "/me/calendars/AAMkCalAddedFromSarah00": calendarRow("AAMkCalAddedFromSarah00", "sarah@contoso.com"),
        "/me": { id: "aaaaaaaa-0000-0000-0000-000000000001" },
        "/users/phillip.alias%40contoso.com": { id: "AAAAAAAA-0000-0000-0000-000000000001", mail: "phillip@contoso.com" },
        // Sarah signs in as sarah.signin@…, so only a lookup by `mail` finds her.
        "/users?mail eq 'sarah@contoso.com'": { value: [{ id: SARAH_ID, mail: "Sarah@Contoso.com" }] },
        [`/users/${SARAH_ID}/calendars/AAMkCalSarahsOwn000000`]: calendarRow("AAMkCalSarahsOwn000000", "sarah@contoso.com"),
      };
      const key = path === "/users" ? `${path}?${url.searchParams.get("$filter")}` : path;
      return key in rows ? Response.json(rows[key]) : Response.json({ error: { code: "ErrorItemNotFound", message: "x" } }, { status: 404 });
    },
  });

  it("takes the user's own calendar as theirs, even when their sign-in name isn't their address", async () => {
    const scope = await resolveCalendarUrl(api, "https://outlook.office.com/calendar/id/AAMkCalTeam000000000000", "schedule", "phillip.signin@contoso.onmicrosoft.com");
    expect(scope).toMatchObject({ kind: "calendar", owner: { kind: "me" }, calendar: { id: "AAMkCalTeam000000000000", entryId: "ENTRY-AAMkCalTeam000000000000" }, access: "schedule" });
  });

  it("takes a link naming another of the user's own addresses as theirs, so their calendars are checked as their own", async () => {
    await expect(resolveCalendarUrl(api, "https://outlook.office.com/calendar/phillip.alias@contoso.com/id/AAMkCalAddedFromSarah00", "schedule", "phillip@contoso.com"))
      .rejects.toThrow(/added to your list/);
    expect(await resolveCalendarUrl(api, "https://outlook.office.com/calendar/phillip.alias@contoso.com/id/AAMkCalTeam000000000000", "schedule", "phillip@contoso.com"))
      .toMatchObject({ owner: { kind: "me" } });
  });

  it("finds a calendar's owner by their primary address when it isn't their sign-in name", async () => {
    const scope = await resolveCalendarUrl(api, "https://outlook.office.com/calendar/sarah@contoso.com/id/AAMkCalSarahsOwn000000?details=limited", "schedule", "phillip@contoso.com");
    expect(scope).toMatchObject({ kind: "calendar", owner: { kind: "shared", id: SARAH_ID, address: "sarah@contoso.com" }, access: "read" });
    await expect(resolveCalendarUrl(api, "https://outlook.office.com/calendar/nobody@contoso.com/default", "read", "phillip@contoso.com")).rejects.toThrow(/nobody with the address/);
  });

  it("refuses someone else's calendar added to the user's list, whose sharing list isn't theirs to read", async () => {
    await expect(resolveCalendarUrl(api, "https://outlook.office.com/calendar/id/AAMkCalAddedFromSarah00", "schedule", "phillip@contoso.com"))
      .rejects.toThrow(/sarah@contoso\.com's calendar, added to your list/);
  });
});
