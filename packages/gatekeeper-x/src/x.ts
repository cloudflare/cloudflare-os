// The X gatekeeper's main module: the HTTP entrypoint (connect link and OAuth callback), the vendor
// and per-account entrypoints, the account Durable Object that holds the OAuth grant, and the
// observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// x-gatekeeper.ts and x-sessions.ts, re-exported here so wrangler finds every class on the main
// module. The design record is plans/x-gatekeeper.md.
//
// X access tokens live two hours and refresh tokens are treated as single-use, so `UserAccount`
// keeps its grant in the kit's `CredentialCoordinator`, which redeems a refresh token once and
// persists the rotated pair before serving either. A connection is pinned to the X user it was
// first made as: a reconnect that comes back as anyone else is refused.

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
import { probeAccess } from "@gadgets/gatekeeper-kit/http-errors";
import {
  OAuthClient,
  OAuthResponseError,
  createPkce,
  isInvalidGrant,
  mergeOAuthTokens,
  oauthRefresh,
  type OAuthTokens,
} from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import { XApi, requireData, type XEnvelope } from "./x-api";
import {
  RECONNECT_MESSAGE,
  accountSource,
  withinReadLimit,
  type PublicGrant,
  type ReadReservation,
  type StoredIdentity,
  type XVerifierApi,
} from "./x-credentials";
import {
  ALL_RESOURCES,
  RESOURCES,
  VENDOR_ID,
  X_AUTHORIZE_URL,
  X_REVOKE_URL,
  X_TOKEN_URL,
  dailyReadLimit,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  grantedResourcePatterns,
  kindOfPattern,
  scopesFor,
  type Env,
  type XGatekeeperImplProps,
} from "./x-env";
import { XListConfiguratorUI, XPlaceholderConfiguratorUI } from "./x-configurators";
import type { WireUser } from "./x-normalize";
import { parseXUrl } from "./x-urls";
import { obsContext } from "./observability";
import X_LOGO_SVG from "./x-logo.svg";
import TYPES_CODE from "./types.txt";
import X_ACCOUNT_CONFIGURATOR_HTML from "./generated/x-account-configurator-ui.txt";
import X_LIST_CONFIGURATOR_HTML from "./generated/x-list-configurator-ui.txt";
import X_POST_CONFIGURATOR_HTML from "./generated/x-post-configurator-ui.txt";
import X_PROFILE_CONFIGURATOR_HTML from "./generated/x-profile-configurator-ui.txt";

export { XGatekeeperImpl } from "./x-gatekeeper";
export {
  XAccountSessionImpl, XListImpl, XPostImpl, XProfileImpl, XUserImpl,
} from "./x-sessions";

const logger = obsContext.createLogger({ component: "gatekeeper.x", vendorId: VENDOR_ID });

