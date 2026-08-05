import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ZoomInfoApi,
  ZoomInfoApiError,
  deriveCodeChallenge,
  exchangeAuthCode,
  generateCodeVerifier,
  refreshAccessToken,
  resolveOAuthConfig,
  type JsonApiDoc,
  type JsonApiResource,
  type QueryParams,
} from "./zoominfo-api";
import type {
  AccountSummary,
  CompanyEnrichInput,
  CompanyHashtag,
  CompanyInsightsCriteria,
  CompanyInsights,
  CompanyLookalike,
  CompanyMatch,
  CompanyOutputField,
  CompanyRecord,
  CompanyRefInput,
  CompanySearchCriteria,
  ContactEnrichInput,
  ContactLookalike,
  ContactLookalikesCriteria,
  ContactMatch,
  ContactOutputField,
  ContactRecommendation,
  ContactRecommendationsCriteria,
  ContactRecord,
  ContactSearchCriteria,
  CorporateHierarchyOutputField,
  CorporateHierarchyRecord,
  CreditUsage,
  EnrichEntity,
  EnrichFieldInfo,
  EnrichMatchStatus,
  EnrichmentKind,
  EnrichmentOutcome,
  EnrichmentTicket,
  EnrichResult,
  Insight,
  IntentEnrichCriteria,
  IntentSearchCriteria,
  IntentSignal,
  LookupFieldName,
  LookupFilters,
  LookupValue,
  NewsArticle,
  NewsEnrichCriteria,
  NewsSearchCriteria,
  PageRequest,
  Scoop,
  ScoopEnrichCriteria,
  ScoopSearchCriteria,
  SearchPage,
  SimilarCompaniesCriteria,
  UsageLimit,
  ZoomInfoSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import ZOOMINFO_LOGO_SVG from "./zoominfo-logo.svg";
import ZOOMINFO_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { ZoomInfoAccountConfiguratorRpc } from "./configurator/account-configurator-types";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  ZOOMINFO_AUTHORIZE_URL?: string;
  ZOOMINFO_TOKEN_URL?: string;
  ZOOMINFO_API_BASE_URL?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type StoredIdentity = {
  displayName?: string;
  uniqueName?: string;
};

type ZoomInfoGatekeeperImplProps = {
  userObjectId: string;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
// Lookup taxonomies (industries, job functions, intent topics, entitled enrich fields, …) are
// effectively static reference data, so we cache them per account binding for a day to avoid
// re-fetching on every search. Dynamic reads (search/insights/summaries) are intentionally uncached.
const LOOKUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Full scope set requested at connect: ZoomInfo has no separately-grantable resources here, so we
// request everything this gatekeeper's session can use. The account's package entitlements are the
// real authority — unentitled scopes simply yield empty/forbidden results per call.
//
// These are the only scopes ZoomInfo's authorization server recognizes (verified against the live
// authorize endpoint; unknown scope names — including a would-be `api:data:lookup`, and even
// standard `openid`/`offline_access` — are rejected with `invalid_scope`). Lookup/enrich-field
// reference data has no dedicated scope; access to it comes with the data scopes above.
const OAUTH_SCOPES = [
  "api:data:company",
  "api:data:contact",
  "api:data:intent",
  "api:data:news",
  "api:data:scoops",
  "api:recommendations:read",
  "api:account-summary:read",
  "api:insights:read",
];

const ZOOMINFO_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(ZOOMINFO_LOGO_SVG)}`;

// Whole-account catch-all resource (matches any URL), like other single-tenant gatekeepers.
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "ZoomInfo Account",
  description:
    "Whole-account access: lookup, company/contact/intent/scoop/news search, record enrichment " +
    "(consumes credits), recommendations, and account intelligence — subject to entitlements.",
  icon: { url: ZOOMINFO_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

// Canonical URL for the connected account. ZoomInfo has no per-user public profile URL, so we use
// the app home; the binding is whole-account regardless.
const ACCOUNT_URL = "https://app.zoominfo.com/";

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #EE3524; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #EE3524; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #EE3524; font-size: 1.5rem; margin: 0 0 1rem 0;">ZoomInfo Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a ZoomInfo OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // Both values are fixed-length random hex nonces, so length carries no secret.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/zoominfo");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function ensureConfigured(env: Env): asserts env is Env & { CLIENT_ID: string; CLIENT_SECRET: string } {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The ZoomInfo gatekeeper is not configured.");
  }
}

// Best-effort decode of an OIDC ID token's claims (no signature check — it came straight from the
// token endpoint over TLS). Used only to give the connected account a friendly display name.
function parseIdTokenClaims(idToken: string | null): StoredIdentity {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(payload)) as {
      name?: string;
      email?: string;
      preferred_username?: string;
      sub?: string;
    };
    return {
      displayName: json.name || json.email || json.preferred_username,
      uniqueName: json.email || json.preferred_username || json.sub,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth (Authorization Code + PKCE) flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Auth initiation: /<doId>/<initiationNonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const oauth = resolveOAuthConfig(env);
      const redirectUrl = new URL(oauth.authorizeUrl);
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      redirectUrl.searchParams.set("code_challenge", begun.codeChallenge);
      redirectUrl.searchParams.set("code_challenge_method", "S256");
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(
          "ZoomInfo authorization failed or was denied. Please restart the connection flow from Cloudflare OS.",
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const accepted = await stub.acceptAuthCode(code, oauthNonce);
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "ZoomInfo",
      url: "https://www.zoominfo.com",
      logo: { url: ZOOMINFO_LOGO_URL },
      color: "#EE3524",
      tagline: "Search and enrich B2B company & contact intelligence",
      description:
        "Connect your ZoomInfo account so Cloudflare OS can resolve filter values, search companies, " +
        "contacts, intent signals, scoops, and news, and enrich matched records into full detail. " +
        "Search is free; enrichment consumes ZoomInfo credits. Build agents that assemble target " +
        "account lists, research accounts, and prioritize outreach on buying signals.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
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

// ---------------------------------------------------------------------------
// UserAccount DO — stores OAuth credentials, performs PKCE token exchange, and refreshes access
// tokens (persisting rotated refresh tokens).

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Verify the initiation nonce, then mint the PKCE pair for the authorize redirect. The
  // code_verifier is stored server-side (never leaves the DO) and consumed at token exchange.
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    this.ctx.storage.kv.put("codeVerifier", codeVerifier);
    return { oauthNonce, codeChallenge };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    const codeVerifier = this.ctx.storage.kv.get<string>("codeVerifier");
    if (!codeVerifier) return false;
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("codeVerifier");

    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const oauth = resolveOAuthConfig(this.env);
    const grant = await exchangeAuthCode(
      code,
      codeVerifier,
      `${getBaseUrl(this.env)}/oauth`,
      this.env.CLIENT_ID,
      this.env.CLIENT_SECRET,
      oauth.tokenUrl,
    );
    if (!grant.refreshToken) {
      throw new Error("ZoomInfo did not return a refresh token.");
    }

    this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    this.ctx.storage.kv.put("scopes", grant.scopes);
    this.ctx.storage.kv.put<StoredIdentity>("identity", parseIdTokenClaims(grant.idToken));
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: ZoomInfoGatekeeperImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("accessToken");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (token && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) {
      return token;
    }

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("ZoomInfo credentials have not been configured for this account.");
    }
    ensureConfigured(this.env);
    const oauth = resolveOAuthConfig(this.env);

    let grant;
    try {
      grant = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET, oauth.tokenUrl);
    } catch (err) {
      if (err instanceof ZoomInfoApiError && (err.isAuthError || err.status === 400)) {
        await this.noteCredentialsExpired();
      }
      throw err;
    }

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    // ZoomInfo rotates refresh tokens: always persist the new one and drop the consumed one.
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("scopes", grant.scopes);
    return grant.accessToken;
  }

  async getIdentity(): Promise<StoredIdentity> {
    return this.ctx.storage.kv.get<StoredIdentity>("identity") ?? {};
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // ZoomInfo exposes no token-revocation endpoint; drop the local credentials. The user can
    // revoke the app's access from their ZoomInfo admin settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#userAccount().getIdentity();
    return {
      displayName: identity.displayName ?? identity.uniqueName ?? "ZoomInfo Account",
      uniqueName: identity.uniqueName,
      avatar: { url: ZOOMINFO_LOGO_URL },
    };
  }

  // ZoomInfo is not offered as a sign-in identity provider.
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const props: ZoomInfoGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return { class: this.ctx.exports.ZoomInfoGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported ZoomInfo resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: ZOOMINFO_ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new ZoomInfoAccountConfiguratorUI()),
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  // ZoomInfo uses the private-only observer strategy. The verifier is never consulted, but the
  // overseer mints one on every collaborator open, so getVerifier must still return a valid stub.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ZoomInfoVerifier({});
  }
}

// A trivial verifier since ZoomInfoGatekeeperImpl refuses all non-owner observers.
@validateRpc()
export class ZoomInfoVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — whole-account has no inputs; just reports the canonical URL.

class ZoomInfoAccountConfiguratorUI extends RpcTarget implements ZoomInfoAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return ACCOUNT_URL;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl — per-Gadget binding to the connected account.

@validateRpc()
export class ZoomInfoGatekeeperImpl extends DurableObject<Env, ZoomInfoGatekeeperImplProps>
  implements Gatekeeper<ZoomInfoSession> {

  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<ResourceDescription> {
    const identity = await this.#userAccount().getIdentity();
    const title = identity.displayName ? `${identity.displayName}'s ZoomInfo` : "ZoomInfo Account";
    return {
      url: ACCOUNT_URL,
      title,
      snippet:
        "Whole-account access: lookup, search (companies, contacts, intent, scoops, news), " +
        "enrichment (consumes credits), recommendations, and account intelligence.",
      suggestedBindingName: "ZOOMINFO",
      tsType: "ZoomInfoSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  #makeApi(account: DurableObjectStub<UserAccount>): ZoomInfoApi {
    return new ZoomInfoApi(() => account.getAccessToken(), resolveOAuthConfig(this.env).apiBaseUrl);
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ZoomInfoSession> {
    return new ZoomInfoSessionImpl(
      this.#userAccount(), approvalQueue.dup(), resolveOAuthConfig(this.env).apiBaseUrl, this.ctx.storage.kv);
  }

  // Approved: replay the queued enrichment against ZoomInfo (spending credits) and store the result
  // for the Gadget to read via getEnrichmentResult(). A ZoomInfo failure is recorded as a "failed"
  // outcome rather than re-thrown: the action is considered resolved (we don't want the overseer to
  // retry a paid operation that may have already charged credits), and the Gadget sees the failure.
  async applyAction(action: number): Promise<void> {
    const store = new EnrichmentStore(this.ctx.storage.kv);
    const pending = store.getPending(action);
    if (!pending) {
      throw new Error(`Unknown pending ZoomInfo enrichment: ${action}`);
    }
    const account = this.#userAccount();
    try {
      const result = await callZoomInfo(account, () => performEnrichment(this.#makeApi(account), pending));
      store.putResult(action, { status: "ready", result });
    } catch (error) {
      store.putResult(action, {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    store.removePending(action);
  }

  // Rejected: discard the queued enrichment (no credits spent) and record the outcome.
  async rejectAction(action: number): Promise<void> {
    const store = new EnrichmentStore(this.ctx.storage.kv);
    store.removePending(action);
    store.putResult(action, { status: "rejected" });
  }

  // Enrichment isn't revertable: spent credits can't be refunded. submitAction sets
  // implementsRevert: false, so this is not normally reached; we drop the stored result defensively.
  async revertAction(action: number): Promise<void | { message?: string; canRetry?: boolean }> {
    new EnrichmentStore(this.ctx.storage.kv).removeResult(action);
    return {
      message:
          "Enrichment can't be reverted: any ZoomInfo credits spent are not refundable. The " +
          "retrieved data has been discarded from this Gadget.",
    };
  }

  // Observer tracking — strategy A (private-only). This whole-account binding exposes licensed,
  // entitlement-dependent data and account-specific intelligence, and ZoomInfo provides no ACL
  // oracle that can prove another account could read every historical result.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "ZoomInfo data cannot be shared with other users: this workspace's ZoomInfo account may only " +
      "be observed by its owner.",
    );
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Mapping helpers

function asResources(doc: JsonApiDoc): JsonApiResource[] {
  if (Array.isArray(doc.data)) return doc.data;
  return doc.data ? [doc.data] : [];
}

function firstResource(doc: JsonApiDoc): JsonApiResource | null {
  const resources = asResources(doc);
  return resources[0] ?? null;
}

function attrs(resource: JsonApiResource): Record<string, unknown> {
  return resource.attributes ?? {};
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Coerce an id-like value to a number when it is a numeric string (ZoomInfo expects int64 ids in
// enrich/insight inputs), leaving non-numeric values untouched.
function idValue(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(Number(value)) && value.trim() !== "" ? Number(value) : value;
}

// Drop undefined entries so we don't send empty attribute keys. Generic so callers keep their
// narrow value types (e.g. a query-param bag stays assignable to QueryParams).
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// Intent- and scoop-signal search filter by firmographics only; ZoomInfo rejects company-identity
// inputs there with an opaque "Invalid field requested" 400. The typed API omits these fields (see
// SignalCompanyFilters), but RPC arguments are plain JSON at runtime, so guard against a force-sent
// identity field and fail with an actionable message pointing at the enrich variant.
const SIGNAL_COMPANY_IDENTITY_FIELDS = ["companyId", "companyName", "companyWebsite"] as const;
function assertNoCompanyIdentity(
  company: Record<string, unknown> | undefined,
  searchMethod: string,
  enrichMethod: string,
): void {
  const offending = SIGNAL_COMPANY_IDENTITY_FIELDS.filter(f => company?.[f] !== undefined);
  if (offending.length > 0) {
    throw new Error(
      `${offending.join(", ")} ${offending.length === 1 ? "is" : "are"} not supported by ` +
        `${searchMethod} — it filters by firmographics only, not company identity. Use ` +
        `${enrichMethod} to retrieve signals for a specific company.`,
    );
  }
}

// ZoomInfo's `state` values are US/Canada regions, so a `state` filter already scopes to that
// country. When `state` and `country` are supplied together ZoomInfo silently ignores `state` and
// broadens the results to the whole country — returning wrong data with no error. Rather than let
// that pass quietly, reject the combination up front so the caller keeps exactly one location
// filter. Applies to every company-filter bag (flat for company search, nested for the others).
function assertCompatibleLocation(company: Record<string, unknown> | undefined, method: string): void {
  if (company?.state !== undefined && company?.country !== undefined) {
    throw new Error(
      `${method}: \`state\` and \`country\` cannot be combined — ZoomInfo ignores \`state\` when ` +
        `\`country\` is also set and returns the whole country. Pass just \`state\` (it already ` +
        `scopes to the US/Canada) or just \`country\`.`,
    );
  }
}

function pageQuery(page?: PageRequest): QueryParams {
  const query: QueryParams = {};
  if (page?.page !== undefined) query["page[number]"] = page.page;
  if (page?.pageSize !== undefined) query["page[size]"] = page.pageSize;
  if (page?.sort !== undefined) query["sort"] = page.sort;
  return query;
}

function toSearchPage<T>(doc: JsonApiDoc, map: (r: JsonApiResource) => T, page?: PageRequest): SearchPage<T> {
  const results = asResources(doc).map(map);
  const pageNumber = doc.meta?.page?.number ?? page?.page ?? 1;
  const pageSize = page?.pageSize ?? 25;
  const totalResults = doc.meta?.totalResults ?? results.length;
  const hasMore = doc.links?.next !== undefined || pageNumber * pageSize < totalResults;
  return { results, totalResults, page: pageNumber, pageSize, hasMore };
}

const MATCHED_STATUSES = new Set<EnrichMatchStatus>(["FULL_MATCH", "COMPANY_ONLY_MATCH", "CONTACT_ONLY_MATCH"]);
const ERROR_STATUSES = new Set<EnrichMatchStatus>(["INVALID_INPUT", "LIMIT_EXCEEDED"]);

function mapEnrichResult<T>(resource: JsonApiResource, buildRecord: (r: JsonApiResource) => T): EnrichResult<T> {
  const meta = (resource.meta ?? {}) as { matchStatus?: EnrichMatchStatus; input?: unknown };
  const matchStatus: EnrichMatchStatus =
    meta.matchStatus ?? (resource.type === "NoMatch" ? "NO_MATCH" : "FULL_MATCH");

  if (ERROR_STATUSES.has(matchStatus)) {
    return { status: "error", input: meta.input, message: matchStatus };
  }
  const hasRecord = resource.type !== "NoMatch" && resource.attributes !== undefined &&
    MATCHED_STATUSES.has(matchStatus);
  if (!hasRecord) {
    return { status: "noMatch", matchStatus, input: meta.input };
  }
  // Best-effort: if ZoomInfo tells us the record is already under management, no credit was charged;
  // otherwise assume a credit was charged (worst case).
  const managementStatus = (resource.attributes as { managementStatus?: { underManagement?: boolean } })
    ?.managementStatus;
  const creditCharged = managementStatus?.underManagement !== true;
  return { status: "matched", matchStatus, record: buildRecord(resource), creditCharged };
}

// Run a ZoomInfo API call, translating auth failures into a reconnect-prompting error and notifying
// the account so the user is asked to reconnect. Shared by the session (reads) and applyAction
// (approved enrichments).
async function callZoomInfo<T>(account: DurableObjectStub<UserAccount>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ZoomInfoApiError && error.isAuthError) {
      await account.noteCredentialsExpired();
      throw new Error("ZoomInfo credentials have expired or been revoked. Please reconnect the account.", {
        cause: error,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Enrichment action queue.
//
// Each enrich* call stores a PendingEnrichment and submits it for approval. When the user approves,
// ZoomInfoGatekeeperImpl.applyAction() replays it against the API (spending credits) and stores the
// result; the Gadget reads it back via getEnrichmentResult(). Rejection stores a "rejected" outcome
// and spends nothing. Everything lives in the GatekeeperImpl DO's KV, shared by the session (which
// submits/reads) and the apply/reject callbacks.

// How many recent enrichment outcomes to retain per connected account. Enough that a Gadget can
// still read back results from earlier in a session, while capping the DO's KV footprint (each
// outcome is small and gated behind a human approval, so this window is generous).
const MAX_RETAINED_ENRICHMENTS = 100;

// A cached value with the time it was fetched, for TTL expiry.
type CachedValue<T> = { value: T; fetchedAt: number };

// A submitted-but-not-yet-applied enrichment: enough to replay the ZoomInfo call on approval.
type PendingEnrichment = {
  kind: EnrichmentKind;
  summary: string;
  attributes: Record<string, unknown>;
  page?: PageRequest;
};

// The stored outcome once the user has decided (mirrors EnrichmentOutcome minus the "pending" state,
// which is represented by the absence of a stored outcome while the request is still pending).
type StoredEnrichmentOutcome =
  | { status: "ready"; result: unknown }
  | { status: "rejected" }
  | { status: "failed"; message: string };

class EnrichmentStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #pendingKey(id: number): string {
    return `enrich:pending:${id}`;
  }

  #resultKey(id: number): string {
    return `enrich:result:${id}`;
  }

  submit(pending: PendingEnrichment): number {
    const id = this.#kv.get<number>("enrich:nextId") ?? 1;
    this.#kv.put("enrich:nextId", id + 1);
    this.#kv.put(this.#pendingKey(id), pending);
    return id;
  }

  getPending(id: number): PendingEnrichment | undefined {
    return this.#kv.get<PendingEnrichment>(this.#pendingKey(id));
  }

  removePending(id: number): void {
    this.#kv.delete(this.#pendingKey(id));
  }

  getResult(id: number): StoredEnrichmentOutcome | undefined {
    return this.#kv.get<StoredEnrichmentOutcome>(this.#resultKey(id));
  }

  putResult(id: number, outcome: StoredEnrichmentOutcome): void {
    this.#kv.put(this.#resultKey(id), outcome);
    // Bound storage: evict the enrichment that has fallen out of the retention window. IDs are
    // dense and monotonic (see submit), so this keeps at most MAX_RETAINED_ENRICHMENTS recent
    // outcomes readable while preventing unbounded growth over the account's lifetime. Dropping the
    // pending key too sweeps up any never-decided request that aged out.
    const evictId = id - MAX_RETAINED_ENRICHMENTS;
    if (evictId >= 1) {
      this.#kv.delete(this.#resultKey(evictId));
      this.#kv.delete(this.#pendingKey(evictId));
    }
  }

  removeResult(id: number): void {
    this.#kv.delete(this.#resultKey(id));
  }
}

// Replay an approved enrichment against the ZoomInfo API and shape the response into the same
// payload the (former) synchronous method would have returned. Dispatches on the stored kind.
async function performEnrichment(api: ZoomInfoApi, pending: PendingEnrichment): Promise<unknown> {
  const { kind, attributes, page } = pending;
  switch (kind) {
    case "companies": {
      const doc = await api.post("/data/v1/companies/enrich", "CompanyEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<CompanyRecord>(r, res => ({
        id: res.id ?? str(attrs(res).id) ?? "",
        fields: attrs(res),
      })));
    }
    case "corporateHierarchy": {
      const doc = await api.post("/data/v1/companies/corporate-hierarchy/enrich", "CorporateHierarchyEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<CorporateHierarchyRecord>(r, res => ({
        companyId: str(attrs(res).companyId) ?? res.id ?? "",
        fields: attrs(res),
      })));
    }
    case "hashtags": {
      const doc = await api.post("/data/v1/companies/hashtags/enrich", "HashtagEnrich", attributes);
      return asResources(doc).map(r => {
        const a = attrs(r);
        return {
          id: r.id ?? "",
          label: str(a.label),
          displayLabel: str(a.displayLabel),
          description: str(a.description),
          group: str(a.group),
          parentCategory: str(a.parentCategory),
          priority: num(a.priority),
        } satisfies CompanyHashtag;
      });
    }
    case "contacts": {
      const doc = await api.post("/data/v1/contacts/enrich", "ContactEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<ContactRecord>(r, res => ({
        id: res.id ?? str(attrs(res).id) ?? "",
        fields: attrs(res),
      })));
    }
    case "intent": {
      const doc = await api.post("/data/v1/intent/enrich", "IntentEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapIntentSignal, page);
    }
    case "scoops": {
      const doc = await api.post("/data/v1/scoops/enrich", "ScoopEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapScoop, page);
    }
    case "news": {
      const doc = await api.post("/data/v1/news/enrich", "NewsEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapNewsArticle, page);
    }
  }
}

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget.

@validateRpc()
class ZoomInfoSessionImpl extends RpcTarget implements ZoomInfoSession {
  #account: DurableObjectStub<UserAccount>;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #api: ZoomInfoApi;
  #kv: DurableObjectStorage["kv"];

  constructor(
    account: DurableObjectStub<UserAccount>,
    approvalQueue: RpcStub<ApprovalQueue>,
    apiBaseUrl: string,
    kv: DurableObjectStorage["kv"],
  ) {
    super();
    this.#account = account;
    this.#approvalQueue = approvalQueue;
    this.#api = new ZoomInfoApi(() => account.getAccessToken(), apiBaseUrl);
    this.#kv = kv;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  // Run an API call, translating auth failures into a reconnect-prompting error.
  #call<T>(fn: (api: ZoomInfoApi) => Promise<T>): Promise<T> {
    return callZoomInfo(this.#account, () => fn(this.#api));
  }

  #observe(title: string, description: string): Promise<void> {
    return this.#approvalQueue.authorizeObservation({ title, description });
  }

  // Read a cached value if still fresh, else undefined. Cache lives in the GatekeeperImpl DO's KV,
  // shared across this binding's sessions and scoped to this connected account.
  #cacheGet<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.#kv.get<CachedValue<T>>(`cache:${key}`);
    if (!hit || Date.now() - hit.fetchedAt >= ttlMs) return undefined;
    return hit.value;
  }

  #cachePut<T>(key: string, value: T): void {
    this.#kv.put<CachedValue<T>>(`cache:${key}`, { value, fetchedAt: Date.now() });
  }

  // Submit a paid enrichment for approval, disclosing the worst-case credit cost. Stores the request
  // so ZoomInfoGatekeeperImpl.applyAction() can replay it once approved, and returns a ticket the
  // Gadget passes to getEnrichmentResult(). No credits are spent until approval. `awaitDecision`
  // suspends the agent's turn until the user decides, so no result simulation is needed.
  async #submitEnrichment(
    kind: EnrichmentKind,
    summary: string,
    attributes: Record<string, unknown>,
    worstCaseCredits: number,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    const store = new EnrichmentStore(this.#kv);
    const id = store.submit({ kind, summary, attributes, page });
    try {
      await this.#approvalQueue.submitAction(id, {
        title: `ZoomInfo: ${summary}`,
        description:
            `${summary}\n\n**Credit cost:** up to **${worstCaseCredits}** ZoomInfo bulk-data ` +
            `credit${worstCaseCredits === 1 ? "" : "s"} (fewer if records are already under ` +
            `management; none for no-match/error results). Charged only on approval.`,
        // Spent credits can't be refunded, so there is no automatic revert.
        implementsRevert: false,
        // No simulation: suspend the agent until the user decides rather than letting it read back
        // un-enriched state.
        awaitDecision: true,
      });
    } catch (error) {
      store.removePending(id);
      throw error;
    }
    return { id, kind, summary };
  }

  // -------------------------------------------------------------------------
  // Lookup

  async lookup(fieldName: LookupFieldName, filters?: LookupFilters): Promise<LookupValue[]> {
    const cacheKey = `lookup:${fieldName}:${JSON.stringify(filters ?? {})}`;
    let results = this.#cacheGet<LookupValue[]>(cacheKey, LOOKUP_CACHE_TTL_MS);
    const fromCache = results !== undefined;
    if (results === undefined) {
      const query: QueryParams = clean({
        "filter[category]": filters?.category,
        "filter[parentCategory]": filters?.parentCategory,
        "filter[subCategory]": filters?.subCategory,
        "filter[vendor]": filters?.vendor,
      });
      const doc = await this.#call(api => api.get(`/data/v1/lookup/${encodeURIComponent(fieldName)}`, query));
      results = asResources(doc).map(r => {
        const a = attrs(r);
        const { name, ...rest } = a;
        return { id: r.id ?? "", type: r.type ?? fieldName, name: str(name), attributes: rest } as LookupValue;
      });
      this.#cachePut(cacheKey, results);
    }
    await this.#observe(
      `Lookup ${fieldName}`,
      `Resolved ${results.length} value(s) for the \`${fieldName}\` taxonomy${fromCache ? " (cached)" : ""}.`,
    );
    return results;
  }

  async lookupEnrichFields(entity: EnrichEntity, fieldType: "input" | "output"): Promise<EnrichFieldInfo[]> {
    const cacheKey = `lookupEnrich:${entity}:${fieldType}`;
    let results = this.#cacheGet<EnrichFieldInfo[]>(cacheKey, LOOKUP_CACHE_TTL_MS);
    const fromCache = results !== undefined;
    if (results === undefined) {
      const doc = await this.#call(api =>
        api.get("/data/v1/lookup/enrich", { "filter[entity]": entity, "filter[fieldType]": fieldType }));
      results = asResources(doc).map(r => {
        const a = attrs(r);
        return {
          fieldName: str(a.fieldName) ?? r.id ?? "",
          description: str(a.description) ?? "",
          fieldType: str(a.fieldType),
          accessGranted: bool(a.accessGranted),
        } satisfies EnrichFieldInfo;
      });
      this.#cachePut(cacheKey, results);
    }
    await this.#observe(
      `Lookup ${entity} enrich ${fieldType} fields`,
      `Returned ${results.length} ${fieldType} field(s) for ${entity} enrichment${fromCache ? " (cached)" : ""}.`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Companies

  async searchCompanies(criteria: CompanySearchCriteria, page?: PageRequest): Promise<SearchPage<CompanyMatch>> {
    assertCompatibleLocation(criteria, "searchCompanies");
    const doc = await this.#call(api =>
      api.post("/data/v1/companies/search", "CompanySearch", clean({ ...criteria }), pageQuery(page)));
    const result = toSearchPage(doc, mapCompanyMatch, page);
    await this.#observe(
      "Search ZoomInfo companies",
      `Company search returned ${result.results.length} of ${result.totalResults} match(es).`,
    );
    return result;
  }

  async enrichCompanies(
    inputs: CompanyEnrichInput[],
    outputFields: CompanyOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchCompanyInput = inputs.map(input => clean({ ...input, companyId: idValue(input.companyId) }));
    return this.#submitEnrichment(
      "companies",
      `Enrich ${inputs.length} compan${inputs.length === 1 ? "y" : "ies"} with fields: ` +
        `${outputFields.join(", ") || "(none)"}`,
      { matchCompanyInput, outputFields },
      inputs.length,
    );
  }

  async enrichCorporateHierarchy(
    inputs: CompanyRefInput[],
    outputFields: CorporateHierarchyOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchCompanyInput = inputs.map(input => clean({ ...input, companyId: idValue(input.companyId) }));
    return this.#submitEnrichment(
      "corporateHierarchy",
      `Enrich corporate hierarchy for ${inputs.length} compan${inputs.length === 1 ? "y" : "ies"}`,
      { matchCompanyInput, outputFields },
      inputs.length,
    );
  }

  async enrichHashtags(companyId: string): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "hashtags",
      `Fetch hashtags for company \`${companyId}\``,
      clean({ companyId: idValue(companyId) }),
      1,
    );
  }

  // -------------------------------------------------------------------------
  // Contacts

  async searchContacts(criteria: ContactSearchCriteria, page?: PageRequest): Promise<SearchPage<ContactMatch>> {
    const { company, ...contact } = criteria;
    assertCompatibleLocation(company, "searchContacts");
    const attributes = clean({ ...company, ...contact });
    const doc = await this.#call(api =>
      api.post("/data/v1/contacts/search", "ContactSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapContactMatch, page);
    await this.#observe(
      "Search ZoomInfo contacts",
      `Contact search returned ${result.results.length} of ${result.totalResults} match(es).`,
    );
    return result;
  }

  async enrichContacts(
    inputs: ContactEnrichInput[],
    outputFields: ContactOutputField[],
    requiredFields?: ContactOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchPersonInput = inputs.map(input => clean({
      ...input,
      personId: idValue(input.personId),
      companyId: idValue(input.companyId),
    }));
    return this.#submitEnrichment(
      "contacts",
      `Enrich ${inputs.length} contact${inputs.length === 1 ? "" : "s"} with fields: ` +
        `${outputFields.join(", ") || "(none)"}` +
        `${requiredFields?.length ? `; required: ${requiredFields.join(", ")}` : ""}`,
      clean({ matchPersonInput, outputFields, requiredFields }),
      inputs.length,
    );
  }

  // -------------------------------------------------------------------------
  // Intent

  async searchIntent(criteria: IntentSearchCriteria, page?: PageRequest): Promise<SearchPage<IntentSignal>> {
    const { company, ...intent } = criteria;
    assertNoCompanyIdentity(company, "searchIntent", "enrichIntent");
    assertCompatibleLocation(company, "searchIntent");
    const attributes = clean({ ...company, ...intent });
    const doc = await this.#call(api =>
      api.post("/data/v1/intent/search", "IntentSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapIntentSignal, page);
    await this.#observe(
      "Search ZoomInfo intent signals",
      `Intent search for topics [${criteria.topics.join(", ")}] returned ${result.results.length} ` +
        `of ${result.totalResults} signal(s).`,
    );
    return result;
  }

  async enrichIntent(
    criteria: IntentEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "intent",
      `Fetch intent signals for company \`${criteria.companyId}\` across topics ` +
        `[${criteria.topics.join(", ")}]`,
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // Scoops

  async searchScoops(criteria: ScoopSearchCriteria, page?: PageRequest): Promise<SearchPage<Scoop>> {
    const { contact, company, ...scoop } = criteria;
    assertNoCompanyIdentity(company, "searchScoops", "enrichScoops");
    assertCompatibleLocation(company, "searchScoops");
    const attributes = clean({ ...contact, ...company, ...scoop });
    const doc = await this.#call(api =>
      api.post("/data/v1/scoops/search", "ScoopSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapScoop, page);
    await this.#observe(
      "Search ZoomInfo scoops",
      `Scoop search returned ${result.results.length} of ${result.totalResults} scoop(s).`,
    );
    return result;
  }

  async enrichScoops(
    criteria: ScoopEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "scoops",
      `Fetch scoops for company \`${criteria.companyId}\``,
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // News

  async searchNews(criteria: NewsSearchCriteria, page?: PageRequest): Promise<SearchPage<NewsArticle>> {
    const doc = await this.#call(api =>
      api.post("/data/v1/news/search", "NewsSearch", clean({ ...criteria }), pageQuery(page)));
    const result = toSearchPage(doc, mapNewsArticle, page);
    await this.#observe(
      "Search ZoomInfo news",
      `News search returned ${result.results.length} of ${result.totalResults} article(s).`,
    );
    return result;
  }

  async enrichNews(
    criteria: NewsEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "news",
      `Fetch news articles for company \`${criteria.companyId}\``,
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // Enrichment results

  async getEnrichmentResult(ticket: EnrichmentTicket): Promise<EnrichmentOutcome> {
    const store = new EnrichmentStore(this.#kv);
    const stored = store.getResult(ticket.id);
    let outcome: EnrichmentOutcome;
    if (stored) {
      // The stored result payload is untyped (see StoredEnrichmentOutcome); its shape was produced
      // by performEnrichment for this ticket's kind, so we re-attach the kind discriminant to form a
      // correctly-shaped EnrichmentReady. This cast is the single trust boundary for that fact.
      outcome = stored.status === "ready"
        ? ({ status: "ready", kind: ticket.kind, result: stored.result } as EnrichmentOutcome)
        : stored;
    } else if (store.getPending(ticket.id)) {
      outcome = { status: "pending" };
    } else {
      throw new Error(`Unknown ZoomInfo enrichment ticket: ${ticket.id}`);
    }
    await this.#observe(
      `Read ZoomInfo enrichment result #${ticket.id}`,
      `Enrichment \`${ticket.kind}\` (${ticket.summary}): **${outcome.status}**.`,
    );
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Recommendations & lookalikes

  async findSimilarCompanies(criteria: SimilarCompaniesCriteria): Promise<CompanyLookalike[]> {
    const query: QueryParams = clean({
      "filter[companyId]": criteria.companyId,
      "filter[companyName]": criteria.companyName,
      "filter[sameRevenueRange]": criteria.sameRevenueRange,
      "filter[sameCountry]": criteria.sameCountry,
      "filter[sameIndustry]": criteria.sameIndustry,
      "filter[sameEmployeeRange]": criteria.sameEmployeeRange,
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/companies/lookalikes", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      return {
        id: r.id ?? "",
        companyName: str(a.companyName) ?? "",
        score: num(a.score) ?? 0,
        rank: num(a.rank) ?? 0,
        industry: str(a.industry),
        revenueRange: str(a.revenueRange),
        employeeRange: str(a.employeeRange),
        country: str(a.country),
      } satisfies CompanyLookalike;
    });
    await this.#observe("Find similar ZoomInfo companies", `Returned ${results.length} lookalike compan(ies).`);
    return results;
  }

  async findContactLookalikes(criteria: ContactLookalikesCriteria): Promise<ContactLookalike[]> {
    const query: QueryParams = clean({
      "filter[referencePersonId]": idValue(criteria.referencePersonId),
      "filter[targetCompanyId]": idValue(criteria.targetCompanyId),
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/contacts/lookalikes", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      const meta = (r.meta ?? {}) as { referencePersonId?: unknown; referencePersonBrief?: unknown };
      return {
        id: r.id ?? "",
        rank: num(a.rank) ?? 0,
        score: num(a.score) ?? 0,
        lookalikePersonBrief: str(a.lookalikePersonBrief),
        referencePersonId: str(meta.referencePersonId),
        referencePersonBrief: str(meta.referencePersonBrief),
      } satisfies ContactLookalike;
    });
    await this.#observe("Find ZoomInfo contact lookalikes", `Returned ${results.length} lookalike contact(s).`);
    return results;
  }

  async getContactRecommendations(criteria: ContactRecommendationsCriteria): Promise<ContactRecommendation[]> {
    const query: QueryParams = clean({
      "filter[useCaseType]": criteria.useCaseType,
      "filter[ziCompanyId]": idValue(criteria.companyId),
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/contacts/recommendations", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      const meta = (r.meta ?? {}) as {
        sourceType?: unknown; referencePersonId?: unknown; referencePersonBrief?: unknown;
      };
      return {
        id: r.id ?? "",
        rank: num(a.rank) ?? 0,
        score: num(a.score) ?? 0,
        reRankingScore: num(a.reRankingScore),
        recommendedPersonBrief: str(a.recommendedPersonBrief),
        sourceType: str(meta.sourceType),
        referencePersonId: str(meta.referencePersonId),
        referencePersonBrief: str(meta.referencePersonBrief),
      } satisfies ContactRecommendation;
    });
    await this.#observe(
      "Get ZoomInfo contact recommendations",
      `Returned ${results.length} recommended contact(s) for ${criteria.useCaseType} at company ` +
        `\`${criteria.companyId}\`.`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Account intelligence

  async getAccountSummary(companyId: string): Promise<AccountSummary> {
    const doc = await this.#call(api =>
      api.get(`/copilot/v1/companies/${encodeURIComponent(companyId)}/account-summary`));
    const resource = firstResource(doc);
    const markdown = str(attrs(resource ?? {}).markdown) ?? "";
    await this.#observe(
      "Get ZoomInfo account summary",
      `Retrieved the account summary for company \`${companyId}\` (${markdown.length} chars).`,
    );
    return { companyId, markdown };
  }

  async askAccountSummary(companyId: string, question: string): Promise<string> {
    const doc = await this.#call(api =>
      api.post(
        `/copilot/v1/companies/${encodeURIComponent(companyId)}/account-summary/actions/ask`,
        "AccountSummaryQuestionRequest",
        { question },
      ));
    const answer = str(attrs(firstResource(doc) ?? {}).answer) ?? "";
    await this.#observe(
      "Ask ZoomInfo account summary",
      `Asked about company \`${companyId}\`: "${question}".`,
    );
    return answer;
  }

  async getCompanyInsights(criteria: CompanyInsightsCriteria): Promise<CompanyInsights[]> {
    const ziCompanyIds = criteria.companyIds.map(id => idValue(id));
    const doc = await this.#call(api =>
      api.post("/copilot/v1/companies/insights", "CompanyInsightsSearch",
        clean({ ziCompanyIds, signalTypes: criteria.signalTypes })));
    const results = asResources(doc).map(r => {
      const rawInsights = (attrs(r).insights ?? []) as Record<string, unknown>[];
      const insights: Insight[] = rawInsights.map(i => ({
        id: str(i.id) ?? "",
        ziCompanyId: str(i.ziCompanyId) ?? "",
        signalId: str(i.signalId) ?? "",
        signalType: str(i.signalType) ?? "",
        signalPayload: (i.signalPayload ?? {}) as Record<string, unknown>,
        insightDate: str(i.insightDate),
        expiresAt: str(i.expiresAt),
        createdAt: str(i.createdAt),
      }));
      return { companyId: r.id ?? "", insights } satisfies CompanyInsights;
    });
    const total = results.reduce((sum, c) => sum + c.insights.length, 0);
    await this.#observe(
      "Get ZoomInfo company insights",
      `Returned ${total} insight signal(s) across ${results.length} compan(ies).`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Usage

  async getCreditUsage(): Promise<CreditUsage> {
    const doc = await this.#call(api => api.get("/data/v1/users/usage"));
    const usageList = (attrs(firstResource(doc) ?? {}).usage ?? []) as Record<string, unknown>[];
    const usage: UsageLimit[] = usageList.map(u => ({
      limitType: str(u.limitType) ?? "",
      description: str(u.description),
      totalLimit: num(u.totalLimit),
      currentUsage: num(u.currentUsage),
      usageRemaining: num(u.usageRemaining),
    }));
    await this.#observe("Get ZoomInfo usage", `Retrieved ${usage.length} usage/limit counter(s).`);
    return { usage };
  }
}

