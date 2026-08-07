import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ParallelApi } from "./parallel-api.js";
import type {
  ParallelExtractResponse,
  ParallelRequestOptions,
  ParallelSearchResponse,
  ParallelSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & {
  PARALLEL_API_KEY?: string;
  PARALLEL_API_BASE_URL?: string;
};

const PARALLEL_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'>" +
      "<rect width='256' height='256' rx='48' fill='%230b1020'/>" +
      "<path d='M72 52h70c31 0 54 21 54 51s-23 51-54 51h-30v50H72V52zm40 37v28h27c10 0 17-5 17-14s-7-14-17-14h-27z' fill='white'/>" +
    "</svg>",
  ),
};

function apiFor(env: Env): ParallelApi {
  if (!env.PARALLEL_API_KEY) {
    throw new Error("The Parallel gatekeeper is not configured. Set PARALLEL_API_KEY.");
  }
  return new ParallelApi(env.PARALLEL_API_KEY, env.PARALLEL_API_BASE_URL);
}

@validateRpc()
export class ParallelSessionImpl extends RpcTarget implements ParallelSession {
  readonly #api: ParallelApi;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(api: ParallelApi, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
  }

  async search(
    objective: string,
    searchQueries: string[],
    options?: ParallelRequestOptions,
  ): Promise<ParallelSearchResponse> {
    const response = await this.#api.search(objective, searchQueries, options);
    await this.#approvalQueue.authorizeObservation({
      title: "Search the web with Parallel",
      description: `Returned ${response.results.length} public web result(s).`,
    });
    return response;
  }

  async extract(
    urls: string[],
    objective?: string,
    options?: ParallelRequestOptions,
  ): Promise<ParallelExtractResponse> {
    const response = await this.#api.extract(urls, objective, options);
    await this.#approvalQueue.authorizeObservation({
      title: "Extract web pages with Parallel",
      description:
        `Returned content from ${response.results.length} public URL(s); ` +
        `${response.errors.length} URL(s) failed.`,
    });
    return response;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class ParallelGatekeeper extends DurableObject<Env>
  implements Gatekeeper<ParallelSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "parallel://web",
      title: "Parallel Web",
      snippet: "Search the live web and extract LLM-optimized content from public URLs.",
      suggestedBindingName: "PARALLEL",
      tsType: "ParallelSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ParallelSession> {
    return new ParallelSessionImpl(apiFor(this.env), approvalQueue.dup());
  }

  async getAgentCatalog(
    _request: AgentCatalogRequest,
    _authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("Parallel is read-only and implements no actions.");
  }
  rejectAction(_action: number): Promise<void> {
    throw new Error("Parallel is read-only and implements no actions.");
  }
  revertAction(_action: number): Promise<void> {
    throw new Error("Parallel is read-only and implements no actions.");
  }
}

@validateRpc()
export class ParallelVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class ParallelAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Parallel",
      avatar: PARALLEL_ICON,
      singleton: { tsType: "ParallelSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ParallelSession>>> {
    return this.ctx.exports.ParallelGatekeeper;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Parallel has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Parallel has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  async revoke(): Promise<void> {}
  reconnect(): Promise<{ url: string }> {
    throw new Error("Parallel uses a deployment API key and has no reconnect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ParallelVerifier({});
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Parallel",
      url: "https://parallel.ai/",
      logo: PARALLEL_ICON,
      tagline: "Search and extract the live web",
      description:
        "Give agents read-only access to Parallel's web search and extraction APIs. " +
        "The deployment API key stays inside the Gatekeeper Worker.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    apiFor(this.env);
    return this.ctx.exports.ParallelAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Parallel is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Parallel gatekeeper is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
