// gitlab-graphql.ts: `projects(ids:)` asked in chunks of at most 100 ids, a few at a time; what an
// omitted project means; and the answers that fail rather than deny. GitLab is faked at `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabApi, GitLabApiError, type GitLabInstance } from "../src/gitlab-api";
import { fetchDownloadCode, fetchProjectFacts, fetchRepositoryOpenToAllUsers } from "../src/gitlab-graphql";

const INSTANCE: GitLabInstance = { apiOrigin: "https://gitlab.example.com", headers: {} };
const api = () => new GitLabApi(INSTANCE, async () => "tok-1");

type Call = { url: URL; method: string; body?: { query: string; variables: { ids: string[] } } };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)), method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return await respond(call);
  }));
  return calls;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const gid = (id: number) => `gid://gitlab/Project/${id}`;
const idsOf = (call: Call) => call.body!.variables.ids.map(value => Number(value.slice(gid(0).length - 1)));
const page = (nodes: unknown[], hasNextPage = false) => json({ data: { projects: { nodes, pageInfo: { hasNextPage } } } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDownloadCode", () => {
  it("asks POST /api/graphql in chunks of at most 100 ids, sent as variables, at most six at once", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    // Every query is held until six are in flight, so a seventh started meanwhile would show.
    const sixInFlight = Promise.withResolvers<void>();
    const calls = fakeFetch(async call => {
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      if (inFlight === 6) sixInFlight.resolve();
      await sixInFlight.promise;
      inFlight--;
      return page(idsOf(call).map(id => ({ id: gid(id), userPermissions: { downloadCode: id % 2 === 0 } })));
    });
    const ids = Array.from({ length: 1001 }, (_, index) => index + 1);
    const answers = await fetchDownloadCode(api(), [...ids, 1, 2]);

    expect(calls.every(call => call.method === "POST" && call.url.pathname === "/api/graphql")).toBe(true);
    expect(calls.map(call => idsOf(call).length).toSorted((a, b) => b - a)).toEqual([...Array(10).fill(100), 1]);
    expect(calls.flatMap(idsOf).toSorted((a, b) => a - b)).toEqual(ids);
    expect(calls[0].body!.query).toContain("$ids: [ID!]");
    expect(calls[0].body!.query).not.toContain("gid://");
    expect(mostInFlight).toBe(6);
    expect(answers.size).toBe(1001);
    expect(answers.get(2)).toBe(true);
    expect(answers.get(3)).toBe(false);
  });

  it("denies a project GitLab leaves out of its answer", async () => {
    fakeFetch(() => page([{ id: gid(5), userPermissions: { downloadCode: true } }]));
    expect(await fetchDownloadCode(api(), [5, 6])).toEqual(new Map([[5, true], [6, false]]));
  });

  it("asks nothing for no ids", async () => {
    const calls = fakeFetch(() => page([]));
    expect(await fetchDownloadCode(api(), [])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("fails, rather than deny, when a chunk says there is another page", async () => {
    fakeFetch(() => page([{ id: gid(1), userPermissions: { downloadCode: true } }], true));
    await expect(fetchDownloadCode(api(), [1, 2])).rejects.toThrow(/not one the gatekeeper understands/);
  });

  it("fails with a GitLabApiError, keeping GitLab's text out of its message, when GitLab answers with GraphQL errors", async () => {
    fakeFetch(() => json({ data: null, errors: [{ message: "Project group/secret is broken" }] }));
    const error = await fetchDownloadCode(api(), [1]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(200);
    expect((error as GitLabApiError).message).not.toContain("secret");
  });

  it("fails on a partial answer with errors beside its data", async () => {
    fakeFetch(() => json({
      data: { projects: { nodes: [], pageInfo: { hasNextPage: false } } },
      errors: [{ message: "Timeout" }],
    }));
    await expect(fetchDownloadCode(api(), [1])).rejects.toBeInstanceOf(GitLabApiError);
  });

  it.each([
    ["a project it was not asked about", [{ id: gid(9), userPermissions: { downloadCode: true } }]],
    ["a node without downloadCode", [{ id: gid(1), userPermissions: null }]],
    ["a malformed id", [{ id: "gid://gitlab/Group/1", userPermissions: { downloadCode: true } }]],
  ])("fails on %s", async (_case, nodes) => {
    fakeFetch(() => page(nodes));
    await expect(fetchDownloadCode(api(), [1])).rejects.toThrow();
  });

  it("fails when GitLab fails", async () => {
    fakeFetch(() => json({ message: "500 Internal Server Error" }, 500));
    await expect(fetchDownloadCode(api(), [1])).rejects.toMatchObject({ status: 500 });
  });
});

describe("fetchProjectFacts", () => {
  const node = (id: number, fullPath: string, visibility: string, rootRef: string | null = "main") => ({
    id: gid(id), fullPath, name: fullPath.split("/").pop(), webUrl: `https://gitlab.example.com/${fullPath}`,
    visibility, archived: id === 3, repository: rootRef === null ? null : { rootRef },
  });

  it("reads each visible project's facts from GraphQL alone", async () => {
    const calls = fakeFetch(() => page([node(1, "g/sub/one", "internal"), node(2, "solo", "private", null),
      node(3, "g/three", "public")]));
    const facts = await fetchProjectFacts(api(), [1, 2, 3, 5]);

    expect(facts.get(1)).toEqual({
      id: 1, path: "g/sub/one", name: "one", namespace: "g/sub", url: "https://gitlab.example.com/g/sub/one",
      defaultBranch: "main", visibility: "internal", archived: false,
    });
    expect(facts.get(2)).toMatchObject({ namespace: "", defaultBranch: null, visibility: "private" });
    expect(facts.get(3)).toMatchObject({ visibility: "public", archived: true });
    expect(facts.has(5)).toBe(false);
    expect(calls.map(call => call.url.pathname)).toEqual(["/api/graphql"]);
  });

  it("reads an unrecognised visibility as private", async () => {
    fakeFetch(() => page([node(1, "g/one", "secret")]));
    expect((await fetchProjectFacts(api(), [1])).get(1)?.visibility).toBe("private");
  });

  it("fails when a chunk says there is another page", async () => {
    fakeFetch(() => page([], true));
    await expect(fetchProjectFacts(api(), [1])).rejects.toThrow();
  });
});

describe("fetchRepositoryOpenToAllUsers", () => {
  it("reads each project's repository level from REST, leaving out what is not known", async () => {
    const levels: Record<number, string | undefined> = { 1: "enabled", 2: "private", 3: "disabled", 4: undefined };
    const calls = fakeFetch(call => {
      const id = Number(call.url.pathname.split("/").pop());
      if (id === 5) return json({ message: "404 Project Not Found" }, 404);
      if (id === 6) return json({ message: "boom" }, 500);
      return json({ id, repository_access_level: levels[id] });
    });
    const open = await fetchRepositoryOpenToAllUsers(api(), [1, 2, 3, 4, 5, 6, 1]);
    expect([...open].toSorted()).toEqual([[1, true], [2, false], [3, false]]);
    expect(calls.map(call => call.url.pathname).toSorted())
      .toEqual([1, 2, 3, 4, 5, 6].map(id => `/api/v4/projects/${id}`));
  });
});
