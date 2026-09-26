// Behavior tests for the Google Chat gatekeeper Durable Object, deliberately few: each pins one
// property that only exists in the DO glue — the Node suites already cover the pure overlay and
// API-mapping logic, and CursorPager has its own tests. What cannot be seen from there is what
// actually leaves for Google and when, and what a real session does across the pager, the store,
// and the approval queue together.

import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {GoogleChatGatekeeperImpl, GoogleChatGatekeeperImplProps} from "../../src/chat";
import type {ChatMessageInfo, ChatListMessagesOptions} from "../../src/chat-types";
import type {ChatMessageRaw, ChatReactionRaw, ChatMembershipRaw} from "../../src/chat-api";
import type {TestHooks as TestHooksImpl} from "./worker";
import { ChatSpaceConfiguratorUI } from "../../src/google-configurators";

type TestHooks = {
  chatStartSession(
      facetName: string, id: string, props: GoogleChatGatekeeperImplProps,
      queueId: string): Promise<void>;
  runChatOperation(
      facetName: string, id: string, props: GoogleChatGatekeeperImplProps,
      queueId: string, operation: string, args: unknown[]): Promise<unknown>;
  chatApplyAction(
      facetName: string, id: string, props: GoogleChatGatekeeperImplProps,
      actionId: number): Promise<void>;
  chatRevertAction(
      facetName: string, id: string, props: GoogleChatGatekeeperImplProps,
      actionId: number): ReturnType<GoogleChatGatekeeperImpl["revertAction"]>;
  chatRejectAction(
      facetName: string, id: string, props: GoogleChatGatekeeperImplProps,
      actionId: number): ReturnType<GoogleChatGatekeeperImpl["rejectAction"]>;
  failNextObservation(queueId: string, title: string): void;
  readQueue(queueId: string): Promise<{
    submissions: Array<{actionId: number; description: unknown}>;
    observations: unknown[];
  }>;
};

const testEnv = env as unknown as {
  GoogleChatGatekeeperImpl: DurableObjectNamespace<GoogleChatGatekeeperImpl>;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooksImpl>;
};

