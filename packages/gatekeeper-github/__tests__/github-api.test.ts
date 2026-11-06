import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApi,
  exchangeAuthCode,
  revokeOAuthToken,
  type GitHubIssueResponse,
} from "../src/github-api";
import {
  assertIssueSearchResultsInRepo,
  buildIssueSearchQuery,
} from "../src/github-search";
import { githubInstance, type Env } from "../src/github-env";
import { parseRepoSubresource, repoSubresourceId } from "../src/repo-subresources";

function issueAt(htmlUrl: string): Pick<GitHubIssueResponse, "html_url"> {
  return { html_url: htmlUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub Enterprise endpoints", () => {
  const instance = githubInstance({ GITHUB_URL: "https://git.example.com", GITHUB_API_URL: "https://api.example.com" } as Env);

  it("sends REST, GraphQL, git and OAuth requests to the worker origin", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      if (req.url.endsWith("/login/oauth/access_token")) {
        return Response.json({ access_token: "oauth-token", token_type: "bearer", scope: "repo" });
      }
      if (req.url.endsWith("/api/graphql")) return Response.json({ data: { viewer: { login: "octo" } } });
      return Response.json({ id: 42 });
    }));
    const api = new GitHubApi(async () => "token", { instance, repo: { owner: "acme", repo: "app", id: 42 } });
    await api.getRepo("acme", "app");
    await api.graphql("query { viewer { login } }", {});
    await api.fetchGitUploadPack("acme", "app", new Uint8Array());
    await exchangeAuthCode("code", "client", "secret", "https://workshop.example/oauth", instance);
    expect(requests.map(r => r.url)).toEqual([
      "https://api.example.com/api/v3/repositories/42", "https://api.example.com/api/graphql",
      "https://api.example.com/acme/app.git/git-upload-pack", "https://api.example.com/login/oauth/access_token",
    ]);
    expect(requests[0].headers.get("authorization")).toBe("Bearer token");
  });

  it("follows only same-instance repository-root redirects under the Enterprise REST prefix", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return requests.length === 1
        ? new Response(null, { status: 301, headers: { location: "https://git.example.com/api/v3/repositories/42" } })
        : Response.json({ id: 42 });
    }));
    await new GitHubApi(async () => "token", { instance }).getRepo("acme", "old");
    expect(requests).toEqual(["https://api.example.com/api/v3/repos/acme/old", "https://api.example.com/api/v3/repositories/42"]);
  });

  it("never follows a repository redirect outside the configured instance", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 301,
      headers: { location: "https://attacker.example/api/v3/repositories/42" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(new GitHubApi(async () => "token", { instance }).getRepo("acme", "old")).rejects.toThrow(/not followed/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("keeps repository observation IDs distinct across GitHub instances", () => {
  const enterprise = repoSubresourceId(42, "https://git.example.com");
  expect(parseRepoSubresource(enterprise, "https://git.example.com")).toBe(42);
  expect(repoSubresourceId(42)).toBe("repo/42");
  expect(() => parseRepoSubresource(enterprise, "https://elsewhere.example.com")).toThrow();
  expect(() => parseRepoSubresource("repo/42", "https://git.example.com")).toThrow();
  expect(() => parseRepoSubresource(enterprise)).toThrow();
});

describe("assertIssueSearchResultsInRepo", () => {
  it("validates search results against the configured enterprise origin", () => {
    const origin = "https://git.example.com";
    expect(() => assertIssueSearchResultsInRepo("acme", "repo", [issueAt(`${origin}/acme/repo/issues/1`)], origin)).not.toThrow();
    expect(() => assertIssueSearchResultsInRepo("acme", "repo", [issueAt("https://github.com/acme/repo/issues/1")], origin)).toThrow();
  });
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

function captureRequests(body: unknown = []): () => URL {
  let requestUrl: URL | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    requestUrl = new URL(String(input));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }));
  return () => {
    if (!requestUrl) throw new Error("no request was made");
    return requestUrl;
  };
}

describe("GitHubApi git reads", () => {
  it("encodes commit refs into the lookup path", async () => {
    const url = captureRequests({});
    const api = new GitHubApi(async () => "test-token");
    await api.getCommitConditional("cloudflare", "workerd", "feature/thing");
    expect(url().pathname).toBe("/repos/cloudflare/workerd/commits/feature%2Fthing");
  });

  it("requests the bare sha media type from the commit sha lookup", async () => {
    let accept: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      accept = new Headers(init?.headers).get("Accept");
      expect(new URL(String(input)).pathname).toBe("/repos/cloudflare/workerd/commits/feature%2Fthing");
      return new Response("a".repeat(40), {
        headers: { "content-type": "application/vnd.github.sha" },
      });
    }));

    const api = new GitHubApi(async () => "test-token");
    const result = await api.getCommitShaConditional("cloudflare", "workerd", "feature/thing");
    expect(accept).toBe("application/vnd.github.sha");
    expect(result).toMatchObject({ status: 200, data: "a".repeat(40) });
  });

  it("pages a metadata-only compare past the files-bearing first page", async () => {
    const url = captureRequests({
      base_commit: { sha: "a".repeat(40) },
      merge_base_commit: { sha: "b".repeat(40) },
      total_commits: 0,
    });
    const api = new GitHubApi(async () => "test-token");
    await api.compareBranches("cloudflare", "workerd", "main", "feature", { perPage: 1, page: 2 });
    expect(url().pathname).toBe("/repos/cloudflare/workerd/compare/main...feature");
    expect(Object.fromEntries(url().searchParams)).toEqual({ per_page: "1", page: "2" });

    // An unpaged compare adds no query parameters (paging would drop its files array).
    await api.compareBranches("cloudflare", "workerd", "main", "feature");
    expect([...url().searchParams]).toEqual([]);
  });

  it("passes history filters to the commit list endpoint", async () => {
    const url = captureRequests();
    const api = new GitHubApi(async () => "test-token");
    await api.listCommitsConditional("cloudflare", "workerd", {
      sha: "main",
      path: "src/workerd",
      author: "kentonv",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      per_page: 100,
      page: 2,
    });
    expect(url().pathname).toBe("/repos/cloudflare/workerd/commits");
    expect(Object.fromEntries(url().searchParams)).toEqual({
      sha: "main",
      path: "src/workerd",
      author: "kentonv",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      per_page: "100",
      page: "2",
    });
  });

  it("passes the protected filter to the branch list endpoint, omitting it when unset", async () => {
    const url = captureRequests();
    const api = new GitHubApi(async () => "test-token");
    await api.listBranchesConditional("cloudflare", "workerd", { protected: true, per_page: 100, page: 1 });
    expect(url().pathname).toBe("/repos/cloudflare/workerd/branches");
    expect(url().searchParams.get("protected")).toBe("true");

    await api.listBranchesConditional("cloudflare", "workerd", { per_page: 100, page: 1 });
    expect(url().searchParams.has("protected")).toBe(false);
  });

  it("addresses pull request commits by pull number", async () => {
    const url = captureRequests();
    const api = new GitHubApi(async () => "test-token");
    await api.listPullRequestCommitsConditional("cloudflare", "workerd", 42, 3, 50);
    expect(url().pathname).toBe("/repos/cloudflare/workerd/pulls/42/commits");
    expect(Object.fromEntries(url().searchParams)).toEqual({ page: "3", per_page: "50" });
  });

  it("reads a branch of an empty repository, which GitHub answers with 409, as missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ message: "Git Repository is empty." }, { status: 409 })));
    const api = new GitHubApi(async () => "test-token");
    expect(await api.getBranchHead("cloudflare", "workerd", "main")).toBeNull();
  });

  it("refuses a branch name that would climb out of the repository, before any request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const api = new GitHubApi(async () => "test-token");
    await expect(api.getBranchHead("cloudflare", "workerd", "../../../../../../repos/victim/secret/git/ref/heads/main"))
      .rejects.toThrow("invalid branch name");
    await expect(api.isBranchProtected("cloudflare", "workerd", "../../../../../../repos/victim/secret/branches/main"))
      .rejects.toThrow("invalid branch name");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GitHubApi.isBranchProtected", () => {
  const api = () => new GitHubApi(async () => "test-token");
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));

  it("reads the branch's protected flag, encoding the name segment by segment", async () => {
    const url = captureRequests({ name: "release/1.0", commit: { sha: "a".repeat(40) }, protected: true });
    expect(await api().isBranchProtected("cloudflare", "workerd", "release/1.0")).toBe(true);
    expect(url().pathname).toBe("/repos/cloudflare/workerd/branches/release/1.0");
  });

  it("reads an unprotected branch as unprotected", async () => {
    answer(200, { name: "feature", commit: { sha: "a".repeat(40) }, protected: false });
    expect(await api().isBranchProtected("cloudflare", "workerd", "feature")).toBe(false);
  });

  it("reads a missing branch, or any branch of an empty repository, as unprotected", async () => {
    answer(404, { message: "Branch not found" });
    expect(await api().isBranchProtected("cloudflare", "workerd", "feature")).toBe(false);
    answer(409, { message: "Git Repository is empty." });
    expect(await api().isBranchProtected("cloudflare", "workerd", "main")).toBe(false);
  });

  it("reads a renamed branch's old name, which GitHub redirects, as protected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 301, headers: { location: "https://api.github.com/repos/cloudflare/workerd/branches/main" },
    })));
    expect(await api().isBranchProtected("cloudflare", "workerd", "master")).toBe(true);
  });

  it("fails on any other error rather than guessing", async () => {
    answer(502, { message: "Bad Gateway" });
    await expect(api().isBranchProtected("cloudflare", "workerd", "main")).rejects.toMatchObject({ status: 502 });
  });
});

