import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, subserviceTally, type BlobSlot, type DoubleSlot,
  type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ID, ONE, type Routes } from "../src/route-operation";
import {
  defineUpstream, recordCall, summedInto, type AnsweredWith, type CallAnswer, type RetryPolicy,
  type Upstream, type UpstreamFetch, type UpstreamRequestInit,
} from "../src/upstream";

const API = "https://api.vendor.example/v1";
const ROUTES: Routes = [[`${API}/`, { threads: { [ID]: { modify: "POST" } }, profile: ONE }]];
const THREAD = `${API}/threads/18c2`;

// The upstream most tests send through, and one with no timeout, whose requests leave no timer.
const upstream = defineUpstream({ vendorId: "vendor", routes: ROUTES });
const untimed = upstream.with({ timeoutMs: null });

const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];
// What happened, in order, in the tests that look at it: a point written is a `count`.
let events: string[];
// The rejections that nothing handled, in the tests that listen for them (`noteUnhandled`).
let unhandled: unknown[];
const noteUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  points = [];
  events = [];
  unhandled = [];
  ambient.METRICS = {
    writeDataPoint: point => {
      if (point) points.push(point);
      events.push("count");
    },
  };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  process.off("unhandledRejection", noteUnhandled);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its service, operation, outcome, reason and HTTP status.
function calls() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
    SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// Each point written, as its outcome, reason and HTTP status alone.
function outcomes() {
  return calls().map(([, , outcome, reason, status]) => [outcome, reason, status]);
}

// One column of each point written.
function columnOf(slot: BlobSlot | DoubleSlot) {
  return points.map(point => column(point, slot));
}

// An answer with a status, asking for no wait before a retry unless told another.
function answer(status: number, body: string = "{}", retryAfter: string = "0"): Response {
  return new Response(body, { status, headers: { "Retry-After": retryAfter } });
}

// A global fetch that gives each of `answers` in turn: a status is an answer with it, an error
// is thrown.
function answering(...answers: (number | Response | Error)[]) {
  const fetch = vi.fn<UpstreamFetch>(async () => {
    events.push("fetch");
    const next = answers.shift();
    if (next === undefined) throw new Error("the test listed no further answer");
    if (next instanceof Error) throw next;
    return typeof next === "number" ? answer(next) : next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A global fetch that is never answered, and fails with its signal's reason once that aborts.
function unanswered() {
  const fetch = vi.fn<UpstreamFetch>((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason));
    }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A global fetch that answers at once with a body that never ends: the body fails with the reason
// of the attempt's signal once that aborts, as the body of a real answer does.
function stalling(status: number = 200) {
  const fetch = vi.fn<UpstreamFetch>(async (_input, init) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    }), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A global fetch that gives each of `answers` in turn, a status, alone or with headers, being an
// answer with it whose body never ends, as those of `stalling` are. It gives the fake clock's
// time at each send.
function stalled(
  ...answers: (number | Response | [status: number, headers: Record<string, string>])[]
): number[] {
  const times: number[] = [];
  vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
    times.push(Date.now());
    const next = answers[times.length - 1];
    if (next === undefined) throw new Error("the test listed no further answer");
    if (next instanceof Response) return next;
    const [status, headers] = typeof next === "number" ? [next, {}] : next;
    const signal = init.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    }), { status, headers });
  });
  return times;
}

// An answer whose body stays open, and whether that body was cancelled.
function open(status: number, headers: Record<string, string> = { "Retry-After": "0" }) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  return { response: new Response(body, { status, headers }), cancelled: () => cancelled };
}

// Makes `AbortSignal.timeout` run on the fake clock, which does not reach the platform's own.
function fakeTimeouts() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

// The init that the `at`th call of a fetch was handed.
function initOf(fetch: { mock: { calls: Parameters<UpstreamFetch>[] } }, at: number = 0): RequestInit {
  const init = fetch.mock.calls[at]?.[1];
  if (!init) throw new Error(`fetch call ${at} was handed no init`);
  return init;
}

// A global fetch that answers its `send`th call with what `answerOf` gives, throwing an error,
// and the fake clock's time at each send.
function sendTimes(answerOf: (send: number) => Response | Error): number[] {
  const times: number[] = [];
  vi.stubGlobal("fetch", async () => {
    times.push(Date.now());
    const next = answerOf(times.length);
    if (next instanceof Error) throw next;
    return next;
  });
  return times;
}

// The milliseconds between each send and the one before it, on the fake clock.
function gaps(times: number[]): number[] {
  return times.slice(1).map((time, at) => time - times[at]);
}

// A Request whose signal has aborted.
function stoppedRequest(): Request {
  return new Request(THREAD, { signal: AbortSignal.abort(new Error("stop")) });
}

// A Request to give for an init, which holds everything but the URL of the request to send.
function givenForInit(method: string): Request {
  return new Request("https://elsewhere.example/", {
    method, headers: { "X-Api": "2" }, body: "payload", redirect: "follow",
  });
}

// A Request that has a body, which is a stream and so is sent once.
function putRequest(): Request {
  return new Request(THREAD, { method: "PUT", body: "payload" });
}

// An answer whose `X-Vendor-Error` header holds `code`, asking for no wait before a retry.
function coded(status: number, body: string, code: string): Response {
  return new Response(body, { status, headers: { "Retry-After": "0", "X-Vendor-Error": code } });
}

// `times` rows like `row`.
function rows<Row>(times: number, row: Row): Row[] {
  return Array.from({ length: times }, () => row);
}

describe("defineUpstream", () => {
  it("names its source after the vendor id", () => {
    expect(upstream.vendorId).toBe("vendor");
    expect(upstream.source).toBe("gatekeeper.vendor.api");
  });

  it.each([
    "", "two words", "https://vendor.example", "vendor/id", "-vendor", "vendor:id", "v".repeat(50),
  ])("refuses the vendor id %j, which is no metric word or makes no source that is one", vendorId => {
    expect(() => defineUpstream({ vendorId })).toThrow("vendorId must be a metric word");
  });

  it("takes a vendor id of 49 characters, whose source is the longest word", () => {
    const longest = defineUpstream({ vendorId: "v".repeat(49) });
    expect(longest.source).toHaveLength(64);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses the timeout %j", timeoutMs => {
    expect(() => defineUpstream({ vendorId: "vendor", timeoutMs })).toThrow("timeoutMs must be");
    expect(() => upstream.with({ timeoutMs })).toThrow("timeoutMs must be");
  });

  it.each<[RetryPolicy, string]>([
    [{ attempts: 0 }, "retry.attempts"],
    [{ attempts: -1 }, "retry.attempts"],
    [{ attempts: 1.5 }, "retry.attempts"],
    [{ attempts: Number.POSITIVE_INFINITY }, "retry.attempts"],
    [{ attempts: Number.NaN }, "retry.attempts"],
    [{ baseDelayMs: -1 }, "retry.baseDelayMs"],
    [{ baseDelayMs: Number.POSITIVE_INFINITY }, "retry.baseDelayMs"],
    [{ maxDelayMs: -1 }, "retry.maxDelayMs"],
    [{ maxDelayMs: Number.NaN }, "retry.maxDelayMs"],
  ])("refuses the retry policy %j", (retry, named) => {
    expect(() => defineUpstream({ vendorId: "vendor", retry })).toThrow(`${named} must be`);
  });

  it("takes no timeout, no retry, and delays of nothing", () => {
    expect(() => defineUpstream({ vendorId: "vendor", timeoutMs: null, retry: null })).not.toThrow();
    expect(() => defineUpstream({
      vendorId: "vendor", retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    })).not.toThrow();
  });

  it("fails a request whose own timeout or retry policy is not valid, sending nothing", async () => {
    const fetch = answering(200, 200);
    await expect(upstream.request(THREAD, { timeoutMs: 0 })).rejects.toThrow("timeoutMs must be");
    await expect(upstream.request(THREAD, { retry: { attempts: 0 } }))
        .rejects.toThrow("retry.attempts must be");
    expect(fetch).not.toHaveBeenCalled();
    expect(points).toEqual([]);
  });
});

describe("names", () => {
  it("names a request by its own operation, then the namer, then the routes, then its method", async () => {
    answering(200, 200, 200, 200, 200, 200);
    const named = upstream.with({
      operation: (method, url) =>
        url.pathname.endsWith("/profile") ? `profile.${method.toLowerCase()}` : undefined,
    });

    await named.request(`${API}/profile`, { operation: "token.exchange" });
    await named.request(`${API}/profile`);
    await named.request(THREAD);
    await named.request(`${THREAD}/modify`, { method: "post" });
    await named.request(`${API}/labels`, { method: "delete" });
    await named.request(`${API}/labels`);

    expect(columnOf(SUBSERVICE_V1_SLOTS.operation)).toEqual([
      "token.exchange", "profile.get", "threads.get", "threads.modify", "DELETE", "GET",
    ]);
  });

  it("names a request to what is no URL by its method, and gives its service function no URL", async () => {
    answering(200, 200);
    const seen: (URL | undefined)[] = [];
    const tabled = upstream.with({
      service: url => {
        seen.push(url);
        return url ? "vendor-api" : "vendor-other";
      },
    });

    await tabled.request("/v1/threads/18c2", { method: "patch" });
    await tabled.request(new URL(THREAD));

    expect(calls()).toEqual([
      ["vendor-other", "PATCH", "success", "", 200],
      ["vendor-api", "threads.get", "success", "", 200],
    ]);
    expect(seen).toEqual([undefined, new URL(THREAD)]);
  });

  it("sends the URL it was given, whatever a namer or a service function does to the one it is given", async () => {
    const fetch = answering(200);
    const paged = new URL(`${THREAD}?page=2`);
    const stripping = upstream.with({
      operation: (_method, url) => {
        url.search = "";
        return undefined;
      },
      service: url => {
        if (url) url.pathname = "/";
        return "vendor-api";
      },
    });

    await stripping.request(paged);

    expect(fetch.mock.calls[0][0]).toBe(paged);
    expect(paged.href).toBe(`${THREAD}?page=2`);
    expect(calls()).toEqual([["vendor-api", "threads.get", "success", "", 200]]);
  });

  it("names by `OTHER` a request whose method is not one of HTTP's own", async () => {
    answering(200, 200);
    await upstream.request(`${API}/labels`, { method: "secret-word" });
    await upstream.request(`${API}/labels`, { method: "options" });
    expect(columnOf(SUBSERVICE_V1_SLOTS.operation)).toEqual(["OTHER", "OPTIONS"]);
    expect(upstream.operationOf("secret-word", "not a url")).toBe("OTHER");
  });

  it("names a Request by its own method and URL", async () => {
    answering(200);
    await upstream.request(new Request(`${THREAD}/modify`, { method: "POST" }));
    expect(columnOf(SUBSERVICE_V1_SLOTS.operation)).toEqual(["threads.modify"]);
  });

  it("counts under the request's service, then the upstream's, then the vendor id", async () => {
    answering(200, 200, 200, 200);
    const literal = upstream.with({ service: "vendor-mail" });

    await literal.request(THREAD, { service: "access" });
    await literal.request(THREAD);
    await upstream.request(THREAD);
    // A service function that throws leaves the vendor id.
    await upstream.with({ service: () => { throw new Error("no table"); } }).request(THREAD);

    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["access", "vendor-mail", "vendor", "vendor"]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(rows(4, "gatekeeper.vendor.api"));
  });

  it("writes no word that a URL, a header, a body, an answer or an error holds", async () => {
    answering(
      new Response("secret-answer", { status: 500, headers: { "X-Request-Id": "secret-header" } }),
      new TypeError(`secret-message for ${THREAD}`),
    );
    const sent = {
      method: "POST", headers: { Authorization: "Bearer secret-token" }, body: "secret-body",
    };

    await upstream.request(`${API}/threads/secret-id/modify?key=secret-query`, sent);
    await expect(upstream.request("https://secret-host.example/secret-path", sent))
        .rejects.toThrow("secret-message");

    expect(points.map(point => point.blobs?.slice(6))).toEqual([
      ["error", "gatekeeper.vendor.api", "vendor", "threads.modify", "http", ""],
      ["error", "gatekeeper.vendor.api", "vendor", "POST", "network", ""],
    ]);
    expect(JSON.stringify(points)).not.toMatch(/secret|example|18c2/);
  });

  describe("operationOf", () => {
    it("names a request as sending it would, and sends nothing", () => {
      const fetch = answering();
      expect(upstream.operationOf("post", `${THREAD}/modify?fields=id`)).toBe("threads.modify");
      expect(upstream.operationOf(undefined, new URL(THREAD))).toBe("threads.get");
      expect(upstream.operationOf("put", `${API}/labels`)).toBe("PUT");
      expect(upstream.operationOf(undefined, "not a url")).toBe("GET");
      expect(fetch).not.toHaveBeenCalled();
      expect(points).toEqual([]);
    });

    it("names by the method a request whose namer throws", () => {
      const throwing = upstream.with({ operation: () => { throw new Error("no name"); } });
      expect(throwing.operationOf("get", THREAD)).toBe("GET");
    });
  });
});

