import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription,
  ApprovalQueue, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions,
  AccountDescription, SupportedResource, ResourceConfiguratorFrame, ActionKind, Cursor,
  GatekeeperUserVerifier, ObservationDescription,
  stripTrailingSlashes, workerVersionTag, type ConnectHandoff,
  requestedResourceUrlPatterns, resourceTypeUrlPattern,
} from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import {
  SlackApi, SlackApiError, SlackAccessToken, SlackConversationTypeFilter, SlackOAuthGrant,
  exchangeAuthCode, refreshAccessToken, revokeToken, isWorkspaceId, type SlackInstallation,
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
  /**
   * Set when this flow reconnects an existing account, so its grant is staged rather than made
   * live. The mode travels with the flow instead of living on the account: committing one
   * reconnect while another is in flight must not change how that other flow lands.
   */
  reconnect?: true;
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
  id: "workspace",
  urlPattern: "https://*",
  title: "Slack Workspace",
  description:
      "Read channels, direct messages, members, and search across the whole connected workspace. " +
      "Choose a workspace the connected user and Slack app can access.",
  grantable: true,
};

const CONVERSATION_RESOURCE: SupportedResource = {
  id: "conversation",
  urlPattern: "https://app.slack.com/client/:teamId/:conversationId",
  title: "Slack Conversation",
  description: "Read a single channel, direct message, or group DM.",
  grantable: true,
};

