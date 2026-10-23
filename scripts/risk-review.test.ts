import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  askClef,
  authorizeRiskReview,
  buildClefState,
  classifyChangeset,
  evaluateGate,
  pathFloor,
  runRiskReview,
  tallyReviews,
  type ActionsContext,
  type ActionsCore,
  type ChangedFile,
  type ClefVerdict,
  type GitHubClient,
  type Review,
  type RiskPullRequest,
} from "./risk-review.ts";

const workflow = readFileSync(new URL("../.github/workflows/risk-review.yml", import.meta.url), "utf8");
const triggerWorkflow = readFileSync(
  new URL("../.github/workflows/risk-review-trigger.yml", import.meta.url),
  "utf8",
);

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const lowVerdict: ClefVerdict = { probabilities: { low: 0.9, medium: 0.08, high: 0.02 }, steering: 0 };

function verdict(low: number, medium: number, high: number, steering = 0): ClefVerdict {
  return { probabilities: { low, medium, high }, steering };
}

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-a\n+b",
    ...overrides,
  };
}

let reviewIds = 0;

function review(login: string, state: string, commit = HEAD, type = "User"): Review {
  return { id: ++reviewIds, user: { login, type }, state, commit_id: commit };
}

const APP = "risk-review[bot]";

describe("pathFloor", () => {
  it("puts all of workshop-backend, the gate itself and the security chokepoints at high", () => {
    for (const path of [
      "packages/workshop-backend/src/overseer.ts",
      "packages/workshop-backend/__tests__/user.test.ts",
      "packages/workshop-backend/README.md",
      ".github/workflows/risk-review.yml",
      "scripts/risk-review.ts",
      "scripts/release/manifest-lib.ts",
      "packages/workshop-shared/src/api.ts",
      "packages/mcp-shared/src/tools.ts",
      "packages/workshop-frontend/src/routes/connect.handoff.tsx",
    ]) {
      assert.equal(pathFloor(path), "high", path);
    }
  });

  it("puts shared code, gatekeepers, dependencies and worker config at medium", () => {
    for (const path of [
      "packages/workshop-shared/src/blueprints.ts",
      "packages/gatekeeper-github/src/index.ts",
      "packages/router/src/index.ts",
      "packages/workshop-frontend/package.json",
      "pnpm-lock.yaml",
      "packages/router/wrangler.jsonc",
      "scripts/worker-config.ts",
      "scripts/preview/preview.ts",
      "vite.config.ts",
      "packages/workshop-frontend/vite.config.ts",
      "packages/bundled-blueprints/blueprints/notes/blueprint.json",
      "packages/configurator-ui/build/frame.ts",
    ]) {
      assert.equal(pathFloor(path), "medium", path);
    }
  });

  it("puts the instructions the AI reviewer follows at medium", () => {
    for (const path of [
      "REVIEW.md",
      "AGENTS.md",
      "packages/ui/AGENTS.md",
      ".agents/skills/write-gatekeeper/SKILL.md",
    ]) {
      assert.equal(pathFloor(path), "medium", path);
    }
  });

  it("matches across dot-segments, which matchesGlob alone skips", () => {
    assert.equal(pathFloor("packages/workshop-backend/src/.internal/x.ts"), "high");
    assert.equal(pathFloor("packages/workshop-backend/.dev.vars"), "high");
    assert.equal(pathFloor("packages/gatekeeper-x/src/.hidden.ts"), "medium");
    assert.equal(pathFloor("packages/x/.config/package.json"), "medium");
    assert.equal(pathFloor("packages/workshop-backend"), "low");
    assert.equal(pathFloor("packages/workshop-backend-old/src/x.ts"), "low");
  });

  it("leaves docs, other tests and the frontend to the classifier", () => {
    for (const path of [
      "docs/testing.md",
      "README.md",
      "packages/gatekeeper-github/__tests__/index.test.ts",
      "packages/workshop-frontend/src/App.tsx",
      "packages/workshop-frontend/src/routes/connect.tsx",
    ]) {
      assert.equal(pathFloor(path), "low", path);
    }
  });
});

