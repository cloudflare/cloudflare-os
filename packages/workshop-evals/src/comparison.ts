import {
  group, hasInfrastructureFailure, parseResults, trials, type Assertion, type Cohort,
} from "./results.ts";

export type EvalStats = {
  trials: number;
  passed: number;
  meanDurationMs: number;
  meanModelTurns: number;
  meanToolCalls: number;
  meanToolErrors: number;
  /** Null when any trial lacks a cost: a mean over a subset would not compare across sides. */
  meanCostUsd: number | null;
  /**
   * Each check that failed, as `t<turn> <check id>`, with how many trials failed it and the
   * evidence of the first. Most frequent first.
   */
  failedChecks: { check: string; trials: number; evidence: string | null }[];
  /** Tool errors by tool and the first line of their message, most frequent first. */
  toolErrors: { tool: string; message: string; count: number }[];
  /** Trials that failed for infrastructure reasons rather than the agent's work, by message. */
  infrastructureErrors: { message: string; trials: number }[];
};

/**
 * One task/model cohort. `reason` is null exactly when the two sides can be compared, and then
 * `pValue` is the two-sided Fisher exact test on their pass counts.
 */
export type EvalComparisonRow = { taskId: string; model: string } & (
  | { reason: null; baseline: EvalStats; candidate: EvalStats; pValue: number }
  | { reason: string; baseline: EvalStats | null; candidate: EvalStats | null }
);

/**
 * `regressed` when any comparable task's pass rate fell significantly (p < 0.05), `improved` when
 * some rose and none fell, `unchanged` when none moved beyond noise or no task's inputs changed,
 * `inconclusive` when nothing could be compared.
 */
export type EvalVerdict = "improved" | "regressed" | "unchanged" | "inconclusive";

export type EvalComparison = {
  /**
   * The pull request's base and head. A task's result may come from another commit with the same
   * eval key.
   */
  baselineSha: string;
  candidateSha: string;
  verdict: EvalVerdict;
  rows: EvalComparisonRow[];
};

/**
 * The reason for a task whose two sides are one result: nothing its run executes differs between
 * base and head. Two separate runs never produce identical results.
 */
const SAME_INPUTS = "same inputs";

/** The significance a pass-rate change must reach to count as improved or regressed. */
const SIGNIFICANCE = 0.05;

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** How many items share each key, most frequent first, keeping the first item for each key. */
function countBy<T>(items: readonly T[], key: (item: T) => string): { item: T; count: number }[] {
  const counts = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const entry = counts.get(key(item));
    if (entry === undefined) counts.set(key(item), { item, count: 1 });
    else entry.count++;
  }
  return [...counts.values()].toSorted((left, right) => right.count - left.count);
}

function infrastructureMessage(assertion: Assertion): string {
  const run = assertion.meta.harness.run;
  const turn = run.output.turns.find(({ outcome }) =>
    outcome.status === "error" || outcome.status === "cancelled");
  return turn?.outcome.message ?? run.errors[0]?.message ?? "infrastructure failure";
}

function stats({ assertions }: Cohort): EvalStats {
  const costs = assertions.flatMap(assertion => {
    const cost = assertion.meta.harness.run.usage.metadata.observedCumulativeChatCostUsd;
    return cost === undefined ? [] : [cost];
  });
  const runs = assertions.map(assertion => assertion.meta.harness.run);
  const metrics = runs.map(run => run.output.metrics);
  const failedChecks = countBy(runs.flatMap(run => run.output.turns.flatMap((turn, index) =>
    turn.checks.filter(check => !check.pass).map(check => ({
      check: `t${index + 1} ${check.id}`,
      evidence: check.evidence === undefined ? null : JSON.stringify(check.evidence),
    })))), failure => failure.check);
  const toolErrors = countBy(runs.flatMap(run => run.session.events.flatMap(event =>
    event.type === "tool_result" && event.error !== undefined
      ? [{ tool: event.name ?? "unknown", message: event.error.message.trim().split("\n")[0] ?? "" }]
      : [])), error => `${error.tool}\n${error.message}`);
  const infrastructureErrors = countBy(
    assertions.filter(hasInfrastructureFailure).map(infrastructureMessage), message => message);
  return {
    trials: assertions.length,
    passed: assertions.filter(assertion => assertion.status === "passed").length,
    meanDurationMs: mean(assertions.map(assertion => assertion.duration)),
    meanModelTurns: mean(metrics.map(value => value.modelTurns)),
    meanToolCalls: mean(metrics.map(value => value.toolCalls)),
    meanToolErrors: mean(metrics.map(value => value.toolErrors)),
    meanCostUsd: costs.length === assertions.length ? mean(costs) : null,
    failedChecks: failedChecks.map(({ item, count }) => ({ ...item, trials: count })),
    toolErrors: toolErrors.map(({ item, count }) => ({ ...item, count })),
    infrastructureErrors: infrastructureErrors.map(({ item, count }) => ({ message: item, trials: count })),
  };
}

