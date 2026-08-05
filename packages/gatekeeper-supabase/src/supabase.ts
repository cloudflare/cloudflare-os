import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  SupabaseApi,
  SupabaseApiError,
  exchangeAuthCode,
  refreshAccessToken,
  revokeRefreshToken,
  type ProjectResponse,
} from "./supabase-api";
import { describeTable, listSchemas, listTables } from "./supabase-introspection";
import {
  SupabaseOrganizationConfiguratorUI,
  SupabaseProjectConfiguratorUI,
} from "./supabase-configurators";
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
};

type StoredToken = {
  token: string;
  expiresAt: number;
};

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

  // Verify the initiation nonce and mint a one-time OAuth `state` nonce. Returns null if invalid.
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
    });
    return oauthNonce;
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
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

    const grant = await exchangeAuthCode(code, clientId, clientSecret, `${getBaseUrl(this.env)}/oauth`);
    this.#storeGrant(grant.accessToken, grant.refreshToken, grant.expiresIn);
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        this.ctx.storage.kv.delete("accessToken");
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("accessTokenExpiresAt");
        throw error;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  #storeGrant(accessToken: string, refreshToken: string, expiresIn: number): void {
    this.ctx.storage.kv.put("accessToken", accessToken);
    this.ctx.storage.kv.put("refreshToken", refreshToken);
    this.ctx.storage.kv.put<number>("accessTokenExpiresAt", Date.now() + expiresIn * 1000);
  }

  // Returns a valid access token (and its expiry), transparently refreshing when close to expiry.
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

    try {
      const grant = await refreshAccessToken(refreshToken, clientId, clientSecret);
      this.#storeGrant(grant.accessToken, grant.refreshToken, grant.expiresIn);
      return { token: grant.accessToken, expiresAt: Date.now() + grant.expiresIn * 1000 };
    } catch (error) {
      // A revoked/expired refresh token surfaces as an auth error; record it so the UI prompts a
      // reconnect rather than surfacing a cryptic failure.
      if (error instanceof SupabaseApiError && error.isAuthError) {
        await this.noteCredentialsExpired();
      }
      throw error;
    }
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) {
      await callback.credentialsExpired();
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

  // Mint a verifier representing this account, used by SupabaseGatekeeperImpl.addObserver to confirm
  // a prospective observer may read a bound project (and, for org bindings, the org and each
  // accessed project). The verifier carries this user's own account id, so the access checks run
  // against the observer's *own* Supabase token.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: SupabaseVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.SupabaseVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Supabase uses the "ACL check (single unit)" strategy for project bindings and "data-set tracking
// (by project)" for organization bindings (see SupabaseGatekeeperImpl observer methods). Both
// reduce to two per-observer access questions answered against the observer's *own* token:
//   - hasProjectAccess(refs): the Management API's `/v1/projects` returns exactly the projects the
//     calling token can reach, so one response can check every requested ref.
//   - hasOrgAccess(slug):    likewise `/v1/organizations` lists the orgs the token belongs to.
// The overseer only ever hands this verifier back to a Supabase gatekeeper, which may therefore
// trust the boolean results.

type SupabaseVerifierProps = {
  userObjectId: string;
};

// The non-standard methods the Supabase gatekeeper calls on its own verifier (see addObserver). Not
// part of the generic GatekeeperUserVerifier contract.
export interface SupabaseVerifierApi extends GatekeeperUserVerifier {
  hasProjectAccess(refs: string[]): Promise<boolean[]>;
  hasOrgAccess(slug: string): Promise<boolean>;
}

type ProjectObservationCheck = {
  excludeObservers?: string[];
  pendingProjects: string[];
  commit(): void;
};

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
}

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

