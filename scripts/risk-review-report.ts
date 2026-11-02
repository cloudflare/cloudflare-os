// Rebuilds the risk-review calibration table from what GitHub already stores: the decision JSON at
// the top of each `risk-review` check run, the reviews people gave, and revert pull requests. One row
// per pull request merged into the default branch in the window: band, area, both reviewer scores and
// findings, what the gate would have done, what people did, and any revert within 14 days.
//
//   GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <app slug> --since 2026-11-01 [--until 2026-12-01]
//
// GITHUB_REPOSITORY defaults to cloudflare/cloudflare-os. The table goes to stdout as Markdown.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { asObject, parseJson, type Json } from "./risk-review-policy.ts";

/** A revert counts if it merged within this long after the pull request. */
export const REVERT_WINDOW_DAYS = 14;

const CHECK_NAME = "risk-review";

/** The pull request fields the report reads. */
export interface MergedPull {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  updated_at: string;
  head: { sha: string };
  user: { login: string } | null;
}

/** The review fields the report reads. */
export interface ReportReview {
  user: { login: string; type?: string } | null;
  state: string;
}

/** One verdict's scores in the decision record. */
export interface VerdictCell {
  confidence: number | null;
  findings: string;
}

/** One table row. */
export interface ReportRow {
  number: number;
  merged: string;
  band: string;
  area: string;
  sol: VerdictCell | undefined;
  opus: VerdictCell | undefined;
  would: string;
  person: string;
  revert: number | undefined;
}

function verdictCell(value: Json | undefined): VerdictCell | undefined {
  const input = asObject(value);
  const findings = asObject(input?.findings);
  const confidence = input?.merge_confidence;
  if (!input || !findings || (confidence !== null && typeof confidence !== "number")) return undefined;
  const counts = ["P0", "P1", "P2", "P3"].map((severity) => {
    const count = findings[severity];
    return typeof count === "number" ? count : 0;
  });
  return { confidence, findings: counts.join("/") };
}

/**
 * Reads one pull request's entry from a `risk-review` check run's summary, which leads with the
 * decision JSON in a fenced block.
 *
 * @returns The band, area, verdicts and would-decision, or `undefined` when the summary has none.
 */
