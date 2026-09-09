import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { JiraProjectGatekeeperImpl, JiraSiteGatekeeperImpl, UserAccount } from "../src/jira";

const ONE = { id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: ["read:jira-work"] };
const TWO = { id: "cloud-2", name: "Two", url: "https://two.atlassian.net", scopes: ["read:jira-work"] };
const NONCE = "a".repeat(64);
const OTHER_NONCE = "b".repeat(64);
const ENV = { BASE_URL: "https://workshop.example/gatekeeper/jira", CLIENT_ID: "client", CLIENT_SECRET: "secret" };

afterEach(() => vi.unstubAllGlobals());

describe("Jira site selection during the OAuth browser flow", () => {
  it.each([null, []])("does not complete without verified Jira sites: %j", async sites => {
    stubAtlassian(sites);
    const { kv, callback, connect } = makeAccount();
    await expect(connect()).resolves.toMatchObject({ error: expect.any(String) });
    expect(kv.has("grant")).toBe(false);
    expect(kv.has("selectedSite")).toBe(false);
    expect(callback.complete).not.toHaveBeenCalled();
  });

  it.each(["revoke", "reconnect"] as const)("ignores stale OAuth discovery after %s", async operation => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return new Promise<Response>(resolve => { release = resolve; });
      return Response.json({ account_id: "acct" });
    });
    vi.stubGlobal("fetch", fetcher);
    const { account, kv, callback, connect } = makeAccount();
    const pending = connect();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    if (operation === "revoke") await account.revoke();
    else await account.prepareReconnect(OTHER_NONCE);
    const expectedNonce = kv.get("nonce");
    release(Response.json([ONE, TWO]));
    await expect(pending).resolves.toBeNull();
    expect(kv.get("nonce")).toEqual(expectedNonce);
    expect(kv.has("grant")).toBe(false);
    expect(kv.has("pendingSelection")).toBe(false);
    expect(callback.complete).not.toHaveBeenCalled();
  });

  it("auto-selects the single granted site and completes without a chooser", async () => {
    stubAtlassian([ONE]);
    const { kv, callback, connect } = makeAccount();

    await expect(connect()).resolves.toEqual({ returnUrl: undefined });

    expect(kv.get("selectedSite")).toEqual({ cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });
    expect(callback.complete).toHaveBeenCalledTimes(1);
  });

  it("asks which site to use and stores no usable grant until one is chosen", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv, callback, connect } = makeAccount();

    const offered = await connect();

    expect(offered?.selection?.sites).toEqual([
      { cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" },
      { cloudId: "cloud-2", url: "https://two.atlassian.net", name: "Two" },
    ]);
    expect(kv.has("grant")).toBe(false);
    expect(kv.has("selectedSite")).toBe(false);
    expect(callback.complete).not.toHaveBeenCalled();

    const chosen = await account.selectSite("cloud-2", offered!.selection!.nonce);

    expect(chosen).toEqual({ returnUrl: undefined });
    expect(kv.get("selectedSite")).toEqual({ cloudId: "cloud-2", url: "https://two.atlassian.net", name: "Two" });
    expect(kv.get("grant")).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(kv.has("pendingSelection")).toBe(false);
    expect(callback.complete).toHaveBeenCalledTimes(1);
  });

  it("refuses a site outside the authorization without connecting anything", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv, callback, connect } = makeAccount();
    const offered = await connect();

    await expect(account.selectSite("cloud-9", offered!.selection!.nonce)).resolves.toMatchObject({ error: expect.stringMatching(/not part of this authorization/) });

    expect(kv.has("grant")).toBe(false);
    expect(kv.has("pendingSelection")).toBe(false);
    expect(callback.complete).not.toHaveBeenCalled();
  });

  it("consumes the selection nonce exactly once and ignores stale or mismatched submits", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv, connect } = makeAccount();
    const offered = await connect();
    const nonce = offered!.selection!.nonce;

    await expect(account.selectSite("cloud-1", OTHER_NONCE)).resolves.toBeNull();
    expect(kv.has("pendingSelection")).toBe(true);

    await expect(account.selectSite("cloud-1", nonce)).resolves.toEqual({ returnUrl: undefined });
    await expect(account.selectSite("cloud-2", nonce)).resolves.toBeNull();
    expect(kv.get("selectedSite")).toMatchObject({ cloudId: "cloud-1" });
  });

  it("expires an unanswered chooser instead of leaving a grant behind", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv, connect } = makeAccount();
    const offered = await connect();

    kv.set("oauthCleanupAt", Date.now() - 1);
    await account.alarm();

    expect(kv.size).toBe(0);
    await expect(account.selectSite("cloud-1", offered!.selection!.nonce)).resolves.toBeNull();
  });

  it("threads the native return URL through the chooser step", async () => {
    stubAtlassian([ONE, TWO]);
    const returnUrl = "https://workshop.example/native/oauth-return/abcdefghijklmnopqrstuvwxyz012345";
    const { account, connect } = makeAccount();

    const offered = await connect(returnUrl);

    await expect(account.selectSite("cloud-1", offered!.selection!.nonce)).resolves.toEqual({ returnUrl });
  });
});

