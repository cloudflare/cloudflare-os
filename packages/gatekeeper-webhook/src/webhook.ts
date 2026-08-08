import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { mintEndpointId, normalizeRegisterOptions } from "./endpoint-core.js";
import WEBHOOK_CONFIGURATOR_HTML from "./generated/webhook-configurator-ui.txt";
import type { EndpointRegistry } from "./endpoint-registry.js";
import type {
  ManagementDeliveryPage,
  ManagementEndpointPage,
  ManagementListOptions,
} from "./management-types.js";
import type {
  DeliverySummary,
  EndpointCredentials,
  EndpointSummary,
  RegisterEndpointOptions,
  WebhookEndpointSession,
  WebhookHook,
  WebhookSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

const WEBHOOK_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M104 96a24 24 0 1 1 36 20.78l25.65 44.35A8 8 0 0 1 160 176h-11.06a32 32 0 1 1-53.79 21.2 8 8 0 0 1 15.92-1.6A16 16 0 1 0 128 176a8 8 0 0 1-6.93-12l30-51.85A8 8 0 0 1 104 96Zm88 40a55.7 55.7 0 0 0-19.61 3.55l-8.1-14A72 72 0 1 1 96.4 62.11a8 8 0 0 1 9.51 12.83A56 56 0 1 0 192 216a8 8 0 0 1 0 16 72 72 0 0 1 0-144Z'/></svg>",
    ),
};

/**
 * The endpoint resource type offered in a workspace's "Connect resource" picker. One binding is one
 * endpoint, which is what lets a workspace run several independent webhook flows side by side: each
 * endpoint is bound under its own name, delivers to its own gadget, and therefore reaches only that
 * gadget's connections.
 */
function endpointResource(env: Cloudflare.Env): SupportedResource {
  return {
    urlPattern: `${env.BASE_URL.replace(/\/+$/, "")}/e/:endpointId`,
    title: "Webhook endpoint",
    description: "An inbound URL a third-party service can POST events to.",
    icon: WEBHOOK_ICON,
  };
}

/** Parses an endpoint ID out of a concrete resource URL, rejecting anything not ours. */
function endpointIdFromUrl(env: Cloudflare.Env, url: string): string {
  const base = new URL(env.BASE_URL);
  const parsed = new URL(url);
  if (parsed.origin !== base.origin) {
    throw new Error(`URL origin ${parsed.origin} is not this deployment's webhook origin.`);
  }
  const prefix = `${base.pathname.replace(/\/+$/, "")}/e/`;
  if (!parsed.pathname.startsWith(prefix)) {
    throw new Error(`URL path ${parsed.pathname} is not a webhook endpoint URL.`);
  }
  const endpointId = parsed.pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{22}$/.test(endpointId)) {
    throw new Error("Malformed webhook endpoint URL.");
  }
  return endpointId;
}

type WebhookHookTarget = RpcTarget & WebhookHook;
type WebhookInitiator = Fetcher<HookInitiator<WebhookHookTarget>>;

/** Immutable identity baked into one endpoint's hook controller. */
export type WebhookControllerProps = {
  accountId: string;
  workspaceId: string;
  endpointId: string;
};

type ControllerFactory = (
  props: WebhookControllerProps,
) => Fetcher<HookController<WebhookHookTarget>>;

type SessionRegistry = Pick<
  EndpointRegistry,
  "register" | "listWorkspace" | "rotateToken" | "revokeEndpoint" | "listDeliveries"
>;

export type WebhookSessionDependencies = {
  accountId: string;
  workspaceId: string;
  approvalQueue: NativeRpcStub<ApprovalQueue>;
  controllerFactory: ControllerFactory;
  registry: SessionRegistry;
  claimEndpointId: (endpointId: string, accountId: string) => Promise<void>;
  newEndpointId?: () => string;
};

@validateRpc()
export class WebhookSessionImpl extends RpcTarget implements WebhookSession {
  readonly #accountId: string;
  readonly #workspaceId: string;
  readonly #approvalQueue: NativeRpcStub<ApprovalQueue>;
  readonly #controllerFactory: ControllerFactory;
  readonly #registry: SessionRegistry;
  readonly #claimEndpointId: (endpointId: string, accountId: string) => Promise<void>;
  readonly #newEndpointId: () => string;

