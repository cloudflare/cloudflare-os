// The RPC sessions agents and gadgets talk to: one per bound resource kind. Every read records
// an observation and advertises the commit ids it returns to the workspace git cache; every
// write submits an action for approval, and the reads that only prepare one record nothing.
// Mirrors gatekeeper-github's session classes, including the carve-out that results served from
// the git cache rather than from the provider are never advertised.

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

const PUSH_NOT_YET = "GitLab push actions are not available in this build.";

/**
 * The page size a listing serves per `next()`: the caller's `resultsPerPage`, or the method's
 * default (50; 20 for the diff reads, whose rows are large). Checked once here, at the RPC
 * boundary -- every cursor-returning session method routes through it -- because the cursors
 * assume a positive integer: a zero page would make one cursor answer `[]` forever and another
 * `null` at once, hiding a non-empty result. Capped at one remote page (100), which is also the
 * most a `next()` buffers.
 */
function pageSize(options: GitLabPageOptions | undefined, fallback = 50): number {
  const requested = options?.resultsPerPage;
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("resultsPerPage must be a positive integer.");
  return Math.min(requested, 100);
}

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

  async createIssue(options: GitLabCreateIssueOptions): Promise<GitLabIssue> {
    const action = await this.#gatekeeper.prepareCreateIssue(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create issue ${options.title}`,
      description: `Create a new issue in ${action.projectPath} titled "${options.title}".`,
      implementsRevert: false,
    });
    return new GitLabIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId);
  }

  async createMergeRequest(options: GitLabCreateMergeRequestOptions): Promise<GitLabMergeRequest> {
    const action = await this.#gatekeeper.prepareCreateMergeRequest(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create merge request ${options.title}`,
      description: `Create a new merge request in ${action.projectPath} from ${options.sourceBranch} into ${options.targetBranch}.`,
      implementsRevert: false,
    });
    return new GitLabMergeRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId);
  }

  /**
   * Opening a capability is not an observation: the caller learns only that the number exists,
   * and the returned stub's getDetails() records the actual read.
   */
  async getIssue(id: string): Promise<GitLabIssue> {
    await this.#gatekeeper.openIssue(id);
    return new GitLabIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async getMergeRequest(id: string): Promise<GitLabMergeRequest> {
    await this.#gatekeeper.openMergeRequest(id, await this.#gitCache.stub());
    return new GitLabMergeRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async listIssues(options?: GitLabIssueFilter): Promise<Cursor<GitLabIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List issues`,
      description: `List issues in the GitLab project.`,
    });
    return await this.#gatekeeper.listIssues(options, pageSize(options));
  }

  async searchIssues(query: GitLabIssueSearch): Promise<Cursor<GitLabIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search issues for "${query.text}"`,
      description: `Search issues in the GitLab project for "${query.text}".`,
    });
    return await this.#gatekeeper.searchIssues(query, pageSize(query));
  }

  async listMergeRequests(options?: GitLabMergeRequestFilter): Promise<Cursor<GitLabMergeRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List merge requests`,
      description: `List merge requests in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listMergeRequests(
      options, pageSize(options), await this.#gitCache.stub());
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
      query, pageSize(query), await this.#gitCache.stub());
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, mr =>
      commitIdsOfMergeRequestSummary(mr).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async listBranches(options?: GitLabBranchFilter): Promise<Cursor<GitLabBranchSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List branches`,
      description: `List branches in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listBranches(options, pageSize(options));
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, branch =>
      gatekeeper.isSimulatedCommitId(branch.headCommit) ? [] : [branch.headCommit]);
  }

  async listTags(options?: GitLabPageOptions): Promise<Cursor<GitLabTagSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List tags`,
      description: `List tags in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listTags(pageSize(options));
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
    throw new Error(PUSH_NOT_YET);
  }

  async listCommits(options?: GitLabCommitFilter): Promise<Cursor<GitLabCommitSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List commit history`,
      description: `List commits in the GitLab project.`,
    });
    const cursor = await this.#gatekeeper.listCommits(
      options, pageSize(options), await this.#gitCache.stub());
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

  /**
   * `#42` for an issue, `!42` for a merge request -- how GitLab itself writes the reference.
   * `#`-private because a TypeScript `protected` method stays on the prototype, where Cap'n Web
   * would let the agent call it.
   */
  #reference(): string {
    return `${this.kind === "issue" ? "#" : "!"}${this.logicalId}`;
  }

  async setTitle(title: string): Promise<void> {
    const action = await this.gatekeeper.prepareSetTitle(this.kind, this.logicalId, title);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Rename ${this.#reference()}`,
      description: `Change the title from "${action.previousTitle}" to "${title}".`,
      implementsRevert: true,
    });
  }

  async setBody(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.prepareSetBody(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Edit description of ${this.#reference()}`,
      description: `Replace the Markdown description of ${this.#reference()}.`,
      implementsRevert: true,
    });
  }

  async addLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareAddLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Add labels to ${this.#reference()}`,
      description: `Add labels ${labels.join(", ")} to ${this.#reference()}.`,
      implementsRevert: true,
    });
  }

  async removeLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareRemoveLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Remove labels from ${this.#reference()}`,
      description: `Remove labels ${labels.join(", ")} from ${this.#reference()}.`,
      implementsRevert: true,
    });
  }

  async close(): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "closed");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Close ${this.#reference()}`,
      description: `Close ${this.#reference()}.`,
      implementsRevert: true,
    });
  }

  async reopen(): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "opened");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reopen ${this.#reference()}`,
      description: `Reopen ${this.#reference()}.`,
      implementsRevert: true,
    });
  }

  async readDiscussion(options?: GitLabPageOptions): Promise<Cursor<GitLabDiscussionEntry>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read discussion for ${this.#reference()}`,
      description: `Read the discussion thread for ${this.#reference()}.`,
    });
    return await this.gatekeeper.issueDiscussion(this.kind, this.logicalId, pageSize(options));
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.preparePostComment(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Comment on ${this.#reference()}`,
      description: `Post a new Markdown comment on ${this.#reference()}.`,
      implementsRevert: true,
    });
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
    // A provisional merge request may carry no branch shas, or a simulated head -- a queued
    // push's commit, withheld because it is not on GitLab yet.
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
      this.logicalId, pageSize(options, 20), await this.#gitCache.stub());
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
    return await this.gatekeeper.mergeRequestThreads(this.logicalId, pageSize(options, 20));
  }

  async postReview(review: GitLabMergeRequestReviewDraft): Promise<void> {
    const action = await this.gatekeeper.preparePostReview(this.logicalId, review);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Submit review for !${this.logicalId}`,
      description: `Submit a ${review.decision} review for merge request !${this.logicalId}` +
        `${review.diffComments?.length ? ` with ${review.diffComments.length} diff comment(s)` : ""}.`,
      implementsRevert: false,
    });
  }

  async replyToDiffComment(commentId: string, bodyMarkdown: string): Promise<void> {
    if (commentId.startsWith("~")) {
      throw new Error(
        "Replies to provisional diff comments are not supported until the parent review is approved and GitLab assigns real note IDs.");
    }
    const action = await this.gatekeeper.prepareReplyToDiffComment(this.logicalId, commentId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reply to diff thread on !${this.logicalId}`,
      description: `Reply to a diff discussion thread on merge request !${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async resolveDiffThread(threadId: string): Promise<void> {
    await this.#setThreadResolved(threadId, true);
  }

  async unresolveDiffThread(threadId: string): Promise<void> {
    await this.#setThreadResolved(threadId, false);
  }

  async #setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    if (threadId.startsWith("~")) {
      throw new Error("A provisional diff thread cannot be resolved until its review is approved.");
    }
    const action = await this.gatekeeper.prepareResolveDiffThread(this.logicalId, threadId, resolved);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `${resolved ? "Resolve" : "Reopen"} a diff thread on !${this.logicalId}`,
      description: `${resolved ? "Mark as resolved" : "Reopen"} a diff discussion thread on merge request !${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async listCommits(options?: GitLabPageOptions): Promise<Cursor<GitLabCommitSummary>> {
    await this.approvalQueue.authorizeObservation({
      title: `List commits for !${this.logicalId}`,
      description: `List the commits of merge request !${this.logicalId}.`,
    });
    const cursor = await this.gatekeeper.mergeRequestCommits(
      this.logicalId, pageSize(options), await this.#gitCache.stub());
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

  async merge(options?: GitLabMergeRequestMergeOptions): Promise<void> {
    const action = await this.gatekeeper.prepareMergeMergeRequest(this.logicalId, options);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Merge merge request !${this.logicalId}`,
      description: `Merge merge request !${this.logicalId} at its current head ${action.expectedHeadSha}` +
        `${options?.squash ? ", squashing its commits" : ""}` +
        `${options?.removeSourceBranch ? " and deleting the source branch" : ""}.` +
        " The merge is refused if the head has moved by the time it applies.",
      implementsRevert: false,
    });
  }
}
