// Loaded by .github/workflows/risk-review.yml through actions/github-script, like
// contribution-policy.ts: its runtime is node24, which strips the types, and the GitHub API shapes
// are written structurally because this repository does not depend on the Octokit types.
//
// The gate posts the one `risk-review` check run on each pull request head and merge group, as the
// risk-review GitHub App. It is the only publisher: producer workflows (reviewer verdicts, rung 1
// proofs, band evidence) run on `pull_request`, write one artifact each, and post nothing; the gate
// reads those artifacts only from runs bound to the head (risk-review-contract.ts). It runs only
// from `main`'s definition, through `workflow_run` and `issue_comment`; merge groups reach it
// through the relay's `workflow_run`, and a merge group is accepted only when the merge queue lists
// its commit. It reads every policy file from the base branch, so a pull request cannot rewrite its
// own gate.
//
// What it decides, per pull request (rules in risk-review-policy.ts):
//
// - A band (low, medium, high) and an area from fixed rules, and whether the change touches a path
//   no AI may decide on (`NEVER_AUTO`).
// - Whether it could merge without a person: its area and band are open in
//   `.github/automerge-bands.json`, it touches no policy path, a maintainer wrote it (or Dependabot,
//   for rung 1's dependency proof only), no maintainer commented after the last push, and either a
//   rung 1 proof holds or both reviewers' verdicts clear the band's threshold, with the band's
//   evidence passing.
// - Otherwise a maintainer from `.github/maintainers` must approve the head commit, and a pull
//   request an agent opened needs its human assignee's approval.
//
// The bands file's `mode` sets what the check run reports. In `shadow`, which ships, it mirrors
// today's rule (`reviewDecision == APPROVED`), records the decision above without acting on it,
// and is not a required check, so it cannot change who merges. In `enforce` it reports the gate's own
// decision, and for an open band it approves (when App approvals count) and enqueues with the App's
// token. Every missing, stale or malformed input counts as absent, which sends the pull request to a
// person.

import { basename } from "node:path/posix";

import {
  AREAS,
  BANDS,
  addedClassDeletions,
  addedDependencies,
  isCatalogVersionBump,
  asObject,
  classifyChangeset,
  needsContents,
  parseEscapeSnapshot,
  parseJson,
  parseMaintainers,
  type Area,
  type Band,
  type ChangedFile,
  type Classification,
  type ContentFacts,
  type ContentsKind,
  type EscapeSnapshot,
  type Json,
} from "./risk-review-policy.ts";
import {
  PRODUCERS,
  VERDICT_NAMES,
  bindingError,
  followError,
  identityError,
  isProducerName,
  newestRun,
  parseFingerprint,
  parseProducerArtifact,
  pickArtifact,
  readArtifactFile,
  type Artifact,
  type BindingExpectation,
  type Fingerprint,
  type ProducerInput,
  type ProducerName,
  type WorkflowRun,
} from "./risk-review-contract.ts";

/** The check run the gate posts; the ruleset requires it once the gate enforces. */
export const CHECK_NAME = "risk-review";

/** Policy files, read at the base commit. */
export const POLICY_FILES = {
  maintainers: ".github/maintainers",
  bands: ".github/automerge-bands.json",
  escapes: ".github/automerge-escape-files.json",
} as const;

/** The decision JSON leads the check run's summary and stays under this, inside GitHub's 65,535. */
export const MAX_DECISION_CHARS = 60_000;

const MAX_SUMMARY_CHARS = 65_535;

const PER_PAGE = 100;

/** Bots that open pull requests on a schedule rather than at someone's direction. */
const DEPENDABOT = "dependabot[bot]";

/** Rung 1 proofs a maintainer's pull request may qualify through. */
// `proof-actions` is not here: every Actions bump touches `.github/**`, which always needs a person.
// Nor is `proof-migrations`: it holds for any change that leaves migrations alone, so it is only a
// precondition for a change that touches a Worker config.
const PROOFS = ["proof-deps", "proof-equivalence", "proof-tests"] as const;

/** What the check run reports. */
export type Mode = "shadow" | "enforce";

/** One area and band's entry in `.github/automerge-bands.json`. */
export interface BandRule {
  open: boolean;
  /** The lower reviewer score must be at least this, 0 to 10. */
  threshold: number | null;
  /** The reviewer configuration the band was calibrated on; a verdict from any other closes it. */
  reviewerFingerprint: Partial<Record<(typeof VERDICT_NAMES)[number], Fingerprint>> | null;
  /** Producers whose `holds` must be true. */
  evidence: ProducerName[];
}

/** `.github/automerge-bands.json`. */
export interface BandsConfig {
  mode: Mode;
  /** Whether the App's approving review counts toward the ruleset's required review. */
  appApprovalsCount: boolean;
  areas: Record<Area, Record<Band, BandRule>>;
}

const CLOSED_RULE: BandRule = { open: false, threshold: null, reviewerFingerprint: null, evidence: [] };

function closedArea(): Record<Band, BandRule> {
  return { low: CLOSED_RULE, medium: CLOSED_RULE, high: CLOSED_RULE };
}

/** Every area and band closed, as a fresh object the parser can fill in. */
function closedAreas(): BandsConfig["areas"] {
  return { proven: closedArea(), scored: closedArea(), "kernel-small": closedArea(), "agent-facing-api": closedArea(), kernel: closedArea() };
}

/** What a missing or malformed bands file means: shadow mode, every band closed. */
export const CLOSED_BANDS: BandsConfig = { mode: "shadow", appApprovalsCount: false, areas: closedAreas() };