class SupabaseSessionContext {
  // A .dup() of the queue passed to startSession (so it outlives that call). We deliberately do not
  // dispose it ourselves: disposing a stub schedules an RPC release, and doing that during isolate
  // shutdown trips a fatal workerd assertion. Like the reference gatekeepers, we let the session's
  // RPC connection teardown reclaim it.
  readonly approvalQueue: RpcStub<ApprovalQueue>;
  #api: SupabaseApi;
  #cache: SupabaseCache;
  #pending: PendingActionStore;
  #noteExpired: () => Promise<void>;
  // Set only for organization bindings (data-set tracking). Given the project ref a project-scoped
  // observation is about to reveal, records it as an observed data set and returns the observer ids
  // that must not see it (those lacking access). Undefined for project bindings (single-unit ACL),
  // where there is nothing to exclude. See SupabaseGatekeeperImpl.#prepareProjectObservation.
  #projectObservationHook?: (ref: string) => Promise<ProjectObservationCheck>;

  constructor(
    api: SupabaseApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    cache: SupabaseCache,
    pending: PendingActionStore,
    noteExpired: () => Promise<void>,
    projectObservationHook?: (ref: string) => Promise<ProjectObservationCheck>,
  ) {
    this.#api = api;
    this.approvalQueue = approvalQueue;
    this.#cache = cache;
    this.#pending = pending;
    this.#noteExpired = noteExpired;
    this.#projectObservationHook = projectObservationHook;
  }

