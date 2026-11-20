import { RpcStub, RpcTarget } from "capnweb";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

// A plain object with a symbol property loses its cleanup when sent through RPC.
@validateRpc()
class SubscriptionLease extends RpcTarget {
  #release: () => void;

  constructor(release: () => void) {
    super();
    this.#release = release;
  }

  [Symbol.dispose](): void { this.#release(); }
}

/**
 * Retains callbacks until their lease is disposed, their RPC breaks, or a delivery fails. Each
 * listener keeps the `data` it was added with (as an unread subscription's scope), passed back to
 * every send().
 */
export class UserSubscriptions<T extends RpcTarget, D = void> {
  #listeners = new Map<RpcStub<T>, {data: D; release: () => void}>();

  constructor(private readonly ctx: DurableObjectState) {}

  get size(): number { return this.#listeners.size; }

  /** `snapshot`, if any, is the first delivery, made right away. */
  add(callback: RpcStub<T>, snapshot: ((listener: RpcStub<T>) => Promise<void>) | null, data: D): RpcStub<{}> {
    let listener = callback.dup();
    let release = () => {
      if (this.#listeners.delete(listener)) listener[Symbol.dispose]();
    };
    this.#listeners.set(listener, {data, release});
    // Native RPC has no onRpcBroken hook. Treating it as a method sends a bogus call;
    // the lease and failed deliveries already cover the native hop's lifetime.
    if (Object.getPrototypeOf(listener) !== NativeRpcStub.prototype) listener.onRpcBroken(release);
    if (snapshot) this.ctx.waitUntil(snapshot(listener).catch(release));
    return new RpcStub<{}>(new SubscriptionLease(release));
  }

  send(update: (listener: RpcStub<T>, data: D) => Promise<void>): void {
    for (let [listener, {data, release}] of this.#listeners) {
      this.ctx.waitUntil(update(listener, data).catch(release));
    }
  }

  /**
   * Make a call to every listener and return each one's promise, for a caller that wants to know
   * who took it. Unlike send(), a rejection does not drop the listener.
   */
  call<R>(call: (listener: RpcStub<T>) => Promise<R>): Promise<R>[] {
    return [...this.#listeners.keys()].map(call);
  }
}
