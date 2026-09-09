import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentCatalog,
  renderBrowserFlowCompletionHtml,
  stripTrailingSlashes,
  type AccountDescription,
  type ActionKind,
  type AgentCatalog,
  type AppUiContext,
  type ApprovalQueue,
  type ConnectionHealthStatus,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperReconnectOptions,
  type GatekeeperUiFrame,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationAuthorizer,
  type ObservationDescription,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import APP_HTML from "./app.txt";
import TICKET_CONFIGURATOR_HTML from "./generated/ticket-configurator-ui.txt";
import TYPES_CODE from "./types.txt";
import { codingTools, toolOk, toolPending, zendeskActionResultToToolResult } from "./coding-session.js";
import {
  MAX_ATTACHMENT_BYTES,
  SUBDOMAIN_RE,
  ZendeskApi,
  ZendeskApiError,
  buildAuthorizeUrl,
  exchangeAuthCode,
  normalizeSubdomain,
  refreshAccessToken,
  ticketUrl,
  type ZendeskAttachment,
  type ZendeskAudit,
  type ZendeskComment,
  type ZendeskIdentity,
  type ZendeskOAuthGrant,
  type ZendeskTicket,
  type ZendeskUser as ZendeskApiUser,
} from "./zendesk-api.js";
import type {
  WorkItemAttachment,
  WorkItemAttachmentContent,
  WorkItemAttachmentUploadInput,
  WorkItemAttachmentUploadResult,
  WorkItemComment,
  WorkItemCommentInput,
  WorkItemDetail,
  WorkItemFieldPatch,
  WorkItemLinkResult,
  WorkItemManagementApi,
  WorkItemMediaCapabilities,
  WorkItemProviderRef,
  WorkItemRead,
  WorkItemSavedView,
  WorkItemSearchPage,
  WorkItemSearchRequest,
  WorkItemSourceStatuses,
  WorkItemSummary,
  WorkItemsCurrentUser,
  WorkItemsManagementApi,
  ZendeskAccountSession,
  ZendeskActionResult,
  ZendeskCodingSessionToolInfo,
  ZendeskCodingSessionToolResult,
  ZendeskCurrentUser,
  ZendeskQueuedAction,
  ZendeskTicketSearchRequest,
  ZendeskTicketSession,
} from "./types.js";

type Env = Cloudflare.Env & { BASE_URL?: string; CLIENT_ID?: string; CLIENT_SECRET?: string; PUBLIC_BASE_URL?: string };
type Exports = Record<string, any>;
type Props = { accountId: string; subdomain: string; ticketId?: string };
type StoredNonce = { value: string; expiresAt: number; returnUrl?: string };
type StoredUpload = {
  token: string;
  ticketId: string;
  attachment: WorkItemAttachment;
  expiresAtMs: number;
  expiresAt: string;
  consumed?: boolean;
};
type PendingAction =
  | {
      kind: "comment";
      ticketId: string;
      body: string;
      public: boolean;
      uploadTokens: string[];
      synthetic: WorkItemComment;
      updateStamp: string;
    }
  | {
      kind: "fields";
      ticketId: string;
      fields: Record<string, string | number | boolean | null | string[]>;
      updateStamp: string;
    };
type StoredAction = PendingAction & { id: number; status: "pending" | "applying" | "applied" | "failed"; claimedAt?: number };

const OAUTH_SCOPE = "read write";
const CONNECT_TIMEOUT_MS = 15 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_SKEW_MS = 60_000;
const BODY_MAX = 12_000;
const DESCRIPTION_MAX = 60_000;
const FIELD_MAX = 2_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
/** `/api/v2/search.json` returns at most 1,000 results per query. Only `/api/v2/search/export` pages past it. */
const SEARCH_CEILING = 1000;
const EXPORT_CURSOR_PREFIX = "zdx1";
const EXPORT_CURSOR_MAX = 2_048;
const MAX_UPLOAD_TOKENS = 10;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const ACTION_KINDS = [
  { tag: "zendesk.comment", label: "Zendesk comment" },
  { tag: "zendesk.update-fields", label: "Zendesk field update" },
] as const satisfies ActionKind[];
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://:subdomain.zendesk.com",
  title: "Zendesk Account",
  description: "Search and manage tickets in one Zendesk subdomain.",
};
const TICKET_RESOURCE: SupportedResource = {
  urlPattern: "https://:subdomain.zendesk.com/agent/tickets/:ticketId",
  title: "Zendesk Ticket",
  description: "Read and manage one Zendesk ticket and its comments.",
};
const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='#03363d'/><path d='M58 80h86l-86 96h86v-96Zm54 0h86l-86 96h86v-96Z' fill='#fff'/></svg>",
  ),
};
const logger = createLogger<{ event?: string; error?: unknown; accountId?: string; subdomain?: string }>({
  component: "gatekeeper.zendesk",
});

function exportsOf(ctx: { exports?: Exports } | unknown): Exports {
  return (ctx as { exports: Exports }).exports;
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/zendesk");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getWorkshopPublicBaseUrl(env: Env): URL {
  if (env.PUBLIC_BASE_URL) return new URL(stripTrailingSlashes(env.PUBLIC_BASE_URL));
  return new URL(new URL(getBaseUrl(env)).origin);
}

function validateNativeReturnUrl(env: Env, value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length > 4096) throw new Error("Invalid native OAuth return URL.");
  let returnUrl: URL;
  try {
    returnUrl = new URL(value);
  } catch {
    throw new Error("Invalid native OAuth return URL.");
  }
  if (
    returnUrl.origin !== getWorkshopPublicBaseUrl(env).origin ||
    returnUrl.username ||
    returnUrl.password ||
    returnUrl.search ||
    returnUrl.hash ||
    !/^\/native\/oauth-return\/[A-Za-z0-9_-]{16,256}$/.test(returnUrl.pathname)
  ) {
    throw new Error("Invalid native OAuth return URL.");
  }
  return returnUrl.toString();
}

