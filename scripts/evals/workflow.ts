// The plan, join and post steps of .github/workflows/workshop-evals-pr.yml:
//   node scripts/evals/workflow.ts plan <baseline-sha> [<candidate-sha>]
//   node scripts/evals/workflow.ts join <runs-dir> <out-dir>
//   node scripts/evals/workflow.ts post <comparison.md>
// Only Node built-ins are imported, so the plan job needs no install step.
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evalKeys, type EvalKeys } from "./eval-keys.ts";

const WORKFLOW = ".github/workflows/workshop-evals-pr.yml";
const RESULTS_MARKER = "<!-- workshop-evals-comparison";
const PER_PAGE = 100;
/** How long a stored result must outlive the run that reuses it, so compare can still download it. */
const OUTLIVES_RUN_MS = 4 * 60 * 60 * 1000;

type Revision = "baseline" | "candidate";
const REVISIONS: readonly Revision[] = ["baseline", "candidate"];

/** One revision's task, under the name its result is stored as. */
type TaskRun = { revision: Revision; sha: string; task: string; name: string };
/** Where a revision's result for a task comes from: a stored artifact, or one leg of this run. */
type Source = TaskRun & ({ artifact: number } | { run: Revision });
type Plan = {
  sources: Source[];
  /** The results this run measures, each stored for later runs to reuse. */
  store: { revision: Revision; task: string; name: string }[];
  /** One job per revision with anything to measure. */
  legs: { revision: Revision; sha: string; tasks: string[] }[];
};
/** An issue comment, as far as recognising results comments and eval reviews needs. */
type Comment = { id: number; login: string | undefined; createdAt: string; body: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** Parsed JSON that is an object, so its fields can be checked one by one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resultName(task: string, key: string): string {
  return `${task}-${key}`;
}

async function github(method: string, path: string, body?: { body: string }): Promise<Response> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-os-workshop-evals",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ` +
      (await response.text()).slice(0, 300));
  }
  return response;
}

/** Every item of a GitHub list, read a page at a time until a short page. */
async function githubList(path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const batch: unknown = await (await github("GET", `${path}?per_page=${PER_PAGE}&page=${page}`)).json();
    if (!Array.isArray(batch)) throw new Error(`GitHub API GET ${path} did not return a list`);
    items.push(...batch);
    if (batch.length < PER_PAGE) return items;
  }
}

function setOutputs(outputs: Record<string, string>): void {
  appendFileSync(env("GITHUB_OUTPUT"),
    Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""));
}

/** JSON with every object's keys sorted, so a digest does not depend on the order yq prints them in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).toSorted()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function workflowDigest(sections: string): string {
  const settings = execFileSync("yq", ["-o=json", sections, WORKFLOW], { encoding: "utf8" });
  return createHash("sha256").update(`${canonicalJson(JSON.parse(settings))}\n`).digest("hex");
}

/**
 * The stored result an artifacts listing offers for reuse: the newest one that outlives this run
 * and that this repository's own run stored, since a fork's run can upload any name.
 */
export function reusableArtifact(listing: unknown, now: number): number | undefined {
  const artifacts: unknown[] = isRecord(listing) && Array.isArray(listing.artifacts) ? listing.artifacts : [];
  let newest: { id: number; createdAt: string } | undefined;
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) continue;
    const { id, expired, created_at: createdAt, expires_at: expiresAt, workflow_run: run } = artifact;
    if (typeof id === "number" && typeof createdAt === "string" && typeof expiresAt === "string" &&
      expired === false && Date.parse(expiresAt) > now + OUTLIVES_RUN_MS &&
      isRecord(run) && typeof run.repository_id === "number" && run.head_repository_id === run.repository_id &&
      (newest === undefined || createdAt >= newest.createdAt)) {
      newest = { id, createdAt };
    }
  }
  return newest?.id;
}

/**
 * Where each revision's result for each task comes from: a stored result, or one leg of this run.
 * A key both revisions share is measured once, by the candidate: equal keys are the same run. A
 * push's one commit is the baseline, as later pull requests use it.
 */
