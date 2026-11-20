// The requests this gatekeeper makes to PagerDuty and the name each is counted under, and what
// the gatekeeper decides about a call that the client cannot know: an error inside a success, which
// requests are sent again, and the errors a caller is given.

import { env } from "cloudflare:workers";
import { SignJWT, importJWK } from "jose";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagerDutyApi, PagerDutyApiError } from "../src/pagerduty-api";
import { verifyIdToken } from "../src/pagerduty-credentials";
import { ID_TOKEN_ISSUER, ID_TOKEN_JWKS_URL, type Region } from "../src/pagerduty-env";
import { PAGERDUTY_OPERATIONS, PAGERDUTY_ROUTES, pagerdutyUpstream } from "../src/pagerduty-upstream";
import SIGNING_JWK from "./workerd/id-token-key.json";

const ROOTS = { us: "https://api.pagerduty.com", eu: "https://api.eu.pagerduty.com" } satisfies Record<Region, string>;

type Row = [method: string, url: string, name: string];

/** Every kind of request the gatekeeper makes under a region's REST root, with the name it is counted under. */
const requestsUnder = (root: string): Row[] => [
  ["GET", `${root}/users/me`, "users.me"],
  ["GET", `${root}/users?query=bob&offset=0&limit=50`, "users.list"],
  ["GET", `${root}/users/PBOB001`, "users.get"],
  ["GET", `${root}/teams?offset=0&limit=25`, "teams.list"],
  ["GET", `${root}/teams/PTEAM01`, "teams.get"],
  ["GET", `${root}/teams/PTEAM01/members?include%5B%5D=users&offset=0&limit=100`, "members.list"],
  ["GET", `${root}/services?sort_by=name&offset=0&limit=25`, "services.list"],
  ["GET", `${root}/services/PSVC001`, "services.get"],
  ["GET", `${root}/escalation_policies?team_ids%5B%5D=PTEAM01&offset=0&limit=100`, "escalation_policies.list"],
  ["GET", `${root}/escalation_policies/PEP0001`, "escalation_policies.get"],
  ["GET", `${root}/priorities?offset=0&limit=100`, "priorities.list"],
  ["GET", `${root}/oncalls?offset=0&limit=25`, "oncalls.list"],
  ["GET", `${root}/incidents?statuses%5B%5D=triggered&offset=0&limit=25`, "incidents.list"],
  ["POST", `${root}/incidents`, "incidents.create"],
  ["GET", `${root}/incidents/PINC001?include%5B%5D=assignees`, "incidents.get"],
  ["PUT", `${root}/incidents/PINC001`, "incidents.update"],
  ["GET", `${root}/incidents/PINC001/notes`, "notes.list"],
  ["POST", `${root}/incidents/PINC001/notes`, "notes.create"],
  ["GET", `${root}/incidents/PINC001/alerts?limit=1&sort_by=created_at%3Aasc`, "alerts.list"],
  ["GET", `${root}/incidents/PINC001/log_entries?offset=0&limit=25`, "log_entries.list"],
  ["POST", `${root}/incidents/PINC001/responder_requests`, "responder_requests.create"],
  ["POST", `${root}/incidents/PINC001/status_updates`, "status_updates.create"],
  ["POST", `${root}/incidents/PINC001/snooze`, "incidents.snooze"],
  ["GET", `${root}/schedules?offset=0&limit=25`, "schedules.list"],
  ["GET", `${root}/schedules/PSCH001?since=2026-01-01T00%3A00%3A00Z`, "schedules.get"],
  ["GET", `${root}/schedules/PSCH001/overrides?editable=true`, "overrides.list"],
  ["POST", `${root}/schedules/PSCH001/overrides`, "overrides.create"],
  ["DELETE", `${root}/schedules/PSCH001/overrides/POVR001`, "overrides.delete"],
  ["GET", `${root}/v3/schedules?offset=0&limit=25`, "schedules.list"],
  ["GET", `${root}/v3/schedules/PSCH003?include%5B%5D=users`, "schedules.get"],
  ["GET", `${root}/v3/schedules/PSCH003/overrides`, "overrides.list"],
];

const REQUESTS: Row[] = [...requestsUnder(ROOTS.us), ...requestsUnder(ROOTS.eu)];

