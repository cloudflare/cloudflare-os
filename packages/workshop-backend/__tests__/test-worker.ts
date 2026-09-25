// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  AccountDescription,
  GatekeeperUserProfile,
  GatekeeperUserVerifier,
} from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import { OverseerDurableObject as RealOverseerDurableObject } from "../src/server.js";

export * from "../src/server.js";
export { GatekeeperUserProfileImpl } from "../src/gatekeeper-user-profile.js";
export { default } from "../src/server.js";

/**
 * The pool stands a proxy class in front of every Durable Object (`createDurableObjectWrapper`) and
 * forwards only string-keyed methods to the instance it constructs, so when the runtime looks up
 * `[restore]` on the entrypoint -- which is what `ctx.restore()` does -- it finds nothing. The
 * wrapper's prototype chain does end at `DurableObject.prototype`, and it hands the instance the
 * very `ctx` it was given, so a `[restore]()` there can route by `ctx` to any instance that has
 * registered itself (below).
 */
const restoreTargets = new WeakMap<DurableObjectState, DurableObject>();
function bridgedRestore(this: DurableObject, params: unknown): unknown {
  const target = restoreTargets.get(this.ctx) as { [restore]?: (params: unknown) => unknown } | undefined;
  if (target?.[restore] === undefined || target[restore] === bridgedRestore) {
    throw new TypeError("This Durable Object does not implement a [restore]() method.");
  }
  return target[restore](params);
}
(DurableObject.prototype as unknown as Record<symbol, unknown>)[restore] = bridgedRestore;

/** The overseer, registered for the bridge above so tests can exercise `ctx.restore()`. */
export class OverseerDurableObject extends RealOverseerDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    restoreTargets.set(ctx, this);
  }
}
/**
 * The `self` object / spawnCallable() stub entrypoint, named explicitly for the same reason as the
 * callbacks below: the overseer mints it through `ctx.exports.AgentSelfLoopback({props})`.
 */
export { AgentSelfLoopback } from "../src/server.js";
/** What a loaded gadget's `env.GADGET` and tail worker are minted from, likewise. */
export { GatekeeperLoopback, GadgetTailLoopback } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

/**
 * Test identity capability returned by a fake connected account. `identify` stands in for the
 * vendor-private method real verifiers expose to their own gatekeeper.
 */
export class FakeGatekeeperVerifier
    extends WorkerEntrypoint<Cloudflare.Env, { name: string }>
    implements GatekeeperUserVerifier {
  identify(): string {
    return this.ctx.props.name;
  }
}

/** What each FakeGatekeeperAccount has been asked to do, by its `name` prop. */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.name` so a test can ask any instance what happened (`calls()`); with
 * `failRevoke` / `failDescribe`, that method rejects after being recorded.
 */
export class FakeGatekeeperAccount extends WorkerEntrypoint<Cloudflare.Env, {
  name: string; failRevoke?: boolean; failDescribe?: boolean; providesUi?: boolean;
}> {
  #record(call: string) {
    const calls = accountCalls.get(this.ctx.props.name) ?? [];
    calls.push(call);
    accountCalls.set(this.ctx.props.name, calls);
  }

  async describe(): Promise<AccountDescription> {
    this.#record("describe");
    if (this.ctx.props.failDescribe) throw new Error("describe failed");
    return {
      displayName: this.ctx.props.name,
      uniqueName: this.ctx.props.name,
      ...(this.ctx.props.providesUi ? { providesUi: { title: this.ctx.props.name } } : {}),
    };
  }

  async revoke(): Promise<void> {
    this.#record("revoke");
    if (this.ctx.props.failRevoke) throw new Error("revoke failed");
  }

  async commitReconnect(stageId: string): Promise<void> {
    this.#record(`commitReconnect(${stageId})`);
  }

  async reconnect(): Promise<{ url: string }> {
    this.#record("reconnect");
    return { url: `https://gk.example/reconnect/${this.ctx.props.name}` };
  }

  /**
   * Nothing to grant for an empty list, as a real gatekeeper answers when the grant already covers
   * every requested resource.
   */
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    this.#record(`ensureResources(${resourceUrlPatterns.join(",")})`);
    if (resourceUrlPatterns.length === 0) return {};
    return { url: `https://gk.example/expand/${this.ctx.props.name}` };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FakeGatekeeperVerifier({ props: { name: this.ctx.props.name } });
  }

  /** Records who was delivered, proving the verifier is the selected account's and the profile is live. */
  async receiveSelectedUser(
      target: string, user: Fetcher<GatekeeperUserVerifier>, profile: Fetcher<GatekeeperUserProfile>,
  ): Promise<void> {
    const selected = user as unknown as Fetcher<FakeGatekeeperVerifier>;
    this.#record(`receiveSelectedUser(${target}, ${await selected.identify()}, ${await profile.getDisplayName()})`);
    if (target === "reject") throw new Error("Collection not found.");
  }

  async calls(): Promise<string[]> {
    return accountCalls.get(this.ctx.props.name) ?? [];
  }
}

/** Test-only bridge to Workshop entrypoints that are otherwise reached through authenticated RPC. */
export class GatekeeperUserPickerTestHooks extends DurableObject<Cloudflare.Env> {
  async createUser(userId: string, displayName: string): Promise<void> {
    const user = this.ctx.exports.UserDurableObject.getByName(userId);
    await user.authenticateFromCfAccess(userId, true);
    await user.setOwnDisplayName(displayName);
  }

  async renameUser(userId: string, displayName: string): Promise<void> {
    await this.ctx.exports.UserDurableObject.getByName(userId).setOwnDisplayName(displayName);
  }

  async addAccount(
      userId: string, vendorId: string, accountName: string,
      options: { expired?: boolean; providesUi?: boolean } = {},
  ): Promise<number> {
    const user = this.ctx.exports.UserDurableObject.getByName(userId);
    const account = this.ctx.exports.FakeGatekeeperAccount({
      props: { name: accountName, providesUi: options.providesUi },
    });
    const accountId = await user.linkConnectedAccountFromLogin(account, vendorId);
    if (options.expired) await user.markCredentialsExpired(accountId);
    return accountId;
  }

  /**
   * What `viewerId`'s account does when its UI selects `selectedUserId`
   * (UserDurableObject.deliverSelectedUser).
   * A rejection is returned as `{ error }` rather than rethrown, which the pool would otherwise report
   * as an unhandled rejection inside the Durable Object even though the test awaits it.
   */
  async pick(
      viewerId: string, accountId: number, target: string, selectedUserId: string,
  ): Promise<boolean | { error: string }> {
    try {
      return await this.ctx.exports.UserDurableObject.getByName(viewerId)
        .deliverSelectedUser(accountId, selectedUserId, target);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async accountCalls(accountName: string): Promise<string[]> {
    return this.ctx.exports.FakeGatekeeperAccount({ props: { name: accountName } }).calls();
  }
}
