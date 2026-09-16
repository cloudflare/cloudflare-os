// The Vitest JSON report `pnpm evals` writes, as far as the comparator and the trajectory renderer
// read it. Everything is `.loose()`: the reporter adds fields freely and only these are relied on.
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
  if (trials(parsed.data.testResults).length === 0) {
    throw new Error(`${name} results contain no evals`);
  }
  return parsed.data.testResults;
}

/** Every trial in the report, in file order. */
export function trials(files: EvalFile[]): Assertion[] {
  return files.flatMap(file => file.assertionResults);
}
