import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvalModel } from "./config.js";
import type { LocalModelAccess } from "./target.js";

type CapturedConfig = {
  account_id?: string;
  ai?: { binding: string; remote?: boolean };
  vars?: Record<string, string>;
};

type StartOptions = {
  patchWorkshop?: (config: CapturedConfig) => void;
};

const fakes = vi.hoisted(() => {
  const requestUrls: string[] = [];
  const responseStatuses: number[] = [];
  const configs: CapturedConfig[] = [];
  const session = { close: vi.fn(() => Promise.resolve()) };
  return {
    requestUrls,
    configs,
    responseStatuses,
    session,
    openSession: vi.fn(() => Promise.resolve(session)),
    server: { close: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock("@gadgets/integration-tests/agent-session", () => ({
  openAgentSession: fakes.openSession,
}));

vi.mock("@gadgets/integration-tests/harness", () => ({
  startHarness: vi.fn((options: StartOptions) => {
    const config: CapturedConfig = {};
    options.patchWorkshop?.(config);
    fakes.configs.push(config);
    return Promise.resolve({
      url: new URL("http://127.0.0.1:8787"),
      server: fakes.server,
    });
  }),
}));

import { openLocalEvalTarget } from "./target.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  fakes.requestUrls.splice(0);
  fakes.responseStatuses.splice(0);
  fakes.configs.splice(0);
  fakes.openSession.mockImplementation(async () => {
    for (const url of fakes.requestUrls) {
      const method = url.includes("/logs/") ? "GET" : "POST";
      fakes.responseStatuses.push((await fetch(url, { method })).status);
    }
    return fakes.session;
  });
  fakes.session.close.mockImplementation(() => Promise.resolve());
  fakes.server.close.mockImplementation(() => Promise.resolve());
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

const WORKERS_AI_MODEL: EvalModel = { provider: "cloudflare", model: "@cf/zai-org/glm-5.2" };
const DIRECT: LocalModelAccess = { kind: "direct", accountId: "account-id", apiToken: "token" };
const BINDING: LocalModelAccess = {
  kind: "gateway", gateway: "gateway", accountId: "account-id", transport: "binding",
};
const BINDING_WITH_TOKEN: LocalModelAccess = { ...BINDING, apiToken: "token" };
const HTTPS: LocalModelAccess = {
  kind: "gateway", gateway: "gateway", accountId: "account-id", transport: "https",
  apiToken: "token",
};

const WORKERS_AI_INFERENCE_URL =
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/v1/chat/completions";
const COST_LOG_URL =
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id";

async function run(access: LocalModelAccess, model: EvalModel = WORKERS_AI_MODEL): Promise<void> {
  const opened = await openLocalEvalTarget(access, model, 25);
  await opened[Symbol.asyncDispose]();
}

it("allows the direct Workers AI route", async () => {
  fakes.requestUrls.push(
      "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions");

  await run(DIRECT);

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.responseStatuses).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes over HTTPS", async () => {
  fakes.requestUrls.push(WORKERS_AI_INFERENCE_URL, COST_LOG_URL);

  await run(HTTPS);

  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(fakes.configs).toEqual([{
    vars: {
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      CF_AI_GATEWAY_USE_BINDING: "false",
    },
  }]);
  expect(fakes.responseStatuses).toEqual([204, 204]);
});

it("keeps HTTPS model routes closed in binding mode", async () => {
  fakes.requestUrls.push(WORKERS_AI_INFERENCE_URL, COST_LOG_URL);

  await run(BINDING);

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.configs).toEqual([{
    account_id: "account-id",
    ai: { binding: "WORKERS_AI", remote: true },
    vars: {
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      CF_AI_GATEWAY_USE_BINDING: "true",
    },
  }]);
  expect(fakes.responseStatuses).toEqual([403, 403]);
});

it("keeps HTTPS model routes closed in binding mode even when a token is available", async () => {
  fakes.requestUrls.push(WORKERS_AI_INFERENCE_URL, COST_LOG_URL);

  await run(BINDING_WITH_TOKEN);

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.configs).toEqual([{
    account_id: "account-id",
    ai: { binding: "WORKERS_AI", remote: true },
    vars: {
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      CF_AI_GATEWAY_USE_BINDING: "true",
    },
  }]);
  expect(fakes.responseStatuses).toEqual([403, 403]);
});

it("opens only the HTTPS inference route for an HTTPS-only provider in binding mode", async () => {
  fakes.requestUrls.push(
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/google-ai-studio/v1beta/models/gemini-3.6-flash:streamGenerateContent",
    WORKERS_AI_INFERENCE_URL,
    COST_LOG_URL,
  );

  await run(BINDING_WITH_TOKEN, { provider: "google", model: "gemini-3.6-flash" });

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.configs).toEqual([{
    account_id: "account-id",
    ai: { binding: "WORKERS_AI", remote: true },
    vars: {
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_PROVIDERS: "google",
      CF_AI_GATEWAY_USE_BINDING: "true",
    },
  }]);
  expect(fakes.responseStatuses).toEqual([204, 403, 403]);
});