describe("timeout", () => {
  it("gives each attempt a fresh timeout of 30 seconds, and so the whole of it", async () => {
    vi.useFakeTimers();
    const timeouts = fakeTimeouts();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const signals: (AbortSignal | null | undefined)[] = [];
    let sent = 0;
    // The first attempt is never answered. The second is, a second short of its own timeout.
    vi.stubGlobal("fetch", (_input: string, init: RequestInit) => {
      signals.push(init.signal);
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        if (sent++ > 0) setTimeout(() => resolve(answer(200)), 29_000);
      });
    });

    const response = upstream.request(THREAD);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signals).toHaveLength(1);
    // The first attempt times out, and the second is sent after a wait of nothing.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_000);

    expect((await response).status).toBe(200);
    expect(timeouts.mock.calls).toEqual([[30_000], [30_000]]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.map(signal => signal?.aborted)).toEqual([true, false]);
    expect(outcomes()).toEqual([["error", "timeout", 0], ["success", "", 200]]);
  });

  it("takes the upstream's timeout, a request's over it, and none for null", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const fetch = answering(200, 200, 200, 200);
    const quick = upstream.with({ timeoutMs: 5_000 });

    await quick.request(THREAD);
    await quick.request(THREAD, { timeoutMs: 100 });
    await quick.request(THREAD, { timeoutMs: null });
    await untimed.request(THREAD, { timeoutMs: 250 });

    expect(timeouts.mock.calls).toEqual([[5_000], [100], [250]]);
    expect(timeouts.mock.results.map(result => result.value))
        .toEqual([initOf(fetch, 0).signal, initOf(fetch, 1).signal, initOf(fetch, 3).signal]);
    expect("signal" in initOf(fetch, 2)).toBe(false);
  });

  it("fails an attempt that the platform's own timeout cuts off, and counts it a timeout", async () => {
    unanswered();
    await expect(upstream.request(THREAD, { method: "POST", timeoutMs: 5 }))
        .rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls()).toEqual([["vendor", "threads.create", "error", "timeout", 0]]);
  });

  it("hands fetch one signal that aborts with the caller's or with the timeout", async () => {
    vi.useFakeTimers();
    fakeTimeouts();
    const fetch = unanswered();
    const caller = new AbortController();

    const stopped = expect(upstream.request(THREAD, { method: "POST", signal: caller.signal }))
        .rejects.toThrow("stop");
    const timed = expect(upstream.request(THREAD, { method: "POST", signal: new AbortController().signal }))
        .rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(initOf(fetch, 0).signal).not.toBe(caller.signal);
    caller.abort(new Error("stop"));
    await stopped;
    await vi.advanceTimersByTimeAsync(30_000);
    await timed;
  });

  it("hands fetch the caller's own signal where there is no timeout", async () => {
    const fetch = answering(200);
    const caller = new AbortController();
    await untimed.request(THREAD, { signal: caller.signal });
    expect(initOf(fetch).signal).toBe(caller.signal);
  });
});

