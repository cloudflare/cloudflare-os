// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data. For
// hooks it also stands in for the overseer: it keeps each bound controller, enables it with an
// initiator whose firings reach it, and records what each firing observed and received.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { PagerDutyGatekeeperImplProps } from "../../src/pagerduty-env.js";
import type { HookScope } from "../../src/pagerduty-session-shared.js";
import type { PagerDutyEvent, PagerDutySubscribeOptions } from "../../src/types.js";

export { default } from "../../src/pagerduty.js";
export * from "../../src/pagerduty.js";
import {
  GatekeeperUserImpl, PagerDutyGatekeeperImpl, PagerDutyHookController as ProductionHookController, PagerDutyVerifier,
} from "../../src/pagerduty.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` in memory here, decorated `WorkerEntrypoint` exports are not registered in
 * `ctx.exports`; the production build registers them. An undecorated subclass registers, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests -- see `TestUser`. */
export class TestVerifier extends PagerDutyVerifier {}

/** The hook controller, under its production name, which the facet mints it by -- see `TestUser`. */
export class PagerDutyHookController extends ProductionHookController {}

export type GatekeeperProps = PagerDutyGatekeeperImplProps;

type UserProps = { userObjectId: string };

type TestExports = {
  PagerDutyGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestVerifier(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
  TestHooks: DurableObjectNamespace<TestHooks>;
  TestHookInitiator(options: { props: { hooks: string; hook: string } }): Fetcher<TestHookInitiator>;
  TestHookDelivery(options: { props: TestHookDeliveryProps }): Fetcher<TestHookDelivery>;
};

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  async credentialsExpired(): Promise<void> {}

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }
}

