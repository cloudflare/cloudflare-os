import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

async function run(access: LocalModelAccess): Promise<void> {
  const opened = await openLocalEvalTarget(access, "@cf/model", 25);
  await opened[Symbol.asyncDispose]();
}

it("allows the direct Workers AI route", async () => {
  fakes.requestUrls.push(
      "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions");

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.responseStatuses).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes", async () => {
  fakes.requestUrls.push(
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/v1/chat/completions",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id",
  );

  await run({
    kind: "gateway",
    gateway: "gateway",
    accountId: "account-id",
    apiToken: "token",
  });

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
  fakes.requestUrls.push(
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/v1/chat/completions",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id",
  );

  await run({
    kind: "gateway",
    gateway: "gateway",
    accountId: "account-id",
  });

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

it("returns a deterministic denial for every other route", async () => {
  fakes.requestUrls.push(
    "https://example.com/collect",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1anything",
    "http://127.0.0.1:9999/admin",
  );

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.responseStatuses).toEqual([403, 403, 403]);
});

it("keeps the deny filter installed when runtime shutdown fails", async () => {
  fakes.server.close.mockImplementation(
      () => Promise.reject(new Error("workerd failed to terminate")));

  const opened = await openLocalEvalTarget(
      { kind: "direct", accountId: "account-id", apiToken: "token" }, "@cf/model", 25);
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
      { kind: "direct", accountId: "account-id", apiToken: "token" }, "@cf/model", 25);
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
      { kind: "direct", accountId: "account-id", apiToken: "token" }, "@cf/model", 25))
    .rejects.toThrow("Eval session setup and cleanup failed");
  expect(globalThis.fetch).not.toBe(unrestrictedFetch);
  expect((await fetch("https://example.com/collect", { method: "POST" })).status).toBe(403);
  globalThis.fetch = realFetch;
});
