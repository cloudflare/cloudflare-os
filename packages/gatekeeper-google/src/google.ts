import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor, ActionKind, GitCache } from '@gadgets/workshop-shared/gatekeeper';
import {
  PreviewOAuth,
  PreviewOAuthConfigurationError,
  type PreviewOAuthState,
} from "@gadgets/gatekeeper-kit/preview-oauth";
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleVerifiedEmail, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import { GoogleDocSession, DocMetadata, type GoogleDocReadSession } from "./docs-types";
import { GoogleDocsApi, type GoogleDocsDocument } from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import type {
  GoogleSpreadsheetReadSession, GoogleSpreadsheetSession, SpreadsheetInfo, SpreadsheetRange,
  SpreadsheetValueMode,
} from "./sheets-types";
import { docToMarkdown, markdownToDocRequests, computeReplaceOperations, DocSnapshot } from "./markdown-converter";
import { DriveApi } from "./drive-api";
import { driveObserverTracker } from "./drive-observers";
import {
  DriveSessionCore, GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, type DriveBindingScope,
  type DriveSessionCoreOptions,
} from "./drive-session";
import type { DriveEntry, DriveListOptions, DriveSearchQuery, GoogleDriveSession } from "./drive-types";
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
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";
import DRIVE_TYPES_CODE from "./drive-types.txt";
import {
  BigQueryConfiguratorUI,
  CalendarConfiguratorUI,
  GmailConfiguratorUI,
  GoogleDocConfiguratorUI,
  GoogleSheetsConfiguratorUI,
  DriveAccountConfiguratorUI,
  DriveFileConfiguratorUI,
  SharedDriveConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import GOOGLE_DOC_CONFIGURATOR_HTML from "./generated/google-doc-configurator-ui.txt";
import GOOGLE_SHEETS_CONFIGURATOR_HTML from "./generated/google-sheets-configurator-ui.txt";
import DRIVE_ACCOUNT_CONFIGURATOR_HTML from "./generated/drive-account-configurator-ui.txt";
import DRIVE_FILE_CONFIGURATOR_HTML from "./generated/drive-file-configurator-ui.txt";
import SHARED_DRIVE_CONFIGURATOR_HTML from "./generated/shared-drive-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest, ACCESS_TOKEN_EXPIRY_SAFETY_MS } from "./auth-retry";
import {
  BIGQUERY_HOST, BIGQUERY_RESOURCE, GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE,
  GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE, GOOGLE_DRIVE_RESOURCE,
  GOOGLE_SHARED_DRIVE_RESOURCE, GOOGLE_SHEETS_RESOURCE, RESOURCE_BY_KIND, SUPPORTED_RESOURCES,
  grantedResourceUrlPatterns, hasDriveResourceGrant, parseResourceUrl,
  recordedResourceUrlPatterns, type RecordedResourceGrant,
} from "./resources";
import {
  beginStoredOAuthFlow, claimStoredOAuthFlow, mergeGrantedResources, prepareOAuthFlow,
  shouldDeleteCredentialsOnAlarm, type OAuthFlowMode,
} from "./oauth-flow";
import { type ObserverBatchResult, type ObserverCheck, ObserverTracker } from "./observers";
import type {Pager} from "./cursor";
import {
  getBasePath,
  getBaseUrl,
  getGoogleOAuthCallbackUri,
  type GoogleOAuthEnv,
} from "./oauth";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "./type-bundle";

let googleDocTypesCode: string | undefined;
let driveAgentTypesCode: string | undefined;
let googleDriveTypesCode: string | undefined;

function getGoogleDocTypesCode(): string {
  return googleDocTypesCode ??= [
    DOCS_READ_TYPES_CODE,
    stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

function getDriveAgentTypesCode(): string {
  return driveAgentTypesCode ??= stripTypeModulePrefix(
    DRIVE_TYPES_CODE, DRIVE_TYPES_MODULE_PREFIX,
  );
}

function getGoogleDriveTypesCode(): string {
  return googleDriveTypesCode ??= [
    DOCS_READ_TYPES_CODE, SHEETS_TYPES_CODE, getDriveAgentTypesCode(),
  ].join("\n");
}
import type {GmailGatekeeperImplProps} from "./gmail";

export { GmailGatekeeperImpl } from "./gmail";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "google";
const logger = obsContext.createLogger({
  component: "gatekeeper.google", vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;

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


// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & GoogleOAuthEnv & {
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
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
      let previewOAuth: PreviewOAuth;
      try {
        previewOAuth = new PreviewOAuth({
          callbackUri: getGoogleOAuthCallbackUri(env),
          env,
        });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Google OAuth callback is not configured.",
          { status: 503 },
        );
      }
      const begun = await stub.beginOAuthFlow(initiationNonce, previewOAuth.redirectUri);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", previewOAuth.redirectUri);
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      // Add newly-requested scopes to any the user already granted, rather than replacing them.
      newUrl.searchParams.set("include_granted_scopes", "true");
      const encodedState = await previewOAuth.createAuthorizationState({
        userObjectId: doId,
        oauthNonce: begun.oauthNonce,
      });
      newUrl.searchParams.set("state", encodedState);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided", { status: 400 });

      let oauthState: PreviewOAuthState;
      try {
        const previewOAuth = new PreviewOAuth({
          callbackUri: getGoogleOAuthCallbackUri(env),
          env,
        });
        const result = await previewOAuth.handleCallback(url);
        if (result.kind === "relay") {
          return result.response;
        }
        oauthState = result.state;
      } catch (error) {
        const configurationError = error instanceof PreviewOAuthConfigurationError;
        return new Response(error instanceof Error ? error.message : "Invalid Google OAuth state", {
          status: configurationError ? 500 : 400,
        });
      }

      let userObjectId;
      try {
        userObjectId = ctx.exports.UserAccount.idFromString(oauthState.userObjectId);
      } catch {
        return new Response("Error: malformed state", { status: 400 });
      }
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);

      let error = url.searchParams.get("error");
      if (error) {
        if (!await stub.consumeOAuthNonce(oauthState.oauthNonce)) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response("Google authorization was not completed.", { status: 400 });
      }

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      if (!await stub.acceptAuthCode(code, oauthState.oauthNonce)) {
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
      tagline: "Draft replies, edit docs, read sheets, search Drive, manage calendars, and analyze data",
      description:
          "Connect your Google account to give Cloudflare OS access to Gmail, Google Docs, Google " +
          "Sheets, Google Drive, Google Calendar, and BigQuery. Build agents that triage email, " +
          "draft and edit documents, read spreadsheets, search Drive and read native Docs and " +
          "Sheets, find focus time, schedule meetings, or run analytics queries on your data.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let requestedResources = authOnly
        ? []
        : options?.resourceUrlPatterns ?? SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
    let mode: OAuthFlowMode = authOnly ? "auth" : "connect";
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedResources, mode);

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
      TYPES_CODE, getGoogleDocTypesCode(), SHEETS_TYPES_CODE, CALENDAR_TYPES_CODE,
      BIGQUERY_TYPES_CODE, getDriveAgentTypesCode(),
    ].join("\n");
  }
}

