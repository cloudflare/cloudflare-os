// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { XPostEvent } from "../../src/types.js";
import type { XGatekeeperImplProps } from "../../src/x-env.js";
import type { XHookParams } from "../../src/x-hooks.js";

export { default } from "../../src/x.js";
export * from "../../src/x.js";
// Named as well, since the pool builds `ctx.exports` entrypoints only from exports it can see
// statically, and the facet, the controller and the drivers mint these.
export { XActivityRouter, XHookController, XHookDriver, XWebhookRegistry } from "../../src/x.js";
import { GatekeeperUserImpl, XGatekeeperImpl, XVerifier } from "../../src/x.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` in memory here, decorated `WorkerEntrypoint` exports are not registered in
 * `ctx.exports`; the production build registers them. An undecorated subclass registers, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests -- see `TestUser`. */
export class TestVerifier extends XVerifier {}

export type GatekeeperProps = XGatekeeperImplProps;

type UserProps = { userObjectId: string };

type TestExports = {
  XGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestVerifier(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
};

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  async credentialsExpired(): Promise<void> {
    expiredNotices.set(this.ctx.props.userObjectId, (expiredNotices.get(this.ctx.props.userObjectId) ?? 0) + 1);
  }

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async complete(): Promise<ConnectHandoff> {
    throw new Error("Workshop unreachable");
  }
}

const expiredNotices = new Map<string, number>();

/** An approval queue that records what it is asked, and refuses observations it is told to. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: ObservationDescription[] = [];
  refuseObservations = false;

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    this.observations.push(description);
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One call in a scenario: a method and its arguments. */
export type Step = [method: string, ...args: unknown[]];

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = {
  describe(): Promise<unknown>;
  getAutoApprovableActions(): Promise<unknown>;
  startSession(queue: RecordingQueue): Promise<Callable>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
  revertAction(actionId: number): Promise<unknown>;
  addObserver(id: string, verifier: unknown): Promise<void>;
  removeObserver(id: string): Promise<void>;
};