it("scopes HTTPS inference to the model's own gateway route", async () => {
  fakes.requestUrls.push(
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/anthropic/v1/messages",
    WORKERS_AI_INFERENCE_URL,
  );

  await run(HTTPS, { provider: "anthropic", model: "claude-sonnet-5" });

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.configs[0]?.vars?.CF_AI_GATEWAY_PROVIDERS).toBe("anthropic");
  expect(fakes.responseStatuses).toEqual([204, 403]);
});

it("returns a deterministic denial for every other route", async () => {
  fakes.requestUrls.push(
    "https://example.com/collect",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1anything",
    "http://127.0.0.1:9999/admin",
  );

  await run(DIRECT);

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.responseStatuses).toEqual([403, 403, 403]);
});

it("keeps the deny filter installed when runtime shutdown fails", async () => {
  fakes.server.close.mockImplementation(
      () => Promise.reject(new Error("workerd failed to terminate")));

  const opened = await openLocalEvalTarget(
      DIRECT, WORKERS_AI_MODEL, 25);
  const fetchDuringCleanup = globalThis.fetch;
  await expect(opened[Symbol.asyncDispose]())
      .rejects.toThrow("workerd failed to terminate");

  // Cleanup failed, so the interceptor must still own globalThis.fetch: unrestricted network
  // access is not restored while the runtime may still run model-authored code.
  expect(globalThis.fetch).toBe(fetchDuringCleanup);

  // An outbound request after the failed shutdown is still answered by the deny filter.
  fakes.responseStatuses.push((await fetch("https://example.com/collect", { method: "POST" })).status);
  expect(fakes.responseStatuses).toEqual([403]);

  globalThis.fetch = realFetch;
});

it("preserves session and runtime cleanup failures", async () => {
  fakes.session.close.mockImplementation(
      () => Promise.reject(new Error("session refused to close")));
  fakes.server.close.mockImplementation(
      () => Promise.reject(new Error("workerd failed to terminate")));

  const opened = await openLocalEvalTarget(
      DIRECT, WORKERS_AI_MODEL, 25);
  const fetchDuringCleanup = globalThis.fetch;
  const failure = await opened[Symbol.asyncDispose]().then(() => undefined, error => error);

  if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
  expect(failure.errors.map(error => error instanceof Error ? error.message : String(error)))
    .toEqual(["session refused to close", "workerd failed to terminate"]);
  expect(globalThis.fetch).toBe(fetchDuringCleanup);
  globalThis.fetch = realFetch;
});

it("keeps the deny filter installed when setup cleanup cannot stop workerd", async () => {
  fakes.openSession.mockRejectedValueOnce(new Error("session setup failed"));
  fakes.server.close.mockRejectedValueOnce(new Error("workerd failed to terminate"));
  const unrestrictedFetch = globalThis.fetch;

  await expect(openLocalEvalTarget(
      DIRECT, WORKERS_AI_MODEL, 25))
    .rejects.toThrow("Eval session setup and cleanup failed");
  expect(globalThis.fetch).not.toBe(unrestrictedFetch);
  expect((await fetch("https://example.com/collect", { method: "POST" })).status).toBe(403);
  globalThis.fetch = realFetch;
});
