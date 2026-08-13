import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription,
  ApprovalQueue, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions,
  AccountDescription, SupportedResource, ResourceConfiguratorFrame, ActionKind, Cursor,
  GatekeeperUserVerifier, ObservationDescription,
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  SlackApi, SlackApiError, SlackAccessToken, SlackConversationTypeFilter, exchangeAuthCode,
  refreshAccessToken, revokeToken,
} from "./slack-api";
import {
  SlackConversation, SlackConversationEntry, SlackConversationInfo, SlackMessage,
  SlackMessageEntry, SlackThread, SlackUser, SlackWorkspaceInfo, SlackWorkspaceSession,
} from "./types";
import {
  ConversationConfiguratorUI, ThreadConfiguratorUI, WorkspaceConfiguratorUI,
} from "./slack-configurators";
import TYPES_CODE from "./types.txt";
import WORKSPACE_CONFIGURATOR_HTML from "./generated/workspace-configurator-ui.txt";
import CONVERSATION_CONFIGURATOR_HTML from "./generated/conversation-configurator-ui.txt";
import THREAD_CONFIGURATOR_HTML from "./generated/thread-configurator-ui.txt";
import SLACK_LOGO_SVG from "./slack-logo.svg";

// ── OAuth flow ──────────────────────────────────────────────────────

// A single-use nonce advances from initiation to OAuth callback, expiring at each stage.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

type Env = Cloudflare.Env & {
  // Public worker URL without a trailing slash; defaults to the local dev route.
  BASE_URL?: string;
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/slack");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ── Limits ──────────────────────────────────────────────────────────

const HISTORY_PAGE_SIZE = 50;
const USER_PAGE_SIZE = 100;
const CONVERSATION_PAGE_SIZE = 100;
const MEMBER_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 20;
const MAX_THREAD_REPLIES = 1000;
const MAX_REPLY_PAGES = 20;
const MAX_SEARCH_QUERY_BYTES = 1000;

// Stay below the Workers limit of six concurrent outgoing requests when fanning out subrequests.
const MAX_CONCURRENT_REQUESTS = 5;

// Map over items with a bounded number of concurrent async calls, preserving input order. It uses
// Promise.all per batch, so it rejects on the first failed call — deliberate, since the observer
// access checks that use it must fail closed rather than act on a partial result.
async function mapWithConcurrency<T, R>(
    items: T[], fn: (item: T) => Promise<R>, limit = MAX_CONCURRENT_REQUESTS): Promise<R[]> {
  let results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return results;
}

// ── Resource types & OAuth scopes ───────────────────────────────────

// Needed for account display and user-name resolution.
const IDENTITY_SCOPES = ["users:read"];

// `https://*` denotes account-wide access; the configurator resolves the concrete workspace URL.
const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Slack Workspace",
  description:
      "Read channels, direct messages, members, and search across the whole connected workspace. " +
      "The workspace is auto-detected from the connected account — no URL or ID need be supplied.",
  grantable: true,
};

const CONVERSATION_RESOURCE: SupportedResource = {
  urlPattern: "https://app.slack.com/client/:teamId/:conversationId",
  title: "Slack Conversation",
  description: "Read a single channel, direct message, or group DM.",
  grantable: true,
};

const THREAD_RESOURCE: SupportedResource = {
  urlPattern: "https://*.slack.com/archives/:conversationId/:messageId",
  title: "Slack Thread",
  description: "Read a single message thread and its replies.",
  grantable: true,
};

const CONVERSATION_READ_SCOPES = [
  "channels:read", "channels:history",
  "groups:read", "groups:history",
  "im:read", "im:history",
  "mpim:read", "mpim:history",
];

const RESOURCE_SCOPES: { resource: SupportedResource; scopes: string[] }[] = [
  {
    resource: WORKSPACE_RESOURCE,
    scopes: ["team:read", ...CONVERSATION_READ_SCOPES, "search:read"],
  },
  {
    resource: CONVERSATION_RESOURCE,
    scopes: [...CONVERSATION_READ_SCOPES, "search:read"],
  },
  {
    resource: THREAD_RESOURCE,
    scopes: ["channels:history", "groups:history", "im:history", "mpim:history"],
  },
];

const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);

function validateResourceUrlPatterns(resourceUrlPatterns?: string[]): void {
  if (resourceUrlPatterns === undefined) return;
  let known = new Set(RESOURCE_SCOPES.map(entry => entry.resource.urlPattern));
  let unknown = resourceUrlPatterns.filter(pattern => !known.has(pattern));
  if (unknown.length > 0) {
    throw new Error(`Unknown grantable resource URL pattern(s): ${unknown.join(", ")}`);
  }
}

function resourceUrlPatternsToScopes(resourceUrlPatterns?: string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);
  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns === undefined ||
        resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