  constructor(dependencies: WebhookSessionDependencies) {
    super();
    this.#accountId = dependencies.accountId;
    this.#workspaceId = dependencies.workspaceId;
    this.#approvalQueue = dependencies.approvalQueue;
    this.#controllerFactory = dependencies.controllerFactory;
    this.#registry = dependencies.registry;
    this.#claimEndpointId = dependencies.claimEndpointId;
    this.#newEndpointId = dependencies.newEndpointId ?? mintEndpointId;
  }

  /** Mints an endpoint and binds a disabled hook that will deliver into this workspace. */
  async register(
    callback: NativeRpcStub<WebhookHookTarget>,
    options: RegisterEndpointOptions,
  ): Promise<EndpointCredentials> {
    const normalized = normalizeRegisterOptions(options);
    const endpointId = this.#newEndpointId();
    // Claim the public ID before the endpoint exists: a claimed ID with no endpoint 404s, while an
    // endpoint with no claim would be a URL that never resolves.
    await this.#claimEndpointId(endpointId, this.#accountId);
    const credentials = await this.#registry.register(this.#workspaceId, endpointId, normalized);
    try {
      const controller = this.#controllerFactory({
        accountId: this.#accountId,
        workspaceId: this.#workspaceId,
        endpointId,
      });
      await this.#approvalQueue.bindHook(
        // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
        controller,
        callback,
        // bindHook takes only the display metadata; the endpoint itself stays in the registry.
        { title: normalized.title, description: normalized.description },
      );
    } catch (error) {
      // Without a hook the endpoint could never be enabled, so don't leave a dead URL behind.
      await this.#registry.revokeEndpoint(endpointId, this.#workspaceId);
      throw error;
    }
    return credentials;
  }

  /** Lists this workspace's endpoints after observation authorization. */
  async list(): Promise<EndpointSummary[]> {
    const endpoints = await this.#registry.listWorkspace(this.#workspaceId);
    await this.#approvalQueue.authorizeObservation({
      title: "List webhook endpoints",
      description: "List the inbound webhook endpoints registered for this workspace.",
    });
    return endpoints;
  }

  /** Replaces an endpoint's bearer token, leaving its URL unchanged. */
  rotateToken(endpointId: string): Promise<EndpointCredentials> {
    return this.#registry.rotateToken(endpointId, this.#workspaceId);
  }

  /** Deletes an endpoint owned by this workspace. */
  revoke(endpointId: string): Promise<void> {
    return this.#registry.revokeEndpoint(endpointId, this.#workspaceId);
  }

  /** Reports recent deliveries after observation authorization. Bodies are never retained. */
  async deliveries(endpointId?: string, limit?: number): Promise<DeliverySummary[]> {
    const deliveries = await this.#registry.listDeliveries(endpointId, this.#workspaceId, limit);
    await this.#approvalQueue.authorizeObservation({
      title: "Read webhook delivery history",
      description: endpointId
        ? `Read recent delivery outcomes for webhook endpoint ${endpointId}.`
        : "Read recent webhook delivery outcomes for this workspace.",
    });
    return deliveries;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class WebhookHookController
  extends WorkerEntrypoint<Cloudflare.Env, WebhookControllerProps>
  implements HookController<WebhookHookTarget>
{
  /** Activates the endpoint, recording the gadget its deliveries land in. */
  enable(initiator: WebhookInitiator, target: HookTargetMetadata): Promise<void> {
    const { accountId: _accountId, workspaceId, endpointId } = this.ctx.props;
    return this.#registry().enable(workspaceId, endpointId, initiator, target.gadgetId);
  }

  /** Pauses the endpoint and drops its delivery capability. The URL and token survive. */
  disable(): Promise<void> {
    const { workspaceId, endpointId } = this.ctx.props;
    return this.#registry().disable(workspaceId, endpointId);
  }

  #registry(): DurableObjectStub<EndpointRegistry> {
    return this.ctx.exports.EndpointRegistry.getByName(this.ctx.props.accountId);
  }
}

