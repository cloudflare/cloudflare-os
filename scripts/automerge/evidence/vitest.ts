// Runs chosen test files under a package's own vitest config and reads the JSON report, for the
// evidence producers that compare one set of tests across two versions of the source.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { asArray, asObject, asString, parseJson, type JsonObject } from "../proofs/json.ts";
import { runCommand } from "./exec.ts";

/** Test files vitest runs, as opposed to the helpers and fixtures beside them. */
export const RUNNABLE_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Configs these producers do not run: a browser, provider accounts, models or the full stack. */
const UNSUPPORTED_CONFIG = /\.(browser|contract|eval|integration)\.config\.ts$/;

/** The package directory (`packages/<name>`) of a repo-relative path, if it is in one. */
export function packageOf(path: string): string | undefined {
  return /^(packages\/[^/]+)\//.exec(path)?.[1];
}

/** The supported vitest configs tracked in a package. */
function supportedConfigs(pkg: string): string[] {
  const result = runCommand("git", ["ls-files", "--", `${pkg}/vitest*.config.ts`], ".");
  return result.stdout.split("\n").filter((path) => path.startsWith(pkg) && !UNSUPPORTED_CONFIG.test(path));
}

/** The repo-relative test files a config includes, by `vitest list`; none if it fails to list. */
function configFiles(pkg: string, config: string): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "automerge-vitest-list-"));
  const out = join(dir, "list.json");
  try {
    const result = runCommand("pnpm", ["exec", "vitest", "list", "--filesOnly", `--json=${out}`, "--config", relative(pkg, config)], pkg);
    return new Set(result.ok ? listedFiles(readFileSync(out, "utf8"), process.cwd()) : []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  for (const test of tests) {
    const pkg = packageOf(test);
    if (!pkg) {
      unplaced.push(test);
      continue;
    }
    const matches = supportedConfigs(pkg).filter((config) => {
      let files = listed.get(config);
      if (!files) {
        files = configFiles(pkg, config);
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

/** What a vitest report says about one test file. */
export interface FileResult {
  /** Relative to the repository root. */
  path: string;
  /** The file's own status: `failed` also when it crashed before or between its tests. */
  status: string;
  passed: number;
  failed: number;
  /** Tests that did not run: skipped, pending or todo. */
  notRun: number;
  /** Full names of its failing tests, at most 20. */
  failures: string[];
}

/** What one vitest run of chosen files reported, or that it left no report to read. */
export interface TestRun {
  config: string;
  files: string[];
  /** Undefined when vitest wrote no report that parses: nothing about the tests was seen. */
  results: FileResult[] | undefined;
  /** vitest's exit status was 0. */
  exitOk: boolean;
  seconds: number;
  /** The end of vitest's output, kept when the run did not exit 0. */
  tail: string;
}

/** The per-file results in a vitest JSON report, with paths relative to `root`. */
export function fileResults(report: JsonObject, root: string): FileResult[] {
  return asArray(report.testResults, "testResults").map((entry) => {
    const suite = asObject(entry, "suite");
    const result: FileResult = {
      path: relative(root, asString(suite.name, "suite name")), status: asString(suite.status, "suite status"),
      passed: 0, failed: 0, notRun: 0, failures: [],
    };
    for (const assertion of asArray(suite.assertionResults, "assertionResults")) {
      const a = asObject(assertion, "assertion");
      const status = asString(a.status, "assertion status");
      if (status === "passed") result.passed++;
      else if (status === "failed") {
        result.failed++;
        if (result.failures.length < 20) result.failures.push(asString(a.fullName, "fullName"));
      } else result.notRun++;
    }
    return result;
  });
}

/** Runs `files` (repo-relative) under `config` from its package directory. */
export function runTests(config: string, files: string[]): TestRun {
  const pkg = packageOf(config);
  if (!pkg) throw new Error(`${config} is not in a package`);
  const dir = mkdtempSync(join(tmpdir(), "automerge-vitest-"));
  const out = join(dir, "report.json");
  try {
    const result = runCommand("pnpm", [
      "exec", "vitest", "run", "--config", relative(pkg, config), "--reporter=json", `--outputFile=${out}`,
      ...files.map((file) => relative(pkg, file)),
    ], pkg);
    let results: FileResult[] | undefined;
    try {
      results = fileResults(asObject(parseJson(readFileSync(out, "utf8")), "vitest report"), process.cwd());
    } catch (error) {
      console.error(`no readable vitest report: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { config, files, results, exitOk: result.ok, seconds: result.seconds, tail: result.ok ? "" : result.tail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A run as artifact details. */
export function runDetails(run: TestRun): JsonObject {
  return {
    config: run.config, files: run.files, exit_ok: run.exitOk, seconds: run.seconds,
    results: run.results === undefined ? null : run.results.map((r) => ({ ...r })),
    ...(run.tail ? { tail: run.tail } : {}),
  };
}