function parseBandRule(value: Json | undefined, area: Area): BandRule | string {
  const rule = asObject(value);
  if (!rule) return "not an object";
  const { open, threshold, reviewer_fingerprint, evidence } = rule;
  if (typeof open !== "boolean") return "open is not a boolean";
  if (threshold !== null && (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0 || threshold > 10)) {
    return "threshold is not null or an integer from 0 to 10";
  }
  if (!Array.isArray(evidence)) return "evidence is not a list";
  const names = evidence.flatMap((name) => (typeof name === "string" && isProducerName(name) ? [name] : []));
  if (names.length !== evidence.length) return "evidence names an unknown producer";
  let reviewerFingerprint: BandRule["reviewerFingerprint"] = null;
  if (reviewer_fingerprint !== null) {
    const object = asObject(reviewer_fingerprint);
    if (!object) return "reviewer_fingerprint is not null or an object";
    reviewerFingerprint = {};
    for (const name of VERDICT_NAMES) {
      const print = parseFingerprint(object[name]);
      if (!print) return `reviewer_fingerprint.${name} is malformed`;
      reviewerFingerprint[name] = print;
    }
  }
  if (open && area !== "proven" && (threshold === null || reviewerFingerprint === null)) {
    return "an open AI-scored band needs a threshold and a reviewer fingerprint";
  }
  return { open, threshold, reviewerFingerprint, evidence: names };
}

function closedBecause(problem: string): { config: BandsConfig; problem: string } {
  return { config: CLOSED_BANDS, problem };
}

/**
 * Parses `.github/automerge-bands.json`. Anything malformed closes every band in shadow mode.
 *
 * @returns The config, and why it was replaced by {@link CLOSED_BANDS} if it was.
 */
export function parseBands(text: string | undefined): { config: BandsConfig; problem?: string } {
  if (text === undefined) return closedBecause("the bands file is missing");
  const root = asObject(parseJson(text));
  if (!root || root.schema !== 1) return closedBecause("the bands file is not schema 1 JSON");
  if (root.mode !== "shadow" && root.mode !== "enforce") return closedBecause("mode is not shadow or enforce");
  if (typeof root.app_approvals_count !== "boolean") return closedBecause("app_approvals_count is not a boolean");
  const areasJson = asObject(root.areas);
  if (!areasJson) return closedBecause("areas is not an object");
  const areas = closedAreas();
  for (const area of AREAS) {
    const bands = asObject(areasJson[area]);
    if (!bands) return closedBecause(`areas.${area} is missing`);
    for (const band of BANDS) {
      const rule = parseBandRule(bands[band], area);
      if (typeof rule === "string") return closedBecause(`areas.${area}.${band}: ${rule}`);
      areas[area][band] = rule;
    }
  }
  return { config: { mode: root.mode, appApprovalsCount: root.app_approvals_count, areas } };
}

/** Policy read from the base commit. */
export interface Policy {
  sha: string;
  maintainers: ReadonlySet<string>;
  bands: BandsConfig;
  bandsProblem?: string;
  escapes: EscapeSnapshot | undefined;
}

/** A GitHub account. `type` is `User` for people and `Bot` for apps and bot accounts. */
export interface GitHubUser {
  login: string;
  type?: string;
}

/** The pull request fields the gate reads. */
export interface PullRequest {
  number: number;
  node_id: string;
  state: string;
  draft?: boolean;
  user: GitHubUser | null;
  assignees?: GitHubUser[] | null;
  head: { sha: string };
  base: { sha: string; ref: string };
  /** Files changed, which can exceed what `pulls.listFiles` will list. */
  changed_files: number;
}

/** A pull request review. */
export interface Review {
  id: number;
  user?: GitHubUser | null;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  /** The head commit when the review was submitted. */
  commit_id?: string | null;
  submitted_at?: string | null;
}

/** An issue comment or a review comment. */
export interface Comment {
  user?: GitHubUser | null;
  created_at: string;
}

/** Everything the decision reads about one pull request. */
export interface PullInputs {
  pull: PullRequest;
  files: ChangedFile[];
  facts: ContentFacts;
  reviews: Review[];
  comments: Comment[];
  /** When the head commit was pushed, or `undefined` when unknown. */
  lastPush: string | undefined;
  reviewDecision: string | null;
  producers: Partial<Record<ProducerName, ProducerInput>>;
}

/** A producer input as the decision record shows it. */
export type InputSummary =
  | { absent: string }
  | { status: string; holds: boolean }
  | {
    status: string;
    merge_confidence: number | null;
    findings: Record<"P0" | "P1" | "P2" | "P3", number>;
    needs_person: string[];
    fingerprint: Fingerprint;
  };

/** The decision for one pull request, as the check run records it. */
export interface PullDecision {
  number: number;
  head_sha: string;
  base_sha: string;
  band: Band;
  band_reasons: string[];
  area: Classification["area"];
  never_auto: string[];
  author: { login: string; maintainer: boolean };
  approvers: string[];
  blockers: string[];
  holds: string[];
  inputs: Partial<Record<ProducerName, InputSummary>>;
  /** Today's rule, which shadow mode reports. */
  today: { review_decision: string | null; passes: boolean };
  /** The gate's own rule, which enforce mode reports. */
  gate: { passes: boolean; reason: string };
  /** Whether it could merge without a person, through which area, and every reason it cannot. */
  would: { decision: "auto" | "person"; area: Area | null; reasons: string[] };
}

/**
 * Finds the maintainers whose approval of the head commit counts, and those still requesting
 * changes. Each reviewer's latest decisive review counts, as on GitHub.
 *
 * @param reviews Every review on the pull request, oldest first.
 */
export function tallyReviews(reviews: Review[], { headSha, author, maintainers }: {
  headSha: string;
  author: string | undefined;
  maintainers: ReadonlySet<string>;
}): { approvers: string[]; blockers: string[] } {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const login = review.user?.login.toLowerCase();
    if (
      !login || review.user?.type !== "User" || login === author?.toLowerCase() || !maintainers.has(login) ||
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    ) {
      continue;
    }
    latest.set(login, review);
  }
  const approvers: string[] = [];
  const blockers: string[] = [];
  for (const [login, review] of latest) {
    if (review.state === "APPROVED" && review.commit_id === headSha) approvers.push(login);
    if (review.state === "CHANGES_REQUESTED") blockers.push(login);
  }
  return { approvers, blockers };
}