describe("buildClefState", () => {
  it("shows where a renamed file came from", () => {
    const { state } = buildClefState([
      file("docs/preview.yml", { status: "renamed", previous_filename: ".github/workflows/preview.yml" }),
    ]);
    assert.match(state, /^--- \.github\/workflows\/preview\.yml → docs\/preview\.yml \(renamed/);
  });

  it("puts higher-floor files first", () => {
    const { state, complete } = buildClefState([
      file("docs/a.md"),
      file("packages/router/src/index.ts"),
      file("packages/workshop-shared/src/api.ts"),
    ]);
    assert.ok(state.indexOf("api.ts") < state.indexOf("router"));
    assert.ok(state.indexOf("router") < state.indexOf("docs/a.md"));
    assert.equal(complete, true);
  });

  it("treats a text diff the API did not inline as unseen, but not a binary file", () => {
    assert.equal(buildClefState([file("icon.png", { patch: undefined, changes: 0 })]).complete, true);
    assert.equal(buildClefState([file("big.ts", { patch: undefined, changes: 9000 })]).complete, false);
  });

  it("measures the limit in bytes, which bound tokens where characters do not", () => {
    // 100,000 digits are 100,000 tokens to a tokenizer that splits digits.
    assert.equal(buildClefState([file("docs/digits.md", { patch: "1".repeat(100_000) })]).complete, false);
    // 20,000 characters, but 80,000 UTF-8 bytes.
    assert.equal(buildClefState([file("docs/emoji.md", { patch: "😀".repeat(20_000) })]).complete, false);
    assert.equal(buildClefState([file("docs/small.md", { patch: "x".repeat(60_000) })]).complete, true);
  });

  it("stops at the size limit and reports the rest unseen", () => {
    const huge = file("docs/huge.md", { patch: "x".repeat(70_000) });
    const { state, complete } = buildClefState([file("docs/a.md"), huge]);
    assert.ok(!state.includes("huge.md"));
    assert.equal(complete, false);
  });
});

function classify(overrides: Partial<Parameters<typeof classifyChangeset>[0]>) {
  return classifyChangeset({ files: [file("docs/a.md")], complete: true, clef: lowVerdict, ...overrides });
}

describe("classifyChangeset", () => {
  it("rates a confidently low change low", () => {
    assert.deepEqual(classify({}), { tier: "low", reasons: [] });
  });

  it("lets Clef raise the tier but never lower a path floor", () => {
    assert.equal(classify({ files: [file("packages/workshop-backend/src/user.ts")] }).tier, "high");
    assert.equal(classify({ files: [file("packages/gatekeeper-x/src/index.ts")] }).tier, "medium");
    assert.equal(
      classify({ files: [file("packages/gatekeeper-x/src/index.ts")], clef: verdict(0.1, 0.2, 0.7) }).tier,
      "high",
    );
  });

  it("escalates when Clef is unsure", () => {
    assert.equal(classify({ clef: verdict(0.65, 0.25, 0.1) }).tier, "medium");
    assert.equal(classify({ clef: verdict(0.5, 0.2, 0.3) }).tier, "high");
    assert.equal(classify({ clef: verdict(0.71, 0.2, 0.09) }).tier, "low");
  });

  it("needs a human when the classifier did not see the whole change", () => {
    assert.equal(classify({ complete: false }).tier, "medium");
    // Unlisted files' paths went unchecked, so they could be anything.
    assert.equal(classify({ listed: false }).tier, "high");
    assert.equal(classify({ clef: { error: "HTTP 500" } }).tier, "medium");
  });

  it("rates a diff that addresses the classifier high", () => {
    assert.equal(classify({ clef: verdict(1, 0, 0, 0.8) }).tier, "high");
  });

  it("rates a rename out of a high-risk path high", () => {
    const rename = file("docs/preview.yml", {
      status: "renamed",
      previous_filename: ".github/workflows/preview.yml",
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: undefined,
    });
    const { tier, reasons } = classify({ files: [rename], complete: buildClefState([rename]).complete });
    assert.equal(tier, "high");
    assert.match(reasons[0], /^high: .*\.github\/workflows\/preview\.yml → docs\/preview\.yml/);
  });

  it("names the files behind a floor", () => {
    const { reasons } = classify({ files: [file("packages/workshop-shared/src/api.ts")] });
    assert.match(reasons[0], /^high: .*packages\/workshop-shared\/src\/api\.ts/);
  });
});

describe("tallyReviews", () => {
  const maintainers = new Set(["alice", "bob", "carol", "author"]);
  const tally = (reviews: Review[]) => tallyReviews(reviews, { headSha: HEAD, author: "author", maintainers });

  it("counts only approvals of the head commit", () => {
    assert.deepEqual(tally([review("alice", "APPROVED"), review("bob", "APPROVED", OLD)]).approvers, ["alice"]);
  });

  it("ignores bots, the author, and reviewers without write access", () => {
    const { approvers } = tally([
      review("bonk[bot]", "APPROVED", HEAD, "Bot"),
      review("author", "APPROVED"),
      review("outsider", "APPROVED"),
    ]);
    assert.deepEqual(approvers, []);
  });

  it("uses each reviewer's latest decisive review", () => {
    assert.deepEqual(tally([review("alice", "CHANGES_REQUESTED", OLD), review("alice", "APPROVED")]), {
      approvers: ["alice"],
      blockers: [],
    });
    assert.deepEqual(
      tally([review("alice", "APPROVED"), review("alice", "COMMENTED"), review("alice", "DISMISSED")]),
      { approvers: [], blockers: [] },
    );
    assert.deepEqual(tally([review("bob", "CHANGES_REQUESTED", OLD)]).blockers, ["bob"]);
  });
});

function gate(overrides: Partial<Parameters<typeof evaluateGate>[0]>) {
  return evaluateGate({ tier: "low", approvers: [], blockers: [], directors: undefined, headSha: HEAD, ...overrides });
}

describe("evaluateGate", () => {
  it("passes low risk with no approvals", () => {
    assert.deepEqual(gate({}), { state: "success", description: "low risk: approved on automated review" });
  });

  it("requires one approval for medium and for high risk", () => {
    assert.deepEqual(gate({ tier: "medium" }), {
      state: "failure",
      description: "medium risk: needs a maintainer's approval of aaaaaaa",
    });
    assert.equal(gate({ tier: "medium", approvers: ["alice"] }).state, "success");
    assert.deepEqual(gate({ tier: "high" }), {
      state: "failure",
      description: "high risk: needs a maintainer's approval of aaaaaaa",
    });
    assert.deepEqual(gate({ tier: "high", approvers: ["alice"] }), {
      state: "success",
      description: "high risk: approved by @alice",
    });
  });

  it("blocks on an outstanding change request", () => {
    assert.equal(gate({ approvers: ["alice"], blockers: ["bob"] }).description, "Changes requested by @bob");
  });

  it("requires the director of an agent's pull request to approve it, even at low risk", () => {
    assert.match(gate({ approvers: ["alice"], directors: [] }).description, /Assign/);
    assert.equal(gate({ directors: ["dave"] }).state, "failure");
    assert.equal(gate({ approvers: ["alice"], directors: ["dave"] }).state, "failure");
    assert.equal(gate({ approvers: ["dave"], directors: ["dave"] }).state, "success");
  });
});

describe("askClef", () => {
  const config = { accountId: "acct", apiToken: "token", gatewayId: "gw" };

  it("reads the verdict out of the REST API's result wrapper", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const answer = await askClef("diff", config, async (url, init) => {
      request = { url: String(url), init };
      return Response.json({
        result: {
          answers: {
            tier: { type: "choice", choice: "low", probabilities: { low: 0.9, medium: 0.1, high: 0 } },
            steering: { type: "noul", noul: 0.01 },
          },
        },
      });
    });

    assert.deepEqual(answer, { probabilities: { low: 0.9, medium: 0.1, high: 0 }, steering: 0.01 });
    assert.ok(request);
    assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef");
    const headers = request.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["cf-aig-gateway-id"], "gw");
    assert.equal(JSON.parse(String(request.init?.body)).model, "clef");
  });

  it("turns every failure into an error verdict", async () => {
    assert.deepEqual(await askClef("diff", {}), { error: "Workers AI credentials are not configured" });
    assert.deepEqual(await askClef("diff", config, async () => new Response("", { status: 403 })), {
      error: "HTTP 403",
    });
    for (const answers of [
      {},
      { tier: { probabilities: {} }, steering: { noul: 0 } },
      { tier: { probabilities: [0.9, 0.1, 0] }, steering: { noul: 0 } },
      { tier: { probabilities: { low: 0.9, medium: 0.1 } }, steering: { noul: 0 } },
      { tier: { probabilities: { low: 0.9, medium: "0.1", high: 0 } }, steering: { noul: 0 } },
      { tier: { probabilities: { low: 0.9, medium: 0.1, high: 1.5 } }, steering: { noul: 0 } },
      { tier: { probabilities: { low: 0.9, medium: 0.1, high: 0 } }, steering: { noul: Number.NaN } },
    ]) {
      assert.deepEqual(
        await askClef("diff", config, async () => Response.json({ result: { answers } })),
        { error: "unexpected response shape" },
        JSON.stringify(answers),
      );
    }
    assert.deepEqual(
      await askClef("diff", config, async () => {
        throw new TypeError("fetch failed");
      }),
      { error: "TypeError" },
    );
  });
});