describe("retry", () => {
  it("sends an idempotent request three times at most, and returns the last answer", async () => {
    const answers = [open(503), open(503), open(503)];
    const fetch = answering(...answers.map(each => each.response));

    const response = await upstream.request(THREAD);

    expect(response).toBe(answers[2].response);
    expect(fetch).toHaveBeenCalledTimes(3);
    // The body of an answer that is retried is cancelled, and the one returned is the caller's.
    expect(answers.map(each => each.cancelled())).toEqual([true, true, false]);
    expect(outcomes()).toEqual(rows(3, ["error", "http", 503]));
  });

  it.each<[string, RetryPolicy | null | undefined, RetryPolicy | null | undefined, number]>([
    ["the upstream's attempts", { attempts: 5 }, undefined, 5],
    ["one attempt", { attempts: 1 }, undefined, 1],
    ["no retry policy", null, undefined, 1],
    ["a request's attempts over the upstream's", { attempts: 5 }, { attempts: 2 }, 2],
    ["no retry policy of a request", { attempts: 5 }, null, 1],
    ["a request's policy over none of the upstream", null, { attempts: 2 }, 2],
    ["the default policy, for a request's empty one over none of the upstream", null, {}, 3],
  ])("sends as often as %s allow", async (_name, ofUpstream, ofRequest, sends) => {
    const fetch = answering(503, 503, 503, 503, 503, 503);
    const response = await upstream.with({ retry: ofUpstream }).request(THREAD, { retry: ofRequest });
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(sends);
    expect(points).toHaveLength(sends);
  });

  it.each([429, 502, 503, 504])("sends again a GET, a HEAD and a marked POST answered %d", async status => {
    const fetch = answering(status, 200, status, 200, status, 200);

    const answers = [
      await upstream.request(THREAD),
      await upstream.request(THREAD, { method: "head" }),
      await upstream.request(THREAD, { method: "POST", body: "{}", idempotent: true }),
    ];

    expect(answers.map(response => response.status)).toEqual([200, 200, 200]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each([400, 401, 404, 408, 500, 501])("sends once a GET answered %d", async status => {
    const fetch = answering(status, 200);
    expect((await upstream.request(THREAD)).status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("sends a %s once, whatever answers or fails it", async method => {
    const fetch = answering(503, 429, new TypeError("network down"), 200);

    const answers = [
      (await upstream.request(THREAD, { method, body: "{}" })).status,
      (await upstream.request(THREAD, { method, idempotent: false })).status,
    ];
    await expect(upstream.request(THREAD, { method })).rejects.toThrow("network down");

    expect(answers).toEqual([503, 429]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sends again an idempotent request that threw, three times at most", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(
      new TypeError("network down"), 200,
      new TypeError("down 1"), new TypeError("down 2"), new TypeError("down 3"), 200,
    );

    expect((await upstream.request(THREAD)).status).toBe(200);
    await expect(upstream.request(THREAD, { method: "POST", idempotent: true })).rejects.toThrow("down 3");

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(calls()).toEqual([
      ["vendor", "threads.get", "error", "network", 0],
      ["vendor", "threads.get", "success", "", 200],
      ...rows(3, ["vendor", "threads.create", "error", "network", 0]),
    ]);
  });

  it.each<[string, () => BodyInit]>([
    ["a string", () => "payload"],
    ["bytes", () => new TextEncoder().encode("payload")],
    ["a buffer", () => new ArrayBuffer(8)],
    ["a blob", () => new Blob(["payload"])],
    ["search params", () => new URLSearchParams({ q: "payload" })],
    ["form data", () => new FormData()],
  ])("sends again a marked request whose body is %s", async (_name, body) => {
    const fetch = answering(503, 200, new TypeError("network down"), 200);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sent = { method: "POST", body: body(), idempotent: true };

    expect((await upstream.request(THREAD, sent)).status).toBe(200);
    expect((await upstream.request(THREAD, sent)).status).toBe(200);

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual(rows(4, sent.body));
  });

  it.each<[string, () => BodyInit]>([
    ["a stream", () => new ReadableStream<Uint8Array>()],
    ["an iterator", () => (function* () { yield new TextEncoder().encode("payload"); })()],
  ])("sends once a marked request whose body is %s, and asks for no replay of it", async (_name, body) => {
    const fetch = answering(503, new TypeError("network down"), 401);
    const replay = vi.fn(() => true);
    const sent = () => ({ method: "POST", body: body(), idempotent: true, replay });

    expect((await upstream.request(THREAD, sent())).status).toBe(503);
    await expect(upstream.request(THREAD, sent())).rejects.toThrow("network down");
    expect((await upstream.request(THREAD, sent())).status).toBe(401);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replay).not.toHaveBeenCalled();
  });

  it("sends once a Request that has a body, and again one that has none", async () => {
    const fetch = answering(503, 503, 200);
    const replay = vi.fn(() => false);

    const put = await upstream.request(
      new Request(THREAD, { method: "PUT", body: "payload" }), { idempotent: true, replay });
    const read = await upstream.request(new Request(THREAD), { replay });

    expect([put.status, read.status]).toEqual([503, 200]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it("sends again a Request whose body the init replaces with one that can be sent again", async () => {
    const fetch = answering(503, 200, 401, 200, 503, 503);
    const retried = putRequest();
    const replayed = putRequest();

    const first = await upstream.request(retried, { body: "replacement", idempotent: true });
    const second = await upstream.request(replayed, {
      body: new URLSearchParams({ q: "replacement" }), replay: reply => reply.status === 401,
    });
    // A `null` gives no body, so the Request's own decides, and a stream is sent once.
    const kept = await upstream.request(putRequest(), { body: null, idempotent: true });
    const streamed = await upstream.request(
      putRequest(), { body: new Blob(["replacement"]).stream(), idempotent: true });

    expect([first.status, second.status, kept.status, streamed.status]).toEqual([200, 200, 503, 503]);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls.slice(0, 2).map(([input]) => input === retried)).toEqual([true, true]);
    expect(fetch.mock.calls.slice(0, 2).map(([, init]) => init?.body)).toEqual(rows(2, "replacement"));
    expect(fetch.mock.calls.slice(2, 4).map(([input]) => input === replayed)).toEqual([true, true]);
    expect(fetch.mock.calls.slice(2, 4).map(([, init]) => String(init?.body))).toEqual(rows(2, "q=replacement"));
    // The body of the Request itself is sent by neither.
    expect([retried.bodyUsed, replayed.bodyUsed]).toEqual([false, false]);
  });

  it("asks the gatekeeper's `retryable` about an answer, a write's included, and not about a throw", async () => {
    const asked: unknown[] = [];
    const lenient = upstream.with({
      retry: {
        retryable: (status, request) => {
          asked.push([status, request]);
          return status === 500;
        },
      },
    });
    const fetch = answering(500, 200, 503, new TypeError("network down"));

    const write = await lenient.request(THREAD, { method: "post", body: "{}" });
    const read = await lenient.request(THREAD);
    await expect(lenient.request(THREAD, { method: "POST" })).rejects.toThrow("network down");

    expect([write.status, read.status]).toEqual([200, 503]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(asked).toEqual([
      [500, { method: "POST", operation: "threads.create", idempotent: false }],
      [200, { method: "POST", operation: "threads.create", idempotent: false }],
      [503, { method: "GET", operation: "threads.get", idempotent: true }],
    ]);
  });

  it("keeps the upstream's `retryable` under a request's own attempts", async () => {
    const lenient = upstream.with({ retry: { attempts: 4, retryable: status => status === 500 } });
    const fetch = answering(500, 500, 500);
    expect((await lenient.request(THREAD, { retry: { attempts: 2 } })).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives `retryable` the answer's headers, by which a rule tells apart two answers of one status", async () => {
    // Sends a 503 again only where it names a wait, and gives up where the wait is a long one.
    const waited = upstream.with({
      retry: {
        retryable: (status, _request, headers) => {
          const wait = headers.get("Retry-After");
          return status === 503 && wait !== null && Number(wait) <= 1;
        },
      },
    });
    const fetch = answering(answer(503, "{}", "0"), answer(503, "{}", "120"), new Response("{}", { status: 503 }));

    const long = await waited.request(THREAD, { method: "POST", body: "{}" });
    const unnamed = await waited.request(THREAD, { method: "POST", body: "{}" });

    expect([long.status, long.headers.get("Retry-After")]).toEqual([503, "120"]);
    expect([unnamed.status, unnamed.headers.get("Retry-After")]).toEqual([503, null]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails a request whose `retryable` throws, its answer counted and its body cancelled", async () => {
    const refused = open(503);
    answering(refused.response);
    const broken = upstream.with({ retry: { retryable: () => { throw new Error("no rule"); } } });

    await expect(broken.request(THREAD)).rejects.toThrow("no rule");

    expect(refused.cancelled()).toBe(true);
    expect(outcomes()).toEqual([["error", "http", 503]]);
  });

  it("sends again without waiting for a body that a hook cloned and left unread", async () => {
    const refused = open(503);
    const expired = open(401);
    const fetch = answering(refused.response, expired.response, 200);

    // A branch of a cloned body is cancelled only once the other is read, which here is never.
    const response = await upstream.request(THREAD, {
      replay: reply => {
        reply.clone();
        return reply.status === 401;
      },
    });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sends again an attempt whose body never ends, waiting for nothing that its `answer` does", async () => {
    const endless = open(503);
    const fetch = answering(endless.response, 200);
    // What code that is not type-checked may give for the hook: one whose answer never comes.
    const pending = vi.fn(() => new Promise<never>(() => {}));

    const response: Response = await Reflect.apply(untimed.request, untimed, [THREAD, { answer: pending }]);

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pending).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual([["error", "http", 503], ["success", "", 200]]);
  });

  it("sends again though the body of the answer cannot be cancelled", async () => {
    const body = new ReadableStream<Uint8Array>();
    vi.spyOn(body, "cancel").mockImplementation(() => { throw new Error("no cancel"); });
    const locked = answer(503);
    locked.body?.getReader();
    const fetch = answering(new Response(body, { status: 503, headers: { "Retry-After": "0" } }), locked, 200);

    const response = await upstream.request(THREAD);

    expect(response.status).toBe(200);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  describe("the wait", () => {
    it.each<[string, RetryPolicy, number]>([
      ["2", {}, 2_000],
      [" 3 ", {}, 3_000],
      ["0", {}, 0],
      ["60", {}, 10_000],
      ["60", { maxDelayMs: 300 }, 300],
      ["9".repeat(400), {}, 10_000],
      // What is neither a count of seconds nor a date leaves the backoff: half of 500 ms.
      ["-5", {}, 250],
      ["1.5", {}, 250],
      ["", {}, 250],
    ])("waits out a Retry-After of %j under %j for %d ms", async (retryAfter, retry, waited) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const times = sendTimes(send => send === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": retryAfter } }) : answer(200));

      const response = untimed.request(THREAD, { retry });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([waited]);
    });

    it.each<[string, string, RetryPolicy, number]>([
      ["a date to come", "Wed, 21 Oct 2026 07:28:04 GMT", {}, 4_000],
      ["a date to come, in spaces", "  Wed, 21 Oct 2026 07:28:04 GMT ", {}, 4_000],
      ["a date past the longest delay", "Wed, 21 Oct 2026 08:28:00 GMT", {}, 10_000],
      ["a date past a policy's longest delay", "Thu, 22 Oct 2026 07:28:00 GMT", { maxDelayMs: 300 }, 300],
      ["the date of the moment", "Wed, 21 Oct 2026 07:28:00 GMT", {}, 0],
      ["a date that is past", "Wed, 21 Oct 2026 07:27:59 GMT", {}, 0],
      ["a date long past", "Sun, 06 Nov 1994 08:49:37 GMT", {}, 0],
      ["a leap day", "Tue, 29 Feb 2028 07:28:04 GMT", {}, 10_000],
      // The two obsolete forms of an HTTP date.
      ["a date in the RFC 850 form", "Wednesday, 21-Oct-26 07:28:04 GMT", {}, 4_000],
      ["an RFC 850 date of a later year of the century", "Monday, 21-Oct-30 07:28:04 GMT", {}, 10_000],
      ["an RFC 850 date of a year more than 50 on, read in the century before",
        "Friday, 21-Oct-77 07:28:04 GMT", {}, 0],
      ["a date in the asctime form", "Wed Oct 21 07:28:04 2026", {}, 4_000],
      ["an asctime date whose day has one digit", "Sun Nov  1 07:28:00 2026", {}, 10_000],
      // The day of the week is not read.
      ["a date under another day of the week", "Mon, 21 Oct 2026 07:28:04 GMT", {}, 4_000],
      // What is no HTTP date leaves the backoff, whatever date it may spell: half of 500 ms.
      ["a date in another form", "2026-10-21T07:28:04Z", {}, 250],
      ["a date with no time", "Wed, 21 Oct 2026", {}, 250],
      ["a date in another zone", "Wed, 21 Oct 2026 07:28:04 +0100", {}, 250],
      ["a date that is none", "Wed, 41 Oct 2026 07:28:04 GMT", {}, 250],
      ["a day that its month does not have", "Tue, 31 Nov 2026 07:28:04 GMT", {}, 250],
      ["a leap day of a year that has none", "Sun, 29 Feb 2026 07:28:04 GMT", {}, 250],
      ["a day of nothing", "Wed, 00 Oct 2026 07:28:04 GMT", {}, 250],
      ["an RFC 850 date with a year of four digits", "Wednesday, 21-Oct-2026 07:28:04 GMT", {}, 250],
      ["an asctime date with a zone", "Wed Oct 21 07:28:04 2026 GMT", {}, 250],
      ["a word", "soon", {}, 250],
      ["a number and a date", "4, Wed, 21 Oct 2026 07:28:04 GMT", {}, 250],
    ])("waits out a Retry-After of %s (%j) under %j for %d ms", async (_name, retryAfter, retry, waited) => {
      vi.useFakeTimers({ now: Date.parse("2026-10-21T07:28:00Z") });
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const times = sendTimes(send => send === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": retryAfter } }) : answer(200));

      const response = untimed.request(THREAD, { retry });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([waited]);
    });

    it("waits out the time left until a Retry-After date when the answer comes", async () => {
      vi.useFakeTimers({ now: Date.parse("2026-10-21T07:28:00Z") });
      const times: number[] = [];
      // The first answer takes three seconds to come, and asks for a retry at a date five on.
      vi.stubGlobal("fetch", async () => {
        times.push(Date.now());
        if (times.length > 1) return answer(200);
        await new Promise(resolve => setTimeout(resolve, 3_000));
        return answer(429, "", "Wed, 21 Oct 2026 07:28:05 GMT");
      });

      const response = untimed.request(THREAD);
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([5_000]);
    });

    it("waits a random share of a ceiling that doubles up to the longest delay", async () => {
      vi.useFakeTimers();
      const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
      const times = sendTimes(() => new Response(null, { status: 503 }));

      const response = untimed.request(THREAD, { retry: { attempts: 7 } });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(503);
      expect(gaps(times)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000]);
      expect(random).toHaveBeenCalledTimes(6);
    });

    it("waits by the delays a policy gives, for an answer and for a throw alike", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const retry = { attempts: 4, baseDelayMs: 100, maxDelayMs: 150 };

      const refused = sendTimes(() => new Response(null, { status: 429 }));
      const answered = untimed.request(THREAD, { retry });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await answered).status).toBe(429);
      expect(gaps(refused)).toEqual([50, 75, 75]);

      const failed = sendTimes(() => new TypeError("network down"));
      const thrown = expect(untimed.request(THREAD, { retry })).rejects.toThrow("network down");
      await vi.advanceTimersByTimeAsync(60_000);
      await thrown;
      expect(gaps(failed)).toEqual([50, 75, 75]);
    });

    it("waits at most as long as a timer takes, whatever the policy and the answer ask for", async () => {
      vi.useFakeTimers();
      const longest = 2 ** 31 - 1;
      const times = sendTimes(send => send === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": "999999999" } }) : answer(200));

      const response = untimed.request(THREAD, { retry: { maxDelayMs: 2 ** 40 } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(times).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(longest);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([longest]);
    });

    it("waits nothing where the random share is nothing", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const times = sendTimes(() => new Response(null, { status: 503 }));

      const response = untimed.request(THREAD);
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(503);
      expect(gaps(times)).toEqual([0, 0]);
    });

    it("waits what the policy's `delayMs` gives for an answer, capped, and as it would without where that is no wait", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const asked: [number, string | null, number][] = [];
      const given = [
        700, 60_000, Number.POSITIVE_INFINITY, -5, Number.NEGATIVE_INFINITY, undefined, Number.NaN,
      ];
      const retry: RetryPolicy = {
        attempts: 9,
        maxDelayMs: 5_000,
        delayMs: (response, sends) => {
          asked.push([response.status, response.headers.get("Retry-After"), sends]);
          if (sends === 8) throw new Error("no wait");
          return given[sends - 1];
        },
      };
      const times = sendTimes(() => new Response(null, { status: 503, headers: { "Retry-After": "2" } }));

      const response = untimed.request(THREAD, { retry });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(503);
      // Its own wait, the longest delay twice, nothing twice, then the Retry-After three times.
      expect(gaps(times)).toEqual([700, 5_000, 5_000, 0, 0, 2_000, 2_000, 2_000]);
      expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(sends => [503, "2", sends]));
    });

    it("gives `delayMs` the attempts of the retry policy, a replay being none of them", async () => {
      vi.useFakeTimers();
      const asked: number[] = [];
      const times = sendTimes(send => answer([401, 503, 401, 503, 200][send - 1] ?? 200));

      const response = untimed.request(THREAD, {
        replay: reply => reply.status === 401,
        retry: {
          retryable: status => status === 503,
          delayMs: (_response, attempts) => {
            asked.push(attempts);
            return 1_000 * attempts;
          },
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(200);
      // Five sends: the two replays wait nothing and count for nothing in the two waits.
      expect(asked).toEqual([1, 2]);
      expect(gaps(times)).toEqual([0, 1_000, 0, 2_000]);
    });

    it("does not ask `delayMs` about an attempt that threw", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const delayMs = vi.fn(() => 4_000);
      const times = sendTimes(send => send === 1 ? new TypeError("network down") : answer(200));

      const response = untimed.request(THREAD, { retry: { delayMs } });
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([250]);
      expect(delayMs).not.toHaveBeenCalled();
    });
  });
});

describe("abort", () => {
  it("hands fetch a request whose caller's signal has aborted, and neither counts nor retries it", async () => {
    const fetch = unanswered();

    await expect(upstream.request(THREAD, { signal: AbortSignal.abort(new Error("stop")) }))
        .rejects.toThrow("stop");
    // A wait that ran out before the request began is no answer the service failed to give.
    await expect(upstream.request(THREAD, {
      signal: AbortSignal.abort(new DOMException("too slow", "TimeoutError")),
    })).rejects.toThrow("too slow");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(points).toEqual([]);
  });

  it("neither counts nor retries a request its caller's signal aborted", async () => {
    const fetch = unanswered();
    const caller = new AbortController();
    const outcome = expect(upstream.request(THREAD, { signal: caller.signal })).rejects.toThrow("stop");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    caller.abort(new Error("stop"));

    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(points).toEqual([]);
  });

  it("counts a request its caller's signal timed out as a timeout, and does not retry it", async () => {
    const fetch = unanswered();
    const wait = new AbortController();
    const outcome = expect(untimed.request(THREAD, { signal: wait.signal })).rejects.toThrow("too slow");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    wait.abort(new DOMException("too slow", "TimeoutError"));

    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["vendor", "threads.get", "error", "timeout", 0]]);
  });

  it("fails with what fetch threw, sent once, when the caller's signal aborted meanwhile", async () => {
    const caller = new AbortController();
    const failure = new TypeError("network down");
    const fetch = vi.fn<UpstreamFetch>(async () => {
      caller.abort(new Error("stop"));
      throw failure;
    });
    vi.stubGlobal("fetch", fetch);

    await expect(upstream.request(THREAD, { signal: caller.signal })).rejects.toBe(failure);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(points).toEqual([]);
  });

  it("takes the signal of a Request for its caller's", async () => {
    const fetch = unanswered();
    const caller = new AbortController();
    const outcome = expect(upstream.request(new Request(THREAD, { signal: caller.signal })))
        .rejects.toThrow("stop");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    caller.abort(new Error("stop"));

    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(points).toEqual([]);
  });

  it("takes the signal of a Request for its caller's where the init's signal is undefined", async () => {
    const fetch = unanswered();
    const caller = new AbortController();
    const outcome = expect(upstream.request(
      new Request(THREAD, { signal: caller.signal }), { signal: undefined })).rejects.toThrow("stop");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    caller.abort(new Error("stop"));

    await outcome;
    expect(points).toEqual([]);
  });

  describe("a Request whose signal the init clears with null", () => {
    it("is handed to fetch with the timeout's signal alone, or with the null given", async () => {
      const fetch = answering(200, 200);

      await upstream.request(stoppedRequest(), { signal: null });
      await untimed.request(stoppedRequest(), { signal: null });

      expect(initOf(fetch).signal).toBeInstanceOf(AbortSignal);
      expect(initOf(fetch).signal?.aborted).toBe(false);
      expect(fetch.mock.calls[1][1]).toEqual({ signal: null, redirect: "manual" });
      expect(outcomes()).toEqual([["success", "", 200], ["success", "", 200]]);
    });

    it("is sent again, and a throw of it counted, though its signal has aborted", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const fetch = answering(503, new TypeError("network down"), 200);

      expect((await upstream.request(stoppedRequest(), { signal: null })).status).toBe(200);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(outcomes()).toEqual([["error", "http", 503], ["error", "network", 0], ["success", "", 200]]);
    });

    it("waits out the wait though its signal aborts meanwhile", async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const times = sendTimes(send => send === 1 ? answer(503, "", "5") : answer(200));

      const response = untimed.request(new Request(THREAD, { signal: caller.signal }), { signal: null });
      await vi.advanceTimersByTimeAsync(1_000);
      caller.abort(new Error("stop"));
      await vi.advanceTimersByTimeAsync(4_000);

      expect((await response).status).toBe(200);
      expect(gaps(times)).toEqual([5_000]);
    });

    it("counts a reading that fails as a malformed answer, and not as one its caller gave up", async () => {
      answering(200);
      await expect(upstream.read(stoppedRequest(), { signal: null }, unparsed)).rejects.toThrow("rejected");
      expect(outcomes()).toEqual([["error", "parse", 200]]);
    });
  });

  it("counts as a network failure a throw with the caller's signal not aborted", async () => {
    answering(new TypeError("network down"));
    await expect(upstream.request(THREAD, { method: "POST", signal: new AbortController().signal }))
        .rejects.toThrow("network down");
    expect(calls()).toEqual([["vendor", "threads.create", "error", "network", 0]]);
  });

  it("ends the wait at once when the caller's signal aborts, and sends nothing more", async () => {
    vi.useFakeTimers();
    const refused = open(503, { "Retry-After": "5" });
    const fetch = answering(refused.response, 200);
    const authorize = vi.fn(() => ({}));
    const caller = new AbortController();

    const outcome = expect(untimed.request(THREAD, { signal: caller.signal, authorize }))
        .rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    caller.abort(new Error("stop"));

    // No time passes: the request has failed by the abort alone, and its timer is gone.
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(refused.cancelled()).toBe(true);
    expect(outcomes()).toEqual([["error", "http", 503]]);
  });

  it("ends the wait after a throw at once when the caller's signal aborts, and sends nothing more", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetch = answering(new TypeError("network down"), 200);
    const caller = new AbortController();

    const outcome = expect(untimed.request(THREAD, {
      signal: caller.signal, retry: { baseDelayMs: 8_000 },
    })).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    caller.abort(new Error("stop"));

    // No time passes: the request has failed by the abort alone, and its timer is gone.
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([["error", "network", 0]]);
  });

  it("does not count an attempt whose caller's wait ran out while its headers were asked for", async () => {
    const fetch = unanswered();
    const wait = new AbortController();

    await expect(upstream.request(THREAD, {
      signal: wait.signal,
      authorize: () => {
        wait.abort(new DOMException("too slow", "TimeoutError"));
        return {};
      },
    })).rejects.toThrow("too slow");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(points).toEqual([]);
  });

  it("sends no replay once the caller's signal has aborted", async () => {
    const fetch = answering(401, 200);
    const authorize = vi.fn(() => ({}));
    const caller = new AbortController();

    await expect(upstream.request(THREAD, {
      signal: caller.signal,
      authorize,
      replay: () => {
        caller.abort(new Error("stop"));
        return true;
      },
    })).rejects.toThrow("stop");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([["error", "http", 401]]);
  });

  it.each<[string, number, UpstreamRequestInit]>([
    ["replay", 401, { replay: response => response.status === 401 }],
    ["retry", 503, {}],
  ])("sends no %s whose headers are asked for as the caller's signal aborts", async (_name, status, init) => {
    // A transport that answers whatever the signal it is handed.
    const fetch = answering(status, 200);
    const caller = new AbortController();
    const stop = new Error("stop");
    let asked = 0;

    await expect(upstream.request(THREAD, {
      ...init,
      signal: caller.signal,
      authorize: async () => {
        // The caller gives up while the headers of the second send are looked up.
        if (++asked === 2) caller.abort(stop);
        return {};
      },
    })).rejects.toBe(stop);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(asked).toBe(2);
    expect(outcomes()).toEqual([["error", "http", status]]);
  });
});

describe("replay", () => {
  it("sends again twice at most, with headers asked anew, whatever the method", async () => {
    const answers = [open(401), open(403), open(401)];
    const fetch = answering(...answers.map(each => each.response));
    let minted = 0;
    const replay = vi.fn(() => true);

    const response = await upstream.request(THREAD, {
      method: "POST",
      body: "payload",
      authorize: () => ({ Authorization: `Bearer token-${++minted}` }),
      replay,
    });

    expect(response).toBe(answers[2].response);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replay.mock.calls).toEqual([[answers[0].response], [answers[1].response]]);
    expect(fetch.mock.calls.map(([, init]) => [new Headers(init?.headers).get("Authorization"), init?.body]))
        .toEqual([["Bearer token-1", "payload"], ["Bearer token-2", "payload"], ["Bearer token-3", "payload"]]);
    expect(answers.map(each => each.cancelled())).toEqual([true, true, false]);
    expect(outcomes()).toEqual([["error", "http", 401], ["error", "http", 403], ["error", "http", 401]]);
  });

  it("uses no attempt of the retry policy", async () => {
    const fetch = answering(401, 403, 503, 503, 200);
    const replay = vi.fn((response: Response) => response.status === 401 || response.status === 403);

    const response = await upstream.request(THREAD, { replay });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(5);
    // Asked about the two it replays and no more.
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it("waits for nothing, whatever wait the answer asks for", async () => {
    vi.useFakeTimers();
    answering(answer(503, "", "60"), answer(429, "", "60"), 200);

    // No time passes on the fake clock: a replay that waited would never be sent.
    const response = await untimed.request(THREAD, { replay: reply => reply.status !== 200 });

    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays a request that has no retry policy", async () => {
    const fetch = answering(401, 200);
    const response = await upstream.request(THREAD, { retry: null, replay: reply => reply.status === 401 });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends twice a write that has no retry policy and whose hook says so once, and once one with no hook", async () => {
    const fetch = answering(503, 200, 503);
    const replay = vi.fn<(reply: Response) => boolean>(() => false).mockReturnValueOnce(true);
    const write = { method: "POST", body: "payload", retry: null };

    const replayed = await upstream.request(THREAD, { ...write, replay });
    const once = await upstream.request(THREAD, write);

    expect([replayed.status, once.status]).toEqual([200, 503]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => [init?.method, init?.body])).toEqual(rows(3, ["POST", "payload"]));
    expect(outcomes()).toEqual([["error", "http", 503], ["success", "", 200], ["error", "http", 503]]);
  });

  it("is asked once the answer is counted, and before the retry policy", async () => {
    answering(503, 200);
    const told = upstream.with({
      retry: {
        retryable: status => {
          events.push(`retryable ${status}`);
          return status === 503;
        },
      },
    });

    await told.request(THREAD, {
      answer: () => {
        events.push("answer");
        return undefined;
      },
      replay: response => {
        events.push(`replay ${response.status}`);
        return false;
      },
    });

    expect(events).toEqual([
      "fetch", "answer", "count", "replay 503", "retryable 503",
      "fetch", "answer", "count", "replay 200", "retryable 200",
    ]);
  });

  it("fails the request when the hook rejects, its answer counted and its body cancelled", async () => {
    const rejected = open(401);
    const fetch = answering(rejected.response, 200);

    await expect(upstream.request(THREAD, {
      replay: async () => { throw new Error("no token"); },
    })).rejects.toThrow("no token");

    expect(rejected.cancelled()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([["error", "http", 401]]);
  });
});

describe("what fetch is handed", () => {
  it("gets the input as given and the caller's init without the client's own options", async () => {
    const fetch = answering(200, 200, 200);
    const headers = { "Content-Type": "application/json" };
    const url = new URL(THREAD);
    const request = new Request(THREAD);

    await untimed.request(THREAD, {
      method: "POST", headers, body: "payload", cf: { cacheTtl: 5 },
      operation: "threads.send", service: "vendor-mail", idempotent: true, timeoutMs: null,
      retry: null, answer: () => undefined, replay: () => false,
    });
    await untimed.request(url);
    await untimed.request(request, {});

    expect(fetch.mock.calls).toEqual([
      [THREAD, { method: "POST", headers, body: "payload", cf: { cacheTtl: 5 }, redirect: "manual" }],
      [url, { redirect: "manual" }],
      [request, { redirect: "manual" }],
    ]);
    expect(initOf(fetch).headers).toBe(headers);
    expect(fetch.mock.calls[1][0]).toBe(url);
    expect(fetch.mock.calls[2][0]).toBe(request);
    expect(calls()[0]).toEqual(["vendor-mail", "threads.send", "success", "", 200]);
  });

  it("gets a signal where there is a timeout, a redirect mode, and nothing else it was not given", async () => {
    const fetch = answering(200);
    await upstream.request(THREAD);
    expect(Object.keys(initOf(fetch))).toEqual(["signal", "redirect"]);
    expect(initOf(fetch).signal).toBeInstanceOf(AbortSignal);
  });

  it("gets the request's redirect mode, else the upstream's, else manual", async () => {
    const fetch = answering(200, 200, 200, 200, 200, 200);
    const manual = untimed.with({ redirect: "manual" });
    const following = untimed.with({ redirect: "follow" });

    await untimed.request(THREAD);
    await untimed.request(THREAD, { redirect: "follow" });
    await manual.request(THREAD);
    await manual.request(THREAD, { redirect: "follow" });
    await following.request(THREAD);
    await following.request(THREAD, { redirect: "manual" });

    expect(fetch.mock.calls.map(([, init]) => init)).toEqual([
      { redirect: "manual" }, { redirect: "follow" }, { redirect: "manual" }, { redirect: "follow" },
      { redirect: "follow" }, { redirect: "manual" },
    ]);
  });

  it("takes a `RequestInit` for a request's init, whatever redirect mode it declares", async () => {
    const fetch = answering(302, 302, 302);
    const init: RequestInit = { method: "POST", redirect: "manual" };
    const other: RequestInit = { redirect: "error" };

    await untimed.request(THREAD, init);
    expect(await untimed.read(THREAD, { ...init, idempotent: true }, statusOf)).toBe(302);
    await untimed.request(THREAD, other);

    expect(fetch.mock.calls.map(([, sent]) => sent)).toEqual([init, init, other]);
    // Only `"manual"` is a mode that follows no redirects.
    expect(outcomes()).toEqual([["error", "http", 302], ["error", "http", 302], ["success", "", 302]]);
  });

  it("reads a Request given for the init by property", async () => {
    const fetch = answering(200, 200);
    const given = givenForInit("PUT");

    await untimed.request(THREAD, given);
    await untimed.request(THREAD, new Request("https://elsewhere.example/", { redirect: "error" }));

    const sent = initOf(fetch);
    expect(fetch.mock.calls[0][0]).toBe(THREAD);
    // The `follow` a Request holds is no declaration: the upstream's mode stands.
    expect([sent.method, sent.redirect]).toEqual(["PUT", "manual"]);
    expect(sent.headers).toBe(given.headers);
    expect(sent.body).toBe(given.body);
    expect(sent.signal).toBe(given.signal);
    expect([initOf(fetch, 1).method, initOf(fetch, 1).redirect]).toEqual(["GET", "error"]);
    // The request is named and counted by what the init holds, its redirect mode included.
    expect(calls()).toEqual([
      ["vendor", "threads.update", "success", "", 200], ["vendor", "threads.get", "success", "", 200],
    ]);
  });

  it("reads by property what an init holds as no enumerable property of its own", async () => {
    const fetch = answering(302, 200);
    const headers = new Headers({ Accept: "text/plain" });
    // A member behind a prototype's getter, one that is not enumerable, and one that is undefined.
    class Draft {
      body = "payload";
      get method() { return "post"; }
      get headers() { return headers; }
      get cache() { return undefined; }
    }
    const hidden = Object.defineProperty({ method: "DELETE" }, "redirect", { value: "manual" });

    await untimed.request(THREAD, new Draft());
    await untimed.request(THREAD, hidden);

    expect(fetch.mock.calls.map(([, init]) => init)).toEqual([
      { body: "payload", method: "post", headers, redirect: "manual" },
      { method: "DELETE", redirect: "manual" },
    ]);
    expect(Object.keys(initOf(fetch))).toEqual(["body", "method", "headers", "redirect"]);
    expect(initOf(fetch).headers).toBe(headers);
    expect(calls()).toEqual([
      ["vendor", "threads.create", "error", "http", 302], ["vendor", "threads.delete", "success", "", 200],
    ]);
  });

  it("hands on the `follow` that an init declares behind a getter, and not the one a Request holds", async () => {
    const fetch = answering(302, 302, 302, 302);
    class Following {
      get redirect(): RequestInit["redirect"] { return "follow"; }
    }
    const held = new Request("https://elsewhere.example/");

    await untimed.request(THREAD, new Following());
    await untimed.fetcher()(THREAD, new Following());
    await untimed.request(THREAD, held);
    await untimed.fetcher()(THREAD, held);

    expect(held.redirect).toBe("follow");
    expect(fetch.mock.calls.map(([, init]) => init?.redirect)).toEqual(["follow", "follow", "manual", "manual"]);
    expect(initOf(fetch)).toEqual({ redirect: "follow" });
    expect(outcomes()).toEqual([
      ["success", "", 302], ["success", "", 302], ["error", "http", 302], ["error", "http", 302],
    ]);
  });

  it("sends once a request whose init is a Request that has a body, and again one that has none", async () => {
    const fetch = answering(503, 503, 200);

    const put = await upstream.request(THREAD, Object.assign(
      new Request("https://elsewhere.example/", { method: "PUT", body: "payload" }), { idempotent: true }));
    const read = await upstream.request(THREAD, new Request("https://elsewhere.example/"));

    expect([put.status, read.status]).toEqual([503, 200]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gets the headers of `authorize` set over the request's, asked anew for each attempt", async () => {
    const fetch = answering(503, 200);
    let minted = 0;
    const authorize = vi.fn(async () => ({ Authorization: `Bearer token-${++minted}`, "X-Api": "2" }));

    await untimed.request(THREAD, { headers: { Accept: "text/plain", "x-api": "1" }, authorize });

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([expect.any(Headers), expect.any(Headers)]);
    expect(fetch.mock.calls.map(([, init]) => Object.fromEntries(new Headers(init?.headers)))).toEqual([
      { accept: "text/plain", authorization: "Bearer token-1", "x-api": "2" },
      { accept: "text/plain", authorization: "Bearer token-2", "x-api": "2" },
    ]);
    expect(Object.keys(initOf(fetch))).toEqual(["headers", "redirect"]);
  });

  it("gets the headers of `authorize` set over a Request's own", async () => {
    const fetch = answering(200);
    await untimed.request(new Request(THREAD, { headers: { Accept: "text/plain" } }), {
      authorize: () => new Headers({ Authorization: "Bearer token" }),
    });
    expect(Object.fromEntries(new Headers(initOf(fetch).headers)))
        .toEqual({ accept: "text/plain", authorization: "Bearer token" });
  });

  it("fails a request whose `authorize` rejects, sending and counting nothing", async () => {
    const fetch = answering(200);
    await expect(upstream.request(THREAD, { authorize: async () => { throw new Error("no token"); } }))
        .rejects.toThrow("no token");
    expect(fetch).not.toHaveBeenCalled();
    expect(points).toEqual([]);
  });

  it("is the upstream's own fetch where it has one, and the global one of the moment otherwise", async () => {
    const first = answering(503);
    const own = vi.fn<UpstreamFetch>(async () => answer(202));
    // The global fetch is replaced between the two attempts of one request.
    first.mockImplementationOnce(async () => {
      vi.stubGlobal("fetch", async () => answer(201));
      return answer(503);
    });

    expect((await upstream.request(THREAD)).status).toBe(201);
    expect((await upstream.with({ fetch: own }).request(THREAD)).status).toBe(202);

    expect(first).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
  });
});

describe("counting", () => {
  it("counts every attempt once, with its status and how long it took to answer", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const statuses = [429, 503, 200];
    vi.stubGlobal("fetch", async () => {
      now += 250;
      return answer(statuses.shift() ?? 500);
    });

    const response = await upstream.request(THREAD);

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["vendor", "threads.get", "refused", "rate", 429],
      ["vendor", "threads.get", "error", "http", 503],
      ["vendor", "threads.get", "success", "", 200],
    ]);
    expect(columnOf(COMMON_SLOTS.durationMs)).toEqual([250, 250, 250]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([1, 1, 1]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(rows(3, "gatekeeper.vendor.api"));
  });

  it("counts a throw with how long it took", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async () => {
      now += 400;
      throw new TypeError("network down");
    });

    await expect(upstream.request(THREAD, { method: "POST" })).rejects.toThrow("network down");

    expect(outcomes()).toEqual([["error", "network", 0]]);
    expect(columnOf(COMMON_SLOTS.durationMs)).toEqual([400]);
  });

  it("counts an answer below 400 a success where redirects are followed", async () => {
    answering(200, 302, 399, 400, 404, 500);
    const following = upstream.with({ redirect: "follow" });
    for (let sent = 0; sent < 6; sent++) await following.request(THREAD, { method: "POST" });
    expect(outcomes()).toEqual([
      ["success", "", 200], ["success", "", 302], ["success", "", 399],
      ["error", "http", 400], ["error", "http", 404], ["error", "http", 500],
    ]);
  });

  it("counts an answer below 300 a success where redirects are not followed", async () => {
    answering(299, 302, 308, 299, 302, 302);
    const manual = upstream.with({ redirect: "manual" });

    // An upstream that declares no mode follows no redirects.
    await upstream.request(THREAD);
    await upstream.request(THREAD);
    await manual.request(THREAD);
    await manual.request(THREAD);
    await manual.request(THREAD);
    // A request that follows redirects, of an upstream that does not.
    await manual.request(THREAD, { redirect: "follow" });

    expect(outcomes()).toEqual([
      ["success", "", 299], ["error", "http", 302], ["error", "http", 308],
      ["success", "", 299], ["error", "http", 302], ["success", "", 302],
    ]);
  });

  it("hands a Request input the request's or the upstream's redirect mode, whatever its own", async () => {
    const fetch = answering(302, 302, 302);

    await untimed.request(new Request(THREAD, { redirect: "follow" }));
    await untimed.request(new Request(THREAD), { redirect: "follow" });
    await untimed.with({ redirect: "follow" }).request(new Request(THREAD, { redirect: "manual" }));

    expect(fetch.mock.calls.map(([, init]) => init))
        .toEqual([{ redirect: "manual" }, { redirect: "follow" }, { redirect: "follow" }]);
    expect(outcomes()).toEqual([["error", "http", 302], ["success", "", 302], ["success", "", 302]]);
  });

  it("counts by the gatekeeper's `succeeded`, asked with the status and the operation", async () => {
    answering(499, 499, 308, 429);
    const cancelling = upstream.with({
      succeeded: (status, operation) =>
        status < 400 || (status === 499 && operation === "upload.cancel") || status === 429,
    });

    await cancelling.request(THREAD, { method: "DELETE", operation: "upload.cancel" });
    await cancelling.request(THREAD, { method: "DELETE", operation: "upload.send" });
    await cancelling.request(THREAD, { method: "PUT", redirect: "manual" });
    await cancelling.request(THREAD, { method: "PUT" });

    expect(calls()).toEqual([
      ["vendor", "upload.cancel", "success", "", 499],
      ["vendor", "upload.send", "error", "http", 499],
      ["vendor", "threads.update", "success", "", 308],
      ["vendor", "threads.update", "success", "", 429],
    ]);
  });

  it("counts by the default a status its `succeeded` throws on", async () => {
    answering(200, 404);
    const broken = upstream.with({ succeeded: () => { throw new Error("no rule"); } });
    expect((await broken.request(THREAD)).status).toBe(200);
    expect((await broken.request(THREAD)).status).toBe(404);
    expect(outcomes()).toEqual([["success", "", 200], ["error", "http", 404]]);
  });

  it("counts by the default a status whose `succeeded` returns what is no boolean, and leaves no rejection unhandled", async () => {
    answering(500, 500, 404, 200);
    process.on("unhandledRejection", noteUnhandled);
    // What code that is not type-checked may give for the hook: an async function, or one that
    // returns a word or a number.
    for (const succeeded of [async () => true, rejecting, () => "yes", () => 0]) {
      const ruled: Upstream = Reflect.apply(upstream.with, upstream, [{ succeeded }]);
      await ruled.request(THREAD);
    }
    // A rejection that nothing handles is reported once the microtasks have run.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
    expect(outcomes()).toEqual([
      ["error", "http", 500], ["error", "http", 500], ["error", "http", 404], ["success", "", 200],
    ]);
  });

  it("counts an answer by the request's `answer`, asked for every attempt with its status and headers", async () => {
    answering(coded(503, "busy", "busy"), coded(200, "quota", "quota"), answer(200, "fine"));
    const seen: number[] = [];
    const quota = (answered: AnsweredWith): CallAnswer | undefined => {
      seen.push(answered.status);
      const code = answered.headers.get("X-Vendor-Error");
      if (code === "busy") return { outcome: "refused", reason: "busy" };
      return code === "quota"
        ? { outcome: "error", reason: "api", detail: "quota", providerCode: 17 } : undefined;
    };

    const over = await upstream.request(THREAD, { answer: quota });
    const fine = await upstream.request(THREAD, { answer: quota });

    // The hook reads no body: the answer is the caller's to read.
    expect([over.bodyUsed, fine.bodyUsed]).toEqual([false, false]);
    expect([await over.text(), await fine.text()]).toEqual(["quota", "fine"]);
    expect(seen).toEqual([503, 200, 200]);
    expect(points.map(point => [
      COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.detail,
      SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.providerCode,
    ].map(slot => column(point, slot)))).toEqual([
      ["refused", "busy", "", 503, 0],
      ["error", "api", "quota", 200, 17],
      ["success", "", "", 200, 0],
    ]);
  });

  it("gives the request's `answer` the status and a copy of the headers, and no body to read or lock", async () => {
    const answers = [answer(200, "read"), answer(200, "requested")];
    answering(...answers);
    const seen: AnsweredWith[] = [];
    const init = {
      answer: (answered: AnsweredWith): CallAnswer => {
        seen.push(answered);
        // What code that is not type-checked may do with an answer: take a reader of its body.
        const body: unknown = Reflect.get(answered, "body");
        if (body instanceof ReadableStream) body.getReader();
        return { outcome: "refused", reason: "busy" };
      },
    };

    const text = await upstream.read(THREAD, init, bodyText);
    const response = await upstream.request(THREAD, init);

    expect(seen.map(answered => Reflect.ownKeys(answered).toSorted())).toEqual(rows(2, ["headers", "status"]));
    for (const answered of seen) expect(Object.getPrototypeOf(answered)).toBe(Object.prototype);
    expect(seen.map(answered => answered.status)).toEqual([200, 200]);
    for (const [at, answered] of seen.entries()) {
      expect(answered.headers).not.toBe(answers[at].headers);
      expect([...answered.headers]).toEqual([...answers[at].headers]);
    }
    // The body is left to `parse`, and to the caller of `request`.
    expect(text).toBe("read");
    expect(response.body?.locked).toBe(false);
    expect(await response.text()).toBe("requested");
    expect(outcomes()).toEqual(rows(2, ["refused", "busy", 200]));
  });

  it("sends nothing again, and answers no other headers, for what `answer` does to the headers it is given", async () => {
    const refused = new Response("{}", { status: 503 });
    const fetch = answering(refused);

    const response = await upstream.request(THREAD, {
      // A rule that sends again only an answer that names its wait.
      retry: { retryable: (_status, _request, headers) => headers.has("Retry-After") },
      answer: answered => {
        answered.headers.set("Retry-After", "0");
        return undefined;
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response).toBe(refused);
    expect(response.headers.has("Retry-After")).toBe(false);
  });

  it("counts by the status an answer whose `answer` throws, or returns what is no answer", async () => {
    answering(200, 404, 200);
    const extra = { outcome: "error", source: "elsewhere", operation: "other", httpStatus: 599 };

    await upstream.request(THREAD, { answer: () => { throw new Error("no rule"); } });
    // What code that is not type-checked may give for the hook: one that rejects.
    await Reflect.apply(upstream.request, upstream, [
      THREAD, { answer: async () => { throw new Error("no rule"); } },
    ]);
    // Only the members of an answer are read: no other column is the hook's to set.
    await upstream.request(THREAD, { answer: (): CallAnswer => extra as CallAnswer });

    expect(calls()).toEqual([
      ["vendor", "threads.get", "success", "", 200],
      ["vendor", "threads.get", "error", "http", 404],
      ["vendor", "threads.get", "error", "", 200],
    ]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(rows(3, "gatekeeper.vendor.api"));
  });

  it("counts by the status an answer whose hook returns what is no answer", async () => {
    answering(404, 200, 200, 200);
    const error = { outcome: "error", reason: "api" };

    // What code that is not type-checked may return: a word, an object with no outcome, a promise.
    await Reflect.apply(upstream.request, upstream, [THREAD, { answer: () => "refused" }]);
    await Reflect.apply(upstream.request, upstream, [THREAD, { answer: () => ({ reason: "api" }) }]);
    await Reflect.apply(upstream.read, upstream, [THREAD, undefined, statusOf, async () => error]);
    await Reflect.apply(upstream.call, upstream, ["command", () => "done", { answer: () => 7 }]);

    expect(calls()).toEqual([
      ["vendor", "threads.get", "error", "http", 404],
      ["vendor", "threads.get", "success", "", 200],
      ["vendor", "threads.get", "success", "", 200],
      ["vendor", "command", "success", "", 0],
    ]);
  });

  it("counts by the status an answer whose hook returns a promise, and leaves no rejection unhandled", async () => {
    answering(200, 404, 200, 200);
    process.on("unhandledRejection", noteUnhandled);
    const error = { outcome: "error", reason: "api" };

    // What code that is not type-checked may give for a hook: an async function.
    await Reflect.apply(upstream.request, upstream, [THREAD, { answer: async () => error }]);
    await Reflect.apply(upstream.request, upstream, [THREAD, { answer: rejecting }]);
    await Reflect.apply(upstream.read, upstream, [THREAD, undefined, statusOf, rejecting]);
    await Reflect.apply(upstream.call, upstream, ["command", () => "done", { answer: rejecting }]);
    // A rejection that nothing handles is reported once the microtasks have run.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
    expect(calls()).toEqual([
      ["vendor", "threads.get", "success", "", 200],
      ["vendor", "threads.get", "error", "http", 404],
      ["vendor", "threads.get", "success", "", 200],
      ["vendor", "command", "success", "", 0],
    ]);
  });

  it("counts how long the answer took, the asking of `answer` left out", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async () => {
      now += 250;
      return answer(200);
    });

    await upstream.request(THREAD, {
      answer: () => {
        now += 4_000;
        return undefined;
      },
    });

    expect(columnOf(COMMON_SLOTS.durationMs)).toEqual([250]);
  });

  describe("an attempt that threw, under the upstream's `thrown`", () => {
    const refusal = new Error("the guard refused the request");

    it("is neither counted nor made again where it answers null", async () => {
      vi.useFakeTimers();
      const guard = vi.fn<UpstreamFetch>(async () => { throw refusal; });
      const thrown = vi.fn((error: unknown) => error === refusal ? null : undefined);
      const guarded = untimed.with({ fetch: guard, thrown });

      // No time passes: a request that waited to be sent again would not have failed yet.
      await expect(guarded.request(THREAD)).rejects.toBe(refusal);
      await expect(guarded.read(THREAD, { method: "POST" }, statusOf)).rejects.toBe(refusal);

      expect(guard).toHaveBeenCalledTimes(2);
      expect(thrown.mock.calls).toEqual([[refusal], [refusal]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(points).toEqual([]);
    });

    it("is counted as it answers, and made again as any other", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const fetch = answering(new TypeError("reset 1"), new TypeError("reset 2"), new TypeError("reset 3"));
      const reset = upstream.with({ thrown: () => ({ outcome: "refused", reason: "reset" }) });

      await expect(reset.request(THREAD)).rejects.toThrow("reset 3");

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(outcomes()).toEqual(rows(3, ["refused", "reset", 0]));
    });

    it("is a network error or a timeout where it answers nothing or throws", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const fetch = answering(new TypeError("network down"), 200, new TypeError("network down"));
      unanswered();
      const silent = upstream.with({ thrown: () => undefined });
      const broken = upstream.with({ fetch, thrown: () => { throw new Error("no rule"); } });

      await expect(silent.request(THREAD, { method: "POST", timeoutMs: 5 }))
          .rejects.toMatchObject({ name: "TimeoutError" });
      expect((await broken.request(THREAD)).status).toBe(200);
      await expect(broken.request(THREAD, { method: "POST" })).rejects.toThrow("network down");

      expect(outcomes()).toEqual([
        ["error", "timeout", 0], ["error", "network", 0], ["success", "", 200], ["error", "network", 0],
      ]);
    });

    it("is not asked about an attempt its caller's signal aborted", async () => {
      const fetch = unanswered();
      const thrown = vi.fn(() => ({ outcome: "error" as const, reason: "guard" }));
      const caller = new AbortController();
      const outcome = expect(upstream.with({ thrown }).request(THREAD, { signal: caller.signal }))
          .rejects.toThrow("stop");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      caller.abort(new Error("stop"));

      await outcome;
      expect(thrown).not.toHaveBeenCalled();
      expect(points).toEqual([]);
    });
  });

  it("writes nothing with the variable off or the dataset unbound, and answers the same", async () => {
    vi.stubGlobal("fetch", async () => new Response("answer", { status: 404 }));
    const on = await upstream.request(THREAD);
    expect(calls()).toEqual([["vendor", "threads.get", "error", "http", 404]]);

    ambient.SUBSERVICE_METRICS = "false";
    const off = await upstream.request(THREAD);
    ambient.SUBSERVICE_METRICS = "true";
    delete ambient.METRICS;
    const unbound = await upstream.request(THREAD);

    expect(points).toHaveLength(1);
    const answered = [on.status, await on.text()];
    for (const other of [off, unbound]) expect([other.status, await other.text()]).toEqual(answered);
  });

  it("answers, or fails as it would have, a request that could not be counted", async () => {
    const broken: SubserviceTally = { add() { throw new Error("no room"); }, flush() {} };
    const failure = new TypeError("network down");
    answering(200, failure, 200, 200);

    const response = await summedInto(broken, () => upstream.request(THREAD));
    const thrown = summedInto(broken, () => upstream.request(THREAD, { method: "POST" }));
    await expect(thrown).rejects.toBe(failure);
    expect(response.status).toBe(200);
    expect(await summedInto(broken, () => upstream.read(THREAD, undefined, () => "parsed")))
        .toBe("parsed");
    expect(await summedInto(broken, () => upstream.call("command", () => "done"))).toBe("done");
    expect(() => summedInto(broken, () => recordCall(CALL))).not.toThrow();
  });

  it("answers the same when the dataset refuses the write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ambient.METRICS = { writeDataPoint() { throw new Error("dataset down"); } };
    answering(answer(200, "answer"));

    const response = await upstream.request(THREAD);

    expect([response.status, await response.text()]).toEqual([200, "answer"]);
  });
});

// What the sample service answers, an error inside a success included, and how such a one counts.
type Body = { ok: boolean; code?: number };
const parseBody = (response: Response) => response.json<Body>();
const failedBody = (parsed: Body): CallAnswer | undefined =>
  parsed.ok ? undefined : { outcome: "error", reason: "api", providerCode: parsed.code };
const refusedBody = (result: Body): CallAnswer | undefined => result.ok ? undefined : {
  outcome: "refused", reason: "quota", detail: "daily", providerCode: result.code,
};
const statusOf = (response: Response) => response.status;
const bodyText = (response: Response) => response.text();
const unparsed = (): never => { throw new Error("rejected"); };
// A hook that answers with a promise, which rejects.
const rejecting = async (): Promise<never> => { throw new Error("no rule"); };

describe("read", () => {
  it("counts an error inside a 200 by what was parsed, and returns it", async () => {
    answering(answer(200, `{"ok":false,"code":17}`), answer(200, `{"ok":true}`));

    expect(await upstream.read(`${THREAD}/modify`, { method: "POST" }, parseBody, failedBody))
        .toEqual({ ok: false, code: 17 });
    expect(await upstream.read(THREAD, undefined, parseBody, failedBody)).toEqual({ ok: true });

    expect(calls()).toEqual([
      ["vendor", "threads.modify", "error", "api", 200],
      ["vendor", "threads.get", "success", "", 200],
    ]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.providerCode)).toEqual([17, 0]);
  });

  it("gives `answer` the parsed value and the answer, and counts once the parsing is done", async () => {
    const last = answer(200, "payload");
    answering(503, last);
    const seen: unknown[] = [];

    const text = await upstream.read(THREAD, undefined, async response => {
      events.push("parse");
      return response.text();
    }, (parsed, response) => {
      events.push("answer");
      seen.push(parsed, response);
      return undefined;
    });

    expect(text).toBe("payload");
    expect(seen).toEqual(["payload", last]);
    expect(seen[1]).toBe(last);
    // The attempt before the last is counted as `request` counts it: when it is answered.
    expect(events).toEqual(["fetch", "count", "fetch", "parse", "answer", "count"]);
    expect(outcomes()).toEqual([["error", "http", 503], ["success", "", 200]]);
  });

  it("counts by its status an answer whose `answer` returns nothing or throws", async () => {
    answering(200, 404, 429);

    expect(await upstream.read(THREAD, { retry: null }, statusOf)).toBe(200);
    expect(await upstream.read(THREAD, { retry: null }, statusOf, () => undefined)).toBe(404);
    expect(await upstream.read(THREAD, { retry: null }, statusOf, () => { throw new Error("no rule"); }))
        .toBe(429);

    expect(outcomes()).toEqual([["success", "", 200], ["error", "http", 404], ["refused", "rate", 429]]);
  });

  it("counts by the request's own `answer` what the parsed one leaves to it", async () => {
    answering(200, 200);
    const init = { answer: (): CallAnswer => ({ outcome: "refused", reason: "busy" }) };

    await upstream.read(THREAD, init, () => "parsed");
    await upstream.read(THREAD, init, () => "parsed", () => ({ outcome: "error", reason: "api" }));

    expect(outcomes()).toEqual([["refused", "busy", 200], ["error", "api", 200]]);
  });

  it("counts a success that cannot be parsed as a parse error, and fails with what `parse` threw", async () => {
    const unread = open(200);
    answering(unread.response, 200);
    const failure = new SyntaxError("not json");

    await expect(upstream.read(THREAD, undefined, () => { throw failure; })).rejects.toBe(failure);
    await expect(upstream.read(THREAD, undefined, async () => { throw failure; }, () => undefined))
        .rejects.toBe(failure);

    expect(outcomes()).toEqual([["error", "parse", 200], ["error", "parse", 200]]);
    expect(unread.cancelled()).toBe(true);
  });

  it("counts by its status a failure that cannot be parsed", async () => {
    answering(404, 429, 302);

    await expect(upstream.read(THREAD, { retry: null }, unparsed)).rejects.toThrow("rejected");
    await expect(upstream.read(THREAD, { retry: null }, unparsed)).rejects.toThrow("rejected");
    await expect(upstream.read(THREAD, { retry: null, redirect: "manual" }, unparsed))
        .rejects.toThrow("rejected");

    expect(outcomes()).toEqual([["error", "http", 404], ["refused", "rate", 429], ["error", "http", 302]]);
  });

  it("cancels what is left of a failure that cannot be parsed", async () => {
    const missing = open(404);
    answering(missing.response);

    await expect(upstream.read(THREAD, undefined, unparsed)).rejects.toThrow("rejected");

    expect(missing.cancelled()).toBe(true);
  });

  it("fails with what `parse` threw though the body cannot be cancelled", async () => {
    const body = new ReadableStream<Uint8Array>();
    vi.spyOn(body, "cancel").mockImplementation(() => { throw new Error("no cancel"); });
    answering(new Response(body), answer(200, "payload"));
    const failure = new SyntaxError("not json");

    await expect(upstream.read(THREAD, undefined, () => { throw failure; })).rejects.toBe(failure);
    // A body that `parse` holds a reader of is locked: its cancelling rejects.
    await expect(upstream.read(THREAD, undefined, response => {
      response.body?.getReader();
      throw failure;
    })).rejects.toBe(failure);

    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([["error", "parse", 200], ["error", "parse", 200]]);
  });

  it("fails at once with what `parse` threw where it cloned the answer and left the clone unread", async () => {
    answering(open(200).response);
    const failure = new SyntaxError("not json");

    await expect(upstream.read(THREAD, undefined, response => {
      response.clone();
      throw failure;
    })).rejects.toBe(failure);

    expect(outcomes()).toEqual([["error", "parse", 200]]);
  });

  describe("a success whose reading is cut off", () => {
    it("is counted a timeout where the attempt's timeout fires, and not a malformed answer", async () => {
      stalling();

      await expect(upstream.read(THREAD, { method: "POST", timeoutMs: 20 }, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });

      expect(calls()).toEqual([["vendor", "threads.create", "error", "timeout", 200]]);
    });

    it("is counted a timeout where the caller's signal aborts with a TimeoutError", async () => {
      stalling();
      const wait = new AbortController();

      await expect(untimed.read(THREAD, { signal: wait.signal }, response => {
        const read = response.text();
        wait.abort(new DOMException("too slow", "TimeoutError"));
        return read;
      })).rejects.toThrow("too slow");

      expect(outcomes()).toEqual([["error", "timeout", 200]]);
    });

    it("is not counted where the caller's signal aborts for any other reason", async () => {
      stalling();
      const stop = new Error("stop");

      // With a timeout of its own that has not fired, and with none.
      for (const sender of [upstream, untimed]) {
        const caller = new AbortController();
        await expect(sender.read(THREAD, { signal: caller.signal }, response => {
          const read = bodyText(response);
          caller.abort(stop);
          return read;
        })).rejects.toBe(stop);
      }

      expect(points).toEqual([]);
    });

    it("is counted by its status where that is no success, however the reading ended", async () => {
      stalling(404);
      const caller = new AbortController();

      await expect(upstream.read(THREAD, { signal: caller.signal, retry: null }, response => {
        const read = response.text();
        caller.abort(new Error("stop"));
        return read;
      })).rejects.toThrow("stop");
      await expect(upstream.read(THREAD, { retry: null, timeoutMs: 20 }, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });

      expect(outcomes()).toEqual([["error", "http", 404], ["error", "http", 404]]);
    });

    it("leaves a request, which reads no body, a success", async () => {
      stalling();
      const caller = new AbortController();

      const response = await upstream.request(THREAD, { signal: caller.signal });
      caller.abort(new Error("stop"));

      await expect(response.text()).rejects.toThrow("stop");
      expect(outcomes()).toEqual([["success", "", 200]]);
    });
  });

  describe("an answer whose reading the attempt's own timeout cuts off", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      fakeTimeouts();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    it("is counted a timeout and a GET sent again after the wait of a throw, the new answer parsed", async () => {
      const times = stalled(200, answer(200, "payload"));
      const parse = vi.fn(bodyText);

      const text = upstream.read(THREAD, undefined, parse);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(times).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);

      expect(await text).toBe("payload");
      // Half of the first backoff ceiling, as after an attempt that threw.
      expect(gaps(times)).toEqual([30_250]);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(calls()).toEqual([
        ["vendor", "threads.get", "error", "timeout", 200], ["vendor", "threads.get", "success", "", 200],
      ]);
    });

    it("sends again a marked write whose body can be sent again, and counts the last by what was parsed", async () => {
      const times = stalled(200, answer(200, `{"ok":false,"code":17}`));

      const body = upstream.read(
        THREAD, { method: "POST", body: "{}", idempotent: true }, parseBody, failedBody);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(await body).toEqual({ ok: false, code: 17 });
      expect(times).toHaveLength(2);
      expect(outcomes()).toEqual([["error", "timeout", 200], ["error", "api", 200]]);
    });

    it.each<[string, RequestInit & { idempotent?: boolean; retry?: null }]>([
      ["a POST", { method: "POST", body: "{}" }],
      ["a marked write whose body is a stream", {
        method: "POST", body: new ReadableStream<Uint8Array>(), idempotent: true,
      }],
      ["a GET that has no retry policy", { retry: null }],
    ])("fails %s with the timeout, sent once", async (_name, init) => {
      const times = stalled(200, answer(200, "payload"));

      const text = expect(upstream.read(THREAD, init, bodyText)).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);

      await text;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "timeout", 200]]);
    });

    it("fails a GET with the timeout once its attempts are used, each counted a timeout", async () => {
      const times = stalled(200, 200, 200, answer(200, "payload"));

      const text = expect(upstream.read(THREAD, undefined, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(120_000);

      await text;
      expect(gaps(times)).toEqual([30_250, 30_500]);
      expect(outcomes()).toEqual(rows(3, ["error", "timeout", 200]));
    });

    it("uses the attempts of the retry policy, as an attempt that threw does", async () => {
      // A 503 is sent again, and no attempt of two is left for the answer that stalls.
      const times = stalled(answer(503), 200, answer(200, "payload"));

      const text = expect(upstream.read(THREAD, { retry: { attempts: 2 } }, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(120_000);

      await text;
      expect(times).toHaveLength(2);
      expect(outcomes()).toEqual([["error", "http", 503], ["error", "timeout", 200]]);
    });

    it("asks for no replay of it, and leaves the replays that remain", async () => {
      const times = stalled(answer(401), 200, answer(403), answer(200, "payload"));
      const replay = vi.fn((response: Response) => response.status !== 200);

      const text = upstream.read(THREAD, { replay }, bodyText);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(await text).toBe("payload");
      expect(times).toHaveLength(4);
      // Asked of each answer as it came, twice replayed: sending the stalled one again is no replay.
      expect(replay.mock.calls.map(([response]) => response.status)).toEqual([401, 200, 403]);
      expect(outcomes()).toEqual([
        ["error", "http", 401], ["error", "timeout", 200], ["error", "http", 403], ["success", "", 200],
      ]);
    });

    it("fails with the caller's reason where the caller aborts during the wait, and sends nothing more", async () => {
      const times = stalled(200, answer(200, "payload"));
      const caller = new AbortController();

      const text = expect(upstream.read(THREAD, { signal: caller.signal }, bodyText)).rejects.toThrow("stop");
      await vi.advanceTimersByTimeAsync(30_100);
      expect(vi.getTimerCount()).toBe(1);
      caller.abort(new Error("stop"));

      // No time passes: the request has failed by the abort alone, and its timer is gone.
      await text;
      expect(vi.getTimerCount()).toBe(0);
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "timeout", 200]]);
    });

    it("is not sent again where the caller's signal has aborted too", async () => {
      const times = stalled(200, answer(200, "payload"));
      const caller = new AbortController();

      // The caller gives up as the timeout fires: what `parse` then throws is the request's end.
      const text = expect(upstream.read(THREAD, { signal: caller.signal }, async response => {
        await new Promise(resolve => setTimeout(resolve, 30_000));
        caller.abort(new Error("stop"));
        return response.text();
      })).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);

      await text;
      expect(times).toHaveLength(1);
      expect(points).toEqual([]);
    });

    it("is not one that the caller's own wait cuts off, which is sent once", async () => {
      const times = stalled(200, answer(200, "payload"));
      const wait = new AbortController();

      const text = expect(untimed.read(THREAD, { signal: wait.signal }, response => {
        const read = response.text();
        wait.abort(new DOMException("too slow", "TimeoutError"));
        return read;
      })).rejects.toThrow("too slow");
      await vi.advanceTimersByTimeAsync(60_000);

      await text;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "timeout", 200]]);
    });

    it("sends once a GET whose answer cannot be parsed and whose timeout has not fired", async () => {
      const times = stalled(answer(200, "not json"), answer(200, "{}"));

      const body = expect(upstream.read(THREAD, undefined, parseBody)).rejects.toBeInstanceOf(SyntaxError);
      await vi.advanceTimersByTimeAsync(60_000);

      await body;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "parse", 200]]);
    });

    it("cancels the body of the answer before it sends again", async () => {
      const unread = open(200);
      const times = stalled(unread.response, answer(200, "payload"));

      // A reading that fails once the timeout has fired, with the body left as it was.
      const text = upstream.read(THREAD, undefined, async response => {
        if (response === unread.response) {
          await new Promise(resolve => setTimeout(resolve, 30_000));
          throw new Error("cut off");
        }
        return response.text();
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(unread.cancelled()).toBe(true);
      expect(times).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);

      expect(await text).toBe("payload");
      expect(times).toHaveLength(2);
    });

    it("is told by the timeout having fired, and not by what `parse` threw", async () => {
      const times = stalled(answer(200, "not json"), answer(200, "{}"));

      // A reading that fails for a reason of its own, once the timeout has fired.
      const body = upstream.read(THREAD, undefined, async response => {
        if (times.length === 1) await new Promise(resolve => setTimeout(resolve, 30_000));
        return parseBody(response);
      });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(await body).toEqual({});
      expect(times).toHaveLength(2);
      expect(outcomes()).toEqual([["error", "timeout", 200], ["success", "", 200]]);
    });

    it("is counted by its status where that is no success, and is not sent again", async () => {
      const times = stalled(404, answer(200, "payload"));

      const text = expect(upstream.read(THREAD, undefined, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);

      await text;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "http", 404]]);
    });

    it("leaves unsent a 429 that `retryable` would not send again, whatever wait the answer names", async () => {
      const times = stalled([429, { "Retry-After": "120" }], answer(200, "payload"));
      const retryable = vi.fn(() => false);

      const text = expect(upstream.read(THREAD, { retry: { retryable } }, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(200_000);

      await text;
      expect(times).toHaveLength(1);
      // The rule was asked about the answer once, when it came, and its word stands.
      expect(retryable).toHaveBeenCalledTimes(1);
      expect(outcomes()).toEqual([["refused", "rate", 429]]);
    });

    it("sends nothing beyond its attempts for a 503 that the retry rule sent again, each of whose bodies stalls", async () => {
      const times = stalled(503, 503, 503, answer(200, "payload"));

      const text = expect(upstream.read(THREAD, undefined, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(200_000);

      await text;
      // The waits of the retry rule, and none after the last answer, whose reading timed out.
      expect(gaps(times)).toEqual([250, 500]);
      expect(outcomes()).toEqual(rows(3, ["error", "http", 503]));
    });

    it.each<[string, Parameters<Upstream["with"]>[0], number]>([
      ["a 404 that `succeeded` takes for a success", { succeeded: status => status === 404 }, 404],
      ["a 302 where redirects are followed", { redirect: "follow" }, 302],
    ])("sends again %s", async (_name, overrides, status) => {
      const times = stalled(status, answer(200, "payload"));

      const text = upstream.with(overrides).read(THREAD, undefined, bodyText);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(await text).toBe("payload");
      expect(gaps(times)).toEqual([30_250]);
      expect(outcomes()[0]).toEqual(["error", "timeout", status]);
    });

    it.each<[string, Parameters<Upstream["with"]>[0], RequestInit & { idempotent?: boolean }, number]>([
      ["a 200 that `succeeded` takes for no success", { succeeded: status => status === 204 }, {}, 200],
      ["a 302 where redirects are not followed", {}, {}, 302],
      ["a 500 of a marked write", {}, { method: "POST", body: "{}", idempotent: true }, 500],
    ])("sends once %s", async (_name, overrides, init, status) => {
      const times = stalled(status, answer(200, "payload"));

      const text = expect(upstream.with(overrides).read(THREAD, init, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(200_000);

      await text;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["error", "http", status]]);
    });

    it("is sent again by what its status is, whatever the request's `answer` counts it as", async () => {
      const busy = stalled(200, answer(200, "payload"));
      const text = upstream.read(
        THREAD, { answer: () => ({ outcome: "refused", reason: "busy" }) }, bodyText);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await text).toBe("payload");

      const missing = stalled(404, answer(200, "payload"));
      const failed = expect(upstream.read(THREAD, { answer: () => ({ outcome: "success" }) }, bodyText))
          .rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(200_000);
      await failed;

      expect([busy.length, missing.length]).toEqual([2, 1]);
      expect(outcomes()).toEqual([
        ["refused", "busy", 200], ["refused", "busy", 200], ["error", "timeout", 404],
      ]);
    });

    it("leaves a request, whose caller reads the body, sent once", async () => {
      const times = stalled(200, answer(200, "payload"));

      const response = await upstream.request(THREAD);
      const text = expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);

      await text;
      expect(times).toHaveLength(1);
      expect(outcomes()).toEqual([["success", "", 200]]);
    });
  });

  it("counts how long the answer took, the parsing left out", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async () => {
      now += 250;
      return answer(200);
    });

    await upstream.read(THREAD, undefined, async () => { now += 4_000; });

    expect(columnOf(COMMON_SLOTS.durationMs)).toEqual([250]);
  });

  it("counts by its status, once, an answer whose replay hook rejects", async () => {
    const rejected = open(401);
    answering(rejected.response);
    const parse = vi.fn();

    await expect(upstream.read(THREAD, { replay: () => { throw new Error("no token"); } }, parse))
        .rejects.toThrow("no token");

    expect(parse).not.toHaveBeenCalled();
    expect(rejected.cancelled()).toBe(true);
    expect(outcomes()).toEqual([["error", "http", 401]]);
  });

  it("counts an answer after its `replay` hook is asked about it", async () => {
    answering(401, 200);

    await upstream.read(THREAD, {
      replay: response => {
        events.push(`replay ${response.status}`);
        return response.status === 401;
      },
    }, response => {
      events.push(`parse ${response.status}`);
    });

    expect(events).toEqual(["fetch", "replay 401", "count", "fetch", "replay 200", "parse 200", "count"]);
  });

  it("retries and replays as `request` does, parsing the last answer alone", async () => {
    const fetch = answering(401, 503, 200);
    const parse = vi.fn(statusOf);

    expect(await upstream.read(THREAD, { replay: response => response.status === 401 }, parse)).toBe(200);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([["error", "http", 401], ["error", "http", 503], ["success", "", 200]]);
  });
});

