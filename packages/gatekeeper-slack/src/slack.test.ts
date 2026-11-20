import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import { SlackApi, SlackApiError, type SlackInstallation, type SlackOAuthGrant } from "./slack-api";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { formatSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { getGrantedResourceTypeIds } from "@gadgets/workshop-shared/gatekeeper";

// These tests exercise binding/observer behavior in Node; the production RPC schema is checked
// separately by the Worker prebuild. The only emulation here is the Workers hosting surface, over
// the shared stub's `env`, which the upstream client reads to count its calls.
vi.mock("cloudflare:workers", async importOriginal => {
  class Entrypoint {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  class Target { [Symbol.dispose]() {} }
  class Stub { dup() { return this; } }
  return {
    ...await importOriginal<{ env: Record<string, unknown> }>(),
    WorkerEntrypoint: Entrypoint, DurableObject: Entrypoint, RpcTarget: Target, RpcStub: Stub,
  };
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
  SlackUserImpl, SlackWorkspaceGatekeeperImpl, SlackConversationGatekeeperImpl,
  SlackThreadGatekeeperImpl, SlackVerifier, UserAccount, GatekeeperVendor,
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

describe("Slack resource binding identity", () => {
  it("retains the workspace from workspace and conversation URLs", async () => {
    let ctx = context({ userObjectId: "account" });
    let user = new SlackUserImpl(ctx as never, {} as never);
    await user.getGatekeeperClassFor("https://app.slack.com/client/TTWO");
    await user.getGatekeeperClassFor("https://app.slack.com/client/TONE/CONE");
    expect(ctx.exports.SlackWorkspaceGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TTWO", reportsSubresources: true },
    });
    expect(ctx.exports.SlackConversationGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TONE", conversationId: "CONE", reportsSubresources: true },
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

  it("checks every conversation earlier reads recorded in that same workspace, pending or observed", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TTWO" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    ctx.storage.kv.put("trackedConversation:COLD", "observed");
    ctx.storage.kv.put("trackedConversation:CPENDING", "pending");
    let observer = { hasWorkspaceAccess: vi.fn(async () => true),
      hasConversationAccess: vi.fn(async (id: string) => id === "COLD") };
    await expect(binding.addObserver("observer", observer as never)).rejects.toThrow("does not have access");
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("COLD", "TTWO");
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("CPENDING", "TTWO");
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


describe("Slack resource type grants", () => {
  const threadPattern = "https://*.slack.com/archives/:conversationId/:messageId";

  it.each([
    { patterns: [threadPattern], ids: ["thread"] },
    { patterns: [], ids: [] },
  ])("describes stable grants independently of the URL grammar: $ids", async ({ patterns, ids }) => {
    const ctx = { props: { userObjectId: "account" }, exports: { UserAccount: {
      idFromString: (id: string) => id,
      get: () => ({
        getUserId: async () => "user",
        getInstallation: async () => installation,
        getGrantedResourceUrlPatterns: async () => patterns,
      }),
    } } };
    vi.spyOn(SlackApi.prototype, "getAccountDescription").mockResolvedValue({
      uniqueName: "slack-user", avatar: { url: "" },
    });
    const user = new SlackUserImpl(ctx as never, {} as never);
    const description = await user.describe();
    expect(description.grantedResourceTypeIds).toEqual(ids);
    expect(description.grantedResourceUrlPatterns).toEqual(patterns);
    const renamedResources = (await user.getSupportedResources()).map(resource => ({
      ...resource, urlPattern: `${resource.urlPattern}/new-grammar`,
    }));
    expect(getGrantedResourceTypeIds(description, renamedResources)).toEqual(ids);
  });

  it.each([
    { options: { resourceTypeIds: ["thread"] }, search: false },
    { options: { resourceTypeIds: [] }, search: false },
    { options: { resourceUrlPatterns: [threadPattern] }, search: false },
    { options: undefined, search: true },
  ])("requests only the selected OAuth scopes: $options", async ({ options, search }) => {
    const setCallback = vi.fn(async (_callback: unknown, _nonce: string, _scopes: string[]) => {});
    const ctx = { exports: { UserAccount: {
      newUniqueId: () => "account", get: () => ({ setCallback }),
    } } };
    const vendor = new GatekeeperVendor(ctx as never, { BASE_URL: "https://slack.test" } as never);
    await vendor.connectAccount({} as never, options);
    const scopes = setCallback.mock.calls[0]![2];
    expect(scopes).toContain("users:read");
    expect(scopes.includes("search:read")).toBe(search);
    if (options?.resourceTypeIds?.length === 0) expect(scopes).toEqual(["users:read"]);
    else expect(scopes).toContain("channels:history");
  });

  it("recognizes an existing grant by ID or legacy pattern without reconnecting", async () => {
    const prepareReconnect = vi.fn();
    const ctx = { props: { userObjectId: "account" }, exports: { UserAccount: {
      idFromString: (id: string) => id,
      get: () => ({ getGrantedResourceUrlPatterns: async () => [threadPattern], prepareReconnect }),
    } } };
    const user = new SlackUserImpl(ctx as never, {} as never);
    expect(await user.ensureResources(["thread"])).toEqual({});
    expect(await user.ensureResources([threadPattern])).toEqual({});
    expect(await user.ensureResources([])).toEqual({});
    expect(prepareReconnect).not.toHaveBeenCalled();
  });

  it("translates a grant upgrade by ID and rejects unknown IDs before reconnecting", async () => {
    const prepareReconnect = vi.fn(async (_nonce: string, _scopes: string[]) => {});
    const ctx = { props: { userObjectId: "account" }, exports: { UserAccount: {
      idFromString: (id: string) => id,
      get: () => ({ getGrantedResourceUrlPatterns: async () => [],
        getResourceUrlPatternsForReconnect: async () => [], prepareReconnect }),
    } } };
    const user = new SlackUserImpl(ctx as never, { BASE_URL: "https://slack.test" } as never);
    expect(await user.ensureResources(["thread"])).toHaveProperty("url");
    expect(prepareReconnect.mock.calls[0]![1]).toContain("channels:history");
    expect(prepareReconnect.mock.calls[0]![1]).not.toContain("search:read");
    await expect(user.ensureResources(["unknown"])).rejects.toThrow();
    expect(prepareReconnect).toHaveBeenCalledOnce();
  });
});

type Point = { blobs?: unknown[]; doubles?: unknown[] };

// A written point's value in one column.
function column(point: Point, slot: string) {
  let values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// A global fetch that answers each Web API method with what `answers` gives for it, and the
// methods of the requests sent.
function slack(answers: Record<string, (params: URLSearchParams) => Record<string, unknown>>): string[] {
  let sent: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    let url = new URL(input);
    let method = url.pathname.slice("/api/".length);
    sent.push(method);
    let answer = answers[method];
    if (!answer) throw new Error(`Unexpected Slack request: ${method}`);
    return Response.json({ ok: true, ...answer(url.searchParams) });
  });
  return sent;
}

// An approval queue that authorizes every observation.
const queue = () => ({ dup() { return this; }, authorizeObservation: vi.fn(async () => undefined) });
// A conversation that names its workspace, which no listing has to prove.
const inWorkspace = (params: URLSearchParams) => ({ channel: { id: params.get("channel"), team_id: "TONE" } });

describe("Slack operations that page, as metric points", () => {
  const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
  let points: Point[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void points.push(point) };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  // How many calls each point written for `operation` stands for, in the order they were written.
  function callsOf(operation: string) {
    return points.filter(point => column(point, SUBSERVICE_V1_SLOTS.operation) === operation)
        .map(point => column(point, SUBSERVICE_V1_SLOTS.calls));
  }

  it("writes the pages a cursor reads until one holds something as one point", async () => {
    let sent = slack({
      "users.list": params => params.get("cursor") === null
        ? { members: [{ id: "WGONE", deleted: true }], response_metadata: { next_cursor: "two" } }
        : { members: [{ id: "WSELF", name: "self" }] },
    });
    let session = await new SlackWorkspaceGatekeeperImpl(
        context({ userObjectId: "account", teamId: "TONE" }) as never, {} as never)
        .startSession(queue() as never);

    let cursor = await session.listUsers();
    expect(await cursor.next()).toMatchObject([{ id: "WSELF" }]);

    expect(sent).toEqual(["users.list", "users.list"]);
    expect(callsOf("users.list")).toEqual([2]);
  });

  it("writes the pages of a thread's replies as one point, after the read that finds its root", async () => {
    let root = { ts: "1700000000.000100", thread_ts: "1700000000.000100", user: "WSELF" };
    let sent = slack({
      "conversations.info": inWorkspace,
      "users.info": params => ({ user: { id: params.get("user"), name: "self" } }),
      "conversations.replies": params => params.get("cursor") === null
        ? { messages: [root], response_metadata: { next_cursor: "two" } }
        : { messages: [{ ts: "1700000000.000200", thread_ts: root.ts, user: "WSELF" }] },
    });
    let thread = await new SlackThreadGatekeeperImpl(context({
      userObjectId: "account", teamId: "TONE", conversationId: "CONE", threadTs: root.ts,
      permalink: "https://one.slack.com/archives/CONE/p1700000000000100", reportsSubresources: true,
    }) as never, {} as never).startSession(queue() as never);

    expect((await thread.listReplies()).map(message => message.ts)).toEqual([root.ts, "1700000000.000200"]);

    expect(sent.filter(method => method === "conversations.replies")).toHaveLength(3);
    expect(callsOf("conversations.replies")).toEqual([1, 2]);
  });

  it("writes the lookups of the conversations an account's access is checked for as one point", async () => {
    let sent = slack({ "conversations.info": inWorkspace });
    let ctx = context({});
    ctx.storage.kv.put("accessToken", token);
    let account = new UserAccount(ctx as never, {} as never);
    let conversations = ["CONE", "CTWO"].map(id => formatSubresourceId({
      fragments: [{ name: "workspace", id: "TONE" }, { name: "conversation", id }],
    }));

    expect(await account.checkSubresourceAccess(conversations)).toEqual([true, true]);

    expect(sent).toEqual(["conversations.info", "conversations.info"]);
    expect(callsOf("conversations.info")).toEqual([2]);
  });
});