async function clefAnswers() {
  return Response.json({
    result: {
      answers: { tier: { probabilities: { low: 0.95, medium: 0.04, high: 0.01 } }, steering: { noul: 0 } },
    },
  });
}

interface RecordedStatus {
  sha: string;
  state: string;
  description: string;
  context: string;
  target_url: string;
}

function harness({
  pullRequest = {},
  files = [file("docs/a.md")],
  reviews = [],
  permissions = {},
  payload = { pull_request: { number: 7 } },
}: {
  pullRequest?: Partial<RiskPullRequest> | null;
  files?: ChangedFile[];
  reviews?: Review[];
  permissions?: Record<string, string>;
  payload?: Omit<ActionsContext["payload"], "repository">;
}) {
  const statuses: RecordedStatus[] = [];
  const reviewCalls: { call: string; commit_id?: string; review_id?: number; body?: string }[] = [];
  const listed: unknown[] = [];
  const outputs: Record<string, string> = {};
  const routes = { list: Symbol("list"), listFiles: Symbol("listFiles"), listReviews: Symbol("listReviews") };
  const pull: RiskPullRequest = {
    number: 7,
    state: pullRequest === null ? "closed" : "open",
    user: { login: "author", type: "User" },
    assignees: [],
    head: { sha: HEAD },
    base: { ref: "main" },
    changed_files: files.length,
    ...pullRequest,
  };
  const github: GitHubClient = {
    rest: {
      pulls: {
        get: async () => ({ data: pull }),
        createReview: async ({ commit_id, event, body }) => {
          reviewCalls.push({ call: event, commit_id, body });
        },
        dismissReview: async ({ review_id }) => {
          reviewCalls.push({ call: "DISMISS", review_id });
        },
        ...routes,
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: permissions[username] ?? "read" },
        }),
        createCommitStatus: async (status) => {
          statuses.push(status);
        },
        // The latest status per context, as GitHub combines them.
        getCombinedStatusForRef: async ({ ref }) => ({
          data: { statuses: statuses.filter(({ sha }) => sha === ref).slice(-1) },
        }),
      },
    },
    paginate: async <T>(route: unknown, args: unknown) => {
      if (route === routes.list) listed.push(args);
      const results = { [routes.list]: [pull], [routes.listFiles]: files, [routes.listReviews]: reviews };
      return (results[route as symbol] ?? []) as T[];
    },
  };
  const summary: ActionsCore["summary"] = {
    addHeading: () => summary,
    addList: () => summary,
    write: async () => undefined,
  };
  const core: ActionsCore = {
    notice: () => {},
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    summary,
  };
  const contextFor = (runId: number): ActionsContext => ({
    repo: { owner: "cloudflare", repo: "cloudflare-os" },
    serverUrl: "https://github.com",
    runId,
    payload: { repository: { default_branch: "main" }, ...payload },
  });
  const authorize = (runId = 1) =>
    authorizeRiskReview({ github, context: contextFor(runId), core, approver: APP });
  const evaluate = (runId = 1) =>
    runRiskReview({
      github,
      context: contextFor(runId),
      core,
      clef: { accountId: "a", apiToken: "t" },
      approver: APP,
      fetchImpl: clefAnswers,
    });
  return {
    statuses,
    reviewCalls,
    listed,
    outputs,
    authorize,
    evaluate,
    /** One workflow run: `authorize`, then the classifier. */
    run: async (runId = 1) => {
      await authorize(runId);
      await evaluate(runId);
    },
  };
}