describe("GitHubApi redirects", () => {
  const pin = { owner: "octo", repo: "repo", id: 42 };

  /**
   * Answers the first request with `status` to `location`, and later ones with `{}`. A request
   * that would let fetch follow the redirect itself fails, since real fetch would follow it.
   */
  function redirectOnce(status: number, location: string) {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect !== "manual") throw new Error("fetch would follow the redirect");
      requests.push({ url: String(input), method: init.method, body: init.body });
      return requests.length === 1
        ? new Response(null, { status, headers: { location } })
        : new Response("{}", { headers: { "content-type": "application/json" } });
    }));
    return requests;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  }

  it("sends a pinned repository's requests to its id, with the same method, body and query", async () => {
    const requests: Array<[string | undefined, string, unknown]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push([init?.method, String(input), init?.body]);
      return Response.json({});
    }));
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    await api.addLabels("octo", "repo", 5, ["bug"]);
    await api.listIssuesConditional("octo", "repo", { state: "open", per_page: 10, page: 2 });

    expect(requests.map(([method, url]) => [method, url])).toEqual([
      ["POST", "https://api.github.com/repositories/42/issues/5/labels"],
      ["GET", "https://api.github.com/repositories/42/issues?state=open&per_page=10&page=2"],
    ]);
    expect(JSON.parse(String(requests[0][2]))).toEqual({ labels: ["bug"] });
  });

  it("sends a path outside the pinned repository as it is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    await api.getRepo("octo", "repository");
    await api.getViewerConditional();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.github.com/repos/octo/repository", "https://api.github.com/user",
    ]);
  });

  it.each([
    ["another repository's id", "https://api.github.com/repositories/43/issues/5"],
    ["a name-form issue transfer", "https://api.github.com/repos/octo/private/issues/5"],
    ["another origin", "https://evil.example/elsewhere"],
    ["a different path", "https://api.github.com/repositories/42/issues/6"],
  ])("refuses a redirect to %s without disclosing it", async (_name, location) => {
    const requests = redirectOnce(301, location);
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    const error = await rejection(api.getIssue("octo", "repo", 5));

    expect(error).toMatchObject({ name: "GitHubApiError", status: 301 });
    expect(String((error as Error).message)).not.toContain(new URL(location).pathname);
    expect(requests).toHaveLength(1);
  });

  it("does not turn a redirected POST into a GET", async () => {
    const requests = redirectOnce(301, "https://api.github.com/repos/octo/other/issues/9/labels");
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    expect(await rejection(api.addLabels("octo", "repo", 5, ["bug"])))
      .toMatchObject({ status: 301 });
    expect(requests.map(r => r.method)).toEqual(["POST"]);
  });

  it("refuses every redirect beneath a repository root without a pin", async () => {
    const requests = redirectOnce(301, "https://api.github.com/repositories/42/issues/5");
    const api = new GitHubApi(async () => "test-token");
    expect(await rejection(api.getIssue("octo", "repo", 5))).toMatchObject({ status: 301 });
    expect(requests).toHaveLength(1);
  });

  it("follows an unpinned repository root's redirect to its id", async () => {
    const requests = redirectOnce(301, "https://api.github.com/repositories/42");
    await new GitHubApi(async () => "test-token").getRepo("octo", "repo");
    expect(requests.map(r => r.url)).toEqual([
      "https://api.github.com/repos/octo/repo",
      "https://api.github.com/repositories/42",
    ]);
  });

  it.each([
    ["a name", "https://api.github.com/repos/octo/elsewhere"],
    ["another origin", "https://evil.example/repositories/42"],
    ["a path beneath an id", "https://api.github.com/repositories/42/issues/5"],
  ])("refuses an unpinned repository root's redirect to %s", async (_name, location) => {
    const requests = redirectOnce(301, location);
    expect(await rejection(new GitHubApi(async () => "test-token").getRepo("octo", "repo")))
      .toMatchObject({ status: 301 });
    expect(requests).toHaveLength(1);
  });

  it("never reads a refused redirect as a missing branch", async () => {
    redirectOnce(301, "https://api.github.com/repositories/43/git/ref/heads/main");
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    expect(await rejection(api.getBranchHead("octo", "repo", "main"))).toMatchObject({ status: 301 });
  });

  it("follows no redirect from a pinned repository's id, even to the same path", async () => {
    const requests = redirectOnce(301, "https://api.github.com/repositories/42/issues/5");
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    expect(await rejection(api.getIssue("octo", "repo", 5))).toMatchObject({ status: 301 });
    expect(requests).toHaveLength(1);
  });

  it("refuses a second hop from a followed redirect", async () => {
    const location = "https://api.github.com/repositories/42";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 301, headers: { location } })));
    expect(await rejection(new GitHubApi(async () => "test-token").getRepo("octo", "repo")))
      .toMatchObject({ status: 301 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirected git push", async () => {
    const requests = redirectOnce(301, "https://github.com/octo/other.git/git-receive-pack");
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    expect(await rejection(api.fetchGitReceivePack("octo", "repo", new Blob(["x"]).stream())))
      .toMatchObject({ status: 301 });
    expect(requests).toHaveLength(1);
  });

  it("still returns a conditional read's 304", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    const api = new GitHubApi(async () => "test-token", { repo: pin });
    expect(await api.getIssueConditional("octo", "repo", 5, { ifNoneMatch: "\"etag\"" }))
      .toMatchObject({ status: 304 });
  });
});

