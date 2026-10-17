import { expect, it } from "vitest";
import {
  EVAL_AGENT_BUDGET_MS, EVAL_TEST_TIMEOUT_MS, EVAL_VERIFICATION_BUDGET_MS,
} from "./budgets.js";
import { evalMatrix, evalModels, resolveEvalCommit } from "./config.js";
import { taskVersion, type EvalTask } from "./task.js";

it("leaves an outer margin for setup and cleanup", () => {
  expect(EVAL_TEST_TIMEOUT_MS)
    .toBeGreaterThan(EVAL_AGENT_BUDGET_MS + EVAL_VERIFICATION_BUDGET_MS);
});

it("accepts model and trial overrides", () => {
  expect(evalMatrix("one", {
    WORKSHOP_EVAL_MODELS: " @cf/zai-org/glm-5.2, claude-sonnet-5 ",
    WORKSHOP_EVAL_TRIALS: "3",
  })).toEqual({ models: ["@cf/zai-org/glm-5.2", "claude-sonnet-5"], trials: 3 });
});

it("rejects a model that is not in the catalog", () => {
  expect(() => evalMatrix("one", { WORKSHOP_EVAL_MODELS: "@cf/zai-org/glm-5.2, model-b" }))
    .toThrow('Unknown eval model "model-b"');
});

it("rejects an invalid trial count", () => {
  expect(() => evalMatrix("one", { WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
});

const RUN = { WORKSHOP_EVAL_MODELS: "claude-sonnet-5", WORKSHOP_EVAL_TRIALS: "3" };

function withOverrides(overrides: unknown): NodeJS.ProcessEnv {
  return { ...RUN, WORKSHOP_EVAL_TASK_OVERRIDES: JSON.stringify(overrides) };
}

it("replaces only the fields a task override gives", () => {
  const environment = withOverrides({
    models: { models: ["@cf/zai-org/glm-5.2", "gpt-6-luna"] },
    trials: { trials: 7 },
    both: { models: ["@cf/zai-org/glm-5.2"], trials: 2 },
  });
  expect(evalMatrix("models", environment))
    .toEqual({ models: ["@cf/zai-org/glm-5.2", "gpt-6-luna"], trials: 3 });
  expect(evalMatrix("trials", environment)).toEqual({ models: ["claude-sonnet-5"], trials: 7 });
  expect(evalMatrix("both", environment)).toEqual({ models: ["@cf/zai-org/glm-5.2"], trials: 2 });
  expect(evalMatrix("other", environment)).toEqual({ models: ["claude-sonnet-5"], trials: 3 });
});

it("lists every model the run or an override names", () => {
  expect(evalModels(withOverrides({
    one: { models: ["@cf/zai-org/glm-5.2", "claude-sonnet-5"] },
    two: { trials: 2 },
  }))).toEqual(["claude-sonnet-5", "@cf/zai-org/glm-5.2"]);
});

it("rejects an invalid task override, even for another task", () => {
  expect(() => evalMatrix("one", { ...RUN, WORKSHOP_EVAL_TASK_OVERRIDES: "{one:" }))
    .toThrow("WORKSHOP_EVAL_TASK_OVERRIDES is not valid JSON");
  expect(() => evalMatrix("one", withOverrides(["one"])))
    .toThrow("WORKSHOP_EVAL_TASK_OVERRIDES is invalid: ✖ Invalid input: expected record");
  for (const [overrides, message] of [
    [{ other: { model: ["claude-sonnet-5"] } }, 'Unrecognized key: "model"\n  → at other'],
    [{ other: { models: [] } }, "expected array to have >=1 items\n  → at other.models"],
    [{ other: { trials: 1.5 } }, "expected int, received number\n  → at other.trials"],
    [{ other: { trials: 0 } }, "expected number to be >0\n  → at other.trials"],
    [{ other: { models: ["model-b"] } }, 'Unknown eval model "model-b"'],
  ] as const) {
    expect(() => evalMatrix("one", withOverrides(overrides))).toThrow(message);
  }
  expect(() => evalModels(withOverrides({ other: { trials: 0 } }))).toThrow("at other.trials");
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
