// A deployment admin's read-only view of a user's account (see AdminUserView in api.ts and
// UserDurableObject.openForAdmin()).
//
// Read-only by construction: the view reaches the account through AdminUserViewHost alone, whose
// store offers only `get` and `list` and leaves out the collections that hold gatekeeper stubs. So
// nothing in this module can write to the account, subscribe to it, or call a gatekeeper.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_LIST_MAX_LIMIT, createAdminAccessError,
  type AdminAccessExposure, type AdminUserAccessRecord, type AdminUserBlueprint,
  type AdminUserConnectedAccount, type AdminUserDescription, type AdminUserDiagnostics,
  type AdminUserMethod, type AdminUserModels, type AdminUserSessions, type AdminUserView,
  type AdminUserWorkspace, type AdminViewAccess, type AdminWorkspaceAccess,
} from "@gadgets/workshop-shared/api";
import {
  assertAdminViewLive, connectedAccountHoldsContent, redactAdminAuditArgs,
  userBlueprintHoldsContent, withholdConnectedAccountContent, withholdUserBlueprintContent,
  type AdminViewTerms,
} from "./admin-access.js";
import type { AdminAuditDurableObject } from "./admin-audit.js";
import { adminViewCall } from "./admin-view.js";
import { isDeploymentAdmin } from "./auth/config.js";
import { createWorkshopLogger } from "./observability.js";
import type { ConnectedAccountRecord, UserStorage } from "./storage-schema/user-storage.js";

const logger = createWorkshopLogger("workshop.admin.user-view");

/**
 * A user's store as the view holds it: the `get` and `list` of each collection and singleton, and
 * nothing that writes, subscribes or opens a transaction. The two collections whose records hold
 * gatekeeper stubs are left out, so nothing in this module can name one: connected accounts come
 * through AdminUserViewHost.connectedAccounts(), without their stubs, and pending handoffs (grants
 * staged and not yet confirmed) are not read at all.
 */
export type UserStoreReads = {
  readonly [K in Exclude<keyof UserStorage,
      "connectedAccounts" | "pendingHandoffs" | "transaction">]:
      Pick<UserStorage[K], Extract<keyof UserStorage[K], "get" | "list">>;
};

/** What the view reads of the account's Durable Object. */
export type AdminUserViewHost = {
  /** The object's environment as it is at each use. A function-typed property and not a method:
   * the view hands it on to adminViewCall() as it is. */
  readonly env: () => Cloudflare.Env;
  /** The account's store: its reads, less the collections that hold gatekeeper stubs. */
  readonly storage: UserStoreReads;
  /** The deployment-wide audit log's namespace. */
  readonly audits: DurableObjectNamespace<AdminAuditDurableObject>;
  /** The connected-account records that load, each without its gatekeeper stub:
   * UserDurableObject's own iteration, which skips one whose gatekeeper is no longer bound. */
  connectedAccounts(): Iterable<Omit<ConnectedAccountRecord, "account">>;
  /** When the object's alarm next fires, or null. */
  nextAlarm(): Promise<number | null>;
};

/**
 * Mints a view of the account behind `user`, recording the open ("inspectUser") as its first call:
 * the view exists only once that record does. The one way to make a view, since its class is not
 * exported. `reason` is already trimmed and `terms` already checked (assertAdminViewTerms()).
 */
export function openAdminUserView(user: AdminUserViewHost, adminId: string, reason: string,
    sessionId: string, terms: AdminViewTerms): Promise<AdminUserView> {
  return AdminUserViewImpl.open(user, adminId, reason, sessionId, terms);
}

// Not exported, so that open() is the only way in and no view exists whose open was not recorded.
// Every method runs through #call, which reads the call's answer and records the call, with what
// that answer exposed, in the deployment-wide log before returning anything. Each answer names
// its fields one by one, since the stored records hold more (token ids, hashes, API tokens); the
// three values returned whole are API values that hold no credential: the profile, a shared
// workspace's owner, and at "full" a connected account's description. Each storage listing is
// read to its end before the next starts.
@validateRpc()
class AdminUserViewImpl extends RpcTarget implements AdminUserView {
  #host: AdminUserViewHost;
  #adminId: string;
  #reason: string;
  #sessionId: string;
  #terms: AdminViewTerms;
  #userId: string;

