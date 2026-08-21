import { describe, expect, it } from "vitest";
import {
  collectAgentGatewayUsage,
  parseGatewayEnvironment, usesDirectWorkersAi, type GatewayConfig,
} from "./gateway-logs.js";

const config: GatewayConfig = {
  accountId: "account",
  apiToken: "token",
  gatewayId: "evals",
};

function response(result: readonly object[]): Response {
  return Response.json({ success: true, result, result_info: { total_count: result.length } });
}

function log(id: string, metadata: string, success = true) {
  return {
    id,
    success,
    duration: 12,
    tokens_in: 10,
    tokens_out: 5,
    cost: 0.25,
    metadata,
  };
}

describe("collectAgentGatewayUsage", () => {
  it("filters exact chat attribution and aggregates successful and failed requests", async () => {
    const logs = [
      log("matching-success", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 })),
      log("matching-failure", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }), false),
      log("title", JSON.stringify({ source: "thread-title", gadgetId: "workspace", chatId: 7 })),
      log("other-chat", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 8 })),
      log("other-workspace", JSON.stringify({ source: "chat", gadgetId: "other", chatId: 7 })),
      log("malformed-metadata", "not json"),
    ];
    const fetchBoundary = async () => response(logs);

    await expect(collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 2, intervalMs: 0, stableAttempts: 1 }, fetchBoundary, async () => {}))
        .resolves.toEqual({
      complete: true,
      successfulRequests: 1,
      failedRequests: 1,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      durationMs: 24,
      costUsd: 0.5,
    });
  });

  it("polls until the matching log set is stable", async () => {
    const pages = [
      response([]),
      response([log("one", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }))]),
      response([log("one", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }))]),
    ];
    let request = 0;
    const fetchBoundary = async () => pages.at(request++) ?? response([]);

    const usage = await collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 4, intervalMs: 0, stableAttempts: 1 }, fetchBoundary, async () => {});

    expect(request).toBe(3);
    expect(usage.successfulRequests).toBe(1);
  });

  it("rejects malformed API responses", async () => {
    await expect(collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 1 }, async () => Response.json({ success: true, result: "bad" })))
        .rejects.toThrow("malformed logs");
  });

  it("marks telemetry incomplete when bounded polling observes no matching request", async () => {
    await expect(collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 2, intervalMs: 0 }, async () => response([]), async () => {}))
        .resolves.toMatchObject({ complete: false, successfulRequests: 0, totalTokens: 0 });
  });

  it("does not report complete telemetry while provider cost is unavailable", async () => {
    const pending = {
      ...log("pending-cost", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 })),
      cost: null,
    };
    await expect(collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 2, intervalMs: 0, stableAttempts: 1 },
        async () => response([pending]), async () => {}))
        .resolves.toMatchObject({ complete: false, totalTokens: 15, costUsd: 0 });
  });

  it("refuses to call usage complete when polling never settled", async () => {
    const entry = log("one", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }));
    let request = 0;
    // A different log set on every attempt: the fingerprint never repeats, so it never stabilises.
    const fetchBoundary = async () =>
      response([entry, log(`churn-${request++}`,
          JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }))]);

    await expect(collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 3, intervalMs: 0, stableAttempts: 2 }, fetchBoundary, async () => {}))
        .resolves.toMatchObject({ complete: false });
  });

  it("keeps paginating when the API returns a shorter page than requested", async () => {
    const matching = (id: string) =>
      log(id, JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }));
    // The API caps at 20 despite per_page=100; stopping on a short page would lose page 2 entirely.
    const pages: Record<string, object[]> = {
      "1": Array.from({ length: 20 }, (_unused, index) => matching(`first-${index}`)),
      "2": [matching("second-0")],
    };
    const fetchBoundary = async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input
        : typeof input === "string" ? new URL(input) : new URL(input.url);
      const page = url.searchParams.get("page") ?? "1";
      return Response.json({ success: true, result: pages[page] ?? [], result_info: {} });
    };

    const usage = await collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 1, intervalMs: 0, stableAttempts: 1 }, fetchBoundary, async () => {});
    expect(usage.successfulRequests).toBe(21);
  });

  it("stops paginating once the reported total is collected", async () => {
    const entry = log("one", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }));
    let requests = 0;
    const fetchBoundary = async () => {
      requests++;
      return Response.json({ success: true, result: [entry], result_info: { total_count: 1 } });
    };
    await collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 1, intervalMs: 0, stableAttempts: 1 }, fetchBoundary, async () => {});
    expect(requests).toBe(1);
  });

  it("deduplicates log IDs when concurrent writes shift pagination boundaries", async () => {
    const matching = log(
        "matching", JSON.stringify({ source: "chat", gadgetId: "workspace", chatId: 7 }));
    const firstPage = [matching, ...Array.from({ length: 99 }, (_, index) =>
      log(`other-${index}`, JSON.stringify({ source: "chat", gadgetId: "other", chatId: 7 })))];
    const fetchBoundary = async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input
        : typeof input === "string" ? new URL(input) : new URL(input.url);
      const page = url.searchParams.get("page");
      return page === "1" ? response(firstPage) : response([matching]);
    };
    const usage = await collectAgentGatewayUsage(config, { workspaceId: "workspace", chatId: 7 },
        { attempts: 1, intervalMs: 0 }, fetchBoundary, async () => {});
    expect(usage.successfulRequests).toBe(1);
    expect(usage.totalTokens).toBe(15);
  });
});

describe("parseGatewayEnvironment", () => {
  const credentials = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };

  it("names the missing credential", () => {
    expect(() => parseGatewayEnvironment({ CLOUDFLARE_ACCOUNT_ID: "account" }))
        .toThrow("CLOUDFLARE_API_TOKEN");
  });

  it("requires a Gateway when logs will be collected", () => {
    expect(() => parseGatewayEnvironment(credentials))
        .toThrow("WORKSHOP_EVAL_GATEWAY_ID is required");
    expect(parseGatewayEnvironment({ ...credentials, WORKSHOP_EVAL_GATEWAY_ID: "gateway" }))
        .toEqual({ accountId: "account", apiToken: "token", gatewayId: "gateway" });
  });

  it("does not require a Gateway in direct mode, which reads no logs", () => {
    expect(parseGatewayEnvironment({ ...credentials, WORKSHOP_EVAL_WAI_DIRECT: "true" }))
        .toEqual({ accountId: "account", apiToken: "token", gatewayId: "direct" });
  });

  it("parses explicit local direct mode without accepting misspellings", () => {
    expect(usesDirectWorkersAi({})).toBe(false);
    expect(usesDirectWorkersAi({ WORKSHOP_EVAL_WAI_DIRECT: "true" })).toBe(true);
    expect(() => usesDirectWorkersAi({ WORKSHOP_EVAL_WAI_DIRECT: "yes" })).toThrow("true or false");
  });
});
