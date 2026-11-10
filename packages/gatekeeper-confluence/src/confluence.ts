// Confluence (Cloud) gatekeeper.
//
// Provides Gadgets with capability-scoped access to a Confluence site, a single space, or a single
// page/blog post. Auth is Atlassian OAuth 2.0 (3LO) with classic scopes; API calls go through the
// api.atlassian.com gateway. See types.d.ts for the Session API.
//
// Responsibilities:
//  1-3. OAuth/credential management (multi-site, rotating refresh tokens), the v1 REST wrapper, and
//       fine-grained resource granting + configurator UIs.
//  4. Logging & approvals — every observation calls authorizeObservation() before returning; every
//     side effect is staged via submitAction() and only performed in applyAction(). See
//     confluence-actions.ts.
//  5. Caching — content responses are cached in DO storage (short TTL).
//  6. Simulation — reads overlay pending actions so a Gadget sees its own writes immediately.
//  7. Observer verification — every read reports the binding's site, space, or content plus the
//     narrower spaces and content it reveals as subresources; see confluence-subresources.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationDescription,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
  workerVersionTag,
} from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { SingleFlight } from "@gadgets/gatekeeper-kit/single-flight";
import {
  CONFLUENCE_SCOPES,
  ConfluenceApi,
  ConfluenceApiError,
  attachmentBelongsToContent,
  attachmentToAttachment,
  buildCql,
  childPageToSummary,
  classifyConfluenceUrl,
  commentToComment,
  contentBodyMarkdown,
  contentToMetadata,
  contentToSummary,
  exchangeAuthCode,
  getAccessibleResources,
  getAtlassianIdentity,
  parseConfluenceContentId,
  parseSpaceKeyOrId,
  refreshAccessToken,
  spaceKeyFromWebui,
  spaceToMetadata,
  type AccessibleResource,
  type AtlassianIdentity,
  type ContentResponse,
} from "./confluence-api";
import {
  ConfluenceStore,
  applyStoredAction,
  autoApprovableKinds,
  observation,
  overlayChildPages,
  overlaySearch,
  overlaySpaceContent,
  rejectStoredAction,
  revertStoredAction,
  simulateBody,
  simulateComments,
  simulateLabels,
  simulateTitle,
  simulateTrashed,
  stageAction,
  type ConfluenceAction,
  type ContentParent,
} from "./confluence-actions";
import { ConfluenceConfiguratorUI } from "./confluence-configurator";
import {
  ConfluenceAccessChecker,
  ConfluenceObserverTracker,
  contentSets,
  spaceSets,
  type ConfluenceObservedSet,
  type ConfluenceVerifierApi,
} from "./confluence-observers";
import {
  checkConfluenceSubresourceAccess,
  formatConfluenceSubresource,
  observedSetSubresource,
  parseConfluenceSubresource,
  type ConfluenceSubresource,
} from "./confluence-subresources";
import type {
  Attachment,
  AttachmentDownload,
  Comment,
  ConfluenceContent as ConfluenceContentSession,
  ConfluenceSite as ConfluenceSiteSession,
  ConfluenceSpace as ConfluenceSpaceSession,
  ConfluenceUser,
  ContentMetadata,
  ContentSummary,
  CreateBlogPostOptions,
  CreateChildPageOptions,
  CreatePageOptions,
  Cursor,
  ListOptions,
  ListPagesOptions,
  ListSpacesOptions,
  SearchOptions,
  SiteMetadata,
  SpaceMetadata,
  SpaceSummary,
  UploadAttachmentOptions,
} from "./types";
import CONFLUENCE_LOGO_SVG from "./confluence-logo.svg";
import TYPES_CODE from "./types.txt";
import CONFIGURATOR_HTML from "./generated/confluence-configurator-ui.txt";

// ---------------------------------------------------------------------------------------------
// Constants & helpers

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const MAX_ATTACHMENT_DOWNLOAD_BYTES = 16 * 1024;

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

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
/** `scopes` is absent from a grant stored before scopes were recorded, until its next refresh. */
type StoredGrant = { accessToken: string; refreshToken?: string; expiresAt: number; scopes?: string[] };

const getBaseUrl = (env: Env): string => env.BASE_URL || "http://localhost:8787/gatekeeper/confluence";
const getBasePath = (env: Env): string => new URL(getBaseUrl(env)).pathname;

const hexEncode = (bytes: Uint8Array): string =>
  [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const generateNonce = (): string => hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

const CONFLUENCE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(CONFLUENCE_LOGO_SVG)}`;

// One connect card chooses among the three, so the site type, which leads it, is titled for the card.
const SITE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki",
  title: "Confluence",
  description: "A whole Confluence site, one space, or one page or blog post.",
};
const SPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki/spaces/:spaceKey",
  title: "Confluence Space",
  description: "Read and edit the pages and blog posts in a single Confluence space.",
  groupedWith: SITE_RESOURCE.urlPattern,
};
const PAGE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*?",
  title: "Confluence Page or Blog Post",
  description: "Read and edit a specific Confluence page or blog post (and its child pages).",
  groupedWith: SITE_RESOURCE.urlPattern,
};
const SUPPORTED_RESOURCES = [SITE_RESOURCE, SPACE_RESOURCE, PAGE_RESOURCE];

const page = (title: string, color: string, message: string): string => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
<div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
<h1 style="color: ${color}; font-size: 1.5rem;">${title}</h1>
<p style="color: #555; line-height: 1.6;">${message}</p></div></body></html>`;

const INVALID_LINK_HTML = page("Authorization Link Expired", "#d97706",
  "This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.");
const NOT_CONFIGURED_HTML = page("Confluence Gatekeeper Not Configured", "#d97706",
  "Please configure an Atlassian OAuth client ID and secret for this gatekeeper.");

