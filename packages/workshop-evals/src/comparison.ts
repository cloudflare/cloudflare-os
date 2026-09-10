import { z } from "zod";
import type { JsonValue } from "vitest-evals";

const MetricsSchema = z.object({
  modelTurns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolErrors: z.number().int().nonnegative(),
});

const AssertionSchema = z.object({
  status: z.enum(["passed", "failed"]),
  duration: z.number().nonnegative(),
  meta: z.object({
    harness: z.object({
      run: z.object({
        session: z.object({
          metadata: z.object({
            taskId: z.string().min(1),
            taskVersion: z.string().min(1),
            gitCommit: z.string().min(1),
          }).loose(),
        }).loose(),
        usage: z.object({
          model: z.string().min(1),
          metadata: z.object({
            observedCumulativeChatCostUsd: z.number().nonnegative().optional(),
          }).loose(),
        }).loose(),
        output: z.object({
          metrics: MetricsSchema,
          turns: z.array(z.object({
            outcome: z.object({ status: z.string() }).loose(),
          }).loose()),
        }).loose(),
        errors: z.array(z.object({
          name: z.string(),
          message: z.string(),
        }).loose()),
      }).loose(),
    }).loose(),
  }).loose(),
}).loose();

const ResultsSchema = z.object({
  testResults: z.array(z.object({ assertionResults: z.array(AssertionSchema) }).loose()),
}).loose();

type Assertion = z.infer<typeof AssertionSchema>;

export type EvalStats = {
  trials: number;
  passed: number;
  passRate: number;
  meanDurationMs: number;
  meanModelTurns: number;
  meanToolCalls: number;
  meanToolErrors: number;
  meanCostUsd: number | null;
};

export type EvalComparisonRow = {
  taskId: string;
  model: string;
  comparable: boolean;
  reason: string | null;
  baseline: EvalStats | null;
  candidate: EvalStats | null;
  passRateDelta: number | null;
};

export type EvalComparison = {
  schemaVersion: 1;
  baselineSha: string;
  candidateSha: string;
  rows: EvalComparisonRow[];
};

type Cohort = {
  taskId: string;
  model: string;
  taskVersion: string;
  assertions: Assertion[];
};

const EXPECTED_TRIALS = 3;

function parseResults(name: string, text: string): Assertion[] {
  let raw: JsonValue;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} results are not valid JSON`, { cause: error });
  }
  const parsed = ResultsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${name} results are invalid: ${z.prettifyError(parsed.error)}`);
  }
  const assertions = parsed.data.testResults.flatMap(result => result.assertionResults);
  if (assertions.length === 0) throw new Error(`${name} results contain no evals`);
  return assertions;
}

function cohortKey(taskId: string, model: string): string {
  return JSON.stringify([taskId, model]);
}

function group(assertions: Assertion[]): Map<string, Cohort> {
  const cohorts = new Map<string, Cohort>();
  for (const assertion of assertions) {
    const run = assertion.meta.harness.run;
    const { taskId, taskVersion } = run.session.metadata;
    const { model } = run.usage;
    const key = cohortKey(taskId, model);
    const cohort = cohorts.get(key);
    if (cohort === undefined) {
      cohorts.set(key, { taskId, model, taskVersion, assertions: [assertion] });
    } else {
      if (cohort.taskVersion !== taskVersion) {
        throw new Error(`${taskId} has inconsistent task versions`);
      }
      cohort.assertions.push(assertion);
    }
  }
  return cohorts;
}

