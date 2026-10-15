import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  ACCESS_TOKEN_SAFETY_MS, CONNECT_TIMEOUT_MS, INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES,
  OAUTH_NONCE_LIFETIME_MS, constantTimeEqual, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CanvaApi,
  CanvaApiError,
  type CanvaDesignResponse,
  type CanvaFolderItemResponse,
  type CanvaFolderResponse,
  type CanvaGenerationJobResponse,
  type CanvaImageAssetResponse,
  type CanvaImageTransformationJobResponse,
  type CanvaThumbnailResponse,
} from "./canva-api";
import {
  OAUTH_SCOPES, buildAuthorizeUrl, exchangeCode, generatePkce, getOAuthConfig, isGrantDeath,
  refreshTokens, revokeToken, type CanvaOAuthConfig,
} from "./canva-oauth";
import type {
  CanvaAccountSession,
  CanvaCreateDesignOptions,
  CanvaDesign,
  CanvaDesignType,
  CanvaFolder,
  CanvaFolderItem,
  CanvaGenerateDesignOptions,
  CanvaGenerationDesignType,
  CanvaGenerationJob,
  CanvaImageAsset,
  CanvaImageTransformation,
  CanvaImageTransformationJob,
  CanvaListDesignsOptions,
  CanvaListFolderItemsOptions,
  CanvaPage,
  CanvaProfile,
  CanvaThumbnail,
  CanvaTransformImageOptions,
} from "./types";
import TYPES_CODE from "./types.txt";
import CANVA_LOGO_SVG from "./canva-logo.svg";
import CANVA_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { CanvaAccountConfiguratorRpc } from "./configurator/account-configurator-types";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one is active at a time; `stage`
// tracks where we are. For the OAuth stage we also stash the PKCE verifier alongside the nonce,
// since Canva requires PKCE and the verifier must survive the round trip through the browser.
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
};

/**
 * The live credential record, held as one unit so a reconnect can stage a complete replacement
 * (see UserAccount.commitReconnect). Canva rotates refresh tokens on every refresh, so this record
 * is rewritten whole each time rather than field by field.
 */
type StoredCredentials = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  scopes: string[];
};

type CanvaGatekeeperImplProps = {
  userObjectId: string;
};

