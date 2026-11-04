// Behavior tests for the Slack gatekeeper's observer checks: the subresources each binding's reads
// report, how verifyObserverAccess() answers for them through each observer's own UserAccount,
// what an older binding's getHistoricalSubresources() exports, and what addObserver() still
// enforces. Slack is faked at the fetch layer, answering each request by the caller's token.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import type { UserAccount } from "../../src/slack";
import type { SlackOAuthGrant } from "../../src/slack-api";
import type { TestBinding } from "./worker";

const OWNER_TOKEN = "owner-token";
const WORKSPACE = "workspace/TONE";
const conversation = (id: string) => `${WORKSPACE}/conversation/${id}`;

const ROOT_TS = "1700000000.000100";
const REPLY_TS = "1700000001.000200";

const TEAMS: Record<string, { id: string; name: string; domain: string }> = {
  TONE: { id: "TONE", name: "One", domain: "one" },
  TTWO: { id: "TTWO", name: "Two", domain: "two" },
};

type RawMessage = {
  ts: string; user: string; text: string; thread_ts?: string; reply_count?: number;
  permalink?: string; channel?: { id: string };
};

/** A Slack user: the workspace their token belongs to, and their user ID. */
type FakeAccount = { team: string; user: string };

/**
 * A conversation in `team`. A public channel opens for every account in its workspace; the others
 * only for the tokens in `members`, which are also who it lists as members. A DM names the owner's
 * other participant as `peer`.
 */
type FakeConversation = {
  id: string; team: string; name?: string; kind: "public" | "private" | "im"; peer?: string;
  members: string[]; messages: RawMessage[]; replies: Record<string, RawMessage[]>;
};

/** The fake Slack's state, which tests set. */
type SlackBackend = {
  accounts: Map<string, FakeAccount>;
  conversations: FakeConversation[];
  /** Search matches by the exact query Slack is sent. */
  searches: Map<string, RawMessage[]>;
  /** Error codes Slack answers with instead, keyed by `<token>` or `<token> <method>`. */
  refusals: Map<string, string>;
  /** Each request Slack received, as `<token> <method>`, plus ` <channel>` when it names one. */
  requests: string[];
};

const root: RawMessage = { ts: ROOT_TS, user: "UOWNER", text: "launch plan", thread_ts: ROOT_TS, reply_count: 1 };
const reply: RawMessage = { ts: REPLY_TS, user: "UMEMBER", text: "launch tomorrow", thread_ts: ROOT_TS };

/** Each conversation kind as `users.conversations` filters by it. */
const KIND_TYPES = { public: "public_channel", private: "private_channel", im: "im" } as const;

/** A conversation as Slack's API returns it: like Slack, a DM names its other participant and no workspace. */
const rawConversation = (c: FakeConversation) => ({
  id: c.id, name: c.name, is_channel: c.kind !== "im", is_private: c.kind === "private", is_im: c.kind === "im",
  ...(c.kind === "im" ? { user: c.peer } : { team_id: c.team }),
});

/**
 * Slack as far as these reads use it. Workspace One holds #general (public, with one thread),
 * #secret (private, the owner and `insider-token`), #quiet (public, empty) and a direct message
 * between the owner and `member-token`. Every account is a workspace install.
 */
