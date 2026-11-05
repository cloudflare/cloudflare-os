// The Microsoft 365 gatekeeper's main module: the HTTP entrypoint (connect link, OAuth callback,
// Outlook change notifications), the vendor and per-account entrypoints, the account Durable Object
// that holds the OAuth grant, and the observer verifier. Each resource's per-binding gatekeeper and
// sessions live in their own modules and are re-exported here so wrangler finds every class on the
// main module. The design record is plans/microsoft-365-gatekeeper.md.
//
// Users sign in with Entra ID's authorization-code flow with PKCE, as a confidential web client.
// Access tokens live about an hour; refresh tokens slide for 90 days. `UserAccount` keeps the grant
// in the kit's `CredentialCoordinator`, so every refresh is serialized and persisted before it is
// served. A connection is pinned to the user it was first made as, by the immutable (tenant ID,
// object ID) pair: a reconnect as anyone else is refused.

import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import {
  PAGE_STYLE, connectHandoffPageHtml, errorPageHtml, escapeHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, NONCE_BYTES, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  OAuthClient, createPkce, isInvalidGrant, mergeOAuthTokens, oauthRefresh, type OAuthTokens,
} from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import { GraphApi } from "./graph-api";
import { SITE_SELECT, parseMe, parseSite } from "./graph-parse";
import {
  RECONNECT_MESSAGE, accountSource, type MicrosoftVerifierApi, type PublicGrant, type StoredIdentity, type VerifiedIdentity,
} from "./microsoft-credentials";
import {
  ALL_RESOURCES,
  CALENDAR_RESOURCE,
  LOGIN_ORIGIN,
  MicrosoftConfigurationError,
  OUTLOOK_RESOURCE,
  SHAREPOINT_RESOURCE,
  VENDOR_ID,
  acceptsTenant,
  calendarAccess,
  effectiveCalendarAccess,
  effectiveOutlookAccess,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  grantedResourcePatterns,
  grantedSharePoint,
  grantsSharedCalendars,
  grantsSharedMailboxes,
  oauthEndpoints,
  outlookAccess,
  scopesFor,
  sharePointAccess,
  tenantPolicy,
  type CalendarGatekeeperProps,
  type Env,
  type OutlookGatekeeperProps,
  type SharePointGatekeeperProps,
} from "./microsoft-env";
import { obsContext } from "./observability";
import { isAvailabilityUnit, probeAvailability } from "./calendar-observers";
import { resolveCalendarUrl } from "./calendar-resolve";
import { CalendarUrlError, parseCalendarUrl } from "./calendar-scope";
import { CalendarConfiguratorUI } from "./calendar-configurator";
import { accountConnection } from "./configurator-connection";
import { OutlookConfiguratorUI } from "./outlook-configurator";
import { SharePointConfiguratorUI } from "./sharepoint-configurator";
import { handleOutlookNotification } from "./outlook-hooks";
import { isMailUnit, probeMailUnits } from "./outlook-observers";
import { resolveOutlookUrl } from "./outlook-resolve";
import { OutlookUrlError, parseOutlookUrl } from "./outlook-scope";
import { probeUnits } from "./sharepoint-observers";
import { UnresolvableUrlError, resolveSharePointUrl } from "./sharepoint-resolve";
import { parseSharePointHost } from "./sharepoint-urls";
import MICROSOFT_LOGO_SVG from "./microsoft-logo.svg";
import TYPES_CODE from "./types.txt";
import OUTLOOK_TYPES_CODE from "./outlook-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import { mergeTypeModules } from "./type-modules";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import OUTLOOK_CONFIGURATOR_HTML from "./generated/outlook-configurator-ui.txt";
import SHAREPOINT_CONFIGURATOR_HTML from "./generated/sharepoint-configurator-ui.txt";

export { CalendarGatekeeper } from "./calendar-gatekeeper";
export { CalendarReaderImpl, CalendarSessionImpl } from "./calendar-session";
export { OutlookGatekeeper } from "./outlook-gatekeeper";
export { OutlookHookController, OutlookHookDriver } from "./outlook-hooks";
export { OutlookReaderImpl, OutlookSessionImpl } from "./outlook-session";
export { SharePointGatekeeper } from "./sharepoint-gatekeeper";
export {
  SharePointListImpl, SharePointListReaderImpl, SharePointReaderImpl, SharePointSessionImpl,
} from "./sharepoint-session";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft", vendorId: VENDOR_ID });

