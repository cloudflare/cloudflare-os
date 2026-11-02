#!/usr/bin/env node

// evidence-mutation: the package's tests kill most mutants Stryker makes on the lines the pull
// request adds or changes.
//
// For each package with changed TypeScript source and a `vitest.config.ts`, Stryker mutates only
// the changed line ranges (`mutate: ["src/x.ts:12-30"]`) and runs that config's tests against each
// mutant, with the mutation proof's Stryker install and wall-clock budget
// (scripts/automerge/proofs/tests.ts, AUTOMERGE_MUTATION_BUDGET_MINUTES). The score is killed and
// timed-out mutants over those plus survivors and uncovered ones; mutants that do not compile or
// crash the runner are left out. It holds when every measured package scores at least MIN_SCORE,
// Stryker's own default `low` threshold, which no band has been calibrated against yet. A package
// with only other configs is listed as unmeasured.
//
// This job runs the pull request's code and holds no secrets.
//
//   node scripts/automerge/evidence/mutation.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, AUTOMERGE_MUTATION_BUDGET_MINUTES

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { decide, errored, notApplicable, runProducer, type Outcome } from "../proofs/artifact.ts";
import { DIFF_ARGS } from "../proofs/diff.ts";
import { git } from "../proofs/git.ts";
import { asArray, asObject, asString, parseJson, type JsonObject } from "../proofs/json.ts";
import { budgetMinutes, installRunner, OverBudget, runBounded, RUNNER_DIR, TEST_PATH } from "../proofs/tests.ts";
import { packageOf } from "./vitest.ts";

export const MIN_SCORE = 0.6;
const CONFIG = "vitest.config.ts";
// Names .gitignore already covers for proofs/tests.ts, which never runs in the same job.
const STRYKER_CONFIG = "stryker.automerge.json";
const REPORT = "reports/automerge-mutation-changed-lines.json";
const SOURCE = /\.tsx?$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DETECTED = ["Killed", "Timeout"];
const UNDETECTED = ["Survived", "NoCoverage"];

/** The head line ranges each changed source file adds, from `git diff -U0` text. */
export function changedRanges(diffText: string): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  let path: string | undefined;
  for (const line of diffText.split("\n")) {
    // Content lines start with "+", "-" or " ", so only a real header matches.
    const file = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (file) {
      path = SOURCE.test(file[1]) && !file[1].endsWith(".d.ts") && !TEST_PATH.test(file[1]) ? file[1] : undefined;
      continue;
    }
    const hunk = path ? HUNK.exec(line) : null;
    if (!path || !hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    ranges.set(path, [...(ranges.get(path) ?? []), [start, start + count - 1]]);
  }
  return ranges;
}

/** Stryker's mutant tally for one report. */
export interface Tally {
  detected: number;
  undetected: number;
  excluded: number;
  survivors: string[];
}

/** Counts a Stryker JSON report's mutants by whether the tests detected them. */
export function tally(report: JsonObject): Tally {
  const result: Tally = { detected: 0, undetected: 0, excluded: 0, survivors: [] };
  for (const [file, entry] of Object.entries(asObject(report.files, "report files"))) {
    for (const mutant of asArray(asObject(entry, file).mutants, `${file} mutants`)) {
      const m = asObject(mutant, "mutant");
      const status = asString(m.status, "mutant status");
      if (DETECTED.includes(status)) result.detected++;
      else if (UNDETECTED.includes(status)) {
        result.undetected++;
        const start = asObject(asObject(m.location, "location").start, "start");
        result.survivors.push(`${file}:${String(start.line)} ${asString(m.mutatorName, "mutator")} (${status})`);
      } else result.excluded++;
    }
  }
  return result;
}

/** Holds when every measured package's score reaches MIN_SCORE. */
export function evaluateMutation(tallies: Map<string, Tally>, unmeasured: string[]): Outcome {
  const reasons: string[] = [];
  const packages: JsonObject = {};
  for (const [pkg, t] of tallies) {
    const scored = t.detected + t.undetected;
    const score = scored === 0 ? null : Math.round((t.detected / scored) * 1000) / 1000;
    packages[pkg] = { score, detected: t.detected, undetected: t.undetected, excluded: t.excluded, survivors: t.survivors.slice(0, 30) };
    if (score === null) reasons.push(`${pkg}: Stryker made no scorable mutant on the changed lines`);
    else if (score < MIN_SCORE) reasons.push(`${pkg}: mutation score ${score} on the changed lines is below ${MIN_SCORE}`);
  }
  if (unmeasured.length > 0) reasons.push(`changed source in ${unmeasured.join(", ")} has no ${CONFIG} to measure it`);
  return decide(reasons, { min_score: MIN_SCORE, calibrated: false, packages, unmeasured });
}

async function main(): Promise<void> {
  await runProducer("evidence", "evidence-mutation", async ({ head, base }): Promise<Outcome> => {
    const minutes = budgetMinutes(process.env.AUTOMERGE_MUTATION_BUDGET_MINUTES);
    const deadline = Date.now() + minutes * 60_000;
    const ranges = changedRanges(git([...DIFF_ARGS, `${base}...${head}`]));
    if (ranges.size === 0) return notApplicable("changes no TypeScript source");
    const byPackage = new Map<string, string[]>();
    const unmeasured = new Set<string>();
    for (const [path, lines] of ranges) {
      const pkg = packageOf(path);
      if (!pkg || !existsSync(join(pkg, CONFIG))) {
        unmeasured.add(pkg ?? path);
        continue;
      }
      const entries = lines.map(([start, end]) => `${relative(pkg, path)}:${start}-${end}`);
      byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), ...entries]);
    }
    const details = { budget_minutes: minutes, unmeasured: [...unmeasured] };
    if (byPackage.size === 0) return errored(`no changed source is in a package with a ${CONFIG}`, details);
    try {
      // Stryker drives vitest directly, which runs none of the test task's codegen (docs/testing.md).
      await runBounded("pnpm", ["build"], ".", deadline);
      const tallies = new Map<string, Tally>();
      for (const [pkg, mutate] of byPackage) {
        const runner = await installRunner(pkg, deadline);
        writeFileSync(join(pkg, STRYKER_CONFIG), JSON.stringify({
          testRunner: "vitest",
          plugins: [runner.plugin],
          vitest: { configFile: CONFIG },
          // As in proofs/tests.ts: TypeScript 7 has no JS API for Stryker's tsconfig rewrite.
          tsconfigFile: "stryker-no-tsconfig.json",
          ignorePatterns: [RUNNER_DIR],
          mutate,
          reporters: ["json", "clear-text"],
          jsonReporter: { fileName: REPORT },
          timeoutMS: 60_000,
        }, null, 2));
        rmSync(join(pkg, REPORT), { force: true });
        await runBounded(runner.stryker, ["run", STRYKER_CONFIG], pkg, deadline);
        tallies.set(pkg, tally(asObject(parseJson(readFileSync(join(pkg, REPORT), "utf8")), "Stryker report")));
      }
      return evaluateMutation(tallies, [...unmeasured]);
    } catch (error) {
      if (error instanceof OverBudget) return errored(`ran past the ${minutes}-minute budget: ${error.message}`, details);
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
