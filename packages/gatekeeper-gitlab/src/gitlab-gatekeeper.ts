// The per-binding gatekeeper Durable Object for GitLab: one instance per (account, project |
// issue | merge request) binding. It caches remote reads, records queued actions and overlays
// them onto everything it returns (so a caller sees the world as if its queued work had landed),
// and mints the sessions agents talk to. Mirrors gatekeeper-github's `GitHubGatekeeperImpl`.
//
// Git operations follow plans/worktrees.md §3 verbatim: every commit id a read returns is
// advertised by the session, `gitPull` is smart-HTTP protocol v2 through the kit's transport,
// `push` binds its expected old head at queue time and applies through receive-pack's
// compare-and-swap, and reads of a branch with queued pushes show the world as if they had landed.

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ActionDescription,
  type ApprovalQueue,
  type Cursor,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type GitCache,
  type GitOid,
  type GitPullHints,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  MAX_DIFF_BLOB_BYTES,
  changedPathsBetweenTrees,
  diffGitTrees,
  parseGitTreePayload,
  type GitDiffFile,
  type TreeDiffSource,
} from "@gadgets/gatekeeper-kit/git-diff";
import { commitDetailsFromGitObject, isCommitOid, parseGitCommitPayload } from "@gadgets/gatekeeper-kit/git-objects";
import {
  GitRefUpdateRejectedError,
  ZERO_OID,
  emptyPackBytes,
  pullGitObjectsIntoCache,
  pushGitRefUpdate,
} from "@gadgets/gatekeeper-kit/git-transport";
import {
  GitLabApi,
  GitLabApiError,
  lineCode,
  type GitLabDiffResponse,
  type GitLabDiscussionResponse,
  type GitLabMergeRequestResponse,
  type GitLabPositionRequest,
  type GitLabSimpleUser,
} from "./gitlab-api";
import {
  apiKind,
  type AddLabelsAction,
  type Cached,
  type ChangeStateAction,
  type CreateIssueAction,
  type CreateMergeRequestAction,
  type EntityKind,
  type GitLabAction,
  type GitLabRevertInfo,
  type MergeMergeRequestAction,
  type PostCommentAction,
  type PostReviewAction,
  type PushAction,
  type RemoveLabelsAction,
  type ReplyToDiffCommentAction,
  type ResolveDiffThreadAction,
  type SetBodyAction,
  type SetTitleAction,
  type StoredActionRecord,
  type StoredProvisionalResource,
} from "./gitlab-action-types";
import {
  VENDOR_ID,
  gitlabInstance,
  instanceUrl as instanceUrlOf,
  type Env,
  type GitLabGatekeeperImplProps,
} from "./gitlab-env";
import {
  actorFromUser,
  actorFromUsername,
  commentTargetFromPosition,
  dedupeLabels,
  diffLinePositions,
  discussionCommentFromNote,
  isDiscussionComment,
  type GitLabDiscussionCommentEntry,
  issueMatchesFilter,
  issueMatchesSearch,
  issueOrder,
  issueUrl,
  issuableComparator,
  mergeRequestMatchesFilter,
  mergeRequestMatchesSearch,
  mergeRequestOrder,
  mergeRequestUrl,
  normalizeBranchSummary,
  normalizeCommitDetails,
  normalizeCommitSummary,
  normalizeDiffFile,
  normalizeIssueDetails,
  normalizeIssueSummary,
  normalizeMergeRequestDetails,
  normalizeMergeRequestSummary,
  normalizeProjectMetadata,
  normalizeTagSummary,
  projectRef,
  revisionFromDiffRefs,
  stableKey,
  summarizeIssueDetails,
  summarizeMergeRequestDetails,
  textSnippet,
  withDraftPrefix,
} from "./gitlab-normalize";
import { ArrayCursor, StreamingCursor } from "./gitlab-cursors";
import { GitLabIssueImpl, GitLabMergeRequestImpl, GitLabProjectSessionImpl } from "./gitlab-sessions";
import type {
  GitLabActor,
  GitLabBranchFilter,
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCommitFilter,
  GitLabCommitSummary,
  GitLabCreateIssueOptions,
  GitLabCreateMergeRequestOptions,
  GitLabDiffCommentTarget,
  GitLabDiffThread,
  GitLabDiscussionEntry,
  GitLabIssue,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSearch,
  GitLabIssueState,
  GitLabIssueSummary,
  GitLabMergeRequest,
  GitLabMergeRequestDetails,
  GitLabMergeRequestFilter,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
  GitLabMergeRequestRevision,
  GitLabMergeRequestSearch,
  GitLabMergeRequestSummary,
  GitLabProject,
  GitLabProjectMetadata,
  GitLabProjectRef,
  GitLabTagSummary,
} from "./types";
import TYPES_CODE from "./types.txt";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.gitlab", vendorId: VENDOR_ID });

export const ENTITY_CACHE_TTL_MS = 30 * 1000;
export const LIST_CACHE_TTL_MS = 15 * 1000;
/** For values that are pure functions of immutable inputs (a merge base keyed by both shas). */
const IMMUTABLE_CACHE_TTL_MS = Infinity;
const VIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
/** `diff_refs` populate asynchronously after an MR is created; one short retry covers the gap. */
const DIFF_REFS_RETRY_DELAY_MS = 1500;

const RECONNECT_MESSAGE = "GitLab credentials have expired or been revoked. Please reconnect the account.";
/** Cap on the queued-but-not-yet-pushed commits walked when simulating a branch's history. */
const MAX_PENDING_CHAIN_COMMITS = 250;
/** Bound on following a chain of not-yet-applied replies back to a real thread. */
const MAX_REPLY_TARGET_HOPS = 50;

type StoredViewer = { actor: GitLabActor; fetchedAt: number };

/**
 * A `target...source` merge request comparison computed as if the source branch's queued pushes
 * had already landed (see `#simulatedMergeRequestComparison`). `pendingCommitIds` are the commits
 * that are not on GitLab yet -- sessions must not advertise them.
 */
type SimulatedMergeRequestComparison = {
  revision: GitLabMergeRequestRevision;
  files: GitDiffFile[];
  totalCommits: number;
  /** Oldest-first: GitLab's compare commits, then the pending chain. */
  commitSummaries: GitLabCommitSummary[];
  pendingCommitIds: GitOid[];
};

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Label names are unique case-insensitively on GitLab, as the overlay treats them. */
function hasLabel(labels: string[], name: string): boolean {
  return labels.some(label => label.toLowerCase() === name.toLowerCase());
}

