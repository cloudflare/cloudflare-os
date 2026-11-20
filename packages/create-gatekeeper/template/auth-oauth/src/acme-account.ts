// The account Durable Object, which holds one connection's OAuth grant, and the HTTP routes of its
// connect flow: the connect link, which redirects to the provider, and the OAuth callback.
//
// Access tokens expire and refresh tokens may rotate, so `UserAccount` keeps the grant in the kit's
// `CredentialCoordinator`. A connection is pinned to the user who made it, and a reconnect that
// comes back as anyone else is refused.

import { DurableObject } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, NONCE_BYTES } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CredentialCoordinator,
  CredentialSource,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { createPkce, mergeOAuthTokens, oauthRefresh, type OAuthTokens } from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import { createApi, isAuthError, isDenial } from "./acme-api";
import { SCOPES, isConfigured, missingScopes, oauthClient } from "./acme-auth";
import { RECONNECT_MESSAGE, accountStub, identityOf, type Identity, type PublicGrant } from "./acme-credentials";
import { VENDOR_ID, getBaseUrl, type Env } from "./acme-env";
// #if hooks
import { forgetHooks } from "./acme-hooks";
// #endif
import { parseSubresource } from "./acme-resources";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.acme", vendorId: VENDOR_ID });

/** How long the connected user's details are served before they are read from the provider again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

// STOP(observer-cache): How long an observer-access answer is reused. A provider that doesn't say
// when access changes is only noticed to have removed it once the allowance expires.
const ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const ACCESS_DENIED_TTL_MS = 15_000;
const accessTtl = (allowed: boolean): number => allowed ? ACCESS_ALLOWED_TTL_MS : ACCESS_DENIED_TTL_MS;
/** How many objects an access check probes at once. */
const PROBE_CONCURRENCY = 6;

/** The stored grant. The refresh token is never sent across the account boundary. */
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
  "Acme Service gatekeeper not configured",
  "Configure an Acme Service OAuth client ID and secret for this gatekeeper.");

function toGrant(tokens: OAuthTokens): Grant {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    // RFC 6749 lets a response omit `scope` when it granted what was asked.
    scopes: tokens.scopes ?? [...SCOPES],
  };
}

// STOP(identity): How the provider says which user a grant belongs to. Prefer a signed ID token
// where the provider issues one; otherwise its "current user" endpoint. `userId` is what the
// connection and every binding are pinned to, so make it name the user AND the tenant
// (organization, workspace) the grant acts in, where a user can belong to several.
/** Reads the user a grant belongs to. */
async function fetchUser(accessToken: string): Promise<Identity> {
  return identityOf(await createApi(accessToken).get("/me"));
}

// STOP(observer-probe): Whether the provider opens an object for the user whose token this is.
// Ask the same endpoint a read uses, not public metadata. A definite "no" is false; any other
// failure leaves access undetermined, so it throws.
async function probe(accessToken: string, itemId: string): Promise<boolean> {
  try {
    await createApi(accessToken).get("/items/{id}", { path: { id: itemId } });
    return true;
  } catch (error) {
    if (isDenial(error)) return false;
    throw error;
  }
}

/** The OAuth callback registered with the provider's app. */
function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/** The OAuth callback policy: direct in production, a relay through the stable Worker on a preview. */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "The Acme Service OAuth callback is not configured.",
      { status: 503 });
  }
}

/** The account a connect link or callback state names; null when the id is not one of ours. */
function accountFor(ctx: ExecutionContext, doId: string): DurableObjectStub<UserAccount> | null {
  try {
    return accountStub(ctx.exports, doId);
  } catch {
    return null;
  }
}

/**
 * Serves the connect flow's routes: `/<account>/<nonce>`, the connect link, and `/oauth`, the
 * provider's callback. `relPath` is the request path below the Worker's base path.
 * @returns The response, or null for a path that is not one of the flow's.
 */
