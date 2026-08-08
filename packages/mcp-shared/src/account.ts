// The Durable Object that owns one connection to one MCP endpoint, and every credential for it. The
// only place an access token is stored, refreshed, or handed out.
//
// The connect handshake:
//
//   1. `setCallback` records how to reach the Workshop, and arms an alarm so an abandoned attempt
//      deletes itself rather than lingering as a half-built account.
//   2. `beginConnect` probes the endpoint unauthenticated. Success means a public server; a 401 both
//      tells us it needs OAuth and says where its authorization server is.
//   3. `#beginOAuth` discovers and registers (once per endpoint, reused thereafter), then redirects.
//   4. `acceptAuthCode` exchanges the code and completes.
//
// Every nonce is single-use, time-bounded, and compared in constant time; see `connect-nonce.ts`.

import { DurableObject } from "cloudflare:workers";
import type { GatekeeperConnectCallback, GatekeeperUser }
  from "@gadgets/workshop-shared/gatekeeper";
import {
  auth,
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";

import { McpAuthRequiredError, McpClient, type McpServerInfo } from "./client.js";
import { clientName, type ConnectionEnv, type McpConnection } from "./connection.js";
import {
  ACCESS_TOKEN_SAFETY_MS,
  CONNECT_TIMEOUT_MS,
  DEFAULT_TOKEN_LIFETIME_S,
  constantTimeEqual,
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  OAUTH_NONCE_LIFETIME_MS,
} from "./connect-nonce.js";
import {
  isCredentialRejection,
  revokeToken,
  safeOAuthError,
  type OAuthTokens,
} from "./oauth.js";
import { fetchOptions, isAllowedUrl, sdkFetch, type FetchOptions } from "./fetch.js";
import type { McpLog } from "./log.js";
import { sameEndpoint } from "./scope.js";
import { hostOf } from "./util.js";

// How a connected endpoint proves who we are. Discovered for a user-supplied endpoint (the probe in
// `beginConnect` answers `none` or `oauth`); configured for a deployment's gateway, which may
// additionally hold a preissued `token`.
export type ServerAuthKind = "none" | "oauth" | "token";

// The endpoint this account is connected to, once chosen.
export type ConnectedServer = {
  endpoint: string;
  // A slug naming this server, for the suggested binding name and the generated session type.
  // Naming only, and not unique: two hosts can yield the same slug, which is why action-kind tags
  // are built from the whole endpoint instead, via `endpointTag`.
  serverId: string;
  // The server's own reported name once known, else the endpoint host.
  serverName: string;
  // Who chose this endpoint. Settled at connect time and true forever after, unlike `ServerTrust`,
  // which is current deployment configuration and must not be frozen onto an account.
  provenance: "user" | "deployment";
  // How to authenticate to it.
  auth: ServerAuthKind;
};

// Which server record a `beginConnect` should proceed with, or null to refuse the attempt.
//
// The endpoint is immutable after the first connect: a reconnect re-authorizes the server this
// account already holds credentials for and cannot name a different one. A gatekeeper facet carries
// the endpoint frozen in its props while `getAuthorization()` answers for whatever the account
// currently points at, so moving the account would send a token minted for the new server to the
// old one.
//
// Only the endpoint is pinned, though. Everything else on the record is the caller's to restate: a
// deployment's portal supplies its name and auth kind from current configuration, so preferring the
// stored copy meant a reconnect could not adopt a renamed portal, a rotated preissued token, or a
// switch between `token` and `oauth` -- the reconnect would appear to succeed and keep using the
// configuration it was meant to replace. A user-supplied reconnect passes no target and still falls
// back to what is stored.
//
// The one endpoint change that is allowed is a deployment repointing its own gateway. That target
// comes from this Worker's configuration rather than from anything a user typed, and bindings minted
// against the old endpoint already fail closed, since each connector checks its props against
// current configuration before handing out a capability. Refusing it outright left the repoint
// unrecoverable: every existing binding told the user to reconnect and reconnecting was the one
// thing the account would not do. Credentials do not survive the move -- see `beginConnect`.
export function resolveConnectTarget(
  existing: ConnectedServer | undefined, target: ConnectedServer | null,
): ConnectedServer | null {
  if (existing && target && target.endpoint !== existing.endpoint
      && target.provenance !== "deployment") {
    return null;
  }
  return target ?? existing ?? null;
}

// What `beginConnect` tells the HTTP handler to do next.
export type ConnectOutcome =
  | { kind: "done" }
  | { kind: "redirect"; url: string }
  | { kind: "invalid" };

// A single-use secret in the connect flow, and the stage it belongs to.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "connecting" | "oauth";
};

