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
import {
  normalizeCalendarRule,
  normalizeInterval,
  normalizeOneShot,
  normalizeRecurringScheduleOptions,
} from "./scheduler-core.js";
import { ScheduleDriver } from "./schedule-driver.js";
import type { ScheduleSpec } from "./schedule-types.js";
import type { ManagementListOptions, ManagementSchedulePage } from "./management.js";
import type {
  CalendarRule,
  NormalizedScheduleOccurrences,
  OneShotTime,
  RecurringScheduleOptions,
  ScheduleOptions,
  ScheduleSession,
  ScheduleSummary,
  ScheduledTaskHook,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

const SCHEDULER_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm40-88a8 8 0 0 1-8 8h-32a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v40h24a8 8 0 0 1 8 8Z'/></svg>",
    ),
};

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;
type ScheduleInitiator = Fetcher<HookInitiator<ScheduleHookTarget>>;

export type ScheduleControllerProps = {
  accountId: string;
  workspaceId: string;
  scheduleId: string;
  spec: ScheduleSpec;
  title: string;
  description: string;
  occurrences?: NormalizedScheduleOccurrences;
};

type SessionDriver = Pick<ScheduleDriver, "listWorkspace">;
type ControllerDriver = Pick<ScheduleDriver, "enable" | "disable">;
type ControllerFactory = (
  props: ScheduleControllerProps,
) => Fetcher<HookController<ScheduleHookTarget>>;

export type ScheduleSessionDependencies = {
  accountId: string;
  workspaceId: string;
  approvalQueue: NativeRpcStub<ApprovalQueue>;
  controllerFactory: ControllerFactory;
  driver: SessionDriver;
  now?: () => number;
  randomId?: () => string;
};

@validateRpc()
export class ScheduleSessionImpl extends RpcTarget implements ScheduleSession {
  readonly #accountId: string;
  readonly #workspaceId: string;
  readonly #approvalQueue: NativeRpcStub<ApprovalQueue>;
  readonly #controllerFactory: ControllerFactory;
  readonly #driver: SessionDriver;
  readonly #now: () => number;
  readonly #randomId: () => string;

  constructor(dependencies: ScheduleSessionDependencies) {
    super();
    this.#accountId = dependencies.accountId;
    this.#workspaceId = dependencies.workspaceId;
    this.#approvalQueue = dependencies.approvalQueue;
    this.#controllerFactory = dependencies.controllerFactory;
    this.#driver = dependencies.driver;
    this.#now = dependencies.now ?? Date.now;
    this.#randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  }

  /** Registers an elapsed interval anchored to the current registration time. */
  every(
    everyMs: number,
    callback: NativeRpcStub<ScheduleHookTarget>,
    options: RecurringScheduleOptions,
  ): Promise<string> {
    const registeredAt = this.#now();
    return this.#register(normalizeInterval(everyMs, registeredAt), callback, options, registeredAt);
  }

  /** Registers a timezone-aware calendar recurrence. */
  calendarAt(
    rule: CalendarRule,
    callback: NativeRpcStub<ScheduleHookTarget>,
    options: RecurringScheduleOptions,
  ): Promise<string> {
    const registeredAt = this.#now();
    return this.#register(
      normalizeCalendarRule(rule, registeredAt), callback, options, registeredAt,
    );
  }

  /** Registers a numeric or timezone-aware one-shot schedule. */
  runAt(
    when: OneShotTime | number,
    callback: NativeRpcStub<ScheduleHookTarget>,
    options: ScheduleOptions,
  ): Promise<string> {
    const registeredAt = this.#now();
    return this.#register(normalizeOneShot(when, registeredAt), callback, options, registeredAt);
  }

  /** Lists this workspace's enabled schedules after observation authorization. */
  async list(): Promise<ScheduleSummary[]> {
    const schedules = await this.#driver.listWorkspace(this.#workspaceId);
    await this.#approvalQueue.authorizeObservation({
      title: "List scheduled tasks",
      description: "List enabled schedules for this workspace.",
    });
    return schedules;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }

  async #register(
    spec: ScheduleSpec,
    callback: NativeRpcStub<ScheduleHookTarget>,
    options: RecurringScheduleOptions,
    registeredAt: number,
  ): Promise<string> {
    if (spec.kind === "once" && options?.occurrences !== undefined) {
      throw new TypeError("Occurrence limits apply only to recurring schedules.");
    }
    const normalized = normalizeRecurringScheduleOptions(options, spec, registeredAt);
    const scheduleId = this.#randomId();
    const controller = this.#controllerFactory({
      accountId: this.#accountId,
      workspaceId: this.#workspaceId,
      scheduleId,
      spec,
      ...normalized,
    });
    await this.#approvalQueue.bindHook(
      // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
      controller,
      callback,
      // bindHook takes only the display metadata; the bound itself stays in the controller.
      { title: normalized.title, description: normalized.description },
    );
    return scheduleId;
  }
}

/** Enables a controller's immutable activation, recording where the hook delivers. */
export async function enableScheduleController(
  props: ScheduleControllerProps,
  initiator: ScheduleInitiator,
  driver: Pick<ControllerDriver, "enable">,
  target: HookTargetMetadata,
): Promise<void> {
  const { accountId: _accountId, ...activation } = props;
  await driver.enable(
    { ...activation, ...(target.gadgetId !== undefined ? { gadgetId: target.gadgetId } : {}) },
    initiator,
  );
}

