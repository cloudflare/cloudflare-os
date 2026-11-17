// Review rounds, counted per reviewer by the distinct head commits it has already reviewed on a
// pull request. A re-run on the same head is the same round.
import { field, list, parseJson, type Json } from "./json.ts";

/** The first round that reviews only the changes since the previous reviewed head. */
export const DIFF_ONLY_ROUND = 3;
/** The first round that sends the pull request to a person. */
export const ROUND_LIMIT = 4;

/** The NEEDS-A-PERSON reason every verdict carries from round {@link ROUND_LIMIT} on. */
export function roundLimitReasons(round: number): string[] {
  return round >= ROUND_LIMIT ? ["round limit"] : [];
}

/** A head commit this reviewer reviewed, with when the review ran. */
export interface ReviewedHead {
  sha: string;
  reviewedAt: string;
}

export interface RoundPlan {
  round: number;
  /** The previous reviewed head when this round reviews only the changes since it, else null. */
  reviewFromSha: string | null;
}

/**
 * This head's round. Every earlier head counts toward the round, even one whose run cannot be
 * trusted, so the limit cannot be put off. `canReviewSince` says whether the changes since the
 * previous head are a fair stand-in for the pull request (see `verdict.ts`); when not, round 3
 * reviews the full diff.
 */
export function planRound(headSha: string, reviewed: ReviewedHead[], canReviewSince: (sha: string) => boolean): RoundPlan {
  const earlier = new Map<string, string>();
  for (const { sha, reviewedAt } of reviewed) {
    if (sha === headSha) continue;
    const seen = earlier.get(sha);
    if (seen === undefined || reviewedAt > seen) earlier.set(sha, reviewedAt);
  }
  const round = earlier.size + 1;
  if (round !== DIFF_ONLY_ROUND) return { round, reviewFromSha: null };
  const [previous] = [...earlier].toSorted(([, a], [, b]) => (a < b ? 1 : a > b ? -1 : 0));
  return { round, reviewFromSha: canReviewSince(previous[0]) ? previous[0] : null };
}

/** One authenticated GitHub REST read. */
export async function githubJson(path: string, token: string): Promise<Json> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "cloudflare-os-review-verdict",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API GET ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return parseJson(await response.text());
}

const PER_PAGE = 100;

/** Where the reviewer's past runs live, and which job in them is this reviewer's. */
export interface RunQuery {
  repository: string;
  workflowFile: string;
  pullNumber: number;
  headRef: string;
  /** The reviewer's job name, such as `Verdict (opus)`. */
  jobName: string;
  /**
   * A step of that job that must also have succeeded, when the job can succeed without a review
   * (Bonk's job passes with every step skipped under break-glass); null when the job's own result
   * says it (the Opus job fails whenever its verdict is not `ok`).
   */
  stepName: string | null;
}

type GetJson = (path: string) => Promise<Json>;

/** Every item of a paged GitHub list, read until a short page. */
async function listAll(getJson: GetJson, path: string, items: (body: Json) => Json[]): Promise<Json[]> {
  const all: Json[] = [];
  for (let page = 1; ; page++) {
    const batch = items(await getJson(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`));
    all.push(...batch);
    if (batch.length < PER_PAGE) return all;
  }
}

/**
 * Heads this reviewer reviewed: completed `pull_request` runs of the workflow on the pull request's
 * branch whose job for this reviewer (and `stepName`, when given) succeeded.
 * A run that lists no pull request still counts when it ran on this branch: GitHub leaves the list
 * empty in some cases, and an extra round sends the pull request to a person sooner, never later.
 */
export async function fetchReviewedHeads(query: RunQuery, getJson: GetJson): Promise<ReviewedHead[]> {
  const { repository, workflowFile, pullNumber, headRef, jobName, stepName } = query;
  const runs = await listAll(getJson, `repos/${repository}/actions/workflows/${workflowFile}/runs?` +
    `event=pull_request&status=completed&branch=${encodeURIComponent(headRef)}`, body => list(field(body, "workflow_runs")));
  const reviewed: ReviewedHead[] = [];
  for (const run of runs) {
    const id = field(run, "id");
    const sha = field(run, "head_sha");
    const createdAt = field(run, "created_at");
    const pulls = list(field(run, "pull_requests")).map(pull => field(pull, "number"));
    if (typeof id !== "number" || typeof sha !== "string" || typeof createdAt !== "string" ||
      field(field(run, "head_repository"), "full_name") !== repository ||
      (pulls.length > 0 && !pulls.includes(pullNumber)) || reviewed.some(head => head.sha === sha)) {
      continue;
    }
    const jobs = list(field(await getJson(`repos/${repository}/actions/runs/${id}/jobs?filter=all&per_page=${PER_PAGE}`),
      "jobs"));
    if (jobs.some(job => field(job, "name") === jobName && field(job, "conclusion") === "success" &&
      (stepName === null || list(field(job, "steps")).some(step =>
        field(step, "name") === stepName && field(step, "conclusion") === "success")))) {
      reviewed.push({ sha, reviewedAt: createdAt });
    }
  }
  return reviewed;
}

/**
 * Whether the pull request was ready for review, not a draft, at a given time, from its timeline's
 * `ready_for_review` and `convert_to_draft` events. With none, it has been as it is now throughout.
 */
export function readyAt(timeline: Json[], draftNow: boolean): (time: string) => boolean {
  const changes = timeline.flatMap(event => {
    const kind = field(event, "event");
    const at = field(event, "created_at");
    return (kind === "ready_for_review" || kind === "convert_to_draft") && typeof at === "string"
      ? [{ ready: kind === "ready_for_review", at }] : [];
  }).toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const readyFirst = changes.length === 0 ? !draftNow : !changes[0].ready;
  return time => changes.reduce((ready, change) => (change.at <= time ? change.ready : ready), readyFirst);
}

/** The pull request's timeline events. */
export function fetchTimeline(repository: string, pullNumber: number, getJson: GetJson): Promise<Json[]> {
  return listAll(getJson, `repos/${repository}/issues/${pullNumber}/timeline`, list);
}
