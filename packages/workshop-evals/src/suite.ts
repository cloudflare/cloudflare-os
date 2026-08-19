import { randomUUID } from "node:crypto";
import { describe, expect, it as test } from "vitest";
import { describeEval } from "vitest-evals";
import { createWorkshopHarness } from "./harness.js";
import { ChecksScorer } from "./scorer.js";
import type { EvalRunInput, EvalTask } from "./task.js";

/** Workers AI models exercised when `WORKSHOP_EVAL_MODELS` is unset. */
export const DEFAULT_MODELS = ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"];

const DEFAULT_TRIALS = 3;

/** Which models to run, how many times, and which slice of the result this process owns. */
export type EvalMatrix = {
  /** Agent models to exercise. */
  models: string[];
  /** Repetitions per task and model. Repetition is the only way to see a flaky agent. */
  trials: number;
  /** Prefix making each repetition's identifier unique, which is how the summary detects a report
   * it has already counted. */
  runId: string;
  /** One-based slice of the expanded run list, when the caller is sharding across CI jobs. */
  shard: { index: number; total: number } | undefined;
};

function parseTrials(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TRIALS;
  const trials = Number(raw);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`WORKSHOP_EVAL_TRIALS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return trials;
}

function parseShard(raw: string | undefined): EvalMatrix["shard"] {
  if (raw === undefined) return undefined;
  const [index, total] = raw.split("/").map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(total) ||
      index === undefined || total === undefined || total < 1 || index < 1 || index > total) {
    throw new Error(`WORKSHOP_EVAL_SHARD must be "<index>/<total>", got ${JSON.stringify(raw)}`);
  }
  return { index, total };
}

/** Reads the run matrix from the environment, failing loudly on a malformed setting. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env): EvalMatrix {
  const models = (environment.WORKSHOP_EVAL_MODELS ?? "")
      .split(",").map(model => model.trim()).filter(model => model !== "");
  return {
    models: models.length > 0 ? models : DEFAULT_MODELS,
    trials: parseTrials(environment.WORKSHOP_EVAL_TRIALS),
    runId: environment.WORKSHOP_EVAL_RUN_ID ?? randomUUID(),
    shard: parseShard(environment.WORKSHOP_EVAL_SHARD),
  };
}

/** One repetition of one task against one model. */
export type EvalRun = {
  /** Task being repeated. */
  task: EvalTask;
  /** Report and test name. */
  name: string;
  /** Harness input. */
  input: EvalRunInput;
};

/**
 * Expands the matrix into individual runs, keeping a shard's slice.
 *
 * Sharding is round-robin over the expanded list rather than Vitest's file-level `--shard`, because
 * a suite is one file per expectation: splitting by file would leave most CI jobs idle.
 */
export function expandRuns(tasks: readonly EvalTask[], matrix: EvalMatrix): EvalRun[] {
  const runs: EvalRun[] = [];
  for (const task of tasks) {
    for (const model of matrix.models) {
      for (let trial = 0; trial < matrix.trials; trial++) {
        runs.push({
          task,
          name: `${model} | trial ${trial + 1}`,
          input: { model, trial, runId: `${matrix.runId}:${task.id}:${model}:${trial}` },
        });
      }
    }
  }
  const shard = matrix.shard;
  return shard === undefined
    ? runs
    : runs.filter((_run, index) => index % shard.total === shard.index - 1);
}

/**
 * Registers every repetition of the given tasks as a Vitest eval.
 *
 * A required task fails its test when any check fails; a frontier task records its score without
 * failing, so tracking capability the agent does not yet have never blocks a merge.
 */
export function defineEvalSuite(
    tasks: readonly EvalTask[], matrix: EvalMatrix = evalMatrix()): void {
  const runs = expandRuns(tasks, matrix);
  if (runs.length === 0) {
    // A shard with no slice of the matrix is normal at low trial counts. Registering nothing would
    // exit non-zero for "no tests found", which is indistinguishable from a real eval failure.
    describe("workshop evals", () => {
      test.skip(`no runs in shard ${matrix.shard?.index}/${matrix.shard?.total}`, () => {});
    });
    return;
  }
  for (const { task, name, input } of runs) {
    describeEval(task.id, { harness: createWorkshopHarness(task) }, it => {
      it(name, async ({ run }) => {
        const result = await run(input);
        await expect(result).toSatisfyJudge(ChecksScorer, {
          threshold: task.expectation === "required" ? 1 : null,
        });
      });
    });
  }
}
