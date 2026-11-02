import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PRODUCERS, type Artifact, type WorkflowRun } from "./risk-review-contract.ts";
import { BASE, HEAD, proofJson, verdictJson, zip } from "./risk-review-fixtures/artifacts.ts";
import {
  CLOSED_BANDS,
  MAX_DECISION_CHARS,
  POLICY_FILES,
  decide,
  mergeGroupPulls,
  parseBands,
  renderOutput,
  runRiskReview,
  type ActionsContext,
  type ActionsCore,
  type Comment,
  type DecisionRecord,
  type GitHubClient,
  type Policy,
  type PullInputs,
  type PullRequest,
  type Review,
} from "./risk-review.ts";
import { parseMaintainers, type ChangedFile, type Json } from "./risk-review-policy.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const fixture = (name: string): Json => JSON.parse(read(`scripts/risk-review-fixtures/${name}`));

const NOW = new Date("2026-11-02T12:00:00Z");
const PUSHED = "2026-11-02T10:00:00Z";
const POLICY_SHA = "f".repeat(40);
const APP = { id: 4242, login: "risk-review[bot]" };
const MAINTAINERS = "ndisidore\nMaximo-Guk\nAshishKumar4\nmaxwellpeterson\ndcartertwo\nkentonv\nderegtd\nFBalint\n";
const FINGERPRINT = { model: "openai/gpt-6.1-sol", opencode: "1.18.33", review_md: "d".repeat(40), prompt: "e".repeat(64) };
const NO_ESCAPES = JSON.stringify({ schema: 1, window_days: 90, files: [] });

function bandsJson(mode: "shadow" | "enforce", appApprovalsCount: boolean, open: { area: string; band: string; evidence?: string[] }[]): string {
  const bands = JSON.parse(read(POLICY_FILES.bands));
  bands.mode = mode;
  bands.app_approvals_count = appApprovalsCount;
  for (const { area, band, evidence = [] } of open) {
    bands.areas[area][band] = {
      open: true,
      threshold: area === "proven" ? null : 7,
      reviewer_fingerprint: area === "proven" ? null : { sol: FINGERPRINT, opus: FINGERPRINT },
      evidence,
    };
  }
  return JSON.stringify(bands);
}

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1 @@\n-a\n+b", ...overrides };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    node_id: "PR_kwDOSA1",
    state: "open",
    draft: false,
    user: { login: "kentonv", type: "User" },
    assignees: [],
    head: { sha: HEAD },
    base: { sha: BASE, ref: "main" },
    changed_files: 1,
    ...overrides,
  };
}

let ids = 0;
function review(login: string, state: string, overrides: Partial<Review> = {}): Review {
  return { id: ++ids, user: { login, type: "User" }, state, commit_id: HEAD, submitted_at: "2026-11-02T11:00:00Z", ...overrides };
}

function run(path: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: ++ids,
    event: "pull_request",
    path,
    head_sha: HEAD,
    head_branch: "kenton/topic",
    head_repository: { full_name: "cloudflare/cloudflare-os" },
    status: "completed",
    conclusion: "success",
    created_at: "2026-11-02T10:01:00Z",
    run_started_at: "2026-11-02T10:01:00Z",
    ...overrides,
  };
}

/** A run of a producer workflow with one artifact per entry. */
interface ProducerRun {
  run: WorkflowRun;
  artifacts: Record<string, string>;
}

function verdicts(overrides: { sol?: Record<string, Json | undefined>; opus?: Record<string, Json | undefined> } = {}): ProducerRun {
  return {
    run: run(PRODUCERS.sol.workflow),
    artifacts: {
      "automerge-sol": verdictJson({ name: "sol", fingerprint: FINGERPRINT, ...overrides.sol }),
      "automerge-opus": verdictJson({ name: "opus", fingerprint: FINGERPRINT, ...overrides.opus }),
    },
  };
}

/** What the gate did through the fake client. */
interface Calls {
  checks: { id: number; sha: string }[];
  updates: { id: number; conclusion: string; summary: string; title: string }[];
  approvals: string[];
  dismissals: number[];
  enqueued: { id: string | number | undefined; head: string | number | undefined }[];
}