// ---------------------------------------------------------------------------
// Resource → typed-shape mappers (module-level; pure functions over JSON:API resources).

function mapCompanyMatch(resource: JsonApiResource): CompanyMatch {
  const a = attrs(resource);
  return {
    id: resource.id ?? "",
    name: str(a.name) ?? "",
    website: str(a.website),
    city: str(a.city),
    state: str(a.state),
    country: str(a.country),
    revenue: str(a.revenue),
    employeeCount: str(a.employeeCount),
    logoUrl: str(a.logo),
  };
}

function mapContactMatch(resource: JsonApiResource): ContactMatch {
  const a = attrs(resource);
  const company = a.company as { id?: unknown; name?: unknown } | undefined;
  return {
    id: resource.id ?? "",
    firstName: str(a.firstName),
    middleName: str(a.middleName),
    lastName: str(a.lastName),
    jobTitle: str(a.jobTitle),
    managementLevel: str(a.managementLevel),
    contactAccuracyScore: num(a.contactAccuracyScore),
    hasEmail: bool(a.hasEmail),
    hasDirectPhone: bool(a.hasDirectPhone),
    hasMobilePhone: bool(a.hasMobilePhone),
    company: company ? { id: str(company.id) ?? "", name: str(company.name) } : undefined,
  };
}

