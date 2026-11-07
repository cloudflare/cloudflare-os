// gitlab-code.ts: which engine a code search runs on, what every search page and repository read
// reports to the Workshop (and when), the narrowing of a page a collaborator was definitely denied,
// the 500-hit cap, file reads' refusals and line window, and the facet caches behind them. GitLab is
// faked at `fetch`, beneath a real GitLabApi; the Workshop is an authorizer that records each
// observation and answers it as a test says.

import { OBSERVER_ACCESS_DENIED_CODE } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabApi, GitLabApiError } from "../src/gitlab-api";
import {
  CODE_SEARCH_PAGE_SIZES, CodeCaches, CodeSearchPager, MAX_CODE_SEARCH_HITS, MAX_FILE_BYTES, MAX_FILE_LINES,
  RepositoryTreePager, decodeTextFile, matchedAs, openRepository, readRepositoryFile, readRepositoryMetadata,
  sliceLines, splitLines,
  type CodeAuthorizer, type CodeObservation, type CodeReadContext, type CodeSearchRequest,
} from "../src/gitlab-code";
import { GitLabCodeSearchError, type CodeSearchErrorCategory } from "../src/gitlab-code-search-api";
import type { GitLabProjectFacts } from "../src/gitlab-graphql";
import { parseResourceUrl } from "../src/gitlab-normalize";

const WEB = "https://gitlab.example.com";
const HOST = "gitlab.example.com";
const INSTANCE = `instance/${HOST}`;
const repository = (id: number) => `repository/${id}`;
/** The project a project search or repository read is about. */
const PROJECT_ID = 7;
const PROJECT_PATH = "group/app";
const TARGET = { projectId: PROJECT_ID, projectPath: PROJECT_PATH };
const COMMIT = "c".repeat(40);
const MINUTE = 60_000;

type Visibility = "public" | "internal" | "private";
/** A project as the owner's account sees it; `repositoryAccess` left out is a level GitLab didn't send. */
type FakeProject = { path: string; visibility: Visibility; repositoryAccess?: "enabled" | "private" | "disabled" };
type Row = { project_id: number; path: string; ref: string; startline: number; data: string };
type Search = { scope: string; params: URLSearchParams; engine: string; page: number; perPage: number };
type SearchAnswer = { rows: Row[]; nextPage?: number | null; engine?: string } | { status: number; message: string };
type TreePage = { entries: Array<{ path: string; type: string }>; nextPage: number | null };

const row = (projectId: number, path: string, startline = 1): Row =>
  ({ project_id: projectId, path, ref: "main", startline, data: `match in ${path}` });

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

/** GitLab at `fetch`: code search, groups, GraphQL project facts, projects, raw files and trees. */
class FakeGitLab {
  readonly projects = new Map<number, FakeProject>([[PROJECT_ID, { path: PROJECT_PATH, visibility: "private" }]]);
  readonly groups = new Map<string, number>();
  readonly searches: Search[] = [];
  /** The ids each GraphQL facts query asked about. */
  readonly factsAsked: number[][] = [];
  readonly fileRequests: Array<{ path: string; ref: string }> = [];
  readonly treeRequests: URLSearchParams[] = [];
  /** The id or path of each `GET /projects/:id` asked. */
  readonly projectReads: string[] = [];
  /** Answers each search; by default an empty last page from the engine asked. */
  answer: (search: Search) => SearchAnswer = () => ({ rows: [] });
  /** Answers `GET …/repository/files/:path/raw`; null is a 404. */
  file: (path: string, ref: string) => { commitId: string; bytes: Uint8Array } | null = () => null;
  /** Answers `GET …/repository/tree` by page; null is a 404. */
  tree: (page: number) => TreePage | null = () => null;
  /** A status every project read answers instead of the project. */
  projectStatus: number | undefined;
  /** A whole answer every GraphQL facts query gets instead of the projects. */
  factsAnswer: (() => Response) | undefined;

  constructor() {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) =>
      this.#respond(new URL(String(input)), init)));
  }

  #respond(url: URL, init: RequestInit): Response {
    const path = url.pathname;
    if (init.method === "POST" && path === "/api/graphql") return this.#facts(JSON.parse(String(init.body)));
    let match = /^\/api\/v4((?:\/groups\/\d+|\/projects\/\d+)?\/search)$/.exec(path);
    if (match) return this.#search(match[1], url.searchParams);
    match = /^\/api\/v4\/groups\/([^/]+)$/.exec(path);
    if (match) {
      const id = this.groups.get(decodeURIComponent(match[1]));
      return id === undefined ? json({ message: "404 Group Not Found" }, 404) : json({ id });
    }
    match = /^\/api\/v4\/projects\/\d+\/repository\/files\/([^/]+)\/raw$/.exec(path);
    if (match) return this.#file(decodeURIComponent(match[1]), url.searchParams.get("ref")!);
    if (/^\/api\/v4\/projects\/\d+\/repository\/tree$/.test(path)) return this.#tree(url.searchParams);
    match = /^\/api\/v4\/projects\/([^/]+)$/.exec(path);
    if (match) return this.#project(decodeURIComponent(match[1]));
    throw new Error(`test: unexpected request ${init.method ?? "GET"} ${url}`);
  }

  #search(scope: string, params: URLSearchParams): Response {
    const search = {
      scope, params, engine: params.get("search_type")!, page: Number(params.get("page")), perPage: Number(params.get("per_page")),
    };
    this.searches.push(search);
    const answer = this.answer(search);
    if ("status" in answer) return json({ message: answer.message }, answer.status);
    return json(answer.rows, 200, {
      "x-search-type": answer.engine ?? search.engine,
      "x-next-page": answer.nextPage === undefined || answer.nextPage === null ? "" : String(answer.nextPage),
    });
  }

  #facts(body: { variables: { ids: string[] } }): Response {
    const ids = body.variables.ids.map(gid => Number(gid.slice(gid.lastIndexOf("/") + 1)));
    this.factsAsked.push(ids);
    if (this.factsAnswer !== undefined) return this.factsAnswer();
    const nodes = ids.flatMap(id => {
      const project = this.projects.get(id);
      return project === undefined ? [] : [{
        id: `gid://gitlab/Project/${id}`, fullPath: project.path, name: project.path.split("/").at(-1),
        webUrl: `${WEB}/${project.path}`, visibility: project.visibility, archived: false, repository: { rootRef: "main" },
      }];
    });
    return json({ data: { projects: { nodes, pageInfo: { hasNextPage: false } } } });
  }

  #project(idOrPath: string): Response {
    this.projectReads.push(idOrPath);
    if (this.projectStatus !== undefined) return json({ message: "test: failed" }, this.projectStatus);
    const id = /^\d+$/.test(idOrPath) ? Number(idOrPath)
      : [...this.projects].find(([, project]) => project.path === idOrPath)?.[0];
    const project = id === undefined ? undefined : this.projects.get(id);
    if (project === undefined) return json({ message: "404 Project Not Found" }, 404);
    const name = project.path.split("/").at(-1);
    return json({
      id, name, path: name, path_with_namespace: project.path, web_url: `${WEB}/${project.path}`,
      visibility: project.visibility, default_branch: "main", description: null,
      repository_access_level: project.repositoryAccess,
    });
  }

  #file(path: string, ref: string): Response {
    this.fileRequests.push({ path, ref });
    const file = this.file(path, ref);
    if (file === null) return json({ message: "404 File Not Found" }, 404);
    return new Response(file.bytes, {
      headers: { "x-gitlab-commit-id": file.commitId, "x-gitlab-size": String(file.bytes.byteLength) },
    });
  }

  #tree(params: URLSearchParams): Response {
    this.treeRequests.push(params);
    const page = this.tree(Number(params.get("page")));
    if (page === null) return json({ message: "404 Tree Not Found" }, 404);
    return json(page.entries, 200, { "x-next-page": page.nextPage === null ? "" : String(page.nextPage) });
  }
}

