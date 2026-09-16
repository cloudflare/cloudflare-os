import { createJudge, describeEval } from "vitest-evals";
import { expect } from "vitest";
import { evalMatrix, resolveEvalCommit, resolveEvalModel } from "./config.js";
import { createWorkshopHarness } from "./harness.js";
import { taskVersion, type EvalRunInput, type EvalRunOutput, type EvalTask } from "./task.js";
import { assertModelAccess, resolveModelAccess } from "./target.js";

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

/** Register one task as model-by-trial Vitest cases. */
export function defineTaskEval(task: EvalTask): void {
  const matrix = evalMatrix();
  // Fail at collection, before any inference, if the access cannot serve a model in the matrix.
  matrix.models.map(resolveEvalModel).forEach(model => assertModelAccess(modelAccess, model));
  const cases = matrix.models.flatMap(model =>
    Array.from({ length: matrix.trials }, (_unused, trial) => ({
      name: `${model} | trial ${trial + 1}`,
      model,
      trial: trial + 1,
    })));
  const identity = { gitCommit, taskVersion: taskVersion(task) };
  const harness = createWorkshopHarness(task, modelAccess, identity);

  describeEval(task.id, { harness }, it => {
    it.for(cases)("$name", async ({ model, trial }, { run }) => {
      const result = await run({ model, trial });
      await expect(result).toSatisfyJudge(FunctionalJudge, { threshold: 1 });
    });
  });
}
