import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reportIssue,
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  MAX_ATTRIBUTE_KEYS,
  MAX_STRING_CHARS,
  type ErrorEventV1,
} from "../src/error-reporting.js";

type TestReporter = NonNullable<typeof env.ERROR_REPORTER> & {
  clear(): Promise<void>;
  getLast(): Promise<ErrorEventV1 | undefined>;
};

const reporter = env.ERROR_REPORTER as TestReporter;

function thrownFunction() {}

describe("reportIssue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches the complete ErrorEventV1 contract", async () => {
    await reporter.clear();
    const error = new Error("boom");
    error.name = "APICallError";

    reportIssue("overseer.run-agent", error, {
      handled: true,
      severity: "warning",
      correlation: { rayId: "ray" },
      http: { kind: "client", method: "POST", responseStatusCode: 503 },
      attributes: { retryable: true },
    });
    const event = await reporter.getLast();

    expect(event).toMatchObject({
      schemaVersion: 1,
      failureSite: "overseer.run-agent",
      severity: "warning",
      handled: true,
      exception: { type: "APICallError", message: "boom" },
      correlation: { rayId: "ray" },
      http: { kind: "client", method: "POST", responseStatusCode: 503 },
      attributes: { retryable: true },
    });
    expect(event?.occurrenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event?.occurredAt ?? ""))).toBe(false);
    expect(event?.exception?.stack).toMatch(/Error: boom/);
    expect(event?.truncated).toBeUndefined();
    expect(event?.exception?.truncated).toBeUndefined();
  });

  it("normalizes optional correlation and HTTP fields", async () => {
    await reporter.clear();

    reportIssue("site", new Error("boom"), {
      correlation: { requestId: "req-1" },
      http: { kind: "server", routeTemplate: "/a/:id", responseStatusCode: 0 },
    });
    const event = await reporter.getLast();

    expect(event?.correlation).toEqual({ requestId: "req-1" });
    expect(event?.http).toEqual({
      kind: "server", routeTemplate: "/a/:id", responseStatusCode: 0,
    });
  });

  it("bounds retained strings and marks both truncation levels", async () => {
    await reporter.clear();
    const error = new Error("m".repeat(MAX_MESSAGE_CHARS + 1));
    error.name = "n".repeat(MAX_STRING_CHARS + 1);
    error.stack = "s".repeat(MAX_STACK_CHARS + 1);

    reportIssue("f".repeat(MAX_STRING_CHARS + 1), error);
    const event = await reporter.getLast();

    expect(event?.failureSite).toHaveLength(MAX_STRING_CHARS);
    expect(event?.exception?.type).toHaveLength(MAX_STRING_CHARS);
    expect(event?.exception?.message).toHaveLength(MAX_MESSAGE_CHARS);
    expect(event?.exception?.stack).toHaveLength(MAX_STACK_CHARS);
    expect(event?.exception?.truncated).toBe(true);
    expect(event?.truncated).toBe(true);
  });

  it("bounds scalar attributes without invoking getters or mutating prototypes", async () => {
    await reporter.clear();
    const attributes: Record<string, unknown> = Object.fromEntries([["__proto__", "safe"]]);
    Object.defineProperty(attributes, "getter", {
      get() { throw new Error("getter invoked"); },
      enumerable: true,
    });
    attributes.nested = { secret: "do not traverse" };
    attributes.when = new Date();
    for (let i = 0; i < MAX_ATTRIBUTE_KEYS + 1; i++) attributes[`k${i}`] = i;

    reportIssue("site", new Error("boom"), { attributes });
    const event = await reporter.getLast();

    expect(Object.keys(event?.attributes ?? {})).toHaveLength(MAX_ATTRIBUTE_KEYS);
    expect(event?.attributes).not.toHaveProperty("nested");
    expect(event?.attributes).not.toHaveProperty("when");
    expect(event?.attributes?.__proto__).toBe("safe");
    expect(event?.truncated).toBe(true);
    expect(Object.getPrototypeOf(event?.attributes)).toBe(Object.prototype);
  });

  it("normalizes primitive, opaque, null, undefined, and function throws", async () => {
    const cases: Array<[unknown, ErrorEventV1["exception"]]> = [
      ["boom", { type: "stringThrown", message: "boom" }],
      [{}, { type: "Object" }],
      [null, { type: "NullThrown" }],
      [undefined, { type: "undefinedThrown", message: "undefined" }],
      [thrownFunction, { type: "FunctionThrown" }],
    ];

    for (const [caught, expected] of cases) {
      await reporter.clear();
      reportIssue("site", caught);
      expect((await reporter.getLast())?.exception).toEqual(expected);
    }
  });

  it("isolates the caller from a rejecting reporter and logs the drop", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    expect(() => reportIssue("reporter-failure", new Error("boom"))).not.toThrow();

    await vi.waitFor(() => expect(debugSpy).toHaveBeenCalled());
    expect(debugSpy.mock.calls.map(([entry]) => entry?.event))
      .toContain("error_report.dispatch.failed");
  });

  it("is a silent no-op when ERROR_REPORTER is unbound", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const saved = env.ERROR_REPORTER;
    delete env.ERROR_REPORTER;
    try {
      expect(() => reportIssue("site", new Error("boom"))).not.toThrow();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      env.ERROR_REPORTER = saved;
    }
  });
});
