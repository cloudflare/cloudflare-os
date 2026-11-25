import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { assertNames } from "./automerge/assert-names.ts";
import { PRODUCERS, artifactName } from "./automerge/producers.ts";
import { VERDICT_NAMES, type Artifact, type WorkflowRun } from "./risk-review-contract.ts";
import { BASE, HEAD, MODELS, proofJson, verdictJson, zip } from "./risk-review-fixtures/artifacts.ts";
import { dig, jobsOf, parseWorkflow, stepsOf, texts } from "./risk-review-fixtures/workflow.ts";
import {
  MAX_DECISION_CHARS,
  POLICY_FILES,
  decide,
  firstOtherBase,
  mergeGroupPulls,
  parseConfig,
  renderOutput,
  runRiskReview,
  type ActionsContext,
  type BaseHistory,
  type ActionsCore,
  type Comment,
  type DecisionRecord,
  type GitHubClient,
  type InputSummary,
  type Policy,
  type PullDecision,
  type PullInputs,
  type PullCommit,
  type PullRequest,
  type Review,
} from "./risk-review.ts";
import { maybeObject, type Json, type JsonObject } from "./automerge/json.ts";
import { parseMaintainers, type ChangedFile } from "./risk-review-policy.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const fixture = (name: string): Json => JSON.parse(read(`scripts/risk-review-fixtures/${name}`));

const NOW = new Date("2026-11-02T12:00:00Z");
const PUSHED = "2026-11-02T10:00:00Z";
const POLICY_SHA = "f".repeat(40);
const APP = { id: 4242, login: "risk-review[bot]" };
const MAINTAINERS = "ndisidore\nMaximo-Guk\nAshishKumar4\nmaxwellpeterson\ndcartertwo\nkentonv\nderegtd\nFBalint\n";
const NO_ESCAPES = JSON.stringify({ schema: 1, window_days: 90, files: [] });

/** `.github/automerge.json` with the named rungs on and a threshold of 7. */
function configJson(mode: "shadow" | "enforce", appApprovalsCount: boolean, on: ("proven" | "scored")[] = []): string {
  return JSON.stringify({
    mode,
    app_approvals_count: appApprovalsCount,
    threshold: 7,
    rungs: { proven: on.includes("proven"), scored: on.includes("scored") },
  });
}

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: "modified", additions: 3, deletions: 1, ...overrides };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    node_id: "PR_kwDOSA1",
    state: "open",
    draft: false,
    user: { login: "kentonv", type: "User" },
    assignees: [],
    head: { sha: HEAD, ref: "kenton/topic" },
    base: { sha: BASE, ref: "main" },
    changed_files: 1,
    commits: 1,
    ...overrides,
  };
}

/** A commit Dependabot made and pushed, as `pulls.listCommits` returns one. */
const DEPENDABOT_COMMIT: PullCommit = {
  sha: "d".repeat(40),
  author: { login: "dependabot[bot]", type: "Bot" },
  committer: { login: "web-flow", type: "User" },
  commit: { verification: { verified: true } },
};

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
    pull_requests: [{ number: 7, base: { ref: "main" } }],
    ...overrides,
  };
}

/** A run of a producer workflow with one artifact per entry. */
interface ProducerRun {
  run: WorkflowRun;
  artifacts: Record<string, string>;
  /** The file inside an artifact's archive, when it is not `<artifact name>.json`. */
  archived?: Record<string, string>;
}

/** Bonk's run and our Opus runner's run on the test head, each with a passing verdict. */
function verdicts(overrides: { bonk?: Record<string, Json | undefined>; opus?: Record<string, Json | undefined> } = {}): ProducerRun[] {
  return [
    {
      run: run(PRODUCERS.bonk.workflow),
      artifacts: { "automerge-verdict-bonk": verdictJson({ name: "bonk", ...overrides.bonk }) },
    },
    {
      run: run(PRODUCERS.opus.workflow),
      artifacts: { "automerge-verdict-opus": verdictJson({ name: "opus", ...overrides.opus }) },
    },
  ];
}

/** What the gate did through the fake client. */
interface Calls {
  checks: { id: number; sha: string }[];
  updates: { id: number; conclusion: string; summary: string; title: string }[];
  /** Each text written to the step summary. */
  summaries: string[];
  approvals: string[];
  dismissals: number[];
  enqueued: { id: string | number | undefined; head: string | number | undefined }[];
}

function notFound(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

/** What a server sent with a failed request, none of which the gate may publish. */
const UPSTREAM = {
  body: "Server failed to authenticate the request",
  header: "req-5f1c9d02",
  url: "https://results.example.net/artifacts/7/artifact.zip?sv=2025-01-05&sig=c2lnbmF0dXJl",
};

/**
 * A failed request as Octokit throws it: the message is built from the response body, and the
 * response rides along with its headers and the URL that answered, after any redirect.
 */
function requestError(status: number): Error {
  return Object.assign(new Error(UPSTREAM.body), {
    name: "HttpError",
    status,
    request: { method: "GET", url: "https://api.github.com/repos/cloudflare/cloudflare-os", headers: { authorization: "token [REDACTED]" } },
    response: { status, url: UPSTREAM.url, headers: { "x-github-request-id": UPSTREAM.header }, data: { message: UPSTREAM.body } },
  });
}

/** A request no server answered, as Octokit throws it: the status 500 and no response. */
function unanswered(): Error {
  return Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { name: "HttpError", status: 500 });
}

/** A refused GraphQL request as Octokit throws it: GitHub's own words, with the response headers. */
function graphqlError(): Error {
  return Object.assign(new Error(`Request failed due to following response errors:\n - ${UPSTREAM.body}`), {
    name: "GraphqlResponseError",
    headers: { "x-github-request-id": UPSTREAM.header },
    errors: [{ type: "UNPROCESSABLE", message: UPSTREAM.body }],
  });
}

/** The error a failed run rejects with, printed as actions/github-script logs it: every property, at any depth. */
async function loggedRejection(gateRun: Promise<void>): Promise<string> {
  try {
    await gateRun;
  } catch (error) {
    return inspect(error, { depth: null, showHidden: true });
  }
  return assert.fail("the run did not fail");
}

function assertNothingUpstream(published: string): void {
  for (const sent of [...Object.values(UPSTREAM), "sig="]) assert.ok(!published.includes(sent), published);
}

/** A request the fake client can be told to fail. */
type GitHubCall =
  | "pulls.get" | "pulls.listFiles" | "pulls.listReviews" | "pulls.createReview"
  | "checks.create" | "checks.update" | "actions.downloadArtifact";

function page<T>(items: T[], { page: number, per_page }: { page: number; per_page: number }): { data: T[] } {
  return { data: items.slice((number - 1) * per_page, number * per_page) };
}

interface HarnessOptions {
  pulls?: PullRequest[];
  files?: Record<number, ChangedFile[]>;
  reviews?: Record<number, Review[]>;
  commits?: Record<number, PullCommit[]>;
  comments?: Record<number, Comment[]>;
  reviewDecision?: Record<number, string | null>;
  runs?: ProducerRun[];
  /** Requests GitHub answers with a server error. */
  failing?: GitHubCall[];
  /** The error a failing request throws; a 502 as Octokit throws it when not given. */
  failWith?: () => Error;
  /** Makes GitHub refuse the enqueue, as it does while required checks are running. */
  enqueueRefused?: true;
  /** The pull request already sits in the merge queue. */
  queued?: true;
  /** Git trees come back truncated. */
  truncatedTrees?: true;
  /** More check suites exist than the one page returned. */
  manySuites?: true;
  /** The runs listing reports more runs than it returned. */
  moreRuns?: true;
  /** Writing the step summary fails. */
  summaryFails?: true;
  /** Closed or other pull requests the `state: "all"` listing also returns. */
  otherPulls?: PullRequest[];
  /**
   * Base histories by pull request number, as GraphQL returns them; `null` makes one unreadable.
   * Unlisted ones were opened on 2026-11-01 into their current base and never changed.
   */
  baseHistories?: Record<number, {
    createdAt: string;
    nodes: { createdAt: string; previousRefName: string; currentRefName: string }[];
    /** More than one page of events. */
    more?: true;
  } | null>;
  /** The pull request's timeline events. */
  timeline?: { event: string; created_at: string }[];
  policy?: Partial<Record<keyof typeof POLICY_FILES, string | undefined>>;
  contents?: Record<string, string>;
  /** Git trees by SHA; a commit's SHA names its root tree. */
  trees?: Record<string, { path: string; mode: string; type: string; sha: string }[]>;
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
  const policy = { maintainers: MAINTAINERS, config: read(POLICY_FILES.config), escapes: NO_ESCAPES, ...options.policy };
  const contents = new Map(Object.entries({
    [`${POLICY_SHA}:${POLICY_FILES.maintainers}`]: policy.maintainers,
    [`${POLICY_SHA}:${POLICY_FILES.config}`]: policy.config,
    [`${POLICY_SHA}:${POLICY_FILES.escapes}`]: policy.escapes,
    ...options.contents,
  }));
  const runs = options.runs ?? [];
  const artifacts = new Map<number, Artifact[]>();
  const zips = new Map<number, Uint8Array>();
  for (const { run: producerRun, artifacts: files, archived } of runs) {
    artifacts.set(producerRun.id, Object.entries(files).map(([name, text]) => {
      const id = ++ids;
      zips.set(id, zip({ [archived?.[name] ?? `${name}.json`]: text }));
      const uploaded = new Date(Date.parse(producerRun.run_started_at ?? producerRun.created_at) + 60_000).toISOString();
      return { id, name, size_in_bytes: text.length, expired: false, created_at: uploaded, workflow_run: { id: producerRun.id } };
    }));
  }
  const calls: Calls = { checks: [], updates: [], summaries: [], approvals: [], dismissals: [], enqueued: [] };
  const refuse = (call: GitHubCall) => {
    if (options.failing?.includes(call)) throw (options.failWith ?? (() => requestError(502)))();
  };