/**
 * Serializes operations against each other, so none observes another's mid-flight state.
 *
 * A promise chain rather than `blockConcurrencyWhile`: that would freeze the whole object for the
 * duration of a fetch, and an exception or a 30s overrun inside it resets the Durable Object. Same
 * pattern as the Slack and Supabase gatekeepers.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#tail;
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

export class UserAccount extends DurableObject<Env> {
  // Serialize minting, reconnect, and revoke against each other. Minting is a network round trip, so
  // without this a single invalidated token has every concurrent caller mint its own — a burst
  // against Google's token endpoint that may get rate-limited, turning a recoverable 401 into a hard
  // failure. It also keeps a mint from interleaving with credentials being replaced or wiped.
  #credentials = new Mutex();

  // The last mint that failed permanently — revoked credentials, or a scope an admin has blocked.
  #mintFailure: { error: Error; at: number } | undefined;

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedResources: string[], mode: OAuthFlowMode) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    prepareOAuthFlow(this.ctx.storage.kv, initiationNonce, requestedResources, mode, Date.now());
  }

  /** Prepare a reconnect or scope-expansion attempt for this account. */
  async prepareReconnect(initiationNonce: string, requestedResources: string[]) {
    prepareOAuthFlow(
      this.ctx.storage.kv, initiationNonce, requestedResources, "reconnect", Date.now());
  }

  /**
   * The grantable resource `urlPattern`s currently granted on this account. Used to decide
   * whether ensureResources() needs to expand.
   */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return grantedResourceUrlPatterns(this.#recordedGrant());
  }

  /**
   * The resource `urlPattern`s a reconnect must re-request. Unlike the granted set, this keeps a
   * resource whose scope requirements have grown since it was granted, which is the only way the
   * consent screen can ever repair it.
   */
  async getRequestableResourceUrlPatterns(): Promise<string[]> {
    return recordedResourceUrlPatterns(this.#recordedGrant());
  }

  #recordedGrant(): RecordedResourceGrant {
    let resourceUrlPatterns = this.ctx.storage.kv.get<string[]>("grantedResources");
    let oauthScopes = this.ctx.storage.kv.get<string[]>("grantedScopes");
    return {
      ...(resourceUrlPatterns === undefined ? {} : { resourceUrlPatterns }),
      ...(oauthScopes === undefined ? {} : { oauthScopes }),
    };
  }

  /** Begin the stored consent attempt, or return null when its initiation nonce is invalid. */
  async beginOAuthFlow(initiationNonce: string, oauthRedirectUri: string): Promise<{
    oauthNonce: string,
    scopes: string[],
  } | null> {
    let oauthNonce = generateNonce();
    return beginStoredOAuthFlow(
        this.ctx.storage.kv, initiationNonce, oauthNonce, oauthRedirectUri, Date.now());
  }

  consumeOAuthNonce(oauthNonce: string): boolean {
    return claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }
  /** Returns false if the OAuth nonce is invalid or expired. */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    let flow = claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now());
    if (!flow) return false;

    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    // The credential swap is serialized against minting and revoke, but the callbacks below are
    // not: they are outbound RPCs that can re-enter this object, and awaiting one while holding the
    // mutex would deadlock. So the locked section returns what the notifications need and the
    // notifications happen after it releases.
    let completion = await this.#credentials.run(async () => {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        // Must have timed out.
        throw new Error("Took too long to complete the authorization. Please try again.");
      }

      let response = await exchangeAuthCode(
          code, clientId, clientSecret, flow.oauthRedirectUri,
          AbortSignal.timeout(AUTH_CODE_EXCHANGE_TIMEOUT_MS));

      if (!response.refreshToken) {
        throw new Error("OAuth exchange didn't return refresh token?");
      }

      this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put<string[]>("grantedScopes", response.grantedScopes);
      mergeGrantedResources(this.ctx.storage.kv, flow.requestedResources);
      return { callback, mode: flow.mode };
    });

    let callback = completion.callback;
    if (completion.mode === "reconnect") {
      await callback.credentialsRestored();
    } else {
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }

      if (completion.mode === "auth") {
        this.ctx.storage.kv.put("deleteCredentialsOnAlarm", true);
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      } else {
        this.ctx.storage.deleteAlarm();
      }
    }

    return true;
  }

  /**
   * Whether the stored token still satisfies this request, i.e. can be served without minting.
   *
   * A `staleToken` request comes from a caller that just had a 401. It must not be answered from the
   * expiry check — the whole point is that Google rejected a token that had not yet expired. It is
   * satisfied only if the stored token is no longer the one that failed, which means another caller
   * already replaced it and this caller should take theirs.
   *
   * A `reloadStored` request needs no arm of its own: it asks only to bypass the caller's *own* memo,
   * and the stored token is exactly the answer it wants — which is what makes it mint nothing.
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
    return this.#credentials.run(async () => {
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

  async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#credentials.run(async () => {
      if (shouldDeleteCredentialsOnAlarm(this.ctx.storage.kv)) {
        this.ctx.storage.deleteAll();
      }
    });
  }

  async revoke(): Promise<void> {
    await this.#credentials.run(async () => {
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
      case "driveAccount":
      case "sharedDrive":
      case "driveFile": {
        let scope: DriveBindingScope;
        if (target.kind === "driveAccount") {
          scope = { kind: "account" };
        } else if (target.kind === "sharedDrive") {
          scope = { kind: "sharedDrive", driveId: target.driveId };
        } else {
          scope = { kind: "file", fileId: target.fileId };
        }
        let props: GoogleDriveGatekeeperImplProps = { userObjectId, scope };
        return { class: this.ctx.exports.GoogleDriveGatekeeperImpl({ props }), resource };
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

    if (resourceUrlPattern === GOOGLE_DRIVE_RESOURCE.urlPattern) {
      return {
        iframeHtml: DRIVE_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new DriveAccountConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_SHARED_DRIVE_RESOURCE.urlPattern) {
      return {
        iframeHtml: SHARED_DRIVE_CONFIGURATOR_HTML,
        ui: new RpcStub(new SharedDriveConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_DRIVE_FILE_RESOURCE.urlPattern) {
      return {
        iframeHtml: DRIVE_FILE_CONFIGURATOR_HTML,
        ui: new RpcStub(new DriveFileConfiguratorUI(getToken)),
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
    let requestable = await obj.getRequestableResourceUrlPatterns();
    await obj.prepareReconnect(initiationNonce, requestable);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let granted = new Set(await obj.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) {
      return {};
    }

    // Union the recorded intent, not the covered subset: a resource whose scope requirements grew
    // is missing from `granted`, and asking only for what this call requested would drop it.
    let requestable = await obj.getRequestableResourceUrlPatterns();
    let unionPatterns = [...new Set([...requestable, ...resourceUrlPatterns])];
    let initiationNonce = generateNonce();
    await obj.prepareReconnect(initiationNonce, unionPatterns);
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
  verifyDriveFiles(fileIds: string[]): Promise<ObserverBatchResult>;
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
      await api.getDocumentMetadata(documentId);
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

  async verifyDriveFiles(fileIds: string[]): Promise<ObserverBatchResult> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let granted = await account.getGrantedResourceUrlPatterns();
    let baselineAllowed = hasDriveResourceGrant(granted);
    if (!baselineAllowed) return { baselineAllowed, allowed: fileIds.map(() => false) };

    let api = new DriveApi(opts => this.#getToken(opts));
    return { baselineAllowed, allowed: await api.checkFileAccess(fileIds) };
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

@validateRpc()
class RpcCursor<Entry> extends RpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;
  #owned: Disposable | undefined;

  /**
   * `owned` is disposed with this cursor. A cursor authorizes every page it discloses, so it needs
   * an approval-queue stub that lives as long as it does rather than its session's, which the
   * cursor's owner may dispose first.
   *
   * Optional because a Gmail cursor has nothing to outlive: that session never disposes its own
   * stub (see the TODO on GmailSessionImpl).
   */
  constructor(pager: Pager<Entry>, owned?: Disposable) {
    super();
    this.#pager = pager;
    this.#owned = owned;
  }

  [Symbol.dispose](): void {
    this.#owned?.[Symbol.dispose]();
  }

  // `next()` takes no arguments, so there is no argument surface to validate.
  @skipRpcValidation()
  next(): Promise<Entry[] | null> {
    return this.#pager.next();
  }
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  documentId: string;
  submittedAt: number;
  baseRevisionId: string;
  writeId?: string;
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

