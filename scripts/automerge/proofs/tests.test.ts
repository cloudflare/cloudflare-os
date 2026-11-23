import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { FileDiff } from "./diff.ts";
import { asArray, asObject, parseJson, type JsonObject } from "../json.ts";
import {
  budgetMinutes, DEFAULT_BUDGET_MINUTES, evaluateKills, killedMutants, narrowedConfig, OverBudget,
  planScope, runBounded, selfImportPath, sourceGraph,
} from "./tests.ts";

/** The workspace's package names, as the proof reads them, for the graph tests below. */
const WORKSPACE = new Set(["@gadgets/bundled-blueprints", "@gadgets/workshop-shared", "@gadgets/scripts"]);

// Stryker JSON reports from real proof runs on packages/error-reporting (2026-11-02), cut down to
// the fields the proof reads. "red" weakened the two `toBeNull()` assertions of "rejects only
// invalid envelopes" to `toBeDefined()`; "green" added a test of a string envelope.
const report = (name: string): JsonObject =>
  asObject(parseJson(readFileSync(new URL(`./testdata/tests/error-reporting-${name}.json`, import.meta.url), "utf8")), name);

const file = (path: string): FileDiff => ({ path, status: "modified", binary: false, modeChanged: false, hunks: [] });

/** A Stryker report of one mutant. */
function reportOf(mutant: JsonObject): JsonObject {
  return { files: { "src/a.ts": { mutants: [mutant] } } };
}

