/**
 * The fan-out behind a push-driven hook driver, which sends one provider event to every hook
 * enabled against it that watches for it. This holds those hooks, and makes the delivery every
 * driver makes the same way: a firing started through the hook's `HookInitiator`, handed with the
 * message to the binding's own delivery stub, which decides whether the hook receives it. Receiving
 * the event and choosing its hooks stay in the driver.
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

type StartHook<Hook extends RpcTarget> = HookInitiator<Hook>["startHook"];

/**
 * A hook's stored stubs as a delivery calls them: the interfaces themselves, since Worker RPC's
 * mapped stub types don't resolve over an unbound `Hook` or `Message`. Mapped over
 * `HookCapabilities`, so the two name the same stubs.
 */
type Held<Hook extends RpcTarget, Message> = {
  [Stub in keyof HookCapabilities<Hook, Message>]: {
    delivery: Disposable & Pick<HookDelivery<Hook, Message>, "deliver">;
    initiator: { startHook(...args: Parameters<StartHook<Hook>>): Promise<Disposable & Awaited<ReturnType<StartHook<Hook>>>> };
  }[Stub];
};

/** A `HookRegistry`'s `screen`: whether a hook, as registered, might take `message`. */
type Screen<Hook extends RpcTarget, Message, Registration> =
  (registration: Registration, capabilities: HookCapabilities<Hook, Message>, message: Message) => Promise<boolean>;

const REGISTRATIONS = "reg:";
const CAPABILITIES = "caps:";

/**
 * A driver's enabled hooks, stored under `reg:{key}` (what the driver filters events by) and
 * `caps:{key}` (the hook's stubs), with their `HookDeliveryQueue`. Every method but `run()` is
 * synchronous, so a driver can change its own records and a hook's in one turn. The driver owns its
 * alarm, as with the queue: it brings it forward after `enqueue()`, calls `run()` from it, and sets
 * it for `nextDue()` afterwards.
 *
 * The records live only in storage, so a driver may read them itself, and may delete all of its
 * storage at once, as on disconnecting, passing each `caps:{key}` to `disposeStubs()`
 * (`./hook-delivery-queue`) first. One hook alone goes through `remove()`: deleting only its records
 * leaves its queued messages to be delivered if it is enabled again.
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
 *   await this.ctx.storage.setAlarm(Date.now());
 * }
 *
 * async alarm() {
 *   await this.#hooks.run(Date.now());
 *   const next = this.#hooks.nextDue();
 *   if (next !== undefined) await this.ctx.storage.setAlarm(next);
 * }
 * ```
 */
export class HookRegistry<Hook extends RpcTarget, Message, Registration> {
  readonly #kv: KvScannable;
  readonly #queue: HookDeliveryQueue<Message>;
  readonly #screen?: Screen<Hook, Message, Registration>;
  #running?: Promise<void>;

  /**
   * @param kv The driver's `ctx.storage.kv`.
   * @param onDrop Called once for each message dropped after repeated delivery failures.
   * @param screen Asked before a message's firing is started: resolve `false` to finish the message
   * without one. For a provider that can't narrow what it pushes to what a hook watches for, whose
   * every event would otherwise start a firing in each hook's workspace. A throw is retried, as a
   * delivery's is.
   */
  constructor(kv: KvScannable, onDrop: () => void, screen?: Screen<Hook, Message, Registration>) {
    this.#kv = kv;
    this.#screen = screen;
    this.#queue = new HookDeliveryQueue<Message>(kv, onDrop);
  }

  /**
   * Enable hook `key`, or replace what it was enabled with, releasing the stubs it replaces. A
   * throw from its second write does not undo its first: call it within
   * `ctx.storage.transactionSync()` so that a registration that can't be stored leaves the hook as
   * it was.
   * @throws {TypeError} If `key` contains `:`, which separates it from a message id in the queue.
   */
  set(key: string, registration: Registration, capabilities: HookCapabilities<Hook, Message>): void {
    if (key.includes(":")) throw new TypeError("A hook key must not contain ':'.");
    const replaced = this.#kv.get<object>(CAPABILITIES + key);
    try {
      // Stubs first: a registration stored without them would have its messages finished undelivered.
      this.#kv.put(CAPABILITIES + key, capabilities);
      this.#kv.put(REGISTRATIONS + key, registration);
    } finally {
      disposeStubs(replaced);
    }
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

  /**
   * Deliver what has come due, as `HookDeliveryQueue.run()` does. A call made while one is in flight
   * joins it, as two runs would each deliver the same messages.
   */
  run(now: number): Promise<void> {
    return this.#running ??= this.#queue.run(now, (key, message) => this.#deliver(key, message))
      .finally(() => { this.#running = undefined; });
  }

  /** @returns When the queue next needs the driver's alarm, if it does. */
  nextDue(): number | undefined {
    return this.#queue.nextDue();
  }

  async #deliver(key: string, message: Message): Promise<void> {
    // A disabled hook's rows are finished, and it gets no new ones.
    const capabilities = this.#kv.get<Held<Hook, Message> & HookCapabilities<Hook, Message>>(CAPABILITIES + key);
    if (!capabilities) return;
    try {
      const registration = this.#kv.get<Registration>(REGISTRATIONS + key);
      if (this.#screen && registration !== undefined &&
          !await this.#screen(registration, capabilities, message)) {
        return;
      }
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
