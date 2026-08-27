import { execFileSync } from "node:child_process";

const DEFAULT_MODELS = ["@cf/deepseek-ai/deepseek-v4-pro-0813"];
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export const EVAL_AGENT_BUDGET_MS = 28 * 60_000;
export const EVAL_VERIFICATION_BUDGET_MS = 2 * 60_000;
export const EVAL_TEST_TIMEOUT_MS = 40 * 60_000;
export type EvalIdentity = { gitCommit: string; taskVersion: string };
export type EvalMatrix = { models: string[]; trials: number };

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