function notFound(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function page<T>(items: T[], { page: number, per_page }: { page: number; per_page: number }): { data: T[] } {
  return { data: items.slice((number - 1) * per_page, number * per_page) };
}

interface HarnessOptions {
  pulls?: PullRequest[];
  files?: Record<number, ChangedFile[]>;
  reviews?: Record<number, Review[]>;
  comments?: Record<number, Comment[]>;
  reviewDecision?: Record<number, string | null>;
  runs?: ProducerRun[];
  repoArtifacts?: Record<string, { artifact: Artifact; run: WorkflowRun }[]>;
  policy?: Partial<Record<keyof typeof POLICY_FILES, string | undefined>>;
  contents?: Record<string, string>;
  lastPush?: string | undefined;
  mergeQueue?: Json;
  /** Check runs another run created on the commit after this one, to test the takeover check. */
  newerCheckRun?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const pulls = new Map((options.pulls ?? [pullRequest()]).map((pull) => [pull.number, pull]));
  const policy = { maintainers: MAINTAINERS, bands: read(POLICY_FILES.bands), escapes: NO_ESCAPES, ...options.policy };
  const contents = new Map(Object.entries({
    [`${POLICY_SHA}:${POLICY_FILES.maintainers}`]: policy.maintainers,
    [`${POLICY_SHA}:${POLICY_FILES.bands}`]: policy.bands,
    [`${POLICY_SHA}:${POLICY_FILES.escapes}`]: policy.escapes,
    ...options.contents,
  }));
  const runs = options.runs ?? [];
  const artifacts = new Map<number, Artifact[]>();
  const zips = new Map<number, Uint8Array>();
  for (const { run: producerRun, artifacts: files } of runs) {
    artifacts.set(producerRun.id, Object.entries(files).map(([name, text]) => {
      const id = ++ids;
      zips.set(id, zip({ [`${name.replace(/-[0-9a-f]{40}$/, "")}.json`]: text }));
      return { id, name, size_in_bytes: text.length, expired: false, created_at: "2026-11-02T10:05:00Z", workflow_run: { id: producerRun.id } };
    }));
  }
  const calls: Calls = { checks: [], updates: [], approvals: [], dismissals: [], enqueued: [] };

  const github: GitHubClient = {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          const pull = pulls.get(pull_number);
          if (!pull) throw notFound();
          return { data: pull };
        },
        list: async ({ head }) => ({ data: [...pulls.values()].filter(() => head.endsWith(":kenton/topic") || head.endsWith(":chore/classify-changsets")) }),
        listFiles: async (args) => page(options.files?.[args.pull_number] ?? [file("docs/automerge.md")], args),
        listReviews: async (args) => page(options.reviews?.[args.pull_number] ?? [], args),
        listReviewComments: async (args) => page([], args),
        createReview: async ({ commit_id }) => {
          calls.approvals.push(commit_id);
          return {};
        },
        dismissReview: async ({ review_id }) => {
          calls.dismissals.push(review_id);
          return {};
        },
      },
      issues: {
        listComments: async (args) => page(options.comments?.[args.issue_number] ?? [], args),
      },
      repos: {
        getContent: async ({ path, ref }) => {
          const text = contents.get(`${ref}:${path}`);
          if (text === undefined) throw notFound();
          return { data: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") } };
        },
        compareCommitsWithBasehead: async ({ basehead }) => ({ data: { merge_base_commit: { sha: basehead.split("...")[0] ?? "" } } }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) =>
          ({ data: [...pulls.values()].filter((pull) => pull.head.sha === commit_sha) }),
      },
      checks: {
        create: async ({ head_sha }) => {
          const id = ++ids;
          calls.checks.push({ id, sha: head_sha });
          return { data: { id } };
        },
        update: async ({ check_run_id, conclusion, output }) => {
          calls.updates.push({ id: check_run_id, conclusion, ...output });
          return {};
        },
        listForRef: async ({ ref }) => ({
          data: {
            check_runs: [
              ...calls.checks.filter(({ sha }) => sha === ref),
              ...(options.newerCheckRun ? [{ id: Number.MAX_SAFE_INTEGER }] : []),
            ],
          },
        }),
        listSuitesForRef: async () => {
          const created = "lastPush" in options ? options.lastPush : PUSHED;
          const suites = created === undefined ? [] : [{ created_at: created }, { created_at: "2026-11-02T10:30:00Z" }];
          return { data: { total_count: suites.length, check_suites: suites } };
        },
      },
      actions: {
        listWorkflowRuns: async ({ workflow_id, head_sha, event }) => {
          const matching = runs.map(({ run: r }) => r).filter((r) => r.path.endsWith(`/${workflow_id}`) && r.head_sha === head_sha && r.event === event);
          return { data: { total_count: matching.length, workflow_runs: matching } };
        },
        getWorkflowRun: async ({ run_id }) => {
          const found = runs.find(({ run: r }) => r.id === run_id) ??
            Object.values(options.repoArtifacts ?? {}).flat().find(({ run: r }) => r.id === run_id);
          if (!found) throw notFound();
          return { data: found.run };
        },
        listWorkflowRunArtifacts: async ({ run_id, name }) =>
          ({ data: { artifacts: (artifacts.get(run_id) ?? []).filter((a) => name === undefined || a.name === name) } }),
        listArtifactsForRepo: async ({ name }) => ({ data: { artifacts: (options.repoArtifacts?.[name] ?? []).map(({ artifact }) => artifact) } }),
        downloadArtifact: async ({ artifact_id }) => {
          const bytes = zips.get(artifact_id);
          if (!bytes) throw notFound();
          return { data: bytes.slice().buffer };
        },
      },
    },
    graphql: async (query, variables): Promise<Json> => {
      if (query.includes("enqueuePullRequest")) {
        calls.enqueued.push({ id: variables.id, head: variables.head });
        return { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_1" } } };
      }
      if (query.includes("mergeQueue(")) return options.mergeQueue ?? null;
      const number = Number(variables.number);
      const decision = options.reviewDecision?.[number];
      return { repository: { pullRequest: { reviewDecision: decision === undefined ? "REVIEW_REQUIRED" : decision, mergeQueueEntry: null } } };
    },
  };
  const core: ActionsCore = {
    notice: () => {},
    summary: { addRaw: () => core.summary, write: async () => ({}) },
  };
  const evaluate = (eventName: string, payload: Json) => {
    const context: ActionsContext = {
      eventName,
      sha: POLICY_SHA,
      runId: 99,
      serverUrl: "https://github.com",
      repo: { owner: "cloudflare", repo: "cloudflare-os" },
      payload: JSON.parse(JSON.stringify(payload)),
    };
    return runRiskReview({ github, context, core, app: APP, now: NOW });
  };
  return { calls, evaluate };
}

