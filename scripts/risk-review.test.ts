import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  type PullDecision,
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
  /** Makes reading reviews fail, as an API outage would. */
  broken?: true;
  policy?: Partial<Record<keyof typeof POLICY_FILES, string | undefined>>;
  contents?: Record<string, string>;
  lastPush?: string | undefined;
  mergeQueue?: Json;
  /** Check runs another run created on the commit after this one, to test the takeover check. */
  newerCheckRun?: boolean;
  /** Merge bases by `base...head`, where the head does not simply contain the base. */
  mergeBases?: Record<string, string>;
  /** Makes every commit comparison a 404. */
  uncomparable?: true;
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
      const uploaded = new Date(Date.parse(producerRun.run_started_at ?? producerRun.created_at) + 60_000).toISOString();
      return { id, name, size_in_bytes: text.length, expired: false, created_at: uploaded, workflow_run: { id: producerRun.id } };
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
        listReviews: async (args) => {
          if (options.broken) throw new Error("HTTP 502");
          return page(options.reviews?.[args.pull_number] ?? [], args);
        },
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
          const sha = createHash("sha1").update(text).digest("hex");
          return { data: { type: "file", sha, encoding: "base64", content: Buffer.from(text).toString("base64") } };
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (options.uncomparable) throw notFound();
          return { data: { merge_base_commit: { sha: options.mergeBases?.[basehead] ?? basehead.split("...")[0] ?? "" } } };
        },
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
          const found = runs.find(({ run: r }) => r.id === run_id);
          if (!found) throw notFound();
          return { data: found.run };
        },
        listWorkflowRunArtifacts: async ({ run_id, name }) =>
          ({ data: { artifacts: (artifacts.get(run_id) ?? []).filter((a) => name === undefined || a.name === name) } }),
        listArtifactsForRepo: async ({ name }) => ({ data: { artifacts: [...artifacts.values()].flat().filter((a) => a.name === name) } }),
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
      if (query.includes("mergeQueueEntry")) return { repository: { pullRequest: { mergeQueueEntry: null } } };
      const decision = options.reviewDecision?.[Number(variables.number)];
      return { repository: { pullRequest: { reviewDecision: decision === undefined ? "REVIEW_REQUIRED" : decision } } };
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

function actions(holds: boolean) {
  return { artifact: { ...JSON.parse(proofJson("proof-actions", "proof", holds)), name: "proof-actions" } };
}

