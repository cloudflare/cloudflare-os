// Covers the guarantee the README makes and nothing previously tested: every read a session returns
// is recorded on the approval queue. Deleting the `authorizeObservation` await in
// `observability-session.ts` must fail this file.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareObservabilityApi } from "../../src/observability-api";
import {
  CloudflareObservabilitySessionImpl,
  summarizeFilter,
} from "../../src/observability-session";
import type { CloudflareObservabilityFilter } from "../../src/types";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TEST_NOW = new Date("2026-08-14T12:00:00Z");

type Observation = { title: string; description: string };

class TestApprovalQueue extends RpcTarget {
  readonly observations: Observation[] = [];
  disposed = 0;

  async authorizeObservation(entry: Observation): Promise<void> {
    this.observations.push(entry);
  }

  [Symbol.dispose](): void {
    this.disposed++;
  }
}

const STATISTICS = { elapsed: 1, rows_read: 10, bytes_read: 100 };

function event(id: string, service = "api-worker") {
  return {
    dataset: "cloudflare-workers",
    timestamp: TEST_NOW.valueOf(),
    source: { message: "hello" },
    $metadata: { id, service, level: "info", traceId: "trace-1" },
  };
}

/** One provider response for every view the session can request. */
function stubProvider() {
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result: Record<string, unknown> = { statistics: STATISTICS };
    if (body.view === "events") result.events = { count: 1, events: [event("e1")] };
    if (body.view === "invocations") result.invocations = { "req-1": [event("e1")] };
    if (body.view === "traces") {
      result.traces = [{
        traceId: "trace-1", traceStartMs: 1, traceEndMs: 2, traceDurationMs: 1,
        rootSpanName: "fetch", rootTransactionName: "GET /", service: ["api-worker"], spans: 1,
      }];
    }
    if (body.view === "calculations") {
      result.calculations = [{
        calculation: "count",
        aggregates: [{ value: 1, count: 1, interval: 1, sampleInterval: 1 }],
        series: [],
      }];
    }
    if (body.key !== undefined) {
      return Response.json({ success: true, result: [{ key: body.key, type: "string", value: "x", dataset: "cloudflare-workers" }] });
    }
    if (body.view === undefined) {
      return Response.json({ success: true, result: [{ key: "$metadata.level", type: "string", lastSeenAt: 1 }] });
    }
    return Response.json({ success: true, result });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function newSession(workerName?: string) {
  const queue = new TestApprovalQueue();
  const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID, workerName);
  const session = new CloudflareObservabilitySessionImpl(
    api, new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>,
    workerName ? `Worker ${workerName}` : `Cloudflare account ${ACCOUNT_ID}`,
  );
  return { queue, session };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("observation authorization", () => {
  // Parameterized so a method added later without an `#observe` wrapper is a visible omission here
  // rather than a silent gap.
  const reads: Array<[string, (session: CloudflareObservabilitySessionImpl) => Promise<unknown>]> = [
    ["listKeys", session => session.listKeys()],
    ["listValues", session => session.listValues("$metadata.level", "string")],
    ["listEvents", session => session.listEvents()],
    ["listInvocations", session => session.listInvocations()],
    ["listTraces", session => session.listTraces()],
    ["getTrace", session => session.getTrace("trace-1")],
    ["calculate", session => session.calculate({ calculations: [{ operator: "count" }] })],
  ];

  it.each(reads)("%s records exactly one observation", async (_name, read) => {
    stubProvider();
    const { queue, session } = newSession();

    await read(session);

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.title).toBeTruthy();
    expect(queue.observations[0]!.description).toContain(ACCOUNT_ID);
  });

  it("records the observation even when the read returned nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ success: true, result: { statistics: STATISTICS, events: { count: 0, events: [] } } })));
    const { queue, session } = newSession();

    await session.listEvents();

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.description).toContain("returned 0 events");
  });

  it("does not record an observation when the read failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 403 })));
    const { queue, session } = newSession();

    await expect(session.listEvents()).rejects.toThrow(/403|nope/);
    expect(queue.observations).toEqual([]);
  });

  it("reports scan cost so an approver can see what a read consumed", async () => {
    stubProvider();
    const { queue, session } = newSession();

    await session.listEvents();

    expect(queue.observations[0]!.description).toContain("10 rows and 100 bytes scanned");
  });
});

describe("session lifetime", () => {
  it("releases the approval queue when disposed", async () => {
    stubProvider();
    const { session } = newSession();

    session[Symbol.dispose]();

    // Released means the queue stub is gone, so no further read can be authorized -- and since
    // `#observe` authorizes before returning, no further read can succeed either.
    await expect(session.listEvents()).rejects.toThrow();
  });

  it("authorizes reads right up until it is disposed", async () => {
    stubProvider();
    const { queue, session } = newSession();

    await session.listEvents();
    session[Symbol.dispose]();

    expect(queue.observations).toHaveLength(1);
  });
});

describe("approval descriptions", () => {
  it("names the fields and operations read, and never the caller's values", () => {
    const filter: CloudflareObservabilityFilter = {
      kind: "group",
      filterCombination: "and",
      filters: [
        { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "secret-value" },
        { kind: "filter", key: "$metadata.statusCode", operation: "gte", type: "number", value: 500 },
      ],
    };

    const summary = summarizeFilter(filter);

    expect(summary).toBe("$metadata.level eq, $metadata.statusCode gte");
    expect(summary).not.toContain("secret-value");
  });

  it("marks an OR combination so the entry is not read as a conjunction", () => {
    expect(summarizeFilter({
      kind: "group",
      filterCombination: "or",
      filters: [
        { kind: "filter", key: "a", operation: "exists", type: "string" },
        { kind: "filter", key: "b", operation: "exists", type: "string" },
      ],
    })).toBe("a exists or b exists");
  });

  it("bounds a large filter rather than pasting it into the queue", () => {
    const summary = summarizeFilter({
      kind: "group",
      filterCombination: "and",
      filters: Array.from({ length: 30 }, (_unused, index) => ({
        kind: "filter" as const,
        key: `field${index}`,
        operation: "exists" as const,
        type: "string" as const,
      })),
    });

    expect(summary).toMatch(/, \.\.\.$/);
    expect(summary.split(",").length).toBeLessThanOrEqual(7);
  });

  it("says so when there is no filter", () => {
    expect(summarizeFilter()).toBe("none");
  });
});