const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** The last document read, replayed for 10s. Pending actions overlay it, so it outlives none. */
const DOC_SNAPSHOT_KEY = "docSnapshot";
/** Name prefix of the named range that marks one Gadgets write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";

type GoogleDocWriteReceipt = { actionId: number; markerId: string };

/** The document revision this binding has already reported, and when it first saw it. */
type GoogleDocMetadataRevision = { revisionId: string; observedAt: number };
type GoogleDocNamedRange = { id: string; name: string };

function googleDocNamedRanges(document: GoogleDocsDocument): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries(
    document.namedRanges as Record<string, unknown>,
  )) {
    if (!collection || typeof collection !== "object") {
      throw new Error("Google Docs returned invalid named ranges");
    }
    let ranges = (collection as { namedRanges?: unknown }).namedRanges;
    if (!Array.isArray(ranges)) {
      throw new Error("Google Docs returned invalid named ranges");
    }
    for (const range of ranges) {
      if (!range || typeof range !== "object") {
        throw new Error("Google Docs returned an invalid named range");
      }
      let {namedRangeId, name} = range as { namedRangeId?: unknown; name?: unknown };
      if (typeof namedRangeId !== "string" || namedRangeId.length === 0 ||
          (name !== undefined && typeof name !== "string")) {
        throw new Error("Google Docs returned an invalid named range");
      }
      result.push({ id: namedRangeId, name: name ?? fallbackName });
    }
  }
  return result;
}

