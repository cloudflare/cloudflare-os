import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpAccountBase,
  type ConnectedServer,
  type ConnectOutcome,
} from "@gadgets/mcp-shared/account";
import { McpAccount } from "../src/portal.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PORTAL_ENDPOINT = "https://portal.example.com/mcp";

type TestEnv = {
  MCP_PORTAL_URL: string;
  MCP_PORTAL_AUTH: string;
  MCP_PORTAL_TOKEN?: string;
};

function portalServer(
  auth: ConnectedServer["auth"], endpoint = PORTAL_ENDPOINT,
): ConnectedServer {
  return {
    endpoint,
    serverId: "portal",
    serverName: "Portal",
    provenance: "deployment",
    auth,
  };
}

function setup(
  entries: Iterable<readonly [string, unknown]> = [],
  overrides: Partial<TestEnv> = {},
) {
  const values = new Map<string, unknown>(entries);
  const env: TestEnv = {
    MCP_PORTAL_URL: PORTAL_ENDPOINT,
    MCP_PORTAL_AUTH: "oauth",
    ...overrides,
  };
  const account = new McpAccount({
    id: { toString: () => "account" },
    storage: {
      kv: {
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) => values.set(key, value),
        delete: (key: string) => values.delete(key),
      },
    },
    exports: {},
  } as never, env as never);
  return { account, env, values };
}

describe("McpAccount configuration revision", () => {
  it("records the current revision before handing an OAuth attempt to its callback", async () => {
    const { account, env, values } = setup([["portalConfigRevision", "old"]]);
    const server = portalServer("oauth", env.MCP_PORTAL_URL);
    const base = McpAccountBase.prototype as unknown as {
      beginConnect(nonce: string, target: ConnectedServer | null): Promise<ConnectOutcome>;
    };
    vi.spyOn(base, "beginConnect")
      .mockResolvedValue({ kind: "redirect", url: "https://login.example.com" });
    const internals = account as unknown as {
      awaitingSelection(nonce: string): boolean;
      server(): ConnectedServer | undefined;
    };
    vi.spyOn(internals, "awaitingSelection").mockReturnValue(true);
    vi.spyOn(internals, "server").mockReturnValue(server);

    await expect(account.beginConnect("nonce", server))
      .resolves.toMatchObject({ kind: "redirect" });

    expect(values.get("portalConfigRevision")).not.toBe("old");
  });

  it("establishes the current token revision and invalidates a legacy transport session once", async () => {
    const { account, values } = setup([
      ["server", portalServer("token")],
      ["connectionGeneration", 2],
      ["mcpSessionId", "legacy-session"],
    ], {
      MCP_PORTAL_AUTH: "token",
      MCP_PORTAL_TOKEN: "configured-token",
    });

    await expect(account.getConnection(PORTAL_ENDPOINT)).resolves.toMatchObject({
      authorization: "configured-token",
      generation: 3,
      sessionId: null,
    });
    await expect(account.getConnection(PORTAL_ENDPOINT)).resolves.toMatchObject({
      generation: 3,
    });
    expect(values.get("portalConfigRevision")).toEqual(expect.any(String));
  });

  it("allows only OAuth callbacks and fallbacks still permitted by live portal configuration", () => {
    const setupResult = setup();
    const { env } = setupResult;
    const account = setupResult.account as unknown as {
      allowsOAuthCallback(server: ConnectedServer): boolean;
      allowsOAuthFallback(server: ConnectedServer): boolean;
    };
    const oauthServer = portalServer("oauth", env.MCP_PORTAL_URL);

    expect(account.allowsOAuthCallback(oauthServer)).toBe(true);
    expect(account.allowsOAuthFallback(oauthServer)).toBe(true);
    expect(account.allowsOAuthFallback({ ...oauthServer, auth: "none" })).toBe(false);
    env.MCP_PORTAL_AUTH = "none";
    expect(account.allowsOAuthCallback(oauthServer)).toBe(false);
    env.MCP_PORTAL_AUTH = "oauth";
    env.MCP_PORTAL_URL = "https://replacement.example.com/mcp";
    expect(account.allowsOAuthCallback(oauthServer)).toBe(false);
  });

  it("rejects and cleans an OAuth callback after the deployment repoints the portal", async () => {
    const nonce = "n".repeat(64);
    const { account, values } = setup([
      ["nonce", { value: nonce, expiresAt: Date.now() + 60_000, stage: "oauth" }],
      ["pendingAuth", { generation: 1 }],
      ["oauthVerifier", "verifier"],
      ["server", portalServer("oauth", "https://old.example.com/mcp")],
    ], { MCP_PORTAL_URL: "https://new.example.com/mcp" });
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    await expect(account.acceptAuthCode("code", nonce)).resolves.toBe(false);

    expect(values.has("nonce")).toBe(false);
    expect(values.has("pendingAuth")).toBe(false);
    expect(values.has("oauthVerifier")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
