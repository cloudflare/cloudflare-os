import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentTurnOutcome, AgentTurnResult, WorkshopAgentSession,
} from "@gadgets/integration-tests/agent-session";
import type { AiChatMessage, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { EVAL_VERIFICATION_BUDGET_MS } from "./config.js";
import { createWorkshopHarness } from "./harness.js";
import type { LocalEvalTarget, LocalModelAccess } from "./target.js";
import type { EvalTask } from "./task.js";

const fakes = vi.hoisted(() => {
  let phaseDelayMs = 0;
  const outcome: AgentTurnOutcome = { status: "completed" };
  const workpieces: WorkpieceSummary[] = [{ id: 1, type: "gadget", title: "Gadget" }];
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 1,
    timestamp: new Date(),
    author: { type: "agent", id: "agent", name: "agent" },
    type: "message",
    message: "done",
  }, {
    chatId: 1,
    sequence: 2,
    timestamp: new Date(),
    author: { type: "agent", id: "agent", name: "agent" },
    type: "changes",
  }];
  const result: AgentTurnResult = { outcome, history, workpieces, usage: {} };
  const session: WorkshopAgentSession = {
    username: "agent",
    runTurn: async () => result,
    approveActionsAndWait: async () => result,
    listActions: async () => ({ entries: [] }),
    connectedAccount: () => { throw new Error("connectedAccount is not used by this test"); },
    openGadget: async () => { throw new Error("openGadget is not used by this test"); },
    acceptChanges: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, phaseDelayMs));
    }),
    close: async () => {},
    [Symbol.asyncDispose]: async () => {},
  };
  const target: LocalEvalTarget = {
    session,
    [Symbol.asyncDispose]: async () => {},
  };
  return { target, setPhaseDelay: (ms: number) => { phaseDelayMs = ms; } };
});

vi.mock("./target.js", () => ({
  openLocalEvalTarget: vi.fn(() => Promise.resolve(fakes.target)),
}));

const ACCESS: LocalModelAccess = {
  kind: "direct",
  accountId: "account",
  apiToken: "token",
};
const IDENTITY = { gitCommit: "a".repeat(40), taskVersion: "v1" };
const MODEL = "@cf/zai-org/glm-5.2";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("shares one deadline across verification, acceptance, and post-accept checks", async () => {
  vi.useFakeTimers();
  const phaseDelay = Math.floor(EVAL_VERIFICATION_BUDGET_MS * 0.4);
  fakes.setPhaseDelay(phaseDelay);
  const task: EvalTask = {
    id: "deadline",
    turns: [{
      prompt: "Build it",
      verify: async () => {
        await new Promise(resolve => setTimeout(resolve, phaseDelay));
      },
      verifyAfterAccept: async () => {
        await new Promise(resolve => setTimeout(resolve, phaseDelay));
      },
    }],
  };
  const harness = createWorkshopHarness(task, ACCESS, IDENTITY);
  const running = harness.run({ model: MODEL, trial: 1 }, {
    signal: undefined,
    artifacts: {},
    setArtifact: () => {},
  });
  const failure = expect(running)
    .rejects.toThrow("Post-accept verification exceeded its time budget");

  await vi.advanceTimersByTimeAsync(EVAL_VERIFICATION_BUDGET_MS + 1);
  await failure;
});

it("does not accept changes after a failed verification", async () => {
  fakes.setPhaseDelay(0);
  const task: EvalTask = {
    id: "failed-check",
    turns: [{
      prompt: "Build it",
      verify: async verifier => {
        await verifier.check("failed", () => Promise.resolve({ pass: false }));
      },
      verifyAfterAccept: async () => {},
    }],
  };
  const harness = createWorkshopHarness(task, ACCESS, IDENTITY);

  const result = await harness.run({ model: MODEL, trial: 1 }, {
    signal: undefined,
    artifacts: {},
    setArtifact: () => {},
  });

  expect(result.output.success).toBe(false);
  expect(fakes.target.session.acceptChanges).not.toHaveBeenCalled();
});
