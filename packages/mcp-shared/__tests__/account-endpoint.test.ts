import { afterEach, describe, expect, it, vi } from "vitest";

import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";

import { McpAuthRequiredError } from "../src/client.js";
import {
  McpAccountBase, resolveConnectTarget, type AccountEnv, type ConnectedServer,
} from "../src/account.js";

function fakeContext() {
  const values = new Map<string, unknown>();
  return {
    id: { toString: () => "account-id" },
    storage: {
      async deleteAlarm() {},
      async setAlarm() {},
      async deleteAll() { values.clear(); },
      kv: {
        get<T>(key: string) { return values.get(key) as T | undefined; },
        put<T>(key: string, value: T) { values.set(key, value); },
        delete(key: string) { values.delete(key); },
      },
    },
  };
}

const testLog = { with() { return testLog; }, info() {}, warn() {} };

class InterleavingAccount extends McpAccountBase<AccountEnv> {
  #rejectProbe: ((reason: Error) => void) | undefined;

  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override staticToken(): string { return "new-portal-token"; }
  protected override async probe(): Promise<never> {
    return await new Promise<never>((_resolve, reject) => { this.#rejectProbe = reject; });
  }

  failProbe(): void {
    this.#rejectProbe?.(new Error("stop test probe"));
  }

  isWaiting(nonce: string): boolean {
    return this.awaitingSelection(nonce);
  }
}

// Stands in for a deployment-configured portal: the token comes from live configuration, and the
// configuration names one endpoint at a time.
class ConfiguredTokenAccount extends McpAccountBase<AccountEnv> {
  configuredEndpoint = "https://old.example/mcp";
  configuredToken = "old-portal-token";

  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override staticToken(server: ConnectedServer): string | null {
    // The real portal's rule: only answer for the endpoint configuration currently names.
    return this.configuredEndpoint === server.endpoint ? this.configuredToken : null;
  }
  protected override async probe(): Promise<never> { throw new Error("not probed"); }
}

// Exercises the expiry latch. The callback is the Workshop, reached over RPC, so it can fail
// transiently without anything being wrong with the account.
class ExpiringAccount extends McpAccountBase<AccountEnv> {
  notifications = 0;
  failNext = false;

  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override async probe(): Promise<never> { throw new Error("not probed"); }

  installCallback(): void {
    this.ctx.storage.kv.put("callback", {
      credentialsExpired: async () => {
        if (this.failNext) throw new Error("workshop unreachable");
        this.notifications++;
      },
    });
  }
}

// A deployment that named a `"token"` endpoint but configured no token for it.
class UnconfiguredTokenAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override staticToken(): string | null { return null; }
  protected override async probe(): Promise<never> {
    throw new Error("probe must not run without a configured token");
  }

  isWaiting(nonce: string): boolean {
    return this.awaitingSelection(nonce);
  }
}

class AuthChallengeAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override async probe(): Promise<never> {
    throw new McpAuthRequiredError("authorization required", null);
  }
}

class OAuthFlowAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { return {} as never; }
  protected override async probe(
    _server: ConnectedServer, accessToken: string | null,
  ): Promise<never> {
    if (!accessToken) throw new McpAuthRequiredError("authorization required", null);
    // The transport session the server opened for these credentials.
    return {
      info: { serverInfo: { name: "Acme" } }, sessionId: `session-for-${accessToken}`,
    } as never;
  }
}

// A server that answers `initialize` with or without a credential.
class PublicServerAccount extends McpAccountBase<AccountEnv> {
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { return {} as never; }
  protected override async probe(): Promise<never> {
    return { info: { serverInfo: { name: "Acme" } }, sessionId: "public-session" } as never;
  }
}

afterEach(() => vi.unstubAllGlobals());

