// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. And because a stub *to* a facet is not
// serializable, TestHooks cannot hand the facet to the test; it forwards each call instead, and
// results ride back as plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser, GitCache, GitPullHints,
  GitPullTransfer,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GitLabAction } from "../../src/gitlab-action-types.js";
import type { GitLabGatekeeperImplProps } from "../../src/gitlab-env.js";
import type {
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCreateIssueOptions,
  GitLabCreateMergeRequestOptions,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
  GitLabCommitFilter,
  GitLabCommitSummary,
  GitLabDiffFile,
  GitLabDiffThread,
  GitLabDiscussionEntry,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSummary,
  GitLabMergeRequestDetails,
  GitLabMergeRequestRevision,
  GitLabMergeRequestSummary,
  GitLabProjectMetadata,
} from "../../src/types.js";

export { default } from "../../src/gitlab.js";
export * from "../../src/gitlab.js";
import { GatekeeperUserImpl, GitLabGatekeeperImpl, GitLabVerifier } from "../../src/gitlab.js";

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

/**
 * The gatekeeper with its storage writable from a test, to leave what an earlier version wrote:
 * `seed` puts each entry, and deletes the key for a `null`.
 */
export class SeededGatekeeper extends GitLabGatekeeperImpl {
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) this.ctx.storage.kv.delete(key);
      else this.ctx.storage.kv.put(key, value);
    }
  }
}

export type GatekeeperProps = GitLabGatekeeperImplProps;

/** What a session passes to `submitActionForApproval`; the gatekeeper renders the description. */
export type ActionPresentation = Parameters<GitLabGatekeeperImpl["submitActionForApproval"]>[2];

type UserProps = { userObjectId: string };

