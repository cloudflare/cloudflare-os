import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor, ActionKind, GitCache, workerVersionTag, type ActionDescription, type ConnectHandoff } from '@gadgets/workshop-shared/gatekeeper';
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan, plainInline } from "@gadgets/gatekeeper-kit/action-description";
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
import {
  GoogleDocSession, DocMetadata, type DocCommentOptions, type DocSuggestEditOptions,
  type GoogleDocReadSession, type GoogleDocTab,
} from "./docs-types";
import {
  DOC_COMMENT_ACTIONS, DocCommentSession, docsThreads, type DocCommentQueue,
} from "./doc-comments";
import {
  BLANK_DOC_TAB_ID, BlankGoogleDoc, blankDocsTab, docsWriteFailure, GoogleDocsApi, type DocsBatchReply,
  type GoogleDocReader, type GoogleDocsDocument, type GoogleDocsTab,
} from "./docs-api";
import { checkDocTabTitle, insertDocTab, type DocTabPlacement } from "./docs-tabs";
import { GoogleSheetsApi } from "./sheets-api";
import { GoogleSlidesApi } from "./slides-api";
import { GoogleApiError } from "./google-response";
import {
  boundProps, createFileOnce, creationAction, isSimulated, newFileTitle, UNCREATED_FILE_ID,
  type SimulatedFileProps,
} from "./creation";
import {
  getGoogleSlidesTypesCode, GooglePresentationReadSessionImpl, type GoogleSlidesGatekeeperImplProps,
} from "./slides";
import {
  getGoogleSheetsTypesCode, GoogleSpreadsheetReadSessionImpl, type GoogleSheetsGatekeeperImplProps,
} from "./sheets";
import type { GooglePresentationReadSession } from "./slides-read-types";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
import SHEETS_READ_TYPES_CODE from "./sheets-read-types.txt";
import {
  applyMarkdownEdit, assertMarkdownWriteComplexity, canonicalizeMarkdownForWrite,
  canonicalizeMarkdownReplacement,
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  type DocTabSnapshot, type EditableMarkdown,
} from "./markdown-converter";
import {
  DriveApi, DriveApiRequestError, FOLDER_MIME_TYPE, isDriveCommentId, lacksFileContentAccess,
  MAX_BATCH_FILES,
} from "./drive-api";
import {
  checkSuggestion, composeComment, composeReply, composeResolve, locateQuote, requireQuote,
  selectTab,
} from "./drive-comment-body";
import {
  ALREADY_RESOLVED, COMMENT_NOT_FOUND, commentAttempts, commentParent, DRIVE_COMMENT_ACTIONS,
  hasPendingResolve, isPendingCommentId, overlayPending, pendingComment, pendingCommentRefusal,
  pendingReply, pendingSuggestion, readLiveComment, REPLY_RESOLVE_PENDING, RESOLVE_PENDING, shownFileName,
  toDriveComment, writeRefusal,
  type CommentTargetPayload, type DriveCommentAction, type DriveCommentActions,
  type DriveCommentQueue,
} from "./drive-comments";
import { CONVERSION_FAILED, pdfToText, type PdfConverter } from "./drive-pdf";
import { downloadableFile, exactRange, fileReadRange, FILE_CHANGED } from "./drive-file-read";
import type { AiFetcher } from "./workers-ai-markdown";
import { driveObserverTracker, type DriveObservation } from "./drive-observers";
import {
  DOCS_SUBRESOURCE_NAMESPACE, DRIVE_SUBRESOURCE_NAMESPACE, fileSubresourceId, parseFileSubresource,
  requireFileSubresources, SHEETS_SUBRESOURCE_NAMESPACE, SLIDES_SUBRESOURCE_NAMESPACE,
  type DriveUnit, type FileSubresource, type NativeFileSubresource,
} from "./file-subresources";
import { outsideScope, readFolderRoot, type FolderLocation } from "./drive-folder-scope";
import {
  DriveFolderSessionCore, DriveSessionCore, driveModifiedTime,
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE, PDF_MIME_TYPE,
  requireDriveBindingScope, type CommentTarget, type DriveBindingScope, type DriveCore,
  type NativeObservation, type NativeRead,
} from "./drive-session";
import type {
  DocSuggestion, DriveComment, DriveCommentOptions, DriveCommentReply, DriveEntry, DriveFileBytes,
  DriveFileReadOptions, DriveListOptions, DrivePdfText, DriveScope, DriveSessionSearchQuery,
  DriveSuggestEditOptions, GoogleDriveFolderSession, GoogleDriveSession,
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
import DOCS_TYPES_CODE from "./docs-types.txt";
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
import { explainUnopenedFile, officeFileError, officeLabel } from "./office-conversion";
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
  GMAIL_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "./type-bundle";

let googleDocTypesCode: string | undefined;
let driveReadAgentTypesCode: string | undefined;
let driveAgentTypesCode: string | undefined;

/**
 * A directly bound Doc's bundle. It holds the comment declarations, which every Drive bundle holds
 * too, so the vendor's bundle takes them from here and from no Drive part.
 */
function getGoogleDocTypesCode(): string {
  return googleDocTypesCode ??= [
    DOCS_READ_TYPES_CODE, COMMENT_TYPES_CODE,
    stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

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
 * with the writes for `write`.
 */
function getGoogleDriveTypesCode(write: boolean): string {
  return [
    DOCS_READ_TYPES_CODE, SHEETS_READ_TYPES_CODE, SLIDES_READ_TYPES_CODE, COMMENT_TYPES_CODE,
    getDriveReadAgentTypesCode(), ...(write ? [getDriveAgentTypesCode()] : []),
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
    return beginStoredOAuthFlow(
        this.ctx.storage.kv, initiationNonce, oauthNonce, oauthRedirectUri, Date.now());
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
        ui: new RpcStub(new DriveConfiguratorUI(getToken, holds)),
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

/** Where a {@link PendingActionStore} keeps the next unused action ID, starting at 1. */
const PENDING_NEXT_ACTION_ID_KEY = "pending:nextActionId";

class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>(PENDING_NEXT_ACTION_ID_KEY) ?? 1;
    this.#kv.put(PENDING_NEXT_ACTION_ID_KEY, id + 1);
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
    this.#kv.delete(this.#applyingKey(id));
  }

  #applyingKey(id: number): string {
    return `pending:applying:${id}`;
  }

  /** Records that the overseer has started applying `id`, which proves it received the action. */
  markApplying(id: number): void {
    this.#kv.put(this.#applyingKey(id), true);
  }

  /** Whether the overseer has started applying `id` (see `markApplying`). */
  isApplying(id: number): boolean {
    return this.#kv.get<boolean>(this.#applyingKey(id)) === true;
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
  submittedAt: number;
  baseRevisionId?: string;
  writeId?: string;
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
}

/** A change to the text of one tab. */
type GoogleDocEditBase = GoogleDocActionBase & {
  /**
   * The tab this edit targets. Absent only on records stored before tab support, which are
   * invalidated rather than retargeted: the first tab is not necessarily the one they meant.
   */
  tabId?: string;
}

type GoogleDocReplaceAction = GoogleDocEditBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocEditBase & {
  type: "appendText";
  markdown: string;
}

/** A new, empty tab, placed under `parentTabId` at `index` as `addDocumentTab` places it. */
type GoogleDocAddTabAction = GoogleDocActionBase & DocTabPlacement & {
  type: "addTab";
  /**
   * The ID the agent was given for the tab, which Google names only once it is added. Edits
   * queued for the tab name it until then, and are pointed at Google's ID when the add applies.
   */
  provisionalTabId: string;
  title: string;
  /**
   * Every tab ID the document held when the add was sent, kept until Google refuses that send: a
   * retry that finds no marker checks it for any tab that has appeared since.
   */
  knownTabIds?: string[];
}

type GoogleDocEditAction = GoogleDocReplaceAction | GoogleDocAppendAction;
type GoogleDocAction = GoogleDocEditAction | GoogleDocAddTabAction;

const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** The last document read, replayed for this long before its revision is rechecked. */
const DOC_SNAPSHOT_TTL_MS = 10_000;
/** The last document read. Pending actions overlay it, so it outlives none. */
const DOC_SNAPSHOT_KEY = "docSnapshot";
/** Name prefix of the named range that marks one Gadgets write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";
/** Prefix of the ID `addTab()` returns for a tab Google has not added yet. */
const PROVISIONAL_TAB_PREFIX = "pending-tab-";
/** Each added tab's provisional ID to the ID Google gave it, oldest first. */
const DOC_ADDED_TABS_KEY = "docAddedTabs";
/** How many added tabs' provisional IDs keep resolving after their adds apply. */
const MAX_DOC_ADDED_TABS = 100;

type GoogleDocWriteReceipt = { actionId: number; markerId: string };

/** The document revision this binding has already reported, and when it first saw it. */
type GoogleDocMetadataRevision = { revisionId?: string; observedAt: number };
type GoogleDocNamedRange = { id: string; name: string };

function googleDocNamedRanges(tab: GoogleDocsTab): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries<unknown>(tab.namedRanges)) {
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

function googleDocNamedRangeIds(tab: GoogleDocsTab, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/**
 * The write IDs whose content `tab` already contains.
 *
 * A marker and its content go up in one atomic batch, so a marker naming a write ID proves that
 * write committed — including the case where its response was lost and its action is still
 * pending. Simulating such an action over this tab would show its content twice.
 */
function googleDocCommittedWriteIds(tab: GoogleDocsTab): string[] {
  let writeIds = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name.startsWith(WRITE_MARKER_PREFIX)) {
      writeIds.add(range.name.slice(WRITE_MARKER_PREFIX.length));
    }
  }
  return [...writeIds];
}

/** One tab's Markdown rendering, tagged with the writes that tab already contains. */
type GoogleDocTabSnapshot = DocTabSnapshot & { committedWriteIds: string[] };

/** A whole document as this gatekeeper caches it: one independent rendering per tab. */
type GoogleDocSnapshot = {
  /** Rendering schema of `tabs`; bumped by the converter that produced them. */
  formatVersion: typeof MARKDOWN_RENDERING_VERSION;
  title: string;
  /** Absent unless the caller can edit the document; see `GoogleDocsDocument.revisionId`. */
  revisionId?: string;
  tabs: GoogleDocTabSnapshot[];
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
}

function googleDocSnapshot(document: GoogleDocsDocument): GoogleDocSnapshot {
  return {
    formatVersion: MARKDOWN_RENDERING_VERSION,
    title: document.title,
    revisionId: document.revisionId,
    tabs: document.tabs.map(tab => ({
      ...docTabToMarkdown(tab),
      committedWriteIds: googleDocCommittedWriteIds(tab),
    })),
    fetchedAt: Date.now(),
  };
}

/** Accept a cached snapshot only if it predates nothing this code depends on. */
function isGoogleDocSnapshot(value: unknown): value is GoogleDocSnapshot {
  if (!value || typeof value !== "object") return false;
  let {formatVersion, title, tabs, revisionId, fetchedAt} = value as Partial<GoogleDocSnapshot>;
  return formatVersion === MARKDOWN_RENDERING_VERSION && typeof title === "string" &&
      Array.isArray(tabs) && (revisionId === undefined || typeof revisionId === "string") &&
      typeof fetchedAt === "number" && Number.isFinite(fetchedAt);
}

/**
 * Whether an expired snapshot still describes the current document.
 *
 * Google withholds `revisionId` from a caller without edit access, leaving no change token, so
 * such a document is refetched rather than spending a request on an answer that could never
 * confirm the cache.
 */
async function googleDocRevisionUnchanged(
  docsApi: GoogleDocReader,
  documentId: string,
  cached: GoogleDocSnapshot,
): Promise<boolean> {
  return cached.revisionId !== undefined &&
      await docsApi.getRevisionId(documentId) === cached.revisionId;
}

/**
 * The tab an operation names, or a failure telling the agent how to name one.
 *
 * Omission is resolved from the flattened tab list, so a single root with any child counts as
 * multi-tab. An unknown ID never falls back to the first tab: the caller meant a specific one.
 */
function resolveGoogleDocTab(
  snapshot: GoogleDocSnapshot,
  tabId: string | undefined,
  operation: "getContent" | "replaceText" | "appendText",
): GoogleDocTabSnapshot {
  if (tabId === undefined) {
    if (snapshot.tabs.length !== 1) {
      throw new Error(
        `${operation}: tabId is required for documents with multiple tabs. ` +
        `Call listTabs() to choose a tab.`);
    }
    return snapshot.tabs[0];
  }
  let tab = snapshot.tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(
      `${operation}: no tab with ID "${tabId}" exists in this document. ` +
      `Call listTabs() to refresh the tab list.`);
  }
  return tab;
}

/** The agent-facing view of one tab: identity and position, never content. */
function googleDocTabMetadata(tab: DocTabSnapshot): GoogleDocTab {
  return {
    id: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
  };
}

/**
 * How a tab is named in approval and observation text.
 *
 * The ID is included because it is what the write actually targets: titles are user-authored,
 * are not required to be unique, and may be empty. A tab still waiting for its add has only a
 * provisional ID, which names nothing the user can find, so it is called a new tab instead: its
 * own approval, queued before, shows where it goes. The title sits in prose, so it is flattened
 * with `plainInline` and cannot open Markdown or HTML structure there.
 */
function googleDocTabLabel(tab: DocTabSnapshot): string {
  let id = tab.tabId.startsWith(PROVISIONAL_TAB_PREFIX) ? "new tab" : tab.tabId;
  return `"${plainInline(tab.title)}" (${id})`;
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

type GoogleDocSimulatedContent = EditableMarkdown & {
  /** The valid document insertion point for an append, absent after trailing structure. */
  appendIndex: number | undefined;
};

function googleDocAppendIndex(tab: GoogleDocTabSnapshot): number | undefined {
  return tab.sourceMap.blocks.at(-1)?.docEnd === tab.bodyEndIndex
    ? tab.bodyEndIndex - 1
    : undefined;
}

function requireGoogleDocAppendIndex(appendIndex: number | undefined): number {
  if (appendIndex === undefined) {
    throw new Error(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.",
    );
  }
  return appendIndex;
}

function googleDocSimulatedContent(tab: GoogleDocTabSnapshot): GoogleDocSimulatedContent {
  return {
    markdown: tab.markdown,
    protectedRanges: tab.sourceMap.protectedRanges,
    appendIndex: googleDocAppendIndex(tab),
  };
}

/** A tab `addTab()` queued, rendered as Google adds it: empty. */
function newGoogleDocTab({ provisionalTabId, title }: GoogleDocAddTabAction): GoogleDocTabSnapshot {
  return { ...docTabToMarkdown(blankDocsTab(provisionalTabId, title)), committedWriteIds: [] };
}

/**
 * Why an add whose marker the document holds, but whose reply was lost, is refused rather than
 * adopted: Google names a new tab only in that reply. It takes no tab ID from the caller, and a
 * marker sent in the same batch cannot go in the tab the batch makes, so nothing else tells which
 * tab it is; a title and place could be a collaborator's tab, made after deleting this one.
 */
function googleDocLostAddError(action: GoogleDocAddTabAction): Error {
  return new Error(
    `Google Docs added the tab "${action.title}", but its reply was lost, and nothing else tells ` +
    "which tab it is. It stays in the document, where listTabs() shows it.");
}

/**
 * Refuses to send again an add whose earlier send has no known outcome and whose marker is gone,
 * once any tab has appeared anywhere in the document since (outside the `knownTabIds` recorded
 * before that send): a collaborator may have moved the tab it made under another parent. Nothing
 * ties such a tab to this add, whose send may never have reached Google, so it is not adopted; nor
 * is the add sent again, which could make a second.
 */
function assertGoogleDocAddUnsent(tabs: DocTabSnapshot[], action: GoogleDocAddTabAction): void {
  let known = new Set(action.knownTabIds);
  let appeared = tabs.filter(tab => !known.has(tab.tabId));
  if (appeared.length > 0) {
    throw new Error(
      `The add of tab "${action.title}" may have reached Google, but no marker of it is left, and ` +
      `${appeared.length === 1 ? "a tab has" : `${appeared.length} tabs have`} appeared in the ` +
      "document since, so whether it was added is unknown.");
  }
}

/** The ID of the tab an `addDocumentTab` reply names, if it names one. */
function googleDocReplyTabId(reply: DocsBatchReply | undefined): string | undefined {
  let tabId = reply?.addDocumentTab?.tabProperties?.tabId;
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

/**
 * The ID Google gave the tab `tabId` names, when it is the provisional ID of a tab whose add has
 * applied, and otherwise `tabId` itself.
 */
function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string): string;
function adoptedGoogleDocTabId(
  kv: DurableObjectStorage["kv"], tabId: string | undefined,
): string | undefined;
function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string | undefined) {
  if (!tabId?.startsWith(PROVISIONAL_TAB_PREFIX)) return tabId;
  return kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY)?.[tabId] ?? tabId;
}