export function planRuns(keys: EvalKeys, stored: ReadonlyMap<string, number>): Plan {
  const runs = keys.commits.flatMap(({ sha, tasks }, side) => Object.entries(tasks).map(([task, { key }]): TaskRun =>
    ({ revision: side === 0 ? "baseline" : "candidate", sha, task, name: resultName(task, key) })));
  const candidate = new Set(runs.filter(({ revision }) => revision === "candidate").map(({ name }) => name));
  const sources = runs.map((run): Source => {
    const artifact = stored.get(run.name);
    return artifact === undefined
      ? { ...run, run: candidate.has(run.name) ? "candidate" : "baseline" }
      : { ...run, artifact };
  });
  const measured = sources.filter(source => "run" in source && source.run === source.revision);
  return {
    sources,
    store: measured.map(({ revision, task, name }) => ({ revision, task, name })),
    legs: REVISIONS.flatMap(revision => {
      const leg = measured.filter(source => source.revision === revision);
      return leg.length === 0 ? [] : [{ revision, sha: leg[0].sha, tasks: leg.map(({ task }) => task) }];
    }),
  };
}

/** The plan step's outputs. Legs and store are left out when nothing is measured: a matrix with no entries fails the run. */
export function planOutputs(keys: EvalKeys, plan: Plan, report: boolean): Record<string, string> {
  return {
    keys: JSON.stringify(keys),
    sources: JSON.stringify(plan.sources),
    report: String(report),
    ...(plan.store.length === 0 ? {} : {
      legs: JSON.stringify({ include: plan.legs }),
      store: JSON.stringify({ include: plan.store }),
    }),
  };
}

function commentsIn(listing: readonly unknown[]): Comment[] {
  return listing.flatMap(comment => {
    if (!isRecord(comment)) return [];
    const { id, user, created_at: createdAt, body } = comment;
    return typeof id === "number" && typeof createdAt === "string" && typeof body === "string"
      ? [{ id, login: isRecord(user) && typeof user.login === "string" ? user.login : undefined, createdAt, body }]
      : [];
  });
}

function isResultsComment({ login, body }: Comment): boolean {
  return login === "github-actions[bot]" && body.startsWith(RESULTS_MARKER);
}

/** Bonk's review of the eval runs, recognised by the heading trajectory-review's prompt asks for. */
function isEvalReview({ login, body }: Comment): boolean {
  return login === "ask-bonk[bot]" && /^## (🔬 )?Eval runs review/u.test(body);
}

function marker(report: string | undefined): string {
  return `${RESULTS_MARKER}${report === undefined ? "" : ` report=${report}`} -->`;
}

/**
 * A results comment. Its marker carries the report key only when every result it shows is stored,
 * so the next run can tell whether it is still current.
 */
export function resultsComment(markdown: string, runUrl: string, report: string | undefined): string {
  return `${marker(report)}\n${markdown}\n[Run](${runUrl}) · [trajectories and raw results](${runUrl}#artifacts)\n`;
}

/** Whether the newest results comment reports these exact inputs and Bonk has reviewed it since. */
export function commentsAreCurrent(listing: readonly unknown[], report: string): boolean {
  const comments = commentsIn(listing);
  const posted = comments.filter(isResultsComment).reduce<Comment | undefined>(
    (newest, comment) => newest === undefined || comment.createdAt >= newest.createdAt ? comment : newest,
    undefined);
  return posted !== undefined && posted.body.startsWith(marker(report)) &&
    comments.some(comment => isEvalReview(comment) && comment.createdAt > posted.createdAt);
}

/** The comments a new results comment replaces: every earlier results comment and Bonk eval review. */
export function staleComments(listing: readonly unknown[]): number[] {
  return commentsIn(listing).filter(comment => isResultsComment(comment) || isEvalReview(comment))
    .map(({ id }) => id);
}

/**
 * Whether to post the comparison: not when the posted comments report these exact inputs, every
 * result they show is stored, Bonk reviewed them afterwards, and nobody asked for a re-run.
 * Comments that cannot be read count as stale, since posting again costs one review and failing
 * here would skip every run.
 */
async function shouldReport(repo: string, report: string, plan: Plan): Promise<boolean> {
  if (env("GITHUB_EVENT_NAME") !== "pull_request") return false;
  if (env("GITHUB_RUN_ATTEMPT") !== "1" || plan.store.length > 0) return true;
  try {
    return !commentsAreCurrent(await githubList(`repos/${repo}/issues/${env("PR_NUMBER")}/comments`), report);
  } catch (error) {
    console.warn(`::warning::Posting the comparison again, as the posted comments cannot be read: ${errorMessage(error)}`);
    return true;
  }
}

