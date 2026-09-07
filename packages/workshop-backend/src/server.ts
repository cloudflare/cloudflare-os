import { RpcStub, RpcTarget, newHttpBatchRpcResponse, newWebSocketRpcSession, RpcSessionOptions } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { JWTPayload } from "jose";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, AiGatewayInfo, AiModelProvider, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, ObserverConfigCallback, BlueprintLibrarySummary, BlueprintPublicInfo, BlueprintUserSummary, BlueprintBindingAssignment, AgentSpawnerConfig, WorkpieceId, BLUEPRINT_SCREENSHOT_PATH_PREFIX, BLUEPRINT_SCREENSHOT_R2_PREFIX, blueprintScreenshotUrl, ServerConfig, CloudflareUsageInfo, CloudflareAccountOption, LoginAttempt, GatekeeperAppInfo, AdminApi, GatekeeperVendorInfo, OutputFormatOffer, ListOutputsResult, createOpenGadgetError, getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, AUTH_ERROR_CODES, createAuthError, isDeploymentHubId, isFinanceOperationsWorkbenchBlueprintId, type CodingSessionApplicationCapability, type CodingSessionAttachCapability, type CodingSessionDevelopmentCatalog, type CodingSessionDevelopmentPlan, type CodingSessionDevelopmentStatus, type CodingSessionEditorCapability, type CodingSessionFileUploadRequest, type CodingSessionFileUploadResult, type CodingSessionOpenCodeCapability, type CodingSessionRepositoryOption, type CodingSessionSummary, type CodingSessionTerminalKind, type CreateCodingSessionRequest, type DeploymentHubId, type FinanceHubStatus, type OpenCodeUserCustomization, type RequiredConnectionStatus, type BrowserFlowOptions, type BrowserFlowStart, type NativeLoginFlowStatus, type NativeLoginConsumeResult } from '@gadgets/workshop-shared/api';
import type { CodingSessionActivity } from "@gadgets/workshop-shared/coding-sessions";
import type { ProductFeedbackStatus, ProductFeedbackSubmissionResult, SubmitProductFeedbackRequest } from "@gadgets/workshop-shared/product-feedback";
import type { UiFeatureFlags } from "@gadgets/workshop-shared/feature-flags";
import { getServerConfig } from "./deployment-config.js";
import { isPasswordAuthEnabled, getAuthGatekeeperAllowlist } from "./auth/config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";
import { getUsageInfo } from "./ai-gateway-billing/limits/usage-checker.js";
import { listConnectedAccounts, selectAccount } from "./ai-gateway-billing/cloudflare/connection-service.js";
import { PendingLogin, LoginConnectCallbackImpl, NativeLoginConnectCallbackImpl } from "./auth/login-flow.js";
import { NativeBrowserFlow, createNativeBrowserFlowRecord } from "./auth/native-browser-flow.js";
import { deploymentOutputForBlueprint, listFormatOffers, readAdminConfig } from "./admin-config.js";