describe("call", () => {
  it("counts a call that resolves as a success, with how long it took and no status", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const result = await upstream.call("containers.exec", async () => {
      now += 120;
      return "done";
    });

    expect(result).toBe("done");
    expect(calls()).toEqual([["vendor", "containers.exec", "success", "", 0]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.vendor.api"]);
    expect(columnOf(COMMON_SLOTS.durationMs)).toEqual([120]);
  });

  it("counts a result by `answer`, given the result, and otherwise as a success", async () => {
    expect(await upstream.call("search", () => ({ ok: false, code: 9 }), { answer: refusedBody }))
        .toEqual({ ok: false, code: 9 });
    await upstream.call("search", () => ({ ok: true }), { answer: refusedBody });
    await upstream.call("search", () => ({ ok: true }), { answer: () => { throw new Error("no rule"); } });

    expect(outcomes()).toEqual([["refused", "quota", 0], ["success", "", 0], ["success", "", 0]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.detail)).toEqual(["daily", "", ""]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.providerCode)).toEqual([9, 0, 0]);
  });

  it("counts a throw as an exception, or a timeout by its name, and fails with it", async () => {
    const failure = new Error("secret-message");
    const slow = new DOMException("too slow", "TimeoutError");

    await expect(upstream.call("command", async () => { throw failure; })).rejects.toBe(failure);
    await expect(upstream.call("command", () => { throw slow; })).rejects.toBe(slow);
    await expect(upstream.call("command", () => { throw "a string"; })).rejects.toBe("a string");

    expect(outcomes()).toEqual([["error", "exception", 0], ["error", "timeout", 0], ["error", "exception", 0]]);
    expect(JSON.stringify(points)).not.toContain("secret");
  });

  it("counts a throw by `thrown`, given the error, and not at all for null", async () => {
    const failure = new Error("closed");
    const seen: unknown[] = [];
    const thrown = (error: unknown): CallAnswer => {
      seen.push(error);
      return { outcome: "refused", reason: "closed" };
    };

    await expect(upstream.call("command", () => { throw failure; }, { thrown })).rejects.toBe(failure);
    await expect(upstream.call("command", () => { throw failure; }, { thrown: () => null })).rejects.toBe(failure);
    await expect(upstream.call("command", () => { throw failure; }, { thrown: () => undefined })).rejects.toBe(failure);
    await expect(upstream.call("command", () => { throw failure; }, {
      thrown: () => { throw new Error("no rule"); },
    })).rejects.toBe(failure);

    expect(seen).toEqual([failure]);
    expect(outcomes()).toEqual([["refused", "closed", 0], ["error", "exception", 0], ["error", "exception", 0]]);
  });

  it("counts under its own service, then the upstream's, whose function is given no URL", async () => {
    const seen: unknown[] = [];
    const tabled = upstream.with({
      service: url => {
        seen.push(url);
        return "vendor-rpc";
      },
    });

    await tabled.call("command", () => "done", { service: "vendor-socket" });
    await tabled.call("command", () => "done");
    await upstream.call("command", () => "done");

    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["vendor-socket", "vendor-rpc", "vendor"]);
    expect(seen).toEqual([undefined]);
  });

  it("makes the call once, with no timeout and no retry", async () => {
    vi.useFakeTimers();
    const timeouts = fakeTimeouts();
    const work = vi.fn(() => new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("closed")), 120_000);
    }));

    const outcome = expect(upstream.call("command", work)).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(120_000);

    await outcome;
    expect(work).toHaveBeenCalledTimes(1);
    expect(timeouts).not.toHaveBeenCalled();
  });
});