  constructor(host: AdminUserViewHost, adminId: string, reason: string, sessionId: string,
              terms: AdminViewTerms) {
    super();
    this.#host = host;
    this.#adminId = adminId;
    this.#reason = reason;
    this.#sessionId = sessionId;
    this.#terms = terms;
    // Read now, since a call's record is built with nothing awaited (see #recordOf()). An
    // account's id never changes.
    this.#userId = host.storage.profile.get().id;
  }

  // Mints a view, recording the open as its first call (see openAdminUserView()). Static, so that
  // auditing stays off the view's RPC surface.
  static async open(host: AdminUserViewHost, adminId: string, reason: string, sessionId: string,
                    terms: AdminViewTerms): Promise<AdminUserViewImpl> {
    let view = new AdminUserViewImpl(host, adminId, reason, sessionId, terms);
    await view.#call("inspectUser", { expiresAt: terms.expiresAt.toISOString() }, () => undefined);
    return view;
  }

  // The checks that stop a call unrecorded: the view has not expired, its admin is still one, and
  // the account still exists.
  #assertLive(): void {
    assertAdminViewLive(this.#terms, this.#adminId, this.#host.env());
    if (!this.#host.storage.created.get()) {
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.userNotFound);
    }
  }

  // Runs one call through adminViewCall(), which checks, reads, records and only then answers.
  // `read` takes the level the call runs at and withholds by it, never by the view's own: the
  // deployment's setting may have dropped under a live view. No method reads content alone, so
  // none is refused below "full".
  #call<T>(method: AdminUserMethod, args: Record<string, string | number | undefined>,
      read: (access: AdminViewAccess) => T | Promise<T>,
      holdsContent?: (answer: T) => boolean): Promise<T> {
    return adminViewCall({
      env: this.#host.env,
      terms: this.#terms,
      audits: this.#host.audits,
      logger,
      assertLive: () => this.#assertLive(),
      recordOf: (access, exposed, refused) =>
          this.#recordOf(method, args, access, exposed, refused),
    }, false, read, holdsContent);
  }

  // The record of one call, as the deployment-wide log keeps it. Synchronous: adminViewCall()
  // builds and sends a record with nothing awaited since its last check.
  #recordOf(method: AdminUserMethod, args: Record<string, string | number | undefined>,
      access: AdminWorkspaceAccess, exposed: AdminAccessExposure,
      refused?: AdminUserAccessRecord["refused"]): AdminUserAccessRecord {
    return {
      kind: "user",
      userId: this.#userId,
      at: new Date(),
      admin: this.#adminId,
      sessionId: this.#sessionId,
      via: this.#terms.via,
      method,
      args: redactAdminAuditArgs(args),
      reason: this.#reason,
      requested: this.#terms.requested,
      access,
      exposed,
      ...(refused ? { refused } : {}),
    };
  }

  async describe(): Promise<AdminUserDescription> {
    return this.#call("describe", {}, access => {
      let storage = this.#host.storage;
      let profile = storage.profile.get();
      let workspaces = [...storage.gadgets.list()];
      let shared = workspaces.filter(workspace => workspace.owner !== undefined).length;
      let lastLogin = storage.directoryLoginAt.get();
      return {
        profile,
        created: storage.createdAt.get() ?? undefined,
        lastLogin: lastLogin > 0 ? new Date(lastLogin) : undefined,
        isAdmin: isDeploymentAdmin(this.#host.env(), profile.id),
        hasPassword: storage.passwordHashHash.get() !== null,
        onboardingCompleted: storage.onboardingCompleted.get(),
        counts: {
          ownedWorkspaces: workspaces.length - shared,
          sharedWorkspaces: shared,
          connectedAccounts: [...this.#host.connectedAccounts()].length,
          models: [...storage.aiModels.list()].length,
          sessions: [...storage.sessions.list()].length,
          ownBlueprints: [...storage.blueprints.list()].length,
          libraryBlueprints: [...storage.libraryBlueprints.list()].length,
        },
        access,
        expiresAt: this.#terms.expiresAt,
      };
    });
  }

  async listWorkspaces(): Promise<AdminUserWorkspace[]> {
    return this.#call("listWorkspaces", {}, () =>
        [...this.#host.storage.gadgets.list()].map(workspace => ({
          id: workspace.id,
          title: workspace.title,
          totalCost: workspace.totalCost,
          notificationMute: workspace.notificationMute,
          owner: workspace.owner,
          role: workspace.role,
          created: workspace.created,
          lastActive: workspace.lastActive,
        })));
  }

  async listConnectedAccounts(): Promise<AdminUserConnectedAccount[]> {
    return this.#call("listConnectedAccounts", {}, access => {
      let accounts = Array.from(this.#host.connectedAccounts(),
          (record): AdminUserConnectedAccount => ({
            id: record.id,
            vendorId: record.vendorId,
            autoProvisioned: record.autoProvisioned === true,
            credentialExpiresAt: record.credentialExpiresAt,
            credentialsExpired: record.credentialsExpired === true,
            description: record.description,
          }));
      return access === "full" ? accounts : accounts.map(withholdConnectedAccountContent);
    }, accounts => accounts.some(connectedAccountHoldsContent));
  }

  async listModels(): Promise<AdminUserModels> {
    return this.#call("listModels", {}, () => {
      let storage = this.#host.storage;
      return {
        models: [...storage.aiModels.list()].map(({ profile, config }) => ({
          id: profile.id,
          name: profile.name,
          provider: config.provider,
          model: config.model,
          customApiUrl: Boolean(config.apiUrl),
        })),
        preferredModel: storage.preferredModel.get(),
        quickModel: storage.quickModel.get(),
      };
    });
  }

  async listSessions(): Promise<AdminUserSessions> {
    return this.#call("listSessions", {}, () => {
      let sessions = [...this.#host.storage.sessions.list()]
          .toSorted((a, b) => b.created.getTime() - a.created.getTime());
      return {
        total: sessions.length,
        sessions: sessions.slice(0, ADMIN_LIST_MAX_LIMIT).map(session => ({
          created: session.created,
          expiresAt: session.expiresAt,
          pendingUntil: session.pendingUntil,
        })),
      };
    });
  }

  async listBlueprints(): Promise<AdminUserBlueprint[]> {
    return this.#call("listBlueprints", {}, access => {
      let storage = this.#host.storage;
      let own = [...storage.blueprints.list()].map((record): AdminUserBlueprint => {
        // The publishing workspace's id; a record without one was not published from a workspace.
        let workspaceId = record.gadgetId || undefined;
        return {
          id: record.id,
          held: workspaceId ? "published" : "imported",
          title: record.metadata.title,
          version: record.metadata.version,
          lastUpdated: record.metadata.lastUpdated,
          workspaceId,
          featured: record.featured === true,
        };
      });
      let library = [...storage.libraryBlueprints.list()].map((record): AdminUserBlueprint => ({
        id: record.id,
        held: record.uploaded ? "uploaded" : "added",
        title: record.metadata.title,
        version: record.metadata.version,
        lastUpdated: record.metadata.lastUpdated,
      }));
      let blueprints = [...own, ...library];
      return access === "full" ? blueprints : blueprints.map(withholdUserBlueprintContent);
    }, blueprints => blueprints.some(userBlueprintHoldsContent));
  }

  async getDiagnostics(): Promise<AdminUserDiagnostics> {
    return this.#call("getDiagnostics", {}, async () => {
      let storage = this.#host.storage;
      let nextAlarm = await this.#host.nextAlarm();
      // The pending collections keep a lapsed record until the account's alarm sweeps it.
      let now = Date.now();
      let live = (records: Iterable<{ expiresAt: Date }>) =>
          [...records].filter(record => record.expiresAt.getTime() > now).length;
      let daily = storage.dailyLlmCount.get();
      let billing = storage.cloudflareBilling.get();
      return {
        nextAlarm: nextAlarm === null ? undefined : new Date(nextAlarm),
        pendingConnectFlows: live(storage.pendingConnectFlows.list()),
        pendingDeviceHandoffs: live(storage.pendingDeviceHandoffs.list()),
        pushDevices: {
          phones: Object.keys(storage.phoneNotificationSubscriptions.get()).length,
          browsers: Object.keys(storage.browserNotificationSubscriptions.get()).length,
        },
        queuedNotifications: [...storage.notificationOutbox.list()].length,
        dailyModelCalls: daily ? { day: daily.day, count: daily.count } : undefined,
        billing: billing ? {
          accountId: billing.accountId,
          creditsRemaining: billing.creditsRemaining ?? undefined,
          creditsUpdatedAt: billing.creditsUpdatedAt === undefined
              ? undefined : new Date(billing.creditsUpdatedAt),
        } : undefined,
      };
    });
  }
}
