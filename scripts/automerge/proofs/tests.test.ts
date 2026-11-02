import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { FileDiff } from "./diff.ts";
import { asObject, parseJson, type JsonObject } from "./json.ts";
import {
  budgetMinutes, DEFAULT_BUDGET_MINUTES, evaluateKills, importedSources, killedMutants, OverBudget, planScope, runBounded,
} from "./tests.ts";

// Stryker JSON reports from real proof runs on packages/error-reporting (2026-11-02), cut down to
// the fields the proof reads. "red" weakened the two `toBeNull()` assertions of "rejects only
// invalid envelopes" to `toBeDefined()`; "green" added a test of a string envelope.
const report = (name: string): JsonObject =>
  asObject(parseJson(readFileSync(new URL(`./testdata/tests/error-reporting-${name}.json`, import.meta.url), "utf8")), name);

const file = (path: string): FileDiff => ({ path, status: "modified", binary: false, modeChanged: false, hunks: [] });

describe("proof-tests verdict", () => {
  it("fails the weakened assertions: three mutants the base killed survive", () => {
    const outcome = evaluateKills(report("red-base"), report("red-head"), {});
    assert.equal(outcome.holds, false);
    assert.deepEqual(outcome.details.reasons, ["3 mutant(s) the base tests killed survive at head"]);
    assert.deepEqual(outcome.details.lost, [
      "src/index.ts:250:9-250:67 ConditionalExpression -> false",
      "src/index.ts:250:9-250:67 LogicalOperator -> !isRecord(input) && ownValue(input, \"schemaVersion\") !== 1",
      "src/index.ts:250:29-250:67 ConditionalExpression -> false",
    ]);
  });

  it("holds for the added test", () => {
    const outcome = evaluateKills(report("green-base"), report("green-head"), {});
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.equal(outcome.details.killed_base, outcome.details.killed_head);
  });

  it("counts timeouts as killed and survivors as not", () => {
    const killed = killedMutants(report("red-head"));
    assert.equal(killed.size, 213);
  });

  it("fails a run that made no mutants", () => {
    assert.deepEqual(evaluateKills({ files: {} }, { files: {} }, {}).details.reasons, ["the mutation run made no mutants"]);
  });
});

describe("proof-tests scope", () => {
  it("takes tests in one package", () => {
    assert.deepEqual(planScope([file("packages/error-reporting/src/index.test.ts"), file("packages/error-reporting/src/__tests__/fixtures/a.json")]), {
      packageDir: "packages/error-reporting",
      tests: ["packages/error-reporting/src/index.test.ts", "packages/error-reporting/src/__tests__/fixtures/a.json"],
    });
  });

  it("does not apply when a source file changes", () => {
    assert.ok("outOfScope" in planScope([file("packages/error-reporting/src/index.test.ts"), file("packages/error-reporting/src/index.ts")]));
  });

  it("does not apply across packages or outside packages/", () => {
    assert.ok("outOfScope" in planScope([file("packages/a/x.test.ts"), file("packages/b/y.test.ts")]));
    assert.ok("outOfScope" in planScope([file("scripts/automerge/proofs/tests.test.ts")]));
  });

  it("finds the source a test imports, but not other tests, fixtures or declarations", () => {
    const present = new Set(["packages/p/src/index.ts", "packages/p/src/util.tsx", "packages/p/src/types.d.ts", "packages/p/src/helpers.test.ts"]);
    const text = [
      'import { a } from "./index.js";',
      'import { b } from "./util";',
      'import type { T } from "./types.d.ts";',
      'import { c } from "./helpers.test.ts";',
      'import { d } from "vitest";',
      'const e = await import("./index.ts");',
    ].join("\n");
    assert.deepEqual(importedSources("packages/p/src/x.test.ts", text, (path) => present.has(path)),
      ["packages/p/src/index.ts", "packages/p/src/util.tsx", "packages/p/src/index.ts"]);
  });
});

describe("proof-tests budget", () => {
  it("reads the budget in whole minutes", () => {
    assert.equal(budgetMinutes(undefined), DEFAULT_BUDGET_MINUTES);
    assert.equal(budgetMinutes(""), DEFAULT_BUDGET_MINUTES);
    assert.equal(budgetMinutes("5"), 5);
    for (const bad of ["0", "-1", "1.5", "ten"]) assert.throws(() => budgetMinutes(bad), /positive whole number/);
  });

  it("returns the output of a command that finishes in time", async () => {
    const out = await runBounded(process.execPath, ["-e", "process.stdout.write('done')"], ".", Date.now() + 60_000, true);
    assert.equal(out, "done");
  });

  it("rejects a command that exits non-zero", async () => {
    await assert.rejects(runBounded(process.execPath, ["-e", "process.exit(3)"], ".", Date.now() + 60_000), /exited with 3/);
  });

  // A real child on the real clock: what is under test is that a running command is killed.
  it("kills a command still running at the deadline and reports OverBudget", async () => {
    const started = Date.now();
    await assert.rejects(runBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ".", started + 300), OverBudget);
    assert.ok(Date.now() - started < 30_000);
  });

  it("starts nothing once the deadline has passed", async () => {
    await assert.rejects(runBounded(process.execPath, ["-e", ""], ".", Date.now() - 1), OverBudget);
  });
});
