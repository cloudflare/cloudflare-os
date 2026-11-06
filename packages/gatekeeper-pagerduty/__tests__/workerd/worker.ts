// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { PagerDutyGatekeeperImplProps } from "../../src/pagerduty-env.js";

export { default } from "../../src/pagerduty.js";
export * from "../../src/pagerduty.js";
import { GatekeeperUserImpl, PagerDutyVerifier } from "../../src/pagerduty.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` in memory here, decorated `WorkerEntrypoint` exports are not registered in
 * `ctx.exports`; the production build registers them. An undecorated subclass registers, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests -- see `TestUser`. */
export class TestVerifier extends PagerDutyVerifier {}

export type GatekeeperProps = PagerDutyGatekeeperImplProps;

type UserProps = { userObjectId: string };

type TestExports = {
  PagerDutyGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestVerifier(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
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
  startSession(queue: RecordingQueue): Promise<Callable>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
  verifyObserverAccess(observers: { id: string; verifier: unknown }[], subresources: string[]):
    Promise<{ allowedObserverIds: string[] }>;
  getHistoricalSubresources(): Promise<string[]>;
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
}
