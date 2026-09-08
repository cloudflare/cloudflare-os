import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraConfiguratorUI } from "../src/jira-configurators";
import projectConfigurator from "../src/configurator/jira-project-configurator-ui";

const sites = [
  { id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: ["read:jira-work"] },
  { id: "cloud-2", name: "Two", url: "https://two.atlassian.net", scopes: ["read:jira-work"] },
];

describe("Jira project configurator", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searches project names and keys on Jira instead of filtering only the first page", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      values: [{ id: "1", key: "PLATFORM", name: "Platform" }],
      isLast: true,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const options = await new JiraConfiguratorUI(async () => [sites[0]], async () => "token")
      .listProjects("platform");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/project/search?startAt=0&maxResults=50&query=platform",
    );
    expect(options).toEqual([{
      value: "https://one.atlassian.net/projects/PLATFORM",
      title: "Platform",
      subtitle: "PLATFORM · One",
    }]);
  });

  it("retains projects from healthy sites when another Jira site fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/cloud-1/")) return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({
        values: [{ id: "2", key: "ENG", name: "Engineering" }],
        isLast: true,
      }), { status: 200 });
    }));

    await expect(new JiraConfiguratorUI(async () => sites, async () => "token").listProjects("eng"))
      .resolves.toEqual([{
        value: "https://two.atlassian.net/projects/ENG",
        title: "Engineering",
        subtitle: "ENG · Two",
      }]);
  });

  it("stops querying sites after collecting the bounded option limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      values: Array.from({ length: 50 }, (_, index) => ({
        id: String(index),
        key: `P${index}`,
        name: `Project ${index}`,
      })),
      isLast: true,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const options = await new JiraConfiguratorUI(async () => sites, async () => "token")
      .listProjects("");

    expect(options).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains issue results from healthy sites when another Jira site fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/cloud-1/")) return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({
        issues: [{ id: "2", key: "ENG-2", fields: { summary: "Healthy site" } }],
        total: 1,
      }), { status: 200 });
    }));

    await expect(new JiraConfiguratorUI(async () => sites, async () => "token").listIssues("healthy"))
      .resolves.toEqual([{
        value: "https://two.atlassian.net/browse/ENG-2",
        title: "ENG-2: Healthy site",
        subtitle: "Two",
      }]);
  });

  it("stops querying sites after collecting the bounded issue option limit", async () => {
    const manySites = Array.from({ length: 4 }, (_, index) => ({
      id: `cloud-${index}`,
      name: `Site ${index}`,
      url: `https://site-${index}.atlassian.net`,
      scopes: ["read:jira-work"],
    }));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { maxResults } = JSON.parse(String(init?.body)) as { maxResults: number };
      return new Response(JSON.stringify({
        issues: Array.from({ length: maxResults }, (_, index) => ({
          id: String(index),
          key: `ENG-${index + 1}`,
          fields: { summary: `Issue ${index + 1}` },
        })),
        total: maxResults,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const options = await new JiraConfiguratorUI(async () => manySites, async () => "token")
      .listIssues("");

    expect(options).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("round-trips the optional default project through the configurator RPC", async () => {
    const defaultProject = { value: "https://one.atlassian.net/projects/ENG", title: "Engineering", subtitle: "ENG · One" };
    const setDefaultProject = vi.fn(async () => defaultProject);
    const ui = new JiraConfiguratorUI(async () => sites, async () => "token", {
      getDefaultProject: async () => defaultProject,
      setDefaultProject,
    });

    await expect(ui.getDefaultProject()).resolves.toEqual(defaultProject);
    await expect(ui.setDefaultProject("https://one.atlassian.net/projects/ENG")).resolves.toEqual(defaultProject);
    expect(setDefaultProject).toHaveBeenCalledWith("https://one.atlassian.net/projects/ENG");
  });

  it("keeps old accounts without a default project as null", async () => {
    await expect(new JiraConfiguratorUI(async () => sites, async () => "token").getDefaultProject())
      .resolves.toBeNull();
  });

  it("keeps an explicit project URL prefill ahead of any default project", async () => {
    expect(await projectConfigurator.initialValuesFromResourceUrl?.({
      resourceUrl: "https://two.atlassian.net/projects/PAY",
      resourceUrlPattern: "https://*.atlassian.net/projects/:projectKey{/:rest}*",
      ui: new JiraConfiguratorUI(async () => sites, async () => "token", {
        getDefaultProject: async () => ({ value: "https://one.atlassian.net/projects/ENG", title: "Engineering" }),
        setDefaultProject: async () => null,
      }),
    })).toEqual({ projectUrl: "https://two.atlassian.net/projects/PAY", defaultProjectLoadState: "loaded" });
  });
});