/** Facet KV over a Map, scanned in key order. */
function memoryKv() {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: <T>(key: string) => entries.get(key) as T | undefined,
    put: <T>(key: string, value: T) => { entries.set(key, value); },
    delete: (key: string) => { entries.delete(key); },
    list: <T>({ prefix, startAfter, limit = Infinity }: { prefix: string; startAfter?: string; limit?: number }) =>
      [...entries.keys()].filter(key => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .toSorted().slice(0, limit).map(key => [key, entries.get(key) as T] as [string, T]),
    /** The keys under `prefix`, in order. */
    keys: (prefix: string) => [...entries.keys()].filter(key => key.startsWith(prefix)).toSorted(),
  };
}

function contextOf(caches = new CodeCaches(memoryKv())): CodeReadContext {
  const api = new GitLabApi({ apiOrigin: WEB, headers: {} }, async () => "tok-1");
  return { read: fn => fn(api), caches, instanceUrl: WEB, host: HOST };
}

/**
 * The Workshop: records each observation, and answers the n-th with `outcomes[n]` -- thrown when
 * set, allowed when undefined or past the end.
 */
function workshop(...outcomes: unknown[]): { observations: CodeObservation[]; authorize: CodeAuthorizer } {
  const observations: CodeObservation[] = [];
  return {
    observations,
    authorize: async observation => {
      const outcome = outcomes[observations.length];
      observations.push(observation);
      if (outcome !== undefined) throw outcome;
    },
  };
}

/** The kernel's definite denial, as it arrives over RPC: an enumerable `code`, the name lost. */
const denial = () => Object.assign(new Error("A collaborator can't see this."), { code: OBSERVER_ACCESS_DENIED_CODE });

const instanceSearch = (context: CodeReadContext, authorize: CodeAuthorizer,
                        query: Extract<CodeSearchRequest, { kind: "instance" }>["query"] = { text: "needle" }) =>
  new CodeSearchPager(context, authorize, { kind: "instance", query });

const projectSearch = (context: CodeReadContext, authorize: CodeAuthorizer,
                       query: Extract<CodeSearchRequest, { kind: "project" }>["query"] = { text: "needle" },
                       defaultBranch: string | null = "main") =>
  new CodeSearchPager(context, authorize,
    { kind: "project", query, projectId: PROJECT_ID, projectPath: PROJECT_PATH, defaultBranch });

async function failure(promise: Promise<unknown>, category: CodeSearchErrorCategory): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitLabCodeSearchError);
  expect((error as GitLabCodeSearchError).category).toBe(category);
}

/** An answer from the engine asked, or `unavailable` for those GitLab can't run. */
function engines(rows: Row[], unavailable: Record<string, string> = {}): (search: Search) => SearchAnswer {
  return search => search.engine in unavailable
    ? { status: 400, message: `400 Bad request - ${unavailable[search.engine]}` }
    : { rows };
}

const ZOEKT_MISSING = { zoekt: "Zoekt is not available" };

let gitlab: FakeGitLab;

beforeEach(() => {
  gitlab = new FakeGitLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matchedAs", () => {
  it("names how the engine that ran matched, never what was asked", () => {
    expect(matchedAs("zoekt", true)).toBe("regex");
    expect(matchedAs("zoekt", false)).toBe("exact");
    expect(matchedAs("zoekt", undefined)).toBe("exact");
    expect(matchedAs("advanced", false)).toBe("words");
    expect(matchedAs("basic", false)).toBe("exact");
    expect(matchedAs("basic", true)).toBe("exact");
  });
});

