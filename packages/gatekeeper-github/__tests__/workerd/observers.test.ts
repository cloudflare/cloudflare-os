// Collaborator ("observer") verification for GitHub bindings, through the real gatekeeper and
// UserAccount Durable Objects with GitHub faked at `fetch`: what each read reports to the Workshop,
// how verifyObserverAccess and addObserver answer, and how both hold up when the bound repository is
// renamed or transferred, deleted, or its name taken by another repository.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps, SessionCall } from "./worker";

const OWNER = "octo";
const REPO = "repo";
const REPO_ID = 42;
/** What every read through the binding reports. */
const SUBRESOURCE = `repo/${REPO_ID}`;
/** A repository that takes the bound one's name once it has left it. */
const OTHER_ID = 43;
const HEAD = "a".repeat(40);
const PULL_OPTIONS = { type: "commit", commitHistory: { kind: "depth", depth: 1 } } as const;
/** An upload-pack answer carrying a pack of one byte. */
const uploadPackResponse = () => new Blob([
  encodePktLine("packfile"), new Uint8Array([0x30, 0x30, 0x30, 0x36, 1, 0x50]), FLUSH_PKT,
]);

const MINUTE = 60_000;

type Row = Record<string, unknown>;

function issue(number: number, fullName = `${OWNER}/${REPO}`): Row {
  return {
    number, html_url: `https://github.com/${fullName}/issues/${number}`, title: `Issue ${number}`,
    state: "open", body: "", user: { login: "someone" }, labels: [], assignees: [],
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null, comments: 0,
  };
}

const workflowRun = {
  id: 900, name: "CI", event: "push", head_branch: "main", head_sha: HEAD, status: "completed",
  conclusion: "failure", run_attempt: 1, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:05:00Z", run_started_at: "2026-01-01T00:00:00Z",
  html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/900`, actor: null,
};

function job(id: number): Row {
  return {
    id, run_id: 900, run_attempt: 1, head_sha: HEAD, name: `test-${id}`, workflow_name: "CI",
    status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:05:00Z", html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/900/job/${id}`,
    check_run_url: `https://api.github.com/repositories/${REPO_ID}/check-runs/${id}`, steps: [],
  };
}

