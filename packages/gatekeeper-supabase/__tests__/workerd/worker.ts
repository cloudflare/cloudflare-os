// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a capability its session hands out, cannot be handed to the test, so TestHooks
// holds each capability under a name the test gives it and makes the test's calls on it.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../../src/supabase.js";
export * from "../../src/supabase.js";

export type GatekeeperProps =
  | { userObjectId: string; resourceKind: "project"; ref: string }
  | { userObjectId: string; resourceKind: "organization"; slug: string };

type TestExports = {
  SupabaseGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
};

type Capability = Record<string, (...args: unknown[]) => Promise<unknown>> & Disposable;

type GatekeeperFacet = {
  startSession(queue: RpcStub<TestQueue>): Promise<Capability>;
};

/**
 * An approval queue that records the observations it authorizes, and whether the gatekeeper still
 * holds it. An observation whose title has a hold waits until the hold is lifted.
 */
class TestQueue extends RpcTarget {
  readonly observations: string[] = [];
  readonly waiting: string[] = [];
  /** Titles whose authorization waits until TestHooks resolves them. */
  readonly holds = new Map<string, PromiseWithResolvers<void>>();
  released = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    const hold = this.holds.get(description.title);
    if (hold) {
      this.waiting.push(description.title);
      await hold.promise;
    }
    this.observations.push(description.title);
  }

  // Runs once every stub to this queue is gone, TestHooks' own and each duplicate the gatekeeper
  // made: when the Workshop's `leave` would run and stop counting the session's collaborator live.
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

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, TestQueue>();
  #capabilities = new Map<string, Capability>();

  #queue(facetName: string): TestQueue {
    const queue = this.#queues.get(facetName);
    if (!queue) throw new Error(`No session was started on ${facetName}.`);
    return queue;
  }

  #capability(facetName: string, name: string): Capability {
    const capability = this.#capabilities.get(`${facetName}/${name}`);
    if (!capability) throw new Error(`No capability is held as ${name}.`);
    return capability;
  }

  /**
   * Starts a session on a fresh queue and holds it as `name`. TestHooks disposes its own stub to
   * the queue before returning, so only what the gatekeeper kept holds the queue afterwards.
   */
  async startSession(facetName: string, props: GatekeeperProps, name: string): Promise<Outcome<void>> {
    const queue = new TestQueue();
    this.#queues.set(facetName, queue);
    using stub = new RpcStub(queue);
    const exports = this.ctx.exports as unknown as TestExports;
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: exports.SupabaseGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
    return await outcome(async () => {
      this.#capabilities.set(`${facetName}/${name}`, await gatekeeper.startSession(stub));
    });
  }

  /** Calls `method` on the capability held as `holder`, holding the capability it returns as `name`. */
  async open(facetName: string, holder: string, method: string, args: unknown[], name: string):
      Promise<Outcome<void>> {
    return await outcome(async () => {
      const opened = await this.#capability(facetName, holder)[method](...args) as Capability;
      this.#capabilities.set(`${facetName}/${name}`, opened);
    });
  }

  /** Calls `method` on the capability held as `holder`, returning what it returns. */
  async call(facetName: string, holder: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#capability(facetName, holder)[method](...args));
  }

  /** Disposes TestHooks' stub to the capability held as `name`. */
  dispose(facetName: string, name: string): void {
    this.#capability(facetName, name)[Symbol.dispose]();
    this.#capabilities.delete(`${facetName}/${name}`);
  }

  /** Makes the session's observations titled `title` wait until `lift` is called. */
  hold(facetName: string, title: string): void {
    this.#queue(facetName).holds.set(title, Promise.withResolvers());
  }

  lift(facetName: string, title: string): void {
    const { holds } = this.#queue(facetName);
    holds.get(title)?.resolve();
    holds.delete(title);
  }

  /** What the session's queue has seen. Not `queue`, which names the Queues consumer handler. */
  queueState(facetName: string): { observations: string[]; waiting: string[]; released: boolean } {
    const { observations, waiting, released } = this.#queue(facetName);
    return { observations, waiting, released };
  }
}