/** A `workflow_run` payload for a producer run finishing on the test pull request's head. */
function producerCompleted(): Json {
  return {
    action: "completed",
    workflow_run: {
      id: 1,
      event: "pull_request",
      head_sha: HEAD,
      head_branch: "kenton/topic",
      head_repository: { owner: { login: "cloudflare" }, full_name: "cloudflare/cloudflare-os" },
      pull_requests: [{ number: 7, base: { ref: "main" } }],
    },
    repository: { default_branch: "main", full_name: "cloudflare/cloudflare-os" },
  };
}

function lastRecord(calls: Calls): DecisionRecord {
  const summary = calls.updates.at(-1)?.summary ?? "";
  const json = /^```json\n(.*)\n```/s.exec(summary)?.[1];
  assert.ok(json, "the summary leads with the decision JSON");
  return JSON.parse(json);
}

describe("parseBands", () => {
  it("ships every band closed, in shadow mode, with App approvals not counted", () => {
    const { config, problem } = parseBands(read(POLICY_FILES.bands));
    assert.equal(problem, undefined);
    assert.equal(config.mode, "shadow");
    assert.equal(config.appApprovalsCount, false);
    for (const bands of Object.values(config.areas)) for (const rule of Object.values(bands)) assert.equal(rule.open, false);
  });

  it("closes every band in shadow mode when the file is missing or malformed", () => {
    assert.deepEqual(parseBands(undefined).config, CLOSED_BANDS);
    assert.deepEqual(parseBands("{").config, CLOSED_BANDS);
    const open = JSON.parse(bandsJson("enforce", true, [{ area: "scored", band: "low" }]));
    open.areas.scored.low.threshold = null;
    const parsed = parseBands(JSON.stringify(open));
    assert.deepEqual(parsed.config, CLOSED_BANDS);
    assert.match(parsed.problem ?? "", /threshold/);
    open.areas.scored.low.threshold = 7;
    open.areas.scored.low.evidence = ["evidence-from-anywhere"];
    assert.deepEqual(parseBands(JSON.stringify(open)).config, CLOSED_BANDS);
  });
});

function inputs(overrides: Partial<PullInputs> = {}): PullInputs {
  return {
    pull: pullRequest(),
    files: [file("docs/automerge.md")],
    facts: { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [] },
    reviews: [],
    comments: [],
    lastPush: PUSHED,
    reviewDecision: "REVIEW_REQUIRED",
    producers: {},
    ...overrides,
  };
}

