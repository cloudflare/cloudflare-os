// The PagerDuty gatekeeper's main module: the HTTP entrypoint (connect link and OAuth callback), the
// vendor and per-account entrypoints, the account Durable Object that holds the OAuth grant, and
// the observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// pagerduty-gatekeeper.ts and pagerduty-sessions.ts, re-exported here so wrangler finds every class
// on the main module.
//
// A connection is a Scoped OAuth user grant: PagerDuty access tokens live a day and refresh tokens
// rotate, so `UserAccount` keeps the grant in the kit's `CredentialCoordinator`. The token
// response's ID token names the user, account and region the grant belongs to; a connection is
// pinned to that user, and a reconnect that comes back as anyone else is refused.

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
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
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
  OAuthClient, createPkce, mergeOAuthTokens, oauthRefresh, type OAuthTokens,
} from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import { PagerDutyApi, isDenial } from "./pagerduty-api";
import {
  RECONNECT_MESSAGE,
  identityOf,
  parseSubresource,
  seesPublicObjects,
  subresourceId,
  verifyIdToken,
  type GrantIdentity,
  type Identity,
  type ObjectKind,
  type PagerDutyVerifierApi,
  type PublicGrant,
  type Subresource,
} from "./pagerduty-credentials";
import {
  ALL_RESOURCES,
  AUTHORIZE_URL,
  RESOURCES,
  SCOPES,
  TOKEN_URL,
  VENDOR_ID,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  missingScopes,
  webOrigin,
  type Env,
  type PagerDutyGatekeeperImplProps,
  type Tenant,
} from "./pagerduty-env";
import { PagerDutyConfiguratorUI } from "./pagerduty-configurator";
import type { WireUser } from "./pagerduty-normalize";
import { parseResourceUrl, sameTenant } from "./pagerduty-urls";
import { obsContext } from "./observability";
import PAGERDUTY_LOGO_SVG from "./pagerduty-logo.svg";
import TYPES_CODE from "./types.txt";
import CONFIGURATOR_HTML from "./generated/pagerduty-configurator-ui.txt";

export { PagerDutyGatekeeperImpl } from "./pagerduty-gatekeeper";
export {
  PagerDutyAccountImpl, PagerDutyIncidentImpl, PagerDutyScheduleImpl, PagerDutyServiceImpl, PagerDutyTeamImpl,
} from "./pagerduty-sessions";

