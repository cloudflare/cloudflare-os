import type { AgentTurnResult } from "@gadgets/integration-tests/agent-session";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import {
  attachHarnessRunToError, createHarness, normalizeHarnessRun, type JsonValue,
  type TranscriptEvent,
} from "vitest-evals";
import { EVAL_AGENT_BUDGET_MS, EVAL_VERIFICATION_BUDGET_MS } from "./budgets.js";
import { resolveEvalModel, type EvalIdentity } from "./config.js";
import type { EvalCheck, EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult } from "./task.js";
import { measureHistory, toTranscriptEvents } from "./transcript.js";
import {
  openLocalEvalTarget, type LocalEvalTarget, type LocalModelAccess,
} from "./target.js";
import { EvalVerifier } from "./verifier.js";

class EvalDeadlineError extends Error {}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new EvalDeadlineError(message)), timeoutMs);
  expired.promise.catch(() => {});
  operation.catch(() => {});
  try {
    return await Promise.race([operation, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function beforeDeadline<T>(
    start: () => Promise<T>, deadline: number, message: string,
    signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new EvalDeadlineError("Eval run was cancelled");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new EvalDeadlineError(message);
  const operation = withTimeout(start(), remaining, message);
  if (signal === undefined) return operation;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(new EvalDeadlineError("Eval run was cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  aborted.promise.catch(() => {});
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Run one real Workshop task and retain its functional result and trajectory. */
export function createWorkshopHarness(
    task: EvalTask, access: LocalModelAccess, identity: EvalIdentity) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal }) => {
      const turns: EvalTurnResult[] = [];
      let history: AiChatMessage[] = [];
      let usage: AgentTurnResult["usage"] = {};
      let opened: LocalEvalTarget | undefined;
      let runError: Error | undefined;
      let cleanupError: Error | undefined;
      let unrecordedPrompt: string | undefined;
      const model = resolveEvalModel(input.model);

      try {
        const agentTurnBudget = Math.floor(EVAL_AGENT_BUDGET_MS / task.turns.length);
        const verificationBudget = Math.floor(EVAL_VERIFICATION_BUDGET_MS / task.turns.length);
        opened = await openLocalEvalTarget(access, model, agentTurnBudget);

        for (const turn of task.turns) {
          const turnStartedAt = Date.now();
          const previousSequence = history.at(-1)?.sequence ?? -1;
          unrecordedPrompt = turn.prompt;
          const running = opened.session.runTurn(turn.prompt, {
            timeoutMs: agentTurnBudget,
            signal,
          });
          const result = await withTimeout(
              running, agentTurnBudget + verificationBudget,
              "Agent turn and canonical snapshot exceeded their time budget");
          const turnWallMs = Date.now() - turnStartedAt;
          if (result.history.some(message =>
            message.sequence > previousSequence && message.type === "message" &&
            message.author.type === "user" && message.message === turn.prompt)) {
            unrecordedPrompt = undefined;
          }
          if (result.history.length > 0) history = result.history;
          const cumulativeCost = result.usage.observedCumulativeChatCostUsd ??
            usage.observedCumulativeChatCostUsd;
          usage = {};
          if (result.usage.lastStepTokens !== undefined) {
            usage.lastStepTokens = result.usage.lastStepTokens;
          }
          if (cumulativeCost !== undefined) {
            usage.observedCumulativeChatCostUsd = cumulativeCost;
          }
          const verificationStartedAt = Date.now();
          const verificationDeadline = verificationStartedAt + verificationBudget;
          if (result.outcome.status !== "completed" || signal?.aborted) {
            runError = new EvalDeadlineError(
                result.outcome.status === "completed"
                  ? "Eval run was cancelled"
                  : result.outcome.message);
            turns.push({
              outcome: result.outcome,
              checks: [],
              turnWallMs,
              verificationWallMs: 0,
            });
            break;
          }
          const verifier = new EvalVerifier(opened.session, result.workpieces);
          let checks: EvalCheck[];
          try {
            checks = await beforeDeadline(
                () => verifier.collect(turn.verify), verificationDeadline,
                "Eval verification exceeded its time budget", signal);
          } catch (error) {
            checks = [...verifier.results(), {
              id: "verifier.timeout",
              pass: false,
              evidence: error instanceof Error ? error.message : String(error),
            }];
            turns.push({
              outcome: result.outcome,
              checks,
              turnWallMs,
              verificationWallMs: Date.now() - verificationStartedAt,
            });
            throw error;
          }

          if (checks.some(check => !check.pass)) {
            turns.push({
              outcome: result.outcome,
              checks,
              turnWallMs,
              verificationWallMs: Date.now() - verificationStartedAt,
            });
            break;
          }

          const verifyAfterAccept = turn.verifyAfterAccept;
          if (result.outcome.status === "completed" && verifyAfterAccept !== undefined) {
            const hasChangesToReload = result.history.some(message =>
              message.sequence > previousSequence && message.type === "changes");
            if (!hasChangesToReload) {
              checks.push({
                id: "accept.no-changes",
                pass: false,
                evidence: "Post-accept verification requires a new code change to reload.",
              });
              turns.push({
                outcome: result.outcome,
                checks,
                turnWallMs,
                verificationWallMs: Date.now() - verificationStartedAt,
              });
              break;
            }
            const session = opened.session;
            try {
              await beforeDeadline(
                  () => session.acceptChanges(), verificationDeadline,
                  "Accepting verified agent changes exceeded its time budget", signal);
            } catch (error) {
              checks.push({
                id: "accept.failed",
                pass: false,
                evidence: error instanceof Error ? error.message : String(error),
              });
              turns.push({
                outcome: result.outcome,
                checks,
                turnWallMs,
                verificationWallMs: Date.now() - verificationStartedAt,
              });
              throw error;
            }

            const afterAccept = new EvalVerifier(session, result.workpieces);
            try {
              checks.push(...await beforeDeadline(
                  () => afterAccept.collect(verifyAfterAccept), verificationDeadline,
                  "Post-accept verification exceeded its time budget", signal));
            } catch (error) {
              checks.push(...afterAccept.results(), {
                id: "post-accept-verifier.timeout",
                pass: false,
                evidence: error instanceof Error ? error.message : String(error),
              });
              turns.push({
                outcome: result.outcome,
                checks,
                turnWallMs,
                verificationWallMs: Date.now() - verificationStartedAt,
              });
              throw error;
            }
          }

          turns.push({
            outcome: result.outcome,
            checks,
            turnWallMs,
            verificationWallMs: Date.now() - verificationStartedAt,
          });
          if (result.outcome.status !== "completed") break;
        }
      } catch (error) {
        runError = error instanceof Error ? error : new Error(String(error));
      }

      if (opened !== undefined) {
        try {
          await opened[Symbol.asyncDispose]();
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
      }

      const metrics = measureHistory(history);
      const checks = turns.flatMap(turn => turn.checks);
      const success = runError === undefined && cleanupError === undefined &&
        turns.length === task.turns.length &&
        turns.every(turn => turn.outcome.status === "completed") &&
        checks.length > 0 && checks.every(check => check.pass);
      const usageMetadata: Record<string, JsonValue> = {};
      if (usage.lastStepTokens !== undefined) usageMetadata.lastStepTokens = usage.lastStepTokens;
      if (usage.observedCumulativeChatCostUsd !== undefined) {
        usageMetadata.observedCumulativeChatCostUsd = usage.observedCumulativeChatCostUsd;
      }
      const events: TranscriptEvent[] = toTranscriptEvents(history);
      if (unrecordedPrompt !== undefined) {
        events.push({
          type: "message",
          role: "user",
          content: unrecordedPrompt,
          metadata: { attempted: true },
        });
      }
      if (events.length === 0) {
        events.push({ type: "message", role: "user", content: task.turns[0].prompt });
      }
      const errors = history.flatMap(message =>
        message.type === "error" ? [{ name: "AgentError", message: message.message }] : []);
      if (runError !== undefined) errors.push({ name: "EvalRunError", message: runError.message });
      if (cleanupError !== undefined) {
        errors.push({ name: "EvalCleanupError", message: cleanupError.message });
      }
      for (const turn of turns) {
        if (turn.outcome.status === "timedOut") {
          errors.push({ name: "AgentTimeout", message: turn.outcome.message });
        }
      }
      const result = {
        output: { success, turns, metrics },
        events,
        usage: {
          provider: model.provider,
          model: input.model,
          toolCalls: metrics.toolCalls,
          metadata: usageMetadata,
        },
        errors,
        metadata: {
          taskId: task.id,
          target: "local",
          ...identity,
        },
      };

      if (runError !== undefined || cleanupError !== undefined) {
        const error = runError !== undefined && cleanupError !== undefined
          ? new AggregateError([runError, cleanupError], "Eval run and cleanup failed")
          : runError ?? cleanupError ?? new Error("Eval failed");
        throw attachHarnessRunToError(error, normalizeHarnessRun(input, result));
      }
      return result;
    },
  });
}