function policyWith(bands: string, maintainers = parseMaintainers(MAINTAINERS)): Policy {
  const { config } = parseBands(bands);
  return {
    sha: POLICY_SHA,
    maintainers,
    bands: config,
    escapes: { windowDays: 90, files: [] },
  };
}

const OPEN_SCORED = policyWith(bandsJson("enforce", true, [{ area: "scored", band: "low" }]));

function verdictInput(name: "sol" | "opus", overrides: Record<string, Json | undefined> = {}) {
  return { artifact: { ...JSON.parse(verdictJson({ name, fingerprint: FINGERPRINT, ...overrides })), name } };
}

const PERFECT = { sol: verdictInput("sol"), opus: verdictInput("opus") };

describe("decide", () => {
  it("lets a maintainer's low-risk change through an open band when both verdicts clear it", () => {
    const decision = decide(inputs({ producers: PERFECT }), OPEN_SCORED, NOW);
    assert.deepEqual(decision.would, { decision: "auto", area: "scored", reasons: [] });
  });

  it("never lets an AI decide on a policy file, whatever the verdicts and bands", () => {
    for (const path of [".github/workflows/review-verdict.yml", "scripts/automerge/verdict/run.ts", "REVIEW.md", "packages/ui/AGENTS.md"]) {
      const decision = decide(inputs({ files: [file(path)], producers: PERFECT }), policyWith(bandsJson("enforce", true,
        ["scored", "kernel", "agent-facing-api"].flatMap((area) => ["low", "medium", "high"].map((band) => ({ area, band }))))), NOW);
      assert.equal(decision.would.decision, "person", path);
      assert.match(decision.would.reasons.join("\n"), /policy:/, path);
    }
  });

  it("holds a pull request a maintainer commented on after the last push", () => {
    // A real review from #845: deregtd commented after 795f5aa4 was pushed.
    const recorded = fixture("pull_request_review.json");
    const { review: recordedReview } = JSON.parse(JSON.stringify(recorded));
    const decision = decide(inputs({
      reviews: [recordedReview],
      lastPush: "2026-10-22T05:00:00Z",
      producers: PERFECT,
    }), OPEN_SCORED, NOW);
    assert.equal(decision.would.decision, "person");
    assert.deepEqual(decision.holds, ["@deregtd commented after the last push"]);
  });

  it("does not hold for the author, a non-maintainer, a bot, an approval, or a comment before the push", () => {
    const comments: Comment[] = [
      { user: { login: "kentonv", type: "User" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "outsider", type: "User" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "ask-bonk[bot]", type: "Bot" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "deregtd", type: "User" }, created_at: "2026-11-02T09:00:00Z" },
    ];
    const decision = decide(inputs({ comments, reviews: [review("Maximo-Guk", "APPROVED")], producers: PERFECT }), OPEN_SCORED, NOW);
    assert.deepEqual(decision.holds, []);
    assert.equal(decision.would.decision, "auto");
  });

  it("holds when the push time is unknown", () => {
    assert.equal(decide(inputs({ lastPush: undefined, producers: PERFECT }), OPEN_SCORED, NOW).would.decision, "person");
  });

  it("reads maintainers from the list only, case-insensitively, and from nowhere when it is missing", () => {
    const outsider = decide(inputs({ pull: pullRequest({ user: { login: "contributor", type: "User" } }), producers: PERFECT }), OPEN_SCORED, NOW);
    assert.equal(outsider.would.decision, "person");
    assert.match(outsider.would.reasons.join("\n"), /not a maintainer/);
    const approved = inputs({ reviews: [review("maximo-guk", "APPROVED")] });
    assert.deepEqual(decide(approved, OPEN_SCORED, NOW).approvers, ["maximo-guk"]);
    const nobody = policyWith(bandsJson("enforce", true, [{ area: "scored", band: "low" }]), parseMaintainers(undefined));
    assert.deepEqual(decide(approved, nobody, NOW).approvers, []);
    assert.equal(decide(inputs({ producers: PERFECT }), nobody, NOW).would.decision, "person");
  });

  it("counts a missing, failed or malformed verdict as absent", () => {
    for (const producers of [
      {},
      { sol: PERFECT.sol },
      { ...PERFECT, opus: { absent: "malformed merge_confidence" } },
      { ...PERFECT, opus: verdictInput("opus", { status: "error", merge_confidence: null }) },
    ]) {
      assert.equal(decide(inputs({ producers }), OPEN_SCORED, NOW).would.decision, "person", JSON.stringify(producers));
    }
  });

  it("closes the band for a verdict from another reviewer configuration", () => {
    const opus = verdictInput("opus", { fingerprint: { ...FINGERPRINT, prompt: "0".repeat(64) } });
    const decision = decide(inputs({ producers: { ...PERFECT, opus } }), OPEN_SCORED, NOW);
    assert.equal(decision.would.decision, "person");
    assert.match(decision.would.reasons.join("\n"), /configuration other than the band's/);
  });

  it("sends a P0 or P1 finding, a NEEDS-A-PERSON line, a missing score or a score under the threshold to a person", () => {
    for (const sol of [
      { findings: [{ severity: "P1", title: "Missing await", path: "a.ts", line: 1 }] },
      { needs_person: ["changes the RPC API"] },
      { merge_confidence: null },
      { merge_confidence: 6 },
    ]) {
      assert.equal(decide(inputs({ producers: { ...PERFECT, sol: verdictInput("sol", sol) } }), OPEN_SCORED, NOW).would.decision, "person", JSON.stringify(sol));
    }
  });

  it("requires the band's evidence to hold", () => {
    const policy = policyWith(bandsJson("enforce", true, [{ area: "scored", band: "low", evidence: ["evidence-deploy-dry-run"] }]));
    assert.equal(decide(inputs({ producers: PERFECT }), policy, NOW).would.decision, "person");
    const dryRun = { artifact: { ...JSON.parse(proofJson("evidence-deploy-dry-run", "evidence", true)), name: "evidence-deploy-dry-run" } };
    assert.equal(decide(inputs({ producers: { ...PERFECT, "evidence-deploy-dry-run": dryRun } }), policy, NOW).would.decision, "auto");
  });

  it("proves a Dependabot pull request only when its dependency proof and preview smoke both hold", () => {
    const policy = policyWith(bandsJson("enforce", true, [{ area: "proven", band: "medium" }]));
    const pull = pullRequest({ user: { login: "dependabot[bot]", type: "Bot" } });
    const files = [file("packages/ui/package.json")];
    const deps = { artifact: { ...JSON.parse(proofJson("proof-deps", "proof", true)), name: "proof-deps" } };
    const smoke = { artifact: { ...JSON.parse(proofJson("preview-smoke", "evidence", true)), name: "preview-smoke" } };
    assert.equal(decide(inputs({ pull, files, producers: { "proof-deps": deps } }), policy, NOW).would.decision, "person");
    assert.deepEqual(decide(inputs({ pull, files, producers: { "proof-deps": deps, "preview-smoke": smoke } }), policy, NOW).would,
      { decision: "auto", area: "proven", reasons: [] });
    // Dependabot never qualifies through AI verdicts.
    assert.equal(decide(inputs({ pull, files, producers: PERFECT }), OPEN_SCORED, NOW).would.decision, "person");
  });

  it("requires a human assignee's approval on a pull request an agent opened", () => {
    const pull = pullRequest({ user: { login: "ask-bonk[bot]", type: "Bot" }, assignees: [{ login: "kentonv", type: "User" }] });
    assert.match(decide(inputs({ pull, reviews: [review("deregtd", "APPROVED")] }), OPEN_SCORED, NOW).gate.reason, /@kentonv/);
    assert.equal(decide(inputs({ pull, reviews: [review("kentonv", "APPROVED")] }), OPEN_SCORED, NOW).gate.passes, true);
    assert.match(decide(inputs({ pull: { ...pull, assignees: [] } }), OPEN_SCORED, NOW).gate.reason, /assign/);
  });

  it("needs a maintainer's approval of the head commit, and blocks on a change request", () => {
    assert.equal(decide(inputs({ reviews: [review("deregtd", "APPROVED", { commit_id: BASE })] }), OPEN_SCORED, NOW).gate.passes, false);
    assert.equal(decide(inputs({ reviews: [review("deregtd", "APPROVED")] }), OPEN_SCORED, NOW).gate.passes, true);
    const blocked = decide(inputs({ reviews: [review("deregtd", "APPROVED"), review("kentonv", "CHANGES_REQUESTED", { user: { login: "FBalint", type: "User" } })] }), OPEN_SCORED, NOW);
    assert.equal(blocked.gate.passes, false);
  });
});

describe("runRiskReview in shadow mode", () => {
  it("mirrors today's rule on the head and records the decision, from the shipped bands file", async () => {
    const cases: [string | null, string][] = [["APPROVED", "success"], ["REVIEW_REQUIRED", "failure"], [null, "failure"]];
    for (const [decision, conclusion] of cases) {
      const { calls, evaluate } = harness({ reviewDecision: { 7: decision } });
      await evaluate("workflow_run", producerCompleted());
      assert.deepEqual(calls.checks.map(({ sha }) => sha), [HEAD]);
      assert.equal(calls.updates.at(-1)?.conclusion, conclusion);
      const record = lastRecord(calls);
      assert.equal(record.mode, "shadow");
      assert.equal(record.pulls[0]?.would.decision, "person");
    }
  });

  it("cannot approve or enqueue, even when a band is open and every input passes", async () => {
    const { calls, evaluate } = harness({
      policy: { bands: bandsJson("shadow", true, [{ area: "scored", band: "low" }]) },
      runs: [verdicts()],
    });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "auto");
    assert.equal(calls.updates.at(-1)?.conclusion, "failure");
    assert.deepEqual(calls.approvals, []);
    assert.deepEqual(calls.enqueued, []);
    assert.deepEqual(calls.dismissals, []);
  });

  it("decides the pull request a recorded review relay run names", async () => {
    // Recorded: the relay's run for deregtd's review of #845 (pull_request_review), and that review.
    const relay = fixture("workflow_run.json");
    const reviewEvent = JSON.parse(JSON.stringify(fixture("pull_request_review.json")));
    const pull = pullRequest({ number: 845, user: { login: "ndisidore", type: "User" }, head: { sha: reviewEvent.pull_request.head.sha }, base: { sha: reviewEvent.pull_request.base.sha, ref: "main" } });
    const { calls, evaluate } = harness({ pulls: [pull], reviews: { 845: [reviewEvent.review] }, lastPush: "2026-10-22T05:00:00Z" });
    await evaluate("workflow_run", relay);
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [reviewEvent.pull_request.head.sha]);
    const record = lastRecord(calls);
    assert.equal(record.pulls[0]?.number, 845);
    assert.deepEqual(record.pulls[0]?.holds, ["@deregtd commented after the last push"]);
  });

  it("decides the pull request a recorded maintainer comment is on", async () => {
    const pull = pullRequest({ number: 881, user: { login: "maxwellpeterson", type: "User" } });
    const { calls, evaluate } = harness({ pulls: [pull], reviewDecision: { 881: "APPROVED" } });
    await evaluate("issue_comment", fixture("issue_comment.json"));
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [HEAD]);
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
  });

  it("decides a pull request again when a bot preview's smoke run finishes on main", async () => {
    const smokeRun = run(PRODUCERS["preview-smoke"].workflow, { event: "workflow_run", head_branch: "main", head_sha: POLICY_SHA });
    const { calls, evaluate } = harness({ runs: [{ run: smokeRun, artifacts: { [`automerge-preview-smoke-${HEAD}`]: proofJson("preview-smoke", "evidence", true) } }] });
    await evaluate("workflow_run", { workflow_run: { id: smokeRun.id, event: "workflow_run", head_sha: POLICY_SHA, head_branch: "main", head_repository: null }, repository: { default_branch: "main", full_name: "cloudflare/cloudflare-os" } });
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [HEAD]);
  });

  it("does nothing for a comment on an issue, or for a pull request into another branch", async () => {
    const issue = JSON.parse(JSON.stringify(fixture("issue_comment.json")));
    issue.issue.pull_request = undefined;
    const first = harness({ pulls: [pullRequest({ number: 881 })] });
    await first.evaluate("issue_comment", issue);
    assert.deepEqual(first.calls.checks, []);
    const second = harness({ pulls: [pullRequest({ base: { sha: BASE, ref: "release" } })] });
    await second.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(second.calls.checks, []);
  });

  it("leaves the commit to a later run that has created a newer check run", async () => {
    const { calls, evaluate } = harness({ reviewDecision: { 7: "APPROVED" }, newerCheckRun: true });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(calls.updates.at(-1)?.conclusion, "cancelled");
  });
});