class NullGitCache extends RpcTarget {}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * The gatekeeper facet named `facetName`, made with `props` on first use. A facet is cached per
   * name, storage and all, so each scenario takes a fresh name.
   */
  #gatekeeper(facetName: string, props: GatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get(facetName, () => ({
      class: this.#exports.XGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  #queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, queue = new RecordingQueue());
    return queue;
  }

  /**
   * Opens a session and makes each call in `steps` on what the call before returned, starting with
   * the session. The last call's result comes back; with `pages`, it is a cursor, walked for at most
   * that many pages.
   */
  async run(facetName: string, props: GatekeeperProps, steps: Step[], options: { pages?: number } = {}):
      Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const session = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method](...args);
          if (index === steps.length - 1) {
            if (options.pages === undefined) return result;
            const cursor = result as { next(): Promise<unknown[] | null> };
            const pages: unknown[][] = [];
            for (let page; pages.length < options.pages && (page = await cursor.next()) !== null;) pages.push(page);
            return pages;
          }
          target = result as Callable;
        }
        return undefined;
      } finally {
        session[Symbol.dispose]?.();
      }
    });
  }

  /** What the facet's approval queue has recorded. */
  queueLog(facetName: string): { submitted: RecordingQueue["submitted"]; observations: RecordingQueue["observations"] } {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations };
  }

  refuseObservations(facetName: string, refuse: boolean): void {
    this.#queue(facetName).refuseObservations = refuse;
  }

  async describe(facetName: string, props: GatekeeperProps): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).describe());
  }

  async autoApprovable(facetName: string, props: GatekeeperProps): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getAutoApprovableActions());
  }

  async applyAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, new NullGitCache()));
  }

  async rejectAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  async revertAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).revertAction(actionId));
  }

  /** `addObserver` with a verifier minted for `observerUserObjectId`'s account. */
  async addObserver(facetName: string, props: GatekeeperProps, observerId: string, observerUserObjectId: string):
      Promise<Outcome<void>> {
    const verifier = this.#exports.TestVerifier({ props: { userObjectId: observerUserObjectId } });
    return await outcome(() => this.#gatekeeper(facetName, props).addObserver(observerId, verifier));
  }

  /** Restarts the gatekeeper, as an eviction would: its storage stays, its memory does not. */
  restart(facetName: string): void {
    this.ctx.facets.abort(facetName, new Error("test restart"));
  }

  // -- account ----------------------------------------------------------------------------

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string, scopes: string[]): Promise<void> {
    const callback = this.#exports.TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    await account.setCallback(callback, initiationNonce, scopes);
  }

  expiredNotices(userObjectId: string): number {
    return expiredNotices.get(userObjectId) ?? 0;
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestUser({ props: { userObjectId } })[method](...args));
  }

  /** Calls `method` on the verifier for `userObjectId`. */
  async verifier(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestVerifier({ props: { userObjectId } })[method](...args));
  }

  /** Calls `method` on the account Durable Object, failures carried back as data. */
  async account(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await outcome(() => (account as unknown as Callable)[method](...args));
  }

  // -- hooks, with this object standing in for the overseer --------------------------------
  //
  // One hook per TestHooks object: subscribing stores the controller it binds, enabling hands it an
  // initiator whose firings reach `startHook()` here, and those firings deliver to a RecordingHook
  // over `#firingQueue`.

  #hook: HookState = { received: [], failures: 0, admissionFailures: 0 };
  #firingQueue = new FiringQueue();

  /** Subscribes through a session, as executeCode would: `steps` lead to the method that takes the hook. */
  async subscribeHook(facetName: string, props: GatekeeperProps, steps: Step[]): Promise<Outcome<HookDescription>> {
    return await outcome(async () => {
      const facet = this.#gatekeeper(facetName, props) as unknown as HookFacet;
      await facet.testRestoreThrough(this.ctx.id.toString(), facetName, props);
      using queue = new RpcStub(new BindingQueue(this.ctx.storage));
      using hook = new RpcStub(new RecordingHook(this.#hook));
      const session = await facet.startSession(queue as never);
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method](...(index === steps.length - 1 ? [...args, hook] : args));
          target = result as Callable;
        }
      } finally {
        session[Symbol.dispose]?.();
      }
      return this.ctx.storage.kv.get<HookDescription>("hookDescription")!;
    });
  }

  async enableHook(): Promise<Outcome<void>> {
    const initiator = (this.ctx.exports as unknown as HookExports).TestHookInitiator({ props: { hooks: this.ctx.id.toString() } });
    return await outcome(() => this.#controller().enable(initiator as never, { workspaceId: "test-workspace" }));
  }

  async disableHook(): Promise<Outcome<void>> {
    return await outcome(() => this.#controller().disable());
  }

  /** The overseer's `HookInitiator.startHook()`, for this object's hook. */
  startHook() {
    if (this.#hook.admissionFailures > 0) {
      this.#hook.admissionFailures--;
      throw new Error("The test Workshop failed to start the firing.");
    }
    return { callback: new RecordingHook(this.#hook), approvalQueue: new RpcStub(this.#firingQueue) };
  }

  /** What a delivery stub the facet minted reaches: the facet's own `[restore]()` target. */
  async deliverHook(facetName: string, props: GatekeeperProps, params: XHookParams,
                    callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, event: unknown): Promise<void> {
    await (this.#gatekeeper(facetName, props) as unknown as HookFacet).testDeliver(params, callback, approvalQueue, event);
  }

  setHookBehavior(behavior: Partial<Omit<HookState, "received">>): void {
    Object.assign(this.#hook, behavior);
  }

  /** What the hook received, and what its firings observed and queued. */
  readHook() {
    return {
      received: this.#hook.received, capabilities: this.#hook.capabilities ?? [], failures: this.#hook.failures,
      ...this.#firingQueue.read(),
    };
  }

  #controller(): HookController<RpcTarget> {
    const controller = this.ctx.storage.kv.get<HookController<RpcTarget>>("hookController");
    if (!controller) throw new Error("No hook has been bound.");
    return controller;
  }
}

/** A gadget's hook, sharing its state with the TestHooks object that fires it. */
type HookState = {
  /** Each event received, without its capability. */
  received: Omit<XPostEvent, "post">[];
  /** Whether each event received carried a capability. */
  capabilities?: boolean[];
  /** Fail this many more deliveries. */
  failures: number;
  /** Fail this many more `startHook()` calls, as the Workshop refusing a firing would. */
  admissionFailures: number;
  /** Reply with this through each event's post. */
  reply?: string;
};

/** The facet methods the hook harness calls, two of them installed below for the tests. */
type HookFacet = {
  startSession(queue: never): Promise<Callable>;
  testRestoreThrough(hooks: string, facetName: string, props: GatekeeperProps): Promise<void>;
  testDeliver(params: XHookParams, callback: unknown, queue: unknown, event: unknown): Promise<void>;
};

type TestHookDeliveryProps = { hooks: string; facetName: string; props: GatekeeperProps; params: XHookParams };

/** This worker's hook entrypoints, which the gatekeeper's generated `Cloudflare.Exports` omits. */
type HookExports = {
  TestHooks: DurableObjectNamespace<TestHooks>;
  TestHookInitiator(options: { props: { hooks: string } }): Fetcher;
  TestHookDelivery(options: { props: TestHookDeliveryProps }): Fetcher;
};

function testHooks(exports: Cloudflare.Exports, id: string) {
  const namespace = (exports as unknown as HookExports).TestHooks;
  return namespace.get(namespace.idFromString(id));
}

/** The overseer's HookInitiator: each firing reaches the TestHooks object that enabled the hook. */
export class TestHookInitiator extends WorkerEntrypoint<Cloudflare.Env, { hooks: string }> {
  startHook() {
    return testHooks(this.ctx.exports, this.ctx.props.hooks).startHook();
  }
}

/**
 * Stands in for the stub the facet mints with ctx.restore(), which this pool cannot do (its Durable
 * Object wrappers don't forward `[restore]`): it reaches the facet's real `[restore]` target
 * through TestHooks.
 */
export class TestHookDelivery extends WorkerEntrypoint<Cloudflare.Env, TestHookDeliveryProps> {
  deliver(callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, event: unknown) {
    const { hooks, facetName, props, params } = this.ctx.props;
    return testHooks(this.ctx.exports, hooks).deliverHook(facetName, props, params, callback, approvalQueue, event);
  }
}

/** The queue a subscription binds its hook on: keeps the controller, as the overseer would. */
class BindingQueue extends RpcTarget {
  constructor(private readonly storage: DurableObjectStorage) {
    super();
  }

  async bindHook(controller: unknown, _callback: unknown, description: HookDescription): Promise<void> {
    this.storage.kv.put("hookController", controller);
    this.storage.kv.put("hookDescription", description);
  }
}

/** The approval queue of every firing: records what the deliveries observed and queued. */
class FiringQueue extends RpcTarget {
  #observations: ObservationDescription[] = [];
  #submissions: { actionId: number; title: string }[] = [];

  async authorizeObservation(observation: ObservationDescription): Promise<void> {
    this.#observations.push(observation);
  }

  async submitAction(actionId: number, description: { title: string }): Promise<void> {
    this.#submissions.push({ actionId, title: description.title });
  }

  read() {
    return { observations: this.#observations, submissions: this.#submissions };
  }
}

/** A gadget's post hook: records each event, and fails or replies as its state says. */
class RecordingHook extends RpcTarget {
  constructor(private readonly state: HookState) {
    super();
  }

  async receivePost(event: XPostEvent): Promise<void> {
    const { post, ...received } = event;
    try {
      if (this.state.failures > 0) {
        this.state.failures--;
        throw new Error("The test hook failed.");
      }
      this.state.received.push(received);
      (this.state.capabilities ??= []).push(post !== undefined);
      if (this.state.reply !== undefined) await post?.reply({ text: this.state.reply });
    } finally {
      (post as Partial<Disposable> | undefined)?.[Symbol.dispose]?.();
    }
  }
}

type TestX = XGatekeeperImpl & HookFacet;
const testPrototype = XGatekeeperImpl.prototype as TestX;

/** Make this facet's ctx.restore() mint TestHookDelivery stubs that route back to `[restore]`. */
testPrototype.testRestoreThrough = async function(hooks, facetName, props) {
  const { ctx } = this as unknown as { ctx: DurableObjectState };
  const exports = ctx.exports as unknown as HookExports;
  ctx.restore = async (params: XHookParams) => Object.assign(
    exports.TestHookDelivery({ props: { hooks, facetName, props, params } }), { [Symbol.dispose]() {} });
};

/** Deliver through the target the facet's `[restore]()` returns for a hook's delivery stub. */
testPrototype.testDeliver = function(params, callback, queue, event) {
  return this[restore](params).deliver(callback as never, queue as never, event as never);
};
