// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, WorkerEntrypoint, restore } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApplyActionContext,
  ApplyActionsThroughResult,
  Gatekeeper,
  GitCache,
  GitPackBuilder,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  createGitPackError,
  getGitPackErrorCode,
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
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

type TestGitPackGatekeeperProps = {
  packAction?: number;
  readOid?: string;
  stoppedAt?: number;
  throwAfterBuild?: boolean;
};

/** Native-RPC test receiver for invocation-scoped Git pack callbacks. */
@validateRpc()
export class TestGitPackGatekeeper
    extends DurableObject<Cloudflare.Env, TestGitPackGatekeeperProps>
    implements Pick<Gatekeeper<unknown>, "applyActionsThrough"> {
  #captured?: Uint8Array;
  #cached?: Awaited<ReturnType<GitCache["get"]>>;
  #retained?: RpcStub<GitPackBuilder>;
  #receivedBatch?: {actionId: number; vetoes: number[]};

  async applyActionsThrough(
    actionId: number,
    vetoes: number[],
    context: ApplyActionContext,
  ): Promise<ApplyActionsThroughResult> {
    this.#receivedBatch = { actionId, vetoes: [...vetoes] };
    const { packAction, readOid, stoppedAt, throwAfterBuild } = this.ctx.props;
    if (readOid !== undefined) this.#cached = await context.gitCache.get(readOid);
    if (packAction === undefined) return {};

    this.#retained?.[Symbol.dispose]();
    this.#retained = context.gitPackBuilder.dup();
    try {
      const stream = await this.#retained.buildPack(packAction);
      this.#captured = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      const code = getGitPackErrorCode(error);
      if (code !== undefined) {
        return { stopped: {
          at: packAction,
          reason: error instanceof Error ? error : createGitPackError(code),
        } };
      }
      throw error;
    }

    if (throwAfterBuild) throw new Error("Test batch response lost.");
    if (stoppedAt !== undefined) {
      return { stopped: { at: stoppedAt, reason: new Error("Test action stopped.") } };
    }
    return {};
  }

  async receivedBatch(): Promise<{actionId: number; vetoes: number[]} | undefined> {
    return this.#receivedBatch;
  }

  async capturedPack(): Promise<Uint8Array> {
    if (this.#captured === undefined) throw new Error("No pack was captured.");
    return this.#captured;
  }

  async cachedObject() {
    return this.#cached;
  }

  async buildRetained(action: number): Promise<Uint8Array> {
    if (this.#retained === undefined) throw new Error("No Git pack builder was retained.");
    const stream = await this.#retained.buildPack(action);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async releaseRetained(): Promise<void> {
    this.#retained?.[Symbol.dispose]();
    this.#retained = undefined;
  }
}

/** What each FakeGatekeeperAccount has been asked to do, by its `name` prop. */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.name` so a test can ask any instance what happened (`calls()`); with
 * `failRevoke` / `failDescribe`, that method rejects after being recorded.
 */
export class FakeGatekeeperAccount
    extends WorkerEntrypoint<unknown, { name: string; failRevoke?: boolean; failDescribe?: boolean }> {
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

  async calls(): Promise<string[]> {
    return accountCalls.get(this.ctx.props.name) ?? [];
  }
}
