// Test worker for the workerd suite: the generated gatekeeper's own entrypoints, so miniflare can
// bind its Durable Objects, and `TestHooks`, which does what only code inside the Worker can: mint
// the Workshop's connect callback and reach the account's entrypoint.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { GatekeeperUserImpl } from "#gatekeeper/acme";

export { default } from "#gatekeeper/acme";
export * from "#gatekeeper/acme";

type UserProps = { userObjectId: string };

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate vite plugin a decorated
 * `WorkerEntrypoint` export is not registered in `ctx.exports`; an undecorated subclass is, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** A stand-in for the Workshop's connect callback. */
export class TestCallback extends WorkerEntrypoint<unknown, UserProps> {
  async credentialsExpired(): Promise<void> {}

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string) {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

export class TestHooks extends DurableObject {
  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string): Promise<void> {
    const exports = this.ctx.exports as any;
    const callback = exports.TestCallback({ props: { userObjectId } });
    await exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId)).setCallback(callback, initiationNonce);
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    try {
      return { ok: await (this.ctx.exports as any).TestUser({ props: { userObjectId } })[method](...args) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
