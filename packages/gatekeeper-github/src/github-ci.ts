// GitHub CI: the GraphQL rollup query, and the pure mappings from GitHub's check runs, commit
// statuses, Actions jobs, workflow runs and job logs to the agent-facing shapes in types.d.ts.

import { applyCarriageReturns, stripAnsi } from "@gadgets/gatekeeper-kit/ci-log";
import type {
  GitHubAnnotation,
  GitHubCheckEntry,
  GitHubCheckRunDetails,
  GitHubCheckRunSummary,
  GitHubCheckState,
  GitHubCiPhase,
  GitHubCiRollupPhase,
  GitHubCommitChecks,
  GitHubPullRequestDetails,
  GitHubStatusSummary,
  GitHubWorkflowRunDetails,
  GitHubWorkflowRunFilter,
  GitHubWorkflowRunSummary,
} from "./types";
import type {
  GitHubCheckAnnotationResponse,
  GitHubCheckRunResponse,
  GitHubWorkflowJobResponse,
  GitHubWorkflowRunResponse,
} from "./github-api";
import { actorFromUser } from "./git-commits";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({ component: "gatekeeper.github.ci", vendorId: "github" });

/** How long after a commit becomes a head CI is still expected to start reporting. */
export const CI_START_WINDOW_MS = 10 * 60 * 1000;

/** Most rollup entries one `getChecks()` returns; the counts still cover every entry. */
export const MAX_CHECK_ENTRIES = 1000;

/** Most of a pull request's commits a commit id is looked for among (GitHub lists no more). */
export const MAX_PULL_COMMITS = 250;

/** GitHub Actions' app slug, on the check runs its jobs report. */
export const ACTIONS_APP_SLUG = "github-actions";

/** REST check/job/run conclusions (and GraphQL's, lower-cased) by the state they report. */
const CONCLUSION_STATES: Record<string, GitHubCheckState> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  timed_out: "timedOut",
  action_required: "actionRequired",
  skipped: "skipped",
  neutral: "neutral",
  stale: "stale",
  startup_failure: "startupFailure",
};

/** REST statuses of unfinished checks, jobs and runs (and GraphQL's, lower-cased). */
const STATUS_STATES: Record<string, GitHubCheckState> = {
  requested: "queued",
  queued: "queued",
  pending: "queued",
  in_progress: "inProgress",
  waiting: "waiting",
};

/** `table[key]`, for a key GitHub sent: never an inherited property such as `constructor`. */
function lookup<V>(table: Record<string, V>, key: string | null | undefined): V | undefined {
  return key != null && Object.hasOwn(table, key) ? table[key] : undefined;
}

function unknownState(field: string, value: string | null | undefined): GitHubCheckState {
  logger.warn("unrecognised GitHub CI status", { event: "ci.unknown_status", ciField: field, ciValue: String(value) });
  return "unknown";
}

/** The state of a check run, job, step or workflow run, from its `status` and `conclusion`. */
export function checkStateOf(status: string | null | undefined, conclusion: string | null | undefined): GitHubCheckState {
  const current = status?.toLowerCase();
  if (current === "completed") {
    return lookup(CONCLUSION_STATES, conclusion?.toLowerCase()) ?? unknownState("conclusion", conclusion);
  }
  return lookup(STATUS_STATES, current) ?? unknownState("status", status);
}

/**
 * The state behind one of GraphQL's `CheckRunState` counts, which fold status and conclusion
 * into one value.
 */
function checkRunCountState(state: string): GitHubCheckState {
  const value = state.toLowerCase();
  return lookup(CONCLUSION_STATES, value) ?? lookup(STATUS_STATES, value) ?? unknownState("checkRunState", state);
}

/** The state of a commit status, from GraphQL's `StatusState` or REST's lower-case one. */
export function statusContextStateOf(state: string): GitHubCheckState {
  switch (state.toUpperCase()) {
    case "SUCCESS": return "success";
    case "FAILURE":
    case "ERROR": return "failure";
    case "PENDING": return "inProgress";
    // A required status that has not reported yet.
    case "EXPECTED": return "queued";
    default: return unknownState("statusState", state);
  }
}

/**
 * Whether an item will keep moving on its own. A `waiting` item is held by a deployment
 * environment: `blocked` when a person must approve it, or when that is not known; `active` when
 * only a wait timer or an external protection rule holds it.
 */
