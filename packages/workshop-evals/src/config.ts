import { execFileSync } from "node:child_process";
import {
  SUGGESTED_MODELS, type AiModelProvider, type SuggestedModelId,
} from "@gadgets/workshop-shared/api";

/** A picker model resolved to the provider that serves it: SUGGESTED_MODELS is the eval catalog. */
export type EvalModel = { provider: AiModelProvider; model: SuggestedModelId };

/**
 * The model published baselines are measured on. Served only through an AI Gateway with an OpenAI
 * key; WORKSHOP_EVAL_MODELS selects another model, at the cost of comparability (see global-setup).
 */
export const DEFAULT_MODEL: SuggestedModelId = "gpt-5.6-luna";
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export type EvalIdentity = { gitCommit: string; taskVersion: string };
export type EvalMatrix = { models: SuggestedModelId[]; trials: number };

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

/** Parse the model and repetition controls before a trial can spend inference. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env): EvalMatrix {
  const models = commaList(environment.WORKSHOP_EVAL_MODELS ?? "")
      .map(modelId => resolveEvalModel(modelId).model);
  const rawTrials = environment.WORKSHOP_EVAL_TRIALS?.trim();
  const trials = rawTrials === undefined || rawTrials === "" ? 1 : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  return { models: models.length > 0 ? models : [DEFAULT_MODEL], trials };
}
