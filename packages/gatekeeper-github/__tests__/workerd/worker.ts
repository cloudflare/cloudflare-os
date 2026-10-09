// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. And because a stub *to* a facet is not
// serializable, TestHooks cannot hand the facet to the test; it forwards each call instead --
// stubs the test passes (the fake approval queue and git cache) ride through to the facet, and
// results ride back as plain data.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type {
  AccountDescription, ActionDescription, ConnectHandoff, GatekeeperUser, GitCache,
} from "@gadgets/workshop-shared/gatekeeper";
import { GitHubGatekeeperImpl, type GitHubVerifierApi } from "../../src/github.js";
import type {
  Cursor,
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitFilter,
  GitHubCommitSummary,
  GitHubCreatePullRequestOptions,
  GitHubIssueDetails,
  GitHubPullRequestDetails,
  GitHubPullRequestDiffFile,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestRevision,
  GitHubRepoMetadata,
} from "../../src/types.js";

export { default } from "../../src/github.js";
export * from "../../src/github.js";
// Named as well, since the pool builds `ctx.exports` entrypoints only from exports it can see
// statically, and the account and TestHooks mint these.
export { GatekeeperUserImpl, GitHubVerifier } from "../../src/github.js";

/** What each `TestConnectCallback` was told, by its `props.name`. */
export const connectCallbackEvents = new Map<string, string[]>();

/** Stands in for the Workshop's connect callback, recording each call it receives. */
export class TestConnectCallback extends WorkerEntrypoint<Cloudflare.Env, { name: string }> {
  #record(event: string): void {
    const events = connectCallbackEvents.get(this.ctx.props.name) ?? [];
    events.push(event);
    connectCallbackEvents.set(this.ctx.props.name, events);
  }

  async complete(): Promise<ConnectHandoff> {
    this.#record("complete");
    return { targetOrigin: "https://workshop.example", ticket: "ticket" };
  }

  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    this.#record(`reconnectComplete:${stageId}`);
    return { targetOrigin: "https://workshop.example", ticket: "ticket" };
  }

  async credentialsExpired(): Promise<void> {
    this.#record("credentialsExpired");
  }

  async credentialsRestored(): Promise<void> {
    this.#record("credentialsRestored");
  }
}

/** Mirrors github.ts's (unexported) `GitHubGatekeeperImplProps`. */
export type GatekeeperProps = {
  userObjectId: string;
  resourceKind: "repo" | "issue" | "pull";
  owner: string;
  repo: string;
  issueNumber?: number;
};

/** Mirrors github.ts's (unexported) `PushAction` record, as the tests read it back. */
export type PushActionData = {
  type: "push";
  approvalId: number;
  submittedAt: number;
  owner: string;
  repo: string;
  branch: string;
  expectedOldSha: string;
  newSha: string;
  force: boolean;
};

/** Mirrors github.ts's (unexported) `CreatePullRequestAction` record. */
export type CreatePullRequestActionData = {
  type: "createPullRequest";
  approvalId: number;
  submittedAt: number;
  owner: string;
  repo: string;
  provisionalId: string;
  options: GitHubCreatePullRequestOptions;
};

/** github.ts's (unexported) `PostReviewAction` record, read off the real submit signature. */
export type PostReviewActionData = Extract<
  Parameters<GitHubGatekeeperImpl["submitActionForApproval"]>[1], { type: "postReview" }>;

/** github.ts's (unexported) `MergePullRequestAction` record, read off the real submit signature. */
export type MergePullRequestActionData = Extract<
  Parameters<GitHubGatekeeperImpl["submitActionForApproval"]>[1], { type: "mergePullRequest" }>;

/** github.ts's (unexported) `SetTitleAction`/`ChangeStateAction` records. */
export type IssueEditActionData = Extract<
  Parameters<GitHubGatekeeperImpl["submitActionForApproval"]>[1], { type: "setTitle" | "changeState" }>;

/** The listing methods `TestHooks.listingPages` drives. */
export type ListingMethod = "listIssues" | "searchIssues" | "listPullRequests" | "searchPullRequests";

type TestExports = {
  GitHubGatekeeperImpl(options: { props: GatekeeperProps }):
    DurableObjectClass<GitHubGatekeeperImpl>;
  SeededGitHubGatekeeper(options: { props: GatekeeperProps }):
    DurableObjectClass<SeededGitHubGatekeeper>;
  GatekeeperUserImpl(options: { props: { userObjectId: string } }): Fetcher<GatekeeperUser>;
  GitHubVerifier(options: { props: { userObjectId: string } }): Fetcher<GitHubVerifierApi>;
};

