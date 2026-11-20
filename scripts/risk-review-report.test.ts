import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { BASE, HEAD, proofJson, verdictJson } from "./risk-review-fixtures/artifacts.ts";
import {
  buildReport,
  followUps,
  personAction,
  readDecision,
  renderTable,
  type GitHubGet,
  type MergedPull,
} from "./risk-review-report.ts";
import { decide, parseConfig, renderOutput, type DecisionRecord, type PullInputs } from "./risk-review.ts";
import type { Json } from "./automerge/json.ts";
import { parseMaintainers } from "./risk-review-policy.ts";

const REPOSITORY = "cloudflare/cloudflare-os";

function merged(number: number, mergedAt: string, title = `Change ${number}`, body: string | null = null, base = "main"): MergedPull {
  return { number, title, body, merged_at: mergedAt, updated_at: mergedAt, head: { sha: HEAD }, base: { ref: base }, user: { login: "kentonv" } };
}

/** A check-run summary, rendered by the gate for one low-risk pull request with both verdicts. */
function summaryFor(number: number, { scored = false, opus = {} }: { scored?: boolean; opus?: Record<string, Json> } = {}): string {
  const inputs: PullInputs = {
    pull: { number, node_id: "PR_1", state: "open", user: { login: "kentonv", type: "User" }, head: { sha: HEAD, ref: "kenton/topic" }, base: { sha: BASE, ref: "main" }, changed_files: 1, commits: 1 },
    files: [{ filename: "docs/automerge.md", status: "modified", additions: 1, deletions: 1 }],
    facts: { workspaceCatalogOnly: true, newDependencies: [], durableObjectRisks: [], skillSymlinks: [] },
    reviews: [],
    comments: [],
    lastPush: "2026-11-02T10:00:00Z",
    reviewDecision: "APPROVED",
    commits: undefined,
    producers: {
      bonk: { artifact: { ...JSON.parse(verdictJson({ name: "bonk" })), name: "bonk" } },
      opus: { artifact: { ...JSON.parse(verdictJson({ name: "opus", ...opus })), name: "opus" } },
      "proof-tests": { artifact: { ...JSON.parse(proofJson("proof-tests", "proof", false)), name: "proof-tests" } },
    },
  };
  const { config } = parseConfig(JSON.stringify({ mode: "shadow", app_approvals_count: false, threshold: 7, rungs: { proven: false, scored } }));
  const policy = { sha: BASE, maintainers: parseMaintainers("kentonv\nderegtd\n"), config, escapes: { windowDays: 90, files: [] } };
  const decision = decide(inputs, policy, new Date("2026-11-02T12:00:00Z"));
  const record: DecisionRecord = { schema: 1, mode: "shadow", event: "workflow_run", sha: HEAD, policy_sha: BASE, conclusion: "success", reason: "ok", pulls: [decision] };
  return renderOutput(record).summary;
}

const RACE = { merge_confidence: 6, findings: [{ severity: "P1", title: "Race", path: null, line: null }] };

describe("readDecision", () => {
  it("reads the risk level, both scores and findings, and what the gate would do from a gate summary", () => {
    assert.deepEqual(readDecision(summaryFor(901, { opus: RACE }), 901), {
      band: "low",
      would: "person",
      bonk: { confidence: 8, findings: "0/0/1/0" },
      opus: { confidence: 6, findings: "0/1/0/0" },
    });
  });

  it("names the rung a pull request would merge through", () => {
    assert.equal(readDecision(summaryFor(901, { scored: true }), 901)?.would, "merge (scored)");
  });

  it("returns nothing for a summary without a decision, or for another pull request", () => {
    assert.equal(readDecision("A later run decides this commit.", 901), undefined);
    assert.equal(readDecision(summaryFor(901), 902), undefined);
  });
});

function user(login: string, type = "User") {
  return { login, type };
}

describe("personAction", () => {
  it("reports the strongest human review other than the author's", () => {
    assert.equal(personAction([{ user: user("deregtd"), state: "APPROVED" }, { user: user("kentonv"), state: "CHANGES_REQUESTED" }], "author"), "changes requested");
    assert.equal(personAction([{ user: user("ask-bonk[bot]", "Bot"), state: "CHANGES_REQUESTED" }, { user: user("deregtd"), state: "COMMENTED" }], "author"), "commented");
    assert.equal(personAction([{ user: user("author"), state: "APPROVED" }], "author"), "no review");
  });
});