export function readDecision(summary: string, number: number):
  Pick<ReportRow, "band" | "area" | "sol" | "opus" | "would"> | undefined {
  const match = /^```json\n(.*)\n```/s.exec(summary);
  const record = asObject(match?.[1] === undefined ? undefined : parseJson(match[1]));
  const pulls = record?.pulls;
  if (record?.schema !== 1 || !Array.isArray(pulls)) return undefined;
  const pull = pulls.map(asObject).find((entry) => entry?.number === number);
  const { band, area } = pull ?? {};
  const would = asObject(pull?.would)?.decision;
  if (typeof band !== "string" || typeof area !== "string" || typeof would !== "string") return undefined;
  const inputs = asObject(pull?.inputs);
  return { band, area, would, sol: verdictCell(inputs?.sol), opus: verdictCell(inputs?.opus) };
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

/** The first pull request that reverted `pull` within {@link REVERT_WINDOW_DAYS} of its merge. */
export function findRevert(pull: MergedPull, merged: MergedPull[], repository: string): number | undefined {
  if (!pull.merged_at) return undefined;
  const start = Date.parse(pull.merged_at);
  const end = start + REVERT_WINDOW_DAYS * 86_400_000;
  const mention = new RegExp(`(?:${repository.replace("/", "\\/")})?#${pull.number}(?!\\d)`);
  return merged.find((other) => {
    const at = other.merged_at ? Date.parse(other.merged_at) : Number.NaN;
    return at > start && at <= end && /^Revert\b/i.test(other.title) &&
      (mention.test(other.title) || mention.test(other.body ?? ""));
  })?.number;
}

function cell(verdict: VerdictCell | undefined): string {
  return verdict ? `${verdict.confidence ?? "–"} (${verdict.findings})` : "absent";
}

/** Renders the rows as a Markdown table. */
export function renderTable(rows: ReportRow[]): string {
  const header = "| PR | Merged | Band | Area | Sol (P0/P1/P2/P3) | Opus (P0/P1/P2/P3) | Gate would | People | Revert ≤14 days |";
  const lines = rows.map((row) =>
    `| #${row.number} | ${row.merged} | ${row.band} | ${row.area} | ${cell(row.sol)} | ${cell(row.opus)} | ` +
    `${row.would} | ${row.person} | ${row.revert === undefined ? "no" : `#${row.revert}`} |`);
  return [header, "|---|---|---|---|---|---|---|---|---|", ...lines].join("\n");
}

/** A GET against the GitHub REST API, returning parsed JSON. */
export type GitHubGet = (path: string) => Promise<Json>;

/** Builds {@link GitHubGet} over `fetch` with a token. */
export function githubGet(token: string, fetchImpl: typeof fetch = fetch): GitHubGet {
  return async (path) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    const body = parseJson(await response.text());
    if (body === undefined) throw new Error(`GET ${path}: not JSON`);
    return body;
  };
}

function asPull(value: Json): MergedPull | undefined {
  const pull = asObject(value);
  const head = asObject(pull?.head)?.sha;
  const user = asObject(pull?.user)?.login;
  const { number, title, body, merged_at, updated_at } = pull ?? {};
  if (typeof number !== "number" || typeof title !== "string" || typeof head !== "string" || typeof updated_at !== "string") {
    return undefined;
  }
  return {
    number,
    title,
    body: typeof body === "string" ? body : null,
    merged_at: typeof merged_at === "string" ? merged_at : null,
    updated_at,
    head: { sha: head },
    user: typeof user === "string" ? { login: user } : null,
  };
}

/** Builds the report's rows for pull requests merged in `[since, until)`. */
export async function buildReport(get: GitHubGet, { repository, app, since, until }: {
  repository: string;
  app: string;
  since: Date;
  until: Date;
}): Promise<ReportRow[]> {
  const horizon = until.getTime() + REVERT_WINDOW_DAYS * 86_400_000;
  const merged: MergedPull[] = [];
  for (let page = 1; ; page++) {
    const listed = await get(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    const pulls = Array.isArray(listed) ? listed.map(asPull) : [];
    for (const pull of pulls) if (pull?.merged_at && Date.parse(pull.merged_at) <= horizon) merged.push(pull);
    const last = pulls.at(-1);
    // Sorted by last update, and a merge is an update, so once a page ends before `since` nothing later merged in the window.
    if (!Array.isArray(listed) || listed.length < 100 || !last || Date.parse(last.updated_at) < since.getTime()) break;
  }
  const inWindow = merged
    .filter(({ merged_at }) => merged_at && Date.parse(merged_at) >= since.getTime() && Date.parse(merged_at) < until.getTime())
    .toSorted((a, b) => a.number - b.number);

  const rows: ReportRow[] = [];
  for (const pull of inWindow) {
    const runs = asObject(await get(
      `/repos/${repository}/commits/${pull.head.sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    ))?.check_runs;
    const run = (Array.isArray(runs) ? runs : []).map(asObject).find((entry) =>
      asObject(entry?.app)?.slug === app && entry?.status === "completed");
    const summary = asObject(run?.output)?.summary;
    const decision = typeof summary === "string" ? readDecision(summary, pull.number) : undefined;
    const reviewsJson = await get(`/repos/${repository}/pulls/${pull.number}/reviews?per_page=100`);
    const reviews = (Array.isArray(reviewsJson) ? reviewsJson : []).flatMap((value) => {
      const review = asObject(value);
      const user = asObject(review?.user);
      const { login, type } = user ?? {};
      const state = review?.state;
      if (typeof state !== "string") return [];
      return [{ state, user: typeof login === "string" ? { login, type: typeof type === "string" ? type : undefined } : null }];
    });
    rows.push({
      number: pull.number,
      merged: pull.merged_at?.slice(0, 10) ?? "",
      band: decision?.band ?? "no record",
      area: decision?.area ?? "",
      sol: decision?.sol,
      opus: decision?.opus,
      would: decision?.would ?? "",
      person: personAction(reviews, pull.user?.login),
      revert: findRevert(pull, merged, repository),
    });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { app: { type: "string" }, since: { type: "string" }, until: { type: "string" } },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!token || !values.app || !values.since) {
    throw new Error("usage: GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <slug> --since YYYY-MM-DD [--until YYYY-MM-DD]");
  }
  const since = new Date(values.since);
  const until = values.until ? new Date(values.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error("--since and --until must be dates");
  const rows = await buildReport(githubGet(token), {
    repository: process.env.GITHUB_REPOSITORY ?? "cloudflare/cloudflare-os",
    app: values.app,
    since,
    until,
  });
  process.stdout.write(`${renderTable(rows)}\n`);
}