/** What Outlook's agent types import, which the vendor's bundle hoists to its top. */
const OUTLOOK_TYPES_MODULE_PREFIX = 'import type { RpcStub } from "cloudflare:workers";\n\n';

/** Every resource's agent types: imports lead the bundle, and SharePoint's and Calendar's types have none. */
function vendorTypes(): string {
  const prefix = OUTLOOK_TYPES_MODULE_PREFIX;
  if (!OUTLOOK_TYPES_CODE.startsWith(prefix)) throw new Error("Outlook's agent types have an unexpected module prefix.");
  return prefix + mergeTypeModules([TYPES_CODE, OUTLOOK_TYPES_CODE.slice(prefix.length), CALENDAR_TYPES_CODE]);
}

const MICROSOFT_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(MICROSOFT_LOGO_SVG)}`;

/** How long the connected identity is served before it is read from Graph again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Entra's documented access-token lifetime is 60–90 minutes; a response always carries
 * `expires_in`, so this only guards a malformed one.
 */
const DEFAULT_EXPIRES_IN_S = 3600;

/** The stored grant. The refresh token is never sent across the account boundary. */
type MicrosoftGrant = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  /** What was asked for, which every refresh repeats: Entra's v2 refresh wants the scopes named. */
  requestedScopes: string[];
};

/** What a connect attempt carries from the authorize redirect to the callback. */
type ConnectAttempt = {
  codeVerifier: string;
  /** The `redirect_uri` the authorize request carried, which the code exchange must repeat. */
  redirectUri: string;
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /** Set when the link was minted to connect a new account, whose grant goes live; else staged. */
  firstConnect?: true;
  /** The scopes this attempt asked for. */
  scopes: string[];
};

/** A reconnect's grant, staged until the Workshop confirms the browser that finished it. */
type ReconnectStage = { grant: MicrosoftGrant; identity: StoredIdentity; startedUnder: string };

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Microsoft 365 gatekeeper not configured",
  "Configure an Entra ID application (client) ID and client secret for this gatekeeper.");

/** The claims this gatekeeper reads from an ID token. */
type IdClaims = { tid: string; oid: string; name?: string; preferredUsername?: string; email?: string };

/**
 * The claims of an ID token received directly from Entra's token endpoint over TLS. OpenID Connect
 * Core §3.1.3.7 lets a client that got the token that way skip signature validation; the token is
 * still checked to be for this app, and the identity it names is confirmed against `/me` before
 * anything is pinned.
 */
function idClaims(idToken: string | undefined, clientId: string): IdClaims {
  const payload = idToken?.split(".")[1];
  if (!payload) throw new Error("Microsoft did not say which account signed in.");
  let claims: Record<string, unknown>;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, char => char.charCodeAt(0))));
  } catch {
    throw new Error("Microsoft sent an unreadable sign-in token.");
  }
  if (claims.aud !== clientId) throw new Error("Microsoft sent a sign-in token for another app.");
  if (typeof claims.tid !== "string" || typeof claims.oid !== "string") {
    throw new Error("Microsoft did not say which account signed in.");
  }
  return {
    tid: claims.tid.toLowerCase(),
    oid: claims.oid.toLowerCase(),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    ...(typeof claims.preferred_username === "string" ? { preferredUsername: claims.preferred_username } : {}),
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
  };
}

/**
 * Reads the signed-in user and their tenant's SharePoint host. The host comes from the root site;
 * a user with no SharePoint license gets a 403 or 404 there and connects without one, to be told
 * so when they try to bind something.
 */
async function fetchIdentity(accessToken: string, tenantId: string): Promise<StoredIdentity> {
  const api = new GraphApi(accessToken);
  const [me, root] = await Promise.all([
    api.get<unknown>("/me", { query: { $select: "id,displayName,userPrincipalName,mail" } }).then(parseMe),
    api.find<unknown>("/sites/root", { query: { $select: SITE_SELECT } }),
  ]);
  const host = root === null ? null : parseSharePointHost(new URL(parseSite(root).webUrl).hostname);
  return {
    tenantId,
    objectId: me.id,
    name: me.displayName,
    ...(me.userPrincipalName ? { username: me.userPrincipalName } : {}),
    ...(me.mail ? { email: me.mail } : {}),
    ...(host ? { sharePointTenant: host.tenant } : {}),
    fetchedAt: Date.now(),
  };
}

/** The app registration's OAuth client for the deployment's authority. */
function oauthClient(env: Env): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The Microsoft 365 gatekeeper is not configured.");
  const endpoints = oauthEndpoints(tenantPolicy(env).authority);
  return new OAuthClient({
    label: "Microsoft",
    // Entra accepts either; a client secret may contain characters raw Basic encoding mangles.
    client: { method: "post", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    tokenEndpoint: endpoints.token,
    authorizationEndpoint: endpoints.authorize,
    defaultExpiresIn: DEFAULT_EXPIRES_IN_S,
  });
}

/** A grant from a token response. */
function toGrant(tokens: OAuthTokens, requested: string[]): MicrosoftGrant {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: tokens.scopes?.length ? tokens.scopes : requested,
    requestedScopes: requested,
  };
}

/** The OAuth callback policy: direct in production, a relay through the stable Worker on a preview. */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "The Microsoft OAuth callback is not configured.",
      { status: 503 });
  }
}

/** A URL path segment decoded, or kept as written when its percent-escapes are malformed. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether a binding URL is a calendar's: Outlook on the web's `/calendar/` app. */
function isCalendarUrl(url: string): boolean {
  try {
    parseCalendarUrl(url);
    return true;
  } catch (error) {
    if (error instanceof CalendarUrlError) return /^https:\/\/(outlook\.office(365)?\.com|outlook\.cloud\.microsoft)\/calendar(\/|$|\?)/i.test(url);
    throw error;
  }
}

/** Whether a binding URL is Outlook mail's rather than SharePoint's. Calendar URLs are matched first. */
function isOutlookUrl(url: string): boolean {
  try {
    parseOutlookUrl(url);
    return true;
  } catch (error) {
    if (error instanceof OutlookUrlError) return /^https:\/\/(outlook\.office(365)?\.com|outlook\.cloud\.microsoft)\//i.test(url);
    throw error;
  }
}

/** The account a connect link or callback state names; null when the id is not one of ours. */
function accountFor(ctx: ExecutionContext, doId: string): DurableObjectStub<UserAccount> | null {
  try {
    return ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
  } catch {
    return null;
  }
}

/** An HTML page with a title, a paragraph, and optionally one link out, styled like the kit's. */
function noticePageHtml(title: string, detail: string, link?: { href: string; label: string }): string {
  const escapedTitle = escapeHtml(title);
  const action = link
    ? `<p><a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapedTitle}</h1>