describe("Jira legacy connection migration", () => {
  it("migrates a legacy single-site connection once and persists the choice", async () => {
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE]);

    await expect(account.getSelectedSite()).resolves.toEqual(ONE);

    expect(kv.get("selectedSite")).toEqual({ cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });
    await expect(account.getAccessTokenForSite("cloud-1")).resolves.toBe("access");
  });

  it("never silently picks a site for a legacy multi-site connection", async () => {
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE, TWO]);
    kv.set("defaultProject", { cloudId: "cloud-1", webBase: "https://one.atlassian.net", projectKey: "ENG", projectName: "Engineering" });

    await expect(account.getSelectedSite()).resolves.toBeNull();
    await expect(account.getAccessTokenForSite("cloud-1")).rejects.toThrow(/no selected Jira site/i);
    await expect(account.getDefaultProject()).resolves.toBeNull();
    expect(kv.has("selectedSite")).toBe(false);
  });

  it("lets a legacy multi-site connection choose through reconnect", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE, TWO]);

    await account.prepareReconnect(NONCE);
    const begun = await account.beginOAuthFlow(NONCE);
    const offered = await account.acceptAuthCode("code", begun!.oauthNonce);

    expect(offered?.selection?.sites).toHaveLength(2);
    expect(kv.get("grant")).toMatchObject({ accessToken: "old-access" });

    await account.selectSite("cloud-2", offered!.selection!.nonce);

    expect(kv.get("selectedSite")).toMatchObject({ cloudId: "cloud-2" });
    expect(kv.get("grant")).toMatchObject({ accessToken: "access" });
  });
});

describe("Jira reconnect site preservation", () => {
  it("keeps the selected site across reconnect without asking again", async () => {
    stubAtlassian([ONE, TWO]);
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE]);
    kv.set("selectedSite", { cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });

    await expect(reconnect(account)).resolves.toEqual({ returnUrl: undefined });

    expect(kv.get("selectedSite")).toMatchObject({ cloudId: "cloud-1" });
    expect(kv.get("grant")).toMatchObject({ accessToken: "access" });
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
  });

  it("fails clearly instead of switching sites when reconnect drops the selected site", async () => {
    stubAtlassian([TWO]);
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE]);
    kv.set("selectedSite", { cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });

    await expect(reconnect(account)).resolves.toMatchObject({ error: expect.stringMatching(/does not include one\.atlassian\.net/) });

    expect(kv.get("selectedSite")).toMatchObject({ cloudId: "cloud-1" });
    expect(kv.get("grant")).toMatchObject({ accessToken: "old-access" });
    expect(kv.get("sites")).toEqual([ONE]);
    expect(callback.credentialsRestored).not.toHaveBeenCalled();
  });

  it("refuses the new grant when discovery fails and keeps the existing connection", async () => {
    stubAtlassian(null);
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE]);
    kv.set("selectedSite", { cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });

    await expect(reconnect(account)).resolves.toMatchObject({ error: expect.stringContaining("Could not verify") });

    expect(kv.get("grant")).toMatchObject({ accessToken: "old-access" });
    expect(kv.get("sites")).toEqual([ONE]);
    await expect(account.getSelectedSite()).resolves.toEqual(ONE);
  });
});