/**
 * Lists the maintainer holds: a maintainer other than the author commented, or reviewed with
 * comments or a change request, after the last push. An approval is not a hold. An unknown push
 * time holds, since any comment could be after it.
 */
export function maintainerHolds(reviews: Review[], comments: Comment[], { lastPush, author, maintainers }: {
  lastPush: string | undefined;
  author: string | undefined;
  maintainers: ReadonlySet<string>;
}): string[] {
  if (lastPush === undefined) return ["the time of the last push is unknown"];
  const pushed = Date.parse(lastPush);
  const holder = (user: GitHubUser | null | undefined, at: string | null | undefined): string[] => {
    const login = user?.login.toLowerCase();
    const counts = !!login && user?.type === "User" && login !== author?.toLowerCase() && maintainers.has(login) &&
      !!at && Date.parse(at) > pushed;
    return counts ? [login] : [];
  };
  const holders = new Set([
    ...comments.flatMap(({ user, created_at }) => holder(user, created_at)),
    ...reviews.flatMap(({ user, state, submitted_at }) =>
      state === "COMMENTED" || state === "CHANGES_REQUESTED" ? holder(user, submitted_at) : []),
  ]);
  return [...holders].map((login) => `@${login} commented after the last push`);
}

function summarize(input: ProducerInput): InputSummary {
  if ("absent" in input) return input;
  const { artifact } = input;
  if (artifact.kind !== "verdict") return { status: artifact.status, holds: artifact.holds };
  const findings = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const { severity } of artifact.findings) findings[severity]++;
  return {
    status: artifact.status,
    merge_confidence: artifact.merge_confidence,
    findings,
    needs_person: artifact.needs_person,
    fingerprint: artifact.fingerprint,
  };
}

function holding(input: ProducerInput | undefined): boolean {
  return !!input && "artifact" in input && input.artifact.kind !== "verdict" && input.artifact.status === "ok" &&
    input.artifact.holds;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.model === b.model && a.opencode === b.opencode && a.review_md === b.review_md && a.prompt === b.prompt;
}

/** Every reason the merge rule fails for one area and band; empty when it holds. */
function mergeRuleFailures(area: Area, band: Band, inputs: PullInputs, rule: BandRule): string[] {
  const reasons: string[] = [];
  if (!rule.open) reasons.push(`the ${area} area's ${band} band is closed`);
  if (area !== "proven") {
    const scores: number[] = [];
    for (const name of VERDICT_NAMES) {
      const input = inputs.producers[name] ?? { absent: "no run" };
      if ("absent" in input) {
        reasons.push(`${name} verdict absent: ${input.absent}`);
        continue;
      }
      const { artifact } = input;
      if (artifact.kind !== "verdict") {
        reasons.push(`${name} is not a verdict`);
        continue;
      }
      if (artifact.status !== "ok") reasons.push(`${name} verdict status is ${artifact.status}`);
      // A diff-only re-review did not look again at what earlier rounds found.
      if (artifact.review_from_sha !== null) {
        reasons.push(`${name} reviewed only the diff since ${artifact.review_from_sha.slice(0, 7)}`);
      }
      const pinned = rule.reviewerFingerprint?.[name];
      if (pinned && !sameFingerprint(pinned, artifact.fingerprint)) {
        reasons.push(`${name} ran with a configuration other than the band's, which closes the band for this pull request`);
      }
      const blocking = artifact.findings.filter(({ severity }) => severity === "P0" || severity === "P1");
      if (blocking.length > 0) reasons.push(`${name} found ${blocking.length} P0 or P1 issues`);
      for (const need of artifact.needs_person) reasons.push(`${name}: needs a person: ${need}`);
      if (artifact.merge_confidence === null) reasons.push(`${name} gave no merge confidence`);
      else scores.push(artifact.merge_confidence);
    }
    const lowest = Math.min(...scores);
    if (scores.length === VERDICT_NAMES.length && rule.threshold !== null && lowest < rule.threshold) {
      reasons.push(`lower merge confidence ${lowest} is below the band's ${rule.threshold}`);
    }
  }
  for (const name of rule.evidence) {
    if (!holding(inputs.producers[name])) reasons.push(`evidence ${name} does not hold`);
  }
  return reasons;
}

/**
 * Decides one pull request: the record shadow mode logs, today's rule, the gate's rule, and
 * whether it could merge without a person.
 */