/** Disables the immutable workspace schedule represented by controller props. */
export function disableScheduleController(
  props: ScheduleControllerProps,
  driver: Pick<ControllerDriver, "disable">,
): Promise<void> {
  return driver.disable(props.workspaceId, props.scheduleId);
}

@validateRpc()
export class ScheduleHookController
  extends WorkerEntrypoint<Cloudflare.Env, ScheduleControllerProps>
  implements HookController<ScheduleHookTarget>
{
  /** Activates the schedule, recording the gadget it delivers into. */
  enable(initiator: ScheduleInitiator, target: HookTargetMetadata): Promise<void> {
    return enableScheduleController(this.ctx.props, initiator, this.#driver(), target);
  }

  /** Removes all driver state for this schedule activation. */
  disable(): Promise<void> {
    return disableScheduleController(this.ctx.props, this.#driver());
  }

  #driver(): DurableObjectStub<ScheduleDriver> {
    return this.ctx.exports.ScheduleDriver.getByName(this.ctx.props.accountId);
  }
}

@validateRpc()
export class SchedulerGatekeeper
  extends DurableObject<Cloudflare.Env, { accountId: string }>
  implements Gatekeeper<ScheduleSession>
{
  /** Describes the ambient Scheduled Tasks binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "scheduler://tasks",
      title: "Scheduled Tasks",
      snippet: "Run workspace callbacks on recurring and one-shot schedules.",
      suggestedBindingName: "SCHEDULER",
      tsType: "ScheduleSession",
      hookTsType: "ScheduledTaskHook",
    };
  }

  /** Returns the agent-facing ScheduleSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Reports that Scheduled Tasks has no auto-applicable actions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session scoped only by this facet's inherited workspace ID. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<ScheduleSession> {
    const workspaceId = this.ctx.id.toString();
    // This account-ID comparison is only a smoke check. The workerd parent/facet inheritance test
    // verifies that the ID is the parent workspace scope, including across sibling facet names.
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited scheduler workspace scope.");
    }
    return new ScheduleSessionImpl({
      accountId: this.ctx.props.accountId,
      workspaceId,
      approvalQueue: approvalQueue.dup(),
      controllerFactory: (props) => this.ctx.exports.ScheduleHookController({ props }),
      driver: this.ctx.exports.ScheduleDriver.getByName(this.ctx.props.accountId),
    });
  }

  /** Returns no catalog because schedule discovery happens through list(). */
  async getAgentCatalog(
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  /** Accepts collaborators under the low-stakes observer policy. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  /** Rejects action application because the scheduler is read-only. */
  applyAction(_action: number): Promise<void> {
    throw new Error("Scheduled Tasks is read-only and implements no actions.");
  }

  /** Rejects action rejection because the scheduler submits no actions. */
  rejectAction(_action: number): Promise<void> {
    throw new Error("Scheduled Tasks is read-only and implements no actions.");
  }

  /** Rejects action reversion because the scheduler submits no actions. */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Scheduled Tasks is read-only and implements no actions.");
  }
}

@validateRpc()
export class ScheduleManagementApi extends RpcTarget {
  constructor(private readonly driver: Pick<ScheduleDriver, "listAccount">) {
    super();
  }

  /** Lists schedules across this account without mutation authority. */
  list(options?: ManagementListOptions): Promise<ManagementSchedulePage> {
    return this.driver.listAccount(options);
  }
}

type ScheduleAccountProps = { accountId: string };

/** Describes the account's ambient capability and generic management app. */
export function describeScheduleAccount(): AccountDescription {
  return {
    displayName: "Scheduled Tasks",
    avatar: SCHEDULER_ICON,
    singleton: { tsType: "ScheduleSession" },
    providesUi: { title: "Scheduled", icon: SCHEDULER_ICON },
  };
}

@validateRpc()
export class ScheduleAccount
  extends WorkerEntrypoint<Cloudflare.Env, ScheduleAccountProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Scheduler account capabilities. */
  async describe(): Promise<AccountDescription> {
    return describeScheduleAccount();
  }

  /** Returns the account-imbued ambient workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ScheduleSession>>> {
    return this.ctx.exports.SchedulerGatekeeper({ props: this.ctx.props });
  }

  /** Opens the account's read-only management frame. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ui = new NativeRpcStub(new ScheduleManagementApi(this.#driver()));
    return { iframeHtml: APP_HTML, ui };
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup because Scheduler is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Scheduled Tasks has no URL-addressed resources.");
  }

  /** Rejects resource configuration because Scheduler is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Scheduled Tasks has no URL-addressed resources.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Permanently revokes the account driver and all schedule activations. */
  async revoke(): Promise<void> {
    await this.#driver().revoke();
  }

  /** Rejects reconnect because Scheduler has no credentials. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Scheduled Tasks has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier used by the low-stakes observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ScheduleVerifier({});
  }

  #driver(): DurableObjectStub<ScheduleDriver> {
    return this.ctx.exports.ScheduleDriver.getByName(this.ctx.props.accountId);
  }
}

@validateRpc()
export class ScheduleVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Scheduled Tasks vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Scheduled Tasks",
      url: "https://workers.cloudflare.com/",
      logo: SCHEDULER_ICON,
      tagline: "Run workspace tasks on a schedule",
      description: "Register recurring and one-shot workspace tasks.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints a new opaque Scheduler account capability. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ScheduleAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because Scheduler is auto-provisioned. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Scheduled Tasks is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing Scheduler declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
