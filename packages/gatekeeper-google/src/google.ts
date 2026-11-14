import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor, ActionKind, GitCache, workerVersionTag, type ActionDescription, type ConnectHandoff } from '@gadgets/workshop-shared/gatekeeper';
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  PreviewOAuth,
  PreviewOAuthConfigurationError,
  type PreviewOAuthState,
} from "@gadgets/gatekeeper-kit/preview-oauth";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleAccountProfile, getGoogleVerifiedEmail, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import type { GoogleDocEditSession, GoogleDocReadSession } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import { GoogleSlidesApi } from "./slides-api";
import { GoogleApiError } from "./google-response";
import {
  boundProps, createFileOnce, creationAction, isSimulated, newFileTitle, UNCREATED_FILE_ID,
  type SimulatedFileProps,
} from "./creation";
import {
  getGoogleSlidesTypesCode, GooglePresentationReadSessionImpl, GooglePresentationSessionImpl,
  type GoogleSlidesGatekeeperImplProps,
} from "./slides";
import {
  getGoogleSheetsTypesCode, GoogleSpreadsheetReadSessionImpl, GoogleSpreadsheetSessionImpl,
  type GoogleSheetsGatekeeperImplProps,
} from "./sheets";
import type { GooglePresentationReadSession } from "./slides-read-types";
import type { GooglePresentationSession } from "./slides-types";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import SLIDES_TYPES_CODE from "./slides-types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import SHEETS_TYPES_CODE from "./sheets-types.txt";
import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
import type { GoogleSpreadsheetSession } from "./sheets-types";
import SHEETS_READ_TYPES_CODE from "./sheets-read-types.txt";
import {
  DriveApi, DriveApiRequestError, isDriveCommentId, isInsufficientScope, lacksFileContentAccess,
  MAX_BATCH_FILES, type DrivePermissionRecord,
} from "./drive-api";
import {
  DRIVE_ACTIONS, type DriveAction, type DriveActions, type DriveQueue,
} from "./drive-actions";
import {
  DriveFileEditors, editorOfMimeType, editorOfTag, type DriveEditorName,
} from "./drive-editors";
import {
  checkSuggestion, composeComment, composeReply, composeResolve, locateQuote, requireQuote,
  selectTab,
} from "./drive-comment-body";
import {
  ALREADY_RESOLVED, COMMENT_NOT_FOUND, commentParent, hasPendingResolve, overlayPending,
  pendingComment, pendingCommentRefusal, pendingReply, pendingSuggestion, readLiveComment,
  REPLY_RESOLVE_PENDING, RESOLVE_PENDING, toDriveComment, type CommentTargetPayload,
  type DriveCommentActions,
} from "./drive-comments";
import {
  hasPendingMove, MOVE_DESTINATION_WAITING, MOVE_PENDING, MOVE_WAITING,
} from "./drive-moves";
import {
  ACCESS_WAITING_CHANGE, ACCESS_WAITING_REMOVE, CHANGE_PENDING, checkAccessName, checkShare,
  hasPendingChange, hasPendingShare, overlayPendingAccess, pendingAccess, pendingAccessRefusal,
  planShare, planUnshare, planUpdate, readPermissions, SHARE_PENDING, toAccessEntries,
} from "./drive-sharing";
import {
  actorFence, driveAccessCap, isPendingId, proveTarget, readOnlyRefusal, shownFileName, writeAttempts,
  writeRefusal, WRITE_CONNECTION_REFUSED, WRITES_GRANT_MISSING, type DriveActor,
  type DriveWriteTargetPayload, type QueuedWrite,
} from "./drive-writes";
import { CONVERSION_FAILED, pdfToText, type PdfConverter } from "./drive-pdf";
import { downloadableFile, exactRange, fileReadRange, FILE_CHANGED } from "./drive-file-read";
import type { AiFetcher } from "./workers-ai-markdown";
import { driveObserverTracker, type DriveObservation } from "./drive-observers";
import {
  DOCS_SUBRESOURCE_NAMESPACE, DRIVE_SUBRESOURCE_NAMESPACE, parseFileSubresource,
  requireFileSubresources, SHEETS_SUBRESOURCE_NAMESPACE, SLIDES_SUBRESOURCE_NAMESPACE,
  type DriveUnit, type FileSubresource, type NativeFileSubresource,
} from "./file-subresources";
import { outsideScope, readFolderRoot, type FolderLocation } from "./drive-folder-scope";
import {
  DriveFolderSessionCore, DriveSessionCore, GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE, MOVE_INTO_ITSELF, MOVE_SINGLE_FILE, PDF_MIME_TYPE,
  requireDriveBindingScope, type DriveBindingScope, type DriveCore, type DriveWriteTarget,
  type NativeRead,
} from "./drive-session";
import type {
  DocSuggestion, DriveAccess, DriveComment, DriveCommentOptions, DriveCommentReply, DriveEntry,
  DriveFileBytes, DriveFileReadOptions, DriveGrantee, DriveListOptions, DrivePdfText, DriveScope,
  DriveSessionSearchQuery, DriveShareOptions, DriveShareRole,
  DriveSuggestEditOptions, GoogleDriveFolderReadSession, GoogleDriveFolderSession,
  GoogleDriveReadSession, GoogleDriveSession,
} from "./drive-types";
import { ChatApi, ChatApiError } from "./chat-api";
import { verifyGoogleSubresourceAccess, type GoogleVerifierApi } from "./google-verifier-types";
import { BigQueryApi, BigQueryApiError, DEFAULT_MAX_BYTES_BILLED } from "./bigquery-api";
import {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQuerySession, BigQueryTable,
} from "./bigquery-types";
import {
  calendarEventOverlaps, calendarEventSortKey, eventPatchToGoogle, GoogleCalendarApi,
  GoogleCalendarApiError, hasCalendarPrivateAccessRole, MAX_FREE_BUSY_CALENDARS, validateCalendarTimeWindow,
  type LiveCalendarEvent,
} from "./calendar-api";
import {
  CALENDAR_EVENTS_ACTION, CALENDAR_INVITATIONS_ACTION, createEventVerdict, updateEventVerdict,
} from "./calendar-verdict";
import type {
  CalendarAvailabilityMode, CalendarEvent, CalendarEventDraft, CalendarEventPatch,
  CalendarListEventsOptions, CalendarSendUpdates, CalendarTime, GoogleCalendarCapabilities,
  GoogleCalendarInfo, GoogleCalendarSession, PersonAvailability,
} from "./calendar-types";
import TYPES_CODE from "./types.txt";
import CHAT_TYPES_CODE from "./chat-types.txt";
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import DRIVE_READ_TYPES_CODE from "./drive-read-types.txt";
import DRIVE_TYPES_CODE from "./drive-types.txt";
import COMMENT_TYPES_CODE from "./comment-types.txt";
import {
  BigQueryConfiguratorUI,
  CalendarConfiguratorUI,
  ChatAccountConfiguratorUI,
  ChatSpaceConfiguratorUI,
  ChatThreadConfiguratorUI,
  GmailConfiguratorUI,
  DriveConfiguratorUI,
  CreationLocationConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import CHAT_ACCOUNT_CONFIGURATOR_HTML from "./generated/chat-account-configurator-ui.txt";
import CHAT_SPACE_CONFIGURATOR_HTML from "./generated/chat-space-configurator-ui.txt";
import CHAT_THREAD_CONFIGURATOR_HTML from "./generated/chat-thread-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import DRIVE_CONFIGURATOR_HTML from "./generated/drive-configurator-ui.txt";
import CREATION_LOCATION_CONFIGURATOR_HTML from "./generated/creation-location-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest, ACCESS_TOKEN_EXPIRY_SAFETY_MS } from "./auth-retry";
import { Mutex } from "./mutex";
import { PendingActionStore } from "./pending-actions";
import {
  driveDocSource, getGoogleDocTypesCode, GoogleDocEditSessionImpl, GoogleDocReadSessionImpl,
  type GoogleDocGatekeeperImplProps,
} from "./docs";
import { ReadGate } from "./read-gate";
import {
  BIGQUERY_HOST, BIGQUERY_QUERY_PROJECT_PARAM, BIGQUERY_RESOURCE, GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE,
  GOOGLE_CHAT_RESOURCE, GOOGLE_CHAT_SPACE_RESOURCE, GOOGLE_CHAT_THREAD_RESOURCE,
  GOOGLE_DRIVE_RESOURCE,
  RESOURCE_BY_KIND,
  SUPPORTED_RESOURCES, creatableKind, nativeFileUrl,
  DRIVE_WRITES_GRANT, grantedResourceUrlPatterns, hasDriveResourceGrant, isPrivateGrant,
  parseResourceUrl, recordedResourceUrlPatterns, type DriveAccessLevel, type RecordedResourceGrant,
} from "./resources";

import {
  beginStoredOAuthFlow, claimStoredOAuthFlow, mergeGrantedResources, prepareOAuthFlow,
  shouldDeleteCredentialsOnAlarm, type OAuthFlowMode,
} from "./oauth-flow";
import {
  DEFAULT_CONCURRENCY, mapWithConcurrency, type ObserverBatchResult, ObserverTracker,
} from "./observers";
import type {Pager} from "./cursor";
import {
  getBasePath,
  getBaseUrl,
  getGoogleOAuthCallbackUri,
  type GoogleOAuthEnv,
} from "./oauth";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_READ_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX,
  GMAIL_TYPES_MODULE_PREFIX, SHEETS_TYPES_MODULE_PREFIX, SLIDES_TYPES_MODULE_PREFIX,
  stripTypeModulePrefix,
} from "./type-bundle";


export { GoogleDocGatekeeperImpl } from "./docs";

let driveReadAgentTypesCode: string | undefined;
let driveAgentTypesCode: string | undefined;

/** The Drive read declarations, which every Drive binding's bundle holds. */
function getDriveReadAgentTypesCode(): string {
  return driveReadAgentTypesCode ??= stripTypeModulePrefix(
    DRIVE_READ_TYPES_CODE, DRIVE_READ_TYPES_MODULE_PREFIX);
}

/** The Drive write declarations, which only a read and write binding's bundle adds. */
function getDriveAgentTypesCode(): string {
  return driveAgentTypesCode ??= stripTypeModulePrefix(DRIVE_TYPES_CODE, DRIVE_TYPES_MODULE_PREFIX);
}

/**
 * A Drive binding's bundle: the native read types, the comment declarations and the Drive reads,
 * with, for `write`, the editable native sessions and the Drive writes.
 */
function getGoogleDriveTypesCode(write: boolean): string {
  return [
    DOCS_READ_TYPES_CODE, SHEETS_READ_TYPES_CODE, SLIDES_READ_TYPES_CODE, COMMENT_TYPES_CODE,
    getDriveReadAgentTypesCode(),
    ...(write ? [
      stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
      stripTypeModulePrefix(SHEETS_TYPES_CODE, SHEETS_TYPES_MODULE_PREFIX),
      stripTypeModulePrefix(SLIDES_TYPES_CODE, SLIDES_TYPES_MODULE_PREFIX),
      getDriveAgentTypesCode(),
    ] : []),
  ].join("\n");
}

import {
  GMAIL_SUBRESOURCE_NAMESPACE, parseGmailUserSubresource, type GmailGatekeeperImplProps,
} from "./gmail";
import {
  CHAT_SUBRESOURCE_NAMESPACE, parseChatSubresource, type ChatSubresource, type GoogleChatGatekeeperImplProps,
} from "./chat";

export { GmailGatekeeperImpl } from "./gmail";
export { GoogleChatGatekeeperImpl } from "./chat";
export { ChatHookController, ChatHookDriver } from "./chat-hooks";
export { GmailHookController, GmailHookDriver } from "./gmail-hooks";
export { GoogleSheetsGatekeeperImpl } from "./sheets";
export { GoogleSlidesGatekeeperImpl } from "./slides";
import { handlePubSubPush, type PushHooksEnv } from "./pubsub-push";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "google";
const logger = obsContext.createLogger({
  component: "gatekeeper.google", vendorId: VENDOR_ID,
});
const driveLogger = obsContext.createLogger({
  component: "gatekeeper.google.drive", vendorId: VENDOR_ID,
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

// What a token request fails with once an account has no refresh token. Of the accounts a binding
// can name, only one the Workshop disconnected loses it: revoke() deletes all of its storage. The
// connect callback goes with the rest and the Workshop deletes its record, so there is nothing to
// mark expired or reconnect, and connecting Google again creates a new account while the binding's
// props still name this one. Replacing the binding is the only remedy.
const DISCONNECTED_ACCOUNT_MESSAGE =
    "The Google account this connection was made with has been disconnected, so the connection " +
    "no longer works. Connecting Google again does not restore it: remove this connection and " +
    "connect the resource again under the same name.";

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}


// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & GoogleOAuthEnv & PushHooksEnv & {
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  // `write` (the default) or `read`: the most this deployment lets a Drive connection do.
  GOOGLE_DRIVE_ACCESS?: string;
}

// =======================================================================================

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