describe("runRiskReview on a merge group", () => {
  const group = fixture("merge_group.json");
  const queue = fixture("merge_queue.json");
  const pulls = [939, 943].map((number) => pullRequest({ number, head: { sha: String(number).repeat(14).slice(0, 40) } }));

  it("maps a merge group to its two pull requests and decides each on the group's commit", () => {
    const { merge_group } = JSON.parse(JSON.stringify(group));
    assert.deepEqual(mergeGroupPulls(queue, merge_group), [939, 943]);
    assert.equal(mergeGroupPulls(queue, { ...merge_group, base_sha: HEAD }), undefined);
    assert.equal(mergeGroupPulls(null, merge_group), undefined);
  });

  it("posts the aggregate on the group's head, reading policy at its base", async () => {
    const { merge_group } = JSON.parse(JSON.stringify(group));
    const { calls, evaluate } = harness({
      pulls,
      mergeQueue: queue,
      reviewDecision: { 939: "APPROVED", 943: "APPROVED" },
      contents: {
        [`${merge_group.base_sha}:${POLICY_FILES.maintainers}`]: MAINTAINERS,
        [`${merge_group.base_sha}:${POLICY_FILES.bands}`]: read(POLICY_FILES.bands),
        [`${merge_group.base_sha}:${POLICY_FILES.escapes}`]: NO_ESCAPES,
      },
    });
    await evaluate("merge_group", group);
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [merge_group.head_sha]);
    const record = lastRecord(calls);
    assert.equal(record.conclusion, "success");
    assert.equal(record.policy_sha, merge_group.base_sha);
    assert.equal(record.bands_problem, undefined);
    assert.deepEqual(record.pulls.map(({ number }) => number), [939, 943]);
  });

  it("fails the group when one pull request fails, or when the group does not map", async () => {
    const first = harness({ pulls, mergeQueue: queue, reviewDecision: { 939: "APPROVED", 943: "CHANGES_REQUESTED" } });
    await first.evaluate("merge_group", group);
    assert.equal(first.calls.updates.at(-1)?.conclusion, "failure");
    const second = harness({ pulls, mergeQueue: null, reviewDecision: { 939: "APPROVED", 943: "APPROVED" } });
    await second.evaluate("merge_group", group);
    assert.equal(second.calls.updates.at(-1)?.conclusion, "failure");
    assert.match(lastRecord(second.calls).reason, /does not map/);
  });
});

