// The RPC sessions agents and gadgets talk to: one per bound resource kind, plus the pipeline and
// job capabilities they open. Every read authorizes an observation through the gatekeeper, which
// reports the subresource it depends on (see GitLabGatekeeperImpl.authorizeRead), a listing each
// page as it leaves, and advertises the commit ids it returns to the workspace git cache; every
// write submits an action for approval, and the reads that only prepare one record nothing. Mirrors
// gatekeeper-github's session classes, including the carve-out that results served from the git
// cache rather than from the provider are never advertised. CI reads advertise nothing: a
// pipeline's commit may be GitLab's merge commit for a merge request, or a fork's, neither of which
// this project's branches reach.
//
// A project's code-only reads -- code search, files, branches, tags, refs, commit history, and its
// metadata -- report its repository (`repository/<id>`), which a collaborator who can download the
// code may see without being a member; everything else reports the project (see
// project-subresources.ts). Metadata of a project whose repository is disabled reports the project
// too, since nobody may download its code (see metadataSubresourceId). `getCommit` reports the
// project, since its answer carries CI. Code search and file reads go through gitlab-code.ts, as an
// instance binding's do; they read GitLab as it is, without the queued pushes a worktree mounted
// from this project would show. Of those, only `readFile` advertises: the commit it read at.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor, GitOid, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { SessionGitCache } from "@gadgets/gatekeeper-kit/cursors";
import { advertisePages, commitIdsOfSummary, isCommitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { validateBranchName } from "@gadgets/gatekeeper-kit/git-transport";
import type { EntityKind } from "./gitlab-action-types";
import { PagerCursor, ObservedCursor } from "./gitlab-cursors";
import { CodeSearchPager, RepositoryTreePager, queueAuthorizer, readRepositoryFile } from "./gitlab-code";
import type { GitLabGatekeeperImpl } from "./gitlab-gatekeeper";
import { commitIdsOfMergeRequestSummary } from "./gitlab-normalize";
import type {
  GitLabBranchFilter,
  GitLabBranchSummary,
  GitLabCodeHit,
  GitLabCommitDetails,
  GitLabCommitFilter,
  GitLabCommitSummary,
  GitLabFileContent,
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
  GitLabJob,
  GitLabJobDetails,
  GitLabJobFilter,
  GitLabJobSummary,
  GitLabListFilesOptions,
  GitLabLogOptions,
  GitLabLogPage,
  GitLabMergeRequest,
  GitLabMergeRequestDetails,
  GitLabMergeRequestDiff,
  GitLabMergeRequestFilter,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
  GitLabMergeRequestSearch,
  GitLabMergeRequestSummary,
  GitLabPageOptions,
  GitLabPipeline,
  GitLabPipelineDetails,
  GitLabPipelineFilter,
  GitLabPipelineSummary,
  GitLabProject,
  GitLabProjectCodeSearch,
  GitLabProjectMetadata,
  GitLabReadFileOptions,
  GitLabTagSummary,
  GitLabTestCase,
  GitLabTestReportSummary,
  GitLabTreeEntry,
} from "./types";

/**
 * The page size a listing serves per `next()`: the caller's `resultsPerPage`, or the method's
 * default (50; 20 for the diff reads, whose rows are large). Checked once here, at the RPC
 * boundary -- every cursor-returning session method routes through it -- because the cursors
 * assume a positive integer: a zero page would make one cursor answer `[]` forever and another
 * `null` at once, hiding a non-empty result. Capped at one remote page (100), which is also the
 * most a `next()` buffers.
 */
export function pageSize(options: GitLabPageOptions | undefined, fallback = 50): number {
  const requested = options?.resultsPerPage;
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("resultsPerPage must be a positive integer.");
  return Math.min(requested, 100);
}

/**
 * `cursor`, a listing the gatekeeper built, with each page authorized as `observation` describes
 * the listing (see GitLabGatekeeperImpl.authorizeRead and ObservedCursor), reporting `subresource`
 * when the listing chose one as it fetched its data, and then, with `advertising`, the commit ids
 * on it advertised, withholding simulated ones as SessionGitCache does. The cursor holds its own
 * duplicates of the session's stubs, so it keeps working if the session is disposed before it is
 * drained.
 */
async function observedListing<T>(
  gatekeeper: Pick<GitLabGatekeeperImpl, "authorizeRead" | "isSimulatedCommitId">,
  approvalQueue: RpcStub<ApprovalQueue>, cursor: Cursor<T>,
  observation: Omit<ObservationDescription, "subresources">,
  options: {
    subresource?: string;
    advertising?: { gitCache: SessionGitCache; commitIds: (item: T) => readonly GitOid[] };
  } = {},
): Promise<Cursor<T>> {
  const { subresource, advertising } = options;
  const cache = advertising && (await advertising.gitCache.stub()).dup();
  const queue = approvalQueue.dup();
  return new ObservedCursor(cursor, {
    authorize: page => gatekeeper.authorizeRead(queue, page === 1
      ? observation
      : { ...observation, title: `${observation.title} (page ${page})` }, subresource),
    advertise: cache && advertisePages(cache, advertising.commitIds,
      { withhold: id => gatekeeper.isSimulatedCommitId(id) }),
    release: () => {
      queue[Symbol.dispose]();
      cache?.[Symbol.dispose]();
    },
  });
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
    this.#gitCache = new SessionGitCache(approvalQueue, { withhold: id => gatekeeper.isSimulatedCommitId(id) });
  }

  [Symbol.dispose](): void {
    this.#gitCache.dispose();
    (this.#approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getMetadata(): Promise<GitLabProjectMetadata> {
    const metadata = await this.#gatekeeper.projectMetadata();
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Read project metadata for ${metadata.path}`,
      description: `Read basic metadata for the GitLab project ${metadata.path}.`,
    }, await this.#gatekeeper.metadataSubresource());
    return metadata;
  }

  async searchCode(query: GitLabProjectCodeSearch): Promise<Cursor<GitLabCodeHit>> {
    const { context, ...project } = await this.#gatekeeper.codeTarget();
    const queue = this.#approvalQueue.dup();
    return new PagerCursor(new CodeSearchPager(context, queueAuthorizer(queue), { kind: "project", query, ...project }),
      () => queue[Symbol.dispose]());
  }

  /**
   * Advertises the commit the file was read at once the read is authorized, so it can be mounted
   * as a worktree. Read from GitLab (or kept from such a read), it is never a simulated one.
   */
  async readFile(path: string, options?: GitLabReadFileOptions): Promise<GitLabFileContent> {
    const { context, ...project } = await this.#gatekeeper.codeTarget();
    const file = await readRepositoryFile(context, queueAuthorizer(this.#approvalQueue), project, path, options);
    await this.#gitCache.advertise([file.commitId]);
    return file;
  }

  async listFiles(options?: GitLabListFilesOptions): Promise<Cursor<GitLabTreeEntry>> {
    const size = pageSize(options, 100);
    const { context, ...project } = await this.#gatekeeper.codeTarget();
    const queue = this.#approvalQueue.dup();
    return new PagerCursor(new RepositoryTreePager(context, queueAuthorizer(queue), project, {
      ...(options?.ref === undefined ? {} : { ref: options.ref }),
      ...(options?.path === undefined ? {} : { path: options.path }),
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      pageSize: size,
    }), () => queue[Symbol.dispose]());
  }

  async createIssue(options: GitLabCreateIssueOptions): Promise<GitLabIssue> {
    const action = await this.#gatekeeper.prepareCreateIssue(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create issue ${options.title}`,
      implementsRevert: false,
    });
    return new GitLabIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId);
  }

  async createMergeRequest(options: GitLabCreateMergeRequestOptions): Promise<GitLabMergeRequest> {
    const action = await this.#gatekeeper.prepareCreateMergeRequest(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create merge request ${options.title}`,
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
    return await observedListing(this.#gatekeeper, this.#approvalQueue,
      await this.#gatekeeper.listIssues(options, pageSize(options)), {
        title: `List issues`,
        description: `List issues in the GitLab project.`,
      });
  }

  async searchIssues(query: GitLabIssueSearch): Promise<Cursor<GitLabIssueSummary>> {
    return await observedListing(this.#gatekeeper, this.#approvalQueue,
      await this.#gatekeeper.searchIssues(query, pageSize(query)), {
        title: `Search issues for "${query.text}"`,
        description: `Search issues in the GitLab project for "${query.text}".`,
      });
  }

  async listMergeRequests(options?: GitLabMergeRequestFilter): Promise<Cursor<GitLabMergeRequestSummary>> {
    const cursor = await this.#gatekeeper.listMergeRequests(
      options, pageSize(options), await this.#gitCache.stub());
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cursor, {
      title: `List merge requests`,
      description: `List merge requests in the GitLab project.`,
    }, { advertising: { gitCache: this.#gitCache, commitIds: commitIdsOfMergeRequestSummary } });
  }

  async searchMergeRequests(query: GitLabMergeRequestSearch): Promise<Cursor<GitLabMergeRequestSummary>> {
    const cursor = await this.#gatekeeper.searchMergeRequests(
      query, pageSize(query), await this.#gitCache.stub());
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cursor, {
      title: `Search merge requests for "${query.text}"`,
      description: `Search merge requests in the GitLab project for "${query.text}".`,
    }, { advertising: { gitCache: this.#gitCache, commitIds: commitIdsOfMergeRequestSummary } });
  }

  async listBranches(options?: GitLabBranchFilter): Promise<Cursor<GitLabBranchSummary>> {
    const cursor = await this.#gatekeeper.listBranches(options, pageSize(options));
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cursor, {
      title: `List branches`,
      description: `List branches in the GitLab project.`,
    }, {
      subresource: await this.#gatekeeper.repositorySubresource(),
      advertising: { gitCache: this.#gitCache, commitIds: branch => [branch.headCommit] },
    });
  }

  async listTags(options?: GitLabPageOptions): Promise<Cursor<GitLabTagSummary>> {
    const cursor = await this.#gatekeeper.listTags(pageSize(options));
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cursor, {
      title: `List tags`,
      description: `List tags in the GitLab project.`,
    }, {
      subresource: await this.#gatekeeper.repositorySubresource(),
      advertising: { gitCache: this.#gitCache, commitIds: tag => [tag.commit] },
    });
  }

  async resolveRef(ref?: string): Promise<string> {
    const { id, fromCache } = await this.#gatekeeper.resolveRef(ref, await this.#gitCache.stub());
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Resolve ${ref ?? "the default branch"} to a commit id`,
      description: `Resolve ${ref === undefined ? "the default branch" : `"${ref}"`}`
        + ` to commit ${id} in the GitLab project.`,
    }, await this.#gatekeeper.repositorySubresource());
    // A cache-served resolution is never advertised, for the same reasons as getCommit.
    if (!fromCache) {
      await this.#gitCache.advertise([id]);
    }
    return id;
  }

  async getCommit(ref?: string): Promise<GitLabCommitDetails> {
    const { details, fromCache } = await this.#gatekeeper.getCommit(ref, await this.#gitCache.stub());
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
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

  async push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void> {
    validateBranchName(branch);
    if (!isCommitOid(commitId)) {
      throw new Error(
        `push() requires a full 40-character commit id; got ${JSON.stringify(commitId)}. ` +
        `Use resolveRef() to resolve a truncated id.`);
    }
    const action = await this.#gatekeeper.preparePush(branch, commitId, options?.force ?? false, await this.#gitCache.stub());
    if (action === null) return;  // the branch is already at commitId: nothing to do
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Push ${commitId.slice(0, 12)} to ${branch}`,
      pushedCommits: [commitId],
      implementsRevert: true,
    });
  }

  async listCommits(options?: GitLabCommitFilter): Promise<Cursor<GitLabCommitSummary>> {
    const cursor = await this.#gatekeeper.listCommits(
      options, pageSize(options), await this.#gitCache.stub());
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cursor, {
      title: `List commit history`,
      description: `List commits in the GitLab project.`,
    }, {
      subresource: await this.#gatekeeper.repositorySubresource(),
      advertising: { gitCache: this.#gitCache, commitIds: commitIdsOfSummary },
    });
  }

  async listPipelines(options?: GitLabPipelineFilter): Promise<Cursor<GitLabPipelineSummary>> {
    return await observedListing(this.#gatekeeper, this.#approvalQueue,
      await this.#gatekeeper.listProjectPipelines(options, pageSize(options)), {
        title: `List pipelines`,
        description: `List CI pipelines in the GitLab project.`,
      });
  }

  /** Opening is not an observation, as for `getIssue`: the stub's reads record theirs. */
  async getPipeline(id: string): Promise<GitLabPipeline> {
    const pipelineId = await this.#gatekeeper.openProjectPipeline(id);
    return new GitLabPipelineImpl(this.#gatekeeper, this.#approvalQueue.dup(), pipelineId);
  }

  async getJob(id: string): Promise<GitLabJob> {
    const jobId = await this.#gatekeeper.openProjectJob(id);
    return new GitLabJobImpl(this.#gatekeeper, this.#approvalQueue.dup(), jobId);
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
      implementsRevert: true,
    });
  }

  async setBody(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.prepareSetBody(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Edit description of ${this.#reference()}`,
      implementsRevert: true,
    });
  }

  async addLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareAddLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Add labels to ${this.#reference()}`,
      implementsRevert: true,
    });
  }

  async removeLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareRemoveLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Remove labels from ${this.#reference()}`,
      implementsRevert: true,
    });
  }

  async close(): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "closed");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Close ${this.#reference()}`,
      implementsRevert: true,
    });
  }

  async reopen(): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "opened");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reopen ${this.#reference()}`,
      implementsRevert: true,
    });
  }

  async readDiscussion(options?: GitLabPageOptions): Promise<Cursor<GitLabDiscussionEntry>> {
    return await observedListing(this.gatekeeper, this.approvalQueue,
      await this.gatekeeper.issueDiscussion(this.kind, this.logicalId, pageSize(options)), {
        title: `Read discussion for ${this.#reference()}`,
        description: `Read the discussion thread for ${this.#reference()}.`,
      });
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.preparePostComment(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Comment on ${this.#reference()}`,
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
    await this.gatekeeper.authorizeRead(this.approvalQueue, {
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
    this.#gitCache = new SessionGitCache(approvalQueue, { withhold: id => gatekeeper.isSimulatedCommitId(id) });
  }

  override [Symbol.dispose](): void {
    this.#gitCache.dispose();
    super[Symbol.dispose]();
  }

  async getDetails(): Promise<GitLabMergeRequestDetails> {
    const details = await this.gatekeeper.mergeRequestDetails(this.logicalId, await this.#gitCache.stub());
    await this.gatekeeper.authorizeRead(this.approvalQueue, {
      title: `Read merge request !${details.id}: ${details.title}`,
      description: `Read the full details of merge request !${details.id} in ${details.project.path}.`,
    });
    // A provisional merge request may carry no branch shas, or a simulated head (withheld).
    await this.#gitCache.advertise(commitIdsOfMergeRequestSummary(details));
    return details;
  }

  async readDiff(options?: GitLabPageOptions): Promise<GitLabMergeRequestDiff> {
    await this.gatekeeper.authorizeRead(this.approvalQueue, {
      title: `Read diff for !${this.logicalId}`,
      description: `Read the diff for merge request !${this.logicalId}.`,
    });
    const diff = await this.gatekeeper.mergeRequestDiff(
      this.logicalId, pageSize(options, 20), await this.#gitCache.stub());
    await this.#gitCache.advertise([diff.revision.baseSha, diff.revision.headSha, diff.revision.mergeBaseSha ?? ""]);
    return {
      ...diff,
      files: await observedListing(this.gatekeeper, this.approvalQueue, diff.files, {
        title: `Read changed files of !${this.logicalId}`,
        description: `Read the changed files and their patches in the diff of merge request !${this.logicalId}.`,
      }),
    };
  }

  async readDiffThreads(options?: GitLabPageOptions): Promise<Cursor<GitLabDiffThread>> {
    return await observedListing(this.gatekeeper, this.approvalQueue,
      await this.gatekeeper.mergeRequestThreads(this.logicalId, pageSize(options, 20)), {
        title: `Read diff threads for !${this.logicalId}`,
        description: `Read diff discussion threads for merge request !${this.logicalId}.`,
      });
  }

  async postReview(review: GitLabMergeRequestReviewDraft): Promise<void> {
    const action = await this.gatekeeper.preparePostReview(this.logicalId, review);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Submit review for !${this.logicalId}`,
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
      implementsRevert: true,
    });
  }

  async listCommits(options?: GitLabPageOptions): Promise<Cursor<GitLabCommitSummary>> {
    const cursor = await this.gatekeeper.mergeRequestCommits(
      this.logicalId, pageSize(options), await this.#gitCache.stub());
    return await observedListing(this.gatekeeper, this.approvalQueue, cursor, {
      title: `List commits for !${this.logicalId}`,
      description: `List the commits of merge request !${this.logicalId}.`,
    }, { advertising: { gitCache: this.#gitCache, commitIds: commitIdsOfSummary } });
  }

  async getMergeBase(): Promise<string> {
    await this.gatekeeper.authorizeRead(this.approvalQueue, {
      title: `Read merge base for !${this.logicalId}`,
      description: `Read the merge base commit of merge request !${this.logicalId}.`,
    });
    const mergeBase = await this.gatekeeper.mergeRequestMergeBase(this.logicalId, await this.#gitCache.stub());
    // A merge base is always a commit GitLab itself knows.
    await this.#gitCache.advertise([mergeBase]);
    return mergeBase;
  }

  async merge(options?: GitLabMergeRequestMergeOptions): Promise<void> {
    const action = await this.gatekeeper.prepareMergeMergeRequest(this.logicalId, options);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Merge merge request !${this.logicalId}`,
      implementsRevert: false,
    });
  }

  async listPipelines(options?: GitLabPageOptions): Promise<Cursor<GitLabPipelineSummary>> {
    return await observedListing(this.gatekeeper, this.approvalQueue,
      await this.gatekeeper.mergeRequestPipelines(this.logicalId, pageSize(options)), {
        title: `List pipelines for !${this.logicalId}`,
        description: `List the CI pipelines of merge request !${this.logicalId}.`,
      });
  }

  async getPipeline(id?: string): Promise<GitLabPipeline> {
    const pipelineId = await this.gatekeeper.openMergeRequestPipeline(this.logicalId, id, await this.#gitCache.stub());
    return new GitLabPipelineImpl(this.gatekeeper, this.approvalQueue.dup(), pipelineId);
  }

  async getJob(id: string): Promise<GitLabJob> {
    const jobId = await this.gatekeeper.openMergeRequestJob(this.logicalId, id);
    return new GitLabJobImpl(this.gatekeeper, this.approvalQueue.dup(), jobId);
  }
}

/**
 * A pipeline of the bound project, opened by a project or merge request session (which checked
 * it may be opened), over its own duplicate of that session's approval queue. Its test reports
 * report the subresource the gatekeeper chose as it fetched them.
 */
@validateRpc()
export class GitLabPipelineImpl extends RpcTarget implements GitLabPipeline {
  #gatekeeper: GitLabGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pipelineId: number;

  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, pipelineId: number) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
    this.#pipelineId = pipelineId;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getDetails(): Promise<GitLabPipelineDetails> {
    const details = await this.#gatekeeper.pipelineDetails(this.#pipelineId);
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Read pipeline #${this.#pipelineId}`,
      description: `Read the details of CI pipeline #${this.#pipelineId} (${details.status}, on ${details.ref}).`,
    });
    return details;
  }

  async listJobs(options?: GitLabJobFilter): Promise<Cursor<GitLabJobSummary>> {
    return await observedListing(this.#gatekeeper, this.#approvalQueue,
      await this.#gatekeeper.pipelineJobs(this.#pipelineId, options, pageSize(options)), {
        title: `List jobs of pipeline #${this.#pipelineId}`,
        description: `List the jobs of CI pipeline #${this.#pipelineId}` +
          `${options?.status === undefined ? "" : ` with status ${options.status.join(", ")}`}.`,
      });
  }

  async getDownstreamPipeline(id: string): Promise<GitLabPipeline> {
    const pipelineId = await this.#gatekeeper.openDownstreamPipeline(this.#pipelineId, id);
    return new GitLabPipelineImpl(this.#gatekeeper, this.#approvalQueue.dup(), pipelineId);
  }

  async getTestReport(): Promise<GitLabTestReportSummary> {
    const { subresource, report } = await this.#gatekeeper.pipelineTestReport(this.#pipelineId);
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Read test report of pipeline #${this.#pipelineId}`,
      description: `Read the unit test totals of CI pipeline #${this.#pipelineId}: ` +
        `${report.total} tests, ${report.failed} failed, ${report.errored} errored.`,
    }, subresource);
    return report;
  }

  async listFailedTests(options?: GitLabPageOptions): Promise<Cursor<GitLabTestCase>> {
    const { subresource, cases } = await this.#gatekeeper.pipelineFailedTests(this.#pipelineId, pageSize(options));
    return await observedListing(this.#gatekeeper, this.#approvalQueue, cases, {
      title: `Read failed tests of pipeline #${this.#pipelineId}`,
      description: `Read the failed and errored test cases, with their output, from CI pipeline #${this.#pipelineId}'s test reports.`,
    }, { subresource });
  }
}

