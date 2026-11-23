// Prints the shadow table from what GitHub already stores: the decision JSON at the top of each
// `risk-review` check run, what people did, and later pull requests.
//
//   GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <app slug> --since 2026-11-01 [--until 2026-12-01]
//
// One row per pull request merged into the default branch in the window, from the record on its
// merged head: risk level, both reviewers' scores and finding counts, what the gate would have
// done, what people did, and the pull requests merged within 14 days that revert it or name it.
// The team reads this table before it lowers `threshold` in `.github/automerge.json`.
//
// GITHUB_REPOSITORY defaults to cloudflare/cloudflare-os. The table goes to stdout as Markdown.

import { parseArgs } from "node:util";

import { maybeJson, maybeObject, type Json } from "./automerge/json.ts";
import { isMain } from "./automerge/main.ts";
import { SEVERITIES } from "./automerge/verdict/parse-review.ts";
import { CHECK_NAME } from "./risk-review.ts";

/** A follow-up counts if it merged within this long after the pull request. */
const FOLLOW_UP_DAYS = 14;

/** The pull request fields the report reads. */
export interface MergedPull {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  updated_at: string;
  head: { sha: string };
  base: { ref: string };
  user: { login: string } | null;
}

/** The review fields the report reads. */
interface ReportReview {
  user: { login: string; type?: string } | null;
  state: string;
}

/** One verdict's scores in the decision record. */
interface VerdictCell {
  confidence: number | null;
  findings: string;
}

/** A pull request merged after another whose title or body names it; a revert when its title says so. */
interface FollowUp {
  number: number;
  revert: boolean;
}

/** One table row. */
interface ReportRow {
  number: number;
  merged: string;
  /** The risk level, or `no record` when the merged head has no decision. */
  band: string;
  bonk: VerdictCell | undefined;
  opus: VerdictCell | undefined;
  would: string;
  person: string;
  followUps: FollowUp[];
}

function verdictCell(value: Json | undefined): VerdictCell | undefined {
  const input = maybeObject(value);
  const findings = maybeObject(input?.findings);
  const confidence = input?.merge_confidence;
  if (!input || !findings || (confidence !== null && typeof confidence !== "number")) return undefined;
  const counts = SEVERITIES.map((severity) => {
    const count = findings[severity];
    return typeof count === "number" ? count : 0;
  });
  return { confidence, findings: counts.join("/") };
}

/**
 * Reads one pull request's entry from a `risk-review` check run's summary, which leads with the
 * decision JSON in a fenced block.
 *
 * @returns The risk level, verdicts and what the gate would have done, or `undefined` when the
 *     summary has none.
 */
export function readDecision(summary: string, number: number):
  Pick<ReportRow, "band" | "bonk" | "opus" | "would"> | undefined {
  const pulls = recordOf(summary)?.pulls;
  if (!Array.isArray(pulls)) return undefined;
  const pull = pulls.map(maybeObject).find((entry) => entry?.number === number);
  const band = pull?.band;
  const { decision, rung } = maybeObject(pull?.would) ?? {};
  const would = decision === "person" ? "person" : decision === "auto" && typeof rung === "string" ? `merge (${rung})` : undefined;
  if (typeof band !== "string" || would === undefined) return undefined;
  const inputs = maybeObject(pull?.inputs);
  return { band, would, bonk: verdictCell(inputs?.bonk), opus: verdictCell(inputs?.opus) };
}

/** What people did: the strongest human review other than the author's. */
export function personAction(reviews: ReportReview[], author: string | undefined): string {
  const states = new Set(reviews
    .filter(({ user }) => user?.type === "User" && user.login !== author)
    .map(({ state }) => state));
  if (states.has("CHANGES_REQUESTED")) return "changes requested";
  if (states.has("APPROVED")) return "approved";
  if (states.has("COMMENTED")) return "commented";
  return "no review";
}