// ---------------------------------------------------------------------------------------------
// HTTP handler — OAuth initiation + completion.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      // Auth initiation: user visited the connect URL.
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(NOT_CONFIGURED_HTML);
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(path[0]));
      const begun = await stub.beginOAuthFlow(path[1]);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML);

      const authUrl = new URL("https://auth.atlassian.com/authorize");
      authUrl.searchParams.set("audience", "api.atlassian.com");
      authUrl.searchParams.set("client_id", env.CLIENT_ID);
      authUrl.searchParams.set("scope", CONFLUENCE_SCOPES.join(" "));
      authUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      authUrl.searchParams.set("state", `${path[0]}:${begun.oauthNonce}`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("prompt", "consent");
      return Response.redirect(authUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) return new Response(`Authorization failed: ${error}`,
        { headers: { "content-type": "text/plain; charset=utf-8" } });
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return new Response("Error: missing 'state' or 'code'",
        { headers: { "content-type": "text/plain; charset=utf-8" } });
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state",
        { headers: { "content-type": "text/plain; charset=utf-8" } });
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(state.slice(0, colonIdx)));
      const handoff = await stub.acceptAuthCode(code, state.slice(colonIdx + 1));
      if (!handoff) return htmlResponse(INVALID_LINK_HTML);
      return htmlResponse(connectHandoffPageHtml(handoff));
    }
    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Confluence",
      url: "https://www.atlassian.com/software/confluence",
      logo: { url: CONFLUENCE_LOGO_URL },
      color: "#deebff",
      tagline: "Read and write your Confluence pages and spaces",
      description:
        "Connect your Atlassian Confluence site to let Cloudflare OS search, read, and edit the pages, " +
        "blog posts, and spaces you share. Build agents that draft documentation, organize " +
        "knowledge bases, or keep pages up to date.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------------------------
// UserAccount DO — OAuth credential management (multi-site, rotating refresh tokens).

export class UserAccount extends DurableObject<Env> {
  // Rotating refresh tokens: concurrent callers (a picker's parallel reads, say) share one refresh,
  // so one new token is stored rather than the last of several.
  readonly #refreshes = new SingleFlight<"refresh">();

