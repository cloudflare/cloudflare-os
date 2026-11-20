// The calls this gatekeeper makes to the Web Search API and the name each is counted under, how a
// search is counted where the client cannot know (an answer that is no success, or one that cannot
// be read), and that the binding is called once for each search, with one and the same request.
// The metrics read the Worker's bindings from `cloudflare:workers`, so a dataset set on its `env`
// here records what a search writes.

import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import { VENDOR_ID, WEBSEARCH_OPERATIONS, search, websearchUpstream } from "../src/search.js";

type WebSearch = Ai["websearch"];

const QUERY = "confidential words";
const GATEWAY = "instance-gateway";
// The one request a search of `QUERY` hands the binding.
const REQUEST = { gatewayId: GATEWAY, query: QUERY, provider: "ceramic", limit: 10 };
const RESULT = { title: "Private Title", url: "https://results.example/page", description: "Private text." };

const unavailable = new Error(`binding unavailable for ${QUERY}`);
const slow = new DOMException(`no answer for ${QUERY}`, "TimeoutError");

// Each way a search that was sent ends: how it is counted (the outcome, and the reason of one that
// is no success), what the binding does, and what the search fails with (nothing, for one that
// answers results).
const ENDS: [
  end: string, outcome: string, reason: string, websearch: WebSearch, failure: unknown,
][] = [
  ["results", "success", "", async () => Response.json({ items: [RESULT] }), undefined],
  ["a refusal to pay", "error", "http",
    async () => new Response(`no credits for ${QUERY}`, { status: 402 }),
    new Error("Web search failed with HTTP 402.")],
  ["a rate limit", "refused", "rate",
    async () => new Response(`slow down, ${QUERY}`, { status: 429 }),
    new Error("Web search failed with HTTP 429.")],
  ["an outage", "error", "http", async () => new Response(null, { status: 503 }),
    new Error("Web search failed with HTTP 503.")],
  ["a redirect", "error", "http",
    async () => new Response(null, { status: 302, headers: { Location: "https://results.example/" } }),
    new Error("Web search failed with HTTP 302.")],
  ["a throw of the binding", "error", "exception", async () => { throw unavailable; }, unavailable],
  ["a timeout of the binding", "error", "timeout", async () => { throw slow; }, slow],
  ["a success of another shape", "error", "parse",
    async () => Response.json({ unexpected: QUERY }), expect.objectContaining({ name: "ZodError" })],
  ["a success that is not JSON", "error", "parse",
    async () => new Response(`<html>${QUERY}</html>`), expect.any(SyntaxError)],
];

const ambient = bindings as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its source, service, operation, outcome, reason, detail, HTTP status,
// provider code and number of calls.
function calls() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.detail,
    SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.providerCode, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
}

// Searches for `QUERY` through `websearch` and the gateway `GATEWAY`, with a record that is kept
// unless `audit` says otherwise. Answers what the search failed with, or undefined. `AI` is the
// binding the search is given, where a test looks at it.
async function searched(
  websearch: WebSearch, query = QUERY, audit: () => Promise<void> = async () => {},
  AI: Pick<Ai, "websearch"> = { websearch },
): Promise<unknown> {
  try {
    await search({ AI, CF_AI_GATEWAY: GATEWAY }, query, audit);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("the names of Web Search's calls", () => {
  it("counts under the vendor's source and service", () => {
    expect(VENDOR_ID).toBe("websearch");
    expect(websearchUpstream.vendorId).toBe(VENDOR_ID);
    expect(websearchUpstream.source).toBe("gatekeeper.websearch.api");
  });

  it("uses every name it declares, and no other, however a search ends", async () => {
    for (const [, , , websearch] of ENDS) await searched(websearch);

    const used = new Set(calls().map(([, , operation]) => operation));
    expect([...used].toSorted()).toEqual(WEBSEARCH_OPERATIONS.toSorted());
    expect(new Set(WEBSEARCH_OPERATIONS).size).toBe(WEBSEARCH_OPERATIONS.length);
  });
});

describe("the binding's call", () => {
  it.each(ENDS)("is made once, with the search's one request, for a search that ends in %s",
      async (_end, _outcome, _reason, answer) => {
    const websearch = vi.fn(answer);
    const AI = { websearch };

    await searched(websearch, QUERY, undefined, AI);

    expect(websearch.mock.calls).toEqual([[REQUEST]]);
    // As a method of the binding, which is what it is called on.
    expect(websearch.mock.contexts).toHaveLength(1);
    expect(websearch.mock.contexts[0]).toBe(AI);
  });
});

describe("the points of a search", () => {
  it.each(ENDS)("counts a search that ends in %s once, as %s %s, and fails it as the search fails",
      async (_end, outcome, reason, websearch, failure) => {
    expect(await searched(websearch)).toEqual(failure);

    expect(calls()).toEqual([["gatekeeper.websearch.api", "websearch", "search", outcome, reason, "", 0, 0, 1]]);
  });

  it("counts a search whose answer is no response as one that was sent and failed", async () => {
    // A binding that breaks its type: what it answers is parsed, so that it is typed as anything.
    const websearch = vi.fn<WebSearch>(async () => JSON.parse("null"));

    expect(await searched(websearch)).toBeInstanceOf(TypeError);

    expect(websearch).toHaveBeenCalledOnce();
    expect(calls()).toEqual([["gatekeeper.websearch.api", "websearch", "search", "error", "exception", "", 0, 0, 1]]);
  });

  it("fails with what the binding threw, itself", async () => {
    expect(await searched(async () => { throw unavailable; })).toBe(unavailable);
    expect(await searched(async () => { throw slow; })).toBe(slow);
  });

  it("counts nothing for a search that is not sent", async () => {
    const websearch = vi.fn<WebSearch>(async () => Response.json({ items: [] }));

    expect(await searched(websearch, "")).toBeInstanceOf(Error);
    expect(await searched(websearch, "q".repeat(1025))).toBeInstanceOf(Error);
    expect(await searched(websearch, QUERY, async () => { throw new Error("refused"); }))
      .toEqual(new Error("refused"));

    expect(websearch).not.toHaveBeenCalled();
    expect(points).toEqual([]);
  });

  it("writes nothing of a query, a gateway, a result or a failure", async () => {
    for (const [, , , websearch] of ENDS) await searched(websearch);

    const written = JSON.stringify(points);
    expect(points).toHaveLength(ENDS.length);
    for (const held of [
      "confidential", GATEWAY, "ceramic", "Private", "results.example", "unavailable", "credits",
      "no answer", "unexpected", "html", "Web search failed",
    ]) {
      expect(written).not.toContain(held);
    }
  });
});