const X_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(X_LOGO_SVG)}`;

/** How long the connected identity is served before it is read from X again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

/** The stored grant. The refresh token rotates and is never sent across the account boundary. */
type XGrant = { accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[] };

/** What a connect attempt carries from the authorize redirect to the callback. */
type ConnectAttempt = {
  codeVerifier: string;
  /** The `redirect_uri` the authorize request carried, which the code exchange must repeat. */
  redirectUri: string;
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /** Whether the grant is staged rather than made live, fixed when the attempt starts. */
  reconnect: boolean;
  /** The scopes this attempt asked for, recorded on the grant if X's response omits them. */
  scopes: string[];
};

/** A reconnect's grant, staged until the Workshop confirms the browser that finished it. */
type ReconnectStage = { grant: XGrant; identity: StoredIdentity; startedUnder: string };

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

const NOT_CONFIGURED_HTML = errorPageHtml(
  "X gatekeeper not configured",
  "Configure an X OAuth 2.0 client ID and secret for this gatekeeper.");

const IDENTITY_FIELDS = "id,name,username,profile_image_url,protected,verified,subscription_type";

/** Reads the X user a token belongs to. */
async function fetchIdentity(accessToken: string): Promise<StoredIdentity> {
  const envelope: XEnvelope<WireUser> = await new XApi(accessToken)
    .get<WireUser>("/2/users/me", { "user.fields": IDENTITY_FIELDS });
  const user = requireData(envelope, "user");
  if (!user.id || !user.username) throw new Error("X did not say which account authorized this connection.");
  return {
    id: user.id,
    username: user.username,
    name: user.name ?? user.username,
    ...(user.profile_image_url ? { profileImageUrl: user.profile_image_url } : {}),
    protected: user.protected === true,
    verified: user.verified === true,
    ...(user.subscription_type ? { subscriptionType: user.subscription_type } : {}),
    fetchedAt: Date.now(),
  };
}

/** The X app's OAuth client, built from this Worker's secrets. */
function oauthClient(env: Env): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The X gatekeeper is not configured.");
  return new OAuthClient({
    label: "X",
    client: { method: "basic", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    tokenEndpoint: X_TOKEN_URL,
    authorizationEndpoint: X_AUTHORIZE_URL,
    revocationEndpoint: X_REVOKE_URL,
    // X's documented access-token lifetime, for a response that omits `expires_in`.
    defaultExpiresIn: 7200,
  });
}

/**
 * Whether X's refusal of a refresh token proves the grant dead. `invalid_grant` is the standard
 * answer; X has also been reported to answer a spent or revoked refresh token with `invalid_request`
 * and "Value passed for the token was invalid", which is narrow enough to count too.
 */
function isGrantDeath(error: OAuthResponseError): boolean {
  return isInvalidGrant(error)
    || (error.oauthError === "invalid_request" && /token was invalid/i.test(error.description ?? ""));
}

/** A grant from a token response, recording the requested scopes when X reports none. */
function toGrant(tokens: OAuthTokens, requested: string[]): XGrant {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: tokens.scopes?.length ? tokens.scopes : requested,
  };
}

/** The OAuth callback policy: direct in production, a relay through the stable Worker on a preview. */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "The X OAuth callback is not configured.",
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
        scopes: begun.scopes,
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
          "X authorization was not granted", "Start the connection again from the Workshop."), 400);
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
      displayName: "X",
      url: "https://x.com",
      logo: { url: X_LOGO_URL },
      color: "#f2f2f2",
      tagline: "Read, post, and engage on X (formerly Twitter)",
      description:
        "Connect your X account so Cloudflare OS can read your timeline, mentions, bookmarks, and " +
        "search, and draft posts, threads, replies, likes, and follows that you approve before " +
        "they go out.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // `options.scopes` asks for a sign-in grant, which this gatekeeper does not offer.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId)
      .setCallback(callback, initiationNonce, scopesFor(options?.resourceUrlPatterns));
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
  readonly #creds = new CredentialCoordinator<XGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    // No `discardMint`: X does not document whether revoking one refresh token revokes the rest of
    // the authorization, so a mint a reconnect overtook is dropped unrevoked rather than risking
    // the connection that won.
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: XGrant): Promise<XGrant> => {
    logger.info("refreshing X access token", { event: "x.token.refresh" });
    return oauthRefresh<XGrant>(oauthClient(this.env), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      isGrantDeath,
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
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /** Arms a reconnect or `ensureResources` flow asking for `requestedScopes`. */
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]): Promise<void> {
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /** Swaps the initiation nonce for the OAuth-stage nonce and mints this flow's PKCE verifier. */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string):
      Promise<{ oauthNonce: string; scopes: string[]; codeChallenge: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = await createPkce();
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? scopesFor();
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      startedUnder: this.#creds.connectionGeneration(),
      reconnect: this.#creds.stored() !== undefined,
      scopes,
    });
    if (oauthNonce === null) return null;
    return { oauthNonce, scopes, codeChallenge: pkce.codeChallenge };
  }

  /** Ends an attempt X refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange. X's authorization code lives 30 seconds, so nothing runs between
   * claiming the nonce and the exchange; the identity read comes after it.
   * @returns The handoff, a refusal to show, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;
    const client = oauthClient(this.env);
    const grant = toGrant(await client.exchangeCode({
      code, redirectUri: attempt.redirectUri, codeVerifier: attempt.codeVerifier,
    }), attempt.scopes);

    // Which grants are revoked when they go unused: one that provably cannot share an authorization
    // with the live grant -- another X user's, a first connect's, one the disconnect left behind.
    // A same-user reconnect's leftover is dropped unrevoked, since X does not say whether revoking
    // one of the user's refresh tokens revokes the rest, and the rest include the live one.
    let identity: StoredIdentity;
    try {
      identity = await fetchIdentity(grant.accessToken);
    } catch (error) {
      if (!attempt.reconnect) await this.#revokeGrant(grant);
      throw new Error("Could not read which X account authorized this connection. Please try again.",
        { cause: error });
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      await this.#revokeGrant(grant);
      throw new Error("The X account was disconnected while it was being authorized. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (attempt.reconnect) {
      const pinned = kv.get<StoredIdentity>("identity");
      if (pinned !== undefined && pinned.id !== identity.id) {
        await this.#revokeGrant(grant);
        return {
          refused: {
            title: "That's a different X account",
            detail: `This connection is for @${pinned.username}, but X authorized @${identity.username}. ` +
              `Sign in to X as @${pinned.username} and reconnect, or connect @${identity.username} ` +
              "as a separate account.",
          },
        };
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's. A stage this
      // one displaces is the same user's, so it is dropped unrevoked.
      discardStagedCredentials<ReconnectStage>(kv);
      const stageId = stageCredentials<ReconnectStage>(kv,
        { grant, identity, startedUnder: attempt.startedUnder }, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        this.#creds.connect(grant, { ifGeneration: attempt.startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        await this.#revokeGrant(grant);
        throw new Error("The X account was disconnected while it was being authorized. Connect it again.",
          { cause: error });
      }
      kv.put<StoredIdentity>("identity", identity);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its tokens with nobody: revoke them.
        const abandoned = this.#creds.stored() ?? grant;
        this.#creds.clear();
        kv.delete("identity");
        await this.#revokeGrant(abandoned);
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
      // The same user's grant, overtaken: dropped unrevoked, as in acceptAuthCode.
      throw new Error("This X account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<StoredIdentity>("identity", staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads, refresh material projected out. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    let snapshot: CredentialsWithIdentity<XGrant>;
    try {
      snapshot = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    } catch (error) {
      // A dead grant, a disconnect, a revoke mid-refresh: to the gadget each means one thing.
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

  /** Adjudicates X's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /** The scopes the live grant carries. */
  async getGrantedScopes(): Promise<string[]> {
    return this.#creds.stored()?.scopes ?? [];
  }

  /**
   * The X user this connection is pinned to, read again from X once it is a day old. A failed
   * re-read serves the stored copy, and a re-read naming another user is ignored: the pin never
   * moves.
   */
  async getIdentity(): Promise<StoredIdentity> {
    const stored = this.ctx.storage.kv.get<StoredIdentity>("identity");
    if (stored === undefined) throw new Error(RECONNECT_MESSAGE);
    if (Date.now() - stored.fetchedAt < IDENTITY_TTL_MS) return stored;
    try {
      const { creds } = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
      const fresh = await fetchIdentity(creds.accessToken);
      if (fresh.id !== stored.id) {
        logger.error("X identity changed under a pinned connection", { event: "x.identity.changed" });
        return stored;
      }
      this.ctx.storage.kv.put<StoredIdentity>("identity", fresh);
      return fresh;
    } catch (error) {
      logger.warn("failed to refresh the X identity", { event: "x.identity.refresh.failed", error });
      return stored;
    }
  }

  /**
   * Reserves `count` billable reads against today's limit. X bills per resource per UTC day, so the
   * limit counts the same way and resets at UTC midnight.
   */
  async reserveReads(count: number): Promise<ReadReservation> {
    const limit = dailyReadLimit(this.env);
    if (limit === null) return { ok: true };
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const stored = this.ctx.storage.kv.get<{ day: string; used: number }>("reads");
    const used = stored?.day === day ? stored.used : 0;
    if (used >= limit) {
      const midnight = new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
      return { ok: false, limit, resetsAt: midnight };
    }
    this.ctx.storage.kv.put("reads", { day, used: used + count });
    return { ok: true };
  }

  /** Settles a reservation of `reserved` reads with the `actual` count X returned. */
  async settleReads(reserved: number, actual: number): Promise<void> {
    if (dailyReadLimit(this.env) === null) return;
    const day = new Date().toISOString().slice(0, 10);
    const stored = this.ctx.storage.kv.get<{ day: string; used: number }>("reads");
    if (stored?.day !== day) return;
    this.ctx.storage.kv.put("reads", { day, used: Math.max(0, stored.used - reserved + actual) });
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Disconnects, local-first: the account is cleared before any call to X, so nothing can re-arm
   * it meanwhile; revoking the tokens at X is best effort afterwards.
   */
  async revoke(): Promise<void> {
    const live = this.#creds.stored();
    const staged = discardStagedCredentials<ReconnectStage>(this.ctx.storage.kv);
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (staged) await this.#revokeGrant(staged.grant);
    if (live) await this.#revokeGrant(live);
  }

  /** Revokes a grant's tokens at X, refresh token first; failures are logged, never fatal. */
  async #revokeGrant(grant: XGrant): Promise<void> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) return;
    const client = oauthClient(this.env);
    const tokens: [string, "refresh_token" | "access_token"][] = [];
    if (grant.refreshToken) tokens.push([grant.refreshToken, "refresh_token"]);
    tokens.push([grant.accessToken, "access_token"]);
    for (const [token, tokenTypeHint] of tokens) {
      try {
        await client.revoke({ token, tokenTypeHint });
      } catch (error) {
        logger.warn("failed to revoke an X OAuth token", { event: "oauth.token.revoke.failed", error });
      }
    }
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
      uniqueName: `@${identity.username}`,
      avatar: { url: identity.profileImageUrl ?? "" },
      grantedResourceUrlPatterns: grantedResourcePatterns(await account.getGrantedScopes()),
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
    const parsed = parseXUrl(url);
    if (!parsed) {
      throw new Error("Not an X link this gatekeeper can bind: expected a post, List, or profile link, " +
        `or ${RESOURCES.account.title} (https://x.com/settings/account).`);
    }
    const base = { userObjectId: this.ctx.props.userObjectId };
    const props: XGatekeeperImplProps =
      parsed.kind === "account" ? { ...base, resourceKind: "account" }
      : parsed.kind === "post" ? { ...base, resourceKind: "post", postId: parsed.postId }
      : parsed.kind === "list" ? { ...base, resourceKind: "list", listId: parsed.listId }
      : { ...base, resourceKind: "profile", username: parsed.username };
    return {
      class: this.ctx.exports.XGatekeeperImpl({ props }),
      resource: RESOURCES[parsed.kind],
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const kind = kindOfPattern(resourceUrlPattern);
    switch (kind) {
      case "account":
        return { iframeHtml: X_ACCOUNT_CONFIGURATOR_HTML, ui: new RpcStub(new XPlaceholderConfiguratorUI()) };
      case "post":
        return { iframeHtml: X_POST_CONFIGURATOR_HTML, ui: new RpcStub(new XPlaceholderConfiguratorUI()) };
      case "profile":
        return { iframeHtml: X_PROFILE_CONFIGURATOR_HTML, ui: new RpcStub(new XPlaceholderConfiguratorUI()) };
      case "list":
        return {
          iframeHtml: X_LIST_CONFIGURATOR_HTML,
          ui: new RpcStub(new XListConfiguratorUI(this.ctx.exports, this.ctx.props.userObjectId)),
        };
      default:
        throw new Error(`Unsupported X resource configurator type: ${resourceUrlPattern}`);
    }
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    // A reconnect re-requests what the connection holds now, so it renews rather than narrows.
    const granted = grantedResourcePatterns(await this.#account().getGrantedScopes());
    return await this.#beginReconnect(granted);
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
    await this.#account().prepareReconnect(initiationNonce, scopesFor(resourceUrlPatterns));
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /** Mints a verifier for this account; see `XGatekeeperImpl.addObserver`. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: XVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.XVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Every binding admits observers by one rule (plans/x-gatekeeper.md §7): public reads need only an
// X account of the observer's own, and owner-private reads -- bookmarks, likes, mute state,
// private Lists, protected accounts' posts -- need the observer to be connected as the same X
// user. A Post or List binding also checks, on every open, that the observer's own account can
// see the bound post or List.

type XVerifierProps = {
  userObjectId: string;
};

@validateRpc()
export class XVerifier extends WorkerEntrypoint<Env, XVerifierProps> implements XVerifierApi {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async getXUserId(): Promise<string | null> {
    try {
      return (await this.#account().getIdentity()).id;
    } catch {
      return null;
    }
  }

  async canViewPost(postId: string): Promise<boolean> {
    return await this.#probe(api => api.get<unknown>(`/2/tweets/${postId}`, {}), "post");
  }

  async canViewList(listId: string): Promise<boolean> {
    return await this.#probe(api => api.get<unknown>(`/2/lists/${listId}`, {}), "List");
  }

  /** Runs one access probe with the observer's own token. Probes count against their read limit. */
  async #probe(lookup: (api: XApi) => Promise<XEnvelope<unknown>>, what: string): Promise<boolean> {
    const source = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
    return await probeAccess(async () => requireData(await withinReadLimit(this.#account(), 1,
      () => source.run(creds => lookup(new XApi(creds.accessToken)), { replayable: true }),
      "The collaborator's X connection"), what));
  }
}

export type { PublicGrant, ReadReservation, StoredIdentity, XVerifierApi };
