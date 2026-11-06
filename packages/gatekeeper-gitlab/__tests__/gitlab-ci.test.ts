// Pure CI logic: GitLab statuses mapped to the phases callers poll on, the rule that decides
// whether a merge request's head pipeline ran for its current head, where CI configuration
// lives, which jobs' downstream pipelines open, failed-test extraction, and job-log lines.

import { readCiLog } from "@gadgets/gatekeeper-kit/ci";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fx from "./fixtures/gitlab-docs";
import {
  ciConfigLocation,
  ciPhase,
  ciStatus,
  failedTestCases,
  normalizeGitLabLogLine,
  normalizeJobSummary,
  normalizePipelineSummary,
  pipelineIsForHead,
  TEST_OUTPUT_MAX_CHARS,
} from "../src/gitlab-normalize";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("status and phase", () => {
  it("keeps polling through timers, callbacks, and after_script; stops on a person or a finish", () => {
    const phases = Object.fromEntries([
      "created", "waiting_for_resource", "preparing", "waiting_for_callback", "pending", "running",
      "canceling", "scheduled", "manual", "success", "failed", "canceled", "skipped",
    ].map(status => [status, ciPhase(ciStatus(status))]));
    expect(phases).toEqual({
      created: "active", waiting_for_resource: "active", preparing: "active", waiting_for_callback: "active",
      pending: "active", running: "active", canceling: "active", scheduled: "active",
      manual: "blocked",
      success: "done", failed: "done", canceled: "done", skipped: "done",
    });
  });

  it("reads a status GitLab adds later as unknown and blocked, and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pipeline = normalizePipelineSummary({ ...fx.pipelineResponse.data, status: "teleporting" });
    expect(pipeline).toMatchObject({ status: "unknown", phase: "blocked" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "ci.unknown_status", ciStatus: "teleporting" }));
  });
});

describe("pipelineIsForHead", () => {
  const HEAD = "a".repeat(40);
  const MERGE = "m".repeat(40);
  const never = async () => { throw new Error("parents must not be read"); };

  it("counts a pipeline on the head commit without reading anything", async () => {
    expect(await pipelineIsForHead({ sha: HEAD, ref: "feature" }, HEAD, "7", never)).toBe(true);
  });

  it("counts a merged-results pipeline whose merge commit has the head as a parent", async () => {
    const parents = vi.fn(async (sha: string) => sha === MERGE ? ["t".repeat(40), HEAD] : null);
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/7/merge" }, HEAD, "7", parents)).toBe(true);
    expect(parents).toHaveBeenCalledWith(MERGE);
  });

  it("counts a merge train pipeline whose train commit has the head as a parent", async () => {
    const parents = vi.fn(async (sha: string) => sha === MERGE ? ["t".repeat(40), HEAD] : null);
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/7/train" }, HEAD, "7", parents)).toBe(true);
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/8/train" }, HEAD, "7", never)).toBe(false);
  });

  it("does not count an earlier head's pipeline, merged-results or not", async () => {
    const earlier = "e".repeat(40);
    expect(await pipelineIsForHead({ sha: earlier, ref: "feature" }, HEAD, "7", never)).toBe(false);
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/7/merge" }, HEAD, "7",
      async () => ["t".repeat(40), earlier])).toBe(false);
    // Another merge request's merge ref, or a commit that cannot be read, does not count either.
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/8/merge" }, HEAD, "7", never)).toBe(false);
    expect(await pipelineIsForHead({ sha: MERGE, ref: "refs/merge-requests/7/merge" }, HEAD, "7", async () => null)).toBe(false);
  });
});

describe("ciConfigLocation", () => {
  it("defaults to .gitlab-ci.yml and treats another project's or a remote file as present", () => {
    expect(ciConfigLocation(undefined)).toEqual({ kind: "file", path: ".gitlab-ci.yml" });
    expect(ciConfigLocation("")).toEqual({ kind: "file", path: ".gitlab-ci.yml" });
    expect(ciConfigLocation("ci/pipeline.yml")).toEqual({ kind: "file", path: "ci/pipeline.yml" });
    expect(ciConfigLocation(".gitlab-ci.yml@group/ci-templates")).toEqual({ kind: "elsewhere" });
    expect(ciConfigLocation("https://example.com/ci.yml")).toEqual({ kind: "elsewhere" });
  });
});

