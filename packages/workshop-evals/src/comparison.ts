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
 * some rose and none fell, `unchanged` when none moved beyond noise, `inconclusive` when nothing
 * could be compared.
 */
export type EvalVerdict = "improved" | "regressed" | "unchanged" | "inconclusive";

export type EvalComparison = {
  baselineSha: string;
  candidateSha: string;
  verdict: EvalVerdict;
  /** Files the pull request changes that the evals exercise. */
  changedFiles: string[];
  rows: EvalComparisonRow[];
};

/** The significance a pass-rate change must reach to count as improved or regressed. */
const SIGNIFICANCE = 0.05;

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

/** Questions about the two commits that only the caller, holding the repository, can answer. */
export type CommitQuestions = {
  /** Whether the code that defines or scores a trial differs; if so, no cohort is comparable. */
  definitionsChanged?: (baselineSha: string, candidateSha: string) => boolean;
  /** The files the pull request changes that the evals exercise. */
  changedFiles?: (baselineSha: string, candidateSha: string) => string[];
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

function verdictOf(rows: EvalComparisonRow[]): EvalVerdict {
  const compared = rows.flatMap(row => row.reason === null ? [row] : []);
  if (compared.length === 0) return "inconclusive";
  const moved = compared.filter(row => row.pValue < SIGNIFICANCE);
  if (moved.some(row => passRate(row.candidate) < passRate(row.baseline))) return "regressed";
  return moved.length > 0 ? "improved" : "unchanged";
}

/** Compare baseline and candidate Vitest eval reports. */
export function compareEvalResults(
    baselineText: string, candidateText: string,
    { definitionsChanged = () => false, changedFiles = () => [] }: CommitQuestions = {},
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
      : base.assertions.length !== next.assertions.length ? "run counts differ"
      : base.assertions.some(hasInfrastructureFailure) ? "baseline run errors"
      : next.assertions.some(hasInfrastructureFailure) ? "candidate run errors"
      : null;
    const [baselineStats, candidateStats] = [stats(base), stats(next)];
    if (reason !== null) {
      return { ...identity, reason, baseline: baselineStats, candidate: candidateStats };
    }
    return { ...identity, reason, baseline: baselineStats, candidate: candidateStats,
      pValue: fisherExact(baselineStats, candidateStats) };
  }).toSorted((left, right) =>
    left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model));
  return {
    baselineSha, candidateSha, verdict: verdictOf(rows),
    changedFiles: changedFiles(baselineSha, candidateSha), rows,
  };
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

const VERDICT: Record<EvalVerdict, string> = {
  improved: "\u{1F7E2} Improved",
  regressed: "\u{1F534} Regressed",
  unchanged: "\u26AA Unchanged",
  inconclusive: "\u{1F7E1} Inconclusive",
};

type ComparedRow = Extract<EvalComparisonRow, { reason: null }>;

/** Text that came from a trial, as inline code: it is untrusted and may contain markup. */
function quoted(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").replaceAll("`", "'").trim();
  return `\`${flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat}\``;
}

/** Ten cells whatever the trial count, so bars line up down the table: green passed, red failed. */
function bar(side: EvalStats | null): string {
  if (side === null) return "\u2014";
  const passed = Math.round(passRate(side) * 10);
  return `${"\u{1F7E9}".repeat(passed)}${"\u{1F7E5}".repeat(10 - passed)} ${side.passed}/${side.trials}`;
}

/** A pass-rate change is coloured only when it is significant; otherwise it is noise. */
function passChange(row: ComparedRow): string {
  const delta = (passRate(row.candidate) - passRate(row.baseline)) * 100;
  const significant = row.pValue < SIGNIFICANCE;
  const marker = !significant ? "\u26AA" : delta > 0 ? "\u{1F7E2}" : "\u{1F534}";
  return `${marker} ${signed(delta, 0, " pp")}${significant ? ` (p = ${row.pValue.toFixed(2)})` : ""}`;
}

