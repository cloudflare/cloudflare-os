// The RPC sessions agents and gadgets talk to: one per bound resource kind. Every read records
// an observation and advertises the commit ids it returns to the workspace git cache; every
// write (a later commit) submits an action for approval. Mirrors gatekeeper-github's session
// classes, including the carve-out that results served from the git cache rather than from the
// provider are never advertised.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { commitIdsOfSummary } from "@gadgets/gatekeeper-kit/git-objects";
import type { EntityKind } from "./gitlab-action-types";
import { SessionGitCache } from "./gitlab-cursors";
import type { GitLabGatekeeperImpl } from "./gitlab-gatekeeper";
import { commitIdsOfMergeRequestSummary } from "./gitlab-normalize";
import type {
  GitLabBranchFilter,
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCommitFilter,
  GitLabCommitSummary,
  GitLabCreateIssueOptions,
  GitLabCreateMergeRequestOptions,
  GitLabDiffThread,
  GitLabDiscussionEntry,
  GitLabIssuable,
  GitLabIssue,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSearch,
  GitLabIssueSummary,
  GitLabMergeRequest,
  GitLabMergeRequestDetails,
  GitLabMergeRequestDiff,
  GitLabMergeRequestFilter,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
  GitLabMergeRequestSearch,
  GitLabMergeRequestSummary,
  GitLabPageOptions,
  GitLabProject,
  GitLabProjectMetadata,
  GitLabTagSummary,
} from "./types";

const NO_ACTIONS_YET = "GitLab actions are not available in this build.";

