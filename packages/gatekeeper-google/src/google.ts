import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor, ActionKind, stripTrailingSlashes } from '@gadgets/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleVerifiedEmail, GmailApi, GmailMessageRaw, GmailOutboundMessage, GoogleAccessToken, normalizeEmailRecipients, revokeGoogleToken } from "./google-api";
import {
  GmailSession, GmailThread, GmailMessage,
  GmailThreadInfo, GmailThreadEntry, GmailMessageInfo, GmailLabel, GmailSystemLabel, EmailContent
} from "./types";
import { GoogleDocSession, DocMetadata } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import type {
  GoogleSpreadsheetSession, SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode,
} from "./sheets-types";
import { docToMarkdown, markdownToDocRequests, computeReplaceOperations, DocSnapshot } from "./markdown-converter";
import { BigQueryApi, DEFAULT_MAX_BYTES_BILLED } from "./bigquery-api";
import {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQuerySession, BigQueryTable,
} from "./bigquery-types";
import {
  calendarEventOverlaps, calendarEventSortKey, eventPatchToGoogle, GoogleCalendarApi,
  validateCalendarTimeWindow,
} from "./calendar-api";
import type {
  CalendarAvailabilityMode, CalendarEvent, CalendarEventDraft, CalendarEventPatch,
  CalendarListEventsOptions, CalendarSendUpdates, CalendarTime, GoogleCalendarCapabilities,
  GoogleCalendarInfo, GoogleCalendarSession, PersonAvailability,
} from "./calendar-types";
import TYPES_CODE from "./types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";
import {
  BigQueryConfiguratorUI,
  CalendarConfiguratorUI,
  GmailConfiguratorUI,
  GoogleDocConfiguratorUI,
  GoogleSheetsConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import GOOGLE_DOC_CONFIGURATOR_HTML from "./generated/google-doc-configurator-ui.txt";
import GOOGLE_SHEETS_CONFIGURATOR_HTML from "./generated/google-sheets-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest, ACCESS_TOKEN_EXPIRY_SAFETY_MS } from "./auth-retry";
import {
  MAX_GMAIL_VISIBLE_THREAD_MESSAGES, validateGmailAddress, validateGmailBody,
  validateGmailQueryForGrouping, validateGmailRecipientCount, validateOutboundInput,
} from "./gmail-validate";
import {
  AUTH_SCOPES, BIGQUERY_HOST, BIGQUERY_RESOURCE, GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE,
  GOOGLE_DOC_RESOURCE, GOOGLE_SHEETS_RESOURCE, LEGACY_GRANTED_RESOURCE_URL_PATTERNS,
  RESOURCE_BY_KIND, SUPPORTED_RESOURCES, grantedResourcesFromScopes, parseResourceUrl,
  resourceUrlPatternsToOAuthScopes,
} from "./resources";
import { ObserverCheck, ObserverTracker } from "./observers";
import { CursorPager, Pager } from "./cursor";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "google";
const logger = obsContext.createLogger({
  component: "gatekeeper.google", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one nonce is active at a time;
// the `stage` field tracks where we are in the flow.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;    // 10 minutes

// Ceilings on the OAuth round trips that run while holding the credential mutex. Each must be
// bounded: an unbounded hang keeps the mutex, and every caller waiting for a token then queues
// behind it.
const TOKEN_MINT_TIMEOUT_MS = 20 * 1000;
const AUTH_CODE_EXCHANGE_TIMEOUT_MS = 30 * 1000;
const TOKEN_REVOKE_TIMEOUT_MS = 10 * 1000;

// How long a permanent mint failure suppresses further attempts. Long enough to absorb the burst a
// revoke produces (every outstanding token 401s at once, so callers arrive within milliseconds),
// short enough that the account recovers on its own once the cause is fixed — an admin lifting a
// scope restriction leaves nothing for us to observe, so we have to re-ask Google eventually.
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Base URL (protocol+host+optional path) at which the default fetch handler is served. Should
  // NOT include a trailing slash. Omit for localhost dev server.
  BASE_URL?: string;
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

// Well-known Gmail system label IDs — derived from GmailSystemLabel so the
// type and runtime set can't drift apart.
const SYSTEM_LABEL_IDS: GmailSystemLabel[] = [
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED",
  "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PRIMARY", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];
const SYSTEM_LABELS: Set<string> = new Set(SYSTEM_LABEL_IDS);

// Resolve raw Gmail label IDs into GmailLabel objects with human-readable names.
// System labels use their well-known name; custom labels are resolved via the
// labelMap (fetched from Gmail's labels.list API).
function toLabelObjects(labelIds: string[], labelMap: Map<string, string>): GmailLabel[] {
  return labelIds.map(id => {
    if (SYSTEM_LABELS.has(id)) {
      return { id, name: id as GmailSystemLabel, type: "system" as const };
    }
    let name = labelMap.get(id) || id;
    return { id, name, type: "custom" as const };
  });
}

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/google");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// =======================================================================================

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.
  </body>
</html>`;

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
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Google Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please see the README.md for instructions on configuring an OAuth client ID and secret so that this Cloudflare OS instance can access Google APIs.</p>
    </div>
  </body>
</html>`;

const GOOGLE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GOOGLE_LOGO_SVG)}`;

/** Main HTTP UI entrypoint. We only use this to initiate and complete OAuth requests to Google. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      // Add newly-requested scopes to any the user already granted, rather than replacing them.
      newUrl.searchParams.set("include_granted_scopes", "true");
      newUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      let userObjectId = ctx.exports.UserAccount.idFromString(doId);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}

// =======================================================================================

// Top-level API exposed to the Workshop.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google",
      url: "https://google.com",
      logo: { url: GOOGLE_LOGO_URL },
      color: "#e8f0fe",
      tagline: "Draft replies, edit docs, read sheets, manage calendars, and analyze data",
      description:
          "Connect your Google account to give Cloudflare OS access to Gmail, Google Docs, Google " +
          "Sheets, Google Calendar, and BigQuery. Build agents that triage email, draft and edit " +
          "documents, read spreadsheets, find focus time, schedule meetings, or run analytics " +
          "queries on your data.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let requestedScopes = authOnly
        ? AUTH_SCOPES
        : resourceUrlPatternsToOAuthScopes(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedScopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return [
      TYPES_CODE, DOCS_TYPES_CODE, SHEETS_TYPES_CODE, CALENDAR_TYPES_CODE, BIGQUERY_TYPES_CODE,
    ].join("\n");
  }
}

export class UserAccount extends DurableObject<Env> {
  // Serialize minting, reconnect, and revoke against each other. Minting is a network round trip, so
  // without this a single invalidated token has every concurrent caller mint its own — a burst
  // against Google's token endpoint that may get rate-limited, turning a recoverable 401 into a hard
  // failure. It also keeps a mint from interleaving with credentials being replaced or wiped.
  //
  // A promise chain rather than blockConcurrencyWhile: that would freeze the whole object for the
  // duration of the fetch, and an exception or a 30s overrun inside it resets the Durable Object.
  // Same pattern as the Slack and Supabase gatekeepers.
  #credentialUpdate: Promise<void> = Promise.resolve();

  // The last mint that failed permanently — revoked credentials, or a scope an admin has blocked.
  #mintFailure: { error: Error; at: number } | undefined;

  async #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedScopes: string[], ephemeral?: boolean) {
    // If we have no API key in 1 hour, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * Prepare this account for a reconnect flow. The next acceptAuthCode() call will replace the
   * existing refresh token and notify via credentialsRestored() instead of complete().
   *
   * `requestedScopes` is the full set of OAuth scopes to request on the reauthorization. For a
   * plain reconnect this is the previously-granted set; for a scope expansion it's the union of
   * the granted scopes and the newly-needed ones.
   */
  async prepareReconnect(initiationNonce: string, requestedScopes: string[]) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * The grantable resource `urlPattern`s currently granted on this account. Used to decide
   * whether ensureResources() needs to expand.
   *
   * Legacy accounts connected before granular scope tracking have no recorded granted scopes.
   * Report only the resources included in that historical grant, so newer resources correctly
   * trigger OAuth scope expansion.
   */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    let granted = this.ctx.storage.kv.get<string[]>("grantedScopes");
    if (granted === undefined) {
      return [...LEGACY_GRANTED_RESOURCE_URL_PATTERNS];
    }
    return grantedResourcesFromScopes(granted);
  }

  /**
   * Called by the fetch handler when the user visits the initiation URL. Verifies the initiation
   * nonce, consumes it, and returns a fresh OAuth nonce plus the scopes to request. Returns null if
   * the nonce is invalid or expired.
   */
  async beginOAuthFlow(initiationNonce: string): Promise<{oauthNonce: string, scopes: string[]} | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    // Replace the consumed initiation nonce with a fresh OAuth nonce.
    let oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    // Fall back to all scopes for legacy flows that didn't record a requested set.
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes")
        ?? resourceUrlPatternsToOAuthScopes();
    return {oauthNonce, scopes};
  }

  /** Returns false if the OAuth nonce is invalid or expired. */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    // Verify and consume the OAuth nonce.
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    // The credential swap is serialized against minting and revoke, but the callbacks below are
    // not: they are outbound RPCs that can re-enter this object, and awaiting one while holding the
    // mutex would deadlock. So the locked section returns what the notifications need and the
    // notifications happen after it releases.
    let completion = await this.#updateCredentials(async () => {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        // Must have timed out.
        throw new Error("Took too long to complete the authorization. Please try again.");
      }

      let response = await exchangeAuthCode(
          code, clientId, clientSecret, getBaseUrl(this.env) + "/oauth",
          AbortSignal.timeout(AUTH_CODE_EXCHANGE_TIMEOUT_MS));

      if (!response.refreshToken) {
        throw new Error("OAuth exchange didn't return refresh token?");
      }

      this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      // Record what Google actually granted (the user may have declined some requested scopes).
      this.ctx.storage.kv.put<string[]>("grantedScopes", response.grantedScopes);
      this.ctx.storage.kv.delete("requestedScopes");

      let reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
      if (reconnecting) this.ctx.storage.kv.delete("reconnecting");
      return { callback, reconnecting: !!reconnecting };
    });

    let callback = completion.callback;
    if (completion.reconnecting) {
      // Reconnect flow: credentials replaced above, notify restoration.
      await callback.credentialsRestored();
    } else {
      // Initial connect flow: create the user entrypoint and notify completion.
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller has read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call the provider's revoke endpoint (that could
      // invalidate the user's other grants for this OAuth client); we just drop our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }

    return true;
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  /**
   * Whether the stored token still satisfies this request, i.e. can be served without minting.
   *
   * A `staleToken` request comes from a caller that just had a 401. It must not be answered from the
   * expiry check — the whole point is that Google rejected a token that had not yet expired. It is
   * satisfied only if the stored token is no longer the one that failed, which means another caller
   * already replaced it and this caller should take theirs.
   */
  #tokenSatisfies(cached: GoogleAccessToken | undefined, opts?: AccessTokenRequest)
      : cached is GoogleAccessToken {
    if (!cached) return false;
    // Expiry gates every path — no request, however it is phrased, is answered with a token that is
    // already inside the safety window.
    if (cached.expires.valueOf() <= Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) return false;
    if (opts?.staleToken !== undefined) return cached.token !== opts.staleToken;
    return !opts?.forceRefresh;
  }

  async getAccessToken(opts?: AccessTokenRequest): Promise<GoogleAccessToken> {
    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      throw new Error("no refresh token set");
    }

    // Fast path, deliberately outside the lock: the overwhelmingly common case is a valid cached
    // token, and that must not serialize behind anything.
    let cached = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
    if (this.#tokenSatisfies(cached, opts)) {
      return cached;
    }

    // Serialized so a burst of concurrent 401s collapses into one token exchange. The re-check
    // inside the lock is what does the collapsing — the lock alone would just queue the mints.
    return this.#updateCredentials(async () => {
      let fresh = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
      if (this.#tokenSatisfies(fresh, opts)) {
        return fresh;
      }

      // A mint already established that these credentials are permanently dead. Fail the same way
      // without asking Google again — see #mintFailure.
      if (this.#mintFailure && Date.now() - this.#mintFailure.at < MINT_FAILURE_COOLDOWN_MS) {
        throw this.#mintFailure.error;
      }

      // Re-read rather than closing over the outer value: the credentials may have been replaced
      // while this call waited for the lock.
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (!refreshToken) {
        throw new Error("no refresh token set");
      }

      // Logged before the exchange so a mint that fails or hangs still leaves a trace. The events
      // are distinct because their rates mean different things: `expiry` should tick about once per
      // token lifetime, whereas `rejected` means a token was invalidated early and the 401 retry
      // healed it — and a burst of 401s should still produce exactly one.
      logger.info("minting Google access token", {
        event: opts?.staleToken !== undefined
            ? "google.token.mint.rejected"
            : "google.token.mint.expiry",
      });

      // TODO: If new refresh token returned, use it.
      let result = await getAccessToken(refreshToken, clientId, clientSecret,
          AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS));
      if (!result.ok) {
        // Both are permanent, so both mark the connection dead. They differ in the remedy:
        // re-authenticating fixes a revoked grant but cannot grant a scope an admin has blocked.
        let error = new Error(
            result.reason === "policyBlocked"
                ? "A Google Workspace admin has restricted access this connection needs " +
                  `(${result.detail}). Ask your administrator to allow it — re-authenticating ` +
                  "will not help."
                : "Google credentials have expired or been revoked. Please re-authenticate.");
        // Recorded before notifying so only the first caller of a burst does either.
        this.#mintFailure = { error, at: Date.now() };
        this.#notifyCredentialsDead();
        throw error;
      }

      // Backstop for the credential mutators: the mutex already keeps them from interleaving with a
      // mint, so this should be unreachable. It stays because publishing a token minted against a
      // refresh token that is no longer current would resurrect a revoked account.
      if (this.ctx.storage.kv.get<string>("refreshToken") !== refreshToken) {
        logger.warn("discarded a Google access token minted against superseded credentials", {
          event: "google.token.mint.superseded",
        });
        let current = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
        if (current) return current;
        throw new Error("Google credentials changed while refreshing. Please try again.");
      }

      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", result.token);
      return result.token;
    });
  }

  // Tell the workshop the credentials are permanently dead so the UI prompts a reconnect instead of
  // every call failing opaquely. Fire and forget — a notification failure must not mask the error.
  #notifyCredentialsDead(): void {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    callback?.credentialsExpired().catch(notifyErr => {
      logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed", error: notifyErr,
      });
    });
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login). Serialized so the wipe cannot land in the
    // middle of a mint, leaving a freshly minted token behind on a deleted account.
    await this.#updateCredentials(async () => {
      if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.deleteAll();
      }
    });
  }

  async revoke(): Promise<void> {
    await this.#updateCredentials(async () => {
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (refreshToken) {
        await revokeGoogleToken(refreshToken, AbortSignal.timeout(TOKEN_REVOKE_TIMEOUT_MS));
      }
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let tokenPromise = obj.getAccessToken();
    let grantedResourcesPromise = obj.getGrantedResourceUrlPatterns();
    let token = await tokenPromise;
    let description = await getGoogleAccountDescription(token.token);

    description.grantedResourceUrlPatterns = await grantedResourcesPromise;
    return description;
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Contract is Promise<string | null>: never throw. The access token fetch can throw if the
    // (possibly transient sign-in) grant has been cleaned up, and the userinfo call can throw on a
    // non-2xx response — treat any failure as "no email available".
    try {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      let token = await obj.getAccessToken();
      if (!token) return null;
      return await getGoogleVerifiedEmail(token.token);
    } catch {
      return null;
    }
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let target = parseResourceUrl(url);
    let resource = RESOURCE_BY_KIND[target.kind];
    let userObjectId = this.ctx.props.userObjectId;

    switch (target.kind) {
      case "gmail": {
        let props: GmailGatekeeperImplProps = {
          userObjectId, searchQuery: target.searchQuery, labelName: target.labelName,
        };
        return {class: this.ctx.exports.GmailGatekeeperImpl({props}), resource};
      }
      case "doc": {
        let props: GoogleDocGatekeeperImplProps = {userObjectId, documentId: target.documentId};
        return {class: this.ctx.exports.GoogleDocGatekeeperImpl({props}), resource};
      }
      case "sheets": {
        let props: GoogleSheetsGatekeeperImplProps = {
          userObjectId, spreadsheetId: target.spreadsheetId,
        };
        return {class: this.ctx.exports.GoogleSheetsGatekeeperImpl({props}), resource};
      }
      case "calendar": {
        let props: GoogleCalendarGatekeeperImplProps = {
          userObjectId, calendarId: target.calendarId, availabilityMode: target.availabilityMode,
        };
        return {class: this.ctx.exports.GoogleCalendarGatekeeperImpl({props}), resource};
      }
      case "bigquery": {
        let props: BigQueryGatekeeperImplProps = {
          userObjectId,
          scopedProjectId: target.projectId,
          scopedDatasetId: target.datasetId,
          scopedTableId: target.tableId,
        };
        return {class: this.ctx.exports.BigQueryGatekeeperImpl({props}), resource};
      }
    }
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let getToken = async (opts?: AccessTokenRequest) => {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      return await obj.getAccessToken(opts);
    };

    if (resourceUrlPattern === BIGQUERY_RESOURCE.urlPattern) {
      return {
        iframeHtml: BIGQUERY_CONFIGURATOR_HTML,
        ui: new RpcStub(new BigQueryConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GMAIL_RESOURCE.urlPattern) {
      return {
        iframeHtml: GMAIL_CONFIGURATOR_HTML,
        ui: new RpcStub(new GmailConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_CALENDAR_RESOURCE.urlPattern) {
      return {
        iframeHtml: CALENDAR_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalendarConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_DOC_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_DOC_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleDocConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_SHEETS_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_SHEETS_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleSheetsConfiguratorUI(getToken)),
      };
    }

    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    await obj.revoke();
  }

  async reconnect(): Promise<{url: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let initiationNonce = generateNonce();
    // Re-request the scopes already granted so a plain reconnect doesn't narrow access.
    let requestedScopes = resourceUrlPatternsToOAuthScopes(await obj.getGrantedResourceUrlPatterns());
    await obj.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let granted = new Set(await obj.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) {
      return {};
    }

    // Request the union of what's already granted and what's newly needed, so the expansion never
    // drops existing access.
    let unionPatterns = new Set([...granted, ...resourceUrlPatterns]);
    let requestedScopes = resourceUrlPatternsToOAuthScopes([...unionPatterns]);
    let initiationNonce = generateNonce();
    await obj.prepareReconnect(initiationNonce, requestedScopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account, used by the Google gatekeepers' addObserver to confirm
   * a prospective observer may read a bound resource. The verifier carries this user's own account
   * id, so the access checks run against the observer's *own* Google token. (The Gmail gatekeeper
   * uses strategy A — it never consults the verifier — but getVerifier must still exist because the
   * overseer mints one on every open.)
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: GoogleVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GoogleVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Google spans several strategies (see each gatekeeper's observer methods):
//   - Gmail Mailbox — strategy A (private-only): addObserver always throws, so the verifier is never
//     consulted (but must exist).
//   - Google Doc — strategy B (ACL check, single unit): hasDocAccess answers whether the observer's
//     own token can open the bound document (Docs API returns 401/403/404 otherwise).
//   - Google Sheets — strategy B (ACL check, single unit): hasSpreadsheetAccess answers whether the
//     observer's own token can open the bound spreadsheet.
//   - Google Calendar — strategies B/C: hasCalendarWriterAccess covers the bound calendar, while
//     hasCalendarFreeBusyAccess covers foreign calendars read by an all-visible availability query.
//   - BigQuery — strategy C (data-set tracking by dataset): hasDatasetAccess answers whether the
//     observer's own token has IAM access to a dataset (BigQuery returns 401/403/404 otherwise).
// The overseer only ever hands this verifier back to a Google gatekeeper, which may therefore trust
// the boolean results.

type GoogleVerifierProps = {
  userObjectId: string;
};

// Extract the HTTP status from the ad-hoc Error messages thrown by the Google API helpers
// (which embed it as `: <status> ` or `[http=<status>]`). Returns undefined if not found.
function httpStatusFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  let m = error.message.match(/\[http=(\d{3})\]/) ?? error.message.match(/:\s(\d{3})(?:\s|$)/);
  return m ? Number(m[1]) : undefined;
}

// True if an error means "the observer's token cannot access this resource" (as opposed to a
// transient failure, which is rethrown so the open fails loudly rather than silently denying).
function isNoAccessStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * The non-standard methods the Google gatekeepers call on their own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface GoogleVerifierApi extends GatekeeperUserVerifier {
  hasDocAccess(documentId: string): Promise<boolean>;
  hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean>;
  hasCalendarWriterAccess(calendarId: string): Promise<boolean>;
  hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean>;
  hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean>;
}

@validateRpc()
export class GoogleVerifier extends WorkerEntrypoint<Env, GoogleVerifierProps>
    implements GoogleVerifierApi {
  async #getToken(opts?: AccessTokenRequest): Promise<string> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return (await account.getAccessToken(opts)).token;
  }

  async hasDocAccess(documentId: string): Promise<boolean> {
    let api = new GoogleDocsApi(opts => this.#getToken(opts));
    try {
      await api.getDocument(documentId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean> {
    let api = new GoogleSheetsApi(opts => this.#getToken(opts));
    try {
      await api.getSpreadsheet(spreadsheetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasCalendarWriterAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      let calendar = await api.getCalendar(calendarId);
      return calendar.accessRole === "writer" || calendar.accessRole === "owner";
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      return await api.hasFreeBusyAccess(calendarId);
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean> {
    let api = new BigQueryApi(opts => this.#getToken(opts));
    try {
      await api.getDataset(projectId, datasetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }
}

class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(this.#actionKey(id));
  }

  put(id: number, action: Action): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  list(): {id: number, action: Action}[] {
    return [...this.#kv.list<Action>({prefix: "pending:action:"})]
        .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
        .filter(({id}) => Number.isFinite(id))
        .toSorted((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
  }
}

// =======================================================================================
// Gmail capability stubs
//
// Capability-based API: GmailSession returns GmailThread[] stubs, which return
// GmailMessage[] stubs, etc. Each stub is an RpcTarget that can be passed across
// Worker boundaries. Actions go through the approval queue; reads go through
// authorizeObservation for audit logging.
//
// Approval model:
//   submitAction (requires approval): all side-effecting actions — archive, trash,
//                                     markRead, markUnread, send (reply / replyAll /
//                                     forward all share the `send` action type)
//   authorizeObservation (audit-only): all reads
//
// All side-effecting actions go through the approval queue. Policy configuration
// determines which actions are auto-approved vs. requiring human review — it is
// not up to the gatekeeper to make that decision.
//
// Outbound-email semantics: send(), reply(), replyAll(), and forward() submit
// compact semantic actions (recipients/body/source message ID). Nothing is
// written to the user's mailbox before approval. applyAction() refetches any
// immutable source message, builds the raw RFC 5322/MIME payload, and delivers
// it via messages.send. There is therefore no pre-approval side effect, no
// large MIME blob in action storage, and no draft to clean up on rejection.

// ── Action types ────────────────────────────────────────────────────

type GmailAction =
  | { type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string }
  | { type: "send"; to: string[]; subject: string; body: string }
  | {
      type: "reply";
      sourceMessageId: string;
      threadId: string;
      body: string;
      replyAll: boolean;
      sourceWasSent: boolean;
    }
  | { type: "forward"; sourceMessageId: string; to: string[]; body?: string };

// ── Session context ─────────────────────────────────────────────────
// Shared context passed to all stubs created within a session.

type GmailSessionContext = {
  gmailApi: GmailApi;
  approvalQueue: RpcStub<ApprovalQueue>;
  pendingActions: PendingActionStore<GmailAction>;
  // SESSION PATH: the raw search query passed to the Gmail API for listThreads/search.
  // This handles historical + new messages. See GmailGatekeeperImplProps.searchQuery.
  searchQuery: string | undefined;
  labelId: string | undefined;
  labelName: string | undefined;
  resolveLabels: (labelIds: string[]) => Promise<GmailLabel[]>;
};

// ── GmailSessionImpl ────────────────────────────────────────────────

@validateRpc()
class GmailSessionImpl extends RpcTarget implements GmailSession {
  #ctx: GmailSessionContext;

  constructor(ctx: GmailSessionContext) {
    super();
    this.#ctx = ctx;
  }

  // TODO: The dup'd approvalQueue RPC stub should be disposed when the session ends.

  async listThreads(): Promise<Cursor<GmailThreadEntry>> {
    const scopeDescription = this.#ctx.searchQuery
      ? "the connected Gmail search scope"
      : this.#ctx.labelId
        ? "the connected Gmail label scope"
        : "the Gmail inbox";

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Gmail threads",
      description:
        `Create a cursor for the most recent threads in ${scopeDescription}.` +
        (this.#ctx.searchQuery
          ? `\n\n${formatApprovalField("Search restriction", this.#ctx.searchQuery)}`
          : "") +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("Required label", this.#ctx.labelName)}`
          : ""),
    });

    const labelIds = this.#ctx.labelId
      ? [this.#ctx.labelId]
      : (!this.#ctx.searchQuery ? ["INBOX"] : undefined);
    return gmailThreadCursor(this.#ctx, this.#ctx.searchQuery, labelIds);
  }

  async search(query: string): Promise<Cursor<GmailThreadEntry>> {
    validateGmailQueryForGrouping(query);
    // A leading boolean operator could bind outside the appended group.
    if (this.#ctx.searchQuery && /^(OR|AND)\b/i.test(query.trim())) {
      throw new Error("Query cannot start with OR/AND.");
    }

    const effectiveQuery = this.#ctx.searchQuery
      ? `(${this.#ctx.searchQuery}) (${query})`
      : query;

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Search Gmail",
      description:
        "Create a cursor for Gmail threads matching this effective query.\n\n" +
        formatApprovalField("Query", effectiveQuery) +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("Required label", this.#ctx.labelName)}`
          : ""),
    });

    // A full-mailbox binding may search all mail. Only an explicit label scope
    // attenuates search results; listThreads() separately defaults to INBOX.
    const labelIds = this.#ctx.labelId ? [this.#ctx.labelId] : undefined;
    return gmailThreadCursor(this.#ctx, effectiveQuery, labelIds);
  }

  async send(to: string[], subject: string, body: string): Promise<void> {
    // send() composes a brand-new outbound message, which isn't tied to any
    // particular thread. For search/label-scoped bindings the user only
    // granted access to a subset of their mail, so composing arbitrary new
    // outbound mail is out of scope — reject it. (reply/forward remain
    // available, since those act on a specific message capability that the
    // caller already obtained through the scoped session.)
    if (this.#ctx.searchQuery || this.#ctx.labelId) {
      throw new Error(
        "send() is not available on a search- or label-scoped Gmail binding. " +
        "Use reply()/forward() on a specific message, or connect the full mailbox.");
    }

    validateOutboundInput(to, subject, body);
    const message = this.#ctx.gmailApi.buildSendRaw(to, subject, body);
    await submitGmailAction(
      this.#ctx,
      { type: "send", to: message.to, subject: message.subject, body: message.body },
      {
        title: sanitizeApprovalTitle(`Send email: ${message.subject}`),
        description: describeOutboundMessage("Send a new email.", message),
      });
  }
}

