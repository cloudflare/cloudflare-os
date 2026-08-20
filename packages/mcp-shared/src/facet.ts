// Shared mechanics of an MCP gatekeeper facet. Connector-owned subclasses retain their Wrangler
// identity, props, labels, trust source, and account lookup.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import {
  createActionDispatchStoppedError,
  type ActionKind,
  type ApprovalQueue,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { ActionStore, REVERT_UNSUPPORTED_MESSAGE } from "./action-store.js";
import {
  CATALOG_TTL_MS,
  HydratedTools,
  scopedCatalog,
  type ScopedCatalog,
} from "./catalog.js";
import type { McpClient, McpTool } from "./client.js";
import {
  McpConnectionChangedError,
  withClient,
  type ConnectionAccount,
  type ConnectionEnv,
  type WithClientOptions,
} from "./connection.js";
import type { McpLog } from "./log.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./fetch.js";
import {
  isPortalNativeTool,
  looksLikePortal,
  PORTAL_LIST_SERVERS_TOOL,
} from "./portal.js";
import { formatToolScope, scopeAllows, type ToolScope } from "./scope.js";
import { matchesToolQuery, toolQueryTerms, MAX_SEARCH_RESULTS } from "./tool-search.js";
import { McpSessionBase, type McpSessionHost, type StoredAction } from "./session.js";
import { installToolMethods } from "./session-methods.js";
import { observerRefusalMessage } from "./sharing-policy.js";
import {
  actionKindFor,
  classifyTool,
  toolPolicyFingerprint,
  type ClassifiedTool,
  type ServerTrust,
} from "./tools.js";

type FacetProps = {
  endpoint: string;
  scope: ToolScope;
};

type SessionConstructor<Session extends McpSessionBase> = new (
  host: McpSessionHost,
  queue: RpcStub<ApprovalQueue>,
) => Session;

const MAX_CONCURRENT_DISCOVERIES = 4;
const MAX_QUEUED_DISCOVERIES = 32;

/** Common session, catalog, action, and sharing behavior for connector-owned MCP facets. */
export abstract class McpFacetBase<
  Env extends ConnectionEnv,
  Props extends FacetProps,
  Session extends McpSessionBase,
