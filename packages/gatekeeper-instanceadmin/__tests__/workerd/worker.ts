// Test worker for the workerd suite: the production entrypoints, and beside them the Workshop's
// side of a hook, which has to be an entrypoint of the Worker under test because the hooks'
// driver stores it: a `HookInitiator` whose firings a test reads back, and a stand-in for the
// delivery stub a facet mints.

import { RpcStub, RpcTarget, WorkerEntrypoint, env, restore } from "cloudflare:workers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { IssueReportHookEvent, IssueReportHookParams } from "../../src/hooks.js";
import { InstanceAdminGatekeeper } from "../../src/worker.js";

// Named one by one: the pool finds a Worker's entrypoints by reading this module's source, and
// does not follow a star export.
export {
  default, GatekeeperVendor, InstanceAdminAccount, InstanceAdminGatekeeper, InstanceAdminVerifier,
  IssueReportHookController, IssueReportHookDriver,
} from "../../src/worker.js";

/** One hook's firings, as a test sets them up and reads them back. */
export type HookState = {
  /** How many firings were started, the refused ones included. */
  firings: number;
  /** Refuse this many more firings, as the Workshop does while the owner is no admin. */
  refusals: number;
  /** Refuse each firing's observation. */
  refuseObservations: boolean;
  /** Fail this many more calls of the callback, as a failing gadget's would. */
  failures: number;
  /** While set, a call of the callback waits for it and then returns, having received nothing:
   * a gadget's callback that waits for long work. */
  hold?: Promise<void>;
  /** What the firings' queues were asked to observe. */
  observations: ObservationDescription[];
  /** Each call of the callback: its method and its event. */
  received: { method: string; event: unknown }[];
  /** The event of each call of the callback that failed. */
  failed: unknown[];
  /** What each firing did, in order: "observe" and "call". */
  order: string[];
  /** Everything else a firing's queue was asked for: there should be nothing. */
  other: string[];
};

const hookStates = new Map<string, HookState>();

/** The state of the hook a test named `hook`, shared with the entrypoints below. */
export function hookState(hook: string): HookState {
  let state = hookStates.get(hook);
  if (!state) {
    hookStates.set(hook, state = {
      firings: 0, refusals: 0, refuseObservations: false, failures: 0,
      observations: [], received: [], failed: [], order: [], other: [],
    });
  }
  return state;
}

/** A gadget's stored callback, for either hook: records each call, or fails as its state says. */
class RecordingHook extends RpcTarget {
  readonly #state: HookState;

  constructor(state: HookState) {
    super();
    this.#state = state;
  }

  async issueReported(event: unknown): Promise<void> {
    await this.#receive("issueReported", event);
  }

  async investigationComplete(event: unknown): Promise<void> {
    await this.#receive("investigationComplete", event);
  }

  async #receive(method: string, event: unknown): Promise<void> {
    if (this.#state.hold) return await this.#state.hold;
    if (this.#state.failures > 0) {
      this.#state.failures--;
      this.#state.failed.push(event);
      throw new Error("The test hook failed.");
    }
    this.#state.order.push("call");
    this.#state.received.push({ method, event });
  }
}

/** The plain approval queue of one firing: it lends no Admin API. */
class FiringQueue extends RpcTarget {
  readonly #state: HookState;

  constructor(state: HookState) {
    super();
    this.#state = state;
  }

  async authorizeObservation(observation: ObservationDescription): Promise<void> {
    this.#state.order.push("observe");
    this.#state.observations.push(observation);
    if (this.#state.refuseObservations) throw new Error("The approval queue refused this observation.");
  }

  async getAdminApi(): Promise<never> {
    this.#state.other.push("getAdminApi");
    throw new Error("A hook's firing is lent no Admin API.");
  }

  async submitAction(): Promise<void> {
    this.#state.other.push("submitAction");
  }
}

/** The Workshop's `HookInitiator` for the hook named in its props. */
export class TestHookInitiator extends WorkerEntrypoint<Cloudflare.Env, { hook: string }> {
  async startHook() {
    const state = hookState(this.ctx.props.hook);
    state.firings++;
    if (state.refusals > 0) {
      state.refusals--;
      throw new Error("This hook's workspace is not owned by a deployment admin.");
    }
    return { callback: new RecordingHook(state), approvalQueue: new RpcStub(new FiringQueue(state)) };
  }
}

type DeliveryProps = IssueReportHookParams & { facet: string };

/**
 * Stands in for the stub the facet mints with `ctx.restore()`, which this pool cannot make (its
 * Durable Object wrappers don't forward `[restore]`): it reaches the real `[restore]` target of
 * the facet named in its props.
 */
export class TestHookDelivery extends WorkerEntrypoint<Cloudflare.Env, DeliveryProps> {
  deliver(callback: unknown, approvalQueue: unknown, event: IssueReportHookEvent): Promise<void> {
    const { facet, ...params } = this.ctx.props;
    const gatekeeper = env.INSTANCE_ADMIN_GATEKEEPER.getByName(facet) as unknown as TestFacet;
    return gatekeeper.testDeliver(params, callback, approvalQueue, event);
  }
}

/** The facet with the two methods this module adds to its prototype. */
export type TestFacet = {
  /** Makes this facet's `ctx.restore()` mint TestHookDelivery stubs that route back to it. */
  testRestoreThrough(facet: string): Promise<void>;
  /** Delivers through the target the facet's `[restore]()` returns for a hook's delivery stub. */
  testDeliver(
    params: IssueReportHookParams, callback: unknown, approvalQueue: unknown,
    event: IssueReportHookEvent,
  ): Promise<void>;
};

const testFacet = InstanceAdminGatekeeper.prototype as InstanceAdminGatekeeper & TestFacet;

testFacet.testRestoreThrough = async function (facet) {
  const { ctx } = this as unknown as { ctx: DurableObjectState };
  const exports = ctx.exports as unknown as {
    TestHookDelivery(options: { props: DeliveryProps }): Fetcher;
  };
  ctx.restore = async (params: IssueReportHookParams) => Object.assign(
      exports.TestHookDelivery({ props: { facet, ...params } }), { [Symbol.dispose]() {} });
};

testFacet.testDeliver = function (params, callback, approvalQueue, event) {
  return this[restore](params).deliver(callback as never, approvalQueue as never, event);
};
