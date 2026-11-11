// Rebuilds the risk-review calibration tables from what GitHub already stores: the decision JSON at
// the top of each `risk-review` check run, what people did, and later pull requests.
//
//   GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <app slug> --since 2026-11-01 [--until 2026-12-01] [--calibrate]
//
// Without `--calibrate`: one row per pull request merged into the default branch in the window, from
// the record on its merged head: band, area, both reviewer scores and findings, what the gate would
// have done, what people did, and any revert within 14 days.
//
// With `--calibrate`: for each area, band, reviewer configuration and threshold from 10 to 1, which
// pull requests the gate would have merged, how many of those people later caught something in, and
// the run of clean ones since the last miss (see {@link calibrate}). A band opens only when that run
// reaches 60, and the threshold is lowered a step at a time as the record supports it.
//
// GITHUB_REPOSITORY defaults to cloudflare/cloudflare-os. The table goes to stdout as Markdown.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { BANDS, asObject, parseJson, parseMaintainers, type Json } from "./risk-review-policy.ts";
import { CHECK_NAME, POLICY_FILES, parseBands } from "./risk-review.ts";

/** A revert counts if it merged within this long after the pull request. */
export const REVERT_WINDOW_DAYS = 14;

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
  bonk: VerdictCell | undefined;
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
  Pick<ReportRow, "band" | "area" | "bonk" | "opus" | "would"> | undefined {
  const pulls = recordOf(summary)?.pulls;
  if (!Array.isArray(pulls)) return undefined;
  const pull = pulls.map(asObject).find((entry) => entry?.number === number);
  const { band, area } = pull ?? {};
  const would = asObject(pull?.would)?.decision;
  if (typeof band !== "string" || typeof area !== "string" || typeof would !== "string") return undefined;
  const inputs = asObject(pull?.inputs);
  return { band, area, would, bonk: verdictCell(inputs?.bonk), opus: verdictCell(inputs?.opus) };
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

/** The pull requests merged within {@link REVERT_WINDOW_DAYS} after `pull` whose title or body names it. */
export function followUps(pull: MergedPull, merged: MergedPull[], repository: string): { number: number; revert: boolean }[] {
  if (!pull.merged_at) return [];
  const start = Date.parse(pull.merged_at);
  const end = start + REVERT_WINDOW_DAYS * 86_400_000;
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

/** The first pull request that reverted `pull` within {@link REVERT_WINDOW_DAYS} of its merge. */
export function findRevert(pull: MergedPull, merged: MergedPull[], repository: string): number | undefined {
  return followUps(pull, merged, repository).find(({ revert }) => revert)?.number;
}

function cell(verdict: VerdictCell | undefined): string {
  return verdict ? `${verdict.confidence ?? "–"} (${verdict.findings})` : "absent";
}

/** Renders the rows as a Markdown table. */
export function renderTable(rows: ReportRow[]): string {
  const header = "| PR | Merged | Band | Area | Bonk (P0/P1/P2/P3) | Opus (P0/P1/P2/P3) | Gate would | People | Revert ≤14 days |";
  const lines = rows.map((row) =>
    `| #${row.number} | ${row.merged} | ${row.band} | ${row.area} | ${cell(row.bonk)} | ${cell(row.opus)} | ` +
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

/** A GitHub GraphQL query, returning the parsed `data`. */
export type GitHubGraphql = (query: string, variables: Record<string, string | number | null>) => Promise<Json>;

/** Builds {@link GitHubGraphql} over `fetch` with a token. */
export function githubGraphql(token: string, fetchImpl: typeof fetch = fetch): GitHubGraphql {
  return async (query, variables) => {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GraphQL: HTTP ${response.status}`);
    const body = asObject(parseJson(await response.text()));
    if (!body || body.errors !== undefined || body.data === undefined) throw new Error("GraphQL: no data");
    return body.data;
  };
}

/**
 * Each force push of a pull request: the head it replaced, the head it left, and when. REST's
 * `head_ref_force_pushed` event names only the head it left, and a rebase drops the replaced head
 * from the commits listing, so only GraphQL shows the replaced head.
 */
async function forcePushes(graphql: GitHubGraphql, repository: string, number: number):
  Promise<{ before: string | null; after: string | null; at: number }[]> {
  const [owner, name] = repository.split("/");
  const pushes: { before: string | null; after: string | null; at: number }[] = [];
  for (let cursor: string | null = null; ;) {
    const data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } } }
            }
          }
        }
      }`,
      { owner: owner ?? "", name: name ?? "", number, cursor },
    );
    const items = asObject(asObject(asObject(asObject(data)?.repository)?.pullRequest)?.timelineItems);
    const nodes = items?.nodes;
    const page = asObject(items?.pageInfo);
    if (!Array.isArray(nodes) || !page) throw new Error(`#${number}'s force pushes are unreadable`);
    for (const value of nodes) {
      const node = asObject(value);
      const before = asObject(node?.beforeCommit)?.oid;
      const after = asObject(node?.afterCommit)?.oid;
      const at = node?.createdAt;
      if (typeof at !== "string") throw new Error(`#${number} has a force push without a time`);
      pushes.push({ before: typeof before === "string" ? before : null, after: typeof after === "string" ? after : null, at: Date.parse(at) });
    }
    if (page.hasNextPage !== true) return pushes;
    cursor = typeof page.endCursor === "string" ? page.endCursor : null;
    if (cursor === null) throw new Error(`#${number}'s force pushes do not page`);
  }
}

function asPull(value: Json): MergedPull | undefined {
  const pull = asObject(value);
  const head = asObject(pull?.head)?.sha;
  const base = asObject(pull?.base)?.ref;
  const user = asObject(pull?.user)?.login;
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
 * The pull requests merged into the default branch from `since` to {@link REVERT_WINDOW_DAYS} after
 * `until`, which holds every follow-up of those merged in the window, and those merged in the window.
 */
async function listMerged(get: GitHubGet, { repository, since, until }: { repository: string; since: Date; until: Date }):
  Promise<{ merged: MergedPull[]; inWindow: MergedPull[]; defaultBranch: string }> {
  const horizon = until.getTime() + REVERT_WINDOW_DAYS * 86_400_000;
  const defaultBranch = asObject(await get(`/repos/${repository}`))?.default_branch;
  if (typeof defaultBranch !== "string") throw new Error(`cannot read ${repository}'s default branch`);
  const merged: MergedPull[] = [];
  for (let page = 1; ; page++) {
    const listed = await get(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    const pulls = Array.isArray(listed) ? listed.map(asPull) : [];
    for (const pull of pulls) {
      // Only the default branch is gated, so only it gives calibration samples and follow-ups.
      if (pull?.merged_at && pull.base.ref === defaultBranch && Date.parse(pull.merged_at) <= horizon) merged.push(pull);
    }
    const last = pulls.at(-1);
    // Sorted by last update, and a merge is an update, so once a page ends before `since` nothing later merged in the window.
    if (!Array.isArray(listed) || listed.length < 100 || !last || Date.parse(last.updated_at) < since.getTime()) break;
  }
  const inWindow = merged
    .filter(({ merged_at }) => merged_at && Date.parse(merged_at) >= since.getTime() && Date.parse(merged_at) < until.getTime())
    .toSorted((a, b) => a.number - b.number);
  return { merged, inWindow, defaultBranch };
}

/** The decision record JSON a `risk-review` check run's summary leads with. */
function recordOf(summary: Json | undefined): { [key: string]: Json } | undefined {
  const match = typeof summary === "string" ? /^```json\n(.*)\n```/s.exec(summary) : null;
  const record = asObject(match?.[1] === undefined ? undefined : parseJson(match[1]));
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
    const runs = asObject(await get(
      `/repos/${repository}/commits/${pull.head.sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    ))?.check_runs;
    const run = (Array.isArray(runs) ? runs : []).map(asObject).find((entry) =>
      asObject(entry?.app)?.slug === app && entry?.status === "completed");
    const summary = asObject(run?.output)?.summary;
    const decision = typeof summary === "string" ? readDecision(summary, pull.number) : undefined;
    const reviewsJson = await listPages(get, `/repos/${repository}/pulls/${pull.number}/reviews`);
    const reviews = reviewsJson.flatMap((value) => {
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
      bonk: decision?.bonk,
      opus: decision?.opus,
      would: decision?.would ?? "",
      person: personAction(reviews, pull.user?.login),
      revert: findRevert(pull, merged, repository),
    });
  }
  return rows;
}

/** The thresholds the calibration report tries, highest first. A band opens at 10. */
const THRESHOLDS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** One `risk-review` decision record for one pull request, as calibration reads it. */
export interface CalibrationRecord {
  /** When the check run completed. */
  at: number;
  /** The head commit it decided. */
  head: string;
  area: string;
  band: string;
  /**
   * Whether a policy rule, an unlisted file, a non-maintainer author or a missing migration proof
   * ruled out any merge.
   */
  ruledOut: boolean;
  /** Both reviewers' scores when their verdicts' own conditions held, else `null`. */
  scores: { bonk: number; opus: number } | null;
  /** The producers whose input held. */
  holding: ReadonlySet<string>;
  /** A short hash of both reviewers' fingerprints, or `null` when either verdict was absent. */
  reviewers: string | null;
  /** A completed check run whose record could not be read (truncated, or another shape). */
  unreadable?: true;
}

/** A maintainer's comment or review on the pull request, other than the author's. */
export interface MaintainerEvent {
  at: number;
  login: string;
  /** `comment` for an issue or review comment; a review's state otherwise. */
  kind: "comment" | "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED" | "DISMISSED";
}

/** What calibration reads about one merged pull request. */
export interface CalibrationPull {
  number: number;
  mergedAt: number;
  records: CalibrationRecord[];
  events: MaintainerEvent[];
  /**
   * When each head was pushed, as best GitHub shows it: the latest of its committer date, a force
   * push that left it, and its first check suite. An error either way can move a catch onto the
   * wrong head; a head with any unreadable record, or none, counts as one the reviewers passed.
   */
  pushes: { head: string; at: number }[];
  followUps: { number: number; revert: boolean }[];
}

/** One calibration row: an area, band, reviewer configuration and threshold. */
export interface CalibrationRow {
  area: string;
  band: string;
  reviewers: string;
  threshold: number;
  /** Admitted pull requests with no miss, 14 days or more after merge. */
  clean: number[];
  /** Admitted pull requests a person or a later fix caught something in, with why. */
  misses: { number: number; why: string[] }[];
  /** Admitted pull requests with no miss yet, under 14 days after merge. */
  pending: number[];
  /** Consecutive clean pull requests, by merge time, since the last miss in this row. */
  streak: number;
}

function min(scores: { bonk: number; opus: number }): number {
  return Math.min(scores.bonk, scores.opus);
}

/** The head `pull` had at `at`: the last one pushed at or before it, or `undefined` when none was. */
function headAt(pull: CalibrationPull, at: number): string | undefined {
  return pull.pushes.filter((push) => push.at <= at).toSorted((a, b) => a.at - b.at).at(-1)?.head;
}

/**
 * Why `pull` is a miss at a threshold, given its would-merge point; empty when it is not.
 *
 * A person's catch counts after the point, when the gate would already have merged. Before the
 * point it counts too, unless every record on the head the person was looking at shows the
 * reviewers never passed it (no eligible scores, or a lower score under the threshold, at any
 * time). A head the reviewers passed at some point, and that only a missing proof, a hold or a
 * reviewer still running kept from merging, is one a person had to catch; so is a head with no
 * readable record.
 */
function missReasons(pull: CalibrationPull, point: CalibrationRecord, threshold: number): string[] {
  const reasons: string[] = [];
  const reviewersPassed = (at: number) => {
    if (at > point.at) return true;
    const head = headAt(pull, at);
    const onHead = pull.records.filter((record) => head === undefined || record.head === head);
    return onHead.length === 0 ||
      onHead.some((record) => record.unreadable || (record.scores !== null && min(record.scores) >= threshold));
  };
  const pushedAfter = (at: number) => pull.pushes.some((push) => push.at > at);
  for (const { at, login, kind } of pull.events) {
    if (at >= pull.mergedAt || !reviewersPassed(at)) continue;
    // A dismissed review keeps no record of what it was, so it counts as a change request.
    if (kind === "CHANGES_REQUESTED" || kind === "DISMISSED") reasons.push(`@${login} requested changes`);
    else if (kind !== "APPROVED" && pushedAfter(at)) reasons.push(`@${login} commented, then a commit followed`);
  }
  for (const { number, revert } of pull.followUps) reasons.push(revert ? `reverted by #${number}` : `#${number} names it`);
  return reasons;
}

/**
 * Builds the calibration rows. For each threshold T from 10 to 1, a pull request's would-merge
 * point is its earliest record that no policy rule rules out, whose head was still the pull
 * request's head when it completed, whose band's evidence held and whose lower eligible score is at
 * least T; its row is that record's area, band and reviewers. A miss
 * counts as soon as it is seen; a pull request with none counts as clean only 14 days after merge.
 *
 * @param input The merged pull requests; each band's required evidence, keyed `<area> <band>`; and
 *     the time of the report.
 */
export function calibrate(pulls: CalibrationPull[], { evidence, now }: {
  evidence: ReadonlyMap<string, readonly string[]>;
  now: number;
}): CalibrationRow[] {
  const rows = new Map<string, CalibrationRow & { order: { mergedAt: number; clean: boolean }[] }>();
  for (const pull of pulls.toSorted((a, b) => a.mergedAt - b.mergedAt)) {
    const records = pull.records.toSorted((a, b) => a.at - b.at);
    for (const threshold of THRESHOLDS) {
      // A record from after the merge, or one that finished after a newer head was pushed, decided
      // nothing the gate could have acted on: the queue only takes the head the decision named.
      const point = records.find((record) =>
        record.at < pull.mergedAt && headAt(pull, record.at) === record.head &&
        !record.ruledOut && !record.unreadable && record.scores !== null && record.reviewers !== null && min(record.scores) >= threshold &&
        (evidence.get(`${record.area} ${record.band}`) ?? ["unknown band"]).every((name) => record.holding.has(name)));
      if (!point?.reviewers) continue;
      const key = `${point.area} ${point.band} ${point.reviewers} ${threshold}`;
      const row = rows.get(key) ?? {
        area: point.area, band: point.band, reviewers: point.reviewers, threshold,
        clean: [], misses: [], pending: [], streak: 0, order: [],
      };
      rows.set(key, row);
      const why = missReasons({ ...pull, records }, point, threshold);
      if (why.length > 0) {
        row.misses.push({ number: pull.number, why });
        row.order.push({ mergedAt: pull.mergedAt, clean: false });
      } else if (now - pull.mergedAt >= REVERT_WINDOW_DAYS * 86_400_000) {
        row.clean.push(pull.number);
        row.order.push({ mergedAt: pull.mergedAt, clean: true });
      } else {
        row.pending.push(pull.number);
      }
    }
  }
  return [...rows.values()].map(({ order, ...row }) => {
    const lastMiss = order.findLastIndex(({ clean }) => !clean);
    return { ...row, streak: order.length - lastMiss - 1 };
  }).toSorted((a, b) =>
    a.area.localeCompare(b.area) || bandOrder(a) - bandOrder(b) || a.reviewers.localeCompare(b.reviewers) ||
    b.threshold - a.threshold);
}

function bandOrder(row: CalibrationRow): number {
  return BANDS.findIndex((name) => name === row.band);
}

function numbered(numbers: number[]): string {
  return numbers.length === 0 ? "0" : `${numbers.length} (${numbers.map((n) => `#${n}`).join(", ")})`;
}

/** Renders the calibration rows as a Markdown table. */
export function renderCalibration(rows: CalibrationRow[]): string {
  const header = "| Area | Band | Reviewers | Threshold | Clean | Misses | Pending | Clean run (of 60) |";
  const lines = rows.map((row) =>
    `| ${row.area} | ${row.band} | ${row.reviewers} | ${row.threshold} | ${numbered(row.clean)} | ` +
    `${row.misses.length === 0 ? "0" : `${row.misses.length} (${row.misses.map(({ number, why }) => `#${number}: ${why.join("; ")}`).join(", ")})`} | ` +
    `${numbered(row.pending)} | ${row.streak} |`);
  return [header, "|---|---|---|---|---|---|---|---|", ...lines].join("\n");
}

/** A short, stable name for one reviewer configuration pair. */
function reviewersKey(inputs: { [key: string]: Json } | undefined): string | null {
  const prints = ["bonk", "opus"].map((name) => asObject(asObject(inputs?.[name])?.fingerprint));
  if (prints.some((print) => print === undefined)) return null;
  const fields = ["model", "opencode", "review_md", "prompt", "action"];
  const canonical = JSON.stringify(prints.map((print) => fields.map((field) => print?.[field] ?? null)));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Reads one pull request's calibration record from a check run, or `undefined` when it has none. */
export function readCalibrationRecord(summary: Json | undefined, number: number, at: number, head: string):
  CalibrationRecord | undefined {
  const pulls = recordOf(summary)?.pulls;
  const pull = Array.isArray(pulls) ? pulls.map(asObject).find((entry) => entry?.number === number) : undefined;
  const { area, band, never_auto, author, eligible_scores, inputs, needs_migration_proof } = pull ?? {};
  const scores = asObject(eligible_scores);
  const inputObject = asObject(inputs);
  const maintainer = asObject(author)?.maintainer;
  if (typeof area !== "string" || typeof band !== "string" || !Array.isArray(never_auto) || typeof maintainer !== "boolean") {
    return undefined;
  }
  if (typeof needs_migration_proof !== "boolean") return undefined;
  if (eligible_scores === undefined || (eligible_scores !== null && !scores) || !inputObject) return undefined;
  const { bonk, opus } = scores ?? {};
  const holding = new Set(Object.entries(inputObject).flatMap(([name, value]) => {
    const input = asObject(value);
    return input?.status === "ok" && input.holds === true ? [name] : [];
  }));
  return {
    at,
    head,
    area,
    band,
    ruledOut: never_auto.length > 0 || !maintainer || needs_migration_proof,
    scores: typeof bonk === "number" && typeof opus === "number" ? { bonk, opus } : null,
    holding,
    reviewers: reviewersKey(inputObject),
  };
}

async function readText(get: GitHubGet, repository: string, path: string): Promise<string | undefined> {
  const content = asObject(await get(`/repos/${repository}/contents/${path}`))?.content;
  return typeof content === "string" ? Buffer.from(content, "base64").toString("utf8") : undefined;
}

/** Gathers every record, maintainer event, push and follow-up of each pull request merged in the window. */
export async function buildCalibration(get: GitHubGet, graphql: GitHubGraphql, { repository, app, since, until, now }: {
  repository: string;
  app: string;
  since: Date;
  until: Date;
  now: Date;
}): Promise<CalibrationRow[]> {
  const maintainers = parseMaintainers(await readText(get, repository, POLICY_FILES.maintainers));
  if (maintainers.size === 0) throw new Error(`${POLICY_FILES.maintainers} is missing or malformed on the default branch`);
  const { config, problem } = parseBands(await readText(get, repository, POLICY_FILES.bands));
  if (problem) throw new Error(`${POLICY_FILES.bands}: ${problem}`);
  const evidence = new Map(Object.entries(config.areas).flatMap(([area, bands]) =>
    Object.entries(bands).map(([band, rule]): [string, readonly string[]] => [`${area} ${band}`, rule.evidence])));

  const { merged, inWindow, defaultBranch } = await listMerged(get, { repository, since, until });
  const pulls: CalibrationPull[] = [];
  for (const pull of inWindow) {
    const base = `/repos/${repository}`;
    const [commits, forced, comments, reviewComments, reviews] = await Promise.all([
      listPages(get, `${base}/pulls/${pull.number}/commits`),
      forcePushes(graphql, repository, pull.number),
      listPages(get, `${base}/issues/${pull.number}/comments`),
      listPages(get, `${base}/pulls/${pull.number}/comments`),
      listPages(get, `${base}/pulls/${pull.number}/reviews`),
    ]);
    // Every head seen: the commits now on the branch, and each head a force push replaced or left.
    // A replaced head GitHub no longer names has no visible record; a catch made on it then counts
    // as one on a head the reviewers passed.
    const pushedAt = new Map<string, number>();
    for (const value of commits) {
      const commit = asObject(value);
      const date = asObject(asObject(commit?.commit)?.committer)?.date;
      if (typeof commit?.sha === "string" && typeof date === "string") pushedAt.set(commit.sha, Date.parse(date));
    }
    for (const { before, after, at } of forced) {
      if (after !== null) pushedAt.set(after, Math.max(pushedAt.get(after) ?? 0, at));
      if (before === null) continue;
      // The replaced history: every commit the replaced head had over the default branch was a head
      // once (pushed some time before; its first check suite, read below, says when). Records on
      // them count only where the gate made them.
      const compared = asObject(await get(`${base}/compare/${defaultBranch}...${before}`));
      const listed = compared?.commits;
      if (!Array.isArray(listed) || compared?.total_commits !== listed.length) {
        pushedAt.set("unlisted", Number.POSITIVE_INFINITY);
      }
      for (const value of Array.isArray(listed) ? listed : []) {
        const sha = asObject(value)?.sha;
        if (typeof sha === "string" && !pushedAt.has(sha)) pushedAt.set(sha, 0);
      }
      if (!pushedAt.has(before)) pushedAt.set(before, 0);
    }
    // The commits listing stops at 250, so a longer pull request's pushes are not all known; any
    // comment then counts as followed by a commit.
    if (commits.length >= 250) pushedAt.set("unlisted", Number.POSITIVE_INFINITY);
    const records: CalibrationRecord[] = [];
    for (const sha of [...pushedAt.keys()].filter((key) => key !== "unlisted")) {
      const runs: Json[] = [];
      for (let page = 1; ; page++) {
        const listed = asObject(await get(`${base}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=all&per_page=100&page=${page}`))?.check_runs;
        if (!Array.isArray(listed)) throw new Error(`${sha}'s check runs are not a list`);
        runs.push(...listed);
        if (listed.length < 100) break;
      }
      // GitHub creates a head's first check suite when it is pushed (later ones come from check runs
      // apps add); a commit pushed under a later head has none, and that head's push covers it.
      const suites = asObject(await get(`${base}/commits/${sha}/check-suites?per_page=100`))?.check_suites;
      const created = (Array.isArray(suites) ? suites : []).flatMap((value) => {
        const at = asObject(value)?.created_at;
        return typeof at === "string" ? [Date.parse(at)] : [];
      });
      if (created.length > 0) pushedAt.set(sha, Math.max(pushedAt.get(sha) ?? 0, Math.min(...created)));
      for (const value of runs) {
        const run = asObject(value);
        const completed = run?.completed_at;
        // A cancelled run was superseded on purpose and decided nothing; the run that took over did.
        if (asObject(run?.app)?.slug !== app || run?.status !== "completed" || run.conclusion === "cancelled") continue;
        if (typeof completed !== "string") continue;
        const at = Date.parse(completed);
        // An unreadable record can never be a would-merge point, and counts as the reviewers having
        // passed its head, so it can only add misses.
        records.push(readCalibrationRecord(asObject(run?.output)?.summary, pull.number, at, sha) ?? {
          at, head: sha, area: "", band: "", ruledOut: true, scores: null, holding: new Set(), reviewers: null, unreadable: true,
        });
      }
    }
    const author = pull.user?.login.toLowerCase();
    const events: MaintainerEvent[] = [];
    const byMaintainer = (user: Json | undefined) => {
      const { login, type } = asObject(user) ?? {};
      return typeof login === "string" && type === "User" && login.toLowerCase() !== author && maintainers.has(login.toLowerCase())
        ? login
        : undefined;
    };
    for (const value of [...comments, ...reviewComments]) {
      const comment = asObject(value);
      const login = byMaintainer(comment?.user);
      if (login && typeof comment?.created_at === "string") events.push({ at: Date.parse(comment.created_at), login, kind: "comment" });
    }
    for (const value of reviews) {
      const review = asObject(value);
      const login = byMaintainer(review?.user);
      const { state, submitted_at } = review ?? {};
      if (!login || typeof submitted_at !== "string") continue;
      if (state === "APPROVED" || state === "COMMENTED" || state === "CHANGES_REQUESTED" || state === "DISMISSED") {
        events.push({ at: Date.parse(submitted_at), login, kind: state });
      }
    }
    pulls.push({
      number: pull.number,
      mergedAt: Date.parse(pull.merged_at ?? ""),
      records,
      events,
      pushes: [...pushedAt].map(([head, at]) => ({ head, at })),
      followUps: followUps(pull, merged, repository),
    });
  }
  return calibrate(pulls, { evidence, now: now.getTime() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { app: { type: "string" }, since: { type: "string" }, until: { type: "string" }, calibrate: { type: "boolean" } },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!token || !values.app || !values.since) {
    throw new Error("usage: GITHUB_TOKEN=… node scripts/risk-review-report.ts --app <slug> --since YYYY-MM-DD [--until YYYY-MM-DD] [--calibrate]");
  }
  const since = new Date(values.since);
  const until = values.until ? new Date(values.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error("--since and --until must be dates");
  const options = { repository: process.env.GITHUB_REPOSITORY ?? "cloudflare/cloudflare-os", app: values.app, since, until };
  const table = values.calibrate
    ? renderCalibration(await buildCalibration(githubGet(token), githubGraphql(token), { ...options, now: new Date() }))
    : renderTable(await buildReport(githubGet(token), options));
  process.stdout.write(`${table}\n`);
}
