import type { HarnessRun, VitestJsonReport } from "@vitest-evals/core";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { EVAL_OUTPUT_DIR } from "./artifacts.js";
import {
  formatSummaryMarkdown, formatSummaryTable, summarizeVitestReport, writeEvalSummary,
} from "./summary.js";

type Overrides = {
  runId?: string;
  trial?: number;
  passed?: boolean;
  model?: string;
  taskId?: string;
  expectation?: "required" | "frontier";
  toolErrors?: { tool: string; message: string }[];
  agentErrors?: string[];
  complete?: boolean;
  failedRequests?: number;
};

type Identity = {
  taskId: string;
  taskTitle: string;
  expectation: "required" | "frontier";
  model: string;
  trial: number;
  runId: string;
};

function runOutput(overrides: Overrides = {}) {
  return {
    taskId: overrides.taskId ?? "task",
    taskTitle: "Splitter",
    expectation: overrides.expectation ?? "required",
    model: overrides.model ?? "model",
    trial: overrides.trial ?? 0,
    runId: overrides.runId ?? "run-0",
    passed: overrides.passed ?? true,
    diagnostics: {
      modelTurns: 3,
      toolCalls: 4,
      toolErrors: overrides.toolErrors ?? [],
      agentErrors: overrides.agentErrors ?? [],
      blockedRequests: [] as string[],
      harnessWarnings: [] as string[],
    },
    usage: {
      complete: overrides.complete ?? true,
      successfulRequests: 2,
      failedRequests: overrides.failedRequests ?? 0,
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
      durationMs: 100,
      costUsd: 0.1,
    },
    wallDurationMs: 1_000,
  };
}

function identity(output: ReturnType<typeof runOutput>): Identity {
  const { taskId, taskTitle, expectation, model, trial, runId } = output;
  return { taskId, taskTitle, expectation, model, trial, runId };
}

function harnessRun(output: ReturnType<typeof runOutput>): HarnessRun {
  return {
    output,
    artifacts: { identity: identity(output) },
    session: { events: [] },
    usage: {},
    errors: [],
  };
}

function assertion(output: ReturnType<typeof runOutput>, score: number | null) {
  return {
    ancestorTitles: [],
    fullName: "eval",
    title: "eval",
    status: "passed" as const,
    meta: {
      harness: { name: "workshop-agent", run: harnessRun(output) },
      ...(score === null ? {} : { eval: { avgScore: score, scores: [{ name: "checks", score }] } }),
    },
  };
}

function report(assertions: ReturnType<typeof assertion>[]): VitestJsonReport {
  return {
    numFailedTests: 0,
    numPassedTests: assertions.length,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: assertions.length,
    startTime: 0,
    success: true,
    testResults: [{ message: "", name: "eval", status: "passed", assertionResults: assertions }],
  };
}