function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function formatApprovalField(label: string, value: string): string {
  // Use a fence longer than any backtick run in the value, so untrusted email
  // fields render verbatim and cannot forge surrounding approval Markdown.
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  return `**${label}:**\n\n${fence}\n${value}\n${fence}`;
}

function describeOutboundMessage(intro: string, message: GmailOutboundMessage): string {
  let fields = [
    formatApprovalField("From", message.from),
    formatApprovalField("To", message.to.join(", ")),
    ...(message.cc.length > 0 ? [formatApprovalField("Cc", message.cc.join(", "))] : []),
    formatApprovalField("Subject", message.subject),
    formatApprovalField("Body", message.body),
    ...message.attachments.map(attachment => formatApprovalField(
      "Attachment",
      `${attachment.filename} (${attachment.contentType})\n${attachment.description}`)),
  ];
  return `${intro}\n\n${fields.join("\n\n")}`;
}

async function submitGmailAction(
    ctx: GmailSessionContext,
    action: GmailAction,
    desc: { title: string; description: string }): Promise<void> {
  if (ctx.pendingActions.list().length >= 100) {
    throw new Error("Too many pending Gmail actions. Resolve existing actions before adding more.");
  }
  let actionId = ctx.pendingActions.submit(action);
  try {
    await ctx.approvalQueue.submitAction(actionId, { ...desc, implementsRevert: false });
  } catch (err) {
    ctx.pendingActions.remove(actionId);
    throw err;
  }
}