describe("proof-tests verdict", () => {
  it("fails the weakened assertions: three mutants the base killed survive", () => {
    const outcome = evaluateKills(report("red-base"), report("red-head"), {});
    assert.equal(outcome.holds, false);
    assert.equal(outcome.status, "ok");
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

  it("counts the red head run's killed mutants: 213 of its 280", () => {
    const killed = killedMutants(report("red-head"));
    assert.equal(killed.size, 213);
  });

  // A mutant is told from the next by where it is and what it puts there.
  it("throws on a report that does not say where a mutant is or what it replaces", () => {
    const mutant = { mutatorName: "ConditionalExpression", replacement: "true", status: "Killed" };
    const place = { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } };
    assert.equal(killedMutants(reportOf({ ...mutant, location: place })).size, 1);
    const unplaced: JsonObject[] = [
      mutant,
      { ...mutant, location: { start: {}, end: {} } },
      { ...mutant, location: { ...place, end: { line: "1", column: 5 } } },
      { ...mutant, location: place, replacement: 7 },
    ];
    for (const entry of unplaced) {
      assert.throws(() => killedMutants(reportOf(entry)), JSON.stringify(entry));
    }
  });

  it("fails a run that made no mutants", () => {
    for (const base of [{ files: {} }, undefined]) {
      const outcome = evaluateKills(base, { files: {} }, {});
      assert.deepEqual([outcome.status, outcome.holds], ["ok", false]);
    }
  });

  // Source is the same on both sides, so a base run with other mutants did not mutate what the
  // head run did, and its kills say nothing about the head's.
  it("fails when the base run and the head run did not make the same mutants", () => {
    assert.equal(evaluateKills({ files: {} }, report("green-head"), {}).holds, false);
    // The head run with a mutant no test killed found somewhere else, and with one more.
    const head = report("green-head");
    const files = asObject(head.files, "files");
    const [path] = Object.keys(files);
    const entry = asObject(files[path], path);
    const mutants = asArray(entry.mutants, "mutants");
    const survivor = mutants.findIndex((mutant) => asObject(mutant, "mutant").status === "Survived");
    const elsewhere = { ...asObject(mutants[survivor], "mutant"), location: { start: { line: 9999, column: 1 }, end: { line: 9999, column: 2 } } };
    for (const other of [mutants.with(survivor, elsewhere), [...mutants, elsewhere]]) {
      const run = { ...head, files: { ...files, [path]: { ...entry, mutants: other } } };
      assert.equal(evaluateKills(report("green-base"), run, {}).holds, false, `${other.length} mutants`);
    }
  });

  it("holds for new test files, which have no base run to compare with", () => {
    assert.equal(evaluateKills(undefined, report("green-head"), {}).holds, true);
  });
});

/** A package's files by path, as `sourceGraph` reads them. */
const files = (entries: Record<string, string>) => (path: string) => entries[path];

/** Checks that each problem, in order, starts with the importing file and names what it could not follow. */
function assertProblems(problems: string[], expected: [importer: string, names: string][]): void {
  assert.equal(problems.length, expected.length, problems.join("\n"));
  expected.forEach(([importer, names], i) => {
    assert.ok(problems[i].startsWith(`${importer}: `) && problems[i].includes(names), problems[i]);
  });
}

describe("proof-tests scope", () => {
  it("takes runnable test files in one package", () => {
    const tests = ["packages/error-reporting/src/index.test.ts", "packages/error-reporting/src/__tests__/envelope.spec.tsx"];
    assert.deepEqual(planScope(tests.map(file)), { packageDir: "packages/error-reporting", tests });
  });

  // The proof runs the changed test files and nothing else, so it cannot speak for any other file,
  // whatever directory it sits in: source, a helper, a fixture, or text that people or agents read.
  it("does not apply when anything but a runnable test file changes", () => {
    const test = file("packages/error-reporting/src/index.test.ts");
    for (const path of [
      "packages/error-reporting/src/index.ts",
      "packages/error-reporting/src/__tests__/helpers.ts",
      "packages/error-reporting/src/__tests__/fixtures/a.json",
      "packages/error-reporting/src/__tests__/README.md",
      "packages/error-reporting/tests/docs/guide.md",
      "packages/error-reporting/fixtures/AGENTS.md",
      "packages/error-reporting/test/.agents/skills/x/SKILL.md",
      "docs/testing.md",
      "plans/tests/plan.md",
    ]) {
      assert.ok("outOfScope" in planScope([test, file(path)]), path);
      assert.ok("outOfScope" in planScope([test, { ...file(path), status: "added" }]), `${path}, added`);
    }
  });

  it("does not apply across packages or outside packages/", () => {
    assert.ok("outOfScope" in planScope([file("packages/a/x.test.ts"), file("packages/b/y.test.ts")]));
    assert.ok("outOfScope" in planScope([file("scripts/automerge/proofs/tests.test.ts")]));
    assert.ok("outOfScope" in planScope([file(".agents/skills/write-gatekeeper/__tests__/a.test.ts")]));
  });

  // With no test file left at head there is nothing to run, and every vitest config would list
  // all of none of them.
  it("does not apply when every changed test file is deleted", () => {
    const kept = file("packages/error-reporting/src/index.test.ts");
    const deleted: FileDiff = { ...file("packages/error-reporting/src/old.test.ts"), status: "deleted" };
    assert.ok("outOfScope" in planScope([deleted]));
    assert.ok(!("outOfScope" in planScope([kept, deleted])));
  });

  // The test imports an index that defines identity() and re-exports double() from double.ts, so
  // double.ts's mutants must be made too.
  it("follows a re-export from the module a test imports", () => {
    const read = files({
      "packages/p/src/index.ts": 'export const identity = (x: number) => x;\nexport { double } from "./double.ts";\n',
      "packages/p/src/double.ts": "export const double = (x: number) => x * 2;\n",
    });
    const test = { path: "packages/p/src/index.test.ts", text: 'import { double, identity } from "./index.ts";\n' };
    assert.deepEqual(sourceGraph([test], "packages/p", read, WORKSPACE), { sources: ["packages/p/src/double.ts", "packages/p/src/index.ts"], problems: [] });
  });

  it("follows imports through helpers and side-effect imports, but mutates neither tests nor data", () => {
    const read = files({
      "packages/p/src/index.ts": 'import "./setup";\nimport data from "./data.json";\nexport { b } from "./util";\n',
      "packages/p/src/setup.ts": 'import { c } from "./deep/index.js";\n',
      "packages/p/src/deep/index.ts": "export const c = 1;\n",
      "packages/p/src/util.tsx": "export const b = 2;\n",
      "packages/p/src/data.json": "{}",
      "packages/p/src/types.d.ts": "export type T = 1;\n",
      "packages/p/__tests__/helpers.ts": 'export * from "../src/index.ts";\nimport type { T } from "../src/types.d.ts";\n',
    });
    const text = 'import { x } from "../__tests__/helpers.ts";\nimport { d } from "vitest";\nconst e = await import("./index.ts");\n';
    assert.deepEqual(sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE), {
      sources: ["packages/p/src/deep/index.ts", "packages/p/src/index.ts", "packages/p/src/setup.ts", "packages/p/src/util.tsx"],
      problems: [],
    });
  });

  it("names a specifier it cannot resolve and an import that leaves the package", () => {
    const read = files({
      "packages/p/src/index.ts": 'export { gone } from "./gone.ts";\nexport { other } from "../../q/src/other.ts";\n',
      "packages/q/src/other.ts": "export const other = 1;\n",
    });
    const test = { path: "packages/p/src/index.test.ts", text: 'import { gone } from "./index.ts";\n' };
    assertProblems(sourceGraph([test], "packages/p", read, WORKSPACE).problems, [
      ["packages/p/src/index.ts", "./gone.ts"],
      ["packages/p/src/index.ts", "packages/q/src/other.ts"],
    ]);
  });

  // The shape of bundled-blueprints' xlsx.server.test.ts, which imports its package's own zip
  // library by name, through package.json `exports`.
  it("follows the package's imports of itself by name through its exports", () => {
    const read = files({
      "packages/bundled-blueprints/package.json": JSON.stringify({
        name: "@gadgets/bundled-blueprints",
        exports: { ".": "./src/index.ts", "./libraries/*/server": "./libraries/*/server.ts" },
      }),
      "packages/bundled-blueprints/libraries/zip/server.ts": 'export { crc32 } from "./src/zip.ts";\n',
      "packages/bundled-blueprints/libraries/zip/src/zip.ts": "export const crc32 = () => 0;\n",
      "packages/bundled-blueprints/src/index.ts": "export const index = 1;\n",
    });
    const test = { path: "packages/bundled-blueprints/blueprints/workspace-sheets/__tests__/xlsx.server.test.ts",
      text: 'import { crc32 } from "@gadgets/bundled-blueprints/libraries/zip/server";\nimport "@gadgets/bundled-blueprints";\n' +
        'import { other } from "@gadgets/bundled-blueprints-extra";\nimport { gone } from "@gadgets/bundled-blueprints/nowhere";\n' };
    const graph = sourceGraph([test], "packages/bundled-blueprints", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/bundled-blueprints/libraries/zip/server.ts",
      "packages/bundled-blueprints/libraries/zip/src/zip.ts", "packages/bundled-blueprints/src/index.ts"]);
    assertProblems(graph.problems, [[test.path, "@gadgets/bundled-blueprints/nowhere"]]);
  });

  it("names an import whose argument is not a string literal, and follows require()", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n", "packages/p/src/..odd.ts": "export const odd = 1;\n" });
    const text = 'const a = require("./a.ts");\nconst b = await import(`./${name}.ts`);\nimport "./..odd.ts";\nthis.#require("x");\n';
    const graph = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/p/src/..odd.ts", "packages/p/src/a.ts"]);
    assertProblems(graph.problems, [["packages/p/src/x.test.ts", "import(`./${name}.ts`)"]]);
  });

  // A space or a comment between `import` and its parenthesis is valid JavaScript that the scan
  // does not read.
  it("names an import call it cannot read for a space or a comment, though its argument is a string", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n", "packages/p/src/feature.ts": "export const f = 1;\n" });
    const text = 'import { a } from "./a.ts";\nconst f = await import ("./feature.ts");\n' +
      'const g = await import /* webpackIgnore: true */ ("./feature.ts");\n';
    const graph = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/p/src/a.ts"]);
    assertProblems(graph.problems, [
      ["packages/p/src/x.test.ts", 'import ("./feature.ts")'],
      ["packages/p/src/x.test.ts", "import /* webpackIgnore: true */"],
    ]);
  });

  // A run of `*//*` after `import` must not make the scan backtrack. The run ends in a block
  // comment that never closes, a syntax error the proof reports.
  it("scans a long run of comment markers in linear time, and fails closed on the unclosed one", () => {
    const text = `const x = import${"/*".concat("*//*".repeat(100_000))};\n`;
    const started = performance.now();
    const { sources, problems } = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", files({}), WORKSPACE);
    assert.ok(performance.now() - started < 1000, "the scan took over a second");
    assert.deepEqual(sources, []);
    assert.equal(problems.length, 1);
  });

  // A quote inside a comment must not stop the static-import pattern, or the declaration would be
  // skipped without a problem.
  it("reads an import or re-export whose clause holds a comment with a quote", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n", "packages/p/src/feature.ts": "export const double = 1;\n" });
    const text = [
      'import { double /* public API\'s helper */ } from "./feature.ts";',
      'export { a /* it\'s re-exported */ } from "./a.ts";',
      "export const c = import.meta.url;",
      'const s = "import x from y";',
      "",
    ].join("\n");
    assert.deepEqual(sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE), {
      sources: ["packages/p/src/a.ts", "packages/p/src/feature.ts"],
      problems: [],
    });
  });

  // `//` inside a regex literal is not a comment, and an import or re-export needs no space after
  // its keyword.
  it("reads an import after a regex literal holding //, and imports written without spaces", () => {
    const read = files({
      "packages/p/src/a.ts": "export const a = 1;\n",
      "packages/p/src/b.ts": "export const b = 1;\n",
      "packages/p/src/feature.ts": "export const f = 1;\n",
      "packages/p/src/half.ts": "export const h = 1;\n",
    });
    const text = [
      'import{a}from"./a.ts";',
      'export*from"./b.ts";',
      'const load = (url: string) => { if (/https?:\\/\\//.test(url)) return import("./feature.ts"); };',
      'const ratio = 4 / 2; const h = import("./half.ts");',
      "",
    ].join("\n");
    assert.deepEqual(sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE), {
      sources: ["packages/p/src/a.ts", "packages/p/src/b.ts", "packages/p/src/feature.ts", "packages/p/src/half.ts"],
      problems: [],
    });
  });

  // A JavaScript module the tests run holds behavior, so it is a problem rather than data.
  it("names an import that resolves to a JavaScript module", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n", "packages/p/src/feature.js": "export const double = (x) => x * 2;\n" });
    const text = 'import { a } from "./a.ts";\nimport { double } from "./feature.js";\n';
    const graph = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/p/src/a.ts"]);
    assertProblems(graph.problems, [["packages/p/src/x.test.ts", "packages/p/src/feature.js"]]);
  });

  // A weakened assertion about another workspace package's code changes no kill in this package's
  // mutants.
  it("names a value import of another workspace package, but not a type-only one or a node_modules one", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n" });
    const text = 'import { a } from "./a.ts";\nimport { api } from "@gadgets/workshop-shared/api";\n' +
      'import type { T } from "@gadgets/workshop-shared";\nimport { z } from "zod";\n';
    const graph = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/p/src/a.ts"]);
    assertProblems(graph.problems, [["packages/p/src/x.test.ts", "@gadgets/workshop-shared/api"]]);
  });

  // Every `*` in an exports target names the matched part.
  it("replaces every * in an exports target", () => {
    const manifest = { name: "@gadgets/p", exports: { "./lib/*": "./lib/*/*.ts" } };
    assert.equal(selfImportPath("packages/p", manifest, "@gadgets/p/lib/zip"), "packages/p/lib/zip/zip.ts");
  });

  // Vitest may pick a condition other than `import` or `default`, and such a condition nested under
  // `import` must not fall back to the outer `default`.
  it("resolves no export that has a condition other than import, default or types", () => {
    const conditional = { name: "@gadgets/p", exports: { "./feature": { node: "./src/feature.node.ts", default: "./src/feature.ts" } } };
    assert.equal(selfImportPath("packages/p", conditional, "@gadgets/p/feature"), undefined);
    const nested = { name: "@gadgets/p", exports: { "./feature": { import: { node: "./src/feature.node.ts" }, default: "./src/feature.ts" } } };
    assert.equal(selfImportPath("packages/p", nested, "@gadgets/p/feature"), undefined);
    const plain = { name: "@gadgets/p", exports: { "./feature": { types: "./src/feature.d.ts", import: "./src/feature.ts" } } };
    assert.equal(selfImportPath("packages/p", plain, "@gadgets/p/feature"), "packages/p/src/feature.ts");
  });

  // Stryker reads each `mutate` entry as a glob.
  it("names a source whose path Stryker would read as a glob", () => {
    const read = files({ "packages/p/src/a.ts": "export const a = 1;\n", "packages/p/src/[feature].ts": "export const f = 1;\n" });
    const text = 'import { a } from "./a.ts";\nimport { f } from "./[feature].ts";\n';
    const graph = sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read, WORKSPACE);
    assert.deepEqual(graph.sources, ["packages/p/src/a.ts"]);
    assertProblems(graph.problems, [["packages/p/src/x.test.ts", "packages/p/src/[feature].ts"]]);
  });
});

