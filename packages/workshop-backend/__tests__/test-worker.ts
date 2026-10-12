// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  AccountDescription,
  AppUiContext,
  GatekeeperUiFrame,
  GatekeeperUserSelection,
  GatekeeperUserVerifier,
} from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import { OverseerDurableObject as RealOverseerDurableObject } from "../src/server.js";

export * from "../src/server.js";
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
/** What an executeCode run's tail worker is minted from, likewise. */
export { CodeModeTailLoopback } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}
/**
 * The exchange a management app's account redeems picker tickets through, reachable through
 * `ctx.exports` by the name startAccountAppUi mints it under.
 */
export { GatekeeperUserSelectionExchangeImpl } from "../src/user.js";

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

/** A ticket a FakeGatekeeperAccount redeems when its UI is next opened, by account name. */
const stashedTickets = new Map<string, string>();

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

  /**
   * Redeems the account's stashed ticket, if any, through the exchange the Workshop supplied, and
   * records what came back — proving the exchange in the AppUiContext is scoped to this account.
   */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ticket = stashedTickets.get(this.ctx.props.name);
    stashedTickets.delete(this.ctx.props.name);
    let outcome = "no ticket";
    if (ticket !== undefined) {
      try {
        const results = await context.userSelectionExchange.redeem(ticket);
        const outcomes = await Promise.all(results.map(async ({ verifier, profile }) => {
          const identity = await (verifier as unknown as Fetcher<FakeGatekeeperVerifier>).identify();
          return `${identity}, ${profile.displayName}`;
        }));
        outcome = outcomes.length === 0 ? "[]" : outcomes.join("; ");
      } catch (error) {
        outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.#record(`startAppUi(${context.isAdmin}, ${outcome})`);
    return { iframeHtml: "<!doctype html>", ui: new RpcStub(new RpcTarget()) };
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
   * What `viewerId`'s browser gets when its app picks `selectedUserId`
   * (UserDurableObject.createGatekeeperUserSelection). A rejection is returned as `{ error }`
   * rather than rethrown, which the pool would otherwise report as an unhandled rejection inside
   * the Durable Object even though the test awaits it.
   */
  async pick(
      viewerId: string, accountId: number, selectedUserId: string,
  ): Promise<GatekeeperUserSelection | null | { error: string }> {
    try {
      return await this.ctx.exports.UserDurableObject.getByName(viewerId)
        .createGatekeeperUserSelection(accountId, selectedUserId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * What `viewerId`'s account learns by redeeming `ticket` through the exchange scoped to
   * `accountId`, as the Workshop hands it in AppUiContext: each redeemed verifier's identity and
   * fresh profile snapshot, or the redemption's `{ error }`.
   */
  async redeem(
      viewerId: string, accountId: number, ticket: string,
  ): Promise<{ identity: string; displayName: string }[] | { error: string }> {
    const selectorUserId = this.ctx.exports.UserDurableObject.idFromName(viewerId).toString();
    const exchange = this.ctx.exports.GatekeeperUserSelectionExchangeImpl({
      props: { selectorUserId, appAccountId: accountId },
    });
    try {
      const results = await exchange.redeem(ticket);
      return await Promise.all(results.map(async ({ verifier, profile }) => {
        const identity = await (verifier as unknown as Fetcher<FakeGatekeeperVerifier>).identify();
        return { identity, displayName: profile.displayName };
      }));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Open `viewerId`'s app UI for `accountId` the way getGatekeeperApp does, with `ticket` stashed
   * for the fake account to redeem through the exchange it is handed; the outcome lands in the
   * account's recorded `startAppUi(...)` call. Returns the open's own `{ error }` if it fails.
   */
  async openAppUi(
      viewerId: string, accountId: number, accountName: string, ticket: string,
  ): Promise<{ error: string } | undefined> {
    stashedTickets.set(accountName, ticket);
    try {
      const frame = await this.ctx.exports.UserDurableObject.getByName(viewerId)
        .startAccountAppUi(accountId, { isAdmin: false });
      frame.ui[Symbol.dispose]();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async accountCalls(accountName: string): Promise<string[]> {
    return this.ctx.exports.FakeGatekeeperAccount({ props: { name: accountName } }).calls();
  }
}