@validateRpc()
export class GitLabGatekeeperImpl extends DurableObject<Env, GitLabGatekeeperImplProps>
  implements Gatekeeper<GitLabProject | GitLabIssue | GitLabMergeRequest> {

  #pendingActionsCache?: GitLabAction[];

  /**
   * Commit ids this instance has served from the workspace git cache as part of simulating
   * queued pushes. Session advertising callbacks consult it (via `isSimulatedCommitId`) to
   * withhold these ids: they are not on GitLab yet, so advertising one would record a wrong
   * pull-routing hint that outlives a rejection. In-memory only -- entries are always recorded
   * in the same call that returns the ids, so a restart cannot leak an unfiltered id.
   */
  #servedSimulatedCommitIds = new Set<GitOid>();

  // -- identity ---------------------------------------------------------------------------

  #props(): GitLabGatekeeperImplProps {
    const props = this.ctx.props;
    // A binding created by the incubating gatekeeper this package replaced carried different
    // props; it cannot be served and says so rather than misbehaving.
    if (!props || typeof props.projectPath !== "string" || !props.resourceKind) {
      throw new Error("This GitLab connection was created by an earlier version. Please remove it and connect the project again.");
    }
    return props;
  }

  #projectPath(): string {
    return this.#props().projectPath;
  }

  #instanceUrl(): string {
    return instanceUrlOf(this.env);
  }

  #projectRef(): GitLabProjectRef {
    return projectRef(this.#instanceUrl(), this.#projectPath());
  }

  #userAccount() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.#props().userObjectId));
  }

  async #withApi<T>(fn: (api: GitLabApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new GitLabApi(gitlabInstance(this.env), async () => await account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof GitLabApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error(RECONNECT_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  // -- caches -----------------------------------------------------------------------------

  #cacheKey(kind: string, ...parts: string[]): string {
    return ["cache", kind, ...parts].join(":");
  }

  #cacheGeneration(): number {
    return this.ctx.storage.kv.get<number>("cacheGeneration") ?? 0;
  }

  #loadCached<T>(key: string, ttlMs: number): T | undefined {
    const cached = this.ctx.storage.kv.get<Cached<T>>(key);
    if (!cached) return undefined;
    if (cached.generation !== this.#cacheGeneration()) return undefined;
    if (Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    return cached.value;
  }

  /**
   * Store under the generation the value was *fetched* in. A loader awaits the network, and an
   * `applyAction` on this object can run to completion in that gap and bump the generation; a
   * value fetched before the mutation must not then be stored as if it reflected it, or the next
   * 30 s of reads would show the state the agent just changed. Such a value is returned to its
   * caller (it was a valid read when made) but not cached.
   */
  #storeCached<T>(key: string, value: T, generation = this.#cacheGeneration()): void {
    if (generation !== this.#cacheGeneration()) return;
    this.ctx.storage.kv.put<Cached<T>>(key, { fetchedAt: Date.now(), value, generation });
  }

  /** TTL cache: GitLab's REST API does not reliably answer conditional requests, so there is no ETag path. */
  async #cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.#loadCached<T>(key, ttlMs);
    if (cached !== undefined) return cached;
    const generation = this.#cacheGeneration();
    const value = await loader();
    this.#storeCached(key, value, generation);
    return value;
  }

  #clearCaches(): void {
    this.ctx.storage.kv.put("cacheGeneration", this.#cacheGeneration() + 1);
  }

  async #fetchAllPages<T>(loader: (page: number, perPage: number) => Promise<T[]>): Promise<T[]> {
    const results: T[] = [];
    const perPage = 100;
    for (let page = 1; ; page += 1) {
      const batch = await loader(page, perPage);
      results.push(...batch);
      if (batch.length < perPage) break;
    }
    return results;
  }

  // -- queued actions (read side) ---------------------------------------------------------

  #listPendingActions(): GitLabAction[] {
    if (!this.#pendingActionsCache) {
      this.#pendingActionsCache = [...this.ctx.storage.kv.list<StoredActionRecord>({ prefix: "action:" })]
        .map(([, value]) => value)
        .filter(record => record.state === "pending")
        .map(record => record.action)
        .toSorted((a, b) => a.submittedAt - b.submittedAt);
    }
    return this.#pendingActionsCache;
  }

  #getProvisionalResource(id: string): StoredProvisionalResource | undefined {
    return this.ctx.storage.kv.get<StoredProvisionalResource>(`provisional:${id}`);
  }

  #resolveProvisionalId(id: string): string | undefined {
    return this.#getProvisionalResource(id)?.realId;
  }

  #entityIdMatches(targetId: string, logicalId: string): boolean {
    if (targetId === logicalId) return true;
    const targetResolved = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
    const logicalResolved = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    return !!targetResolved && !!logicalResolved && targetResolved === logicalResolved;
  }

  #pendingActionsForEntity(kind: EntityKind, logicalId: string): GitLabAction[] {
    return this.#listPendingActions().filter(action => {
      switch (action.type) {
        case "createIssue":
        case "createMergeRequest":
        case "push":
          return false;
        case "postReview":
        case "replyToDiffComment":
        case "resolveDiffThread":
        case "mergeMergeRequest":
          return kind === "mergeRequest" && this.#entityIdMatches(action.mergeRequestId, logicalId);
        default:
          return action.targetKind === kind && this.#entityIdMatches(action.targetId, logicalId);
      }
    });
  }

  #findCreateAction(id: string, kind: "issue"): CreateIssueAction | undefined;
  #findCreateAction(id: string, kind: "mergeRequest"): CreateMergeRequestAction | undefined;
  #findCreateAction(id: string, kind: EntityKind): CreateIssueAction | CreateMergeRequestAction | undefined {
    return this.#listPendingActions().find(action =>
      (kind === "issue" ? action.type === "createIssue" : action.type === "createMergeRequest") &&
      (action as CreateIssueAction | CreateMergeRequestAction).provisionalId === id,
    ) as CreateIssueAction | CreateMergeRequestAction | undefined;
  }

  /** Real ids of existing entities with queued mutations, so listings inject their overlaid rows. */
  #pendingExistingEntityIds(kind: EntityKind): Set<string> {
    const ids = new Set<string>();
    for (const action of this.#listPendingActions()) {
      let targetId: string | undefined;
      switch (action.type) {
        case "setTitle": case "setBody": case "addLabels": case "removeLabels":
        case "changeState": case "postComment":
          if (action.targetKind === kind) targetId = action.targetId;
          break;
        case "postReview": case "replyToDiffComment": case "resolveDiffThread": case "mergeMergeRequest":
          if (kind === "mergeRequest") targetId = action.mergeRequestId;
          break;
        default:
          break;
      }
      if (!targetId) continue;
      const realId = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
      if (realId) ids.add(realId);
    }
    return ids;
  }

  /**
   * Rewrite provisional references -- `#~N` for issues, `!~N` for merge requests -- to their real
   * numbers where known. With `requireAll`, an unresolved reference is an error (apply time).
   */
  #rewriteKnownReferences(text: string, requireAll: boolean): string {
    return text.replace(/([#!])(~\d+)/g, (_, sigil: string, provisionalId: string) => {
      const kind: EntityKind = sigil === "#" ? "issue" : "mergeRequest";
      const record = this.#getProvisionalResource(provisionalId);
      const realId = record?.kind === kind ? record.realId : undefined;
      if (!realId && requireAll) {
        throw new Error(
          `Reference ${sigil}${provisionalId} points to a provisional ${kind === "issue" ? "issue" : "merge request"} ` +
          `that has not been created on GitLab yet. Retry after its create action is approved.`);
      }
      return realId ? `${sigil}${realId}` : `${sigil}${provisionalId}`;
    });
  }

  /** Pending pushes, oldest first, optionally for one branch. */
  #pendingPushActions(branch?: string): PushAction[] {
    return this.#listPendingActions().filter(
      (action): action is PushAction => action.type === "push" && (branch === undefined || action.branch === branch));
  }

  /**
   * Overlay a branch's queued pushes onto its real head: repeatedly consume the pending push
   * whose expected old head is the current head, advancing to its new head. `null` when the
   * branch does not exist and no queued push creates it. Reads use this to show a branch at its
   * simulated head; the push queue path uses it to bind the next push's expectation.
   */
  #simulateBranchHead(branch: string, realHead: GitOid | null): GitOid | null {
    let head = realHead;
    const pending = [...this.#pendingPushActions(branch)];
    for (let progressed = true; progressed;) {
      progressed = false;
      for (let i = 0; i < pending.length; i += 1) {
        const expected = pending[i].expectedOldSha === ZERO_OID ? null : pending[i].expectedOldSha;
        if (expected === head) {
          head = pending[i].newSha;
          pending.splice(i, 1);
          progressed = true;
          break;
        }
      }
    }
    return head;
  }

  // -- viewer and project -----------------------------------------------------------------

  async #getViewerActor(): Promise<GitLabActor> {
    const viewer = await this.#cached<StoredViewer>(this.#cacheKey("viewer"), VIEWER_CACHE_TTL_MS, async () => {
      const user = await this.#withApi(api => api.getCurrentUser());
      const actor = actorFromUser(this.#instanceUrl(), user);
      if (!actor) throw new Error("Failed to identify the connected GitLab account.");
      return { actor, fetchedAt: Date.now() };
    });
    return viewer.actor;
  }

  async #getProjectMetadata(): Promise<GitLabProjectMetadata> {
    return await this.#cached(this.#cacheKey("project", this.#projectPath()), ENTITY_CACHE_TTL_MS, async () =>
      normalizeProjectMetadata(this.#instanceUrl(), await this.#withApi(api => api.getProject(this.#projectPath()))));
  }

  /** A fork's project ref, for a merge request whose source project is not this one. */
  async #projectRefById(id: number): Promise<GitLabProjectRef> {
    return await this.#cached(this.#cacheKey("project-by-id", String(id)), ENTITY_CACHE_TTL_MS, async () => {
      try {
        const project = await this.#withApi(api => api.getProjectById(id));
        return projectRef(this.#instanceUrl(), project.path_with_namespace, project.name);
      } catch (error) {
        // A fork the user cannot see: keep the merge request readable with an opaque ref.
        logger.warn("failed to resolve a merge request's source project", {
          event: "merge.request.source.project.resolve.failed", error,
        });
        return { path: `project-${id}`, name: `project-${id}`, namespace: "", url: this.#instanceUrl() };
      }
    });
  }

  async #sourceProjectRef(mr: GitLabMergeRequestResponse): Promise<GitLabProjectRef | undefined> {
    return mr.source_project_id === mr.target_project_id ? undefined : await this.#projectRefById(mr.source_project_id);
  }

  // -- issues and merge requests ----------------------------------------------------------

  async #getRemoteIssueDetails(realId: string): Promise<GitLabIssueDetails> {
    const details = await this.#cached(this.#cacheKey("issue", realId), ENTITY_CACHE_TTL_MS, async () =>
      normalizeIssueDetails(this.#instanceUrl(), this.#projectPath(),
        await this.#withApi(api => api.getIssue(this.#projectPath(), Number(realId)))));
    return details;
  }

  /**
   * The raw merge request, retried once when `diff_refs` is still empty (GitLab computes it
   * asynchronously after creation); the revision reads fall back to `/merge_base` if it stays so.
   */
  async #getRawMergeRequest(realId: string): Promise<GitLabMergeRequestResponse> {
    return await this.#cached(this.#cacheKey("mr-raw", realId), ENTITY_CACHE_TTL_MS, async () => {
      let mr = await this.#withApi(api => api.getMergeRequest(this.#projectPath(), Number(realId)));
      if (!mr.diff_refs && mr.state === "opened") {
        await new Promise(resolve => setTimeout(resolve, DIFF_REFS_RETRY_DELAY_MS));
        mr = await this.#withApi(api => api.getMergeRequest(this.#projectPath(), Number(realId)));
      }
      return mr;
    });
  }

  async #getApprovers(realId: string): Promise<GitLabSimpleUser[]> {
    return await this.#cached(this.#cacheKey("mr-approvals", realId), ENTITY_CACHE_TTL_MS, async () => {
      try {
        return (await this.#withApi(api => api.getMergeRequestApprovals(this.#projectPath(), Number(realId))))
          .approved_by.map(entry => entry.user);
      } catch (error) {
        // Approvals may be unavailable (feature disabled, or an older instance); the merge request
        // is still readable without them.
        if (error instanceof GitLabApiError && (error.status === 404 || error.status === 403)) return [];
        throw error;
      }
    });
  }

  async #getRemoteMergeRequestDetails(realId: string): Promise<GitLabMergeRequestDetails> {
    const details = await this.#cached(this.#cacheKey("mr", realId), ENTITY_CACHE_TTL_MS, async () => {
      const mr = await this.#getRawMergeRequest(realId);
      const [approvers, sourceProject] = await Promise.all([this.#getApprovers(realId), this.#sourceProjectRef(mr)]);
      return normalizeMergeRequestDetails(this.#instanceUrl(), this.#projectPath(), mr, approvers, sourceProject);
    });
    return details;
  }

  async #getIssueDetails(logicalId: string): Promise<GitLabIssueDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "issue") {
        throw new Error(`No provisional issue exists with id ${logicalId}`);
      }
      if (provisional.realId) {
        return this.#overlayIssueLike(await this.#getRemoteIssueDetails(provisional.realId), "issue", logicalId);
      }
      const createAction = this.#findCreateAction(logicalId, "issue");
      if (!createAction) {
        throw new Error(`Provisional issue ${logicalId} is no longer available.`);
      }
      return this.#overlayIssueLike(await this.#buildProvisionalIssueDetails(createAction), "issue", logicalId, true);
    }
    return this.#overlayIssueLike(await this.#getRemoteIssueDetails(logicalId), "issue", logicalId);
  }

  async #getMergeRequestDetails(logicalId: string, gitCache?: RpcStub<GitCache>): Promise<GitLabMergeRequestDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "mergeRequest") {
        throw new Error(`No provisional merge request exists with id ${logicalId}`);
      }
      if (provisional.realId) {
        return await this.#overlaySimulatedSourceHead(
          this.#overlayIssueLike(await this.#getRemoteMergeRequestDetails(provisional.realId), "mergeRequest", logicalId),
          gitCache);
      }
      const createAction = this.#findCreateAction(logicalId, "mergeRequest");
      if (!createAction) {
        throw new Error(`Provisional merge request ${logicalId} is no longer available.`);
      }
      return this.#overlayIssueLike(
        await this.#buildProvisionalMergeRequestDetails(createAction, gitCache), "mergeRequest", logicalId, true);
    }
    return await this.#overlaySimulatedSourceHead(
      this.#overlayIssueLike(await this.#getRemoteMergeRequestDetails(logicalId), "mergeRequest", logicalId),
      gitCache);
  }

  /**
   * Overlay queued pushes onto an existing merge request's source branch: when the (same-project)
   * source branch has pending pushes, the details read as if they had landed -- simulated head
   * sha and recomputed changed-file count. `mergeStatus` becomes `unchecked`: GitLab's verdict
   * describes the remote head, not the simulated one. Without a git cache (a read that is not a
   * session's, such as binding a merge's expected head), or when the simulation fails, the head
   * alone is overlaid from the queued pushes' records -- so every read of the branch agrees on
   * which commit it is at, and a merge queued behind a push binds the head that push will leave.
   */
  async #overlaySimulatedSourceHead(
    details: GitLabMergeRequestDetails, gitCache?: RpcStub<GitCache>,
  ): Promise<GitLabMergeRequestDetails> {
    if (details.source.project.path !== this.#projectPath()) return details;
    if (this.#pendingPushActions(details.source.branch).length === 0) return details;
    if (gitCache === undefined) return this.#overlayMergeRequestSummaryHead(details);
    const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, details.target.branch, details.source.branch);
    if (simulated === null) return this.#overlayMergeRequestSummaryHead(details);
    return {
      ...details,
      source: { ...details.source, sha: simulated.revision.headSha },
      changedFiles: simulated.files.length,
      changedFilesTruncated: undefined,
      mergeStatus: "unchecked",
      hasConflicts: false,
    };
  }

  /**
   * A same-project source branch with queued pushes reads at its simulated head. The simulated
   * sha is always a queued push's newSha, so `isSimulatedCommitId` already withholds it from
   * session advertising.
   */
  #overlayMergeRequestSummaryHead<T extends GitLabMergeRequestSummary>(item: T): T {
    if (item.source.project.path !== this.#projectPath()) return item;
    if (this.#pendingPushActions(item.source.branch).length === 0) return item;
    const simulated = this.#simulateBranchHead(item.source.branch, item.source.sha || null);
    if (simulated === null || simulated === item.source.sha) return item;
    return { ...item, source: { ...item.source, sha: simulated } };
  }

  async #buildProvisionalIssueDetails(action: CreateIssueAction): Promise<GitLabIssueDetails> {
    const viewer = await this.#getViewerActor();
    return {
      project: this.#projectRef(),
      id: action.provisionalId,
      url: issueUrl(this.#instanceUrl(), this.#projectPath(), action.provisionalId),
      title: action.options.title,
      state: "opened",
      labels: (action.options.labels ?? []).map(name => ({ name })),
      author: viewer,
      assignees: (action.options.assignees ?? []).map(username => actorFromUsername(this.#instanceUrl(), username)),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
    };
  }

  async #buildProvisionalMergeRequestDetails(
    action: CreateMergeRequestAction, gitCache?: RpcStub<GitCache>,
  ): Promise<GitLabMergeRequestDetails> {
    const viewer = await this.#getViewerActor();
    let sourceSha = "";
    let targetSha = "";
    let changedFiles: number | undefined;
    try {
      // The source branch may itself be provisional -- moved, or outright created, by queued
      // pushes. The simulated comparison reads it as if those pushes had landed; when it cannot
      // run (no cache, or a tree the cache lacks) the live heads stand in, with the source head
      // still overlaid so the ref points where the queued pushes will put it.
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, action.options.targetBranch, action.options.sourceBranch);
      if (simulated !== null) {
        sourceSha = simulated.revision.headSha;
        targetSha = simulated.revision.baseSha;
        changedFiles = simulated.files.length;
      } else {
        const [source, target] = await Promise.all([
          this.#getBranchHeadCached(action.options.sourceBranch),
          this.#getBranchHeadCached(action.options.targetBranch),
        ]);
        sourceSha = this.#simulateBranchHead(action.options.sourceBranch, source) ?? "";
        targetSha = target ?? "";
        if (source !== null && target !== null && sourceSha === source) {
          const compare = await this.#compareCached(action.options.targetBranch, action.options.sourceBranch);
          changedFiles = compare.files.length;
        }
      }
    } catch (error) {
      logger.warn("failed to compute provisional merge request comparison", {
        event: "merge.request.provisional.comparison.compute.failed", error,
      });
    }
    const project = this.#projectRef();
    return {
      project,
      id: action.provisionalId,
      url: mergeRequestUrl(this.#instanceUrl(), this.#projectPath(), action.provisionalId),
      title: action.options.draft ? withDraftPrefix(action.options.title) : action.options.title,
      state: "opened",
      labels: [],
      author: viewer,
      assignees: [],
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
      draft: action.options.draft ?? false,
      source: { branch: action.options.sourceBranch, sha: sourceSha, project },
      target: { branch: action.options.targetBranch, sha: targetSha, project },
      mergeStatus: "unchecked",
      hasConflicts: false,
      reviewers: [],
      approvedBy: [],
      ...(changedFiles === undefined ? {} : { changedFiles }),
    };
  }

  /** Replay an entity's pending mutations onto a summary or details object. */
  #overlayIssueLike<T extends GitLabIssueSummary | GitLabIssueDetails | GitLabMergeRequestSummary | GitLabMergeRequestDetails>(
    base: T, kind: EntityKind, logicalId: string, includeCreate = false,
  ): T {
    const result = structuredClone(base);
    const actions = this.#pendingActionsForEntity(kind, logicalId);
    for (const action of actions) {
      switch (action.type) {
        case "setTitle":
          result.title = action.title;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "setBody":
          if ("bodyMarkdown" in result) {
            result.bodyMarkdown = this.#rewriteKnownReferences(action.bodyMarkdown, false);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        case "addLabels": {
          const existing = new Set(result.labels.map(label => label.name.toLowerCase()));
          for (const label of action.labels) {
            if (!existing.has(label.toLowerCase())) result.labels.push({ name: label });
          }
          result.labels = dedupeLabels(result.labels);
          result.updatedAt = new Date(action.submittedAt);
          break;
        }
        case "removeLabels":
          result.labels = result.labels.filter(label =>
            !action.labels.some(name => name.toLowerCase() === label.name.toLowerCase()));
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "changeState":
          result.state = action.state;
          result.closedAt = action.state === "closed" ? new Date(action.submittedAt) : undefined;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "postComment":
          result.commentCount += 1;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "mergeMergeRequest":
          if ("source" in result) {
            result.state = "merged";
            result.closedAt = new Date(action.submittedAt);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        default:
          break;
      }
    }
    if (includeCreate) {
      const lastAction = actions.at(-1);
      result.updatedAt = lastAction ? new Date(lastAction.submittedAt) : result.updatedAt;
    }
    return result;
  }

  // -- listings ---------------------------------------------------------------------------

  async #buildTouchedIssueSummaries(
    predicate: (item: GitLabIssueDetails) => boolean,
    compare: (a: GitLabIssueSummary, b: GitLabIssueSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitLabIssueSummary[] }> {
    const ids = this.#pendingExistingEntityIds("issue");
    const items = (await Promise.all([...ids].map(id => this.#getIssueDetails(id))))
      .filter(predicate)
      .map(summarizeIssueDetails)
      .toSorted(compare);
    return { ids, items };
  }

  async #buildTouchedMergeRequestSummaries(
    predicate: (item: GitLabMergeRequestDetails) => boolean,
    compare: (a: GitLabMergeRequestSummary, b: GitLabMergeRequestSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitLabMergeRequestSummary[] }> {
    const ids = this.#pendingExistingEntityIds("mergeRequest");
    const items = (await Promise.all([...ids].map(id => this.#getMergeRequestDetails(id))))
      .filter(predicate)
      .map(summarizeMergeRequestDetails)
      .toSorted(compare);
    return { ids, items };
  }

  /**
   * Issues, listed or searched: GitLab's list endpoint is its search endpoint (`search=`), so one
   * path serves both. Touched (queued-mutation) issues are removed from the remote pages and
   * re-injected overlaid; provisional issues are injected too.
   */
  async #listIssueSummaries(
    filter: GitLabIssueFilter | undefined, search: string | undefined, pageSize: number,
  ): Promise<Cursor<GitLabIssueSummary>> {
    const compare = issuableComparator<GitLabIssueSummary>(filter?.sort, filter?.direction);
    const matches = (item: GitLabIssueDetails) =>
      search === undefined ? issueMatchesFilter(item, filter) : issueMatchesSearch(item, { ...filter, text: search });
    const touched = await this.#buildTouchedIssueSummaries(matches, compare);
    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateIssueAction => action.type === "createIssue")
      .map(action => this.#buildProvisionalIssueDetails(action)
        .then(issue => this.#overlayIssueLike(issue, "issue", action.provisionalId, true)))))
      .filter(matches)
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);

    const { orderBy, sort } = issueOrder(filter);
    const projectPath = this.#projectPath();
    const key = stableKey({ ...filter, search });
    return new StreamingCursor<GitLabIssueSummary>({
      fetchPage: async (page, perPage) =>
        await this.#cached(this.#cacheKey("list-issues", key, `p${page}`), LIST_CACHE_TTL_MS, async () => {
          const raw = await this.#withApi(api => api.listIssues(projectPath, {
            state: filter?.state,
            labels: filter?.labels,
            authorUsername: filter?.author,
            assigneeUsername: filter?.assignee,
            search,
            orderBy,
            sort,
            perPage,
            page,
          }));
          return raw.map(item => normalizeIssueSummary(this.#instanceUrl(), projectPath, item));
        }),
      overlay: item => this.#overlayIssueLike(item, "issue", item.id),
      // Search scope is the project's own endpoint, so remote rows need no re-check; the local
      // filter re-applies the structured filter after the overlay may have changed labels/state,
      // and drops the rows already served as injected items (a touched issue sorts by its
      // overlaid state, not its remote one). Both belong here rather than in fetchPage: the
      // cursor reads the remote page's *length* to know when the listing is exhausted, so a page
      // thinned before it is counted would end the walk early.
      filter: item => !touched.ids.has(item.id) && issueMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #listMergeRequestSummaries(
    filter: GitLabMergeRequestFilter | undefined, search: string | undefined, pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitLabMergeRequestSummary>> {
    const compare = issuableComparator<GitLabMergeRequestSummary>(filter?.sort, filter?.direction);
    const matches = (item: GitLabMergeRequestDetails) =>
      search === undefined ? mergeRequestMatchesFilter(item, filter) : mergeRequestMatchesSearch(item, { ...filter, text: search });
    const touched = await this.#buildTouchedMergeRequestSummaries(matches, compare);
    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateMergeRequestAction => action.type === "createMergeRequest")
      .map(action => this.#buildProvisionalMergeRequestDetails(action, gitCache)
        .then(mr => this.#overlayIssueLike(mr, "mergeRequest", action.provisionalId, true)))))
      .filter(matches)
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);

    const { orderBy, sort } = mergeRequestOrder(filter);
    const projectPath = this.#projectPath();
    const key = stableKey({ ...filter, search });
    return new StreamingCursor<GitLabMergeRequestSummary>({
      fetchPage: async (page, perPage) =>
        await this.#cached(this.#cacheKey("list-mrs", key, `p${page}`), LIST_CACHE_TTL_MS, async () => {
          const raw = await this.#withApi(api => api.listMergeRequests(projectPath, {
            state: filter?.state,
            sourceBranch: filter?.sourceBranch,
            targetBranch: filter?.targetBranch,
            labels: filter?.labels,
            authorUsername: filter?.author,
            assigneeUsername: filter?.assignee,
            draft: filter?.draft,
            search,
            orderBy,
            sort,
            perPage,
            page,
          }));
          const sourceProjects = await Promise.all(raw.map(item => this.#sourceProjectRef(item)));
          return raw.map((item, i) => normalizeMergeRequestSummary(this.#instanceUrl(), projectPath, item, sourceProjects[i]));
        }),
      overlay: item => this.#overlayMergeRequestSummaryHead(this.#overlayIssueLike(item, "mergeRequest", item.id)),
      // As for issues: touched rows are dropped here, after the page has been counted.
      filter: item => !touched.ids.has(item.id) && mergeRequestMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  // -- discussion -------------------------------------------------------------------------

  #noteableUrl(kind: EntityKind, id: string): string {
    return kind === "issue"
      ? issueUrl(this.#instanceUrl(), this.#projectPath(), id)
      : mergeRequestUrl(this.#instanceUrl(), this.#projectPath(), id);
  }

  /**
   * A thread's comments -- the people's words, oldest first -- read from the discussions endpoint
   * and flattened: every note of every discussion, less GitLab's own activity (`system`) and, on
   * a merge request, the diff-anchored notes `readDiffThreads()` serves. The notes endpoint would
   * be the natural incremental source (it takes `order_by=updated_at`), but GitLab documents that
   * it omits replies ("items of type DiscussionNote are not returned as part of the Note API"),
   * and the discussions endpoint takes no ordering or `since` at all -- so the whole thread is
   * read and cached, as the diff threads already are.
   */
  async #fetchRemoteDiscussionComments(kind: EntityKind, realId: string): Promise<GitLabDiscussionCommentEntry[]> {
    const noteableUrl = this.#noteableUrl(kind, realId);
    const discussions = await this.#fetchRemoteDiscussions(kind, realId);
    return discussions
      .flatMap(discussion => discussion.notes)
      .filter(isDiscussionComment)
      .map(note => discussionCommentFromNote(this.#instanceUrl(), noteableUrl, note))
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async #getDiscussion(kind: EntityKind, logicalId: string, pageSize: number): Promise<Cursor<GitLabDiscussionEntry>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    const compare = (a: GitLabDiscussionEntry, b: GitLabDiscussionEntry) => a.createdAt.getTime() - b.createdAt.getTime();

    const viewer = await this.#getViewerActor();
    const provisionals: GitLabDiscussionEntry[] = [];
    for (const action of this.#pendingActionsForEntity(kind, logicalId)) {
      if (action.type === "postComment") {
        provisionals.push({
          kind: "comment",
          id: action.provisionalCommentId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
          createdAt: new Date(action.submittedAt),
          url: `${this.#noteableUrl(kind, logicalId)}#note_${action.provisionalCommentId}`,
        });
      } else if (action.type === "postReview" && action.review.bodyMarkdown) {
        // A review's summary is published as an ordinary note on the thread.
        provisionals.push({
          kind: "comment",
          id: action.provisionalReviewId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.review.bodyMarkdown, false),
          createdAt: new Date(action.submittedAt),
          url: `${this.#noteableUrl(kind, logicalId)}#note_${action.provisionalReviewId}`,
        });
      }
    }
    provisionals.sort(compare);

    if (!realId) {
      return new ArrayCursor(provisionals, pageSize);
    }

    const comments = await this.#fetchRemoteDiscussionComments(kind, realId);
    return new ArrayCursor([...comments, ...provisionals].toSorted(compare), pageSize);
  }

  // -- diff threads -----------------------------------------------------------------------

  /** Every discussion on an issue or merge request, cached briefly; the one read behind both `readDiscussion()` and `readDiffThreads()`. */
  async #fetchRemoteDiscussions(kind: EntityKind, realId: string): Promise<GitLabDiscussionResponse[]> {
    return await this.#cached(this.#cacheKey("discussions", kind, realId), ENTITY_CACHE_TTL_MS, async () =>
      await this.#fetchAllPages((page, perPage) =>
        this.#withApi(api => api.listDiscussions(this.#projectPath(), apiKind(kind), Number(realId), page, perPage))));
  }

  /** Diff-anchored discussions as threads, in creation order. */
  async #fetchRemoteDiffThreads(realId: string, headSha: string | undefined): Promise<GitLabDiffThread[]> {
    const threads: GitLabDiffThread[] = [];
    const noteableUrl = this.#noteableUrl("mergeRequest", realId);
    for (const discussion of await this.#fetchRemoteDiscussions("mergeRequest", realId)) {
      const first = discussion.notes[0];
      if (!first?.position) continue;
      const comments = discussion.notes.filter(note => !note.system);
      if (comments.length === 0) continue;
      threads.push({
        id: discussion.id,
        target: commentTargetFromPosition(first.position),
        // REST has no outdated flag; a position anchored to an older head than the current one
        // is the best available approximation.
        ...(headSha ? { isOutdated: first.position.head_sha !== headSha } : {}),
        isResolved: comments.some(note => note.resolvable) ? comments.every(note => !note.resolvable || note.resolved === true) : false,
        comments: comments.map(note => ({
          id: String(note.id),
          author: actorFromUser(this.#instanceUrl(), note.author),
          bodyMarkdown: note.body ?? "",
          createdAt: new Date(note.created_at),
          updatedAt: note.updated_at ? new Date(note.updated_at) : undefined,
          url: `${noteableUrl}#note_${note.id}`,
        })),
      });
    }
    return threads.toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
  }

  async #getDiffThreads(logicalId: string, pageSize: number): Promise<Cursor<GitLabDiffThread>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    let base: GitLabDiffThread[] = [];
    if (realId) {
      const raw = await this.#getRawMergeRequest(realId);
      base = await this.#fetchRemoteDiffThreads(realId, raw.diff_refs?.head_sha ?? raw.sha);
    }

    const threads = new Map<string, GitLabDiffThread>(base.map(thread => [thread.id, structuredClone(thread)]));
    const viewer = await this.#getViewerActor();
    const noteableUrl = this.#noteableUrl("mergeRequest", logicalId);
    for (const action of this.#pendingActionsForEntity("mergeRequest", logicalId)) {
      if (action.type === "postReview") {
        for (const comment of action.review.diffComments ?? []) {
          threads.set(comment.provisionalCommentId, {
            id: comment.provisionalCommentId,
            target: comment.target,
            isOutdated: false,
            isResolved: false,
            comments: [{
              id: comment.provisionalCommentId,
              author: viewer,
              bodyMarkdown: this.#rewriteKnownReferences(comment.bodyMarkdown, false),
              createdAt: new Date(action.submittedAt),
              url: `${noteableUrl}#note_${comment.provisionalCommentId}`,
            }],
          });
        }
      } else if (action.type === "replyToDiffComment") {
        const thread = [...threads.values()].find(candidate =>
          candidate.id === action.commentId || candidate.comments.some(comment => comment.id === action.commentId));
        if (thread) {
          thread.comments.push({
            id: action.provisionalCommentId,
            author: viewer,
            bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
            createdAt: new Date(action.submittedAt),
            url: `${noteableUrl}#note_${action.provisionalCommentId}`,
          });
        }
      } else if (action.type === "resolveDiffThread") {
        const thread = threads.get(action.threadId);
        if (thread) thread.isResolved = action.resolved;
      }
    }

    const sorted = [...threads.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
    return new ArrayCursor(sorted, pageSize);
  }

  // -- diff and merge base ----------------------------------------------------------------

  /** A three-dot compare, normalized: the files and the commits (oldest first). */
  async #compareCached(from: string, to: string): Promise<{ files: GitDiffFile[]; commits: GitLabCommitSummary[]; timedOut: boolean }> {
    return await this.#cached(this.#cacheKey("compare", stableKey(from), stableKey(to)), ENTITY_CACHE_TTL_MS, async () => {
      const compare = await this.#withApi(api => api.compare(this.#projectPath(), from, to));
      return {
        files: compare.diffs.map(normalizeDiffFile),
        commits: compare.commits.map(c => normalizeCommitSummary(this.#instanceUrl(), this.#projectPath(), c)),
        timedOut: compare.compare_timeout,
      };
    });
  }

  /** The merge base of two commits, cached immutably: a pure function of the pair. */
  async #getMergeBaseCached(a: GitOid, b: GitOid): Promise<GitOid> {
    return await this.#cached(this.#cacheKey("merge-base", a, b), IMMUTABLE_CACHE_TTL_MS, async () => {
      const base = await this.#withApi(api => api.mergeBase(this.#projectPath(), a, b));
      if (!base) throw new Error(`GitLab reports no common ancestor between ${a} and ${b}.`);
      return base.id;
    });
  }

  async #mergeBaseOrWarn(a: string, b: string): Promise<GitOid | undefined> {
    if (!isCommitOid(a) || !isCommitOid(b)) return undefined;
    try {
      return await this.#getMergeBaseCached(a, b);
    } catch (error) {
      logger.warn("failed to determine a merge request's merge base", {
        event: "merge.request.merge.base.failed", error,
      });
      return undefined;
    }
  }

  /**
   * The revision an existing merge request's diff is pinned to. From `diff_refs` when GitLab has
   * computed it (the common case), else assembled from the live heads and `/merge_base`.
   */
  async #mergeRequestRevision(mr: GitLabMergeRequestResponse): Promise<GitLabMergeRequestRevision> {
    if (mr.diff_refs) return revisionFromDiffRefs(mr.diff_refs);
    const targetHead = (await this.#getBranchHeadCached(mr.target_branch)) ?? "";
    return {
      baseSha: targetHead,
      headSha: mr.sha,
      mergeBaseSha: targetHead ? await this.#mergeBaseOrWarn(targetHead, mr.sha) : undefined,
    };
  }

  async #getDiff(logicalId: string, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<{ revision: GitLabMergeRequestRevision; files: Cursor<GitDiffFile> }> {
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${logicalId} is no longer available.`);
      // The source branch may be provisional (moved or created by queued pushes); read the
      // comparison as if those pushes had landed. GitLab's live compare would 404 on a branch
      // that does not exist yet, or silently describe its stale head.
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, action.options.targetBranch, action.options.sourceBranch);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }
      const [source, target] = await Promise.all([
        this.#getBranchHeadCached(action.options.sourceBranch),
        this.#getBranchHeadCached(action.options.targetBranch),
      ]);
      if (source === null || target === null) {
        throw new Error(
          `Branch "${source === null ? action.options.sourceBranch : action.options.targetBranch}" does not exist on GitLab yet; ` +
          `push it first, and read the diff once that push is approved.`);
      }
      const compare = await this.#compareCached(action.options.targetBranch, action.options.sourceBranch);
      return {
        revision: { baseSha: target, headSha: source, mergeBaseSha: await this.#mergeBaseOrWarn(target, source) },
        files: new ArrayCursor(compare.files, pageSize),
      };
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    const mr = await this.#getRawMergeRequest(realId);
    // An existing merge request whose source branch has queued pushes reads its diff at the
    // simulated head, like every other read of that branch.
    if (gitCache !== undefined && mr.source_project_id === mr.target_project_id &&
        this.#pendingPushActions(mr.source_branch).length > 0) {
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, mr.target_branch, mr.source_branch);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }
    }
    const revision = await this.#mergeRequestRevision(mr);
    const projectPath = this.#projectPath();
    return {
      revision,
      files: new StreamingCursor<GitDiffFile>({
        fetchPage: async (page, perPage) =>
          await this.#cached(this.#cacheKey("mr-diffs", realId, revision.headSha, `p${page}`), ENTITY_CACHE_TTL_MS, async () =>
            (await this.#withApi(api => api.listMergeRequestDiffs(projectPath, Number(realId), page, perPage)))
              .map(normalizeDiffFile)),
        overlay: item => item,
        filter: () => true,
        comparator: () => 0,
        injectedItems: [],
        pageSize,
      }),
    };
  }

  // -- repository -------------------------------------------------------------------------

  /** A branch's current head (null if it does not exist), cached briefly for simulation reads. */
  async #getBranchHeadCached(branch: string): Promise<GitOid | null> {
    const key = this.#cacheKey("branch-head", stableKey(branch));
    const cached = this.#loadCached<{ head: GitOid | null }>(key, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) return cached.head;
    const generation = this.#cacheGeneration();
    const head = (await this.#withApi(api => api.getBranch(this.#projectPath(), branch)))?.commit.id ?? null;
    this.#storeCached(key, { head }, generation);
    return head;
  }

  /** A commit by sha, branch, or tag; null on 404. Cached briefly, since `ref` may be a name. */
  async #getRemoteCommitDetails(ref: string): Promise<GitLabCommitDetails | null> {
    return await this.#cached(this.#cacheKey("commit", stableKey(ref)), ENTITY_CACHE_TTL_MS, async () => {
      const commit = await this.#withApi(api => api.getCommit(this.#projectPath(), ref));
      return commit ? normalizeCommitDetails(this.#instanceUrl(), this.#projectPath(), commit) : null;
    });
  }

  async #tryReadCachedCommitDetails(gitCache: RpcStub<GitCache>, oid: GitOid): Promise<GitLabCommitDetails | null> {
    const object = await gitCache.get(oid);
    if (object === null || object.type !== "commit") return null;
    const instanceUrl = this.#instanceUrl();
    const projectPath = this.#projectPath();
    return commitDetailsFromGitObject(oid, object.content, id => `${instanceUrl}/${projectPath}/-/commit/${id}`);
  }

  // -- Gatekeeper interface ---------------------------------------------------------------

  async describe(): Promise<ResourceDescription> {
    const props = this.#props();
    switch (props.resourceKind) {
      case "project": {
        const project = await this.#getProjectMetadata();
        return {
          url: project.url,
          title: project.path,
          snippet: project.description ?? `GitLab project ${project.path}`,
          suggestedBindingName: "GITLAB_PROJECT",
          tsType: "GitLabProject",
        };
      }
      case "issue": {
        const issue = await this.#getIssueDetails(String(props.iid));
        return {
          url: issue.url,
          title: `Issue #${issue.id}: ${issue.title}`,
          snippet: textSnippet(issue.bodyMarkdown, `${issue.state} issue in ${issue.project.path}`),
          suggestedBindingName: "GITLAB_ISSUE",
          tsType: "GitLabIssue",
        };
      }
      case "mergeRequest": {
        const mr = await this.#getMergeRequestDetails(String(props.iid));
        return {
          url: mr.url,
          title: `Merge Request !${mr.id}: ${mr.title}`,
          snippet: textSnippet(mr.bodyMarkdown, `${mr.state} merge request in ${mr.project.path}`),
          suggestedBindingName: "GITLAB_MERGE_REQUEST",
          tsType: "GitLabMergeRequest",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GitLabProject | GitLabIssue | GitLabMergeRequest> {
    const props = this.#props();
    const queue = approvalQueue.dup();
    switch (props.resourceKind) {
      case "project":
        return new GitLabProjectSessionImpl(this, queue);
      case "issue":
        return new GitLabIssueImpl(this, queue, String(props.iid));
      case "mergeRequest":
        return new GitLabMergeRequestImpl(this, queue, String(props.iid));
    }
  }

  /**
   * Observer tracking: the "ACL check (single unit)" strategy. Every binding is scoped to one
   * project, and issues/MRs inherit its permissions, so admitting an observer is one question --
   * can they read the project's repository, checked with their own token via the verifier. Whole
   * unit verified up front, so nothing is tracked and `removeObserver` is a no-op; the overseer
   * re-runs `addObserver` on every open, so lost access is caught promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<import("./gitlab").GitLabVerifierApi>;
    const projectPath = this.#projectPath();
    if (!(await verifier.hasProjectAccess(projectPath))) {
      throw new Error(
        `This collaborator does not have read access to the GitLab project ${projectPath}, ` +
        `so they cannot be allowed to observe data this workspace read from it.`);
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  // -- session-facing reads (in-process; sessions hold this object directly) --------------

  async projectMetadata(): Promise<GitLabProjectMetadata> {
    return await this.#getProjectMetadata();
  }

  async openIssue(id: string): Promise<GitLabIssueDetails> {
    return await this.#getIssueDetails(id);
  }

  async openMergeRequest(id: string, gitCache?: RpcStub<GitCache>): Promise<GitLabMergeRequestDetails> {
    return await this.#getMergeRequestDetails(id, gitCache);
  }

  async issueDiscussion(kind: EntityKind, id: string, pageSize: number): Promise<Cursor<GitLabDiscussionEntry>> {
    return await this.#getDiscussion(kind, id, pageSize);
  }

  async mergeRequestDiff(id: string, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<{ revision: GitLabMergeRequestRevision; files: Cursor<GitDiffFile> }> {
    return await this.#getDiff(id, pageSize, gitCache);
  }

  /**
   * The merge base of a merge request, always a commit GitLab itself knows -- even a simulated
   * head's merge base comes from a live `/merge_base` against the pending chain's anchor -- so
   * sessions may advertise it.
   */
  async mergeRequestMergeBase(id: string, gitCache?: RpcStub<GitCache>): Promise<GitOid> {
    if (id.startsWith("~") && !this.#resolveProvisionalId(id)) {
      const action = this.#findCreateAction(id, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${id} is no longer available.`);
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, action.options.targetBranch, action.options.sourceBranch);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
      const [source, target] = await Promise.all([
        this.#getBranchHeadCached(action.options.sourceBranch),
        this.#getBranchHeadCached(action.options.targetBranch),
      ]);
      if (source === null || target === null) {
        throw new Error(`Both branches must exist on GitLab before a merge base can be computed for ${id}.`);
      }
      return await this.#getMergeBaseCached(target, source);
    }
    const realId = id.startsWith("~") ? this.#resolveProvisionalId(id)! : id;
    const mr = await this.#getRawMergeRequest(realId);
    // A source branch with queued pushes reads at its simulated head, like every other read of
    // that branch; its comparison already knows the merge base it diffs from.
    if (gitCache !== undefined && mr.source_project_id === mr.target_project_id &&
        this.#pendingPushActions(mr.source_branch).length > 0) {
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, mr.target_branch, mr.source_branch);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
    }
    const revision = await this.#mergeRequestRevision(mr);
    if (revision.mergeBaseSha) return revision.mergeBaseSha;
    if (!isCommitOid(revision.baseSha) || !isCommitOid(revision.headSha)) {
      throw new Error(`GitLab has not finished computing merge request ${id}; retry shortly.`);
    }
    return await this.#getMergeBaseCached(revision.baseSha, revision.headSha);
  }

  async mergeRequestThreads(id: string, pageSize: number): Promise<Cursor<GitLabDiffThread>> {
    return await this.#getDiffThreads(id, pageSize);
  }

  async listIssues(filter: GitLabIssueFilter | undefined, pageSize: number): Promise<Cursor<GitLabIssueSummary>> {
    return await this.#listIssueSummaries(filter, undefined, pageSize);
  }

  async searchIssues(query: GitLabIssueSearch, pageSize: number): Promise<Cursor<GitLabIssueSummary>> {
    const { text, ...filter } = query;
    return await this.#listIssueSummaries(filter, text, pageSize);
  }

  async listMergeRequests(filter: GitLabMergeRequestFilter | undefined, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabMergeRequestSummary>> {
    return await this.#listMergeRequestSummaries(filter, undefined, pageSize, gitCache);
  }

  async searchMergeRequests(query: GitLabMergeRequestSearch, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabMergeRequestSummary>> {
    const { text, ...filter } = query;
    return await this.#listMergeRequestSummaries(filter, text, pageSize, gitCache);
  }

  /**
   * Whether `commitId` is the head of a push queued on this gatekeeper -- a commit simulation may
   * hand back that is not on GitLab yet. Synchronous so per-page cursor advertising can check it
   * live as pages are drained.
   */
  isCommitPendingPush(commitId: GitOid): boolean {
    return this.#pendingPushActions().some(action => action.newSha === commitId);
  }

  /**
   * Whether `commitId` is a commit simulation may have handed back that is not on GitLab yet: a
   * queued push's head, or any commit this instance served from the workspace git cache while
   * simulating one. Session advertising callbacks consult this to withhold such ids.
   */
  isSimulatedCommitId(commitId: GitOid): boolean {
    return this.#servedSimulatedCommitIds.has(commitId) || this.isCommitPendingPush(commitId);
  }

  async listBranches(filter: GitLabBranchFilter | undefined, pageSize: number): Promise<Cursor<GitLabBranchSummary>> {
    const projectPath = this.#projectPath();

    // Simulation: a branch a queued push *creates* is injected -- but only while the remote still
    // lacks the name, checked live here, so reads never hide a branch that genuinely exists.
    const injectedNames = new Set<string>();
    const injectedItems: GitLabBranchSummary[] = [];
    const creationsChecked = new Set<string>();
    for (const action of this.#pendingPushActions()) {
      if (action.expectedOldSha !== ZERO_OID || creationsChecked.has(action.branch)) continue;
      creationsChecked.add(action.branch);
      if (filter?.search && !action.branch.includes(filter.search.replace(/^\^|\$$/g, ""))) continue;
      const real = await this.#withApi(api => api.getBranch(projectPath, action.branch));
      if (real !== null) continue;
      const head = this.#simulateBranchHead(action.branch, null);
      if (head === null) continue;
      injectedNames.add(action.branch);
      this.#servedSimulatedCommitIds.add(head);
      injectedItems.push({ name: action.branch, headCommit: head, protected: false, default: false });
    }

    return new StreamingCursor<GitLabBranchSummary>({
      fetchPage: async (page, perPage) =>
        await this.#cached(this.#cacheKey("list-branches", stableKey(filter ?? {}), `p${page}`), LIST_CACHE_TTL_MS, async () =>
          (await this.#withApi(api => api.listBranches(projectPath, { search: filter?.search, page, perPage })))
            .map(normalizeBranchSummary)),
      // A branch a queued push moves reads at the pushed head; the simulated head is recorded as
      // served so the advertising callback withholds it even if the push is rejected later.
      overlay: item => {
        const head = this.#simulateBranchHead(item.name, item.headCommit) ?? item.headCommit;
        if (head === item.headCommit) return item;
        this.#servedSimulatedCommitIds.add(head);
        return { ...item, headCommit: head };
      },
      filter: item => !injectedNames.has(item.name),
      comparator: () => 0,
      injectedItems,
      revalidateInjected: item => {
        const head = this.#simulateBranchHead(item.name, null);
        if (head === null) return null;
        this.#servedSimulatedCommitIds.add(head);
        return head === item.headCommit ? item : { ...item, headCommit: head };
      },
      pageSize,
    });
  }

  async listTags(pageSize: number): Promise<Cursor<GitLabTagSummary>> {
    const projectPath = this.#projectPath();
    return new StreamingCursor<GitLabTagSummary>({
      fetchPage: async (page, perPage) =>
        await this.#cached(this.#cacheKey("list-tags", `p${page}`), LIST_CACHE_TTL_MS, async () =>
          (await this.#withApi(api => api.listTags(projectPath, page, perPage))).map(normalizeTagSummary)),
      overlay: item => item,
      filter: () => true,
      comparator: () => 0,
      injectedItems: [],
      pageSize,
    });
  }

  /**
   * Look up a commit for the session. `fromCache` reports whether the details were served from
   * the workspace git cache rather than from GitLab; the session must not advertise a
   * cache-served result (it is either already known from this remote, or part of a pending push
   * whose advertisement would outlive a rejection).
   */
  async getCommit(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>):
      Promise<{ details: GitLabCommitDetails; fromCache: boolean }> {
    const ref = refOrDefault ?? (await this.#getProjectMetadata()).defaultBranch;
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      const realHead = (await this.#getRemoteCommitDetails(ref))?.id ?? null;
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        const details = await this.#tryReadCachedCommitDetails(gitCache, simulated);
        if (details !== null) {
          this.#servedSimulatedCommitIds.add(simulated);
          return { details, fromCache: true };
        }
      }
      if (realHead === null) throw new Error(`No commit found for ref "${ref}".`);
    }

    const details = await this.#getRemoteCommitDetails(ref);
    if (details !== null) return { details, fromCache: false };
    // A full commit id GitLab doesn't know yet may be queued for push; serve it from the
    // workspace git cache so the caller sees the world as if the push had landed.
    if (gitCache !== undefined && isCommitOid(ref)) {
      const cached = await this.#tryReadCachedCommitDetails(gitCache, ref);
      if (cached !== null) {
        this.#servedSimulatedCommitIds.add(ref);
        return { details: cached, fromCache: true };
      }
    }
    throw new Error(`No commit found for ref "${ref}".`);
  }

  /** Resolve a ref to a commit id, with `getCommit`'s simulation semantics. */
  async resolveRef(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>):
      Promise<{ id: GitOid; fromCache: boolean }> {
    const ref = refOrDefault ?? (await this.#getProjectMetadata()).defaultBranch;
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      const realHead = await this.#getBranchHeadCached(ref);
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        const object = await gitCache.get(simulated);
        if (object !== null && object.type === "commit") {
          this.#servedSimulatedCommitIds.add(simulated);
          return { id: simulated, fromCache: true };
        }
      }
      if (realHead === null) throw new Error(`No commit found for ref "${ref}".`);
    }

    // GitLab has no sha-only read; the commit lookup is the resolution.
    const details = await this.#getRemoteCommitDetails(ref);
    if (details !== null) return { id: details.id, fromCache: false };
    if (gitCache !== undefined && isCommitOid(ref)) {
      const object = await gitCache.get(ref);
      if (object !== null && object.type === "commit") {
        this.#servedSimulatedCommitIds.add(ref);
        return { id: ref, fromCache: true };
      }
    }
    throw new Error(`No commit found for ref "${ref}".`);
  }

  async listCommits(filter: GitLabCommitFilter | undefined, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabCommitSummary>> {
    const projectPath = this.#projectPath();
    // An omitted ref means the default branch, resolved here so the listing names the branch
    // explicitly (consistently with getCommit()/resolveRef(), which resolve from the same cache).
    const ref = filter?.ref ?? (await this.#getProjectMetadata()).defaultBranch;
    // A ref naming a branch with queued pushes enumerates from the simulated head: the pending
    // chain (locally filtered) is injected newest-first ahead of GitLab's listing, which starts
    // from the chain's anchor -- the first commit GitLab actually knows. Without this, a branch a
    // queued push creates 404s, and a moved one lists its stale history.
    let injected: GitLabCommitSummary[] = [];
    let refName = ref;
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      const realHead = await this.#getBranchHeadCached(ref);
      const simulatedHead = this.#simulateBranchHead(ref, realHead);
      if (simulatedHead !== null && simulatedHead !== realHead) {
        try {
          const chain = await this.#collectPendingChain(gitCache, simulatedHead);
          injected = await this.#filterPendingCommitsForListing(gitCache, chain, filter);
          refName = chain.anchor;
        } catch (error) {
          logger.warn("failed to simulate a commit listing over queued pushes", {
            event: "commits.list.simulated.failed", error,
          });
          if (realHead === null) {
            throw new Error(
              `Branch "${ref}" does not exist on GitLab yet and the commits queued to create it ` +
              `could not be read. Retry, or list commits from an existing ref.`, { cause: error });
          }
        }
      }
    }
    return new StreamingCursor<GitLabCommitSummary>({
      fetchPage: async (page, perPage) =>
        await this.#cached(this.#cacheKey("list-commits", stableKey({ ...filter, ref: refName }), `p${page}`), LIST_CACHE_TTL_MS, async () =>
          (await this.#withApi(api => api.listCommits(projectPath, {
            refName,
            path: filter?.path,
            author: filter?.author,
            since: filter?.since?.toISOString(),
            until: filter?.until?.toISOString(),
            page,
            perPage,
          }))).map(c => normalizeCommitSummary(this.#instanceUrl(), projectPath, c))),
      overlay: item => item,
      filter: () => true,
      // Injected pending commits are newer than everything the remote lists (newest-first).
      comparator: () => -1,
      injectedItems: injected,
      pageSize,
    });
  }

  async mergeRequestCommits(logicalId: string, pageSize: number, gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabCommitSummary>> {
    const projectPath = this.#projectPath();
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${logicalId} is no longer available.`);
      // Not on GitLab yet: when the source branch has queued pushes the spliced simulation is the
      // truth; otherwise the branch comparison is.
      const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, action.options.targetBranch, action.options.sourceBranch);
      if (simulated !== null) return new ArrayCursor(simulated.commitSummaries, pageSize);
      const compare = await this.#compareCached(action.options.targetBranch, action.options.sourceBranch);
      return new ArrayCursor(compare.commits, pageSize);
    }
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    // An existing merge request whose source branch has queued pushes lists the simulated
    // comparison instead of the remote pages (a force push may even have replaced the listed
    // history, so splicing pages with the pending chain would misreport it).
    if (gitCache !== undefined && this.#pendingPushActions().length > 0) {
      const mr = await this.#getRawMergeRequest(realId);
      if (mr.source_project_id === mr.target_project_id && this.#pendingPushActions(mr.source_branch).length > 0) {
        const simulated = await this.#simulatedMergeRequestComparisonOrWarn(gitCache, mr.target_branch, mr.source_branch);
        if (simulated !== null) return new ArrayCursor(simulated.commitSummaries, pageSize);
      }
    }
    // GitLab lists a merge request's commits newest first and the agent-facing order is oldest
    // first, so the whole list is read and reversed rather than streamed. Nothing bounds it but
    // the merge request itself; a pathological one costs pages, not correctness.
    const commits = await this.#cached(this.#cacheKey("mr-commits", realId), LIST_CACHE_TTL_MS, async () =>
      (await this.#fetchAllPages((page, perPage) =>
        this.#withApi(api => api.listMergeRequestCommits(projectPath, Number(realId), page, perPage))))
        .map(c => normalizeCommitSummary(this.#instanceUrl(), projectPath, c))
        .toReversed());
    return new ArrayCursor(commits, pageSize);
  }

  // -- action records (write side) --------------------------------------------------------

  #nextCounter(name: string): number {
    const key = `counter:${name}`;
    const value = (this.ctx.storage.kv.get<number>(key) ?? 0) + 1;
    this.ctx.storage.kv.put(key, value);
    return value;
  }

  #nextActionId(): number {
    return this.#nextCounter("action");
  }

  #nextProvisionalResourceId(): string {
    return `~${this.#nextCounter("resource")}`;
  }

  #nextProvisionalCommentId(prefix: string): string {
    return `~${prefix}${this.#nextCounter(prefix)}`;
  }

  #actionRecordKey(approvalId: number): string {
    return `action:${approvalId}`;
  }

  #retiredActionRecordKey(approvalId: number): string {
    return `retiredAction:${approvalId}`;
  }

  #getActionRecord(approvalId: number): StoredActionRecord | undefined {
    return this.ctx.storage.kv.get<StoredActionRecord>(this.#actionRecordKey(approvalId))
      ?? this.ctx.storage.kv.get<StoredActionRecord>(this.#retiredActionRecordKey(approvalId));
  }

  #requireActionRecord(approvalId: number): StoredActionRecord {
    const record = this.#getActionRecord(approvalId);
    if (!record) throw new Error(`No queued GitLab action exists with id ${approvalId}.`);
    return record;
  }

  #putActionRecord(approvalId: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.put(this.#actionRecordKey(approvalId), record);
    this.#pendingActionsCache = undefined;
  }

  #retireActionRecord(approvalId: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.delete(this.#actionRecordKey(approvalId));
    this.ctx.storage.kv.put(this.#retiredActionRecordKey(approvalId), record);
    this.#pendingActionsCache = undefined;
  }

  #stageAction(action: GitLabAction): void {
    this.#putActionRecord(action.approvalId, { action, state: "staged" });
  }

  #markActionPending(action: GitLabAction): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "pending";
    this.#putActionRecord(action.approvalId, record);
    if (action.type === "createIssue" || action.type === "createMergeRequest") {
      this.#setProvisionalResource(action.provisionalId, {
        kind: action.type === "createIssue" ? "issue" : "mergeRequest",
      });
    }
  }

  #markActionApproved(action: GitLabAction, revertInfo?: GitLabRevertInfo): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "approved";
    record.appliedAt = Date.now();
    if (revertInfo) record.revertInfo = revertInfo;
    this.#retireActionRecord(action.approvalId, record);
  }

  #markActionRejected(action: GitLabAction): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "rejected";
    record.rejectedAt = Date.now();
    this.#retireActionRecord(action.approvalId, record);
  }

  #setProvisionalResource(id: string, record: StoredProvisionalResource): void {
    this.ctx.storage.kv.put(`provisional:${id}`, record);
  }

  #actionDependsOnResource(action: GitLabAction, kind: EntityKind, provisionalId: string): boolean {
    switch (action.type) {
      case "createIssue":
      case "createMergeRequest":
        return action.provisionalId === provisionalId;
      case "setTitle": case "setBody": case "addLabels": case "removeLabels": case "changeState": case "postComment":
        return action.targetKind === kind && action.targetId === provisionalId;
      case "postReview": case "replyToDiffComment": case "resolveDiffThread": case "mergeMergeRequest":
        return kind === "mergeRequest" && action.mergeRequestId === provisionalId;
      case "push":
        return false;  // pushes target a branch, never an issue or merge request
    }
  }

  #rejectActionsForResource(kind: EntityKind, provisionalId: string): void {
    for (const pending of this.#listPendingActions()) {
      if (this.#actionDependsOnResource(pending, kind, provisionalId)) {
        this.#markActionRejected(pending);
      }
    }
  }

  /**
   * Cascade for a rejected push: reject every queued `createMergeRequest` whose source or target
   * branch no longer exists on the remote or as the outcome of the remaining queued pushes, along
   * with everything queued against the doomed merge request. Returns whether anything cascaded.
   */
  async #rejectMergeRequestsForMissingBranches(): Promise<boolean> {
    let cascaded = false;
    for (const pending of this.#listPendingActions()) {
      if (pending.type !== "createMergeRequest") continue;
      for (const branch of [pending.options.sourceBranch, pending.options.targetBranch]) {
        const real = (await this.#withApi(api => api.getBranch(this.#projectPath(), branch)))?.commit.id ?? null;
        if (this.#simulateBranchHead(branch, real) === null) {
          this.#markActionRejected(pending);
          this.#rejectActionsForResource("mergeRequest", pending.provisionalId);
          this.ctx.storage.kv.delete(`provisional:${pending.provisionalId}`);
          cascaded = true;
          break;
        }
      }
    }
    return cascaded;
  }

  #rejectReplyDependencyChain(rootCommentIds: string[]): void {
    const pendingReplies = this.#listPendingActions()
      .filter((action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment");
    const queue = [...rootCommentIds];
    const seen = new Set<string>(rootCommentIds);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const reply of pendingReplies) {
        if (reply.commentId === current) {
          this.#markActionRejected(reply);
          if (!seen.has(reply.provisionalCommentId)) {
            seen.add(reply.provisionalCommentId);
            queue.push(reply.provisionalCommentId);
          }
        }
      }
    }
  }

  #realIdOf(targetId: string): string | undefined {
    return targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
  }

  #requireRealId(targetId: string, what = "Target"): string {
    const realId = this.#realIdOf(targetId);
    if (!realId) throw new Error(`${what} ${targetId} has not been created on GitLab yet.`);
    return realId;
  }

  async #currentState(kind: EntityKind, targetId: string): Promise<GitLabIssueState> {
    // Pending state changes win over the remote (the caller sees the simulated world).
    const latest = [...this.#pendingActionsForEntity(kind, targetId)].toReversed()
      .find((action): action is ChangeStateAction | MergeMergeRequestAction =>
        action.type === "changeState" || action.type === "mergeMergeRequest");
    if (latest?.type === "changeState") return latest.state;
    if (latest?.type === "mergeMergeRequest") return "closed";
    const details = kind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getMergeRequestDetails(targetId);
    return details.state === "opened" ? "opened" : "closed";
  }

  // -- submit -----------------------------------------------------------------------------

  async submitActionForApproval(
    approvalQueue: RpcStub<ApprovalQueue>, action: GitLabAction, description: ActionDescription,
  ): Promise<void> {
    this.#stageAction(action);
    try {
      await approvalQueue.submitAction(action.approvalId, description);
    } catch (error) {
      this.ctx.storage.kv.delete(this.#actionRecordKey(action.approvalId));
      this.#pendingActionsCache = undefined;
      throw error;
    }
    this.#markActionPending(action);
    this.#clearCaches();
  }

  // -- prepare ----------------------------------------------------------------------------

  #base() {
    return { approvalId: this.#nextActionId(), submittedAt: Date.now(), projectPath: this.#projectPath() };
  }

  /**
   * Assignees are usernames in the API and ids on GitLab; resolving them here (an observation
   * the session records) means a typo fails now, not at apply.
   */
  async #resolveAssigneeIds(usernames: string[] | undefined): Promise<number[]> {
    const ids: number[] = [];
    for (const username of usernames ?? []) {
      const users = await this.#withApi(api => api.findUsersByUsername(username));
      const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!user) throw new Error(`No GitLab user named "${username}" exists on this instance.`);
      ids.push(user.id);
    }
    return ids;
  }

  async prepareCreateIssue(options: GitLabCreateIssueOptions): Promise<CreateIssueAction> {
    const assigneeIds = await this.#resolveAssigneeIds(options.assignees);
    return { type: "createIssue", ...this.#base(), provisionalId: this.#nextProvisionalResourceId(), options, assigneeIds };
  }

  async prepareCreateMergeRequest(options: GitLabCreateMergeRequestOptions): Promise<CreateMergeRequestAction> {
    // Queue-time validation: both branches must exist -- on the remote, or as the not-yet-applied
    // outcome of queued pushes. Failing here surfaces a typo'd or forgotten-to-push branch to the
    // caller immediately, instead of queuing an action GitLab will later refuse.
    for (const [role, branch] of [["source", options.sourceBranch], ["target", options.targetBranch]] as const) {
      const real = await this.#getBranchHeadCached(branch);
      if (this.#simulateBranchHead(branch, real) === null) {
        throw new Error(role === "source"
          ? `Cannot create a merge request from branch "${branch}": the branch does not exist in ` +
            `${this.#projectPath()}. Push your commits to the branch first (see push()), then create the merge request.`
          : `Cannot create a merge request into branch "${branch}": the target branch does not exist in ${this.#projectPath()}.`);
      }
    }
    return { type: "createMergeRequest", ...this.#base(), provisionalId: this.#nextProvisionalResourceId(), options };
  }

  async #detailsOf(kind: EntityKind, targetId: string) {
    return kind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getMergeRequestDetails(targetId);
  }

  async prepareSetTitle(targetKind: EntityKind, targetId: string, title: string): Promise<SetTitleAction> {
    const details = await this.#detailsOf(targetKind, targetId);
    return { type: "setTitle", ...this.#base(), targetKind, targetId, title, previousTitle: details.title };
  }

  async prepareSetBody(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<SetBodyAction> {
    const details = await this.#detailsOf(targetKind, targetId);
    return { type: "setBody", ...this.#base(), targetKind, targetId, bodyMarkdown, previousBodyMarkdown: details.bodyMarkdown };
  }

  async prepareAddLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<AddLabelsAction> {
    const details = await this.#detailsOf(targetKind, targetId);
    return { type: "addLabels", ...this.#base(), targetKind, targetId, labels, previousLabels: details.labels.map(l => l.name) };
  }

  async prepareRemoveLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<RemoveLabelsAction> {
    const details = await this.#detailsOf(targetKind, targetId);
    return { type: "removeLabels", ...this.#base(), targetKind, targetId, labels, previousLabels: details.labels.map(l => l.name) };
  }

  async prepareChangeState(targetKind: EntityKind, targetId: string, state: GitLabIssueState): Promise<ChangeStateAction> {
    if (targetKind === "mergeRequest") {
      const details = await this.#getMergeRequestDetails(targetId);
      if (details.state === "merged") {
        throw new Error(`Merge request !${targetId} has been merged and cannot be ${state === "closed" ? "closed" : "reopened"}.`);
      }
    }
    const previousState = await this.#currentState(targetKind, targetId);
    return { type: "changeState", ...this.#base(), targetKind, targetId, state, previousState };
  }

  async preparePostComment(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<PostCommentAction> {
    return {
      type: "postComment", ...this.#base(), targetKind, targetId, bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("comment"),
    };
  }

  async preparePostReview(mergeRequestId: string, review: GitLabMergeRequestReviewDraft): Promise<PostReviewAction> {
    if (review.decision !== "approve" && !review.bodyMarkdown && !(review.diffComments?.length)) {
      // Nothing to publish: an approval still approves, but a comment or requestChanges review
      // with no comments would make no request at all -- GitLab records `reviewer_state` only on
      // a `bulk_publish`, and an empty one is a no-op it would be a lie to retire as done.
      throw new Error(`A ${review.decision} review needs a summary comment or at least one diff comment.`);
    }
    return {
      type: "postReview", ...this.#base(), mergeRequestId,
      provisionalReviewId: this.#nextProvisionalCommentId("review"),
      review: {
        ...review,
        diffComments: review.diffComments?.map(comment => ({
          ...comment, provisionalCommentId: this.#nextProvisionalCommentId("diff"),
        })),
      },
    };
  }

  async prepareReplyToDiffComment(mergeRequestId: string, commentId: string, bodyMarkdown: string): Promise<ReplyToDiffCommentAction> {
    return {
      type: "replyToDiffComment", ...this.#base(), mergeRequestId, commentId, bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("reply"),
    };
  }

  async prepareResolveDiffThread(mergeRequestId: string, threadId: string, resolved: boolean): Promise<ResolveDiffThreadAction> {
    return { type: "resolveDiffThread", ...this.#base(), mergeRequestId, threadId, resolved };
  }

  /**
   * Binds the head the merge is approved against (an observation the session records): without
   * it, commits pushed between approval and apply -- a collaborator's, or the agent's own
   * through another approved push -- would merge unreviewed. For a provisional merge request
   * this is the simulated source head, the head it will have once created.
   */
  async prepareMergeMergeRequest(mergeRequestId: string, options?: GitLabMergeRequestMergeOptions): Promise<MergeMergeRequestAction> {
    const details = await this.#getMergeRequestDetails(mergeRequestId);
    const expectedHeadSha = options?.expectedHeadSha ?? (details.source.sha || undefined);
    if (expectedHeadSha === undefined) {
      // A provisional merge request whose source head could not be simulated reads an empty sha
      // (its comparison degraded). Queuing anyway would send the merge without `sha`, and the
      // approval would then cover whatever the branch holds when it applies -- the one thing the
      // binding exists to prevent. Refuse instead; the head is knowable once the reads recover.
      throw new Error(
        `Merge request ${mergeRequestId.startsWith("~") ? mergeRequestId : `!${mergeRequestId}`}'s source head could not be ` +
        "determined, so the merge cannot be bound to a reviewed state. Re-read the merge request and try again, " +
        "or pass expectedHeadSha.");
    }
    return { type: "mergeMergeRequest", ...this.#base(), mergeRequestId, options, expectedHeadSha };
  }

  // -- apply ------------------------------------------------------------------------------

  async applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void> {
    const record = this.#requireActionRecord(actionId);
    if (record.state === "approved") {
      // Already applied: the overseer records completion only after this method returns, so a
      // crash or lost reply in that window re-delivers the apply. The durable record answers it
      // -- a desired-state re-check could not, since the world may have legitimately moved on --
      // and throwing would strand the action as forever un-appliable.
      return;
    }
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitLab action ${actionId} is no longer pending.`);
    }
    const action = record.action;
    const projectPath = this.#projectPath();

    switch (action.type) {
      case "createIssue": {
        const response = await this.#withApi(api => api.createIssue(projectPath, {
          title: action.options.title,
          description: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
          labels: action.options.labels,
          assignee_ids: action.assigneeIds.length > 0 ? action.assigneeIds : undefined,
        }));
        this.#setProvisionalResource(action.provisionalId, { kind: "issue", realId: String(response.iid) });
        break;
      }
      case "createMergeRequest": {
        let response;
        try {
          response = await this.#withApi(api => api.createMergeRequest(projectPath, {
            source_branch: action.options.sourceBranch,
            target_branch: action.options.targetBranch,
            title: action.options.draft ? withDraftPrefix(action.options.title) : action.options.title,
            description: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
            remove_source_branch: action.options.removeSourceBranch,
            squash: action.options.squash,
          }));
        } catch (error) {
          // The typical cause is ordering: the merge request was queued against a branch whose
          // push is still awaiting approval, and this action was approved first. It stays
          // pending; applying it again after the push works.
          if (error instanceof GitLabApiError && (error.status === 400 || error.status === 409 || error.status === 422) &&
              this.#pendingPushActions(action.options.sourceBranch).length > 0) {
            throw new Error(
              `Cannot create this merge request yet: branch "${action.options.sourceBranch}" has a queued ` +
              `push that has not been applied. Approve the push to "${action.options.sourceBranch}" first, ` +
              `then approve this merge request.`, { cause: error });
          }
          throw error;
        }
        this.#setProvisionalResource(action.provisionalId, { kind: "mergeRequest", realId: String(response.iid) });
        break;
      }
      case "setTitle": {
        const realId = this.#requireRealId(action.targetId);
        await this.#updateIssuable(action.targetKind, realId, { title: action.title });
        break;
      }
      case "setBody": {
        const realId = this.#requireRealId(action.targetId);
        await this.#updateIssuable(action.targetKind, realId, { description: this.#rewriteKnownReferences(action.bodyMarkdown, true) });
        break;
      }
      case "addLabels": {
        const realId = this.#requireRealId(action.targetId);
        await this.#updateIssuable(action.targetKind, realId, { add_labels: action.labels });
        break;
      }
      case "removeLabels": {
        const realId = this.#requireRealId(action.targetId);
        await this.#updateIssuable(action.targetKind, realId, { remove_labels: action.labels });
        break;
      }
      case "changeState": {
        const realId = this.#requireRealId(action.targetId);
        await this.#updateIssuable(action.targetKind, realId, { state_event: action.state === "closed" ? "close" : "reopen" });
        break;
      }
      case "postComment": {
        const realId = this.#requireRealId(action.targetId);
        const note = await this.#withApi(api => api.createNote(
          projectPath, apiKind(action.targetKind), Number(realId), this.#rewriteKnownReferences(action.bodyMarkdown, true)));
        this.#markActionApproved(action, { type: "note", kind: action.targetKind, noteId: note.id });
        this.#clearCaches();
        return;
      }
      case "postReview": {
        await this.#publishReview(record, action);
        break;
      }
      case "replyToDiffComment": {
        const realId = this.#requireRealId(action.mergeRequestId, "Merge request");
        const discussionId = await this.#resolveReplyTarget(realId, action.commentId);
        const note = await this.#withApi(api => api.addDiscussionNote(
          projectPath, Number(realId), discussionId, this.#rewriteKnownReferences(action.bodyMarkdown, true)));
        this.ctx.storage.kv.put(`diffAlias:${action.provisionalCommentId}`, String(note.id));
        this.#markActionApproved(action, { type: "note", kind: "mergeRequest", noteId: note.id });
        this.#clearCaches();
        return;
      }
      case "resolveDiffThread": {
        const realId = this.#requireRealId(action.mergeRequestId, "Merge request");
        await this.#withApi(api => api.setDiscussionResolved(projectPath, Number(realId), action.threadId, action.resolved));
        break;
      }
      case "mergeMergeRequest": {
        const realId = this.#requireRealId(action.mergeRequestId, "Merge request");
        await this.#mergeMergeRequest(realId, action.options, action.expectedHeadSha);
        break;
      }
      case "push": {
        // No gatekeeper-side object walk: the overseer composes the pack from the action's
        // pending-push marks (`cache.buildPack()` on the action-scoped stub), and this side
        // contributes only send-pack framing plus the ref-update command. The command's old-sha
        // is the queue-time `expectedOldSha` -- receive-pack's compare-and-swap applies to every
        // update, force or not (fast-forward policy was already enforced at queue time), so a
        // branch that moved between approval and apply fails cleanly instead of being clobbered.
        try {
          const pack = await cache.buildPack();
          await this.#withApi(api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(projectPath, body),
            { branch: action.branch, oldSha: action.expectedOldSha, newSha: action.newSha },
            pack));
        } catch (error) {
          if (!(error instanceof GitRefUpdateRejectedError)) throw error;
          // Desired-state semantics: apply succeeds iff the branch ends up at newSha -- by our
          // CAS'd push, or by finding it already there (a retried apply whose first attempt
          // landed but crashed before this record was persisted, or a third party's
          // byte-identical push -- indistinguishable, and the approved end state holds either way).
          const head = (await this.#withApi(api => api.getBranch(projectPath, action.branch)))?.commit.id ?? null;
          if (head !== action.newSha) {
            // GitLab's pre-receive hooks (protected branches, push rules) explain themselves in
            // the report-status line; that reason is passed through, never matched.
            throw new Error(action.expectedOldSha === ZERO_OID
              ? `The push cannot be applied: a branch named "${action.branch}" was created after this push ` +
                `was queued (the push would have created it). Re-observe the branch and queue a fresh push ` +
                `against its current head. GitLab said: ${error.reason}`
              : `The push cannot be applied: branch "${action.branch}" has moved from ${action.expectedOldSha}, ` +
                `the head it was approved against, or GitLab refused it. Re-observe the branch and queue a ` +
                `fresh push against its current head. GitLab said: ${error.reason}`,
              { cause: error });
          }
        }
        break;
      }
    }

    this.#markActionApproved(action);
    this.#clearCaches();
  }

  async #updateIssuable(kind: EntityKind, realId: string, patch: {
    title?: string; description?: string; state_event?: "close" | "reopen"; add_labels?: string[]; remove_labels?: string[];
  }): Promise<void> {
    const projectPath = this.#projectPath();
    await this.#withApi<unknown>(api => kind === "issue"
      ? api.updateIssue(projectPath, Number(realId), patch)
      : api.updateMergeRequest(projectPath, Number(realId), patch));
  }

  /** `PUT …/merge`, translating GitLab's documented failure codes into agent-actionable reasons. */
  async #mergeMergeRequest(
    realId: string, options: GitLabMergeRequestMergeOptions | undefined, expectedHeadSha: string,
  ): Promise<void> {
    const projectPath = this.#projectPath();
    try {
      await this.#withApi(api => api.mergeMergeRequest(projectPath, Number(realId), {
        squash: options?.squash,
        should_remove_source_branch: options?.removeSourceBranch,
        merge_commit_message: options?.commitMessage,
        squash_commit_message: options?.squashCommitMessage,
        sha: expectedHeadSha,
      }));
    } catch (error) {
      if (!(error instanceof GitLabApiError)) throw error;
      switch (error.status) {
        case 405: {
          // "Cannot merge": re-read the merge status so the message names the reason.
          let status = "unknown";
          try {
            status = (await this.#withApi(api => api.getMergeRequest(projectPath, Number(realId)))).detailed_merge_status ?? status;
          } catch {}
          const reason = status === "ci_must_pass" || status === "ci_still_running"
            ? "the pipeline has not passed yet; pipeline status is not available through this connection -- check it in GitLab"
            : `GitLab reports ${status}`;
          throw new Error(`Merge request !${realId} cannot be merged: ${reason}.`, { cause: error });
        }
        case 409:
          throw new Error(`Merge request !${realId}'s head has moved from ${expectedHeadSha} ` +
            "since the merge was queued; re-read it and merge again so the new commits are reviewed.", { cause: error });
        case 422:
          throw new Error(`Merge request !${realId}'s branch cannot be merged (GitLab: ${error.message}).`, { cause: error });
        case 401:
          throw new Error(`The connected GitLab account is not allowed to merge !${realId}.`, { cause: error });
        default:
          throw error;
      }
    }
  }

  /**
   * Resolve the discussion a reply belongs to. A reply may target a not-yet-applied reply (a
   * chain of provisional ids), an alias recorded when its review was published, or a real note
   * id, whose discussion is found in the merge request's discussions.
   */
  async #resolveReplyTarget(realId: string, commentId: string): Promise<string> {
    const pendingReplies = new Map(this.#listPendingActions()
      .filter((action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment")
      .map(action => [action.provisionalCommentId, action]));

    let resolved = commentId;
    const seen = new Set<string>();
    while (pendingReplies.has(resolved)) {
      if (seen.size >= MAX_REPLY_TARGET_HOPS) throw new Error(`Reply chain for diff comment ${commentId} exceeded ${MAX_REPLY_TARGET_HOPS} hops.`);
      if (seen.has(resolved)) throw new Error(`Reply chain for diff comment ${commentId} contains a cycle.`);
      seen.add(resolved);
      resolved = pendingReplies.get(resolved)!.commentId;
    }

    const aliased = this.ctx.storage.kv.get<string>(`diffAlias:${resolved}`) ?? resolved;
    if (aliased.startsWith("~")) throw new Error(`Diff comment ${resolved} has not been created on GitLab yet.`);

    // Bypass the TTL cache: a reply may follow a publish within the same window.
    const discussions = await this.#fetchAllPages((page, perPage) =>
      this.#withApi(api => api.listMergeRequestDiscussions(this.#projectPath(), Number(realId), page, perPage)));
    const discussion = discussions.find(d => d.id === aliased || d.notes.some(note => String(note.id) === aliased));
    if (!discussion) throw new Error(`Diff comment ${commentId} was not found on merge request !${realId}.`);
    return discussion.id;
  }

  /**
   * The `position` for a draft diff note, from the agent-facing target and the review's
   * revision. `files` is the merge request's diff, fetched once per review: GitLab wants both
   * paths always (for a renamed file the old path comes from the diff), and the line's kind
   * decides how it is named -- an added line by `new_line` alone, a removed line by `old_line`
   * alone, and an *unchanged* line by both (its number on each side, which differ once earlier
   * hunks have shifted them). Naming an unchanged line by one side is the documented way to get
   * a rejected or mis-anchored note, so the hunk walk that knows the kind supplies both numbers.
   * A line the diff does not contain falls back to the caller's one-sided naming and lets GitLab
   * judge it.
   */
  async #positionFor(
    files: GitLabDiffResponse[], target: GitLabDiffCommentTarget, revision: GitLabMergeRequestRevision,
  ): Promise<GitLabPositionRequest> {
    const file = files.find(f => f.new_path === target.path || f.old_path === target.path);
    const newPath = file?.new_path ?? target.path;
    const oldPath = file?.old_path ?? target.path;
    const shas = {
      // Our names are GitHub's; GitLab's are inverted (see revisionFromDiffRefs).
      base_sha: revision.mergeBaseSha ?? revision.baseSha,
      start_sha: revision.baseSha,
      head_sha: revision.headSha,
    };
    if (target.subjectType === "file") {
      return { ...shas, position_type: "file", old_path: oldPath, new_path: newPath };
    }
    const hunks = file?.diff ? normalizeDiffFile(file).hunks : [];
    const end = diffLinePositions(hunks, target.side, target.line);
    const position: GitLabPositionRequest = {
      ...shas,
      position_type: "text",
      old_path: oldPath,
      new_path: newPath,
      ...(end?.kind === "context" ? { old_line: end.oldLine, new_line: end.newLine }
        : target.side === "new" ? { new_line: target.line } : { old_line: target.line }),
    };
    if (target.startLine !== undefined && end) {
      const startSide = target.startSide ?? target.side;
      const start = diffLinePositions(hunks, startSide, target.startLine);
      if (start) {
        position.line_range = {
          start: { line_code: await lineCode(newPath, start.oldLine, start.newLine), type: startSide },
          end: { line_code: await lineCode(newPath, end.oldLine, end.newLine), type: target.side },
        };
      }
    }
    return position;
  }

  /**
   * Publish a review through GitLab's draft notes: `approve` first when the decision is
   * `approve`, then one draft per diff comment, then a publish that carries the summary and
   * reviewer state.
   *
   * Every step records itself on the action record before the next begins, because `applyAction`
   * owes the queue idempotence (a failure is offered a retry) and this is the one action GitLab
   * makes multi-call. Approval is the step with a compare-and-swap -- `sha` is the reviewed head,
   * and GitLab answers 409 if the head has moved -- and the one whose failure is *expected*, so it
   * runs before anything is posted: a stale head fails the action clean and a retry fails it
   * again until the agent re-reads, rather than publishing the comments once per attempt. A
   * retry then skips the comments already published, deletes the drafts it created but never
   * published (GitLab keeps them parked, visible only to the user; mistaking them for the user's
   * would send the retry down the individual-publish path below and lose the reviewer state),
   * recreates the rest, and posts the summary only if it has not.
   *
   * `bulk_publish` publishes every draft the user has on the merge request -- a human's parked
   * drafts included -- so when foreign drafts exist ours are published one by one and the
   * summary posts as a plain note. That path cannot set the reviewer state, which for `comment`
   * and `approve` is cosmetic but for `requestChanges` *is* the review: that decision refuses,
   * before anything is posted, until the user publishes or discards their own drafts. The
   * foreign set is read twice -- once to clear our leftovers, and again just before publishing,
   * so a draft the user started while the comments were being created is not swept up; the one
   * round trip between that read and the publish is the window GitLab's API leaves.
   */
  async #publishReview(record: StoredActionRecord, action: PostReviewAction): Promise<void> {
    const realId = this.#requireRealId(action.mergeRequestId, "Merge request");
    const projectPath = this.#projectPath();
    const iid = Number(realId);
    const review = action.review;
    const comments = review.diffComments ?? [];
    const progress = record.progress ?? {};
    const save = () => {
      record.progress = progress;
      this.#putActionRecord(action.approvalId, record);
    };

    if (review.decision === "approve" && !progress.approved) {
      await this.#withApi(api => api.approveMergeRequest(projectPath, iid, review.revision.headSha));
      progress.approved = true;
      save();
    }

    // The user's parked drafts, as distinct from ours. A requestChanges review refuses over them
    // (see above) -- the first time before anything of its own is posted, the second with its own
    // drafts created and recorded, which the retry clears.
    const foreignDrafts = async (ours: Set<number>) => {
      const foreign = (await this.#withApi(api => api.listDraftNotes(projectPath, iid))).filter(draft => !ours.has(draft.id));
      if (review.decision === "requestChanges" && foreign.length > 0) {
        throw new Error(
          `Cannot request changes on !${realId}: you have ${foreign.length} unpublished draft comment${foreign.length === 1 ? "" : "s"} ` +
          "of your own on it in GitLab, and publishing this review would publish those too. Publish or delete them there first.");
      }
      return foreign;
    };

    // Leftovers of an earlier attempt: ours to clear before the user's drafts are counted.
    const leftovers = progress.draftIds ?? [];
    let foreign = await foreignDrafts(new Set(leftovers));
    for (const draftId of leftovers) {
      await this.#withApi(api => api.deleteDraftNote(projectPath, iid, draftId));
    }
    progress.draftIds = [];
    save();

    const published = progress.publishedComments ?? 0;
    const pending = comments.slice(published);
    const files = pending.length > 0
      ? await this.#fetchAllPages((page, perPage) =>
          this.#withApi(api => api.listMergeRequestDiffs(projectPath, iid, page, perPage)))
      : [];
    const created: number[] = [];
    for (const comment of pending) {
      const body = this.#rewriteKnownReferences(comment.bodyMarkdown, true);
      const position = await this.#positionFor(files, comment.target, review.revision);
      const draft = await this.#withApi(api => api.createDraftNote(projectPath, iid, { note: body, position }));
      created.push(draft.id);
      progress.draftIds = [...created];
      save();
    }

    const summary = review.bodyMarkdown && !progress.summaryPosted
      ? this.#rewriteKnownReferences(review.bodyMarkdown, true) : undefined;
    const reviewerState = review.decision === "requestChanges" ? "requested_changes" : "reviewed";
    // Re-read just before publishing: the drafts above took time to create.
    if (created.length > 0 || summary) foreign = await foreignDrafts(new Set(created));
    if (foreign.length === 0) {
      if (created.length > 0 || summary) {
        await this.#withApi(api => api.bulkPublishDraftNotes(projectPath, iid, { note: summary, reviewer_state: reviewerState }));
        progress.publishedComments = comments.length;
        progress.draftIds = [];
        if (summary) progress.summaryPosted = true;
        save();
      }
    } else {
      logger.warn("publishing review drafts individually: the account has other drafts on this merge request", {
        event: "merge.request.review.foreign.drafts",
      });
      for (const [index, draftId] of created.entries()) {
        await this.#withApi(api => api.publishDraftNote(projectPath, iid, draftId));
        progress.publishedComments = published + index + 1;
        progress.draftIds = created.slice(index + 1);
        save();
      }
      if (summary) {
        await this.#withApi(api => api.createNote(projectPath, "merge_requests", iid, summary));
        progress.summaryPosted = true;
        save();
      }
    }
  }

  // -- reject and revert ------------------------------------------------------------------

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitLab action ${actionId} is no longer pending.`);
    }

    if (action.type === "postReview") {
      // A discarded review that had got partway (approve runs first; drafts are created one by
      // one; a later step failed): take the approval back and clear the parked drafts, so
      // discarding leaves nothing unpublished behind on GitLab. Comments already published stay,
      // as the action's `implementsRevert: false` says. Before the record is retired: a cleanup
      // that fails leaves the action pending, so the discard can be retried rather than stranding
      // the approval.
      const realId = this.#realIdOf(action.mergeRequestId);
      if (realId) {
        if (record.progress?.approved) {
          await this.#withApi(api => api.unapproveMergeRequest(this.#projectPath(), Number(realId)));
        }
        for (const draftId of record.progress?.draftIds ?? []) {
          await this.#withApi(api => api.deleteDraftNote(this.#projectPath(), Number(realId), draftId));
        }
      }
    }

    this.#markActionRejected(action);
    if (action.type === "createIssue" || action.type === "createMergeRequest") {
      this.#rejectActionsForResource(action.type === "createIssue" ? "issue" : "mergeRequest", action.provisionalId);
      this.ctx.storage.kv.delete(`provisional:${action.provisionalId}`);
      this.#clearCaches();
      return { restart: true };
    }

    if (action.type === "push") {
      const cascaded = await this.#rejectMergeRequestsForMissingBranches();
      this.#clearCaches();
      return cascaded ? { restart: true } : undefined;
    }

    if (action.type === "postReview") {
      this.#rejectReplyDependencyChain((action.review.diffComments ?? []).map(comment => comment.provisionalCommentId));
    } else if (action.type === "replyToDiffComment") {
      this.#rejectReplyDependencyChain([action.provisionalCommentId]);
    }

    this.#clearCaches();
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    const gone = { message: "The target resource no longer exists on GitLab.", canRetry: false };
    switch (action.type) {
      case "setTitle": {
        const realId = this.#realIdOf(action.targetId);
        if (!realId) return gone;
        await this.#updateIssuable(action.targetKind, realId, { title: action.previousTitle });
        break;
      }
      case "setBody": {
        const realId = this.#realIdOf(action.targetId);
        if (!realId) return gone;
        await this.#updateIssuable(action.targetKind, realId, { description: action.previousBodyMarkdown });
        break;
      }
      case "addLabels": {
        const realId = this.#realIdOf(action.targetId);
        if (!realId) return gone;
        // Only the labels the action introduced: one that was already there stays.
        const introduced = action.labels.filter(label => !hasLabel(action.previousLabels, label));
        if (introduced.length > 0) await this.#updateIssuable(action.targetKind, realId, { remove_labels: introduced });
        break;
      }
      case "removeLabels": {
        const realId = this.#realIdOf(action.targetId);
        if (!realId) return gone;
        // Only the labels the action removed: one that was never there is not added.
        const removed = action.labels.filter(label => hasLabel(action.previousLabels, label));
        if (removed.length > 0) await this.#updateIssuable(action.targetKind, realId, { add_labels: removed });
        break;
      }
      case "changeState": {
        const realId = this.#realIdOf(action.targetId);
        if (!realId) return gone;
        await this.#updateIssuable(action.targetKind, realId, { state_event: action.previousState === "closed" ? "close" : "reopen" });
        break;
      }
      case "postComment":
      case "replyToDiffComment": {
        const info = record.revertInfo;
        if (info?.type !== "note") return { message: "Missing note revert information.", canRetry: false };
        const realId = this.#realIdOf(action.type === "postComment" ? action.targetId : action.mergeRequestId);
        if (!realId) return gone;
        await this.#withApi(api => api.deleteNote(this.#projectPath(), apiKind(info.kind), Number(realId), info.noteId));
        break;
      }
      case "resolveDiffThread": {
        const realId = this.#realIdOf(action.mergeRequestId);
        if (!realId) return gone;
        await this.#withApi(api => api.setDiscussionResolved(this.#projectPath(), Number(realId), action.threadId, !action.resolved));
        break;
      }
      case "push": {
        // Ref rollback: move the branch back to the head the user approved pushing it from
        // (delete it, if the push created it). The command's old-sha is the pushed commit, so
        // work that landed on the branch after the push is never stomped -- the rollback then
        // fails cleanly instead. The pushed objects stay on the remote (they merely go dangling),
        // which is also why the rollback needs no pack contents: an empty pack accompanies the
        // update, and a deletion sends none (the protocol forbids it).
        const deleting = action.expectedOldSha === ZERO_OID;
        try {
          await this.#withApi(async api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(this.#projectPath(), body),
            { branch: action.branch, oldSha: action.newSha, newSha: deleting ? ZERO_OID : action.expectedOldSha },
            deleting ? null : bytesToStream(await emptyPackBytes())));
        } catch (error) {
          if (error instanceof GitRefUpdateRejectedError) {
            return {
              message: `Branch "${action.branch}" is no longer at the pushed commit ${action.newSha}, so it ` +
                `cannot be rolled back automatically (GitLab said: ${error.reason}). Reset the branch manually if needed.`,
              canRetry: false,
            };
          }
          throw error;
        }
        break;
      }
      case "createIssue":
      case "createMergeRequest":
      case "postReview":
      case "mergeMergeRequest":
        return { message: "This GitLab action cannot be automatically reverted.", canRetry: false };
    }
    this.#clearCaches();
  }

  // -- git: pull, push, and the simulation of queued pushes -------------------------------

  /**
   * `Gatekeeper.gitPull()`: fetch the requested objects from this project over git smart-HTTP
   * (protocol v2) and deposit them in the workspace git cache. The gatekeeper contributes only
   * protocol framing -- the kit's transport composes the fetch command from the hints and strips
   * the response down to the raw pack body, which streams into `cache.consumePack()` for
   * overseer-side decoding, hash verification, and storage -- and retains nothing locally.
   *
   * No observation is recorded: a pull is overseer-initiated population of the workspace cache
   * with objects whose commit ids were already returned (and advertised) by observed session
   * reads, not a new agent-visible read; observer access to the git data rides the same
   * project-level ACL as everything else here (strategy B).
   */
  async gitPull(oids: GitOid[], cache: RpcStub<GitCache>, hints: GitPullHints): Promise<void> {
    const projectPath = this.#projectPath();
    await this.#withApi(api => pullGitObjectsIntoCache(
      body => api.fetchGitUploadPack(projectPath, body), oids, hints, cache));
  }

  /**
   * Prepare a push action, binding the expected remote ref state at queue time: reads the
   * branch's current head (live, never cached -- the expectation must reflect the remote) and
   * overlays this project's earlier queued pushes (`#simulateBranchHead`: stacked pushes bind
   * each `expectedOldSha` to the previous push's `newSha`, so approving them in order applies
   * cleanly). Returns null when the (simulated) branch is already at `commitId`.
   *
   * A non-force push must be a fast-forward: `expectedOldSha` must be an ancestor of `commitId`,
   * checked here -- before anything is queued -- via `GitCache.isAncestor()`. Branch creation is
   * exempt (no old head to fast-forward from; the zero-id compare-and-swap at apply protects
   * against a branch appearing in the interim), and `force` skips only this policy check -- it
   * does not loosen the old-sha match at apply.
   */
  async preparePush(branch: string, commitId: GitOid, force: boolean, gitCache: RpcStub<GitCache>): Promise<PushAction | null> {
    const realHead = (await this.#withApi(api => api.getBranch(this.#projectPath(), branch)))?.commit.id ?? null;
    const expectedOldSha = this.#simulateBranchHead(branch, realHead) ?? ZERO_OID;
    if (expectedOldSha === commitId) return null;
    if (!force && expectedOldSha !== ZERO_OID && !(await gitCache.isAncestor(expectedOldSha, commitId))) {
      throw new Error(
        `Cannot push to branch "${branch}": its current head ${expectedOldSha} is not an ancestor of ` +
        `${commitId}, so this push is not a fast-forward -- the branch has moved past the head this work ` +
        `was based on. Pull the branch's new head and rebase onto it, or pass force: true to overwrite the branch.`);
    }
    return { type: "push", ...this.#base(), branch, expectedOldSha, newSha: commitId, force };
  }

  /** Whether GitLab knows this commit (the anchor test for pending-chain walks). */
  async #isCommitOnGitLab(oid: GitOid): Promise<boolean> {
    return (await this.#getRemoteCommitDetails(oid)) !== null;
  }

  /**
   * Walk a simulated branch head down to its **anchor** -- the first commit GitLab already knows
   * -- reading the not-yet-pushed commits from the workspace git cache (which serves this
   * gatekeeper's queued-push closure, pulling objects through on demand). Returns the pending
   * commits newest-first plus the anchor. The *listing* follows first parents, as GitLab's own
   * history view does; a chain that leaves the cache or bottoms out with no GitLab-known ancestor
   * throws, and callers degrade.
   *
   * The *served* set is wider than the listing: every parent of a pending commit that GitLab does
   * not have is recorded in `#servedSimulatedCommitIds` too, side parents of a local merge
   * included, because every summary names its parents and the session advertises what it names.
   * Advertising a not-yet-pushed side parent would tell the overseer the remote has it; the push
   * pack would then omit it (a remote-known object is not sent) and receive-pack would reject the
   * push for the missing object.
   */
  async #collectPendingChain(gitCache: RpcStub<GitCache>, head: GitOid): Promise<{
    commits: { summary: GitLabCommitSummary; tree: GitOid }[];
    anchor: GitOid;
  }> {
    // A push's expectedOldSha is usually known to GitLab without a probe: it was read from the
    // remote at queue time. Stacked pushes bind each expectedOldSha to the previous queued push's
    // newSha (a pending commit), so those are excluded and the walk continues to the real anchor.
    const pendingNewShas = new Set(this.#pendingPushActions().map(action => action.newSha));
    const knownShas = new Set(this.#pendingPushActions()
      .map(action => action.expectedOldSha)
      .filter(sha => sha !== ZERO_OID && !pendingNewShas.has(sha)));

    const onGitLab = async (oid: GitOid) => knownShas.has(oid) || await this.#isCommitOnGitLab(oid);
    const commits: { summary: GitLabCommitSummary; tree: GitOid }[] = [];
    const sideParents: GitOid[] = [];
    let current = head;
    while (commits.length <= MAX_PENDING_CHAIN_COMMITS) {
      if (await onGitLab(current)) {
        await this.#recordPendingSideParents(gitCache, sideParents, onGitLab);
        return { commits, anchor: current };
      }
      const object = await gitCache.get(current);
      if (object === null || object.type !== "commit") {
        throw new Error(`Commit ${current} is not available from the workspace git cache.`);
      }
      const parsed = parseGitCommitPayload(object.content, current);
      this.#servedSimulatedCommitIds.add(current);
      const instanceUrl = this.#instanceUrl();
      const projectPath = this.#projectPath();
      commits.push({
        summary: commitDetailsFromGitObject(current, object.content, id => `${instanceUrl}/${projectPath}/-/commit/${id}`),
        tree: parsed.tree,
      });
      if (parsed.parents.length === 0) {
        throw new Error(`Commit ${current} has no ancestor known to GitLab.`);
      }
      sideParents.push(...parsed.parents.slice(1));
      current = parsed.parents[0];
    }
    throw new Error(`More than ${MAX_PENDING_CHAIN_COMMITS} commits are queued for push.`);
  }

  /**
   * Mark every not-yet-pushed commit reachable through a local merge's side parents as served
   * (see `#collectPendingChain`), walking each side branch down to a commit GitLab has. Bounded
   * like the main chain; a side branch that leaves the cache is left unmarked (the push itself
   * would fail on the missing object, not silently advertise it).
   */
  async #recordPendingSideParents(
    gitCache: RpcStub<GitCache>, roots: GitOid[], onGitLab: (oid: GitOid) => Promise<boolean>,
  ): Promise<void> {
    const stack = [...roots];
    let visited = 0;
    while (stack.length > 0 && visited <= MAX_PENDING_CHAIN_COMMITS) {
      const oid = stack.pop()!;
      if (this.#servedSimulatedCommitIds.has(oid) || await onGitLab(oid)) continue;
      const object = await gitCache.get(oid);
      if (object === null || object.type !== "commit") continue;
      visited += 1;
      this.#servedSimulatedCommitIds.add(oid);
      stack.push(...parseGitCommitPayload(object.content, oid).parents);
    }
  }

  /**
   * The tree oid of a commit, from cached bytes when available. GitLab's REST API has no
   * object-by-oid read of a commit's tree, so an on-remote commit whose bytes the cache lacks
   * cannot be resolved -- the caller degrades.
   */
  async #treeOidOfCommit(gitCache: RpcStub<GitCache>, sha: GitOid): Promise<GitOid> {
    const object = await gitCache.get(sha);
    if (object !== null && object.type === "commit") {
      return parseGitCommitPayload(object.content, sha).tree;
    }
    throw new Error(`Could not resolve the tree of commit ${sha}: it is not in the workspace git cache.`);
  }

  /**
   * Object source for the simulated-diff tree walk: the workspace git cache first (the pending
   * side always resolves there -- the queued-push closure pulls through on demand). Blobs the
   * cache lacks come from GitLab's blob-by-sha endpoint; trees have no oid-addressed endpoint
   * (`/repository/tree` is path-and-ref addressed), so a missing tree is `null` and the walk
   * throws `TreeUnavailableError`, which callers degrade to the un-simulated remote read.
   */
  #treeDiffSource(gitCache: RpcStub<GitCache>): TreeDiffSource {
    const projectPath = this.#projectPath();
    return {
      getTree: async oid => {
        const object = await gitCache.get(oid);
        return object !== null && object.type === "tree" ? parseGitTreePayload(object.content, oid) : null;
      },
      getBlob: async oid => {
        const object = await gitCache.get(oid);
        if (object !== null && object.type === "blob") return object.content;
        const remote = await this.#withApi(api => api.getBlob(projectPath, oid, MAX_DIFF_BLOB_BYTES));
        return remote === null || remote === "oversized" ? "unavailable" : remote;
      },
    };
  }

  /**
   * The simulated `target...source` comparison for a merge request whose source branch has
   * queued pushes, computed as if those pushes had already landed: the head is the simulated
   * branch head, the commit list splices GitLab's `compare(target, anchor)` with the pending
   * chain, and the file diff is a local tree diff from the merge base to the simulated head
   * (GitLab cannot compute it -- the pending commits are not on the remote). Returns null when
   * no overlay applies (no cache, no queued pushes, or the remote has invalidated their
   * expectations), so callers fall through to the ordinary remote reads.
   *
   * Known gap: a queued push to the *target* branch is not overlaid here -- the comparison uses
   * the target branch's remote state.
   */
  async #simulatedMergeRequestComparison(
    gitCache: RpcStub<GitCache> | undefined, targetRef: string, sourceBranch: string,
  ): Promise<SimulatedMergeRequestComparison | null> {
    if (gitCache === undefined) return null;
    if (this.#pendingPushActions(sourceBranch).length === 0) return null;
    const realHead = await this.#getBranchHeadCached(sourceBranch);
    const simulatedHead = this.#simulateBranchHead(sourceBranch, realHead);
    if (simulatedHead === null || simulatedHead === realHead) return null;

    const cacheKey = this.#cacheKey("mr-simulated", stableKey(targetRef), simulatedHead);
    const cached = this.#loadCached<SimulatedMergeRequestComparison>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) {
      // The served-id set is in-memory; re-record the cached result's pending ids so this
      // instance's advertising filter covers them too.
      for (const id of cached.pendingCommitIds) this.#servedSimulatedCommitIds.add(id);
      return cached;
    }

    const generation = this.#cacheGeneration();
    const chain = await this.#collectPendingChain(gitCache, simulatedHead);
    const targetHead = await this.#getBranchHeadCached(targetRef);
    if (targetHead === null) throw new Error(`Target branch "${targetRef}" does not exist on GitLab.`);
    const [compare, mergeBase] = await Promise.all([
      this.#compareCached(targetRef, chain.anchor),
      this.#getMergeBaseCached(targetHead, chain.anchor),
    ]);

    const newTree = chain.commits.length > 0 ? chain.commits[0].tree : await this.#treeOidOfCommit(gitCache, simulatedHead);
    const files = await diffGitTrees(this.#treeDiffSource(gitCache), await this.#treeOidOfCommit(gitCache, mergeBase), newTree);

    const result: SimulatedMergeRequestComparison = {
      // The pending chain descends from the anchor without touching the target branch, so the
      // diff's merge base is the (target, anchor) one.
      revision: { baseSha: targetHead, headSha: simulatedHead, mergeBaseSha: mergeBase },
      files,
      totalCommits: compare.commits.length + chain.commits.length,
      // Oldest-first, like the merge request commit listing.
      commitSummaries: [...compare.commits, ...chain.commits.map(commit => commit.summary).toReversed()],
      pendingCommitIds: chain.commits.map(commit => commit.summary.id),
    };
    this.#storeCached(cacheKey, result, generation);
    return result;
  }

  /** `#simulatedMergeRequestComparison`, degrading a failure to null with a warning. */
  async #simulatedMergeRequestComparisonOrWarn(
    gitCache: RpcStub<GitCache> | undefined, targetRef: string, sourceBranch: string,
  ): Promise<SimulatedMergeRequestComparison | null> {
    try {
      return await this.#simulatedMergeRequestComparison(gitCache, targetRef, sourceBranch);
    } catch (error) {
      logger.warn("failed to simulate a merge request comparison over queued pushes", {
        event: "merge.request.simulated.comparison.failed", error,
      });
      return null;
    }
  }

  /** Apply a history listing's filters to the pending chain locally (GitLab never sees these commits). */
  async #filterPendingCommitsForListing(
    gitCache: RpcStub<GitCache>,
    chain: { commits: { summary: GitLabCommitSummary; tree: GitOid }[]; anchor: GitOid },
    filter: GitLabCommitFilter | undefined,
  ): Promise<GitLabCommitSummary[]> {
    const results: GitLabCommitSummary[] = [];
    for (let index = 0; index < chain.commits.length; index++) {
      const { summary, tree } = chain.commits[index];
      if (filter?.author !== undefined && summary.author.email !== filter.author && summary.author.name !== filter.author) continue;
      const date = summary.committer.date ?? summary.author.date;
      if (filter?.since !== undefined && (date === undefined || date < filter.since)) continue;
      if (filter?.until !== undefined && (date === undefined || date > filter.until)) continue;
      if (filter?.path !== undefined) {
        const parentTree = index + 1 < chain.commits.length
          ? chain.commits[index + 1].tree
          : await this.#treeOidOfCommit(gitCache, chain.anchor);
        const changed = await changedPathsBetweenTrees(this.#treeDiffSource(gitCache), parentTree, tree);
        const path = filter.path.replace(/\/+$/, "");
        if (!changed.some(candidate => candidate === path || candidate.startsWith(`${path}/`))) continue;
      }
      results.push(summary);
    }
    return results;
  }
}