function grantedResourcesFromScopes(grantedScopes: string[]): string[] {
  let granted = new Set(grantedScopes);
  // Expose a resource only when every required Slack scope was granted.
  return RESOURCE_SCOPES
      .filter(entry => entry.scopes.every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}

const SLACK_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SLACK_LOGO_SVG)}`;

// ── HTML shown in the OAuth popup ───────────────────────────────────

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Slack Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please see the README.md for instructions on configuring a Slack OAuth client ID and secret.</p>
    </div>
  </body>
</html>`;

// ── HTTP handler: OAuth initiation + completion ─────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      let authUrl = new URL("https://slack.com/oauth/v2/authorize");
      authUrl.searchParams.set("client_id", env.CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      // User scopes produce the read-only user token needed for private channels and DMs.
      authUrl.searchParams.set("user_scope", begun.scopes.join(","));
      authUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(authUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      let error = url.searchParams.get("error");
      if (error) return new Response(`Slack authorization failed: ${error}`);

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(SELF_CLOSING_HTML,
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

// ── Vendor ──────────────────────────────────────────────────────────

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Slack",
      url: "https://slack.com",
      logo: { url: SLACK_LOGO_URL },
      color: "#f4ede4",
      tagline: "Read channels, DMs, and threads",
      description:
          "Connect your Slack account to give Cloudflare OS read-only access to the workspaces, " +
          "channels, direct messages, and threads you can see. Build agents that summarize " +
          "conversations, monitor channels, or search across your Slack history.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();
    let requestedScopes = resourceUrlPatternsToScopes(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ── UserAccount DO: token storage + rotation ────────────────────────

export class UserAccount extends DurableObject<Env> {
  // Serialize refresh, reconnect, and revoke because rotating refresh tokens are single-use.
  #credentialUpdate: Promise<void> = Promise.resolve();

  async #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedScopes: string[]) {
    // Self-destruct if the flow is never completed.
    if (!this.ctx.storage.kv.get<SlackAccessToken>("accessToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * Prepare for a reconnect/expansion flow: the next acceptAuthCode() replaces credentials and
   * notifies via credentialsRestored() instead of complete().
   */
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    let granted = this.ctx.storage.kv.get<string[]>("grantedScopes");
    if (granted === undefined) return SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
    return grantedResourcesFromScopes(granted);
  }

  async beginOAuthFlow(initiationNonce: string)
      : Promise<{ oauthNonce: string; scopes: string[] } | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    let oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? resourceUrlPatternsToScopes();
    return { oauthNonce, scopes };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    // Consume OAuth state before the network exchange to prevent callback replay.
    this.ctx.storage.kv.delete("nonce");

    let completion = await this.#updateCredentials(async () => {
      if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
        throw new Error("The Slack Gatekeeper is not configured.");
      }

      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        throw new Error("Took too long to complete the authorization. Please try again.");
      }

      let grant = await exchangeAuthCode(
          code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");

      this.ctx.storage.kv.put<SlackAccessToken>("accessToken", grant.accessToken);
      if (grant.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
      this.ctx.storage.kv.put<string>("userId", grant.userId);
      this.ctx.storage.kv.put<string>("teamId", grant.teamId);
      if (grant.teamName) this.ctx.storage.kv.put<string>("teamName", grant.teamName);
      this.ctx.storage.kv.delete("requestedScopes");

      let reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
      if (reconnecting) {
        this.ctx.storage.kv.delete("reconnecting");
      }
      return { callback, grant, reconnecting: !!reconnecting };
    });

    if (completion.reconnecting) {
      await completion.callback.credentialsRestored(completion.grant.accessToken.expires);
    } else {
      try {
        let props: SlackUserImplProps = { userObjectId: this.ctx.id.toString() };
        await completion.callback.complete(
            this.ctx.exports.SlackUserImpl({ props }), completion.grant.accessToken.expires);
      } catch (err) {
        await this.#updateCredentials(async () => {
          let storedToken = this.ctx.storage.kv.get<SlackAccessToken>("accessToken");
          if (storedToken?.token === completion.grant.accessToken.token) {
            this.ctx.storage.kv.delete("accessToken");
            this.ctx.storage.kv.delete("refreshToken");
          }
        });
        throw err;
      }
    }
    return true;
  }

  async getUserId(): Promise<string> {
    return this.ctx.storage.kv.get<string>("userId") ?? "";
  }

  async getTeamId(): Promise<string> {
    return this.ctx.storage.kv.get<string>("teamId") ?? "";
  }

  /** Refresh rotating tokens shortly before expiry. */
  async getAccessToken(): Promise<SlackAccessToken> {
    return this.#updateCredentials(() => this.#getAccessTokenLocked());
  }

  async #getAccessTokenLocked(): Promise<SlackAccessToken> {
    let cached = this.ctx.storage.kv.get<SlackAccessToken>("accessToken");
    if (!cached) throw new Error("No Slack credentials set.");
    // Normalize the persisted expiry before comparing it.
    let expires = new Date(cached.expires);
    if (expires.valueOf() > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return { token: cached.token, expires };
    }

    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      // Legacy non-rotating tokens do not expire.
      return { token: cached.token, expires };
    }

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Slack Gatekeeper is not configured.");
    }

    let result = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    if (result === null) {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsExpired().catch(err =>
          console.error("Failed to notify Slack credential expiry:", err));
      throw new Error("Slack credentials have expired or been revoked. Please re-authenticate.");
    }

    this.ctx.storage.kv.put<SlackAccessToken>("accessToken", result.accessToken);
    if (result.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", result.refreshToken);
    if (result.grantedScopes.length > 0) {
      this.ctx.storage.kv.put<string[]>("grantedScopes", result.grantedScopes);
    }
    return result.accessToken;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<SlackAccessToken>("accessToken")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.#updateCredentials(async () => {
      let cached = this.ctx.storage.kv.get<SlackAccessToken>("accessToken");
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (refreshToken) await revokeToken(refreshToken);
      if (cached) await revokeToken(cached.token);
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }
}

