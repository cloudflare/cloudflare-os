import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { dig, jobsOf, parseWorkflow } from "../risk-review-fixtures/workflow.ts";
import { git } from "./git.ts";
import type { Json } from "./json.ts";
import { PRODUCERS } from "./producers.ts";

const ROOT = resolve(import.meta.dirname, "../..");

/** Each path a step's script names under `$RUNNER_TEMP`, relative to it. */
function runnerTempPaths(script: string): string[] {
  return [...script.matchAll(/\$\{?RUNNER_TEMP\}?\/([\w./-]+)/g)].map((match) => match[1] ?? "");
}

function topDirectory(path: string): string {
  return path.split("/", 1).join("");
}

/** The shell of each `run` step of a job, in order. */
function runsOf(job: Json): string[] {
  const steps = dig(job, "steps");
  return (Array.isArray(steps) ? steps : []).flatMap((step) => {
    const run = dig(step, "run");
    return typeof run === "string" ? [run] : [];
  });
}

/** Each script a step starts with node, as the step names it. */
function startedScripts(run: string): string[] {
  return [...run.matchAll(/\bnode\s+(\S+\.ts)\b/g)].map((match) => match[1] ?? "");
}

/**
 * A repository as GitHub holds one pull request: `main` has the working tree's judge, the pull
 * request's base commit is older and has none, and the head replaces every script in `started` with
 * one that throws. The merge commit, which a `pull_request` run gets as `GITHUB_SHA`, keeps the
 * head's scripts.
 */
function pullRequestRepository(dir: string, started: string[]): { url: string; name: string; main: string; merge: string } {
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const objects = join(origin, "objects");
  const shared = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], ROOT).trim();
  writeFileSync(join(objects, "info", "alternates"), `${shared}\n`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: shared,
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[], input?: string) => execFileSync("git", args, { cwd: ROOT, env, input, encoding: "utf8" }).trim();
  const commit = (tree: string, ...parents: string[]) => run(["commit-tree", tree, "-m", "commit", ...parents.flatMap((parent) => ["-p", parent])]);

  const base = commit(run(["hash-object", "-t", "tree", "-w", "--stdin"], ""));
  run(["add", "--all", "--", "scripts/automerge", "scripts/risk-review*"]);
  const main = commit(run(["write-tree"]), base);
  const thrower = run(["hash-object", "-w", "--stdin"], 'throw new Error("the head\'s judge ran");\n');
  for (const path of started) run(["update-index", "--add", "--cacheinfo", `100644,${thrower},${path}`]);
  const headTree = run(["write-tree"]);
  const head = commit(headTree, base);
  return { url: pathToFileURL(dir).href, name: basename(origin), main, merge: commit(headTree, main, head) };
}

// A `pull_request` run reads its workflow file from the merge commit, so the scripts that file
// starts must come from that commit's first parent, the base branch as merged. The pull request's
// `base.sha` can be months older, and then holds no judge or an old one; the head is the pull
// request's own.
describe("the producers' workflows", () => {
  const temp = mkdtempSync(join(tmpdir(), "automerge-judge-"));
  after(() => rmSync(temp, { recursive: true, force: true }));
  const workflows = [...new Set(Object.values(PRODUCERS).map(({ workflow }) => workflow))];
  const jobs = workflows.flatMap((file) => jobsOf(parseWorkflow(readFileSync(join(ROOT, file), "utf8")))
    .map((job) => ({ file, job, started: runsOf(job).flatMap(startedScripts) }))
    .filter(({ started }) => started.length > 0));
  const judgeScripts = [...new Set(jobs.flatMap(({ started }) => started.flatMap(runnerTempPaths)))];

  it("start a script in every workflow, and each from a copy outside the checkout", () => {
    assert.deepEqual([...new Set(jobs.map(({ file }) => file))], workflows);
    for (const { file, started } of jobs) {
      for (const script of started) assert.ok(runnerTempPaths(script).length === 1, `${file} starts ${script}`);
    }
  });

  it("copy the judge of the main a pull request merges onto, whatever its base and its head hold", () => {
    const copied = topDirectory(judgeScripts[0] ?? "");
    const inRepository = judgeScripts.map((path) => path.slice(copied.length + 1));
    const repository = pullRequestRepository(temp, inRepository);
    for (const [index, { file, job, started }] of jobs.entries()) {
      const runnerTemp = join(temp, `job-${index}`);
      mkdirSync(runnerTemp);
      const output = join(runnerTemp, "output");
      const copies = runsOf(job).filter((run) => runnerTempPaths(run).some((path) => path === copied));
      assert.ok(copies.length > 0, `${file}: a step fills $RUNNER_TEMP/${copied}`);
      // In the runner's temp directory, which is no repository: the copy needs no checkout.
      for (const copy of copies) {
        execFileSync("bash", ["-e", "-c", copy], {
          cwd: runnerTemp,
          env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, GITHUB_SHA: repository.merge,
            GITHUB_SERVER_URL: repository.url, GITHUB_REPOSITORY: repository.name },
        });
      }
      assert.ok(readFileSync(output, "utf8").includes(repository.main), `${file}: the step reports the commit it copied`);
      for (const script of started.flatMap(runnerTempPaths)) {
        const url = pathToFileURL(join(runnerTemp, script)).href;
        // Imported rather than run: that loads every module the script imports and starts nothing.
        execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`], { stdio: "pipe" });
      }
    }
  });
});