  const github: GitHubClient = {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          refuse("pulls.get");
          const pull = pulls.get(pull_number);
          if (!pull) throw notFound();
          return { data: pull };
        },
        list: async ({ head, state, ...args }) => {
          if (state === "all") {
            const all = [...pulls.values(), ...(options.otherPulls ?? [])];
            return page(all.filter((pull) => `cloudflare:${pull.head.ref}` === head), args);
          }
          return { data: [...pulls.values()].filter(() => head.endsWith(":kenton/topic") || head.endsWith(":chore/classify-changsets")) };
        },
        listFiles: async (args) => {
          refuse("pulls.listFiles");
          return page(options.files?.[args.pull_number] ?? [file("docs/automerge.md")], args);
        },
        listReviews: async (args) => {
          refuse("pulls.listReviews");
          return page(options.reviews?.[args.pull_number] ?? [], args);
        },
        listReviewComments: async (args) => page([], args),
        listCommits: async (args) => page(options.commits?.[args.pull_number] ?? [DEPENDABOT_COMMIT], args),
        createReview: async ({ commit_id }) => {
          refuse("pulls.createReview");
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
        listEventsForTimeline: async (args) => page(options.timeline ?? [], args),
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
      },
      git: {
        getTree: async ({ tree_sha }) => {
          const entries = options.trees?.[tree_sha];
          if (!entries) throw notFound();
          return { data: { tree: entries, truncated: options.truncatedTrees === true } };
        },
      },
      checks: {
        create: async ({ head_sha }) => {
          refuse("checks.create");
          const id = ++ids;
          calls.checks.push({ id, sha: head_sha });
          return { data: { id } };
        },
        update: async ({ check_run_id, conclusion, output }) => {
          refuse("checks.update");
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
          // The head's first suite comes at its push; another app adds one later.
          const later = created === undefined ? undefined : new Date(Date.parse(created) + 1_800_000).toISOString();
          const suites = created === undefined || later === undefined ? [] : [{ created_at: created }, { created_at: later }];
          return { data: { total_count: suites.length + (options.manySuites ? 100 : 0), check_suites: suites } };
        },
      },
      actions: {
        listWorkflowRuns: async ({ workflow_id, head_sha, event }) => {
          const matching = runs.map(({ run: r }) => r).filter((r) => r.path.endsWith(`/${workflow_id}`) && r.head_sha === head_sha && r.event === event);
          return { data: { total_count: matching.length + (options.moreRuns ? 1 : 0), workflow_runs: matching } };
        },
        listWorkflowRunArtifacts: async ({ run_id, name }) =>
          ({ data: { artifacts: (artifacts.get(run_id) ?? []).filter((a) => a.name === name) } }),
        downloadArtifact: async ({ artifact_id }) => {
          refuse("actions.downloadArtifact");
          const bytes = zips.get(artifact_id);
          if (!bytes) throw notFound();
          return { data: bytes.slice().buffer };
        },
      },
    },
    graphql: async (query, variables): Promise<Json> => {
      if (query.includes("BaseRefChangedEvent")) {
        const number = Number(variables.number);
        const other = options.otherPulls?.find((pull) => pull.number === number) ?? pulls.get(number);
        const history = options.baseHistories?.[number];
        if (history === null) return { repository: { pullRequest: null } };
        return {
          repository: {
            pullRequest: {
              createdAt: history?.createdAt ?? "2026-11-01T09:00:00Z",
              baseRefName: other?.base.ref ?? "main",
              timelineItems: { pageInfo: { hasNextPage: history?.more === true }, nodes: history?.nodes ?? [] },
            },
          },
        };
      }
      if (query.includes("enqueuePullRequest")) {
        if (options.enqueueRefused) throw graphqlError();
        calls.enqueued.push({ id: variables.id, head: variables.head });
        return { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_1" } } };
      }
      if (query.includes("mergeQueue(")) return options.mergeQueue ?? null;
      if (query.includes("mergeQueueEntry")) {
        return { repository: { pullRequest: { mergeQueueEntry: options.queued ? { id: "MQE_0" } : null } } };
      }
      const decision = options.reviewDecision?.[Number(variables.number)];
      return { repository: { pullRequest: { reviewDecision: decision === undefined ? "REVIEW_REQUIRED" : decision } } };
    },
  };
  const core: ActionsCore = {
    notice: () => {},
    summary: {
      addRaw: (text) => {
        calls.summaries.push(text);
        return core.summary;
      },
      write: async () => {
        if (options.summaryFails) throw requestError(507);
        return {};
      },
    },
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

describe("parseConfig", () => {
  const SHADOW = parseConfig(undefined).config;

  it("ships in shadow mode with both rungs off and App approvals not counted", () => {
    const { config, problem } = parseConfig(read(POLICY_FILES.config));
    assert.equal(problem, undefined);
    assert.equal(config.mode, "shadow");
    assert.equal(config.appApprovalsCount, false);
    assert.deepEqual(config.rungs, { proven: false, scored: false });
  });

  it("reads the mode, whether App approvals count, the threshold and each rung's switch", () => {
    assert.deepEqual(parseConfig(configJson("enforce", true, ["scored"])),
      { config: { mode: "enforce", appApprovalsCount: true, threshold: 7, rungs: { proven: false, scored: true } } });
  });

  it("falls back to shadow mode with both rungs off when the file is missing or malformed", () => {
    assert.equal(SHADOW.mode, "shadow");
    assert.equal(SHADOW.appApprovalsCount, false);
    assert.deepEqual(SHADOW.rungs, { proven: false, scored: false });
    const enforce = JSON.parse(configJson("enforce", true, ["proven", "scored"]));
    const malformed: Record<string, Json>[] = [
      { ...enforce, mode: "on" },
      { ...enforce, app_approvals_count: "true" },
      { ...enforce, threshold: null },
      { ...enforce, threshold: 7.5 },
      { ...enforce, threshold: 11 },
      { ...enforce, threshold: -1 },
      { ...enforce, rungs: { proven: true } },
      { ...enforce, rungs: { proven: true, scored: "yes" } },
      { ...enforce, rungs: [true, true] },
    ];
    for (const text of ["{", "[]", "null", ...malformed.map((config) => JSON.stringify(config))]) {
      const parsed = parseConfig(text);
      assert.deepEqual(parsed.config, SHADOW, text);
      assert.ok(parsed.problem, text);
    }
  });
});

function inputs(overrides: Partial<PullInputs> = {}): PullInputs {
  return {
    pull: pullRequest(),
    files: [file("docs/automerge.md")],
    facts: { workspaceCatalogOnly: true, newDependencies: [], durableObjectRisks: [], skillSymlinks: [] },
    reviews: [],
    comments: [],
    lastPush: PUSHED,
    reviewDecision: "REVIEW_REQUIRED",
    producers: {},
    commits: [DEPENDABOT_COMMIT],
    ...overrides,
  };
}

function policyWith(config: string, maintainers = parseMaintainers(MAINTAINERS)): Policy {
  return { sha: POLICY_SHA, maintainers, config: parseConfig(config).config, escapes: { windowDays: 90, files: [] } };
}

const SCORED = policyWith(configJson("enforce", true, ["scored"]));
const PROVEN = policyWith(configJson("enforce", true, ["proven"]));
const BOTH = policyWith(configJson("enforce", true, ["proven", "scored"]));

function verdictInput(name: "bonk" | "opus", overrides: Record<string, Json | undefined> = {}) {
  return { artifact: { ...JSON.parse(verdictJson({ name, ...overrides })), name } };
}

const PERFECT = { bonk: verdictInput("bonk"), opus: verdictInput("opus") };

/** Both verdicts, differing from `PERFECT` in one field. */
function verdictsWith(key: "merge_confidence" | "model", bonk: Json, opus: Json) {
  return { bonk: verdictInput("bonk", { [key]: bonk }), opus: verdictInput("opus", { [key]: opus }) };
}

function proofInput(name: "proof-deps" | "proof-tests" | "preview-smoke", holds = true, overrides: Record<string, Json> = {}) {
  return { artifact: { ...JSON.parse(proofJson(name, holds, overrides)), name } };
}

const DEPENDABOT_PROVEN = { "proof-deps": proofInput("proof-deps"), "preview-smoke": proofInput("preview-smoke") };
const AUTO_SCORED = { decision: "auto", rung: "scored", reasons: [] };
const AUTO_PROVEN = { decision: "auto", rung: "proven", reasons: [] };
/** A low-risk change to source, which a proof can take; the default change is to docs, which none can. */
const SOURCE = [file("packages/workshop-frontend/src/App.tsx")];

describe("decide", () => {
  it("lets a maintainer's low-risk change through rung 2 when both verdicts clear it", () => {
    assert.deepEqual(decide(inputs({ producers: PERFECT }), SCORED, NOW).would, AUTO_SCORED);
  });

  it("sends every pull request to a person while both rungs are off", () => {
    const off = policyWith(configJson("enforce", true));
    assert.equal(decide(inputs({ files: SOURCE, producers: { ...PERFECT, "proof-tests": proofInput("proof-tests") } }), off, NOW).would.decision, "person");
    const pull = pullRequest({ user: { login: "dependabot[bot]", type: "Bot" } });
    assert.equal(decide(inputs({ pull, files: [file("packages/ui/package.json")], producers: DEPENDABOT_PROVEN }), off, NOW).would.decision, "person");
  });

  it("takes a rung only when that rung is on", () => {
    const proof = { "proof-tests": proofInput("proof-tests") };
    assert.deepEqual(decide(inputs({ files: SOURCE, producers: proof }), PROVEN, NOW).would, AUTO_PROVEN);
    assert.equal(decide(inputs({ files: SOURCE, producers: proof }), SCORED, NOW).would.decision, "person");
    assert.deepEqual(decide(inputs({ files: SOURCE, producers: PERFECT }), SCORED, NOW).would, AUTO_SCORED);
    assert.equal(decide(inputs({ files: SOURCE, producers: PERFECT }), PROVEN, NOW).would.decision, "person");
    assert.deepEqual(decide(inputs({ files: SOURCE, producers: { ...PERFECT, ...proof } }), BOTH, NOW).would, AUTO_PROVEN);
  });

  it("never lets an AI decide on a policy file, whatever the verdicts, proofs and rungs", () => {
    for (const path of [".github/workflows/review-verdict.yml", ".github/automerge.json", "scripts/automerge/verdict/run.ts", "REVIEW.md", "packages/ui/AGENTS.md"]) {
      const decision = decide(inputs({ files: [file(path)], producers: { ...PERFECT, "proof-tests": proofInput("proof-tests") } }), BOTH, NOW);
      assert.equal(decision.would.decision, "person", path);
      assert.notDeepEqual(decision.never_auto, [], path);
    }
  });

  // The reviewers read the base's copy of each of these, so the pull request's version first
  // steers a review after it merges.
  it("never lets an AI decide on a file a reviewer reads as instructions, wherever it sits", () => {
    assert.deepEqual(decide(inputs({ files: [file("docs/observers.md", { status: "added" })], producers: PERFECT }), SCORED, NOW).would, AUTO_SCORED);
    for (const path of ["docs/CONTEXT.md", ".claude/settings.json", "CONTRIBUTING.md", "docs/review.md", "docs/Agents.MD"]) {
      const decision = decide(inputs({ files: [file(path, { status: "added" })], producers: PERFECT }), SCORED, NOW);
      assert.equal(decision.would.decision, "person", path);
      assert.notDeepEqual(decision.never_auto, [], path);
    }
  });

  it("never lets an AI decide on a Worker config change that may drop Durable Object data", () => {
    const risky = inputs({
      files: [file("packages/gatekeeper-x/wrangler.jsonc")],
      facts: { workspaceCatalogOnly: true, newDependencies: [], durableObjectRisks: ["packages/gatekeeper-x/wrangler.jsonc: reuses the tag v1"], skillSymlinks: [] },
      producers: { ...PERFECT, "proof-tests": proofInput("proof-tests") },
    });
    assert.equal(decide(risky, BOTH, NOW).would.decision, "person");
    assert.equal(decide({ ...risky, facts: inputs().facts }, BOTH, NOW).would.decision, "auto");
  });

  it("holds a pull request a maintainer commented on after the last push", () => {
    // Recorded: a maintainer's review of #845, a comment made after 795f5aa4 was pushed.
    const recorded = fixture("pull_request_review.json");
    const { review: recordedReview } = JSON.parse(JSON.stringify(recorded));
    const held = inputs({ reviews: [recordedReview], lastPush: "2026-10-22T05:00:00Z", producers: PERFECT });
    const decision = decide(held, SCORED, NOW);
    assert.equal(decision.would.decision, "person");
    assert.equal(decision.holds.length, 1);
    assert.ok(decision.holds[0]?.includes("deregtd"));
    assert.equal(decide({ ...held, reviews: [] }, SCORED, NOW).would.decision, "auto");
  });

  it("holds for a maintainer's comment on the pull request after the last push", () => {
    const comments: Comment[] = [{ user: { login: "deregtd", type: "User" }, created_at: "2026-11-02T11:00:00Z" }];
    const decision = decide(inputs({ comments, producers: PERFECT }), SCORED, NOW);
    assert.equal(decision.holds.length, 1);
    assert.equal(decision.would.decision, "person");
  });

  it("does not hold for the author, a non-maintainer, a bot, an approval, or a comment before the push", () => {
    const comments: Comment[] = [
      { user: { login: "kentonv", type: "User" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "outsider", type: "User" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "ask-bonk[bot]", type: "Bot" }, created_at: "2026-11-02T11:00:00Z" },
      { user: { login: "deregtd", type: "User" }, created_at: "2026-11-02T09:00:00Z" },
    ];
    const decision = decide(inputs({ comments, reviews: [review("Maximo-Guk", "APPROVED")], producers: PERFECT }), SCORED, NOW);
    assert.deepEqual(decision.holds, []);
    assert.equal(decision.would.decision, "auto");
  });

  it("holds when the push time is unknown", () => {
    assert.equal(decide(inputs({ lastPush: undefined, producers: PERFECT }), SCORED, NOW).would.decision, "person");
  });

  // Requested before the last push, so it is no hold: only the standing request stops the merge.
  it("sends a standing change request to a person, whatever the rungs take", () => {
    const earlier = { submitted_at: "2026-11-02T09:00:00Z" };
    const blocked = inputs({ files: SOURCE, reviews: [review("deregtd", "CHANGES_REQUESTED", earlier)], producers: { ...PERFECT, "proof-tests": proofInput("proof-tests") } });
    const decision = decide(blocked, BOTH, NOW);
    assert.equal(decision.would.decision, "person");
    assert.deepEqual(decision.blockers, ["deregtd"]);
    assert.deepEqual(decision.holds, []);
    assert.equal(decide({ ...blocked, reviews: [] }, BOTH, NOW).would.decision, "auto");
  });

  it("counts each maintainer's latest review, so an approval lifts a change request and a change request ends an approval", () => {
    const [earlier, later] = [{ submitted_at: "2026-11-02T08:00:00Z" }, { submitted_at: "2026-11-02T09:00:00Z" }];
    const lifted = [review("deregtd", "CHANGES_REQUESTED", earlier), review("deregtd", "APPROVED", later)];
    assert.deepEqual(decide(inputs({ reviews: lifted, producers: PERFECT }), SCORED, NOW).would, AUTO_SCORED);
    const ended = [review("deregtd", "APPROVED", earlier), review("deregtd", "CHANGES_REQUESTED", later)];
    const decision = decide(inputs({ reviews: ended, producers: PERFECT }), SCORED, NOW);
    assert.deepEqual(decision.approvers, []);
    assert.equal(decision.would.decision, "person");
  });

  it("sends a pull request that lists fewer files than it changed to a person", () => {
    const decision = decide(inputs({ pull: pullRequest({ changed_files: 2 }), producers: PERFECT }), SCORED, NOW);
    assert.equal(decision.would.decision, "person");
    assert.notDeepEqual(decision.never_auto, []);
  });

  it("takes an author for a maintainer only as a user, and for Dependabot only as a bot", () => {
    const producers = { ...PERFECT, "proof-tests": proofInput("proof-tests") };
    const bot = pullRequest({ user: { login: "kentonv", type: "Bot" } });
    assert.equal(decide(inputs({ files: SOURCE, pull: bot, producers }), BOTH, NOW).would.decision, "person");
    const user = pullRequest({ user: { login: "dependabot[bot]", type: "User" } });
    assert.equal(decide(inputs({ files: [file("packages/ui/package.json")], pull: user, producers: DEPENDABOT_PROVEN }), PROVEN, NOW).would.decision, "person");
  });

  it("reads maintainers from the list only, case-insensitively, and from nowhere when it is missing", () => {
    const outsider = pullRequest({ user: { login: "contributor", type: "User" } });
    for (const producers of [PERFECT, { "proof-tests": proofInput("proof-tests") }]) {
      assert.equal(decide(inputs({ files: SOURCE, pull: outsider, producers }), BOTH, NOW).would.decision, "person");
      assert.equal(decide(inputs({ files: SOURCE, producers }), BOTH, NOW).would.decision, "auto");
    }
    const approved = inputs({ reviews: [review("maximo-guk", "APPROVED")] });
    assert.deepEqual(decide(approved, SCORED, NOW).approvers, ["maximo-guk"]);
    const nobody = policyWith(configJson("enforce", true, ["proven", "scored"]), parseMaintainers(undefined));
    assert.deepEqual(decide(approved, nobody, NOW).approvers, []);
    assert.equal(decide(inputs({ producers: PERFECT }), nobody, NOW).would.decision, "person");
  });

  it("counts either reviewer's missing, failed or malformed verdict as absent", () => {
    assert.equal(decide(inputs({ producers: {} }), SCORED, NOW).would.decision, "person");
    for (const name of VERDICT_NAMES) {
      const alone = Object.fromEntries(VERDICT_NAMES.filter((other) => other !== name).map((other) => [other, PERFECT[other]]));
      for (const producers of [
        alone,
        { ...PERFECT, [name]: { absent: "malformed merge_confidence" } },
        // A verdict that reports a failure does not count, whatever score it carries.
        { ...PERFECT, [name]: verdictInput(name, { status: "error" }) },
        { ...PERFECT, [name]: verdictInput(name, { status: "not_applicable" }) },
      ]) {
        assert.equal(decide(inputs({ producers }), SCORED, NOW).would.decision, "person", `${name}: ${JSON.stringify(producers)}`);
      }
    }
  });

  it("sends either reviewer's P0 or P1 finding, NEEDS-A-PERSON line, missing score or score under the threshold to a person", () => {
    const [p0, p1, p2, p3] = ["P0", "P1", "P2", "P3"].map((severity) => ({ findings: [{ severity, title: "Drops the table", path: "a.ts", line: 1 }] }));
    for (const name of VERDICT_NAMES) {
      for (const fault of [p0, p1, { needs_person: ["changes the RPC API"] }, { merge_confidence: null }, { merge_confidence: 6 }]) {
        const producers = { ...PERFECT, [name]: verdictInput(name, fault) };
        assert.equal(decide(inputs({ producers }), SCORED, NOW).would.decision, "person", `${name}: ${JSON.stringify(fault)}`);
      }
      for (const fine of [p2, p3]) {
        const producers = { ...PERFECT, [name]: verdictInput(name, fine) };
        assert.deepEqual(decide(inputs({ producers }), SCORED, NOW).would, AUTO_SCORED, `${name}: ${JSON.stringify(fine)}`);
      }
    }
  });

  it("takes the lower of the two scores, which must be at least the threshold", () => {
    const threshold = SCORED.config.threshold;
    for (const { bonk, opus, decision } of [
      { bonk: threshold, opus: 10, decision: "auto" },
      { bonk: 10, opus: threshold, decision: "auto" },
      { bonk: threshold - 1, opus: 10, decision: "person" },
      { bonk: 10, opus: threshold - 1, decision: "person" },
    ]) {
      const { would } = decide(inputs({ producers: verdictsWith("merge_confidence", bonk, opus) }), SCORED, NOW);
      assert.equal(would.decision, decision, `${bonk} and ${opus}`);
    }
  });

  it("sends either reviewer's diff-only re-review to a person", () => {
    for (const name of VERDICT_NAMES) {
      const diffOnly = { ...PERFECT, [name]: verdictInput(name, { round: 3, review_from_sha: "c".repeat(40) }) };
      assert.equal(decide(inputs({ producers: diffOnly }), SCORED, NOW).would.decision, "person", name);
      const full = { ...PERFECT, [name]: verdictInput(name, { round: 3 }) };
      assert.deepEqual(decide(inputs({ producers: full }), SCORED, NOW).would, AUTO_SCORED, name);
    }
  });

  // Bonk's model is a repository variable no pull request reviews, so nothing else keeps the two
  // reviewers from being one model family.
  it("sends verdicts whose models share a provider, or name none the gate can read, to a person", () => {
    assert.deepEqual(decide(inputs({ producers: verdictsWith("model", MODELS.bonk, MODELS.opus) }), SCORED, NOW).would, AUTO_SCORED);
    for (const [bonk, opus] of [
      [MODELS.opus, MODELS.opus],
      ["cloudflare-ai-gateway/anthropic/claude-sonnet-5", MODELS.opus],
      ["cloudflare-ai-gateway/Anthropic/claude-sonnet-5", MODELS.opus],
      [MODELS.bonk, "cloudflare-ai-gateway/openai/gpt-6.1-sol-mini"],
      ["", MODELS.opus],
      [MODELS.bonk, ""],
      ["openai/gpt-6.1-sol", MODELS.opus],
      ["cloudflare-ai-gateway/openrouter/anthropic/claude-opus-5.5", MODELS.opus],
      ["cloudflare-ai-gateway/ /gpt-6.1-sol", MODELS.opus],
    ] as const) {
      assert.equal(decide(inputs({ producers: verdictsWith("model", bonk, opus) }), SCORED, NOW).would.decision, "person", `${bonk} and ${opus}`);
    }
  });

  it("never scores a medium or high risk change, which a proof can still take", () => {
    const proof = { "proof-tests": proofInput("proof-tests") };
    for (const [path, band] of [["packages/gatekeeper-x/src/x-normalize.ts", "medium"], ["packages/workshop-backend/src/agent.ts", "high"]] as const) {
      const scored = decide(inputs({ files: [file(path)], producers: PERFECT }), BOTH, NOW);
      assert.equal(scored.band, band, path);
      assert.equal(scored.would.decision, "person", path);
      assert.deepEqual(decide(inputs({ files: [file(path)], producers: { ...PERFECT, ...proof } }), BOTH, NOW).would, AUTO_PROVEN, path);
    }
  });

  it("proves a maintainer's change only through the test proof, when it holds", () => {
    assert.deepEqual(decide(inputs({ files: SOURCE, producers: { "proof-tests": proofInput("proof-tests") } }), PROVEN, NOW).would, AUTO_PROVEN);
    for (const producers of [
      {},
      { "proof-tests": proofInput("proof-tests", false) },
      { "proof-tests": { absent: "concluded failure" } },
      // A proof that reports a failure does not hold, whatever it says of itself.
      { "proof-tests": proofInput("proof-tests", true, { status: "error" }) },
      { "proof-tests": proofInput("proof-tests", true, { status: "not_applicable" }) },
      // The dependency proof and the preview smoke are Dependabot's, and prove nothing for a maintainer.
      DEPENDABOT_PROVEN,
      { ...DEPENDABOT_PROVEN, "proof-tests": proofInput("proof-tests", false) },
    ]) {
      assert.equal(decide(inputs({ files: SOURCE, producers }), PROVEN, NOW).would.decision, "person", JSON.stringify(producers));
      // Rung 2 is still open to it.
      assert.deepEqual(decide(inputs({ files: SOURCE, producers: { ...producers, ...PERFECT } }), BOTH, NOW).would, AUTO_SCORED, JSON.stringify(producers));
    }
  });

  it("proves a Dependabot pull request only when its dependency proof and preview smoke both hold, whatever its risk level", () => {
    const pull = pullRequest({ user: { login: "dependabot[bot]", type: "Bot" } });
    const files = [file("packages/ui/package.json")];
    assert.deepEqual(decide(inputs({ pull, files, producers: DEPENDABOT_PROVEN }), PROVEN, NOW).would, AUTO_PROVEN);
    for (const producers of [
      { "proof-deps": proofInput("proof-deps") },
      { "preview-smoke": proofInput("preview-smoke") },
      { ...DEPENDABOT_PROVEN, "proof-deps": proofInput("proof-deps", false) },
      { ...DEPENDABOT_PROVEN, "preview-smoke": proofInput("preview-smoke", false) },
      { ...DEPENDABOT_PROVEN, "proof-deps": proofInput("proof-deps", true, { status: "error" }) },
      { ...DEPENDABOT_PROVEN, "preview-smoke": proofInput("preview-smoke", true, { status: "error" }) },
      // Dependabot never qualifies through a maintainer's proof or through AI verdicts.
      { "proof-tests": proofInput("proof-tests") },
      PERFECT,
    ]) {
      const { would } = decide(inputs({ pull, files, producers }), BOTH, NOW);
      assert.equal(would.decision, "person", JSON.stringify(Object.keys(producers)));
      assert.notDeepEqual(would.reasons, [], "the record says why");
    }
    // Its proofs hold, but rung 1 is off: rung 2 is no second way in for Dependabot.
    assert.equal(decide(inputs({ pull, files: SOURCE, producers: { ...DEPENDABOT_PROVEN, ...PERFECT } }), SCORED, NOW).would.decision, "person");
    const large = decide(inputs({ pull, files: [file("pnpm-lock.yaml", { additions: 400, deletions: 300 })], producers: DEPENDABOT_PROVEN }), PROVEN, NOW);
    assert.equal(large.band, "high");
    assert.deepEqual(large.would, AUTO_PROVEN);
  });

  describe("a Dependabot pull request", () => {
    // Recorded: #621, Dependabot's bump of three actions across ci.yml, preview.yml,
    // workshop-evals-pr.yml and workshop-evals.yml.
    const recorded = JSON.parse(read("scripts/risk-review-fixtures/dependabot-actions-621.json"));
    const pull621 = pullRequest({ ...recorded.pull, base: { ...recorded.pull.base } });
    const files621: ChangedFile[] = recorded.files;
    const ciOnly = files621.filter(({ filename }) => filename === ".github/workflows/ci.yml");
    const ciPull = { ...pull621, changed_files: ciOnly.length };

    it("needs a person when it bumps an action in a workflow, whatever holds", () => {
      const producers = { ...DEPENDABOT_PROVEN, ...PERFECT, "proof-tests": proofInput("proof-tests") };
      for (const [pull, files] of [[ciPull, ciOnly], [pull621, files621]] as const) {
        const decision = decide(inputs({ pull, files: [...files], producers }), BOTH, NOW);
        assert.equal(decision.would.decision, "person");
        assert.notDeepEqual(decision.never_auto, []);
      }
      // The same pull request, had it changed a package manifest instead.
      assert.deepEqual(decide(inputs({ pull: ciPull, files: [file("packages/ui/package.json")], producers }), BOTH, NOW).would, AUTO_PROVEN);
    });

    it("needs every commit to be a verified Dependabot commit", async () => {
      // Recorded: #993, where a maintainer pushed an unverified commit onto Dependabot's verified one.
      const pr993 = JSON.parse(read("scripts/risk-review-fixtures/dependabot-pr-993.json"));
      const commits: PullCommit[] = pr993.commits;
      const [dependabotCommit, pushed] = commits;
      assert.ok(dependabotCommit && pushed);
      const bump = { pull: ciPull, files: [file("packages/ui/package.json")], producers: DEPENDABOT_PROVEN };
      assert.deepEqual(decide(inputs({ ...bump, commits: [dependabotCommit] }), PROVEN, NOW).would, AUTO_PROVEN);
      const mixed = decide(inputs({ ...bump, commits }), PROVEN, NOW);
      assert.equal(mixed.would.decision, "person");
      assert.ok(mixed.would.reasons.some((reason) => reason.includes(pushed.sha.slice(0, 7))), "the reasons name the commit");
      for (const other of [
        { ...dependabotCommit, commit: { verification: { verified: false } } },
        { ...dependabotCommit, author: { login: "ndisidore", type: "User" } },
        { ...dependabotCommit, author: null },
        { ...dependabotCommit, committer: { login: "ndisidore", type: "User" } },
      ]) {
        assert.equal(decide(inputs({ ...bump, commits: [dependabotCommit, other] }), PROVEN, NOW).would.decision, "person", JSON.stringify(other));
      }
      assert.equal(decide(inputs({ ...bump, commits: undefined }), PROVEN, NOW).would.decision, "person");
      // A pull request with more commits than the API lists counts as unlisted.
      for (const [count, decision] of [[1, "auto"], [251, "person"]] as const) {
        const { calls, evaluate } = harness({
          pulls: [pullRequest({ user: { login: "dependabot[bot]", type: "Bot" }, commits: count })],
          files: { 7: [file("pnpm-lock.yaml")] },
          policy: { config: configJson("shadow", false, ["proven"]) },
          runs: [proofRun("proof-deps"), smokeIn(PRODUCERS["preview-smoke"].workflow)],
          contents: at(BASE, "minimumReleaseAge: 10080\n", "lockfileVersion: '9.0'\n"),
        });
        await evaluate("workflow_run", producerCompleted());
        assert.equal(lastRecord(calls).pulls[0]?.would.decision, decision, `${count} commits`);
      }
    });
  });

  it("requires a human assignee's approval on a pull request an agent opened", () => {
    const pull = pullRequest({ user: { login: "ask-bonk[bot]", type: "Bot" }, assignees: [{ login: "kentonv", type: "User" }] });
    assert.equal(decide(inputs({ pull, reviews: [review("deregtd", "APPROVED")] }), SCORED, NOW).gate.passes, false);
    assert.equal(decide(inputs({ pull, reviews: [review("kentonv", "APPROVED")] }), SCORED, NOW).gate.passes, true);
    assert.equal(decide(inputs({ pull: { ...pull, assignees: [] }, reviews: [review("kentonv", "APPROVED")] }), SCORED, NOW).gate.passes, false);
  });

  it("needs a maintainer's approval of the head commit, and blocks on a change request", () => {
    assert.equal(decide(inputs({ reviews: [review("deregtd", "APPROVED", { commit_id: BASE })] }), SCORED, NOW).gate.passes, false);
    assert.equal(decide(inputs({ reviews: [review("deregtd", "APPROVED")] }), SCORED, NOW).gate.passes, true);
    const blocked = decide(inputs({ reviews: [review("deregtd", "APPROVED"), review("kentonv", "CHANGES_REQUESTED", { user: { login: "FBalint", type: "User" } })] }), SCORED, NOW);
    assert.equal(blocked.gate.passes, false);
  });
});

describe("runRiskReview in shadow mode", () => {
  it("mirrors today's rule on the head and records the decision, from the shipped config", async () => {
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

  it("stays in shadow mode with both rungs off when the config is missing or malformed", async () => {
    for (const config of [undefined, "{", JSON.stringify({ mode: "enforce", app_approvals_count: true, threshold: 0, rungs: { proven: true } })]) {
      const { calls, evaluate } = harness({ policy: { config }, runs: [...verdicts(), proofRun("proof-tests")], reviewDecision: { 7: "APPROVED" } });
      await evaluate("workflow_run", producerCompleted());
      const record = lastRecord(calls);
      assert.equal(record.mode, "shadow", String(config));
      assert.ok(record.config_problem, String(config));
      assert.equal(record.pulls[0]?.would.decision, "person", String(config));
      assert.equal(calls.updates.at(-1)?.conclusion, "success", String(config));
      assert.deepEqual([calls.approvals, calls.enqueued, calls.dismissals], [[], [], []], String(config));
    }
  });

  it("cannot approve or enqueue, even when a rung is on and every input passes", async () => {
    const { calls, evaluate } = harness({
      policy: { config: configJson("shadow", true, ["scored"]) },
      runs: verdicts(),
    });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "auto");
    assert.equal(calls.updates.at(-1)?.conclusion, "failure");
    assert.deepEqual(calls.approvals, []);
    assert.deepEqual(calls.enqueued, []);
    assert.deepEqual(calls.dismissals, []);
  });

  it("decides the pull request a recorded review relay run names", async () => {
    // Recorded: the relay's run for a maintainer's review of #845 (pull_request_review), and that review.
    const relay = fixture("workflow_run.json");
    const reviewEvent = JSON.parse(JSON.stringify(fixture("pull_request_review.json")));
    const pull = pullRequest({ number: 845, user: { login: "ndisidore", type: "User" }, head: { sha: reviewEvent.pull_request.head.sha, ref: reviewEvent.pull_request.head.ref }, base: { sha: reviewEvent.pull_request.base.sha, ref: "main" } });
    const { calls, evaluate } = harness({ pulls: [pull], reviews: { 845: [reviewEvent.review] }, lastPush: "2026-10-22T05:00:00Z" });
    await evaluate("workflow_run", relay);
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [reviewEvent.pull_request.head.sha]);
    const record = lastRecord(calls);
    assert.equal(record.pulls[0]?.number, 845);
    assert.equal(record.pulls[0]?.holds.length, 1);
    assert.ok(record.pulls[0]?.holds[0]?.includes(reviewEvent.review.user.login));
  });

  it("decides the pull request a recorded maintainer comment is on", async () => {
    const pull = pullRequest({ number: 881, user: { login: "maxwellpeterson", type: "User" } });
    const { calls, evaluate } = harness({ pulls: [pull], reviewDecision: { 881: "APPROVED" } });
    await evaluate("issue_comment", fixture("issue_comment.json"));
    assert.deepEqual(calls.checks.map(({ sha }) => sha), [HEAD]);
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
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

  it("counts nobody as a maintainer when the base has no maintainers file, or an unreadable one", async () => {
    for (const maintainers of [undefined, "kentonv\n@deregtd\n"]) {
      const { calls, evaluate } = harness({ policy: { maintainers }, reviews: { 7: [review("deregtd", "APPROVED")] } });
      await evaluate("workflow_run", producerCompleted());
      const pull = lastRecord(calls).pulls[0];
      assert.deepEqual(pull?.approvers, [], String(maintainers));
      assert.equal(pull?.author.maintainer, false);
    }
    const listed = harness({ reviews: { 7: [review("deregtd", "APPROVED")] } });
    await listed.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(lastRecord(listed.calls).pulls[0]?.approvers, ["deregtd"]);
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
  const pulls = [939, 943].map((number) => pullRequest({ number, head: { sha: String(number).repeat(14).slice(0, 40), ref: `topic-${number}` } }));
  const basePolicy = {
    [`${group.base_sha}:${POLICY_FILES.maintainers}`]: MAINTAINERS,
    [`${group.base_sha}:${POLICY_FILES.config}`]: read(POLICY_FILES.config),
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
    assert.equal(record.config_problem, undefined);
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

// GitHub computes a run's `pull_requests` when the run is read: any open pull request whose head
// matches. So a run that another pull request triggered still lists #7 into main.
function forgedAt(overrides: Partial<WorkflowRun>): ProducerRun[] {
  return verdicts({ bonk: { merge_confidence: 10 } }).map((entry) => ({
    ...entry,
    run: { ...entry.run, id: entry.run.id + 1000, created_at: "2026-11-02T11:00:00Z", run_started_at: "2026-11-02T11:00:00Z", ...overrides },
  }));
}

/** Bonk's score in the last record, or its input when absent. */
function bonkScore(calls: Calls): number | null | InputSummary | undefined {
  const bonk = lastRecord(calls).pulls[0]?.inputs.bonk;
  return bonk && "merge_confidence" in bonk ? bonk.merge_confidence : bonk;
}

/** Why the last record counts Bonk's verdict as absent; `undefined` when it counts or has no run. */
function bonkAbsent(calls: Calls): string | undefined {
  const bonk = lastRecord(calls).pulls[0]?.inputs.bonk;
  return bonk && "absent" in bonk ? bonk.absent : undefined;
}

/** A base history for #8, opened at 09:00 and now into `baseRefName`. */
function history8(baseRefName: string, changes: BaseHistory["changes"]): BaseHistory {
  return { number: 8, createdAt: Date.parse("2026-11-02T09:00:00Z"), baseRefName, changes };
}

describe("firstOtherBase", () => {

  it("finds when a pull request first had another base", () => {
    assert.equal(firstOtherBase(history8("main", []), "main"), undefined);
    assert.deepEqual(firstOtherBase(history8("evil", []), "main"), { at: Date.parse("2026-11-02T09:00:00Z"), base: "evil" });
    const away = history8("main", [
      { at: Date.parse("2026-11-02T12:00:00Z"), from: "evil", to: "main" },
      { at: Date.parse("2026-11-02T11:00:00Z"), from: "main", to: "evil" },
    ]);
    assert.deepEqual(firstOtherBase(away, "main"), { at: Date.parse("2026-11-02T11:00:00Z"), base: "evil" });
    assert.deepEqual(firstOtherBase(history8("main", [{ at: Date.parse("2026-11-02T10:00:00Z"), from: "evil", to: "main" }]), "main"),
      { at: Date.parse("2026-11-02T09:00:00Z"), base: "evil" });
  });
});

describe("runRiskReview producer binding", () => {
  const open = { policy: { config: configJson("shadow", true, ["scored"]) } };

  it("reads both verdicts from a bound run", async () => {
    const { calls, evaluate } = harness({ ...open, runs: verdicts() });
    await evaluate("workflow_run", producerCompleted());
    const bonk = lastRecord(calls).pulls[0]?.inputs.bonk;
    assert.equal(bonk && "status" in bonk ? bonk.status : undefined, "ok");
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "auto");
  });

  it("lets either reviewer's newer failed or unfinished attempt beat an older success, whatever it uploaded", async () => {
    for (const name of VERDICT_NAMES) {
      for (const state of [{ conclusion: "failure" }, { status: "in_progress", conclusion: null }]) {
        const newer = {
          run: run(PRODUCERS[name].workflow, { created_at: "2026-11-02T10:30:00Z", run_started_at: "2026-11-02T10:30:00Z", ...state }),
          artifacts: { [artifactName(name)]: verdictJson({ name, merge_confidence: 10 }) },
        };
        const { calls, evaluate } = harness({ ...open, runs: [...verdicts(), newer] });
        await evaluate("workflow_run", producerCompleted());
        const pull = lastRecord(calls).pulls[0];
        assert.ok(pull?.inputs[name] && "absent" in pull.inputs[name], `${name}: ${JSON.stringify(state)}`);
        assert.equal(pull.would.decision, "person");
      }
    }
  });

  it("ignores a run of the same commit from another branch, whose pull request targets a replaced workflow", async () => {
    const { calls, evaluate } = harness({ ...open, runs: [...verdicts(), ...forgedAt({ head_branch: "attacker/same-commit" })] });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(bonkScore(calls), 8);
  });

  it("trusts no producer run when another pull request from the same branch targets another base, even a closed one", async () => {
    const elsewhere = pullRequest({ number: 8, state: "closed", base: { sha: BASE, ref: "release" } });
    const { calls, evaluate } = harness({ ...open, runs: verdicts(), otherPulls: [elsewhere] });
    await evaluate("workflow_run", producerCompleted());
    assert.ok(bonkAbsent(calls)?.includes("#8"), "the record names the sibling");
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "person");
    const sameBase = harness({ ...open, runs: verdicts(), otherPulls: [pullRequest({ number: 6, state: "closed" })] });
    await sameBase.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(sameBase.calls).pulls[0]?.would.decision, "auto");
  });

  it("remembers that a sibling targeted another base after it was retargeted to main, and fences runs from then", async () => {
    // #8 opened into `evil` (whose producer workflow was replaced) at 09:30, uploaded a forged
    // verdict for this head at 11:00, then moved to main at 11:30 and closed.
    const sibling = pullRequest({ number: 8, state: "closed" });
    const baseHistories = { 8: { createdAt: "2026-11-02T09:30:00Z", nodes: [{ createdAt: "2026-11-02T11:30:00Z", previousRefName: "evil", currentRefName: "main" }] } };
    const forged = forgedAt({});
    const { calls, evaluate } = harness({ ...open, runs: forged, otherPulls: [sibling], baseHistories });
    await evaluate("workflow_run", producerCompleted());
    assert.ok(bonkAbsent(calls)?.includes("#8"), "the record names the sibling");
    assert.equal(lastRecord(calls).pulls[0]?.would.decision, "person");
    // A run from before the sibling ever targeted another base still counts.
    const early = verdicts().map((entry) => ({ ...entry, run: { ...entry.run, created_at: "2026-11-02T09:00:00Z", run_started_at: "2026-11-02T09:00:00Z" } }));
    const before = harness({ ...open, runs: early, otherPulls: [sibling], baseHistories });
    await before.evaluate("workflow_run", producerCompleted());
    assert.equal(bonkScore(before.calls), 8);
    // A sibling whose base history cannot be read, or runs past one page, fences every run.
    const paged: NonNullable<HarnessOptions["baseHistories"]>[number] = { ...baseHistories[8], more: true };
    for (const history of [null, paged]) {
      const unread = harness({ ...open, runs: early, otherPulls: [sibling], baseHistories: { 8: history } });
      await unread.evaluate("workflow_run", producerCompleted());
      assert.equal(lastRecord(unread.calls).pulls[0]?.would.decision, "person", JSON.stringify(history));
    }
  });

  it("ignores runs from before the pull request's base last changed, even re-run since", async () => {
    // Retargeted to a branch with a replaced workflow, run (and re-run) there, then retargeted back.
    const before = forgedAt({ created_at: "2026-11-02T10:30:00Z", run_started_at: "2026-11-02T12:00:00Z" });
    const timeline = [{ event: "base_ref_changed", created_at: "2026-11-02T10:45:00Z" }];
    const after = verdicts().map((entry) => ({ ...entry, run: { ...entry.run, created_at: "2026-11-02T11:30:00Z", run_started_at: "2026-11-02T11:30:00Z" } }));
    const { calls, evaluate } = harness({ ...open, runs: [...after, ...before], timeline, lastPush: "2026-11-02T11:20:00Z" });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(bonkScore(calls), 8);
    const onlyBefore = harness({ ...open, runs: before, timeline, lastPush: "2026-11-02T11:20:00Z" });
    await onlyBefore.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(onlyBefore.calls).pulls[0]?.would.decision, "person");
  });

  it("trusts no producer run when the base changed after the head was pushed", async () => {
    // The head was pushed at 10:00 (the harness's last push); the base changed at 10:45, and a run
    // the change started may have used the old base's merge commit.
    const timeline = [{ event: "base_ref_changed", created_at: "2026-11-02T10:45:00Z" }];
    const late = verdicts().map((entry) => ({ ...entry, run: { ...entry.run, created_at: "2026-11-02T10:46:00Z", run_started_at: "2026-11-02T10:46:00Z" } }));
    const { calls, evaluate } = harness({ ...open, runs: late, timeline });
    await evaluate("workflow_run", producerCompleted());
    assert.ok(bonkAbsent(calls));
    const unknownPush = harness({ ...open, runs: late, timeline, lastPush: undefined });
    await unknownPush.evaluate("workflow_run", producerCompleted());
    assert.ok(bonkAbsent(unknownPush.calls));
    const fresh = verdicts().map((entry) => ({ ...entry, run: { ...entry.run, created_at: "2026-11-02T10:51:00Z", run_started_at: "2026-11-02T10:51:00Z" } }));
    const pushedAfter = harness({ ...open, runs: fresh, timeline, lastPush: "2026-11-02T10:50:00Z" });
    await pushedAfter.evaluate("workflow_run", producerCompleted());
    assert.equal(bonkScore(pushedAfter.calls), 8);
  });

  it("rejects either reviewer's verdict from a fork, or one made for another head or base", async () => {
    for (const name of VERDICT_NAMES) {
      for (const runs of [
        verdicts().map((entry) => entry.run.path === PRODUCERS[name].workflow
          ? { ...entry, run: { ...entry.run, head_repository: { full_name: "someone/cloudflare-os" } } }
          : entry),
        verdicts({ [name]: { head_sha: "c".repeat(40) } }),
        verdicts({ [name]: { base_sha: "c".repeat(40) } }),
      ]) {
        const { calls, evaluate } = harness({ ...open, runs });
        await evaluate("workflow_run", producerCompleted());
        const pull = lastRecord(calls).pulls[0];
        assert.ok(pull?.inputs[name] && "absent" in pull.inputs[name], name);
        assert.equal(pull.would.decision, "person");
      }
    }
  });
});

/** A Worker's generated `wrangler.jsonc`: two migrations, then these. */
function wranglerJsonc(appended: Json[] = []): string {
  return `// Generated from cloudflare.config.ts -- do not edit.\n${JSON.stringify({
    name: "gatekeeper-x",
    migrations: [{ tag: "v1", new_sqlite_classes: ["Notes"] }, { tag: "v2", deleted_classes: ["Old"] }, ...appended],
  }, null, 2)}\n`;
}

/** Decides the test pull request with these changed files and file contents. */
async function decideFiles(files: ChangedFile[], contents: Record<string, string>): Promise<PullDecision> {
  const { calls, evaluate } = harness({ files: { 7: files }, contents });
  await evaluate("workflow_run", producerCompleted());
  const pull = lastRecord(calls).pulls[0];
  assert.ok(pull);
  return pull;
}

/** A run of `path` on the test head that uploaded a preview smoke artifact named `name`. */
function smokeIn(path: string, name = "automerge-preview-smoke", holds = true): ProducerRun {
  return {
    run: run(path, { created_at: "2026-11-02T10:20:00Z", run_started_at: "2026-11-02T10:20:00Z" }),
    artifacts: { [name]: proofJson("preview-smoke", holds) },
  };
}

/** The preview smoke input the gate reads for the test pull request, given these producer runs. */
async function smokeInput(runs: ProducerRun[]): Promise<InputSummary | undefined> {
  const { calls, evaluate } = harness({ runs });
  await evaluate("workflow_run", producerCompleted());
  return lastRecord(calls).pulls[0]?.inputs["preview-smoke"];
}

describe("runRiskReview preview smoke", () => {
  it("counts the smoke from its producer's workflow on the head, and not from preview.yml, whatever its artifact's name", async () => {
    assert.deepEqual(await smokeInput([smokeIn(PRODUCERS["preview-smoke"].workflow)]), { status: "ok", holds: true });
    // Recorded: a real pull_request run of preview.yml, moved onto the test head.
    const preview: WorkflowRun = { ...JSON.parse(read("scripts/risk-review-fixtures/preview-run.json")), head_sha: HEAD };
    for (const name of ["automerge-preview-smoke", `automerge-preview-smoke-${HEAD}`]) {
      // Archived under the file name the gate reads, so only the binding can reject it.
      const archived = { [name]: "automerge-preview-smoke.json" };
      const input = await smokeInput([{ run: preview, artifacts: { [name]: proofJson("preview-smoke", true) }, archived }]);
      assert.ok(input && "absent" in input, `${name}: ${JSON.stringify(input)}`);
    }
  });

  it("does not let another workflow's artifact with the same name mask the real smoke", async () => {
    const forged = { ...smokeIn(".github/workflows/someone.yml", "automerge-preview-smoke", false) };
    forged.run = { ...forged.run, created_at: "2026-11-02T11:00:00Z", run_started_at: "2026-11-02T11:00:00Z" };
    assert.deepEqual(await smokeInput([smokeIn(PRODUCERS["preview-smoke"].workflow), forged]), { status: "ok", holds: true });
  });
});

function tree(path: string, sha: string): { path: string; mode: string; type: string; sha: string } {
  return { path, mode: "040000", type: "tree", sha };
}

/** The git trees from `commit` down to `.agents/skills/write-gatekeeper/SKILL.md`, which has `mode`. */
function skillTrees(commit: string, mode: string): Record<string, { path: string; mode: string; type: string; sha: string }[]> {
  return {
    [commit]: [tree(".agents", `${commit}-agents`), { path: "README.md", mode: "100644", type: "blob", sha: "r" }],
    [`${commit}-agents`]: [tree("skills", `${commit}-skills`)],
    [`${commit}-skills`]: [tree("write-gatekeeper", `${commit}-skill`)],
    [`${commit}-skill`]: [{ path: "SKILL.md", mode, type: "blob", sha: "s" }, tree("references", "refs")],
  };
}

describe("runRiskReview content rules", () => {
  const workspace = read("scripts/risk-review-fixtures/pnpm-workspace.yaml");

  it("allows pnpm-workspace.yaml when only catalog versions change, and keeps every other change with a person", async () => {
    const files = [file("pnpm-workspace.yaml")];
    const bump = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace, [`${HEAD}:pnpm-workspace.yaml`]: workspace.replace("zod: ^4.6.7", "zod: ^4.7.0") });
    assert.match(workspace, /zod: \^4\.6\.7/);
    assert.deepEqual(bump.never_auto, []);
    const age = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace, [`${HEAD}:pnpm-workspace.yaml`]: `${workspace}minimumReleaseAge: 1\n` });
    assert.notDeepEqual(age.never_auto, []);
    const unread = await decideFiles(files, { [`${BASE}:pnpm-workspace.yaml`]: workspace });
    assert.notDeepEqual(unread.never_auto, []);
  });

  it("scores a skill edit, and sends a symlink under .agents/skills/ to a person", async () => {
    const skill = ".agents/skills/write-gatekeeper/SKILL.md";
    const decideSkill = async (base: string, head: string) => {
      const { calls, evaluate } = harness({ files: { 7: [file(skill)] }, trees: { ...skillTrees(BASE, base), ...skillTrees(HEAD, head) } });
      await evaluate("workflow_run", producerCompleted());
      const pull = lastRecord(calls).pulls[0];
      assert.ok(pull);
      return pull;
    };
    assert.deepEqual((await decideSkill("100644", "100644")).never_auto, []);
    assert.deepEqual((await decideSkill("100644", "100755")).never_auto, []);
    // The trees API is the one that shows a symlink: the contents API reports its target as a file.
    assert.notDeepEqual((await decideSkill("100644", "120000")).never_auto, []);
    assert.notDeepEqual((await decideSkill("120000", "100644")).never_auto, []);
    assert.notDeepEqual((await decideSkill("100644", "160000")).never_auto, []);
    // Trees that cannot be read may hide one.
    const { calls, evaluate } = harness({ files: { 7: [file(skill)] } });
    await evaluate("workflow_run", producerCompleted());
    assert.notDeepEqual(lastRecord(calls).pulls[0]?.never_auto, []);
  });

  it("sends a wrangler.jsonc that may drop Durable Object data, or goes away, to a person", async () => {
    const config = "packages/gatekeeper-x/wrangler.jsonc";
    const before = wranglerJsonc();
    const files = [file(config)];
    const deletes = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: wranglerJsonc([{ tag: "v3", deleted_classes: ["Notes"] }]) });
    assertNames(deletes.never_auto, ["Notes"]);
    const reused = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: wranglerJsonc([{ tag: "v1", new_sqlite_classes: ["Inbox"] }]) });
    assertNames(reused.never_auto, ["v1"]);
    const rewritten = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: before.replace('"Old"', '"Old",\n        "Notes"') });
    assertNames(rewritten.never_auto, [config]);
    const adds = await decideFiles(files, { [`${BASE}:${config}`]: before, [`${HEAD}:${config}`]: `// v2 dropped Old.\n${wranglerJsonc([{ tag: "v3", new_sqlite_classes: ["Inbox"] }])}` });
    assert.deepEqual(adds.never_auto, []);
    const unread = await decideFiles(files, { [`${BASE}:${config}`]: before });
    assertNames(unread.never_auto, [config]);
    // The release deploys packages/<dir>/wrangler.jsonc by directory, so a config renamed to another
    // name or moved to another directory takes its Worker out of the release, like removing it.
    for (const moved of ["packages/gatekeeper-x/wrangler.old.jsonc", "packages/gatekeeper-x/legacy/wrangler.jsonc", "packages/gatekeeper-y/wrangler.jsonc"]) {
      const gone = await decideFiles([file(moved, { status: "renamed", previous_filename: config })], { [`${BASE}:${config}`]: before, [`${HEAD}:${moved}`]: before });
      assertNames(gone.never_auto, [config], moved);
    }
    const removed = await decideFiles([file(config, { status: "removed" })], { [`${BASE}:${config}`]: before });
    assertNames(removed.never_auto, [config]);
    // The cloudflare.config.ts source deploys only through the generated file, so it is not read.
    const source = await decideFiles([file("packages/gatekeeper-x/cloudflare.config.ts")], {});
    assert.deepEqual(source.never_auto, []);
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
    assert.equal(unread.band, "high");
    const override = await decideFiles(files, {
      [`${BASE}:packages/ui/package.json`]: before,
      [`${HEAD}:packages/ui/package.json`]: JSON.stringify({ dependencies: { zod: "catalog:" }, pnpm: { overrides: { zod: "npm:evil@1.0.0" } } }),
    });
    assert.equal(override.band, "high");
    assert.match(override.band_reasons.join("\n"), /packages\/ui\/package\.json: .*pnpm/);
    // A JSON fixture renamed into a package.json brings its install script in as new.
    const renamed = file("packages/new/package.json", { status: "renamed", previous_filename: "fixtures/x.json" });
    const carried = JSON.stringify({ name: "x", scripts: { postinstall: "node steal.js" } });
    const renamedIn = await decideFiles([renamed], { [`${BASE}:fixtures/x.json`]: carried, [`${HEAD}:packages/new/package.json`]: carried });
    assert.equal(renamedIn.band, "high");
    assert.match(renamedIn.band_reasons.join("\n"), /packages\/new\/package\.json: .*postinstall/);
  });
});

