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
//  7. Observer verification — all bindings track independently restricted spaces and content.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ApprovalQueue,
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
} from "@gadgets/workshop-shared/gatekeeper";
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
import { ConfluenceConfiguratorUI } from "./confluence-configurators";
import {
  ConfluenceAccessChecker,
  ConfluenceObserverTracker,
  contentSets,
  spaceSets,
  type ConfluenceObservedSet,
  type ConfluenceVerifierApi,
} from "./confluence-observers";
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
import SITE_CONFIGURATOR_HTML from "./generated/confluence-site-configurator-ui.txt";
import SPACE_CONFIGURATOR_HTML from "./generated/confluence-space-configurator-ui.txt";
import PAGE_CONFIGURATOR_HTML from "./generated/confluence-page-configurator-ui.txt";

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

type StoredNonce = { value: string; expiresAt: number; stage: "initiation" | "oauth" };
type StoredGrant = { accessToken: string; refreshToken?: string; expiresAt: number };

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

const SITE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki",
  title: "Confluence Site",
  description: "Search, browse, and edit any space or page on a Confluence site.",
};
const SPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki/spaces/:spaceKey",
  title: "Confluence Space",
  description: "Read and edit the pages and blog posts in a single Confluence space.",
};
const PAGE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*?",
  title: "Confluence Page or Blog Post",
  description: "Read and edit a specific Confluence page or blog post (and its child pages).",
};
const SUPPORTED_RESOURCES = [SITE_RESOURCE, SPACE_RESOURCE, PAGE_RESOURCE];