// An authorization server that registers any client, exchanges any code, and revokes any token,
// recording the bodies of the revocations it is asked for.
function stubOAuthServer(): { revoked: string[] } {
  const revoked: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      return Response.json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://auth.example"],
      });
    }
    if (url.includes("oauth-authorization-server")) {
      return Response.json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        revocation_endpoint: "https://auth.example/revoke",
        response_types_supported: ["code"],
      });
    }
    if (url === "https://auth.example/revoke") {
      revoked.push(String(init?.body));
      return new Response(null, { status: 200 });
    }
    if (url === "https://auth.example/register") {
      return Response.json({
        client_id: "client-id",
        redirect_uris: ["https://gatekeeper.example/oauth"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    if (url === "https://auth.example/token") {
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response("", { status: 404 });
  });
  return { revoked };
}

const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "c".repeat(64) };

const server = (endpoint: string): ConnectedServer => ({
  endpoint,
  serverId: "acme",
  serverName: "Acme",
  provenance: "user",
  auth: "oauth",
});

describe("connect initiation nonce", () => {
  it("is claimed before probing can let another completion request interleave", async () => {
    const nonce = "a".repeat(64);
    const account = new InterleavingAccount(fakeContext() as never, {});
    await account.prepareReconnect(nonce);

    // The first request reaches a probe that deliberately never settles. Durable Object requests can
    // interleave at that await, so the second request exercises the exact duplicate-completion race.
    const first = account.beginConnect(nonce, server("https://a.example/mcp"));
    await expect(account.beginConnect(nonce, server("https://a.example/mcp")))
      .resolves.toEqual({ kind: "invalid" });

    account.failProbe();
    await expect(first).rejects.toThrow("stop test probe");
    // The request still owns the claim, so a transient failure reopens the already-rendered form.
    expect(account.isWaiting(nonce)).toBe(true);
  });

  it("does not hand current credentials to a facet for the pre-repoint endpoint", async () => {
    const context = fakeContext();
    context.storage.kv.put("server", {
      ...server("https://new.example/mcp"), auth: "none",
    });
    const account = new AuthChallengeAccount(context as never, {});

    await expect(account.getConnection("https://old.example/mcp"))
      .rejects.toThrow(/account is now connected to new\.example/);
  });

  it("moves the server record before probing a repointed static-token portal", async () => {
    // `staticToken()` reads current deployment configuration. If the account kept the old server
    // record during the new probe, this stale facet would pass validation and receive the new token.
    const context = fakeContext();
    context.storage.kv.put("server", {
      ...server("https://old.example/mcp"), auth: "token", provenance: "deployment",
    });
    const account = new InterleavingAccount(context as never, {});
    const nonce = "c".repeat(64);
    await account.prepareReconnect(nonce);
    const repoint = account.beginConnect(nonce, {
      ...server("https://new.example/mcp"), auth: "token", provenance: "deployment",
    });

    expect(context.storage.kv.get<ConnectedServer>("server")?.endpoint)
      .toBe("https://new.example/mcp");
    await expect(account.getConnection("https://old.example/mcp"))
      .rejects.toThrow(/account is now connected to new\.example/);

    account.failProbe();
    await expect(repoint).rejects.toThrow("stop test probe");
  });

  it("ignores a transport session written by an operation from before repoint", async () => {
    const context = fakeContext();
    const old = { ...server("https://old.example/mcp"), auth: "none" as const };
    context.storage.kv.put("server", old);
    const account = new InterleavingAccount(context as never, {});
    const connection = await account.getConnection(old.endpoint);

    const nonce = "d".repeat(64);
    await account.prepareReconnect(nonce);
    const repoint = account.beginConnect(nonce, {
      ...server("https://new.example/mcp"), provenance: "deployment",
    });
    await account.setMcpSessionId(
      old.endpoint, connection.generation, connection.sessionId, "old-session");
    expect(context.storage.kv.get("mcpSessionId")).toBeUndefined();

    account.failProbe();
    await expect(repoint).rejects.toThrow("stop test probe");
  });

  it("does not let concurrent initialization overwrite the first stored session", async () => {
    const context = fakeContext();
    const connected = { ...server("https://mcp.example/mcp"), auth: "none" as const };
    context.storage.kv.put("server", connected);
    const account = new InterleavingAccount(context as never, {});
    const first = await account.getConnection(connected.endpoint);
    const second = await account.getConnection(connected.endpoint);

    await expect(account.setMcpSessionId(
      connected.endpoint, first.generation, null, "first-session")).resolves.toBe(true);
    await expect(account.setMcpSessionId(
      connected.endpoint, second.generation, null, "first-session")).resolves.toBe(true);
    await expect(account.setMcpSessionId(
      connected.endpoint, second.generation, null, "second-session")).resolves.toBe(false);

    expect(context.storage.kv.get("mcpSessionId")).toBe("first-session");
  });

  it("does not let an old in-flight refresh restore tokens after repoint", async () => {
    const context = fakeContext();
    const old = { ...server("https://old.example/mcp"), auth: "oauth" as const };
    context.storage.kv.put("server", old);
    context.storage.kv.put("tokens", {
      access_token: "expired",
      token_type: "Bearer",
      refresh_token: "old-refresh",
      issuer: "https://auth.old.example",
      expiresAt: Date.now() - 1000,
    });
    context.storage.kv.put("oauthDiscovery", {
      authorizationServerUrl: "https://auth.old.example",
      authorizationServerMetadata: {
        issuer: "https://auth.old.example",
        authorization_endpoint: "https://auth.old.example/authorize",
        token_endpoint: "https://auth.old.example/token",
      },
    });
    context.storage.kv.put("oauthClient", {
      client_id: "old-client", issuer: "https://auth.old.example",
    });
    const account = new InterleavingAccount(context as never, {});

    let answerRefresh: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { answerRefresh = resolve; }));
    const refreshing = account.getConnection(old.endpoint);
    await vi.waitFor(() => expect(answerRefresh).toBeDefined());

    const nonce = "e".repeat(64);
    await account.prepareReconnect(nonce);
    const repoint = account.beginConnect(nonce, {
      ...server("https://new.example/mcp"), provenance: "deployment",
    });
    answerRefresh!(new Response(JSON.stringify({
      access_token: "late-old-access", refresh_token: "late-old-refresh",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(refreshing).rejects.toThrow(/previous MCP connection|connection changed/);
    expect(context.storage.kv.get("tokens")).toBeUndefined();

    account.failProbe();
    await expect(repoint).rejects.toThrow("stop test probe");
  });

  it("uses the default lifetime when a refresh omits expires_in", async () => {
    const context = fakeContext();
    const connected = { ...server("https://old.example/mcp"), auth: "oauth" as const };
    context.storage.kv.put("server", connected);
    context.storage.kv.put("tokens", {
      access_token: "expired",
      token_type: "Bearer",
      refresh_token: "refresh",
      issuer: "https://auth.example",
      expiresAt: Date.now() - 1000,
    });
    context.storage.kv.put("oauthDiscovery", {
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
      },
    });
    context.storage.kv.put("oauthClient", {
      client_id: "client", issuer: "https://auth.example",
    });
    const account = new OAuthFlowAccount(context as never, {});
    let refreshes = 0;
    vi.stubGlobal("fetch", async () => {
      refreshes++;
      return new Response(JSON.stringify({ access_token: "fresh", token_type: "Bearer" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    await expect(account.getConnection(connected.endpoint))
      .resolves.toMatchObject({ authorization: "fresh" });
    await expect(account.getConnection(connected.endpoint))
      .resolves.toMatchObject({ authorization: "fresh" });
    expect(refreshes).toBe(1);
  });

  it("withholds a repointed deployment's token from a facet on the old endpoint", async () => {
    // The window that matters. A repoint is a configuration edit that touches no account, so until
    // someone reconnects the account still names the old endpoint and a stale facet's endpoint check
    // passes. `staticToken()` is the one credential read from live configuration rather than from
    // this account's storage, so without endpoint scoping it answers with the *new* portal's secret.
    const context = fakeContext();
    context.storage.kv.put("server", {
      ...server("https://old.example/mcp"), auth: "token", provenance: "deployment",
    });
    const account = new ConfiguredTokenAccount(context as never, {});

    // Before the repoint the configured token is served normally.
    await expect(account.getConnection("https://old.example/mcp"))
      .resolves.toMatchObject({ authorization: "old-portal-token" });

    // The administrator repoints the gateway and rotates its token. Nobody has reconnected yet.
    account.configuredEndpoint = "https://new.example/mcp";
    account.configuredToken = "new-portal-token";

    const failure = await account.getConnection("https://old.example/mcp").catch(err => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain("new-portal-token");
    expect(failure.message).toMatch(/reconnect the account/i);
  });

  it("does not spend the expiry latch on a failed notification", async () => {
    // The latch exists to stop every concurrent caller notifying at once. Persisting it before the
    // call meant one dropped connection to the Workshop silenced this account's expiry warning
    // forever, so the user was never told to reconnect and nothing could take it back.
    const context = fakeContext();
    const connected = { ...server("https://a.example/mcp"), auth: "oauth" as const };
    context.storage.kv.put("server", connected);
    const account = new ExpiringAccount(context as never, {});
    account.installCallback();

    // Best-effort: callers await this before throwing their own "please reconnect", so a broken
    // callback must release the latch without replacing that message with an RPC error.
    account.failNext = true;
    await account.noteCredentialsExpired(connected.endpoint, 0);
    expect(context.storage.kv.get("expiredNotified")).toBe(false);

    // The next attempt still gets through.
    account.failNext = false;
    await account.noteCredentialsExpired(connected.endpoint, 0);
    expect(account.notifications).toBe(1);
    expect(context.storage.kv.get("expiredNotified")).toBe(true);

    // And having succeeded, it stays latched: one warning per expiry, not one per failed call.
    await account.noteCredentialsExpired(connected.endpoint, 0);
    expect(account.notifications).toBe(1);
  });

  it("refuses to connect a token endpoint with no token configured", async () => {
    // The probe would not reveal this: it runs with whatever `staticToken` returns, so a server
    // whose `initialize` is public answers happily and the account is recorded as connected. Every
    // real call then dies in `getAuthorization`, with the misconfiguration surfacing far from the
    // setting that caused it.
    const context = fakeContext();
    const account = new UnconfiguredTokenAccount(context as never, {});
    const nonce = "f".repeat(64);
    await account.prepareReconnect(nonce);

    await expect(account.beginConnect(nonce, {
      ...server("https://portal.example/mcp"), auth: "token", provenance: "deployment",
    })).rejects.toThrow(/No preissued token is configured/);

    // Nothing was recorded, and the link still works so an administrator can set the token and retry.
    expect(context.storage.kv.get("server")).toBeUndefined();
    expect(context.storage.kv.get("connected")).toBeUndefined();
    expect(account.isWaiting(nonce)).toBe(true);
  });

  it("adopts OAuth but refuses a private authorization redirect", async () => {
    const context = fakeContext();
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://portal.example/mcp",
          authorization_servers: ["https://auth.example"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.example",
          authorization_endpoint: "https://127.0.0.1/authorize",
          token_endpoint: "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          response_types_supported: ["code"],
        });
      }
      if (url === "https://auth.example/register") {
        return Response.json({
          client_id: "client-id",
          redirect_uris: ["https://gatekeeper.example/oauth"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }
      return new Response("", { status: 404 });
    });
    const account = new AuthChallengeAccount(context as never, {});
    const nonce = "b".repeat(64);
    await account.setCallback({} as never, nonce);

    await expect(account.beginConnect(nonce, {
      ...server("https://portal.example/mcp"), auth: "none", provenance: "deployment",
    })).rejects.toThrow(/unsafe authorization URL/);
    await expect(account.beginConnect(nonce, {
      ...server("https://portal.example/mcp"), auth: "none", provenance: "deployment",
    })).rejects.toThrow(/unsafe authorization URL/);
    expect(context.storage.kv.get<ConnectedServer>("server")?.auth).toBe("oauth");
  });

  it("completes OAuth after a new account instance resumes the redirect", async () => {
    const context = fakeContext();
    const complete = vi.fn(async () => HANDOFF);
    stubOAuthServer();

    const nonce = "9".repeat(64);
    const account = new OAuthFlowAccount(context as never, {});
    await account.setCallback({ complete } as never, nonce);
    const outcome = await account.beginConnect(nonce, server("https://mcp.example/mcp"));
    expect(outcome.kind).toBe("redirect");
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    const oauthNonce = state.slice(state.indexOf(":") + 1);

    const resumed = new OAuthFlowAccount(context as never, {});
    expect(await resumed.acceptAuthCode("authorization-code", oauthNonce)).toEqual(HANDOFF);
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("access-token");
    expect(context.storage.kv.get("mcpSessionId")).toBe("session-for-access-token");
    expect(complete).toHaveBeenCalledOnce();
    expect(await resumed.acceptAuthCode("authorization-code", oauthNonce)).toBeNull();
  });

  it("stages a reconnect's tokens until the Workshop commits them", async () => {
    // The reconnect URL is a bearer capability, so the tokens it yields must not go live before the
    // Workshop has confirmed the finishing browser is the owner's: facets read the live key directly.
    const context = fakeContext();
    stubOAuthServer();
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    const complete = vi.fn(async () => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { complete, reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    context.storage.kv.put("mcpSessionId", "old-session");
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "7".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);
    expect(outcome.kind).toBe("redirect");
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    expect(await account.acceptAuthCode("code", state.slice(state.indexOf(":") + 1)))
      .toEqual(HANDOFF);

    expect(reconnectComplete).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("old-token");
    // The session the probe opened with the new tokens is staged with them: bound facets still
    // read the old tokens, and a session opened under other credentials is not theirs to use.
    expect(context.storage.kv.get("mcpSessionId")).toBe("old-session");
    expect(context.storage.kv.get("reconnectTokens")).toBeUndefined();
    // The Workshop was told which stage this completion produced, and only that id commits it.
    const stageId = reconnectComplete.mock.calls[0][0];
    expect(stageId).toMatch(/^[0-9a-f]{64}$/);
    await expect(account.commitReconnect("0".repeat(64))).rejects.toThrow(/No reconnect is awaiting/);
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("old-token");
    expect(context.storage.kv.get("stagedCredentials")).toBeDefined();

    await account.commitReconnect(stageId);
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("access-token");
    expect(context.storage.kv.get("mcpSessionId")).toBe("session-for-access-token");
    expect(context.storage.kv.get("stagedCredentials")).toBeUndefined();
    await expect(account.commitReconnect(stageId)).rejects.toThrow(/No reconnect is awaiting/);
  });

  it("discards and revokes a reconnect's parked tokens when the probe fails after the exchange", async () => {
    // The nonce is spent before the exchange, and no alarm sweeps a connected account, so without
    // this the grant the exchange parked would sit unused and unrevoked until the next reconnect.
    class ProbeFailsAccount extends OAuthFlowAccount {
      protected override async probe(
        server: ConnectedServer, accessToken: string | null,
      ): Promise<never> {
        if (accessToken) throw new Error("server rejected the new credentials");
        return await super.probe(server, accessToken);
      }
    }
    const context = fakeContext();
    const { revoked } = stubOAuthServer();
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    const account = new ProbeFailsAccount(context as never, {});
    const nonce = "7".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);
    expect(outcome.kind).toBe("redirect");
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    await expect(account.acceptAuthCode("code", state.slice(state.indexOf(":") + 1)))
      .rejects.toThrow("server rejected the new credentials");

    expect(reconnectComplete).not.toHaveBeenCalled();
    expect(context.storage.kv.get("reconnectTokens")).toBeUndefined();
    expect(context.storage.kv.get("reconnectOauthClient")).toBeUndefined();
    expect(context.storage.kv.get("reconnectOauthDiscovery")).toBeUndefined();
    expect(context.storage.kv.get("stagedCredentials")).toBeUndefined();
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("old-token");
    expect(revoked).toEqual([
      "token=access-token&token_type_hint=access_token&client_id=client-id",
      "token=refresh-token&token_type_hint=refresh_token&client_id=client-id",
    ]);
  });

  it("stages an overlapping reconnect even after an earlier one is committed", async () => {
    // Redeeming reconnect A must not change how reconnect B, already in flight, lands: B's URL may
    // be in a phished victim's hands, so B's grant has to stay in escrow until B's own ticket.
    const context = fakeContext();
    stubOAuthServer();
    let issued = 0;
    const upstream = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) !== "https://auth.example/token") return upstream(input, init);
      issued++;
      return Response.json({
        access_token: `token-${issued}`, refresh_token: `refresh-${issued}`,
        token_type: "Bearer", expires_in: 3600,
      });
    });
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    const complete = vi.fn(async () => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { complete, reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    const account = new OAuthFlowAccount(context as never, {});
    const liveToken = () =>
      context.storage.kv.get<{ access_token: string }>("tokens")?.access_token;
    const startReconnect = async (nonce: string) => {
      await account.prepareReconnect(nonce);
      const outcome = await account.beginConnect(nonce, null);
      expect(outcome.kind).toBe("redirect");
      const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
      return state.slice(state.indexOf(":") + 1);
    };

    const a = await startReconnect("1".repeat(64));
    expect(await account.acceptAuthCode("code-a", a)).toEqual(HANDOFF);
    const b = await startReconnect("2".repeat(64));
    await account.commitReconnect(reconnectComplete.mock.calls[0][0]);
    expect(liveToken()).toBe("token-1");

    expect(await account.acceptAuthCode("code-b", b)).toEqual(HANDOFF);
    expect(reconnectComplete).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(liveToken()).toBe("token-1");
    await account.commitReconnect(reconnectComplete.mock.calls[1][0]);
    expect(liveToken()).toBe("token-2");
  });

  it("re-authorizes a reconnect rather than refreshing the live tokens", async () => {
    // The live tokens are refreshable, so `auth()` would refresh them if it saw them — and against a
    // server that rotates refresh tokens that burns the live one before the handoff is redeemed.
    // A reconnect hides them from the SDK, so it redirects and the live record is untouched.
    const context = fakeContext();
    stubOAuthServer();
    const tokenRequests: string[] = [];
    const upstream = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "https://auth.example/token") {
        tokenRequests.push(String(init?.body));
      }
      return upstream(input, init);
    });
    const live = {
      access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer", expiresAt: 1,
    };
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", {
      complete: vi.fn(async () => HANDOFF), reconnectComplete: vi.fn(async () => HANDOFF),
    });
    context.storage.kv.put("tokens", live);
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "8".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);

    expect(outcome.kind).toBe("redirect");
    expect(tokenRequests.filter(body => body.includes("refresh_token"))).toEqual([]);
    expect(context.storage.kv.get("tokens")).toEqual(live);
    expect(context.storage.kv.get("stagedCredentials")).toBeUndefined();
  });

  it("keeps a reconnect's client, discovery and server record off the live keys until commit", async () => {
    // The tokens were already escrowed, but the SDK also writes the client registration and
    // discovery state as it goes, and the flow rewrote the server record mid-way. A reconnect URL in
    // the wrong hands could then change what the live account refreshes against, or its name.
    const context = fakeContext();
    stubOAuthServer();
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    const liveServer = { ...server("https://mcp.example/mcp"), serverName: "Old name" };
    // A registration with another issuer's stamp, so the flow has to register afresh; live discovery
    // is not copied at all (see `prepareReconnect`), so the flow rediscovers from the probe.
    const liveClient = { client_id: "old-client", issuer: "https://other.example" };
    const liveDiscovery = { authorizationServerUrl: "https://auth.example" };
    context.storage.kv.put("server", liveServer);
    context.storage.kv.put("callback", { complete: vi.fn(async () => HANDOFF), reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    context.storage.kv.put("oauthClient", liveClient);
    context.storage.kv.put("oauthDiscovery", liveDiscovery);
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "9".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);
    expect(outcome.kind).toBe("redirect");
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    expect(await account.acceptAuthCode("code", state.slice(state.indexOf(":") + 1)))
      .toEqual(HANDOFF);

    expect(reconnectComplete).toHaveBeenCalledOnce();
    expect(context.storage.kv.get("server")).toEqual(liveServer);
    expect(context.storage.kv.get("oauthClient")).toEqual(liveClient);
    expect(context.storage.kv.get("oauthDiscovery")).toEqual(liveDiscovery);
    expect(context.storage.kv.get("reconnectOauthClient")).toBeUndefined();
    expect(context.storage.kv.get("reconnectOauthDiscovery")).toBeUndefined();

    await account.commitReconnect(reconnectComplete.mock.calls[0][0]);
    expect(context.storage.kv.get("server")).toEqual({ ...liveServer, serverName: "Acme" });
    expect(context.storage.kv.get<{ client_id: string }>("oauthClient")?.client_id)
      .toBe("client-id");
    expect(context.storage.kv.get<{ authorizationServerMetadata?: unknown }>("oauthDiscovery")
      ?.authorizationServerMetadata).toBeDefined();
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("access-token");
  });

  it("rediscovers the authorization server on reconnect", async () => {
    // A reconnect is an explicit re-authorization. Seeded with the live discovery, the SDK takes its
    // `authorizationServerUrl` verbatim and skips discovery, so an endpoint that moved to another
    // authorization server would keep redirecting to the old one.
    const context = fakeContext();
    stubOAuthServer();
    const staleDiscovery = {
      authorizationServerUrl: "https://stale.example",
      authorizationServerMetadata: {
        issuer: "https://stale.example",
        authorization_endpoint: "https://stale.example/authorize",
        token_endpoint: "https://stale.example/token",
        response_types_supported: ["code"],
      },
    };
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", {
      complete: vi.fn(async () => HANDOFF), reconnectComplete: vi.fn(async () => HANDOFF),
    });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    context.storage.kv.put("oauthDiscovery", staleDiscovery);
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "d".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);
    expect(outcome.kind).toBe("redirect");
    expect((outcome as { url: string }).url).toMatch(/^https:\/\/auth\.example\/authorize\?/);
    expect(context.storage.kv.get<{ authorizationServerUrl: string }>("reconnectOauthDiscovery")
      ?.authorizationServerUrl).toBe("https://auth.example");
    expect(context.storage.kv.get("oauthDiscovery")).toEqual(staleDiscovery);
  });

  it("refuses to commit a reconnect staged before a repoint", async () => {
    // Reconnect A staged the old endpoint's record and tokens; a deployment then repointed the
    // account. Redeeming A's ticket must not put the old server, tokens and session back live under
    // the repoint's probe.
    const context = fakeContext();
    const oldServer = { ...server("https://old.example/mcp"), provenance: "deployment" as const };
    const newServer = { ...server("https://new.example/mcp"), provenance: "deployment" as const };
    context.storage.kv.put("server", oldServer);
    context.storage.kv.put("tokens", { access_token: "live-token", token_type: "Bearer", expiresAt: 1 });
    const stageIdA = stageCredentials(context.storage.kv, {
      tokens: { access_token: "staged-token", token_type: "Bearer", expiresAt: 1 },
      sessionId: "a",
      server: oldServer,
    }, Date.now());
    const account = new InterleavingAccount(context as never, {});
    const nonce = "e".repeat(64);
    await account.prepareReconnect(nonce);
    // The repoint runs before the probe's first await.
    const repoint = account.beginConnect(nonce, newServer);

    await expect(account.commitReconnect(stageIdA)).rejects.toThrow(/No reconnect is awaiting/);
    expect(context.storage.kv.get("server")).toEqual(newServer);
    expect(context.storage.kv.get("tokens")).toBeUndefined();
    expect(context.storage.kv.get("mcpSessionId")).toBeUndefined();

    account.failProbe();
    await expect(repoint).rejects.toThrow("stop test probe");
  });

  it("registers a reconnect's client only under the reconnect key", async () => {
    // With no live registration to copy, dynamic registration during the reconnect must still land
    // beside the parked tokens rather than on the key the live refresh path reads.
    const context = fakeContext();
    stubOAuthServer();
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", {
      complete: vi.fn(async () => HANDOFF), reconnectComplete: vi.fn(async () => HANDOFF),
    });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "a".repeat(64);
    await account.prepareReconnect(nonce);

    expect((await account.beginConnect(nonce, null)).kind).toBe("redirect");

    expect(context.storage.kv.get("oauthClient")).toBeUndefined();
    expect(context.storage.kv.get("oauthDiscovery")).toBeUndefined();
    expect(context.storage.kv.get<{ client_id: string }>("reconnectOauthClient")?.client_id)
      .toBe("client-id");
    expect(context.storage.kv.get("reconnectOauthDiscovery")).toBeDefined();
  });

  it("does not let a reconnect's refused code exchange invalidate the live client", async () => {
    // On `invalid_client` the SDK invalidates the client registration and retries. Pointed at the
    // live key, that would have deleted the registration the live tokens still refresh under.
    const context = fakeContext();
    stubOAuthServer();
    const upstream = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) !== "https://auth.example/token") return upstream(input, init);
      return Response.json({ error: "invalid_client" }, { status: 401 });
    });
    const liveClient = { client_id: "old-client", issuer: "https://auth.example" };
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", {
      complete: vi.fn(async () => HANDOFF), reconnectComplete: vi.fn(async () => HANDOFF),
    });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    context.storage.kv.put("oauthClient", liveClient);
    const account = new OAuthFlowAccount(context as never, {});
    const nonce = "b".repeat(64);
    await account.prepareReconnect(nonce);

    const outcome = await account.beginConnect(nonce, null);
    expect(outcome.kind).toBe("redirect");
    const state = new URL((outcome as { url: string }).url).searchParams.get("state")!;
    await expect(account.acceptAuthCode("code", state.slice(state.indexOf(":") + 1)))
      .rejects.toThrow();

    expect(context.storage.kv.get("oauthClient")).toEqual(liveClient);
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token)
      .toBe("old-token");
  });

  it("stages an observed auth-mode change rather than flipping the live record", async () => {
    // An OAuth account whose server now answers unauthenticated: the reconnect learns `"none"`, but
    // `getAuthorization()` reads the live mode to decide whether to send the live tokens, so the
    // flip must wait for the commit like everything else the reconnect learned.
    const context = fakeContext();
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { complete: vi.fn(async () => HANDOFF), reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    const account = new PublicServerAccount(context as never, {});
    const nonce = "d".repeat(64);
    await account.prepareReconnect(nonce);

    expect((await account.beginConnect(nonce, null)).kind).toBe("done");

    expect(reconnectComplete).toHaveBeenCalledOnce();
    expect(context.storage.kv.get<ConnectedServer>("server")?.auth).toBe("oauth");
    await account.commitReconnect(reconnectComplete.mock.calls[0][0]);
    expect(context.storage.kv.get<ConnectedServer>("server")?.auth).toBe("none");
    expect(context.storage.kv.get("mcpSessionId")).toBe("public-session");
  });

  it("revokes the retired OAuth grant when a reconnect observes a server that takes none", async () => {
    // The stage carries no tokens and no discovery, so the commit would otherwise leave the old
    // tokens live while dropping the discovery a later revoke() needs to reach them: a grant nobody
    // could ever revoke, disconnect included.
    const context = fakeContext();
    const { revoked } = stubOAuthServer();
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { reconnectComplete });
    context.storage.kv.put("tokens", {
      access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer", expiresAt: 1,
    });
    context.storage.kv.put("oauthClient", { client_id: "client-id" });
    context.storage.kv.put("oauthDiscovery", {
      authorizationServerMetadata: { revocation_endpoint: "https://auth.example/revoke" },
    });
    const account = new PublicServerAccount(context as never, {});
    const nonce = "e".repeat(64);
    await account.prepareReconnect(nonce);
    expect((await account.beginConnect(nonce, null)).kind).toBe("done");
    // Nothing is revoked until the Workshop confirms the reconnect: the old grant still serves.
    expect(revoked).toEqual([]);
    expect(context.storage.kv.get<{ access_token: string }>("tokens")?.access_token).toBe("old-token");

    await account.commitReconnect(reconnectComplete.mock.calls[0][0]);
    expect(context.storage.kv.get<ConnectedServer>("server")?.auth).toBe("none");
    expect(context.storage.kv.get("tokens")).toBeUndefined();
    expect(context.storage.kv.get("oauthDiscovery")).toBeUndefined();
    expect(revoked).toEqual([
      "token=old-token&token_type_hint=access_token&client_id=client-id",
      "token=old-refresh&token_type_hint=refresh_token&client_id=client-id",
    ]);
  });

  it("commits the retiring reconnect before the revocation round trip, not after it", async () => {
    // The revocation is a network call. A disconnect (or a newer reconnect) that finishes while it
    // is in flight must not be overwritten when the commit resumes, so every live write lands first.
    const context = fakeContext();
    stubOAuthServer();
    const base = globalThis.fetch;
    let releaseRevocation!: () => void;
    const revocationStarted = new Promise<void>(started => {
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (String(input) !== "https://auth.example/revoke") return await base(input, init);
        started();
        await new Promise<void>(release => { releaseRevocation = release; });
        return new Response(null, { status: 200 });
      });
    });
    const reconnectComplete = vi.fn(async (_stageId: string) => HANDOFF);
    context.storage.kv.put("server", server("https://mcp.example/mcp"));
    context.storage.kv.put("callback", { reconnectComplete });
    context.storage.kv.put("tokens", { access_token: "old-token", token_type: "Bearer", expiresAt: 1 });
    context.storage.kv.put("oauthClient", { client_id: "client-id" });
    context.storage.kv.put("oauthDiscovery", {
      authorizationServerMetadata: { revocation_endpoint: "https://auth.example/revoke" },
    });
    const account = new PublicServerAccount(context as never, {});
    const nonce = "e".repeat(64);
    await account.prepareReconnect(nonce);
    expect((await account.beginConnect(nonce, null)).kind).toBe("done");

    const commit = account.commitReconnect(reconnectComplete.mock.calls[0][0]);
    await revocationStarted;
    // Already live while the revocation is still pending.
    expect(context.storage.kv.get<ConnectedServer>("server")?.auth).toBe("none");
    expect(context.storage.kv.get("tokens")).toBeUndefined();

    // The user disconnects during the pause; the resumed commit must leave the account deleted.
    await account.revoke();
    expect(context.storage.kv.get("server")).toBeUndefined();
    releaseRevocation();
    await commit;
    expect(context.storage.kv.get("server")).toBeUndefined();
    expect(context.storage.kv.get("oauthClient")).toBeUndefined();
    expect(context.storage.kv.get("expiredNotified")).toBeUndefined();
  });
});

