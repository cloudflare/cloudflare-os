import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApi, SlackApiError, type SlackInstallation, type SlackOAuthGrant } from "./slack-api";
import * as centralOAuth from "@gadgets/gatekeeper-kit/central-oauth";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";

// These tests exercise binding/observer behavior in Node; the production RPC schema is checked
// separately by the Worker prebuild. The only emulation here is the Workers hosting surface.
vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  class Target { [Symbol.dispose]() {} }
  class Stub { dup() { return this; } }
  return { WorkerEntrypoint: Entrypoint, DurableObject: Entrypoint, RpcTarget: Target, RpcStub: Stub };
});
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("./types.txt", () => ({ default: "" }));
vi.mock("./generated/workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("./generated/conversation-configurator-ui.txt", () => ({ default: "" }));
vi.mock("./generated/thread-configurator-ui.txt", () => ({ default: "" }));

const {
  default: slackWorker,
  SlackUserImpl, SlackWorkspaceGatekeeperImpl, SlackConversationGatekeeperImpl,
  SlackThreadGatekeeperImpl, SlackVerifier, UserAccount,
} = await import("./slack");

class MemoryKv {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  put<T>(key: string, value: T) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
  list<T>({ prefix }: { prefix: string }): Map<string, T> {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}

let installation: SlackInstallation;
let workspaces: { id: string; name: string }[];
const token = { token: "user-token", expires: new Date("2999-01-01") };

function context(initialProps: Record<string, unknown>) {
  let kv = new MemoryKv();
  let account = {
    getTeamId: async () => installation.teamId,
    getInstallation: async () => installation,
    getAccessToken: async () => token,
  };
  let exports = {
    UserAccount: { idFromString: (id: string) => id, get: () => account },
    SlackWorkspaceGatekeeperImpl: vi.fn(({ props }) => props),
    SlackConversationGatekeeperImpl: vi.fn(({ props }) => props),
    SlackThreadGatekeeperImpl: vi.fn(({ props }) => props),
  };
  return { props: initialProps, storage: { kv }, exports };
}

beforeEach(() => {
  installation = { teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" };
  workspaces = [{ id: "TONE", name: "One" }, { id: "TTWO", name: "Two" }];
  vi.spyOn(SlackApi.prototype, "listWorkspaces").mockImplementation(async () => workspaces);
  vi.spyOn(SlackApi.prototype, "getWorkspaceInfo").mockImplementation(async function (this: SlackApi) {
    let teamId = await this.workspaceTeamId();
    return { teamId, name: teamId, domain: teamId.toLowerCase() };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("managed Slack consent failures", () => {
  it("renders a recoverable error when the central broker refuses a suspended installation", async () => {
    const account = { beginOAuthFlow: vi.fn(async () => ({ oauthNonce: "b".repeat(64), scopes: ["users:read"] })) };
    const ctx = { exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } } };
    const env = { BASE_URL: "https://instance.example/gatekeeper/slack", CENTRAL_GATEKEEPER_URL: "https://central.example" };
    const request = new Request(`${env.BASE_URL}/${"a".repeat(64)}/${"c".repeat(64)}`);
    const begin = vi.spyOn(centralOAuth, "beginCentralOAuth")
      .mockRejectedValueOnce(new Error("Central slack OAuth request failed (401)"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = await slackWorker.fetch(request, env as never, ctx as never);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(await refused.text()).toContain("Contact your Cloudflare OS administrator");

    // A new attempt can proceed after the operator restores the installation.
    begin.mockResolvedValueOnce("https://slack.com/oauth/v2/authorize?client_id=test");
    const restored = await slackWorker.fetch(request, env as never, ctx as never);
    expect(restored.status).toBe(302);
    expect(restored.headers.get("Location")).toBe("https://slack.com/oauth/v2/authorize?client_id=test");
  });
});

describe("Slack resource binding identity", () => {
  it("retains the workspace from workspace and conversation URLs", async () => {
    let ctx = context({ userObjectId: "account" });
    let user = new SlackUserImpl(ctx as never, {} as never);
    await user.getGatekeeperClassFor("https://app.slack.com/client/TTWO");
    await user.getGatekeeperClassFor("https://app.slack.com/client/TONE/CONE");
    expect(ctx.exports.SlackWorkspaceGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TTWO" },
    });
    expect(ctx.exports.SlackConversationGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TONE", conversationId: "CONE" },
    });
    await expect(user.getGatekeeperClassFor("https://app.slack.com/client/EORG"))
        .rejects.toThrow("not an enterprise");
  });

  it("resolves a thread's workspace from its permalink host", async () => {
    let resolve = vi.spyOn(SlackApi.prototype, "workspaceIdForDomain").mockResolvedValue("TTWO");
    let ctx = context({ userObjectId: "account" });
    await new SlackUserImpl(ctx as never, {} as never)
        .getGatekeeperClassFor("https://two.slack.com/archives/CTWO/p123000001");
    expect(resolve).toHaveBeenCalledWith("two");
    expect(ctx.exports.SlackThreadGatekeeperImpl).toHaveBeenCalledWith({
      props: expect.objectContaining({ teamId: "TTWO", conversationId: "CTWO" }),
    });
  });

  it("pins a legacy workspace binding independently of later reconnects", async () => {
    installation = { teamId: "TONE" };
    let ctx = context({ userObjectId: "account" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TONE");
    installation = { teamId: "TTWO", isEnterpriseInstall: false };
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TONE");
    expect(ctx.storage.kv.get("boundTeamId")).toBe("TONE");
  });

  it("recovers only an unambiguous legacy org workspace", async () => {
    let ctx = context({ userObjectId: "account" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    await expect(binding.describe()).rejects.toThrow("no unambiguous workspace");
    expect(ctx.storage.kv.get("boundTeamId")).toBeUndefined();
    workspaces = [{ id: "TTWO", name: "Two" }];
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TTWO");
  });

  it("does not redirect a selected binding after its workspace grant is removed", async () => {
    let binding = new SlackWorkspaceGatekeeperImpl(
        context({ userObjectId: "account", teamId: "TTWO" }) as never, {} as never);
    await binding.describe();
    workspaces = [{ id: "TONE", name: "One" }];
    await expect(binding.describe()).rejects.toMatchObject({ code: "team_access_not_granted" });
  });

  it("revalidates a long-lived cursor when its cached account credential reaches the refresh window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let ctx = context({ userObjectId: "account", teamId: "TONE" });
    let account = ctx.exports.UserAccount.get();
    let currentToken = { token: "org-token", expires: new Date(Date.now() + 60 * 60 * 1000) };
    let getAccessToken = vi.spyOn(account, "getAccessToken").mockImplementation(async () => currentToken);
    let read = vi.fn(async () => Response.json({ ok: true,
      members: [{ id: "WSELF", name: "ddr" }], response_metadata: { next_cursor: "next-page" } }));
    vi.stubGlobal("fetch", read);
    let queue = { dup() { return this; }, authorizeObservation: vi.fn(async () => undefined) };
    let session = await new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never)
        .startSession(queue as never);
    let cursor = await session.listUsers();
    expect(await cursor.next()).toMatchObject([{ id: "WSELF" }]);
    installation = { teamId: "TTWO", isEnterpriseInstall: false };
    workspaces = [{ id: "TTWO", name: "Two" }];
    currentToken = { token: "workspace-token", expires: new Date(Date.now() + 12 * 60 * 60 * 1000) };
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await expect(cursor.next()).rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
    expect(ctx.storage.kv.get("boundTeamId")).toBe("TONE");
  });

  it("commits org metadata only when the staged reconnect is committed", async () => {
    let ctx = context({});
    let account = new UserAccount(ctx as never, {} as never);
    ctx.storage.kv.put("teamId", "TONE");
    ctx.storage.kv.put("teamName", "Old workspace");
    let grant: SlackOAuthGrant = { accessToken: token, grantedScopes: ["users:read"],
      userId: "WSELF", teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" };
    let stageId = stageCredentials(ctx.storage.kv, grant, Date.now());
    expect(await account.getInstallation()).toEqual({ teamId: "TONE" });
    await account.commitReconnect(stageId);
    expect(await account.getInstallation()).toEqual(installation);
    expect(ctx.storage.kv.get("teamName")).toBeUndefined();
  });

  it("preserves legacy narrow grants for new consent without claiming they can already be read", async () => {
    let ctx = context({});
    let account = new UserAccount(ctx as never, {} as never);
    ctx.storage.kv.put("grantedScopes",
        ["users:read", "channels:history", "groups:history", "im:history", "mpim:history"]);
    expect(await account.getGrantedResourceUrlPatterns()).toEqual([]);
    expect(await account.getResourceUrlPatternsForReconnect())
        .toEqual(["https://*.slack.com/archives/:conversationId/:messageId"]);
    ctx.storage.kv.put("grantedScopes", [
      "users:read", "channels:read", "channels:history", "groups:read", "groups:history",
      "im:read", "im:history", "mpim:read", "mpim:history", "search:read",
    ]);
    expect(await account.getGrantedResourceUrlPatterns()).toEqual([]);
    expect(await account.getResourceUrlPatternsForReconnect()).toEqual([
      "https://app.slack.com/client/:teamId/:conversationId",
      "https://*.slack.com/archives/:conversationId/:messageId",
    ]);
  });
});

describe("Slack org observer isolation", () => {
  it("checks the observer's selected workspace rather than enterprise equality", async () => {
    let binding = new SlackWorkspaceGatekeeperImpl(
        context({ userObjectId: "account", teamId: "TTWO" }) as never, {} as never);
    let observer = { hasWorkspaceAccess: vi.fn(async () => false) };
    await expect(binding.addObserver("observer", observer as never)).rejects.toThrow("not a member");
    expect(observer.hasWorkspaceAccess).toHaveBeenCalledWith("TTWO");
  });

  it("checks tracked and new conversations in that same workspace before disclosure", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TTWO" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    ctx.storage.kv.put("trackedConversation:COLD", "observed");
    let observer = { hasWorkspaceAccess: vi.fn(async () => true),
      hasConversationAccess: vi.fn(async () => true) };
    await binding.addObserver("observer", observer as never);
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("COLD", "TTWO");
    observer.hasConversationAccess.mockResolvedValue(false);
    let queue = { authorizeObservation: vi.fn(async () => undefined) };
    await binding.authorizeConversationObservation(queue as never, ["CNEW"], { title: "Read", description: "Test" });
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("CNEW", "TTWO");
    expect(queue.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      excludeObservers: ["observer"],
    }));
    expect(ctx.storage.kv.get("trackedConversation:CNEW")).toBe("observed");
  });

  it("keeps blocked observations pending so retries recheck observer access", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TONE" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    let observer = { hasWorkspaceAccess: vi.fn(async () => true),
      hasConversationAccess: vi.fn(async () => false) };
    await binding.addObserver("observer", observer as never);
    let queue = { authorizeObservation: vi.fn(async () => { throw new Error("blocked"); }) };
    await expect(binding.authorizeConversationObservation(
        queue as never, ["CNEW"], { title: "Read", description: "Test" })).rejects.toThrow("blocked");
    expect(ctx.storage.kv.get("trackedConversation:CNEW")).toBe("pending");
    await expect(binding.authorizeConversationObservation(
        queue as never, ["CNEW"], { title: "Read", description: "Test" })).rejects.toThrow("blocked");
    expect(observer.hasConversationAccess).toHaveBeenCalledTimes(2);
  });

  it("passes workspace identity into conversation and thread observer checks", async () => {
    let observer = { hasConversationAccess: vi.fn(async () => true) };
    let ctx = context({ userObjectId: "account", teamId: "TTWO", conversationId: "CTWO",
      threadTs: "123.000001", permalink: "https://two.slack.com/archives/CTWO/p123000001" });
    await new SlackConversationGatekeeperImpl(ctx as never, {} as never).addObserver("id", observer as never);
    await new SlackThreadGatekeeperImpl(ctx as never, {} as never).addObserver("id", observer as never);
    expect(observer.hasConversationAccess).toHaveBeenNthCalledWith(1, "CTWO", "TTWO");
    expect(observer.hasConversationAccess).toHaveBeenNthCalledWith(2, "CTWO", "TTWO");
  });

  it("treats workspace removal as denial but propagates transient failures", async () => {
    let verifier = new SlackVerifier(context({ userObjectId: "observer" }) as never, {} as never);
    workspaces = [{ id: "TONE", name: "One" }];
    expect(await verifier.hasWorkspaceAccess("TTWO")).toBe(false);
    expect(await verifier.hasConversationAccess("CTWO", "TTWO")).toBe(false);
    vi.spyOn(SlackApi.prototype, "listWorkspaces").mockRejectedValue(new SlackApiError("ratelimited", 429));
    await expect(verifier.hasWorkspaceAccess("TONE")).rejects.toMatchObject({ code: "ratelimited" });
  });
});


describe("managed Slack connection", () => {
  const grant = () => ({ credentialId: "c".repeat(64), accessToken: "managed-user-token",
    expiresAt: Date.now() + 3_600_000, scopes: ["users:read"],
    providerData: { userId: "UUSER", teamId: "TONE", isEnterpriseInstall: false } });
  function fixture() {
    // Workers supplies timingSafeEqual; the hosting shim here uses exact byte equality.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, index) => value === b[index]) } });
    const ctx = { ...context({}), id: { toString: () => "a".repeat(64) } };
    const account = new UserAccount(ctx as never, { CENTRAL_GATEKEEPER_URL: "https://central.test" } as never);
    const callback = { reconnectComplete: vi.fn(async (ticket: string) => ({ targetOrigin: "https://instance.test", ticket })) };
    ctx.storage.kv.put("callback", callback);
    ctx.storage.kv.put("accessToken", token);
    return { ctx, account, callback };
  }
  it("stages managed reconnects, consumes nonce once, and stores only an opaque refresh reference", async () => {
    const { ctx, account } = fixture();
    ctx.storage.kv.put("refreshToken", "legacy-refresh-secret");
    await account.prepareReconnect("init", ["users:read"]);
    const flow = await account.beginOAuthFlow("init");
    expect(await account.acceptCentralGrant(grant(), "wrong")).toBeNull();
    const handoff = await account.acceptCentralGrant(grant(), flow!.oauthNonce);
    expect(ctx.storage.kv.get("accessToken")).toEqual(token);
    expect(await account.acceptCentralGrant(grant(), flow!.oauthNonce)).toBeNull();
    await account.commitReconnect(handoff!.ticket);
    expect(ctx.storage.kv.get("centralCredential")).toBe(`cgc1.${"c".repeat(64)}`);
    expect(ctx.storage.kv.get("refreshToken")).toBeUndefined();
    expect(await account.getAccessToken()).toMatchObject({ token: "managed-user-token" });
    await expect(account.acceptAuthCode("code", "nonce")).rejects.toThrow("Direct OAuth is disabled");
  });
  it("refreshes centrally and preserves org installation metadata without a provider secret", async () => {
    const { ctx, account } = fixture();
    ctx.storage.kv.put("accessToken", { token: "expired", expires: new Date(0) });
    ctx.storage.kv.put("centralCredential", `cgc1.${"c".repeat(64)}`);
    const refreshed = { ...grant(), providerData: { userId: "UUSER", teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" } };
    const refresh = vi.spyOn(centralOAuth, "refreshCentralOAuth").mockResolvedValue({ ok: true, grant: refreshed });
    expect((await account.getAccessToken()).token).toBe("managed-user-token");
    expect(refresh).toHaveBeenCalledOnce();
    expect(await account.getInstallation()).toEqual({ teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" });
    expect(ctx.storage.kv.get("refreshToken")).toBeUndefined();
  });
  it("refuses grants missing user/workspace identity before committing them", async () => {
    const { ctx, account } = fixture();
    await account.prepareReconnect("init", ["users:read"]);
    const flow = await account.beginOAuthFlow("init");
    await expect(account.acceptCentralGrant({ ...grant(), providerData: { userId: "bot", teamId: "" } }, flow!.oauthNonce))
      .rejects.toThrow("Invalid managed Slack");
    expect(ctx.storage.kv.get("accessToken")).toEqual(token);
  });
});
