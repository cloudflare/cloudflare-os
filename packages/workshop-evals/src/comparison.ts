import { basename } from "node:path";
import { z } from "zod";
import type { JsonValue } from "vitest-evals";

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
          metrics: z.object({
            modelTurns: z.number().int().nonnegative(),
            toolCalls: z.number().int().nonnegative(),
            toolErrors: z.number().int().nonnegative(),
          }),
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

// One entry per eval file. A file that fails before its first trial (a collection error) is still
// listed, with no assertions and the error in `message`.
const FileSchema = z.object({
  name: z.string(),
  message: z.string().optional(),
  assertionResults: z.array(AssertionSchema),
}).loose();

const ResultsSchema = z.object({ testResults: z.array(FileSchema) }).loose();

type Assertion = z.infer<typeof AssertionSchema>;
type EvalFile = z.infer<typeof FileSchema>;

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

function parseResults(name: string, text: string): EvalFile[] {
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
  if (trials(parsed.data.testResults).length === 0) {
    throw new Error(`${name} results contain no evals`);
  }
  return parsed.data.testResults;
}

function trials(files: EvalFile[]): Assertion[] {
  return files.flatMap(file => file.assertionResults);
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
      return { ...identity, reason: "missing baseline", baseline: null, candidate: stats(cohort) };
    }
    if (next === undefined) {
      return { ...identity, reason: "missing candidate", baseline: stats(base), candidate: null };
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

function side(value: EvalStats | null): string {
  return value === null
    ? "—"
    : `${value.passed}/${value.trials} (${(passRate(value) * 100).toFixed(1)}%)`;
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
    "| Task | Model | Baseline | Candidate | Pass-rate delta | Duration delta | Tool-error delta | Cost delta |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of comparison.rows) {
    const cells = [row.taskId, row.model, side(row.baseline), side(row.candidate)];
    if (row.reason !== null) {
      cells.push(row.reason, "—", "—", "—");
    } else {
      const { baseline, candidate } = row;
      const costDelta = baseline.meanCostUsd === null || candidate.meanCostUsd === null
        ? "—"
        : `${candidate.meanCostUsd >= baseline.meanCostUsd ? "+" : "-"}$${
          Math.abs(candidate.meanCostUsd - baseline.meanCostUsd).toFixed(4)}`;
      cells.push(
        signed((passRate(candidate) - passRate(baseline)) * 100, " pp"),
        signed(candidate.meanDurationMs - baseline.meanDurationMs, " ms"),
        signed(candidate.meanToolErrors - baseline.meanToolErrors, ""),
        costDelta);
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
