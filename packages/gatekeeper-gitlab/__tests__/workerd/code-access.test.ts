// Collaborator verification of code-read access, through the real gatekeeper and UserAccount
// Durable Objects with GitLab faked at `fetch`: `repository/<id>` answered from GraphQL's
// `downloadCode` in batched queries, `instance/<host>` from `GET /user`, how long each answer is
// reused, and what fails rather than deny.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGitLab, WEB, hooks, json, projectProps, seedAccount, type FakeRequest } from "./fake-gitlab";

const OWNER_TOKEN = "owner-token";
const HOST = new URL(WEB).host;
const INSTANCE = `instance/${HOST}`;
const DAY = 24 * 60 * 60_000;

const repository = (id: number) => `repository/${id}`;

function tokenOf(request: FakeRequest): string {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

/**
 * GitLab as each token's user sees it: the projects whose code it may download, those it sees but
 * may not download, and its `/user` state; every other project is invisible to it.
 */
class CodeAccessGitLab extends FakeGitLab {
  readonly users = new Map<string, {
    downloadable: Set<number>; visible: Set<number>; state: string; external: boolean;
  }>();
  /** What a GraphQL query is answered with instead, while set. */
  graphqlOverride: ((ids: number[]) => Response) | undefined;

  constructor() {
    super();
    this.on("POST", /^\/api\/graphql$/, request => this.#graphql(request));
    this.on("GET", /^\/api\/v4\/user$/, request => {
      const user = this.users.get(tokenOf(request));
      return user
        ? json({ id: 7, username: "u", name: "u", web_url: `${WEB}/u`, state: user.state, external: user.external })
        : json({ message: "401 Unauthorized" }, { status: 401 });
    });
  }

  user(token: string, options: { downloadable?: number[]; visible?: number[]; state?: string; external?: boolean } = {}) {
    this.users.set(token, {
      downloadable: new Set(options.downloadable ?? []),
      visible: new Set([...options.visible ?? [], ...options.downloadable ?? []]),
      state: options.state ?? "active",
      external: options.external ?? false,
    });
  }

  /** The project ids of each GraphQL query `token` sent, in order. */
  queriesWith(token: string): number[][] {
    return this.requests
      .filter(request => request.url.pathname === "/api/graphql" && tokenOf(request) === token)
      .map(request => idsOf(request));
  }

  /** How many `GET /user` requests `token` sent. */
  userReadsWith(token: string): number {
    return this.requests.filter(request => request.url.pathname === "/api/v4/user" && tokenOf(request) === token).length;
  }

  #graphql(request: FakeRequest): Response {
    const ids = idsOf(request);
    if (this.graphqlOverride) return this.graphqlOverride(ids);
    const user = this.users.get(tokenOf(request));
    if (!user) return json({ message: "401 Unauthorized" }, { status: 401 });
    // GitLab answers in its own order and leaves out what the user can't see.
    const nodes = ids.filter(id => user.visible.has(id)).toReversed().map(id => ({
      id: `gid://gitlab/Project/${id}`, userPermissions: { downloadCode: user.downloadable.has(id) },
    }));
    return json({ data: { projects: { nodes, pageInfo: { hasNextPage: false } } } });
  }
}

function idsOf(request: FakeRequest): number[] {
  const { variables } = JSON.parse(request.body ?? "{}") as { variables: { ids: string[] } };
  return variables.ids.map(gid => Number(gid.replace("gid://gitlab/Project/", "")));
}

/** A connected account whose token is `token`, lasting past the day-long grants the tests wait out. */
const account = (token: string) => seedAccount({ accessToken: token, expiresInMs: 3 * DAY });

let scenarios = 0;

/** A project binding by the owner's account, whose verifyObserverAccess the tests ask. */
async function binding() {
  const name = `code-access-${++scenarios}`;
  const props = projectProps(await account(OWNER_TOKEN), "group/sub/project");
  return {
    verify: (observers: Record<string, string>, subresources: string[]) => hooks().verifyObservers(
      name, props, Object.entries(observers).map(([id, userObjectId]) => ({ id, userObjectId })), subresources),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("repository access", () => {
  it("allows an observer GitLab lets download every repository, asking with their own token", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const [reader, partial, guest, outsider] = await Promise.all(
      ["reader", "partial", "guest", "outsider"].map(token => account(token)));
    gitlab.user("reader", { downloadable: [1, 2] });
    gitlab.user("partial", { downloadable: [1] });
    // Sees project 2 but may not read its code (a Guest, or a members-only repository).
    gitlab.user("guest", { downloadable: [1], visible: [2] });
    gitlab.user("outsider");
    const gk = await binding();

    expect(await gk.verify({ reader, partial, guest, outsider }, [repository(1), repository(2)]))
      .toEqual({ ok: ["reader"] });
    // A project GitLab leaves out of the answer is a denial, not a failure.
    expect(gitlab.queriesWith("outsider")).toEqual([[1, 2]]);
    expect(gitlab.queriesWith(OWNER_TOKEN)).toEqual([]);
  });

  it("asks about at most 100 projects per query, and only about those not already answered", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const ids = Array.from({ length: 250 }, (_, index) => index + 1);
    const alice = await account("alice");
    gitlab.user("alice", { downloadable: ids });

    expect(await hooks().checkSubresourceAccess(alice, ids.slice(0, 10).map(repository)))
      .toEqual({ ok: Array(10).fill(true) });
    expect(await hooks().checkSubresourceAccess(alice, ids.map(repository))).toEqual({ ok: Array(250).fill(true) });

    const queries = gitlab.queriesWith("alice");
    expect(queries[0]).toEqual(ids.slice(0, 10));
    const later = queries.slice(1);
    expect(later.map(query => query.length).toSorted((a, b) => b - a)).toEqual([100, 100, 40]);
    expect(later.flat().toSorted((a, b) => a - b)).toEqual(ids.slice(10));
  });

  it("answers in the order asked, mixing repositories and the instance", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.user("alice", { downloadable: [5], visible: [6] });

    expect(await hooks().checkSubresourceAccess(alice, [repository(6), INSTANCE, repository(5), repository(6)]))
      .toEqual({ ok: [false, true, true, false] });
    expect(gitlab.queriesWith("alice")).toEqual([[6, 5]]);
  });

  it("reuses a grant for a day and a denial for 15 seconds", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.user("alice", { downloadable: [1] });
    gitlab.user("bob");
    // Two bindings share each account's answers.
    const [first, second] = [await binding(), await binding()];
    const start = Date.now();
    const at = (offset: number) => vi.setSystemTime(start + offset);
    const asked = (token: string) => gitlab.queriesWith(token).length;

    expect(await first.verify({ alice, bob }, [repository(1)])).toEqual({ ok: ["alice"] });
    at(14_000);
    expect(await second.verify({ alice, bob }, [repository(1)])).toEqual({ ok: ["alice"] });
    expect([asked("alice"), asked("bob")]).toEqual([1, 1]);

    // Bob gains access, and alice loses it.
    gitlab.user("bob", { downloadable: [1] });
    gitlab.user("alice");
    at(16_000);
    expect(await first.verify({ alice, bob }, [repository(1)])).toEqual({ ok: ["alice", "bob"] });
    // Alice's revoked grant is still served until the day is up.
    at(DAY - 1_000);
    expect(await first.verify({ alice, bob }, [repository(1)])).toEqual({ ok: ["alice", "bob"] });
    at(DAY + 1_000);
    expect(await first.verify({ alice, bob }, [repository(1)])).toEqual({ ok: ["bob"] });
    expect([asked("alice"), asked("bob")]).toEqual([2, 2]);
  });

  it.each([
    ["GraphQL errors", () => json({ data: { projects: null }, errors: [{ message: "Internal server error" }] })],
    ["another page", () => json({ data: { projects: { nodes: [], pageInfo: { hasNextPage: true } } } })],
    ["a project it was not asked about", () => json({ data: { projects: {
      nodes: [{ id: "gid://gitlab/Project/99", userPermissions: { downloadCode: true } }],
      pageInfo: { hasNextPage: false },
    } } })],
    ["an outage", () => json({ message: "500 Internal Server Error" }, { status: 500 })],
  ])("fails, denying no one for good, when GitLab answers with %s", async (_case, answer) => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.user("alice", { downloadable: [1] });
    const gk = await binding();

    gitlab.graphqlOverride = answer;
    const failed = await gk.verify({ alice }, [repository(1)]);
    expect(failed).toEqual({ error: expect.any(String) });
    // GitLab's own error text is not passed on.
    expect(JSON.stringify(failed)).not.toContain("Internal server error");
    // Not remembered: once GitLab answers, alice is allowed.
    gitlab.graphqlOverride = undefined;
    expect(await gk.verify({ alice }, [repository(1)])).toEqual({ ok: ["alice"] });
  });
});