/** GitHub's REST API as each token sees it. */
class FakeGitHub {
  /** The repositories that exist, by id, with their owner and name now. */
  readonly repos = new Map<number, { owner: string; name: string }>([[REPO_ID, { owner: OWNER, name: REPO }]]);
  /** Names repositories have left, by full name, with the id each belonged to. */
  readonly formerNames = new Map<string, number>();
  /** The repositories each token can read; the binding's own account reads them all. */
  readonly readable = new Map<string, Set<number>>([["owner-token", new Set([REPO_ID, OTHER_ID])]]);
  /** What a token's `GET /repositories/<id>` is answered with instead, as for a rate limit. */
  readonly refusals = new Map<string, () => Response>();
  /** The status `GET /repos/<owner>/<name>` fails with, while set. */
  probeStatus: number | undefined;
  /** The bound repository's open issues. */
  issues: number[] = [];
  /** The bound repository's open pull requests. */
  pulls: number[] = [];
  readonly requests: { token: string; path: string; query: URLSearchParams }[] = [];
  /** The repositories git requests reached, by the name they were addressed by. */
  readonly gitRequests: string[] = [];
  /** Runs as a git request reaches GitHub, before it is answered. */
  onGit: (() => void) | undefined;

  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.#handle(new Request(input, init)));
  }

  /** The requests made with `token`, by path. */
  requestsWith(token: string): string[] {
    return this.requests.filter(request => request.token === token).map(request => request.path);
  }

  #handle(request: Request): Response {
    const url = new URL(request.url);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    this.requests.push({ token, path: url.pathname, query: url.searchParams });
    if (url.hostname === "github.com") {
      // github.com serves git by the name a repository has now, as it does any repository.
      const named = /^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/.exec(url.pathname);
      if (!named || this.#idNamed(`${named[1]}/${named[2]}`) === undefined) return new Response("Not Found", { status: 404 });
      this.gitRequests.push(`${named[1]}/${named[2]}`);
      this.onGit?.();
      return new Response(uploadPackResponse(), { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    }
    const notFound = Response.json({ message: "Not Found" }, { status: 404 });
    const canRead = (id: number) => this.repos.has(id) && (this.readable.get(token)?.has(id) ?? false);

    if (url.pathname === "/user") return Response.json({ id: 9, login: "someone" });
    const byName = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (byName) {
      if (this.probeStatus !== undefined) return Response.json({ message: "Server Error" }, { status: this.probeStatus });
      const fullName = `${byName[1]}/${byName[2]}`;
      const id = this.#idNamed(fullName);
      // A name a repository left redirects to it by id, until another repository takes the name.
      const moved = this.formerNames.get(fullName);
      if (id === undefined && moved !== undefined && this.repos.has(moved)) {
        return new Response(null, { status: 301, headers: { location: `https://api.github.com/repositories/${moved}` } });
      }
      return id !== undefined && canRead(id) ? Response.json(this.#repository(id)) : notFound;
    }
    const byId = /^\/repositories\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (byId) {
      const id = Number(byId[1]);
      const rest = byId[2] ?? "";
      const refusal = this.refusals.get(token);
      if (rest === "" && refusal) return refusal();
      if (!canRead(id)) return notFound;
      if (rest === "") return Response.json(this.#repository(id));
      if (id !== REPO_ID) return notFound;
      const firstPage = (url.searchParams.get("page") ?? "1") === "1";
      if (rest === "/issues") {
        const open = url.searchParams.get("state") !== "closed";
        return Response.json(firstPage && open ? this.issues.map(number => issue(number, this.#fullName(id))) : []);
      }
      const issueNumber = /^\/issues\/(\d+)$/.exec(rest)?.[1];
      if (issueNumber) return Response.json(issue(Number(issueNumber), this.#fullName(id)));
      const pull = (number: number) => ({
        ...issue(number, this.#fullName(id)), html_url: `https://github.com/${this.#fullName(id)}/pull/${number}`,
        draft: false, merged_at: null, requested_reviewers: [],
        // A removed branch repository uses the pull request's repository as its fallback.
        head: { ref: "fix", sha: HEAD, repo: null }, base: { ref: "main", sha: HEAD, repo: this.#repository(id) },
        commits: 1, additions: 0, deletions: 0, changed_files: 0,
      });
      if (rest === "/pulls") return Response.json(firstPage ? this.pulls.map(pull) : []);
      const pullNumber = /^\/pulls\/(\d+)$/.exec(rest)?.[1];
      if (pullNumber) return Response.json(pull(Number(pullNumber)));
      if (rest === "/actions/runs/900") return Response.json(workflowRun);
      if (rest === "/actions/runs/900/jobs") return Response.json({ jobs: firstPage ? [job(71), job(72)] : [] });
      return notFound;
    }
    if (url.pathname === "/search/issues") {
      // GitHub's search finds a repository by the name it has now.
      const named = this.#idNamed(/repo:(\S+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? "");
      const firstPage = (url.searchParams.get("page") ?? "1") === "1";
      const items = named === REPO_ID && canRead(REPO_ID) && firstPage
        ? this.issues.map(number => issue(number, this.#fullName(REPO_ID)))
        : [];
      return Response.json({ items });
    }
    throw new Error(`test: unexpected fetch to ${url}`);
  }

  #idNamed(fullName: string): number | undefined {
    return [...this.repos.keys()].find(id => this.#fullName(id) === fullName);
  }

  #fullName(id: number): string {
    const { owner, name } = this.repos.get(id)!;
    return `${owner}/${name}`;
  }

  #repository(id: number): Row {
    const { owner, name } = this.repos.get(id)!;
    return {
      id, name, full_name: `${owner}/${name}`, owner: { login: owner }, html_url: `https://github.com/${owner}/${name}`,
      description: null, visibility: "public", private: false, default_branch: "main",
    };
  }
}

class TestGitCache extends RpcTarget {
  async advertiseCommit(): Promise<void> {}
}

/** The Workshop's approval queue: records what each observation reports, or refuses it. */
class RecordingQueue extends RpcTarget {
  readonly observations: { title: string; subresources?: string[] }[] = [];
  /** The ordinals (1-based) of the observations to refuse, as the Workshop refusing their audience would. */
  readonly refuse = new Set<number>();
  #asked = 0;

  async authorizeObservation(observation: { title: string; subresources?: string[] }): Promise<void> {
    if (this.refuse.has(++this.#asked)) throw new Error("test: the audience was refused");
    this.observations.push({ title: observation.title, subresources: observation.subresources });
  }

  async submitAction(): Promise<void> {}

  async getGitCache(): Promise<TestGitCache> {
    return new TestGitCache();
  }
}

/** A connected account whose token is `token`. */
async function account(token: string): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("accessToken", token);
  });
  return id.toString();
}

let scenarios = 0;

/**
 * A binding of `octo/repo` by the owner's account; with `pinned`, as an earlier read left it, its
 * repository's id already stored.
 */
async function binding(options: { pinned?: boolean } = {}) {
  const scenario = `observers-${++scenarios}`;
  const props: GatekeeperProps = {
    userObjectId: await account("owner-token"), resourceKind: "repo", owner: OWNER, repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  if (options.pinned) await hooks.seedGatekeeper(scenario, props, { repoId: REPO_ID });
  const queue = new RecordingQueue();
  return {
    /** The binding owner's account. */
    owner: props.userObjectId,
    queue,
    read: (calls: SessionCall[], drain = false) =>
      hooks.sessionRead(scenario, props, new RpcStub(queue) as never, calls, drain),
    pages: (calls: SessionCall[]) => hooks.sessionPages(scenario, props, new RpcStub(queue) as never, calls),
    /** Writes `entries` into the binding's storage, then restarts it, as an upgrade would. */
    upgradeFrom: async (entries: Record<string, unknown>) => {
      await hooks.seedGatekeeper(scenario, props, entries);
      await hooks.restartGatekeeper(scenario);
    },
    /** gitPull of HEAD; the transfer's status once drained, or the pull's error. */
    pull: async (): Promise<{ ok: unknown } | { error: string }> => {
      const outcome = await hooks.gitPull(scenario, props, [HEAD], PULL_OPTIONS);
      if ("error" in outcome) return outcome;
      using transfer = outcome.ok as unknown as RpcStub<GitPullTransfer>;
      await new Response(await transfer.stream()).arrayBuffer();
      return { ok: await transfer.status() };
    },
    /** verifyObserverAccess for observers named by id, each with the account given. */
    verify: (observers: Record<string, string>, subresources = [SUBRESOURCE]) => hooks.verifyObservers(
      scenario, props, Object.entries(observers).map(([id, userObjectId]) => ({ id, userObjectId })), subresources),
    admit: (userObjectId: string) => hooks.addObserver(scenario, props, userObjectId),
  };
}

const rateLimited = () => Response.json({ message: "API rate limit exceeded for user ID 9." },
  { status: 403, headers: { "x-ratelimit-remaining": "0" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reads", () => {
  it("report the pinned repository by its id, whatever served them", async () => {
    const github = new FakeGitHub();
    github.issues = [1, 2];
    const gk = await binding();

    // The first read pins the repository's id, by its name, before anything is disclosed.
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: { fullName: "octo/repo" } });
    // Served from the cache, without asking GitHub again.
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: { fullName: "octo/repo" } });
    expect(github.requestsWith("owner-token")).toEqual([`/repos/${OWNER}/${REPO}`, `/repositories/${REPO_ID}`]);
    // Every page of a listing as it leaves, one served from the buffer of an earlier fetch
    // included; the listing's end, after them, discloses nothing more.
    expect(await gk.read([{ method: "listIssues", args: [{ resultsPerPage: 1 }] }], true))
      .toMatchObject({ ok: [{ id: "1" }, { id: "2" }] });
    // A listing that finds nothing answers too.
    expect(await gk.read([{ method: "listIssues", args: [{ state: "closed" }] }], true)).toEqual({ ok: [] });
    // CI, through the stub opening a workflow run returns.
    expect(await gk.read([{ method: "getWorkflowRun", args: ["900"] }, { method: "listJobs" }], true))
      .toMatchObject({ ok: [{ id: "71" }, { id: "72" }] });
    expect(await gk.read([{ method: "getWorkflowRun", args: ["900"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: { id: "900" } });

    expect(gk.queue.observations).toEqual([
      { title: "Read repository metadata for octo/repo", subresources: [SUBRESOURCE] },
      { title: "Read repository metadata for octo/repo", subresources: [SUBRESOURCE] },
      { title: "List issues", subresources: [SUBRESOURCE] },
      { title: "List issues (page 2)", subresources: [SUBRESOURCE] },
      { title: "List issues", subresources: [SUBRESOURCE] },
      { title: "List jobs of workflow run #900", subresources: [SUBRESOURCE] },
      { title: "Read workflow run CI #900", subresources: [SUBRESOURCE] },
    ]);
  });

  it("authorize each page of a listing as it leaves, a refused one ending the listing", async () => {
    const github = new FakeGitHub();
    github.issues = [1, 2];
    const gk = await binding({ pinned: true });
    gk.queue.refuse.add(2);

    // The second page is refused, and so is the retry; a new listing goes through.
    expect(await gk.pages([{ method: "listIssues", args: [{ resultsPerPage: 1 }] }]))
      .toEqual({ error: expect.stringContaining("audience was refused") });
    expect(await gk.read([{ method: "listIssues", args: [{ resultsPerPage: 1 }] }], true))
      .toMatchObject({ ok: [{ id: "1" }, { id: "2" }] });
    expect(gk.queue.observations.map(observation => observation.title))
      .toEqual(["List issues", "List issues", "List issues (page 2)"]);
  });

  it("returns the pinned repository's current identity after a rename, transfer, and name reuse", async () => {
    const github = new FakeGitHub();
    github.issues = [1];
    github.pulls = [2];
    const gk = await binding({ pinned: true });
    github.repos.set(REPO_ID, { owner: "acme", name: "renamed" });
    github.repos.set(OTHER_ID, { owner: OWNER, name: REPO });
    const repository = {
      owner: "acme", name: "renamed", fullName: "acme/renamed", url: "https://github.com/acme/renamed",
    };
    const expectedIssue = { id: "1", repo: repository, url: "https://github.com/acme/renamed/issues/1" };

    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: repository });
    expect(await gk.read([{ method: "getIssue", args: ["1"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: expectedIssue });
    expect(await gk.read([{ method: "listIssues" }], true)).toMatchObject({ ok: [expectedIssue] });
    // Search names a repository only by name, so it is asked by the one the id has now.
    expect(await gk.read([{ method: "searchIssues", args: [{ text: "crash" }] }], true))
      .toMatchObject({ ok: [expectedIssue] });
    const expectedPull = {
      id: "2", repo: repository, url: "https://github.com/acme/renamed/pull/2",
      head: { repo: repository }, base: { repo: repository },
    };
    expect(await gk.read([{ method: "getPullRequest", args: ["2"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: expectedPull });
    expect(await gk.read([{ method: "listPullRequests" }], true)).toMatchObject({ ok: [expectedPull] });
    expect(await gk.read([{ method: "searchPullRequests", args: [{ text: "Issue" }] }], true))
      .toMatchObject({ ok: [expectedPull] });
    // A simulated issue must identify the repository its approval will create it in too.
    expect(await gk.read([
      { method: "createIssue", args: [{ title: "A new issue" }] }, { method: "getDetails" },
    ])).toMatchObject({ ok: { repo: repository, url: "https://github.com/acme/renamed/issues/~1" } });
    expect(github.requests.find(request => request.path === "/search/issues")?.query.get("q"))
      .toContain("repo:acme/renamed");
    expect(github.requests.filter(request => request.path.startsWith("/repos/"))).toEqual([]);
  });

  it("disclose nothing once the repository is deleted and another takes its name", async () => {
    const github = new FakeGitHub();
    github.issues = [1];
    const gk = await binding({ pinned: true });
    github.repos.delete(REPO_ID);
    github.repos.set(OTHER_ID, { owner: OWNER, name: REPO });

    expect(await gk.read([{ method: "getMetadata" }])).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "listIssues" }], true)).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "searchIssues", args: [{ text: "crash" }] }], true))
      .toEqual({ error: expect.any(String) });
    expect(gk.queue.observations).toEqual([]);
    // Never asked of the repository the name now names, by that name or its id.
    expect(github.requests.filter(request => request.path !== `/repositories/${REPO_ID}`
      && !request.path.startsWith(`/repositories/${REPO_ID}/`))).toEqual([]);
  });

  it("pull git by the name the repository's id has now, and never by a name it left", async () => {
    const github = new FakeGitHub();
    const gk = await binding({ pinned: true });
    github.repos.set(REPO_ID, { owner: "acme", name: "renamed" });
    expect(await gk.pull()).toEqual({ ok: { state: "complete" } });
    expect(github.gitRequests).toEqual(["acme/renamed"]);

    // Deleted, and its old names taken by another repository: nothing is asked of either.
    github.repos.delete(REPO_ID);
    github.repos.set(OTHER_ID, { owner: "acme", name: "renamed" });
    expect(await gk.pull()).toEqual({ error: expect.any(String) });
    expect(github.gitRequests).toEqual(["acme/renamed"]);
  });

  it("refuse a git answer if the repository was renamed before it arrived", async () => {
    const github = new FakeGitHub();
    const gk = await binding({ pinned: true });
    // Renamed as the request reaches GitHub: the name it was sent to may name another repository.
    github.onGit = () => github.repos.set(REPO_ID, { owner: "acme", name: "renamed" });
    expect(await gk.pull()).toEqual({ error: expect.stringContaining("was renamed from octo/repo") });

    github.onGit = undefined;
    expect(await gk.pull()).toEqual({ ok: { state: "complete" } });
    expect(github.gitRequests).toEqual([`${OWNER}/${REPO}`, "acme/renamed"]);
  });

  it("serve nothing cached while the repository was read by name", async () => {
    const github = new FakeGitHub();
    github.issues = [1];
    const gk = await binding({ pinned: true });
    expect(await gk.read([{ method: "listIssues" }], true)).toMatchObject({ ok: [{ id: "1" }] });
    github.issues = [2];
    expect(await gk.read([{ method: "listIssues" }], true)).toMatchObject({ ok: [{ id: "1" }] });

    // As a release that addressed the repository by name left the binding: what it cached may
    // have come from another repository that had taken the name.
    await gk.upgradeFrom({ cachesByRepoId: false });
    expect(await gk.read([{ method: "listIssues" }], true)).toMatchObject({ ok: [{ id: "2" }] });
  });

  it("disclose nothing until the repository's id is pinned, then report it", async () => {
    const github = new FakeGitHub();
    github.probeStatus = 502;
    const gk = await binding();

    expect(await gk.read([{ method: "getMetadata" }])).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "listIssues" }], true)).toEqual({ error: expect.any(String) });
    expect(gk.queue.observations).toEqual([]);
    // Nothing was read in the meantime, by name or by any id.
    expect(github.requestsWith("owner-token")).toEqual([`/repos/${OWNER}/${REPO}`, `/repos/${OWNER}/${REPO}`]);

    github.probeStatus = undefined;
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: {} });
    expect(gk.queue.observations).toEqual([
      { title: "Read repository metadata for octo/repo", subresources: [SUBRESOURCE] },
    ]);
  });
});

