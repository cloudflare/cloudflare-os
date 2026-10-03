import { describe, expect, it } from "vitest";
import { assertModelAccess, resolveModelAccess, type LocalModelAccess } from "./target.js";

describe("resolveModelAccess", () => {
  it("uses HTTPS when a Gateway token is present and no binding preference is set", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
      transport: "https",
      apiToken: "token",
    });
  });

  it("uses the Workers AI binding when the Gateway token is absent", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
      transport: "binding",
    });
  });

  it("keeps an injected Gateway token available when the binding is explicitly requested", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "injected-token",
      CF_AI_GATEWAY_USE_BINDING: " TrUe ",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
      transport: "binding",
      apiToken: "injected-token",
    });
  });

  it("uses HTTPS when the binding is opted out", () => {
    const https = {
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
      transport: "https",
      apiToken: "token",
    };
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_USE_BINDING: "false",
    })).toEqual(https);
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
      CF_AI_GATEWAY_USE_BINDING: " False ",
    })).toEqual(https);
  });

  it("requires the Gateway token when the binding is opted out", () => {
    expect(() => resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_USE_BINDING: "false",
    })).toThrow("CF_AI_GATEWAY_API_TOKEN must be set when CF_AI_GATEWAY_USE_BINDING is false");
  });

  it("rejects an unrecognized binding flag", () => {
    expect(() => resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_USE_BINDING: "yes",
    })).toThrow('CF_AI_GATEWAY_USE_BINDING must be "true" or "false"');
  });

  it("uses direct Workers AI credentials", () => {
    expect(resolveModelAccess({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    })).toEqual({ kind: "direct", accountId: "account", apiToken: "token" });
  });

  it("rejects a partial Gateway configuration", () => {
    expect(() => resolveModelAccess({ CF_AI_GATEWAY: "gateway" }))
      .toThrow("require CF_AI_GATEWAY");
  });

  it("rejects a Gateway token without a Gateway", () => {
    expect(() => resolveModelAccess({ CF_AI_GATEWAY_API_TOKEN: "token" }))
      .toThrow("require CF_AI_GATEWAY");
  });

  it("rejects a binding flag without a Gateway", () => {
    expect(() => resolveModelAccess({ CF_AI_GATEWAY_USE_BINDING: "true" }))
      .toThrow("require CF_AI_GATEWAY");
  });

  it("rejects missing model access", () => {
    expect(() => resolveModelAccess({})).toThrow("model access");
  });
});

describe("assertModelAccess", () => {
  const direct: LocalModelAccess = { kind: "direct", accountId: "account", apiToken: "token" };
  const binding: LocalModelAccess = {
    kind: "gateway", gateway: "gateway", accountId: "account", transport: "binding",
  };
  const bindingWithToken: LocalModelAccess = { ...binding, apiToken: "token" };
  const https: LocalModelAccess = {
    kind: "gateway", gateway: "gateway", accountId: "account", transport: "https",
    apiToken: "token",
  };
  const google = { provider: "google", model: "gemini-3.6-flash" } as const;
  const cloudflare = { provider: "cloudflare", model: "@cf/zai-org/glm-5.2" } as const;

  it("limits direct Workers AI credentials to cloudflare models", () => {
    expect(() => assertModelAccess(direct, google)).toThrow("only run cloudflare models");
    expect(() => assertModelAccess(direct, cloudflare)).not.toThrow();
  });

  it("requires the Gateway token for HTTPS-only providers on the binding transport", () => {
    expect(() => assertModelAccess(binding, google)).toThrow("requires CF_AI_GATEWAY_API_TOKEN");
    expect(() => assertModelAccess(bindingWithToken, google)).not.toThrow();
    expect(() => assertModelAccess(https, google)).not.toThrow();
  });

  it("lets cloudflare models ride the binding without a token", () => {
    expect(() => assertModelAccess(binding, cloudflare)).not.toThrow();
  });
});