function textResponse(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

function parseZendeskAccountId(exports: Exports, accountId: string): unknown | null {
  try {
    return exports.ZendeskAccount.idFromString(accountId);
  } catch {
    return null;
  }
}

function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function zendeskOauthContinueResponse(authorizeUrl: string): Response {
  const url = new URL(authorizeUrl);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".zendesk.com") ||
    !SUBDOMAIN_RE.test(url.hostname.slice(0, -".zendesk.com".length)) ||
    url.pathname !== "/oauth/authorizations/new"
  ) {
    throw new Error("Invalid Zendesk OAuth URL.");
  }
  return new Response(
    `<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${htmlAttribute(url.toString())}"><title>Continue to Zendesk</title></head><body><p>Continuing to Zendesk...</p><script>location.replace(${JSON.stringify(url.toString())});</script></body></html>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function boundedString(value: unknown, max: number, fallback = ""): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const trimmed = raw.replaceAll(String.fromCharCode(0), "").replace(/[\t\r\n ]+/g, " ").trim();
  return (trimmed || fallback).slice(0, max);
}

function boundedBody(value: unknown): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  return raw.replaceAll(String.fromCharCode(0), "").trim().slice(0, BODY_MAX);
}

function normalizeTicketId(value: unknown): string {
  const id = boundedString(value, 40);
  if (!/^\d+$/.test(id)) throw new Error("Zendesk ticket id must be numeric.");
  return id;
}

function pageLimit(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value ?? DEFAULT_LIMIT);
  return Math.min(Math.max(Number.isFinite(number) ? Math.floor(number) : DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function parseCursor(cursor: unknown): number {
  if (cursor == null || cursor === "") return 1;
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new Error("Zendesk cursor is invalid.");
  return page;
}

function isExportCursor(cursor: unknown): cursor is string {
  return typeof cursor === "string" && cursor.startsWith(`${EXPORT_CURSOR_PREFIX}.`);
}

/**
 * Binds an export cursor to the exact site, scoped query, and page size that produced it. This is an integrity tag,
 * not a secret: it stops a cursor minted for another Zendesk site or a different query from silently paging an
 * unrelated result set. Cross-account reads remain impossible regardless, because the request still carries only this
 * session's own token.
 */
async function exportFingerprint(subdomain: string, query: string, limit: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${subdomain}\n${query}\n${limit}`));
  return Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mintExportCursor(fingerprint: string, after: string): string {
  return `${EXPORT_CURSOR_PREFIX}.${fingerprint}.${after}`;
}

function parseExportCursor(cursor: string, expected: string): string {
  if (cursor.length > EXPORT_CURSOR_MAX) throw new Error("Zendesk export cursor is invalid.");
  const fingerprint = cursor.split(".")[1] ?? "";
  // The opaque Zendesk cursor may itself contain dots, so take everything after the fingerprint verbatim.
  const after = cursor.slice(EXPORT_CURSOR_PREFIX.length + fingerprint.length + 2);
  if (!/^[0-9a-f]{16}$/.test(fingerprint) || !/^[A-Za-z0-9._~+/=-]+$/.test(after)) throw new Error("Zendesk export cursor is invalid.");
  if (fingerprint !== expected) throw new Error("Zendesk export cursor is for a different site, query, or page size. Restart the search.");
  return after;
}

function actionKey(id: number): string { return `action:${id}`; }
function resultKey(id: number): string { return `result:${id}`; }
function uploadKey(token: string): string { return `upload:${token}`; }

function privateObservation(title: string, description: string): ObservationDescription {
  return { title, description, prohibitAllSharing: true };
}

function ticketObservation(title: string, description: string): ObservationDescription {
  return { title, description };
}