export async function handleConnect(
    req: Request, env: Env, ctx: ExecutionContext, relPath: string): Promise<Response | null> {
  const url = new URL(req.url);
  const path = relPath.slice(1).split("/");

  if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
    if (!isConfigured(env)) return htmlResponse(NOT_CONFIGURED_HTML);
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
        "Acme Service authorization was not granted", "Start the connection again from the Workshop."), 400);
    }
    const code = url.searchParams.get("code");
    if (!code) return new Response("Error: no 'code' provided", { status: 400 });

    const result = await stub.acceptAuthCode(code, oauthNonce);
    if (result === null) return htmlResponse(INVALID_LINK_HTML);
    if ("refused" in result) return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
    return htmlResponse(connectHandoffPageHtml(result.handoff));
  }

  return null;
}

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: Grant): Promise<Grant> => {
    logger.info("refreshing Acme Service access token", { event: "acme.token.refresh" });
    return oauthRefresh<Grant>(oauthClient(this.env), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      expiredMessage: RECONNECT_MESSAGE,
    })(grant);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  // The account's own reads (its user, its observer probes) run through the same rejection
  // handling as a facet's: a refused token is refreshed, or the grant marked dead and the user
  // asked to reconnect.
  readonly #source = new CredentialSource<PublicGrant>({
    account: () => this,
    isAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });

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

  /** Ends an attempt the provider refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange.
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
          title: "The Acme Service app is missing permissions",
          detail: `Acme Service didn't grant ${missing.join(", ")}. Ask whoever registered the app to ` +
            "add these permissions, then connect again.",
        },
      };
    }
    let identity: Identity;
    try {
      identity = await fetchUser(grant.accessToken);
    } catch (error) {
      logger.error("could not read who authorized an Acme Service connection", { event: "acme.oauth.identity.failed", error });
      throw new Error("Could not read which Acme Service user authorized this connection. Please try again.",
        { cause: error });
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      throw new Error("The Acme Service account was disconnected while it was being authorized. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      const pinned = kv.get<Identity>("identity");
      if (pinned !== undefined && pinned.userId !== identity.userId) {
        return {
          refused: {
            title: "That's a different Acme Service user",
            detail: `This connection is for ${pinned.name}, but Acme Service authorized ${identity.name}. ` +
              `Sign in as ${pinned.name} and reconnect, or connect the other user as a separate account.`,
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
        throw new Error("The Acme Service account was disconnected while it was being authorized. Connect it again.",
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
      throw new Error("This Acme Service account was reconnected again while this reconnect was finishing, " +
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

  /** Adjudicates the provider's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /**
   * The connected user, read again from the provider once a day old. A failed re-read serves the
   * stored copy.
   */
  async getIdentity(): Promise<Identity> {
    const stored = this.ctx.storage.kv.get<Identity>("identity");
    if (stored === undefined || !this.#creds.stored()) throw new CredentialsExpiredError(RECONNECT_MESSAGE);
    if (Date.now() - stored.fetchedAt < IDENTITY_TTL_MS) return stored;
    try {
      const fresh = await this.#source.run(creds => fetchUser(creds.accessToken), { replayable: true });
      this.ctx.storage.kv.put<Identity>("identity", fresh);
      return fresh;
    } catch (error) {
      logger.warn("failed to refresh the Acme Service identity", { event: "acme.identity.refresh.failed", error });
      return stored;
    }
  }

  /**
   * Whether this connection can read each subresource (see `itemSubresourceId`), in order. An
   * allowed answer is reused for up to 15 minutes and a denial for 15 seconds, until the next
   * reconnect. Throws for an ID it can't check, or when access can't be determined, which is never
   * reused. A token the provider refuses is refreshed, or else the user asked to reconnect.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    const items = subresources.map(id => parseSubresource(id).itemId);
    // A connection that is gone fails the check outright, rather than serve answers it cached.
    await this.getCredentials();
    const unique = [...new Set(items)];
    const allowed = new Map<string, boolean>();
    for (let start = 0; start < unique.length; start += PROBE_CONCURRENCY) {
      await Promise.all(unique.slice(start, start + PROBE_CONCURRENCY).map(async itemId => {
        allowed.set(itemId, await this.#access.cached(itemId, accessTtl, () =>
          this.#source.run(creds => probe(creds.accessToken, itemId), { replayable: true })));
      }));
    }
    return items.map(itemId => allowed.get(itemId)!);
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /** Disconnects: the grant is forgotten here. */
  async revoke(): Promise<void> {
    // Before any await, so no credential read or OAuth completion gets in.
    this.#creds.clear();
    // #if hooks
    // Best effort: should it fail, nothing retries it, and the hooks' firings fail without a grant.
    await forgetHooks(this.ctx.exports, this.ctx.id.toString()).catch((error: unknown) => {
      logger.warn("failed to drop the hooks of a disconnected connection", { event: "acme.hooks.forget.failed", error });
    });
    // #endif
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
