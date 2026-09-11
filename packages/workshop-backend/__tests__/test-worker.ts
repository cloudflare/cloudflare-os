// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AccountDescription, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";

export * from "../src/server.js";
export { GatekeeperUserProfileImpl } from "../src/gatekeeper-user-profile.js";
export { default } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

/** Test identity capability returned by a fake connected account. */
export class FakeGatekeeperVerifier
    extends WorkerEntrypoint<Cloudflare.Env, { name: string }>
    implements GatekeeperUserVerifier {}

/** What each FakeGatekeeperAccount has been asked to do, by its `name` prop. */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.name` so a test can ask any instance what happened (`calls()`); with
 * `failRevoke` / `failDescribe`, that method rejects after being recorded.
 */
export class FakeGatekeeperAccount
    extends WorkerEntrypoint<Cloudflare.Env, { name: string; failRevoke?: boolean; failDescribe?: boolean }> {
  #record(call: string) {
    const calls = accountCalls.get(this.ctx.props.name) ?? [];
    calls.push(call);
    accountCalls.set(this.ctx.props.name, calls);
  }

  async describe(): Promise<AccountDescription> {
    this.#record("describe");
    if (this.ctx.props.failDescribe) throw new Error("describe failed");
    return { displayName: this.ctx.props.name, uniqueName: this.ctx.props.name };
  }

  async revoke(): Promise<void> {
    this.#record("revoke");
    if (this.ctx.props.failRevoke) throw new Error("revoke failed");
  }

  async commitReconnect(stageId: string): Promise<void> {
    this.#record(`commitReconnect(${stageId})`);
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FakeGatekeeperVerifier({ props: { name: this.ctx.props.name } });
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
      userId: string, vendorId: string, accountName: string, expired = false,
  ): Promise<number> {
    const user = this.ctx.exports.UserDurableObject.getByName(userId);
    const account = this.ctx.exports.FakeGatekeeperAccount({ props: { name: accountName } });
    const accountId = await user.linkConnectedAccountFromLogin(account, vendorId);
    if (expired) await user.markCredentialsExpired(accountId);
    return accountId;
  }

  /**
   * The two primitives AuthenticatedApi.selectGatekeeperUser composes: the target's verifier lookup,
   * then the minted profile's current name. Null when the user isn't selectable for the vendor.
   */
  async selectUser(vendorId: string, userId: string): Promise<string | null> {
    const verifier =
      await this.ctx.exports.UserDurableObject.getByName(userId).getUniqueGatekeeperUserVerifier(vendorId);
    if (!verifier) return null;
    return this.ctx.exports.GatekeeperUserProfileImpl({ props: { userId } }).getDisplayName();
  }
}