/**
 * Render the comparison for a pull request comment: the verdict and the changed files the evals
 * exercise, one table of every task's scores and deltas, then what failed and why, for the human
 * who has to fix it. Whatever every row shares (the model, the trial count) is said once.
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
    `${name(row)} ${row.baseline.passed}/${row.baseline.trials} \u2192 ` +
    `${row.candidate.passed}/${row.candidate.trials} (p = ${row.pValue.toFixed(2)})`;
  const falls = moved.filter(row => passRate(row.candidate) < passRate(row.baseline));
  const rises = moved.filter(row => passRate(row.candidate) > passRate(row.baseline));
  const why = comparison.verdict === "inconclusive"
    ? `No task can be compared: ${[...new Set(rows.flatMap(row => row.reason ?? []))].join(", ")}.`
    : comparison.verdict === "unchanged"
      ? `No task moved beyond what ${trials ?? "these"} runs can tell apart from noise.`
      : [falls.length > 0 ? `Fell: ${falls.map(change).join(", ")}.` : "",
        rises.length > 0 ? `Rose: ${rises.map(change).join(", ")}.` : ""].join(" ").trim();

  const files = comparison.changedFiles;
  const lines = [
    "# Eval results", "",
    `**Verdict: ${VERDICT[comparison.verdict]}.** ${why}`, "",
    files.length === 0 ? "**Evals exercise no file this change touches.**"
      : `**Evals exercise these changed files:** ${files.slice(0, 8).map(file => `\`${file}\``).join(", ")}` +
        (files.length > 8 ? `, and ${files.length - 8} more` : ""),
    "",
    [`Baseline \`${comparison.baselineSha.slice(0, 8)}\` (PR base) vs candidate ` +
        `\`${comparison.candidateSha.slice(0, 8)}\` (PR head)`,
      ...(model === null ? [] : [model]),
      ...(trials === null ? [] : [`each task run ${trials} times per commit`])].join(" \u00b7 ") + ".",
    "",
    "| Task | Baseline | Candidate | \u0394 pass | \u0394 duration | \u0394 tool errors | \u0394 cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const deltas = row.reason !== null ? [`_not compared: ${row.reason}_`, "\u2014", "\u2014", "\u2014"] : [
      passChange(row),
      signed((row.candidate.meanDurationMs - row.baseline.meanDurationMs) / 1000, 1, " s"),
      signed(row.candidate.meanToolErrors - row.baseline.meanToolErrors, 1),
      costDelta(row.baseline, row.candidate),
    ];
    lines.push(`| ${[name(row), bar(row.baseline), bar(row.candidate), ...deltas].join(" | ")} |`);
  }
  lines.push("");

  for (const row of rows) {
    const { candidate, baseline } = row;
    if (candidate === null) continue;
    const failed = candidate.trials - candidate.passed;
    if (failed === 0 && candidate.toolErrors.length === 0) continue;
    lines.push(`### ${name(row)}: ${failed === 0 ? `all ${candidate.trials} candidate runs passed`
      : `${failed} of ${candidate.trials} candidate runs failed`}`, "");
    if (candidate.failedChecks.length > 0) {
      lines.push("| Check | Baseline failed | Candidate failed |", "| --- | --- | --- |");
      for (const { check, trials: count } of candidate.failedChecks.slice(0, 8)) {
        const before = baseline?.failedChecks.find(failure => failure.check === check)?.trials ?? 0;
        // Only a comparable task's counts can be set against each other.
        const worse = row.reason === null && count > before;
        lines.push(`| \`${check}\` | ${baseline === null ? "\u2014" : before} | ${worse ? "\u{1F534} " : ""}${count} |`);
      }
      const hidden = candidate.failedChecks.length - 8;
      if (hidden > 0) lines.push(`| _${hidden} more checks_ | | |`);
      lines.push("");
    }
    const [first] = candidate.failedChecks;
    if (first?.evidence) {
      lines.push(`First failing evidence (\`${first.check}\`): ${quoted(first.evidence, 240)}`, "");
    }
    if (candidate.toolErrors.length > 0) {
      lines.push(`Tool errors: ${candidate.toolErrors.slice(0, 5).map(error =>
        `\`${error.tool}\` ${quoted(error.message, 100)} \u00d7${error.count}`).join(" \u00b7 ")}`, "");
    }
    if (candidate.infrastructureErrors.length > 0) {
      lines.push(`Infrastructure errors, not the agent's work: ${candidate.infrastructureErrors.map(error =>
        `${quoted(error.message, 100)} \u00d7${error.trials}`).join(" \u00b7 ")}`, "");
    }
  }
  return lines.join("\n");
}
