// The per-binding gatekeeper Durable Object for GitLab: one instance per (account, project |
// issue | merge request) binding. It caches remote reads, records queued actions and overlays
// them onto everything it returns (so a caller sees the world as if its queued work had landed),
// and mints the sessions agents talk to. Mirrors gatekeeper-github's `GitHubGatekeeperImpl`.
//
// This commit is the read side: every observation, with the overlay machinery the writes will
// feed. `applyAction`/`rejectAction`/`revertAction`, the `prepare*` methods, and git pull/push
// follow in later commits.

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ApprovalQueue,
  type Cursor,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type GitCache,
  type GitOid,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GitDiffFile } from "@gadgets/gatekeeper-kit/git-diff";
import { commitDetailsFromGitObject, isCommitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import {
  GitLabApi,
  GitLabApiError,
  type GitLabDiscussionResponse,
  type GitLabMergeRequestResponse,
  type GitLabSimpleUser,
} from "./gitlab-api";
import {
  apiKind,
  type Cached,
  type CreateIssueAction,
  type CreateMergeRequestAction,
  type EntityKind,
  type GitLabAction,
  type PushAction,
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
import { ArrayCursor, StreamingCursor } from "./gitlab-cursors";
import { GitLabIssueImpl, GitLabMergeRequestImpl, GitLabProjectSessionImpl } from "./gitlab-sessions";
import type {
  GitLabActor,
  GitLabBranchFilter,
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCommitFilter,
  GitLabCommitSummary,
  GitLabDiffThread,
  GitLabDiscussionEntry,
  GitLabIssue,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSearch,
  GitLabIssueSummary,
  GitLabMergeRequest,
  GitLabMergeRequestDetails,
  GitLabMergeRequestFilter,
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

const NO_ACTIONS_YET = "GitLab actions are not available in this build.";

type StoredViewer = { actor: GitLabActor; fetchedAt: number };

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
        await this.#buildProvisionalMergeRequestDetails(createAction), "mergeRequest", logicalId, true);
    }
    return await this.#overlaySimulatedSourceHead(
      this.#overlayIssueLike(await this.#getRemoteMergeRequestDetails(logicalId), "mergeRequest", logicalId),
      gitCache);
  }

  /**
   * Overlay queued pushes onto an existing merge request's source branch head. Only the head sha
   * moves in this commit; the recomputed diff stats arrive with the push simulation.
   */
  async #overlaySimulatedSourceHead(
    details: GitLabMergeRequestDetails, _gitCache?: RpcStub<GitCache>,
  ): Promise<GitLabMergeRequestDetails> {
    return this.#overlayMergeRequestSummaryHead(details);
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
      upvotes: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
    };
  }

  async #buildProvisionalMergeRequestDetails(action: CreateMergeRequestAction): Promise<GitLabMergeRequestDetails> {
    const viewer = await this.#getViewerActor();
    let sourceSha = "";
    let targetSha = "";
    let changedFiles: number | undefined;
    try {
      // The branches exist (or a queued push will create them): read their heads for the refs.
      const [source, target] = await Promise.all([
        this.#getBranchHeadCached(action.options.sourceBranch),
        this.#getBranchHeadCached(action.options.targetBranch),
      ]);
      sourceSha = this.#simulateBranchHead(action.options.sourceBranch, source) ?? "";
      targetSha = target ?? "";
      if (source !== null && target !== null) {
        const compare = await this.#compareCached(action.options.targetBranch, action.options.sourceBranch);
        changedFiles = compare.files.length;
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
      labels: [],
      author: viewer,
      assignees: [],
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
      .map(action => this.#buildProvisionalMergeRequestDetails(action)
        .then(mr => this.#overlayIssueLike(mr, "mergeRequest", action.provisionalId, true)))))
      .filter(matches)
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);
    void gitCache;

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

  /**
   * A three-dot compare, normalized: the files and the commits (oldest first). GitLab documents
   * that `diffs` may be incomplete when `compare_timeout` is set, with nothing in the diffs
   * themselves to say so; a caller reviewing such a diff would review part of a change and
   * approve all of it. So a timed-out comparison is refused here, the one place it is read,
   * rather than served -- and not cached, since the next attempt may complete.
   */
  async #compareCached(from: string, to: string): Promise<{ files: GitDiffFile[]; commits: GitLabCommitSummary[] }> {
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

  async #getDiff(logicalId: string, pageSize: number, _gitCache?: RpcStub<GitCache>):
      Promise<{ revision: GitLabMergeRequestRevision; files: Cursor<GitDiffFile> }> {
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${logicalId} is no longer available.`);
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

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async rejectAction(_actionId: number): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error(NO_ACTIONS_YET);
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

  /** The merge base of a merge request, always a commit GitLab itself knows. */
  async mergeRequestMergeBase(id: string, _gitCache?: RpcStub<GitCache>): Promise<GitOid> {
    if (id.startsWith("~") && !this.#resolveProvisionalId(id)) {
      const action = this.#findCreateAction(id, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${id} is no longer available.`);
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
    const revision = await this.#mergeRequestRevision(await this.#getRawMergeRequest(realId));
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

  async listCommits(filter: GitLabCommitFilter | undefined, pageSize: number, _gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabCommitSummary>> {
    const projectPath = this.#projectPath();
    // An omitted ref means the default branch, resolved here so the listing names the branch
    // explicitly (consistently with getCommit()/resolveRef(), which resolve from the same cache).
    const refName = filter?.ref ?? (await this.#getProjectMetadata()).defaultBranch;
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
      comparator: () => -1,
      injectedItems: [],
      pageSize,
    });
  }

  async mergeRequestCommits(logicalId: string, pageSize: number, _gitCache?: RpcStub<GitCache>):
      Promise<Cursor<GitLabCommitSummary>> {
    const projectPath = this.#projectPath();
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "mergeRequest");
      if (!action) throw new Error(`Provisional merge request ${logicalId} is no longer available.`);
      const compare = await this.#compareCached(action.options.targetBranch, action.options.sourceBranch);
      return new ArrayCursor(compare.commits, pageSize);
    }
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
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
}
