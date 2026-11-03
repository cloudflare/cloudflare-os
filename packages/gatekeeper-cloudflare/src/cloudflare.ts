import { WorkerEntrypoint, DurableObject, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  SupportedResource, ResourceConfiguratorFrame, ResourceDescription, ApprovalQueue, ActionKind,
  GitCache, stripTrailingSlashes, workerVersionTag, type ConnectHandoff,
} from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import {
  getOAuthConfig, buildAuthorizeUrl, generatePkce, exchangeCode, refreshTokens, isGrantDeath,
  AUTH_SCOPES, BILLING_SCOPES, persistentScopesForResources,
} from "./oauth";
import { fetchIdentity } from "./cloudflare-api";
import {
  OBSERVABILITY_RESOURCES,
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
  grantedObservabilityResourcePatterns,
  accountObservabilityUrl,
  workerObservabilityUrl,
  parseObservabilityResourceUrl,
  observabilitySubresourceId,
  parseObservabilitySubresourceId,
} from "./resources.js";
import { CloudflareObservabilityApi, deniesAccess } from "./observability-api.js";
import { CloudflareObservabilitySessionImpl } from "./observability-session.js";
import { getWorker, resolveWorkerScope, type WorkerScope } from "./workers-api.js";
import {
  CloudflareAccountConfiguratorUI,
  CloudflareWorkerConfiguratorUI,
} from "./cloudflare-configurators.js";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/cloudflare-account-configurator-ui.txt";
import WORKER_CONFIGURATOR_HTML from "./generated/cloudflare-worker-configurator-ui.txt";
import type { CloudflareObservabilitySession } from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one is active at a time; `stage`
// tracks where we are. For the OAuth stage we also stash the PKCE verifier alongside the nonce.
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
  verifier?: string;
  scopes?: string[];
};

// A cached access token plus its absolute expiry (unix ms).
type StoredAccessToken = { token: string; expires: number };
/** The live keys a completed OAuth exchange writes, as one value so a reconnect can stage it. */
type StoredGrant = { refreshToken: string; accessToken: StoredAccessToken; grantedScopes: string[] };

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// How long an account reuses an answer about its own access to a subresource, counted from when it
// started asking Cloudflare. Cloudflare doesn't say when access changes: a revoked role is noticed
// only once the answer that allowed it expires, while a denial is kept briefly so that a new grant
// is noticed soon.
const SUBRESOURCE_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const SUBRESOURCE_ACCESS_DENIED_TTL_MS = 15_000;

// How long a Worker binding reuses its Worker's resolved name and versions. A stale answer can only
// withhold the Worker's own telemetry: a version deployed since is missing from it, and so is what
// it emitted under a name it took since.
const WORKER_SCOPE_TTL_MS = 60_000;