/**
 * A job run by a runner in the bound project, opened by a project or merge request session, over
 * its own duplicate of that session's approval queue. Its log reports the Developer role.
 */
@validateRpc()
export class GitLabJobImpl extends RpcTarget implements GitLabJob {
  #gatekeeper: GitLabGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #jobId: number;

  constructor(gatekeeper: GitLabGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, jobId: number) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
    this.#jobId = jobId;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getDetails(): Promise<GitLabJobDetails> {
    const details = await this.#gatekeeper.jobDetails(this.#jobId);
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Read job \`${details.name}\` #${this.#jobId}`,
      description: `Read the details of CI job \`${details.name}\` #${this.#jobId} (${details.status}).`,
    });
    return details;
  }

  async readLog(options?: GitLabLogOptions): Promise<GitLabLogPage> {
    const { jobName, page, subresource } = await this.#gatekeeper.readJobLog(this.#jobId, options);
    const first = page.lines[0]?.number;
    const last = page.lines.at(-1)?.number;
    const range = first === undefined ? "no lines" : `lines ${first}–${last}`;
    const search = options?.search === undefined ? "" : ` matching "${options.search}"`;
    await this.#gatekeeper.authorizeRead(this.#approvalQueue, {
      title: `Read log of job \`${jobName}\` #${this.#jobId}, ${range}`,
      description: `Read ${range}${search} of the log of CI job \`${jobName}\` #${this.#jobId} (${page.totalLines} lines in all).`,
    }, subresource);
    return page;
  }
}