/** The document as the pending queue leaves it. */
type GoogleDocSimulation = {
  /** Every tab, those queued with `addTab()` included, flattened as Google flattens them. */
  tabs: GoogleDocTabSnapshot[];
  /** The simulated content of every tab, since one replay covers them all. */
  contentByTabId: Map<string, GoogleDocSimulatedContent>;
}

/** One replay of the pending queue, keyed by the state it was computed from. */
type GoogleDocSimulatedContentCache = {
  baseRevisionId?: string;
  pendingFingerprint: string;
  simulation: GoogleDocSimulation;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
  /** Writes landed in the document, counted so a read awaiting Google across one can tell. */
  writes: number;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

const MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES = 1024 * 1024;
const googleDocActionEncoder = new TextEncoder();

function assertGoogleDocActionMarkdownSize(...values: string[]): void {
  // UTF-16 length is a lower bound on UTF-8 bytes, so an oversized input is refused unencoded.
  let byteLength = values.reduce((total, value) => total + value.length, 0);
  if (byteLength <= MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    byteLength = values.reduce(
      (total, value) => total + googleDocActionEncoder.encode(value).byteLength, 0);
  }
  if (byteLength > MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    throw new Error(
      `Google Doc action Markdown exceeds the ${MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES}-byte ` +
      "safe submission limit.",
    );
  }
  for (let value of values) assertMarkdownWriteComplexity(value);
}
function findUniqueMarkdown(
  markdown: string,
  oldMarkdown: string,
  operation: string,
  tabId: string,
): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}: oldMarkdown must not be empty.`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
      `Make sure the text exactly matches content returned by getContent("${tabId}").`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${tabId}". Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  content: GoogleDocSimulatedContent,
  action: GoogleDocReplaceAction,
  tabId: string,
): GoogleDocSimulatedContent {
  let { oldMarkdown } = action;
  let newMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, action.newMarkdown);
  let start = findUniqueMarkdown(content.markdown, oldMarkdown, "replaceText", tabId);
  if (oldMarkdown === newMarkdown) return content;
  return {
    ...content,
    ...applyMarkdownEdit(content, start, start + oldMarkdown.length, newMarkdown),
  };
}

/**
 * Whether a tab holds nothing but one empty paragraph, as a new document does. An append fills
 * that paragraph rather than following it, in both the simulation and the write. A paragraph whose
 * only content renders as nothing (a chip with no label) is protected, so it is not blank. Empty
 * Markdown counts too: a pending replace that removes a tab's whole content leaves the simulation
 * empty, while the real tab keeps its final paragraph and so renders as `"\n"`.
 */
function isBlankGoogleDocTab({ markdown, protectedRanges }: EditableMarkdown): boolean {
  return (markdown === "" || markdown === "\n") && protectedRanges.length === 0;
}

function appendMarkdownForSimulation(content: EditableMarkdown, appendedMarkdown: string): string {
  let terminatedAppend = appendedMarkdown + "\n";

  if (isBlankGoogleDocTab(content)) return terminatedAppend;
  let { markdown } = content;
  return canonicalizeMarkdownReplacement(
    markdown, markdown + (markdown.endsWith("\n") ? "\n" : "\n\n") + terminatedAppend);
}

function assertGoogleDocActionReplayable(action: GoogleDocAction): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
  // A new tab holds no Markdown, so no rendering change can alter it.
  if (action.type !== "addTab" && action.markdownVersion !== MARKDOWN_RENDERING_VERSION) {
    throw new Error(
      "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
      "apply as previewed. Reject it and retry.");
  }
}

function applyGoogleDocActionToContent(
  content: GoogleDocSimulatedContent,
  action: GoogleDocEditAction,
  tabId: string,
): GoogleDocSimulatedContent {
  assertGoogleDocActionReplayable(action);

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(content, action, tabId);
    case "appendText":
      requireGoogleDocAppendIndex(content.appendIndex);
      return {
        ...content,
        markdown: appendMarkdownForSimulation(
          content, canonicalizeMarkdownForWrite(action.markdown)),
      };
    default:
      action satisfies never;
      throw new Error("unknown Google Doc action type");
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

/**
 * The tabs that could hold the write marker of `action`.
 *
 * A marker lives in the tab its write landed in, so one elsewhere belongs to a different write.
 * A pre-tab-support edit names no tab, so its marker — and therefore the proof that its write
 * already committed — could be in any of them; so could a new tab's, which goes in its parent or
 * in the first tab, whichever was there when it was sent.
 */
function googleDocActionTabs<T extends { tabId: string }>(tabs: T[], action: GoogleDocAction): T[] {
  let tabId = action.type === "addTab" ? undefined : action.tabId;
  return tabId === undefined ? tabs : tabs.filter(tab => tab.tabId === tabId);
}

/** Whether `snapshot` already holds `action`'s write, which landed though its reply was lost. */
function googleDocActionCommitted(snapshot: GoogleDocSnapshot, action: GoogleDocAction): boolean {
  let { writeId } = action;
  return writeId !== undefined && googleDocActionTabs(snapshot.tabs, action)
    .some(tab => tab.committedWriteIds.includes(writeId));
}

/**
 * The tab an edit targets.
 *
 * A record stored before tabs were addressable names none, but the old code refused to read a
 * document with more than one tab, so such a record was approved against a document that had
 * exactly one. A document still holding one tab therefore resolves unambiguously; tabs added
 * since leave the approved target unknowable.
 *
 * Exported for coverage: no current write path can produce such a record.
 */
export function googleDocActionTab(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocEditAction,
): GoogleDocTabSnapshot {
  if (action.tabId === undefined && snapshot.tabs.length !== 1) {
    throw new Error(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  }
  return resolveGoogleDocTab(snapshot, action.tabId, action.type);
}

/**
 * Replay the pending queue over `snapshot`, invalidating any action that no longer applies.
 *
 * Actions are replayed in global approval order, but each edit only touches its own tab, so an
 * edit to one tab can neither shift nor be shifted by an edit to another. An added tab joins the
 * tab list where Google will put it, and edits queued for it then find it there.
 *
 * An edit whose marker `snapshot` already holds committed though its reply never arrived, so
 * the snapshot contains it, and replaying it would show its content twice; it stays pending, and
 * applyAction() settles it from the same marker. An add whose marker the snapshot holds is still
 * replayed as pending, though the tab it made is in the snapshot too: its reply may yet arrive,
 * to an approval still running, and only applyAction() can tell it was lost.
 */
function invalidateUnreplayableGoogleDocActions(
  pendingActions: PendingActionStore<GoogleDocAction>,
  snapshot: GoogleDocSnapshot,
  pending: GoogleDocPendingAction[],
  context: string,
): GoogleDocSimulation {
  let tabs = snapshot.tabs;
  let contentByTabId = new Map(
    snapshot.tabs.map(tab => [tab.tabId, googleDocSimulatedContent(tab)]),
  );
  for (let record of pending) {
    let { action } = record;
    if (action.invalidatedReason) continue;

    try {
      if (action.type === "addTab") {
        assertGoogleDocActionReplayable(action);
        let tab = newGoogleDocTab(action);
        tabs = insertDocTab(tabs, tab, { parentTabId: action.parentTabId, index: action.index });
        contentByTabId.set(tab.tabId, googleDocSimulatedContent(tab));
        continue;
      }
      if (googleDocActionCommitted(snapshot, action)) continue;
      let { tabId } = googleDocActionTab({ ...snapshot, tabs }, action);
      contentByTabId.set(
        tabId,
        applyGoogleDocActionToContent(contentByTabId.get(tabId)!, action, tabId),
      );
    } catch (error) {
      invalidateGoogleDocAction(
        pendingActions,
        record,
        `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
        `Reject it and retry if it is still needed.`,
      );
    }
  }

  return { tabs, contentByTabId };
}

