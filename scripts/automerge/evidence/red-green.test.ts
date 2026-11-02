import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDiff } from "../proofs/diff.ts";
import { asArray, asNumber, asObject, asString, parseJson, type Json } from "../proofs/json.ts";
import { evaluateRedGreen, planRedGreen } from "./red-green.ts";
import { listedFiles, summarizeReport, type TestRun } from "./vitest.ts";

// `git diff -U0` of real merged commits against their parents, and the artifact red-green.ts wrote
// for #932 (024caa73b, typed-storage distinct keys) on 2026-11-02: its new tests passed at head and
// four of them failed on the base source.
const DIR = new URL("./testdata/red-green/", import.meta.url);
const diff = (commit: string) => parseDiff(readFileSync(new URL(`diff-${commit}.diff`, DIR), "utf8"));

function recordedRuns(side: "head" | "base"): TestRun[] {
  const artifact = asObject(parseJson(readFileSync(new URL("pr932-artifact.json", DIR), "utf8")), "artifact");
  return asArray(asObject(artifact.details, "details")[side], side).map((entry: Json) => {
    const run = asObject(entry, "run");
    return {
      config: asString(run.config, "config"),
      files: asArray(run.files, "files").map((file) => asString(file, "file")),
      passed: run.passed === true,
      tests: asNumber(run.tests, "tests"),
      failedTests: asNumber(run.failed_tests, "failed_tests"),
      failedSuites: asNumber(run.failed_suites, "failed_suites"),
      failures: asArray(run.failures, "failures").map((name) => asString(name, "failure")),
      seconds: asNumber(run.seconds, "seconds"),
      tail: typeof run.tail === "string" ? run.tail : "",
    };
  });
}

describe("planRedGreen", () => {
  it("runs #932's changed test against its changed typed-storage source", () => {
    assert.deepEqual(planRedGreen(diff("024caa73b")), {
      tests: ["packages/typed-storage/__tests__/index.test.ts"],
      sources: ["packages/typed-storage/src/index.ts"],
    });
  });

  it("does not apply to #951, which touches no kernel path", () => {
    assert.deepEqual(planRedGreen(diff("91f4e7073")), { notApplicable: "touches no kernel path" });
  });

  it("does not apply to a kernel change of tests only (#571)", () => {
    assert.deepEqual(planRedGreen(diff("91c06bc67")), { notApplicable: "changes only tests and documentation" });
  });

  it("errors on a kernel change that also bumps dependencies (6756bd6ca)", () => {
    const scope = planRedGreen(diff("6756bd6ca"));
    assert.ok("error" in scope);
    assert.match(scope.error, /packages\/workshop-backend\/package\.json/);
  });
});

describe("evaluateRedGreen", () => {
  const tests = ["packages/typed-storage/__tests__/index.test.ts"];

  it("holds on #932: green at head, red on the base source", () => {
    const outcome = evaluateRedGreen(tests, recordedRuns("head"), recordedRuns("base"));
    assert.equal(outcome.holds, true);
  });

  it("does not hold when the tests pass on the base source too", () => {
    const outcome = evaluateRedGreen(tests, recordedRuns("head"), recordedRuns("head"));
    assert.deepEqual(outcome.details.reasons, ["the changed tests also pass on the base source, so they do not check the change"]);
  });

  it("does not hold when the tests fail at head", () => {
    const outcome = evaluateRedGreen(tests, recordedRuns("base"), []);
    assert.deepEqual(outcome.details.reasons, ["the changed tests fail at head under packages/typed-storage/vitest.config.ts"]);
  });

  it("does not hold when the change adds no test", () => {
    assert.deepEqual(evaluateRedGreen([], [], []).details.reasons, ["the change adds or changes no test file"]);
  });
});

describe("vitest reports", () => {
  it("reads vitest list output relative to the repository", () => {
    const json = JSON.stringify([{ file: "/repo/packages/typed-storage/__tests__/index.test.ts" }]);
    assert.deepEqual(listedFiles(json, "/repo"), ["packages/typed-storage/__tests__/index.test.ts"]);
  });

  it("counts a run as passed only when vitest exited 0 and reported success", () => {
    const report = { success: true, numTotalTests: 1, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] };
    assert.equal(summarizeReport("c", [], report, true, 1, "").passed, true);
    assert.equal(summarizeReport("c", [], report, false, 1, "boom").passed, false);
  });
});
