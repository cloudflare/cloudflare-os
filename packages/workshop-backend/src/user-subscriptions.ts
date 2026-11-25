import { RpcStub, RpcTarget } from "capnweb";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.user.subscriptions");

/**
 * Most deliveries queued for one listener. A listener this far behind has its queue dropped and is
 * sent one fresh snapshot instead.
 */
export const MAX_PENDING_DELIVERIES = 64;

/** Most leases one collection holds; a subscribe past it throws. */
export const MAX_SUBSCRIPTIONS = 64;

type Delivery<T extends RpcTarget, D> = (listener: RpcStub<T>, data: D) => Promise<void>;

interface Listener<T extends RpcTarget, D> {
  data: D;
  snapshot: ((listener: RpcStub<T>) => Promise<void>) | null;
  queue: Delivery<T, D>[];
  delivering: boolean;
  release: () => void;
}

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
 * every send(). A listener gets its deliveries one at a time, in order.
 */
export class UserSubscriptions<T extends RpcTarget, D = void> {
  #listeners = new Map<RpcStub<T>, Listener<T, D>>();

  /** `feed` is a stable name for logs, as `"unread"`. */
  constructor(private readonly ctx: DurableObjectState, private readonly feed: string) {}

  get size(): number { return this.#listeners.size; }

  /**
   * `snapshot`, if any, is the first delivery, made right away, and is made again for a listener
   * whose queue overflows, so it must read the state when called.
   */
  add(callback: RpcStub<T>, snapshot: ((listener: RpcStub<T>) => Promise<void>) | null, data: D): RpcStub<{}> {
    if (this.#listeners.size >= MAX_SUBSCRIPTIONS) {
      throw new Error(`At most ${MAX_SUBSCRIPTIONS} subscriptions to this feed may be open at once.`);
    }
    let listener = callback.dup();
    let entry: Listener<T, D> = {data, snapshot, queue: [], delivering: false, release: () => {
      if (!this.#listeners.delete(listener)) return;
      entry.queue = [];
      listener[Symbol.dispose]();
    }};
    this.#listeners.set(listener, entry);
    // Native RPC has no onRpcBroken hook. Treating it as a method sends a bogus call;
    // the lease and failed deliveries already cover the native hop's lifetime.
    if (Object.getPrototypeOf(listener) !== NativeRpcStub.prototype) listener.onRpcBroken(entry.release);
    if (snapshot) this.#enqueue(listener, entry, snapshot);
    return new RpcStub<{}>(new SubscriptionLease(entry.release));
  }

  send(update: Delivery<T, D>): void {
    for (let [listener, entry] of this.#listeners) this.#enqueue(listener, entry, update);
  }

  #enqueue(listener: RpcStub<T>, entry: Listener<T, D>, delivery: Delivery<T, D>): void {
    // A replacement snapshot not yet started reads the state when it runs, covering this update.
    // (The first snapshot starts as it is queued, so a lone snapshot queued is a replacement.)
    if (entry.queue.length === 1 && entry.queue[0] === entry.snapshot) return;
    if (entry.queue.length >= MAX_PENDING_DELIVERIES) {
      logger.warn("subscription queue overflowed", {event: "user.subscription.overflow", feed: this.feed});
      if (!entry.snapshot) return entry.release();
      // Taken after the delivery in flight, the snapshot covers this update and those dropped.
      entry.queue = [entry.snapshot];
      return;
    }
    entry.queue.push(delivery);
    if (!entry.delivering) this.ctx.waitUntil(this.#deliver(listener, entry));
  }

  async #deliver(listener: RpcStub<T>, entry: Listener<T, D>): Promise<void> {
    entry.delivering = true;
    try {
      // A released listener's queue is emptied.
      for (let delivery; (delivery = entry.queue.shift());) await delivery(listener, entry.data);
    } catch {
      entry.release();
    } finally {
      entry.delivering = false;
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