/** Main HTTP entrypoint: OAuth flows and Pub/Sub pushes from Google. */
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
    } else if (relPath === "/pubsub" && req.method === "POST") {
      return handlePubSubPush(req, env, ctx.exports);
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

      let handoff = await stub.acceptAuthCode(code, oauthState.oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return htmlResponse(connectHandoffPageHtml(handoff));
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
      tagline: "Draft replies, edit docs, sheets and slides, search Drive, manage calendars, post to Chat, and analyze data",
      description:
          "Connect your Google account to give Cloudflare OS access to Gmail, Google Docs, Google " +
          "Sheets, Google Slides, Google Drive, Google Calendar, Google Chat, and BigQuery. Build " +
          "agents that triage email, draft and edit documents, spreadsheets and presentations, " +
          "search Drive and read native Docs and Sheets, find focus time, " +
          "schedule meetings, follow and post to Chat conversations, or run analytics queries on " +
          "your data.",
      providesAuth: true,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
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

  async createResource(resourceUrlPattern: string, title: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    action: ActionDescription;
  }> {
    let kind = creatableKind(resourceUrlPattern);
    let props: SimulatedFileProps = { creation: { title: newFileTitle(title) } };
    let cls: DurableObjectClass<Gatekeeper<any>>;
    switch (kind) {
      case "doc": cls = this.ctx.exports.GoogleDocGatekeeperImpl({props}); break;
      case "sheets": cls = this.ctx.exports.GoogleSheetsGatekeeperImpl({props}); break;
      case "slides": cls = this.ctx.exports.GoogleSlidesGatekeeperImpl({props}); break;
      case "driveFolder": cls = this.ctx.exports.GoogleDriveGatekeeperImpl({props}); break;
    }
    let resource = RESOURCE_BY_KIND[kind];
    return { class: cls, resource, action: creationAction(resource, props.creation.title) };
  }

  async getTypeScriptTypes(): Promise<string> {
    return [
      stripTypeModulePrefix(TYPES_CODE, GMAIL_TYPES_MODULE_PREFIX), getGoogleDocTypesCode(),
      getGoogleSheetsTypesCode(), getGoogleSlidesTypesCode(), CALENDAR_TYPES_CODE,
      BIGQUERY_TYPES_CODE, getDriveReadAgentTypesCode(), getDriveAgentTypesCode(), CHAT_TYPES_CODE,
    ].join("\n");
  }
}

/**
 * A hook driver holding some of an account's hooks, which the account tells to drop them when it
 * is disconnected: Gmail's per mailbox, Chat's per space.
 */
export type HookDriverRef = { kind: "gmail" | "chat"; name: string };

/** What a reconnect flow obtains, held in escrow until commitReconnect() writes it live. */
type StagedGoogleCredentials = {
  refreshToken: string;
  accessToken: GoogleAccessToken;
  grantedScopes: string[];
  requestedResources: string[];
};

// How long an account reuses an answer about its access to a subresource, counted from when it
// started asking Google. Google doesn't tell us when a share changes: a revoked share is noticed
// only once the answer that allowed it expires, while a denial is kept briefly so that a new share
// is noticed soon.
const SUBRESOURCE_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const SUBRESOURCE_ACCESS_DENIED_TTL_MS = 15_000;

/** A subresource whose access a UserAccount checks for itself (see parseAccountSubresource). */
type AccountSubresource =
  | { kind: "calendar" | "freeBusy"; calendarId: string }
  | { kind: "bigQueryDataset"; dataset: BigQueryDatasetRef }
  | { kind: "gmailUser"; subject: string }
  | ChatSubresource
  | FileSubresource;

/**
 * What a subresource a Google gatekeeper asks an account about names: a calendar or its free/busy
 * (see parseCalendarSubresource), a BigQuery dataset, a Gmail mailbox's owner, a Google Chat
 * conversation, its member list or account (see parseChatSubresource), or a Drive file, its content
 * or a folder, or a native Docs, Sheets or Slides file (see parseFileSubresource). Throws for any
 * other ID.
 */
function parseAccountSubresource(subresource: string): AccountSubresource {
  switch (parseSubresourceId(subresource).namespace) {
    case CALENDAR_SUBRESOURCE_NAMESPACE:
      return parseCalendarSubresource(subresource);
    case BIGQUERY_SUBRESOURCE_NAMESPACE:
      return { kind: "bigQueryDataset", dataset: parseBigQueryDatasetSubresource(subresource) };
    case GMAIL_SUBRESOURCE_NAMESPACE:
      return { kind: "gmailUser", subject: parseGmailUserSubresource(subresource) };
    case CHAT_SUBRESOURCE_NAMESPACE:
      return parseChatSubresource(subresource);
    case DRIVE_SUBRESOURCE_NAMESPACE:
    case DOCS_SUBRESOURCE_NAMESPACE:
    case SHEETS_SUBRESOURCE_NAMESPACE:
    case SLIDES_SUBRESOURCE_NAMESPACE:
      return parseFileSubresource(subresource);
    default:
      throw new Error("Not a Google subresource.");
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

  // This account's answers about its own access to subresources, keyed by subresource and
  // partitioned by the credentials that learned them (see #credentialsId), so an answer can't
  // outlive a disconnect that left storage behind, nor survive a reconnect, which may sign in as
  // another Google account. Bypassed while the account holds no credentials.
  #access = new KvTtlCache(this.ctx.storage.kv, () => this.#credentialsId(), { name: "access" });

  // Names the credentials installed now, or undefined while there are none. Every install names
  // its credentials afresh, and revoking deletes the name with everything else, so no load that
  // started under earlier credentials can find the same name when it finishes. Credentials
  // installed before names existed are named on first use.
  #credentialsId(): string | undefined {
    let kv = this.ctx.storage.kv;
    if (!kv.get<string>("refreshToken")) return undefined;
    let id = kv.get<string>("credentialsId");
    if (id === undefined) {
      id = crypto.randomUUID();
      kv.put<string>("credentialsId", id);
    }
    return id;
  }

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
    // Where the deployment keeps Google Drive read-only, no consent asks Google for the scope
    // Drive writes need. The grant stays in the attempt, so it is asked for again once they are
    // allowed.
    let withheld = driveAccessCap(this.env) === "write" ? [] : [DRIVE_WRITES_GRANT];
    return beginStoredOAuthFlow(
        this.ctx.storage.kv, initiationNonce, oauthNonce, oauthRedirectUri, Date.now(), withheld);
  }

  consumeOAuthNonce(oauthNonce: string): boolean {
    return claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }
  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null if the OAuth nonce is invalid or expired.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    let flow = claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now());
    if (!flow) return null;

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

      if (flow.mode === "reconnect") {
        // The reconnect URL is a bearer capability, so the new grant is only staged until the
        // Workshop has confirmed the browser that finished the flow is the owner's (see
        // commitReconnect). Bound gadgets keep reading the current token meanwhile.
        let staged: StagedGoogleCredentials = {
          refreshToken: response.refreshToken, accessToken: response.accessToken,
          grantedScopes: response.grantedScopes, requestedResources: flow.requestedResources,
        };
        let stageId = stageCredentials(this.ctx.storage.kv, staged, Date.now());
        return { callback, mode: flow.mode, stageId };
      }

      this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);
      this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put<string[]>("grantedScopes", response.grantedScopes);
      mergeGrantedResources(this.ctx.storage.kv, flow.requestedResources);
      return { callback, mode: flow.mode, stageId: undefined };
    });

    let callback = completion.callback;
    let handoff: ConnectHandoff;
    if (completion.stageId !== undefined) {
      handoff = await callback.reconnectComplete(completion.stageId);
    } else {
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
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

    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    await this.#credentials.run(async () => {
      let staged = commitStagedCredentials<StagedGoogleCredentials>(
          this.ctx.storage.kv, Date.now(), stageId);
      if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
      this.ctx.storage.kv.put<string>("refreshToken", staged.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", staged.accessToken);
      this.ctx.storage.kv.put<string>("credentialsId", crypto.randomUUID());
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put<string[]>("grantedScopes", staged.grantedScopes);
      mergeGrantedResources(this.ctx.storage.kv, staged.requestedResources);
    });
  }

  /**
   * Whether this account can read each subresource, in order. An allowed answer is reused for up
   * to SUBRESOURCE_ACCESS_ALLOWED_TTL_MS and a denial for up to SUBRESOURCE_ACCESS_DENIED_TTL_MS,
   * until credentials are next installed. Throws for an ID it can't check, or when access can't be
   * determined, which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    let parsed = new Map(subresources.map(subresource =>
        [subresource, parseAccountSubresource(subresource)] as const));
    let getToken = async (opts?: AccessTokenRequest) => (await this.getAccessToken(opts)).token;
    let freeBusy = new Map<string, string>();
    let calendars = new Map<string, string>();
    let datasets = new Map<string, BigQueryDatasetRef>();
    let owners = new Map<string, string>();
    let conversations = new Map<string, { spaceName: string; members: boolean }>();
    let driveUnits = new Map<string, DriveUnit>();
    let nativeFiles = new Map<string, NativeFileSubresource>();
    for (let [subresource, resource] of parsed) {
      if (resource.kind === "bigQueryDataset") datasets.set(subresource, resource.dataset);
      else if (resource.kind === "gmailUser" || resource.kind === "chatUser") {
        owners.set(subresource, resource.subject);
      } else if (resource.kind === "chatSpace" || resource.kind === "chatSpaceMembers") {
        conversations.set(subresource,
          { spaceName: resource.spaceName, members: resource.kind === "chatSpaceMembers" });
      } else if (
        resource.kind === "file" || resource.kind === "folder" || resource.kind === "content"
      ) {
        driveUnits.set(subresource, resource);
      } else if ("calendarId" in resource) {
        (resource.kind === "freeBusy" ? freeBusy : calendars).set(subresource, resource.calendarId);
      } else nativeFiles.set(subresource, resource);
    }
    let api = new GoogleCalendarApi(getToken);
    let ttl = (allowed: boolean) =>
        allowed ? SUBRESOURCE_ACCESS_ALLOWED_TTL_MS : SUBRESOURCE_ACCESS_DENIED_TTL_MS;
    let access = new Map<string, boolean>();
    // Each Google request is cached on its own, so a later failure keeps what earlier ones learned,
    // and the free/busy queries carry only the calendars without a recent answer. One request at a
    // time, so a long list doesn't trip Google's per-user rate limit. A query Google refuses
    // outright (expired credentials, a missing scope, a rate limit) says nothing about the
    // account's access, so it throws rather than reading as a denial.
    let freeBusyIds = [...freeBusy.keys()];
    let freeBusyAnswers = await this.#access.cachedMany(freeBusyIds, ttl, missing =>
        api.hasFreeBusyAccess(missing.map(subresource => freeBusy.get(subresource)!)),
        {batchSize: MAX_FREE_BUSY_CALENDARS});
    freeBusyIds.forEach((subresource, index) => access.set(subresource, freeBusyAnswers[index]));
    for (let [subresource, calendarId] of calendars) {
      access.set(subresource, await this.#access.cached(subresource, ttl,
          () => hasCalendarDetailAccess(api, calendarId)));
    }
    if (datasets.size > 0) {
      let bigQuery = new BigQueryApi(getToken);
      for (let [subresource, dataset] of datasets) {
        access.set(subresource, await this.#access.cached(subresource, ttl,
            () => hasBigQueryDatasetAccess(bigQuery, dataset)));
      }
    }
    if (conversations.size > 0) {
      let chat = new ChatApi(getToken);
      // Chat answers for one space per request, so a few run at a time.
      let entries = [...conversations];
      let answers = await mapWithConcurrency(entries, DEFAULT_CONCURRENCY,
        ([subresource, { spaceName, members }]) =>
          this.#access.cached(subresource, ttl, () => hasChatAccess(chat, spaceName, members)));
      entries.forEach(([subresource], index) => access.set(subresource, answers[index]));
    }
    if (driveUnits.size > 0) {
      // As verifyDriveObservations does, an account without a Drive grant is denied every Drive
      // unit, and Drive is asked about each unit (100 to a batch) only for one with it.
      let drive = new DriveApi(getToken);
      let unitIds = [...driveUnits.keys()];
      let answers = await this.#access.cachedMany(unitIds, ttl, async missing => {
        let units = missing.map(subresource => driveUnits.get(subresource)!);
        return hasDriveResourceGrant(await this.getGrantedResourceUrlPatterns())
          ? drive.checkObservations(units)
          : units.map(() => false);
      }, { batchSize: MAX_BATCH_FILES });
      unitIds.forEach((subresource, index) => access.set(subresource, answers[index]));
    }
    if (nativeFiles.size > 0) {
      // Docs, Sheets and Slides answer for one file per request, so a few run at a time.
      let entries = [...nativeFiles];
      let answers = await mapWithConcurrency(entries, DEFAULT_CONCURRENCY, ([subresource, file]) =>
          this.#access.cached(subresource, ttl, () => hasNativeFileAccess(getToken, file)));
      entries.forEach(([subresource], index) => access.set(subresource, answers[index]));
    }
    if (owners.size > 0) {
      // A mailbox or a Chat account is private to its owner, so only that same Google account can
      // read it.
      let ownerIds = [...owners.keys()];
      let answers = await this.#access.cachedMany(ownerIds, ttl, async missing => {
        let { sub } = await getGoogleAccountProfile(getToken);
        return missing.map(subresource => owners.get(subresource) === sub);
      });
      ownerIds.forEach((subresource, index) => access.set(subresource, answers[index]));
    }
    return subresources.map(subresource => access.get(subresource)!);
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

    // Checked before the cached access token, so a disconnected account serves nothing.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      throw new Error(DISCONNECTED_ACCOUNT_MESSAGE);
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
        throw new Error(DISCONNECTED_ACCOUNT_MESSAGE);
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
        await this.#forgetHooks();
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
      await this.#forgetHooks();
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }

  /**
   * Note that `driver` holds hooks of this account, so that disconnecting it reaches them; false,
   * noting nothing, once the account is disconnected, when no hook of it may be registered.
   */
  async trackHookDriver(driver: HookDriverRef): Promise<boolean> {
    // Serialized with disconnecting, so that a driver is either noted before the account's drivers
    // are told to drop its hooks, or refused once its credentials are gone.
    return await this.#credentials.run(async () => {
      if (!this.ctx.storage.kv.get<string>("refreshToken")) return false;
      this.ctx.storage.kv.put(`hookDriver:${driver.kind}:${driver.name}`, driver);
      return true;
    });
  }

  /**
   * Have every driver holding this account's hooks drop them. Their records are about to go with
   * the credentials, and a driver would otherwise go on reading and renewing for them, failing
   * every time. Best effort: a driver that can't be reached is logged rather than block the
   * disconnect, and drops them itself within a day, when it next asks whether the account knows of
   * it (see trackHookDriver()).
   */
  async #forgetHooks(): Promise<void> {
    const userObjectId = this.ctx.id.toString();
    const results = await Promise.allSettled(
      [...this.ctx.storage.kv.list<HookDriverRef>({ prefix: "hookDriver:" })].map(([, { kind, name }]) =>
        (kind === "gmail" ? this.ctx.exports.GmailHookDriver : this.ctx.exports.ChatHookDriver)
          .getByName(name).forgetAccount(userObjectId)));
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("failed to drop a disconnected account's hooks", {
          event: "hooks.account.forget.failed", error: result.reason,
        });
      }
    }
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

    // A private grant is the gatekeeper's own business, never a resource the Workshop can bind.
    description.grantedResourceUrlPatterns =
      (await grantedResourcesPromise).filter(pattern => !isPrivateGrant(pattern));
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
      case "slides": {
        let props: GoogleSlidesGatekeeperImplProps = {
          userObjectId, presentationId: target.presentationId,
        };
        return {class: this.ctx.exports.GoogleSlidesGatekeeperImpl({props}), resource};
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
          queryProjectId: target.queryProjectId,
        };
        return {class: this.ctx.exports.BigQueryGatekeeperImpl({props}), resource};
      }
      case "chatAccount":
      case "chatSpace":
      case "chatThread": {
        let props: GoogleChatGatekeeperImplProps = {
          userObjectId,
          ...(target.kind !== "chatAccount" ? { spaceId: target.spaceId } : {}),
          ...(target.kind === "chatThread" ? { threadId: target.threadId } : {}),
        };
        return { class: this.ctx.exports.GoogleChatGatekeeperImpl({ props }), resource };
      }
      case "driveAccount":
      case "driveFolder":
      case "driveFile": {
        let scope: DriveBindingScope;
        switch (target.kind) {
          case "driveAccount": scope = { kind: "account" }; break;
          case "driveFolder": scope = { kind: "folder", folderId: target.folderId }; break;
          default: scope = { kind: "file", fileId: target.fileId };
        }
        // A binding's level is fixed in its props, so one this deployment does not allow is refused
        // here and not narrowed: narrowed, it would stay read-only after the setting was lifted.
        if (target.access === "write" && driveAccessCap(this.env) !== "write") {
          throw new Error(WRITE_CONNECTION_REFUSED);
        }
        let props: GoogleDriveGatekeeperImplProps = {
          userObjectId, scope, ...(target.access === "write" ? { access: "write" } : {}),
        };
        return { class: this.ctx.exports.GoogleDriveGatekeeperImpl({ props }), resource };
      }
    }
  }

  /**
   * What a configurator reaches the account through. A grant is read on every call, since a private
   * one arrives through a pop-up while the dialog is open.
   */
  #configuratorAccess() {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return {
      getToken: async (opts?: AccessTokenRequest) => await account.getAccessToken(opts),
      holds: async (grant: string) => (await account.getGrantedResourceUrlPatterns()).includes(grant),
    };
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let { getToken, holds } = this.#configuratorAccess();

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

    if (resourceUrlPattern === GOOGLE_CHAT_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatAccountConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_CHAT_SPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_SPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatSpaceConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_CHAT_THREAD_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_THREAD_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatThreadConfiguratorUI()),
      };
    }

    // One picker for the whole account and every type grouped with it: a folder, a file, or a Docs,
    // Sheets or Slides file.
    let groupedWith = SUPPORTED_RESOURCES
      .find(resource => resource.urlPattern === resourceUrlPattern)?.groupedWith;
    if (resourceUrlPattern === GOOGLE_DRIVE_RESOURCE.urlPattern ||
        groupedWith === GOOGLE_DRIVE_RESOURCE.urlPattern) {
      return {
        iframeHtml: DRIVE_CONFIGURATOR_HTML,
        ui: new RpcStub(
          new DriveConfiguratorUI(getToken, holds, driveAccessCap(this.env) === "write")),
      };
    }

    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  /** Every creatable type is configured by where it is created. */
  async startCreationConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    creatableKind(resourceUrlPattern);
    let { getToken, holds } = this.#configuratorAccess();
    return {
      iframeHtml: CREATION_LOCATION_CONFIGURATOR_HTML,
      ui: new RpcStub(new CreationLocationConfiguratorUI(getToken, holds)),
    };
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

  async commitReconnect(stageId: string): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).commitReconnect(stageId);
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
   * Mint a verifier representing this account, used by the Google gatekeepers' addObserver and
   * verifyObserverAccess to confirm a prospective observer may read a bound resource. The verifier
   * carries this user's own account id, so the access checks run against the observer's *own*
   * Google token.
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
//   - Gmail Mailbox — strategy A (private-only), kernel-checked: every read reports its owner's
//     account as a `gmail/user/<sub>` subresource, which checkSubresourceAccess grants only to that
//     same Google account. addObserver still always throws, for reads made before they reported it.
//   - Google Doc, Sheets and Slides — strategy B (ACL check, single unit), kernel-checked: every
//     read reports the bound file as `docs/document/<documentId>`,
//     `sheets/spreadsheet/<spreadsheetId>` or `slides/presentation/<presentationId>`, which
//     checkSubresourceAccess checks by opening it in that API, as hasDocAccess,
//     hasSpreadsheetAccess and hasPresentationAccess do without reusing answers for addObserver,
//     which still checks the bound file for reads made before they reported it.
//   - Google Drive — strategy C by file, kernel-checked: reads report each file whose metadata they
//     return as `drive/file/<fileId>`, each file whose PDF text or bytes they return as
//     `drive/content/<fileId>`, each folder they list as `drive/folder/<folderId>`, and each native
//     file whose content they read as Docs, Sheets or Slides names it. checkSubresourceAccess
//     checks a file, its content or a folder as verifyDriveObservations does (a Drive grant, then
//     the file visible, downloadable or the folder listable), which addObserver still uses, asking
//     Drive every time, for the bound folder or file and the units recorded before reads reported
//     them.
//   - Google Calendar — strategy B reporting subresources: every read reports the calendar or
//     free/busy it returned, checked by checkSubresourceAccess, where a calendar needs the role
//     hasCalendarWriterAccess also checks for the bound calendar at admission;
//     hasCalendarFreeBusyAccess covers the calendars availability queries recorded before they
//     reported them. The observer's UserAccount answers both, reusing recent answers.
//   - BigQuery — strategy C by dataset, kernel-checked: reads report each dataset whose data they
//     reveal as a `bigquery/project/<projectId>/dataset/<datasetId>` subresource, checked by
//     checkSubresourceAccess like Calendar's. hasDatasetAccess answers, without reusing answers,
//     whether the observer's own token has IAM access to a dataset (see hasBigQueryDatasetAccess),
//     for the datasets addObserver still guards from before reads reported them.
//   - Google Chat — strategies A/B, kernel-checked: reads report each conversation they read as a
//     `chat/space/<spaceId>` subresource, its member list as `chat/spaceMembers/<spaceId>`, and on
//     an account binding the account as `chat/user/<sub>`, which checkSubresourceAccess checks as
//     hasChatSpaceAccess does, or grants only to that same Google account. addObserver still
//     refuses an account binding and checks a conversation or thread binding's conversation through
//     hasChatSpaceAccess, for reads made before they reported subresources.
// The overseer only ever hands this verifier back to a Google gatekeeper, which may therefore trust
// the boolean results. Creation uses it too: getUserObjectId names the account a user approved a
// pending creation into, and applyCreation() creates the file through that account.

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