// Cache the token within one SlackApi instance while respecting its refresh window.
function createAccessTokenGetter(
    getStub: () => DurableObjectStub<UserAccount>): () => Promise<string> {
  let cached: SlackAccessToken | undefined;
  return async () => {
    if (!cached || cached.expires.valueOf() < Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      cached = await getStub().getAccessToken();
    }
    return cached.token;
  };
}

// ── SlackUserImpl: maps resource URLs to gatekeeper classes ─────────

type SlackUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class SlackUserImpl extends WorkerEntrypoint<Env, SlackUserImplProps>
                           implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return new SlackApi(createAccessTokenGetter(() => this.#account()));
  }

  async describe(): Promise<AccountDescription> {
    let account = this.#account();
    let userIdPromise = account.getUserId();
    let teamIdPromise = account.getTeamId();
    let grantedPromise = account.getGrantedResourceUrlPatterns();
    let description = await this.#api().getAccountDescription(
        await userIdPromise, await teamIdPromise);
    description.grantedResourceUrlPatterns = await grantedPromise;
    return description;
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = new URL(url);

    if (parsed.hostname.endsWith(".slack.com") && parsed.pathname.startsWith("/archives/")) {
      let segments = parsed.pathname.split("/").filter(Boolean);
      let conversationId = segments[1];
      let messageId = segments[2];
      if (!conversationId || !messageId) {
        throw new Error("Invalid Slack thread URL: expected /archives/<conversationId>/<messageId>.");
      }
      let threadTs = parsed.searchParams.get("thread_ts") || messageIdToTs(messageId);
      let props: SlackThreadGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        conversationId,
        threadTs,
        permalink: url,
      };
      return {
        class: this.ctx.exports.SlackThreadGatekeeperImpl({ props }),
        resource: THREAD_RESOURCE,
      };
    }

    if (parsed.hostname === "app.slack.com" && parsed.pathname.startsWith("/client/")) {
      let segments = parsed.pathname.split("/").filter(Boolean);
      let conversationId = segments[2];
      if (conversationId) {
        let props: SlackConversationGatekeeperImplProps = {
          userObjectId: this.ctx.props.userObjectId,
          conversationId: decodeURIComponent(conversationId),
        };
        return {
          class: this.ctx.exports.SlackConversationGatekeeperImpl({ props }),
          resource: CONVERSATION_RESOURCE,
        };
      }
      let props: SlackWorkspaceGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
      return {
        class: this.ctx.exports.SlackWorkspaceGatekeeperImpl({ props }),
        resource: WORKSPACE_RESOURCE,
      };
    }

    throw new Error(`Unsupported Slack resource URL: ${url}`);
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === WORKSPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new WorkspaceConfiguratorUI(this.#api())),
      };
    }
    if (resourceUrlPattern === CONVERSATION_RESOURCE.urlPattern) {
      let teamId = await this.#account().getTeamId();
      return {
        iframeHtml: CONVERSATION_CONFIGURATOR_HTML,
        ui: new RpcStub(new ConversationConfiguratorUI(this.#api(), teamId)),
      };
    }
    if (resourceUrlPattern === THREAD_RESOURCE.urlPattern) {
      return {
        iframeHtml: THREAD_CONFIGURATOR_HTML,
        ui: new RpcStub(new ThreadConfiguratorUI()),
      };
    }
    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async reconnect(): Promise<{ url: string }> {
    let account = this.#account();
    let initiationNonce = generateNonce();
    let requestedScopes = resourceUrlPatternsToScopes(await account.getGrantedResourceUrlPatterns());
    await account.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    let account = this.#account();
    let granted = new Set(await account.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) return {};

    let union = new Set([...granted, ...resourceUrlPatterns]);
    let requestedScopes = resourceUrlPatternsToScopes([...union]);
    let initiationNonce = generateNonce();
    await account.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  /**
   * Mint a verifier representing this account, used by the Slack gatekeepers' addObserver to confirm
   * a prospective observer may read a bound conversation (and, for workspace bindings, the workspace
   * and each observed conversation). The verifier carries this user's own account id, so the access
   * checks run against the observer's *own* Slack token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: SlackVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.SlackVerifier({ props });
  }
}

// ── Verifier ────────────────────────────────────────────────────────
//
// Slack uses the "ACL check (single unit)" observer strategy for conversation and thread bindings
// (each is one conversation, and a thread inherits its conversation's ACL), and "data-set tracking
// (by conversation)" for workspace bindings (see the gatekeeper impls' observer methods). Both
// reduce to per-observer access questions answered against the observer's *own* token:
//   - getTeamId(): the workspace the observer's token belongs to, gating workspace membership.
//   - hasConversationAccess(id): conversations.info succeeds for the observer. Public channels
//     resolve for any workspace member; private channels, DMs, and group DMs resolve only for
//     members/participants — honoring Slack's ACL. Conversation IDs are globally unique, so this
//     also rejects a conversation in a different workspace.
// The overseer only ever hands this verifier back to a Slack gatekeeper, which may therefore trust
// the boolean results.

type SlackVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard methods the Slack gatekeepers call on their own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface SlackVerifierApi extends GatekeeperUserVerifier {
  getTeamId(): Promise<string | null>;
  hasConversationAccess(conversationId: string): Promise<boolean>;
}

@validateRpc()
export class SlackVerifier extends WorkerEntrypoint<Env, SlackVerifierProps>
    implements SlackVerifierApi {
  #api(): SlackApi {
    let account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return new SlackApi(createAccessTokenGetter(() => account));
  }

  /**
   * The observer's workspace team id, or null if their token is broken/expired (a token that can't
   * demonstrate access is treated as "no access" rather than failing the whole open; the observer is
   * re-checked on their next open).
   */
  async getTeamId(): Promise<string | null> {
    try {
      return (await this.#api().authedTeamId()) || null;
    } catch (error) {
      if (error instanceof SlackApiError && error.isAuthError) return null;
      throw error;
    }
  }

  async hasConversationAccess(conversationId: string): Promise<boolean> {
    try {
      await this.#api().getConversationInfo(conversationId);
      return true;
    } catch (error) {
      if (error instanceof SlackApiError && (error.isAccessError || error.isAuthError)) return false;
      throw error;
    }
  }
}

// Slack message permalinks encode ts as p<seconds><6-digit-microseconds>.
function messageIdToTs(messageId: string): string {
  let digits = messageId.replace(/^p/, "");
  if (digits.length <= 6) return digits;
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

// ── Session context & shared helpers ────────────────────────────────

type SlackSessionContext = {
  api: SlackApi;
  approvalQueue: RpcStub<ApprovalQueue>;
  // Set for workspace bindings only: routes conversation-scoped observations through the gatekeeper
  // so it can record which conversations were revealed and exclude observers who cannot access them.
  // Undefined for single-unit conversation/thread bindings, whose whole resource is verified up
  // front. Held by in-process reference (the session runs in the gatekeeper's own isolate), so it is
  // copied — not duped — across dupSessionContext.
  tracker?: SlackWorkspaceGatekeeperImpl;
};

function dupSessionContext(ctx: SlackSessionContext): SlackSessionContext {
  return { api: ctx.api, approvalQueue: ctx.approvalQueue.dup(), tracker: ctx.tracker };
}

// Authorize a conversation-scoped observation. For workspace bindings this records the revealed
// conversations as observed data sets and excludes observers lacking access to a newly-seen one; for
// single-unit bindings it is a plain authorizeObservation. `conversationIds` may be empty for
// workspace-level reads (workspace metadata, member directory) any member may see. Every read that
// reveals conversation identity or content should go through this rather than calling
// approvalQueue.authorizeObservation directly.
async function authorizeConversationObservation(
    ctx: SlackSessionContext, conversationIds: string[],
    description: ObservationDescription): Promise<void> {
  if (ctx.tracker) {
    await ctx.tracker.authorizeConversationObservation(
        ctx.approvalQueue, conversationIds, description);
  } else {
    await ctx.approvalQueue.authorizeObservation(description);
  }
}

function truncate(text: string, max = 200): string {
  let trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

function conversationLabel(info: SlackConversationInfo): string {
  if (info.kind === "im") return "a direct message";
  if (info.kind === "mpim") return "a group direct message";
  return info.name ? `#${info.name}` : "a private channel";
}

function conversationEntry(
    ctx: SlackSessionContext, info: SlackConversationInfo): SlackConversationEntry {
  return { info, conversation: new SlackConversationImpl(dupSessionContext(ctx), info.id) };
}

function messageEntry(
    ctx: SlackSessionContext, channelId: string, message: SlackMessage): SlackMessageEntry {
  let threadRoot = message.threadTs ?? (message.replyCount ? message.ts : undefined);
  let thread = threadRoot
      ? new SlackThreadImpl(dupSessionContext(ctx), channelId, threadRoot)
      : undefined;
  return { message, thread };
}

function validateSearchQuery(query: string): void {
  // Reject blank queries before creating a lazy cursor.
  if (query.trim().length === 0) {
    throw new Error("Search query must not be empty.");
  }
  if (new TextEncoder().encode(query).byteLength > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`Search query must be at most ${MAX_SEARCH_QUERY_BYTES} bytes.`);
  }
}

// ── Cursor ──────────────────────────────────────────────────────────

// Each page is authorized before it can reach the caller.
class SlackCursor<T> extends RpcTarget implements Cursor<T> {
  #ctx: SlackSessionContext;
  #loadPage: (
    ctx: SlackSessionContext, cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string }>;
  #cursor: string | undefined;
  #exhausted = false;
  // Serialize concurrent next() calls so each consumes a distinct page.
  #tail: Promise<void> = Promise.resolve();

  constructor(
      ctx: SlackSessionContext,
      loadPage: (
        ctx: SlackSessionContext, cursor: string | undefined,
      ) => Promise<{ items: T[]; nextCursor?: string }>) {
    super();
    this.#ctx = dupSessionContext(ctx);
    this.#loadPage = loadPage;
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  next(): Promise<T[] | null> {
    let result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<T[] | null> {
    while (!this.#exhausted) {
      let page = await this.#loadPage(this.#ctx, this.#cursor);
      this.#cursor = page.nextCursor;
      this.#exhausted = !page.nextCursor;
      if (page.items.length > 0) return page.items;
    }
    return null;
  }
}

// ── Gatekeeper impls ────────────────────────────────────────────────

const NO_ACTIONS: ActionKind[] = [];

function unreachableAction(): never {
  throw new Error("Slack gatekeeper is read-only and submits no actions.");
}

type SlackWorkspaceGatekeeperImplProps = {
  userObjectId: string;
};

// A tracked conversation is "pending" while an observation revealing it is in flight, and "observed"
// once that observation has been authorized (see #prepareConversationObservation).
type TrackedConversationState = "pending" | "observed";

@validateRpc()
export class SlackWorkspaceGatekeeperImpl extends DurableObject<Env, SlackWorkspaceGatekeeperImplProps>
    implements Gatekeeper<SlackWorkspaceSession> {
  #apiInstance?: SlackApi;

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return this.#apiInstance ??= new SlackApi(createAccessTokenGetter(() => this.#account()));
  }

  async describe(): Promise<ResourceDescription> {
    let info = await this.#api().getWorkspaceInfo();
    return {
      url: `https://app.slack.com/client/${info.teamId}`,
      title: info.name || "Slack workspace",
      snippet: `Slack workspace: ${info.name || info.teamId}`,
      suggestedBindingName: "SLACK_WORKSPACE",
      tsType: "SlackWorkspaceSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return NO_ACTIONS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SlackWorkspaceSession> {
    return new SlackWorkspaceSessionImpl(
        { api: this.#api(), approvalQueue: approvalQueue.dup(), tracker: this });
  }

  // ── Observer tracking (data-set tracking by conversation) ─────────
  //
  // A workspace binding spans many conversations with distinct ACLs (public/private channels, DMs),
  // so we track which conversations' data the Gadget has actually observed and verify each observer
  // against them. addObserver requires workspace membership (so workspace metadata and the member
  // directory are fine to show) plus access to every already-observed conversation; later, the first
  // observation revealing a *new* conversation excludes any observer lacking access to it (see
  // #prepareConversationObservation). Verified observers are remembered (their verifier stored) so the
  // forward-exclusion check can run. The overseer re-runs addObserver on every open, catching loss
  // of access promptly.

  #observerKey(id: string): string { return `observer:${id}`; }
  #trackedConversationKey(id: string): string { return `trackedConversation:${id}`; }

  #isConversationObserved(conversationId: string): boolean {
    return this.ctx.storage.kv.get<TrackedConversationState>(
        this.#trackedConversationKey(conversationId)) === "observed";
  }

  #listTrackedConversations(): string[] {
    let prefix = "trackedConversation:";
    return [...this.ctx.storage.kv.list<TrackedConversationState>({ prefix })]
        .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<SlackVerifierApi>]> {
    let prefix = "observer:";
    for (let [key, verifier] of this.ctx.storage.kv.list<Fetcher<SlackVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Marks not-yet-observed conversations pending and returns the current observers who cannot access
  // one of them, plus a commit() promoting them to observed. Conversations stay pending (and are
  // rechecked on retry) until commit() runs, so an observation the overseer blocks is not recorded
  // as revealed.
  async #prepareConversationObservation(conversationIds: string[]):
      Promise<{ excludeObservers?: string[]; commit(): void }> {
    let pending = [...new Set(conversationIds)].filter(id => !this.#isConversationObserved(id));
    if (pending.length === 0) return { commit() {} };
    for (let id of pending) {
      let key = this.#trackedConversationKey(id);
      if (this.ctx.storage.kv.get<TrackedConversationState>(key) === undefined) {
        this.ctx.storage.kv.put<TrackedConversationState>(key, "pending");
      }
    }
    let excluded: string[] = [];
    for (let [id, verifier] of this.#listObservers()) {
      let access = await mapWithConcurrency(pending, cid => verifier.hasConversationAccess(cid));
      if (!access.every(hasAccess => hasAccess)) excluded.push(id);
    }
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      commit: () => {
        for (let id of pending) {
          this.ctx.storage.kv.put<TrackedConversationState>(this.#trackedConversationKey(id), "observed");
        }
      },
    };
  }

  /**
   * Routes a conversation-scoped observation through data-set tracking (see the class comment).
   * Called in-process by the workspace session and its child capabilities via
   * authorizeConversationObservation.
   */
  async authorizeConversationObservation(
      queue: RpcStub<ApprovalQueue>, conversationIds: string[],
      description: ObservationDescription): Promise<void> {
    let check = conversationIds.length > 0
        ? await this.#prepareConversationObservation(conversationIds)
        : { excludeObservers: undefined, commit() {} };
    await queue.authorizeObservation({ ...description, excludeObservers: check.excludeObservers });
    check.commit();
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    let boundTeamId = await this.#account().getTeamId();
    let observerTeamId = await verifier.getTeamId();
    if (!observerTeamId || observerTeamId !== boundTeamId) {
      throw new Error(
          "This collaborator is not a member of the connected Slack workspace, so they cannot be " +
          "allowed to observe it.");
    }
    // Loop until no new conversations appear mid-check (concurrent observations may add more).
    let checked = new Set<string>();
    while (true) {
      let conversationIds = this.#listTrackedConversations().filter(cid => !checked.has(cid));
      if (conversationIds.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await mapWithConcurrency(
          conversationIds, cid => verifier.hasConversationAccess(cid));
      if (access.some(hasAccess => !hasAccess)) {
        throw new Error(
            "This collaborator does not have access to a Slack conversation whose data this workspace " +
            "has read, so they cannot be allowed to observe it.");
      }
      for (let cid of conversationIds) checked.add(cid);
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }

  applyAction(): Promise<void> { return unreachableAction(); }
  rejectAction(): Promise<void> { return unreachableAction(); }
  revertAction(): Promise<void> { return unreachableAction(); }
}

type SlackConversationGatekeeperImplProps = {
  userObjectId: string;
  conversationId: string;
};

@validateRpc()
export class SlackConversationGatekeeperImpl
    extends DurableObject<Env, SlackConversationGatekeeperImplProps>
    implements Gatekeeper<SlackConversation> {
  #apiInstance?: SlackApi;

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return this.#apiInstance ??= new SlackApi(createAccessTokenGetter(() => this.#account()));
  }

  async describe(): Promise<ResourceDescription> {
    let teamIdPromise = this.#account().getTeamId();
    let info = await this.#api().getConversationInfo(this.ctx.props.conversationId);
    let teamId = await teamIdPromise;
    let title = info.name ? `#${info.name}` : conversationLabel(info);
    return {
      url: `https://app.slack.com/client/${teamId}/${info.id}`,
      title,
      snippet: info.purpose || info.topic || `Slack conversation ${info.id}`,
      suggestedBindingName: "SLACK_CONVERSATION",
      tsType: "SlackConversation",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return NO_ACTIONS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SlackConversation> {
    return new SlackConversationImpl(
        { api: this.#api(), approvalQueue: approvalQueue.dup() },
        this.ctx.props.conversationId);
  }

  /**
   * Observer tracking: "ACL check (single unit)". The binding is one conversation, so we simply
   * confirm the observer can read it with their own token (see SlackVerifier). Nothing read later
   * could be outside that conversation, so no observers are tracked, no excludeObservers is set, and
   * removeObserver is an idempotent no-op. The overseer re-runs addObserver on every open, catching
   * loss of access promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    if (!(await verifier.hasConversationAccess(this.ctx.props.conversationId))) {
      throw new Error(
          "This collaborator does not have access to the connected Slack conversation, so they " +
          "cannot be allowed to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  applyAction(): Promise<void> { return unreachableAction(); }
  rejectAction(): Promise<void> { return unreachableAction(); }
  revertAction(): Promise<void> { return unreachableAction(); }
}

type SlackThreadGatekeeperImplProps = {
  userObjectId: string;
  conversationId: string;
  threadTs: string;
  permalink: string;
};

@validateRpc()
export class SlackThreadGatekeeperImpl extends DurableObject<Env, SlackThreadGatekeeperImplProps>
    implements Gatekeeper<SlackThread> {
  #apiInstance?: SlackApi;

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return this.#apiInstance ??= new SlackApi(createAccessTokenGetter(() => this.#account()));
  }

  async describe(): Promise<ResourceDescription> {
    let snippet = "Slack thread";
    try {
      let page = await this.#api().listReplies(
          this.ctx.props.conversationId, this.ctx.props.threadTs, undefined, 1);
      if (page.items[0]) snippet = truncate(page.items[0].text) || snippet;
    } catch {
      // Keep the generic snippet when the root is unavailable.
    }
    return {
      url: this.ctx.props.permalink,
      title: "Slack thread",
      snippet,
      suggestedBindingName: "SLACK_THREAD",
      tsType: "SlackThread",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return NO_ACTIONS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SlackThread> {
    return new SlackThreadImpl(
        { api: this.#api(), approvalQueue: approvalQueue.dup() },
        this.ctx.props.conversationId, this.ctx.props.threadTs);
  }

  /**
   * Observer tracking: "ACL check (single unit)". A thread inherits its conversation's ACL, so we
   * confirm the observer can read that conversation with their own token (see SlackVerifier). Nothing
   * read later could be outside it, so no observers are tracked and removeObserver is an idempotent
   * no-op. The overseer re-runs addObserver on every open, catching loss of access promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    if (!(await verifier.hasConversationAccess(this.ctx.props.conversationId))) {
      throw new Error(
          "This collaborator does not have access to the Slack conversation containing this " +
          "thread, so they cannot be allowed to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  applyAction(): Promise<void> { return unreachableAction(); }
  rejectAction(): Promise<void> { return unreachableAction(); }
  revertAction(): Promise<void> { return unreachableAction(); }
}

// ── Session stubs ───────────────────────────────────────────────────

@validateRpc()
class SlackWorkspaceSessionImpl extends RpcTarget implements SlackWorkspaceSession {
  #ctx: SlackSessionContext;

  constructor(ctx: SlackSessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<SlackWorkspaceInfo> {
    let info = await this.#ctx.api.getWorkspaceInfo();
    await authorizeConversationObservation(this.#ctx, [], {
      title: "Read Slack workspace info",
      description: `Read metadata for the "${info.name}" workspace.`,
    });
    return info;
  }

  #listConversations(
      types: SlackConversationTypeFilter[], title: string): Cursor<SlackConversationEntry> {
    return new SlackCursor<SlackConversationEntry>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.listUserConversations(types, cursor, CONVERSATION_PAGE_SIZE);
      await authorizeConversationObservation(ctx, page.items.map(info => info.id), {
        title: `${title} (${page.items.length})`,
        description: page.items.length > 0
            ? `Listed conversations:\n${page.items.map(info =>
                `- ${info.name ? "#" + info.name : conversationLabel(info)}`).join("\n")}`
            : "No conversations on this page.",
      });
      let entries = page.items.map(info => conversationEntry(ctx, info));
      return { items: entries, nextCursor: page.nextCursor };
    });
  }

  async listChannels(): Promise<Cursor<SlackConversationEntry>> {
    return this.#listConversations(["public_channel", "private_channel"], "List Slack channels");
  }

  async listDirectMessages(): Promise<Cursor<SlackConversationEntry>> {
    return this.#listConversations(["im", "mpim"], "List Slack direct messages");
  }

  async listUsers(): Promise<Cursor<SlackUser>> {
    return new SlackCursor<SlackUser>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.listUsers(cursor, USER_PAGE_SIZE);
      await authorizeConversationObservation(ctx, [], {
        title: `List Slack members (${page.items.length})`,
        description: `Read a page of ${page.items.length} workspace members.`,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  async getUser(userId: string): Promise<SlackUser> {
    let user = await this.#ctx.api.getUser(userId);
    await authorizeConversationObservation(this.#ctx, [], {
      title: `Read Slack user ${user.username}`,
      description: `Read profile for user ${user.username} (${user.id}).`,
    });
    return user;
  }

  async getConversation(conversationId: string): Promise<SlackConversation> {
    let info = await this.#ctx.api.getConversationInfo(conversationId);
    await authorizeConversationObservation(this.#ctx, [info.id], {
      title: `Open Slack conversation ${info.name ? "#" + info.name : info.id}`,
      description: `Open ${conversationLabel(info)} for reading.`,
    });
    return new SlackConversationImpl(dupSessionContext(this.#ctx), info.id);
  }

  async search(query: string): Promise<Cursor<SlackMessageEntry>> {
    validateSearchQuery(query);
    return new SlackCursor<SlackMessageEntry>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.searchMessages(query, cursor, SEARCH_PAGE_SIZE);
      let channelIds = [...new Set(page.items.map(match => match.channelId))];
      await authorizeConversationObservation(ctx, channelIds, {
        title: `Search Slack (${page.items.length} results)`,
        description:
            `Search the workspace for messages.\n\nQuery: ${truncate(query)}\n\n` +
            `Matched ${page.items.length} messages on this page.`,
      });
      let entries = page.items.map(match => messageEntry(ctx, match.channelId, match.message));
      return { items: entries, nextCursor: page.nextCursor };
    });
  }
}

@validateRpc()
class SlackConversationImpl extends RpcTarget implements SlackConversation {
  #ctx: SlackSessionContext;
  #conversationId: string;

  constructor(ctx: SlackSessionContext, conversationId: string) {
    super();
    this.#ctx = ctx;
    this.#conversationId = conversationId;
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<SlackConversationInfo> {
    let info = await this.#ctx.api.getConversationInfo(this.#conversationId);
    await authorizeConversationObservation(this.#ctx, [this.#conversationId], {
      title: `Read Slack conversation info ${info.name ? "#" + info.name : info.id}`,
      description: `Read metadata for ${conversationLabel(info)}.`,
    });
    return info;
  }

  async members(): Promise<Cursor<SlackUser>> {
    let conversationId = this.#conversationId;
    return new SlackCursor<SlackUser>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.listConversationMembers(conversationId, cursor, MEMBER_PAGE_SIZE);
      let users = await mapWithConcurrency(page.items, id => ctx.api.getUser(id));
      await authorizeConversationObservation(ctx, [conversationId], {
        title: `List Slack conversation members (${users.length})`,
        description: `Read ${users.length} members of conversation ${conversationId}.`,
      });
      return { items: users, nextCursor: page.nextCursor };
    });
  }

  async listMessages(): Promise<Cursor<SlackMessageEntry>> {
    let conversationId = this.#conversationId;
    return new SlackCursor<SlackMessageEntry>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.listHistory(conversationId, cursor, HISTORY_PAGE_SIZE);
      await authorizeConversationObservation(ctx, [conversationId], {
        title: `Read Slack messages (${page.items.length})`,
        description:
            `Read a page of ${page.items.length} messages from conversation ${conversationId}.`,
      });
      let entries = page.items.map(message =>
          messageEntry(ctx, conversationId, message));
      return { items: entries, nextCursor: page.nextCursor };
    });
  }

  async getThread(threadTs: string): Promise<SlackThread> {
    return new SlackThreadImpl(dupSessionContext(this.#ctx), this.#conversationId, threadTs);
  }

  async search(query: string): Promise<Cursor<SlackMessageEntry>> {
    validateSearchQuery(query);
    // The name narrows Slack's search; ID filtering below remains the security boundary.
    let conversationId = this.#conversationId;
    let infoPromise: Promise<SlackConversationInfo> | undefined;
    return new SlackCursor<SlackMessageEntry>(this.#ctx, async (ctx, cursor) => {
      let info = await (infoPromise ??= ctx.api.getConversationInfo(conversationId));
      let effectiveQuery = info.name ? `in:#${info.name} ${query}` : query;
      let page = await ctx.api.searchMessages(
          effectiveQuery, cursor, SEARCH_PAGE_SIZE, conversationId);
      await authorizeConversationObservation(ctx, [conversationId], {
        title: `Search Slack conversation (${page.items.length} results)`,
        description:
            `Search within ${conversationLabel(info)}.\n\nQuery: ${truncate(query)}\n\n` +
            `Matched ${page.items.length} messages on this page.`,
      });
      let entries = page.items.map(match => messageEntry(ctx, match.channelId, match.message));
      return { items: entries, nextCursor: page.nextCursor };
    });
  }
}

@validateRpc()
class SlackThreadImpl extends RpcTarget implements SlackThread {
  #ctx: SlackSessionContext;
  #conversationId: string;
  #threadTs: string;
  #resolved?: Promise<{ rootTs: string; root: SlackMessage | undefined }>;

  constructor(ctx: SlackSessionContext, conversationId: string, threadTs: string) {
    super();
    this.#ctx = ctx;
    this.#conversationId = conversationId;
    this.#threadTs = threadTs;
  }

  [Symbol.dispose]() {
    this.#ctx.approvalQueue[Symbol.dispose]();
  }

  // Resolve reply timestamps to the thread root once per session.
  #resolveRoot(): Promise<{ rootTs: string; root: SlackMessage | undefined }> {
    return this.#resolved ??= (async () => {
      let page = await this.#ctx.api.listReplies(
          this.#conversationId, this.#threadTs, undefined, 1);
      let first = page.items[0];
      if (first?.threadTs && first.threadTs !== this.#threadTs) {
        let rootPage = await this.#ctx.api.listReplies(
            this.#conversationId, first.threadTs, undefined, 1);
        return { rootTs: first.threadTs, root: rootPage.items[0] };
      }
      return { rootTs: this.#threadTs, root: first };
    })();
  }

  async getRoot(): Promise<SlackMessage> {
    let { root } = await this.#resolveRoot();
    if (!root) throw new Error(`Thread ${this.#threadTs} not found.`);
    await authorizeConversationObservation(this.#ctx, [this.#conversationId], {
      title: "Read Slack thread root",
      description: `Read the root message of a thread in conversation ${this.#conversationId}.`,
    });
    return root;
  }

  async listReplies(): Promise<SlackMessage[]> {
    let { rootTs } = await this.#resolveRoot();
    let messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REPLY_PAGES; page++) {
      let result = await this.#ctx.api.listReplies(
          this.#conversationId, rootTs, cursor, HISTORY_PAGE_SIZE);
      messages.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor || messages.length >= MAX_THREAD_REPLIES) break;
    }
    await authorizeConversationObservation(this.#ctx, [this.#conversationId], {
      title: `Read Slack thread (${messages.length} messages)`,
      description:
          `Read a thread of ${messages.length} messages in conversation ${this.#conversationId}.`,
    });
    return messages.slice(0, MAX_THREAD_REPLIES);
  }
}