function connectHtml(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Zendesk</title></head><body style="font-family:system-ui;margin:2rem"><main style="max-width:520px;margin:auto"><h1>Connect Zendesk</h1><p>Enter your Zendesk subdomain. Example: <code>acme</code> for <code>acme.zendesk.com</code>.</p><form method="post"><label>Zendesk subdomain <input required name="subdomain" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{1,61}[A-Za-z0-9](\\.zendesk\\.com)?" style="display:block;width:100%;padding:.6rem;margin:.4rem 0"></label><button style="padding:.6rem 1rem">Continue to Zendesk</button></form></main></body></html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const relPath = url.pathname.slice(getBasePath(env).length);
    const parts = relPath.split("/").filter(Boolean);

    if (parts[0] === "connect" && parts[1] && parts[2]) {
      if (!/^[0-9a-f]{64}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) {
        return textResponse("Invalid Zendesk connection link.");
      }
      const exports = exportsOf(ctx);
      const parsedAccountId = parseZendeskAccountId(exports, parts[1]);
      if (!parsedAccountId) return textResponse("Invalid Zendesk connection link.");
      const account = exports.ZendeskAccount.get(parsedAccountId);
      if (request.method === "GET") {
        return new Response(connectHtml(), {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (request.method !== "POST") return textResponse("Method Not Allowed", 405);
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return textResponse("Zendesk OAuth is not configured.", 503);
      const form = await request.formData();
      const subdomain = normalizeSubdomain(String(form.get("subdomain") ?? ""));
      let returnUrl: string | undefined;
      try {
        returnUrl = validateNativeReturnUrl(env, url.searchParams.get("returnUrl") ?? undefined);
      } catch {
        return textResponse("Invalid native OAuth return URL.");
      }
      const begun = await account.beginOAuth(parts[2], subdomain, returnUrl);
      if (!begun) return textResponse("Invalid or expired Zendesk connection link.");
      return zendeskOauthContinueResponse(buildAuthorizeUrl({
        subdomain,
        clientId: env.CLIENT_ID,
        redirectUri: `${getBaseUrl(env)}/oauth`,
        scope: OAUTH_SCOPE,
        state: `${parts[1]}:${begun.oauthNonce}`,
      }));
    }

    if (relPath === "/oauth") {
      const [accountId, oauthNonce] = (url.searchParams.get("state") ?? "").split(":");
      if (!/^[0-9a-f]{64}$/.test(accountId) || !/^[0-9a-f]{64}$/.test(oauthNonce)) {
        return textResponse("Invalid OAuth state.");
      }
      const code = boundedString(url.searchParams.get("code"), 1000);
      if (!code) return textResponse("Zendesk did not return an authorization code.");
      const exports = exportsOf(ctx);
      const parsedAccountId = parseZendeskAccountId(exports, accountId);
      if (!parsedAccountId) return textResponse("Invalid OAuth state.");
      const accepted = await exports.ZendeskAccount
        .get(parsedAccountId)
        .acceptAuthCode(code, oauthNonce);
      if (!accepted) return textResponse("Invalid or expired OAuth state.");
      return new Response(renderBrowserFlowCompletionHtml({ appName: "Odie OS", returnUrl: accepted.returnUrl }), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Zendesk",
      url: "https://www.zendesk.com/",
      logo: ICON,
      color: "#03363d",
      tagline: "Read and manage Zendesk tickets",
      description: "Connect Zendesk Support so agents can search tickets, read normalized Work Items-compatible data, stage attachments, and request ticket comments or field updates.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const exports = exportsOf(this.ctx);
    const accountId = exports.ZendeskAccount.newUniqueId();
    const nonce = randomNonce();
    await exports.ZendeskAccount.get(accountId).setCallback(callback, nonce, validateNativeReturnUrl(this.env, options?.returnUrl));
    return { url: `${getBaseUrl(this.env)}/connect/${accountId}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return [ACCOUNT_RESOURCE, TICKET_RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class ZendeskAccount extends DurableObject<Env> {
  #refreshing?: Promise<string>;
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string, returnUrl?: string): Promise<void> {
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_TTL_MS, returnUrl });
    if (!this.ctx.storage.kv.get<ZendeskOAuthGrant>("grant")) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
  }

  async beginOAuth(nonce: string, subdomain: string, returnUrl?: string): Promise<{ oauthNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !timingSafeEqual(stored.value, nonce)) return null;
    if (this.ctx.storage.kv.get("grant") && subdomain !== this.ctx.storage.kv.get("subdomain")) throw new Error("Reconnect must use the original Zendesk subdomain.");
    const oauthNonce = randomNonce();
    this.ctx.storage.kv.put("subdomain", subdomain);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + NONCE_TTL_MS,
      returnUrl: returnUrl ?? stored.returnUrl,
    });
    return { oauthNonce };
  }

  async acceptAuthCode(code: string, nonce: string): Promise<{ returnUrl?: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    const subdomain = this.ctx.storage.kv.get<string>("subdomain");
    if (!stored || Date.now() >= stored.expiresAt || !timingSafeEqual(stored.value, nonce) || !subdomain) return null;
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) throw new Error("Zendesk OAuth is not configured.");
    this.ctx.storage.kv.delete("nonce");
    const grant = await exchangeAuthCode({
      subdomain,
      code,
      clientId: this.env.CLIENT_ID,
      clientSecret: this.env.CLIENT_SECRET,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
      scope: OAUTH_SCOPE,
    });
    this.ctx.storage.kv.put<ZendeskOAuthGrant>("grant", grant);
    this.ctx.storage.kv.delete("identity");
    this.ctx.storage.kv.delete("expiredNotified");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Zendesk connection attempt was abandoned.");
    if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      await callback.complete(exportsOf(this.ctx).ZendeskUserImpl({ props: { accountId: this.ctx.id.toString(), subdomain } }));
    }
    await this.ctx.storage.deleteAlarm();
    return { returnUrl: stored.returnUrl };
  }

  async getAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<ZendeskOAuthGrant>("grant");
    const subdomain = this.ctx.storage.kv.get<string>("subdomain");
    if (!grant || !subdomain) throw new Error("Zendesk credentials have not been configured.");
    if (grant.expiresAt === null || Date.now() < grant.expiresAt - TOKEN_SKEW_MS) return grant.accessToken;
    // Older persisted grants invented a one-hour expiry, including non-expiring tokens.
    // Without a refresh token, let Zendesk decide whether that token is still usable.
    if (!grant.refreshToken || !this.env.CLIENT_ID || !this.env.CLIENT_SECRET) return grant.accessToken;
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#refresh(grant, subdomain);
    try { return await this.#refreshing; }
    finally { this.#refreshing = undefined; }
  }

  async #refresh(grant: ZendeskOAuthGrant, subdomain: string): Promise<string> {
    try {
      const refreshed = await refreshAccessToken({
        subdomain,
        refreshToken: grant.refreshToken!,
        clientId: this.env.CLIENT_ID!,
        clientSecret: this.env.CLIENT_SECRET!,
        scope: grant.scope ?? OAUTH_SCOPE,
      });
      if (this.ctx.storage.kv.get<ZendeskOAuthGrant>("grant")?.accessToken !== grant.accessToken) throw new Error("Zendesk credentials changed during refresh. Retry the operation.");
      if (!refreshed.refreshToken) refreshed.refreshToken = grant.refreshToken;
      refreshed.scope ??= grant.scope;
      this.ctx.storage.kv.put<ZendeskOAuthGrant>("grant", refreshed);
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof ZendeskApiError && error.isAuthError && this.ctx.storage.kv.get<ZendeskOAuthGrant>("grant")?.accessToken === grant.accessToken) await this.notifyExpired();
      throw error;
    }
  }

  async identity(): Promise<ZendeskIdentity | undefined> { return this.ctx.storage.kv.get<ZendeskIdentity>("identity"); }
  async storeIdentity(identity: ZendeskIdentity): Promise<void> { this.ctx.storage.kv.put("identity", identity); }
  async prepareReconnect(nonce: string, returnUrl?: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_TTL_MS, returnUrl });
  }
  async notifyExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    try { await callback.credentialsExpired(); }
    catch (error) { logger.warn("failed to notify Zendesk credential expiry", { event: "credentials.expiry.notify.failed", error }); }
  }
  async revoke(): Promise<void> { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
  async alarm(): Promise<void> { if (!this.ctx.storage.kv.get<ZendeskOAuthGrant>("grant")) await this.ctx.storage.deleteAll(); }
}

@validateRpc()
export class ZendeskUserImpl extends WorkerEntrypoint<Env, Props> implements GatekeeperUser {
  #account(): DurableObjectStub<ZendeskAccount> {
    const exports = exportsOf(this.ctx);
    return exports.ZendeskAccount.get(exports.ZendeskAccount.idFromString(this.ctx.props.accountId));
  }
  #api(): ZendeskApi { return new ZendeskApi(this.ctx.props.subdomain, () => this.#account().getAccessToken()); }

  async describe(): Promise<AccountDescription> {
    let identity = await this.#account().identity() as ZendeskIdentity | undefined;
    if (!identity) {
      identity = (await this.#api().me()).user;
      await this.#account().storeIdentity(identity);
    }
    return {
      displayName: identity.name ?? `Zendesk ${this.ctx.props.subdomain}`,
      uniqueName: identity.email ?? `${this.ctx.props.subdomain}.zendesk.com`,
      avatar: identity.photo?.content_url ? { url: identity.photo.content_url } : ICON,
      singleton: { tsType: "ZendeskAccountSession" },
      providesUi: {
        title: "Zendesk",
        icon: ICON,
        composition: { kind: "work-items", role: "zendesk", embeddedOnly: true },
      },
      codingSessionResourceUrls: [`https://${this.ctx.props.subdomain}.zendesk.com`],
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [ACCOUNT_RESOURCE, TICKET_RESOURCE]; }
  async ensureResources(): Promise<{ url?: string }> { return {}; }
  async getConnectionStatus(): Promise<ConnectionHealthStatus> {
    try { await this.#api().me(); return { state: "healthy", message: "Zendesk credentials are usable." }; }
    catch (error) {
      if (error instanceof ZendeskApiError && error.status === 401) await this.#account().notifyExpired();
      return { state: error instanceof ZendeskApiError && error.status === 401 ? "expired" : "unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const parsed = new URL(url);
    const subdomain = normalizeSubdomain(parsed.hostname);
    if (parsed.origin !== `https://${this.ctx.props.subdomain}.zendesk.com` || parsed.username || parsed.password) throw new Error("Zendesk URL is outside the connected subdomain.");
    const ticketId = parsed.pathname.match(/^\/agent\/tickets\/(\d+)\/?$/)?.[1];
    if (!ticketId && parsed.pathname !== "/") throw new Error("Unsupported Zendesk resource URL; select the account root or a ticket URL.");
    return {
      class: exportsOf(this.ctx).ZendeskGatekeeper({ props: { accountId: this.ctx.props.accountId, subdomain, ticketId } }),
      resource: ticketId ? TICKET_RESOURCE : ACCOUNT_RESOURCE,
    };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ZendeskAccountSession>>> {
    return exportsOf(this.ctx).ZendeskGatekeeper({ props: this.ctx.props });
  }
  async startResourceConfigurator(): Promise<ResourceConfiguratorFrame> {
    return { iframeHtml: TICKET_CONFIGURATOR_HTML, ui: new RpcStub(new TicketConfiguratorUI(this.ctx.props.subdomain)) };
  }
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    return { iframeHtml: APP_HTML, ui: new RpcStub(new ZendeskWorkItemsManagementAdapter(exportsOf(this.ctx).ZendeskGatekeeper({ props: this.ctx.props }))) };
  }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  async reconnect(options?: GatekeeperReconnectOptions): Promise<{ url: string }> {
    const nonce = randomNonce();
    await this.#account().prepareReconnect(nonce, validateNativeReturnUrl(this.env, options?.returnUrl));
    return { url: `${getBaseUrl(this.env)}/connect/${this.ctx.props.accountId}/${nonce}` };
  }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return exportsOf(this.ctx).ZendeskVerifier({ props: this.ctx.props });
  }
}

export interface ZendeskVerifierApi extends GatekeeperUserVerifier { hasTicketAccess(subdomain: string, ticketId: string): Promise<boolean>; }

@validateRpc()
export class ZendeskVerifier extends WorkerEntrypoint<Env, Props> implements ZendeskVerifierApi {
  async hasTicketAccess(subdomain: string, ticketId: string): Promise<boolean> {
    if (subdomain !== this.ctx.props.subdomain) return false;
    const exports = exportsOf(this.ctx);
    const account = exports.ZendeskAccount.get(exports.ZendeskAccount.idFromString(this.ctx.props.accountId));
    try { return (await new ZendeskApi(subdomain, () => account.getAccessToken()).showTicket(normalizeTicketId(ticketId))) !== null; }
    catch (error) { if (error instanceof ZendeskApiError && (error.isAuthError || error.isNotFound)) return false; throw error; }
  }
}

@validateRpc()
class TicketConfiguratorUI extends RpcTarget {
  constructor(private readonly subdomain: string) { super(); }
  async resourceUrl(ticketId?: string): Promise<string> { return ticketUrl(this.subdomain, normalizeTicketId(ticketId)); }
}

@validateRpc()
class ZendeskWorkItemsManagementAdapter extends RpcTarget implements WorkItemsManagementApi {
  constructor(private readonly gatekeeper: DurableObjectStub<ZendeskGatekeeper>) { super(); }
  async getCurrentUser(): Promise<WorkItemsCurrentUser> { return this.gatekeeper.getCurrentUser(); }
  async listSavedViews(): Promise<WorkItemSavedView[]> { return []; }
  async saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView> { return view; }
  async deleteSavedView(_id: string): Promise<void> {}
  async getSourceStatuses(): Promise<WorkItemSourceStatuses> { return this.gatekeeper.sourceStatuses(); }
  async search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage> { return this.gatekeeper.searchTickets(request); }
  async item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi> {
    if (ref.source !== "zendesk") throw new Error("Native Zendesk source can only open Zendesk refs.");
    return new RpcStub(new ZendeskManagementTicketAdapter(this.gatekeeper, normalizeTicketId(ref.id))) as unknown as WorkItemManagementApi;
  }
}

class ZendeskManagementTicketAdapter extends RpcTarget implements WorkItemManagementApi {
  constructor(private readonly gatekeeper: DurableObjectStub<ZendeskGatekeeper>, private readonly ticketId: string) { super(); }
  read(): Promise<WorkItemRead> { return this.gatekeeper.readTicket(this.ticketId); }
  readAttachment(id: string): Promise<WorkItemAttachmentContent> { return this.gatekeeper.readAttachment(this.ticketId, id); }
  mediaCapabilities(): Promise<WorkItemMediaCapabilities> { return mediaCapabilities(); }
  createAttachment(input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult> { return this.gatekeeper.stageUpload(this.ticketId, input); }
  async addComment(input: WorkItemCommentInput): Promise<WorkItemDetail> { return this.gatekeeper.directComment(this.ticketId, input); }
  async updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail> { return this.gatekeeper.directUpdateFields(this.ticketId, patch); }
  transition(_transitionId: string): Promise<WorkItemDetail> { throw new Error("Zendesk tickets do not expose workflow transitions through this source."); }
  linkTo(_other: WorkItemProviderRef): Promise<WorkItemLinkResult> { throw new Error("Native Zendesk does not create Work Items links."); }
}

@validateRpc()
export class ZendeskGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<ZendeskAccountSession | ZendeskTicketSession> {
  #account(): DurableObjectStub<ZendeskAccount> {
    const exports = exportsOf(this.ctx);
    return exports.ZendeskAccount.get(exports.ZendeskAccount.idFromString(this.ctx.props.accountId));
  }
  #api(): ZendeskApi { return new ZendeskApi(this.ctx.props.subdomain, () => this.#account().getAccessToken()); }

  async describe(): Promise<ResourceDescription> {
    const url = this.ctx.props.ticketId ? ticketUrl(this.ctx.props.subdomain, this.ctx.props.ticketId) : `https://${this.ctx.props.subdomain}.zendesk.com`;
    return {
      url,
      title: this.ctx.props.ticketId ? `Zendesk ticket ${this.ctx.props.ticketId}` : `${this.ctx.props.subdomain}.zendesk.com`,
      snippet: this.ctx.props.ticketId ? "Single Zendesk ticket with comments, field updates, and staged attachments." : "Zendesk account-wide ticket source.",
      suggestedBindingName: this.ctx.props.ticketId ? "ZENDESK_TICKET" : "ZENDESK",
      tsType: this.ctx.props.ticketId ? "ZendeskTicketSession" : "ZendeskAccountSession",
    };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return [...ACTION_KINDS]; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<ZendeskAccountSession | ZendeskTicketSession> {
    return this.ctx.props.ticketId
      ? new ZendeskTicketSessionImpl(this, this.ctx.props.ticketId, queue.dup())
      : new ZendeskAccountSessionImpl(this, queue.dup());
  }
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    await authorizer.authorizeObservation(privateObservation("Read Zendesk catalog", "Discovered native Zendesk ticket search, read, comment, field update, and staged attachment capabilities."));
    return boundAgentCatalog([{ id: "zendesk:tickets", title: "Zendesk tickets", description: `Search and read tickets in ${this.ctx.props.subdomain}.zendesk.com.` }]);
  }
  async addObserver(_id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    if (!this.ctx.props.ticketId) throw new Error("Zendesk account-wide observations are private to the connected account.");
    const sameVendor = verifier as Fetcher<ZendeskVerifierApi>;
    if (!await sameVendor.hasTicketAccess(this.ctx.props.subdomain, this.ctx.props.ticketId)) {
      throw new Error("Observer cannot access this Zendesk ticket.");
    }
  }
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(id: number): Promise<void> {
    const action = this.#claimAction(id);
    if (!action) return;
    try {
      const result = action.kind === "comment"
        ? await this.#applyComment(action)
        : await this.#applyFields(action);
      this.ctx.storage.kv.put<ZendeskActionResult>(resultKey(action.id), { status: "ready", result });
      action.status = "applied";
      this.ctx.storage.kv.put(actionKey(id), action);
    } catch (error) {
      const guidance = error instanceof ZendeskApiError && error.status === 409
        ? "Ticket update conflict. Read the latest ticket and submit a new action with the intended changes."
        : "The write outcome may be ambiguous. Read the ticket and its history to verify whether it applied before submitting a new action; do not blindly repeat the write.";
      this.ctx.storage.kv.put<ZendeskActionResult>(resultKey(action.id), { status: "failed", message: `${guidance} ${boundedString(error instanceof Error ? error.message : String(error), 240)}` });
      action.status = "failed";
      this.ctx.storage.kv.put(actionKey(id), action);
      throw error;
    }
  }
  async rejectAction(id: number): Promise<void> {
    const action = this.ctx.storage.kv.get<StoredAction>(actionKey(id));
    if (action?.kind === "comment") for (const token of action.uploadTokens) this.ctx.storage.kv.delete(uploadKey(token));
    this.ctx.storage.kv.delete(actionKey(id));
    if (action) this.ctx.storage.kv.put<ZendeskActionResult>(resultKey(id), { status: "rejected" });
  }
  revertAction(): Promise<void> { throw new Error("Zendesk actions are not revertable by this gatekeeper."); }

  async getCurrentUser(): Promise<ZendeskCurrentUser> {
    const identity = (await this.#api().me()).user;
    return { id: String(identity.id), displayName: identity.name ?? undefined, uniqueName: identity.email ?? `${this.ctx.props.subdomain}.zendesk.com` };
  }
  async sourceStatuses(): Promise<WorkItemSourceStatuses> {
    try {
      await this.#api().me();
      return { jira: { configured: false, connected: false, reason: "Native Zendesk source only." }, zendesk: { configured: true, connected: true } };
    } catch (error) {
      return { jira: { configured: false, connected: false, reason: "Native Zendesk source only." }, zendesk: { configured: true, connected: false, reason: boundedString(error instanceof Error ? error.message : String(error), 512) } };
    }
  }
  async searchTickets(request?: Partial<WorkItemSearchRequest & { query?: string; cursor?: string; limit?: number; exhaustive?: boolean }>): Promise<WorkItemSearchPage> {
    const source = request?.source ?? "zendesk";
    if (source !== "zendesk" && source !== "both") throw new Error("Native Zendesk source only searches Zendesk.");
    const cursor = typeof request?.cursor === "string" ? request.cursor : request?.cursors?.zendesk;
    const limit = pageLimit(request?.limit);
    let query = boundedString(request?.query, 300);
    if (request?.assignedToMe === true) {
      // Repeated assignee terms can broaden a Zendesk query instead of intersecting it.
      if (/\bassignee\s*:/i.test(query)) throw new Error("Use assignedToMe without an assignee term in query.");
      const identity = await this.getCurrentUser();
      query = `assignee:${identity.id} ${query}`.trim();
    }
    if (isExportCursor(cursor) || request?.exhaustive === true) return this.#exportSearch(query, limit, cursor);
    const page = parseCursor(cursor);
    if (page * limit > SEARCH_CEILING) throw new Error("Zendesk search is limited to 1,000 results. Narrow the query by date or other filters, or retry with exhaustive.");
    const out = await this.#api().searchTickets(query, page, limit);
    const atCeiling = (page + 1) * limit > SEARCH_CEILING;
    const hasMore = Boolean(out.next_page) && !atCeiling;
    const truncated = atCeiling && (out.count === undefined ? Boolean(out.next_page) : out.count > page * limit);
    return {
      items: out.results.map(ticket => normalizeSummary(this.ctx.props.subdomain, ticket)),
      cursors: hasMore ? { zendesk: String(page + 1) } : {},
      hasMore: { zendesk: hasMore },
      truncated: { zendesk: truncated },
      completeness: { zendesk: !hasMore && !truncated },
    };
  }
  /**
   * Pages the Export Search Results endpoint, which has no 1,000-result ceiling. The path is chosen once per
   * pagination run and never mixed with offset paging: the two endpoints order results differently, so switching
   * mid-run would drop and duplicate tickets.
   */
  async #exportSearch(query: string, limit: number, cursor: string | undefined): Promise<WorkItemSearchPage> {
    if (cursor != null && cursor !== "" && !isExportCursor(cursor)) {
      throw new Error("Restart the Zendesk search to page beyond the 1,000-result ceiling; offset and export cursors cannot be mixed.");
    }
    const fingerprint = await exportFingerprint(this.ctx.props.subdomain, query, limit);
    const after = isExportCursor(cursor) ? parseExportCursor(cursor, fingerprint) : undefined;
    const out = await this.#api().searchTicketsExport(query, limit, after);
    if (!Array.isArray(out.results) || typeof out.meta?.has_more !== "boolean") throw new Error("Zendesk returned a malformed export search page.");
    const next = out.meta.after_cursor;
    // Reporting completeness here would silently drop every remaining ticket, so fail the page instead.
    const hasMore = out.meta.has_more;
    if (hasMore && (typeof next !== "string" || !next || next.length > EXPORT_CURSOR_MAX - 22 || next === after)) throw new Error("Zendesk export search is missing its next cursor or returned an invalid continuation.");
    return {
      items: out.results.map(ticket => normalizeSummary(this.ctx.props.subdomain, ticket)),
      cursors: hasMore ? { zendesk: mintExportCursor(fingerprint, next!) } : {},
      hasMore: { zendesk: hasMore },
      truncated: { zendesk: false },
      completeness: { zendesk: !hasMore },
    };
  }
  async readTicket(ticketId: string): Promise<WorkItemRead> {
    const id = normalizeTicketId(ticketId);
    const api = this.#api();
    const [ticket, commentPage, auditPage] = await Promise.all([api.showTicket(id), api.comments(id), api.audits(id)]);
    if (!ticket) throw new Error(`Zendesk ticket not found: ${id}`);
    const users = new Map<number, ZendeskApiUser>(([...(commentPage.users ?? []), ...(auditPage.users ?? [])]).map(user => [user.id, user]));
    const pending = this.#pendingActionsFor(String(ticket.id));
    let item = normalizeSummary(this.ctx.props.subdomain, ticket, users);
    for (const action of pending) if (action.kind === "fields") item = overlayFields(item, action.fields);
    return {
      detail: { item },
      comments: [...normalizeComments(commentPage.comments, users), ...pending.flatMap(action => action.kind === "comment" ? [action.synthetic] : [])],
      activity: normalizeActivity(auditPage.audits, users),
      updateOptions: { source: "zendesk", id: String(ticket.id), key: `ZD-${ticket.id}`, allowedFields: ["status", "priority", "type", "assignee_id", "group_id", "tags", "custom_<id>"] },
      transitions: [],
      attachments: normalizeAttachments(commentPage.comments),
    };
  }
  async readAttachment(ticketId: string, attachmentId: string): Promise<WorkItemAttachmentContent> {
    const id = normalizeTicketId(ticketId);
    const wanted = boundedString(attachmentId, 80);
    const commentPage = await this.#api().comments(id);
    const raw = commentPage.comments.flatMap(comment => comment.attachments ?? []).find(attachment => String(attachment.id) === wanted);
    if (!raw?.content_url) throw new Error("Attachment not found on this ticket.");
    const downloaded = await this.#api().downloadAttachment(raw.content_url);
    return { data: downloaded.data, name: boundedString(raw.file_name, 240, `attachment-${wanted}`), contentType: downloaded.contentType ?? (boundedString(raw.content_type, 160) || undefined) };
  }
  async stageUpload(ticketId: string, input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult> {
    const id = normalizeTicketId(ticketId);
    const normalized = normalizeUploadInput(input);
    const upload = await this.#api().upload(normalized);
    const expiresAtMs = Date.now() + UPLOAD_TTL_MS;
    const stored: StoredUpload = { token: upload.token, ticketId: id, attachment: normalizeAttachment(upload.attachment), expiresAtMs, expiresAt: upload.expires_at ?? new Date(expiresAtMs).toISOString() };
    this.ctx.storage.kv.put(uploadKey(upload.token), stored);
    await this.ctx.storage.setAlarm(expiresAtMs + 60_000);
    return { attachment: stored.attachment, uploadToken: stored.token, uploadMode: "staged-comment", target: "comment", supportsInline: false, expiresAt: stored.expiresAt };
  }
  async alarm(): Promise<void> { cleanupExpiredUploads(this.ctx.storage.kv); }
  async directComment(ticketId: string, input: WorkItemCommentInput): Promise<WorkItemDetail> {
    const action = await this.#commentAction(ticketId, input);
    return this.#applyComment({ ...action, id: 0, status: "applying" });
  }
  async directUpdateFields(ticketId: string, patch: WorkItemFieldPatch): Promise<WorkItemDetail> {
    const action = await this.#fieldAction(ticketId, patch);
    return this.#applyFields({ ...action, id: 0, status: "applying" });
  }
  async queueComment(queue: RpcStub<ApprovalQueue>, ticketId: string, input: WorkItemCommentInput): Promise<ZendeskQueuedAction<WorkItemDetail>> {
    const action = await this.#commentAction(ticketId, input);
    return this.#queue(queue, action, `Add ${action.public ? "public" : "internal"} Zendesk comment`, `Add a ${action.public ? "public" : "internal"} comment to Zendesk ticket ${action.ticketId}.`, ACTION_KINDS[0]);
  }
  async queueFields(queue: RpcStub<ApprovalQueue>, ticketId: string, patch: WorkItemFieldPatch): Promise<ZendeskQueuedAction<WorkItemDetail>> {
    const action = await this.#fieldAction(ticketId, patch);
    return this.#queue(queue, action, `Update Zendesk ticket ${action.ticketId}`, `Update allowlisted fields on Zendesk ticket ${action.ticketId}: ${Object.keys(action.fields).join(", ")}.`, ACTION_KINDS[1]);
  }
  getActionResult(actionId: number): ZendeskActionResult { if (!Number.isInteger(actionId) || actionId <= 0) throw new Error("Invalid Zendesk action result id."); return this.ctx.storage.kv.get<ZendeskActionResult>(resultKey(actionId)) ?? { status: "pending" }; }

  #nextActionId(): number { const id = this.ctx.storage.kv.get<number>("nextActionId") ?? 1; this.ctx.storage.kv.put("nextActionId", id + 1); return id; }
  #pendingActionsFor(ticketId: string): StoredAction[] { return [...this.ctx.storage.kv.list<StoredAction>({ prefix: "action:" })].map(([, value]) => value).filter(action => action.status === "pending" && action.ticketId === ticketId).toSorted((a, b) => a.id - b.id); }
  #claimAction(id: number): StoredAction | null {
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid Zendesk action id.");
    const result = this.ctx.storage.kv.get<ZendeskActionResult>(resultKey(id));
    // Consult results too: older versions deleted the action when recording failure.
    if (result?.status === "failed") throw new Error(`${result.message} Read the ticket and verify the outcome before submitting a new action.`);
    if (result?.status === "rejected") throw new Error("Zendesk action was rejected. Submit a new action if the change is still intended.");
    const action = this.ctx.storage.kv.get<StoredAction>(actionKey(id));
    if (action?.status === "applied" || result?.status === "ready") return null;
    if (!action) throw new Error("Zendesk action is unavailable. Verify the ticket before submitting a new action.");
    if (action.status === "applying" || action.status === "failed") throw new Error("Zendesk action is in progress or its outcome is ambiguous. Read the ticket and its history before submitting a new action; do not blindly repeat the write.");
    const claimed = { ...action, status: "applying" as const, claimedAt: Date.now() };
    this.ctx.storage.kv.put(actionKey(id), claimed);
    return claimed;
  }
  async #queue(queue: RpcStub<ApprovalQueue>, action: PendingAction, title: string, description: string, actionKind: ActionKind): Promise<ZendeskQueuedAction<WorkItemDetail>> {
    const id = this.#nextActionId();
    this.ctx.storage.kv.put<StoredAction>(actionKey(id), { ...action, id, status: "pending" });
    this.ctx.storage.kv.put<ZendeskActionResult>(resultKey(id), { status: "pending" });
    try { await queue.submitAction(id, { title, description, implementsRevert: false, actionKind }); }
    catch (error) {
      if (action.kind === "comment") for (const uploadToken of action.uploadTokens) this.ctx.storage.kv.delete(uploadKey(uploadToken));
      this.ctx.storage.kv.delete(actionKey(id));
      this.ctx.storage.kv.delete(resultKey(id));
      throw error;
    }
    return { actionId: id, status: "pending", pollAfterMs: 1000 };
  }
  async #commentAction(ticketId: string, input: WorkItemCommentInput): Promise<PendingAction & { kind: "comment" }> {
    const id = normalizeTicketId(ticketId);
    if (typeof input.body !== "string" || input.body.length > BODY_MAX) throw new Error("Zendesk comment body must be at most 12,000 characters.");
    const body = boundedBody(input.body);
    if (!body) throw new Error("Comment body is required.");
    const ticket = await this.#api().showTicket(id);
    if (!ticket?.updated_at) throw new Error("Zendesk ticket update stamp is unavailable.");
    const uploadTokens = validateUploadTokens(this.ctx.storage.kv, id, input.attachmentTokens ?? []);
    return { kind: "comment", ticketId: id, body, public: input.visibility === "public", uploadTokens, updateStamp: ticket.updated_at, synthetic: { id: `pending-${crypto.randomUUID()}`, body, public: input.visibility === "public", createdAt: new Date().toISOString(), format: "text", providerFormat: "plain" } };
  }
  async #fieldAction(ticketId: string, patch: WorkItemFieldPatch): Promise<PendingAction & { kind: "fields" }> {
    const id = normalizeTicketId(ticketId);
    const fields = normalizeFieldPatch(patch);
    const ticket = await this.#api().showTicket(id);
    if (!ticket?.updated_at) throw new Error("Zendesk ticket update stamp is unavailable.");
    return { kind: "fields", ticketId: id, fields, updateStamp: ticket.updated_at };
  }
  async #applyComment(action: StoredAction & { kind: "comment" }): Promise<WorkItemDetail> {
    validateUploadTokens(this.ctx.storage.kv, action.ticketId, action.uploadTokens);
    const { ticket } = await this.#api().updateTicket(action.ticketId, { comment: { body: action.body, public: action.public, uploads: action.uploadTokens } }, { updateStamp: action.updateStamp });
    for (const token of action.uploadTokens) this.ctx.storage.kv.delete(uploadKey(token));
    return { item: normalizeSummary(this.ctx.props.subdomain, ticket) };
  }
  async #applyFields(action: StoredAction & { kind: "fields" }): Promise<WorkItemDetail> {
    const { ticket } = await this.#api().updateTicket(action.ticketId, zendeskPatch(action.fields), { updateStamp: action.updateStamp });
    return { item: normalizeSummary(this.ctx.props.subdomain, ticket) };
  }
}

class ZendeskAccountSessionImpl extends RpcTarget implements ZendeskAccountSession {
  constructor(private readonly gatekeeper: ZendeskGatekeeper, private readonly queue: RpcStub<ApprovalQueue>) { super(); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
  async getCurrentUser(): Promise<ZendeskCurrentUser> { const result = await this.gatekeeper.getCurrentUser(); await this.queue.authorizeObservation(privateObservation("Read current Zendesk user", "Read the signed-in Zendesk user's identity.")); return result; }
  async searchTickets(request?: ZendeskTicketSearchRequest): Promise<WorkItemSearchPage> { const result = await this.gatekeeper.searchTickets(request); await this.queue.authorizeObservation(privateObservation("Search Zendesk tickets", "Searched tickets in the connected Zendesk subdomain.")); return result; }
  async readTicket(ticketId: string): Promise<WorkItemRead> { const result = await this.gatekeeper.readTicket(ticketId); await this.queue.authorizeObservation(privateObservation("Read Zendesk ticket", `Read Zendesk ticket ${normalizeTicketId(ticketId)}.`)); return result; }
  async ticket(ticketId: string): Promise<ZendeskTicketSession> { return new RpcStub(new ZendeskTicketSessionImpl(this.gatekeeper, normalizeTicketId(ticketId), this.queue.dup())) as unknown as ZendeskTicketSession; }
  async getActionResult(actionId: number): Promise<ZendeskCodingSessionToolResult> {
    return zendeskActionResultToToolResult(await this.gatekeeper.getActionResult(actionId), actionId);
  }
  getCodingSessionActionResult(actionId: number): Promise<ZendeskCodingSessionToolResult> { return this.getActionResult(actionId); }
  async listTools(): Promise<ZendeskCodingSessionToolInfo[]> { return codingTools(); }
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ZendeskCodingSessionToolResult> {
    if (name === "zendesk_get_current_user") return toolOk(await this.getCurrentUser());
    if (name === "zendesk_search_tickets") return toolOk(await this.searchTickets(toolSearchRequest(args)));
    if (name === "zendesk_read_ticket") return toolOk(await this.readTicket(normalizeTicketId(args.id ?? args.ticketId)));
    if (name === "zendesk_add_comment") return toolPending(await this.gatekeeper.queueComment(this.queue, normalizeTicketId(args.id ?? args.ticketId), toolCommentInput(args)), "Zendesk comment is awaiting Workshop approval.");
    if (name === "zendesk_update_fields") return toolPending(await this.gatekeeper.queueFields(this.queue, normalizeTicketId(args.id ?? args.ticketId), toolFieldPatch(args)), "Zendesk field update is awaiting Workshop approval.");
    throw new Error(`Unknown Zendesk coding-session tool: ${name}`);
  }
}

class ZendeskTicketSessionImpl extends RpcTarget implements ZendeskTicketSession {
  constructor(private readonly gatekeeper: ZendeskGatekeeper, private readonly ticketId: string, private readonly queue: RpcStub<ApprovalQueue>) { super(); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
  async read(): Promise<WorkItemRead> { const result = await this.gatekeeper.readTicket(this.ticketId); await this.queue.authorizeObservation(ticketObservation("Read Zendesk ticket", `Read Zendesk ticket ${this.ticketId}.`)); return result; }
  async readAttachment(id: string): Promise<WorkItemAttachmentContent> { const result = await this.gatekeeper.readAttachment(this.ticketId, id); await this.queue.authorizeObservation(ticketObservation("Read Zendesk ticket attachment", `Read attachment ${boundedString(id, 80)} from Zendesk ticket ${this.ticketId}.`)); return result; }
  mediaCapabilities(): Promise<WorkItemMediaCapabilities> { return mediaCapabilities(); }
  addComment(input: WorkItemCommentInput): Promise<ZendeskQueuedAction<WorkItemDetail>> { return this.gatekeeper.queueComment(this.queue, this.ticketId, input); }
  updateFields(patch: WorkItemFieldPatch): Promise<ZendeskQueuedAction<WorkItemDetail>> { return this.gatekeeper.queueFields(this.queue, this.ticketId, patch); }
}

function mediaCapabilities(): Promise<WorkItemMediaCapabilities> {
  return Promise.resolve({ uploads: true, uploadMode: "staged-comment", targets: ["comment"], inlineImages: false, inlineVideos: false, maxBytes: MAX_ATTACHMENT_BYTES, acceptedContentTypes: ["image/png", "image/jpeg", "image/gif", "application/pdf", "text/plain", "text/csv"] });
}

function normalizeUploadInput(input: WorkItemAttachmentUploadInput): { name: string; contentType: string; data: Uint8Array } {
  const name = boundedString(input.name, 240);
  const contentType = boundedString(input.contentType, 160);
  if (!name || !contentType || input.target !== "comment") throw new Error("Zendesk staged uploads require a file name, MIME type, and comment target.");
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0 || input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Zendesk upload bytes are empty or exceed the configured limit.");
  return { name, contentType, data: input.data };
}

function validateUploadTokens(kv: DurableObjectStorage["kv"], ticketId: string, tokens: string[]): string[] {
  if (tokens.length > MAX_UPLOAD_TOKENS || tokens.some(token => typeof token !== "string" || !token || token.length > 1600)) throw new Error("Zendesk attachment tokens exceed the supported limits.");
  for (const token of tokens) {
    const upload = kv.get<StoredUpload>(uploadKey(token));
    if (upload && Date.now() >= upload.expiresAtMs) kv.delete(uploadKey(token));
    if (!upload || upload.ticketId !== ticketId || upload.consumed || Date.now() >= upload.expiresAtMs) throw new Error("Zendesk upload token is invalid, expired, consumed, or belongs to another ticket.");
  }
  return tokens;
}

function cleanupExpiredUploads(kv: DurableObjectStorage["kv"]): void {
  const now = Date.now();
  for (const [key, upload] of kv.list<StoredUpload>({ prefix: "upload:" })) {
    if (upload.consumed || now >= upload.expiresAtMs) kv.delete(key);
  }
}

function normalizeAttachment(attachment: ZendeskAttachment): WorkItemAttachment {
  return { id: String(attachment.id), name: boundedString(attachment.file_name, 240, `attachment-${attachment.id}`), contentType: boundedString(attachment.content_type, 160) || undefined, size: attachment.size ?? undefined, createdAt: attachment.created_at ?? undefined };
}
function normalizeAttachments(comments: ZendeskComment[]): WorkItemAttachment[] { return comments.flatMap(comment => (comment.attachments ?? []).map(attachment => ({ ...normalizeAttachment(attachment), commentId: String(comment.id) }))); }
function normalizeSummary(subdomain: string, ticket: ZendeskTicket, users = new Map<number, ZendeskApiUser>()): WorkItemSummary { return { source: "zendesk", id: String(ticket.id), key: `ZD-${ticket.id}`, url: ticketUrl(subdomain, ticket.id), title: boundedString(ticket.subject ?? ticket.raw_subject, 300, `Zendesk ticket ${ticket.id}`), status: boundedString(ticket.status, 80) || undefined, type: boundedString(ticket.type, 80) || undefined, priority: boundedString(ticket.priority, 80) || undefined, assignee: displayUser(ticket.assignee_id, users), requester: displayUser(ticket.requester_id, users), updatedAt: ticket.updated_at ?? undefined, description: { body: String(ticket.description ?? "").slice(0, DESCRIPTION_MAX), format: "text", providerFormat: "zendesk-text", truncated: (ticket.description?.length ?? 0) > DESCRIPTION_MAX }, fields: normalizeTicketFields(ticket) }; }
function displayUser(id: number | null | undefined, users: Map<number, ZendeskApiUser>): string | undefined { if (!id) return undefined; const user = users.get(id); return boundedString(user?.name ?? user?.email ?? id, 160); }
function normalizeTicketFields(ticket: ZendeskTicket): Record<string, string | number | boolean | null> { const out: Record<string, string | number | boolean | null> = {}; for (const field of ticket.custom_fields ?? ticket.fields ?? []) if (field.value === null || ["string", "number", "boolean"].includes(typeof field.value)) out[`custom_${field.id}`] = field.value as string | number | boolean | null; return out; }
function normalizeComments(comments: ZendeskComment[], users: Map<number, ZendeskApiUser>): WorkItemComment[] {
  return comments.map(comment => {
    const body = String(comment.plain_body ?? comment.body ?? "").replaceAll(String.fromCharCode(0), "").trim();
    return { id: String(comment.id), author: displayUser(comment.author_id, users), body: body.slice(0, BODY_MAX), format: "text", providerFormat: "zendesk-text", public: comment.public !== false, createdAt: comment.created_at ?? undefined, truncated: body.length > BODY_MAX };
  });
}
function normalizeActivity(audits: ZendeskAudit[], users: Map<number, ZendeskApiUser>): WorkItemRead["activity"] { return audits.map(audit => ({ id: String(audit.id), type: "audit", author: displayUser(audit.author_id, users), createdAt: audit.created_at ?? undefined, summary: boundedString((audit.events ?? []).map(event => event.type === "Change" ? `${event.field_name ?? "field"} changed` : event.type ?? "event").join(", "), 300, "Ticket audit") })); }
function overlayFields(item: WorkItemSummary, fields: Record<string, string | number | boolean | null | string[]>): WorkItemSummary { return { ...item, status: typeof fields.status === "string" ? fields.status : item.status, priority: typeof fields.priority === "string" ? fields.priority : item.priority, type: typeof fields.type === "string" ? fields.type : item.type, fields: { ...item.fields, ...Object.fromEntries(Object.entries(fields).filter(([key, value]) => key.startsWith("custom_") && (value === null || ["string", "number", "boolean"].includes(typeof value)))) as Record<string, string | number | boolean | null> } }; }
export function zendeskPatch(fields: Record<string, string | number | boolean | null | string[]>): Record<string, unknown> { const ticket: Record<string, unknown> = {}; const customFields: Array<{ id: number; value: unknown }> = []; for (const [key, value] of Object.entries(fields)) { if (["status", "priority", "type", "assignee_id", "group_id", "tags"].includes(key)) ticket[key] = value; else if (/^custom_\d+$/.test(key)) customFields.push({ id: Number(key.slice(7)), value }); else throw new Error(`Unsupported Zendesk field: ${key}`); } if (customFields.length > 0) ticket.custom_fields = customFields; return ticket; }
function normalizeFieldPatch(patch: WorkItemFieldPatch): Record<string, string | number | boolean | null | string[]> {
  const entries = Object.entries(patch.fields ?? {});
  if (entries.length === 0 || entries.length > 10) throw new Error("Zendesk field updates require 1 to 10 supported fields.");
  for (const [key, value] of entries) {
    const valid = value === null || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= FIELD_MAX) ||
      (Array.isArray(value) && value.length <= 50 && value.every(v => typeof v === "string" && v.length <= 120));
    if (key.length > 80 || !valid) throw new Error("Zendesk field update exceeds the supported value limits.");
  }
  const fields = Object.fromEntries(entries);
  zendeskPatch(fields);
  return fields;
}
function toolSearchRequest(args: Record<string, unknown>): WorkItemSearchRequest & { exhaustive?: boolean } { return { source: "zendesk", query: boundedString(args.query, 300), assignedToMe: args.assignedToMe === true, limit: pageLimit(args.limit), exhaustive: args.exhaustive === true, cursors: { zendesk: args.cursor == null ? undefined : boundedString(args.cursor, EXPORT_CURSOR_MAX) } }; }
function toolCommentInput(args: Record<string, unknown>): WorkItemCommentInput { return { body: typeof args.body === "string" ? args.body : "", visibility: args.visibility === "public" ? "public" : "internal", attachmentTokens: Array.isArray(args.attachmentTokens) ? args.attachmentTokens.map(String) : undefined }; }
function toolFieldPatch(args: Record<string, unknown>): WorkItemFieldPatch { const fields = typeof args.fields === "object" && args.fields !== null ? args.fields as Record<string, string | number | boolean | null | string[]> : {}; return { fields }; }
