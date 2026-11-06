import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { FileDiff } from "./diff.ts";
import { asObject, parseJson, type JsonObject } from "./json.ts";
import {
  budgetMinutes, DEFAULT_BUDGET_MINUTES, editedSupportFiles, evaluateKills, killedMutants, OverBudget,
  planScope, runBounded, sourceGraph,
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

/** A package's files by path, as `sourceGraph` reads them. */
const files = (entries: Record<string, string>) => (path: string) => entries[path];

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

  // Bonk's case on #987: the test imports an index that defines identity() and re-exports
  // double() from double.ts, so double.ts's mutants must be made too.
  it("follows a re-export from the module a test imports", () => {
    const read = files({
      "packages/p/src/index.ts": 'export const identity = (x: number) => x;\nexport { double } from "./double.ts";\n',
      "packages/p/src/double.ts": "export const double = (x: number) => x * 2;\n",
    });
    const test = { path: "packages/p/src/index.test.ts", text: 'import { double, identity } from "./index.ts";\n' };
    assert.deepEqual(sourceGraph([test], "packages/p", read), { sources: ["packages/p/src/double.ts", "packages/p/src/index.ts"], problems: [] });
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
    assert.deepEqual(sourceGraph([{ path: "packages/p/src/x.test.ts", text }], "packages/p", read), {
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
    assert.deepEqual(sourceGraph([test], "packages/p", read).problems, [
      "packages/p/src/index.ts: cannot resolve ./gone.ts",
      "packages/p/src/index.ts: imports packages/q/src/other.ts, outside packages/p",
    ]);
  });

  it("flags edited helpers and fixtures, which unchanged tests may import", () => {
    assert.deepEqual(editedSupportFiles([
      "packages/p/src/a.test.ts", "packages/p/__tests__/helpers.ts", "packages/p/test/fixtures/x.json",
    ]), ["packages/p/__tests__/helpers.ts", "packages/p/test/fixtures/x.json"]);
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