async function planStep(shas: readonly string[]): Promise<void> {
  // What decides a task's result or whether it is stored, and what decides the comments.
  const keys = evalKeys(workflowDigest("[.env, .jobs.evals, .jobs.store]"),
    workflowDigest('[.jobs.compare, .jobs["trajectory-review"]]'), shas);
  const repo = env("GITHUB_REPOSITORY");
  const now = Date.now();
  const names = new Set(keys.commits.flatMap(({ tasks }) =>
    Object.entries(tasks).map(([task, { key }]) => resultName(task, key))));
  const stored = new Map<string, number>();
  await Promise.all([...names].map(async name => {
    const listing = await github("GET", `repos/${repo}/actions/artifacts?name=workshop-evals-${name}&per_page=${PER_PAGE}`);
    const id = reusableArtifact(await listing.json(), now);
    if (id !== undefined) stored.set(name, id);
  }));
  const plan = planRuns(keys, stored);
  setOutputs(planOutputs(keys, plan, await shouldReport(repo, keys.report, plan)));
}

/**
 * Writes <out-dir>/<revision>/results.json from this run's <runs-dir> or from stored results, as
 * the plan's SOURCES say, and outputs `complete`: false when a result from this run was not clean
 * enough to store, so a comment built on it must not count as current.
 */
async function joinStep(runsDir: string, outDir: string): Promise<void> {
  const sources: unknown = JSON.parse(env("SOURCES"));
  if (!Array.isArray(sources) || !sources.every(isRecord)) throw new Error("SOURCES is not a list of sources");
  const repo = env("GITHUB_REPOSITORY");
  const storedDir = await mkdtemp(join(tmpdir(), "workshop-evals-stored-"));
  let complete = true;
  for (const revision of REVISIONS) {
    const testResults: unknown[] = [];
    for (const { task, artifact, run } of sources.filter(source => source.revision === revision)) {
      if (typeof task !== "string") throw new Error("SOURCES names a source with no task");
      let file: string;
      if (typeof artifact === "number") {
        const dir = join(storedDir, String(artifact));
        if (!existsSync(dir)) {
          const zip = await github("GET", `repos/${repo}/actions/artifacts/${artifact}/zip`);
          await writeFile(`${dir}.zip`, new Uint8Array(await zip.arrayBuffer()));
          execFileSync("unzip", ["-q", `${dir}.zip`, "-d", dir]);
        }
        file = join(dir, `${task}.json`);
      } else {
        if (run !== "baseline" && run !== "candidate") throw new Error(`SOURCES gives ${task} no artifact or run`);
        file = join(runsDir, run, `${task}.json`);
        // A leg lists the tasks clean enough to store; one with no list stored none.
        const clean = join(runsDir, run, "clean.json");
        const listed: unknown = existsSync(clean) ? JSON.parse(await readFile(clean, "utf8")) : [];
        if (!Array.isArray(listed) || !listed.includes(task)) complete = false;
      }
      const result: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isRecord(result) || !Array.isArray(result.testResults)) throw new Error(`${file} holds no testResults`);
      testResults.push(...result.testResults);
    }
    await mkdir(join(outDir, revision), { recursive: true });
    await writeFile(join(outDir, revision, "results.json"), `${JSON.stringify({ testResults }, null, 2)}\n`);
  }
  setOutputs({ complete: String(complete) });
}

/**
 * Posts the comparison fresh at the end of the conversation, then deletes every earlier results
 * comment and Bonk eval review, so the latest pair is the only one and sits where readers look.
 * Bonk's review follows this comment. Bonk's code reviews and anything a person wrote stay.
 */
async function postStep(markdownPath: string): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  const comments = `repos/${repo}/issues/${env("PR_NUMBER")}/comments`;
  const runUrl = `${env("GITHUB_SERVER_URL")}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const report = env("COMPLETE") === "true" ? env("REPORT_KEY") : undefined;
  const body = resultsComment(await readFile(markdownPath, "utf8"), runUrl, report);
  // Listed before any deletion, which would shift the pages still to be read.
  const earlier = staleComments(await githubList(comments));
  await github("POST", comments, { body });
  for (const id of earlier) {
    try {
      await github("DELETE", `repos/${repo}/issues/comments/${id}`);
    } catch (error) {
      // Someone may have deleted it already.
      console.warn(`::warning::${errorMessage(error)}`);
    }
  }
}

async function main([command, ...args]: readonly string[]): Promise<void> {
  if (command === "plan" && args.length >= 1 && args.length <= REVISIONS.length) return planStep(args);
  if (command === "join" && args.length === 2) return joinStep(args[0], args[1]);
  if (command === "post" && args.length === 1) return postStep(args[0]);
  throw new Error("Usage: node scripts/evals/workflow.ts plan <baseline-sha> [<candidate-sha>] | " +
    "join <runs-dir> <out-dir> | post <comparison.md>");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`::error::${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