/** The batch requests for one edit, together with the tab they are addressed to. */
function materializeGoogleDocAction(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAction,
): { tab: GoogleDocTabSnapshot; requests: any[] } {
  assertGoogleDocActionReplayable(action);
  if (action.type === "addTab") return materializeGoogleDocAddTab(snapshot, action);
  let tab = googleDocActionTab(snapshot, action);

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          tab.markdown, action.oldMarkdown, "applyAction(replaceText)", tab.tabId);
      let { requests } = computeReplaceOperations(
          tab.sourceMap,
          tab.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          canonicalizeMarkdownReplacement(action.oldMarkdown, action.newMarkdown),
          tab.tabId);
      return { tab, requests };
    }

    case "appendText": {
      let appendIndex = requireGoogleDocAppendIndex(googleDocAppendIndex(tab));
      let requests = isBlankGoogleDocTab(googleDocSimulatedContent(tab))
        ? markdownToDocRequests(action.markdown, appendIndex, tab.tabId, { resetParagraphs: true })
        : markdownToDocRequests("\n" + action.markdown, appendIndex, tab.tabId,
          { resetParagraphs: true, preserveLeadingParagraph: true });
      return { tab, requests };
    }

    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

/**
 * The request adding a tab, refused where Google would refuse it. Its write marker goes in a tab
 * that exists: its parent, or the first tab.
 */
function materializeGoogleDocAddTab(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAddTabAction,
): { tab: GoogleDocTabSnapshot; requests: any[] } {
  let { title, parentTabId, index } = action;
  insertDocTab(snapshot.tabs, newGoogleDocTab(action), { parentTabId, index });
  let tab = snapshot.tabs.find(candidate => candidate.tabId === parentTabId) ?? snapshot.tabs[0];
  let tabProperties = {
    title,
    ...parentTabId === undefined ? {} : { parentTabId },
    ...index === undefined ? {} : { index },
  };
  return { tab, requests: [{ addDocumentTab: { tabProperties } }] };
}