const CANVA_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(CANVA_LOGO_SVG)}`;
const CANVA_PROJECTS_URL = "https://www.canva.com/projects";

const ACCOUNT_RESOURCE: SupportedResource = {
  // Whole-instance catch-all (matches any URL), like other single-tenant gatekeepers.
  urlPattern: "https://*",
  title: "Canva Account",
  description:
    "Whole-account access: your profile, your designs, your folders, and creating new designs.",
  icon: { url: CANVA_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Canva Gatekeeper Not Configured",
  "Please configure a Canva integration client ID and secret for this gatekeeper.");

// ---------------------------------------------------------------------------
// Small helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/canva");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function requireOAuthConfig(env: Env): CanvaOAuthConfig {
  const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env));
  if (!config) throw new Error("The Canva gatekeeper is not configured.");
  return config;
}

/**
 * Extract a design ID from a canva.com design URL or accept a bare ID. Canva design IDs are short
 * URL-safe strings like "DAFVztcvd9z". Returns null if the input is neither.
 */
function parseDesignId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)canva\.com$/.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("design");
    const candidate = idx >= 0 ? segments[idx + 1] : undefined;
    if (candidate && /^[A-Za-z0-9_-]+$/.test(candidate)) return candidate;
  } catch {
    // not a URL
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalizers: raw Canva responses -> the shapes declared in types.d.ts.
//
// Canva timestamps are Unix seconds; the agent-facing API uses ISO 8601 strings.

function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function normalizeThumbnail(thumbnail: CanvaThumbnailResponse | undefined): CanvaThumbnail | null {
  return thumbnail ? { width: thumbnail.width, height: thumbnail.height, url: thumbnail.url } : null;
}

function normalizeDesign(design: CanvaDesignResponse): CanvaDesign {
  return {
    id: design.id,
    title: design.title ?? null,
    owner: design.owner ? { userId: design.owner.user_id, teamId: design.owner.team_id } : null,
    thumbnail: normalizeThumbnail(design.thumbnail),
    editUrl: design.urls.edit_url,
    viewUrl: design.urls.view_url,
    pageCount: design.page_count ?? null,
    createdAt: isoFromUnixSeconds(design.created_at),
    updatedAt: isoFromUnixSeconds(design.updated_at),
  };
}

function normalizeFolder(folder: CanvaFolderResponse): CanvaFolder {
  return {
    id: folder.id,
    name: folder.name,
    thumbnail: normalizeThumbnail(folder.thumbnail),
    createdAt: isoFromUnixSeconds(folder.created_at),
    updatedAt: isoFromUnixSeconds(folder.updated_at),
  };
}

function normalizeImageAsset(image: CanvaImageAssetResponse): CanvaImageAsset {
  const { width, height } = image.metadata ?? {};
  return {
    id: image.id,
    name: image.name,
    tags: image.tags ?? [],
    owner: image.owner ? { userId: image.owner.user_id, teamId: image.owner.team_id } : null,
    dimensions: width !== undefined && height !== undefined ? { width, height } : null,
    thumbnail: normalizeThumbnail(image.thumbnail),
    createdAt: isoFromUnixSeconds(image.created_at),
    updatedAt: isoFromUnixSeconds(image.updated_at),
  };
}

function normalizeFolderItem(item: CanvaFolderItemResponse): CanvaFolderItem {
  switch (item.type) {
    case "folder": return { type: "folder", folder: normalizeFolder(item.folder) };
    case "design": return { type: "design", design: normalizeDesign(item.design) };
    case "image": return { type: "image", image: normalizeImageAsset(item.image) };
  }
}

// ---------------------------------------------------------------------------
// HTTP entrypoint: the two browser-facing routes of the connect flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Auth initiation: /<doId>/<initiationNonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env));
      if (!config) return htmlResponse(NOT_CONFIGURED_HTML, 500);

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML, 400);

      const state = `${doId}:${begun.oauthNonce}`;
      return Response.redirect(buildAuthorizeUrl(config, state, begun.challenge, begun.scopes), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return htmlResponse(errorPageHtml(
          "Canva authorization failed",
          "Authorization was denied or failed. Please restart the connection flow from the Workshop."), 400);
      }

      const state = url.searchParams.get("state");
      if (!state) return htmlResponse(errorPageHtml("Invalid callback", "No 'state' was provided."), 400);
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return htmlResponse(errorPageHtml("Invalid callback", "Malformed 'state'."), 400);

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return htmlResponse(errorPageHtml("Invalid callback", "No 'code' was provided."), 400);

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) return htmlResponse(INVALID_LINK_HTML, 400);

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
      displayName: "Canva",
      url: "https://www.canva.com",
      logo: { url: CANVA_LOGO_URL },
      color: "#00C4CC",
      tagline: "Browse your designs and folders, and create new designs",
      description:
        "Connect your Canva account to give Gadgets access to your designs and folders. " +
        "Build agents that find the right design, keep track of what changed, or spin up a new " +
        "design ready for you to edit.",
      providesAuth: false,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
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
// UserAccount DO — stores OAuth credentials and refreshes access tokens.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
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
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  /**
   * Advance from the initiation link to the OAuth redirect: mint the OAuth-stage nonce and the PKCE
   * pair, keeping the verifier here so only this DO can redeem the code Canva hands back.
   */
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; challenge: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
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
    return { oauthNonce, challenge, scopes: OAUTH_SCOPES };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const tokens = await exchangeCode(requireOAuthConfig(this.env), code, stored.verifier)
      .catch((cause: unknown) => {
        throw new Error("Canva OAuth exchange failed.", { cause });
      });
    if (!tokens.refreshToken) {
      throw new Error("Canva did not return a refresh token.");
    }

    const credentials: StoredCredentials = {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt ?? 0,
      scopes: tokens.scopes ?? OAUTH_SCOPES,
    };

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      const stageId = stageCredentials(this.ctx.storage.kv, credentials, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#storeCredentials(credentials);
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("credentials");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const credentials = commitStagedCredentials<StoredCredentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!credentials) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#storeCredentials(credentials);
  }

  #storeCredentials(credentials: StoredCredentials): void {
    this.ctx.storage.kv.put("credentials", credentials);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  // A refresh in flight for this DO activation. Canva's refresh tokens are single-use, so two
  // concurrent refreshes would each redeem the same token and the loser would kill the grant.
  // Coalescing them here means every concurrent caller waits on the one real refresh.
  #refreshing?: Promise<string>;

  async getAccessToken(): Promise<string> {
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials) {
      throw new Error("Canva credentials have not been configured for this account.");
    }
    if (Date.now() < credentials.accessTokenExpiresAt - ACCESS_TOKEN_SAFETY_MS) {
      return credentials.accessToken;
    }

    if (!this.#refreshing) {
      this.#refreshing = this.#refresh(credentials).finally(() => { this.#refreshing = undefined; });
    }
    return this.#refreshing;
  }

  async #refresh(credentials: StoredCredentials): Promise<string> {
    let tokens;
    try {
      tokens = await refreshTokens(requireOAuthConfig(this.env), credentials.refreshToken);
    } catch (err) {
      if (isGrantDeath(err)) await this.noteCredentialsExpired();
      throw new Error("Canva credentials have expired or been revoked. Please reconnect the account.", { cause: err });
    }
    this.#storeCredentials({
      // Canva rotates the refresh token; if a response ever omits it, keep the current one.
      refreshToken: tokens.refreshToken ?? credentials.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt ?? 0,
      scopes: tokens.scopes ?? credentials.scopes,
    });
    return tokens.accessToken;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  /** An abandoned connect flow: no credentials ever arrived, so forget the DO entirely. */
  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Best-effort: tell Canva the grant is gone so it stops listing this integration as connected.
    // If that fails the local wipe below still makes the account unusable here.
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    const config = getOAuthConfig(this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env));
    if (credentials && config) {
      await revokeToken(config, credentials.refreshToken).catch(() => undefined);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: CanvaApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new CanvaApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof CanvaApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Canva credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const [me, profile] = await Promise.all([api.getCurrentUser(), api.getProfile()]);
      return {
        displayName: profile.profile.display_name,
        uniqueName: me.team_user.user_id,
        // The Connect API exposes no avatar for the connected user, so the vendor logo stands in.
        avatar: { url: CANVA_LOGO_URL },
      };
    });
  }

  /** Canva is not offered as a sign-in identity provider (the Connect API exposes no verified email). */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // One resource granularity today: any URL is whole-account access against the connected account.
    const props: CanvaGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return { class: this.ctx.exports.CanvaGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === ACCOUNT_RESOURCE.urlPattern) {
      return {
        iframeHtml: CANVA_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new CanvaAccountConfiguratorUI()),
      };
    }
    throw new Error(`Unsupported Canva resource configurator type: ${resourceUrlPattern}`);
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
   * Mint a verifier representing this account. It carries the account so a future ACL check can
   * learn the observer's Canva identity (see CanvaVerifier.getTeamUser); today's observer strategy
   * never consults it (see CanvaGatekeeperImpl.addObserver), but the overseer mints one on every
   * open, so it must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: CanvaVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.CanvaVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Vendor-specific verifier methods, trusted only after the overseer's same-vendor handoff: the
// overseer promises to pass a verifier back only to the gatekeeper that minted it.

type CanvaVerifierProps = {
  userObjectId: string;
};

@validateRpc()
export class CanvaVerifier extends WorkerEntrypoint<Env, CanvaVerifierProps> implements GatekeeperUserVerifier {
  /** The observer's Canva identity, for a future per-design access check. */
  async getTeamUser(): Promise<{ userId: string; teamId: string }> {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    const api = new CanvaApi(() => account.getAccessToken());
    const me = await api.getCurrentUser();
    return { userId: me.team_user.user_id, teamId: me.team_user.team_id };
  }
}

// ---------------------------------------------------------------------------
// Action model.
//
// Every write is submitted to the ApprovalQueue and stored as a pending action; it is only performed
// against Canva when applyAction() is later called. Neither action is simulated: Canva assigns the
// design ID when it does the work and the Connect API offers no way to delete a design, so there is
// nothing a provisional record could usefully stand in for. Generation is additionally asynchronous
// on Canva's side, so applying it starts a job whose outcome `listGeneratedDesigns` reads back.

type ActionState = "staged" | "pending" | "approved" | "rejected" | "failed";

type BaseAction = { approvalId: number; submittedAt: number };

type CreateDesignAction = BaseAction & {
  type: "createDesign";
  designType: CanvaDesignType;
  title?: string;
  assetId?: string;
};

type GenerateDesignAction = BaseAction & {
  type: "generateDesign";
  brief: string;
  designType: CanvaGenerationDesignType;
  outline?: CanvaGenerateDesignOptions["outline"];
};

type TransformImageAction = BaseAction & {
  type: "transformImage";
  assetId: string;
  transformations: CanvaImageTransformation[];
  name?: string;
};

type CanvaAction = CreateDesignAction | GenerateDesignAction | TransformImageAction;

/** The Canva job an applied generateDesign action started, updated as it is polled. */
type GenerationState = {
  jobId: string;
  startedAt: number;
  status: CanvaGenerationJob["status"];
  design?: CanvaDesign;
  error?: { code: string; message: string };
};

/**
 * The Canva job an applied transformImage action started. `jobId` is absent when Canva finished
 * the job inside the creation call, which it may do for a quick transformation.
 */
type TransformationState = {
  jobId?: string;
  startedAt: number;
  status: CanvaImageTransformationJob["status"];
  asset?: CanvaImageAsset;
  error?: { code: string; message: string };
};

type StoredActionRecord = {
  action: CanvaAction;
  state: ActionState;
  appliedAt?: number;
  rejectedAt?: number;
  /** Set once a createDesign action is applied, so revert can at least point the user at the design. */
  createdDesign?: { id: string; editUrl: string };
  /** Set once a generateDesign action is applied. */
  generation?: GenerationState;
  /** Set once a transformImage action is applied. */
  transformation?: TransformationState;
};

// How long applied/rejected action records are retained before being pruned from DO storage.
const RETIRED_ACTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Don't rescan the retired keyspace more often than this (pruning is best-effort cleanup).
const RETIRED_ACTION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DESIGN_OWNERSHIPS = new Set(["owned", "shared", "any"]);
const DESIGN_SORTS = new Set([
  "relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending",
]);
const FOLDER_ITEM_TYPES = new Set(["folder", "design", "image"]);
const FOLDER_ITEM_SORTS = new Set([
  "created_ascending", "created_descending", "modified_ascending", "modified_descending",
  "title_ascending", "title_descending",
]);
const PRESET_DESIGN_TYPES = new Set(["doc", "whiteboard", "presentation"]);
// Canva's documented bounds for custom design dimensions, in pixels.
const CUSTOM_DESIGN_MIN_PX = 40;
const CUSTOM_DESIGN_MAX_PX = 8000;
// Canva's documented bounds for design generation requests.
const GENERATION_DESIGN_TYPES = new Set(["doc", "presentation"]);
const GENERATION_BRIEF_MAX = 5000;
const GENERATION_SECTIONS_MAX = 100;
const GENERATION_SECTION_TITLE_MAX = 255;
const GENERATION_SECTION_DESCRIPTION_MAX = 2000;
const GENERATION_SECTION_POINTS_MAX = 50;
// Generation jobs expire on Canva 24 hours after they start; a poll after that 404s.
const GENERATION_JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
// How many generation jobs listGeneratedDesigns reports (newest first).
const GENERATION_LIST_MAX = 20;

// Canva's documented bounds for image transformation requests.
const TRANSFORMATION_TYPES = new Set(["background_removal"]);
const TRANSFORMATIONS_MAX = 20;
const TRANSFORMATION_NAME_MAX = 255;

/** Converts a polled job into the state stored on its action record. */
function generationStateFromJob(
  job: CanvaGenerationJobResponse, startedAt: number,
): GenerationState {
  const state: GenerationState = { jobId: job.id, startedAt, status: job.status };
  if (job.status === "success" && job.result) state.design = normalizeDesign(job.result.design);
  if (job.status === "failed" && job.error) state.error = { code: job.error.code, message: job.error.message };
  return state;
}

/** Converts a polled transformation job into the state stored on its action record. */
function transformationStateFromJob(
  job: CanvaImageTransformationJobResponse, startedAt: number,
): TransformationState {
  const state: TransformationState = { startedAt, status: job.status };
  if (job.id !== undefined) state.jobId = job.id;
  if (job.status === "success" && job.result) state.asset = normalizeImageAsset(job.result.asset);
  if (job.status === "failed" && job.error) state.error = { code: job.error.code, message: job.error.message };
  return state;
}

const EXPIRED_JOB_ERROR = { code: "expired", message: "The job expired on Canva before it completed." };

/**
 * Whether a failed poll means the job aged out rather than vanished. Canva forgets a generation job
 * 24 hours after it starts; the transformation docs don't state a lifetime, so the same window is
 * applied there. An earlier 404 is passed through, since it means something is wrong.
 */
function isExpiredJob(error: unknown, startedAt: number): boolean {
  return error instanceof CanvaApiError && error.status === 404
    && Date.now() - startedAt > GENERATION_JOB_LIFETIME_MS;
}

/** Lists a transformation's steps for an approval card, e.g. "background removal". */
function describeTransformations(transformations: CanvaImageTransformation[]): string {
  return transformations.map(step => step.type.replaceAll("_", " ")).join(", then ");
}

function describeDesignType(designType: CanvaDesignType): string {
  return designType.type === "preset"
    ? `a ${designType.name}`
    : `a custom ${designType.width}×${designType.height}px design`;
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-binding instance, runs as a facet of the Overseer.

@validateRpc()
export class CanvaGatekeeperImpl extends DurableObject<Env, CanvaGatekeeperImplProps>
  implements Gatekeeper<CanvaAccountSession> {

  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: CanvaApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new CanvaApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof CanvaApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Canva credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<ResourceDescription> {
    const profile = await this.#withApi(api => api.getProfile());
    return {
      url: CANVA_PROJECTS_URL,
      title: `${profile.profile.display_name}'s Canva`,
      snippet: "Whole-account access: profile, designs, folders, and design creation.",
      suggestedBindingName: "CANVA_ACCOUNT",
      tsType: "CanvaAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CanvaAccountSession> {
    return new CanvaAccountSessionImpl(this, approvalQueue.dup());
  }

  /**
   * Observer tracking: Canva uses the "private-only" strategy for now. Designs have real per-user
   * sharing, and a whole-account binding can read any of them, so a collaborator opening a shared
   * gadget could see designs they were never granted. Until a per-design access check exists (the
   * verifier already exposes the observer's identity for it), nobody but the owner may observe.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "A gadget that reads a Canva account cannot be shared yet: the Canva connector does not " +
      "verify that collaborators can see the same designs.");
  }

  async removeObserver(_id: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Reads

  async getProfile(): Promise<CanvaProfile> {
    const [me, profile, capabilities] = await this.#withApi(api =>
      Promise.all([api.getCurrentUser(), api.getProfile(), api.getCapabilities()]));
    return {
      userId: me.team_user.user_id,
      teamId: me.team_user.team_id,
      displayName: profile.profile.display_name,
      canGenerateDesigns: capabilities.capabilities.includes("design_generation"),
      canRemoveBackgrounds: capabilities.capabilities.includes("background_removal"),
    };
  }

  async getImageAsset(assetId: string): Promise<CanvaImageAsset> {
    let asset: CanvaImageAssetResponse;
    try {
      asset = await this.#withApi(api => api.getAsset(assetId));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva asset found with id "${assetId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
    if (asset.type === "video") {
      throw new Error(`Canva asset "${assetId}" is a video, not an image.`);
    }
    return normalizeImageAsset(asset);
  }

  async listDesigns(options: CanvaListDesignsOptions): Promise<CanvaPage<CanvaDesign>> {
    const page = await this.#withApi(api => api.listDesigns({
      query: options.query,
      ownership: options.ownership,
      sort_by: options.sortBy,
      continuation: options.continuation,
    }));
    return { items: page.items.map(normalizeDesign), ...(page.continuation ? { continuation: page.continuation } : {}) };
  }

  async getDesign(designId: string): Promise<CanvaDesign> {
    try {
      return normalizeDesign(await this.#withApi(api => api.getDesign(designId)));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva design found with id "${designId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
  }

  async getFolder(folderId: string): Promise<CanvaFolder> {
    try {
      return normalizeFolder(await this.#withApi(api => api.getFolder(folderId)));
    } catch (error) {
      if (error instanceof CanvaApiError && error.status === 404) {
        throw new Error(`No Canva folder found with id "${folderId}", or you do not have access to it.`, { cause: error });
      }
      throw error;
    }
  }

  async listFolderItems(folderId: string, options: CanvaListFolderItemsOptions): Promise<CanvaPage<CanvaFolderItem>> {
    const page = await this.#withApi(api => api.listFolderItems(folderId, {
      item_types: options.itemTypes,
      sort_by: options.sortBy,
      continuation: options.continuation,
    }));
    return {
      items: page.items.map(normalizeFolderItem),
      ...(page.continuation ? { continuation: page.continuation } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Action storage & lookup

  #counter(name: string): number {
    const value = (this.ctx.storage.kv.get<number>(`counter:${name}`) ?? 0) + 1;
    this.ctx.storage.kv.put(`counter:${name}`, value);
    return value;
  }

  #actionKey(id: number): string { return `action:${id}`; }
  #retiredKey(id: number): string { return `retiredAction:${id}`; }

  #getRecord(id: number): StoredActionRecord | undefined {
    return this.ctx.storage.kv.get<StoredActionRecord>(this.#actionKey(id))
      ?? this.ctx.storage.kv.get<StoredActionRecord>(this.#retiredKey(id));
  }

  #requireRecord(id: number): StoredActionRecord {
    const record = this.#getRecord(id);
    if (!record) throw new Error(`No queued Canva action exists with id ${id}.`);
    return record;
  }

  #retire(id: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.delete(this.#actionKey(id));
    this.ctx.storage.kv.put(this.#retiredKey(id), record);
    this.#maybePruneRetiredActions();
  }

  // Retired (applied/rejected) records are kept so the overseer can still ask about recently-applied
  // actions, but they must not accumulate forever. Rate-limited so we don't rescan on every apply.
  #maybePruneRetiredActions(): void {
    const last = this.ctx.storage.kv.get<number>("meta:lastRetiredPrune") ?? 0;
    if (Date.now() - last < RETIRED_ACTION_PRUNE_INTERVAL_MS) return;
    this.ctx.storage.kv.put("meta:lastRetiredPrune", Date.now());
    const cutoff = Date.now() - RETIRED_ACTION_RETENTION_MS;
    for (const [key, record] of this.ctx.storage.kv.list<StoredActionRecord>({ prefix: "retiredAction:" })) {
      const retiredAt = record.appliedAt ?? record.rejectedAt ?? 0;
      if (retiredAt > 0 && retiredAt < cutoff) this.ctx.storage.kv.delete(key);
    }
  }

  prepareCreateDesign(designType: CanvaDesignType, options: CanvaCreateDesignOptions): CreateDesignAction {
    return {
      approvalId: this.#counter("approval"),
      submittedAt: Date.now(),
      type: "createDesign",
      designType,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.assetId !== undefined ? { assetId: options.assetId } : {}),
    };
  }

  prepareGenerateDesign(
    brief: string, designType: CanvaGenerationDesignType, options: CanvaGenerateDesignOptions,
  ): GenerateDesignAction {
    return {
      approvalId: this.#counter("approval"),
      submittedAt: Date.now(),
      type: "generateDesign",
      brief,
      designType,
      ...(options.outline !== undefined ? { outline: options.outline } : {}),
    };
  }

  /**
   * The generation jobs this binding has started, newest first, with any still-running job polled
   * first so the caller sees Canva's current answer. Each poll result is persisted, so a finished
   * job is never asked about again and a job that has aged out of Canva is reported as expired.
   */
  async listGeneratedDesigns(): Promise<CanvaGenerationJob[]> {
    const applied: Array<[string, StoredActionRecord]> = [];
    for (const [key, record] of this.ctx.storage.kv.list<StoredActionRecord>({ prefix: "retiredAction:" })) {
      if (record.action.type === "generateDesign" && record.state === "approved" && record.generation) {
        applied.push([key, record]);
      }
    }
    applied.sort((a, b) => b[1].action.submittedAt - a[1].action.submittedAt);

    const jobs: CanvaGenerationJob[] = [];
    for (const [key, record] of applied.slice(0, GENERATION_LIST_MAX)) {
      const action = record.action as GenerateDesignAction;
      let generation = record.generation!;
      if (generation.status === "in_progress") {
        generation = await this.#refreshGeneration(generation);
        record.generation = generation;
        this.ctx.storage.kv.put(key, record);
      }
      jobs.push({
        id: generation.jobId,
        brief: action.brief,
        designType: action.designType,
        startedAt: new Date(generation.startedAt).toISOString(),
        status: generation.status,
        design: generation.design ?? null,
        error: generation.error ?? null,
      });
    }
    return jobs;
  }

  async #refreshGeneration(current: GenerationState): Promise<GenerationState> {
    try {
      const job = await this.#withApi(api => api.getDesignGeneration(current.jobId));
      return generationStateFromJob(job, current.startedAt);
    } catch (error) {
      if (!isExpiredJob(error, current.startedAt)) throw error;
      return { ...current, status: "failed", error: EXPIRED_JOB_ERROR };
    }
  }

  prepareTransformImage(
    assetId: string, transformations: CanvaImageTransformation[], options: CanvaTransformImageOptions,
  ): TransformImageAction {
    return {
      approvalId: this.#counter("approval"),
      submittedAt: Date.now(),
      type: "transformImage",
      assetId,
      transformations,
      ...(options.name !== undefined ? { name: options.name } : {}),
    };
  }

  /** The transformation jobs this binding has started, newest first; see listGeneratedDesigns. */
  async listImageTransformations(): Promise<CanvaImageTransformationJob[]> {
    const applied: Array<[string, StoredActionRecord]> = [];
    for (const [key, record] of this.ctx.storage.kv.list<StoredActionRecord>({ prefix: "retiredAction:" })) {
      if (record.action.type === "transformImage" && record.state === "approved" && record.transformation) {
        applied.push([key, record]);
      }
    }
    applied.sort((a, b) => b[1].action.submittedAt - a[1].action.submittedAt);

    const jobs: CanvaImageTransformationJob[] = [];
    for (const [key, record] of applied.slice(0, GENERATION_LIST_MAX)) {
      const action = record.action as TransformImageAction;
      let transformation = record.transformation!;
      if (transformation.status === "in_progress" && transformation.jobId !== undefined) {
        transformation = await this.#refreshTransformation(transformation, transformation.jobId);
        record.transformation = transformation;
        this.ctx.storage.kv.put(key, record);
      }
      jobs.push({
        id: transformation.jobId ?? null,
        sourceAssetId: action.assetId,
        transformations: action.transformations,
        startedAt: new Date(transformation.startedAt).toISOString(),
        status: transformation.status,
        asset: transformation.asset ?? null,
        error: transformation.error ?? null,
      });
    }
    return jobs;
  }

  async #refreshTransformation(current: TransformationState, jobId: string): Promise<TransformationState> {
    try {
      const job = await this.#withApi(api => api.getImageTransformation(jobId));
      return transformationStateFromJob(job, current.startedAt);
    } catch (error) {
      if (!isExpiredJob(error, current.startedAt)) throw error;
      return { ...current, status: "failed", error: EXPIRED_JOB_ERROR };
    }
  }

  async submitActionForApproval(
    queue: RpcStub<ApprovalQueue>,
    action: CanvaAction,
    description: ActionDescription,
  ): Promise<void> {
    this.ctx.storage.kv.put<StoredActionRecord>(this.#actionKey(action.approvalId), { action, state: "staged" });
    try {
      await queue.submitAction(action.approvalId, description);
    } catch (error) {
      this.ctx.storage.kv.delete(this.#actionKey(action.approvalId));
      throw error;
    }
    const record = this.#requireRecord(action.approvalId);
    record.state = "pending";
    this.ctx.storage.kv.put(this.#actionKey(action.approvalId), record);
  }

  // -------------------------------------------------------------------------
  // Action lifecycle (apply / reject / revert)

  async applyAction(actionId: number): Promise<void> {
    const record = this.#requireRecord(actionId);
    // "failed" is retryable (a prior apply threw); the overseer may call applyAction again.
    if (record.state !== "pending" && record.state !== "staged" && record.state !== "failed") {
      throw new Error(`Canva action ${actionId} is no longer pending.`);
    }
    try {
      await this.#performAction(record);
    } catch (error) {
      record.state = "failed";
      this.ctx.storage.kv.put(this.#actionKey(actionId), record);
      throw error;
    }
    record.state = "approved";
    record.appliedAt = Date.now();
    this.#retire(actionId, record);
  }

  async #performAction(record: StoredActionRecord): Promise<void> {
    const action = record.action;
    switch (action.type) {
      case "createDesign": {
        const created = await this.#withApi(api => api.createDesign({
          design_type: action.designType,
          ...(action.title !== undefined ? { title: action.title } : {}),
          ...(action.assetId !== undefined ? { asset_id: action.assetId } : {}),
        }));
        record.createdDesign = { id: created.id, editUrl: created.urls.edit_url };
        break;
      }
      case "generateDesign": {
        const startedAt = Date.now();
        const job = await this.#withApi(api => api.createDesignGeneration({
          brief: action.brief,
          design_type: action.designType,
          ...(action.outline !== undefined ? { outline: action.outline } : {}),
        }));
        record.generation = generationStateFromJob(job, startedAt);
        break;
      }
      case "transformImage": {
        const startedAt = Date.now();
        let job: CanvaImageTransformationJobResponse;
        try {
          job = await this.#withApi(api => api.createImageTransformation({
            asset_id: action.assetId,
            transformations: action.transformations,
            ...(action.name !== undefined ? { name: action.name } : {}),
          }));
        } catch (error) {
          // A 403 here is most often a connection made before this gatekeeper requested asset:write,
          // which only a fresh consent can widen. Say so rather than leave the user guessing.
          if (error instanceof CanvaApiError && error.status === 403) {
            throw new Error(
              "Canva refused the image transformation. If this Canva account was connected before " +
              "image transformation was added, disconnect and reconnect it to grant the asset:write " +
              "scope; otherwise the user's plan may not include this feature.", { cause: error });
          }
          throw error;
        }
        record.transformation = transformationStateFromJob(job, startedAt);
        break;
      }
    }
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Be lenient: a reject for an action we don't have pending (already applied/rejected, or a
    // stale queue entry from a prior session) is treated as a no-op success so the overseer can
    // always clear it from its queue. Throwing here would leave such entries stuck.
    const record = this.#getRecord(actionId);
    if (!record || (record.state !== "pending" && record.state !== "staged" && record.state !== "failed")) {
      return;
    }
    record.state = "rejected";
    record.rejectedAt = Date.now();
    this.#retire(actionId, record);
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#requireRecord(actionId);
    if (record.state !== "approved") {
      return { message: "This action has not been applied, so there is nothing to revert.", canRetry: false };
    }
    if (record.action.type === "transformImage") {
      // The source asset was never touched; only the new asset would need removing.
      const asset = record.transformation?.asset;
      const which = asset ? ` The new asset is "${asset.name}" (id ${asset.id}).` : "";
      return {
        message: "The Connect API cannot delete an asset, so remove the transformed image from your " +
          `Canva Uploads by hand if you don't want it.${which} The AI credits it consumed are not refunded.`,
        canRetry: false,
      };
    }
    // The Connect API has no endpoint to delete a design, so the best we can do is point at it.
    const editUrl = record.createdDesign?.editUrl ?? record.generation?.design?.editUrl;
    const where = editUrl ? ` It is at ${editUrl}; move it to the trash from the Canva editor.` : "";
    const what = record.action.type === "generateDesign" ? "generation" : "creation";
    const credits = record.action.type === "generateDesign"
      ? " The AI credits it consumed are not refunded." : "";
    return {
      message: `Canva designs cannot be deleted through the API, so this ${what} must be undone by hand.${where}${credits}`,
      canRetry: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Session implementation

function disposeQueue(queue: RpcStub<ApprovalQueue>): void {
  (queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

@validateRpc()
class CanvaAccountSessionImpl extends RpcTarget implements CanvaAccountSession {
  #gk: CanvaGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: CanvaGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  async getProfile(): Promise<CanvaProfile> {
    const profile = await this.#gk.getProfile();
    await this.#queue.authorizeObservation({
      title: "Read Canva profile",
      description: `Read the connected Canva account's profile (${profile.displayName}).`,
    });
    return profile;
  }

  @skipRpcValidation()
  async listDesigns(options?: CanvaListDesignsOptions): Promise<CanvaPage<CanvaDesign>> {
    const opts = options ?? {};
    if (opts.query !== undefined && typeof opts.query !== "string") {
      throw new Error("listDesigns(): query must be a string when provided.");
    }
    if (opts.ownership !== undefined && !DESIGN_OWNERSHIPS.has(opts.ownership)) {
      throw new Error(`listDesigns(): ownership must be one of "owned", "shared", or "any".`);
    }
    if (opts.sortBy !== undefined && !DESIGN_SORTS.has(opts.sortBy)) {
      throw new Error(`listDesigns(): sortBy must be one of ${[...DESIGN_SORTS].map(s => `"${s}"`).join(", ")}.`);
    }
    if (opts.continuation !== undefined && typeof opts.continuation !== "string") {
      throw new Error("listDesigns(): continuation must be a string when provided.");
    }
    const page = await this.#gk.listDesigns(opts);
    const what = opts.query ? `designs matching "${opts.query}"` : "designs";
    await this.#queue.authorizeObservation({
      title: opts.query ? `Search Canva designs for "${opts.query}"` : "List Canva designs",
      description: `Read ${page.items.length} ${what} from the connected Canva account` +
        `${opts.ownership && opts.ownership !== "any" ? ` (${opts.ownership})` : ""}.`,
    });
    return page;
  }

  async getDesign(designIdOrUrl: string): Promise<CanvaDesign> {
    const designId = parseDesignId(designIdOrUrl);
    if (!designId) {
      throw new Error(`Invalid Canva design "${designIdOrUrl}". Pass a design id or a canva.com/design URL.`);
    }
    const design = await this.#gk.getDesign(designId);
    await this.#queue.authorizeObservation({
      title: `Read design "${design.title ?? design.id}"`,
      description: `Read metadata for the Canva design "${design.title ?? design.id}".`,
    });
    return design;
  }

  @skipRpcValidation()
  async createDesign(designType: CanvaDesignType, options?: CanvaCreateDesignOptions): Promise<void> {
    if (!designType || typeof designType !== "object") {
      throw new Error("createDesign(): designType is required.");
    }
    if (designType.type === "preset") {
      if (!PRESET_DESIGN_TYPES.has(designType.name)) {
        throw new Error(`createDesign(): preset name must be one of "doc", "whiteboard", or "presentation".`);
      }
    } else if (designType.type === "custom") {
      for (const [label, value] of [["width", designType.width], ["height", designType.height]] as const) {
        if (!Number.isInteger(value) || value < CUSTOM_DESIGN_MIN_PX || value > CUSTOM_DESIGN_MAX_PX) {
          throw new Error(
            `createDesign(): ${label} must be an integer between ${CUSTOM_DESIGN_MIN_PX} and ${CUSTOM_DESIGN_MAX_PX} pixels.`);
        }
      }
    } else {
      throw new Error(`createDesign(): designType.type must be "preset" or "custom".`);
    }
    const opts = options ?? {};
    if (opts.title !== undefined && (typeof opts.title !== "string" || opts.title.trim() === "")) {
      throw new Error("createDesign(): title must be a non-empty string when provided.");
    }
    if (opts.assetId !== undefined && (typeof opts.assetId !== "string" || opts.assetId.trim() === "")) {
      throw new Error("createDesign(): assetId must be a non-empty string when provided.");
    }

    const action = this.#gk.prepareCreateDesign(designType, opts);
    const titled = opts.title ? ` titled "${opts.title}"` : "";
    await this.#gk.submitActionForApproval(this.#queue, action, {
      title: `Create Canva design${titled}`,
      description: `Create ${describeDesignType(designType)}${titled} in the connected Canva account` +
        `${opts.assetId ? `, placing asset ${opts.assetId} on the first page` : ""}.`,
      // The Connect API cannot delete a design, so the user has to undo this one by hand.
      implementsRevert: false,
      // Not simulated: the design does not exist until approved, so the agent should not read
      // back a world where it is missing and conclude the call failed.
      awaitDecision: true,
    });
  }

  @skipRpcValidation()
  async generateDesign(
    brief: string, designType: CanvaGenerationDesignType, options?: CanvaGenerateDesignOptions,
  ): Promise<void> {
    if (typeof brief !== "string" || brief.trim() === "" || brief.length > GENERATION_BRIEF_MAX) {
      throw new Error(`generateDesign(): brief must be a non-empty string of at most ${GENERATION_BRIEF_MAX} characters.`);
    }
    if (!designType || typeof designType !== "object" || designType.type !== "preset"
        || !GENERATION_DESIGN_TYPES.has(designType.name)) {
      throw new Error(`generateDesign(): designType must be { type: "preset", name: "doc" | "presentation" }.`);
    }
    const opts = options ?? {};
    if (opts.outline !== undefined) {
      if (designType.name !== "presentation") {
        throw new Error("generateDesign(): an outline is only valid for presentations.");
      }
      const sections = opts.outline?.sections;
      if (!Array.isArray(sections) || sections.length === 0 || sections.length > GENERATION_SECTIONS_MAX) {
        throw new Error(`generateDesign(): outline.sections must have 1 to ${GENERATION_SECTIONS_MAX} entries.`);
      }
      sections.forEach((section, index) => {
        const at = `outline.sections[${index}]`;
        if (!section || typeof section !== "object") throw new Error(`generateDesign(): ${at} must be an object.`);
        if (typeof section.title !== "string" || section.title.trim() === ""
            || section.title.length > GENERATION_SECTION_TITLE_MAX) {
          throw new Error(`generateDesign(): ${at}.title must be 1 to ${GENERATION_SECTION_TITLE_MAX} characters.`);
        }
        if (section.description !== undefined && (typeof section.description !== "string"
            || section.description.trim() === "" || section.description.length > GENERATION_SECTION_DESCRIPTION_MAX)) {
          throw new Error(`generateDesign(): ${at}.description must be 1 to ${GENERATION_SECTION_DESCRIPTION_MAX} characters.`);
        }
        if (section.points !== undefined && (!Array.isArray(section.points)
            || section.points.length > GENERATION_SECTION_POINTS_MAX
            || section.points.some(point => typeof point !== "string"))) {
          throw new Error(`generateDesign(): ${at}.points must be an array of at most ${GENERATION_SECTION_POINTS_MAX} strings.`);
        }
      });
    }

    const action = this.#gk.prepareGenerateDesign(brief, designType, opts);
    const slides = opts.outline ? ` with a ${opts.outline.sections.length}-slide outline` : "";
    await this.#gk.submitActionForApproval(this.#queue, action, {
      title: `Generate a Canva ${designType.name} with AI`,
      description:
        `Ask Canva's AI to generate ${describeDesignType(designType)}${slides} from this brief:\n\n` +
        `> ${brief.replaceAll("\n", "\n> ")}\n\n` +
        `**This spends your Canva AI credits.** The design is saved to your Canva account once ` +
        `generation finishes; the agent can follow progress with listGeneratedDesigns().`,
      // The Connect API cannot delete a design, and credits are not refundable.
      implementsRevert: false,
      // Not simulated and asynchronous: nothing exists until approved and generated.
      awaitDecision: true,
    });
  }

  async listGeneratedDesigns(): Promise<CanvaGenerationJob[]> {
    const jobs = await this.#gk.listGeneratedDesigns();
    const finished = jobs.filter(job => job.status === "success").length;
    await this.#queue.authorizeObservation({
      title: "Read Canva generation jobs",
      description: `Read ${jobs.length} design generation job(s) started from this connection` +
        ` (${finished} finished).`,
    });
    return jobs;
  }

  async getImageAsset(assetId: string): Promise<CanvaImageAsset> {
    if (assetId.trim() === "") throw new Error("getImageAsset(): assetId must be a non-empty string.");
    const asset = await this.#gk.getImageAsset(assetId.trim());
    await this.#queue.authorizeObservation({
      title: `Read image asset "${asset.name}"`,
      description: `Read metadata for the Canva image asset "${asset.name}".`,
    });
    return asset;
  }

  @skipRpcValidation()
  async transformImage(
    assetId: string, transformations: CanvaImageTransformation[], options?: CanvaTransformImageOptions,
  ): Promise<void> {
    if (typeof assetId !== "string" || assetId.trim() === "") {
      throw new Error("transformImage(): assetId must be a non-empty string.");
    }
    if (!Array.isArray(transformations) || transformations.length === 0
        || transformations.length > TRANSFORMATIONS_MAX) {
      throw new Error(`transformImage(): transformations must have 1 to ${TRANSFORMATIONS_MAX} steps.`);
    }
    for (const step of transformations) {
      if (!step || typeof step !== "object" || !TRANSFORMATION_TYPES.has(step.type)) {
        throw new Error(`transformImage(): each step must be { type: "background_removal" }.`);
      }
    }
    const opts = options ?? {};
    if (opts.name !== undefined && (typeof opts.name !== "string" || opts.name.trim() === ""
        || opts.name.length > TRANSFORMATION_NAME_MAX)) {
      throw new Error(`transformImage(): name must be 1 to ${TRANSFORMATION_NAME_MAX} characters when provided.`);
    }

    // Read the source first so the approval card can name it, and so a video or a missing asset is
    // refused before anything is queued. This read is itself an observation.
    const source = await this.getImageAsset(assetId);
    const steps = transformations.map(step => ({ type: step.type }));
    const action = this.#gk.prepareTransformImage(source.id, steps, opts);
    const named = opts.name ? ` named "${opts.name}"` : "";
    await this.#gk.submitActionForApproval(this.#queue, action, {
      title: `Transform Canva image "${source.name}"`,
      description:
        `Apply ${describeTransformations(steps)} to the Canva image asset "${source.name}" ` +
        `(id ${source.id}), saving the result as a new asset${named} in your Canva Uploads. The ` +
        `original is not changed.\n\n**This spends your Canva AI credits.** The agent can follow ` +
        `progress with listImageTransformations().`,
      // The Connect API cannot delete an asset, and credits are not refundable.
      implementsRevert: false,
      // Not simulated and asynchronous: nothing exists until approved and processed.
      awaitDecision: true,
    });
  }

  async listImageTransformations(): Promise<CanvaImageTransformationJob[]> {
    const jobs = await this.#gk.listImageTransformations();
    const finished = jobs.filter(job => job.status === "success").length;
    await this.#queue.authorizeObservation({
      title: "Read Canva image transformation jobs",
      description: `Read ${jobs.length} image transformation job(s) started from this connection` +
        ` (${finished} finished).`,
    });
    return jobs;
  }

  async getFolder(folderId: string): Promise<CanvaFolder> {
    if (folderId.trim() === "") throw new Error("getFolder(): folderId must be a non-empty string.");
    const folder = await this.#gk.getFolder(folderId.trim());
    await this.#queue.authorizeObservation({
      title: `Read folder "${folder.name}"`,
      description: `Read metadata for the Canva folder "${folder.name}".`,
    });
    return folder;
  }

  async listFolders(folderId?: string, continuation?: string): Promise<CanvaPage<CanvaFolder>> {
    const parent = (folderId ?? "root").trim() || "root";
    const page = await this.#gk.listFolderItems(parent, {
      itemTypes: ["folder"],
      ...(continuation !== undefined ? { continuation } : {}),
    });
    const folders = page.items.flatMap(item => item.type === "folder" ? [item.folder] : []);
    await this.#queue.authorizeObservation({
      title: "List Canva folders",
      description: `Read ${folders.length} sub-folder(s) of Canva folder "${parent}".`,
    });
    return { items: folders, ...(page.continuation ? { continuation: page.continuation } : {}) };
  }

  @skipRpcValidation()
  async listFolderItems(folderId: string, options?: CanvaListFolderItemsOptions): Promise<CanvaPage<CanvaFolderItem>> {
    if (typeof folderId !== "string" || folderId.trim() === "") {
      throw new Error("listFolderItems(): folderId must be a non-empty string.");
    }
    const opts = options ?? {};
    if (opts.itemTypes !== undefined) {
      if (!Array.isArray(opts.itemTypes) || opts.itemTypes.length === 0) {
        throw new Error("listFolderItems(): itemTypes must be a non-empty array when provided.");
      }
      for (const type of opts.itemTypes) {
        if (!FOLDER_ITEM_TYPES.has(type)) {
          throw new Error(`listFolderItems(): unknown item type "${type}". Valid types: folder, design, image.`);
        }
      }
    }
    if (opts.sortBy !== undefined && !FOLDER_ITEM_SORTS.has(opts.sortBy)) {
      throw new Error(`listFolderItems(): sortBy must be one of ${[...FOLDER_ITEM_SORTS].map(s => `"${s}"`).join(", ")}.`);
    }
    if (opts.continuation !== undefined && typeof opts.continuation !== "string") {
      throw new Error("listFolderItems(): continuation must be a string when provided.");
    }
    const page = await this.#gk.listFolderItems(folderId.trim(), opts);
    await this.#queue.authorizeObservation({
      title: "List Canva folder contents",
      description: `Read ${page.items.length} item(s) from Canva folder "${folderId.trim()}"` +
        `${opts.itemTypes ? ` (${opts.itemTypes.join(", ")})` : ""}.`,
    });
    return page;
  }
}

// ---------------------------------------------------------------------------
// Resource configurator — the whole-account resource has nothing to choose, so the UI only confirms
// what is being connected and reports the canonical resource URL.

@validateRpc()
class CanvaAccountConfiguratorUI extends RpcTarget implements CanvaAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return CANVA_PROJECTS_URL;
  }
}
