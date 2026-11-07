// gitlab-code-search-api.ts: how a query is encoded for each engine, what one page's request
// carries for each scope, how the engine GitLab says ran is held to the one asked for, and how
// GitLab's failures become fixed, agent-safe errors. GitLab is faked at `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabApi, GitLabApiError, type GitLabInstance } from "../src/gitlab-api";
import {
  CODE_SEARCH_ERROR_MESSAGES, GitLabCodeSearchError, encodeSearchText, resolveGroupId, searchCodePage,
  type CodeSearchEngine, type CodeSearchScope,
} from "../src/gitlab-code-search-api";

const INSTANCE: GitLabInstance = { apiOrigin: "https://gitlab.example.com", headers: {} };
const api = () => new GitLabApi(INSTANCE, async () => "tok-1");

type Call = { url: URL; method: string };

/** Answers every fetch with `respond`; returns the recorded calls. */
function fakeFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), method: init.method ?? "GET" };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200, headers: { "content-type": "application/json", ...init.headers },
  });
}

const row = (projectId: number, path: string, startline: number) => ({
  basename: path, data: `match in ${path}`, filename: path, id: null, path, project_id: projectId, ref: "main", startline,
});

/** A results page as GitLab sends it, run by `engine`. */
const results = (engine: string, rows: unknown[], headers: Record<string, string> = {}) =>
  json(rows, { headers: { "x-search-type": engine, "x-next-page": "", ...headers } });

const options = { page: 1, perPage: 20 };

async function failure(promise: Promise<unknown>): Promise<GitLabCodeSearchError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitLabCodeSearchError);
  return error as GitLabCodeSearchError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodeSearchText", () => {
  it("passes text verbatim to Zoekt and basic search", () => {
    for (const engine of ["zoekt", "basic"] as const) {
      expect(encodeSearchText({ text: 'a.b("x") -y' }, engine)).toBe('a.b("x") -y');
    }
  });

  it("escapes every simple_query_string special character for advanced search", () => {
    expect(encodeSearchText({ text: "foo.bar(baz)" }, "advanced")).toBe("foo\\.bar\\(baz\\)");
    expect(encodeSearchText({ text: "multi word -x" }, "advanced")).toBe("multi word \\-x");
    const specials = '\\"~|+-*()[]{}.^$?/=,<>&:!#';
    expect(encodeSearchText({ text: specials }, "advanced"))
      .toBe([...specials].map(character => `\\${character}`).join(""));
  });

  it("appends the shared filters on every engine, and the language on Zoekt only", () => {
    const filters = { text: "needle", path: "docs/", filename: "*.md", extension: ".md", language: "ruby" } as const;
    expect(encodeSearchText(filters, "zoekt")).toBe("needle path:docs/ filename:*.md extension:md lang:ruby");
    expect(encodeSearchText({ ...filters, language: undefined }, "advanced"))
      .toBe("needle path:docs/ filename:*.md extension:md");
    expect(encodeSearchText({ text: "needle", path: "" }, "basic")).toBe("needle");
  });

  it("rejects empty text and filter values that would split into search terms", () => {
    expect(() => encodeSearchText({ text: "  " }, "zoekt")).toThrow(GitLabCodeSearchError);
    expect(() => encodeSearchText({ text: "x", path: "my docs/" }, "zoekt")).toThrow(/must not contain spaces/);
    expect(() => encodeSearchText({ text: "x", filename: "a\tb" }, "basic")).toThrow(/must not contain spaces/);
  });
});