/**
 * The production gatekeeper plus a way to write its storage directly, for records an earlier
 * release stored that today's validated entry points can no longer produce.
 */
export class SeededGitHubGatekeeper extends GitHubGatekeeperImpl {
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.ctx.storage.kv.put(key, value);
  }
}

type SeedFacet = { seed(entries: Record<string, unknown>): Promise<void> };

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference collapses several of these returns to `never` (its `Serializable`
// heuristic gives up on them), while the runtime objects are exactly the production ones.
type GatekeeperFacet = {
  preparePush(branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>)
    : Promise<PushActionData | null>;
  prepareCreatePullRequest(options: GitHubCreatePullRequestOptions)
    : Promise<CreatePullRequestActionData>;
  prepareMergePullRequest(pullId: string, options?: GitHubPullRequestMergeOptions)
    : Promise<MergePullRequestActionData>;
  submitActionForApproval(
    queue: unknown,
    action: PushActionData | CreatePullRequestActionData | PostReviewActionData | MergePullRequestActionData
      | IssueEditActionData,
    description: ActionDescription): Promise<void>;
  applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void>;
  rejectAction(actionId: number): Promise<undefined | { restart?: boolean }>;
  revertAction(actionId: number): Promise<undefined | { message?: string; canRetry?: boolean }>;
  listBranches(filter: undefined, pageSize: number)
    : Promise<{ next(): Promise<GitHubBranchSummary[] | null> }>;
  isSimulatedCommitId(commitId: string): Promise<boolean>;
  getCommit(ref: string | undefined, cache?: RpcStub<GitCache>)
    : Promise<{ details: GitHubCommitDetails, fromCache: boolean }>;
  resolveRef(ref: string | undefined, cache?: RpcStub<GitCache>)
    : Promise<{ id: string, fromCache: boolean }>;
  repoMetadata(): Promise<GitHubRepoMetadata>;
  openPullRequest(id: string, cache?: RpcStub<GitCache>): Promise<GitHubPullRequestDetails>;
  pullMergeBase(id: string, cache?: RpcStub<GitCache>): Promise<string>;
  pullDiff(id: string, pageSize: number, cache?: RpcStub<GitCache>): Promise<{
    revision: GitHubPullRequestRevision,
    files: { next(): Promise<GitHubPullRequestDiffFile[] | null> },
  }>;
  pullCommits(id: string, pageSize: number, cache?: RpcStub<GitCache>)
    : Promise<{ next(): Promise<GitHubCommitSummary[] | null> }>;
  listCommits(filter: GitHubCommitFilter | undefined, pageSize: number, cache?: RpcStub<GitCache>)
    : Promise<{ next(): Promise<GitHubCommitSummary[] | null> }>;
  openIssue(id: string): Promise<GitHubIssueDetails>;
  prepareSetTitle(kind: "issue" | "pull", id: string, title: string): Promise<IssueEditActionData>;
  prepareChangeState(kind: "issue" | "pull", id: string, state: "open" | "closed")
    : Promise<IssueEditActionData>;
} & Record<ListingMethod, (query: never, pageSize: number) => Promise<Cursor<unknown>>>;

async function drain<T>(cursor: { next(): Promise<T[] | null> }): Promise<T[]> {
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
    return this.ctx.facets.get<GitHubGatekeeperImpl>(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).GitHubGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  /** `GatekeeperUser.describe()` for the account with id `userObjectId`. */
  async describeAccount(userObjectId: string): Promise<Outcome<AccountDescription>> {
    const user = (this.ctx.exports as unknown as TestExports)
      .GatekeeperUserImpl({ props: { userObjectId } });
    return await outcome(() => user.describe());
  }

  /** `GitHubVerifier.hasRepoAccess()` as the account with id `userObjectId`. */
  async hasRepoAccess(userObjectId: string, owner: string, repo: string): Promise<Outcome<boolean>> {
    const verifier = (this.ctx.exports as unknown as TestExports)
      .GitHubVerifier({ props: { userObjectId } });
    return await outcome(() => verifier.hasRepoAccess(owner, repo));
  }

  /** The `urlPattern` of the resource `GatekeeperUser.getGatekeeperClassFor(url)` resolves. */
  async resourcePatternFor(url: string): Promise<Outcome<string>> {
    const user = (this.ctx.exports as unknown as TestExports)
      .GatekeeperUserImpl({ props: { userObjectId: "unused" } });
    return await outcome(async () => (await user.getGatekeeperClassFor(url)).resource.urlPattern);
  }

  async preparePush(
    facetName: string, props: GatekeeperProps,
    branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>,
  ): Promise<Outcome<PushActionData | null>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).preparePush(branch, commitId, force, cache));
  }

  async submitPush(
    facetName: string, props: GatekeeperProps,
    queue: unknown, action: PushActionData, description: ActionDescription,
  ): Promise<Outcome<void>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).submitActionForApproval(queue, action, description));
  }

  async prepareCreatePullRequest(
    facetName: string, props: GatekeeperProps, options: GitHubCreatePullRequestOptions,
  ): Promise<Outcome<CreatePullRequestActionData>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).prepareCreatePullRequest(options));
  }

  async submitCreatePullRequest(
    facetName: string, props: GatekeeperProps,
    queue: unknown, action: CreatePullRequestActionData, description: ActionDescription,
  ): Promise<Outcome<void>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).submitActionForApproval(queue, action, description));
  }

  async submitReview(
    facetName: string, props: GatekeeperProps,
    queue: unknown, action: PostReviewActionData, description: ActionDescription,
  ): Promise<Outcome<void>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).submitActionForApproval(queue, action, description));
  }

  async prepareMergePullRequest(
    facetName: string, props: GatekeeperProps, pullId: string, options?: GitHubPullRequestMergeOptions,
  ): Promise<Outcome<MergePullRequestActionData>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).prepareMergePullRequest(pullId, options));
  }

  async submitMerge(
    facetName: string, props: GatekeeperProps,
    queue: unknown, action: MergePullRequestActionData, description: ActionDescription,
  ): Promise<Outcome<void>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).submitActionForApproval(queue, action, description));
  }

  async rejectAction(
    facetName: string, props: GatekeeperProps, actionId: number,
  ): Promise<Outcome<undefined | { restart?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  async openPullRequest(
    facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<GitHubPullRequestDetails>> {
    return await outcome(() => this.#gatekeeper(facetName, props).openPullRequest(id, cache));
  }

  /** `pullDiff` with the file cursor drained inside the DO (cursor stubs cannot ride back). */
  async pullDiffAll(
    facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<{ revision: GitHubPullRequestRevision, files: GitHubPullRequestDiffFile[] }>> {
    return await outcome(async () => {
      const diff = await this.#gatekeeper(facetName, props).pullDiff(id, 20, cache);
      return { revision: diff.revision, files: await drain(diff.files) };
    });
  }

  /** `pullCommits`, drained. */
  async pullCommitsAll(
    facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<GitHubCommitSummary[]>> {
    return await outcome(async () =>
      await drain(await this.#gatekeeper(facetName, props).pullCommits(id, 50, cache)));
  }

  /** The first page of the repo-level `listCommits`. */
  async listCommitsFirstPage(
    facetName: string, props: GatekeeperProps,
    filter: GitHubCommitFilter | undefined, pageSize: number, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<GitHubCommitSummary[] | null>> {
    return await outcome(async () => {
      const cursor = await this.#gatekeeper(facetName, props).listCommits(filter, pageSize, cache);
      return await cursor.next();
    });
  }

  async applyAction(
    facetName: string, props: GatekeeperProps, actionId: number, cache: RpcStub<GitCache>,
  ): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, cache));
  }

  async revertAction(
    facetName: string, props: GatekeeperProps, actionId: number,
  ): Promise<Outcome<undefined | { message?: string; canRetry?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).revertAction(actionId));
  }

  /** The first page of `listBranches`, drained inside the DO (cursor stubs cannot ride back). */
  async listBranchesFirstPage(
    facetName: string, props: GatekeeperProps, pageSize: number,
  ): Promise<Outcome<GitHubBranchSummary[] | null>> {
    return await outcome(async () => {
      const cursor = await this.#gatekeeper(facetName, props).listBranches(undefined, pageSize);
      return await cursor.next();
    });
  }

  /**
   * `listBranches` raced against a rejection: the cursor (and its injected-branch snapshot) is
   * built first, `actionId` is rejected, and only then is the first page drained.
   */
  async listBranchesFirstPageAfterReject(
    facetName: string, props: GatekeeperProps, pageSize: number, actionId: number,
  ): Promise<Outcome<GitHubBranchSummary[] | null>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props);
      const cursor = await gatekeeper.listBranches(undefined, pageSize);
      await gatekeeper.rejectAction(actionId);
      return await cursor.next();
    });
  }

  /**
   * `listBranches` paged (page size 1) with a rejection *between* pages: the first page is
   * drained, `actionId` is rejected, then the second page is drained -- catching rows that were
   * already buffered ahead of the first page when the rejection landed.
   */
  async listBranchesPagedRejectBetween(
    facetName: string, props: GatekeeperProps, actionId: number,
  ): Promise<Outcome<{
    first: GitHubBranchSummary[] | null, second: GitHubBranchSummary[] | null,
  }>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props);
      const cursor = await gatekeeper.listBranches(undefined, 1);
      const first = await cursor.next();
      await gatekeeper.rejectAction(actionId);
      const second = await cursor.next();
      return { first, second };
    });
  }

  async isSimulatedCommitId(
    facetName: string, props: GatekeeperProps, commitId: string,
  ): Promise<Outcome<boolean>> {
    return await outcome(() => this.#gatekeeper(facetName, props).isSimulatedCommitId(commitId));
  }

  async getCommit(
    facetName: string, props: GatekeeperProps, ref: string | undefined, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<{ details: GitHubCommitDetails, fromCache: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getCommit(ref, cache));
  }

  async resolveRef(
    facetName: string, props: GatekeeperProps, ref: string | undefined, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<{ id: string, fromCache: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).resolveRef(ref, cache));
  }

  async repoMetadata(
    facetName: string, props: GatekeeperProps,
  ): Promise<Outcome<GitHubRepoMetadata>> {
    return await outcome(() => this.#gatekeeper(facetName, props).repoMetadata());
  }

  async pullMergeBase(
    facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<string>> {
    return await outcome(() => this.#gatekeeper(facetName, props).pullMergeBase(id, cache));
  }

  async openIssue(
    facetName: string, props: GatekeeperProps, id: string,
  ): Promise<Outcome<GitHubIssueDetails>> {
    return await outcome(() => this.#gatekeeper(facetName, props).openIssue(id));
  }

  /** Prepares and queues a `setTitle` (given `title`) or `changeState` (given `state`). */
  async queueEdit(
    facetName: string, props: GatekeeperProps, queue: unknown,
    kind: "issue" | "pull", id: string, edit: { title: string } | { state: "open" | "closed" },
  ): Promise<Outcome<number>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props);
      const action = "title" in edit
        ? await gatekeeper.prepareSetTitle(kind, id, edit.title)
        : await gatekeeper.prepareChangeState(kind, id, edit.state);
      await gatekeeper.submitActionForApproval(
        queue, action, { title: action.type, description: action.type, implementsRevert: true });
      return action.approvalId;
    });
  }

  /**
   * One listing cursor's `next()` results, for up to `calls` calls or through its `null`. A call
   * that throws is recorded as its message and retried on the same cursor; a second throw in a
   * row ends the drain with it.
   */
  async listingPages(
    facetName: string, props: GatekeeperProps,
    method: ListingMethod, query: unknown, pageSize: number, calls = Infinity,
  ): Promise<Outcome<(unknown[] | null | string)[]>> {
    return await outcome(async () => {
      const cursor = await this.#gatekeeper(facetName, props)[method](query as never, pageSize);
      const pages: (unknown[] | null | string)[] = [];
      while (pages.length < calls && pages.at(-1) !== null) {
        try {
          pages.push(await cursor.next());
        } catch (error) {
          if (typeof pages.at(-1) === "string") throw error;
          pages.push(String(error));
        }
      }
      return pages;
    });
  }

  /** Restarts the gatekeeper facet: in-memory state is lost, storage (and its caches) kept. */
  async restartGatekeeper(facetName: string): Promise<void> {
    this.ctx.facets.abort(facetName, new Error("test: restart"));
  }

  /**
   * Writes `entries` into a gatekeeper's storage. Must be the facet's first use: the facet is
   * instantiated as `SeededGitHubGatekeeper`, and later calls reuse it.
   */
  async seedGatekeeper(
    facetName: string, props: GatekeeperProps, entries: Record<string, unknown>,
  ): Promise<void> {
    // Spelled structurally, like GatekeeperFacet: `Fetcher<T>` inference loses `seed`.
    const facet = this.ctx.facets.get<SeededGitHubGatekeeper>(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).SeededGitHubGatekeeper({ props }),
    })) as unknown as SeedFacet;
    await facet.seed(entries);
  }
}