export type GoogleDocGatekeeperImplProps =
  { userObjectId: string; documentId: string } | SimulatedFileProps;

/** The ID of the first tab of a document just created, for the real class to adopt pending edits. */
const CREATED_DOC_TAB_KEY = "createdDocTab";

/** Points every pending action naming tab `from`, as its target or as its parent, at tab `to`. */
function retargetGoogleDocActions(kv: DurableObjectStorage["kv"], from: string, to: string): void {
  let pendingActions = new PendingActionStore<GoogleDocAction>(kv);
  for (let { id, action } of pendingActions.list()) {
    if (action.type === "addTab") {
      if (action.parentTabId === from) pendingActions.put(id, { ...action, parentTabId: to });
    } else if (action.tabId === from) {
      pendingActions.put(id, { ...action, tabId: to });
    }
  }
}

/**
 * Hands the tab an add made from its provisional ID to the ID Google gave it: the actions queued
 * for it name Google's from now on, and the pair is kept, so an agent still holding the
 * provisional ID keeps reaching the tab.
 */
function adoptGoogleDocTab(
  kv: DurableObjectStorage["kv"], provisionalTabId: string, tabId: string,
): void {
  retargetGoogleDocActions(kv, provisionalTabId, tabId);
  let added = Object.entries(kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY) ?? {});
  kv.put(DOC_ADDED_TABS_KEY,
    Object.fromEntries([...added, [provisionalTabId, tabId]].slice(-MAX_DOC_ADDED_TABS)));
}

/**
 * Moves the state a simulated document left in storage onto the created one: pending actions
 * naming the blank document's tab name the created document's first tab, and the cached reads of
 * the blank document are dropped.
 */
function adoptBlankDocument(kv: DurableObjectStorage["kv"], tabId: string): void {
  retargetGoogleDocActions(kv, BLANK_DOC_TAB_ID, tabId);
  kv.delete(DOC_SNAPSHOT_KEY);
  kv.delete(DOC_METADATA_REVISION_KEY);
  kv.delete(CREATED_DOC_TAB_KEY);
}

// All Google Doc edits (replaceText, appendText, ...) are grouped under a single action kind
const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "Document edits",
};