describe("runRiskReview maintainer holds", () => {
  // Other apps add check suites to a head long after its push, so only the first one dates it.
  it("dates the last push by the head's first check suite", async () => {
    const scored = { policy: { config: configJson("shadow", true, ["scored"]) }, runs: verdicts() };
    const comment = { user: { login: "deregtd", type: "User" }, created_at: "2026-11-02T10:10:00Z" };
    const after = harness({ ...scored, comments: { 7: [comment] } });
    await after.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(after.calls).pulls[0]?.holds.length, 1);
    const before = harness({ ...scored, comments: { 7: [{ ...comment, created_at: "2026-11-02T09:50:00Z" }] } });
    await before.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(before.calls).pulls[0]?.would.decision, "auto");
  });
});

describe("runRiskReview failure", () => {
  it("fails closed on a truncated tree, more check suites than one page, and more producer runs than one page", async () => {
    const skill = ".agents/skills/write-gatekeeper/SKILL.md";
    const truncated = harness({ files: { 7: [file(skill)] }, trees: { ...skillTrees(BASE, "100644"), ...skillTrees(HEAD, "100644") }, truncatedTrees: true });
    await truncated.evaluate("workflow_run", producerCompleted());
    assert.notDeepEqual(lastRecord(truncated.calls).pulls[0]?.never_auto, []);
    const scored = { policy: { config: configJson("shadow", true, ["scored"]) }, runs: verdicts() };
    const suites = harness({ ...scored, manySuites: true });
    await suites.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(suites.calls).pulls[0]?.holds.length, 1);
    assert.equal(lastRecord(suites.calls).pulls[0]?.would.decision, "person");
    const runs = harness({ ...scored, moreRuns: true });
    await runs.evaluate("workflow_run", producerCompleted());
    assert.ok(bonkAbsent(runs.calls));
    assert.equal(lastRecord(runs.calls).pulls[0]?.would.decision, "person");
  });

  // The job log and the check run are public. Octokit's error holds the response body, its headers
  // and the URL that answered, which for an artifact download is a signed, temporary one.
  it("fails its check run with what it was doing and the HTTP status, and publishes nothing the server sent", async () => {
    for (const { failing, doing } of [
      { failing: ["actions.downloadArtifact"], doing: "automerge-verdict-" },
      { failing: ["pulls.listFiles"], doing: "#7" },
      { failing: ["pulls.listReviews"], doing: "#7" },
    ] satisfies { failing: GitHubCall[]; doing: string }[]) {
      const { calls, evaluate } = harness({ failing, runs: verdicts() });
      const logged = await loggedRejection(evaluate("workflow_run", producerCompleted()));
      assert.deepEqual(calls.updates.map(({ conclusion }) => conclusion), ["failure"], doing);
      const [check] = calls.updates;
      for (const published of [logged, check.title, check.summary, ...calls.summaries]) assertNothingUpstream(published);
      for (const text of [logged, check.summary]) assert.ok(text.includes(doing) && text.includes("502"), text);
    }
  });

  it("rejects with nothing the server sent wherever else a request fails, and keeps a check run it had completed", async () => {
    const enforce = { policy: { config: configJson("enforce", true, ["scored"]) }, runs: verdicts() };
    for (const { options, completed } of [
      { options: { failing: ["pulls.get"] }, completed: [] },
      { options: { failing: ["checks.create"] }, completed: [] },
      { options: { failing: ["pulls.listReviews", "checks.update"] }, completed: [] },
      { options: { ...enforce, failing: ["pulls.createReview"] }, completed: ["success"] },
      { options: { reviewDecision: { 7: "APPROVED" }, summaryFails: true }, completed: ["success"] },
    ] satisfies { options: HarnessOptions; completed: string[] }[]) {
      const { calls, evaluate } = harness(options);
      assertNothingUpstream(await loggedRejection(evaluate("workflow_run", producerCompleted())));
      assert.deepEqual(calls.updates.map(({ conclusion }) => conclusion), completed, JSON.stringify(options));
    }
  });

  it("reports no HTTP status for a request that no server answered", async () => {
    const { calls, evaluate } = harness({ failing: ["pulls.listFiles"], failWith: unanswered });
    const logged = await loggedRejection(evaluate("workflow_run", producerCompleted()));
    for (const text of [logged, calls.updates[0].summary]) assert.doesNotMatch(text, /HTTP \d/);
  });
});

