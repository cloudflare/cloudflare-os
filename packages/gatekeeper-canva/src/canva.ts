import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ApprovalQueue,
  type ConnectHandoff,
  type Cursor,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type GitCache,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { ACCESS_TOKEN_SAFETY_MS, CONNECT_TIMEOUT_MS, NONCE_BYTES, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { ActionJournal, type ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  commitStagedCredentials, discardStagedCredentials, stageCredentials,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { TokenCursor, type CursorInjection } from "@gadgets/gatekeeper-kit/cursors";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { createPkce, mergeOAuthTokens, oauthRefresh, type OAuthTokens } from "@gadgets/gatekeeper-kit/oauth-client";
import { CanvaApi, CanvaApiError, type CanvaImageAssetResponse } from "./canva-api";
import {
  OAUTH_SCOPES, buildAuthorizeUrl, getOAuthConfig, isGrantDeath, oauthClient, type CanvaOAuthConfig,
} from "./canva-oauth";
import {
  RECONNECT_MESSAGE,
  VENDOR_ID,
  accountSource,
  fetchIdentity,
  type CanvaGrant,
  type CanvaVerifierApi,
  type PublicGrant,
  type StoredIdentity,
} from "./canva-credentials";
import {
  canvaActions,
  generationStateFromJob,
  transformationStateFromJob,
  type CanvaAction,
  type CanvaActionHost,
  type CanvaActions,
  type CanvaJobRecord,
} from "./canva-actions";
import {
  normalizeDesign, normalizeFolder, normalizeFolderItem, normalizeImageAsset, parseDesignId, parseFolderId,
} from "./canva-normalize";
import {
  designOrder, folderItemIdentity, folderItemOrder, isProvisional, pendingActionFor, pendingAssets,
  pendingCreatedDesign, pendingDesigns, pendingGeneratedDesign, pendingRow, pendingTransformedAsset,
  runningRow, type Pending, type Unmade,
} from "./canva-simulation";
import type {
  CanvaAccountSession,
  CanvaBackgroundRemovalJob,
  CanvaCreateDesignOptions,
  CanvaDesign,
  CanvaDesignSort,
  CanvaDesignType,
  CanvaFolder,
  CanvaFolderItem,
  CanvaFolderItemSort,
  CanvaGenerateDesignOptions,
  CanvaGenerationJob,
  CanvaImageAsset,
  CanvaListDesignsOptions,
  CanvaListFolderItemsOptions,
  CanvaProfile,
  CanvaRemoveBackgroundOptions,
} from "./types";
import TYPES_CODE from "./types.txt";
import CANVA_LOGO_SVG from "./canva-logo.svg";
import CANVA_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { CanvaAccountConfiguratorRpc } from "./configurator/account-configurator-types";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

const logger = createLogger<{ vendorId: string; action: number }>({
  component: "gatekeeper.canva", vendorId: VENDOR_ID,
});

type CanvaGatekeeperImplProps = {
  userObjectId: string;
};

const CANVA_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(CANVA_LOGO_SVG)}`;
const CANVA_PROJECTS_URL = "https://www.canva.com/projects";

const ACCOUNT_RESOURCE: SupportedResource = {
  // Whole-instance catch-all (matches any URL), like other single-tenant gatekeepers.
  urlPattern: "https://*",
  title: "Canva Account",
  description:
    "Whole-account access: your profile, your designs, your folders and images, and creating new designs.",
  icon: { url: CANVA_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Canva Gatekeeper Not Configured",
  "Please configure a Canva integration client ID and secret for this gatekeeper.");

// ---------------------------------------------------------------------------
// Small helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/canva");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function requireOAuthConfig(env: Env): CanvaOAuthConfig {
  const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env));
  if (!config) throw new Error("The Canva gatekeeper is not configured.");
  return config;
}

/** The grant a token response describes. Canva always issues a refresh token; a response without one is an error. */
function toGrant(tokens: OAuthTokens): CanvaGrant {
  if (!tokens.refreshToken) throw new Error("Canva did not return a refresh token.");
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: tokens.scopes ?? OAUTH_SCOPES,
  };
}

// ---------------------------------------------------------------------------
// HTTP entrypoint: the two browser-facing routes of the connect flow.

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
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env));
      if (!config) return htmlResponse(NOT_CONFIGURED_HTML, 500);

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML, 400);

      const state = `${doId}:${begun.oauthNonce}`;
      return Response.redirect(buildAuthorizeUrl(config, state, begun.challenge, begun.scopes), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const state = url.searchParams.get("state");
      if (!state) return htmlResponse(errorPageHtml("Invalid callback", "No 'state' was provided."), 400);
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return htmlResponse(errorPageHtml("Invalid callback", "Malformed 'state'."), 400);
      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );

      if (url.searchParams.get("error")) {
        // Canva declined or the user cancelled: the attempt is over, so spend its nonce.
        await stub.consumeOAuthNonce(oauthNonce);
        return htmlResponse(errorPageHtml(
          "Canva authorization failed",
          "Authorization was denied or failed. Please restart the connection flow from the Workshop."), 400);
      }

      const code = url.searchParams.get("code");
      if (!code) return htmlResponse(errorPageHtml("Invalid callback", "No 'code' was provided."), 400);

      const result = await stub.acceptAuthCode(code, oauthNonce);
      if (result === null) return htmlResponse(INVALID_LINK_HTML, 400);
      if ("refused" in result) return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 400);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
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
      displayName: "Canva",
      url: "https://www.canva.com",
      logo: { url: CANVA_LOGO_URL },
      color: "#00C4CC",
      tagline: "Browse your designs and folders, and create new designs",
      description:
        "Connect your Canva account to give Gadgets access to your designs and folders. " +
        "Build agents that find the right design, keep track of what changed, or spin up a new " +
        "design ready for you to edit.",
      providesAuth: false,
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
// UserAccount DO — holds the grant in the kit's CredentialCoordinator, which redeems Canva's
// single-use refresh token once per expiry and fences a refresh against a reconnect or revoke that
// lands while it is in flight. The connection is pinned to the Canva user who made it.

/** Metadata that rides a connect attempt from the link through the OAuth callback. */
type ConnectAttempt = {
  /** Set when this flow creates the account, as opposed to reconnecting it. */
  firstConnect?: true;
  /** The PKCE verifier the callback's code exchange must present. */
  codeVerifier: string;
  /** The connection generation when the attempt started: `connect()` is fenced on it. */
  startedUnder: string;
};

/** A reconnect's grant, held until the Workshop confirms the finishing browser was the owner's. */
type ReconnectStage = { grant: CanvaGrant; identity: StoredIdentity; startedUnder: string };

type CallbackResult =
  | { handoff: ConnectHandoff }
  | { refused: { title: string; detail: string } };

const IDENTITY_KEY = "identity";

export class UserAccount extends DurableObject<Env> {
  // No legacy migration: the pre-kit layout stored its grant under the same `credentials` key the
  // coordinator owns, with the same fields but `accessTokenExpiresAt` for `expiresAt`. The
  // coordinator reads such a record as a non-expiring grant, and the first 401 heals it through a
  // refresh that rewrites it canonically, so a dev account connected before the port keeps working.
  readonly #creds = new CredentialCoordinator<CanvaGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    refreshSkewMs: ACCESS_TOKEN_SAFETY_MS,
    // No `discardMint`: Canva does not document whether revoking one refresh token revokes the
    // whole authorization, so a mint a reconnect overtook is dropped unrevoked rather than risking
    // the connection that won.
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: CanvaGrant): Promise<CanvaGrant> => {
    logger.info("refreshing Canva access token", { event: "canva.token.refresh" });
    return oauthRefresh<CanvaGrant>(oauthClient(requireOAuthConfig(this.env)), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      isGrantDeath,
      expiredMessage: RECONNECT_MESSAGE,
    })(grant);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    putInitiation<Pick<ConnectAttempt, "firstConnect">>(this.ctx.storage.kv, initiationNonce, Date.now(),
      { firstConnect: true });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /**
   * Advance from the initiation link to the OAuth redirect: mint the OAuth-stage nonce and the PKCE
   * pair, keeping the verifier here so only this DO can redeem the code Canva hands back.
   */
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; challenge: string; scopes: string[] } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<Omit<ConnectAttempt, "firstConnect">>(
      this.ctx.storage.kv, initiationNonce, Date.now(),
      { codeVerifier: pkce.codeVerifier, startedUnder: this.#creds.connectionGeneration() });
    if (oauthNonce === null) return null;
    return { oauthNonce, challenge: pkce.codeChallenge, scopes: OAUTH_SCOPES };
  }

  /** Ends an attempt Canva refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange. Returns the handoff for the page the browser lands on, a refusal to
   * show, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;

    const config = requireOAuthConfig(this.env);
    const tokens = await oauthClient(config)
      .exchangeCode({ code, redirectUri: config.redirectUri, codeVerifier: attempt.codeVerifier })
      .catch((cause: unknown) => {
        throw new Error("Canva OAuth exchange failed.", { cause });
      });
    const grant = toGrant(tokens);

    let identity: StoredIdentity;
    try {
      identity = await fetchIdentity(grant.accessToken);
    } catch (error) {
      await this.#revokeGrant(grant);
      throw new Error("Could not read which Canva account authorized this connection. Please try again.",
        { cause: error });
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      await this.#revokeGrant(grant);
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      // The connection stays pinned to the Canva user who made it: every queued action is fenced
      // on that user, so a grant for anyone else must not become this connection's credentials.
      const pinned = kv.get<StoredIdentity>(IDENTITY_KEY);
      if (pinned !== undefined && pinned.userId !== identity.userId) {
        await this.#revokeGrant(grant);
        return {
          refused: {
            title: "That's a different Canva account",
            detail: `This connection is for ${pinned.displayName}, but Canva authorized ` +
              `${identity.displayName}. Sign in to Canva as ${pinned.displayName} and reconnect, or ` +
              `connect ${identity.displayName} as a separate account.`,
          },
        };
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). A
      // stage this one displaces is the same user's, so it is dropped unrevoked.
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
        throw new Error("The Canva account was disconnected while it was being authorized. Connect it again.",
          { cause: error });
      }
      kv.put<StoredIdentity>(IDENTITY_KEY, identity);
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its tokens with nobody: revoke them.
        const abandoned = this.#creds.stored() ?? grant;
        this.#creds.clear();
        kv.delete(IDENTITY_KEY);
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
      throw new Error("This Canva account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<StoredIdentity>(IDENTITY_KEY, staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads, refresh material projected out. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    let snapshot: CredentialsWithIdentity<CanvaGrant>;
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

  /** Adjudicates Canva's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /**
   * The Canva user this connection is pinned to. An account connected before the pin existed reads
   * it from Canva once and keeps it; the pin never moves after that.
   */
  async getIdentity(): Promise<StoredIdentity> {
    const stored = this.ctx.storage.kv.get<StoredIdentity>(IDENTITY_KEY);
    if (stored !== undefined) return stored;
    const { creds } = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    const identity = await fetchIdentity(creds.accessToken);
    this.ctx.storage.kv.put<StoredIdentity>(IDENTITY_KEY, identity);
    return identity;
  }

  /** An abandoned connect flow: no credentials ever arrived, so forget the DO entirely. */
  async alarm(): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Disconnects, local-first: the account is cleared before any call to Canva, so nothing can
   * re-arm it meanwhile; revoking the tokens at Canva is best effort afterwards.
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

  /** Revokes a grant's tokens at Canva, refresh token first; failures are logged, never fatal. */
  async #revokeGrant(grant: CanvaGrant): Promise<void> {
    const config = getOAuthConfig(this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env));
    if (!config) return;
    const client = oauthClient(config);
    const tokens: [string, "refresh_token" | "access_token"][] = [
      [grant.refreshToken, "refresh_token"], [grant.accessToken, "access_token"],
    ];
    for (const [token, tokenTypeHint] of tokens) {
      try {
        await client.revoke({ token, tokenTypeHint });
      } catch (error) {
        logger.warn("failed to revoke a Canva OAuth token", { event: "oauth.token.revoke.failed", error });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().getIdentity();
    return {
      displayName: identity.displayName,
      uniqueName: identity.userId,
      // The Connect API exposes no avatar for the connected user, so the vendor logo stands in.
      avatar: { url: CANVA_LOGO_URL },
    };
  }

  /** Canva is not offered as a sign-in identity provider (the Connect API exposes no verified email). */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // One resource granularity today: any URL is whole-account access against the connected account.
    const props: CanvaGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return { class: this.ctx.exports.CanvaGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === ACCOUNT_RESOURCE.urlPattern) {
      return {
        iframeHtml: CANVA_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new CanvaAccountConfiguratorUI()),
      };
    }
    throw new Error(`Unsupported Canva resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  /**
   * Mint a verifier representing this account. It exposes the pinned Canva identity for a future
   * per-design access check (see CanvaVerifierApi); today's observer strategy never consults it
   * (see CanvaGatekeeperImpl.addObserver), but the overseer mints one on every open, so it must
   * exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: CanvaVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.CanvaVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Vendor-specific verifier methods, trusted only after the overseer's same-vendor handoff: the
// overseer promises to pass a verifier back only to the gatekeeper that minted it.

type CanvaVerifierProps = {
  userObjectId: string;
};

@validateRpc()
export class CanvaVerifier extends WorkerEntrypoint<Env, CanvaVerifierProps> implements CanvaVerifierApi {
  async getTeamUser(): Promise<{ userId: string; teamId: string } | null> {
    try {
      const identity = await this.ctx.exports.UserAccount
        .get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId)).getIdentity();
      return { userId: identity.userId, teamId: identity.teamId };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-binding instance, runs as a facet of the Overseer.

const JOB_PREFIX = "job:";
const HOUSEKEEPING_KEY = "meta:lastHousekeeping";
// Job records older than this are dropped; Canva itself forgets a job after 24 hours.
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Generation jobs expire on Canva 24 hours after they start; a poll after that 404s. The
// transformation docs don't state a lifetime, so the same window is applied there.
const JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
const EXPIRED_JOB_ERROR = { code: "expired", message: "The job expired on Canva before it completed." };
// Rows per `next()` on a listing cursor. Canva chooses its own provider page size.
const CURSOR_PAGE_SIZE = 50;

/**
 * What a session may ask of its gatekeeper. A plain object of closures rather than the Durable
 * Object itself, so these generic helpers stay off the RPC surface the overseer sees.
 */
type CanvaSessionHost = {
  /** Runs a provider read as the connection. Reads are safe to repeat after a stale credential. */
  read<T>(op: (api: CanvaApi) => Promise<T>): Promise<T>;
  /** The Canva user the connection is pinned to: the owner every pending row shows. */
  identity(): Promise<StoredIdentity>;
  /** Stages an action for approval, fenced on the pinned Canva user. */
  submit<K extends keyof CanvaActions>(queue: ActionSubmitter, kind: K, payload: CanvaActions[K]): Promise<number>;
  /** Allocates a temporary id for a design or asset this session is about to make. */
  allocate(kind: "design" | "asset"): string;
  /** What a temporary id was allocated for, or `undefined` for an id Canva issued. */
  kindOf(id: string): "design" | "asset" | undefined;
  /** The id Canva assigned a temporary id, or the id itself. */
  resolve(id: string): string;
  /** Actions waiting for a decision, for simulation. */
  pending(): Pending;
  /** The record of an applied action that makes `ref`, if any. Not refreshed. */
  jobForRef(ref: string): CanvaJobRecord | undefined;
  /** The records of applied actions whose jobs were still running when last seen. Not refreshed. */
  runningJobs(): CanvaJobRecord[];
  getProfile(): Promise<CanvaProfile>;
  getDesign(designId: string): Promise<CanvaDesign>;
  getFolder(folderId: string): Promise<CanvaFolder>;
  getImageAsset(assetId: string): Promise<CanvaImageAsset>;
  /** What applied actions of one kind recorded, newest first, with running jobs refreshed. */
  listJobs<K extends CanvaJobRecord["kind"]>(kind: K): Promise<Extract<CanvaJobRecord, { kind: K }>[]>;
};

@validateRpc()
export class CanvaGatekeeperImpl extends DurableObject<Env, CanvaGatekeeperImplProps>
  implements Gatekeeper<CanvaAccountSession> {

  readonly #creds = accountSource(() => this.#account());
  readonly #journal = new ActionJournal<CanvaAction>(this.ctx.storage.kv, { namespace: "canva" });
  // Namespaced apart from the journal ("canva:") and the job records ("job:").
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "refs:", isProvisional });
  readonly #actionHost: CanvaActionHost = {
    refs: this.#refs,
    write: op => this.#creds.run((creds, read) => op(new CanvaApi(async () => creds.accessToken), read)),
    read: op => this.#read(op),
    recordJob: record => this.ctx.storage.kv.put(`${JOB_PREFIX}${record.actionId}`, record),
    recordedJob: actionId => this.ctx.storage.kv.get<CanvaJobRecord>(`${JOB_PREFIX}${actionId}`),
  };
  readonly #actions = canvaActions.bind(this.#journal, this.#actionHost);

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  readonly #sessionHost: CanvaSessionHost = {
    read: op => this.#read(op),
    identity: () => this.#account().getIdentity(),
    submit: (queue, kind, payload) => this.#submit(queue, kind, payload),
    allocate: kind => this.#refs.allocate(sequence => `~${sequence}`, { kind }),
    kindOf: id => this.#refs.kindOf(id) as "design" | "asset" | undefined,
    resolve: id => this.#refs.resolve(id),
    pending: () => this.#journal.listPending(),
    jobForRef: ref => this.#jobForRef(ref),
    runningJobs: () => this.#runningJobs(),
    getProfile: () => this.#getProfile(),
    getDesign: id => this.#getDesign(id),
    getFolder: id => this.#getFolder(id),
    getImageAsset: id => this.#getImageAsset(id),
    listJobs: kind => this.#listJobs(kind),
  };

  #read<T>(op: (api: CanvaApi) => Promise<T>): Promise<T> {
    return this.#creds.run(creds => op(new CanvaApi(async () => creds.accessToken)), { replayable: true });
  }

  async describe(): Promise<ResourceDescription> {
    const identity = await this.#account().getIdentity();
    return {
      url: CANVA_PROJECTS_URL,
      title: `${identity.displayName}'s Canva`,
      snippet: "Whole-account access: profile, designs, folders and images, design creation and AI.",
      suggestedBindingName: "CANVA_ACCOUNT",
      tsType: "CanvaAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CanvaAccountSession> {
    return new CanvaAccountSessionImpl(this.#sessionHost, approvalQueue.dup());
  }

  /**
   * Observer tracking: private-only (docs/observers.md §9, strategy A). Designs are shared inside
   * Canva, and sharing a gadget in the Workshop changes nothing there, so a collaborator opening a
   * shared gadget would read designs Canva never showed them. The Connect API offers no way to grant
   * that access or to tell what another Canva user may see, so nobody but the owner may observe.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "A gadget that reads a Canva account cannot be shared: sharing it in the Workshop would not " +
      "share the designs in Canva, and the Canva connector cannot check what a collaborator may see.");
  }

  async removeObserver(_id: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Reads the session delegates to

  async #getProfile(): Promise<CanvaProfile> {
    const [identity, capabilities] = await Promise.all([
      this.#account().getIdentity(),
      this.#read(api => api.getCapabilities()),
    ]);
    return {
      userId: identity.userId,
      teamId: identity.teamId,
      displayName: identity.displayName,
      canGenerateDesigns: capabilities.capabilities.includes("design_generation"),
      canRemoveBackgrounds: capabilities.capabilities.includes("background_removal"),
    };
  }

  async #getDesign(designId: string): Promise<CanvaDesign> {
    const id = this.#refs.resolve(designId);
    if (isProvisional(id)) return await this.#pendingDesign(id);
    try {
      return normalizeDesign(await this.#read(api => api.getDesign(id)));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva design found with id "${designId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
  }

  async #getFolder(folderId: string): Promise<CanvaFolder> {
    try {
      return normalizeFolder(await this.#read(api => api.getFolder(folderId)));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva folder found with id "${folderId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
  }

  async #getImageAsset(assetId: string): Promise<CanvaImageAsset> {
    const id = this.#refs.resolve(assetId);
    if (isProvisional(id)) return await this.#pendingAsset(id);
    let asset: CanvaImageAssetResponse;
    try {
      asset = await this.#read(api => api.getAsset(id));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva asset found with id "${assetId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
    if (asset.type === "video") throw new Error(`Canva asset "${assetId}" is a video, not an image.`);
    return normalizeImageAsset(asset);
  }

  // -------------------------------------------------------------------------
  // Temporary ids Canva has not yet assigned: a row from the pending action, or from the job the
  // applied action started, which a read of its id brings up to date.

  async #pendingDesign(ref: string): Promise<CanvaDesign> {
    if (this.#refs.kindOf(ref) === "asset") throw new Error(`${ref} is the temporary id of an image asset, not a design.`);
    const me = await this.#account().getIdentity();
    const action = pendingActionFor(ref, this.#journal.listPending());
    if (action !== undefined) {
      const row = pendingRow(action, me);
      if (row.type === "design") return row.design;
    }
    const job = this.#jobForRef(ref);
    if (job?.kind === "generateDesign") {
      const current = await this.#settleJob(job);
      if (current.status === "success" && current.design) return current.design;
      if (current.status === "failed") {
        throw new Error(`Canva did not generate design ${ref}: ${current.error?.message ?? "the job failed"}` +
          `${current.error ? ` (${current.error.code})` : ""}.`);
      }
      const row = runningRow(current, me);
      if (row?.type === "design") return row.design;
    }
    throw new Error(`No pending Canva design has the temporary id ${ref}; its creation may have been rejected.`);
  }

  async #pendingAsset(ref: string): Promise<CanvaImageAsset> {
    if (this.#refs.kindOf(ref) === "design") throw new Error(`${ref} is the temporary id of a design, not an image asset.`);
    const me = await this.#account().getIdentity();
    const action = pendingActionFor(ref, this.#journal.listPending());
    if (action?.kind === "removeBackground") return pendingTransformedAsset(action.payload, me);
    const job = this.#jobForRef(ref);
    if (job?.kind === "removeBackground") {
      const current = await this.#settleJob(job);
      if (current.status === "success" && current.asset) return current.asset;
      if (current.status === "failed") {
        throw new Error(`Canva did not produce asset ${ref}: ${current.error?.message ?? "the job failed"}` +
          `${current.error ? ` (${current.error.code})` : ""}.`);
      }
      const row = runningRow(current, me);
      if (row?.type === "image") return row.image;
    }
    throw new Error(`No pending Canva image asset has the temporary id ${ref}; its removal may have been rejected.`);
  }

  #jobForRef(ref: string): CanvaJobRecord | undefined {
    for (const [, record] of this.ctx.storage.kv.list<CanvaJobRecord>({ prefix: JOB_PREFIX })) {
      if (record.ref === ref) return record;
    }
    return undefined;
  }

  #runningJobs(): CanvaJobRecord[] {
    const running: CanvaJobRecord[] = [];
    for (const [, record] of this.ctx.storage.kv.list<CanvaJobRecord>({ prefix: JOB_PREFIX })) {
      if (record.kind !== "createDesign" && record.status === "in_progress") running.push(record);
    }
    return running;
  }

  // -------------------------------------------------------------------------
  // Jobs: what applied actions recorded, refreshed from Canva while still running

  async #listJobs<K extends CanvaJobRecord["kind"]>(kind: K): Promise<Extract<CanvaJobRecord, { kind: K }>[]> {
    const records: CanvaJobRecord[] = [];
    for (const [, record] of this.ctx.storage.kv.list<CanvaJobRecord>({ prefix: JOB_PREFIX })) {
      if (record.kind === kind) records.push(await this.#settleJob(record));
    }
    // Filtered on `kind` above, which is what the return type states.
    return records.toSorted((a, b) => b.at - a.at) as Extract<CanvaJobRecord, { kind: K }>[];
  }

  /**
   * A job record brought up to date: one still running is polled, the result stored over it, and
   * a finished job's temporary id bound to the id Canva assigned.
   */
  async #settleJob<R extends CanvaJobRecord>(record: R): Promise<R> {
    if (record.kind === "createDesign" || record.status !== "in_progress" || record.jobId === null) return record;
    const current = await this.#refreshJob(record);
    this.ctx.storage.kv.put(`${JOB_PREFIX}${current.actionId}`, current);
    const made = current.kind === "generateDesign" ? current.design?.id
      : current.kind === "removeBackground" ? current.asset?.id : undefined;
    if (made !== undefined) this.#refs.bind(current.ref, made);
    // `#refreshJob` keeps the record's kind, which is what `R` states.
    return current as R;
  }

  async #refreshJob(record: Exclude<CanvaJobRecord, { kind: "createDesign" }>): Promise<CanvaJobRecord> {
    const jobId = record.jobId!;
    try {
      if (record.kind === "generateDesign") {
        return { ...record, ...generationStateFromJob(await this.#read(api => api.getDesignGeneration(jobId))) };
      }
      return { ...record, ...transformationStateFromJob(await this.#read(api => api.getImageTransformation(jobId))) };
    } catch (error) {
      // Canva forgets a job 24 hours after it starts, so a 404 past that point is the job aging out
      // rather than vanishing; an earlier 404 is passed through since it means something is wrong.
      const expired = error instanceof CanvaApiError && error.status === 404
        && Date.now() - record.at > JOB_LIFETIME_MS;
      if (!expired) throw error;
      return { ...record, status: "failed", error: EXPIRED_JOB_ERROR };
    }
  }

  // -------------------------------------------------------------------------
  // Action lifecycle

  /**
   * Stages an action, fenced on the Canva user the connection is pinned to rather than the
   * connection generation: a reconnect as the same user must not strand what is waiting, and the
   * account refuses a reconnect as anyone else.
   */
  async #submit<K extends keyof CanvaActions>(queue: ActionSubmitter, kind: K, payload: CanvaActions[K]): Promise<number> {
    const { userId } = await this.#account().getIdentity();
    return await this.#actions.submit(queue, kind, payload, { fence: { generation: userId } });
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    this.#housekeep();
    const { userId } = await this.#account().getIdentity();
    await this.#actions.apply(actionId, { generation: userId });
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    await this.#actions.reject(actionId);
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // The Connect API can delete neither a design nor an asset, so the best we can do is point at it.
    const record = this.ctx.storage.kv.get<CanvaJobRecord>(`${JOB_PREFIX}${actionId}`);
    if (!record) {
      return { message: "This action has not been applied, so there is nothing to revert.", canRetry: false };
    }
    switch (record.kind) {
      case "createDesign":
        return {
          message: "Canva designs cannot be deleted through the API, so this creation must be undone by hand. " +
            `It is at ${record.design.editUrl ?? `https://www.canva.com/design/${record.design.id}/edit`}; ` +
            "move it to the trash from the Canva editor.",
          canRetry: false,
        };
      case "generateDesign": {
        const where = record.design ? ` It is at ${record.design.editUrl}; move it to the trash from the Canva editor.` : "";
        return {
          message: `Canva designs cannot be deleted through the API, so this generation must be undone by hand.${where} ` +
            "The AI credits it consumed are not refunded.",
          canRetry: false,
        };
      }
      case "removeBackground": {
        const which = record.asset ? ` The new asset is "${record.asset.name}" (id ${record.asset.id}).` : "";
        return {
          message: "The Connect API cannot delete an asset, so remove the transformed image from your Canva " +
            `Uploads by hand if you don't want it.${which} The AI credits it consumed are not refunded.`,
          canRetry: false,
        };
      }
    }
  }

  /** Drops job records older than the retention window. Runs at most every few hours, from apply. */
  #housekeep(): void {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    if (now - (kv.get<number>(HOUSEKEEPING_KEY) ?? 0) < HOUSEKEEPING_INTERVAL_MS) return;
    kv.put(HOUSEKEEPING_KEY, now);
    for (const [key, record] of kv.list<CanvaJobRecord>({ prefix: JOB_PREFIX })) {
      if (record.at < now - JOB_RETENTION_MS) kv.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Session implementation

function disposeQueue(queue: RpcStub<ApprovalQueue>): void {
  (queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

const DESIGN_OWNERSHIPS = new Set(["owned", "shared", "any"]);
const DESIGN_SORTS = new Set([
  "relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending",
]);
const FOLDER_ITEM_TYPES = new Set(["folder", "design", "image"]);
const FOLDER_ITEM_SORTS = new Set([
  "created_ascending", "created_descending", "modified_ascending", "modified_descending",
  "title_ascending", "title_descending",
]);
const PRESET_DESIGN_TYPES = new Set(["doc", "whiteboard", "presentation"]);
// Canva's documented bounds for custom design dimensions, in pixels.
const CUSTOM_DESIGN_MIN_PX = 40;
const CUSTOM_DESIGN_MAX_PX = 8000;
// Canva's documented bounds for design generation requests.
const GENERATION_DESIGN_TYPES = new Set(["doc", "presentation"]);
const GENERATION_BRIEF_MAX = 5000;
const GENERATION_SECTIONS_MAX = 100;
const GENERATION_SECTION_TITLE_MAX = 255;
const GENERATION_SECTION_DESCRIPTION_MAX = 2000;
const GENERATION_SECTION_POINTS_MAX = 50;
// Canva's documented bound for a transformed asset's name.
const ASSET_NAME_MAX = 255;

function isNonEmptyString(value: unknown, max = Infinity): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

/**
 * The design type a caller asked for, rebuilt from its known members. An extra property on the
 * caller's object would otherwise be stored, sent to Canva, and missing from the approval card.
 */
function parseDesignType(value: unknown, method: string): CanvaDesignType {
  if (typeof value === "string" && PRESET_DESIGN_TYPES.has(value)) return value as CanvaDesignType;
  if (value && typeof value === "object" && "width" in value && "height" in value) {
    const { width, height } = value as { width: unknown; height: unknown };
    for (const [label, px] of [["width", width], ["height", height]] as const) {
      if (!Number.isInteger(px) || (px as number) < CUSTOM_DESIGN_MIN_PX || (px as number) > CUSTOM_DESIGN_MAX_PX) {
        throw new Error(`${method}: ${label} must be an integer between ${CUSTOM_DESIGN_MIN_PX} and ${CUSTOM_DESIGN_MAX_PX} pixels.`);
      }
    }
    return { width: width as number, height: height as number };
  }
  throw new Error(`${method}: designType must be "doc", "whiteboard", "presentation", or { width, height } in pixels.`);
}

@validateRpc()
class CanvaAccountSessionImpl extends RpcTarget implements CanvaAccountSession {
  #host: CanvaSessionHost;
  #queue: RpcStub<ApprovalQueue>;

  constructor(host: CanvaSessionHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  /**
   * A listing cursor over a Canva continuation-token endpoint. The cursor is walked after this
   * call returns, so it takes its own queue stub and releases it when the walk is dropped; every
   * page is authorized as an observation before it leaves, an empty one included.
   */
  #cursor<T>(listing: {
    title: string;
    describe(count: number): string;
    describeEmpty: string;
    fetchPage(api: CanvaApi, token: string | undefined): Promise<{ items: T[]; continuation?: string }>;
    /** Rows pending actions add, merged into Canva's pages at their sort positions. */
    inject?: CursorInjection<T>;
  }): Cursor<T> {
    const queue = this.#queue.dup();
    return new TokenCursor<T>({
      pageSize: CURSOR_PAGE_SIZE,
      dispose: () => disposeQueue(queue),
      ...(listing.inject ? { inject: listing.inject } : {}),
      fetchPage: async token => {
        const page = await this.#host.read(api => listing.fetchPage(api, token));
        return { items: page.items, ...(page.continuation !== undefined ? { nextToken: page.continuation } : {}) };
      },
      authorizePage: async (items, { terminal }) => {
        await queue.authorizeObservation({
          title: listing.title,
          description: items.length === 0
            ? (terminal ? listing.describeEmpty : "Scanned a window of results; none were visible.")
            : listing.describe(items.length),
        });
      },
    });
  }

  /**
   * A pending design as a page serves it, which may be long after the cursor was built: the pending
   * row while the action waits or its job runs, and nothing once it was rejected or failed. Once
   * Canva has assigned the id, the row takes it, so the cursor's duplicate check drops whichever of
   * this row and Canva's lists second, but it stays synthetic: nothing Canva returned is served
   * through the injection, which the cursor does not authorize as an observation. The row's times
   * are kept so it holds its sort position.
   */
  #revalidateDesign(design: CanvaDesign, me: StoredIdentity): CanvaDesign | null {
    const host = this.#host;
    const resolved = host.resolve(design.id);
    if (!isProvisional(resolved)) return { ...design, id: resolved };
    const action = pendingActionFor(resolved, host.pending());
    if (action !== undefined) {
      const row = pendingRow(action, me);
      return row.type === "design" ? row.design : null;
    }
    const job = host.jobForRef(resolved);
    const row = job && runningRow(job, me);
    return row?.type === "design" ? { ...row.design, createdAt: design.createdAt, updatedAt: design.updatedAt } : null;
  }

  /** As `#revalidateDesign`, for the asset a pending background removal makes. */
  #revalidateAsset(asset: CanvaImageAsset, me: StoredIdentity): CanvaImageAsset | null {
    const host = this.#host;
    const resolved = host.resolve(asset.id);
    if (!isProvisional(resolved)) return { ...asset, id: resolved };
    const action = pendingActionFor(resolved, host.pending());
    if (action?.kind === "removeBackground") return pendingTransformedAsset(action.payload, me);
    const job = host.jobForRef(resolved);
    const row = job && runningRow(job, me);
    return row?.type === "image" ? { ...row.image, createdAt: asset.createdAt, updatedAt: asset.updatedAt } : null;
  }

  /** What has no Canva id yet: actions awaiting a decision, and jobs still running after approval. */
  #unmade(): Unmade {
    return { pending: this.#host.pending(), running: this.#host.runningJobs() };
  }

  /** A design listing's pending rows, or none for an order a pending row cannot be placed in. */
  #injectDesigns(me: StoredIdentity, sortBy: CanvaDesignSort): CursorInjection<CanvaDesign> | undefined {
    const compare = designOrder(sortBy);
    if (compare === undefined) return undefined;
    const host = this.#host;
    return {
      items: pendingDesigns(this.#unmade(), me, id => host.resolve(id)).toSorted(compare),
      compare,
      revalidate: design => this.#revalidateDesign(design, me),
      identity: design => design.id,
    };
  }

  /**
   * A folder listing's pending rows: new designs land in the Projects root and transformed images
   * in Uploads, so only those two folders have any. Honors the listing's item types.
   */
  #injectFolderItems(me: StoredIdentity, folderId: string, itemTypes: readonly string[] | undefined,
                     sortBy: CanvaFolderItemSort): CursorInjection<CanvaFolderItem> | undefined {
    const host = this.#host;
    const wants = (type: string) => itemTypes === undefined || itemTypes.includes(type);
    const resolve = (id: string) => host.resolve(id);
    const items: CanvaFolderItem[] = folderId === "root" || folderId === "projects"
      ? wants("design") ? pendingDesigns(this.#unmade(), me, resolve).map(design => ({ type: "design", design })) : []
      : folderId === "uploads" && wants("image")
        ? pendingAssets(this.#unmade(), me, resolve).map(image => ({ type: "image", image }))
        : [];
    if (items.length === 0) return undefined;
    const compare = folderItemOrder(sortBy);
    return {
      items: items.toSorted(compare),
      compare,
      revalidate: item => {
        if (item.type === "design") {
          const design = this.#revalidateDesign(item.design, me);
          return design && { type: "design", design };
        }
        if (item.type === "image") {
          const image = this.#revalidateAsset(item.image, me);
          return image && { type: "image", image };
        }
        return item;
      },
      identity: folderItemIdentity,
    };
  }

  async getProfile(): Promise<CanvaProfile> {
    const profile = await this.#host.getProfile();
    await this.#queue.authorizeObservation({
      title: "Read Canva profile",
      description: `Read the connected Canva account's profile (${profile.displayName}) and plan capabilities.`,
    });
    return profile;
  }

  @skipRpcValidation()
  async listDesigns(options?: CanvaListDesignsOptions): Promise<Cursor<CanvaDesign>> {
    const opts = options ?? {};
    if (opts.query !== undefined && typeof opts.query !== "string") {
      throw new Error("listDesigns(): query must be a string when provided.");
    }
    if (opts.ownership !== undefined && !DESIGN_OWNERSHIPS.has(opts.ownership)) {
      throw new Error(`listDesigns(): ownership must be one of "owned", "shared", or "any".`);
    }
    if (opts.sortBy !== undefined && !DESIGN_SORTS.has(opts.sortBy)) {
      throw new Error(`listDesigns(): sortBy must be one of ${[...DESIGN_SORTS].map(s => `"${s}"`).join(", ")}.`);
    }
    // The documented default, sent to Canva rather than left to its own (relevance, even with no
    // query), so the order the pending rows merge into is the order Canva returned.
    const sortBy: CanvaDesignSort = opts.sortBy ?? (opts.query !== undefined ? "relevance" : "modified_descending");
    const query = { query: opts.query, ownership: opts.ownership, sort_by: sortBy };
    const what = opts.query ? `designs matching "${opts.query}"` : "designs";
    // A search cannot say whether a pending design would match, and a design the agent makes is
    // its own, so only an unqueried listing that admits owned designs shows pending ones.
    const inject = opts.query === undefined && opts.ownership !== "shared"
      ? this.#injectDesigns(await this.#host.identity(), sortBy)
      : undefined;
    return this.#cursor<CanvaDesign>({
      ...(inject ? { inject } : {}),
      title: opts.query ? `Search Canva designs for "${opts.query}"` : "List Canva designs",
      describe: count => `Read ${count} ${what} from the connected Canva account` +
        `${opts.ownership && opts.ownership !== "any" ? ` (${opts.ownership})` : ""}.`,
      describeEmpty: `Listed ${what}; there were none.`,
      fetchPage: async (api, token) => {
        const page = await api.listDesigns({ ...query, continuation: token });
        return { items: page.items.map(normalizeDesign), continuation: page.continuation };
      },
    });
  }

  async getDesign(designIdOrUrl: string): Promise<CanvaDesign> {
    const designId = parseDesignId(designIdOrUrl);
    if (!designId) {
      throw new Error(`Invalid Canva design "${designIdOrUrl}". Pass a design id or a canva.com/design URL.`);
    }
    const design = await this.#host.getDesign(designId);
    const pending = design.editUrl === null;
    await this.#queue.authorizeObservation({
      title: `Read design "${design.title ?? design.id}"`,
      description: pending
        ? `Read the pending Canva design ${design.id}, which Canva has not made yet.`
        : `Read metadata for the Canva design "${design.title ?? design.id}".`,
    });
    return design;
  }

  @skipRpcValidation()
  async createDesign(options: CanvaCreateDesignOptions): Promise<CanvaDesign> {
    if (!options || typeof options !== "object") throw new Error("createDesign(): options are required.");
    const designType = parseDesignType(options.designType, "createDesign()");
    if (options.title !== undefined && !isNonEmptyString(options.title)) {
      throw new Error("createDesign(): title must be a non-empty string when provided.");
    }
    if (options.assetId !== undefined && !isNonEmptyString(options.assetId)) {
      throw new Error("createDesign(): assetId must be a non-empty string when provided.");
    }
    const assetId = options.assetId === undefined ? undefined : this.#assetRef(options.assetId.trim(), "createDesign()");
    const me = await this.#host.identity();
    // Rebuilt from known members: nothing else the caller's object carried is stored or sent.
    const payload: CanvaActions["createDesign"] = {
      ref: this.#host.allocate("design"),
      submittedAt: Date.now(),
      designType,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
    };
    await this.#host.submit(this.#queue, "createDesign", payload);
    return pendingCreatedDesign(payload, me);
  }

  /**
   * An asset id an action will send to Canva: one Canva issued, or the temporary id of a pending
   * background removal, which the action then waits for. A design's temporary id is refused here,
   * with a message that says so, rather than at apply.
   */
  #assetRef(assetId: string, method: string): string {
    const resolved = this.#host.resolve(assetId);
    if (isProvisional(resolved) && this.#host.kindOf(resolved) === "design") {
      throw new Error(`${method}: ${assetId} is the temporary id of a design, not of an image asset.`);
    }
    return resolved;
  }

  @skipRpcValidation()
  async generateDesign(options: CanvaGenerateDesignOptions): Promise<CanvaDesign> {
    if (!options || typeof options !== "object") throw new Error("generateDesign(): options are required.");
    const { brief, designType, outline } = options;
    if (!isNonEmptyString(brief, GENERATION_BRIEF_MAX)) {
      throw new Error(`generateDesign(): brief must be a non-empty string of at most ${GENERATION_BRIEF_MAX} characters.`);
    }
    if (typeof designType !== "string" || !GENERATION_DESIGN_TYPES.has(designType)) {
      throw new Error(`generateDesign(): designType must be "doc" or "presentation".`);
    }
    let sections: CanvaGenerateDesignOptions["outline"] | undefined;
    if (outline !== undefined) {
      if (designType !== "presentation") throw new Error("generateDesign(): an outline is only valid for presentations.");
      const given = outline?.sections;
      if (!Array.isArray(given) || given.length === 0 || given.length > GENERATION_SECTIONS_MAX) {
        throw new Error(`generateDesign(): outline.sections must have 1 to ${GENERATION_SECTIONS_MAX} entries.`);
      }
      sections = {
        sections: given.map((section, index) => {
          const at = `outline.sections[${index}]`;
          if (!section || typeof section !== "object") throw new Error(`generateDesign(): ${at} must be an object.`);
          if (!isNonEmptyString(section.title, GENERATION_SECTION_TITLE_MAX)) {
            throw new Error(`generateDesign(): ${at}.title must be 1 to ${GENERATION_SECTION_TITLE_MAX} characters.`);
          }
          if (section.description !== undefined && !isNonEmptyString(section.description, GENERATION_SECTION_DESCRIPTION_MAX)) {
            throw new Error(`generateDesign(): ${at}.description must be 1 to ${GENERATION_SECTION_DESCRIPTION_MAX} characters.`);
          }
          if (section.points !== undefined && (!Array.isArray(section.points)
              || section.points.length > GENERATION_SECTION_POINTS_MAX
              || section.points.some(point => typeof point !== "string"))) {
            throw new Error(`generateDesign(): ${at}.points must be an array of at most ${GENERATION_SECTION_POINTS_MAX} strings.`);
          }
          // Rebuilt from known members, as the design type is.
          return {
            title: section.title,
            ...(section.description !== undefined ? { description: section.description } : {}),
            ...(section.points !== undefined ? { points: [...section.points] } : {}),
          };
        }),
      };
    }
    const duplicate = this.#host.pending().find(({ action }) => action.kind === "generateDesign"
      && action.payload.brief === brief && action.payload.designType === designType);
    if (duplicate !== undefined) {
      throw new Error(`generateDesign(): a ${designType} from this brief is already waiting for approval as design ` +
        `${duplicate.action.payload.ref}. Read it with getDesign("${duplicate.action.payload.ref}") rather than ` +
        "asking again, which would spend credits twice.");
    }
    const me = await this.#host.identity();
    const payload: CanvaActions["generateDesign"] = {
      ref: this.#host.allocate("design"),
      submittedAt: Date.now(),
      brief, designType, ...(sections !== undefined ? { outline: sections } : {}),
    };
    await this.#host.submit(this.#queue, "generateDesign", payload);
    return pendingGeneratedDesign(payload, me);
  }

  async listGeneratedDesigns(): Promise<CanvaGenerationJob[]> {
    const jobs = (await this.#host.listJobs("generateDesign")).map(record => ({
      id: record.jobId,
      designId: record.ref,
      brief: record.brief,
      designType: record.designType,
      startedAt: new Date(record.at).toISOString(),
      status: record.status,
      design: record.design ?? null,
      error: record.error ?? null,
    }));
    const finished = jobs.filter(job => job.status === "success").length;
    await this.#queue.authorizeObservation({
      title: "Read Canva generation jobs",
      description: `Read ${jobs.length} design generation job(s) started from this connection (${finished} finished).`,
    });
    return jobs;
  }

  async getImageAsset(assetId: string): Promise<CanvaImageAsset> {
    if (!isNonEmptyString(assetId)) throw new Error("getImageAsset(): assetId must be a non-empty string.");
    const asset = await this.#host.getImageAsset(assetId.trim());
    await this.#queue.authorizeObservation({
      title: `Read image asset "${asset.name}"`,
      description: isProvisional(asset.id)
        ? `Read the pending Canva image asset ${asset.id}, which Canva has not made yet.`
        : `Read metadata for the Canva image asset "${asset.name}".`,
    });
    return asset;
  }

  @skipRpcValidation()
  async removeBackground(assetId: string, options?: CanvaRemoveBackgroundOptions): Promise<CanvaImageAsset> {
    if (!isNonEmptyString(assetId)) throw new Error("removeBackground(): assetId must be a non-empty string.");
    const name = options?.name;
    if (name !== undefined && !isNonEmptyString(name, ASSET_NAME_MAX)) {
      throw new Error(`removeBackground(): name must be 1 to ${ASSET_NAME_MAX} characters when provided.`);
    }
    // Read the source first so the approval card can name it, and so a video or a missing asset is
    // refused before anything is queued. This read is itself an observation. The source may be the
    // pending result of an earlier removal, which this one then waits for.
    const source = await this.getImageAsset(this.#assetRef(assetId.trim(), "removeBackground()"));
    const duplicate = this.#host.pending().find(({ action }) => action.kind === "removeBackground"
      && this.#host.resolve(action.payload.assetId) === source.id);
    if (duplicate !== undefined) {
      throw new Error(`removeBackground(): this image's background is already being removed, as asset ` +
        `${duplicate.action.payload.ref}, waiting for approval. Read it with getImageAsset("${duplicate.action.payload.ref}") ` +
        "rather than asking again, which would spend credits twice.");
    }
    const me = await this.#host.identity();
    const payload: CanvaActions["removeBackground"] = {
      ref: this.#host.allocate("asset"),
      submittedAt: Date.now(),
      assetId: source.id,
      sourceName: source.name,
      sourceDimensions: source.dimensions,
      ...(name !== undefined ? { name } : {}),
    };
    await this.#host.submit(this.#queue, "removeBackground", payload);
    return pendingTransformedAsset(payload, me);
  }

  async listBackgroundRemovals(): Promise<CanvaBackgroundRemovalJob[]> {
    const jobs = (await this.#host.listJobs("removeBackground")).map(record => ({
      id: record.jobId,
      assetId: record.ref,
      sourceAssetId: record.sourceAssetId,
      startedAt: new Date(record.at).toISOString(),
      status: record.status,
      asset: record.asset ?? null,
      error: record.error ?? null,
    }));
    const finished = jobs.filter(job => job.status === "success").length;
    await this.#queue.authorizeObservation({
      title: "Read Canva background removal jobs",
      description: `Read ${jobs.length} background removal job(s) started from this connection (${finished} finished).`,
    });
    return jobs;
  }

  async getFolder(folderIdOrUrl: string): Promise<CanvaFolder> {
    const folderId = parseFolderId(folderIdOrUrl);
    if (!folderId) {
      throw new Error(`Invalid Canva folder "${folderIdOrUrl}". Pass a folder id (or "root") or a canva.com/folder URL.`);
    }
    const folder = await this.#host.getFolder(folderId);
    await this.#queue.authorizeObservation({
      title: `Read folder "${folder.name}"`,
      description: `Read metadata for the Canva folder "${folder.name}".`,
    });
    return folder;
  }

  @skipRpcValidation()
  async listFolderItems(folderIdOrUrl: string, options?: CanvaListFolderItemsOptions): Promise<Cursor<CanvaFolderItem>> {
    const folderId = typeof folderIdOrUrl === "string" ? parseFolderId(folderIdOrUrl) : null;
    if (!folderId) {
      throw new Error(`Invalid Canva folder "${String(folderIdOrUrl)}". Pass a folder id (or "root") or a canva.com/folder URL.`);
    }
    const opts = options ?? {};
    let itemTypes: string[] | undefined;
    if (opts.itemTypes !== undefined) {
      if (!Array.isArray(opts.itemTypes) || opts.itemTypes.length === 0) {
        throw new Error("listFolderItems(): itemTypes must be a non-empty array when provided.");
      }
      for (const type of opts.itemTypes) {
        if (!FOLDER_ITEM_TYPES.has(type)) {
          throw new Error(`listFolderItems(): unknown item type "${type}". Valid types: folder, design, image.`);
        }
      }
      itemTypes = [...opts.itemTypes];
    }
    if (opts.sortBy !== undefined && !FOLDER_ITEM_SORTS.has(opts.sortBy)) {
      throw new Error(`listFolderItems(): sortBy must be one of ${[...FOLDER_ITEM_SORTS].map(s => `"${s}"`).join(", ")}.`);
    }
    const sortBy = opts.sortBy;
    const kinds = itemTypes ? ` (${itemTypes.join(", ")})` : "";
    const inject = this.#injectFolderItems(await this.#host.identity(), folderId, itemTypes,
      sortBy ?? "modified_descending");
    return this.#cursor<CanvaFolderItem>({
      ...(inject ? { inject } : {}),
      title: "List Canva folder contents",
      describe: count => `Read ${count} item(s) from Canva folder "${folderId}"${kinds}.`,
      describeEmpty: `Listed Canva folder "${folderId}"${kinds}; it was empty.`,
      fetchPage: async (api, token) => {
        const page = await api.listFolderItems(folderId, { item_types: itemTypes, sort_by: sortBy, continuation: token });
        return { items: page.items.map(normalizeFolderItem), continuation: page.continuation };
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Resource configurator — the whole-account resource has nothing to choose, so the UI only confirms
// what is being connected and reports the canonical resource URL.

@validateRpc()
class CanvaAccountConfiguratorUI extends RpcTarget implements CanvaAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return CANVA_PROJECTS_URL;
  }
}