describe("searchCodePage requests", () => {
  it.each<[CodeSearchScope, string]>([
    [{ kind: "instance" }, "/api/v4/search"],
    [{ kind: "group", groupId: 9 }, "/api/v4/groups/9/search"],
    [{ kind: "project", projectId: 42 }, "/api/v4/projects/42/search"],
  ])("sends %j to %s, with search_type and regex on Zoekt", async (scope, path) => {
    const calls = fakeFetch(() => results("zoekt", []));
    await searchCodePage(api(), scope, "zoekt", { text: "needle" }, { ...options, ref: "main", includeArchived: true });
    const { url } = calls[0];
    expect(url.pathname).toBe(path);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      scope: "blobs", search: "needle", search_type: "zoekt", regex: "false", page: "1", per_page: "20",
    });
    // `ref` only applies to a project, `include_archived` only beyond one.
    expect(params.ref).toBe(scope.kind === "project" ? "main" : undefined);
    expect(params.include_archived).toBe(scope.kind === "project" ? undefined : "true");
  });

  it("sends regex=true when asked, and never sends regex to the other engines", async () => {
    const calls = fakeFetch(call => results(call.url.searchParams.get("search_type")!, []));
    await searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "a.*b", regex: true }, options);
    await searchCodePage(api(), { kind: "project", projectId: 1 }, "advanced", { text: "a" }, options);
    await searchCodePage(api(), { kind: "project", projectId: 1 }, "basic", { text: "a" }, options);
    expect(calls.map(call => call.url.searchParams.get("regex"))).toEqual(["true", null, null]);
  });

  it("sends a language with symbols in its name intact", async () => {
    const calls = fakeFetch(() => results("zoekt", []));
    await searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "x", language: "c++" }, options);
    await searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "x", language: "c#" }, options);
    expect(calls.map(call => call.url.searchParams.get("search"))).toEqual(["x lang:c++", "x lang:c#"]);
  });

  it.each<[CodeSearchEngine, object]>([
    ["basic", { regex: true }], ["advanced", { regex: true }], ["basic", { language: "go" }],
  ])("refuses a query only Zoekt can run on %s before sending it", async (engine, extra) => {
    const calls = fakeFetch(() => results(engine, []));
    const error = await failure(searchCodePage(api(), { kind: "project", projectId: 1 }, engine,
      { text: "x", ...extra }, options));
    expect(error.category).toBe("needsExactSearch");
    expect(calls).toEqual([]);
  });

  it("returns hits deduplicated on project, path and line, with the next page", async () => {
    fakeFetch(() => results("zoekt", [row(1, "a.ts", 3), row(1, "a.ts", 3), row(1, "a.ts", 9), row(2, "a.ts", 3)],
      { "x-next-page": "2" }));
    const page = await searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "x" }, options);
    expect(page.engine).toBe("zoekt");
    expect(page.nextPage).toBe(2);
    expect(page.hits.map(hit => [hit.projectId, hit.path, hit.startLine])).toEqual([[1, "a.ts", 3], [1, "a.ts", 9], [2, "a.ts", 3]]);
    expect(page.hits[0]).toEqual({ projectId: 1, path: "a.ts", ref: "main", startLine: 3, data: "match in a.ts" });
  });
});

describe("searchCodePage engine check", () => {
  it("fails a regex search another engine ran, rather than return results that ignored it", async () => {
    fakeFetch(() => results("basic", [row(1, "a.ts", 1)]));
    const error = await failure(searchCodePage(api(), { kind: "project", projectId: 1 }, "zoekt",
      { text: "a.*", regex: true }, { ...options, ref: "feature" }));
    expect(error.category).toBe("needsExactSearch");
  });

  it("reports Zoekt as unavailable when another engine ran an instance or group search", async () => {
    fakeFetch(() => results("advanced", []));
    expect((await failure(searchCodePage(api(), { kind: "group", groupId: 3 }, "zoekt", { text: "x" }, options))).category)
      .toBe("zoektUnavailable");
  });

  it("fails as internal on any other mismatch, or no X-Search-Type at all", async () => {
    fakeFetch(() => results("basic", []));
    expect((await failure(searchCodePage(api(), { kind: "project", projectId: 1 }, "zoekt", { text: "x" }, options))).category)
      .toBe("internal");
    fakeFetch(() => json([]));
    expect((await failure(searchCodePage(api(), { kind: "project", projectId: 1 }, "basic", { text: "x" }, options))).category)
      .toBe("internal");
  });
});