describe("instance access", () => {
  it("allows only an active, non-external user of the instance", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const [member, external, blocked, deactivated] = await Promise.all(
      ["member", "external", "blocked", "deactivated"].map(token => account(token)));
    gitlab.user("member");
    gitlab.user("external", { external: true });
    gitlab.user("blocked", { state: "blocked" });
    gitlab.user("deactivated", { state: "deactivated" });
    const gk = await binding();

    expect(await gk.verify({ member, external, blocked, deactivated }, [INSTANCE])).toEqual({ ok: ["member"] });
  });

  it("reuses a grant for a day and a denial for 15 seconds", async () => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.user("alice");
    gitlab.user("bob", { external: true });
    const gk = await binding();
    const start = Date.now();
    const at = (offset: number) => vi.setSystemTime(start + offset);

    expect(await gk.verify({ alice, bob }, [INSTANCE])).toEqual({ ok: ["alice"] });
    gitlab.user("alice", { external: true });
    gitlab.user("bob");
    at(16_000);
    expect(await gk.verify({ alice, bob }, [INSTANCE])).toEqual({ ok: ["alice", "bob"] });
    at(DAY + 1_000);
    expect(await gk.verify({ alice, bob }, [INSTANCE])).toEqual({ ok: ["bob"] });
    expect([gitlab.userReadsWith("alice"), gitlab.userReadsWith("bob")]).toEqual([2, 2]);
  });
});

describe("refusals", () => {
  it.each([
    "instance/other.example.com", "instance/GITLAB.EXAMPLE.COM", "instance/gitlab.example.com%3A443",
    "repository/042", "repository/0", "repository/abc", "repository/1/role/developer", "gitlab/repository/1",
    "instance", "repository",
  ])("refuses the whole call for %s, asking no one", async id => {
    const gitlab = new CodeAccessGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.user("alice", { downloadable: [1] });
    const gk = await binding();

    expect(await gk.verify({ alice }, [repository(1), id])).toEqual({ error: expect.any(String) });
    expect(gitlab.requests).toEqual([]);
  });
});