/** Loads `config` through narrowedConfig's wrapper, as Vitest would, from a temporary directory. */
async function load(config: string): Promise<JsonObject> {
  const dir = mkdtempSync(join(tmpdir(), "automerge-narrow-"));
  try {
    writeFileSync(join(dir, "config.mjs"), config);
    writeFileSync(join(dir, "wrapper.mjs"), narrowedConfig("./config.mjs", ["src/a.test.ts"]));
    const wrapper: { default: (env: object) => Promise<JsonObject> } = await import(pathToFileURL(join(dir, "wrapper.mjs")).href);
    return await wrapper.default({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Vitest merges a root include into each project's include, so a config with projects would not be
// narrowed.
describe("narrowed vitest config", () => {
  it("narrows a config, given as an object or a function, to the changed tests", async () => {
    for (const config of ['export default { test: { include: ["**/*.test.ts"], setupFiles: ["s.ts"] } };',
      'export default async () => ({ test: { include: ["**/*.test.ts"], setupFiles: ["s.ts"] } });']) {
      assert.deepEqual(await load(config), { test: { include: ["src/a.test.ts"], setupFiles: ["s.ts"] } });
    }
  });

  it("refuses a config with test.projects", async () => {
    await assert.rejects(load('export default { test: { projects: [{ test: { name: "a", include: ["**/*.test.ts"] } }] } };'));
  });
});

describe("proof-tests budget", () => {
  it("reads the budget in whole minutes", () => {
    assert.equal(budgetMinutes(undefined), DEFAULT_BUDGET_MINUTES);
    assert.equal(budgetMinutes(""), DEFAULT_BUDGET_MINUTES);
    assert.equal(budgetMinutes("5"), 5);
    for (const bad of ["0", "-1", "1.5", "ten"]) assert.throws(() => budgetMinutes(bad));
  });

  it("returns the output of a command that finishes in time", async () => {
    const out = await runBounded(process.execPath, ["-e", "process.stdout.write('done')"], ".", Date.now() + 60_000, true);
    assert.equal(out, "done");
  });

  it("rejects a command that exits non-zero", async () => {
    await assert.rejects(runBounded(process.execPath, ["-e", "process.exit(3)"], ".", Date.now() + 60_000),
      (error: Error) => !(error instanceof OverBudget));
  });

  // A real child on the real clock: what is under test is that a running command is killed.
  it("kills a command still running at the deadline and reports OverBudget", async () => {
    const started = Date.now();
    await assert.rejects(runBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ".", started + 300), OverBudget);
    assert.ok(Date.now() - started < 30_000);
  });

  // The command exits at once and leaves a child holding the captured stdout: the deadline, not
  // the pipe closing, has to settle the run.
  for (const detached of [false, true]) {
    it(`settles at the deadline while a ${detached ? "detached " : ""}child holds stdout`, async () => {
      const child = `setTimeout(() => {}, 10000)`;
      const wrapper = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], ` +
        `{ detached: ${detached}, stdio: ["ignore", "inherit", "ignore"] }).unref()`;
      const started = Date.now();
      await assert.rejects(runBounded(process.execPath, ["-e", wrapper], ".", started + 500, true), OverBudget);
      assert.ok(Date.now() - started < 5_000, "settled by the child's exit rather than the deadline");
    });
  }

  it("starts nothing once the deadline has passed", async () => {
    await assert.rejects(runBounded(process.execPath, ["-e", ""], ".", Date.now() - 1), OverBudget);
  });
});