export function phaseOf(state: GitHubCheckState, waitingNeedsPerson = true): GitHubCiPhase {
  switch (state) {
    case "queued":
    case "inProgress":
      return "active";
    case "waiting":
      return waitingNeedsPerson ? "blocked" : "active";
    case "actionRequired":
    case "unknown":
      return "blocked";
    default:
      return "done";
  }
}

/** The rollup's combined verdict, from GraphQL's `StatusState` (null when nothing reported). */
export function rollupStateOf(state: string | null | undefined): GitHubCommitChecks["state"] {
  switch (state) {
    case null:
    case undefined: return "none";
    case "SUCCESS": return "success";
    case "FAILURE":
    case "ERROR": return "failure";
    case "PENDING": return "pending";
    case "EXPECTED": return "expected";
    default:
      unknownState("rollupState", state);
      return "pending";
  }
}

/**
 * A commit's phase from its entries' phases, or undefined when nothing has reported (the
 * absence policy decides then). An `expected` rollup waits on a required status: `active`.
 */
export function rollupPhaseOf(
  state: GitHubCommitChecks["state"], phases: readonly GitHubCiPhase[],
): GitHubCiRollupPhase | undefined {
  if (state === "expected" || phases.includes("active")) return "active";
  if (phases.includes("blocked")) return "blocked";
  return phases.length > 0 ? "done" : undefined;
}

/**
 * The absence policy, for a commit nothing has reported on: `notStarted` while a push of it is
 * queued, or while CI is expected and the commit became a head less than `CI_START_WINDOW_MS`
 * ago; otherwise `done` (no CI ran on it).
 */
export function absencePhaseOf(options: {
  pushQueued: boolean; ciExpected: boolean; becameHeadAt: number | undefined; now: number;
}): "notStarted" | "done" {
  if (options.pushQueued) return "notStarted";
  const { ciExpected, becameHeadAt, now } = options;
  return ciExpected && becameHeadAt !== undefined && now - becameHeadAt < CI_START_WINDOW_MS
    ? "notStarted" : "done";
}

/** CI on a commit only a queued push will deliver to GitHub: nothing has reported on it yet. */
export function queuedCommitChecks(commitId: string): GitHubCommitChecks {
  return { commitId, state: "none", phase: "notStarted", counts: {}, checks: [] };
}

/** How many of `states` are in each state. */
export function countStates(states: Iterable<GitHubCheckState>): Partial<Record<GitHubCheckState, number>> {
  const counts: Partial<Record<GitHubCheckState, number>> = {};
  for (const state of states) counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}

/** The counts GraphQL reports for the whole rollup, past any entry it was not paged through. */
export function countsFromRollup(
  checkRuns: readonly { state: string; count: number }[],
  statusContexts: readonly { state: string; count: number }[],
): Partial<Record<GitHubCheckState, number>> {
  const counts: Partial<Record<GitHubCheckState, number>> = {};
  const add = (state: GitHubCheckState, count: number) => {
    if (count > 0) counts[state] = (counts[state] ?? 0) + count;
  };
  for (const { state, count } of checkRuns) add(checkRunCountState(state), count);
  for (const { state, count } of statusContexts) add(statusContextStateOf(state), count);
  return counts;
}

/** Whether a `.github/workflows` tree holds a workflow file. */
export function hasWorkflowFiles(entries: readonly { name: string; type: string }[] | null | undefined): boolean {
  return (entries ?? []).some(entry => entry.type === "blob" && /\.ya?ml$/i.test(entry.name));
}

/** What an entry is known by: a check run's name, a commit status's context. */
export function entryName(entry: GitHubCheckEntry): string {
  return entry.kind === "checkRun" ? entry.name : entry.context;
}

/** A deployment environment's hold on a `waiting` job. */
export type PendingDeployment = NonNullable<GitHubCheckRunDetails["pendingDeployment"]>;

/** GraphQL's `DeploymentRequest`, as the queries below select it. */
export type GqlDeploymentRequest = {
  waitTimer: number;
  waitTimerStartedAt: string | null;
  environment: { name: string };
  reviewers: { totalCount: number };
};

