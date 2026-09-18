import { createJudge, describeEval } from "vitest-evals";
import { afterAll, beforeAll } from "vitest";
import { evalMatrix, resolveEvalCommit, resolveEvalModel } from "./config.js";
import { createWorkshopHarness } from "./harness.js";
import { taskVersion, type EvalRunInput, type EvalRunOutput, type EvalTask } from "./task.js";
import {
  assertModelAccess, evalNetworkInterceptor, resolveModelAccess, runtimesStillRunning,
} from "./target.js";

const gitCommit = resolveEvalCommit();
const modelAccess = resolveModelAccess();

const FunctionalJudge = createJudge<EvalRunInput, EvalRunOutput>(
  "functional result",
  ({ output }) => {
    const checks = output.turns.flatMap(turn => turn.checks);
    const failed = checks.filter(check => !check.pass);
    const passed = checks.length - failed.length;
    return {
      score: output.success ? 1 : 0,
      metadata: {
        rationale: output.success
          ? "All turns and checks passed"
          : `Failed checks: ${failed.map(check => check.id).join(", ") || "agent turn failed"}`,
        passedChecks: passed,
        totalChecks: checks.length,
        checkFraction: checks.length === 0 ? 0 : passed / checks.length,
        failedChecks: failed.map(check => check.id),
      },
    };
  },
);

/**
 * Register one task as model-by-trial Vitest cases. Trials run concurrently: each boots its own
 * Workshop, so a file finishes in the time of its slowest trial rather than the sum.
 */
export function defineTaskEval(task: EvalTask): void {
  const matrix = evalMatrix();
  const models = matrix.models.map(resolveEvalModel);
  // Fail at collection, before any inference, if the access cannot serve a model in the matrix.
  models.forEach(model => assertModelAccess(modelAccess, model));
  const identity = { gitCommit, taskVersion: taskVersion(task) };
  const harness = createWorkshopHarness(task, modelAccess, identity);
  const network = evalNetworkInterceptor(modelAccess, models);

  describeEval(task.id, { harness }, it => {
    beforeAll(() => network.install());
    // Fail closed: a runtime that would not stop may still run model-authored code through this
    // process's fetch, so unrestricted network access is not restored while one may be alive.
    afterAll(() => {
      if (runtimesStillRunning() === 0) network.uninstall();
    });
    for (const { model } of models) {
      for (let trial = 1; trial <= matrix.trials; trial++) {
        // Concurrent tests must use the context's expect: the judge matcher records its score on
        // the current task, which the global expect cannot identify while trials overlap.
        it.concurrent(`${model} | trial ${trial}`, async ({ run, expect }) => {
          const result = await run({ model, trial });
          await expect(result).toSatisfyJudge(FunctionalJudge, { threshold: 1 });
        });
      }
    }
  });
}