  // Authorize an observation that reveals data belonging to a specific project. For organization
  // bindings this also tracks the project as an observed data set and excludes any observers who
  // lack access to it; for project bindings it is a plain authorizeObservation. Use this (rather
  // than approvalQueue.authorizeObservation directly) for every read that exposes project data.
  async authorizeProjectObservation(
    ref: string,
    description: { title: string; description: string },
  ): Promise<void> {
    const check = this.#projectObservationHook
      ? await this.#projectObservationHook(ref)
      : {pendingProjects: [], commit() {}};
    await this.approvalQueue.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
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
      await this.approvalQueue.submitAction(actionId, {
        title: "Run SQL on Supabase",
        description:
            `Execute a mutating SQL statement against Supabase project \`${ref}\`.\n\n` +
            "```sql\n" + sql + "\n```" +
            (params && params.length > 0 ? `\n\nParameters: \`${JSON.stringify(params)}\`` : ""),
        // Arbitrary SQL cannot be automatically reverted.
        implementsRevert: false,
        // This gatekeeper doesn't simulate writes, so the agent shouldn't continue (and read back
        // un-applied state) until the user decides on this statement.
        awaitDecision: true,
      });
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
    // Organization bindings track which projects' data has actually been observed and exclude
    // observers who lack access to them; project bindings are a single ACL unit with nothing to
    // exclude, so they get no hook.
    const projectObservationHook = this.ctx.props.resourceKind === "organization"
      ? (ref: string) => this.#prepareProjectObservation(ref)
      : undefined;
    return new SupabaseSessionContext(
      this.#makeApi(),
      approvalQueue.dup(),
      new SupabaseCache(this.ctx.storage.kv),
      new PendingActionStore(this.ctx.storage.kv),
      async () => { await this.#userAccount().noteCredentialsExpired(); },
      projectObservationHook,
    );
  }

  // -------------------------------------------------------------------------
  // Observer tracking (see addObserver/removeObserver).

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedProjectKey(ref: string): string { return `observedProject:${ref}`; }

  #isProjectObserved(ref: string): boolean {
    const state = this.ctx.storage.kv.get<ObservedProjectState>(this.#observedProjectKey(ref));
    return state === true || state === "observed";
  }

  #listTrackedProjects(): string[] {
    const prefix = "observedProject:";
    return [...this.ctx.storage.kv.list<ObservedProjectState>({ prefix })]
      .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<SupabaseVerifierApi>]> {
    const prefix = "observer:";
    for (const [key, verifier] of this.ctx.storage.kv.list<Fetcher<SupabaseVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Organization bindings only. Marks the project pending and returns current observers who cannot
  // access it. Authorization promotes it; failed attempts remain pending and are rechecked.
  async #prepareProjectObservation(ref: string): Promise<ProjectObservationCheck> {
    if (this.#isProjectObserved(ref)) return {pendingProjects: [], commit() {}};
    const key = this.#observedProjectKey(ref);
    if (this.ctx.storage.kv.get<ObservedProjectState>(key) === undefined) {
      this.ctx.storage.kv.put(key, "pending");
    }
    const observers = [...this.#listObservers()];
    const access = await Promise.all(
      observers.map(([, verifier]) => verifier.hasProjectAccess([ref])),
    );
    const excluded = observers
      .filter((_, index) => !access[index][0])
      .map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingProjects: [ref],
      commit: () => this.ctx.storage.kv.put(key, "observed"),
    };
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
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SupabaseProject | SupabaseOrganization> {
    const context = this.#makeContext(approvalQueue);
    if (this.ctx.props.resourceKind === "project") {
      return new SupabaseProjectImpl(context, this.#requireRef());
    }
    return new SupabaseOrganizationImpl(context, this.#requireSlug());
  }

  // Approved: run the queued SQL statement for real, then drop it and invalidate cached schema
  // metadata (the database may have changed).
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

  // Rejected: discard the queued statement. There is no simulation state to roll back.
  async rejectAction(actionId: number): Promise<void> {
    new PendingActionStore(this.ctx.storage.kv).remove(actionId);
  }

  // Arbitrary SQL changes can't be reliably undone, so we don't offer automatic revert
  // (submitAction sets implementsRevert: false, so this is not normally reached).
  async revertAction(_action: number): Promise<void | { message?: string; canRetry?: boolean }> {
    return {
      message:
          "This SQL change can't be reverted automatically. To undo it, run a compensating " +
          "statement (e.g. a corresponding `DELETE`, `UPDATE`, or `DROP`).",
    };
  }

  // Observer tracking. Strategy depends on the binding's granularity:
  //
  // - Project binding — "ACL check (single unit)". Arbitrary read-only SQL can read anything in the
  //   project's database, so the project is the atomic unit. We just confirm the observer can access
  //   the project (their own `/v1/projects` lists it). Nothing read later could be outside that unit,
  //   so no observers are tracked and removeObserver is a no-op.
  //
  // - Organization binding — "data-set tracking (by project)". Org members may have access to
  //   different projects, so we track which projects' data the Gadget has actually observed and
  //   verify each observer against them. addObserver requires org membership (so org-level metadata
  //   like the project list is fine to show) plus access to every already-observed project; later,
  //   the first observation of a *new* project excludes any observer lacking it (see
  //   #prepareProjectObservation). Verified observers are remembered (their verifier stored) so that
  //   forward-exclusion check can run.
  //
  // The overseer re-runs addObserver on every open, catching loss of access promptly.
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

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Supabase organization",
      description: `Read metadata for the Supabase organization \`${this.#slug}\`.`,
    });
    return info;
  }

  async listProjects(): Promise<SupabaseProjectSummary[]> {
    const projects = await this.#ctx.cached(cacheKey("org-projects", this.#slug), METADATA_CACHE_TTL_MS, async api => {
      const all = await api.listProjects();
      return all.filter(project => project.organization_slug === this.#slug).map(projectSummary);
    });

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Supabase projects",
      description:
          `List the ${projects.length} project(s) in the Supabase organization \`${this.#slug}\`.`,
    });
    return projects;
  }

  async getProject(ref: string): Promise<SupabaseProject> {
    // Authorize first: this performs an external read and would otherwise be an unlogged
    // existence/membership oracle for arbitrary project refs.
    await this.#ctx.authorizeProjectObservation(ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
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

    await this.#ctx.authorizeProjectObservation(this.#ref, {
      title: "Describe Supabase table",
      description: `Read the structure of table \`${schema}.${name}\` in project \`${this.#ref}\`.`,
    });
    return details;
  }
}