function mapIntentSignal(resource: JsonApiResource): IntentSignal {
  const a = attrs(resource);
  const company = (a.company ?? {}) as Record<string, unknown>;
  const recommended = (a.recommendedContacts ?? []) as Record<string, unknown>[];
  const locations = (a.topSignalLocations ?? []) as Record<string, unknown>[];
  return {
    category: str(a.category),
    topic: str(a.topic) ?? "",
    signalScore: num(a.signalScore) ?? 0,
    audienceStrength: str(a.audienceStrength),
    signalDate: str(a.signalDate),
    spikesInDateRange: num(a.spikesInDateRange),
    company: {
      id: str(company.id) ?? "",
      name: str(company.name),
      website: str(company.website),
      hasOtherTopicConsumption: bool(company.hasOtherTopicConsumption),
    },
    recommendedContacts: recommended.map(c => ({
      id: str(c.id) ?? "",
      firstName: str(c.firstName),
      lastName: str(c.lastName),
      jobTitle: str(c.jobTitle),
      companyName: str(c.companyName),
      jobFunctions: ((c.jobFunctions ?? []) as Record<string, unknown>[]).map(f => ({
        name: str(f.name),
        department: str(f.department),
      })),
    })),
    topSignalLocations: locations.map(l => ({
      city: str(l.city),
      state: str(l.state),
      country: str(l.country),
    })),
  };
}

