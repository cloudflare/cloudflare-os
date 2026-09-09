import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraApi, markdownToAdf } from "../src/jira-api";
import { JIRA_CODING_TOOLS, JiraWorkItemUI, JiraWorkItemsManagementUI, scopedJql, UserAccount } from "../src/jira";

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Jira API action behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps types.txt as an actual symlink", () => {
    expect(lstatSync(resolve(import.meta.dirname, "../src/types.txt")).isSymbolicLink()).toBe(true);
  });

  it("sends issue updates only through api.atlassian.com with JSON bodies", async () => {
    const fetchMock = vi.fn(async () => ok(undefined));
    vi.stubGlobal("fetch", fetchMock);
    await new JiraApi({ cloudId: "cloud-1", webBase: "https://acme.atlassian.net", getToken: async () => "tok" })
      .updateIssue("ENG-1", { summary: "Fixed" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ENG-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ fields: { summary: "Fixed" } });
  });

  it("posts comments as ADF documents", async () => {
    const fetchMock = vi.fn(async () => ok({ id: "10000" }));
    vi.stubGlobal("fetch", fetchMock);
    const body = markdownToAdf("hello");
    await new JiraApi({ cloudId: "cloud-1", webBase: "https://acme.atlassian.net", getToken: async () => "tok" })
      .addComment("ENG-1", body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ body });
  });

  it("rejects raw project-scoped JQL before any out-of-project query is sent", async () => {
    const fetchMock = vi.fn(async () => ok({ issues: [] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(() => scopedJql("ENG", { jql: "status = Done) OR project = PAY OR (project = ENG" })).toThrow(/Raw JQL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps raw JQL available for site-scoped searches", () => {
    expect(scopedJql(undefined, { jql: "project = ENG ORDER BY updated DESC" })).toBe("project = ENG ORDER BY updated DESC");
    expect(() => scopedJql(undefined, { jql: "project = ENG", text: "open" })).toThrow(/cannot be combined/);
  });

  it("quotes generated JQL literals and rejects invalid project keys", () => {
    expect(scopedJql("ENG", { text: 'status "done"' })).toBe('project = "ENG" AND text ~ "status \\"done\\""');
    expect(() => scopedJql("ENG) OR project = PAY", { text: "done" })).toThrow(/Invalid Jira project key/);
  });

  it("creates remote links through Jira's remote-link endpoint", async () => {
    const fetchMock = vi.fn(async () => ok({ id: "1" }));
    vi.stubGlobal("fetch", fetchMock);
    await new JiraApi({ cloudId: "cloud-1", webBase: "https://acme.atlassian.net", getToken: async () => "tok" })
      .createRemoteLink("ENG-1", { globalId: "work-items:x", object: { url: "https://example.invalid/1", title: "Example" } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ENG-1/remotelink");
    expect(init.method).toBe("POST");
  });

  it("only downloads attachment bearer URLs from the connected site or Atlassian API host", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200, headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new JiraApi({ cloudId: "cloud-1", webBase: "https://acme.atlassian.net", getToken: async () => "tok" });

    await expect(api.downloadAttachment("https://evil.atlassian.net/secure/attachment/1/pwn.txt")).rejects.toThrow(/Unexpected attachment host/);
    await expect(api.downloadAttachment("https://api.atlassian.com/ex/jira/cloud-2/rest/api/3/attachment/content/1")).rejects.toThrow(/Unexpected attachment host/);
    await expect(api.downloadAttachment("https://acme.atlassian.net/secure/attachment/1/ok.txt")).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("advertises Work Items description updates and converts them to Jira ADF", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/issue/ENG-1/comment")) return ok({ comments: [] });
      if (url.includes("/issue/ENG-1/transitions")) return ok({ transitions: [] });
      if (url.includes("/issue/ENG-1") && init?.method === "PUT") return ok(undefined);
      if (url.includes("/issue/ENG-1")) return ok(issue("ENG-1", "old"));
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new JiraApi({ cloudId: "cloud-1", webBase: "https://acme.atlassian.net", getToken: async () => "tok" });
    const ui = new JiraWorkItemUI(api, { getSites: async () => [], getAccessToken: async () => "tok", getAccessTokenForSite: async () => "tok", getSelectedSite: async () => null, getIdentity: async () => null, getDefaultProject: async () => null, setDefaultProject: async () => null }, "https://acme.atlassian.net", "ENG-1");

    const read = await ui.read();
    expect(read.updateOptions.allowedFields).toContain("description");
    expect(read.updateOptions.allowedFields).not.toContain("descriptionMarkdown");
    await ui.updateFields({ fields: { description: "new description" } });

    const updateCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/issue/ENG-1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(updateCall).toBeDefined();
    if (!updateCall) throw new Error("Missing Jira issue update request.");
    expect(JSON.parse(String((updateCall[1] as RequestInit).body))).toEqual({ fields: { description: markdownToAdf("new description") } });
  });

  it("publishes Workshop-compatible coding-session tool metadata", () => {
    expect(JIRA_CODING_TOOLS.every(tool => tool.mode === "read" || tool.mode === "action")).toBe(true);
    expect(JIRA_CODING_TOOLS.find(tool => tool.name === "jira_search")).toMatchObject({
      mode: "read",
      classifiedBy: "server-annotation",
    });
    expect(JIRA_CODING_TOOLS.find(tool => tool.name === "jira_update_issue")).toMatchObject({
      mode: "action",
      classifiedBy: "default",
    });
  });

  it("keeps Jira Work Items refs on the selected site and refuses refs from other granted sites", async () => {
    const selected = { id: "cloud-2", name: "Two", url: "https://two.atlassian.net", scopes: ["read:jira-work"] };
    const account = {
      getSites: async () => [{ id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: ["read:jira-work"] }, selected],
      getAccessToken: async () => "tok",
      getAccessTokenForSite: async (cloudId: string) => { if (cloudId !== "cloud-2") throw new Error(`Token requested for unselected site ${cloudId}.`); return "tok"; },
      getSelectedSite: async () => selected,
      getIdentity: async () => null,
      getDefaultProject: async () => null,
      setDefaultProject: async () => null,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/cloud-2/") && url.endsWith("/search/jql")) return ok({ issues: [issue("ENG-2", "Second site")], isLast: true });
      if (url.includes("/cloud-2/") && url.includes("/issue/ENG-2")) return ok(issue("ENG-2", "Second site", [{ id: "att-2", filename: "note.txt", mimeType: "text/plain", size: 2, content: "https://two.atlassian.net/secure/attachment/att-2/note.txt" }]));
      if (url === "https://two.atlassian.net/secure/attachment/att-2/note.txt") return new Response("ok", { status: 200, headers: { "content-length": "2" } });
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ui = new JiraWorkItemsManagementUI(account);
    const page = await ui.search({ source: "jira", limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "https://two.atlassian.net/browse/ENG-2", key: "ENG-2" });
    expect(page.items[0].description).toEqual({ body: "Second site", format: "markdown", providerFormat: "jira-adf" });

    const item = await ui.item(page.items[0]);
    await expect(item.readAttachment("att-2")).resolves.toMatchObject({ name: "note.txt", contentType: "text/plain" });
    await expect(ui.item({ source: "jira", id: "https://one.atlassian.net/browse/ENG-9" })).rejects.toThrow(/limited to two\.atlassian\.net/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/cloud-1/"))).toBe(false);
  });

  it("persists, returns, and clears a validated default Jira project", async () => {
    const account = makeStoredAccount();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/cloud-1/rest/api/3/project/ENG")) return ok({ id: "100", key: "ENG", name: "Engineering" });
      throw new Error(`unexpected URL ${url}`);
    }));

    await expect(account.getDefaultProject()).resolves.toBeNull();
    await expect(account.setDefaultProject("https://one.atlassian.net/projects/ENG")).resolves.toEqual({
      cloudId: "cloud-1",
      webBase: "https://one.atlassian.net",
      projectKey: "ENG",
      projectName: "Engineering",
    });
    await expect(account.getDefaultProject()).resolves.toMatchObject({ projectKey: "ENG" });
    await expect(account.setDefaultProject(null)).resolves.toBeNull();
    await expect(account.getDefaultProject()).resolves.toBeNull();
  });

  it("denies a default project outside the selected Jira site", async () => {
    const account = makeStoredAccount();
    vi.stubGlobal("fetch", vi.fn(async () => ok({ id: "200", key: "PAY", name: "Payments" })));

    await expect(account.setDefaultProject("https://two.atlassian.net/projects/PAY"))
      .rejects.toThrow(/selected Jira site/);
  });
});

function issue(key: string, description: string, attachment = []) {
  return {
    id: key.replace("-", ""),
    key,
    fields: {
      summary: key,
      description: markdownToAdf(description),
      project: { id: "100", key: key.split("-")[0], name: "Engineering" },
      attachment,
    },
  };
}

function makeStoredAccount(): UserAccount {
  const account = new UserAccount();
  const kv = new Map<string, unknown>([
    ["grant", { accessToken: "tok", refreshToken: "refresh", expiresAt: Date.now() + 60_000 }],
    ["sites", [{ id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: ["read:jira-work"] }]],
  ]);
  Object.assign(account, {
    env: { CLIENT_ID: "client", CLIENT_SECRET: "secret" },
    ctx: {
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => kv.set(key, value),
          delete: (key: string) => kv.delete(key),
        },
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn(),
      },
    },
  });
  return account;
}
