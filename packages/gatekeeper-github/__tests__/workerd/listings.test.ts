// Issue and pull request listings and searches, driven against the real `GitHubGatekeeperImpl`
// Durable Object (via the TestHooks facet) with GitHub faked at the `fetch` boundary: walks that
// must not end on a page the overlay thinned out, a bounded PR text search, structured filters
// re-checked after the overlay, case-insensitive logins, the read cache's generation fence, and
// the session's page-size check.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubGatekeeperImpl } from "../../src/github";
import { GitHubRepoSessionImpl } from "../../src/github";
import type { GatekeeperProps, ListingMethod, Outcome } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

/** A REST response row, as JSON. */
type Row = Record<string, unknown>;

function issue(number: number, overrides: Row = {}): Row {
  return {
    number,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`,
    title: `Issue ${number}`,
    state: "open",
    body: "",
    user: { login: "someone" },
    labels: [],
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    comments: 0,
    ...overrides,
  };
}

/** A `GET /pulls` row: like GitHub's, it has no `comments`. */
function pull(number: number, overrides: Row = {}): Row {
  const { comments: _comments, ...row } = issue(number, {
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    draft: false,
    merged_at: null,
    head: { ref: `feature-${number}`, sha: "b".repeat(40), repo: null },
    base: { ref: "main", sha: "a".repeat(40), repo: null },
    ...overrides,
  });
  return row;
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

/** GitHub's REST API, answered from the test's tables; GET paths are logged with their page. */
class FakeGitHub {
  readonly issues = new Map<number, Row>();
  readonly pulls = new Map<number, Row>();
  /** Listing pages by path (`/issues`, `/pulls`, `/search/issues`), 1-based. */
  readonly pages = new Map<string, unknown[][]>();
  /** `"<path> p<page>"` listing fetches that fail once with a 502. */
  readonly failing = new Set<string>();
  readonly requests: string[] = [];
  /**
   * While set, a `GET /issues/{n}` stalls (answering with what it read on arrival) and is logged
   * in `stalled`. Polled rather than awaited: a promise settled from the test would carry the
   * test's I/O context into the gatekeeper's Durable Object.
   */
  stall = false;
  stalled = 0;

  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(new Request(input, init)));
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const path = url.pathname.startsWith("/repos/")
      ? url.pathname.slice(new URL(API_BASE).pathname.length)
      : url.pathname;
    this.requests.push(`${request.method} ${path}${url.searchParams.has("page") ? ` p${page}` : ""}`);

    if (path === "") {
      // Repo metadata, which also pins the repository id.
      return Response.json({
        id: 1, description: null, visibility: "public", private: false, default_branch: "main",
      });
    }
    if (path === "/user") return Response.json({ login: "ada" });
    if (this.failing.delete(`${path} p${page}`)) {
      return Response.json({ message: "Bad Gateway" }, { status: 502 });
    }
    const listing = this.pages.get(path);
    if (listing !== undefined) {
      const rows = listing[page - 1] ?? [];
      return Response.json(path === "/search/issues" ? { items: rows } : rows);
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(path);
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      if (request.method === "PATCH") {
        this.issues.set(number, { ...this.issues.get(number)!, ...await request.json<object>() });
        return Response.json(this.issues.get(number));
      }
      const body = this.issues.get(number);
      if (this.stall) {
        this.stalled++;
        while (this.stall) await scheduler.wait(1);
      }
      return Response.json(body);
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(path);
    if (pullMatch) {
      return Response.json({
        ...this.pulls.get(Number(pullMatch[1])),
        comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: 0,
        requested_reviewers: [], mergeable: null,
      });
    }
    throw new Error(`test: unexpected fetch ${request.method} ${request.url}`);
  }
}

class TestApprovalQueue extends RpcTarget {
  async authorizeObservation(): Promise<void> {}
  async submitAction(): Promise<void> {}
}

/** Stands in for the git cache an apply is handed; an issue edit's apply never calls it. */
class UnusedGitCache extends RpcTarget {}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

let nextScenario = 0;

async function repoGatekeeper() {
  const scenario = `listings-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(), resourceKind: "repo", owner: OWNER, repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    pages: async <T>(method: ListingMethod, query: unknown, pageSize = 100, calls?: number) =>
      await unwrap(hooks.listingPages(scenario, props, method, query, pageSize, calls)) as (T[] | null | string)[],
    all: async <T>(method: ListingMethod, query: unknown) =>
      (await unwrap(hooks.listingPages(scenario, props, method, query, 100)) as (T[] | null)[])
        .flatMap(page => page ?? []),
    queueEdit: (kind: "issue" | "pull", id: string, edit: { title: string } | { state: "open" | "closed" }) =>
      unwrap(hooks.queueEdit(scenario, props, new RpcStub(new TestApprovalQueue()) as never, kind, id, edit)),
    applyAction: (actionId: number) =>
      unwrap(hooks.applyAction(scenario, props, actionId, new RpcStub(new UnusedGitCache()) as never)),
    openIssue: (id: string) => unwrap(hooks.openIssue(scenario, props, id)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listing walks", () => {
  it("listIssues continues past a page that contains a pull request", async () => {
    const github = new FakeGitHub();
    github.pages.set("/issues", [
      range(1, 100).map(n => issue(n, n === 50 ? { pull_request: {} } : {})),
      [issue(101)],
    ]);
    const gk = await repoGatekeeper();

    const ids = (await gk.all<{ id: string }>("listIssues", undefined)).map(item => item.id);

    expect(ids).toHaveLength(100);
    expect(ids).not.toContain("50");
    expect(ids).toContain("101");
  });

  it("listPullRequests continues past a page with a touched row", async () => {
    const github = new FakeGitHub();
    github.pulls.set(5, pull(5));
    github.pages.set("/pulls", [range(1, 100).map(n => pull(n)), [pull(101)]]);
    const gk = await repoGatekeeper();
    await gk.queueEdit("pull", "5", { title: "Renamed" });

    const rows = await gk.all<{ id: string, title: string }>("listPullRequests", { state: "all" });

    expect(rows).toHaveLength(101);
    expect(rows.find(row => row.id === "5")?.title).toBe("Renamed");
    expect(rows.map(row => row.id)).toContain("101");
  });

  it("loses no rows when a fetch fails partway through a page", async () => {
    const github = new FakeGitHub();
    github.pages.set("/issues", [range(1, 100).map(n => issue(n)), range(101, 100).map(n => issue(n))]);
    github.failing.add("/issues p2");
    const gk = await repoGatekeeper();

    // The second call holds rows 61-100 when page 2's fetch fails; the retry still serves them.
    const pages = await gk.pages<{ id: string }>("listIssues", undefined, 60);
    expect(pages[1]).toContain("Bad Gateway");
    expect(pages.flatMap(page => Array.isArray(page) ? page.map(item => item.id) : []))
      .toEqual(range(1, 200).map(String));
  });
});

describe("pull request text search", () => {
  it("bounds each next() and still finds a match on a later page", async () => {
    const github = new FakeGitHub();
    github.pages.set("/pulls", range(0, 25).map(page => range(page * 100 + 1, 100)
      .map(n => pull(n, n === 1450 ? { body: "the NEEDLE is here" } : {}))));
    const gk = await repoGatekeeper();
    const fetched = () => github.requests.filter(request => request.startsWith("GET /pulls p"));

    // The first call spends its fetch window without a match: `[]`, not the end.
    expect(await gk.pages("searchPullRequests", { text: "needle" }, 50, 1)).toEqual([[]]);
    expect(fetched()).toHaveLength(10);

    const pages = await gk.pages<{ id: string }>("searchPullRequests", { text: "needle" }, 50);
    expect(pages.map(page => Array.isArray(page) ? page.map(item => item.id) : page))
      .toEqual([[], ["1450"], null]);
    // Pages 1-10 came from the cache; 26 is the empty page that ends the walk.
    expect(fetched()).toHaveLength(26);
  });
});

describe("filters", () => {
  it("matches a creator login case-insensitively", async () => {
    const github = new FakeGitHub();
    github.pages.set("/issues", [[
      issue(1, { user: { login: "octocat" } }),
      issue(2, { user: { login: "someone" } }),
    ]]);
    const gk = await repoGatekeeper();

    const ids = (await gk.all<{ id: string }>("listIssues", { author: "OctoCat" })).map(item => item.id);

    expect(ids).toEqual(["1"]);
  });

  it("excludes a queued close from a `state: open` issue search", async () => {
    const github = new FakeGitHub();
    github.issues.set(3, issue(3));
    github.pages.set("/search/issues", [[issue(3), issue(4)]]);
    const gk = await repoGatekeeper();
    await gk.queueEdit("issue", "3", { state: "closed" });

    const ids = (await gk.all<{ id: string }>("searchIssues", { text: "bug", state: "open" }))
      .map(item => item.id);

    expect(ids).toEqual(["4"]);
  });
});

describe("read cache", () => {
  it("does not cache a read that straddled an apply", async () => {
    const github = new FakeGitHub();
    github.issues.set(5, issue(5, { title: "Old" }));
    const gk = await repoGatekeeper();
    const actionId = await gk.queueEdit("issue", "5", { title: "New" });

    github.stall = true;
    const straddling = gk.openIssue("5");
    await vi.waitFor(() => expect(github.stalled).toBe(1));
    await gk.applyAction(actionId);
    github.stall = false;
    expect((await straddling).title).toBe("Old");

    expect((await gk.openIssue("5")).title).toBe("New");
  });
});

describe("session page size", () => {
  it("refuses a non-positive resultsPerPage", async () => {
    const gatekeeper = { listIssues: async () => ({ next: async () => null }) };
    using session = new GitHubRepoSessionImpl(
      gatekeeper as unknown as GitHubGatekeeperImpl,
      new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>);

    await expect(session.listIssues({ resultsPerPage: 0 })).rejects.toThrow(/resultsPerPage/);
  });
});