/** New tabs, a kind of their own since edits already have an auto-approvable one. */
const ADD_DOCUMENT_TAB_ACTION: ActionKind = {
  tag: "addDocumentTab",
  label: "New document tabs",
};

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = { writes: 0 };

  // Serialize applying and rejecting actions, and creating the document, against each other. Every
  // network await below leaves the Durable Object's input gate open, and one action id can arrive
  // twice — the overseer marks a record approved only after applyAction() returns, so two approvals
  // of it both see it pending. Interleaved, both fetch the document and the loser writes content the
  // winner already committed; the write marker is no defence, since the winner's cleanup deletes it
  // before the loser looks. Two approvals of a creation would likewise create two documents.
  #actions = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
    return stub.getAccessToken(opts);
  });
  // Comment writes keep the comment engine's own records. Their journal takes its IDs from the
  // edit store's counter, which holds the next unused ID and starts at 1 as a journal's does, so an
  // approval ID names one action of this binding, edit or comment: applyAction() and rejectAction()
  // tell the two apart by whether this journal holds it. A namespace would start a second counter.
  #commentJournal = new ActionJournal<DriveCommentAction>(this.ctx.storage.kv, {
    legacyKeys: { nextIdKey: PENDING_NEXT_ACTION_ID_KEY, recordPrefix: "docComments:action:" },
  });
  #commentAttempts = commentAttempts(this.ctx.storage.kv);
  #comments = DOC_COMMENT_ACTIONS.bind(this.#commentJournal, {
    // Read at apply: a Doc not created yet takes no comment writes, so none applies before it is.
    threads: docsThreads(() => this.#bound.documentId,
      new GoogleDocsApi(opts => this.#getAccessToken(opts)),
      new DriveApi(opts => this.#getAccessToken(opts))),
    docs: new GoogleDocsApi(opts => this.#getAccessToken(opts)),
    // Not gated on Drive's read and write choice, as the Doc's edits are not.
    writeRefusal: async () => undefined,
    attempts: this.#commentAttempts,
  });
  #reads = new ReadGate();

  constructor(ctx: DurableObjectState<GoogleDocGatekeeperImplProps>, env: Env) {
    super(ctx, env);
    // The real class's first start after applyCreation(): take over what the blank document left.
    let tabId = ctx.storage.kv.get<string>(CREATED_DOC_TAB_KEY);
    if (tabId !== undefined && !isSimulated(ctx.props)) {
      ctx.storage.transactionSync(() => adoptBlankDocument(ctx.storage.kv, tabId));
    }
  }

  /** The account and document this binding reaches, which a document not yet created has not. */
  get #bound(): { userObjectId: string; documentId: string } {
    return boundProps(this.ctx.props, "doc");
  }

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

    // The marker ID is exact, but its tab is not recorded, so every tab is searched for it.
    let markerTab = document.tabs.find(
      tab => googleDocNamedRanges(tab).some(({ id }) => id === receipt.markerId),
    );
    if (!markerTab) {
      this.#clearDocWriteReceipt(receipt.markerId);
      return document;
    }

    let { documentId } = this.#bound;
    await api.deleteNamedRange(documentId, receipt.markerId, markerTab.tabId);
    this.#clearDocWriteReceipt(receipt.markerId);
    return api.getDocument(documentId);
  }

  /**
   * Hands one proven write from its pending action to a cleanup receipt, atomically.
   *
   * The cached snapshot goes with it. That snapshot predates this write, and once the action stops
   * being pending nothing overlays it, so a read interleaving with the cleanup below would report
   * content older than what is already committed. A read already awaiting Google sees the write
   * counted and fetches again rather than cache what it got.
   *
   * A write that added a tab hands that tab to the ID Google gave it in the same step, so no read
   * finds the add gone while the edits queued for its tab still name the provisional ID.
   */
  #handoffDocWriteReceipt(
    actionId: number,
    markerId: string,
    pendingActions: PendingActionStore<GoogleDocAction>,
    addedTab?: { provisionalTabId: string; tabId: string },
  ): void {
    this.ctx.storage.transactionSync(() => {
      let existing = this.#readDocWriteReceipt();
      if (existing && existing.markerId !== markerId) {
        throw new Error("A different Google Doc write receipt is already pending cleanup");
      }
      if (addedTab) adoptGoogleDocTab(this.ctx.storage.kv, addedTab.provisionalTabId, addedTab.tabId);
      this.ctx.storage.kv.put(DOC_WRITE_RECEIPT_KEY, { actionId, markerId });
      this.ctx.storage.kv.delete(DOC_SNAPSHOT_KEY);
      pendingActions.remove(actionId);
      this.#simulationCache.writes++;
    });
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("doc"),
        title,
        snippet: `Google Doc: ${title} (not created yet)`,
        suggestedBindingName: "GOOGLE_DOC",
        tsType: "GoogleDocSession",
      };
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocumentMetadata(props.documentId);
    // Docs reads an Office file as though it were native but refuses every edit to it, so only
    // Drive can say. When Drive cannot answer, the document is described as it reads.
    let mimeType = await new DriveApi(opts => this.#getAccessToken(opts))
      .getFile(props.documentId).then(file => file.mimeType, () => undefined);
    if (officeLabel("doc", mimeType) !== undefined) throw officeFileError("doc");
    return {
      url: nativeFileUrl("doc", props.documentId),
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
    return [EDIT_DOCUMENT_ACTION, ADD_DOCUMENT_TAB_ACTION, ...this.#comments.autoApprovableKinds()];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let props = this.ctx.props;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    // Only an undecided or claimed comment write can be applied again, so no other marker is read.
    this.#commentAttempts.sweep(new Set(this.#commentJournal.listPending().map(({ id }) => id)));
    let comments: DocCommentQueue = {
      submit: (queue, kind, payload) => this.#comments.submit(queue, kind, payload),
      undecided: read => this.#reads.read(() => read(this.#commentJournal.listUndecided())),
    };
    // A blank document always has a revision, so the session never reaches Drive for one.
    return new GoogleDocSessionImpl(
        isSimulated(props)
          ? new BlankGoogleDoc(props.creation.title)
          : new GoogleDocsApi(opts => this.#getAccessToken(opts)),
        new DriveApi(opts => this.#getAccessToken(opts)),
        isSimulated(props) ? UNCREATED_FILE_ID : props.documentId,
        approvalQueue.dup(),
        pendingActions,
        this.ctx.storage,
        this.#simulationCache,
        comments);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#applyComment(actionId) : this.#applyAction(actionId));
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#rejectComment(actionId) : this.#rejectAction(actionId));
  }

  /** Whether `actionId` names a comment write, pending or already applied, rather than an edit. */
  #isComment(actionId: number): boolean {
    return this.#commentJournal.get(actionId) !== undefined ||
      this.#commentJournal.wasApplied(actionId);
  }

  /**
   * Applies a comment write, and then drops its attempt marker, as a Drive binding does. A claim an
   * earlier apply left is handed back as undecided first: the marker decides whether its send is
   * looked for before anything is sent again. Comments depend on no edit, so they are applied in
   * any order.
   */
  #applyComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      if (this.#commentJournal.get(actionId)?.state === "claimed") {
        this.#commentJournal.restorePending(actionId);
      }
      await this.#comments.apply(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  /** Withdraws a comment write. No edit waits on it, so nothing restarts. */
  #rejectComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      await this.#comments.reject(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#actions.run(() => this.#applyCreation(creator, configuration));
  }

  async #applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    let { userObjectId, fileId, resourceUrl, getAccessToken: tokens } = await createFileOnce(
        this.ctx, creator, "doc", configuration,
        (title, getToken) => new GoogleDocsApi(getToken).createDocument(title));
    // Edits queued against the blank document name its tab, which the created one may not share.
    let [tab] = (await new GoogleDocsApi(tokens).getDocument(fileId)).tabs;
    this.ctx.storage.kv.put(CREATED_DOC_TAB_KEY, tab.tabId);
    return {
      class: this.ctx.exports.GoogleDocGatekeeperImpl({props: {userObjectId, documentId: fileId}}),
      resourceUrl,
    };
  }

  async #applyAction(actionId: number): Promise<void> {
    let { documentId } = this.#bound;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let action = pending[pendingIndex].action;
    // Left pending, not removed: the overseer keeps its own record when this throws, so removing
    // ours would answer the next retry with "unknown action" instead of the reason. Rejecting
    // clears both.
    if (action.invalidatedReason) {
      throw new Error(action.invalidatedReason);
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
    let doc = await api.getDocument(documentId);
    doc = await this.#reconcileDocWriteReceipt(api, doc);
    let snapshot = googleDocSnapshot(doc);
    // A marker is found with its tab, which deleting it must name.
    let markers = googleDocActionTabs(doc.tabs, action).flatMap(tab =>
      googleDocNamedRangeIds(tab, writeMarkerName).map(id => ({ id, tabId: tab.tabId })));
    if (new Set(markers.map(({ id }) => id)).size > 1) {
      throw new Error(`Google Docs returned multiple write markers for action ${actionId}`);
    }
    let [writeMarker] = markers;
    /** The ID of the tab an add made, which only Google's reply to it names. */
    let addedTabId: string | undefined;
    // A retry of an add that landed without its reply is refused, and one whose earlier send has
    // no known outcome and whose marker is gone (a top-level add's marker is in another tab, which
    // a collaborator may have deleted) is checked before it is sent again.
    if (action.type === "addTab" && (writeMarker || action.knownTabIds !== undefined)) {
      try {
        if (writeMarker) throw googleDocLostAddError(action);
        assertGoogleDocAddUnsent(snapshot.tabs, action);
      } catch (error) {
        invalidateGoogleDocAction(pendingActions, pending[pendingIndex],
          `Pending Google Doc tab add was refused: ${errorMessage(error)} ` +
          "Edits queued for it must be queued again for a tab listTabs() shows.");
        this.#simulationCache.current = undefined;
        throw error;
      }
    }
    if (!writeMarker) {
      let materialized: { tab: GoogleDocTabSnapshot; requests: any[] };
      try {
        materialized = materializeGoogleDocAction(snapshot, action);
      } catch (error) {
        // Invalidated, not removed: later edits stop waiting behind it, and approving it again
        // repeats the reason rather than reporting success for a write that never happened.
        logger.error("Google Doc action cannot be applied", {
          event: "google.doc.action.apply.unapplyable",
          actionId, error,
        });
        invalidateGoogleDocAction(
            pendingActions,
            pending[pendingIndex],
            `Pending Google Doc edit could not be applied: ${errorMessage(error)}`);
        this.#simulationCache.current = undefined;
        await this.ctx.storage.put(DOC_SNAPSHOT_KEY, snapshot);
        throw error;
      }
      let { tab, requests } = materialized;
      if (action.type === "addTab") {
        action.knownTabIds = doc.tabs.map(({ tabId }) => tabId);
        pendingActions.put(actionId, action);
      }
      if (requests.length > 0) {
        let result = await api.batchUpdate(documentId, requests, snapshot.revisionId, {
          name: writeMarkerName,
          rangeStart: tab.bodyEndIndex - 1,
          tabId: tab.tabId,
        }).catch(async (error: unknown) => {
          if (action.type === "addTab" && docsWriteFailure(error) !== "unknown") {
            // Refused whole, so no tab was added, and a retry has nothing to look for.
            delete action.knownTabIds;
            pendingActions.put(actionId, action);
          }
          throw await explainUnopenedFile("doc", error, async () =>
            (await new DriveApi(opts => this.#getAccessToken(opts)).getFile(documentId)).mimeType);
        });
        if (!result.writeMarkerId) {
          throw new Error(`Google Docs did not return a write marker for action ${actionId}`);
        }
        writeMarker = { id: result.writeMarkerId, tabId: tab.tabId };
        if (action.type === "addTab") {
          // Applied, but unnamed: a retry finds the marker and refuses.
          addedTabId = googleDocReplyTabId(result.replies[0]);
          if (!addedTabId) {
            throw new Error(`Google Docs did not return the new tab's ID for action ${actionId}`);
          }
        }
      }
    }
    if (writeMarker) {
      this.#handoffDocWriteReceipt(actionId, writeMarker.id, pendingActions,
        action.type === "addTab" && addedTabId
          ? { provisionalTabId: action.provisionalTabId, tabId: addedTabId } : undefined);
      try {
        await api.deleteNamedRange(documentId, writeMarker.id, writeMarker.tabId);
        this.#clearDocWriteReceipt(writeMarker.id);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    } else {
      pendingActions.remove(actionId);
    }
    this.#simulationCache.current = undefined;

    // The handoff dropped the snapshot this edit made stale. Only edits queued behind it need the
    // new revision now, to be replayed over it; otherwise the next read fetches it, and an approval
    // that nobody reads after costs no full document read. They are listed again, since the
    // handoff of an added tab pointed those queued for it at Google's ID.
    let later = pendingActions.list()
      .filter(record => record.id > actionId && !record.action.invalidatedReason);
    if (writeMarker && later.length === 0) return;
    try {
      let refreshedSnapshot = snapshot;
      if (writeMarker) {
        refreshedSnapshot = googleDocSnapshot(await api.getDocument(documentId));
      }
      await this.ctx.storage.put(DOC_SNAPSHOT_KEY, refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot,
          later,
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
   *
   * Reads now also report the document as a `docs/document/<documentId>` subresource, which
   * verifyObserverAccess checks; this check stays for the reads made before they did.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.#bound.documentId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Doc, so they cannot be allowed " +
        "to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  /**
   * Checks the document subresource every read reports, failing the whole call for any other ID.
   * Each observer's UserAccount answers whether the Docs API opens the document for their own
   * account, reusing recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    requireFileSubresources(subresources, ["document"]);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocReader;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;
  /** What every read reports: the document, or nothing for one not created yet. */
  #subresources: string[];
  #comments: DocCommentSession;

  constructor(
    docsApi: GoogleDocReader,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
    comments: DocCommentQueue,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
    this.#subresources = documentId === UNCREATED_FILE_ID
      ? []
      : [fileSubresourceId({kind: "document", fileId: documentId})];
    this.#comments = new DocCommentSession({
      documentId, docs: docsApi, drive: driveApi, comments, approvalQueue,
      authorizeRead: description => this.#authorizeRead(description),
      onlyInPendingEdits: async (tabId, quote) => {
        if (this.#pendingActions.list().length === 0) return false;
        let { tab, markdown } = await this.#getSimulatedContent(tabId, "getContent");
        return !tab.markdown.includes(quote) && markdown.includes(quote);
      },
    });
  }

  listComments(): Promise<DriveComment[]> {
    return this.#comments.listComments();
  }

  comment(text: string, options: DocCommentOptions): Promise<DriveComment> {
    return this.#comments.comment(text, { ...options, tabId: this.#adoptedTabId(options.tabId) });
  }

  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion> {
    return this.#comments.suggestEdit(oldText, newText,
      options && { ...options, tabId: this.#adoptedTabId(options.tabId) });
  }

  /** `tabId`, or the ID Google gave the tab when it is the provisional ID of an applied add. */
  #adoptedTabId(tabId: string | undefined): string | undefined {
    return adoptedGoogleDocTabId(this.#storage.kv, tabId);
  }

  reply(commentId: string, text: string): Promise<DriveCommentReply> {
    return this.#comments.reply(commentId, text);
  }

  resolve(commentId: string, text?: string): Promise<DriveCommentReply> {
    return this.#comments.resolve(commentId, text);
  }

  // Every read authorizes through here, which reports the document it read as its subresource.
  #authorizeRead(description: Omit<ObservationDescription, "subresources">): Promise<void> {
    return this.#approvalQueue.authorizeObservation({
      ...description, subresources: this.#subresources,
    });
  }

  async #getSnapshot(): Promise<GoogleDocSnapshot> {
    for (;;) {
      let writes = this.#simulationCache.writes;
      // A snapshot written before tabs existed has no tab list and is simply replaced.
      let cached = await this.#storage.get<unknown>(DOC_SNAPSHOT_KEY);
      if (isGoogleDocSnapshot(cached) && Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) {
        return cached;
      }
      let snapshot = isGoogleDocSnapshot(cached) &&
          await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)
        ? { ...cached, fetchedAt: Date.now() }
        : googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
      // What Google returned before a write landed is stale: the edit is no longer pending to be
      // replayed over it, so it would read as missing, and edits queued after it could not replay.
      if (writes !== this.#simulationCache.writes) continue;
      await this.#storage.put(DOC_SNAPSHOT_KEY, snapshot);
      return snapshot;
    }
  }

  /** The document with every pending action replayed over it. */
  async #simulate(): Promise<GoogleDocSimulation & { snapshot: GoogleDocSnapshot }> {
    let snapshot = await this.#getSnapshot();
    let pending = this.#pendingActions.list();
    let cached = this.#simulationCache.current;
    // An unknown revision cannot be shown to match, so the replay is recomputed.
    if (cached && cached.baseRevisionId !== undefined &&
        cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === googleDocPendingFingerprint(pending)) {
      return { snapshot, ...cached.simulation };
    }

    let simulation = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot,
        pending,
        "Pending Google Doc edit could not be replayed against the current document");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.list()),
      simulation,
    };
    return { snapshot, ...simulation };
  }

  /** The selected tab's content with every pending action replayed over it. */
  async #getSimulatedContent(
    tabId: string | undefined,
    operation: "getContent" | "replaceText" | "appendText",
  ): Promise<GoogleDocSimulatedContent & {
    snapshot: GoogleDocSnapshot,
    tab: GoogleDocTabSnapshot,
  }> {
    let simulation = await this.#simulate();
    let { snapshot, tabs } = simulation;
    let tab = resolveGoogleDocTab({ ...snapshot, tabs }, this.#adoptedTabId(tabId), operation);
    let content = simulation.contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
    return {snapshot, tab, ...content};
  }

  /**
   * Current title, and a modification time that only advances when something changed.
   *
   * Google Docs exposes no modification time, so the moment this binding first saw the current
   * revision stands in for it and is reused for as long as that revision holds — reading a
   * document must not make it look freshly edited. Without edit access there is no revision to
   * date, and Drive's own timestamp is used instead. Pending edits still move it forward, since
   * `getContent()` already shows them.
   */
  async getMetadata(): Promise<DocMetadata> {
    let metadata = await this.#docsApi.getDocumentMetadata(this.#documentId);
    let revisedAt = metadata.revisionId === undefined
        ? await this.#modifiedWithoutRevision()
        : this.#observeDocRevision(metadata.revisionId);
    let pendingActions = this.#pendingActions.list()
        .map(({action}) => action)
        .filter(action => !action.invalidatedReason);

    await this.#authorizeRead({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), revisedAt);
    return {
      // UNCREATED_FILE_ID, empty, until the document is created.
      id: this.#documentId,
      title: metadata.title,
      lastModified: new Date(lastModified),
    };
  }

  /**
   * The modification time of a document Google reports no revision for.
   *
   * Without edit access there is no revision to date, so Drive is asked instead. An account
   * connected before per-resource grants may not hold the picker's metadata scope, leaving no
   * signal at all; the first observation then stands rather than every read looking like an edit.
   */
  async #modifiedWithoutRevision(): Promise<number> {
    try {
      return driveModifiedTime(await this.#driveApi.getFile(this.#documentId)).valueOf();
    } catch (error) {
      // Only a refused grant means no signal will ever arrive. A quota 403 (also 403), an outage
      // or a malformed body are transient or fixable, and dating the document from one would
      // report a changed document as unchanged for as long as Drive stays unhealthy.
      let refusedGrant = error instanceof DriveApiRequestError && error.status === 403 &&
          !error.isAccountWide;
      if (!refusedGrant) throw error;
      logger.warn("no Drive grant to date a Google Doc that has no revision", {
        event: "google.doc.metadata.drive.ungranted", error,
      });
      return this.#observeDocRevision(undefined);
    }
  }

  /**
   * When this binding first saw `revisionId`, recording it if the revision is new.
   *
   * An unreadable record is re-observed rather than rejected: it only dates a revision, so the
   * worst a lost record costs is one timestamp that moves when the document did not. Two absent
   * revisions count as the same: a document that offers no change token must not look edited by
   * every read, which is the opposite of what a cache needs from the same comparison.
   */
  #observeDocRevision(revisionId?: string): number {
    let stored = this.#storage.kv.get<unknown>(DOC_METADATA_REVISION_KEY);
    if (stored && typeof stored === "object") {
      let { revisionId: seen, observedAt } = stored as Partial<GoogleDocMetadataRevision>;
      if (seen === revisionId &&
          typeof observedAt === "number" && Number.isFinite(observedAt)) {
        return observedAt;
      }
    }
    let observedAt = Date.now();
    this.#storage.kv.put<GoogleDocMetadataRevision>(
      DOC_METADATA_REVISION_KEY, { revisionId, observedAt });
    return observedAt;
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    let { tabs } = await this.#simulate();

    await this.#authorizeRead({
      title: "List Google Doc tabs",
      description: "Read the document's tab names and hierarchy.",
    });

    return tabs.map(googleDocTabMetadata);
  }

  async addTab(title: string, options: { parentTabId?: string; index?: number } = {})
      : Promise<string> {
    checkDocTabTitle(title);
    let { index } = options;
    let provisionalTabId = `${PROVISIONAL_TAB_PREFIX}${crypto.randomUUID()}`;
    let simulation, action: GoogleDocAddTabAction, tabs;
    try {
      simulation = await this.#simulate();
      let parentTabId = this.#adoptedTabId(options.parentTabId);
      action = {
        type: "addTab",
        provisionalTabId,
        title,
        ...parentTabId === undefined ? {} : { parentTabId },
        ...index === undefined ? {} : { index },
        submittedAt: Date.now(),
        baseRevisionId: simulation.snapshot.revisionId,
        writeId: crypto.randomUUID(),
      };
      tabs = insertDocTab(simulation.tabs, newGoogleDocTab(action), { parentTabId, index });
    } catch (error) {
      // The error says whether that parent exists, and how many tabs it holds.
      await this.#authorizeRead({
        title: "List Google Doc tabs",
        description: "Read the document's tab names and hierarchy.",
      });
      throw error;
    }

    let { parentTabId } = action;
    let parent = simulation.tabs.find(tab => tab.tabId === parentTabId);
    let siblings = tabs.filter(tab => tab.parentTabId === parentTabId).length;
    let description = buildDescription(
      `Add a new, empty tab ${parent ? `under tab ${googleDocTabLabel(parent)}` : "at the top level"}` +
      (index === undefined ? ", after the tabs already there." :
        `, at position ${index + 1} of ${siblings}.`))
      .inline("Title", title);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Add tab to Google Doc",
        ...description.finish(),
        implementsRevert: false,
        actionKind: ADD_DOCUMENT_TAB_ACTION,
        autoApprovable: true,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
    return provisionalTabId;
  }

  async getContent(tabId?: string): Promise<string> {
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "getContent");
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }

    await this.#authorizeRead({
      title: "Read Google Doc content",
      description:
        `Read the full simulated content of tab ${googleDocTabLabel(selected.tab)} as Markdown.`,
    });
    return selected.markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }
    assertGoogleDocActionMarkdownSize(oldMarkdown, newMarkdown);

    let selected;
    let renderedNewMarkdown: string;
    try {
      selected = await this.#getSimulatedContent(tabId, "replaceText");
      let start = findUniqueMarkdown(
        selected.markdown, oldMarkdown, "replaceText", selected.tab.tabId,
      );
      renderedNewMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
      applyMarkdownEdit(selected, start, start + oldMarkdown.length, renderedNewMarkdown);
      // With no earlier edit to this tab, approval will build exactly these requests.
      if (selected.markdown === selected.tab.markdown) {
        computeReplaceOperations(selected.tab.sourceMap, selected.markdown, start,
          start + oldMarkdown.length, renderedNewMarkdown, selected.tab.tabId);
      }
    } catch (error) {
      // The error says whether that tab, or that text, exists.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;

    let action: GoogleDocAction = {
      type: "replaceText",
      // Read again: the add of a tab selected before the await above may have applied since.
      tabId: this.#adoptedTabId(tab.tabId),
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      oldMarkdown,
      newMarkdown,
    };

    let description = buildDescription(`Replace text in tab ${googleDocTabLabel(tab)}.`)
      .verbatim("Old", oldMarkdown, "markdown");
    if (newMarkdown !== renderedNewMarkdown) {
      description.verbatim("Requested New", newMarkdown, "markdown");
    }
    description.verbatim("New", renderedNewMarkdown, "markdown");
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Edit Google Doc",
        ...description.finish(),
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

  async appendText(markdown: string, tabId?: string): Promise<void> {
    assertGoogleDocActionMarkdownSize(markdown);
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "appendText");
      requireGoogleDocAppendIndex(selected.appendIndex);
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;
    let renderedMarkdown = canonicalizeMarkdownForWrite(markdown);

    let action: GoogleDocAction = {
      type: "appendText",
      // Read again: the add of a tab selected before the await above may have applied since.
      tabId: this.#adoptedTabId(tab.tabId),
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      markdown,
    };

    let description =
      buildDescription(`Append content to the end of tab ${googleDocTabLabel(tab)}.`);
    if (markdown === renderedMarkdown) {
      description.verbatim("Content", renderedMarkdown, "markdown");
    } else {
      description
        .verbatim("Requested", markdown, "markdown")
        .verbatim("Resulting", renderedMarkdown, "markdown");
    }
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Append to Google Doc",
        ...description.finish(),
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
    implements Gatekeeper<GoogleDriveSession> {
  #creating = new Mutex();
  #tokens = new AccessTokenCache(opts => this.#account().getAccessToken(opts));
  #api = new DriveApi(opts => this.#getAccessToken(opts));
  #journal = new ActionJournal<DriveCommentAction>(this.ctx.storage.kv, { namespace: "drive" });
  #attempts = commentAttempts(this.ctx.storage.kv);
  #actions = DRIVE_COMMENT_ACTIONS.bind(this.#journal, {
    api: this.#api,
    docs: new GoogleDocsApi(opts => this.#getAccessToken(opts)),
    scope: () => this.#scope,
    writeRefusal: () => this.#writeRefusal(),
    attempts: this.#attempts,
  });
  #reads = new ReadGate();

  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
  }

  /**
   * Whether the connection was made read and write. Anything else in its props is read-only, a
   * folder not created yet included.
   */
  get #writes(): boolean {
    return !isSimulated(this.ctx.props) && this.ctx.props.access === "write";
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
      access: this.#bound.access, scope: this.#scope, holdsGrant: () => this.#holdsWritesGrant(),
    });
  }

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  /** The account, scope and access this binding has, which a folder not yet created has not. */
  get #bound(): { userObjectId: string; scope: DriveBindingScope; access?: DriveAccessLevel } {
    return boundProps(this.ctx.props, "driveFolder");
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
    let level = write ? "Read and write" : "Read-only";
    let comments = write ? "read and queue comments" : "read comments";
    // The title is where a connection's level is said to people and to the agent.
    let titled = (title: string) => write ? `${title} (read and write)` : title;
    if (scope.kind === "account") {
      return {
        url: GOOGLE_DRIVE_RESOURCE.urlPattern,
        title: titled("Google Drive Account"),
        snippet: `${level}: find files anywhere this Google account can read in Drive, read native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other file's bytes with readFile(), and ${comments}`,
        suggestedBindingName: "GOOGLE_DRIVE",
        tsType: write ? "GoogleDriveSession" : "GoogleDriveReadSession",
      };
    }
    let api = this.#api;
    if (scope.kind === "folder") {
      // Validated here too, so a hand-built resource URL fails at connect rather than minting a
      // presentable binding whose every call then refuses.
      let folder = await readFolderRoot(scope.folderId, id => api.getFile(id));
      return {
        // The natural browser URL, not the internal `_resource` selector the grant is keyed on.
        url: `https://drive.google.com/drive/folders/${encodeURIComponent(scope.folderId)}`,
        title: titled(folder.name),
        snippet: `${level}: list and search direct children, navigate child folders, read native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other file's bytes with readFile(), and ${comments} on direct children in Drive folder "${folder.name}"`,
        suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
        tsType: write ? "GoogleDriveFolderSession" : "GoogleDriveFolderReadSession",
      };
    }
    let file = await api.getFile(scope.fileId);
    return {
      url: `https://drive.google.com/file/d/${encodeURIComponent(scope.fileId)}/view`,
      title: titled(file.name),
      snippet: write
        ? `Read and write: read metadata and, when native, Google Doc, Sheet or Slides content, with readPdf() a PDF's text, or with readFile() the bytes of any other file, from Drive file "${file.name}", and read and queue comments on it`
        : `Read-only: read metadata and, when native, Google Doc, Sheet or Slides content, with readPdf() a PDF's text, or with readFile() the bytes of any other file, and comments, from Drive file "${file.name}"`,
      suggestedBindingName: "GOOGLE_DRIVE_FILE",
      tsType: write ? "GoogleDriveFileSession" : "GoogleDriveReadSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDriveTypesCode(this.#writes);
  }

  /** A read-only binding submits nothing, so it lists no kind. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#writes ? this.#actions.autoApprovableKinds() : [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleDriveSession> {
    let props = this.ctx.props;
    if (isSimulated(props)) return new UncreatedDriveFolderSessionImpl(props.creation.title, approvalQueue.dup());
    // Only an undecided or claimed write can be applied again, so no other marker is read again.
    this.#attempts.sweep(new Set(this.#journal.listPending().map(({ id }) => id)));
    let getDriveAccessToken = (opts?: AccessTokenRequest) => this.#getAccessToken(opts);
    // `pnpm dev-server` drops the AI binding unless started with --use-workers-ai-binding.
    // `Ai` declares no `fetch`, but the binding has one; conversion goes through it so it can stream.
    let ai = this.env.AI as unknown as AiFetcher | undefined;
    let gatewayId = this.env.CF_AI_GATEWAY;
    let convertPdf: PdfConverter | undefined = ai && (pdf => pdfToText(ai, gatewayId, pdf));
    let comments: DriveCommentQueue = {
      access: this.#writes ? "write" : "read",
      writeRefusal: () => this.#writeRefusal(),
      submit: (queue, kind, payload) => this.#actions.submit(queue, kind, payload),
      undecided: read => this.#reads.read(() => read(this.#journal.listUndecided())),
    };
    return new GoogleDriveSessionImpl(
      this.#api,
      new GoogleDocsApi(getDriveAccessToken),
      new GoogleSheetsApi(getDriveAccessToken),
      new GoogleSlidesApi(getDriveAccessToken),
      convertPdf,
      this.#scope,
      approvalQueue.dup(),
      comments,
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
   * it and looks for what was posted.
   */
  applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#reads.resolve(async () => {
      this.#adoptOrphanedClaim(actionId);
      await this.#actions.apply(actionId);
      this.#attempts.delete(actionId);
    });
  }

  /**
   * Withdraws a write, whatever an earlier send of it did: a comment that send posted stays on the
   * file, and nothing applies the action again, so its attempt marker goes with it.
   */
  rejectAction(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      await this.#actions.reject(actionId);
      this.#attempts.delete(actionId);
    });
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Google Drive comments cannot be reverted automatically.");
  }

  /**
   * Hands a claim an earlier apply left behind back to the action set as undecided, rather than
   * let it be failed as of unknown outcome: the send's attempt marker decides instead. With one,
   * applying looks for what the send posted before anything is sent again. Without one, no send
   * of the write is in doubt: none was made, or each one made is known to have posted nothing. A
   * marker is kept until its action is applied or rejected so that this holds. Resolutions run
   * one at a time behind the read gate, so a claim found here is never one this activation holds.
   */
  #adoptOrphanedClaim(actionId: number): void {
    if (this.#journal.get(actionId)?.state === "claimed") this.#journal.restorePending(actionId);
  }

  // Observers: every read reports the Drive units it depends on as subresources (see
  // file-subresources.ts), which the Workshop checks through verifyObserverAccess(): each file
  // whose metadata or comments it returned, each file whose PDF text or bytes it returned (as
  // content, which needs leave to download), each folder it listed, and each native file whose
  // content it read, Docs, Sheets and Slides included. A read whose answer is relative to the
  // connected account (an account binding's empty search, a folder it cannot list, a file it
  // cannot see, or a file it cannot comment on) reports `[]`; a folder binding's search reports
  // its folders even when empty. Account-binding invisible-file 403/404 probes return one generic
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