describe("runRiskReview producer binding", () => {
  const open = { policy: { bands: bandsJson("shadow", true, [{ area: "scored", band: "low" }]) } };

  it("reads both verdicts from a bound run", async () => {
    const { calls, evaluate } = harness({ ...open, runs: [verdicts()] });
    await evaluate("workflow_run", producerCompleted());
    const sol = lastRecord(calls).pulls[0]?.inputs.sol;
    assert.equal(sol && "status" in sol ? sol.status : undefined, "ok");
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "auto");
  });

  it("lets a newer failed attempt beat an older success", async () => {
    const failed = { run: run(PRODUCERS.sol.workflow, { created_at: "2026-11-02T10:30:00Z", conclusion: "failure" }), artifacts: {} };
    const { calls, evaluate } = harness({ ...open, runs: [verdicts(), failed] });
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(lastRecord(calls).pulls[0]?.inputs.sol, { absent: "concluded failure" });
  });

  it("rejects a verdict from a fork, or one made for another head or base", async () => {
    for (const runs of [
      [{ ...verdicts(), run: run(PRODUCERS.sol.workflow, { head_repository: { full_name: "someone/cloudflare-os" } }) }],
      [verdicts({ sol: { head_sha: "c".repeat(40) } })],
      [verdicts({ sol: { base_sha: "c".repeat(40) } })],
    ]) {
      const { calls, evaluate } = harness({ ...open, runs });
      await evaluate("workflow_run", producerCompleted());
      const record = lastRecord(calls);
      assert.ok(record.pulls[0]?.inputs.sol && "absent" in record.pulls[0].inputs.sol);
      assert.equal(record.pulls[0]?.would.decision, "person");
    }
  });
});