> extends DurableObject<Env, Props> implements Gatekeeper<Session>, McpSessionHost {
  #catalogPromise: Promise<ScopedCatalog> | undefined;
  #toolsFetchedAt = 0;
  #toolsTrust: ServerTrust | undefined;
  #actionStore: ActionStore | undefined;
  #hydrated = new HydratedTools();
  #activeDiscoveries = 0;
  #waitingDiscoveries: Array<() => void> = [];
  #resolvingCalls = new Map<string, Promise<{
    entry: ClassifiedTool;
    policyFingerprint: string;
    connectionGeneration: number;
  } | undefined>>();

  #actions(): ActionStore {
    return this.#actionStore ??= new ActionStore(this.ctx.storage.sql);
  }

  /** Connector-owned logger carrying the facet's safe identifying fields. */
  protected abstract get log(): McpLog;

  /** Current trust tier, read whenever catalog classification is used. */
  protected abstract get trust(): ServerTrust;

  /** Connector-decorated session class exposed through RPC. */
  protected abstract get sessionClass(): SessionConstructor<Session>;

  /** Namespace preventing approval policy from crossing resource boundaries. */
  protected abstract get actionScopeTag(): string;

  /** Human-readable resource named when refusing an observer. */
  protected abstract get observerName(): string;

  /** Connector-owned account capability used for endpoint calls. */
  protected abstract account(): ConnectionAccount;

  /** Human-readable server label used in observations and action prompts. */
  abstract get serverName(): string;

  /** Describes the connector-specific resource represented by this facet. */
  abstract describe(): Promise<ResourceDescription>;

  /** Generates the connector-specific TypeScript API for this facet. */
  abstract getTypeScriptTypes(): Promise<string>;

  /** The endpoint this facet is authorized to call. */
  get endpoint(): string {
    return this.ctx.props.endpoint;
  }

  /** The tool scope this facet is authorized to expose. */
  get scope(): ToolScope {
    return this.ctx.props.scope;
  }

  /** Canonical resource URL for this facet's endpoint and scope. */
  protected get resourceUrl(): string {
    return formatToolScope(this.endpoint, this.scope);
  }

  /** Returns this facet's scoped catalog and endpoint kind. */
  protected catalog(deadline?: number): Promise<ScopedCatalog> {
    const trust = this.trust;
    if (!this.#catalogPromise || this.#toolsTrust !== trust
        || Date.now() - this.#toolsFetchedAt > CATALOG_TTL_MS) {
      this.#toolsFetchedAt = Date.now();
      this.#toolsTrust = trust;
      const load = (operationDeadline: number) => scopedCatalog({
        store: this.ctx.storage.kv,
        log: this.log,
        env: this.env,
        account: this.account(),
        endpoint: this.endpoint,
        scope: this.scope,
        trust,
        deadline: operationDeadline,
      });
      const loading = deadline === undefined ? this.runDiscovery(load) : load(deadline);
      this.#catalogPromise = loading.catch(err => {
        this.#catalogPromise = undefined;
        throw err;
      });
    }
    return this.#catalogPromise;
  }

  /** Returns this facet's scoped and classified tool definitions. */
  async tools(): Promise<ClassifiedTool[]> {
    return (await this.catalog()).tools;
  }

  /** Runs Gadget-triggered catalog I/O within one facet-wide concurrency bound. */
  protected async runDiscovery<T>(operation: (deadline: number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + DEFAULT_REQUEST_TIMEOUT_MS;
    if (this.#activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) {
      if (this.#waitingDiscoveries.length >= MAX_QUEUED_DISCOVERIES) {
        throw new Error("Too many MCP discovery requests are already in progress.");
      }
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.#waitingDiscoveries.indexOf(resume);
          if (index >= 0) this.#waitingDiscoveries.splice(index, 1);
          reject(new Error("Timed out waiting to discover MCP tools."));
        }, Math.max(0, deadline - Date.now()));
        this.#waitingDiscoveries.push(resume);
      });
    } else {
      this.#activeDiscoveries++;
    }

    try {
      return await operation(deadline);
    } finally {
      const next = this.#waitingDiscoveries.shift();
      if (next) next();
      else this.#activeDiscoveries--;
    }
  }

  /** Searches the endpoint for granted tools by name, title, and description. */
  async searchTools(query: string): Promise<ClassifiedTool[]> {
    const terms = toolQueryTerms(query);
    return this.runDiscovery(async deadline => {
      const catalog = await this.catalog(deadline);
      if (!catalog.truncated) {
        return catalog.tools.filter(entry => matchesToolQuery(entry.tool, terms))
          .slice(0, MAX_SEARCH_RESULTS);
      }
      const { isPortal } = catalog;
      const tools = await this.call(
        client => client.listMatchingToolSummaries(
          MAX_SEARCH_RESULTS,
          tool => scopeAllows(this.scope, tool.name, isPortal) && matchesToolQuery(tool, terms),
        ),
        { deadline },
      );
      return tools.map(tool => classifyTool(tool, this.trust));
    });
  }

  /** Resolves one granted tool, fetching it when the described catalog omitted it. */
  async findTool(name: string): Promise<ClassifiedTool | undefined> {
    // Grant restrictions can be enforced without loading anything. A portal-native exclusion needs
    // the endpoint kind below, except for a server scope, which by definition belongs to a portal.
    if (!scopeAllows(this.scope, name, this.scope.serverId !== undefined)) return undefined;

    return this.runDiscovery(async deadline => {
      const catalog = await this.catalog(deadline);
      if (!scopeAllows(this.scope, name, catalog.isPortal)) return undefined;
      const described = catalog.tools.find(entry => entry.tool.name === name);
      if (described) return described;
      if (!catalog.truncated) return undefined;

      const load = (candidate: string) =>
        this.call(client => client.findTool(candidate), { deadline });
      const tool = await this.#hydrated.resolve(name, load);
      return tool && classifyTool(tool, this.trust);
    });
  }

  async #freshTool(
    client: McpClient,
    name: string,
    catalog: ScopedCatalog,
    deadline?: number,
  ): Promise<McpTool | undefined> {
    if (!catalog.isPortal && isPortalNativeTool(name)) {
      const probe = await client.listTools(
        2,
        tool => tool.name === name || tool.name === PORTAL_LIST_SERVERS_TOOL,
        deadline,
      );
      if (looksLikePortal(probe.tools, { truncated: probe.truncated, cap: 2 })) return undefined;
      return probe.tools.find(tool => tool.name === name);
    }
    return client.findTool(name, deadline);
  }

  /** Resolves current dispatch policy and the account generation it belongs to. */
  resolveToolForCall(name: string): Promise<{
    entry: ClassifiedTool;
    policyFingerprint: string;
    connectionGeneration: number;
  } | undefined> {
    const existing = this.#resolvingCalls.get(name);
    if (existing) return existing;
    const resolving = this.runDiscovery(async deadline => {
      if (!scopeAllows(this.scope, name, this.scope.serverId !== undefined)) return undefined;
      const catalog = await this.catalog(deadline);
      if (!scopeAllows(this.scope, name, catalog.isPortal)) return undefined;
      return this.call(async (client, connectionGeneration) => {
        const tool = await this.#freshTool(client, name, catalog);
        if (!tool) return undefined;
        const entry = classifyTool(tool, this.trust);
        return {
          entry,
          policyFingerprint: toolPolicyFingerprint(tool, this.trust),
          connectionGeneration,
        };
      }, { deadline });
    }).finally(() => {
      if (this.#resolvingCalls.get(name) === resolving) this.#resolvingCalls.delete(name);
    });
    this.#resolvingCalls.set(name, resolving);
    return resolving;
  }

  /** Returns action kinds that this facet's current catalog permits auto-approving. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return (await this.tools())
      .filter(entry => entry.autoApprovable)
      .map(entry => actionKindFor(this.actionScopeTag, entry.tool.name));
  }

  /** Starts a session with generated per-tool methods when the catalog is available. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session> {
    let SessionClass = this.sessionClass;
    try {
      SessionClass = installToolMethods(SessionClass, await this.tools());
    } catch (err) {
      this.log.warn("starting session without per-tool methods", {
        event: "session.tool-methods.unavailable", error: err,
      });
    }
    return new SessionClass(this, approvalQueue.dup());
  }

  /** Refuses observers so MCP bindings can only be opened by their owner. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(observerRefusalMessage(this.observerName));
  }

  /** Removes no observer state because observers are never admitted. */
  async removeObserver(_id: string): Promise<void> {}

  /** Stages an MCP action for approval. */
  stageAction(
    toolName: string,
    args: Record<string, unknown>,
    snapshot: { policyFingerprint: string; connectionGeneration: number },
  ): StoredAction {
    return this.#actions().stage(toolName, args, snapshot);
  }

  /** Discards an action whose approval submission failed. */
  discardStagedAction(id: number): void {
    this.#actions().discard(id);
  }

  /** Looks up a staged or completed action. */
  lookupAction(id: number): StoredAction | undefined {
    return this.#actions().get(id);
  }

  /** Applies an approved action without retrying an outcome-unknown write. */
  async applyAction(action: number): Promise<void> {
    const stored = this.#actions().get(action);
    if (!stored) throw new Error(`MCP action ${action} is unknown.`);
    const snapshotMissing = stored.connectionGeneration === undefined ||
      stored.policyFingerprint === undefined;
    const safeToRestage = stored.state === "pending" ||
      (stored.state === "failed" && stored.retryable !== false);
    if (snapshotMissing && safeToRestage) {
      const reason =
        "This MCP action predates current approval policy checks. Stage the call again.";
      this.#actions().markRestageRequired(action, reason);
      throw createActionDispatchStoppedError("restage", reason);
    }
    return this.#actions().apply(
      action,
      fn => this.call(async (client, connectionGeneration) => {
        const dispatch = await this.runDiscovery(async deadline => {
          const catalog = await this.catalog(deadline);
          if (stored.connectionGeneration === undefined || stored.policyFingerprint === undefined
              || connectionGeneration !== stored.connectionGeneration) {
            throw createActionDispatchStoppedError("invalidated",
              "This MCP connection changed after approval was requested. Stage the call again.");
          }
          if (!scopeAllows(this.scope, stored.toolName, catalog.isPortal)) {
            throw createActionDispatchStoppedError("invalidated",
              "This MCP tool is no longer allowed by the binding. Stage the call again.");
          }
          const tool = await this.#freshTool(client, stored.toolName, catalog, deadline);
          if (!tool || toolPolicyFingerprint(tool, this.trust) !== stored.policyFingerprint) {
            throw createActionDispatchStoppedError("invalidated",
              "This MCP tool's approval policy changed. Review and stage the call again.");
          }
          return () => fn(client);
        });
        return dispatch();
      }, { retryOnExpiry: false }).catch(error => {
        if (error instanceof McpConnectionChangedError) {
          throw createActionDispatchStoppedError("invalidated",
            "This MCP connection changed after approval was requested. Stage the call again.");
        }
        throw error;
      }),
      this.log,
    );
  }

  /** Rejects a pending action. */
  async rejectAction(action: number): Promise<void> {
    this.#actions().reject(action);
  }

  /** Reports that MCP actions cannot be reverted. */
  async revertAction(_action: number): Promise<{ message: string }> {
    return { message: REVERT_UNSUPPORTED_MESSAGE };
  }

  /** Runs a call against this facet's endpoint and account. */
  call<T>(
    fn: (client: McpClient, connectionGeneration: number) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T> {
    return withClient(this.env, this.account(), this.endpoint, fn, options);
  }

  /** Namespaces one tool's approval kind to this facet. */
  actionKindFor(toolName: string): ActionKind {
    return actionKindFor(this.actionScopeTag, toolName);
  }
}