describe("authorizeRiskReview", () => {
  for (const permission of ["admin", "maintain", "write"]) {
    it(`runs straight away for an author with ${permission} permission`, async () => {
      const { outputs, authorize } = harness({ permissions: { author: permission } });
      await authorize();
      assert.deepEqual(outputs, { author: "maintainer" });
    });
  }

  it("holds anyone else's pull request for approval, bots included", async () => {
    const outsider = harness({ permissions: { author: "triage" } });
    await outsider.authorize();
    assert.deepEqual(outsider.outputs, { author: "other" });
    assert.deepEqual(outsider.statuses.map(({ sha, state, description }) => ({ sha, state, description })), [
      { sha: HEAD, state: "pending", description: "Waiting for a maintainer to approve the run" },
    ]);

    const bot = harness({ pullRequest: { user: { login: "bonk[bot]", type: "Bot" } } });
    await bot.authorize();
    assert.deepEqual(bot.outputs, { author: "other" });
  });

  it("routes nowhere when the pull request is closed", async () => {
    const { outputs, statuses, authorize } = harness({ pullRequest: null });
    await authorize();
    assert.deepEqual(outputs, { author: "" });
    assert.deepEqual(statuses, []);
  });

  it("leaves a pull request into another branch alone, since the status is the head's", async () => {
    const { outputs, statuses, authorize } = harness({ pullRequest: { base: { ref: "feature" } } });
    await authorize();
    assert.deepEqual(outputs, { author: "" });
    assert.deepEqual(statuses, []);
  });

  it("ignores the app's own reviews, which cannot change the verdict", async () => {
    const { outputs, statuses, authorize } = harness({
      payload: {
        workflow_run: {
          actor: { login: APP },
          head_branch: "topic",
          head_repository: { owner: { login: "cloudflare" } },
        },
      },
    });
    await authorize();
    assert.deepEqual(outputs, { author: "" });
    assert.deepEqual(statuses, []);
  });

  it("looks a reviewed pull request up by head and default branch", async () => {
    const { outputs, listed, authorize } = harness({
      payload: {
        workflow_run: {
          actor: { login: "alice" },
          head_branch: "topic",
          head_repository: { owner: { login: "someone" } },
        },
      },
      permissions: { author: "write" },
    });
    await authorize();
    assert.deepEqual(outputs, { author: "maintainer" });
    assert.deepEqual(listed, [{
      owner: "cloudflare",
      repo: "cloudflare-os",
      state: "open",
      head: "someone:topic",
      base: "main",
      per_page: 100,
    }]);
  });
});

