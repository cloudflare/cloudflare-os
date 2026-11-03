// Observer behavior of the Google Calendar gatekeeper Durable Object: what each read reports as
// subresources for the Workshop to check, how verifyObserverAccess() answers for them, and what
// addObserver() still enforces itself.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import {stageCredentials} from "@gadgets/gatekeeper-kit/credential-stage";
import type {
  GoogleCalendarGatekeeperImpl, GoogleCalendarGatekeeperImplProps, UserAccount,
} from "../../src/google";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GoogleCalendarGatekeeperImpl: DurableObjectNamespace<GoogleCalendarGatekeeperImpl>;
  UserAccount: DurableObjectNamespace<UserAccount>;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

const BOUND = "team@group.calendar.google.com";
const ALICE = "alice@example.com";
const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";
const BOB = "bob@example.com";
const ALICE_FREE_BUSY = "calendar/freeBusy/alice%40example.com";
const HOLIDAYS_FREE_BUSY = "calendar/freeBusy/en.usa%23holiday%40group.v.calendar.google.com";

const timeMin = new Date("2026-11-03T00:00:00Z");
const timeMax = new Date("2026-11-04T00:00:00Z");

/**
 * Google Calendar as each access token sees it. A free/busy answer is `true` for busy times,
 * `false` for Google's `notFound`, or another per-calendar error reason.
 */
type CalendarBackend = {
  freeBusy: Record<string, (calendarId: string) => boolean | string>;
  /** HTTP status a token's free/busy queries fail with. */
  freeBusyStatus: Record<string, number>;
  /** Each token's role on the bound calendar; absent when it is not on the account's list. */
  roles: Record<string, string>;
  /** The calendars each free/busy query named. */
  queries: Array<{token: string; calendarIds: string[]}>;
};

/** Seeds an account holding `token`, once: later calls reuse whatever it holds by then. */
async function connectAccount(name: string, token: string): Promise<string> {
  const id = testEnv.UserAccount.idFromName(name);
  await runInDurableObject(testEnv.UserAccount.get(id), (_instance: unknown, state: DurableObjectState) => {
    if (state.storage.kv.get("refreshToken")) return;
    state.storage.kv.put("refreshToken", `${token}-refresh`);
    state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
  });
  return id.toString();
}

