import { expect, it } from "vitest";
import { compareEvalResults, renderEvalComparison } from "./comparison.js";

const MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const VERSION = "c".repeat(64);

type TrialOptions = {
  taskId?: string;
  taskVersion?: string;
  gitCommit?: string;
  status?: "passed" | "failed";
  duration?: number;
  modelTurns?: number;
  toolCalls?: number;
  toolErrors?: number;
  cost?: number;
  errors?: { name: string; message: string }[];
  outcomeStatus?: "completed" | "error" | "timedOut" | "cancelled";
};

function trial(options: TrialOptions = {}) {
  const {
    taskId = "project-doc",
    taskVersion = VERSION,
    gitCommit = BASE_SHA,
    status = "passed",
    duration = 100,
    modelTurns = 2,
    toolCalls = 3,
    toolErrors = 0,
    cost,
    errors = [],
    outcomeStatus = "completed",
  } = options;
  return {
    status,
    duration,
    meta: {
      harness: {
        run: {
          session: { metadata: { taskId, taskVersion, gitCommit } },
          usage: {
            model: MODEL,
            metadata: cost === undefined ? {} : { observedCumulativeChatCostUsd: cost },
          },
          output: {
            metrics: { modelTurns, toolCalls, toolErrors },
            turns: [{ outcome: { status: outcomeStatus } }],
          },
          errors,
        },
      },
    },
  };
}

function report(assertions: ReturnType<typeof trial>[]): string {
  return JSON.stringify({ testResults: [{ assertionResults: assertions }] });
}

it("compares three-trial task cohorts", () => {
  const baseline = report([
    trial({ status: "passed", duration: 100, cost: 0.1 }),
    trial({ status: "failed", duration: 200, toolErrors: 1, cost: 0.2 }),
    trial({ status: "passed", duration: 300, cost: 0.3 }),
  ]);
  const candidate = report([
    trial({ gitCommit: HEAD_SHA, duration: 200, cost: 0.2 }),
    trial({ gitCommit: HEAD_SHA, duration: 300, cost: 0.3 }),
    trial({ gitCommit: HEAD_SHA, duration: 400, cost: 0.4 }),
  ]);

  const comparison = compareEvalResults(baseline, candidate);

  expect(comparison.baselineSha).toBe(BASE_SHA);
  expect(comparison.candidateSha).toBe(HEAD_SHA);
  expect(comparison.rows).toEqual([{
    taskId: "project-doc",
    model: MODEL,
    comparable: true,
    reason: null,
    baseline: {
      trials: 3,
      passed: 2,
      passRate: 2 / 3,
      meanDurationMs: 200,
      meanModelTurns: 2,
      meanToolCalls: 3,
      meanToolErrors: 1 / 3,
      meanCostUsd: (0.1 + 0.2 + 0.3) / 3,
    },
    candidate: {
      trials: 3,
      passed: 3,
      passRate: 1,
      meanDurationMs: 300,
      meanModelTurns: 2,
      meanToolCalls: 3,
      meanToolErrors: 0,
      meanCostUsd: (0.2 + 0.3 + 0.4) / 3,
    },
    passRateDelta: 1 - 2 / 3,
  }]);
  expect(renderEvalComparison(comparison)).toContain("+33.3 pp");
});

it("does not compare costs from different trial populations", () => {
  const baseline = report([trial({ cost: 0.1 }), trial(), trial({ cost: 0.3 })]);
  const candidate = report([
    trial({ gitCommit: HEAD_SHA, cost: 0.2 }),
    trial({ gitCommit: HEAD_SHA, cost: 0.3 }),
    trial({ gitCommit: HEAD_SHA, cost: 0.4 }),
  ]);

  const row = compareEvalResults(baseline, candidate).rows[0];
  expect(row.baseline?.meanCostUsd).toBeNull();
  expect(row.candidate?.meanCostUsd).toBeCloseTo(0.3);
});

it("separates infrastructure errors from failed agent outcomes", () => {
  const baselineError = report([
    trial({ errors: [{ name: "EvalCleanupError", message: "Cleanup failed." }] }),
    trial(),
    trial(),
  ]);
  const baseline = report([trial(), trial(), trial()]);
  const candidateInfrastructure = report([
    trial({ gitCommit: HEAD_SHA, status: "failed", errors: [{
      name: "EvalRunError", message: "Verifier failed.",
    }] }),
    trial({ gitCommit: HEAD_SHA }),
    trial({ gitCommit: HEAD_SHA }),
  ]);
  const candidateAgentFailure = report([
    trial({ gitCommit: HEAD_SHA, status: "failed", errors: [{
      name: "AgentError", message: "Agent stopped.",
    }] }),
    trial({ gitCommit: HEAD_SHA, status: "failed", outcomeStatus: "timedOut", errors: [{
      name: "AgentTimeout", message: "Agent timed out.",
    }, {
      name: "EvalRunError", message: "Agent timed out.",
    }] }),
    trial({ gitCommit: HEAD_SHA }),
  ]);

  expect(compareEvalResults(baselineError, candidateAgentFailure).rows[0]).toMatchObject({
    comparable: false,
    reason: "baseline run errors",
    passRateDelta: null,
  });
  expect(compareEvalResults(baseline, candidateInfrastructure).rows[0]).toMatchObject({
    comparable: false,
    reason: "candidate run errors",
    passRateDelta: null,
  });
  expect(compareEvalResults(baseline, candidateAgentFailure).rows[0]).toMatchObject({
    comparable: true,
    reason: null,
    passRateDelta: 1 / 3 - 1,
  });
});

it("does not compare changed or incomplete tasks", () => {
  const baseline = report([trial(), trial(), trial()]);
  const changed = report([
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
  ]);
  const incomplete = report([
    trial({ gitCommit: HEAD_SHA }),
    trial({ gitCommit: HEAD_SHA }),
  ]);

  expect(compareEvalResults(baseline, changed).rows[0]).toMatchObject({
    comparable: false,
    reason: "task version changed",
    passRateDelta: null,
  });
  expect(compareEvalResults(baseline, changed, true).rows[0]).toMatchObject({
    comparable: false,
    reason: "eval definition changed",
    passRateDelta: null,
  });
  expect(compareEvalResults(baseline, incomplete).rows[0]).toMatchObject({
    comparable: false,
    reason: "incomplete candidate",
    passRateDelta: null,
  });
});

it("rejects malformed reports", () => {
  expect(() => compareEvalResults("not json", report([trial()])))
    .toThrow("baseline results are not valid JSON");
  expect(() => compareEvalResults("{}", report([trial()])))
    .toThrow("baseline results are invalid");
});
