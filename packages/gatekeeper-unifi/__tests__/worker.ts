// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds what the tests drive them with.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet can't be handed to the test, so TestHooks runs each scenario itself and returns plain data.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription, ActionDescription, ConnectHandoff, GatekeeperUser, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { UnifiGatekeeper, UnifiGatekeeperProps } from "../src/gatekeeper.js";

export { default } from "../src/unifi.js";
export * from "../src/unifi.js";
import { UnifiUser as ProductionUser, UnifiVerifier as ProductionVerifier } from "../src/unifi.js";

/**
 * The account entrypoint under its production name. Under the capnweb-validate *vite* plugin,
 * decorated `WorkerEntrypoint` exports aren't registered in `ctx.exports` (the production build
 * registers them; see gatekeeper-gitlab's test worker), so the code under test -- which mints
 * `ctx.exports.UnifiUser` -- would find nothing. An undecorated subclass registers and inherits the
 * production behaviour, and this module's own export shadows the one `export *` re-exports.
 */
export class UnifiUser extends ProductionUser {}
/** The verifier entrypoint under its production name; see `UnifiUser`. */
export class UnifiVerifier extends ProductionVerifier {}

/** What the test-side connect callback has been told, per account. */
const callbackLog = new Map<string, { completed: number; describedAs: AccountDescription[]; expired: number; stages: string[] }>();

function logFor(accountId: string) {
  let log = callbackLog.get(accountId);
  if (!log) callbackLog.set(accountId, log = { completed: 0, describedAs: [], expired: 0, stages: [] });
  return log;
}

/**
 * Stands in for the Workshop's connect callback. The account persists it, which only a persistent
 * stub survives -- a `WorkerEntrypoint` reached through `ctx.exports`, as the Workshop's own is.
 */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, { accountId: string }> {
  async complete(account: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    const log = logFor(this.ctx.props.accountId);
    // The Workshop describes the account while staging the connection.
    log.describedAs.push(await account.describe());
    log.completed++;
    return { targetOrigin: "https://gadgets.example", ticket: `ticket-${log.completed}` };
  }

  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    logFor(this.ctx.props.accountId).stages.push(stageId);
    return { targetOrigin: "https://gadgets.example", ticket: stageId };
  }

  async credentialsExpired(): Promise<void> {
    logFor(this.ctx.props.accountId).expired++;
  }

  async credentialsRestored(): Promise<void> {}
}

/** A recording approval queue that accepts every submission. */
export class RecordingQueue extends RpcTarget {
  readonly observations: Omit<ObservationDescription, "excludeObservers">[] = [];
  readonly submitted: { actionId: number; description: ActionDescription }[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push({ title: description.title, description: description.description });
  }

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async bindHook(): Promise<void> {
    throw new Error("UniFi gatekeepers bind no hooks");
  }

  async getGitCache(): Promise<never> {
    throw new Error("UniFi gatekeepers use no git cache");
  }
}

/** One call in a scenario: optional capability getters to walk first, then the call. */
export type Step = { via?: [method: string, ...args: unknown[]][]; call: string; args?: unknown[] };

/**
 * Whatever a scenario's call returned, which the test narrows by asserting on it. Not `unknown`,
 * which isn't serializable, so a stub's typing would reduce every result to the error arm.
 */
export type Returned = object | string | number | boolean | bigint | null | undefined;

/** A call's result as plain data; failures ride back as data rather than RPC rejections. */
export type Outcome<T = Returned> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type TestExports = {
  UnifiGatekeeper(options: { props: UnifiGatekeeperProps }): DurableObjectClass<UnifiGatekeeper>;
  TestCallback(options: { props: { accountId: string } }): Fetcher<TestCallback>;
  UnifiVerifier(options: { props: { accountId: string } }): Fetcher<GatekeeperUserVerifier>;
  UnifiUser(options: { props: { accountId: string } }): Fetcher<GatekeeperUser>;
};