export function pendingDeploymentOf(request: GqlDeploymentRequest | null | undefined): PendingDeployment | undefined {
  if (!request) return undefined;
  const started = request.waitTimerStartedAt ? Date.parse(request.waitTimerStartedAt) : NaN;
  return {
    environment: request.environment.name,
    needsReviewers: request.reviewers.totalCount > 0,
    waitTimerEndsAt: request.waitTimer > 0 && Number.isFinite(started)
      ? new Date(started + request.waitTimer * 60_000) : undefined,
  };
}

const DEPLOYMENT_REQUEST_FIELDS = `
  waitTimer waitTimerStartedAt environment { name } reviewers { totalCount }`;

/**
 * One page of a commit's status check rollup, with (on the first page, `$first`) its committer
 * date, its first parent's rollup state and the `.github/workflows` tree at `$workflows`
 * (`"<sha>:.github/workflows"`), which decide whether CI is expected. `isRequired` is asked only
 * for a pull request (`$withPull`). Reads `repository(...) { databaseId }` for
 * `GitHubApi.queryRepository`.
 */
export const ROLLUP_QUERY = `
query($owner: String!, $name: String!, $followRenames: Boolean!, $oid: GitObjectID!,
      $workflows: String!, $after: String, $first: Boolean!, $withPull: Boolean!, $pull: Int) {
  repository(owner: $owner, name: $name, followRenames: $followRenames) {
    databaseId
    object(oid: $oid) {
      ... on Commit {
        committedDate
        parents(first: 1) @include(if: $first) { nodes { statusCheckRollup { state } } }
        statusCheckRollup {
          state
          contexts(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
            nodes {
              __typename
              ... on CheckRun {
                databaseId name status conclusion startedAt completedAt url detailsUrl
                isRequired(pullRequestNumber: $pull) @include(if: $withPull)
                pendingDeploymentRequest { ${DEPLOYMENT_REQUEST_FIELDS} }
                checkSuite { app { name } workflowRun { databaseId workflow { name } } }
              }
              ... on StatusContext {
                context state description targetUrl updatedAt
                isRequired(pullRequestNumber: $pull) @include(if: $withPull)
              }
            }
          }
        }
      }
    }
    workflows: object(expression: $workflows) @include(if: $first) {
      ... on Tree { entries { name type } }
    }
  }
}`;

/** A waiting check run's deployment hold, by the check run's node id. */
export const PENDING_DEPLOYMENT_QUERY = `
query($id: ID!) {
  node(id: $id) { ... on CheckRun { pendingDeploymentRequest { ${DEPLOYMENT_REQUEST_FIELDS} } } }
}`;

export type GqlCheckRun = {
  __typename: "CheckRun";
  databaseId: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  detailsUrl: string | null;
  isRequired?: boolean;
  pendingDeploymentRequest: GqlDeploymentRequest | null;
  checkSuite: {
    app: { name: string } | null;
    workflowRun: { databaseId: number | null; workflow: { name: string } } | null;
  } | null;
};

export type GqlStatusContext = {
  __typename: "StatusContext";
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  updatedAt: string;
  isRequired?: boolean;
};

export type GqlRollupData = {
  repository: {
    databaseId: number | null;
    object: {
      committedDate?: string;
      parents?: { nodes: ({ statusCheckRollup: { state: string } | null } | null)[] | null };
      statusCheckRollup?: {
        state: string;
        contexts: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          checkRunCountsByState: { state: string; count: number }[] | null;
          statusContextCountsByState: { state: string; count: number }[] | null;
          nodes: (GqlCheckRun | GqlStatusContext | null)[] | null;
        };
      } | null;
    } | null;
    workflows?: { entries?: { name: string; type: string }[] | null } | null;
  } | null;
};

/** A rollup entry, with whether the pull request asked about requires it (GraphQL's `isRequired`). */
export type RollupEntry = GitHubCheckEntry & { isRequired?: boolean };

