import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareObservabilityApi,
  observabilityFieldKey,
  scopeObservabilityFilters,
  type ObservabilityFilter,
} from "../src/observability-api";
import { CloudflareObservabilityApiError } from "../src/observability-parse";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TEST_NOW = new Date("2026-08-14T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `restoreMocks` is not enabled, so a `console` spy set up by one test would otherwise stay
  // installed and swallow the output of every test after it.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scopeObservabilityFilters", () => {
  it("passes account-wide filters through unchanged", () => {
    const filter: ObservabilityFilter = {
      kind: "filter",
      key: "$metadata.level",
      operation: "eq",
      type: "string",
      value: "error",
    };

    expect(scopeObservabilityFilters(undefined, filter)).toEqual([filter]);
  });

  it("adds an immutable Worker condition around caller OR filters", () => {
    const callerFilter: ObservabilityFilter = {
      kind: "group",
      filterCombination: "or",
      filters: [
        {
          kind: "filter",
          key: "$metadata.level",
          operation: "eq",
          type: "string",
          value: "error",
        },
        {
          kind: "filter",
          key: "$metadata.statusCode",
          operation: "gte",
          type: "number",
          value: 500,
        },
      ],
    };

    expect(scopeObservabilityFilters("api-worker", callerFilter)).toEqual([
      {
        kind: "filter",
        key: "$metadata.service",
        operation: "eq",
        type: "string",
        value: "api-worker",
      },
      callerFilter,
    ]);
  });

  it("still constrains a caller-supplied service filter", () => {
    const callerFilter: ObservabilityFilter = {
      kind: "filter",
      key: "$metadata.service",
      operation: "neq",
      type: "string",
      value: "api-worker",
    };

    expect(scopeObservabilityFilters("api-worker", callerFilter)).toEqual([
      expect.objectContaining({
        key: "$metadata.service",
        operation: "eq",
        value: "api-worker",
      }),
      callerFilter,
    ]);
  });

  it("rejects caller filters too deep to wrap safely", () => {
    const leaf: ObservabilityFilter = {
      kind: "filter",
      key: "$metadata.level",
      operation: "eq",
      type: "string",
      value: "error",
    };
    const depthThree: ObservabilityFilter = {
      kind: "group",
      filterCombination: "and",
      filters: [{
        kind: "group",
        filterCombination: "and",
        filters: [{
          kind: "group",
          filterCombination: "and",
          filters: [leaf],
        }],
      }],
    };

    expect(() => scopeObservabilityFilters("api-worker", depthThree))
      .toThrow("Filter nesting is too deep");
  });
});

