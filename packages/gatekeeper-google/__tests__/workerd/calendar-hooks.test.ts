// Google Calendar event hooks, end to end inside the gatekeeper worker: a facet restored the way the
// Overseer restores it binds the hook, TestHooks enables it and answers each firing, and Google
// Calendar is the fetch mock below, which notifies through the worker's own fetch handler.

import {env} from "cloudflare:workers";
import {SELF, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {CALENDAR_WRITE_MARK} from "../../src/calendar-api";
import type {CalendarEvent, CalendarSubscribeOptions} from "../../src/calendar-types";
import type {GoogleCalendarGatekeeperImplProps} from "../../src/google";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  CalendarHookDriver: DurableObjectNamespace;
  GoogleCalendarGatekeeperImpl: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
  UserAccount: DurableObjectNamespace;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOTIFICATIONS = "https://gadgets.example.com/gatekeeper/google/calendar/notifications/";

// Each test watches a fresh calendar, so that no other test's hooks share its drivers.
let CALENDAR: string;

beforeEach(() => {
  CALENDAR = `${crypto.randomUUID()}@group.calendar.google.com`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type MockEvent = {
  id: string; etag: string; seq: number; status: "confirmed" | "cancelled"; summary: string;
  description?: string; start: {dateTime: string}; end: {dateTime: string};
  eventType: string; recurringEventId?: string; recurrence?: string[];
  extendedProperties?: {private?: Record<string, string>};
};

/** A channel Google opened. */
type MockChannel = {id: string; token: string; address: string; resourceId: string};

/**
 * Holds a Calendar response until released. Both sides poll, because a promise settled across
 * Durable Objects moves its waiter's I/O to the settler.
 */
type Gate = {started: boolean; released: boolean};

async function pass(gate: Gate | undefined): Promise<void> {
  if (!gate || gate.released) return;
  gate.started = true;
  await vi.waitFor(() => expect(gate.released).toBe(true), {timeout: 10_000, interval: 5});
}

/** Google Calendar, for the one calendar every connection reads. */
type MockCalendar = {
  events: Map<string, MockEvent>;
  /** Bumped by every change, which a sync token names the count of. */
  seq: number;
  channels: MockChannel[];
  /** IDs of the channels stopped. */
  stopped: string[];
  /** Statuses the next events.watch calls fail with. */
  watchFailures: number[];
  /** Make the next read of changes answer 410, as Google does once it expires a sync token. */
  tokenExpired: boolean;
  /** Make every read of the calendar answer 404, as for one the account can no longer read. */
  gone: boolean;
  /** Holds the next events.list response, already decided, until released. */
  holdList?: Gate;
  /** Holds the next events.watch response, its channel already open, until released. */
  holdWatch?: Gate;
  /** Every Calendar API request, as `METHOD /path` below the calendar. */
  requests: string[];
};

/** An event as `events.list` reports it to the gatekeeper's field mask. */
function listItem(event: MockEvent) {
  return {
    id: event.id, etag: event.etag, status: event.status,
    ...(event.recurringEventId ? {recurringEventId: event.recurringEventId} : {}),
    // Google reports a deleted event with little more than its ID.
    ...(event.status !== "cancelled" && event.extendedProperties ? {extendedProperties: event.extendedProperties} : {}),
  };
}

function mockCalendar(): MockCalendar {
  const calendar: MockCalendar = {
    events: new Map(), seq: 0, channels: [], stopped: [], watchFailures: [], tokenExpired: false, gone: false,
    requests: [],
  };
  const take = (hold: "holdList" | "holdWatch") => {
    const gate = calendar[hold];
    calendar[hold] = undefined;
    return pass(gate);
  };
  const base = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}`;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.href === "https://oauth2.googleapis.com/revoke" && method === "POST") return new Response(null);
    if (url.hostname !== "www.googleapis.com") throw new Error(`Unexpected request: ${method} ${url}`);
    if (url.pathname === "/calendar/v3/channels/stop" && method === "POST") {
      calendar.requests.push("POST /channels/stop");
      calendar.stopped.push((JSON.parse(init.body as string) as {id: string}).id);
      return new Response(null, {status: 204});
    }
    if (!url.pathname.startsWith(base)) throw new Error(`Unexpected request: ${method} ${url}`);
    const path = url.pathname.slice(base.length);
    calendar.requests.push(`${method} ${path}`);
    if (path === "/events/watch" && method === "POST") {
      const status = calendar.watchFailures.shift();
      if (status !== undefined) return json({error: {code: status}}, status);
      const {id, token, address, type} = JSON.parse(init.body as string) as MockChannel & {type: string};
      expect(type).toBe("web_hook");
      const channel = {id, token, address, resourceId: `resource-${calendar.channels.length}`};
      calendar.channels.push(channel);
      const expiration = String(Date.now() + 7 * DAY);
      // The channel is open from here, whether or not Google has answered yet.
      await take("holdWatch");
      return json({kind: "api#channel", id, resourceId: channel.resourceId, expiration});
    }
    if (path === "/events" && method === "GET" && url.searchParams.get("singleEvents") === "true") {
      // listEvents(), which this fake answers with every event the calendar has.
      return json({items: [...calendar.events.values()].filter(event => event.status !== "cancelled")});
    }
    if (path === "/events" && method === "GET") {
      const syncToken = url.searchParams.get("syncToken");
      expect(url.searchParams.get("singleEvents")).toBe("false");
      if (calendar.gone) return json({error: {code: 404, errors: [{reason: "notFound"}]}}, 404);
      if (syncToken !== null && calendar.tokenExpired) {
        calendar.tokenExpired = false;
        return json({error: {code: 410, errors: [{reason: "fullSyncRequired"}]}}, 410);
      }
      const since = syncToken === null ? undefined : Number(syncToken.slice("tok-".length));
      const rows = [...calendar.events.values()]
        .filter(event => since === undefined ? event.status !== "cancelled" : event.seq > since)
        .toSorted((a, b) => a.seq - b.seq);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const pageSize = Number(url.searchParams.get("maxResults"));
      // Decided before any hold, as Google decides a page when it answers.
      const page = {
        items: rows.slice(offset, offset + pageSize).map(listItem),
        ...(offset + pageSize < rows.length
          ? {nextPageToken: String(offset + pageSize)}
          : {nextSyncToken: `tok-${calendar.seq}`}),
      };
      await take("holdList");
      return json(page);
    }
    if (path === "/events" && method === "POST") {
      const body = JSON.parse(init.body as string) as Partial<MockEvent>;
      const event = store(calendar, {
        id: `made${calendar.seq + 1}`, status: "confirmed", summary: body.summary ?? "", start: body.start!,
        end: body.end!, eventType: "default", extendedProperties: body.extendedProperties,
      });
      return json(event);
    }
    const eventId = /^\/events\/([^/]+)$/.exec(path)?.[1];
    if (eventId !== undefined) {
      const event = calendar.events.get(decodeURIComponent(eventId));
      if (!event) return json({error: {code: 404}}, 404);
      if (method === "GET") return json(event);
      if (method === "PATCH") {
        const {extendedProperties, ...patch} = JSON.parse(init.body as string) as Partial<MockEvent>;
        return json(store(calendar, {
          ...event, ...patch,
          extendedProperties: {private: {...event.extendedProperties?.private, ...extendedProperties?.private}},
        }));
      }
      if (method === "DELETE") {
        store(calendar, {...event, status: "cancelled"});
        return new Response(null, {status: 204});
      }
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return calendar;
}

/** Store a new version of an event, as any change to it does. */
function store(calendar: MockCalendar, event: Omit<MockEvent, "etag" | "seq">): MockEvent {
  calendar.seq++;
  const stored = {...event, seq: calendar.seq, etag: `"${calendar.seq}"`};
  calendar.events.set(event.id, stored);
  return stored;
}

let nextEvent = 0;

/** Someone adds an event to the calendar, or an invitation to one arrives. */
function add(calendar: MockCalendar, fields: Partial<MockEvent> = {}): string {
  const n = ++nextEvent;
  const start = Date.now() + DAY + n * HOUR;
  return store(calendar, {
    id: `ev${n}`, status: "confirmed", summary: `Meeting ${n}`, description: `Agenda ${n}`,
    start: {dateTime: new Date(start).toISOString()}, end: {dateTime: new Date(start + HOUR).toISOString()},
    eventType: "default", ...fields,
  }).id;
}

/** Someone edits an event in Google Calendar, which keeps its private properties. */
function edit(calendar: MockCalendar, id: string, fields: Partial<MockEvent> = {}): void {
  const event = calendar.events.get(id)!;
  store(calendar, {...event, summary: `${event.summary} (moved)`, ...fields});
}

function cancel(calendar: MockCalendar, id: string): void {
  store(calendar, {...calendar.events.get(id)!, status: "cancelled"});
}

/** A connected Google account, with a token valid long enough that faked clocks never refresh it. */
async function account(): Promise<string> {
  const userObject = testEnv.UserAccount.get(testEnv.UserAccount.newUniqueId());
  await runInDurableObject(userObject, (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
    state.storage.kv.put("accessToken", {token: `access-token-${crypto.randomUUID()}`, expires: new Date(Date.now() + 60 * DAY)});
  });
  return userObject.id.toString();
}

type Connection = ReturnType<typeof calendarConnection>;

/** One connection to the calendar with the account, and the TestHooks object standing in for its Overseer. */
function calendarConnection(userObjectId: string) {
  const name = `calendar-hooks-${crypto.randomUUID()}`;
  const props: GoogleCalendarGatekeeperImplProps = {userObjectId, calendarId: CALENDAR, availabilityMode: "thisCalendar"};
  const hooks = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  return {hooks, facetName: `calendar-${name}`, id: testEnv.GoogleCalendarGatekeeperImpl.idFromName(name).toString(), props};
}

/** A connection whose hook is subscribed through the restored facet. */
async function connect(userObjectId: string, options?: CalendarSubscribeOptions): Promise<Connection> {
  const connection = calendarConnection(userObjectId);
  await connection.hooks.calendarSubscribe(facetOf(connection), options);
  return connection;
}

/** Enable a connection's hook and wait for its driver to finish what that started. */
async function enable(connection: Connection): Promise<void> {
  await connection.hooks.chatEnableHook();
  await settled(connection);
}

const driver = (connection: Connection) =>
  testEnv.CalendarHookDriver.get(testEnv.CalendarHookDriver.idFromName(`${connection.props.userObjectId}:${CALENDAR}`));

const driverStorage = <T>(connection: Connection, key: string) => runInDurableObject(driver(connection),
  (_instance: unknown, state: DurableObjectState) => state.storage.kv.get<T>(key));

/**
 * Wait until the driver has no read or delivery due: its own alarm runs them, and forcing that
 * alarm here as well would run it twice concurrently.
 */
const settled = (connection: Connection) => vi.waitFor(() => runInDurableObject(driver(connection),
  (_instance: unknown, state: DurableObjectState) => {
    const now = Date.now();
    const due = [...state.storage.kv.list<{at?: number}>({prefix: "msg:"})].filter(([, row]) => row.at! <= now);
    const syncAt = state.storage.kv.get<number>("syncAt");
    if (due.length > 0 || (syncAt !== undefined && syncAt <= now)) throw new Error("The driver is still busy.");
  }), {timeout: 5_000});

/** Run the driver's alarm on a clock `ms` ahead, which the runtime won't wake it for. */
async function later(connection: Connection, ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await runDurableObjectAlarm(driver(connection));
}

/** Post a notification as Google does for `channel`, by default the newest one. */
async function notify(calendar: MockCalendar, {
  state = "exists", channel = calendar.channels.at(-1)!, token = channel.token, address = channel.address,
}: {state?: string; channel?: MockChannel; token?: string; address?: string} = {}): Promise<number> {
  const response = await SELF.fetch(address, {
    method: "POST",
    headers: {
      "X-Goog-Channel-ID": channel.id, "X-Goog-Channel-Token": token, "X-Goog-Resource-ID": channel.resourceId,
      "X-Goog-Resource-State": state, "X-Goog-Message-Number": "2",
    },
  });
  return response.status;
}

/** Notify of a change and wait for the driver to deliver it. */
async function notifyAndSettle(calendar: MockCalendar, connection: Connection): Promise<void> {
  expect(await notify(calendar)).toBe(204);
  await vi.waitFor(async () => expect((await driverStorage<number>(connection, "syncAt"))! > Date.now()).toBe(true));
  await settled(connection);
}

/** Changes as `[kind, event ID]`, in an order that doesn't depend on which delivery finished first. */
const sorted = (changes: string[][]) => changes.toSorted(([a, b], [c, d]) => `${b} ${a}`.localeCompare(`${d} ${c}`));

const received = async (connection: Connection) =>
  sorted((await connection.hooks.readCalendarHook()).received.map(({change, event}) => [change, event.id]));

/** The facet a connection's hook runs through, as TestHooks takes it. */
const facetOf = ({facetName, id, props}: Connection) => ({facetName, id, props});

/** The hooks the driver holds, and those with a delivery still to (re)try. */
const driverHooks = (connection: Connection) => runInDurableObject(driver(connection),
  (_instance: unknown, state: DurableObjectState) => ({
    registered: [...state.storage.kv.list({prefix: "reg:"})].length,
    pending: [...state.storage.kv.list<{at?: number}>({prefix: "msg:"})].filter(([, row]) => row.at !== undefined).length,
  }));

/** Disconnect the account, as the Workshop does through `GatekeeperUser.revoke()`. */
const disconnect = (userObjectId: string) =>
  (testEnv.UserAccount.get(testEnv.UserAccount.idFromString(userObjectId)) as unknown as
    {revoke(): Promise<void>}).revoke();

it("delivers a new event as created, an edit as updated and a deletion as cancelled, each once", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);

  const id = add(calendar);
  await notifyAndSettle(calendar, ada);
  // Google may notify twice, and a later read may cover what one already read.
  await notifyAndSettle(calendar, ada);
  edit(calendar, id);
  await notifyAndSettle(calendar, ada);
  cancel(calendar, id);
  await notifyAndSettle(calendar, ada);

  const hook = await ada.hooks.readCalendarHook();
  expect(hook.received.map(({change, event}) => [change, event.id, event.status])).toEqual([
    ["created", id, "confirmed"], ["updated", id, "confirmed"], ["cancelled", id, "cancelled"],
  ]);
  expect(hook.received[1].event).toMatchObject({title: "Meeting " + id.slice(2) + " (moved)", eventType: "default"});
  expect(hook.received[1].event.start).toMatchObject({kind: "dateTime", dateTime: expect.any(Date)});
  expect(hook.observations).toContainEqual(expect.objectContaining({
    title: `Google Calendar event created: Meeting ${id.slice(2)}`,
  }));
});

it("tells an edit of what was there before the hook was enabled from a new event, and delivers neither earlier", async () => {
  const calendar = mockCalendar();
  const before = add(calendar);
  const ada = await connect(await account());
  await enable(ada);

  edit(calendar, before);
  const after = add(calendar);
  await notifyAndSettle(calendar, ada);

  expect(await received(ada)).toEqual(sorted([["updated", before], ["created", after]]));
});

it("offers a hook enabled while a read is in flight only what later reads find", async () => {
  const calendar = mockCalendar();
  const userObjectId = await account();
  const ada = await connect(userObjectId);
  await enable(ada);
  const bob = await connect(userObjectId);

  // A notification starts a read, which Google holds once it has decided on this change.
  const read = add(calendar);
  const held: Gate = calendar.holdList = {started: false, released: false};
  expect(await notify(calendar)).toBe(204);
  await vi.waitFor(() => expect(held.started).toBe(true));
  // Bob's enable notes its account, then at once joins that read rather than starting another.
  // Ada's note is cleared first, so that Bob's can be seen to land.
  await runInDurableObject(driver(ada), (_instance: unknown, state: DurableObjectState) =>
    state.storage.kv.delete(`tracked:${userObjectId}`));
  const enabling = bob.hooks.chatEnableHook();
  await vi.waitFor(async () => expect(await driverStorage(ada, `tracked:${userObjectId}`)).toBeDefined());
  const after = add(calendar);

  held.released = true;
  await enabling;
  await settled(ada);
  await notifyAndSettle(calendar, ada);

  expect(await received(ada)).toEqual(sorted([["created", read], ["created", after]]));
  expect(await received(bob)).toEqual([["created", after]]);
});

it("never delivers what the gatekeeper writes, for the hook that queued it or any other, but delivers edits after it", async () => {
  const calendar = mockCalendar();
  const userObjectId = await account();
  const ada = await connect(userObjectId);
  const other = await connect(userObjectId);
  await enable(ada);
  await enable(other);
  await ada.hooks.setCalendarHookBehavior({update: {title: "Prepared"}, create: {
    title: "Prep", start: {kind: "dateTime", dateTime: new Date(Date.now() + DAY)},
    end: {kind: "dateTime", dateTime: new Date(Date.now() + DAY + 30 * MINUTE)},
  }});

  const id = add(calendar);
  await notifyAndSettle(calendar, ada);
  const {submissions} = await ada.hooks.readCalendarHook();
  expect(submissions).toHaveLength(2);
  await ada.hooks.setCalendarHookBehavior({update: undefined, create: undefined});

  // Approving them updates the event and creates another, each carrying a fresh write mark.
  for (const {actionId} of submissions) await ada.hooks.calendarApplyAction(facetOf(ada), actionId);
  expect(calendar.events.get(id)!.summary).toBe("Prepared");
  expect(calendar.events.get(id)!.extendedProperties?.private?.[CALENDAR_WRITE_MARK]).toEqual(expect.any(String));
  expect([...calendar.events.values()].map(event => event.summary)).toContain("Prep");
  await notifyAndSettle(calendar, ada);
  expect(await received(ada)).toEqual([["created", id]]);
  expect(await received(other)).toEqual([["created", id]]);

  // Someone then moves the event in Google Calendar, which keeps the mark as it was.
  edit(calendar, id);
  await notifyAndSettle(calendar, ada);
  expect(await received(ada)).toEqual(sorted([["created", id], ["updated", id]]));
  expect(await received(other)).toEqual(sorted([["created", id], ["updated", id]]));
});

it("delivers the deletion that undoing a created event makes, as nothing marks it", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);
  await ada.hooks.setCalendarHookBehavior({create: {
    title: "Prep", start: {kind: "dateTime", dateTime: new Date(Date.now() + DAY)},
    end: {kind: "dateTime", dateTime: new Date(Date.now() + DAY + 30 * MINUTE)},
  }});
  const id = add(calendar);
  await notifyAndSettle(calendar, ada);
  await ada.hooks.setCalendarHookBehavior({create: undefined});
  const [{actionId}] = (await ada.hooks.readCalendarHook()).submissions;
  await ada.hooks.calendarApplyAction(facetOf(ada), actionId);
  await notifyAndSettle(calendar, ada);
  const created = [...calendar.events.values()].find(event => event.summary === "Prep")!.id;

  await ada.hooks.calendarRevertAction(facetOf(ada), actionId);
  await notifyAndSettle(calendar, ada);

  expect(await received(ada)).toEqual(sorted([["created", id], ["cancelled", created]]));
});

it("delivers an occurrence's change as an update and its cancellation, and only its series' to a hook on the series", async () => {
  const calendar = mockCalendar();
  const series = add(calendar, {recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"]});
  const userObjectId = await account();
  const all = await connect(userObjectId);
  const watched = await connect(userObjectId, {eventId: series});
  await enable(all);
  await enable(watched);

  // Google lists an occurrence once it differs from its series, under an ID of its own.
  const moved = add(calendar, {id: `${series}_20261110T170000Z`, recurringEventId: series});
  const dropped = add(calendar, {id: `${series}_20261117T170000Z`, recurringEventId: series, status: "cancelled"});
  const unrelated = add(calendar);
  edit(calendar, series);
  await notifyAndSettle(calendar, all);

  expect(await received(all)).toEqual(sorted([
    ["updated", moved], ["cancelled", dropped], ["created", unrelated], ["updated", series],
  ]));
  expect(await received(watched)).toEqual(sorted([["updated", moved], ["cancelled", dropped], ["updated", series]]));
  const delivered = (await all.hooks.readCalendarHook()).received;
  expect(delivered.find(({event}) => event.id === moved)!.event.recurringEventId).toBe(series);
  expect(delivered.find(({event}) => event.id === series)!.event.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
});

it("delivers only the kinds of change a hook asks for", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account(), {changes: ["created"]});
  await enable(ada);

  const id = add(calendar);
  edit(calendar, id);
  await notifyAndSettle(calendar, ada);
  const second = add(calendar);
  cancel(calendar, id);
  await notifyAndSettle(calendar, ada);

  expect(await received(ada)).toEqual(sorted([["created", id], ["created", second]]));
});

it("refuses options it can't honour", async () => {
  mockCalendar();
  const userObjectId = await account();
  await expect(connect(userObjectId, {changes: []})).rejects.toThrow("options.changes must name at least one kind of change.");
  // The session's generated validation refuses what its types don't allow.
  await expect(connect(userObjectId, {changes: ["moved" as never]})).rejects.toThrow("subscribeEventChanges[1]");
  await expect(connect(userObjectId, {eventId: 7 as never})).rejects.toThrow("subscribeEventChanges[1]");
});

it("refuses a session argument of the wrong type when called, and lists events' kinds, queued ones included", async () => {
  const calendar = mockCalendar();
  const away = add(calendar, {eventType: "outOfOffice"});
  const novel = add(calendar, {eventType: "someKindGoogleAddsLater"});
  const connection = calendarConnection(await account());
  const start = new Date(Date.now() + DAY);
  const prep = {
    title: "Prep", start: {kind: "dateTime", dateTime: start},
    end: {kind: "dateTime", dateTime: new Date(start.getTime() + 30 * MINUTE)},
  };

  // A string where a Date belongs used to be queued, failing only once the creation was approved.
  const misdated = {...prep, start: {kind: "dateTime", dateTime: start.toISOString()}};
  await expect(connection.hooks.calendarSessionCall(facetOf(connection), "createEvent", [misdated]))
    .rejects.toThrow("createEvent[0]");
  await connection.hooks.calendarSessionCall(facetOf(connection), "createEvent", [prep]);

  const events = await connection.hooks.calendarSessionCall(facetOf(connection), "listEvents",
    [{timeMin: new Date(), timeMax: new Date(Date.now() + 30 * DAY)}]) as CalendarEvent[];
  expect(events.map(({title, eventType, pending}) => ({title, eventType, pending}))).toEqual([
    {title: "Prep", eventType: "default", pending: true},
    {title: calendar.events.get(away)!.summary, eventType: "outOfOffice"},
    {title: calendar.events.get(novel)!.summary},
  ]);
});

it("delivers descriptions only to a hook that asks for them", async () => {
  const calendar = mockCalendar();
  const userObjectId = await account();
  const plain = await connect(userObjectId);
  const described = await connect(userObjectId, {includeDescriptions: true});
  await enable(plain);
  await enable(described);

  add(calendar);
  await notifyAndSettle(calendar, plain);

  expect((await plain.hooks.readCalendarHook()).received[0].event.description).toBeUndefined();
  expect((await described.hooks.readCalendarHook()).received[0].event.description).toMatch(/^Agenda /);
});

it("opens one channel per account and calendar, at the driver's address, and replaces it before it expires", async () => {
  const calendar = mockCalendar();
  const userObjectId = await account();
  const ada = await connect(userObjectId);
  await enable(ada);
  await enable(await connect(userObjectId));

  expect(calendar.channels).toHaveLength(1);
  expect(calendar.channels[0].address).toBe(`${NOTIFICATIONS}${driver(ada).id.toString()}`);

  await later(ada, 6 * DAY + MINUTE);
  expect(calendar.channels).toHaveLength(2);
  expect(calendar.stopped).toEqual([calendar.channels[0].id]);
  // The replaced channel's notifications no longer count.
  calendar.requests.length = 0;
  expect(await notify(calendar, {channel: calendar.channels[0]})).toBe(204);
  expect(calendar.requests).toEqual([]);
});

it("reads every two minutes until a notification arrives on its channel, and hourly after", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);

  const unnotified = add(calendar);
  await later(ada, 2 * MINUTE + 1);
  expect(await received(ada)).toEqual([["created", unnotified]]);

  // Google's first notification on a channel shows that they arrive.
  expect(await notify(calendar, {state: "sync"})).toBe(204);
  await later(ada, 2 * MINUTE + 1);
  expect(await driverStorage<number>(ada, "syncAt")).toBeGreaterThan(Date.now() + 50 * MINUTE);
});

it("counts Google's first notification on a channel when it comes before Google answers the watch", async () => {
  const calendar = mockCalendar();
  const held: Gate = calendar.holdWatch = {started: false, released: false};
  const ada = await connect(await account());
  const enabling = ada.hooks.chatEnableHook();
  await vi.waitFor(() => expect(held.started).toBe(true));

  expect(await notify(calendar, {state: "sync"})).toBe(204);
  held.released = true;
  await enabling;

  expect(await driverStorage(ada, "channel")).toMatchObject({id: calendar.channels[0].id, confirmed: true});
  await later(ada, 2 * MINUTE + 1);
  expect(await driverStorage<number>(ada, "syncAt")).toBeGreaterThan(Date.now() + 50 * MINUTE);
});

it("asks again for a channel Google refuses after an hour, then two, reading every two minutes meanwhile", async () => {
  const calendar = mockCalendar();
  calendar.watchFailures = [400, 400];
  const ada = await connect(await account());
  await enable(ada);
  const watches = () => calendar.requests.filter(request => request === "POST /events/watch").length;
  expect(watches()).toBe(1);

  const id = add(calendar);
  await later(ada, 2 * MINUTE + 1);
  expect(await received(ada)).toEqual([["created", id]]);

  await later(ada, HOUR);
  expect(watches()).toBe(2);
  await later(ada, HOUR);
  expect(watches()).toBe(2);
  await later(ada, HOUR);
  expect(watches()).toBe(3);
  expect(calendar.channels).toHaveLength(1);
  expect(await driverStorage(ada, "channelFailures")).toBeUndefined();
});

it("acts on no notification without its channel's token, and refuses addresses that name no driver", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);
  add(calendar);

  calendar.requests.length = 0;
  expect(await notify(calendar, {token: "forged"})).toBe(204);
  expect(await notify(calendar, {channel: {...calendar.channels[0], id: crypto.randomUUID()}})).toBe(204);
  await settled(ada);
  expect(calendar.requests).toEqual([]);
  expect(await received(ada)).toEqual([]);

  expect(await notify(calendar, {address: `${NOTIFICATIONS}${"0".repeat(64)}`})).toBe(404);
  expect(await notify(calendar, {address: `${NOTIFICATIONS}nonsense`})).toBe(404);
});

it("lists the calendar again once Google expires its sync token, delivering what changes after", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);
  const before = add(calendar);

  calendar.tokenExpired = true;
  await notifyAndSettle(calendar, ada);
  expect(await received(ada)).toEqual([]);

  // Listed again, the event that arrived in the gap is known, so its edit is an update.
  edit(calendar, before);
  const after = add(calendar);
  await notifyAndSettle(calendar, ada);
  expect(await received(ada)).toEqual(sorted([["updated", before], ["created", after]]));
});

it("backs off reading a calendar it can no longer read to hourly, and reads it again once it can", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);

  calendar.gone = true;
  const retries: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    await later(ada, (await driverStorage<number>(ada, "syncAt"))! - Date.now());
    retries.push(Math.round(((await driverStorage<number>(ada, "syncAt"))! - Date.now()) / MINUTE));
  }
  expect(retries).toEqual([5, 10, 20, 40, 60, 60]);

  calendar.gone = false;
  const id = add(calendar);
  await later(ada, HOUR);
  expect(await received(ada)).toEqual([["created", id]]);
  expect(await driverStorage(ada, "syncFailures")).toBeUndefined();
});

it("retries a failing hook, and disabling it ends the retries", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);
  await ada.hooks.setCalendarHookBehavior({failures: 1});

  const retried = add(calendar);
  await notifyAndSettle(calendar, ada);
  expect(await received(ada)).toEqual([]);
  await later(ada, MINUTE);
  expect(await received(ada)).toEqual([["created", retried]]);

  await ada.hooks.setCalendarHookBehavior({failures: 1});
  add(calendar);
  vi.useRealTimers();
  await notifyAndSettle(calendar, ada);
  await ada.hooks.chatDisableHook();
  await later(ada, MINUTE);
  expect(await ada.hooks.readCalendarHook()).toMatchObject({failures: 0, received: [{event: {id: retried}}]});
});

it("stops the calendar's channel and forgets it once its last hook is disabled", async () => {
  const calendar = mockCalendar();
  const ada = await connect(await account());
  await enable(ada);

  await ada.hooks.chatDisableHook();
  expect(calendar.stopped).toEqual([calendar.channels[0].id]);
  expect(await driverStorage(ada, "sync")).toBeUndefined();
  expect(await runInDurableObject(driver(ada), (_instance: unknown, state: DurableObjectState) =>
    [...state.storage.kv.list({prefix: "known:"})].length)).toBe(0);
});

it("drops a disconnected account's hooks, reading nothing more for them", async () => {
  const calendar = mockCalendar();
  const userObjectId = await account();
  const ada = await connect(userObjectId);
  await enable(ada);

  await disconnect(userObjectId);
  expect(await driverHooks(ada)).toEqual({registered: 0, pending: 0});
  calendar.requests.length = 0;
  add(calendar);
  expect(await notify(calendar)).toBe(204);
  await later(ada, HOUR);
  expect(calendar.requests).toEqual([]);
  expect(await received(ada)).toEqual([]);
});

it("drops at its daily check the hooks of an account whose disconnect couldn't reach it", async () => {
  mockCalendar();
  const userObjectId = await account();
  const ada = await connect(userObjectId);
  await enable(ada);
  // As when the disconnect can't reach the driver (see the test worker's), which it only logs.
  await runInDurableObject(driver(ada), (_instance: unknown, state: DurableObjectState) => state.storage.kv.put("test:unreachable", true));
  await disconnect(userObjectId);
  await runInDurableObject(driver(ada), (_instance: unknown, state: DurableObjectState) => state.storage.kv.delete("test:unreachable"));
  expect(await driverHooks(ada)).toEqual({registered: 1, pending: 0});

  await later(ada, DAY);
  expect(await driverHooks(ada)).toEqual({registered: 0, pending: 0});
});
