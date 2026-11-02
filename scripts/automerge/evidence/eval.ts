#!/usr/bin/env node

// evidence-eval: the Workshop evals did not regress.
//
// Reads the `comparison.json` that scripts/evals/compare-results.ts writes in the `Compare evals`
// job of .github/workflows/workshop-evals-pr.yml, which is where this producer runs: the gate binds
// `automerge-evidence-eval` to that workflow's `pull_request` run on the head. The comparison names
// the merge commit it measured as `candidateSha`, which must be the commit that run checked out.
//
// It holds on `unchanged` and `improved`; `regressed` (a pass rate fell with p < 0.05) and
// `inconclusive` (nothing could be compared) do not. Report-only until calibrated: over the 24
// newest comparisons on 2026-11-02 (runs 40919620760 to 41468082001, 13 pull requests), 22 were
// `unchanged`, 2 `inconclusive` and none `regressed`, so how often `regressed` is a false alarm is
// still unmeasured. The bands that list it stay closed until it is.
//
//   node scripts/automerge/evidence/eval.ts --comparison <comparison.json> --candidate <merge sha>
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decide, errored, runProducer, type Outcome } from "../proofs/artifact.ts";
import { asArray, asNumber, asObject, asString, isObject, parseJson, type Json, type JsonObject } from "../proofs/json.ts";

const VERDICTS = ["improved", "regressed", "unchanged", "inconclusive"];
const SIGNIFICANCE = 0.05;

function passRate(stats: JsonObject): number {
  const counted = asNumber(stats.trials, "trials") - asNumber(stats.infrastructureTrials, "infrastructureTrials");
  return counted === 0 ? 0 : asNumber(stats.passed, "passed") / counted;
}

/** The compared task and model pairs whose pass rate fell beyond noise. */
export function regressedRows(rows: Json[]): string[] {
  return rows.flatMap((entry) => {
    const row = asObject(entry, "row");
    if (row.reason !== null || typeof row.pValue !== "number" || row.pValue >= SIGNIFICANCE) return [];
    const baseline = asObject(row.baseline, "baseline");
    const candidate = asObject(row.candidate, "candidate");
    return passRate(candidate) < passRate(baseline) ? [`${asString(row.taskId, "taskId")}/${asString(row.model, "model")}`] : [];
  });
}

/** Decides from a comparison, which must be about `candidateSha`. */
export function evaluateComparison(comparison: Json, candidateSha: string): Outcome {
  if (!isObject(comparison)) return errored("comparison.json is not a JSON object");
  const verdict = comparison.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return errored(`unknown verdict ${JSON.stringify(verdict ?? null)}`);
  if (comparison.candidateSha !== candidateSha) {
    return errored(`the comparison measured ${String(comparison.candidateSha)}, not ${candidateSha}`);
  }
  const rows = asArray(comparison.rows, "rows");
  const compared = rows.filter((row) => isObject(row) && row.reason === null).length;
  const regressed = regressedRows(rows);
  if (verdict === "regressed" && regressed.length === 0) return errored("verdict is regressed but no compared row fell");
  // Nothing could be compared: no measurement to judge, which is not a regression.
  if (verdict === "inconclusive") return errored("no eval task could be compared", { verdict, rows: rows.length, compared });
  const reasons = verdict === "regressed" ? [`pass rate fell beyond noise for ${regressed.join(", ")}`] : [];
  return decide(reasons, {
    verdict, report_only: true, candidate_sha: candidateSha, baseline_sha: asString(comparison.baselineSha, "baselineSha"),
    rows: rows.length, compared, regressed,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { comparison: { type: "string" }, candidate: { type: "string" } } });
  await runProducer("evidence", "evidence-eval", async () => {
    const { comparison, candidate } = values;
    if (!comparison || !candidate) throw new Error("--comparison and --candidate are required");
    return evaluateComparison(parseJson(readFileSync(comparison, "utf8")), candidate);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
