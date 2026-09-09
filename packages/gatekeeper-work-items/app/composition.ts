import type {
  WorkItemAttachmentContent,
  WorkItemAttachmentUploadInput,
  WorkItemAttachmentUploadResult,
  WorkItemDetail,
  WorkItemFieldPatch,
  WorkItemLinkResult,
  WorkItemManagementApi,
  WorkItemMediaCapabilities,
  WorkItemProviderError,
  WorkItemProviderKind,
  WorkItemProviderRef,
  WorkItemRead,
  WorkItemSearchPage,
  WorkItemSearchRequest,
  WorkItemSourceStatus,
  WorkItemSourceStatuses,
  WorkItemsCurrentUser,
  WorkItemsManagementApi,
  WorkItemsShellMetadataApi,
  WorkItemsSourceManagementApi,
} from "../src/types";

export type GatekeeperAppInfo = {
  id: string;
  vendorId: string;
  title: string;
  composition?: { kind: string; role?: string; embeddedOnly?: boolean };
};

export type WorkItemsShellRuntimeApi = Pick<WorkItemsShellMetadataApi, "listSavedViews" | "saveSavedView" | "deleteSavedView">;

export interface HostCompositionApi {
  readonly ui: WorkItemsShellRuntimeApi;
  listCapabilities(): Promise<GatekeeperAppInfo[]>;
  getCapability(id: string): Promise<WorkItemsSourceManagementApi | null>;
}

type SourceMap = Partial<Record<WorkItemProviderKind, WorkItemsSourceManagementApi>>;
type SourceErrors = Partial<Record<WorkItemProviderKind, string>>;
type LoadedSources = { sources: SourceMap; errors: SourceErrors };

const REQUIRED_SOURCE_METHODS = ["getCurrentUser", "getSourceStatuses", "search", "item"] as const;
const REQUIRED_ITEM_METHODS = ["read", "readAttachment", "mediaCapabilities", "createAttachment", "addComment", "updateFields", "transition", "linkTo"] as const;
const CROSS_PROVIDER_LINKING_DISABLED = "Cross-provider Work Items linking is disabled until both provider sources expose trusted URLs and a supported link operation.";

export async function composeWorkItemsApi(host: HostCompositionApi): Promise<WorkItemsManagementApi> {
  const { sources, errors } = await loadSources(host);
  return new CompositeWorkItemsApi(host.ui, sources, errors);
}

async function loadSources(host: HostCompositionApi): Promise<LoadedSources> {
  let capabilities: GatekeeperAppInfo[];
  try { capabilities = await host.listCapabilities(); }
  catch (caught) {
    const reason = `Provider discovery failed: ${safeMessage(caught)}`;
    return { sources: {}, errors: { jira: reason, zendesk: reason } };
  }
  const selected = new Map<WorkItemProviderKind, GatekeeperAppInfo>();
  for (const app of capabilities) {
    const role = validWorkItemsSourceRole(app);
    if (role) selected.set(role, app);
  }
  const loaded = await Promise.all([...selected].map(async ([source, app]) => {
    let capability: WorkItemsSourceManagementApi | null;
    try { capability = await host.getCapability(app.id); }
    catch (caught) { return { source, error: safeMessage(caught) } as const; }
    if (!capability) return { source, error: `No ${source} Work Items source is connected.` } as const;
    const error = missingMethod(capability, REQUIRED_SOURCE_METHODS, `${source} Work Items source`);
    if (error) return { source, error } as const;
    return { source, capability } as const;
  }));
  return {
    sources: Object.fromEntries(loaded.flatMap((entry) => "capability" in entry ? [[entry.source, entry.capability] as const] : [])),
    errors: Object.fromEntries(loaded.flatMap((entry) => "error" in entry ? [[entry.source, entry.error] as const] : [])),
  };
}

function validWorkItemsSourceRole(app: GatekeeperAppInfo): WorkItemProviderKind | undefined {
  const role = app.composition?.role;
  if ((role !== "jira" && role !== "zendesk") || app.composition?.kind !== "work-items" || app.composition.embeddedOnly !== true) {
    return undefined;
  }
  return app.vendorId === role ? role : undefined;
}

class CompositeWorkItemsApi implements WorkItemsManagementApi {
  constructor(private readonly shell: WorkItemsShellRuntimeApi, private readonly sources: SourceMap, private readonly sourceErrors: SourceErrors) {}