type RungOneProof = "proof-deps" | "proof-tests";

/** A run of the proof's workflow on the test head, with a holding proof made against `BASE`. */
function proofRun(name: RungOneProof, pullNumber = 7): ProducerRun {
  const pullRequests = [{ number: pullNumber, base: { ref: "main" } }];
  return { run: run(PRODUCERS[name].workflow, { pull_requests: pullRequests }), artifacts: { [`automerge-${name}`]: proofJson(name, true) } };
}

/** The two files proof-deps reads at its merge base, as they stand at `sha`. */
function at(sha: string, workspaceText: string, lockText: string): Record<string, string> {
  return { [`${sha}:pnpm-workspace.yaml`]: workspaceText, [`${sha}:pnpm-lock.yaml`]: lockText };
}

describe("runRiskReview proof freshness", () => {
  // The relay's run for the recorded merge group; #943's slot holds a Dependabot bump, and lands on
  // the group commit for #939.
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
  const workspace = read("scripts/risk-review-fixtures/pnpm-workspace.yaml");
  const bot = { login: "dependabot[bot]", type: "Bot" };
  const queued = [pullRequest({ number: 939, head: { sha: "9".repeat(40), ref: "topic-939" } }), pullRequest({ number: 943, user: bot })];
  const policyAt = (sha: string) => ({
    [`${sha}:${POLICY_FILES.maintainers}`]: MAINTAINERS,
    [`${sha}:${POLICY_FILES.config}`]: read(POLICY_FILES.config),
    [`${sha}:${POLICY_FILES.escapes}`]: NO_ESCAPES,
  });
  const queuedInput = async (name: RungOneProof, files: ChangedFile[], contents: Record<string, string>) => {
    const { calls, evaluate } = harness({
      pulls: queued,
      files: { 943: files },
      mergeQueue: fixture("merge_queue.json"),
      runs: [proofRun(name, 943)],
      contents: { ...policyAt(group.base_sha), ...contents },
    });
    await evaluate("workflow_run", relayed);
    return lastRecord(calls).pulls.find(({ number }) => number === 943)?.inputs[name];
  };

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
      assert.ok(changed && "absent" in changed, JSON.stringify(changed));
    }
  });

  it("treats proof-deps as absent when a file it read cannot be read at its base", async () => {
    const lock = "lockfileVersion: '9.0'\n";
    for (const { contents, counted } of [
      { contents: at(BASE, workspace, lock), counted: true },
      { contents: {}, counted: false },
      { contents: { [`${BASE}:pnpm-workspace.yaml`]: workspace }, counted: false },
      { contents: { [`${BASE}:pnpm-lock.yaml`]: lock }, counted: false },
    ]) {
      const { calls, evaluate } = harness({ files: { 7: [file("pnpm-lock.yaml")] }, runs: [proofRun("proof-deps")], contents });
      await evaluate("workflow_run", producerCompleted());
      const input = lastRecord(calls).pulls[0]?.inputs["proof-deps"];
      assert.equal(input !== undefined && !("absent" in input), counted, JSON.stringify(Object.keys(contents)));
    }
  });

  it("treats a proof whose commits GitHub cannot compare as absent, and still decides", async () => {
    const { calls, evaluate } = harness({ files: { 7: [file("pnpm-lock.yaml")] }, runs: [proofRun("proof-deps")], uncomparable: true, reviewDecision: { 7: "APPROVED" } });
    await evaluate("workflow_run", producerCompleted());
    const input = lastRecord(calls).pulls[0]?.inputs["proof-deps"];
    assert.ok(input && "absent" in input, JSON.stringify(input));
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
  });

  it("counts proof-tests only when made against the commit the pull request lands on", async () => {
    const { calls, evaluate } = harness({ runs: [proofRun("proof-tests")] });
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(lastRecord(calls).pulls[0]?.inputs["proof-tests"], { status: "ok", holds: true });
    const inQueue = await queuedInput("proof-tests", [file("docs/automerge.md")], {});
    assert.ok(inQueue && "absent" in inQueue, JSON.stringify(inQueue));
  });

  it("counts proof-tests only when the head contains its base", async () => {
    const { calls, evaluate } = harness({ runs: [proofRun("proof-tests")], mergeBases: { [`${BASE}...${HEAD}`]: "e".repeat(40) } });
    await evaluate("workflow_run", producerCompleted());
    const input = lastRecord(calls).pulls[0]?.inputs["proof-tests"];
    assert.ok(input && "absent" in input, JSON.stringify(input));
  });
});

