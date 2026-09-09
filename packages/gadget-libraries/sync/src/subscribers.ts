/**
 * The browsers subscribed to one Durable Object, and how events reach them.
 *
 * A subscriber arrives as the client's `RpcTarget`, seen from here through a Workers RPC stub that
 * is only valid for the call that delivered it. Keeping it means `dup()`-ing it, and dropping it
 * means disposing that copy; the runtime's `onRpcBroken` says when the connection behind it went
 * away. Delivery isolates subscribers from each other and from the object: a broadcast is issued to
 * everyone at once and never awaited, so one whose call fails is dropped rather than failing the
 * mutation that was being broadcast (and the rest are told it left, exactly as they would be had
 * its connection closed), one that never answers holds up nothing but itself, and a callback may
 * itself call back into the object -- read the document, queue another mutation -- without
 * deadlocking on the mutation that is telling it about the last one. Because deliveries are issued
 * synchronously, in call order, each subscriber still hears events in the order they were sent.
 *
 * Presence is the one thing the registry knows how to say itself, through the optional
 * {@link PresenceHooks}: a newcomer is first told about everyone already here, then announced to
 * everyone, and whoever drops out is announced as gone. What a "join" or "leave" looks like on the
 * wire is the gadget's, so the hooks express it in the gadget's own callback vocabulary. A gadget
 * with no presence (a deck everyone sees the same way) passes no hooks and gets a plain fan-out.
 */

/**
 * What the RPC layer adds to a subscriber's callbacks: the `dup` that keeps it past the call that
 * delivered it, the disposer that releases it, and the disconnection hook.
 */
export interface SubscriberStub {
  /** A copy that survives the end of the RPC call this stub arrived in. */
  dup(): this;
  /** Runs once when the connection behind this stub is gone. */
  onRpcBroken(handler: (error: unknown) => void): void;
  /** Releases this stub. */
  [Symbol.dispose](): void;
}

/**
 * How the registry announces presence, in the gadget's own callback vocabulary. Each hook sends
 * one message to one subscriber and may return a promise; a rejection drops that subscriber.
 */
export interface PresenceHooks<Callbacks, Info> {
  /** Tell `subscriber` that `who` is here: what a newcomer hears about each earlier arrival, and everyone about the newcomer. */
  join(subscriber: Callbacks, who: Info): unknown;
  /** Tell `subscriber` that `who` is gone. */
  leave(subscriber: Callbacks, who: Info): unknown;
}

/**
 * The subscribers of one object, each with what it said about itself on arrival (`Info`; `void`
 * for a gadget that keeps nothing per subscriber). `Callbacks` is the interface the client's
 * `RpcTarget` implements.
 */
export class SubscriberRegistry<Callbacks extends object, Info = void> {
  readonly #subscribers = new Map<Callbacks & SubscriberStub, Info>();
  readonly #presence: PresenceHooks<Callbacks, Info> | null;

  constructor(presence?: PresenceHooks<Callbacks, Info>) {
    this.#presence = presence ?? null;
  }

  /** How many subscribers are registered. */
  get size(): number {
    return this.#subscribers.size;
  }

  /** Whether `subscriber` -- the handle {@link add} returned -- is still registered. */
  has(subscriber: Callbacks): boolean {
    return this.#subscribers.has(subscriber as Callbacks & SubscriberStub);
  }

  /** What each subscriber said about itself, in order of arrival. */
  members(): Info[] {
    return Array.from(this.#subscribers.values());
  }

  /**
   * Keep `subscriber` -- the stub the RPC layer delivered, typed as the client implements it --
   * until its connection breaks or it fails a delivery, and announce its presence when hooks are
   * set: it is seeded with everyone already here, all at once, and then announced to everyone,
   * after the current task so that the call that subscribed it returns first. A newcomer that
   * fails a seed is gone already: it is dropped, and its leave is announced, because it was a
   * member from the moment it was added -- a subscriber added during its seeding window was seeded
   * with it, and would otherwise show it until its own roster expired it. Returns the kept handle,
   * for {@link remove}.
   */
  add(subscriber: Callbacks, who: Info): Callbacks {
    const stub = (subscriber as Callbacks & SubscriberStub).dup();
    const others = this.members();
    this.#subscribers.set(stub, who);
    stub.onRpcBroken(() => {
      if (this.#drop(stub)) this.#announceLeave(who);
    });
    const presence = this.#presence;
    if (presence) {
      queueMicrotask(async () => {
        // A newcomer gone already -- removed or broken since it was added -- was announced as it
        // went (see remove and the broken handler), and is seeded and announced no further.
        if (!this.#subscribers.has(stub)) return;
        const seeds = await Promise.allSettled(others.map((person) => Promise.resolve().then(() => presence.join(stub, person))));
        // One that fails a seed is dropped the same way a failed delivery drops it. Its join was
        // never broadcast, but a subscriber added while it was seeding took it from the members
        // and was seeded with it, so its leave has to be announced all the same.
        if (seeds.some((seed) => seed.status === "rejected")) this.#dropAndAnnounce(stub);
        if (!this.#subscribers.has(stub)) return;
        this.broadcast((each) => presence.join(each, who));
      });
    }
    return stub;
  }

  /**
   * Forget a subscriber before its connection breaks, release its stub and announce that it left.
   * Returns whether it was registered.
   */
  remove(subscriber: Callbacks): boolean {
    const stub = subscriber as Callbacks & SubscriberStub;
    const who = this.#subscribers.get(stub) as Info;
    if (!this.#drop(stub)) return false;
    this.#announceLeave(who);
    return true;
  }

  /**
   * Deliver to every subscriber at once, without waiting for any of them: each `send` is called
   * synchronously, here, and what it returns is watched rather than awaited. One whose call throws
   * or rejects is dropped rather than failing the caller, and the rest are told it left; one that
   * never settles holds up nothing but its own client. A caller that broadcasts from inside its
   * mutation queue therefore neither blocks the queue on a slow browser nor deadlocks when a
   * callback re-enters it.
   */
  broadcast(send: (subscriber: Callbacks) => unknown): void {
    for (const stub of Array.from(this.#subscribers.keys())) {
      let delivery: unknown;
      try {
        delivery = send(stub);
      } catch {
        this.#dropAndAnnounce(stub);
        continue;
      }
      Promise.resolve(delivery).catch(() => this.#dropAndAnnounce(stub));
    }
  }

  /** Drop a subscriber whose delivery failed and, when it was still here, tell the rest it left. */
  #dropAndAnnounce(stub: Callbacks & SubscriberStub): void {
    const who = this.#subscribers.get(stub) as Info;
    if (this.#drop(stub)) this.#announceLeave(who);
  }

  /** Tell everyone still here that `who` left, when there is a vocabulary to say it in. */
  #announceLeave(who: Info): void {
    const presence = this.#presence;
    if (presence) this.broadcast((each) => presence.leave(each, who));
  }

  /**
   * Forget a subscriber and release the stub `add` kept. Returns whether it was registered, so a
   * failure and a broken connection reported together drop -- and announce -- it once.
   */
  #drop(stub: Callbacks & SubscriberStub): boolean {
    if (!this.#subscribers.delete(stub)) return false;
    stub[Symbol.dispose]();
    return true;
  }
}
