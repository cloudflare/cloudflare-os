// A vitest setup file that vitest.ts's runTests copies into the package under test. It records in
// each test's `meta.automergeBody` (vitest.ts BODY_MARK) `failed` when the test's own body threw,
// `passed` when it returned. vitest reports a failing `beforeEach`, `aroundEach` or fixture as a
// failed test whose body never ran, and its JSON report has no other way to tell them apart.
//
// vitest calls the runner's `runTask` in place of the body, after the `beforeEach` hooks, when the
// runner has one; its base runner has none, so this defines it. (`TestRunner.setTestFn` would be
// the direct route, but vitest 5.0.5 binds it to the getter.) A test is left unmarked, which reads
// as unattributed, whenever the mark could not mean "the body ran and this was its outcome":
// - a runner that defines its own `runTask` shadows this one, so nothing is marked;
// - a test that retries or repeats: the mark of an earlier attempt would outlive a later attempt
//   that failed in a hook;
// - a file that defines or overrides fixtures (`test.extend`, `test.override`, `test.scoped`):
//   vitest resolves them inside the function `runTask` calls, so a failing fixture would read as a
//   failing body.
// A mark preset through a test's `meta` option is cleared before any test in the file runs.
// `test.fails` and `expect.soft` invert or defer the outcome, so their marks do not match their
// results and they read as unattributed too.
//
// Not judge code: it runs inside the package's vitest, beside the pull request's tests, so it may
// import vitest. A `.mjs` file keeps it out of the import-policy scan of judge scripts.

import { beforeAll, it, test, TestRunner } from "vitest";

const MARK = "automergeBody";
const FIXTURES = Symbol.for("automerge.fixturesDefined");
const testBody = TestRunner.getTestFn;

// Every derived collector (`test.runIf(…)`, `test.concurrent`, `test.skip`, …) is a new function
// that copies its methods from the original collector, `test.fn`, when it is made. So the flag is
// set on `test.fn` as well as on `test` itself, which was made before this file ran.
for (const api of new Set([test, it])) {
  for (const target of new Set([api, api.fn])) {
    for (const name of ["extend", "override", "scoped"]) {
      const original = target[name];
      if (typeof original !== "function") continue;
      target[name] = function (...args) {
        globalThis[FIXTURES] = true;
        return original.apply(this, args);
      };
    }
  }
}

function clearMarks(task) {
  if (task.type === "test") delete task.meta[MARK];
  for (const child of task.tasks ?? []) clearMarks(child);
}

// vitest 5 passes the hook context first, and parses its pattern for fixtures, so it must be an
// object pattern; the file suite is the second argument.
// oxlint-disable-next-line no-empty-pattern -- vitest rejects any other first parameter.
beforeAll(({}, file) => {
  clearMarks(file);
});

function attempts(count) {
  return typeof count === "number" ? count : (count?.count ?? 0);
}

TestRunner.prototype.runTask = async function (task) {
  const body = testBody(task);
  if (typeof body !== "function") throw new Error("Test function is not found.");
  const markable = attempts(task.retry) === 0 && (task.repeats ?? 0) === 0 && globalThis[FIXTURES] !== true;
  try {
    await body();
  } catch (error) {
    if (markable) task.meta[MARK] = "failed";
    throw error;
  }
  if (markable) task.meta[MARK] = "passed";
};