@validateRpc()
export class WebhookGatekeeper
  extends DurableObject<Cloudflare.Env, { accountId: string }>
  implements Gatekeeper<WebhookSession>
{
  /** Describes the ambient Webhooks binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "webhook://endpoints",
      title: "Webhooks",
      snippet: "Receive inbound HTTP webhooks from third-party services in this workspace.",
      suggestedBindingName: "WEBHOOKS",
      tsType: "WebhookSession",
      hookTsType: "WebhookHook",
    };
  }

  /** Returns the agent-facing WebhookSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Reports that Webhooks has no auto-applicable actions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session scoped only by this facet's inherited workspace ID. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<WebhookSession> {
    const workspaceId = this.ctx.id.toString();
    // Smoke check only; the facet's inherited ID is the real scope (see the scope test).
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited webhook workspace scope.");
    }
    return new WebhookSessionImpl({
      accountId: this.ctx.props.accountId,
      workspaceId,
      approvalQueue: approvalQueue.dup(),
      controllerFactory: (props) => this.ctx.exports.WebhookHookController({ props }),
      registry: this.ctx.exports.EndpointRegistry.getByName(this.ctx.props.accountId),
      claimEndpointId: (endpointId, accountId) =>
        this.ctx.exports.EndpointIndex.getByName(endpointId).claim(accountId),
    });
  }

  /** Returns no catalog because endpoint discovery happens through list(). */
  async getAgentCatalog(
    _request: AgentCatalogRequest,
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  /**
   * Accepts collaborators under the low-stakes observer policy: an endpoint is a URL minted by this
   * workspace for this workspace, so its collaborators are the intended audience and no third party
   * independently holds access to it.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  /** Rejects action application because Webhooks submits no actions. */
  applyAction(_action: number): Promise<void> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }

  /** Rejects action rejection because Webhooks submits no actions. */
  rejectAction(_action: number): Promise<void> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }

  /** Rejects action reversion because Webhooks submits no actions. */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }
}

type EndpointRegistryFacet = Pick<
  EndpointRegistry,
  "adopt" | "getEndpoint" | "rotateToken" | "revokeEndpoint" | "listDeliveries"
>;

/**
 * The session a gadget gets from a bound webhook endpoint. It is deliberately narrower than the
 * ambient `WebhookSession`: it cannot create or enumerate endpoints, only operate the one it is
 * bound to. That is what keeps several endpoints in one workspace independent — a gadget holding
 * the "alerts" binding can attach a handler to that endpoint and nothing else.
 */
@validateRpc()
export class WebhookEndpointSessionImpl extends RpcTarget implements WebhookEndpointSession {
  constructor(
    private readonly deps: {
      accountId: string;
      workspaceId: string;
      endpointId: string;
      approvalQueue: NativeRpcStub<ApprovalQueue>;
      controllerFactory: ControllerFactory;
      registry: EndpointRegistryFacet;
    },
  ) {
    super();
  }

  /**
   * Attaches this gadget's persistent callback to the endpoint, binding a disabled hook. Enable it
   * in Connections to start delivery. Calling this again replaces the binding.
   */
  async onWebhook(callback: NativeRpcStub<WebhookHookTarget>): Promise<void> {
    const { accountId, workspaceId, endpointId, registry } = this.deps;
    const endpoint = await registry.getEndpoint(endpointId, workspaceId);
    if (!endpoint) throw new Error("This webhook endpoint no longer exists.");
    const controller = this.deps.controllerFactory({ accountId, workspaceId, endpointId });
    await this.deps.approvalQueue.bindHook(
      // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
      controller,
      callback,
      { title: endpoint.title, description: endpoint.description },
    );
  }

  /** This endpoint's current state, including whether a token has been issued for it yet. */
  async describe(): Promise<EndpointSummary> {
    const endpoint = await this.deps.registry.getEndpoint(
      this.deps.endpointId, this.deps.workspaceId,
    );
    if (!endpoint) throw new Error("This webhook endpoint no longer exists.");
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read webhook endpoint details",
      description: `Read the configuration of webhook endpoint ${this.deps.endpointId}.`,
    });
    return endpoint;
  }

  /** Mints a replacement token for this endpoint, invalidating the previous one immediately. */
  rotateToken(): Promise<EndpointCredentials> {
    return this.deps.registry.rotateToken(this.deps.endpointId, this.deps.workspaceId);
  }

  /** Recent deliveries to this endpoint, newest first. Bodies are never retained. */
  async deliveries(limit?: number): Promise<DeliverySummary[]> {
    const deliveries = await this.deps.registry.listDeliveries(
      this.deps.endpointId, this.deps.workspaceId, limit,
    );
    await this.deps.approvalQueue.authorizeObservation({
      title: "Read webhook delivery history",
      description: `Read recent delivery outcomes for webhook endpoint ${this.deps.endpointId}.`,
    });
    return deliveries;
  }

  [Symbol.dispose](): void {
    this.deps.approvalQueue[Symbol.dispose]?.();
  }
}

