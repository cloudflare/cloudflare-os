import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel, type ModelHandle } from "../src/ai-models.js";

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

const capturedRequests: CapturedRequest[] = [];

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  capturedRequests.push({ url: request.url, headers: request.headers, body: await request.text() });
  // A non-retryable client error: the provider SDK reports it, pi converts it into an
  // error-stop assistant message, and the request stays captured for assertions.
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

// Runs one request through the handle with the fetch stub and returns what was sent.
async function captureRequest(handle: ModelHandle): Promise<CapturedRequest> {
  const stream = await handle.stream(handle.model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { fetch: fetchStub, maxRetries: 0 });
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
    expect(request.url).toBe(
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

  it("rejects conflicting Workers AI routing configuration", () => {
    expect(() => getModel(env({
      CF_AI_GATEWAY_WAI: "workers-ai-gateway",
      CF_AI_GATEWAY_WAI_DIRECT: "true",
    }), WORKERS_AI_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
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
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/user-account-id/default/anthropic/v1/messages");
    // The user's token authorizes the gateway; the SDK's own auth headers are suppressed so the
    // gateway's unified-billing provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer user-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("routes Workers AI to its REST endpoint when explicitly configured direct", async () => {
    const handle = getModel(
        env({ CF_AI_GATEWAY_WAI_DIRECT: "true" }),
        WORKERS_AI_CONFIG,
        INITIATOR,
        { sessionAffinity: "session-a" });

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai/v1");
    // No gateway in the path: no log route (and no gateway metadata).
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
    // Session affinity flows through (Workers AI models opt in to the affinity headers).
    expect(request.headers.get("x-session-affinity")).toBe("session-a");
  }, 15000);

  it("routes same-account Workers AI through the platform gateway by default", () => {
    const handle = getModel(env(), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });

  it("uses an explicit Workers AI gateway override", () => {
    const handle = getModel(
        env({ CF_AI_GATEWAY_WAI: "workers-ai-gateway" }), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/workers-ai-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "workers-ai-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });
});

describe("getModel AI Gateway binding transport", () => {
  // Universal-endpoint entries captured by the fake Workers AI binding. In binding mode the
  // handle's requests never hit HTTP: pi's SDK fetch is the pi gateway-binding shim, which
  // translates each request into binding.gateway(gw).run(entry).
  type CapturedEntry = {
    gatewayId: string;
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    query: unknown;
  };
  const capturedEntries: CapturedEntry[] = [];

  const fakeBinding = {
    gateway: (gatewayId: string) => ({
      run: async (data: Omit<CapturedEntry, "gatewayId">) => {
        capturedEntries.push({ gatewayId, ...data });
        // Same non-retryable client error as the HTTP fetch stub: pi surfaces an error-stop
        // message and the entry stays captured for assertions.
        return Response.json(
            { error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
      },
    }),
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

  async function captureEntry(handle: ModelHandle): Promise<CapturedEntry> {
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
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic");
    // Same-account log reads ride the binding too: no account id or token in the route.
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });

    const entry = await captureEntry(handle);
    expect(entry.gatewayId).toBe("platform-gateway");
    expect(entry.provider).toBe("anthropic");
    expect(entry.endpoint).toBe("v1/messages");
    // The sentinel auth header satisfies pi's request-auth check but must never reach the
    // gateway; the SDK's own auth headers stay suppressed.
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("cf-aig-authorization");
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("authorization");
    const metadataHeader = Object.entries(entry.headers)
        .find(([name]) => name.toLowerCase() === "cf-aig-metadata")?.[1];
    expect(JSON.parse(metadataHeader!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
    expect((entry.query as { model: string }).model).toBe("claude-sonnet-4-5");
  }, 15000);

  it("drives Workers AI through the binding via its gateway route", async () => {
    const handle = getModel(bindingEnv({ CF_AI_GATEWAY_WAI: "workers-ai-gateway" }),
        WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/workers-ai-gateway/" +
        "workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "workers-ai-gateway" });

    const entry = await captureEntry(handle);
    expect(entry.gatewayId).toBe("workers-ai-gateway");
    expect(entry.provider).toBe("workers-ai");
    expect(entry.endpoint).toBe("v1/chat/completions");
    expect((entry.query as { model: string }).model)
        .toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // openai-completions adapters inject `Authorization: Bearer unused` under header-owned
    // auth; the gatewayAuthHeaders nulls must delete it before the entry is built, else the
    // gateway would treat it as a request-supplied provider key overriding stored keys.
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("cf-aig-authorization");
  }, 15000);

  it("requires the token for direct Workers AI REST routing", () => {
    expect(() => getModel(bindingEnv({ CF_AI_GATEWAY_WAI_DIRECT: "true" }),
        WORKERS_AI_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_WAI_DIRECT bypasses the gateway");
  });

  it("lets a per-call fetch override the binding transport", async () => {
    // Tests and diagnostics inject options.fetch; it must win over the handle's binding shim.
    // The raw request still carries the sentinel (stripping is the shim's job).
    const handle = getModel(bindingEnv(), ANTHROPIC_CONFIG, INITIATOR);

    const request = await captureRequest(handle);
    expect(capturedEntries).toHaveLength(0);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic/" +
        "v1/messages");
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
    expect(entry.provider).toBe("anthropic");
    const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("cf-aig-authorization");
  }, 15000);

  it("requires the token when google is an enabled provider", () => {
    expect(() => getModel(
        bindingEnv({ CF_AI_GATEWAY_PROVIDERS: "anthropic,google" }),
        ANTHROPIC_CONFIG, INITIATOR)).toThrow(
        "enabling the google provider requires CF_AI_GATEWAY_API_TOKEN");
  });

});

describe("getModel direct routing (no gateway)", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
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
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("direct-api-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
  }, 15000);

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