function slackBackend(): SlackBackend {
  const backend: SlackBackend = {
    accounts: new Map([[OWNER_TOKEN, { team: "TONE", user: "UOWNER" }]]),
    conversations: [
      {
        id: "CGENERAL", team: "TONE", name: "general", kind: "public", members: [OWNER_TOKEN, "member-token"],
        messages: [root], replies: { [ROOT_TS]: [root, reply] },
      },
      {
        id: "GSECRET", team: "TONE", name: "secret", kind: "private", members: [OWNER_TOKEN, "insider-token"],
        messages: [{ ts: ROOT_TS, user: "UOWNER", text: "launch secret" }], replies: {},
      },
      { id: "CQUIET", team: "TONE", name: "quiet", kind: "public", members: [OWNER_TOKEN], messages: [], replies: {} },
      {
        id: "DMEMBER", team: "TONE", kind: "im", peer: "UMEMBER", members: [OWNER_TOKEN, "member-token"],
        messages: [], replies: {},
      },
    ],
    searches: new Map([["launch", [
      { ...reply, channel: { id: "CGENERAL" },
        permalink: `https://one.slack.com/archives/CGENERAL/p1700000001000200?thread_ts=${ROOT_TS}&cid=CGENERAL` },
      { ts: ROOT_TS, user: "UOWNER", text: "launch secret", channel: { id: "GSECRET" } },
    ]]]),
    refusals: new Map(),
    requests: [],
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const method = url.pathname.slice("/api/".length);
    const params = url.searchParams;
    const channel = params.get("channel");
    backend.requests.push([token, method, channel].filter(Boolean).join(" "));
    const refusal = backend.refusals.get(`${token} ${method}`) ?? backend.refusals.get(token);
    if (refusal) return Response.json({ ok: false, error: refusal });
    const account = backend.accounts.get(token);
    if (!account) return Response.json({ ok: false, error: "invalid_auth" });
    const opens = (c: FakeConversation) =>
      c.members.includes(token) || (c.kind === "public" && c.team === account.team);
    const found = backend.conversations.find(c => c.id === channel && opens(c));
    switch (method) {
      case "auth.test":
        return Response.json({ ok: true, team_id: account.team, user_id: account.user, is_enterprise_install: false });
      case "team.info":
        return params.get("team") === account.team
          ? Response.json({ ok: true, team: TEAMS[account.team] })
          : Response.json({ ok: false, error: "team_not_found" });
      case "users.info":
        return Response.json({ ok: true, user: { id: params.get("user"), name: params.get("user")!.toLowerCase() } });
      case "users.list":
        return Response.json({ ok: true, members: [...backend.accounts.values()]
          .filter(member => member.team === params.get("team_id"))
          .map(member => ({ id: member.user, name: member.user.toLowerCase() })) });
      case "users.conversations": {
        const types = params.get("types")!.split(",");
        return Response.json({ ok: true, channels: backend.conversations
          .filter(c => c.members.includes(token) && c.team === params.get("team_id") && types.includes(KIND_TYPES[c.kind]))
          .map(rawConversation) });
      }
      case "search.messages":
        return Response.json({ ok: true, messages: {
          matches: (backend.searches.get(params.get("query")!) ?? []).filter(match =>
            backend.conversations.some(c => c.id === match.channel?.id && opens(c))),
          paging: { page: 1, pages: 1 },
        } });
    }
    if (!found) return Response.json({ ok: false, error: "channel_not_found" });
    switch (method) {
      case "conversations.info":
        return Response.json({ ok: true, channel: rawConversation(found) });
      case "conversations.members":
        return Response.json({ ok: true, members: found.members.map(member => backend.accounts.get(member)!.user) });
      case "conversations.history":
        return Response.json({ ok: true, messages: found.messages });
      case "conversations.replies":
        return Response.json({ ok: true, messages: found.replies[params.get("ts")!] ?? [] });
    }
    throw new Error(`Unexpected Slack request: ${url}`);
  });
  return backend;
}

/**
 * Connects a Slack account, named `name`, whose stored access token is `token`. `storedTeamId` is
 * the installation workspace the account saved, which an account connected before workspace
 * selection, such as a legacy org install, may lack.
 */
async function connectAccount(
    name: string, token: string, { team, user }: FakeAccount, storedTeamId = team): Promise<string> {
  const id = env.USER_ACCOUNT.idFromName(name);
  await runInDurableObject(env.USER_ACCOUNT.get(id), (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("accessToken", { token, expires: new Date(Date.now() + 3_600_000) });
    state.storage.kv.put("userId", user);
    state.storage.kv.put("teamId", storedTeamId);
    state.storage.kv.put("isEnterpriseInstall", false);
  });
  return id.toString();
}

/**
 * The owner's bindings over one fake Slack, driven from a TestHooks standing in for the overseer.
 * `ownerTeamId` is the workspace the owner's account saved (see connectAccount).
 */
