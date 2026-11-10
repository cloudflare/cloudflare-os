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
  /** The reviewer's job name, such as `Verdict (sol)`. */
  jobName: string;
}

/**
 * Heads this reviewer reviewed: completed `pull_request` runs of the workflow on the pull request's
 * branch whose job for this reviewer succeeded (the job fails whenever the verdict is not `ok`).
 * A run that lists no pull request still counts when it ran on this branch: GitHub leaves the list
 * empty in some cases, and an extra round sends the pull request to a person sooner, never later.
 */
export async function fetchReviewedHeads(query: RunQuery, getJson: (path: string) => Promise<Json>): Promise<ReviewedHead[]> {
  const { repository, workflowFile, pullNumber, headRef, jobName } = query;
  const runs: Json[] = [];
  for (let page = 1; ; page++) {
    const batch = list(field(await getJson(`repos/${repository}/actions/workflows/${workflowFile}/runs?` +
      `event=pull_request&status=completed&branch=${encodeURIComponent(headRef)}&per_page=${PER_PAGE}&page=${page}`),
    "workflow_runs"));
    runs.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
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
    if (jobs.some(job => field(job, "name") === jobName && field(job, "conclusion") === "success")) {
      reviewed.push({ sha, reviewedAt: createdAt });
    }
  }
  return reviewed;
}