// ── Cursors ─────────────────────────────────────────────────────────
// A cursor is a capability. The listThreads()/search() call authorizes its creation; CursorPager
// separately authorizes each page before disclosing it. See cursor.ts.

@validateRpc()
class RpcCursor<Entry> extends RpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;

  constructor(pager: Pager<Entry>) {
    super();
    this.#pager = pager;
  }

  // `next()` takes no arguments, so there is no argument surface to validate.
  @skipRpcValidation()
  next(): Promise<Entry[] | null> {
    return this.#pager.next();
  }
}

type GmailThreadRef = { id: string; snippet?: string };

/** Threads matching the scope, 20 at a time, each enriched with its metadata. */
function gmailThreadCursor(
    ctx: GmailSessionContext, query: string | undefined, labelIds?: string[],
): Cursor<GmailThreadEntry> {
  return new RpcCursor(new CursorPager<GmailThreadRef, GmailThreadEntry>({
    provider: "Gmail",

    async fetchPage(pageToken) {
      let { threads, nextPageToken } =
          await ctx.gmailApi.listThreads(20, query, pageToken, labelIds);
      return { items: threads, nextPageToken };
    },

    async buildEntries(threads) {
      // Stay below the Workers six-outgoing-connection limit while enriching the page.
      let entries: GmailThreadEntry[] = [];
      for (let i = 0; i < threads.length; i += 5) {
        entries.push(...await Promise.all(threads.slice(i, i + 5).map(async thread => {
          let metadata = await ctx.gmailApi.getThreadInfo(thread.id);
          let info: GmailThreadInfo = {
            ...metadata,
            ...(thread.snippet !== undefined ? { snippet: thread.snippet } : {}),
          };
          return { info, thread: new GmailThreadStub(ctx, thread.id, info) };
        })));
      }
      return entries;
    },

    authorize: entries => ctx.approvalQueue.authorizeObservation({
      title: `Read ${entries.length} Gmail threads`,
      description:
        "Fetch the next page of Gmail threads.\n\n" +
        formatApprovalField("Subjects", entries.map(entry => entry.info.subject).join("\n")),
    }),
  }));
}

// ── GmailThreadStub ─────────────────────────────────────────────────

@validateRpc()
class GmailThreadStub extends RpcTarget implements GmailThread {
  #ctx: GmailSessionContext;
  #threadId: string;
  #cachedInfo: GmailThreadInfo | undefined;

  constructor(ctx: GmailSessionContext, threadId: string, cachedInfo?: GmailThreadInfo) {
    super();
    this.#ctx = ctx;
    this.#threadId = threadId;
    this.#cachedInfo = cachedInfo;
  }