describe("runRiskReview", () => {
  it("passes a low-risk change with no human review", async () => {
    const { statuses, run } = harness({});
    await run();
    assert.deepEqual(statuses.map(({ sha, state }) => ({ sha, state })), [
      { sha: HEAD, state: "pending" },
      { sha: HEAD, state: "success" },
    ]);
  });

  it("holds a workshop-backend change for a maintainer's approval of the head commit", async () => {
    const { statuses, run } = harness({
      files: [file("packages/workshop-backend/src/overseer.ts")],
      reviews: [review("alice", "APPROVED", OLD)],
      permissions: { alice: "maintain" },
    });
    await run();
    assert.equal(statuses.at(-1)?.description, "high risk: needs a maintainer's approval of aaaaaaa");
  });

  it("rates a pull request high when GitHub did not list all its files", async () => {
    const { statuses, reviewCalls, run } = harness({ pullRequest: { changed_files: 3001 } });
    await run();
    assert.equal(statuses.at(-1)?.description, "high risk: needs a maintainer's approval of aaaaaaa");
    assert.deepEqual(reviewCalls, []);
  });

  it("asks an agent's pull request for its director's approval", async () => {
    const { statuses, run } = harness({
      pullRequest: {
        user: { login: "bonk[bot]", type: "Bot" },
        assignees: [{ login: "dave", type: "User" }],
      },
      reviews: [review("alice", "APPROVED")],
      permissions: { alice: "write", dave: "write" },
    });
    await run();
    assert.equal(statuses.at(-1)?.state, "failure");
    assert.match(statuses.at(-1)?.description ?? "", /@dave/);
  });

  it("approves a low-risk head as the app, once", async () => {
    const first = harness({});
    await first.run();
    assert.deepEqual(first.reviewCalls, [
      { call: "APPROVE", commit_id: HEAD, body: "low risk: approved on automated review" },
    ]);

    const again = harness({ reviews: [review(APP, "APPROVED", HEAD, "Bot")] });
    await again.run();
    assert.deepEqual(again.reviewCalls, []);

    const pushed = harness({ reviews: [review(APP, "APPROVED", OLD, "Bot")] });
    await pushed.run();
    assert.deepEqual(pushed.reviewCalls.map(({ call, commit_id }) => ({ call, commit_id })), [
      { call: "APPROVE", commit_id: HEAD },
    ]);
  });

  it("withdraws the app's approval once a change is no longer low risk or fails the gate", async () => {
    const appApproval = review(APP, "APPROVED", HEAD, "Bot");
    const rated = harness({ files: [file("packages/router/src/index.ts")], reviews: [appApproval] });
    await rated.run();
    assert.deepEqual(rated.reviewCalls, [{ call: "DISMISS", review_id: appApproval.id }]);

    const blocked = harness({
      reviews: [appApproval, review("bob", "CHANGES_REQUESTED")],
      permissions: { bob: "write" },
    });
    await blocked.run();
    assert.deepEqual(blocked.reviewCalls, [{ call: "DISMISS", review_id: appApproval.id }]);
  });

  it("does not count the app's own approval as a maintainer's", async () => {
    const { statuses, reviewCalls, run } = harness({
      files: [file("packages/router/src/index.ts")],
      reviews: [review(APP, "APPROVED", HEAD, "Bot")],
      permissions: { [APP]: "write" },
    });
    await run();
    assert.equal(statuses.at(-1)?.state, "failure");
    assert.equal(reviewCalls[0].call, "DISMISS");
  });

  it("does not restore a verdict a later run withdrew while this one read the reviews", async () => {
    const { statuses, reviewCalls, authorize, evaluate } = harness({ reviews: [review("alice", "APPROVED")] });
    await authorize(1);
    await authorize(2);
    await evaluate(1);
    assert.deepEqual(reviewCalls, []);
    assert.deepEqual(statuses.map(({ state, target_url }) => ({ state, run: target_url.split("/").at(-1) })), [
      { state: "pending", run: "1" },
      { state: "pending", run: "2" },
    ]);
  });
});