/** The commits compared, and what only the caller, holding their eval keys, can tell about them. */
export type CompareOptions = {
  /** The pull request's base and head. */
  baselineSha: string;
  candidateSha: string;
  /** Whether the code that defines or scores a task's trials differs between base and head. */
  definitionsChanged?: (taskId: string) => boolean;
};

/** The natural log of `count` choose `chosen`, as a sum of logs so large counts don't overflow. */
function logChoose(count: number, chosen: number): number {
  let sum = 0;
  for (let factor = chosen + 1; factor <= count; factor++) sum += Math.log(factor);
  for (let factor = 2; factor <= count - chosen; factor++) sum -= Math.log(factor);
  return sum;
}

/**
 * Two-sided Fisher exact test on two pass counts: the chance, were both sides equally good, of a
 * split at least as uneven as the one observed.
 */
function fisherExact(baseline: EvalStats, candidate: EvalStats): number {
  const passed = baseline.passed + candidate.passed;
  const probability = (baselinePassed: number) => Math.exp(
    logChoose(baseline.trials, baselinePassed) + logChoose(candidate.trials, passed - baselinePassed) -
    logChoose(baseline.trials + candidate.trials, passed));
  const observed = probability(baseline.passed);
  let total = 0;
  const lowest = Math.max(0, passed - candidate.trials);
  for (let baselinePassed = lowest; baselinePassed <= Math.min(passed, baseline.trials); baselinePassed++) {
    // The tolerance keeps tables as likely as the observed one despite floating-point noise.
    const chance = probability(baselinePassed);
    if (chance <= observed * (1 + 1e-7)) total += chance;
  }
  return Math.min(1, total);
}

/** Whether every task's two sides are one reused result, so nothing the evals run changed. */
function allReused(rows: readonly EvalComparisonRow[]): boolean {
  return rows.length > 0 && rows.every(row => row.reason === SAME_INPUTS);
}

function verdictOf(rows: EvalComparisonRow[]): EvalVerdict {
  if (allReused(rows)) return "unchanged";
  const compared = rows.flatMap(row => row.reason === null ? [row] : []);
  if (compared.length === 0) return "inconclusive";
  const moved = compared.filter(row => row.pValue < SIGNIFICANCE);
  if (moved.some(row => passRate(row.candidate) < passRate(row.baseline))) return "regressed";
  return moved.length > 0 ? "improved" : "unchanged";
}

/** Compare baseline and candidate Vitest eval reports. */
export function compareEvalResults(
    baselineText: string, candidateText: string,
    { baselineSha, candidateSha, definitionsChanged = () => false }: CompareOptions,
): EvalComparison {
  const baseline = group(trials(parseResults("baseline", baselineText)));
  const candidate = group(trials(parseResults("candidate", candidateText)));
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
    // Sameness comes last: one result both sides share can still have failed to run.
    const reason = definitionsChanged(cohort.taskId) ? "eval definition changed"
      : base.taskVersion !== next.taskVersion ? "task version changed"
      : base.assertions.length !== next.assertions.length ? "run counts differ"
      : base.assertions.some(hasInfrastructureFailure) ? "baseline run errors"
      : next.assertions.some(hasInfrastructureFailure) ? "candidate run errors"
      : JSON.stringify(base.assertions) === JSON.stringify(next.assertions) ? SAME_INPUTS
      : null;
    const [baselineStats, candidateStats] = [stats(base), stats(next)];
    if (reason !== null) {
      return { ...identity, reason, baseline: baselineStats, candidate: candidateStats };
    }
    return { ...identity, reason, baseline: baselineStats, candidate: candidateStats,
      pValue: fisherExact(baselineStats, candidateStats) };
  }).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model));
  return { baselineSha, candidateSha, verdict: verdictOf(rows), rows };
}

function passRate(stats: EvalStats): number {
  return stats.passed / stats.trials;
}