describe("runRiskReview in enforce mode", () => {
  it("never approves a draft, and dismisses an approval standing on one", async () => {
    const config = configJson("enforce", true, ["scored"]);
    const draft = harness({ policy: { config }, runs: verdicts(), pulls: [pullRequest({ draft: true })] });
    await draft.evaluate("workflow_run", producerCompleted());
    assert.equal(lastRecord(draft.calls).pulls[0]?.would.decision, "auto");
    assert.deepEqual(draft.calls.approvals, []);
    assert.deepEqual(draft.calls.enqueued, []);
    const standing: Review = { id: 556, user: { login: APP.login, type: "Bot" }, state: "APPROVED", commit_id: HEAD };
    const dismissed = harness({ policy: { config }, runs: verdicts(), pulls: [pullRequest({ draft: true })], reviews: { 7: [standing] } });
    await dismissed.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(dismissed.calls.dismissals, [556]);
  });

  it("does not enqueue a pull request already in the merge queue", async () => {
    const { calls, evaluate } = harness({ policy: { config: configJson("enforce", true, ["scored"]) }, runs: verdicts(), queued: true });
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(calls.approvals, [HEAD]);
    assert.deepEqual(calls.enqueued, []);
  });

  it("keeps the published check when GitHub refuses the enqueue, and enqueues when a later run finds it admitted", async () => {
    const options: HarnessOptions = { policy: { config: configJson("enforce", true, ["scored"]) }, runs: verdicts(), enqueueRefused: true };
    const { calls, evaluate } = harness(options);
    const logged = await loggedRejection(evaluate("workflow_run", producerCompleted()));
    assertNothingUpstream(logged);
    assert.ok(logged.includes("#7"), logged);
    assert.deepEqual(calls.updates.map(({ conclusion }) => conclusion), ["success"]);
    assert.deepEqual(calls.enqueued, []);
    // The required checks finish, CI's completion wakes the gate, and GitHub now admits the pull request.
    options.enqueueRefused = undefined;
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(calls.updates.map(({ conclusion }) => conclusion), ["success", "success"]);
    assert.equal(calls.enqueued.length, 1);
  });

  it("approves the head and enqueues it for a pull request a rung takes, when App approvals count", async () => {
    const { calls, evaluate } = harness({ policy: { config: configJson("enforce", true, ["scored"]) }, runs: verdicts() });
    await evaluate("workflow_run", producerCompleted());
    assert.equal(calls.updates.at(-1)?.conclusion, "success");
    assert.deepEqual(calls.approvals, [HEAD]);
    assert.deepEqual(calls.enqueued, [{ id: "PR_kwDOSA1", head: HEAD }]);
  });

  it("enqueues only after a maintainer approves when App approvals do not count", async () => {
    const config = configJson("enforce", false, ["scored"]);
    const waiting = harness({ policy: { config }, runs: verdicts() });
    await waiting.evaluate("workflow_run", producerCompleted());
    assert.equal(waiting.calls.updates.at(-1)?.conclusion, "failure");
    assert.deepEqual(waiting.calls.enqueued, []);
    const approved = harness({ policy: { config }, runs: verdicts(), reviews: { 7: [review("deregtd", "APPROVED")] } });
    await approved.evaluate("workflow_run", producerCompleted());
    assert.deepEqual(approved.calls.approvals, []);
    assert.equal(approved.calls.enqueued.length, 1);
  });

  it("withdraws a standing App approval once the pull request needs a person", async () => {
    const appApproval: Review = { id: 555, user: { login: APP.login, type: "Bot" }, state: "APPROVED", commit_id: HEAD };
    const { calls, evaluate } = harness({ policy: { config: configJson("enforce", true) }, reviews: { 7: [appApproval] } });
    await evaluate("workflow_run", producerCompleted());
    assert.deepEqual(calls.dismissals, [555]);
    assert.deepEqual(calls.enqueued, []);
  });
});

