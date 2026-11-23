// CI reads (checks, check runs, logs, workflow runs) through real sessions on the real
// `GitHubGatekeeperImpl` Durable Object, with GitHub faked at the `fetch` boundary -- REST, GraphQL,
// and the blob storage job logs are downloaded from -- and the overseer's approval queue and
// workspace git cache faked at their stub boundaries.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type { ActionPresentation } from "@gadgets/gatekeeper-kit/actions";
import { FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type {
  GitHubCheckRunDetails, GitHubCommitChecks, GitHubLogPage, GitHubPullRequestChecks,
} from "../../src/types";
import type {
  CreatePullRequestActionData, GatekeeperProps, Outcome, PushActionData, SessionCall,
} from "./worker";

const OWNER = "acme";
const REPO = "widgets";
/** Where the binding reads the repository once pinned: by its id, 1. */
const API_BASE = "https://api.github.com/repositories/1";
/** The repository by name, which the binding reads only to pin its id. */
const NAME_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RECEIVE_PACK_URL = `https://github.com/${OWNER}/${REPO}.git/git-receive-pack`;
const BLOB_ORIGIN = "https://blob.example.net";

const HEAD = "a".repeat(40);     // main's head, and pull request #7's head
const C1 = "c".repeat(40);       // pull request #7's first commit
const FOREIGN = "f".repeat(40);  // a commit that is not pull request #7's
const PUSHED = "e".repeat(40);   // an agent commit, queued for push
const TREE = "1".repeat(40);

const MINUTE = 60_000;

const encoder = new TextEncoder();

// -- Fakes ---------------------------------------------------------------------------------------

/** A commit's rollup, as the fake GraphQL endpoint reports it. */
type FakeRollup = {
  /** The rollup's StatusState, or null when nothing has reported. */
  state: string | null;
  nodes: Record<string, unknown>[];
  committedAt: number;
  /** Whether `.github/workflows` holds a workflow file at the commit. */
  workflows: boolean;
  /** Whether the commit's first parent has a rollup. */
  parentHasCi: boolean;
  /** Entries per GraphQL page; all on one page when omitted. */
  pageSize?: number;
  /** Entries GitHub counts but returns as null, listed ahead of `nodes`. */
  hiddenNodes?: Record<string, unknown>[];
  /** Whether GitHub left out the counts by state, as a partial error can. */
  countsMissing?: boolean;
  /** The page (0-based) whose rollup GitHub nulls with an error, as a timeout on it does. */
  failedPage?: number;
  /** Whether GitHub answers the entry list as null, which its schema allows without an error. */
  nodesMissing?: boolean;
};

function checkRunNode(name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) {
  return {
    __typename: "CheckRun", databaseId: 100 + name.length, name, status, conclusion,
    startedAt: "2026-01-01T00:00:00Z", completedAt: conclusion === null ? null : "2026-01-01T00:01:00Z",
    url: `https://github.com/${OWNER}/${REPO}/runs/${100 + name.length}`, detailsUrl: null,
    pendingDeploymentRequest: null, isRequired: false,
    checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { databaseId: 900, workflow: { name: "CI" } } },
    ...extra,
  };
}

function statusNode(context: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: "StatusContext", context, state, description: null, targetUrl: null,
    updatedAt: "2026-01-01T00:00:00Z", isRequired: false, ...extra,
  };
}

function deploymentRequest(reviewers: number, waitTimer = 0) {
  return {
    waitTimer, waitTimerStartedAt: waitTimer > 0 ? "2026-01-01T00:00:00Z" : null,
    environment: { name: "production" }, reviewers: { totalCount: reviewers },
  };
}

/** A check run in the checks API's REST shape: a finished GitHub Actions job unless overridden. */
function checkRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, node_id: `CR_${id}`, head_sha: HEAD, name: "test",
    html_url: `https://github.com/${OWNER}/${REPO}/runs/${id}`,
    details_url: `https://github.com/${OWNER}/${REPO}/actions/runs/900/job/${id}`,
    status: "completed", conclusion: "failure",
    started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:00Z",
    output: { title: "1 test failed", summary: "See the log.", text: null, annotations_count: 2 },
    app: { name: "GitHub Actions", slug: "github-actions" },
    ...overrides,
  };
}

/** An Actions job in the jobs API's REST shape. */
function job(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, run_id: 900, run_attempt: 1, head_sha: HEAD, name: "test", workflow_name: "CI",
    status: "completed", conclusion: "failure",
    started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:00Z",
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/900/job/${id}`,
    check_run_url: `${API_BASE}/check-runs/${id}`,
    steps: [{ number: 1, name: "Run npm test", status: "completed", conclusion: "failure" }],
    ...overrides,
  };
}

function workflowRun(id: number, headSha: string) {
  return {
    id, name: "CI", event: "push", head_branch: "main", head_sha: headSha,
    status: "completed", conclusion: "failure" as string | null, run_attempt: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:05:00Z",
    run_started_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${id}`, actor: null,
  };
}

/** A run of HEAD held `pending` by its concurrency group, created `minutes` ago: it has no check runs yet. */
function pendingRun(id: number, minutes: number) {
  const createdAt = new Date(Date.now() - minutes * MINUTE).toISOString();
  return { ...workflowRun(id, HEAD), status: "pending", conclusion: null, created_at: createdAt, run_started_at: createdAt };
}

function commitResponse(sha: string) {
  return {
    sha, html_url: `https://github.com/${OWNER}/${REPO}/commit/${sha}`,
    commit: { message: "commit", author: null, committer: null }, author: null, parents: [],
  };
}

