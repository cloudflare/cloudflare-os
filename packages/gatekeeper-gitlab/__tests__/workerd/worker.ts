// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. And because a stub *to* a facet is not
// serializable, TestHooks cannot hand the facet to the test; it forwards each call instead, and
// results ride back as plain data.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type { ActionDescription, GitCache, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import type { GitLabAction } from "../../src/gitlab-action-types.js";
import type { GitLabGatekeeperImpl } from "../../src/gitlab-gatekeeper.js";
import type { GitLabGatekeeperImplProps } from "../../src/gitlab-env.js";
import type {
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCreateIssueOptions,
  GitLabCreateMergeRequestOptions,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
  GitLabCommitSummary,
  GitLabDiffFile,
  GitLabDiffThread,
  GitLabDiscussionEntry,
  GitLabIssueDetails,
  GitLabIssueSummary,
  GitLabMergeRequestDetails,
  GitLabMergeRequestRevision,
  GitLabMergeRequestSummary,
  GitLabProjectMetadata,
} from "../../src/types.js";

export { default } from "../../src/gitlab.js";
export * from "../../src/gitlab.js";
import { GatekeeperUserImpl, GitLabVerifier } from "../../src/gitlab.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin (which
 * applies `@validateRpc()` in-memory here) decorated `WorkerEntrypoint` exports are not registered
 * in `ctx.exports`; the production build (`capnweb-validate build`) registers them fine, as
 * gatekeeper-github's identical `GitHubVerifier` shows. An undecorated subclass registers, and
 * inherits the exact production behaviour.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests -- see `TestUser`. */
export class TestVerifier extends GitLabVerifier {}

export type GatekeeperProps = GitLabGatekeeperImplProps;

type UserProps = { userObjectId: string };