function migrations(holds: boolean) {
  return { artifact: { ...JSON.parse(proofJson("proof-migrations", "proof", holds)), name: "proof-migrations" } };
}

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

  it("sends a diff-only re-review to a person", () => {
    const sol = verdictInput("sol", { round: 3, review_from_sha: "c".repeat(40) });
    const decision = decide(inputs({ producers: { ...PERFECT, sol } }), OPEN_SCORED, NOW);
    assert.equal(decision.would.decision, "person");
    assert.match(decision.would.reasons.join("\n"), /only the diff since ccccccc/);
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
    const smokeHolds = { artifact: { ...JSON.parse(proofJson("preview-smoke", "evidence", true)), name: "preview-smoke" } };
    assert.equal(decide(inputs({ pull, files, producers: { "proof-deps": deps } }), policy, NOW).would.decision, "person");
    assert.deepEqual(decide(inputs({ pull, files, producers: { "proof-deps": deps, "preview-smoke": smokeHolds } }), policy, NOW).would,
      { decision: "auto", area: "proven", reasons: [] });
    // Dependabot never qualifies through AI verdicts.
    assert.equal(decide(inputs({ pull, files, producers: PERFECT }), OPEN_SCORED, NOW).would.decision, "person");
  });

  it("never proves a change through the migration proof alone, and needs it for a Worker config change", () => {
    const policy = policyWith(bandsJson("enforce", true, [{ area: "proven", band: "low" }, { area: "scored", band: "medium" }]));
    const alone = decide(inputs({ producers: { "proof-migrations": migrations(true) } }), policy, NOW);
    assert.equal(alone.would.decision, "person");
    assert.notEqual(alone.would.area, "proven");
    const config = [file("packages/gatekeeper-x/wrangler.jsonc")];
    assert.match(decide(inputs({ files: config, producers: PERFECT }), policy, NOW).would.reasons.join("\n"), /migration proof/);
    assert.match(decide(inputs({ files: config, producers: { ...PERFECT, "proof-migrations": migrations(false) } }), policy, NOW).would.reasons.join("\n"), /migration proof/);
    assert.deepEqual(decide(inputs({ files: config, producers: { ...PERFECT, "proof-migrations": migrations(true) } }), policy, NOW).would,
      { decision: "auto", area: "scored", reasons: [] });
  });

  describe("a Dependabot GitHub Actions bump", () => {
    // Recorded: #621, Dependabot's bump of three actions across ci.yml, preview.yml,
    // workshop-evals-pr.yml and workshop-evals.yml.
    const recorded = JSON.parse(read("scripts/risk-review-fixtures/dependabot-actions-621.json"));
    const pull621 = pullRequest({ ...recorded.pull, base: { ...recorded.pull.base } });
    const files621: ChangedFile[] = recorded.files;
    const ciOnly = files621.filter(({ filename }) => filename === ".github/workflows/ci.yml");
    const ciPull = { ...pull621, changed_files: ciOnly.length };
    const policy = policyWith(bandsJson("enforce", true, [{ area: "proven", band: "high" }]));
    const proven = { decision: "auto", area: "proven", reasons: [] };

    it("qualifies when confined to non-gate workflows, but not when it touches a producer, as #621 does", () => {
      assert.deepEqual(decide(inputs({ pull: ciPull, files: ciOnly, producers: { "proof-actions": actions(true) } }), policy, NOW).would, proven);
      const whole = decide(inputs({ pull: pull621, files: files621, producers: { "proof-actions": actions(true) } }), policy, NOW);
      assert.equal(whole.would.decision, "person");
      assert.match(whole.would.reasons.join("\n"), /preview\.yml/);
    });

    it("needs its Actions proof to hold", () => {
      assert.deepEqual(decide(inputs({ pull: ciPull, files: ciOnly, producers: { "proof-actions": actions(true) } }), policy, NOW).would, proven);
      for (const producers of [{}, { "proof-actions": actions(false) }, { "proof-actions": { absent: "concluded failure" } }]) {
        assert.equal(decide(inputs({ pull: ciPull, files: ciOnly, producers }), policy, NOW).would.decision, "person", JSON.stringify(producers));
      }
    });

    it("covers only existing workflow files modified in place", () => {
      const ok = { pull: ciPull, producers: { "proof-actions": actions(true) } };
      assert.deepEqual(decide(inputs({ ...ok, files: ciOnly }), policy, NOW).would, proven);
      const [ci] = ciOnly;
      assert.ok(ci);
      for (const changed of [
        { ...ci, filename: ".github/dependabot.yml" },
        { ...ci, filename: ".github/workflows/nested/ci.yml" },
        { ...ci, status: "added" },
        { ...ci, status: "renamed", previous_filename: ".github/workflows/preview.yml" },
        { ...ci, status: "renamed", filename: ".github/workflows/risk-review.yml", previous_filename: ".github/workflows/ci.yml" },
        { ...ci, filename: ".github/workflows/automerge-proofs.yml" },
      ]) {
        assert.equal(decide(inputs({ ...ok, files: [changed] }), policy, NOW).would.decision, "person", JSON.stringify(changed.filename));
      }
      assert.equal(decide(inputs({ ...ok, files: [...ciOnly, file(".github/dependabot.yml")], pull: { ...ciPull, changed_files: 2 } }), policy, NOW).would.decision, "person");
      assert.equal(decide(inputs({ ...ok, files: ciOnly, pull: { ...ciPull, changed_files: 2 } }), policy, NOW).would.decision, "person");
    });

    it("applies to Dependabot only", () => {
      assert.deepEqual(decide(inputs({ pull: ciPull, files: ciOnly, producers: { "proof-actions": actions(true) } }), policy, NOW).would, proven);
      const maintainer = { ...ciPull, user: { login: "deregtd", type: "User" } };
      const scored = policyWith(bandsJson("enforce", true, ["proven", "scored", "kernel"].map((area) => ({ area, band: "high" }))));
      const decision = decide(inputs({ pull: maintainer, files: ciOnly, producers: { ...PERFECT, "proof-actions": actions(true) } }), scored, NOW);
      assert.equal(decision.would.decision, "person");
      assert.match(decision.would.reasons.join("\n"), /policy:/);
    });
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
  // The relay's `workflow_run` for the recorded merge group: same head commit and queue ref.
  const { merge_group: group } = JSON.parse(JSON.stringify(fixture("merge_group.json")));
  const relayed = {
    workflow_run: {
      id: 3,
      event: "merge_group",
      head_sha: group.head_sha,
      head_branch: group.head_ref.replace("refs/heads/", ""),
      head_repository: { owner: { login: "cloudflare" }, full_name: "cloudflare/cloudflare-os" },
      pull_requests: [],
    },
    repository: { default_branch: "main", full_name: "cloudflare/cloudflare-os" },
  };
  const queue = fixture("merge_queue.json");
  const pulls = [939, 943].map((number) => pullRequest({ number, head: { sha: String(number).repeat(14).slice(0, 40) } }));
  const basePolicy = {
    [`${group.base_sha}:${POLICY_FILES.maintainers}`]: MAINTAINERS,
    [`${group.base_sha}:${POLICY_FILES.bands}`]: read(POLICY_FILES.bands),
    [`${group.base_sha}:${POLICY_FILES.escapes}`]: NO_ESCAPES,
  };

  it("maps a merge group's commit to its two pull requests and its base", () => {
    const [first, second] = JSON.parse(read("scripts/risk-review-fixtures/merge_queue.json")).repository.mergeQueue.entries.nodes;
    assert.deepEqual(mergeGroupPulls(queue, group.head_sha), {
      pulls: [{ number: 939, base: group.base_sha }, { number: 943, base: first.headCommit.oid }],
      baseSha: group.base_sha,
    });
    assert.equal(second.headCommit.oid, group.head_sha);
    assert.equal(mergeGroupPulls(queue, HEAD), undefined);
    assert.equal(mergeGroupPulls(null, group.head_sha), undefined);
  });

  it("posts the aggregate on the group's commit, reading policy at its base", async () => {
    const { calls, evaluate } = harness({ pulls, mergeQueue: queue, reviewDecision: { 939: "APPROVED", 943: "APPROVED" }, contents: basePolicy });
    await evaluate("workflow_run", relayed);
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [group.head_sha]);
    const record = lastRecord(calls);
    assert.equal(record.conclusion, "success");
    assert.equal(record.event, "merge_group");
    assert.equal(record.policy_sha, group.base_sha);
    assert.equal(record.bands_problem, undefined);
    assert.deepEqual(record.pulls.map(({ number }) => number), [939, 943]);
  });

  it("fails the group when one pull request fails today's rule", async () => {
    const { calls, evaluate } = harness({ pulls, mergeQueue: queue, reviewDecision: { 939: "APPROVED", 943: "CHANGES_REQUESTED" }, contents: basePolicy });
    await evaluate("workflow_run", relayed);
    assert.equal(calls.updates.at(-1)?.conclusion, "failure");
  });

  it("decides nothing for a queue-named branch the merge queue does not list, or whose name disagrees", async () => {
    const forged = harness({ pulls, mergeQueue: queue, reviewDecision: { 939: "APPROVED", 943: "APPROVED" } });
    await forged.evaluate("workflow_run", { ...relayed, workflow_run: { ...relayed.workflow_run, head_sha: HEAD } });
    assert.deepEqual(forged.calls.checks, []);
    const renamed = harness({ pulls, mergeQueue: queue, reviewDecision: { 939: "APPROVED", 943: "APPROVED" } });
    await renamed.evaluate("workflow_run", { ...relayed, workflow_run: { ...relayed.workflow_run, head_branch: `gh-readonly-queue/main/pr-939-${group.base_sha}` } });
    assert.deepEqual(renamed.calls.checks, []);
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
    const failed = { run: run(PRODUCERS.sol.workflow, { created_at: "2026-11-02T10:30:00Z", run_started_at: "2026-11-02T10:30:00Z", conclusion: "failure" }), artifacts: {} };
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

/** A follow-up Preview run's smoke artifact for the test head, naming the run it followed. */
function smoke(producerRun: WorkflowRun, trigger: WorkflowRun, holds = true): ProducerRun {
  const details = { trigger: { run_id: trigger.id, run_attempt: trigger.run_attempt ?? 1 } };
  return { run: producerRun, artifacts: { [`automerge-preview-smoke-${HEAD}`]: proofJson("preview-smoke", "evidence", holds, { details }) } };
}

/** Decides the test pull request with these changed files and file contents. */
async function decideFiles(files: ChangedFile[], contents: Record<string, string>): Promise<PullDecision> {
  const { calls, evaluate } = harness({ files: { 7: files }, contents });
  await evaluate("workflow_run", producerCompleted());
  const pull = lastRecord(calls).pulls[0];
  assert.ok(pull);
  return pull;
}

describe("runRiskReview preview smoke from main", () => {
  const evidence = run(PRODUCERS["proof-equivalence"].workflow, { run_attempt: 2, run_started_at: "2026-11-02T10:01:00Z" });
  const smokeRun = (overrides: Partial<WorkflowRun> = {}) =>
    run(PRODUCERS["preview-smoke"].workflow, { event: "workflow_run", head_branch: "main", head_sha: POLICY_SHA, created_at: "2026-11-02T10:20:00Z", run_started_at: "2026-11-02T10:20:00Z", ...overrides });
  const smokeInput = async (runs: ProducerRun[]) => {
    const { calls, evaluate } = harness({ runs: [{ run: evidence, artifacts: {} }, ...runs] });
    await evaluate("workflow_run", producerCompleted());
    return lastRecord(calls).pulls[0]?.inputs["preview-smoke"];
  };

  it("accepts a smoke run on main that followed the newest Automerge evidence run's current attempt", async () => {
    assert.deepEqual(await smokeInput([smoke(smokeRun(), evidence)]), { status: "ok", holds: true });
  });

  it("treats a smoke run that followed an older run or attempt as absent, however late it ran", async () => {
    const older = run(PRODUCERS["proof-equivalence"].workflow, { run_started_at: "2026-11-02T09:00:00Z" });
    for (const trigger of [older, { ...evidence, run_attempt: 1 }]) {
      const stale = await smokeInput([smoke(smokeRun({ created_at: "2026-11-02T12:00:00Z", run_started_at: "2026-11-02T12:00:00Z" }), trigger)]);
      assert.ok(stale && "absent" in stale && /follows another run/.test(stale.absent), JSON.stringify(stale));
    }
  });

  it("accepts the smoke from a pull_request Preview run on the head, under the same head-named artifact", async () => {
    const deploy = run(PRODUCERS["preview-smoke"].workflow, { created_at: "2026-11-02T10:20:00Z", run_started_at: "2026-11-02T10:20:00Z" });
    const named = { run: deploy, artifacts: { [`automerge-preview-smoke-${HEAD}`]: proofJson("preview-smoke", "evidence", true) } };
    assert.deepEqual(await smokeInput([named]), { status: "ok", holds: true });
  });

  it("does not let another workflow's artifact with the same name mask the real smoke", async () => {
    const forged = smoke(run(".github/workflows/someone.yml", { created_at: "2026-11-02T11:00:00Z", run_started_at: "2026-11-02T11:00:00Z" }), evidence, false);
    assert.deepEqual(await smokeInput([smoke(smokeRun(), evidence), forged]), { status: "ok", holds: true });
  });

  it("does not let a fork's newer Automerge evidence run on the same commit displace the trigger", async () => {
    const fork = run(PRODUCERS["proof-equivalence"].workflow, { head_repository: { full_name: "someone/cloudflare-os" }, run_started_at: "2026-11-02T11:00:00Z" });
    assert.deepEqual(await smokeInput([{ run: fork, artifacts: {} }, smoke(smokeRun(), evidence)]), { status: "ok", holds: true });
  });
});

describe("runRiskReview content rules", () => {
  const workspace = read("pnpm-workspace.yaml");

  it("allows pnpm-workspace.yaml when only catalog versions change, and keeps every other change with a person", async () => {
    const files = [file("pnpm-workspace.yaml")];
    const bump = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace, [`${HEAD}:pnpm-workspace.yaml`]: workspace.replace("zod: ^4.6.7", "zod: ^4.7.0") });
    assert.deepEqual(bump.never_auto, []);
    const age = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace, [`${HEAD}:pnpm-workspace.yaml`]: `${workspace}minimumReleaseAge: 1\n` });
    assert.match(age.never_auto.join("\n"), /supply-chain/);
    const unread = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace });
    assert.match(unread.never_auto.join("\n"), /supply-chain/);
  });

  it("sends a Worker config that newly deletes a Durable Object class to a person", async () => {
    const config = "packages/gatekeeper-x/cloudflare.config.ts";
    const before = "migrations: [\n  { tag: 'v1', new_sqlite_classes: ['Notes'] },\n  { tag: 'v2', deleted_classes: [\n    'Old',\n  ] },\n]";
    const files = [file(config)];
    const added = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: before.replace("    'Old',\n", "    'Old',\n    'Notes',\n") });
    assert.match(added.never_auto.join("\n"), /Durable Object classes \(packages\/gatekeeper-x\/cloudflare\.config\.ts: Notes\)/);
    const unchanged = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: `// v2 dropped Old.\n${before}` });
    assert.deepEqual(unchanged.never_auto, []);
    const unread = await decideFiles(files, { [`${BASE}:${config}`]: before });
    assert.match(unread.never_auto.join("\n"), /unreadable/);
  });

  it("rates a package.json that gains a dependency high, and one it cannot read too", async () => {
    const files = [file("packages/ui/package.json")];
    const before = JSON.stringify({ dependencies: { zod: "catalog:" } });
    const added = await decideFiles(files, { [`${BASE}:packages/ui/package.json`]: before, [`${HEAD}:packages/ui/package.json`]: JSON.stringify({ dependencies: { zod: "catalog:", "left-pad": "^1.0.0" } }) });
    assert.equal(added.band, "high");
    assert.match(added.band_reasons.join("\n"), /left-pad/);
    const same = await decideFiles(files, { [`${BASE}:packages/ui/package.json`]: before, [`${HEAD}:packages/ui/package.json`]: before });
    assert.equal(same.band, "medium");
    const unread = await decideFiles(files, { [`${BASE}:packages/ui/package.json`]: before });
    assert.match(unread.band_reasons.join("\n"), /unreadable/);
  });
});