function pullResponse(number: number, headSha: string) {
  const repository = { owner: { login: OWNER }, name: REPO };
  return {
    number, html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`, title: `PR ${number}`,
    state: "open", body: "", user: null, labels: [], assignees: [], requested_reviewers: [],
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null,
    comments: 0, draft: false, merged_at: null, mergeable: true, mergeable_state: "blocked",
    commits: 2, additions: 1, deletions: 0, changed_files: 1,
    head: { ref: "fix", sha: headSha, repo: repository },
    base: { ref: "main", sha: HEAD, repo: repository },
  };
}

/** A job log as GitHub stores it: timestamped, with step groups and commands. */
const RAW_LOG = [
  "2026-01-01T00:00:00.0000000Z ##[group]Run npm test",
  "2026-01-01T00:00:01.0000000Z > test",
  "2026-01-01T00:00:02.0000000Z ##[endgroup]",
  "2026-01-01T00:00:03.0000000Z ok 1 parses",
  "2026-01-01T00:00:04.0000000Z ##[error]not ok 2 renders",
  "2026-01-01T00:00:05.0000000Z Error: expected 1, got 2",
  "2026-01-01T00:00:06.0000000Z done",
  "",
].join("\n");

/** Fakes GitHub at the fetch boundary, recording what it is asked. */
class FakeGitHub {
  readonly branches = new Map<string, string>([["main", HEAD]]);
  readonly rollups = new Map<string, FakeRollup>();
  readonly checkRuns = new Map<number, ReturnType<typeof checkRun>>();
  readonly jobs = new Map<number, ReturnType<typeof job>>();
  /** Each job's log: downloadable, or the status the logs endpoint answers instead. */
  readonly logs = new Map<number, string | 404 | 410>();
  readonly runs = new Map<number, ReturnType<typeof workflowRun>>();
  readonly pulls = new Map<number, ReturnType<typeof pullResponse>>();
  readonly pullCommits = new Map<number, string[]>();
  /** `base...head` → the commits GitHub's compare lists, oldest first. */
  readonly compares = new Map<string, { mergeBase: string; commits: string[] }>();
  /** Updates the activity API reports for any branch, newest first; `activity_type` defaults to push. */
  pushes: { after: string; timestamp: string; activity_type?: string }[] = [];
  /** When set, the activity API fails with this status instead. */
  activityStatus?: number;
  /** When set, a request to the activity API rejects with this, as a timeout or lost connection does. */
  activityError?: Error;
  requiredByRules: string[] | "rateLimited" = [];
  requiredByProtection: string[] = [];
  readonly graphqlQueries: string[] = [];
  /** Every request, with the Authorization header it carried. */
  readonly requests: { url: URL; authorization: string | null }[] = [];
  readonly #receivePackResponses: Uint8Array[] = [];

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  respondToPush(...lines: string[]): void {
    const pieces = [...lines.map(encodePktLine), FLUSH_PKT];
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    let offset = 0;
    for (const piece of pieces) {
      out.set(piece, offset);
      offset += piece.byteLength;
    }
    this.#receivePackResponses.push(out);
  }

  requestsTo(prefix: string): { url: URL; authorization: string | null }[] {
    return this.requests.filter(request => (request.url.origin + request.url.pathname).startsWith(prefix));
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    const headers = new Headers(init?.headers);
    this.requests.push({ url, authorization: headers.get("authorization") });
    const path = url.origin + url.pathname;
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

    if (path === RECEIVE_PACK_URL) {
      const response = this.#receivePackResponses.shift();
      if (!response) throw new Error("test: unexpected receive-pack request");
      return new Response(response, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    }
    if (path.startsWith(`${BLOB_ORIGIN}/logs/`)) {
      const log = this.logs.get(Number(path.slice(`${BLOB_ORIGIN}/logs/`.length)));
      return typeof log === "string" ? new Response(log) : new Response("gone", { status: 404 });
    }
    if (path === "https://api.github.com/graphql") {
      return Response.json(this.#graphql(JSON.parse(await new Response(init!.body as BodyInit).text())));
    }
    if (path === "https://api.github.com/user") {
      return Response.json({ login: "ada", name: null, html_url: "https://github.com/ada", avatar_url: null });
    }
    if (path === API_BASE || path === NAME_ROOT) {
      return Response.json({ id: 1, name: REPO, owner: { login: OWNER }, description: null,
        visibility: "public", private: false, default_branch: "main" });
    }
    const rest = path.slice(API_BASE.length);
    let match: RegExpMatchArray | null;
    if ((match = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const head = this.branches.get(decodeURIComponent(match[1]));
      return head === undefined ? notFound() : Response.json({ object: { sha: head, type: "commit" } });
    }
    if ((match = rest.match(/^\/commits\/(.+)$/))) {
      const ref = decodeURIComponent(match[1]);
      const sha = this.branches.get(ref) ?? (this.rollups.has(ref) ? ref : undefined);
      if (sha === undefined) {
        return /^[0-9a-f]{40}$/.test(ref)
          ? Response.json({ message: `No commit found for SHA: ${ref}` }, { status: 422 })
          : notFound();
      }
      return headers.get("accept")?.includes("sha") ? new Response(sha) : Response.json(commitResponse(sha));
    }
    if (rest === "/activity") {
      if (this.activityError !== undefined) throw this.activityError;
      if (this.activityStatus !== undefined) {
        return Response.json({ message: "Server Error" }, { status: this.activityStatus });
      }
      const kind = url.searchParams.get("activity_type");
      return Response.json(this.pushes.map(push => ({ activity_type: "push", ...push }))
        .filter(push => kind === null || push.activity_type === kind));
    }
    if ((match = rest.match(/^\/compare\/(.+)$/))) {
      const compare = this.compares.get(decodeURIComponent(match[1]));
      if (compare === undefined) return notFound();
      return Response.json({
        base_commit: { sha: compare.mergeBase }, merge_base_commit: { sha: compare.mergeBase },
        commits: compare.commits.map(commitResponse), total_commits: compare.commits.length, files: [],
      });
    }
    if ((match = rest.match(/^\/check-runs\/(\d+)(\/annotations)?$/))) {
      const run = this.checkRuns.get(Number(match[1]));
      if (run === undefined) return notFound();
      if (match[2] === undefined) return Response.json(run);
      const annotations = [
        { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "failure", title: "Type error", message: "nope" },
        { path: "src/b.ts", start_line: 9, end_line: 10, annotation_level: "warning", title: null, message: "hmm" },
      ];
      return Response.json(url.searchParams.get("page") === "1" ? annotations : []);
    }
    if ((match = rest.match(/^\/actions\/jobs\/(\d+)(\/logs)?$/))) {
      const id = Number(match[1]);
      if (match[2] === undefined) {
        const found = this.jobs.get(id);
        return found === undefined ? notFound() : Response.json(found);
      }
      const log = this.logs.get(id);
      if (log === undefined || typeof log === "number") {
        return Response.json({ message: "Gone" }, { status: log ?? 404 });
      }
      return new Response(null, { status: 302, headers: { Location: `${BLOB_ORIGIN}/logs/${id}?sig=signed` } });
    }
    if (rest === "/actions/runs") {
      const sha = url.searchParams.get("head_sha"), status = url.searchParams.get("status");
      return Response.json({
        workflow_runs: [...this.runs.values()].filter(run => (sha === null || run.head_sha === sha) &&
          (status === null || run.status === status || run.conclusion === status)),
      });
    }
    if ((match = rest.match(/^\/actions\/runs\/(\d+)(\/jobs|\/attempts\/\d+\/jobs)?$/))) {
      const run = this.runs.get(Number(match[1]));
      if (run === undefined) return notFound();
      return match[2] === undefined ? Response.json(run) : Response.json({ jobs: [...this.jobs.values()] });
    }
    if (rest.startsWith("/rules/branches/")) {
      if (this.requiredByRules === "rateLimited") {
        return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      }
      return Response.json(this.requiredByRules.length === 0 ? [] : [{
        type: "required_status_checks",
        parameters: { required_status_checks: this.requiredByRules.map(context => ({ context })) },
      }]);
    }
    if (rest.startsWith("/branches/")) {
      return Response.json({
        name: "main", protected: true,
        protection: { required_status_checks: { contexts: this.requiredByProtection, checks: [] } },
      });
    }
    if ((match = rest.match(/^\/pulls\/(\d+)(\/commits)?$/))) {
      const number = Number(match[1]);
      const pull = this.pulls.get(number);
      if (pull === undefined) return notFound();
      if (match[2] === undefined) return Response.json(pull);
      return Response.json(url.searchParams.get("page") === "1"
        ? (this.pullCommits.get(number) ?? []).map(commitResponse) : []);
    }
    throw new Error(`test: unexpected fetch to ${url}`);
  }

  #graphql({ query, variables }: { query: string; variables: Record<string, unknown> }) {
    this.graphqlQueries.push(query);
    if (variables.id !== undefined) {
      const run = [...this.checkRuns.values()].find(candidate => candidate.node_id === variables.id);
      return { data: { node: run === undefined ? null : { pendingDeploymentRequest: deploymentRequest(1) } } };
    }
    const rollup = this.rollups.get(variables.oid as string);
    const listed = (rollup?.nodes ?? []).map(node => {
      if (variables.withPull) return node;
      const { isRequired: _isRequired, ...rest } = node;
      return rest;
    });
    const hidden = rollup?.hiddenNodes ?? [];
    const nodes = [...hidden.map(() => null), ...listed];
    const offset = variables.after === null ? 0 : Number(variables.after);
    const end = offset + (rollup?.pageSize ?? nodes.length);
    const failed = rollup?.failedPage !== undefined && offset === rollup.failedPage * (rollup.pageSize ?? nodes.length);
    const countBy = (typename: string, stateOf: (node: Record<string, unknown>) => string) => {
      const counts = new Map<string, number>();
      for (const node of [...hidden, ...listed].filter(candidate => candidate.__typename === typename)) {
        counts.set(stateOf(node), (counts.get(stateOf(node)) ?? 0) + 1);
      }
      return [...counts].map(([state, count]) => ({ state, count }));
    };
    return {
      ...failed ? { errors: [{ message: "Timeout", path: ["repository", "object", "statusCheckRollup"] }] } : {},
      data: {
        repository: {
          databaseId: 1,
          object: rollup === undefined ? null : {
            committedDate: new Date(rollup.committedAt).toISOString(),
            parents: { nodes: [{ statusCheckRollup: rollup.parentHasCi ? { state: "SUCCESS" } : null }] },
            statusCheckRollup: rollup.state === null || failed ? null : {
              state: rollup.state,
              contexts: {
                pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null },
                checkRunCountsByState: rollup.countsMissing ? null : countBy("CheckRun", node => String(node.conclusion ?? node.status)),
                statusContextCountsByState: rollup.countsMissing ? null : countBy("StatusContext", node => String(node.state)),
                nodes: rollup.nodesMissing ? null : nodes.slice(offset, end),
              },
            },
          },
          workflows: rollup?.workflows ? { entries: [{ name: "ci.yml", type: "blob" }] } : null,
        },
      },
    };
  }
}

/**
 * The workspace git cache: serves the queued commit and the one it builds on (both on the empty
 * tree, so a simulated pull request diff is empty), and records what is advertised.
 */
class TestGitCache extends RpcTarget {
  readonly advertised: string[] = [];
  readonly #objects = new Map<GitOid, { type: GitObjectType; content: Uint8Array }>([
    [PUSHED, {
      type: "commit",
      content: encoder.encode(`tree ${TREE}\nparent ${HEAD}\nauthor A <a@example.com> 1700000000 +0000\n` +
        `committer A <a@example.com> 1700000000 +0000\n\nfix\n`),
    }],
    [HEAD, {
      type: "commit",
      content: encoder.encode(`tree ${TREE}\nauthor A <a@example.com> 1700000000 +0000\n` +
        `committer A <a@example.com> 1700000000 +0000\n\nbase\n`),
    }],
    [TREE, { type: "tree", content: new Uint8Array() }],
  ]);

  async get(id: GitOid) {
    return this.#objects.get(id) ?? null;
  }

  async stat(id: GitOid): Promise<{ type: GitObjectType; size: number } | null> {
    const object = this.#objects.get(id);
    return object === undefined ? null : { type: object.type, size: object.content.length };
  }

  async isAncestor(): Promise<boolean> {
    return true;
  }

  async advertiseCommit(id: string): Promise<void> {
    this.advertised.push(id);
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    return new Response("PACK-STAND-IN").body!;
  }
}

/** The overseer's approval queue: records each observation's title. */
class TestApprovalQueue extends RpcTarget {
  readonly observations: string[] = [];
  readonly cache = new TestGitCache();

  async authorizeObservation(description: { title: string }): Promise<void> {
    this.observations.push(description.title);
  }

  async submitAction(): Promise<void> {}

  async getGitCache(): Promise<TestGitCache> {
    return this.cache;
  }
}

// -- Harness ---------------------------------------------------------------------------------------

let nextScenario = 0;

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

/** The message `pending` is refused with. */
async function refusalOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("test: expected a refusal");
}

/** A gatekeeper bound to the repository, or to pull request `pull` in it. */
async function gatekeeper(pull?: number) {
  const scenario = `ci-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(), resourceKind: pull === undefined ? "repo" : "pull",
    owner: OWNER, repo: REPO, ...(pull === undefined ? {} : { issueNumber: pull }),
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  const queue = new TestApprovalQueue();
  const read = <T>(calls: SessionCall[], drain = false) =>
    unwrap(hooks.sessionRead(scenario, props, new RpcStub(queue) as never, calls, drain)) as Promise<T>;
  return {
    queue,
    read,
    /** Queues a push of PUSHED creating `branch`; returns its action id. */
    async queuePush(branch: string): Promise<number> {
      const action = await unwrap(hooks.preparePush(
        scenario, props, branch, PUSHED, false, new RpcStub(queue.cache) as never)) as PushActionData;
      const description: ActionPresentation = {
        title: "push", description: "push", pushedCommits: [PUSHED], implementsRevert: true,
      };
      await unwrap(hooks.submitPush(scenario, props, new RpcStub(queue) as never, action, description));
      return action.approvalId;
    },
    /** Queues creating a pull request from `head` into main; returns its provisional id. */
    async queuePullRequest(head: string): Promise<string> {
      const action = await unwrap(hooks.prepareCreatePullRequest(
        scenario, props, { title: "Fix", head, base: "main" })) as CreatePullRequestActionData;
      await unwrap(hooks.submitCreatePullRequest(scenario, props, new RpcStub(queue) as never, action, {
        title: "create PR", description: "create PR", implementsRevert: false,
      }));
      return action.provisionalId;
    },
    apply: (actionId: number) =>
      unwrap(hooks.applyAction(scenario, props, actionId, new RpcStub(queue.cache) as never)),
  };
}

function fakeGitHub(): FakeGitHub {
  const github = new FakeGitHub();
  github.install();
  return github;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// -- Tests ---------------------------------------------------------------------------------------

describe("getChecks: mapping and phase", () => {
  const nodes = () => [
    checkRunNode("build", "COMPLETED", "SUCCESS"),
    checkRunNode("deploy", "WAITING", null, { pendingDeploymentRequest: deploymentRequest(1) }),
    checkRunNode("soak", "WAITING", null, { pendingDeploymentRequest: deploymentRequest(0, 5) }),
    checkRunNode("first-timer", "COMPLETED", "ACTION_REQUIRED"),
    checkRunNode("mystery", "FROBNICATING", null),
    statusNode("ci/legacy", "ERROR"),
  ];

  it("maps each entry's state and phase, counts them, and is active while anything is", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, { state: "FAILURE", nodes: nodes(), committedAt: Date.now(), workflows: true, parentHasCi: true });
    const gk = await gatekeeper();

    const checks = await gk.read<GitHubCommitChecks>([{ method: "getChecks", args: [HEAD] }]);
    expect(checks.commitId).toBe(HEAD);
    expect(checks.state).toBe("failure");
    expect(checks.checks.map(entry => [
      entry.kind === "checkRun" ? entry.name : entry.context, entry.state, entry.phase,
    ])).toEqual([
      ["build", "success", "done"],
      ["deploy", "waiting", "blocked"],       // a reviewer must approve
      ["soak", "waiting", "active"],          // a wait timer only
      ["first-timer", "actionRequired", "blocked"],
      ["mystery", "unknown", "blocked"],
      ["ci/legacy", "failure", "done"],
    ]);
    expect(checks.checks[0]).toMatchObject({ app: "GitHub Actions", workflowRun: { id: "900", name: "CI" } });
    expect(checks.counts).toEqual({ success: 1, waiting: 2, actionRequired: 1, unknown: 1, failure: 1 });
    expect(checks.phase).toBe("active");
  });

  it("is blocked when nothing is active but something waits for a person", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, {
      state: "PENDING", nodes: nodes().filter(node => !("name" in node && node.name === "soak")),
      committedAt: Date.now(), workflows: true, parentHasCi: true,
    });
    const gk = await gatekeeper();

    expect((await gk.read<GitHubCommitChecks>([{ method: "getChecks", args: [HEAD] }])).phase).toBe("blocked");
  });

  it("is blocked by an unrecognised status alone", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, {
      state: "PENDING", nodes: [checkRunNode("build", "COMPLETED", "SUCCESS"), checkRunNode("x", "FROBNICATING", null)],
      committedAt: Date.now(), workflows: true, parentHasCi: true,
    });
    const gk = await gatekeeper();

    expect((await gk.read<GitHubCommitChecks>([{ method: "getChecks", args: [HEAD] }])).phase).toBe("blocked");
  });
});

