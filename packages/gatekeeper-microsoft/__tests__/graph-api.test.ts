import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DownloadTooLargeError, GraphApi, GraphApiError, GraphThrottledError, GraphTransportError, errorForResponse, isDownloadHost, isGraphUrl,
  isOutcomeUnknown,
} from "../src/graph-api";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a script, recording every request. */
function scripted(...answers: (Response | (() => Response) | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return { api: new GraphApi("token-123", { fetch: fetch as typeof globalThis.fetch }), calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

/** Runs a request to completion while its retries sleep on fake timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isGraphUrl", () => {
  it.each([
    ["https://graph.microsoft.com/v1.0/me", true],
    ["https://graph.microsoft.com/v1.0/sites?search=x&$skiptoken=abc", true],
    ["https://graph.microsoft.com/beta/me", false],
    ["https://graph.microsoft.com/v1.0", false],
    ["http://graph.microsoft.com/v1.0/me", false],
    ["https://graph.microsoft.com:8443/v1.0/me", false],
    ["https://user:pass@graph.microsoft.com/v1.0/me", false],
    ["https://graph.microsoft.com.evil.example/v1.0/me", false],
    ["https://contoso.sharepoint.com/v1.0/me", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isGraphUrl(url)).toBe(expected);
  });
});

describe("isDownloadHost", () => {
  it.each([
    ["https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x", true],
    ["https://contoso-my.sharepoint.com/personal/p/_layouts/15/download.aspx", true],
    ["https://southcentralus1-mediap.svc.ms/transform/pdf", true],
    ["http://contoso.sharepoint.com/download", false],
    ["https://contoso.sharepoint.com:444/download", false],
    ["https://user@contoso.sharepoint.com/download", false],
    ["https://contoso.sharepoint.com.evil.example/download", false],
    ["https://a.b.sharepoint.com/download", false],
    ["https://graph.microsoft.com/v1.0/me", false],
    ["https://evil.example/svc.ms", false],
  ])("%s → %s", (url, expected) => {
    expect(isDownloadHost(url)).toBe(expected);
  });
});

describe("errorForResponse", () => {
  it("keeps Graph's code, the innermost code and the request ID", () => {
    const error = errorForResponse(new Response(null, { status: 409, headers: { "request-id": "req-1" } }), {
      error: { code: "nameAlreadyExists", message: "Name already exists", innerError: { code: "a", innerError: { code: "b" } } },
    });
    expect(error).toMatchObject({ status: 409, code: "nameAlreadyExists", innerCode: "b", requestId: "req-1", message: "Name already exists" });
    expect(error.isNameConflict).toBe(true);
    expect(error.isConflict).toBe(false);
  });

  it.each([
    [401, "Microsoft 365 did not accept this connection's credentials."],
    [403, "You don't have permission to do that in Microsoft 365."],
    [404, "That item doesn't exist, or you don't have access to it."],
  ])("uses its own wording for %i, never Graph's (which can carry server paths)", (status, message) => {
    const error = errorForResponse(new Response(null, { status }), { error: { code: "x", message: "/sites/Secret/Shared Documents/plan.docx" } });
    expect(error.message).toBe(message);
  });

  it("falls back to plain wording when Graph explains nothing", () => {
    expect(errorForResponse(new Response(null, { status: 423 }), null).message).toMatch(/locked/);
    expect(errorForResponse(new Response(null, { status: 418 }), "teapot").message).toBe("Microsoft Graph answered with HTTP 418.");
  });

  it("reads 429, and 503 with Retry-After, as throttling with a retry time", () => {
    const before = Date.now();
    const throttled = errorForResponse(new Response(null, { status: 429, headers: { "retry-after": "30" } }), null);
    expect(throttled).toBeInstanceOf(GraphThrottledError);
    expect((throttled as GraphThrottledError).retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(throttled.message).toMatch(/Try again after \d\d:\d\d:\d\d UTC\./);
    expect(errorForResponse(new Response(null, { status: 503, headers: { "retry-after": "1" } }), null)).toBeInstanceOf(GraphThrottledError);
    expect(errorForResponse(new Response(null, { status: 503 }), null)).not.toBeInstanceOf(GraphThrottledError);
  });

  it("classifies a 412 and a non-name 409 as the object having changed", () => {
    expect(errorForResponse(new Response(null, { status: 412 }), null).isConflict).toBe(true);
    expect(errorForResponse(new Response(null, { status: 409 }), { error: { code: "resourceModified" } }).isConflict).toBe(true);
  });
});

describe("isOutcomeUnknown", () => {
  it("is true for a lost answer or a server failure, not for throttling or a refusal", () => {
    expect(isOutcomeUnknown(new GraphTransportError("x"))).toBe(true);
    expect(isOutcomeUnknown(new GraphApiError(502, "x"))).toBe(true);
    expect(isOutcomeUnknown(new GraphThrottledError(503, undefined))).toBe(false);
    expect(isOutcomeUnknown(new GraphApiError(404, "x"))).toBe(false);
  });
});

describe("GraphApi.request", () => {
  it("sends the token, user agent and query to Graph, never following a redirect", async () => {
    const { api, calls } = scripted(json({ ok: 1 }));
    expect(await api.get("/me", { query: { $select: "id", skip: undefined } })).toEqual({ ok: 1 });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me?%24select=id");
    expect(header(calls[0], "authorization")).toBe("Bearer token-123");
    expect(header(calls[0], "user-agent")).toMatch(/^ISV\|Cloudflare\|/);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("refuses to send the token anywhere but Graph's pinned version", async () => {
    const { api, calls } = scripted();
    await expect(api.get("https://evil.example/v1.0/me")).rejects.toThrow(/outside Microsoft Graph/);
    await expect(api.get("https://graph.microsoft.com/beta/me")).rejects.toThrow(/outside Microsoft Graph/);
    expect(calls).toEqual([]);
  });

  it("follows a full nextLink on Graph", async () => {
    const { api, calls } = scripted(json({ value: [] }));
    await api.get("https://graph.microsoft.com/v1.0/sites?$skiptoken=abc");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/sites?$skiptoken=abc");
  });

  it("sends a JSON body, raw bytes, If-Match and Prefer as asked", async () => {
    const { api, calls } = scripted(json({}), json({}));
    await api.request("PATCH", "/me/events/x", { body: { a: 1 }, ifMatch: "\"c:1\"", prefer: ["a", "b"] });
    expect(calls[0].init.body).toBe("{\"a\":1}");
    expect(header(calls[0], "content-type")).toBe("application/json");
    expect(header(calls[0], "if-match")).toBe("\"c:1\"");
    expect(header(calls[0], "prefer")).toBe("a, b");
    await api.request("PUT", "/drives/d/items/y/content", { rawBody: "text", contentType: "text/plain" });
    expect(calls[1].init.body).toBe("text");
    expect(header(calls[1], "content-type")).toBe("text/plain");
  });

  it("answers 204 and allowed statuses with null, and find() with null for 403 and 404", async () => {
    const { api } = scripted(new Response(null, { status: 204 }), json({ error: {} }, 404), json({ error: {} }, 403),
      json({ error: {} }, 404), json({ error: {} }, 401));
    expect(await api.request("DELETE", "/me/events/x")).toBeNull();
    expect(await api.request("GET", "/me/events/x", { allow: [404] })).toBeNull();
    expect(await api.find("/me/events/x")).toBeNull();
    expect(await api.find("/me/events/x")).toBeNull();
    await expect(api.find("/me/events/x")).rejects.toMatchObject({ status: 401, isAuthError: true });
  });

  it("retries a short throttle, whatever the method, then succeeds", async () => {
    const { api, calls } = scripted(json({}, 429, { "retry-after": "1" }), json({}, 429, { "retry-after": "0" }), json({ done: true }));
    expect(await settle(api.request("POST", "/me/events/x/accept", { body: {} }))).toEqual({ done: true });
    expect(calls).toHaveLength(3);
  });

  it("gives up after three throttled attempts", async () => {
    const { api, calls } = scripted(...[1, 2, 3].map(() => () => json({}, 429, { "retry-after": "0" })));
    await expect(settle(api.get("/me/events/x"))).rejects.toBeInstanceOf(GraphThrottledError);
    expect(calls).toHaveLength(3);
  });

  it("hands a long throttle back to the caller rather than waiting", async () => {
    const { api, calls } = scripted(json({}, 429, { "retry-after": "120" }));
    const error = await settle(api.get("/me/events/x")).catch(caught => caught) as GraphThrottledError;
    expect(error).toBeInstanceOf(GraphThrottledError);
    expect(error.retryAt).toBeGreaterThan(Date.now() + 100_000);
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 without Retry-After for a GET, but never for a write that may have landed", async () => {
    const reads = scripted(json({}, 503), json({}, 504), json({ ok: true }));
    expect(await settle(reads.api.get("/me/events/x"))).toEqual({ ok: true });
    expect(reads.calls).toHaveLength(3);

    const writes = scripted(json({}, 503));
    const error = await settle(writes.api.request("POST", "/me/events/x/accept", { body: {} })).catch(caught => caught);
    expect(error).toMatchObject({ status: 503 });
    expect(isOutcomeUnknown(error)).toBe(true);
    expect(writes.calls).toHaveLength(1);
  });

  it("reports a dropped connection as an unknown outcome", async () => {
    const { api } = scripted(new TypeError("network"));
    await expect(api.request("POST", "/me/events/x/accept")).rejects.toBeInstanceOf(GraphTransportError);
  });

  it("answers a non-JSON error page by its status", async () => {
    const { api } = scripted(new Response("<html>Bad gateway</html>", { status: 400 }));
    await expect(api.get("/me/events/x")).rejects.toMatchObject({ status: 400, message: "Microsoft Graph answered with HTTP 400." });
  });
});

// A client answering from a script, with the clock's time at each send.
function timed(...answers: ([status: number, headers?: Record<string, string>] | Error)[]) {
  const times: number[] = [];
  const fetch = vi.fn(async () => {
    times.push(Date.now());
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return json({}, next[0], next[1]);
  });
  return { api: new GraphApi("token-123", { fetch }), times };
}

// The milliseconds between each send and the one before it.
const gaps = (times: number[]) => times.slice(1).map((time, at) => time - times[at]);

// What is thrown once a request is given up, as its class and status.
async function failure(promise: Promise<unknown>): Promise<[string, number | undefined]> {
  const error = await settle(promise).then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof Error)) throw new Error("the request did not fail");
  return [error.name, error instanceof GraphApiError ? error.status : undefined];
}

// A `Retry-After` header naming a wait.
const after = (wait: string) => ({ "retry-after": wait });

describe("GraphApi.request, by what Graph answers", () => {
  const NOW = Date.parse("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: NOW });
  });

  type Answer = [status: number, headers?: Record<string, string>];
  // The method, each answer in turn, the waits between the sends, and what is thrown at the end.
  const ROWS: [what: string, method: string, answers: Answer[], waits: number[], thrown: [string, number]][] = [
    ["a 429 that names no wait waits a second for each send made, whatever the method", "POST",
      [[429], [429], [429]], [1000, 2000], ["GraphThrottledError", 429]],
    ["a 429 waits what its Retry-After names", "PATCH",
      [[429, after("3")], [429, after("10")], [429, after("0")]], [3000, 10_000], ["GraphThrottledError", 429]],
    ["a 429 whose Retry-After is longer than ten seconds is handed back at once", "GET",
      [[429, after("11")]], [], ["GraphThrottledError", 429]],
    ["a 429 on the second send whose Retry-After is too long is handed back then", "GET",
      [[429, after("1")], [429, after("3600")]], [1000], ["GraphThrottledError", 429]],
    ["a 429 waits until the date its Retry-After names", "GET",
      [[429, { "retry-after": new Date(NOW + 4000).toUTCString() }], [429, after("11")]], [4000], ["GraphThrottledError", 429]],
    ["a 429 whose Retry-After names a date past is sent again at once", "GET",
      [[429, { "retry-after": new Date(NOW - 60_000).toUTCString() }], [429, after("11")]], [0], ["GraphThrottledError", 429]],
    ["a 503 that names a wait is a throttle, sent again whatever the method", "DELETE",
      [[503, after("2")], [503, after("0")], [503, after("0")]], [2000, 0], ["GraphThrottledError", 503]],
    ["a 503 that names too long a wait is handed back at once", "POST",
      [[503, after("60")]], [], ["GraphThrottledError", 503]],
    ["a 503 that names no wait is sent again for a GET, a second later for each send made", "GET",
      [[503], [503], [503]], [1000, 2000], ["GraphApiError", 503]],
    ["a 503 that names no wait is not sent again for a write", "PATCH",
      [[503]], [], ["GraphApiError", 503]],
    ["a 504 is sent again for a GET by the same wait, whatever Retry-After it carries", "GET",
      [[504, after("7")], [504], [504]], [1000, 2000], ["GraphApiError", 504]],
    ["a 504 is not sent again for a write, whatever Retry-After it carries", "POST",
      [[504, after("1")]], [], ["GraphApiError", 504]],
    ["a 502 is not sent again, even for a GET", "GET",
      [[502]], [], ["GraphApiError", 502]],
    ["a 500 is not sent again", "GET",
      [[500, after("1")]], [], ["GraphApiError", 500]],
  ];

  it.each(ROWS)("%s", async (_what, method, answers, waits, thrown) => {
    const { api, times } = timed(...answers);
    expect(await failure(api.request(method, "/me/events/x", method === "GET" || method === "DELETE" ? {} : { body: {} }))).toEqual(thrown);
    expect(times).toHaveLength(answers.length);
    expect(gaps(times)).toEqual(waits);
  });

  it("sends three times at most, and answers what the third send got", async () => {
    const { api, times } = timed([429, after("0")], [503], [200]);
    expect(await settle(api.get("/me/events/x"))).toEqual({});
    expect(times).toHaveLength(3);
  });

  it("never sends again an answer among `allow`, which is answered with null", async () => {
    const { api, times } = timed([503], [429, after("0")]);
    expect(await settle(api.request("GET", "/me/events/x", { allow: [503] }))).toBeNull();
    expect(await settle(api.request("GET", "/me/events/x", { allow: [429] }))).toBeNull();
    expect(times).toHaveLength(2);
  });

  it("sends a GET that got no answer three times, and then reports an unknown outcome", async () => {
    const { api, times } = timed(new TypeError("reset"), new TypeError("reset"), new TypeError("reset"));
    expect(await failure(api.get("/me/events/x"))).toEqual(["GraphTransportError", undefined]);
    expect(times).toHaveLength(3);
  });

  it("sends a write that got no answer once", async () => {
    const { api, times } = timed(new TypeError("reset"));
    expect(await failure(api.request("PATCH", "/me/events/x", { body: {} }))).toEqual(["GraphTransportError", undefined]);
    expect(times).toHaveLength(1);
  });
});

describe("GraphApi.batch", () => {
  const get = (id: string) => ({ id, method: "GET" as const, url: `drives/b!x/items/${id}` });

  it("sends nothing for no requests", async () => {
    const { api, calls } = scripted();
    expect(await api.batch([])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("refuses more than Graph's limit of 20, and absolute or rooted URLs", async () => {
    const { api } = scripted();
    await expect(api.batch(Array.from({ length: 21 }, (_, index) => get(String(index))))).rejects.toThrow(/at most 20/);
    await expect(api.batch([{ id: "1", method: "GET", url: "/me" }])).rejects.toThrow(/relative/);
    await expect(api.batch([{ id: "1", method: "GET", url: "https://evil.example/x" }])).rejects.toThrow(/relative/);
  });

  it("maps each answer to its request, keeping per-request statuses and skipping junk", async () => {
    const { api, calls } = scripted(json({
      responses: [{ id: "a", status: 200, body: { id: "A" } }, { id: "b", status: 403, body: { error: {} } }, null, { id: 3, status: 200 }],
    }));
    const answers = await api.batch([get("a"), get("b")]);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/$batch");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ requests: [get("a"), get("b")] });
    expect([...answers.values()]).toEqual([{ id: "a", status: 200, body: { id: "A" } }, { id: "b", status: 403, body: { error: {} } }]);
  });

  it("refuses an answer with no responses as a 502", async () => {
    const { api } = scripted(json({}));
    await expect(api.batch([get("a")])).rejects.toMatchObject({ status: 502 });
  });
});

describe("GraphApi.download", () => {
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const bytes = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

  it("follows the one redirect to SharePoint, without the token", async () => {
    const { api, calls } = scripted(redirect("https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x"),
      bytes("hello", { "content-type": "text/plain" }));
    const download = await api.download("/drives/b!x/items/1/content", 1024, { format: "pdf" });
    expect(new TextDecoder().decode(download.bytes)).toBe("hello");
    expect(download.contentType).toBe("text/plain");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/drives/b!x/items/1/content?format=pdf");
    expect(header(calls[0], "authorization")).toBe("Bearer token-123");
    expect(calls[1].url).toBe("https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x");
    expect(header(calls[1], "authorization")).toBeUndefined();
    expect(calls[1].init.redirect).toBe("manual");
  });

  it.each([
    "https://evil.example/steal",
    "http://contoso.sharepoint.com/download",
    "https://graph.microsoft.com/v1.0/other",
  ])("refuses a redirect to %s without requesting it", async location => {
    const { api, calls } = scripted(redirect(location));
    await expect(api.download("/drives/b!x/items/1/content", 1024)).rejects.toThrow(/redirected the download somewhere unexpected/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect with no location", async () => {
    const { api } = scripted(new Response(null, { status: 302 }));
    await expect(api.download("/drives/d/items/x/content", 1024)).rejects.toMatchObject({ status: 502 });
  });

  it("follows no second redirect, even to an allowed host", async () => {
    const { api, calls } = scripted(redirect("https://contoso.sharepoint.com/a"), redirect("https://contoso.sharepoint.com/b"));
    await expect(api.download("/drives/d/items/x/content", 1024)).rejects.toBeInstanceOf(GraphApiError);
    expect(calls).toHaveLength(2);
  });

  it("refuses a file declared larger than the cap before reading it", async () => {
    const { api } = scripted(bytes("x".repeat(10), { "content-length": "4096" }));
    await expect(api.download("/drives/d/items/x/content", 1024)).rejects.toBeInstanceOf(DownloadTooLargeError);
  });

  it("refuses a file that turns out larger than the cap while reading", async () => {
    const { api } = scripted(bytes("x".repeat(2048)));
    const error = await api.download("/drives/d/items/x/content", 1024).catch(caught => caught);
    expect(error).toBeInstanceOf(DownloadTooLargeError);
    expect(error.maxBytes).toBe(1024);
  });

  it("maps a refused download onto Graph's errors, and a lost one onto a transport error", async () => {
    const refused = scripted(json({ error: { code: "itemNotFound" } }, 404));
    await expect(refused.api.download("/drives/d/items/x/content", 1024)).rejects.toMatchObject({ status: 404, code: "itemNotFound" });
    // A download is a GET, so one that gets no answer is sent three times before it is given up.
    const lost = scripted(new TypeError("reset"), new TypeError("reset"), new TypeError("reset"));
    await expect(settle(lost.api.download("/drives/d/items/x/content", 1024))).rejects.toBeInstanceOf(GraphTransportError);
    expect(lost.calls).toHaveLength(3);
  });
});