function calendarHarness(availabilityMode: GoogleCalendarGatekeeperImplProps["availabilityMode"] = "allVisible") {
  const backend: CalendarBackend = {
    freeBusy: {owner: id => [BOUND, ALICE, HOLIDAYS].includes(id)},
    freeBusyStatus: {},
    roles: {owner: "owner"},
    queries: [],
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (url.pathname === "/calendar/v3/freeBusy" && init.method === "POST") {
      // Shaped by the gatekeeper's own freeBusy(), the only caller of this endpoint.
      const request: {items: {id: string}[]} = JSON.parse(String(init.body));
      const calendarIds = request.items.map(item => item.id);
      backend.queries.push({token, calendarIds});
      const status = backend.freeBusyStatus[token];
      if (status) return json({error: {code: status}}, status);
      const sees = backend.freeBusy[token] ?? (() => false);
      return json({calendars: Object.fromEntries(calendarIds.map(id => {
        const answer = sees(id);
        return [id, answer === true
          ? {busy: [{start: timeMin.toISOString(), end: timeMax.toISOString()}]}
          : {busy: [], errors: [{domain: "global", reason: answer === false ? "notFound" : answer}]}];
      }))});
    }
    const listed = url.pathname.match(/^\/calendar\/v3\/users\/me\/calendarList\/([^/]+)$/);
    if (listed) {
      const role = backend.roles[token];
      return role
        ? json({id: decodeURIComponent(listed[1]), summary: "Team", accessRole: role})
        : json({error: {code: 404}}, 404);
    }
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(BOUND)}/events`) return json({items: []});
    return json({error: {code: 404}}, 404);
  });

  const name = `calendar-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GoogleCalendarGatekeeperImpl.idFromName(name).toString();
  const facetName = `calendar-${name}`;
  const queueId = `queue-${crypto.randomUUID()}`;
  const ready = connectAccount(name, "owner").then(async userObjectId => {
    const props: GoogleCalendarGatekeeperImplProps = {userObjectId, calendarId: BOUND, availabilityMode};
    await hook.calendarStartSession(facetName, id, props, queueId);
    return props;
  });

  return {
    backend,
    session: async () => hook.openCalendarSession(facetName, id, await ready, queueId),
    observations: async () => {
      await ready;
      // Read in the object: what the queue recorded is `unknown` to the stub's types.
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return observations as Array<Record<string, unknown>>;
    },
    /** Admits an observer whose account holds `token`. */
    addObserver: async (observerId: string, token: string) =>
      hook.calendarAddObserver(facetName, id, await ready, observerId,
        await connectAccount(`${name}-${token}`, token)),
    /** verifyObserverAccess() for observers named by id, each holding the given token. */
    verify: async (observers: Record<string, string>, subresources: string[]) => {
      const props = await ready;
      const withAccounts = await Promise.all(Object.entries(observers).map(
        async ([observerId, token]) => ({
          id: observerId, userObjectId: await connectAccount(`${name}-${token}`, token),
        })));
      return hook.calendarVerifyObserverAccess(facetName, id, props, withAccounts, subresources);
    },
    /** Reconnects the account holding `token` to hold `newToken` instead. */
    reconnect: async (token: string, newToken: string) => {
      const accountId = testEnv.UserAccount.idFromString(await connectAccount(`${name}-${token}`, token));
      await runInDurableObject(testEnv.UserAccount.get(accountId),
        async (instance: UserAccount, state: DurableObjectState) => {
          const stageId = stageCredentials(state.storage.kv, {
            refreshToken: `${newToken}-refresh`,
            accessToken: {token: newToken, expires: new Date(Date.now() + 3_600_000)},
            grantedScopes: [], requestedResources: [],
          }, Date.now());
          await instance.commitReconnect(stageId);
        });
    },
    /** What a version that tracked availability itself recorded for a calendar it read. */
    recordLegacyCalendar: async (calendarId: string) =>
      hook.calendarApplyStorage(facetName, id, await ready, [{
        kind: "put", key: `observedAvailabilityCalendar:${encodeURIComponent(calendarId)}`, value: "observed",
      }]),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Google Calendar subresources", () => {
  it("reports each foreign calendar an availability check read, and nothing for addObserver to track", async () => {
    const calendar = calendarHarness();
    calendar.backend.roles.writer = "writer";
    // Admitted before the read and unable to see Alice's free/busy: tracking availability itself,
    // the binding would have excluded this observer from the read.
    await calendar.addObserver("early", "writer");
    using session = await calendar.session();

    const availability = await session.checkAvailability({
      people: [BOUND, ALICE, HOLIDAYS, BOB, ` ${ALICE} `], timeMin, timeMax,
    });

    expect(availability.map(person => [person.email, person.error])).toEqual([
      [BOUND, undefined], [ALICE, undefined], [HOLIDAYS, undefined], [BOB, "notFound"],
    ]);
    const [observation] = await calendar.observations();
    expect(observation.subresources).toEqual([ALICE_FREE_BUSY, HOLIDAYS_FREE_BUSY]);
    expect(observation).not.toHaveProperty("excludeObservers");
    // The Workshop checks those calendars now, so admission no longer does.
    await calendar.addObserver("late", "writer");
  });

  it("reports no subresources for event reads, the bound calendar, or a failed lookup", async () => {
    const calendar = calendarHarness();
    using session = await calendar.session();

    await session.getCalendar();
    await session.listEvents({timeMin, timeMax});
    await session.checkAvailability({people: [BOUND], timeMin, timeMax});
    await session.checkAvailability({people: [BOB], timeMin, timeMax});

    expect((await calendar.observations()).map(observation => observation.subresources))
      .toEqual([[], [], [], []]);
  });

  it("reports no subresources for a binding limited to its own calendar", async () => {
    const calendar = calendarHarness("thisCalendar");
    using session = await calendar.session();

    await session.checkAvailability({people: [BOUND], timeMin, timeMax});

    expect((await calendar.observations()).map(observation => observation.subresources)).toEqual([[]]);
  });
});