function runHook<T>(
    hook: DurableObjectStub,
    callback: (instance: TestHooks) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(hook, callback as never);
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

const SPACE_ID = "AAAA";
const SPACE_NAME = `spaces/${SPACE_ID}`;

/**
 * Provider history is paged independently of the capability cursor, including private messages
 * the gatekeeper must omit. Requests are recorded so tests check scope as well as returned data.
 */
function chatBackend() {
  const state = {
    spaceType: "SPACE",
    spaceName: "Project",
    spaceThreadingState: "THREADED_MESSAGES",
    messages: [] as ChatMessageRaw[],
    members: [] as ChatMembershipRaw[],
    memberRequests: 0,
    spaceLists: 0,
    searches: [] as string[],
    pageSize: 50,
    lists: [] as URL[],
    gets: [] as string[],
    downloads: [] as string[],
    reactions: [] as ChatReactionRaw[],
    reactionWrites: [] as Array<{method: string; id: string}>,
    deletes: [] as string[],
    edits: [] as Array<{name: string; text: string}>,
    /** Answer creates the way Google replays an idempotent request: names only, no thread. */
    echoCreates: false,
    getMessageStatus: 200,
    deleteAfterGet: false,
    rejectedToken: undefined as string | undefined,
    sentRequests: new Map<string, string>(),
    /** Message names Chat would refuse to delete without force: they have threaded replies. */
    repliesOn: new Set<string>(),
    creates: [] as Array<{
      requestId: string | null;
      replyOption: string | null;
      body: {text: string; thread?: {name: string}};
    }>,
  };
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if (state.rejectedToken && url.hostname === "chat.googleapis.com" &&
        new Headers(init.headers).get("Authorization") === `Bearer ${state.rejectedToken}`) return json({}, 403);
    if (url.pathname.startsWith("/v1/media/")) {
      state.downloads.push(url.pathname);
      return new Response("attachment bytes");
    }
    const space = {name: SPACE_NAME, displayName: state.spaceName,
      spaceType: state.spaceType, spaceThreadingState: state.spaceThreadingState};
    if (url.pathname === "/v1/spaces") { state.spaceLists++; return json({spaces: [space]}); }
    const spaceGet = /^\/v1\/spaces\/([^/:]+)$/.exec(url.pathname)?.[1];
    if (spaceGet) return json({...space, name: `spaces/${spaceGet}`});
    if (url.pathname === "/v1/spaces/-/messages:search") {
      // A provider that ignores the space filter: the capability must still refuse foreign results.
      const {filter} = JSON.parse(init.body as string) as {filter: string};
      state.searches.push(filter);
      const keyword = /^"([^"]+)"/.exec(filter)?.[1];
      return json({results: state.messages
        .filter(message => !keyword || message.text?.includes(keyword))
        .map(message => ({message}))});
    }
    if (url.pathname === `/v1/spaces/${SPACE_ID}/members`) {
      state.memberRequests++;
      return json({memberships: state.members});
    }
    if (url.pathname.startsWith(`/v1/spaces/${SPACE_ID}/members/`)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const member = state.members.find(item => item.member?.name === `users/${id}`);
      return member ? json(member) : json({}, 404);
    }
    if (url.pathname === `/v1/spaces/${SPACE_ID}/messages`) {
      if (method === "GET") {
        state.lists.push(url);
        const filter = url.searchParams.get("filter") ?? "";
        const thread = /thread\.name = (\S+)/.exec(filter)?.[1];
        const after = /createTime > "([^"]+)"/.exec(filter)?.[1];
        const before = /createTime < "([^"]+)"/.exec(filter)?.[1];
        const sign = url.searchParams.get("orderBy") === "createTime DESC" ? -1 : 1;
        const messages = state.messages.filter(message =>
          (!thread || message.thread?.name === thread) &&
          (!after || Date.parse(message.createTime!) > Date.parse(after)) &&
          (!before || Date.parse(message.createTime!) < Date.parse(before)))
          .toSorted((a, b) => sign * (Date.parse(a.createTime!) - Date.parse(b.createTime!)));
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const end = start + state.pageSize;
        return json({messages: messages.slice(start, end),
          ...(end < messages.length ? {nextPageToken: String(end)} : {})});
      }
      const body = JSON.parse(init.body as string) as {text: string; thread?: {name: string}};
      const requestId = url.searchParams.get("requestId")!;
      const prior = state.sentRequests.get(requestId);
      if (prior) return json({name: prior, text: body.text});
      if (body.thread && !state.messages.some(message => message.thread?.name === body.thread!.name)) {
        return json({}, 404);
      }
      state.creates.push({requestId: url.searchParams.get("requestId"),
        replyOption: url.searchParams.get("messageReplyOption"), body});
      const created = {
        name: `${SPACE_NAME}/messages/M${state.creates.length}`,
        text: body.text,
        createTime: new Date().toISOString(),
        sender: {name: "users/subject-a", type: "HUMAN"},
        thread: body.thread ?? {name: `${SPACE_NAME}/threads/T${state.creates.length}`},
        threadReply: body.thread !== undefined,
      };
      state.messages.push(created);
      state.sentRequests.set(requestId, created.name);
      return json(state.echoCreates ? {name: created.name, text: created.text} : created);
    }
    const name = url.pathname.slice("/v1/".length);
    const reactionParent = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions$/.exec(name)?.[1];
    if (reactionParent) {
      if (method === "GET") {
        const filter = url.searchParams.get("filter") ?? "";
        const emoji = /emoji.unicode = "([^"]+)"/.exec(filter)?.[1];
        const user = /user.name = "([^"]+)"/.exec(filter)?.[1];
        const reactions = state.reactions.filter(reaction =>
          reaction.name?.startsWith(`${reactionParent}/reactions/`) &&
          (!emoji || reaction.emoji?.unicode === emoji) && (!user || reaction.user?.name === user));
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const end = start + state.pageSize;
        return json({reactions: reactions.slice(start, end),
          ...(end < reactions.length ? {nextPageToken: String(end)} : {})});
      }
      if (method === "POST") {
        const {emoji} = JSON.parse(init.body as string) as {emoji: {unicode: string}};
        const reaction = {name: `${reactionParent}/reactions/R${state.reactionWrites.length + 1}`,
          emoji, user: {name: "users/subject-a", type: "HUMAN"}};
        state.reactions.push(reaction);
        state.reactionWrites.push({method, id: reaction.name});
        return json(reaction);
      }
    }
    const reactionIndex = state.reactions.findIndex(reaction => reaction.name === name);
    if (reactionIndex !== -1 && method === "DELETE") {
      state.reactions.splice(reactionIndex, 1);
      state.reactionWrites.push({method, id: name});
      return json({});
    }
    const index = state.messages.findIndex(message => message.name === name);
    if (index !== -1) {
      if (method === "GET") {
        state.gets.push(name);
        if (state.getMessageStatus !== 200) return json({}, state.getMessageStatus);
        const message = state.messages[index];
        if (state.deleteAfterGet) { state.deleteAfterGet = false; state.messages.splice(index, 1); }
        return json(message);
      }
      if (method === "PATCH") {
        const {text} = JSON.parse(init.body as string) as {text: string};
        state.edits.push({name, text});
        state.messages[index].text = text;
        state.messages[index].lastUpdateTime = new Date().toISOString();
        return json(state.messages[index]);
      }
      if (method === "DELETE") {
        if (state.repliesOn.has(name)) {
          return json({error: {status: "FAILED_PRECONDITION"}}, 400);
        }
        state.deletes.push(name);
        state.messages.splice(index, 1);
        return json({});
      }
    }
    return json({}, 404);
  };
  return {state, fetch: fetchImpl};
}

