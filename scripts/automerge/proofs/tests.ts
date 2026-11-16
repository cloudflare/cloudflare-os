#!/usr/bin/env node

// proof-tests: a test-only pull request whose tests kill at least the mutants the base tests did.
//
// Applies when every changed file is a test file (TEST_PATH) in one package. The proof mutates the
// package source those tests reach through imports and re-exports (sourceGraph), with Stryker and
// the package's own vitest config narrowed to the changed test files, once with the base version of
// those files and once with the head version. Source is identical on both sides, so the two runs
// make the same mutants. It holds when every mutant the base tests killed (or timed out) is still
// killed at head: an edit that weakens a test without deleting a line kills fewer and fails.
//
// Scope follows a 2026-11-02 probe: Stryker 10.1.1's vitest runner worked on a workerd suite
// (typed-storage) and a Node suite (error-reporting).
// A pull request that changes anything but tests in one package is not applicable. Tests that only
// a browser-mode, contract, eval or integration config runs get status `error`, and so does an
// edit to an existing helper, fixture or setup file (editedSupportFiles).
//
// The whole proof runs within a wall-clock budget, AUTOMERGE_MUTATION_BUDGET_MINUTES (default
// DEFAULT_BUDGET_MINUTES). A heavy suite makes thousands of mutants (#943's base run had not
// finished after 50 minutes), so a run still going at the deadline is killed and the result is
// status `error`: a person reviews the pull request.
//
// Stryker is installed from ./stryker, its own pnpm workspace, rather than from the root lockfile
// (see ./stryker/pnpm-workspace.yaml).
//
// This job runs the pull request's code and holds no secrets.
//
//   node scripts/automerge/proofs/tests.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, AUTOMERGE_MUTATION_BUDGET_MINUTES

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decide, errored, notApplicable, runProducer, type Outcome } from "./artifact.ts";
import type { FileDiff } from "./diff.ts";
import { fileAt, git, mergeBase, pullRequestDiff } from "./git.ts";
import { asArray, asObject, asString, isObject, parseJson, type Json, type JsonObject } from "./json.ts";

