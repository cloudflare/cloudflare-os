import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareObservabilityApi,
  scopeObservabilityFilters,
  type ObservabilityFilter,
} from "../src/observability-api";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TEST_NOW = new Date("2026-08-14T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("uses endpoint-specific keys and values request shapes", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true, result: [] });
    }));
    const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, "api-worker");
    const timeframe = {
      from: new Date("2026-08-14T09:00:00Z"),
      to: new Date("2026-08-14T10:00:00Z"),
    };

    await api.listKeys({ timeframe });
    await api.listValues("$metadata.service", "string", { timeframe });

    expect(bodies[0]).toMatchObject({
      from: timeframe.from.valueOf(),
      to: timeframe.to.valueOf(),
      filters: [{
        kind: "group",
        filterCombination: "and",
        filters: [{ key: "$metadata.service", operation: "eq", value: "api-worker" }],
      }],
    });
    expect(bodies[0]).not.toHaveProperty("filterCombination");
    expect(bodies[0]).not.toHaveProperty("timeframe");
    expect(bodies[1]).toMatchObject({
      timeframe: { from: timeframe.from.valueOf(), to: timeframe.to.valueOf() },
      key: "$metadata.service",
      type: "string",
      filters: [{
        kind: "group",
        filterCombination: "and",
        filters: [{ key: "$metadata.service", operation: "eq", value: "api-worker" }],
      }],
    });
    expect(bodies[1]).not.toHaveProperty("filterCombination");
    expect(bodies[1]).not.toHaveProperty("from");
    expect(bodies[1]).not.toHaveProperty("to");
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
    expect(page.nextCursor).toBe("own-cursor");
    expect(JSON.stringify(page)).not.toContain("foreign");
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