describe("getChecks: a commit nothing has reported on", () => {
  const empty = (overrides: Partial<FakeRollup>): FakeRollup =>
    ({ state: null, nodes: [], committedAt: Date.now(), workflows: true, parentHasCi: false, ...overrides });

  it("has not started within ten minutes of becoming the head while CI is expected", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, empty({ committedAt: Date.now() - MINUTE }));
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getChecks", args: [HEAD] }]))
      .toEqual({ commitId: HEAD, state: "none", phase: "notStarted", counts: {}, checks: [] });
  });

  it("is done with no results past the window, taking GitHub's push record over the commit date", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, empty({ committedAt: Date.now() - 60 * MINUTE }));
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getChecks", args: ["main"] }]))
      .toMatchObject({ commitId: HEAD, state: "none", phase: "done", checks: [] });

    // The commit is old, but was pushed to main two minutes ago.
    github.pushes = [{ after: HEAD, timestamp: new Date(Date.now() - 2 * MINUTE).toISOString() }];
    expect(await gk.read([{ method: "getChecks", args: ["main"] }])).toMatchObject({ phase: "notStarted" });
  });

  it.each(["force_push", "branch_creation"])("takes a %s as the head time too", async kind => {
    // An old commit made the head by a force push, or a branch created at it, outside this gatekeeper.
    const github = fakeGitHub();
    github.rollups.set(HEAD, empty({ committedAt: Date.now() - 60 * MINUTE }));
    github.pushes = [{ after: HEAD, timestamp: new Date(Date.now() - 2 * MINUTE).toISOString(), activity_type: kind }];
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getChecks", args: ["main"] }])).toMatchObject({ phase: "notStarted" });
  });

  it.each([
    ["refuses it", (github: FakeGitHub) => { github.activityStatus = 503; }],
    ["times out", (github: FakeGitHub) => { github.activityError = new DOMException("timed out", "TimeoutError"); }],
    ["cannot be reached", (github: FakeGitHub) => { github.activityError = new TypeError("Network connection lost."); }],
  ])("falls back to the commit date when GitHub's push record cannot be read: GitHub %s", async (_, fail) => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, empty({ committedAt: Date.now() - 60 * MINUTE }));
    fail(github);
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getChecks", args: ["main"] }]))
      .toMatchObject({ commitId: HEAD, state: "none", phase: "done", checks: [] });
    expect(github.requestsTo(`${API_BASE}/activity`)).toHaveLength(1);
  });

  it("is done at once when no CI is expected, and not when the first parent had CI", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, empty({ workflows: false }));
    const gk = await gatekeeper();
    expect(await gk.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ phase: "done", state: "none" });

    github.rollups.set(HEAD, empty({ workflows: false, parentHasCi: true }));
    expect(await gk.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ phase: "notStarted" });
  });

  it("has not started while its push is queued, without asking GitHub for CI", async () => {
    const github = fakeGitHub();
    const gk = await gatekeeper();
    await gk.queuePush("feature");

    expect(await gk.read([{ method: "getChecks", args: ["feature"] }]))
      .toEqual({ commitId: PUSHED, state: "none", phase: "notStarted", counts: {}, checks: [] });
    expect(github.graphqlQueries).toEqual([]);
    expect(gk.queue.observations).toEqual([expect.stringContaining(PUSHED.slice(0, 12))]);
    // A commit GitHub does not have yet is not advertised.
    expect(gk.queue.cache.advertised).toEqual([]);
  });

  it("does not advertise a commit only the workspace cache has, such as a queued push's intermediate one", async () => {
    // No queued push names it as its head, so only `fromCache` keeps the hint from outliving a rejection.
    fakeGitHub();
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getChecks", args: [PUSHED] }])).toMatchObject({ commitId: PUSHED, phase: "notStarted" });
    expect(gk.queue.cache.advertised).toEqual([]);
  });

  it("counts the window from when this gatekeeper applied the push", async () => {
    const github = fakeGitHub();
    const gk = await gatekeeper();
    const push = await gk.queuePush("feature");
    github.respondToPush("unpack ok", "ok refs/heads/feature");
    await gk.apply(push);
    github.branches.set("feature", PUSHED);
    // An old commit, and GitHub's activity API knows of no push of it.
    github.rollups.set(PUSHED, empty({ committedAt: Date.now() - 60 * MINUTE }));

    expect(await gk.read([{ method: "getChecks", args: ["feature"] }])).toMatchObject({ phase: "notStarted" });
    expect(github.requestsTo(`${API_BASE}/activity`)).toEqual([]);
  });
});