/** Paths that hold tests, fixtures, helpers or setup rather than shipped code. */
export const TEST_PATH = /(^|\/)(__tests__|test|tests|fixtures|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Test files vitest runs, as opposed to the helpers and fixtures beside them. */
const RUNNABLE_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PACKAGE = /^packages\/([^/]+)\//;
const UNSUPPORTED_CONFIG = /\.(browser|contract|eval|integration)\.config\.ts$/;
const KILLED = new Set(["Killed", "Timeout"]);
const STRYKER_CONFIG = "stryker.automerge.json";
const VITEST_CONFIG = "vitest.automerge.config.ts";
const reportPath = (side: "base" | "head") => `reports/automerge-mutation-${side}.json`;

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

// The keyword may be followed by `{` or `*` as well as a space: `import{a}from"./a"` is valid.
const IMPORT = /(?:^|[\s;])(?:import|export)(?=[\s{*])[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|(?<![\w$#.])(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;
/** A type-only import or re-export, which brings no behavior with it. */
const TYPE_ONLY = /^[\s;]*(?:import|export)\s+type\s/;
/** Every `import` or `require` name; the next character past spaces says whether it is a call. */
const CALL_NAME = /(?<![\w$#.])(?:import|require)(?![\w$])/g;
/** The one call spelling IMPORT reads: the name, then `(` and a single string literal. */
const READABLE_CALL = /(?:import|require)\(\s*['"][^'"]+['"]\s*\)/y;
const SOURCE = /\.[cm]?tsx?$/;
/** JavaScript the tests can run, which this proof neither mutates nor follows. */
const JAVASCRIPT = /\.(?:[cm]?js|jsx)$/;
/** Characters Stryker's `mutate` list reads as a glob, so a path holding one may not name itself. */
const GLOB_CHARACTER = /[*?[\]{}()!+@]/;

/** A `/` after one of these characters, or after one of REGEX_AFTER_WORD, starts a regex literal. */
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** The end of the regex literal that starts at `at`, or -1 when it does not end on its line. */
function regexEnd(text: string, at: number): number {
  let inClass = false;
  for (let j = at + 1; j < text.length; j += text[j] === "\\" ? 2 : 1) {
    if (text[j] === "\n") return -1;
    if (text[j] === "[") inClass = true;
    else if (text[j] === "]") inClass = false;
    else if (text[j] === "/" && !inClass) return j;
  }
  return -1;
}

/**
 * A source file with its comments blanked out, every position kept, so a quote or a stray
 * `import` in a comment cannot stop or start an import pattern. One linear pass that steps over
 * strings and regex literals (a `/` after an operator, a bracket or a keyword such as `return`).
 * It stops blanking at a string or regex it cannot see the end of on its line (JSX text holding a
 * quote reads that way) and leaves the rest as it is; imports come first in a file, so they are
 * blanked. A block comment that never closes is a syntax error, and is returned.
 */
function blankComments(text: string): { code: string; unclosedComment?: number } {
  // UTF-16 units, as string indexes count them.
  const code = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (text[k] !== "\n") code[k] = " ";
  };
  // The last few characters of code before the cursor, comments left out and each run of spaces
  // kept as one, decide whether a `/` starts a regex: `a in /x/` is one, `a / b` is not.
  let previous = "";
  const regexStarts = () => {
    const before = previous.trimEnd();
    return before === "" || REGEX_AFTER.has(before.at(-1) ?? "") || REGEX_AFTER_WORD.test(before);
  };
  for (let i = 0; i < text.length;) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return { code: code.join(""), unclosedComment: i };
      blank(i, end + 2);
      i = end + 2;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
      const quote = text[i];
      // A quote or backtick string ends at its own quote; a quoted one also ends, unclosed, at a newline.
      let j = i + 1;
      for (; j < text.length; j += text[j] === "\\" ? 2 : 1) {
        if (text[j] === quote || (quote !== "`" && text[j] === "\n")) break;
      }
      if (j >= text.length || text[j] !== quote) break;
      previous = "x";
      i = j + 1;
    } else if (text[i] === "/" && regexStarts()) {
      const end = regexEnd(text, i);
      if (end === -1) break;
      previous = "x";
      i = end + 1;
    } else {
      const space = /\s/.test(text[i]);
      if (!space || !previous.endsWith(" ")) previous = (previous + (space ? " " : text[i])).slice(-12);
      i++;
    }
  }
  return { code: code.join("") };
}

/** The index of the first non-space character from `at`. */
function skipSpaces(text: string, at: number): number {
  let i = at;
  while (/\s/.test(text[i] ?? "")) i++;
  return i;
}

/** The source a set of tests reaches, and the imports that could not be followed. */
export interface SourceGraph {
  /** Source files to mutate (repo-relative), sorted. */
  sources: string[];
  problems: string[];
}

/**
 * The file an `exports` entry names for an import: a path, or its `import` or `default` condition.
 * Any other condition (`node`, `browser`, `development`, …) may be the one vitest picks, so an
 * entry with one names no file this proof can be sure of. `types` only matters to the type checker.
 */
function exportTarget(value: Json | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (!isObject(value)) return undefined;
  if (Object.keys(value).some((condition) => !["import", "default", "types"].includes(condition))) return undefined;
  // An `import` entry vitest would use decides alone, so one this proof cannot read is not replaced
  // by `default`.
  if (value.import !== undefined) return exportTarget(value.import);
  return exportTarget(value.default);
}

/**
 * The file a package's import of itself by name resolves to through its `exports` map (one `*` in
 * the key, each `*` in the target replaced), or undefined when it names none.
 */
export function selfImportPath(packageDir: string, manifest: JsonObject, specifier: string): string | undefined {
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  const exports = manifest.exports;
  // `"exports": "./src/index.ts"` names the package root only.
  const exact = isObject(exports) ? exportTarget(exports[subpath]) : subpath === "." ? exportTarget(exports) : undefined;
  if (exact !== undefined) return join(packageDir, exact);
  if (!isObject(exports)) return undefined;
  for (const [pattern, value] of Object.entries(exports)) {
    const [prefix, suffix, ...rest] = pattern.split("*");
    const target = exportTarget(value);
    if (suffix === undefined || rest.length > 0 || target === undefined) continue;
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      return join(packageDir, target.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length)));
    }
  }
  return undefined;
}

/** Whether `specifier` names the package `pkg` or a subpath of it. */
function names(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Every source file `roots` reach through imports and re-exports, followed transitively within
 * `packageDir`: a test that imports an index which re-exports another module exercises that module
 * too. Relative specifiers and the package's imports of itself by name (through its package.json
 * `exports`) are followed; other bare specifiers (node_modules) are not. A problem, since mutants
 * would go unmade, is: a specifier that resolves to no file or to a file outside the package; a
 * value import of another package in `workspace` (names of the workspace's packages), whose source
 * this proof does not mutate; and an `import`/`require` call spelled other than with one string
 * literal straight after the parenthesis. `read` gives a file's text, or undefined when there is
 * no such file.
 */
export function sourceGraph(
  roots: { path: string; text: string }[], packageDir: string, read: (path: string) => string | undefined,
  workspace: ReadonlySet<string>,
): SourceGraph {
  const sources = new Set<string>();
  const problems: string[] = [];
  const seen = new Set<string>();
  const manifestText = read(join(packageDir, "package.json"));
  const parsed = manifestText === undefined ? undefined : parseJson(manifestText);
  const manifest: JsonObject = isObject(parsed) ? parsed : {};
  const name = typeof manifest.name === "string" ? manifest.name : undefined;
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { code, unclosedComment } = blankComments(next.text);
    if (unclosedComment !== undefined) {
      problems.push(`${next.path}: cannot read its imports past the comment at offset ${unclosedComment}, which never closes`);
      continue;
    }
    for (const call of code.matchAll(CALL_NAME)) {
      if (code[skipSpaces(code, call.index + call[0].length)] !== "(") continue;
      READABLE_CALL.lastIndex = call.index;
      if (READABLE_CALL.test(code)) continue;
      const shown = next.text.slice(call.index, call.index + 40).split("\n")[0];
      problems.push(`${next.path}: cannot follow "${shown}", not a call with one string literal`);
    }
    for (const match of code.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      let base: string;
      if (specifier.startsWith(".")) {
        base = normalize(join(dirname(next.path), specifier));
      } else if (name !== undefined && names(specifier, name)) {
        const target = selfImportPath(packageDir, manifest, specifier);
        if (target === undefined) {
          problems.push(`${next.path}: ${specifier} names no export this proof can resolve in ${packageDir}/package.json`);
          continue;
        }
        base = normalize(target);
      } else {
        const other = [...workspace].find((pkg) => pkg !== name && names(specifier, pkg));
        if (other !== undefined && !TYPE_ONLY.test(match[0])) {
          problems.push(`${next.path}: imports ${specifier} from the workspace package ${other}, whose source is not mutated`);
        }
        continue;
      }
      const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`,
        `${base}.d.ts`, base.replace(/\.js$/, ".d.ts"), join(base, "index.ts"), join(base, "index.tsx")];
      const hit = candidates.map((path) => ({ path, text: read(path) })).find((file) => file.text !== undefined);
      if (hit?.text === undefined) {
        problems.push(`${next.path}: cannot resolve ${specifier}`);
        continue;
      }
      const inside = relative(packageDir, hit.path);
      if (inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
        problems.push(`${next.path}: imports ${hit.path}, outside ${packageDir}`);
        continue;
      }
      if (JAVASCRIPT.test(hit.path)) {
        problems.push(`${next.path}: imports the JavaScript module ${hit.path}, which is not mutated`);
        continue;
      }
      // Data files (JSON, text, styles) and declarations hold no mutants and import nothing.
      if (!SOURCE.test(hit.path) || hit.path.endsWith(".d.ts") || seen.has(hit.path)) continue;
      seen.add(hit.path);
      if (GLOB_CHARACTER.test(hit.path)) {
        problems.push(`${next.path}: imports ${hit.path}, whose name Stryker would read as a glob`);
        continue;
      }
      if (!TEST_PATH.test(hit.path)) sources.add(hit.path);
      queue.push({ path: hit.path, text: hit.text });
    }
  }
  return { sources: [...sources].toSorted(), problems };
}

/** A file's text, or undefined when the path is not a file. */
function readFile(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
}

/** The names of the workspace's packages (pnpm-workspace.yaml: `packages/*` and `scripts`). */
function workspacePackages(): Set<string> {
  const manifests = git(["ls-files", "--", "packages/*/package.json", "scripts/package.json"]).split("\n").filter((path) => path !== "");
  return new Set(manifests.flatMap((path) => {
    const parsed = parseJson(readFileSync(path, "utf8"));
    return isObject(parsed) && typeof parsed.name === "string" ? [parsed.name] : [];
  }));
}

/** A step was still running when the proof's budget ran out. */
export class OverBudget extends Error {}

export const DEFAULT_BUDGET_MINUTES = 20;

/** The budget in minutes: `value` when it is a positive whole number, the default when unset. */
export function budgetMinutes(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_BUDGET_MINUTES;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`AUTOMERGE_MUTATION_BUDGET_MINUTES must be a positive whole number, got "${value}"`);
  return Number(value);
}

/**
 * Runs a command and returns its stdout when `capture` is set. Throws OverBudget if it is still
 * running at `deadline` (epoch milliseconds). The command gets its own process group and the whole
 * group is killed: Stryker and vitest start workers, workerd among them, that outlive their parent.
 * The deadline settles the promise by itself, since a process outside the group can still hold the
 * captured pipe open.
 */
export function runBounded(
  command: string, args: string[], cwd: string, deadline: number, capture = false,
): Promise<string> {
  const line = `${command} ${args.join(" ")}`;
  console.log(`running in ${cwd}: ${line}`);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    reject(new OverBudget(`no time left to start ${line}`));
    return promise;
  }
  const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.stdout?.destroy();
    child.unref();
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      // ESRCH: the group has already exited, though something it started may still hold the pipe.
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        reject(error);
        return;
      }
    }
    reject(new OverBudget(`${line} was still running when the budget ran out`));
  }, remaining);
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (expired) return;
    if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
    else reject(new Error(`${line} exited with ${code ?? signal}`));
  });
  return promise;
}

