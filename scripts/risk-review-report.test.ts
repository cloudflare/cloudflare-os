import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BASE, HEAD, proofJson, verdictJson } from "./risk-review-fixtures/artifacts.ts";
import {
  buildReport,
  findRevert,
  personAction,
  readDecision,
  renderTable,
  type GitHubGet,
  type MergedPull,
} from "./risk-review-report.ts";
import {
  decide,
  parseBands,
  renderOutput,
  type DecisionRecord,
  type PullInputs,
} from "./risk-review.ts";
import { parseMaintainers, type Json } from "./risk-review-policy.ts";

const REPOSITORY = "cloudflare/cloudflare-os";

function merged(number: number, mergedAt: string, title = `Change ${number}`, body: string | null = null): MergedPull {
  return { number, title, body, merged_at: mergedAt, updated_at: mergedAt, head: { sha: HEAD }, user: { login: "kentonv" } };
}

/** A real check-run summary, rendered by the gate for one pull request with both verdicts. */
function summaryFor(number: number): string {
  const inputs: PullInputs = {
    pull: { number, node_id: "PR_1", state: "open", user: { login: "kentonv", type: "User" }, head: { sha: HEAD }, base: { sha: BASE, ref: "main" }, changed_files: 1 },
    files: [{ filename: "docs/automerge.md", status: "modified", additions: 1, deletions: 1, changes: 2 }],
    facts: { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [] },
    reviews: [],
    comments: [],
    lastPush: "2026-11-02T10:00:00Z",
    reviewDecision: "APPROVED",
    producers: {
      sol: { artifact: { ...JSON.parse(verdictJson({ name: "sol", merge_confidence: 8 })), name: "sol" } },
      opus: { artifact: { ...JSON.parse(verdictJson({ name: "opus", merge_confidence: 6, findings: [{ severity: "P1", title: "Race", path: null, line: null }] })), name: "opus" } },
      "proof-tests": { artifact: { ...JSON.parse(proofJson("proof-tests", "proof", false)), name: "proof-tests" } },
    },
  };
  const policy = { sha: BASE, maintainers: parseMaintainers("kentonv\nderegtd\n"), bands: parseBands(undefined).config, escapes: { windowDays: 90, files: [] } };
  const decision = decide(inputs, policy, new Date("2026-11-02T12:00:00Z"));
  const record: DecisionRecord = { schema: 1, mode: "shadow", event: "workflow_run", sha: HEAD, policy_sha: BASE, conclusion: "success", reason: "ok", pulls: [decision] };
  return renderOutput(record).summary;
}

describe("readDecision", () => {
  it("reads band, area, both scores and findings, and the would-decision from a gate summary", () => {
    assert.deepEqual(readDecision(summaryFor(901), 901), {
      band: "low",
      area: "scored",
      would: "person",
      sol: { confidence: 8, findings: "0/0/1/0" },
      opus: { confidence: 6, findings: "0/1/0/0" },
    });
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

describe("findRevert", () => {
  const pull = merged(717, "2026-10-10T12:00:00Z");

  it("finds a revert that names the pull request within 14 days", () => {
    const revert = merged(741, "2026-10-12T12:00:00Z", 'Revert "Add the GitLab gatekeeper"', "Reverts cloudflare/cloudflare-os#717");
    assert.equal(findRevert(pull, [revert], REPOSITORY), 741);
  });

  it("ignores a late revert, another pull request's revert, and a non-revert", () => {
    assert.equal(findRevert(pull, [merged(800, "2026-10-30T12:00:00Z", 'Revert "x"', "Reverts cloudflare/cloudflare-os#717")], REPOSITORY), undefined);
    assert.equal(findRevert(pull, [merged(742, "2026-10-12T12:00:00Z", 'Revert "x"', "Reverts cloudflare/cloudflare-os#7170")], REPOSITORY), undefined);
    assert.equal(findRevert(pull, [merged(742, "2026-10-12T12:00:00Z", "Fix install after #717")], REPOSITORY), undefined);
  });
});

describe("buildReport", () => {
  it("builds one row per pull request merged in the window, from a fake API", async () => {
    const pulls = [
      merged(901, "2026-11-03T12:00:00Z"),
      merged(902, "2026-11-05T12:00:00Z", 'Revert "Change 901"', "Reverts cloudflare/cloudflare-os#901"),
      merged(850, "2026-10-20T12:00:00Z"),
    ];
    const responses: Record<string, Json> = {
      [`/repos/${REPOSITORY}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: pulls.map((pull) => ({ ...pull })),
      [`/repos/${REPOSITORY}/commits/${HEAD}/check-runs?check_name=risk-review&filter=latest&per_page=100`]: {
        check_runs: [
          { app: { slug: "someone-else" }, status: "completed", output: { summary: "forged" } },
          { app: { slug: "risk-review" }, status: "completed", output: { summary: summaryFor(901) } },
        ],
      },
      [`/repos/${REPOSITORY}/pulls/901/reviews?per_page=100`]: [{ user: { login: "deregtd", type: "User" }, state: "APPROVED" }],
      [`/repos/${REPOSITORY}/pulls/902/reviews?per_page=100`]: [],
    };
    const get: GitHubGet = async (path) => {
      const response = responses[path];
      if (response === undefined) throw new Error(`unexpected request ${path}`);
      return response;
    };
    const rows = await buildReport(get, { repository: REPOSITORY, app: "risk-review", since: new Date("2026-11-01"), until: new Date("2026-11-04") });
    assert.deepEqual(rows.map(({ number, band, person, revert }) => ({ number, band, person, revert })), [
      { number: 901, band: "low", person: "approved", revert: 902 },
    ]);
    assert.match(renderTable(rows), /\| #901 \| 2026-11-03 \| low \| scored \| 8 \(0\/0\/1\/0\) \| 6 \(0\/1\/0\/0\) \| person \| approved \| #902 \|/);
  });
});
