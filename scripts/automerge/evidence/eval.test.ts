import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asArray, asObject, parseJson, type Json } from "../proofs/json.ts";
import { evaluateComparison } from "./eval.ts";

// Real `workshop-evals-comparison` artifacts, downloaded 2026-11-02 with `gh run download`:
// run 41468082001 (#966, unchanged) and run 41111649796 (#950, inconclusive: every task's
// definition changed). None of the 24 newest comparisons regressed, so the regressed case is #966's
// file with one row's candidate passes lowered and its p-value set below 0.05.
function recorded(name: string): Json {
  return parseJson(readFileSync(new URL(`./testdata/eval/${name}.json`, import.meta.url), "utf8"));
}

const PR966 = "5fbf074bf5133940d5aaf826160f6c795d34f2e8";
const PR950 = "78699b247acbd3a72ca8e16227100604e640b0ae";

function regressedPr966(): Json {
  const comparison = asObject(recorded("run-41468082001-pr966"), "comparison");
  const row = asObject(asArray(comparison.rows, "rows")[0], "row");
  asObject(row.candidate, "candidate").passed = 3;
  row.pValue = 0.0034;
  comparison.verdict = "regressed";
  return comparison;
}

describe("evaluateComparison", () => {
  it("holds on #966's unchanged comparison", () => {
    const outcome = evaluateComparison(recorded("run-41468082001-pr966"), PR966);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, true);
    assert.equal(outcome.details.verdict, "unchanged");
    assert.equal(outcome.details.compared, 7);
  });

  it("errors on #950's inconclusive comparison: nothing was compared", () => {
    const outcome = evaluateComparison(recorded("run-41111649796-pr950"), PR950);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.details.error, "no eval task could be compared");
  });

  it("does not hold on a regression and names the task", () => {
    const outcome = evaluateComparison(regressedPr966(), PR966);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, false);
    assert.deepEqual(outcome.details.regressed, ["change-calendar/gpt-6-luna"]);
  });

  it("errors on a comparison of another commit", () => {
    assert.equal(evaluateComparison(recorded("run-41468082001-pr966"), PR950).status, "error");
  });

  it("errors on a regressed verdict no row explains, and on an unknown verdict", () => {
    const comparison = asObject(recorded("run-41468082001-pr966"), "comparison");
    comparison.verdict = "regressed";
    assert.equal(evaluateComparison(comparison, PR966).status, "error");
    comparison.verdict = "better";
    assert.equal(evaluateComparison(comparison, PR966).status, "error");
  });
});
