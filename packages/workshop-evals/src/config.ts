import { execFileSync } from "node:child_process";
import {
  SUGGESTED_MODELS, type AiModelProvider, type SuggestedModelId,
} from "@gadgets/workshop-shared/api";
import type { JsonValue } from "vitest-evals";
import { z } from "zod";

/** A picker model resolved to the provider that serves it: SUGGESTED_MODELS is the eval catalog. */
export type EvalModel = { provider: AiModelProvider; model: SuggestedModelId };

/**
 * The model published baselines are measured on. Served only through an AI Gateway with an OpenAI
 * key; WORKSHOP_EVAL_MODELS or WORKSHOP_EVAL_TASK_OVERRIDES selects another model, at the cost of
 * comparability (see global-setup).
 */
export const DEFAULT_MODEL: SuggestedModelId = "gpt-6-luna";
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export type EvalIdentity = { gitCommit: string; taskVersion: string };
export type EvalMatrix = { models: SuggestedModelId[]; trials: number };

const TaskOverridesSchema = z.record(z.string(), z.strictObject({
  models: z.array(z.string()).min(1).optional(),
  trials: z.int().positive().optional(),
}));

function commaList(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function localGitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function localWorktreeDirty(): boolean {
  return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
}

/** Identify the checkout that supplied the local Workshop and eval code. */
export function resolveEvalCommit(
    environment: NodeJS.ProcessEnv = process.env,
    readLocalCommit: () => string = localGitCommit,
    isLocalWorktreeDirty: () => boolean = localWorktreeDirty): string {
  const configured = environment.WORKSHOP_EVAL_COMMIT?.trim() || environment.GITHUB_SHA?.trim();
  if (configured === undefined && isLocalWorktreeDirty()) {
    throw new Error(
      "Local evals require a clean worktree or an explicit WORKSHOP_EVAL_COMMIT");
  }
  const commit = configured ?? readLocalCommit();
  if (!GIT_SHA_PATTERN.test(commit)) {
    throw new Error("WORKSHOP_EVAL_COMMIT must be a full 40-character Git SHA");
  }
  return commit;
}

/** Resolve a model ID to the provider the catalog lists for it. */
export function resolveEvalModel(modelId: string): EvalModel {
  for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
    if (Object.hasOwn(models, modelId)) {
      return { provider: provider as AiModelProvider, model: modelId as SuggestedModelId };
    }
  }
  throw new Error(
    `Unknown eval model ${JSON.stringify(modelId)}: eval models must be listed in SUGGESTED_MODELS`);
}

function runMatrix(environment: NodeJS.ProcessEnv): EvalMatrix {
  const models = commaList(environment.WORKSHOP_EVAL_MODELS ?? "")
      .map(modelId => resolveEvalModel(modelId).model);
  const rawTrials = environment.WORKSHOP_EVAL_TRIALS?.trim();
  const trials = rawTrials === undefined || rawTrials === "" ? 1 : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  return { models: models.length > 0 ? models : [DEFAULT_MODEL], trials };
}

function taskOverrides(environment: NodeJS.ProcessEnv): Map<string, Partial<EvalMatrix>> {
  const raw = environment.WORKSHOP_EVAL_TASK_OVERRIDES?.trim();
  if (raw === undefined || raw === "") return new Map();
  let json: JsonValue;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error("WORKSHOP_EVAL_TASK_OVERRIDES is not valid JSON", { cause: error });
  }
  const parsed = TaskOverridesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`WORKSHOP_EVAL_TASK_OVERRIDES is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return new Map(Object.entries(parsed.data).map(([taskId, override]) => [taskId, {
    models: override.models?.map(modelId => resolveEvalModel(modelId).model),
    trials: override.trials,
  }]));
}

/**
 * Parse a task's models and trials before a trial can spend inference. WORKSHOP_EVAL_MODELS and
 * WORKSHOP_EVAL_TRIALS apply to every task; WORKSHOP_EVAL_TASK_OVERRIDES, a JSON object from task
 * id to `{ models?, trials? }`, replaces either for the tasks it names.
 */
export function evalMatrix(
    taskId: string, environment: NodeJS.ProcessEnv = process.env): EvalMatrix {
  const run = runMatrix(environment);
  const override = taskOverrides(environment).get(taskId);
  return { models: override?.models ?? run.models, trials: override?.trials ?? run.trials };
}

/** Every model the run-wide matrix or any task override names, validating both. */
export function evalModels(environment: NodeJS.ProcessEnv = process.env): SuggestedModelId[] {
  const run = runMatrix(environment);
  const overrides = [...taskOverrides(environment).values()];
  return [...new Set([run.models, ...overrides.map(override => override.models ?? [])].flat())];
}
