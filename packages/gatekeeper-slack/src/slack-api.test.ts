import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode, SlackApi, SlackApiError } from "./slack-api";

afterEach(() => vi.unstubAllGlobals());

const requests: URL[] = [];
let grantedTeams = ["TONE", "TTWO"];
let memberTeams = ["TONE", "TTWO"];
let channel: Record<string, unknown>;

function mockSlack(org = true) {
  requests.length = 0;
  grantedTeams = ["TONE", "TTWO"];
  memberTeams = ["TONE", "TTWO"];
  channel = { id: "CONE", name: "general", shared_team_ids: ["TONE"] };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    let url = new URL(input);
    requests.push(url);
    let method = url.pathname.split("/").pop();
    let team = url.searchParams.get("team_id");
    let result: Record<string, unknown>;
    switch (method) {
      case "auth.test":
        result = { team_id: org ? "EORG" : "TONE", enterprise_id: "EORG", user_id: "WSELF",
          url: org ? "https://enterprise.slack.com/" : "https://tone.slack.com/" }; break;
      case "users.info":
        result = { user: { id: url.searchParams.get("user"), name: "ddr",
          enterprise_user: { teams: memberTeams } } }; break;
      case "auth.teams.list":
        result = url.searchParams.has("cursor")
            ? { teams: grantedTeams.slice(1).map(id => ({ id, name: id })) }
            : { teams: grantedTeams.slice(0, 1).map(id => ({ id, name: id })),
              response_metadata: { next_cursor: "second-page" } }; break;
      case "team.info": {
        let domain = url.searchParams.get("domain");
        if (!org && domain) {
          result = { ok: false, error: "team_not_on_enterprise" }; break;
        }
        let id = url.searchParams.get("team") || (domain ? domain.toUpperCase() : "EORG");
        result = { team: { id, name: id, domain: id.toLowerCase() } }; break;
      }
      case "users.list":
        result = team ? { members: [{ id: "WSELF", name: "ddr" }] } :
            { ok: false, error: "missing_argument" }; break;
      case "users.conversations":
      case "conversations.list":
        result = team ? { channels: [{ id: "DONE", is_im: true, user: "WPEER" }] } :
            { ok: false, error: "missing_argument" }; break;
      case "conversations.info": result = { channel }; break;
      case "conversations.history":
      case "conversations.replies": result = { messages: [{ ts: "123.000001", text: "test" }] }; break;
      case "conversations.members": result = { members: ["WSELF"] }; break;
      case "search.messages": result = team ? { messages: { matches: [{ ts: "123.000001",
        text: "test", channel: { id: "CONE" } }], paging: { page: 1, pages: 1 } } } :
        { ok: false, error: "missing_argument" }; break;
      default: throw new Error(`Unexpected method ${method}`);
    }
    return Response.json({ ok: true, ...result });
  }));
}

const api = (teamId = "TONE") => new SlackApi(async () => "test-token").forWorkspace(teamId);

function mockCredentialChange() {
  mockSlack();
  let token = "org-token";
  let fetchSlack = fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") !== "Bearer workspace-token") {
      return fetchSlack(input, init);
    }
    let url = new URL(input);
    requests.push(url);
    switch (url.pathname.split("/").pop()) {
      case "auth.test":
        return Response.json({ ok: true, team_id: "TTWO", user_id: "WSELF", is_enterprise_install: false });
      case "team.info":
        return Response.json({ ok: true, team: { id: "TTWO", name: "Two", domain: "ttwo" } });
      // Slack ignores team_id on these endpoints for workspace-installed credentials.
      case "users.list":
        return Response.json({ ok: true, members: [{ id: "WFOREIGN", name: "foreign" }] });
      case "users.conversations":
        return Response.json({ ok: true, channels: [{ id: "DFOREIGN", is_im: true }] });
      default: throw new Error("Unexpected workspace-token request");
    }
  }));
  return {
    client: new SlackApi(async () => token).forWorkspace("TONE"),
    reconnect: () => { token = "workspace-token"; },
  };
}

