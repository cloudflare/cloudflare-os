import { describe, expect, it } from "vitest";
import { resolveModelAccess } from "./target.js";

describe("resolveModelAccess", () => {
  it("uses a complete AI Gateway configuration", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
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
    });
  });

  it("lets an explicit binding override an injected Gateway token", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "injected-token",
      CF_AI_GATEWAY_USE_BINDING: " TrUe ",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
    });
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

  it("requires a token when the binding is explicitly disabled", () => {
    expect(() => resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_USE_BINDING: "false",
    })).toThrow("CF_AI_GATEWAY_API_TOKEN");
  });

  it("rejects an invalid binding preference", () => {
    expect(() => resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_USE_BINDING: "sometimes",
    })).toThrow("true or false");
  });

  it("rejects missing model access", () => {
    expect(() => resolveModelAccess({})).toThrow("model access");
  });
});