function chatHarness(
    backend: ReturnType<typeof chatBackend>,
    userInfo: (token?: string | null) => {sub: string; name?: string} = () => ({sub: "subject-a", name: "Ada"}),
    accountBinding = false,
) {
  // Plain flags rather than promises: the stub runs inside the gatekeeper DO, and a promise made
  // in the test context cannot be awaited there.
  const gate = {hold: false, reached: false, released: false};
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
      if (gate.hold) {
        gate.hold = false;
        gate.reached = true;
        while (!gate.released) await tick();
      }
      return json(userInfo(new Headers(init.headers).get("Authorization")));
    }
    return backend.fetch(url, init);
  });
  const name = `chat-test-${crypto.randomUUID()}`;
  let hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GoogleChatGatekeeperImpl.idFromName(name).toString();
  const facetName = `chat-${name}`;
  const props: GoogleChatGatekeeperImplProps = {
    userObjectId: testEnv.UserAccount.idFromName(name).toString(),
    ...(accountBinding ? {} : {spaceId: SPACE_ID}),
  };
  const queueId = `queue-${crypto.randomUUID()}`;
  const userObject = testEnv.UserAccount.get(testEnv.UserAccount.idFromName(name));
  const ready = runInDurableObject(userObject,
    (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", "refresh-token");
      state.storage.kv.put("accessToken",
        {token: "access-token", expires: new Date(Date.now() + 3_600_000)});
    })
    .then(() => runHook(hook, instance =>
      instance.chatStartSession(facetName, id, props, queueId)));
  const observerId = testEnv.UserAccount.idFromName(`${name}-observer`);
  return {
    setToken: (token: string) => runInDurableObject(userObject, (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
    }),
    session: () => ready.then(() => hook.openChatSession(facetName, id, props, queueId)),
    account: () => ready.then(() => hook.openChatAccountSession(facetName, id, props, queueId)),
    addObserver: async () => {
      await ready;
      await runInDurableObject(testEnv.UserAccount.get(observerId), (_instance: unknown, state: DurableObjectState) => {
        state.storage.kv.put("refreshToken", "observer-refresh-token");
        state.storage.kv.put("accessToken", {token: "observer-token", expires: new Date(Date.now() + 3_600_000)});
      });
      await hook.chatAddObserver(facetName, id, props, queueId, "viewer", observerId.toString());
    },
    restart: async () => {
      await ready;
      await abortAllDurableObjects();
      hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
      await runHook(hook, instance => instance.chatStartSession(facetName, id, props, queueId));
    },
    call: (operation: string, args: unknown[] = []): Promise<unknown> => ready.then(() =>
      runHook(hook, instance =>
        instance.runChatOperation(facetName, id, props, queueId, operation, args))),
    applyAction: (actionId: number): Promise<void> => ready.then(() =>
      runHook(hook, instance => instance.chatApplyAction(facetName, id, props, actionId))),
    revertAction: (actionId: number) => ready.then(() =>
      runHook(hook, instance => instance.chatRevertAction(facetName, id, props, actionId))),
    rejectAction: (actionId: number) => ready.then(() =>
      runHook(hook, instance => instance.chatRejectAction(facetName, id, props, actionId))),
    /** Hold the next account lookup; resolves once it is reached, returning its release. */
    holdNextUserInfo: async (): Promise<() => void> => {
      gate.hold = true;
      while (!gate.reached) await tick();
      return () => { gate.released = true; };
    },
    failNextObservation: (title: string): Promise<void> => ready.then(() =>
      runHook(hook, instance => instance.failNextObservation(queueId, title))),
    readQueue: () => ready.then(() =>
      runHook(hook, instance => instance.readQueue(queueId))),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Chat identities", () => {
  const directMessage = () => {
    const backend = chatBackend();
    backend.state.spaceType = "DIRECT_MESSAGE";
    backend.state.spaceName = "";
    backend.state.members.push(
      {name: `${SPACE_NAME}/members/subject-a`, member: {name: "users/subject-a", displayName: "Ada", type: "HUMAN"}},
      {name: `${SPACE_NAME}/members/123`, member: {name: "users/123", displayName: "Alice Smith", type: "HUMAN"}},
    );
    return backend;
  };

  it("keeps listings cheap and resolves a DM name only when metadata is requested", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend, undefined, true);
    using account = await chat.account();
    using cursor = await account.listSpaces();
    await chat.failNextObservation("List Google Chat conversations");
    await expect(Promise.resolve(cursor.next())).rejects.toThrow(/denied by the test/);
    using page = await cursor.next();
    expect(page![0].info).toMatchObject({id: SPACE_NAME, type: "directMessage"});
    expect(page![0].info.name).toBeUndefined();
    expect(backend.state.memberRequests).toBe(0);
    expect(await page![0].space.getMetadata()).toMatchObject({name: "Alice Smith"});
    expect(backend.state.memberRequests).toBe(1);
  });

  it("does not resolve participant names during picker searches", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    using _session = await chat.session();
    const picker = new ChatSpaceConfiguratorUI(async () => ({token: "access-token", expires: new Date(Date.now() + 60_000)}));
    expect(await picker.listChatSpaces("")).toEqual([
      {value: SPACE_ID, title: "Direct message", subtitle: "Direct message", meta: SPACE_ID},
    ]);
    expect(await picker.listChatSpaces("Alice")).toEqual([]);
    expect(backend.state.memberRequests).toBe(0);
  });

  it("opens an exact conversation reference without scanning the picker listing", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    using _session = await chat.session();
    const picker = new ChatSpaceConfiguratorUI(async () => ({token: "access-token", expires: new Date(Date.now() + 60_000)}));
    expect(await picker.listChatSpaces(SPACE_NAME)).toEqual([
      {value: SPACE_ID, title: "Direct message", subtitle: "Direct message", meta: SPACE_ID},
    ]);
    expect(await picker.listChatSpaces(`https://chat.google.com/dm/${SPACE_ID}`)).toHaveLength(1);
    expect(backend.state.spaceLists).toBe(0);
  });

  it("admits an observer only when their own account can open the conversation", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    backend.state.rejectedToken = "observer-token";
    await expect(chat.addObserver()).rejects.toThrow(/cannot access the Google Chat conversation/);
    backend.state.rejectedToken = undefined;
    await chat.addObserver();
    using space = await chat.session();
    expect(await space.getMetadata()).toMatchObject({name: "Alice Smith"});
  });

  it("uses Chat-provided names across results without extra identity lookups", async () => {
    const backend = chatBackend();
    const alice = {name: "users/123", displayName: "Alice Smith", type: "HUMAN"};
    const expected = {id: "users/123", name: "Alice Smith", type: "human"};
    backend.state.messages.push(
      {...threadMessage("root", "A", "2024-01-01T00:00:00Z"), sender: alice},
      {...threadMessage("reply", "A", "2024-01-02T00:00:00Z", true), sender: alice},
      {...threadMessage("app", "A", "2024-01-03T00:00:00Z", true), sender: {name: "users/456", type: "BOT"}},
    );
    backend.state.members.push({name: `${SPACE_NAME}/members/123`, member: alice});
    backend.state.reactions.push({name: `${messageName("root")}/reactions/one`,
      emoji: {unicode: "👍"}, user: alice});
    const chat = chatHarness(backend);
    using requests = vi.spyOn(globalThis, "fetch");
    using space = await chat.session();
    using messages = await space.listMessages();
    using page = await messages.next();
    expect(page![0].info.sender).toEqual(expected);
    expect(page![1].info.sender).toEqual(expected);
    expect(page![2].info.sender).toEqual({id: "users/456", type: "app"});
    expect((await page![0].message.getMetadata()).sender).toEqual(expected);
    using threads = await space.listThreads();
    using entries = await threads.next();
    expect(entries![0].info.rootMessage?.sender).toEqual(expected);
    expect((await entries![0].thread.getMetadata()).rootMessage?.sender).toEqual(expected);
    using members = await space.listMembers();
    using memberPage = await members.next();
    expect(memberPage![0].member).toEqual(expected);
    expect((await space.findMember("users/123"))?.member).toEqual(expected);
    using reactions = await page![0].message.listReactions();
    using reactionPage = await reactions.next();
    expect(reactionPage![0].user).toEqual(expected);
    const hosts = requests.mock.calls.map(([input]) =>
      new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname);
    expect(new Set(hosts)).toEqual(new Set(["www.googleapis.com", "chat.googleapis.com"]));
  });
});

