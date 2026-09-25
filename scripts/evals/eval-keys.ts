// Cache keys for Workshop eval results, read from git trees so no checkout is needed. The eval
// workflow's plan step calls evalKeys(); from the command line,
//   node scripts/evals/eval-keys.ts --config <digest> --report-config <digest> <sha>...
// prints {"report": <key>,
//         "commits": [{"sha": <sha>, "tasks": {<task>: {"key": <key>, "definition": <digest>}}}...]}.
//
// A task's key covers every tracked file that can change its result or decides whether it is
// stored: the Worker (WORKER_INPUTS, the one table of what decides it), the harness packages, the
// shared eval helpers, the task's own file, and the workflow settings in --config. Tooling that
// only supervises a run, such as scripts/with-timeout.ts, is left out: it can stop a run, and a
// stopped run is never stored. Equal keys mean the same run, so its result can be reused. A task's
// definition is the part of its key that defines or scores its trials rather than builds the
// product under test: two sides whose definitions differ cannot be compared. The report key covers
// what turns results into the PR comments, plus every task key: equal report keys mean the posted
// comments are still current.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isWorkerInputPath } from "../../packages/integration-tests/src/worker-inputs.ts";

const EVALS = "packages/workshop-evals/";
const TASKS = `${EVALS}evals/`;
const TASK_SUFFIX = ".eval.ts";
const REPORT_MODULES = new Set(
  ["comparison.ts", "trajectory-markdown.ts"].map(file => `${EVALS}src/${file}`));
const USAGE = "usage: eval-keys.ts --config <digest> --report-config <digest> <sha>...";

/**
 * Test files change no result and no comment: no eval run executes them and no Worker imports
 * them, though WORKER_INPUTS names whole packages.
 */
function isTestPath(path: string): boolean {
  return path.includes("/__tests__/") || /\.test\.[^/]+$/.test(path);
}

/**
 * Files that can change any eval run's result or decide whether it is stored, apart from the
 * tasks themselves.
 */
function isHarnessPath(path: string): boolean {
  if (isTestPath(path)) return false;
  return isWorkerInputPath(path) || path === "package.json" || path === "pnpm-workspace.yaml" ||
    path === "scripts/evals/validate-results.ts" || path.startsWith("packages/integration-tests/") ||
    (path.startsWith(EVALS) && !path.startsWith(TASKS) && !REPORT_MODULES.has(path));
}

/** Harness files that define or score a trial, as opposed to the product under test. */
function isDefinitionPath(path: string): boolean {
  return path.startsWith(EVALS) || path.startsWith("packages/integration-tests/");
}

function isReportPath(path: string): boolean {
  return !isTestPath(path) && (REPORT_MODULES.has(path) || path.startsWith("scripts/evals/"));
}

type TreeEntry = { path: string; line: string };
type Task = { key: string; definition: string };

/** Each commit's task keys and definitions, and the report key over all of them. */
export type EvalKeys = { report: string; commits: { sha: string; tasks: Record<string, Task> }[] };

function treeOf(sha: string): TreeEntry[] {
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", sha], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return listing.split("\0").filter(Boolean).map(line => ({ path: line.slice(line.indexOf("\t") + 1), line }));
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part}\n`);
  return hash.digest("hex").slice(0, 20);
}

function tasksOf(tree: readonly TreeEntry[], config: string): Record<string, Task> {
  const harness = tree.filter(entry => isHarnessPath(entry.path));
  const inTasks = tree.filter(entry => entry.path.startsWith(TASKS));
  const helpers = inTasks.filter(entry => !entry.path.endsWith(TASK_SUFFIX) && !isTestPath(entry.path))
    .map(entry => entry.line);
  const key = digest(["workshop-evals v1", config, ...harness.map(entry => entry.line), ...helpers]);
  const definition = digest([config,
    ...harness.filter(entry => isDefinitionPath(entry.path)).map(entry => entry.line), ...helpers]);
  return Object.fromEntries(inTasks.filter(entry => entry.path.endsWith(TASK_SUFFIX)).map(entry => [
    entry.path.slice(TASKS.length, -TASK_SUFFIX.length),
    { key: digest([key, entry.line]), definition: digest([definition, entry.line]) },
  ]));
}

export function evalKeys(config: string, reportConfig: string, shas: readonly string[]): EvalKeys {
  const commits = shas.map(sha => {
    const tree = treeOf(sha);
    return { sha, tree, tasks: tasksOf(tree, config) };
  });
  // Keyed by position (base, head), not commit id: a new commit that changes nothing keeps the key.
  const report = digest([reportConfig, ...commits.flatMap(({ tree, tasks }, side) => [
    ...Object.entries(tasks).map(([task, { key }]) => `${side} ${task} ${key}`),
    ...tree.filter(entry => isReportPath(entry.path)).map(entry => `${side} ${entry.line}`),
  ])]);
  return { report, commits: commits.map(({ sha, tasks }) => ({ sha, tasks })) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals: shas } = parseArgs({
    options: { config: { type: "string" }, "report-config": { type: "string" } },
    allowPositionals: true,
  });
  const config = values.config;
  const reportConfig = values["report-config"];
  if (config === undefined || reportConfig === undefined || shas.length === 0) throw new Error(USAGE);
  console.log(JSON.stringify(evalKeys(config, reportConfig, shas)));
}