function googleDocNamedRangeIds(document: GoogleDocsDocument, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(document)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/**
 * The write IDs whose content `document` already contains.
 *
 * A marker and its content go up in one atomic batch, so a marker naming a write ID proves that
 * write committed — including the case where its response was lost and its action is still
 * pending. Simulating such an action over this document would show its content twice.
 */
function googleDocCommittedWriteIds(document: GoogleDocsDocument): string[] {
  let writeIds = new Set<string>();
  for (let range of googleDocNamedRanges(document)) {
    if (range.name.startsWith(WRITE_MARKER_PREFIX)) {
      writeIds.add(range.name.slice(WRITE_MARKER_PREFIX.length));
    }
  }
  return [...writeIds];
}

/** Markdown snapshot of `document`, tagged with the writes it already contains. */
function googleDocSnapshot(document: GoogleDocsDocument): DocSnapshot {
  return {
    ...docToMarkdown(document),
    committedWriteIds: googleDocCommittedWriteIds(document),
  };
}

function parseGoogleDocWriteReceipt(value: unknown): GoogleDocWriteReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  let { actionId, markerId } = value as { actionId?: unknown; markerId?: unknown };
  if (typeof actionId !== "number" || !Number.isSafeInteger(actionId) || actionId < 1 ||
      typeof markerId !== "string" || markerId.length === 0) {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  return { actionId, markerId };
}

type GoogleDocPendingAction = { id: number; action: GoogleDocAction };

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

  // Serialize applying and rejecting actions against each other. Every network await below leaves
  // the Durable Object's input gate open, and one action id can arrive twice — the overseer marks a
  // record approved only after applyAction() returns, so two approvals of it both see it pending.
  // Interleaved, both fetch the document and the loser writes content the winner already committed;
  // the write marker is no defence, since the winner's cleanup deletes it before the loser looks.
  #actions = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return stub.getAccessToken(opts);
  });

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  #readDocWriteReceipt(): GoogleDocWriteReceipt | undefined {
    return parseGoogleDocWriteReceipt(this.ctx.storage.kv.get<unknown>(DOC_WRITE_RECEIPT_KEY));
  }

  #clearDocWriteReceipt(markerId: string): void {
    if (this.#readDocWriteReceipt()?.markerId === markerId) {
      this.ctx.storage.kv.delete(DOC_WRITE_RECEIPT_KEY);
    }
  }

  async #reconcileDocWriteReceipt(
    api: GoogleDocsApi,
    document: GoogleDocsDocument,
  ): Promise<GoogleDocsDocument> {
    let receipt = this.#readDocWriteReceipt();
    if (!receipt) return document;

    let markerExists = googleDocNamedRanges(document).some(
      ({ id }) => id === receipt.markerId,
    );
    if (!markerExists) {
      this.#clearDocWriteReceipt(receipt.markerId);
      return document;
    }

    await api.deleteNamedRange(this.ctx.props.documentId, receipt.markerId);
    this.#clearDocWriteReceipt(receipt.markerId);
    return api.getDocument(this.ctx.props.documentId);
  }

  /**
   * Hands one proven write from its pending action to a cleanup receipt, atomically.
   *
   * The cached snapshot goes with it. That snapshot predates this write, and once the action stops
   * being pending nothing overlays it, so a read interleaving with the cleanup below would report
   * content older than what is already committed.
   */
  #handoffDocWriteReceipt(
    actionId: number,
    markerId: string,
    pendingActions: PendingActionStore<GoogleDocAction>,
  ): void {
    this.ctx.storage.transactionSync(() => {
      let existing = this.#readDocWriteReceipt();
      if (existing && existing.markerId !== markerId) {
        throw new Error("A different Google Doc write receipt is already pending cleanup");
      }
      this.ctx.storage.kv.put(DOC_WRITE_RECEIPT_KEY, { actionId, markerId });
      this.ctx.storage.kv.delete(DOC_SNAPSHOT_KEY);
      pendingActions.remove(actionId);
    });
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocumentMetadata(this.ctx.props.documentId);
    return {
      url: `https://docs.google.com/document/d/${this.ctx.props.documentId}/edit`,
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDocTypesCode();
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

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#actions.run(() => this.#applyAction(actionId));
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    return this.#actions.run(() => this.#rejectAction(actionId));
  }

  async #applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let action = pending[pendingIndex].action;
    if (action.invalidatedReason) {
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      return;
    }

    let firstPending = pending.find(record => !record.action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    if (!action.writeId) {
      action.writeId = crypto.randomUUID();
      pendingActions.put(actionId, action);
    }
    let writeMarkerName = googleDocWriteMarkerName(action.writeId);
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(action.documentId);
    doc = await this.#reconcileDocWriteReceipt(api, doc);
    let snapshot = googleDocSnapshot(doc);
    let markerIds = googleDocNamedRangeIds(doc, writeMarkerName);
    if (markerIds.length > 1) {
      throw new Error(`Google Docs returned multiple write markers for action ${actionId}`);
    }
    let [writeMarkerId] = markerIds;
    if (!writeMarkerId) {
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
        await this.ctx.storage.put(DOC_SNAPSHOT_KEY, snapshot);
        invalidateUnreplayableGoogleDocActions(
            pendingActions,
            snapshot.markdown,
            pending.slice(pendingIndex + 1),
            `Pending Google Doc edits could not be replayed after edit ${actionId} was dropped`);
        return;
      }
      if (requests.length > 0) {
        let result = await api.batchUpdate(action.documentId, requests, snapshot.revisionId, {
          name: writeMarkerName,
          rangeStart: snapshot.bodyEndIndex - 1,
        });
        if (!result.writeMarkerId) {
          throw new Error(`Google Docs did not return a write marker for action ${actionId}`);
        }
        writeMarkerId = result.writeMarkerId;
      }
    }
    if (writeMarkerId) {
      this.#handoffDocWriteReceipt(actionId, writeMarkerId, pendingActions);
      try {
        await api.deleteNamedRange(action.documentId, writeMarkerId);
        this.#clearDocWriteReceipt(writeMarkerId);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    } else {
      pendingActions.remove(actionId);
    }
    this.#simulationCache.current = undefined;

    try {
      let refreshedSnapshot = snapshot;
      if (writeMarkerId) {
        refreshedSnapshot = googleDocSnapshot(await api.getDocument(action.documentId));
      }
      await this.ctx.storage.put(DOC_SNAPSHOT_KEY, refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot.markdown,
          pending.slice(pendingIndex + 1),
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);
    }
  }

  async #rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);

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
      let cached = await this.#storage.get<DocSnapshot>(DOC_SNAPSHOT_KEY);
      if (cached) {
        let age = Date.now() - cached.fetchedAt;
        if (age < 10_000) {
          return cached;
        }
        // TTL expired — check if document has changed.
        let currentRevisionId = await this.#docsApi.getRevisionId(this.#documentId);
        if (currentRevisionId === cached.revisionId) {
          cached.fetchedAt = Date.now();
          await this.#storage.put(DOC_SNAPSHOT_KEY, cached);
          return cached;
        }
      }
    }

    // Fetch full document and build snapshot.
    let doc = await this.#docsApi.getDocument(this.#documentId);
    let snapshot = googleDocSnapshot(doc);
    await this.#storage.put(DOC_SNAPSHOT_KEY, snapshot);
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

    // An edit whose marker is already in the document committed even though its response never
    // arrived, so this snapshot contains it. Replaying it would show that content twice; the
    // action stays pending, and applyAction() settles it from the same marker.
    let committed = new Set(snapshot.committedWriteIds);
    let replayable = pending.filter(
        ({action}) => action.writeId === undefined || !committed.has(action.writeId));

    let {markdown, pendingActions} = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot.markdown,
        replayable,
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

  /**
   * Current title, and a modification time that only advances when something changed.
   *
   * Google Docs exposes no modification time, so the moment this binding first saw the current
   * revision stands in for it and is reused for as long as that revision holds — reading a
   * document must not make it look freshly edited. Pending edits still move it forward, since
   * `getContent()` already shows them.
   */
  async getMetadata(): Promise<DocMetadata> {
    let metadata = await this.#docsApi.getDocumentMetadata(this.#documentId);
    let revisedAt = this.#observeDocRevision(metadata.revisionId);
    let pendingActions = this.#pendingActions.list()
        .map(({action}) => action)
        .filter(action => !action.invalidatedReason);

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), revisedAt);
    return {
      title: metadata.title,
      lastModified: new Date(lastModified),
    };
  }

  /**
   * When this binding first saw `revisionId`, recording it if the revision is new.
   *
   * An unreadable record is re-observed rather than rejected: it only dates a revision, so the
   * worst a lost record costs is one timestamp that moves when the document did not.
   */
  #observeDocRevision(revisionId: string): number {
    let stored = this.#storage.kv.get<unknown>(DOC_METADATA_REVISION_KEY);
    if (stored && typeof stored === "object") {
      let { revisionId: seen, observedAt } = stored as Partial<GoogleDocMetadataRevision>;
      if (seen === revisionId && typeof observedAt === "number" && Number.isFinite(observedAt)) {
        return observedAt;
      }
    }
    let observedAt = Date.now();
    this.#storage.kv.put<GoogleDocMetadataRevision>(
      DOC_METADATA_REVISION_KEY, { revisionId, observedAt });
    return observedAt;
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
      writeId: crypto.randomUUID(),
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
      writeId: crypto.randomUUID(),
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
// Google Drive Gatekeeper
// =======================================================================================