export function decide(inputs: PullInputs, policy: Policy, now: Date): PullDecision {
  const { pull } = inputs;
  const author = pull.user ?? undefined;
  const authorLogin = author?.login ?? "";
  const classification = classifyChangeset({
    files: inputs.files,
    listed: inputs.files.length >= pull.changed_files,
    facts: inputs.facts,
    escapes: policy.escapes,
    now,
  });
  const maintainer = author?.type === "User" && policy.maintainers.has(authorLogin.toLowerCase());
  const dependabot = authorLogin === DEPENDABOT && author?.type === "Bot";
  const people = { author: author?.login, maintainers: policy.maintainers };
  const { approvers, blockers } = tallyReviews(inputs.reviews, { headSha: pull.head.sha, ...people });
  const holds = maintainerHolds(inputs.reviews, inputs.comments, { lastPush: inputs.lastPush, ...people });

  const common: string[] = [...classification.neverAuto.map((reason) => `policy: ${reason}`), ...holds];
  if (blockers.length > 0) common.push(`changes requested by ${blockers.map((login) => `@${login}`).join(", ")}`);
  const depsProven = holding(inputs.producers["proof-deps"]) && holding(inputs.producers["preview-smoke"]);
  const touchesWorkerConfig = inputs.files.some((file) =>
    [file.filename, file.previous_filename].some((path) => path !== undefined && needsContents(path) === "worker-config"));
  if (touchesWorkerConfig && !holding(inputs.producers["proof-migrations"])) {
    common.push("changes a Worker config, and the migration proof does not hold");
  }
  const proven = dependabot
    ? depsProven
    : PROOFS.some((name) => name === "proof-deps" ? depsProven : holding(inputs.producers[name]));
  const candidates: Area[] = [];
  if (proven) candidates.push("proven");
  if (maintainer) candidates.push(classification.area);
  else if (!dependabot) common.push("the author is not a maintainer");
  if (dependabot && !proven) common.push("a Dependabot pull request needs its dependency proof and preview smoke to hold");

  let would: PullDecision["would"] = { decision: "person", area: candidates[0] ?? null, reasons: [...common] };
  for (const area of candidates) {
    const failures = mergeRuleFailures(area, classification.band, inputs, policy.bands.areas[area][classification.band]);
    if (common.length === 0 && failures.length === 0) {
      would = { decision: "auto", area, reasons: [] };
      break;
    }
    would.reasons.push(...failures.map((reason) => `${area}: ${reason}`));
  }

  return {
    number: pull.number,
    head_sha: pull.head.sha,
    base_sha: pull.base.sha,
    band: classification.band,
    band_reasons: classification.bandReasons,
    area: classification.area,
    never_auto: classification.neverAuto,
    author: { login: authorLogin, maintainer },
    approvers,
    blockers,
    holds,
    inputs: Object.fromEntries(Object.entries(inputs.producers).map(([name, input]) => [name, summarize(input)])),
    today: { review_decision: inputs.reviewDecision, passes: inputs.reviewDecision === "APPROVED" },
    gate: gateRule(inputs, { approvers, blockers, autoApproves: would.decision === "auto" && policy.bands.appApprovalsCount }),
    would,
  };
}

/**
 * The gate's own rule: no outstanding change request; for a pull request an agent opened, a human
 * assignee's approval; and a maintainer's approval of the head commit, unless the App approves it.
 */
function gateRule(inputs: PullInputs, { approvers, blockers, autoApproves }: {
  approvers: string[];
  blockers: string[];
  autoApproves: boolean;
}): PullDecision["gate"] {
  const { pull } = inputs;
  const commit = pull.head.sha.slice(0, 7);
  if (blockers.length > 0) {
    return { passes: false, reason: `changes requested by ${blockers.map((login) => `@${login}`).join(", ")}` };
  }
  if (pull.user?.type === "Bot" && pull.user.login !== DEPENDABOT) {
    const directors = (pull.assignees ?? []).filter((user) => user.type === "User").map((user) => user.login.toLowerCase());
    if (directors.length === 0) {
      return { passes: false, reason: "an agent opened this; assign the person who directed it, who must approve" };
    }
    if (!directors.some((login) => approvers.includes(login))) {
      return { passes: false, reason: `needs approval of ${commit} from ${directors.map((l) => `@${l}`).join(" or ")}` };
    }
  }
  if (autoApproves) return { passes: true, reason: "the risk-review App approves it" };
  if (approvers.length === 0) return { passes: false, reason: `needs a maintainer's approval of ${commit}` };
  return { passes: true, reason: `approved by ${approvers.map((login) => `@${login}`).join(", ")}` };
}

/** The record the check run's summary leads with. */
export interface DecisionRecord {
  schema: 1;
  mode: Mode;
  event: string;
  sha: string;
  policy_sha: string;
  bands_problem?: string;
  conclusion: "success" | "failure";
  reason: string;
  pulls: PullDecision[];
  truncated?: true;
}

/** The check run's conclusion: today's rule in shadow mode, the gate's in enforce mode. */
export function conclude(pulls: PullDecision[], mode: Mode, problem?: string): Pick<DecisionRecord, "conclusion" | "reason"> {
  if (problem) return { conclusion: "failure", reason: problem };
  if (pulls.length === 0) return { conclusion: "failure", reason: "no pull request to decide" };
  const failing = pulls.filter((pull) => (mode === "shadow" ? !pull.today.passes : !pull.gate.passes));
  if (failing.length === 0) {
    return { conclusion: "success", reason: mode === "shadow" ? "approved under today's rule" : "the gate's rule holds" };
  }
  const why = failing.map((pull) =>
    `#${pull.number}: ${mode === "shadow" ? `review decision ${pull.today.review_decision ?? "none"}` : pull.gate.reason}`);
  return { conclusion: "failure", reason: why.join("; ") };
}

/**
 * Renders the check run's output: the decision JSON first, in a fenced block under
 * {@link MAX_DECISION_CHARS}, so truncation can only cut the prose after it.
 */
export function renderOutput(record: DecisionRecord): { title: string; summary: string } {
  let json = JSON.stringify(record);
  if (json.length > MAX_DECISION_CHARS) {
    const pulls = record.pulls.map(({ number, head_sha, base_sha, band, area, today, gate, would }) =>
      ({ number, head_sha, base_sha, band, area, today, gate, would: { ...would, reasons: would.reasons.slice(0, 5) } }));
    json = JSON.stringify({ ...record, pulls, truncated: true });
  }
  if (json.length > MAX_DECISION_CHARS) {
    const { pulls: _pulls, ...rest } = record;
    json = JSON.stringify({ ...rest, pulls: [], truncated: true });
  }
  const lines = record.pulls.map((pull) =>
    `- #${pull.number} at ${pull.head_sha.slice(0, 7)}: ${pull.band} band, ${pull.area} area; ` +
    `would ${pull.would.decision === "auto" ? `merge through ${pull.would.area}` : "go to a person"}` +
    (pull.would.reasons.length > 0 ? `: ${pull.would.reasons.join("; ")}` : ""));
  const prose = [`**${record.mode}**: ${record.reason}`, ...lines].join("\n");
  const summary = `\`\`\`json\n${json}\n\`\`\`\n\n${prose}`.slice(0, MAX_SUMMARY_CHARS);
  const title = `${record.mode}: ${record.conclusion === "success" ? "passes" : "blocked"}; would ` +
    (record.pulls.every((pull) => pull.would.decision === "auto") && record.pulls.length > 0 ? "auto-merge" : "need a person");
  return { title, summary };
}

