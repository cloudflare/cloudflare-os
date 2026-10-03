import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUGGESTED_MODELS, type AiChatAuthorInfo, type AiModelConfig, type BuiltInReasoning,
} from "@gadgets/workshop-shared/api";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import {
  gatewayBuiltInReasoning, gatewayReasoningLevels, getModel, isRuntimeModel,
  LanguageModelGatekeeper, type ModelHandle,
} from "../src/ai-models.js";

// These tests exercise the real pi-ai stack: no module mocks. Routing decisions are asserted on
// the returned handle's model descriptor (baseUrl/id/api) and log route, and request-level
// behavior (URLs, auth headers, gateway metadata) is asserted by driving `handle.stream` with an
// injected `options.fetch` stub. pi streams never reject; a stubbed 400 simply ends the stream
// with an error-stop message once the request has been captured.

const INITIATOR: AiChatAuthorInfo = {
  type: "user",
  id: "user-123",
  name: "User",
};

const GADGET_INITIATOR: AiChatAuthorInfo = {
  type: "gadget",
  id: "owner-456",
  name: "Report Gadget",
};

const ANTHROPIC_CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiToken: "ignored-in-gateway-mode",
};

const WORKERS_AI_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  apiToken: "ignored-in-gateway-mode",
};

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    ...overrides,
  } as Cloudflare.Env;
}

type CapturedRequest = { url: string; headers: Headers; body: string };

// Anthropic's SDK adds provider-owned query flags (currently ?beta=true); routing owns the path.
function urlWithoutQuery(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

const capturedRequests: CapturedRequest[] = [];

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  capturedRequests.push({ url: request.url, headers: request.headers, body: await request.text() });
  // A non-retryable client error: the provider SDK reports it, pi converts it into an
  // error-stop assistant message, and the request stays captured for assertions.
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

// Runs one request through the handle with the fetch stub and returns what was sent.
async function captureRequest(
    handle: ModelHandle,
    options: NonNullable<Parameters<ModelHandle["stream"]>[2]> = {}): Promise<CapturedRequest> {
  const stream = await handle.stream(handle.model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { fetch: fetchStub, maxRetries: 0, ...options });
  const message = await stream.result();
  expect(message.stopReason).toBe("error");
  expect(capturedRequests.length).toBeGreaterThan(0);
  return capturedRequests[0];
}

describe("getModel AI Gateway routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("routes non-Workers providers through the platform gateway", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.id).toBe("claude-sonnet-4-5");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(urlWithoutQuery(request.url)).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic/" +
        "v1/messages");
    // Gateway-owned auth: the cf-aig token authorizes the request and the SDK's own auth
    // headers are suppressed so the gateway's server-managed provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
  }, 15000);

  it("routes Google through the gateway's google-ai-studio passthrough", () => {
    // The @google/genai SDK sends its API key as `x-goog-api-key`, which AI Gateway forwards to
    // the provider verbatim (taking precedence over the gateway's stored keys), so the documented
    // stored-key flow passes the gateway token as the SDK API key. The adapter rejects injected
    // fetch, so only the descriptor is asserted here; the header behavior is the SDK's.
    const handle = getModel(env(), {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR);

    expect(handle.model.api).toBe("google-generative-ai");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/" +
        "google-ai-studio/v1beta");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });

  it("preserves gadget automation metadata", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, GADGET_INITIATOR, {
      metadata: { source: "thread-title", gadgetId: "gadget-456", chatId: 8 },
    });

    const request = await captureRequest(handle);
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "owner-456",
      source: "thread-title",
      gadgetId: "gadget-456",
      chatId: 8,
      automated: true,
    });
  }, 15000);

  it("requires the gateway account id whenever gateway mode is enabled", () => {
    expect(() => getModel(env({ CF_AI_GATEWAY_ACCOUNT_ID: undefined }), ANTHROPIC_CONFIG,
        INITIATOR)).toThrow("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
  });

  it("requires a transport: the Workers AI binding or an API token", () => {
    // Without the binding (local dev without --use-workers-ai-binding), the token is required.
    expect(() => getModel(env({ CF_AI_GATEWAY_API_TOKEN: undefined }), ANTHROPIC_CONFIG,
        INITIATOR)).toThrow("AI Gateway mode needs a transport");
  });

  it("prioritizes a connected user's Gateway over platform routing", async () => {
    const handle = getModel(env(), WORKERS_AI_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
      metadata: { source: "chat", gadgetId: "gadget-789", chatId: 9 },
    });

    // BYOK rides the user's default gateway's provider-native routes (unified *billing* has no
    // API requirements), regardless of the platform gateway configuration. For Workers AI that
    // is its own OpenAI-compatible endpoint under workers-ai/v1.
    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "default",
      accountId: "user-account-id",
      apiToken: "user-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/workers-ai/v1/" +
        "chat/completions");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer user-token");
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-789",
      chatId: 9,
    });
  }, 15000);

  it("speaks the provider's native API on a connected user's Gateway", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
    });

    // Never the gateway's unified OpenAI-compat translation layer: it drops provider features
    // (extended thinking, cache_control prompt caching, the Responses API).
    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.id).toBe("claude-sonnet-4-5");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/anthropic");

    const request = await captureRequest(handle);
    expect(urlWithoutQuery(request.url)).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/anthropic/v1/messages");
    // The user's token authorizes the gateway; the SDK's own auth headers are suppressed so the
    // gateway's unified-billing provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer user-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("routes Workers AI through the platform gateway like every other provider", async () => {
    const handle = getModel(env(), WORKERS_AI_CONFIG, INITIATOR,
        { sessionAffinity: "session-a" });
    const glm = getModel(env(),
        {...WORKERS_AI_CONFIG, model: "@cf/zai-org/glm-5.3-flash"}, INITIATOR);
    expect(glm.model).toMatchObject({reasoning: true, input: ["text", "image"]});

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/" +
        "v1/chat/completions");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    // Session affinity flows through (Workers AI models opt in to the affinity headers).
    expect(request.headers.get("x-session-affinity")).toBe("session-a");
  }, 15000);

  // The environment's providers are not all a deployment enables, so the refusal lists none.
  it("refuses a provider the gateway has no route for", () => {
    expect(() => getModel(env({ CF_AI_GATEWAY_PROVIDERS: "anthropic,ollama" }),
        { provider: "ollama", model: "llama3", apiToken: "" }, INITIATOR))
        .toThrow(new Error('Provider "ollama" is not supported through AI Gateway.'));
  });
});

