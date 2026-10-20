import { RpcStub } from "capnweb";
import type { ChatReadReceipt, ChatReadState, UnreadStateSubscriber, UserUnreadState } from "@gadgets/workshop-shared/api";
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, RedactedAiModelConfig, ModelKind, modelKind, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, GatekeeperVendorInfo, OutputSummary, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, ConnectFlowStart, validateCommitEmail, NotificationSubscriber, NotificationMute, UserNotification, type DeviceSessionHandoffStart } from '@gadgets/workshop-shared/api';
import { ActionDescription, Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback, ConnectHandoff, SupportedResource, ResourceConfiguratorFrame, AppUiContext, GatekeeperUiFrame, GatekeeperUserSelection, GatekeeperUserSelectionExchange, RedeemedGatekeeperUserSelection } from "@gadgets/workshop-shared/gatekeeper";
import { shouldAutoProvisionAccount, ambientGatekeeperMode } from "./provisioning-policy.js";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  makeUserStorage, type BlueprintUserRecord, type CloudflareBilling, type ConnectedAccountRecord,
  type GadgetRecord, type PendingConnectFlow, type PendingDeviceHandoffRecord,
  type PendingHandoffRecord, type UserAiModelRecord, type UserStorage, type WorkspaceOutputEntry,
  type ChatTimelineHead,
} from "./storage-schema/user-storage.js";
import { recordAnalytics } from "./analytics";
import { createWorkshopLogger } from "./observability";
import { getGatewayModels, type GatewayModels } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { deleteBlueprintContent } from "./blueprint-archive.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import { CONNECT_FLOW_LIFETIME_MS, handoffTargetOrigin, hashPresentedSecret, hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from "./connect-handoff.js";
import { deliver, registerDevice } from "./notification-service.js";
import {
  DEVICE_HANDOFF_LIFETIME_MS, isDeviceHandoffState, sealDeviceSessionHandoff,
  type DeviceSessionCredential, type DeviceSessionHandoff,
} from "./auth/device-session-handoff.js";

const logger = createWorkshopLogger("workshop.user");

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

/** Server-enforced lifetime of a Workshop session issued to a native device. */
export const DEVICE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;

/**
 * How long a user selection ticket (GatekeeperUserSelection) remains
 * redeemable.
 */
export const GATEKEEPER_USER_SELECTION_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
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
type ResourceCreatorStub = Required<Pick<GatekeeperVendor, "createResource">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser, "getSingletonGatekeeperClass" | "startAppUi">>;
type CreationConfiguratorStub = Required<Pick<GatekeeperUser, "startCreationConfigurator">>;

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

/**
 * Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
 * Gateway billing flow is Cloudflare-specific, so several places key off this literal.
 */
export const CLOUDFLARE_VENDOR_ID = "cloudflare";

const withholdSecret = (secret: string) => secret === "" ? "" : null;

/** Withholds the non-empty secrets of `config`, for returning it to a client. */
function redactModelConfig(config: AiModelConfig): RedactedAiModelConfig {
  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: withholdSecret(apiToken),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name, withholdSecret(value)]))}),
  };
}

/**
 * Fills in the `null` secrets of `config` from `source`, throwing if `source` is absent or doesn't
 * hold them. Secrets only carry over to the endpoint they were configured for: otherwise a client
 * could point the model at its own server and receive them.
 */
function resolveWithheldSecrets(
    config: RedactedAiModelConfig, source?: AiModelConfig): AiModelConfig {
  let resolve = (secret: string | null, stored: string | undefined, what: string) => {
    if (secret !== null) return secret;
    if (!source) {
      throw new Error(`A value for ${what} is required.`);
    }
    if (source.provider !== config.provider || (source.apiUrl ?? "") !== (config.apiUrl ?? "")) {
      throw new Error(`Please re-enter ${what}, since the provider or API URL changed.`);
    }
    if (stored === undefined) {
      throw new Error(`There is no stored ${what} to keep.`);
    }
    return stored;
  };

  let storedHeader = (name: string) => source?.extraHeaders && Object.hasOwn(source.extraHeaders, name)
      ? source.extraHeaders[name] : undefined;

  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: resolve(apiToken, source?.apiToken, "the API token"),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) =>
            [name, resolve(value, storedHeader(name), `the value of header "${name}"`)]))}),
  };
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
}

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

