import { DurableObject, RpcStub as NativeRpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import TYPES_CODE from "./agent-types.txt";
import APP_HTML from "./generated/app.txt";
import type { WorkItemsCurrentUser, WorkItemSavedView, WorkItemsSession, WorkItemsShellMetadataApi } from "./types.js";

const ACCOUNT_URL = "work-items://shell";
const MAX_VIEWS = 80;
const MAX_ID = 160;
const MAX_NAME = 120;
const MAX_QUERY = 2_000;
const MAX_FILTER = 200;
const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'><path d='M216 48h-48V40a24 24 0 0 0-24-24h-32a24 24 0 0 0-24 24v8H40a16 16 0 0 0-16 16v136a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16Zm-112-8a8 8 0 0 1 8-8h32a8 8 0 0 1 8 8v8h-48Zm112 160H40V64h176v136Z'/></svg>"),
};

type AccountProps = { accountId: string };

/** Returns provider-neutral account metadata for the composite Work Items shell. */
export function describeWorkItemsAccount(user?: WorkItemsCurrentUser): AccountDescription {
  return {
    displayName: user?.displayName ?? "Work Items",
    uniqueName: user?.uniqueName,
    avatar: ICON,
    singleton: { tsType: "WorkItemsSession" },
    providesUi: { title: "Work Items", icon: ICON, composition: { kind: "work-items" } },
  };
}

/** Durable account-local storage for shell-only saved-view preferences. */
@validateRpc()
export class WorkItemsAccount extends DurableObject<Cloudflare.Env> {
  listSavedViews(): WorkItemSavedView[] {
    return this.ctx.storage.kv.get<WorkItemSavedView[]>("savedViews") ?? [];
  }

  saveSavedView(view: WorkItemSavedView): WorkItemSavedView {
    const normalized = normalizeSavedView(view);
    const current = this.listSavedViews().filter((entry) => entry.id !== normalized.id);
    const next = [normalized, ...current].slice(0, MAX_VIEWS);
    this.ctx.storage.kv.put("savedViews", next);
    return normalized;
  }

  deleteSavedView(id: string): void {
    const safeId = boundString(id, MAX_ID).trim();
    if (!safeId || safeId.startsWith("builtin:")) throw new Error("Saved Work Items view id is invalid.");
    this.ctx.storage.kv.put("savedViews", this.listSavedViews().filter((entry) => entry.id !== safeId));
  }

  importSavedViews(views: WorkItemSavedView[]): WorkItemSavedView[] {
    if (!Array.isArray(views)) throw new Error("Saved Work Items view import must be an array.");
    const imported = normalizeImportedSavedViews(views);
    this.ctx.storage.kv.put("savedViews", imported);
    return imported;
  }

  revoke(): void {
    this.ctx.storage.kv.delete("savedViews");
  }
}

@validateRpc()
export class WorkItemsShellApi extends RpcTarget implements WorkItemsShellMetadataApi {
  constructor(private readonly account: DurableObjectStub<WorkItemsAccount>) { super(); }
  listSavedViews(): Promise<WorkItemSavedView[]> { return this.account.listSavedViews(); }
  saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView> { return this.account.saveSavedView(view); }
  deleteSavedView(id: string): Promise<void> { return this.account.deleteSavedView(id); }
  importSavedViews(views: WorkItemSavedView[]): Promise<WorkItemSavedView[]> { return this.account.importSavedViews(views); }
}

@validateRpc()
export class WorkItemsSessionImpl extends RpcTarget implements WorkItemsSession {
  constructor(private readonly approvalQueue: NativeRpcStub<ApprovalQueue>) { super(); }
  async ping(): Promise<string> {
    await this.approvalQueue.authorizeObservation({ title: "Check Work Items shell", description: "Checked that the provider-neutral Work Items shell is installed." });
    return "work-items-shell-ready";
  }
  [Symbol.dispose](): void { this.approvalQueue[Symbol.dispose]?.(); }
}

