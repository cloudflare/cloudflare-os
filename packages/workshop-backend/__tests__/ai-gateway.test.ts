import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiGatewayConfig,
  AiGatewayLogRetryableError,
  getAiGatewayLogCost,
} from "../src/ai-gateway.js";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    WORKERS_AI: {} as Ai,
    ...overrides,
  } as Cloudflare.Env;
}

describe("AiGatewayConfig transport selection", () => {
  const binding = { gateway: () => ({}) } as unknown as Ai;
  // google needs the HTTPS+token transport, so token-less configs must not enable it.
  const bindingOnly = env({
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare",
    WORKERS_AI: binding,
  });

  it("uses the binding for every provider except google", () => {
    const config = new AiGatewayConfig(bindingOnly);
    expect(config.apiToken).toBeUndefined();
    expect(config.bindingFor("anthropic")).toBe(binding);
    expect(config.bindingFor("openai")).toBe(binding);
    expect(config.bindingFor("cloudflare")).toBe(binding);
    expect(config.bindingFor("google")).toBeUndefined();
  });

  it("falls back to HTTPS with the token when the binding is absent", () => {
    const config = new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      WORKERS_AI: undefined,
    }));
    expect(config.apiToken).toBe("gateway-token");
    expect(config.bindingFor("anthropic")).toBeUndefined();
  });

  it("ignores the binding when CF_AI_GATEWAY_USE_BINDING=false opts out", () => {
    // The cross-account shape (e.g. the internal production Workshop): WORKERS_AI is injected
    // for webFetch, but the gateway lives in a different account, so the deployment opts out
    // and gateway traffic rides HTTPS with the token.
    const config = new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_USE_BINDING: "false",
      WORKERS_AI: binding,
    }));
    expect(config.binding).toBeUndefined();
    expect(config.apiToken).toBe("gateway-token");
    expect(config.bindingFor("anthropic")).toBeUndefined();
    expect(config.bindingFor("openai")).toBeUndefined();
  });

  it("opts out on a padded, mixed-case CF_AI_GATEWAY_USE_BINDING", () => {
    const config = new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_USE_BINDING: " False ",
      WORKERS_AI: binding,
    }));
    expect(config.binding).toBeUndefined();
    expect(config.bindingFor("anthropic")).toBeUndefined();
  });

  it("still requires a transport when the opt-out leaves no token", () => {
    expect(() => new AiGatewayConfig({
      ...bindingOnly,
      CF_AI_GATEWAY_USE_BINDING: "false",
    })).toThrow("AI Gateway mode needs a transport");
  });

  it("rejects an explicit CF_AI_GATEWAY_USE_BINDING=true without the WORKERS_AI binding", () => {
    expect(() => new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_USE_BINDING: "true",
      WORKERS_AI: undefined,
    }))).toThrow("CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding");
  });

  it("requires the account id", () => {
    expect(() => new AiGatewayConfig(env({ CF_AI_GATEWAY_ACCOUNT_ID: undefined })))
        .toThrow("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
  });

  it("requires a transport", () => {
    expect(() => new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      WORKERS_AI: undefined,
    }))).toThrow("AI Gateway mode needs a transport");
  });

  it("requires the token when google is enabled", () => {
    expect(() => new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      WORKERS_AI: binding,
    }))).toThrow("enabling the google provider requires CF_AI_GATEWAY_API_TOKEN");
  });

  it("resolves the same-account gateway for binding-based callers (webFetch)", () => {
    expect(new AiGatewayConfig(bindingOnly).sameAccountGateway).toBe("platform-gateway");
    expect(new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_USE_BINDING: "false",
      WORKERS_AI: binding,
    })).sameAccountGateway).toBeUndefined();
    // It tracks the binding rather than the opt-out, so an HTTPS-only deployment that never had a
    // binding to opt out of resolves no same-account gateway either.
    expect(new AiGatewayConfig(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      WORKERS_AI: undefined,
    })).sameAccountGateway).toBeUndefined();
  });
});

describe("getAiGatewayLogCost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads cross-account log cost through the REST API", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { cost: 1.25 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log/id")).resolves.toBe(1.25);

    expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/" +
        "ai-gateway/gateways/platform-gateway/logs/log%2Fid",
        {
          headers: { Authorization: "Bearer read-run-token" },
          signal: expect.any(AbortSignal),
        });
  });

  it("uses the binding for same-account log cost", async () => {
    const getLog = vi.fn(async () => ({ cost: 0.5 }));
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id")).resolves.toBe(0.5);

    expect(gateway).toHaveBeenCalledWith("platform-gateway");
    expect(getLog).toHaveBeenCalledWith("log-id");
  });

  it("classifies same-account binding failures as retryable", async () => {
    const getLog = vi.fn(async () => { throw new Error("log not found"); });
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable"); }));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account response body failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("response body reset"); },
    } as Response)));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("rejects failed or malformed cross-account responses", async () => {
    const responses = [
      new Response(null, { status: 403 }),
      Response.json({ success: true, result: { cost: "unknown" } }),
      Response.json({ success: true, result: { cost: -1 } }),
      Response.json({ success: true, result: {} }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 408 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const route = {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    };

    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log request failed with status 403.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });
});
