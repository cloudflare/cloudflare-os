import {
  group, hasInfrastructureFailure, parseResults, trials, type Assertion, type Cohort,
} from "./results.ts";

export type EvalStats = {
  trials: number;
  /** Trials that passed. An infrastructure failure counts as neither a pass nor a fail. */
  passed: number;
  /** Trials that failed for infrastructure reasons rather than the agent's work. */
  infrastructureTrials: number;
  meanDurationMs: number;
  meanModelTurns: number;
  meanToolCalls: number;
  meanToolErrors: number;
  /**
   * The share of all the trials' prompt tokens that the provider's prompt cache served. Null when
   * any trial lacks the counts, as one that never finished a model step does.
   */
  cacheHitRate: number | null;
  /**
   * Each check that failed in some trial, by turn, with how many trials failed it and the evidence
   * of the first. A turn the agent did not complete fails as `agent.<outcome>`. Leaves out
   * infrastructure failures. Most frequent first.
   */
  failedChecks: { turn: number; check: string; trials: number; evidence: string | null }[];
  /** How many trials reached each turn, leaving out infrastructure failures. */
  turnsReached: number[];
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
   * The main the pull request merges into, and its merge commit. A task's result may come from
   * another commit with the same eval key.
   */
  baselineSha: string;
  candidateSha: string;
  verdict: EvalVerdict;
  rows: EvalComparisonRow[];
};

/**
 * The reason for a task whose two sides are one result: nothing its run executes differs between
 * the two commits. Two separate runs never produce identical results.
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

type Turn = Assertion["meta"]["harness"]["run"]["output"]["turns"][number];

/**
 * A turn's failed checks. A turn the agent did not complete has no checks to fail, so it fails as
 * `agent.<outcome>`.
 */
function failures(turn: Turn): { check: string; evidence: unknown }[] {
  const failed = turn.checks.flatMap(({ id, pass, evidence }) => pass ? [] : [{ check: id, evidence }]);
  return turn.outcome.status === "completed"
    ? failed : [{ check: `agent.${turn.outcome.status}`, evidence: undefined }, ...failed];
}

function infrastructureMessage(assertion: Assertion): string {
  const run = assertion.meta.harness.run;
  const turn = run.output.turns.find(({ outcome }) =>
    outcome.status === "error" || outcome.status === "cancelled");
  return turn?.outcome.message ?? run.errors[0]?.message ?? "infrastructure failure";
}

function stats({ assertions }: Cohort): EvalStats {
  const tokens = assertions.flatMap(assertion => {
    const { cumulativePromptTokens: prompt, cumulativeCacheReadTokens: cached } =
      assertion.meta.harness.run.usage.metadata;
    return prompt === undefined || cached === undefined ? [] : [{ prompt, cached }];
  });
  const promptTokens = tokens.reduce((total, trial) => total + trial.prompt, 0);
  const cachedTokens = tokens.reduce((total, trial) => total + trial.cached, 0);
  const runs = assertions.map(assertion => assertion.meta.harness.run);
  const metrics = runs.map(run => run.output.metrics);
  // A crash's check results say nothing about the agent's work.
  const judged = assertions.filter(assertion => !hasInfrastructureFailure(assertion));
  const turns = judged.map(assertion => assertion.meta.harness.run.output.turns);
  const failedChecks = countBy(turns.flatMap(trial => trial.flatMap((turn, index) =>
    failures(turn).map(({ check, evidence }) => ({
      turn: index + 1, check,
      evidence: evidence === undefined ? null : JSON.stringify(evidence),
    })))), failure => `${failure.turn} ${failure.check}`);
  const toolErrors = countBy(runs.flatMap(run => run.session.events.flatMap(event =>
    event.type === "tool_result" && event.error !== undefined
      ? [{ tool: event.name ?? "unknown", message: event.error.message.trim().split("\n")[0] ?? "" }]
      : [])), error => `${error.tool}\n${error.message}`);
  const infrastructureErrors = countBy(
    assertions.filter(hasInfrastructureFailure).map(infrastructureMessage), message => message);
  return {
    trials: assertions.length,
    passed: judged.filter(assertion => assertion.status === "passed").length,
    infrastructureTrials: assertions.length - judged.length,
    meanDurationMs: mean(assertions.map(assertion => assertion.duration)),
    meanModelTurns: mean(metrics.map(value => value.modelTurns)),
    meanToolCalls: mean(metrics.map(value => value.toolCalls)),
    meanToolErrors: mean(metrics.map(value => value.toolErrors)),
    cacheHitRate: tokens.length === assertions.length && promptTokens > 0
      ? cachedTokens / promptTokens : null,
    failedChecks: failedChecks.map(({ item, count }) => ({ ...item, trials: count })),
    turnsReached: Array.from({ length: Math.max(0, ...turns.map(trial => trial.length)) },
      (_, index) => turns.filter(trial => trial.length > index).length),
    toolErrors: toolErrors.map(({ item, count }) => ({ ...item, count })),
    infrastructureErrors: infrastructureErrors.map(({ item, count }) => ({ message: item, trials: count })),
  };
}