interface RepoRef {
  owner: string;
  repo: string;
}

type PullRef = RepoRef & { pull_number: number };

type Page = { per_page: number; page: number };

/** A file or directory entry from `repos.getContent`. */
interface ContentEntry {
  type: string;
  content?: string;
  encoding?: string;
}

/** The subset of actions/github-script's authenticated Octokit client the gate calls. */
export interface GitHubClient {
  rest: {
    pulls: {
      get(args: PullRef): Promise<{ data: PullRequest }>;
      list(args: RepoRef & Page & { state: "open"; head: string; base: string }): Promise<{ data: PullRequest[] }>;
      listFiles(args: PullRef & Page): Promise<{ data: ChangedFile[] }>;
      listReviews(args: PullRef & Page): Promise<{ data: Review[] }>;
      listReviewComments(args: PullRef & Page): Promise<{ data: Comment[] }>;
      createReview(args: PullRef & { commit_id: string; event: "APPROVE"; body: string }): Promise<object>;
      dismissReview(args: PullRef & { review_id: number; message: string }): Promise<object>;
    };
    issues: {
      listComments(args: RepoRef & Page & { issue_number: number }): Promise<{ data: Comment[] }>;
    };
    repos: {
      getContent(args: RepoRef & { path: string; ref: string }): Promise<{ data: ContentEntry | ContentEntry[] }>;
      compareCommitsWithBasehead(args: RepoRef & { basehead: string; per_page: number }):
        Promise<{ data: { merge_base_commit: { sha: string } } }>;
      listPullRequestsAssociatedWithCommit(args: RepoRef & { commit_sha: string; per_page: number }):
        Promise<{ data: PullRequest[] }>;
    };
    checks: {
      create(args: RepoRef & { name: string; head_sha: string; status: "in_progress"; details_url: string }):
        Promise<{ data: { id: number } }>;
      update(args: RepoRef & {
        check_run_id: number;
        status: "completed";
        conclusion: "success" | "failure" | "cancelled";
        output: { title: string; summary: string };
      }): Promise<object>;
      listForRef(args: RepoRef & { ref: string; check_name: string; app_id: number; filter: "all"; per_page: number }):
        Promise<{ data: { check_runs: { id: number }[] } }>;
      listSuitesForRef(args: RepoRef & { ref: string; per_page: number }):
        Promise<{ data: { total_count: number; check_suites: { created_at: string | null }[] } }>;
    };
    actions: {
      listWorkflowRuns(args: RepoRef & { workflow_id: string; head_sha: string; event: string; per_page: number }):
        Promise<{ data: { total_count: number; workflow_runs: WorkflowRun[] } }>;
      getWorkflowRun(args: RepoRef & { run_id: number }): Promise<{ data: WorkflowRun }>;
      listWorkflowRunArtifacts(args: RepoRef & { run_id: number; name?: string; per_page: number }):
        Promise<{ data: { artifacts: Artifact[] } }>;
      listArtifactsForRepo(args: RepoRef & { name: string; per_page: number }): Promise<{ data: { artifacts: Artifact[] } }>;
      downloadArtifact(args: RepoRef & { artifact_id: number; archive_format: "zip" }): Promise<{ data: ArrayBuffer }>;
    };
  };
  graphql(query: string, variables: Record<string, string | number>): Promise<Json>;
}

/** The GitHub Actions event context fields the gate reads. */
export interface ActionsContext {
  eventName: string;
  /** For `workflow_run` and `issue_comment`, the default branch's head when the event fired. */
  sha: string;
  runId: number;
  serverUrl: string;
  repo: RepoRef;
  payload: {
    repository?: { default_branch: string; full_name: string };
    workflow_run?: {
      id: number;
      event: string;
      head_sha: string;
      head_branch: string | null;
      head_repository: { owner: { login: string } } | null;
      pull_requests?: { number: number; base: { ref: string } }[];
    };
    issue?: { number: number; pull_request?: object | null };
  };
}

/** The actions/github-script logging helpers the gate calls. */
export interface ActionsCore {
  notice(message: string): void;
  summary: { addRaw(text: string): ActionsCore["summary"]; write(): Promise<object> };
}

/** The risk-review App, whose token the workflow passes in. */
export interface RiskReviewApp {
  id: number;
  /** The App's bot login, `<slug>[bot]`. */
  login: string;
}

async function listAll<T>(list: (page: Page) => Promise<{ data: T[] }>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const { data } = await list({ per_page: PER_PAGE, page });
    all.push(...data);
    if (data.length < PER_PAGE) return all;
  }
}

function isNotFound(error: Error): boolean {
  return "status" in error && error.status === 404;
}

async function readFile(github: GitHubClient, repo: RepoRef, path: string, ref: string): Promise<string | undefined> {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64" || data.content === undefined) {
      return undefined;
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof Error && isNotFound(error)) return undefined;
    throw error;
  }
}

/** Reads the policy files at a base commit. */
export async function readPolicy(github: GitHubClient, repo: RepoRef, sha: string): Promise<Policy> {
  const [maintainers, bands, escapes] = await Promise.all([
    readFile(github, repo, POLICY_FILES.maintainers, sha),
    readFile(github, repo, POLICY_FILES.bands, sha),
    readFile(github, repo, POLICY_FILES.escapes, sha),
  ]);
  const { config, problem } = parseBands(bands);
  return {
    sha,
    maintainers: parseMaintainers(maintainers),
    bands: config,
    ...(problem && { bandsProblem: problem }),
    escapes: parseEscapeSnapshot(escapes),
  };
}