describe("project search routing", () => {
  it("runs Zoekt with the text verbatim on the default branch, named or not, asking 100 a page", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")]);
    for (const ref of [undefined, "", "main"]) {
      const { authorize } = workshop();
      const hits = await projectSearch(contextOf(), authorize, { text: "a.b(", ...(ref === undefined ? {} : { ref }) }).next();
      expect(hits).toMatchObject([{ path: "a.ts", matchedAs: "exact" }]);
      const search = gitlab.searches.at(-1)!;
      expect(search).toMatchObject({ scope: `/projects/${PROJECT_ID}/search`, engine: "zoekt", page: 1, perPage: 100 });
      expect(search.params.get("search")).toBe("a.b(");
      expect(search.params.get("regex")).toBe("false");
    }
    expect(gitlab.searches).toHaveLength(3);
  });

  it("asks basic search, without regex, for another ref or any ref of an empty repository", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")]);
    expect(await projectSearch(contextOf(), workshop().authorize, { text: "x", ref: "feature" }).next())
      .toMatchObject([{ matchedAs: "exact" }]);
    expect(await projectSearch(contextOf(), workshop().authorize, { text: "x", ref: "main" }, null).next())
      .toMatchObject([{ matchedAs: "exact" }]);
    expect(gitlab.searches.map(search => search.engine)).toEqual(["basic", "basic"]);
    expect(gitlab.searches[0].params.get("ref")).toBe("feature");
    expect(gitlab.searches[0].params.has("regex")).toBe(false);
    expect(gitlab.searches[0].perPage).toBe(CODE_SEARCH_PAGE_SIZES.basic);
  });

  it("refuses a regex or language on another ref before asking GitLab or the Workshop", async () => {
    for (const query of [{ text: "a+", regex: true, ref: "feature" }, { text: "a", language: "go", ref: "feature" } as const]) {
      const { observations, authorize } = workshop();
      await failure(projectSearch(contextOf(), authorize, query).next(), "needsExactSearch");
      expect(observations).toEqual([]);
    }
    expect(gitlab.searches).toEqual([]);
  });

  it("falls back from Zoekt to advanced search, 20 a page with escaped text, and remembers Zoekt is missing", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")], ZOEKT_MISSING);
    const caches = new CodeCaches(memoryKv());
    expect(await projectSearch(contextOf(caches), workshop().authorize, { text: "a.b" }).next())
      .toMatchObject([{ path: "a.ts", matchedAs: "words" }]);
    expect(gitlab.searches.map(search => search.engine)).toEqual(["zoekt", "advanced"]);
    expect(gitlab.searches[1].perPage).toBe(20);
    expect(gitlab.searches[1].params.get("search")).toBe("a\\.b");
    expect(gitlab.searches[1].params.has("regex")).toBe(false);
    expect(caches.hasNoZoekt(`project/${PROJECT_ID}`)).toBe(true);
    expect(caches.hasNoZoekt("instance")).toBe(false);

    // The next search of the project skips Zoekt.
    await projectSearch(contextOf(caches), workshop().authorize).next();
    expect(gitlab.searches.map(search => search.engine)).toEqual(["zoekt", "advanced", "advanced"]);
  });

  it("falls back to basic search where neither Zoekt nor advanced search can run", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")], { ...ZOEKT_MISSING, advanced: "Elasticsearch is not available" });
    expect(await projectSearch(contextOf(), workshop().authorize).next()).toMatchObject([{ matchedAs: "exact" }]);
    expect(gitlab.searches.map(search => search.engine)).toEqual(["zoekt", "advanced", "basic"]);
    expect(gitlab.searches[2].perPage).toBe(100);
  });

  it("fails a regex where Zoekt is unavailable rather than match it as words", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")], ZOEKT_MISSING);
    await failure(projectSearch(contextOf(), workshop().authorize, { text: "a+", regex: true }).next(), "needsExactSearch");
    expect(gitlab.searches.map(search => search.engine)).toEqual(["zoekt"]);
  });

  it("reports a regex Zoekt ran as regex matches", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")]);
    expect(await projectSearch(contextOf(), workshop().authorize, { text: "a+", regex: true }).next())
      .toMatchObject([{ matchedAs: "regex" }]);
    expect(gitlab.searches[0].params.get("regex")).toBe("true");
  });

  it("keeps the first page's engine for the rest of the search", async () => {
    gitlab.answer = search => search.engine === "zoekt" ? { status: 400, message: "Zoekt is not available" }
      : { rows: [row(PROJECT_ID, `p${search.page}.ts`)], nextPage: search.page === 1 ? 2 : null };
    const { observations, authorize } = workshop();
    const pager = projectSearch(contextOf(), authorize);
    expect(await pager.next()).toMatchObject([{ path: "p1.ts", matchedAs: "words" }]);
    expect(await pager.next()).toMatchObject([{ path: "p2.ts", matchedAs: "words" }]);
    expect(await pager.next()).toBeNull();
    expect(gitlab.searches.map(search => [search.engine, search.page])).toEqual([["zoekt", 1], ["advanced", 1], ["advanced", 2]]);
    expect(observations.map(observation => observation.title))
      .toEqual([`Search GitLab code: needle in ${PROJECT_PATH}`, `Search GitLab code: needle in ${PROJECT_PATH} (page 2)`]);
  });

  it("asks again for a page GitLab failed, without ending the search or telling the Workshop", async () => {
    let calls = 0;
    gitlab.answer = () => ++calls === 1 ? { status: 500, message: "boom" } : { rows: [row(PROJECT_ID, "a.ts")] };
    const { observations, authorize } = workshop();
    const pager = projectSearch(contextOf(), authorize);
    await failure(pager.next(), "unavailable");
    expect(observations).toEqual([]);
    expect(await pager.next()).toMatchObject([{ path: "a.ts" }]);
    expect(gitlab.searches.map(search => [search.engine, search.page])).toEqual([["zoekt", 1], ["zoekt", 1]]);
  });
});

