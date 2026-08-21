import { AgentSession, type AgentSourceSnapshot } from "@gadgets/integration-tests/agent-session";
import { startHarness, type WorkerConfig } from "@gadgets/integration-tests/harness";
import { NetworkInterceptor } from "@gadgets/integration-tests/network-interceptor";
import type { AiChatMessage, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { createHarness } from "vitest-evals";
import { runDirectory, slug, writeArtifact } from "./artifacts.js";
import { agentTurnTimeoutMs } from "./timeouts.js";
import {
  collectAgentGatewayUsage, type GatewayConfig, incompleteGatewayUsage, parseGatewayEnvironment,
  usesDirectWorkersAi,
} from "./gateway-logs.js";
import { findSandboxViolations, type SandboxViolation } from "./source-checks.js";
import { canonicalTranscript, collectDiagnostics } from "./transcript.js";
import type {
  EvalArtifact, EvalGadgetSource, EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult,
} from "./task.js";
import { EvalVerifier } from "./verifier.js";

// The only hosts a trial may reach. Everything else throws, which keeps a result reproducible and
// keeps a prompt from leaving for a third party: the agent's `webFetch` tool is always available to
// it, and would otherwise reach the live internet from inside a trial. A blocked attempt lands in the
// trial's tool errors, so it is visible rather than silent.
const MODEL_HOSTS = ["api.cloudflare.com", "gateway.ai.cloudflare.com"];

/** Stands in for an artifact whose write failed, so the report never claims a file that is absent. */
const MISSING_ARTIFACT: EvalArtifact = { path: "", sha256: "", bytes: 0 };

/**
 * Runs `operation`, reducing a failure to `fallback` and a recorded warning.
 *
 * Everything this wraps happens *after* the last check is recorded, so a Gateway 500 or a disk
 * error here says nothing about the agent. Letting it throw would void a trial whose verdict was
 * already known — and a voided trial silently leaves the pass rate.
 */
async function tolerate<T>(
    what: string, warnings: string[], fallback: T, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    warnings.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function workshopConfig(config: WorkerConfig, gateway: GatewayConfig, direct: boolean): void {
  if (direct) return;
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: gateway.gatewayId,
    CF_AI_GATEWAY_ACCOUNT_ID: gateway.accountId,
    CF_AI_GATEWAY_API_TOKEN: gateway.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
  };
}

async function captureSource(
    snapshot: AgentSourceSnapshot,
    workpieces: readonly WorkpieceSummary[],
    directory: string,
    violations: SandboxViolation[]): Promise<EvalGadgetSource[]> {
  const gadgets: EvalGadgetSource[] = [];
  for (const workpiece of workpieces) {
    if (workpiece.type !== "gadget") continue;
    const gadget: EvalGadgetSource = { id: workpiece.id, title: workpiece.title, files: [] };
    gadgets.push(gadget);
    const source = workpiece.filesRoot === undefined
      ? undefined
      : snapshot.workpieces.get(workpiece.filesRoot);
    if (source === undefined) continue;
    violations.push(...findSandboxViolations(source.files));
    for (const [name, contents] of source.files) {
      gadget.files.push(await writeArtifact(
          `${directory}/source/${slug(workpiece.title)}/${slug(name)}`, contents));
    }
  }
  return gadgets;
}

/**
 * Builds the live harness for one task: a fresh workerd Workshop, a fresh account and workspace,
 * and the task's prompts run in order against the production agent.
 *
 * Each repetition gets its own Workshop, because the alternative — reusing one across trials —
 * would let a task leak state into the next and make repeated trials no longer independent.
 */
export function createWorkshopHarness(task: EvalTask) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal, setArtifact }) => {
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      setArtifact("identity", {
        taskId: task.id,
        taskTitle: task.title,
        expectation: task.expectation,
        model: input.model,
        trial: input.trial,
        runId: input.runId,
      });
      const gateway = parseGatewayEnvironment();
      const direct = usesDirectWorkersAi();
      const network = new NetworkInterceptor([], { passThroughHosts: MODEL_HOSTS });
      network.install();
      const harness = await startHarness({
        gatekeepers: [...(task.gatekeepers ?? [])],
        enableGadgetExecution: true,
        patchWorkshop: config => workshopConfig(config, gateway, direct),
      });
      let disposable: AgentSession | undefined;
      try {
        const session = await AgentSession.create(harness.url, {
          modelId: input.model,
          ambientVendors: task.ambientVendors,
          ...(direct ? {
            userModel: {
              profile: { type: "agent", id: input.model, name: input.model },
              config: {
                provider: "cloudflare",
                model: input.model,
                accountId: gateway.accountId,
                apiToken: gateway.apiToken,
              },
            },
          } : {}),
          usernamePrefix: "eval",
          timeoutMs: agentTurnTimeoutMs(task.turns.length),
        });
        disposable = session;
        // Before the first prompt, so the agent's system prompt reliably carries the deployment's
        // standard output formats rather than racing their fire-and-forget install.
        await session.waitForOutputFormats();
        await task.prepare?.(session);

        const turns: EvalTurnResult[] = [];
        let history: readonly AiChatMessage[] = [];
        let workpieces: readonly WorkpieceSummary[] = [];
        let chatId: number | undefined;
        for (const [index, turn] of task.turns.entries()) {
          const agentStartedAt = Date.now();
          const result = await session.run(turn.prompt, { signal });
          const agentDurationMs = Date.now() - agentStartedAt;
          ({ chatId, history, workpieces } = result);

          const verificationStartedAt = Date.now();
          const verifier = new EvalVerifier(session, result.chatId, result.workpieces);
          turns.push({
            index,
            checks: await verifier.collect(turn.verify),
            agentDurationMs,
            verificationDurationMs: Date.now() - verificationStartedAt,
          });
        }
        if (chatId === undefined) throw new Error(`Eval task ${task.id} declared no turns`);

        const directory = runDirectory(task.id, input.model, input.trial);
        const events = canonicalTranscript(history);
        const diagnostics = collectDiagnostics(history);
        diagnostics.blockedRequests = network.getUnmockedCalls().slice(0, 50);
        const warnings = diagnostics.harnessWarnings;
        const transcript = await tolerate("transcript", warnings, MISSING_ARTIFACT, () =>
          writeArtifact(`${directory}/transcript.json`, `${JSON.stringify({ events }, null, 2)}\n`));
        const gadgets = await tolerate("source capture", warnings, [], async () =>
          captureSource(
              await session.acceptChanges(), workpieces, directory, diagnostics.sandboxViolations));
        const usage = direct
          ? incompleteGatewayUsage()
          : await tolerate("gateway telemetry", warnings, incompleteGatewayUsage(), () =>
            collectAgentGatewayUsage(
                gateway, { workspaceId: session.workspaceId, chatId }, { startDate: startedAtIso }));

        const checks = turns.flatMap(entry => entry.checks);
        const output: EvalRunOutput = {
          taskId: task.id,
          taskTitle: task.title,
          expectation: task.expectation,
          model: input.model,
          trial: input.trial,
          runId: input.runId,
          workspaceId: session.workspaceId,
          chatId,
          turns,
          passed: checks.length > 0 && checks.every(check => check.pass),
          gadgets,
          diagnostics,
          usage,
          wallDurationMs: Date.now() - startedAt,
          transcript,
        };
        return {
          output,
          events,
          usage: {
            provider: "cloudflare-ai-gateway",
            model: input.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            metadata: {
              complete: usage.complete,
              successfulRequests: usage.successfulRequests,
              failedRequests: usage.failedRequests,
              durationMs: usage.durationMs,
              costUsd: usage.costUsd,
            },
          },
          timings: { totalMs: output.wallDurationMs },
          artifacts: { transcript, gadgets },
          errors: diagnostics.agentErrors.map(message => ({ name: "AgentError", message })),
          metadata: { taskId: task.id, expectation: task.expectation, chatId },
        };
      } finally {
        disposable?.[Symbol.dispose]();
        await harness.server.close();
        network.uninstall();
      }
    },
  });
}