@validateRpc()
class GoogleDocReadSessionImpl extends RpcTarget implements GoogleDocReadSession {
  #docsApi: GoogleDocsApi;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  /** A fetch still in flight, so reads issued together observe one revision. */
  #inFlight?: Promise<GoogleDocSnapshot>;
  /** The last revision a completed scope check approved, the only one a later read may reuse. */
  #approved?: GoogleDocSnapshot;
  #read: NativeRead;

  constructor(
    docsApi: GoogleDocsApi,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getMetadata(): Promise<DocMetadata> {
    return this.#read(async () => {
      let file = await this.#driveApi.getFile(this.#documentId);
      return { id: this.#documentId, title: file.name, lastModified: driveModifiedTime(file) };
    }, () => ({
      title: "Read Google Doc metadata",
      description: "Read the current title and modification time of the Drive document.",
    }));
  }

  /**
   * Reads one snapshot under the binding's scope guard.
   *
   * Only a revision a whole guard cycle approved becomes reusable. The scope check straddles the
   * fetch, so a revision fetched while the document was outside must never reach a later read --
   * and rolling it back after the refusal is too late, since a read that chained onto it meanwhile
   * already holds it. Reads issued together still share one fetch: each brackets that fetch with
   * its own checks, exactly as a lone read does.
   */
  async #readSnapshot<T>(
    use: (snapshot: GoogleDocSnapshot) => T,
    observe: (value: T) => NativeObservation,
  ): Promise<T> {
    let snapshot: GoogleDocSnapshot | undefined;
    let value = await this.#read(async () => {
      snapshot = await (this.#inFlight ??= this.#nextSnapshot()
        .finally(() => { this.#inFlight = undefined; }));
      return use(snapshot);
    }, observe);
    // A slow guard must not republish its older revision over a newer one already approved.
    if (snapshot && snapshot.fetchedAt >= (this.#approved?.fetchedAt ?? 0)) {
      this.#approved = snapshot;
    }
    return value;
  }

  /** Reuse one revision for the TTL, then confirm it is still current before reusing it again. */
  async #nextSnapshot(): Promise<GoogleDocSnapshot> {
    let cached = this.#approved;
    if (cached) {
      if (Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) return cached;
      if (await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)) {
        cached.fetchedAt = Date.now();
        return cached;
      }
    }
    return googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    return this.#readSnapshot(
      snapshot => snapshot.tabs.map(googleDocTabMetadata),
      () => ({
        title: "List Google Doc tabs",
        description: "Read the document's tab names and hierarchy.",
      }));
  }

  async getContent(tabId?: string): Promise<string> {
    // The selector error says whether a tab exists, so a failed attempt discloses something too
    // and has to be authorized. It rides back as a value so one guarded read covers both outcomes.
    let selection = await this.#readSnapshot(
      (snapshot): { tab: GoogleDocTabSnapshot } | { error: unknown } => {
        try {
          return { tab: resolveGoogleDocTab(snapshot, tabId, "getContent") };
        } catch (error) {
          return { error };
        }
      },
      result => ({
        title: "Read Google Doc content",
        description: "tab" in result
          ? `Read the current content of tab ${googleDocTabLabel(result.tab)} as Markdown.`
          : "Read the content of one tab of the document.",
      }));
    if (!("tab" in selection)) throw selection.error;
    return selection.tab.markdown;
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

