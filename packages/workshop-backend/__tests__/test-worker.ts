// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";

export * from "../src/server.js";
export { default } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}

/** What each FakeGatekeeperAccount has been asked to do, by its `name` prop. */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.name` so a test can ask any instance what happened (`calls()`); with
 * `failRevoke`, every `revoke()` rejects after being recorded.
 */
export class FakeGatekeeperAccount
    extends WorkerEntrypoint<unknown, { name: string; failRevoke?: boolean }> {
  #record(call: string) {
    const calls = accountCalls.get(this.ctx.props.name) ?? [];
    calls.push(call);
    accountCalls.set(this.ctx.props.name, calls);
  }

  async describe(): Promise<AccountDescription> {
    this.#record("describe");
    return { displayName: this.ctx.props.name, uniqueName: this.ctx.props.name };
  }

  async revoke(): Promise<void> {
    this.#record("revoke");
    if (this.ctx.props.failRevoke) throw new Error("revoke failed");
  }

  async commitReconnect(stageId: string): Promise<void> {
    this.#record(`commitReconnect(${stageId})`);
  }

  async calls(): Promise<string[]> {
    return accountCalls.get(this.ctx.props.name) ?? [];
  }
}