describe("instance search routing", () => {
  beforeEach(() => {
    gitlab.projects.set(1, { path: "acme/one", visibility: "private" });
  });

  it("runs Zoekt alone, across the instance or a group, 100 a page", async () => {
    gitlab.answer = engines([row(1, "a.ts")]);
    gitlab.groups.set("acme/platform", 5);
    expect(await instanceSearch(contextOf(), workshop().authorize, { text: "needle", includeArchived: true }).next())
      .toMatchObject([{ projectId: 1, matchedAs: "exact" }]);
    const { observations, authorize } = workshop();
    expect(await instanceSearch(contextOf(), authorize, { text: "n.+", regex: true, groupPath: "acme/platform" }).next())
      .toMatchObject([{ projectId: 1, matchedAs: "regex" }]);

    expect(gitlab.searches.map(search => [search.scope, search.engine, search.perPage]))
      .toEqual([["/search", "zoekt", 100], ["/groups/5/search", "zoekt", 100]]);
    expect(gitlab.searches[0].params.get("include_archived")).toBe("true");
    expect(gitlab.searches[0].params.get("regex")).toBe("false");
    expect(gitlab.searches[1].params.get("regex")).toBe("true");
    expect(observations[0]).toMatchObject({
      title: "Search GitLab code: n.+ in acme/platform",
      description: `Search code in the GitLab group acme/platform on ${HOST} for "n.+".`,
    });
  });

  it("fails where Zoekt can't search, trying no other engine, and asks nothing while that is remembered", async () => {
    gitlab.answer = engines([row(1, "a.ts")], ZOEKT_MISSING);
    const caches = new CodeCaches(memoryKv());
    const { observations, authorize } = workshop();
    await failure(instanceSearch(contextOf(caches), authorize).next(), "zoektUnavailable");
    await failure(instanceSearch(contextOf(caches), authorize).next(), "zoektUnavailable");
    expect(gitlab.searches.map(search => search.engine)).toEqual(["zoekt"]);
    expect(caches.hasNoZoekt("instance")).toBe(true);
    expect(observations).toEqual([]);
  });

  it("treats another engine answering as Zoekt being unavailable", async () => {
    gitlab.answer = () => ({ rows: [row(1, "a.ts")], engine: "basic" });
    const caches = new CodeCaches(memoryKv());
    const { observations, authorize } = workshop();
    await failure(instanceSearch(contextOf(caches), authorize).next(), "zoektUnavailable");
    expect(caches.hasNoZoekt("instance")).toBe(true);
    expect(observations).toEqual([]);
  });

  it("reports a group the account can't see as an answer about the instance, then ends", async () => {
    const { observations, authorize } = workshop();
    const pager = instanceSearch(contextOf(), authorize, { text: "needle", groupPath: "acme/hidden" });
    await expect(pager.next()).rejects.toThrow(`No GitLab group at "acme/hidden" that this account can read on ${HOST}.`);
    expect(observations).toEqual([{
      title: "Search GitLab code: needle in acme/hidden",
      description: `Search code in the GitLab group acme/hidden on ${HOST} for "needle".`,
      subresources: [INSTANCE],
    }]);
    expect(await pager.next()).toBeNull();
    expect(gitlab.searches).toEqual([]);
  });

  it("ends the search when that group answer is refused", async () => {
    const refusal = new Error("test: refused");
    const pager = instanceSearch(contextOf(), workshop(refusal).authorize, { text: "needle", groupPath: "acme/hidden" });
    await expect(pager.next()).rejects.toBe(refusal);
    await expect(pager.next()).rejects.toBe(refusal);
  });

  describe("when the project lookup for a page fails", () => {
    const SECRET = "acme/secret-project on gitlab-zoekt-gateway.gitlab.svc.cluster.local:8080";

    /** The failure, checked to carry nothing of GitLab's answer, anywhere an agent or log could see. */
    async function sanitizedFailure(category: CodeSearchErrorCategory): Promise<GitLabCodeSearchError> {
      gitlab.answer = engines([row(1, "a.ts")]);
      const { observations, authorize } = workshop();
      const pager = instanceSearch(contextOf(), authorize);
      const error = await pager.next().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitLabCodeSearchError);
      const failed = error as GitLabCodeSearchError;
      expect(failed.category).toBe(category);
      expect(failed.cause).toBeUndefined();
      expect(JSON.stringify({ ...failed, message: failed.message })).not.toMatch(/secret|cluster\.local/);
      expect(observations).toEqual([]);
      return failed;
    }

    it("fails with fixed text, never GitLab's, for an HTTP error", async () => {
      gitlab.factsAnswer = () => json({ message: `500 Internal Server Error: ${SECRET}` }, 500);
      expect((await sanitizedFailure("unavailable")).status).toBe(500);
      gitlab.factsAnswer = () => json({ message: `403 Forbidden: ${SECRET}` }, 403);
      await sanitizedFailure("refused");
    });

    it("keeps a rate limit's retry delay and nothing else", async () => {
      gitlab.factsAnswer = () => new Response(JSON.stringify({ message: SECRET }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
      expect((await sanitizedFailure("rateLimited")).retryAfterSeconds).toBe(7);
    });

    it("fails with fixed text, without GitLab's error list, for GraphQL errors", async () => {
      gitlab.factsAnswer = () => json({ data: null, errors: [{ message: `Project ${SECRET} timed out` }] });
      await sanitizedFailure("internal");
    });

    it("asks again for the same page on the next call", async () => {
      gitlab.factsAnswer = () => json({ message: SECRET }, 502);
      gitlab.answer = engines([row(1, "a.ts")]);
      const pager = instanceSearch(contextOf(), workshop().authorize);
      await failure(pager.next(), "unavailable");
      gitlab.factsAnswer = undefined;
      expect(await pager.next()).toMatchObject([{ path: "a.ts" }]);
      expect(gitlab.searches.map(search => search.page)).toEqual([1, 1]);
    });
  });
});

describe("search pages", () => {
  beforeEach(() => {
    gitlab.projects.set(1, { path: "acme/one", visibility: "public", repositoryAccess: "enabled" });
    gitlab.projects.set(2, { path: "acme/two", visibility: "private" });
  });

  it("report the instance and each distinct repository on an instance page", async () => {
    gitlab.answer = search => search.page === 1
      ? { rows: [row(1, "a.ts", 3), row(1, "b.ts"), row(2, "c.ts")], nextPage: 2 }
      : { rows: [row(2, "d.ts")], nextPage: null };
    const { observations, authorize } = workshop();
    const pager = instanceSearch(contextOf(), authorize);

    const first = await pager.next();
    expect(first).toHaveLength(3);
    expect(first![0]).toEqual({
      projectId: 1, projectPath: "acme/one", path: "a.ts", ref: "main", startLine: 3, snippet: "match in a.ts",
      webUrl: `${WEB}/acme/one/-/blob/main/a.ts#L3`, matchedAs: "exact",
    });
    expect(await pager.next()).toMatchObject([{ projectId: 2, path: "d.ts" }]);
    expect(await pager.next()).toBeNull();
    expect(observations).toEqual([
      {
        title: "Search GitLab code: needle",
        description: `Search code in every readable project on ${HOST} for "needle".`,
        subresources: [INSTANCE, repository(1), repository(2)],
      },
      {
        title: "Search GitLab code: needle (page 2)",
        description: `Search code in every readable project on ${HOST} for "needle".`,
        subresources: [INSTANCE, repository(2)],
      },
    ]);
  });

  it("authorize an empty first page, which tells that the term is absent, then end", async () => {
    const instance = workshop();
    const pager = instanceSearch(contextOf(), instance.authorize);
    expect(await pager.next()).toBeNull();
    expect(await pager.next()).toBeNull();
    expect(instance.observations.map(observation => observation.subresources)).toEqual([[INSTANCE]]);

    const project = workshop();
    expect(await projectSearch(contextOf(), project.authorize).next()).toBeNull();
    expect(project.observations.map(observation => observation.subresources)).toEqual([[repository(PROJECT_ID)]]);
  });

  it("withhold an empty first page the Workshop refuses", async () => {
    const refusal = new Error("test: refused");
    await expect(instanceSearch(contextOf(), workshop(refusal).authorize).next()).rejects.toBe(refusal);
  });

  it("end without an observation when the page after an answered one is empty", async () => {
    gitlab.answer = search => search.page === 1 ? { rows: [row(1, "a.ts")], nextPage: 2 } : { rows: [], nextPage: null };
    const { observations, authorize } = workshop();
    const pager = instanceSearch(contextOf(), authorize);
    expect(await pager.next()).toHaveLength(1);
    expect(await pager.next()).toBeNull();
    expect(observations).toHaveLength(1);
  });

  it("report only the repository on a project page", async () => {
    gitlab.answer = engines([row(PROJECT_ID, "a.ts"), row(PROJECT_ID, "b.ts")]);
    const { observations, authorize } = workshop();
    expect(await projectSearch(contextOf(), authorize).next()).toHaveLength(2);
    expect(observations).toEqual([{
      title: `Search GitLab code: needle in ${PROJECT_PATH}`,
      description: `Search code in the GitLab project ${PROJECT_PATH} for "needle".`,
      subresources: [repository(PROJECT_ID)],
    }]);
  });

  it("drop hits from projects the owner's account can't see, and leave them out of the report", async () => {
    gitlab.answer = engines([row(1, "a.ts"), row(99, "secret.ts")]);
    const { observations, authorize } = workshop();
    expect(await instanceSearch(contextOf(), authorize).next()).toMatchObject([{ projectId: 1, path: "a.ts" }]);
    expect(observations[0].subresources).toEqual([INSTANCE, repository(1)]);
  });

  it("reuse the owner's view of a project across searches", async () => {
    gitlab.answer = engines([row(1, "a.ts"), row(2, "b.ts")]);
    const caches = new CodeCaches(memoryKv());
    await instanceSearch(contextOf(caches), workshop().authorize).next();
    await instanceSearch(contextOf(caches), workshop().authorize).next();
    expect(gitlab.factsAsked).toEqual([[1, 2]]);
  });

  it(`stop at ${MAX_CODE_SEARCH_HITS} hits, cutting the page that crosses it`, async () => {
    // The first page loses half its rows to a project the owner can't see; the sixth crosses 500.
    gitlab.answer = search => ({
      rows: Array.from({ length: 100 }, (_, index) =>
        row(search.page === 1 && index % 2 === 1 ? 99 : 1, `p${search.page}-${index}.ts`)),
      nextPage: search.page + 1,
    });
    const pager = instanceSearch(contextOf(), workshop().authorize);
    const sizes: number[] = [];
    for (let page = await pager.next(); page !== null; page = await pager.next()) sizes.push(page.length);
    expect(sizes).toEqual([50, 100, 100, 100, 100, 50]);
    expect(gitlab.searches).toHaveLength(6);
  });

  it("serve concurrent calls one page after another", async () => {
    gitlab.answer = search => ({ rows: [row(1, `p${search.page}.ts`)], nextPage: search.page === 1 ? 2 : null });
    const pager = instanceSearch(contextOf(), workshop().authorize);
    const [first, second, third] = await Promise.all([pager.next(), pager.next(), pager.next()]);
    expect([first![0].path, second![0].path, third]).toEqual(["p1.ts", "p2.ts", null]);
  });

  it("end at a refused page, failing every later call as it did without asking GitLab again", async () => {
    gitlab.answer = engines([row(1, "a.ts")]);
    const refusal = new Error("test: refused");
    const { observations, authorize } = workshop(refusal);
    const pager = instanceSearch(contextOf(), authorize);
    await expect(pager.next()).rejects.toBe(refusal);
    await expect(pager.next()).rejects.toBe(refusal);
    expect(observations).toHaveLength(1);
    expect(gitlab.searches).toHaveLength(1);
  });

  it("clip long search text in titles", async () => {
    const { observations, authorize } = workshop();
    await instanceSearch(contextOf(), authorize, { text: "x".repeat(100) }).next();
    expect(observations[0].title).toBe(`Search GitLab code: ${"x".repeat(80)}…`);
  });

  it("need search text", () => {
    expect(() => instanceSearch(contextOf(), workshop().authorize, {} as never)).toThrow(/needs `text`/);
  });
});

describe("narrowing an instance search page", () => {
  /** 1 and 2 every signed-in user can read; 3 to 6 not, each for its own reason. */
  beforeEach(() => {
    gitlab.projects.set(1, { path: "acme/public", visibility: "public", repositoryAccess: "enabled" });
    gitlab.projects.set(2, { path: "acme/internal", visibility: "internal", repositoryAccess: "enabled" });
    gitlab.projects.set(3, { path: "acme/private", visibility: "private" });
    gitlab.projects.set(4, { path: "acme/members-code", visibility: "public", repositoryAccess: "private" });
    gitlab.projects.set(5, { path: "acme/no-code", visibility: "internal", repositoryAccess: "disabled" });
    // GitLab sent no repository level: not known to be open, so not open.
    gitlab.projects.set(6, { path: "acme/unknown", visibility: "public" });
  });

  const everyProject = [1, 2, 3, 4, 5, 6].map(id => row(id, `f${id}.ts`));

  it("offers a definitely denied page once more with only the hits every signed-in user can read", async () => {
    gitlab.answer = search => search.page === 1 ? { rows: everyProject, nextPage: 2 } : { rows: [row(3, "next.ts")], nextPage: null };
    const { observations, authorize } = workshop(denial());
    const pager = instanceSearch(contextOf(), authorize);

    expect((await pager.next())!.map(hit => hit.projectId)).toEqual([1, 2]);
    expect(observations.map(observation => observation.subresources)).toEqual([
      [INSTANCE, ...[1, 2, 3, 4, 5, 6].map(repository)],
      [INSTANCE, repository(1), repository(2)],
    ]);
    expect(observations[1].title).toBe(observations[0].title);
    // The search goes on, its next page offered whole.
    expect(await pager.next()).toMatchObject([{ projectId: 3 }]);
    expect(observations[2].subresources).toEqual([INSTANCE, repository(3)]);
  });

  it("matches the denial by name too", async () => {
    gitlab.answer = engines(everyProject);
    const denied = new Error("denied");
    denied.name = OBSERVER_ACCESS_DENIED_CODE;
    expect((await instanceSearch(contextOf(), workshop(denied).authorize).next())!.map(hit => hit.projectId)).toEqual([1, 2]);
  });

  it("may narrow a page to nothing, still authorizing that empty page", async () => {
    gitlab.answer = engines([row(3, "a.ts"), row(4, "b.ts")]);
    const { observations, authorize } = workshop(denial());
    const pager = instanceSearch(contextOf(), authorize);
    expect(await pager.next()).toEqual([]);
    expect(observations.map(observation => observation.subresources))
      .toEqual([[INSTANCE, repository(3), repository(4)], [INSTANCE]]);
    expect(await pager.next()).toBeNull();
  });

  it("propagates any other refusal unchanged, without narrowing, ending the search", async () => {
    for (const refusal of [new Error("test: a verifier failed"),
      Object.assign(new Error("test: other code"), { code: "ObserverCheckFailed" })]) {
      gitlab.answer = engines(everyProject);
      const { observations, authorize } = workshop(refusal);
      const pager = instanceSearch(contextOf(), authorize);
      await expect(pager.next()).rejects.toBe(refusal);
      await expect(pager.next()).rejects.toBe(refusal);
      expect(observations).toHaveLength(1);
    }
  });

  it("propagates a refused narrowed page, ending the search, and never narrows again", async () => {
    for (const second of [denial(), new Error("test: a verifier failed")]) {
      gitlab.answer = engines(everyProject);
      const { observations, authorize } = workshop(denial(), second);
      const pager = instanceSearch(contextOf(), authorize);
      await expect(pager.next()).rejects.toBe(second);
      await expect(pager.next()).rejects.toBe(second);
      expect(observations).toHaveLength(2);
    }
  });

  it("rethrows the denial when narrowing would leave the page as it was", async () => {
    gitlab.answer = engines([row(1, "a.ts"), row(2, "b.ts")]);
    const refusal = denial();
    const { observations, authorize } = workshop(refusal);
    await expect(instanceSearch(contextOf(), authorize).next()).rejects.toBe(refusal);
    expect(observations).toHaveLength(1);
  });

  it("never narrows a project search, whose page depends on one repository however it is cut", async () => {
    gitlab.projects.set(PROJECT_ID, { path: PROJECT_PATH, visibility: "public", repositoryAccess: "enabled" });
    gitlab.answer = engines([row(PROJECT_ID, "a.ts")]);
    const refusal = denial();
    const { observations, authorize } = workshop(refusal);
    await expect(projectSearch(contextOf(), authorize).next()).rejects.toBe(refusal);
    expect(observations).toHaveLength(1);
  });

  it("asks GitLab for repository levels only to narrow, for internal and public projects, reusing known ones", async () => {
    gitlab.answer = engines(everyProject);
    const caches = new CodeCaches(memoryKv());
    await instanceSearch(contextOf(caches), workshop().authorize).next();
    expect(gitlab.projectReads).toEqual([]);
    await instanceSearch(contextOf(caches), workshop(denial()).authorize).next();
    expect(gitlab.projectReads.toSorted()).toEqual(["1", "2", "4", "5", "6"]);
    // The level GitLab did not send (6) is asked again; the others are reused.
    await instanceSearch(contextOf(caches), workshop(denial()).authorize).next();
    expect(gitlab.projectReads.toSorted()).toEqual(["1", "2", "4", "5", "6", "6"]);
  });

  it("counts a repository level GitLab failed to answer as not open", async () => {
    gitlab.answer = engines([row(1, "a.ts"), row(3, "b.ts")]);
    gitlab.projectStatus = 500;
    const { observations, authorize } = workshop(denial());
    expect(await instanceSearch(contextOf(), authorize).next()).toEqual([]);
    expect(observations.map(observation => observation.subresources))
      .toEqual([[INSTANCE, repository(1), repository(3)], [INSTANCE]]);
  });
});

describe("CodeCaches", () => {
  const facts = (id: number): GitLabProjectFacts => ({
    id, path: `acme/p${id}`, name: `p${id}`, namespace: "acme", url: `${WEB}/acme/p${id}`, defaultBranch: "main",
    visibility: "private", archived: false,
  });

  it("reuses project facts for ten minutes, and asks again about an id the load left out", async () => {
    let now = 0;
    const kv = memoryKv();
    const caches = new CodeCaches(kv, () => now);
    const asked: number[][] = [];
    const load = async (ids: number[]) => {
      asked.push(ids);
      return new Map(ids.filter(id => id !== 2).map(id => [id, facts(id)]));
    };
    expect([...(await caches.projectFacts([1, 2, 1], load)).keys()]).toEqual([1]);
    expect(kv.entries.has("code:facts:1")).toBe(true);
    now = 10 * MINUTE - 1;
    expect([...(await caches.projectFacts([1, 2], load)).keys()]).toEqual([1]);
    now = 10 * MINUTE;
    await caches.projectFacts([1], load);
    expect(asked).toEqual([[1, 2], [2], [1]]);
  });

  it("remembers that Zoekt can't search a scope for ten minutes, then deletes the entry it reads expired", () => {
    let now = 0;
    const kv = memoryKv();
    const caches = new CodeCaches(kv, () => now);
    caches.markNoZoekt("group/5");
    expect(kv.entries.has("code:noZoekt:group/5")).toBe(true);
    expect(caches.hasNoZoekt("group/5")).toBe(true);
    expect(caches.hasNoZoekt("instance")).toBe(false);
    now = 10 * MINUTE;
    expect(caches.hasNoZoekt("group/5")).toBe(false);
    expect(kv.entries.has("code:noZoekt:group/5")).toBe(false);
  });

  it("sweeps expired entries as new ones are written, a bounded batch at a time, until only fresh ones remain", async () => {
    let now = 0;
    const kv = memoryKv();
    const caches = new CodeCaches(kv, () => now);
    const load = async (ids: number[]) => new Map(ids.map(id => [id, facts(id)]));
    const open = async (ids: number[]) => new Map(ids.map(id => [id, true]));
    await caches.projectFacts(Array.from({ length: 100 }, (_, index) => index + 1), load);
    await caches.repositoryOpenToAllUsers(Array.from({ length: 100 }, (_, index) => index + 1), open);
    for (const scope of ["instance", "group/1", "group/2"]) caches.markNoZoekt(scope);
    now = 10 * MINUTE;

    // One write looks at a bounded batch, not the whole family.
    await caches.projectFacts([1001], load);
    expect(kv.keys("code:facts:").length).toBeGreaterThan(50);
    for (let id = 1002; id <= 1010; id++) await caches.projectFacts([id], load);
    expect(kv.keys("code:facts:")).toEqual(Array.from({ length: 10 }, (_, index) => `code:facts:${1001 + index}`));

    for (let id = 1001; id <= 1010; id++) await caches.repositoryOpenToAllUsers([id], open);
    expect(kv.keys("code:repositoryOpen:")).toHaveLength(10);
    caches.markNoZoekt("group/3");
    expect(kv.keys("code:noZoekt:")).toEqual(["code:noZoekt:group/3"]);
  });

  it("keeps file contents by project, commit and path, at most 128 of them, dropping the oldest", () => {
    const kv = memoryKv();
    const caches = new CodeCaches(kv);
    const bytes = new Uint8Array([1]);
    caches.storeFile(1, COMMIT, "dir/a b.ts", bytes);
    expect(kv.entries.get(`code:file:1:${COMMIT}:${encodeURIComponent("dir/a b.ts")}`)).toBe(bytes);
    for (let index = 1; index < 128; index++) caches.storeFile(1, COMMIT, `f${index}`, bytes);
    expect(caches.file(1, COMMIT, "dir/a b.ts")).toBe(bytes);
    // Stored again, the first is the newest; the next past the bound drops f1 instead.
    caches.storeFile(1, COMMIT, "dir/a b.ts", bytes);
    caches.storeFile(1, COMMIT, "f128", bytes);
    expect(caches.file(1, COMMIT, "f1")).toBeUndefined();
    expect(caches.file(1, COMMIT, "dir/a b.ts")).toBe(bytes);
    expect(caches.file(2, COMMIT, "f2")).toBeUndefined();
    expect(caches.file(1, COMMIT, "f2")).toBe(bytes);
    expect(kv.get<unknown[]>("code:files")).toHaveLength(128);
  });

  it("keeps at most 16 MiB of file contents, dropping the oldest", () => {
    const caches = new CodeCaches(memoryKv());
    const mebibyte = new Uint8Array(1024 * 1024);
    for (let index = 0; index < 16; index++) caches.storeFile(1, COMMIT, `f${index}`, mebibyte);
    expect(caches.file(1, COMMIT, "f0")).toBe(mebibyte);
    caches.storeFile(1, COMMIT, "f16", mebibyte);
    expect(caches.file(1, COMMIT, "f0")).toBeUndefined();
    expect(caches.file(1, COMMIT, "f1")).toBe(mebibyte);
  });
});

describe("readRepositoryFile", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `l${index + 1}`).join("\n") + "\n";

  it("reads a text file at the default branch, authorized as the repository", async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: text("one\r\ntwo\n") });
    const { observations, authorize } = workshop();
    expect(await readRepositoryFile(contextOf(), authorize, TARGET, "/src/a.ts")).toEqual({
      path: "src/a.ts", commitId: COMMIT, startLine: 1, endLine: 2, totalLines: 2, text: "one\ntwo",
    });
    expect(gitlab.fileRequests).toEqual([{ path: "src/a.ts", ref: "HEAD" }]);
    expect(observations).toEqual([{
      title: `Read src/a.ts in ${PROJECT_PATH}`,
      description: `Read src/a.ts in the GitLab project ${PROJECT_PATH}.`,
      subresources: [repository(PROJECT_ID)],
    }]);
  });

  it(`returns at most ${MAX_FILE_LINES} lines a call, the end clamped to the file's`, async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: text(lines(2500)) });
    const read = (options: { startLine?: number; endLine?: number }) =>
      readRepositoryFile(contextOf(), workshop().authorize, TARGET, "big.txt", options);

    const first = await read({});
    expect(first).toMatchObject({ startLine: 1, endLine: 2000, totalLines: 2500 });
    expect(first.text.split("\n")).toHaveLength(2000);
    expect(first.text.split("\n").at(-1)).toBe("l2000");
    expect(await read({ startLine: 2001 })).toMatchObject({ startLine: 2001, endLine: 2500 });
    expect(await read({ startLine: 10, endLine: 12 })).toMatchObject({ endLine: 12, text: "l10\nl11\nl12" });
    expect(await read({ startLine: 2400, endLine: 99_999 })).toMatchObject({ endLine: 2500 });
    expect(await read({ startLine: 1, endLine: 5000 })).toMatchObject({ endLine: 2000 });
    await expect(read({ startLine: 2501 })).rejects.toThrow("Line 2501 is past the end of big.txt, which has 2500 lines.");
    await expect(read({ startLine: 6, endLine: 5 })).rejects.toThrow(/endLine must not be before startLine/);
    for (const startLine of [0, -1, 1.5]) await expect(read({ startLine })).rejects.toThrow(/positive whole number/);
  });

  it("refuses a binary file, once the read is authorized", async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: new Uint8Array([0x61, 0, 0x62]) });
    const { observations, authorize } = workshop();
    await expect(readRepositoryFile(contextOf(), authorize, TARGET, "logo.png")).rejects.toThrow(/binary file/);
    expect(observations).toHaveLength(1);
  });

  it("refuses a file over 1 MiB without reading it, once the read is authorized", async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61) });
    const { observations, authorize } = workshop();
    await expect(readRepositoryFile(contextOf(), authorize, TARGET, "huge.txt"))
      .rejects.toThrow(`huge.txt is ${MAX_FILE_BYTES + 1} bytes, larger than the 1 MiB readFile() reads.`);
    expect(observations).toHaveLength(1);
  });

  it("reports a missing file as an answer from the repository", async () => {
    const { observations, authorize } = workshop();
    await expect(readRepositoryFile(contextOf(), authorize, TARGET, "docs/x.md"))
      .rejects.toThrow(`There is no file docs/x.md at the default branch in ${PROJECT_PATH}.`);
    await expect(readRepositoryFile(contextOf(), authorize, TARGET, "docs/x.md", { ref: "v1" }))
      .rejects.toThrow(`There is no file docs/x.md at v1 in ${PROJECT_PATH}.`);
    expect(observations.map(observation => observation.subresources)).toEqual([[repository(PROJECT_ID)], [repository(PROJECT_ID)]]);
    expect(observations[1].description).toBe(`Read docs/x.md at v1 in the GitLab project ${PROJECT_PATH}.`);
  });

  it("tells nothing about the file when the read is refused", async () => {
    const refusal = new Error("test: refused");
    await expect(readRepositoryFile(contextOf(), workshop(refusal).authorize, TARGET, "docs/x.md")).rejects.toBe(refusal);
  });

  it("serves a file at a commit it keeps from the cache, still authorizing every read", async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: text("cached\n") });
    const context = contextOf();
    const { observations, authorize } = workshop(undefined, undefined, new Error("test: refused"));
    expect(await readRepositoryFile(context, authorize, TARGET, "a.ts", { ref: "main" })).toMatchObject({ commitId: COMMIT });
    // Kept by the commit `main` resolved to.
    expect(await readRepositoryFile(context, authorize, TARGET, "a.ts", { ref: COMMIT }))
      .toMatchObject({ commitId: COMMIT, text: "cached" });
    expect(gitlab.fileRequests).toHaveLength(1);
    await expect(readRepositoryFile(context, authorize, TARGET, "a.ts", { ref: COMMIT })).rejects.toThrow("test: refused");
    expect(observations).toHaveLength(3);
    // A branch moves, so it is always asked of GitLab.
    await readRepositoryFile(context, workshop().authorize, TARGET, "a.ts", { ref: "main" });
    expect(gitlab.fileRequests.map(request => request.ref)).toEqual(["main", "main"]);
  });

  it("keeps no binary file", async () => {
    gitlab.file = () => ({ commitId: COMMIT, bytes: new Uint8Array([0]) });
    const context = contextOf();
    for (let read = 0; read < 2; read++) {
      await expect(readRepositoryFile(context, workshop().authorize, TARGET, "bin", { ref: COMMIT })).rejects.toThrow(/binary/);
    }
    expect(gitlab.fileRequests).toHaveLength(2);
  });

  it("needs a path", async () => {
    for (const path of ["", "/"]) {
      await expect(readRepositoryFile(contextOf(), workshop().authorize, TARGET, path)).rejects.toThrow(/needs the file's path/);
    }
  });
});