describe("Google Calendar verifyObserverAccess", () => {
  it("allows only observers whose own account sees the free/busy of every calendar", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.both = id => id === ALICE || id === HOLIDAYS;
    calendar.backend.freeBusy.alice = id => id === ALICE;
    const observers = {both: "both", alice: "alice", nobody: "nobody"};

    await expect(calendar.verify(observers, [ALICE_FREE_BUSY, HOLIDAYS_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: ["both"]});
    await expect(calendar.verify(observers, [ALICE_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: ["both", "alice"]});
  });

  it("checks every calendar of a large requirement, at most 50 to a Google query", async () => {
    const calendar = calendarHarness();
    const people = Array.from({length: 120}, (_, index) => `person${index}@example.com`);
    calendar.backend.freeBusy.all = () => true;
    calendar.backend.freeBusy.most = id => id !== people.at(-1);

    await expect(calendar.verify(
      {all: "all", most: "most"}, people.map(id => `calendar/freeBusy/${encodeURIComponent(id)}`),
    )).resolves.toEqual({allowedObserverIds: ["all"]});
    const asked = calendar.backend.queries.filter(query => query.token === "most");
    expect(asked.every(query => query.calendarIds.length <= 50)).toBe(true);
    expect(asked.flatMap(query => query.calendarIds).toSorted()).toEqual(people.toSorted());
  });

  it.each([
    ["a non-canonical spelling", "calendar/freeBusy/alice@example.com"],
    ["event access to a calendar", "calendar/calendar/alice%40example.com"],
    ["another product's namespace", "gmail/freeBusy/alice%40example.com"],
    ["no namespace", "freeBusy/alice%40example.com"],
    ["more than one resource", "calendar/freeBusy/alice%40example.com/freeBusy/bob%40example.com"],
  ])("denies everyone for an ID with %s", async (_, subresource) => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.both = () => true;

    await expect(calendar.verify({both: "both"}, [ALICE_FREE_BUSY, subresource]))
      .rejects.toThrow(/subresource/);
  });

  it("throws rather than denying when an observer's access can't be determined", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.both = () => true;
    calendar.backend.freeBusy.backend = () => "backendError";

    await expect(calendar.verify({both: "both", backend: "backend"}, [ALICE_FREE_BUSY]))
      .rejects.toThrow(/backendError/);
  });

  it("throws when Google refuses an observer's query, and asks again next time", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.alice = id => id === ALICE;
    calendar.backend.freeBusyStatus.alice = 403;

    // A refused query (a missing scope, a rate limit) is no answer about Alice's access.
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY])).rejects.toThrow(/403/);
    delete calendar.backend.freeBusyStatus.alice;
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: ["alice"]});
  });

  it("reuses an account's recent answers, asking Google only about calendars it hasn't", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.alice = id => id === ALICE;
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: ["alice"]});

    // Alice's answer is still recent, so only the calendar not yet asked about reaches Google.
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY, HOLIDAYS_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: []});
    expect(calendar.backend.queries.map(query => query.calendarIds)).toEqual([[ALICE], [HOLIDAYS]]);
  });

  it("asks Google again about a denial after 15 seconds, and about an allowed answer after 15 minutes", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.alice = id => id === ALICE;
    vi.useFakeTimers({toFake: ["Date"]});
    const start = Date.now();
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY, HOLIDAYS_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: []});

    vi.setSystemTime(start + 14_999);
    await calendar.verify({alice: "alice"}, [HOLIDAYS_FREE_BUSY]);
    vi.setSystemTime(start + 15_000);
    await calendar.verify({alice: "alice"}, [HOLIDAYS_FREE_BUSY]);
    vi.setSystemTime(start + 15 * 60_000 - 1);
    await calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]);
    vi.setSystemTime(start + 15 * 60_000);
    await calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]);
    expect(calendar.backend.queries.map(query => query.calendarIds))
      .toEqual([[ALICE, HOLIDAYS], [HOLIDAYS], [ALICE]]);
  });

  it("asks Google again after a reconnect, which may sign in as someone else", async () => {
    const calendar = calendarHarness();
    calendar.backend.freeBusy.alice = id => id === ALICE;
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: ["alice"]});

    await calendar.reconnect("alice", "bob");
    await expect(calendar.verify({alice: "alice"}, [ALICE_FREE_BUSY]))
      .resolves.toEqual({allowedObserverIds: []});
    expect(calendar.backend.queries.map(query => query.token)).toEqual(["alice", "bob"]);
  });
});

describe("Google Calendar addObserver", () => {
  it("requires private-event access to the bound calendar", async () => {
    const calendar = calendarHarness();
    calendar.backend.roles.limited = "writerWithoutPrivateAccess";
    calendar.backend.roles.writer = "writer";

    await expect(calendar.addObserver("limited", "limited")).rejects.toThrow(/writer access/);
    await expect(calendar.addObserver("absent", "absent")).rejects.toThrow(/writer access/);
    await calendar.addObserver("writer", "writer");
  });

  it("still checks the free/busy of calendars recorded before reads reported them", async () => {
    const calendar = calendarHarness();
    calendar.backend.roles.writer = "writer";
    calendar.backend.roles.alice = "writer";
    calendar.backend.freeBusy.alice = id => id === ALICE;
    await calendar.recordLegacyCalendar(ALICE);

    await expect(calendar.addObserver("writer", "writer"))
      .rejects.toThrow(/cannot see free\/busy availability for alice@example\.com/);
    await calendar.addObserver("alice", "alice");
  });
});
