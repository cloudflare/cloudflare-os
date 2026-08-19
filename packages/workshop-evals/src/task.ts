import type { JsonValue } from "@vitest-evals/core";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { EvalVerifier } from "./verifier.js";

/** Whether a task is expected to pass today, or tracks capability the agent does not yet have. */
export type EvalExpectation = "required" | "frontier";

/** Result of one deterministic observation: a bare verdict, or a verdict with supporting evidence. */
export type EvalCheckOutcome = boolean | {
  /** Whether the observable requirement held. */
  pass: boolean;
  /**
   * Evidence retained in the report, which the author should bound to what explains a failure.
   *
   * Deliberately untyped at this boundary: the useful thing to hand back is usually a value that
   * just came off an RPC stub, which carries `Disposable` and is not JSON. The framework converts
   * it, so an author never has to restate a result as a plain object.
   */
  evidence?: unknown;
};

/** One deterministic observation recorded while verifying a turn, after evidence is made JSON-safe. */
export type EvalCheck = {
  /** Identifier, unique within its task. */
  id: string;
  /** Whether the observable requirement held. */
  pass: boolean;
  /** Normalized author evidence, or the thrown message when the check body failed. */
  evidence?: JsonValue;
};

/** One prompt and the deterministic verification of what it produced. */
export type EvalTurn = {
  /** Prompt sent to the production Workshop agent. */
  prompt: string;
  /** Records observations about the resulting provisional branch. */
  verify(verifier: EvalVerifier): Promise<void>;
};

/** An authored evaluation case. */
export type EvalTask = {
  /** Stable identifier, unique across the suite. Lowercase letters, digits, and hyphens. */
  id: string;
  /** Human-readable title shown in reports. */
  title: string;
  /** Whether a failure is a regression or an expected frontier gap. */
  expectation: EvalExpectation;
  /**
   * Prompts run in order against one fresh workspace and one chat. Later turns see the earlier
   * turns' provisional changes, so a multi-turn task measures whether extending the work erodes
   * what already passed: re-check the earlier requirements in the later turn's verifier.
   */
  turns: readonly [EvalTurn, ...EvalTurn[]];
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates and returns one authored evaluation case.
 *
 * Authoring mistakes surface here rather than as a confusing run: an empty prompt would hang a
 * turn, and a malformed ID would split or collide with another task's aggregated statistics.
 */
export function defineEvalTask(task: EvalTask): EvalTask {
  if (!ID_PATTERN.test(task.id)) {
    throw new Error(`Eval task ID ${JSON.stringify(task.id)} must be lowercase kebab-case`);
  }
  if (task.title.trim() === "") {
    throw new Error(`Eval task ${task.id} needs a title`);
  }
  task.turns.forEach((turn, index) => {
    if (turn.prompt.trim() === "") {
      throw new Error(`Eval task ${task.id} turn ${index} has an empty prompt`);
    }
  });
  return task;
}

/** JSON-safe configuration identifying one repetition of one task. */
export type EvalRunInput = {
  /** Agent model, as listed by the fresh workspace's `listModels()`. */
  model: string;
  /** Zero-based repetition index. */
  trial: number;
  /** Identifier unique to this repetition, which the summary uses to reject double-counting. */
  runId: string;
};

/** A file written beside the run for post-hoc inspection. */
export type EvalArtifact = {
  /** Path relative to the package directory. */
  path: string;
  /** Lowercase SHA-256 digest of the file bytes. */
  sha256: string;
  /** Size in bytes. */
  bytes: number;
};

/** Checks and timings from one turn. */
export type EvalTurnResult = {
  /** Zero-based turn index. */
  index: number;
  /** Observations recorded by the turn's verifier. */
  checks: EvalCheck[];
  /** Wall time the agent took to settle. */
  agentDurationMs: number;
  /** Wall time verification took. */
  verificationDurationMs: number;
};

/** Accepted source of one Gadget the task produced. */
export type EvalGadgetSource = {
  /** Workspace-local workpiece ID. */
  id: WorkpieceId;
  /** Final display title. */
  title: string;
  /** One artifact per source file. */
  files: EvalArtifact[];
};

/**
 * What went wrong during a run, whether or not it changed the verdict.
 *
 * These never decide pass or fail: a task is scored on what the agent delivered, and an agent that
 * recovered from a failed tool call still succeeded. They explain *how* a run went, and their rates
 * across trials are the signal for platform bugs the checks alone would not surface.
 */
export type EvalDiagnostics = {
  /** Model turns the agent took, which is one assistant message each. */
  modelTurns: number;
  /** Tool calls the agent made. */
  toolCalls: number;
  /** Tool calls that returned an error, in order. */
  toolErrors: {
    /** Name of the tool that failed. */
    tool: string;
    /** Error text, truncated to keep reports bounded. */
    message: string;
  }[];
  /** Errors posted into canonical chat history, which end a turn without an answer. */
  agentErrors: string[];
  /**
   * Outbound requests the trial refused, as `METHOD url`.
   *
   * A trial may reach the model provider and nothing else. The agent's `webFetch` tool stays
   * available to it, so this records an attempt to use it rather than leaving the attempt silent.
   * A non-empty list means the result depended on something outside the trial.
   */
  blockedRequests: string[];
  /**
   * Failures in the harness's own bookkeeping after the last check was recorded — capturing source,
   * writing the transcript, reading Gateway logs. Recorded rather than thrown, because discarding a
   * finished trial over one of these would quietly remove it from the pass rate.
   */
  harnessWarnings: string[];
};

/** Provider-reported usage for one run's model requests, read back from AI Gateway logs. */
export type EvalUsage = {
  /** Whether logs settled with provider costs attached. False leaves the other fields unusable. */
  complete: boolean;
  /** Successful model requests. */
  successfulRequests: number;
  /** Failed model requests. */
  failedRequests: number;
  /** Provider input tokens. */
  inputTokens: number;
  /** Provider output tokens. */
  outputTokens: number;
  /** Input plus output tokens. */
  totalTokens: number;
  /** Summed model request duration, which excludes tool execution. */
  durationMs: number;
  /** Provider-reported cost. */
  costUsd: number;
};

/** Everything one repetition produced, stored in the Vitest report as task metadata. */
export type EvalRunOutput = {
  /** Stable task identifier. */
  taskId: string;
  /** Human-readable task title. */
  taskTitle: string;
  /** Whether a failure is a regression or an expected frontier gap. */
  expectation: EvalExpectation;
  /** Agent model used. */
  model: string;
  /** Zero-based repetition index. */
  trial: number;
  /** Identifier unique to this repetition. */
  runId: string;
  /** Fresh workspace the run used. */
  workspaceId: string;
  /** Chat all turns shared. */
  chatId: number;
  /** Per-turn checks and timings. */
  turns: EvalTurnResult[];
  /** Whether every check in every turn passed. */
  passed: boolean;
  /** Source of each Gadget, read after accepting the chat's changes. */
  gadgets: EvalGadgetSource[];
  /** What went wrong, whether or not it changed the verdict. */
  diagnostics: EvalDiagnostics;
  /** Provider-reported model usage. */
  usage: EvalUsage;
  /** End-to-end wall time, which includes workerd startup and verification. */
  wallDurationMs: number;
  /** Canonical transcript written for inspection. */
  transcript: EvalArtifact;
};