type TestExports = {
  GitLabGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass<GitLabGatekeeperImpl>;
  TestUser(options: { props: UserProps }): {
    describe(): Promise<{ displayName?: string; uniqueName?: string }>;
    getAuthenticatedEmail(): Promise<string | null>;
    getGatekeeperClassFor(url: string): Promise<{ resource: { urlPattern: string } }>;
    getSupportedResources(): Promise<Array<{ urlPattern: string; title: string; description: string }>>;
    ensureResources(patterns: string[]): Promise<{ url?: string }>;
  };
  TestVerifier(options: { props: UserProps }): { hasProjectAccess(projectPath: string): Promise<boolean> };
};

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference collapses several of these returns to `never`, while the runtime objects
// are exactly the production ones.
type Pages<T> = { next(): Promise<T[] | null> };
type GatekeeperFacet = {
  describe(): Promise<{ url: string; title: string; snippet: string; suggestedBindingName: string; tsType: string }>;
  projectMetadata(): Promise<GitLabProjectMetadata>;
  openIssue(id: string): Promise<GitLabIssueDetails>;
  openMergeRequest(id: string, cache?: RpcStub<GitCache>): Promise<GitLabMergeRequestDetails>;
  issueDiscussion(kind: "issue" | "mergeRequest", id: string, pageSize: number): Promise<Pages<GitLabDiscussionEntry>>;
  mergeRequestDiff(id: string, pageSize: number, cache?: RpcStub<GitCache>):
    Promise<{ revision: GitLabMergeRequestRevision; files: Pages<GitLabDiffFile> }>;
  mergeRequestMergeBase(id: string, cache?: RpcStub<GitCache>): Promise<string>;
  mergeRequestThreads(id: string, pageSize: number): Promise<Pages<GitLabDiffThread>>;
  listIssues(filter: undefined, pageSize: number): Promise<Pages<GitLabIssueSummary>>;
  listMergeRequests(filter: undefined, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabMergeRequestSummary>>;
  listBranches(filter: undefined, pageSize: number): Promise<Pages<GitLabBranchSummary>>;
  getCommit(ref: string | undefined, cache?: RpcStub<GitCache>): Promise<{ details: GitLabCommitDetails; fromCache: boolean }>;
  resolveRef(ref: string | undefined, cache?: RpcStub<GitCache>): Promise<{ id: string; fromCache: boolean }>;
  listCommits(filter: undefined, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabCommitSummary>>;
  mergeRequestCommits(id: string, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabCommitSummary>>;
  isSimulatedCommitId(commitId: string): boolean;
  gitPull(oids: string[], cache: RpcStub<GitCache>, hints: GitPullHints): Promise<void>;
  addObserver(id: string, verifier: unknown): Promise<void>;
  // write side
  prepareCreateIssue(options: GitLabCreateIssueOptions): Promise<GitLabAction>;
  prepareCreateMergeRequest(options: GitLabCreateMergeRequestOptions): Promise<GitLabAction>;
  prepareSetTitle(kind: "issue" | "mergeRequest", id: string, title: string): Promise<GitLabAction>;
  prepareAddLabels(kind: "issue" | "mergeRequest", id: string, labels: string[]): Promise<GitLabAction>;
  prepareRemoveLabels(kind: "issue" | "mergeRequest", id: string, labels: string[]): Promise<GitLabAction>;
  prepareChangeState(kind: "issue" | "mergeRequest", id: string, state: "opened" | "closed"): Promise<GitLabAction>;
  preparePostComment(kind: "issue" | "mergeRequest", id: string, body: string): Promise<GitLabAction>;
  preparePostReview(id: string, review: GitLabMergeRequestReviewDraft): Promise<GitLabAction>;
  prepareReplyToDiffComment(id: string, commentId: string, body: string): Promise<GitLabAction>;
  prepareResolveDiffThread(id: string, threadId: string, resolved: boolean): Promise<GitLabAction>;
  prepareMergeMergeRequest(id: string, options?: GitLabMergeRequestMergeOptions): Promise<GitLabAction>;
  preparePush(branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>): Promise<GitLabAction | null>;
  submitActionForApproval(queue: unknown, action: GitLabAction, description: ActionDescription): Promise<void>;
  applyAction(actionId: number, cache: unknown): Promise<void>;
  rejectAction(actionId: number): Promise<undefined | { restart?: boolean }>;
  revertAction(actionId: number): Promise<undefined | { message?: string; canRetry?: boolean }>;
};

/** A stand-in for the action-scoped `GitCache` stub `applyAction` receives; nothing here reads it yet. */
class NullGitCache extends RpcTarget {}

/** A test approval queue: accepts every action, records descriptions. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: string[] = [];
  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }
  async authorizeObservation(description: { title: string }): Promise<void> {
    this.observations.push(description.title);
  }
}

async function drain<T>(cursor: Pages<T>): Promise<T[]> {
  const items: T[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
    items.push(...page);
  }
  return items;
}

/**
 * A forwarded call's result as plain data. Failures ride back as data rather than as RPC
 * rejections, because an expected rejection crossing the RPC boundary additionally surfaces as
 * an unhandled-rejection report in vitest; the test-side wrapper rethrows `error` locally.
 */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  /**
   * The gatekeeper facet for the given name, instantiating it with `props` on first use. Each
   * distinct scenario should use a fresh facet name: a facet is cached per name, so reusing one
   * silently reuses the first caller's props and storage.
   */
  #gatekeeper(facetName: string, props: GatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get<GitLabGatekeeperImpl>(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).GitLabGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  async describe(facetName: string, props: GatekeeperProps) {
    return await outcome(() => this.#gatekeeper(facetName, props).describe());
  }

  async projectMetadata(facetName: string, props: GatekeeperProps): Promise<Outcome<GitLabProjectMetadata>> {
    return await outcome(() => this.#gatekeeper(facetName, props).projectMetadata());
  }

  async openIssue(facetName: string, props: GatekeeperProps, id: string): Promise<Outcome<GitLabIssueDetails>> {
    return await outcome(() => this.#gatekeeper(facetName, props).openIssue(id));
  }

  async openMergeRequest(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>):
      Promise<Outcome<GitLabMergeRequestDetails>> {
    return await outcome(() => this.#gatekeeper(facetName, props).openMergeRequest(id, cache));
  }

  async discussionAll(facetName: string, props: GatekeeperProps, kind: "issue" | "mergeRequest", id: string, pageSize: number):
      Promise<Outcome<GitLabDiscussionEntry[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).issueDiscussion(kind, id, pageSize)));
  }

  async diffAll(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>):
      Promise<Outcome<{ revision: GitLabMergeRequestRevision; files: GitLabDiffFile[] }>> {
    return await outcome(async () => {
      const diff = await this.#gatekeeper(facetName, props).mergeRequestDiff(id, 20, cache);
      return { revision: diff.revision, files: await drain(diff.files) };
    });
  }

  async mergeBase(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>): Promise<Outcome<string>> {
    return await outcome(() => this.#gatekeeper(facetName, props).mergeRequestMergeBase(id, cache));
  }

  async threadsAll(facetName: string, props: GatekeeperProps, id: string): Promise<Outcome<GitLabDiffThread[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).mergeRequestThreads(id, 20)));
  }

  async listIssuesAll(facetName: string, props: GatekeeperProps, pageSize: number): Promise<Outcome<GitLabIssueSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).listIssues(undefined, pageSize)));
  }

  async listMergeRequestsAll(facetName: string, props: GatekeeperProps, pageSize: number): Promise<Outcome<GitLabMergeRequestSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).listMergeRequests(undefined, pageSize)));
  }

  async listBranchesAll(facetName: string, props: GatekeeperProps, pageSize: number): Promise<Outcome<GitLabBranchSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).listBranches(undefined, pageSize)));
  }

  async getCommit(facetName: string, props: GatekeeperProps, ref: string | undefined, cache?: RpcStub<GitCache>):
      Promise<Outcome<{ details: GitLabCommitDetails; fromCache: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getCommit(ref, cache));
  }

  async resolveRef(facetName: string, props: GatekeeperProps, ref: string | undefined, cache?: RpcStub<GitCache>):
      Promise<Outcome<{ id: string; fromCache: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).resolveRef(ref, cache));
  }

  async listCommitsAll(facetName: string, props: GatekeeperProps, pageSize: number, cache?: RpcStub<GitCache>):
      Promise<Outcome<GitLabCommitSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).listCommits(undefined, pageSize, cache)));
  }

  async mergeRequestCommitsAll(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>):
      Promise<Outcome<GitLabCommitSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).mergeRequestCommits(id, 50, cache)));
  }

  async isSimulatedCommitId(facetName: string, props: GatekeeperProps, commitId: string): Promise<Outcome<boolean>> {
    return await outcome(async () => this.#gatekeeper(facetName, props).isSimulatedCommitId(commitId));
  }

  async gitPull(facetName: string, props: GatekeeperProps, oids: string[], cache: RpcStub<GitCache>, hints: GitPullHints):
      Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).gitPull(oids, cache, hints));
  }

  /** `addObserver` with a verifier minted for `observerUserObjectId`'s account. */
  async addObserver(facetName: string, props: GatekeeperProps, observerUserObjectId: string): Promise<Outcome<void>> {
    const verifier = (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId: observerUserObjectId } });
    return await outcome(() => this.#gatekeeper(facetName, props).addObserver("observer", verifier));
  }

  // -- write side -------------------------------------------------------------------------

  #queues = new Map<string, RecordingQueue>();

  #queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) {
      queue = new RecordingQueue();
      this.#queues.set(facetName, queue);
    }
    return queue;
  }

  /** What the facet's queue has recorded so far. */
  async queueLog(facetName: string): Promise<{ submitted: Array<{ actionId: number; description: ActionDescription }>; observations: string[] }> {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations };
  }

  /**
   * Prepare and submit one action through the facet, returning the stored action record. `kind`
   * selects the prepare method; `args` are its arguments.
   */
  async queueAction(facetName: string, props: GatekeeperProps, method: string, args: unknown[], description: ActionDescription):
      Promise<Outcome<GitLabAction | null>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props) as unknown as Record<string, (...a: unknown[]) => Promise<GitLabAction | null>>;
      const action = await gatekeeper[method](...args);
      // `preparePush` answers null when the branch is already at the commit: nothing to queue.
      if (action === null) return null;
      await (this.#gatekeeper(facetName, props)).submitActionForApproval(this.#queue(facetName), action, description);
      return action;
    });
  }

  async applyAction(facetName: string, props: GatekeeperProps, actionId: number, cache?: RpcStub<GitCache>): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, cache ?? new NullGitCache()));
  }

  async rejectAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<undefined | { restart?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  async revertAction(facetName: string, props: GatekeeperProps, actionId: number):
      Promise<Outcome<undefined | { message?: string; canRetry?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).revertAction(actionId));
  }

  // -- account ----------------------------------------------------------------------------

  /** `UserAccount.getAccessToken()`, with the rejection carried back as data. */
  async accountToken(userObjectId: string): Promise<Outcome<string>> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await outcome(() => account.getAccessToken());
  }

  // -- account entrypoint -----------------------------------------------------------------

  #user(userObjectId: string) {
    return (this.ctx.exports as unknown as TestExports).TestUser({ props: { userObjectId } });
  }

  async userDescribe(userObjectId: string): Promise<Outcome<{ displayName?: string; uniqueName?: string }>> {
    return await outcome(() => this.#user(userObjectId).describe());
  }

  async userEmail(userObjectId: string): Promise<Outcome<string | null>> {
    return await outcome(() => this.#user(userObjectId).getAuthenticatedEmail());
  }

  async userEnsureResources(userObjectId: string, patterns: string[]): Promise<Outcome<{ url?: string }>> {
    return await outcome(() => this.#user(userObjectId).ensureResources(patterns));
  }

  /** Which resource `getGatekeeperClassFor(url)` resolves to, by its URL pattern. */
  async resourceFor(userObjectId: string, url: string): Promise<Outcome<string>> {
    return await outcome(async () => (await this.#user(userObjectId).getGatekeeperClassFor(url)).resource.urlPattern);
  }

  async supportedResources(userObjectId: string): Promise<Outcome<Array<{ urlPattern: string; title: string; description: string }>>> {
    return await outcome(() => this.#user(userObjectId).getSupportedResources());
  }

  async hasProjectAccess(userObjectId: string, projectPath: string): Promise<Outcome<boolean>> {
    const verifier = (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId } });
    return await outcome(() => verifier.hasProjectAccess(projectPath));
  }
}
