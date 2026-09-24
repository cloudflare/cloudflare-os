// The Vitest JSON report `pnpm evals` writes, as far as the comparator and the trajectory renderer
// read it, and which reports are clean enough to store for reuse. Everything is `.loose()`: the
// reporter adds fields freely and only these are relied on. Because it decides what is stored,
// this file is part of every eval result's cache key (scripts/evals/eval-keys.ts).
import { basename } from "node:path";
import { z } from "zod";
import type { JsonValue } from "vitest-evals";

const JsonSchema: z.ZodType<JsonValue> = z.json();

const TranscriptEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    role: z.enum(["system", "user", "assistant"]),
    content: JsonSchema.optional(),
    metadata: z.record(z.string(), JsonSchema).optional(),
  }).loose(),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), JsonSchema).optional(),
  }).loose(),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    name: z.string().optional(),
    content: JsonSchema.optional(),
    error: z.object({ name: z.string(), message: z.string() }).loose().optional(),
  }).loose(),
]);

const CheckSchema = z.object({
  id: z.string(),
  pass: z.boolean(),
  evidence: JsonSchema.optional(),
}).loose();

export const AssertionSchema = z.object({
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
          events: z.array(TranscriptEventSchema).default([]),
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
            outcome: z.object({ status: z.string(), message: z.string().optional() }).loose(),
            checks: z.array(CheckSchema).default([]),
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

export type Assertion = z.infer<typeof AssertionSchema>;
export type EvalFile = z.infer<typeof FileSchema>;
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

/** Parse one report; `name` labels the side in errors. */
export function parseResults(name: string, text: string): EvalFile[] {
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
  // Results are stored per eval file and compared per task id, so the two have to agree.
  for (const file of parsed.data.testResults) {
    const task = basename(file.name, ".eval.ts");
    for (const { meta } of file.assertionResults) {
      const { taskId } = meta.harness.run.session.metadata;
      if (taskId !== task) {
        throw new Error(`${basename(file.name)} runs task ${taskId}; its id must be ${task}`);
      }
    }
  }
  if (trials(parsed.data.testResults).length === 0) {
    throw new Error(`${name} results contain no evals`);
  }
  return parsed.data.testResults;
}

/** Every trial in the report, in file order. */
export function trials(files: EvalFile[]): Assertion[] {
  return files.flatMap(file => file.assertionResults);
}

/** One task's trials on one model. */
export type Cohort = {
  taskId: string;
  model: string;
  taskVersion: string;
  assertions: Assertion[];
};

function cohortKey(taskId: string, model: string): string {
  return JSON.stringify([taskId, model]);
}

/** Trials grouped by task and model, keyed by both. */
export function group(assertions: Assertion[]): Map<string, Cohort> {
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

/** Whether a trial failed for infrastructure reasons rather than because of the agent's work. */
export function hasInfrastructureFailure(assertion: Assertion): boolean {
  const run = assertion.meta.harness.run;
  if (run.output.turns.some(turn =>
    turn.outcome.status === "error" || turn.outcome.status === "cancelled")) return true;
  const names = new Set(run.errors.map(error => error.name));
  if (names.has("EvalCleanupError")) return true;
  const hasAgentOutcome = names.has("AgentError") || names.has("AgentTimeout");
  return names.has("EvalRunError") && !hasAgentOutcome;
}

/**
 * Reject a report that cannot be stored for reuse: every eval file must have run, every
 * task/model cohort must hold exactly `expectedTrials` trials, and no trial may have failed for
 * infrastructure reasons. Agent failures are legitimate results and pass.
 */
export function validateEvalResults(text: string, expectedTrials: number): void {
  const files = parseResults("these", text);
  for (const file of files) {
    if (file.assertionResults.length === 0) {
      throw new Error(`${basename(file.name)} ran no trials${file.message ? `: ${file.message}` : ""}`);
    }
  }
  const assertions = trials(files);
  singleCommit("these", assertions);
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