// Official Cloudflare logomark (orange cloud on a transparent background), as a data URI so it can
// be rendered directly as the vendor/account avatar.
const CLOUDFLARE_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74">` +
  `<path fill="#f4801f" d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.75,22.27-16.71l4.34-11.36a2.68,2.68,0,0,0,.18-1,3.31,3.31,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z"/>` +
  `<path fill="#f9ab41" d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.09.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.55,1.55,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z"/>` +
  `</svg>`,
);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Optional env vars (may be omitted from wrangler.jsonc; secrets come from .dev.vars / dashboard).
type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/cloudflare");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Authorization Link Expired</h1>
<p>This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
<button onclick="window.close()">Close</button></body></html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Configuration Required</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Cloudflare Gatekeeper Not Configured</h1>
<p>Please see the README.md for instructions on configuring an OAuth client ID and secret.</p>
</body></html>`;

/** Main HTTP entrypoint — used only to initiate and complete the OAuth flow. */
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
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env))!;
      const authUrl = buildAuthorizeUrl(config, `${doId}:${begun.oauthNonce}`, begun.challenge, begun.scopes);
      return Response.redirect(authUrl, 302);
    } else if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }
      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      const doId = state.slice(0, colonIdx);
      const oauthNonce = state.slice(colonIdx + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return htmlResponse(connectHandoffPageHtml(handoff));
    }
    return new Response("Not Found", { status: 404 });
  },
};

// =======================================================================================

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare",
      url: "https://cloudflare.com",
      logo: { url: CLOUDFLARE_LOGO_URL },
      color: "#fbece0",
      tagline: "Sign in, use AI Gateway, and inspect Workers Observability",
      description:
          "Sign in with your Cloudflare account and use your own Cloudflare AI Gateway credits for " +
          "usage beyond the free tier. You can also connect Workers Observability to inspect logs, " +
          "invocations, traces, and aggregate metrics.",
      providesAuth: true,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly
      ? AUTH_SCOPES
      : persistentScopesForResources(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return OBSERVABILITY_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  #refreshing: { generation: number; token: Promise<string | null> } | undefined;
  // Bumped by every grant write. It keys and fences refreshes, so a replaced grant is detected even
  // when the new grant reuses the refresh token.
  #grantGeneration = 0;

  // This account's answers about its own access to subresources, keyed by subresource and
  // partitioned by the credentials that learned them (see #credentialsId), so an answer can't
  // outlive a disconnect that left storage behind, nor survive a reconnect, which may sign in as
  // another Cloudflare user. Bypassed while the account holds no credentials.
  #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the credentials installed now, or undefined while there are none. Every install names
  // its credentials afresh, and revoking deletes the name with everything else, so no load that
  // started under earlier credentials can find the same name when it finishes. Credentials
  // installed before names existed are named on first use.
  #credentialsId(): string | undefined {
    const kv = this.ctx.storage.kv;
    if (!kv.get<string>("refreshToken")) return undefined;
    let id = kv.get<string>("credentialsId");
    if (id === undefined) {
      id = crypto.randomUUID();
      kv.put<string>("credentialsId", id);
    }
    return id;
  }

  #config() {
    const config = getOAuthConfig(this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env));
    if (!config) throw new Error("The Cloudflare Gatekeeper is not configured.");
    return config;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    scopes: string[], ephemeral?: boolean) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    // Scopes to request (auth-only for sign-in, or the full capability set). Reused on reconnect.
    this.ctx.storage.kv.put<string[]>("scopes", scopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string, scopes: string[]) {
    this.ctx.storage.kv.put<string[]>("scopes", scopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  async getGrantedScopes(): Promise<string[]> {
    // Accounts connected before resource grants existed had exactly the billing scopes.
    return this.ctx.storage.kv.get<string[]>("grantedScopes") ?? [...BILLING_SCOPES];
  }

  /**
   * Verify+consume the initiation nonce; mint a fresh OAuth nonce + PKCE pair. Returns the OAuth
   * nonce (for the `state`) and the PKCE challenge (for the authorize URL), or null if invalid.
   */
  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; challenge: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const { verifier, challenge } = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
      verifier,
    });
    // Fail closed: a missing `scopes` key is legacy or corrupted state, so request only the billing
    // set rather than silently asking for observability the user never chose.
    const scopes = this.ctx.storage.kv.get<string[]>("scopes") ?? [...BILLING_SCOPES];
    return { oauthNonce, challenge, scopes };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    const tokens = await exchangeCode(this.#config(), code, stored.verifier).catch((cause: unknown) => {
      throw new Error("Cloudflare OAuth exchange failed.", { cause });
    });
    if (!tokens.refreshToken) {
      throw new Error("Cloudflare OAuth exchange returned no refresh token.");
    }

    // An omitted `scope` means the grant is exactly what this flow requested (RFC 6749 §5.1), so
    // record the request, never the full capability set: a billing-only flow must not advertise an
    // observability grant, or `ensureResources` would short-circuit into a binding that 403s with no
    // way to fix it. A missing request fails closed to billing, as in `beginOAuthFlow`.
    const grant: StoredGrant = {
      refreshToken: tokens.refreshToken,
      accessToken: { token: tokens.accessToken, expires: tokens.expiresAt ?? 0 },
      grantedScopes: tokens.scopes ?? this.ctx.storage.kv.get<string[]>("scopes") ?? [...BILLING_SCOPES],
    };

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#writeGrant(grant);
      try {
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call a provider revoke endpoint; we just drop
      // our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#writeGrant(grant);
  }

  #writeGrant(grant: StoredGrant) {
    this.#grantGeneration++;
    this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", grant.accessToken);
    this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
    this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
  }

  /**
   * Whether this account can read each subresource, in order. An account's telemetry needs a
   * telemetry read there to succeed; a Worker's needs that and for the Worker, looked up by its ID,
   * to be one this account can see, so a Worker that took its name since is never asked about.
   * Scopes are checked on every call, before anything is reused, so a connection whose grant lacks
   * telemetry, a billing-only one, is denied without asking Cloudflare. An allowed answer from
   * Cloudflare is reused for up to SUBRESOURCE_ACCESS_ALLOWED_TTL_MS and a denial for up to
   * SUBRESOURCE_ACCESS_DENIED_TTL_MS, under the credentials that learned it. Throws for an ID it
   * can't check, or when access can't be determined (no usable credentials, an outage, a
   * reconnect landing mid-check), which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check fails the whole call.
    const parsed = subresources.map(parseObservabilitySubresourceId);
    // Every answer must come from the credentials installed when the check began: a reconnect
    // landing between an account's check and its Worker's would otherwise pair one principal's
    // telemetry access with another's Worker.
    const credentials = this.#credentialsId();
    const granted = grantedObservabilityResourcePatterns(await this.getGrantedScopes());
    const answers = new Map<string, boolean>();
    // Each Cloudflare request is cached on its own, and asked one at a time, so a long list doesn't
    // trip Cloudflare's per-user rate limit.
    const ask = async (subresource: string) => {
      let answer = answers.get(subresource);
      if (answer === undefined) {
        answer = await this.#access.cached<boolean>(subresource,
          allowed => allowed ? SUBRESOURCE_ACCESS_ALLOWED_TTL_MS : SUBRESOURCE_ACCESS_DENIED_TTL_MS,
          () => this.#askCloudflare(subresource));
        answers.set(subresource, answer);
      }
      return answer;
    };

    const allowed: boolean[] = [];
    // A Worker's check starts with its account's, so a Worker is looked up only in an account this
    // one can read telemetry in.
    for (const { accountId, workerId } of parsed) {
      allowed.push(granted.includes(ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern) &&
        await ask(observabilitySubresourceId(accountId)) &&
        (workerId === undefined || (granted.includes(WORKER_OBSERVABILITY_RESOURCE.urlPattern) &&
          await ask(observabilitySubresourceId(accountId, workerId)))));
    }
    if (this.#credentialsId() !== credentials) {
      throw new Error("This Cloudflare connection was reconnected while its access was being checked.");
    }
    return allowed;
  }

  /** Cloudflare's answer for one subresource, from one request with this account's credentials. */
  async #askCloudflare(subresource: string): Promise<boolean> {
    const { accountId, workerId } = parseObservabilitySubresourceId(subresource);
    const getToken = async () => {
      const token = await this.getAccessToken();
      // Thrown as a plain error, which no check reads as a denial: an account without credentials
      // can't say what it may read.
      if (!token) throw new Error("This Cloudflare connection has no usable credentials to check access with.");
      return token;
    };
    try {
      if (workerId === undefined) {
        await new CloudflareObservabilityApi(getToken, accountId).listKeys({ limit: 1 });
        return true;
      }
      return await getWorker(getToken, accountId, { workerId }) !== null;
    } catch (error) {
      if (!deniesAccess(error)) throw error;
      logger.info("observer denied access to telemetry", {
        event: "observer.denied", status: error.status,
        subresourceKind: workerId === undefined ? "account" : "worker",
      });
      return false;
    }
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  /**
   * Returns a usable access token (refreshing if needed), or null if the credentials are gone or
   * can no longer be refreshed (in which case the workshop is notified via credentialsExpired()).
   * A refresh that fails without proving the grant dead falls back to the still-unexpired cached
   * token, or throws.
   */
  async getAccessToken(): Promise<string | null> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return null;

    const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
    if (cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return cached.token;
    }

    // Reads of one grant share a refresh, so a rotating refresh token is never redeemed twice. A read
    // after a reconnect starts its own rather than joining one whose result will be fenced out.
    const generation = this.#grantGeneration;
    if (this.#refreshing?.generation !== generation) {
      const flight = {
        generation,
        token: this.#refresh(refreshToken, generation).finally(() => {
          if (this.#refreshing === flight) this.#refreshing = undefined;
        }),
      };
      this.#refreshing = flight;
    }
    return this.#refreshing.token;
  }

  async #refresh(refreshToken: string, generation: number): Promise<string | null> {
    const outcome = await refreshTokens(this.#config(), refreshToken)
      .then(tokens => ({ tokens }), (error: unknown) => ({ error }));
    // A reconnect or revoke landed mid-flight, so its grant supersedes whatever this refresh got.
    if (this.#grantGeneration !== generation
      || this.ctx.storage.kv.get<string>("refreshToken") !== refreshToken) {
      return this.ctx.storage.kv.get<StoredAccessToken>("accessToken")?.token ?? null;
    }

    if ("error" in outcome) {
      const { error } = outcome;
      if (isGrantDeath(error)) {
        logger.info("refresh rejected; grant expired", { event: "credentials.refresh.expired", error });
        const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
        callback?.credentialsExpired().catch(err =>
          logger.warn("failed to notify credential expiry", {
            event: "credentials.expiry.notify.failed", error: err,
          }));
        return null;
      }
      logger.warn("access token refresh failed", { event: "credentials.refresh.failed", error });
      const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
      if (cached && cached.expires > Date.now()) return cached.token;
      throw error;
    }

    const refreshed = outcome.tokens;
    if (refreshed.refreshToken) {
      this.ctx.storage.kv.put<string>("refreshToken", refreshed.refreshToken);
    }
    if (refreshed.scopes) {
      this.ctx.storage.kv.put<string[]>("grantedScopes", refreshed.scopes);
    }
    const token: StoredAccessToken = {
      token: refreshed.accessToken,
      expires: refreshed.expiresAt ?? 0,
    };
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", token);
    return token.token;
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements CloudflareGatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const account = this.#account();
    // Both reads start before either is awaited, and settle together so a failure in one cannot
    // abandon the other as an unhandled rejection.
    const [token, grantedScopes] = await Promise.all([
      account.getAccessToken().catch(() => null), account.getGrantedScopes(),
    ]);
    const identity = token ? await fetchIdentity(token) : null;
    return {
      displayName: identity?.displayName,
      uniqueName: identity?.email,
      avatar: { url: CLOUDFLARE_LOGO_URL },
      grantedResourceUrlPatterns: grantedObservabilityResourcePatterns(grantedScopes),
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    const token = await this.#account().getAccessToken();
    if (!token) return null;
    const identity = await fetchIdentity(token);
    return identity?.email ?? null;
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{url?: string}> {
    const account = this.#account();
    const grantedPatterns = new Set(grantedObservabilityResourcePatterns(await account.getGrantedScopes()));
    if (resourceUrlPatterns.every(pattern => grantedPatterns.has(pattern))) return {};

    const union = [...new Set([...grantedPatterns, ...resourceUrlPatterns])];
    const initiationNonce = generateNonce();
    await account.prepareReconnect(initiationNonce, persistentScopesForResources(union));
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async getUsableAccessToken(): Promise<string | null> {
    return this.#account().getAccessToken().catch(() => null);
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return OBSERVABILITY_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const { userObjectId } = this.ctx.props;
    const { accountId, workerName } = parseObservabilityResourceUrl(url);
    if (workerName === undefined) {
      return {
        class: this.ctx.exports.CloudflareObservabilityGatekeeper({ props: { userObjectId, accountId } }),
        resource: ACCOUNT_OBSERVABILITY_RESOURCE,
      };
    }
    // The URL names the Worker, but the binding is to the Worker that has the name now: its ID goes
    // into the props the overseer stores, so a later rename, or another Worker taking the name,
    // can't move the binding.
    const account = this.#account();
    const worker = await getWorker(() => account.getAccessToken(), accountId, { name: workerName });
    if (!worker) throw new Error(`This Cloudflare account has no Worker named ${workerName}.`);
    return {
      class: this.ctx.exports.CloudflareObservabilityGatekeeper({
        props: { userObjectId, accountId, workerName: worker.name, workerId: worker.workerId },
      }),
      resource: WORKER_OBSERVABILITY_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const getToken = () => this.#account().getAccessToken();
    if (resourceUrlPattern === ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern) {
      return {
        iframeHtml: ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new CloudflareAccountConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === WORKER_OBSERVABILITY_RESOURCE.urlPattern) {
      return {
        iframeHtml: WORKER_CONFIGURATOR_HTML,
        ui: new RpcStub(new CloudflareWorkerConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Cloudflare resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    const scopes = await this.#account().getGrantedScopes();
    await this.#account().prepareReconnect(initiationNonce, scopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CloudflareVerifier({
      props: { userObjectId: this.ctx.props.userObjectId },
    });
  }
}

/** Vendor-specific verifier methods trusted only after the overseer's same-vendor handoff. */
export interface CloudflareVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether this connected Cloudflare account can read each subresource, in order, reusing recent
   * answers (see `UserAccount.checkSubresourceAccess`). Throws for an ID it can't check, or when
   * access can't be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

/** Verifies an observer's access using that observer's own Cloudflare credentials. */
@validateRpc()
export class CloudflareVerifier extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements CloudflareVerifierApi {
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return await account.checkSubresourceAccess(subresources);
  }
}

// Admits an observer only if their own account can read every subresource, as its UserAccount last
// learned (see UserAccount.checkSubresourceAccess for how long it reuses answers).
const verifyObservabilityAccess = observerAccessVerifier({
  hasCollectionAccess: (verifier: Fetcher<CloudflareVerifierApi>, subresources: readonly string[]) =>
    verifier.checkSubresourceAccess([...subresources]),
});

type CloudflareObservabilityGatekeeperProps = {
  userObjectId: string;
  accountId: string;
  /** The bound Worker's name when the binding was created, for display and its dashboard URL. */
  workerName?: string;
  /**
   * The bound Worker's immutable ID, which every read is pinned to. Absent from a Worker binding
   * created before bindings recorded it, which can no longer read anything (see #api).
   */
  workerId?: string;
};

@validateRpc()
export class CloudflareObservabilityGatekeeper
    extends DurableObject<Env, CloudflareObservabilityGatekeeperProps>
    implements Gatekeeper<CloudflareObservabilitySession> {
  // The bound Worker's name and versions as last resolved, reused for WORKER_SCOPE_TTL_MS.
  #workerScope: { resolved: Promise<WorkerScope>; at: number } | undefined;

  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  #api(): CloudflareObservabilityApi {
    const { accountId, workerName, workerId } = this.ctx.props;
    // A Worker binding that recorded only a name can't tell its Worker from one that took the name
    // since, so it reads nothing rather than trust whichever Worker has the name now.
    if (workerName !== undefined && workerId === undefined) {
      throw new Error(
        `This connection to the Worker ${workerName} predates Worker IDs, so it can't confirm ` +
        "which Worker it was granted. Remove it and connect the Worker again.");
    }
    const account = this.#account();
    const getToken = () => account.getAccessToken();
    return new CloudflareObservabilityApi(getToken, accountId,
      workerId === undefined ? undefined : () => this.#resolveWorkerScope(getToken, workerId));
  }

  #resolveWorkerScope(getToken: () => Promise<string | null>, workerId: string): Promise<WorkerScope> {
    const now = Date.now();
    if (this.#workerScope && now - this.#workerScope.at < WORKER_SCOPE_TTL_MS) {
      return this.#workerScope.resolved;
    }
    const entry = { resolved: resolveWorkerScope(getToken, this.ctx.props.accountId, workerId), at: now };
    this.#workerScope = entry;
    // A failure is not reused: the next read asks again.
    entry.resolved.catch(() => {
      if (this.#workerScope === entry) this.#workerScope = undefined;
    });
    return entry.resolved;
  }

  async describe(): Promise<ResourceDescription> {
    const workerName = this.ctx.props.workerName;
    return {
      url: workerName
        ? workerObservabilityUrl(this.ctx.props.accountId, workerName)
        : accountObservabilityUrl(this.ctx.props.accountId),
      title: workerName ? `${workerName} observability` : "Workers Observability",
      snippet: workerName
        ? `Read logs, invocations, metrics, and traces for ${workerName}.`
        : "Read logs, invocations, metrics, and traces across this Cloudflare account.",
      suggestedBindingName: workerName ? "WORKER_OBSERVABILITY" : "CLOUDFLARE_OBSERVABILITY",
      tsType: "CloudflareObservabilitySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareObservabilitySession> {
    const { accountId, workerName, workerId } = this.ctx.props;
    const api = this.#api();
    const target = workerId
      ? `Worker ${workerName} (ID ${workerId})`
      : `Cloudflare account ${accountId}`;
    return new CloudflareObservabilitySessionImpl(
      api, approvalQueue.dup(), target, observabilitySubresourceId(accountId, workerId));
  }

  /**
   * Observers: every read reports the binding's subresource, which the Workshop checks through
   * verifyObserverAccess(): `account/<accountId>` for an account binding, and
   * `account/<accountId>/worker/<workerId>` for a Worker binding, pinned to the Worker's immutable
   * ID. This keeps requiring the binding's own subresource at every admission, for the reads made
   * before reads reported it. A Worker binding that predates Worker IDs read whichever Worker had
   * its name at the time, so its collaborators must be able to read the whole account.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // The overseer only hands a verifier back to its own vendor, making this strategy-B ACL check
    // authoritative for the one account or Worker represented by the binding.
    const verifier = user as unknown as Fetcher<CloudflareVerifierApi>;
    const [allowed] = await verifier.checkSubresourceAccess(
      [observabilitySubresourceId(this.ctx.props.accountId, this.ctx.props.workerId)]);
    if (!allowed) {
      throw new Error("This collaborator does not have access to the bound Workers telemetry.");
    }
  }

  async removeObserver(_id: string): Promise<void> {
    // Strategy B verifies on each admission and retains no observer state to remove.
  }

  /**
   * Checks account and Worker subresources, as observabilitySubresourceId spells them, each against
   * the observer's own account; any other ID fails the whole call.
   */
  async verifyObserverAccess(
      observers: {id: string, verifier: Fetcher<GatekeeperUserVerifier>}[],
      subresources: string[]): Promise<{allowedObserverIds: string[]}> {
    return verifyObservabilityAccess(observers, subresources);
  }

  /**
   * `_cache` is unused (a read-only resource applies nothing), but declaring it keeps the
   * signature aligned with the `Gatekeeper` interface, which is also what lets the workerd test
   * suite pass a stand-in cache through the class-typed facet stub.
   */
  async applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("This resource is read-only.");
  }
  async rejectAction(_action: number): Promise<void> { throw new Error("This resource is read-only."); }
  async revertAction(_action: number): Promise<void> { throw new Error("This resource is read-only."); }
}
