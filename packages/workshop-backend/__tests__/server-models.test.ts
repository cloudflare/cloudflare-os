import { describe, it, expect } from "vitest";
import { getServerModelsConfig, ServerModelsConfig } from "../src/server-models.js";
import { getModelTokenLimits } from "../src/agent-compaction.js";

function env(serverModels?: string): Cloudflare.Env {
  return { SERVER_MODELS: serverModels } as unknown as Cloudflare.Env;
}

const ONE = JSON.stringify([{
  id: "house-sonnet",
  name: "Sonnet (internal)",
  provider: "anthropic",
  model: "claude-sonnet-5",
  apiUrl: "https://llm.example.com",
  apiToken: "secret-token",
}]);

describe("getServerModelsConfig", () => {
  it("returns null when unset or empty", () => {
    expect(getServerModelsConfig(env())).toBeNull();
    expect(getServerModelsConfig(env(""))).toBeNull();
    expect(getServerModelsConfig(env("   "))).toBeNull();
    expect(getServerModelsConfig(env("[]"))).toBeNull();
  });

  it("parses a configured model", () => {
    const config = getServerModelsConfig(env(ONE))!;
    expect(config.has("house-sonnet")).toBe(true);
    expect(config.getModelList()).toEqual([
      { type: "agent", id: "house-sonnet", name: "Sonnet (internal)" },
    ]);
  });

  it("resolves to a record carrying the deployment's own endpoint and token", () => {
    const resolved = getServerModelsConfig(env(ONE))!.resolveModel("house-sonnet")!;
    expect(resolved.config.apiUrl).toBe("https://llm.example.com");
    expect(resolved.config.apiToken).toBe("secret-token");
    // This flag is what keeps inference off an AI Gateway, which would discard both.
    expect(resolved.config.serverManaged).toBe(true);
  });

  it("returns undefined for an unknown id", () => {
    expect(getServerModelsConfig(env(ONE))!.resolveModel("nope")).toBeUndefined();
  });

  it("defaults id and name to the model name", () => {
    const config = new ServerModelsConfig(
        JSON.stringify([{ provider: "ollama", model: "qwen3" }]));
    expect(config.getModelList()).toEqual([{ type: "agent", id: "qwen3", name: "qwen3" }]);
  });

  it("allows an empty token, for endpoints that want no Authorization header", () => {
    const config = new ServerModelsConfig(
        JSON.stringify([{ provider: "ollama", model: "qwen3", apiUrl: "http://ollama:11434" }]));
    expect(config.resolveModel("qwen3")!.config.apiToken).toBe("");
  });

  it("preserves configured order", () => {
    const config = new ServerModelsConfig(JSON.stringify([
      { provider: "ollama", model: "b" },
      { provider: "ollama", model: "a" },
    ]));
    expect(config.getModelList().map(m => m.id)).toEqual(["b", "a"]);
  });

  // A deployment that meant to supply models should fail loudly rather than quietly offer none.
  describe("rejects malformed configuration", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["invalid JSON", "{not json", /not valid JSON/],
      ["a non-array", JSON.stringify({ provider: "ollama" }), /must be a JSON array/],
      ["a non-object entry", JSON.stringify(["x"]), /must be an object/],
      ["an unknown provider",
       JSON.stringify([{ provider: "hal9000", model: "m" }]), /"provider" must be one of/],
      ["a missing model", JSON.stringify([{ provider: "ollama" }]), /"model" is required/],
      ["a non-string apiUrl",
       JSON.stringify([{ provider: "ollama", model: "m", apiUrl: 7 }]), /"apiUrl" must be a string/],
      ["a non-numeric contextWindow",
       JSON.stringify([{ provider: "ollama", model: "m", contextWindow: "big" }]),
       /"contextWindow" must be a number/],
      ["duplicate ids",
       JSON.stringify([{ provider: "ollama", model: "m" }, { provider: "ollama", model: "m" }]),
       /duplicate id/],
    ];
    for (const [label, json, message] of cases) {
      it(`throws on ${label}`, () => {
        expect(() => new ServerModelsConfig(json)).toThrow(message);
      });
    }
  });

  it("reports which entry was bad", () => {
    expect(() => new ServerModelsConfig(JSON.stringify([
      { provider: "ollama", model: "ok" },
      { provider: "ollama" },
    ]))).toThrow(/SERVER_MODELS\[1\]/);
  });
});

describe("getModelTokenLimits with a server model", () => {
  it("uses the configured window instead of the default", () => {
    const config = new ServerModelsConfig(JSON.stringify([{
      provider: "ollama", model: "big-context", contextWindow: 1_000_000, outputLimit: 64_000,
    }])).resolveModel("big-context")!.config;

    expect(getModelTokenLimits(config)).toEqual({
      inputBudget: 1_000_000 - 64_000,
      maxOutputTokens: 64_000,
    });
  });

  it("falls back to the default window when none is configured", () => {
    const config = new ServerModelsConfig(
        JSON.stringify([{ provider: "ollama", model: "unknown-model" }]))
        .resolveModel("unknown-model")!.config;

    expect(getModelTokenLimits(config).inputBudget).toBe(128_000);
  });
});