/** An approval queue that records what it is asked. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: ObservationDescription[] = [];

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
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
  startSession(queue: RpcTarget): Promise<Callable>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
  verifyObserverAccess(observers: { id: string; verifier: unknown }[], subresources: string[]):
    Promise<{ allowedObserverIds: string[] }>;
  getHistoricalSubresources(): Promise<string[]>;
  testRestoreThrough(hooks: string, facetName: string, props: GatekeeperProps): Promise<void>;
  testDeliver(scope: HookScope, initiator: unknown, event: unknown): Promise<void>;
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
      class: this.#exports.PagerDutyGatekeeperImpl({ props }),
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
      // Every capability a step returned and the scenario walked on from, the session's included.
      const owned: Callable[] = [session];
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method](...args);
          if (index === steps.length - 1) {
            if (options.pages === undefined) return result;
            const cursor = result as Callable & { next(): Promise<unknown[] | null> };
            owned.push(cursor);
            const pages: unknown[][] = [];
            for (let page; pages.length < options.pages && (page = await cursor.next()) !== null;) pages.push(page);
            return pages;
          }
          target = result as Callable;
          owned.push(target);
        }
        return undefined;
      } finally {
        for (const capability of owned.toReversed()) capability[Symbol.dispose]?.();
      }
    });
  }

  /** What the facet's approval queue has recorded. */
  queueLog(facetName: string): { submitted: RecordingQueue["submitted"]; observations: RecordingQueue["observations"] } {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations };
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

  /** `verifyObserverAccess` with each observer's verifier minted for its account. */
  async verifyObserverAccess(facetName: string, props: GatekeeperProps,
                             observers: { id: string; userObjectId: string }[], subresources: string[]):
      Promise<Outcome<{ allowedObserverIds: string[] }>> {
    const minted = observers.map(({ id, userObjectId }) =>
      ({ id, verifier: this.#exports.TestVerifier({ props: { userObjectId } }) }));
    return await outcome(() => this.#gatekeeper(facetName, props).verifyObserverAccess(minted, subresources));
  }

  async historicalSubresources(facetName: string, props: GatekeeperProps): Promise<Outcome<string[]>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getHistoricalSubresources());
  }

  // -- account ----------------------------------------------------------------------------

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string): Promise<void> {
    const callback = this.#exports.TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    await account.setCallback(callback, initiationNonce);
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestUser({ props: { userObjectId } })[method](...args));
  }

  // -- hooks ------------------------------------------------------------------------------

  #hooks = new Map<string, HookState>();

  #hook(hook: string): HookState {
    let state = this.#hooks.get(hook);
    if (!state) this.#hooks.set(hook, state = { received: [], observations: [], submitted: [], firings: 0, failures: 0 });
    return state;
  }

  /**
   * Subscribes the hook named `hook` through the capability `steps` open from the session, as
   * executeCode would, and returns what it was bound with.
   */
  async subscribeHook(hook: string, facetName: string, props: GatekeeperProps, steps: Step[],
                      options?: PagerDutySubscribeOptions): Promise<Outcome<HookDescription>> {
    return await outcome(async () => {
      const facet = this.#gatekeeper(facetName, props);
      await facet.testRestoreThrough(this.ctx.id.toString(), facetName, props);
      const owned: Callable[] = [await facet.startSession(new BindingQueue(this.ctx.storage, hook))];
      try {
        for (const [method, ...args] of steps) owned.push(await owned.at(-1)![method](...args) as Callable);
        using callback = new RpcStub(new RecordingHook(this.#hook(hook)));
        await owned.at(-1)!.subscribe(callback, options);
      } finally {
        for (const capability of owned.toReversed()) capability[Symbol.dispose]?.();
      }
      return this.ctx.storage.kv.get<HookDescription>(`hook:${hook}:description`)!;
    });
  }

  async enableHook(hook: string): Promise<Outcome<void>> {
    const initiator = this.#exports.TestHookInitiator({ props: { hooks: this.ctx.id.toString(), hook } });
    return await outcome(() => this.#controller(hook).enable(initiator, { workspaceId: "test-workspace" }));
  }

  async disableHook(hook: string): Promise<void> {
    await this.#controller(hook).disable();
  }

  /** The overseer's `HookInitiator.startHook()` for the hook named `hook`. */
  startHook(hook: string) {
    const state = this.#hook(hook);
    state.firings++;
    return { callback: new RecordingHook(state), approvalQueue: new RpcStub(new FiringQueue(state)) };
  }

  /** What a delivery stub the facet minted reaches: the facet's own `[restore]()` target. */
  async deliverHook(facetName: string, props: GatekeeperProps, scope: HookScope, initiator: unknown, event: unknown): Promise<void> {
    await this.#gatekeeper(facetName, props).testDeliver(scope, initiator, event);
  }

  /** Makes the hook's next `count` deliveries throw, as a failing gadget's would. */
  failHook(hook: string, count: number): void {
    this.#hook(hook).failures = count;
  }

  /** Has the hook add `note` to each event's incident, through the capability the event carries. */
  replyHook(hook: string, note: string): void {
    this.#hook(hook).reply = note;
  }

  readHook(hook: string): HookState {
    return this.#hook(hook);
  }

  #controller(hook: string): HookController<RpcTarget> {
    const controller = this.ctx.storage.kv.get<HookController<RpcTarget>>(`hook:${hook}:controller`);
    if (!controller) throw new Error(`No hook ${hook} has been bound.`);
    return controller;
  }
}

/** One hook's firings, as the test reads them back. */
type HookState = {
  /** Each event received, without its incident capability. */
  received: Omit<PagerDutyEvent, "incident">[];
  observations: ObservationDescription[];
  /** The titles of the actions the firings queued. */
  submitted: string[];
  /** How many firings were started. */
  firings: number;
  /** Fail this many more deliveries. */
  failures: number;
  reply?: string;
};

type TestHookDeliveryProps = { hooks: string; facetName: string; props: GatekeeperProps; scope: HookScope };

function testHooks(exports: Cloudflare.Exports, id: string) {
  const namespace = (exports as unknown as TestExports).TestHooks;
  return namespace.get(namespace.idFromString(id));
}

/** The overseer's HookInitiator: each firing reaches the TestHooks object that enabled the hook. */
export class TestHookInitiator extends WorkerEntrypoint<Cloudflare.Env, { hooks: string; hook: string }> {
  startHook() {
    return testHooks(this.ctx.exports, this.ctx.props.hooks).startHook(this.ctx.props.hook);
  }
}

/**
 * Stands in for the stub the facet mints with `ctx.restore()`, which this pool cannot do (its
 * Durable Object wrappers don't forward `[restore]`): it reaches the facet's real `[restore]`
 * target through TestHooks.
 */
export class TestHookDelivery extends WorkerEntrypoint<Cloudflare.Env, TestHookDeliveryProps> {
  deliver(initiator: unknown, event: unknown) {
    const { hooks, facetName, props, scope } = this.ctx.props;
    return testHooks(this.ctx.exports, hooks).deliverHook(facetName, props, scope, initiator, event);
  }
}

/** The queue a subscription binds its hook on: keeps the controller, as the overseer would. */
class BindingQueue extends RpcTarget {
  constructor(private readonly storage: DurableObjectStorage, private readonly hook: string) {
    super();
  }

  async bindHook(controller: unknown, _callback: unknown, description: HookDescription): Promise<void> {
    this.storage.kv.put(`hook:${this.hook}:controller`, controller);
    this.storage.kv.put(`hook:${this.hook}:description`, description);
  }
}

/** The approval queue of every firing of one hook. */
class FiringQueue extends RpcTarget {
  constructor(private readonly state: HookState) {
    super();
  }

  async authorizeObservation(observation: ObservationDescription): Promise<void> {
    this.state.observations.push(observation);
  }

  async submitAction(_actionId: number, description: ActionDescription): Promise<void> {
    this.state.submitted.push(description.title);
  }
}

/** A gadget's event hook: records each event, and fails or replies as its state says. */
class RecordingHook extends RpcTarget {
  constructor(private readonly state: HookState) {
    super();
  }

  async receiveEvent(event: PagerDutyEvent): Promise<void> {
    const { incident, ...received } = event;
    try {
      if (this.state.failures > 0) {
        this.state.failures--;
        throw new Error("The test hook failed.");
      }
      this.state.received.push(received);
      if (this.state.reply !== undefined) await incident.addNote(this.state.reply);
    } finally {
      (incident as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }
}

type HookTestFacet = PagerDutyGatekeeperImpl & Pick<GatekeeperFacet, "testRestoreThrough" | "testDeliver">;
const testPrototype = PagerDutyGatekeeperImpl.prototype as HookTestFacet;

/** Makes this facet's `ctx.restore()` mint TestHookDelivery stubs that route back to `[restore]`. */
testPrototype.testRestoreThrough = async function(hooks, facetName, props) {
  const { ctx } = this as unknown as { ctx: DurableObjectState };
  const exports = ctx.exports as unknown as TestExports;
  ctx.restore = async (scope: HookScope) => Object.assign(
    exports.TestHookDelivery({ props: { hooks, facetName, props, scope } }), { [Symbol.dispose]() {} });
};

/** Delivers through the target the facet's `[restore]()` returns for a hook's delivery stub. */
testPrototype.testDeliver = function(scope, initiator, event) {
  return this[restore](scope).deliver(initiator as never, event as never);
};
