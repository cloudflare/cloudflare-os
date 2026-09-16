// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. And because a stub *to* a facet is not
// serializable, TestHooks cannot hand the facet to the test; it forwards each call instead --
// stubs the test passes (the fake approval queue and git cache) ride through to the facet, and
// results ride back as plain data.

import { DurableObject } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type { ActionDescription, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubGatekeeperImpl } from "../../src/github.js";
import type {
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitFilter,
  GitHubCommitSummary,
  GitHubCreatePullRequestOptions,
  GitHubPullRequestDetails,
  GitHubPullRequestDiffFile,
  GitHubPullRequestRevision,
  GitHubRepoMetadata,
} from "../../src/types.js";

export { default } from "../../src/github.js";
export * from "../../src/github.js";

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

type TestExports = {
  GitHubGatekeeperImpl(options: { props: GatekeeperProps }):
    DurableObjectClass<GitHubGatekeeperImpl>;
};

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference collapses several of these returns to `never` (its `Serializable`
// heuristic gives up on them), while the runtime objects are exactly the production ones.
type GatekeeperFacet = {
  preparePush(branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>)
    : Promise<PushActionData | null>;
  prepareCreatePullRequest(options: GitHubCreatePullRequestOptions)
    : Promise<CreatePullRequestActionData>;
  submitActionForApproval(
    queue: unknown, action: PushActionData | CreatePullRequestActionData,
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
};

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
}
