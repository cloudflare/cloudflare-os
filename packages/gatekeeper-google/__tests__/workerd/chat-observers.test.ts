// Behavior tests for the Google Chat gatekeeper's observer checks: the subresources each binding's
// reads report, and how verifyObserverAccess() answers for them. Google is faked at the fetch layer,
// naming each caller's account by its token.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {GoogleChatGatekeeperImplProps} from "../../src/chat";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GoogleChatGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const OWNER_TOKEN = "owner-token";
/** The subresources reads report: two conversations, the first's member list, and the owner. */
const SPACE = "chat/space/AAAA";
const OTHER_SPACE = "chat/space/BBBB";
const MEMBERS = "chat/spaceMembers/AAAA";
const OWNER = "chat/user/100";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json", ...headers}});

type Observation = {title: string; subresources?: string[]};

/** The fake Google's per-token state, which tests set. */
type GoogleBackend = {
  /** The Google account subject behind each token, which is also its Chat user ID. */
  subjects: Map<string, string>;
  /** Tokens Chat refuses every space to, as it does an account outside them. */
  outsiders: Set<string>;
  /** Tokens Chat refuses member lists to, as a space restricted to its managers does. */
  hiddenMembers: Set<string>;
  /** Tokens whose Chat requests fail as an outage would. */
  failing: Set<string>;
  /** Tokens Chat refuses with 403 and this `ErrorInfo` reason, as it does one missing a scope. */
  refusals: Map<string, string>;
};

/** A named, threaded space as Chat returns it. */
const chatSpace = (id: string) => ({
  name: `spaces/${id}`, displayName: `Project ${id}`, spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES",
});

/**
 * Google as far as these reads use it: userinfo names the account behind each token, and Chat
 * holds two spaces, AAAA and BBBB, where AAAA has one member and one message, in thread T1.
 */
function googleBackend(): GoogleBackend {
  const backend: GoogleBackend = {
    subjects: new Map([[OWNER_TOKEN, "100"]]), outsiders: new Set(), hiddenMembers: new Set(), failing: new Set(),
    refusals: new Map(),
  };
  const member = {
    name: "spaces/AAAA/members/200", state: "JOINED", role: "ROLE_MEMBER",
    member: {name: "users/200", displayName: "Bob", type: "HUMAN"},
  };
  const message = {
    name: "spaces/AAAA/messages/M1", text: "hello", createTime: "2024-01-01T00:00:00Z",
    sender: {name: "users/200", displayName: "Bob", type: "HUMAN"}, thread: {name: "spaces/AAAA/threads/T1"},
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      const sub = backend.subjects.get(token);
      if (!sub) throw new Error(`Unexpected token: ${token}`);
      return json({sub, name: `User ${sub}`});
    }
    if (url.hostname !== "chat.googleapis.com") throw new Error(`Unexpected request: ${url}`);
    if (backend.failing.has(token)) return json({error: {status: "UNAVAILABLE"}}, 503, {"Retry-After": "0"});
    const reason = backend.refusals.get(token);
    if (reason) {
      return json({error: {status: "PERMISSION_DENIED", details: [
        {"@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com"},
      ]}}, 403);
    }
    if (backend.outsiders.has(token)) return json({error: {status: "PERMISSION_DENIED"}}, 403);
    if (url.pathname === "/v1/spaces") return json({spaces: [chatSpace("AAAA"), chatSpace("BBBB")]});
    const spaceId = /^\/v1\/spaces\/([A-Z]+)$/.exec(url.pathname)?.[1];
    if (spaceId) return json(chatSpace(spaceId));
    if (url.pathname.startsWith("/v1/spaces/AAAA/members")) {
      if (backend.hiddenMembers.has(token)) return json({error: {status: "PERMISSION_DENIED"}}, 403);
      return url.pathname === "/v1/spaces/AAAA/members" ? json({memberships: [member]}) : json(member);
    }
    if (url.pathname === "/v1/spaces/AAAA/messages") return json({messages: [message]});
    if (url.pathname === "/v1/spaces/AAAA/messages/M1") return json(message);
    throw new Error(`Unexpected request: ${url}`);
  });
  return backend;
}