const htmlResponse = (body: string): Response =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><body><script>window.close();</script>
<p>Authorization complete. You may close this tab and return to Cloudflare OS.</p></body></html>`;

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
      if (!await stub.acceptAuthCode(code, state.slice(colonIdx + 1))) return htmlResponse(INVALID_LINK_HTML);
      return htmlResponse(SELF_CLOSING_HTML);
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
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation",
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
      value: oauthNonce, expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS, stage: "oauth",
    });
    return { oauthNonce };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Confluence Gatekeeper is not configured.");
    }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete the authorization. Please try again.");

    const grant = await exchangeAuthCode(
      code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");
    this.#storeGrant(grant);
    await this.#refreshSitesAndIdentity(grant.accessToken);

    if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored(new Date(grant.expiresAt));
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }), new Date(grant.expiresAt));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }
    return true;
  }

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

  async refreshCredentials(): Promise<string> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Confluence Gatekeeper is not configured.");
    }
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant?.refreshToken) {
      this.#notifyExpired();
      throw new ConfluenceApiError(401, "Confluence credentials are no longer valid. Please reconnect.");
    }
    try {
      const next = await refreshAccessToken(grant.refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      this.#storeGrant(next); // rotating refresh token: always persist the new one
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsRestored(new Date(next.expiresAt)).catch(() => {});
      return next.accessToken;
    } catch (err) {
      if (err instanceof ConfluenceApiError && (err.isAuthError || err.status === 400 || err.status === 403)) {
        this.#notifyExpired();
      }
      throw err;
    }
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
    const account = this.#userAccount();
    const ui = new ConfluenceConfiguratorUI(
      async () => await account.getSites(),
      async () => await account.getAccessToken(),
    );
    const html =
      resourceUrlPattern === SITE_RESOURCE.urlPattern ? SITE_CONFIGURATOR_HTML
      : resourceUrlPattern === SPACE_RESOURCE.urlPattern ? SPACE_CONFIGURATOR_HTML
      : resourceUrlPattern === PAGE_RESOURCE.urlPattern ? PAGE_CONFIGURATOR_HTML
      : null;
    if (!html) throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    return { iframeHtml: html, ui: new RpcStub(ui) };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
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
  #store() { return new ConfluenceStore(this.ctx.storage.kv, makeApi(this.ctx, this.ctx.props)); }
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

  async getAutoApprovableActions() { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceSiteSession> {
    const identity: AtlassianIdentity | null =
      await accountFor(this.ctx, this.ctx.props.userObjectId).getIdentity();
    return new SiteSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, identity,
      sets => this.#tracker().prepareObservation(sets));
  }

  /**
   * Site membership is the baseline for site metadata/current-user reads. The tracker separately
   * verifies every restricted space and content item revealed through this broad binding.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasSiteAccess(this.ctx.props.cloudId))) {
      throw new Error("This collaborator does not have access to the bound Confluence site.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

  async applyAction(action: number): Promise<void> { await applyStoredAction(this.#store(), action); }
  async rejectAction(action: number) { return rejectStoredAction(this.#store(), action); }
  async revertAction(action: number) { return await revertStoredAction(this.#store(), action); }
}

@validateRpc()
export class ConfluenceSpaceGatekeeperImpl extends DurableObject<Env, SpaceGatekeeperProps>
    implements Gatekeeper<ConfluenceSpaceSession> {
  #store() { return new ConfluenceStore(this.ctx.storage.kv, makeApi(this.ctx, this.ctx.props)); }
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

  async getAutoApprovableActions() { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceSpaceSession> {
    return new SpaceSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, this.ctx.props.spaceKey,
      sets => this.#tracker().prepareObservation(sets));
  }

  /**
   * Space access is the baseline; pages and blog posts are tracked independently because
   * Confluence content restrictions may be narrower than the containing space.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasSpaceAccess(this.ctx.props.cloudId, this.ctx.props.spaceKey))) {
      throw new Error("This collaborator does not have access to the bound Confluence space.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

  async applyAction(action: number): Promise<void> { await applyStoredAction(this.#store(), action); }
  async rejectAction(action: number) { return rejectStoredAction(this.#store(), action); }
  async revertAction(action: number) { return await revertStoredAction(this.#store(), action); }
}

@validateRpc()
export class ConfluenceContentGatekeeperImpl extends DurableObject<Env, ContentGatekeeperProps>
    implements Gatekeeper<ConfluenceContentSession> {
  #store() { return new ConfluenceStore(this.ctx.storage.kv, makeApi(this.ctx, this.ctx.props)); }
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

  async getAutoApprovableActions() { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ConfluenceContentSession> {
    return new ContentSessionImpl(
      this.#store(), approvalQueue.dup(), this.ctx.props.webBase, this.ctx.props.contentId,
      sets => this.#tracker().prepareObservation(sets));
  }

  /**
   * Access to the bound page/blog post is the baseline. Child pages remain tracked sets because a
   * descendant can have stricter restrictions than its parent.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<ConfluenceVerifierApi>;
    if (!(await verifier.hasContentAccess(this.ctx.props.cloudId, this.ctx.props.contentId))) {
      throw new Error("This collaborator does not have access to the bound Confluence content.");
    }
    await this.#tracker().addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> { this.#tracker().removeObserver(id); }

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

// Queue-independent so one hook can be threaded through every sub-session and cursor while the DO
// remains the sole owner of durable observer state.
type ObserveHook = (sets: ConfluenceObservedSet[]) => Promise<{
  excludeObservers?: string[];
  pendingSets: ConfluenceObservedSet[];
  commit(): void;
}>;

// Combines data-set accounting with the existing approval-queue observation. Reads with no
// independently protected set rely only on the binding baseline checked by addObserver().
async function authorizeConfluenceObservation(
  queue: RpcStub<ApprovalQueue>, observe: ObserveHook, sets: ConfluenceObservedSet[],
  description: ObservationDescription,
): Promise<void> {
  const check = sets.length > 0 ? await observe(sets) : { pendingSets: [], commit() {} };
  await queue.authorizeObservation({ ...description, excludeObservers: check.excludeObservers });
  check.commit();
}

// ---------------------------------------------------------------------------------------------
// Sessions

@validateRpc()
class SiteSessionImpl extends RpcTarget implements ConfluenceSiteSession {
  #store: ConfluenceStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #webBase: string;
  #identity: AtlassianIdentity | null;
  #observe: ObserveHook;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string,
    identity: AtlassianIdentity | null, observe: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#identity = identity;
    this.#observe = observe;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  async getMetadata(): Promise<SiteMetadata> {
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, [],
      observation("Read Confluence site info", "Read the connected Confluence site's name and URL."));
    return { name: this.#webBase.replace(/^https?:\/\//, "").replace(/\/wiki$/, ""), url: this.#webBase, cloudId: this.#store.api.cloudId };
  }

  listSpaces(options?: ListSpacesOptions): Promise<Cursor<SpaceSummary>> {
    const limit = clampPageSize(options?.pageSize);
    return Promise.resolve(new PagedCursor<SpaceSummary>(async cursor => {
      const { results, nextCursor } = await this.#store.api.listSpaces({ type: options?.type, cursor, limit });
      await authorizeConfluenceObservation(
        this.#approvalQueue, this.#observe, spaceSets(results.map(s => s.id)),
        observation("List Confluence spaces", "List the spaces on the Confluence site."));
      return { items: results.map(s => spaceToMetadata(s, this.#webBase)), nextCursor };
    }));
  }

  async getSpace(keyOrIdOrUrl: string): Promise<ConfluenceSpaceSession> {
    const ref = parseSpaceKeyOrId(keyOrIdOrUrl);
    // Resolve to the space's key (the session is keyed by key); numeric IDs and URLs are accepted.
    const space = "key" in ref
      ? await this.#store.api.getSpaceByKey(ref.key)
      : await this.#store.api.getSpaceById(ref.id);
    await authorizeConfluenceObservation(
      this.#approvalQueue, this.#observe, spaceSets([space.id]),
      observation("Open Confluence space", "Open a Confluence space."));
    return new SpaceSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, space.key, this.#observe);
  }

  async getContent(idOrUrl: string): Promise<ConfluenceContentSession> {
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, [],
      observation("Open Confluence content", "Open a Confluence page or blog post."));
    const id = resolveHandle(this.#store, idOrUrl);
    if (!ConfluenceStore.isProvisional(id)) await this.#store.getContentResponse(id);
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, id, this.#observe);
  }

  search(options?: SearchOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(searchCursor(this.#store, this.#approvalQueue, this.#observe, options));
  }

  async getCurrentUser(): Promise<ConfluenceUser> {
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, [],
      observation("Read Confluence user", "Read the authorizing Confluence user's profile."));
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
  #observe: ObserveHook;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string, spaceKey: string,
    observe: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#spaceKey = spaceKey;
    this.#observe = observe;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  async getMetadata(): Promise<SpaceMetadata> {
    const space = await this.#store.api.getSpaceByKey(this.#spaceKey);
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, [],
      observation("Read Confluence space", `Read metadata for Confluence space ${this.#spaceKey}.`));
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
      await authorizeConfluenceObservation(
        this.#approvalQueue, this.#observe, contentSets(items.map(item => item.id)), observation(
          `List Confluence ${type === "blogpost" ? "blog posts" : "pages"}`,
          `List the ${type === "blogpost" ? "blog posts" : "pages"} in space ${this.#spaceKey}.`));
      return { items, nextCursor };
    });
  }

  async getContent(idOrUrl: string): Promise<ConfluenceContentSession> {
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, [],
      observation("Open Confluence content", `Open a page or blog post in space ${this.#spaceKey}.`));
    const id = resolveHandle(this.#store, idOrUrl);
    if (!ConfluenceStore.isProvisional(id)) {
      const content = await this.#store.getContentResponse(id);
      if (spaceKeyFromWebui(content._links?.webui) !== this.#spaceKey) {
        throw new ConfluenceApiError(404, "No such page or blog post in this space.");
      }
    }
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, id, this.#observe);
  }

  search(options?: SearchOptions): Promise<Cursor<ContentSummary>> {
    return Promise.resolve(
      searchCursor(this.#store, this.#approvalQueue, this.#observe, options, this.#spaceKey));
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
    });
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, provisionalId, this.#observe);
  }
}

