import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApi,
  type GitHubIssueResponse,
} from "../src/github-api";
import {
  assertIssueSearchResultsInRepo,
  buildIssueSearchQuery,
} from "../src/github-search";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject<Env = unknown, Props = unknown> {
    ctx: { props: Props };
    env: Env;
    constructor(ctx: { props: Props }, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcStub: class RpcStub<T> { value?: T; constructor(value: T) { this.value = value; } },
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint<Env = unknown, Props = unknown> {
    ctx: { props: Props };
    env: Env;
    constructor(ctx: { props: Props }, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("capnweb-validate", () => ({
  skipRpcValidation: () => <T>(value: T): T => value,
  validateRpc: () => <T>(value: T): T => value,
}));

function issueAt(htmlUrl: string): Pick<GitHubIssueResponse, "html_url"> {
  return { html_url: htmlUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertIssueSearchResultsInRepo", () => {
  it("accepts exact repository path segments case-insensitively", () => {
    expect(() => assertIssueSearchResultsInRepo("Cloudflare", "Workerd", [
      issueAt("https://github.com/cloudflare/workerd/issues/1"),
    ])).not.toThrow();
  });

  it("rejects results from another repository", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/quiche/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("does not accept repository names that only share a prefix", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd-private/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("rejects pull requests returned by an injected search expression", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd/pull/1"),
    ])).toThrow("non-issue result");
  });

  it("rejects malformed and non-GitHub result URLs", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("not a URL"),
    ])).toThrow("outside the connected repository");
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://example.com/cloudflare/workerd/issues/1"),
    ])).toThrow("outside the connected repository");
  });
});

describe("buildIssueSearchQuery", () => {
  it("builds a benign literal phrase search with structured filters", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "durable objects",
      state: "open",
      labels: ["bug"],
      author: "jasnell",
    })).toBe(
      '"durable objects" repo:cloudflare/workerd is:issue state:open label:"bug" author:"jasnell"',
    );
  });

  it("quotes every caller-controlled query fragment", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "repo:cloudflare/quiche OR scheduler",
      author: "jasnell OR repo:cloudflare/quiche",
      assignee: "octocat OR repo:cloudflare/quiche",
    })).toBe(
      '"repo:cloudflare/quiche OR scheduler" repo:cloudflare/workerd is:issue '
      + 'author:"jasnell OR repo:cloudflare/quiche" assignee:"octocat OR repo:cloudflare/quiche"',
    );
  });

  it("escapes quotes inside plain search text", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: 'bug" OR repo:cloudflare/quiche OR "',
    })).toBe('"bug\\" OR repo:cloudflare/quiche OR \\"" repo:cloudflare/workerd is:issue');
  });
});

describe("GitHubApi.searchIssuesConditional", () => {
  it("enables GitHub advanced search parsing", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(String(input));
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const api = new GitHubApi(async () => "test-token");
    await api.searchIssuesConditional(
      "repo:cloudflare/quiche OR repo:cloudflare/workerd is:issue",
      1,
      100,
    );

    expect(requestUrl?.searchParams.get("advanced_search")).toBe("true");
  });
});

describe("GitHubGatekeeperImpl.startSession", () => {
  it("keeps Totango domain-sharing sessions on an owned duplicate approval queue", async () => {
    const { GitHubGatekeeperImpl } = await import("../src/github");
    const observations: unknown[] = [];
    let originalDisposed = false;
    let duplicateDisposed = false;
    const duplicateQueue = {
      dup: vi.fn(() => duplicateQueue),
      authorizeObservation: vi.fn(async (description: unknown) => {
        if (originalDisposed) observations.push(description);
      }),
      getSessionSurface: vi.fn(async () => "code" as const),
      submitAction: vi.fn(),
      bindHook: vi.fn(),
      [Symbol.dispose]: vi.fn(() => { duplicateDisposed = true; }),
    };
    const borrowedQueue = {
      dup: vi.fn(() => duplicateQueue),
      authorizeObservation: vi.fn(async () => {
        throw new Error("borrowed queue used after disposal");
      }),
      getSessionSurface: vi.fn(async () => "code" as const),
      submitAction: vi.fn(),
      bindHook: vi.fn(),
      [Symbol.dispose]: vi.fn(() => { originalDisposed = true; }),
    };
    const gatekeeper = new GitHubGatekeeperImpl({
      props: { userObjectId: "account", resourceKind: "repo", owner: "totango", repo: "app" },
      storage: { kv: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(() => []) } },
      exports: {},
    } as never, {} as never);

    const session = await gatekeeper.startSession(borrowedQueue as never) as {
      listTools(): Promise<unknown>;
      [Symbol.dispose](): void;
    };
    borrowedQueue[Symbol.dispose]();
    expect(originalDisposed).toBe(true);
    await expect(session.listTools()).resolves.toEqual(expect.any(Array));
    expect(borrowedQueue.authorizeObservation).not.toHaveBeenCalled();
    expect(duplicateQueue.authorizeObservation).toHaveBeenCalledOnce();
    expect(duplicateDisposed).toBe(false);
    session[Symbol.dispose]();

    expect(borrowedQueue.dup).toHaveBeenCalledOnce();
    expect(observations).toEqual([expect.objectContaining({
      domainSharingPolicy: { type: "verified-sso-email-domain", emailDomain: "totango.com" },
    })]);
    expect(duplicateDisposed).toBe(true);
  });
});