describe("the names of PagerDuty's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(pagerdutyUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree, under the root of each region", () => {
    expect(PAGERDUTY_ROUTES.map(([root]) => root)).toEqual([`${ROOTS.us}/`, `${ROOTS.eu}/`]);
    expect(routeEnds(PAGERDUTY_ROUTES)).toHaveLength(30);
    expect(unreachedRouteEnds(PAGERDUTY_ROUTES, REQUESTS)).toEqual([]);
  });

  it.each<Row>([
    ["GET", `${ROOTS.us}/abilities`, "GET"],
    ["PUT", `${ROOTS.us}/incidents/PINC001/merge`, "PUT"],
    ["POST", `${ROOTS.eu}/v3/schedules/PSCH003/overrides/POVR001`, "POST"],
    ["GET", "https://api.pagerduty.example/users/me", "GET"],
    ["POST", "https://identity.pagerduty.com/oauth/token", "POST"],
    ["GET", ID_TOKEN_JWKS_URL, "GET"],
  ])("names %s %s, which no path of the tree is, by its method", (method, url, name) => {
    expect(pagerdutyUpstream.operationOf(method, url)).toBe(name);
  });

  it("builds no name from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(words.has(pagerdutyUpstream.operationOf("GET", `${ROOTS.us}/users/secret-user`))).toBe(true);
    expect(words.has(pagerdutyUpstream.operationOf("DELETE", `${ROOTS.eu}/schedules/secret-schedule/overrides/secret-override`))).toBe(true);
    expect(pagerdutyUpstream.operationOf("GET", `${ROOTS.us}/incidents/PINC001/secret-word`)).toBe("GET");
  });
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

// A full page of a listing of services, and whether PagerDuty has more.
const servicesPage = (more: boolean) => json({ services: Array.from({ length: 100 }, (_, n) => ({ id: `PSVC${n}` })), more });

type Sent = { method: string; url: string; redirect: RequestInit["redirect"] };

// A global fetch that answers the requests sent, in order, with `answers`, the last of them for
// every request after it; an `Error` among them is thrown. Returns the requests as they are sent.
function answering(...answers: ((() => Response) | Error)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const answer = answers[Math.min(sent.length, answers.length - 1)];
    sent.push({ method: init.method ?? "GET", url: String(input), redirect: init.redirect });
    if (answer instanceof Error) throw answer;
    return answer();
  });
  return sent;
}

// A `Retry-After` that is the date `ms` ahead of the clock.
const retryAt = (ms: number) => ({ "retry-after": new Date(Date.now() + ms).toUTCString() });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const api = (region: Region = "us") => new PagerDutyApi("secret-token", region, "alice@acme.test");

// A caller's check of a body: whether it describes a team.
const holdsTeam = (body: Record<string, unknown>) => typeof body.team === "object" && body.team !== null;

