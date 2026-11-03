import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDiff } from "../proofs/diff.ts";
import { asObject, parseJson } from "../proofs/json.ts";
import { evaluateRedGreen, headVerdict, planRedGreen } from "./red-green.ts";
import { fileResults, listedFiles, type FileResult, type TestRun } from "./vitest.ts";

// `git diff -U0` of real merged commits against their parents, and the vitest JSON reports of
// #932's changed test file (024caa73b, typed-storage distinct keys) recorded 2026-11-03: at head
// (63 pass) and with src/index.ts put back to its parent (4 fail). The crash case is a real report
// whose only file failed in a hook before any of its ten tests ran, recorded 2026-11-02.
const DIR = new URL("./testdata/red-green/", import.meta.url);
const diff = (commit: string) => parseDiff(readFileSync(new URL(`diff-${commit}.diff`, DIR), "utf8"));
const TEST = "packages/typed-storage/__tests__/index.test.ts";
const CONFIG = "packages/typed-storage/vitest.config.ts";

function results(url: URL): FileResult[] {
  return fileResults(asObject(parseJson(readFileSync(url, "utf8")), "report"), "/workspace");
}

function run(side: "head" | "base", files = [TEST]): TestRun {
  return { config: CONFIG, files, results: results(new URL(`pr932-vitest-${side}.json`, DIR)), exitOk: side === "head", seconds: 3, tail: "" };
}

/** The real crashed report, relabelled as #932's test file so only its statuses matter. */
function crashed(): TestRun {
  const [file] = results(new URL("crashed-suite.json", DIR));
  return { config: CONFIG, files: [TEST], results: [{ ...file, path: TEST }], exitOk: false, seconds: 3, tail: "" };
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
  const tests = [TEST];

  it("holds on #932: 63 pass at head, 4 fail on the base source", () => {
    const outcome = evaluateRedGreen(tests, [run("head")], [run("base")]);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, true);
  });

  it("does not hold when the file passes on the base source too", () => {
    const outcome = evaluateRedGreen(tests, [run("head")], [run("head")]);
    assert.deepEqual(outcome.details.reasons, [`${TEST} passes on the base source, so it does not check the change`]);
  });

  it("does not hold when the file fails at head, and skips the base", () => {
    const outcome = headVerdict(tests, [run("base")]);
    assert.equal(outcome?.status, "ok");
    assert.equal(outcome?.holds, false);
    assert.match(String(asObject(outcome?.details ?? {}, "details").reasons), /fails at head: non-unique index by number/);
  });

  it("does not hold when the change adds no test", () => {
    assert.deepEqual(evaluateRedGreen([], [], []).details.reasons, ["the change adds or changes no test file"]);
  });

  it("errors when the base left no readable report, instead of counting it red", () => {
    const outcome = evaluateRedGreen(tests, [run("head")], [{ ...run("base"), results: undefined }]);
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /no readable vitest report on the base source/);
  });

  it("errors when the base file crashed before any test ran, instead of counting it red", () => {
    const outcome = evaluateRedGreen(tests, [run("head")], [crashed()]);
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /ran no test on the base source \(status failed\)/);
  });

  it("errors when a changed test file is missing from a report", () => {
    const other = "packages/typed-storage/__tests__/other.test.ts";
    const outcome = evaluateRedGreen([TEST, other], [run("head", [TEST, other])], [run("base", [TEST, other])]);
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /other\.test\.ts is missing from the head report/);
  });

  it("errors when vitest exited non-zero at head though every test passed", () => {
    const outcome = evaluateRedGreen(tests, [{ ...run("head"), exitOk: false }], [run("base")]);
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /exited non-zero under .* at head with no failing test/);
  });

  it("errors when vitest exited non-zero on the base source with the file passing", () => {
    assert.equal(evaluateRedGreen(tests, [run("head")], [{ ...run("head"), exitOk: false }]).status, "error");
  });

  it("errors when the head crashed, instead of counting it as a head failure", () => {
    assert.equal(headVerdict(tests, [crashed()])?.status, "error");
  });
});

describe("vitest reports", () => {
  it("reads vitest list output relative to the repository", () => {
    const json = JSON.stringify([{ file: "/repo/packages/typed-storage/__tests__/index.test.ts" }]);
    assert.deepEqual(listedFiles(json, "/repo"), ["packages/typed-storage/__tests__/index.test.ts"]);
  });

  it("counts each file's passing, failing and unrun tests", () => {
    const [base] = results(new URL("pr932-vitest-base.json", DIR));
    assert.deepEqual({ ...base, failures: base.failures.length }, { path: TEST, status: "failed", passed: 59, failed: 4, notRun: 0, failures: 4 });
  });
});