type GoogleDriveGatekeeperImplProps = {
  userObjectId: string;
  scope: DriveBindingScope;
};

@validateRpc()
export class GoogleDriveGatekeeperImpl
    extends DurableObject<Env, GoogleDriveGatekeeperImplProps>
    implements Gatekeeper<GoogleDriveSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let { scope } = this.ctx.props;
    if (scope.kind === "account") {
      return {
        url: GOOGLE_DRIVE_RESOURCE.urlPattern,
        title: "Google Drive Account",
        snippet: GOOGLE_DRIVE_RESOURCE.description,
        suggestedBindingName: "GOOGLE_DRIVE",
        tsType: "GoogleDriveSession",
      };
    }
    let api = new DriveApi(opts => this.#getAccessToken(opts));
    if (scope.kind === "sharedDrive") {
      let drive = await api.getDrive(scope.driveId);
      return {
        url: `https://drive.google.com/drive/folders/${encodeURIComponent(scope.driveId)}`,
        title: drive.name,
        snippet: `Find files and folders and read native Google Docs and Sheets in organization-owned shared drive "${drive.name}"`,
        suggestedBindingName: "GOOGLE_SHARED_DRIVE",
        tsType: "GoogleDriveSession",
      };
    }
    let file = await api.getFile(scope.fileId);
    return {
      url: `https://drive.google.com/file/d/${encodeURIComponent(scope.fileId)}/view`,
      title: file.name,
      snippet: `Read metadata and, when native, Google Doc or Sheet content from Drive file "${file.name}"`,
      suggestedBindingName: "GOOGLE_DRIVE_FILE",
      tsType: "GoogleDriveReadSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDriveTypesCode();
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleDriveSession> {
    let observerTracker = this.#observerTracker();
    let getDriveAccessToken = (opts?: AccessTokenRequest) => this.#getAccessToken(opts);
    return new GoogleDriveSessionImpl(
      new DriveApi(getDriveAccessToken),
      new GoogleDocsApi(getDriveAccessToken),
      new GoogleSheetsApi(getDriveAccessToken),
      this.ctx.props.scope,
      approvalQueue.dup(),
      fileIds => observerTracker.prepareObservation(fileIds),
      () => [...observerTracker.observers()].map(([id]) => id),
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("Google Drive gatekeeper has no writable actions to revert");
  }

  #observerTracker(): ObserverTracker<string, Fetcher<GoogleVerifierApi>> {
    return driveObserverTracker<Fetcher<GoogleVerifierApi>>(
      this.ctx.storage.kv, this.ctx.props.scope,
      (verifier, fileIds) => verifier.verifyDriveFiles([...fileIds]));
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observerTracker().addObserver(id, user as unknown as Fetcher<GoogleVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observerTracker().removeObserver(id);
  }
}

@validateRpc()
class GoogleDocReadSessionImpl extends RpcTarget implements GoogleDocReadSession {
  #docsApi: GoogleDocsApi;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
    docsApi: GoogleDocsApi,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getMetadata(): Promise<DocMetadata> {
    let file = await this.#driveApi.getFile(this.#documentId);
    let lastModified = new Date(file.modifiedTime ?? "");
    if (Number.isNaN(lastModified.valueOf())) {
      throw new Error("Google Drive returned an invalid modifiedTime");
    }
    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the current title and modification time of the Drive document.",
    });
    return { title: file.name, lastModified };
  }

  async getContent(): Promise<string> {
    let snapshot = docToMarkdown(await this.#docsApi.getDocument(this.#documentId));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc content",
      description: "Read the current document body as Markdown.",
    });
    return snapshot.markdown;
  }
}

