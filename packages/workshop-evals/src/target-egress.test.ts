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
  const configs: CapturedConfig[] = [];
  const session = { close: vi.fn(() => Promise.resolve()) };
  return {
    configs,
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

import {
  closeLocalEvalRuntimes, evalNetworkInterceptor, openLocalEvalTarget, runtimesStillRunning,
} from "./target.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  fakes.configs.splice(0);
  fakes.openSession.mockImplementation(() => Promise.resolve(fakes.session));
  fakes.session.close.mockImplementation(() => Promise.resolve());
  fakes.server.close.mockImplementation(() => Promise.resolve());
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
});

afterEach(async () => {
  fakes.server.close.mockImplementation(() => Promise.resolve());
  await closeLocalEvalRuntimes();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

const WORKERS_AI_MODEL: EvalModel = { provider: "cloudflare", model: "@cf/zai-org/glm-5.2" };
const GEMINI: EvalModel = { provider: "google", model: "gemini-3.6-flash" };
const CLAUDE: EvalModel = { provider: "anthropic", model: "claude-sonnet-5" };
const DIRECT: LocalModelAccess = { kind: "direct", accountId: "account-id", apiToken: "token" };
const BINDING: LocalModelAccess = {
  kind: "gateway", gateway: "gateway", accountId: "account-id", transport: "binding",
};
const BINDING_WITH_TOKEN: LocalModelAccess = { ...BINDING, apiToken: "token" };
const HTTPS: LocalModelAccess = {
  kind: "gateway", gateway: "gateway", accountId: "account-id", transport: "https",
  apiToken: "token",
};

const DIRECT_INFERENCE_URL =
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions";
const WORKERS_AI_INFERENCE_URL =
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/v1/chat/completions";
const GEMINI_INFERENCE_URL =
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/google-ai-studio/v1beta/models/gemini-3.6-flash:streamGenerateContent";
const CLAUDE_INFERENCE_URL =
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/anthropic/v1/messages";
const COST_LOG_URL =
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id";

/** Statuses the Workshop would see for `urls` with the filter for `access` and `models` installed. */
async function egress(
    access: LocalModelAccess, models: EvalModel[], urls: string[]): Promise<number[]> {
  const network = evalNetworkInterceptor(access, models);
  network.install();
  try {
    const statuses: number[] = [];
    for (const url of urls) {
      const method = url.includes("/logs/") ? "GET" : "POST";
      statuses.push((await fetch(url, { method })).status);
    }
    return statuses;
  } finally {
    network.uninstall();
  }
}

it("allows the direct Workers AI route", async () => {
  expect(await egress(DIRECT, [WORKERS_AI_MODEL], [DIRECT_INFERENCE_URL])).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes over HTTPS", async () => {
  expect(await egress(HTTPS, [WORKERS_AI_MODEL], [WORKERS_AI_INFERENCE_URL, COST_LOG_URL]))
    .toEqual([204, 204]);
});

it("keeps HTTPS model routes closed in binding mode, with or without a token", async () => {
  const urls = [WORKERS_AI_INFERENCE_URL, COST_LOG_URL];
  expect(await egress(BINDING, [WORKERS_AI_MODEL], urls)).toEqual([403, 403]);
  expect(await egress(BINDING_WITH_TOKEN, [WORKERS_AI_MODEL], urls)).toEqual([403, 403]);
});

it("opens only the HTTPS inference route for an HTTPS-only provider in binding mode", async () => {
  expect(await egress(BINDING_WITH_TOKEN, [GEMINI],
      [GEMINI_INFERENCE_URL, WORKERS_AI_INFERENCE_URL, COST_LOG_URL])).toEqual([204, 403, 403]);
});

it("scopes HTTPS inference to the gateway routes of the models in the matrix", async () => {
  const urls = [CLAUDE_INFERENCE_URL, WORKERS_AI_INFERENCE_URL, GEMINI_INFERENCE_URL];
  expect(await egress(HTTPS, [CLAUDE], urls)).toEqual([204, 403, 403]);
  expect(await egress(HTTPS, [CLAUDE, WORKERS_AI_MODEL], urls)).toEqual([204, 204, 403]);
});

it("returns a deterministic denial for every other route, loopback included", async () => {
  expect(await egress(DIRECT, [WORKERS_AI_MODEL], [
    "https://example.com/collect",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1anything",
    "http://127.0.0.1:9999/admin",
  ])).toEqual([403, 403, 403]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

async function open(access: LocalModelAccess, model: EvalModel = WORKERS_AI_MODEL): Promise<void> {
  const opened = await openLocalEvalTarget(access, model, 25);
  await opened[Symbol.asyncDispose]();
}

it("configures the Workshop for HTTPS gateway access", async () => {
  await open(HTTPS);
  expect(fakes.configs).toEqual([{
    vars: {
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      CF_AI_GATEWAY_USE_BINDING: "false",
    },
  }]);
});

it("configures the Workshop for the binding transport, retaining any token", async () => {
  await open(BINDING_WITH_TOKEN, GEMINI);
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
});

it("leaves the Workshop config alone for direct access", async () => {
  await open(DIRECT);
  expect(fakes.configs).toEqual([{}]);
});

it("gives a model's concurrent trials one Workshop with a session each", async () => {
  const first = { close: vi.fn(() => Promise.resolve()) };
  const second = { close: vi.fn(() => Promise.resolve()) };
  fakes.openSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

  const [opened] = await Promise.all([
    openLocalEvalTarget(DIRECT, WORKERS_AI_MODEL, 25),
    openLocalEvalTarget(DIRECT, WORKERS_AI_MODEL, 25),
  ]);
  await opened[Symbol.asyncDispose]();

  expect(fakes.configs).toHaveLength(1);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).not.toHaveBeenCalled();
  expect(fakes.server.close).not.toHaveBeenCalled();
  await closeLocalEvalRuntimes();
  expect(fakes.server.close).toHaveBeenCalledOnce();
});

it("keeps counting a Workshop that failed to stop", async () => {
  const before = runtimesStillRunning();
  await open(DIRECT);
  fakes.server.close.mockRejectedValueOnce(new Error("workerd failed to terminate"));

  await expect(closeLocalEvalRuntimes()).rejects.toThrow("workerd failed to terminate");
  expect(runtimesStillRunning()).toBe(before + 1);
});