describe("verifyObserverAccess", () => {
  it("allows an observer whose account can read the repository, by its id, and denies one that can't", async () => {
    const github = new FakeGitHub();
    const [alice, bob, sam] = await Promise.all([account("alice-token"), account("bob-token"), account("sam-token")]);
    github.readable.set("alice-token", new Set([REPO_ID]));
    // An organization's SAML enforcement keeps this token out of the repository.
    github.refusals.set("sam-token", () => Response.json(
      { message: "Resource protected by organization SAML enforcement." }, { status: 403 }));
    const gk = await binding();

    expect(await gk.verify({ alice, bob, sam })).toEqual({ ok: { allowedObserverIds: ["alice"] } });
    for (const token of ["alice-token", "bob-token", "sam-token"]) {
      expect(github.requestsWith(token)).toEqual([`/repositories/${REPO_ID}`]);
    }
    // The binding's own account was never asked: each observer is checked with their own.
    expect(github.requestsWith("owner-token")).toEqual([]);
  });

  it.each([
    ["a rate limit", rateLimited],
    ["an outage", () => Response.json({ message: "Server Error" }, { status: 500 })],
  ])("fails, denying no one for good, when %s keeps GitHub from answering", async (_, answer) => {
    const github = new FakeGitHub();
    const [alice, carol] = await Promise.all([account("alice-token"), account("carol-token")]);
    github.readable.set("alice-token", new Set([REPO_ID]));
    github.readable.set("carol-token", new Set([REPO_ID]));
    github.refusals.set("carol-token", answer);
    const gk = await binding();

    expect(await gk.verify({ alice, carol })).toEqual({ error: expect.any(String) });
    // Not remembered as a denial: once GitHub answers, carol is allowed.
    github.refusals.delete("carol-token");
    expect(await gk.verify({ alice, carol })).toEqual({ ok: { allowedObserverIds: ["alice", "carol"] } });
  });

  it("reuses an account's answer, a grant for 15 minutes and a denial for 15 seconds", async () => {
    const github = new FakeGitHub();
    const [alice, bob] = await Promise.all([account("alice-token"), account("bob-token")]);
    github.readable.set("alice-token", new Set([REPO_ID]));
    // Two bindings of the same repository share each account's answers.
    const [first, second] = [await binding(), await binding()];
    const start = Date.now();
    const at = (offset: number) => vi.setSystemTime(start + offset);
    const asked = (token: string) => github.requestsWith(token).length;

    expect(await first.verify({ alice, bob })).toEqual({ ok: { allowedObserverIds: ["alice"] } });
    at(14_000);
    expect(await second.verify({ alice, bob })).toEqual({ ok: { allowedObserverIds: ["alice"] } });
    expect([asked("alice-token"), asked("bob-token")]).toEqual([1, 1]);

    // Bob is given access, and alice loses hers.
    github.readable.set("bob-token", new Set([REPO_ID]));
    github.readable.delete("alice-token");
    at(16_000);
    expect(await first.verify({ alice, bob })).toEqual({ ok: { allowedObserverIds: ["alice", "bob"] } });
    // Each answer is dated from when GitHub was asked: alice's grant has expired, bob's not yet.
    at(15 * MINUTE + 1_000);
    expect(await first.verify({ alice, bob })).toEqual({ ok: { allowedObserverIds: ["bob"] } });
    expect([asked("alice-token"), asked("bob-token")]).toEqual([2, 2]);
  });

  it("serves no remembered answer once the account's credentials are confirmed dead", async () => {
    const github = new FakeGitHub();
    const alice = await account("alice-token");
    github.readable.set("alice-token", new Set([REPO_ID]));
    const gk = await binding();

    expect(await gk.verify({ alice })).toEqual({ ok: { allowedObserverIds: ["alice"] } });
    // GitHub rejects alice's token, and her account, which has no refresh token, records it dead.
    const aliceAccount = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(alice));
    expect(await aliceAccount.reportTokenRejected("alice-token")).toBe("expired");

    // Access can no longer be determined, so the check fails rather than reuse the grant.
    expect(await gk.verify({ alice })).toEqual({ error: expect.stringMatching(/expired|revoked/i) });
    expect(github.requestsWith("alice-token")).toEqual([`/repositories/${REPO_ID}`]);
  });

  it("keys answers by account, not observer, and asks again after the account reconnects", async () => {
    const github = new FakeGitHub();
    const [alice, bob] = await Promise.all([account("alice-token"), account("bob-token")]);
    github.readable.set("alice-token", new Set([REPO_ID]));
    const gk = await binding();

    expect(await gk.verify({ observer: alice })).toEqual({ ok: { allowedObserverIds: ["observer"] } });
    // The same observer, with another account's verifier.
    expect(await gk.verify({ observer: bob })).toEqual({ ok: { allowedObserverIds: [] } });

    // Alice's connection is replaced by one signed in as another GitHub user, who can't read it.
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(alice)), async (instance, state) => {
      await instance.commitReconnect(
        stageCredentials(state.storage.kv, { accessToken: "mallory-token", scopes: ["repo"] }, Date.now()));
    });
    expect(await gk.verify({ observer: alice })).toEqual({ ok: { allowedObserverIds: [] } });
    expect(github.requestsWith("mallory-token")).toContain(`/repositories/${REPO_ID}`);
  });

  it.each([
    "github/repo/42", "repo/042", "repo/abc", "repo/-1", "repo/0", "repo/9007199254740993", "repo/42/issue/7",
    "issue/42", "repo/4%32",
  ])("refuses the whole call for %s, asking no one", async id => {
    const github = new FakeGitHub();
    const alice = await account("alice-token");
    github.readable.set("alice-token", new Set([REPO_ID]));
    const gk = await binding();

    expect(await gk.verify({ alice }, [SUBRESOURCE, id])).toEqual({ error: expect.any(String) });
    expect(github.requests).toEqual([]);
  });
});