describe("runRiskReview in enforce mode", () => {
  it("approves the head and enqueues it for an open band when App approvals count", async () => {
    const { calls, evaluate } = harness({ policy: { bands: bandsJson("enforce", true, [{ area: "scored", band: "low" }]) }, runs: [verdicts()] });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
    assert.deepEqual(calls.approvals, [HEAD]);
    assert.deepEqual(calls.enqueued, [{ id: "PR_kwDOSA1", head: HEAD }]);
  });

  it("enqueues only after a maintainer approves when App approvals do not count", async () => {
    const bands = bandsJson("enforce", false, [{ area: "scored", band: "low" }]);
    const waiting = harness({ policy: { bands }, runs: [verdicts()] });
    await waiting.evaluate("workflow_run", producerCompleted());
    assert.equal(waiting.calls.updates.at(-1)?.conclusion, "failure");
    assert.deepEqual(waiting.calls.enqueued, []);
    const approved = harness({ policy: { bands }, runs: [verdicts()], reviews: { 7: [review("deregtd", "APPROVED")] } });
    await approved.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(approved.calls.approvals, []);
    assert.equal(approved.calls.enqueued.length, 1);
  });

  it("withdraws a standing App approval once the pull request needs a person", async () => {
    const appApproval: Review = { id: 555, user: { login: APP.login, type: "Bot" }, state: "APPROVED", commit_id: HEAD };
    const { calls, evaluate } = harness({ policy: { bands: bandsJson("enforce", true, []) }, reviews: { 7: [appApproval] } });
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(calls.dismissals, [555]);
    assert.deepEqual(calls.enqueued, []);
  });
});