  async #ensureInfo(): Promise<GmailThreadInfo> {
    if (!this.#cachedInfo) {
      this.#cachedInfo = await this.#ctx.gmailApi.getThreadInfo(this.#threadId);
    }
    return this.#cachedInfo;
  }

  async getMetadata(): Promise<GmailThreadInfo> {
    const info = await this.#ensureInfo();

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Thread info: ${info.subject}`),
      description: `Get metadata for thread ${this.#threadId}.`,
    });

    return info;
  }

  async messages(): Promise<GmailMessage[]> {
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Get messages: ${thread.snippet || "(no snippet)"}`),
      description: `Get all messages in thread ${this.#threadId}.`,
    });

    return thread.messages.map(message =>
      new GmailMessageStub(this.#ctx, message.id, this.#threadId)
    );
  }

  async messagesVisibleTo(address: string): Promise<GmailMessage[]> {
    validateGmailAddress(address);
    const [normalizedAddress] = normalizeEmailRecipients([address]);
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Messages involving ${normalizedAddress}`),
      description:
        "List messages in this thread involving the requested address.\n\n" +
        formatApprovalField("Address", normalizedAddress) + "\n\n" +
        formatApprovalField("Thread snippet", thread.snippet || "(no snippet)"),
    });

    if (thread.messages.length > MAX_GMAIL_VISIBLE_THREAD_MESSAGES) {
      throw new Error(
        `Thread has ${thread.messages.length} messages; messagesVisibleTo() supports at most ` +
        `${MAX_GMAIL_VISIBLE_THREAD_MESSAGES}.`);
    }

    const target = normalizedAddress.toLowerCase();
    const visible: GmailMessage[] = [];
    // Fetch only participant metadata, at most five messages at once.
    for (let i = 0; i < thread.messages.length; i += 5) {
      const batch = thread.messages.slice(i, i + 5);
      const participantSets = await Promise.all(batch.map(message =>
        this.#ctx.gmailApi.getMessageParticipants(message.id).catch(err => {
          logger.warn("getMessageParticipants failed", {
            event: "gmail.message.participants.get.failed",
            messageId: message.id, error: err,
          });
          return null;
        })));
      for (let j = 0; j < batch.length; j++) {
        if (participantSets[j]?.has(target)) {
          visible.push(new GmailMessageStub(this.#ctx, batch[j].id, this.#threadId));
        }
      }
    }
    return visible;
  }

  async #submitThreadAction(
      type: "archive" | "trash" | "markRead" | "markUnread",
      titlePrefix: string,
      intro: string): Promise<void> {
    const info = await this.#ensureInfo();
    const subject = info.subject || "(no subject)";
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read thread before ${titlePrefix.toLowerCase()}: ${subject}`),
      description: "Read the current Gmail thread metadata needed to prepare this action.",
    });
    await submitGmailAction(
      this.#ctx,
      { type, threadId: this.#threadId },
      {
        title: sanitizeApprovalTitle(`${titlePrefix}: ${subject}`),
        description:
          `${intro}\n\n` +
          formatApprovalField("Subject", subject) +
          (info.snippet !== undefined
            ? `\n\n${formatApprovalField("Snippet", info.snippet)}`
            : ""),
      });
  }

  async archive(): Promise<void> {
    await this.#submitThreadAction("archive", "Archive", "Remove this thread from the inbox.");
  }

  async trash(): Promise<void> {
    await this.#submitThreadAction("trash", "Trash", "Move this thread to trash.");
  }

  async markRead(): Promise<void> {
    await this.#submitThreadAction("markRead", "Mark read", "Mark every message in this thread as read.");
  }

  async markUnread(): Promise<void> {
    await this.#submitThreadAction("markUnread", "Mark unread", "Mark every message in this thread as unread.");
  }
}

// ── GmailMessageStub ────────────────────────────────────────────────

@validateRpc()
class GmailMessageStub extends RpcTarget implements GmailMessage {
  #ctx: GmailSessionContext;
  #messageId: string;
  #threadId: string;
  #cachedRaw: GmailMessageRaw | undefined;

  constructor(ctx: GmailSessionContext, messageId: string, threadId: string, cachedRaw?: GmailMessageRaw) {
    super();
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
    this.#cachedRaw = cachedRaw;
  }

  async #getRaw(): Promise<GmailMessageRaw> {
    if (!this.#cachedRaw) {
      this.#cachedRaw = await this.#ctx.gmailApi.getMessage(this.#messageId);
    }
    return this.#cachedRaw;
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const raw = await this.#getRaw();
    const rawInfo = await this.#ctx.gmailApi.parseMessageInfo(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Message info: ${rawInfo.subject}`),
      description: `Get metadata for message ${this.#messageId}.`,
    });

    // Resolve raw label IDs to GmailLabel objects.
    const labels = await this.#ctx.resolveLabels(rawInfo.labelIds);
    return {
      id: this.#messageId,
      from: rawInfo.from,
      to: rawInfo.to,
      cc: rawInfo.cc,
      subject: rawInfo.subject,
      timestamp: rawInfo.timestamp,
      labels,
    };
  }

  async thread(): Promise<GmailThread> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Get thread for message`,
      description: `Navigate from message ${this.#messageId} to its parent thread.`,
    });
    return new GmailThreadStub(this.#ctx, this.#threadId);
  }

  async getContent(): Promise<EmailContent> {
    const raw = await this.#getRaw();
    const { info, content } = await this.#ctx.gmailApi.parseMessage(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read message: ${info.subject}`),
      description: `Get body content of message ${this.#messageId}.`,
    });

    return content;
  }

  async reply(body: string): Promise<void> {
    validateGmailBody(body);
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message headers to prepare reply",
      description: "Read the source message headers needed to calculate reply recipients and threading.",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, false);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: false,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`Reply: ${message.subject}`),
        description: describeOutboundMessage("Send a reply.", message),
      });
  }

  async replyAll(body: string): Promise<void> {
    validateGmailBody(body);
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message headers to prepare reply-all",
      description: "Read the source message headers needed to calculate reply-all recipients and threading.",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, true);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: true,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`Reply all: ${message.subject}`),
        description: describeOutboundMessage("Send a reply to all recipients.", message),
      });
  }

  async forward(to: string[], body?: string): Promise<void> {
    const normalizedTo = normalizeEmailRecipients(to);
    validateGmailRecipientCount(normalizedTo);
    validateGmailBody(body ?? '');
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message to prepare forward",
      description: "Read the complete source message and attachment metadata needed to prepare a forward.",
    });
    const message = await this.#ctx.gmailApi.buildForwardRaw(original, normalizedTo, body);
    validateOutboundInput(message.to, message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      { type: "forward", sourceMessageId: this.#messageId, to: normalizedTo, body },
      {
        title: sanitizeApprovalTitle(`Forward: ${message.subject}`),
        description: describeOutboundMessage(
          "Forward an existing message. The complete original email is attached losslessly.",
          message),
      });
  }
}

// =======================================================================================

type GmailGatekeeperImplProps = {
  userObjectId: string;

  // Optional free-form Gmail search restriction.
  searchQuery?: string;

  // Optional exact Gmail label name. Resolved to a label ID at session start;
  // never interpolated into Gmail search syntax.
  labelName?: string;
}