describe("runRiskReview failure", () => {
  it("fails its check run, rather than leaving it in progress, when the API fails", async () => {
    const { calls, evaluate } = harness({ broken: true });
    await assert.rejects(evaluate("workflow_run", producerCompleted()), /HTTP 502/);
    assert.deepEqual(calls.updates.map(({ conclusion }) => conclusion), ["failure"]);
  });
});

type RungOneProof = "proof-actions" | "proof-deps" | "proof-equivalence" | "proof-tests";

/** A run of the proof's workflow on the test head, with a holding proof made against `BASE`. */
function proofRun(name: RungOneProof): ProducerRun {
  return { run: run(PRODUCERS[name].workflow), artifacts: { [`automerge-${name}`]: proofJson(name, "proof", true) } };
}

/** The two files proof-deps reads at its merge base, as they stand at `sha`. */
function at(sha: string, workspaceText: string, lockText: string): Record<string, string> {
  return { [`${sha}:pnpm-workspace.yaml`]: workspaceText, [`${sha}:pnpm-lock.yaml`]: lockText };
}

describe("runRiskReview proof freshness", () => {
  // The relay's run for the recorded merge group; #943's slot holds a Dependabot bump of #621's
  // ci.yml change, and lands on the group commit for #939.
  const { merge_group: group } = JSON.parse(read("scripts/risk-review-fixtures/merge_group.json"));
  const [first] = JSON.parse(read("scripts/risk-review-fixtures/merge_queue.json")).repository.mergeQueue.entries.nodes;
  const landsOn: string = first.headCommit.oid;
  const relayed = {
    workflow_run: {
      id: 3,
      event: "merge_group",
      head_sha: group.head_sha,
      head_branch: group.head_ref.replace("refs/heads/", ""),
      head_repository: { owner: { login: "cloudflare" }, full_name: "cloudflare/cloudflare-os" },
      pull_requests: [],
    },
    repository: { default_branch: "main", full_name: "cloudflare/cloudflare-os" },
  };
  const recorded = JSON.parse(read("scripts/risk-review-fixtures/dependabot-actions-621.json"));
  const ciOnly: ChangedFile[] = recorded.files.filter(({ filename }: ChangedFile) => filename === ".github/workflows/ci.yml");
  const ci = read(".github/workflows/ci.yml");
  const workspace = read("pnpm-workspace.yaml");
  const bot = { login: "dependabot[bot]", type: "Bot" };
  const queued = [pullRequest({ number: 939, head: { sha: "9".repeat(40) } }), pullRequest({ number: 943, user: bot })];
  const policyAt = (sha: string) => ({
    [`${sha}:${POLICY_FILES.maintainers}`]: MAINTAINERS,
    [`${sha}:${POLICY_FILES.bands}`]: read(POLICY_FILES.bands),
    [`${sha}:${POLICY_FILES.escapes}`]: NO_ESCAPES,
  });
  const queuedInput = async (name: RungOneProof, files: ChangedFile[], contents: Record<string, string>) => {
    const { calls, evaluate } = harness({
      pulls: queued,
      files: { 943: files },
      mergeQueue: fixture("merge_queue.json"),
      runs: [proofRun(name)],
      contents: { ...policyAt(group.base_sha), ...contents },
    });
    await evaluate("workflow_run", relayed);
    return lastRecord(calls).pulls.find(({ number }) => number === 943)?.inputs[name];
  };

  it("counts proof-actions in the queue only while every workflow it read is unchanged under the pull request", async () => {
    const same = await queuedInput("proof-actions", ciOnly, { [`${BASE}:.github/workflows/ci.yml`]: ci, [`${landsOn}:.github/workflows/ci.yml`]: ci });
    assert.deepEqual(same, { status: "ok", holds: true });
    const secret = ci.replace("permissions:", "env:\n  TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\npermissions:");
    assert.notEqual(secret, ci);
    const changed = await queuedInput("proof-actions", ciOnly, { [`${BASE}:.github/workflows/ci.yml`]: ci, [`${landsOn}:.github/workflows/ci.yml`]: secret });
    assert.ok(changed && "absent" in changed && /changed between/.test(changed.absent), JSON.stringify(changed));
    const unread = await queuedInput("proof-actions", ciOnly, { [`${BASE}:.github/workflows/ci.yml`]: ci });
    assert.ok(unread && "absent" in unread, JSON.stringify(unread));
  });

  it("counts proof-deps in the queue only while the release-age policy and base lockfile it read are unchanged", async () => {
    const files = [file("packages/ui/package.json"), file("pnpm-lock.yaml")];
    const lock = "lockfileVersion: '9.0'\npackages:\n  left-pad@1.3.0: {}\n";
    const same = await queuedInput("proof-deps", files, { ...at(BASE, workspace, lock), ...at(landsOn, workspace, lock) });
    assert.deepEqual(same, { status: "ok", holds: true });
    const stricter = workspace.replace(/^minimumReleaseAge: \d+$/m, "minimumReleaseAge: 20160");
    assert.notEqual(stricter, workspace);
    for (const contents of [
      { ...at(BASE, workspace, lock), ...at(landsOn, stricter, lock) },
      { ...at(BASE, workspace, lock), ...at(landsOn, workspace, "lockfileVersion: '9.0'\npackages: {}\n") },
      { ...at(BASE, workspace, lock), [`${landsOn}:pnpm-workspace.yaml`]: workspace },
    ]) {
      const changed = await queuedInput("proof-deps", files, contents);
      assert.ok(changed && "absent" in changed && /unreadable or changed/.test(changed.absent), JSON.stringify(changed));
    }
  });

  it("does not count proof-actions on its own base when a workflow it read cannot be read", async () => {
    const pull = pullRequest({ user: { login: "dependabot[bot]", type: "Bot" } });
    const readable = harness({ pulls: [pull], files: { 7: ciOnly }, runs: [proofRun("proof-actions")], contents: { [`${BASE}:.github/workflows/ci.yml`]: ci } });
    await readable.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(lastRecord(readable.calls).pulls[0]?.inputs["proof-actions"], { status: "ok", holds: true });
    const unread = harness({ pulls: [pull], files: { 7: ciOnly }, runs: [proofRun("proof-actions")] });
    await unread.evaluate("workflow_run", producerCompleted());
    const input = lastRecord(unread.calls).pulls[0]?.inputs["proof-actions"];
    assert.ok(input && "absent" in input && /unreadable/.test(input.absent), JSON.stringify(input));
  });

  it("treats a proof whose commits GitHub cannot compare as absent, and still decides", async () => {
    const { calls, evaluate } = harness({ files: { 7: [file("pnpm-lock.yaml")] }, runs: [proofRun("proof-deps")], uncomparable: true, reviewDecision: { 7: "APPROVED" } });
    await evaluate("workflow_run", producerCompleted());
    const input = lastRecord(calls).pulls[0]?.inputs["proof-deps"];
    assert.ok(input && "absent" in input && /cannot compare/.test(input.absent), JSON.stringify(input));
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
  });

  it("counts proof-equivalence and proof-tests only when made against the commit the pull request lands on", async () => {
    for (const name of ["proof-equivalence", "proof-tests"] as const) {
      const { calls, evaluate } = harness({ runs: [proofRun(name)] });
      await evaluate("workflow_run", producerCompleted());
      assert.deepEqual(lastRecord(calls).pulls[0]?.inputs[name], { status: "ok", holds: true }, name);
      const inQueue = await queuedInput(name, [file("docs/automerge.md")], {});
      assert.ok(inQueue && "absent" in inQueue && /made against/.test(inQueue.absent), `${name}: ${JSON.stringify(inQueue)}`);
    }
  });

  it("counts proof-equivalence and proof-tests only when the head contains its base", async () => {
    for (const name of ["proof-equivalence", "proof-tests"] as const) {
      const { calls, evaluate } = harness({ runs: [proofRun(name)], mergeBases: { [`${BASE}...${HEAD}`]: "e".repeat(40) } });
      await evaluate("workflow_run", producerCompleted());
      const input = lastRecord(calls).pulls[0]?.inputs[name];
      assert.ok(input && "absent" in input && /does not contain/.test(input.absent), `${name}: ${JSON.stringify(input)}`);
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
  it("runs only from main's definition: no pull_request_target, pull_request, review or merge_group triggers", () => {
    const triggers = /^on:\n((?: .*\n|\n)*?)^\S/m.exec(gateWorkflow)?.[1] ?? "";
    assert.deepEqual([...triggers.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]), ["workflow_run", "issue_comment"]);
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
    assert.match(gateWorkflow, /permission-merge-queues: write/);
    assert.doesNotMatch(gateWorkflow, /statuses/);
  });

  it("checks the script out from the default branch", () => {
    assert.match(gateWorkflow, /ref: \$\{\{ github\.workflow_sha \}\}\n/);
    assert.doesNotMatch(gateWorkflow, /github\.event\.(pull_request|workflow_run)\.head\.(ref|sha|repo)/);
  });

  it("relays pull request and review events from a workflow with no permissions or secrets", () => {
    assert.match(relayWorkflow, /^permissions: \{\}$/m);
    assert.doesNotMatch(relayWorkflow, /secrets\./);
    for (const event of ["pull_request", "pull_request_review", "pull_request_review_comment", "merge_group"]) {
      assert.match(relayWorkflow, new RegExp(`^ {2}${event}:`, "m"));
    }
  });

  it("gives no producer workflow checks: write, so only the gate publishes", () => {
    for (const workflow of new Set(Object.values(PRODUCERS).map(({ workflow: path }) => path))) {
      if (existsSync(new URL(workflow, ROOT))) assert.doesNotMatch(read(workflow), /checks: write|write-all/, workflow);
    }
    assert.doesNotMatch(relayWorkflow, /checks: write|write-all/);
  });
});
