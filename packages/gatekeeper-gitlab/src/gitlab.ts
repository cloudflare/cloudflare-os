// The GitLab gatekeeper's main module: the HTTP entrypoint (connect URL and OAuth callback), the
// vendor and per-account entrypoints, the account Durable Object that holds the OAuth grant, and
// the observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// gitlab-gatekeeper.ts and are re-exported here so wrangler finds every class on the main module.
//
// A mirror of gatekeeper-github (see plans/gitlab-gatekeeper.md). What differs is instance
// configuration (any GitLab, optionally behind Cloudflare Access) and credentials: GitLab access
// tokens expire and refresh tokens rotate, so `UserAccount` keeps its grant in the kit's
// `CredentialCoordinator`, which redeems a refresh token once and persists the rotated pair
// before serving either.

import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, NONCE_BYTES, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CredentialCoordinator,
  isConnectionSuperseded,
  isCredentialsExpired,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import {
  GitLabApiError,
  buildAuthorizeUrl,
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
  type GitLabOAuthGrant,
} from "./gitlab-api";
import {
  AUTH_SCOPES,
  OAUTH_SCOPES,
  VENDOR_ID,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  gitlabInstance,
  instanceUrl,
  oauthApp,
  supportedResources,
  withAccountApi,
  type AccountCredentials,
  type Env,
  type GitLabApiRunner,
  type GitLabGatekeeperImplProps,
} from "./gitlab-env";
import { parseResourceUrl } from "./gitlab-normalize";
import {
  GitLabIssueConfiguratorUI,
  GitLabMergeRequestConfiguratorUI,
  GitLabProjectConfiguratorUI,
} from "./gitlab-configurators";
import GITLAB_LOGO_SVG from "./gitlab-logo.svg";
import TYPES_CODE from "./types.txt";
import GITLAB_ISSUE_CONFIGURATOR_HTML from "./generated/gitlab-issue-configurator-ui.txt";
import GITLAB_MERGE_REQUEST_CONFIGURATOR_HTML from "./generated/gitlab-merge-request-configurator-ui.txt";
import GITLAB_PROJECT_CONFIGURATOR_HTML from "./generated/gitlab-project-configurator-ui.txt";
import { obsContext } from "./observability";

export { GitLabGatekeeperImpl } from "./gitlab-gatekeeper";
export { GitLabIssueImpl, GitLabMergeRequestImpl, GitLabProjectSessionImpl } from "./gitlab-sessions";

const logger = obsContext.createLogger({ component: "gatekeeper.gitlab", vendorId: VENDOR_ID });

