import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraApi } from "../src/jira-api";
import { JiraSiteGatekeeperImpl, JiraProjectGatekeeperImpl, JiraIssueGatekeeperImpl, JiraWorkItemsManagementUI, scopedJql } from "../src/jira";

const ok = (body: unknown) => Response.json(body);
const issue = (key: string) => ({ id: key, key, fields: { summary: key, project: { key: key.split("-")[0] } } });
const api = () => new JiraApi({ cloudId: "cloud-1", webBase: "https://one.atlassian.net", getToken: async () => "token" });
const grantedSites = [
  { id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: ["read:jira-work"] },
  { id: "cloud-2", name: "Two", url: "https://two.atlassian.net", scopes: ["read:jira-work"] },
];
// Two sites are granted by OAuth, but only the selected one may ever be reached.
const account = {
  getAccessToken: async () => "token",
  getAccessTokenForSite: async (cloudId: string) => { if (cloudId !== "cloud-1") throw new Error(`Token requested for unselected site ${cloudId}.`); return "token"; },
  getSelectedSite: async () => grantedSites[0],
  getDefaultProject: async () => null,
  setDefaultProject: async () => null,
  getIdentity: async () => null,
  getSites: async () => grantedSites,
};

function setup(kind: "site" | "project" | "issue" = "project") {
  const gatekeeper = kind === "site" ? new JiraSiteGatekeeperImpl() : kind === "project" ? new JiraProjectGatekeeperImpl() : new JiraIssueGatekeeperImpl();
  const values = new Map<string, unknown>();
  Object.assign(gatekeeper, { ctx: {
    props: { cloudId: "cloud-1", webBase: "https://one.atlassian.net", userObjectId: "owner", projectKey: "ENG", issueKey: "ENG-1" },
    exports: { UserAccount: { idFromString: (s: string) => s, get: () => account } },
    storage: { kv: { get: (key: string) => values.get(key), put: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) } },
  } });
  const queue = {
    authorizeObservation: vi.fn(async (_description: unknown) => {}),
    submitAction: vi.fn(async (id: number, _description: unknown) => { await gatekeeper.applyAction(id); }),
    dup() { return this; },
    [Symbol.dispose]: vi.fn(),
  };
  return { gatekeeper, queue, session: () => gatekeeper.startSession(queue as never) };
}

afterEach(() => vi.unstubAllGlobals());

describe("enhanced Jira search", () => {
  it("posts explicit fields and opaque tokens, without offsets or totals", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok({ issues: [], nextPageToken: "opaque+/=" }));
    vi.stubGlobal("fetch", fetchMock);
    await api().searchIssues("ORDER BY updated DESC", undefined, 10);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/jql");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ jql: 'created >= "1970-01-01" ORDER BY updated DESC', maxResults: 10, fields: expect.arrayContaining(["summary", "project", "status"]) });
    expect(body).not.toHaveProperty("startAt");
    expect(body).not.toHaveProperty("nextPageToken");
    fetchMock.mockResolvedValueOnce(ok({ issues: [], isLast: true, nextPageToken: null }));
    await expect(api().searchIssues("assignee = currentUser()", "opaque+/=", 10)).resolves.toEqual({ issues: [], nextPageToken: undefined });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).nextPageToken).toBe("opaque+/=");
  });

  it.each([
    { issues: [], isLast: false },
    { issues: [], nextPageToken: "same" },
    { issues: [], nextPageToken: 42 },
  ])("rejects broken continuation metadata: %j", async page => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(page)));
    await expect(api().searchIssues("project = ENG", "same", 10)).rejects.toThrow(/Jira search/);
  });

  it("preserves the session signature, continues through short/empty pages, and stops without another fetch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ issues: [issue("ENG-1")], nextPageToken: "second" }))
      .mockResolvedValueOnce(ok({ issues: [], nextPageToken: "third" }))
      .mockResolvedValueOnce(ok({ issues: [issue("ENG-2")], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup();
    const project = await session();
    if (!("searchIssues" in project)) throw new Error("Wrong session");
    const cursor = await project.searchIssues({ maxResults: 50, assignedToMe: true });
    expect(await cursor.next()).toHaveLength(1);
    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toHaveLength(1);
    expect(await cursor.next()).toBeNull();
    expect(await cursor.next()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).nextPageToken)).toEqual([undefined, "second", "third"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).jql).toBe('project = "ENG" AND assignee = currentUser()');
  });

  it("does not advance when observation authorization fails and rejects foreign project results", async () => {
    const fetchMock = vi.fn(async () => ok({ issues: [issue("ENG-1")], nextPageToken: "second" }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup();
    const project = await session();
    if (!("searchIssues" in project)) throw new Error("Wrong session");
    const cursor = await project.searchIssues({});
    queue.authorizeObservation.mockRejectedValueOnce(new Error("Denied"));
    await expect(cursor.next()).rejects.toThrow("Denied");
    expect(await cursor.next()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(ok({ issues: [issue("PAY-1")], isLast: true }));
    await expect(cursor.next()).rejects.toThrow(/outside this project/);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(2);
  });

  it("rejects overlapping cursor advances instead of duplicating a page", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const target = await setup().session();
    if (!("searchIssues" in target)) throw new Error("Wrong session");
    const cursor = await target.searchIssues({});
    const pending = cursor.next();
    await expect(cursor.next()).rejects.toThrow(/previous Jira cursor/);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolve(ok({ issues: [issue("ENG-1")], isLast: true }));
    expect(await pending).toHaveLength(1);
    expect(await cursor.next()).toBeNull();
  });

  it("paginates only the selected site and keeps exhaustion distinct from an unvisited start", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ issues: [issue("ENG-1")], nextPageToken: "more" }))
      .mockResolvedValueOnce(ok({ issues: [issue("ENG-2")], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    const ui = new JiraWorkItemsManagementUI(account);
    const first = await ui.search({ source: "jira", limit: 1 });
    expect(JSON.parse(first.cursors.jira!)).toEqual({ "cloud-1": "more" });
    expect(first.hasMore.jira).toBe(true);
    const second = await ui.search({ source: "jira", limit: 1, cursors: first.cursors });
    expect(second.items[0].id).toBe("https://one.atlassian.net/browse/ENG-2");
    expect(JSON.parse(second.cursors.jira!)).toEqual({ "cloud-1": null });
    expect(second.hasMore.jira).toBe(false);
    expect((await ui.search({ source: "jira", cursors: second.cursors })).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]: [string]) => url.includes("/cloud-1/"))).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).nextPageToken).toBe("more");
    await expect(ui.search({ source: "jira", cursors: { jira: '{"cloud-1":20}' } })).rejects.toThrow(/Restart the search/);
  });
});