describe("text helpers", () => {
  it("split lines on LF or CRLF, without the empty one after a final newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("a")).toEqual(["a"]);
  });

  it("decode UTF-8 leniently, dropping a BOM, and call anything with a NUL byte binary", () => {
    expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({ text: "hi" });
    expect(decodeTextFile(new Uint8Array([0x61, 0xff]))).toEqual({ text: "a\uFFFD" });
    expect(decodeTextFile(new Uint8Array([0x61, 0x00]))).toEqual({ binary: true });
  });

  it("slice an empty file as no lines", () => {
    expect(sliceLines("empty", "")).toEqual({ startLine: 1, endLine: 0, totalLines: 0, text: "" });
    expect(() => sliceLines("empty", "", 2)).toThrow(/past the end/);
  });
});

describe("readRepositoryMetadata", () => {
  it("reads the project by its id, authorized as the repository", async () => {
    const { observations, authorize } = workshop();
    expect(await readRepositoryMetadata(contextOf(), authorize, TARGET))
      .toMatchObject({ path: PROJECT_PATH, url: `${WEB}/${PROJECT_PATH}`, defaultBranch: "main" });
    expect(observations).toEqual([{
      title: `Read project metadata for ${PROJECT_PATH}`,
      description: `Read basic metadata for the GitLab project ${PROJECT_PATH}.`,
      subresources: [repository(PROJECT_ID)],
    }]);
  });

  it("reports the project, which members can read, when its repository is disabled for everyone", async () => {
    const reported = async (repositoryAccess?: "enabled" | "private" | "disabled") => {
      gitlab.projects.set(PROJECT_ID, { path: PROJECT_PATH, visibility: "internal", repositoryAccess });
      const { observations, authorize } = workshop();
      await readRepositoryMetadata(contextOf(), authorize, TARGET);
      return observations[0].subresources;
    };
    expect(await reported("disabled")).toEqual([`project/${PROJECT_ID}`]);
    expect(await reported("private")).toEqual([repository(PROJECT_ID)]);
    expect(await reported("enabled")).toEqual([repository(PROJECT_ID)]);
    expect(await reported(undefined)).toEqual([repository(PROJECT_ID)]);
  });

  it("authorizes a project gone as an answer before failing with GitLab's 404", async () => {
    gitlab.projects.delete(PROJECT_ID);
    const { observations, authorize } = workshop();
    await expect(readRepositoryMetadata(contextOf(), authorize, TARGET)).rejects.toMatchObject({ status: 404 });
    expect(observations).toHaveLength(1);
  });

  it("tells the Workshop nothing when GitLab fails", async () => {
    gitlab.projectStatus = 500;
    const { observations, authorize } = workshop();
    await expect(readRepositoryMetadata(contextOf(), authorize, TARGET)).rejects.toBeInstanceOf(GitLabApiError);
    expect(observations).toEqual([]);
  });
});

