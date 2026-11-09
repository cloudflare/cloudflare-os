/**
 * A hook driver's enabled hooks, and the delivery every driver makes the same way: a firing started
 * through the hook's `HookInitiator`, handed with the message to the binding's own delivery stub,
 * which decides whether the hook receives it.
 */

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue, HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import { HookDeliveryQueue, disposeStubs } from "./hook-delivery-queue";
import type { KvScannable } from "./kv";

/** What a hook's delivery stub reaches: its binding's facet, narrowed to delivering. */
export interface HookDelivery<Hook extends RpcTarget, Message> extends RpcTarget {
  /**
   * Deliver `message` to one firing of the hook, as `HookInitiator.startHook()` returned it, if the
   * binding admits it; otherwise return without calling the hook. A throw is retried.
   */
  deliver(callback: RpcStub<Hook>, approvalQueue: RpcStub<ApprovalQueue>, message: Message): Promise<void>;
}

/** The stubs a driver stores for one enabled hook. */
export type HookCapabilities<Hook extends RpcTarget, Message> = {
  delivery: RpcStub<HookDelivery<Hook, Message>>;
  initiator: Fetcher<HookInitiator<Hook>>;
};

/**
 * A hook's stored stubs as a delivery calls them: the interfaces themselves, since Worker RPC's
 * mapped stub types don't resolve over an unbound `Hook` or `Message`.
 */
type Held<Hook extends RpcTarget, Message> = {
  delivery: Disposable & Pick<HookDelivery<Hook, Message>, "deliver">;
  initiator: { startHook(): Promise<Disposable & Awaited<ReturnType<HookInitiator<Hook>["startHook"]>>> };
};

const REGISTRATIONS = "reg:";
const CAPABILITIES = "caps:";

/**
 * A driver's enabled hooks, stored under `reg:{key}` (what the driver filters events by) and
 * `caps:{key}` (the hook's stubs), with their `HookDeliveryQueue`. Every method but `run()` is
 * synchronous, so a driver can change its own records and a hook's in one turn. The driver owns its
 * alarm, as with the queue: it calls `run()` from it, and sets it for `nextDue()` afterwards.
 *
 * Nothing is kept in memory, so a driver may read or delete these records itself, as on
 * disconnecting. One that deletes a `caps:{key}` passes it to `disposeStubs()` first.
 *
 * There is no lookup by key: no driver's provider names the hook it pushes for. Add a `get(key)`
 * reading `reg:{key}` when one does.
 *
 * @example
 * ```ts
 * #hooks = new HookRegistry<EventHook, Event, Registration>(this.ctx.storage.kv, () => logger.warn("dropped an event"));
 *
 * async ingest(event: Event) {
 *   for (const [key, registration] of this.#hooks.entries()) {
 *     if (watches(registration, event)) this.#hooks.enqueue(key, event.id, event, Date.now());
 *   }
 * }
 * ```
 */
export class HookRegistry<Hook extends RpcTarget, Message, Registration> {
  readonly #kv: KvScannable;
  readonly #queue: HookDeliveryQueue<Message>;

  /**
   * @param kv The driver's `ctx.storage.kv`.
   * @param onDrop Called once for each message dropped after repeated delivery failures.
   */
  constructor(kv: KvScannable, onDrop: () => void) {
    this.#kv = kv;
    this.#queue = new HookDeliveryQueue<Message>(kv, onDrop);
  }

  /**
   * Enable hook `key`, or replace what it was enabled with, releasing the stubs it replaces.
   * @throws {TypeError} If `key` contains `:`, which separates it from a message id in the queue.
   */
  set(key: string, registration: Registration, capabilities: HookCapabilities<Hook, Message>): void {
    if (key.includes(":")) throw new TypeError("A hook key must not contain ':'.");
    const replaced = this.#kv.get<object>(CAPABILITIES + key);
    this.#kv.put(REGISTRATIONS + key, registration);
    this.#kv.put(CAPABILITIES + key, capabilities);
    disposeStubs(replaced);
  }

  /**
   * Disable hook `key`: forget it, release its stubs, and end its queued deliveries.
   * @returns What it was registered with, if it was enabled.
   */
  remove(key: string): Registration | undefined {
    const registration = this.#kv.get<Registration>(REGISTRATIONS + key);
    disposeStubs(this.#kv.get<object>(CAPABILITIES + key));
    this.#kv.delete(REGISTRATIONS + key);
    this.#kv.delete(CAPABILITIES + key);
    this.#queue.cancel(key);
    return registration;
  }

  /** @returns Every enabled hook, by key, listed in full: safe to hold across writes and awaits. */
  entries(): [key: string, registration: Registration][] {
    return Array.from(this.#kv.list<Registration>({ prefix: REGISTRATIONS }),
      ([key, registration]) => [key.slice(REGISTRATIONS.length), registration]);
  }

  /** Queue `message` for hook `key`, as `HookDeliveryQueue.enqueue()` does. */
  enqueue(key: string, messageId: string, message: Message, now: number): void {
    this.#queue.enqueue(key, messageId, message, now);
  }

  /** Deliver what has come due, as `HookDeliveryQueue.run()` does. */
  async run(now: number): Promise<void> {
    await this.#queue.run(now, (key, message) => this.#deliver(key, message));
  }

  /** @returns When the queue next needs the driver's alarm, if it does. */
  nextDue(): number | undefined {
    return this.#queue.nextDue();
  }

  async #deliver(key: string, message: Message): Promise<void> {
    // A disabled hook's rows are finished, and it gets no new ones.
    const capabilities = this.#kv.get<Held<Hook, Message>>(CAPABILITIES + key);
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling the hook ends the retries. Awaited, not pipelined: workerd can't pass a
      // property of a pending result into another call.
      using firing = await capabilities.initiator.startHook();
      await capabilities.delivery.deliver(firing.callback, firing.approvalQueue, message);
    } finally {
      disposeStubs(capabilities);
    }
  }
}
