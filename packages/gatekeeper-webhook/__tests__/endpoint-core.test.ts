import { describe, expect, it } from "vitest";
import {
  buildEvent,
  hashToken,
  isJsonContentType,
  MAX_BODY_BYTES,
  mintEndpointId,
  mintToken,
  normalizeRegisterOptions,
  paginateManagementEndpoints,
  readBearer,
  retryDelayMs,
  sanitizeHeaders,
  sanitizeQuery,
  timingSafeEqual,
  truncateBody,
} from "../src/endpoint-core.js";
import { parseEndpointPath } from "../src/receiver.js";
import type { ManagementEndpoint } from "../src/management-types.js";

describe("normalizeRegisterOptions", () => {
  it("defaults to POST and trims bounded text", () => {
    const result = normalizeRegisterOptions({ title: "  Stripe  ", description: " events " });
    expect(result).toEqual({ title: "Stripe", description: "events", methods: ["POST"] });
  });

  it("rejects empty title or description", () => {
    expect(() => normalizeRegisterOptions({ title: " ", description: "x" })).toThrow(TypeError);
    expect(() => normalizeRegisterOptions({ title: "x", description: "" })).toThrow(TypeError);
  });

  it("normalizes, de-duplicates, and sorts methods", () => {
    const result = normalizeRegisterOptions({
      title: "t",
      description: "d",
      methods: ["put", "POST", "put"],
    });
    expect(result.methods).toEqual(["POST", "PUT"]);
  });

  it("rejects unsupported methods", () => {
    expect(() =>
      normalizeRegisterOptions({ title: "t", description: "d", methods: ["TRACE"] }),
    ).toThrow(/Unsupported webhook method/);
  });

  it("truncates over-long text rather than rejecting it", () => {
    const result = normalizeRegisterOptions({
      title: "t".repeat(500),
      description: "d".repeat(5000),
    });
    expect(result.title).toHaveLength(200);
    expect(result.description).toHaveLength(2000);
  });
});