const THREAD_RESOURCE: SupportedResource = {
  id: "thread",
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

const RESOURCE_SCOPES: {
  resource: SupportedResource;
  scopes: string[];
  /** Prior consent to these scopes can be upgraded through a new OAuth consent, never a read. */
  legacyScopes?: string[];
}[] = [
  {
    resource: WORKSPACE_RESOURCE,
    scopes: ["team:read", ...CONVERSATION_READ_SCOPES, "search:read"],
  },
  {
    resource: CONVERSATION_RESOURCE,
    scopes: ["team:read", ...CONVERSATION_READ_SCOPES, "search:read"],
    legacyScopes: [...CONVERSATION_READ_SCOPES, "search:read"],
  },
  {
    resource: THREAD_RESOURCE,
    // Workspace resolution and channel membership verification also need metadata read scopes.
    scopes: ["team:read", ...CONVERSATION_READ_SCOPES],
    legacyScopes: CONVERSATION_READ_SCOPES.filter(scope => scope.endsWith(":history")),
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

function grantedResourcesFromScopes(grantedScopes: string[], forReconnect = false): string[] {
  let granted = new Set(grantedScopes);
  // Reads need all current scopes. Reconnect may retain a legacy resource only to request consent.
  return RESOURCE_SCOPES
      .filter(entry => (forReconnect ? entry.legacyScopes ?? entry.scopes : entry.scopes)
          .every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}

const SLACK_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SLACK_LOGO_SVG)}`;

// ── HTML shown in the OAuth popup ───────────────────────────────────

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
      let handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML,
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return htmlResponse(connectHandoffPageHtml(handoff));
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

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();
    let requestedScopes = resourceUrlPatternsToScopes(
        requestedResourceUrlPatterns(options, SUPPORTED_RESOURCES));
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

// ── Observer subresources ───────────────────────────────────────────
//
// Every read reports what it disclosed as subresources (see slackSubresourceId), which the
// Workshop checks collaborators against through verifyObserverAccess(). Slack's access control
// stops at the conversation, so a thread, message, member or search match reports its
// conversation. A conversation's check includes its workspace's, so no read relies on the
// workspace check addObserver() keeps for reads made before they reported subresources.

/** What a Slack read can depend on: a workspace, or with `conversationId`, a conversation in it. */
type SlackSubresource = { teamId: string; conversationId?: string };

/**
 * The subresource ID a read reports: `workspace/<teamId>` for the workspace's metadata, its member
 * directory, or a listing or search page naming no conversation, and
 * `workspace/<teamId>/conversation/<conversationId>` for each conversation it listed, matched or
 * read from. A conversation is named within the workspace it was read through, whose membership
 * its check also requires.
 */
function slackSubresourceId({ teamId, conversationId }: SlackSubresource): string {
  let fragments = [{ name: "workspace", id: teamId }];
  if (conversationId !== undefined) fragments.push({ name: "conversation", id: conversationId });
  return formatSubresourceId({ fragments });
}

/** What a slackSubresourceId() ID names; throws for any other ID. */
function parseSlackSubresource(id: string): SlackSubresource {
  let { namespace, fragments: [workspace, conversation, ...rest] } = parseSubresourceId(id);
  if (namespace === undefined && rest.length === 0 && workspace.name === "workspace" &&
      isWorkspaceId(workspace.id)) {
    if (conversation === undefined) return { teamId: workspace.id };
    if (conversation.name === "conversation") {
      return { teamId: workspace.id, conversationId: conversation.id };
    }
  }
  throw new Error("Not a Slack subresource ID.");
}

// How long an account reuses an answer about its access to a subresource, counted from when it
// started asking Slack. Slack doesn't say when membership changes: a removal is noticed only once
// the answer that allowed it expires, while a denial is kept briefly so that a new membership is
// noticed soon.
const SUBRESOURCE_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const SUBRESOURCE_ACCESS_DENIED_TTL_MS = 15_000;

/** How long an access answer is reused, by whether it allowed (see the TTLs above). */
function subresourceAccessTtl(allowed: boolean): number {
  return allowed ? SUBRESOURCE_ACCESS_ALLOWED_TTL_MS : SUBRESOURCE_ACCESS_DENIED_TTL_MS;
}

/**
 * Whether `read` succeeds for an account: false when Slack answers that the account cannot see
 * what it asked for (see SlackApiError.isDenial), and a throw for any other failure, which leaves
 * the account's access undetermined.
 */
async function slackAccess(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    if (error instanceof SlackApiError && error.isDenial) return false;
    throw error;
  }
}

// ── UserAccount DO: token storage + rotation ────────────────────────

export class UserAccount extends DurableObject<Env> {
  // Serialize refresh, reconnect, and revoke because rotating refresh tokens are single-use.
  #credentialUpdate: Promise<void> = Promise.resolve();

  // This account's answers about its own access to subresources, keyed by subresource and
  // partitioned by the credentials that learned them (see #credentialsId), so an answer can't
  // outlive a disconnect, nor survive a reconnect, which may sign in as another Slack user or
  // workspace. Bypassed while the account holds no credentials.
  #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the credentials installed now, or undefined while there are none. Every install names
  // its credentials afresh (see #writeGrant), and revoking deletes the name with everything else,
  // so no load that started under earlier credentials can find the same name when it finishes. A
  // token refresh renews the same grant, so it keeps the name. Credentials installed before names
  // existed are named on first use.
  #credentialsId(): string | undefined {
    let kv = this.ctx.storage.kv;
    if (!kv.get<SlackAccessToken>("accessToken")) return undefined;
    let id = kv.get<string>("credentialsId");
    if (id === undefined) {
      id = crypto.randomUUID();
      kv.put<string>("credentialsId", id);
    }
    return id;
  }

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
   * Prepare for a reconnect/expansion flow: the next acceptAuthCode() stages the new credentials
   * and notifies via reconnectComplete() instead of complete(); commitReconnect() makes them live.
   */
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]) {
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    let granted = this.ctx.storage.kv.get<string[]>("grantedScopes");
    if (granted === undefined) return SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
    return grantedResourcesFromScopes(granted);
  }

  /** Preserve legacy narrow grants when requesting new consent for metadata scopes. */
  async getResourceUrlPatternsForReconnect(): Promise<string[]> {
    let granted = this.ctx.storage.kv.get<string[]>("grantedScopes");
    return granted === undefined ? SUPPORTED_RESOURCES.map(resource => resource.urlPattern)
        : grantedResourcesFromScopes(granted, true);
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
      reconnect: stored.reconnect,
    });
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? resourceUrlPatternsToScopes();
    return { oauthNonce, scopes };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    // Consume OAuth state before the network exchange to prevent callback replay.
    this.ctx.storage.kv.delete("nonce");
    let reconnect = stored.reconnect;

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

      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      let stageId = reconnect
          ? stageCredentials(this.ctx.storage.kv, grant, Date.now())
          : undefined;
      if (stageId === undefined) this.#writeGrant(grant);
      this.ctx.storage.kv.delete("requestedScopes");
      return { callback, grant, stageId };
    });

    let handoff: ConnectHandoff;
    if (completion.stageId !== undefined) {
      handoff = await completion.callback.reconnectComplete(
          completion.stageId, completion.grant.accessToken.expires);
    } else {
      try {
        let props: SlackUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await completion.callback.complete(
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
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    await this.#updateCredentials(async () => {
      let grant = commitStagedCredentials<SlackOAuthGrant>(this.ctx.storage.kv, Date.now(), stageId);
      if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
      this.#writeGrant(grant);
    });
  }

  #writeGrant(grant: SlackOAuthGrant) {
    this.ctx.storage.kv.put<SlackAccessToken>("accessToken", grant.accessToken);
    this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
    if (grant.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
    this.ctx.storage.kv.put<string>("userId", grant.userId);
    this.ctx.storage.kv.put<string>("teamId", grant.teamId);
    if (grant.teamName) this.ctx.storage.kv.put<string>("teamName", grant.teamName);
    else this.ctx.storage.kv.delete("teamName");
    // A reconnect staged before this version may not contain the installation flag.
    if (typeof grant.isEnterpriseInstall === "boolean") {
      this.ctx.storage.kv.put("isEnterpriseInstall", grant.isEnterpriseInstall);
    } else {
      this.ctx.storage.kv.delete("isEnterpriseInstall");
    }
    if (grant.enterpriseId) this.ctx.storage.kv.put("enterpriseId", grant.enterpriseId);
    else this.ctx.storage.kv.delete("enterpriseId");
  }

  async getUserId(): Promise<string> {
    return this.ctx.storage.kv.get<string>("userId") ?? "";
  }

  async getTeamId(): Promise<string> {
    return this.ctx.storage.kv.get<string>("teamId") ?? "";
  }

  /** Installation identity is distinct from the workspace selected by a resource binding. */
  async getInstallation(): Promise<SlackInstallation> {
    return {
      teamId: await this.getTeamId(),
      isEnterpriseInstall: this.ctx.storage.kv.get<boolean>("isEnterpriseInstall"),
      enterpriseId: this.ctx.storage.kv.get<string>("enterpriseId"),
    };
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

  /**
   * Whether this account can read each subresource (see slackSubresourceId), in order: a workspace
   * when it is one of this account's workspaces, and a conversation when its workspace is and Slack
   * opens the conversation for this account there. An allowed answer is reused for up to
   * SUBRESOURCE_ACCESS_ALLOWED_TTL_MS and a denial for up to SUBRESOURCE_ACCESS_DENIED_TTL_MS,
   * until credentials are next installed. Throws for an ID it can't check, or when access can't be
   * determined, which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    let parsed = new Map(subresources.map(id => [id, parseSlackSubresource(id)] as const));
    let api = new SlackApi(async () => (await this.getAccessToken()).token,
        { installation: () => this.getInstallation() });
    // One client per workspace, whose membership proof (see SlackApi.workspaceTeamId) answers the
    // workspace and is reused by its conversation lookups under the same token.
    let workspaces = new Map<string, { api: SlackApi; allowed: boolean }>();
    for (let { teamId } of parsed.values()) {
      if (workspaces.has(teamId)) continue;
      let teamApi = api.forWorkspace(teamId);
      let allowed = await this.#access.cached(slackSubresourceId({ teamId }), subresourceAccessTtl,
          () => slackAccess(() => teamApi.workspaceTeamId()));
      workspaces.set(teamId, { api: teamApi, allowed });
    }
    // A conversation in a workspace the account is not in is denied without asking about it.
    let conversations = [...parsed].filter(([, { teamId, conversationId }]) =>
        conversationId !== undefined && workspaces.get(teamId)!.allowed);
    let answers = await mapWithConcurrency(conversations, ([id, { teamId, conversationId }]) =>
        this.#access.cached(id, subresourceAccessTtl, () =>
            slackAccess(() => workspaces.get(teamId)!.api.getConversationInfo(conversationId!))));
    let conversationAccess = new Map(conversations.map(([id], index) => [id, answers[index]]));
    return subresources.map(id => {
      let { teamId, conversationId } = parsed.get(id)!;
      return workspaces.get(teamId)!.allowed &&
          (conversationId === undefined || conversationAccess.get(id)!);
    });
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

function accountApi(account: DurableObjectStub<UserAccount>): SlackApi {
  return new SlackApi(createAccessTokenGetter(() => account), {
    installation: () => account.getInstallation(),
  });
}

// Legacy facets did not retain the workspace from their URL. Recover only a known workspace or
// an unambiguous selection, then persist it independently of credentials/reconnects.
async function boundWorkspaceId(
    ctx: DurableObjectState, account: DurableObjectStub<UserAccount>, selected?: string,
    domain?: string): Promise<string> {
  let pinned = ctx.storage.kv.get<string>("boundTeamId");
  if (pinned) return pinned;
  let teamId = selected;
  if (!teamId) {
    let legacyTeam = await account.getTeamId();
    if (isWorkspaceId(legacyTeam)) teamId = legacyTeam;
    else if (domain) teamId = await accountApi(account).workspaceIdForDomain(domain);
    else {
      let workspaces = await accountApi(account).listWorkspaces();
      if (workspaces.length === 1) teamId = workspaces[0].id;
    }
  }
  if (!isWorkspaceId(teamId)) {
    throw new Error("This legacy Slack connection has no unambiguous workspace. Add it again and choose a workspace.");
  }
  // Another concurrent invocation may have completed recovery while the provider calls awaited.
  pinned = ctx.storage.kv.get<string>("boundTeamId");
  if (pinned) return pinned;
  ctx.storage.kv.put("boundTeamId", teamId);
  return teamId;
}

function boundApi(
    ctx: DurableObjectState, account: DurableObjectStub<UserAccount>, teamId?: string,
    domain?: string): SlackApi {
  return new SlackApi(createAccessTokenGetter(() => account), {
    installation: () => account.getInstallation(),
    teamId: () => boundWorkspaceId(ctx, account, teamId, domain),
  });
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
    return accountApi(this.#account());
  }

  async describe(): Promise<AccountDescription> {
    let account = this.#account();
    let userIdPromise = account.getUserId();
    let installationPromise = account.getInstallation();
    let grantedPromise = account.getGrantedResourceUrlPatterns();
    let installation = await installationPromise;
    let description = await this.#api().getAccountDescription(
        await userIdPromise, installation);
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
        teamId: await this.#api().workspaceIdForDomain(parsed.hostname.slice(0, -".slack.com".length)),
        reportsSubresources: true,
      };
      return {
        class: this.ctx.exports.SlackThreadGatekeeperImpl({ props }),
        resource: THREAD_RESOURCE,
      };
    }

    if (parsed.hostname === "app.slack.com" && parsed.pathname.startsWith("/client/")) {
      let segments = parsed.pathname.split("/").filter(Boolean);
      let teamId = decodeURIComponent(segments[1] ?? "");
      if (!isWorkspaceId(teamId)) throw new Error("Select a Slack workspace, not an enterprise.");
      let conversationId = segments[2];
      if (conversationId) {
        let props: SlackConversationGatekeeperImplProps = {
          userObjectId: this.ctx.props.userObjectId,
          conversationId: decodeURIComponent(conversationId),
          teamId,
          reportsSubresources: true,
        };
        return {
          class: this.ctx.exports.SlackConversationGatekeeperImpl({ props }),
          resource: CONVERSATION_RESOURCE,
        };
      }
      let props: SlackWorkspaceGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId, teamId, reportsSubresources: true,
      };
      return {
        class: this.ctx.exports.SlackWorkspaceGatekeeperImpl({ props }),
        resource: WORKSPACE_RESOURCE,
      };
    }

    throw new Error(`Unsupported Slack resource URL: ${url}`);
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    resourceUrlPattern = resourceTypeUrlPattern(await this.getSupportedResources(), resourceUrlPattern);
    if (resourceUrlPattern === WORKSPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new WorkspaceConfiguratorUI(this.#api())),
      };
    }
    if (resourceUrlPattern === CONVERSATION_RESOURCE.urlPattern) {
      return {
        iframeHtml: CONVERSATION_CONFIGURATOR_HTML,
        ui: new RpcStub(new ConversationConfiguratorUI(this.#api())),
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
    let requestedScopes = resourceUrlPatternsToScopes(await account.getResourceUrlPatternsForReconnect());
    await account.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async ensureResources(resourceTypeIds: string[]): Promise<{ url?: string }> {
    let resourceUrlPatterns = resourceTypeIds.map(id => resourceTypeUrlPattern(SUPPORTED_RESOURCES, id));
    let account = this.#account();
    let granted = new Set(await account.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) return {};

    let union = new Set([...await account.getResourceUrlPatternsForReconnect(), ...resourceUrlPatterns]);
    let requestedScopes = resourceUrlPatternsToScopes([...union]);
    let initiationNonce = generateNonce();
    await account.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  /**
   * Mint a verifier representing this account, used by the Slack gatekeepers' verifyObserverAccess
   * and addObserver to confirm a prospective observer may read a workspace or conversation. The
   * verifier carries this user's own account id, so the access checks run against the observer's
   * *own* Slack token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: SlackVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.SlackVerifier({ props });
  }
}

// ── Verifier ────────────────────────────────────────────────────────
//
// Every read reports the workspace or conversations it disclosed (see slackSubresourceId), and
// verifyObserverAccess() asks each observer's checkSubresourceAccess(), which their own
// UserAccount answers with their own token, reusing recent answers:
//   - a workspace: the app is deployed there and the observer belongs to that workspace.
//   - a conversation: that, and conversations.info succeeds for the observer in that workspace.
//     Public channels resolve for any workspace member; private channels, DMs, and group DMs
//     resolve only for members/participants — honoring Slack's ACL. The selected workspace is
//     checked independently because an org token may resolve conversations in several workspaces.
// hasWorkspaceAccess and hasConversationAccess answer the same questions live for addObserver,
// which keeps checking what reads recorded before they reported subresources (see the gatekeeper
// impls). The overseer only ever hands this verifier back to a Slack gatekeeper, which may
// therefore trust the results.

type SlackVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard methods the Slack gatekeepers call on their own verifier (see
 * verifyObserverAccess and addObserver). Not part of the generic GatekeeperUserVerifier contract.
 */
export interface SlackVerifierApi extends GatekeeperUserVerifier {
  hasWorkspaceAccess(teamId: string): Promise<boolean>;
  hasConversationAccess(conversationId: string, teamId: string): Promise<boolean>;
  /**
   * Whether the observer's account can read each subresource, in order, reusing recent answers
   * (see UserAccount.checkSubresourceAccess). Throws for an ID it can't check, or when access
   * can't be determined (expired credentials, a missing scope, a rate limit).
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

@validateRpc()
export class SlackVerifier extends WorkerEntrypoint<Env, SlackVerifierProps>
    implements SlackVerifierApi {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return accountApi(this.#account());
  }

  /**
   * The observer's membership in a selected workspace, or false if their token cannot demonstrate
   * access. The observer is re-checked on their next open.
   */
  async hasWorkspaceAccess(teamId: string): Promise<boolean> {
    try {
      return await this.#api().hasWorkspaceAccess(teamId);
    } catch (error) {
      if (error instanceof SlackApiError && (error.isAuthError || error.isAccessError)) return false;
      throw error;
    }
  }

  async hasConversationAccess(conversationId: string, teamId: string): Promise<boolean> {
    try {
      await this.#api().forWorkspace(teamId).getConversationInfo(conversationId);
      return true;
    } catch (error) {
      if (error instanceof SlackApiError && (error.isAccessError || error.isAuthError)) return false;
      throw error;
    }
  }

  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    return this.#account().checkSubresourceAccess(subresources);
  }
}

// Admits an observer only if their own account can read every subresource, as its UserAccount
// last learned (see UserAccount.checkSubresourceAccess).
const checkSlackSubresourceAccess = observerAccessVerifier({
  hasCollectionAccess: (verifier: Fetcher<SlackVerifierApi>, subresources: readonly string[]) =>
      verifier.checkSubresourceAccess([...subresources]),
});

/**
 * Every Slack binding's verifyObserverAccess(): fails the whole call for an ID no Slack read
 * reports (see slackSubresourceId), before asking any observer, then admits each observer whose
 * own account can read every subresource.
 */
async function verifySlackObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
  for (let id of subresources) parseSlackSubresource(id);
  return checkSlackSubresourceAccess(observers, subresources);
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
};

function dupSessionContext(ctx: SlackSessionContext): SlackSessionContext {
  return { api: ctx.api, approvalQueue: ctx.approvalQueue.dup() };
}

/**
 * Authorize a read, reporting what it disclosed as subresources (see slackSubresourceId): each
 * conversation it listed, matched or read from, or with `"workspace"`, the workspace, for a read
 * that disclosed nothing narrower (workspace metadata, the member directory, a listing or search
 * page naming no conversation). Every read authorizes through here, which makes subresources
 * required; an empty list would report the read as unrestricted, so it is refused.
 */
async function observe(
    ctx: SlackSessionContext, disclosed: readonly string[] | "workspace",
    description: Omit<ObservationDescription, "subresources">): Promise<void> {
  let teamId = await ctx.api.workspaceTeamId();
  let subresources = disclosed === "workspace" ? [slackSubresourceId({ teamId })]
      : [...new Set(disclosed)].map(conversationId => slackSubresourceId({ teamId, conversationId }));
  if (subresources.length === 0) throw new Error("A Slack read must report what it disclosed.");
  await ctx.approvalQueue.authorizeObservation({ ...description, subresources });
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
  teamId?: string;
  /**
   * Set on bindings created since every read reported its subresources, which therefore have no
   * legacy observer history (see getHistoricalSubresources). Absent on older bindings, whose props
   * an earlier version minted.
   */
  reportsSubresources?: true;
};

// Recorded by reads made before they reported subresources: "pending" while an observation
// revealing the conversation was in flight (or after it failed), "observed" once it was
// authorized. Both are legacy history, which nothing writes or clears any longer.
type TrackedConversationState = "pending" | "observed";

@validateRpc()
export class SlackWorkspaceGatekeeperImpl extends DurableObject<Env, SlackWorkspaceGatekeeperImplProps>
    implements Gatekeeper<SlackWorkspaceSession> {

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return boundApi(this.ctx, this.#account(), this.ctx.props.teamId);
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
    return new SlackWorkspaceSessionImpl({ api: this.#api(), approvalQueue: approvalQueue.dup() });
  }

  // ── Observers ─────────────────────────────────────────────────────
  //
  // A workspace binding spans many conversations with distinct ACLs (public/private channels,
  // DMs), so every read reports each conversation it disclosed, or the workspace when it disclosed
  // none (see observe), and verifyObserverAccess() checks the observer's own access to each.
  //
  // Reads made before they reported subresources relied on addObserver() instead: it requires
  // workspace membership (for workspace metadata and the member directory) plus access to every
  // conversation those reads recorded, pending or observed. The overseer still runs it on every
  // open; history export cannot replace it when legacy observations were not recorded.

  #listTrackedConversations(): string[] {
    let prefix = "trackedConversation:";
    return [...this.ctx.storage.kv.list<TrackedConversationState>({ prefix })]
        .map(([key]) => key.slice(prefix.length));
  }

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    let boundTeamId = await this.#api().workspaceTeamId();
    if (!(await verifier.hasWorkspaceAccess(boundTeamId))) {
      throw new Error(
          "This collaborator is not a member of the connected Slack workspace, so they cannot be " +
          "allowed to observe it.");
    }
    let access = await mapWithConcurrency(
        this.#listTrackedConversations(), cid => verifier.hasConversationAccess(cid, boundTeamId));
    if (access.some(hasAccess => !hasAccess)) {
      throw new Error(
          "This collaborator does not have access to a Slack conversation whose data this workspace " +
          "has read, so they cannot be allowed to observe it.");
    }
  }

  /** Drops the verifier an earlier version stored for this observer; none is stored now. */
  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    return verifySlackObserverAccess(observers, subresources);
  }

  /**
   * Export recorded legacy requirements without consulting today's account or changing storage.
   * The old tracker proves a disclosure only when it names a conversation; workspace-only reads
   * and unused bindings left the same state, so an empty tracker cannot prove an empty history.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    if (this.ctx.props.reportsSubresources) return [];
    let conversations = this.#listTrackedConversations();
    if (conversations.length === 0) {
      throw new Error("This Slack binding's legacy observation history was not recorded completely.");
    }
    let teamId = this.ctx.storage.kv.get<string>("boundTeamId") ?? this.ctx.props.teamId;
    if (!isWorkspaceId(teamId)) {
      throw new Error("This Slack binding's historical workspace was not recorded.");
    }
    return [
      slackSubresourceId({ teamId }),
      ...conversations.map(conversationId => slackSubresourceId({ teamId, conversationId })),
    ];
  }

  applyAction(): Promise<void> { return unreachableAction(); }
  rejectAction(): Promise<void> { return unreachableAction(); }
  revertAction(): Promise<void> { return unreachableAction(); }
}

type SlackConversationGatekeeperImplProps = {
  userObjectId: string;
  conversationId: string;
  teamId?: string;
  /** See SlackWorkspaceGatekeeperImplProps.reportsSubresources. */
  reportsSubresources?: true;
};

@validateRpc()
export class SlackConversationGatekeeperImpl
    extends DurableObject<Env, SlackConversationGatekeeperImplProps>
    implements Gatekeeper<SlackConversation> {

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    return boundApi(this.ctx, this.#account(), this.ctx.props.teamId);
  }

  async describe(): Promise<ResourceDescription> {
    let api = this.#api();
    let info = await api.getConversationInfo(this.ctx.props.conversationId);
    let teamId = await api.workspaceTeamId();
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
   * Observer tracking: "ACL check (single unit)". The binding is one conversation, which every
   * read reports (see verifyObserverAccess). Reads made before they did relied on this check
   * instead, so it is kept for them: the observer can read the conversation with their own token
   * (see SlackVerifier). Nothing is tracked and removeObserver is an idempotent no-op.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    let teamId = await this.#api().workspaceTeamId();
    if (!(await verifier.hasConversationAccess(this.ctx.props.conversationId, teamId))) {
      throw new Error(
          "This collaborator does not have access to the connected Slack conversation, so they " +
          "cannot be allowed to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    return verifySlackObserverAccess(observers, subresources);
  }

  /** Legacy reads did not record whether this conversation's data was ever observed. */
  async getHistoricalSubresources(): Promise<string[]> {
    if (this.ctx.props.reportsSubresources) return [];
    throw new Error("This Slack binding's legacy observation history was not recorded completely.");
  }

  applyAction(): Promise<void> { return unreachableAction(); }
  rejectAction(): Promise<void> { return unreachableAction(); }
  revertAction(): Promise<void> { return unreachableAction(); }
}

type SlackThreadGatekeeperImplProps = {
  userObjectId: string;
  conversationId: string;
  threadTs: string;
  permalink: string;
  teamId?: string;
  /** See SlackWorkspaceGatekeeperImplProps.reportsSubresources. */
  reportsSubresources?: true;
};

@validateRpc()
export class SlackThreadGatekeeperImpl extends DurableObject<Env, SlackThreadGatekeeperImplProps>
    implements Gatekeeper<SlackThread> {

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): SlackApi {
    let domain = new URL(this.ctx.props.permalink).hostname.slice(0, -".slack.com".length);
    return boundApi(this.ctx, this.#account(), this.ctx.props.teamId, domain);
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
   * Observer tracking: "ACL check (single unit)". A thread inherits its conversation's ACL, which
   * every read reports (see verifyObserverAccess). Reads made before they did relied on this check
   * instead, so it is kept for them: the observer can read that conversation with their own token
   * (see SlackVerifier). Nothing is tracked and removeObserver is an idempotent no-op.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<SlackVerifierApi>;
    let teamId = await this.#api().workspaceTeamId();
    if (!(await verifier.hasConversationAccess(this.ctx.props.conversationId, teamId))) {
      throw new Error(
          "This collaborator does not have access to the Slack conversation containing this " +
          "thread, so they cannot be allowed to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    return verifySlackObserverAccess(observers, subresources);
  }

  /** Legacy reads did not record whether this thread's data was ever observed. */
  async getHistoricalSubresources(): Promise<string[]> {
    if (this.ctx.props.reportsSubresources) return [];
    throw new Error("This Slack binding's legacy observation history was not recorded completely.");
  }

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
    await observe(this.#ctx, "workspace", {
      title: "Read Slack workspace info",
      description: `Read metadata for the "${info.name}" workspace.`,
    });
    return info;
  }

  #listConversations(
      types: SlackConversationTypeFilter[], title: string): Cursor<SlackConversationEntry> {
    return new SlackCursor<SlackConversationEntry>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.listUserConversations(types, cursor, CONVERSATION_PAGE_SIZE);
      // A page naming no conversation still discloses something about the workspace.
      await observe(ctx, page.items.length > 0 ? page.items.map(info => info.id) : "workspace", {
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
      await observe(ctx, "workspace", {
        title: `List Slack members (${page.items.length})`,
        description: `Read a page of ${page.items.length} workspace members.`,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  async getUser(userId: string): Promise<SlackUser> {
    let user = await this.#ctx.api.getWorkspaceUser(userId);
    await observe(this.#ctx, "workspace", {
      title: `Read Slack user ${user.username}`,
      description: `Read profile for user ${user.username} (${user.id}).`,
    });
    return user;
  }

  async getConversation(conversationId: string): Promise<SlackConversation> {
    let info = await this.#ctx.api.getConversationInfo(conversationId);
    await observe(this.#ctx, [info.id], {
      title: `Open Slack conversation ${info.name ? "#" + info.name : info.id}`,
      description: `Open ${conversationLabel(info)} for reading.`,
    });
    return new SlackConversationImpl(dupSessionContext(this.#ctx), info.id);
  }

  async search(query: string): Promise<Cursor<SlackMessageEntry>> {
    validateSearchQuery(query);
    return new SlackCursor<SlackMessageEntry>(this.#ctx, async (ctx, cursor) => {
      let page = await ctx.api.searchMessages(query, cursor, SEARCH_PAGE_SIZE);
      let channelIds = page.items.map(match => match.channelId);
      await observe(ctx, channelIds.length > 0 ? channelIds : "workspace", {
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
    await observe(this.#ctx, [this.#conversationId], {
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
      await observe(ctx, [conversationId], {
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
      await observe(ctx, [conversationId], {
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
      await observe(ctx, [conversationId], {
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
    await observe(this.#ctx, [this.#conversationId], {
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
    await observe(this.#ctx, [this.#conversationId], {
      title: `Read Slack thread (${messages.length} messages)`,
      description:
          `Read a thread of ${messages.length} messages in conversation ${this.#conversationId}.`,
    });
    return messages.slice(0, MAX_THREAD_REPLIES);
  }
}