describe("getModel AI Gateway binding transport", () => {
  // Provider-native requests captured by the fake Workers AI binding. In binding mode the
  // handle's requests never hit HTTP: pi's SDK fetch is the gateway-binding shim, which only
  // rewrites the URL onto the gateway's provider passthrough
  // (workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...) and hands the request to
  // binding.fetch() otherwise unchanged.
  type CapturedBindingRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  const capturedEntries: CapturedBindingRequest[] = [];

  const fakeBinding = {
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      capturedEntries.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      // Same non-retryable client error as the HTTP fetch stub: pi surfaces an error-stop
      // message and the request stays captured for assertions.
      return Response.json(
          { error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
    },
  } as unknown as Ai;

  // Binding transport selects by default: binding present, no API token (in-account gateways;
  // CF_AI_GATEWAY_USE_BINDING=false is the cross-account opt-out). google must not be an
  // enabled provider in this mode (its transport still needs the token).
  function bindingEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
    return env({
      CF_AI_GATEWAY_API_TOKEN: undefined,
      CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare",
      WORKERS_AI: fakeBinding,
      ...overrides,
    });
  }

  async function captureEntry(handle: ModelHandle): Promise<CapturedBindingRequest> {
    const stream = handle.stream(handle.model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, { maxRetries: 0 });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    expect(capturedEntries.length).toBeGreaterThan(0);
    return capturedEntries[0];
  }

  beforeEach(() => {
    capturedEntries.length = 0;
    capturedRequests.length = 0;
  });

  it("drives Anthropic through the binding with no API token", async () => {
    const handle = getModel(bindingEnv(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(handle.model.api).toBe("anthropic-messages");
    // Binding-routed models address the gateway on the binding's host, which takes no account
    // id -- the binding channel carries identity.
    expect(handle.model.baseUrl).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic");
    // Same-account log reads ride the binding too: no account id or token in the route.
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const entry = await captureEntry(handle);
    expect(urlWithoutQuery(entry.url)).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    expect(entry.method).toBe("POST");
    // The sentinel auth header satisfies pi's request-auth check; the gateway recognizes and
    // strips it on binding-routed requests, so the shim forwards it. The SDK's own auth
    // headers stay suppressed.
    expect(entry.headers["cf-aig-authorization"]).toBe("Bearer cloudflare-gateway-binding");
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("authorization");
    expect(JSON.parse(entry.headers["cf-aig-metadata"])).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
    expect((JSON.parse(entry.body) as { model: string }).model).toBe("claude-sonnet-4-5");
  }, 15000);

  it("drives Workers AI through the binding via its gateway route", async () => {
    const handle = getModel(bindingEnv(), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.baseUrl).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const entry = await captureEntry(handle);
    expect(entry.url).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/workers-ai/" +
        "v1/chat/completions");
    expect((JSON.parse(entry.body) as { model: string }).model)
        .toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // openai-completions adapters inject `Authorization: Bearer unused` under header-owned
    // auth; the gatewayAuthHeaders nulls must delete it before dispatch, else the gateway
    // would treat it as a request-supplied provider key overriding stored keys.
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("x-api-key");
  }, 15000);

  it("lets a per-call fetch override the binding transport", async () => {
    // Tests and diagnostics inject options.fetch; it must win over the handle's binding fetch.
    // The URL is the model's, so it still names the binding route -- only the transport swaps.
    const handle = getModel(bindingEnv(), ANTHROPIC_CONFIG, INITIATOR);

    const request = await captureRequest(handle);
    expect(capturedEntries).toHaveLength(0);
    expect(urlWithoutQuery(request.url)).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    expect(request.headers.get("cf-aig-authorization"))
        .toBe("Bearer cloudflare-gateway-binding");
  }, 15000);

  it("keeps Google on HTTPS with the token while other providers use the binding", async () => {
    // Hybrid mode: binding and token both present. pi's Google adapter rejects a custom fetch,
    // so Google inference rides HTTPS with the gateway token -- but same-account log reads
    // still use the binding.
    const hybridEnv = env({
      CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
      WORKERS_AI: fakeBinding,
    });

    const googleHandle = getModel(hybridEnv, {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR);
    expect(googleHandle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/" +
        "google-ai-studio/v1beta");
    expect(googleHandle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const anthropicHandle = getModel(hybridEnv, ANTHROPIC_CONFIG, INITIATOR);
    const entry = await captureEntry(anthropicHandle);
    expect(urlWithoutQuery(entry.url)).toBe(
        "https://workers-binding.ai/ai-gateway/gateways/platform-gateway/anthropic/v1/messages");
    // The binding arm carries the sentinel, never the real gateway token.
    expect(entry.headers["cf-aig-authorization"]).toBe("Bearer cloudflare-gateway-binding");
  }, 15000);

  it("requires the token when google is an enabled provider", () => {
    expect(() => getModel(
        bindingEnv({ CF_AI_GATEWAY_PROVIDERS: "anthropic,google" }),
        ANTHROPIC_CONFIG, INITIATOR)).toThrow(
        "enabling the google provider requires CF_AI_GATEWAY_API_TOKEN");
  });

  it("rejects a stored google config when the deployment has no token", () => {
    expect(() => getModel(bindingEnv(), {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR)).toThrow(
        'Provider "google" cannot use the Workers AI binding transport');
  });

});

describe("getModel direct routing (no gateway)", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it.each([
    ["anthropic", "claude-opus-5-5", "Claude Opus 5.5", 1_000_000],
    ["anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000],
    ["anthropic", "claude-fable-5-1", "Claude Fable 5.1", 1_000_000],
    ["openai", "gpt-6.1-sol", "GPT-6.1 Sol", 1_050_000],
    ["openai", "gpt-6-astra", "GPT-6 Astra", 1_050_000],
    ["openai", "gpt-6-sol", "GPT-6 Sol", 1_050_000],
    ["openai", "gpt-6-luna", "GPT-6 Luna", 1_050_000],
  ] as const)(
      "offers %s model %s with configured limits and catalog metadata",
      (provider, model, name, contextWindow) => {
    expect(SUGGESTED_MODELS[provider][model]).toMatchObject({name, contextWindow});

    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider,
      model,
      apiToken: "direct-api-token",
    }, INITIATOR);
    const upstream = provider === "anthropic" ? ANTHROPIC_MODELS[model] : OPENAI_MODELS[model];
    expect(upstream).toBeDefined();
    expect(handle.model).toMatchObject({
      id: model,
      name,
      contextWindow,
      maxTokens: 128_000,
      cost: upstream.cost,
      compat: upstream.compat,
      thinkingLevelMap: upstream.thinkingLevelMap,
    });
    expect(handle.model.compat).toMatchObject(provider === "anthropic"
      ? { forceAdaptiveThinking: true }
      : { supportsExplicitPromptCacheMode: true });
  });

  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])(
      "keeps quick requests valid for %s", async (model) => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic",
      model,
      apiToken: "direct-api-token",
    }, INITIATOR);

    const request = await captureRequest(handle, { thinking: false });
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe(model);
    expect(body.max_tokens).toBe(128_000);
    if (handle.model.compat?.supportsMidConvoEffort) {
      // Managed-effort models require adaptive thinking even for one-shot quick calls; keep
      // their active effort low instead of silently sending the provider's high-effort default.
      expect(body).toMatchObject({ thinking: { type: "adaptive" } });
      expect(body.messages).toContainEqual(expect.objectContaining({
        role: "system", output_config: { effort: "low" },
      }));
    } else {
      expect(body).not.toHaveProperty("thinking");
    }
  });

  // pi maps these models' "off" thinking level to nothing, since they can't turn reasoning off.
  it.each(["gpt-6-astra", "gpt-6.1-sol"])(
      "does not try to disable reasoning for %s", async (model) => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai",
      model,
      apiToken: "direct-api-token",
    }, INITIATOR);

    const request = await captureRequest(handle, { thinking: false });
    expect(JSON.parse(request.body)).not.toHaveProperty("reasoning");
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])(
      "turns off reasoning for quick %s requests", async (model) => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai", model, apiToken: "direct-api-token",
    }, INITIATOR);

    const request = await captureRequest(handle, { thinking: false });
    expect(JSON.parse(request.body)).toMatchObject({ reasoning: { effort: "none" } });
  });

  it("uses the provider defaults and the config's own credentials", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "direct-api-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.baseUrl).toBe("https://api.anthropic.com");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(urlWithoutQuery(request.url)).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("direct-api-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
  }, 15000);

  it("sends the caller's system prompt to the provider", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "direct-api-token",
    }, INITIATOR);

    const stream = handle.stream(handle.model, {
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }, { fetch: fetchStub, maxRetries: 0 });
    await stream.result();

    expect(JSON.parse(capturedRequests[0].body).system).toEqual([
      expect.objectContaining({ type: "text", text: "Be concise." }),
    ]);
  });

  it("uses the config's own account and token for direct Workers AI", async () => {
    // Outside gateway mode, Workers AI is BYOK like any other provider: credentials come from
    // the model config (never from env, which only configures gateway mode).
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      ...WORKERS_AI_CONFIG,
      accountId: "user-account-id",
      apiToken: "user-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer user-token");
  }, 15000);

  it.each([
    { accountId: undefined, apiToken: "user-token" },
    { accountId: "user-account-id", apiToken: "" },
  ])("requires config credentials for direct Workers AI", (overrides) => {
    // Pre-BYOK configs (saved when Workers AI needed no credentials) fail with a clear message.
    expect(() => getModel(env({ CF_AI_GATEWAY: undefined }),
        { ...WORKERS_AI_CONFIG, ...overrides }, INITIATOR))
        .toThrow("This Workers AI model has no Cloudflare credentials.");
  });

  it("appends /v1 to an Ollama server base URL", () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434/",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
  });

  it("sends no Authorization header for an Ollama config without an API key", async () => {
    // An empty token means local auth: a strict local proxy may reject an unexpected bearer
    // token, so no Authorization header is sent at all (matching the pre-pi provider).
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.url).toBe("http://my-ollama:11434/v1/chat/completions");
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("sends the configured Ollama API key as a bearer token", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "ollama-token",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer ollama-token");
  }, 15000);

  it("sends the config's extra headers, overriding provider defaults", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai",
      model: "gpt-5",
      apiToken: "direct-api-token",
      apiUrl: "https://proxy.example.com/v1",
      extraHeaders: { "X-Proxy-Key": "proxy-secret", Authorization: "Bearer proxy-token" },
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.url).toBe("https://proxy.example.com/v1/responses");
    expect(request.headers.get("x-proxy-key")).toBe("proxy-secret");
    expect(request.headers.get("authorization")).toBe("Bearer proxy-token");
  }, 15000);

  it.each([
    { provider: "anthropic", model: "claude-sonnet-4-5", keyHeader: "x-api-key" },
    { provider: "openai", model: "gpt-5", keyHeader: "authorization" },
  ] as const)("sends no $provider API key when the token is blank", async (
      { provider, model, keyHeader }) => {
    // A proxy like AI Gateway with stored keys only injects its own provider key into requests
    // that carry none, authenticating the caller through extra headers instead. (A header pi
    // doesn't recognize as auth, so this also covers pi's own "No API key" check.)
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider,
      model,
      apiToken: "",
      apiUrl: "https://proxy.example.com",
      extraHeaders: { "X-Proxy-Auth": "proxy-token" },
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get(keyHeader)).toBeNull();
    expect(request.headers.get("x-proxy-auth")).toBe("proxy-token");
  }, 15000);

  it("sends extra headers for an Ollama config without an API key", async () => {
    // The null default that suppresses the SDK's placeholder bearer token must not also
    // suppress an Authorization header the user configured explicitly.
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434",
      extraHeaders: { Authorization: "Basic dXNlcjpwYXNz" },
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Basic dXNlcjpwYXNz");
  }, 15000);

  it("ignores extra headers when routing through AI Gateway", async () => {
    const handle = getModel(env(), {
      ...ANTHROPIC_CONFIG,
      extraHeaders: { "X-Proxy-Key": "proxy-secret" },
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get("x-proxy-key")).toBeNull();
  }, 15000);

  it("strips a legacy /api (or /v1) suffix from an Ollama base URL", () => {
    // Configs saved before the pi migration store the native-API base (".../api").
    for (const apiUrl of ["http://my-ollama:11434/api", "http://my-ollama:11434/v1/"]) {
      const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
        provider: "ollama",
        model: "qwen3:8b",
        apiToken: "",
        apiUrl,
      }, INITIATOR);
      expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
    }
  });
});