export function rollupEntryOf(node: GqlCheckRun | GqlStatusContext): RollupEntry {
  if (node.__typename === "StatusContext") {
    const state = statusContextStateOf(node.state);
    const entry: GitHubStatusSummary & { isRequired?: boolean } = {
      kind: "status",
      context: node.context,
      state,
      phase: phaseOf(state),
      description: node.description ?? undefined,
      targetUrl: node.targetUrl ?? undefined,
      updatedAt: new Date(node.updatedAt),
    };
    if (node.isRequired !== undefined) entry.isRequired = node.isRequired;
    return entry;
  }
  const state = checkStateOf(node.status, node.conclusion);
  const deployment = pendingDeploymentOf(node.pendingDeploymentRequest);
  const workflowRun = node.checkSuite?.workflowRun;
  const entry: GitHubCheckRunSummary & { isRequired?: boolean } = {
    kind: "checkRun",
    id: String(node.databaseId),
    name: node.name,
    state,
    phase: phaseOf(state, deployment?.needsReviewers ?? true),
    app: node.checkSuite?.app?.name ?? "",
    workflowRun: workflowRun?.databaseId == null
      ? undefined : { id: String(workflowRun.databaseId), name: workflowRun.workflow.name },
    startedAt: node.startedAt ? new Date(node.startedAt) : undefined,
    completedAt: node.completedAt ? new Date(node.completedAt) : undefined,
    url: node.url,
    detailsUrl: node.detailsUrl ?? undefined,
  };
  if (node.isRequired !== undefined) entry.isRequired = node.isRequired;
  return entry;
}

/** The id at the end of a `.../check-runs/<id>` API URL, as a job's `check_run_url` is. */
export function checkRunIdOfUrl(url: string | null | undefined): number | undefined {
  const id = url?.match(/\/check-runs\/(\d+)$/)?.[1];
  return id === undefined ? undefined : Number(id);
}

/**
 * The Actions job behind a GitHub Actions check run: the job id in its `details_url`
 * (`.../actions/runs/<run>/job/<job>`), else the check run's own id, which Actions reuses.
 */
export function actionsJobIdOf(run: Pick<GitHubCheckRunResponse, "id" | "details_url">): number {
  const id = run.details_url?.match(/\/actions\/runs\/\d+\/jobs?\/(\d+)/)?.[1];
  return id === undefined ? run.id : Number(id);
}