  // This account's answers about its own access to Confluence subresources, keyed by subresource
  // and partitioned by the credentials that learned them (see #credentialsId), so an answer can't
  // outlive a disconnect that left storage behind, nor survive a reconnect, which may sign in as
  // another Atlassian account. Bypassed while the account holds no credentials.
  readonly #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the credentials installed now, or undefined while there are none. Every install names
  // its credentials afresh (see #installGrant), a refresh keeps the name, and revoking deletes it
  // with everything else, so no load that started under earlier credentials can find the same name
  // when it finishes. Credentials installed before names existed are named on first use.
  #credentialsId(): string | undefined {
    const kv = this.ctx.storage.kv;
    if (!kv.get<StoredGrant>("grant")) return undefined;
    let id = kv.get<string>("credentialsId");
    if (id === undefined) {
      id = crypto.randomUUID();
      kv.put<string>("credentialsId", id);
    }
    return id;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string) {
    if (!this.ctx.storage.kv.get<StoredGrant>("grant")) {
      this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string) {
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    return { oauthNonce };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Confluence Gatekeeper is not configured.");
    }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete the authorization. Please try again.");

    const grant = await exchangeAuthCode(
      code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      // No expiry is reported: the access token is refreshed transparently from the rotating
      // refresh token, and GatekeeperConnectCallback says not to report a token-cache expiry.
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#installGrant(grant);
      await this.#refreshSitesAndIdentity(grant.accessToken);
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        this.ctx.storage.kv.delete("credentialsId");
        throw err;
      }
    }
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#installGrant(grant);
    await this.#refreshSitesAndIdentity(grant.accessToken);
  }

  // Installs credentials from a connect or a reconnect, which may sign in as another account, so
  // they get a new name (see #credentialsId).
  #installGrant(grant: StoredGrant) {
    this.#storeGrant(grant);
    this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
  }

  // Stores a grant, from an install or a refresh of the same credentials.
  #storeGrant(grant: StoredGrant) {
    this.ctx.storage.kv.put<StoredGrant>("grant", grant);
  }

  async #refreshSitesAndIdentity(token: string) {
    const [sites, identity] = await Promise.all([
      getAccessibleResources(token).catch(() => [] as AccessibleResource[]),
      getAtlassianIdentity(token).catch(() => null),
    ]);
    this.ctx.storage.kv.put<AccessibleResource[]>("sites", sites);
    if (identity) this.ctx.storage.kv.put<AtlassianIdentity>("identity", identity);
  }

  /** Returns a usable access token, refreshing proactively if it is near expiry. */
  async getAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant) throw new ConfluenceApiError(401, "No Confluence credentials set.");
    if (Date.now() >= grant.expiresAt - TOKEN_REFRESH_SKEW_MS) return await this.refreshCredentials();
    return grant.accessToken;
  }

  refreshCredentials(): Promise<string> {
    return this.#refreshes.run("refresh", () => this.#refreshCredentials());
  }

  async #refreshCredentials(): Promise<string> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Confluence Gatekeeper is not configured.");
    }
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant?.refreshToken) {
      this.#notifyExpired();
      throw new ConfluenceApiError(401, "Confluence credentials are no longer valid. Please reconnect.");
    }
    // Named before the request, so a reconnect or revoke that replaces these credentials while it
    // runs is seen when it returns.
    const installed = this.#credentialsId();
    try {
      const next = await refreshAccessToken(grant.refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      // Storing a refresh of replaced credentials would put the old account's tokens under the new
      // installation's name, where the access cache would serve one account's answers to the other.
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) return this.#installedAccessToken();
      this.#storeGrant(next); // rotating refresh token: always persist the new one
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsRestored().catch(() => {});
      return next.accessToken;
    } catch (err) {
      // The credentials that failed to refresh are no longer installed, so their failure says
      // nothing about the ones that are.
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) return this.#installedAccessToken();
      if (err instanceof ConfluenceApiError && (err.isAuthError || err.status === 400 || err.status === 403)) {
        this.#notifyExpired();
      }
      throw err;
    }
  }

  // The installed grant's access token, for a refresh that a reconnect or revoke overtook.
  #installedAccessToken(): string {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant) throw new ConfluenceApiError(401, "No Confluence credentials set.");
    return grant.accessToken;
  }

  #notifyExpired() {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    callback?.credentialsExpired().catch(() => {});
  }

  async getSites(): Promise<AccessibleResource[]> {
    return this.ctx.storage.kv.get<AccessibleResource[]>("sites") ?? [];
  }

  async getIdentity(): Promise<AtlassianIdentity | null> {
    return this.ctx.storage.kv.get<AtlassianIdentity>("identity") ?? null;
  }

  /** The scopes the grant holds, or null for a grant stored before scopes were recorded. */
  async getGrantedScopes(): Promise<string[] | null> {
    return this.ctx.storage.kv.get<StoredGrant>("grant")?.scopes ?? null;
  }

  /**
   * Whether this account can read each Confluence subresource, in order (see
   * checkConfluenceSubresourceAccess). An allowed answer is reused for up to 15 minutes and a
   * denial for up to 15 seconds, until credentials are next installed. Every answer comes from the
   * credentials installed when the check began: a reconnect partway through could otherwise combine
   * one Atlassian account's answers with another's, so it fails the check. Throws for an ID it can't
   * check, or when access can't be determined, which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    const installed = this.#credentialsId();
    const answers = await checkConfluenceSubresourceAccess(this.#access, {
      getToken: () => this.getAccessToken(),
      refresh: () => this.refreshCredentials(),
      api: (cloudId, token) => new ConfluenceApi({
        cloudId, webBase: "", getToken: async () => token, refresh: () => this.refreshCredentials(),
      }),
    }, subresources);
    if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) {
      throw new Error("This collaborator's Confluence connection changed while their access was being checked.");
    }
    return answers;
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<StoredGrant>("grant")) this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------------------------
// UserImpl — resource URL -> gatekeeper class mapping.

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  // Resolve a URL's host to one of the connection's accessible sites.
  async #siteForHost(host: string): Promise<AccessibleResource> {
    const sites = await this.#userAccount().getSites();
    const site = sites.find(s => {
      try { return new URL(s.url).hostname === host; } catch { return false; }
    });
    if (!site) {
      throw new ConfluenceApiError(404,
        `This connection has no access to a Confluence site at ${host}.`);
    }
    return site;
  }

  async describe(): Promise<AccountDescription> {
    const [identity, sites] = await Promise.all([
      this.#userAccount().getIdentity(),
      this.#userAccount().getSites(),
    ]);
    return {
      displayName: identity?.name ?? sites[0]?.name ?? "Confluence",
      uniqueName: identity?.email,
      avatar: { url: identity?.picture ?? sites[0]?.avatarUrl ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Confluence is a data connector, not a sign-in provider (see README for the fast-follow note).
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const classified = classifyConfluenceUrl(url);
    const site = await this.#siteForHost(classified.host);
    const base = { userObjectId: this.ctx.props.userObjectId, cloudId: site.id, webBase: `${site.url}/wiki` };

    if (classified.kind === "content") {
      const props: ContentGatekeeperProps = { ...base, contentId: classified.contentId };
      return { class: this.ctx.exports.ConfluenceContentGatekeeperImpl({ props }), resource: PAGE_RESOURCE };
    }
    if (classified.kind === "space") {
      const props: SpaceGatekeeperProps = { ...base, spaceKey: classified.spaceKey };
      return { class: this.ctx.exports.ConfluenceSpaceGatekeeperImpl({ props }), resource: SPACE_RESOURCE };
    }
    const props: SiteGatekeeperProps = base;
    return { class: this.ctx.exports.ConfluenceSiteGatekeeperImpl({ props }), resource: SITE_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    // The three types share one card, so each starts the same configurator.
    if (!SUPPORTED_RESOURCES.some(resource => resource.urlPattern === resourceUrlPattern)) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    const account = this.#userAccount();
    const ui = new ConfluenceConfiguratorUI({
      getSites: async () => await account.getSites(),
      getGrantedScopes: async () => await account.getGrantedScopes(),
      getToken: async () => await account.getAccessToken(),
      refresh: async () => await account.refreshCredentials(),
    });
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(ui) };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: ConfluenceVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.ConfluenceVerifier({ props });
  }
}

type ConfluenceVerifierProps = { userObjectId: string };

// Persistent verifier entrypoint representing one connected Confluence account. The props identify
// the observer's UserAccount DO, so every access question below is answered with that observer's
// token. The overseer only returns this stub to Confluence gatekeepers.
@validateRpc()
export class ConfluenceVerifier extends WorkerEntrypoint<Env, ConfluenceVerifierProps>
    implements ConfluenceVerifierApi {
  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #checker(): ConfluenceAccessChecker {
    const account = () => this.#account();
    return new ConfluenceAccessChecker(
      async () => await account().getAccessToken(),
      cloudId => new ConfluenceApi({
        cloudId,
        webBase: "",
        getToken: async () => await account().getAccessToken(),
        refresh: async () => await account().refreshCredentials(),
      }),
    );
  }

  hasSiteAccess(cloudId: string): Promise<boolean> {
    return this.#checker().hasSiteAccess(cloudId);
  }

  hasSpaceAccess(cloudId: string, spaceIdOrKey: string): Promise<boolean> {
    return this.#checker().hasSpaceAccess(cloudId, spaceIdOrKey);
  }

  hasContentAccess(cloudId: string, contentId: string): Promise<boolean> {
    return this.#checker().hasContentAccess(cloudId, contentId);
  }

  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    return await this.#account().checkSubresourceAccess(subresources);
  }
}

// Admits an observer only if their own account can read every Confluence resource a binding's
// reads reported, as their UserAccount last learned (see UserAccount.checkSubresourceAccess).
const verifyConfluenceAccess = observerAccessVerifier({
  hasCollectionAccess: (verifier: Fetcher<ConfluenceVerifierApi>, subresources: readonly string[]) =>
    verifier.checkSubresourceAccess([...subresources]),
});

/**
 * Checks each subresource a binding on site `cloudId` is asked about, failing the whole call for an
 * ID that is not a Confluence subresource, names another site, or that `reported` says this
 * binding's reads never report, then asks each observer's account (see verifyConfluenceAccess).
 */
async function verifyBindingAccess(
  observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[], subresources: string[],
  cloudId: string, reported: (resource: ConfluenceSubresource) => boolean,
): Promise<{ allowedObserverIds: string[] }> {
  for (const subresource of subresources) {
    const resource = parseConfluenceSubresource(subresource);
    if (resource.cloudId !== cloudId || !reported(resource)) {
      throw new Error(`This Confluence binding never reports the subresource ${subresource}.`);
    }
  }
  return await verifyConfluenceAccess(observers, subresources);
}

/**
 * A binding's `getHistoricalSubresources()`: the resource its legacy addObserver() checked of every
 * collaborator (`baseline`, the bound site, space, or content), then each space and content item
 * `tracker` recorded, as the subresources reads report them. Reads storage only.
 * @throws Error rather than export an ID that `reported` says this binding's
 * verifyObserverAccess() refuses.
 */
function legacyHistory(
  baseline: ConfluenceSubresource, tracker: ConfluenceObserverTracker,
  reported: (resource: ConfluenceSubresource) => boolean,
): string[] {
  const history = new BindingSubresources(baseline).of(tracker.trackedSets());
  for (const subresource of history) {
    if (!reported(parseConfluenceSubresource(subresource))) {
      throw new Error(`This Confluence binding recorded ${subresource}, which its reads never report.`);
    }
  }
  return history;
}