const CALL: SubserviceCallInput = {
  source: "gatekeeper.vendor.api", service: "vendor", operation: "GET", outcome: "success",
  httpStatus: 200,
};

// Makes a call after an await, as a client deep in the work does.
async function later(operation: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1));
  recordCall({ ...CALL, operation });
}

// The operation of each point written, beside how many calls it stands for.
function written() {
  return points.map(point => [
    column(point, SUBSERVICE_V1_SLOTS.operation), column(point, SUBSERVICE_V1_SLOTS.calls),
  ]);
}

describe("recordCall and summedInto", () => {
  it("writes a call at once outside a tally", () => {
    recordCall(CALL);
    expect(written()).toEqual([["GET", 1]]);
  });

  it("sums the calls made in `summedInto`, across an await and in a nested call", async () => {
    const tally = subserviceTally();
    const answered = await summedInto(tally, async () => {
      recordCall(CALL);
      await later("GET");
      await Promise.all([later("GET"), later("POST")]);
      return "answer";
    });
    expect(answered).toBe("answer");
    expect(written()).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["GET", 3], ["POST", 1]]);
  });

  it("keeps apart the calls of two tallies at once, and of work under neither", async () => {
    const first = subserviceTally();
    const second = subserviceTally();
    await Promise.all([
      summedInto(first, () => later("GET")),
      summedInto(second, async () => { await later("POST"); await later("POST"); }),
      later("DELETE"),
    ]);
    expect(written()).toEqual([["DELETE", 1]]);

    first.flush();
    second.flush();
    expect(written()).toEqual([["DELETE", 1], ["GET", 1], ["POST", 2]]);
  });

  it("sums the attempts of a request, a read and a call made under a tally", async () => {
    answering(503, 200, 200);
    const tally = subserviceTally();

    await summedInto(tally, async () => {
      await upstream.request(THREAD);
      await upstream.read(THREAD, undefined, () => "parsed");
      await upstream.call("command", () => "done");
    });
    expect(points).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["threads.get", 1], ["threads.get", 2], ["command", 1]]);
  });
});