/** Where the Stryker workspace is installed, inside the package under test. */
export const RUNNER_DIR = ".automerge-stryker";

export interface Runner {
  stryker: string;
  plugin: string;
}

/**
 * Installs ./stryker inside `packageDir`, so that the vitest runner's `vitest` import resolves
 * upward to the package's own vitest.
 */
export async function installRunner(packageDir: string, deadline: number): Promise<Runner> {
  const dir = join(packageDir, RUNNER_DIR);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(dirname(fileURLToPath(import.meta.url)), "stryker"), dir, { recursive: true });
  await runBounded("pnpm", ["install", "--frozen-lockfile"], dir, deadline);
  return {
    stryker: join(process.cwd(), dir, "node_modules", ".bin", "stryker"),
    plugin: createRequire(join(process.cwd(), dir, "package.json")).resolve("@stryker-mutator/vitest-runner"),
  };
}

/** The supported vitest config in `packageDir` that lists every one of `tests`, if exactly one does. */
async function configFor(packageDir: string, tests: string[], deadline: number): Promise<string> {
  const configs = git(["ls-files", "--", `${packageDir}/vitest*.config.ts`]).split("\n")
    .filter((path) => path !== "" && !UNSUPPORTED_CONFIG.test(path));
  const runnable = tests.filter((path) => RUNNABLE_TEST.test(path));
  const matches: string[] = [];
  for (const config of configs) {
    const listed = parseJson(await runBounded("pnpm",
      ["exec", "vitest", "list", "--filesOnly", "--json", "--config", relative(packageDir, config)], packageDir, deadline, true));
    const files = new Set(asArray(listed, "vitest list").map((entry) => relative(".", asString(asObject(entry, "entry").file, "file"))));
    if (runnable.every((path) => files.has(path))) matches.push(config);
  }
  if (matches.length !== 1) {
    throw new Error(`expected one supported vitest config listing ${runnable.join(", ")}, found ${matches.length}`);
  }
  return matches[0];
}

