import type { HarnessRun } from "@vitest-evals/core";
import { describe, expect, it } from "vitest";
import { ChecksScorer } from "./scorer.js";
import type { EvalCheck, EvalRunInput, EvalRunOutput } from "./task.js";

function output(...turns: EvalCheck[][]): EvalRunOutput {
  return {
    taskId: "task",
    taskTitle: "Task",
    expectation: "required",
    model: "model",
    trial: 0,
    runId: "run",
    workspaceId: "workspace",
    chatId: 1,
    turns: turns.map((checks, index) => ({
      index,
      checks,
      agentDurationMs: 0,
      verificationDurationMs: 0,
    })),
    passed: turns.every(checks => checks.every(check => check.pass)),
    gadgets: [],
    diagnostics: { modelTurns: 0, toolCalls: 0, toolErrors: [], agentErrors: [], blockedRequests: [], harnessWarnings: [] },
    usage: {
      complete: true,
      successfulRequests: 1,
      failedRequests: 0,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      durationMs: 1,
      costUsd: 0,
    },
    wallDurationMs: 1,
    transcript: { path: "t.json", sha256: "0".repeat(64), bytes: 1 },
  };
}

function assess(value: EvalRunOutput) {
  const run: HarnessRun<EvalRunOutput> = {
    output: value,
    session: { events: [] },
    usage: {},
    errors: [],
  };
  return ChecksScorer.assess({
    input: { model: "model", trial: 0, runId: "run" } satisfies EvalRunInput,
    output: value,
    toolCalls: [],
    run,
    session: run.session,
    harness: undefined,
  });
}

describe("ChecksScorer", () => {
  it("scores a fully passing run at one", async () => {
    const result = await assess(output([{ id: "a", pass: true }, { id: "b", pass: true }]));
    expect(result.score).toBe(1);
    expect(result.metadata?.rationale).toBe("all 2 checks passed");
  });

  it("gives partial credit and names what failed", async () => {
    const result = await assess(output([
      { id: "a", pass: true },
      { id: "b", pass: false, evidence: { expected: 5, actual: 4 } },
    ]));
    expect(result.score).toBe(0.5);
    expect(result.metadata?.rationale).toContain("1 of 2 checks failed: b");
    expect(result.metadata?.failed).toEqual([{ id: "b", evidence: { expected: 5, actual: 4 } }]);
  });

  it("scores a wholly failing run at zero", async () => {
    expect((await assess(output([{ id: "a", pass: false }]))).score).toBe(0);
  });

  it("counts checks across every turn", async () => {
    const result = await assess(output(
        [{ id: "a", pass: true }],
        [{ id: "b", pass: true }, { id: "c", pass: false }]));
    expect(result.score).toBeCloseTo(2 / 3, 10);
  });

  it("declines to score a failing run whose turn ended with an error", async () => {
    const value = output([{ id: "a", pass: true }, { id: "b", pass: false }]);
    value.diagnostics = {
      modelTurns: 6, toolCalls: 12, toolErrors: [],
      agentErrors: ["Stream ended without finish_reason"], blockedRequests: [], harnessWarnings: [],
    };
    const result = await assess(value);
    expect(result.score).toBeNull();
    expect(result.metadata?.rationale).toContain("cannot be attributed");
  });

  it("scores a run that hit a transient error and still delivered", async () => {
    const value = output([{ id: "a", pass: true }]);
    value.diagnostics = {
      modelTurns: 5, toolCalls: 9, toolErrors: [], agentErrors: ["500 status code (no body)"],
      blockedRequests: [], harnessWarnings: [],
    };
    expect((await assess(value)).score).toBe(1);
  });

  it("scores a failing run that ended cleanly, which is a real capability failure", async () => {
    const value = output([{ id: "a", pass: false }]);
    value.diagnostics = { modelTurns: 1, toolCalls: 9, toolErrors: [], agentErrors: [], blockedRequests: [], harnessWarnings: [] };
    expect((await assess(value)).score).toBe(0);
  });

  it("declines to score a task that recorded nothing", async () => {
    const result = await assess(output([]));
    expect(result.score).toBeNull();
    expect(result.metadata?.rationale).toContain("recorded no checks");
  });
});
