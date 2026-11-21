// The admin gatekeeper: an auto-provisioned gatekeeper whose account lets a deployment admin add
// this deployment's Admin API to a workspace they own, for its agents. It holds no power of its
// own: the Workshop lends each session the Admin API of the workspace's owner, and decides what
// each call may do.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { ActionJournal, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import type {
  AdminAgentApi, AdminAgentQueue, AdminGatekeeper, AdminGatekeeperVendor,
} from "@gadgets/workshop-shared/admin-gatekeeper";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GitCache,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { resourceTypeUrlPattern, workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_ACTIONS, type AdminActions, type BoundAdminActions } from "./actions.js";
import type { DeploymentConfiguratorRpc } from "./configurator/deployment-configurator-types";
import { ADMIN_SUBRESOURCE, type AdminSession, forwarderFor } from "./forward.js";
import DEPLOYMENT_CONFIGURATOR_HTML from "./generated/deployment-configurator-ui.txt";
import {
  IssueReportHookDeliveryImpl, type IssueReportHookKind, type IssueReportHookParams,
  type IssueReportHookTarget, type SentIssueReportEvent, bindIssueReportHook, issueReportHookDriver,
} from "./hooks.js";
import { IssueReportSession } from "./report-session.js";
import { ADMIN_SCHEMA, generatedDeclarations } from "./surface.js";
import TYPES_CODE from "./types.txt";

const DISPLAY_NAME = "Deployment admin";

const SHIELD_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M208 40H48a16 16 0 0 0-16 16v56c0 52.72 25.52 84.67 46.93 102.19 23.06 18.86 46 25.27 47 25.53a8 8 0 0 0 4.2 0c1-.26 23.91-6.67 47-25.53C198.48 196.67 224 164.72 224 112V56a16 16 0 0 0-16-16Zm0 72c0 37.07-13.66 67.16-40.6 89.42A129.3 129.3 0 0 1 128 223.62a128.25 128.25 0 0 1-38.92-21.81C61.82 179.51 48 149.3 48 112V56h160Z'/></svg>",
    ),
};

/**
 * The one resource of an admin gatekeeper account: this deployment's Admin API. Not exported: the
 * runtime refuses to start a Worker whose entry module exports a value that is no handler.
 */
const DEPLOYMENT_URL = "admin://deployment";