describe("resolveConnectTarget", () => {
  it("accepts the first endpoint offered", () => {
    expect(resolveConnectTarget(undefined, server("https://a.example/mcp")))
      .toEqual(server("https://a.example/mcp"));
  });

  it("refuses a reconnect that names a different endpoint", () => {
    // The hole this closes: a reconnect link accepts a POST, and the form field used to be honoured
    // even for an account that already had a server. Re-pointing left every existing binding holding
    // the old endpoint in its props while the account minted credentials for the new one -- so the
    // next tool call would send the new server's bearer token to the old server.
    expect(resolveConnectTarget(server("https://a.example/mcp"), server("https://evil.example/mcp")))
      .toBeNull();
  });

  it("adopts the caller's record when the endpoint is unchanged", () => {
    // Only the endpoint is pinned. A deployment's portal restates its name and auth kind from
    // current configuration on every connect, so preferring the stored copy meant a reconnect
    // could not pick up a renamed portal or a rotated preissued token: it would report success and
    // go on using exactly the configuration it was asked to replace.
    const stored: ConnectedServer = {
      ...server("https://a.example/mcp"), serverName: "Old name", auth: "token",
    };
    const configured: ConnectedServer = {
      ...server("https://a.example/mcp"), serverName: "New name", auth: "oauth",
    };
    expect(resolveConnectTarget(stored, configured)).toEqual(configured);
  });

  it("falls back to the stored record when the caller names no target", () => {
    // A user-supplied reconnect has nothing to restate, so the account keeps what it has.
    expect(resolveConnectTarget(server("https://a.example/mcp"), null))
      .toEqual(server("https://a.example/mcp"));
  });

  it("has nothing to connect to when neither side names an endpoint", () => {
    expect(resolveConnectTarget(undefined, null)).toBeNull();
  });
});