/**
 * The wrapper config that narrows `configImport` (a path relative to the wrapper) to `include`. It
 * resolves a config exported as a function or a promise, and throws for one with `test.projects`:
 * Vitest merges a root `include` into each project's own globs rather than replacing them, so the
 * run would not be narrowed and could pick up projects the tests do not belong to. The throw fails
 * the Stryker run, which the proof records as `error`.
 */
export function narrowedConfig(configImport: string, include: string[]): string {
  return [
    `import config from ${JSON.stringify(configImport)};`,
    "export default async (env) => {",
    '  const resolved = await (typeof config === "function" ? config(env) : config);',
    '  if (resolved.test?.projects) throw new Error("automerge: a vitest config with test.projects is not supported");',
    `  return { ...resolved, test: { ...resolved.test, include: ${JSON.stringify(include)} } };`,
    "};",
    "",
  ].join("\n");
}

async function runSide(
  plan: TestsPlan, runner: Runner, config: string, side: "base" | "head", tests: string[], deadline: number,
): Promise<JsonObject> {
  const pkg = plan.packageDir;
  const include = tests.filter((path) => RUNNABLE_TEST.test(path)).map((path) => relative(pkg, path));
  writeFileSync(join(pkg, VITEST_CONFIG), narrowedConfig(`./${relative(pkg, config)}`, include));
  writeFileSync(join(pkg, STRYKER_CONFIG), JSON.stringify({
    testRunner: "vitest",
    // Stryker finds plugins next to its own package, which pnpm's layout does not share.
    plugins: [runner.plugin],
    vitest: { configFile: VITEST_CONFIG },
    // Stryker rewrites tsconfig files with the TypeScript JS API, which the workspace's TypeScript 7
    // no longer ships; vitest does not read tsconfig to run, so a missing file skips that step.
    tsconfigFile: "stryker-no-tsconfig.json",
    ignorePatterns: [RUNNER_DIR],
    mutate: plan.mutate.map((path) => relative(pkg, path)),
    reporters: ["json", "clear-text"],
    jsonReporter: { fileName: reportPath(side) },
    timeoutMS: 60_000,
  }, null, 2));
  rmSync(join(pkg, reportPath(side)), { force: true });
  await runBounded(runner.stryker, ["run", STRYKER_CONFIG], pkg, deadline);
  return asObject(parseJson(readFileSync(join(pkg, reportPath(side)), "utf8")), "Stryker report");
}

