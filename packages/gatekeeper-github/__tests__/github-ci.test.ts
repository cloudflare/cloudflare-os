// The pure CI mappings of github-ci.ts: GitHub's check, status, job and workflow run states to
// the agent-facing state and phase, the rollup and absence phases, job-log lines, and the smaller
// adapters.

import { CI_START_WINDOW_MS, readCiLog } from "@gadgets/gatekeeper-kit/ci";
import { describe, expect, it, vi } from "vitest";
import {
  absencePhaseOf,
  actionsJobIdOf,
  annotationOf,
  checkStateOf,
  countsFromRollup,
  hasWorkflowFiles,
  jobSummaryOf,
  mergeStateOf,
  normalizeGitHubLogLine,
  parseCiId,
  pendingDeploymentOf,
  phaseOf,
  rollupEntryOf,
  rollupPhaseOf,
  rollupStateOf,
  statusContextStateOf,
  workflowRunStatusFilter,
  type GqlCheckRun,
} from "../src/github-ci";
import type { GitHubWorkflowJobResponse } from "../src/github-api";

function gqlCheckRun(overrides: Partial<GqlCheckRun> = {}): GqlCheckRun {
  return {
    __typename: "CheckRun", databaseId: 7, name: "deploy", status: "WAITING", conclusion: null,
    startedAt: null, completedAt: null, url: "https://github.com/acme/widgets/runs/7", detailsUrl: null,
    pendingDeploymentRequest: null, checkSuite: { app: { name: "GitHub Actions" }, workflowRun: null },
    ...overrides,
  };
}

describe("checkStateOf", () => {
  it("maps unfinished statuses and completed conclusions, REST or GraphQL", () => {
    expect(checkStateOf("requested", null)).toBe("queued");
    expect(checkStateOf("QUEUED", null)).toBe("queued");
    expect(checkStateOf("pending", null)).toBe("queued");
    expect(checkStateOf("in_progress", null)).toBe("inProgress");
    expect(checkStateOf("WAITING", null)).toBe("waiting");
    expect(checkStateOf("completed", "success")).toBe("success");
    expect(checkStateOf("COMPLETED", "TIMED_OUT")).toBe("timedOut");
    expect(checkStateOf("completed", "action_required")).toBe("actionRequired");
    expect(checkStateOf("completed", "startup_failure")).toBe("startupFailure");
  });

  it("reads anything else as unknown", () => {
    expect(checkStateOf("frobnicating", null)).toBe("unknown");
    expect(checkStateOf("completed", "exploded")).toBe("unknown");
    expect(checkStateOf("completed", "constructor")).toBe("unknown");
    expect(checkStateOf(null, null)).toBe("unknown");
  });
});

describe("phaseOf", () => {
  it("is active while queued or running, blocked on a person, else done", () => {
    expect(phaseOf("queued")).toBe("active");
    expect(phaseOf("inProgress")).toBe("active");
    expect(phaseOf("actionRequired")).toBe("blocked");
    expect(phaseOf("unknown")).toBe("blocked");
    expect(phaseOf("failure")).toBe("done");
    expect(phaseOf("skipped")).toBe("done");
  });

  it("reads a waiting item as blocked unless only a timer holds it", () => {
    expect(phaseOf("waiting")).toBe("blocked");
    expect(phaseOf("waiting", false)).toBe("active");
  });
});