function singleCommit(name: string, assertions: Assertion[]): string {
  const commits = new Set(assertions.map(
      assertion => assertion.meta.harness.run.session.metadata.gitCommit));
  if (commits.size !== 1) throw new Error(`${name} results have inconsistent commits`);
  const commit = commits.values().next().value;
  if (commit === undefined) throw new Error(`${name} results have no commit`);
  return commit;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stats(assertions: Assertion[]): EvalStats {
  const costs = assertions.flatMap(assertion => {
    const cost = assertion.meta.harness.run.usage.metadata.observedCumulativeChatCostUsd;
    return cost === undefined ? [] : [cost];
  });
  const metrics = assertions.map(assertion => assertion.meta.harness.run.output.metrics);
  const passed = assertions.filter(assertion => assertion.status === "passed").length;
  return {
    trials: assertions.length,
    passed,
    passRate: passed / assertions.length,
    meanDurationMs: mean(assertions.map(assertion => assertion.duration)),
    meanModelTurns: mean(metrics.map(value => value.modelTurns)),
    meanToolCalls: mean(metrics.map(value => value.toolCalls)),
    meanToolErrors: mean(metrics.map(value => value.toolErrors)),
    meanCostUsd: costs.length === assertions.length ? mean(costs) : null,
  };
}


function hasInfrastructureFailure(assertion: Assertion): boolean {
  const run = assertion.meta.harness.run;
  if (run.output.turns.some(turn =>
    turn.outcome.status === "error" || turn.outcome.status === "cancelled")) return true;
  const names = new Set(run.errors.map(error => error.name));
  if (names.has("EvalCleanupError")) return true;
  const hasAgentOutcome = names.has("AgentError") || names.has("AgentTimeout");
  return names.has("EvalRunError") && !hasAgentOutcome;
}
/** Compare baseline and candidate Vitest eval reports. */
export function compareEvalResults(
    baselineText: string, candidateText: string, definitionsChanged = false): EvalComparison {
  const baselineAssertions = parseResults("baseline", baselineText);
  const candidateAssertions = parseResults("candidate", candidateText);
  const baseline = group(baselineAssertions);
  const candidate = group(candidateAssertions);
  const keys = new Set([...baseline.keys(), ...candidate.keys()]);
  const rows = [...keys].map(key => {
    const base = baseline.get(key);
    const next = candidate.get(key);
    const baseStats = base === undefined ? null : stats(base.assertions);
    const nextStats = next === undefined ? null : stats(next.assertions);
    let reason: string | null = null;
    if (base === undefined) reason = "missing baseline";
    else if (next === undefined) reason = "missing candidate";
    else if (definitionsChanged) reason = "eval definition changed";
    else if (base.taskVersion !== next.taskVersion) reason = "task version changed";
    else if (base.assertions.length !== EXPECTED_TRIALS) reason = "incomplete baseline";
    else if (next.assertions.length !== EXPECTED_TRIALS) reason = "incomplete candidate";
    else if (base.assertions.some(hasInfrastructureFailure)) reason = "baseline run errors";
    else if (next.assertions.some(hasInfrastructureFailure)) reason = "candidate run errors";
    return {
      taskId: base?.taskId ?? next?.taskId ?? "",
      model: base?.model ?? next?.model ?? "",
      comparable: reason === null,
      reason,
      baseline: baseStats,
      candidate: nextStats,
      passRateDelta: reason === null && baseStats !== null && nextStats !== null
        ? nextStats.passRate - baseStats.passRate
        : null,
    };
  }).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model));
  return {
    schemaVersion: 1,
    baselineSha: singleCommit("baseline", baselineAssertions),
    candidateSha: singleCommit("candidate", candidateAssertions),
    rows,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function side(value: EvalStats | null): string {
  return value === null ? "—" : `${value.passed}/${value.trials} (${percent(value.passRate)})`;
}

function signed(value: number, suffix: string): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
}

/** Render a concise GitHub Check summary. */
export function renderEvalComparison(comparison: EvalComparison): string {
  const lines = [
    "# Workshop eval comparison",
    "",
    `Baseline \`${comparison.baselineSha}\` vs candidate \`${comparison.candidateSha}\`.`,
    "",
    "| Task | Baseline | Candidate | Pass-rate delta | Duration delta | Tool-error delta | Cost delta |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of comparison.rows) {
    if (!row.comparable || row.baseline === null || row.candidate === null) {
      lines.push(`| ${row.taskId} | ${side(row.baseline)} | ${side(row.candidate)} | ${row.reason} | — | — | — |`);
      continue;
    }
    const costDelta = row.baseline.meanCostUsd === null || row.candidate.meanCostUsd === null
      ? "—"
      : `${row.candidate.meanCostUsd - row.baseline.meanCostUsd >= 0 ? "+" : ""}$${
        (row.candidate.meanCostUsd - row.baseline.meanCostUsd).toFixed(4)}`;
    lines.push(`| ${row.taskId} | ${side(row.baseline)} | ${side(row.candidate)} | ${
      signed((row.passRateDelta ?? 0) * 100, " pp")} | ${
      signed(row.candidate.meanDurationMs - row.baseline.meanDurationMs, " ms")} | ${
      signed(row.candidate.meanToolErrors - row.baseline.meanToolErrors, "")} | ${costDelta} |`);
  }
  return `${lines.join("\n")}\n`;
}