/** The pull requests merged within {@link FOLLOW_UP_DAYS} after `pull` whose title or body names it. */
export function followUps(pull: MergedPull, merged: MergedPull[], repository: string): FollowUp[] {
  if (!pull.merged_at) return [];
  const start = Date.parse(pull.merged_at);
  const end = start + FOLLOW_UP_DAYS * 86_400_000;
  // `#N`, `owner/repo#N` for this repository, or a link to the pull request, with or without a
  // fragment or subpage. The look-behind keeps `#N` at the end of another repository's reference
  // (`cloudflare/workers-sdk#N`) from counting.
  const repo = repository.replace("/", "\\/");
  const mention = new RegExp(`(?:(?<![\\w/.-])(?:${repo})?#|https:\\/\\/github\\.com\\/${repo}\\/(?:pull|issues)\\/)${pull.number}(?!\\d)`);
  return merged.flatMap((other) => {
    const at = other.merged_at ? Date.parse(other.merged_at) : Number.NaN;
    const names = mention.test(other.title) || mention.test(other.body ?? "");
    return other.number !== pull.number && at > start && at <= end && names
      ? [{ number: other.number, revert: /^Revert\b/i.test(other.title) }]
      : [];
  });
}

function cell(verdict: VerdictCell | undefined): string {
  return verdict ? `${verdict.confidence ?? "–"} (${verdict.findings})` : "absent";
}

/** Renders the rows as a Markdown table. */
export function renderTable(rows: ReportRow[]): string {
  const header = "| PR | Merged | Risk | Bonk (P0/P1/P2/P3) | Opus (P0/P1/P2/P3) | Gate would | People | Follow-ups ≤14 days |";
  const lines = rows.map((row) => {
    const later = row.followUps.map(({ number, revert }) => `${revert ? "reverted by" : "named by"} #${number}`);
    return `| #${row.number} | ${row.merged} | ${row.band} | ${cell(row.bonk)} | ${cell(row.opus)} | ` +
      `${row.would} | ${row.person} | ${later.length > 0 ? later.join(", ") : "none"} |`;
  });
  return [header, "|---|---|---|---|---|---|---|---|", ...lines].join("\n");
}

/** A GET against the GitHub REST API, returning parsed JSON. */
export type GitHubGet = (path: string) => Promise<Json>;

function githubGet(token: string, fetchImpl: typeof fetch = fetch): GitHubGet {
  return async (path) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    const body = maybeJson(await response.text());
    if (body === undefined) throw new Error(`GET ${path}: not JSON`);
    return body;
  };
}

function asPull(value: Json): MergedPull | undefined {
  const pull = maybeObject(value);
  const head = maybeObject(pull?.head)?.sha;
  const base = maybeObject(pull?.base)?.ref;
  const user = maybeObject(pull?.user)?.login;
  const { number, title, body, merged_at, updated_at } = pull ?? {};
  if (
    typeof number !== "number" || typeof title !== "string" || typeof head !== "string" || typeof base !== "string" ||
    typeof updated_at !== "string"
  ) {
    return undefined;
  }
  return {
    number,
    title,
    body: typeof body === "string" ? body : null,
    merged_at: typeof merged_at === "string" ? merged_at : null,
    updated_at,
    head: { sha: head },
    base: { ref: base },
    user: typeof user === "string" ? { login: user } : null,
  };
}

/** Every page of a listing endpoint that returns a JSON array. */
async function listPages(get: GitHubGet, path: string): Promise<Json[]> {
  const all: Json[] = [];
  for (let page = 1; ; page++) {
    const listed = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(listed)) throw new Error(`${path} is not a list`);
    all.push(...listed);
    if (listed.length < 100) return all;
  }
}

/**
 * The pull requests merged into the default branch from `since` to {@link FOLLOW_UP_DAYS} after
 * `until`, which holds every follow-up of those merged in the window, and those merged in the window.
 */
