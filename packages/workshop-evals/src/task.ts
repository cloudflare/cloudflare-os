import { createHash } from "node:crypto";
import type { AgentTurnOutcome } from "@gadgets/integration-tests/agent-session";
import type { JsonValue } from "vitest-evals";
import type { EvalVerifier } from "./verifier.js";

export type EvalCheckOutcome = {
  pass: boolean;
  evidence?: JsonValue;
};

export type EvalCheck = {
  id: string;
  pass: boolean;
  evidence?: JsonValue;
};

export type EvalTurn = {
  prompt: string;
  verify(verifier: EvalVerifier): Promise<void>;
};

export type EvalTask = {
  id: string;
  turns: readonly [EvalTurn, ...EvalTurn[]];
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate one task before it can spend inference. */
export function defineEvalTask(task: EvalTask): EvalTask {
  if (!ID_PATTERN.test(task.id)) throw new Error(`Invalid eval task ID ${JSON.stringify(task.id)}`);
  task.turns.forEach((turn, index) => {
    if (turn.prompt.trim() === "") throw new Error(`Eval task ${task.id} turn ${index} is empty`);
  });
  return task;
}

/** Hash the prompts that define what the agent was asked to do. */
export function taskVersion(task: EvalTask): string {
  return createHash("sha256").update(JSON.stringify(task.turns.map(turn => turn.prompt))).digest("hex");
}

export type EvalRunInput = {
  model: string;
  trial: number;
};

export type EvalTurnResult = {
  outcome: AgentTurnOutcome;
  checks: EvalCheck[];
  turnWallMs: number;
  verificationWallMs: number;
};

export type EvalRunOutput = {
  success: boolean;
  turns: EvalTurnResult[];
  metrics: {
    modelTurns: number;
    toolCalls: number;
    toolErrors: number;
  };
};
