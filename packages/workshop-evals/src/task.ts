import { createHash } from "node:crypto";
import type { AgentTurnOutcome } from "@gadgets/integration-tests/agent-session";
import type { GadgetFocus, GatewayModelSettings } from "@gadgets/workshop-shared/api";
import type { JsonValue } from "vitest-evals";
import { z } from "zod";
import type { EvalVerifier } from "./verifier.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.json();

/** Anything JSON-serialisable, as check evidence, with a type that says so. */
export function asEvidence(value: unknown): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

export type EvalCheckOutcome = {
  pass: boolean;
  evidence?: JsonValue;
};

export type EvalCheck = {
  id: string;
  pass: boolean;
  evidence?: JsonValue;
};

/** An Agent Skill the user writes in their Skills library. */
export type EvalSkill = {
  /**
   * Its name, also its directory: lowercase letters and digits, in words joined by single hyphens,
   * at most 64 characters.
   */
  name: string;
  /** What it is for, at most 1024 characters, which the Skills catalog shows the agent. */
  description: string;
  /** The body of its SKILL.md, after the frontmatter. */
  instructions: string;
};

const THING_URL = /https:\/\/gadgets-test\.example\/things\/[\w-]+/g;

/**
 * The link to the Test Thing called `name`: a connection that holds a number, which the agent
 * reads and asks to set (see gatekeeper-test in integration-tests). In a prompt it is a link the
 * user pasted, which binds the Test Thing in the chat.
 */
export const thingUrl = (name: string) => `https://gadgets-test.example/things/${name}`;

/** Where the Test Things linked in `prompt` stand in it. */
export const linkedThings = (prompt: string) =>
    [...prompt.matchAll(THING_URL)].map(({ 0: url, index }) => ({ url, position: index }));

/**
 * The Test Thing the user was viewing beside the chat when they sent a prompt, and the spot its
 * UI reported there. Viewing it binds nothing: the chat holds it only if a prompt linked it.
 */
export type EvalFocus = { url: string; spot?: GadgetFocus };

export type EvalTurn = {
  /** Skills the user adds to their Skills library before sending `prompt`, turning Skills on. */
  skills?: readonly EvalSkill[];
  prompt: string;
  focus?: EvalFocus;
  verify(verifier: EvalVerifier): Promise<void>;
  /** Commit this turn, reload its Gadgets, then run these checks. */
  verifyAfterAccept?(verifier: EvalVerifier): Promise<void>;
};

/** Whether a task's turns involve a Test Thing, so that its Workshop needs their gatekeeper. */
export const usesThings = (task: EvalTask) =>
    task.turns.some(turn => turn.focus !== undefined || linkedThings(turn.prompt).length > 0);

export type EvalTask = {
  id: string;
  /**
   * What the deployment's admin sets for the task's model before any trial starts (see
   * AdminApi.setGatewayModelSettings). Only an AI Gateway deployment has such settings.
   */
  modelSettings?: GatewayModelSettings;
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

/**
 * Hash what the agent was asked to do: each turn's prompt, the skills it adds and what the user
 * was viewing, and the model settings it runs under.
 */
export function taskVersion(task: EvalTask): string {
  const turns = task.turns.map(({ prompt, skills, focus }) => ({ prompt, skills, focus }));
  return createHash("sha256")
      .update(JSON.stringify(task.modelSettings === undefined
        ? turns : { turns, modelSettings: task.modelSettings }))
      .digest("hex");
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