/** A stand-in for the action-scoped git cache `applyAction` receives; nothing here reads it. */
class NullGitCache extends RpcTarget {}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  readonly #queues = new Map<string, RecordingQueue>();
  readonly #sessions = new Map<string, unknown>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * The facet for `name`, made with `props` on first use. Each scenario should use a fresh name: a
   * facet is cached per name, so reusing one silently reuses the first caller's props and storage.
   */
  #facet(name: string, props: UnifiGatekeeperProps): UnifiGatekeeper {
    return this.ctx.facets.get<UnifiGatekeeper>(name, () => ({ class: this.#exports.UnifiGatekeeper({ props }) })) as unknown as UnifiGatekeeper;
  }

  #queue(name: string): RecordingQueue {
    let queue = this.#queues.get(name);
    if (!queue) this.#queues.set(name, queue = new RecordingQueue());
    return queue;
  }

  /** Points `accountId`'s connect flow at a test callback, as `connectAccount` does. */
  async installCallback(accountId: string, nonce: string): Promise<void> {
    const account = this.env.UNIFI_ACCOUNT.get(this.env.UNIFI_ACCOUNT.idFromString(accountId));
    await account.setCallback(this.#exports.TestCallback({ props: { accountId } }), nonce);
  }

  /**
   * Calls the account Durable Object, returning a failure as data: an expected rejection crossing
   * the RPC boundary would also be reported to vitest as an unhandled one.
   */
  async accountCall(accountId: string, method: "commitReconnect" | "listConsoles" | "canObserve", args: unknown[]): Promise<Outcome> {
    const account = this.env.UNIFI_ACCOUNT.get(this.env.UNIFI_ACCOUNT.idFromString(accountId));
    return await outcome(() => (account as unknown as Record<string, (...a: unknown[]) => Promise<Returned>>)[method]!(...args));
  }

  /** What the test callback for `accountId` has been told. */
  callbackLog(accountId: string) {
    return logFor(accountId);
  }

  /** Runs calls against the binding's session, starting one on first use. */
  async run(name: string, props: UnifiGatekeeperProps, steps: Step[]): Promise<Outcome[]> {
    let session = this.#sessions.get(name);
    if (!session) {
      session = await this.#facet(name, props).startSession(new RpcStub(this.#queue(name)) as never);
      this.#sessions.set(name, session);
    }
    const results: Outcome[] = [];
    for (const step of steps) {
      results.push(await outcome(async () => {
        let target = session as Record<string, (...args: unknown[]) => unknown>;
        for (const [method, ...args] of step.via ?? []) target = target[method]!(...args) as typeof target;
        return await target[step.call]!(...(step.args ?? [])) as Returned;
      }));
    }
    return results;
  }

  /** What the binding's approval queue has recorded. */
  queueState(name: string) {
    const queue = this.#queue(name);
    return { observations: [...queue.observations], submitted: [...queue.submitted] };
  }

  async describeBinding(name: string, props: UnifiGatekeeperProps) {
    return await outcome(() => this.#facet(name, props).describe());
  }

  async autoApprovable(name: string, props: UnifiGatekeeperProps) {
    return await outcome(() => this.#facet(name, props).getAutoApprovableActions());
  }

  async apply(name: string, props: UnifiGatekeeperProps, actionId: number) {
    return await outcome(() => this.#facet(name, props).applyAction(actionId, new RpcStub(new NullGitCache()) as never));
  }

  async reject(name: string, props: UnifiGatekeeperProps, actionId: number) {
    return await outcome(() => this.#facet(name, props).rejectAction(actionId));
  }

  async revert(name: string, props: UnifiGatekeeperProps, actionId: number) {
    return await outcome(() => this.#facet(name, props).revertAction(actionId));
  }

  /** `addObserver` with the verifier minted for `observerAccountId`'s connection. */
  async addObserver(name: string, props: UnifiGatekeeperProps, observerAccountId: string) {
    const verifier = this.#exports.UnifiVerifier({ props: { accountId: observerAccountId } });
    return await outcome(() => this.#facet(name, props).addObserver("observer-1", verifier));
  }

  /** Calls the account entrypoint the Workshop holds for `accountId`. */
  async user(accountId: string, call: "describe" | "getGatekeeperClassFor" | "reconnect" | "getSupportedResources", args: unknown[] = []): Promise<Outcome> {
    return await outcome(async () => {
      const user = this.#exports.UnifiUser({ props: { accountId } }) as unknown as Record<string, (...a: unknown[]) => Promise<Returned>>;
      const result = await user[call]!(...args);
      // A gatekeeper class can't cross back to the test; report which resource it matched.
      if (call === "getGatekeeperClassFor") return (result as { resource: Returned }).resource;
      return result;
    });
  }

  /** Lists through a resource picker's capability, as the iframe would. */
  async pick(accountId: string, pattern: string, call: string, args: unknown[]): Promise<Outcome> {
    return await outcome(async () => {
      const user = this.#exports.UnifiUser({ props: { accountId } }) as unknown as GatekeeperUser;
      const frame = await user.startResourceConfigurator(pattern);
      const ui = frame.ui as unknown as Record<string, (...a: unknown[]) => Promise<Returned>>;
      return await ui[call]!(...args);
    });
  }

  /** Restarts the facet, as an eviction would: its storage stays, its memory does not. */
  restart(name: string): void {
    this.ctx.facets.abort(name, new Error("test restart"));
    this.#sessions.delete(name);
  }
}