/** The commits compared, and what only the caller, holding their eval keys, can tell about them. */
export type CompareOptions = {
  /** The main the pull request merges into, and its merge commit. */
  baselineSha: string;
  candidateSha: string;
  /** Whether the code that defines or scores a task's trials differs between the two commits. */
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

/** The pass rate over trials that reached a verdict: an infrastructure failure reached none. */
function passRate(stats: EvalStats): number {
  return stats.passed / (stats.trials - stats.infrastructureTrials);
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

/** The pass rate, as a whole percentage, and how many trials failed for infrastructure reasons. */
function score(side: EvalStats): string {
  const count = side.infrastructureTrials;
  const errors = `${count}${NBSP}run${NBSP}error${count === 1 ? "" : "s"}`;
  if (count === side.trials) return errors;
  const percent = `${Math.round(passRate(side) * 100)}%`;
  return count === 0 ? percent : `${percent}${NBSP}(${errors})`;
}

/** A change in percentage points. */
function points(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "\u2212" : "";
  return `${sign}${Math.abs(delta).toFixed(0)}${NBSP}pp`;
}

/** The pass-rate change, in percentage points. */
function passChange(row: ComparedRow): string {
  return points((passRate(row.candidate) - passRate(row.baseline)) * 100);
}

/** A side's prompt cache hit rate, as a whole percentage. */
function cachePercent(side: EvalStats): number | null {
  return side.cacheHitRate === null ? null : Math.round(side.cacheHitRate * 100);
}

/**
 * Each side's prompt cache hit rate and, when both sides have one and the task compares, its
 * change on a second line.
 */
function cacheHits(row: EvalComparisonRow): string {
  const rates = sides(row, side => {
    const value = cachePercent(side);
    return value === null ? null : `${value}%`;
  });
  if (row.reason !== null) return rates;
  const baseline = cachePercent(row.baseline);
  const candidate = cachePercent(row.candidate);
  return baseline === null || candidate === null
    ? rates : `${rates}<br>${points(candidate - baseline)}`;
}

/** A p-value to two decimals, or a bound where two decimals would round it to zero. */
function pValueText(pValue: number): string {
  return pValue < 0.01 ? `p${NBSP}<${NBSP}0.01` : `p${NBSP}=${NBSP}${pValue.toFixed(2)}`;
}

/**
 * One value for each side, baseline first, with a dash for a side that lacks it. A value both sides
 * share is shown once.
 */
function sides(row: EvalComparisonRow, value: (side: EvalStats) => string | null): string {
  const cell = (side: EvalStats | null) => (side === null ? null : value(side)) ?? "\u2014";
  const baseline = cell(row.baseline);
  const candidate = cell(row.candidate);
  return baseline === candidate ? baseline : `${baseline}${NBSP}\u2192${NBSP}${candidate}`;
}

/**
 * One table row per check that failed on either side: how many trials failed it out of those that
 * reached its turn, e.g. `2/10 → 5/10`.
 */
function failedCheckRows(row: EvalComparisonRow, task: string): string[] {
  const checks = new Map<string, { turn: number; check: string }>();
  for (const side of [row.baseline, row.candidate]) {
    for (const { turn, check } of side?.failedChecks ?? []) checks.set(`t${turn} ${check}`, { turn, check });
  }
  return [...checks].toSorted(([, left], [, right]) => left.turn - right.turn).map(([label, { turn, check }]) => {
    const failed = (side: EvalStats) => {
      const reached = side.turnsReached[turn - 1] ?? 0;
      const count = side.failedChecks.find(entry => entry.turn === turn && entry.check === check)?.trials ?? 0;
      return reached === 0 ? null : `${count}/${reached}`;
    };
    return `| ${task} | ${label} | ${sides(row, failed)} |`;
  });
}

/**
 * Render the comparison for a pull request comment: the verdict, then one table with each task's
 * score on both sides, its change and Fisher test, its prompt cache hit rate and that change, and
 * each side's average minutes and steps per run. A collapsed table lists each check that failed on
 * either side of a task whose inputs changed; Bonk's review explains the failures.
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
    "| Task | Score | \u0394 score | Fisher test | Cache hits | Avg min | Avg steps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const fisher = row.reason !== null ? "\u2014"
      : row.pValue < SIGNIFICANCE ? `**${pValueText(row.pValue)}**<br>significant`
      : pValueText(row.pValue);
    lines.push(`| ${[
      name(row), sides(row, score),
      row.reason === null ? passChange(row) : `_${row.reason}_`, fisher, cacheHits(row),
      sides(row, side => (side.meanDurationMs / 60_000).toFixed(1)),
      sides(row, side => side.meanModelTurns.toFixed(1)),
    ].join(" | ")} |`);
  }
  const checks = rows.flatMap(row => row.reason === SAME_INPUTS ? [] : failedCheckRows(row, name(row)));
  if (checks.length > 0) {
    // GitHub renders a table inside <details> only after a blank line.
    lines.push("", "<details><summary>Failed checks</summary>", "",
      "| Task | Check | Failed |", "| --- | --- | --- |", ...checks, "", "</details>");
  }
  lines.push("");
  return lines.join("\n");
}
