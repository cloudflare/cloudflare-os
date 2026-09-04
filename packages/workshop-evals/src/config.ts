import { execFileSync } from "node:child_process";
import {
  SUGGESTED_MODELS, type AiModelProvider, type SuggestedModelId,
} from "@gadgets/workshop-shared/api";

/**
 * Models evals may run that the picker does not offer, each with the provider that serves it. The
 * eval catalog is SUGGESTED_MODELS plus this map: every picker model is an eval model, and a model
 * that is in neither is rejected rather than assigned a guessed provider.
 */
const EVAL_ONLY_MODELS = {
  // The backend's quick model: a cheap Workers AI model for smoke runs of the eval pipeline.
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "cloudflare",
} satisfies Record<string, AiModelProvider>;

/** A model ID from the eval catalog: SUGGESTED_MODELS or EVAL_ONLY_MODELS. */
export type EvalModelId = SuggestedModelId | (keyof typeof EVAL_ONLY_MODELS & string);
/** An eval catalog model resolved to the provider that serves it. */
export type EvalModel = { provider: AiModelProvider; model: EvalModelId };

// The default must be a Workers AI picker model so it runs in both direct and gateway mode.
const DEFAULT_MODELS: readonly SuggestedModelId<"cloudflare">[] =
  ["@cf/deepseek-ai/deepseek-v4-pro-0813"];
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export type EvalIdentity = { gitCommit: string; taskVersion: string };
export type EvalMatrix = { models: EvalModelId[]; trials: number };

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

/** Resolve a model ID to the provider the eval catalog lists for it. */
export function resolveEvalModel(modelId: string): EvalModel {
  for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
    if (Object.hasOwn(models, modelId)) {
      return { provider: provider as AiModelProvider, model: modelId as EvalModelId };
    }
  }
  if (Object.hasOwn(EVAL_ONLY_MODELS, modelId)) {
    const provider = EVAL_ONLY_MODELS[modelId as keyof typeof EVAL_ONLY_MODELS];
    return { provider, model: modelId as EvalModelId };
  }
  throw new Error(
    `Unknown eval model ${JSON.stringify(modelId)}: eval models must be listed in ` +
    "SUGGESTED_MODELS or EVAL_ONLY_MODELS");
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
  return { models: models.length > 0 ? models : [...DEFAULT_MODELS], trials };
}