@validateRpc()
class ContentSessionImpl extends RpcTarget implements ConfluenceContentSession {
  #store: ConfluenceStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #webBase: string;
  #contentId: string;
  #observe: ObserveHook;

  constructor(
    store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, webBase: string, contentId: string,
    observe: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#webBase = webBase;
    this.#contentId = contentId;
    this.#observe = observe;
  }

  [Symbol.dispose]() { disposeQueue(this.#approvalQueue); }

  #isProvisional(): boolean { return ConfluenceStore.isProvisional(this.#store.resolveId(this.#contentId)); }
  #pending() { return this.#store.pendingForContent(this.#contentId); }
  #ref(): string { return this.#store.resolveId(this.#contentId); }
  #sets(): ConfluenceObservedSet[] { return contentSets([this.#ref()]); }

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
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
      observation("Read Confluence content", `Read metadata for “${meta.title || "Untitled"}”.`));
    return meta;
  }

  async getContent(): Promise<string> {
    const base = await this.#base();
    const markdown = simulateBody(base ? contentBodyMarkdown(base) : null, this.#pending());
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
      observation("Read Confluence content body", `Read the body of Confluence content ${this.#ref()}.`));
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
      await authorizeConfluenceObservation(
        this.#approvalQueue, this.#observe,
        [...this.#sets(), ...contentSets(items.map(item => item.id))],
        observation("List Confluence child pages", `List the child pages of Confluence content ${this.#ref()}.`));
      return { items, nextCursor };
    }));
  }

  async createChildPage(options: CreateChildPageOptions): Promise<ConfluenceContentSession> {
    if (await this.#kind() === "blogpost") {
      throw new ConfluenceApiError(400, "Blog posts cannot have child pages.");
    }
    const create = this.#store.createActionFor(this.#contentId)?.action;
    const spaceKey = await this.#spaceKey(create);
    const provisionalId = this.#store.nextProvisionalId();
    await this.#stage({
      type: "createContent", provisionalId, kind: "page",
      parent: { type: "page", parentId: this.#contentId, spaceKey },
      title: options.title, content: options.content, status: options.status ?? "current",
    });
    return new ContentSessionImpl(
      this.#store, this.#approvalQueue.dup(), this.#webBase, provisionalId, this.#observe);
  }

  async listLabels(): Promise<string[]> {
    const base = this.#isProvisional() ? [] : await this.#store.api.getLabels(this.#ref(), await this.#kind());
    const labels = simulateLabels(base, this.#pending());
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
      observation("Read Confluence labels", `Read the labels of Confluence content ${this.#ref()}.`));
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
      await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
        observation("Read Confluence comments", `Read the comments on Confluence content ${this.#ref()}.`));
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
      await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
        observation("List Confluence attachments", `List the attachments on Confluence content ${this.#ref()}.`));
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
    await authorizeConfluenceObservation(this.#approvalQueue, this.#observe, this.#sets(),
      observation("Download Confluence attachment", `Download attachment “${info.title}”.`));
    return { filename: info.title, mediaType, data };
  }

  async uploadAttachment(options: UploadAttachmentOptions): Promise<Attachment> {
    await this.#stage({
      type: "uploadAttachment", contentId: this.#contentId,
      filename: options.filename, mediaType: options.mediaType, data: options.data, comment: options.comment,
    });
    // Reflect the pending upload optimistically (it isn't applied until approved). Use a fresh
    // provisional id (like createContent) so concurrent pending uploads don't share one id.
    return { id: this.#store.nextProvisionalId(), title: options.filename, mediaType: options.mediaType,
      fileSize: options.data.byteLength, version: 1, createdAt: new Date() };
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

function searchCursor(
  store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, observe: ObserveHook,
  options: SearchOptions | undefined, spaceKey?: string,
): Cursor<ContentSummary> {
  const limit = clampPageSize(options?.pageSize);
  const cql = buildCql({ text: options?.text, cql: options?.cql, type: options?.type, spaceKey });
  return new PagedCursor<ContentSummary>(async cursor => {
    const { results, nextCursor } = await store.api.search(cql, { cursor, limit });
    const items = overlaySearch(results, store, !cursor, options?.type);
    await authorizeConfluenceObservation(
      approvalQueue, observe, contentSets(items.map(item => item.id)),
      observation("Search Confluence", `Search Confluence for “${options?.cql ?? options?.text ?? ""}”.`));
    return { items, nextCursor };
  });
}
