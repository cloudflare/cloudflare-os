import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  workerVersionTag,
  type AccountDescription,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationDescription,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import {
  SupabaseApi,
  SupabaseApiError,
  exchangeAuthCode,
  refreshAccessToken,
  revokeRefreshToken,
  type ProjectResponse,
  type SupabaseOAuthGrant,
} from "./supabase-api";
import { AUTO_APPROVABLE_KINDS, executeActionDescription } from "./supabase-actions";
import { describeTable, listSchemas, listTables } from "./supabase-introspection";
import {
  SupabaseOrganizationConfiguratorUI,
  SupabaseProjectConfiguratorUI,
} from "./supabase-configurators";
import {
  organizationSubresourceId,
  parseSupabaseSubresource,
  projectSubresourceId,
  type SupabaseSubresource,
} from "./subresources";
import type {
  SupabaseDatabase,
  SupabaseEdgeFunction,
  SupabaseListTablesOptions,
  SupabaseOrganization,
  SupabaseOrganizationInfo,
  SupabaseProject,
  SupabaseProjectInfo,
  SupabaseProjectStatus,
  SupabaseProjectSummary,
  SupabaseQueryResult,
  SupabaseServiceHealth,
  SupabaseStorageBucket,
  SupabaseTable,
  SupabaseTableDetails,
  SupabaseValue,
} from "./types";
import TYPES_CODE from "./types.txt";
import SUPABASE_LOGO_SVG from "./supabase-logo.svg";
import SUPABASE_PROJECT_CONFIGURATOR_HTML from "./generated/supabase-project-configurator-ui.txt";
import SUPABASE_ORGANIZATION_CONFIGURATOR_HTML from "./generated/supabase-organization-configurator-ui.txt";
import { obsContext } from "./observability.js";

const VENDOR_ID = "supabase";

const logger = obsContext.createLogger({
  component: "gatekeeper.supabase", vendorId: VENDOR_ID,
});

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
// Refresh the access token slightly before it actually expires to avoid races.
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

const HEALTH_SERVICES = ["auth", "db", "pooler", "realtime", "rest", "storage"];

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

type StoredToken = {
  token: string;
  expiresAt: number;
};

/**
 * A grant as persisted (or staged for a reconnect): the expiry is absolute, since the provider's
 * relative `expiresIn` counts from the exchange, not from whenever the grant is later made live.
 */
type StoredGrant = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

function toStoredGrant(grant: SupabaseOAuthGrant, now: number): StoredGrant {
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    accessTokenExpiresAt: now + grant.expiresIn * 1000,
  };
}

// A mutating SQL statement queued for human approval and applied once approved.
type StoredExecuteAction = {
  ref: string;
  sql: string;
  params?: SupabaseValue[];
  submittedAt: number;
};

type Cached<T> = {
  fetchedAt: number;
  value: T;
  generation: number;
};

// Cache TTLs. Project/org metadata and service lists change rarely; schema introspection can shift
// after DDL, so it gets a shorter TTL and is invalidated entirely when an action is applied.
const METADATA_CACHE_TTL_MS = 60 * 1000;
const SCHEMA_CACHE_TTL_MS = 30 * 1000;
// Re-fetch the access token from the UserAccount DO at most this often per gatekeeper session.
const SESSION_TOKEN_TTL_MS = 30 * 1000;
// How long an account's answer about its own access to an organization or project is reused (see
// UserAccount.checkSubresourceAccess). A grant is trusted for longer than a denial, so an observer
// just added to a project or organization is let in soon.
const SUBRESOURCE_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const SUBRESOURCE_ACCESS_DENIED_TTL_MS = 15_000;

type ResourceKind = "project" | "organization";

type SupabaseGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  ref?: string;
  slug?: string;
};

type GatekeeperUserImplProps = {
  userObjectId: string;
};

const SUPABASE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SUPABASE_LOGO_SVG)}`;

const PROJECT_RESOURCE: SupportedResource = {
  urlPattern: "https://supabase.com/dashboard/project/:ref",
  title: "Supabase Project",
  description:
      "Query and manage a project's Postgres database, and inspect its edge functions and storage.",
  icon: { url: SUPABASE_LOGO_URL },
};

const ORGANIZATION_RESOURCE: SupportedResource = {
  urlPattern: "https://supabase.com/dashboard/org/:slug",
  title: "Supabase Organization",
  description: "Discover and manage every project in a Supabase organization.",
  icon: { url: SUPABASE_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [PROJECT_RESOURCE, ORGANIZATION_RESOURCE];

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #b45309; font-size: 1.5rem;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #b45309; font-size: 1.5rem;">Supabase Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6;">Please configure a Supabase OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

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
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/supabase");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function projectUrl(ref: string): string {
  return `https://supabase.com/dashboard/project/${ref}`;
}

function organizationUrl(slug: string): string {
  return `https://supabase.com/dashboard/org/${slug}`;
}

// Builds a cache key from parts, encoding each so that identifiers containing the ":" delimiter
// (legal in Postgres) can't collide across different (schema, name) combinations.
function cacheKey(...parts: (string | number | boolean)[]): string {
  return parts.map(part => encodeURIComponent(String(part))).join(":");
}