describe("tokens", () => {
  it("mints URL-safe IDs of the length the receiver's pattern expects", () => {
    expect(mintEndpointId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("mints distinct tokens", () => {
    expect(mintToken()).not.toEqual(mintToken());
  });

  it("hashes deterministically and never returns the raw token", async () => {
    const token = mintToken();
    const hash = await hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toEqual(await hashToken(token));
    expect(hash).not.toContain(token);
  });

  it("compares equal-length digests without early exit", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("reads a bearer token and rejects other schemes", () => {
    expect(readBearer("Bearer abc-123_x")).toBe("abc-123_x");
    expect(readBearer("bearer abc")).toBeNull();
    expect(readBearer("Basic abc")).toBeNull();
    expect(readBearer(null)).toBeNull();
  });
});

describe("request sanitization", () => {
  it("strips credential headers but keeps signature headers", () => {
    const headers = sanitizeHeaders(
      new Headers({
        Authorization: "Bearer secret",
        Cookie: "session=1",
        "X-Hub-Signature-256": "sha256=abc",
        "Content-Type": "application/json",
      }),
    );
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers["x-hub-signature-256"]).toBe("sha256=abc");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("bounds header values", () => {
    const headers = sanitizeHeaders(new Headers({ "x-long": "v".repeat(5000) }));
    expect(headers["x-long"]).toHaveLength(1024);
  });

  it("keeps the last value for a repeated query key", () => {
    const query = sanitizeQuery(new URLSearchParams("a=1&a=2&b=3"));
    expect(query).toEqual({ a: "2", b: "3" });
  });
});

describe("body handling", () => {
  it("recognizes JSON content types including structured suffixes", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/vnd.github+json")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it("passes short bodies through untouched", () => {
    expect(truncateBody("hello")).toEqual({ body: "hello", truncated: false });
  });

  it("truncates over-long bodies at the byte cap", () => {
    const result = truncateBody("x".repeat(MAX_BODY_BYTES + 100));
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
});

const baseEvent = {
  deliveryId: "d1",
  endpointId: "e1",
  receivedAt: 1000,
  attempt: 1,
  method: "POST",
  subPath: "",
  query: {},
  truncated: false,
};

describe("buildEvent", () => {
  it("parses a JSON body into `json`", () => {
    const event = buildEvent({
      ...baseEvent,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(event.json).toEqual({ a: 1 });
    expect(event.contentType).toBe("application/json");
  });

  it("leaves malformed JSON as body only", () => {
    const event = buildEvent({
      ...baseEvent,
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(event.json).toBeUndefined();
    expect(event.body).toBe("{not json");
  });

  it("never parses a truncated body, which is no longer valid JSON", () => {
    const event = buildEvent({
      ...baseEvent,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
      truncated: true,
    });
    expect(event.json).toBeUndefined();
    expect(event.truncated).toBe(true);
  });

  it("bounds the sub-path", () => {
    const event = buildEvent({ ...baseEvent, headers: {}, body: "", subPath: `/${"x".repeat(500)}` });
    expect(event.subPath).toHaveLength(256);
  });
});

describe("retryDelayMs", () => {
  it("escalates and caps at one hour", () => {
    expect(retryDelayMs(2)).toBe(30_000);
    expect(retryDelayMs(3)).toBe(60_000);
    expect(retryDelayMs(8)).toBe(3_600_000);
    expect(retryDelayMs(50)).toBe(3_600_000);
  });
});

describe("parseEndpointPath", () => {
  const base = "/gatekeeper/webhook";

  it("extracts an endpoint ID", () => {
    expect(parseEndpointPath(`${base}/e/${"a".repeat(22)}`, base)).toEqual({
      endpointId: "a".repeat(22),
      subPath: "",
    });
  });

  it("keeps a trailing sub-path", () => {
    expect(parseEndpointPath(`${base}/e/${"a".repeat(22)}/payments`, base)).toEqual({
      endpointId: "a".repeat(22),
      subPath: "/payments",
    });
  });

  it("rejects malformed IDs and unrelated paths", () => {
    expect(parseEndpointPath(`${base}/e/short`, base)).toBeNull();
    expect(parseEndpointPath(`${base}/other`, base)).toBeNull();
    expect(parseEndpointPath("/elsewhere", base)).toBeNull();
  });
});

function endpoint(id: string, overrides: Partial<ManagementEndpoint> = {}): ManagementEndpoint {
  return {
    endpointId: id,
    title: `Endpoint ${id}`,
    description: "d",
    url: `https://example.com/e/${id}`,
    methods: ["POST"],
    status: "active",
    createdAt: 1000,
    deliveryCount: 0,
    failedCount: 0,
    workspaceId: "w1",
    ...overrides,
  };
}

describe("paginateManagementEndpoints", () => {
  it("filters by status and query", () => {
    const endpoints = [
      endpoint("a", { title: "Stripe events" }),
      endpoint("b", { title: "GitHub pushes", status: "disabled" }),
    ];
    expect(
      paginateManagementEndpoints(endpoints, { statuses: ["disabled"] }).endpoints,
    ).toHaveLength(1);
    expect(paginateManagementEndpoints(endpoints, { query: "stripe" }).endpoints[0].endpointId).toBe(
      "a",
    );
  });

  it("sorts newest first", () => {
    const page = paginateManagementEndpoints([
      endpoint("old", { createdAt: 1 }),
      endpoint("new", { createdAt: 2 }),
    ]);
    expect(page.endpoints.map((item) => item.endpointId)).toEqual(["new", "old"]);
  });

  it("restarts rather than returning nothing when a cursor's endpoint disappeared", () => {
    const page = paginateManagementEndpoints([endpoint("a")], { cursor: "gone" });
    expect(page.endpoints).toHaveLength(1);
  });
});
