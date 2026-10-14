// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, WorkerEntrypoint, restore, type RpcStub } from "cloudflare:workers";
import type { AccountDescription, ActionDescription, Gatekeeper, ApprovalQueue, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentContext, AgentTurnEvent, AgentTurnInfo, AgentTurnParticipant,
  GatekeeperActionContext } from "@gadgets/workshop-shared/agent-integration";
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

  /** Transfer a real endpoint over RPC, rather than leaking a DO-owned stub out of a test callback. */
  testReplicaEndpoint(leaseId: string) {
    return this.ctx.exports.WorkspaceReplicaEndpoint({ props: {
      overseerId: this.ctx.id.toString(), leaseId,
    } });
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
export { WorkspaceReplicaEndpoint } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

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

const integrationCallbacks = new Map<string, { fail: boolean; captureReplica?: boolean;
  blocked?: {kind: AgentTurnEvent["kind"]; wait: Promise<void>; release: () => void};
  calls: { event: AgentTurnEvent; turn: AgentTurnInfo; checkoutIds?: number[] }[] }>();

/** A genuinely persistent native callback, so outbox tests cross RPC and DO storage boundaries. */
export class IntegrationTestParticipant extends WorkerEntrypoint<unknown, { name: string }>
    implements AgentTurnParticipant {
  #state() {
    let state = integrationCallbacks.get(this.ctx.props.name);
    if (!state) integrationCallbacks.set(this.ctx.props.name, state = { fail: false, calls: [] });
    return state;
  }
  async onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void> {
    using borrowed = context;
    const call = {event, turn: await borrowed.getTurn(), checkoutIds: undefined as number[] | undefined};
    this.#state().calls.push(call);
    const blocked = this.#state().blocked;
    if (blocked?.kind === event.kind) await blocked.wait;
    if (this.#state().fail) throw new Error("participant unavailable");
    if (this.#state().captureReplica && call.turn.phase === "running") {
      const replica = await borrowed.openWorktreeReplica();
      try { call.checkoutIds = (await replica.checkpoint()).worktrees.map(tree => tree.checkoutId); }
      finally { await replica.release(); }
    }
  }
  setFailure(fail: boolean): void { this.#state().fail = fail; }
  block(kind: AgentTurnEvent["kind"]): void {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    this.#state().blocked = {kind, wait, release};
  }
  releaseBlock(): void {
    this.#state().blocked?.release();
    delete this.#state().blocked;
  }
  setCaptureReplica(capture: boolean): void { this.#state().captureReplica = capture; }
  calls() { return this.#state().calls; }
}

/** Real facet RPC dispatch: contextual failure must never fall back to the legacy handler. */
export class IntegrationTestActionGatekeeper extends DurableObject<Cloudflare.Env>
    implements Gatekeeper<object> {
  async describe() { return { url: "container://test", title: "Test", suggestedBindingName: "TEST", tsType: "object" }; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
  async getAutoApprovableActions() { return []; }
  /** A source fixture that recognizes exactly one remote commit, never DO auto-commits. */
  allowGitCommit(commit: string): void { this.ctx.storage.kv.put("gitCommit", commit); }
  async gitReadPack(commit: string, request: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    if (commit !== this.ctx.storage.kv.get("gitCommit")) throw new Error("Unknown remote commit");
    return new Response(request).body!;
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<{ turn: AgentTurnInfo | null }> {
    using borrowed = queue;
    using context = await borrowed.getAgentContext();
    return { turn: context ? await context.getTurn() : null };
  }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  async revertAction(_action: number): Promise<void> {}
  async applyAction(action: number): Promise<void> { this.#record({ action, handler: "legacy" }); }
  async applyActionInContext(action: number, context: RpcStub<GatekeeperActionContext>): Promise<void> {
    using borrowed = context;
    if (this.ctx.storage.kv.get(`receipt:${action}`)) return;
    using agent = await borrowed.getAgentContext();
    this.#record({ action, handler: "contextual", turn: agent ? await agent.getTurn() : null });
    const followup = this.ctx.storage.kv.get<ActionDescription>("followup");
    if (action === 42 && followup) {
      await borrowed.submitAction(43, followup);
      await borrowed.submitAction(43, followup); // Lost-ACK replay must not publish a second card.
    }
    if (this.ctx.storage.kv.get("fail")) throw new Error("Contextual handler failed");
    if (this.ctx.storage.kv.get("recoverable")) this.ctx.storage.kv.put(`receipt:${action}`, true);
  }
  setRecoverable(): void { this.ctx.storage.kv.put("recoverable", true); }
  setFollowup(description: ActionDescription): void { this.ctx.storage.kv.put("followup", description); }
  setFailure(fail: boolean): void { this.ctx.storage.kv.put("fail", fail); }
  calls(): { action: number; handler: string; turn?: AgentTurnInfo | null }[] {
    return this.ctx.storage.kv.get("calls") ?? [];
  }
  #record(call: ReturnType<IntegrationTestActionGatekeeper["calls"]>[number]): void {
    this.ctx.storage.kv.put("calls", [...this.calls(), call]);
  }
}