/** A Chat binding of the owner's account: the whole account, or with `binding`, a space or thread. */
function chatHarness(
    backend: GoogleBackend, binding: Pick<GoogleChatGatekeeperImplProps, "spaceId" | "threadId"> = {},
) {
  const name = `chat-observers-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GoogleChatGatekeeperImpl.idFromName(name).toString();
  const facetName = `chat-${name}`;
  const queueId = `queue-${name}`;
  /** A connected Google account whose stored access token is `token`. */
  const account = async (token: string): Promise<string> => {
    const accountId = testEnv.UserAccount.idFromName(`${name}-${token}`);
    await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", `${token}-refresh`);
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
    });
    return accountId.toString();
  };
  const props = account(OWNER_TOKEN).then(async (userObjectId) => {
    const bound: GoogleChatGatekeeperImplProps = {userObjectId, ...binding};
    await hook.chatStartSession(facetName, id, bound, queueId);
    return bound;
  });
  return {
    account: async () => hook.openChatAccountSession(facetName, id, await props, queueId),
    space: async () => hook.openChatSession(facetName, id, await props, queueId),
    thread: async () => hook.openChatThreadSession(facetName, id, await props, queueId),
    /** Each observation so far, as its title and the subresources it reported. */
    observations: async () => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return (observations as Observation[]).map(({title, subresources}) => [title, subresources]);
    },
    /** An observer's connected account, which Google identifies as `subject`. */
    observer: (token: string, subject: string): Promise<string> => {
      backend.subjects.set(token, subject);
      return account(token);
    },
    verify: async (observers: Array<{id: string; userObjectId: string}>, subresources: string[]) =>
      hook.chatVerifyObserverAccess(facetName, id, await props, observers, subresources),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Chat observations", () => {
  it("report a conversation binding's conversation, and its member list for member reads", async () => {
    const chat = chatHarness(googleBackend(), {spaceId: "AAAA"});
    using space = await chat.space();
    await space.getMetadata();
    using messages = await space.listMessages();
    using page = await messages.next();
    expect((await page![0].message.getMetadata()).text).toBe("hello");
    using members = await space.listMembers();
    using _memberPage = await members.next();
    expect(await space.findMember("users/200")).toMatchObject({kind: "user"});
    await space.getCurrentUser();

    expect(await chat.observations()).toEqual([
      ["Open a Google Chat conversation", [SPACE]],
      ["Read Google Chat conversation metadata", [SPACE]],
      ["Read Google Chat messages", [SPACE]],
      ["Read a Google Chat message", [SPACE]],
      ["List Google Chat conversation members", [MEMBERS]],
      ["Look up a Google Chat conversation member", [MEMBERS]],
      ["Read the connected Google Chat identity", [SPACE]],
    ]);
  });

  it("report a thread binding's conversation, which Google's access control stops at", async () => {
    const chat = chatHarness(googleBackend(), {spaceId: "AAAA", threadId: "T1"});
    using thread = await chat.thread();
    using messages = await thread.listMessages();
    using page = await messages.next();
    expect(page!.map(entry => entry.info.text)).toEqual(["hello"]);

    expect(await chat.observations()).toEqual([
      ["Open a Google Chat thread", [SPACE]],
      ["Read Google Chat thread messages", [SPACE]],
    ]);
  });

  it("report the connected account on every read through a whole-account binding", async () => {
    const chat = chatHarness(googleBackend());
    using account = await chat.account();
    using spaces = await account.listSpaces();
    using page = await spaces.next();
    await page![0].space.getMetadata();
    await account.getCurrentUser();

    expect(await chat.observations()).toEqual([
      ["Open a Google Chat session", [OWNER]],
      ["List Google Chat conversations", [SPACE, OTHER_SPACE, OWNER]],
      ["Read Google Chat conversation metadata", [SPACE, OWNER]],
      ["Read the connected Google Chat identity", [OWNER]],
    ]);
  });
});

describe("Google Chat verifyObserverAccess", () => {
  it("allows a conversation to observers who can open it, and its members to those who can list them", async () => {
    const backend = googleBackend();
    const chat = chatHarness(backend, {spaceId: "AAAA"});
    const observers = [
      {id: "member", userObjectId: await chat.observer("member-token", "200")},
      {id: "restricted", userObjectId: await chat.observer("restricted-token", "300")},
      {id: "outsider", userObjectId: await chat.observer("outsider-token", "400")},
    ];
    backend.hiddenMembers.add("restricted-token");
    backend.outsiders.add("outsider-token");

    expect(await chat.verify(observers, [SPACE])).toEqual({allowedObserverIds: ["member", "restricted"]});
    expect(await chat.verify(observers, [SPACE, MEMBERS])).toEqual({allowedObserverIds: ["member"]});
  });

  it("allows the connected account only to observers whose account is that same Google account", async () => {
    const chat = chatHarness(googleBackend());
    const observers = [
      // The owner, through another connection to the same Google account.
      {id: "owner", userObjectId: await chat.observer("owner-again-token", "100")},
      {id: "colleague", userObjectId: await chat.observer("colleague-token", "200")},
    ];
    expect(await chat.verify(observers, [OWNER])).toEqual({allowedObserverIds: ["owner"]});
  });

  it("refuses the whole call for an ID that does not name a Chat conversation, member list or account", async () => {
    const chat = chatHarness(googleBackend(), {spaceId: "AAAA"});
    const observers = [{id: "member", userObjectId: await chat.observer("member-token", "200")}];
    for (const id of [
      "chat/space/AAAA/thread/T1",
      "chat/thread/T1",
      "chat/members/AAAA",
      "chat/space/..",
      "space/AAAA",
      // Other Google gatekeepers' IDs, which the observer's account could check.
      "gmail/user/100",
      "calendar/freeBusy/alice%40example.com",
    ]) {
      await expect(chat.verify(observers, [SPACE, id]), id).rejects.toThrow(/subresource ID|space ID/);
    }
  });

  it("fails the whole call when Chat can't say whether an observer can open the conversation", async () => {
    const backend = googleBackend();
    const chat = chatHarness(backend, {spaceId: "AAAA"});
    const observers = [
      {id: "member", userObjectId: await chat.observer("member-token", "200")},
      {id: "flaky", userObjectId: await chat.observer("flaky-token", "300")},
    ];
    backend.failing.add("flaky-token");
    await expect(chat.verify(observers, [SPACE])).rejects.toThrow(/http=503/);
  });

  it("throws when Chat refuses for a reason, which says nothing about access, and asks again next time", async () => {
    const backend = googleBackend();
    const chat = chatHarness(backend, {spaceId: "AAAA"});
    const observers = [{id: "member", userObjectId: await chat.observer("member-token", "200")}];
    backend.refusals.set("member-token", "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    await expect(chat.verify(observers, [SPACE]))
      .rejects.toThrow(/http=403 PERMISSION_DENIED ACCESS_TOKEN_SCOPE_INSUFFICIENT/);

    backend.refusals.clear();
    expect(await chat.verify(observers, [SPACE])).toEqual({allowedObserverIds: ["member"]});
  });
});