describe("Google Chat gatekeeper behaviors", () => {
  it("recovers a thread ID from a partial idempotent send response", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using thread = (await space.startThread("root")).thread;
    using _reply = (await thread.post("reply")).message;
    // Google may answer a create with only the submitted fields plus the assigned name.
    backend.state.echoCreates = true;
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.creates).toHaveLength(2);
    expect(backend.state.creates[1].body.thread?.name).toBe(threadName("T1"));
  });

  // approveAction and rejectAction both pass the overseer's "still pending" check before their own
  // awaits, so a reject can land while an apply is resolving the account. The write must not
  // reach Google once the queue has recorded the action as rejected.
  it("does not send an action that was rejected while its apply was in flight", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    await chat.call("space.post", ["hello"]);
    const held = chat.holdNextUserInfo();
    const applying = chat.applyAction(1);
    const release = await held;
    await chat.rejectAction(1);
    release();
    await expect(applying).rejects.toThrow(/rejected before it was applied/);
    expect(backend.state.creates).toEqual([]);
    await expect(chat.revertAction(1)).resolves.toMatchObject({message: expect.stringMatching(/no longer be undone/)});
  });

  it("keeps a denied unsend retryable and handles disappearance between GET and DELETE", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    await chat.call("space.post", ["hello"]);
    await chat.applyAction(1);
    backend.state.getMessageStatus = 403;
    await expect(chat.revertAction(1)).rejects.toThrow(/http=403/);
    expect(backend.state.messages).toHaveLength(1);
    backend.state.getMessageStatus = 200;
    backend.state.deleteAfterGet = true;
    await chat.revertAction(1);
    expect(backend.state.messages).toEqual([]);
  });

  it("rechecks the authoritative account before delayed apply and undo", async () => {
    const backend = chatBackend();
    let sub = "subject-a";
    const chat = chatHarness(backend, () => ({sub}));
    await chat.call("space.post", ["hello"]);
    sub = "subject-b";
    await expect(chat.applyAction(1)).rejects.toThrow(/different Google account/);
    expect(backend.state.creates).toEqual([]);
    sub = "subject-a";
    await chat.applyAction(1);
    sub = "subject-b";
    await expect(chat.revertAction(1)).rejects.toThrow(/different Google account/);
    expect(backend.state.deletes).toEqual([]);
  });

  it("refuses a replacement account token when a live session reloads after a 403", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend, token => ({sub: token === "Bearer replacement" ? "subject-b" : "subject-a"}));
    using space = await chat.session();
    await chat.setToken("replacement");
    backend.state.rejectedToken = "access-token";
    await expect(Promise.resolve(space.getMetadata())).rejects.toThrow(/different Google account/);
  });

  it("hides replies to rejected pending roots across restart", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using thread = (await space.startThread("root")).thread;
    using reply = (await thread.post("reply")).message;
    await chat.rejectAction(1);
    await expect(Promise.resolve(reply.getMetadata())).rejects.toThrow(/root message was never created/);
    await chat.restart();
    expect(await chat.call("space.listMessages", [{}])).toEqual([]);
    await expect(chat.applyAction(2)).rejects.toThrow(/root message was never created/);
  });

  it.each([false, true])("gates sends and supports undo (already removed: %s)", async alreadyRemoved => {
    const backend = chatBackend();
    const chat = chatHarness(backend);

    const info = await chat.call("space.post", ["hello"]) as ChatMessageInfo;
    expect(info).toMatchObject({id: "pending:send:1", pending: true, text: "hello"});

    expect(backend.state.creates).toEqual([]);
    const {submissions} = await chat.readQueue();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      actionId: 1,
      description: {actionKind: {tag: "chatSendMessage"}, autoApprovable: true},
    });

    await chat.applyAction(1);
    expect(backend.state.creates).toHaveLength(1);
    // The request id is what makes a retried apply return the first attempt's message instead of
    // posting a second one.
    expect(backend.state.creates[0].requestId).toBeTruthy();
    expect(backend.state.creates[0].body).toEqual({text: "hello"});
    if (alreadyRemoved) backend.state.messages.length = 0;

    // Explicit deletion is absent from the message capability, but a send still has an undo.
    expect(await chat.revertAction(1)).toBeUndefined();
    expect(backend.state.messages).toEqual([]);
    expect(backend.state.deletes).toEqual(alreadyRemoved ? [] : [`${SPACE_NAME}/messages/M1`]);
  });

  // Chat refuses a non-force delete of a message with threaded replies, and force would cascade
  // into other people's replies. The undo must explain itself and stay retryable rather than
  // surface a raw provider error.
  it("reports an un-send blocked by threaded replies and allows a retry", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    await chat.call("space.post", ["hello"]);
    await chat.applyAction(1);

    backend.state.repliesOn.add(`${SPACE_NAME}/messages/M1`);
    expect(await chat.revertAction(1)).toMatchObject({
      message: expect.stringMatching(/threaded replies/), canRetry: true,
    });
    expect(backend.state.messages).toHaveLength(1);

    backend.state.repliesOn.clear();
    expect(await chat.revertAction(1)).toBeUndefined();
    expect(backend.state.messages).toEqual([]);
  });

  // CursorPager leaves a denied page's cursor where it was so a retry re-offers the same page.
  // The overlay must behave the same way: a queued message shown on the denied page has to be on
  // the retried page too, which fails if overlay state advances when the pager does not. Ordered
  // newest-first because that is where the queued message rides the *first* page — the case a
  // stale "already past the first page" flag silently drops on retry.
  it("re-offers a denied page with the queued message still on it", async () => {
    const backend = chatBackend();
    backend.state.messages.push({
      name: `${SPACE_NAME}/messages/EXISTING`,
      text: "already there",
      createTime: "2024-01-01T00:00:00Z",
      sender: {name: "users/subject-a", type: "HUMAN"},
    });
    const chat = chatHarness(backend);
    await chat.call("space.post", ["queued hello"]);

    await chat.failNextObservation("Read Google Chat messages");
    const {firstError, page} = await chat.call(
      "space.listMessagesRetry", [{order: "newestFirst"}]) as {
      firstError: string;
      page: ChatMessageInfo[] | null;
    };
    expect(firstError).toMatch(/denied by the test/);
    expect(page?.map(info => [info.text, info.pending === true])).toEqual([
      ["queued hello", true],
      ["already there", false],
    ]);
  });

  // The binding pins the connected account's stable subject: if the credentials later follow a
  // reconnect to a different Google account, "my own messages" must not silently become somebody
  // else's.
  it("refuses to act once the connected Google account changes", async () => {
    let sub = "subject-a";
    const chat = chatHarness(chatBackend(), () => ({sub}));
    await chat.call("space.listMessages", [{}]);
    sub = "subject-b";
    await expect(chat.call("space.listMessages", [{}]))
      .rejects.toThrow(/different Google account/);
  });

  it("allows post then edit before sending without changing the original approved post", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.post("Working...")).message;
    await message.edit("Done.");
    expect(await message.getMetadata()).toMatchObject({
      id: "pending:send:1", text: "Done.", pending: true, editedAt: expect.any(Date),
    });
    using history = await space.listMessages();
    using messages = await history.next();
    expect(messages!.map(entry => entry.info.text)).toEqual(["Done."]);
    using threads = await space.listThreads();
    using entries = await threads.next();
    expect(entries![0].info.latestMessage.text).toBe("Done.");
    expect((await chat.readQueue()).submissions).toHaveLength(2);
    expect(backend.state.creates).toEqual([]);
    expect(backend.state.edits).toEqual([]);

    await expect(chat.applyAction(2)).rejects.toThrow(/Post the message before/);
    expect(backend.state.edits).toEqual([]);
    await chat.applyAction(1);
    expect(backend.state.creates[0].body.text).toBe("Working...");
    expect((await message.getMetadata()).text).toBe("Done.");
    using committedHistory = await space.listMessages();
    using committedMessages = await committedHistory.next();
    expect(committedMessages![0].info.text).toBe("Done.");
    await chat.applyAction(2);
    expect(backend.state.edits).toEqual([{name: messageName("M1"), text: "Done."}]);
    expect((await message.getMetadata()).text).toBe("Done.");
    await chat.revertAction(2);
    expect((await message.getMetadata()).text).toBe("Working...");
  });

  it("rewinds rejected queued edits in direct reads and history", async () => {
    const chat = chatHarness(chatBackend());
    using space = await chat.session();
    using message = (await space.post("Working...")).message;
    await message.edit("Done.");
    await message.edit("Actually, still working.");
    expect((await message.getMetadata()).text).toBe("Actually, still working.");
    await chat.rejectAction(3);
    expect((await message.getMetadata()).text).toBe("Done.");
    await chat.rejectAction(2);
    expect((await message.getMetadata()).text).toBe("Working...");
    using history = await space.listMessages();
    using messages = await history.next();
    expect(messages!.map(entry => entry.info.text)).toEqual(["Working..."]);
  });

  it("applies queued edits to one message in submission order", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Investigating");
    await message.edit("Resolved");
    await expect(chat.applyAction(2)).rejects.toThrow(/earlier edits first/);
    expect(backend.state.edits).toEqual([]);
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.messages[0].text).toBe("Resolved");
  });

  it("refuses an edit whose prerequisite post was rejected", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.post("Working...")).message;
    await message.edit("Done.");
    expect(await chat.rejectAction(1)).toEqual({restart: true});
    await expect(chat.applyAction(2)).rejects.toThrow(/never created/);
    expect(backend.state.creates).toEqual([]);
    expect(backend.state.edits).toEqual([]);
  });

  it("restores queued edits across a worker restart", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    let id: string;
    {
      using space = await chat.session();
      using message = (await space.post("Working...")).message;
      await message.edit("Done.");
      id = (await message.getMetadata()).id;
      await chat.applyAction(1);
    }
    await chat.restart();
    using space = await chat.session();
    using message = (await space.getMessage(id)).message;
    expect((await message.getMetadata()).text).toBe("Done.");
    await chat.applyAction(2);
    expect(backend.state.messages[0].text).toBe("Done.");
  });

  it("throws from getMessage itself for missing, private, deleted, or out-of-scope messages", async () => {
    const backend = chatBackend();
    backend.state.messages.push(
      {...threadMessage("private", "A", "2024-01-01T00:00:00Z"), privateMessageViewer: {name: "users/1"}},
      {...threadMessage("deleted", "A", "2024-01-01T00:00:00Z"), deleteTime: "2024-01-02T00:00:00Z"},
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.getMessage(messageName("missing")))).rejects.toThrow(/http=404/);
    await expect(Promise.resolve(space.getMessage(messageName("private")))).rejects.toThrow(/not available/);
    await expect(Promise.resolve(space.getMessage(messageName("deleted")))).rejects.toThrow(/no longer available/);
    await expect(Promise.resolve(space.getMessage("spaces/OTHER/messages/1")))
      .rejects.toThrow(/different conversation/);
  });

  it("scopes a space search to its conversation and rejects foreign results", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    expect(await space.getCurrentUser()).toEqual({id: "users/subject-a", name: "Ada", type: "human"});
    using results = await space.searchMessages({text: "root"});
    using page = await results.next();
    expect(page!.map(entry => entry.info.id)).toEqual([messageName("root")]);
    expect(backend.state.searches).toEqual([`"root" AND (space.name = "${SPACE_NAME}")`]);
    backend.state.messages.push({name: "spaces/OTHER/messages/foreign", text: "root",
      createTime: "2024-01-01T00:00:00Z"});
    using retry = await space.searchMessages({text: "root"});
    await expect(Promise.resolve(retry.next())).rejects.toThrow(/only covers one/);
  });
});

