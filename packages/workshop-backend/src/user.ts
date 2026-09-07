import { RpcStub, RpcTarget } from "capnweb";
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, GatekeeperVendorInfo, BlueprintOutput, OutputSummary, WorkpieceId, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, EMPTY_OPENCODE_USER_CUSTOMIZATION, PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES, createProvisionalWorkspaceOriginError, isFinanceOperationsWorkbenchBlueprintId, type CodingSessionApplicationCapability, type CodingSessionAttachCapability, type CodingSessionDevelopmentCatalog, type CodingSessionDevelopmentPlan, type CodingSessionDevelopmentStatus, type CodingSessionEditorCapability, type CodingSessionFileUploadRequest, type CodingSessionFileUploadResult, type CodingSessionOpenCodeCapability, type CodingSessionRepositoryOption, type CodingSessionSummary, type CodingSessionTerminalKind, type CreateCodingSessionRequest, type DeploymentHubId, type OpenCodeUserCustomization, type RequiredConnectionStatus } from '@gadgets/workshop-shared/api';
import { validateCodingSessionFileUploadRequest, validateCodingSessionRepositories, validateOpenCodeCustomization, type CodingSessionOwner, type CodingSessionsService, type ProductFeedbackEvidenceBundle } from "@gadgets/workshop-shared/coding-sessions";
import type { CodingSessionActivity, CodingSessionReadResourceResult, CodingSessionResource, CodingSessionTool, CodingSessionToolResult } from "@gadgets/workshop-shared/coding-sessions";
import type { ProductFeedbackStatus, ProductFeedbackSubmissionResult, SubmitProductFeedbackRequest } from "@gadgets/workshop-shared/product-feedback";
import { PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH, PRODUCT_FEEDBACK_MAX_DIAGNOSTICS, PRODUCT_FEEDBACK_MAX_TEXT_LENGTH, sanitizeProductFeedbackText, validateSubmitProductFeedbackRequest } from "@gadgets/workshop-shared/product-feedback";
import type { GitHubVerifierApi } from "@gadgets/workshop-shared/github-gatekeeper";
import { Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback, SupportedResource, ResourceConfiguratorFrame, AppUiContext, GatekeeperUiFrame, type ActionDescription, type ApprovalQueue, type ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { McpSessionBase } from "@gadgets/mcp-shared/session";
import type { McpCallResult, McpToolInfo } from "@gadgets/mcp-shared/types";
import { shouldAutoProvisionAccount, ambientGatekeeperMode } from "./provisioning-policy.js";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { createWorkshopLogger } from "./observability";
import { getAiGatewayConfig } from "./ai-gateway.js";
import {
  getDefaultTeamPiCodexModel, getTeamPiCodexModelList, isTeamPiCodexEligibleUser,
  isTeamPiCodexMarkerConfig, resolveTeamPiCodexModel,
} from "./team-pi-codex-models.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./blueprint-archive.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import {
  assertCodingSessionMcpResponseSize,
  namespaceCodingSessionResourceUri,
  namespaceCodingSessionToolMetadata,
  parseCodingSessionResourceUri,
  selectCodingSessionResourceBinding,
} from "./coding-session-mcp.js";

const logger = createWorkshopLogger("workshop.user");

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;
const CODING_SESSION_REPOSITORY_OWNER = "totango";
const CODING_SESSION_REPOSITORY_OPTION_LIMIT = 50;
const PRODUCT_FEEDBACK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CODING_SESSION_DISCOVERED_BINDINGS_PER_ACCOUNT = 32;
const RETIRED_GATEKEEPER_VENDOR_IDS = new Set(["team_pi"]);

// The original Team PI gatekeeper service binding has been removed. Keep its persisted records
// inert in code, rather than depending on admin config or on stale stubs failing to deserialize. The
// deployment-provided Team PI Codex model relay is configured through TEAM_PI_CODEX_* env vars, not a
// gatekeeper vendor record, and must not be included in this retirement gate. Operationally, drain or
// reject pending Team PI approvals before removing the binding; this gate prevents new authority but
// does not reach into the retired gatekeeper's own approval queue storage.
/** Returns true for gatekeeper vendor IDs whose persisted accounts/capabilities must stay inert. */
export function isRetiredGatekeeperVendor(vendorId: string): boolean {
  return RETIRED_GATEKEEPER_VENDOR_IDS.has(vendorId.toLowerCase());
}

function retiredGatekeeperError(vendorId: string): Error {
  return new Error(`The "${vendorId}" gatekeeper has been retired on this deployment.`);
}

/** Rejects missing, inactive, archived, or stale coding-session generations. */
export async function assertCurrentCodingSessionGeneration(
  service: Service<CodingSessionsService>,
  owner: CodingSessionOwner,
  sessionId: string,
  sandboxId: string,
): Promise<CodingSessionSummary> {
  const session = await service.getSessionMetadata(owner, sessionId);
  if (!session || session.status !== "running" || session.archivedAt ||
      !await service.isCurrentSessionGeneration(owner, sessionId, sandboxId)) {
    throw new Error("Coding session is not running.");
  }
  return session;
}

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
  // True if the Workshop created this account automatically via GatekeeperVendor.createAccount()
  // (no OAuth flow), rather than the user connecting it. Such accounts are protected from manual
  // disconnect, since deleting one permanently destroys the user's data in that gatekeeper.
  autoProvisioned?: boolean;
  codingSessionGeneration?: string;
  pendingNativeFlow?: { flowHandle: string; kind: "reconnect" | "grant" };
};

type NativeAccountBrowserFlowOptions = {
  flowHandle: string;
  returnUrl: string;
};

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
  authorityKey?: string;
};

// The singleton/UI methods (createAccount on GatekeeperVendor; getSingletonGatekeeperClass /
// startAppUi on GatekeeperUser) are optional on their interfaces. We don't need to probe whether a
// method is present — we already know from the declaration flags (autoProvisionsAccount /
// description.singleton / .providesUi) that we gated on — but TypeScript still can't call an optional
// method on the mapped stub type directly, so we view the stub through a plain shape that marks the
// needed method required. These are derived from the source interfaces (Pick + Required) rather than
// re-declared, so they can't drift. They are intentionally NOT wrapped in Service/Fetcher: a plain
// shape keeps the methods' declared return types (e.g. createAccount's Fetcher<GatekeeperUser>)
// usable directly, the way the runtime stub actually behaves.
type AccountCreatorStub = Required<Pick<GatekeeperVendor, "createAccount">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser,
  "getSingletonGatekeeperClass" | "getSingletonGatekeeperAuthority" | "startAppUi">>;
type ConnectionStatusAccountStub = Required<Pick<GatekeeperUser, "getConnectionStatus">>;

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  // Slack previously reported its refreshable access-token expiry here. Ignore those persisted
  // timestamps; the gatekeeper reports a terminal refresh failure through credentialsExpired.
  if (record.vendorId !== "slack" &&
      record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function codingSessionBindingId(
  vendorId: string,
  accountId: number,
  resourceUrl?: string,
): string {
  const prefix = `${vendorId}-${accountId}`;
  if (!resourceUrl) return prefix;

  let scope = "resource";
  try {
    const url = new URL(resourceUrl);
    const serverId = new URLSearchParams(url.hash.slice(1)).get("server")?.trim();
    if (serverId) scope = serverId.slice(0, 64).replaceAll(/[^A-Za-z0-9-]/g, "-");
  } catch {
    // Leave invalid resource URLs for getGatekeeperClassFor(), which owns authorization checks.
  }
  return `${prefix}-${scope}-${fnv1a32(resourceUrl)}`;
}

/** Canonical native GitHub repository resource URLs exposed to a coding session. */
export function codingSessionGitHubResourceUrls(repositories: string[] | undefined): string[] {
  return (repositories ?? []).map(repo => `https://github.com/${CODING_SESSION_REPOSITORY_OWNER}/${repo}`);
}

function requiredHealthyConnectionVendorIds(env: Cloudflare.Env): string[] {
  let raw = env.REQUIRED_HEALTHY_CONNECTIONS;
  if (!raw) return [];
  let vendorIds = raw.split(",").map(value => value.trim().toLowerCase());
  if (vendorIds.some(value => !/^[a-z][a-z0-9_]*$/.test(value))) {
    throw new Error("REQUIRED_HEALTHY_CONNECTIONS contains an invalid vendor ID.");
  }
  return [...new Set(vendorIds)];
}

/**
 * Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
 * Gateway billing flow is Cloudflare-specific, so several places key off this literal.
 */
export const CLOUDFLARE_VENDOR_ID = "cloudflare";

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

// Blueprint record stored in the user's `blueprints` collection.
type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  // Source of truth for whether the blueprint is featured deployment-wide.
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

/** Delete every version and screenshot stored for an owner-authorized blueprint ID. */
export async function deleteBlueprintContent(
    bucket: Pick<R2Bucket, "list" | "delete">, id: string): Promise<void> {
  while (true) {
    let objects = await bucket.list({
      prefix: `${id}/`, limit: 1000,
    });
    if (objects.objects.length === 0) break;
    await bucket.delete(objects.objects.map(({key}) => key));
  }
  await bucket.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);
}

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

/**
 * One output of a workspace, as pushed into a user's output index by the Overseer that owns it
 * (see `syncWorkspaceOutputs()`). Carries only what the workspace itself knows: its title,
 * activity time and ownership are joined in from the `gadgets` collection on read, so they can't
 * go stale here.
 */
export type WorkspaceOutputEntry = {
  workpieceId: WorkpieceId;
  title: string;
  created: Date;

  /** The format the gadget was built as, if it was instantiated from a blueprint declaring one. */
  output?: BlueprintOutput;
};

type OutputRecord = WorkspaceOutputEntry & {
  // The workspace containing this output (an Overseer DO id).
  workspaceId: string;
};

type CodingSessionActionRecord = CodingSessionActivity & {
  bindingId: string;
  bindingGeneration: string;
  gatekeeperActionId: number;
};

type CodingSessionMcpBinding = {
  id: string;
  generation: string;
  vendorId: string;
  resourceTitle: string;
  facet: Fetcher<Gatekeeper<McpSessionBase>>;
};

class CodingSessionApprovalQueue extends RpcTarget implements ApprovalQueue {
  constructor(
    private readonly user: UserDurableObject,
    private readonly sessionId: string,
    private readonly binding: CodingSessionMcpBinding,
  ) {
    super();
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    this.user.recordCodingSessionObservation(this.sessionId, this.binding, description);
    return Promise.resolve();
  }

  getSessionSurface(): Promise<"code"> {
    return Promise.resolve("code");
  }

  submitAction(action: number, description: ActionDescription): Promise<void> {
    this.user.recordCodingSessionAction(this.sessionId, this.binding, action, description);
    return Promise.resolve();
  }

  bindHook(): never {
    throw new Error("Coding sessions cannot register persistent hooks.");
  }
}

