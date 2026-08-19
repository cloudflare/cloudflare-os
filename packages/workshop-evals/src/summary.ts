import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readEvalTaskMeta, type HarnessRun, type VitestJsonReport } from "@vitest-evals/core";
import { readVitestJsonReportFile } from "@vitest-evals/core/node";
import colors from "tinyrainbow";
import { z } from "zod";
import { EVAL_OUTPUT_DIR } from "./artifacts.ts";
import {
  type ConfidenceInterval, type MetricDistribution, mean, metricDistribution,
  sampleStandardDeviation, tMeanInterval, wilsonInterval,
} from "./statistics.ts";

const UsageSchema = z.object({
  complete: z.boolean(),
  successfulRequests: z.number().nonnegative(),
  failedRequests: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});

const IdentitySchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  expectation: z.enum(["required", "frontier"]),
  model: z.string(),
  trial: z.number().int().nonnegative(),
  runId: z.string(),
});

const RunOutputSchema = IdentitySchema.extend({
  passed: z.boolean(),
  diagnostics: z.object({
    toolCalls: z.number().nonnegative(),
    toolErrors: z.array(z.object({ tool: z.string(), message: z.string() })),
    agentErrors: z.array(z.string()),
  }),
  usage: UsageSchema,
  wallDurationMs: z.number().nonnegative(),
});

type RunOutput = z.infer<typeof RunOutputSchema>;
type Identity = z.infer<typeof IdentitySchema>;

/** Aggregated result for repeated runs of one task against one model. */
export type EvalSummaryGroup = {
  /** Stable task identifier. */
  taskId: string;
  /** Human-readable task title. */
  taskTitle: string;
  /** Required or frontier result set. */
  expectation: "required" | "frontier";
  /** Agent model. */
  model: string;
  /** Trials that produced a usable result. */
  validTrials: number;
  /** Trials whose harness output or score was missing, excluded from every rate below. */
  invalidTrials: number;
  /** Valid trials where every check passed. */
  passCount: number;
  /** Fraction of valid trials that fully passed. */
  passRate: number | null;
  /** Wilson 95% interval for {@link passRate}. */
  passRateInterval: ConfidenceInterval | null;
  /** Mean fraction of checks passed, which gives partial credit. */
  meanScore: number | null;
  /** Sample standard deviation of the per-trial score. */
  scoreSampleSd: number | null;
  /** Student-t 95% interval for {@link meanScore}. */
  scoreMeanInterval: ConfidenceInterval | null;
  /** Total tokens per trial, over the trials whose telemetry settled. */
  tokens: MetricDistribution | null;
  /** Summed model request time per trial, excluding tool execution, over measured trials. */
  modelDurationMs: MetricDistribution | null;
  /** End-to-end time per trial, including workerd startup and verification. */
  wallDurationMs: MetricDistribution | null;
  /** Provider-reported cost per trial, over measured trials. */
  costUsd: MetricDistribution | null;
  /**
   * Fraction of valid trials whose Gateway telemetry settled. Below 1, the metrics above describe
   * only that subset; at 0 they are absent rather than zero.
   */
  telemetryCompleteRate: number | null;
  /** Fraction of valid trials containing at least one failed tool call. */
  toolFailureRate: number | null;
  /** Fraction of measured trials containing at least one failed model request. */
  modelFailureRate: number | null;
  /** Fraction of valid trials where the agent posted an error into chat history. */
  agentErrorRate: number | null;
};

/** Machine-readable aggregate over one Vitest JSON report. */
export type EvalSummary = {
  /** Summary format version. */
  version: 1;
  /** Task and model groups, required first. */
  groups: EvalSummaryGroup[];
};

type ValidTrial = { output: RunOutput; score: number };
type Accumulator = Identity & { valid: ValidTrial[]; invalid: number };

