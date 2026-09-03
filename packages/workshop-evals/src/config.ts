import { execFileSync } from "node:child_process";
import {
  SUGGESTED_MODELS, type AiModelProvider, type SuggestedModelId,
} from "@gadgets/workshop-shared/api";

/** A model ID: catalog IDs autocomplete, but WORKSHOP_EVAL_MODELS may name any model. */
export type EvalModelId = SuggestedModelId | (string & {});
/** A model resolved to the provider that serves it. */
export type EvalModel = { provider: AiModelProvider; model: string };

// The default must be a Workers AI catalog model so it runs in both direct and gateway mode.
const DEFAULT_MODELS: readonly SuggestedModelId<"cloudflare">[] =
  ["@cf/deepseek-ai/deepseek-v4-pro-0813"];
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export const EVAL_AGENT_BUDGET_MS = 28 * 60_000;
export const EVAL_VERIFICATION_BUDGET_MS = 2 * 60_000;
export const EVAL_TEST_TIMEOUT_MS = 40 * 60_000;
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

/**
 * Resolve a model ID to the provider listed for it in SUGGESTED_MODELS. Unlisted IDs fall back
 * to Workers AI (every Workers AI ID is `@cf/...`, and cloudflare is the only provider the direct
 * transport serves), so an unknown model runs exactly as a catalog Workers AI model does.
 */
export function resolveEvalModel(modelId: string): EvalModel {
  for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
    if (Object.hasOwn(models, modelId)) {
      return { provider: provider as AiModelProvider, model: modelId };
    }
  }
  return { provider: "cloudflare", model: modelId };
}

/** Parse the model and repetition controls before a trial can spend inference. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env): EvalMatrix {
  const models = commaList(environment.WORKSHOP_EVAL_MODELS ?? "");
  const rawTrials = environment.WORKSHOP_EVAL_TRIALS?.trim();
  const trials = rawTrials === undefined || rawTrials === "" ? 1 : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  return { models: models.length > 0 ? models : [...DEFAULT_MODELS], trials };
}