describe("commit statuses and the rollup", () => {
  it("maps commit status states", () => {
    expect(statusContextStateOf("PENDING")).toBe("inProgress");
    expect(statusContextStateOf("success")).toBe("success");
    expect(statusContextStateOf("ERROR")).toBe("failure");
    expect(statusContextStateOf("FAILURE")).toBe("failure");
    expect(statusContextStateOf("sideways")).toBe("unknown");
  });

  it("maps the rollup's verdict", () => {
    expect(rollupStateOf(null)).toBe("none");
    expect(rollupStateOf("SUCCESS")).toBe("success");
    expect(rollupStateOf("ERROR")).toBe("failure");
    expect(rollupStateOf("PENDING")).toBe("pending");
    expect(rollupStateOf("EXPECTED")).toBe("expected");
  });

  it("is active if any entry is, else blocked if any is, else done; undefined with no entries", () => {
    expect(rollupPhaseOf("failure", ["done", "blocked", "active"])).toBe("active");
    expect(rollupPhaseOf("pending", ["done", "blocked"])).toBe("blocked");
    expect(rollupPhaseOf("success", ["done"])).toBe("done");
    expect(rollupPhaseOf("none", [])).toBeUndefined();
    // A required status that has not reported yet keeps the commit active.
    expect(rollupPhaseOf("expected", ["done"])).toBe("active");
  });

  it("counts every entry by state from GitHub's totals", () => {
    expect(countsFromRollup(
      [{ state: "SUCCESS", count: 3 }, { state: "WAITING", count: 1 }, { state: "IN_PROGRESS", count: 0 }],
      [{ state: "ERROR", count: 1 }, { state: "FAILURE", count: 2 }, { state: "PENDING", count: 1 }],
    )).toEqual({ success: 3, waiting: 1, failure: 3, inProgress: 1 });
  });

  it("skips the zero-count states GitHub lists, without warning about COMPLETED", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(countsFromRollup([{ state: "COMPLETED", count: 0 }, { state: "SUCCESS", count: 1 }], [])).toEqual({ success: 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("absencePhaseOf", () => {
  const now = 1_000_000_000;

  it("has not started while a push of the commit is queued", () => {
    expect(absencePhaseOf({ pushQueued: true, ciExpected: false, becameHeadAt: undefined, now })).toBe("notStarted");
  });

  it("has not started within the window when CI is expected, else is done", () => {
    expect(absencePhaseOf({ pushQueued: false, ciExpected: true, becameHeadAt: now - 1000, now })).toBe("notStarted");
    expect(absencePhaseOf({ pushQueued: false, ciExpected: true, becameHeadAt: now - CI_START_WINDOW_MS, now }))
      .toBe("done");
    expect(absencePhaseOf({ pushQueued: false, ciExpected: false, becameHeadAt: now, now })).toBe("done");
    expect(absencePhaseOf({ pushQueued: false, ciExpected: true, becameHeadAt: undefined, now })).toBe("done");
  });

  it("expects CI from a workflow file", () => {
    expect(hasWorkflowFiles([{ name: "ci.yml", type: "blob" }])).toBe(true);
    expect(hasWorkflowFiles([{ name: "release.YAML", type: "blob" }])).toBe(true);
    expect(hasWorkflowFiles([{ name: "README.md", type: "blob" }, { name: "old.yml", type: "tree" }])).toBe(false);
    expect(hasWorkflowFiles(null)).toBe(false);
  });
});

describe("rollupEntryOf", () => {
  it("tells a deployment reviewer's hold from a wait timer", () => {
    const reviewer = rollupEntryOf(gqlCheckRun({
      pendingDeploymentRequest: {
        waitTimer: 0, waitTimerStartedAt: null, environment: { name: "prod" }, reviewers: { totalCount: 2 },
      },
    }));
    expect(reviewer).toMatchObject({ kind: "checkRun", id: "7", state: "waiting", phase: "blocked" });
    const timer = rollupEntryOf(gqlCheckRun({
      pendingDeploymentRequest: {
        waitTimer: 5, waitTimerStartedAt: "2026-01-01T00:00:00Z", environment: { name: "prod" },
        reviewers: { totalCount: 0 },
      },
    }));
    expect(timer).toMatchObject({ state: "waiting", phase: "active" });
    // Nothing known about the hold: a person may be needed.
    expect(rollupEntryOf(gqlCheckRun())).toMatchObject({ state: "waiting", phase: "blocked" });
  });

  it("maps a commit status and carries isRequired only when asked", () => {
    expect(rollupEntryOf({
      __typename: "StatusContext", context: "ci/legacy", state: "PENDING", description: "Running",
      targetUrl: "https://ci.example.com/1", updatedAt: "2026-01-01T00:00:00Z", isRequired: true,
    })).toEqual({
      kind: "status", context: "ci/legacy", state: "inProgress", phase: "active", description: "Running",
      targetUrl: "https://ci.example.com/1", updatedAt: new Date("2026-01-01T00:00:00Z"), isRequired: true,
    });
    expect(rollupEntryOf(gqlCheckRun())).not.toHaveProperty("isRequired");
  });
});

describe("pendingDeploymentOf", () => {
  it("computes when the wait timer runs out", () => {
    expect(pendingDeploymentOf({
      waitTimer: 10, waitTimerStartedAt: "2026-01-01T00:00:00Z", environment: { name: "prod" },
      reviewers: { totalCount: 0 },
    })).toEqual({ environment: "prod", needsReviewers: false, waitTimerEndsAt: new Date("2026-01-01T00:10:00Z") });
    expect(pendingDeploymentOf(null)).toBeUndefined();
  });
});

describe("adapters", () => {
  it("maps an Actions job to a check run summary under its check run id", () => {
    const job: GitHubWorkflowJobResponse = {
      id: 71, run_id: 900, head_sha: "a".repeat(40), name: "test", workflow_name: "CI",
      status: "in_progress", conclusion: null, started_at: "2026-01-01T00:00:00Z", completed_at: null,
      html_url: "https://github.com/acme/widgets/actions/runs/900/job/71",
      check_run_url: "https://api.github.com/repos/acme/widgets/check-runs/70",
    };
    expect(jobSummaryOf(job)).toMatchObject({
      kind: "checkRun", id: "70", state: "inProgress", phase: "active", app: "GitHub Actions",
      workflowRun: { id: "900", name: "CI" },
    });
  });

  it("finds the Actions job behind a check run", () => {
    expect(actionsJobIdOf({ id: 70, details_url: "https://github.com/acme/widgets/actions/runs/900/job/71" }))
      .toBe(71);
    expect(actionsJobIdOf({ id: 70, details_url: null })).toBe(70);
  });

  it("accepts only positive decimal ids", () => {
    expect(parseCiId("123", "check run")).toBe(123);
    for (const bad of ["0", "-1", "1e3", "abc", "12345678901234567"]) {
      expect(() => parseCiId(bad, "check run")).toThrow(/is not a check run id/);
    }
  });

  it("maps annotation levels, defaulting to notice", () => {
    expect(annotationOf({
      path: "a.ts", start_line: 1, end_line: 2, annotation_level: null, title: null, message: "m",
    })).toEqual({ path: "a.ts", startLine: 1, endLine: 2, level: "notice", title: undefined, message: "m" });
  });

  it("filters workflow runs by the narrowest REST status", () => {
    expect(workflowRunStatusFilter(undefined)).toBeUndefined();
    expect(workflowRunStatusFilter("inProgress")).toBe("in_progress");
    expect(workflowRunStatusFilter("timedOut")).toBe("timed_out");
    expect(workflowRunStatusFilter("startupFailure")).toBe("completed");
  });

  it("maps mergeable_state, unknown until GitHub has computed it", () => {
    expect(mergeStateOf("has_hooks")).toBe("hasHooks");
    expect(mergeStateOf("behind")).toBe("behind");
    expect(mergeStateOf(null)).toBe("unknown");
    expect(mergeStateOf("sideways")).toBe("unknown");
  });
});

describe("normalizeGitHubLogLine", () => {
  const ESC = "\x1b";
  const ts = "2024-05-01T12:34:56.1234567Z ";

  it("strips the timestamp, ANSI sequences, and carriage-return overwrites, keeping the rest verbatim", () => {
    expect(normalizeGitHubLogLine(`${ts}npm test`)).toBe("npm test");
    expect(normalizeGitHubLogLine(`${ts}${ESC}[32;1mok${ESC}[0m done`)).toBe("ok done");
    expect(normalizeGitHubLogLine(`${ESC}]0;title\x07${ESC}(Bplain`)).toBe("plain");
    expect(normalizeGitHubLogLine(`${ts}downloading 10%\rdownloading 100%`)).toBe("downloading 100%");
    expect(normalizeGitHubLogLine("windows line\r")).toBe("windows line");
    expect(normalizeGitHubLogLine("  indented\tverbatim  ")).toBe("  indented\tverbatim  ");
    // GitLab's section markers are not GitHub markup.
    expect(normalizeGitHubLogLine("section_end:1:x")).toBe("section_end:1:x");
  });

  it("rewrites workflow commands", () => {
    expect(normalizeGitHubLogLine(`${ts}##[group]Run actions/checkout@v4`)).toBe("▶ Run actions/checkout@v4");
    expect(normalizeGitHubLogLine(`${ts}##[endgroup]`)).toBeNull();
    expect(normalizeGitHubLogLine(`${ts}##[error]Process completed with exit code 1.`))
      .toBe("error: Process completed with exit code 1.");
    expect(normalizeGitHubLogLine(`${ts}##[warning]deprecated`)).toBe("warning: deprecated");
    expect(normalizeGitHubLogLine(`${ts}##[notice]heads up`)).toBe("notice: heads up");
    expect(normalizeGitHubLogLine(`${ts}##[debug]Evaluating`)).toBe("debug: Evaluating");
  });

  it("reads an Actions log through readCiLog, counting only the lines it keeps", async () => {
    const body = new Response([
      "\uFEFF2024-05-01T00:00:00.0000000Z ##[group]Setup\n",
      "2024-05-01T00:00:01.0000000Z installing\n",
      "2024-05-01T00:00:02.0000000Z ##[endgroup]\n",
      "2024-05-01T00:00:03.0000000Z done\n",
    ].join("")).body!;
    expect(await readCiLog(body, normalizeGitHubLogLine))
      .toEqual({ lines: ["▶ Setup", "installing", "done"], firstLine: 1, totalLines: 3 });
  });
});