@validateRpc()
export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailSession> {
  #tokens = new AccessTokenCache(opts => {
    let stub = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async #getSelfEmail(): Promise<string> {
    let cached = this.ctx.storage.kv.get<string>("selfEmail");
    if (cached) return cached;

    let token = await this.#getAccessToken();
    let desc = await getGoogleAccountDescription(token);
    if (!desc.uniqueName) {
      throw new Error("Google account has no email address");
    }
    this.ctx.storage.kv.put("selfEmail", desc.uniqueName);
    return desc.uniqueName;
  }

  async describe(): Promise<ResourceDescription> {
    const labelName = this.ctx.props.labelName;
    if (labelName) {
      return {
        url: `https://mail.google.com/mail/#label/${encodeURIComponent(labelName)}`,
        title: `Gmail label: ${labelName}`,
        snippet: `Gmail threads with label: ${labelName}`,
        suggestedBindingName: "GMAIL_LABEL",
        tsType: "GmailSession",
      };
    }

    let searchQuery = this.ctx.props.searchQuery;
    if (searchQuery) {
      return {
        url: `https://mail.google.com/mail/#search/${encodeURIComponent(searchQuery)}`,
        title: `Gmail: ${searchQuery}`,
        snippet: `Gmail threads matching: ${searchQuery}`,
        suggestedBindingName: "GMAIL_SEARCH",
        tsType: "GmailSession",
      };
    }

    return {
      url: "https://mail.google.com/mail/",
      title: "Gmail Inbox",
      snippet: "Your personal Gmail inbox",
      suggestedBindingName: "GMAIL_INBOX",
      tsType: "GmailSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GmailSession> {
    let selfEmail = await this.#getSelfEmail();
    let gmailApi = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

    // In-memory label map cache for the session lifetime. Fetched once on
    // first label resolution, shared across all stubs in this session.
    let labelMapCache: Map<string, string> | undefined;
    const getLabelMap = async () => {
      if (!labelMapCache) labelMapCache = await gmailApi.listLabels();
      return labelMapCache;
    };
    let labelId: string | undefined;
    if (this.ctx.props.labelName) {
      const labelMap = await getLabelMap();
      labelId = [...labelMap].find(([, name]) => name === this.ctx.props.labelName)?.[0];
      if (!labelId) {
        throw new Error(`Gmail label not found: ${this.ctx.props.labelName}`);
      }
    }

    const ctx: GmailSessionContext = {
      gmailApi,
      approvalQueue: approvalQueue.dup(),
      pendingActions: new PendingActionStore<GmailAction>(this.ctx.storage.kv),
      searchQuery: this.ctx.props.searchQuery,
      labelId,
      labelName: this.ctx.props.labelName,
      resolveLabels: async (labelIds: string[]): Promise<GmailLabel[]> =>
        toLabelObjects(labelIds, await getLabelMap()),
    };

    return new GmailSessionImpl(ctx);
  }

  /** --------------------------------------------------------------------------- */
  async applyAction(actionId: number): Promise<void> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    const action = pendingActions.get(actionId);
    if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);

    const selfEmail = await this.#getSelfEmail();
    const gmailApi = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

    switch (action.type) {
      case "archive":
        await gmailApi.modifyThread(action.threadId, [], ["INBOX"]);
        break;
      case "trash":
        await gmailApi.trashThread(action.threadId);
        break;
      case "markRead":
        await gmailApi.modifyThread(action.threadId, [], ["UNREAD"]);
        break;
      case "markUnread":
        await gmailApi.modifyThread(action.threadId, ["UNREAD"], []);
        break;
      case "send": {
        const message = gmailApi.buildSendRaw(action.to, action.subject, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      case "reply": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildReplyRaw(
          original, action.body, action.replyAll, action.sourceWasSent);
        await gmailApi.sendRawMessage(message.raw, action.threadId);
        break;
      }
      case "forward": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildForwardRaw(original, action.to, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      default:
        action satisfies never;
        throw new Error(`unknown action type: ${(action as {type: string}).type}`);
    }

    pendingActions.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    if (!pendingActions.get(actionId)) {
      throw new Error(`Unknown pending Gmail action: ${actionId}`);
    }
    pendingActions.remove(actionId);
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  /**
   * Observer tracking — strategy A (private-only). Full access to a mailbox/label/search is too
   * personal to extend to any non-owner observer (a Gmail mailbox has no per-recipient ACL we could
   * verify an observer against — the mailing-list decomposition discussed in the plan is explicitly
   * out of scope). So no non-owner observer may ever observe Gmail data: addObserver always throws.
   * (This is enforced here in addition to any prohibitAllSharing usage, so the lockdown holds even
   * when sharing is otherwise permitted.) removeObserver is a no-op since none is ever recorded.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "Gmail data cannot be shared with other users: this workspace reads a personal Gmail mailbox, " +
      "which may only be observed by its owner.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  documentId: string;
  submittedAt: number;
  baseRevisionId: string;
  invalidatedReason?: string;
}

type GoogleDocReplaceAction = GoogleDocActionBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocActionBase & {
  type: "appendText";
  markdown: string;
}

type GoogleDocAction = GoogleDocReplaceAction | GoogleDocAppendAction;

type GoogleDocPendingAction = {id: number, action: GoogleDocAction};

type GoogleDocSimulatedContentCache = {
  baseRevisionId: string;
  pendingFingerprint: string;
  markdown: string;
  pendingActions: GoogleDocAction[];
  computedAt: number;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

function previewMarkdown(markdown: string, maxLength: number): string {
  return markdown.length > maxLength ? markdown.slice(0, maxLength) + "..." : markdown;
}

function findUniqueMarkdown(markdown: string, oldMarkdown: string, operation: string): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}: oldMarkdown must not be empty.`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated document. ` +
      `Make sure the text exactly matches content returned by getContent().`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated document. ` +
      `Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  markdown: string,
  oldMarkdown: string,
  newMarkdown: string,
  operation: string,
): string {
  if (oldMarkdown === newMarkdown) {
    return markdown;
  }

  let index = findUniqueMarkdown(markdown, oldMarkdown, operation);
  return markdown.slice(0, index) + newMarkdown + markdown.slice(index + oldMarkdown.length);
}

function appendMarkdownForSimulation(markdown: string, appendedMarkdown: string): string {
  let normalizedAppend = appendedMarkdown.endsWith("\n") ? appendedMarkdown : appendedMarkdown + "\n";

  if (markdown.length === 0) {
    return normalizedAppend;
  }

  if (markdown.endsWith("\n\n")) {
    return markdown + normalizedAppend;
  }

  if (markdown.endsWith("\n")) {
    return markdown + "\n" + normalizedAppend;
  }

  return markdown + "\n\n" + normalizedAppend;
}

function applyGoogleDocActionToMarkdown(markdown: string, action: GoogleDocAction): string {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(
          markdown, action.oldMarkdown, action.newMarkdown, "replaceText");
    case "appendText":
      return appendMarkdownForSimulation(markdown, action.markdown);
    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateGoogleDocAction(
  pendingActions: PendingActionStore<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.put(pending.id, pending.action);
  }
}

function invalidateUnreplayableGoogleDocActions(
  pendingActions: PendingActionStore<GoogleDocAction>,
  baseMarkdown: string,
  pending: GoogleDocPendingAction[],
  context: string,
): {markdown: string, pendingActions: GoogleDocAction[]} {
  let markdown = baseMarkdown;
  let replayedActions: GoogleDocAction[] = [];
  for (let i = 0; i < pending.length; i++) {
    let action = pending[i].action;
    if (action.invalidatedReason) {
      continue;
    }

    try {
      markdown = applyGoogleDocActionToMarkdown(markdown, action);
    } catch (error) {
      invalidateGoogleDocAction(
          pendingActions,
          pending[i],
          `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
          `Reject it and retry if it is still needed.`);
      continue;
    }
    replayedActions.push(action);
  }

  return {markdown, pendingActions: replayedActions};
}

function materializeGoogleDocAction(snapshot: DocSnapshot, action: GoogleDocAction): any[] {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          snapshot.markdown, action.oldMarkdown, "applyAction(replaceText)");
      let result = computeReplaceOperations(
          snapshot.sourceMap,
          snapshot.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          action.newMarkdown);
      return result.requests;
    }

    case "appendText": {
      let insertAt = snapshot.bodyEndIndex - 1;
      return markdownToDocRequests("\n" + action.markdown, insertAt);
    }

    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

type GoogleDocGatekeeperImplProps = {
  userObjectId: string;
  documentId: string;
}

// All Google Doc edits (replaceText, appendText, ...) are grouped under a single action kind
const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "Document edits",
};

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = {};
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(this.ctx.props.documentId);
    return {
      url: `https://docs.google.com/document/d/${this.ctx.props.documentId}/edit`,
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return DOCS_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [EDIT_DOCUMENT_ACTION];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    return new GoogleDocSessionImpl(
        api,
        this.ctx.props.documentId,
        approvalQueue.dup(),
        pendingActions,
        this.ctx.storage,
        this.#simulationCache);
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let pendingRecord = pending[pendingIndex];

    let action = pendingRecord.action;
    if (action.invalidatedReason) {
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      return;
    }

    let firstPending = pending.find(({action}) => !action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(action.documentId);
    let snapshot = docToMarkdown(doc);
    let requests: any[];
    try {
      requests = materializeGoogleDocAction(snapshot, action);
    } catch (error) {
      logger.error("dropping stale Google Doc action during apply", {
        event: "google.doc.action.apply.stale.dropped",
        actionId, error,
      });
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      await this.ctx.storage.put("docSnapshot", snapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          snapshot.markdown,
          pending.slice(pendingIndex + 1),
          `Pending Google Doc edits could not be replayed after edit ${actionId} was dropped`);
      return;
    }
    if (requests.length > 0) {
      await api.batchUpdate(action.documentId, requests, snapshot.revisionId);
    }
    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;

    try {
      let refreshedSnapshot = snapshot;
      if (requests.length > 0) {
        refreshedSnapshot = docToMarkdown(await api.getDocument(action.documentId));
      }
      await this.ctx.storage.put("docSnapshot", refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot.markdown,
          pending.slice(pendingIndex + 1),
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete("docSnapshot");
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete("docSnapshot");

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). The binding is one document, so we just
   * confirm the observer can open it with their own token (hasDocAccess, via the Drive/Docs ACL).
   * The document is the atomic unit (everything read through this binding is that one doc), so no
   * observers are tracked and removeObserver is a no-op. The overseer re-runs addObserver on every
   * open, catching loss of access promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.ctx.props.documentId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Doc, so they cannot be allowed " +
        "to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocsApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;

  constructor(
    docsApi: GoogleDocsApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
  }

  async #getSnapshot(forceRefresh?: boolean): Promise<DocSnapshot> {
    if (!forceRefresh) {
      let cached = await this.#storage.get<DocSnapshot>("docSnapshot");
      if (cached) {
        let age = Date.now() - cached.fetchedAt;
        if (age < 10_000) {
          return cached;
        }
        // TTL expired — check if document has changed.
        let currentRevisionId = await this.#docsApi.getRevisionId(this.#documentId);
        if (currentRevisionId === cached.revisionId) {
          cached.fetchedAt = Date.now();
          await this.#storage.put("docSnapshot", cached);
          return cached;
        }
      }
    }

    // Fetch full document and build snapshot.
    let doc = await this.#docsApi.getDocument(this.#documentId);
    let snapshot = docToMarkdown(doc);
    await this.#storage.put("docSnapshot", snapshot);
    return snapshot;
  }

  async #getSimulatedContent(): Promise<{
    snapshot: DocSnapshot,
    markdown: string,
    pendingActions: GoogleDocAction[],
  }> {
    let snapshot = await this.#getSnapshot();
    let pending = this.#pendingActions.list();
    let pendingFingerprint = googleDocPendingFingerprint(pending);
    let cached = this.#simulationCache.current;
    if (cached && cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === pendingFingerprint) {
      return {
        snapshot,
        markdown: cached.markdown,
        pendingActions: cached.pendingActions,
      };
    }

    let {markdown, pendingActions} = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot.markdown,
        pending,
        "Pending Google Doc edit could not be replayed against the current document");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.list()),
      markdown,
      pendingActions,
      computedAt: Date.now(),
    };
    return {snapshot, markdown, pendingActions};
  }

  async getMetadata(): Promise<DocMetadata> {
    let {snapshot, pendingActions} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    // The Docs API doesn't return lastModified directly (that's a Drive API field).
    // For now, use the fetch timestamp as an approximation.
    // TODO: Use Drive API files.get for actual modifiedTime.
    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), snapshot.fetchedAt);
    return {
      title: snapshot.title ?? "Untitled document",
      lastModified: new Date(lastModified),
    };
  }

  async getContent(): Promise<string> {
    let {markdown} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc content",
      description: "Read the full simulated content of the document as Markdown.",
    });

    return markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }

    let {snapshot, markdown} = await this.#getSimulatedContent();
    findUniqueMarkdown(markdown, oldMarkdown, "replaceText");

    let action: GoogleDocAction = {
      type: "replaceText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      oldMarkdown,
      newMarkdown,
    };

    let oldPreview = previewMarkdown(oldMarkdown, 80);
    let newPreview = previewMarkdown(newMarkdown, 80);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Edit Google Doc",
        description:
          `Replace text in the document.\n\n` +
          `**Old:** ${oldPreview}\n\n` +
          `**New:** ${newPreview}`,
        implementsRevert: false,
        // Group all document edits under one tag
        actionKind: EDIT_DOCUMENT_ACTION,
        autoApprovable: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }

  async appendText(markdown: string): Promise<void> {
    let {snapshot} = await this.#getSimulatedContent();

    let action: GoogleDocAction = {
      type: "appendText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      markdown,
    };

    let preview = previewMarkdown(markdown, 100);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Append to Google Doc",
        description: `Append content to the end of the document:\n\n${preview}`,
        implementsRevert: false,
        // Same "editDocument" tag as replaceText
        actionKind: EDIT_DOCUMENT_ACTION,
        autoApprovable: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }
}

// =======================================================================================
// Google Sheets Gatekeeper
// =======================================================================================

type GoogleSheetsGatekeeperImplProps = {
  userObjectId: string;
  spreadsheetId: string;
};

@validateRpc()
export class GoogleSheetsGatekeeperImpl
    extends DurableObject<Env, GoogleSheetsGatekeeperImplProps>
    implements Gatekeeper<GoogleSpreadsheetSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
    return account.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleSheetsApi(opts => this.#getAccessToken(opts));
    let spreadsheet = await api.getSpreadsheet(this.ctx.props.spreadsheetId);
    return {
      url: `https://docs.google.com/spreadsheets/d/${this.ctx.props.spreadsheetId}/edit`,
      title: spreadsheet.title,
      snippet: `Google Spreadsheet: ${spreadsheet.title} (read-only)`,
      suggestedBindingName: "GOOGLE_SHEET",
      tsType: "GoogleSpreadsheetSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return SHEETS_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleSpreadsheetSession> {
    let api = new GoogleSheetsApi(opts => this.#getAccessToken(opts));
    return new GoogleSpreadsheetSessionImpl(
      api, this.ctx.props.spreadsheetId, approvalQueue.dup(),
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {
    throw new Error("Google Sheets is read-only and implements no actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("Google Sheets is read-only and implements no actions.");
  }
  revertAction(_action: number): Promise<void> {
    throw new Error("Google Sheets is read-only and implements no actions.");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). Google applies sharing permissions at
   * spreadsheet granularity, so an observer must be able to open this spreadsheet with their own
   * account. The overseer re-runs this check on every open, catching revoked access.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasSpreadsheetAccess(this.ctx.props.spreadsheetId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google spreadsheet, so they cannot " +
        "observe data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GoogleSpreadsheetSessionImpl extends RpcTarget implements GoogleSpreadsheetSession {
  #api: GoogleSheetsApi;
  #spreadsheetId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
    api: GoogleSheetsApi,
    spreadsheetId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
    this.#api = api;
    this.#spreadsheetId = spreadsheetId;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getSpreadsheet(): Promise<SpreadsheetInfo> {
    let spreadsheet = await this.#api.getSpreadsheet(this.#spreadsheetId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Google spreadsheet metadata",
      description:
        `Read metadata for "${spreadsheet.title}", including its ${spreadsheet.sheets.length} ` +
        "worksheet(s).",
    });
    return spreadsheet;
  }

  async readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    return (await this.#readRanges([range], options))[0];
  }

  async readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    return this.#readRanges(ranges, options);
  }

  async #readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    let result = await this.#api.readRanges(
      this.#spreadsheetId, ranges, options?.valueMode,
    );
    let cellCount = result.reduce(
      (total, range) => total + range.values.reduce((sum, row) => sum + row.length, 0),
      0,
    );
    await this.#approvalQueue.authorizeObservation({
      title: result.length === 1
        ? `Read Google Sheets range ${result[0].range}`
        : `Read ${result.length} Google Sheets ranges`,
      description:
        `Read ${cellCount.toLocaleString()} cell(s) from ${result.length} bounded range(s) in ` +
        "the connected spreadsheet.",
    });
    return result;
  }
}

// =======================================================================================
// Google Calendar Gatekeeper
// =======================================================================================

type GoogleCalendarActionBase = {
  calendarId: string;
  submittedAt: number;
  sendUpdates: CalendarSendUpdates;
}

type GoogleCalendarCreateAction = GoogleCalendarActionBase & {
  type: "createEvent";
  event: CalendarEventDraft;
}

type GoogleCalendarUpdateAction = GoogleCalendarActionBase & {
  type: "updateEvent";
  eventId: string;
  patch: CalendarEventPatch;
}

type GoogleCalendarAction = GoogleCalendarCreateAction | GoogleCalendarUpdateAction;

type GoogleCalendarRevertInfo =
  | {
      type: "createdEvent";
      calendarId: string;
      eventId: string;
      sendUpdates: CalendarSendUpdates;
    }
  | {
      type: "updatedEvent";
      calendarId: string;
      eventId: string;
      // Prior values of exactly the fields that were changed, so the edit can be patched back.
      previous: CalendarEventPatch;
      sendUpdates: CalendarSendUpdates;
    };

type GoogleCalendarGatekeeperImplProps = {
  userObjectId: string;
  calendarId: string;
  availabilityMode: CalendarAvailabilityMode;
}

function previewCalendarTime(time: CalendarTime): string {
  if (time.kind === "date") return time.date;
  return time.dateTime.toISOString();
}

function pendingCalendarEventFromDraft(
  id: number,
  action: GoogleCalendarCreateAction,
  opts: CalendarListEventsOptions,
): CalendarEvent {
  return {
    id: `pending:create:${id}`,
    title: action.event.title,
    start: action.event.start,
    end: action.event.end,
    status: "confirmed",
    ...(action.event.location ? {location: action.event.location} : {}),
    ...(opts.includeDescriptions && action.event.description ? {description: action.event.description} : {}),
    ...(action.event.attendees ? {attendees: action.event.attendees} : {}),
    ...(action.event.transparency ? {transparency: action.event.transparency} : {}),
    ...(action.event.visibility ? {visibility: action.event.visibility} : {}),
    pending: true,
  };
}

// Apply a pending updateEvent's patch onto a fetched event in place, so listEvents() reflects the
// edit before it's approved.
function applyCalendarPatchToEvent(
  event: CalendarEvent,
  patch: CalendarEventPatch,
  opts: CalendarListEventsOptions,
): void {
  if (patch.title !== undefined) event.title = patch.title;
  if (patch.start !== undefined) event.start = patch.start;
  if (patch.end !== undefined) event.end = patch.end;
  if (patch.location !== undefined) event.location = patch.location;
  if (patch.transparency !== undefined) event.transparency = patch.transparency;
  if (patch.visibility !== undefined) event.visibility = patch.visibility;
  if (patch.description !== undefined && opts.includeDescriptions) {
    event.description = patch.description;
  }
  if (patch.attendees !== undefined) {
    event.attendees = patch.attendees;
  }
}

// Build the undo patch for an updateEvent.
function priorCalendarPatch(oldEvent: CalendarEvent, patch: CalendarEventPatch): CalendarEventPatch {
  let previous: CalendarEventPatch = {};
  if (patch.title !== undefined) previous.title = oldEvent.title;
  if (patch.start !== undefined) previous.start = oldEvent.start;
  if (patch.end !== undefined) previous.end = oldEvent.end;
  if (patch.location !== undefined) previous.location = oldEvent.location ?? "";
  if (patch.description !== undefined) previous.description = oldEvent.description ?? "";
  if (patch.transparency !== undefined) previous.transparency = oldEvent.transparency ?? "opaque";
  if (patch.visibility !== undefined) previous.visibility = oldEvent.visibility ?? "default";
  if (patch.attendees !== undefined) {
    previous.attendees = (oldEvent.attendees ?? []).map(a => ({
      email: a.email,
      ...(a.displayName ? {displayName: a.displayName} : {}),
      ...(a.optional ? {optional: a.optional} : {}),
    }));
  }
  return previous;
}

function summarizeCalendarPatch(patch: CalendarEventPatch): string {
  let parts: string[] = [];
  if (patch.title !== undefined) parts.push(`title \u2192 "${patch.title}"`);
  if (patch.start !== undefined) parts.push(`start \u2192 ${previewCalendarTime(patch.start)}`);
  if (patch.end !== undefined) parts.push(`end \u2192 ${previewCalendarTime(patch.end)}`);
  if (patch.location !== undefined) parts.push(`location \u2192 "${patch.location}"`);
  if (patch.description !== undefined) parts.push("description");
  if (patch.attendees !== undefined) {
    parts.push(`attendees \u2192 ${patch.attendees.map(a => a.email).join(", ") || "(none)"}`);
  }
  if (patch.transparency !== undefined) parts.push(`transparency \u2192 ${patch.transparency}`);
  if (patch.visibility !== undefined) parts.push(`visibility \u2192 ${patch.visibility}`);
  return parts.length ? parts.join("; ") : "(no changes)";
}

function applyPendingCalendarActions(
  events: CalendarEvent[],
  pending: {id: number, action: GoogleCalendarAction}[],
  opts: CalendarListEventsOptions,
): CalendarEvent[] {
  let byId = new Map(events.map(event => [event.id, {...event}]));
  let added: CalendarEvent[] = [];

  for (let {id, action} of pending) {
    if (action.type === "createEvent") {
      let event = pendingCalendarEventFromDraft(id, action, opts);
      if (calendarEventOverlaps(event, opts.timeMin, opts.timeMax)) added.push(event);
    } else if (action.type === "updateEvent") {
      let existing = byId.get(action.eventId);
      if (existing) {
        applyCalendarPatchToEvent(existing, action.patch, opts);
        existing.pending = true;
        if (!calendarEventOverlaps(existing, opts.timeMin, opts.timeMax)) {
          byId.delete(action.eventId);
        }
      }
    } else {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }

  return [...byId.values(), ...added]
      .toSorted((a, b) => calendarEventSortKey(a) - calendarEventSortKey(b));
}

function validateEventTimes(start: CalendarTime, end: CalendarTime): void {
  if (start.kind !== end.kind) {
    throw new Error("Event start and end must both be all-day (date) or both be timed (dateTime).");
  }
  let startMs = start.kind === "date" ? Date.parse(start.date) : start.dateTime.valueOf();
  let endMs = end.kind === "date" ? Date.parse(end.date) : end.dateTime.valueOf();
  if (!(endMs > startMs)) throw new Error("Event end must be after start.");
}

function summarizePeople(people: string[]): string {
  if (people.length <= 5) return people.join(", ");
  return `${people.slice(0, 5).join(", ")}, and ${people.length - 5} more`;
}

export class GoogleCalendarGatekeeperImpl
    extends DurableObject<Env, GoogleCalendarGatekeeperImplProps>
    implements Gatekeeper<GoogleCalendarSession> {
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  // Revert data for already-applied actions, keyed by action id. The overseer no longer round-trips
  // revert info through applyAction()/revertAction(), so we persist it in our own storage.
  #revertKey(actionId: number): string {
    return `revert:info:${actionId}`;
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let calendar = await api.getCalendar(this.ctx.props.calendarId);
    let availability = this.ctx.props.availabilityMode === "allVisible"
        ? " Availability lookup covers all calendars visible to the account."
        : " Availability lookup is limited to this calendar.";
    return {
      url: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(this.ctx.props.calendarId)}`,
      title: `Calendar: ${calendar.summary}`,
      snippet: `Google Calendar: ${calendar.summary}.${availability}`,
      suggestedBindingName: "GOOGLE_CALENDAR",
      tsType: "GoogleCalendarSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CALENDAR_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleCalendarSession> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    return new GoogleCalendarSessionImpl(
      api,
      this.ctx.props.calendarId,
      this.ctx.props.availabilityMode,
      approvalQueue.dup(),
      pendingActions,
      calendarIds => this.#observers.prepareObservation(calendarIds),
    );
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    let action = pendingActions.get(actionId);
    if (!action) {
      throw new Error(`Unknown pending Google Calendar action: ${actionId}`);
    }

    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    switch (action.type) {
      case "createEvent": {
        let created = await api.createEvent(action.calendarId, action.event, action.sendUpdates);
        pendingActions.remove(actionId);
        this.ctx.storage.kv.put<GoogleCalendarRevertInfo>(this.#revertKey(actionId), {
          type: "createdEvent",
          calendarId: action.calendarId,
          eventId: created.id,
          sendUpdates: action.sendUpdates,
        });
        return;
      }
      case "updateEvent": {
        let oldEvent = await api.getEvent(action.calendarId, action.eventId);
        let previous = priorCalendarPatch(oldEvent, action.patch);
        await api.patchEvent(
          action.calendarId, action.eventId,
          eventPatchToGoogle(action.patch), action.sendUpdates);
        pendingActions.remove(actionId);
        this.ctx.storage.kv.put<GoogleCalendarRevertInfo>(this.#revertKey(actionId), {
          type: "updatedEvent",
          calendarId: action.calendarId,
          eventId: action.eventId,
          previous,
          sendUpdates: action.sendUpdates,
        });
        return;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown action type: ${String(_exhaustive)}`);
      }
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    pendingActions.remove(actionId);
  }

  async revertAction(actionId: number)
      : Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    let revertInfo =
        this.ctx.storage.kv.get<GoogleCalendarRevertInfo>(this.#revertKey(actionId));
    if (!revertInfo) {
      return {
        message: "This Google Calendar action can no longer be reverted automatically. " +
            "Undo it manually from Google Calendar.",
      };
    }

    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    switch (revertInfo.type) {
      case "createdEvent":
        await api.deleteEvent(revertInfo.calendarId, revertInfo.eventId, revertInfo.sendUpdates);
        break;
      case "updatedEvent":
        await api.patchEvent(
          revertInfo.calendarId, revertInfo.eventId,
          eventPatchToGoogle(revertInfo.previous), revertInfo.sendUpdates);
        break;
      default: {
        const _exhaustive: never = revertInfo;
        void _exhaustive;
      }
    }
    this.ctx.storage.kv.delete(this.#revertKey(actionId));
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // No hooks for Google Calendar.
  }

  // Observer tracking combines strategy B for the selected calendar with strategy C for the
  // optional all-visible availability scope. Full event reads can include private event details,
  // which Google hides from readers, so observers must currently be writers or owners.
  // TODO: Let the binding owner choose whether private events are included. A public-only mode
  // could admit readers instead of requiring writer access from every collaborator.

  get #observers(): ObserverTracker<string, Fetcher<GoogleVerifierApi>> {
    return new ObserverTracker(this.ctx.storage.kv, {
      setPrefix: "observedAvailabilityCalendar:",
      encode: calendarId => encodeURIComponent(calendarId),
      decode: encoded => decodeURIComponent(encoded),
      hasAccess: (verifier, calendarId) => verifier.hasCalendarFreeBusyAccess(calendarId),
      deniedMessage: calendarId =>
        `This collaborator cannot see free/busy availability for ${calendarId}, whose ` +
        "availability this workspace has read, so they cannot be allowed to observe it.",
      // In thisCalendar mode no foreign calendar is ever read, so there is never anyone to
      // forward-exclude and nothing to remember an observer for.
      recordObservers: this.ctx.props.availabilityMode === "allVisible",
    });
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasCalendarWriterAccess(this.ctx.props.calendarId))) {
      throw new Error(
        "This collaborator does not have writer access to the bound Google Calendar, so they " +
        "cannot be allowed to observe its event details.");
    }
    await this.#observers.addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observers.removeObserver(id);
  }
}

class GoogleCalendarSessionImpl extends RpcTarget implements GoogleCalendarSession {
  #api: GoogleCalendarApi;
  #calendarId: string;
  #availabilityMode: CalendarAvailabilityMode;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleCalendarAction>;
  #observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>;

  constructor(
    api: GoogleCalendarApi,
    calendarId: string,
    availabilityMode: CalendarAvailabilityMode,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleCalendarAction>,
    observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>,
  ) {
    super();
    this.#api = api;
    this.#calendarId = calendarId;
    this.#availabilityMode = availabilityMode;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#observeAvailabilityCalendars = observeAvailabilityCalendars;
  }

  async getCapabilities(): Promise<GoogleCalendarCapabilities> {
    return {availabilityMode: this.#availabilityMode};
  }

  async getCalendar(): Promise<GoogleCalendarInfo> {
    let calendar = await this.#api.getCalendar(this.#calendarId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Calendar metadata",
      description: `Read metadata for Google Calendar ${calendar.summary} (${calendar.id}).`,
    });
    return calendar;
  }

  async listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 366);
    let events = await this.#api.listEvents(this.#calendarId, opts);
    let simulated = applyPendingCalendarActions(events, this.#pendingActions.list(), opts);

    await this.#approvalQueue.authorizeObservation({
      title: "List Google Calendar events",
      description:
          `List ${simulated.length} event(s) on calendar ${this.#calendarId} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}.` +
          (opts.includeDescriptions ? " Event descriptions are included." : ""),
    });

    return simulated;
  }

  async checkAvailability(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 90);
    let people = [...new Set(opts.people.map(person => person.trim()).filter(Boolean))];
    if (people.length === 0) throw new Error("At least one person or calendar is required.");
    if (people.length > 50) throw new Error("At most 50 people/calendars can be checked at once.");
    if (people.includes("primary")) {
      throw new Error(
        "Availability checks must use a stable calendar ID or email address, not the " +
        "account-relative \"primary\" alias.");
    }

    let foreign = people.filter(id => id !== this.#calendarId);
    if (foreign.length > 0 && this.#availabilityMode === "thisCalendar") {
      throw new Error(
          "This connection only allows availability for the bound calendar. Reconnect with " +
          "\"All calendars visible to me\" to check other calendars' availability.");
    }

    let availability = await this.#api.freeBusy({...opts, people});
    let successfulForeign = availability
        .filter(result => foreign.includes(result.email) && !result.error)
        .map(result => result.email);
    let check = successfulForeign.length > 0
        ? await this.#observeAvailabilityCalendars(successfulForeign)
        : {pendingSets: [], commit() {}};

    await this.#approvalQueue.authorizeObservation({
      title: "Check Google Calendar availability",
      description:
          `Check free/busy availability for ${summarizePeople(people)} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}. ` +
          "Only busy time blocks are returned; event details are not read.",
      excludeObservers: check.excludeObservers,
    });
    check.commit();

    return availability;
  }

  async createEvent(
    event: CalendarEventDraft,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!event.title.trim()) throw new Error("Event title is required.");
    validateEventTimes(event.start, event.end);
    let action: GoogleCalendarAction = {
      type: "createEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      event,
    };
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `Create calendar event: ${event.title}`,
        description:
            `Create event **${event.title}** on calendar ${this.#calendarId} from ` +
            `${previewCalendarTime(event.start)} to ${previewCalendarTime(event.end)}.` +
            (event.attendees?.length ? ` Attendees: ${event.attendees.map(a => a.email).join(", ")}.` : "") +
            ` Send updates: ${action.sendUpdates}.`,
        implementsRevert: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }

  async updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!eventId.trim()) throw new Error("eventId is required.");
    if (Object.keys(patch).length === 0) throw new Error("patch must change at least one field.");
    if (patch.start !== undefined || patch.end !== undefined) {
      // Validate the resulting start/end pair. If only one side is patched, fetch the event to
      // get the other side.
      let start = patch.start;
      let end = patch.end;
      if (start === undefined || end === undefined) {
        let current = await this.#api.getEvent(this.#calendarId, eventId);
        start ??= current.start;
        end ??= current.end;
      }
      validateEventTimes(start, end);
    }
    let action: GoogleCalendarAction = {
      type: "updateEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      eventId,
      patch,
    };
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `Update calendar event ${eventId}`,
        description:
            `Update event ${eventId} on calendar ${this.#calendarId}: ` +
            `${summarizeCalendarPatch(patch)}. ` +
            `Send updates: ${action.sendUpdates}.`,
        implementsRevert: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }
}

// =======================================================================================
// BigQuery Gatekeeper
// =======================================================================================
//
// Scope enforcement: when a session is scoped to a project/dataset/table, every query is
// dry-run first (via `BigQueryApi.dryRun`) and rejected if it references tables outside the
// scope. The dry-run also gives us the bytesProcessed estimate, which we cross-check against
// `maximumBytesBilled` before actually executing — defense in depth, since BigQuery will also
// enforce maximumBytesBilled server-side.

/** One BigQuery dataset, the unit at which observer access is tracked. */
type BigQueryDatasetRef = { projectId: string; datasetId: string };

type BigQueryGatekeeperImplProps = {
  userObjectId: string;
  // When set, narrows the session's authority. Project is required for any narrower scope.
  scopedProjectId?: string;
  scopedDatasetId?: string;
  scopedTableId?: string;
};

@validateRpc()
export class BigQueryGatekeeperImpl
    extends DurableObject<Env, BigQueryGatekeeperImplProps>
    implements Gatekeeper<BigQuerySession> {
  #tokens = new AccessTokenCache(opts => {
      let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let { scopedProjectId: p, scopedDatasetId: d, scopedTableId: t } = this.ctx.props;
    let path = p ? (d ? (t ? `/${p}/${d}/${t}` : `/${p}/${d}`) : `/${p}`) : "";
    let label = t ? `${p}.${d}.${t}` : d ? `${p}.${d}` : p ?? null;
    return {
      url: `https://${BIGQUERY_HOST}${path}`,
      title: label ? `BigQuery (${label})` : "BigQuery",
      snippet: t
          ? `Query BigQuery table "${p}.${d}.${t}" (read-only)`
          : d
              ? `Query BigQuery dataset "${p}.${d}" (read-only)`
              : p
                  ? `Query BigQuery datasets in project "${p}" (read-only)`
                  : "Browse BigQuery projects and datasets (read-only)",
      suggestedBindingName: "BIGQUERY",
      tsType: "BigQuerySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return BIGQUERY_TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BigQuerySession> {
    let api = new BigQueryApi(opts => this.#getAccessToken(opts));
    return new BigQuerySessionImpl(
      api,
      approvalQueue.dup(),
      this.ctx.props.scopedProjectId,
      this.ctx.props.scopedDatasetId,
      this.ctx.props.scopedTableId,
      datasets => this.#observers.prepareObservation(datasets),
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("BigQuery gatekeeper has no writable actions to revert");
  }

  // -------------------------------------------------------------------------
  // Observer tracking — strategy C, by dataset. Even a project- or table-scoped binding is tracked
  // at dataset granularity: users may have IAM access to different datasets, so we record which
  // datasets' data the gadget has actually read and verify each observer against them.

  get #observers(): ObserverTracker<BigQueryDatasetRef, Fetcher<GoogleVerifierApi>> {
    return new ObserverTracker(this.ctx.storage.kv, {
      setPrefix: "observedDataset:",
      // "/" cannot appear in either id, so it is an unambiguous separator.
      encode: ({ projectId, datasetId }) => `${projectId}/${datasetId}`,
      decode: encoded => {
        let slash = encoded.indexOf("/");
        return { projectId: encoded.slice(0, slash), datasetId: encoded.slice(slash + 1) };
      },
      hasAccess: (verifier, { projectId, datasetId }) =>
        verifier.hasDatasetAccess(projectId, datasetId),
      deniedMessage: ({ projectId, datasetId }) =>
        "This collaborator does not have access to the BigQuery dataset " +
        `\`${projectId}.${datasetId}\`, whose data this workspace has read, so they cannot be ` +
        "allowed to observe it.",
    });
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user as unknown as Fetcher<GoogleVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observers.removeObserver(id);
  }
}

@validateRpc()
class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;
  // Records the datasets an observation reveals and returns observers to exclude.
  #observe: (datasets: BigQueryDatasetRef[]) => Promise<ObserverCheck<BigQueryDatasetRef>>;

  constructor(
    api: BigQueryApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    scopedProjectId: string | undefined,
    scopedDatasetId: string | undefined,
    scopedTableId: string | undefined,
    observe: (datasets: BigQueryDatasetRef[]) => Promise<ObserverCheck<BigQueryDatasetRef>>,
  ) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#scopedProjectId = scopedProjectId;
    this.#scopedDatasetId = scopedDatasetId;
    this.#scopedTableId = scopedTableId;
    this.#observe = observe;
  }

  // Authorize an observation that reveals data belonging to specific dataset(s), tracking them and
  // excluding observers who lack access to a newly-seen one. Use for every read that exposes dataset
  // data; pass an empty `datasets` for reads that reveal none (e.g. echoing the scoped project id).
  async #authorizeDatasets(
    datasets: { projectId: string; datasetId: string }[],
    description: ObservationDescription,
  ): Promise<void> {
    let check = datasets.length > 0 ? await this.#observe(datasets) : {pendingSets: [], commit() {}};
    await this.#approvalQueue.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  // The unique datasets referenced by a dry-run's `referencedTables` (format "project.dataset.table",
  // matching #checkScopedTables's parsing).
  static #datasetsFromReferencedTables(referenced: string[]): { projectId: string; datasetId: string }[] {
    let out: { projectId: string; datasetId: string }[] = [];
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length === 3) out.push({ projectId: parts[0], datasetId: parts[1] });
    }
    return out;
  }

  // --- helpers -----------------------------------------------------------

  // Pick the project to bill the query against. When scoped, the scoped project is used and
  // the caller cannot override. When unscoped, the caller must declare a default project via
  // `defaultDataset.projectId` (BigQuery requires a billing project on every query).
  #billingProject(): string {
    if (this.#scopedProjectId) return this.#scopedProjectId;
    throw new Error(
      "This session is not scoped to a project. Connect to a specific BigQuery project " +
      "(e.g. https://bigquery.googleapis.com/my-project) to run queries.");
  }

  #effectiveDataset(opts: { defaultDataset?: string } | undefined): string | undefined {
    if (this.#scopedDatasetId) {
      if (opts?.defaultDataset && opts.defaultDataset !== this.#scopedDatasetId) {
        throw new Error(
          `Cannot override defaultDataset to "${opts.defaultDataset}" — this connection is ` +
          `scoped to "${this.#scopedDatasetId}".`);
      }
      return this.#scopedDatasetId;
    }
    return opts?.defaultDataset;
  }

  // Note: callers can still probe whether out-of-scope tables exist by attempting queries
  // and observing which error class fires (out-of-scope vs. not-found vs. DML-rejected).
  // The data is protected; the namespace is partly leaky.
  #checkScopedTables(referenced: string[]): void {
    if (!this.#scopedProjectId) throw new Error("BigQuery queries require a project-scoped binding.");
    // Empty referencedTables is fine for project-only scope (e.g. `SELECT 1`,
    // `SELECT CURRENT_TIMESTAMP()`) — there are no tables to scope-check. Only require
    // at least one referenced table when the binding narrows to a specific dataset or
    // table, since otherwise there's nothing to verify the scope against.
    if (referenced.length === 0) {
      if (this.#scopedDatasetId || this.#scopedTableId) {
        throw new Error(
          "BigQuery dry run did not report any referenced tables; refusing to execute because " +
          "resource scope cannot be verified.");
      }
      return;
    }
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length !== 3) {
        throw new Error(`Could not parse referenced table "${ref}".`);
      }
      let [proj, ds, tbl] = parts;
      if (proj !== this.#scopedProjectId) {
        throw new Error(
          `Query references project "${proj}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}".`);
      }
      if (this.#scopedDatasetId && ds !== this.#scopedDatasetId) {
        throw new Error(
          `Query references dataset "${proj}.${ds}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}".`);
      }
      if (this.#scopedTableId && tbl !== this.#scopedTableId) {
        throw new Error(
          `Query references table "${ref}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}.${this.#scopedTableId}".`);
      }
    }
  }

  #assertReadOnlyEstimate(estimate: {
    statementType?: string;
    ddlOperationPerformed?: string;
    hasScript: boolean;
    hasDmlStats: boolean;
    referencedRoutines?: string[];
  }): void {
    if (estimate.hasScript || estimate.statementType === "SCRIPT") {
      throw new Error("Only single-statement read-only SELECT queries are allowed.");
    }
    if (estimate.ddlOperationPerformed) {
      throw new Error("DDL statements are not allowed.");
    }
    if (estimate.hasDmlStats) {
      throw new Error("DML statements are not allowed.");
    }
    // Allowlist (fail-closed): require an explicit SELECT statementType. BigQuery's dry-run
    // doesn't always populate statementType for every form, so a missing value should be
    // treated as "unknown" and rejected — not assumed safe just because the explicit DDL/DML
    // guards above didn't trip.
    if (!estimate.statementType) {
      throw new Error(
        "BigQuery dry run did not report a statement type; refusing to execute.");
    }
    if (estimate.statementType !== "SELECT") {
      throw new Error(
        `Only read-only SELECT queries are allowed (got ${estimate.statementType}).`);
    }
    if (estimate.referencedRoutines && estimate.referencedRoutines.length > 0) {
      throw new Error(
        "Queries that reference routines are not allowed because their data access cannot " +
        "be scoped by referencedTables.");
    }
  }

  // --- API ---------------------------------------------------------------

  async query(sql: string, opts?: BigQueryQueryOptions): Promise<BigQueryQueryResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);
    let maxBytes = opts?.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED;

    // Always dry-run first to enforce scope and get a cost estimate. Dry-runs are free
    // (BigQuery doesn't bill for them), and the response includes `referencedTables`
    // parsed by Google's own SQL engine — the only reliable way to check scope on
    // arbitrary SQL.
    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);
    if (estimate.bytesProcessed > maxBytes) {
      throw new Error(
        `Query would process ${(estimate.bytesProcessed / 1e9).toFixed(2)} GB, exceeding the ` +
        `limit of ${(maxBytes / 1e9).toFixed(2)} GB. Pass a higher \`maximumBytesBilled\` to ` +
        `override.`);
    }

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery query: ${preview}`,
      description:
        `SQL preview: \`${preview}\`${sql.length > preview.length ? "..." : ""}\n` +
        (defaultDataset ? `Default dataset: \`${defaultDataset}\`\n` : "") +
        `Billing project: \`${billingProject}\`\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ")}\n` +
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Maximum bytes billed: ${maxBytes.toLocaleString()}.`,
      prohibitAllSharing: true,
    });

    let result = await this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset,
      maximumBytesBilled: maxBytes,
    });

    return result;
  }

  async dryRun(
    sql: string,
    opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">,
  ): Promise<BigQueryDryRunResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);

    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery dry run: ${preview}`,
      description:
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ") || "(none)"}`,
      prohibitAllSharing: true,
    });

    return estimate;
  }

  async getProject(): Promise<BigQueryProject> {
    let result: BigQueryProject = { projectId: this.#scopedProjectId! };
    // Echoes the project id the Gadget was bound to — reveals no dataset data, so no attribution.
    await this.#authorizeDatasets([], {
      title: "Get BigQuery project",
      description: `Returned the scoped project: \`${this.#scopedProjectId}\`.`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async listDatasets(projectId?: string): Promise<BigQueryDataset[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list datasets in "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    if (!p) {
      throw new Error("listDatasets requires a projectId when the session is unscoped.");
    }

    if (this.#scopedDatasetId) {
      let dataset = await this.#api.getDataset(p, this.#scopedDatasetId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: this.#scopedDatasetId }], {
        title: `List datasets in ${p}`,
        description: `Returned scoped dataset \`${p}.${this.#scopedDatasetId}\` (1 dataset).`,
        prohibitAllSharing: true,
      });
      return [dataset];
    }

    let result = await this.#api.listDatasets(p);
    // Listing reveals each dataset's existence/name, so attribute to all of them.
    await this.#authorizeDatasets(result.map(ds => ({ projectId: p, datasetId: ds.datasetId })), {
      title: `List datasets in ${p}`,
      description: `Listed ${result.length} dataset(s) in \`${p}\`.`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async listTables(datasetId?: string, projectId?: string): Promise<BigQueryTable[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list tables in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot list tables in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    if (!p) throw new Error("listTables requires a projectId when the session is unscoped.");
    if (!d) throw new Error("listTables requires a datasetId when the session is unscoped.");

    if (this.#scopedTableId) {
      let { table } = await this.#api.getTable(p, d, this.#scopedTableId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
        title: `List tables in ${p}.${d}`,
        description: `Returned scoped table \`${p}.${d}.${this.#scopedTableId}\` (1 table).`,
        prohibitAllSharing: true,
      });
      return [table];
    }

    let result = await this.#api.listTables(p, d);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `List tables in ${p}.${d}`,
      description: `Listed ${result.length} table(s) in \`${p}.${d}\`.`,
      prohibitAllSharing: true,
    });
    return result;
  }

  async describeTable(
    tableId?: string,
    datasetId?: string,
    projectId?: string,
  ): Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot describe table in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot describe table in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    if (this.#scopedTableId && tableId && tableId !== this.#scopedTableId) {
      throw new Error(
        `Cannot describe table "${tableId}" — this connection is scoped to ` +
        `"${this.#scopedTableId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    let t = this.#scopedTableId ?? tableId;
    if (!p) throw new Error("describeTable requires a projectId when the session is unscoped.");
    if (!d) throw new Error("describeTable requires a datasetId when the session is unscoped.");
    if (!t) throw new Error("describeTable requires a tableId when the session is unscoped.");

    let result = await this.#api.getTable(p, d, t);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `Describe ${p}.${d}.${t}`,
      description:
        `Described table \`${p}.${d}.${t}\` (${result.schema.length} columns).`,
      prohibitAllSharing: true,
    });
    return result;
  }
}