describe("searchCodePage failures", () => {
  /** The error a search fails with when GitLab answers `response`. */
  const failWith = async (response: () => Response) => {
    fakeFetch(response);
    return await failure(searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "x" }, options));
  };
  const badRequest = (message: string) => () => json({ message }, { status: 400 });

  it("maps a 429 to rateLimited with Retry-After", async () => {
    const error = await failWith(() => json({ message: "Retry later" }, { status: 429, headers: { "retry-after": "17" } }));
    expect(error).toMatchObject({ category: "rateLimited", status: 429, retryAfterSeconds: 17 });
    expect(error.message).toBe("GitLab is rate-limiting code searches. Try again in 17 seconds.");
  });

  it.each([500, 502, 503, 504])("maps %i to unavailable", async status => {
    expect((await failWith(() => json({ message: "boom" }, { status }))).category).toBe("unavailable");
  });

  it("maps an answer that is not a list to unavailable, rather than read it as no matches", async () => {
    const error = await failWith(() => json({ message: "not a list" }, { headers: { "x-search-type": "zoekt" } }));
    expect(error).toMatchObject({ category: "unavailable", status: 502 });
    expect(error.message).toBe(CODE_SEARCH_ERROR_MESSAGES.unavailable);
  });

  it("maps a request GitLab never answered to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED internal-host.example");
    }));
    const error = await failure(searchCodePage(api(), { kind: "instance" }, "zoekt", { text: "x" }, options));
    expect(error.category).toBe("unavailable");
    expect(error.message).not.toContain("internal-host");
  });

  it("maps the global-search-disabled 403 to disabled, and any other 401/403/404 to refused with its status", async () => {
    expect((await failWith(() => json({ message: "403 Forbidden - Global Search is disabled for this scope" },
      { status: 403 }))).category).toBe("disabled");
    expect((await failWith(() => json({ message: "Global Search is disabled for this scope" }, { status: 403 }))).category)
      .toBe("disabled");
    for (const status of [401, 403, 404]) {
      const error = await failWith(() => json({ message: "403 Forbidden" }, { status }));
      expect(error).toMatchObject({ category: "refused", status });
      expect(error.message).toBe(`GitLab refused the code search (HTTP ${status}).`);
    }
  });

  it.each([
    ["Zoekt is not available", "zoektUnavailable"],
    ["Elasticsearch is not available", "noEngine"],
    ["Elasticsearch is disabled for blobs", "noEngine"],
    ["Scope supported only with advanced search or exact code search", "noEngine"],
    ["Zoekt is not available, Elasticsearch is not available", "zoektUnavailable"],
    ["Zoekt can only be used for blobs", "internal"],
    ["regex supported only with exact code search", "internal"],
    ["Zoekt is not available, regex supported only with exact code search", "internal"],
    ["Your search includes too many projects while traversal ID indexing is still in progress. Narrow it, then retry.",
      "tooBroad"],
  ])("maps the exact 400 %j to %s", async (message, category) => {
    const error = await failWith(badRequest(message));
    expect(error.category).toBe(category);
    expect(error.message).toBe(CODE_SEARCH_ERROR_MESSAGES[category as GitLabCodeSearchError["category"]]);
  });

  it.each([
    "zoekt is not available", "Zoekt is not available.", "Zoekt is not available, something else",
    "Failed to parse query: unbalanced ( at zoekt-7.internal.example:6070", "",
  ])("maps any other 400 (%j) to rejected, never repeating GitLab's text", async message => {
    const error = await failWith(badRequest(message));
    expect(error.category).toBe("rejected");
    expect(error.message).toBe(CODE_SEARCH_ERROR_MESSAGES.rejected);
    expect(JSON.stringify({ ...error, message: error.message, cause: error.cause })).not.toContain("internal.example");
  });

  it("rethrows a credential refusal unchanged", async () => {
    const refusal = new GitLabApiError(401, "401 Unauthorized", { isAuthError: true });
    const refusing = { searchBlobs: async () => { throw refusal; } } as unknown as GitLabApi;
    await expect(searchCodePage(refusing, { kind: "instance" }, "zoekt", { text: "x" }, options)).rejects.toBe(refusal);
  });
});

describe("resolveGroupId", () => {
  it("returns the group's id, or null when it isn't visible", async () => {
    const calls = fakeFetch(call => call.url.pathname.endsWith("/missing")
      ? json({ message: "404 Group Not Found" }, { status: 404 }) : json({ id: 31 }));
    expect(await resolveGroupId(api(), "group/sub")).toBe(31);
    expect(await resolveGroupId(api(), "missing")).toBeNull();
    expect(calls[0].url.pathname).toBe("/api/v4/groups/group%2Fsub");
  });

  it("fails with a classified error when GitLab fails", async () => {
    fakeFetch(() => json({ message: "boom" }, { status: 503 }));
    expect((await failure(resolveGroupId(api(), "group"))).category).toBe("unavailable");
  });
});