// ---------------------------------------------------------------------------------------------
// Gatekeeper DO instances.

type BaseProps = { userObjectId: string; cloudId: string; webBase: string };
type SiteGatekeeperProps = BaseProps;
type SpaceGatekeeperProps = BaseProps & { spaceKey: string };
type ContentGatekeeperProps = BaseProps & { contentId: string };

function makeApi(ctx: { exports: Cloudflare.Env }, props: BaseProps): ConfluenceApi {
  const account = () =>
    (ctx.exports as any).UserAccount.get((ctx.exports as any).UserAccount.idFromString(props.userObjectId));
  return new ConfluenceApi({
    cloudId: props.cloudId,
    webBase: props.webBase,
    getToken: async () => await account().getAccessToken(),
    refresh: async () => await account().refreshCredentials(),
  });
}

@validateRpc()
export class ConfluenceSiteGatekeeperImpl extends DurableObject<Env, SiteGatekeeperProps>
    implements Gatekeeper<ConfluenceSiteSession> {
  #store() { return new ConfluenceStore(this.ctx.storage, makeApi(this.ctx, this.ctx.props)); }
  #tracker() { return new ConfluenceObserverTracker(this.ctx.storage.kv, this.ctx.props.cloudId); }

  async describe(): Promise<ResourceDescription> {
    const sites: AccessibleResource[] = await accountFor(this.ctx, this.ctx.props.userObjectId).getSites();
    const site = sites.find(s => s.id === this.ctx.props.cloudId);
    return {
      url: this.ctx.props.webBase,
      title: site ? `${site.name} (Confluence)` : "Confluence site",
      snippet: "Search, browse, and edit content across a Confluence site.",
      suggestedBindingName: "CONFLUENCE_SITE",
      tsType: "ConfluenceSite",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  async getAutoApprovableActions() { return autoApprovableKinds(); }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceSiteSession> {
    const identity: AtlassianIdentity | null =
      await accountFor(this.ctx, this.ctx.props.userObjectId).getIdentity();
    return new SiteSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, identity,
      new BindingSubresources({ kind: "site", cloudId: this.ctx.props.cloudId }));
  }

  /**
   * Site membership was the baseline for site metadata/current-user reads, and the tracker
   * separately verified every restricted space and content item revealed through this broad
   * binding. Every read now reports the site and what it reveals (see BindingSubresources), which
   * the Workshop checks through verifyObserverAccess. This check stays for the reads made before
   * they did, and for the sets those recorded, asking with the observer's own token, now.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasSiteAccess(this.ctx.props.cloudId))) {
      throw new Error("This collaborator does not have access to the bound Confluence site.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

  /**
   * Checks the subresources this binding's reads report, all on the bound site: the site, and the
   * spaces and content they reveal. Fails the whole call for any other ID. An observer is allowed
   * when their own account can read each one (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return await verifyBindingAccess(observers, subresources, this.ctx.props.cloudId, () => true);
  }

  /**
   * The site, which addObserver() required of every collaborator, and each space and content item
   * the legacy tracker recorded, as `site/<cloudId>/space/<spaceId>` and
   * `site/<cloudId>/content/<contentId>`.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    return legacyHistory(
      { kind: "site", cloudId: this.ctx.props.cloudId }, this.#tracker(), () => true);
  }

  async applyAction(action: number): Promise<void> { await applyStoredAction(this.#store(), action); }
  async rejectAction(action: number) { return rejectStoredAction(this.#store(), action); }
  async revertAction(action: number) { return await revertStoredAction(this.#store(), action); }
}

@validateRpc()
export class ConfluenceSpaceGatekeeperImpl extends DurableObject<Env, SpaceGatekeeperProps>
    implements Gatekeeper<ConfluenceSpaceSession> {
  #store() { return new ConfluenceStore(this.ctx.storage, makeApi(this.ctx, this.ctx.props)); }
  #tracker() { return new ConfluenceObserverTracker(this.ctx.storage.kv, this.ctx.props.cloudId); }

  async describe(): Promise<ResourceDescription> {
    const space = await this.#store().api.getSpaceByKey(this.ctx.props.spaceKey);
    return {
      url: `${this.ctx.props.webBase}/spaces/${this.ctx.props.spaceKey}`,
      title: `${space.name} (Confluence space)`,
      snippet: "A single Confluence space.",
      suggestedBindingName: "CONFLUENCE_SPACE",
      tsType: "ConfluenceSpace",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  async getAutoApprovableActions() { return autoApprovableKinds(); }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceSpaceSession> {
    return new SpaceSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, this.ctx.props.spaceKey,
      new BindingSubresources({
        kind: "space", cloudId: this.ctx.props.cloudId, space: this.ctx.props.spaceKey,
      }));
  }

  /**
   * Space access was the baseline; pages and blog posts were tracked independently because
   * Confluence content restrictions may be narrower than the containing space. Every read now
   * reports the space and the content it reveals (see BindingSubresources), which the Workshop
   * checks through verifyObserverAccess. This check stays for the reads made before they did, and
   * for the sets those recorded, asking with the observer's own token, now.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasSpaceAccess(this.ctx.props.cloudId, this.ctx.props.spaceKey))) {
      throw new Error("This collaborator does not have access to the bound Confluence space.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

  /**
   * Checks the subresources this binding's reads report, all on the bound site: the bound space,
   * by key, and the content they reveal. Fails the whole call for any other ID, another space
   * included. An observer is allowed when their own account can read each one (see
   * UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return await verifyBindingAccess(
      observers, subresources, this.ctx.props.cloudId, resource => this.#reports(resource));
  }

  /**
   * The space, by key, which addObserver() required of every collaborator, and each content item
   * the legacy tracker recorded, as `site/<cloudId>/content/<contentId>`.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    return legacyHistory(
      { kind: "space", cloudId: this.ctx.props.cloudId, space: this.ctx.props.spaceKey },
      this.#tracker(), resource => this.#reports(resource));
  }

  // Whether this binding's reads report `resource`, on the bound site: its space or any content.
  #reports(resource: ConfluenceSubresource): boolean {
    return resource.kind === "content" ||
      (resource.kind === "space" && resource.space === this.ctx.props.spaceKey);
  }

  async applyAction(action: number): Promise<void> { await applyStoredAction(this.#store(), action); }
  async rejectAction(action: number) { return rejectStoredAction(this.#store(), action); }
  async revertAction(action: number) { return await revertStoredAction(this.#store(), action); }
}

@validateRpc()
export class ConfluenceContentGatekeeperImpl extends DurableObject<Env, ContentGatekeeperProps>
    implements Gatekeeper<ConfluenceContentSession> {
  #store() { return new ConfluenceStore(this.ctx.storage, makeApi(this.ctx, this.ctx.props)); }
  #tracker() { return new ConfluenceObserverTracker(this.ctx.storage.kv, this.ctx.props.cloudId); }

  async describe(): Promise<ResourceDescription> {
    const content = await this.#store().getContentResponse(this.ctx.props.contentId);
    const meta = contentToMetadata(content, this.ctx.props.webBase);
    return {
      url: meta.url,
      title: meta.title || "Untitled",
      snippet: meta.type === "blogpost" ? "Confluence blog post" : "Confluence page",
      suggestedBindingName: meta.type === "blogpost" ? "CONFLUENCE_BLOG_POST" : "CONFLUENCE_PAGE",
      tsType: "ConfluenceContent",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  async getAutoApprovableActions() { return autoApprovableKinds(); }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceContentSession> {
    return new ContentSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, this.ctx.props.contentId,
      new BindingSubresources({
        kind: "content", cloudId: this.ctx.props.cloudId, contentId: this.ctx.props.contentId,
      }));
  }

  /**
   * Access to the bound page/blog post was the baseline. Child pages were tracked sets because a
   * descendant can have stricter restrictions than its parent. Every read now reports the bound
   * content and the child pages it reveals (see BindingSubresources), which the Workshop checks
   * through verifyObserverAccess. This check stays for the reads made before they did, and for the
   * sets those recorded, asking with the observer's own token, now.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasContentAccess(this.ctx.props.cloudId, this.ctx.props.contentId))) {
      throw new Error("This collaborator does not have access to the bound Confluence content.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

  /**
   * Checks the subresources this binding's reads report, all on the bound site: the bound content
   * and its child pages. Fails the whole call for any other ID. An observer is allowed when their
   * own account can read each one (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return await verifyBindingAccess(observers, subresources, this.ctx.props.cloudId,
      resource => resource.kind === "content");
  }

  /**
   * The content, which addObserver() required of every collaborator, and each child page the
   * legacy tracker recorded, as `site/<cloudId>/content/<contentId>`.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    return legacyHistory(
      { kind: "content", cloudId: this.ctx.props.cloudId, contentId: this.ctx.props.contentId },
      this.#tracker(), resource => resource.kind === "content");
  }

  async applyAction(action: number): Promise<void> { await applyStoredAction(this.#store(), action); }
  async rejectAction(action: number) { return rejectStoredAction(this.#store(), action); }
  async revertAction(action: number) { return await revertStoredAction(this.#store(), action); }
}

function accountFor(ctx: { exports: Cloudflare.Env }, userObjectId: string) {
  return (ctx.exports as any).UserAccount.get((ctx.exports as any).UserAccount.idFromString(userObjectId));
}

// ---------------------------------------------------------------------------------------------
// Cursor

@validateRpc()
class PagedCursor<T> extends RpcTarget implements Cursor<T> {
  // `fetchPage` receives the current opaque cursor (undefined for the first page) and returns the
  // items plus the next cursor (undefined when exhausted).
  #fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>;
  #cursor: string | undefined = undefined;
  #done = false;

  constructor(fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>) {
    super();
    this.#fetchPage = fetchPage;
  }

  async next(): Promise<T[] | null> {
    if (this.#done) return null;
    const { items, nextCursor } = await this.#fetchPage(this.#cursor);
    if (nextCursor) this.#cursor = nextCursor;
    else this.#done = true;
    return items;
  }
}

const clampPageSize = (pageSize: number | undefined): number =>
  pageSize === undefined ? 25 : Math.max(1, Math.min(100, Math.floor(pageSize)));

function disposeQueue(stub: RpcStub<ApprovalQueue>): void {
  (stub as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

/**
 * What a binding's reads report as subresources: on every read, the resource its legacy admission
 * baseline checked (the bound site, space, or content), plus each space or content item the read
 * reveals, named as the legacy tracker records it. Threaded into nested sessions and cursors, so a
 * space or content opened through a site binding still reports the site; a space session opened
 * through it also reports that space on every read (see within). The baseline is formatted up
 * front, so a binding missing the identity it needs fails to start.
 */
class BindingSubresources {
  readonly #baseline: ConfluenceSubresource;
  /** The spaces this one was opened through, which its every read depends on. */
  readonly opened: readonly ConfluenceObservedSet[];
  readonly #required: string[];

  constructor(baseline: ConfluenceSubresource, opened: readonly ConfluenceObservedSet[] = []) {
    this.#baseline = baseline;
    this.opened = opened;
    this.#required = [
      formatConfluenceSubresource(baseline),
      ...opened.map(set => observedSetSubresource(baseline.cloudId, set)),
    ];
  }

  /**
   * The subresources of a session opened on `opened` through this one, whose every read depends
   * on it too, even one revealing nothing narrower.
   */
  within(opened: ConfluenceObservedSet[]): BindingSubresources {
    return new BindingSubresources(this.#baseline, [...this.opened, ...opened]);
  }

  /** The subresources of a read that reveals `revealed`: the baseline first, then each one. */
  of(revealed: ConfluenceObservedSet[]): string[] {
    return [...new Set([
      ...this.#required, ...revealed.map(set => observedSetSubresource(this.#baseline.cloudId, set)),
    ])];
  }
}

/**
 * Authorizes a read with the subresources it depends on (see BindingSubresources). Every read,
 * each cursor page included, authorizes through here, so none can leave them out. Reads no longer
 * feed the legacy tracker (see confluence-observers.ts) or exclude observers.
 */
async function authorizeRead(
  queue: RpcStub<ApprovalQueue>, description: ObservationDescription & { subresources: string[] },
): Promise<void> {
  await queue.authorizeObservation(description);
}

// ---------------------------------------------------------------------------------------------
// Sessions

@validateRpc()
class SiteSessionImpl extends RpcTarget implements ConfluenceSiteSession {
  #store: ConfluenceStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #webBase: string;
  #identity: AtlassianIdentity | null;
  #subresources: BindingSubresources;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string,
    identity: AtlassianIdentity | null, subresources: BindingSubresources,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#identity = identity;
    this.#subresources = subresources;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  async getMetadata(): Promise<SiteMetadata> {
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence site info", "Read the connected Confluence site's name and URL."),
      subresources: this.#subresources.of([]),
    });
    return { name: this.#webBase.replace(/^https?:\/\//, "").replace(/\/wiki$/, ""), url: this.#webBase, cloudId: this.#store.api.cloudId };
  }

  listSpaces(options?: ListSpacesOptions): Promise<Cursor<SpaceSummary>> {
    const limit = clampPageSize(options?.pageSize);
    return Promise.resolve(new PagedCursor<SpaceSummary>(async cursor => {
      const { results, nextCursor } = await this.#store.api.listSpaces({ type: options?.type, cursor, limit });
      await authorizeRead(this.#approvalQueue, {
        ...observation("List Confluence spaces", "List the spaces on the Confluence site."),
        subresources: this.#subresources.of(spaceSets(results.map(s => s.id))),
      });
      return { items: results.map(s => spaceToMetadata(s, this.#webBase)), nextCursor };
    }));
  }

  async getSpace(keyOrIdOrUrl: string): Promise<ConfluenceSpaceSession> {
    const ref = parseSpaceKeyOrId(keyOrIdOrUrl);
    // Resolve to the space's key (the session is keyed by key); numeric IDs and URLs are accepted.
    const space = "key" in ref
      ? await this.#store.api.getSpaceByKey(ref.key)
      : await this.#store.api.getSpaceById(ref.id);
    const subresources = this.#subresources.within(spaceSets([space.id]));
    await authorizeRead(this.#approvalQueue, {
      ...observation("Open Confluence space", "Open a Confluence space."),
      subresources: subresources.of([]),
    });
    // Every read of the session depends on the space, which the site's ACL doesn't cover.
    return new SpaceSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, space.key, subresources);
  }

  async getContent(idOrUrl: string): Promise<ConfluenceContentSession> {
    await authorizeRead(this.#approvalQueue, {
      ...observation("Open Confluence content", "Open a Confluence page or blog post."),
      subresources: this.#subresources.of([]),
    });
    const id = resolveHandle(this.#store, idOrUrl);
    if (!ConfluenceStore.isProvisional(id)) await this.#store.getContentResponse(id);
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, id, this.#subresources);
  }

  search(options?: SearchOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(searchCursor(this.#store, this.#approvalQueue, this.#subresources, options));
  }

  async getCurrentUser(): Promise<ConfluenceUser> {
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence user", "Read the authorizing Confluence user's profile."),
      subresources: this.#subresources.of([]),
    });
    const id = this.#identity;
    return {
      accountId: id?.accountId ?? "unknown",
      displayName: id?.name,
      avatarUrl: id?.picture,
    };
  }
}