/** Drive RPC session implementation, exported for workerd contract coverage. */
@validateRpc()
export class GoogleDriveSessionImpl extends RpcTarget
    implements GoogleDriveSession, GoogleDriveFolderSession {
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
  #comments: DriveCommentQueue;

  constructor(
    driveApi: DriveApi,
    docsApi: GoogleDocsApi,
    sheetsApi: GoogleSheetsApi,
    slidesApi: GoogleSlidesApi,
    convertPdf: PdfConverter | undefined,
    scope: DriveBindingScope,
    approvalQueue: RpcStub<ApprovalQueue>,
    comments: DriveCommentQueue,
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
    this.#comments = comments;
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

  async openFolder(folderId: string): Promise<GoogleDriveFolderSession> {
    if (this.#scope.kind !== "folder") outsideScope();
    return this.#withQueue(async (queue, core) => {
      let location = await (core as DriveFolderSessionCore).openFolder(folderId);
      return new GoogleDriveSessionImpl(
        this.#driveApi, this.#docsApi, this.#sheetsApi, this.#slidesApi, this.#convertPdf,
        this.#scope, queue, this.#comments, location,
      );
    });
  }

  async openGoogleDoc(fileId: string): Promise<GoogleDocReadSession> {
    return this.#openNative(fileId, GOOGLE_DOC_MIME_TYPE, "Google Doc",
      (documentId, queue, read) =>
        new GoogleDocReadSessionImpl(this.#docsApi, this.#driveApi, documentId, queue, read));
  }

  async openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession> {
    return this.#openNative(fileId, GOOGLE_SHEET_MIME_TYPE, "Google Sheet",
      (spreadsheetId, queue, read) =>
        new GoogleSpreadsheetReadSessionImpl(this.#sheetsApi, spreadsheetId, queue, read));
  }

  async openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession> {
    return this.#openNative(fileId, GOOGLE_SLIDES_MIME_TYPE, "Google Slides presentation",
      (presentationId, queue, read) =>
        new GooglePresentationReadSessionImpl(this.#slidesApi, presentationId, queue, read));
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
      let pager = core.commentPager(id, fetch => this.#comments.undecided(async pending => {
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

  /** Refuses a write this binding may not make: it is read-only, or its account does not allow changes. */
  async #requireWritable(): Promise<void> {
    let refused = await this.#comments.writeRefusal();
    if (refused !== undefined) throw new Error(refused);
  }

  /**
   * Refuses a comment ID that is not one Drive gave: a `pending:` ID, by whether its comment still
   * awaits approval in this binding's queue, or anything that is not a comment ID at all.
   */
  async #requirePostedCommentId(commentId: string): Promise<void> {
    if (isPendingCommentId(commentId)) {
      throw new Error(await this.#comments.undecided(
        async pending => pendingCommentRefusal(commentId, pending)));
    }
    if (!isDriveCommentId(commentId)) throw new Error("Not a Google Drive comment ID.");
  }

  /** Whether this binding has a resolve of the comment waiting for approval. */
  #resolvePending(fileId: string, commentId: string): Promise<boolean> {
    return this.#comments.undecided(
      async pending => hasPendingResolve(fileId, commentId, pending));
  }

  /**
   * Checks and queues one comment write: the file is in scope, is not a folder, and the connected
   * account can comment on it, all before `prepare` builds the payload, and nothing is queued
   * until it has.
   */
  async #queueComment<K extends keyof DriveCommentActions>(
    fileId: string,
    kind: K,
    prepare: (target: CommentTarget, base: CommentTargetPayload) => Promise<DriveCommentActions[K]>,
  ): Promise<{ id: number; payload: DriveCommentActions[K] }> {
    let core = this.#core;
    let target = await core.commentTarget(fileId);
    // Before the account is asked whether it can comment: of a folder, Drive says it can.
    if (target.mimeType === FOLDER_MIME_TYPE) throw new Error(FOLDER_COMMENT_REFUSED);
    await core.requireCommentable(target.fileId);
    let payload = await prepare(target, {
      fileId: target.fileId,
      fileName: shownFileName(target.name),
      ...(target.folderIds ? { folderIds: target.folderIds } : {}),
      queuedAt: new Date().toISOString(),
    });
    let id = await this.#comments.submit(this.#approvalQueue, kind, payload);
    return { id, payload };
  }

  /**
   * The ID of the tab of a Google Doc in which `quote` occurs exactly once; with `wholeChips`, as
   * for text a suggestion replaces, refused when it takes in part of a chip. Reading the Doc is a
   * content read, authorized as one.
   */
  async #quotedTab(
    target: CommentTarget, quote: string, tabId: string | undefined, wholeChips = false,
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
      access: this.#comments.access,
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

  async #openNative<T>(
    fileId: string,
    mimeType: string,
    description: string,
    build: (id: string, queue: RpcStub<ApprovalQueue>, read: NativeRead) => T,
  ): Promise<T> {
    return this.#withQueue(async (queue, core) => {
      let id = await core.openNativeFile(fileId, mimeType, description);
      return build(id, queue, core.nativeRead(id, mimeType));
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

  async openGoogleDoc(_fileId: string): Promise<GoogleDocReadSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openGoogleSheet(_fileId: string): Promise<GoogleSpreadsheetReadSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async openGoogleSlides(_fileId: string): Promise<GooglePresentationReadSession> {
    throw new Error(UNCREATED_FOLDER);
  }

  async readPdf(_fileId: string): Promise<DrivePdfText> {
    throw new Error(UNCREATED_FOLDER);
  }

  async readFile(_fileId: string, _options?: DriveFileReadOptions): Promise<DriveFileBytes> {
    throw new Error(UNCREATED_FOLDER);
  }

  // A folder not created yet holds no file to read or write comments on. Its agent types are the
  // read-only ones, so the writes are here only for the session's declared shape.
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