function contentsKind(file: ChangedFile): ContentsKind | undefined {
  return needsContents(file.filename) ?? (file.previous_filename === undefined ? undefined : needsContents(file.previous_filename));
}

async function readFacts(github: GitHubClient, repo: RepoRef, pull: PullRequest, files: ChangedFile[]): Promise<ContentFacts> {
  const facts: ContentFacts = { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [] };
  const needed = files.filter((file) => contentsKind(file) !== undefined);
  if (needed.length === 0) return facts;
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${pull.base.sha}...${pull.head.sha}`,
    per_page: 1,
  });
  const mergeBase = data.merge_base_commit.sha;
  for (const file of needed) {
    const added = file.status === "added";
    const removed = file.status === "removed";
    const before = added ? undefined : await readFile(github, repo, file.previous_filename ?? file.filename, mergeBase);
    const after = removed ? undefined : await readFile(github, repo, file.filename, pull.head.sha);
    // A side that exists but cannot be read (too large, not a file) is unknown, so it counts against the change.
    const unreadable = (!added && before === undefined) || (!removed && after === undefined);
    switch (contentsKind(file)) {
      case "workspace":
        facts.workspaceCatalogOnly = before !== undefined && after !== undefined && isCatalogVersionBump(before, after);
        break;
      case "manifest": {
        const names = unreadable ? undefined : addedDependencies(before, after);
        if (names === undefined) facts.newDependencies.push(`${file.filename}: unreadable`);
        else facts.newDependencies.push(...names.map((name) => `${file.filename}: ${name}`));
        break;
      }
      case "worker-config": {
        // Removing a Worker's config removes the Worker, and its Durable Objects with it.
        const deleted = unreadable || after === undefined ? undefined : addedClassDeletions(before, after);
        if (deleted === undefined) facts.deletedClasses.push(`${file.filename}: ${removed ? "removed" : "unreadable"}`);
        else facts.deletedClasses.push(...deleted.map((name) => `${file.filename}: ${name}`));
        break;
      }
      case undefined:
        break;
    }
  }
  return facts;
}

/** When the head was pushed: the earliest check suite GitHub created for it. */
async function readLastPush(github: GitHubClient, repo: RepoRef, sha: string): Promise<string | undefined> {
  const { data } = await github.rest.checks.listSuitesForRef({ ...repo, ref: sha, per_page: PER_PAGE });
  if (data.total_count === 0 || data.total_count > data.check_suites.length) return undefined;
  const times = data.check_suites.flatMap(({ created_at }) => (created_at ? [Date.parse(created_at)] : []));
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
}

async function readReviewDecision(github: GitHubClient, repo: RepoRef, number: number): Promise<string | null> {
  const response = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } }
    }`,
    { owner: repo.owner, repo: repo.repo, number },
  );
  const decision = asObject(asObject(asObject(response)?.repository)?.pullRequest)?.reviewDecision;
  return typeof decision === "string" ? decision : null;
}

async function readProducers(github: GitHubClient, repo: RepoRef, pull: PullRequest, context: ActionsContext):
  Promise<Partial<Record<ProducerName, ProducerInput>>> {
  const repository = `${repo.owner}/${repo.repo}`;
  const defaultBranch = context.payload.repository?.default_branch ?? "main";
  const runsByWorkflow = new Map<string, WorkflowRun[] | string>();
  const runsOf = async (workflow: string) => {
    const cached = runsByWorkflow.get(workflow);
    if (cached !== undefined) return cached;
    let runs: WorkflowRun[] | string;
    try {
      const { data } = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id: basename(workflow),
        head_sha: pull.head.sha,
        event: "pull_request",
        per_page: PER_PAGE,
      });
      runs = data.total_count > data.workflow_runs.length ? "too many runs to tell which is newest" : data.workflow_runs;
    } catch (error) {
      if (!(error instanceof Error && isNotFound(error))) throw error;
      runs = `${workflow} does not exist`;
    }
    runsByWorkflow.set(workflow, runs);
    return runs;
  };

  const inputs: Partial<Record<ProducerName, ProducerInput>> = {};
  for (const [name, producer] of Object.entries(PRODUCERS)) {
    if (!isProducerName(name)) continue;
    const expected = { producer, headSha: pull.head.sha, repository, defaultBranch };
    const runs = await runsOf(producer.workflow);
    if (typeof runs === "string") {
      inputs[name] = { absent: runs };
      continue;
    }
    const candidates = [...runs];
    let trigger: WorkflowRun | undefined;
    if ("triggeredBy" in producer) {
      const triggers = await runsOf(producer.triggeredBy);
      const triggerExpected = { ...expected, producer: { kind: producer.kind, workflow: producer.triggeredBy } };
      trigger = typeof triggers === "string"
        ? undefined
        : newestRun(triggers.filter((candidate) => identityError(candidate, triggerExpected) === undefined));
      const { data } = await github.rest.actions.listArtifactsForRepo({
        ...repo,
        name: `automerge-${name}-${pull.head.sha}`,
        per_page: PER_PAGE,
      });
      const ids = new Set(data.artifacts.flatMap(({ workflow_run }) => (workflow_run?.id ? [workflow_run.id] : [])));
      for (const run_id of ids) candidates.push((await github.rest.actions.getWorkflowRun({ ...repo, run_id })).data);
    }
    // Only the producer's own runs compete to be the newest, so an unrelated run cannot mask them.
    const run = newestRun(candidates.filter((candidate) => identityError(candidate, expected) === undefined));
    const input = await readProducer(github, repo, { name, run, pull, expected });
    const follow = run?.event === "workflow_run" && "artifact" in input ? followError(input.artifact, trigger) : undefined;
    inputs[name] = follow ? { absent: follow } : input;
  }
  return inputs;
}