/** The one value every row shares, or null when they differ and must be shown per row. */
function uniform<T>(values: readonly T[]): T | null {
  const [first, ...rest] = values;
  return first !== undefined && rest.every(value => value === first) ? first : null;
}

const VERDICT: Record<EvalVerdict, string> = {
  improved: "\u{1F7E2} Improved",
  regressed: "\u{1F534} Regressed",
  unchanged: "\u26AA Unchanged",
  inconclusive: "\u{1F7E1} Inconclusive",
};

type ComparedRow = Extract<EvalComparisonRow, { reason: null }>;

/**
 * Joins a value's words so it stays on one line: GitHub fits a wide table to a comment by wrapping
 * cells at spaces, and should wrap names and headers rather than numbers.
 */
const NBSP = "\u00a0";

/** The pass rate, as a whole percentage. */
function score(side: EvalStats): string {
  return `${Math.round(passRate(side) * 100)}%`;
}

/** The pass-rate change, in percentage points. */
function passChange(row: ComparedRow): string {
  const delta = (passRate(row.candidate) - passRate(row.baseline)) * 100;
  const sign = delta > 0 ? "+" : delta < 0 ? "\u2212" : "";
  return `${sign}${Math.abs(delta).toFixed(0)}${NBSP}pp`;
}

/** A p-value to two decimals, or a bound where two decimals would round it to zero. */
function pValueText(pValue: number): string {
  return pValue < 0.01 ? `p${NBSP}<${NBSP}0.01` : `p${NBSP}=${NBSP}${pValue.toFixed(2)}`;
}

/** One value for each side, baseline first, with a dash for a side that lacks it. */
function sides(row: EvalComparisonRow, value: (side: EvalStats) => string | null): string {
  const cell = (side: EvalStats | null) => (side === null ? null : value(side)) ?? "\u2014";
  return `${cell(row.baseline)}${NBSP}\u2192${NBSP}${cell(row.candidate)}`;
}

/**
 * Render the comparison for a pull request comment: the verdict, then one table with each task's
 * score on both sides, its change and Fisher test, and each side's average minutes, cost and
 * steps per run. Headers are short so the table fits a comment's width unwrapped. Bonk's review
 * explains the failures.
 */
export function renderEvalComparison(comparison: EvalComparison): string {
  const { rows } = comparison;
  const model = uniform(rows.map(row => row.model));
  const trials = uniform(rows.flatMap(row =>
    [row.baseline?.trials, row.candidate?.trials].filter(count => count !== undefined)));
  const name = (row: EvalComparisonRow) =>
    model === null ? `${row.taskId} (${row.model})` : row.taskId;
  const moved = rows.flatMap(row => row.reason === null && row.pValue < SIGNIFICANCE ? [row] : []);
  const change = (row: ComparedRow) =>
    `${name(row)} ${sides(row, score)} (${pValueText(row.pValue)})`;
  const falls = moved.filter(row => passRate(row.candidate) < passRate(row.baseline));
  const rises = moved.filter(row => passRate(row.candidate) > passRate(row.baseline));
  const why = comparison.verdict === "inconclusive"
    ? `No task can be compared: ${[...new Set(rows.flatMap(row => row.reason ?? []))].join(", ")}.`
    : allReused(rows) ? "Nothing the evals run changed, so every result is reused."
    : comparison.verdict === "unchanged"
      ? `No task moved beyond what ${trials ?? "these"} runs can tell apart from noise.`
      : [falls.length > 0 ? `Fell: ${falls.map(change).join(", ")}.` : "",
        rises.length > 0 ? `Rose: ${rises.map(change).join(", ")}.` : ""].join(" ").trim();

  const lines = [
    "# Eval results", "",
    `**Verdict: ${VERDICT[comparison.verdict]}.** ${why}`, "",
    "| Task | Score | \u0394 score | Fisher test | Avg min | Avg $ | Avg steps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const fisher = row.reason !== null ? "\u2014"
      : row.pValue < SIGNIFICANCE ? `**${pValueText(row.pValue)}**<br>significant`
      : pValueText(row.pValue);
    lines.push(`| ${[
      name(row), sides(row, score),
      row.reason === null ? passChange(row) : `_${row.reason}_`, fisher,
      sides(row, side => (side.meanDurationMs / 60_000).toFixed(1)),
      sides(row, side => side.meanCostUsd?.toFixed(3) ?? null),
      sides(row, side => side.meanModelTurns.toFixed(1)),
    ].join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