function readTrial(assertion: VitestJsonReport["testResults"][number]["assertionResults"][number]) {
  const metadata = readEvalTaskMeta(assertion.meta);
  if (metadata?.harness === undefined) return undefined;
  const harnessRun: HarnessRun | undefined = metadata.harness.run;
  if (harnessRun === undefined) throw new Error("Workshop eval result lacked a harness run");
  const output = RunOutputSchema.safeParse(harnessRun.output);
  const identity = IdentitySchema.safeParse(harnessRun.artifacts?.identity);
  if (!identity.success) {
    throw new Error(`Workshop eval result lacked a run identity: ${z.prettifyError(identity.error)}`);
  }
  const score = (metadata.eval?.scores ?? []).find(entry => entry.name === "checks")?.score;
  if (!output.success || typeof score !== "number") {
    return { identity: identity.data, valid: undefined };
  }
  return { identity: identity.data, valid: { output: output.data, score } satisfies ValidTrial };
}

function rate(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

function summarizeGroup(group: Accumulator): EvalSummaryGroup {
  const trials = group.valid;
  const scores = trials.map(trial => trial.score);
  const passCount = trials.filter(trial => trial.output.passed).length;
  // Gateway-derived metrics come only from trials whose logs settled. Averaging in a trial that
  // reported no usage because it was never measured would understate every figure silently.
  const measured = trials.filter(trial => trial.output.usage.complete).map(trial => trial.output);
  return {
    taskId: group.taskId,
    taskTitle: group.taskTitle,
    expectation: group.expectation,
    model: group.model,
    validTrials: trials.length,
    invalidTrials: group.invalid,
    passCount,
    passRate: rate(passCount, trials.length),
    passRateInterval: wilsonInterval(passCount, trials.length),
    meanScore: trials.length === 0 ? null : mean(scores),
    scoreSampleSd: sampleStandardDeviation(scores),
    scoreMeanInterval: tMeanInterval(scores),
    tokens: metricDistribution(measured.map(output => output.usage.totalTokens)),
    modelDurationMs: metricDistribution(measured.map(output => output.usage.durationMs)),
    wallDurationMs: metricDistribution(trials.map(trial => trial.output.wallDurationMs)),
    costUsd: metricDistribution(measured.map(output => output.usage.costUsd)),
    telemetryCompleteRate: rate(measured.length, trials.length),
    toolFailureRate: rate(
        trials.filter(trial => trial.output.diagnostics.toolErrors.length > 0).length, trials.length),
    modelFailureRate: rate(
        measured.filter(output => output.usage.failedRequests > 0).length, measured.length),
    agentErrorRate: rate(
        trials.filter(trial => trial.output.diagnostics.agentErrors.length > 0).length,
        trials.length),
  };
}

/** Reduces vitest-evals report metadata into per-task, per-model groups. */
export function summarizeVitestReport(report: VitestJsonReport): EvalSummary {
  const groups = new Map<string, Accumulator>();
  const seenRunIds = new Set<string>();
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      const trial = readTrial(assertion);
      if (trial === undefined) continue;
      const { identity } = trial;
      if (seenRunIds.has(identity.runId)) {
        throw new Error(`Duplicate Workshop eval run ID ${identity.runId}`);
      }
      seenRunIds.add(identity.runId);
      const key = `${identity.expectation}\u0000${identity.taskId}\u0000${identity.model}`;
      const group = groups.get(key) ?? { ...identity, valid: [], invalid: 0 };
      if (trial.valid === undefined) group.invalid++;
      else group.valid.push(trial.valid);
      groups.set(key, group);
    }
  }
  return {
    version: 1,
    groups: [...groups.values()].map(summarizeGroup).toSorted((left, right) =>
      left.expectation.localeCompare(right.expectation) ||
      left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model)),
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function interval(bounds: ConfidenceInterval | null): string {
  return bounds === null ? ""
    : `[${(bounds.low * 100).toFixed(0)}, ${(bounds.high * 100).toFixed(0)}]`;
}

function tokens(distribution: MetricDistribution | null): string {
  return distribution === null ? "n/a" : `${(distribution.mean / 1_000).toFixed(1)}k`;
}

function seconds(distribution: MetricDistribution | null): string {
  return distribution === null ? "n/a" : `${(distribution.p50 / 1_000).toFixed(0)}s`;
}

