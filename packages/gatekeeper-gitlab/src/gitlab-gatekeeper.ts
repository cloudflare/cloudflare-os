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
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  MAX_DIFF_BLOB_BYTES,
  changedPathsBetweenTrees,
  diffGitTrees,
  parseGitTreePayload,
  type TreeDiffFile,
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
  supportsReviewerState,
  type GitLabApprovalsResponse,
  type GitLabDiffResponse,
  type GitLabDiscussionResponse,
  type GitLabDraftNoteResponse,
  type GitLabMergeRequestResponse,
  type GitLabPage,
  type GitLabPositionRequest,
  type GitLabSimpleUser,
} from "./gitlab-api";
import {
  apiKind,
  referenceBearingTexts,
  replaceProvisionalReferences,
  textReferences,
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
  instanceUrl as instanceUrlOf,
  withAccountApi,
  type Env,
  type GitLabGatekeeperImplProps,
} from "./gitlab-env";
import {
  actorFromUser,
  actorFromUsername,
  branchNameMatchesSearch,
  commentTargetFromPosition,
  dedupeLabels,
  diffAnchor,
  diffLinePositions,
  discussionCommentFromNote,
  hasDraftPrefix,
  issuableComparator,
  issueMatchesFilter,
  issueMatchesSearch,
  issueOrder,
  issueUrl,
  mergeRequestCreateTitle,
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
  type GitLabDiscussionCommentEntry,
} from "./gitlab-normalize";
import { ArrayCursor, StreamingCursor, mapPage } from "./gitlab-cursors";
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
  GitLabDiffFile,
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
/** An instance's version changes only when it is upgraded. */
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
/** `diff_refs` populate asynchronously after an MR is created; one short retry covers the gap. */
const DIFF_REFS_RETRY_DELAY_MS = 1500;

/** Cap on the queued-but-not-yet-pushed commits walked when simulating a branch's history. */
const MAX_PENDING_CHAIN_COMMITS = 250;
/** Bound on following a chain of not-yet-applied replies back to a real thread. */
const MAX_REPLY_TARGET_HOPS = 50;
/** How many of a merge request's newest notes a retried review summary searches for its lost post. */
const LOST_SUMMARY_SEARCH_DEPTH = 100;

/** The connected account: its user id, which tells its approvals and notes from others', and its actor. */
type StoredViewer = { id: number; actor: GitLabActor; fetchedAt: number };

/**
 * A `target...source` merge request comparison computed as if the source branch's queued pushes
 * had already landed (see `#simulatedMergeRequestComparison`). `pendingCommitIds` are the commits
 * that are not on GitLab yet -- sessions must not advertise them.
 */