describe("addObserver", () => {
  it("requires the pinned repository by its id, and the one its name names, asked each time", async () => {
    const github = new FakeGitHub();
    const [alice, bob, carol] = await Promise.all([account("alice-token"), account("bob-token"), account("carol-token")]);
    const gk = await binding({ pinned: true });
    github.readable.set("alice-token", new Set([REPO_ID]));
    github.readable.set("bob-token", new Set([OTHER_ID]));
    github.readable.set("carol-token", new Set([REPO_ID]));
    github.refusals.set("carol-token", rateLimited);

    // Renamed: its old name redirects to it, so reading it is enough.
    github.repos.set(REPO_ID, { owner: OWNER, name: "moved" });
    github.formerNames.set(`${OWNER}/${REPO}`, REPO_ID);
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(github.requestsWith("alice-token").toSorted()).toEqual([
      `/repos/${OWNER}/${REPO}`, `/repos/${OWNER}/${REPO}`, `/repositories/${REPO_ID}`, `/repositories/${REPO_ID}`,
      `/repositories/${REPO_ID}`, `/repositories/${REPO_ID}`,
    ]);
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    // An answer that says nothing about access fails admission, as an error rather than a denial.
    expect(await gk.admit(carol)).toEqual({ error: expect.stringContaining("rate limit") });

    // Another repository takes the old name. A release that read by name may have read it, so an
    // observer must be able to read it too: alice no longer can, bob still can't read the pinned one.
    github.repos.set(OTHER_ID, { owner: OWNER, name: REPO });
    expect(await gk.admit(alice)).toEqual({ error: expect.stringContaining("does not have read access") });
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    github.readable.set("alice-token", new Set([REPO_ID, OTHER_ID]));
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
  });

  it("admits an observer on their own access by name while no id is stored, never asking the owner", async () => {
    // A binding not read since ids were pinned has read nothing by id, and its owner's grant may
    // have lapsed since; that must not keep out collaborators who can read the repository themselves.
    const github = new FakeGitHub();
    const [alice, bob] = await Promise.all([account("alice-token"), account("bob-token")]);
    github.readable.set("alice-token", new Set([REPO_ID]));
    const gk = await binding();
    const owner = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(gk.owner));
    expect(await owner.reportTokenRejected("owner-token")).toBe("expired");

    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    expect(github.requestsWith("alice-token")).toEqual([`/repos/${OWNER}/${REPO}`]);
    expect(github.requestsWith("owner-token")).toEqual([]);
  });
});
