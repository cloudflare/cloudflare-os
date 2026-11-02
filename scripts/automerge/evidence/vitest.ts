// Runs chosen test files under a package's own vitest config and reads the JSON report, for the
// evidence producers that compare one set of tests across two versions of the source.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { asArray, asNumber, asObject, asString, parseJson, type JsonObject } from "../proofs/json.ts";
import { runCommand } from "./exec.ts";

/** Test files vitest runs, as opposed to the helpers and fixtures beside them. */
export const RUNNABLE_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Configs these producers do not run: a browser, provider accounts, models or the full stack. */
const UNSUPPORTED_CONFIG = /\.(browser|contract|eval|e2e|integration)\.config\.ts$/;

/** The package directory (`packages/<name>`) of a repo-relative path, if it is in one. */
export function packageOf(path: string): string | undefined {
  return /^(packages\/[^/]+)\//.exec(path)?.[1];
}

/**
 * Assigns each test file to the one supported vitest config in its package that lists it, using
 * `vitest list`. Returns the groups, keyed by config path, and the files no config or more than
 * one config lists.
 */
export function groupByConfig(tests: string[]): { groups: Map<string, string[]>; unplaced: string[] } {
  const groups = new Map<string, string[]>();
  const unplaced: string[] = [];
  const listed = new Map<string, Set<string>>();
  const configsOf = (pkg: string): string[] => {
    const result = runCommand("git", ["ls-files", "--", `${pkg}/vitest*.config.ts`], ".");
    return result.stdout.split("\n").filter((path) => path.startsWith(pkg) && !UNSUPPORTED_CONFIG.test(path));
  };
  const listFiles = (pkg: string, config: string): Set<string> => {
    const dir = mkdtempSync(join(tmpdir(), "automerge-vitest-list-"));
    const out = join(dir, "list.json");
    try {
      const result = runCommand("pnpm", ["exec", "vitest", "list", "--filesOnly", `--json=${out}`, "--config", relative(pkg, config)], pkg);
      return new Set(result.ok ? listedFiles(readFileSync(out, "utf8"), process.cwd()) : []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const test of tests) {
    const pkg = packageOf(test);
    if (!pkg) {
      unplaced.push(test);
      continue;
    }
    const matches = configsOf(pkg).filter((config) => {
      let files = listed.get(config);
      if (!files) {
        files = listFiles(pkg, config);
        listed.set(config, files);
      }
      return files.has(test);
    });
    if (matches.length !== 1) {
      unplaced.push(test);
      continue;
    }
    groups.set(matches[0], [...(groups.get(matches[0]) ?? []), test]);
  }
  return { groups, unplaced };
}

/** The files in a `vitest list --filesOnly --json=<file>` report, relative to `root`. */
export function listedFiles(json: string, root: string): string[] {
  return asArray(parseJson(json), "vitest list").map((entry) => relative(root, asString(asObject(entry, "entry").file, "file")));
}

/** What one vitest run of chosen files reported. */
export interface TestRun {
  config: string;
  files: string[];
  /** vitest exited 0 and reported success. */
  passed: boolean;
  tests: number;
  failedTests: number;
  failedSuites: number;
  /** Full names of the failing tests, at most 20. */
  failures: string[];
  seconds: number;
  /** The end of vitest's output, kept when the run did not pass. */
  tail: string;
}

/** Reads a vitest JSON report into a run summary. */
export function summarizeReport(config: string, files: string[], report: JsonObject, exitOk: boolean, seconds: number, tail: string): TestRun {
  const failures: string[] = [];
  for (const suite of asArray(report.testResults, "testResults")) {
    for (const assertion of asArray(asObject(suite, "suite").assertionResults, "assertionResults")) {
      const a = asObject(assertion, "assertion");
      if (a.status === "failed") failures.push(asString(a.fullName, "fullName"));
    }
  }
  const passed = exitOk && report.success === true;
  return {
    config, files, passed,
    tests: asNumber(report.numTotalTests, "numTotalTests"),
    failedTests: asNumber(report.numFailedTests, "numFailedTests"),
    failedSuites: asNumber(report.numFailedTestSuites, "numFailedTestSuites"),
    failures: failures.slice(0, 20), seconds, tail: passed ? "" : tail,
  };
}

/** Runs `files` (repo-relative; none means every file the config includes) under `config` from its package directory. */
export function runTests(config: string, files: string[], env: NodeJS.ProcessEnv = process.env): TestRun {
  const pkg = packageOf(config);
  if (!pkg) throw new Error(`${config} is not in a package`);
  const dir = mkdtempSync(join(tmpdir(), "automerge-vitest-"));
  const out = join(dir, "report.json");
  try {
    const result = runCommand("pnpm", [
      "exec", "vitest", "run", "--config", relative(pkg, config), "--reporter=json", `--outputFile=${out}`,
      ...files.map((file) => relative(pkg, file)),
    ], pkg, env);
    let report: JsonObject;
    try {
      report = asObject(parseJson(readFileSync(out, "utf8")), "vitest report");
    } catch {
      return {
        config, files, passed: false, tests: 0, failedTests: 0, failedSuites: files.length, failures: [],
        seconds: result.seconds, tail: result.tail,
      };
    }
    return summarizeReport(config, files, report, result.ok, result.seconds, result.tail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A run as artifact details. */
export function runDetails(run: TestRun): JsonObject {
  return {
    config: run.config, files: run.files, passed: run.passed, tests: run.tests, failed_tests: run.failedTests,
    failed_suites: run.failedSuites, failures: run.failures, seconds: run.seconds, ...(run.tail ? { tail: run.tail } : {}),
  };
}