@validateRpc()
export class WorkItemsGatekeeper extends DurableObject<Cloudflare.Env, AccountProps> implements Gatekeeper<WorkItemsSession> {
  async describe(): Promise<ResourceDescription> {
    return { url: ACCOUNT_URL, title: "Work Items", snippet: "Provider-neutral Work Items shell for composed Jira and Zendesk sources.", suggestedBindingName: "WORK_ITEMS", tsType: "WorkItemsSession" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<WorkItemsSession> { return new WorkItemsSessionImpl(approvalQueue.dup()); }
  async getAgentCatalog(authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    await authorizer.authorizeObservation({ title: "Read Work Items catalog", description: "Listed the composed Work Items shell capability." });
    return { entries: [{ id: "work-items:shell", title: "Work Items shell", description: "Readiness marker only: ping() confirms installation, not provider connectivity. Search, reads, and mutations require separately authorized Jira or Zendesk bindings; management UI APIs are not callable on this session." }] };
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  applyAction(_action: number): never { throw new Error("Work Items shell does not apply provider actions."); }
  rejectAction(_action: number): never { throw new Error("Work Items shell does not queue provider actions."); }
  revertAction(_action: number): never { throw new Error("Work Items shell does not revert provider actions."); }
}

@validateRpc()
export class WorkItemsUser extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return describeWorkItemsAccount(); }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new Error("Work Items shell has no URL-addressed resources."); }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("Work Items shell has no URL-addressed resources."); }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  reconnect(): Promise<{ url: string }> { throw new Error("Work Items shell is auto-provisioned and has no connect flow."); }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getConnectionStatus(): Promise<{ state: "healthy"; message: string }> { return { state: "healthy", message: "Work Items shell is ready." }; }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WorkItemsSession>>> { return this.ctx.exports.WorkItemsGatekeeper({ props: this.ctx.props }); }
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> { return { iframeHtml: APP_HTML, ui: new NativeRpcStub(new WorkItemsShellApi(this.#account())) }; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.WorkItemsVerifier({}); }
  #account(): DurableObjectStub<WorkItemsAccount> { return this.ctx.exports.WorkItemsAccount.get(this.ctx.exports.WorkItemsAccount.idFromString(this.ctx.props.accountId)); }
}

@validateRpc()
export class WorkItemsVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Work Items", url: "https://github.com/totango/odie-os/tree/main/packages/gatekeeper-work-items", logo: ICON, tagline: "Unify Jira and Zendesk work", description: "Auto-provisioned provider-neutral UI shell that composes role-tagged Jira and Zendesk Work Items UI capabilities without owning provider credentials or agent authority.", autoProvisionsAccount: true, providesAuth: false };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.WorkItemsUser({ props: { accountId: this.ctx.exports.WorkItemsAccount.newUniqueId().toString() } }); }
  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("Work Items shell is auto-provisioned and has no connect flow."); }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export function normalizeCurrentUser(user: WorkItemsCurrentUser): WorkItemsCurrentUser {
  return { displayName: optionalBoundString(user?.displayName, 200), uniqueName: optionalBoundString(user?.uniqueName, 320) };
}

export function normalizeSavedView(view: WorkItemSavedView): WorkItemSavedView {
  const id = boundString(view?.id, MAX_ID).trim();
  if (!id || /[\r\n]/.test(id) || id.startsWith("builtin:")) throw new Error("Saved Work Items view id is invalid.");
  const name = boundString(view?.name, MAX_NAME).trim();
  if (!name) throw new Error("Saved Work Items view name is required.");
  const source = view.source === "jira" || view.source === "zendesk" || view.source === "both" ? view.source : "both";
  const filters = view.filters ?? { status: "", priority: "", type: "", person: "" };
  const hiddenStatuses = Array.isArray(view.hiddenStatuses) ? view.hiddenStatuses.slice(0, 80).map((value) => boundString(value, MAX_FILTER).trim()).filter(Boolean) : [];
  return {
    id,
    name,
    ...(view.assignedToMe === true ? { assignedToMe: true } : {}),
    query: boundString(view.query, MAX_QUERY),
    source,
    filters: {
      status: boundString(filters.status, MAX_FILTER),
      priority: boundString(filters.priority, MAX_FILTER),
      type: boundString(filters.type, MAX_FILTER),
      person: boundString(filters.person, MAX_FILTER),
    },
    view: view.view === "kanban" ? "kanban" : "list",
    hiddenStatuses,
  };
}

export function normalizeImportedSavedViews(views: WorkItemSavedView[]): WorkItemSavedView[] {
  const byId = new Map<string, WorkItemSavedView>();
  for (const view of views.slice(0, MAX_VIEWS)) {
    const normalized = normalizeSavedView(view);
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()].slice(0, MAX_VIEWS);
}

function optionalBoundString(value: unknown, max: number): string | undefined {
  const bounded = boundString(value, max).trim();
  return bounded || undefined;
}

function boundString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