describe("Jira identity and workflows", () => {
  it.each(["site", "project"] as const)("returns a privacy-limited current user only after authorization on %s", async kind => {
    const fetchMock = vi.fn(async () => ok({ accountId: "abc", displayName: "Connected user", groups: { secret: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup(kind);
    const target = await session();
    if (!("getCurrentUser" in target)) throw new Error("Wrong session");
    expect(await target.getCurrentUser()).toEqual({ accountId: "abc", displayName: "Connected user" });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/myself$/);
    expect(queue.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({ prohibitAllSharing: true }));
    queue.authorizeObservation.mockRejectedValueOnce(new Error("Denied"));
    await expect(target.getCurrentUser()).rejects.toThrow("Denied");
  });

  it("keeps identity off shared issue-only capabilities and raw JQL off projects", async () => {
    expect(await setup("issue").session()).not.toHaveProperty("getCurrentUser");
    expect(() => scopedJql("ENG", { jql: "assignee = currentUser()" })).toThrow(/Raw JQL/);
    expect(() => scopedJql(undefined, { jql: "project = ENG", assignedToMe: true })).toThrow(/cannot be combined/);
  });

  it("keeps an issue coding search bounded when a text query is present", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok({ issues: [issue("ENG-1")], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup("issue");
    const target = await session();
    if (!("callTool" in target) || typeof target.callTool !== "function") throw new Error("Wrong session");
    await target.callTool("jira_search", { query: 'text "quoted"' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).jql).toBe('issuekey = "ENG-1" AND text ~ "text \\"quoted\\""');
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
  });

  it("discovers transitions and only posts the selected transition through approval", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/transitions")) return init.method === "POST" ? new Response(null, { status: 204 }) : ok({ transitions: [{ id: "31", name: "Complete", to: { id: "100", name: "Done" } }] });
      return ok(issue("ENG-1"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup("issue");
    const target = await session();
    if (!("listTransitions" in target)) throw new Error("Wrong session");
    expect(await target.listTransitions()).toMatchObject([{ id: "31", to: { id: "100", name: "Done" } }]);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
    expect(queue.submitAction).not.toHaveBeenCalled();
    await target.transition("complete", { fields: { assigneeAccountId: "abc" }, commentMarkdown: "Finished" });
    expect(queue.submitAction).toHaveBeenCalledWith(1, expect.objectContaining({ awaitDecision: true, autoApprovable: false }));
    const posts = fetchMock.mock.calls.filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toMatchObject({ transition: { id: "31" }, fields: { assignee: { accountId: "abc" } }, update: { comment: [{ add: { body: { type: "doc" } } }] } });
    await expect(target.transition("100")).rejects.toThrow(/No transition/);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
  });

  it("does not create an issue when approval is denied", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue } = setup();
    queue.submitAction.mockRejectedValueOnce(new Error("Denied"));
    const project = await session();
    if (!("createIssue" in project)) throw new Error("Wrong session");
    await expect(project.createIssue({ issueType: "Task", summary: "Test" })).rejects.toThrow("Denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flattens issue-type status groups and deduplicates by status ID", async () => {
    const status = { id: "1", name: "Open", statusCategory: { key: "new" } };
    vi.stubGlobal("fetch", vi.fn(async () => ok([{ id: "bug", name: "Bug", statuses: [status] }, { id: "task", name: "Task", statuses: [status, { id: "2", name: "Done" }] }])));
    const { session, queue } = setup();
    const project = await session();
    if (!("listStatuses" in project)) throw new Error("Wrong session");
    expect(await project.listStatuses()).toEqual([{ id: "1", name: "Open", category: "new" }, { id: "2", name: "Done" }]);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
  });

  it.each(["site", "project"] as const)("returns a pending session before delayed application and later resolves the real issue on %s", async kind => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/issue") && init.method === "POST") return ok({ id: "100", key: "ENG-42", self: "unused" });
      if (url.includes("/issue/ENG-42?")) return ok(issue("ENG-42"));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue, gatekeeper } = setup(kind);
    queue.submitAction.mockImplementation(async () => {});
    const target = await session();
    if (!("createIssue" in target)) throw new Error("Wrong session");
    const created = await target.createIssue({ projectKey: "ENG", issueType: "Task", summary: "Test" });
    expect(queue.submitAction).toHaveBeenCalledWith(1, expect.objectContaining({ awaitDecision: true, autoApprovable: false }));
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(created.getDetails()).rejects.toThrow(/creation is pending/);
    await expect(created.addComment("Follow-up")).rejects.toThrow(/same issue session/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    await gatekeeper.applyAction(1);
    expect((await created.getDetails()).key).toBe("ENG-42");
    expect((await created.getDetails()).key).toBe("ENG-42");
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it.each(["rejected", "failed"] as const)("reports terminal %s creation without polling or re-creating", async state => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue, gatekeeper } = setup();
    queue.submitAction.mockImplementation(async () => {});
    const target = await session();
    if (!("createIssue" in target)) throw new Error("Wrong session");
    const created = await target.createIssue({ issueType: "Task", summary: "Test" });
    if (state === "rejected") await gatekeeper.rejectAction(1);
    else await expect(gatekeeper.applyAction(1)).rejects.toThrow();
    await expect(created.getDetails()).rejects.toThrow(`creation ${state}`);
    await expect(created.update({ summary: "retry" })).rejects.toThrow(`creation ${state}`);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(state === "failed" ? 1 : 0);
  });

  it("keeps the session pending while the approved create HTTP request is still in flight", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/issue")
      ? new Promise<Response>(resolve => { release = resolve; })
      : ok(issue("ENG-42")));
    vi.stubGlobal("fetch", fetchMock);
    const { session, queue, gatekeeper } = setup();
    queue.submitAction.mockImplementation(async () => {});
    const project = await session();
    if (!("createIssue" in project)) throw new Error("Wrong session");
    const created = await project.createIssue({ issueType: "Task", summary: "Test" });
    const applying = gatekeeper.applyAction(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(created.getDetails()).rejects.toThrow(/creation is pending/);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    release(ok({ id: "42", key: "ENG-42" }));
    await applying;
    expect((await created.getDetails()).key).toBe("ENG-42");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters My work by the OAuth assignee before paginating the selected site", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.jql).toBe('text ~ "urgent" AND assignee = currentUser() ORDER BY updated DESC');
      expect(body.jql).not.toContain("reporter");
      return ok({ issues: [issue("ENG-1")], nextPageToken: body.nextPageToken ? undefined : "next", isLast: !!body.nextPageToken });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ui = new JiraWorkItemsManagementUI(account);
    const first = await ui.search({ source: "jira", query: "urgent", assignedToMe: true, limit: 1 });
    const second = await ui.search({ source: "jira", query: "urgent", assignedToMe: true, limit: 1, cursors: first.cursors });
    expect(second.hasMore.jira).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([expect.stringContaining("cloud-1"), expect.stringContaining("cloud-1")]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).nextPageToken).toBe("next");
  });
});
