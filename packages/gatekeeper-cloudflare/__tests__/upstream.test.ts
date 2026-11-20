// The requests this gatekeeper makes to Cloudflare and the name each is counted under, and what
// the gatekeeper decides about a call that the client cannot know: an error inside a success, the
// telemetry requests' own retry rule, and which operations are summed.

import { env } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchIdentity, listAccounts } from "../src/cloudflare-api";
import { CLOUDFLARE_ROUTES, cloudflareUpstream } from "../src/cloudflare-upstream";
import { exchangeCode, refreshTokens, type CloudflareOAuthConfig } from "../src/oauth";
import { CloudflareObservabilityApi, CloudflareObservabilityApiError } from "../src/observability-api";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TELEMETRY = `${API}/accounts/${ACCOUNT_ID}/workers/observability/telemetry`;
const NOW = new Date("2026-08-14T12:00:00Z");

/** Every kind of request the gatekeeper makes under Cloudflare's API root, with the name it is counted under. */
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${API}/user`, "user.get"],
  ["GET", `${API}/accounts?page=1&per_page=50`, "accounts.list"],
  ["POST", `${TELEMETRY}/query`, "telemetry.query"],
  ["POST", `${TELEMETRY}/keys`, "telemetry.keys"],
  ["POST", `${TELEMETRY}/values`, "telemetry.values"],
];

describe("the names of Cloudflare's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(cloudflareUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(CLOUDFLARE_ROUTES)).toHaveLength(4);
    expect(unreachedRouteEnds(CLOUDFLARE_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, and another host, by the method alone", () => {
    expect(cloudflareUpstream.operationOf("GET", `${API}/zones`)).toBe("GET");
    expect(cloudflareUpstream.operationOf("GET", `${TELEMETRY}/query`)).toBe("GET");
    expect(cloudflareUpstream.operationOf("POST", `${TELEMETRY}/destinations`)).toBe("POST");
    expect(cloudflareUpstream.operationOf("POST", "https://dash.cloudflare.com/oauth2/token")).toBe("POST");
  });

  it("builds no name from an account's id", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(words.has(cloudflareUpstream.operationOf("POST", `${API}/accounts/some-tenant/workers/observability/telemetry/keys`)))
      .toBe(true);
    expect(cloudflareUpstream.operationOf("GET", `${API}/accounts/some-tenant`)).toBe("accounts.get");
  });
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// What a stubbed fetch does with one send: answers, or throws.
type Answer = () => Response;

// A global fetch that gives each send the next of `answers`, and every later one the last.
function respond(...answers: Answer[]) {
  let sends = 0;
  const fetch = vi.fn(async () => answers[Math.min(sends++, answers.length - 1)]?.() ?? new Response(null));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const json = (body: unknown, init?: ResponseInit): Answer => () => Response.json(body, init);
const status = (code: number, headers?: Record<string, string>): Answer =>
  () => Response.json({ success: false }, { status: code, headers });
const throws = (error: Error): Answer => () => {
  throw error;
};

/** The page of telemetry events numbered `page`, as the `query` endpoint answers. */
const eventsPage = (count: number, total: number, page = 1): Answer => json({
  success: true,
  result: {
    statistics: { elapsed: 0.01, rows_read: count, bytes_read: 10 },
    events: {
      count: total,
      events: Array.from({ length: count }, (_, index) => ({
        dataset: "cloudflare-workers", timestamp: index, source: {},
        $metadata: { id: `event-${page}-${index}`, service: "api-worker" },
      })),
    },
  },
});

/** The statistics every answer of the `query` endpoint holds. */
const STATISTICS = { elapsed: 0.01, rows_read: 1, bytes_read: 10 };

/** A page of `count` accounts out of 120, as `/accounts` answers. */
const accountsPage = (count: number): Answer => json({
  success: true,
  result: Array.from({ length: count }, (_, index) => ({ id: `id-${index}`, name: `account-${index}` })),
  result_info: { per_page: 50, total_count: 120 },
});

/** The telemetry client of one account, with a token to send. */
const telemetry = () => new CloudflareObservabilityApi(async () => "secret-token", ACCOUNT_ID);

/** The HTTP date `ms` after the tests' clock. */
const later = (ms: number) => new Date(NOW.valueOf() + ms).toUTCString();

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

// The status of each failure a telemetry request logged through the spied `console.warn`, in the
// order logged.
function warned() {
  return vi.mocked(console.warn).mock.calls.map(([line]) => {
    expect(line).toMatchObject({ event: "observability.request.failed", path: "keys" });
    return (line as { status?: unknown }).status;
  });
}

describe("the points of Cloudflare's requests", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
    ambient.SUBSERVICE_METRICS = "true";
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // A failed request is logged, which is not what these tests read.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Each point written, as its operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
      SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  it("counts every kind of request under the vendor's source and service, by its route", async () => {
    respond(json({ success: true, result: { id: "u1", email: "user@example.com" } }));
    await fetchIdentity("secret-token");
    respond(json({ success: true, result: [] }));
    await listAccounts("secret-token");
    await telemetry().listKeys();
    await telemetry().listValues("$metadata.service", "string");
    respond(eventsPage(1, 1));
    await telemetry().listEvents();

    expect(points.map(point => [SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service]
      .map(slot => column(point, slot)))).toEqual(points.map(() => ["gatekeeper.cloudflare.api", "cloudflare"]));
    expect(calls()).toEqual([
      ["user.get", "success", "", 200],
      ["accounts.list", "success", "", 200],
      ["telemetry.keys", "success", "", 200],
      ["telemetry.values", "success", "", 200],
      ["telemetry.query", "success", "", 200],
    ]);
  });

  it("counts the token requests of the OAuth client under their literal names", async () => {
    const config: CloudflareOAuthConfig = {
      clientId: "client", clientSecret: "secret",
      authUrl: "https://dash.cloudflare.com/oauth2/auth",
      tokenUrl: "https://dash.cloudflare.com/oauth2/token",
      redirectUri: "https://gatekeeper.example/oauth",
    };
    const fetch = respond(json({ access_token: "access", expires_in: 3600 }), status(503));
    await exchangeCode(config, "code", "verifier");
    await failure(refreshTokens(config, "refresh"));

    // A token request is sent once: a second redemption of a code or a rotating refresh token fails.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls()).toEqual([
      ["token.exchange", "success", "", 200],
      ["token.refresh", "error", "http", 503],
    ]);
  });

  it("counts a GET whose envelope reports a failure inside a 200 as an error of the API", async () => {
    respond(json({ success: false, errors: [{ code: 9109, message: "Secret refusal" }] }));
    expect(await fetchIdentity("secret-token")).toBeNull();
    respond(json({ success: true }));
    expect(await listAccounts("secret-token")).toEqual([]);

    expect(calls()).toEqual([
      ["user.get", "error", "api", 200],
      ["accounts.list", "error", "api", 200],
    ]);
  });

  it("counts a GET whose result is not what it was sent for as an error, and sends it once", async () => {
    const nameless = respond(json({ success: true, result: { id: "u1", first_name: "Ada" } }));
    expect(await fetchIdentity("secret-token")).toBeNull();
    const empty = respond(json({ success: true, result: null }));
    expect(await listAccounts("secret-token")).toEqual([]);
    const listless = respond(json({ success: true, result: { id: "a1", name: "one" } }));
    const error = await failure(listAccounts("secret-token"));

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "result.map is not a function" });
    expect([nameless, empty, listless].map(fetch => fetch.mock.calls.length)).toEqual([1, 1, 1]);
    expect(calls()).toEqual([
      ["user.get", "error", "api", 200],
      ["accounts.list", "error", "api", 200],
      ["accounts.list", "error", "api", 200],
    ]);
  });

  it("counts an identity whose reading throws as an error of the API, and throws what the reading threw", async () => {
    const fetch = respond(json({ success: true, result: { id: "u1", email: 42 } }));
    const error = await failure(fetchIdentity("secret-token"));

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "r.email.split is not a function" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["user.get", "error", "api", 200]]);
  });

  // A page in the middle of an account listing that is not what it was sent for: what the walk
  // then answers, after the page of 50 accounts before it.
  it.each<[row: string, result: unknown, ending: unknown]>([
    ["holds no result", null, 50],
    ["holds a result that is no list", { id: "a1", name: "one" }, "result.map is not a function"],
  ])("counts a page of an account listing that %s as an error beside the pages read, and sends no page after it", async (_row, result, ending) => {
    const fetch = respond(accountsPage(50), json({ success: true, result }), accountsPage(20));
    const listed = await listAccounts("secret-token").then(
      accounts => accounts.length, (error: unknown) => error instanceof TypeError && error.message);

    expect(listed).toBe(ending);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, `${API}/accounts?page=1&per_page=50`, expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(2, `${API}/accounts?page=2&per_page=50`, expect.anything());
    expect(calls()).toEqual([["accounts.list", "success", "", 200], ["accounts.list", "error", "api", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([1, 1]);
  });

  it("counts a refused GET and a redirect, which is not followed, by their status, and sends each once", async () => {
    const refused = respond(status(403));
    expect(await fetchIdentity("secret-token")).toBeNull();
    const redirected = respond(() => new Response(null, {
      status: 302, headers: { Location: "https://elsewhere.example/user" },
    }));
    expect(await fetchIdentity("secret-token")).toBeNull();

    expect([refused, redirected].map(fetch => fetch.mock.calls.length)).toEqual([1, 1]);
    expect(redirected).toHaveBeenCalledWith(`${API}/user`, expect.objectContaining({ redirect: "manual" }));
    expect(calls()).toEqual([
      ["user.get", "error", "http", 403],
      ["user.get", "error", "http", 302],
    ]);
  });

  it("sends a GET three times at most after a transient failure, and counts each send", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const unavailable = respond(status(503));
    expect(await fetchIdentity("secret-token")).toBeNull();
    const lost = respond(throws(new TypeError("network connection lost")), json({
      success: true, result: { id: "u1", email: "user@example.com" },
    }));
    expect(await fetchIdentity("secret-token")).toMatchObject({ id: "u1" });

    expect([unavailable, lost].map(fetch => fetch.mock.calls.length)).toEqual([3, 2]);
    expect(calls()).toEqual([
      ["user.get", "error", "http", 503],
      ["user.get", "error", "http", 503],
      ["user.get", "error", "http", 503],
      ["user.get", "error", "network", 0],
      ["user.get", "success", "", 200],
    ]);
  });

  it("counts a telemetry failure inside a 200 as an error of the API, with Cloudflare's code", async () => {
    respond(json({ success: false, errors: [{ code: 7003, message: "Secret refusal" }] }));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 200, codes: [7003] });

    expect(calls()).toEqual([["telemetry.keys", "error", "api", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.providerCode))).toEqual([7003]);
  });

  it("counts a telemetry answer that cannot be read as one, and a refusal by its status", async () => {
    respond(json({ success: true, result: null }));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 502 });
    respond(() => new Response("not json"));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 502 });
    respond(json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 403 });
    respond(() => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/keys" } }));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 307 });

    expect(calls()).toEqual([
      ["telemetry.keys", "error", "parse", 200],
      ["telemetry.keys", "error", "parse", 200],
      ["telemetry.keys", "error", "http", 403],
      ["telemetry.keys", "error", "http", 307],
    ]);
  });

  // A result that a telemetry method's own parser refuses, by the method that asked for it.
  it.each<[row: string, operation: string, result: unknown, read: (api: CloudflareObservabilityApi) => Promise<unknown>]>([
    ["keys that are no list", "telemetry.keys", { keys: [] }, api => api.listKeys()],
    ["a key with no type", "telemetry.keys", [{ key: "$metadata.level" }], api => api.listKeys()],
    ["values that are no list", "telemetry.values", "none", api => api.listValues("$metadata.service", "string")],
    ["a value with no key", "telemetry.values", [{ type: "string", value: "api-worker" }],
      api => api.listValues("$metadata.service", "string")],
    ["a query result that is no object", "telemetry.query", "none", api => api.listEvents()],
    ["a query result with no statistics", "telemetry.query", { events: { events: [] } }, api => api.listEvents()],
    ["events that are no list", "telemetry.query", { statistics: STATISTICS, events: { events: "none" } },
      api => api.listEvents()],
    ["an event with no metadata", "telemetry.query",
      { statistics: STATISTICS, events: { events: [{ dataset: "cloudflare-workers", timestamp: 1 }] } },
      api => api.getTrace("trace-id")],
    ["invocations that are a list", "telemetry.query", { statistics: STATISTICS, invocations: [] },
      api => api.listInvocations()],
    ["a trace summary with no id", "telemetry.query", { statistics: STATISTICS, traces: [{ service: [] }] },
      api => api.listTraces()],
    ["a calculation with no series", "telemetry.query",
      { statistics: STATISTICS, calculations: [{ calculation: "count" }] },
      api => api.calculate({ calculations: [{ operator: "count" }] })],
  ])("counts a telemetry answer with %s as an error of the API, and sends it once", async (_row, operation, result, read) => {
    const fetch = respond(json({ success: true, result }));
    const error = await failure(read(telemetry()));

    expect(error).toBeInstanceOf(CloudflareObservabilityApiError);
    expect(error).toMatchObject({
      status: 502, message: "Cloudflare returned an invalid Workers Observability response.", codes: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([[operation, "error", "api", 200]]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  // The rows of `telemetryRetry`: what the first send of a telemetry request met, how many sends
  // the request makes, and the wait before the second.
  it.each<[row: string, first: Answer, sends: number, waitMs: number]>([
    ["a 503 with no Retry-After", status(503), 2, 250],
    ["a 429 with no Retry-After", status(429), 2, 250],
    ["a 502 asking for a second", status(502, { "retry-after": "1" }), 2, 1000],
    ["a 504 asking for the two seconds the budget allows", status(504, { "retry-after": "2" }), 2, 2000],
    ["a 503 asking for no wait", status(503, { "retry-after": "0" }), 2, 0],
    ["a 503 whose Retry-After cannot be read", status(503, { "retry-after": "soon" }), 2, 250],
    ["a 503 asking for a date a second on", status(503, { "retry-after": later(1000) }), 2, 1000],
    ["a 503 asking for a date that is past", status(503, { "retry-after": later(-5000) }), 2, 0],
    ["a 429 asking for longer than the budget", status(429, { "retry-after": "3" }), 1, 0],
    ["a 503 asking for a date past the budget", status(503, { "retry-after": later(30_000) }), 1, 0],
    ["a 500", status(500), 1, 0],
    ["a 403", status(403), 1, 0],
    ["a 400", status(400), 1, 0],
    ["a failure inside a 200", json({ success: false }), 1, 0],
    ["a transport failure", throws(new TypeError("network connection lost")), 2, 125],
    ["a timeout", throws(new DOMException("The operation timed out.", "TimeoutError")), 2, 125],
  ])("sends a telemetry request that met %s %i time(s)", async (_row, first, sends, waitMs) => {
    // A request that got no answer waits a random share of 250 ms: half of it here.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetch = respond(first, json({ success: true, result: [] }));
    const settled = telemetry().listKeys().then(() => "answered", () => "failed");

    await vi.advanceTimersByTimeAsync(Math.max(waitMs - 1, 0));
    expect(fetch).toHaveBeenCalledTimes(waitMs > 0 ? 1 : sends);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBe(sends === 2 ? "answered" : "failed");
    expect(fetch).toHaveBeenCalledTimes(sends);
    expect(points).toHaveLength(sends);
  });

  // The row of `telemetryRetry` for an answer whose body the attempt's own timeout cut off, which
  // is sent again whatever its status, and is counted by that status where it is no success.
  it.each<[row: string, code: number, headers: Record<string, string>, counted: unknown[]]>([
    ["a 200", 200, {}, ["error", "timeout", 200]],
    ["a 500", 500, {}, ["error", "http", 500]],
    ["a 403", 403, {}, ["error", "http", 403]],
  ])("sends a telemetry request again when the timeout cut off the reading of %s", async (_row, code, headers, counted) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const attempt = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(attempt.signal);
    // The first answer's body fails as its attempt's timeout fires.
    const stalled: Answer = () => new Response(new ReadableStream({
      pull(controller) {
        attempt.abort(new DOMException("The operation timed out.", "TimeoutError"));
        controller.error(attempt.signal.reason);
      },
    }), { status: code, headers });
    const fetch = respond(stalled, json({ success: true, result: [] }));
    const settled = telemetry().listKeys();

    await vi.advanceTimersByTimeAsync(124);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls()).toEqual([["telemetry.keys", ...counted], ["telemetry.keys", "success", "", 200]]);
    expect(warned()).toEqual([504]);
  });

  // An answer that asks for a longer wait than the budget is not sent again, whether its body
  // was read or the attempt's own timeout cut the reading off: no send comes before that time.
  it.each<[row: string, code: number, counted: unknown[]]>([
    ["a 200", 200, ["error", "timeout", 200]],
    ["a 503", 503, ["error", "http", 503]],
    ["a 429", 429, ["refused", "rate", 429]],
  ])("sends a telemetry request once when the timeout cut off the reading of %s asking for longer than the budget", async (_row, code, counted) => {
    const attempt = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(attempt.signal);
    const stalled: Answer = () => new Response(new ReadableStream({
      pull(controller) {
        attempt.abort(new DOMException("The operation timed out.", "TimeoutError"));
        controller.error(attempt.signal.reason);
      },
    }), { status: code, headers: { "retry-after": "5" } });
    const fetch = respond(stalled, json({ success: true, result: [] }));
    const settled = telemetry().listKeys().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await settled).toMatchObject({ status: 504 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["telemetry.keys", ...counted]]);
  });

  // Each attempt of a telemetry request that fails is logged, one that the second send recovers
  // from included.
  it.each<[row: string, answers: Answer[], statuses: number[]]>([
    ["a 503 that the second send recovers from", [status(503, { "retry-after": "0" }), json({ success: true, result: [] })], [503]],
    ["a 503 and then a 429", [status(503, { "retry-after": "0" }), status(429, { "retry-after": "0" })], [503, 429]],
    ["a transport failure that the second send recovers from",
      [throws(new TypeError("network connection lost")), json({ success: true, result: [] })], [502]],
    ["two transport failures", [throws(new TypeError("network connection lost"))], [502, 502]],
    ["two timeouts", [throws(new DOMException("The operation timed out.", "TimeoutError"))], [504, 504]],
    ["a 400", [status(400)], [400]],
    ["a failure inside a 200", [json({ success: false, errors: [{ code: 7003, message: "Secret refusal" }] })], [200]],
    ["an answer that cannot be read", [() => new Response("not json")], [502]],
    ["a result", [json({ success: true, result: [] })], []],
  ])("logs each failed attempt of a telemetry request that met %s", async (_row, answers, statuses) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    respond(...answers);
    await telemetry().listKeys().catch(() => undefined);

    expect(warned()).toEqual(statuses);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("Secret refusal");
  });

  it("sends a telemetry request twice at most, and counts both sends", async () => {
    const fetch = respond(status(503, { "retry-after": "0" }), status(429, { "retry-after": "0" }));
    expect(await failure(telemetry().listKeys())).toMatchObject({ status: 429 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls()).toEqual([
      ["telemetry.keys", "error", "http", 503],
      ["telemetry.keys", "refused", "rate", 429],
    ]);
  });

  it("sums the pages of an account listing into one point", async () => {
    respond(accountsPage(50), accountsPage(50), accountsPage(20));
    expect(await listAccounts("secret-token")).toHaveLength(120);

    expect(calls()).toEqual([["accounts.list", "success", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([3]);
  });

  it("sums the pages of a trace into one point", async () => {
    respond(eventsPage(100, 250, 1), eventsPage(100, 250, 2), eventsPage(50, 250, 3));
    const trace = await telemetry().getTrace("trace-id");
    expect(trace.events).toHaveLength(250);

    expect(calls()).toEqual([["telemetry.query", "success", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([3]);
  });

  it("writes nothing an answer, a path or a credential holds", async () => {
    respond(json({ success: false, errors: [{ code: 7003, message: "Secret refusal about api-worker" }] }, { status: 400 }));
    await failure(telemetry().listValues("secret-field", "string", { search: { value: "secret words" } }));
    respond(json({ success: false, errors: [{ message: "Secret refusal" }] }));
    await fetchIdentity("secret-token");

    const written = JSON.stringify(points);
    expect(points).toHaveLength(2);
    for (const secret of [ACCOUNT_ID, "secret", "Secret", "api-worker", "api.cloudflare.com"]) {
      expect(written).not.toContain(secret);
    }
  });
});
