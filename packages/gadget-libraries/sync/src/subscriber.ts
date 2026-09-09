/**
 * The object a client hands to the server's `subscribe`.
 *
 * A gadget's callbacks reach it as calls on an `RpcTarget`, and the RPC layer exposes the
 * prototype's methods of such a target and nothing of its own properties. The class comes from
 * the gadget's bootstrap -- a library cannot import it -- so the gadget passes it in, as it passes
 * its `gadget` stub, and {@link createSubscriber} builds the target: a subclass of the host's class
 * whose prototype carries each callback under its name.
 */

/** What the gadget's bootstrap supplies that a library cannot import: the RPC layer's `RpcTarget`. */
export interface SyncHost {
  /** Cap'n Web's `RpcTarget`, as the gadget's `client.js` sees it. */
  RpcTarget: new () => object;
}

/**
 * An `RpcTarget` whose remotely callable methods are `callbacks`' functions, under their names.
 * `callbacks` is a plain object of functions (its own enumerable properties; a class instance's
 * prototype methods are not seen), and the result is what to pass to the server's `subscribe`.
 */
export function createSubscriber<Callbacks extends object>(RpcTarget: SyncHost["RpcTarget"], callbacks: Callbacks): Callbacks {
  class Subscriber extends RpcTarget {}
  for (const [name, callback] of Object.entries(callbacks)) {
    if (typeof callback !== "function") throw new TypeError(`Subscriber callback "${name}" is not a function.`);
    Object.defineProperty(Subscriber.prototype, name, { value: callback, writable: true, configurable: true });
  }
  return new Subscriber() as Callbacks;
}