describe("summed", () => {
  it("writes one point per kind of call once the work resolves, and nothing before", async () => {
    answering(200, 200, 200, 404, 200);

    const result = await upstream.summed(async () => {
      for (let page = 0; page < 3; page++) await upstream.request(THREAD);
      await upstream.request(THREAD);
      await upstream.request(`${THREAD}/modify`, { method: "POST" });
      expect(points).toEqual([]);
      return "pages";
    });

    expect(result).toBe("pages");
    expect(written()).toEqual([["threads.get", 3], ["threads.get", 1], ["threads.modify", 1]]);
    expect(outcomes()).toEqual([["success", "", 200], ["error", "http", 404], ["success", "", 200]]);
  });

  it("returns the very promise the work returned", async () => {
    const promise = Promise.resolve("done");
    expect(upstream.summed(() => promise)).toBe(promise);
    await promise;
  });

  it("writes when the work rejects, and fails as it did", async () => {
    answering(200);
    const failure = new Error("stop");

    await expect(upstream.summed(async () => {
      await upstream.request(THREAD);
      throw failure;
    })).rejects.toBe(failure);

    expect(written()).toEqual([["threads.get", 1]]);
  });

  it("writes as soon as work that is not a promise returns or throws", () => {
    const failure = new Error("stop");

    expect(upstream.summed(() => {
      recordCall(CALL);
      recordCall(CALL);
      return 7;
    })).toBe(7);
    expect(written()).toEqual([["GET", 2]]);

    expect(() => upstream.summed(() => {
      recordCall({ ...CALL, operation: "POST" });
      throw failure;
    })).toThrow(failure);
    expect(written()).toEqual([["GET", 2], ["POST", 1]]);
  });

  it("returns a thenable that is no promise as it is, and leaves its `then` to the caller", async () => {
    const fetch = answering(201);
    const send = upstream.fetcher();
    // A query builder of an SDK sends when it is awaited, each time it is.
    const then = vi.fn((resolve: (status: number) => void, reject: (error: unknown) => void) => {
      send(`${THREAD}/modify`, { method: "POST" }).then(response => resolve(response.status), reject);
    });
    // oxlint-disable-next-line unicorn/no-thenable -- The work of this test returns a thenable.
    const builder = { then };

    const returned = upstream.summed(() => builder);
    expect(returned).toBe(builder);
    expect(then).not.toHaveBeenCalled();

    expect(await returned).toBe(201);
    expect(then).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(written()).toEqual([["threads.modify", 1]]);
  });

  it("writes at once the calls of work left running once it has settled, a `summed` in it summing anew", async () => {
    answering(200, 200, 200, 200, 200);
    let background: Promise<void> | undefined;

    await upstream.summed(async () => {
      await upstream.request(THREAD);
      background = (async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        await upstream.request(`${API}/profile`);
        await upstream.summed(async () => {
          await upstream.request(`${THREAD}/modify`, { method: "POST" });
          await upstream.request(`${THREAD}/modify`, { method: "POST" });
          expect(written()).toEqual([["threads.get", 1], ["profile.get", 1]]);
        });
        recordCall(CALL);
      })();
    });
    expect(written()).toEqual([["threads.get", 1]]);

    await background;
    expect(written()).toEqual([["threads.get", 1], ["profile.get", 1], ["threads.modify", 2], ["GET", 1]]);
  });

  it("sums into the tally already running, and leaves the writing to it", async () => {
    answering(200, 200, 200);
    const access = upstream.with({ service: "access" });

    await upstream.summed(async () => {
      await upstream.request(THREAD);
      await upstream.summed(() => upstream.request(THREAD));
      // An upstream made by `with` sums into the same tally.
      await access.summed(() => access.request(THREAD));
      expect(points).toEqual([]);
    });
    expect(calls()).toEqual([
      ["vendor", "threads.get", "success", "", 200],
      ["access", "threads.get", "success", "", 200],
    ]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([2, 1]);
  });

  it("sums into the tally of `summedInto`, and does not flush it", async () => {
    answering(200);
    const tally = subserviceTally();

    await summedInto(tally, () => upstream.summed(() => upstream.request(THREAD)));
    expect(points).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["threads.get", 1]]);
  });

  it("writes each call at once outside it", async () => {
    answering(200, 200);
    await upstream.request(THREAD);
    expect(written()).toEqual([["threads.get", 1]]);
    await upstream.request(THREAD);
    expect(written()).toEqual([["threads.get", 1], ["threads.get", 1]]);
  });
});