describe("renderOutput", () => {
  it("keeps the decision JSON first and under the limit, however long the reasons", () => {
    const decision = decide(inputs({ producers: PERFECT }), OPEN_SCORED, NOW);
    const long = { ...decision, would: { ...decision.would, reasons: Array.from({ length: 5_000 }, (_, index) => `reason ${index} `.repeat(4)) } };
    const record: DecisionRecord = { schema: 1, mode: "shadow", event: "merge_group", sha: HEAD, policy_sha: POLICY_SHA, conclusion: "failure", reason: "x", pulls: [long] };
    const { summary } = renderOutput(record);
    const json = /^```json\n(.*)\n```/s.exec(summary)?.[1] ?? "";
    assert.ok(json.length <= MAX_DECISION_CHARS);
    assert.ok(summary.length <= 65_535);
    assert.equal(JSON.parse(json).truncated, true);
  });
});

const gateWorkflow = read(".github/workflows/risk-review.yml");
const relayWorkflow = read(".github/workflows/risk-review-trigger.yml");

describe("risk-review workflows", () => {
  it("runs only from main's definition: no pull_request_target, pull_request or review triggers", () => {
    const triggers = /^on:\n((?: .*\n|\n)*?)^\S/m.exec(gateWorkflow)?.[1] ?? "";
    assert.deepEqual([...triggers.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]), ["workflow_run", "issue_comment", "merge_group"]);
  });

  it("wakes on every producer workflow and the review relay", () => {
    const names = /workflows: \[([^\]]*)\]/.exec(gateWorkflow)?.[1]?.split(",").map((name) => name.trim()) ?? [];
    assert.ok(names.includes(/^name: (.+)$/m.exec(relayWorkflow)?.[1] ?? ""));
    for (const { workflow } of Object.values(PRODUCERS)) {
      if (!existsSync(new URL(workflow, ROOT))) continue;
      const name = /^name: (.+)$/m.exec(read(workflow))?.[1];
      assert.ok(name && names.includes(name), `${workflow} (${name}) wakes the gate`);
    }
  });

  it("posts only as the App, from the environment that holds its key, with no job-token fallback", () => {
    assert.match(gateWorkflow, /environment: risk-review\n/);
    assert.match(gateWorkflow, /github-token: \$\{\{ steps\.app\.outputs\.token \}\}\n/);
    assert.doesNotMatch(gateWorkflow, /github\.token/);
    assert.match(gateWorkflow, /permission-checks: write/);
    assert.doesNotMatch(gateWorkflow, /statuses/);
  });

  it("checks the script out from the default branch, or the merge group's base", () => {
    assert.match(gateWorkflow, /ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.workflow_sha \}\}/);
    assert.doesNotMatch(gateWorkflow, /github\.event\.(pull_request|workflow_run)\.head\.(ref|sha|repo)/);
  });

  it("relays pull request and review events from a workflow with no permissions or secrets", () => {
    assert.match(relayWorkflow, /^permissions: \{\}$/m);
    assert.doesNotMatch(relayWorkflow, /secrets\./);
    for (const event of ["pull_request", "pull_request_review", "pull_request_review_comment"]) {
      assert.match(relayWorkflow, new RegExp(`^ {2}${event}:`, "m"));
    }
  });

  it("gives no producer workflow checks: write, so only the gate publishes", () => {
    for (const workflow of new Set(Object.values(PRODUCERS).map(({ workflow: path }) => path))) {
      if (existsSync(new URL(workflow, ROOT))) assert.doesNotMatch(read(workflow), /checks: write/, workflow);
    }
    assert.doesNotMatch(relayWorkflow, /checks: write/);
  });
});