type TestExports = {
  GitLabGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass<GitLabGatekeeperImpl>;
  SeededGatekeeper(options: { props: GatekeeperProps }): DurableObjectClass<SeededGatekeeper>;
  TestUser(options: { props: UserProps }): {
    describe(): Promise<{ displayName?: string; uniqueName?: string }>;
    getAuthenticatedEmail(): Promise<string | null>;
    getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass; resource: { urlPattern: string } }>;
    getSupportedResources(): Promise<Array<{ urlPattern: string; title: string; description: string }>>;
    ensureResources(patterns: string[]): Promise<{ url?: string }>;
  };
  TestVerifier(options: { props: UserProps }): {
    hasProjectAccess(projectId: number, minAccessLevel?: number): Promise<boolean>;
    hasProjectPathAccess(projectPath: string, minAccessLevel?: number): Promise<boolean>;
    checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
  };
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
};

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference collapses several of these returns to `never`, while the runtime objects
// are exactly the production ones.
type Pages<T> = { next(): Promise<T[] | null> };
type GatekeeperFacet = Pick<GitLabGatekeeperImpl, "gitPull"> & {
  describe(): Promise<{ url: string; title: string; snippet: string; suggestedBindingName: string; tsType: string }>;
  projectMetadata(): Promise<GitLabProjectMetadata>;
  openIssue(id: string): Promise<GitLabIssueDetails>;
  openMergeRequest(id: string, cache?: RpcStub<GitCache>): Promise<GitLabMergeRequestDetails>;
  mergeRequestDetails(id: string, cache?: RpcStub<GitCache>): Promise<GitLabMergeRequestDetails>;
  startSession(queue: unknown): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
  issueDiscussion(kind: "issue" | "mergeRequest", id: string, pageSize: number): Promise<Pages<GitLabDiscussionEntry>>;
  mergeRequestDiff(id: string, pageSize: number, cache?: RpcStub<GitCache>):
    Promise<{ revision: GitLabMergeRequestRevision; files: Pages<GitLabDiffFile> }>;
  mergeRequestMergeBase(id: string, cache?: RpcStub<GitCache>): Promise<string>;
  mergeRequestThreads(id: string, pageSize: number): Promise<Pages<GitLabDiffThread>>;
  listIssues(filter: GitLabIssueFilter | undefined, pageSize: number): Promise<Pages<GitLabIssueSummary>>;
  listMergeRequests(filter: undefined, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabMergeRequestSummary>>;
  listBranches(filter: undefined, pageSize: number): Promise<Pages<GitLabBranchSummary>>;
  getCommit(ref: string | undefined, cache?: RpcStub<GitCache>): Promise<{ details: GitLabCommitDetails; fromCache: boolean }>;
  resolveRef(ref: string | undefined, cache?: RpcStub<GitCache>): Promise<{ id: string; fromCache: boolean }>;
  listCommits(filter: GitLabCommitFilter | undefined, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabCommitSummary>>;
  mergeRequestCommits(id: string, pageSize: number, cache?: RpcStub<GitCache>): Promise<Pages<GitLabCommitSummary>>;
  isSimulatedCommitId(commitId: string): boolean;
  addObserver(id: string, verifier: unknown): Promise<void>;
  verifyObserverAccess(observers: Array<{ id: string; verifier: unknown }>, subresources: string[]):
    Promise<{ allowedObserverIds: string[] }>;
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
  submitActionForApproval(queue: unknown, action: GitLabAction, presentation: ActionPresentation): Promise<void>;
  applyAction(actionId: number, cache: unknown): Promise<void>;
  rejectAction(actionId: number): Promise<undefined | { restart?: boolean }>;
  revertAction(actionId: number): Promise<undefined | { message?: string; canRetry?: boolean }>;
};

/** A binding `getGatekeeperClassFor` minted, as the Workshop reaches it; see `TestHooks.#bound`. */
type BoundFacet = {
  describe(): Promise<{ url: string; title: string; snippet: string; suggestedBindingName: string; tsType: string }>;
  getAutoApprovableActions(): Promise<string[]>;
  getHistoricalSubresources(): Promise<string[]>;
  startSession(queue: unknown): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
  verifyObserverAccess(observers: Array<{ id: string; verifier: unknown }>, subresources: string[]):
    Promise<{ allowedObserverIds: string[] }>;
};

/**
 * A stand-in for the action-scoped `GitCache` stub `applyAction` receives, for the actions that
 * never read it: every one but a push.
 */
class NullGitCache extends RpcTarget {}

/**
 * A test stand-in for the Workshop's connect callback. The account persists its callback in KV,
 * which only a *persistent* stub survives -- a `WorkerEntrypoint` reached through `ctx.exports`,
 * as the Workshop's own is -- so this is one, with its tally kept module-side by account id:
 * `credentialsExpired()` notices received, and how many of the next ones to refuse, as an
 * unreachable Workshop would. A reconnect's handoff carries its stage id as the ticket, so a test
 * can commit exactly the stage it finished, as the Workshop's ticket would.
 */
const callbackTallies = new Map<string, { expiredNotices: number; failNext: number }>();

export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, { userObjectId: string }> {
  async credentialsExpired(): Promise<void> {
    const tally = callbackTallies.get(this.ctx.props.userObjectId);
    if (!tally) throw new Error("TestCallback: no tally installed");
    if (tally.failNext > 0) {
      tally.failNext -= 1;
      throw new Error("Workshop unreachable");
    }
    tally.expiredNotices += 1;
  }

  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  /**
   * Describes the account first, as the Workshop's `stagePendingConnect` does -- which refreshes
   * the grant if GitLab refuses its token -- then fails, as a Workshop that cannot stage would.
   */
  async complete(account: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    await account.describe();
    throw new Error("Workshop unreachable");
  }
}

/** Stands in for the workspace git cache a session advertises to: it knows no objects. */
class EmptyGitCache extends RpcTarget {
  async advertiseCommit(): Promise<void> {}
  async get(): Promise<null> {
    return null;
  }
}

/** A test approval queue: records descriptions, and accepts every action unless told to refuse. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: string[] = [];
  /** Each observation's exclusions, in the order recorded (`undefined` for none). */
  readonly excluded: Array<string[] | undefined> = [];
  /** Each observation's subresources, in the order recorded. */
  readonly subresources: Array<string[] | undefined> = [];
  /** How many of the next submissions to refuse, as a Workshop that could not record them would. */
  refuseNext = 0;
  /** The ordinals (1-based) of the observations to refuse, as the Workshop refusing their audience would. */
  readonly refuseObservations = new Set<number>();
  #observationsAsked = 0;
  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      throw new Error("The approval queue refused the action.");
    }
    this.submitted.push({ actionId, description });
  }
  async authorizeObservation(description: { title: string; excludeObservers?: string[]; subresources?: string[] }):
      Promise<void> {
    if (this.refuseObservations.has(++this.#observationsAsked)) throw new Error("test: the audience was refused");
    this.observations.push(description.title);
    this.excluded.push(description.excludeObservers);
    this.subresources.push(description.subresources);
  }
  async getGitCache(): Promise<EmptyGitCache> {
    return new EmptyGitCache();
  }
}

/** One call of `TestHooks.session`: `method(...args)` on the previous step's result, its cursor drained if `drain`. */
export type SessionStep = { method: string; args?: unknown[]; drain?: true };

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

  async mergeRequestDetails(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>):
      Promise<Outcome<GitLabMergeRequestDetails>> {
    return await outcome(() => this.#gatekeeper(facetName, props).mergeRequestDetails(id, cache));
  }

  /**
   * Starts a session on the facet over its recording queue, then makes each call in `steps` on
   * what the previous one returned -- `getPipeline()`, then `listJobs()`, say. The last result
   * rides back as data; observations land in `queueLog`.
   */
  async session(facetName: string, props: GatekeeperProps, steps: SessionStep[]): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      let target: unknown = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
      for (const step of steps) {
        const result = await (target as Record<string, (...args: unknown[]) => Promise<unknown>>)[step.method]!(...(step.args ?? []));
        target = step.drain ? await drain(result as Pages<unknown>) : result;
      }
      return target;
    });
  }

  /**
   * `session`, whose last step returns a cursor that is then walked page by page; a page that
   * fails is asked for once more. What the walk served, and the error each failed call gave.
   */
  async sessionRetryingPages(facetName: string, props: GatekeeperProps, steps: SessionStep[]):
      Promise<Outcome<{ served: unknown[][]; errors: string[] }>> {
    return await outcome(async () => {
      const opened = await this.session(facetName, props, steps);
      if ("error" in opened) throw new Error(opened.error);
      const cursor = opened.ok as Pages<unknown>;
      const served: unknown[][] = [];
      const errors: string[] = [];
      for (let retried = false; ;) {
        const page = await outcome(() => cursor.next());
        if ("ok" in page) {
          if (page.ok === null) break;
          served.push(page.ok);
          continue;
        }
        errors.push(page.error);
        if (retried) break;
        retried = true;
      }
      return { served, errors };
    });
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

  /**
   * Open an issue listing, serve `pagesBefore` of its pages, apply or reject `actionId`, then drain
   * the rest: what a cursor serves when an action is decided while it is being read. One call, so
   * the cursor never has to outlive the event it was received in.
   */
  async listIssuesAcrossDecision(facetName: string, props: GatekeeperProps, actionId: number, pageSize: number,
                                 options: { filter?: GitLabIssueFilter; pagesBefore?: number; reject?: true } = {}):
      Promise<Outcome<GitLabIssueSummary[]>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props);
      const cursor = await gatekeeper.listIssues(options.filter, pageSize);
      const served: GitLabIssueSummary[] = [];
      for (let i = 0; i < (options.pagesBefore ?? 0); i++) served.push(...await cursor.next() ?? []);
      if (options.reject) await gatekeeper.rejectAction(actionId);
      else await gatekeeper.applyAction(actionId, new NullGitCache());
      return [...served, ...await drain(cursor)];
    });
  }

  /** Restart the gatekeeper, as an eviction would: its storage stays, its memory does not. */
  restart(facetName: string): void {
    this.ctx.facets.abort(facetName, new Error("test restart"));
  }

  /**
   * Start `facetName` on storage an earlier version left: a new binding's, with `entries` written
   * over it (see `SeededGatekeeper`), then restart it, so later calls reach the production class on
   * that storage, as after a deploy.
   */
  async startOnEarlierStorage(facetName: string, props: GatekeeperProps, entries: Record<string, unknown>): Promise<void> {
    const facet = this.ctx.facets.get<SeededGatekeeper>(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).SeededGatekeeper({ props }),
    })) as unknown as { seed(entries: Record<string, unknown>): Promise<void> };
    await facet.seed(entries);
    this.ctx.facets.abort(facetName, new Error("test restart"));
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

  async listCommitsAll(facetName: string, props: GatekeeperProps, pageSize: number, cache?: RpcStub<GitCache>, filter?: GitLabCommitFilter):
      Promise<Outcome<GitLabCommitSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).listCommits(filter, pageSize, cache)));
  }

  async mergeRequestCommitsAll(facetName: string, props: GatekeeperProps, id: string, cache?: RpcStub<GitCache>):
      Promise<Outcome<GitLabCommitSummary[]>> {
    return await outcome(async () => await drain(await this.#gatekeeper(facetName, props).mergeRequestCommits(id, 50, cache)));
  }

  async isSimulatedCommitId(facetName: string, props: GatekeeperProps, commitId: string): Promise<Outcome<boolean>> {
    return await outcome(async () => this.#gatekeeper(facetName, props).isSimulatedCommitId(commitId));
  }

  async gitPull(facetName: string, props: GatekeeperProps, oids: string[], options: GitPullHints):
      Promise<Outcome<GitPullTransfer>> {
    return await outcome(() => this.#gatekeeper(facetName, props).gitPull(oids, options));
  }

  /** `addObserver` with a verifier minted for `observerUserObjectId`'s account. */
  async addObserver(facetName: string, props: GatekeeperProps, observerUserObjectId: string, observerId = "observer"): Promise<Outcome<void>> {
    const verifier = (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId: observerUserObjectId } });
    return await outcome(() => this.#gatekeeper(facetName, props).addObserver(observerId, verifier));
  }

  /** `verifyObserverAccess` for observers named by id, each with a verifier minted for its account. */
  async verifyObservers(facetName: string, props: GatekeeperProps, observers: Array<{ id: string; userObjectId: string }>,
                        subresources: string[]): Promise<Outcome<string[]>> {
    return await outcome(async () => (await this.#gatekeeper(facetName, props).verifyObserverAccess(
      observers.map(({ id, userObjectId }) => ({
        id, verifier: (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId } }),
      })), subresources)).allowedObserverIds);
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

  /** Make the facet's queue refuse its next submission. */
  async refuseNextSubmit(facetName: string): Promise<void> {
    this.#queue(facetName).refuseNext += 1;
  }

  /** Make the facet's queue refuse its `ordinal`th observation (1-based, counted from its first). */
  async refuseObservation(facetName: string, ordinal: number): Promise<void> {
    this.#queue(facetName).refuseObservations.add(ordinal);
  }

  /** What the facet's queue has recorded so far. */
  async queueLog(facetName: string): Promise<{
    submitted: Array<{ actionId: number; description: ActionDescription }>;
    observations: string[];
    excluded: Array<string[] | undefined>;
    subresources: Array<string[] | undefined>;
  }> {
    const queue = this.#queue(facetName);
    return {
      submitted: queue.submitted, observations: queue.observations, excluded: queue.excluded,
      subresources: queue.subresources,
    };
  }

  /**
   * Prepare and submit one action through the facet, returning the stored action record. `kind`
   * selects the prepare method; `args` are its arguments.
   */
  async queueAction(facetName: string, props: GatekeeperProps, method: string, args: unknown[], presentation: ActionPresentation):
      Promise<Outcome<GitLabAction>> {
    return await outcome(async () => {
      const action = await this.#prepareAndSubmit(facetName, props, method, args, presentation);
      if (action === null) throw new Error(`${method} queued nothing; a push that may be a no-op goes through queuePush`);
      return action;
    });
  }

  /** `queueAction` for `preparePush`, which answers null -- queuing nothing -- when the branch is already at the commit. */
  async queuePush(facetName: string, props: GatekeeperProps, args: unknown[], presentation: ActionPresentation):
      Promise<Outcome<GitLabAction | null>> {
    return await outcome(() => this.#prepareAndSubmit(facetName, props, "preparePush", args, presentation));
  }

  async #prepareAndSubmit(facetName: string, props: GatekeeperProps, method: string, args: unknown[], presentation: ActionPresentation):
      Promise<GitLabAction | null> {
    const gatekeeper = this.#gatekeeper(facetName, props) as unknown as Record<string, (...a: unknown[]) => Promise<GitLabAction | null>>;
    const action = await gatekeeper[method](...args);
    if (action !== null) await this.#gatekeeper(facetName, props).submitActionForApproval(this.#queue(facetName), action, presentation);
    return action;
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
    return await outcome(async () => await account.getAccessToken());
  }

  /**
   * Give the account a Workshop callback and a connect link nonce (the seed writes neither).
   * `failNext` makes that many notices throw, as an unreachable Workshop would.
   */
  async installCallback(userObjectId: string, failNext = 0, initiationNonce = "nonce"): Promise<void> {
    callbackTallies.set(userObjectId, { expiredNotices: 0, failNext });
    const callback = (this.ctx.exports as unknown as TestExports).TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    // The production entry: it stores the callback and a connect nonce, and on an account with no
    // grant yet schedules the connect timeout.
    await account.setCallback(callback, initiationNonce, ["api", "write_repository"], false);
  }

  async expiredNotices(userObjectId: string): Promise<number> {
    return callbackTallies.get(userObjectId)?.expiredNotices ?? 0;
  }

  /** `UserAccount.reportTokenRejected(accessToken)`: what `withAccountApi` reports after a refused token. */
  async reportTokenRejected(userObjectId: string, accessToken: string): Promise<string> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await account.reportTokenRejected(accessToken);
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

  /**
   * The binding `getGatekeeperClassFor(url)` mints for the account, started as a facet as the
   * Workshop starts it: what an instance binding is tested through. Fresh names per scenario, as
   * for `#gatekeeper`.
   */
  #bound(facetName: string, userObjectId: string, url: string): BoundFacet {
    return this.ctx.facets.get(facetName, async () => ({
      class: (await this.#user(userObjectId).getGatekeeperClassFor(url)).class,
    })) as unknown as BoundFacet;
  }

  async boundDescribe(facetName: string, userObjectId: string, url: string) {
    return await outcome(() => this.#bound(facetName, userObjectId, url).describe());
  }

  /** The bound binding's auto-approvable actions and historical subresources. */
  async boundObserverBaseline(facetName: string, userObjectId: string, url: string):
      Promise<Outcome<{ autoApprovable: string[]; historical: string[] }>> {
    return await outcome(async () => {
      const bound = this.#bound(facetName, userObjectId, url);
      return { autoApprovable: await bound.getAutoApprovableActions(), historical: await bound.getHistoricalSubresources() };
    });
  }

  /** `session` on the bound binding; observations land in `queueLog(facetName)`. */
  async boundSession(facetName: string, userObjectId: string, url: string, steps: SessionStep[]): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      let target: unknown = await this.#bound(facetName, userObjectId, url).startSession(this.#queue(facetName));
      for (const step of steps) {
        const result = await (target as Record<string, (...args: unknown[]) => Promise<unknown>>)[step.method]!(...(step.args ?? []));
        target = step.drain ? await drain(result as Pages<unknown>) : result;
      }
      return target;
    });
  }

  /** `verifyObservers` on the bound binding. */
  async boundVerifyObservers(facetName: string, userObjectId: string, url: string,
                             observers: Array<{ id: string; userObjectId: string }>, subresources: string[]): Promise<Outcome<string[]>> {
    return await outcome(async () => (await this.#bound(facetName, userObjectId, url).verifyObserverAccess(
      observers.map(({ id, userObjectId: observer }) => ({
        id, verifier: (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId: observer } }),
      })), subresources)).allowedObserverIds);
  }

  async supportedResources(userObjectId: string): Promise<Outcome<Array<{ urlPattern: string; title: string; description: string }>>> {
    return await outcome(() => this.#user(userObjectId).getSupportedResources());
  }

  /** The verifier's membership check, by the project's id (a number) or its path (a string). */
  async hasProjectAccess(userObjectId: string, project: number | string, minAccessLevel?: number): Promise<Outcome<boolean>> {
    const verifier = (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId } });
    return await outcome(() => typeof project === "number"
      ? verifier.hasProjectAccess(project, minAccessLevel)
      : verifier.hasProjectPathAccess(project, minAccessLevel));
  }

  async checkSubresourceAccess(userObjectId: string, subresources: string[]): Promise<Outcome<boolean[]>> {
    const verifier = (this.ctx.exports as unknown as TestExports).TestVerifier({ props: { userObjectId } });
    return await outcome(() => verifier.checkSubresourceAccess(subresources));
  }
}