type ChatReadCursor = NonNullable<ReturnType<UserStorage["chatReadCursors"]["get"]>>;

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

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  #notificationSubscribers = new Map<object, RpcStub<NotificationSubscriber>>();
  #unreadSubscribers = new Map<object, RpcStub<UnreadStateSubscriber>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeUserStorage(ctx.storage);
    for (let cursor of this.storage.chatReadCursors.list()) {
      // Internal prototype rows retain their horizons; only their missing derived count is dirty.
      if (cursor.unreadCount === undefined) this.storage.chatReadCursors.put({
        workspaceId: cursor.workspaceId, chatId: cursor.chatId,
        readThroughSequence: cursor.readThroughSequence, unreadCount: 0,
        notifiedThroughSequence: -1, unreadDirty: true, notificationsDirty: true,
      });
    }
    for (let cursor of this.storage.chatReadCursors.list()) {
      this.#readCursors.set(`${cursor.workspaceId}:${cursor.chatId}`, cursor);
    }
    this.storage.chatReadCursors.subscribe({
      add: cursor => { this.#readCursors.set(`${cursor.workspaceId}:${cursor.chatId}`, cursor); },
      update: (_old, cursor) => { this.#readCursors.set(`${cursor.workspaceId}:${cursor.chatId}`, cursor); },
      remove: cursor => { this.#readCursors.delete(`${cursor.workspaceId}:${cursor.chatId}`); },
    });
    for (let listing of this.storage.gadgets.list()) {
      if (listing.role !== "use") this.#unreadWorkspaces.add(listing.id);
    }
    this.storage.gadgets.subscribe({
      add: listing => { if (listing.role !== "use") this.#unreadWorkspaces.add(listing.id); },
      update: (_old, listing) => {
        if (listing.role === "use") this.#unreadWorkspaces.delete(listing.id);
        else this.#unreadWorkspaces.add(listing.id);
      },
      remove: listing => { this.#unreadWorkspaces.delete(listing.id); },
    });
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.vendors = buildGatekeeperVendorMap(env);
    if ([...this.#readCursors.values()].some(cursor => cursor.unreadDirty || cursor.notificationsDirty)) {
      this.ctx.waitUntil((async () => {
        if (await this.ctx.storage.getAlarm() === null) await this.#armExpirySweep();
        await this.#recoverUnread();
      })().catch(error => {
        logger.warn("unread recovery deferred", {event: "chat.unread.recovery.deferred", error});
      }));
    }
  }

  // Mirrors the profile into the deployment-wide user directory. Best-effort
  // and does not block the caller. The `syncUser` call opens this DO's input
  // gate, so a rename can start a second sync while one is in flight, and the
  // two can reach the directory in either order. Each sync carries its
  // `profileRev` and the directory keeps the highest, so no ordering is needed
  // here. The revision counter only increases, and a failed sync leaves it
  // behind so the next authentication retries.
  #syncDirectory(): void {
    const rev = this.storage.profileRev.get();
    if (rev === this.storage.directoryRev.get()) return;
    const profile = this.storage.profile.get();
    this.ctx.exports.UserDirectoryDurableObject.getByName("")
        .syncUser({ id: profile.id, name: profile.name }, rev)
        .then(() => {
          if (rev > this.storage.directoryRev.get()) this.storage.directoryRev.put(rev);
        }, (error: unknown) => {
          logger.warn("failed to sync user directory record", {
            event: "user.directory.sync.failed",
            error,
          });
        });
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
    const now = Date.now();
    if ((session.expiresAt && session.expiresAt.getTime() <= now) ||
        (session.pendingUntil && session.pendingUntil.getTime() <= now)) {
      this.storage.sessions.delete(tokenId);
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (session.pendingUntil) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    this.#syncDirectory();
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    const isNew = !this.storage.created.get();
    if (isNew) {
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
    }
    this.#syncDirectory();
    return isNew;
  }

  async #newSessionToken(options: { expiresAt?: Date; pendingUntil?: Date } = {}): Promise<string> {
    let { secret, hash: tokenId } = await newSecretToken();
    this.storage.sessions.put({ tokenId, created: new Date(), ...options });
    return secret.toBase64();
  }

  /**
   * Stage an idempotent, single-use transfer without returning encrypted credentials to page
   * JavaScript. A Workshop session remains inactive until the HTTPS callback consumes the record;
   * an Access token is already bounded by its JWT expiry and is stored only inside `handoff`.
   */
  async stageDeviceSessionHandoff(publicKey: string, state: string, accessJwt?: string)
      : Promise<DeviceSessionHandoffStart> {
    if (!this.storage.created.get()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (!isDeviceHandoffState(state)) throw new Error("Invalid device sign-in state.");
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const existing = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.publicKey !== publicKey) {
        throw new Error("This device sign-in state is already bound to another key.");
      }
      // Reissue only the one-use ticket; a retry must not mint another credential or session.
      const { secret, hash: ticketHash } = await newSecretToken();
      this.storage.pendingDeviceHandoffs.put({ ...existing, ticketHash });
      return { userDoId: this.ctx.id.toString(), ticket: secret.toHex() };
    }
    if (existing) this.#dropPendingDeviceHandoff(existing);

    const { secret: ticket, hash: ticketHash } = await newSecretToken();
    const now = Date.now();
    const handoffExpiresAt = now + DEVICE_HANDOFF_LIFETIME_MS;
    let credential: DeviceSessionCredential;
    let sessionTokenId: string | undefined;
    let deviceSessionExpiresAt: number | undefined;
    if (accessJwt) {
      credential = { kind: "cloudflare-access", token: accessJwt };
    } else {
      const { secret, hash } = await newSecretToken();
      sessionTokenId = hash;
      deviceSessionExpiresAt = now + DEVICE_SESSION_LIFETIME_MS;
      credential = {
        kind: "workshop",
        token: `${this.storage.profile.get().id}:${secret.toBase64()}`,
        expiresAt: deviceSessionExpiresAt,
      };
    }
    const handoff = await sealDeviceSessionHandoff(
        publicKey, state, credential, handoffExpiresAt);
    if (sessionTokenId && deviceSessionExpiresAt) {
      this.storage.sessions.put({
        tokenId: sessionTokenId,
        created: new Date(now),
        expiresAt: new Date(deviceSessionExpiresAt),
        pendingUntil: new Date(handoffExpiresAt),
      });
    }
    this.storage.pendingDeviceHandoffs.put({
      stateHash,
      ticketHash,
      publicKey,
      handoff,
      expiresAt: new Date(handoffExpiresAt),
      sessionTokenId,
    });
    await this.#armExpirySweep();
    logger.info("device session handoff staged", {
      event: "auth.device_handoff.staged",
      credentialKind: credential.kind,
    });
    return { userDoId: this.ctx.id.toString(), ticket: ticket.toHex() };
  }

  /** Consume a staged handoff once and activate its pending Workshop device session, if any. */
  async consumeDeviceSessionHandoff(state: string, ticket: string): Promise<DeviceSessionHandoff | null> {
    if (!isDeviceHandoffState(state)) return null;
    const presentedHash = hashPresentedSecret(ticket);
    if (!presentedHash) return null;
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const pending = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
      this.#dropPendingDeviceHandoff(pending);
      await this.#armExpirySweep();
      return null;
    }
    if (pending.ticketHash !== await presentedHash) return null;
    this.storage.pendingDeviceHandoffs.delete(stateHash);
    if (pending.sessionTokenId) {
      const session = this.storage.sessions.get(pending.sessionTokenId);
      if (!session || !session.pendingUntil || session.pendingUntil.getTime() <= Date.now()) {
        if (session) this.storage.sessions.delete(pending.sessionTokenId);
        await this.#armExpirySweep();
        return null;
      }
      const { pendingUntil: _pendingUntil, ...active } = session;
      this.storage.sessions.put(active);
    }
    await this.#armExpirySweep();
    logger.info("device session handoff consumed", {
      event: "auth.device_handoff.consumed",
      credentialKind: pending.sessionTokenId ? "workshop" : "cloudflare-access",
    });
    return pending.handoff;
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
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: this.ctx.id.toString(),
        source: "gatekeeper",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: this.ctx.id.toString(),
      source: "gatekeeper",
    });
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  /** Exchange the native app's one-time device registration for that device's push subscription. */
  async registerNotificationDevice(deviceRegistrationId: string): Promise<void> {
    let { deviceKey, subscriptionId } = await registerDevice(this.env, deviceRegistrationId);
    this.storage.notificationSubscriptions.put(
        { ...this.storage.notificationSubscriptions.get(), [deviceKey]: subscriptionId });
  }

  /** Subscribe an authenticated client, including background listeners, to live notifications. */
  async subscribeToNotifications(
      subscriber: RpcStub<NotificationSubscriber>): Promise<RpcStub<{}>> {
    subscriber = subscriber.dup();
    let token = {};
    this.#notificationSubscribers.set(token, subscriber);
    let unsubscribe = () => {
      let existing = this.#notificationSubscribers.get(token);
      if (!existing) return;
      this.#notificationSubscribers.delete(token);
      existing[Symbol.dispose]();
    };
    subscriber.onRpcBroken(unsubscribe);
    return new RpcStub<{}>({ [Symbol.dispose]: unsubscribe });
  }

  /** See `AuthenticatedApi.setWorkspaceNotificationMute()`. */
  async setWorkspaceNotificationMute(workspaceId: string, mute: NotificationMute | null)
      : Promise<void> {
    let record = this.storage.gadgets.get(workspaceId);
    if (!record) throw new Error("No such workspace belonging to user.");
    record.notificationMute = mute ?? undefined;
    this.storage.gadgets.put(record);
  }

  // Null hides metadata/counts while observer admission is denied, without forgetting the listing.
  #chatHeads = new Map<string, Map<number, ChatTimelineHead> | null>();
  #readCursors = new Map<string, ChatReadCursor>();
  #readTokens = new Map<string, string>();
  #unreadWorkspaces = new Set<string>();
  #unavailableWorkspaces = new Set<string>();
  #chatWork = new Map<string, Promise<void>>();
  #notificationWork = new Map<string, Promise<void>>();
  #dirtyTokens = new Map<string, object>();

  #cursor(workspaceId: string, chatId: number): ChatReadCursor {
    return this.#readCursors.get(`${workspaceId}:${chatId}`) ??
      {workspaceId, chatId, readThroughSequence: -1, unreadCount: 0, notifiedThroughSequence: -1};
  }

  #storeCursor(cursor: ChatReadCursor): boolean {
    let old = this.#readCursors.get(`${cursor.workspaceId}:${cursor.chatId}`);
    if (old && old.readThroughSequence === cursor.readThroughSequence &&
        old.unreadCount === cursor.unreadCount &&
        old.notifiedThroughSequence === cursor.notifiedThroughSequence &&
        old.unreadDirty === cursor.unreadDirty && old.notificationsDirty === cursor.notificationsDirty) return false;
    this.storage.chatReadCursors.put(cursor);
    return true;
  }

  #workspace(workspaceId: string) {
    return this.ctx.exports.OverseerDurableObject.get(
      this.ctx.exports.OverseerDurableObject.idFromString(workspaceId));
  }

  #hasWorkspace(workspaceId: string): boolean {
    return this.#unreadWorkspaces.has(workspaceId);
  }

  // Only serializes concurrent calculations. Durable dirty bits, not these promises, recover work.
  async #serialize(work: Map<string, Promise<void>>, key: string, operation: () => Promise<void>) {
    let previous = work.get(key) ?? Promise.resolve();
    let current = previous.catch(() => {}).then(operation);
    work.set(key, current);
    try { await current; }
    finally { if (work.get(key) === current) work.delete(key); }
  }

  async #chatState(cursor: ChatReadCursor) {
    return this.#workspace(cursor.workspaceId).getChatStateForUser(
      this.ctx.id.toString(), this.storage.profile.get().id, cursor.chatId,
      cursor.readThroughSequence, cursor.notifiedThroughSequence);
  }

  #unreadCounts() {
    let unreadChatCount = 0, unreadMessageCount = 0;
    for (let cursor of this.#readCursors.values()) {
      if (!this.#hasWorkspace(cursor.workspaceId) || this.#chatHeads.get(cursor.workspaceId) === null) continue;
      unreadMessageCount += cursor.unreadCount;
      if (cursor.unreadCount > 0) unreadChatCount++;
    }
    return {unreadChatCount, unreadMessageCount};
  }

  #unreadSnapshot(): UserUnreadState {
    let chats: ChatReadState[] = [];
    for (let [workspaceId, heads] of this.#chatHeads) {
      if (!this.#hasWorkspace(workspaceId) || !heads) continue;
      for (let head of heads.values()) {
        chats.push(this.#readState(workspaceId, head));
      }
    }
    return {...this.#unreadCounts(), chats,
      ...(this.#unavailableWorkspaces.size ? {unavailableWorkspaceIds: [...this.#unavailableWorkspaces]} : {})};
  }

  #readState(workspaceId: string, head: ChatTimelineHead): ChatReadState {
    let key = `${workspaceId}:${head.chatId}`;
    let cursor = this.#cursor(workspaceId, head.chatId);
    let readToken = this.#readTokens.get(key);
    if (!readToken) this.#readTokens.set(key, readToken = crypto.randomUUID());
    return {...head, workspaceId, readThroughSequence: cursor.readThroughSequence,
      unreadMessageCount: cursor.unreadCount, readToken};
  }

  #denyUnreadWorkspace(workspaceId: string): void {
    let changed = this.#chatHeads.get(workspaceId) !== null;
    this.#chatHeads.set(workspaceId, null);
    let wasUnavailable = this.#unavailableWorkspaces.delete(workspaceId);
    if (changed || wasUnavailable) this.#unreadChanged();
  }

  async #refreshUnreadWorkspace(workspaceId: string, persistBaseline = false): Promise<void> {
    try {
      let previousHeads = this.#chatHeads.get(workspaceId);
      let heads = await this.#workspace(workspaceId).getChatHeadsForUser(
          this.ctx.id.toString(), this.storage.profile.get().id);
      if (!this.#hasWorkspace(workspaceId)) return;
      if (heads === null) {
        // Preserve both the listing and private horizons. New arrivals must still journal work.
        this.#denyUnreadWorkspace(workspaceId);
        return;
      }
      this.#chatHeads.set(workspaceId, new Map(heads.map(head => [head.chatId, head])));
      await Promise.all(heads.map(async head => {
        let key = `${workspaceId}:${head.chatId}`;
        let existing = this.#readCursors.get(key);
        if (existing) {
          if (persistBaseline && !this.storage.chatReadCursors.get(key)) {
            this.storage.chatReadCursors.put(existing);
          }
          if (existing.unreadDirty) await this.#serialize(this.#chatWork, key,
            () => this.#reconcileChat(workspaceId, head.chatId));
          return;
        }
        let cursor = this.#cursor(workspaceId, head.chatId);
        let state = await this.#chatState(cursor);
        if (!this.#hasWorkspace(workspaceId)) return;
        if (state === "denied") { this.#denyUnreadWorkspace(workspaceId); return; }
        if (!state || this.#readCursors.has(key)) return;
        // Explicit admission establishes a durable alert baseline, even without unread consumers.
        // Ordinary snapshot reads keep new counts in memory only.
        let baseline = {...cursor, unreadCount: state.unreadCount,
          notifiedThroughSequence: state.notifications.at(-1)?.sequence ?? -1};
        if (persistBaseline) this.#storeCursor(baseline);
        else this.#readCursors.set(key, baseline);
      }));
      this.#unavailableWorkspaces.delete(workspaceId);
      if (!previousHeads && this.#chatHeads.get(workspaceId)) this.#unreadChanged();
    } catch {
      if (this.#hasWorkspace(workspaceId)) this.#unavailableWorkspaces.add(workspaceId);
    }
  }

  /** Persisted counts hydrate locally; clean cursors never require a recount. */
  async getUnreadState(): Promise<UserUnreadState> {
    await Promise.all([...this.#unreadWorkspaces].map(workspaceId => this.#refreshUnreadWorkspace(workspaceId)));
    return this.#unreadSnapshot();
  }

  async subscribeToUnreadState(subscriber: RpcStub<UnreadStateSubscriber>): Promise<RpcStub<{}>> {
    await this.getUnreadState();
    subscriber = subscriber.dup();
    let token = {};
    this.#unreadSubscribers.set(token, subscriber);
    let unsubscribe = () => {
      let existing = this.#unreadSubscribers.get(token);
      if (existing) { this.#unreadSubscribers.delete(token); existing[Symbol.dispose](); }
    };
    subscriber.onRpcBroken(unsubscribe);
    this.ctx.waitUntil(subscriber.updated(this.#unreadSnapshot()).catch(unsubscribe));
    return new RpcStub<{}>({[Symbol.dispose]: unsubscribe});
  }

  #unreadChanged(workspaceId?: string, chatId?: number): void {
    let head = workspaceId === undefined || chatId === undefined ? undefined :
      this.#chatHeads.get(workspaceId)?.get(chatId);
    let chat = head ? this.#readState(workspaceId!, head) : null;
    for (let [token, subscriber] of this.#unreadSubscribers) {
      let update = workspaceId !== undefined && chatId !== undefined
        ? subscriber.chatUpdated(workspaceId, chatId, chat, this.#unreadCounts())
        : subscriber.updated(this.#unreadSnapshot());
      this.ctx.waitUntil(update.catch(() => {
        this.#unreadSubscribers.delete(token);
        subscriber[Symbol.dispose]();
      }));
    }
  }

  /** Journal before ACK; reconcile admitted threads and retain denied work for re-admission. */
  async messageArrived(workspaceId: string, chatId: number): Promise<void> {
    if (!this.#hasWorkspace(workspaceId)) return;
    let key = `${workspaceId}:${chatId}`;
    this.#dirtyTokens.set(key, {});
    let cursor = this.#cursor(workspaceId, chatId);
    if (!cursor.unreadDirty || !cursor.notificationsDirty) {
      this.#storeCursor({...cursor, unreadDirty: true, notificationsDirty: true});
    }
    await this.#armExpirySweep();
    await this.#serialize(this.#chatWork, key, () => this.#reconcileChat(workspaceId, chatId));
    this.ctx.waitUntil(this.#deliverChatNotifications(workspaceId, chatId).catch(error => {
      logger.warn("notification catch-up deferred", {event: "notification.catchup.deferred", error});
    }));
  }

  async #reconcileChat(workspaceId: string, chatId: number): Promise<void> {
    if (!this.#hasWorkspace(workspaceId)) return;
    let key = `${workspaceId}:${chatId}`;
    let token = this.#dirtyTokens.get(key);
    let cursor = this.#cursor(workspaceId, chatId);
    let state = await this.#chatState(cursor);
    if (!this.#hasWorkspace(workspaceId)) return;
    if (state === "denied") { this.#denyUnreadWorkspace(workspaceId); return; }
    if (!state) { this.#forgetChat(workspaceId, chatId); return; }
    let heads = this.#chatHeads.get(workspaceId) ?? new Map<number, ChatTimelineHead>();
    let previousHead = heads.get(chatId);
    heads.set(chatId, state.head);
    this.#chatHeads.set(workspaceId, heads);
    let current = this.#cursor(workspaceId, chatId);
    this.#storeCursor({...current, unreadCount: state.unreadCount,
      unreadDirty: this.#dirtyTokens.get(key) === token ? undefined : true});
    if (current.unreadCount !== state.unreadCount || !previousHead ||
        previousHead.latestSequence !== state.head.latestSequence ||
        previousHead.chatTitle !== state.head.chatTitle ||
        previousHead.latestMessagePreview !== state.head.latestMessagePreview) {
      this.#unreadChanged(workspaceId, chatId);
    }
  }

  /** Advance only the observed horizon/token, including across a read/unread/read ABA cycle. */
  async markChatRead(receipt: ChatReadReceipt): Promise<void> {
    await this.markChatsRead([receipt]);
  }

  async markChatsRead(receipts: ChatReadReceipt[]): Promise<void> {
    let results = await Promise.allSettled(receipts.map(receipt =>
      this.#setReadHorizon(receipt.workspaceId, receipt.chatId, receipt.throughSequence,
        receipt.readThroughSequence, false, receipt.readToken)));
    for (let result of results) if (result.status === "rejected") throw result.reason;
  }

  async markChatUnread(workspaceId: string, chatId: number, fromSequence: number,
      readThroughSequence: number, readToken: string): Promise<void> {
    await this.#setReadHorizon(workspaceId, chatId, fromSequence - 1, readThroughSequence, true, readToken);
  }

  async #setReadHorizon(workspaceId: string, chatId: number, through: number,
      observed: number, rewind: boolean, readToken: string): Promise<void> {
    if (!Number.isSafeInteger(through) || through < -1) throw new Error("Invalid timeline sequence.");
    await this.#serialize(this.#chatWork, `${workspaceId}:${chatId}`, async () => {
      if (!this.#hasWorkspace(workspaceId)) return;
      let cursor = this.#cursor(workspaceId, chatId);
      if (!readToken || readToken !== this.#readTokens.get(`${workspaceId}:${chatId}`)) return;
      if (cursor.readThroughSequence !== observed || through === cursor.readThroughSequence ||
          (!rewind && through < cursor.readThroughSequence)) return;
      let state = await this.#chatState({...cursor, readThroughSequence: through});
      if (!this.#hasWorkspace(workspaceId)) return;
      if (state === "denied") { this.#denyUnreadWorkspace(workspaceId); return; }
      if (!state) return;
      if (through > state.head.latestSequence) throw new Error("Invalid timeline sequence.");
      // Fetching the count performs no effects. Commit the new horizon and its count together.
      let current = this.#cursor(workspaceId, chatId);
      this.#storeCursor({...current, readThroughSequence: through,
        unreadCount: state.unreadCount});
      this.#readTokens.delete(`${workspaceId}:${chatId}`);
      let heads = this.#chatHeads.get(workspaceId) ?? new Map<number, ChatTimelineHead>();
      heads.set(chatId, state.head);
      this.#chatHeads.set(workspaceId, heads);
      this.#unreadChanged(workspaceId, chatId);
    });
  }

  async #deliverChatNotifications(workspaceId: string, chatId: number): Promise<void> {
    await this.#serialize(this.#notificationWork, `${workspaceId}:${chatId}`, async () => {
      while (this.#hasWorkspace(workspaceId)) {
        let key = `${workspaceId}:${chatId}`;
        let token = this.#dirtyTokens.get(key);
        let cursor = this.#cursor(workspaceId, chatId);
        if (!cursor.notificationsDirty) return;
        let state = await this.#chatState(cursor);
        if (!this.#hasWorkspace(workspaceId)) return;
        if (state === "denied") { this.#denyUnreadWorkspace(workspaceId); return; }
        if (!state) { this.#forgetChat(workspaceId, chatId); return; }
        for (let candidate of state.notifications) {
          if (!this.#readCursors.has(key)) return;
          await this.publishNotification({
            id: candidate.id,
            kind: candidate.kind, workspaceId, chatId, chatTitle: state.head.chatTitle,
          });
          let current = this.#readCursors.get(key);
          if (!current) return;
          this.#storeCursor({...current,
            notifiedThroughSequence: Math.max(current.notifiedThroughSequence, candidate.sequence)});
        }
        // A newly dirtied thread needs another source read, even if this batch was empty.
        if (this.#dirtyTokens.get(key) !== token) continue;
        let current = this.#readCursors.get(key);
        if (current?.notificationsDirty) {
          this.#storeCursor({...current, notificationsDirty: undefined});
        }
        await this.#armExpirySweep();
        return;
      }
    });
  }

  async #recoverUnread(workspaceId?: string): Promise<void> {
    let results = await Promise.allSettled([...this.#readCursors.values()]
      .filter(cursor => workspaceId === undefined || cursor.workspaceId === workspaceId).map(async cursor => {
      if (cursor.unreadDirty) await this.#serialize(this.#chatWork,
        `${cursor.workspaceId}:${cursor.chatId}`,
        () => this.#reconcileChat(cursor.workspaceId, cursor.chatId));
      if (cursor.notificationsDirty) await this.#deliverChatNotifications(cursor.workspaceId, cursor.chatId);
    }));
    await this.#armExpirySweep();
    for (let result of results) if (result.status === "rejected") throw result.reason;
  }

  #forgetChat(workspaceId: string, chatId: number): void {
    let key = `${workspaceId}:${chatId}`;
    if (!this.#readCursors.has(key)) return;
    this.storage.chatReadCursors.delete(key);
    this.#readCursors.delete(key);
    this.#readTokens.delete(key);
    this.#chatHeads.get(workspaceId)?.delete(chatId);
    this.#unreadChanged(workspaceId, chatId);
  }

  /** Journal removal before the source is destroyed; recount only after releasing the RPC. */
  async workspaceRemoved(workspaceId: string): Promise<void> {
    for (let cursor of this.#readCursors.values()) {
      if (cursor.workspaceId !== workspaceId) continue;
      this.#dirtyTokens.set(`${workspaceId}:${cursor.chatId}`, {});
      this.#storeCursor({...cursor, unreadDirty: true, notificationsDirty: true});
    }
    await this.#armExpirySweep();
    this.ctx.waitUntil(this.#recoverUnread().catch(error => {
      logger.warn("workspace unread cleanup deferred", {event: "chat.unread.cleanup.deferred", error});
    }));
  }

  #forgetUnreadWorkspace(workspaceId: string): void {
    let cursors = [...this.#readCursors.values()].filter(cursor => cursor.workspaceId === workspaceId);
    if (cursors.length) this.storage.chatReadCursors.byWorkspace.delete(workspaceId);
    for (let cursor of cursors) {
      let key = `${workspaceId}:${cursor.chatId}`;
      this.#readCursors.delete(key);
      this.#readTokens.delete(key);
    }
    let hadHeads = this.#chatHeads.delete(workspaceId);
    let wasUnavailable = this.#unavailableWorkspaces.delete(workspaceId);
    if (cursors.length || hadHeads || wasUnavailable) this.#unreadChanged();
  }

  /**
   * Offer a notification to visible clients, otherwise use push. The caller advances its
   * notifiedThroughSequence only once this delivery succeeds or policy intentionally skips it.
   */
  async publishNotification(notification: UserNotification): Promise<void> {
    let mute = this.storage.gadgets.get(notification.workspaceId)?.notificationMute;
    if (notification.kind === "taskCompleted" && mute &&
        ("indefinite" in mute || mute.until.getTime() > Date.now())) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = await Promise.race([
      Promise.any([...this.#notificationSubscribers.values()]
          .map(subscriber => subscriber.notify(notification))).then(() => true, () => false),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 3_000); }),
    ]).finally(() => clearTimeout(timeout));
    if (acknowledged) return;
    let subscriptions = Object.entries(this.storage.notificationSubscriptions.get());
    let results = await Promise.allSettled(subscriptions.map(async ([deviceKey, subscriptionId]) => {
      if (await deliver(this.env, subscriptionId, notification)) return;
      // This subscription is dead; the device gets a new one when its app next opens. Keep one it
      // registered while this delivery was in flight.
      let { [deviceKey]: current, ...others } = this.storage.notificationSubscriptions.get();
      if (current === subscriptionId) this.storage.notificationSubscriptions.put(others);
    }));
    for (let result of results) {
      if (result.status === "rejected") throw result.reason;
    }
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
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole
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
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        created: now,
        lastActive: now,
      });
    }
    if (role === "use") this.#forgetUnreadWorkspace(gadgetId);
    else {
      await this.#refreshUnreadWorkspace(gadgetId, true);
      this.ctx.waitUntil(this.#recoverUnread(gadgetId).catch(error => {
        logger.warn("unread recovery deferred", {event: "chat.unread.recovery.deferred", error});
      }));
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
    if (role === "use") this.#forgetUnreadWorkspace(gadgetId);
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
      this.#forgetUnreadWorkspace(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
    this.storage.profileRev.put(this.storage.profileRev.get() + 1);
    this.#syncDirectory();
  }

  async setOwnCommitEmail(email: string | null): Promise<void> {
    let profile = this.storage.profile.get();
    if (email === null) {
      delete profile.commitEmail;
    } else {
      validateCommitEmail(email);
      profile.commitEmail = email;
    }
    this.storage.profile.put(profile);
  }

  async listModels(kind: ModelKind = "language"): Promise<AiChatAuthorInfo[]> {
    return this.#listModels(await getGatewayModels(this.env), kind);
  }

  #listModels(models: GatewayModels | null, kind: ModelKind): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];

    // When AI Gateway mode is active, include the gateway models the deployment offers.
    if (models) {
      result.push(...models.list(kind));
    }

    // Also include user-configured models, where users may add their own, skipping any that a
    // gateway model shadows, whatever its mode (see #resolveModel()).
    if (models && !models.userModels) return result;
    for (let model of this.storage.aiModels.list()) {
      if (!models?.get(model.profile.id) &&
          modelKind(model.config.provider, model.config.model) === kind) {
        result.push(model.profile);
      }
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig,
                 copySecretsFrom?: string): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let source: AiModelConfig | undefined;
    if (copySecretsFrom !== undefined) {
      source = this.#getHandAddedModel(copySecretsFrom, models).config;
    }
    // A gateway model, whatever its mode, would shadow the new model and leave it unreachable.
    if (this.storage.aiModels.get(profile.id) || models?.get(profile.id)) {
      throw new Error(`A model with ID "${profile.id}" already exists.`);
    }
    this.#putModel(profile, resolveWithheldSecrets(config, source), models);
  }

  async getModelConfig(id: string): Promise<{profile: AiChatAuthorInfo, config: RedactedAiModelConfig}> {
    let {profile, config} = this.#getHandAddedModel(id, await getGatewayModels(this.env));
    return {profile, config: redactModelConfig(config)};
  }

  async updateModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let stored = this.#getHandAddedModel(profile.id, models).config;
    if (config.provider !== stored.provider || config.model !== stored.model) {
      throw new Error("A model's provider and model ID can't be changed.");
    }
    this.#putModel(profile, resolveWithheldSecrets(config, stored), models);
  }

  /** The stored record of a model the user added, throwing for AI Gateway models. */
  #getHandAddedModel(id: string, models: GatewayModels | null): UserAiModelRecord {
    let record = this.storage.aiModels.get(id);
    // A stored model sharing a gateway model's ID is shadowed by it (see listModels()).
    if (!record || models?.get(id)) {
      throw new Error(`No such hand-added model: ${id}`);
    }
    return record;
  }

  #putModel(profile: AiChatAuthorInfo, config: AiModelConfig, models: GatewayModels | null) {
    if (models && !models.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }
    for (let limit of [config.contextWindow, config.outputLimit]) {
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
        throw new Error("Token limits must be positive integers.");
      }
    }

    // capnweb-validate lets through properties that RedactedAiModelConfig omits, and these are a
    // deployment's to set on its own models.
    let {reasoning, compactionInputBudget, behavesLike, capabilities, ...own} = config;

    profile.type = "agent";
    this.storage.aiModels.put({profile, config: own});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting the gateway's own models, whatever their mode.
    let model = (await getGatewayModels(this.env))?.get(id);
    if (model) throw new Error(`Cannot delete built-in model "${model.name}".`);

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.storage.aiModels.get(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Any model that resolves is accepted, hidden ones included (see getExternalMessageChatContext()).
      if (!this.#resolveModel(id, await getGatewayModels(this.env))) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
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
    return this.#getChatContext(modelId, await getGatewayModels(this.env));
  }

  #getChatContext(modelId: string | null, models: GatewayModels | null): UserChatContext {
    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = this.#resolveModel(modelId, models);
      if (!result.aiModel) {
        models?.refuseDisabled(modelId);
        // No gateway model has the ID, so a stored model with it is one the deployment keeps
        // users from running.
        let stored = this.storage.aiModels.get(modelId);
        if (stored) models?.refuseUserModel(stored.profile.name);
        throw new Error(`No such model: ${modelId}`);
      }
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (models) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = models.gateway.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.storage.aiModels.get(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }
    return result;
  }

  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    // An existing chat keeps its model while it still resolves, even once no longer offered. A new
    // conversation takes the user's preferred model only while it is still offered, as the web
    // composer does with its stored choice, and otherwise the first available model.
    let models = await getGatewayModels(this.env);
    let selectedModelId = existingChatModelId;
    if (selectedModelId === null || !this.#resolveModel(selectedModelId, models)) {
      let offered = this.#listModels(models, "language");
      let preferredModel = this.storage.preferredModel.get();
      selectedModelId = (offered.find(model => model.id === preferredModel) ?? offered[0])?.id ?? null;
    }

    return this.#getChatContext(selectedModelId, models);
  }

  /**
   * Resolve a model ID the way chats do: a gateway model shadows a stored model with the same ID
   * whatever its mode, so a disabled one resolves to nothing rather than to the stored model. No
   * stored model resolves on a gateway deployment whose users may not add their own.
   */
  #resolveModel(id: string, models: GatewayModels | null): UserAiModelRecord | undefined {
    if (models?.get(id)) return models.resolve(id);
    return models && !models.userModels ? undefined : this.storage.aiModels.get(id);
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

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }

  async ensureGadgetRegistered(id: string, title: string): Promise<void> {
    if (this.storage.gadgets.get(id)) return;
    await this.newGadget(id, title);
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
    this.#forgetUnreadWorkspace(id);
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

    if (kvRecord) {
      if (kvRecord.ownerId !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      await deleteBlueprintContent(this.env, id);
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

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

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<ConnectFlowStart> {
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

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback, {resourceUrlPatterns});
    let nonce = await this.openConnectFlow(accountId);
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return { url, nonce };
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

  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
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
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      // A "disabled" ambient gatekeeper's account stays dormant: don't surface its singleton capsule
      // or management UI. (Its data is preserved, so re-enabling restores it.)
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      result.push({ accountId: rec.id, vendorId: rec.vendorId, description: rec.description });
    }
    return result;
  }

  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   */
  async getSingletonGatekeeperClass(accountId: number)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    return (record.account as unknown as SingletonAccountStub).getSingletonGatekeeperClass();
  }

  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is supplied
   * fresh by the caller so admin-gated features reflect the user's current status.
   */
  async startAccountAppUi(
      accountId: number, options: Pick<AppUiContext, "isAdmin">,
  ): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    let userSelectionExchange = this.ctx.exports.GatekeeperUserSelectionExchangeImpl({
      props: { selectorUserId: this.ctx.id.toString(), appAccountId: accountId },
    });
    return (record.account as unknown as SingletonAccountStub)
        .startAppUi({ isAdmin: options.isAdmin, userSelectionExchange });
  }

  // The account record behind one of this user's gatekeeper apps, or undefined
  // if `accountId` is not a UI-providing account the deployment currently
  // offers (the same test listProvidedAccounts applies, since a "disabled"
  // ambient gatekeeper's account stays dormant).
  async #uiAccountRecord(accountId: number): Promise<ConnectedAccountRecord | undefined> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) return undefined;
    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(record.vendorId)) return undefined;
    if (record.autoProvisioned) {
      if (ambientGatekeeperMode(config, record.vendorId) === "disabled") return undefined;
    }
    return record;
  }

  /**
   * Mint a single-use ticket for a user selected on behalf of a gatekeeper app,
   * redeemable through that gatekeeper app's exchange capability (see
   * GatekeeperUserSelectionExchangeImpl). Returns null if the selected user is
   * this user or does not exist. Self-selection uses stable DO identity because
   * ctx.id.name may be absent after a cold start through idFromString().
   */
  async createGatekeeperUserSelection(
      appAccountId: number, selectedUserId: string,
  ): Promise<GatekeeperUserSelection | null> {
    let app = await this.#uiAccountRecord(appAccountId);
    if (!app) throw new Error("No such app.");
    let selectedId = this.ctx.exports.UserDurableObject.idFromName(selectedUserId);
    if (this.ctx.id.equals(selectedId)) return null;
    let selectedProfile = await this.ctx.exports.UserDurableObject.get(selectedId).whoamiIfExists();
    if (!selectedProfile) return null;
    let profile = { displayName: selectedProfile.name };
    let { secret, hash: ticketHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + GATEKEEPER_USER_SELECTION_LIFETIME_MS);
    this.storage.pendingUserSelections.put({
      ticketHash, appAccountId, vendorId: app.vendorId, selectedUserId, expiresAt,
    });
    await this.#armExpirySweep();
    return { ticket: secret.toHex(), profile };
  }

  /**
   * Redeem a ticket returned from createGatekeeperUserSelection. A ticket can
   * only be redeemed once by the gatekeeper app account that minted it. A
   * ticket minted for a different gatekeeper app account is refused without
   * being spent, so a later valid exchange can still redeem it. Returns all of
   * the selected user's eligible same-vendor accounts. The gatekeeper handles
   * zero or multiple results. A ticket represents a Workshop user, not a
   * connected account, so a 1:1 mapping with a connected account is not
   * guaranteed.
   */
  async redeemGatekeeperUserSelection(
      appAccountId: number, ticket: string,
  ): Promise<RedeemedGatekeeperUserSelection[]> {
    let ticketHash = await hashPresentedSecret(ticket);
    let record = ticketHash === undefined
        ? undefined : this.storage.pendingUserSelections.get(ticketHash);
    if (!record || record.appAccountId !== appAccountId) {
      throw new Error("This selection has expired. Please select the user again.");
    }
    this.storage.pendingUserSelections.delete(record.ticketHash);
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new Error("This selection has expired. Please select the user again.");
    }
    let app = await this.#uiAccountRecord(appAccountId);
    if (!app || app.vendorId !== record.vendorId) throw new Error("No such app.");
    return this.ctx.exports.UserDurableObject.getByName(record.selectedUserId)
        .selectableGatekeeperUsers(record.vendorId);
  }

  /**
   * Make the account's grant cover the resource types `resourceUrlPatterns` names. Only the
   * gatekeeper knows what it was granted, so it decides: it returns the URL of a consent flow that
   * widens the grant, opened here as a connect flow, or no URL when the grant already covers them.
   */
  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[])
      : Promise<ConnectFlowStart | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.ensureResources(resourceUrlPatterns);
    if (url === undefined) {
      // Nothing to grant, yet callers ask for what the account's stored description doesn't list as
      // granted, so that list is out of date. A gatekeeper that renames a resource type's
      // `urlPattern` reads the grants it recorded under the new name, but the description stored
      // here keeps the old one until it is fetched again. Fetch it now, or the UI keeps offering a
      // grant the account already has. Best-effort: null still means nothing needed granting.
      try {
        let description = await record.account.describe();
        let current = this.storage.connectedAccounts.get(accountId);
        if (current) this.storage.connectedAccounts.put({ ...current, description });
      } catch (err) {
        logger.warn("failed to refresh a stale account description", {
          event: "account.describe.refresh.failed", vendorId: record.vendorId, accountId, error: err,
        });
      }
      return null;
    }
    return { url, nonce: await this.openConnectFlow(accountId) };
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
        // A forced ("enabled") ambient account can't be removed by the user — the admin controls it.
        if (shouldAutoProvisionAccount(await readAdminConfig(this.env), account.vendorId)) {
          throw new Error("This account is provided automatically and can't be disconnected.");
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
      await account.account.revoke();
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

  async reconnectAccount(accountId: number): Promise<ConnectFlowStart> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.reconnect();
    return { url, nonce: await this.openConnectFlow(accountId) };
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  async startCreationConfigurator(accountId: number, resourceUrlPattern: string)
      : Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return (record.account as unknown as CreationConfiguratorStub)
        .startCreationConfigurator(resourceUrlPattern);
  }

  /**
   * Persist a connected gatekeeper account that was established during sign-in (rather than via the
   * usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
   * links the account for AI Gateway billing: the login callback resolves this user by verified
   * email, then calls here to store the resulting grant. That grant covers billing only: sign-in
   * requests no gadget-facing resources, so any later resource access is authorized separately.
   * Returns the id of the connected account the grant now backs, so the login callback — which the
   * gatekeeper keeps for that account's lifetime — can find it again.
   */
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<number> {
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
        this.storage.connectedAccounts.put(existing);
        return existing.id;
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
    return id;
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
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put(record);
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

    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    this.storage.connectedAccounts.put(record);

    // Re-fetch the description since the user may have re-authed with different info. Best-effort:
    // the credentials are live either way, and a record still showing as expired over a failed
    // describe() would send the user back through a reconnect that changes nothing.
    try {
      record.description = await record.account.describe();
      this.storage.connectedAccounts.put(record);
    } catch (err) {
      logger.warn("failed to refresh the description of a restored account", {
        event: "account.describe.refresh.failed", vendorId: record.vendorId, accountId, error: err,
      });
    }
  }

  // --- Connect handoff (see connect-handoff.ts) ---

  /**
   * Start a connect / reconnect / ensure-resources flow for `accountId`: mints the nonce the Workshop
   * tab gives the popup (see ConnectFlowStart) and keeps its hash, so completeConnectHandoff can
   * check that the ticket the flow produces came back through that popup.
   */
  async openConnectFlow(accountId: number): Promise<string> {
    let { secret, hash: nonceHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + CONNECT_FLOW_LIFETIME_MS);
    this.storage.pendingConnectFlows.put({ nonceHash, accountId, expiresAt });
    await this.#armExpirySweep();
    return secret.toHex();
  }

  // Store a finished-but-unconfirmed flow and hand back the ticket its page must present, together
  // with the flow's nonce, over the initiating user's session. Only the ticket's hash is kept, and
  // only in this user's DO, so the ticket is redeemable by nobody else (completeConnectHandoff looks
  // it up in the caller's own DO).
  async #stagePendingHandoff(
      record: Omit<PendingHandoffRecord, "ticketHash" | "expiresAt">): Promise<ConnectHandoff> {
    let targetOrigin = handoffTargetOrigin(this.env);
    let { secret, hash: ticketHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    this.storage.pendingHandoffs.put({ ...record, ticketHash, expiresAt });
    await this.#armExpirySweep();
    return { targetOrigin, ticket: secret.toHex() };
  }

  /** A gatekeeper finished a connect flow for a reserved account id; stage it until confirmed. */
  async stagePendingConnect(accountId: number, account: Fetcher<GatekeeperUser>, vendorId: string,
                            credentialExpiresAt?: Date): Promise<ConnectHandoff> {
    let description = await account.describe();
    return this.#stagePendingHandoff({
      kind: "connect", accountId, credentialExpiresAt, connect: { account, description, vendorId },
    });
  }

  /**
   * A gatekeeper finished a reconnect/ensureResources flow; its credentials stay staged there under
   * `stageId`, which commitReconnect() names so the ticket activates exactly those credentials.
   */
  stagePendingRestore(accountId: number, stageId: string, credentialExpiresAt?: Date)
      : Promise<ConnectHandoff> {
    return this.#stagePendingHandoff({ kind: "restore", accountId, stageId, credentialExpiresAt });
  }

  /**
   * Redeem a finished flow's handoff. Called by the Workshop's own /connect/handoff page in the popup
   * over the popup's session; `nonce` proves the popup is the one this user's tab opened for that
   * flow. The ticket's record is deleted before anything else, so a ticket is single-use however the
   * rest goes (DO input gates serialize the read and delete) and a wrong nonce still spends it; the
   * nonce's flow is deleted too, so a nonce cannot be retried against another ticket. A staged
   * connect the redemption cannot activate is dropped like an unredeemed one, so no grant is left
   * reachable in a gatekeeper with nothing to revoke it.
   */
  async completeConnectHandoff(ticket: string, nonce: string): Promise<void> {
    let [ticketHash, nonceHash] =
        await Promise.all([hashPresentedSecret(ticket), hashPresentedSecret(nonce)]);
    let record: PendingHandoffRecord | undefined;
    if (ticketHash !== undefined) {
      record = this.storage.pendingHandoffs.get(ticketHash);
      if (record) this.storage.pendingHandoffs.delete(ticketHash);
    }
    let flow: PendingConnectFlow | undefined;
    if (nonceHash !== undefined) {
      flow = this.storage.pendingConnectFlows.get(nonceHash);
      if (flow) this.storage.pendingConnectFlows.delete(nonceHash);
    }
    let now = Date.now();
    if (!record || record.expiresAt.getTime() <= now ||
        !flow || flow.expiresAt.getTime() <= now || flow.accountId !== record.accountId) {
      if (record) await this.#dropPendingConnect(record);
      throw new Error("This connection attempt has expired. Please try again.");
    }

    if (record.kind === "connect") {
      if (!record.connect) throw new Error("Corrupt pending connection.");
      try {
        await this.putConnectedAccount({
          id: record.accountId, ...record.connect, credentialExpiresAt: record.credentialExpiresAt,
        });
      } catch (err) {
        await this.#dropPendingConnect(record);
        throw err;
      }
      logger.info("account connected", {
        event: "account.connect.completed", vendorId: record.connect.vendorId,
        accountId: record.accountId,
      });
    } else {
      let account = this.storage.connectedAccounts.get(record.accountId);
      if (!account) throw new Error("No such account.");
      if (record.stageId === undefined) throw new Error("Corrupt pending reconnect.");
      // A failed commit changed nothing live, and the gatekeeper's stage expires on its own.
      await account.account.commitReconnect(record.stageId);
      await this.markCredentialsRestored(record.accountId, record.credentialExpiresAt);
      logger.info("account credentials restored", {
        event: "account.reconnect.completed", vendorId: account.vendorId,
        accountId: record.accountId,
      });
    }
  }

  // Drop a pending handoff that will never activate. A staged connect holds a victim's (or just an
  // abandoned) grant in a reachable gatekeeper DO, so it is revoked, best-effort. A staged restore
  // left nothing live: the gatekeeper's staged credentials stop being committable on their own
  // (commitStagedCredentials refuses an expired stage), though they stay stored until the next
  // reconnect overwrites them; deleting them from here is a follow-up.
  async #dropPendingConnect(pending: PendingHandoffRecord): Promise<void> {
    if (pending.kind === "connect" && pending.connect) {
      try {
        await pending.connect.account.revoke();
      } catch (err) {
        logger.warn("failed to revoke unconfirmed connection", {
          event: "connect.handoff.revoke.failed", vendorId: pending.connect.vendorId,
          accountId: pending.accountId, error: err,
        });
      }
    }
    logger.info("unconfirmed connection dropped", {
      event: "connect.handoff.expired", handoffKind: pending.kind, accountId: pending.accountId,
    });
  }

  #dropPendingDeviceHandoff(pending: PendingDeviceHandoffRecord): void {
    this.storage.pendingDeviceHandoffs.delete(pending.stateHash);
    if (pending.sessionTokenId) this.storage.sessions.delete(pending.sessionTokenId);
  }

  // Arm the alarm for the soonest pending expiry, including device sessions and picker selections.
  async #armExpirySweep(): Promise<void> {
    let scheduled = await this.ctx.storage.getAlarm();
    let next: number | undefined;
    let consider = (at: number) => { if (next === undefined || at < next) next = at; };
    if ([...this.#readCursors.values()].some(cursor => cursor.unreadDirty || cursor.notificationsDirty)) {
      // Other activity must not postpone an outstanding retry; a fired alarm can schedule anew.
      consider(Math.min(scheduled ?? Infinity, Date.now() + 30_000));
    }
    for (let flow of this.storage.pendingConnectFlows.list()) consider(flow.expiresAt.getTime());
    for (let pending of this.storage.pendingDeviceHandoffs.list()) {
      consider(pending.expiresAt.getTime());
    }
    for (let session of this.storage.sessions.list()) {
      if (session.expiresAt) consider(session.expiresAt.getTime());
    }
    for (let selection of this.storage.pendingUserSelections.list()) {
      consider(selection.expiresAt.getTime());
    }
    try {
      for (let pending of this.storage.pendingHandoffs.list()) consider(pending.expiresAt.getTime());
    } catch (err) {
      // A record whose stub no longer deserializes (its Worker was unbound) fails the listing, and
      // without a keys-only listing it cannot be deleted either. Staging a new connect must not
      // depend on listing old ones, so arm a retry instead: one warning per lifetime for this user
      // until the Worker is bound again, while the grant the record holds is reachable by nobody.
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.arm.failed", error: err,
      });
      consider(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    }
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(1, next));
    }
  }

  /**
   * Drop unconfirmed connect handoffs, abandoned connect flows and picker selections, and expired
   * device handoffs and sessions. Device handoff cleanup also deletes its unactivated session.
   */
  async alarm(): Promise<void> {
    // A stalled workspace/push service must not prevent unrelated auth expiry cleanup.
    let deliveries = Promise.allSettled([this.#recoverUnread()]);
    let now = Date.now();
    let expiredFlows = Array.from(this.storage.pendingConnectFlows.list())
        .filter(flow => flow.expiresAt.getTime() <= now);
    for (let flow of expiredFlows) this.storage.pendingConnectFlows.delete(flow.nonceHash);
    let expiredSelections = Array.from(this.storage.pendingUserSelections.list())
        .filter(selection => selection.expiresAt.getTime() <= now);
    for (let selection of expiredSelections) {
      this.storage.pendingUserSelections.delete(selection.ticketHash);
    }
    let expired: PendingHandoffRecord[] = [];
    try {
      for (let pending of this.storage.pendingHandoffs.list()) {
        if (pending.expiresAt.getTime() <= now) expired.push(pending);
      }
    } catch (err) {
      // Same failure mode as #connectedAccountRecords: a stub for a Worker that is no longer bound
      // fails to deserialize. Leave the sweep for next time (#armExpirySweep bounds the retry).
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.sweep.failed", error: err,
      });
    }
    for (let pending of expired) {
      this.storage.pendingHandoffs.delete(pending.ticketHash);
      await this.#dropPendingConnect(pending);
    }
    for (let pending of Array.from(this.storage.pendingDeviceHandoffs.list())) {
      if (pending.expiresAt.getTime() <= now) this.#dropPendingDeviceHandoff(pending);
    }
    for (let session of Array.from(this.storage.sessions.list())) {
      if ((session.expiresAt?.getTime() ?? Infinity) <= now) {
        this.storage.sessions.delete(session.tokenId);
      }
    }
    await this.#armExpirySweep();
    for (let result of await deliveries) if (result.status === "rejected") throw result.reason;
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);
    await this.#assertResourceEnabled(account.vendorId, resource);
    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern};
  }

  /**
   * Mint a gatekeeper class simulating a new resource of a creatable type (see
   * GatekeeperVendor.createResource()). It belongs to no account; the returned `action` is the
   * creation to queue.
   */
  async createResourceGatekeeper(vendorId: string, resourceUrlPattern: string, title: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, typeUrlPattern: string,
                  action: ActionDescription}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error(`Unknown vendor "${vendorId}".`);
    let {class: cls, resource, action} = await (vendor as unknown as ResourceCreatorStub)
        .createResource(resourceUrlPattern, title);
    if (!resource.creatable) {
      throw new Error(`"${resource.title}" resources can't be created. ` +
          "listConnectableResources marks the types that can.");
    }
    await this.#assertResourceEnabled(vendorId, resource);
    return {class: cls, typeUrlPattern: resource.urlPattern, action};
  }

  // Block whole gatekeepers + disabled resources at the core-side chokepoints where a gatekeeper
  // class is minted (reached only via the user/UI-facing Overseer.newGatekeeper, blueprint
  // instantiation, and the agent's createExternalResource -- never from gadget code). An ambient
  // gatekeeper an admin set to "disabled" is blocked here too. Blocking here prevents minting a
  // capability to a disabled resource even if the request bypasses the (separately filtered)
  // picker/agent listings.
  async #assertResourceEnabled(vendorId: string, resource: SupportedResource) {
    let config = await readAdminConfig(this.env);
    let normalized = vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(normalized) ||
        ambientGatekeeperMode(config, normalized) === "disabled") {
      throw new Error(
          `The "${vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }
    if (isResourceDisabled(config, normalized, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }
  }

  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it, or to its
   * `applyCreation()` to create the resource in this account. Returns null if the
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
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }

  // All currently eligible accounts this selected user has with the requested vendor. The
  // gatekeeper, not the Workshop, decides what zero or multiple accounts mean for its operation.
  async #eligibleGatekeeperAccounts(vendorId: string): Promise<ConnectedAccountRecord[]> {
    if (!this.storage.created.get()) return [];
    vendorId = vendorId.toLowerCase();

    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(vendorId)) return [];

    await this.#ensureAutoProvisionedAccounts();

    return [...this.#connectedAccountRecords()].filter((record) =>
      record.vendorId === vendorId && areCredentialsValid(record) &&
      (!record.autoProvisioned || ambientGatekeeperMode(config, vendorId) !== "disabled")
    );
  }

  /**
   * Return every currently eligible account belonging to this selected user and
   * vendor, each with its own identity capability and the user's fresh
   * display-name snapshot. Returns an empty array when none qualify; does not
   * choose between multiple accounts. Accounts are resolved at redemption time
   * and need not be the same accounts the user had when the ticket was minted.
   */
  async selectableGatekeeperUsers(vendorId: string): Promise<RedeemedGatekeeperUserSelection[]> {
    let accounts = await this.#eligibleGatekeeperAccounts(vendorId);
    if (accounts.length === 0) return [];
    let profile = { displayName: this.storage.profile.get().name };
    return Promise.all(accounts.map(async account => ({
      verifier: await account.account.getVerifier(), profile,
    })));
  }

  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account ? account.description : null;
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<ConnectHandoff> {
    let {accountId, vendorId} = this.ctx.props;
    return this.#getUserStub().stagePendingConnect(accountId, account, vendorId, expiresAt);
  }

  reconnectComplete(stageId: string, expiresAt?: Date): Promise<ConnectHandoff> {
    return this.#getUserStub().stagePendingRestore(this.ctx.props.accountId, stageId, expiresAt);
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

type GatekeeperUserSelectionExchangeProps = {
  selectorUserId: string;
  appAccountId: number;
};

/**
 * The capability exposed to a gatekeeper app for redeeming user selection
 * tickets (AppUiContext.userSelectionExchange). Its props contain the selecting
 * user's ID and the one gatekeeper account startAccountAppUi was called on.
 * Every ticket is redeemed against that scope, so the capability cannot resolve
 * anything that the Workshop did not mint for it.
 */
@validateRpc()
export class GatekeeperUserSelectionExchangeImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperUserSelectionExchangeProps>
    implements GatekeeperUserSelectionExchange {
  /**
   * RPC validation is skipped for the same reason every gatekeeper's
   * getVerifier() skips it: the generated return validator wraps the native
   * Fetcher in a Proxy that Workers RPC then refuses to serialize. The ticket
   * itself is checked by hashPresentedSecret before it is looked up.
   */
  @skipRpcValidation()
  redeem(ticket: string): Promise<RedeemedGatekeeperUserSelection[]> {
    let { selectorUserId, appAccountId } = this.ctx.props;
    let users = this.ctx.exports.UserDurableObject;
    return users.get(users.idFromString(selectorUserId))
        .redeemGatekeeperUserSelection(appAccountId, ticket);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