function slackHarness({ ownerTeamId = "TONE" }: { ownerTeamId?: string } = {}) {
  const backend = slackBackend();
  const name = `slack-${crypto.randomUUID()}`;
  const hook = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName(name));
  const owner = connectAccount(`${name}-owner`, OWNER_TOKEN, backend.accounts.get(OWNER_TOKEN)!, ownerTeamId);
  const binding = async <B extends TestBinding>(kind: B["kind"], props: Omit<B["props"], "userObjectId">) =>
    ({ kind, facetName: `${kind}-${crypto.randomUUID()}`, props: { userObjectId: await owner, ...props } }) as B;
  return {
    backend,
    /** A workspace binding; by default, one created since reads reported subresources. */
    workspace: (props: Omit<Extract<TestBinding, { kind: "workspace" }>["props"], "userObjectId"> =
        { teamId: "TONE", reportsSubresources: true }) =>
      binding<Extract<TestBinding, { kind: "workspace" }>>("workspace", props),
    conversation: (props: Omit<Extract<TestBinding, { kind: "conversation" }>["props"], "userObjectId">) =>
      binding<Extract<TestBinding, { kind: "conversation" }>>("conversation", props),
    thread: (props: Omit<Extract<TestBinding, { kind: "thread" }>["props"], "userObjectId">) =>
      binding<Extract<TestBinding, { kind: "thread" }>>("thread", props),
    openWorkspace: async (b: TestBinding) => hook.openWorkspace(b),
    openConversation: async (b: TestBinding) => hook.openConversation(b),
    openThread: async (b: TestBinding) => hook.openThread(b),
    /** Each observation so far, as its title and the subresources it reported. */
    observations: async () => (await hook.observations()).map(({ title, subresources }) => [title, subresources]),
    /** An observer's connected account, whose token Slack knows as `account`. */
    observer: (token: string, account: FakeAccount): Promise<string> => {
      backend.accounts.set(token, account);
      return connectAccount(`${name}-${token}`, token, account);
    },
    // Each awaited here, so the test holds a native promise rather than the RPC promise itself.
    verify: async (b: TestBinding, observers: Record<string, string>, subresources: string[]) =>
      await hook.verify(b, Object.entries(observers).map(([id, userObjectId]) => ({ id, userObjectId })), subresources),
    history: async (b: TestBinding) => await hook.historicalSubresources(b),
    addObserver: async (b: TestBinding, observerId: string, userObjectId: string) =>
      await hook.addObserver(b, observerId, userObjectId),
    seed: async (b: TestBinding, entries: Record<string, unknown>) => await hook.seed(b, entries),
    /** Reconnects the account `userObjectId` as the Slack user behind `token`. */
    reconnect: async (userObjectId: string, token: string, account: FakeAccount) => {
      backend.accounts.set(token, account);
      await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)),
        async (instance: UserAccount, state: DurableObjectState) => {
          const grant: SlackOAuthGrant = {
            accessToken: { token, expires: new Date(Date.now() + 3_600_000) }, grantedScopes: [],
            userId: account.user, teamId: account.team, isEnterpriseInstall: false,
          };
          await instance.commitReconnect(stageCredentials(state.storage.kv, grant, Date.now()));
        });
    },
    /** The conversations.info lookups `token` made, by conversation. */
    lookups: (token: string) => backend.requests.filter(request => request.startsWith(`${token} conversations.info`)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Slack observations", () => {
  it("report the workspace for its metadata and member directory", async () => {
    const slack = slackHarness();
    using session = await slack.openWorkspace(await slack.workspace());
    expect(await session.getInfo()).toMatchObject({ teamId: "TONE" });
    using users = await session.listUsers();
    expect((await users.next())!.map(user => user.id)).toEqual(["UOWNER"]);
    expect(await session.getUser("UOWNER")).toMatchObject({ id: "UOWNER" });

    expect(await slack.observations()).toEqual([
      ["Read Slack workspace info", [WORKSPACE]],
      ["List Slack members (1)", [WORKSPACE]],
      ["Read Slack user uowner", [WORKSPACE]],
    ]);
  });

  it("report every conversation a listing or search page disclosed, and a thread's as its conversation", async () => {
    const slack = slackHarness();
    using session = await slack.openWorkspace(await slack.workspace());
    using channels = await session.listChannels();
    expect((await channels.next())!.map(entry => entry.info.id)).toEqual(["CGENERAL", "GSECRET", "CQUIET"]);
    using dms = await session.listDirectMessages();
    using dmPage = await dms.next();
    expect(dmPage!.map(entry => entry.info.peer?.id)).toEqual(["UMEMBER"]);
    using results = await session.search("launch");
    using matches = await results.next();
    expect(matches!.map(entry => entry.message.text)).toEqual(["launch tomorrow", "launch secret"]);
    expect((await matches![0].thread!.listReplies()).map(message => message.ts)).toEqual([ROOT_TS, REPLY_TS]);
    using opened = await session.getConversation("GSECRET");
    await opened.getInfo();

    expect(await slack.observations()).toEqual([
      ["List Slack channels (3)", [conversation("CGENERAL"), conversation("GSECRET"), conversation("CQUIET")]],
      ["List Slack direct messages (1)", [conversation("DMEMBER")]],
      ["Search Slack (2 results)", [conversation("CGENERAL"), conversation("GSECRET")]],
      ["Read Slack thread (2 messages)", [conversation("CGENERAL")]],
      ["Open Slack conversation #secret", [conversation("GSECRET")]],
      ["Read Slack conversation info #secret", [conversation("GSECRET")]],
    ]);
  });

  it("report the workspace for a listing or search page that named no conversation", async () => {
    const slack = slackHarness();
    slack.backend.conversations = [];
    using session = await slack.openWorkspace(await slack.workspace());
    using channels = await session.listChannels();
    expect(await channels.next()).toBeNull();
    using results = await session.search("nothing");
    expect(await results.next()).toBeNull();

    expect(await slack.observations()).toEqual([
      ["List Slack channels (0)", [WORKSPACE]],
      ["Search Slack (0 results)", [WORKSPACE]],
    ]);
  });

  it("report a conversation binding's conversation on every read, its empty pages included", async () => {
    const slack = slackHarness();
    using quiet = await slack.openConversation(await slack.conversation(
      { conversationId: "CQUIET", teamId: "TONE", reportsSubresources: true }));
    await quiet.getInfo();
    using members = await quiet.members();
    expect((await members.next())!.map(user => user.id)).toEqual(["UOWNER"]);
    using messages = await quiet.listMessages();
    expect(await messages.next()).toBeNull();
    using results = await quiet.search("nothing");
    expect(await results.next()).toBeNull();
    using general = await slack.openConversation(await slack.conversation(
      { conversationId: "CGENERAL", teamId: "TONE", reportsSubresources: true }));
    using thread = await general.getThread(ROOT_TS);
    expect(await thread.getRoot()).toMatchObject({ text: "launch plan" });

    const quietId = [conversation("CQUIET")];
    expect(await slack.observations()).toEqual([
      ["Read Slack conversation info #quiet", quietId],
      ["List Slack conversation members (1)", quietId],
      ["Read Slack messages (0)", quietId],
      ["Search Slack conversation (0 results)", quietId],
      ["Read Slack thread root", [conversation("CGENERAL")]],
    ]);
  });

  it("report a thread binding's conversation, whose access control covers its threads", async () => {
    const slack = slackHarness();
    using thread = await slack.openThread(await slack.thread({
      conversationId: "CGENERAL", threadTs: ROOT_TS, teamId: "TONE", reportsSubresources: true,
      permalink: "https://one.slack.com/archives/CGENERAL/p1700000000000100",
    }));
    await thread.getRoot();
    expect(await thread.listReplies()).toHaveLength(2);

    expect(await slack.observations()).toEqual([
      ["Read Slack thread root", [conversation("CGENERAL")]],
      ["Read Slack thread (2 messages)", [conversation("CGENERAL")]],
    ]);
  });
});