const DEPLOYMENT_RESOURCE: SupportedResource = {
  id: "deployment",
  urlPattern: DEPLOYMENT_URL,
  title: DISPLAY_NAME,
  description: "This deployment's Admin API, for the agents of a workspace its admin owns.",
  icon: SHIELD_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [DEPLOYMENT_RESOURCE];

const NO_CONNECT_FLOW = "The admin gatekeeper is auto-provisioned and has no connect flow.";

/** The binding's declarations: the ones generated from the schema, then the hand-written ones. */
const TYPES = `${generatedDeclarations()}\n${TYPES_CODE}`;

// The hook controller and the hooks' driver are reached through ctx.exports, so the entry module
// exports them.
export { IssueReportHookController, IssueReportHookDriver } from "./hooks.js";

/** Binds `hook` on the session's queue as a hook of `kind`: the facet's part of subscribing. */
type Subscribe = (
  queue: RpcStub<AdminAgentQueue>, kind: IssueReportHookKind, hook: RpcStub<IssueReportHookTarget>,
) => Promise<void>;

/**
 * The session of the whole binding: the schema's methods, and beside them the ones AdminBinding
 * declares by hand. It borrows the queue its base owns.
 *
 * No @validateRpc(), as its base has none: a validator built from this class would refuse every
 * method the schema defines. So a method written here checks its own arguments.
 */
class BindingSession extends forwarderFor(ADMIN_SCHEMA.entry) {
  readonly #queue: RpcStub<AdminAgentQueue>;
  readonly #actions: BoundAdminActions;
  readonly #subscribe: Subscribe;

  constructor(queue: RpcStub<AdminAgentQueue>, actions: BoundAdminActions, subscribe: Subscribe) {
    super(queue, { restricted: true, subresource: ADMIN_SUBRESOURCE, actions });
    this.#queue = queue;
    this.#actions = actions;
    this.#subscribe = subscribe;
  }

  /**
   * Opens a session limited to the report `reportId`, over a queue of its own. It reads nothing
   * and observes nothing, since it returns a capability and no data: a report that does not
   * exist is refused by the session's first call.
   */
  async openIssueReport(reportId: string): Promise<IssueReportSession> {
    if (typeof reportId !== "string") {
      throw new TypeError("Invalid arguments for AdminBinding.openIssueReport: reportId must " +
          "be a string.");
    }
    return new IssueReportSession(reportId, this.#queue.dup(), this.#actions);
  }

  /**
   * Binds `hook`, a persistent stub, to be called for each issue report filed. It reads nothing
   * through the binding and observes nothing: the hook is bound on the queue, disabled until a
   * person enables it.
   */
  async subscribeIssueReported(hook: RpcStub<IssueReportHookTarget>): Promise<void> {
    await this.#bind("subscribeIssueReported", "reported", hook);
  }

  /** As subscribeIssueReported(), for each investigation that ends. */
  async subscribeInvestigationComplete(hook: RpcStub<IssueReportHookTarget>): Promise<void> {
    await this.#bind("subscribeInvestigationComplete", "investigationComplete", hook);
  }

  /** As subscribeIssueReported(), for each write to a report after it was filed. */
  async subscribeIssueReportChanged(hook: RpcStub<IssueReportHookTarget>): Promise<void> {
    await this.#bind("subscribeIssueReportChanged", "changed", hook);
  }

  async #bind(
    method: string, kind: IssueReportHookKind, hook: RpcStub<IssueReportHookTarget>,
  ): Promise<void> {
    // A stub arrives as an object or, for one that may be a function, as a function.
    if ((typeof hook !== "object" && typeof hook !== "function") || hook === null) {
      throw new TypeError(`Invalid arguments for AdminBinding.${method}: hook must be a ` +
          "persistent stub of the callback.");
    }
    await this.#subscribe(this.#queue, kind, hook);
  }
}

/**
 * The workspace facet. Its sessions forward to the Admin API the Workshop lends each of them
 * through its queue, and queue what would post, set or ask anything as an action. The facet
 * holds the journal of those actions and nothing that could carry one out: an approved action
 * runs on the Admin API the Workshop lends for it.
 */
@validateRpc()
export class AdminGatekeeperImpl
  extends DurableObject<Cloudflare.Env>
  implements AdminGatekeeper<AdminSession>
{
  /** The Admin API lent for each action being applied, by action id, for as long as it is. */
  readonly #lent = new Map<number, RpcStub<AdminAgentApi>>();
  readonly #journal = new ActionJournal<TaggedAction<AdminActions>>(
      this.ctx.storage.kv, { namespace: "admin" });
  readonly #actions = ADMIN_ACTIONS.bind(
      this.#journal, { lentFor: (action) => this.#lent.get(action) });

  /** Describes the admin binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: DEPLOYMENT_URL,
      title: DISPLAY_NAME,
      snippet: "This deployment's Admin API, as the workspace's owner.",
      suggestedBindingName: "ADMIN",
      tsType: "AdminBinding",
      hookTsType: "IssueReportHook",
    };
  }

  /** Returns the agent-facing declarations of the admin binding. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }

  /** The action kinds a rule may apply: every kind but the two whose verdict is false. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  /**
   * Opens a session that forwards each Admin API read to what `queue` lends it, and queues the
   * rest as actions.
   *
   * Skips validation: capnweb-validate builds a method's return validator from its declared
   * type, and the session's type declares none of its Admin API methods (they are defined from
   * the schema at load), so a validated return would wrap the session in a proxy refusing every
   * one of them. The session checks each call's arguments against the schema, and the Workshop
   * validates them again where the call lands. The skip also leaves `queue` unchecked, which only
   * the Workshop passes.
   */
  @skipRpcValidation()
  async startSession(queue: RpcStub<AdminAgentQueue>): Promise<AdminSession> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new BindingSession(queue.dup(), this.#actions,
        (bindOn, kind, hook) => bindIssueReportHook(this.ctx, bindOn, kind, hook));
  }

  /**
   * What a hook's delivery stub reaches: a target that delivers events of the hook's kind, never
   * the facet itself.
   */
  [restore](params: IssueReportHookParams): IssueReportHookDeliveryImpl {
    return new IssueReportHookDeliveryImpl(params);
  }

  /** Returns no catalog: the binding's types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Keeps no observer state: verifyObserverAccess() is asked about each read. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * Allows every observer it is asked about for the one subresource this Worker reports, the
   * whole binding's, and none for any other. Who may see what the binding read is a question of
   * who is a deployment admin, which this Worker cannot tell: the Workshop admits to a workspace
   * with this connection, beside its owner, only users who are deployment admins at that moment.
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    const known = subresources.every((id) => id === ADMIN_SUBRESOURCE);
    return { allowedObserverIds: known ? observers.map((observer) => observer.id) : [] };
  }

  /** Reports no requirement recorded before observations carried their subresources. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /**
   * Applies approved action `action` with `admin`, which the Workshop lent for its one call. The
   * handler finds `admin` by the action's id, and only for as long as this call runs.
   */
  async applyAdminAction(action: number, admin: RpcStub<AdminAgentApi>): Promise<void> {
    this.#lent.set(action, admin);
    try {
      await this.#actions.apply(action);
    } finally {
      this.#lent.delete(action);
    }
  }

  /** Refuses: an action runs only on the Admin API lent for it (applyAdminAction()). */
  applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("The admin gatekeeper applies an action only with the Admin API lent for it.");
  }

  /** Withdraws an action: nothing was posted, set or filed for it. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions.reject(action);
  }

  /** Refuses: an entry, a status and a filed request cannot be taken back from here. */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The admin gatekeeper's actions cannot be reverted.");
  }
}