function cost(distribution: MetricDistribution | null): string {
  return distribution === null ? "n/a" : `$${distribution.mean.toFixed(4)}`;
}

const HEADERS = [
  "Task", "Model", "Pass", "95% CI", "Score", "Tokens", "Wall p50", "Cost", "Tool fail", "Invalid",
] as const;

function row(group: EvalSummaryGroup): string[] {
  return [
    group.taskTitle,
    group.model,
    `${group.passCount}/${group.validTrials}`,
    interval(group.passRateInterval),
    group.meanScore === null ? "n/a" : group.meanScore.toFixed(2),
    tokens(group.tokens),
    seconds(group.wallDurationMs),
    cost(group.costUsd),
    percent(group.toolFailureRate),
    String(group.invalidTrials),
  ];
}

/** Renders an aligned table for a terminal, colouring each group by whether it fully passed. */
export function formatSummaryTable(summary: EvalSummary): string {
  if (summary.groups.length === 0) return "No Workshop eval results.\n";
  const rows = summary.groups.map(row);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map(entry => entry[column]?.length ?? 0)));
  const align = (cells: readonly string[]) => cells
      .map((cell, column) => column === 0 || column === 1
        ? cell.padEnd(widths[column] ?? 0)
        : cell.padStart(widths[column] ?? 0))
      .join("  ");
  const lines = [colors.bold(align(HEADERS)), colors.dim(align(widths.map(width => "-".repeat(width))))];
  for (const [index, group] of summary.groups.entries()) {
    const cells = align(rows[index] ?? []);
    const complete = group.passRate === 1 && group.invalidTrials === 0;
    lines.push(group.expectation === "frontier" ? colors.dim(cells)
      : complete ? colors.green(cells) : colors.red(cells));
  }
  const partial = summary.groups.filter(group => (group.telemetryCompleteRate ?? 1) < 1);
  if (partial.length > 0) {
    lines.push("", colors.yellow(
        `Token, time, and cost figures cover only the trials whose AI Gateway telemetry settled; ` +
        `${partial.length} group(s) are missing some or all of it.`));
  }
  return `${lines.join("\n")}\n`;
}

/** Renders the same table as Markdown, for a CI job summary. */
export function formatSummaryMarkdown(summary: EvalSummary): string {
  return [
    "# Workshop agent evals",
    "",
    "Pass counts fully-passing trials; the interval is Wilson 95%. Score is the mean fraction of",
    "checks passed. Frontier rows track capability the agent does not have yet and never gate CI.",
    "",
    `| ${HEADERS.join(" | ")} |`,
    `| ${HEADERS.map((_header, column) => column < 2 ? "---" : "---:").join(" | ")} |`,
    ...summary.groups.map(group => `| ${row(group).join(" | ")} |`),
    "",
  ].join("\n");
}

/** Reads a Vitest JSON report and writes `<name>.json`, `<name>.md`, and the terminal table. */
export async function writeEvalSummary(
    reportPath = resolve(EVAL_OUTPUT_DIR, "results.json"),
    name = "summary"): Promise<EvalSummary> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Workshop eval summary name must be lowercase alphanumeric with hyphens");
  }
  const jsonPath = resolve(EVAL_OUTPUT_DIR, `${name}.json`);
  // `eval:required` writes `required.json`, so summarising it under the name `required` would
  // destroy the report on the way out and leave nothing to re-reduce.
  if (jsonPath === resolve(reportPath)) {
    throw new Error(
        `Refusing to overwrite the report being summarized (${reportPath}); choose another name`);
  }
  const summary = summarizeVitestReport(await readVitestJsonReportFile(reportPath));
  await mkdir(EVAL_OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(resolve(EVAL_OUTPUT_DIR, `${name}.md`), formatSummaryMarkdown(summary)),
  ]);
  return summary;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const args = process.argv.slice(2).filter(argument => argument !== "--");
  const summary = await writeEvalSummary(
      args[0] === undefined ? undefined : resolve(args[0]), args[1]);
  process.stdout.write(formatSummaryTable(summary));
}
