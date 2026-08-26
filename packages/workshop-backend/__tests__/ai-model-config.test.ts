import { describe, expect, it } from "vitest";
import { normalizeAiModelConfig } from "../src/ai-model-config.js";

const config = {
  provider: "openai-compatible" as const,
  model: "  provider/model  ",
  apiToken: "  secret  ",
  apiUrl: "https://example.com/api/v1/",
  contextWindow: 128_000,
  outputLimit: 8_192,
};

describe("normalizeAiModelConfig", () => {
  it("normalizes an OpenAI-compatible model configuration", () => {
    expect(normalizeAiModelConfig(config)).toEqual({
      ...config,
      model: "provider/model",
      apiToken: "secret",
      apiUrl: "https://example.com/api/v1",
    });
  });

  it("uses Pi metadata for a recognized endpoint and model", () => {
    expect(normalizeAiModelConfig({
      ...config,
      model: "gemma-4-31b",
      apiUrl: "https://api.cerebras.ai/v1/chat/completions",
      contextWindow: undefined,
      outputLimit: undefined,
    })).toMatchObject({
      apiUrl: "https://api.cerebras.ai/v1",
      contextWindow: 131_072,
      outputLimit: 40_960,
    });
  });

  it("accepts equal context and output maxima published by Pi", () => {
    expect(normalizeAiModelConfig({
      ...config,
      model: "grok-build-0.1",
      apiUrl: "https://api.x.ai/v1",
      contextWindow: undefined,
      outputLimit: undefined,
    })).toMatchObject({contextWindow: 256_000, outputLimit: 256_000});
  });

  it.each([
    "http://localhost:8080/v1",
    "http://127.42.0.1:8080/v1",
    "http://[::1]:8080/v1",
  ])("allows loopback HTTP endpoints (%s)", (apiUrl) => {
    expect(normalizeAiModelConfig({...config, apiUrl}).apiUrl).toBe(apiUrl);
  });

  it("does not impose an arbitrary maximum context window", () => {
    expect(normalizeAiModelConfig({...config, contextWindow: 2_000_001}).contextWindow)
        .toBe(2_000_001);
  });

  it("normalizes a pasted Chat Completions endpoint to its base URL", () => {
    expect(normalizeAiModelConfig({
      ...config,
      apiUrl: "https://example.com/v1/chat/completions///",
    }).apiUrl).toBe("https://example.com/v1");
  });

  it.each([
    { name: "model ID", overrides: { model: " " }, error: "model ID" },
    { name: "API token", overrides: { apiToken: " " }, error: "API token" },
    { name: "base URL", overrides: { apiUrl: undefined }, error: "base URL" },
    { name: "invalid URL", overrides: { apiUrl: "not a URL" }, error: "valid HTTPS" },
    { name: "HTTP URL", overrides: { apiUrl: "http://example.com/v1" }, error: "valid HTTPS" },
    { name: "URL credentials", overrides: { apiUrl: "https://user:pass@example.com/v1" }, error: "credentials" },
    { name: "URL query", overrides: { apiUrl: "https://example.com/v1?route=chat" }, error: "query" },
    { name: "URL fragment", overrides: { apiUrl: "https://example.com/v1#chat" }, error: "fragment" },
    { name: "zero context window", overrides: { contextWindow: 0 }, error: "context window" },
    { name: "fractional output limit", overrides: { outputLimit: 1.5 }, error: "output limit" },
    {
      name: "output equal to context",
      overrides: { outputLimit: 128_000 },
      error: "less than",
    },
  ])("rejects an invalid $name", ({ overrides, error }) => {
    expect(() => normalizeAiModelConfig({ ...config, ...overrides })).toThrow(error);
  });

  it("leaves other providers unchanged", () => {
    const existing = { provider: "openai" as const, model: "gpt", apiToken: " token " };
    expect(normalizeAiModelConfig(existing)).toBe(existing);
  });
});