describe("RepositoryTreePager", () => {
  const tree = (context: CodeReadContext, authorize: CodeAuthorizer, request: { ref?: string; path?: string; recursive?: boolean } = {}) =>
    new RepositoryTreePager(context, authorize, TARGET, { ...request, pageSize: 50 });

  it("authorizes each page as the repository, an empty one mid-walk included", async () => {
    const pages: Record<number, TreePage> = {
      1: { entries: [{ path: "src/a.ts", type: "blob" }, { path: "src/vendor", type: "commit" }], nextPage: 2 },
      2: { entries: [], nextPage: 3 },
      3: { entries: [{ path: "src/lib", type: "tree" }], nextPage: null },
    };
    gitlab.tree = page => pages[page];
    const { observations, authorize } = workshop();
    const pager = tree(contextOf(), authorize, { path: "src", recursive: true, ref: "v1" });
    expect(await pager.next()).toEqual([{ path: "src/a.ts", type: "file" }]);
    expect(await pager.next()).toEqual([]);
    expect(await pager.next()).toEqual([{ path: "src/lib", type: "directory" }]);
    expect(await pager.next()).toBeNull();
    expect(gitlab.treeRequests).toHaveLength(3);
    expect(Object.fromEntries(gitlab.treeRequests[0]))
      .toEqual({ ref: "v1", path: "src", recursive: "true", page: "1", per_page: "50" });
    expect(observations).toEqual([
      {
        title: `List files in src in ${PROJECT_PATH}`,
        description: `List files recursively in src of the GitLab project ${PROJECT_PATH} at v1.`,
        subresources: [repository(PROJECT_ID)],
      },
      expect.objectContaining({ title: `List files in src in ${PROJECT_PATH} (page 2)`, subresources: [repository(PROJECT_ID)] }),
      expect.objectContaining({ title: `List files in src in ${PROJECT_PATH} (page 3)`, subresources: [repository(PROJECT_ID)] }),
    ]);
  });

  it("authorizes a missing path or ref as an answer, then fails and ends", async () => {
    const { observations, authorize } = workshop();
    const pager = tree(contextOf(), authorize, { path: "nope" });
    await expect(pager.next()).rejects.toThrow(/There is nothing at nope at the default branch in group\/app/);
    expect(observations.map(observation => observation.subresources)).toEqual([[repository(PROJECT_ID)]]);
    expect(await pager.next()).toBeNull();
  });

  it("ends without an observation when a later page is gone", async () => {
    gitlab.tree = page => page === 1 ? { entries: [{ path: "a", type: "blob" }], nextPage: 2 } : null;
    const { observations, authorize } = workshop();
    const pager = tree(contextOf(), authorize);
    expect(await pager.next()).toHaveLength(1);
    expect(await pager.next()).toBeNull();
    expect(observations).toHaveLength(1);
  });

  it("ends at a refused page", async () => {
    gitlab.tree = () => ({ entries: [{ path: "a", type: "blob" }], nextPage: 2 });
    const refusal = new Error("test: refused");
    const pager = tree(contextOf(), workshop(refusal).authorize);
    await expect(pager.next()).rejects.toBe(refusal);
    await expect(pager.next()).rejects.toBe(refusal);
    expect(gitlab.treeRequests).toHaveLength(1);
  });
});