describe("normalizeJobSummary", () => {
  const trigger = (projectId: number | undefined) => ({
    ...fx.triggerJobResponse.data,
    downstream_pipeline: { ...fx.triggerJobResponse.data.downstream_pipeline, project_id: projectId },
  }) as never;

  it("opens a trigger job's downstream pipeline only when it ran in the bound project", () => {
    expect(normalizeJobSummary(trigger(1), "trigger", 1).downstream).toEqual({ crossProject: false, pipelineId: "5" });
    expect(normalizeJobSummary(trigger(2), "trigger", 1).downstream).toEqual({ crossProject: true });
    // A row without the project id cannot be shown to be this project's.
    expect(normalizeJobSummary(trigger(undefined), "trigger", 1).downstream).toEqual({ crossProject: true });
  });
});

describe("failedTestCases", () => {
  const testCase = (status: string, name: string, output: { system_output?: string; stack_trace?: string } = {}) =>
    ({ ...fx.testReportResponse.data.test_suites[0].test_cases[0], status, name, system_output: null, stack_trace: null, ...output });

  it("keeps failed and errored cases only, joining their output once and cutting it to about 4 KiB", () => {
    const long = "x".repeat(TEST_OUTPUT_MAX_CHARS + 100);
    const cases = failedTestCases({
      test_suites: [
        { name: "unit", test_cases: [testCase("success", "ok"), testCase("failed", "breaks", { system_output: "boom", stack_trace: "boom" })] },
        { name: "e2e", test_cases: [testCase("skipped", "later"), testCase("error", "crashes", { system_output: long })] },
      ],
    });
    expect(cases.map(c => [c.suite, c.name, c.status])).toEqual([["unit", "breaks", "failed"], ["e2e", "crashes", "error"]]);
    expect(cases[0].output).toBe("boom");
    expect(cases[1].output!.startsWith("x".repeat(TEST_OUTPUT_MAX_CHARS))).toBe(true);
    expect(cases[1].output).toMatch(/\[output truncated\]$/);
    expect(cases[1].output!.length).toBeLessThan(TEST_OUTPUT_MAX_CHARS + 50);
  });
});

describe("normalizeGitLabLogLine", () => {
  const ESC = "\x1b";

  it("strips ANSI sequences and carriage-return overwrites, keeping the rest verbatim", () => {
    expect(normalizeGitLabLogLine(`${ESC}[32;1mok${ESC}[0m done`)).toBe("ok done");
    expect(normalizeGitLabLogLine(`${ESC}]0;title\x07${ESC}(Bplain`)).toBe("plain");
    expect(normalizeGitLabLogLine("10%\r50%\r100%")).toBe("100%");
    expect(normalizeGitLabLogLine("windows line\r")).toBe("windows line");
    expect(normalizeGitLabLogLine("  indented\tverbatim  ")).toBe("  indented\tverbatim  ");
    // GitHub's workflow commands and timestamps are not GitLab markup.
    expect(normalizeGitLabLogLine("##[group]x")).toBe("##[group]x");
    expect(normalizeGitLabLogLine("2024-05-01T12:34:56Z npm test")).toBe("2024-05-01T12:34:56Z npm test");
  });

  it("turns section starts into headings and drops section ends", () => {
    expect(normalizeGitLabLogLine(
      `${ESC}[0Ksection_start:1700000000:step_script\r${ESC}[0K${ESC}[36;1mExecuting "step_script"${ESC}[0;m`,
    )).toBe('▶ Executing "step_script"');
    expect(normalizeGitLabLogLine(`section_start:1700000000:build[collapsed=true]\r${ESC}[0K`)).toBe("▶ build");
    expect(normalizeGitLabLogLine(`${ESC}[0Ksection_end:1700000000:step_script\r${ESC}[0K`)).toBeNull();
    // The runner often closes one section and opens the next on the same line.
    expect(normalizeGitLabLogLine(
      `${ESC}[0Ksection_end:1:step_script\r${ESC}[0K${ESC}[0Ksection_start:1:cleanup\r${ESC}[0KCleaning up`,
    )).toBe("▶ Cleaning up");
  });

  it("reads a job trace through readCiLog, counting only the lines it keeps", async () => {
    const body = new Response([
      `\uFEFF${ESC}[0Ksection_start:1:step_script\r${ESC}[0KExecuting "step_script"\n`,
      "$ npm test\r\n",
      `${ESC}[0Ksection_end:1:step_script\r${ESC}[0K\n`,
      "Job succeeded",
    ].join("")).body!;
    expect(await readCiLog(body, normalizeGitLabLogLine))
      .toEqual({ lines: ['▶ Executing "step_script"', "$ npm test", "Job succeeded"], firstLine: 1, totalLines: 3 });
  });
});