// Exported (like the impls below) for the workerd wiring tests, which instantiate sessions
// directly against fake gatekeepers -- see __tests__/workerd/session-git.test.ts.
@validateRpc()
export class GitLabProjectSessionImpl extends RpcTarget implements GitLabProject {
  #gatekeeper: GitLabGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
    this.#gitCache = new SessionGitCache(approvalQueue);
  }

  [Symbol.dispose](): void {
    this.#gitCache.dispose();
    (this.#approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getMetadata(): Promise<GitLabProjectMetadata> {
    const metadata = await this.#gatekeeper.projectMetadata();
    await this.#approvalQueue.authorizeObservation({
      title: `Read project metadata for ${metadata.path}`,
      description: `Read basic metadata for the GitLab project ${metadata.path}.`,
    });
    return metadata;
  }

  async createIssue(_options: GitLabCreateIssueOptions): Promise<GitLabIssue> {
    throw new Error(NO_ACTIONS_YET);
  }

  async createMergeRequest(_options: GitLabCreateMergeRequestOptions): Promise<GitLabMergeRequest> {
    throw new Error(NO_ACTIONS_YET);
  }

  async getIssue(id: string): Promise<GitLabIssue> {
    const details = await this.#gatekeeper.openIssue(id);
    await this.#approvalQueue.authorizeObservation({
      title: `Open issue #${details.id}: ${details.title}`,
      description: `Open a capability for issue #${details.id} in ${details.project.path}.`,
    });
    return new GitLabIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async getMergeRequest(id: string): Promise<GitLabMergeRequest> {
    const details = await this.#gatekeeper.openMergeRequest(id, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Open merge request !${details.id}: ${details.title}`,
      description: `Open a capability for merge request !${details.id} in ${details.project.path}.`,
    });
    return new GitLabMergeRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async listIssues(options?: GitLabIssueFilter): Promise<Cursor<GitLabIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List issues`,
      description: `List issues in the GitLab project.`,
    });
    return await this.#gatekeeper.listIssues(options, options?.resultsPerPage ?? 50);
  }

  async searchIssues(query: GitLabIssueSearch): Promise<Cursor<GitLabIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search issues for "${query.text}"`,
      description: `Search issues in the GitLab project for "${query.text}".`,
    });
    return await this.#gatekeeper.searchIssues(query, query.resultsPerPage ?? 50);
  }

  async listMergeRequests(options?: GitLabMergeRequestFilter): Promise<Cursor<GitLabMergeRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List merge requests`,
      description: `List merge requests in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listMergeRequests(
      options, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    // Simulated ids -- heads of queued pushes, which listings show as if already pushed -- are
    // withheld from advertising: they are not on GitLab yet, and the hint would outlive a
    // rejection. Checked live per page, since a push may be queued while the cursor is drained.
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, mr =>
      commitIdsOfMergeRequestSummary(mr).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async searchMergeRequests(query: GitLabMergeRequestSearch): Promise<Cursor<GitLabMergeRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search merge requests for "${query.text}"`,
      description: `Search merge requests in the GitLab project for "${query.text}".`,
    });
    const cursor = await this.#gatekeeper.searchMergeRequests(
      query, query.resultsPerPage ?? 50, await this.#gitCache.stub());
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, mr =>
      commitIdsOfMergeRequestSummary(mr).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async listBranches(options?: GitLabBranchFilter): Promise<Cursor<GitLabBranchSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List branches`,
      description: `List branches in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listBranches(options, options?.resultsPerPage ?? 50);
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, branch =>
      gatekeeper.isSimulatedCommitId(branch.headCommit) ? [] : [branch.headCommit]);
  }

  async listTags(options?: GitLabPageOptions): Promise<Cursor<GitLabTagSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List tags`,
      description: `List tags in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listTags(options?.resultsPerPage ?? 50);
    return await this.#gitCache.wrap(cursor, tag => [tag.commit]);
  }

  async resolveRef(ref?: string): Promise<string> {
    const { id, fromCache } = await this.#gatekeeper.resolveRef(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Resolve ${ref ?? "the default branch"} to a commit id`,
      description: `Resolve ${ref === undefined ? "the default branch" : `"${ref}"`}`
        + ` to commit ${id} in the GitLab project.`,
    });
    // A cache-served resolution is never advertised, for the same reasons as getCommit.
    if (!fromCache) {
      await this.#gitCache.advertise([id]);
    }
    return id;
  }

  async getCommit(ref?: string): Promise<GitLabCommitDetails> {
    const { details, fromCache } = await this.#gatekeeper.getCommit(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Read commit ${details.id.slice(0, 12)}`,
      description: `Read commit ${details.id}`
        + `${ref === undefined ? " (head of the default branch)"
          : ref === details.id ? "" : ` (resolved from "${ref}")`} in the GitLab project.`,
    });
    // A cache-served read is never advertised: either the commit was populated from this remote
    // in the first place (provenance already recorded) or it is part of a pending push (not on
    // the remote yet -- the hint would outlive a rejection).
    if (!fromCache) {
      await this.#gitCache.advertise(commitIdsOfSummary(details));
    }
    return details;
  }

  async push(_branch: string, _commitId: string, _options?: { force?: boolean }): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async listCommits(options?: GitLabCommitFilter): Promise<Cursor<GitLabCommitSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List commit history`,
      description: `List commits in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listCommits(
      options, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, item =>
      commitIdsOfSummary(item).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }
}

/**
 * The operations issues and merge requests share (`GitLabIssuable`). `getDetails()` is declared
 * on the concrete classes because the two detail types have incompatible `state` unions.
 */
@validateRpc()
export abstract class GitLabIssuableImpl extends RpcTarget implements GitLabIssuable {
  protected gatekeeper: GitLabGatekeeperImpl;
  protected approvalQueue: RpcStub<ApprovalQueue>;
  protected logicalId: string;
  protected kind: EntityKind;

  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string, kind: EntityKind) {
    super();
    this.gatekeeper = gatekeeper;
    this.approvalQueue = approvalQueue;
    this.logicalId = logicalId;
    this.kind = kind;
  }

  [Symbol.dispose](): void {
    (this.approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  /** `#42` for an issue, `!42` for a merge request -- how GitLab itself writes the reference. */
  protected reference(): string {
    return `${this.kind === "issue" ? "#" : "!"}${this.logicalId}`;
  }

  async setTitle(_title: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async setBody(_bodyMarkdown: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async addLabels(_labels: string[]): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async removeLabels(_labels: string[]): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async close(): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async reopen(): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async readDiscussion(options?: GitLabPageOptions): Promise<Cursor<GitLabDiscussionEntry>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read discussion for ${this.reference()}`,
      description: `Read the discussion thread for ${this.reference()}.`,
    });
    return await this.gatekeeper.issueDiscussion(this.kind, this.logicalId, options?.resultsPerPage ?? 50);
  }

  async postComment(_bodyMarkdown: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }
}

@validateRpc()
export class GitLabIssueImpl extends GitLabIssuableImpl implements GitLabIssue {
  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string) {
    super(gatekeeper, approvalQueue, logicalId, "issue");
  }

  async getDetails(): Promise<GitLabIssueDetails> {
    const details = await this.gatekeeper.openIssue(this.logicalId);
    await this.approvalQueue.authorizeObservation({
      title: `Read issue #${details.id}: ${details.title}`,
      description: `Read the full details of issue #${details.id} in ${details.project.path}.`,
    });
    return details;
  }
}