async function listMerged(get: GitHubGet, { repository, since, until }: { repository: string; since: Date; until: Date }):
  Promise<{ merged: MergedPull[]; inWindow: MergedPull[] }> {
  const horizon = until.getTime() + FOLLOW_UP_DAYS * 86_400_000;
  const defaultBranch = maybeObject(await get(`/repos/${repository}`))?.default_branch;
  if (typeof defaultBranch !== "string") throw new Error(`cannot read ${repository}'s default branch`);
  const merged: MergedPull[] = [];
  for (let page = 1; ; page++) {
    const listed = await get(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    const pulls = Array.isArray(listed) ? listed.map(asPull) : [];
    for (const pull of pulls) {
      // Only the default branch is gated, so only its merges are rows and follow-ups.
      if (pull?.merged_at && pull.base.ref === defaultBranch && Date.parse(pull.merged_at) <= horizon) merged.push(pull);
    }
    const last = pulls.at(-1);
    // Sorted by last update, and a merge is an update, so once a page ends before `since` nothing later merged in the window.
    if (!Array.isArray(listed) || listed.length < 100 || !last || Date.parse(last.updated_at) < since.getTime()) break;
  }
  const inWindow = merged
    .filter(({ merged_at }) => merged_at && Date.parse(merged_at) >= since.getTime() && Date.parse(merged_at) < until.getTime())
    .toSorted((a, b) => a.number - b.number);
  return { merged, inWindow };
}

/** The decision record JSON a `risk-review` check run's summary leads with. */
function recordOf(summary: string): { [key: string]: Json } | undefined {
  const match = /^```json\n(.*)\n```/s.exec(summary);
  const record = maybeObject(match?.[1] === undefined ? undefined : maybeJson(match[1]));
  return record?.schema === 1 ? record : undefined;
}

/** Builds the report's rows for pull requests merged in `[since, until)`. */
export async function buildReport(get: GitHubGet, { repository, app, since, until }: {
  repository: string;
  app: string;
  since: Date;
  until: Date;
}): Promise<ReportRow[]> {
  const { merged, inWindow } = await listMerged(get, { repository, since, until });

  const rows: ReportRow[] = [];
  for (const pull of inWindow) {
    const runs = maybeObject(await get(
      `/repos/${repository}/commits/${pull.head.sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    ))?.check_runs;
    const run = (Array.isArray(runs) ? runs : []).map(maybeObject).find((entry) =>
      maybeObject(entry?.app)?.slug === app && entry?.status === "completed");
    const summary = maybeObject(run?.output)?.summary;
    const decision = typeof summary === "string" ? readDecision(summary, pull.number) : undefined;
    const reviewsJson = await listPages(get, `/repos/${repository}/pulls/${pull.number}/reviews`);
    const reviews = reviewsJson.flatMap((value) => {
      const review = maybeObject(value);
      const user = maybeObject(review?.user);
      const { login, type } = user ?? {};
      const state = review?.state;
      if (typeof state !== "string") return [];
      return [{ state, user: typeof login === "string" ? { login, type: typeof type === "string" ? type : undefined } : null }];
    });
    rows.push({
      number: pull.number,
      merged: pull.merged_at?.slice(0, 10) ?? "",
      band: decision?.band ?? "no record",
      bonk: decision?.bonk,
      opus: decision?.opus,
      would: decision?.would ?? "",
      person: personAction(reviews, pull.user?.login),
      followUps: followUps(pull, merged, repository),
    });
  }
  return rows;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { app: { type: "string" }, since: { type: "string" }, until: { type: "string" } } });
  const token = process.env.GITHUB_TOKEN;
  if (!token || !values.app || !values.since) {
    throw new Error("usage: GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <slug> --since YYYY-MM-DD [--until YYYY-MM-DD]");
  }
  const since = new Date(values.since);
  const until = values.until ? new Date(values.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error("--since and --until must be dates");
  const repository = process.env.GITHUB_REPOSITORY ?? "cloudflare/cloudflare-os";
  const rows = await buildReport(githubGet(token), { repository, app: values.app, since, until });
  process.stdout.write(`${renderTable(rows)}\n`);
}