describe("summarizeVitestReport", () => {
  it("aggregates repeated trials of one task and model", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a", trial: 0, passed: true }), 1),
      assertion(runOutput({ runId: "b", trial: 1, passed: false }), 0.5),
    ]));
    const group = summary.groups.at(0);
    expect(summary.groups).toHaveLength(1);
    expect(group?.validTrials).toBe(2);
    expect(group?.passCount).toBe(1);
    expect(group?.passRate).toBe(0.5);
    expect(group?.meanScore).toBe(0.75);
    expect(group?.tokens?.mean).toBe(10);
  });

  it("separates models into their own groups", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a", model: "one" }), 1),
      assertion(runOutput({ runId: "b", model: "two" }), 1),
    ]));
    expect(summary.groups.map(group => group.model)).toEqual(["one", "two"]);
  });

  it("counts a scoreless trial as invalid without discarding its group", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a" }), 1),
      assertion(runOutput({ runId: "b", trial: 1 }), null),
    ]));
    expect(summary.groups.at(0)?.validTrials).toBe(1);
    expect(summary.groups.at(0)?.invalidTrials).toBe(1);
    expect(summary.groups.at(0)?.passRate).toBe(1);
  });

  it("excludes unmeasured trials from Gateway-derived metrics", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a", complete: true }), 1),
      assertion(runOutput({ runId: "b", trial: 1, complete: false }), 1),
    ]));
    const group = summary.groups.at(0);
    expect(group?.validTrials).toBe(2);
    expect(group?.telemetryCompleteRate).toBe(0.5);
    // The mean is 10 (the measured trial), not 5 (averaging in an unmeasured zero).
    expect(group?.tokens?.mean).toBe(10);
    expect(group?.wallDurationMs?.mean).toBe(1_000);
  });

  it("has no Gateway metrics at all when nothing settled", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a", complete: false }), 1),
    ]));
    expect(summary.groups.at(0)?.tokens).toBeNull();
    expect(summary.groups.at(0)?.costUsd).toBeNull();
    expect(summary.groups.at(0)?.telemetryCompleteRate).toBe(0);
  });

  it("reports diagnostics as rates rather than verdicts", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({
        runId: "a",
        passed: true,
        toolErrors: [{ tool: "editFile", message: "no such file" }],
        agentErrors: ["ran out of turns"],
        failedRequests: 1,
      }), 1),
      assertion(runOutput({ runId: "b", trial: 1, passed: true }), 1),
    ]));
    const group = summary.groups.at(0);
    expect(group?.passRate).toBe(1);
    expect(group?.toolFailureRate).toBe(0.5);
    expect(group?.agentErrorRate).toBe(0.5);
    expect(group?.modelFailureRate).toBe(0.5);
  });

  it("rejects a duplicated run ID rather than double-counting it", () => {
    expect(() => summarizeVitestReport(report([
      assertion(runOutput({ runId: "same" }), 1),
      assertion(runOutput({ runId: "same", trial: 1 }), 1),
    ]))).toThrow("Duplicate Workshop eval run ID");
  });

  it("sorts frontier groups after required ones", () => {
    const summary = summarizeVitestReport(report([
      assertion(runOutput({ runId: "f", taskId: "z", expectation: "frontier" }), 1),
      assertion(runOutput({ runId: "r" }), 1),
    ]));
    expect(summary.groups.map(group => group.expectation)).toEqual(["frontier", "required"]);
  });
});

describe("writeEvalSummary", () => {
  it("refuses to overwrite the report it is summarizing", async () => {
    await expect(writeEvalSummary(resolve(EVAL_OUTPUT_DIR, "required.json"), "required"))
        .rejects.toThrow("Refusing to overwrite");
  });
});

describe("rendering", () => {
  const summary = summarizeVitestReport(report([
    assertion(runOutput({ runId: "a", passed: true }), 1),
    assertion(runOutput({ runId: "b", trial: 1, passed: false }), 0),
  ]));

  it("renders an aligned table naming the task and model", () => {
    const table = formatSummaryTable(summary);
    expect(table).toContain("Splitter");
    expect(table).toContain("1/2");
  });

  it("warns when telemetry did not settle", () => {
    const partial = summarizeVitestReport(report([
      assertion(runOutput({ runId: "a", complete: false }), 1),
    ]));
    expect(formatSummaryTable(partial)).toContain("telemetry settled");
  });

  it("renders Markdown with one row per group", () => {
    const markdown = formatSummaryMarkdown(summary);
    expect(markdown).toContain("| Task | Model |");
    expect(markdown.split("\n").filter(line => line.startsWith("| Task |"))).toHaveLength(1);
  });

  it("says so when there is nothing to report", () => {
    expect(formatSummaryTable({ version: 1, groups: [] })).toContain("No Workshop eval results");
  });
});

describe("diagnostics reporting", () => {
  it("reports model turns and tool calls as distributions", () => {
    const first = runOutput({ runId: "a" });
    first.diagnostics.modelTurns = 4;
    first.diagnostics.toolCalls = 9;
    const second = runOutput({ runId: "b", trial: 1 });
    second.diagnostics.modelTurns = 8;
    second.diagnostics.toolCalls = 21;
    const summary = summarizeVitestReport(report([assertion(first, 1), assertion(second, 1)]));
    expect(summary.groups.at(0)?.modelTurns?.mean).toBe(6);
    expect(summary.groups.at(0)?.toolCalls?.mean).toBe(15);
  });

  it("reports the fraction of trials that tried to reach a blocked host", () => {
    const reached = runOutput({ runId: "a" });
    reached.diagnostics.blockedRequests = ["GET https://example.test/docs"];
    const summary = summarizeVitestReport(report([
      assertion(reached, 1),
      assertion(runOutput({ runId: "b", trial: 1 }), 1),
    ]));
    expect(summary.groups.at(0)?.blockedRequestRate).toBe(0.5);
  });
});