describe("Jira selected-site enforcement", () => {
  it("refuses tokens for any site other than the selected one", async () => {
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 });
    kv.set("sites", [ONE, TWO]);
    kv.set("selectedSite", { cloudId: "cloud-1", url: "https://one.atlassian.net", name: "One" });

    await expect(account.getAccessTokenForSite("cloud-1")).resolves.toBe("access");
    await expect(account.getAccessTokenForSite("cloud-2")).rejects.toThrow(/limited to one\.atlassian\.net/);
  });

  it("refuses a capability persisted for a site this connection no longer uses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { session } = setupGatekeeper("site", { cloudId: "cloud-2", webBase: "https://two.atlassian.net" });
    const site = await session();
    if (!("getMetadata" in site)) throw new Error("Wrong session");

    await expect(site.listProjects().then(cursor => cursor.next())).rejects.toThrow(/limited to one\.atlassian\.net/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Jira browser-flow selection endpoint", () => {
  it("renders an escaped chooser bound to the flow state", async () => {
    const acceptAuthCode = vi.fn(async () => ({ selection: { nonce: OTHER_NONCE, sites: [{ cloudId: "cloud-1", url: "https://one.atlassian.net", name: 'A & B <script>"' }] } }));
    const response = await fetchWorker(`https://workshop.example/gatekeeper/jira/oauth?state=${NONCE}:${OTHER_NONCE}&code=xyz`, { acceptAuthCode });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(body).toContain('action="https://workshop.example/gatekeeper/jira/select"');
    expect(body).toContain(`<input type="hidden" name="state" value="${NONCE}:${OTHER_NONCE}">`);
    expect(body).toContain("A &amp; B &lt;script&gt;&quot;");
    expect(body).not.toContain("<script>");
  });

  it("surfaces a refused reconnect as a bounded error page", async () => {
    const acceptAuthCode = vi.fn(async () => ({ error: 'no access to <b>one.atlassian.net</b>' }));
    const response = await fetchWorker(`https://workshop.example/gatekeeper/jira/oauth?state=${NONCE}:${OTHER_NONCE}&code=xyz`, { acceptAuthCode });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("no access to &lt;b&gt;one.atlassian.net&lt;/b&gt;");
  });

  it("only accepts POST with well-formed single-use state on the selection callback", async () => {
    const selectSite = vi.fn(async () => ({ returnUrl: undefined }));

    const rejectedMethod = await fetchWorker("https://workshop.example/gatekeeper/jira/select", { selectSite });
    expect(rejectedMethod.status).toBe(405);

    const rejectedState = await fetchWorker("https://workshop.example/gatekeeper/jira/select", { selectSite }, form({ state: "not-a-state", cloudId: "cloud-1" }));
    expect(rejectedState.status).toBe(400);
    await expect(rejectedState.text()).resolves.toContain("Invalid Authorization State");
    expect(selectSite).not.toHaveBeenCalled();

    const accepted = await fetchWorker("https://workshop.example/gatekeeper/jira/select", { selectSite }, form({ state: `${NONCE}:${OTHER_NONCE}`, cloudId: "cloud-1" }));
    expect(accepted.status).toBe(200);
    expect(selectSite).toHaveBeenCalledWith("cloud-1", OTHER_NONCE);
  });

  it("reports an expired or replayed selection instead of connecting", async () => {
    const selectSite = vi.fn(async () => null);
    const response = await fetchWorker("https://workshop.example/gatekeeper/jira/select", { selectSite }, form({ state: `${NONCE}:${OTHER_NONCE}`, cloudId: "cloud-1" }));

    await expect(response.text()).resolves.toContain("Authorization Link Expired");
  });
});