describe("risk-review workflows", () => {
  it("runs the classifier from the base branch only", () => {
    assert.doesNotMatch(workflow, /^\s+pull_request:/m);
    assert.doesNotMatch(workflow, /^\s+pull_request_review:/m);
    assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(ref|repo)/);
  });

  it("classifies only pull requests into main", () => {
    assert.match(workflow, /pull_request_target:\n(?:\s+#.*\n)*\s+branches: \[main\]/);
  });

  it("serializes authorize and the classifiers per head commit", () => {
    assert.match(workflow, /\n {2}authorize:\n[\s\S]*?concurrency: &serialize\n/);
    assert.equal(workflow.match(/concurrency: \*serialize/g)?.length, 2);
  });

  it("reclassifies when the base changes, but not on other edits", () => {
    assert.match(workflow, /types: \[[^\]]*\bedited\b/);
    assert.match(workflow, /github\.event\.action != 'edited' \|\| github\.event\.changes\.base/);
  });

  it("holds every author but a maintainer behind the approval environment", () => {
    assert.match(workflow, /if: needs\.authorize\.outputs\.author == 'maintainer'/);
    assert.match(
      workflow,
      /if: needs\.authorize\.outputs\.author == 'other'\n(?:.*\n)*?\s+environment: risk-review-external/,
    );
    // Only the two classify jobs may see the Clef credentials.
    const authorizeJob = /\n {2}authorize:\n([\s\S]*?)\n {2}\w+:\n/.exec(workflow)?.[1];
    assert.ok(authorizeJob);
    assert.doesNotMatch(authorizeJob, /CF_AI_GATEWAY/);
  });

  it("lets authorize withdraw the status without the Clef credentials", () => {
    assert.match(workflow, /\n {2}authorize:\n[\s\S]*?statuses: write[\s\S]*?\n {2}maintainer:/);
  });

  it("posts every status as the app, from environments that hold its key", () => {
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n")).split(/\n {2}(?=\w+:\n)/).slice(1);
    assert.deepEqual(jobs.map((job) => /environment: ([\w-]+)/.exec(job)?.[1]), [
      "risk-review",
      "risk-review",
      "risk-review-external",
    ]);
    assert.equal(workflow.match(/github-token: \$\{\{ steps\.app\.outputs\.token \|\| github\.token \}\}/g)?.length, 2);
    assert.match(workflow, /- \*app-token\n/);
    // authorize needs the app's login too, to ignore the app's own reviews.
    assert.equal(workflow.match(/approver: process\.env\.RISK_REVIEW_APPROVER/g)?.length, 2);
  });

  it("relays reviews from a workflow with no permissions", () => {
    const name = /^name: (.+)$/m.exec(triggerWorkflow)?.[1];
    assert.ok(name);
    assert.match(workflow, new RegExp(`workflows: \\[${name}\\]`));
    assert.match(triggerWorkflow, /^permissions: \{\}$/m);
    assert.doesNotMatch(triggerWorkflow, /secrets\./);
  });
});
