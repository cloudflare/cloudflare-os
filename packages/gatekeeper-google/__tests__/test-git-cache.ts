import { RpcTarget } from "cloudflare:workers";
import type { GitCache, GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Stands in for the action-scoped git cache the overseer passes to `applyAction()`. The Google
 * gatekeepers never interact with git, so every method throws: the stub exists only to satisfy
 * the argument the `Gatekeeper` interface (and hence capnweb-validate) requires, and a test that
 * unexpectedly reaches git fails loudly rather than silently passing.
 */
export class TestGitCache extends RpcTarget implements GitCache {
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
