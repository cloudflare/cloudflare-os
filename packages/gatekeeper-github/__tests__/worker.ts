import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription,
  ApplyActionsThroughResult,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubAction, GitHubGatekeeperImpl } from "../src/github.js";

export { default } from "../src/github.js";
// Vitest's ctx.exports analyzer needs the classes named directly, not through a barrel.
export {
  GatekeeperVendor,
  GatekeeperUserImpl,
  GitHubGatekeeperImpl,
  GitHubVerifier,
  UserAccount,
} from "../src/github.js";

// Approval queue that accepts every submission, standing in for the workshop overseer.
class AcceptingApprovalQueue extends RpcTarget {
  async submitAction(): Promise<void> {}
  async authorizeObservation(): Promise<void> {}
}

type FacetExports = {
  GitHubGatekeeperImpl: DurableObjectClass;
};

/** Test-only parent hosting a GitHubGatekeeperImpl facet the way the workshop overseer does. */
export class GitHubTestParent extends DurableObject {
  #gatekeeper() {
    const exports = this.ctx.exports as unknown as FacetExports;
    // The facet runs without props: the veto/staging paths under test never read ctx.props (only
    // the GitHub API paths dereference the user account and repo coordinates).
    return this.ctx.facets.get<GitHubGatekeeperImpl>("gatekeeper", () => ({
      class: exports.GitHubGatekeeperImpl,
    }));
  }

  /** Stage and submit an action, as a session would. */
  async submitAction(action: GitHubAction, description: ActionDescription): Promise<void> {
    await this.#gatekeeper().submitActionForApproval(
        new AcceptingApprovalQueue() as unknown as RpcStub<ApprovalQueue>, action, description);
  }

  applyActionsThrough(actionId: number, vetoes: number[]): Promise<ApplyActionsThroughResult> {
    return this.#gatekeeper().applyActionsThrough(actionId, vetoes);
  }

  applyAction(actionId: number): Promise<void> {
    return this.#gatekeeper().applyAction(actionId);
  }

  rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#gatekeeper().rejectAction(actionId);
  }
}