// AI Gateway billing state for the optional top-up flow: which Cloudflare account to bill and a
// cached credit balance. The OAuth tokens themselves live in the connected Cloudflare *gatekeeper*
// account (vendorId "cloudflare"); billing reads a usable token from there via getUsableAccessToken.
type CloudflareBilling = {
  // Selected account, once chosen (auto-selected when the grant sees exactly one).
  accountId?: string;
  accountName?: string;
  // Cached credit balance (USD) and when it was last fetched (unix ms).
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
      // Outputs of every workspace in `gadgets`, mirrored here by each workspace's Overseer so the
      // Outputs page is one cheap read of the user's own DO. Entries are meaningful only while the
      // corresponding `gadgets` record exists; `syncWorkspaceOutputs()` and the `gadgets` deletion
      // paths keep the two in step.
      outputs: collection<OutputRecord>()({
        primaryKey: record => `${record.workspaceId}:${record.workpieceId}`,
        nonUniqueIndexes: {
          byWorkspace(record: OutputRecord) { return record.workspaceId; },
        },
      }),
      codingSessionActions: collection<CodingSessionActionRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: {
          bySession(record: CodingSessionActionRecord) { return record.sessionId; },
        },
      }),
    },
    singletons: {
      // AI Gateway billing state (selected account + cached balance) for the optional top-up flow;
      // null until a Cloudflare account is connected and resolved.
      cloudflareBilling: <CloudflareBilling | null>null,

      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      simplifiedTechnicalEnglishEnabled: false,
      preferredModel: <string | null>null,
      onboardingCompleted: false,
      openCodeCustomization: EMPTY_OPENCODE_USER_CUSTOMIZATION,

      // Set once the user's pre-existing workspaces have been asked to populate the outputs index
      // (see #backfillOutputs()). Workspaces created since push on their own.
      outputsBackfilled: false,

      // How far that catch-up has got: the last workspace id examined. The sweep runs a page at a
      // time and resumes here on the next visit.
      outputsBackfillCursor: "",

      nextAccountId: 0,
      pinnedBlueprints: <string[]>[],

      // Per-user free-tier daily LLM-call counter (only used when ENABLE_CLOUDFLARE_LIMITS is on).
      // Stores the current UTC day and the calls made that day; a stale `day` implicitly resets the
      // count. Folds the former standalone RateLimitDO into the user object.
      dailyLlmCount: <{ day: string; count: number } | null>null,

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
    }
  });
}

type UserStorage = ReturnType<typeof makeUserStorage>;

function unavailableGatekeeperVendorInfo(id: string): GatekeeperVendorInfo {
  return {
    id,
    unavailable: true,
    description: {
      displayName: id,
      url: "",
      tagline: "Temporarily unavailable",
      description: "This gatekeeper could not be loaded.",
    },
    supportedResources: [],
  };
}