// The parts of a request body that ask for reasoning, and what they are for each answer of
// gatewayBuiltInReasoning(). The effort pi gives a Claude whose effort it manages is pi's own.
const reasoningAsked = (body: Record<string, unknown>) => ({
  thinking: (body.thinking as { type: string } | undefined)?.type,
  effort: (body.reasoning as { effort: string } | undefined)?.effort ?? body.reasoning_effort,
});
const builtInRequest = (builtIn: BuiltInReasoning) => builtIn === "adaptive"
    ? { thinking: "adaptive", effort: undefined }
    : { thinking: undefined, effort: builtIn ?? undefined };

describe("gateway model reasoning levels", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  const gatewayEnv = env({ CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare" });
  type GatewayConfig = Omit<AiModelConfig, "apiToken">;
  type Level = NonNullable<AiModelConfig["reasoning"]>;

  // The body of one request to a gateway model, as sent: an agent turn's unless `options` says
  // otherwise.
  async function requestBody(config: GatewayConfig,
                             options: Parameters<typeof captureRequest>[1] = {}): Promise<string> {
    capturedRequests.length = 0;
    const handle = getModel(gatewayEnv, { ...config, apiToken: "" }, INITIATOR);
    return (await captureRequest(handle, options)).body;
  }
  const parsed = async (...args: Parameters<typeof requestBody>) =>
      JSON.parse(await requestBody(...args)) as Record<string, unknown>;

  const OPUS: GatewayConfig = { provider: "anthropic", model: "claude-opus-5-5" };
  const SONNET_5: GatewayConfig = { provider: "anthropic", model: "claude-sonnet-5" };
  const HAIKU: GatewayConfig = { provider: "anthropic", model: "claude-haiku-4-5" };
  const GPT: GatewayConfig = { provider: "openai", model: "gpt-6.1-sol" };
  const GPT_6_SOL: GatewayConfig = { provider: "openai", model: "gpt-6-sol" };
  const GLM: GatewayConfig = { provider: "cloudflare", model: "@cf/zai-org/glm-5.2" };
  const GLM_FLASH: GatewayConfig = { provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash" };
  const KIMI: GatewayConfig = { provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code" };
  const DEEPSEEK: GatewayConfig =
      { provider: "cloudflare", model: "@cf/deepseek-ai/deepseek-v4-pro-0813" };
  // pi marks this one as a model that does no reasoning.
  const LLAMA: GatewayConfig = { provider: "cloudflare", model: WORKERS_AI_CONFIG.model };

  // Each body below is written in the key order it is sent in.
  const CLAUDE_HELLO = {
    role: "user",
    content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
  };
  // pi sends a managed-effort Claude its effort in a system message; the top-level one is fixed.
  const opusBody = (effort: string) => ({
    model: OPUS.model,
    messages: [CLAUDE_HELLO, { role: "system", content: [], output_config: { effort } }],
    max_tokens: 128000, stream: true,
    thinking: {
      type: "adaptive", display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    output_config: { effort: "high" },
  });
  const claudeBody = (config: GatewayConfig, max_tokens: number, extra: object = {}) =>
      ({ model: config.model, messages: [CLAUDE_HELLO], max_tokens, stream: true, ...extra });
  const gptBody = (config: GatewayConfig, extra: object) => ({
    model: config.model,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true, store: false, ...extra,
  });
  // An OpenAI request that asks for an effort, which also asks for the reasoning back.
  const gptEffortBody = (config: GatewayConfig, effort: string) => gptBody(config, {
    reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"],
  });
  const completionsBody = (config: GatewayConfig, extra: object = {}) => ({
    model: config.model, messages: [{ role: "user", content: "hello" }], stream: true,
    stream_options: { include_usage: true }, ...extra,
  });

  // The whole body of an agent turn's request while no level is set, byte for byte: what each
  // model is sent by a deployment that sets no level.
  it.each([
    ["an adaptive Claude", OPUS, opusBody("high")],
    ["Haiku", HAIKU, claudeBody(HAIKU, 64000)],
    ["an OpenAI model", GPT, gptEffortBody(GPT, "medium")],
    ["GLM 5.2", GLM, completionsBody(GLM)],
    // pi's DeepSeek format turns thinking off whenever it is given no effort.
    ["DeepSeek V4 Pro", DEEPSEEK, completionsBody(DEEPSEEK, { thinking: { type: "disabled" } })],
  ])("sends %s its built-in request while no level is set", async (_, config, body) => {
    expect(await requestBody(config)).toBe(JSON.stringify(body));
  });

  // Opus 5.5 can't stop thinking and has no "minimal", so both are its lowest level.
  it.each([
    ["off", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"],
    ["xhigh", "xhigh"], ["max", "max"],
  ] as const)("asks an adaptive Claude for level %s as effort %s", async (level, effort) => {
    expect(await parsed({ ...OPUS, reasoning: level })).toEqual(opusBody(effort));
  });

  it("gives an adaptive Claude whose effort is not managed the effort in the request", async () => {
    const adaptive = { type: "adaptive", display: "summarized" };
    expect(await parsed({ ...SONNET_5, reasoning: "medium" })).toEqual(claudeBody(
        SONNET_5, 128000, { thinking: adaptive, output_config: { effort: "medium" } }));
    // Anthropic has no "minimal" effort.
    expect(await parsed({ ...SONNET_5, reasoning: "minimal" })).toEqual(claudeBody(
        SONNET_5, 128000, { thinking: adaptive, output_config: { effort: "low" } }));
    // This one can stop thinking.
    expect(await parsed({ ...SONNET_5, reasoning: "off" })).toEqual(
        claudeBody(SONNET_5, 128000, { thinking: { type: "disabled" } }));
  });

  it.each([
    ["minimal", 1024], ["low", 2048], ["medium", 8192], ["high", 16384], ["max", 16384],
  ] as const)("gives Haiku a thinking budget for level %s, under the same response cap",
      async (level, budget_tokens) => {
    expect(await parsed({ ...HAIKU, reasoning: level })).toEqual(claudeBody(HAIKU, 64000,
        { thinking: { type: "enabled", budget_tokens, display: "summarized" } }));
  });

  it("turns Haiku's thinking off", async () => {
    expect(await parsed({ ...HAIKU, reasoning: "off" }))
        .toEqual(claudeBody(HAIKU, 64000, { thinking: { type: "disabled" } }));
  });

  it("fits a thinking budget under the caller's response cap, leaving room to answer",
      async () => {
    expect(await parsed({ ...HAIKU, reasoning: "high" }, { maxTokens: 2048 })).toEqual(
        claudeBody(HAIKU, 2048,
            { thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" } }));
    // No room for Anthropic's smallest budget beside an answer, so no thinking is asked for.
    expect(await parsed({ ...HAIKU, reasoning: "high" }, { maxTokens: 1500 }))
        .toEqual(claudeBody(HAIKU, 1500));
  });

  // GPT-6.1 Sol can't stop reasoning and has no "minimal", so both are its lowest level.
  it.each([
    ["off", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"],
    ["xhigh", "xhigh"], ["max", "max"],
  ] as const)("asks an OpenAI model for level %s as effort %s", async (level, effort) => {
    expect(await parsed({ ...GPT, reasoning: level })).toEqual(gptEffortBody(GPT, effort));
  });

  it("turns reasoning off on an OpenAI model that can stop reasoning", async () => {
    expect(await parsed({ ...GPT_6_SOL, reasoning: "off" }))
        .toEqual(gptBody(GPT_6_SOL, { reasoning: { effort: "none" } }));
  });

  // Each Workers AI model takes the levels pi's catalog gives it, and a level between two of
  // them is the next one up. These go to the gateway's HTTPS host, where pi would send no effort
  // at all without the compat flag the descriptor sets.
  it.each([
    ["GLM 5.2", GLM, "off", { reasoning_effort: "none" }],
    ["GLM 5.2", GLM, "low", { reasoning_effort: "high" }],
    ["GLM 5.2", GLM, "high", { reasoning_effort: "high" }],
    ["GLM 5.2", GLM, "xhigh", { reasoning_effort: "max" }],
    // It can't stop reasoning.
    ["GLM 5.3 Flash", GLM_FLASH, "off", { reasoning_effort: "low" }],
    ["GLM 5.3 Flash", GLM_FLASH, "medium", { reasoning_effort: "high" }],
    ["GLM 5.3 Flash", GLM_FLASH, "max", { reasoning_effort: "max" }],
    // Its "off" is to send no effort.
    ["Kimi K2.7", KIMI, "off", {}],
    ["Kimi K2.7", KIMI, "minimal", { reasoning_effort: "minimal" }],
    ["Kimi K2.7", KIMI, "max", { reasoning_effort: "high" }],
    ["DeepSeek V4 Pro", DEEPSEEK, "off", { thinking: { type: "disabled" } }],
    ["DeepSeek V4 Pro", DEEPSEEK, "low",
      { thinking: { type: "enabled" }, reasoning_effort: "high" }],
    ["DeepSeek V4 Pro", DEEPSEEK, "max",
      { thinking: { type: "enabled" }, reasoning_effort: "max" }],
    ["a model that does no reasoning", LLAMA, "high", {}],
  ] as const)("sends $0 level $2", async (_, config, level, extra) => {
    expect(await parsed({ ...config, reasoning: level })).toEqual(completionsBody(config, extra));
  });

  // pi's Google adapter refuses an injected fetch, so the request is read from the payload hook,
  // which fails it before anything is sent.
  async function googleThinking(model: string, level?: Level,
                                behavesLike?: string): Promise<unknown> {
    const handle = getModel(gatewayEnv,
        { provider: "google", model, apiToken: "", reasoning: level, behavesLike }, INITIATOR);
    let config: { thinkingConfig?: unknown } | undefined;
    const stream = handle.stream(handle.model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, {
      maxRetries: 0,
      onPayload: (payload) => {
        config = (payload as { config: { thinkingConfig?: unknown } }).config;
        throw new Error("captured");
      },
    });
    expect((await stream.result()).errorMessage).toContain("captured");
    return config!.thinkingConfig;
  }

  it("asks a Gemini model for a level in the format the model takes", async () => {
    // Nothing, while no level is set.
    expect(await googleThinking("gemini-3.6-flash")).toBeUndefined();
    expect(await googleThinking("gemini-3.6-flash", "low"))
        .toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
    // It can't stop thinking, and has no level above "high".
    expect(await googleThinking("gemini-3.6-flash", "off"))
        .toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" });
    expect(await googleThinking("gemini-3.6-flash", "max"))
        .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });

    // The 2.5 models take a token budget.
    expect(await googleThinking("gemini-2.5-flash")).toBeUndefined();
    expect(await googleThinking("gemini-2.5-flash", "off")).toEqual({ thinkingBudget: 0 });
  });

  it.each([
    ["minimal", 1024], ["low", 2048], ["medium", 8192], ["high", 16384],
  ] as const)("gives a Gemini model that takes a budget one for level %s",
      async (level, thinkingBudget) => {
    expect(await googleThinking("gemini-2.5-flash", level))
        .toEqual({ includeThoughts: true, thinkingBudget });
  });

  it("gives a model billed to a connected user's gateway its level too", async () => {
    const handle = getModel(gatewayEnv, { ...GLM, apiToken: "", reasoning: "high" }, INITIATOR,
        { userGateway: { accountId: "user-account-id", apiKey: "user-token" } });
    expect(JSON.parse((await captureRequest(handle)).body))
        .toEqual(completionsBody(GLM, { reasoning_effort: "high" }));
  });

  it.each([
    ["an adaptive Claude", OPUS, "max_tokens"], ["Haiku", HAIKU, "max_tokens"],
    ["an OpenAI model", GPT, "max_output_tokens"], ["GLM 5.2", GLM, "max_tokens"],
  ] as const)("sends %s the caller's response cap with a level as without",
      async (_, config, cap) => {
    expect((await parsed(config, { maxTokens: 32768 }))[cap]).toBe(32768);
    expect((await parsed({ ...config, reasoning: "high" }, { maxTokens: 32768 }))[cap])
        .toBe(32768);
  });

  // A quick call (a title, a compaction summary, a gadget's model binding) asks for no thinking
  // whatever the level.
  it.each([
    ["an adaptive Claude", OPUS], ["an adaptive Claude that can stop thinking", SONNET_5],
    ["Haiku", HAIKU], ["an OpenAI model", GPT], ["an OpenAI model that can stop", GPT_6_SOL],
    ["GLM 5.3 Flash", GLM_FLASH], ["Kimi K2.7", KIMI], ["DeepSeek V4 Pro", DEEPSEEK],
  ])("sends %s the same quick request whatever level is set", async (_, config) => {
    const quick = await requestBody(config, { thinking: false });
    for (const level of ["off", "high", "max"] as const) {
      expect(await requestBody({ ...config, reasoning: level }, { thinking: false })).toBe(quick);
    }
  });

  // The one exception: with a level set, GLM 5.2's descriptor has pi's level map, whose "off"
  // pi sends whenever it is given no effort.
  it("sends GLM 5.2 its off effort on a quick request once a level is set", async () => {
    expect(await parsed(GLM, { thinking: false })).toEqual(completionsBody(GLM));
    expect(await parsed({ ...GLM, reasoning: "high" }, { thinking: false }))
        .toEqual(completionsBody(GLM, { reasoning_effort: "none" }));
  });

  it("gives a model reached directly no level", async () => {
    capturedRequests.length = 0;
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }),
        { ...GPT, apiToken: "direct-api-token", reasoning: "max" }, INITIATOR);
    expect(JSON.parse((await captureRequest(handle)).body))
        .toEqual(gptEffortBody(GPT, "medium"));
  });

  const LOW_TO_MAX = ["low", "medium", "high", "xhigh", "max"];
  const OFF_TO_HIGH = ["off", "minimal", "low", "medium", "high"];
  it.each([
    ["anthropic", "claude-opus-5-5", LOW_TO_MAX],
    ["anthropic", "claude-sonnet-5-5", LOW_TO_MAX],
    ["anthropic", "claude-fable-5-1", ["minimal", ...LOW_TO_MAX]],
    ["anthropic", "claude-opus-5", ["minimal", ...LOW_TO_MAX]],
    ["anthropic", "claude-sonnet-5", ["off", "minimal", ...LOW_TO_MAX]],
    ["anthropic", "claude-haiku-4-5", OFF_TO_HIGH],
    ["openai", "gpt-6.1-sol", LOW_TO_MAX],
    ["openai", "gpt-6-astra", LOW_TO_MAX],
    ["openai", "gpt-6-sol", ["off", ...LOW_TO_MAX]],
    ["openai", "gpt-6-luna", ["off", ...LOW_TO_MAX]],
    ["openai", "gpt-5.6-sol", ["off", ...LOW_TO_MAX]],
    ["openai", "gpt-5.6-luna", ["off", ...LOW_TO_MAX]],
    ["openai", "gpt-5.6-terra", ["off", ...LOW_TO_MAX]],
    ["google", "gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
    ["cloudflare", "@cf/moonshotai/kimi-k2.7-code", OFF_TO_HIGH],
    ["cloudflare", "@cf/zai-org/glm-5.2", ["off", "high", "max"]],
    ["cloudflare", "@cf/zai-org/glm-5.3-flash", ["low", "high", "max"]],
    ["cloudflare", "@cf/deepseek-ai/deepseek-v4-pro-0813", ["off", "high", "max"]],
    // Models pi does not know: one that is assumed to reason takes the levels every such model
    // has, and a Workers AI one is assumed not to.
    ["anthropic", "claude-next", OFF_TO_HIGH],
    ["openai", "gpt-next", OFF_TO_HIGH],
    ["cloudflare", "@cf/test/next", []],
    ["cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", []],
    // AI Gateway serves no such provider.
    ["ollama", "qwen3:8b", []],
  ] as const)("lists the levels %s model %s can be sent", (provider, model, levels) => {
    expect(gatewayReasoningLevels(provider, model)).toEqual(levels);
  });

  // What an agent's turn asks each catalog model for while no level is set.
  const BUILT_IN: [AiModelConfig["provider"], string, BuiltInReasoning][] = [
    ["anthropic", "claude-opus-5-5", "adaptive"],
    ["anthropic", "claude-sonnet-5-5", "adaptive"],
    ["anthropic", "claude-fable-5-1", "adaptive"],
    ["anthropic", "claude-opus-5", "adaptive"],
    ["anthropic", "claude-sonnet-5", "adaptive"],
    ["anthropic", "claude-haiku-4-5", null],
    ["openai", "gpt-6.1-sol", "medium"],
    ["openai", "gpt-6-sol", "medium"],
    ["openai", "gpt-6-luna", "medium"],
    ["openai", "gpt-6-astra", "medium"],
    ["openai", "gpt-5.6-sol", "medium"],
    ["openai", "gpt-5.6-luna", "medium"],
    ["openai", "gpt-5.6-terra", "medium"],
    ["google", "gemini-3.6-flash", null],
    ["cloudflare", "@cf/moonshotai/kimi-k2.7-code", null],
    ["cloudflare", "@cf/zai-org/glm-5.2", null],
    ["cloudflare", "@cf/zai-org/glm-5.3-flash", null],
    ["cloudflare", "@cf/deepseek-ai/deepseek-v4-pro-0813", null],
  ];
  it.each(BUILT_IN)("says what %s model %s is asked for while no level is set",
      (provider, model, builtIn) => {
    expect(gatewayBuiltInReasoning(provider, model)).toBe(builtIn);
  });

  it("says so for every model of the catalog", () => {
    const catalog = Object.entries(SUGGESTED_MODELS).flatMap(
        ([provider, models]) => Object.keys(models).map(model => `${provider} ${model}`));
    expect(BUILT_IN.map(([provider, model]) => `${provider} ${model}`).toSorted())
        .toEqual(catalog.toSorted());
  });

  it.each([
    // Models pi does not know. An Anthropic one is taken for a model that is not adaptive, and
    // an OpenAI one for a model that reasons.
    ["anthropic", "claude-next", undefined, null],
    ["anthropic", "claude-next", "claude-opus-5-5", "adaptive"],
    ["anthropic", "claude-next", "claude-haiku-4-5", null],
    // pi does not know this one either, so there is nothing to borrow.
    ["anthropic", "claude-next", "claude-nope", null],
    ["openai", "gpt-next", undefined, "medium"],
    ["openai", "gpt-next", "gpt-6.1-sol", "medium"],
    // pi marks GPT-4o as a model that does no reasoning, which it sends no effort.
    ["openai", "gpt-4o", undefined, null],
    ["openai", "gpt-next", "gpt-4o", null],
    ["cloudflare", "@cf/test/next", undefined, null],
    ["cloudflare", "@cf/test/next", "@cf/zai-org/glm-5.2", null],
    ["google", "gemini-next", undefined, null],
    ["google", "gemini-next", "gemini-3.6-flash", null],
    // A model pi knows borrows nothing.
    ["anthropic", "claude-haiku-4-5", "claude-opus-5-5", null],
    ["anthropic", "claude-opus-5-5", "claude-haiku-4-5", "adaptive"],
    // AI Gateway serves no such provider.
    ["ollama", "qwen3:8b", undefined, null],
  ] as const)("says what %s model %s behaving like %s is asked for while no level is set",
      (provider, model, behavesLike, builtIn) => {
    expect(gatewayBuiltInReasoning(provider, model, behavesLike)).toBe(builtIn);
  });

  // Every route getModel() has through an AI Gateway: the platform's over HTTPS and over the
  // Workers AI binding (whose requests the injected fetch takes), and a connected user's.
  const GATEWAY_ROUTES = [
    ["gateway.ai.cloudflare.com", gatewayEnv, {}],
    ["workers-binding.ai", env({
      CF_AI_GATEWAY_API_TOKEN: undefined, CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare",
      WORKERS_AI: {} as Ai,
    }), {}],
    ["gateway.ai.cloudflare.com", gatewayEnv,
      { userGateway: { accountId: "user-account-id", apiKey: "user-token" } }],
  ] as const;

  // DeepSeek V4 Pro is left out: it is asked for nothing, and pi's format for it then turns
  // thinking off (see its built-in request above).
  it.each<[string, GatewayConfig, BuiltInReasoning]>([
    ["a Claude whose effort pi manages", OPUS, "adaptive"],
    ["an adaptive Claude", SONNET_5, "adaptive"],
    ["a model that behaves like an adaptive Claude",
      { provider: "anthropic", model: "claude-next", behavesLike: OPUS.model }, "adaptive"],
    ["Haiku", HAIKU, null],
    ["an Anthropic model pi does not know", { provider: "anthropic", model: "claude-next" }, null],
    ["an OpenAI model", GPT, "medium"],
    ["an OpenAI model pi does not know", { provider: "openai", model: "gpt-next" }, "medium"],
    ["an OpenAI model that does no reasoning", { provider: "openai", model: "gpt-4o" }, null],
    ["GLM 5.2", GLM, null],
    ["a Workers AI model that does no reasoning", LLAMA, null],
  ])("sends %s what its built-in reasoning says, on every route", async (_, config, builtIn) => {
    expect(gatewayBuiltInReasoning(config.provider, config.model, config.behavesLike))
        .toBe(builtIn);
    for (const [host, gateway, routing] of GATEWAY_ROUTES) {
      capturedRequests.length = 0;
      const handle = getModel(gateway, { ...config, apiToken: "" }, INITIATOR, routing);
      expect(new URL(handle.model.baseUrl).host).toBe(host);
      const body = JSON.parse((await captureRequest(handle)).body) as Record<string, unknown>;
      expect(reasoningAsked(body)).toEqual(builtInRequest(builtIn));
    }
  });

  // pi leaves the effort out of a request to an OpenAI model that does no reasoning, so one
  // that is asked for none is sent the request it would be sent with an effort.
  it("sends an OpenAI model that does no reasoning a request with no effort", async () => {
    const gpt4o: GatewayConfig = { provider: "openai", model: "gpt-4o" };
    expect(await requestBody(gpt4o)).toBe(JSON.stringify(gptBody(gpt4o, {})));
  });

  // Google's requests go over HTTPS alone.
  it.each(["gemini-3.6-flash", "gemini-2.5-flash", "gemini-next"])(
      "sends Gemini model %s nothing, as its built-in reasoning says", async (model) => {
    expect(gatewayBuiltInReasoning("google", model)).toBeNull();
    expect(await googleThinking(model)).toBeUndefined();
  });

  it("knows a model by an entry of its own, under its own provider", () => {
    expect(isRuntimeModel("anthropic", "claude-opus-5-5")).toBe(true);
    expect(isRuntimeModel("openai", "claude-opus-5-5")).toBe(false);
    expect(isRuntimeModel("anthropic", "claude-next")).toBe(false);
    expect(isRuntimeModel("ollama", "qwen3:8b")).toBe(false);
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      expect(isRuntimeModel("anthropic", inherited)).toBe(false);
    }
  });

  describe("for a model that behaves like another", () => {
    // An added model pi has no entry for, as GatewayModels.resolve() describes it.
    const NEXT: GatewayConfig =
        { provider: "anthropic", model: "claude-next", contextWindow: 500000 };
    const LIKE_OPUS: GatewayConfig = { ...NEXT, behavesLike: "claude-opus-5-5" };
    const budgetBody = (config: GatewayConfig, max_tokens: number, budget_tokens: number) =>
        claudeBody(config, max_tokens,
            { thinking: { type: "enabled", budget_tokens, display: "summarized" } });

    it("sends the level in the format of the model it borrows from", async () => {
      expect(await parsed({ ...LIKE_OPUS, reasoning: "medium" }))
          .toEqual({ ...opusBody("medium"), model: NEXT.model, max_tokens: 4096 });
      // Without the borrow, an Anthropic model pi does not know gets the budget format.
      expect(await parsed({ ...NEXT, reasoning: "medium" })).toEqual(budgetBody(NEXT, 4096, 3072));
    });

    it("borrows the built-in behaviour too", async () => {
      expect(await parsed(LIKE_OPUS))
          .toEqual({ ...opusBody("high"), model: NEXT.model, max_tokens: 4096 });
      expect(await parsed(NEXT)).toEqual(claudeBody(NEXT, 4096));
    });

    it("keeps its own name, cost and limits", () => {
      const { model } = getModel(gatewayEnv, { ...LIKE_OPUS, apiToken: "" }, INITIATOR);
      const opus = ANTHROPIC_MODELS["claude-opus-5-5"];
      expect(model).toMatchObject({
        id: "claude-next", name: "claude-next", contextWindow: 500000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: opus.compat, thinkingLevelMap: opus.thinkingLevelMap, input: opus.input,
      });
      expect(opus).toMatchObject({ name: "Claude Opus 5.5", maxTokens: 128000 });
      expect(opus.cost.input).toBeGreaterThan(0);
      expect(gatewayReasoningLevels("anthropic", "claude-next", "claude-opus-5-5"))
          .toEqual(LOW_TO_MAX);
    });

    // Gemini 3.6 Flash takes a level, where a Gemini model pi does not know is given a budget.
    it("is asked in the other model's format, which pi tells from a Gemini model's ID",
        async () => {
      expect(gatewayReasoningLevels("google", "gemini-next", "gemini-3.6-flash"))
          .toEqual(["minimal", "low", "medium", "high"]);
      expect(await googleThinking("gemini-next", "low", "gemini-3.6-flash"))
          .toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
      expect(await googleThinking("gemini-next", "max", "gemini-3.6-flash"))
          .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
      expect(await googleThinking("gemini-next", "low"))
          .toEqual({ includeThoughts: true, thinkingBudget: 2048 });
    });

    // A Workers AI model pi does not know is assumed to do no reasoning.
    it("borrows whether the model reasons at all", async () => {
      const next: GatewayConfig = { provider: "cloudflare", model: "@cf/test/next" };
      expect(await parsed({ ...next, reasoning: "high" })).toEqual(completionsBody(next));
      expect(await parsed({ ...next, behavesLike: GLM.model, reasoning: "high" }))
          .toEqual(completionsBody(next, { reasoning_effort: "high" }));
      expect(gatewayReasoningLevels("cloudflare", next.model, GLM.model))
          .toEqual(["off", "high", "max"]);
    });

    // pi lets Anthropic answer a Claude Fable 5 request with one of two other models.
    it("does not borrow the models that may answer in the other one's place", async () => {
      const fable = ANTHROPIC_MODELS["claude-fable-5"];
      expect(fable.compat?.allowedFallbackModels).not.toHaveLength(0);
      const config = { ...NEXT, behavesLike: fable.id };
      expect(await parsed(config)).not.toHaveProperty("fallbacks");
      const { model } = getModel(gatewayEnv, { ...config, apiToken: "" }, INITIATOR);
      const { allowedFallbackModels, ...flags } = fable.compat!;
      expect(model.compat).toEqual(flags);
    });

    it("is ignored by a model pi knows", async () => {
      const haiku = { ...HAIKU, behavesLike: "claude-opus-5-5", reasoning: "low" } as const;
      expect(await parsed(haiku)).toEqual(budgetBody(HAIKU, 64000, 2048));
      expect(gatewayReasoningLevels("anthropic", HAIKU.model, "claude-opus-5-5"))
          .toEqual(OFF_TO_HIGH);
    });

    it("is as good as absent when pi does not know the other model either", async () => {
      // A Workers AI model's ID is no Anthropic model's.
      for (const behavesLike of ["claude-nope", GLM.model, "constructor"]) {
        expect(await parsed({ ...NEXT, behavesLike, reasoning: "medium" }))
            .toEqual(budgetBody(NEXT, 4096, 3072));
        expect(gatewayReasoningLevels("anthropic", "claude-next", behavesLike))
            .toEqual(OFF_TO_HIGH);
      }
    });
  });
});

describe("LanguageModelGatekeeper.startSession", () => {
  const MODEL_ID = "claude-opus-5-5";
  const DISABLED: Partial<AdminConfig> = { modelModes: { [MODEL_ID]: "disabled" } };
  const DISABLED_MESSAGE =
      'The "Claude Opus 5.5" model is disabled on this deployment by an administrator.';

  // The session of a binding minted for `config`, on a deployment whose admin config is `admin`.
  function startSession(config: AiModelConfig, admin: Partial<AdminConfig>,
                        overrides: Partial<Cloudflare.Env> = {}) {
    const getConfig = vi.fn(
        async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...admin }));
    const gatekeeper = Object.create(LanguageModelGatekeeper.prototype) as LanguageModelGatekeeper;
    Object.assign(gatekeeper, {
      env: env({ BLUEPRINTS: { get: getConfig } as unknown as KVNamespace, ...overrides }),
      ctx: { props: { displayName: "Model", config, initiator: GADGET_INITIATOR } },
    });
    // The binding implements no actions, so a session never touches its approval queue.
    return { session: gatekeeper.startSession(undefined as never), getConfig };
  }

  it("refuses a gateway model the admin disabled", async () => {
    const config = { provider: "anthropic" as const, model: MODEL_ID, apiToken: "" };
    await expect(startSession(config, DISABLED).session).rejects.toThrow(
        new Error(DISABLED_MESSAGE));
  });

  it.each([
    ["an enabled model", "anthropic", {}],
    ["a hidden model", "anthropic", { modelModes: { [MODEL_ID]: "hidden" } }],
    // A model a user added by hand on another provider, whose model name happens to match.
    ["the disabled model's ID under another provider", "openai", DISABLED],
  ] as const)("starts a session for %s", async (_, provider, admin) => {
    const binding = await startSession({ provider, model: MODEL_ID, apiToken: "" }, admin)
        .session;
    expect(binding.run).toBeTypeOf("function");
  });

  // A binding keeps the config its model resolved to when it was minted. GLM 5.2 is the model
  // whose one-shot request differs once it has a level.
  it("asks for no reasoning level, whatever its model had when it was minted", async () => {
    const glm = { provider: "cloudflare" as const, model: "@cf/zai-org/glm-5.2", apiToken: "" };
    const sent = async (config: AiModelConfig) => {
      capturedRequests.length = 0;
      const binding = await startSession(
          config, {}, { CF_AI_GATEWAY_PROVIDERS: "cloudflare" }).session;
      await expect(binding.run({ prompt: "hello" })).rejects.toThrow();
      return capturedRequests[0].body;
    };
    vi.stubGlobal("fetch", fetchStub);
    try {
      expect(await sent({ ...glm, reasoning: "high" })).toBe(await sent(glm));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not read the admin config outside AI Gateway mode", async () => {
    const { session, getConfig } = startSession(
        { provider: "anthropic", model: MODEL_ID, apiToken: "direct-api-token" },
        { ...DISABLED, userModelsEnabled: false }, { CF_AI_GATEWAY: undefined });
    expect((await session).run).toBeTypeOf("function");
    expect(getConfig).not.toHaveBeenCalled();
  });

  describe("where users' own models are concerned", () => {
    const ADDED = {
      provider: "anthropic" as const, id: "claude-test", name: "Claude Test", contextWindow: 1000,
    };
    const OFF: Partial<AdminConfig> = { userModelsEnabled: false, addedModels: [ADDED] };
    // Bindings for a model that is not the gateway's.
    const BINDINGS = [
      // No gateway model has the ID: a user added the model, or the admin added and removed it.
      ["a model the user added", "anthropic", "my-model"],
      ["a gateway model's ID under another provider", "openai", MODEL_ID],
      ["an added model's ID under another provider", "openai", ADDED.id],
    ] as const;

    it.each(BINDINGS)("starts a session for %s while users may add their own",
        async (_, provider, model) => {
      const binding = await startSession(
          { provider, model, apiToken: "" }, { addedModels: [ADDED] }).session;
      expect(binding.run).toBeTypeOf("function");
    });

    it.each(BINDINGS)("refuses %s once users may not", async (_, provider, model) => {
      await expect(startSession({ provider, model, apiToken: "" }, OFF).session).rejects.toThrow(
          new Error('The "Model" model can\'t be used: adding your own models is disabled on ' +
              "this deployment by an administrator."));
    });

    it.each([
      ["an enabled model", MODEL_ID, {}],
      ["a hidden model", MODEL_ID, { [MODEL_ID]: "hidden" }],
      ["a model the admin added", ADDED.id, {}],
      ["a hidden model the admin added", ADDED.id, { [ADDED.id]: "hidden" }],
    ] as const)("starts a session for %s of the gateway's once users may not",
        async (_, model, modelModes) => {
      const binding = await startSession(
          { provider: "anthropic", model, apiToken: "" }, { ...OFF, modelModes }).session;
      expect(binding.run).toBeTypeOf("function");
    });

    it("refuses a disabled gateway model as disabled once users may not", async () => {
      const config = { provider: "anthropic" as const, model: MODEL_ID, apiToken: "" };
      await expect(startSession(config, { ...OFF, ...DISABLED }).session)
          .rejects.toThrow(new Error(DISABLED_MESSAGE));
    });
  });
});

describe("PDF attachment bridging", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  // PDFs ride pi ImageContent parts (pi has no document part); every handle's onPayload hook
  // rewrites them into the provider's native document blocks (see chat-attachment-pdf.ts).
  // These tests drive the real pi adapters and assert on the outgoing request body.
  const PDF_PART = { type: "image" as const, data: "JVBERi0=", mimeType: "application/pdf" };
  const PNG_PART = { type: "image" as const, data: "iVBOR", mimeType: "image/png" };

  async function capturePdfRequest(handle: ModelHandle): Promise<unknown> {
    const stream = handle.stream(handle.model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Summarize the attached PDF." }, PDF_PART, PNG_PART],
        timestamp: 0,
      }],
    }, { fetch: fetchStub, maxRetries: 0 });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    return JSON.parse(capturedRequests[0].body);
  }

  it("sends Anthropic PDFs as document blocks", async () => {
    const handle = getModel(env(), ANTHROPIC_CONFIG, INITIATOR);
    const body = await capturePdfRequest(handle) as
        { messages: { content: { type: string; source?: { media_type: string } }[] }[] };

    const blocks = body.messages[0].content;
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "document",
      source: expect.objectContaining({ media_type: "application/pdf", data: "JVBERi0=" }),
    }));
    // A real image in the same message stays an image block.
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "image",
      source: expect.objectContaining({ media_type: "image/png" }),
    }));
    expect(blocks.some((block) => block.source?.media_type === "application/pdf" &&
        block.type !== "document")).toBe(false);
  }, 15000);

  it("sends OpenAI PDFs as input_file parts", async () => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai",
      model: "gpt-5.2",
      apiToken: "direct-api-token",
    }, INITIATOR);
    expect(handle.model.api).toBe("openai-responses");
    const body = await capturePdfRequest(handle) as
        { input: { role?: string; content: { type: string; image_url?: string }[] }[] };

    const parts = body.input.find((item) => item.role === "user")!.content;
    expect(parts).toContainEqual({
      type: "input_file",
      filename: "attachment.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(parts).toContainEqual(expect.objectContaining({
      type: "input_image",
      image_url: "data:image/png;base64,iVBOR",
    }));
  }, 15000);
});