/** Runs both sides of the proof, base tests and head tests, against the same source. */
async function prove(plan: TestsPlan, tests: string[], from: string, deadline: number, details: JsonObject): Promise<Outcome> {
  let config: string;
  try {
    config = await configFor(plan.packageDir, plan.headTests, deadline);
  } catch (error) {
    if (error instanceof OverBudget) throw error;
    return errored(error instanceof Error ? error.message : String(error), details);
  }
  const runner = await installRunner(plan.packageDir, deadline);
  const headReport = await runSide(plan, runner, config, "head", plan.headTests, deadline);
  for (const path of tests) {
    const text = fileAt(from, path);
    if (text === undefined) rmSync(path, { force: true });
    else writeFileSync(path, text);
  }
  // New test files only: the base kills nothing, so there is no base run to make.
  const baseReport = plan.baseTests.some((path) => RUNNABLE_TEST.test(path))
    ? await runSide(plan, runner, config, "base", plan.baseTests, deadline)
    : { files: {} };
  return evaluateKills(baseReport, headReport, { ...details, config });
}

/**
 * The changed files, present at base, that vitest does not run itself. The proof runs only the
 * changed test files, so an edit to a helper or fixture that unchanged tests import would go unseen.
 */
export function editedSupportFiles(baseTests: string[]): string[] {
  return baseTests.filter((path) => !RUNNABLE_TEST.test(path));
}

async function main(): Promise<void> {
  await runProducer("proof", "proof-tests", async ({ head, base }) => {
    const minutes = budgetMinutes(process.env.AUTOMERGE_MUTATION_BUDGET_MINUTES);
    const deadline = Date.now() + minutes * 60_000;
    const from = mergeBase(base, head);
    const files = pullRequestDiff(base, head);
    if (files.length === 0) return notApplicable("changes nothing");
    const scope = planScope(files);
    if ("outOfScope" in scope) return notApplicable(scope.outOfScope);

    const baseTests = scope.tests.filter((path) => fileAt(from, path) !== undefined);
    const headTests = scope.tests.filter((path) => existsSync(path));
    const scoped = { package: scope.packageDir, tests: scope.tests, budget_minutes: minutes };
    const support = editedSupportFiles(baseTests);
    if (support.length > 0) {
      return errored(`changes existing helpers, fixtures or setup that unchanged tests may use: ${support.slice(0, 5).join(", ")}`, scoped);
    }
    try {
      // Stryker drives vitest directly, which runs none of the test task's codegen (docs/testing.md).
      // Built before the imports are followed, so generated modules resolve.
      await runBounded("pnpm", ["build"], ".", deadline);
      const graph = sourceGraph([
        ...headTests.map((path) => ({ path, text: readFileSync(path, "utf8") })),
        ...baseTests.map((path) => ({ path, text: fileAt(from, path) ?? "" })),
      ], scope.packageDir, readFile, workspacePackages());
      const plan: TestsPlan = { packageDir: scope.packageDir, baseTests, headTests, mutate: graph.sources };
      const details = { ...scoped, mutate: plan.mutate };
      if (graph.problems.length > 0) {
        return errored(`cannot follow every import of the changed tests: ${graph.problems.slice(0, 5).join("; ")}`, details);
      }
      if (plan.mutate.length === 0) return errored("the changed tests import no source file to mutate", details);
      return await prove(plan, scope.tests, from, deadline, details);
    } catch (error) {
      if (error instanceof OverBudget) return errored(`ran past the ${minutes}-minute budget: ${error.message}`, scoped);
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