const threadName = (id: string) => `${SPACE_NAME}/threads/${id}`;
const messageName = (id: string) => `${SPACE_NAME}/messages/${id}`;

function threadMessage(id: string, thread: string, createTime: string, reply = false): ChatMessageRaw {
  return {name: messageName(id), text: id, thread: {name: threadName(thread)},
    createTime, threadReply: reply};
}

describe("Google Chat thread capabilities", () => {
  it("enriches roots already in the discovery page without extra message lookups", async () => {
    const backend = chatBackend();
    backend.state.messages.push(
      threadMessage("root", "A", "2024-01-01T00:00:00Z"),
      threadMessage("reply", "A", "2024-01-02T00:00:00Z", true),
      threadMessage("zero-replies", "B", "2024-01-03T00:00:00Z"),
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    using cursor = await space.listThreads();
    using page = await cursor.next();
    expect(page!.map(({info}) => [info.id, info.latestMessage.text, info.rootMessage?.text]))
      .toEqual([[threadName("B"), "zero-replies", "zero-replies"], [threadName("A"), "reply", "root"]]);
    expect(backend.state.lists).toHaveLength(1);
    expect(backend.state.gets).toEqual([]);
  });

  it("omits roots outside the current page rather than fetching them for discovery or metadata", async () => {
    const backend = chatBackend();
    backend.state.pageSize = 1;
    backend.state.messages.push(
      threadMessage("root", "A", "2024-01-01T00:00:00Z"),
      threadMessage("reply", "A", "2024-01-02T00:00:00Z", true),
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    using cursor = await space.listThreads({since: new Date("2024-01-02T00:00:00Z")});
    using page = await cursor.next();
    expect(page![0].info).not.toHaveProperty("rootMessage");
    expect(backend.state.lists).toHaveLength(1);
    const info = await page![0].thread.getMetadata();
    expect(info).toMatchObject({id: threadName("A"), spaceId: SPACE_NAME,
      latestMessage: {text: "reply"}});
    expect(info).not.toHaveProperty("rootMessage");
    expect(backend.state.lists).toHaveLength(2);
    expect(backend.state.gets).toEqual([]);
    using root = (await page![0].thread.getRootMessage())!.message;
    expect((await root!.getMetadata()).text).toBe("root");
  });

  it("refreshes authorized thread metadata including same-page roots and pending edits", async () => {
    const backend = chatBackend();
    const reply = threadMessage("reply", "A", "2024-01-02T00:00:00Z", true);
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"), reply);
    const chat = chatHarness(backend);
    using space = await chat.session();
    using thread = (await space.getThread(threadName("A"))).thread;
    using root = (await thread.getRootMessage())!.message;
    await root!.edit("revised root");
    await chat.failNextObservation("Read Google Chat thread metadata");
    await expect(Promise.resolve(thread.getMetadata())).rejects.toThrow(/denied by the test/);
    reply.text = "new reply text";
    expect(await thread.getMetadata()).toMatchObject({
      id: threadName("A"), spaceId: SPACE_NAME,
      rootMessage: {text: "revised root"}, latestMessage: {text: "new reply text"},
    });
    backend.state.messages.length = 0;
    await expect(Promise.resolve(thread.getMetadata())).rejects.toThrow(/not available/);
  });

  it("discovers zero-reply roots and recently replied-to old threads once across pages and retries", async () => {
    const backend = chatBackend();
    backend.state.pageSize = 1;
    backend.state.messages.push(
      threadMessage("old-root", "A", "2024-01-01T00:00:00Z"),
      threadMessage("older-reply", "A", "2024-01-02T01:00:00Z", true),
      threadMessage("zero-replies", "B", "2024-01-02T02:00:00Z"),
      threadMessage("latest-reply", "A", "2024-01-02T03:00:00Z", true),
      {...threadMessage("private", "P", "2024-01-02T04:00:00Z"), privateMessageViewer: {name: "users/1"}},
      threadMessage("too-new", "C", "2024-01-03T00:00:00Z"),
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    using cursor = await space.listThreads({
      since: new Date("2024-01-02T00:00:00Z"), before: new Date("2024-01-03T00:00:00Z"),
    });
    await chat.failNextObservation("List Google Chat threads");
    await expect(Promise.resolve(cursor.next())).rejects.toThrow(/denied by the test/);
    const results: Array<[string, string]> = [];
    for (let i = 0; i < 10; i++) {
      using page = await cursor.next();
      if (page === null) break;
      for (const entry of page) results.push([entry.info.id, entry.info.latestMessage.text]);
    }
    expect(results).toEqual([[threadName("A"), "latest-reply"], [threadName("B"), "zero-replies"]]);
    expect(await cursor.next()).toBeNull();
    expect(backend.state.lists[0].searchParams.get("pageToken")).toBeNull();
    expect(backend.state.lists[2].searchParams.get("pageToken")).toBeNull();
  });

  it("keeps delegated threads alive after discovery is disposed, without parent or sibling access", async () => {
    const backend = chatBackend();
    backend.state.messages.push(
      threadMessage("root", "A", "2024-01-01T00:00:00Z"),
      threadMessage("reply", "A", "2024-01-02T00:00:00Z", true),
      threadMessage("unrelated", "B", "2024-01-03T00:00:00Z"),
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    using cursor = await space.listThreads();
    using entries = await cursor.next();
    using thread = entries!.find(entry => entry.info.id === threadName("A"))!.thread.dup();
    await expect(Promise.resolve(Reflect.get(thread, "searchMessages")({text: "unrelated"})))
      .rejects.toThrow(/does not implement the method "searchMessages"/);
    entries![Symbol.dispose]();
    cursor[Symbol.dispose]();
    space[Symbol.dispose]();

    using root = (await thread.getRootMessage())!.message;
    expect((await root!.getMetadata()).text).toBe("root");
    using history = await thread.listMessages({
      since: new Date("2024-01-02T00:00:00Z"), threadName: threadName("B"),
    } as ChatListMessagesOptions);
    using messages = await history.next();
    expect(messages!.map(entry => entry.info.text)).toEqual(["reply"]);
    expect(backend.state.lists.at(-1)!.searchParams.get("filter")).toContain(`thread.name = ${threadName("A")}`);
    await expect(Promise.resolve(Reflect.get(thread, "getSpace")())).rejects.toThrow();
    await expect(Promise.resolve(Reflect.get(root!, "space")())).rejects.toThrow();
    await expect(Promise.resolve(Reflect.get(root!, "getThread")())).rejects.toThrow();
    using response = (await thread.post("acknowledged")).message;
    expect((await response.getMetadata()).threadId).toBe(threadName("A"));
    expect(backend.state.creates).toEqual([]);
    await chat.applyAction(1);
    expect(backend.state.creates[0]).toMatchObject({
      replyOption: "REPLY_MESSAGE_OR_FAIL", body: {text: "acknowledged", thread: {name: threadName("A")}},
    });
  });

  it.each(["root", "history", "post", "reply"])(
    "retains thread scope through %s messages, reactions, replies, and attachments", async source => {
    const backend = chatBackend();
    backend.state.pageSize = 1;
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using thread = (await space.getThread(threadName("A"))).thread;
    using root = (await thread.getRootMessage())!.message;
    using history = await thread.listMessages();
    using page = await history.next();
    using message = source === "root" ? root.dup() : source === "history" ? page![0].message.dup()
      : source === "post" ? (await thread.post("new message")).message
      : (await root.reply("new message")).message;
    if (source === "post" || source === "reply") await chat.applyAction(1);
    const id = (await message.getMetadata()).id;
    const raw = backend.state.messages.find(item => item.name === id)!;
    const attachmentId = `${id}/attachments/file`;
    raw.attachment = [{name: attachmentId, contentName: "notes.txt", source: "UPLOADED_CONTENT",
      contentType: "text/plain", attachmentDataRef: {resourceName: "media/notes"}}];
    backend.state.reactions.push(
      {name: `${id}/reactions/one`, emoji: {unicode: "👍"}, user: {name: "users/subject-a"}},
      {name: `${id}/reactions/two`, emoji: {unicode: "🎉"}, user: {name: "users/other"}},
    );
    await expect(Promise.resolve(message.getAttachment(`${id}/attachments/other`)))
      .rejects.toThrow(/no such attachment/);
    using attachment = await message.getAttachment(attachmentId);
    expect((await attachment.getMetadata()).filename).toBe("notes.txt");
    expect(new TextDecoder().decode(await attachment.getContent())).toBe("attachment bytes");
    using reactions = await message.listReactions();
    using firstReactions = await reactions.next();
    expect(firstReactions![0].emoji).toBe("👍");
    const submissions = (await chat.readQueue()).submissions.length;

    // A later lookup now describes the same ID in a sibling thread. The original thread grant
    // must fail closed on every descendant surface, even though the space grant still permits it.
    raw.thread = {name: threadName("B")};
    const scopeError = /only covers one Google Chat thread/;
    await expect(Promise.resolve(message.getMetadata())).rejects.toThrow(scopeError);
    await expect(Promise.resolve(message.edit("outside"))).rejects.toThrow(scopeError);
    await expect(Promise.resolve(message.reply("outside"))).rejects.toThrow(scopeError);
    await expect(Promise.resolve(message.addReaction("🎉"))).rejects.toThrow(scopeError);
    await expect(Promise.resolve(message.removeReaction("👍"))).rejects.toThrow(scopeError);
    await expect(Promise.resolve(message.getAttachment(attachmentId))).rejects.toThrow(scopeError);
    await expect(Promise.resolve(reactions.next())).rejects.toThrow(scopeError);
    await expect(Promise.resolve(attachment.getMetadata())).rejects.toThrow(scopeError);
    await expect(Promise.resolve(attachment.getContent())).rejects.toThrow(scopeError);
    expect(backend.state.downloads).toHaveLength(1);
    expect((await chat.readQueue()).submissions).toHaveLength(submissions);
    expect(backend.state.edits).toEqual([]);
    expect(backend.state.reactionWrites).toEqual([]);
    using broad = (await space.getMessage(id)).message;
    expect((await broad.getMetadata()).threadId).toBe(threadName("B"));
    delete raw.thread;
    await expect(Promise.resolve(message.getMetadata())).rejects.toThrow(scopeError);
  });

  it("checks thread ownership and never substitutes a surviving reply for the root", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("reply", "A", "2024-01-02T00:00:00Z", true));
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.getThread("spaces/OTHER/threads/A")))
      .rejects.toThrow(/only covers one/);
    expect(backend.state.lists).toEqual([]);
    using thread = (await space.getThread(threadName("A"))).thread;
    expect(await thread.getRootMessage()).toBeNull();
    await expect(Promise.resolve(space.getThread(threadName("missing"))))
      .rejects.toThrow(/not available/);
  });

  it.each([
    ["DIRECT_MESSAGE", "THREADED_MESSAGES"],
    ["GROUP_CHAT", "THREADED_MESSAGES"],
    ["SPACE", "UNTHREADED_MESSAGES"],
  ])("does not invent writable threads in %s / %s", async (spaceType, spaceThreadingState) => {
    const backend = chatBackend();
    Object.assign(backend.state, {spaceType, spaceThreadingState});
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.listThreads())).rejects.toThrow(/does not support/);
    expect(backend.state.lists).toEqual([]);
    await expect(Promise.resolve(space.getThread(threadName("A")))).rejects.toThrow(/does not support/);
    await expect(Promise.resolve(space.startThread("new topic"))).rejects.toThrow(/does not support/);
    using message = (await space.getMessage(messageName("root"))).message;
    await expect(Promise.resolve(message.reply("hello"))).rejects.toThrow(/does not support/);
    expect((await chat.readQueue()).submissions).toEqual([]);
  });

  it("starts a thread ready for posting and keeps its capabilities valid through approval", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    const started = await space.startThread("new topic");
    using thread = started.thread;
    const expected = {
      id: "pending:thread:1", spaceId: SPACE_NAME,
      rootMessage: {text: "new topic"}, latestMessage: {text: "new topic"},
    };
    expect(started.info).toMatchObject(expected);
    expect(await thread.getMetadata()).toMatchObject(expected);
    using root = (await thread.getRootMessage())!.message;
    const rootInfo = await root.getMetadata();
    expect(rootInfo.threadId).toBe("pending:thread:1");
    using response = (await thread.post("first reply")).message;
    using _second = (await root.reply("second reply")).message;
    expect(await thread.getMetadata()).toMatchObject({
      rootMessage: {text: "new topic"}, latestMessage: {text: "second reply"},
    });
    using before = await thread.listMessages();
    using beforePage = await before.next();
    expect(beforePage!.map(entry => entry.info.text)).toEqual(["new topic", "first reply", "second reply"]);
    await expect(chat.applyAction(2)).rejects.toThrow(/root message before/);
    expect(backend.state.creates).toEqual([]);

    await chat.applyAction(1);
    using during = await thread.listMessages();
    expect(await thread.getMetadata()).toMatchObject({
      id: threadName("T1"), rootMessage: {id: messageName("M1")},
    });
    using duringPage = await during.next();
    expect(duringPage!.map(entry => entry.info.text)).toEqual(["new topic", "first reply", "second reply"]);
    await chat.applyAction(2);
    await chat.applyAction(3);
    using after = await thread.listMessages();
    using afterPage = await after.next();
    expect(afterPage!.map(entry => entry.info.text)).toEqual(["new topic", "first reply", "second reply"]);
    expect(afterPage!.every(entry => entry.info.threadId === threadName("T1"))).toBe(true);
    expect((await root.getMetadata()).id).toBe(messageName("M1"));
    expect((await response.getMetadata()).id).toBe(messageName("M2"));
  });

  it("does not advance pending-thread discovery on denial or retain a rejected root", async () => {
    const chat = chatHarness(chatBackend());
    using space = await chat.session();
    using root = (await space.post("new topic")).message;
    using thread = (await space.getThread((await root.getMetadata()).threadId!)).thread;
    using cursor = await space.listThreads();
    await chat.failNextObservation("List Google Chat threads");
    await expect(Promise.resolve(cursor.next())).rejects.toThrow(/denied by the test/);
    using page = await cursor.next();
    expect(page!.map(entry => entry.info.latestMessage.text)).toEqual(["new topic"]);
    await chat.rejectAction(1);
    await expect(Promise.resolve(thread.getRootMessage())).rejects.toThrow(/never created/);
    using retry = await space.listThreads();
    expect(await retry.next()).toBeNull();
  });

  it("reopens a temporary thread name after the root is committed and the worker restarts", async () => {
    const chat = chatHarness(chatBackend());
    let name: string;
    {
      using space = await chat.session();
      const posted = await space.post("persistent topic");
      using root = posted.message;
      name = posted.info.threadId!;
      await expect(Promise.resolve(root.getAttachment("x"))).rejects.toThrow(/not been committed/);
      await chat.applyAction(1);
    }
    await chat.restart();
    using space = await chat.session();
    using thread = (await space.getThread(name)).thread;
    using root = (await thread.getRootMessage())!.message;
    expect((await root!.getMetadata()).text).toBe("persistent topic");
    using reply = (await thread.post("after restart")).message;
    expect((await reply.getMetadata()).threadId).toBe(threadName("T1"));
  });
});
