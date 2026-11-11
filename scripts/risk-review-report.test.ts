import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { BASE, HEAD, proofJson, verdictJson } from "./risk-review-fixtures/artifacts.ts";
import {
  buildCalibration,
  buildReport,
  followUps,
  type GitHubGraphql,
  calibrate,
  readCalibrationRecord,
  type CalibrationPull,
  type CalibrationRecord,
  type CalibrationRow,
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

function merged(number: number, mergedAt: string, title = `Change ${number}`, body: string | null = null, base = "main"): MergedPull {
  return { number, title, body, merged_at: mergedAt, updated_at: mergedAt, head: { sha: HEAD }, base: { ref: base }, user: { login: "kentonv" } };
}

/** A real check-run summary, rendered by the gate for one pull request with both verdicts. */
function summaryFor(number: number): string {
  const inputs: PullInputs = {
    pull: { number, node_id: "PR_1", state: "open", user: { login: "kentonv", type: "User" }, head: { sha: HEAD, ref: "kenton/topic" }, base: { sha: BASE, ref: "main" }, changed_files: 1, commits: 1 },
    files: [{ filename: "docs/automerge.md", status: "modified", additions: 1, deletions: 1, changes: 2 }],
    facts: { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [], skillSymlinks: [] },
    reviews: [],
    comments: [],
    lastPush: "2026-11-02T10:00:00Z",
    reviewDecision: "APPROVED",
    commits: undefined,
    producers: {
      bonk: { artifact: { ...JSON.parse(verdictJson({ name: "bonk", merge_confidence: 8 })), name: "bonk" } },
      opus: { artifact: { ...JSON.parse(verdictJson({ name: "opus", merge_confidence: 6, findings: [{ severity: "P1", title: "Race", path: null, line: null }] })), name: "opus" } },
      "proof-tests": { artifact: { ...JSON.parse(proofJson("proof-tests", "proof", false)), name: "proof-tests" } },
    },
  };
  const policy = { sha: BASE, maintainers: parseMaintainers("kentonv\nderegtd\n"), bands: parseBands(undefined).config, escapes: { windowDays: 90, files: [] } };
  const decision = decide(inputs, policy, new Date("2026-11-02T12:00:00Z"));
  const record: DecisionRecord = { schema: 1, mode: "shadow", event: "workflow_run", sha: HEAD, policy_sha: BASE, conclusion: "success", reason: "ok", pulls: [decision] };
  return renderOutput(record).summary;
}

/** A passing verdict with this score. */
function verdict(name: "bonk" | "opus", score: number) {
  return { artifact: { ...JSON.parse(verdictJson({ name, merge_confidence: score, findings: [] })), name } };
}

/** A gate summary for `number` whose two verdicts pass with these scores. */
function summaryWithScores(number: number, bonk: number, opus: number): string {
  const inputs: PullInputs = {
    pull: { number, node_id: "PR_1", state: "open", user: { login: "kentonv", type: "User" }, head: { sha: HEAD, ref: "kenton/topic" }, base: { sha: BASE, ref: "main" }, changed_files: 1, commits: 1 },
    files: [{ filename: "packages/workshop-frontend/src/App.tsx", status: "modified", additions: 1, deletions: 1, changes: 2 }],
    facts: { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [], skillSymlinks: [] },
    reviews: [],
    comments: [],
    lastPush: "2026-11-02T10:00:00Z",
    reviewDecision: null,
    commits: undefined,
    producers: { bonk: verdict("bonk", bonk), opus: verdict("opus", opus) },
  };
  const policy = { sha: BASE, maintainers: parseMaintainers("kentonv\n"), bands: parseBands(undefined).config, escapes: { windowDays: 90, files: [] } };
  const record: DecisionRecord = { schema: 1, mode: "shadow", event: "workflow_run", sha: HEAD, policy_sha: BASE, conclusion: "failure", reason: "x", pulls: [decide(inputs, policy, new Date())] };
  return renderOutput(record).summary;
}

describe("readDecision", () => {
  it("reads band, area, both scores and findings, and the would-decision from a gate summary", () => {
    assert.deepEqual(readDecision(summaryFor(901), 901), {
      band: "low",
      area: "scored",
      would: "person",
      bonk: { confidence: 8, findings: "0/0/1/0" },
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
  it("builds one row per pull request merged into the default branch in the window, reading every review page", async () => {
    const pulls = [
      merged(901, "2026-11-03T12:00:00Z"),
      merged(902, "2026-11-05T12:00:00Z", 'Revert "Change 901"', "Reverts cloudflare/cloudflare-os#901"),
      merged(850, "2026-10-20T12:00:00Z"),
      // Merged into another branch, which the gate never decides: neither a sample nor a revert.
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
          { app: { slug: "risk-review" }, status: "completed", output: { summary: summaryFor(901) } },
        ],
      },
      [`/repos/${REPOSITORY}/pulls/901/reviews?per_page=100&page=1`]: bonk,
      [`/repos/${REPOSITORY}/pulls/901/reviews?per_page=100&page=2`]: [{ user: { login: "deregtd", type: "User" }, state: "APPROVED" }],
      [`/repos/${REPOSITORY}/pulls/902/reviews?per_page=100&page=1`]: [],
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

const DAY = 86_400_000;
const NOW_CAL = Date.parse("2026-11-30T12:00:00Z");
const EVIDENCE = new Map<string, readonly string[]>([["scored low", []], ["scored medium", ["evidence-deploy-dry-run"]]]);

/** A record of the scored area's low band, with both scores, at `day` days before the report. */
function calRecord(day: number, bonk: number, opus: number, overrides: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return { at: NOW_CAL - day * DAY, head: "h1", area: "scored", band: "low", ruledOut: false, scores: { bonk, opus }, holding: new Set(), reviewers: "aaaa", ...overrides };
}

function calPull(number: number, mergedDay: number, overrides: Partial<CalibrationPull> = {}): CalibrationPull {
  return { number, mergedAt: NOW_CAL - mergedDay * DAY, records: [calRecord(mergedDay + 2, 9, 9)], events: [], pushes: [{ head: "h1", at: NOW_CAL - (mergedDay + 3) * DAY }], followUps: [], ...overrides };
}

function row(rows: CalibrationRow[], threshold: number, reviewers = "aaaa"): CalibrationRow | undefined {
  return rows.find((entry) => entry.threshold === threshold && entry.reviewers === reviewers && entry.band === "low");
}

describe("calibrate", () => {
  it("takes the earliest record across heads that clears each threshold as the would-merge point", () => {
    // Head 1 scored 7/8, head 2 scored 9/10; a person commented on head 1 and a commit followed.
    const pull = calPull(901, 20, {
      records: [calRecord(25, 7, 8), calRecord(23, 9, 10, { head: "h2" })],
      events: [{ at: NOW_CAL - 24 * DAY, login: "deregtd", kind: "comment" }],
      pushes: [{ head: "h1", at: NOW_CAL - 26 * DAY }, { head: "h2", at: NOW_CAL - 23.5 * DAY }],
    });
    const rows = calibrate([pull], { evidence: EVIDENCE, now: NOW_CAL });
    // At 7 the gate would have merged head 1, before the comment: a miss.
    assert.deepEqual(row(rows, 7)?.misses, [{ number: 901, why: ["@deregtd commented, then a commit followed"] }]);
    // At 9 head 2 is the point; at the comment the record in force scored 7, under 9: clean.
    assert.deepEqual(row(rows, 9)?.clean, [901]);
    assert.equal(row(rows, 10), undefined);
  });

  it("counts a catch before the point when the reviewers had already passed the head, or no record shows they had not", () => {
    const comment = { at: NOW_CAL - 24 * DAY, login: "deregtd", kind: "comment" as const };
    const pushes = [{ head: "h1", at: NOW_CAL - 26 * DAY }, { head: "h2", at: NOW_CAL - 23.5 * DAY }];
    // Head 1 scored 9/9 but its evidence did not hold, so the point is head 2.
    const held = calPull(902, 20, {
      records: [calRecord(25, 9, 9, { band: "medium" }), calRecord(23, 9, 9, { head: "h2", band: "medium", holding: new Set(["evidence-deploy-dry-run"]) })],
      events: [comment],
      pushes,
    });
    const noRecord = calPull(903, 20, { records: [calRecord(23, 9, 9, { head: "h2" })], events: [comment], pushes });
    // Head 1 scored 5 and was replaced by head 2, which no record judged before the comment.
    const unjudged = calPull(904, 20, {
      records: [calRecord(26, 5, 5), calRecord(23, 9, 9, { head: "h2" })],
      events: [{ at: NOW_CAL - 24 * DAY, login: "deregtd", kind: "CHANGES_REQUESTED" }],
      pushes: [{ head: "h1", at: NOW_CAL - 27 * DAY }, { head: "h2", at: NOW_CAL - 25 * DAY }],
    });
    const rows = calibrate([held, noRecord, unjudged], { evidence: EVIDENCE, now: NOW_CAL });
    assert.deepEqual(rows.find((entry) => entry.band === "medium" && entry.threshold === 9)?.misses.map(({ number }) => number), [902]);
    assert.deepEqual(row(rows, 9)?.misses.map(({ number }) => number), [903, 904]);
  });

  it("counts a catch on a head the reviewers passed only after the person commented, and one with an unreadable record", () => {
    const comment = { at: NOW_CAL - 24 * DAY, login: "deregtd", kind: "comment" as const };
    const pushes = [{ head: "h1", at: NOW_CAL - 26 * DAY }, { head: "h2", at: NOW_CAL - 23 * DAY }];
    // Opus was still running at the comment; both scored h1 9/9 afterwards, and the author pushed a fix.
    const late = calPull(905, 20, { records: [calRecord(25, 9, 9, { scores: null }), calRecord(24.5, 9, 9)], events: [comment], pushes });
    // h1's only record was truncated; the point is on h2.
    const unreadable = calPull(906, 20, {
      records: [calRecord(25, 0, 0, { scores: null, ruledOut: true, reviewers: null, unreadable: true }), calRecord(22, 9, 9, { head: "h2" })],
      events: [comment],
      pushes,
    });
    // h1 never passed: the person's catch matched the reviewers' doubt.
    const doubted = calPull(907, 20, { records: [calRecord(25, 5, 9), calRecord(22, 9, 9, { head: "h2" })], events: [comment], pushes });
    const misses = row(calibrate([late, unreadable, doubted], { evidence: EVIDENCE, now: NOW_CAL }), 9)?.misses.map(({ number }) => number);
    assert.deepEqual(misses, [905, 906]);
  });

  it("counts a miss for a change request, a revert, or a later pull request naming it, and not for an approval or a comment no commit followed", () => {
    const after = NOW_CAL - 21 * DAY;
    const pulls = [
      calPull(910, 20, { events: [{ at: after, login: "kentonv", kind: "CHANGES_REQUESTED" }] }),
      calPull(911, 20, { followUps: [{ number: 950, revert: true }] }),
      calPull(912, 20, { followUps: [{ number: 951, revert: false }] }),
      calPull(913, 20, { events: [{ at: after, login: "kentonv", kind: "APPROVED" }, { at: after, login: "deregtd", kind: "comment" }] }),
    ];
    const misses = row(calibrate(pulls, { evidence: EVIDENCE, now: NOW_CAL }), 9)?.misses;
    assert.deepEqual(misses, [
      { number: 910, why: ["@kentonv requested changes"] },
      { number: 911, why: ["reverted by #950"] },
      { number: 912, why: ["#951 names it"] },
    ]);
  });

  it("counts a miss as soon as it is seen, and a clean pull request only 14 days after merge", () => {
    const rows = calibrate([
      calPull(920, 3, { followUps: [{ number: 960, revert: true }] }),
      calPull(921, 3),
      calPull(922, 15),
    ], { evidence: EVIDENCE, now: NOW_CAL });
    const nine = row(rows, 9);
    assert.deepEqual(nine?.misses.map(({ number }) => number), [920]);
    assert.deepEqual(nine?.pending, [921]);
    assert.deepEqual(nine?.clean, [922]);
  });

  it("restarts the clean run after a miss, and keeps each reviewer configuration apart", () => {
    const rows = calibrate([
      calPull(930, 40),
      calPull(931, 35, { followUps: [{ number: 970, revert: true }] }),
      calPull(932, 30),
      calPull(933, 25),
      calPull(934, 20, { records: [calRecord(22, 9, 9, { reviewers: "bbbb" })] }),
    ], { evidence: EVIDENCE, now: NOW_CAL });
    assert.equal(row(rows, 9)?.streak, 2);
    assert.deepEqual(row(rows, 9, "bbbb")?.clean, [934]);
    assert.equal(row(rows, 9, "bbbb")?.streak, 1);
  });

  it("admits nothing a policy rule ruled out, or without both scores", () => {
    const rows = calibrate([
      calPull(940, 20, { records: [calRecord(22, 9, 9, { ruledOut: true })] }),
      calPull(941, 20, { records: [calRecord(22, 9, 9, { scores: null })] }),
    ], { evidence: EVIDENCE, now: NOW_CAL });
    assert.deepEqual(rows, []);
  });
});

describe("readCalibrationRecord", () => {
  it("reads eligible scores, holding inputs and the reviewers from a gate summary", () => {
    const summary = summaryFor(901);
    const parsed = readCalibrationRecord(summary, 901, 0, HEAD);
    assert.ok(parsed);
    assert.equal(parsed.ruledOut, false);
    assert.equal(parsed.scores, null);
    assert.equal(parsed.holding.has("proof-tests"), false);
    assert.match(parsed.reviewers ?? "", /^[0-9a-f]{12}$/);
    assert.equal(readCalibrationRecord(summary, 902, 0, HEAD), undefined);
  });
});

describe("buildCalibration", () => {
  it("reads the head a force push replaced, from #1021's recorded event, and counts a catch made on it", async () => {
    const R = `/repos/${REPOSITORY}`;
    // Recorded: #1021's force push, which GraphQL reports with the head it replaced and the one it left.
    const recorded = JSON.parse(readFileSync(new URL("./risk-review-fixtures/force-push-1021.json", import.meta.url), "utf8")).data;
    const [push] = recorded.repository.pullRequest.timelineItems.nodes;
    const OLD: string = push.beforeCommit.oid;
    const NEW: string = push.afterCommit.oid;
    const pushed = Date.parse(push.createdAt);
    const iso = (offsetHours: number) => new Date(pushed + offsetHours * 3_600_000).toISOString();
    const runOn = (offsetHours: number, score: number) => ({
      app: { slug: "risk-review" },
      status: "completed",
      completed_at: iso(offsetHours),
      output: { summary: summaryWithScores(1021, score, score) },
    });
    const responses: Record<string, Json> = {
      [`${R}/contents/.github/maintainers`]: { content: Buffer.from("deregtd\nkentonv\n").toString("base64") },
      [`${R}/contents/.github/automerge-bands.json`]: { content: Buffer.from(readFileSync(new URL("../.github/automerge-bands.json", import.meta.url))).toString("base64") },
      [R]: { default_branch: "main" },
      [`${R}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [{ ...merged(1021, iso(30)) }],
      // After the rebase, only the new head is on the branch.
      [`${R}/pulls/1021/commits?per_page=100&page=1`]: [{ sha: NEW, commit: { committer: { date: iso(-0.5) } } }],
      // The old head scored 9/9; deregtd commented on it; the force push replaced it with one scoring 7/7.
      [`${R}/issues/1021/comments?per_page=100&page=1`]: [{ user: { login: "deregtd", type: "User" }, created_at: iso(-1) }],
      [`${R}/pulls/1021/comments?per_page=100&page=1`]: [],
      [`${R}/pulls/1021/reviews?per_page=100&page=1`]: [{ user: { login: "kentonv", type: "User" }, state: "APPROVED", submitted_at: iso(2) }],
      [`${R}/commits/${NEW}/check-suites?per_page=100`]: { check_suites: [{ created_at: push.createdAt }] },
      [`${R}/commits/${OLD}/check-suites?per_page=100`]: { check_suites: [{ created_at: iso(-5) }] },
      [`${R}/commits/${NEW}/check-runs?check_name=risk-review&filter=all&per_page=100&page=1`]: { check_runs: [runOn(1, 7)] },
      [`${R}/commits/${OLD}/check-runs?check_name=risk-review&filter=all&per_page=100&page=1`]: {
        check_runs: [runOn(-3, 9), { ...runOn(-2.5, 10), app: { slug: "someone-else" } }, { ...runOn(-2.8, 10), conclusion: "cancelled", output: { summary: "A later run decides this commit." } }],
      },
    };
    const get: GitHubGet = async (path) => {
      const response = responses[path];
      if (response === undefined) throw new Error(`unexpected request ${path}`);
      return response;
    };
    const graphql: GitHubGraphql = async (query, variables) => {
      assert.match(query, /HeadRefForcePushedEvent/);
      assert.equal(variables.number, 1021);
      return recorded;
    };
    const now = new Date(pushed + 20 * 86_400_000);
    const rows = await buildCalibration(get, graphql, { repository: REPOSITORY, app: "risk-review", since: new Date(pushed - 86_400_000), until: now, now });
    const nine = rows.find((entry) => entry.threshold === 9);
    assert.deepEqual(nine?.misses, [{ number: 1021, why: ["@deregtd commented, then a commit followed"] }]);
    assert.equal(rows.find((entry) => entry.threshold === 10), undefined);
  });
});

describe("followUps", () => {
  it("counts a fix that links the pull request, as #1001 links #894", () => {
    // Recorded: #1001's title and body, which name #894 only by a URL with a fragment.
    const fix = JSON.parse(readFileSync(new URL("./risk-review-fixtures/fix-1001.json", import.meta.url), "utf8"));
    const culprit = merged(894, "2026-11-03T18:00:00Z");
    const follow = merged(1001, fix.merged_at, fix.title, fix.body);
    assert.deepEqual(followUps(culprit, [culprit, follow], REPOSITORY), [{ number: 1001, revert: false }]);
    for (const body of ["See https://github.com/cloudflare/cloudflare-os/pull/894", "cloudflare/cloudflare-os#894", "#894"]) {
      assert.equal(followUps(culprit, [merged(1002, fix.merged_at, "Fix", body)], REPOSITORY).length, 1, body);
    }
    for (const body of ["https://github.com/cloudflare/cloudflare-os/pull/8940", "https://github.com/someone/fork/pull/894", "#8941"]) {
      assert.deepEqual(followUps(culprit, [merged(1002, fix.merged_at, "Fix", body)], REPOSITORY), [], body);
    }
  });
});