describe("getChecks: a run its concurrency group holds", () => {
  it("keeps a commit whose visible checks are done active for an hour, then lets it be done", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, { state: "SUCCESS", nodes: [checkRunNode("build", "COMPLETED", "SUCCESS")],
      committedAt: Date.now() - 60 * MINUTE, workflows: true, parentHasCi: true });
    github.runs.set(900, pendingRun(900, 5));
    const gk = await gatekeeper();
    expect(await gk.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ state: "success", phase: "active" });

    // Pending for over an hour, it is taken as stuck.
    github.runs.set(900, pendingRun(900, 61));
    expect(await gk.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ phase: "done" });
  });

  it("keeps an old commit nothing has reported on active rather than done", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, { state: null, nodes: [], committedAt: Date.now() - 60 * MINUTE, workflows: true, parentHasCi: false });
    github.runs.set(900, pendingRun(900, 30));
    const gk = await gatekeeper();
    expect(await gk.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ state: "none", phase: "active" });
  });
});

describe("pull request CI", () => {
  function pullScenario(): FakeGitHub {
    const github = fakeGitHub();
    github.pulls.set(7, pullResponse(7, HEAD));
    github.pullCommits.set(7, [C1, HEAD]);
    github.rollups.set(HEAD, {
      state: "SUCCESS", committedAt: Date.now(), workflows: true, parentHasCi: true,
      nodes: [checkRunNode("build", "COMPLETED", "SUCCESS", { isRequired: true }), statusNode("ci/extra", "SUCCESS")],
    });
    github.rollups.set(C1, { state: "FAILURE", nodes: [checkRunNode("build", "COMPLETED", "FAILURE")],
      committedAt: Date.now(), workflows: true, parentHasCi: true });
    github.requiredByRules = ["build", "deploy-preview"];
    github.requiredByProtection = ["lint"];
    github.checkRuns.set(55, checkRun(55, { head_sha: FOREIGN }));
    github.checkRuns.set(56, checkRun(56, { head_sha: C1 }));
    github.jobs.set(56, job(56, { head_sha: C1 }));
    github.runs.set(900, workflowRun(900, HEAD));
    github.runs.set(901, workflowRun(901, FOREIGN));
    return github;
  }

  it("starts CI's window when the pull request was opened, however old its head, and reads the push record once", async () => {
    // A branch pushed an hour ago, its pull request opened just now: `on: pull_request` CI is only starting.
    const github = pullScenario();
    github.rollups.set(HEAD, { state: null, nodes: [], committedAt: Date.now() - 60 * MINUTE, workflows: true, parentHasCi: false });
    const openedAgo = (minutes: number) =>
      github.pulls.set(7, { ...pullResponse(7, HEAD), created_at: new Date(Date.now() - minutes * MINUTE).toISOString() });
    openedAgo(2);
    const gk = await gatekeeper(7);
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ state: "expected", phase: "notStarted" });

    // Opened an hour ago too: the missing required checks need someone to act.
    openedAgo(60);
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ state: "expected", phase: "blocked" });
    expect(github.requestsTo(`${API_BASE}/activity`)).toHaveLength(2);
  });

  it("keeps a missing required check active, not blocked, while a run of the head waits on its concurrency group", async () => {
    const github = pullScenario();
    github.rollups.get(HEAD)!.committedAt = Date.now() - 60 * MINUTE;
    const gk = await gatekeeper(7);
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ state: "expected", phase: "blocked" });

    github.runs.set(902, pendingRun(902, 20));
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ state: "expected", phase: "active" });
  });

  it("reports the head's checks with what the base branch requires, and mergeState", async () => {
    pullScenario();
    const gk = await gatekeeper(7);

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    // Every reported check passed, but required ones have not reported: CI is not over.
    expect(checks).toMatchObject({ commitId: HEAD, state: "expected", phase: "active" });
    expect(checks.checks.map(entry => [entry.kind === "checkRun" ? entry.name : entry.context, entry.required]))
      .toEqual([["build", true], ["ci/extra", false]]);
    expect(checks.missingRequired.toSorted()).toEqual(["deploy-preview", "lint"]);
    expect(await gk.read([{ method: "getDetails" }])).toMatchObject({ mergeState: "blocked" });
  });

  it("keeps polling until a missing required check reports, then is done", async () => {
    const github = pullScenario();
    github.requiredByProtection = [];
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "expected", phase: "active", missingRequired: ["deploy-preview"] });

    github.rollups.get(HEAD)!.nodes.push(checkRunNode("deploy-preview", "COMPLETED", "SUCCESS", { isRequired: true }));
    expect(await gk.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "success", phase: "done", missingRequired: [] });
  });

  it("fails a read whose required checks GitHub rate-limited, and does not cache that", async () => {
    const github = pullScenario();
    github.requiredByRules = "rateLimited";
    const gk = await gatekeeper(7);
    await expect(gk.read([{ method: "getChecks" }])).rejects.toThrow("rate limit");

    github.requiredByRules = ["deploy-preview"];
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ missingRequired: ["deploy-preview", "lint"] });
  });

  it("reads CI at a head someone else pushed at once, not at the cached previous one", async () => {
    const github = pullScenario();
    const gk = await gatekeeper(7);
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ commitId: HEAD });

    github.pulls.set(7, pullResponse(7, C1));
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ commitId: C1, state: "failure" });
  });

  it("stops polling on a required check still missing ten minutes after the head arrived", async () => {
    // A required check that has not reported by then never will without someone acting: a
    // path-filtered workflow, or an app not installed on the repository.
    const github = pullScenario();
    github.requiredByProtection = [];
    github.rollups.get(HEAD)!.committedAt = Date.now() - 60 * MINUTE;
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "expected", phase: "blocked", missingRequired: ["deploy-preview"] });
    // Unless the head was pushed lately, whatever its commit date.
    github.pushes = [{ after: HEAD, timestamp: new Date(Date.now() - 2 * MINUTE).toISOString() }];
    expect(await gk.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "expected", phase: "active", missingRequired: ["deploy-preview"] });
    // And a check still running keeps it active, however old the head.
    github.pushes = [];
    github.rollups.get(HEAD)!.nodes.push(checkRunNode("e2e", "IN_PROGRESS", null));
    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ phase: "active" });
  });

  it("bounds GitHub's own expected verdict the same way, on a pull request and on the repository", async () => {
    // GitHub reads a required status that has not reported as EXPECTED, including one whose
    // requirement this account cannot see (so nothing is named missing).
    const github = pullScenario();
    github.requiredByRules = ["build"];
    github.requiredByProtection = [];
    Object.assign(github.rollups.get(HEAD)!, { state: "EXPECTED", committedAt: Date.now() - 60 * MINUTE });
    const pull = await gatekeeper(7);
    const repo = await gatekeeper();

    expect(await pull.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "expected", phase: "blocked", missingRequired: [] });
    expect(await repo.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ state: "expected", phase: "blocked" });
    github.pushes = [{ after: HEAD, timestamp: new Date(Date.now() - 2 * MINUTE).toISOString() }];
    expect(await pull.read([{ method: "getChecks" }])).toMatchObject({ state: "expected", phase: "active" });
    expect(await repo.read([{ method: "getChecks", args: ["main"] }])).toMatchObject({ state: "expected", phase: "active" });
    github.pushes = [];
    github.rollups.get(HEAD)!.nodes.push(checkRunNode("e2e", "IN_PROGRESS", null));
    expect(await pull.read([{ method: "getChecks" }])).toMatchObject({ phase: "active" });
    expect(await repo.read([{ method: "getChecks", args: [HEAD] }])).toMatchObject({ phase: "active" });
  });

  it("reads every page of the rollup", async () => {
    const github = pullScenario();
    github.rollups.get(HEAD)!.pageSize = 1;
    const gk = await gatekeeper(7);

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    expect(github.graphqlQueries).toHaveLength(2);
    expect(checks.checks.map(entry => [entry.kind === "checkRun" ? entry.name : entry.context, entry.required]))
      .toEqual([["build", true], ["ci/extra", false]]);
    expect(checks.counts).toEqual({ success: 2 });
    expect(checks.missingRequired.toSorted()).toEqual(["deploy-preview", "lint"]);
  });

  it.each([0, 1])("refuses a rollup page GitHub nulled with an error (page %s) rather than read it as absent", async page => {
    // Read as absent, an old commit's first page would be "no CI ran", and a later one would drop entries unflagged.
    const github = pullScenario();
    Object.assign(github.rollups.get(HEAD)!, { pageSize: 1, failedPage: page, committedAt: Date.now() - 60 * MINUTE });
    const gk = await gatekeeper(7);

    await expect(gk.read([{ method: "getChecks" }])).rejects.toThrow(/could not read this commit's CI just now/);
  });

  it.each([false, true])("keeps polling a pending rollup whose entry list GitHub left null (counts missing: %s)", async countsMissing => {
    // No error comes with it, so only the null list says entries were left out; read as none, an
    // old commit would be done while its CI runs.
    const github = pullScenario();
    Object.assign(github.rollups.get(HEAD)!, {
      state: "PENDING", nodes: [checkRunNode("build", "IN_PROGRESS", null)], nodesMissing: true, countsMissing,
      committedAt: Date.now() - 60 * MINUTE,
    });
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ state: "pending", phase: "active", checks: [] });
  });

  it("counts every check past the 1000 it lists, and names none missing then", async () => {
    const github = pullScenario();
    github.rollups.set(HEAD, {
      state: "SUCCESS", committedAt: Date.now(), workflows: true, parentHasCi: true, pageSize: 100,
      nodes: Array.from({ length: 1001 }, (_, index) => checkRunNode(`check-${index}`, "COMPLETED", "SUCCESS")),
    });
    const gk = await gatekeeper(7);

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    expect(checks.checks).toHaveLength(1000);
    expect(checks.counts).toEqual({ success: 1001 });
    expect(checks).toMatchObject({ state: "success", phase: "done", missingRequired: [] });
  });

  it("judges a check dropped at the cap as unread when null entries shortened earlier pages", async () => {
    const github = pullScenario();
    github.rollups.set(HEAD, {
      state: "PENDING", committedAt: Date.now(), workflows: true, parentHasCi: true, pageSize: 100,
      hiddenNodes: Array.from({ length: 10 }, (_, index) => checkRunNode(`hidden-${index}`, "COMPLETED", "SUCCESS")),
      nodes: [
        ...Array.from({ length: 1000 }, (_, index) => checkRunNode(`check-${index}`, "COMPLETED", "SUCCESS")),
        checkRunNode("soak", "IN_PROGRESS", null),
      ],
    });
    const gk = await gatekeeper(7);

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    expect(checks.checks).toHaveLength(1000);
    expect(checks).toMatchObject({ state: "pending", phase: "active", missingRequired: [] });
  });

  it.each([false, true])("names no required check missing when GitHub returns one as null (counts missing: %s)", async countsMissing => {
    const github = pullScenario();
    github.requiredByRules = ["build"];
    Object.assign(github.rollups.get(HEAD)!, {
      countsMissing, hiddenNodes: [checkRunNode("lint", "COMPLETED", "SUCCESS", { isRequired: true })],
    });
    const gk = await gatekeeper(7);

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    expect(checks.checks).toHaveLength(2);
    expect(checks).toMatchObject({ state: "success", phase: "done", missingRequired: [] });
  });

  it("keeps polling on a pending rollup whose unfinished check GitHub returned as null, uncounted", async () => {
    const github = pullScenario();
    github.requiredByRules = ["build"];
    Object.assign(github.rollups.get(HEAD)!, {
      state: "PENDING", countsMissing: true, hiddenNodes: [checkRunNode("lint", "IN_PROGRESS", null, { isRequired: true })],
    });
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "getChecks" }]))
      .toMatchObject({ state: "pending", phase: "active", missingRequired: [] });
  });

  it("takes what the base branch requires for a pull request GitHub has not created yet", async () => {
    const github = pullScenario();
    github.branches.set("fix", C1);
    github.compares.set("main...fix", { mergeBase: HEAD, commits: [C1] });
    const gk = await gatekeeper();
    const provisionalId = await gk.queuePullRequest("fix");

    const checks = await gk.read<GitHubPullRequestChecks>(
      [{ method: "getPullRequest", args: [provisionalId] }, { method: "getChecks" }]);
    expect(checks).toMatchObject({ commitId: C1, state: "failure", phase: "done" });
    expect(checks.checks.map(entry => [entry.kind === "checkRun" ? entry.name : entry.context, entry.required]))
      .toEqual([["build", true]]);
    expect(checks.missingRequired.toSorted()).toEqual(["deploy-preview", "lint"]);
  });

  it("reads CI on the pull request's own commits and refuses any other", async () => {
    pullScenario();
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "getChecks", args: [C1] }])).toMatchObject({ commitId: C1, state: "failure" });
    await expect(gk.read([{ method: "getChecks", args: [FOREIGN] }])).rejects.toThrow("pull request #7");

    expect(await gk.read([{ method: "getCheckRun", args: ["56"] }, { method: "getDetails" }]))
      .toMatchObject({ id: "56", commitId: C1 });
    // A refusal names no commit another run ran on: run ids are sequential and enumerable.
    for (const opened of [{ method: "getCheckRun", args: ["55"] }, { method: "getWorkflowRun", args: ["901"] }]) {
      const refusal = await refusalOf(gk.read([opened]));
      expect(refusal).toContain("pull request #7");
      expect(refusal).not.toContain(FOREIGN.slice(0, 7));
    }

    expect(await gk.read([{ method: "getWorkflowRun", args: ["900"] }, { method: "getDetails" }]))
      .toMatchObject({ id: "900", commitId: HEAD });
  });

  it("lists the head commit's workflow runs", async () => {
    pullScenario();
    const gk = await gatekeeper(7);

    expect(await gk.read([{ method: "listWorkflowRuns" }], true)).toMatchObject([{ id: "900", commitId: HEAD }]);
  });

  it("reads CI on a head it pushed once the push reaches GitHub", async () => {
    const github = fakeGitHub();
    github.branches.set("fix", HEAD);
    github.pulls.set(7, pullResponse(7, HEAD));
    github.pullCommits.set(7, [HEAD]);
    github.compares.set(`main...${HEAD}`, { mergeBase: HEAD, commits: [] });
    github.rollups.set(HEAD, { state: "FAILURE", nodes: [checkRunNode("build", "COMPLETED", "FAILURE")],
      committedAt: Date.now(), workflows: true, parentHasCi: true });
    const gk = await gatekeeper(7);
    const push = await gk.queuePush("fix");

    // Queued: nothing has run on it.
    expect(await gk.read([{ method: "getChecks" }]))
      .toEqual({ commitId: PUSHED, state: "none", phase: "notStarted", counts: {}, checks: [], missingRequired: [] });
    expect(await gk.read([{ method: "listWorkflowRuns" }], true)).toEqual([]);

    github.respondToPush("unpack ok", "ok refs/heads/fix");
    await gk.apply(push);
    github.branches.set("fix", PUSHED);
    github.pulls.set(7, pullResponse(7, PUSHED));
    github.pullCommits.set(7, [HEAD, PUSHED]);
    github.rollups.set(PUSHED, { state: "SUCCESS", nodes: [checkRunNode("build", "COMPLETED", "SUCCESS")],
      committedAt: Date.now(), workflows: true, parentHasCi: true });
    github.runs.set(900, workflowRun(900, PUSHED));

    const checks = await gk.read<GitHubPullRequestChecks>([{ method: "getChecks" }]);
    expect(checks).toMatchObject({ commitId: PUSHED, state: "success", phase: "done", counts: { success: 1 } });
    expect(checks.checks).toMatchObject([{ kind: "checkRun", name: "build", state: "success" }]);
    expect(await gk.read([{ method: "listWorkflowRuns" }], true)).toMatchObject([{ id: "900", commitId: PUSHED }]);
  });

  it("keeps reporting a head's CI while an unrelated branch push of the same commit is queued", async () => {
    const github = pullScenario();
    github.pulls.set(7, pullResponse(7, PUSHED));
    github.pullCommits.set(7, [HEAD, PUSHED]);
    github.rollups.set(PUSHED, { state: "FAILURE", nodes: [checkRunNode("build", "COMPLETED", "FAILURE")],
      committedAt: Date.now(), workflows: true, parentHasCi: true });
    github.runs.set(900, workflowRun(900, PUSHED));
    const gk = await gatekeeper(7);
    await gk.queuePush("release");

    expect(await gk.read([{ method: "getChecks" }])).toMatchObject({ commitId: PUSHED, state: "failure", phase: "done" });
    expect(await gk.read([{ method: "listWorkflowRuns" }], true)).toMatchObject([{ id: "900" }]);
  });
});

