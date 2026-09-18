// The GitLab gatekeeper's main module: the HTTP entrypoint (connect URL and OAuth callback), the
// vendor and per-account entrypoints, the account Durable Object that holds the OAuth grant, and
// the observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// gitlab-gatekeeper.ts and are re-exported here so wrangler finds every class on the main module.
//
// A mirror of gatekeeper-github (see plans/gitlab-gatekeeper.md). What differs is instance
// configuration (any GitLab, optionally behind Cloudflare Access) and credentials: GitLab access
// tokens expire and refresh tokens rotate, so `UserAccount` refreshes under a lock and persists
// the rotated pair before using either.

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
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  INITIATION_NONCE_LIFETIME_MS,
  NONCE_BYTES,
  OAUTH_NONCE_LIFETIME_MS,
  constantTimeEqual,
  generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  GitLabApi,
  GitLabApiError,
  buildAuthorizeUrl,
  exchangeAuthCode,
  generatePkce,
  refreshAccessToken,
  revokeToken,
  type GitLabOAuthGrant,
} from "./gitlab-api";
import {
  AUTH_SCOPES,
  OAUTH_SCOPES,
  VENDOR_ID,
  ensureConfigured,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  gitlabInstance,
  instanceUrl,
  supportedResources,
  type Env,
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

/** Refresh when less than this remains; GitLab's default lifetime is 7200s. */
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;
/** Back-off after a non-terminal refresh failure so a burst of callers doesn't hammer the token endpoint. */
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;
/** Auth-only sign-in grants self-destruct shortly after the email is read. */
const EPHEMERAL_GRANT_LIFETIME_MS = 2 * 60 * 1000;
/** An account whose connect flow never completes is dropped. */
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

const RECONNECT_MESSAGE = "GitLab credentials have expired or been revoked. Please reconnect the account.";

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

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Link Expired</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">GitLab Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a GitLab OAuth application ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

/**
 * Serializes operations against each other, so none observes another's mid-flight state. A
 * promise chain rather than `blockConcurrencyWhile`: that would freeze the whole object for the
 * duration of a fetch, and an exception inside it resets the Durable Object.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return htmlResponse(INVALID_LINK_HTML);
      }

      // The authorize page is on the browser-facing instance: the user's own session must reach it.
      return Response.redirect(buildAuthorizeUrl(instanceUrl(env), {
        clientId: env.CLIENT_ID,
        redirectUri: getRedirectUri(env),
        scopes: begun.scopes,
        state: `${doId}:${begun.oauthNonce}`,
        codeChallenge: begun.codeChallenge,
      }), 302);
    }

    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("GitLab authorization failed. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
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

/** The live grant, as `UserAccount` stores it. */
type StoredGrant = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** Scopes the grant was requested with; the token response carries none. */
  scopes: string[];
};

type StagedGrant = GitLabOAuthGrant & { scopes: string[] };

export class UserAccount extends DurableObject<Env> {
  /**
   * Serializes refresh, reconnect, and revoke against each other. GitLab rotates refresh tokens,
   * so two callers racing a refresh would redeem the same single-use token: the second redemption
   * fails, and the first's new pair could be overwritten by a stale write. The re-check inside the
   * lock is what collapses a burst of expired callers into one exchange.
   */
  #credentials = new Mutex();

