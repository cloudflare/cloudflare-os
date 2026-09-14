import { expect, it } from "vitest";
import {
  EVAL_AGENT_BUDGET_MS, EVAL_TEST_TIMEOUT_MS, EVAL_VERIFICATION_BUDGET_MS,
} from "./budgets.js";
import { evalMatrix, resolveEvalCommit } from "./config.js";
import { taskVersion, type EvalTask } from "./task.js";

it("leaves an outer margin for setup and cleanup", () => {
  expect(EVAL_TEST_TIMEOUT_MS)
    .toBeGreaterThan(EVAL_AGENT_BUDGET_MS + EVAL_VERIFICATION_BUDGET_MS);
});

it("accepts model and trial overrides", () => {
  expect(evalMatrix({
    WORKSHOP_EVAL_MODELS: " @cf/zai-org/glm-5.2, claude-sonnet-5 ",
    WORKSHOP_EVAL_TRIALS: "3",
  })).toEqual({ models: ["@cf/zai-org/glm-5.2", "claude-sonnet-5"], trials: 3 });
});

it("rejects a model that is not in the catalog", () => {
  expect(() => evalMatrix({ WORKSHOP_EVAL_MODELS: "@cf/zai-org/glm-5.2, model-b" }))
    .toThrow('Unknown eval model "model-b"');
});

it("rejects an invalid trial count", () => {
  expect(() => evalMatrix({ WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
});

const COMMIT = "a".repeat(40);

it("records the checkout commit", () => {
  expect(resolveEvalCommit({ GITHUB_SHA: COMMIT }, () => "unused", () => true)).toBe(COMMIT);
  expect(resolveEvalCommit({}, () => COMMIT, () => false)).toBe(COMMIT);
  expect(() => resolveEvalCommit({}, () => COMMIT, () => true)).toThrow("clean worktree");
  expect(() => resolveEvalCommit({ WORKSHOP_EVAL_COMMIT: "main" }, () => COMMIT, () => false))
    .toThrow("40-character Git SHA");
});

it("versions only the task prompts", () => {
  const task: EvalTask = {
    id: "one",
    turns: [{ prompt: "Build it", verify: () => Promise.resolve() }],
  };
  const version = taskVersion(task);
  expect(version).toMatch(/^[a-f0-9]{64}$/);
  expect(taskVersion({
    ...task,
    turns: [{ prompt: "Build it", verify: async () => { await Promise.resolve(); } }],
  })).toBe(version);
  expect(taskVersion({ ...task, turns: [{ ...task.turns[0], prompt: "Build it better" }] }))
    .not.toBe(version);
});