describe("Slack verifyObserverAccess", () => {
  it("allows a workspace to its members, and a conversation only to those who can open it there", async () => {
    const slack = slackHarness();
    const observers = {
      member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }),
      insider: await slack.observer("insider-token", { team: "TONE", user: "UINSIDER" }),
      outsider: await slack.observer("outsider-token", { team: "TTWO", user: "UOUTSIDER" }),
    };
    // The outsider's token can open #secret, as a Slack Connect guest's might, but not in One.
    slack.backend.conversations.find(c => c.id === "GSECRET")!.members.push("outsider-token");
    const workspace = await slack.workspace();

    expect(await slack.verify(workspace, observers, [WORKSPACE]))
      .toEqual({ allowedObserverIds: ["member", "insider"] });
    expect(await slack.verify(workspace, observers, [conversation("CGENERAL")]))
      .toEqual({ allowedObserverIds: ["member", "insider"] });
    expect(await slack.verify(workspace, observers, [WORKSPACE, conversation("GSECRET")]))
      .toEqual({ allowedObserverIds: ["insider"] });
    // The outsider was refused One without being asked about any conversation in it.
    expect(slack.lookups("outsider-token")).toEqual([]);
  });

  it("refuses the whole call for an ID no Slack read reports", async () => {
    const slack = slackHarness();
    const observers = { member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }) };
    const workspace = await slack.workspace();
    for (const id of [
      "workspace/EORG",
      "workspace/tone",
      "workspace/T%4FNE",
      "slack/workspace/TONE",
      "conversation/CGENERAL",
      "workspace/TONE/channel/CGENERAL",
      "workspace/TONE/conversation/CGENERAL/thread/1700000000.000100",
      // Another vendor's ID.
      "gmail/user/100",
    ]) {
      await expect(slack.verify(workspace, observers, [WORKSPACE, id]), id).rejects.toThrow(/subresource ID/);
    }
    expect(slack.backend.requests.filter(request => request.startsWith("member-token"))).toEqual([]);
  });

  it("fails the whole call when Slack can't say, and asks again next time", async () => {
    const slack = slackHarness();
    const observers = {
      member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }),
      flaky: await slack.observer("flaky-token", { team: "TONE", user: "UFLAKY" }),
    };
    slack.backend.refusals.set("flaky-token conversations.info", "fatal_error");
    const workspace = await slack.workspace();
    await expect(slack.verify(workspace, observers, [conversation("CGENERAL")])).rejects.toThrow(/fatal_error/);

    slack.backend.refusals.clear();
    expect(await slack.verify(workspace, observers, [conversation("CGENERAL")]))
      .toEqual({ allowedObserverIds: ["member", "flaky"] });
    expect(slack.lookups("flaky-token")).toHaveLength(2);
  });

  it.each([
    ["a missing scope", "missing_scope", /lacks permission/],
    ["revoked credentials", "token_revoked", /authentication has expired/],
    ["a rate limit", "ratelimited", /rate limit/],
  ])("throws for %s, which leaves the observer's access undetermined", async (_name, code, message) => {
    const slack = slackHarness();
    const observers = { member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }) };
    const workspace = await slack.workspace();
    slack.backend.refusals.set("member-token", code);
    await expect(slack.verify(workspace, observers, [WORKSPACE])).rejects.toThrow(message);
    slack.backend.refusals.clear();
    slack.backend.refusals.set("member-token conversations.info", code);
    await expect(slack.verify(workspace, observers, [conversation("CGENERAL")])).rejects.toThrow(message);
  });

  it("reuses an account's answers across bindings, asking Slack only about what it hasn't", async () => {
    const slack = slackHarness();
    const observers = { member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }) };
    expect(await slack.verify(await slack.workspace(), observers, [WORKSPACE, conversation("CGENERAL")]))
      .toEqual({ allowedObserverIds: ["member"] });
    const asked = slack.backend.requests.filter(request => request.startsWith("member-token"));
    expect(asked).toEqual(["member-token auth.test", "member-token team.info", "member-token conversations.info CGENERAL"]);

    const general = await slack.conversation({ conversationId: "CGENERAL", teamId: "TONE", reportsSubresources: true });
    expect(await slack.verify(general, observers, [conversation("CGENERAL")])).toEqual({ allowedObserverIds: ["member"] });
    expect(slack.backend.requests.filter(request => request.startsWith("member-token"))).toEqual(asked);
  });

  it("asks Slack again about a denial after 15 seconds, and about an allowed answer after 15 minutes", async () => {
    const slack = slackHarness();
    const observers = { member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }) };
    const workspace = await slack.workspace();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    expect(await slack.verify(workspace, observers, [conversation("CGENERAL"), conversation("GSECRET")]))
      .toEqual({ allowedObserverIds: [] });

    vi.setSystemTime(start + 14_999);
    await slack.verify(workspace, observers, [conversation("GSECRET")]);
    vi.setSystemTime(start + 15_000);
    await slack.verify(workspace, observers, [conversation("GSECRET")]);
    vi.setSystemTime(start + 15 * 60_000 - 1);
    await slack.verify(workspace, observers, [conversation("CGENERAL")]);
    vi.setSystemTime(start + 15 * 60_000);
    await slack.verify(workspace, observers, [conversation("CGENERAL")]);
    expect(slack.lookups("member-token").toSorted()).toEqual([
      "member-token conversations.info CGENERAL", "member-token conversations.info CGENERAL",
      "member-token conversations.info GSECRET", "member-token conversations.info GSECRET",
    ]);
  });

  it("asks Slack again after a reconnect, which may sign in as someone else", async () => {
    const slack = slackHarness();
    const member = await slack.observer("member-token", { team: "TONE", user: "UMEMBER" });
    const outsider = await slack.observer("outsider-token", { team: "TTWO", user: "UOUTSIDER" });
    const workspace = await slack.workspace();
    expect(await slack.verify(workspace, { member, outsider }, [WORKSPACE]))
      .toEqual({ allowedObserverIds: ["member"] });

    // Within either answer's lifetime, so only new credentials explain the new answers.
    await slack.reconnect(member, "member-elsewhere-token", { team: "TTWO", user: "UMEMBER2" });
    await slack.reconnect(outsider, "outsider-joined-token", { team: "TONE", user: "UOUTSIDER" });
    expect(await slack.verify(workspace, { member, outsider }, [WORKSPACE]))
      .toEqual({ allowedObserverIds: ["outsider"] });
  });
});