// Re-export the optional-feature Durable Objects + entrypoints so they can be bound in wrangler.
export { PendingLogin, LoginConnectCallbackImpl, NativeLoginConnectCallbackImpl, NativeBrowserFlow };
import type { CodingSessionOwner, CodingSessionToolHost, CodingSessionToolResult } from "@gadgets/workshop-shared/coding-sessions";
import { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { getAiGatewayConfig } from "./ai-gateway.js";
import {
  ADMIN_SETTINGS_SINGLETON_NAME,
  AdminSettings,
  AdminApiImpl,
  type FinanceWorkspaceClaim,
  type FinanceWorkspaceClaimResult,
} from "./admin-settings.js";
import { BlueprintKvRecord, buildBlueprintArchiveStream, sanitizeBlueprintOutput, listFeaturedBlueprintsFromKv, parseBlueprintArchive, randomBlueprintId, readBlueprintContent, readBlueprintKvRecord } from "./blueprint-archive.js";
import { GatekeeperConnectCallbackImpl, normalizeUsername, UserDurableObject, CLOUDFLARE_VENDOR_ID, type ProvidedAccountInfo } from "./user";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GatekeeperHookLoopback, GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback } from "./overseer";
import { ExternalMessageGateway } from "./external-message-gateway";
import { RpcStub as NativeRpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { recordAnalytics } from "./analytics";
import { handleClientErrorRequest } from "./client-errors.js";
import { verifyCfAccessJwt } from "./access.js";
import { resolveUiFeatureFlags } from "./feature-flags";
import { serveSiteLogo, SITE_LOGO_PATH } from "./site-logo.js";
import { createWorkshopLogger } from "./observability";
import { retryOnDoReset, wrapDoStubForTelemetry } from "./do-retry";
import { loadBundledFinanceOperationsWorkbenchSource } from "./format-blueprints.js";

const logger = createWorkshopLogger("workshop.server");

function base64UrlEncode(bytes: Uint8Array): string {
  let text = "";
  for (let byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomOpaqueHandle(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function publicBaseUrl(env: Env): URL {
  return new URL(env.PUBLIC_BASE_URL || "http://localhost:8787");
}

function nativeBrowserFlows(ctx: ExecutionContext): DurableObjectNamespace<NativeBrowserFlow> {
  return ctx.exports.NativeBrowserFlow as unknown as DurableObjectNamespace<NativeBrowserFlow>;
}

export async function gatekeeperAppInstanceId(account: Pick<ProvidedAccountInfo, "accountId">)
    : Promise<string> {
  let hash = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(`gatekeeper-app-account:${account.accountId}`));
  return `acct_${base64UrlEncode(new Uint8Array(hash).slice(0, 18))}`;
}

function canOpenGatekeeperApp(account: ProvidedAccountInfo, isAdmin: boolean): boolean {
  return Boolean(account.description.providesUi &&
      (isAdmin || !account.description.providesUi.adminOnly));
}

export async function listVisibleGatekeeperApps(accounts: ProvidedAccountInfo[], isAdmin: boolean)
    : Promise<GatekeeperAppInfo[]> {
  return Promise.all(accounts
      .filter((account) => canOpenGatekeeperApp(account, isAdmin))
      .map(async (account) => ({
        id: await gatekeeperAppInstanceId(account),
        vendorId: account.vendorId,
        accountDisplayName: account.description.displayName,
        accountUniqueName: account.description.uniqueName,
        title: account.description.providesUi!.title,
        icon: account.description.providesUi!.icon,
        composition: account.description.providesUi!.composition,
      })));
}

export async function resolveGatekeeperAppAccount(accounts: ProvidedAccountInfo[], id: string,
    isAdmin: boolean): Promise<ProvidedAccountInfo | null> {
  let app: ProvidedAccountInfo | undefined;
  for (let account of accounts) {
    if (account.description.providesUi && await gatekeeperAppInstanceId(account) === id) {
      app = account;
      break;
    }
  }
  if (!app) {
    let legacyMatches = accounts.filter((account) =>
      account.vendorId === id && canOpenGatekeeperApp(account, isAdmin));
    if (legacyMatches.length === 1) app = legacyMatches[0];
  }
  if (!app || !canOpenGatekeeperApp(app, isAdmin)) return null;
  return app;
}

// Set once we've asked the AdminSettings DO to install the bundled format blueprints (see the
// fetch handler), so later requests skip the call. The DO holds the real answer.
let formatBlueprintInstallStarted = false;

function publicBlueprintInfo(id: string, metadata: BlueprintPublicInfo['metadata']): BlueprintPublicInfo {
  return {
    id,
    metadata,
    screenshotUrl: blueprintScreenshotUrl(id, metadata),
  };
}

/** Resolve the fail-closed Finance entitlement returned by the authenticated API. */
export function resolveFinanceHubStatus(
    workspaceId: string | null, liveAuthorized: boolean, isAdmin: boolean): FinanceHubStatus {
  if (workspaceId) {
    return liveAuthorized
      ? {authorized: true, workspaceId, canCreate: false}
      : {authorized: false, canCreate: false};
  }
  if (isAdmin) return {authorized: true, canCreate: true};
  return {authorized: false, canCreate: false};
}

/** Read the deployment claim and validate the caller against the live Finance permission graph. */
export async function readFinanceHubStatus(
    adminSettings: DurableObjectNamespace<AdminSettings>,
    overseers: DurableObjectNamespace<OverseerDurableObject>,
    userId: string, profileId: string, isAdmin: boolean): Promise<FinanceHubStatus> {
  let claim: FinanceWorkspaceClaim | null;
  try {
    claim = await retryOnDoReset(() => adminSettings
        .getByName(ADMIN_SETTINGS_SINGLETON_NAME).getFinanceWorkspaceClaim());
  } catch (error) {
    logger.warn("failed to read Finance workspace claim", {
      event: "finance.claim.read.failed", error,
    });
    return {authorized: false, canCreate: false};
  }
  if (!claim) return resolveFinanceHubStatus(null, false, isAdmin);

  try {
    let workspace = overseers.get(overseers.idFromString(claim.workspaceId));
    let authorized = await retryOnDoReset(
        () => workspace.hasFinanceHubAccess(claim, userId, profileId, isAdmin));
    return resolveFinanceHubStatus(claim.workspaceId, authorized, isAdmin);
  } catch (error) {
    logger.warn("failed to validate Finance workspace access", {
      event: "finance.access.validate.failed", error,
    });
    return {authorized: false, canCreate: false};
  }
}

/**
 * Run workspace creation with deterministic resource cleanup. An ordinary generated ID belongs to
 * this attempt; a fresh Finance claim owns only its fresh registration, preserving exact retries.
 */
type BlueprintWorkspaceCreationOps<T extends {[Symbol.dispose](): void}> = {
  claim?: () => Promise<FinanceWorkspaceClaimResult>;
  register: () => Promise<"inserted" | "existing" | void>;
  open: () => Promise<T>;
  finish: (opened: T) => Promise<void>;
  rollbackRegistration?: (opened: T | undefined) => Promise<void>;
  releaseClaim?: () => Promise<unknown>;
};

export async function runBlueprintWorkspaceCreation<T extends {[Symbol.dispose](): void}>(
    ops: BlueprintWorkspaceCreationOps<T>): Promise<T> {
  let claimed = false;
  let registered = false;
  let registrationAttempted = false;
  let opened: T | undefined;
  try {
    if (ops.claim) {
      if (!ops.rollbackRegistration || !ops.releaseClaim) {
        throw new TypeError("Claimed workspace creation requires rollback handlers.");
      }
      let claimResult = await ops.claim();
      if (claimResult === "conflict") {
        throw new Error("A Finance workspace already exists on this deployment.");
      }
      claimed = claimResult === "claimed";
    }
    registrationAttempted = true;
    registered = await ops.register() === "inserted";
    opened = await ops.open();
    await ops.finish(opened);
    return opened;
  } catch (error) {
    let cleanupErrors: unknown[] = [];
    let ownsRegistration = ops.claim ? claimed && registered : registrationAttempted;
    // An ambiguous Finance registration must retain its fresh claim as the recovery handle.
    let registrationRolledBack = !claimed;
    if (ownsRegistration && ops.rollbackRegistration) {
      try {
        await ops.rollbackRegistration(opened);
        registrationRolledBack = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      opened?.[Symbol.dispose]();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (claimed && registrationRolledBack && ops.releaseClaim) {
      try {
        await ops.releaseClaim();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      logger.error("blueprint workspace cleanup failed", {
        event: "blueprint.workspace.cleanup.failed",
        error: new AggregateError(cleanupErrors),
      });
    }
    throw error;
  }
}

/** Enforce the protected Finance bootstrap pairing and return whether it is that bootstrap. */
export function assertBlueprintOriginAllowed(
    blueprintId: string, originHubId: DeploymentHubId | undefined, isAdmin: boolean): boolean {
  let isFinanceBlueprint = isFinanceOperationsWorkbenchBlueprintId(blueprintId);
  if (isFinanceBlueprint) {
    if (originHubId !== "finance" || !isAdmin) throw new Error("Blueprint not found.");
  } else if (originHubId === "finance") {
    throw new Error("Only the Finance Operations Workbench may use the Finance hub origin.");
  }
  return isFinanceBlueprint;
}

/** Remove the protected Finance starter from owner-scoped blueprint records. */
export function visibleOwnBlueprints(
    blueprints: BlueprintUserSummary[]): BlueprintUserSummary[] {
  return blueprints.filter(({id}) => !isFinanceOperationsWorkbenchBlueprintId(id));
}

/** Return an owner-scoped blueprint only when it is not the protected Finance starter. */
export function visibleOwnBlueprint(
    blueprint: BlueprintUserSummary | null): BlueprintUserSummary | null {
  return blueprint && !isFinanceOperationsWorkbenchBlueprintId(blueprint.id) ? blueprint : null;
}

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from admin-settings.ts.
export { AdminSettings };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl };

/** Restart-safe owner capability used by the Sessions worker to serve Workshop MCP. */
export class CodingSessionToolHostImpl
  extends WorkerEntrypoint<Env>
  implements CodingSessionToolHost {
  #user(owner: CodingSessionOwner): DurableObjectStub<UserDurableObject> {
    const users = this.ctx.exports.UserDurableObject;
    return wrapDoStubForTelemetry(users.get(users.idFromString(owner.userId)));
  }

  async prepareSessionStartup(
    owner: CodingSessionOwner,
    _sessionId: string,
    repositories: string[],
  ): Promise<OpenCodeUserCustomization> {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.prepareCodingSessionStartup(repositories);
  }

  async listTools(owner: CodingSessionOwner, sessionId: string, sandboxId: string) {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.listCodingSessionTools(sessionId, sandboxId);
  }

  async listResources(owner: CodingSessionOwner, sessionId: string, sandboxId: string) {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.listCodingSessionResources(sessionId, sandboxId);
  }

  async readResource(owner: CodingSessionOwner, sessionId: string, uri: string, sandboxId: string) {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.readCodingSessionResource(sessionId, uri, sandboxId);
  }

  async callTool(owner: CodingSessionOwner, sessionId: string, name: string,
      args: Record<string, unknown> | undefined, sandboxId: string)
      : Promise<CodingSessionToolResult> {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.callCodingSessionTool(sessionId, name, args, sandboxId);
  }

  async getActionResult(owner: CodingSessionOwner, sessionId: string, name: string,
      actionId: number, sandboxId: string)
      : Promise<CodingSessionToolResult> {
    const user = this.#user(owner);
    await user.assertRequiredConnectionsHealthy();
    return user.getCodingSessionActionResult(sessionId, name, actionId, sandboxId);
  }
}

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, GatekeeperHookLoopback,
    CodeModeTailLoopback, AgentSpawnerGatekeeper, GadgetTailLoopback,
    AgentSelfLoopback, TransientStubLoopback };

// Re-export service-binding entrypoint for external channel integrations.
export { ExternalMessageGateway };

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Set these if using Cloudflare Access for authentication, otherwise username/password is used.
  CF_ACCESS_AUD?: string,  // audience
  CF_ACCESS_ISS?: string,  // team URL, i.e. https://<team>.cloudflareaccess.com
  DEV?: boolean;
  FLAGS?: Flagship;
}

// =======================================================================================

@validateRpc()
class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private env: Env,
      userId: DurableObjectId,
      private abortSession: (reason: Error) => void) {
    super();

    this.#userId = userId;
    this.overseers = this.ctx.exports.OverseerDurableObject;
    this.adminSettings = this.ctx.exports.AdminSettings;
    this.users = this.ctx.exports.UserDurableObject;
  }

  private overseers: DurableObjectNamespace<OverseerDurableObject>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  private users: DurableObjectNamespace<UserDurableObject>;

  #userId: DurableObjectId;

  // Get a stub pointing at the user DO. We create a new stub for every request so that we don't
  // have to worry about detecting when a stub has become broken.
  get #user(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(this.users.get(this.#userId));
  }

  #isAdmin(): boolean {
    let name = this.#userId.name;
    let admins = this.env.ADMINS;

    if (!name || !admins) return false;

    if (typeof admins === "string") {
      // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
      // specify JSON bindings, so we also support a string that parses as JSON array.
      admins = JSON.parse(admins);
    }

    if (!Array.isArray(admins)) {
      throw new TypeError("ADMINS must be configured as an array of usernames.");
    }

    return admins.includes(name);
  }

  whoami(): Promise<AiChatAuthorInfo> {
    // Pure-read delegations retry once across a user-DO reset (see retryOnDoReset); writes never do.
    return retryOnDoReset(() => this.#user.whoami());
  }
  setOwnDisplayName(name: string): Promise<void> {
    return this.#user.setOwnDisplayName(name);
  }
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    return this.#user.changePassword(oldHash, newHash);
  }
  hasPasswordLogin(): Promise<boolean> {
    return retryOnDoReset(() => this.#user.hasPasswordLogin());
  }
  listModels(): Promise<AiChatAuthorInfo[]> {
    return retryOnDoReset(() => this.#user.listModels());
  }
  addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    return this.#user.addModel(profile, config);
  }
  deleteModel(id: string): Promise<void> {
    return this.#user.deleteModel(id);
  }
  setQuickModel(id: string | null): Promise<void> {
    return this.#user.setQuickModel(id);
  }
  getQuickModel(): Promise<null | string> {
    return retryOnDoReset(() => this.#user.getQuickModel());
  }

  getSimplifiedTechnicalEnglishEnabled(): Promise<boolean> {
    return retryOnDoReset(() => this.#user.getSimplifiedTechnicalEnglishEnabled());
  }

  setSimplifiedTechnicalEnglishEnabled(enabled: boolean): Promise<void> {
    return this.#user.setSimplifiedTechnicalEnglishEnabled(enabled);
  }

  getPreferredModel(): Promise<string | null> {
    return retryOnDoReset(() => this.#user.getPreferredModel());
  }
  setPreferredModel(id: string | null): Promise<void> {
    return this.#user.setPreferredModel(id);
  }
  isOnboardingCompleted(): Promise<boolean> {
    return retryOnDoReset(() => this.#user.isOnboardingCompleted());
  }
  completeOnboarding(): Promise<void> {
    return this.#user.completeOnboarding();
  }

  getCloudflareUsage(): Promise<CloudflareUsageInfo> {
    return getUsageInfo(this.env, this.#user);
  }

  listCloudflareAccounts(): Promise<CloudflareAccountOption[]> {
    return listConnectedAccounts(this.env, this.#user);
  }

  selectCloudflareAccount(accountId: string): Promise<void> {
    return selectAccount(this.env, this.#user, accountId);
  }

  async setAvatar(data: Uint8Array | null): Promise<void> {
    if (data) {
      if (data.byteLength > 100 * 1024) {
        throw new Error("Avatar too large (max 100 KB)");
      }
      // Verify the data starts with a known image magic-byte header.
      let isJpeg = data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
      let isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;
      if (!isJpeg && !isPng) {
        throw new Error("Avatar must be a JPEG or PNG image");
      }
    }
    // Avatar data lives in KV (global), not the user's DO storage, so we
    // read/write it directly here to avoid routing through the DO location.
    let userId = this.#userId.name!;
    if (data) {
      await this.env.AVATARS.put(userId, data);
    } else {
      await this.env.AVATARS.delete(userId);
    }
  }
  async getAvatar(userId: string): Promise<Uint8Array | null> {
    let result = await this.env.AVATARS.get(userId, "arrayBuffer");
    if (!result) return null;
    return new Uint8Array(result);
  }

  getAiConfig(): Promise<AiGatewayInfo> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      return Promise.resolve({
        enabled: true,
        enabledProviders: [...gwConfig.providers] as AiModelProvider[],
      });
    } else {
      return Promise.resolve({ enabled: false });
    }
  }

  getUiFeatureFlags(): Promise<UiFeatureFlags> {
    return resolveUiFeatureFlags(this.env, this.#userId.name!);
  }

  async #assertCodingSessionRuntimeEnabled(runtime: "pi" | "prime-agent"): Promise<void> {
    const flags = await resolveUiFeatureFlags(this.env, this.#userId.name!);
    if (!flags["pi-coding-session-runtime"]) {
      const label = runtime === "pi" ? "Pi" : "Prime Agent";
      throw new Error(`${label} coding sessions are not enabled for this account.`);
    }
  }

  async #assertRequiredConnectionsHealthy(): Promise<void> {
    await this.#user.assertRequiredConnectionsHealthy();
  }

  codingSessionEditorAvailable(): Promise<boolean> {
    return this.#user.codingSessionEditorAvailable();
  }

  listCodingSessions(): Promise<CodingSessionSummary[]> {
    return this.#user.listCodingSessions();
  }

  getCodingSessionDevelopmentCatalog(): Promise<CodingSessionDevelopmentCatalog> {
    return this.#user.getCodingSessionDevelopmentCatalog();
  }

  async preflightCodingSession(request: CreateCodingSessionRequest): Promise<CodingSessionDevelopmentPlan> {
    await this.#assertRequiredConnectionsHealthy();
    if (request.runtime && request.runtime !== "opencode") await this.#assertCodingSessionRuntimeEnabled(request.runtime);
    return this.#user.preflightCodingSession(request);
  }

  getCodingSessionDevelopmentStatus(sessionId: string): Promise<CodingSessionDevelopmentStatus> {
    return this.#user.getCodingSessionDevelopmentStatus(sessionId);
  }

  listCodingSessionRepositoryOptions(query?: string): Promise<CodingSessionRepositoryOption[]> {
    return this.#user.listCodingSessionRepositoryOptions(query);
  }

  async createCodingSession(request: CreateCodingSessionRequest): Promise<CodingSessionSummary> {
    await this.#assertRequiredConnectionsHealthy();
    if (request.runtime && request.runtime !== "opencode") await this.#assertCodingSessionRuntimeEnabled(request.runtime);
    return this.#user.createCodingSession(request);
  }

  getOpenCodeCustomization(): Promise<OpenCodeUserCustomization> {
    return this.#user.getOpenCodeCustomization();
  }

  setOpenCodeCustomization(customization: OpenCodeUserCustomization): Promise<void> {
    return this.#user.setOpenCodeCustomization(customization);
  }

  stopCodingSession(sessionId: string): Promise<void> {
    return this.#user.stopCodingSession(sessionId);
  }

  async restartCodingSession(sessionId: string): Promise<CodingSessionSummary> {
    await this.#assertRequiredConnectionsHealthy();
    const session = (await this.#user.listCodingSessions()).find(({ id }) => id === sessionId);
    if (session?.runtime && session.runtime !== "opencode") await this.#assertCodingSessionRuntimeEnabled(session.runtime);
    return this.#user.restartCodingSession(sessionId);
  }

  archiveCodingSession(sessionId: string): Promise<void> {
    return this.#user.archiveCodingSession(sessionId);
  }

  async mintCodingSessionAttachCapability(
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.mintCodingSessionAttachCapability(sessionId, terminal);
  }

  async mintCodingSessionEditorCapability(sessionId: string): Promise<CodingSessionEditorCapability> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.mintCodingSessionEditorCapability(sessionId);
  }

  async mintCodingSessionOpenCodeCapability(sessionId: string): Promise<CodingSessionOpenCodeCapability> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.mintCodingSessionOpenCodeCapability(sessionId);
  }

  /** Attaches to the authenticated owner's existing Pi bridge without launching a process. */
  async connectCodingSessionPi(sessionId: string): Promise<import('@gadgets/workshop-shared/api').CodingSessionPiConnection> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.connectCodingSessionPi(sessionId);
  }

  /** Rechecks the required-connection gate before dispatching an owner Pi operation. */
  async callCodingSessionPi(sessionId: string, connectionId: string, command: import('@gadgets/workshop-shared/api').CodingSessionPiCommand): Promise<import('@gadgets/workshop-shared/api').CodingSessionPiResult> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.callCodingSessionPi(sessionId, connectionId, command);
  }

  async mintCodingSessionApplicationCapability(
    sessionId: string,
    applicationId: string,
  ): Promise<CodingSessionApplicationCapability> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.mintCodingSessionApplicationCapability(sessionId, applicationId);
  }

  async uploadCodingSessionFile(
    request: CodingSessionFileUploadRequest,
  ): Promise<CodingSessionFileUploadResult> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.uploadCodingSessionFile(request);
  }

  listCodingSessionActivity(sessionId?: string): Promise<CodingSessionActivity[]> {
    return this.#user.listCodingSessionActivity(sessionId);
  }

  async approveCodingSessionAction(activityId: string): Promise<void> {
    await this.#assertRequiredConnectionsHealthy();
    return this.#user.approveCodingSessionAction(activityId);
  }

  rejectCodingSessionAction(activityId: string): Promise<void> {
    return this.#user.rejectCodingSessionAction(activityId);
  }

  productFeedbackAvailable(): Promise<boolean> {
    return this.#user.productFeedbackAvailable();
  }

  submitProductFeedback(request: SubmitProductFeedbackRequest): Promise<ProductFeedbackSubmissionResult> {
    return this.#user.submitProductFeedback(request);
  }

  listProductFeedbackStatuses(): Promise<ProductFeedbackStatus[]> {
    return this.#user.listProductFeedbackStatuses();
  }

  getProductFeedbackStatus(id: string): Promise<ProductFeedbackStatus | undefined> {
    return this.#user.getProductFeedbackStatus(id);
  }

  async #openGadgetInternal(id: string, shareKey?: string,
                            configureObservers?: RpcStub<ObserverConfigCallback>,
                            requiredConnectionsChecked = false)
      : Promise<NativeRpcStub<Overseer>> {
    if (!requiredConnectionsChecked) await this.#assertRequiredConnectionsHealthy();
    let userId = this.#userId.toString();
    let profileId = this.#userId.name!;
    let overseerId;
    try {
      overseerId = this.overseers.idFromString(id);
    } catch {
      throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
    }
    let overseer = this.overseers.get(overseerId);

    // HACK: Detect loss of the connection to the DO by:
    // - Pass a callback to overseer.open() which it should call when the session is disposed.
    // - Detect if the callback itself is disposed before being called, suggesting the connection
    //   was lost.
    // If the connection is lost, we abort this I/O context, which kills the WebSocket from the
    // client, forcing it to engage its reconnect logic, which should recover.
    // TODO: Implement onRpcBroken() in the built-in RPC system, matching Cap'n Web, and use that
    //   instead.
    // TODO: Consider how to reconnect to one DO without resetting the whole WebSocket. Probably
    //   needs new code on the client side. However, typically a client only ever opens one
    //   gadget at a time (since each tab is a separate client), so it's probably fine for now.
    let closed = false;
    let started = false;
    let notifyClosed = () => {
      closed = true;
    };
    (notifyClosed as any)[Symbol.dispose] = () => {
      if (started && !closed) {
        // this.ctx.abort() would be nicer here, but it is still marked experimental in the
        // workers runtime.
        this.abortSession(new Error(`lost connection to workspace DO (gadget ${id})`));
      }
    }

    let result;
    try {
      result = await overseer.open(
          userId, profileId, notifyClosed, shareKey, configureObservers, this.#isAdmin());
    } catch (err) {
      // A denial proves this user's listing for the workspace is stale: revocation tries to drop it
      // (refreshAffectedCollaboratorListings), but that push is best-effort. Only catches entries
      // they click; others stay frozen at revocation, as a disconnected collaborator gets no pushes.
      if (getOpenGadgetErrorCode(err) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) {
        await this.#user.forgetSharedGadget(id);
      }
      throw err;
    }
    started = true;
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_opened",
      user_id: userId,
      gadget_id: id,
      source: shareKey ? "share_key" : "direct",
    });
    return result;
  }

  async openGadget(id: string, shareKey?: string,
                   configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<RpcStub<Overseer>> {
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return this.#openGadgetInternal(id, shareKey, configureObservers);
  }

  async newGadget(originHubId?: DeploymentHubId): Promise<RpcStub<Overseer>> {
    await this.#assertRequiredConnectionsHealthy();
    if (originHubId !== undefined && !isDeploymentHubId(originHubId)) {
      throw new Error("Invalid deployment hub id.");
    }
    if (originHubId === "finance") {
      throw new Error("Finance workspaces must be created from the Finance hub.");
    }
    let id = this.overseers.newUniqueId().toString();
    let result = await runBlueprintWorkspaceCreation({
      register: async () => {
        await this.#user.newGadget(id, "Untitled Workspace", originHubId);
      },
      open: () => this.#openGadgetInternal(id, undefined, undefined, true),
      finish: async () => {
        recordAnalytics(this.ctx, this.env, {
          event_name: "gadget_created",
          user_id: this.#userId.toString(),
          gadget_id: id,
          source: "blank",
        });
      },
      rollbackRegistration: async (openedOverseer) => {
        if (openedOverseer) {
          await openedOverseer.deleteSelf("creation-rollback");
        } else {
          await retryOnDoReset(() => this.#user.deleteGadget(id));
        }
      },
    });
    if (!result) {
      throw new Error("Open failed despite newly-created workspace?");
    }
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return result;
  }

  async getFinanceHubStatus(): Promise<FinanceHubStatus> {
    return readFinanceHubStatus(
        this.adminSettings, this.overseers, this.#userId.toString(), this.#userId.name!,
        this.#isAdmin());
  }

  async updateProvisionalWorkspaceOrigin(
      workspaceId: string, originHubId: DeploymentHubId): Promise<void> {
    if (!isDeploymentHubId(originHubId)) {
      throw new Error("Invalid deployment hub id.");
    }
    if (originHubId === "finance") {
      throw new Error("Finance workspaces must be created from the Finance hub.");
    }
    await this.#user.updateProvisionalWorkspaceOrigin(workspaceId, originHubId);
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    return retryOnDoReset(() => this.#user.listGadgets());
  }

  listOutputs(): Promise<ListOutputsResult> {
    return this.#user.listOutputs();
  }

  async listOutputFormats(): Promise<OutputFormatOffer[]> {
    let offers = await listFormatOffers(this.env, await readAdminConfig(this.env));
    // Neither the agent's hint nor the binding details are part of what a user is offered here.
    return offers.map(({agentHint: _agentHint, bindings: _bindings, ...offer}) => offer);
  }

  listGatekeeperVendors(filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]> {
    return retryOnDoReset(() => this.#user.listGatekeeperVendors(filter));
  }

  getRequiredConnectionStatuses(): Promise<RequiredConnectionStatus[]> {
    return this.#user.getRequiredConnectionStatuses();
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[], options?: { flow?: BrowserFlowOptions }): Promise<BrowserFlowStart> {
    if (options?.flow?.returnMode === "native-verified-link") {
      const result = await this.#startNativeAccountFlow("connect", options.flow, flow =>
        this.#user.connectAccount(vendorId, resourceUrlPatterns, flow));
      if (!result.url) throw new Error("Native account connection did not return an authorization URL.");
      return result as BrowserFlowStart;
    }
    return this.#user.connectAccount(vendorId, resourceUrlPatterns);
  }

  ensureAccountResources(accountId: number, resourceUrlPatterns: string[], options?: { flow?: BrowserFlowOptions }): Promise<Partial<BrowserFlowStart>> {
    if (options?.flow?.returnMode === "native-verified-link") {
      return this.#startNativeAccountFlow("grant", options.flow, flow =>
        this.#user.ensureAccountResources(accountId, resourceUrlPatterns, flow));
    }
    return this.#user.ensureAccountResources(accountId, resourceUrlPatterns);
  }

  listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    return retryOnDoReset(() => this.#user.listAddableGatekeepers());
  }

  provisionAmbientAccount(vendorId: string): Promise<void> {
    return this.#user.provisionAmbientAccount(vendorId);
  }

  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    return this.#user.subscribeConnectedAccounts(subscriber, filter);
  }

  disconnectAccount(accountId: number): Promise<void> {
    return this.#user.disconnectAccount(accountId);
  }

  async reconnectAccount(accountId: number, options?: { flow?: BrowserFlowOptions }): Promise<BrowserFlowStart> {
    if (options?.flow?.returnMode === "native-verified-link") {
      const result = await this.#startNativeAccountFlow("reconnect", options.flow, flow =>
        this.#user.reconnectAccount(accountId, flow));
      if (!result.url) throw new Error("Native account reconnection did not return an authorization URL.");
      return result as BrowserFlowStart;
    }
    return this.#user.reconnectAccount(accountId);
  }

  async #startNativeAccountFlow(
      kind: "connect" | "reconnect" | "grant",
      flow: BrowserFlowOptions,
      start: (flow: { flowHandle: string; returnUrl: string }) => Promise<{ url?: string }>): Promise<Partial<BrowserFlowStart>> {
    if (!flow.clientVerifierHash) throw new Error("Native account browser flow requires a client verifier hash.");
    const flowHandle = randomOpaqueHandle();
    const returnUrl = new URL(`/native/oauth-return/${encodeURIComponent(flowHandle)}`, publicBaseUrl(this.env)).toString();
    const { url: providerInitiationUrl } = await start({ flowHandle, returnUrl });
    if (!providerInitiationUrl) return {};
    const record = createNativeBrowserFlowRecord({
      kind,
      flowHandle,
      launchTicket: flowHandle,
      clientVerifierHash: flow.clientVerifierHash,
      providerInitiationUrl,
      userId: this.#userId.toString(),
    });
    await nativeBrowserFlows(this.ctx).get(nativeBrowserFlows(this.ctx).idFromName(flowHandle))
        .initialize(record);
    return {
      url: new URL(`/native/oauth-start/${encodeURIComponent(flowHandle)}`, publicBaseUrl(this.env)).toString(),
      flowHandle,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  async getNativeAccountFlowStatus(flowHandle: string, clientVerifier: string): Promise<NativeLoginFlowStatus> {
    return await nativeBrowserFlows(this.ctx).get(nativeBrowserFlows(this.ctx).idFromName(flowHandle))
        .getAccountStatus(await sha256Hex(clientVerifier), this.#userId.toString());
  }

  startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string) {
    return this.#user.startResourceConfigurator(accountId, resourceUrlPattern);
  }

  async dismissSharedGadget(gadgetId: string): Promise<void> {
    return this.#user.forgetSharedGadget(gadgetId);
  }

  async listOwnBlueprints(): Promise<BlueprintUserSummary[]> {
    return visibleOwnBlueprints(await retryOnDoReset(() => this.#user.listBlueprints()));
  }

  async getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null> {
    if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) return null;
    return visibleOwnBlueprint(await retryOnDoReset(() => this.#user.getBlueprint(blueprintId)));
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    return (await retryOnDoReset(() => this.#user.listLibraryBlueprints()))
        .filter(({id}) => !isFinanceOperationsWorkbenchBlueprintId(id));
  }

  async setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void> {
    if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) {
      throw new Error("Blueprint not found.");
    }
    return this.#user.setBlueprintPinned(blueprintId, pinned);
  }

  async isBlueprintPinned(blueprintId: string): Promise<boolean> {
    if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) return false;
    return retryOnDoReset(() => this.#user.isBlueprintPinned(blueprintId));
  }

  async listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]> {
    return (await listFeaturedBlueprintsFromKv(this.env))
        .filter(({id}) => !isFinanceOperationsWorkbenchBlueprintId(id)).map(
        blueprint => publicBlueprintInfo(blueprint.id, blueprint.metadata));
  }

  async addBlueprintToLibrary(blueprintId: string): Promise<void> {
    if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) {
      throw new Error("Blueprint not found.");
    }
    return this.#user.addBlueprintToLibrary(blueprintId);
  }

  async removeBlueprintFromLibrary(blueprintId: string): Promise<void> {
    return this.#user.removeBlueprintFromLibrary(blueprintId);
  }

  isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null> {
    return retryOnDoReset(() => this.#user.isBlueprintInLibrary(blueprintId));
  }

  async importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string> {
    let { metadata, contentLength, content } = await parseBlueprintArchive(archive);
    delete metadata.screenshot;
    let blueprintId = randomBlueprintId();
    let r2Key = `${blueprintId}/${metadata.version}`;

    try {
      let fixedLengthStream = new FixedLengthStream(contentLength);

      await Promise.all([
        content.pipeTo(fixedLengthStream.writable),
        this.env.BLUEPRINT_CONTENT.put(r2Key, fixedLengthStream.readable),
      ]);

      let kvRecord: BlueprintKvRecord = {
        metadata,
        ownerId: this.#userId.toString(),
      };

      await this.env.BLUEPRINTS.put(blueprintId, JSON.stringify(kvRecord));

      await this.#user.importBlueprint(blueprintId, metadata);

      recordAnalytics(this.ctx, this.env, {
        event_name: "blueprint_imported",
        user_id: this.#userId.toString(),
        blueprint_id: blueprintId,
      });

      return blueprintId;
    } catch (err) {
      // Try to delete what we uploaded, but don't wait for results becasue there's nothing we
      // can do if they fail, and we already have an error to throw.
      this.env.BLUEPRINTS.delete(blueprintId);
      this.env.BLUEPRINT_CONTENT.delete(r2Key);
      throw err;
    }
  }

  async newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>,
    originHubId?: DeploymentHubId,
  ): Promise<RpcStub<Overseer>> {
    await this.#assertRequiredConnectionsHealthy();
    if (originHubId !== undefined && !isDeploymentHubId(originHubId)) {
      throw new Error("Invalid deployment hub id.");
    }
    let isFinanceBlueprint = assertBlueprintOriginAllowed(
        blueprintId, originHubId, this.#isAdmin());
    // Protected Finance creation and recovery always use the immutable source bundled into this
    // Worker. Ordinary blueprints use their installed KV metadata and R2 code snapshot.
    let kvRecord: BlueprintKvRecord;
    let codeBytes: Uint8Array;
    if (isFinanceBlueprint) {
      let source = await loadBundledFinanceOperationsWorkbenchSource();
      kvRecord = {metadata: source.metadata};
      codeBytes = source.code;
    } else {
      let stored = await readBlueprintKvRecord(this.env, blueprintId);
      if (!stored) throw new Error("Blueprint not found.");
      kvRecord = stored;
      let storedCode = await readBlueprintContent(this.env, blueprintId, stored.metadata.version);
      if (!storedCode) throw new Error("Blueprint content not found in R2.");
      codeBytes = storedCode;
    }

    // 3. Create new Overseer DO (same as newGadget()).
    let id = this.overseers.newUniqueId().toString();
    let financeClaim: FinanceWorkspaceClaim | undefined = isFinanceBlueprint ? {
      workspaceId: id,
      ownerUserId: this.#userId.toString(),
      ownerProfileId: this.#userId.name!,
    } : undefined;
    let adminSettings = this.adminSettings.getByName(ADMIN_SETTINGS_SINGLETON_NAME);
    let rollbackRegistration = async (openedOverseer: NativeRpcStub<Overseer> | undefined) => {
      if (openedOverseer) {
        await openedOverseer.deleteSelf("creation-rollback");
      } else {
        await retryOnDoReset(() => this.#user.deleteGadget(id));
      }
    };
    let overseerResult = await runBlueprintWorkspaceCreation({
      claim: financeClaim
          ? () => adminSettings.claimFinanceWorkspace(financeClaim)
          : undefined,
      register: () => financeClaim
          ? this.#user.registerFinanceGadget(id, kvRecord.metadata.title)
          : this.#user.newGadget(id, kvRecord.metadata.title, originHubId),
      open: () => this.#openGadgetInternal(id, undefined, undefined, true),
      rollbackRegistration,
      releaseClaim: financeClaim
          ? () => retryOnDoReset(() => this.adminSettings
              .getByName(ADMIN_SETTINGS_SINGLETON_NAME).releaseFinanceWorkspace(financeClaim))
          : undefined,
      finish: async (openedOverseer) => {
        // 4. Initialize from blueprint code.
        let overseerDo = this.overseers.get(this.overseers.idFromString(id));
        await overseerDo.initializeFromBlueprint(codeBytes, kvRecord.metadata.title,
            deploymentOutputForBlueprint(await readAdminConfig(this.env), blueprintId,
                sanitizeBlueprintOutput(kvRecord.metadata.output)));

        // 5. Create gatekeepers from assignments and bind them into the workspace's (only) gadget.
        let metadata = await openedOverseer.getMetadata();
        using gadget = await openedOverseer.getGadget(metadata.defaultGadgetId!);

        // Defensively put blueprint bindings into a map (not a raw object) until validation.
        let blueprintBindings = new Map(Object.entries(kvRecord.metadata.bindings));
        let gadgetId = metadata.defaultGadgetId!;

        // Create non-spawner bindings first, then spawners whose env references those results.
        let createdIds = new Map<string, WorkpieceId>();
        let gkPromises: Promise<void>[] = [];

        for (let [bindingName, assignment] of Object.entries(bindings)) {
          let blueprintBinding = blueprintBindings.get(bindingName);
          if (!blueprintBinding) {
            throw new Error(`Unknown binding name: ${bindingName}`);
          }

          gkPromises.push((async () => {
            let gk;
            if (assignment.type === "gatekeeper") {
              gk = await openedOverseer.newGatekeeper(
                  assignment.accountId, assignment.resourceUrl);
              if (!gk) {
                throw new Error(`Failed to create gatekeeper for binding "${bindingName}".`);
              }
            } else if (assignment.type === "aiModel") {
              gk = await openedOverseer.newAiModelGatekeeper(assignment.modelId);
            } else {
              return;  // agent spawners are created in phase two
            }
            try {
              let id = await gk.getId();
              createdIds.set(bindingName, id);
              // A spawnerOnly binding feeds a spawner's env but is not bound into the gadget.
              if (!blueprintBinding.spawnerOnly) {
                await gadget.bind(bindingName, id);
              }
            } finally {
              gk[Symbol.dispose]();
            }
          })());
        }

        await Promise.all(gkPromises);

        for (let [bindingName, assignment] of Object.entries(bindings)) {
          if (assignment.type !== "agentSpawner") continue;
          let blueprintBinding = blueprintBindings.get(bindingName);
          if (blueprintBinding?.type !== "agentSpawner") {
            throw new Error(`Binding "${bindingName}" type mismatch.`);
          }

          let env: Record<string, WorkpieceId> = {};
          for (let [envName, target] of Object.entries(blueprintBinding.env)) {
            if (target.type === "gadget") {
              env[envName] = gadgetId;
            } else {
              let id = createdIds.get(target.name);
              if (id === undefined) {
                throw new Error(`Agent spawner binding "${bindingName}" references binding ` +
                    `"${target.name}", which was not assigned.`);
              }
              env[envName] = id;
            }
          }

          let config: AgentSpawnerConfig = {
            displayName: blueprintBinding.title,
            modelId: assignment.modelId,
            env,
          };
          using gk = await openedOverseer.newAgentSpawnerGatekeeper(config);
          await gadget.bind(bindingName, await gk.getId());
        }

        recordAnalytics(this.ctx, this.env, {
          event_name: "gadget_created",
          user_id: this.#userId.toString(),
          gadget_id: id,
          blueprint_id: blueprintId,
          source: "blueprint",
        });
      },
    });

    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return overseerResult;
  }

  async deleteOrphanedBlueprint(blueprintId: string): Promise<void> {
    return this.#user.deleteOwnedBlueprint(blueprintId);
  }

  // --- Gatekeeper management apps ---

  // The management apps available to the current user: their connected accounts that declare a
  // top-level UI (AccountDescription.providesUi). The app id is an opaque stable account-addressed
  // slug, so multiple UI accounts from the same vendor do not collide.
  async listGatekeeperApps(): Promise<GatekeeperAppInfo[]> {
    // listProvidedAccounts provisions auto-provisioned accounts first (idempotent), so their apps
    // appear in the nav even before the user opens a gadget — in a single round trip.
    let accounts = await this.#user.listProvidedAccounts();
    return await listVisibleGatekeeperApps(accounts, this.#isAdmin());
  }

  async getGatekeeperApp(id: string): Promise<GatekeeperUiFrame | null> {
    // Self-sufficient: listProvidedAccounts provisions auto-provisioned accounts first (idempotent),
    // so a direct URL load of /gatekeepers/$id works without racing the Header's listGatekeeperApps.
    let user = this.#user;  // one stub for both calls
    let accounts = await user.listProvidedAccounts();
    let app = await resolveGatekeeperAppAccount(accounts, id, this.#isAdmin());
    if (!app) return null;
    // isAdmin is supplied fresh per open so admin-gated features reflect the user's current status.
    return user.startAccountAppUi(app.accountId, { isAdmin: this.#isAdmin() });
  }

  // --- Deployment admin ---

  async amIAdmin(): Promise<boolean> {
    return this.#isAdmin();
  }

  async getAdminApi(): Promise<RpcStub<AdminApi> | null> {
    if (!this.#isAdmin()) return null;
    // #isAdmin() guarantees a non-empty user id name. Forwarded to gatekeepers when listing the
    // resource catalog so RBAC-gated ones still surface for this admin.
    let adminUserId = this.#userId.name!;
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return new AdminApiImpl(
        this.adminSettings.getByName(ADMIN_SETTINGS_SINGLETON_NAME), adminUserId);
  }
}

async function serveBlueprintScreenshot(env: Env, blueprintId: string): Promise<Response> {
  if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) {
    return new Response("Not Found", {status: 404});
  }
  let object = await env.BLUEPRINT_CONTENT.get(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${blueprintId}`);
  if (!object) return new Response("Not Found", {status: 404});

  let contentType = object.httpMetadata?.contentType;
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    contentType = "image/jpeg";
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// Returned by startGatekeeperLogin(). Wraps the PendingLogin DO so the client awaits the login
// result through a capability (this stub) rather than a guessable id — no login id is ever exposed
// to the client. Disposing the stub (e.g. when the pop-up closes or the component unmounts) cancels
// the in-flight wait and lets the DO be evicted.
@validateRpc()
class LoginAttemptImpl extends RpcTarget implements LoginAttempt {
  constructor(private pending: DurableObjectStub<PendingLogin>) {
    super();
  }

  async wait(): Promise<string> {
    return await this.pending.awaitResult();
  }
}

@validateRpc()
class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;

  constructor(private ctx: ExecutionContext, private env: Env,
      private abortSession: (reason: Error) => void,
      private accessPayload?: JWTPayload) {
    super();
    this.users = this.ctx.exports.UserDurableObject;
  }

  async ping(): Promise<void> {}

  async getServerConfig(): Promise<ServerConfig> {
    return getServerConfig(this.env);
  }

  startGatekeeperLogin(vendorId: string): Promise<{ url: string; attempt: RpcStub<LoginAttempt> }>;
  startGatekeeperLogin(vendorId: string, options: { flow: BrowserFlowOptions }): Promise<BrowserFlowStart>;
  async startGatekeeperLogin(vendorId: string, options?: { flow?: BrowserFlowOptions }): Promise<BrowserFlowStart & { attempt?: RpcStub<LoginAttempt> }> {
    if (!getAuthGatekeeperAllowlist(this.env).includes(vendorId)) {
      throw new Error(`Sign-in via "${vendorId}" is not enabled on this deployment.`);
    }
    const vendor = getAuthVendorBinding(this.env, vendorId);
    if (!vendor) throw new Error(`No such auth gatekeeper: ${vendorId}`);
    const desc = await vendor.describe();
    if (!desc.providesAuth) throw new Error(`"${vendorId}" does not provide authentication.`);

    const connectOptions = vendorId === CLOUDFLARE_VENDOR_ID
      ? { scopes: "full" as const, resourceUrlPatterns: [] }
      : { scopes: "auth" as const };

    if (options?.flow?.returnMode === "native-verified-link") {
      if (!options.flow.clientVerifierHash) throw new Error("Native login requires a client verifier hash.");
      const flowHandle = randomOpaqueHandle();
      const callback = this.ctx.exports.NativeLoginConnectCallbackImpl({ props: { flowHandle, vendorId } });
      const returnUrl = new URL(`/native/oauth-return/${encodeURIComponent(flowHandle)}`, publicBaseUrl(this.env));
      const { url: providerInitiationUrl } = await vendor.connectAccount(callback, {
        ...connectOptions,
        returnUrl: returnUrl.toString(),
      });
      const record = createNativeBrowserFlowRecord({
        kind: "login",
        flowHandle,
        launchTicket: flowHandle,
        clientVerifierHash: options.flow.clientVerifierHash,
        providerInitiationUrl,
      });
      await nativeBrowserFlows(this.ctx).get(nativeBrowserFlows(this.ctx).idFromName(flowHandle))
          .initialize(record);
      return {
        url: new URL(`/native/oauth-start/${encodeURIComponent(flowHandle)}`, publicBaseUrl(this.env)).toString(),
        flowHandle,
        expiresAt: new Date(record.expiresAt).toISOString(),
      };
    }

    // The PendingLogin DO is the rendezvous between this request and the (separate) OAuth-callback
    // invocation. The client never sees its id — we hand back an `attempt` stub instead.
    const pendingId = this.ctx.exports.PendingLogin.newUniqueId();
    const pending = this.ctx.exports.PendingLogin.get(pendingId);
    const callback = this.ctx.exports.LoginConnectCallbackImpl(
        { props: { pendingId: pendingId.toString(), vendorId } });
    const { url } = await vendor.connectAccount(callback, connectOptions);
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return { url, attempt: new LoginAttemptImpl(pending) };
  }

  async consumeNativeLoginFlow(flowHandle: string, clientVerifier: string): Promise<NativeLoginConsumeResult> {
    return await nativeBrowserFlows(this.ctx).get(nativeBrowserFlows(this.ctx).idFromName(flowHandle))
        .consumeLoginResult(await sha256Hex(clientVerifier));
  }

  async authenticate(token: string): Promise<AuthenticatedApi> {
    let split = token.split(':');
    if (split.length !== 2) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }

    let userId = this.users.idFromName(split[0]);
    await this.users.get(userId).authenticate(split[1]);
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "session_token",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession);
  }

  async authenticateFromCfAccess(): Promise<AuthenticatedApi> {
    if (!this.accessPayload) {
      throw createAuthError(AUTH_ERROR_CODES.notAuthenticatedWithAccess);
    }

    let email = this.accessPayload.email as string;
    let userId = this.users.idFromName(email);
    let signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
    let accountCreated =
        await this.users.get(userId).authenticateFromCfAccess(email, signupsEnabled);
    if (accountCreated) {
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: userId.toString(),
        source: "cf_access",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "cf_access",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession);
  }

  async login(username: string, passwordHash: Uint8Array): Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password login is disabled on this deployment. Use a sign-in option.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let token = await this.users.get(id).login(passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password signup is disabled on this deployment. Use a sign-in option.");
    }
    if (!(await readAdminConfig(this.env)).signupsEnabled) {
      throw new Error("New signups are currently disabled on this deployment.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.createAccount(username, displayName, passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "account_created",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async getBlueprint(id: string): Promise<BlueprintPublicInfo | null> {
    if (isFinanceOperationsWorkbenchBlueprintId(id)) return null;
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) return null;

    return publicBlueprintInfo(id, kvRecord.metadata);
  }

  async downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>> {
    if (isFinanceOperationsWorkbenchBlueprintId(id)) throw new Error("Blueprint not found.");
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) throw new Error("Blueprint not found.");

    let r2Object = await this.env.BLUEPRINT_CONTENT.get(`${id}/${kvRecord.metadata.version}`);
    if (!r2Object) throw new Error("Blueprint content not found in R2.");

    let metadata = { ...kvRecord.metadata };
    delete metadata.screenshot;

    return buildBlueprintArchiveStream(metadata, r2Object.body, r2Object.size);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === SITE_LOGO_PATH) {
      return serveSiteLogo(req, env.BLUEPRINT_CONTENT);
    }

    if (url.pathname.startsWith(BLUEPRINT_SCREENSHOT_PATH_PREFIX)) {
      let blueprintId = url.pathname.slice(BLUEPRINT_SCREENSHOT_PATH_PREFIX.length);
      return serveBlueprintScreenshot(env, blueprintId);
    }

    if (url.pathname.startsWith("/native/oauth-start/")) {
      const launchTicket = decodeURIComponent(url.pathname.slice("/native/oauth-start/".length));
      const providerUrl = await nativeBrowserFlows(ctx)
          .get(nativeBrowserFlows(ctx).idFromName(launchTicket))
          .launch(launchTicket);
      return new Response(null, {
        status: 302,
        headers: { Location: providerUrl, "Referrer-Policy": "no-referrer" },
      });
    }

    // Sign-in via authentication gatekeepers happens entirely within each gatekeeper Worker (the
    // OAuth redirect lands on `/gatekeeper/<name>/oauth`); native flows use /native/oauth-start/* as
    // a branded one-time trampoline and return via /native/oauth-return/*. A signed Universal Link
    // opens the app before this request reaches the Worker; unsigned desktop builds land here while
    // the app securely consumes the result through its verifier-bound polling fallback.
    if (url.pathname.startsWith("/native/oauth-return/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Odie OS</title><style>body{box-sizing:border-box;min-height:100vh;margin:0;display:grid;place-items:center;background:#fafafa;color:#202020;font:16px system-ui,sans-serif;text-align:center}.card{max-width:28rem;padding:2rem}h1{margin:.75rem 0;font-size:1.75rem}p{color:#666;line-height:1.5}.mark{color:#f47f53;font-size:2.5rem}</style></head><body><main class="card"><div class="mark">●</div><h1>Sign-in complete</h1><p>Return to Odie OS. The app will continue automatically.</p></main></body></html>`;
      return new Response(req.method === "HEAD" ? null : html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/api/client-errors") {
      return handleClientErrorRequest(req, env, ctx);
    }

    if (url.pathname === "/api") {
      // Make sure the bundled format blueprints are installed. The AdminSettings DO doesn't wake
      // merely because someone deployed, so the install needs a trigger; hanging it off API
      // traffic means a fresh deployment is provisioned by its first visitor. Fire-and-forget,
      // and the DO is idempotent.
      if (!formatBlueprintInstallStarted) {
        formatBlueprintInstallStarted = true;
        ctx.waitUntil(ctx.exports.AdminSettings.getByName(ADMIN_SETTINGS_SINGLETON_NAME)
            .ensureFormatBlueprintsInstalled()
            .then((complete: boolean) => {
              // A partial install resolves rather than throwing, and nothing else will call the DO
              // from here, so clearing this is the whole retry: one bad archive would otherwise
              // leave the deployment half-provisioned for as long as the isolate lives.
              if (!complete) formatBlueprintInstallStarted = false;
            })
            .catch((err: unknown) => {
              // Likewise let the next request try again. The DO coalesces concurrent callers, so a
              // retry costs one comparison once it succeeds.
              formatBlueprintInstallStarted = false;
              logger.warn("failed to install bundled format blueprints", {
                event: "formats.install.trigger.failed", error: err,
              });
            }));
      }

      let accessPayload: JWTPayload | undefined;

      // Preserve Cloudflare Access as defense-in-depth for the browser origin while allowing the
      // separately deployed, route-restricted native gateway to use the API's existing in-band
      // session authority. The backend has no public workers.dev route, so only account-owned service
      // bindings can deliver a request whose URL names the configured native origin.
      if (env.CF_ACCESS_AUD && url.origin !== publicBaseUrl(env).origin) {
        if (req.headers.get("Origin") !== url.origin) {
          return new Response("Cross-origin API access not allowed.", { status: 403 });
        }

        const payload = await verifyCfAccessJwt(req, env);
        if (!payload) return new Response("Invalid CF access JWT.", { status: 403 });

        if (!payload.email) {
          return new Response("Access JWT didn't specify email address.", { status: 403 });
        }

        accessPayload = payload;
      }

      // HACK: Implement `abortSession` callback by closing the websocket.
      // TODO: When ctx.abort() becomes non-experimental, consider using that instead.
      let abortController = new AbortController();
      let abortSession = (reason: Error) => {
        // Closing the socket fails no invocation, so nothing else logs this.
        logger.warn("aborting api session", { event: "session.abort", error: reason });
        abortController.abort(reason);
      };

      return await newWorkersRpcResponse(req,
          new PublicApiImpl(ctx, env, abortSession, accessPayload),
          { abortSignal: abortController.signal });
    }

    return new Response("Not Found", {status: 404});
  }
} satisfies ExportedHandler<Env>;

// Extend Cap'n Web's RpcSessionOptions with an AbortSignal.
//
// TODO: Consider adding this feature to Cap'n Web. However, we might not actually need it for
//   long: ctx.abort() will soon be available non-experimentally, in which case we can just use
//   that instead.
type ExtendedRpcSessionOptions = RpcSessionOptions & {
  // Abort WebSocket sessions when this AbortSignal is aborted. (No effect on HTTP batch sessions.)
  abortSignal: AbortSignal;
};

// Clone of newWorkersRpcResponse() from Cap'n Web, except the `options` has been extended with
// `abortSignal`.
async function newWorkersRpcResponse(
    request: Request, localMain: any, options?: ExtendedRpcSessionOptions) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain, options);
    // Since we're exposing the same API over WebSocket, too, and WebSocket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain, options);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}

function newWorkersWebSocketRpcResponse(
    request: Request, localMain?: any, options?: ExtendedRpcSessionOptions): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
  }

  let pair = new WebSocketPair();
  let server = pair[0];
  server.accept()
  let stub = newWebSocketRpcSession(server, localMain, options);

  // -- ADDED FOR GADGETS --
  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      stub[Symbol.dispose]();
    } else {
      options.abortSignal.addEventListener("abort", () => {
        stub[Symbol.dispose]();
      });
    }
  }
  // -- END ADDED FOR GADGETS --

  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}