  async getCurrentUser(): Promise<WorkItemsCurrentUser> {
    const users = await Promise.all((["jira", "zendesk"] as const).map(async (source) => {
      const capability = this.sources[source];
      if (!capability) return undefined;
      try { return await capability.getCurrentUser(); }
      catch { return undefined; }
    }));
    return mergeUsers(users);
  }
  listSavedViews(): ReturnType<WorkItemsManagementApi["listSavedViews"]> { return this.shell.listSavedViews(); }
  saveSavedView: WorkItemsManagementApi["saveSavedView"] = (view) => this.shell.saveSavedView(view);
  deleteSavedView: WorkItemsManagementApi["deleteSavedView"] = (id) => this.shell.deleteSavedView(id);

  async getSourceStatuses(): Promise<WorkItemSourceStatuses> {
    const [jira, zendesk] = await Promise.all([this.sourceStatus("jira"), this.sourceStatus("zendesk")]);
    return { jira, zendesk };
  }

  async search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage> {
    const sources = request.source === "both" ? (["jira", "zendesk"] as const) : ([request.source] as const);
    const pages = await Promise.all(sources.map((source) => this.searchOne(source, request)));
    const items = pages.flatMap((page) => page.ok ? page.page.items : []);
    const errors = pages.flatMap((page) => page.ok ? page.errors : [page.error]);
    return {
      items,
      cursors: Object.assign({}, ...pages.map((page) => page.ok ? page.page.cursors : {})),
      hasMore: Object.assign({}, ...pages.map((page) => page.ok ? page.page.hasMore : { [page.error.source]: false })),
      truncated: Object.assign({}, ...pages.map((page) => page.ok ? page.page.truncated : { [page.error.source]: false })),
      // A source that never answered cannot have exhausted anything.
      completeness: Object.assign({}, ...pages.map((page) => page.ok ? page.page.completeness : { [page.error.source]: false })),
      ...(errors.length ? { errors } : {}),
    };
  }

  async item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi> {
    const normalized = normalizeRef(ref);
    const primary = await this.requireSource(normalized.source).item(providerSelectionRef(normalized));
    assertMethods(primary, REQUIRED_ITEM_METHODS, `${normalized.source} Work Items item`);
    return new CompositeWorkItemApi(normalized, primary);
  }

  private async sourceStatus(source: WorkItemProviderKind): Promise<WorkItemSourceStatus> {
    const capability = this.sources[source];
    if (!capability) return { configured: false, connected: false, reason: this.sourceErrors[source] ?? `No ${source} Work Items source is connected.` };
    try {
      const statuses = await capability.getSourceStatuses();
      return statuses[source] ?? { configured: true, connected: false, reason: "Provider returned no connection status. Retry loading providers." };
    } catch (caught) {
      return { configured: true, connected: false, reason: safeMessage(caught) };
    }
  }

  private async searchOne(source: WorkItemProviderKind, request: WorkItemSearchRequest): Promise<{ ok: true; page: WorkItemSearchPage; errors: WorkItemProviderError[] } | { ok: false; error: WorkItemProviderError }> {
    try {
      const page = await this.requireSource(source).search({ ...request, source });
      const { items, errors } = normalizeSearchItems(source, page.items);
      const providerErrors = [...(page.errors ?? []), ...errors];
      return {
        ok: true,
        errors: providerErrors,
        page: {
          items,
          // A source may only speak for itself; scoping stops one provider seeding another provider's cursor or status.
          cursors: scopeToSource(source, page.cursors, isNonEmptyString),
          hasMore: scopeToSource(source, page.hasMore, isBoolean),
          truncated: scopeToSource(source, page.truncated, isBoolean),
          completeness: { [source]: resolveCompleteness(source, page, providerErrors) },
        },
      };
    } catch (caught) {
      return { ok: false, error: { source, message: safeMessage(caught) } };
    }
  }

  private requireSource(source: WorkItemProviderKind): WorkItemsSourceManagementApi {
    const capability = this.sources[source];
    if (!capability) throw new Error(this.sourceErrors[source] ?? `No ${source} Work Items source is connected.`);
    return capability;
  }
}

class CompositeWorkItemApi implements WorkItemManagementApi {
  constructor(private readonly ref: WorkItemProviderRef, private readonly primary: WorkItemManagementApi) {}
  read(): Promise<WorkItemRead> { return this.primary.read(); }
  readAttachment(id: string): Promise<WorkItemAttachmentContent> { return this.primary.readAttachment(id); }
  mediaCapabilities(): Promise<WorkItemMediaCapabilities> { return this.primary.mediaCapabilities(); }
  createAttachment(input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult> { return this.primary.createAttachment(input); }
  addComment(input: { body: string; visibility?: "internal" | "public"; attachmentTokens?: string[] }): Promise<WorkItemDetail> { return this.primary.addComment(input); }
  updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail> { return this.primary.updateFields(patch); }
  transition(transitionId: string): Promise<WorkItemDetail> { return this.primary.transition(transitionId); }
  async linkTo(other: WorkItemProviderRef): Promise<WorkItemLinkResult> {
    const normalizedOther = normalizeRef(other);
    if (normalizedOther.source !== this.ref.source) {
      throw new Error(CROSS_PROVIDER_LINKING_DISABLED);
    }
    return this.primary.linkTo(providerSelectionRef(normalizedOther));
  }
  [Symbol.dispose](): void { disposeWorkItemApi(this.primary); }
}

function isBoolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value !== ""; }