async function readProducer(github: GitHubClient, repo: RepoRef, { name, run, pull, expected }: {
  name: ProducerName;
  run: WorkflowRun | undefined;
  pull: PullRequest;
  expected: BindingExpectation;
}): Promise<ProducerInput> {
  if (!run) return { absent: "no run" };
  const error = bindingError(run, expected);
  if (error) return { absent: error };
  // The preview smoke names the head it checked in both its routes; other producers run on the head.
  const artifactName = "triggeredBy" in expected.producer ? `automerge-${name}-${pull.head.sha}` : `automerge-${name}`;
  const { data } = await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: run.id, name: artifactName, per_page: PER_PAGE });
  const artifact = pickArtifact(data.artifacts, artifactName, run);
  if (!artifact) return { absent: "the run's latest attempt uploaded no usable artifact" };
  const zip = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: "zip" });
  const file = readArtifactFile(new Uint8Array(zip.data), `automerge-${name}.json`);
  if ("absent" in file) return file;
  return parseProducerArtifact(file.text, { name, headSha: pull.head.sha, baseSha: pull.base.sha });
}

/** Reads everything the decision needs about one pull request. */
export async function readPullInputs(github: GitHubClient, context: ActionsContext, pull: PullRequest): Promise<PullInputs> {
  const repo = context.repo;
  const ref = { ...repo, pull_number: pull.number };
  const files = await listAll((page) => github.rest.pulls.listFiles({ ...ref, ...page }));
  const [facts, reviews, issueComments, reviewComments, lastPush, reviewDecision, producers] = await Promise.all([
    readFacts(github, repo, pull, files),
    listAll((page) => github.rest.pulls.listReviews({ ...ref, ...page })),
    listAll((page) => github.rest.issues.listComments({ ...repo, issue_number: pull.number, ...page })),
    listAll((page) => github.rest.pulls.listReviewComments({ ...ref, ...page })),
    readLastPush(github, repo, pull.head.sha),
    readReviewDecision(github, repo, pull.number),
    readProducers(github, repo, pull, context),
  ]);
  return { pull, files, facts, reviews, comments: [...issueComments, ...reviewComments], lastPush, reviewDecision, producers };
}

/** The commit a run posts on, the pull requests it decides, and the commit policy is read at. */
interface Target {
  sha: string;
  policySha: string;
  pulls: PullRequest[];
  mergeGroup: boolean;
  /** Set when the event names a commit but its pull requests cannot be told apart. */
  problem?: string;
}

async function openPullIntoDefault(github: GitHubClient, context: ActionsContext, number: number) {
  const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const base = context.payload.repository?.default_branch;
  return data.state === "open" && data.base.ref === base ? data : undefined;
}

/**
 * The pull requests in the merge group whose commit is `headSha`, oldest first, and the group's
 * base: walk from the entry whose merge commit is `headSha` back through each entry's base until a
 * base that is no entry's commit. `undefined` when no queue entry has that commit, so a branch that
 * only looks like a merge group's is never decided as one.
 */
export function mergeGroupPulls(entries: Json, headSha: string): { numbers: number[]; baseSha: string } | undefined {
  const nodes = asObject(asObject(asObject(asObject(entries)?.repository)?.mergeQueue)?.entries)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const byHead = new Map<string, { base: string; number: number }>();
  for (const node of nodes) {
    const entry = asObject(node);
    const head = asObject(entry?.headCommit)?.oid;
    const base = asObject(entry?.baseCommit)?.oid;
    const number = asObject(entry?.pullRequest)?.number;
    if (typeof head === "string" && typeof base === "string" && typeof number === "number") {
      byHead.set(head, { base, number });
    }
  }
  const numbers: number[] = [];
  let sha = headSha;
  for (let entry = byHead.get(sha); entry; entry = byHead.get(sha)) {
    if (numbers.length >= byHead.size) return undefined;
    numbers.unshift(entry.number);
    sha = entry.base;
  }
  return numbers.length > 0 ? { numbers, baseSha: sha } : undefined;
}

async function resolveMergeGroup(github: GitHubClient, context: ActionsContext, run: { head_sha: string; head_branch: string | null }):
  Promise<Target | undefined> {
  const { repo, payload } = context;
  const defaultBranch = payload.repository?.default_branch ?? "main";
  const response = await github.graphql(
    `query($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        mergeQueue(branch: $branch) {
          entries(first: 100) { nodes { headCommit { oid } baseCommit { oid } pullRequest { number } } }
        }
      }
    }`,
    { owner: repo.owner, repo: repo.repo, branch: defaultBranch },
  );
  const group = mergeGroupPulls(response, run.head_sha);
  // The queue's ref names its newest pull request: gh-readonly-queue/<base>/pr-<number>-<base sha>.
  const named = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(run.head_branch ?? "")?.[1];
  if (!group || Number(named) !== group.numbers.at(-1)) return undefined;
  const target = { sha: run.head_sha, policySha: group.baseSha, mergeGroup: true };
  const pulls = await Promise.all(group.numbers.map((number) => openPullIntoDefault(github, context, number)));
  const open = pulls.filter((pull) => pull !== undefined);
  if (open.length !== group.numbers.length) {
    return { ...target, pulls: [], problem: "a pull request in the group is not open into the default branch" };
  }
  return { ...target, pulls: open };
}