@validateRpc()
class SpaceSessionImpl extends RpcTarget implements ConfluenceSpaceSession {
  #store: ConfluenceStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #webBase: string;
  #spaceKey: string;
  #subresources: BindingSubresources;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string, spaceKey: string,
    subresources: BindingSubresources,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#spaceKey = spaceKey;
    this.#subresources = subresources;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  async getMetadata(): Promise<SpaceMetadata> {
    const space = await this.#store.api.getSpaceByKey(this.#spaceKey);
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence space", `Read metadata for Confluence space ${this.#spaceKey}.`),
      subresources: this.#subresources.of([]),
    });
    return spaceToMetadata(space, this.#webBase);
  }

  listPages(options?: ListPagesOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(this.#listContent("page", options?.depth, options?.pageSize));
  }

  listBlogPosts(options?: ListOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(this.#listContent("blogpost", undefined, options?.pageSize));
  }

  #listContent(type: "page" | "blogpost", depth: "root" | "all" | undefined, pageSize?: number): Cursor<ContentSummary> {
    const limit = clampPageSize(pageSize);
    return new PagedCursor<ContentSummary>(async cursor => {
      const spaceId = await this.#store.getSpaceId(this.#spaceKey);
      const { results, nextCursor } = type === "blogpost"
        ? await this.#store.api.listBlogPostsInSpace({ spaceId, cursor, limit })
        : await this.#store.api.listPagesInSpace({ spaceId, depth: depth ?? "root", cursor, limit });
      const items = overlaySpaceContent(
        results.map(c => contentToSummary(c, this.#webBase)), this.#store, this.#spaceKey, type, !cursor);
      await authorizeRead(this.#approvalQueue, {
        ...observation(
          `List Confluence ${type === "blogpost" ? "blog posts" : "pages"}`,
          `List the ${type === "blogpost" ? "blog posts" : "pages"} in space ${this.#spaceKey}.`),
        subresources: this.#subresources.of(revealedSets(this.#store, items.map(item => item.id))),
      });
      return { items, nextCursor };
    });
  }

  async getContent(idOrUrl: string): Promise<ConfluenceContentSession> {
    await authorizeRead(this.#approvalQueue, {
      ...observation("Open Confluence content", `Open a page or blog post in space ${this.#spaceKey}.`),
      subresources: this.#subresources.of([]),
    });
    const id = resolveHandle(this.#store, idOrUrl);
    if (!ConfluenceStore.isProvisional(id)) {
      const content = await this.#store.getContentResponse(id);
      if (spaceKeyFromWebui(content._links?.webui) !== this.#spaceKey) {
        throw new ConfluenceApiError(404, "No such page or blog post in this space.");
      }
    }
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, id, this.#subresources);
  }

  search(options?: SearchOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(
      searchCursor(this.#store, this.#approvalQueue, this.#subresources, options, this.#spaceKey));
  }

  async createPage(options: CreatePageOptions): Promise<ConfluenceContentSession> {
    return this.#create("page", options.title, options.content, options.status, options.parentId);
  }

  async createBlogPost(options: CreateBlogPostOptions): Promise<ConfluenceContentSession> {
    return this.#create("blogpost", options.title, options.content, options.status);
  }

  async #create(
    kind: "page" | "blogpost", title: string, content: string | undefined,
    status: "current" | "draft" | undefined, parentId?: string,
  ): Promise<ConfluenceContentSession> {
    const provisionalId = this.#store.nextProvisionalId();
    const parent: ContentParent = parentId
      ? { type: "page", parentId: resolveHandle(this.#store, parentId), spaceKey: this.#spaceKey }
      : { type: "space", spaceKey: this.#spaceKey };
    await stageAction(this.#store, this.#approvalQueue, {
      type: "createContent", provisionalId, kind, parent, title, content, status: status ?? "current",
      sources: [...this.#subresources.opened],
    });
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, provisionalId, this.#subresources);
  }
}

@validateRpc()
class ContentSessionImpl extends RpcTarget implements ConfluenceContentSession {
  #store: ConfluenceStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #webBase: string;
  #contentId: string;
  #subresources: BindingSubresources;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string, contentId: string,
    subresources: BindingSubresources,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#contentId = contentId;
    this.#subresources = subresources;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  #isProvisional(): boolean { return ConfluenceStore.isProvisional(this.#store.resolveId(this.#contentId)); }
  #pending() { return this.#store.pendingForContent(this.#contentId); }
  #ref(): string { return this.#store.resolveId(this.#contentId); }
  #sets(): ConfluenceObservedSet[] { return revealedSets(this.#store, [this.#contentId]); }

  async #base(): Promise<ContentResponse | null> {
    return this.#isProvisional() ? null : await this.#store.getContentResponse(this.#contentId);
  }

  #stage(action: ConfluenceAction): Promise<number> {
    return stageAction(this.#store, this.#approvalQueue, action);
  }

  async getMetadata(): Promise<ContentMetadata> {
    const records = this.#pending();
    const base = await this.#base();
    let meta: ContentMetadata;
    if (base) {
      meta = contentToMetadata(base, this.#webBase);
    } else {
      const create = this.#store.createActionFor(this.#contentId)?.action;
      const kind = create?.type === "createContent" ? create.kind : "page";
      meta = {
        id: this.#contentId, type: kind, title: "", spaceKey: create?.type === "createContent" ? create.parent.spaceKey : undefined,
        url: `${this.#webBase}/pages/${this.#contentId}`, status: "draft", createdAt: new Date(), lastUpdatedAt: new Date(),
        version: 0, author: null, lastUpdatedBy: null,
      };
    }
    meta.title = simulateTitle(records, meta.title);
    const trashed = simulateTrashed(records);
    if (trashed !== undefined) meta.status = trashed ? "trashed" : "current";
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence content", `Read metadata for “${meta.title || "Untitled"}”.`),
      subresources: this.#subresources.of(this.#sets()),
    });
    return meta;
  }

  async getContent(): Promise<string> {
    const base = await this.#base();
    const markdown = simulateBody(base ? contentBodyMarkdown(base) : null, this.#pending());
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence content body", `Read the body of Confluence content ${this.#ref()}.`),
      subresources: this.#subresources.of(this.#sets()),
    });
    return markdown;
  }

  async setContent(markdown: string): Promise<void> {
    const base = await this.#base();
    const previous = simulateBody(base ? contentBodyMarkdown(base) : null, this.#pending());
    await this.#stage({ type: "setContent", contentId: this.#contentId, markdown, previousMarkdown: previous });
  }

  async appendContent(markdown: string): Promise<void> {
    const base = await this.#base();
    const previous = simulateBody(base ? contentBodyMarkdown(base) : null, this.#pending());
    await this.#stage({ type: "appendContent", contentId: this.#contentId, markdown, previousMarkdown: previous });
  }

  async setTitle(title: string): Promise<void> {
    const records = this.#pending();
    const base = await this.#base();
    const previousTitle = simulateTitle(records, base ? base.title : "");
    await this.#stage({ type: "setTitle", contentId: this.#contentId, title, previousTitle });
  }

  listChildPages(options?: ListOptions): Promise<Cursor<ContentSummary>> {
    const limit = clampPageSize(options?.pageSize);
    return Promise.resolve(new PagedCursor<ContentSummary>(async cursor => {
      let items: ContentSummary[] = [];
      let nextCursor: string | undefined;
      // Only pages have children; a provisional or blog-post target just yields pending creations.
      if (!this.#isProvisional() && await this.#kind() === "page") {
        const spaceKey = spaceKeyFromWebui((await this.#base())?._links?.webui);
        const res = await this.#store.api.listChildPages(this.#ref(), { cursor, limit });
        items = res.results.map(c => childPageToSummary(c, this.#webBase, spaceKey));
        nextCursor = res.nextCursor;
      }
      items = overlayChildPages(items, this.#store, this.#contentId, !cursor);
      await authorizeRead(this.#approvalQueue, {
        ...observation("List Confluence child pages", `List the child pages of Confluence content ${this.#ref()}.`),
        subresources: this.#subresources.of(
          [...this.#sets(), ...revealedSets(this.#store, items.map(item => item.id))]),
      });
      return { items, nextCursor };
    }));
  }

  async createChildPage(options: CreateChildPageOptions): Promise<ConfluenceContentSession> {
    if (await this.#kind() === "blogpost") {
      throw new ConfluenceApiError(400, "Blog posts cannot have child pages.");
    }
    const create = this.#store.createActionFor(this.#contentId)?.action;
    const spaceKey = await this.#spaceKey(create);
    // The description names the parent's space, read from the parent itself.
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence parent page", "Read the space of the page a child page is created under."),
      subresources: this.#subresources.of(this.#sets()),
    });
    const provisionalId = this.#store.nextProvisionalId();
    await this.#stage({
      type: "createContent", provisionalId, kind: "page",
      parent: { type: "page", parentId: this.#contentId, spaceKey },
      title: options.title, content: options.content, status: options.status ?? "current",
      sources: [...new Set([...this.#subresources.opened, ...this.#sets()])],
    });
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, provisionalId, this.#subresources);
  }

  async listLabels(): Promise<string[]> {
    const base = this.#isProvisional() ? [] : await this.#store.api.getLabels(this.#ref(), await this.#kind());
    const labels = simulateLabels(base, this.#pending());
    await authorizeRead(this.#approvalQueue, {
      ...observation("Read Confluence labels", `Read the labels of Confluence content ${this.#ref()}.`),
      subresources: this.#subresources.of(this.#sets()),
    });
    return labels;
  }

  async addLabel(name: string): Promise<void> {
    await this.#stage({ type: "addLabel", contentId: this.#contentId, name });
  }

  async removeLabel(name: string): Promise<void> {
    await this.#stage({ type: "removeLabel", contentId: this.#contentId, name });
  }

  listComments(options?: ListOptions): Promise<Cursor<Comment>> {
    const limit = clampPageSize(options?.pageSize);
    return Promise.resolve(new PagedCursor<Comment>(async cursor => {
      let items: Comment[] = [];
      let nextCursor: string | undefined;
      if (!this.#isProvisional()) {
        const res = await this.#store.api.listComments(this.#ref(), await this.#kind(), { cursor, limit });
        items = res.results.map(c => commentToComment(c, this.#webBase));
        nextCursor = res.nextCursor;
      }
      if (!cursor) items = simulateComments(items, this.#pending());
      await authorizeRead(this.#approvalQueue, {
        ...observation("Read Confluence comments", `Read the comments on Confluence content ${this.#ref()}.`),
        subresources: this.#subresources.of(this.#sets()),
      });
      return { items, nextCursor };
    }));
  }

  async addComment(markdown: string): Promise<void> {
    await this.#stage({ type: "addComment", contentId: this.#contentId, text: markdown });
  }

  listAttachments(options?: ListOptions): Promise<Cursor<Attachment>> {
    const limit = clampPageSize(options?.pageSize);
    return Promise.resolve(new PagedCursor<Attachment>(async cursor => {
      const res = this.#isProvisional()
        ? { results: [], nextCursor: undefined }
        : await this.#store.api.listAttachments(this.#ref(), await this.#kind(), { cursor, limit });
      await authorizeRead(this.#approvalQueue, {
        ...observation("List Confluence attachments", `List the attachments on Confluence content ${this.#ref()}.`),
        subresources: this.#subresources.of(this.#sets()),
      });
      return { items: res.results.map(attachmentToAttachment), nextCursor: res.nextCursor };
    }));
  }

  async downloadAttachment(id: string): Promise<AttachmentDownload> {
    const info = await this.#store.api.getAttachmentInfo(id);
    // Enforce the capability's grant boundary: the attachment must belong to this content. Normalize
    // a foreign/missing attachment to the same 404 so this can't probe other content's attachments.
    if (!attachmentBelongsToContent(info, this.#ref())) {
      throw new ConfluenceApiError(404, "No such attachment on this content.");
    }
    const size = info.fileSize;
    if (size !== undefined && size > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
      throw new ConfluenceApiError(413,
        `Attachment is ${size} bytes, exceeding the ${MAX_ATTACHMENT_DOWNLOAD_BYTES}-byte download limit.`);
    }
    const downloadPath = info.downloadLink ?? info._links?.download;
    if (!downloadPath) throw new ConfluenceApiError(404, "Attachment has no downloadable content.");
    // Confluence-sourced, but guard the "/wiki" prefix concatenation against a non-relative path.
    if (!downloadPath.startsWith("/")) throw new ConfluenceApiError(502, "Malformed attachment download link.");
    const { data, mediaType } = await this.#store.api.downloadAttachment(downloadPath);
    if (data.byteLength > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
      throw new ConfluenceApiError(413,
        `Attachment is ${data.byteLength} bytes, exceeding the ${MAX_ATTACHMENT_DOWNLOAD_BYTES}-byte download limit.`);
    }
    await authorizeRead(this.#approvalQueue, {
      ...observation("Download Confluence attachment", `Download attachment “${info.title}”.`),
      subresources: this.#subresources.of(this.#sets()),
    });
    return { filename: info.title, mediaType, data };
  }

  async uploadAttachment(options: UploadAttachmentOptions): Promise<Attachment> {
    // Staging deletes the action, and its file with it, if approval submission fails.
    const file = await this.#store.captureAttachment(options.data);
    await this.#stage({
      type: "uploadAttachment", contentId: this.#contentId,
      filename: options.filename, mediaType: options.mediaType, file, comment: options.comment,
    });
    // Reflect the pending upload optimistically (it isn't applied until approved). Use a fresh
    // provisional id (like createContent) so concurrent pending uploads don't share one id.
    return { id: this.#store.nextProvisionalId(), title: options.filename, mediaType: options.mediaType,
      fileSize: file.size, version: 1, createdAt: new Date() };
  }

  async trash(): Promise<void> {
    await this.#stage({ type: "trash", contentId: this.#contentId });
  }

  async restore(): Promise<void> {
    await this.#stage({ type: "restore", contentId: this.#contentId });
  }

  // The content kind (page/blogpost), from a pending creation or the fetched response.
  async #kind(): Promise<"page" | "blogpost"> {
    const create = this.#store.createActionFor(this.#contentId)?.action;
    if (create?.type === "createContent") return create.kind;
    const content = await this.#store.getContentResponse(this.#contentId);
    return content.type === "blogpost" ? "blogpost" : "page";
  }

  async #spaceKey(create: ConfluenceAction | undefined): Promise<string> {
    if (create?.type === "createContent" && create.parent.spaceKey) return create.parent.spaceKey;
    const content = await this.#store.getContentResponse(this.#contentId);
    return spaceKeyFromWebui(content._links?.webui) ?? "";
  }
}

// Resolve a user-supplied content handle (provisional ID, numeric ID, or URL) to a stored handle.
function resolveHandle(store: ConfluenceStore, idOrUrl: string): string {
  if (ConfluenceStore.isProvisional(idOrUrl)) {
    if (!store.knowsProvisional(idOrUrl)) throw new ConfluenceApiError(404, "No such content.");
    return idOrUrl;
  }
  return parseConfluenceContentId(idOrUrl);
}

/**
 * What a read showing the content `ids` reveals: each page or blog post Confluence holds, and for a
 * pending creation, the sources its creation recorded. The staged content is the gadget's own, but
 * the space key it shows was read from those, and a session reaching it by its handle, a listing
 * or a search may never have read them.
 */
function revealedSets(store: ConfluenceStore, ids: string[]): ConfluenceObservedSet[] {
  return [...new Set(ids.flatMap(id => {
    const ref = store.resolveId(id);
    if (!ConfluenceStore.isProvisional(ref)) return contentSets([ref]);
    const create = store.createActionFor(id)?.action;
    return create?.type === "createContent" ? create.sources ?? [] : [];
  }))];
}

function searchCursor(
  store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, subresources: BindingSubresources,
  options: SearchOptions | undefined, spaceKey?: string,
): Cursor<ContentSummary> {
  const limit = clampPageSize(options?.pageSize);
  const cql = buildCql({ text: options?.text, cql: options?.cql, type: options?.type, spaceKey });
  return new PagedCursor<ContentSummary>(async cursor => {
    const { results, nextCursor } = await store.api.search(cql, { cursor, limit });
    const items = overlaySearch(results, store, !cursor, options?.type);
    await authorizeRead(approvalQueue, {
      ...observation("Search Confluence", `Search Confluence for “${options?.cql ?? options?.text ?? ""}”.`),
      subresources: subresources.of(revealedSets(store, items.map(item => item.id))),
    });
    return { items, nextCursor };
  });
}
