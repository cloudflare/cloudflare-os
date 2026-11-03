// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass` from
// `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the overseer
// instantiates a gatekeeper in production.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, GitObjectType, GitOid }
  from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareObservabilityGatekeeper, GatekeeperUserImpl } from "../src/cloudflare.js";
import type { CloudflareObservabilitySession } from "../src/types.js";

export { default } from "../src/cloudflare.js";
export * from "../src/cloudflare.js";
// Named as well, since the pool finds the entrypoints `ctx.exports` serves from named exports.
export { CloudflareVerifier, GatekeeperUserImpl } from "../src/cloudflare.js";

/** The props a binding's class carries, including ones an earlier version stored. */
export type GatekeeperProps = {
  userObjectId: string;
  accountId: string;
  workerName?: string;
  workerId?: string;
};

export type TestExports = {
  CloudflareObservabilityGatekeeper(options: { props: GatekeeperProps }):
    DurableObjectClass<CloudflareObservabilityGatekeeper>;
  GatekeeperUserImpl(options: { props: { userObjectId: string } }): Fetcher<GatekeeperUserImpl>;
  CloudflareVerifier(options: { props: { userObjectId: string } }): Fetcher<GatekeeperUserVerifier>;
  TestConnectCallback(options: { props: { label: string } }): Fetcher<TestConnectCallback>;
};

/**
 * Stands in for the git cache the overseer passes to `applyAction()`. This read-only gatekeeper
 * never touches it, so every method just throws.
 */
class TestGitCache extends RpcTarget implements GitCache {
  async get(_id: GitOid): Promise<{type: GitObjectType, content: Uint8Array} | null> {
    throw new Error("not implemented");
  }
  async has(_id: GitOid): Promise<boolean> { throw new Error("not implemented"); }
  async stat(_id: GitOid): Promise<{type: GitObjectType, size: number} | null> {
    throw new Error("not implemented");
  }
  async put(_type: GitObjectType, _content: Uint8Array): Promise<GitOid> {
    throw new Error("not implemented");
  }
  async advertiseCommit(_commitId: GitOid): Promise<void> { throw new Error("not implemented"); }
  async buildPack(): Promise<ReadableStream<Uint8Array>> { throw new Error("not implemented"); }
  async consumePack(_pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    throw new Error("not implemented");
  }
  async isAncestor(_ancestor: GitOid, _descendant: GitOid): Promise<boolean> {
    throw new Error("not implemented");
  }
}

/** Records what the gatekeeper authorized, as the overseer's approval queue would. */
class TestApprovalQueue extends RpcTarget {
  readonly observations: Array<{ title: string; subresources?: string[] }> = [];

  async authorizeObservation(description: { title: string; subresources?: string[] }): Promise<void> {
    this.observations.push({ title: description.title, subresources: description.subresources });
  }
}

/** The labels of the `TestConnectCallback`s notified of credential expiry, in arrival order. */
export const expiryNotices: string[] = [];

/** Stands in for the Workshop's connect callback, which an account stores to report expiry. */
export class TestConnectCallback extends WorkerEntrypoint<Env, { label: string }> {
  async credentialsExpired(): Promise<void> {
    expiryNotices.push(this.ctx.props.label);
  }
}

export class TestHooks extends DurableObject<Env> {
  #classes = new Map<string, DurableObjectClass<Gatekeeper<CloudflareObservabilitySession>>>();
  #queues = new Map<string, TestApprovalQueue>();
  #sessions = new Map<string, CloudflareObservabilitySession>();

  get #exports() {
    return this.ctx.exports as unknown as TestExports;
  }

  #gatekeeper(facetName: string) {
    const cls = this.#classes.get(facetName);
    if (!cls) throw new Error(`No test binding named ${facetName}.`);
    return this.ctx.facets.get<CloudflareObservabilityGatekeeper>(facetName, () => ({ class: cls }));
  }

  /**
   * Creates a binding the way the overseer does: the class the owner's account returns for
   * `url`, carrying whatever props that account resolved for it.
   */
  async bind(facetName: string, ownerUserObjectId: string, url: string): Promise<void> {
    const owner = this.#exports.GatekeeperUserImpl({ props: { userObjectId: ownerUserObjectId } });
    const { class: cls } = await owner.getGatekeeperClassFor(url);
    this.#classes.set(facetName, cls);
  }

  /** Creates a binding from props as given, such as those an earlier version stored. */
  async bindProps(facetName: string, props: GatekeeperProps): Promise<void> {
    this.#classes.set(facetName, this.#exports.CloudflareObservabilityGatekeeper({ props }));
  }

  /** Opens a session that `read(queueId, ...)` reads through and `observations(queueId)` audits. */
  async openSession(facetName: string, queueId: string): Promise<void> {
    const queue = new TestApprovalQueue();
    this.#queues.set(queueId, queue);
    // Implements only what a read calls: authorizeObservation().
    using queueStub = new RpcStub(queue) as unknown as ApprovalQueue & Disposable;
    // The stub's own type is the session's, wrapped too deeply for the checker to compare.
    const session: unknown = await this.#gatekeeper(facetName).startSession(queueStub);
    this.#sessions.set(queueId, session as CloudflareObservabilitySession);
  }

  /**
   * Calls one session method, returning its result or the message it threw. Kept here, beside the
   * session stub, so a refused read is settled where it was made rather than forwarded on.
   */
  async read(queueId: string, method: keyof CloudflareObservabilitySession, args: unknown[])
      : Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const session = this.#sessions.get(queueId);
    if (!session) throw new Error(`No test session ${queueId}.`);
    // A stub's method is itself a stub, called directly; `apply` would name a remote method.
    const call = session[method] as (...args: unknown[]) => Promise<unknown>;
    try {
      return { ok: true, value: await call(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The thrown message of a session that can't open, or null when it opened. */
  async openSessionError(facetName: string): Promise<string | null> {
    try {
      using queueStub = new RpcStub(new TestApprovalQueue()) as unknown as ApprovalQueue & Disposable;
      using _session = await this.#gatekeeper(facetName).startSession(queueStub);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async observations(queueId: string): Promise<Array<{ title: string; subresources?: string[] }>> {
    return this.#queues.get(queueId)?.observations ?? [];
  }

  /**
   * Admits an observer with their own account's verifier, as the overseer would. Returns the
   * thrown message, or null when the observer was admitted.
   */
  async addObserver(facetName: string, observerUserObjectId: string): Promise<string | null> {
    try {
      await this.#gatekeeper(facetName).addObserver("observer-1",
        this.#exports.CloudflareVerifier({ props: { userObjectId: observerUserObjectId } }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The facet's verifyObserverAccess(), with each observer's verifier minted for their account. */
  async verifyObserverAccess(
    facetName: string,
    observers: Array<{ id: string; userObjectId: string }>,
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return this.#gatekeeper(facetName).verifyObserverAccess(
      observers.map(({ id, userObjectId }) => ({
        id, verifier: this.#exports.CloudflareVerifier({ props: { userObjectId } }),
      })),
      subresources);
  }

  /** The resource description for a binding, which encodes the account/Worker split. */
  async describeResource(
    facetName: string,
  ): Promise<{ url: string; title: string; suggestedBindingName: string }> {
    const { url, title, suggestedBindingName } = await this.#gatekeeper(facetName).describe();
    return { url, title, suggestedBindingName };
  }

  /** Confirms the read-only resource refuses every mutating gatekeeper operation. */
  async applyActionMessage(facetName: string): Promise<string> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName).applyAction(1, new RpcStub(new TestGitCache()));
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