/** A caller-given check run, job or workflow run id, which must be a positive decimal integer. */
export function parseCiId(id: string, what: string): number {
  const value = /^\d{1,16}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${JSON.stringify(id)} is not a ${what} id: pass the number from its URL.`);
  }
  return value;
}

/** A check run from the checks API, with its Actions job when it is one. */
export function checkRunSummaryOf(
  run: GitHubCheckRunResponse, job: GitHubWorkflowJobResponse | undefined, waitingNeedsPerson = true,
): GitHubCheckRunSummary {
  const state = checkStateOf(run.status, run.conclusion);
  return {
    kind: "checkRun",
    id: String(run.id),
    name: run.name,
    state,
    phase: phaseOf(state, waitingNeedsPerson),
    app: run.app?.name ?? "",
    workflowRun: job === undefined ? undefined : { id: String(job.run_id), name: job.workflow_name ?? "" },
    startedAt: run.started_at ? new Date(run.started_at) : undefined,
    completedAt: run.completed_at ? new Date(run.completed_at) : undefined,
    url: run.html_url ?? "",
    detailsUrl: run.details_url ?? undefined,
  };
}

export function checkRunDetailsOf(
  run: GitHubCheckRunResponse, job: GitHubWorkflowJobResponse | undefined,
  pendingDeployment: PendingDeployment | undefined,
): GitHubCheckRunDetails {
  return {
    ...checkRunSummaryOf(run, job, pendingDeployment?.needsReviewers ?? true),
    commitId: run.head_sha,
    title: run.output.title ?? undefined,
    summaryMarkdown: run.output.summary ?? undefined,
    textMarkdown: run.output.text ?? undefined,
    annotationCount: run.output.annotations_count,
    steps: job?.steps?.map(step => {
      const state = checkStateOf(step.status, step.conclusion);
      return { number: step.number, name: step.name, state, phase: phaseOf(state) };
    }),
    pendingDeployment,
  };
}

/** An Actions job as a check run summary, for `GitHubWorkflowRun.listJobs()`. */
export function jobSummaryOf(job: GitHubWorkflowJobResponse): GitHubCheckRunSummary {
  const state = checkStateOf(job.status, job.conclusion);
  return {
    kind: "checkRun",
    id: String(checkRunIdOfUrl(job.check_run_url) ?? job.id),
    name: job.name,
    state,
    phase: phaseOf(state),
    app: "GitHub Actions",
    workflowRun: { id: String(job.run_id), name: job.workflow_name ?? "" },
    startedAt: job.started_at ? new Date(job.started_at) : undefined,
    completedAt: job.completed_at ? new Date(job.completed_at) : undefined,
    url: job.html_url ?? "",
    detailsUrl: job.html_url ?? undefined,
  };
}

export function workflowRunSummaryOf(run: GitHubWorkflowRunResponse): GitHubWorkflowRunSummary {
  const state = checkStateOf(run.status, run.conclusion);
  return {
    id: String(run.id),
    name: run.name ?? "",
    event: run.event,
    branch: run.head_branch ?? undefined,
    commitId: run.head_sha,
    state,
    phase: phaseOf(state),
    attempt: run.run_attempt ?? 1,
    createdAt: new Date(run.created_at),
    updatedAt: new Date(run.updated_at),
    url: run.html_url,
  };
}

export function workflowRunDetailsOf(run: GitHubWorkflowRunResponse): GitHubWorkflowRunDetails {
  return {
    ...workflowRunSummaryOf(run),
    startedAt: run.run_started_at ? new Date(run.run_started_at) : undefined,
    actor: actorFromUser(run.actor),
  };
}

/**
 * The REST `status` filter narrowest around `state`. GitHub has none for a startup failure, so
 * that asks for completed runs, which the caller filters further.
 */
const STATE_FILTERS: Record<NonNullable<GitHubWorkflowRunFilter["state"]>, string> = {
  queued: "queued",
  inProgress: "in_progress",
  waiting: "waiting",
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  timedOut: "timed_out",
  actionRequired: "action_required",
  skipped: "skipped",
  neutral: "neutral",
  stale: "stale",
  startupFailure: "completed",
};

export function workflowRunStatusFilter(state: GitHubWorkflowRunFilter["state"]): string | undefined {
  if (state === undefined) return undefined;
  const filter = lookup(STATE_FILTERS, state);
  if (filter === undefined) throw new Error(`Unknown workflow run state ${JSON.stringify(state)}.`);
  return filter;
}

export function annotationOf(annotation: GitHubCheckAnnotationResponse): GitHubAnnotation {
  const level = annotation.annotation_level;
  return {
    path: annotation.path,
    startLine: annotation.start_line,
    endLine: annotation.end_line,
    level: level === "warning" || level === "failure" ? level : "notice",
    title: annotation.title ?? undefined,
    message: annotation.message,
  };
}

const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}) /;
const LOG_COMMAND = /^##\[(group|endgroup|error|warning|notice|debug)\]/;

/**
 * One raw Actions job-log line as `readCiLog` keeps it, or null when it is markup only. Strips the
 * leading timestamp, then ANSI escapes and carriage-return overwrites; `##[group]X` becomes `▶ X`,
 * `##[endgroup]` is dropped, and `##[error]`, `##[warning]`, `##[notice]` and `##[debug]` become
 * `error: `, `warning: `, `notice: ` and `debug: `. Everything else is kept verbatim.
 */
export function normalizeGitHubLogLine(line: string): string | null {
  const text = applyCarriageReturns(stripAnsi(line.replace(LOG_TIMESTAMP, "")));
  const command = LOG_COMMAND.exec(text);
  if (command === null) return text;
  const rest = text.slice(command[0].length);
  switch (command[1]) {
    case "group": return `▶ ${rest}`;
    case "endgroup": return null;
    default: return `${command[1]}: ${rest}`;
  }
}

const MERGE_STATES: Record<string, GitHubPullRequestDetails["mergeState"]> = {
  clean: "clean",
  blocked: "blocked",
  behind: "behind",
  dirty: "dirty",
  unstable: "unstable",
  has_hooks: "hasHooks",
  draft: "draft",
  unknown: "unknown",
};

/** A pull request's REST `mergeable_state`, which GitHub leaves unset until it has computed it. */
export function mergeStateOf(state: string | null | undefined): GitHubPullRequestDetails["mergeState"] {
  if (state === null || state === undefined) return "unknown";
  const known = lookup(MERGE_STATES, state);
  if (known === undefined) {
    logger.warn("unrecognised GitHub merge state", {
      event: "pull.merge_state.unknown", ciField: "mergeable_state", ciValue: state,
    });
  }
  return known ?? "unknown";
}
