#!/usr/bin/env node

// proof-tests: a test-only pull request whose tests kill at least the mutants the base tests did.
//
// Applies when every changed file is a test file (TEST_PATH) in one package. The proof mutates the
// source files those tests import, with Stryker and the package's own vitest config narrowed to
// the changed test files, once with the base version of those files and once with the head
// version. Source is identical on both sides, so the two runs make the same mutants. It holds when
// every mutant the base tests killed (or timed out) is still killed at head: an edit that weakens
// a test without deleting a line kills fewer and fails.
//
// Scope follows the 2026-11-02 probe (evidence/build-research/probe-results.md): Stryker 10.1.1's
// vitest runner worked on a workerd suite (typed-storage) and a Node suite (error-reporting).
// Browser-mode, contract, eval and integration configs are out of scope, and so are tests outside
// packages/ (scripts/ runs on `node --test`). Out-of-scope pull requests get status `error`.
//
// This job runs the pull request's code and holds no secrets.
//
//   node scripts/automerge/proofs/tests.ts   (env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { decide, errored, notApplicable, runProducer, type Outcome } from "./artifact.ts";
import type { FileDiff } from "./diff.ts";
import { fileAt, mergeBase, pullRequestDiff } from "./git.ts";
import { asArray, asObject, asString, parseJson, type JsonObject } from "./json.ts";

/** Paths that hold tests, fixtures, helpers or setup rather than shipped code. */
export const TEST_PATH = /(^|\/)(__tests__|test|tests|fixtures|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Test files vitest runs, as opposed to the helpers and fixtures beside them. */
const RUNNABLE_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PACKAGE = /^packages\/([^/]+)\//;
const UNSUPPORTED_CONFIG = /\.(browser|contract|eval|integration)\.config\.ts$/;
const KILLED = new Set(["Killed", "Timeout"]);
const STRYKER_CONFIG = "stryker.automerge.json";
const VITEST_CONFIG = "vitest.automerge.config.ts";
const REPORT = "reports/automerge-mutation.json";

/** The mutants a Stryker JSON report says the tests killed, keyed by place and replacement. */
export function killedMutants(report: JsonObject): Set<string> {
  const killed = new Set<string>();
  for (const [file, entry] of Object.entries(asObject(report.files, "report files"))) {
    for (const mutant of asArray(asObject(entry, file).mutants, `${file} mutants`)) {
      const m = asObject(mutant, "mutant");
      if (!KILLED.has(asString(m.status, "mutant status"))) continue;
      const { start, end } = asObject(m.location, "mutant location");
      const s = asObject(start, "start");
      const e = asObject(end, "end");
      killed.add(`${file}:${String(s.line)}:${String(s.column)}-${String(e.line)}:${String(e.column)} ` +
        `${asString(m.mutatorName, "mutator")} -> ${String(m.replacement ?? "")}`);
    }
  }
  return killed;
}

/** Counts every mutant in a report. */
export function mutantCount(report: JsonObject): number {
  return Object.entries(asObject(report.files, "report files"))
    .reduce((sum, [file, entry]) => sum + asArray(asObject(entry, file).mutants, file).length, 0);
}

/** Holds when the head tests kill every mutant the base tests killed. */
export function evaluateKills(base: JsonObject, head: JsonObject, scope: JsonObject): Outcome {
  const before = killedMutants(base);
  const after = killedMutants(head);
  const lost = [...before].filter((key) => !after.has(key));
  const reasons = lost.length > 0 ? [`${lost.length} mutant(s) the base tests killed survive at head`] : [];
  if (mutantCount(head) === 0) reasons.push("the mutation run made no mutants");
  return decide(reasons, {
    ...scope,
    mutants: mutantCount(head), killed_base: before.size, killed_head: after.size, lost: lost.slice(0, 50),
  });
}

/** What the proof runs: one package, the changed test files, and the source they import. */
export interface TestsPlan {
  packageDir: string;
  /** Changed test files as each side has them (repo-relative). */
  baseTests: string[];
  headTests: string[];
  /** Source files to mutate (repo-relative). */
  mutate: string[];
}

/** Why the proof does not apply, or the package and the changed test files it covers. */
export type TestsScope = { outOfScope: string } | { packageDir: string; tests: string[] };

/** Applies the scope rules to a diff. */
export function planScope(files: FileDiff[]): TestsScope {
  const others = files.filter((file) => !TEST_PATH.test(file.path));
  if (others.length > 0) return { outOfScope: `changes files that are not tests: ${others.map((f) => f.path).slice(0, 5).join(", ")}` };
  const packages = new Set(files.map((file) => PACKAGE.exec(file.path)?.[1] ?? ""));
  if (packages.size !== 1 || packages.has("")) return { outOfScope: "changes tests outside exactly one package" };
  return { packageDir: `packages/${[...packages][0]}`, tests: files.map((file) => file.path) };
}

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** The repo-relative source files a test file imports through relative specifiers. */
export function importedSources(testPath: string, text: string, exists: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2];
    const base = normalize(join(dirname(testPath), specifier));
    const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
    const hit = candidates.find((candidate) => /\.tsx?$/.test(candidate) && exists(candidate));
    if (hit && !TEST_PATH.test(hit) && !hit.endsWith(".d.ts")) found.push(hit);
  }
  return found;
}