describe("check runs", () => {
  /** A finished Actions job 70 with a log, and another app's check run 80. */
  function checkRunScenario(): FakeGitHub {
    const github = fakeGitHub();
    github.checkRuns.set(70, checkRun(70));
    github.jobs.set(70, job(70));
    github.logs.set(70, RAW_LOG);
    github.checkRuns.set(80, checkRun(80, {
      name: "CircleCI build", app: { name: "CircleCI Checks", slug: "circleci-checks" },
      details_url: "https://circleci.com/gh/acme/widgets/42",
    }));
    return github;
  }

  const readLog = (options?: unknown): SessionCall[] =>
    [{ method: "getCheckRun", args: ["70"] }, { method: "readLog", args: options === undefined ? [] : [options] }];

  it("opens an Actions job id as its check run, with steps and annotations", async () => {
    const github = checkRunScenario();
    // The job 71 reports through check run 70.
    github.jobs.set(71, job(71, { check_run_url: `${API_BASE}/check-runs/70` }));
    const gk = await gatekeeper();

    const details = await gk.read<GitHubCheckRunDetails>([{ method: "getCheckRun", args: ["71"] }, { method: "getDetails" }]);
    expect(details).toMatchObject({
      id: "70", name: "test", state: "failure", phase: "done", app: "GitHub Actions", commitId: HEAD,
      annotationCount: 2, title: "1 test failed",
      steps: [{ number: 1, name: "Run npm test", state: "failure", phase: "done" }],
    });
    expect(await gk.read([{ method: "getCheckRun", args: ["70"] }, { method: "listAnnotations" }], true))
      .toEqual([
        { path: "src/a.ts", startLine: 3, endLine: 3, level: "failure", title: "Type error", message: "nope" },
        { path: "src/b.ts", startLine: 9, endLine: 10, level: "warning", message: "hmm" },
      ]);
  });

  it("tells a deployment reviewer's hold from a wait timer", async () => {
    const github = checkRunScenario();
    github.checkRuns.set(70, checkRun(70, { status: "waiting", conclusion: null }));
    github.jobs.set(70, job(70, { status: "waiting", conclusion: null }));
    const gk = await gatekeeper();

    expect(await gk.read([{ method: "getCheckRun", args: ["70"] }, { method: "getDetails" }])).toMatchObject({
      state: "waiting", phase: "blocked", pendingDeployment: { environment: "production", needsReviewers: true },
    });
  });

  it("refuses to read the log of another app's check run, pointing at getDetails()", async () => {
    checkRunScenario();
    const gk = await gatekeeper();

    const error: unknown = await gk.read([{ method: "getCheckRun", args: ["80"] }, { method: "readLog" }])
      .then(() => undefined, (thrown: unknown) => thrown);
    const message = (error as Error).message;
    expect(message).toContain("not reported by GitHub Actions");
    expect(message).toContain("getDetails()");
    // Nothing the provider reported appears before the check run is observed.
    expect(message).not.toMatch(/circleci/i);
  });

  it("pages a log by tail, line range and search", async () => {
    checkRunScenario();
    const gk = await gatekeeper();

    expect(await gk.read<GitHubLogPage>(readLog())).toEqual({
      lines: [
        { number: 1, text: "▶ Run npm test" },
        { number: 2, text: "> test" },
        { number: 3, text: "ok 1 parses" },
        { number: 4, text: "error: not ok 2 renders" },
        { number: 5, text: "Error: expected 1, got 2" },
        { number: 6, text: "done" },
      ],
      totalLines: 6, firstAvailableLine: 1, complete: true,
    });
    expect((await gk.read<GitHubLogPage>(readLog({ maxLines: 2 }))).lines.map(line => line.number)).toEqual([5, 6]);
    expect((await gk.read<GitHubLogPage>(readLog({ fromLine: 2, maxLines: 2 }))).lines.map(line => line.number))
      .toEqual([2, 3]);
    expect((await gk.read<GitHubLogPage>(readLog({ search: "ERROR" }))).lines.map(line => line.number))
      .toEqual([4, 5]);
  });

  it("reads an unfinished job's log as empty without fetching it", async () => {
    const github = checkRunScenario();
    github.checkRuns.set(70, checkRun(70, { status: "in_progress", conclusion: null, completed_at: null }));
    const gk = await gatekeeper();

    expect(await gk.read(readLog())).toEqual({ lines: [], totalLines: 0, firstAvailableLine: 1, complete: false });
    expect(github.requestsTo(`${API_BASE}/actions/jobs/70/logs`)).toEqual([]);
    expect(github.requestsTo(BLOB_ORIGIN)).toEqual([]);
  });

  it("downloads the log from blob storage without the token", async () => {
    const github = checkRunScenario();
    const gk = await gatekeeper();

    await gk.read(readLog());
    expect(github.requestsTo(`${API_BASE}/actions/jobs/70/logs`).map(request => request.authorization))
      .toEqual(["Bearer test-token"]);
    expect(github.requestsTo(BLOB_ORIGIN).map(request => request.authorization)).toEqual([null]);
  });

  it("serves a finished log from cache until GitHub deletes it", async () => {
    const github = checkRunScenario();
    const gk = await gatekeeper();

    await gk.read(readLog());
    await gk.read(readLog({ search: "error" }));
    // Each read asked GitHub for the log again; only the first downloaded it.
    expect(github.requestsTo(`${API_BASE}/actions/jobs/70/logs`)).toHaveLength(2);
    expect(github.requestsTo(BLOB_ORIGIN)).toHaveLength(1);

    github.logs.set(70, 410);
    await expect(gk.read(readLog())).rejects.toThrow("GitHub has deleted this job's log.");

    // The cached copy is gone: a log GitHub serves again is downloaded afresh.
    github.logs.set(70, RAW_LOG);
    expect((await gk.read<GitHubLogPage>(readLog())).totalLines).toBe(6);
    expect(github.requestsTo(BLOB_ORIGIN)).toHaveLength(2);
  });
});

