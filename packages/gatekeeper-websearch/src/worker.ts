// Web Search: an auto-provisioned gatekeeper whose account gives the agent a `WEB_SEARCH` binding
// that searches the public web with Cloudflare's Web Search API. README.md explains the design.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { search } from "./search.js";
import type { WebSearchResult, WebSearchSession } from "./types.js";
import TYPES_CODE from "./types.txt";

const WEB_SEARCH_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M229.66 218.34l-50.07-50.06a88.11 88.11 0 1 0-11.31 11.31l50.06 50.07a8 8 0 0 0 11.32-11.32ZM40 112a72 72 0 1 1 72 72 72.08 72.08 0 0 1-72-72Z'/></svg>",
    ),
};

@validateRpc()
class WebSearchSessionImpl extends RpcTarget implements WebSearchSession {
  readonly #ai: Ai;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(ai: Ai, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#ai = ai;
    this.#approvalQueue = approvalQueue;
  }

  /** Searches the web, recording the query first. */
  search(query: string): Promise<WebSearchResult[]> {
    return search(this.#ai, query,
        description => this.#approvalQueue.authorizeObservation(description));
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }
}

@validateRpc()
export class WebSearchGatekeeper
  extends DurableObject<Cloudflare.Env>
  implements Gatekeeper<WebSearchSession>
{
  /** Describes the ambient Web Search binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "websearch://web",
      title: "Web Search",
      snippet: "Search the public web.",
      suggestedBindingName: "WEB_SEARCH",
      tsType: "WebSearchSession",
    };
  }

  /** Returns the agent-facing WebSearchSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Reports that Web Search has no actions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session that records each query through `approvalQueue`. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<WebSearchSession> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new WebSearchSessionImpl(this.env.AI, approvalQueue.dup());
  }

  /** Returns no catalog: the binding's types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: search results are public. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("Web Search implements no actions.");
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error("Web Search implements no actions.");
  }

  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Web Search implements no actions.");
  }
}

@validateRpc()
export class WebSearchAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account: an agent singleton and no management UI. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Web Search",
      avatar: WEB_SEARCH_ICON,
      singleton: { tsType: "WebSearchSession" },
    };
  }

  /** Returns the workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebSearchSession>>> {
    return this.ctx.exports.WebSearchGatekeeper({});
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: the account holds no credentials and no state. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Web Search has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Web Search has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier that goes with admitting every observer. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebSearchVerifier({});
  }
}

@validateRpc()
export class WebSearchVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Web Search vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Web Search",
      url: "https://developers.cloudflare.com/web-search/",
      logo: WEB_SEARCH_ICON,
      tagline: "Search the public web",
      description: "Let the agent and gadgets search the public web with Cloudflare's Web Search API.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints a new account. All accounts are alike: none holds credentials or state. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebSearchAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Web Search is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the agent-facing WebSearchSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