/** Drive RPC session implementation, exported for workerd contract coverage. */
@validateRpc()
export class GoogleDriveSessionImpl extends RpcTarget implements GoogleDriveSession {
  #core: DriveSessionCore;
  #coreOptions: Omit<DriveSessionCoreOptions, "authorize">;
  #driveApi: DriveApi;
  #docsApi: GoogleDocsApi;
  #sheetsApi: GoogleSheetsApi;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
    driveApi: DriveApi,
    docsApi: GoogleDocsApi,
    sheetsApi: GoogleSheetsApi,
    scope: DriveBindingScope,
    approvalQueue: RpcStub<ApprovalQueue>,
    prepareObservation: (fileIds: string[]) => Promise<ObserverCheck<string>>,
    observerIds: () => string[],
  ) {
    super();
    this.#driveApi = driveApi;
    this.#docsApi = docsApi;
    this.#sheetsApi = sheetsApi;
    this.#approvalQueue = approvalQueue;
    this.#coreOptions = { api: driveApi, scope, prepareObservation, observerIds };
    this.#core = this.#coreFor(this.#approvalQueue);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  getScope() {
    return this.#core.getScope();
  }

  async list(options?: DriveListOptions): Promise<Cursor<DriveEntry>> {
    return this.#cursor(core => core.list(options));
  }

  async search(query: DriveSearchQuery): Promise<Cursor<DriveEntry>> {
    return this.#cursor(core => core.search(query));
  }

  /**
   * A core with this session's authority, authorizing through `queue`.
   *
   * Scope and observer tracking are identical in every case; only the approval queue differs,
   * which is the whole reason a cursor needs a core of its own.
   */
  #coreFor(queue: RpcStub<ApprovalQueue>): DriveSessionCore {
    return new DriveSessionCore({
      ...this.#coreOptions,
      authorize: description => queue.authorizeObservation(description),
    });
  }

  /**
   * A cursor paging through an approval-queue stub of its own, disposed with the cursor.
   *
   * The caller owns a returned cursor separately from this session and may keep paging it after
   * disposing the session, so a cursor sharing the session's stub would fail mid-pagination.
   */
  async #cursor(
    open: (core: DriveSessionCore) => Promise<Pager<DriveEntry>>,
  ): Promise<Cursor<DriveEntry>> {
    let queue = this.#approvalQueue.dup();
    try {
      return new RpcCursor(await open(this.#coreFor(queue)), queue);
    } catch (error) {
      queue[Symbol.dispose]();
      throw error;
    }
  }

  getEntry(fileId: string): Promise<DriveEntry> {
    return this.#core.getEntry(fileId);
  }

  async openGoogleDoc(fileId: string): Promise<GoogleDocReadSession> {
    let documentId = await this.#core.openNativeFile(
      fileId, GOOGLE_DOC_MIME_TYPE, "Google Doc",
    );
    return new GoogleDocReadSessionImpl(
      this.#docsApi, this.#driveApi, documentId, this.#approvalQueue.dup(),
    );
  }

  async openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession> {
    let spreadsheetId = await this.#core.openNativeFile(
      fileId, GOOGLE_SHEET_MIME_TYPE, "Google Sheet",
    );
    return new GoogleSpreadsheetSessionImpl(
      this.#sheetsApi, spreadsheetId, this.#approvalQueue.dup(),
    );
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