describe("GitHubApi.listRepoWebhooks", () => {
  it("lists every page of a repository's webhooks", async () => {
    const pages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      pages.push(url.searchParams.get("page") ?? "");
      const count = url.searchParams.get("page") === "1" ? 100 : 1;
      const offset = url.searchParams.get("page") === "1" ? 0 : 100;
      return Response.json(Array.from({ length: count }, (_, i) => ({ id: offset + i, config: { url: "https://x.test/" } })));
    }));

    const webhooks = await new GitHubApi(async () => "test-token").listRepoWebhooks(7);
    expect(webhooks).toHaveLength(101);
    expect(pages).toEqual(["1", "2"]);
  });
});

describe("revokeOAuthToken", () => {
  it("revokes only the given token, never the whole grant", async () => {
    // `/applications/{id}/grant` would revoke every token the user holds for the app, taking a
    // working connection down with the duplicate or abandoned one being dropped.
    let requestUrl: URL | undefined;
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      requestUrl = new URL(String(input));
      init = options;
      return new Response(null, { status: 204 });
    }));

    await revokeOAuthToken("gho_token", "client/id", "client-secret");

    expect(init?.method).toBe("DELETE");
    expect(requestUrl?.pathname).toBe("/applications/client%2Fid/token");
    expect(JSON.parse(String(init?.body))).toEqual({ access_token: "gho_token" });
    expect(new Headers(init?.headers).get("Authorization"))
      .toBe(`Basic ${btoa("client/id:client-secret")}`);
  });
});
