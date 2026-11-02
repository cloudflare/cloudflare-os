#!/usr/bin/env node

// evidence-red-green: a kernel change's new or changed tests fail on the base source and pass on
// the head source.
//
// Applies when the pull request touches the kernel (KERNEL, as the gate classifies it) and changes
// source as well as tests. The changed test files are run at head under their package's vitest
// config; then every changed source file is put back to its merge-base version (files the pull
// request added are removed) with the head tests left in place, the workspace is rebuilt, and the
// same tests run again. It holds when every changed test file is in both parsed reports, passes at
// head and has at least one failing test on the base source: the tests check the behaviour the
// change adds. What was not seen is an `error`, never a result: no readable report, a changed test
// file missing from it, or a file that crashed before its tests ran. A dependency change is out of
// scope, since the base source would run against the head's install.
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
import { groupByConfig, runDetails, runTests, RUNNABLE_TEST, type FileResult, type TestRun } from "./vitest.ts";

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
  const sources = files.filter((file) => !TEST_PATH.test(file.path) && !file.path.endsWith(".md")).map((file) => file.path);
  if (sources.length === 0) return { notApplicable: "changes only tests and documentation" };
  const tests = files.filter((file) => file.status !== "deleted" && RUNNABLE_TEST.test(file.path)).map((file) => file.path);
  return { tests, sources };
}

/** Each changed test file's result in one side's runs, or why it was not seen. */
function resultsFor(tests: string[], runs: TestRun[], side: string): { found: Map<string, FileResult>; unseen: string[] } {
  const found = new Map<string, FileResult>();
  const unseen: string[] = [];
  for (const test of tests) {
    const run = runs.find((candidate) => candidate.files.includes(test));
    const result = run?.results?.find((entry) => entry.path === test);
    if (!run) unseen.push(`${test} was not run on the ${side}`);
    else if (run.results === undefined) unseen.push(`no readable vitest report on the ${side} for ${test}`);
    else if (!result) unseen.push(`${test} is missing from the ${side} report`);
    else found.set(test, result);
  }
  return { found, unseen };
}

/** The outcome the head runs alone decide, or undefined when every changed test file is green at head. */
export function headVerdict(tests: string[], head: TestRun[]): Outcome | undefined {
  const details = { tests, head: head.map(runDetails) };
  if (tests.length === 0) return decide(["the change adds or changes no test file"], details);
  const { found, unseen } = resultsFor(tests, head, "head");
  const reasons: string[] = [];
  for (const [test, result] of found) {
    if (result.failed > 0) reasons.push(`${test} fails at head: ${result.failures.join("; ")}`);
    else if (result.status !== "passed" || result.passed === 0) unseen.push(`${test} ran no passing test at head (status ${result.status})`);
  }
  if (unseen.length > 0) return errored(unseen.join("; "), details);
  return reasons.length > 0 ? decide(reasons, details) : undefined;
}

/** Holds when every changed test file passed at head and had a failing test on the base source. */
export function evaluateRedGreen(tests: string[], head: TestRun[], base: TestRun[]): Outcome {
  const decided = headVerdict(tests, head);
  if (decided) return decided;
  const details = { tests, head: head.map(runDetails), base: base.map(runDetails) };
  const { found, unseen } = resultsFor(tests, base, "base source");
  const reasons: string[] = [];
  for (const [test, result] of found) {
    if (result.failed > 0) continue;
    if (result.status !== "passed" || result.passed === 0) unseen.push(`${test} ran no test on the base source (status ${result.status})`);
    else reasons.push(`${test} passes on the base source, so it does not check the change`);
  }
  if (unseen.length > 0) return errored(unseen.join("; "), details);
  return decide(reasons, details);
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

    const decided = headVerdict(scope.tests, headRuns);
    if (decided) return decided;

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
