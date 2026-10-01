import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUGGESTED_MODELS, type AiModelProvider, type GatewayModel,
} from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import {
  AiGatewayConfig,
  AiGatewayLogRetryableError,
  GatewayModels,
  getAiGatewayLogCost,
  getGatewayModels,
} from "../src/ai-gateway.js";
import { getModel } from "../src/ai-models.js";

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

const ids = (models: readonly { id: string }[]) => models.map(model => model.id);

// A BLUEPRINTS namespace whose only content is the admin config.
const adminConfigKv = (config: Partial<AdminConfig>) => ({
  get: vi.fn(async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...config })),
});

describe("GatewayModels", () => {
  const USER = { type: "user" as const, id: "user-1", name: "User" };
  const DISABLED_MESSAGE =
      'The "Claude Fable 5.1" model is disabled on this deployment by an administrator.';
  const ADDED: GatewayModel[] = [
    { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 },
    {
      provider: "cloudflare", id: "@cf/test/added", name: "Added (Workers AI)",
      contextWindow: 100000, outputLimit: 8000,
    },
    { provider: "anthropic", id: "claude-test-2", name: "Claude Test 2", contextWindow: 200000 },
  ];

  const gatewayEnv = (providers = "anthropic,openai,cloudflare") => env({
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: providers,
  });
  const gatewayModels = (
      config: Partial<Pick<AdminConfig, "modelModes" | "addedModels">> = {}, providers?: string) =>
      new GatewayModels(new AiGatewayConfig(gatewayEnv(providers)),
          { modelModes: {}, addedModels: [], ...config });

  it("offers each catalog model in its default mode, on enabled providers only", () => {
    const models = gatewayModels();
    expect(models.get("claude-opus-5-5")).toStrictEqual({
      provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5",
      contextWindow: 1000000, mode: "enabled", defaultMode: "enabled", added: false,
    });
    expect(models.get("gpt-6-sol")).toMatchObject(
        { outputLimit: 128000, mode: "hidden", defaultMode: "hidden", added: false });
    expect(models.get("gemini-3.6-flash")).toBeUndefined();

    expect(ids(models.all)).toEqual([
      ...Object.keys(SUGGESTED_MODELS.cloudflare),
      ...Object.keys(SUGGESTED_MODELS.anthropic),
      ...Object.keys(SUGGESTED_MODELS.openai),
    ]);
    expect(ids(models.list())).toEqual(ids(models.all.filter(model => model.mode === "enabled")));
    expect(ids(models.list())).toContain("claude-opus-5-5");
    expect(ids(models.list())).not.toContain("gpt-6-sol");
  });

  // Chats, spawners, and preferences created before a model was hidden still name it. A catalog
  // model's limits stay out of its config, where they would override the catalog's own budgets.
  it("still resolves a hidden model that it doesn't list", () => {
    const record = gatewayModels().resolve("gpt-6-sol");
    expect(record).toStrictEqual({
      profile: { type: "agent", id: "gpt-6-sol", name: "GPT-6 Sol" },
      config: { provider: "openai", model: "gpt-6-sol", apiToken: "" },
    });
    expect(getModel(gatewayEnv(), record!.config, USER).model.id).toBe("gpt-6-sol");
  });

  it("hides an enabled model: unlisted, still resolved", () => {
    const models = gatewayModels({ modelModes: { "claude-fable-5-1": "hidden" } });
    expect(models.get("claude-fable-5-1")).toMatchObject({ mode: "hidden", defaultMode: "enabled" });
    expect(ids(models.list())).not.toContain("claude-fable-5-1");
    expect(models.resolve("claude-fable-5-1")?.profile.name).toBe("Claude Fable 5.1");
    expect(() => models.refuseDisabled("claude-fable-5-1")).not.toThrow();
  });

  it("disables an enabled model: unlisted and unresolved, with its ID still reserved", () => {
    const models = gatewayModels({ modelModes: { "claude-fable-5-1": "disabled" } });
    expect(models.get("claude-fable-5-1")).toMatchObject(
        { name: "Claude Fable 5.1", mode: "disabled", defaultMode: "enabled" });
    expect(ids(models.all)).toContain("claude-fable-5-1");
    expect(ids(models.list())).not.toContain("claude-fable-5-1");
    expect(models.resolve("claude-fable-5-1")).toBeUndefined();
    expect(() => models.refuseDisabled("claude-fable-5-1")).toThrow(new Error(DISABLED_MESSAGE));
  });

  it("enables a model the catalog hides, in its catalog position", () => {
    const models = gatewayModels({ modelModes: { "claude-opus-5": "enabled" } });
    expect(models.get("claude-opus-5")).toMatchObject({ mode: "enabled", defaultMode: "hidden" });
    const listed = ids(models.list());
    expect(listed.indexOf("claude-opus-5")).toBe(listed.indexOf("claude-fable-5-1") + 1);
  });

  it("refuses only a disabled gateway model", () => {
    const models = gatewayModels({ modelModes: { "claude-fable-5-1": "disabled" } });
    expect(() => models.refuseDisabled("claude-opus-5-5")).not.toThrow();
    expect(() => models.refuseDisabled("gpt-6-sol")).not.toThrow();
    expect(() => models.refuseDisabled("not-a-gateway-model")).not.toThrow();
  });

  it("lists added models after their provider's catalog models, in stored order", () => {
    const models = gatewayModels({ addedModels: ADDED });
    expect(ids(models.all)).toEqual([
      ...Object.keys(SUGGESTED_MODELS.cloudflare), "@cf/test/added",
      ...Object.keys(SUGGESTED_MODELS.anthropic), "claude-test", "claude-test-2",
      ...Object.keys(SUGGESTED_MODELS.openai),
    ]);
    expect(models.get("claude-test")).toStrictEqual({
      provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000,
      mode: "enabled", defaultMode: "enabled", added: true,
    });
    const listed = ids(models.list());
    expect(listed.indexOf("claude-test")).toBe(listed.indexOf("claude-haiku-4-5") + 1);
    expect(listed.indexOf("claude-test-2")).toBe(listed.indexOf("claude-test") + 1);
  });

  it("resolves an added model with its limits in the config", () => {
    const models = gatewayModels({ addedModels: ADDED });
    const record = models.resolve("@cf/test/added");
    expect(record).toStrictEqual({
      profile: { type: "agent", id: "@cf/test/added", name: "Added (Workers AI)" },
      config: {
        provider: "cloudflare", model: "@cf/test/added", apiToken: "",
        contextWindow: 100000, outputLimit: 8000,
      },
    });
    const handle = getModel(gatewayEnv(), record!.config, USER);
    expect(handle.model.id).toBe("@cf/test/added");
    expect(handle.model.contextWindow).toBe(100000);
    expect(handle.model.maxTokens).toBe(8000);

    expect(models.resolve("claude-test")?.config).toStrictEqual(
        { provider: "anthropic", model: "claude-test", apiToken: "", contextWindow: 500000 });
  });

  it("gives an added model the same three modes", () => {
    const hidden = gatewayModels({ addedModels: ADDED, modelModes: { "claude-test": "hidden" } });
    expect(ids(hidden.list())).not.toContain("claude-test");
    expect(hidden.resolve("claude-test")?.profile.name).toBe("Claude Test");

    const disabled = gatewayModels({ addedModels: ADDED, modelModes: { "claude-test": "disabled" } });
    expect(disabled.get("claude-test")).toMatchObject({ mode: "disabled", defaultMode: "enabled" });
    expect(disabled.resolve("claude-test")).toBeUndefined();
    expect(() => disabled.refuseDisabled("claude-test")).toThrow(
        new Error('The "Claude Test" model is disabled on this deployment by an administrator.'));
  });

  it("leaves out an added model whose provider the gateway does not enable", () => {
    const models = gatewayModels({ addedModels: ADDED }, "anthropic,openai");
    expect(models.get("@cf/test/added")).toBeUndefined();
    expect(models.resolve("@cf/test/added")).toBeUndefined();
    expect(ids(models.all)).not.toContain("@cf/test/added");
    expect(ids(models.list())).toContain("claude-test");
  });

  it("lets the catalog win an ID that an added model also claims", () => {
    const models = gatewayModels({ addedModels: [
      { provider: "cloudflare", id: "claude-opus-5-5", name: "Impostor", contextWindow: 1000 },
      // Listed by the catalog under google, which this gateway does not enable.
      { provider: "cloudflare", id: "gemini-3.6-flash", name: "Impostor", contextWindow: 1000 },
    ] });
    expect(models.get("claude-opus-5-5")).toMatchObject(
        { provider: "anthropic", name: "Claude Opus 5.5", added: false });
    expect(ids(models.all).filter(id => id === "claude-opus-5-5")).toHaveLength(1);
    expect(models.resolve("claude-opus-5-5")?.config).toStrictEqual(
        { provider: "anthropic", model: "claude-opus-5-5", apiToken: "" });
    expect(models.get("gemini-3.6-flash")).toBeUndefined();
  });

  it("keeps the first of two added models sharing an ID", () => {
    const models = gatewayModels({ addedModels: [
      { provider: "anthropic", id: "twice", name: "First", contextWindow: 1000 },
      { provider: "anthropic", id: "twice", name: "Second", contextWindow: 2000 },
    ] });
    expect(models.get("twice")?.name).toBe("First");
    expect(ids(models.all).filter(id => id === "twice")).toHaveLength(1);
  });

  // Every lookup keyed by a model ID has to be an own-property one.
  it.each(["__proto__", "constructor", "toString"])("does not take %s for a model", (id) => {
    const models = gatewayModels();
    expect(models.get(id)).toBeUndefined();
    expect(models.resolve(id)).toBeUndefined();
    expect(() => models.refuseDisabled(id)).not.toThrow();

    // Added under that ID, it is a model like any other, in the default mode.
    const added = gatewayModels(
        { addedModels: [{ provider: "anthropic", id, name: "Odd", contextWindow: 1000 }] });
    expect(added.get(id)).toMatchObject({ mode: "enabled", defaultMode: "enabled", added: true });
    expect(added.resolve(id)?.profile).toEqual({ type: "agent", id, name: "Odd" });
  });

  it("names the providers a model may be added under, in catalog order", () => {
    // The gateway enables ollama here, but does not serve it.
    const models = gatewayModels({}, "openai,ollama,anthropic,mistral");
    expect(models.addableProviders).toEqual(
        Object.keys(SUGGESTED_MODELS).filter(p => p === "openai" || p === "anthropic"));
    expect(models.addableProviders).toHaveLength(2);
  });

  describe("assertAddable", () => {
    const NEW: GatewayModel =
        { provider: "anthropic", id: "claude-new", name: "Claude New", contextWindow: 1000 };
    // openai is not enabled on the gateway these are checked against.
    const models = gatewayModels({ addedModels: [
      ADDED[0]!,
      { provider: "openai", id: "gpt-parked", name: "Parked", contextWindow: 1000 },
    ] }, "anthropic,cloudflare,ollama");

    it("accepts a free ID on a provider the gateway serves and enables", () => {
      expect(() => models.assertAddable(NEW)).not.toThrow();
      expect(() => models.assertAddable({ ...NEW, provider: "cloudflare" })).not.toThrow();
      // Not the name of a model: only an ID has to be free.
      expect(() => models.assertAddable({ ...NEW, name: "Claude Opus 5.5" })).not.toThrow();
    });

    it.each([
      ["an unknown provider", { ...NEW, provider: "mistral" },
        'Provider "mistral" is not served through AI Gateway.'],
      ["an inherited provider name", { ...NEW, provider: "__proto__" },
        'Provider "__proto__" is not served through AI Gateway.'],
      ["a provider the gateway enables but can't serve", { ...NEW, provider: "ollama" },
        'Provider "ollama" is not served through AI Gateway.'],
      ["a provider the gateway does not enable", { ...NEW, provider: "openai" },
        'Provider "openai" is not enabled on this deployment.'],
      ["an ID the catalog already has", { ...NEW, provider: "cloudflare", id: "claude-opus-5-5" },
        '"claude-opus-5-5" is already a suggested model.'],
      ["an ID the catalog has under a provider that is not enabled", { ...NEW, id: "gpt-6-luna" },
        '"gpt-6-luna" is already a suggested model.'],
      ["an ID added already", { ...NEW, provider: "cloudflare", id: "claude-test" },
        '"claude-test" is already an added model.'],
      ["an ID added already under a provider that is not enabled", { ...NEW, id: "gpt-parked" },
        '"gpt-parked" is already an added model.'],
    ])("refuses %s", (_, model, message) => {
      expect(() => models.assertAddable(model as GatewayModel)).toThrow(new Error(message));
    });

    it.each(["__proto__", "constructor", "toString"])("accepts %s as an ID", (id) => {
      expect(() => models.assertAddable({ ...NEW, id })).not.toThrow();
    });
  });

  // The table keeps its own list of the providers getModel can route through the gateway, so an
  // added model it offers is one that can run. This holds the two in step.
  it.each(Object.keys(SUGGESTED_MODELS) as AiModelProvider[])(
      "offers an added model on %s only if the gateway can route it", (provider) => {
    const unroutable = (() => {
      try {
        getModel(gatewayEnv(provider), { provider, model: "test-model", apiToken: "" }, USER);
        return false;
      } catch (err) {
        return String(err).includes("is not supported through AI Gateway");
      }
    })();

    const models = gatewayModels({
      addedModels: [{ provider, id: "test-model", name: "Test", contextWindow: 1000 }],
    }, provider);
    expect(models.get("test-model")?.provider).toBe(unroutable ? undefined : provider);
    expect(models.resolve("test-model")?.config.provider).toBe(unroutable ? undefined : provider);

    expect(models.addableProviders).toEqual(unroutable ? [] : [provider]);
    const add = () => gatewayModels({}, provider).assertAddable(
        { provider, id: "test-model", name: "Test", contextWindow: 1000 });
    if (unroutable) {
      expect(add).toThrow(`Provider "${provider}" is not served through AI Gateway.`);
    } else {
      expect(add).not.toThrow();
    }
  });
});

describe("getGatewayModels", () => {
  it("applies the admin config's modes and added models", async () => {
    const BLUEPRINTS = adminConfigKv({
      modelModes: { "claude-fable-5-1": "disabled" },
      addedModels: [
        { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 500000 },
      ],
    });
    const models = await getGatewayModels(env({
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      BLUEPRINTS: BLUEPRINTS as unknown as KVNamespace,
    }));
    expect(BLUEPRINTS.get).toHaveBeenCalledWith(".adminConfig");
    expect(models!.gateway.gateway).toBe("platform-gateway");
    expect(models!.resolve("claude-fable-5-1")).toBeUndefined();
    expect(ids(models!.list())).toContain("claude-test");
  });

  // A deployment outside AI Gateway mode has no gateway models, and must not pay a KV read to
  // learn that.
  it("is null outside AI Gateway mode, without reading the admin config", async () => {
    const BLUEPRINTS = adminConfigKv({});
    await expect(getGatewayModels(env({
      CF_AI_GATEWAY: undefined,
      BLUEPRINTS: BLUEPRINTS as unknown as KVNamespace,
    }))).resolves.toBeNull();
    expect(BLUEPRINTS.get).not.toHaveBeenCalled();
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