const logger = obsContext.createLogger({ component: "gatekeeper.pagerduty", vendorId: VENDOR_ID });

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(PAGERDUTY_LOGO_SVG)}`;

/** How long the connected user's details are served before they are read from PagerDuty again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
/** PagerDuty's documented access-token lifetime, for a response that omits `expires_in`. */
const ACCESS_TOKEN_SECONDS = 24 * 60 * 60;

/**
 * How long an observer-access answer is reused, by whether it allowed. PagerDuty doesn't say when
 * a role or team membership changes, so a removal is noticed once the allowance expires, while a
 * denial is kept only briefly so a new membership is noticed soon.
 */
const ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const ACCESS_DENIED_TTL_MS = 15_000;
const accessTtl = (allowed: boolean): number => allowed ? ACCESS_ALLOWED_TTL_MS : ACCESS_DENIED_TTL_MS;
/** How many objects an access check probes at once. */
const PROBE_CONCURRENCY = 6;

/** Where an object's access probe reads it. */
const PROBE_PATHS: Record<ObjectKind, string> = {
  team: "/teams/",
  service: "/services/",
  incident: "/incidents/",
  schedule: "/schedules/",
  escalation_policy: "/escalation_policies/",
};

/**
 * Whether PagerDuty opens an object for the user whose token this is: a 403 or 404 is a definite
 * no, and any other failure leaves access undetermined, so it throws.
 */
async function probe(accessToken: string, { region, object }: Subresource): Promise<boolean> {
  try {
    await new PagerDutyApi(accessToken, region).get(`${PROBE_PATHS[object!.kind]}${object!.id}`);
    return true;
  } catch (error) {
    if (isDenial(error)) return false;
    throw error;
  }
}

/** The stored grant. The refresh token rotates and is never sent across the account boundary. */
type Grant = { accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[] };

/** What a connect attempt carries from the authorize redirect to the callback. */
type ConnectAttempt = {
  codeVerifier: string;
  /** The `redirect_uri` the authorize request carried, which the code exchange must repeat. */
  redirectUri: string;
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /** Set when the link was minted to connect a new account, whose grant goes live. */
  firstConnect?: true;
};

/** A reconnect's grant, staged until the Workshop confirms the browser that finished it. */
type ReconnectStage = { grant: Grant; identity: Identity; startedUnder: string };

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

const NOT_CONFIGURED_HTML = errorPageHtml(
  "PagerDuty gatekeeper not configured",
  "Configure a PagerDuty Scoped OAuth client ID and secret for this gatekeeper.");

/** The PagerDuty app's OAuth client, built from this Worker's secrets. */
function oauthClient(env: Env): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The PagerDuty gatekeeper is not configured.");
  return new OAuthClient({
    label: "PagerDuty",
    client: { method: "post", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    tokenEndpoint: TOKEN_URL,
    authorizationEndpoint: AUTHORIZE_URL,
    defaultExpiresIn: ACCESS_TOKEN_SECONDS,
  });
}

function toGrant(tokens: OAuthTokens): Grant {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    // RFC 6749 lets a response omit `scope` when it granted what was asked.
    scopes: tokens.scopes ?? [...SCOPES],
  };
}

/** Reads the user a grant belongs to. */
async function fetchUser(accessToken: string, grant: GrantIdentity): Promise<Identity> {
  const { user } = await new PagerDutyApi(accessToken, grant.region).get<{ user: WireUser }>("/users/me");
  return identityOf(grant, user);
}

/** The OAuth callback policy: direct in production, a relay through the stable Worker on a preview. */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "The PagerDuty OAuth callback is not configured.",
      { status: 503 });
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

/** The `UserAccount` an entrypoint's props name. */
function accountOf(ctx: ExecutionContext<{ userObjectId: string }>): DurableObjectStub<UserAccount> {
  return ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(ctx.props.userObjectId));
}

/** Where an account's web app lives, for messages. */
const hostOf = (tenant: Tenant): string => new URL(webOrigin(tenant)).host;

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
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      const begun = await accountFor(ctx, path[0])?.beginOAuthFlow(path[1], previewOAuth.redirectUri);
      if (!begun) return htmlResponse(INVALID_LINK_HTML);
      const authorize = oauthClient(env).authorizationUrl({
        redirectUri: previewOAuth.redirectUri,
        state: await previewOAuth.createAuthorizationState({ userObjectId: path[0], oauthNonce: begun.oauthNonce }),
        scopes: [...SCOPES],
        codeChallenge: begun.codeChallenge,
      });
      return Response.redirect(authorize.toString(), 302);
    }

    if (relPath === "/oauth") {
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

      if (url.searchParams.get("error")) {
        // The refusal ends the attempt: its nonce is consumed so a replayed callback cannot resume it.
        if (!await stub.consumeOAuthNonce(oauthNonce)) return htmlResponse(INVALID_LINK_HTML);
        return htmlResponse(errorPageHtml(
          "PagerDuty authorization was not granted", "Start the connection again from the Workshop."), 400);
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
      displayName: "PagerDuty",
      url: "https://www.pagerduty.com",
      logo: { url: LOGO_URL },
      color: "#e6f7eb",
      tagline: "Respond to incidents and see who is on call",
      description:
        "Connect your PagerDuty account so Cloudflare OS can read incidents, services, teams and " +
        "on-call schedules, and acknowledge, resolve, reassign and annotate incidents or add " +
        "schedule overrides once you approve.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // Every resource type needs the same scopes, so `options.resourceUrlPatterns` narrows nothing.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: Grant): Promise<Grant> => {
    logger.info("refreshing PagerDuty access token", { event: "pagerduty.token.refresh" });
    return oauthRefresh<Grant>(oauthClient(this.env), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      expiredMessage: RECONNECT_MESSAGE,
    })(grant);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  // This account's answers about its own access to subresources, partitioned by the connection
  // that learned them, so none outlives a disconnect or survives a reconnect. Bypassed while the
  // account holds no grant.
  readonly #access = new KvTtlCache(this.ctx.storage.kv,
    () => this.#creds.stored() ? this.#creds.connectionGeneration() : undefined, { name: "access" });

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    putInitiation<Pick<ConnectAttempt, "firstConnect">>(this.ctx.storage.kv, initiationNonce, Date.now(),
      { firstConnect: true });
  }

  /** Arms a reconnect flow. */
  async prepareReconnect(initiationNonce: string): Promise<void> {
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /** Swaps the initiation nonce for the OAuth-stage nonce and mints this flow's PKCE verifier. */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string):
      Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      startedUnder: this.#creds.connectionGeneration(),
    });
    return oauthNonce === null ? null : { oauthNonce, codeChallenge: pkce.codeChallenge };
  }

  /** Ends an attempt PagerDuty refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange. PagerDuty's authorization code lives 30 seconds, so nothing runs
   * between claiming the nonce and the exchange. PagerDuty documents no token revocation, so a
   * grant this refuses is dropped rather than revoked.
   * @returns The handoff, a refusal to show, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;
    const tokens = await oauthClient(this.env).exchangeCode({
      code, redirectUri: attempt.redirectUri, codeVerifier: attempt.codeVerifier,
    });
    const grant = toGrant(tokens);

    const missing = missingScopes(grant.scopes);
    if (missing.length > 0) {
      return {
        refused: {
          title: "The PagerDuty app is missing permissions",
          detail: `PagerDuty didn't grant ${missing.join(", ")}. Ask whoever registered the app to ` +
            "add these permissions, then connect again.",
        },
      };
    }
    if (!tokens.idToken) throw new Error("PagerDuty did not say which user authorized this connection.");
    let identity: Identity;
    try {
      identity = await fetchUser(grant.accessToken, await verifyIdToken(tokens.idToken));
    } catch (error) {
      throw new Error("Could not read which PagerDuty user authorized this connection. Please try again.",
        { cause: error });
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      throw new Error("The PagerDuty account was disconnected while it was being authorized. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      const pinned = kv.get<Identity>("identity");
      if (pinned !== undefined && (pinned.userId !== identity.userId || pinned.accountId !== identity.accountId)) {
        return {
          refused: {
            title: "That's a different PagerDuty user",
            detail: `This connection is for ${pinned.email} on ${hostOf(pinned)}, but PagerDuty authorized ` +
              `${identity.email} on ${hostOf(identity)}. Sign in as ${pinned.email} and reconnect, or ` +
              "connect the other user as a separate account.",
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
        throw new Error("The PagerDuty account was disconnected while it was being authorized. Connect it again.",
          { cause: error });
      }
      kv.put<Identity>("identity", identity);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its grant with nobody: drop it.
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
   * the connection stays pinned to the user it was made with.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<ReconnectStage>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      throw new Error("This PagerDuty account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<Identity>("identity", staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads, refresh material projected out. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    let snapshot: CredentialsWithIdentity<Grant>;
    try {
      snapshot = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    } catch (error) {
      // A dead grant, a disconnect, a revoke mid-refresh: to the gadget each means one thing.
      if (isCredentialsExpired(error)) throw new CredentialsExpiredError(RECONNECT_MESSAGE, { cause: error });
      throw error;
    }
    const { creds: { accessToken, expiresAt }, identity, generation } = snapshot;
    return { creds: { accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) }, identity, generation };
  }

  /** Adjudicates PagerDuty's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /**
   * The connected user, read again from PagerDuty once a day old, or once older than `maxAgeMs`
   * for a caller that needs it recent. A failed re-read serves the stored copy, except to a caller
   * that asked for a recent one.
   */
  async getIdentity(options?: { maxAgeMs?: number }): Promise<Identity> {
    const stored = this.ctx.storage.kv.get<Identity>("identity");
    if (stored === undefined || !this.#creds.stored()) throw new CredentialsExpiredError(RECONNECT_MESSAGE);
    const recent = options?.maxAgeMs !== undefined;
    if (Date.now() - stored.fetchedAt < (options?.maxAgeMs ?? IDENTITY_TTL_MS)) return stored;
    try {
      const { creds } = await this.getCredentials();
      const fresh = await fetchUser(creds.accessToken, stored);
      this.ctx.storage.kv.put<Identity>("identity", fresh);
      return fresh;
    } catch (error) {
      if (recent) throw error;
      logger.warn("failed to refresh the PagerDuty identity", { event: "pagerduty.identity.refresh.failed", error });
      return stored;
    }
  }

  /**
   * Whether this connection can read each subresource (see `subresourceId`), in order. The account
   * is readable when it is this connection's and the user's base role sees public objects; an
   * object, when the account is and PagerDuty opens it for this user, a 403 or 404 being a
   * definite no. An allowed answer is reused for up to 15 minutes and a denial for 15 seconds, until
   * the next reconnect. Throws for an ID it can't check, or when access can't be determined, which
   * is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    const parsed = subresources.map(parseSubresource);
    const { creds } = await this.getCredentials();
    const accounts = new Map<string, boolean>();
    for (const key of parsed) {
      const id = subresourceId(key);
      if (!accounts.has(id)) accounts.set(id, await this.#access.cached(id, accessTtl, () => this.#ownsAccount(key)));
    }
    // An object in an account the observer can't read is denied without asking about it.
    const objects = [...new Set(parsed.filter(key => key.object && accounts.get(subresourceId(key)))
      .map(key => subresourceId(key, key.object)))];
    const allowed = new Map<string, boolean>();
    for (let start = 0; start < objects.length; start += PROBE_CONCURRENCY) {
      await Promise.all(objects.slice(start, start + PROBE_CONCURRENCY).map(async id => {
        allowed.set(id, await this.#access.cached(id, accessTtl, () => probe(creds.accessToken, parseSubresource(id))));
      }));
    }
    return parsed.map(key =>
      accounts.get(subresourceId(key))! && (!key.object || allowed.get(subresourceId(key, key.object))!));
  }

  /** Whether `key` is this connection's account and its user's role sees the account's objects. */
  async #ownsAccount(key: Subresource): Promise<boolean> {
    const stored = await this.getIdentity();
    if (stored.region !== key.region || stored.accountId !== key.accountId) return false;
    // The role can change, so it is read afresh for every answer this caches.
    return seesPublicObjects((await this.getIdentity({ maxAgeMs: 0 })).role);
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Disconnects. PagerDuty documents no token revocation, so the grant is forgotten here and lapses
   * at PagerDuty: the access token within a day, the refresh token after 30 days unused. A user
   * can revoke it sooner from their PagerDuty profile.
   */
  async revoke(): Promise<void> {
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const identity = await accountOf(this.ctx).getIdentity();
    return {
      displayName: identity.name,
      uniqueName: `${identity.email} · ${hostOf(identity)}`,
      avatar: { url: identity.avatarUrl ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = parseResourceUrl(url);
    if (!parsed) {
      throw new Error("Not a PagerDuty link this gatekeeper can bind: expected an account " +
        "(https://<subdomain>.pagerduty.com), or a team, service, incident or schedule in it.");
    }
    const identity = await accountOf(this.ctx).getIdentity();
    if (!sameTenant(parsed, identity)) {
      throw new Error(`That link is for ${hostOf(parsed)}, but this ` +
        `connection is to ${hostOf(identity)}.`);
    }
    const base = { userObjectId: this.ctx.props.userObjectId, region: parsed.region, subdomain: parsed.subdomain };
    const props: PagerDutyGatekeeperImplProps = parsed.kind === "account"
      ? { ...base, resourceKind: "account" }
      : { ...base, resourceKind: parsed.kind, id: parsed.id };
    return { class: this.ctx.exports.PagerDutyGatekeeperImpl({ props }), resource: RESOURCES[parsed.kind] };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    // The five types share one card, so each gets the same configurator (see `groupedWith`).
    if (!ALL_RESOURCES.some(resource => resource.urlPattern === resourceUrlPattern)) {
      throw new Error(`Unsupported PagerDuty resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: CONFIGURATOR_HTML,
      ui: new RpcStub(new PagerDutyConfiguratorUI(this.ctx.exports, this.ctx.props.userObjectId)),
    };
  }

  async revoke(): Promise<void> {
    await accountOf(this.ctx).revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await accountOf(this.ctx).prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await accountOf(this.ctx).commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // A connection holds every scope or was refused, so it already covers every resource type.
    return {};
  }

  /** Mints a verifier for this account; see `PagerDutyGatekeeperImpl.verifyObserverAccess`. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.PagerDutyVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Every read reports the account and the objects whose visibility governs it; an observer may see
// it only if their own connection, to the same account, can read each one (see
// UserAccount.checkSubresourceAccess).

@validateRpc()
export class PagerDutyVerifier extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements PagerDutyVerifierApi {
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    return await accountOf(this.ctx).checkSubresourceAccess(subresources);
  }
}

export type { Identity, PagerDutyVerifierApi, PublicGrant };
