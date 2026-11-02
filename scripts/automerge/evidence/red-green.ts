#!/usr/bin/env node

// evidence-red-green: a kernel change's new or changed tests fail on the base source and pass on
// the head source.
//
// Applies when the pull request touches the kernel (KERNEL, as the gate classifies it) and changes
// source as well as tests. The changed test files are run at head under their package's vitest
// config; then every changed source file is put back to its merge-base version (files the pull
// request added are removed) with the head tests left in place, the workspace is rebuilt, and the
// same tests run again. It holds when the head run passes and the base run fails: the tests check
// the behaviour the change adds. A dependency change is out of scope, since the base source would
// run against the head's install.
//
// This job runs the pull request's code and holds no secrets.
//
//   node scripts/automerge/evidence/red-green.ts   (env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA)

import { rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decide, errored, notApplicable, runProducer, type Outcome } from "../proofs/artifact.ts";
import type { FileDiff } from "../proofs/diff.ts";
import { fileAt, git, mergeBase, pullRequestDiff } from "../proofs/git.ts";
import { TEST_PATH } from "../proofs/tests.ts";
import { runCommand } from "./exec.ts";
import { groupByConfig, runDetails, runTests, RUNNABLE_TEST, type TestRun } from "./vitest.ts";

/** The kernel, as the gate's path policy names it (scripts/risk-review-policy.ts). */
const KERNEL = /^(packages\/workshop-backend\/|packages\/typed-storage\/|packages\/workshop-shared\/src\/api\.ts$)/;
const DEPENDENCY_FILE = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;

/** What the producer runs, or why it does not apply. */
export type RedGreenScope =
  | { notApplicable: string }
  | { error: string }
  | { tests: string[]; sources: string[] };

/** Applies the scope rules to a diff. */
export function planRedGreen(files: FileDiff[]): RedGreenScope {
  if (!files.some((file) => KERNEL.test(file.path))) return { notApplicable: "touches no kernel path" };
  const dependencies = files.filter((file) => DEPENDENCY_FILE.test(file.path)).map((file) => file.path);
  if (dependencies.length > 0) return { error: `changes dependencies (${dependencies.join(", ")}), so base source cannot run on this install` };
  const sources = files.filter((file) => !TEST_PATH.test(file.path) && !/\.md$/.test(file.path)).map((file) => file.path);
  if (sources.length === 0) return { notApplicable: "changes only tests and documentation" };
  const tests = files.filter((file) => file.status !== "deleted" && RUNNABLE_TEST.test(file.path)).map((file) => file.path);
  return { tests, sources };
}

/** Holds when every head run passed and at least one base run failed. */
export function evaluateRedGreen(tests: string[], head: TestRun[], base: TestRun[]): Outcome {
  const reasons: string[] = [];
  if (tests.length === 0) reasons.push("the change adds or changes no test file");
  for (const run of head) if (!run.passed) reasons.push(`the changed tests fail at head under ${run.config}`);
  if (tests.length > 0 && head.every((run) => run.passed) && base.every((run) => run.passed)) {
    reasons.push("the changed tests also pass on the base source, so they do not check the change");
  }
  return decide(reasons, { tests, head: head.map(runDetails), base: base.map(runDetails) });
}

function revertSources(from: string, sources: string[]): void {
  for (const path of sources) {
    const text = fileAt(from, path);
    if (text === undefined) rmSync(path, { force: true });
    else writeFileSync(path, text);
  }
}

async function main(): Promise<void> {
  await runProducer("evidence", "evidence-red-green", async ({ head, base }) => {
    const from = mergeBase(base, head);
    const scope = planRedGreen(pullRequestDiff(base, head));
    if ("notApplicable" in scope) return notApplicable(scope.notApplicable);
    if ("error" in scope) return errored(scope.error);
    if (scope.tests.length === 0) return evaluateRedGreen([], [], []);
    // vitest runs none of the test task's codegen (docs/testing.md).
    if (!runCommand("pnpm", ["build"], ".").ok) return errored("pnpm build failed at head");
    const { groups, unplaced } = groupByConfig(scope.tests);
    if (unplaced.length > 0) return errored(`no single supported vitest config lists ${unplaced.join(", ")}`, { tests: scope.tests });
    const headRuns = [...groups].map(([config, files]) => runTests(config, files));

    if (headRuns.some((run) => !run.passed)) return evaluateRedGreen(scope.tests, headRuns, []);

    revertSources(from, scope.sources);
    try {
      // The merge base built on its own, so a failure here says nothing about the tests.
      if (!runCommand("pnpm", ["build"], ".").ok) return errored("pnpm build failed on the base source");
      const baseRuns = [...groups].map(([config, files]) => runTests(config, files));
      return evaluateRedGreen(scope.tests, headRuns, baseRuns);
    } finally {
      git(["checkout", head, "--", ...scope.sources.filter((path) => fileAt(head, path) !== undefined)]);
      for (const path of scope.sources) if (fileAt(head, path) === undefined) rmSync(path, { force: true });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