describe("followUps", () => {
  const pull = merged(717, "2026-10-10T12:00:00Z");

  it("finds a revert and a fix that name the pull request within 14 days", () => {
    const revert = merged(741, "2026-10-12T12:00:00Z", 'Revert "Add the GitLab gatekeeper"', "Reverts cloudflare/cloudflare-os#717");
    const fix = merged(742, "2026-10-13T12:00:00Z", "Fix install after #717");
    assert.deepEqual(followUps(pull, [pull, revert, fix], REPOSITORY), [{ number: 741, revert: true }, { number: 742, revert: false }]);
  });

  it("ignores a late revert, another pull request's revert, and one merged earlier", () => {
    assert.deepEqual(followUps(pull, [merged(800, "2026-10-30T12:00:00Z", 'Revert "x"', "Reverts cloudflare/cloudflare-os#717")], REPOSITORY), []);
    assert.deepEqual(followUps(pull, [merged(742, "2026-10-12T12:00:00Z", 'Revert "x"', "Reverts cloudflare/cloudflare-os#7170")], REPOSITORY), []);
    assert.deepEqual(followUps(pull, [merged(700, "2026-10-09T12:00:00Z", "Prepare for #717")], REPOSITORY), []);
  });

  it("counts a fix that links the pull request by URL", () => {
    // Recorded: #1001's title and body, which name #894 only by a URL with a fragment.
    const fix = JSON.parse(readFileSync(new URL("./risk-review-fixtures/fix-1001.json", import.meta.url), "utf8"));
    const culprit = merged(894, "2026-11-03T18:00:00Z");
    const follow = merged(1001, fix.merged_at, fix.title, fix.body);
    assert.deepEqual(followUps(culprit, [culprit, follow], REPOSITORY), [{ number: 1001, revert: false }]);
    for (const body of ["See https://github.com/cloudflare/cloudflare-os/pull/894", "cloudflare/cloudflare-os#894", "#894", "Fixes (#894)."]) {
      assert.equal(followUps(culprit, [merged(1002, fix.merged_at, "Fix", body)], REPOSITORY).length, 1, body);
    }
    // A longer number, another repository's pull request, and `#894` at the end of another
    // repository's reference are not this pull request.
    for (const body of ["https://github.com/cloudflare/cloudflare-os/pull/8940", "https://github.com/someone/fork/pull/894", "#8941",
      "Fixes cloudflare/workers-sdk#894", "someone/fork#894", "not-cloudflare/cloudflare-os#894"]) {
      assert.deepEqual(followUps(culprit, [merged(1002, fix.merged_at, "Fix", body)], REPOSITORY), [], body);
    }
  });
});

describe("buildReport", () => {
  it("builds one row per pull request merged into the default branch in the window, reading every review page", async () => {
    const pulls = [
      merged(901, "2026-11-03T12:00:00Z"),
      merged(902, "2026-11-05T12:00:00Z", 'Revert "Change 901"', "Reverts cloudflare/cloudflare-os#901"),
      merged(905, "2026-11-06T12:00:00Z", "Fix the docs link from #901"),
      merged(850, "2026-10-20T12:00:00Z"),
      // Merged into another branch, which the gate never decides: neither a row nor a follow-up.
      merged(903, "2026-11-03T13:00:00Z", "Release branch fix", null, "release"),
      merged(904, "2026-11-03T14:00:00Z", 'Revert "Change 901"', "Reverts cloudflare/cloudflare-os#901", "release"),
    ];
    // 100 bot reviews fill the first page; the human approval is on the second.
    const bonk = Array.from({ length: 100 }, () => ({ user: { login: "ask-bonk[bot]", type: "Bot" }, state: "COMMENTED" }));
    const responses: Record<string, Json> = {
      [`/repos/${REPOSITORY}`]: { default_branch: "main" },
      [`/repos/${REPOSITORY}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: pulls.map((pull) => ({ ...pull })),
      [`/repos/${REPOSITORY}/commits/${HEAD}/check-runs?check_name=risk-review&filter=latest&per_page=100`]: {
        check_runs: [
          { app: { slug: "someone-else" }, status: "completed", output: { summary: "forged" } },
          { app: { slug: "risk-review" }, status: "completed", output: { summary: summaryFor(901, { opus: RACE }) } },
        ],
      },
      [`/repos/${REPOSITORY}/pulls/901/reviews?per_page=100&page=1`]: bonk,
      [`/repos/${REPOSITORY}/pulls/901/reviews?per_page=100&page=2`]: [{ user: { login: "deregtd", type: "User" }, state: "APPROVED" }],
    };
    const get: GitHubGet = async (path) => {
      const response = responses[path];
      if (response === undefined) throw new Error(`unexpected request ${path}`);
      return response;
    };
    const rows = await buildReport(get, { repository: REPOSITORY, app: "risk-review", since: new Date("2026-11-01"), until: new Date("2026-11-04") });
    assert.deepEqual(rows, [{
      number: 901,
      merged: "2026-11-03",
      band: "low",
      bonk: { confidence: 8, findings: "0/0/1/0" },
      opus: { confidence: 6, findings: "0/1/0/0" },
      would: "person",
      person: "approved",
      followUps: [{ number: 902, revert: true }, { number: 905, revert: false }],
    }]);
    const [, , line] = renderTable(rows).split("\n");
    for (const shown of ["#901", "2026-11-03", "low", "8 (0/0/1/0)", "6 (0/1/0/0)", "person", "approved", "#902", "#905"]) {
      assert.ok(line?.includes(shown), `the row shows ${shown}: ${line}`);
    }
  });
});
