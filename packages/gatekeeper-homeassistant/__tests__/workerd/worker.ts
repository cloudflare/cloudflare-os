// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does: as
// a facet made from `ctx.exports`. A stub to a facet, or to a session it mints, cannot be handed to
// the test, so TestHooks holds them and the test drives them by index.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../../src/homeassistant.js";
export * from "../../src/homeassistant.js";

type GatekeeperProps = { userObjectId: string; resourceKind: "instance"; resourceId?: string };

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = { startSession(queue: TrackedQueue): Promise<Callable> };

type TestExports = { HomeAssistantGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass };

/** An approval queue that records observations, and when native RPC releases it: once every stub
 * to it is disposed -- when the Workshop would stop counting its collaborator as live. */
class TrackedQueue extends RpcTarget {
  observations: ObservationDescription[] = [];
  released = false;

  async submitAction(): Promise<void> {}

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

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

export type Step = [method: string, ...args: unknown[]];

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #tracked = new Map<string, { queue: TrackedQueue; held: Callable[] }>();

  /**
   * Opens a session on a fresh `TrackedQueue` passed as a native `RpcStub`, whose own stub is
   * disposed once `startSession` settles, and makes each call in `steps` on what the call before
   * returned. Each capability is held for `disposeHeld`/`callHeld`; index 0 is the session.
   */
  async openTracked(facetName: string, props: GatekeeperProps, steps: Step[]): Promise<Outcome<null>> {
    const queue = new TrackedQueue();
    const tracked = { queue, held: [] as Callable[] };
    this.#tracked.set(facetName, tracked);
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).HomeAssistantGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
    const stub = new RpcStub(queue);
    try {
      tracked.held.push(await gatekeeper.startSession(stub as unknown as TrackedQueue));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      stub[Symbol.dispose]();
    }
    return await outcome(async () => {
      let target = tracked.held[0];
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
}