function run(command: string, args: string[], cwd: string): string {
  console.log(`running in ${cwd}: ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
}

/** The supported vitest config in `packageDir` that lists every one of `tests`, if exactly one does. */
function configFor(packageDir: string, tests: string[]): string {
  const configs = run("git", ["ls-files", "--", `${packageDir}/vitest*.config.ts`], ".").split("\n")
    .filter((path) => path !== "" && !UNSUPPORTED_CONFIG.test(path));
  const runnable = tests.filter((path) => RUNNABLE_TEST.test(path));
  const matches = configs.filter((config) => {
    const listed = parseJson(run("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json", "--config", relative(packageDir, config)], packageDir));
    const files = new Set(asArray(listed, "vitest list").map((entry) => relative(".", asString(asObject(entry, "entry").file, "file"))));
    return runnable.every((path) => files.has(path));
  });
  if (matches.length !== 1) {
    throw new Error(`expected one supported vitest config listing ${runnable.join(", ")}, found ${matches.length}`);
  }
  return matches[0];
}

function runSide(plan: TestsPlan, config: string, tests: string[]): JsonObject {
  const pkg = plan.packageDir;
  const runner = createRequire(join(process.cwd(), "package.json")).resolve("@stryker-mutator/vitest-runner");
  const include = tests.filter((path) => RUNNABLE_TEST.test(path)).map((path) => relative(pkg, path));
  writeFileSync(join(pkg, VITEST_CONFIG), [
    `import config from "./${relative(pkg, config)}";`,
    `export default { ...config, test: { ...config.test, include: ${JSON.stringify(include)} } };`,
    "",
  ].join("\n"));
  writeFileSync(join(pkg, STRYKER_CONFIG), JSON.stringify({
    testRunner: "vitest",
    // Stryker finds plugins next to its own package, which pnpm's layout does not share.
    plugins: [runner],
    vitest: { configFile: VITEST_CONFIG },
    // Stryker rewrites tsconfig files with the TypeScript JS API, which the workspace's TypeScript 7
    // no longer ships; vitest does not read tsconfig to run, so a missing file skips that step.
    tsconfigFile: "stryker-no-tsconfig.json",
    mutate: plan.mutate.map((path) => relative(pkg, path)),
    reporters: ["json", "clear-text"],
    jsonReporter: { fileName: REPORT },
    timeoutMS: 60_000,
  }, null, 2));
  rmSync(join(pkg, REPORT), { force: true });
  run("pnpm", ["exec", "stryker", "run", STRYKER_CONFIG], pkg);
  return asObject(parseJson(readFileSync(join(pkg, REPORT), "utf8")), "Stryker report");
}

async function main(): Promise<void> {
  await runProducer("proof", "proof-tests", async ({ head, base }) => {
    const from = mergeBase(base, head);
    const files = pullRequestDiff(base, head);
    if (files.length === 0) return notApplicable("changes nothing");
    const scope = planScope(files);
    if ("outOfScope" in scope) return notApplicable(scope.outOfScope);

    const baseTests = scope.tests.filter((path) => fileAt(from, path) !== undefined);
    const headTests = scope.tests.filter((path) => existsSync(path));
    const mutate = new Set<string>();
    for (const path of headTests) for (const source of importedSources(path, readFileSync(path, "utf8"), existsSync)) mutate.add(source);
    for (const path of baseTests) {
      for (const source of importedSources(path, fileAt(from, path) ?? "", existsSync)) mutate.add(source);
    }
    const plan: TestsPlan = { packageDir: scope.packageDir, baseTests, headTests, mutate: [...mutate].toSorted() };
    const details = { package: plan.packageDir, tests: scope.tests, mutate: plan.mutate };
    if (plan.mutate.length === 0) return errored("the changed tests import no source file to mutate", details);
    // Stryker drives vitest directly, which runs none of the test task's codegen (docs/testing.md).
    run("pnpm", ["build"], ".");
    let config: string;
    try {
      config = configFor(plan.packageDir, headTests);
    } catch (error) {
      return errored(error instanceof Error ? error.message : String(error), details);
    }

    const headReport = runSide(plan, config, headTests);
    for (const path of scope.tests) {
      const text = fileAt(from, path);
      if (text === undefined) rmSync(path, { force: true });
      else writeFileSync(path, text);
    }
    // New test files only: the base kills nothing, so there is no base run to make.
    const baseReport = baseTests.some((path) => RUNNABLE_TEST.test(path))
      ? runSide(plan, config, baseTests)
      : { files: {} };
    return evaluateKills(baseReport, headReport, { ...details, config });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