describe("openRepository", () => {
  const projectPathOfUrl = (url: string) => parseResourceUrl(WEB, url)?.projectPath ?? null;

  it("finds a project by id, path or URL, authorizing that answer as one about the instance", async () => {
    const { observations, authorize } = workshop();
    for (const idOrPath of [String(PROJECT_ID), PROJECT_PATH, ` /${PROJECT_PATH}.git/ `, `${WEB}/${PROJECT_PATH}`]) {
      expect(await openRepository(contextOf(), authorize, idOrPath, projectPathOfUrl))
        .toMatchObject({ id: PROJECT_ID, path_with_namespace: PROJECT_PATH });
    }
    expect(observations[0]).toEqual({
      title: `Open GitLab repository ${PROJECT_ID}`,
      description: `Look for the GitLab project ${PROJECT_ID} on ${HOST}.`,
      subresources: [INSTANCE],
    });
    expect(observations.map(observation => observation.subresources)).toEqual(Array.from({ length: 4 }, () => [INSTANCE]));
  });

  it("authorizes finding no project the same way, then fails", async () => {
    const { observations, authorize } = workshop();
    await expect(openRepository(contextOf(), authorize, "acme/missing", projectPathOfUrl))
      .rejects.toThrow(`There is no GitLab project "acme/missing" that this account can read on ${HOST}.`);
    expect(observations).toEqual([{
      title: "Open GitLab repository acme/missing",
      description: `Look for the GitLab project acme/missing on ${HOST}.`,
      subresources: [INSTANCE],
    }]);
  });

  it("fails as the Workshop refuses that answer, found or not, and tells it nothing when GitLab fails", async () => {
    const refusal = new Error("test: refused");
    await expect(openRepository(contextOf(), workshop(refusal).authorize, PROJECT_PATH, projectPathOfUrl)).rejects.toBe(refusal);
    await expect(openRepository(contextOf(), workshop(refusal).authorize, "acme/missing", projectPathOfUrl)).rejects.toBe(refusal);
    gitlab.projectStatus = 502;
    const { observations, authorize } = workshop();
    await expect(openRepository(contextOf(), authorize, "42", projectPathOfUrl)).rejects.toBeInstanceOf(GitLabApiError);
    expect(observations).toEqual([]);
  });

  it("needs a project id or path", async () => {
    await expect(openRepository(contextOf(), workshop().authorize, " ", projectPathOfUrl)).rejects.toThrow(/needs a project id or path/);
  });
});