<p class="sub">${escapeHtml(detail)}</p>${action}</main></body></html>`;
}

/** The number of the `AADSTS…` error code in Entra's error description, if it has one. */
function aadstsCode(description: string | null): string | undefined {
  return /\bAADSTS(\d{5,6})\b/.exec(description ?? "")?.[1];
}

/** The page for an authorization Entra refused, explaining the cases people actually hit. */
function authorizationRefusedHtml(env: Env, error: string, description: string | null): string {
  const code = aadstsCode(description);
  // 65001: no consent; 90094/90095: admin approval required, or a request was sent to the admins.
  if (error === "consent_required" || code === "65001" || code === "90094" || code === "90095") {
    let link: { href: string; label: string } | undefined;
    try {
      const authority = tenantPolicy(env).authority;
      if (authority !== "organizations" && env.CLIENT_ID) {
        const url = new URL(`${LOGIN_ORIGIN}/${encodeURIComponent(authority)}/adminconsent`);
        url.searchParams.set("client_id", env.CLIENT_ID);
        url.searchParams.set("redirect_uri", getRedirectUri(env));
        link = { href: url.toString(), label: "Admin consent link (for an administrator)" };
      }
    } catch {
      // An unconfigured tenant has no admin consent link to offer; the text still explains.
    }
    return noticePageHtml("An administrator needs to approve this app",
      code === "90095"
        ? "Your request to use this app was sent to your organization's administrators. Once one of them " +
          "approves it, start the connection again from the Workshop."
        : "Your organization only lets administrators allow apps to read Microsoft 365 data. Ask a " +
          "Microsoft 365 administrator to grant admin consent for this app, then start the connection again " +
          `from the Workshop.${env.CLIENT_ID ? ` The app's ID is ${env.CLIENT_ID}.` : ""}`,
      link);
  }
  // 50020: a user from a tenant this single-tenant app does not accept (a personal account, or a guest).
  if (code === "50020" || code === "500200" || code === "50194") {
    return errorPageHtml("That account can't connect here",
      "This deployment only accepts work or school accounts from its own Microsoft 365 organization. Sign " +
      "in with your organization account and try again.");
  }
  // 53003: Conditional Access blocked the sign-in.
  if (code === "53003" || code === "53000" || code === "53001") {
    return errorPageHtml("Your organization blocked this sign-in",
      "A Conditional Access policy in your Microsoft 365 organization blocked the sign-in, for example because " +
      "of your device or location. Your administrator can tell you what is required.");
  }
  return errorPageHtml("Microsoft 365 authorization was not granted", "Start the connection again from the Workshop.");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(NOT_CONFIGURED_HTML);
      try {
        tenantPolicy(env);
      } catch (error) {
        if (error instanceof MicrosoftConfigurationError) {
          return htmlResponse(errorPageHtml("Microsoft 365 gatekeeper misconfigured", error.message), 503);
        }
        throw error;
      }
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      const begun = await accountFor(ctx, path[0])?.beginOAuthFlow(path[1], previewOAuth.redirectUri);
      if (!begun) return htmlResponse(INVALID_LINK_HTML);
      const authorize = oauthClient(env).authorizationUrl({
        redirectUri: previewOAuth.redirectUri,
        state: await previewOAuth.createAuthorizationState({ userObjectId: path[0], oauthNonce: begun.oauthNonce }),
        scopes: begun.scopes,
        codeChallenge: begun.codeChallenge,
        // Always show the account picker: the browser's signed-in Microsoft account is often not the
        // one meant for this connection, and a silent sign-in would bind the wrong one.
        params: { prompt: "select_account", ...(begun.loginHint ? { login_hint: begun.loginHint } : {}) },
      });
      return Response.redirect(authorize.toString(), 302);
    }

    if (path.length === 3 && path[0] === "outlook" && path[1] === "notifications") {
      // The segment is a driver name, which the handler checks against a strict pattern; a
      // malformed escape in this unauthenticated URL is just one more name it won't match.
      return await handleOutlookNotification(req, safeDecode(path[2]), ctx.exports, ctx);
    }

    if (relPath === "/oauth") {
      // An administrator who followed the consent page's link lands here, with no state of ours.
      if (url.searchParams.has("admin_consent") && !url.searchParams.has("state")) {
        return htmlResponse(url.searchParams.get("admin_consent") === "True"
          ? noticePageHtml("Consent granted", "People in your organization can now connect Microsoft 365. " +
            "Go back to the Workshop and start the connection again.")
          : errorPageHtml("Consent was not granted", "Nothing changed. You can close this window."));
      }
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      let doId: string;
      let oauthNonce: string;
      try {
        const result = await previewOAuth.handleCallback(url);
        if (result.kind === "relay") return result.response;
        ({ userObjectId: doId, oauthNonce } = result.state);
      } catch (error) {
        if (error instanceof PreviewOAuthConfigurationError) return new Response(error.message, { status: 500 });
        return new Response("Error: malformed state", { status: 400 });
      }
      const stub = accountFor(ctx, doId);
      if (stub === null) return new Response("Error: malformed state", { status: 400 });

      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        // The refusal ends the attempt: its nonce is consumed so a replayed callback cannot resume it.
        if (!await stub.consumeOAuthNonce(oauthNonce)) return htmlResponse(INVALID_LINK_HTML);
        logger.info("Microsoft authorization refused", {
          event: "oauth.authorize.refused", oauthError: aadstsCode(url.searchParams.get("error_description")) ?? oauthError,
        });
        return htmlResponse(authorizationRefusedHtml(env, oauthError, url.searchParams.get("error_description")), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      const result = await stub.acceptAuthCode(code, oauthNonce);
      if (result === null) return htmlResponse(INVALID_LINK_HTML);
      if ("refused" in result) return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Microsoft 365",
      url: "https://www.microsoft365.com",
      logo: { url: MICROSOFT_LOGO_URL },
      color: "#f3f2f1",
      tagline: "SharePoint, OneDrive, Outlook mail and calendars",
      description:
        "Connect your work or school Microsoft 365 account so agents can read SharePoint and OneDrive files, " +
        "lists and pages, Outlook mail and calendars, and propose changes you approve before they are made.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // `options.scopes` asks for a sign-in grant, which this gatekeeper does not offer.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId)
      .setCallback(callback, initiationNonce, scopesFor(this.env, options?.resourceUrlPatterns));
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return vendorTypes();
  }
}

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<MicrosoftGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: MicrosoftGrant): Promise<MicrosoftGrant> => {
    logger.info("refreshing Microsoft access token", { event: "microsoft.token.refresh" });
    return oauthRefresh<MicrosoftGrant>(oauthClient(this.env), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      // `invalid_grant` covers an expired, revoked, or password-reset-invalidated refresh token, and
      // the AADSTS700082/50173/50076 family; `interaction_required` is Conditional Access or MFA
      // demanding a fresh interactive sign-in, which a refresh can never satisfy either.
      isGrantDeath: error => isInvalidGrant(error) || error.oauthError === "interaction_required",
      request: current => ({ scopes: current.requestedScopes }),
      expiredMessage: RECONNECT_MESSAGE,
    })(grant);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes: string[]): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    putInitiation<Pick<ConnectAttempt, "firstConnect">>(this.ctx.storage.kv, initiationNonce, Date.now(),
      { firstConnect: true });
  }

  /** Arms a reconnect or `ensureResources` flow asking for `requestedScopes`. */
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]): Promise<void> {
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /**
   * Swaps the initiation nonce for the OAuth-stage nonce and mints this flow's PKCE verifier. A
   * reconnect pre-fills the account picker with the pinned user, since only they can complete it.
   */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string):
      Promise<{ oauthNonce: string; scopes: string[]; codeChallenge: string; loginHint?: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = await createPkce();
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? scopesFor(this.env);
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      startedUnder: this.#creds.connectionGeneration(),
      scopes,
    });
    if (oauthNonce === null) return null;
    const pinned = this.ctx.storage.kv.get<StoredIdentity>("identity");
    return {
      oauthNonce, scopes, codeChallenge: pkce.codeChallenge,
      ...(pinned?.username ? { loginHint: pinned.username } : {}),
    };
  }

  /** Ends an attempt Entra refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange, then checks who signed in: a tenant the deployment accepts, and on a
   * reconnect, the same user the connection is pinned to.
   * @returns The handoff, a refusal to show, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;
    const tokens = await oauthClient(this.env).exchangeCode({
      code, redirectUri: attempt.redirectUri, codeVerifier: attempt.codeVerifier,
    });
    const grant = toGrant(tokens, attempt.scopes);
    // Entra has no token revocation endpoint (only "sign out everywhere", which would end the user's
    // other sessions too), so a grant this callback refuses is simply never stored.
    const claims = idClaims(tokens.idToken, this.env.CLIENT_ID!);
    const policy = tenantPolicy(this.env);
    const pinned = kv.get<StoredIdentity>("identity");
    if (!acceptsTenant(policy, claims.tid, attempt.firstConnect ? undefined : pinned?.tenantId)) {
      return {
        refused: {
          title: "That organization can't connect here",
          detail: "This deployment doesn't accept accounts from that Microsoft 365 organization. Sign in with an " +
            "account from an organization it allows.",
        },
      };
    }

    let identity: StoredIdentity;
    try {
      identity = await fetchIdentity(grant.accessToken, claims.tid);
    } catch (error) {
      throw new Error("Could not read which Microsoft 365 account authorized this connection. Please try again.",
        { cause: error });
    }
    if (identity.objectId !== claims.oid) {
      throw new Error("Microsoft described a different account than the one that signed in. Please try again.");
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      throw new Error("The Microsoft 365 account was disconnected while it was being authorized. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      if (pinned !== undefined && (pinned.tenantId !== identity.tenantId || pinned.objectId !== identity.objectId)) {
        const pinnedName = pinned.username ?? pinned.name;
        const signedIn = identity.username ?? identity.name;
        return {
          refused: {
            title: "That's a different Microsoft 365 account",
            detail: `This connection is for ${pinnedName}, but you signed in as ${signedIn}. Sign in as ` +
              `${pinnedName} and reconnect, or connect ${signedIn} as a separate account.`,
          },
        };
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's.
      discardStagedCredentials<ReconnectStage>(kv);
      const stageId = stageCredentials<ReconnectStage>(kv,
        { grant, identity, startedUnder: attempt.startedUnder }, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        this.#creds.connect(grant, { ifGeneration: attempt.startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        throw new Error("The Microsoft 365 account was disconnected while it was being authorized. Connect it again.",
          { cause: error });
      }
      kv.put<StoredIdentity>("identity", identity);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its tokens with nobody: drop them.
        this.#creds.clear();
        kv.delete("identity");
        throw error;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /**
   * Makes the grant staged under `stageId` live. One a newer reconnect overtook is discarded, and
   * the connection stays pinned to the identity it was made with.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<ReconnectStage>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      throw new Error("This Microsoft 365 account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<StoredIdentity>("identity", staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads, refresh material projected out. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    let snapshot: CredentialsWithIdentity<MicrosoftGrant>;
    try {
      snapshot = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    } catch (error) {
      if (isCredentialsExpired(error)) throw new CredentialsExpiredError(RECONNECT_MESSAGE, { cause: error });
      throw error;
    }
    const { creds, identity, generation } = snapshot;
    return {
      creds: {
        accessToken: creds.accessToken,
        ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
        scopes: creds.scopes,
      },
      identity,
      generation,
    };
  }

  /** Adjudicates Graph's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /** The scopes the live grant carries. */
  async getGrantedScopes(): Promise<string[]> {
    return this.#creds.stored()?.scopes ?? [];
  }

  /**
   * The user this connection is pinned to, read again from Graph once it is a day old. A failed
   * re-read serves the stored copy; a re-read naming anyone else is ignored, since the pin never moves.
   */
  async getIdentity(): Promise<StoredIdentity> {
    const stored = this.ctx.storage.kv.get<StoredIdentity>("identity");
    if (stored === undefined) throw new Error(RECONNECT_MESSAGE);
    if (Date.now() - stored.fetchedAt < IDENTITY_TTL_MS) return stored;
    try {
      const { creds } = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
      const fresh = await fetchIdentity(creds.accessToken, stored.tenantId);
      if (fresh.objectId !== stored.objectId) {
        logger.error("Microsoft identity changed under a pinned connection", { event: "microsoft.identity.changed" });
        return stored;
      }
      // A license removed since connecting leaves the old host: it still names the right tenant.
      const sharePointTenant = fresh.sharePointTenant ?? stored.sharePointTenant;
      const updated = { ...fresh, ...(sharePointTenant ? { sharePointTenant } : {}) };
      this.ctx.storage.kv.put<StoredIdentity>("identity", updated);
      return updated;
    } catch (error) {
      logger.warn("failed to refresh the Microsoft identity", { event: "microsoft.identity.refresh.failed", error });
      return stored;
    }
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Notes an Outlook hook driver that holds this connection's hooks, so disconnecting reaches it.
   * Answers false once disconnected, when the driver must refuse the hook.
   */
  async trackHookDriver(name: string): Promise<boolean> {
    if (!this.#creds.stored()) return false;
    this.ctx.storage.kv.put(`hookDriver:${name}`, Date.now());
    return true;
  }

  /**
   * Disconnects by forgetting the tokens and dropping the connection's Outlook hooks. Entra offers no
   * way to revoke one app's refresh token short of signing the user out of every session; the user
   * can remove the app's consent themselves at myapps.microsoft.com.
   */
  async revoke(): Promise<void> {
    // Hooks stop with the connection: each driver drops this account's, best effort, since one
    // left behind only polls with credentials that no longer work until its subscription lapses.
    const drivers = [...this.ctx.storage.kv.list<number>({ prefix: "hookDriver:" })].map(([key]) => key.slice("hookDriver:".length));
    await Promise.all(drivers.map(name => this.ctx.exports.OutlookHookDriver.getByName(name).forgetAccount().catch(error => {
      logger.warn("failed to drop an Outlook hook driver's hooks", { event: "outlook.hooks.forget.failed", error });
    })));
    discardStagedCredentials<ReconnectStage>(this.ctx.storage.kv);
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const account = this.#account();
    const identity = await account.getIdentity();
    return {
      displayName: identity.name,
      ...(identity.username ? { uniqueName: identity.username } : {}),
      // Graph serves profile photos only as bytes behind the token; the initials avatar is the Workshop's.
      avatar: { url: "" },
      grantedResourceUrlPatterns: grantedResourcePatterns(await account.getGrantedScopes()),
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  /**
   * Resolves a SharePoint, OneDrive, Outlook or Outlook Calendar URL to what it names, as this user,
   * and bakes the stable IDs into the binding: renaming or moving the object later can neither break
   * nor widen it.
   */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    if (isCalendarUrl(url)) return await this.#calendarGatekeeperClass(url);
    if (isOutlookUrl(url)) return await this.#outlookGatekeeperClass(url);
    const identity = await this.#account().getIdentity();
    if (identity.sharePointTenant === undefined) {
      throw new Error("This Microsoft 365 account has no SharePoint or OneDrive. Ask your administrator for a " +
        "license that includes SharePoint.");
    }
    const source = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
    const selected = grantedSharePoint(await this.#account().getGrantedScopes())?.sites === "selected";
    let resolved;
    try {
      resolved = await source.run(creds => resolveSharePointUrl(new GraphApi(creds.accessToken), url,
        identity.sharePointTenant!, { selected }), { replayable: true });
    } catch (error) {
      if (error instanceof UnresolvableUrlError) throw new Error(error.message, { cause: error });
      throw error;
    }
    const props: SharePointGatekeeperProps = { userObjectId: this.ctx.props.userObjectId, scope: resolved.scope };
    return { class: this.ctx.exports.SharePointGatekeeper({ props }), resource: SHAREPOINT_RESOURCE };
  }

  async #outlookGatekeeperClass(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const account = this.#account();
    const [identity, scopes] = await Promise.all([account.getIdentity(), account.getGrantedScopes()]);
    // The most a binding may do: the deployment's ceiling, narrowed by what the connection was granted.
    const ceiling = effectiveOutlookAccess(this.env, scopes, "send");
    if (ceiling === null) throw new Error("This Microsoft 365 connection doesn't include Outlook. Reconnect it to add Outlook.");
    const me = identity.email ?? identity.username;
    if (me === undefined) throw new Error("This Microsoft 365 account has no mailbox.");
    const source = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
    let scope;
    try {
      scope = await source.run(creds => resolveOutlookUrl(new GraphApi(creds.accessToken), url, ceiling, me, identity.objectId), { replayable: true });
    } catch (error) {
      if (error instanceof OutlookUrlError) throw new Error(error.message, { cause: error });
      throw error;
    }
    if (scope.mailbox.kind === "shared" && !grantsSharedMailboxes(scopes, scope.access)) {
      throw new Error("This Microsoft 365 connection can't open shared mailboxes. Reconnect it to add them.");
    }
    const props: OutlookGatekeeperProps = { userObjectId: this.ctx.props.userObjectId, scope };
    return { class: this.ctx.exports.OutlookGatekeeper({ props }), resource: OUTLOOK_RESOURCE };
  }

  async #calendarGatekeeperClass(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const account = this.#account();
    const [identity, scopes] = await Promise.all([account.getIdentity(), account.getGrantedScopes()]);
    // The most a binding may do: the deployment's ceiling, narrowed by what the connection was granted.
    const ceiling = effectiveCalendarAccess(this.env, scopes, "schedule");
    if (ceiling === null) throw new Error("This Microsoft 365 connection doesn't include calendars. Reconnect it to add Outlook Calendar.");
    const me = identity.email ?? identity.username;
    if (me === undefined) throw new Error("This Microsoft 365 account has no mailbox, so it has no calendar.");
    const target = parseCalendarUrl(url);
    if (target.kind === "calendar" && target.owner !== undefined && target.owner !== me.toLowerCase() && !grantsSharedCalendars(scopes, "read")) {
      throw new Error("This Microsoft 365 connection can't open calendars shared with you. Reconnect it to add them.");
    }
    const source = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
    let scope;
    try {
      scope = await source.run(creds => resolveCalendarUrl(new GraphApi(creds.accessToken), url, ceiling, me), { replayable: true });
    } catch (error) {
      if (error instanceof CalendarUrlError) throw new Error(error.message, { cause: error });
      throw error;
    }
    if (scope.kind === "calendar" && scope.owner.kind === "shared" && !grantsSharedCalendars(scopes, scope.access)) {
      // The grant reads shared calendars but can't change them: a link that asked for no level gets read.
      if (target.kind !== "calendar" || target.access !== undefined) {
        throw new Error("This Microsoft 365 connection can't change calendars shared with you. Reconnect it, or connect the calendar to read.");
      }
      scope = { ...scope, access: "read" as const };
    }
    const props: CalendarGatekeeperProps = { userObjectId: this.ctx.props.userObjectId, scope };
    return { class: this.ctx.exports.CalendarGatekeeper({ props }), resource: CALENDAR_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === OUTLOOK_RESOURCE.urlPattern) {
      // The deployment's limit, not the effective access: the configurator combines it with the
      // connection's scopes itself so it can say which of the two is what limits the user.
      return {
        iframeHtml: OUTLOOK_CONFIGURATOR_HTML,
        ui: new RpcStub(new OutlookConfiguratorUI(
          accountConnection(this.ctx.exports, this.ctx.props.userObjectId), outlookAccess(this.env))),
      };
    }
    if (resourceUrlPattern === CALENDAR_RESOURCE.urlPattern) {
      // As for Outlook: the deployment's limit, which the configurator combines with the grant itself.
      return {
        iframeHtml: CALENDAR_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalendarConfiguratorUI(
          accountConnection(this.ctx.exports, this.ctx.props.userObjectId), calendarAccess(this.env))),
      };
    }
    if (resourceUrlPattern !== SHAREPOINT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported Microsoft 365 resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: SHAREPOINT_CONFIGURATOR_HTML,
      ui: new RpcStub(new SharePointConfiguratorUI(this.ctx.exports, this.ctx.props.userObjectId, sharePointAccess(this.env))),
    };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    // A reconnect re-requests what the connection holds now, so it renews rather than narrows.
    const granted = grantedResourcePatterns(await this.#account().getGrantedScopes());
    return await this.#beginReconnect(granted.length > 0 ? granted : ALL_RESOURCES.map(resource => resource.urlPattern));
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    const granted = grantedResourcePatterns(await this.#account().getGrantedScopes());
    if (resourceUrlPatterns.every(pattern => granted.includes(pattern))) return {};
    return await this.#beginReconnect([...new Set([...granted, ...resourceUrlPatterns])]);
  }

  async #beginReconnect(resourceUrlPatterns: string[]): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce, scopesFor(this.env, resourceUrlPatterns));
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /** Mints a verifier for this account, which observers' probes run through. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: MicrosoftVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.MicrosoftVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// A collaborator observes a binding only with a working Microsoft 365 connection of their own, in
// the same tenant, and only reads whose every access unit their own account can open (see
// sharepoint-observers.ts, outlook-observers.ts and calendar-observers.ts). Probes run with the
// collaborator's token, never the owner's.

type MicrosoftVerifierProps = {
  userObjectId: string;
};

@validateRpc()
export class MicrosoftVerifier extends WorkerEntrypoint<Env, MicrosoftVerifierProps> implements MicrosoftVerifierApi {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async getIdentity(): Promise<VerifiedIdentity | null> {
    const account = this.#account();
    try {
      // The identity outlives the grant, so it speaks for the observer only while the connection's
      // credentials still work and still reach at least one resource.
      const { creds } = await account.getCredentials();
      if (grantedResourcePatterns(creds.scopes).length === 0) return null;
      const identity = await account.getIdentity();
      // The primary SMTP address Graph gave the observer's own token: what calendar sharing lists name.
      return { tenantId: identity.tenantId, objectId: identity.objectId, ...(identity.email ? { email: identity.email.toLowerCase() } : {}) };
    } catch {
      return null;
    }
  }

  async canAccess(units: string[]): Promise<boolean[]> {
    const source = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
    // Each kind of unit is probed its own way, then the verdicts are put back in the order asked.
    const kinds = units.map(unit => isAvailabilityUnit(unit) ? "availability" : isMailUnit(unit) ? "mail" : "files");
    const indexes = (kind: string) => kinds.flatMap((unitKind, index) => unitKind === kind ? [index] : []);
    const availability = indexes("availability");
    const mail = indexes("mail");
    const files = indexes("files");
    return await source.run(async creds => {
      const api = new GraphApi(creds.accessToken);
      const pick = (list: number[]) => list.map(index => units[index]!);
      const [availabilityVerdicts, mailVerdicts, fileVerdicts] = await Promise.all([
        availability.length ? probeAvailability(api, pick(availability)) : [],
        mail.length ? probeMailUnits(api, pick(mail)) : [],
        files.length ? probeUnits(api, pick(files)) : [],
      ]);
      const verdicts = Array.from({ length: units.length }, () => false);
      availability.forEach((index, at) => { verdicts[index] = availabilityVerdicts[at] === true; });
      mail.forEach((index, at) => { verdicts[index] = mailVerdicts[at] === true; });
      files.forEach((index, at) => { verdicts[index] = fileVerdicts[at] === true; });
      return verdicts;
    }, { replayable: true });
  }
}

export type { MicrosoftVerifierApi, PublicGrant, StoredIdentity };
