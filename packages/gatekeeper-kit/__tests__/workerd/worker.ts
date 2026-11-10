// Fixture for the suites that need real Durable Object storage rather than the cloning Node fake.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { HookRegistry } from "../../src/hook-registry";
import { ObserverTracker } from "../../src/observers";
export { ConformanceAccount, ConformanceResource, ConformanceVerifier } from "./conformance/gatekeeper";

type VerifierProps = { allowed: readonly string[]; dropVerdicts?: number };

/**
 * A verifier reached the way the overseer's is: a `WorkerEntrypoint` behind a service binding, which
 * is what makes it a *persistent* stub. An ad-hoc `RpcTarget` has no durable address and Durable
 * Object storage refuses it outright, flag or no flag.
 */
export class FixtureVerifier extends WorkerEntrypoint<unknown, VerifierProps> {
  async hasSets(collectionIds: readonly string[]): Promise<boolean[]> {
    const verdicts = collectionIds.map(collectionId => this.ctx.props.allowed.includes(collectionId));
    return verdicts.slice(0, verdicts.length - (this.ctx.props.dropVerdicts ?? 0));
  }
}

type Verifier = { hasSets(collectionIds: readonly string[]): Promise<boolean[]> };

/** Drives a tracker whose storage is a real DO's, so a persisted stub is a persisted stub. */
export class TrackerHost extends DurableObject {
  readonly #tracker = this.#newTracker();

  /** Built the way a gatekeeper that rebuilds one per accessor gets it: fresh from
   *  `this.ctx.storage.kv`, whose durable markers every tracker over it reads. */
  #newTracker(): ObserverTracker<Verifier> {
    return new ObserverTracker<Verifier>({
      kv: this.ctx.storage.kv,
      hasCollectionAccess: (verifier, collectionIds) => verifier.hasSets(collectionIds),
    });
  }

  async admit(id: string, props: VerifierProps): Promise<void> {
    await this.#tracker.addObserver(id, this.ctx.exports.FixtureVerifier({ props }));
  }

  /** Holds a withheld read open and reports what admitting through a *second* tracker did. */
  async admitDuringWithheldRead(id: string, props: VerifierProps): Promise<string> {
    const check = this.#tracker.prepareWithheld();
    try {
      await this.#newTracker().addObserver(id, this.ctx.exports.FixtureVerifier({ props }));
      return "admitted";
    } catch (error) {
      return String(error);
    } finally {
      check.discard?.();
    }
  }

  observerIds(): string[] {
    return this.#tracker.observerIds();
  }

  /** Reveals `collectionIds`, commits, and reports who the read had to be hidden from. */
  async reveal(collectionIds: string[]): Promise<string[]> {
    const check = await this.#tracker.prepareObservation(collectionIds);
    const excluded = [...(check.excludeObservers ?? [])];
    check.commit();
    return excluded;
  }

  /** Proves the stub survived the write: re-read from storage and call it. */
  async askStored(id: string, collectionIds: string[]): Promise<boolean[] | undefined> {
    return await this.ctx.storage.kv.get<Verifier>(`observer:${id}`)?.hasSets(collectionIds);
  }
}

/** The hook a firing calls, which tells its `HookHost` what it received. */
class FixtureHook extends RpcTarget {
  readonly #host: DurableObjectStub<HookHost>;

  constructor(host: DurableObjectStub<HookHost>) {
    super();
    this.#host = host;
  }

  async receive(message: string): Promise<void> {
    await this.#host.received(message);
  }
}

class FixtureApprovalQueue extends RpcTarget {}

/** Starts a firing as the Workshop's `HookInitiator` does, behind a persistent stub. */
export class FixtureHookInitiator extends WorkerEntrypoint<unknown, { host: string }> {
  async startHook() {
    const host = this.ctx.exports.HookHost.getByName(this.ctx.props.host);
    return { callback: new FixtureHook(host), approvalQueue: new FixtureApprovalQueue() };
  }
}

/** A binding's delivery stub, which admits every message. */
export class FixtureHookDelivery extends WorkerEntrypoint {
  async deliver(callback: RpcStub<FixtureHook>, _approvalQueue: unknown, message: string): Promise<void> {
    await callback.receive(message);
  }
}

/** A driver's registry over a real DO's storage, which hands back a fresh stub on every read. */
export class HookHost extends DurableObject {
  readonly #hooks = new HookRegistry<FixtureHook, string, unknown>(this.ctx.storage.kv, () => {});
  readonly #received: string[] = [];

  /** Enables `key` in a transaction, with a registration storage refuses unless `storable`. */
  enable(key: string, storable = true): void {
    this.ctx.storage.transactionSync(() => this.#hooks.set(key, storable ? "registration" : () => {}, {
      delivery: this.ctx.exports.FixtureHookDelivery({}),
      initiator: this.ctx.exports.FixtureHookInitiator({ props: { host: this.ctx.id.name! } }),
    } as never));
  }

  holdsStubs(key: string): boolean {
    return this.ctx.storage.kv.get(`caps:${key}`) !== undefined;
  }

  /** Queues and runs `message`, and reports everything the hook has received. */
  async deliver(key: string, message: string): Promise<string[]> {
    this.#hooks.enqueue(key, message, message, Date.now());
    await this.#hooks.run(Date.now());
    return this.#received;
  }

  received(message: string): void {
    this.#received.push(message);
  }
}

export default {
  fetch: () => new Response("fixture", { status: 404 }),
};