describe("Slack legacy observer history", () => {
  it("is empty for every binding created since reads reported subresources", async () => {
    const slack = slackHarness();
    const bindings = [
      await slack.workspace(),
      await slack.conversation({ conversationId: "GSECRET", teamId: "TONE", reportsSubresources: true }),
      await slack.thread({
        conversationId: "CGENERAL", threadTs: ROOT_TS, teamId: "TONE", reportsSubresources: true,
        permalink: "https://one.slack.com/archives/CGENERAL/p1700000000000100",
      }),
    ];
    for (const binding of bindings) expect(await slack.history(binding)).toEqual([]);
  });

  it("exports an older workspace binding's workspace and every conversation it recorded, as verifyObserverAccess checks them", async () => {
    const slack = slackHarness();
    const workspace = await slack.workspace({ teamId: "TONE" });
    await slack.seed(workspace, { "trackedConversation:GSECRET": "observed", "trackedConversation:CGENERAL": "pending" });
    const exported = [WORKSPACE, conversation("CGENERAL"), conversation("GSECRET")];
    expect(await slack.history(workspace)).toEqual(exported);
    // The export reads history without consuming it.
    expect(await slack.history(workspace)).toEqual(exported);

    const observers = {
      member: await slack.observer("member-token", { team: "TONE", user: "UMEMBER" }),
      insider: await slack.observer("insider-token", { team: "TONE", user: "UINSIDER" }),
    };
    expect(await slack.verify(workspace, observers, exported)).toEqual({ allowedObserverIds: ["insider"] });
  });

  it("names an older binding's workspace as its reads do: the pinned one, else the account's", async () => {
    const slack = slackHarness();
    const pinned = await slack.workspace({});
    await slack.seed(pinned, { boundTeamId: "TTWO" });
    expect(await slack.history(pinned)).toEqual(["workspace/TTWO"]);
    expect(await slack.history(await slack.workspace({}))).toEqual([WORKSPACE]);
  });

  it("exports an older conversation or thread binding's conversation", async () => {
    const slack = slackHarness();
    expect(await slack.history(await slack.conversation({ conversationId: "GSECRET", teamId: "TONE" })))
      .toEqual([conversation("GSECRET")]);
    // Without a workspace of its own or the account's, a thread binding recovers its permalink's.
    const unsaved = slackHarness({ ownerTeamId: "" });
    expect(await unsaved.history(await unsaved.thread({
      conversationId: "CGENERAL", threadTs: ROOT_TS, permalink: "https://one.slack.com/archives/CGENERAL/p1700000000000100",
    }))).toEqual([conversation("CGENERAL")]);
  });

  it("throws rather than export an older binding whose workspace can't be recovered", async () => {
    const slack = slackHarness({ ownerTeamId: "" });
    // The account's own workspace is not the one the permalink names.
    await expect(slack.history(await slack.thread({
      conversationId: "CGENERAL", threadTs: ROOT_TS, permalink: "https://elsewhere.slack.com/archives/CGENERAL/p1700000000000100",
    }))).rejects.toThrow(/team_access_not_granted/);
    // Slack can't say which workspaces the account has.
    slack.backend.refusals.set(OWNER_TOKEN, "fatal_error");
    await expect(slack.history(await slack.workspace({}))).rejects.toThrow(/fatal_error/);
  });
});

describe("Slack addObserver", () => {
  it("still requires workspace membership and every conversation reads recorded before reporting them", async () => {
    const slack = slackHarness();
    const workspace = await slack.workspace({ teamId: "TONE" });
    await slack.seed(workspace, { "trackedConversation:GSECRET": "pending" });
    const member = await slack.observer("member-token", { team: "TONE", user: "UMEMBER" });
    const insider = await slack.observer("insider-token", { team: "TONE", user: "UINSIDER" });
    const outsider = await slack.observer("outsider-token", { team: "TTWO", user: "UOUTSIDER" });

    await expect(slack.addObserver(workspace, "outsider", outsider)).rejects.toThrow(/not a member/);
    await expect(slack.addObserver(workspace, "member", member)).rejects.toThrow(/does not have access/);
    await slack.addObserver(workspace, "insider", insider);
  });
});