async function resolveTarget(github: GitHubClient, context: ActionsContext): Promise<Target | undefined> {
  const { payload, repo } = context;
  const defaultBranch = payload.repository?.default_branch ?? "main";
  let number: number | undefined;
  if (context.eventName === "issue_comment") {
    if (payload.issue?.pull_request) number = payload.issue.number;
  } else if (context.eventName === "workflow_run" && payload.workflow_run) {
    const run = payload.workflow_run;
    if (run.event === "merge_group") return resolveMergeGroup(github, context, run);
    if (run.event === "workflow_run") {
      // A producer run on `main`'s definition (the bot preview's smoke) names the head it checked in
      // its artifact. The name only picks which pull request to decide again; the decision binds
      // the artifact itself.
      const { data } = await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: run.id, per_page: PER_PAGE });
      const head = data.artifacts.map(({ name }) => /^automerge-[\w-]+-([0-9a-f]{40})$/.exec(name)?.[1]).find(Boolean);
      if (!head) return undefined;
      const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
        ...repo,
        commit_sha: head,
        per_page: PER_PAGE,
      });
      number = pulls.find((pull) => pull.state === "open" && pull.head.sha === head && pull.base.ref === defaultBranch)?.number;
    } else {
      number = run.pull_requests?.find((pull) => pull.base.ref === defaultBranch)?.number;
      // `pull_requests` is empty when the head is in a fork, so look the pull request up by head and
      // base. GitHub allows one open pull request per pair.
      if (number === undefined && run.head_repository && run.head_branch) {
        const { data } = await github.rest.pulls.list({
          ...repo,
          state: "open",
          head: `${run.head_repository.owner.login}:${run.head_branch}`,
          base: defaultBranch,
          per_page: PER_PAGE,
          page: 1,
        });
        number = data[0]?.number;
      }
    }
  }
  if (number === undefined) return undefined;
  const pull = await openPullIntoDefault(github, context, number);
  return pull && { sha: pull.head.sha, policySha: context.sha, pulls: [pull], mergeGroup: false };
}

/**
 * Keeps the App's approval in step with an enforce-mode decision: it approves the head commit of a
 * pull request that may merge without a person when App approvals count, and withdraws any standing
 * approval otherwise. It enqueues a pull request that may merge without a person once the gate
 * passes.
 */
async function execute(github: GitHubClient, context: ActionsContext, { inputs, decision, policy, app }: {
  inputs: PullInputs;
  decision: PullDecision;
  policy: Policy;
  app: RiskReviewApp;
}): Promise<void> {
  const { repo } = context;
  const ref = { ...repo, pull_number: decision.number };
  const auto = decision.would.decision === "auto";
  const approve = auto && policy.bands.appApprovalsCount;
  const standing = inputs.reviews.filter((review) => review.user?.login === app.login && review.state === "APPROVED");
  if (!approve) {
    for (const review of standing) {
      await github.rest.pulls.dismissReview({ ...ref, review_id: review.id, message: decision.gate.reason });
    }
  } else if (!standing.some((review) => review.commit_id === decision.head_sha)) {
    await github.rest.pulls.createReview({ ...ref, commit_id: decision.head_sha, event: "APPROVE", body: decision.gate.reason });
  }
  if (!auto || !decision.gate.passes || inputs.pull.draft) return;
  const response = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) { mergeQueueEntry { id } } }
    }`,
    { owner: repo.owner, repo: repo.repo, number: decision.number },
  );
  const queued = asObject(asObject(asObject(asObject(response)?.repository)?.pullRequest)?.mergeQueueEntry) !== undefined;
  if (queued) return;
  await github.graphql(
    `mutation($id: ID!, $head: GitObjectID!) {
      enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { id } }
    }`,
    { id: inputs.pull.node_id, head: decision.head_sha },
  );
}

/**
 * Decides the pull requests the event is about and posts the `risk-review` check run, then, in
 * enforce mode, approves and enqueues those that may merge without a person.
 *
 * @param options GitHub Actions runtime dependencies, the risk-review App, and the decision time.
 */
export async function runRiskReview({ github, context, core, app, now = new Date() }: {
  github: GitHubClient;
  context: ActionsContext;
  core: ActionsCore;
  app: RiskReviewApp;
  now?: Date;
}): Promise<void> {
  const target = await resolveTarget(github, context);
  if (!target) {
    core.notice("No open pull request into the default branch, or queued merge group, matches this event; nothing to decide.");
    return;
  }
  const { repo } = context;
  // Created before anything is read, so a later run's check run is always newer than this one's and
  // this run can tell it has been overtaken.
  const { data: created } = await github.rest.checks.create({
    ...repo,
    name: CHECK_NAME,
    head_sha: target.sha,
    status: "in_progress",
    details_url: `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
  });
  const complete = (conclusion: "success" | "failure" | "cancelled", output: { title: string; summary: string }) =>
    github.rest.checks.update({ ...repo, check_run_id: created.id, status: "completed", conclusion, output });
  try {
    const policy = await readPolicy(github, repo, target.policySha);
    const pulls = await Promise.all(target.pulls.map(async (pull) => {
      const inputs = await readPullInputs(github, context, pull);
      return { inputs, decision: decide(inputs, policy, now) };
    }));
    const decisions = pulls.map(({ decision }) => decision);
    const record: DecisionRecord = {
      schema: 1,
      mode: policy.bands.mode,
      event: target.mergeGroup ? "merge_group" : context.eventName,
      sha: target.sha,
      policy_sha: policy.sha,
      ...(policy.bandsProblem && { bands_problem: policy.bandsProblem }),
      ...conclude(decisions, policy.bands.mode, target.problem),
      pulls: decisions,
    };

    const { data: latest } = await github.rest.checks.listForRef({
      ...repo,
      ref: target.sha,
      check_name: CHECK_NAME,
      app_id: app.id,
      filter: "all",
      per_page: PER_PAGE,
    });
    if (latest.check_runs.some(({ id }) => id > created.id)) {
      await complete("cancelled", { title: "Superseded", summary: "A later run decides this commit." });
      core.notice("A later run has taken over this commit's check run; leaving it to that run.");
      return;
    }
    const output = renderOutput(record);
    await complete(record.conclusion, output);
    if (record.mode === "enforce" && !target.mergeGroup) {
      for (const { inputs, decision } of pulls) await execute(github, context, { inputs, decision, policy, app });
    }
    await core.summary.addRaw(output.summary).write();
  } catch (error) {
    // A check run left in progress would hold the commit until some later event; fail it instead.
    const message = error instanceof Error ? error.message : String(error);
    await complete("failure", { title: "The gate failed", summary: `The gate could not decide: ${message}` });
    throw error;
  }
}