// Whether the account behind `api` holds a role on the calendar that sees private event details,
// not merely write access (see hasCalendarPrivateAccessRole): false when the calendar isn't on the
// account's list (404), and a throw for any other failure. A refused request (expired
// credentials, a missing scope, a rate limit) says nothing about the account's access.
async function hasCalendarDetailAccess(api: GoogleCalendarApi, calendarId: string): Promise<boolean> {
  try {
    return hasCalendarPrivateAccessRole(await api.getCalendar(calendarId));
  } catch (error) {
    if (httpStatusFromError(error) === 404) return false;
    throw error;
  }
}

/**
 * Whether `api`'s account can open a BigQuery dataset: false when BigQuery denies it (403
 * `accessDenied`, which also hides whether it exists) or doesn't hold it (404), and a throw for any
 * other failure. BigQuery answers other refusals with 403 too (a rate limit, a quota, billing, a
 * missing scope, a disabled API), and those say nothing about the account's access.
 */
async function hasBigQueryDatasetAccess(
    api: BigQueryApi, { projectId, datasetId }: BigQueryDatasetRef): Promise<boolean> {
  try {
    await api.getDataset(projectId, datasetId);
    return true;
  } catch (error) {
    if (error instanceof BigQueryApiError &&
        (error.status === 404 || (error.status === 403 && error.reason === "accessDenied"))) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether `api`'s account can open a Google Chat space, or with `members`, list its members, which
 * a space can restrict to its managers: false when Chat refuses it without giving a reason (403)
 * or doesn't hold it for the account (404), and a throw for any other failure. Chat gives a reason
 * for the refusals that say nothing about the account's access, such as a missing scope or a
 * disabled API.
 */
async function hasChatAccess(api: ChatApi, spaceName: string, members: boolean): Promise<boolean> {
  try {
    if (members) await api.listMembers(spaceName, { pageSize: 1 });
    else await api.getSpace(spaceName);
    return true;
  } catch (error) {
    if (error instanceof ChatApiError &&
        (error.status === 404 || (error.status === 403 && error.reasons.length === 0))) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether the account behind `getToken` can open a native file in the API that reads it (Docs,
 * Sheets or Slides): false when Google refuses it without giving a reason (403) or doesn't hold it
 * for the account (404), and a throw for any other failure. Google gives a reason for the refusals
 * that say nothing about the account's access, such as a missing scope or a disabled API, and a
 * 401 that survives a fresh token means the credentials, not the file.
 */
async function hasNativeFileAccess(
    getToken: (opts?: AccessTokenRequest) => Promise<string>,
    { kind, fileId }: NativeFileSubresource): Promise<boolean> {
  try {
    switch (kind) {
      case "document": await new GoogleDocsApi(getToken).getDocumentMetadata(fileId); break;
      case "spreadsheet": await new GoogleSheetsApi(getToken).getSpreadsheet(fileId); break;
      case "presentation": await new GoogleSlidesApi(getToken).getPresentationTitle(fileId); break;
    }
    return true;
  } catch (error) {
    let status = httpStatusFromError(error);
    if (error instanceof GoogleApiError &&
        (status === 404 || (status === 403 && error.providerReasons.length === 0))) {
      return false;
    }
    throw error;
  }
}

/**
 * The non-standard methods the Google gatekeepers call on their own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 *
 * Declared in its own module so that a gatekeeper living outside this file (Chat) can name it
 * without importing the module that implements it; re-exported here because this is where callers
 * have always found it.
 */
export type { GoogleVerifierApi } from "./google-verifier-types";

@validateRpc()
export class GoogleVerifier extends WorkerEntrypoint<Env, GoogleVerifierProps>
    implements GoogleVerifierApi {
  async #getToken(opts?: AccessTokenRequest): Promise<string> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return (await account.getAccessToken(opts)).token;
  }

  async hasDocAccess(documentId: string): Promise<boolean> {
    return hasNativeFileAccess(
      opts => this.#getToken(opts), { kind: "document", fileId: documentId });
  }

  async hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean> {
    return hasNativeFileAccess(
      opts => this.#getToken(opts), { kind: "spreadsheet", fileId: spreadsheetId });
  }

  async hasPresentationAccess(presentationId: string): Promise<boolean> {
    return hasNativeFileAccess(
      opts => this.#getToken(opts), { kind: "presentation", fileId: presentationId });
  }

  /**
   * Observers need the roles that see private event details, not merely write access; see
   * `hasCalendarDetailAccess` and the observer notes on GoogleCalendarGatekeeperImpl.
   */
  async hasCalendarWriterAccess(calendarId: string): Promise<boolean> {
    return hasCalendarDetailAccess(new GoogleCalendarApi(opts => this.#getToken(opts)), calendarId);
  }

  async hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean> {
    let [access] = await this.checkSubresourceAccess([freeBusySubresourceId(calendarId)]);
    return access;
  }

  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return await account.checkSubresourceAccess(subresources);
  }

  async hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean> {
    return hasBigQueryDatasetAccess(new BigQueryApi(opts => this.#getToken(opts)), { projectId, datasetId });
  }

  async hasChatSpaceAccess(spaceName: string, options: { members?: boolean } = {}): Promise<boolean> {
    let api = new ChatApi(opts => this.#getToken(opts));
    return await hasChatAccess(api, spaceName, false) &&
      (!options.members || await hasChatAccess(api, spaceName, true));
  }

  async verifyDriveObservations(
    observations: DriveObservation[],
  ): Promise<ObserverBatchResult> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let granted = await account.getGrantedResourceUrlPatterns();
    let baselineAllowed = hasDriveResourceGrant(granted);
    if (!baselineAllowed) return { baselineAllowed, allowed: observations.map(() => false) };

    let api = new DriveApi(opts => this.#getToken(opts));
    return {
      baselineAllowed,
      allowed: await api.checkObservations(observations),
    };
  }

  async getUserObjectId(): Promise<string> {
    return this.ctx.props.userObjectId;
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
  /**
   * The verdict it was submitted with. One judged auto-approvable is judged again against the
   * live event when it applies, since guests may have been added in Google meanwhile. Absent on
   * actions stored before verdicts were recorded, which were never auto-approvable.
   */
  autoApprovable?: boolean;
  /**
   * Whether it was submitted as an invitation (`calendar-invitations`) rather than a change to an
   * event nobody else is on. One judged auto-approvable must keep its kind when judged again, since
   * the user may trust one kind and not the other. Absent on actions stored before invitations
   * could be auto-approved, which were never invitations when auto-approvable.
   */
  invitation?: boolean;
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

export type GoogleCalendarGatekeeperImplProps = {
  userObjectId: string;
  calendarId: string;
  availabilityMode: CalendarAvailabilityMode;
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
  opts: Pick<CalendarListEventsOptions, "includeDescriptions">,
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

// The event as it will be once this binding's pending updates to it apply, so a change queued
// behind one that adds guests is judged as reaching them.
function simulatedCalendarEvent(
  event: LiveCalendarEvent,
  pending: {id: number, action: GoogleCalendarAction}[],
): LiveCalendarEvent {
  let simulated = {...event};
  for (let {action} of pending) {
    if (action.type === "updateEvent" && action.eventId === event.id) {
      applyCalendarPatchToEvent(simulated, action.patch, {includeDescriptions: true});
    }
  }
  return simulated;
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

// What Calendar reports as subresources, each something a read returned from Google: a calendar
// (`calendar/calendar/<calendarId>`) for its metadata and its events, which its role on the
// calendar decides who may see, and a calendar's free/busy information
// (`calendar/freeBusy/<calendarId>`), which Google shares separately from, and more widely than,
// its events ("See only free/busy").
const CALENDAR_SUBRESOURCE_NAMESPACE = "calendar";
const CALENDAR_FRAGMENT = "calendar";
const FREE_BUSY_FRAGMENT = "freeBusy";

/** The subresource ID of a calendar. */
function calendarSubresourceId(calendarId: string): string {
  return formatSubresourceId({
    namespace: CALENDAR_SUBRESOURCE_NAMESPACE,
    fragments: [{name: CALENDAR_FRAGMENT, id: calendarId}],
  });
}

/** The subresource ID of a calendar's free/busy information. */
function freeBusySubresourceId(calendarId: string): string {
  return formatSubresourceId({
    namespace: CALENDAR_SUBRESOURCE_NAMESPACE,
    fragments: [{name: FREE_BUSY_FRAGMENT, id: calendarId}],
  });
}

/**
 * The calendar a calendar or free/busy subresource names, and which of the two it is. Throws for
 * any other ID.
 */
function parseCalendarSubresource(subresource: string)
    : {kind: "calendar" | "freeBusy", calendarId: string} {
  let {namespace, fragments} = parseSubresourceId(subresource);
  if (namespace === CALENDAR_SUBRESOURCE_NAMESPACE && fragments.length === 1) {
    let [{name, id}] = fragments;
    if (name === CALENDAR_FRAGMENT) return {kind: "calendar", calendarId: id};
    if (name === FREE_BUSY_FRAGMENT) return {kind: "freeBusy", calendarId: id};
  }
  throw new Error("Not a Google Calendar subresource.");
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
    return [CALENDAR_EVENTS_ACTION, CALENDAR_INVITATIONS_ACTION];
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
    );
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleCalendarAction>(this.ctx.storage.kv);
    let action = pendingActions.get(actionId);
    if (!action) {
      // The overseer records completion only after this returns, so an apply that already ran can
      // be delivered again after a lost reply or a restart; it has nothing left to do.
      if (this.ctx.storage.kv.get(this.#revertKey(actionId)) !== undefined) return;
      throw new Error(`Unknown pending Google Calendar action: ${actionId}`);
    }
    pendingActions.markApplying(actionId);

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
        // Whoever approved it, it was approved as reaching nobody, or as an invitation; with guests
        // added or removed or its visibility narrowed in Google since, applying it would now email
        // people under a kind the user may not trust, or expose the event.
        let changedError = new Error(
          "The event has changed in Google Calendar since this was proposed: who is on it has " +
          "changed, or this change would widen who can see it. This attempt changed nothing. " +
          "Reject this and ask the agent to read the event again.");
        // The write below is conditional on the etag, so an event Google sent without one cannot
        // be updated without a person.
        if (action.autoApprovable && !oldEvent.etag) {
          throw new Error(
            "Google Calendar sent this event without the version tag this change needs to apply " +
            "only to the event as it was checked. This attempt changed nothing. Reject this and " +
            "ask the agent to make the change again.");
        }
        if (action.autoApprovable) {
          let verdict = updateEventVerdict(oldEvent, action.patch);
          let submittedKind = action.invitation ? CALENDAR_INVITATIONS_ACTION : CALENDAR_EVENTS_ACTION;
          if (!verdict.autoApprovable || verdict.actionKind !== submittedKind) throw changedError;
        }
        let previous = priorCalendarPatch(oldEvent, action.patch);
        try {
          // Conditional on the version just judged, so guests added between the read and the
          // write cannot receive it.
          await api.patchEvent(
            action.calendarId, action.eventId,
            eventPatchToGoogle(action.patch), action.sendUpdates,
            action.autoApprovable ? oldEvent.etag : undefined);
        } catch (error) {
          if (error instanceof GoogleCalendarApiError && error.status === 412) throw changedError;
          throw error;
        }
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

  // Observers: every read reports what it returned from Google as subresources, which the
  // Workshop checks through verifyObserverAccess(): the bound calendar for its metadata, each event
  // a listing returns, and the free/busy of each calendar an availability check read. A calendar
  // and its events need a writer or owner role on it, since Google hides private event details
  // from readers; free/busy needs only Google answering for the calendar. addObserver() keeps
  // requiring that role on the bound calendar for the event reads made before reads reported
  // subresources.
  // TODO: Let the binding owner choose whether private events are included. A public-only mode
  // could admit readers instead of requiring writer access from every collaborator.

  // Guards only legacy history: the foreign calendars availability checks recorded before they
  // reported them as subresources, which addObserver() keeps checking. No read records more or
  // forward-checks observers, so none are recorded. The prefix and encoding must match what earlier
  // versions recorded.
  get #observers(): ObserverTracker<string, Fetcher<GoogleVerifierApi>> {
    return new ObserverTracker(this.ctx.storage.kv, {
      setPrefix: "observedAvailabilityCalendar:",
      encode: calendarId => encodeURIComponent(calendarId),
      decode: encoded => decodeURIComponent(encoded),
      hasAccess: (verifier, calendarId) => verifier.hasCalendarFreeBusyAccess(calendarId),
      deniedMessage: calendarId =>
        `This collaborator cannot see free/busy availability for ${calendarId}, whose ` +
        "availability this workspace has read, so they cannot be allowed to observe it.",
      recordObservers: false,
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

  /**
   * Checks the subresources this binding's reads report, each with the observer's own account.
   * Any ID Calendar doesn't report fails the whole call.
   */
  async verifyObserverAccess(
      observers: {id: string, verifier: Fetcher<GatekeeperUserVerifier>}[],
      subresources: string[]): Promise<{allowedObserverIds: string[]}> {
    // Refused here rather than by the account, which also checks other Google gatekeepers'
    // subresources.
    for (let subresource of subresources) parseCalendarSubresource(subresource);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

class GoogleCalendarSessionImpl extends RpcTarget implements GoogleCalendarSession {
  #api: GoogleCalendarApi;
  #calendarId: string;
  #availabilityMode: CalendarAvailabilityMode;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleCalendarAction>;

  constructor(
    api: GoogleCalendarApi,
    calendarId: string,
    availabilityMode: CalendarAvailabilityMode,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleCalendarAction>,
  ) {
    super();
    this.#api = api;
    this.#calendarId = calendarId;
    this.#availabilityMode = availabilityMode;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
  }

  // Every read authorizes through here, which makes `subresources` required: each read must name
  // everything it returned from Google, since addObserver() covers only reads made before they did.
  #authorizeObservation(
      description: ObservationDescription & {subresources: string[]}): Promise<void> {
    return this.#approvalQueue.authorizeObservation(description);
  }

  async getCapabilities(): Promise<GoogleCalendarCapabilities> {
    return {availabilityMode: this.#availabilityMode};
  }

  async getCalendar(): Promise<GoogleCalendarInfo> {
    let calendar = await this.#api.getCalendar(this.#calendarId);
    await this.#authorizeObservation({
      title: "Read Google Calendar metadata",
      description: `Read metadata for Google Calendar ${calendar.summary} (${calendar.id}).`,
      subresources: [calendarSubresourceId(this.#calendarId)],
    });
    return calendar;
  }

  async listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 366);
    let events = await this.#api.listEvents(this.#calendarId, opts);
    let simulated = applyPendingCalendarActions(events, this.#pendingActions.list(), opts);
    // Even an empty window reveals something about the calendar, so every listing reports it.
    let subresources = [calendarSubresourceId(this.#calendarId)];

    await this.#authorizeObservation({
      title: "List Google Calendar events",
      description:
          `List ${simulated.length} event(s) on calendar ${this.#calendarId} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}.` +
          (opts.includeDescriptions ? " Event descriptions are included." : ""),
      subresources,
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
    if (people.includes("primary")) {
      throw new Error(
        "Availability checks must use a stable calendar ID or email address, not the " +
        "account-relative \"primary\" alias.");
    }

    if (this.#availabilityMode === "thisCalendar" && people.some(id => id !== this.#calendarId)) {
      throw new Error(
          "This connection only allows availability for the bound calendar. Reconnect with " +
          "\"All calendars visible to me\" to check other calendars' availability.");
    }

    let availability = await this.#api.freeBusy({...opts, people});
    // The calendars whose free/busy this reveals, bound or not, each once since `people` is
    // deduplicated: not a failed lookup, which returns none.
    let subresources = availability
        .filter(result => !result.error)
        .map(result => freeBusySubresourceId(result.email));

    await this.#authorizeObservation({
      title: "Check Google Calendar availability",
      description:
          `Check free/busy availability for ${summarizePeople(people)} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}. ` +
          "Only busy time blocks are returned; event details are not read.",
      subresources,
    });

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
        // The JSON is the event exactly as it will be created, so the title, times, description,
        // location, attendee names and reminders are all there to read. None of them sits in the
        // prose, where agent text could open Markdown or HTML structure.
        ...buildDescription(
          `Create an event on calendar ${codeSpan(this.#calendarId)}.`)
          .inline("Calendar ID", this.#calendarId)
          .inline("Send updates", action.sendUpdates)
          .json("Event", event)
          .finish(),
        implementsRevert: true,
        ...createEventVerdict(event),
      });
    } catch (error) {
      if (this.#receivedDespite(actionId)) return;
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
    // Read for the verdict, which turns on who is on the event, and for the side of a start/end
    // pair the patch leaves alone.
    let current = await this.#api.getEvent(this.#calendarId, eventId);
    if (patch.start !== undefined || patch.end !== undefined) {
      validateEventTimes(patch.start ?? current.start, patch.end ?? current.end);
    }
    let verdict = updateEventVerdict(
      simulatedCalendarEvent(current, this.#pendingActions.list()), patch);
    let action: GoogleCalendarAction = {
      type: "updateEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      eventId,
      patch,
      autoApprovable: verdict.autoApprovable,
      invitation: verdict.actionKind === CALENDAR_INVITATIONS_ACTION,
    };
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `Update calendar event ${eventId}`,
        ...buildDescription(
          `Update an event on calendar ${codeSpan(this.#calendarId)}.`)
          .inline("Calendar ID", this.#calendarId)
          .inline("Event", eventId)
          .inline("Send updates", action.sendUpdates)
          .json("Changes", patch)
          .finish(),
        implementsRevert: true,
        ...verdict,
      });
    } catch (error) {
      if (this.#receivedDespite(actionId)) return;
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }

  // An auto-approval can apply an action before its submit reply arrives. Its pending record goes
  // only once the overseer has applied or rejected it, and is marked while an apply is under way
  // or has failed, so a lost reply then is no failure: reporting one would invite a repeated write,
  // and dropping the record would take away the retry.
  #receivedDespite(actionId: number): boolean {
    return this.#pendingActions.get(actionId) === undefined || this.#pendingActions.isApplying(actionId);
  }
}

// =======================================================================================
// Google Drive Gatekeeper
// =======================================================================================

/** Said of a write whose earlier send is in doubt while another Google account is connected. */
const SEND_IN_DOUBT_OTHER_ACCOUNT =
  "An earlier attempt at this may already have changed the file, and it was made as another " +
  "Google account than the one connected now, so it can't be checked or finished as this one. " +
  "Reconnect as the account that queued it and approve it again, which first checks the file. " +
  "Or check the file on Google Drive, then reject this to clear it.";

/**
 * Where an exact-file binding keeps which editor its file is, if any, as its describe() last read
 * it: its catalog lists only that editor's kinds, and is answered without asking Google.
 */
const BOUND_FILE_EDITOR_KEY = "driveEditors:boundFile";

/**
 * What a Drive binding names: its owner's account, its scope and its access level, or a folder not
 * created yet.
 */
export type GoogleDriveGatekeeperImplProps = {
  userObjectId: string;
  scope: DriveBindingScope;
  /** `"write"` when the connection was made read and write; absent on a read-only one. */
  access?: DriveAccessLevel;
} | SimulatedFileProps;

@validateRpc()
export class GoogleDriveGatekeeperImpl
    extends DurableObject<Env, GoogleDriveGatekeeperImplProps>
    implements Gatekeeper<GoogleDriveSessionImpl | UncreatedDriveFolderSessionImpl> {
  #creating = new Mutex();
  #tokens = new AccessTokenCache(opts => this.#account().getAccessToken(opts));
  #api = new DriveApi(opts => this.#getAccessToken(opts));
  #journal = new ActionJournal<DriveAction>(this.ctx.storage.kv, { namespace: "drive" });
  #attempts = writeAttempts(this.ctx.storage.kv);
  /**
   * The one token an approval of a sharing change or a move sends everything under, while that
   * approval runs (see applyAction()). Approvals run one at a time, behind #reads.
   */
  #approvalToken: string | undefined;
  /**
   * The Drive client the action handlers use. While an approval's token is set it answers that
   * token to every request, a refresh or a reload asked for after a 401 or a 403 included, so
   * nothing the approval sends after its identity read goes a second time under other credentials. Otherwise it is the connection's own
   * provider, under which a comment is applied.
   */
  #applyApi = new DriveApi(async opts => this.#approvalToken ?? this.#getAccessToken(opts));
  #host = {
    api: this.#applyApi,
    // Comments that quote a Doc and suggested edits are sent through Docs, under the same token.
    docs: new GoogleDocsApi(async opts => this.#approvalToken ?? this.#getAccessToken(opts)),
    scope: () => this.#scope, writeRefusal: () => this.#writeRefusal(),
    attempts: this.#attempts,
    // An edit is not tied to an account, so it is sent under the connection's own token.
    editors: {
      slides: (fileId: string) => ({ api: this.#editApis.slides, presentationId: fileId }),
      sheets: (fileId: string) => this.#editors.sheetsHost(fileId),
      docs: (fileId: string) => this.#editors.docsHost(fileId),
      prove: (editor: DriveEditorName, target: DriveWriteTargetPayload, id: number) =>
        this.#editors.prove(editor, target, id),
    },
  };
  #editApis = {
    slides: new GoogleSlidesApi(opts => this.#getAccessToken(opts)),
    sheets: new GoogleSheetsApi(opts => this.#getAccessToken(opts)),
    docs: new GoogleDocsApi(opts => this.#getAccessToken(opts)),
  };
  #actions = DRIVE_ACTIONS.bind(this.#journal, this.#host);
  #reads = new ReadGate();
  #editors = new DriveFileEditors({
    kv: this.ctx.storage.kv,
    sheets: this.#editApis.sheets,
    docs: this.#editApis.docs,
    drive: this.#api,
    journal: this.#journal,
    submit: (queue, name, payload) =>
      this.#actions.submit(queue, name as keyof DriveActions, payload as never),
    apply: id => this.#actions.apply(id),
    reject: id => this.#actions.reject(id),
    writeRefusal: () => this.#writeRefusal(),
    locate: target => proveTarget(this.#host, target),
  });

  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
  }

  /**
   * Whether the connection may make changes: it was made read and write, and the deployment lets
   * Drive connections write. Anything else is read-only in every respect, a folder not created yet
   * included.
   */
  get #writes(): boolean {
    return !isSimulated(this.ctx.props) && this.ctx.props.access === "write" &&
      driveAccessCap(this.env) === "write";
  }

  /**
   * Whether the account holds the Drive writes grant, read live so a withdrawal counts at once.
   *
   * An account that does not is asked for its token, past this binding's memo of it. A disconnected
   * account records no grant either, and allowing changes cannot restore its connection, so a
   * write on it fails there as every read of the binding does, rather than name that step.
   */
  async #holdsWritesGrant(): Promise<boolean> {
    if ((await this.#account().getGrantedResourceUrlPatterns()).includes(DRIVE_WRITES_GRANT)) {
      return true;
    }
    await this.#getAccessToken({ reloadStored: true });
    return false;
  }

  /** Why this binding cannot make changes now, if it cannot: asked at queue and at apply. */
  #writeRefusal(): Promise<string | undefined> {
    return writeRefusal({
      deployment: driveAccessCap(this.env), access: this.#bound.access, scope: this.#scope,
      holdsGrant: () => this.#holdsWritesGrant(),
    });
  }

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  /** The account, scope and access this binding has, which a folder not yet created has not. */
  get #bound(): { userObjectId: string; scope: DriveBindingScope; access?: DriveAccessLevel } {
    return boundProps(this.ctx.props, "driveFolder");
  }

  /** The Google account `api`'s token is for, asked of Drive. */
  async #identity(api: DriveApi): Promise<DriveActor> {
    try {
      return await api.getAccountIdentity();
    } catch (error) {
      // A token with no Drive scope: the account does not hold the grant, and that is what to say.
      if (isInsufficientScope(error)) throw new Error(WRITES_GRANT_MISSING, { cause: error });
      throw error;
    }
  }

  /**
   * The Google account this connection acts as now, for a call that queues a write. This object
   * keeps the token it last used until that token nears expiry, and a reconnect does not revoke
   * the one before it, so without the reload a connection switched to another Google account
   * would answer as the first for up to a token's lifetime, and a write would be staged under it.
   */
  async #actor(): Promise<DriveActor> {
    // Replaces the kept token with the account's stored one, minting nothing while that is good.
    await this.#getAccessToken({ reloadStored: true });
    return this.#identity(this.#api);
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("driveFolder"),
        title,
        snippet: `Google Drive folder: ${title} (empty; not created yet)`,
        suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
        // Created as a read-only connection, as a resource URL without `?access=write` is.
        tsType: "GoogleDriveFolderReadSession",
      };
    }
    let scope = this.#scope;
    let write = this.#writes;
    // The title is where a connection's level is said to people and to the agent.
    let titled = (title: string) => write ? `${title} (read and write)` : title;
    if (scope.kind === "account") {
      let reads = "find files anywhere this Google account can read in Drive, read native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other file's bytes with readFile()";
      return {
        url: GOOGLE_DRIVE_RESOURCE.urlPattern,
        title: titled("Google Drive Account"),
        snippet: write
          ? `Read and write: ${reads}, queue edits to Google Docs, Sheets and Slides files, read and queue comments, change who files are shared with, and move files`
          : `Read-only: ${reads}, and read comments`,
        suggestedBindingName: "GOOGLE_DRIVE",
        tsType: write ? "GoogleDriveSession" : "GoogleDriveReadSession",
      };
    }
    let api = this.#api;
    if (scope.kind === "folder") {
      // Validated here too, so a hand-built resource URL fails at connect rather than minting a
      // presentable binding whose every call then refuses.
      let folder = await readFolderRoot(scope.folderId, id => api.getFile(id));
      let reads = "list and search direct children, navigate child folders, read native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other file's bytes with readFile()";
      return {
        // The natural browser URL, not the internal `_resource` selector the grant is keyed on.
        url: `https://drive.google.com/drive/folders/${encodeURIComponent(scope.folderId)}`,
        title: titled(folder.name),
        snippet: write
          ? `Read and write: ${reads}, queue edits to Google Docs, Sheets and Slides files among direct children, read and queue comments on direct children, change who they and the folder are shared with, and move them within Drive folder "${folder.name}"`
          : `Read-only: ${reads}, and read comments on direct children in Drive folder "${folder.name}"`,
        suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
        tsType: write ? "GoogleDriveFolderSession" : "GoogleDriveFolderReadSession",
      };
    }
    let file = await api.getFile(scope.fileId);
    let editor: DriveEditorName | null = editorOfMimeType(file.mimeType) ?? null;
    this.ctx.storage.kv.put(BOUND_FILE_EDITOR_KEY, editor);
    return {
      url: `https://drive.google.com/file/d/${encodeURIComponent(scope.fileId)}/view`,
      title: titled(file.name),
      snippet: write
        ? `Read and write: read metadata and, when native, Google Doc, Sheet or Slides content, with readPdf() a PDF's text, or with readFile() the bytes of any other file, from Drive file "${file.name}", queue edits to it when it is a Google Docs, Sheets or Slides file, read and queue comments on it, and change who it is shared with`
        : `Read-only: read metadata and, when native, Google Doc, Sheet or Slides content, with readPdf() a PDF's text, or with readFile() the bytes of any other file, and comments, from Drive file "${file.name}"`,
      suggestedBindingName: "GOOGLE_DRIVE_FILE",
      tsType: write ? "GoogleDriveFileSession" : "GoogleDriveReadSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDriveTypesCode(this.#writes);
  }

  /**
   * A read-only binding submits nothing, so it lists no kind. An exact-file binding lists the
   * kinds of its file's editor alone, once describe() has read which that is.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    if (!this.#writes) return [];
    let kinds = this.#actions.autoApprovableKinds();
    if (this.#scope.kind !== "file") return kinds;
    let bound = this.ctx.storage.kv.get<DriveEditorName | null>(BOUND_FILE_EDITOR_KEY);
    return kinds.filter(({ tag }) => {
      let editor = editorOfTag(tag);
      return editor === undefined || editor === bound;
    });
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleDriveSessionImpl | UncreatedDriveFolderSessionImpl> {
    let props = this.ctx.props;
    if (isSimulated(props)) return new UncreatedDriveFolderSessionImpl(props.creation.title, approvalQueue.dup());
    // Only an undecided or claimed write can be applied again, so no other marker is read again.
    this.#attempts.sweep(new Set(this.#journal.listPending().map(({ id }) => id)));
    this.#editors.sweep();
    let getDriveAccessToken = (opts?: AccessTokenRequest) => this.#getAccessToken(opts);
    // `pnpm dev-server` drops the AI binding unless started with --use-workers-ai-binding.
    // `Ai` declares no `fetch`, but the binding has one; conversion goes through it so it can stream.
    let ai = this.env.AI as unknown as AiFetcher | undefined;
    let gatewayId = this.env.CF_AI_GATEWAY;
    let convertPdf: PdfConverter | undefined = ai && (pdf => pdfToText(ai, gatewayId, pdf));
    let writes: DriveQueue = {
      access: this.#writes ? "write" : "read",
      writeRefusal: () => this.#writeRefusal(),
      actor: () => this.#actor(),
      submit: (queue, kind, payload, fence) =>
        this.#actions.submit(queue, kind, payload, fence ? { fence } : undefined),
      undecided: read => this.#reads.read(() => read(this.#journal.listUndecided())),
      // A claim an approval left behind is taken up by the next one (see #adoptOrphanedClaim()),
      // so it waits as much as an undecided write does. Reads wait behind a running approval, so
      // none sees the claim that approval holds.
      waiting: read => this.#reads.read(() => read(this.#journal.listPending())),
    };
    return new GoogleDriveSessionImpl(
      this.#api,
      new GoogleDocsApi(getDriveAccessToken),
      new GoogleSheetsApi(getDriveAccessToken),
      new GoogleSlidesApi(getDriveAccessToken),
      convertPdf,
      this.#scope,
      approvalQueue.dup(),
      writes,
      // A read-only binding's native sessions have no write method at all.
      this.#writes ? this.#editors : undefined,
    );
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#creating.run(async () => {
      let { userObjectId, fileId, resourceUrl } = await createFileOnce(this.ctx, creator, "driveFolder", configuration);
      let props: GoogleDriveGatekeeperImplProps = { userObjectId, scope: { kind: "folder", folderId: fileId } };
      return { class: this.ctx.exports.GoogleDriveGatekeeperImpl({ props }), resourceUrl };
    });
  }

  /**
   * Applies a write, and then drops its attempt marker. The marker outlives the send it records
   * until the action's record is settled, so that a retry of an apply that ended in between finds
   * it and looks for what that send made.
   */
  applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    // An edit is applied in its file's turn, which a comment's reads need not wait for.
    let edit = this.#editors.apply(actionId);
    if (edit) return edit;
    return this.#reads.resolve(async () => {
      // A sharing change or a move was staged under the Google account that queued it. Only a
      // record still to be applied needs the account asked: the kit answers an applied or failed
      // one from what it stored, and that must not depend on Google answering.
      let record = this.#journal.get(actionId);
      let settled = record === undefined || record.state === "failed" ||
        this.#journal.wasApplied(actionId);
      if (!record?.fence || settled) {
        this.#adoptOrphanedClaim(actionId);
        await this.#actions.apply(actionId);
        this.#attempts.delete(actionId);
        return;
      }
      // Everything this approval asks of Drive after the identity read goes out under the token
      // that read was answered under: the look, the checks and the change. So the account that
      // passes the fence is the one the change is made as, whatever is connected meanwhile, and a
      // request Google refuses is never sent again under other credentials. The read itself starts
      // from the token the account stores now and may refresh it, as a token Google stopped
      // accepting before its recorded expiry needs: the fence then checks whatever answered.
      await this.#getAccessToken({ reloadStored: true });
      try {
        let verified: string | undefined;
        let actor = await this.#identity(
          new DriveApi(async opts => (verified = await this.#getAccessToken(opts))));
        this.#approvalToken = verified;
        if (record.fence.generation !== actor.permissionId &&
            this.#attempts.get(actionId) !== undefined) {
          // The kit would fail it for good and say to submit again. An earlier send may have
          // landed, and the account that can check it may be connected again: leave it as it is.
          driveLogger.warn("a Drive write with a send in doubt met another Google account", {
            event: "drive.apply.account.changed", actionId, actionKind: record.action.kind,
            outcome: "unknown",
          });
          throw new Error(SEND_IN_DOUBT_OTHER_ACCOUNT);
        }
        this.#adoptOrphanedClaim(actionId);
        await this.#actions.apply(actionId, { generation: actor.permissionId });
        this.#attempts.delete(actionId);
      } finally {
        this.#approvalToken = undefined;
      }
    });
  }

  /**
   * Withdraws a write, whatever an earlier send of it did: what that send made stays on the file,
   * and nothing applies the action again, so its attempt marker goes with it.
   */
  rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    let edit = this.#editors.reject(actionId);
    if (edit) return edit;
    return this.#reads.resolve(async () => {
      await this.#actions.reject(actionId);
      this.#attempts.delete(actionId);
    });
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Google Drive changes cannot be reverted automatically.");
  }

  /**
   * Hands a claim an earlier apply left behind back to the action set as undecided, rather than
   * let it be failed as of unknown outcome: the send's attempt marker decides instead. With one,
   * applying looks for what the send made before anything is sent again. Without one, no send of
   * the write is in doubt: none was made, or each one made is known to have changed nothing. A
   * marker is kept until its action is applied or rejected so that this holds. Resolutions run
   * one at a time behind the read gate, so a claim found here is never one this activation holds.
   */
  #adoptOrphanedClaim(actionId: number): void {
    if (this.#journal.get(actionId)?.state === "claimed") this.#journal.restorePending(actionId);
  }

  // Observers: every read reports the Drive units it depends on as subresources (see
  // file-subresources.ts), which the Workshop checks through verifyObserverAccess(): each file
  // whose metadata, comments or sharing it returned, each file whose PDF text or bytes it returned
  // (as content, which needs leave to download), each folder it listed, and each native file
  // whose content it read, Docs, Sheets and Slides included. A read whose answer is relative to
  // the connected account (an account binding's empty search, a folder it cannot list, a file it
  // cannot see, comment on or share, the top level of its own My Drive named as a sharing
  // target, or a move it may not make) reports `[]`; a folder binding's search reports its
  // folders even when empty. Account-binding invisible-file 403/404 probes return one generic
  // error without Google's per-file reason. The tracker no longer records what reads reveal. It
  // keeps what addObserver() still enforces: a Drive grant, the bound folder or file (seeded
  // below), the units reads recorded before they reported subresources, and the admission fence
  // earlier releases latched after owner-relative reads.

  #observerTracker(): ObserverTracker<DriveObservation, Fetcher<GoogleVerifierApi>> {
    return driveObserverTracker<Fetcher<GoogleVerifierApi>>(
      this.ctx.storage.kv, this.#scope,
      (verifier, observations) => verifier.verifyDriveObservations([...observations]));
  }

  get #scope(): DriveBindingScope {
    return requireDriveBindingScope(this.#bound.scope);
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observerTracker().addObserver(id, user as unknown as Fetcher<GoogleVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    // A folder not created yet tracks no observer.
    if (isSimulated(this.ctx.props)) return;
    this.#observerTracker().removeObserver(id);
  }

  /**
   * Checks the Drive, Docs, Sheets and Slides subresources this binding's reads report, failing
   * the whole call for any other ID. Each observer's UserAccount answers whether their own account
   * can see each file, download each file's content, list each folder and open each native file,
   * reusing recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    requireFileSubresources(
      subresources, ["file", "content", "folder", "document", "spreadsheet", "presentation"]);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

/** The refusal for a comment write on a folder: Drive answers one with a server error, every time. */
const FOLDER_COMMENT_REFUSED = "A Google Drive folder cannot take comments.";

/** The refusal for an account connected before Drive bindings could read file content. */
function contentAccessMissing(what: string): string {
  return "This Google account was connected before Drive bindings could read file content. " +
    `Reconnect it in Workshop to read ${what}.`;
}

/** A failed file download as a file read reports it. */
function fileReadError(error: unknown): unknown {
  if (lacksFileContentAccess(error)) return new Error(contentAccessMissing("Drive files"));
  // Only a file that shrank since its size was read refuses a range inside that size.
  if (error instanceof DriveApiRequestError && error.status === 416) return new Error(FILE_CHANGED);
  return error;
}

/** The same refusal for a comment listing, which needs the same access. */
const COMMENTS_ACCESS_MISSING =
  "This Google account was connected before Drive bindings could read file content. Reconnect " +
  "it in Workshop to read comments.";

/**
 * Said before a write refusal that answers a listing: each speaks of changes, and none was asked
 * for.
 */
const LISTING_TAKES_WRITES = "Seeing who a file is shared with takes what changing it takes.";

/** Said before the read-only refusal of an all-of-Drive binding, which names a single-file URL. */
const MOVE_NEEDS_A_FOLDER =
  "Moving takes a folder or all-of-Drive connection: the single-file connection named below " +
  "cannot move a file.";

/** The Drive session methods that open a native file. */
type NativeOpener = "openGoogleDoc" | "openGoogleSheet" | "openGoogleSlides";

/**
 * Drive RPC session implementation, exported for workerd contract coverage. One class serves every
 * scope and access level. A native opener answers the session the binding's access hands out, a
 * read session or an editable one that extends it, and a folder opens another such session, so
 * those are typed as the reads.
 */
@validateRpc()
export class GoogleDriveSessionImpl extends RpcTarget
    implements Omit<GoogleDriveSession, NativeOpener>,
      Omit<GoogleDriveFolderSession, NativeOpener | "openFolder">,
      Pick<GoogleDriveReadSession, NativeOpener>, Pick<GoogleDriveFolderReadSession, "openFolder"> {
  #core: DriveCore;
  #driveApi: DriveApi;
  #docsApi: GoogleDocsApi;
  #sheetsApi: GoogleSheetsApi;
  #slidesApi: GoogleSlidesApi;
  /** Absent when the deployment has no Workers AI binding, so PDFs cannot be read. */
  #convertPdf: PdfConverter | undefined;
  #scope: DriveBindingScope;
  /** Set exactly when the scope is a folder, so no core has to be built to learn which it is. */
  #location?: FolderLocation;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #writes: DriveQueue;
  /** The binding's edits of native files; absent on a read-only binding. */
  #editors: DriveFileEditors | undefined;

  constructor(
    driveApi: DriveApi,
    docsApi: GoogleDocsApi,
    sheetsApi: GoogleSheetsApi,
    slidesApi: GoogleSlidesApi,
    convertPdf: PdfConverter | undefined,
    scope: DriveBindingScope,
    approvalQueue: RpcStub<ApprovalQueue>,
    writes: DriveQueue,
    editors: DriveFileEditors | undefined,
    location?: FolderLocation,
  ) {
    super();
    this.#driveApi = driveApi;
    this.#docsApi = docsApi;
    this.#sheetsApi = sheetsApi;
    this.#slidesApi = slidesApi;
    this.#convertPdf = convertPdf;
    this.#scope = scope;
    this.#location = scope.kind === "folder"
      ? location ?? {folderIds: [scope.folderId]}
      : undefined;
    this.#approvalQueue = approvalQueue;
    this.#writes = writes;
    this.#editors = editors;
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

  async search(query: DriveSessionSearchQuery): Promise<Cursor<DriveEntry>> {
    return this.#cursor(core => core.search(query));
  }

  getEntry(fileId: string): Promise<DriveEntry> {
    return this.#core.getEntry(fileId);
  }

  async openFolder(folderId: string): Promise<GoogleDriveSessionImpl> {
    if (this.#scope.kind !== "folder") outsideScope();
    return this.#withQueue(async (queue, core) => {
      let location = await (core as DriveFolderSessionCore).openFolder(folderId);
      return new GoogleDriveSessionImpl(
        this.#driveApi, this.#docsApi, this.#sheetsApi, this.#slidesApi, this.#convertPdf,
        this.#scope, queue, this.#writes, this.#editors, location,
      );
    });
  }

  async openGoogleDoc(fileId: string): Promise<GoogleDocReadSession | GoogleDocEditSession> {
    let editors = this.#editors;
    return this.#openNative(fileId, GOOGLE_DOC_MIME_TYPE, "Google Doc",
      (documentId, queue, read, target) => editors
        ? new GoogleDocEditSessionImpl({
          docsApi: this.#docsApi, driveApi: this.#driveApi, documentId, approvalQueue: queue, read,
          changes: editors.docs(target, queue),
          source: driveDocSource(
            this.#docsApi, this.#driveApi, documentId, editors.docsFreshness(documentId)),
        })
        : new GoogleDocReadSessionImpl(this.#docsApi, this.#driveApi, documentId, queue, read));
  }

  async openGoogleSheet(
    fileId: string,
  ): Promise<GoogleSpreadsheetReadSession | GoogleSpreadsheetSession> {
    let editors = this.#editors;
    return this.#openNative(fileId, GOOGLE_SHEET_MIME_TYPE, "Google Sheet",
      (spreadsheetId, queue, read, target) => editors
        ? new GoogleSpreadsheetSessionImpl(
          this.#sheetsApi, spreadsheetId, queue, read, editors.sheets(target, queue))
        : new GoogleSpreadsheetReadSessionImpl(this.#sheetsApi, spreadsheetId, queue, read));
  }

  async openGoogleSlides(
    fileId: string,
  ): Promise<GooglePresentationReadSession | GooglePresentationSession> {
    let editors = this.#editors;
    return this.#openNative(fileId, GOOGLE_SLIDES_MIME_TYPE, "Google Slides presentation",
      (presentationId, queue, read, target) => editors
        ? new GooglePresentationSessionImpl(
          this.#slidesApi, presentationId, queue, read, editors.slides(target, queue))
        : new GooglePresentationReadSessionImpl(this.#slidesApi, presentationId, queue, read));
  }

  async readPdf(fileId: string): Promise<DrivePdfText> {
    // The text stream needs no queue of its own, so this reads through the session's, as getEntry.
    let core = this.#core;
    let id = await core.openNativeFile(fileId, PDF_MIME_TYPE, "PDF");
    let convert = this.#convertPdf;
    if (!convert) throw new Error("PDF reading is not available on this deployment.");
    let converted: DrivePdfText | undefined;
    return core.nativeRead(id, PDF_MIME_TYPE, {content: true})(async () => {
      let download = (await this.#driveApi.openDownload(id).catch((error: unknown) => {
        throw lacksFileContentAccess(error) ? new Error(contentAccessMissing("PDFs")) : error;
      })).getReader();
      // The checks after this fetch must cover everything the text is converted from, so a
      // conversion that answers before the download has ended is refused.
      let downloaded = false;
      converted = await convert(new ReadableStream<Uint8Array>({
        async pull(controller) {
          let chunk = await download.read();
          if (chunk.done) {
            downloaded = true;
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        },
        cancel: reason => download.cancel(reason),
      }, { highWaterMark: 0 }));
      if (!downloaded) {
        await download.cancel().catch(() => undefined);
        throw new Error(CONVERSION_FAILED);
      }
      return converted;
    }, () => ({
      title: "Read PDF from Google Drive",
      description: `Read the text of Drive file ${id}.`,
    })).catch(async (error: unknown) => {
      // Text refused after its conversion still holds the response open.
      await converted?.text.cancel().catch(() => undefined);
      throw error;
    });
  }

  async readFile(fileId: string, options: DriveFileReadOptions = {}): Promise<DriveFileBytes> {
    let range = fileReadRange(options);
    // The stream needs no queue of its own, so this reads through the session's, as readPdf.
    let core = this.#core;
    let file = await core.openFile(fileId, "file");
    let {mimeType, size, modifiedTime} = downloadableFile(file);
    let {offset} = range;
    if (offset > size) {
      throw new Error(
        `offset ${offset} is past the end of the Drive file, which is ${size} bytes long.`);
    }
    let length = Math.min(range.length, size - offset);
    let opened: ReadableStream<Uint8Array> | undefined;
    // The fetch ends once Drive begins its answer, with none of it read or held here. A folder
    // binding's re-proof after it shows the file was still the folder's as that answer began, and
    // the stream carries only that answer; a move or rewrite later in it is not looked for, on
    // the understanding (unchecked) that Drive answers a download from one revision. The
    // re-proof re-reads the file's metadata anyway, so a folder binding also refuses a rewrite
    // that kept the size: its modification time moved.
    let download = await core.nativeRead(file.id, mimeType, {
      content: true,
      unchanged: current => {
        if (current.modifiedTime !== file.modifiedTime) throw new Error(FILE_CHANGED);
      },
    })(async () => {
      if (length === 0) return undefined;
      let answer = await this.#driveApi.downloadRange(file.id, offset, length)
        .catch((error: unknown) => { throw fileReadError(error); });
      opened = answer.content;
      // Another size, or a range that ends inside the file, means bytes from another revision
      // than the one described.
      if ((answer.fileSize ?? size) !== size || (answer.length ?? length) < length) {
        throw new Error(FILE_CHANGED);
      }
      return opened;
    }, () => ({
      title: "Read file from Google Drive",
      description: `Read ${length} bytes of Drive file ${file.id}, from byte ${offset}.`,
    })).catch(async (error: unknown) => {
      // A read refused after Drive began its answer still holds the download open.
      await opened?.cancel().catch(() => undefined);
      throw error;
    });
    // Its idle wait starts only now, so one spent on authorization is not counted against it.
    let content = download
      ? exactRange(download, length)
      : new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    return {mimeType, size, modifiedTime, offset, length, content};
  }

  async listComments(fileId: string): Promise<Cursor<DriveComment>> {
    return this.#withQueue(async (queue, core) => {
      let { fileId: id } = await core.commentTarget(fileId);
      await core.requireCommentable(id);
      let pager = core.commentPager(id, fetch => this.#writes.undecided(async pending => {
        let { comments, nextPageToken } = await fetch().catch((error: unknown) => {
          throw lacksFileContentAccess(error) ? new Error(COMMENTS_ACCESS_MISSING) : error;
        });
        return {
          ...overlayPending(id, comments.map(toDriveComment), pending, nextPageToken === undefined),
          ...(nextPageToken ? { nextPageToken } : {}),
        };
      }));
      return new RpcCursor(pager, queue);
    });
  }

  async comment(
    fileId: string, text: string, options: DriveCommentOptions = {},
  ): Promise<DriveComment> {
    await this.#requireWritable();
    let { quote, tabId } = options;
    if (tabId !== undefined && quote === undefined) {
      throw new Error("tabId names the tab a quote is in; pass the quote too.");
    }
    let queued = await this.#queueComment(fileId, "createComment", async (target, base) => {
      if (quote === undefined) return { ...base, content: composeComment(text) };
      // Checked before the Doc is read; a comment attached through Docs has the Docs limit.
      let content = composeComment(text, true);
      let quoted = requireQuote(quote);
      return {
        ...base, content, anchor: { tabId: await this.#quotedTab(target, quoted, tabId), text: quoted },
      };
    });
    return pendingComment(queued.id, queued.payload);
  }

  async suggestEdit(
    fileId: string, oldText: string, newText: string, options: DriveSuggestEditOptions = {},
  ): Promise<DocSuggestion> {
    await this.#requireWritable();
    let { note, tabId } = options;
    let queued = await this.#queueComment(fileId, "suggestEdit", async (target, base) => {
      let checked = checkSuggestion(oldText, newText, note);
      return {
        ...base, tabId: await this.#quotedTab(target, checked.oldText, tabId, true), ...checked,
      };
    });
    return pendingSuggestion(queued.id, queued.payload);
  }

  async reply(fileId: string, commentId: string, text: string): Promise<DriveCommentReply> {
    await this.#requireWritable();
    await this.#requirePostedCommentId(commentId);
    let queued = await this.#queueComment(fileId, "createReply", async (target, base) => {
      let content = composeReply(text);
      // Before Drive is asked for the comment, so that a resolve applied meanwhile is seen there.
      if (await this.#resolvePending(target.fileId, commentId)) {
        throw new Error(REPLY_RESOLVE_PENDING);
      }
      let comment = await this.#liveComment(target.fileId, commentId);
      return {
        ...base, commentId, content, parent: await commentParent(comment),
        // Drive reopens a resolved comment that is replied to.
        ...(comment.resolved ? { reopens: true as const } : {}),
      };
    });
    return pendingReply(queued.id, { kind: "createReply", payload: queued.payload });
  }

  async resolve(fileId: string, commentId: string, text?: string): Promise<DriveCommentReply> {
    await this.#requireWritable();
    await this.#requirePostedCommentId(commentId);
    let queued = await this.#queueComment(fileId, "resolveComment", async (target, base) => {
      let content = composeResolve(text);
      if (await this.#resolvePending(target.fileId, commentId)) throw new Error(RESOLVE_PENDING);
      let comment = await this.#liveComment(target.fileId, commentId);
      // Drive would add another resolve reply to a resolved comment.
      if (comment.resolved) throw new Error(ALREADY_RESOLVED);
      return {
        ...base, commentId, ...(content === undefined ? {} : { content }),
        parent: await commentParent(comment),
      };
    });
    return pendingReply(queued.id, { kind: "resolveComment", payload: queued.payload });
  }

  async listAccess(fileId: string): Promise<DriveAccess[]> {
    // A listing is a read, and each refusal speaks of changes, so it is said what the two share.
    let refused = await this.#writes.writeRefusal();
    if (refused !== undefined) throw new Error(`${LISTING_TAKES_WRITES} ${refused}`);
    let actor = await this.#writes.actor();
    let { target } = await this.#sharing(fileId);
    let id = target.fileId;
    let entries = await this.#writes.undecided(async pending => overlayPendingAccess(
      id, toAccessEntries(await this.#permissions(target), actor.permissionId), pending));
    await this.#core.authorizeAccessList(target, entries.length);
    return entries;
  }

  async share(
    fileId: string, grantee: DriveGrantee, role: DriveShareRole, options?: DriveShareOptions,
  ): Promise<DriveAccess> {
    await this.#requireWritable();
    let checked = checkShare(grantee, options);
    let actor = await this.#writes.actor();
    let { target, base } = await this.#sharing(fileId);
    await this.#refuseBehindMove(target);
    let id = target.fileId;
    await this.#refuseQueued(pending =>
      hasPendingShare(id, checked.grantee, pending) ? SHARE_PENDING : undefined);
    let permissions = await this.#permissions(target);
    // Asked again with the list in hand, so that no refusal names access a listing leaves out.
    let plan = await this.#writes.undecided(async pending =>
      planShare(id, permissions, actor, checked.grantee, role, pending));
    let payload = { ...base, ...checked, role, ...plan };
    let actionId = await this.#writes.submit(
      this.#approvalQueue, "createPermission", payload, actorFence(actor));
    return pendingAccess(actionId, payload);
  }

  async updateAccess(
    fileId: string, access: string | DriveGrantee, role: DriveShareRole,
  ): Promise<DriveAccess> {
    let { payload, actor, permissions } = await this.#prepareChange(
      fileId, access, "change", (listed, as, named) => planUpdate(listed, as, named, role));
    // The entry a listing shows for it while it waits: the one given on the file, at the new role.
    let entry = toAccessEntries(permissions, actor.permissionId)
      .find(listed => !listed.inherited && listed.id === payload.permissionId);
    if (!entry) throw new Error("That access was not found on this file.");
    await this.#writes.submit(
      this.#approvalQueue, "updatePermission", payload, actorFence(actor));
    return { ...entry, role, pending: true };
  }

  async unshare(fileId: string, access: string | DriveGrantee): Promise<void> {
    let { payload, actor } = await this.#prepareChange(fileId, access, "remove", planUnshare);
    await this.#writes.submit(
      this.#approvalQueue, "deletePermission", payload, actorFence(actor));
  }

  async move(fileId: string, folderId: string): Promise<void> {
    // Said before the write refusal, whose URL on a read-only file binding could not move either.
    if (this.#scope.kind === "file") throw new Error(MOVE_SINGLE_FILE);
    let refused = await this.#writes.writeRefusal();
    if (refused !== undefined) {
      // Only an all-of-Drive binding's read-only refusal names a connection that cannot move.
      throw new Error(refused === readOnlyRefusal({ kind: "account" })
        ? `${MOVE_NEEDS_A_FOLDER} ${refused}` : refused);
    }
    if (folderId === fileId) throw new Error(MOVE_INTO_ITSELF);
    let actor = await this.#writes.actor();
    let target = await this.#core.moveTarget(fileId, folderId);
    await this.#refuseQueued(pending => {
      if (hasPendingMove([target.fileId], pending)) return MOVE_PENDING;
      // A folder binding proves the move again at approval along the saved path, and the
      // destination as a child of the source, so a move of either would leave it unprovable.
      if (!target.folderIds) return undefined;
      if (hasPendingMove(target.folderIds, pending)) return MOVE_WAITING;
      return hasPendingMove([target.toFolderId], pending) ? MOVE_DESTINATION_WAITING : undefined;
    });
    await this.#writes.submit(this.#approvalQueue, "moveFile", {
      fileId: target.fileId,
      fileName: shownFileName(target.name),
      ...(target.isFolder ? { isFolder: true as const } : {}),
      fromFolderId: target.fromFolderId,
      toFolderId: target.toFolderId,
      ...(target.toName === undefined ? {} : { toName: shownFileName(target.toName) }),
      ...(target.fromName === undefined ? {} : { fromName: shownFileName(target.fromName) }),
      ...(target.fromMyDrive ? { fromMyDrive: true as const } : {}),
      ...(target.toMyDrive ? { toMyDrive: true as const } : {}),
      ...(target.folderIds ? { folderIds: target.folderIds } : {}),
    }, actorFence(actor));
  }

  /**
   * Refuses a write this binding may not make, with the reason `writeRefusal()` gives: the
   * deployment keeps Google Drive read-only, the binding is read-only, or its account does not
   * allow changes.
   */
  async #requireWritable(): Promise<void> {
    let refused = await this.#writes.writeRefusal();
    if (refused !== undefined) throw new Error(refused);
  }

  /**
   * Refuses a comment ID that is not one Drive gave: a `pending:` ID, by whether its comment still
   * awaits approval in this binding's queue, or anything that is not a comment ID at all.
   */
  async #requirePostedCommentId(commentId: string): Promise<void> {
    if (isPendingId(commentId)) {
      throw new Error(await this.#writes.undecided(
        async pending => pendingCommentRefusal(commentId, pending)));
    }
    if (!isDriveCommentId(commentId)) throw new Error("Not a Google Drive comment ID.");
  }

  /**
   * Whether this binding has a resolve of the comment that an approval can still apply: one
   * awaiting a decision, or one an interrupted approval left to the next.
   */
  #resolvePending(fileId: string, commentId: string): Promise<boolean> {
    return this.#writes.waiting(async pending => hasPendingResolve(fileId, commentId, pending));
  }

  /**
   * Throws the refusal `ask` answers from the writes this binding has waiting, if it answers one:
   * those still to be decided, and those an interrupted approval left to be applied by the next.
   * The read gate is held across no request.
   */
  async #refuseQueued(ask: (pending: readonly QueuedWrite[]) => string | undefined): Promise<void> {
    let refused = await this.#writes.waiting(async pending => ask(pending));
    if (refused !== undefined) throw new Error(refused);
  }

  /** The scope proof, the sharing check and the base payload every sharing call shares. */
  async #sharing(fileId: string): Promise<{
    target: DriveWriteTarget; base: DriveWriteTargetPayload & { isFolder?: true };
  }> {
    let core = this.#core;
    let target = await core.sharingTarget(fileId);
    await core.requireShareable(target.fileId);
    return {
      target,
      base: {
        fileId: target.fileId,
        fileName: shownFileName(target.name),
        ...(target.folderIds ? { folderIds: target.folderIds } : {}),
        ...(target.self ? { self: true as const } : {}),
        ...(target.isFolder ? { isFolder: true as const } : {}),
      },
    };
  }

  /**
   * The permissions of a sharing target, read after its scope proof. A folder binding proves the
   * target again after the read, as it does after every other read of a child: a file moved out
   * of the folder meanwhile lists the sharing of where it went, which this binding does not reach.
   */
  async #permissions(target: DriveWriteTarget): Promise<DrivePermissionRecord[]> {
    let permissions = await readPermissions(this.#driveApi, target.fileId);
    await this.#core.revalidateSharingTarget(target);
    return permissions;
  }

  /**
   * Refuses a write on a folder binding while a move waits for anything its proof at approval
   * rests on: its file, or a folder of the saved path to it.
   */
  async #refuseBehindMove(target: { fileId: string; folderIds?: readonly string[] }): Promise<void> {
    // An account or file binding proves no path.
    let { fileId, folderIds } = target;
    if (!folderIds) return;
    await this.#refuseQueued(pending =>
      hasPendingMove([...folderIds, fileId], pending) ? MOVE_WAITING : undefined);
  }

  /** Access to `fileId` named by a string or a grantee, checked before Google is asked anything. */
  async #namedAccess(
    fileId: string, access: string | DriveGrantee, call: "change" | "remove",
  ): Promise<string | DriveGrantee> {
    if (typeof access === "string" && isPendingId(access)) {
      throw new Error(await this.#writes.undecided(
        async pending => pendingAccessRefusal(fileId, access, pending, call)));
    }
    return checkAccessName(access);
  }

  /**
   * Everything a role change and a removal do before they are queued: the write refusal, the
   * access named, the account's identity, the scope proof and the sharing check, what this binding
   * already has waiting, and the file's permissions, which `plan` holds the request against.
   */
  async #prepareChange<P extends { permissionId: string }>(
    fileId: string, access: string | DriveGrantee, call: "change" | "remove",
    plan: (
      permissions: DrivePermissionRecord[], actor: DriveActor, access: string | DriveGrantee,
    ) => P,
  ): Promise<{
    payload: DriveWriteTargetPayload & { isFolder?: true } & P;
    actor: DriveActor;
    permissions: DrivePermissionRecord[];
  }> {
    await this.#requireWritable();
    let named = await this.#namedAccess(fileId, access, call);
    let actor = await this.#writes.actor();
    let { target, base } = await this.#sharing(fileId);
    await this.#refuseBehindMove(target);
    let id = target.fileId;
    await this.#refuseQueued(pending => {
      if (typeof named === "string") {
        return hasPendingChange(id, named, pending) ? CHANGE_PENDING : undefined;
      }
      // Access that is not given yet takes no change: the user withdraws it by rejecting it.
      if (!hasPendingShare(id, named, pending)) return undefined;
      return call === "change" ? ACCESS_WAITING_CHANGE : ACCESS_WAITING_REMOVE;
    });
    let permissions = await this.#permissions(target);
    let planned = plan(permissions, actor, named);
    if (typeof named !== "string") {
      // A grantee names its access only once the list is read.
      await this.#refuseQueued(pending =>
        hasPendingChange(id, planned.permissionId, pending) ? CHANGE_PENDING : undefined);
    }
    return { payload: { ...base, ...planned }, actor, permissions };
  }

  /**
   * Checks and queues one comment write: the file is in scope and is not a folder, the connected
   * account can comment on it and no move waits for it, all before `prepare` builds the payload,
   * and nothing is queued until it has.
   */
  async #queueComment<K extends keyof DriveCommentActions>(
    fileId: string,
    kind: K,
    prepare: (target: DriveWriteTarget, base: CommentTargetPayload) => Promise<DriveActions[K]>,
  ): Promise<{ id: number; payload: DriveActions[K] }> {
    let core = this.#core;
    let target = await core.commentTarget(fileId);
    // Before the account is asked whether it can comment: of a folder, Drive says it can.
    if (target.isFolder) throw new Error(FOLDER_COMMENT_REFUSED);
    await core.requireCommentable(target.fileId);
    await this.#refuseBehindMove(target);
    let payload = await prepare(target, {
      fileId: target.fileId,
      fileName: shownFileName(target.name),
      ...(target.folderIds ? { folderIds: target.folderIds } : {}),
      queuedAt: new Date().toISOString(),
    });
    let id = await this.#writes.submit(this.#approvalQueue, kind, payload);
    return { id, payload };
  }

  /**
   * The ID of the tab of a Google Doc in which `quote` occurs exactly once; with `wholeChips`, as
   * for text a suggestion replaces, refused when it takes in part of a chip. Reading the Doc is a
   * content read, authorized as one.
   */
  async #quotedTab(
    target: DriveWriteTarget, quote: string, tabId: string | undefined, wholeChips = false,
  ): Promise<string> {
    if (target.mimeType !== GOOGLE_DOC_MIME_TYPE) {
      throw new Error("Quoting and suggested edits work only on Google Docs.");
    }
    let documentId = target.fileId;
    let document = await this.#core.nativeRead(documentId, GOOGLE_DOC_MIME_TYPE)(
      () => this.#docsApi.getDocument(documentId),
      () => ({
        title: "Read Google Doc content",
        description: `Read the text of Google Doc ${documentId} to find the quoted text.`,
      }));
    let tab = selectTab(document, tabId);
    locateQuote(tab, quote, { wholeChips });
    return tab.tabId;
  }

  async #liveComment(fileId: string, commentId: string) {
    let comment = await readLiveComment(this.#driveApi, fileId, commentId);
    if (!comment) throw new Error(COMMENT_NOT_FOUND);
    return comment;
  }

  #coreFor(queue: RpcStub<ApprovalQueue>): DriveCore {
    let common = {
      api: this.#driveApi,
      access: this.#writes.access,
      authorize: (description: ObservationDescription) => queue.authorizeObservation(description),
    };
    if (this.#scope.kind === "folder") {
      return new DriveFolderSessionCore({
        ...common, location: this.#location ?? {folderIds: [this.#scope.folderId]},
      });
    }
    return new DriveSessionCore({...common, scope: this.#scope});
  }

  /**
   * Runs `use` against a capability-owned approval queue, disposing it if `use` throws.
   *
   * A capability handed to the caller outlives this session, so it pages through a queue of its
   * own; the queue is this session's to release until ownership transfers on success.
   */
  async #withQueue<T>(use: (queue: RpcStub<ApprovalQueue>, core: DriveCore) => Promise<T>) {
    let queue = this.#approvalQueue.dup();
    try {
      return await use(queue, this.#coreFor(queue));
    } catch (error) {
      queue[Symbol.dispose]();
      throw error;
    }
  }

  async #cursor(open: (core: DriveCore) => Promise<Pager<DriveEntry>>): Promise<Cursor<DriveEntry>> {
    return this.#withQueue(async (queue, core) => new RpcCursor(await open(core), queue));
  }

  /**
   * Opens a native file for `build`, handing it the file's ID, a queue of its own, the read every
   * fetch goes through, and the file as an edit names it.
   */
  async #openNative<T>(
    fileId: string,
    mimeType: string,
    description: string,
    build: (
      id: string, queue: RpcStub<ApprovalQueue>, read: NativeRead, target: DriveWriteTargetPayload,
    ) => T,
  ): Promise<T> {
    return this.#withQueue(async (queue, core) => {
      let file = await core.openNative(fileId, mimeType, description);
      let target: DriveWriteTargetPayload = {
        fileId: file.id, fileName: shownFileName(file.name),
        ...(this.#location ? { folderIds: [...this.#location.folderIds] } : {}),
      };
      return build(file.id, queue, core.nativeRead(file.id, mimeType), target);
    });
  }
}