function scopeToSource<T>(source: WorkItemProviderKind, map: Partial<Record<WorkItemProviderKind, unknown>> | undefined, valid: (value: unknown) => value is T): Partial<Record<WorkItemProviderKind, T>> {
  const value = map?.[source];
  return valid(value) ? { [source]: value } : {};
}

/**
 * Resolves whether one provider exhausted its entire matching source. A provider that reports `completeness` is
 * trusted only to say "incomplete": any local failure or dropped item overrides a `true` it cannot know about.
 * Providers that omit it — Jira today — are derived conservatively from `hasMore`, `truncated`, and errors.
 */
function resolveCompleteness(source: WorkItemProviderKind, page: WorkItemSearchPage, errors: WorkItemProviderError[]): boolean {
  if (errors.some((error) => error.source === source)) return false;
  if (page.hasMore?.[source] === true || page.truncated?.[source] === true) return false;
  const declared = page.completeness?.[source];
  return isBoolean(declared) ? declared : page.hasMore?.[source] === false;
}

function normalizeSearchItems(source: WorkItemProviderKind, items: WorkItemSearchPage["items"]): { items: WorkItemSearchPage["items"]; errors: WorkItemProviderError[] } {
  const normalized = [] as WorkItemSearchPage["items"];
  const errors: WorkItemProviderError[] = [];
  for (const item of items) {
    try {
      const ref = normalizeRef(item);
      if (ref.source !== source) throw new Error(`Provider returned ${ref.source} item in ${source} search results.`);
      normalized.push({ ...item, ...ref, url: safeProviderUrl(item.url) });
    } catch (caught) {
      errors.push({ source, message: `Dropped malformed ${source} search result: ${safeMessage(caught)}` });
    }
  }
  return { items: normalized, errors };
}

function normalizeRef(ref: WorkItemProviderRef): WorkItemProviderRef {
  if (ref?.source !== "jira" && ref?.source !== "zendesk") throw new Error("Work Item ref source is invalid.");
  const id = typeof ref.id === "string" ? ref.id.trim() : "";
  if (!id) throw new Error(`${ref.source} Work Item ref id is required.`);
  const key = typeof ref.key === "string" && ref.key.trim() ? ref.key.trim().slice(0, 160) : undefined;
  const url = safeProviderUrl(ref.url);
  return { source: ref.source, id: id.slice(0, 1_000), ...(key ? { key } : {}), ...(url ? { url } : {}) };
}

function providerSelectionRef(ref: WorkItemProviderRef): WorkItemProviderRef {
  if (ref.source === "jira" && ref.url) return { ...ref, id: ref.url };
  return ref;
}

function safeProviderUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeMessage(caught: unknown): string {
  return (caught instanceof Error ? caught.message : String(caught)).slice(0, 512);
}

function assertMethods(target: object, methods: readonly string[], label: string): void {
  const missing = missingMethod(target, methods, label);
  if (missing) throw new Error(missing);
}

function missingMethod(target: object, methods: readonly string[], label: string): string | undefined {
  for (const method of methods) {
    if (typeof (target as Record<string, unknown>)[method] !== "function") {
      return `${label} does not implement required Work Items composition method ${method}.`;
    }
  }
  return undefined;
}

function mergeUsers(users: Array<WorkItemsCurrentUser | undefined>): WorkItemsCurrentUser {
  const valid = users.filter((user): user is WorkItemsCurrentUser => !!(user?.uniqueName || user?.displayName));
  const complete = valid.find((user) => user.uniqueName && user.displayName);
  if (complete) return { displayName: complete.displayName, uniqueName: complete.uniqueName };
  return {
    displayName: valid.find((user) => user.displayName)?.displayName,
    uniqueName: valid.find((user) => user.uniqueName)?.uniqueName,
  };
}

function disposeWorkItemApi(api: WorkItemManagementApi): void {
  try {
    const disposable = api as Partial<Disposable>;
    disposable[Symbol.dispose]?.();
  } catch {
    // Best-effort cleanup; disposal must not mask the provider operation result.
  }
}