describe("renderOutput", () => {
  it("keeps the decision JSON first and under the limit, however long the reasons", () => {
    const decision = decide(inputs({ producers: PERFECT }), SCORED, NOW);
    const long = { ...decision, would: { ...decision.would, reasons: Array.from({ length: 5_000 }, (_, index) => `reason ${index} `.repeat(4)) } };
    const record: DecisionRecord = { schema: 1, mode: "shadow", event: "merge_group", sha: HEAD, policy_sha: POLICY_SHA, conclusion: "failure", reason: "x", pulls: [long] };
    const { summary } = renderOutput(record);
    const json = /^```json\n(.*)\n```/s.exec(summary)?.[1] ?? "";
    assert.ok(json.length <= MAX_DECISION_CHARS);
    assert.ok(summary.length <= 65_535);
    assert.equal(JSON.parse(json).truncated, true);
  });
});

describe("parseWorkflow", () => {
  it("reads the same workflow whatever its comments, quoting and key order", () => {
    const plain = [
      "name: Gate",
      "on:",
      "  workflow_run:",
      "    workflows: [Relay, Proofs]",
      "permissions: {}",
      "jobs:",
      "  gate:",
      "    if: github.event_name != 'issue_comment'",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "        with:",
      "          ref: ${{ github.workflow_sha }}",
      "      - run: |",
      "          echo \"checks: write # not a comment\"",
      "",
    ].join("\n");
    const dressed = [
      "# permissions:",
      "#   checks: write",
      "'on':",
      "  workflow_run: # github.token",
      "    workflows:",
      "      - \"Relay\"",
      "      - 'Proofs'",
      "jobs:",
      "  gate:",
      "    steps:",
      "    - with: { ref: \"${{ github.workflow_sha }}\" }",
      "      uses: actions/checkout@v7 # v7.0.1",
      "",
      "    - run: |",
      "        echo \"checks: write # not a comment\"",
      "    if: >-",
      "      github.event_name != 'issue_comment'",
      "permissions: {}",
      "\"name\": Gate",
      "",
    ].join("\n");
    assert.deepEqual(parseWorkflow(dressed), parseWorkflow(plain));
    assert.deepEqual(dig(parseWorkflow(plain), "on", "workflow_run", "workflows"), ["Relay", "Proofs"]);
    assert.deepEqual(stepsOf(parseWorkflow(plain)).map((step) => Object.keys(step).toSorted()), [["uses", "with"], ["run"]]);
  });

  it("refuses a file it cannot read, rather than passing it", () => {
    for (const text of [
      "on:\n  workflow_run:\n    workflows: [Relay,\n      Proofs]\n",
      "jobs:\n  gate:\n      steps: []\n    name: x\n",
      // Anchors, aliases and tags give a value this would read as plain text.
      "jobs:\n  a:\n    permissions: &grant { checks: write }\n",
      "jobs:\n  a:\n    permissions: &grant\n      checks: write\n",
      "jobs:\n  a:\n    permissions: *grant\n",
      "jobs:\n  a:\n    <<: *base\n",
      "jobs:\n  a:\n    permissions: !!map { checks: write }\n",
      "permissions: {}\npermissions: write-all\n",
      "permissions: { checks: read, checks: write }\n",
    ]) {
      assert.throws(() => parseWorkflow(text), JSON.stringify(text));
    }
  });
});