const UNCREATED_FOLDER =
  "This Google Drive folder is not created yet, so it holds nothing. Once its creation is " +
  "approved, open it from a new session.";

/**
 * A Drive folder GatekeeperVendor.createResource() was asked for, before its creation is approved:
 * empty, and named as it will be. Nothing it answers comes from Google, but its reads are audited
 * as every pending creation's are, with no subresources.
 */
@validateRpc()
class UncreatedDriveFolderSessionImpl extends RpcTarget
    implements GoogleDriveSession, GoogleDriveFolderSession {
  #title: string;
  #queue: RpcStub<ApprovalQueue>;

  constructor(title: string, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#title = title;
    this.#queue = queue;
  }

  #audit(title: string, description: string): Promise<void> {
    return this.#queue.authorizeObservation({ title, description, subresources: [] });
  }

  async getScope(): Promise<DriveScope> {
    await this.#audit("Read Google Drive scope", `Read the name of Drive folder "${this.#title}", not created yet.`);
    return {
      kind: "folder", folderId: UNCREATED_FILE_ID, rootFolderId: UNCREATED_FILE_ID, name: this.#title,
      access: "read",
    };
  }

  async list(_options?: DriveListOptions): Promise<Cursor<DriveEntry>> {
    await this.#audit("Read Google Drive metadata", `Listed Drive folder "${this.#title}", not created yet: empty.`);
    return new RpcCursor<DriveEntry>({ next: async () => null });
  }

  async search(_query: DriveSessionSearchQuery): Promise<Cursor<DriveEntry>> {
    await this.#audit("Read Google Drive metadata", `Searched Drive folder "${this.#title}", not created yet: empty.`);
    return new RpcCursor<DriveEntry>({ next: async () => null });
  }

  async getEntry(_fileId: string): Promise<DriveEntry> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openFolder(_folderId: string): Promise<GoogleDriveFolderSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openGoogleDoc(_fileId: string): Promise<GoogleDocEditSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openGoogleSheet(_fileId: string): Promise<GoogleSpreadsheetSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openGoogleSlides(_fileId: string): Promise<GooglePresentationSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async readPdf(_fileId: string): Promise<DrivePdfText> {
    throw new Error(UNCREATED_FOLDER);
  }

  async readFile(_fileId: string, _options?: DriveFileReadOptions): Promise<DriveFileBytes> {
    throw new Error(UNCREATED_FOLDER);
  }

  // A folder not created yet holds no file to read or write comments on, share or move. Its agent
  // types are the read-only ones, so the writes are here only for the session's declared shape.
  async listComments(_fileId: string): Promise<Cursor<DriveComment>> {
    throw new Error(UNCREATED_FOLDER);
  }

  async comment(_fileId: string, _text: string, _options?: DriveCommentOptions): Promise<DriveComment> {
    throw new Error(UNCREATED_FOLDER);
  }

  async suggestEdit(
    _fileId: string, _oldText: string, _newText: string, _options?: DriveSuggestEditOptions,
  ): Promise<DocSuggestion> {
    throw new Error(UNCREATED_FOLDER);
  }

  async reply(_fileId: string, _commentId: string, _text: string): Promise<DriveCommentReply> {
    throw new Error(UNCREATED_FOLDER);
  }

  async resolve(_fileId: string, _commentId: string, _text?: string): Promise<DriveCommentReply> {
    throw new Error(UNCREATED_FOLDER);
  }

  async listAccess(_fileId: string): Promise<DriveAccess[]> {
    throw new Error(UNCREATED_FOLDER);
  }

  async share(
    _fileId: string, _grantee: DriveGrantee, _role: DriveShareRole, _options?: DriveShareOptions,
  ): Promise<DriveAccess> {
    throw new Error(UNCREATED_FOLDER);
  }

  async updateAccess(
    _fileId: string, _access: string | DriveGrantee, _role: DriveShareRole,
  ): Promise<DriveAccess> {
    throw new Error(UNCREATED_FOLDER);
  }

  async unshare(_fileId: string, _access: string | DriveGrantee): Promise<void> {
    throw new Error(UNCREATED_FOLDER);
  }

  async move(_fileId: string, _folderId: string): Promise<void> {
    throw new Error(UNCREATED_FOLDER);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
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

/** One BigQuery dataset, the unit at which observer access is checked. */
type BigQueryDatasetRef = { projectId: string; datasetId: string };

const BIGQUERY_SUBRESOURCE_NAMESPACE = "bigquery";

/**
 * The subresource ID a read reports for a dataset whose data it reveals:
 * `bigquery/project/<projectId>/dataset/<datasetId>`, each component escaped. A dataset ID is
 * unique only within its project, so the ID names both.
 */
function bigQueryDatasetSubresource({ projectId, datasetId }: BigQueryDatasetRef): string {
  return formatSubresourceId({
    namespace: BIGQUERY_SUBRESOURCE_NAMESPACE,
    fragments: [{ name: "project", id: projectId }, { name: "dataset", id: datasetId }],
  });
}

/** The dataset a {@link bigQueryDatasetSubresource} ID names; throws for any other ID. */
function parseBigQueryDatasetSubresource(id: string): BigQueryDatasetRef {
  let { namespace, fragments } = parseSubresourceId(id);
  if (namespace !== BIGQUERY_SUBRESOURCE_NAMESPACE || fragments.length !== 2 ||
      fragments[0].name !== "project" || fragments[1].name !== "dataset") {
    throw new Error("Not a BigQuery dataset subresource ID.");
  }
  return { projectId: fragments[0].id, datasetId: fragments[1].id };
}

export type BigQueryGatekeeperImplProps = {
  userObjectId: string;
  /** When set, narrows the session's authority. Project is required for any narrower scope. */
  scopedProjectId?: string;
  scopedDatasetId?: string;
  scopedTableId?: string;
  /**
   * The project query jobs run in and are billed to, when it is not the scoped project: what a
   * dataset shared from a project the account holds no role in needs, since BigQuery requires
   * `bigquery.jobs.create` wherever the job runs. It changes nothing about which tables a query
   * may read, which the scope above decides.
   */
  queryProjectId?: string;
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
    let { scopedProjectId: p, scopedDatasetId: d, scopedTableId: t, queryProjectId } = this.ctx.props;
    let path = p ? (d ? (t ? `/${p}/${d}/${t}` : `/${p}/${d}`) : `/${p}`) : "";
    let label = t ? `${p}.${d}.${t}` : d ? `${p}.${d}` : p ?? null;
    let url = new URL(`https://${BIGQUERY_HOST}${path}`);
    if (queryProjectId) url.searchParams.set(BIGQUERY_QUERY_PROJECT_PARAM, queryProjectId);
    let snippet = t
        ? `Query BigQuery table "${p}.${d}.${t}" (read-only)`
        : d
            ? `Query BigQuery dataset "${p}.${d}" (read-only)`
            : p
                ? `Query BigQuery datasets in project "${p}" (read-only)`
                : "Browse BigQuery projects and datasets (read-only)";
    return {
      url: url.toString(),
      title: label ? `BigQuery (${label})` : "BigQuery",
      snippet: queryProjectId ? `${snippet}; query jobs run in "${queryProjectId}"` : snippet,
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
      this.ctx.props.queryProjectId,
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("BigQuery gatekeeper has no writable actions to revert");
  }

  // -------------------------------------------------------------------------
  // Observer tracking — strategy C, by dataset. Even a project- or table-scoped binding is checked
  // at dataset granularity: users may have IAM access to different datasets. Reads report each
  // dataset they reveal as a subresource, which the Workshop checks through verifyObserverAccess().
  //
  // This tracker now guards only legacy history: the datasets reads recorded before they reported
  // subresources, or that a read still running that code records. Reads no longer feed it, so
  // addObserver() verifies each observer against that history alone, through hasDatasetAccess,
  // which reuses no answers.

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

  /**
   * Checks the dataset subresources reads report, failing the whole call for any other ID. Each
   * observer's UserAccount answers whether its own token has IAM access to every dataset, reusing
   * recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    for (let id of subresources) parseBigQueryDatasetSubresource(id);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

@validateRpc()
class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;
  #queryProjectId?: string;

  constructor(
    api: BigQueryApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    scopedProjectId: string | undefined,
    scopedDatasetId: string | undefined,
    scopedTableId: string | undefined,
    queryProjectId?: string,
  ) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#scopedProjectId = scopedProjectId;
    this.#scopedDatasetId = scopedDatasetId;
    this.#scopedTableId = scopedTableId;
    this.#queryProjectId = queryProjectId;
  }

  // Authorize an observation, reporting as subresources the datasets whose data it reveals, which
  // the Workshop checks collaborators against. Use for every read; pass an empty `datasets` for
  // reads that reveal none (e.g. echoing the scoped project id).
  async #authorizeDatasets(
    datasets: { projectId: string; datasetId: string }[],
    description: ObservationDescription,
  ): Promise<void> {
    await this.#approvalQueue.authorizeObservation({
      ...description,
      subresources: [...new Set(datasets.map(bigQueryDatasetSubresource))],
    });
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

  // The project every query job runs in and is billed to: the connection's query project when it
  // names one, else the scoped project. Fixed by the connection, never by the caller. BigQuery
  // requires `bigquery.jobs.create` here, which a dataset shared from another project does not
  // grant, so a connection to such a dataset names a project of the account's own.
  #billingProject(): string {
    if (this.#queryProjectId) return this.#queryProjectId;
    if (this.#scopedProjectId) return this.#scopedProjectId;
    throw new Error(
      "This session is not scoped to a project. Connect to a specific BigQuery project " +
      "(e.g. https://bigquery.googleapis.com/my-project) to run queries.");
  }

  // The default dataset lives in the data's project, whichever project the job runs in, so an
  // unqualified table name resolves where the connection points.
  #jobDefaultDataset(datasetId: string | undefined): { projectId: string; datasetId: string } | undefined {
    return datasetId ? { projectId: this.#scopedProjectId!, datasetId } : undefined;
  }

  // BigQuery's answer when the account cannot create jobs in the billing project, said in terms of
  // what the user can do about it; the gatekeeper's own cross-project checks never reach BigQuery.
  async #asJob<T>(billingProject: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BigQueryApiError && error.status === 403 &&
          error.reason === "accessDenied" && error.message.includes("bigquery.jobs.create")) {
        throw new Error(
          `This Google account cannot run query jobs in project "${billingProject}" (it lacks ` +
          "bigquery.jobs.create there), which BigQuery requires of every query, including a dry run. " +
          "Reconnect this BigQuery resource choosing a project of yours to run queries in; it can " +
          "still read this data, and that project is billed instead.", { cause: error });
      }
      throw error;
    }
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
    let estimate = await this.#asJob(billingProject, () => this.#api.dryRun(billingProject, sql, {
      defaultDataset: this.#jobDefaultDataset(defaultDataset), params: opts?.params,
    }));
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
      containsRestrictedData: true,
    });

    return this.#asJob(billingProject, () => this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset: this.#jobDefaultDataset(defaultDataset),
      maximumBytesBilled: maxBytes,
    }));
  }

  async dryRun(
    sql: string,
    opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">,
  ): Promise<BigQueryDryRunResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);

    let estimate = await this.#asJob(billingProject, () => this.#api.dryRun(billingProject, sql, {
      defaultDataset: this.#jobDefaultDataset(defaultDataset), params: opts?.params,
    }));
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery dry run: ${preview}`,
      description:
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ") || "(none)"}`,
      containsRestrictedData: true,
    });

    return estimate;
  }

  async getProject(): Promise<BigQueryProject> {
    let result: BigQueryProject = { projectId: this.#scopedProjectId! };
    // Echoes the project id the Gadget was bound to — reveals no dataset data, so no attribution.
    await this.#authorizeDatasets([], {
      title: "Get BigQuery project",
      description: `Returned the scoped project: \`${this.#scopedProjectId}\`.`,
      containsRestrictedData: true,
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
        containsRestrictedData: true,
      });
      return [dataset];
    }

    let result = await this.#api.listDatasets(p);
    // Listing reveals each dataset's existence/name, so attribute to all of them.
    await this.#authorizeDatasets(result.map(ds => ({ projectId: p, datasetId: ds.datasetId })), {
      title: `List datasets in ${p}`,
      description: `Listed ${result.length} dataset(s) in \`${p}\`.`,
      containsRestrictedData: true,
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
        containsRestrictedData: true,
      });
      return [table];
    }

    let result = await this.#api.listTables(p, d);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `List tables in ${p}.${d}`,
      description: `Listed ${result.length} table(s) in \`${p}.${d}\`.`,
      containsRestrictedData: true,
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
      containsRestrictedData: true,
    });
    return result;
  }
}