type WebhookEndpointProps = { accountId: string; endpointId: string };

/** One bound webhook endpoint, as seen by the gadget that holds the binding. */
@validateRpc()
export class WebhookEndpointGatekeeper
  extends DurableObject<Cloudflare.Env, WebhookEndpointProps>
  implements Gatekeeper<WebhookEndpointSessionImpl>
{
  async describe(): Promise<ResourceDescription> {
    const endpoint = await this.#registry().getEndpoint(this.ctx.props.endpointId);
    const url = `${this.env.BASE_URL.replace(/\/+$/, "")}/e/${this.ctx.props.endpointId}`;
    return {
      url,
      title: endpoint?.title ?? "Webhook endpoint",
      snippet: endpoint?.description ?? "An inbound URL a third-party service can POST events to.",
      suggestedBindingName: "WEBHOOK",
      tsType: "WebhookEndpointSession",
      hookTsType: "WebhookHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session scoped to this endpoint and to this facet's inherited workspace ID. */
  async startSession(
    approvalQueue: NativeRpcStub<ApprovalQueue>,
  ): Promise<WebhookEndpointSessionImpl> {
    const workspaceId = this.ctx.id.toString();
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited webhook workspace scope.");
    }
    const registry = this.#registry();
    // The configurator created this endpoint with no workspace to attribute it to; binding it into
    // a workspace is what assigns it, and a second workspace is refused rather than silently
    // redirecting a live URL.
    await registry.adopt(this.ctx.props.endpointId, workspaceId);
    return new WebhookEndpointSessionImpl({
      accountId: this.ctx.props.accountId,
      workspaceId,
      endpointId: this.ctx.props.endpointId,
      approvalQueue: approvalQueue.dup(),
      controllerFactory: (props) => this.ctx.exports.WebhookHookController({ props }),
      registry,
    });
  }

  async getAgentCatalog(
    _request: AgentCatalogRequest,
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }
  rejectAction(_action: number): Promise<void> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Webhooks is inbound-only and implements no actions.");
  }

  #registry(): DurableObjectStub<EndpointRegistry> {
    return this.ctx.exports.EndpointRegistry.getByName(this.ctx.props.accountId);
  }
}

/**
 * The capability the endpoint configurator frame talks to. It mints the endpoint when the form is
 * submitted and returns its URL, which becomes the binding's resource URL.
 */
@validateRpc()
export class WebhookEndpointConfiguratorUI extends RpcTarget {
  constructor(
    private readonly deps: {
      accountId: string;
      registry: Pick<EndpointRegistry, "createWithoutToken">;
      claimEndpointId: (endpointId: string, accountId: string) => Promise<void>;
      newEndpointId?: () => string;
    },
  ) {
    super();
  }

  /**
   * Creates the endpoint and returns its URL. No token is issued here — see
   * `EndpointRegistry.createWithoutToken`.
   */
  async createEndpoint(title: string, description: string, methods?: string): Promise<string> {
    const normalized = normalizeRegisterOptions({
      title,
      description,
      ...(methods ? { methods: methods.split(",").map((m) => m.trim()).filter(Boolean) } : {}),
    });
    const endpointId = (this.deps.newEndpointId ?? mintEndpointId)();
    await this.deps.claimEndpointId(endpointId, this.deps.accountId);
    const { url } = await this.deps.registry.createWithoutToken("", endpointId, normalized);
    return url;
  }
}

@validateRpc()
export class WebhookManagementApi extends RpcTarget {
  constructor(
    private readonly registry: Pick<
      EndpointRegistry,
      "listAccount" | "listDeliveries" | "rotateToken" | "revokeEndpoint"
    >,
  ) {
    super();
  }