/**
 * An admin's account. It holds no credential and no state: every account is alike, and the
 * Workshop offers one only to a user who is a deployment admin. It declares no singleton, so it
 * is injected into no workspace: its holder adds its one resource to the workspaces that need it.
 */
@validateRpc()
export class AdminAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account: no agent singleton and no management UI. */
  async describe(): Promise<AccountDescription> {
    return { displayName: DISPLAY_NAME, avatar: SHIELD_ICON };
  }

  /** Returns the account's one resource, the deployment. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /** Returns the workspace facet class for the deployment's URL, and for no other. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<AdminSession>>;
    resource: SupportedResource;
  }> {
    if (url !== DEPLOYMENT_URL) {
      throw new Error(`The admin gatekeeper has one resource, ${DEPLOYMENT_URL}.`);
    }
    return { class: this.ctx.exports.AdminGatekeeperImpl({}), resource: DEPLOYMENT_RESOURCE };
  }

  /** Returns the frame that adds the deployment: it has nothing to choose. The type is named by
   * its id, or by its exact pattern as an older Workshop names it (resourceTypeUrlPattern()). */
  async startResourceConfigurator(resourceTypeId: string): Promise<ResourceConfiguratorFrame> {
    try {
      resourceTypeUrlPattern(SUPPORTED_RESOURCES, resourceTypeId);
    } catch {
      throw new Error(`The admin gatekeeper has one resource, ${DEPLOYMENT_URL}.`);
    }
    return {
      iframeHtml: DEPLOYMENT_CONFIGURATOR_HTML,
      ui: new RpcStub(new DeploymentConfiguratorUI()),
    };
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceTypeIds: string[]): Promise<{ url?: string }> {
    return {};
  }

  /**
   * Nothing to revoke: the account holds no token and no storage. What ends its connections when
   * it is removed is the Workshop's question at each lend, never this Worker.
   */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error(NO_CONNECT_FLOW);
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error(NO_CONNECT_FLOW);
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier that goes with allowing every observer. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.AdminVerifier({});
  }
}

/** The configurator's capability: the deployment's URL, the one resource there is to add. */
class DeploymentConfiguratorUI extends RpcTarget implements DeploymentConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return DEPLOYMENT_URL;
  }
}

/**
 * What a second admin presents to be admitted as an observer: their own account of this vendor.
 * Every account is alike, so there is nothing to verify.
 */
@validateRpc()
export class AdminVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned admin gatekeeper vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: DISPLAY_NAME,
      url: "https://github.com/cloudflare/cloudflare-os/blob/main/docs/admin-access.md",
      logo: SHIELD_ICON,
      tagline: "Give a deployment admin's agents this deployment's Admin API",
      description: "For deployment admins only. Agents in a workspace you add it to use this " +
        "deployment's Admin API as you: they read what admins read (users, workspaces, " +
        "settings, the audit log, issue reports and audited views of workspaces), and what " +
        "they would post to an issue report or ask of the admins is queued as an action. A " +
        "workspace it is added to admits only deployment admins. Removing this account ends " +
        "every connection made with it, in every workspace you own, until you add it again.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. It takes no identity: every account is alike and holds nothing. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.AdminAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error(NO_CONNECT_FLOW);
  }

  /**
   * Returns the one resource, which is not creatable: a connection of this vendor is made only
   * by adding the resource of an account, where the Workshop checks who adds it.
   */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /** Returns the agent-facing declarations of the admin binding. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }

  /**
   * Takes the issue report store's events for the hooks subscribed to them, and resolves once
   * the driver has stored each for delivery. An event with no subscriber, or of a kind or
   * with a label this Worker does not know, is dropped there, never refused: the store would
   * send its whole call again.
   */
  async issueReportEvents(events: SentIssueReportEvent[]): Promise<void> {
    await issueReportHookDriver(this.ctx.exports).ingest(events);
  }
}

/**
 * Not `implements AdminGatekeeperVendor`: capnweb-validate sharpens an implemented
 * interface's signatures onto the generated validator, which would refuse an event of a kind
 * this build does not know where issueReportEvents() takes it and drops it. The class is
 * checked against the contract here instead.
 */
export default GatekeeperVendor satisfies new (...args: never[]) => AdminGatekeeperVendor;