type SimulatedMergeRequestComparison = {
  revision: GitLabMergeRequestRevision;
  files: TreeDiffFile[];
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

/** When the user approved, by GitLab's `approved_at`; null if they have not, or the instance does not say. */
function approvedAtOf(approvals: GitLabApprovalsResponse, userId: number): string | null {
  return approvals.approved_by.find(entry => entry.user.id === userId)?.approved_at ?? null;
}

/**
 * Whether a draft sits where a review's diff comment is anchored: the same file (by either path,
 * as `#positionFor` sends both) and, for a line comment, the same line on the comment's side.
 */
function draftAnchoredAt(draft: GitLabDraftNoteResponse, target: GitLabDiffCommentTarget): boolean {
  const position = draft.position;
  if (!position || (position.new_path !== target.path && position.old_path !== target.path)) return false;
  if (target.subjectType === "file") return true;
  return target.side === "new" ? position.new_line === target.line : position.old_line === target.line;
}

/**
 * `bulk_publish` publishes every draft the user has on the merge request, so a request for
 * changes waits while the user has drafts of their own there.
 */
function refuseOverForeignDrafts(realId: string, foreign: GitLabDraftNoteResponse[]): void {
  if (foreign.length === 0) return;
  throw new Error(
    `Cannot request changes on !${realId}: you have ${foreign.length} unpublished draft comment${foreign.length === 1 ? "" : "s"} ` +
    "of your own on it in GitLab, and publishing this review would publish those too. Publish or delete them there first.");
}

/** Why a review is not posted once the merge request has moved on from the reviewed head. */
function reviewedHeadMoved(realId: string, reviewedSha: string, liveSha?: string): string {
  return `Merge request !${realId} has moved on from the reviewed revision (${reviewedSha.slice(0, 12)}` +
    `${liveSha ? ` -> ${liveSha.slice(0, 12)}` : ""}); the review's comments and approval refer to code that has since ` +
    "changed. Re-read the diff and review it again.";
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
    return await withAccountApi(this.env, this.#userAccount(), fn);
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

  /** Every row of a listing, page after page for as long as GitLab says there is a next one. */
  async #fetchAllPages<T>(loader: (page: number, perPage: number) => Promise<GitLabPage<T>>): Promise<T[]> {
    const results: T[] = [];
    for (let page: number | null = 1; page !== null;) {
      const batch = await loader(page, 100);
      results.push(...batch.items);
      page = batch.nextPage;
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

  /**
   * The number an issue or merge request goes by now: a provisional `~N` whose create has
   * landed is its real number, and is the same item as the row GitLab now lists under it.
   */
  #currentId(id: string): string {
    return id.startsWith("~") ? this.#resolveProvisionalId(id) ?? id : id;
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
    return replaceProvisionalReferences(text, reference => {
      const record = this.#getProvisionalResource(reference.provisionalId);
      const realId = record?.kind === reference.kind ? record.realId : undefined;
      if (!realId && requireAll) {
        throw new Error(
          `Reference ${reference.text} points to a provisional ${reference.kind === "issue" ? "issue" : "merge request"} ` +
          `that has not been created on GitLab yet. Retry after its create action is approved.`);
      }
      return realId ? `${reference.text[0]}${realId}` : reference.text;
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

  async #getViewer(): Promise<StoredViewer> {
    return await this.#cached<StoredViewer>(this.#cacheKey("viewer"), VIEWER_CACHE_TTL_MS, async () => {
      const user = await this.#withApi(api => api.getCurrentUser());
      const actor = actorFromUser(this.#instanceUrl(), user);
      if (!actor) throw new Error("Failed to identify the connected GitLab account.");
      return { id: user.id, actor, fetchedAt: Date.now() };
    });
  }

  async #getViewerActor(): Promise<GitLabActor> {
    return (await this.#getViewer()).actor;
  }

  /** The instance's version, for what depends on it (see `supportsReviewerState`). */
  async #getVersion(): Promise<string> {
    return await this.#cached(this.#cacheKey("version"), VERSION_CACHE_TTL_MS, async () =>
      await this.#withApi(api => api.getVersion()));
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

  /**
   * Who has approved, or null when GitLab will not say (approvals disabled or not visible to the
   * user): the merge request is still readable without them, but an empty list would claim
   * nobody approved.
   */
  async #getApprovers(realId: string): Promise<GitLabSimpleUser[] | null> {
    return await this.#cached(this.#cacheKey("mr-approvals", realId), ENTITY_CACHE_TTL_MS, async () => {
      try {
        return (await this.#withApi(api => api.getMergeRequestApprovals(this.#projectPath(), Number(realId))))
          .approved_by.map(entry => entry.user);
      } catch (error) {
        if (error instanceof GitLabApiError && (error.status === 404 || error.status === 403)) return null;
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
    const simulated = this.#simulateBranchHead(item.source.branch, item.source.sha);
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
      upvotes: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
    };
  }

  async #buildProvisionalMergeRequestDetails(
    action: CreateMergeRequestAction, gitCache?: RpcStub<GitCache>,
  ): Promise<GitLabMergeRequestDetails> {
    const viewer = await this.#getViewerActor();
    let sourceSha: GitOid | null = null;
    let targetSha: GitOid | null = null;
    let changedFiles: number | undefined;
    try {
      // The source branch may itself be provisional -- moved, or outright created, by queued
      // pushes. The simulated comparison reads it as if those pushes had landed; when it cannot
      // run (no cache, or a tree the cache lacks) the live heads stand in, with the source head
      // still overlaid so the ref points where the queued pushes will put it. GitLab's own
      // comparison describes the remote head, so it counts the files only when that is the head.
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
        sourceSha = this.#simulateBranchHead(action.options.sourceBranch, source);
        targetSha = target;
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
      title: mergeRequestCreateTitle(action.options),
      state: "opened",
      labels: (action.options.labels ?? []).map(name => ({ name })),
      author: viewer,
      assignees: (action.options.assignees ?? []).map(username => actorFromUsername(this.#instanceUrl(), username)),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
      // As GitLab will compute it: from the title, not the flag.
      draft: hasDraftPrefix(mergeRequestCreateTitle(action.options)),
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
          // GitLab derives a merge request's draft status from its title.
          if ("draft" in result) result.draft = hasDraftPrefix(action.title);
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
          return mapPage(raw, item => normalizeIssueSummary(this.#instanceUrl(), projectPath, item));
        }),
      overlay: item => this.#overlayIssueLike(item, "issue", item.id),
      // Search scope is the project's own endpoint, so remote rows need no re-check; the local
      // filter re-applies the structured filter after the overlay may have changed labels/state,
      // and drops the rows already served as injected items (a touched issue sorts by its
      // overlaid state, not its remote one).
      filter: item => !touched.ids.has(item.id) && issueMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      identity: item => this.#currentId(item.id),
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
          const sourceProjects = await Promise.all(raw.items.map(item => this.#sourceProjectRef(item)));
          return {
            items: raw.items.map((item, i) => normalizeMergeRequestSummary(this.#instanceUrl(), projectPath, item, sourceProjects[i])),
            nextPage: raw.nextPage,
          };
        }),
      overlay: item => this.#overlayMergeRequestSummaryHead(this.#overlayIssueLike(item, "mergeRequest", item.id)),
      // As for issues: touched rows are dropped, since they are served as injected items.
      filter: item => !touched.ids.has(item.id) && mergeRequestMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      identity: item => this.#currentId(item.id),
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
      .filter(discussion => diffAnchor(discussion) === null)
      .flatMap(discussion => discussion.notes)
      .filter(note => !note.system)
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
      const anchor = diffAnchor(discussion);
      if (anchor === null) continue;
      const comments = discussion.notes.filter(note => !note.system);
      if (comments.length === 0) continue;
      threads.push({
        id: discussion.id,
        target: commentTargetFromPosition(anchor),
        // REST has no outdated flag; a position anchored to an older head than the current one
        // is the best available approximation.
        ...(headSha ? { isOutdated: anchor.head_sha !== headSha } : {}),
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

  /**
   * A merge request's diff threads as the caller sees them -- GitLab's, with queued reviews'
   * comments, replies, and resolutions laid over them -- in creation order.
   */
  async #overlaidDiffThreads(logicalId: string): Promise<GitLabDiffThread[]> {
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

    return [...threads.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
  }

  async #getDiffThreads(logicalId: string, pageSize: number): Promise<Cursor<GitLabDiffThread>> {
    return new ArrayCursor(await this.#overlaidDiffThreads(logicalId), pageSize);
  }

  // -- diff and merge base ----------------------------------------------------------------

  /**
   * A three-dot compare, normalized: the files and the commits (oldest first). GitLab documents
   * that `diffs` may be incomplete when `compare_timeout` is set, with nothing in the diffs
   * themselves to say so; a caller reviewing such a diff would review part of a change and
   * approve all of it. So a timed-out comparison is refused here, the one place it is read,
   * rather than served -- and not cached, since the next attempt may complete.
   */
  async #compareCached(from: string, to: string): Promise<{ files: GitLabDiffFile[]; commits: GitLabCommitSummary[] }> {
    return await this.#cached(this.#cacheKey("compare", stableKey(from), stableKey(to)), ENTITY_CACHE_TTL_MS, async () => {
      const compare = await this.#withApi(api => api.compare(this.#projectPath(), from, to));
      if (compare.compare_timeout) {
        throw new Error(
          `GitLab timed out comparing ${from} with ${to}, so the diff it returned may be incomplete. ` +
          "Try again; if the comparison keeps timing out, read the change in smaller pieces (by commit or by path).");
      }
      return {
        files: compare.diffs.map(normalizeDiffFile),
        commits: compare.commits.map(c => normalizeCommitSummary(this.#instanceUrl(), this.#projectPath(), c)),
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
      Promise<{ revision: GitLabMergeRequestRevision; files: Cursor<GitLabDiffFile> }> {
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
    // Pages are cached under the whole revision, not the head alone: the target branch can move
    // with the head unchanged, and files cached for the old comparison would then be served as
    // the new one's, putting review comments against lines that diff does not have.
    const revisionKey = [revision.baseSha, revision.mergeBaseSha ?? "", revision.headSha];
    return {
      revision,
      files: new StreamingCursor<GitLabDiffFile>({
        fetchPage: async (page, perPage) =>
          await this.#cached(this.#cacheKey("mr-diffs", realId, ...revisionKey, `p${page}`), ENTITY_CACHE_TTL_MS, async () =>
            mapPage(await this.#withApi(api => api.listMergeRequestDiffs(projectPath, Number(realId), page, perPage)),
              normalizeDiffFile)),
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
      Promise<{ revision: GitLabMergeRequestRevision; files: Cursor<GitLabDiffFile> }> {
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
      if (filter?.search && !branchNameMatchesSearch(action.branch, filter.search)) continue;
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
          mapPage(await this.#withApi(api => api.listBranches(projectPath, { search: filter?.search, page, perPage })),
            normalizeBranchSummary)),
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
          mapPage(await this.#withApi(api => api.listTags(projectPath, page, perPage)), normalizeTagSummary)),
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
   * whose advertisement would outlive a rejection). A branch with queued pushes reads at its
   * simulated head; a full commit id GitLab does not know reads from the cache only when the
   * push simulation stands behind it (`#readQueuedPushCommit`).
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
    if (gitCache !== undefined && isCommitOid(ref)) {
      const queued = await this.#readQueuedPushCommit(gitCache, ref);
      if (queued !== null) return { details: queued, fromCache: true };
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
    if (gitCache !== undefined && isCommitOid(ref) && await this.#readQueuedPushCommit(gitCache, ref) !== null) {
      return { id: ref, fromCache: true };
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
          mapPage(await this.#withApi(api => api.listCommits(projectPath, {
            refName,
            path: filter?.path,
            author: filter?.author,
            since: filter?.since?.toISOString(),
            until: filter?.until?.toISOString(),
            page,
            perPage,
          })), c => normalizeCommitSummary(this.#instanceUrl(), projectPath, c))),
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

  /**
   * Whether a queued action cannot apply once the provisional resource is gone: it targets it,
   * or its text names it (`#~N` / `!~N`, which apply would fail to rewrite -- see
   * `referenceBearingTexts`).
   */
  #actionDependsOnResource(action: GitLabAction, kind: EntityKind, provisionalId: string): boolean {
    if (referenceBearingTexts(action).some(text => textReferences(text, kind, provisionalId))) return true;
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

  /**
   * A provisional resource will never exist: retire every pending action that depends on it
   * (`#actionDependsOnResource`) and forget the provisional itself. A retired action may be a
   * *create* -- an issue whose body cites the doomed merge request -- whose own provisional then
   * never exists either, so the cascade recurses through it; otherwise a comment queued on that
   * issue would stay pending and fail every apply.
   */
  #retireProvisional(kind: EntityKind, provisionalId: string): void {
    this.ctx.storage.kv.delete(`provisional:${provisionalId}`);
    for (const pending of this.#listPendingActions()) {
      if (!this.#actionDependsOnResource(pending, kind, provisionalId)) continue;
      // A nested cascade may have retired this one already (it depended on both).
      if (this.#getActionRecord(pending.approvalId)?.state !== "pending") continue;
      this.#markActionRejected(pending);
      if (pending.type === "createIssue" || pending.type === "createMergeRequest") {
        this.#retireProvisional(pending.type === "createIssue" ? "issue" : "mergeRequest", pending.provisionalId);
      }
    }
  }

  /**
   * Cascade for a rejected push: retire the queued actions stranded on a head that will now never
   * be reached, then those the missing-branch check dooms (`#rejectMergeRequestsForMissingBranches`).
   * A head is stranded when the push that would leave it is retired and no other queued push to
   * the branch would leave it too. A push bound to a stranded head (`expectedOldSha`) could only
   * fail its compare-and-swap -- with an error blaming the branch for moving -- and strands its own
   * new head in turn; a merge bound to one (`expectedHeadSha`) could only be refused. Only a
   * rejection strands a head: a branch moved by anyone else is the compare-and-swap's to report
   * at apply. Returns whether anything cascaded.
   */
  async #rejectActionsStrandedByPush(rejected: PushAction): Promise<boolean> {
    let cascaded = false;
    const stranded = [{ branch: rejected.branch, head: rejected.newSha }];
    for (let next = stranded.pop(); next !== undefined; next = stranded.pop()) {
      const { branch, head } = next;
      const pending = this.#listPendingActions();
      if (pending.some(action => action.type === "push" && action.branch === branch && action.newSha === head)) continue;
      for (const action of pending) {
        if (action.type === "push" && action.branch === branch && action.expectedOldSha === head) {
          this.#markActionRejected(action);
          stranded.push({ branch, head: action.newSha });
          cascaded = true;
        } else if (action.type === "mergeMergeRequest" && action.sourceBranch === branch && action.expectedHeadSha === head) {
          this.#markActionRejected(action);
          cascaded = true;
        }
      }
    }
    return await this.#rejectMergeRequestsForMissingBranches() || cascaded;
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
          this.#retireProvisional("mergeRequest", pending.provisionalId);
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

  /** Assignees are usernames in the API and ids on GitLab; resolving them here means a typo fails now, not at apply. */
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
    const assigneeIds = await this.#resolveAssigneeIds(options.assignees);
    return { type: "createMergeRequest", ...this.#base(), provisionalId: this.#nextProvisionalResourceId(), options, assigneeIds };
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
      // An empty comment review would publish nothing, and a request for changes with no
      // explanation gives the author nothing to act on; GitHub refuses both. An approval still
      // approves.
      throw new Error(`A ${review.decision} review needs a summary comment or at least one diff comment.`);
    }
    if (review.decision === "requestChanges") {
      // Older instances ignore `bulk_publish`'s `reviewer_state` without an error, which would
      // publish the request for changes as a plain comment.
      const version = await this.#getVersion();
      if (!supportsReviewerState(version)) {
        throw new Error(`Requesting changes needs GitLab 19.2 or later, and this instance runs ${version}. Post a comment review instead.`);
      }
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

  /**
   * Records the thread's state as the caller sees it, queued resolutions included, for a revert
   * to restore. A thread already in the requested state is still queued, as a title already
   * equal to the new one is: the request is the caller's, and applying it changes nothing.
   */
  async prepareResolveDiffThread(mergeRequestId: string, threadId: string, resolved: boolean): Promise<ResolveDiffThreadAction> {
    const thread = (await this.#overlaidDiffThreads(mergeRequestId)).find(candidate => candidate.id === threadId);
    if (!thread) {
      throw new Error(`Diff thread ${threadId} was not found on merge request ` +
        `${mergeRequestId.startsWith("~") ? mergeRequestId : `!${mergeRequestId}`}.`);
    }
    return {
      type: "resolveDiffThread", ...this.#base(), mergeRequestId, threadId, resolved, previouslyResolved: thread.isResolved,
    };
  }

  /**
   * Binds the head the merge is approved against: without it, commits pushed between approval
   * and apply -- a collaborator's, or the agent's own through another approved push -- would
   * merge unreviewed. For a provisional merge request this is the simulated source head, the
   * head it will have once created.
   */
  async prepareMergeMergeRequest(mergeRequestId: string, options?: GitLabMergeRequestMergeOptions): Promise<MergeMergeRequestAction> {
    const details = await this.#getMergeRequestDetails(mergeRequestId);
    const expectedHeadSha = options?.expectedHeadSha ?? details.source.sha ?? undefined;
    if (expectedHeadSha === undefined) {
      // A provisional merge request whose source head could not be simulated reads no sha (its
      // comparison degraded). Queuing anyway would send the merge without `sha`, and the
      // approval would then cover whatever the branch holds when it applies -- the one thing the
      // binding exists to prevent. Refuse instead; the head is knowable once the reads recover.
      throw new Error(
        `Merge request ${mergeRequestId.startsWith("~") ? mergeRequestId : `!${mergeRequestId}`}'s source head could not be ` +
        "determined, so the merge cannot be bound to a reviewed state. Re-read the merge request and try again, " +
        "or pass expectedHeadSha.");
    }
    const sourceBranch = details.source.project.path === this.#projectPath() ? details.source.branch : null;
    return { type: "mergeMergeRequest", ...this.#base(), mergeRequestId, options, expectedHeadSha, sourceBranch };
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
    if (record.state === "rejected") {
      // The Workshop's copy stays pending after a cascade (see `#retireProvisional`) until the
      // user discards it too, so this is how an apply learns why it cannot run.
      throw new Error(`GitLab action ${actionId} was discarded, or something it depended on was, so it cannot be applied.`);
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
            title: mergeRequestCreateTitle(action.options),
            description: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
            labels: action.options.labels,
            assignee_ids: action.assigneeIds.length > 0 ? action.assigneeIds : undefined,
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
          // "Cannot merge", which is also GitLab's answer once the merge request is merged -- as
          // it is when this apply is a retry of one whose reply was lost. Merged at the bound
          // head is that merge (GitLab checks `sha` before merging, so it can have merged no
          // other); otherwise the re-read names the reason.
          let mr: GitLabMergeRequestResponse | undefined;
          try {
            mr = await this.#withApi(api => api.getMergeRequest(projectPath, Number(realId)));
          } catch {}
          if (mr?.state === "merged" && mr.sha === expectedHeadSha) return;
          const status = mr?.detailed_merge_status ?? "unknown";
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
   * Publish a review: `approve`'s approval first, then one draft note per diff comment, published
   * as the decision requires, then the summary as an ordinary note.
   *
   * The review was written against one revision -- its comments are positioned in that diff and
   * an approval means "this head" -- so every attempt first checks that the merge request's
   * source head is still `review.revision.headSha`, and fails clean if it has moved (GitLab
   * keeps `approve` honest the same way, answering 409 to a stale `sha`, but only on the attempt
   * that runs it; a retry after a push would otherwise resume past it, and GitLab may have reset
   * the approval on that push). The check reads the live merge request, not the cache, since it
   * is what the action is bound to.
   *
   * `applyAction` owes the queue idempotence (a failure is offered a retry), and this is the one
   * action GitLab makes multi-call, so each step is recorded on the action record
   * (`ReviewProgress`) as it lands. A step GitLab could carry out without the answer arriving is
   * recorded as under way first, and a retry asks GitLab what became of it before repeating it.
   * Approval runs before anything is posted, so a stale head -- or any other refusal of the
   * approval itself -- fails the action with nothing published.
   *
   * `bulk_publish` is the only call that records a reviewer state, which for `requestChanges`
   * *is* the review; but it publishes every draft the user has on the merge request, a human's
   * parked drafts included. So `requestChanges` refuses while the user has drafts of their own
   * there -- checked before its drafts are created and again just before publishing; the round
   * trip between that read and the publish is the window GitLab's API leaves, and its handler
   * is not transactional either. `comment` and `approve` have no state to record (`approve`'s
   * approval sets its own), so they publish their drafts one at a time and never touch the
   * user's -- at the cost of a grouped review: each comment arrives as its own note.
   */
  async #publishReview(record: StoredActionRecord, action: PostReviewAction): Promise<void> {
    const realId = this.#requireRealId(action.mergeRequestId, "Merge request");
    const projectPath = this.#projectPath();
    const iid = Number(realId);
    const review = action.review;
    const comments = review.diffComments ?? [];
    const progress = record.progress ??= {};
    const entries = progress.comments ??= comments.map(() => null);

    // Every reference must resolve before anything is posted. A review left partway -- approved,
    // drafts parked -- waiting on an issue that is then discarded would be retired by that
    // cascade, which cleans nothing up.
    const bodies = comments.map(comment => this.#rewriteKnownReferences(comment.bodyMarkdown, true));
    const summary = review.bodyMarkdown ? this.#rewriteKnownReferences(review.bodyMarkdown, true) : undefined;

    const live = await this.#withApi(api => api.getMergeRequest(projectPath, iid));
    if (live.sha !== review.revision.headSha) throw new Error(reviewedHeadMoved(realId, review.revision.headSha, live.sha));
    const viewer = await this.#getViewer();

    if (review.decision === "approve") await this.#approveReviewedHead(record, action, iid, viewer.id);

    if (review.decision === "requestChanges") {
      if (!progress.requestedChanges) {
        refuseOverForeignDrafts(realId, await this.#reconcileReviewDrafts(record, action, iid, bodies));
        await this.#createReviewDrafts(record, action, iid, bodies);
        // Again, just before publishing: a draft the user started while ours were being created
        // would be published with them.
        refuseOverForeignDrafts(realId, await this.#reconcileReviewDrafts(record, action, iid, bodies));
        await this.#withApi(api => api.bulkPublishDraftNotes(projectPath, iid, { reviewer_state: "requested_changes" }));
        entries.fill("published");
        progress.requestedChanges = true;
        this.#saveProgress(record);
      }
    } else if (entries.some(entry => entry !== "published")) {
      await this.#reconcileReviewDrafts(record, action, iid, bodies);
      await this.#createReviewDrafts(record, action, iid, bodies);
      for (const [index, entry] of entries.entries()) {
        if (typeof entry !== "number") continue;
        await this.#withApi(api => api.publishDraftNote(projectPath, iid, entry));
        entries[index] = "published";
        this.#saveProgress(record);
      }
    }

    if (summary !== undefined) await this.#postReviewSummary(record, iid, summary, viewer.id);
  }

  /** Persist a review's progress before its next step (see `#publishReview`). */
  #saveProgress(record: StoredActionRecord): void {
    this.#putActionRecord(record.action.approvalId, record);
  }

  /**
   * `approve`'s approval, made once across attempts. GitLab answers 401 both when the user may
   * not approve and when they already have, so the approvals are read first: one already there
   * is this review's own if an attempt whose answer was lost made it (`"approving"`), and
   * otherwise one the account held before, which a discard leaves alone.
   */
  async #approveReviewedHead(record: StoredActionRecord, action: PostReviewAction, iid: number, viewerId: number): Promise<void> {
    const progress = record.progress ??= {};
    if (progress.approval !== undefined && progress.approval !== "approving") return;
    const projectPath = this.#projectPath();
    const before = await this.#withApi(api => api.getMergeRequestApprovals(projectPath, iid));
    if (before.user_has_approved) {
      progress.approval = progress.approval === "approving" ? { approvedAt: approvedAtOf(before, viewerId) } : "preexisting";
      this.#saveProgress(record);
      return;
    }
    progress.approval = "approving";
    this.#saveProgress(record);
    let after: GitLabApprovalsResponse;
    try {
      after = await this.#withApi(api => api.approveMergeRequest(projectPath, iid, action.review.revision.headSha));
    } catch (error) {
      // A refusal approved nothing, so a retry starts afresh; an answer that never came may have.
      if (error instanceof GitLabApiError && error.status >= 400 && error.status < 500) {
        progress.approval = undefined;
        this.#saveProgress(record);
        if (error.status === 409) throw new Error(reviewedHeadMoved(String(iid), action.review.revision.headSha), { cause: error });
        if (error.status === 401) throw new Error(`The connected GitLab account is not allowed to approve !${iid}.`, { cause: error });
      }
      throw error;
    }
    progress.approval = { approvedAt: approvedAtOf(after, viewerId) };
    this.#saveProgress(record);
  }

  /**
   * Settle a review's drafts against the ones GitLab holds for the user -- one read, as the
   * listing is unpaginated -- and answer the drafts that are not the review's own. A draft the
   * review created that is no longer listed was published by an attempt whose answer was lost,
   * or deleted by the user, who is taken at their word: either way it is not created again. A
   * draft whose creation went unanswered (`"creating"`) is adopted if GitLab holds an unclaimed
   * draft with its body and anchor, and is otherwise created again.
   */
  async #reconcileReviewDrafts(
    record: StoredActionRecord, action: PostReviewAction, iid: number, bodies: string[],
  ): Promise<GitLabDraftNoteResponse[]> {
    const comments = action.review.diffComments ?? [];
    const entries = (record.progress ??= {}).comments ??= comments.map(() => null);
    const listed = await this.#withApi(api => api.listDraftNotes(this.#projectPath(), iid));
    const unclaimed = new Map(listed.map(draft => [draft.id, draft]));
    for (const [index, entry] of entries.entries()) {
      if (typeof entry === "number" && !unclaimed.delete(entry)) entries[index] = "published";
    }
    for (const [index, entry] of entries.entries()) {
      if (entry !== "creating") continue;
      const adopted = [...unclaimed.values()].find(draft =>
        draft.note === bodies[index] && draftAnchoredAt(draft, comments[index].target));
      if (adopted) unclaimed.delete(adopted.id);
      entries[index] = adopted?.id ?? null;
    }
    this.#saveProgress(record);
    return [...unclaimed.values()];
  }

  /** Create, in order, the review's drafts that do not exist yet: see `#reconcileReviewDrafts`. */
  async #createReviewDrafts(record: StoredActionRecord, action: PostReviewAction, iid: number, bodies: string[]): Promise<void> {
    const entries = record.progress?.comments ?? [];
    if (!entries.includes(null)) return;
    const projectPath = this.#projectPath();
    const comments = action.review.diffComments ?? [];
    const files = await this.#fetchAllPages((page, perPage) =>
      this.#withApi(api => api.listMergeRequestDiffs(projectPath, iid, page, perPage)));
    for (const [index, entry] of entries.entries()) {
      if (entry !== null) continue;
      const position = await this.#positionFor(files, comments[index].target, action.review.revision);
      entries[index] = "creating";
      this.#saveProgress(record);
      entries[index] = (await this.#withApi(api => api.createDraftNote(projectPath, iid, { note: bodies[index], position }))).id;
      this.#saveProgress(record);
    }
  }

  /**
   * The review's summary, posted last as an ordinary note. A post whose answer was lost
   * (`"posting"`) is looked for among the merge request's newest notes -- the account's own, with
   * the same body -- before it is posted again.
   */
  async #postReviewSummary(record: StoredActionRecord, iid: number, summary: string, viewerId: number): Promise<void> {
    const progress = record.progress ??= {};
    if (typeof progress.summary === "number") return;
    const projectPath = this.#projectPath();
    if (progress.summary === "posting") {
      const newest = await this.#withApi(api => api.listNotes(projectPath, "merge_requests", iid, {
        orderBy: "created_at", sort: "desc", page: 1, perPage: LOST_SUMMARY_SEARCH_DEPTH,
      }));
      const posted = newest.items.find(note => !note.system && note.author?.id === viewerId && note.body === summary);
      if (posted) {
        progress.summary = posted.id;
        this.#saveProgress(record);
        return;
      }
    }
    progress.summary = "posting";
    this.#saveProgress(record);
    progress.summary = (await this.#withApi(api => api.createNote(projectPath, "merge_requests", iid, summary))).id;
    this.#saveProgress(record);
  }

  /**
   * Take back what a discarded review left unpublished: its parked drafts, and its approval.
   * Comments already published stay, as the action's `implementsRevert: false` says, and so does
   * an approval the account held before the review. The review's own approval is taken back only
   * while GitLab still dates it as the one the review made -- the user may since have withdrawn
   * it and approved again -- or cannot say, on an instance that reports no `approved_at`.
   */
  async #discardReviewLeftovers(record: StoredActionRecord, action: PostReviewAction): Promise<void> {
    const progress = record.progress;
    const realId = this.#realIdOf(action.mergeRequestId);
    if (!progress || !realId) return;
    const projectPath = this.#projectPath();
    const iid = Number(realId);

    const entries = progress.comments ?? [];
    if (entries.some(entry => entry === "creating" || typeof entry === "number")) {
      // Unresolvable now means it was never sent, and then it matches no draft.
      const bodies = (action.review.diffComments ?? []).map(comment => this.#rewriteKnownReferences(comment.bodyMarkdown, false));
      await this.#reconcileReviewDrafts(record, action, iid, bodies);
      for (const [index, entry] of entries.entries()) {
        if (typeof entry !== "number") continue;
        await this.#withApi(api => api.deleteDraftNote(projectPath, iid, entry));
        entries[index] = null;
        this.#saveProgress(record);
      }
    }

    const approval = progress.approval;
    if (approval !== undefined && approval !== "preexisting") {
      const approvals = await this.#withApi(api => api.getMergeRequestApprovals(projectPath, iid));
      if (approvals.user_has_approved) {
        const approvedAt = approvedAtOf(approvals, (await this.#getViewer()).id);
        if (approval === "approving" || approval.approvedAt === null || approvedAt === null || approvedAt === approval.approvedAt) {
          await this.#withApi(api => api.unapproveMergeRequest(projectPath, iid));
        }
      }
      progress.approval = undefined;
      this.#saveProgress(record);
    }
  }

  // -- reject and revert ------------------------------------------------------------------

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    // Discarded already: a cascade (see `#retireProvisional`) retires actions the Workshop still
    // shows as pending, and the user's discard of one must then succeed, not strand it.
    if (record.state === "rejected") return;
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitLab action ${actionId} is no longer pending.`);
    }

    if (action.type === "postReview") {
      // Before the record is retired: a cleanup that fails leaves the action pending, so the
      // discard can be retried rather than stranding an approval or parked drafts.
      await this.#discardReviewLeftovers(record, action);
    }

    this.#markActionRejected(action);
    if (action.type === "createIssue" || action.type === "createMergeRequest") {
      this.#retireProvisional(action.type === "createIssue" ? "issue" : "mergeRequest", action.provisionalId);
      this.#clearCaches();
      return { restart: true };
    }

    if (action.type === "push") {
      const cascaded = await this.#rejectActionsStrandedByPush(action);
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
        // A thread that was already in the requested state was not changed, so is not changed back.
        if (action.previouslyResolved !== action.resolved) {
          await this.#withApi(api =>
            api.setDiscussionResolved(this.#projectPath(), Number(realId), action.threadId, action.previouslyResolved));
        }
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
   * A full commit id GitLab does not know, read from the workspace git cache -- but only a commit
   * the push simulation stands behind: one it has served already (`isSimulatedCommitId`), or one
   * a pending push's chain reaches, walked here (`#collectPendingChain` records each commit it
   * walks, even when the walk then fails, and side parents once it reaches GitLab's history).
   * Otherwise null. The overseer's cache already answers this gatekeeper only for its remote's
   * objects and its own queued pushes; this keeps the simulation, not the cache's contents, the
   * authority on which commits read as if pushed.
   */
  async #readQueuedPushCommit(gitCache: RpcStub<GitCache>, oid: GitOid): Promise<GitLabCommitDetails | null> {
    if (!this.isSimulatedCommitId(oid)) {
      for (const head of new Set(this.#pendingPushActions().map(action => action.newSha))) {
        try {
          await this.#collectPendingChain(gitCache, head);
        } catch (error) {
          logger.warn("failed to walk a queued push's commits", { event: "commits.pending.walk.failed", error });
        }
        if (this.#servedSimulatedCommitIds.has(oid)) break;
      }
      if (!this.#servedSimulatedCommitIds.has(oid)) return null;
    }
    const details = await this.#tryReadCachedCommitDetails(gitCache, oid);
    if (details !== null) this.#servedSimulatedCommitIds.add(oid);
    return details;
  }

  /**
   * Walk a simulated branch head down to its **anchor** -- the first commit GitLab already knows
   * -- reading the not-yet-pushed commits from the workspace git cache (which serves this
   * gatekeeper's queued-push closure, pulling objects through on demand). Returns the pending
   * commits newest-first plus the anchor. The walk, and so every listing built from it, follows
   * first parents only, where GitLab's own history lists every parent: a local merge's side
   * branch is missing from simulated listings until its push lands (a known gap -- matching
   * GitLab would mean date-merging the remote history behind each side parent). A chain that
   * leaves the cache or bottoms out with no GitLab-known ancestor throws, and callers degrade.
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
    // Rejecting a push retires the pushes stacked on it (`#rejectActionsStrandedByPush`), so no
    // pending push is left bound to a head that will never exist, which this would take for GitLab's.
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
   * chain (first parents only, see `#collectPendingChain`), and the file diff is a local tree
   * diff from the merge base to the simulated head (GitLab cannot compute it -- the pending
   * commits are not on the remote). Returns null when no overlay applies (no cache, no queued
   * pushes, or the remote has invalidated their expectations), so callers fall through to the
   * ordinary remote reads.
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
        const path = stripTrailingSlashes(filter.path);
        if (!changed.some(candidate => candidate === path || candidate.startsWith(`${path}/`))) continue;
      }
      results.push(summary);
    }
    return results;
  }
}