describe("Jira coding-session search pagination", () => {
  it("returns a validated cursor scoped to its own search and keeps paging inside the project", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ issues: [{ id: "1", key: "ENG-1", fields: { summary: "One", project: { key: "ENG" } } }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(Response.json({ issues: [{ id: "2", key: "ENG-2", fields: { summary: "Two", project: { key: "ENG" } } }], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    const project = await setupGatekeeper("project").session();
    if (!("callTool" in project) || typeof project.callTool !== "function") throw new Error("Wrong session");

    const first = await project.callTool("jira_search", { query: "urgent", limit: 5 });
    const page = first.structuredContent as { items: unknown[]; hasMore: boolean; nextCursor?: string };

    expect(page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    expect(page.items).toHaveLength(1);

    const second = await project.callTool("jira_search", { query: "urgent", limit: 5, cursor: page.nextCursor });

    expect(second.structuredContent).toMatchObject({ hasMore: false });
    expect(second.structuredContent).not.toHaveProperty("nextCursor");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ jql: 'project = "ENG" AND text ~ "urgent"', nextPageToken: "page-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed cursors and cursors minted by a different search", async () => {
    const fetchMock = vi.fn(async () => Response.json({ issues: [], nextPageToken: "page-2" }));
    vi.stubGlobal("fetch", fetchMock);
    const project = await setupGatekeeper("project").session();
    const site = await setupGatekeeper("site").session();
    if (!("callTool" in project) || typeof project.callTool !== "function") throw new Error("Wrong session");
    if (!("callTool" in site) || typeof site.callTool !== "function") throw new Error("Wrong session");

    const projectCursor = (await project.callTool("jira_search", { query: "urgent" })).structuredContent as { nextCursor: string };

    await expect(site.callTool("jira_search", { query: "urgent", cursor: projectCursor.nextCursor })).rejects.toThrow(/different Jira search/);
    await expect(project.callTool("jira_search", { query: "other", cursor: projectCursor.nextCursor })).rejects.toThrow(/different Jira search/);
    await expect(project.callTool("jira_search", { cursor: "not base64url!" })).rejects.toThrow(/nextCursor returned by a previous jira_search/);
    await expect(project.callTool("jira_search", { cursor: btoa("{}").replace(/=+$/, "") })).rejects.toThrow(/nextCursor returned by a previous jira_search/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function stubAtlassian(resources: typeof ONE[] | null): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://auth.atlassian.com/oauth/token") return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read:jira-work" });
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return resources ? Response.json(resources) : Response.json({ error: "unavailable" }, { status: 503 });
    if (url === "https://api.atlassian.com/me") return Response.json({ account_id: "acct" });
    throw new Error(`unexpected URL ${url}`);
  }));
}

async function reconnect(account: UserAccount) {
  await account.prepareReconnect(NONCE);
  const begun = await account.beginOAuthFlow(NONCE);
  if (!begun) throw new Error("OAuth flow did not begin.");
  return account.acceptAuthCode("code", begun.oauthNonce);
}

function makeAccount() {
  const account = new UserAccount();
  const kv = new Map<string, unknown>();
  const callback = { complete: vi.fn(), credentialsRestored: vi.fn(), credentialsExpired: vi.fn() };
  Object.assign(account, {
    env: ENV,
    ctx: {
      id: { toString: () => "d".repeat(64) },
      exports: { GatekeeperUserImpl: () => ({}) },
      storage: {
        kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => kv.set(key, value), delete: (key: string) => kv.delete(key) },
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn(),
        deleteAll: vi.fn(() => kv.clear()),
      },
    },
  });
  kv.set("callback", callback);
  const connect = async (returnUrl?: string) => {
    await account.setCallback(callback as never, NONCE, returnUrl);
    const begun = await account.beginOAuthFlow(NONCE);
    if (!begun) throw new Error("OAuth flow did not begin.");
    return account.acceptAuthCode("code", begun.oauthNonce);
  };
  return { account, kv, callback, connect };
}

/** Gatekeeper bound to `props`, backed by a connection whose selected site is always cloud-1. */
function setupGatekeeper(kind: "site" | "project", props: { cloudId: string; webBase: string } = { cloudId: "cloud-1", webBase: "https://one.atlassian.net" }) {
  const gatekeeper = kind === "site" ? new JiraSiteGatekeeperImpl() : new JiraProjectGatekeeperImpl();
  const account = {
    getSelectedSite: async () => ONE,
    getAccessToken: async () => "token",
    getAccessTokenForSite: async (cloudId: string) => {
      if (cloudId !== ONE.id) throw new Error(`This Jira connection is limited to ${new URL(ONE.url).hostname}. Reconnect the Jira account to use a different site.`);
      return "token";
    },
    getDefaultProject: async () => null,
  };
  const values = new Map<string, unknown>();
  Object.assign(gatekeeper, { ctx: {
    props: { ...props, userObjectId: "owner", projectKey: "ENG" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } },
    storage: { kv: { get: (key: string) => values.get(key), put: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) } },
  } });
  const queue = { authorizeObservation: vi.fn(async () => {}), submitAction: vi.fn(async () => {}), dup() { return this; }, [Symbol.dispose]: vi.fn() };
  return { gatekeeper, queue, session: () => gatekeeper.startSession(queue as never) };
}

function form(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("https://workshop.example/gatekeeper/jira/select", { method: "POST", body });
}

function fetchWorker(url: string, stub: Record<string, unknown>, request?: Request): Promise<Response> {
  const ctx = { exports: { UserAccount: { idFromString: (id: string) => id, get: () => stub } } };
  return worker.fetch(request ?? new Request(url), ENV as never, ctx as never);
}
