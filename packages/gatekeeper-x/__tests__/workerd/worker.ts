// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { XGatekeeperImplProps } from "../../src/x-env.js";

export { default } from "../../src/x.js";
export * from "../../src/x.js";
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

/** A `RecordingQueue` that records when native RPC releases it: once every stub to it is disposed. */
class TrackedQueue extends RecordingQueue {
  released = false;

  [Symbol.dispose](): void {
    this.released = true;
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
  verifyObserverAccess(observers: { id: string; verifier: unknown }[], subresources: string[]):
    Promise<{ allowedObserverIds: string[] }>;
  getHistoricalSubresources(): Promise<string[]>;
  putTestStorage(key: string, value: unknown): void;
};

// Installed only in this test Worker, to seed what an earlier version stored. The exported class
// remains the production implementation, with its real capnweb-validated RPC surface.
(XGatekeeperImpl.prototype as unknown as Pick<GatekeeperFacet, "putTestStorage">).putTestStorage =
  function(this: { ctx: DurableObjectState }, key: string, value: unknown): void {
    this.ctx.storage.kv.put(key, value);
  };

type Tracked = { queue: TrackedQueue; held: Callable[] };

class NullGitCache extends RpcTarget {}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();
  #tracked = new Map<string, Tracked>();

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

  /**
   * Opens a session on a fresh `TrackedQueue` passed as a native `RpcStub`, whose own stub is
   * disposed at once, and makes each call in `steps` on what the call before returned. The session
   * and every capability returned are held, undisposed, for `disposeHeld`/`callHeld`; index 0 is
   * the session. The last call's outcome comes back.
   */
  async openTracked(facetName: string, props: GatekeeperProps, steps: Step[]): Promise<Outcome<unknown>> {
    const queue = new TrackedQueue();
    const tracked: Tracked = { queue, held: [] };
    this.#tracked.set(facetName, tracked);
    const stub = new RpcStub(queue);
    const session = await this.#gatekeeper(facetName, props)
      .startSession(stub as unknown as RecordingQueue);
    stub[Symbol.dispose]();
    tracked.held.push(session);
    return await outcome(async () => {
      let target: Callable = session;
      for (const [method, ...args] of steps) {
        target = await target[method](...args) as Callable;
        tracked.held.push(target);
      }
      return null;
    });
  }

  disposeHeld(facetName: string, index: number): void {
    this.#tracked.get(facetName)!.held[index][Symbol.dispose]?.();
  }

  async callHeld(facetName: string, index: number, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#tracked.get(facetName)!.held[index][method](...args));
  }

  trackedQueue(facetName: string): { released: boolean; observations: number } {
    const { queue } = this.#tracked.get(facetName)!;
    return { released: queue.released, observations: queue.observations.length };
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

  /** Writes `key` into the facet's storage, as an earlier version of the gatekeeper would have. */
  async putStorage(facetName: string, props: GatekeeperProps, key: string, value: unknown): Promise<void> {
    await this.#gatekeeper(facetName, props).putTestStorage(key, value);
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
}