describe("resolveConnectTarget and a repointed deployment", () => {
  const deployment = (endpoint: string): ConnectedServer => ({
    ...server(endpoint), provenance: "deployment", serverId: "portal", serverName: "Portal",
  });

  it("lets a deployment repoint its own gateway", () => {
    // Every binding on the old endpoint tells the user to reconnect, so reconnecting has to be able
    // to adopt the new one. Refusing left the repoint unrecoverable except by deleting the account.
    // Safe because the target comes from this Worker's configuration rather than from user input,
    // and because bindings minted against the old endpoint already fail closed.
    const moved = deployment("https://new.example/mcp");
    expect(resolveConnectTarget(deployment("https://old.example/mcp"), moved)).toEqual(moved);
  });

  it("still refuses a user-supplied reconnect that names a different endpoint", () => {
    // Unchanged, and the reason is different: this target is whatever was typed into the form.
    expect(resolveConnectTarget(
      server("https://a.example/mcp"), server("https://evil.example/mcp"))).toBeNull();
  });

  it("refuses a user-supplied target trying to move a deployment's account", () => {
    // Provenance is the discriminator, so it has to be the incoming target's, not the stored one's.
    expect(resolveConnectTarget(
      deployment("https://old.example/mcp"), server("https://evil.example/mcp"))).toBeNull();
  });
});
