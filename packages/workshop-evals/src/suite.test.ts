import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, evalMatrix, expandRuns, type EvalMatrix } from "./suite.js";
import { defineEvalTask, type EvalTask } from "./task.js";

function task(id: string): EvalTask {
  return {
    id,
    title: id,
    expectation: "required",
    turns: [{ prompt: "build it", verify: async () => {} }],
  };
}

const matrix: EvalMatrix = {
  models: ["model-a", "model-b"],
  trials: 2,
  runId: "run",
  shard: undefined,
};

describe("evalMatrix", () => {
  it("falls back to the default models", () => {
    expect(evalMatrix({ WORKSHOP_EVAL_RUN_ID: "r" }).models).toEqual(DEFAULT_MODELS);
  });

  it("reads a comma-separated model list, ignoring blanks", () => {
    expect(evalMatrix({ WORKSHOP_EVAL_MODELS: " a , ,b " }).models).toEqual(["a", "b"]);
  });

  it("rejects a non-positive trial count", () => {
    expect(() => evalMatrix({ WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
    expect(() => evalMatrix({ WORKSHOP_EVAL_TRIALS: "two" })).toThrow("positive integer");
  });

  it("rejects a malformed shard", () => {
    expect(() => evalMatrix({ WORKSHOP_EVAL_SHARD: "3/2" })).toThrow("WORKSHOP_EVAL_SHARD");
    expect(() => evalMatrix({ WORKSHOP_EVAL_SHARD: "1" })).toThrow("WORKSHOP_EVAL_SHARD");
  });

  it("accepts a well-formed shard", () => {
    expect(evalMatrix({ WORKSHOP_EVAL_SHARD: "2/4" }).shard).toEqual({ index: 2, total: 4 });
  });
});

describe("expandRuns", () => {
  it("covers every task, model, and trial with a unique run ID", () => {
    const runs = expandRuns([task("one"), task("two")], matrix);
    expect(runs).toHaveLength(8);
    expect(new Set(runs.map(run => run.input.runId)).size).toBe(8);
    expect(runs[0]?.name).toBe("model-a | trial 1");
  });

  it("partitions runs across shards without loss or overlap", () => {
    const tasks = [task("one"), task("two"), task("three")];
    const all = expandRuns(tasks, matrix).map(run => run.input.runId);
    const sharded = [1, 2, 3].flatMap(index =>
      expandRuns(tasks, { ...matrix, shard: { index, total: 3 } }).map(run => run.input.runId));
    expect(sharded.toSorted()).toEqual(all.toSorted());
    expect(new Set(sharded).size).toBe(all.length);
  });
});

describe("defineEvalTask", () => {
  it("returns a valid task", () => {
    expect(defineEvalTask(task("reading-list")).id).toBe("reading-list");
  });

  it("rejects an ID that is not kebab-case", () => {
    expect(() => defineEvalTask(task("Reading List"))).toThrow("kebab-case");
  });

  it("rejects an empty prompt", () => {
    expect(() => defineEvalTask({
      ...task("empty"),
      turns: [{ prompt: "  ", verify: async () => {} }],
    })).toThrow("empty prompt");
  });
});