function mapScoop(resource: JsonApiResource): Scoop {
  const a = attrs(resource);
  const company = a.company as { id?: unknown; name?: unknown } | undefined;
  const topics = (a.topics ?? []) as Record<string, unknown>[];
  const types = (a.types ?? []) as Record<string, unknown>[];
  const contacts = (a.contacts ?? []) as Record<string, unknown>[];
  return {
    id: resource.id ?? "",
    publishedDate: str(a.publishedDate),
    originalPublishedDate: str(a.originalPublishedDate),
    linkText: str(a.linkText),
    link: str(a.link),
    description: str(a.description),
    updateText: str(a.updateText),
    topics: topics.map(t => ({ id: str(t.id) ?? "", topic: str(t.topic) ?? "" })),
    types: types.map(t => ({ id: str(t.id) ?? "", type: str(t.type) ?? "" })),
    company: company ? { id: str(company.id) ?? "", name: str(company.name) } : undefined,
    contacts: contacts.map(c => ({
      id: str(c.id) ?? "",
      firstName: str(c.firstName),
      lastName: str(c.lastName),
      jobTitle: str(c.jobTitle),
      jobFunction: ((c.jobFunction ?? []) as Record<string, unknown>[]).map(f => ({
        name: str(f.name),
        department: str(f.department),
      })),
    })),
  };
}

function mapNewsArticle(resource: JsonApiResource): NewsArticle {
  const a = attrs(resource);
  const companies = (a.company ?? []) as Record<string, unknown>[];
  return {
    domain: str(a.domain),
    title: str(a.title),
    url: str(a.url),
    imageUrl: str(a.imageUrl),
    pageDate: str(a.pageDate),
    categories: (a.categories ?? []) as string[],
    description: str(a.description),
    company: companies.map(c => ({ id: str(c.id) ?? "", name: str(c.name) })),
  };
}