describe("Slack org installations", () => {
  it("retains enterprise identity while keeping the per-user token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, team: null,
      enterprise: { id: "EORG", name: "Org" }, is_enterprise_install: true,
      access_token: "bot-must-not-be-used", authed_user: { id: "WSELF", access_token: "user-token",
        refresh_token: "user-refresh", scope: "users:read,search:read" } })));
    let grant = await exchangeAuthCode("code", "client", "secret", "https://test/oauth");
    expect(grant).toMatchObject({ teamId: "", enterpriseId: "EORG", isEnterpriseInstall: true,
      accessToken: { token: "user-token" }, refreshToken: "user-refresh" });
  });

  it("intersects all app-granted pages with the user's workspace membership", async () => {
    mockSlack();
    grantedTeams = ["TONE", "TTWO", "TOTHER"];
    memberTeams = ["TTWO", "TNOTGRANTED"];
    expect(await new SlackApi(async () => "token").listWorkspaces()).toEqual([{ id: "TTWO", name: "TTWO" }]);
    expect(requests.filter(url => url.pathname.endsWith("auth.teams.list"))).toHaveLength(2);
  });

  it("fails closed when enterprise membership is unknown", async () => {
    mockSlack(); memberTeams = [];
    expect(await new SlackApi(async () => "token").listWorkspaces()).toEqual([]);
    await expect(api().getWorkspaceInfo()).rejects.toMatchObject({ code: "team_access_not_granted" });
  });

  it("routes workspace metadata, discovery, members and search to the chosen workspace", async () => {
    mockSlack(); let client = api();
    await client.getWorkspaceInfo();
    await client.listUserConversations(["im", "mpim"], "page", 50);
    await client.listUsers(undefined, 20);
    await client.searchMessages("gatekeeper", undefined, 10);
    let info = requests.find(url => url.pathname.endsWith("team.info"));
    expect(info?.searchParams.get("team")).toBe("TONE");
    for (let method of ["users.conversations", "users.list", "search.messages"]) {
      expect(requests.find(url => url.pathname.endsWith(method))?.searchParams.get("team_id")).toBe("TONE");
    }
    expect(requests.find(url => url.pathname.endsWith("users.conversations"))?.searchParams.get("cursor")).toBe("page");
  });

  it("keeps workspace-installed user tokens working", async () => {
    mockSlack(false);
    await api().listUsers(undefined, 10);
    expect(requests.some(url => url.pathname.endsWith("auth.teams.list"))).toBe(false);
  });

  it.each(["users", "conversations"])("rechecks changed credentials before listing %s", async resource => {
    let { client, reconnect } = mockCredentialChange();
    let read = () => resource === "users" ? client.listUsers(undefined, 10) :
        client.listUserConversations(["im"], undefined, 10);
    await read();
    let method = resource === "users" ? "users.list" : "users.conversations";
    let before = requests.filter(url => url.pathname.endsWith(method)).length;
    reconnect();
    await expect(read()).rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(requests.filter(url => url.pathname.endsWith(method))).toHaveLength(before);
  });

  it("checks the actual read credential even when it changes during workspace validation", async () => {
    let { client, reconnect } = mockCredentialChange();
    let fetchSlack = fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      let response = await fetchSlack(input, init);
      let url = new URL(input);
      if (url.pathname.endsWith("auth.teams.list") && url.searchParams.has("cursor")) reconnect();
      return response;
    });
    await expect(client.listUsers(undefined, 10)).rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(requests.some(url => url.pathname.endsWith("users.list"))).toBe(false);
  });

  it("rechecks replacement credentials before retrying a rate-limited read", async () => {
    let { client, reconnect } = mockCredentialChange();
    let fetchSlack = fetch;
    let reads = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.includes("users.list") && reads++ === 0) {
        reconnect();
        return Response.json({ ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": "0.001" } });
      }
      return fetchSlack(input, init);
    });
    await expect(client.listUsers(undefined, 10)).rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(reads).toBe(1);
  });

  it("coalesces concurrent access checks and reuses only the same credential's proof", async () => {
    mockSlack();
    let fetchSlack = fetch;
    let started = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    let checks = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.includes("auth.test")) {
        checks++;
        started.resolve();
        await release.promise;
      }
      return fetchSlack(input, init);
    });
    let token = "first-token";
    let selectWorkspace = vi.fn(async () => "TONE");
    let client = new SlackApi(async () => token, { teamId: selectWorkspace });
    let concurrent = Promise.all([client.workspaceTeamId(), client.workspaceTeamId()]);
    await started.promise;
    expect(checks).toBe(1);
    release.resolve();
    expect(await concurrent).toEqual(["TONE", "TONE"]);
    await client.listUsers(undefined, 10);
    expect(checks).toBe(1);
    token = "rotated-token";
    await client.listUsers(undefined, 10);
    expect(checks).toBe(2);
    expect(selectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not evict a newer credential's proof when an older concurrent check fails", async () => {
    mockSlack();
    let fetchSlack = fetch;
    let started = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    let currentChecks = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.includes("auth.test")) {
        if (new Headers(init?.headers).get("Authorization") === "Bearer old-token") {
          started.resolve();
          await release.promise;
          throw new Error("old check failed");
        }
        currentChecks++;
      }
      return fetchSlack(input, init);
    });
    let token = "old-token";
    let client = new SlackApi(async () => token).forWorkspace("TONE");
    let old = expect(client.workspaceTeamId()).rejects.toThrow("old check failed");
    await started.promise;
    token = "current-token";
    expect(await client.workspaceTeamId()).toBe("TONE");
    release.resolve();
    await old;
    expect(await client.workspaceTeamId()).toBe("TONE");
    expect(currentChecks).toBe(1);
  });

  it.each(["network", "rate-limit"])("retries workspace checks after a %s failure without repinning", async failure => {
    mockSlack();
    let fetchSlack = fetch;
    let failing = true;
    let selectWorkspace = vi.fn(async () => "TONE");
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (failing && input.includes("auth.test")) {
        if (failure === "network") throw new Error("temporary failure");
        return Response.json({ ok: false, error: "ratelimited" },
            { status: 429, headers: { "Retry-After": "0.001" } });
      }
      return fetchSlack(input, init);
    });
    let client = new SlackApi(async () => "token", { teamId: selectWorkspace });
    await expect(client.listUsers(undefined, 10)).rejects.toThrow();
    failing = false;
    await expect(client.listUsers(undefined, 10)).resolves.toMatchObject({ items: [{ id: "WSELF" }] });
    expect(selectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not collapse a workspace installation inside an enterprise into an org account", async () => {
    mockSlack(false);
    let client = new SlackApi(async () => "token");
    expect((await client.getAccountDescription("WSELF",
        { teamId: "TONE", isEnterpriseInstall: false, enterpriseId: "EORG" })).uniqueName)
        .toBe("ddr@tone.slack.com");
    mockSlack();
    expect((await client.getAccountDescription("WSELF",
        { teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" })).uniqueName)
        .toBe("WSELF@EORG");
  });

  it("resolves a thread host only to a workspace granted to both app and user", async () => {
    mockSlack();
    let client = new SlackApi(async () => "token");
    expect(await client.workspaceIdForDomain("ttwo")).toBe("TTWO");
    expect(requests.find(url => url.pathname.endsWith("team.info"))?.searchParams.get("domain"))
        .toBe("ttwo");
    await expect(client.workspaceIdForDomain("tforeign")).rejects.toMatchObject({ code: "team_access_not_granted" });
  });

  it.each([undefined, false])("resolves workspace-installed thread hosts without Enterprise lookup (flag %s)",
      async isEnterpriseInstall => {
    mockSlack(false);
    let client = new SlackApi(async () => "token", {
      installation: async () => ({ teamId: "TONE", isEnterpriseInstall }),
    });
    expect(await client.workspaceIdForDomain("tone")).toBe("TONE");
    let info = requests.find(url => url.pathname.endsWith("team.info"));
    expect(info?.searchParams.get("team")).toBe("TONE");
    expect(requests.some(url => url.searchParams.has("domain"))).toBe(false);
    expect(requests.some(url => url.pathname.endsWith("auth.teams.list"))).toBe(false);
  });

  it("rejects a different permalink host for a workspace installation", async () => {
    mockSlack(false);
    await expect(new SlackApi(async () => "token").workspaceIdForDomain("ttwo"))
        .rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(requests.some(url => url.searchParams.has("domain"))).toBe(false);
  });

  it("does not use an enterprise ID as a workspace selector", async () => {
    mockSlack();
    expect(() => api("EORG")).toThrow("not an enterprise");
    await expect(new SlackApi(async () => "token").getWorkspaceInfo()).rejects.toThrow("Select a Slack workspace");
  });

  it("uses saved org metadata even if auth.test reports a workspace-shaped identity", async () => {
    mockSlack(false);
    let client = new SlackApi(async () => "token", {
      installation: async () => ({ teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" }),
    });
    expect(await client.listWorkspaces()).toHaveLength(2);
    // Saved org metadata also chooses the Enterprise-only permalink resolution path.
    let fetchSlack = fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.includes("team.info") && new URL(input).searchParams.has("domain")) {
        requests.push(new URL(input));
        return Response.json({ ok: true, team: { id: "TTWO", name: "Two", domain: "ttwo" } });
      }
      return fetchSlack(input);
    });
    expect(await client.workspaceIdForDomain("ttwo")).toBe("TTWO");
    await expect(client.getWorkspaceInfo()).rejects.toThrow("Select a Slack workspace");
  });

  it("rejects repeated grant cursors instead of hanging workspace discovery", async () => {
    mockSlack();
    let fetchSlack = fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.includes("auth.teams.list")) {
        return Response.json({ ok: true, teams: [], response_metadata: { next_cursor: "loop" } });
      }
      return fetchSlack(input);
    });
    await expect(api().listWorkspaces()).rejects.toThrow("repeated a pagination cursor");
  });

  it("rejects a foreign channel before any history is read", async () => {
    mockSlack(); channel.shared_team_ids = ["TTWO"];
    await expect(api().listHistory("CONE", undefined, 1)).rejects.toMatchObject({ code: "access_denied" });
    expect(requests.some(url => url.pathname.endsWith("conversations.history"))).toBe(false);
  });

  it("allows a shared channel linked to the selected workspace and carries its context", async () => {
    mockSlack(); channel.shared_team_ids = ["TTWO", "TONE"];
    let client = api();
    let history = await client.listHistory("CONE", undefined, 1);
    await client.listReplies("CONE", "123.000001", undefined, 1);
    await client.listConversationMembers("CONE", undefined, 10);
    for (let method of ["conversations.info", "conversations.history", "conversations.replies", "conversations.members"]) {
      expect(requests.find(url => url.pathname.endsWith(method))?.searchParams.get("client_context_team_id")).toBe("TONE");
    }
    expect(history.items[0].permalink).toContain("https://tone.slack.com/");
  });

  it("proves a metadata-less DM through workspace-scoped discovery", async () => {
    mockSlack(); channel = { id: "DONE", is_im: true };
    await expect(api().listHistory("DONE", undefined, 1)).resolves.toMatchObject({ items: [{ text: "test" }] });
    channel = { id: "DFOREIGN", is_im: true };
    await expect(api().getConversationInfo("DFOREIGN")).rejects.toMatchObject({ code: "access_denied" });
  });

  it("also verifies DMs with empty sharing metadata rather than rejecting every DM", async () => {
    mockSlack(); channel = { id: "DONE", is_im: true, shared_team_ids: [] };
    await expect(api().getConversationInfo("DONE")).resolves.toMatchObject({ id: "DONE", kind: "im" });
  });

  it("does not mistake a requested viewing context for membership in a foreign channel", async () => {
    mockSlack(); channel = { id: "CFOREIGN", team_id: "TTWO", context_team_id: "TONE" };
    await expect(api().listHistory("CFOREIGN", undefined, 1)).rejects.toMatchObject({ code: "access_denied" });
    expect(requests.some(url => url.pathname.endsWith("conversations.history"))).toBe(false);
  });

  it("does not return search matches in another workspace", async () => {
    mockSlack(); channel.shared_team_ids = ["TTWO"];
    await expect(api().searchMessages("test", undefined, 10)).rejects.toMatchObject({ code: "access_denied" });
  });

  it("restricts direct user lookup to the workspace directory", async () => {
    mockSlack();
    await expect(api().getWorkspaceUser("WSELF")).resolves.toMatchObject({ id: "WSELF" });
    await expect(api().getWorkspaceUser("WOTHER")).rejects.toMatchObject({ code: "access_denied" });
  });

  it("accepts a workspace member's pre-Enterprise user ID through Slack's translation", async () => {
    mockSlack();
    let fetchSlack = fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.includes("users.info") && input.includes("UOLD")) {
        return Response.json({ ok: true, user: { id: "WSELF", name: "ddr" } });
      }
      return fetchSlack(input);
    });
    await expect(api().getWorkspaceUser("UOLD")).resolves.toMatchObject({ id: "WSELF" });
  });

  it("classifies a missing workspace grant as access denied, not credential expiry", () => {
    let error = new SlackApiError("team_access_not_granted", 200);
    expect(error.isAccessError).toBe(true);
    expect(error.isAuthError).toBe(false);
  });
});
