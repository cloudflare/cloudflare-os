import { basename } from "node:path";
import { parseResults, trials, type Assertion } from "./results.ts";

export type EvalStats = {
  trials: number;
  passed: number;
  meanDurationMs: number;
  meanModelTurns: number;
  meanToolCalls: number;
  meanToolErrors: number;
  /** Null when any trial lacks a cost: a mean over a subset would not compare across sides. */
  meanCostUsd: number | null;
};

/** One task/model cohort. `reason` is null exactly when the two sides can be compared. */
export type EvalComparisonRow = { taskId: string; model: string } & (
  | { reason: null; baseline: EvalStats; candidate: EvalStats }
  | { reason: string; baseline: EvalStats | null; candidate: EvalStats | null }
);

export type EvalComparison = {
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

function stats({ assertions }: Cohort): EvalStats {
  const costs = assertions.flatMap(assertion => {
    const cost = assertion.meta.harness.run.usage.metadata.observedCumulativeChatCostUsd;
    return cost === undefined ? [] : [cost];
  });
  const metrics = assertions.map(assertion => assertion.meta.harness.run.output.metrics);
  return {
    trials: assertions.length,
    passed: assertions.filter(assertion => assertion.status === "passed").length,
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

/**
 * Reject a report that cannot serve as a shared baseline: every eval file must have run, every
 * task/model cohort must hold exactly `expectedTrials` trials, and no trial may have failed for
 * infrastructure reasons. Agent failures are legitimate baseline data and pass.
 */
export function validateEvalResults(text: string, expectedTrials: number): void {
  const files = parseResults("baseline", text);
  for (const file of files) {
    if (file.assertionResults.length === 0) {
      throw new Error(`${basename(file.name)} ran no trials${file.message ? `: ${file.message}` : ""}`);
    }
  }
  const assertions = trials(files);
  singleCommit("baseline", assertions);
  for (const cohort of group(assertions).values()) {
    if (cohort.assertions.length !== expectedTrials) {
      throw new Error(
        `${cohort.taskId} on ${cohort.model} has ${cohort.assertions.length} trials, ` +
        `expected ${expectedTrials}`);
    }
    if (cohort.assertions.some(hasInfrastructureFailure)) {
      throw new Error(`${cohort.taskId} on ${cohort.model} has infrastructure failures`);
    }
  }
}

/**
 * Compare baseline and candidate Vitest eval reports. `definitionsChanged` is asked, with both
 * reports' commits, whether the code that defines or scores a trial differs between them; when it
 * does, no cohort is comparable.
 */
export function compareEvalResults(
    baselineText: string, candidateText: string,
    definitionsChanged: (baselineSha: string, candidateSha: string) => boolean = () => false,
): EvalComparison {
  const baselineAssertions = trials(parseResults("baseline", baselineText));
  const candidateAssertions = trials(parseResults("candidate", candidateText));
  const baselineSha = singleCommit("baseline", baselineAssertions);
  const candidateSha = singleCommit("candidate", candidateAssertions);
  const changed = definitionsChanged(baselineSha, candidateSha);
  const baseline = group(baselineAssertions);
  const candidate = group(candidateAssertions);
  // Either side's cohort carries the identity; both do when the key is shared.
  const rows = [...new Map([...baseline, ...candidate])].map(([key, cohort]): EvalComparisonRow => {
    const identity = { taskId: cohort.taskId, model: cohort.model };
    const base = baseline.get(key);
    const next = candidate.get(key);
    if (base === undefined) {
      return { ...identity, reason: "only in candidate", baseline: null, candidate: stats(cohort) };
    }
    if (next === undefined) {
      return { ...identity, reason: "only in baseline", baseline: stats(base), candidate: null };
    }
    const reason = changed ? "eval definition changed"
      : base.taskVersion !== next.taskVersion ? "task version changed"
      : base.assertions.length !== next.assertions.length ? "trial counts differ"
      : base.assertions.some(hasInfrastructureFailure) ? "baseline run errors"
      : next.assertions.some(hasInfrastructureFailure) ? "candidate run errors"
      : null;
    return { ...identity, reason, baseline: stats(base), candidate: stats(next) };
  }).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model));
  return { baselineSha, candidateSha, rows };
}

function passRate(stats: EvalStats): number {
  return stats.passed / stats.trials;
}

function signed(value: number, digits: number, unit = ""): string {
  const sign = value > 0 ? "+" : value < 0 ? "\u2212" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}${unit}`;
}

function costDelta(baseline: EvalStats, candidate: EvalStats): string {
  if (baseline.meanCostUsd === null || candidate.meanCostUsd === null) return "\u2014";
  const delta = candidate.meanCostUsd - baseline.meanCostUsd;
  return `${delta > 0 ? "+" : delta < 0 ? "\u2212" : ""}$${Math.abs(delta).toFixed(3)}`;
}

/** The one value every row shares, or null when they differ and must be shown per row. */
function uniform<T>(values: readonly T[]): T | null {
  const [first, ...rest] = values;
  return first !== undefined && rest.every(value => value === first) ? first : null;
}

/**
 * Render the comparison for a pull request comment: one table of the cohorts that can be
 * compared, then the cohorts that cannot, grouped by why. Whatever every row shares (the model,
 * the trial count) is said once in the header rather than repeated down a column.
 */
export function renderEvalComparison(comparison: EvalComparison): string {
  const { rows } = comparison;
  const model = uniform(rows.map(row => row.model));
  const trials = uniform(rows.flatMap(row =>
    [row.baseline?.trials, row.candidate?.trials].filter(count => count !== undefined)));
  const header = [
    `Baseline \`${comparison.baselineSha.slice(0, 8)}\` vs candidate \`${comparison.candidateSha.slice(0, 8)}\``,
    ...(model === null ? [] : [model]),
    ...(trials === null ? [] : [`${trials} trials per task`]),
  ].join(" \u00b7 ");
  const lines = ["# Eval runs comparison", "", `${header}.`, ""];

  const side = (stats: EvalStats) =>
    trials === null ? `${stats.passed}/${stats.trials}` : String(stats.passed);
  const compared = rows.flatMap(row => row.reason === null ? [row] : []);
  if (compared.length === 0) {
    lines.push("No cohort is comparable.", "");
  } else {
    const columns = ["Task", ...(model === null ? ["Model"] : []),
      trials === null ? "Baseline" : `Baseline /${trials}`,
      trials === null ? "Candidate" : `Candidate /${trials}`,
      "\u0394 pass", "\u0394 duration", "\u0394 tool errors", "\u0394 cost"];
    lines.push(`| ${columns.join(" | ")} |`, `|${" --- |".repeat(columns.length)}`);
    for (const row of compared) {
      const { baseline, candidate } = row;
      const cells = [row.taskId, ...(model === null ? [row.model] : []),
        side(baseline), side(candidate),
        signed((passRate(candidate) - passRate(baseline)) * 100, 0, " pp"),
        signed((candidate.meanDurationMs - baseline.meanDurationMs) / 1000, 1, " s"),
        signed(candidate.meanToolErrors - baseline.meanToolErrors, 1),
        costDelta(baseline, candidate)];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  // Each side's own pass count still says something even when the two cannot be set against
  // each other: a one-sided cohort shows the side it has, an invalidated one shows both.
  const skipped = new Map<string, string[]>();
  for (const row of rows) {
    if (row.reason === null) continue;
    const scores = [row.baseline, row.candidate].flatMap(stats =>
      stats === null ? [] : [`${stats.passed}/${stats.trials}`]).join(" \u2192 ");
    const name = model === null ? `${row.taskId} (${row.model})` : row.taskId;
    skipped.set(row.reason, [...(skipped.get(row.reason) ?? []), `${name} ${scores}`]);
  }
  if (skipped.size > 0) {
    lines.push("Not compared:");
    for (const [reason, tasks] of skipped) lines.push(`- ${reason}: ${tasks.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