  /** The last refresh that failed, so a burst of callers fails the same way without re-asking GitLab. */
  #mintFailure: { error: Error; at: number } | undefined;

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes: string[], ephemeral: boolean): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("expiredNotified", false);
    // A reconnect always requests the full scopes, whatever the account was first connected with.
    this.ctx.storage.kv.put<string[]>("requestedScopes", OAUTH_SCOPES);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  /**
   * Swap the initiation nonce for the OAuth-stage nonce and mint this flow's PKCE verifier. The
   * challenge goes into the authorize URL; the verifier waits in storage for the code exchange.
   */
  async beginOAuthFlow(initiationNonce: string):
      Promise<{ oauthNonce: string; scopes: string[]; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    const oauthNonce = generateNonce();
    const pkce = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    this.ctx.storage.kv.put("codeVerifier", pkce.verifier);
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes, codeChallenge: pkce.challenge };
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
    const codeVerifier = this.ctx.storage.kv.get<string>("codeVerifier");
    this.ctx.storage.kv.delete("codeVerifier");

    ensureConfigured(this.env);
    const clientId = this.env.CLIENT_ID;
    const clientSecret = this.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("GitLab OAuth is not configured.");
    }
    if (!codeVerifier) {
      throw new Error("The authorization flow was not started properly. Please try again.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    const grant = await exchangeAuthCode(gitlabInstance(this.env), {
      code, clientId, clientSecret, redirectUri: getRedirectUri(this.env), codeVerifier,
    });

    // The exchange ran outside the lock (it is a network call no other operation waits on), so
    // the account may have been revoked meanwhile -- a disconnect clicked while the reconnect
    // popup was finishing. The grant lands under the lock, and only into an account that still
    // exists, so a revoked account never holds a live token nobody knows about. The lock covers
    // just that check and write; the Workshop callback below is another RPC and runs outside it.
    const stageId = await this.#credentials.run(async () => {
      if (this.ctx.storage.kv.get("callback") === undefined) {
        await this.#revokeTokens(grant.refreshToken, grant.accessToken);
        throw new Error("The GitLab account was disconnected while it was being authorized. Please connect it again.");
      }
      if (stored.reconnect) {
        // The reconnect URL is a bearer capability, so the new grant is only staged until the
        // Workshop has confirmed the browser that finished the flow is the owner's (see
        // commitReconnect). Bound gadgets keep reading the current token meanwhile.
        const staged: StagedGrant = { ...grant, scopes };
        return stageCredentials(this.ctx.storage.kv, staged, Date.now());
      }
      this.#writeGrant(grant, scopes);
      return undefined;
    });

    let handoff: ConnectHandoff;
    if (stageId !== undefined) {
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        this.#clearGrant();
        throw error;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct (the alarm revokes the tokens too).
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        await this.ctx.storage.setAlarm(Date.now() + EPHEMERAL_GRANT_LIFETIME_MS);
        return handoff;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    await this.#credentials.run(async () => {
      const staged = commitStagedCredentials<StagedGrant>(this.ctx.storage.kv, Date.now(), stageId);
      if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
      this.#writeGrant(staged, staged.scopes);
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put("expiredNotified", false);
    });
  }

  /**
   * Writes a grant as the live one, under a fresh `grantId`. The id names *which authorization*
   * the tokens belong to: a refresh rotates the tokens but keeps the id (same user, same
   * authorization), a connect or reconnect mints a new one (possibly a different GitLab user).
   * Anything derived from the grant -- the user id below -- is stored against it and trusted only
   * while it is still the live one.
   */
  #writeGrant(grant: GitLabOAuthGrant, scopes: string[], grantId = generateNonce()): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("accessToken", grant.accessToken);
      this.ctx.storage.kv.put("accessTokenExpiresAt", grant.expiresAt.getTime());
      this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put<string[]>("scopes", scopes);
      this.ctx.storage.kv.put("expiredNotified", false);
      if (this.ctx.storage.kv.get<string>("grantId") !== grantId) {
        this.ctx.storage.kv.put("grantId", grantId);
        this.ctx.storage.kv.delete("userId");
      }
    });
  }

  #clearGrant(): void {
    this.ctx.storage.transactionSync(() => {
      for (const key of ["accessToken", "accessTokenExpiresAt", "refreshToken", "scopes", "grantId", "userId"]) {
        this.ctx.storage.kv.delete(key);
      }
    });
  }

  /**
   * The GitLab user the live grant belongs to, as `{ id, grantId }`: read from `GET /user` with
   * the grant's own token the first time it is needed and kept with the grant. It is what the
   * observer probe looks up memberships for, on every workspace open, so it is worth keeping;
   * and it is a fact about one authorization, so it is fenced to it. A read that started under
   * one grant and finished under another (a reconnect landed in between, possibly as a different
   * GitLab user) is neither stored nor returned -- the caller re-reads under the live grant.
   */
  async getUser(): Promise<{ id: number; grantId: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const grantId = this.#grantId();
      const stored = this.ctx.storage.kv.get<number>("userId");
      if (stored !== undefined) return { id: stored, grantId };
      const api = new GitLabApi(gitlabInstance(this.env), async () => await this.getAccessToken());
      const user = await api.getCurrentUser();
      if (this.ctx.storage.kv.get<string>("grantId") === grantId) {
        this.ctx.storage.kv.put("userId", user.id);
        return { id: user.id, grantId };
      }
      // The grant moved under the read: the id may be another user's. Once more, under the new one.
    }
    throw new Error("GitLab credentials changed while they were being read. Please try again.");
  }

  /**
   * The live grant's id, minted on first use for a grant written before ids were kept (one left
   * by the incubating gatekeeper this package replaced): the tokens are whoever's they were, and
   * the id only has to be stable from here on.
   */
  #grantId(): string {
    const existing = this.ctx.storage.kv.get<string>("grantId");
    if (existing !== undefined) return existing;
    if (this.ctx.storage.kv.get<string>("accessToken") === undefined) {
      throw new Error("GitLab credentials have not been configured for this account.");
    }
    const minted = generateNonce();
    this.ctx.storage.kv.put("grantId", minted);
    return minted;
  }

  #readGrant(): StoredGrant | null {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!accessToken || !refreshToken) return null;
    return {
      accessToken,
      refreshToken,
      scopes: this.getScopes(),
      accessTokenExpiresAt: this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0,
    };
  }

  #tokenIsFresh(grant: StoredGrant): boolean {
    return grant.accessTokenExpiresAt > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS;
  }

  /**
   * The current access token, refreshed when it is within the safety window of expiry. The fast
   * path is outside the lock; refresh is serialized and re-checked inside it, and the rotated
   * pair is written in one transaction before any caller sees the new token.
   */
  async getAccessToken(): Promise<string> {
    const grant = this.#readGrant();
    if (!grant) {
      throw new Error("GitLab credentials have not been configured for this account.");
    }
    if (this.#tokenIsFresh(grant)) return grant.accessToken;

    return await this.#credentials.run(async () => {
      const current = this.#readGrant();
      if (!current) {
        throw new Error("GitLab credentials have not been configured for this account.");
      }
      if (this.#tokenIsFresh(current)) return current.accessToken;

      if (this.#mintFailure && Date.now() - this.#mintFailure.at < MINT_FAILURE_COOLDOWN_MS) {
        throw this.#mintFailure.error;
      }

      ensureConfigured(this.env);
      logger.info("refreshing GitLab access token", { event: "gitlab.token.refresh" });
      let result;
      try {
        result = await refreshAccessToken(gitlabInstance(this.env), {
          refreshToken: current.refreshToken,
          clientId: this.env.CLIENT_ID!,
          clientSecret: this.env.CLIENT_SECRET!,
          redirectUri: getRedirectUri(this.env),
        });
      } catch (error) {
        // Transient: the token endpoint was unreachable or answered 5xx. Back off, but do not
        // declare the account dead -- the refresh token is still good.
        const wrapped = new Error("Could not refresh GitLab credentials; please try again shortly.", { cause: error });
        this.#mintFailure = { error: wrapped, at: Date.now() };
        throw wrapped;
      }

      if (!result.ok) {
        // Terminal: the refresh token was already used, expired, or revoked.
        const error = new Error(RECONNECT_MESSAGE);
        this.#mintFailure = { error, at: Date.now() };
        await this.noteCredentialsExpired();
        throw error;
      }

      // Backstop: the mutex keeps mutators from interleaving with a refresh, so the stored
      // refresh token should still be the one just redeemed. If it isn't, a reconnect landed
      // meanwhile and its pair wins.
      if (this.ctx.storage.kv.get<string>("refreshToken") !== current.refreshToken) {
        logger.warn("discarded a GitLab token refreshed against superseded credentials", {
          event: "gitlab.token.refresh.superseded",
        });
        const replaced = this.#readGrant();
        if (replaced) return replaced.accessToken;
        throw new Error("GitLab credentials changed while refreshing. Please try again.");
      }

      this.#writeGrant(result.grant, current.scopes, this.#grantId());
      this.#mintFailure = undefined;
      return result.grant.accessToken;
    });
  }

  /**
   * The scopes the live grant was requested with. The current code always writes this record;
   * a grant without one is from the earlier incubating gatekeeper this package replaced, whose
   * `read_api` tokens can serve reads but not writes or push -- reported as no scopes, so
   * `ensureResources` offers the reconnect that widens it.
   */
  getScopes(): string[] {
    return this.ctx.storage.kv.get<string[]>("scopes") ?? [];
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) {
      return;
    }

    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) {
      await callback.credentialsExpired();
    }
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login). The latter still holds live tokens, which
    // are revoked rather than left to expire.
    if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
      await this.revoke();
    } else if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.#credentials.run(async () => {
      await this.#revokeTokens(
        this.ctx.storage.kv.get<string>("refreshToken"), this.ctx.storage.kv.get<string>("accessToken"));
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  /**
   * Revoke a grant's tokens on GitLab. The docs don't say revoking one token revokes its
   * partner, so both are; failures are logged, not fatal -- the caller drops its copy regardless.
   */
  async #revokeTokens(...tokens: Array<string | undefined>): Promise<void> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) return;
    for (const token of tokens) {
      if (!token) continue;
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

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #withApi<T>(fn: (api: GitLabApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    const api = new GitLabApi(gitlabInstance(this.env), async () => await account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof GitLabApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error(RECONNECT_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const user = await api.getCurrentUser();
      return {
        displayName: user.name || user.username,
        uniqueName: user.username,
        avatar: { url: user.avatar_url ?? "" },
      };
    });
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // The primary email, which GitLab only makes primary once confirmed: `confirmed_at` is the
    // provider's verification, so this is safe as a sign-in identity. `public_email` is not used
    // -- the user chose to publish it; the provider did not verify it for this purpose.
    return await this.#withApi(async api => {
      const user = await api.getCurrentUser();
      return user.email && user.confirmed_at ? user.email : null;
    });
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
    const resource = parsed.kind === "issue" ? resources.issue
      : parsed.kind === "mergeRequest" ? resources.mergeRequest
      : resources.project;
    return {
      class: this.ctx.exports.GitLabGatekeeperImpl({ props }),
      resource,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const account = this.#account();
    const context = {
      instanceUrl: instanceUrl(this.env),
      api: new GitLabApi(gitlabInstance(this.env), async () => await account.getAccessToken()),
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
// membership (`GET …/members/all/:user_id`, inherited and shared-group access included) rather
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
export const REPORTER_ACCESS_LEVEL = 20;

/**
 * Decide from a user's effective membership (or its absence) whether they see everything a
 * binding can disclose: Reporter or above, and not an invitation still awaiting acceptance.
 * Exported for the node tests.
 */
export function membershipGrantsFullRead(
  member: { access_level: number; membership_state?: string } | null,
): boolean {
  return member !== null && member.membership_state !== "awaiting" && member.access_level >= REPORTER_ACCESS_LEVEL;
}

@validateRpc()
export class GitLabVerifier extends WorkerEntrypoint<Env, GitLabVerifierProps>
    implements GitLabVerifierApi {
  async hasProjectAccess(projectPath: string): Promise<boolean> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    const api = new GitLabApi(gitlabInstance(this.env), async () => await account.getAccessToken());
    try {
      // What the observer holds on the project, read with their own token: nothing (`[]`) for a
      // non-member, 404 for a project the token cannot see at all (GitLab hides existence) -- the
      // same answer here. Their user id comes from the account, fenced to the grant that answered
      // it: if a reconnect (possibly as another GitLab user) lands between the two reads, the
      // membership row would be one user's and the token another's, so the answer is discarded
      // and the probe fails closed -- the overseer re-runs it on the next open.
      const user = await account.getUser();
      const member = await api.getProjectMember(projectPath, user.id);
      if ((await account.getUser()).grantId !== user.grantId) return false;
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