describe("the points of PagerDuty's requests", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
    ambient.SUBSERVICE_METRICS = "true";
    // No wait between the sends of a request that is sent again.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Each point written, as its operation, outcome, reason, HTTP status and number of calls.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
      SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot)));
  }

  it("counts a read and a write of either region under the vendor's source and service, by their routes", async () => {
    const sent = answering(json({ incident: { id: "PINC001" } }));
    await api().get("/incidents/PINC001", { include: ["assignees"] });
    await api("eu").write("PUT", "/incidents/PINC001", { incident: { status: "resolved" } });
    expect(sent).toEqual([
      { method: "GET", url: `${ROOTS.us}/incidents/PINC001?include%5B%5D=assignees`, redirect: "manual" },
      { method: "PUT", url: `${ROOTS.eu}/incidents/PINC001`, redirect: "manual" },
    ]);
    expect(pagerdutyUpstream.source).toBe("gatekeeper.pagerduty.api");
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
    ].map(slot => column(point, slot)))).toEqual([
      ["gatekeeper.pagerduty.api", "pagerduty", "incidents.get", "success"],
      ["gatekeeper.pagerduty.api", "pagerduty", "incidents.update", "success"],
    ]);
  });

  it("counts a batch of overrides PagerDuty answered 201 as an error of the call when it refused one", async () => {
    answering(json([{ status: 201, override: { id: "POVR001" } }], 201));
    await api().write("POST", "/schedules/PSCH001/overrides", { overrides: [{}] });
    answering(json([{ status: 400, errors: ["Override must end after its start"] }], 201));
    expect(await api().write("POST", "/schedules/PSCH001/overrides", { overrides: [{}] }))
      .toEqual([{ status: 400, errors: ["Override must end after its start"] }]);
    expect(calls()).toEqual([
      ["overrides.create", "success", "", 201, 1],
      ["overrides.create", "error", "api", 201, 1],
    ]);
  });

  it.each<[string, () => Response, string]>([
    ["no list", json({ more: false }), "Error"],
    ["what is no list", json({ services: "none", incidents: null }), "Error"],
    ["a list in place of an object", json([{ id: "PSVC001" }]), "Error"],
    ["no body", () => new Response(null), "TypeError"],
  ])("counts a listing answered 200 with %s as an error of the call, sent once and thrown as it is", async (_, answer, name) => {
    const sent = answering(answer);
    const error = await rejection(api().page("/services", "services", {}, 0, 25));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name });
    if (name === "Error") expect(error).toMatchObject({ message: "PagerDuty's listing of services was malformed." });
    expect(await rejection(api().all("/incidents", "incidents"))).toMatchObject({ name });
    expect(sent.map(({ method, url }) => [method, url])).toEqual([
      ["GET", `${ROOTS.us}/services?offset=0&limit=25`], ["GET", `${ROOTS.us}/incidents?offset=0&limit=100`],
    ]);
    expect(calls()).toEqual([["services.list", "error", "api", 200, 1], ["incidents.list", "error", "api", 200, 1]]);
  });

  it("counts a success its caller's check refuses or throws on as an error of the call, and returns the body all the same", async () => {
    const sent = answering(json({ team: null }));
    expect(await api().object("team", "PTEAM01", holdsTeam)).toEqual({ team: null });
    expect(await api().get("/teams/PTEAM01", {}, () => {
      throw new TypeError("no team");
    })).toEqual({ team: null });
    expect(await api().write("PUT", "/incidents/PINC001", {}, () => false)).toEqual({ team: null });
    expect(await api().get("/teams/PTEAM01", {}, () => true)).toEqual({ team: null });
    expect(sent).toHaveLength(4);
    expect(calls()).toEqual([
      ["teams.get", "error", "api", 200, 1], ["teams.get", "error", "api", 200, 1],
      ["incidents.update", "error", "api", 200, 1], ["teams.get", "success", "", 200, 1],
    ]);
  });

  it("asks a caller's check about a schedule of either generation, and about no answer that is not a success", async () => {
    const holdsSchedule = vi.fn((body: Record<string, unknown>) => typeof body.schedule === "object" && body.schedule !== null);
    const sent = answering(json({ error: { message: "Not shift-based" } }, 400), json({ schedule: "PSCH001" }));
    expect(await api().object("schedule", "PSCH001", holdsSchedule)).toEqual({ schedule: "PSCH001" });
    expect(sent.map(({ url }) => url)).toEqual([`${ROOTS.us}/v3/schedules/PSCH001`, `${ROOTS.us}/schedules/PSCH001`]);
    expect(holdsSchedule.mock.calls).toEqual([[{ schedule: "PSCH001" }]]);
    answering(json({ schedule: { id: "PSCH003" } }));
    expect(await api().schedule("PSCH003", holdsSchedule)).toEqual({ body: { schedule: { id: "PSCH003" } }, shiftBased: true });
    expect(calls()).toEqual([
      ["schedules.get", "error", "http", 400, 1], ["schedules.get", "error", "api", 200, 1], ["schedules.get", "success", "", 200, 1],
    ]);
  });

  it("counts a shift-based schedule its caller's check refuses as an error of the call, and returns the body all the same", async () => {
    const holdsSchedule = vi.fn((body: Record<string, unknown>) => typeof body.schedule === "object" && body.schedule !== null);
    const sent = answering(json({ schedule: null }));
    expect(await api().schedule("PSCH003", holdsSchedule)).toEqual({ body: { schedule: null }, shiftBased: true });
    expect(await api().object("schedule", "PSCH003", holdsSchedule)).toEqual({ schedule: null });
    expect(sent.map(({ method, url }) => [method, url])).toEqual([
      ["GET", `${ROOTS.us}/v3/schedules/PSCH003`], ["GET", `${ROOTS.us}/v3/schedules/PSCH003`],
    ]);
    expect(holdsSchedule.mock.calls).toEqual([[{ schedule: null }], [{ schedule: null }]]);
    expect(calls()).toEqual([["schedules.get", "error", "api", 200, 1], ["schedules.get", "error", "api", 200, 1]]);
  });

  it("writes the pages of a listing as one point", async () => {
    const sent = answering(servicesPage(true), servicesPage(false));
    expect(await api().all("/services", "services", { team_ids: ["PTEAM01"] })).toHaveLength(200);
    expect(sent.map(({ url }) => new URL(url).searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(calls()).toEqual([["services.list", "success", "", 200, 2]]);
  });

  it.each([
    [502, "error", "http"], [503, "error", "http"], [504, "error", "http"],
  ])("sends a read answered %i again, three times at most, and counts each send", async (status, outcome, reason) => {
    const healed = answering(json({}, status), json({ user: { id: "PBOB001" } }));
    expect(await api().get("/users/PBOB001")).toEqual({ user: { id: "PBOB001" } });
    expect(healed).toHaveLength(2);
    const failing = answering(json({ error: { message: "Try later" } }, status));
    expect(await rejection(api().get("/users/PBOB001"))).toMatchObject({ name: "PagerDutyApiError", status });
    expect(failing).toHaveLength(3);
    expect(calls()).toEqual([
      ["users.get", outcome, reason, status, 1], ["users.get", "success", "", 200, 1],
      ["users.get", outcome, reason, status, 1], ["users.get", outcome, reason, status, 1], ["users.get", outcome, reason, status, 1],
    ]);
  });

  it("sends a read that did not reach PagerDuty again, and says so once every send has failed", async () => {
    const lost = new TypeError("network connection lost");
    const sent = answering(lost);
    const error = await rejection(api().get("/priorities"));
    expect(error).toMatchObject({ message: "Could not reach PagerDuty; please try again.", cause: lost });
    expect(sent).toHaveLength(3);
    expect(calls()).toEqual(Array.from({ length: 3 }, () => ["priorities.list", "error", "network", 0, 1]));
  });

  it.each([400, 401, 403, 404, 500])("sends a read answered %i once", async status => {
    const sent = answering(json({ error: { message: "Refused", errors: ["Not this one"] } }, status));
    const error = await rejection(api().get("/services/PSVC001"));
    expect(error).toBeInstanceOf(PagerDutyApiError);
    expect(error).toMatchObject({ status, message: `PagerDuty answered HTTP ${status}: Refused; Not this one` });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["services.get", "error", "http", status, 1]]);
  });

  it.each([
    ["POST", "/incidents/PINC001/snooze", "incidents.snooze"],
    ["PUT", "/incidents/PINC001", "incidents.update"],
    ["DELETE", "/schedules/PSCH001/overrides/POVR001", "overrides.delete"],
  ] as const)("sends a %s once, whatever PagerDuty answers or fails with", async (method, path, name) => {
    const limited = answering(() => new Response(null, { status: 429, headers: { "ratelimit-reset": "12" } }));
    expect(await rejection(api().write(method, path, {}))).toMatchObject({
      status: 429, message: "PagerDuty is rate limiting this connection; try again in 12 seconds.",
    });
    const unavailable = answering(json({}, 503));
    expect(await rejection(api().write(method, path, {}))).toMatchObject({ status: 503, message: "PagerDuty answered HTTP 503." });
    const lost = answering(new TypeError("network connection lost"));
    expect(await rejection(api().write(method, path, {}))).toMatchObject({ message: "Could not reach PagerDuty; please try again." });
    const silent = answering(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await rejection(api().write(method, path, {}))).toMatchObject({ message: "PagerDuty did not answer in time; please try again." });
    expect([limited, unavailable, lost, silent].map(sent => sent.length)).toEqual([1, 1, 1, 1]);
    expect(calls()).toEqual([
      [name, "refused", "rate", 429, 1], [name, "error", "http", 503, 1],
      [name, "error", "network", 0, 1], [name, "error", "network", 0, 1],
    ]);
  });

  describe("a read whose answer the timeout of its attempt cut off", () => {
    // The timeout of each attempt, in the order the attempts were made.
    let timeouts: AbortController[];

    beforeEach(() => {
      timeouts = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const timeout = new AbortController();
        timeouts.push(timeout);
        return timeout.signal;
      });
    });

    // A 200 with `headers` whose body stops after its start until the timeout of its attempt fires.
    const stalled = (headers: Record<string, string>) => () => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode('{"service":')),
      pull(controller) {
        const timeout = timeouts.at(-1);
        timeout?.abort(new DOMException("The operation timed out.", "TimeoutError"));
        controller.error(timeout?.signal.reason);
      },
    }), { headers });

    it("is asked for again where something is left of the rate limit", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const sent = answering(stalled({ "ratelimit-remaining": "12", "ratelimit-reset": "15" }), json({ service: { id: "PSVC001" } }));
      expect(await api().get("/services/PSVC001")).toEqual({ service: { id: "PSVC001" } });
      expect(sent).toHaveLength(2);
      expect(calls()).toEqual([["services.get", "error", "timeout", 200, 1], ["services.get", "success", "", 200, 1]]);
    });

    // PagerDuty says what is left of the limit on a success too, and refuses a request sent before
    // the limit resets: the refusal would be thrown in place of the read that failed.
    it("is not asked for again where its answer spent the rate limit, and throws what the reading met", async () => {
      const sent = answering(stalled({ "ratelimit-remaining": "0", "ratelimit-reset": "15" }),
        () => new Response(null, { status: 429, headers: { "ratelimit-reset": "15" } }));
      const thrown = await rejection(api().get("/services/PSVC001"));
      expect(thrown).toMatchObject({
        message: "PagerDuty's response could not be read; please try again.", cause: timeouts[0].signal.reason,
      });
      expect(sent).toHaveLength(1);
      expect(calls()).toEqual([["services.get", "error", "timeout", 200, 1]]);
    });
  });

  describe("a request PagerDuty rate limits", () => {
    const user = { user: { id: "PBOB001" } };
    const limitedPoint = ["users.get", "refused", "rate", 429, 1];
    // The milliseconds of the fake clock at which each answer was asked for, from the first.
    let sentAt: number[];

    beforeEach(() => {
      // The clock starts at a whole second, which is what a date in a header counts by.
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
      sentAt = [];
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // An answer that notes when it was asked for.
    const timed = (answer: () => Response) => () => {
      sentAt.push(Date.now());
      return answer();
    };
    const rateLimited = (headers: Record<string, string> = {}) => timed(() => new Response(null, { status: 429, headers }));
    const sinceFirst = () => {
      const [first = 0] = sentAt;
      return sentAt.map(at => at - first);
    };

    it("waits the two seconds a 429 says its rate limit resets in, then sends the read again", async () => {
      const sent = answering(rateLimited({ "ratelimit-reset": "2" }), timed(json(user)));
      const read = api().get("/users/PBOB001");
      await vi.advanceTimersByTimeAsync(1999);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toEqual(user);
      expect(sent).toEqual(Array.from({ length: 2 }, () => ({ method: "GET", url: `${ROOTS.us}/users/PBOB001`, redirect: "manual" })));
      expect(sinceFirst()).toEqual([0, 2000]);
      expect(calls()).toEqual([limitedPoint, ["users.get", "success", "", 200, 1]]);
    });

    it.each([
      ["1", 1000], ["1.5", 2000], ["9.2", 10_000], ["10", 10_000],
    ])("waits no less than a reset of %s seconds, whatever the backoff would have been", async (reset, waitMs) => {
      vi.mocked(Math.random).mockReturnValue(0.999);
      answering(rateLimited({ "ratelimit-reset": reset }), timed(json(user)));
      const read = api().get("/users/PBOB001");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await read).toEqual(user);
      expect(sinceFirst()).toEqual([0, waitMs]);
      expect(sinceFirst()[1]).toBeGreaterThanOrEqual(Number(reset) * 1000);
    });

    it("sends a read that stays rate limited three times at most, each a reset after the one before", async () => {
      const sent = answering(rateLimited({ "ratelimit-reset": "3" }));
      const failed = rejection(api().get("/users/PBOB001"));
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await failed;
      expect(error).toBeInstanceOf(PagerDutyApiError);
      expect(error).toMatchObject({ status: 429, message: "PagerDuty is rate limiting this connection; try again in 3 seconds." });
      expect(sent).toHaveLength(3);
      expect(sinceFirst()).toEqual([0, 3000, 6000]);
      expect(calls()).toEqual([limitedPoint, limitedPoint, limitedPoint]);
    });

    it.each<[headers: Record<string, string>, wait: string]>([
      [{ "ratelimit-reset": "20" }, "in 20 seconds"],
      [{ "ratelimit-reset": "11" }, "in 11 seconds"],
      [{ "ratelimit-reset": "10.5" }, "in 11 seconds"],
      [{}, "shortly"],
      [{ "ratelimit-reset": "" }, "shortly"],
      [{ "ratelimit-reset": "soon" }, "shortly"],
      [{ "ratelimit-reset": "0" }, "shortly"],
      [{ "ratelimit-reset": "-2" }, "shortly"],
      [{ "ratelimit-reset": "Infinity" }, "shortly"],
      [{ "retry-after": "60" }, "shortly"],
      [{ "ratelimit-reset": "20", "retry-after": "1" }, "in 20 seconds"],
      [{ "ratelimit-reset": "2", "retry-after": "60" }, "in 2 seconds"],
      [{ "retry-after": "soon" }, "shortly"],
      [{ "retry-after": "1.5" }, "shortly"],
      [{ "retry-after": "-1" }, "shortly"],
      [{ "ratelimit-reset": "2", "retry-after": "soon" }, "in 2 seconds"],
      [{ "ratelimit-reset": "2", "retry-after": "Sunday, 06-Nov-94 08:49:37 GMT" }, "in 2 seconds"],
      [{ "ratelimit-reset": "2", "retry-after": "Sun Nov  6 08:49:37 1994" }, "in 2 seconds"],
      [{ "ratelimit-reset": "2", "retry-after": "Sun, 06 Nov 1994 24:49:37 GMT" }, "in 2 seconds"],
    ])("sends a read answered 429 with %j once, and waits for nothing", async (headers, wait) => {
      const sent = answering(rateLimited(headers));
      const error = await rejection(api().get("/users/PBOB001"));
      expect(error).toBeInstanceOf(PagerDutyApiError);
      expect(error).toMatchObject({ status: 429, message: `PagerDuty is rate limiting this connection; try again ${wait}.` });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(calls()).toEqual([limitedPoint]);
    });

    it.each<[headers: Record<string, string>, waitMs: number]>([
      [{ "retry-after": "3" }, 3000],
      [{ "ratelimit-reset": "2", "retry-after": "5" }, 5000],
      [{ "ratelimit-reset": "5", "retry-after": "2" }, 5000],
      [{ "ratelimit-reset": "soon", "retry-after": "10" }, 10_000],
      [{ "retry-after": "0" }, 0],
      [{ "ratelimit-reset": "0", "retry-after": "0" }, 0],
      [{ "ratelimit-reset": "3", "retry-after": "0" }, 3000],
      [{ "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }, 0],
      [{ "ratelimit-reset": "3", "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }, 3000],
    ])("waits the longer of the waits a 429 with %j names", async (headers, waitMs) => {
      answering(rateLimited(headers), timed(json(user)));
      const read = api().get("/users/PBOB001");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await read).toEqual(user);
      expect(sinceFirst()).toEqual([0, waitMs]);
    });

    it.each<[retryAfter: string, reset: string | undefined, ms: number, waitMs: number]>([
      ["3 seconds on", undefined, 3000, 3000],
      ["10 seconds on", undefined, 10_000, 10_000],
      ["8 seconds on, past a reset of 2 seconds", "2", 8000, 8000],
      ["3 seconds on, before a reset of 8 seconds", "8", 3000, 8000],
    ])("waits until the later time a 429 names whose Retry-After is a date %s", async (_, reset, ms, waitMs) => {
      answering(rateLimited({ ...retryAt(ms), ...(reset === undefined ? {} : { "ratelimit-reset": reset }) }), timed(json(user)));
      const read = api().get("/users/PBOB001");
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(sentAt).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toEqual(user);
      expect(sinceFirst()).toEqual([0, waitMs]);
    });

    it.each<[retryAfter: string, reset: string | undefined, ms: number, wait: string]>([
      ["11 seconds on", undefined, 11_000, "shortly"],
      ["a minute on", undefined, 60_000, "shortly"],
      ["a minute on, past a reset of 2 seconds", "2", 60_000, "in 2 seconds"],
      ["3 seconds on, before a reset of 20 seconds", "20", 3000, "in 20 seconds"],
    ])("sends a read once whose 429 has a Retry-After that is a date %s, and waits for nothing", async (_, reset, ms, wait) => {
      const sent = answering(rateLimited({ ...retryAt(ms), ...(reset === undefined ? {} : { "ratelimit-reset": reset }) }));
      const error = await rejection(api().get("/users/PBOB001"));
      expect(error).toBeInstanceOf(PagerDutyApiError);
      expect(error).toMatchObject({ status: 429, message: `PagerDuty is rate limiting this connection; try again ${wait}.` });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("sends a read whose 429 asks for no wait again at once, three times at most", async () => {
      const sent = answering(rateLimited({ "retry-after": "0" }));
      const error = await rejection(api().get("/users/PBOB001"));
      expect(error).toBeInstanceOf(PagerDutyApiError);
      expect(error).toMatchObject({ status: 429, message: "PagerDuty is rate limiting this connection; try again shortly." });
      expect(sent).toHaveLength(3);
      expect(sinceFirst()).toEqual([0, 0, 0]);
      expect(calls()).toEqual([limitedPoint, limitedPoint, limitedPoint]);
    });

    it("gives a read PagerDuty does not answer 30 seconds a send, and sends it three times", async () => {
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      // A PagerDuty that never answers: the request fails once its signal aborts, as `fetch` fails one.
      vi.stubGlobal("fetch", (_input: string | URL, init: RequestInit = {}) => {
        sentAt.push(Date.now());
        return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      });
      const failed = rejection(api().get("/users/PBOB001"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await failed).toMatchObject({ message: "PagerDuty did not answer in time; please try again." });
      expect(sinceFirst()).toEqual([0, 30_000, 60_000]);
      expect(calls()).toEqual(Array.from({ length: 3 }, () => ["users.get", "error", "timeout", 0, 1]));
    });

    it.each(["POST", "PUT", "DELETE"] as const)("sends a %s once, though its rate limit resets in two seconds", async method => {
      const sent = answering(rateLimited({ "ratelimit-reset": "2" }));
      const error = await rejection(api().write(method, "/users/PBOB001", {}));
      expect(error).toBeInstanceOf(PagerDutyApiError);
      expect(error).toMatchObject({ status: 429, message: "PagerDuty is rate limiting this connection; try again in 2 seconds." });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([502, 503, 504])("waits what the Retry-After of a %i asks, and reads no reset from it", async status => {
      const unavailable = (headers: Record<string, string>) => timed(() => new Response(null, { status, headers }));
      answering(unavailable({ "retry-after": "4", "ratelimit-reset": "20" }), unavailable({ "ratelimit-reset": "20" }), timed(json(user)));
      const read = api().get("/users/PBOB001");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await read).toEqual(user);
      // The second wait is the client's backoff, which the random share of nothing makes none.
      expect(sinceFirst()).toEqual([0, 4000, 4000]);
    });
  });

  it("counts a redirect, which is not followed, and a success that is not JSON as errors", async () => {
    const sent = answering(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    const redirected = await rejection(api().get("/users/me"));
    expect(redirected).toBeInstanceOf(PagerDutyApiError);
    expect(redirected).toMatchObject({ status: 302, message: "PagerDuty answered with an unexpected redirect." });
    expect(sent).toEqual([{ method: "GET", url: `${ROOTS.us}/users/me`, redirect: "manual" }]);
    answering(() => new Response("<html>"));
    expect(await rejection(api().get("/users/me"))).toMatchObject({ message: "PagerDuty answered with a response that is not JSON." });
    expect(calls()).toEqual([["users.me", "error", "http", 302, 1], ["users.me", "error", "parse", 200, 1]]);
  });

  it("counts an answer with no body as a success", async () => {
    answering(() => new Response(null, { status: 204 }));
    expect(await api().write("DELETE", "/schedules/PSCH001/overrides/POVR001")).toBeUndefined();
    expect(calls()).toEqual([["overrides.delete", "success", "", 204, 1]]);
  });

  it("writes nothing an answer, a path, a query or a token holds", async () => {
    answering(json({ error: { message: "Secret refusal about secret-user" } }, 403));
    await rejection(api().get("/users/secret-user", { query: "secret words" }));
    const written = JSON.stringify(points);
    expect(points).toHaveLength(1);
    for (const secret of ["secret", "Secret", "pagerduty.com", "acme.test"]) expect(written).not.toContain(secret);
  });
});

// An ID token as PagerDuty's token endpoint returns one, signed with the test key.
async function signedIdToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    user_id: "PALICE1", account_id: "PACME01", subdomain: "acme", region: "UnitedStates",
    iss: ID_TOKEN_ISSUER, aud: [ROOTS.us, "client-id"], iat: now, exp: now + 3600,
  }).setProtectedHeader({ alg: "RS256", kid: SIGNING_JWK.kid }).sign(await importJWK(SIGNING_JWK, "RS256"));
}

describe("the requests no path names", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
    ambient.SUBSERVICE_METRICS = "true";
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Each point written, as its source, service, operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
      SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  // Each literal name, with the call that sends the request it names.
  const LITERALS = {
    "certs.get": async () => {
      const { kty, kid, n, e } = SIGNING_JWK;
      const sent = answering(json({ keys: [{ kty, kid, n, e, alg: "RS256", use: "sig" }] }));
      expect(await verifyIdToken(await signedIdToken(), "client-id"))
        .toEqual({ userId: "PALICE1", accountId: "PACME01", subdomain: "acme", region: "us" });
      return sent;
    },
  } satisfies Record<(typeof PAGERDUTY_OPERATIONS)[number], () => Promise<Sent[]>>;

  it("sends a request for every literal name, and lists none twice", () => {
    expect(Object.keys(LITERALS).toSorted()).toEqual(PAGERDUTY_OPERATIONS.toSorted());
    expect(new Set(PAGERDUTY_OPERATIONS).size).toBe(PAGERDUTY_OPERATIONS.length);
  });

  it("counts the fetch of the keys an ID token is checked with as certs.get, following no redirect", async () => {
    const sent = await LITERALS["certs.get"]();
    expect(sent).toEqual([{ method: "GET", url: ID_TOKEN_JWKS_URL, redirect: "manual" }]);
    expect(calls()).toEqual([["gatekeeper.pagerduty.api", "pagerduty", "certs.get", "success", "", 200]]);
  });

  it.each<[string, () => Response, string, [outcome: string, reason: string, status: number]]>([
    ["a 200 that is a page of HTML", () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
      "Failed to parse the JSON Web Key Set HTTP response as JSON", ["error", "parse", 200]],
    ["a 200 whose JSON holds no keys", json({}), "JSON Web Key Set malformed", ["error", "parse", 200]],
    ["a 200 whose keys are no list", json({ keys: "none" }), "JSON Web Key Set malformed", ["error", "parse", 200]],
    ["a 200 whose keys hold what is no key", json({ keys: [null] }), "JSON Web Key Set malformed", ["error", "parse", 200]],
    ["a 404, by its status", json({ error: "Not Found" }, 404), "Expected 200 OK from the JSON Web Key Set HTTP response",
      ["error", "http", 404]],
    ["a 206 that holds keys, which is no 200", json({ keys: [{ kty: "RSA", kid: "k" }] }, 206),
      "Expected 200 OK from the JSON Web Key Set HTTP response", ["error", "http", 206]],
  ])("counts the fetch of the keys answered %s as an error, and fails the check as the key set's reader does", async (_what, answer, message, counted) => {
    // Past the ten minutes for which keys fetched by an earlier check are kept, so that this one
    // fetches them whatever ran before it.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    const sent = answering(answer);

    await expect(verifyIdToken(await signedIdToken(), "client-id")).rejects.toThrow(message);

    expect(sent).toEqual([{ method: "GET", url: ID_TOKEN_JWKS_URL, redirect: "manual" }]);
    expect(calls()).toEqual([["gatekeeper.pagerduty.api", "pagerduty", "certs.get", ...counted]]);
  });
});
