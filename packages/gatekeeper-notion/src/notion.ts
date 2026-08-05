// Notion gatekeeper.
//
// Provides Gadgets with capability-scoped access to a user's Notion workspace, a single page, or a
// single database. Auth is OAuth 2.0 (public connection). See types.d.ts for the Session API.
//
// Responsibilities implemented:
//  1-3. OAuth/credential management, the Notion API wrapper, and fine-grained resource granting
//       + configurator UI.
//  4. Logging & approvals — every observation calls approvalQueue.authorizeObservation() before
//     returning, and every side effect is staged via submitAction() and only performed in
//     applyAction(). See notion-actions.ts.
//  5. Caching — page/database responses and rendered page Markdown are cached in DO storage.
//  6. Simulation — reads overlay pending (submitted-but-unapplied) actions so a Gadget sees its own
//     writes immediately. List simulation has documented limitations (see types.d.ts).

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ApprovalQueue,
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
import {
  NotionApi,
  NotionApiError,
  commentToNotion,
  exchangeAuthCode,
  iconStringToInput,
  itemResponseToSummary,
  pageToMetadata,
  pageToSummary,
  parseNotionId,
  propertiesToValues,
  propertyValueToInput,
  refreshAccessToken,
  userResponseToUser,
  type NotionOAuthGrant,
} from "./notion-api";
import {
  NotionStore,
  applyStoredAction,
  defaultPropertiesFromSchema,
  observation,
  overlayChildPages,
  overlayDatabaseRows,
  overlaySearch,
  rejectStoredAction,
  revertStoredAction,
  stageAction,
  simulateComments,
  simulatePageContent,
  simulatePageMetadata,
  simulatePageProperties,
  type NotionAction,
} from "./notion-actions";
import type {
  Cursor,
  NotionComment,
  NotionCreateDatabasePageOptions,
  NotionCreatePageOptions,
  NotionDatabase as NotionDatabaseSession,
  NotionDatabaseMetadata,
  NotionDatabaseSchema,
  NotionIconInput,
  NotionItemSummary,
  NotionPage as NotionPageSession,
  NotionPageMetadata,
  NotionPageOptions,
  NotionPageSummary,
  NotionPropertyInput,
  NotionPropertyValue,
  NotionQueryFilter,
  NotionQueryOptions,
  NotionQuerySort,
  NotionSearchOptions,
  NotionUser,
  NotionWorkspace as NotionWorkspaceSession,
  NotionWorkspaceMetadata,
} from "./types";
import { NotionItemConfiguratorUI, NotionWorkspaceConfiguratorUI } from "./notion-configurators";
import NOTION_LOGO_SVG from "./notion-logo.svg";
import TYPES_CODE from "./types.txt";
import NOTION_ITEM_CONFIGURATOR_HTML from "./generated/notion-item-configurator-ui.txt";
import NOTION_WORKSPACE_CONFIGURATOR_HTML from "./generated/notion-workspace-configurator-ui.txt";

// ---------------------------------------------------------------------------------------------
// Constants & helpers

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type StoredAccountInfo = {
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
  ownerId?: string;
  ownerName?: string;
  ownerAvatar?: string;
};

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/notion");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // The early length check leaks length only; safe here since nonces are fixed-length 64-hex.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

