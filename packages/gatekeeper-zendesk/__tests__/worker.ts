// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object for the one thing a test cannot reach directly.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: `ctx.facets` -- the only
// way to turn a props-carrying `DurableObjectClass` into a running object -- exists on Durable
// Objects alone. That asymmetry is the whole reason `ZendeskAccount` owns the management facet.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Named rather than `export *`: the loopback bindings on `ctx.exports` are built from the module's
// declared exports, and the vendor's OAuth completion reaches for `ctx.exports.ZendeskUserImpl`.
export { default } from "../src/zendesk.js";
export {
  GatekeeperVendor,
  ZendeskAccount,
  ZendeskGatekeeper,
  ZendeskUserImpl,
  ZendeskVerifier,
} from "../src/zendesk.js";

type GatekeeperProps = { accountId: string; subdomain: string; ticketId?: string };

/**
 * The Workshop capability the vendor calls back on once OAuth completes.
 *
 * It is a `WorkerEntrypoint` rather than a local `RpcTarget`: `setCallback` persists the callback in
 * Durable Object storage, and only a stub that can outlive the request survives that write.
 */
export class TestConnectCallback extends WorkerEntrypoint {
  async complete(): Promise<void> {}
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(): Promise<void> {}
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  /**
   * Calls a gatekeeper method on the `DurableObjectClass` itself -- exactly what
   * `startAppUi` used to hand the Work Items adapter -- and reports what came back.
   *
   * The cast is deliberate and is the point of the hook: with `exportsOf` returning the generated
   * `Cloudflare.Exports`, this line does not typecheck without it, so the test has to opt in to the
   * mistake in order to demonstrate the runtime consequence.
   */
  async callSourceStatusesOnClass(props: GatekeeperProps): Promise<string> {
    const exports = (this.ctx as unknown as { exports: Cloudflare.Exports }).exports;
    const durableClass = exports.ZendeskGatekeeper({ props });
    try {
      await (durableClass as unknown as { sourceStatuses(): Promise<unknown> }).sourceStatuses();
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