describe("observations", () => {
  it("records every CI data read, and no stub open", async () => {
    const github = fakeGitHub();
    github.rollups.set(HEAD, { state: "FAILURE", nodes: [checkRunNode("test", "COMPLETED", "FAILURE")],
      committedAt: Date.now(), workflows: true, parentHasCi: true });
    github.checkRuns.set(70, checkRun(70));
    github.jobs.set(70, job(70));
    github.logs.set(70, RAW_LOG);
    github.runs.set(900, workflowRun(900, HEAD));
    const gk = await gatekeeper();

    await gk.read([{ method: "getCheckRun", args: ["70"] }]);
    await gk.read([{ method: "getWorkflowRun", args: ["900"] }]);
    expect(gk.queue.observations).toEqual([]);

    await gk.read([{ method: "getChecks", args: [HEAD] }]);
    await gk.read([{ method: "getCheckRun", args: ["70"] }, { method: "getDetails" }]);
    await gk.read([{ method: "getCheckRun", args: ["70"] }, { method: "listAnnotations" }], true);
    await gk.read([{ method: "getCheckRun", args: ["70"] }, { method: "readLog", args: [{ maxLines: 2 }] }]);
    await gk.read([{ method: "listWorkflowRuns", args: [{ branch: "main" }] }], true);
    await gk.read([{ method: "getWorkflowRun", args: ["900"] }, { method: "getDetails" }]);
    await gk.read([{ method: "getWorkflowRun", args: ["900"] }, { method: "listJobs", args: [{ attempt: 1 }] }], true);
    // One observation per read, in order, each naming what it read.
    expect(gk.queue.observations).toEqual([
      expect.stringContaining(HEAD.slice(0, 12)),
      expect.stringContaining("#70"),
      expect.stringContaining("#70"),
      expect.stringContaining("#70"),
      expect.any(String),
      expect.stringContaining("#900"),
      expect.stringContaining("#900"),
    ]);
  });
});