describe("CloudflareObservabilityApi", () => {
  it("serializes a scoped events query with an outer AND", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          events: { count: 1, events: [] },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");
    const from = new Date("2026-08-14T09:00:00Z");
    const to = new Date("2026-08-14T10:00:00Z");

    await api.listEvents({
      timeframe: { from, to },
      filter: {
        kind: "group",
        filterCombination: "or",
        filters: [
          { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "error" },
          { kind: "filter", key: "$metadata.statusCode", operation: "gte", type: "number", value: 500 },
        ],
      },
    });

    expect(requestUrl).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
    );
    expect(requestBody).toMatchObject({
      view: "events",
      dry: true,
      timeframe: { from: from.valueOf(), to: to.valueOf() },
      parameters: {
        datasets: ["cloudflare-workers"],
        filterCombination: "and",
        filters: [
          { key: "$metadata.service", operation: "eq", value: "api-worker" },
          { kind: "group", filterCombination: "or" },
        ],
      },
    });
  });

  it("loads trace detail through the events view without weakening Worker scope", async () => {
    let requestBody: { parameters: { filters: unknown[] } } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          events: { count: 1, events: [{
            dataset: "cloudflare-workers", timestamp: 1, source: {},
            $metadata: { id: "event", service: "api-worker" },
          }] },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const trace = await api.getTrace("trace-id", {
      timeframe: {
        from: new Date("2026-08-14T09:00:00Z"),
        to: new Date("2026-08-14T10:00:00Z"),
      },
    });

    expect(trace.traceId).toBe("trace-id");
    expect(trace.events).toHaveLength(1);
    expect(requestBody?.parameters.filters).toEqual([
      expect.objectContaining({ key: "$metadata.service", value: "api-worker" }),
      expect.objectContaining({ key: "$metadata.traceId", value: "trace-id" }),
    ]);
  });

  it("rejects timeframes longer than seven days before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listEvents({
      timeframe: {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-09T00:00:00Z"),
      },
    })).rejects.toThrow("seven days");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects timeframes entirely outside retention before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listEvents({
      timeframe: {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-02T00:00:00Z"),
      },
    })).rejects.toThrow("retention");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fetch after credentials expire", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => null, ACCOUNT_ID);

    await expect(api.listKeys()).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed successful envelopes with a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: null })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listEvents().catch(caught => caught);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).toContain("invalid Workers Observability response");
  });

  it("rejects malformed view payloads with a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
        events: { events: "not-an-array" },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listEvents()).rejects.toMatchObject({ status: 502 });
  });

  it("rejects non-finite query statistics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"success":true,"result":{"statistics":{"elapsed":1e400,"rows_read":1,"bytes_read":10},' +
      '"events":{"events":[]}}}',
      { headers: { "content-type": "application/json" } },
    )));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listEvents()).rejects.toMatchObject({ status: 502 });
  });

  it("retries one request timeout before failing", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const fetchSpy = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const expectation = expect(api.listKeys()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(250);

    await expectation;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a timeout while reading the response body", async () => {
    const timeout = new Error("timed out while reading");
    timeout.name = "TimeoutError";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        pull(controller) { controller.error(timeout); },
      })))
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const expectation = expect(api.listKeys()).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(250);

    await expectation;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized response before buffering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      headers: { "content-length": String(3 * 1024 * 1024) },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listKeys()).rejects.toThrow("response is too large");
  });

  it("answers a constrained discovery call from a filtered events sample", async () => {
    // The provider's `keys` and `values` endpoints ignore the `filters` array entirely -- verified
    // against a live account -- so a Worker-scoped binding cannot use them: they would answer with
    // every field name and value in the whole account. Discovery is instead derived from an events
    // query, which does honour filters.
    const bodies: unknown[] = [];
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          events: {
            count: 1,
            events: [{
              dataset: "cloudflare-workers",
              timestamp: 1,
              source: { route: "/health" },
              $metadata: { id: "e1", service: "api-worker", level: "info" },
            }],
          },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");
    const timeframe = {
      from: new Date("2026-08-14T09:00:00Z"),
      to: new Date("2026-08-14T10:00:00Z"),
    };

    const keys = await api.listKeys({ timeframe });
    const values = await api.listValues("$metadata.service", "string", { timeframe });

    // Both reads are events queries carrying the binding's scope filter, not `keys`/`values` calls.
    expect(urls).toEqual([
      expect.stringContaining("/telemetry/query"),
      expect.stringContaining("/telemetry/query"),
    ]);
    for (const body of bodies) {
      expect(body).toMatchObject({
        view: "events",
        timeframe: { from: timeframe.from.valueOf(), to: timeframe.to.valueOf() },
        parameters: {
          filters: [{ key: "$metadata.service", operation: "eq", value: "api-worker" }],
        },
      });
    }

    // The field names come from walking the sampled events, so only this Worker's fields appear --
    // reported under the name each field is *indexed* under, which for the caller's own log payload
    // is the bare name rather than the `source.` path the event envelope returns it at.
    expect(keys).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "$metadata.service", type: "string" }),
      expect.objectContaining({ key: "route", type: "string" }),
    ]));
    expect(keys.map(entry => entry.key)).not.toContain("source.route");
    expect(values).toEqual([expect.objectContaining({ value: "api-worker" })]);
  });

  it("filters foreign events from Worker-scoped invocations and cursors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 3, bytes_read: 30 },
        invocations: {
          mixed: [
            { dataset: "cloudflare-workers", timestamp: 1, source: { secret: "foreign" }, $metadata: { id: "foreign-cursor", service: "other-worker" } },
            { dataset: "cloudflare-workers", timestamp: 2, source: {}, $metadata: { id: "own-cursor", service: "api-worker" } },
          ],
          foreign: [
            { dataset: "cloudflare-workers", timestamp: 3, source: {}, $metadata: { id: "last-foreign", service: "other-worker" } },
          ],
        },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const page = await api.listInvocations();

    expect(page.invocations).toEqual([{
      requestId: "mixed",
      events: [expect.objectContaining({ $metadata: expect.objectContaining({ id: "own-cursor" }) })],
    }]);
    // The cursor is the provider's own position -- the oldest event it returned, foreign or not.
    // Deriving it from the surviving events instead would stall pagination the moment a page came
    // back entirely foreign: the cursor would be null and the caller would stop early, hiding its own
    // older events. An event id is an opaque position within one account the user already owns; the
    // log content is what must not cross the Worker scope, and none of it does.
    expect(page.nextCursor).toBe("foreign-cursor");
    expect(JSON.stringify(page.invocations)).not.toContain("foreign");
    expect(JSON.stringify(page.invocations)).not.toContain("other-worker");
  });

  it("rejects trace summaries for Worker-scoped bindings before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    await expect(api.listTraces()).rejects.toThrow("account-scoped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops foreign events returned by a Worker-scoped trace query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 2, bytes_read: 20 },
        events: { count: 2, events: [
          { dataset: "cloudflare-workers", timestamp: 1, source: {}, $metadata: { id: "own", service: "api-worker" } },
          { dataset: "cloudflare-workers", timestamp: 2, source: { secret: "foreign" }, $metadata: { id: "foreign", service: "other-worker" } },
        ] },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const trace = await api.getTrace("trace-id");

    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].$metadata.id).toBe("own");
    expect(JSON.stringify(trace)).not.toContain("foreign");
  });

  it("withholds the provider count when it demonstrably ignored the scope filter", async () => {
    // A foreign event proves the filter was not applied, which makes the provider's count a count of
    // the whole account's matching telemetry -- the volume a Worker binding must not learn. The
    // events are still returned, because those we filtered ourselves.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 9000, bytes_read: 90000 },
        events: { count: 5000, events: [
          { dataset: "cloudflare-workers", timestamp: 1, source: {}, $metadata: { id: "own", service: "api-worker" } },
          { dataset: "cloudflare-workers", timestamp: 2, source: {}, $metadata: { id: "foreign", service: "other-worker" } },
        ] },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const page = await api.listEvents();

    expect(page.events).toHaveLength(1);
    expect(page.count).toBeUndefined();
    // The cursor comes from the provider's own last event even though we dropped it: deriving it
    // from the survivors would end pagination early whenever a page's tail was foreign, hiding the
    // caller's own older events. An event id is an opaque position, not log content.
    expect(page.nextCursor).toBe("foreign");
    // Kept deliberately: it describes what our query cost, not how much telemetry matched it.
    expect(page.statistics.rowsRead).toBe(9000);
  });

  it("reports the provider count when the scope filter was honoured", async () => {
    // The counterpart to the test above: withholding the count whenever a Worker binding is in play
    // would lose a genuinely useful figure on the normal path.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
        events: { count: 42, events: [
          { dataset: "cloudflare-workers", timestamp: 1, source: {}, $metadata: { id: "own", service: "api-worker" } },
        ] },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    expect((await api.listEvents()).count).toBe(42);
  });

  it("keeps reporting the provider count for an account-scoped binding", async () => {
    // No Worker scope means no filter to ignore, so there is nothing to distrust.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 2, bytes_read: 20 },
        events: { count: 7, events: [
          { dataset: "cloudflare-workers", timestamp: 1, source: {}, $metadata: { id: "a", service: "one" } },
          { dataset: "cloudflare-workers", timestamp: 2, source: {}, $metadata: { id: "b", service: "two" } },
        ] },
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const page = await api.listEvents();

    expect(page.events).toHaveLength(2);
    expect(page.count).toBe(7);
  });

  it("turns non-JSON provider failures into body-safe typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>secret upstream page</html>", {
      status: 502,
      headers: { "content-type": "text/html", "retry-after": "0" },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listKeys().catch(caught => caught);

    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).toContain("status 502");
    expect(String(error)).not.toContain("secret upstream page");
  });

  it("maps malformed successful JSON responses to a gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listKeys()).rejects.toMatchObject({ status: 502 });
  });

  it("joins bounded provider errors without exposing arbitrary response fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [{ message: "first" }, { message: "second" }],
      debug: "secret",
    }, { status: 400 })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listKeys().catch(caught => caught);
    expect(String(error)).toContain("first; second");
    expect(String(error)).not.toContain("secret");
  });

  it("carries the provider's error codes so a failure can be logged without its message", async () => {
    // The message may quote a caller-supplied filter value back at us. Filter values are kept out of
    // the audit trail on purpose (see `summarizeFilter`), so the request log names the codes instead
    // and the message travels only to the caller who caused it.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [
        { code: 7003, message: "Could not route to /accounts/tenant-secret/..." },
        { code: 7000, message: "No route for that URI" },
      ],
    }, { status: 400 })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listKeys().catch(caught => caught);
    expect(error).toBeInstanceOf(CloudflareObservabilityApiError);
    expect(error.codes).toEqual([7003, 7000]);
    expect(String(error)).toContain("No route for that URI");
  });

  it("keeps an uncoded provider message out of the log but returns it to the caller", async () => {
    // Regression: the log used to be gated on `codes.length`, so a provider message with no numeric
    // code -- which Cloudflare does return -- fell through to `{ error }` and was logged in full,
    // stack included. The message must still reach the caller who caused it; only the log withholds.
    const warnings: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(...args));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [{ message: "invalid filter value: alice@example.com" }],
    }, { status: 400 })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listKeys().catch(caught => caught);

    expect(error.codes).toEqual([]);
    expect(error.fromProvider).toBe(true);
    // The caller still gets the diagnostic.
    expect(error.message).toContain("alice@example.com");
    // The audit trail does not -- not in `error`, and not in `errorStack` either.
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).not.toContain("alice@example.com");
    expect(warnings[0]).toMatchObject({ event: "observability.request.failed", status: 400 });
  });

  it("logs its own message in full when the failure is not the provider's", async () => {
    // The counterpart: withholding is scoped to provider text, so a transport failure -- whose
    // message we author -- must still be logged, or the fix would have blinded the audit trail.
    const warnings: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(...args));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    // A transport failure earns a retry, whose backoff has to be driven under fake timers.
    const pending = api.listKeys().catch(caught => caught);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error.fromProvider).toBe(false);
    expect(JSON.stringify(warnings)).toContain("Could not reach the Cloudflare Workers Observability API.");
  });

  it("bounds the codes it retains", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: Array.from({ length: 9 }, (_, index) => ({ code: index, message: `m${index}` })),
    }, { status: 400 })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const error = await api.listKeys().catch(caught => caught);
    expect(error.codes).toEqual([0, 1, 2]);
  });

  it("retries one transient read then returns the result", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: false }, {
        status: 503, headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listKeys()).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the provider asks for longer than the budget allows", async () => {
    // A 429 with a long `Retry-After` cannot be satisfied inside a request: retrying sooner only earns
    // a second 429, and honouring it would hold an agent past any useful deadline. Fail fast instead.
    const fetchSpy = vi.fn(async () => Response.json({ success: false }, {
      status: 429, headers: { "retry-after": "30" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listKeys()).rejects.toMatchObject({ status: 429 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a status that is not retryable", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ success: false }, { status: 403 }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listKeys()).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends the access token as a bearer credential and nothing else", async () => {
    let headers: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ success: true, result: [] });
    }));
    const api = new CloudflareObservabilityApi(async () => "the-token", ACCOUNT_ID);

    await api.listKeys();

    expect(headers!.get("authorization")).toBe("Bearer the-token");
    // A cookie or an `X-Auth-Key`/`X-Auth-Email` pair would be ambient account-wide authority rather
    // than the scoped OAuth grant this binding is limited to.
    expect(headers!.get("cookie")).toBeNull();
    expect(headers!.get("x-auth-key")).toBeNull();
    expect(headers!.get("x-auth-email")).toBeNull();
  });

  it("reads the token per request, so a refresh takes effect without a new binding", async () => {
    const tokens = ["first", "second"];
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ success: true, result: [] });
    }));
    const api = new CloudflareObservabilityApi(async () => tokens.shift() ?? null, ACCOUNT_ID);

    await api.listKeys();
    await api.listKeys();

    expect(seen).toEqual(["Bearer first", "Bearer second"]);
  });

  it("uses the real discovery endpoints for an unfiltered account-wide read", async () => {
    // The inverse of the derived-discovery case: with nothing to constrain, the provider's own `keys`
    // and `values` endpoints are both correct and far cheaper than sampling events.
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ success: true, result: [] });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await api.listKeys();
    await api.listValues("$metadata.service", "string");

    expect(urls).toEqual([
      expect.stringContaining("/telemetry/keys"),
      expect.stringContaining("/telemetry/values"),
    ]);
  });

  it("derives discovery for an account binding as soon as the caller supplies a filter", async () => {
    // `keys`/`values` ignore the `filters` array, so answering a filtered discovery call from them
    // would silently widen it back to the whole account and mislead the agent about its own data.
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 0, bytes_read: 0 },
          events: { count: 0, events: [] },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);
    const filter: ObservabilityFilter = {
      kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "error",
    };

    await api.listKeys({ filter });

    expect(urls).toEqual([expect.stringContaining("/telemetry/query")]);
  });

  it("rejects invalid result limits before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.listEvents({ limit: 0 })).rejects.toThrow("limit");
    await expect(api.listEvents({ limit: 1001 })).rejects.toThrow("limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests calculation series only when explicitly requested or given granularity", async () => {
    const bodies: Array<{ chart?: boolean; ignoreSeries?: boolean; granularity?: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10, abr_level: 2 },
          calculations: [{
            calculation: "count", aggregates: [{ value: 10, count: 5, interval: 2, sampleInterval: 4 }], series: [],
          }],
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const aggregateOnly = await api.calculate({ calculations: [{ operator: "count" }] });
    await api.calculate({ calculations: [{ operator: "count" }], includeSeries: true });
    await api.calculate({ calculations: [{ operator: "count" }], granularity: 20 });

    expect(bodies[0]).toMatchObject({ chart: false, ignoreSeries: true });
    expect(bodies[1]).toMatchObject({ chart: true, ignoreSeries: false });
    expect(bodies[2]).toMatchObject({ chart: true, ignoreSeries: false, granularity: 20 });
    expect(aggregateOnly.statistics.abrLevel).toBe(2);
    expect(aggregateOnly.calculations[0].aggregates[0]).toMatchObject({ interval: 2, sampleInterval: 4 });
  });

  it("constrains a Worker-scoped calculation to that Worker", async () => {
    // An aggregate is the one read with no second line of defence: `#scopeEvents` can re-check
    // events after the fact, but a median or a `uniq` computed across services cannot be un-mixed.
    // So the injected `$metadata.service` filter is the *only* thing keeping a Worker binding's
    // aggregate from summarizing the whole account, and it is asserted here for that reason.
    let requestBody: { parameters: { filters: unknown[] } } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          calculations: [{
            calculation: "count",
            aggregates: [{ value: 10, count: 5, interval: 2, sampleInterval: 4 }],
            series: [],
          }],
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    await api.calculate({
      calculations: [{ operator: "count" }],
      filter: {
        kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "error",
      },
    });

    // The Worker condition leads, and the caller's own filter cannot displace or reorder it.
    expect(requestBody?.parameters.filters).toEqual([
      expect.objectContaining({ key: "$metadata.service", operation: "eq", value: "api-worker" }),
      expect.objectContaining({ key: "$metadata.level", value: "error" }),
    ]);
  });

  it("keeps the Worker condition when a calculation groups by service", async () => {
    // A caller that groups by `$metadata.service` must not thereby widen the query: the injected
    // condition still has to be present, so the only group that can come back is this Worker's.
    let requestBody: { parameters: { filters: unknown[]; groupBys?: unknown } } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          calculations: [{
            calculation: "count",
            aggregates: [{
              value: 10, count: 5, interval: 2, sampleInterval: 4,
              groups: [{ key: "$metadata.service", value: "api-worker" }],
            }],
            series: [],
          }],
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    await api.calculate({
      calculations: [{ operator: "count" }],
      groupBys: [{ value: "$metadata.service", type: "string" }],
    });

    expect(requestBody?.parameters.filters).toEqual([
      expect.objectContaining({ key: "$metadata.service", operation: "eq", value: "api-worker" }),
    ]);
    // The group-by really was sent, so the filter above is what keeps the result to one service
    // rather than the group-by having been quietly dropped.
    expect(requestBody?.parameters.groupBys)
      .toEqual([{ value: "$metadata.service", type: "string" }]);
  });

  it("rejects a calculation response missing the arrays its type guarantees", async () => {
    // `aggregates` and `series` are non-optional, so passing this through would hand the agent an
    // object whose type promises arrays that are absent -- a raw TypeError inside gadget code where a
    // typed 502 belongs. This exact payload used to be accepted.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 1 },
        calculations: [{ calculation: "count" }],
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.calculate({ calculations: [{ operator: "count" }] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("rejects non-numeric aggregate leaves", async () => {
    // The agent formats and reasons over these as numbers.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 1 },
        calculations: [{
          calculation: "count",
          aggregates: [{ value: "12", count: 1, interval: 1, sampleInterval: 1 }],
          series: [],
        }],
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.calculate({ calculations: [{ operator: "count" }] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("rejects a malformed series bucket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 1 },
        calculations: [{
          calculation: "count",
          aggregates: [],
          series: [{ time: "2026-08-17T00:00:00Z", data: [{ value: 1 }] }],
        }],
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    await expect(api.calculate({ calculations: [{ operator: "count" }] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("keeps validated group identity on aggregates", async () => {
    // `groups` is how a caller tells which slice an aggregate belongs to, so it is narrowed rather
    // than passed through -- and it has to survive that narrowing intact.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 1 },
        calculations: [{
          calculation: "count",
          alias: "hits",
          aggregates: [{
            value: 3, count: 3, interval: 1, sampleInterval: 1,
            groups: [{ key: "$metadata.service", value: "api-worker" }],
          }],
          series: [{
            time: "2026-08-17T00:00:00Z",
            data: [{ value: 1, count: 1, interval: 1, sampleInterval: 1 }],
          }],
        }],
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const result = await api.calculate({ calculations: [{ operator: "count" }] });

    expect(result.calculations[0].alias).toBe("hits");
    expect(result.calculations[0].aggregates[0].groups)
      .toEqual([{ key: "$metadata.service", value: "api-worker" }]);
    expect(result.calculations[0].series[0].data[0].value).toBe(1);
  });

  it("drops unknown properties from a calculation response", async () => {
    // Same reason the request side rebuilds field-by-field: extra properties survive RPC validation,
    // and this is a trust boundary.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 1 },
        calculations: [{
          calculation: "count", aggregates: [], series: [], internalCursor: "secret",
        }],
      },
    })));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);

    const result = await api.calculate({ calculations: [{ operator: "count" }] });

    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("paginates trace events to a bounded result", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      page++;
      const count = page === 1 ? 100 : 1;
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: count, bytes_read: count * 10 },
          events: {
            count: 101,
            events: Array.from({ length: count }, (_, index) => ({
              dataset: "cloudflare-workers",
              timestamp: index,
              source: {},
              $metadata: { id: `event-${page}-${index}`, service: "api-worker" },
            })),
          },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const trace = await api.getTrace("trace-id");

    expect(trace.events).toHaveLength(101);
    expect(trace.count).toBe(101);
    expect(trace.truncated).toBe(false);
    expect(page).toBe(2);
  });

  it("continues trace pagination when response filtering shortens a full provider page", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      page++;
      const events = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            dataset: "cloudflare-workers", timestamp: index, source: {},
            $metadata: {
              id: `event-1-${index}`,
              service: index === 99 ? "other-worker" : "api-worker",
            },
          }))
        : [{
            dataset: "cloudflare-workers", timestamp: 101, source: {},
            $metadata: { id: "event-2-0", service: "api-worker" },
          }];
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: events.length, bytes_read: 10 },
          events: { count: 101, events },
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const trace = await api.getTrace("trace-id");

    expect(trace.events).toHaveLength(100);
    expect(trace.events.at(-1)?.$metadata.id).toBe("event-2-0");
    expect(trace.truncated).toBe(false);
    expect(page).toBe(2);
  });

  it("does not mark an exact full trace page as truncated when the total is known", async () => {
    const fetchSpy = vi.fn(async () => Response.json({
      success: true,
      result: {
        statistics: { elapsed: 0.01, rows_read: 100, bytes_read: 1000 },
        events: {
          count: 100,
          events: Array.from({ length: 100 }, (_, index) => ({
            dataset: "cloudflare-workers", timestamp: index, source: {},
            $metadata: { id: `event-${index}`, service: "api-worker" },
          })),
        },
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const trace = await api.getTrace("trace-id");

    expect(trace.events).toHaveLength(100);
    expect(trace.truncated).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("indexed field names", () => {
  // Cloudflare indexes a caller's structured log fields under their bare name and only nests them
  // beneath `source` when returning them: `logger.warn(msg, {event: "x"})` is queried as `event`.
  // Confirmed two ways against the live API -- `/telemetry/keys` reports `event`/`component`/`level`
  // and no `source.*` key at all -- and by the docs' "Logging structured JSON objects" table, where
  // `console.log({user_id: 123})` is filterable as `user_id`.
  //
  // This is a regression guard for a real failure: discovery reported `source.event`, an agent
  // filtered on exactly what it had discovered, and the provider accepted the unknown key, matched
  // nothing, and returned an empty page with no error -- after scanning the full timeframe.
  const eventWithLogFields = {
    dataset: "cloudflare-workers",
    timestamp: 1,
    source: {
      level: "warn",
      component: "workshop.server",
      event: "user_do.reset.surfaced",
      exception: { name: "Error" },
    },
    $metadata: { id: "e1", service: "api-worker", level: "warn" },
  };

  function stubEvents(): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          events: { count: 1, events: [eventWithLogFields] },
        },
      });
    }));
    return { bodies };
  }

  it("maps a returned envelope path to the name the field is indexed under", () => {
    expect(observabilityFieldKey("source.event")).toBe("event");
    expect(observabilityFieldKey("source.exception.name")).toBe("exception.name");
    // Namespaces that really are addressed by their dotted path are left alone.
    expect(observabilityFieldKey("$metadata.service")).toBe("$metadata.service");
    expect(observabilityFieldKey("$workers.cpuTimeMs")).toBe("$workers.cpuTimeMs");
    expect(observabilityFieldKey("event")).toBe("event");
    // Only the leading segment is a prefix; an inner `source.` is part of the field name.
    expect(observabilityFieldKey("outer.source.event")).toBe("outer.source.event");
  });

  it("derives discoverable keys under their indexed names", async () => {
    stubEvents();
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    const keys = (await api.listKeys()).map(entry => entry.key);

    expect(keys).toEqual(expect.arrayContaining([
      "event", "component", "level", "exception.name", "$metadata.service",
    ]));
    expect(keys.filter(key => key.startsWith("source."))).toEqual([]);
  });

  it("finds values for a field discovered under its indexed name", async () => {
    stubEvents();
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    // The exact round trip that failed: discover `event`, then ask for its values.
    const values = await api.listValues("event", "string");

    expect(values).toEqual([expect.objectContaining({
      key: "event", value: "user_do.reset.surfaced",
    })]);
  });

  it("accepts the envelope path as an alias when reading values", async () => {
    stubEvents();
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    // An agent that copied the path out of a `listEvents` result gets the same answer, reported
    // under the indexed name so the two spellings cannot diverge in later calls.
    const values = await api.listValues("source.event", "string");

    expect(values).toEqual([expect.objectContaining({
      key: "event", value: "user_do.reset.surfaced",
    })]);
  });

  it("rewrites a caller filter's envelope paths before sending them", async () => {
    const { bodies } = stubEvents();
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    await api.listEvents({
      filter: {
        kind: "group",
        filterCombination: "and",
        filters: [
          { kind: "filter", key: "source.event", operation: "eq", type: "string", value: "x" },
          { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "warn" },
        ],
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      parameters: {
        filters: [
          // The binding's own scope condition is never rewritten.
          { key: "$metadata.service", operation: "eq", value: "api-worker" },
          {
            kind: "group",
            filters: [
              { key: "event", operation: "eq", value: "x" },
              { key: "$metadata.level", operation: "eq", value: "warn" },
            ],
          },
        ],
      },
    });
  });

  it("rewrites envelope paths in calculations and group-bys", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        success: true,
        result: {
          statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 10 },
          calculations: [],
        },
      });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");

    await api.calculate({
      calculations: [{ operator: "uniq", key: "source.event", keyType: "string", alias: "kinds" }],
      groupBys: [{ value: "source.component", type: "string" }],
    });

    expect(bodies[0]).toMatchObject({
      parameters: {
        calculations: [{ operator: "uniq", key: "event", keyType: "string", alias: "kinds" }],
        groupBys: [{ value: "component", type: "string" }],
      },
    });
  });

  it("keeps a scope filter alongside a rewritten caller key", () => {
    const filter: ObservabilityFilter = {
      kind: "filter", key: "source.event", operation: "eq", type: "string", value: "x",
    };

    expect(scopeObservabilityFilters("api-worker", filter)).toEqual([
      { kind: "filter", key: "$metadata.service", operation: "eq", type: "string", value: "api-worker" },
      { kind: "filter", key: "event", operation: "eq", type: "string", value: "x" },
    ]);
  });
});