// OAuth state held between the redirect out and the callback back.
type PendingAuthorization = {
  // Connection generation that started this authorization. The callback crosses an arbitrary time
  // gap and must not install tokens after a newer reconnect has replaced the attempt.
  generation: number;
};

// The environment an account reads. Each Worker's own `Env` satisfies it structurally.
export type AccountEnv = ConnectionEnv & {
  // Public base URL of this gatekeeper Worker, used to build the OAuth redirect URI.
  BASE_URL?: string;
};

// Longest server-supplied name kept. It appears in every approval prompt, so it is capped,
// single-line, and stripped of the markdown that would let it forge structure there.
const MAX_SERVER_NAME = 60;

function displayName(reported: string | undefined): string | undefined {
  if (!reported) return undefined;
  const cleaned = reported.replace(/[\r\n]+/g, " ").replace(/[`*_[\]()#>|]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_SERVER_NAME ? `${cleaned.slice(0, MAX_SERVER_NAME)}\u2026` : cleaned;
}

// Base for a connector's account Durable Object. Subclasses supply where this Worker lives
// (`baseUrl`), how to hand the finished account back to the Workshop (`mintAccount`), and, only for
// a deployment-configured endpoint, a preissued bearer token (`staticToken`).
export abstract class McpAccountBase<E extends AccountEnv, P = unknown>
  extends DurableObject<E, P> {


  // This Worker's public base URL, with no trailing slash. The OAuth redirect is `${it}/oauth`.
  protected abstract baseUrl(): string;

  // Logger for connect-flow events, already carrying the connector's component field.
  protected abstract log(): McpLog;

  // Mints the account capability handed to the Workshop on a successful connect. Per-connector
  // because a Durable Object can only reach its own Worker's exports.
  protected abstract mintAccount(): Fetcher<GatekeeperUser>;

  // A bearer token this deployment was configured with, for an endpoint whose `auth` is `"token"`.
  // Null when there is none, which for such an endpoint is reported as a misconfiguration. Never
  // called for `"none"` or `"oauth"`.
  //
  // `server` is supplied because this is the one credential read from *live deployment
  // configuration* rather than from this account's storage. Everything else handed out here was
  // minted for the endpoint the account stores, so it is safe to send there by construction; a
  // configured token is not. An administrator repointing the gateway changes the URL and its token
  // together and touches no account, so between that edit and the user's reconnect the account
  // still names the old endpoint while this method would answer with the new deployment's secret.
  // Implementations must therefore return null unless current configuration still names `server`.
  protected staticToken(_server: ConnectedServer): string | null {
    return null;
  }

  // Relaxes host and scheme checks for local development against an MCP server on localhost.
  protected fetchOptions(): FetchOptions {
    return fetchOptions(this.env);
  }


  protected server(): ConnectedServer | undefined {
    return this.ctx.storage.kv.get<ConnectedServer>("server");
  }

  // Generation zero covers accounts created before this field existed. Advancing is synchronous,
  // so every request already suspended at an await retains an older number and cannot later write
  // credentials, expiry state, or an MCP transport session into the new connection.
  private connectionGeneration(): number {
    return this.ctx.storage.kv.get<number>("connectionGeneration") ?? 0;
  }

  private advanceConnectionGeneration(): number {
    const generation = this.connectionGeneration() + 1;
    this.ctx.storage.kv.put("connectionGeneration", generation);
    return generation;
  }

  private isCurrentConnection(server: ConnectedServer, generation: number): boolean {
    const current = this.server();
    return this.connectionGeneration() === generation && current !== undefined &&
      sameEndpoint(current.endpoint, server.endpoint);
  }

  protected requireServer(): ConnectedServer {
    const server = this.server();
    if (!server) throw new Error("This MCP account is not connected to a server yet.");
    return server;
  }

  // True once a server has been chosen, so a reconnect can skip the picker. A connector that needs
  // this over RPC re-exposes it.
  protected hasConnectedServer(): boolean {
    return this.server() !== undefined;
  }

  // The connected endpoint and its name, for gatekeeper facets and the configurator.
  async getServer(): Promise<ConnectedServer> {
    return this.requireServer();
  }


  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
  ): Promise<void> {
    // Only arm the abandonment alarm for a first connect; a reconnect already has a server to keep.
    if (!this.hasConnectedServer()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // True when this account is waiting to be connected with this nonce. Exposed by the connector so
  // its connect handler can reject a stale link before rendering the endpoint form.
  protected awaitingSelection(initiationNonce: string): boolean {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return stored !== undefined && stored.stage === "initiation" &&
      Date.now() < stored.expiresAt && constantTimeEqual(stored.value, initiationNonce);
  }

  // Claims an initiation nonce synchronously, before connecting reaches its first await. Durable
  // Object requests can interleave at an await, so merely validating here would let two completion
  // requests both pass and independently probe, start OAuth, or hand an account to the Workshop.
  // The intermediate stage preserves the value and expiry for diagnosis without leaving it usable.
  protected claimSelection(initiationNonce: string): boolean {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || !this.awaitingSelection(initiationNonce)) return false;
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, stage: "connecting" });
    return true;
  }

  // Releases a failed connection attempt without reopening a nonce that another request replaced or
  // advanced to OAuth while this request was suspended. Synchronous storage makes the check and put
  // one non-interleavable step inside this Durable Object activation.
  private restoreSelection(initiationNonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "connecting" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return;
    }
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, stage: "initiation" });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.advanceConnectionGeneration();
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Connects to `target`, or to the already-chosen server on reconnect.
  //
  // Probes unauthenticated first, since a 401 is how a server tells us both that it needs OAuth and
  // where its authorization server is.
  async beginConnect(
    initiationNonce: string, target: ConnectedServer | null,
  ): Promise<ConnectOutcome> {
    const existing = this.server();
    const server = resolveConnectTarget(existing, target);
    if (!server || !this.claimSelection(initiationNonce)) return { kind: "invalid" };

    // Every claimed attempt advances the generation before its first await, invalidating old probe,
    // OAuth callback, refresh, and session writes. A repoint additionally persists the new endpoint
    // *now*, not after its probe:
    // static tokens come from current deployment configuration, so leaving the old server record in
    // place during that await would let a stale old-endpoint facet pass `getConnection()` and receive
    // the new portal's token.
    const generation = this.advanceConnectionGeneration();
    if (existing) this.ctx.storage.kv.delete("mcpSessionId");
    if (existing && existing.endpoint !== server.endpoint) {
      this.ctx.storage.kv.put("server", server);
      for (const key of [
        "tokens", "oauthClient", "oauthDiscovery", "oauthVerifier", "pendingAuth",
      ]) {
        this.ctx.storage.kv.delete(key);
      }
      this.ctx.storage.kv.put("expiredNotified", false);
      this.log().info("portal repointed", {
        event: "connect.repointed",
        serverHost: hostOf(server.endpoint),
      });
    }

    const log = this.log().with({
      serverId: server.serverId,
      serverHost: hostOf(server.endpoint),
      provenance: server.provenance,
    });

    // A `"token"` endpoint with nothing configured cannot be connected, and the probe would not
    // reveal that: it runs with whatever `staticToken` returns, so a server whose `initialize` is
    // public answers happily while every real call needs a bearer this deployment does not have.
    // Connecting anyway records an account that looks fine in the Workshop and fails on first use,
    // with the misconfiguration surfacing far from the setting that caused it. Refused here, and
    // the form stays open so an administrator can supply the token and retry.
    if (server.auth === "token" && this.staticToken(server) === null) {
      this.restoreSelection(initiationNonce);
      throw new Error(
        `No preissued token is configured for "${server.serverName}" on this deployment, so it ` +
        `cannot be connected. Set one and try again.`);
    }

    // A first-connect server record is written only once the endpoint has answered, below. Storing
    // user input up front left a typo or dead host as the account's permanent choice. A deployment
    // repoint is the exception above: it must fail closed against old facets before probing.
    try {
      const info = await this.probe(server, null, generation);
      if (generation !== this.connectionGeneration()) {
        throw new Error("This connection attempt was replaced by a newer one.");
      }
      // A `"token"` endpoint is probed *with* its preissued bearer (see `probe`), so completing the
      // handshake says nothing about whether it is public; recording `"none"` here would drop that
      // token from every later request. Only an endpoint that answered with no credential at all is.
      const connected: ConnectedServer =
        server.auth === "token" ? server : { ...server, auth: "none" };
      this.ctx.storage.kv.put("server", connected);
      await this.complete(connected, info, generation);
      log.info("connected without authorization", { event: "connect.completed" });
      return { kind: "done" };
    } catch (err) {
      if (!(err instanceof McpAuthRequiredError)) {
        this.restoreSelection(initiationNonce);
        throw err;
      }
      if (server.auth === "token") {
        // A preissued token that is refused is a misconfiguration; there is no interactive flow to
        // fall back to. Keep the form retryable so an administrator can rotate the configured token
        // without forcing the user to start a new connect flow.
        this.restoreSelection(initiationNonce);
        throw new Error(
          `The MCP server "${server.serverName}" rejected this deployment's configured token.`,
          { cause: err });
      }
      // The endpoint answered with an authorization challenge, so OAuth is now the observed auth
      // mode even if deployment configuration optimistically called the portal public. Persist that
      // mode because `getAuthorization()` uses it to decide whether to read the tokens the callback
      // stores.
      const oauthServer: ConnectedServer = { ...server, auth: "oauth" };
      this.ctx.storage.kv.put("server", oauthServer);
      try {
        return await this.beginOAuth(oauthServer, err.resourceMetadataUrl, generation);
      } catch (oauthErr) {
        this.restoreSelection(initiationNonce);
        throw oauthErr;
      }
    }
  }

  // Opens a client and performs `initialize`, caching the transport session id it returns.
  protected async probe(
    server: ConnectedServer, accessToken: string | null, generation: number,
  ): Promise<McpServerInfo> {
    const token = accessToken ?? (server.auth === "token" ? this.staticToken(server) : null);
    const client = new McpClient(server.endpoint, async () => token, null, this.fetchOptions());
    const info = await client.initialize(clientName(this.env));
    // A newer attempt may have started while initialize was in flight. Its session belongs to that
    // attempt, not this response, so only the captured generation may populate the cache.
    if (client.sessionId && generation === this.connectionGeneration()) {
      this.ctx.storage.kv.put("mcpSessionId", client.sessionId);
    }
    return info;
  }

  private oauthProvider(
    server: ConnectedServer,
    generation: number,
    redirect: (url: URL) => void = () => {
      throw new Error("The authorization server unexpectedly requested a redirect.");
    },
  ): OAuthClientProvider {
    const current = () => {
      if (!this.isCurrentConnection(server, generation)) {
        throw new Error("This authorization attempt was replaced by a newer connection.");
      }
    };
    const matchesIssuer = (value: { issuer?: string } | undefined, issuer?: string) =>
      value !== undefined && (!issuer || !value.issuer || value.issuer === issuer);

    return {
      redirectUrl: `${this.baseUrl()}/oauth`,
      clientMetadata: {
        client_name: clientName(this.env),
        redirect_uris: [`${this.baseUrl()}/oauth`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: context => {
        current();
        const client = this.ctx.storage.kv.get<StoredOAuthClientInformation>("oauthClient");
        if (client && typeof client.client_id !== "string") {
          this.ctx.storage.kv.delete("oauthClient");
          return undefined;
        }
        return matchesIssuer(client, context?.issuer) ? client : undefined;
      },
      saveClientInformation: (client, context) => {
        current();
        this.ctx.storage.kv.put("oauthClient", { ...client, issuer: context?.issuer });
      },
      tokens: context => {
        current();
        const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
        if (tokens && (typeof tokens.access_token !== "string" ||
            typeof tokens.token_type !== "string")) {
          this.ctx.storage.kv.delete("tokens");
          return undefined;
        }
        return matchesIssuer(tokens, context?.issuer) ? tokens : undefined;
      },
      saveTokens: (tokens, context) => {
        current();
        this.ctx.storage.kv.put<OAuthTokens>("tokens", {
          ...tokens,
          issuer: context?.issuer,
          // An absent `expires_in` is optional per RFC 6749 and means unknown, not eternal. Left
          // undefined the token is never refreshed, and a refresh token sitting right here goes
          // unused while every call fails on the server's own 401.
          expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
        });
        this.ctx.storage.kv.put("expiredNotified", false);
      },
      redirectToAuthorization: url => {
        current();
        redirect(url);
      },
      saveCodeVerifier: verifier => {
        current();
        this.ctx.storage.kv.put("oauthVerifier", verifier);
      },
      codeVerifier: () => {
        current();
        const verifier = this.ctx.storage.kv.get<string>("oauthVerifier");
        if (!verifier) throw new Error("This authorization attempt has expired. Please try again.");
        return verifier;
      },
      state: () => {
        current();
        const oauthNonce = generateNonce();
        this.ctx.storage.kv.put<StoredNonce>("nonce", {
          value: oauthNonce,
          expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
          stage: "oauth",
        });
        this.ctx.storage.kv.put<PendingAuthorization>("pendingAuth", { generation });
        return `${this.ctx.id.toString()}:${oauthNonce}`;
      },
      discoveryState: () => {
        current();
        const state = this.ctx.storage.kv.get<OAuthDiscoveryState>("oauthDiscovery");
        if (state && typeof state.authorizationServerUrl !== "string") {
          this.ctx.storage.kv.delete("oauthDiscovery");
          return undefined;
        }
        return state;
      },
      saveDiscoveryState: state => {
        current();
        this.ctx.storage.kv.put("oauthDiscovery", state);
      },
      invalidateCredentials: scope => {
        current();
        if (scope === "all" || scope === "tokens") this.ctx.storage.kv.delete("tokens");
        if (scope === "all" || scope === "client") this.ctx.storage.kv.delete("oauthClient");
        if (scope === "all" || scope === "verifier") this.ctx.storage.kv.delete("oauthVerifier");
        if (scope === "all" || scope === "discovery") {
          this.ctx.storage.kv.delete("oauthDiscovery");
        }
      },
    };
  }

  private async beginOAuth(
    server: ConnectedServer, resourceMetadataUrl: string | null, generation: number,
  ): Promise<ConnectOutcome> {
    const selection = this.ctx.storage.kv.get<StoredNonce>("nonce");
    let redirectUrl: URL | undefined;
    try {
      let result: Awaited<ReturnType<typeof auth>>;
      try {
        result = await auth(this.oauthProvider(server, generation, url => { redirectUrl = url; }), {
          serverUrl: server.endpoint,
          resourceMetadataUrl: resourceMetadataUrl ? new URL(resourceMetadataUrl) : undefined,
          fetchFn: sdkFetch(this.fetchOptions()),
        });
      } catch (err) {
        const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
        throw safeOAuthError(err, [
          this.ctx.storage.kv.get<string>("oauthVerifier"),
          tokens?.access_token,
          tokens?.refresh_token,
        ],
          this.ctx.storage.kv.get<StoredOAuthClientInformation>("oauthClient"));
      }
      if (!this.isCurrentConnection(server, generation)) {
        throw new Error("This authorization attempt was replaced by a newer connection.");
      }
      if (result === "REDIRECT" && redirectUrl) {
        if (!isAllowedUrl(redirectUrl.toString(), this.fetchOptions())) {
          throw new Error("The authorization server returned an unsafe authorization URL.");
        }
        return { kind: "redirect", url: redirectUrl.toString() };
      }
      if (result === "AUTHORIZED") {
        const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
        if (!tokens) throw new Error("The authorization server returned no access token.");
        const info = await this.probe(server, tokens.access_token, generation);
        await this.complete(server, info, generation);
        return { kind: "done" };
      }
      throw new Error("The authorization server returned no redirect.");
    } catch (err) {
      const nonce = this.ctx.storage.kv.get<StoredNonce>("nonce");
      const pending = this.ctx.storage.kv.get<PendingAuthorization>("pendingAuth");
      const ownsAttempt = selection?.stage === "connecting" && nonce !== undefined &&
        ((nonce.stage === "connecting" && constantTimeEqual(nonce.value, selection.value)) ||
          (nonce.stage === "oauth" && pending?.generation === generation));
      if (ownsAttempt && this.isCurrentConnection(server, generation)) {
        this.ctx.storage.kv.put<StoredNonce>("nonce", { ...selection, stage: "initiation" });
        this.ctx.storage.kv.delete("pendingAuth");
        this.ctx.storage.kv.delete("oauthVerifier");
      }
      throw err;
    }
  }

  // Completes the OAuth code exchange. Returns false when the callback's nonce doesn't match.
  async acceptAuthCode(code: string, oauthNonce: string, issuer?: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    const pending = this.ctx.storage.kv.get<PendingAuthorization>("pendingAuth");
    if (!pending) return false;
    // Single-use: consumed before the exchange, so a replayed callback cannot reach the token endpoint.
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("pendingAuth");

    const server = this.requireServer();
    if (!this.isCurrentConnection(server, pending.generation)) return false;
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(this.oauthProvider(server, pending.generation), {
        serverUrl: server.endpoint,
        authorizationCode: code,
        iss: issuer,
        fetchFn: sdkFetch(this.fetchOptions()),
      });
    } catch (err) {
      const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
      throw safeOAuthError(err, [
        code,
        this.ctx.storage.kv.get<string>("oauthVerifier"),
        tokens?.access_token,
        tokens?.refresh_token,
      ],
        this.ctx.storage.kv.get<StoredOAuthClientInformation>("oauthClient"));
    }
    if (result !== "AUTHORIZED") throw new Error("The authorization server requested another redirect.");
    if (!this.isCurrentConnection(server, pending.generation)) return false;
    const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
    if (!tokens) throw new Error("The authorization server returned no access token.");
    this.ctx.storage.kv.delete("oauthVerifier");

    const info = await this.probe(server, tokens.access_token, pending.generation);
    if (!this.isCurrentConnection(server, pending.generation)) return false;
    await this.complete(server, info, pending.generation);
    return true;
  }

  // Hands the freshly-minted account back to the Workshop (or, on reconnect, just says so).
  private async complete(
    server: ConnectedServer, info: McpServerInfo, generation: number,
  ): Promise<void> {
    if (!this.isCurrentConnection(server, generation)) {
      throw new Error("This connection attempt was replaced by a newer one.");
    }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete the connection. Please try again.");

    // Prefer the server's own name over the host once we have spoken to it, but only for an endpoint
    // the user chose. A deployment-configured endpoint has an administrator's name on it, and letting
    // the far side rename itself in every approval prompt would undo that choice.
    const reported = displayName(info.serverInfo?.title ?? info.serverInfo?.name);
    if (reported && server.provenance === "user") {
      this.ctx.storage.kv.put<ConnectedServer>("server", { ...server, serverName: reported });
    }

    // The initiation nonce authorized exactly one connect, which has now happened. Left in place, a
    // replayed connect URL could mint a second account against the same callback.
    this.ctx.storage.kv.delete("nonce");

    // Recorded before the callback rather than after it. The alarm below deletes any account that
    // never got this far, and handing the account over is the point of no return: if the callback
    // throws after the Workshop has taken it, deleting this side an hour later would strand a
    // connection the user can see and cannot use.
    this.ctx.storage.kv.put("connected", true);

    if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
      this.ctx.storage.kv.delete("reconnecting");
      const expiresAt = this.ctx.storage.kv.get<OAuthTokens>("tokens")?.expiresAt;
      await callback.credentialsRestored(expiresAt ? new Date(expiresAt) : undefined);
    } else {
      await callback.complete(this.mintAccount());
    }
    await this.ctx.storage.deleteAlarm();
  }


  // Everything one operation against the endpoint needs, in a single round trip. Every MCP request
  // needs both the credentials and the cached transport session, and reading them separately costs
  // two serialized RPCs to this Durable Object on the hot path.
  async getConnection(endpoint: string): Promise<McpConnection> {
    const server = this.requireServer();
    const generation = this.connectionGeneration();
    // Facets are durable and can outlive a deployment repoint. The facet supplies the endpoint it
    // is about to contact; reject before reading or refreshing credentials if the account has since
    // moved. Otherwise a bearer token minted for the new portal would be sent to the old endpoint.
    if (!sameEndpoint(endpoint, server.endpoint)) {
      throw new Error(
        `This binding is for ${hostOf(endpoint)}, but the account is now connected to ` +
        `${hostOf(server.endpoint)}. Replace the binding before using it again.`);
    }
    const authorization = await this.#getAuthorization(server, generation);
    // `#getAuthorization` may await a token refresh. A reconnect can interleave there, so recheck
    // before returning the credential to a caller that still intends to contact the old endpoint.
    if (!this.isCurrentConnection(server, generation)) {
      throw new Error("This MCP connection changed while credentials were being prepared. Try again.");
    }
    return {
      authorization,
      sessionId: this.ctx.storage.kv.get<string>("mcpSessionId") ?? null,
      generation,
    };
  }

  // Returns the bearer token for one captured connection generation, refreshing it when close to
  // expiry, or null for a public server. Every path that awaits rechecks the generation before it
  // can return or mutate state.
  async #getAuthorization(server: ConnectedServer, generation: number): Promise<string | null> {
    if (server.auth === "none") return null;
    if (server.auth === "token") {
      // Null covers both "never configured" and "configured for some other endpoint now". The
      // second is a repoint the account has not caught up with, and the only safe answer is to
      // withhold the token rather than send this deployment's current secret to the host this
      // account happens to still point at.
      const token = this.staticToken(server);
      if (!token) {
        throw new Error(
          `This deployment has no preissued token for "${server.serverName}" at ` +
          `${hostOf(server.endpoint)}. If the portal was repointed, reconnect the account.`);
      }
      return token;
    }

    const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
    if (!tokens || typeof tokens.access_token !== "string" ||
        typeof tokens.token_type !== "string") {
      await this.noteCredentialsExpired(server.endpoint, generation);
      throw new Error("This MCP connection is not authorized. Please reconnect the account.");
    }
    // An absent expiry is a token stored before one was always recorded: refresh it rather than
    // trusting it forever.
    if (Date.now() < (tokens.expiresAt ?? 0) - ACCESS_TOKEN_SAFETY_MS) {
      return tokens.access_token;
    }
    if (!tokens.refresh_token) {
      await this.noteCredentialsExpired(server.endpoint, generation);
      throw new Error("This MCP connection has expired. Please reconnect the account.");
    }

    const discovery = this.ctx.storage.kv.get<OAuthDiscoveryState>("oauthDiscovery");
    const client = this.ctx.storage.kv.get<StoredOAuthClientInformation>("oauthClient");
    if (!discovery || !client) {
      await this.noteCredentialsExpired(server.endpoint, generation);
      throw new Error("This MCP connection has expired. Please reconnect the account.");
    }

    return this.#refresh(server, generation, tokens.refresh_token, discovery, client);
  }

  // The refresh currently in flight, if any. Tagged so a reconnect never reuses a promise that was
  // redeeming the prior generation's token. The old promise may still settle, but its generation
  // checks prevent every state write.
  #refreshing: { generation: number; promise: Promise<string> } | undefined;

  // Redeems the refresh token, at most once at a time.
  //
  // Every in-flight MCP call reaches `getAuthorization` independently, so at expiry they all observe
  // the same stale token and would each redeem the refresh token. Against a server that rotates
  // refresh tokens the first redemption invalidates the rest, so a busy but perfectly healthy
  // account reports itself expired and demands a reconnect. Sharing the promise also spares the
  // token endpoint one request per concurrent call.
  #refresh(
    server: ConnectedServer, generation: number, refreshToken: string,
    discovery: OAuthDiscoveryState, client: StoredOAuthClientInformation,
  ): Promise<string> {
    if (this.#refreshing?.generation === generation) return this.#refreshing.promise;
    const promise = this.#performRefresh(server, generation, refreshToken, discovery, client)
      .finally(() => {
        // An older refresh can finish after a newer generation started one. Do not let its cleanup
        // erase the newer promise and defeat refresh deduplication.
        if (this.#refreshing?.promise === promise) this.#refreshing = undefined;
      });
    this.#refreshing = { generation, promise };
    return promise;
  }

  async #performRefresh(
    server: ConnectedServer, generation: number, refreshToken: string,
    discovery: OAuthDiscoveryState, client: StoredOAuthClientInformation,
  ): Promise<string> {
    try {
      const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: client,
        refreshToken,
        resource: new URL(server.endpoint),
        fetchFn: sdkFetch(this.fetchOptions()),
      });
      if (!this.isCurrentConnection(server, generation)) {
        throw new Error("Discarded credentials refreshed for a previous MCP connection.");
      }
      // Servers may or may not rotate the refresh token; keep the old one when they don't.
      this.ctx.storage.kv.put<OAuthTokens>("tokens", {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? refreshToken,
        issuer: client.issuer,
        expiresAt: Date.now() + (refreshed.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
      });
      return refreshed.access_token;
    } catch (err) {
      const safeError = safeOAuthError(err, [refreshToken], client);
      // A rejection from an old refresh says nothing about the new connection. Check before either
      // wrapping it as a transient current failure or notifying the Workshop that credentials died.
      if (!this.isCurrentConnection(server, generation)) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- OAuth errors may contain credentials.
        throw new Error("Ignored a token refresh from a previous MCP connection.", { cause: safeError });
      }
      // Only a verdict on the credential latches the account as expired. Marking it on any failure
      // meant one 5xx or dropped connection at the token endpoint demanded a reconnect for an
      // account whose refresh token was still perfectly good, and `noteCredentialsExpired` fires at
      // most once per expiry, so the wrong call could not be taken back by a later success.
      if (!isCredentialRejection(err)) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- OAuth errors may contain credentials.
        throw new Error(
          "This MCP connection could not be refreshed just now. Please try again.",
          { cause: safeError });
      }
      await this.noteCredentialsExpired(server.endpoint, generation);
      // oxlint-disable-next-line eslint/preserve-caught-error -- OAuth errors may contain credentials.
      throw new Error(
        "This MCP connection could not be refreshed. Please reconnect the account.",
        { cause: safeError });
    }
  }

  // Records the transport session id, so repeat calls skip the `initialize` handshake. An MCP call
  // can finish after reconnecting; endpoint plus generation keep its old session out of new state.
  async setMcpSessionId(
    endpoint: string, generation: number, sessionId: string | null,
  ): Promise<void> {
    const server = this.server();
    if (!server || !sameEndpoint(endpoint, server.endpoint)
        || generation !== this.connectionGeneration()) return;
    if (sessionId) this.ctx.storage.kv.put("mcpSessionId", sessionId);
    else this.ctx.storage.kv.delete("mcpSessionId");
  }

  // Tells the Workshop the credentials need attention, at most once per expiry. A rejection can
  // arrive after reconnecting, where it belongs to the old generation and must not poison the new.
  async noteCredentialsExpired(endpoint: string, generation: number): Promise<void> {
    const server = this.server();
    if (!server || !sameEndpoint(endpoint, server.endpoint)
        || generation !== this.connectionGeneration()) return;
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;

    // Claimed before the call so concurrent callers -- every in-flight request observes the same
    // dead credential -- do not each notify. Released again if the call fails, because the latch is
    // meant to suppress duplicates, not to be spent by a dropped connection: left set on failure it
    // would silence every future expiry for this account, and the user would never be asked to
    // reconnect. Notifying twice is recoverable; never notifying is not.
    //
    // Best-effort: every caller awaits this before throwing its own "please reconnect", so a broken
    // stored callback must not replace that message with an RPC error.
    this.ctx.storage.kv.put("expiredNotified", true);
    try {
      await callback.credentialsExpired();
    } catch (err) {
      this.ctx.storage.kv.put("expiredNotified", false);
      this.log().warn("failed to notify credential expiry",
        { event: "credentials.expiry.notify.failed", error: err });
    }
  }


  async alarm(): Promise<void> {
    // Armed only for a first connect, so reaching here means one never finished. The test is whether
    // the account was ever handed to the Workshop, not whether an endpoint was recorded: a connect
    // that chose an endpoint and then failed -- a rejected authorization, a server that stopped
    // answering -- used to leave a permanent account holding no usable credentials, which the user
    // never saw and so could never remove.
    if (!this.ctx.storage.kv.get<boolean>("connected")) await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    const tokens = this.ctx.storage.kv.get<OAuthTokens>("tokens");
    const discovery = this.ctx.storage.kv.get<OAuthDiscoveryState>("oauthDiscovery");
    const client = this.ctx.storage.kv.get<StoredOAuthClientInformation>("oauthClient");
    if (tokens && discovery && client) {
      // Best effort: a server that does not implement RFC 7009 must not block the disconnect.
      try {
        const fetchFn = sdkFetch(this.fetchOptions());
        await revokeToken(discovery, client, tokens.access_token, "access_token", fetchFn);
        if (tokens.refresh_token) {
          await revokeToken(discovery, client, tokens.refresh_token, "refresh_token", fetchFn);
        }
      } catch (err) {
        this.log().warn("failed to revoke MCP tokens",
          { event: "oauth.token.revoke.failed", error: err });
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