const GITLAB_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GITLAB_LOGO_SVG)}`;

/** Auth-only sign-in grants self-destruct shortly after the email is read. */
const EPHEMERAL_GRANT_LIFETIME_MS = 2 * 60 * 1000;

/**
 * What a connect attempt carries from the authorize redirect to the callback, with the kit's
 * OAuth-stage nonce (`advanceToOAuth`).
 */
type ConnectAttempt = {
  codeVerifier: string;
  /**
   * The `redirect_uri` the authorize request carried, which the code exchange must repeat
   * exactly. Usually this Worker's own callback; on a Worker Preview it is the stable Worker's,
   * which relays the callback here (`PreviewOAuth`).
   */
  redirectUri: string;
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /**
   * Whether the grant is staged rather than made live. Fixed when the attempt starts, so
   * committing one reconnect while another is in flight does not change how that other lands.
   */
  reconnect: boolean;
};

const NOT_CONFIGURED_HTML = errorPageHtml(
  "GitLab gatekeeper not configured",
  "Please configure a GitLab OAuth application ID and secret for this gatekeeper.");

/**
 * The OAuth callback policy for this Worker: direct in production, a relay through the stable
 * Worker on a Worker Preview. A misconfiguration (half the preview variables set) is a 503 with
 * the kit's display-safe message rather than an authorize request GitLab would refuse anyway.
 */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "GitLab OAuth callback is not configured.",
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return htmlResponse(NOT_CONFIGURED_HTML);
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      const begun = await accountFor(ctx, doId)?.beginOAuthFlow(initiationNonce, previewOAuth.redirectUri);
      if (!begun) {
        return htmlResponse(INVALID_LINK_HTML);
      }

      // The authorize page is on the browser-facing instance: the user's own session must reach it.
      return Response.redirect(buildAuthorizeUrl(instanceUrl(env), {
        clientId: env.CLIENT_ID,
        redirectUri: previewOAuth.redirectUri,
        scopes: begun.scopes,
        state: await previewOAuth.createAuthorizationState({ userObjectId: doId, oauthNonce: begun.oauthNonce }),
        codeChallenge: begun.codeChallenge,
      }), 302);
    }

    if (relPath === "/oauth") {
      // The kit decides whose callback this is: a preview's, arriving at the stable Worker, is
      // relayed there with GitLab's parameters (an `error` included) and the state untouched.
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      let doId: string;
      let oauthNonce: string;
      try {
        const result = await previewOAuth.handleCallback(url);
        if (result.kind === "relay") return result.response;
        ({ userObjectId: doId, oauthNonce } = result.state);
      } catch (error) {
        if (error instanceof PreviewOAuthConfigurationError) {
          return new Response(error.message, { status: 500 });
        }
        return new Response("Error: malformed state", { status: 400 });
      }

      const stub = accountFor(ctx, doId);
      if (stub === null) return new Response("Error: malformed state", { status: 400 });

      if (url.searchParams.get("error")) {
        // The refusal ends the attempt: its nonce is consumed so a replayed callback cannot resume it.
        if (!await stub.consumeOAuthNonce(oauthNonce)) return htmlResponse(INVALID_LINK_HTML);
        return htmlResponse(errorPageHtml(
          "GitLab authorization failed", "Please restart the connection flow from Cloudflare OS."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      const handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return htmlResponse(INVALID_LINK_HTML);
      }

      return htmlResponse(connectHandoffPageHtml(handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "GitLab",
      url: instanceUrl(this.env),
      logo: { url: GITLAB_LOGO_URL },
      color: "#fff0e8",
      tagline: "Triage issues, review merge requests, and push to projects",
      description:
          "Connect your GitLab account so Cloudflare OS can read and update issues, merge requests, " +
          "and reviews, and pull from and push to the projects you choose.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // `options.resourceUrlPatterns` limits a connection to its *grantable* resource types; none
    // of this gatekeeper's are (one indivisible scope set covers every resource), so it has
    // nothing to limit and is not consulted -- as in gatekeeper-github.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly ? AUTH_SCOPES : OAUTH_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return supportedResources(this.env).all;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

/** The live grant: the token pair and the scopes it was requested with (the token response carries none). */
type GitLabGrant = GitLabOAuthGrant & { scopes: string[] };

/** A reconnect's grant, staged until the Workshop confirms it, and the connection it replaces. */
type ReconnectStage = { grant: GitLabGrant; startedUnder: string };

/** The GitLab user behind a connection, kept against the generation it was read under. */
type StoredUser = { id: number; generation: string };

/**
 * Stands in for the identity of a token the account no longer serves, so the coordinator's
 * moved-past gate adjudicates it. Never equal to a real identity, which is a hex nonce.
 */
const REPLACED_TOKEN_IDENTITY = "replaced-token";

export class UserAccount extends DurableObject<Env> implements AccountCredentials {
  readonly #creds = new CredentialCoordinator<GitLabGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    // The layout before the kit, which the deployed internal stub wrote too, minus `scopes`.
    legacyKeys: ["accessToken", "accessTokenExpiresAt", "refreshToken", "scopes"],
    upgrade: kv => {
      const accessToken = kv.get<string>("accessToken");
      const refreshToken = kv.get<string>("refreshToken");
      if (!accessToken || !refreshToken) return undefined;
      return {
        accessToken,
        refreshToken,
        // No recorded expiry: refreshed on first use.
        expiresAt: kv.get<number>("accessTokenExpiresAt") ?? 0,
        // The stub never recorded scopes. Its `read_api` token still serves reads, and reads as no
        // scopes so `ensureResources` offers the reconnect that widens it.
        scopes: kv.get<string[]>("scopes") ?? [],
      };
    },
    // A mint a disconnect overtook is revoked: the disconnect revoked only the pair it found, which
    // the refresh had already rotated out, and nothing survives it for the revocation to harm. One
    // a reconnect overtook, or a death recorded meanwhile, is dropped unrevoked: GitLab does not
    // document that revoking one refresh token leaves the rest of the authorization standing.
    discardMint: async mint => {
      if (this.#creds.stored() === undefined) await this.#revokeTokens(mint.refreshToken, mint.accessToken);
    },
    vendorId: VENDOR_ID,
  });

  /** How the coordinator refreshes a grant and announces its death to the Workshop. */
  readonly #recovery = {
    refresh: async (grant: GitLabGrant): Promise<GitLabGrant> => {
      logger.info("refreshing GitLab access token", { event: "gitlab.token.refresh" });
      try {
        const refreshed = await refreshAccessToken(gitlabInstance(this.env),
          { refreshToken: grant.refreshToken, ...oauthApp(this.env) });
        return { ...refreshed, scopes: grant.scopes };
      } catch (error) {
        if (isCredentialsExpired(error)) throw error;
        throw new Error("Could not refresh GitLab credentials; please try again shortly.", { cause: error });
      }
    },
    notify: () => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID),
  };

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes: string[], ephemeral: boolean): Promise<void> {
    if (!this.#creds.stored()) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral);
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    // A reconnect always requests the full scopes, whatever the account was first connected with.
    this.ctx.storage.kv.put<string[]>("requestedScopes", OAUTH_SCOPES);
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /**
   * Swap the initiation nonce for the OAuth-stage nonce and mint this flow's PKCE verifier. The
   * challenge goes into the authorize URL; the verifier waits with the attempt for the code exchange.
   */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string):
      Promise<{ oauthNonce: string; scopes: string[]; codeChallenge: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      startedUnder: this.#creds.connectionGeneration(),
      // Only a reconnect finds a grant here: an initial connect's account is new.
      reconnect: this.#creds.stored() !== undefined,
    });
    if (oauthNonce === null) return null;
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes, codeChallenge: pkce.codeChallenge };
  }

  /** Ends an attempt GitLab refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const scopes = kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    const grant: GitLabGrant = {
      ...await exchangeAuthCode(gitlabInstance(this.env), {
        code, ...oauthApp(this.env), codeVerifier: attempt.codeVerifier,
        // The exchange must repeat the authorize request's redirect_uri exactly (RFC 6749 §4.1.3).
        redirectUri: attempt.redirectUri,
      }),
      scopes,
    };

    // A disconnect may have landed during the exchange: a finished one wiped the account and its
    // callback, one still running has moved the connection generation `connect` fences on. The
    // new tokens are revoked rather than left live where nobody knows about them.
    const disconnected = async (cause?: unknown) => {
      await this.#revokeTokens(grant.refreshToken, grant.accessToken);
      return new Error("The GitLab account was disconnected while it was being authorized. Please connect it again.",
        { cause });
    };
    if (kv.get("callback") === undefined) throw await disconnected();

    let handoff: ConnectHandoff;
    if (attempt.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's (see
      // commitReconnect). Bound gadgets keep reading the current token meanwhile.
      const stageId = stageCredentials<ReconnectStage>(kv, { grant, startedUnder: attempt.startedUnder }, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        this.#creds.connect(grant, { ifGeneration: attempt.startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        throw await disconnected(error);
      }
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its tokens with nobody: revoke them, as a
        // disconnect would -- the pair stored now, since describing the account may have rotated it.
        const abandoned = this.#creds.stored() ?? grant;
        this.#creds.clear();
        await this.#revokeTokens(abandoned.refreshToken, abandoned.accessToken);
        throw error;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct (the alarm revokes the tokens too).
      if (kv.get<boolean>("ephemeral")) {
        await this.ctx.storage.setAlarm(Date.now() + EPHEMERAL_GRANT_LIFETIME_MS);
        return handoff;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /**
   * Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. A reconnect
   * replaces the connection that was live when it started, so one that another reconnect has
   * overtaken -- its code exchange was still running while the newer flow finished -- is not
   * committed over the newer grant: its tokens are revoked instead.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<ReconnectStage>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      await this.#revokeTokens(staged.grant.refreshToken, staged.grant.accessToken);
      throw new Error("This GitLab account was reconnected again while this reconnect was finishing, so this one was discarded.",
        { cause: error });
    }
  }

  /**
   * The GitLab user behind the live connection: read from `GET /user` the first time it is
   * needed and kept. It is what the observer probe looks up memberships for, on every workspace
   * open, so it is worth keeping; and it is a fact about one connection, so it is fenced to its
   * generation. A read that started under one connection and finished under another (a
   * reconnect landed in between, possibly as a different GitLab user) is neither stored nor
   * returned -- the caller re-reads under the live one.
   */
  async getUser(): Promise<StoredUser> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.#creds.connectionGeneration();
      const stored = this.ctx.storage.kv.get<StoredUser>("user");
      if (stored?.generation === generation) return stored;
      const { id } = await withAccountApi(this.env, this, api => api.getCurrentUser(), { replayable: true });
      if (this.#creds.connectionGeneration() === generation) {
        const user = { id, generation };
        this.ctx.storage.kv.put<StoredUser>("user", user);
        return user;
      }
      // The connection moved under the read: the id may be another user's. Once more, under the new one.
    }
    throw new Error("GitLab credentials changed while they were being read. Please try again.");
  }

  /**
   * @returns The current access token, refreshed when it is within the kit's safety window of expiry.
   * @throws `CredentialsExpiredError` when the account is disconnected or its grant is dead, after
   * notifying the Workshop of a death.
   */
  async getAccessToken(): Promise<string> {
    const { creds } = await this.#creds.snapshot(this.#recovery.refresh, this.#recovery);
    return creds.accessToken;
  }

  getScopes(): string[] {
    return this.#creds.stored()?.scopes ?? [];
  }

  /**
   * Adjudicates GitLab's refusal of `accessToken`, notifying the Workshop when the grant is dead.
   * GitLab invalidates an access token when it issues the next one, so a request that presented a
   * token this account has since replaced -- by a refresh or a reconnect -- failed stale. A refusal
   * of the current token refreshes past it; one arriving while that refresh is already in flight
   * joins it rather than being taken for the grant's death.
   */
  async reportTokenRejected(accessToken: string): Promise<RejectionVerdict> {
    const identity = this.#creds.stored()?.accessToken === accessToken
      ? this.#creds.identity()
      : REPLACED_TOKEN_IDENTITY;
    return await this.#creds.adjudicateRejection(identity, this.#recovery);
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login). The latter still holds live tokens, which
    // are revoked rather than left to expire.
    if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
      await this.revoke();
    } else if (!this.#creds.stored()) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const grant = this.#creds.stored();
    // Fence before the first await, so a refresh still in flight is never stored -- not even into
    // the wiped account. Its mint is revoked when it lands (`discardMint`).
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (grant) await this.#revokeTokens(grant.refreshToken, grant.accessToken);
  }

  /**
   * Revoke a grant's tokens on GitLab. The docs don't say revoking one token revokes its
   * partner, so both are; failures are logged, not fatal -- the caller drops its copy regardless.
   */
  async #revokeTokens(...tokens: string[]): Promise<void> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) return;
    for (const token of tokens) {
      try {
        await revokeToken(gitlabInstance(this.env), {
          token, clientId: this.env.CLIENT_ID, clientSecret: this.env.CLIENT_SECRET,
        });
      } catch (error) {
        logger.error("failed to revoke GitLab OAuth token", {
          event: "oauth.token.revoke.failed", error,
        });
      }
    }
  }
}

/** Runs replay-safe GitLab reads as the account behind `userObjectId`; see withAccountApi. */
function accountReader(env: Env, exports: Cloudflare.Exports, userObjectId: string): GitLabApiRunner {
  // The stub is made per call: a configurator outlives the request that created it.
  return fn => withAccountApi(env,
    exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId)), fn, { replayable: true });
}

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const user = await accountReader(this.env, this.ctx.exports, this.ctx.props.userObjectId)(
      api => api.getCurrentUser());
    return {
      displayName: user.name || user.username,
      uniqueName: user.username,
      avatar: { url: user.avatar_url ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // The primary email, which GitLab only makes primary once confirmed: `confirmed_at` is the
    // provider's verification, so this is safe as a sign-in identity. `public_email` is not used
    // -- the user chose to publish it; the provider did not verify it for this purpose.
    const user = await accountReader(this.env, this.ctx.exports, this.ctx.props.userObjectId)(
      api => api.getCurrentUser());
    return user.email && user.confirmed_at ? user.email : null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return supportedResources(this.env).all;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = parseResourceUrl(instanceUrl(this.env), url);
    if (!parsed) {
      throw new Error(`Unsupported GitLab URL: ${url}`);
    }
    const resources = supportedResources(this.env);
    const props: GitLabGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      projectPath: parsed.projectPath,
      resourceKind: parsed.kind,
      ...(parsed.kind === "project" ? {} : { iid: parsed.iid }),
    };
    return {
      class: this.ctx.exports.GitLabGatekeeperImpl({ props }),
      resource: resources[parsed.kind],
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const context = {
      instanceUrl: instanceUrl(this.env),
      read: accountReader(this.env, this.ctx.exports, this.ctx.props.userObjectId),
    };
    const resources = supportedResources(this.env);

    if (resourceUrlPattern === resources.project.urlPattern) {
      return {
        iframeHtml: GITLAB_PROJECT_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitLabProjectConfiguratorUI(context)),
      };
    }
    if (resourceUrlPattern === resources.issue.urlPattern) {
      return {
        iframeHtml: GITLAB_ISSUE_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitLabIssueConfiguratorUI(context)),
      };
    }
    if (resourceUrlPattern === resources.mergeRequest.urlPattern) {
      return {
        iframeHtml: GITLAB_MERGE_REQUEST_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitLabMergeRequestConfiguratorUI(context)),
      };
    }
    throw new Error(`Unsupported GitLab resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return {
      url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}`,
    };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  /**
   * Every resource type needs the same indivisible grant, so this only asks whether the live
   * grant has it: one requested with fewer scopes (a sign-in grant, or a grant left by the
   * incubating gatekeeper this package replaced, which recorded none) is answered with a
   * reconnect URL, which the Workshop opens before binding the resource. The reconnect stages
   * its credentials like any other (see `reconnect`).
   */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    const granted = await this.#account().getScopes();
    if (OAUTH_SCOPES.every(scope => granted.includes(scope))) return {};
    return await this.reconnect();
  }

  /**
   * Mint a verifier representing this account, used by GitLabGatekeeperImpl.addObserver to confirm
   * a prospective observer is allowed to read a bound project (see that method). The verifier
   * carries this user's own account id, so when the gatekeeper calls hasProjectAccess() the check
   * runs against the observer's *own* GitLab token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: GitLabVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GitLabVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// GitLab uses the "ACL check (single unit)" observer strategy: a binding is a single project (or
// a single issue/MR, which inherits the project's ACL), so verifying an observer reduces to "can
// this user see everything this binding can disclose?".
//
// Neither a 200 on the project nor its visibility answers that. GitLab's Guest role can see a
// private project and its issues but "cannot push code or access repository", so it would be
// admitted to cached git data it cannot read. And a *public* project can hold confidential issues
// (Planner+ only) and internal notes (Reporter+ only), so a non-member admitted on visibility
// alone would see confidential data the owner's token read -- GitHub has no counterpart, since a
// public repo's issues and comments are all public. The probe therefore requires membership at
// Reporter (20) or higher, whatever the visibility, and reads it from the user's *effective*
// membership (`GET …/members/all?user_ids[]=`, inherited and shared-group access included) rather
// than the project's `permissions` object, which reported `null` for group-inherited access on
// every project it was checked against -- the access most members of most projects hold. The
// same check, live: a non-member reads as `[]`, an inherited Developer as one row at 30.
// Over-strictness (Planner's confidential-issue and 18.7+ private-repo read, custom roles, the
// non-member collaborator on an open-source project) is accepted: under `excludeObservers`
// semantics erring toward denial never leaks.

type GitLabVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard method the GitLab gatekeeper calls on its own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface GitLabVerifierApi extends GatekeeperUserVerifier {
  hasProjectAccess(projectPath: string): Promise<boolean>;
}

/**
 * The lowest role that sees everything a binding can disclose: the repository, confidential
 * issues, and internal notes.
 */
const REPORTER_ACCESS_LEVEL = 20;

/**
 * Decide from a user's effective membership (or its absence) whether they see everything a
 * binding can disclose: Reporter or above, not an invitation still awaiting acceptance, and not
 * expired -- GitLab documents that from `expires_at` onward the user can no longer access the
 * project, and a row it has not yet swept may still be listed with the date passed. The date is
 * a day (`2026-09-18`), read as its UTC midnight; a date that does not parse expires too.
 */
function membershipGrantsFullRead(
  member: { access_level: number; membership_state?: string; expires_at?: string | null } | null,
  now: Date = new Date(),
): boolean {
  if (member === null || member.membership_state === "awaiting") return false;
  if (member.expires_at != null && !(Date.parse(member.expires_at) > now.getTime())) return false;
  return member.access_level >= REPORTER_ACCESS_LEVEL;
}

@validateRpc()
export class GitLabVerifier extends WorkerEntrypoint<Env, GitLabVerifierProps>
    implements GitLabVerifierApi {
  async hasProjectAccess(projectPath: string): Promise<boolean> {
    const { userObjectId } = this.ctx.props;
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    try {
      // What the observer holds on the project, read with their own token: nothing (`[]`) for a
      // non-member, 404 for a project the token cannot see at all (GitLab hides existence) -- the
      // same answer here. Their user id comes from the account, fenced to the connection that
      // answered it: if a reconnect (possibly as another GitLab user) lands between the two reads,
      // the membership row would be one user's and the token another's, so the answer is
      // discarded and the probe fails closed -- the overseer re-runs it on the next open.
      const user = await account.getUser();
      const member = await accountReader(this.env, this.ctx.exports, userObjectId)(
        api => api.getProjectMember(projectPath, user.id));
      if ((await account.getUser()).generation !== user.generation) return false;
      return membershipGrantsFullRead(member);
    } catch (error) {
      // 403 in some policy cases; the observer lacks access either way.
      if (error instanceof GitLabApiError && (error.status === 404 || error.status === 403)) {
        return false;
      }
      throw error;
    }
  }
}