// Counts the cache breakpoints in an Anthropic request body.
const breakpointCount = (body: string) => body.split(`"cache_control"`).length - 1;

describe("System prompt cache blocks", () => {
  // The agent's leading system message: shared text as its content, project-specific text as a
  // section (see runAgentPass). Every handle's onPayload hook splits pi's single system block
  // there (see system-prompt-blocks.ts). These tests drive the real pi adapters and compare the
  // outgoing request with one whose prompt is the same text as plain content.
  const STATIC_TEXT = "Shared instructions.";
  const RENDERED_TEXT = `${STATIC_TEXT}\n\nThis workspace's gadgets.`;

  async function captureBody(
      handle: ModelHandle, sections: boolean,
      options: NonNullable<Parameters<ModelHandle["stream"]>[2]> = {}): Promise<string> {
    capturedRequests.length = 0;
    const stream = handle.stream(handle.model, {
      messages: [
        sections
            ? {
                role: "system", content: STATIC_TEXT,
                sections: { environment: "This workspace's gadgets." }, timestamp: 0,
              }
            : { role: "system", content: RENDERED_TEXT, timestamp: 0 },
        { role: "user", content: "hello", timestamp: 0 },
      ],
    }, { fetch: fetchStub, maxRetries: 0, ...options });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    return capturedRequests[0].body;
  }

  // An OAuth token makes pi put an identity block (with its own breakpoint) before the prompt.
  it.each(["direct-api-token", "sk-ant-oat01-direct"])(
      "moves Anthropic's system breakpoint after the static text, with token %s",
      async (apiToken) => {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic", model: "claude-sonnet-4-5", apiToken,
    }, INITIATOR);
    const split = await captureBody(handle, true);
    const unsplit = await captureBody(handle, false);

    const { system: unsplitSystem } = JSON.parse(unsplit);
    expect(unsplitSystem.at(-1)).toMatchObject({ text: RENDERED_TEXT });
    expect(JSON.parse(split).system).toEqual([
      ...unsplitSystem.slice(0, -1),
      { type: "text", text: STATIC_TEXT, cache_control: { type: "ephemeral" } },
      { type: "text", text: RENDERED_TEXT.slice(STATIC_TEXT.length) },
    ]);
    expect(breakpointCount(split)).toBe(breakpointCount(unsplit));
  }, 15000);

  function openAiHandle(model: string): ModelHandle {
    const handle = getModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai", model, apiToken: "direct-api-token",
    }, INITIATOR);
    expect(handle.model.api).toBe("openai-responses");
    return handle;
  }

  it("puts an OpenAI GPT-5.6+ breakpoint after the static text", async () => {
    const handle = openAiHandle("gpt-6-luna");
    expect(JSON.parse(await captureBody(handle, true)).input[0]).toEqual({
      role: "developer",
      content: [
        { type: "input_text", text: STATIC_TEXT, prompt_cache_breakpoint: { mode: "explicit" } },
        { type: "input_text", text: RENDERED_TEXT.slice(STATIC_TEXT.length) },
      ],
    });
  }, 15000);

  it.each([
    { name: "models before GPT-5.6", model: "gpt-5.2", options: {} },
    { name: "requests with caching off", model: "gpt-6-luna", options: { cacheRetention: "none" } },
  ] as const)("leaves the OpenAI prompt whole for $name", async ({ model, options }) => {
    const handle = openAiHandle(model);
    const split = await captureBody(handle, true, options);
    expect(JSON.parse(split).input[0]).toMatchObject({ content: RENDERED_TEXT });
    expect(split).toBe(await captureBody(handle, false, options));
  }, 15000);
});