@validateRpc()
export class GitLabMergeRequestImpl extends GitLabIssuableImpl implements GitLabMergeRequest {
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string) {
    super(gatekeeper, approvalQueue, logicalId, "mergeRequest");
    this.#gitCache = new SessionGitCache(approvalQueue);
  }

  override [Symbol.dispose](): void {
    this.#gitCache.dispose();
    super[Symbol.dispose]();
  }

  async getDetails(): Promise<GitLabMergeRequestDetails> {
    const details = await this.gatekeeper.openMergeRequest(this.logicalId, await this.#gitCache.stub());
    await this.approvalQueue.authorizeObservation({
      title: `Read merge request !${details.id}: ${details.title}`,
      description: `Read the full details of merge request !${details.id} in ${details.project.path}.`,
    });
    // A provisional merge request may carry empty branch shas (advertise() skips them) or a
    // simulated head -- a queued push's commit, withheld because it is not on GitLab yet.
    await this.#gitCache.advertise(
      commitIdsOfMergeRequestSummary(details).filter(id => !this.gatekeeper.isSimulatedCommitId(id)));
    return details;
  }

  async readDiff(options?: GitLabPageOptions): Promise<GitLabMergeRequestDiff> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff for !${this.logicalId}`,
      description: `Read the diff for merge request !${this.logicalId}.`,
    });
    const diff = await this.gatekeeper.mergeRequestDiff(
      this.logicalId, options?.resultsPerPage ?? 20, await this.#gitCache.stub());
    await this.#gitCache.advertise(
      [diff.revision.baseSha, diff.revision.headSha, diff.revision.mergeBaseSha ?? ""]
        .filter(id => !this.gatekeeper.isSimulatedCommitId(id)));
    return diff;
  }

  async readDiffThreads(options?: GitLabPageOptions): Promise<Cursor<GitLabDiffThread>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff threads for !${this.logicalId}`,
      description: `Read diff discussion threads for merge request !${this.logicalId}.`,
    });
    return await this.gatekeeper.mergeRequestThreads(this.logicalId, options?.resultsPerPage ?? 20);
  }

  async postReview(_review: GitLabMergeRequestReviewDraft): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async replyToDiffComment(_commentId: string, _bodyMarkdown: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async resolveDiffThread(_threadId: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async unresolveDiffThread(_threadId: string): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async listCommits(options?: GitLabPageOptions): Promise<Cursor<GitLabCommitSummary>> {
    await this.approvalQueue.authorizeObservation({
      title: `List commits for !${this.logicalId}`,
      description: `List the commits of merge request !${this.logicalId}.`,
    });
    const cursor = await this.gatekeeper.mergeRequestCommits(
      this.logicalId, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    const gatekeeper = this.gatekeeper;
    return await this.#gitCache.wrap(cursor, item =>
      commitIdsOfSummary(item).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async getMergeBase(): Promise<string> {
    await this.approvalQueue.authorizeObservation({
      title: `Read merge base for !${this.logicalId}`,
      description: `Read the merge base commit of merge request !${this.logicalId}.`,
    });
    const mergeBase = await this.gatekeeper.mergeRequestMergeBase(this.logicalId, await this.#gitCache.stub());
    // A merge base is always a commit GitLab itself knows, so it advertises unconditionally.
    await this.#gitCache.advertise([mergeBase]);
    return mergeBase;
  }

  async merge(_options?: GitLabMergeRequestMergeOptions): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }
}