  /** Lists endpoints across this account. */
  list(options?: ManagementListOptions): Promise<ManagementEndpointPage> {
    return this.registry.listAccount(options);
  }

  /** Reports recent deliveries for one endpoint. */
  async deliveries(endpointId: string): Promise<ManagementDeliveryPage> {
    return { deliveries: await this.registry.listDeliveries(endpointId) };
  }

  /**
   * Mints a replacement token. This is a mutation the user must be able to perform without an
   * agent: a leaked webhook token needs to be cut off immediately, and the URL stays valid so the
   * third party only has to update its credential.
   */
  rotateToken(endpointId: string): Promise<EndpointCredentials> {
    return this.registry.rotateToken(endpointId);
  }

  /** Deletes an endpoint. Same reasoning as rotateToken: revocation cannot depend on an agent. */
  revoke(endpointId: string): Promise<void> {
    return this.registry.revokeEndpoint(endpointId);
  }
}

type WebhookAccountProps = { accountId: string };

/** Describes the account's ambient capability and generic management app. */
export function describeWebhookAccount(): AccountDescription {
  return {
    displayName: "Webhooks",
    avatar: WEBHOOK_ICON,
    singleton: { tsType: "WebhookSession" },
    providesUi: { title: "Webhooks", icon: WEBHOOK_ICON },
  };
}

@validateRpc()
export class WebhookAccount
  extends WorkerEntrypoint<Cloudflare.Env, WebhookAccountProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Webhooks account capabilities. */
  async describe(): Promise<AccountDescription> {
    return describeWebhookAccount();
  }

  /** Returns the account-imbued ambient workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebhookSession>>> {
    return this.ctx.exports.WebhookGatekeeper({ props: this.ctx.props });
  }

  /** Opens the account's management frame. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ui = new NativeRpcStub(new WebhookManagementApi(this.#registry()));
    return { iframeHtml: APP_HTML, ui };
  }

  /** Offers the endpoint resource, so endpoints can be created from a workspace's Connections. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [endpointResource(this.env)];
  }

  /** Resolves a bound endpoint URL to the per-endpoint gatekeeper facet. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<WebhookEndpointSessionImpl>>;
    resource: SupportedResource;
  }> {
    const endpointId = endpointIdFromUrl(this.env, url);
    return {
      class: this.ctx.exports.WebhookEndpointGatekeeper({
        props: { accountId: this.ctx.props.accountId, endpointId },
      }),
      resource: endpointResource(this.env),
    };
  }

  /** Opens the form that names a new endpoint and mints it. */
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const resource = endpointResource(this.env);
    if (resourceUrlPattern !== resource.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: WEBHOOK_CONFIGURATOR_HTML,
      ui: new NativeRpcStub(
        new WebhookEndpointConfiguratorUI({
          accountId: this.ctx.props.accountId,
          registry: this.#registry(),
          claimEndpointId: (endpointId, accountId) =>
            this.ctx.exports.EndpointIndex.getByName(endpointId).claim(accountId),
        }),
      ),
    };
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Permanently revokes the account: every endpoint URL stops resolving. */
  async revoke(): Promise<void> {
    await this.#registry().revoke();
  }

  /** Rejects reconnect because Webhooks has no credentials of its own. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Webhooks has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier used by the low-stakes observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebhookVerifier({});
  }

  #registry(): DurableObjectStub<EndpointRegistry> {
    return this.ctx.exports.EndpointRegistry.getByName(this.ctx.props.accountId);
  }
}

@validateRpc()
export class WebhookVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Webhooks vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Webhooks",
      url: "https://workers.cloudflare.com/",
      logo: WEBHOOK_ICON,
      tagline: "Receive inbound webhooks from other services",
      description:
        "Give a workspace its own webhook URLs so third-party services can push events into it.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints a new opaque Webhooks account capability. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebhookAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because Webhooks is auto-provisioned. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Webhooks is auto-provisioned and has no connect flow.");
  }

  /**
   * The vendor advertises the same resource the account does. The workspace's "Create New
   * Connection" picker reads the vendor's list, so omitting it here hides the endpoint type from
   * the UI even when every account offers it.
   */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [endpointResource(this.env)];
  }

  /** Returns the complete agent-facing Webhooks declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
