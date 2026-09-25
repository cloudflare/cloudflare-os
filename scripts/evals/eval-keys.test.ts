import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "eval-keys.ts");

type Output = {
  report: string;
  commits: { sha: string; tasks: Record<string, { key: string; definition: string }> }[];
};

let repo = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
  return git("rev-parse", "HEAD");
}

function run(shas: string[], config = "config"): Output {
  return JSON.parse(execFileSync(process.execPath,
    [SCRIPT, "--config", config, "--report-config", "report", ...shas], { cwd: repo, encoding: "utf8" }));
}

function keys(sha: string, config = "config"): { tasks: Record<string, string>; report: string } {
  const { report, commits: [only] } = run([sha], config);
  return {
    tasks: Object.fromEntries(Object.entries(only?.tasks ?? {}).map(([task, { key }]) => [task, key])),
    report,
  };
}

function definitions(sha: string): Record<string, string> {
  const [only] = run([sha]).commits;
  return Object.fromEntries(
    Object.entries(only?.tasks ?? {}).map(([task, { definition }]) => [task, definition]));
}

/** The tasks whose keys differ between two commits. */
function changed(from: string, to: string): string[] {
  const [a, b] = [keys(from).tasks, keys(to).tasks];
  return Object.keys(b).filter(task => a[task] !== b[task]).toSorted();
}

let base = "";
before(() => {
  repo = mkdtempSync(join(tmpdir(), "eval-keys-"));
  git("init", "-q");
  base = commit({
    "README.md": "readme",
    "pnpm-lock.yaml": "lock",
    "packages/workshop-backend/src/agent.ts": "agent",
    "packages/workshop-evals/src/harness.ts": "harness",
    "packages/workshop-evals/src/comparison.ts": "comparison",
    "packages/workshop-evals/evals/seeded.ts": "helper",
    "packages/workshop-evals/evals/chess.eval.ts": "chess",
    "packages/workshop-evals/evals/worker-logs.eval.ts": "logs",
  });
});
after(() => rmSync(repo, { recursive: true, force: true }));

test("a commit that touches nothing a run executes, tests included, keeps every key", () => {
  const next = commit({
    "README.md": "edited",
    "packages/workshop-evals/src/harness.test.ts": "t",
    "packages/workshop-backend/__tests__/agent.test.ts": "t",
    "scripts/evals/eval-keys.test.ts": "t",
    "packages/workshop-evals/evals/seeded.test.ts": "t",
  });
  assert.deepEqual(keys(next), keys(base));
  base = next;
});

test("a task edit changes only that task's key", () => {
  const next = commit({ "packages/workshop-evals/evals/chess.eval.ts": "chess 2" });
  assert.deepEqual(changed(base, next), ["chess"]);
  base = next;
});

test("the Worker, the harness, the lockfile, shared helpers and admission change every key", () => {
  for (const path of [
    "packages/workshop-backend/src/agent.ts",
    "packages/workshop-evals/src/harness.ts",
    "pnpm-lock.yaml",
    "packages/workshop-evals/evals/seeded.ts",
    "packages/workshop-evals/src/results.ts",
    "scripts/evals/validate-results.ts",
  ]) {
    const next = commit({ [path]: `${path} edited` });
    assert.deepEqual(changed(base, next), ["chess", "worker-logs"], path);
    base = next;
  }
});

test("the workflow's eval settings change every key", () => {
  assert.notEqual(keys(base, "other").tasks.chess, keys(base).tasks.chess);
});

test("only eval code changes a task's definition, not the product under test", () => {
  const product = commit({ "packages/workshop-backend/src/agent.ts": "agent 3" });
  assert.deepEqual(definitions(product), definitions(base));
  const harness = commit({ "packages/workshop-evals/src/harness.ts": "harness 3" });
  assert.notDeepEqual(definitions(harness), definitions(product));
  base = harness;
});

test("a report change keeps every task key and changes the report key", () => {
  const next = commit({ "packages/workshop-evals/src/comparison.ts": "comparison 4" });
  assert.deepEqual(changed(base, next), []);
  assert.notEqual(keys(next).report, keys(base).report);
});
