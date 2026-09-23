import { expect, it } from "vitest";
import { compareEvalResults, renderEvalComparison, validateEvalResults } from "./comparison.js";

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
  checks?: { id: string; pass: boolean; evidence?: string }[];
  events?: object[];
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
    checks = [],
    events = [],
  } = options;
  return {
    status,
    duration,
    meta: {
      harness: {
        run: {
          session: { metadata: { taskId, taskVersion, gitCommit }, events },
          usage: {
            model: MODEL,
            metadata: cost === undefined ? {} : { observedCumulativeChatCostUsd: cost },
          },
          output: {
            metrics: { modelTurns, toolCalls, toolErrors },
            turns: [{ outcome: { status: outcomeStatus }, checks }],
          },
          errors,
        },
      },
    },
  };
}

function report(
    assertions: ReturnType<typeof trial>[],
    ...emptyFiles: { name: string; message: string }[]): string {
  return JSON.stringify({ testResults: [
    { name: "/evals/project-doc.eval.ts", assertionResults: assertions },
    ...emptyFiles.map(file => ({ ...file, assertionResults: [] })),
  ] });
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
  const noFailures = { failedChecks: [], toolErrors: [], infrastructureErrors: [] };
  expect(comparison.verdict).toBe("unchanged");
  expect(comparison.rows).toEqual([{
    taskId: "project-doc",
    model: MODEL,
    reason: null,
    pValue: expect.closeTo(1),
    baseline: {
      trials: 3,
      passed: 2,
      meanDurationMs: 200,
      meanModelTurns: 2,
      meanToolCalls: 3,
      meanToolErrors: 1 / 3,
      meanCostUsd: (0.1 + 0.2 + 0.3) / 3,
      ...noFailures,
    },
    candidate: {
      trials: 3,
      passed: 3,
      meanDurationMs: 300,
      meanModelTurns: 2,
      meanToolCalls: 3,
      meanToolErrors: 0,
      meanCostUsd: (0.2 + 0.3 + 0.4) / 3,
      ...noFailures,
    },
  }]);
  const markdown = renderEvalComparison(comparison);
  expect(markdown).toContain("**Verdict: \u26AA Unchanged.**");
  // Two of three trials is two thirds, which rounds to seven of ten cells. A 33 pp rise over three
  // trials is noise, so it gets no colour.
  expect(markdown).toContain(
    `| project-doc | ${"\u{1F7E9}".repeat(7)}${"\u{1F7E5}".repeat(3)} 2/3 | ${"\u{1F7E9}".repeat(10)} 3/3 | ` +
    "\u26AA +33 pp | +0.1 s | \u22120.3 | +$0.100 |");
});

it("calls a significant fall a regression and a small one noise", () => {
  const passes = (passed: number, gitCommit: string) => report(Array.from({ length: 10 }, (_, index) =>
    trial({ gitCommit, status: index < passed ? "passed" : "failed" })));
  const fell = compareEvalResults(passes(9, BASE_SHA), passes(3, HEAD_SHA));
  expect(fell.verdict).toBe("regressed");
  expect(renderEvalComparison(fell)).toContain("\u{1F534} \u221260 pp (p = 0.02)");
  expect(compareEvalResults(passes(9, BASE_SHA), passes(7, HEAD_SHA)).verdict).toBe("unchanged");
  expect(compareEvalResults(passes(3, BASE_SHA), passes(9, HEAD_SHA)).verdict).toBe("improved");
});

it("reports what failed, quoting trial text so it cannot inject markup", () => {
  const failed = (evidence: string) => trial({
    gitCommit: HEAD_SHA, status: "failed",
    checks: [{ id: "shows-the-target", pass: false, evidence }, { id: "builds", pass: true }],
    events: [
      { type: "tool_call", id: "1", name: "createGadget" },
      { type: "tool_result", toolCallId: "1", name: "createGadget",
        error: { name: "Error", message: "Key `@here` is empty\nat kv.get" } },
    ],
  });
  const comparison = compareEvalResults(report([trial(), trial()]),
    report([failed("`@here` shown $40M"), failed("again")]));
  const { candidate } = comparison.rows[0];
  expect(candidate?.failedChecks).toEqual([
    { check: "t1 shows-the-target", trials: 2, evidence: JSON.stringify("`@here` shown $40M") },
  ]);
  expect(candidate?.toolErrors).toEqual(
    [{ tool: "createGadget", message: "Key `@here` is empty", count: 2 }]);
  const markdown = renderEvalComparison(comparison);
  expect(markdown).toContain("| `t1 shows-the-target` | 0 | 2 |");
  expect(markdown).toContain("`createGadget` `Key '@here' is empty` \u00d72");
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

  expect(compareEvalResults(baselineError, candidateAgentFailure).rows[0].reason)
    .toBe("baseline run errors");
  expect(compareEvalResults(baseline, candidateInfrastructure).rows[0].reason)
    .toBe("candidate run errors");
  expect(compareEvalResults(baseline, candidateAgentFailure).rows[0]).toMatchObject({
    reason: null,
    candidate: { trials: 3, passed: 1 },
  });
});

it("does not compare changed tasks or unequal trial counts", () => {
  const baseline = report([trial(), trial(), trial()]);
  const changed = report([
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
    trial({ gitCommit: HEAD_SHA, taskVersion: "changed" }),
  ]);
  const shorter = report([
    trial({ gitCommit: HEAD_SHA }),
    trial({ gitCommit: HEAD_SHA }),
  ]);

  expect(compareEvalResults(baseline, changed).rows[0].reason).toBe("task version changed");
  const asked: string[][] = [];
  expect(compareEvalResults(baseline, changed, {
    definitionsChanged: (...shas) => {
      asked.push(shas);
      return true;
    },
  }).rows[0].reason).toBe("eval definition changed");
  expect(asked).toEqual([[BASE_SHA, HEAD_SHA]]);
  expect(compareEvalResults(baseline, shorter).rows[0].reason).toBe("run counts differ");
});

it("accepts a complete baseline with agent failures but not infrastructure failures", () => {
  const complete = report([
    trial(),
    trial({ status: "failed", errors: [{ name: "AgentError", message: "Agent stopped." }] }),
    trial({ taskId: "expense-ledger" }),
    trial({ taskId: "expense-ledger" }),
  ]);
  const short = report([trial(), trial(), trial({ taskId: "expense-ledger" })]);
  const infrastructure = report([
    trial(),
    trial({ status: "failed", errors: [{ name: "EvalRunError", message: "Verifier failed." }] }),
  ]);
  const mixedCommits = report([trial(), trial({ gitCommit: HEAD_SHA })]);
  const uncollected = report(
    [trial(), trial()],
    { name: "/evals/appointment-desk.eval.ts", message: "Cannot find module './verifier.js'" });

  expect(() => validateEvalResults(complete, 2)).not.toThrow();
  expect(() => validateEvalResults(short, 2)).toThrow("expense-ledger on");
  expect(() => validateEvalResults(infrastructure, 2)).toThrow("infrastructure failures");
  expect(() => validateEvalResults(mixedCommits, 2)).toThrow("inconsistent commits");
  expect(() => validateEvalResults(uncollected, 2))
    .toThrow("appointment-desk.eval.ts ran no trials: Cannot find module");
});

it("rejects malformed reports", () => {
  expect(() => compareEvalResults("not json", report([trial()])))
    .toThrow("baseline results are not valid JSON");
  expect(() => compareEvalResults("{}", report([trial()])))
    .toThrow("baseline results are invalid");
});
