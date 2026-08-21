import { createJudge } from "vitest-evals";
import type { EvalRunInput, EvalRunOutput } from "./task.js";

/**
 * Scores a run on the fraction of its deterministic checks that passed.
 *
 * The score is reproducible: it depends only on what the agent built and what the task asserted,
 * so a change in the number tracks a change in the agent rather than in a grader. Partial credit is
 * reported because a frontier task that satisfies most of a contract is meaningfully closer than
 * one that satisfies none, while `EvalRunOutput.passed` remains the all-or-nothing verdict.
 */
export const ChecksScorer = createJudge<EvalRunInput, EvalRunOutput>("checks", ({ output }) => {
  const checks = output.turns.flatMap(turn => turn.checks);
  if (checks.length === 0) {
    return { score: null, metadata: { rationale: `task ${output.taskId} recorded no checks` } };
  }
  const failed = checks.filter(check => !check.pass);
  // An error posted into chat history means the turn died rather than finishing: the model stream
  // was cut, the provider refused, the server restarted mid-turn. The platform does not post one for
  // running out of turns or for giving up, so these are almost always infrastructure.
  //
  // It only confounds the result when the trial also failed, because then it is impossible to say
  // whether the agent or the outage caused it — so that trial is left unscored, and shows up as
  // invalid. A trial that passed regardless is scored normally: the agent evidently delivered.
  if (failed.length > 0 && output.diagnostics.agentErrors.length > 0) {
    return {
      score: null,
      metadata: {
        rationale: "the turn ended with an error, so its failures cannot be attributed to the agent",
        agentErrors: output.diagnostics.agentErrors,
        failed: failed.map(check => check.id),
      },
    };
  }
  return {
    score: (checks.length - failed.length) / checks.length,
    metadata: {
      rationale: failed.length === 0
        ? `all ${checks.length} checks passed`
        : `${failed.length} of ${checks.length} checks failed: ` +
          failed.map(check => check.id).join(", "),
      failed: failed.map(check => ({ id: check.id, evidence: check.evidence ?? null })),
    },
  };
});
