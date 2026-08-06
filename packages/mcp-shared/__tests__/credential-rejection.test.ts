import { describe, expect, it } from "vite-plus/test";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/client";

import { isCredentialRejection, revokeToken, safeOAuthError } from "../src/oauth.js";
import { safeServerText } from "../src/util.js";

describe("isCredentialRejection", () => {
  it.each([
    OAuthErrorCode.InvalidGrant,
    OAuthErrorCode.InvalidClient,
    OAuthErrorCode.UnauthorizedClient,
    OAuthErrorCode.InvalidScope,
  ])("treats the authorization server's %s verdict as final", code => {
    expect(isCredentialRejection(new OAuthError(code, "credential rejected"))).toBe(true);
  });

  it("keeps outages and unknown failures transient", () => {
    expect(isCredentialRejection(
      new OAuthError(OAuthErrorCode.TemporarilyUnavailable, "try later"))).toBe(false);
    expect(isCredentialRejection(new Error("network error"))).toBe(false);
  });
});

describe("safeServerText", () => {
  it("flattens and caps server-written text", () => {
    expect(safeServerText("denied\nERROR fake entry")).toBe("denied ERROR fake entry");
    expect(safeServerText("x".repeat(10_000))!.length).toBeLessThan(250);
  });
});

describe("safeOAuthError", () => {
  it("redacts submitted secrets before capping server text", () => {
    const refreshToken = `rt-${"s".repeat(60)}`;
    const err = safeOAuthError(
      new Error(`${"context-".repeat(20)}refresh_token=${encodeURIComponent(refreshToken)}`),
      [refreshToken],
    );
    expect(err.message).not.toContain(refreshToken);
    expect(err.message).not.toContain(refreshToken.slice(0, 24));
    expect(err.message).toContain("[redacted]");
  });

  it("redacts a confidential client's secret and Basic credential", () => {
    const client = {
      client_id: "client:name",
      client_secret: "cs/secret+0123456789",
    };
    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const err = safeOAuthError(
      new Error(`invalid Authorization header: Basic ${basic}`), [], client);
    expect(err.message).not.toContain(basic);
    expect(err.message).not.toContain(client.client_secret);
    expect(err.message).toContain("Basic [redacted]");
  });

  it("keeps a useful explanation that quotes no secret", () => {
    expect(safeOAuthError(new Error("The grant has expired.")).message)
      .toContain("The grant has expired.");
  });
});

describe("revokeToken", () => {
  it("uses public-client authentication and reports rejection", async () => {
    let request: RequestInit | undefined;
    const discovery = {
      authorizationServerMetadata: { revocation_endpoint: "https://auth.example/revoke" },
    } as never;
    const client = { client_id: "client-id", client_secret: "must-not-send" } as never;

    await revokeToken(discovery, client, "refresh-token", "refresh_token", async (_url, init) => {
      request = init;
      return new Response(null, { status: 200 });
    });

    expect(new Headers(request?.headers).has("Authorization")).toBe(false);
    expect(String(request?.body)).toBe(
      "token=refresh-token&token_type_hint=refresh_token&client_id=client-id");
    await expect(revokeToken(discovery, client, "refresh-token", "refresh_token",
      async () => new Response(null, { status: 400 }))).rejects.toThrow(/HTTP 400/);
  });
});