/** The steps that run `action`, at any version. */
function stepsUsing(workflow: Json, action: string): JsonObject[] {
  return stepsOf(workflow).filter(({ uses }) => typeof uses === "string" && uses.startsWith(`${action}@`));
}

/** The events that start a workflow, however `on` is written. */
function triggersOf(workflow: Json): string[] {
  const on = dig(workflow, "on");
  return typeof on === "string" || Array.isArray(on) ? texts(on) : Object.keys(maybeObject(on) ?? {});
}

/**
 * Whether a job's token may create check runs: the job, or failing that the workflow, grants
 * `checks: write` or `write-all`, or neither declares permissions, which leaves the repository's
 * default.
 */
function mayWriteChecks(workflow: Json): boolean {
  return jobsOf(workflow).some((job) => {
    const permissions = dig(job, "permissions") ?? dig(workflow, "permissions");
    return permissions === undefined || permissions === "write-all" || dig(permissions, "checks") === "write";
  });
}

/** An expression without its spacing, which GitHub ignores. */
function expression(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value.replace(/\s+/g, "") : undefined;
}

/** The values in a workflow that read a secret, and what its jobs pass on as secrets to a called workflow. */
function secretsIn(workflow: Json): Json[] {
  return [...texts(workflow).filter((text) => /\bsecrets\b/i.test(text)), ...jobsOf(workflow).flatMap((job) => dig(job, "secrets") ?? [])];
}