const NOTION_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(NOTION_LOGO_SVG)}`;

const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Notion Workspace",
  description: "Search, read, and edit any page or database shared with this connection.",
};

const ITEM_RESOURCE: SupportedResource = {
  urlPattern: "https://www.notion.so/:path+",
  title: "Notion Page or Database",
  description: "Read and edit a specific Notion page or database (and its rows).",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [WORKSPACE_RESOURCE, ITEM_RESOURCE];

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
      <h1 style="color: #d97706; font-size: 1.5rem;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem;">Notion Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6;">Please configure a Notion OAuth client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// Extract a Notion object ID from a resource URL, or null if there isn't one (e.g. the
// whole-workspace catch-all URL).
function idFromResourceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)notion\.so$/i.test(parsed.hostname)) return null;
  if (stripTrailingSlashes(parsed.pathname).length === 0) return null;
  try {
    return parseNotionId(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP handler — OAuth initiation + completion.

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
      // Auth initiation: user visited the connect URL.
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const authUrl = new URL("https://api.notion.com/v1/oauth/authorize");
      authUrl.searchParams.set("client_id", env.CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("owner", "user");
      authUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(authUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect from Notion.
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`Authorization failed: ${error}`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
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
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Notion",
      url: "https://www.notion.so",
      logo: { url: NOTION_LOGO_URL },
      color: "#f7f6f3",
      tagline: "Read and write your Notion pages and databases",
      description:
          "Connect your Notion workspace to let Cloudflare OS search, read, and edit the pages and " +
          "databases you share. Build agents that draft documents, organize notes, or manage " +
          "database records.",
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

// ---------------------------------------------------------------------------------------------
// UserAccount DO — OAuth credential management.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string) {
    if (!this.ctx.storage.kv.get<string>("accessToken")) {
      this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Prepare this account for a reconnect: the next acceptAuthCode() replaces credentials and
  // notifies via credentialsRestored() instead of complete().
  async prepareReconnect(initiationNonce: string) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Verify & consume the initiation nonce, returning a fresh OAuth nonce. Returns null if invalid.
  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { oauthNonce };
  }

  // Exchange the auth code for tokens. Returns false if the OAuth nonce is invalid/expired.
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Notion Gatekeeper is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(
        code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");

    this.#storeGrant(grant);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("accessToken");
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
    }
    return true;
  }

  #storeGrant(grant: NotionOAuthGrant) {
    this.ctx.storage.kv.put<string>("accessToken", grant.accessToken);
    if (grant.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<StoredAccountInfo>("accountInfo", {
      workspaceId: grant.workspaceId,
      workspaceName: grant.workspaceName,
      workspaceIcon: grant.workspaceIcon,
      ownerId: grant.owner?.id,
      ownerName: grant.owner?.name,
      ownerAvatar: grant.owner?.avatarUrl,
    });
  }

  // Returns a usable access token. Notion access tokens are long-lived; if one ever expires, the
  // caller should invoke refreshCredentials().
  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    if (!token) throw new Error("No Notion credentials set.");
    return token;
  }

  // Rotate the access token using the stored refresh token. Notifies the Workshop (once) that
  // credentials have expired whenever rotation is impossible or rejected, so the UI can prompt a
  // reconnect. Always throws when it can't produce a fresh token.
  async refreshCredentials(): Promise<string> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Notion Gatekeeper is not configured.");
    }
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      // Long-lived token was revoked and there's nothing to refresh with — surface as expiry.
      this.#notifyExpired();
      throw new NotionApiError(401, "Notion credentials are no longer valid. Please reconnect.");
    }
    try {
      const grant = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      this.#storeGrant(grant);
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsRestored().catch(() => {});
      return grant.accessToken;
    } catch (err) {
      // Notion returns 401 or 400 (invalid_grant) for a dead refresh token; treat both as expiry.
      if (err instanceof NotionApiError && (err.isAuthError || err.status === 400)) {
        this.#notifyExpired();
      }
      throw err;
    }
  }

  #notifyExpired() {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    callback?.credentialsExpired().catch(() => {});
  }

  async getAccountInfo(): Promise<StoredAccountInfo> {
    return this.ctx.storage.kv.get<StoredAccountInfo>("accountInfo") ?? {};
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<string>("accessToken")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------------------------
// UserImpl — resource URL -> gatekeeper class mapping.

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  #getToken = async (): Promise<string> => {
    return await this.#userAccount().getAccessToken();
  };

  async describe(): Promise<AccountDescription> {
    const info = await this.#userAccount().getAccountInfo();
    return {
      displayName: info.workspaceName ?? info.ownerName ?? "Notion",
      uniqueName: info.ownerName,
      avatar: { url: info.workspaceIcon ?? info.ownerAvatar ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Notion does not provide a reliably verified email for sign-in; not an auth provider.
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const id = idFromResourceUrl(url);
    if (id) {
      const props: NotionItemGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        itemId: id,
      };
      return { class: this.ctx.exports.NotionItemGatekeeperImpl({ props }), resource: ITEM_RESOURCE };
    }
    const props: NotionWorkspaceGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
    };
    return {
      class: this.ctx.exports.NotionWorkspaceGatekeeperImpl({ props }),
      resource: WORKSPACE_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === ITEM_RESOURCE.urlPattern) {
      return {
        iframeHtml: NOTION_ITEM_CONFIGURATOR_HTML,
        ui: new RpcStub(new NotionItemConfiguratorUI(this.#getToken)),
      };
    }
    if (resourceUrlPattern === WORKSPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: NOTION_WORKSPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new NotionWorkspaceConfiguratorUI(this.#getToken)),
      };
    }
    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  // Mint a verifier representing this account, used by the Notion gatekeepers' addObserver to confirm
  // a prospective observer may read a bound page/database (and, for workspace bindings, the workspace
  // and each accessed item). The verifier carries this user's own account id, so the access checks
  // run against the observer's *own* Notion token.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: NotionVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.NotionVerifier({ props });
  }
}

// ---------------------------------------------------------------------------------------------
// Verifier
//
// Notion uses the "ACL check (single unit)" strategy for page/database (item) bindings and "data-set
// tracking (by page/database)" for workspace bindings (see the gatekeepers' observer methods). Both
// reduce to per-observer access questions answered against the observer's *own* token:
//   - hasWorkspaceAccess(workspaceId): the observer's connection belongs to the same Notion
//     workspace. Gates workspace-level reads (the workspace name and member directory) that any
//     workspace member may see.
//   - hasItemAccess(itemId): the observer's connection can retrieve the page/database. Notion returns
//     404 (object_not_found) / 403 (restricted_resource) for items a connection cannot see, so a
//     successful retrieve means the observer has at least read access. Note this checks the
//     observer's *connection* grant (the pages they shared with their Gadgets connection), which is
//     the only per-observer oracle available and is conservative (it never grants more than the
//     observer's connection can actually reach).
// The overseer only ever hands this verifier back to a Notion gatekeeper, which may therefore trust
// the boolean results.

type NotionVerifierProps = {
  userObjectId: string;
};

// The non-standard methods the Notion gatekeepers call on their own verifier (see addObserver). Not
// part of the generic GatekeeperUserVerifier contract.
export interface NotionVerifierApi extends GatekeeperUserVerifier {
  hasWorkspaceAccess(workspaceId: string): Promise<boolean>;
  hasItemAccess(itemId: string): Promise<boolean>;
}

@validateRpc()
export class NotionVerifier extends WorkerEntrypoint<Env, NotionVerifierProps>
    implements NotionVerifierApi {
  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #api(): NotionApi {
    const account = () => this.#account();
    return new NotionApi(
      async () => await account().getAccessToken(),
      async () => await account().refreshCredentials(),
    );
  }

  async hasWorkspaceAccess(workspaceId: string): Promise<boolean> {
    const info = await this.#account().getAccountInfo();
    // Fail closed if either side's workspace id is unknown (e.g. an account connected before workspace
    // ids were persisted): the observer must reconnect before they can be admitted.
    return !!info.workspaceId && info.workspaceId === workspaceId;
  }

  async hasItemAccess(itemId: string): Promise<boolean> {
    try {
      await this.#api().detectKind(itemId);
      return true;
    } catch (error) {
      if (error instanceof NotionApiError &&
          (error.status === 404 || error.status === 403 || error.status === 400 ||
           error.isAuthError || error.code === "restricted_resource")) {
        return false;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Observation authorization with observer tracking.

// Computes the observer ids that must be excluded from an observation revealing the given item(s),
// or undefined if none. Item bindings pass no hook (single ACL unit, nothing to exclude); the
// workspace gatekeeper passes one that records the items as observed data sets and excludes observers
// lacking access to a newly-seen one. The hook is queue-independent, so the same reference is shared
// by every (sub-)session of a binding.
type ItemObservationCheck = {
  excludeObservers?: string[];
  pendingItems: string[];
  commit(): void;
};
type ObserveHook = (itemIds: string[]) => Promise<ItemObservationCheck>;
type ObservedItemState = true | "pending" | "observed";

// Authorize an observation that reveals data belonging to specific item(s). For workspace bindings
// this also tracks those items as observed data sets and excludes observers lacking access to a
// newly-seen one; for item bindings it is a plain authorizeObservation. `itemIds` may be empty for
// workspace-level reads (workspace name, member directory) any member may see, and for "open"
// observations that reveal no item data yet (the real data reads are tracked by the returned
// sub-session). Provisional (not-yet-created) ids should be filtered out by the caller, since they
// are not real Notion items the observer could be checked against.
async function authorizeItemObservation(
  queue: RpcStub<ApprovalQueue>,
  observe: ObserveHook | undefined,
  itemIds: string[],
  description: ObservationDescription,
): Promise<void> {
  const check = observe && itemIds.length > 0
    ? await observe(itemIds)
    : {pendingItems: [], commit() {}};
  await queue.authorizeObservation({ ...description, excludeObservers: check.excludeObservers });
  check.commit();
}

// ---------------------------------------------------------------------------------------------
// Gatekeeper DO instances.

type NotionItemGatekeeperImplProps = {
  userObjectId: string;
  itemId: string;
};

@validateRpc()
export class NotionItemGatekeeperImpl extends DurableObject<Env, NotionItemGatekeeperImplProps>
    implements Gatekeeper<NotionPageSession | NotionDatabaseSession> {
  #api(): NotionApi {
    const userObjectId = this.ctx.props.userObjectId;
    const account = () =>
      this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return new NotionApi(
      async () => await account().getAccessToken(),
      async () => await account().refreshCredentials(),
    );
  }

  #store(): NotionStore {
    return new NotionStore(this.ctx.storage.kv, this.#api());
  }

  async #kind(): Promise<"page" | "database"> {
    const cached = this.ctx.storage.kv.get<"page" | "database">("kind");
    if (cached) return cached;
    const kind = await this.#api().detectKind(this.ctx.props.itemId);
    this.ctx.storage.kv.put("kind", kind);
    return kind;
  }

  async describe(): Promise<ResourceDescription> {
    const api = this.#api();
    const kind = await this.#kind();
    if (kind === "database") {
      const db = await api.retrieveDatabase(this.ctx.props.itemId);
      const summary = itemResponseToSummary(db);
      return {
        url: summary.url,
        title: summary.title || "Untitled database",
        snippet: "Notion database",
        suggestedBindingName: "NOTION_DATABASE",
        tsType: "NotionDatabase",
      };
    }
    const page = await api.retrievePage(this.ctx.props.itemId);
    const meta = pageToMetadata(page);
    return {
      url: meta.url,
      title: meta.title || "Untitled page",
      snippet: "Notion page",
      suggestedBindingName: "NOTION_PAGE",
      tsType: "NotionPage",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<NotionPageSession | NotionDatabaseSession> {
    const store = this.#store();
    const kind = await this.#kind();
    if (kind === "database") {
      return new NotionDatabaseSessionImpl(store, approvalQueue.dup(), this.ctx.props.itemId);
    }
    return new NotionPageSessionImpl(store, approvalQueue.dup(), this.ctx.props.itemId);
  }

  // Observer tracking — "ACL check (single unit)". The binding is one page or database, so we just
  // confirm the observer can retrieve it with their own token (hasItemAccess). A page's subtree and a
  // database's rows inherit its access, so the bound item is the atomic unit: nothing read later could
  // be outside it, so no observers are tracked and removeObserver is a no-op. The overseer re-runs
  // addObserver on every open, catching loss of access promptly.
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<NotionVerifierApi>;
    if (!(await verifier.hasItemAccess(this.ctx.props.itemId))) {
      throw new Error(
        "This collaborator does not have access to the bound Notion page/database, so they cannot " +
        "be allowed to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    await applyStoredAction(this.#store(), action);
  }

  async rejectAction(action: number): Promise<void | { restart?: boolean }> {
    return rejectStoredAction(this.#store(), action);
  }

  async revertAction(action: number) {
    return await revertStoredAction(this.#store(), action);
  }
}

type NotionWorkspaceGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class NotionWorkspaceGatekeeperImpl
    extends DurableObject<Env, NotionWorkspaceGatekeeperImplProps>
    implements Gatekeeper<NotionWorkspaceSession> {
  #api(): NotionApi {
    const userObjectId = this.ctx.props.userObjectId;
    const account = () =>
      this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return new NotionApi(
      async () => await account().getAccessToken(),
      async () => await account().refreshCredentials(),
    );
  }

  #store(): NotionStore {
    return new NotionStore(this.ctx.storage.kv, this.#api());
  }

  async describe(): Promise<ResourceDescription> {
    const info = await this.ctx.exports.UserAccount
        .get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId))
        .getAccountInfo();
    return {
      url: "https://www.notion.so/",
      title: info.workspaceName ? `${info.workspaceName} (Notion)` : "Notion workspace",
      snippet: "Every page and database shared with this connection.",
      suggestedBindingName: "NOTION_WORKSPACE",
      tsType: "NotionWorkspace",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<NotionWorkspaceSession> {
    const info = await this.ctx.exports.UserAccount
        .get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId))
        .getAccountInfo();
    const authorizedBy: NotionUser | null = info.ownerId
      ? { id: info.ownerId, name: info.ownerName, avatarUrl: info.ownerAvatar, type: "person" }
      : null;
    return new NotionWorkspaceSessionImpl(
      this.#store(), approvalQueue.dup(), authorizedBy,
      itemIds => this.#prepareItemObservation(itemIds));
  }

  // -------------------------------------------------------------------------
  // Observer tracking — "data-set tracking (by page/database)". Workspace members may have shared
  // different pages/databases with their connections, so we track which items' data the Gadget has
  // actually observed and verify each observer against them. addObserver requires the observer to be
  // in the same Notion workspace (so workspace-level metadata and the member directory are fine to
  // show) plus access to every already-observed item; later, the first observation of a *new* item
  // excludes any observer lacking it (see #prepareItemObservation). Verified observers are remembered
  // (their verifier stored) so that forward-exclusion re-check can run. The overseer re-runs
  // addObserver on every open, catching loss of access promptly.

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedItemKey(itemId: string): string { return `observedItem:${normalizeId(itemId)}`; }

  #isItemObserved(itemId: string): boolean {
    const state = this.ctx.storage.kv.get<ObservedItemState>(this.#observedItemKey(itemId));
    return state === true || state === "observed";
  }

  #listTrackedItems(): string[] {
    const prefix = "observedItem:";
    return [...this.ctx.storage.kv.list<ObservedItemState>({ prefix })]
      .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<NotionVerifierApi>]> {
    const prefix = "observer:";
    for (const [key, verifier] of this.ctx.storage.kv.list<Fetcher<NotionVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Marks unknown items pending and returns current observers who cannot access any pending item in
  // this attempt. Authorization promotes them; failed attempts remain pending and are rechecked.
  async #prepareItemObservation(itemIds: string[]): Promise<ItemObservationCheck> {
    const pendingItems = [...new Set(itemIds)].filter(id => !this.#isItemObserved(id));
    if (pendingItems.length === 0) return {pendingItems, commit() {}};
    for (const itemId of pendingItems) {
      const key = this.#observedItemKey(itemId);
      if (this.ctx.storage.kv.get<ObservedItemState>(key) === undefined) {
        this.ctx.storage.kv.put(key, "pending");
      }
    }
    const observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      const access = await Promise.all(pendingItems.map(itemId => verifier.hasItemAccess(itemId)));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    const excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingItems,
      commit: () => {
        for (const itemId of pendingItems) {
          this.ctx.storage.kv.put(this.#observedItemKey(itemId), "observed");
        }
      },
    };
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<NotionVerifierApi>;
    const workspaceId = (await this.ctx.exports.UserAccount
        .get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId))
        .getAccountInfo()).workspaceId;
    if (!workspaceId) {
      throw new Error(
        "This Notion connection predates workspace-id tracking; please disconnect and reconnect " +
        "the owning Notion account before sharing this workspace.");
    }
    if (!(await verifier.hasWorkspaceAccess(workspaceId))) {
      throw new Error(
        "This collaborator is not a member of this Notion workspace, so they cannot be allowed to " +
        "observe it.");
    }
    const checked = new Set<string>();
    while (true) {
      const itemIds = this.#listTrackedItems().filter(itemId => !checked.has(itemId));
      if (itemIds.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      const itemAccess = await Promise.all(itemIds.map(itemId => verifier.hasItemAccess(itemId)));
      if (itemAccess.some(hasAccess => !hasAccess)) {
        throw new Error(
          "This collaborator does not have access to a Notion page/database whose data this workspace " +
          "has read, so they cannot be allowed to observe it.");
      }
      for (const itemId of itemIds) checked.add(itemId);
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }

  async applyAction(action: number): Promise<void> {
    await applyStoredAction(this.#store(), action);
  }

  async rejectAction(action: number): Promise<void | { restart?: boolean }> {
    return rejectStoredAction(this.#store(), action);
  }

  async revertAction(action: number) {
    return await revertStoredAction(this.#store(), action);
  }
}

// ---------------------------------------------------------------------------------------------
// Cursor

@validateRpc()
class PagedCursor<T> extends RpcTarget implements Cursor<T> {
  #fetchPage: (cursor: string | undefined, firstPage: boolean) =>
    Promise<{ items: T[]; nextCursor: string | undefined }>;
  #cursor: string | undefined = undefined;
  #first = true;
  #done = false;

  constructor(
    fetchPage: (cursor: string | undefined, firstPage: boolean) =>
      Promise<{ items: T[]; nextCursor: string | undefined }>,
  ) {
    super();
    this.#fetchPage = fetchPage;
  }

  async next(): Promise<T[] | null> {
    if (this.#done) return null;
    const { items, nextCursor } = await this.#fetchPage(this.#cursor, this.#first);
    this.#first = false;
    if (nextCursor) this.#cursor = nextCursor;
    else this.#done = true;
    return items;
  }
}

// Recursively collect child_page / child_database blocks from a fetched block tree, so sub-pages
// nested inside columns/toggles are surfaced by listChildPages.
function collectChildPages(
  tree: import("./notion-api").BlockWithChildren[],
  out: NotionItemSummary[],
): void {
  for (const node of tree) {
    const block = node.block as Record<string, any>;
    const type = block.type as string;
    if (type === "child_page" || type === "child_database") {
      out.push({
        kind: type === "child_database" ? "database" : "page",
        id: block.id,
        title: block[type]?.title ?? "Untitled",
        url: `https://www.notion.so/${String(block.id).replace(/-/g, "")}`,
        createdAt: new Date(block.created_time ?? Date.now()),
        lastEditedAt: new Date(block.last_edited_time ?? Date.now()),
      });
    }
    if (node.children && node.children.length > 0) collectChildPages(node.children, out);
  }
}

function clampPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  return Math.max(1, Math.min(100, Math.floor(pageSize)));
}

// Dispose an owned ApprovalQueue stub. Each session owns its own dup() and releases it when the
// gadget disposes the session stub.
function disposeQueue(stub: RpcStub<ApprovalQueue>): void {
  (stub as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

// ---------------------------------------------------------------------------------------------
// Sessions

@validateRpc()
class NotionPageSessionImpl extends RpcTarget implements NotionPageSession {
  #store: NotionStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pageId: string;
  // Undefined for page bindings (single ACL unit); set for workspace bindings to track this page as
  // an observed data set and exclude observers who lack access to it. Shared by all sub-sessions.
  #observe?: ObserveHook;

  constructor(
    store: NotionStore, approvalQueue: RpcStub<ApprovalQueue>, pageId: string, observe?: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#pageId = pageId;
    this.#observe = observe;
  }

  [Symbol.dispose]() {
    disposeQueue(this.#approvalQueue);
  }

  // True when this page is provisional (created in this session) and not yet applied on Notion.
  #isProvisional(): boolean {
    return NotionStore.isProvisional(this.#store.resolveId(this.#pageId));
  }

  // A short identifier for this page, for approval/audit descriptions (resolved real ID if known).
  #ref(): string {
    return this.#store.resolveId(this.#pageId);
  }

  // The observed data set(s) for a read of this page: the resolved page id, or empty for a still
  // provisional (not-yet-created) page whose data is the gadget's own staged content, not a real item.
  #itemIds(): string[] {
    return this.#isProvisional() ? [] : [this.#store.resolveId(this.#pageId)];
  }

  async #baseMetadata(): Promise<NotionPageMetadata | null> {
    if (this.#isProvisional()) return null;
    return pageToMetadata(await this.#store.getPageResponse(this.#pageId));
  }

  async #baseProperties(): Promise<Record<string, NotionPropertyValue> | null> {
    if (this.#isProvisional()) return null;
    return propertiesToValues((await this.#store.getPageResponse(this.#pageId)).properties);
  }

  #stage(action: NotionAction): Promise<number> {
    return stageAction(this.#store, this.#approvalQueue, action);
  }

  // Page metadata only carries partial `{id}` users; resolve them to the full NotionUser for parity
  // with getProperties()/listUsers().
  async #resolveUser(user: NotionUser | null): Promise<NotionUser | null> {
    if (!user || user.name !== undefined) return user;
    try {
      return await this.#store.getUser(user.id);
    } catch {
      return user;
    }
  }

  async getMetadata(): Promise<NotionPageMetadata> {
    const records = this.#store.pendingForPage(this.#pageId);
    const meta = simulatePageMetadata(await this.#baseMetadata(), this.#pageId, records);
    meta.createdBy = await this.#resolveUser(meta.createdBy);
    meta.lastEditedBy = await this.#resolveUser(meta.lastEditedBy);
    await authorizeItemObservation(this.#approvalQueue, this.#observe, this.#itemIds(),
      observation("Read Notion page", `Read metadata for Notion page “${meta.title || "Untitled"}”.`));
    return meta;
  }

  async getProperties(): Promise<Record<string, NotionPropertyValue>> {
    const records = this.#store.pendingForPage(this.#pageId);
    // For a provisional row, seed the full parent-database column set (with defaults) so an
    // unapproved row has the same shape as it will after approval.
    let seed: Record<string, NotionPropertyValue> | undefined;
    if (this.#isProvisional()) {
      const dbId = await this.#parentDatabaseId();
      if (dbId) seed = defaultPropertiesFromSchema(await this.#store.getDatabaseSchema(dbId));
    }
    const props = simulatePageProperties(await this.#baseProperties(), records, seed);
    const titleVal = Object.values(props).find(v => v.type === "title");
    const label = titleVal?.type === "title" && titleVal.text ? `“${titleVal.text}”` : this.#ref();
    await authorizeItemObservation(this.#approvalQueue, this.#observe, this.#itemIds(),
      observation("Read Notion page properties", `Read the property values of Notion page ${label}.`));
    return props;
  }

  async getContent(): Promise<string> {
    const base = this.#isProvisional() ? null : await this.#store.getPageContent(this.#pageId);
    const content = simulatePageContent(base, this.#store.pendingForPage(this.#pageId));
    await authorizeItemObservation(this.#approvalQueue, this.#observe, this.#itemIds(),
      observation("Read Notion page content", `Read the body content of Notion page ${this.#ref()}.`));
    return content;
  }

  async listChildPages(options?: NotionPageOptions): Promise<Cursor<NotionItemSummary>> {
    const pageSize = clampPageSize(options?.pageSize) ?? 100;
    const store = this.#store;
    const approvalQueue = this.#approvalQueue;
    const observe = this.#observe;
    const pageId = this.#pageId;
    const provisional = this.#isProvisional();
    // Walk the block tree so sub-pages nested inside layout containers (columns, toggles, etc.) are
    // found, not just direct children. The full set is gathered once (one observation), then served
    // in `pageSize` chunks through the cursor.
    let all: NotionItemSummary[] | null = null;
    let offset = 0;
    return new PagedCursor<NotionItemSummary>(async () => {
      if (all === null) {
        const collected: NotionItemSummary[] = [];
        if (!provisional) {
          const tree = await store.api.fetchBlockTree(store.resolveId(pageId));
          collectChildPages(tree, collected);
        }
        all = overlayChildPages(collected, pageId, store, true);
        // The listing reveals each (real) child item's existence/title, so attribute it to the parent
        // page plus the child pages/databases themselves.
        const itemIds = provisional ? [] : [
          store.resolveId(pageId),
          ...all.filter(c => !NotionStore.isProvisional(c.id)).map(c => c.id),
        ];
        await authorizeItemObservation(approvalQueue, observe, itemIds,
          observation("List Notion child pages", `List the sub-pages of Notion page ${store.resolveId(pageId)}.`));
      }
      const slice = all.slice(offset, offset + pageSize);
      offset += slice.length;
      return { items: slice, nextCursor: offset < all.length ? String(offset) : undefined };
    });
  }

  async appendContent(markdown: string): Promise<void> {
    await this.#stage({ type: "appendContent", pageId: this.#pageId, markdown });
  }

  async setTitle(title: string): Promise<void> {
    const records = this.#store.pendingForPage(this.#pageId);
    const previousTitle = simulatePageMetadata(await this.#baseMetadata(), this.#pageId, records).title;
    await this.#stage({ type: "setTitle", pageId: this.#pageId, title, previousTitle });
  }

  // Resolve the database ID this page belongs to (for property validation), or null for a
  // standalone page. For a still-pending page we read its parent from the queued creation, since
  // the page doesn't exist on the server yet.
  async #parentDatabaseId(): Promise<string | null | undefined> {
    if (this.#isProvisional()) {
      const create = this.#store.pendingForPage(this.#pageId).find(r => r.action.type === "createPage");
      const action = create?.action;
      if (action?.type !== "createPage") return undefined; // unknown — skip validation
      return action.parent.kind === "database" ? action.parent.databaseId : null;
    }
    const page = await this.#store.getPageResponse(this.#pageId);
    return page.parent?.type === "database_id" ? page.parent.database_id : null;
  }

  async setProperties(properties: Record<string, NotionPropertyInput>): Promise<void> {
    // Validate against the parent database's schema (fail fast, before the human approves) — works
    // for both existing pages and pages whose creation is still pending in this session.
    // NOTE: this reads the schema from Notion on a write path; it's deliberately not logged as an
    // observation since no schema data is returned to the caller (used only for validation).
    const parentDbId = await this.#parentDatabaseId();
    if (parentDbId) {
      validateProperties(await this.#store.getDatabaseSchema(parentDbId), properties);
    } else if (parentDbId === null && Object.keys(properties).length > 0) {
      throw new NotionApiError(
        400,
        "This page is not a database row, so it has no editable properties. Use setTitle() to " +
        "change its title.");
    }
    const records = this.#store.pendingForPage(this.#pageId);
    const current = simulatePageProperties(await this.#baseProperties(), records);
    const previousProperties: Record<string, NotionPropertyInput> = {};
    for (const name of Object.keys(properties)) {
      const prev = current[name] ? propertyValueToInput(current[name]) : null;
      if (prev) previousProperties[name] = prev;
    }
    await this.#stage({ type: "setProperties", pageId: this.#pageId, properties, previousProperties });
  }

  async setIcon(icon: NotionIconInput | null): Promise<void> {
    if (icon) assertValidIcon(icon);
    const records = this.#store.pendingForPage(this.#pageId);
    const meta = simulatePageMetadata(await this.#baseMetadata(), this.#pageId, records);
    await this.#stage({
      type: "setIcon",
      pageId: this.#pageId,
      icon,
      previousIcon: iconStringToInput(meta.icon),
    });
  }

  async createSubPage(options: NotionCreatePageOptions): Promise<NotionPageSession> {
    if (options.icon) assertValidIcon(options.icon);
    const provisionalId = this.#store.nextProvisionalId();
    const action: NotionAction = {
      type: "createPage",
      provisionalId,
      parent: { kind: "page", pageId: this.#pageId },
      title: options.title,
      content: options.content,
      icon: options.icon,
    };
    await this.#stage(action);
    return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), provisionalId, this.#observe);
  }

  async archive(): Promise<void> {
    await this.#stage({ type: "archive", pageId: this.#pageId });
  }

  async restore(): Promise<void> {
    await this.#stage({ type: "restore", pageId: this.#pageId });
  }

  async listComments(options?: NotionPageOptions): Promise<Cursor<NotionComment>> {
    const pageSize = clampPageSize(options?.pageSize);
    const store = this.#store;
    const approvalQueue = this.#approvalQueue;
    const observe = this.#observe;
    const pageId = this.#pageId;
    const provisional = this.#isProvisional();
    const itemIds = provisional ? [] : [store.resolveId(pageId)];
    return new PagedCursor<NotionComment>(async (cursor, firstPage) => {
      let items: NotionComment[] = [];
      let nextCursor: string | undefined;
      if (!provisional) {
        let result;
        try {
          result = await store.api.listComments(store.resolveId(pageId), cursor, pageSize);
        } catch (err) {
          if (err instanceof NotionApiError && (err.status === 403 || err.code === "restricted_resource")) {
            throw new NotionApiError(
              403,
              "Reading comments isn't available: this Notion connection lacks the \"Read comments\" " +
              "capability. Enable it in the integration's settings, then reconnect.",
              err.code);
          }
          throw err;
        }
        items = result.results.map(commentToNotion);
        nextCursor = result.has_more ? result.next_cursor ?? undefined : undefined;
      }
      // Pending comments are only surfaced on the first batch to avoid duplication.
      if (firstPage) items = simulateComments(items, store.pendingForPage(pageId));
      await authorizeItemObservation(approvalQueue, observe, itemIds,
        observation("Read Notion page comments", `Read the comment thread on Notion page ${store.resolveId(pageId)}.`));
      return { items, nextCursor };
    });
  }

  async addComment(text: string): Promise<void> {
    await this.#stage({ type: "addComment", pageId: this.#pageId, text });
  }
}

@validateRpc()
class NotionDatabaseSessionImpl extends RpcTarget implements NotionDatabaseSession {
  #store: NotionStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #databaseId: string;
  // Undefined for database bindings (single ACL unit); set for workspace bindings to track this
  // database as an observed data set. Shared by sub-sessions (rows opened via getPage/createPage).
  #observe?: ObserveHook;

  constructor(
    store: NotionStore, approvalQueue: RpcStub<ApprovalQueue>, databaseId: string, observe?: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#databaseId = databaseId;
    this.#observe = observe;
  }

  [Symbol.dispose]() {
    disposeQueue(this.#approvalQueue);
  }

  async getMetadata(): Promise<NotionDatabaseMetadata> {
    const db = await this.#store.getDatabaseResponse(this.#databaseId);
    const summary = itemResponseToSummary(db);
    const metadata: NotionDatabaseMetadata = {
      id: db.id,
      title: summary.title || "Untitled database",
      url: summary.url,
      createdAt: summary.createdAt,
      lastEditedAt: summary.lastEditedAt,
    };
    const description = (db.description ?? []).map(r => r.plain_text ?? r.text?.content ?? "").join("");
    if (description) metadata.description = description;
    if (summary.icon) metadata.icon = summary.icon;
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [this.#databaseId],
      observation("Read Notion database", `Read metadata for Notion database “${metadata.title}”.`));
    return metadata;
  }

  async getSchema(): Promise<NotionDatabaseSchema> {
    const schema = await this.#store.getDatabaseSchema(this.#databaseId);
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [this.#databaseId],
      observation("Read Notion database schema", "Read the property schema of a Notion database."));
    return schema;
  }

  async query(options?: NotionQueryOptions): Promise<Cursor<NotionPageSummary>> {
    const pageSize = clampPageSize(options?.pageSize);
    const store = this.#store;
    const approvalQueue = this.#approvalQueue;
    const observe = this.#observe;
    const databaseId = this.#databaseId;
    // Resolve the schema so filters use each property's real type (not a guess from the condition),
    // and resolve the database's primary data source — rows are queried on the data source, which
    // is required for newer multi-source / Meeting Notes / wiki databases.
    const schema = await this.#store.getDatabaseSchema(this.#databaseId);
    const dataSourceId = await this.#store.getDataSourceId(this.#databaseId);
    const typeOf = (name: string) => schema.properties[name]?.type;
    const filter = options?.filter ? filterToNotion(options.filter, typeOf) : undefined;
    const sorts = options?.sorts?.map(sortToNotion);
    const seed = defaultPropertiesFromSchema(schema);
    return new PagedCursor<NotionPageSummary>(async (cursor, firstPage) => {
      const result = await store.api.queryDataSource(dataSourceId, {
        filter,
        sorts,
        start_cursor: cursor,
        page_size: pageSize,
      });
      const rows = overlayDatabaseRows(result.results.map(pageToSummary), databaseId, store, firstPage, seed);
      // A query reveals row data, which is gated by access to the database (rows inherit it), so the
      // database is the data set.
      await authorizeItemObservation(approvalQueue, observe, [databaseId],
        observation("Query Notion database", `Query rows from Notion database ${store.resolveId(databaseId)}.`));
      return { items: rows, nextCursor: result.has_more ? result.next_cursor ?? undefined : undefined };
    });
  }

  async getPage(idOrUrl: string): Promise<NotionPageSession> {
    // Authorize before touching Notion so this can't be used as an existence oracle for pages
    // outside this database's grant. This "open" reveals no row data itself (that is read through the
    // returned session, which tracks the row), so it carries no item attribution.
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [],
      observation("Open Notion database row", "Open a page (row) in a Notion database."));

    // A provisional handle (row created earlier in this session, not yet approved): rehydrate it if
    // its queued creation targets this database.
    if (NotionStore.isProvisional(idOrUrl)) {
      const action = this.#store.createActionFor(idOrUrl)?.action;
      if (!action || action.type !== "createPage" || action.parent.kind !== "database" ||
          normalizeId(action.parent.databaseId) !== normalizeId(this.#databaseId)) {
        throw new NotionApiError(404, "No such page (row) in this database.");
      }
      return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), idOrUrl, this.#observe);
    }

    const id = parseNotionId(idOrUrl);
    // Normalize "doesn't exist" and "exists but not a row here" to one indistinguishable error so
    // the caller can't probe arbitrary workspace pages through a database-scoped capability.
    let page;
    try {
      page = await this.#store.getPageResponse(id);
    } catch {
      throw new NotionApiError(404, "No such page (row) in this database.");
    }
    const parent = page.parent;
    if (!parent || parent.type !== "database_id" ||
        normalizeId(parent.database_id) !== normalizeId(this.#databaseId)) {
      throw new NotionApiError(404, "No such page (row) in this database.");
    }
    return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), id, this.#observe);
  }

  async createPage(options: NotionCreateDatabasePageOptions): Promise<NotionPageSession> {
    if (options.icon) assertValidIcon(options.icon);
    const schema = await this.#store.getDatabaseSchema(this.#databaseId);
    if (options.properties && Object.keys(options.properties).length > 0) {
      validateProperties(schema, options.properties);
    }
    const provisionalId = this.#store.nextProvisionalId();
    const action: NotionAction = {
      type: "createPage",
      provisionalId,
      parent: { kind: "database", databaseId: this.#databaseId },
      title: options.title,
      properties: options.properties,
      content: options.content,
      icon: options.icon,
      titlePropertyName: titlePropertyNameOf(schema),
    };
    await stageAction(this.#store, this.#approvalQueue, action);
    return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), provisionalId, this.#observe);
  }
}

// The name of a database's title column (the property whose type is "title"), e.g. "Name".
function titlePropertyNameOf(schema: NotionDatabaseSchema): string | undefined {
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "title") return name;
  }
  return undefined;
}

@validateRpc()
class NotionWorkspaceSessionImpl extends RpcTarget implements NotionWorkspaceSession {
  #store: NotionStore;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #authorizedBy: NotionUser | null;
  #observe: ObserveHook;

  constructor(
    store: NotionStore, approvalQueue: RpcStub<ApprovalQueue>, authorizedBy: NotionUser | null,
    observe: ObserveHook,
  ) {
    super();
    this.#store = store;
    this.#approvalQueue = approvalQueue;
    this.#authorizedBy = authorizedBy;
    this.#observe = observe;
  }

  [Symbol.dispose]() {
    disposeQueue(this.#approvalQueue);
  }

  async getMetadata(): Promise<NotionWorkspaceMetadata> {
    const bot = await this.#store.api.getBotUser();
    const metadata: NotionWorkspaceMetadata = { authorizedBy: this.#authorizedBy };
    if (bot.workspaceName) metadata.name = bot.workspaceName;
    // The workspace's name is visible to any workspace member, so no item attribution is needed (the
    // baseline workspace-membership check in addObserver covers it).
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [],
      observation("Read Notion workspace info", "Read the connected Notion workspace's name."));
    return metadata;
  }

  async search(options?: NotionSearchOptions): Promise<Cursor<NotionItemSummary>> {
    const pageSize = clampPageSize(options?.pageSize);
    const store = this.#store;
    const approvalQueue = this.#approvalQueue;
    const observe = this.#observe;
    const sort = options?.sort
      ? {
          direction: (options.sort === "lastEditedAscending" ? "ascending" : "descending") as
            "ascending" | "descending",
          timestamp: "last_edited_time" as const,
        }
      : undefined;
    const filter = options?.filter
      ? { property: "object" as const, value: options.filter }
      : undefined;
    return new PagedCursor<NotionItemSummary>(async (cursor, firstPage) => {
      const result = await store.api.search({
        query: options?.query,
        filter,
        sort,
        start_cursor: cursor,
        page_size: pageSize,
      });
      const items = overlaySearch(
        result.results.map(itemResponseToSummary), store, firstPage, options?.filter);
      // Search reveals each matching item's existence/title, so attribute to every (real) result item
      // and exclude observers who lack access to any of them.
      const itemIds = result.results
        .map(r => r.id)
        .filter(id => !NotionStore.isProvisional(id));
      await authorizeItemObservation(approvalQueue, observe, itemIds,
        observation("Search Notion", `Search Notion for “${options?.query ?? ""}”.`));
      return { items, nextCursor: result.has_more ? result.next_cursor ?? undefined : undefined };
    });
  }

  async getPage(idOrUrl: string): Promise<NotionPageSession> {
    // This "open" reveals no page data itself (that is read through the returned session, which
    // tracks the page), so it carries no item attribution.
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [],
      observation("Open Notion page", "Open a Notion page by ID or URL."));
    // Accept a provisional handle for a page created earlier in this session.
    if (NotionStore.isProvisional(idOrUrl)) {
      if (!this.#store.knowsProvisional(idOrUrl)) {
        throw new NotionApiError(404, "No such page.");
      }
      return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), idOrUrl, this.#observe);
    }
    const id = parseNotionId(idOrUrl);
    await this.#store.getPageResponse(id);
    return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), id, this.#observe);
  }

  async getDatabase(idOrUrl: string): Promise<NotionDatabaseSession> {
    // As with getPage, opening reveals no database data itself; the returned session tracks it.
    await authorizeItemObservation(this.#approvalQueue, this.#observe, [],
      observation("Open Notion database", "Open a Notion database by ID or URL."));
    // Databases are never provisional (this gatekeeper doesn't create databases).
    if (NotionStore.isProvisional(idOrUrl)) {
      throw new NotionApiError(404, "No such database.");
    }
    const id = parseNotionId(idOrUrl);
    await this.#store.getDatabaseResponse(id);
    return new NotionDatabaseSessionImpl(this.#store, this.#approvalQueue.dup(), id, this.#observe);
  }

  async createPage(options: NotionCreatePageOptions): Promise<NotionPageSession> {
    if (options.icon) assertValidIcon(options.icon);
    const provisionalId = this.#store.nextProvisionalId();
    const action: NotionAction = {
      type: "createPage",
      provisionalId,
      parent: { kind: "workspace" },
      title: options.title,
      content: options.content,
      icon: options.icon,
    };
    await stageAction(this.#store, this.#approvalQueue, action);
    return new NotionPageSessionImpl(this.#store, this.#approvalQueue.dup(), provisionalId, this.#observe);
  }

  async listUsers(options?: NotionPageOptions): Promise<Cursor<NotionUser>> {
    const pageSize = clampPageSize(options?.pageSize);
    const store = this.#store;
    const approvalQueue = this.#approvalQueue;
    const observe = this.#observe;
    return new PagedCursor<NotionUser>(async cursor => {
      const result = await store.api.listUsers(cursor, pageSize);
      // The member directory is visible to any workspace member, so no item attribution (the baseline
      // workspace-membership check in addObserver covers it).
      await authorizeItemObservation(approvalQueue, observe, [],
        observation("List Notion users", "List the members of the Notion workspace."));
      return {
        items: result.results.map(userResponseToUser),
        nextCursor: result.has_more ? result.next_cursor ?? undefined : undefined,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Query filter / sort conversion.

function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

// Validate an icon input at call time, so a bad value fails immediately instead of wasting a
// human approval and then erroring at apply with Notion's giant emoji enum.
function assertValidIcon(icon: NotionIconInput): void {
  if ("imageUrl" in icon) {
    if (!/^https?:\/\//i.test(icon.imageUrl)) {
      throw new NotionApiError(400, "Icon imageUrl must be an http(s) URL.");
    }
    return;
  }
  const emoji = icon.emoji.trim();
  // A Notion emoji icon is a single emoji (possibly a ZWJ/modifier sequence). Reject anything with
  // ASCII letters/digits or lacking an emoji pictographic — e.g. "not-an-emoji".
  if (!emoji || /[A-Za-z0-9]/.test(emoji) || !/\p{Extended_Pictographic}/u.test(emoji)) {
    throw new NotionApiError(400, `"${icon.emoji}" is not a valid emoji. Use a single emoji character, or { imageUrl }.`);
  }
}

// Validate writable property inputs against a database schema. Throws on an unknown property name
// or a value whose type doesn't match the column's type (this also rejects writes to read-only
// computed columns like created_time, since no writable input type matches them).
function validateProperties(
  schema: NotionDatabaseSchema,
  properties: Record<string, NotionPropertyInput>,
): void {
  for (const [name, input] of Object.entries(properties)) {
    const prop = schema.properties[name];
    if (!prop) {
      throw new NotionApiError(400, `Unknown property "${name}" for this database.`);
    }
    if (prop.type !== input.type) {
      throw new NotionApiError(
        400, `Property "${name}" is of type ${prop.type}; cannot set it with a ${input.type} value.`);
    }
  }
}

// Notion only allows compound filters nested two levels deep; we cap our own recursion well above
// that so an agent-supplied (or buggy) deeply-nested filter throws a clean error instead of
// overflowing the stack.
const MAX_FILTER_DEPTH = 10;

// Notion nests a filter condition under a key named for the property's *type*
// (`{ property, <type>: { <condition>: value } }`). We get that type from the database schema
// rather than guessing from the condition, so `equals` works for select/status/title/etc.
function filterToNotion(
  filter: NotionQueryFilter,
  typeOf: (name: string) => string | undefined,
  depth = 0,
): unknown {
  if (depth > MAX_FILTER_DEPTH) {
    throw new NotionApiError(
      400, `Database filter is nested too deeply (max ${MAX_FILTER_DEPTH} levels).`);
  }
  if ("and" in filter) return { and: filter.and.map(f => filterToNotion(f, typeOf, depth + 1)) };
  if ("or" in filter) return { or: filter.or.map(f => filterToNotion(f, typeOf, depth + 1)) };

  const propType = typeOf(filter.property);
  if (!propType) {
    throw new NotionApiError(400, `Unknown property "${filter.property}" in database filter.`);
  }
  const container = filterContainerForType(propType);
  if (!container) {
    throw new NotionApiError(
      400, `Property "${filter.property}" (type ${propType}) cannot be used in a filter.`);
  }
  const valid = FILTER_CONDITIONS[container];
  if (valid && !valid.has(filter.condition)) {
    throw new NotionApiError(
      400,
      `Unknown filter condition "${filter.condition}" for property "${filter.property}" ` +
      `(type ${propType}). Valid conditions: ${[...valid].join(", ")}.`);
  }
  // When no `value` is given, the operand shape depends on the condition: relative-date frames
  // (this_week, past_week, …) take an empty object `{}`, whereas existence checks (is_empty,
  // is_not_empty) take the boolean `true`. Sending `true` for a date frame makes Notion reject it.
  const operand = filter.value !== undefined ? filter.value
    : RELATIVE_DATE_CONDITIONS.has(filter.condition) ? {}
    : true;
  return { property: filter.property, [container]: { [filter.condition]: operand } };
}

// Date filter conditions whose operand is an empty object rather than a value/boolean.
const RELATIVE_DATE_CONDITIONS = new Set([
  "this_week", "past_week", "past_month", "past_year", "next_week", "next_month", "next_year",
]);

// Valid filter conditions per filter container (from Notion's "Filter database entries" reference),
// so we return a clean error rather than leaking Notion's multi-line validation dump.
const FILTER_CONDITIONS: Record<string, Set<string>> = {
  rich_text: new Set(["equals", "does_not_equal", "contains", "does_not_contain", "starts_with", "ends_with", "is_empty", "is_not_empty"]),
  phone_number: new Set(["equals", "does_not_equal", "contains", "does_not_contain", "starts_with", "ends_with", "is_empty", "is_not_empty"]),
  number: new Set(["equals", "does_not_equal", "greater_than", "less_than", "greater_than_or_equal_to", "less_than_or_equal_to", "is_empty", "is_not_empty"]),
  unique_id: new Set(["equals", "does_not_equal", "greater_than", "less_than", "greater_than_or_equal_to", "less_than_or_equal_to", "is_empty", "is_not_empty"]),
  checkbox: new Set(["equals", "does_not_equal"]),
  select: new Set(["equals", "does_not_equal", "is_empty", "is_not_empty"]),
  status: new Set(["equals", "does_not_equal", "is_empty", "is_not_empty"]),
  multi_select: new Set(["contains", "does_not_contain", "is_empty", "is_not_empty"]),
  people: new Set(["contains", "does_not_contain", "is_empty", "is_not_empty"]),
  relation: new Set(["contains", "does_not_contain", "is_empty", "is_not_empty"]),
  files: new Set(["is_empty", "is_not_empty"]),
  date: new Set(["equals", "before", "after", "on_or_before", "on_or_after", "is_empty", "is_not_empty", "this_week", "past_week", "past_month", "past_year", "next_week", "next_month", "next_year"]),
};

// Maps a property type to the filter-object key Notion expects. Notion only accepts a fixed set of
// filter keys (per the "Filter database entries" reference), which is NOT the same as the set of
// property types: text-like types share `rich_text`, the two `*_by` types use `people`, and the two
// `*_time` types use `date`. Returns null for types that need specialized/nested shapes we don't
// model (formula, rollup, verification).
function filterContainerForType(propType: string): string | null {
  switch (propType) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
      return "rich_text";
    case "phone_number":
      return "phone_number";
    case "number":
      return "number";
    case "checkbox":
      return "checkbox";
    case "select":
      return "select";
    case "multi_select":
      return "multi_select";
    case "status":
      return "status";
    case "date":
    case "created_time":
    case "last_edited_time":
      return "date";
    case "people":
    case "created_by":
    case "last_edited_by":
      return "people";
    case "relation":
      return "relation";
    case "files":
      return "files";
    case "unique_id":
      return "unique_id";
    default:
      return null;
  }
}

function sortToNotion(sort: NotionQuerySort): unknown {
  if (sort.timestamp) return { timestamp: sort.timestamp, direction: sort.direction };
  return { property: sort.property, direction: sort.direction };
}
