import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson } from "../proofs/json.ts";
import { changedRanges, evaluateMutation, MIN_SCORE, tally } from "./mutation.ts";

// #932's `git diff -U0` (024caa73b against its parent), and real Stryker JSON reports: the mutation
// proof's recorded error-reporting runs (216 killed, 57 survived, 7 uncovered; and a weakened test
// at 213, 60, 7), recorded 2026-11-02.
const diff = readFileSync(new URL("./testdata/red-green/diff-024caa73b.diff", import.meta.url), "utf8");
const report = (name: string) =>
  asObject(parseJson(readFileSync(new URL(`../proofs/testdata/tests/${name}.json`, import.meta.url), "utf8")), name);

describe("changedRanges", () => {
  it("takes #932's added source lines and leaves its test file out", () => {
    assert.deepEqual([...changedRanges(diff)], [["packages/typed-storage/src/index.ts", [[83, 93], [698, 700]]]]);
  });

  it("skips pure deletions and declaration files", () => {
    const text = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts", "--- a/packages/x/src/a.ts", "+++ b/packages/x/src/a.ts",
      "@@ -4,2 +3,0 @@", "-gone", "-gone",
      "diff --git a/packages/x/src/types.d.ts b/packages/x/src/types.d.ts", "--- a/packages/x/src/types.d.ts",
      "+++ b/packages/x/src/types.d.ts", "@@ -1 +1 @@", "-a", "+b",
    ].join("\n");
    assert.deepEqual([...changedRanges(text)], []);
  });
});

describe("evaluateMutation", () => {
  it("scores error-reporting's recorded run at 216 of 280 and holds", () => {
    const t = tally(report("error-reporting-green-head"));
    assert.deepEqual({ detected: t.detected, undetected: t.undetected, excluded: t.excluded }, { detected: 216, undetected: 64, excluded: 0 });
    const outcome = evaluateMutation(new Map([["packages/error-reporting", t]]), []);
    assert.equal(outcome.holds, true);
    assert.equal(asObject(asObject(outcome.details.packages, "packages")["packages/error-reporting"], "pkg").score, 0.771);
  });

  it("does not hold below the minimum score", () => {
    const t = { detected: 1, undetected: 3, excluded: 2, survivors: [] };
    const outcome = evaluateMutation(new Map([["packages/typed-storage", t]]), ["packages/workshop-frontend"]);
    assert.deepEqual(outcome.details.reasons, [
      `packages/typed-storage: mutation score 0.25 on the changed lines is below ${MIN_SCORE}`,
      "changed source in packages/workshop-frontend has no vitest.config.ts to measure it",
    ]);
    assert.deepEqual(outcome.details.unmeasured, ["packages/workshop-frontend"]);
  });

  it("does not hold when no mutant could be scored", () => {
    const outcome = evaluateMutation(new Map([["packages/typed-storage", { detected: 0, undetected: 0, excluded: 4, survivors: [] }]]), []);
    assert.equal(outcome.holds, false);
  });
});
