import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  IssuerMismatchError,
  startAuthorization,
} from "@modelcontextprotocol/client";

import { sdkFetch } from "../src/fetch.js";

function stubFetch(responses: Record<string, unknown>): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = String(input);
    seen.push(url);
    const body = responses[url];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("SDK OAuth discovery through the guarded fetch adapter", () => {
  it("preserves a resource query in protected-resource discovery", async () => {
    const endpoint = "https://mcp.example.com/mcp?tenant=one";
    const seen = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp?tenant=one": {
        resource: endpoint,
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });
    const info = await discoverOAuthServerInfo(endpoint, { fetchFn: sdkFetch() });
    expect(info.authorizationServerUrl).toBe("https://auth.example.com");
    expect(seen[0]).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp?tenant=one");
  });

  it("never fetches a blocked advertised metadata URL", async () => {
    const seen = stubFetch({});
    const info = await discoverOAuthServerInfo("https://mcp.example.com/mcp", {
      resourceMetadataUrl: new URL("http://169.254.169.254/latest/meta-data/"),
      fetchFn: sdkFetch(),
    });
    expect(info.authorizationServerUrl).toBe("https://mcp.example.com/");
    expect(seen).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("requires authorization metadata to echo the exact issuer", async () => {
    stubFetch({
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://other.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });
    await expect(discoverAuthorizationServerMetadata("https://auth.example.com", {
      fetchFn: sdkFetch(),
    })).rejects.toBeInstanceOf(IssuerMismatchError);
  });
});

describe("SDK authorization URL construction", () => {
  it("does not request every advertised scope by default", async () => {
    const { authorizationUrl } = await startAuthorization("https://auth.example.com", {
      metadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        scopes_supported: ["admin", "files:write"],
        response_types_supported: ["code"],
      },
      clientInformation: { client_id: "client" },
      redirectUrl: "https://gatekeeper.example.com/oauth",
      state: "state",
      resource: new URL("https://mcp.example.com/mcp"),
    });
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);
  });
});
