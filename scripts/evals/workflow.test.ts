import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalKeys } from "./eval-keys.ts";
import { commentsAreCurrent, planOutputs, planRuns, resultsComment, reusableArtifact, staleComments } from "./workflow.ts";

const HOUR = 60 * 60 * 1000;

/** Keys for commits, baseline first, each mapping its tasks to their keys. */
function keysOf(...commits: Record<string, string>[]): EvalKeys {
  return {
    report: "report",
    commits: commits.map((tasks, index) => ({
      sha: `sha${index}`,
      tasks: Object.fromEntries(Object.entries(tasks).map(([task, key]) => [task, { key, definition: "definition" }])),
    })),
  };
}

test("a stored result is reused, and a key both sides share is measured once, by the candidate", () => {
  const plan = planRuns(keysOf({ chess: "a", logs: "b" }, { chess: "a", logs: "c" }), new Map([["logs-b", 7]]));
  assert.deepEqual(plan.sources.map(source =>
    [source.revision, source.task, "artifact" in source ? source.artifact : source.run]), [
    ["baseline", "chess", "candidate"],
    ["baseline", "logs", 7],
    ["candidate", "chess", "candidate"],
    ["candidate", "logs", "candidate"],
  ]);
  assert.deepEqual(plan.legs, [{ revision: "candidate", sha: "sha1", tasks: ["chess", "logs"] }]);
  assert.deepEqual(plan.store.map(({ name }) => name), ["chess-a", "logs-c"]);
});

test("a push measures its one commit as the baseline", () => {
  assert.deepEqual(planRuns(keysOf({ chess: "a" }), new Map()).legs,
    [{ revision: "baseline", sha: "sha0", tasks: ["chess"] }]);
});

test("with nothing to measure there are no legs or store, since an empty matrix fails the run", () => {
  const keys = keysOf({ chess: "a" }, { chess: "a" });
  assert.deepEqual(Object.keys(planOutputs(keys, planRuns(keys, new Map([["chess-a", 7]])), true)),
    ["keys", "sources", "report"]);
});

test("a stored result is reused only if this repository stored it and it outlives the run, newest first", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const artifact = (id: number, createdAt: string, expiresInHours: number, headRepositoryId = 1) => ({
    id,
    expired: false,
    created_at: createdAt,
    expires_at: new Date(now + expiresInHours * HOUR).toISOString(),
    workflow_run: { repository_id: 1, head_repository_id: headRepositoryId },
  });
  assert.equal(reusableArtifact({
    artifacts: [
      artifact(1, "2026-08-02T00:00:00Z", 100),
      artifact(2, "2026-08-03T00:00:00Z", 100),
      artifact(3, "2026-08-01T00:00:00Z", 100),
      artifact(4, "2026-08-04T00:00:00Z", 100, 2),
      artifact(5, "2026-08-05T00:00:00Z", 3),
    ],
  }, now), 2);
});

const at = (hour: number) => `2026-09-01T0${hour}:00:00Z`;
const results = (id: number, hour: number, report?: string) =>
  ({ id, user: { login: "github-actions[bot]" }, created_at: at(hour), body: resultsComment("table", "https://run", report) });
const review = (id: number, hour: number, heading = "## 🔬 Eval runs review") =>
  ({ id, user: { login: "ask-bonk[bot]" }, created_at: at(hour), body: `${heading}\n\nLooks right.` });

test("the posted comments are current only if the newest results comment has this key and a Bonk eval review follows it", () => {
  assert.equal(commentsAreCurrent([results(1, 1, "r1"), review(2, 2)], "r1"), true);
  assert.equal(commentsAreCurrent([results(1, 1, "r1"), review(2, 2)], "r2"), false);
  assert.equal(commentsAreCurrent([results(1, 1), review(2, 2)], "r1"), false);
  assert.equal(commentsAreCurrent([review(2, 0), results(1, 1, "r1")], "r1"), false);
  assert.equal(commentsAreCurrent([results(1, 1, "r1"), review(2, 2, "## Code review")], "r1"), false);
  assert.equal(commentsAreCurrent([results(1, 1, "r1"), results(3, 3, "r0"), review(2, 4)], "r1"), false);
});

test("a new results comment replaces only earlier results comments and Bonk eval reviews", () => {
  const person = { id: 4, user: { login: "someone" }, created_at: at(1), body: resultsComment("quoted", "https://run", "r1") };
  assert.deepEqual(staleComments([
    results(1, 1, "r1"),
    review(2, 2),
    review(3, 3, "## Code review"),
    person,
    review(5, 5, "## Eval runs review"),
  ]), [1, 2, 5]);
});