async function checkGatekeeperVendorFilter(
    vendor: Service<GatekeeperVendor> | Service<GatekeeperUser>,
    vendorId: string,
    filter: GatekeeperVendorFilter): Promise<boolean> {
  try {
    if (filter.resourceUrl) {
      let resources = await vendor.getSupportedResources();
      let matched = false;
      for (let resource of resources) {
        if (typeof resource.urlPattern !== "string") {
          // Guard against gatekeepers returning a non-string urlPattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
        }

        if (new URLPattern(resource.urlPattern).test(filter.resourceUrl)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  } catch (err) {
    // This function is called when iterating over several gatekeepers to filter them. If one of
    // them throws we don't want to block the whole list, so instead log the error and assume this
    // gatekeeper should be filtered.
    logger.warn("gatekeeper filter check failed", {
      event: "gatekeeper.filter.check.failed", vendorId, error: err,
    });
    return false;
  }
}

function normalizedPathname(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("Feedback route pathname is invalid.");
  }
  return boundedText(value, 512);
}

function boundedText(value: string, limit: number): string {
  return typeof value === "string" && value.length > limit ? value.slice(0, limit) : `${value ?? ""}`;
}

function sanitizeFeedbackText(value: string, limit: number): string {
  return boundedText(sanitizeProductFeedbackText(value), limit);
}

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private sessionsService?: Service<CodingSessionsService>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // Migrate data created prior to the minions -> gadgets rename.
    // TODO(cleanup): Eventually remove this, very few people ever used it as "minions".
    for (let [key, value] of Array.from(ctx.storage.kv.list({prefix: "minions:"}))) {
      let newKey = "gadgets:" + key.slice("minions:".length);
      ctx.storage.kv.put(newKey, value);
      ctx.storage.kv.delete(key);
    }

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.vendors = buildGatekeeperVendorMap(env);
    this.sessionsService = (env as unknown as Record<string, Service<CodingSessionsService>>)
      .GATEKEEPER_SESSIONS;
  }

  async authenticate(token: string): Promise<void> {
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    if (!this.storage.created.get()) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      return true;
    }

    return false;
  }

  async #newSessionToken(): Promise<string> {
    let sessionToken = new Uint8Array(32);
    crypto.getRandomValues(sessionToken);

    let tokenId = new Uint8Array(await crypto.subtle.digest('SHA-256', sessionToken)).toHex();
    this.storage.sessions.put({ tokenId, created: new Date() });

    return sessionToken.toBase64();
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    // Do a little migration here for old data.
    // TODO(soon): Delete this.
    for (let gadget of Array.from(this.storage.gadgets.list())) {
      if (!gadget.created || !gadget.lastActive) {
        if (!gadget.created) {
          gadget.created = new Date("2026-01-01");
        }
        if (!gadget.lastActive) {
          gadget.lastActive = new Date("2026-01-01");;
        }
        this.storage.gadgets.put(gadget);
      }
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  /**
   * Called by the overseer every time a collaborator opens a shared gadget.
   * Creates the record on first open; updates lastActive on subsequent opens.
   *
   * `role` is cached so listings built from this DO can offer the actions it permits without
   * reopening the workspace to ask. Presentation only: every operation is still authorized by the
   * Overseer when attempted.
   */
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole,
      originHubId?: DeploymentHubId,
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this workspace; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      record.role = role;
      if (originHubId) record.originHubId = originHubId;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        ...(originHubId ? {originHubId} : {}),
        created: now,
        lastActive: now,
      });
    }
  }

  /**
   * Updates the presentation-only role cached for a shared workspace listing. Authorization still
   * comes from the Overseer's live sharing graph; this only keeps the listing's available actions
   * accurate after a collaborator is downgraded.
   */
  async updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record?.owner) return;
    record.role = role;
    this.storage.gadgets.put(record);
  }

  /**
   * Forgets a gadget shared with this user: drops it from their workspace listing and its outputs
   * from their Outputs index. Called both when the user dismisses it and when their access is
   * revoked (Overseer.refreshAffectedCollaboratorListings()); it grants and revokes nothing.
   */
  async forgetSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
      this.storage.outputs.byWorkspace.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
  }

  #canUseTeamPiCodex(): boolean {
    return isTeamPiCodexEligibleUser(
      this.storage.profile.get().id,
      this.storage.passwordHashHash.get() !== null,
    );
  }

  #isTeamPiCodexOnly(): boolean {
    return this.env.TEAM_PI_CODEX_ONLY === "true";
  }

  #getUserConfiguredModel(id: string): UserAiModelRecord | undefined {
    const model = this.storage.aiModels.get(id);
    return model && !isTeamPiCodexMarkerConfig(model.config) ? model : undefined;
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    if (this.#isTeamPiCodexOnly()) {
      return this.#canUseTeamPiCodex() ? getTeamPiCodexModelList(this.env) : [];
    }

    let result: AiChatAuthorInfo[] = [];
    let reservedModelIds = new Set<string>();

    if (this.#canUseTeamPiCodex()) {
      for (let entry of getTeamPiCodexModelList(this.env)) {
        result.push(entry);
        reservedModelIds.add(entry.id);
      }
    }

    // When AI Gateway mode is active, include all suggested models for enabled providers.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let entry of gwConfig.getModelList()) {
        result.push(entry);
        reservedModelIds.add(entry.id);
      }
    }

    // Also include user-configured models, skipping any that duplicate a gateway model.
    for (let model of this.storage.aiModels.list()) {
      if (!reservedModelIds.has(model.profile.id) && !isTeamPiCodexMarkerConfig(model.config)) {
        result.push(model.profile);
      }
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    if (this.#isTeamPiCodexOnly()) {
      throw new Error("This deployment only supports Team PI Codex models.");
    }
    if (isTeamPiCodexMarkerConfig(config)) {
      throw new Error("Team PI Codex models are deployment-provided and cannot be added manually.");
    }
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig && !gwConfig.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }

    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting built-in suggested models.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
        if (gwConfig.providers.has(provider) && id in models) {
          throw new Error(`Cannot delete built-in model "${models[id].name}".`);
        }
      }
    }
    const teamPiModel = resolveTeamPiCodexModel(this.env, id);
    if (teamPiModel) {
      throw new Error(`Cannot delete built-in model "${teamPiModel.profile.name}".`);
    }

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    if (this.#isTeamPiCodexOnly() && id !== null &&
        (!this.#canUseTeamPiCodex() || !resolveTeamPiCodexModel(this.env, id))) {
      throw new Error(`No such model: ${id}`);
    }
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    if (this.#isTeamPiCodexOnly()) {
      if (!this.#canUseTeamPiCodex()) return null;
      const selected = this.storage.quickModel.get();
      return (selected ? resolveTeamPiCodexModel(this.env, selected)?.profile.id : undefined) ??
          getDefaultTeamPiCodexModel(this.env, this.storage.profile.get().id)?.profile.id ?? null;
    }
    let result = this.storage.quickModel.get();
    if (result && this.#getUserConfiguredModel(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getSimplifiedTechnicalEnglishEnabled(): Promise<boolean> {
    return this.storage.simplifiedTechnicalEnglishEnabled.get();
  }

  async setSimplifiedTechnicalEnglishEnabled(enabled: boolean): Promise<void> {
    this.storage.simplifiedTechnicalEnglishEnabled.put(enabled);
  }

  async getPreferredModel(): Promise<string | null> {
    const preferred = this.storage.preferredModel.get();
    if (this.#isTeamPiCodexOnly()) {
      if (!this.#canUseTeamPiCodex()) return null;
      return (preferred ? resolveTeamPiCodexModel(this.env, preferred)?.profile.id : undefined) ??
          getDefaultTeamPiCodexModel(this.env, this.storage.profile.get().id)?.profile.id ?? null;
    }
    if (preferred && !preferred.startsWith("team-pi-codex/")) return preferred;
    return (preferred && this.#canUseTeamPiCodex() && resolveTeamPiCodexModel(this.env, preferred)
      ? preferred
      : undefined) ??
        (this.#canUseTeamPiCodex()
          ? getDefaultTeamPiCodexModel(this.env, this.storage.profile.get().id)?.profile.id
          : undefined) ?? null;
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Validate that the model exists in the user's configured models or as a gateway model.
      let exists = this.#isTeamPiCodexOnly()
        ? this.#canUseTeamPiCodex() && !!resolveTeamPiCodexModel(this.env, id)
        : !!this.#getUserConfiguredModel(id) || !!getAiGatewayConfig(this.env)?.resolveModel(id) ||
          (this.#canUseTeamPiCodex() && !!resolveTeamPiCodexModel(this.env, id));
      if (!exists) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get() ||
        (this.#canUseTeamPiCodex() &&
         !!getDefaultTeamPiCodexModel(this.env, this.storage.profile.get().id));
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Cloudflare account connection (optional top-up flow).
  // ---------------------------------------------------------------------------------------------

  /**
   * Return the connected Cloudflare *gatekeeper* account stub, if any. The AI Gateway billing flow
   * narrows it to CloudflareGatekeeperUser to obtain a usable access token. Null if the user hasn't
   * connected (or signed in with) Cloudflare.
   */
  async getCloudflareGatekeeperAccount(): Promise<Fetcher<CloudflareGatekeeperUser> | null> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try { rec = this.storage.connectedAccounts.get(id); } catch { continue; }
      if (rec && rec.vendorId === CLOUDFLARE_VENDOR_ID) {
        return rec.account as unknown as Fetcher<CloudflareGatekeeperUser>;
      }
    }
    return null;
  }

  /** The AI Gateway billing state (selected account + cached balance), or null if unset. */
  async getCloudflareBilling(): Promise<CloudflareBilling | null> {
    return this.storage.cloudflareBilling.get();
  }

  /** Update the cached credit balance for the billed account. */
  async updateCloudflareCredits(creditsRemaining: number | null): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.creditsRemaining = creditsRemaining;
    record.creditsUpdatedAt = Date.now();
    this.storage.cloudflareBilling.put(record);
  }

  /**
   * Persist which Cloudflare account to bill. Clears the cached credit balance (it belonged to the
   * old account).
   */
  async setCloudflareAccountSelection(accountId: string, accountName?: string): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.accountId = accountId;
    record.accountName = accountName;
    record.creditsRemaining = undefined;
    record.creditsUpdatedAt = undefined;
    this.storage.cloudflareBilling.put(record);
  }

  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  /** Read the current daily quota state without counting a call. */
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  /**
   * Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
   * pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
   * so a blocked request never counts.
   */
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. Pure read: call sites replay it across DO resets
   * via retryOnDoReset, so it must stay free of writes and side effects. */
  async getChatContext(modelId: string | null): Promise<UserChatContext> {
    let gwConfig = getAiGatewayConfig(this.env);
    const teamPiOnly = this.#isTeamPiCodexOnly();

    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      if (teamPiOnly && this.#canUseTeamPiCodex()) {
        result.aiModel = resolveTeamPiCodexModel(this.env, modelId);
      } else if (gwConfig) {
        // In AI Gateway mode, resolve gateway models first.
        result.aiModel = gwConfig.resolveModel(modelId);
      }
      if (!result.aiModel && !teamPiOnly && this.#canUseTeamPiCodex()) {
        result.aiModel = resolveTeamPiCodexModel(this.env, modelId);
      }
      if (!result.aiModel && !teamPiOnly) {
        result.aiModel = this.#getUserConfiguredModel(modelId);
      }
      if (!result.aiModel) throw new Error(`No such model: ${modelId}`);
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (teamPiOnly && this.#canUseTeamPiCodex()) {
      const selected = this.storage.quickModel.get();
      result.quickModel = (selected ? resolveTeamPiCodexModel(this.env, selected)?.config : undefined) ??
          getDefaultTeamPiCodexModel(this.env, result.profile.id)?.config;
    } else if (gwConfig) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = gwConfig.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.#getUserConfiguredModel(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
      if (this.#canUseTeamPiCodex()) {
        result.quickModel ??=
            getDefaultTeamPiCodexModel(this.env, result.profile.id)?.config;
      }
    }
    return result;
  }

  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    let models = await this.listModels();
    // Prefer the existing chat's model, then the user's preferred model, then the first available model.
    let selectedModel = models.find(model => model.id === existingChatModelId)
      ?? models.find(model => model.id === this.storage.preferredModel.get())
      ?? models[0];

    return this.getChatContext(selectedModel?.id ?? null);
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let result: GadgetMetadataWithTimestamps[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget)) {
        result.push(gadget);
      }
    }
    return result;
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  /** Return a coarse classification of the claimed Finance workspace's owner registration. */
  getFinanceGadgetRegistrationStatus(id: string):
      "missing" | "missing-origin" | "healthy" | "shared" | "non-finance" | "duplicate" {
    let exact = this.storage.gadgets.get(id);
    if (exact?.owner) return "shared";
    for (let gadget of this.storage.gadgets.list()) {
      if (!gadget.owner && gadget.originHubId === "finance" && gadget.id !== id) return "duplicate";
    }
    if (!exact) return "missing";
    if (exact.originHubId === undefined) return "missing-origin";
    return exact.originHubId === "finance" ? "healthy" : "non-finance";
  }

  /**
   * Atomically repair one claimed Finance owner registration. Only a missing record or an existing
   * owner record with no origin can change; every conflicting state is returned unchanged.
   */
  async repairFinanceGadgetRegistration(id: string): Promise<
      "inserted" | "updated" | "missing" | "missing-origin" | "healthy" |
      "shared" | "non-finance" | "duplicate"> {
    if (!this.storage.created.get()) return "missing";
    let status = this.getFinanceGadgetRegistrationStatus(id);
    if (status === "missing") {
      this.storage.gadgets.put({
        id,
        title: "Finance Operations Workbench",
        created: new Date(),
        originHubId: "finance",
      });
      return "inserted";
    }
    if (status === "missing-origin") {
      let record = this.storage.gadgets.get(id)!;
      record.originHubId = "finance";
      this.storage.gadgets.put(record);
      return "updated";
    }
    return status;
  }

  async newGadget(id: string, title: string, originHubId?: DeploymentHubId): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created, ...(originHubId ? {originHubId} : {})});
  }

  /** Atomically register the deployment's one Finance workspace for this owner. */
  async registerFinanceGadget(id: string, title: string): Promise<"inserted" | "existing"> {
    let exact = this.storage.gadgets.get(id);
    if (exact && (exact.owner || exact.originHubId !== "finance" || exact.title !== title)) {
      throw new Error("The Finance workspace registration conflicts with an existing workspace.");
    }
    for (let gadget of this.storage.gadgets.list()) {
      if (gadget.originHubId === "finance") {
        if (gadget.id !== id || gadget.title !== title || gadget.owner) {
          throw new Error("A Finance workspace already exists for this user.");
        }
      }
    }
    if (exact) return "existing";
    this.storage.gadgets.put({id, title, created: new Date(), originHubId: "finance"});
    return "inserted";
  }

  async ensureGadgetRegistered(id: string, title: string, originHubId?: DeploymentHubId): Promise<void> {
    if (this.storage.gadgets.get(id)) return;
    await this.newGadget(id, title, originHubId);
  }

  async updateProvisionalWorkspaceOrigin(id: string, originHubId: DeploymentHubId): Promise<void> {
    let record = this.storage.gadgets.get(id);
    if (!record || record.owner) {
      throw createProvisionalWorkspaceOriginError(
          PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES.workspaceNotFound);
    }
    if (record.lastActive !== undefined) {
      throw createProvisionalWorkspaceOriginError(
          PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES.workspaceAlreadyActive);
    }
    if (record.originHubId === originHubId) return;
    record.originHubId = originHubId;
    this.storage.gadgets.put(record);
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
    this.storage.outputs.byWorkspace.delete(id);
  }

  /**
   * Replace the set of outputs recorded for one workspace. Called by that workspace's Overseer
   * whenever its gadget registry changes and whenever it is opened.
   *
   * A workspace the user no longer tracks (deleted, or a shared one they dismissed) has its
   * entries dropped.
   */
  syncWorkspaceOutputs(workspaceId: string, entries: WorkspaceOutputEntry[]): void {
    this.storage.outputs.byWorkspace.delete(workspaceId);
    if (!this.storage.gadgets.get(workspaceId)) return;
    for (let entry of entries) {
      this.storage.outputs.put({...entry, workspaceId});
    }
  }

  async listOutputs(): Promise<ListOutputsResult> {
    let catchingUp = await this.#backfillOutputs();
    return {outputs: this.#readOutputs(), catchingUp};
  }

  // Ask the user's pre-existing workspaces to populate the outputs index, once. Workspaces push as
  // they change and when opened, so only those predating the index need this.
  //
  // Sweeps one bounded page and reports whether more remains, rather than sweeping everything: a
  // first Outputs load must not wait on every workspace the user has ever created. The caller
  // drains the rest, so the list fills in while the page is open.
  async #backfillOutputs(): Promise<boolean> {
    if (this.storage.outputsBackfilled.get()) return false;

    let startAfter = this.storage.outputsBackfillCursor.get() || undefined;
    let cursor = startAfter ?? "";
    let targets: string[] = [];
    let examined = 0;
    for (let gadget of this.storage.gadgets.list({startAfter, limit: OUTPUTS_BACKFILL_PAGE})) {
      ++examined;
      cursor = gadget.id;
      // A shared workspace is mirrored on open, not swept; a half-created one has nothing yet.
      if (!gadget.owner && isFullyCreated(gadget)) targets.push(gadget.id);
    }
    let done = examined < OUTPUTS_BACKFILL_PAGE;

    let ownerId = this.ctx.id.toString();
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(targets.map(id =>
        overseers.get(overseers.idFromString(id)).getOutputsForOwnerBackfill(ownerId)));

    let failureCount = 0;
    let firstError: unknown;
    for (let [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (result.value) this.syncWorkspaceOutputs(targets[index], result.value);
      } else {
        if (failureCount === 0) firstError = result.reason;
        ++failureCount;
      }
    }

    if (failureCount > 0) {
      logger.warn("failed to backfill outputs for some workspaces", {
        event: "outputs.backfill.partial",
        failureCount,
        error: firstError,
      });
    }

    // Advance past workspaces that failed, rather than retrying them. The index is self-healing,
    // so one missed here reappears the moment it is touched, whereas holding the cursor lets a
    // single unwakeable workspace stall the sweep forever.
    if (done) {
      this.storage.outputsBackfilled.put(true);
    } else {
      this.storage.outputsBackfillCursor.put(cursor);
    }

    // A page where everything failed looks systemic, so stop draining and let the next visit pick
    // up from the next page: draining on would be a burst of doomed calls during an outage.
    if (failureCount > 0 && failureCount === targets.length) return false;
    return !done;
  }

  #readOutputs(): OutputSummary[] {
    let result: OutputSummary[] = [];
    for (let output of this.storage.outputs.list()) {
      let workspace = this.storage.gadgets.get(output.workspaceId);
      if (!workspace || !isFullyCreated(workspace)) continue;
      result.push({
        workspaceId: output.workspaceId,
        workpieceId: output.workpieceId,
        ...(output.output ? {output: output.output} : {}),
        title: output.title,
        workspaceTitle: workspace.title,
        created: output.created,
        lastActive: workspace.lastActive,
        ...(workspace.owner ? {owner: workspace.owner} : {}),
        ...(workspace.role ? {role: workspace.role} : {}),
        ...(workspace.originHubId ? {originHubId: workspace.originHubId} : {}),
      });
    }
    result.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return result;
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    if (isFinanceOperationsWorkbenchBlueprintId(id)) {
      throw new Error("Blueprint not found.");
    }
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    if (isFinanceOperationsWorkbenchBlueprintId(id)) {
      throw new Error("Blueprint not found.");
    }
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    if (existing) {
      existing.metadata = kvRecord.metadata;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    if (isFinanceOperationsWorkbenchBlueprintId(id)) return null;
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord && kvRecord.ownerId !== this.ctx.id.toString()) {
      throw new Error("You don't own this blueprint.");
    }

    let sourceGadgetIds = [publishedRecord?.gadgetId, kvRecord?.gadgetId]
        .filter((gadgetId): gadgetId is string => gadgetId !== undefined);
    if (sourceGadgetIds.some(gadgetId => this.storage.gadgets.get(gadgetId))) {
      throw new Error("Delete this blueprint from its source workspace.");
    }

    // Local owner records remain authoritative for cleanup when KV publication is absent or stale.
    // Listing the exact prefix also finds versions newer than the last metadata that propagated.
    await deleteBlueprintContent(this.env.BLUEPRINT_CONTENT, id);

    // Delete from KV after content cleanup. A retry can still establish ownership from local state.
    await this.env.BLUEPRINTS.delete(id);

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.libraryBlueprints.list()) {
      if (isFinanceOperationsWorkbenchBlueprintId(record.id)) continue;
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<GatekeeperVendorInfo[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    // Admin-disabled resources/gatekeepers are filtered out here, which also covers the agent (the
    // Overseer's connectable-vendor/resource list is sourced from this method).
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<GatekeeperVendorInfo | null>[] = [];

    for (let [id, vendor] of this.vendors) {
      if (isRetiredGatekeeperVendor(id)) {
        continue;
      }
      if (disabledGatekeeperSet.has(id)) {
        continue;  // Whole gatekeeper disabled by admin.
      }
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, id, filter))) {
          return null;
        }

        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources(options),
          ]);
          let enabledResources =
              filterEnabledResources(config, id, supportedResources);
          if (enabledResources.length == 0) {
            // Every resource for this vendor is disabled (or it advertised none) — hide the vendor.
            return null;
          }

          return {id, description, supportedResources: enabledResources};
        } catch (err) {
          logger.warn("failed to load gatekeeper vendor", {
            event: "gatekeeper.vendor.load.failed", vendorId: id, error: err,
          });
          return unavailableGatekeeperVendorInfo(id);
        }
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async getRequiredConnectionStatuses(): Promise<RequiredConnectionStatus[]> {
    const requiredVendorIds = requiredHealthyConnectionVendorIds(this.env);
    if (requiredVendorIds.length === 0) return [];

    const config = await readAdminConfig(this.env);
    const disabledGatekeepers = new Set(config.disabledGatekeepers);
    return Promise.all(requiredVendorIds.map(vendorId =>
      this.#requiredConnectionStatus(vendorId, disabledGatekeepers)));
  }

  /** Rejects operations that require every deployment-mandated connection to be healthy. */
  async assertRequiredConnectionsHealthy(): Promise<void> {
    const statuses = await this.getRequiredConnectionStatuses();
    if (statuses.some(({ state }) => state !== "healthy")) {
      throw new Error("Required connections must be healthy before using workspaces or coding sessions.");
    }
  }

  async #requiredConnectionStatus(vendorId: string, disabledGatekeepers: Set<string>)
      : Promise<RequiredConnectionStatus> {
    if (isRetiredGatekeeperVendor(vendorId)) {
      return { vendorId, displayName: vendorId, state: "unavailable", message: "Required service has been retired." };
    }
    const vendor = this.vendors.get(vendorId);
    const displayName = await this.#requiredVendorDisplayName(vendorId, vendor);
    if (!vendor) {
      return { vendorId, displayName, state: "unavailable", message: "Required service is not installed." };
    }
    if (disabledGatekeepers.has(vendorId)) {
      return { vendorId, displayName, state: "unavailable", message: "Required service is disabled by an administrator." };
    }

    const records = [...this.#connectedAccountRecords()].filter(record => record.vendorId === vendorId);
    if (records.length === 0) {
      return { vendorId, displayName, state: "missing", message: "Connect this required service." };
    }

    let fallback: RequiredConnectionStatus | undefined;
    for (const record of records) {
      if (!areCredentialsValid(record)) {
        fallback ??= {
          vendorId,
          displayName,
          state: "expired",
          accountId: record.id,
          message: "Reconnect this required service.",
        };
        continue;
      }
      try {
        const status = await (record.account as unknown as ConnectionStatusAccountStub)
          .getConnectionStatus();
        if (status.state === "expired") await this.markCredentialsExpired(record.id);
        const result = {
          vendorId,
          displayName,
          state: status.state,
          accountId: record.id,
          message: status.message,
        } satisfies RequiredConnectionStatus;
        if (status.state === "healthy") return result;
        fallback ??= result;
      } catch (error) {
        logger.warn("required connection status check failed", {
          event: "required.connection.status.failed", vendorId, accountId: record.id, error,
        });
        fallback ??= {
          vendorId,
          displayName,
          state: "unavailable",
          accountId: record.id,
          message: "The required connection could not be checked. Try again or contact an administrator.",
        };
      }
    }
    return fallback ?? { vendorId, displayName, state: "missing", message: "Connect this required service." };
  }

  async #requiredVendorDisplayName(vendorId: string, vendor: Service<GatekeeperVendor> | undefined)
      : Promise<string> {
    if (!vendor) return vendorId;
    try {
      return (await vendor.describe()).displayName;
    } catch {
      return vendorId;
    }
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[], nativeFlow?: NativeAccountBrowserFlowOptions): Promise<{url: string}> {
    if (isRetiredGatekeeperVendor(vendorId)) {
      throw retiredGatekeeperError(vendorId);
    }
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(vendorId.toLowerCase())) {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({
      props: nativeFlow ? { ...props, flowHandle: nativeFlow.flowHandle } : props,
    });

    let {url} = await vendor.connectAccount(callback, {
      resourceUrlPatterns,
      returnUrl: nativeFlow?.returnUrl,
    });
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return {url};
  }

  // Iterate every connected-account record, skipping any that fails to load. A record can fail to
  // deserialize when its account stub points at a gatekeeper Worker that's no longer bound in this
  // deployment (workerd throws "Stub refers to a service that doesn't exist"). Skipping it keeps one
  // stale account from breaking listing, provisioning, and opt-in for all the others — the same
  // resilience subscribeConnectedAccounts relies on (it iterates through this).
  *#connectedAccountRecords(): Generator<ConnectedAccountRecord> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try {
        rec = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account: failed to load", {
          event: "connected.account.load.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (rec) yield rec;
    }
  }

  // Whether this user already has a connected account for the given vendor.
  #hasAccountForVendor(vendorId: string): boolean {
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.vendorId === vendorId) return true;
    }
    return false;
  }

  async #codingSessionsAccess(repositories?: readonly string[]): Promise<{
    owner: CodingSessionOwner;
    service: Service<CodingSessionsService>;
  }> {
    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes("github")) {
      throw new Error("GitHub is disabled on this deployment.");
    }
    let service = this.sessionsService;
    if (!service) throw new Error("Coding sessions are not installed on this deployment.");
    const canonicalRepositories = repositories === undefined
      ? undefined
      : validateCodingSessionRepositories(repositories);

    for (let record of this.#connectedAccountRecords()) {
      if (record.vendorId !== "github" || !areCredentialsValid(record)) continue;
      let description = await record.account.describe();
      if (canonicalRepositories) {
        let verifier = await record.account.getVerifier() as unknown as Fetcher<GitHubVerifierApi>;
        let access = await Promise.all(canonicalRepositories.map(repository =>
          verifier.hasRepoWriteAccess(CODING_SESSION_REPOSITORY_OWNER, repository)));
        if (access.some(allowed => !allowed)) {
          throw new Error("Your GitHub account cannot push to every selected repository.");
        }
      }
      let profile = await this.whoami();
      return {
        owner: {
          userId: this.ctx.id.toString(),
          email: profile.id,
          githubLogin: description.uniqueName,
        },
        service,
      };
    }
    throw new Error("Connect a valid GitHub account to use coding sessions.");
  }

  async #githubVerifierForCodingSessions(): Promise<Fetcher<GitHubVerifierApi>> {
    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes("github")) {
      throw new Error("GitHub is disabled on this deployment.");
    }
    for (let record of this.#connectedAccountRecords()) {
      if (record.vendorId !== "github" || !areCredentialsValid(record)) continue;
      return await record.account.getVerifier() as unknown as Fetcher<GitHubVerifierApi>;
    }
    throw new Error("Connect a valid GitHub account to use coding sessions.");
  }

  async #codingSessionsOwner(): Promise<{
    owner: CodingSessionOwner;
    service: Service<CodingSessionsService>;
  }> {
    const service = this.sessionsService;
    if (!service) throw new Error("Coding sessions are not installed on this deployment.");
    const profile = await this.whoami();
    return { owner: { userId: this.ctx.id.toString(), email: profile.id }, service };
  }

  /** Reports whether this deployment has browser VS Code configured. */
  async codingSessionEditorAvailable(): Promise<boolean> {
    let {service} = await this.#codingSessionsOwner();
    return service.editorAvailable();
  }

  /** Lists owned coding sessions even when GitHub credentials need reconnection. */
  async listCodingSessions(): Promise<CodingSessionSummary[]> {
    let {owner, service} = await this.#codingSessionsOwner();
    return service.listSessions(owner);
  }

  /** Reads the development catalog for a currently authorized coding-session user. */
  async getCodingSessionDevelopmentCatalog(): Promise<CodingSessionDevelopmentCatalog> {
    let {owner, service} = await this.#codingSessionsAccess();
    return service.getDevelopmentCatalog(owner);
  }

  /** Preflights a coding session after re-authorizing every requested repository. */
  async preflightCodingSession(request: CreateCodingSessionRequest): Promise<CodingSessionDevelopmentPlan> {
    const repositories = validateCodingSessionRepositories(request.repositories);
    let {owner, service} = await this.#codingSessionsAccess(repositories);
    return service.preflightSession(owner, { ...request, repositories });
  }

  /** Reads development status after verifying ownership and current repository authority. */
  async getCodingSessionDevelopmentStatus(sessionId: string): Promise<CodingSessionDevelopmentStatus> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.getDevelopmentStatus(owner, sessionId);
  }

  /** Lists Totango repositories the connected GitHub account can push to. */
  async listCodingSessionRepositoryOptions(query?: string): Promise<CodingSessionRepositoryOption[]> {
    const verifier = await this.#githubVerifierForCodingSessions();
    const trimmed = (query ?? "").trim();
    if (trimmed) {
      return verifier.searchReposWithWriteAccess(
        CODING_SESSION_REPOSITORY_OWNER, trimmed, CODING_SESSION_REPOSITORY_OPTION_LIMIT);
    }
    return verifier.listReposWithWriteAccess(
      CODING_SESSION_REPOSITORY_OWNER, CODING_SESSION_REPOSITORY_OPTION_LIMIT);
  }

  /** Creates a coding session after enforcing a valid GitHub connection. */
  async createCodingSession(request: CreateCodingSessionRequest): Promise<CodingSessionSummary> {
    const repositories = validateCodingSessionRepositories(request.repositories);
    let {owner, service} = await this.#codingSessionsAccess(repositories);
    return service.createSession(
      owner, { ...request, repositories }, validateOpenCodeCustomization(this.storage.openCodeCustomization.get()));
  }

  /**
   * Private Sessions-worker callback that rechecks live startup authorization and returns current
   * bounded OpenCode customization for immediate alarm-time materialization.
   */
  async prepareCodingSessionStartup(repositories: string[]): Promise<OpenCodeUserCustomization> {
    await this.#codingSessionsAccess(repositories);
    return this.storage.openCodeCustomization.get();
  }

  /** Reads the OpenCode customization persisted for this account. */
  getOpenCodeCustomization(): OpenCodeUserCustomization {
    return this.storage.openCodeCustomization.get();
  }

  /** Replaces this account's OpenCode customization after validating bounded plugin and skill data. */
  setOpenCodeCustomization(customization: OpenCodeUserCustomization): void {
    this.storage.openCodeCustomization.put(validateOpenCodeCustomization(customization));
  }

  /** Stops an owned coding session even if its GitHub connection has expired. */
  async stopCodingSession(sessionId: string): Promise<void> {
    let {owner, service} = await this.#codingSessionsOwner();
    return service.stopSession(owner, sessionId);
  }

  /** Rebuilds an owned coding session after rechecking repository access. */
  async restartCodingSession(sessionId: string): Promise<CodingSessionSummary> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.restartSession(owner, sessionId, validateOpenCodeCustomization(this.storage.openCodeCustomization.get()));
  }

  /** Stops and archives an owned coding session even if its GitHub connection has expired. */
  async archiveCodingSession(sessionId: string): Promise<void> {
    let {owner, service} = await this.#codingSessionsOwner();
    return service.archiveSession(owner, sessionId);
  }

  /** Mints a terminal attachment capability after enforcing a valid GitHub connection. */
  async mintCodingSessionAttachCapability(
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.mintAttachCapability(owner, sessionId, terminal);
  }

  /** Mints a browser VS Code capability after re-authorizing every session repository. */
  async mintCodingSessionEditorCapability(sessionId: string): Promise<CodingSessionEditorCapability> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.mintEditorCapability(owner, sessionId);
  }

  /** Mints an OpenCode server capability after re-authorizing every session repository. */
  async mintCodingSessionOpenCodeCapability(sessionId: string): Promise<CodingSessionOpenCodeCapability> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.mintOpenCodeCapability(owner, sessionId);
  }

  /** Attaches to an existing Pi process after rechecking all owner access requirements. */
  async connectCodingSessionPi(sessionId: string): Promise<import('@gadgets/workshop-shared/api').CodingSessionPiConnection> {
    const initial = await this.#codingSessionsOwner();
    const session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    const {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.connectPi(owner, sessionId);
  }

  /** Rechecks owner authority on every Pi operation, including reads and dialog responses. */
  async callCodingSessionPi(sessionId: string, connectionId: string, command: import('@gadgets/workshop-shared/api').CodingSessionPiCommand): Promise<import('@gadgets/workshop-shared/api').CodingSessionPiResult> {
    const initial = await this.#codingSessionsOwner();
    const session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    const {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.callPi(owner, sessionId, connectionId, command);
  }

  /** Mints an application capability after verifying ownership and current repository authority. */
  async mintCodingSessionApplicationCapability(
    sessionId: string,
    applicationId: string,
  ): Promise<CodingSessionApplicationCapability> {
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.mintApplicationCapability(owner, sessionId, applicationId);
  }

  /** Uploads one file into an owned running coding session after rechecking repository access. */
  async uploadCodingSessionFile(
    request: CodingSessionFileUploadRequest,
  ): Promise<CodingSessionFileUploadResult> {
    const upload = validateCodingSessionFileUploadRequest(request);
    let initial = await this.#codingSessionsOwner();
    let session = await initial.service.getSession(initial.owner, upload.sessionId);
    if (!session) throw new Error("Coding session was not found.");
    let {owner, service} = await this.#codingSessionsAccess(session.repositories);
    return service.uploadFile(owner, upload);
  }

  /** Lists coding-session observations and actions newest first. */
  listCodingSessionActivity(sessionId?: string): CodingSessionActivity[] {
    const records = sessionId
      ? [...this.storage.codingSessionActions.bySession.get(sessionId)]
      : [...this.storage.codingSessionActions.list()];
    return records.map(({
      bindingId: _bindingId,
      bindingGeneration: _bindingGeneration,
      gatekeeperActionId: _actionId,
      ...record
    }) => record)
      .toSorted((left, right) => right.createdAt.valueOf() - left.createdAt.valueOf());
  }

  /** Submits first-party product feedback after enforcing verified @totango.com SSO eligibility. */
  async submitProductFeedback(request: SubmitProductFeedbackRequest): Promise<ProductFeedbackSubmissionResult> {
    await this.#assertProductFeedbackEligible();
    const { owner, service } = await this.#codingSessionsOwner();
    const evidence = await this.#buildProductFeedbackEvidence(owner, request);
    return service.submitProductFeedback(owner, evidence);
  }

  /** Lists first-party product feedback automation statuses owned by this user. */
  async listProductFeedbackStatuses(): Promise<ProductFeedbackStatus[]> {
    await this.#assertProductFeedbackEligible();
    const { owner, service } = await this.#codingSessionsOwner();
    return service.listProductFeedbackStatuses(owner);
  }

  /** Reads one first-party product feedback automation status owned by this user. */
  async getProductFeedbackStatus(id: string): Promise<ProductFeedbackStatus | undefined> {
    await this.#assertProductFeedbackEligible();
    const { owner, service } = await this.#codingSessionsOwner();
    return service.getProductFeedbackStatus(owner, id);
  }

  /** Return whether the current account satisfies the internal SSO-only feedback policy. */
  async productFeedbackAvailable(): Promise<boolean> {
    const profile = await this.whoami();
    return isTeamPiCodexEligibleUser(profile.id, this.storage.passwordHashHash.get() !== null);
  }

  async #assertProductFeedbackEligible(): Promise<void> {
    if (!await this.productFeedbackAvailable()) {
      throw new Error("Product feedback automation is available only to verified @totango.com SSO users.");
    }
  }

  async #buildProductFeedbackEvidence(
    owner: CodingSessionOwner,
    rawRequest: SubmitProductFeedbackRequest,
  ): Promise<ProductFeedbackEvidenceBundle> {
    const request = validateSubmitProductFeedbackRequest(rawRequest);
    const title = sanitizeFeedbackText(request.title, 180).trim();
    const description = sanitizeFeedbackText(request.description, PRODUCT_FEEDBACK_MAX_TEXT_LENGTH).trim();
    if (!title) throw new Error("Feedback title is required.");
    if (!description) throw new Error("Feedback details are required.");
    if (request.kind !== "bug" && request.kind !== "feedback") throw new Error("Feedback type is invalid.");
    const pathname = normalizedPathname(request.context.pathname);
    const evidence: ProductFeedbackEvidenceBundle = {
      id: crypto.randomUUID(),
      kind: request.kind,
      title,
      description,
      submitterEmail: owner.email,
      owner,
      pathname,
      expiresAt: new Date(Date.now() + PRODUCT_FEEDBACK_TTL_MS),
    };
    if (request.consent.frontendDiagnostics) {
      evidence.diagnostics = (request.diagnostics ?? []).slice(-PRODUCT_FEEDBACK_MAX_DIAGNOSTICS).map(item => ({
        timestamp: item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp),
        level: ["log", "info", "warn", "error"].includes(item.level) ? item.level : "log",
        message: sanitizeFeedbackText(item.message, PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH),
      })).filter(item => item.message);
    }
    if (request.consent.workspaceContext && request.context.workspaceId) {
      const record = this.storage.gadgets.get(request.context.workspaceId);
      if (record) {
        const ns = this.ctx.exports.OverseerDurableObject;
        evidence.workspace = await ns.get(ns.idFromString(request.context.workspaceId))
          .collectProductFeedbackEvidence(this.ctx.id.toString(), request.context.chatId);
      }
    }
    if (request.consent.codingSessionContext) {
      const sessions = await this.listCodingSessions();
      const selected = request.context.codingSessionId
        ? sessions.filter(session => session.id === request.context.codingSessionId)
        : sessions.slice(0, 5);
      const activity = this.listCodingSessionActivity(request.context.codingSessionId)
        .slice(0, 20)
        .map(record => sanitizeFeedbackText(`${record.type}:${record.vendorId}:${record.resourceTitle}:${record.state}`, 240));
      evidence.codingSessions = { sessions: selected, activity };
    }
    return evidence;
  }

  /** Approves and applies one coding-session action exactly once. */
  async approveCodingSessionAction(activityId: string): Promise<void> {
    const record = this.#pendingCodingSessionAction(activityId);
    this.storage.codingSessionActions.put({ ...record, state: "applying" });
    const binding = await this.#codingSessionBinding(record.bindingId);
    if (binding.generation !== record.bindingGeneration) {
      this.storage.codingSessionActions.put({
        ...record, state: "failed", error: "The connected account changed before approval.",
      });
      throw new Error("The connected account changed before this action was approved.");
    }
    try {
      await binding.facet.applyAction(record.gatekeeperActionId);
      this.storage.codingSessionActions.put({ ...record, state: "approved" });
    } catch (error) {
      this.storage.codingSessionActions.put({
        ...record,
        state: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : "Tool action failed.",
      });
      throw error;
    }
  }

  /** Rejects one coding-session action exactly once. */
  async rejectCodingSessionAction(activityId: string): Promise<void> {
    const record = this.#pendingCodingSessionAction(activityId);
    const binding = await this.#codingSessionBinding(record.bindingId);
    if (binding.generation !== record.bindingGeneration) {
      throw new Error("The connected account changed before this action was rejected.");
    }
    await binding.facet.rejectAction(record.gatekeeperActionId);
    this.storage.codingSessionActions.put({ ...record, state: "rejected" });
  }

  recordCodingSessionObservation(
    sessionId: string,
    binding: CodingSessionMcpBinding,
    description: ObservationDescription,
  ): void {
    this.storage.codingSessionActions.put({
      id: crypto.randomUUID(), sessionId, bindingId: binding.id,
      bindingGeneration: binding.generation, gatekeeperActionId: -1,
      vendorId: binding.vendorId, resourceTitle: binding.resourceTitle,
      type: "observation", state: "approved", description, createdAt: new Date(),
    });
  }

  recordCodingSessionAction(
    sessionId: string,
    binding: CodingSessionMcpBinding,
    gatekeeperActionId: number,
    description: ActionDescription,
  ): void {
    this.storage.codingSessionActions.put({
      id: `${sessionId}:${binding.id}:${binding.generation}:${gatekeeperActionId}`,
      sessionId, bindingId: binding.id, bindingGeneration: binding.generation, gatekeeperActionId,
      vendorId: binding.vendorId, resourceTitle: binding.resourceTitle,
      type: "action", state: "pending", description, createdAt: new Date(),
    });
  }

  async listCodingSessionTools(sessionId: string, sandboxId: string): Promise<CodingSessionTool[]> {
    const repositories = await this.#assertCodingSessionAccess(sessionId, sandboxId);
    const catalogs = await Promise.all((await this.#codingSessionBindings(repositories)).map(async binding => {
      let session: McpSessionBase | undefined;
      try {
        session = await binding.facet.startSession(
          new CodingSessionApprovalQueue(this, sessionId, binding)) as unknown as McpSessionBase;
        return { binding, tools: await session.listTools() as McpToolInfo[] };
      } catch {
        return { binding, tools: [] as McpToolInfo[] };
      } finally {
        session?.[Symbol.dispose]();
      }
    }));
    const tools = catalogs.flatMap(({ binding, tools: upstreamTools }) => upstreamTools.map(tool => ({
      name: this.#codingSessionToolName(binding.id, tool.name),
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      securitySchemes: tool.securitySchemes,
      _meta: namespaceCodingSessionToolMetadata(
        binding.id, binding.generation, tool._meta),
    })));
    assertCodingSessionMcpResponseSize({ tools });
    return tools;
  }

  async listCodingSessionResources(
    sessionId: string,
    sandboxId: string,
  ): Promise<CodingSessionResource[]> {
    const repositories = await this.#assertCodingSessionAccess(sessionId, sandboxId);
    const catalogs = await Promise.all((await this.#codingSessionBindings(repositories)).map(async binding => {
      let session: McpSessionBase | undefined;
      try {
        session = await binding.facet.startSession(
          new CodingSessionApprovalQueue(this, sessionId, binding)) as unknown as McpSessionBase;
        return { binding, resources: await session.listResources() };
      } catch {
        return { binding, resources: [] as CodingSessionResource[] };
      } finally {
        session?.[Symbol.dispose]();
      }
    }));
    const resources = catalogs.flatMap(({ binding, resources: upstreamResources }) =>
      upstreamResources.map(resource => ({
        ...resource,
        uri: namespaceCodingSessionResourceUri(binding.id, binding.generation, resource.uri),
      })));
    assertCodingSessionMcpResponseSize({ resources });
    return resources;
  }

  async readCodingSessionResource(
    sessionId: string,
    uri: string,
    sandboxId: string,
  ): Promise<CodingSessionReadResourceResult> {
    const repositories = await this.#assertCodingSessionAccess(sessionId, sandboxId);
    const { bindingId, bindingGeneration, upstreamUri } = parseCodingSessionResourceUri(uri);
    const binding = selectCodingSessionResourceBinding(
      bindingId, bindingGeneration, await this.#codingSessionBindings(repositories));
    const session = await binding.facet.startSession(
      new CodingSessionApprovalQueue(this, sessionId, binding)) as unknown as McpSessionBase;
    try {
      const result = await session.readResource(upstreamUri);
      const namespaced = {
        contents: result.contents.map(content => ({
          ...content,
          uri: namespaceCodingSessionResourceUri(binding.id, binding.generation, content.uri),
        })),
      };
      assertCodingSessionMcpResponseSize(namespaced);
      return namespaced;
    } finally {
      session[Symbol.dispose]();
    }
  }

  async callCodingSessionTool(
    sessionId: string,
    qualifiedName: string,
    args: Record<string, unknown> | undefined,
    sandboxId: string,
  ): Promise<CodingSessionToolResult> {
    const repositories = await this.#assertCodingSessionAccess(sessionId, sandboxId);
    const { binding, toolName } = await this.#resolveCodingSessionTool(qualifiedName, repositories);
    const session = await binding.facet.startSession(
      new CodingSessionApprovalQueue(this, sessionId, binding)) as unknown as McpSessionBase;
    try {
      const result = this.#codingSessionToolResult(await session.callTool(toolName, args));
      assertCodingSessionMcpResponseSize(result);
      return result;
    } finally {
      session[Symbol.dispose]();
    }
  }

  async getCodingSessionActionResult(
    sessionId: string,
    qualifiedName: string,
    actionId: number,
    sandboxId: string,
  ): Promise<CodingSessionToolResult> {
    const repositories = await this.#assertCodingSessionAccess(sessionId, sandboxId);
    const { binding } = await this.#resolveCodingSessionTool(qualifiedName, repositories);
    const record = [...this.storage.codingSessionActions.bySession.get(sessionId)].find(candidate =>
      candidate.bindingId === binding.id &&
      candidate.bindingGeneration === binding.generation &&
      candidate.gatekeeperActionId === actionId);
    if (!record || record.state !== "approved") {
      throw new Error("This Workshop action is not approved for this coding session.");
    }
    const session = await binding.facet.startSession(
      new CodingSessionApprovalQueue(this, sessionId, binding)) as unknown as McpSessionBase;
    try {
      const codingSessionSession = session as McpSessionBase & {
        getCodingSessionActionResult?: (actionId: number) => Promise<McpCallResult>;
      };
      const result = await (codingSessionSession.getCodingSessionActionResult?.(actionId) ??
        session.getActionResult(actionId));
      const codingSessionResult = this.#codingSessionToolResult(result);
      assertCodingSessionMcpResponseSize(codingSessionResult);
      return codingSessionResult;
    } finally {
      session[Symbol.dispose]();
    }
  }

  async #assertCodingSessionAccess(sessionId: string, sandboxId: string): Promise<string[]> {
    const { owner, service } = await this.#codingSessionsOwner();
    const session = await assertCurrentCodingSessionGeneration(service, owner, sessionId, sandboxId);
    await this.#codingSessionsAccess(session.repositories);
    return session.repositories;
  }

  async #codingSessionBindings(repositories?: string[]): Promise<CodingSessionMcpBinding[]> {
    await this.#ensureAutoProvisionedAccounts();
    const config = await readAdminConfig(this.env);
    const bindings: CodingSessionMcpBinding[] = [];
    for (const record of this.#connectedAccountRecords()) {
      if (isRetiredGatekeeperVendor(record.vendorId)) continue;
      if (!areCredentialsValid(record) || config.disabledGatekeepers.includes(record.vendorId)) continue;
      if (record.autoProvisioned && ambientGatekeeperMode(config, record.vendorId) === "disabled") continue;
      const generation = record.codingSessionGeneration ?? crypto.randomUUID();
      if (!record.codingSessionGeneration) {
        record.codingSessionGeneration = generation;
        this.storage.connectedAccounts.put(record);
      }
      if (record.vendorId === "mcp_portal" &&
          record.description.codingSessionResourceUrls === undefined) {
        try {
          record.description = await record.account.describe();
          this.storage.connectedAccounts.put(record);
        } catch (error) {
          logger.warn("skipping coding session tools: failed to describe portal account", {
            event: "coding.session.portal.describe.skipped",
            accountId: record.id,
            vendorId: record.vendorId,
            error,
          });
          continue;
        }
      }
      const nativeGitHubResourceUrls = record.vendorId === "github"
        ? codingSessionGitHubResourceUrls(repositories)
        : [];
      const discoveredResourceUrls = [...new Set([
        ...(record.description.codingSessionResourceUrls ?? []),
        ...nativeGitHubResourceUrls,
      ])]
        .slice(0, MAX_CODING_SESSION_DISCOVERED_BINDINGS_PER_ACCOUNT);
      const entries: { id: string; title: string; class: DurableObjectClass<Gatekeeper<any>> }[] = [];
      try {
        if (record.description.singleton) {
          const cls = await this.getSingletonGatekeeperClass(record.id);
          if (!cls) continue;
          entries.push({
            id: codingSessionBindingId(record.vendorId, record.id),
            title: record.description.displayName ?? record.vendorId,
            class: cls,
          });
        } else if (record.vendorId === "mcp" && record.description.uniqueName) {
          entries.push({
            id: codingSessionBindingId(record.vendorId, record.id),
            title: record.description.displayName ?? record.vendorId,
            class: (await this.getGatekeeperClassFor(record.id, record.description.uniqueName)).class,
          });
        }
      } catch (error) {
        logger.warn("skipping coding session tools: failed to load connected account", {
          event: "coding.session.binding.load.skipped",
          accountId: record.id,
          vendorId: record.vendorId,
          error,
        });
        continue;
      }
      for (const resourceUrl of discoveredResourceUrls) {
        try {
          const loaded = await this.getGatekeeperClassFor(record.id, resourceUrl);
          entries.push({
            id: codingSessionBindingId(record.vendorId, record.id, resourceUrl),
            title: resourceUrl,
            class: loaded.class,
          });
        } catch (error) {
          logger.warn("skipping discovered coding session tool binding", {
            event: "coding.session.discovered.binding.load.skipped",
            accountId: record.id,
            vendorId: record.vendorId,
            error,
          });
        }
      }
      for (const entry of entries) {
        const facet = this.ctx.facets.get<Gatekeeper<McpSessionBase>>(
          `coding-session-${entry.id}-${generation}`, () => ({ class: entry.class }));
        bindings.push({
          id: entry.id, generation,
          vendorId: record.vendorId,
          resourceTitle: entry.title,
          facet,
        });
      }
    }
    return bindings;
  }

  async #codingSessionBinding(id: string, repositories?: string[]): Promise<CodingSessionMcpBinding> {
    const binding = (await this.#codingSessionBindings(repositories)).find(candidate => candidate.id === id);
    if (!binding) throw new Error("This connected tool is no longer available.");
    return binding;
  }

  async #resolveCodingSessionTool(qualifiedName: string, repositories?: string[]) {
    const separator = qualifiedName.indexOf("__");
    if (separator < 1) throw new Error("Invalid Workshop MCP tool name.");
    const binding = await this.#codingSessionBinding(qualifiedName.slice(0, separator), repositories);
    return { binding, toolName: qualifiedName.slice(separator + 2) };
  }

  #codingSessionToolName(bindingId: string, toolName: string): string {
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(toolName)) {
      throw new Error("A connected MCP server published an invalid tool name.");
    }
    return `${bindingId}__${toolName}`;
  }

  #codingSessionToolResult(result: McpCallResult): CodingSessionToolResult {
    if (result.status === "ok") {
      return {
        content: result.content,
        isError: result.isError,
        structuredContent: result.structuredContent,
      };
    }
    if (result.status === "pending") {
      return {
        content: [{ type: "text", text: result.message }],
        pendingActionId: result.actionId,
      };
    }
    return { content: [{ type: "text", text: result.message }], isError: true };
  }

  #pendingCodingSessionAction(id: string): CodingSessionActionRecord {
    const record = this.storage.codingSessionActions.get(id);
    if (!record || record.type !== "action") throw new Error("No such coding-session action.");
    if (record.state !== "pending") throw new Error("This coding-session action is already resolved.");
    return record;
  }

  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
      if (isRetiredGatekeeperVendor(vendorId)) return null;
      try {
        let description = await vendor.describe();
        return description.autoProvisionsAccount ? {vendorId, vendor, description} : null;
      } catch (err) {
        logger.warn("failed to describe vendor", {
          event: "vendor.describe.failed", vendorId, error: err,
        });
        return null;
      }
    }));
    return described.filter(v => v !== null);
  }

  /**
   * The ambient gatekeepers the user can opt into now: mode "optional" and not yet added. Backs the
   * Connectors "Available" section. ("enabled" ones are already provisioned; "disabled" ones aren't
   * offered.)
   */
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    let config = await readAdminConfig(this.env);
    return (await this.#ambientVendors())
        .filter(({vendorId}) =>
            ambientGatekeeperMode(config, vendorId) === "optional" && !this.#hasAccountForVendor(vendorId))
        // Same shape as listGatekeeperVendors; ambient gatekeepers expose no resources.
        .map(({vendorId, description}) => ({id: vendorId, description, supportedResources: []}));
  }

  // Per-vendor dedup of concurrent provisionAmbientAccount() calls — same DO-input-gate race as
  // #ensureAccountsPromise (see its comment below), e.g. a double-click on "Add". Cleared on completion.
  #provisionPromises = new Map<string, Promise<void>>();

  /**
   * Opt into an ambient gatekeeper on demand: mint its connected account for this user (no OAuth).
   * Only when the vendor's mode isn't "disabled" and the user has no account yet. Idempotent.
   */
  provisionAmbientAccount(vendorId: string): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let inFlight = this.#provisionPromises.get(vendorId);
    if (inFlight) return inFlight;
    let promise = this.#provisionAmbientAccount(vendorId)
        .finally(() => { this.#provisionPromises.delete(vendorId); });
    this.#provisionPromises.set(vendorId, promise);
    return promise;
  }

  async #provisionAmbientAccount(vendorId: string): Promise<void> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error("No such service: " + vendorId);

    if (ambientGatekeeperMode(await readAdminConfig(this.env), vendorId) === "disabled") {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let description = await vendor.describe();
    if (!description.autoProvisionsAccount) {
      throw new Error(`The "${vendorId}" gatekeeper can't be added this way.`);
    }

    if (this.#hasAccountForVendor(vendorId)) return;  // already added

    await this.#createAutoProvisionedAccount(vendorId, vendor);
  }

  // Mint a vendor's connected account with no OAuth flow and persist it as auto-provisioned. The
  // caller must have already confirmed the vendor sets autoProvisionsAccount (so createAccount is
  // present) and that the user has no account for it yet.
  async #createAutoProvisionedAccount(vendorId: string, vendor: Service<GatekeeperVendor>): Promise<void> {
    let account = await (vendor as unknown as AccountCreatorStub).createAccount();
    // Resolve the description before allocating the id, so a describe() failure doesn't burn a slot.
    let description = await account.describe();
    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);
    this.storage.connectedAccounts.put({
      id: accountId,
      account,
      description,
      vendorId,
      autoProvisioned: true,
    });
  }

  // Dedup concurrent #ensureAutoProvisionedAccounts() calls. The provisioning loop awaits cross-worker
  // RPCs (describe/createAccount), which releases the DO input gate; without this, two overlapping
  // calls (e.g. the nav listing apps while a gadget opens) could both see "not provisioned" and
  // create duplicate accounts. Cleared on completion so a later call re-checks (e.g. for a gatekeeper
  // bound after this DO started).
  #ensureAccountsPromise?: Promise<void>;

  // Ensure an auto-provisioned connected account exists for every bound vendor that requests it
  // (VendorDescription.autoProvisionsAccount) and is permitted by the provisioning policy. Idempotent
  // and best-effort: a single failing vendor never blocks the others. Creates at most one account per
  // vendor. Deduped via #ensureAccountsPromise (above); callers reach it through listProvidedAccounts.
  #ensureAutoProvisionedAccounts(): Promise<void> {
    return (this.#ensureAccountsPromise ??=
      this.#provisionMissingAccounts().finally(() => { this.#ensureAccountsPromise = undefined; }));
  }

  async #provisionMissingAccounts(): Promise<void> {
    // Which vendors already have an auto-provisioned account?
    let provisioned = new Set<string>();
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.autoProvisioned) provisioned.add(rec.vendorId);
    }

    let config = await readAdminConfig(this.env);
    for (let {vendorId, vendor} of await this.#ambientVendors()) {
      if (provisioned.has(vendorId)) continue;
      // Only "enabled" (forced) vendors are auto-provisioned for everyone. "optional" vendors are
      // added on demand by the user (provisionAmbientAccount); "disabled" ones never.
      if (!shouldAutoProvisionAccount(config, vendorId)) continue;

      try {
        await this.#createAutoProvisionedAccount(vendorId, vendor);
      } catch (err) {
        logger.error("failed to auto-provision account", {
          event: "account.auto.provision.failed", vendorId, error: err,
        });
      }
    }
  }

  /**
   * Ensure the user's auto-provisioned accounts exist (idempotent; see #ensureAutoProvisionedAccounts),
   * then list those that declare an agent singleton and/or a management UI. Folding the ensure in lets
   * callers (gadget open, app nav) provision and read the accounts back in a single round trip to this
   * DO. Callers filter on `description.singleton` (ambient capsules / catalog) or
   * `description.providesUi` (management-UI listing).
   */
  async listProvidedAccounts(): Promise<ProvidedAccountInfo[]> {
    await this.#ensureAutoProvisionedAccounts();
    let config = await readAdminConfig(this.env);
    let result: ProvidedAccountInfo[] = [];
    for (let rec of this.#connectedAccountRecords()) {
      if (isRetiredGatekeeperVendor(rec.vendorId)) continue;
      if (config.disabledGatekeepers.includes(rec.vendorId)) continue;
      if (!areCredentialsValid(rec)) continue;
      // Auto-provisioned provider declarations may evolve after an account was persisted (for
      // example a singleton adding revisioned authority). Refresh them at this cold boundary without
      // adding remote calls for ordinary connected accounts.
      if (rec.autoProvisioned) {
        rec.description = await rec.account.describe();
        this.storage.connectedAccounts.put(rec);
      }
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      // A "disabled" ambient gatekeeper's account stays dormant: don't surface its singleton capsule
      // or management UI. (Its data is preserved, so re-enabling restores it.)
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      let authorityKey: string | undefined;
      if (rec.description.singleton?.revisionedAuthority) {
        authorityKey = (await (rec.account as unknown as SingletonAccountStub)
          .getSingletonGatekeeperAuthority()).key;
      }
      result.push({ accountId: rec.id, vendorId: rec.vendorId,
        description: rec.description, authorityKey });
    }
    return result;
  }

  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   */
  async getSingletonGatekeeperClass(accountId: number, authorityKey?: string)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    if (isRetiredGatekeeperVendor(record.vendorId)) return null;
    if (!areCredentialsValid(record)) return null;
    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(record.vendorId) ||
        record.autoProvisioned && ambientGatekeeperMode(config, record.vendorId) === "disabled") return null;
    let account = record.account as unknown as SingletonAccountStub;
    if (record.description.singleton.revisionedAuthority) {
      let authority = await account.getSingletonGatekeeperAuthority();
      if (authorityKey !== undefined && authority.key !== authorityKey) return null;
      return authority.class;
    }
    return account.getSingletonGatekeeperClass();
  }

  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is supplied
   * fresh by the caller so admin-gated features reflect the user's current status.
   */
  async startAccountAppUi(accountId: number, context: AppUiContext): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    if (isRetiredGatekeeperVendor(record.vendorId)) throw new Error("No such app.");
    return (record.account as unknown as SingletonAccountStub).startAppUi(context);
  }

  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[], nativeFlow?: NativeAccountBrowserFlowOptions): Promise<{url?: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    if (isRetiredGatekeeperVendor(record.vendorId)) throw retiredGatekeeperError(record.vendorId);
    if (!areCredentialsValid(record)) throw new Error("This connection needs to be reconnected before it can be used.");
    let config = await readAdminConfig(this.env);
    let vendorId = record.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId) ||
        resourceUrlPatterns.some(pattern => isResourceDisabled(config, vendorId, pattern))) {
      throw new Error("This connection is disabled on this deployment by an administrator.");
    }
    let result = await record.account.ensureResources(resourceUrlPatterns, { returnUrl: nativeFlow?.returnUrl });
    if (nativeFlow && result.url) {
      this.storage.connectedAccounts.put({
        ...record,
        pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "grant" },
      });
    }
    return result;
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    if (filter?.includeForcedAutoProvisionedAccounts) await this.#ensureAutoProvisionedAccounts();

    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    // Snapshot the admin config once for this subscription. Changes take effect when the client
    // re-subscribes (e.g. on reconnect), matching other deployment config.
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    async function notifyAdd(record: ConnectedAccountRecord) {
      if (isRetiredGatekeeperVendor(record.vendorId)) return;
      // Ambient (auto-provisioned) accounts only appear in the Connectors list when their vendor is
      // "optional" — i.e. the user opted in and can manage/remove it. "enabled" (forced) accounts have
      // nothing to manage, and "disabled" ones are dormant, so both are hidden.
      // Forced accounts are included when observer verification explicitly requests them.
      if (record.autoProvisioned) {
        let mode = ambientGatekeeperMode(config, record.vendorId);
        if (mode === "disabled" ||
            (mode === "enabled" && !filter?.includeForcedAutoProvisionedAccounts)) {
          return;
        }
      }
      if (disabledGatekeeperSet.has(record.vendorId)) {
        return;  // Whole gatekeeper disabled by admin.
      }
      if (filter && !(await checkGatekeeperVendorFilter(
          record.account, record.vendorId, filter))) {
        return;
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        logger.error("no such service for connected account", {
          event: "connected.account.service.missing",
          accountId: record.id, vendorId: record.vendorId,
        });
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        logger.warn("failed to describe connected account", {
          event: "connected.account.describe.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
        return;
      }

      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = await record.account.getSupportedResources();
        supportedResources =
            filterEnabledResources(config, record.vendorId, supportedResources);
      } catch (err) {
        logger.warn("failed to get supported resources for connected account", {
          event: "connected.account.supported.resources.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // #connectedAccountRecords() skips any record that fails to load, so a single stale account
    // (e.g. one whose gatekeeper Worker is no longer bound) doesn't prevent surfacing the others.
    let promises = [...this.#connectedAccountRecords()].map(record => notifyAdd(record));

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }

  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      if (account.autoProvisioned) {
        // Only an opt-in ambient account belongs to the user to remove. Enabled accounts are forced,
        // while disabled accounts stay dormant so disabling a vendor never destroys its data.
        if (isRetiredGatekeeperVendor(account.vendorId)) {
          throw new Error("This account is managed automatically and can't be disconnected.");
        }
        let mode = ambientGatekeeperMode(await readAdminConfig(this.env), account.vendorId);
        if (mode !== "optional") {
          throw new Error("This account is managed automatically and can't be disconnected.");
        }
        // An opt-in ("optional") ambient account: the user added it, so let them remove it. revoke()
        // gives the gatekeeper a chance to delete its own per-user storage (e.g. the account's
        // private collections DO) — it's its cleanup hook, not just OAuth revocation. Best-effort:
        // a gatekeeper that throws (or has nothing to revoke) must not block the user's disconnect.
        try {
          await account.account.revoke();
        } catch (err) {
          logger.error("revoke() failed during disconnect", {
            event: "account.revoke.failed",
            vendorId: account.vendorId, accountId, error: err,
          });
        }
        this.storage.connectedAccounts.delete(accountId);
        logger.info("account disconnected", {
          event: "account.disconnected",
          vendorId: account.vendorId, accountId, autoProvisioned: true,
        });
        return;
      }
      try {
        await account.account.revoke();
      } catch (err) {
        // Disconnect is a local authority decision. A provider outage or stale remote token must
        // not leave that authority attached to the user's Workshop account.
        logger.error("revoke() failed during disconnect", {
          event: "account.revoke.failed",
          vendorId: account.vendorId, accountId, error: err,
        });
      }
      this.storage.connectedAccounts.delete(accountId);
      // Disconnecting the Cloudflare account also clears the AI Gateway billing state (selected
      // account + cached balance), which is meaningless without the underlying grant.
      if (account.vendorId === CLOUDFLARE_VENDOR_ID) {
        this.storage.cloudflareBilling.put(null);
      }
      logger.info("account disconnected", {
        event: "account.disconnected",
        vendorId: account.vendorId, accountId, autoProvisioned: false,
      });
    }
  }

  async reconnectAccount(accountId: number, nativeFlow?: NativeAccountBrowserFlowOptions): Promise<{url: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    if (isRetiredGatekeeperVendor(record.vendorId)) throw retiredGatekeeperError(record.vendorId);
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(
        record.vendorId.toLowerCase())) {
      throw new Error("This connection is disabled on this deployment by an administrator.");
    }
    let result = await record.account.reconnect({ returnUrl: nativeFlow?.returnUrl });
    if (nativeFlow) {
      this.storage.connectedAccounts.put({
        ...record,
        pendingNativeFlow: { flowHandle: nativeFlow.flowHandle, kind: "reconnect" },
      });
    }
    return result;
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    if (isRetiredGatekeeperVendor(record.vendorId)) throw retiredGatekeeperError(record.vendorId);
    let config = await readAdminConfig(this.env);
    let vendorId = record.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId) ||
        isResourceDisabled(config, vendorId, resourceUrlPattern)) {
      throw new Error("This connection is disabled on this deployment by an administrator.");
    }
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  /**
   * Persist a connected gatekeeper account that was established during sign-in (rather than via the
   * usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
   * links the account for AI Gateway billing: the login callback resolves this user by verified
   * email, then calls here to store the resulting grant. That grant covers billing only: sign-in
   * requests no gadget-facing resources, so any later resource access is authorized separately.
   */
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<void> {
    if (isRetiredGatekeeperVendor(vendorId)) {
      try {
        await account.revoke();
      } catch (err) {
        logger.error("failed to revoke retired login grant", {
          event: "account.retired.login.grant.revoke.failed", vendorId, error: err,
        });
      }
      throw retiredGatekeeperError(vendorId);
    }
    let description = await account.describe();
    let uniqueName = description.uniqueName;

    // A repeated sign-in is a re-authorization, so the *fresh* grant is the one we want. If this
    // identity is already connected for this vendor, refresh that record in place rather than letting
    // putConnectedAccount's dedup discard the new grant: keeping the stale record would leave billing
    // broken whenever the old token had expired or was rotated out by this very re-auth — the
    // opposite of what signing in again should accomplish.
    if (uniqueName) {
      let existing = this.#findConnectedAccountByIdentity(vendorId, uniqueName);
      if (existing) {
        // Drop the now-stale grant (a separate gatekeeper-side object from the fresh one), then point
        // the existing record — keeping its id, so UI references stay stable — at the fresh grant.
        try {
          await existing.account.revoke();
        } catch (err) {
          logger.error("failed to revoke stale grant; replacing anyway", {
            event: "account.stale.grant.revoke.failed",
            accountId: existing.id, vendorId, error: err,
          });
        }
        existing.account = account;
        existing.description = description;
        existing.credentialExpiresAt = expiresAt;
        existing.credentialsExpired = false;
        existing.codingSessionGeneration = crypto.randomUUID();
        this.storage.connectedAccounts.put(existing);
        return;
      }
    }

    let id = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(id + 1);
    this.storage.connectedAccounts.put({
      id,
      account,
      description,
      vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load, for the same reasons as subscribeConnectedAccounts():
  // a single corrupt record (e.g. one referencing a Worker binding that no longer exists) must not
  // poison the scan and prevent the user from connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      if (id === excludeId) continue;
      let existing: ConnectedAccountRecord | undefined;
      try {
        existing = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account during identity lookup: failed to load", {
          event: "connected.account.identity.lookup.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (!existing) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    if (isRetiredGatekeeperVendor(record.vendorId)) {
      try {
        await record.account.revoke();
      } catch (err) {
        logger.error("failed to revoke retired connected account", {
          event: "account.retired.connected.revoke.failed",
          vendorId: record.vendorId, accountId: record.id, error: err,
        });
      }
      throw retiredGatekeeperError(record.vendorId);
    }

    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put({ ...record, codingSessionGeneration: crypto.randomUUID() });
  }

  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      this.storage.connectedAccounts.put(record);
    }
  }

  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let nativeFlow = record.pendingNativeFlow;

    try {
      // Re-fetch description since the user may have re-authed with different info.
      record.description = await record.account.describe();
      record.credentialsExpired = false;
      record.credentialExpiresAt = expiresAt;
      record.codingSessionGeneration = crypto.randomUUID();
      delete record.pendingNativeFlow;
      this.storage.connectedAccounts.put(record);
      if (nativeFlow) await completeNativeAccountBrowserFlow(this.ctx, nativeFlow.flowHandle);
    } catch (err) {
      if (nativeFlow) {
        await failNativeAccountBrowserFlow(this.ctx, nativeFlow.flowHandle, "Account reconnection failed. Please try again.");
      }
      throw err;
    }
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string, providedBySingleton?: true,
                  singletonAuthorityKey?: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    if (isRetiredGatekeeperVendor(account.vendorId)) throw retiredGatekeeperError(account.vendorId);
    if (!areCredentialsValid(account)) throw new Error("This connection needs to be reconnected before it can be used.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);

    // Block whole gatekeepers + disabled resources at this single core-side chokepoint where a
    // resourceUrl becomes a capability (reached only via the user/UI-facing Overseer.newGatekeeper
    // and blueprint instantiation — never from gadget or agent code).
    let config = await readAdminConfig(this.env);
    let vendorId = account.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId)) {
      throw new Error(
          `The "${account.vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }

    // Blocking here prevents minting a new capability to a disabled resource even if the request
    // bypasses the (separately filtered) picker/agent listings.
    if (isResourceDisabled(config, vendorId, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }

    let singletonAuthorityKey: string | undefined;
    if (resource.providedBySingleton && account.description.singleton?.revisionedAuthority) {
      singletonAuthorityKey = (await (account.account as unknown as SingletonAccountStub)
        .getSingletonGatekeeperAuthority()).key;
    }
    return {
      class: cls,
      vendorId: account.vendorId,
      typeUrlPattern: resource.urlPattern,
      providedBySingleton: resource.providedBySingleton,
      singletonAuthorityKey,
    };
  }

  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it. Returns null if the
   * account no longer exists (or never existed). Throws if the account belongs to a different
   * vendor (not a legitimate UI state — only reachable by bypassing client-side filtering).
   *
   * Account *selection* (which of the user's accounts to use for a given binding) is done by the
   * frontend; this method validates and resolves a chosen account to its verifier.
   */
  async getVerifier(accountId: number, expectedVendorId: string)
      : Promise<Fetcher<GatekeeperUserVerifier> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) return null;
    if (isRetiredGatekeeperVendor(account.vendorId)) return null;
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }

  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account && isRetiredGatekeeperVendor(account.vendorId)) return null;
    return account ? account.description : null;
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
  flowHandle?: string;
}

function nativeAccountBrowserFlow(ctx: { exports: any }, flowHandle: string) {
  const flows = ctx.exports.NativeBrowserFlow as unknown as DurableObjectNamespace;
  return flows.get(flows.idFromName(flowHandle)) as unknown as {
    completeAccount(): Promise<void>;
    fail(message: string): Promise<void>;
  };
}

async function completeNativeAccountBrowserFlow(ctx: { exports: any }, flowHandle: string): Promise<void> {
  await nativeAccountBrowserFlow(ctx, flowHandle).completeAccount();
}

async function failNativeAccountBrowserFlow(ctx: { exports: any }, flowHandle: string, message: string): Promise<void> {
  await nativeAccountBrowserFlow(ctx, flowHandle).fail(message);
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  private getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    try {
      let userStub = this.getUserStub();

      await userStub.putConnectedAccount({
        id: this.ctx.props.accountId,
        account,
        description: await account.describe(),
        vendorId: this.ctx.props.vendorId,
        credentialExpiresAt: expiresAt,
      });
      if (this.ctx.props.flowHandle) {
        await completeNativeAccountBrowserFlow(this.ctx, this.ctx.props.flowHandle);
      }
    } catch (err) {
      if (this.ctx.props.flowHandle) {
        await failNativeAccountBrowserFlow(this.ctx, this.ctx.props.flowHandle, "Account connection failed. Please try again.");
      }
      throw err;
    }
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    try {
      let userStub = this.getUserStub();
      await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
    } catch (err) {
      if (this.ctx.props.flowHandle) {
        await failNativeAccountBrowserFlow(this.ctx, this.ctx.props.flowHandle, "Account reconnection failed. Please try again.");
      }
      throw err;
    }
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