// Defense-in-depth for query(): the read-only endpoint already runs in a read-only transaction as
// a restricted role (which blocks data/schema writes, and blocks pg_net since it writes to a
// queue table), but synchronous network/file extensions could still cause side effects if the
// role were ever granted EXECUTE on them. Reject statements that reference these primitives so
// such effects can only go through execute() (and thus approval). This is best-effort and
// non-exhaustive, not the primary control.
const SIDE_EFFECT_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /\bnet\s*\./i, name: "pg_net (net.*)" },
  { pattern: /\bdblink(_exec|_open|_send_query)?\s*\(/i, name: "dblink" },
  { pattern: /\bhttp_(get|post|put|delete|head|patch)\s*\(/i, name: "http extension" },
  { pattern: /\bpg_read_file\s*\(/i, name: "pg_read_file" },
  { pattern: /\bpg_read_binary_file\s*\(/i, name: "pg_read_binary_file" },
  { pattern: /\bpg_ls_dir\s*\(/i, name: "pg_ls_dir" },
  { pattern: /\bpg_stat_file\s*\(/i, name: "pg_stat_file" },
  { pattern: /\blo_(import|export)\s*\(/i, name: "large-object file access" },
  // Matches the actual COPY ... FROM/TO PROGRAM syntax, rather than the words "copy"/"program"
  // appearing anywhere (which would false-positive on ordinary SELECTs).
  { pattern: /\bcopy\b[\s\S]*?\b(from|to)\s+program\b/i, name: "COPY ... PROGRAM" },
];

function assertReadOnlyQuerySafe(sql: string): void {
  for (const { pattern, name } of SIDE_EFFECT_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(
        `query() is read-only and rejected a reference to ${name}, which can cause side effects. ` +
        `Use execute() for any statement with external effects.`,
      );
    }
  }
}

const PROJECT_STATUSES: ReadonlySet<SupabaseProjectStatus> = new Set([
  "INACTIVE", "ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY", "COMING_UP", "GOING_DOWN", "INIT_FAILED",
  "REMOVED", "RESTORING", "UPGRADING", "PAUSING", "RESTARTING", "PAUSE_FAILED", "RESTORE_FAILED",
  "RESIZING", "UNKNOWN",
]);

// The Management API status is an open string; map unrecognized values to "UNKNOWN" rather than
// trusting an unchecked cast.
function toProjectStatus(status: string): SupabaseProjectStatus {
  return PROJECT_STATUSES.has(status as SupabaseProjectStatus)
    ? (status as SupabaseProjectStatus)
    : "UNKNOWN";
}

function projectSummary(project: ProjectResponse): SupabaseProjectSummary {
  return {
    ref: project.ref,
    name: project.name,
    organizationSlug: project.organization_slug,
    region: project.region,
    status: toProjectStatus(project.status),
    createdAt: new Date(project.created_at),
    url: projectUrl(project.ref),
  };
}

// ---------------------------------------------------------------------------
// HTTP handler — drives the OAuth browser flow.

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
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const oauthNonce = await stub.beginOAuthFlow(initiationNonce);
      if (oauthNonce === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const redirectUrl = new URL("https://api.supabase.com/v1/oauth/authorize");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("state", `${doId}:${oauthNonce}`);
      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("Supabase authorization failed. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const badRequest = (message: string) =>
        new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

      const state = url.searchParams.get("state");
      if (!state) return badRequest("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return badRequest("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return badRequest("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return htmlResponse(connectHandoffPageHtml(handoff));
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
      displayName: "Supabase",
      url: "https://supabase.com",
      logo: { url: SUPABASE_LOGO_URL },
      color: "#f0fdf4",
      tagline: "Query Postgres, inspect schema, and manage projects",
      description:
          "Connect your Supabase account so Cloudflare OS can run SQL against your project databases, " +
          "explore schema, and inspect edge functions and storage for the projects you choose.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
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
// UserAccount DO — stores OAuth tokens and refreshes them on demand.

export class UserAccount extends DurableObject<Env> {
  // Guards against concurrent refreshes: Supabase rotates refresh tokens, so two simultaneous
  // refreshes with the same token would make the second fail with `invalid_grant`. DO calls
  // interleave at await points (e.g. describeTable fires three queries via Promise.all), so we
  // coalesce overlapping refreshes onto a single in-flight promise.
  #refreshInFlight?: Promise<StoredToken>;

  // This account's answers about its own access to organizations and projects, keyed by
  // subresource ID and partitioned by the credentials that learned them (see #credentialsId), so an
  // answer can't outlive a disconnect that left storage behind, nor survive a reconnect, which may
  // sign in as another Supabase user. Bypassed while the account holds no credentials.
  #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the credentials installed now, or undefined while there are none. Every install names
  // its credentials afresh (see #installGrant), and revoking deletes the name with everything
  // else, so no load that started under earlier credentials can find the same name when it
  // finishes. A token refresh renews the same grant and keeps the name. Credentials installed
  // before names existed are named on first use.
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
    clearCredentialExpiryLatch(this.ctx.storage.kv);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  /** Verify the initiation nonce and mint a one-time OAuth `state` nonce. Returns null if invalid. */
  async beginOAuthFlow(initiationNonce: string): Promise<string | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    return oauthNonce;
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    const clientId = this.env.CLIENT_ID;
    const clientSecret = this.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Supabase OAuth is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = toStoredGrant(
      await exchangeAuthCode(code, clientId, clientSecret, `${getBaseUrl(this.env)}/oauth`),
      Date.now(),
    );

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#installGrant(grant);
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        this.ctx.storage.kv.delete("accessToken");
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("accessTokenExpiresAt");
        this.ctx.storage.kv.delete("credentialsId");
        throw error;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#installGrant(grant);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  // Makes `grant` the account's credentials, named afresh (see #credentialsId) so that no access
  // answer learned under earlier credentials is reused. A refresh stores its grant with
  // #storeGrant alone: it renews these credentials rather than replacing them.
  #installGrant(grant: StoredGrant): void {
    this.#storeGrant(grant);
    this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
  }

  #storeGrant(grant: StoredGrant): void {
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<number>("accessTokenExpiresAt", grant.accessTokenExpiresAt);
  }

  /** Returns a valid access token (and its expiry), transparently refreshing when close to expiry. */
  async getAccessToken(): Promise<StoredToken> {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (!accessToken || !refreshToken) {
      throw new Error("Supabase credentials have not been configured for this account.");
    }

    if (Date.now() < expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return { token: accessToken, expiresAt };
    }

    // Coalesce concurrent refreshes (see #refreshInFlight). Setting the field is synchronous and
    // happens before the first await, so overlapping callers share one refresh.
    if (this.#refreshInFlight) {
      return await this.#refreshInFlight;
    }
    this.#refreshInFlight = this.#refresh(refreshToken);
    try {
      return await this.#refreshInFlight;
    } finally {
      this.#refreshInFlight = undefined;
    }
  }

  async #refresh(refreshToken: string): Promise<StoredToken> {
    const clientId = this.env.CLIENT_ID;
    const clientSecret = this.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Supabase OAuth is not configured.");
    }

    // Named before the request, so a reconnect or revoke that replaces these credentials while it
    // runs is seen when it returns.
    const installed = this.#credentialsId();
    try {
      const grant = toStoredGrant(
        await refreshAccessToken(refreshToken, clientId, clientSecret), Date.now());
      // Storing a refresh of replaced credentials would put the old account's tokens under the new
      // installation's name, where the access cache would serve one account's answers to the other.
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) return this.#installedToken();
      this.#storeGrant(grant);
      return { token: grant.accessToken, expiresAt: grant.accessTokenExpiresAt };
    } catch (error) {
      // The credentials that failed to refresh are no longer installed, so their failure says
      // nothing about the ones that are.
      if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) return this.#installedToken();
      // A revoked/expired refresh token surfaces as an auth error; record it so the UI prompts a
      // reconnect rather than surfacing a cryptic failure.
      if (error instanceof SupabaseApiError && error.isAuthError) {
        await this.noteCredentialsExpired();
      }
      throw error;
    }
  }

  // The installed token, for a refresh that a reconnect or revoke overtook.
  #installedToken(): StoredToken {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    if (!token) throw new Error("Supabase credentials have not been configured for this account.");
    return { token, expiresAt: this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0 };
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);
  }

  /**
   * Whether this account can read each organization or project subresource, in order. A project
   * ID asks only whether the account can reach that project (its organization in the ID is
   * identity, since projects move between organizations); an organization ID asks for membership.
   * An allowed answer is reused for up to SUBRESOURCE_ACCESS_ALLOWED_TTL_MS and a denial for up to
   * SUBRESOURCE_ACCESS_DENIED_TTL_MS, until credentials are next installed. Every answer comes from
   * the credentials installed when the check began: a reconnect partway through could otherwise
   * combine one Supabase account's answers with another's, so it fails the check. Throws for an ID
   * it can't check, or when access can't be determined (missing or expired credentials, a rate
   * limit, an outage), which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    const parsed = subresources.map(parseSupabaseSubresource);
    const installed = this.#credentialsId();
    const projectRefs = new Map<string, string>();
    const organizationSlugs = new Map<string, string>();
    parsed.forEach((resource, index) => {
      if (resource.kind === "project") projectRefs.set(subresources[index], resource.ref);
      else organizationSlugs.set(subresources[index], resource.slug);
    });
    const api = new SupabaseApi(async () => (await this.getAccessToken()).token);
    const ttl = (allowed: boolean) =>
      allowed ? SUBRESOURCE_ACCESS_ALLOWED_TTL_MS : SUBRESOURCE_ACCESS_DENIED_TTL_MS;
    const access = new Map<string, boolean>();
    // `/v1/projects` lists exactly the projects this account's token can reach, so one request
    // answers every project ID without a recent answer, and `/v1/organizations` likewise every
    // organization ID; one request at a time. Only absence from a list is a denial: a request
    // Supabase refuses says nothing about access, so it throws and nothing is cached.
    const projectIds = [...projectRefs.keys()];
    if (projectIds.length > 0) {
      const answers = await this.#access.cachedMany(projectIds, ttl, async missing => {
        const reachable = new Set(
          (await this.#askForAccessCheck(() => api.listProjects())).map(project => project.ref));
        return missing.map(subresource => reachable.has(projectRefs.get(subresource)!));
      });
      projectIds.forEach((subresource, index) => access.set(subresource, answers[index]));
    }
    const organizationIds = [...organizationSlugs.keys()];
    if (organizationIds.length > 0) {
      const answers = await this.#access.cachedMany(organizationIds, ttl, async missing => {
        const memberships = new Set(
          (await this.#askForAccessCheck(() => api.listOrganizations())).map(org => org.slug));
        return missing.map(subresource => memberships.has(organizationSlugs.get(subresource)!));
      });
      organizationIds.forEach((subresource, index) => access.set(subresource, answers[index]));
    }
    if (this.ctx.storage.kv.get<string>("credentialsId") !== installed) {
      throw new Error("This collaborator's Supabase connection changed while their access was being checked.");
    }
    return subresources.map(subresource => access.get(subresource)!);
  }

  // Makes one request for checkSubresourceAccess, naming an auth failure for what it is: this
  // account can't currently show what it can reach. Unlike SupabaseVerifier's legacy checks, which
  // read it as a denial, it throws, so the observer is refused without the answer being kept.
  async #askForAccessCheck<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof SupabaseApiError && error.isAuthError) {
        throw new Error(
          "This collaborator's Supabase credentials have expired or been revoked, so their access " +
          "cannot be checked until they reconnect.", { cause: error });
      }
      throw error;
    }
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (refreshToken && this.env.CLIENT_ID && this.env.CLIENT_SECRET) {
      try {
        await revokeRefreshToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      } catch (error) {
        logger.error("failed to revoke Supabase OAuth grant", {
          event: "oauth.grant.revoke.failed", error,
        });
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// GatekeeperUserImpl — maps resource URLs to gatekeeper DO classes.

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #getToken = async (): Promise<string> => {
    return (await this.#userAccount().getAccessToken()).token;
  };

  async #withApi<T>(fn: (api: SupabaseApi) => Promise<T>): Promise<T> {
    const api = new SupabaseApi(this.#getToken);
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof SupabaseApiError) {
        if (error.isAuthError) {
          await this.#userAccount().noteCredentialsExpired();
          throw new Error("Supabase credentials have expired or been revoked. Please reconnect the account.", { cause: error });
        }
        throw new Error(error.message, { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const organizations = await api.listOrganizations();
      const primary = organizations[0];
      return {
        displayName: primary ? primary.name : "Supabase account",
        uniqueName: primary?.slug,
        avatar: { url: SUPABASE_LOGO_URL },
      };
    });
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<SupabaseProject | SupabaseOrganization>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "supabase.com") {
      throw new Error(`Unsupported Supabase URL: ${url}`);
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] !== "dashboard" || segments.length < 3) {
      throw new Error(`Unsupported Supabase URL: ${url}`);
    }

    if (segments[1] === "project") {
      const props: SupabaseGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "project",
        ref: segments[2],
      };
      return { class: this.ctx.exports.SupabaseGatekeeperImpl({ props }), resource: PROJECT_RESOURCE };
    }

    if (segments[1] === "org") {
      const props: SupabaseGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "organization",
        slug: segments[2],
      };
      return { class: this.ctx.exports.SupabaseGatekeeperImpl({ props }), resource: ORGANIZATION_RESOURCE };
    }

    throw new Error(`Unsupported Supabase URL: ${url}`);
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === PROJECT_RESOURCE.urlPattern) {
      return {
        iframeHtml: SUPABASE_PROJECT_CONFIGURATOR_HTML,
        ui: new RpcStub(new SupabaseProjectConfiguratorUI(this.#getToken)),
      };
    }
    if (resourceUrlPattern === ORGANIZATION_RESOURCE.urlPattern) {
      return {
        iframeHtml: SUPABASE_ORGANIZATION_CONFIGURATOR_HTML,
        ui: new RpcStub(new SupabaseOrganizationConfiguratorUI(this.#getToken)),
      };
    }
    throw new Error(`Unsupported Supabase resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  /**
   * Mint a verifier representing this account, used by SupabaseGatekeeperImpl's addObserver and
   * verifyObserverAccess to confirm a prospective observer may read a bound project or
   * organization and the projects read through it (see those methods). The verifier carries this
   * user's own account id, so the access checks run against the observer's *own* Supabase token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: SupabaseVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.SupabaseVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Every read reports the organization and/or project it depends on (see
// SupabaseSessionContext.authorizeRead), which verifyObserverAccess checks through
// checkSubresourceAccess, answered by the observer's own UserAccount, which reuses recent answers.
// The legacy checks addObserver still makes for history recorded before reads reported them reduce
// to two per-observer access questions answered against the observer's *own* token, asked now:
//   - hasProjectAccess(refs): the Management API's `/v1/projects` returns exactly the projects the
//     calling token can reach, so one response can check every requested ref.
//   - hasOrgAccess(slug):    likewise `/v1/organizations` lists the orgs the token belongs to.
// The overseer only ever hands this verifier back to a Supabase gatekeeper, which may therefore
// trust the boolean results.

type SupabaseVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard methods the Supabase gatekeeper calls on its own verifier (see addObserver and
 * verifyObserverAccess). Not part of the generic GatekeeperUserVerifier contract.
 */
export interface SupabaseVerifierApi extends GatekeeperUserVerifier {
  hasProjectAccess(refs: string[]): Promise<boolean[]>;
  hasOrgAccess(slug: string): Promise<boolean>;
  /**
   * Whether the observer's account can read each organization or project subresource, in order,
   * reusing recent answers (see UserAccount.checkSubresourceAccess). Throws for an ID it can't
   * check, or when access can't be determined (expired credentials, a rate limit, an outage).
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

type ObservedProjectState = true | "pending" | "observed";

@validateRpc()
export class SupabaseVerifier extends WorkerEntrypoint<Env, SupabaseVerifierProps>
    implements SupabaseVerifierApi {
  #api(): SupabaseApi {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return new SupabaseApi(async () => (await account.getAccessToken()).token);
  }

  async hasProjectAccess(refs: string[]): Promise<boolean[]> {
    if (refs.length === 0) return [];
    try {
      const projects = await this.#api().listProjects();
      const accessibleRefs = new Set(projects.map(project => project.ref));
      return refs.map(ref => accessibleRefs.has(ref));
    } catch (error) {
      // A broken/expired observer token cannot demonstrate access; treat as "no access" rather than
      // failing the whole open. The observer will be re-checked on their next open.
      if (error instanceof SupabaseApiError && error.isAuthError) return refs.map(() => false);
      throw error;
    }
  }

  async hasOrgAccess(slug: string): Promise<boolean> {
    try {
      const orgs = await this.#api().listOrganizations();
      return orgs.some(org => org.slug === slug);
    } catch (error) {
      if (error instanceof SupabaseApiError && error.isAuthError) return false;
      throw error;
    }
  }

  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    const accounts = this.ctx.exports.UserAccount;
    return await accounts.get(accounts.idFromString(this.ctx.props.userObjectId))
      .checkSubresourceAccess(subresources);
  }
}

// Allows an observer only if their own account can read every organization and project a
// binding's reads reported, as their UserAccount last learned (see
// UserAccount.checkSubresourceAccess).
const verifySupabaseAccess = observerAccessVerifier({
  hasCollectionAccess: (verifier: Fetcher<SupabaseVerifierApi>, subresources: readonly string[]) =>
    verifier.checkSubresourceAccess([...subresources]),
});

// ---------------------------------------------------------------------------
// Action queue storage. Mutating SQL statements are stored here when submitted for approval and
// removed once applied or rejected.

class PendingActionStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #key(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: StoredExecuteAction): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#key(id), action);
    return id;
  }

  get(id: number): StoredExecuteAction | undefined {
    return this.#kv.get<StoredExecuteAction>(this.#key(id));
  }

  remove(id: number): void {
    this.#kv.delete(this.#key(id));
  }
}

// ---------------------------------------------------------------------------
// Cache for stable, read-only metadata (project info, schema introspection, etc.). Backed by the
// gatekeeper DO's KV storage and keyed within a "generation" that is bumped when an action is
// applied, so structural changes invalidate cached schema in one stroke.

class SupabaseCache {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #generation(): number {
    return this.#kv.get<number>("cache:generation") ?? 0;
  }

  bumpGeneration(): void {
    this.#kv.put("cache:generation", this.#generation() + 1);
  }

  get<T>(key: string, ttlMs: number): T | undefined {
    const cached = this.#kv.get<Cached<T>>(`cache:entry:${key}`);
    if (!cached || cached.generation !== this.#generation()) return undefined;
    if (Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    return cached.value;
  }

  put<T>(key: string, value: T): void {
    this.#kv.put<Cached<T>>(`cache:entry:${key}`, {
      fetchedAt: Date.now(),
      value,
      generation: this.#generation(),
    });
  }
}

// ---------------------------------------------------------------------------
// Session context shared by a session's RpcTargets.
//
// Holds the API client, error handling, the approval queue, the cache, and the pending-action
// store. It is NOT an RpcTarget — it is captured privately by the session objects.

/**
 * An observation that names every subresource it depends on, so a read that leaves them out, and
 * would fall back to the legacy observer protocol, is a type error (see authorizeRead).
 */
type SubresourceObservation = ObservationDescription & { subresources: string[] };

/** The resource a session's binding is pinned to, which decides what its reads report. */
type SessionBinding = { kind: "organization"; slug: string } | { kind: "project"; ref: string };

class SupabaseSessionContext {
  // A .dup() of the queue passed to startSession (so it outlives that call). We deliberately do not
  // dispose it ourselves: disposing a stub schedules an RPC release, and doing that during isolate
  // shutdown trips a fatal workerd assertion. Like the reference gatekeepers, we let the session's
  // RPC connection teardown reclaim it.
  #approvalQueue: RpcStub<ApprovalQueue>;
  #api: SupabaseApi;
  #cache: SupabaseCache;
  #pending: PendingActionStore;
  #noteExpired: () => Promise<void>;
  #binding: SessionBinding;

  constructor(
    api: SupabaseApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    cache: SupabaseCache,
    pending: PendingActionStore,
    noteExpired: () => Promise<void>,
    binding: SessionBinding,
  ) {
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#cache = cache;
    this.#pending = pending;
    this.#noteExpired = noteExpired;
    this.#binding = binding;
  }

  // Authorizes a read, reporting every subresource it depends on, which the Workshop checks through
  // SupabaseGatekeeperImpl.verifyObserverAccess. Every observation goes through here, with the IDs
  // from organizationSubresources or projectSubresources (see authorizeProjectRead); none feeds the
  // legacy tracker addObserver still checks.
  async authorizeRead(observation: SubresourceObservation): Promise<void> {
    await this.#approvalQueue.authorizeObservation(observation);
  }

  // What a read of the bound organization's own metadata depends on: membership of it, which
  // addObserver required of every observer before reads reported it, and no project, since such
  // a read reveals no project's data that the legacy tracker would have recorded.
  organizationSubresources(): string[] {
    if (this.#binding.kind !== "organization") {
      throw new Error("Only a Supabase organization binding reads organization metadata.");
    }
    return [organizationSubresourceId(this.#binding.slug)];
  }

  // What a read revealing project `ref`'s data depends on. Through an organization binding: the
  // organization, whose membership addObserver requires, and the project, which such a read
  // recorded as observed. Through a project binding: the project alone, which is all addObserver
  // checks there, named under the organization Supabase says owns it. That comes from the cached
  // project info (fetchProjectInfo), so a read costs no extra request while it is fresh, and a
  // project whose organization is unknown is not read rather than reported without it.
  async projectSubresources(ref: string): Promise<string[]> {
    if (this.#binding.kind === "organization") {
      const { slug } = this.#binding;
      return [organizationSubresourceId(slug), projectSubresourceId(slug, ref)];
    }
    if (ref !== this.#binding.ref) {
      throw new Error(`This binding reads only the Supabase project ${this.#binding.ref}.`);
    }
    const { organizationSlug } = await fetchProjectInfo(this, ref);
    if (!organizationSlug) {
      throw new Error(
        `Supabase did not say which organization owns the project ${ref}, so who may see data ` +
        `read from it cannot be checked. Try again later, or reconnect the account.`);
    }
    return [projectSubresourceId(organizationSlug, ref)];
  }

  // Authorizes a read revealing project `ref`'s data (see projectSubresources). Use this for every
  // read that exposes project data.
  async authorizeProjectRead(
    ref: string, description: Omit<ObservationDescription, "subresources">,
  ): Promise<void> {
    await this.authorizeRead({ ...description, subresources: await this.projectSubresources(ref) });
  }

  async run<T>(fn: (api: SupabaseApi) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#api);
    } catch (error) {
      if (error instanceof SupabaseApiError) {
        if (error.isAuthError) {
          await this.#noteExpired();
          throw new Error("Supabase credentials have expired or been revoked. Please reconnect the account.", { cause: error });
        }
        // Re-throw as a plain Error so the gadget sees a clean message without the internal
        // "SupabaseApiError:" class-name prefix. The message (including any Postgres detail) is kept.
        throw new Error(error.message, { cause: error });
      }
      throw error;
    }
  }

  // Returns a cached value if fresh, otherwise loads it (with auth handling) and caches it.
  async cached<T>(key: string, ttlMs: number, loader: (api: SupabaseApi) => Promise<T>): Promise<T> {
    const hit = this.#cache.get<T>(key, ttlMs);
    if (hit !== undefined) return hit;
    const value = await this.run(loader);
    this.#cache.put(key, value);
    return value;
  }

  // Submits a mutating SQL statement for approval. The statement is NOT run here; it runs in
  // SupabaseGatekeeperImpl.applyAction() once approved. (The approval contract is between this
  // gatekeeper and the Workshop/approver and is intentionally invisible to the calling Gadget.)
  async submitExecute(ref: string, sql: string, params?: SupabaseValue[]): Promise<void> {
    const action: StoredExecuteAction = { ref, sql, params, submittedAt: Date.now() };
    const actionId = this.#pending.submit(action);
    try {
      await this.#approvalQueue.submitAction(actionId, executeActionDescription(ref, sql, params));
    } catch (error) {
      this.#pending.remove(actionId);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-resource instance, runs as a facet of the Overseer.

@validateRpc()
export class SupabaseGatekeeperImpl extends DurableObject<Env, SupabaseGatekeeperImplProps>
    implements Gatekeeper<SupabaseProject | SupabaseOrganization> {

  // Cache of the access token on this DO instance (shared across the resource's sessions/requests),
  // so repeated API calls — including the parallel queries inside describeTable — don't each make a
  // round-trip to the UserAccount DO. #tokenFetch coalesces concurrent fetches.
  #accessToken?: StoredToken;
  #tokenFetch?: Promise<string>;

  #userAccount() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #getAccessToken = async (): Promise<string> => {
    const cached = this.#accessToken;
    if (cached && cached.expiresAt > Date.now() + SESSION_TOKEN_TTL_MS) {
      return cached.token;
    }
    if (this.#tokenFetch) {
      return await this.#tokenFetch;
    }
    this.#tokenFetch = (async () => {
      const fresh = await this.#userAccount().getAccessToken();
      this.#accessToken = fresh;
      return fresh.token;
    })();
    try {
      return await this.#tokenFetch;
    } finally {
      this.#tokenFetch = undefined;
    }
  };

  #makeApi(): SupabaseApi {
    return new SupabaseApi(this.#getAccessToken);
  }

  #makeContext(approvalQueue: RpcStub<ApprovalQueue>): SupabaseSessionContext {
    const binding: SessionBinding = this.ctx.props.resourceKind === "project"
      ? { kind: "project", ref: this.#requireRef() }
      : { kind: "organization", slug: this.#requireSlug() };
    return new SupabaseSessionContext(
      this.#makeApi(),
      approvalQueue.dup(),
      new SupabaseCache(this.ctx.storage.kv),
      new PendingActionStore(this.ctx.storage.kv),
      async () => { await this.#userAccount().noteCredentialsExpired(); },
      binding,
    );
  }

  // -------------------------------------------------------------------------
  // Legacy observer tracking (see addObserver/removeObserver). Reads no longer record projects
  // here; what earlier reads recorded stays, and addObserver keeps checking it.

  #observerKey(id: string): string { return `observer:${id}`; }

  #listTrackedProjects(): string[] {
    const prefix = "observedProject:";
    return [...this.ctx.storage.kv.list<ObservedProjectState>({ prefix })]
      .map(([key]) => key.slice(prefix.length));
  }

  // Caches infrequent metadata reads (used by describe()) in the same DO-backed cache the session
  // uses, so repeated describe() calls don't re-hit the Management API.
  async #cachedMetadata<T>(key: string, loader: (api: SupabaseApi) => Promise<T>): Promise<T> {
    const cache = new SupabaseCache(this.ctx.storage.kv);
    const hit = cache.get<T>(key, METADATA_CACHE_TTL_MS);
    if (hit !== undefined) return hit;
    const value = await loader(this.#makeApi());
    cache.put(key, value);
    return value;
  }

  // The props are set by getGatekeeperClassFor() based on resourceKind, but guard rather than
  // asserting non-null so a malformed/legacy binding fails with a clear message.
  #requireRef(): string {
    const ref = this.ctx.props.ref;
    if (!ref) throw new Error("This Supabase project gatekeeper is missing its project ref.");
    return ref;
  }

  #requireSlug(): string {
    const slug = this.ctx.props.slug;
    if (!slug) throw new Error("This Supabase organization gatekeeper is missing its org slug.");
    return slug;
  }

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "project") {
      const ref = this.#requireRef();
      const project = await this.#cachedMetadata(cacheKey("describe-project", ref), api => api.getProject(ref));
      return {
        url: projectUrl(ref),
        title: project.name,
        snippet: `${project.region} · ${project.status}`,
        suggestedBindingName: "SUPABASE_PROJECT",
        tsType: "SupabaseProject",
      };
    }

    const slug = this.#requireSlug();
    const organizations = await this.#cachedMetadata(cacheKey("describe-orgs"), api => api.listOrganizations());
    const org = organizations.find(o => o.slug === slug);
    return {
      url: organizationUrl(slug),
      title: org ? org.name : slug,
      snippet: "Supabase organization",
      suggestedBindingName: "SUPABASE_ORGANIZATION",
      tsType: "SupabaseOrganization",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return AUTO_APPROVABLE_KINDS;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SupabaseProject | SupabaseOrganization> {
    const context = this.#makeContext(approvalQueue);
    if (this.ctx.props.resourceKind === "project") {
      return new SupabaseProjectImpl(context, this.#requireRef());
    }
    return new SupabaseOrganizationImpl(context, this.#requireSlug());
  }

  /**
   * Approved: run the queued SQL statement for real, then drop it and invalidate cached schema
   * metadata (the database may have changed).
   */
  async applyAction(actionId: number): Promise<void> {
    const pending = new PendingActionStore(this.ctx.storage.kv);
    const action = pending.get(actionId);
    if (!action) {
      throw new Error(`Unknown pending Supabase action: ${actionId}`);
    }
    try {
      await this.#makeApi().runQuery(action.ref, action.sql, action.params);
    } catch (error) {
      // On expired/revoked credentials, signal the account so the user is prompted to reconnect.
      // The action stays queued (we don't remove it) so it can be retried after reconnecting.
      if (error instanceof SupabaseApiError && error.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
        throw new Error("Supabase credentials have expired or been revoked. Reconnect the account, then retry.", { cause: error });
      }
      throw error;
    }
    pending.remove(actionId);
    new SupabaseCache(this.ctx.storage.kv).bumpGeneration();
  }

  /** Rejected: discard the queued statement. There is no simulation state to roll back. */
  async rejectAction(actionId: number): Promise<void> {
    new PendingActionStore(this.ctx.storage.kv).remove(actionId);
  }

  /**
   * Arbitrary SQL changes can't be reliably undone, so we don't offer automatic revert
   * (submitAction sets implementsRevert: false, so this is not normally reached).
   */
  async revertAction(_action: number): Promise<void | { message?: string; canRetry?: boolean }> {
    return {
      message:
          "This SQL change can't be reverted automatically. To undo it, run a compensating " +
          "statement (e.g. a corresponding `DELETE`, `UPDATE`, or `DROP`).",
    };
  }

  /**
   * Observer tracking. Every read reports the subresources it depends on (see
   * SupabaseSessionContext.authorizeRead), which the Workshop checks through
   * verifyObserverAccess: a project binding reports its project, an organization binding its
   * organization plus the project whose data a read reveals.
   *
   * These checks now guard only legacy history, the reads made before they reported subresources
   * and reads by a Worker version still running that code during a rollout, so they stay as they
   * were, asking with the observer's own token, now, through hasProjectAccess / hasOrgAccess, which
   * reuse no answers:
   *
   * - Project binding — "ACL check (single unit)". Arbitrary read-only SQL can read anything in the
   *   project's database, so the project is the atomic unit. We just confirm the observer can access
   *   the project (their own `/v1/projects` lists it). Nothing read later could be outside that unit,
   *   so no observers are tracked and removeObserver is a no-op.
   *
   * - Organization binding — "data-set tracking (by project)". Org members may have access to
   *   different projects, so earlier reads recorded which projects' data the Gadget observed
   *   (`observedProject:` keys, pending ones included). addObserver requires org membership plus
   *   access to every recorded project. Verified observers are still remembered (their verifier
   *   stored), since a Worker version still recording projects excludes observers by them. Reads no
   *   longer record projects or exclude observers.
   *
   * The overseer re-runs addObserver on every open, catching loss of access promptly.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<SupabaseVerifierApi>;

    if (this.ctx.props.resourceKind === "project") {
      const ref = this.#requireRef();
      const [hasAccess] = await verifier.hasProjectAccess([ref]);
      if (!hasAccess) {
        throw new Error(
          `This collaborator does not have access to the Supabase project ${ref}, so they cannot ` +
          `be allowed to observe data this workspace read from it.`);
      }
      return;
    }

    const slug = this.#requireSlug();
    if (!(await verifier.hasOrgAccess(slug))) {
      throw new Error(
        `This collaborator is not a member of the Supabase organization ${slug}, so they cannot ` +
        `be allowed to observe it.`);
    }
    const checked = new Set<string>();
    while (true) {
      const refs = this.#listTrackedProjects().filter(ref => !checked.has(ref));
      if (refs.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      const projectAccess = await verifier.hasProjectAccess(refs);
      for (const [index, ref] of refs.entries()) {
        if (!projectAccess[index]) {
          throw new Error(
            `This collaborator does not have access to the Supabase project ${ref}, whose data the ` +
            `workspace has read, so they cannot be allowed to observe it.`);
        }
        checked.add(ref);
      }
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }

  /**
   * Checks the subresources this binding's reads report (see SupabaseSessionContext.authorizeRead),
   * failing the whole call for any other ID: an organization binding accepts only IDs under its
   * own organization; a project binding only its own project, under any organization, since a
   * project can move between organizations. An observer is allowed when their own account can read
   * each, as their UserAccount last learned (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    for (const subresource of subresources) {
      this.#assertReportedHere(parseSupabaseSubresource(subresource));
    }
    return await verifySupabaseAccess(observers, subresources);
  }

  // Refuses a subresource this binding's reads never report.
  #assertReportedHere(resource: SupabaseSubresource): void {
    if (this.ctx.props.resourceKind === "project") {
      if (resource.kind !== "project" || resource.ref !== this.#requireRef()) {
        throw new Error("Not a subresource this Supabase project binding reports.");
      }
      return;
    }
    if (resource.slug !== this.#requireSlug()) {
      throw new Error("Not a subresource this Supabase organization binding reports.");
    }
  }
}

// ---------------------------------------------------------------------------
// Session implementations.

// Fetches (and caches) full project info. Shared so SupabaseOrganization.getProject() and
// SupabaseProject.getInfo() hit the same cache entry instead of fetching the project twice.
async function fetchProjectInfo(ctx: SupabaseSessionContext, ref: string): Promise<SupabaseProjectInfo> {
  return await ctx.cached(cacheKey("project-info", ref), METADATA_CACHE_TTL_MS, async api => {
    const project = await api.getProject(ref);
    return {
      ...projectSummary(project),
      database: {
        host: project.database?.host ?? "",
        postgresVersion: project.database?.version ?? "",
      },
    };
  });
}

@validateRpc()
class SupabaseOrganizationImpl extends RpcTarget implements SupabaseOrganization {
  #ctx: SupabaseSessionContext;
  #slug: string;

  constructor(ctx: SupabaseSessionContext, slug: string) {
    super();
    this.#ctx = ctx;
    this.#slug = slug;
  }

  async getInfo(): Promise<SupabaseOrganizationInfo> {
    const info = await this.#ctx.cached(cacheKey("org", this.#slug), METADATA_CACHE_TTL_MS, async api => {
      const organizations = await api.listOrganizations();
      const org = organizations.find(o => o.slug === this.#slug);
      if (!org) {
        throw new Error(`Organization ${this.#slug} is not accessible with the connected account.`);
      }
      return { slug: org.slug, name: org.name, url: organizationUrl(org.slug) };
    });

    await this.#ctx.authorizeRead({
      title: "Read Supabase organization",
      description: `Read metadata for the Supabase organization \`${this.#slug}\`.`,
      subresources: this.#ctx.organizationSubresources(),
    });
    return info;
  }

  async listProjects(): Promise<SupabaseProjectSummary[]> {
    const projects = await this.#ctx.cached(cacheKey("org-projects", this.#slug), METADATA_CACHE_TTL_MS, async api => {
      const all = await api.listProjects();
      return all.filter(project => project.organization_slug === this.#slug).map(projectSummary);
    });

    // Reports the organization alone, as the legacy tracker recorded no project for a listing: the
    // list is organization metadata every member was admitted to see.
    await this.#ctx.authorizeRead({
      title: "List Supabase projects",
      description:
          `List the ${projects.length} project(s) in the Supabase organization \`${this.#slug}\`.`,
      subresources: this.#ctx.organizationSubresources(),
    });
    return projects;
  }

  async getProject(ref: string): Promise<SupabaseProject> {
    // Authorize first: this performs an external read and would otherwise be an unlogged
    // existence/membership oracle for arbitrary project refs.
    await this.#ctx.authorizeProjectRead(ref, {
      title: "Open Supabase project",
      description: `Look up Supabase project \`${ref}\` within organization \`${this.#slug}\`.`,
    });

    // Verify the project belongs to this organization before handing out a capability for it.
    const project = await fetchProjectInfo(this.#ctx, ref);
    if (project.organizationSlug !== this.#slug) {
      throw new Error(`Project ${ref} is not part of organization ${this.#slug}.`);
    }
    return new SupabaseProjectImpl(this.#ctx, ref);
  }
}

@validateRpc()
class SupabaseProjectImpl extends RpcTarget implements SupabaseProject {
  #ctx: SupabaseSessionContext;
  #ref: string;

  constructor(ctx: SupabaseSessionContext, ref: string) {
    super();
    this.#ctx = ctx;
    this.#ref = ref;
  }

  async getInfo(): Promise<SupabaseProjectInfo> {
    const info = await fetchProjectInfo(this.#ctx, this.#ref);

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "Read Supabase project",
      description: `Read metadata for the Supabase project \`${this.#ref}\`.`,
    });
    return info;
  }

  async getDatabase(): Promise<SupabaseDatabase> {
    // Returns a capability only; no external data is read here, so no observation is recorded.
    return new SupabaseDatabaseImpl(this.#ctx, this.#ref);
  }


  async checkHealth(): Promise<SupabaseServiceHealth[]> {
    // Not cached: health is a liveness probe where staleness defeats the purpose.
    const health = await this.#ctx.run(api => api.getServicesHealth(this.#ref, HEALTH_SERVICES));
    const result = health.map(item => ({ service: item.name, status: item.status, error: item.error }));

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "Check Supabase project health",
      description: `Check the health of services for the Supabase project \`${this.#ref}\`.`,
    });
    return result;
  }

  async listEdgeFunctions(): Promise<SupabaseEdgeFunction[]> {
    const functions = await this.#ctx.cached(cacheKey("functions", this.#ref), METADATA_CACHE_TTL_MS, async api => {
      const list = await api.listFunctions(this.#ref);
      return list.map(fn => ({
        slug: fn.slug,
        name: fn.name,
        status: fn.status,
        version: fn.version,
        verifyJwt: fn.verify_jwt ?? false,
        createdAt: new Date(fn.created_at),
        updatedAt: new Date(fn.updated_at),
      }));
    });

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "List Supabase edge functions",
      description: `List the ${functions.length} edge function(s) deployed to project \`${this.#ref}\`.`,
    });
    return functions;
  }

  async getEdgeFunctionSource(slug: string): Promise<string> {
    const source = await this.#ctx.cached(
      cacheKey("function-source", this.#ref, slug),
      METADATA_CACHE_TTL_MS,
      api => api.getFunctionBody(this.#ref, slug),
    );

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "Read Supabase edge function source",
      description: `Read the deployed source of edge function \`${slug}\` in project \`${this.#ref}\`.`,
    });
    return source;
  }

  async listStorageBuckets(): Promise<SupabaseStorageBucket[]> {
    const buckets = await this.#ctx.cached(cacheKey("buckets", this.#ref), METADATA_CACHE_TTL_MS, async api => {
      const list = await api.listStorageBuckets(this.#ref);
      return list.map(bucket => ({
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        createdAt: new Date(bucket.created_at),
        updatedAt: new Date(bucket.updated_at),
      }));
    });

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "List Supabase storage buckets",
      description: `List the ${buckets.length} storage bucket(s) in project \`${this.#ref}\`.`,
    });
    return buckets;
  }
}

@validateRpc()
class SupabaseDatabaseImpl extends RpcTarget implements SupabaseDatabase {
  #ctx: SupabaseSessionContext;
  #ref: string;

  constructor(ctx: SupabaseSessionContext, ref: string) {
    super();
    this.#ctx = ctx;
    this.#ref = ref;
  }

  async query(sql: string, params?: SupabaseValue[]): Promise<SupabaseQueryResult> {
    assertReadOnlyQuerySafe(sql);
    // Read-only queries are not cached (the SQL and parameters are arbitrary and dynamic). The
    // result size is bounded inside runReadOnlyQuery (it throws before returning an oversized body).
    const rows = await this.#ctx.run(api => api.runReadOnlyQuery(this.#ref, sql, params));

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "Run read-only SQL on Supabase",
      description:
          `Run a read-only query against Supabase project \`${this.#ref}\`.\n\n` +
          "```sql\n" + sql + "\n```",
    });
    return { rows: rows as SupabaseQueryResult["rows"], rowCount: rows.length };
  }

  async execute(sql: string, params?: SupabaseValue[]): Promise<void> {
    // Reject statements with no executable content (blank, or only SQL comments) so no-ops can't
    // clog the queue. Comment stripping is only used for this emptiness test, never on the
    // SQL we actually store and run.
    const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    if (withoutComments.trim().length === 0) {
      throw new Error("execute() requires a non-empty SQL statement.");
    }
    return await this.#ctx.submitExecute(this.#ref, sql, params);
  }

  async listSchemas(): Promise<string[]> {
    const schemas = await this.#ctx.cached(
      cacheKey("schemas", this.#ref),
      SCHEMA_CACHE_TTL_MS,
      api => listSchemas(api, this.#ref),
    );

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "List Supabase schemas",
      description: `List the ${schemas.length} schema(s) in the database of project \`${this.#ref}\`.`,
    });
    return schemas;
  }

  async listTables(options?: SupabaseListTablesOptions): Promise<SupabaseTable[]> {
    const schema = options?.schema ?? "public";
    const includeViews = options?.includeViews ?? true;
    // Pass the resolved values (not raw `options`) to the loader so what's cached always matches
    // the cache key, even if SupabaseListTablesOptions gains fields later.
    const tables = await this.#ctx.cached(
      cacheKey("tables", this.#ref, schema, includeViews),
      SCHEMA_CACHE_TTL_MS,
      api => listTables(api, this.#ref, { schema, includeViews }),
    );

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "List Supabase tables",
      description:
          `List the ${tables.length} table(s)/view(s) in schema \`${schema}\` of project \`${this.#ref}\`.`,
    });
    return tables;
  }

  async describeTable(schema: string, name: string): Promise<SupabaseTableDetails> {
    const details = await this.#ctx.cached(
      cacheKey("table", this.#ref, schema, name),
      SCHEMA_CACHE_TTL_MS,
      api => describeTable(api, this.#ref, schema, name),
    );

    await this.#ctx.authorizeProjectRead(this.#ref, {
      title: "Describe Supabase table",
      description: `Read the structure of table \`${schema}.${name}\` in project \`${this.#ref}\`.`,
    });
    return details;
  }
}