const RELAY = ".github/workflows/risk-review-trigger.yml";
const gate = parseWorkflow(read(".github/workflows/risk-review.yml"));
const relay = parseWorkflow(read(RELAY));

describe("risk-review workflows", () => {
  it("runs only from main's definition: workflow_run and issue_comment are its only triggers", () => {
    assert.deepEqual(triggersOf(gate).toSorted(), ["issue_comment", "workflow_run"]);
  });

  it("wakes on the relay, every producer workflow and CI, and on nothing else", () => {
    // CI runs the required checks: its completion is when the gate retries an enqueue GitHub
    // refused while they ran.
    const paths = [RELAY, ".github/workflows/ci.yml", ...Object.values(PRODUCERS).map(({ workflow }) => workflow)];
    const names = paths.map((path) => {
      const name = dig(parseWorkflow(read(path)), "name");
      return typeof name === "string" ? name : path;
    });
    assert.deepEqual(texts(dig(gate, "on", "workflow_run", "workflows")).toSorted(), [...new Set(names)].toSorted());
  });

  it("posts only as the App, from the environment that holds its key, with no job-token fallback", () => {
    assert.deepEqual(jobsOf(gate).map((job) => dig(job, "environment")), ["risk-review"]);
    const [minted, ...others] = stepsUsing(gate, "actions/create-github-app-token");
    assert.ok(typeof minted?.id === "string" && others.length === 0, "one step mints the App's token");
    // Without these two the App can neither post the check run nor enqueue.
    assert.deepEqual([dig(minted, "with", "permission-checks"), dig(minted, "with", "permission-merge-queues")], ["write", "write"]);
    assert.deepEqual(stepsUsing(gate, "actions/github-script").map((step) => expression(dig(step, "with", "github-token"))),
      [`\${{steps.${minted.id}.outputs.token}}`]);
    assert.deepEqual(texts(gate).filter((text) => /\bgithub\.token\b|\bsecrets\.GITHUB_TOKEN\b/.test(text)), []);
  });

  it("checks the script out at the commit of its own definition, never a pull request's", () => {
    assert.deepEqual(stepsUsing(gate, "actions/checkout").map((step) => [expression(dig(step, "with", "ref")), dig(step, "with", "repository")]),
      [["${{github.workflow_sha}}", undefined]]);
  });

  it("relays pull request, review and merge group events from a workflow with no permissions or secrets", () => {
    assert.deepEqual(dig(relay, "permissions"), {});
    assert.deepEqual(jobsOf(relay).map((job) => dig(job, "permissions")).filter((permissions) => permissions !== undefined), []);
    assert.deepEqual(secretsIn(relay), []);
    for (const event of ["pull_request", "pull_request_review", "pull_request_review_comment", "merge_group"]) {
      assert.ok(triggersOf(relay).includes(event), event);
    }
  });

  it("gives no producer workflow a token that can create check runs, so only the gate publishes", () => {
    // Bonk's workflow posts its own `bonk` check; the gate reads only Bonk's artifact, never a check
    // run, so that check cannot stand in for the gate's.
    const producers = Object.values(PRODUCERS).map(({ workflow }) => workflow).filter((path) => path !== PRODUCERS.bonk.workflow);
    for (const path of new Set([...producers, RELAY])) {
      assert.equal(mayWriteChecks(parseWorkflow(read(path))), false, path);
    }
    assert.equal(mayWriteChecks(parseWorkflow("jobs:\n  a:\n    permissions:\n      checks: write\n")), true);
    assert.equal(mayWriteChecks(parseWorkflow("permissions: write-all\njobs:\n  a:\n    steps: []\n")), true);
    assert.equal(mayWriteChecks(parseWorkflow("jobs:\n  a:\n    steps: []\n")), true);
    // A job id that is also the name of an object's prototype is a job like any other.
    assert.equal(mayWriteChecks(parseWorkflow("permissions: {}\njobs:\n  __proto__:\n    permissions:\n      checks: write\n")), true);
  });

  it("gives the workflow that builds and runs the head no secret, environment or write permission", () => {
    const paths = (["proof-tests", "preview-smoke"] as const).map((name) => PRODUCERS[name].workflow);
    for (const path of new Set(paths)) {
      const workflow = parseWorkflow(read(path));
      assert.deepEqual(secretsIn(workflow), [], path);
      for (const job of jobsOf(workflow)) {
        const permissions = maybeObject(dig(job, "permissions") ?? dig(workflow, "permissions"));
        assert.ok(permissions && Object.values(permissions).every((grant) => grant === "read" || grant === "none"), `${path}: ${JSON.stringify(permissions)}`);
        assert.equal(dig(job, "environment"), undefined, path);
      }
    }
  });
});
