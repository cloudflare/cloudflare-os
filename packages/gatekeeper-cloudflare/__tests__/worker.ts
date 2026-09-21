// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass` from
// `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the overseer
// instantiates a gatekeeper in production.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { GatekeeperUserVerifier, GitCache, GitObjectType, GitOid }
  from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareObservabilityGatekeeper } from "../src/cloudflare.js";

export { default } from "../src/cloudflare.js";
export * from "../src/cloudflare.js";

type GatekeeperProps = {
  userObjectId: string;
  accountId: string;
  workerName?: string;
};

type TestExports = {
  CloudflareObservabilityGatekeeper(options: { props: GatekeeperProps }):
    DurableObjectClass<CloudflareObservabilityGatekeeper>;
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

/** Stands in for another user's Cloudflare account during an observer admission check. */
class TestVerifier extends RpcTarget {
  constructor(private readonly outcome: boolean | string) {
    super();
  }

  async hasObservabilityAccess(): Promise<boolean> {
    if (typeof this.outcome === "string") throw new Error(this.outcome);
    return this.outcome;
  }
}

export class TestHooks extends DurableObject<Env> {
  #gatekeeper(facetName: string, props: GatekeeperProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<CloudflareObservabilityGatekeeper>(facetName, () => ({
      class: exports.CloudflareObservabilityGatekeeper({ props }),
    }));
  }

  /**
   * Run `addObserver` against a verifier with a known answer. Returns the thrown message, or null
   * when the collaborator was admitted, so the test can assert on both outcomes.
   */
  async addObserver(
    facetName: string, props: GatekeeperProps, outcome: boolean | string,
  ): Promise<string | null> {
    // A local RpcTarget stands in for the remote verifier the overseer would pass; only
    // `hasObservabilityAccess` is ever called on it.
    const verifier = new RpcStub(new TestVerifier(outcome)) as unknown as
      Fetcher<GatekeeperUserVerifier>;
    try {
      await this.#gatekeeper(facetName, props).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The resource description for a binding, which encodes the account/Worker split. */
  async describeResource(
    facetName: string, props: GatekeeperProps,
  ): Promise<{ url: string; title: string; suggestedBindingName: string }> {
    const { url, title, suggestedBindingName } =
      await this.#gatekeeper(facetName, props).describe();
    return { url, title, suggestedBindingName };
  }

  /** Confirms the read-only resource refuses every mutating gatekeeper operation. */
  async applyActionMessage(facetName: string, props: GatekeeperProps): Promise<string> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName, props).applyAction(1, new RpcStub(new TestGitCache()));
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
