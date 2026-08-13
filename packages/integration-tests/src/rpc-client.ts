// Drives the Workshop over its real Cap'n Web WebSocket API, the same transport the browser uses.

import { createHash } from "node:crypto";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
import type {
  AuthenticatedApi, ConnectedAccountsSubscriber, ObserverAccountChoice, ObserverBindingNeed,
  ObserverConfigCallback, PublicApi,
} from "@gadgets/workshop-shared/api";
import type {
  AccountDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * Poll `attempt` until it returns non-null.
 *
 * For the handful of places where an effect is only observable through the API's own eventual state
 * (an account appearing in the user's list, say) rather than by awaiting a promise.
 */
export async function waitFor<T>(
    what: string, attempt: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== null) return result;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

// Storage persists for the harness's lifetime and is never reset -- server.reset() would also change
// the server URL, invalidating every open RPC session -- so NO TEST MAY ASSUME A CLEAN SLATE. Fresh
// identities per test are how tests stay independent, which is also what lets them run concurrently.
let userSeq = 0;

/**
 * Fresh usernames for one test: `nextUsernames("alice", "bob")` gives `["alice7", "bob7"]`.
 *
 * The Workshop requires usernames to be alphanumeric and start with a letter, so prefixes must be
 * too. Every call advances the counter, so no two tests can collide.
 */
export function nextUsernames(...prefixes: string[]): string[] {
  const n = ++userSeq;
  return prefixes.map(prefix => `${prefix}${n}`);
}

/** Open an RPC session against the Workshop's /api endpoint. */
export function connect(baseUrl: URL): RpcStub<PublicApi> {
  const wsUrl = new URL("/api", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<PublicApi>(wsUrl.toString());
}

/**
 * Wrap a target so it can be passed to the Workshop over a session from `connect()`.
 *
 * Always mint callback stubs through here rather than importing `RpcStub` yourself. A stub is only
 * serialisable by the same capnweb instance that owns the session, and a consumer of this package can
 * easily end up with a second copy -- a repo that vendors this one as a `public/` submodule installs
 * its own workspace *and* the submodule's, so `capnweb` resolves to two different stores. The failure is
 * `Cannot serialize value: [object RpcStub]`, and it appears only once those installs are separate, so
 * a single-install dev machine will not show it and CI will.
 */
export function stubFor<T extends RpcTarget>(target: T): RpcStub<T> {
  return new RpcStub(target) as unknown as RpcStub<T>;
}

// The server stores and compares these bytes verbatim and never re-derives them, so the tests skip
// the frontend's argon2id (64 MiB per call) in favour of a deterministic stand-in.
function passwordHashFor(username: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest());
}

export async function signUp(
    api: RpcStub<PublicApi>, username: string): Promise<RpcStub<AuthenticatedApi>> {
  const token = await api.createAccount(username, username, passwordHashFor(username));
  if (!token) throw new Error(`Signup failed for "${username}" -- username already taken?`);
  return (await api.authenticate(token)) as unknown as RpcStub<AuthenticatedApi>;
}

export type ConnectedAccount = {
  id: number;
  vendorId: string;
  description: AccountDescription;
  credentialsValid: boolean;
};

/**
 * The label the Workshop names this account by.
 *
 * Mirrors the precedence in the overseer's `#describeObserverFailures`, so a test asserting on a
 * failure message compares against the same string the user would read.
 */
export function accountLabel(account: ConnectedAccount): string {
  const { uniqueName, displayName } = account.description;
  return uniqueName || displayName || `account ${account.id}`;
}

/** Read the user's connected accounts by driving subscribeConnectedAccounts() to its ready() call. */
export async function listConnectedAccounts(
    api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount[]> {
  const accounts: ConnectedAccount[] = [];
  let settle: () => void;
  const ready = new Promise<void>(resolve => { settle = resolve; });

  class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
    add(id: number, description: AccountDescription, _vendor: VendorDescription,
        _supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string) {
      accounts.push({ id, description, credentialsValid, vendorId });
    }
    remove(id: number) {
      const at = accounts.findIndex(a => a.id === id);
      if (at >= 0) accounts.splice(at, 1);
    }
    ready() { settle(); }
  }

  // 'using' disposes in reverse order -- the subscription first, which tells the server to drop its
  // duplicate of the subscriber, then our original -- and covers the path where the subscribe call
  // itself throws.
  using subscriber = new RpcStub(new Subscriber());
  using _subscription = await api.subscribeConnectedAccounts(subscriber);
  await ready;
  return accounts;
}

/**
 * The most configure() calls one open can make: the initial prompt plus at most one re-prompt
 * (`MAX_CONFIG_REPROMPTS` in the overseer is 1). The product does not export it, so it is asserted
 * here once rather than re-derived as a magic number in every suite.
 */
export const MAX_OBSERVER_PROMPTS = 2;

/**
 * Records every configure() call the overseer makes and answers from a scripted queue.
 *
 * The recording is the assertion surface for these tests: "did the overseer prompt a second time,
 * and did that prompt carry `failure`?" is answered by inspecting `calls`.
 */
export class ObserverConfigRecorder extends RpcTarget implements ObserverConfigCallback {
  readonly calls: ObserverBindingNeed[][] = [];
  #responses: ((needs: ObserverBindingNeed[]) => ObserverAccountChoice[])[] = [];

  /** Queue one response. The nth configure() call is answered by the nth queued responder. */
  respondWith(responder: (needs: ObserverBindingNeed[]) => ObserverAccountChoice[]): this {
    this.#responses.push(responder);
    return this;
  }

  /**
   * Answer the next `times` calls by choosing `accountId` for each binding asked about.
   *
   * `times` is explicit because over-queueing hides a real regression: configure() throws once the
   * queue is empty, so an unexpected extra prompt should fail rather than be silently answered.
   * ensureObserver() prompts at most MAX_OBSERVER_PROMPTS times.
   */
  alwaysChoose(accountId: number, times: number): this {
    for (let i = 0; i < times; i++) {
      this.respondWith(needs => needs.map(n => ({ gatekeeperId: n.gatekeeperId, accountId })));
    }
    return this;
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** The single need for `vendorId` in the nth call, asserting there is exactly one. */
  needAt(callIndex: number, index = 0): ObserverBindingNeed {
    const call = this.calls[callIndex];
    if (!call) throw new Error(`configure() was not called ${callIndex + 1} time(s)`);
    const need = call[index];
    if (!need) throw new Error(`call ${callIndex} had no need at index ${index}`);
    return need;
  }

  async configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    this.calls.push(needs);
    const responder = this.#responses.shift();
    if (!responder) {
      throw new Error(
        `configure() called ${this.calls.length} time(s) but only ` +
        `${this.calls.length - 1} response(s) were queued`);
    }
    return responder(needs);
  }
}