describe("fetcher", () => {
  it("sends each call as a request with the caller's init under its defaults", async () => {
    const fetch = answering(401, 200);
    let minted = 0;
    const fetcher = untimed.fetcher({
      operation: "keys.get",
      service: "access",
      authorize: () => ({ Authorization: `Bearer token-${++minted}` }),
      replay: response => response.status === 401,
    });

    const response = await fetcher(`${API}/keys`, { headers: { Accept: "application/json" } });

    expect(response.status).toBe(200);
    expect(fetch.mock.calls.map(([input, init]) => [input, Object.fromEntries(new Headers(init?.headers))]))
        .toEqual([
          [`${API}/keys`, { accept: "application/json", authorization: "Bearer token-1" }],
          [`${API}/keys`, { accept: "application/json", authorization: "Bearer token-2" }],
        ]);
    expect(calls()).toEqual([
      ["access", "keys.get", "error", "http", 401],
      ["access", "keys.get", "success", "", 200],
    ]);
  });

  it("names and retries as a request does where it has no defaults", async () => {
    const fetch = answering(503, 200, 503);
    const fetcher = upstream.fetcher();

    expect((await fetcher(THREAD)).status).toBe(200);
    expect((await fetcher(new Request(`${THREAD}/modify`, { method: "POST" }))).status).toBe(503);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(columnOf(SUBSERVICE_V1_SLOTS.operation)).toEqual(["threads.get", "threads.get", "threads.modify"]);
  });

  it("reads of a caller's init only what fetch takes, and none of a request's own options", async () => {
    const fetch = answering(503, 401);
    const hooks = { authorize: vi.fn(() => ({})), replay: vi.fn(() => true), answer: vi.fn() };
    // What code that is not type-checked may pass in the init of a fetch.
    const init = {
      method: "POST", body: "{}", idempotent: true, operation: "from-caller",
      service: "host.vendor.example", timeoutMs: null, retry: { attempts: 5 }, ...hooks,
    };

    expect((await upstream.fetcher()(THREAD, init)).status).toBe(503);
    expect((await upstream.fetcher({ operation: "keys.send" })(THREAD, init)).status).toBe(401);

    // A write that nothing marks is sent once, under the upstream's own names and timeout.
    expect(fetch.mock.calls.map(([, sent]) => Object.keys(sent ?? {})))
        .toEqual(rows(2, ["method", "body", "signal", "redirect"]));
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
    expect(calls()).toEqual([
      ["vendor", "threads.create", "error", "http", 503],
      ["vendor", "keys.send", "error", "http", 401],
    ]);
  });

  it("reads a Request given for a call's init by property", async () => {
    const fetch = answering(200, 200);
    const first = givenForInit("POST");

    await untimed.fetcher()(`${THREAD}/modify`, first);
    await untimed.fetcher({ redirect: "manual", operation: "threads.send" })(THREAD, givenForInit("POST"));

    const sent = initOf(fetch);
    expect([sent.method, sent.redirect]).toEqual(["POST", "manual"]);
    expect(sent.headers).toBe(first.headers);
    expect(sent.body).toBe(first.body);
    expect([initOf(fetch, 1).method, initOf(fetch, 1).redirect]).toEqual(["POST", "manual"]);
    expect(calls()).toEqual([
      ["vendor", "threads.modify", "success", "", 200], ["vendor", "threads.send", "success", "", 200],
    ]);
  });

  it("reads none of a request's own options that a call's init holds behind a getter", async () => {
    const fetch = answering(503);
    class Sdk {
      get method() { return "POST"; }
      get operation() { return "from-caller"; }
      get idempotent() { return true; }
      get retry() { return { attempts: 5 }; }
    }

    expect((await untimed.fetcher()(THREAD, new Sdk())).status).toBe(503);

    expect(fetch.mock.calls.map(([, init]) => init)).toEqual([{ method: "POST", redirect: "manual" }]);
    expect(calls()).toEqual([["vendor", "threads.create", "error", "http", 503]]);
  });

  it("fails by a rejection, as fetch does, a call whose init throws on being read", async () => {
    const fetch = answering(200, 200);
    const refused = new Error("no init");
    class Sdk {
      get method(): string { throw refused; }
    }
    const own: RequestInit = Object.defineProperty({}, "body", {
      enumerable: true, get() { throw refused; },
    });

    for (const init of [new Sdk(), own]) {
      const sent: Promise<Response>[] = [];
      expect(() => sent.push(untimed.fetcher()(THREAD, init))).not.toThrow();
      expect(sent).toHaveLength(1);
      await expect(sent[0]).rejects.toBe(refused);
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(points).toEqual([]);
  });

  it("uses a redirect mode of the caller's init where its defaults have none", async () => {
    const fetch = answering(302, 302, 302, 302);

    await untimed.fetcher()(THREAD, { redirect: "manual" });
    await untimed.fetcher({ redirect: undefined, retry: null })(THREAD, { redirect: "manual" });
    await untimed.fetcher({ redirect: "follow" })(THREAD, { redirect: "manual" });
    await untimed.fetcher({ redirect: "manual" })(THREAD);

    expect(fetch.mock.calls.map(([, init]) => init)).toEqual([
      { redirect: "manual" }, { redirect: "manual" }, { redirect: "follow" }, { redirect: "manual" },
    ]);
    expect(outcomes()).toEqual([
      ["error", "http", 302], ["error", "http", 302], ["success", "", 302], ["error", "http", 302],
    ]);
  });
});

describe("with", () => {
  it("takes the options given in place of its own and keeps the rest, the vendor included", async () => {
    const global = answering(200);
    const bound = vi.fn<UpstreamFetch>(async () => answer(302));
    const overrides = { service: "access", fetch: bound, redirect: "manual", vendorId: "other" } as const;

    const access = upstream.with(overrides);
    await access.request(THREAD);
    await upstream.request(THREAD);

    expect([access.vendorId, access.source]).toEqual(["vendor", "gatekeeper.vendor.api"]);
    expect(bound).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([
      ["access", "threads.get", "error", "http", 302],
      ["vendor", "threads.get", "success", "", 200],
    ]);
  });

  it("gives an option replaced by undefined its default", async () => {
    answering(200, 200);
    const plain = upstream.with({ service: "access" }).with({ service: undefined, routes: undefined });
    await plain.request(THREAD);
    expect(calls()).toEqual([["vendor", "GET", "success", "", 200]]);
  });
});
