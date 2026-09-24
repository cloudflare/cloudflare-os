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
import type {ChatMessageRaw} from "../../src/chat-api";
import type {TestHooks as TestHooksImpl} from "./worker";

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
    spaceThreadingState: "THREADED_MESSAGES",
    messages: [] as ChatMessageRaw[],
    pageSize: 50,
    lists: [] as URL[],
    deletes: [] as string[],
    edits: [] as Array<{name: string; text: string}>,
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
    if (url.pathname === `/v1/spaces/${SPACE_ID}`) {
      return json({name: SPACE_NAME, displayName: "Project",
        spaceType: state.spaceType, spaceThreadingState: state.spaceThreadingState});
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
      return json(created);
    }
    const name = url.pathname.slice("/v1/".length);
    const index = state.messages.findIndex(message => message.name === name);
    if (index !== -1) {
      if (method === "GET") return json(state.messages[index]);
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
    userInfo: () => {sub: string; name?: string} = () => ({sub: "subject-a", name: "Ada"}),
) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
      return json(userInfo());
    }
    return backend.fetch(url, init);
  });
  const name = `chat-test-${crypto.randomUUID()}`;
  let hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GoogleChatGatekeeperImpl.idFromName(name).toString();
  const facetName = `chat-${name}`;
  const props: GoogleChatGatekeeperImplProps = {
    userObjectId: testEnv.UserAccount.idFromName(name).toString(),
    spaceId: SPACE_ID,
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
  return {
    session: () => ready.then(() => hook.openChatSession(facetName, id, props, queueId)),
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
    failNextObservation: (title: string): Promise<void> => ready.then(() =>
      runHook(hook, instance => instance.failNextObservation(queueId, title))),
    readQueue: () => ready.then(() =>
      runHook(hook, instance => instance.readQueue(queueId))),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Chat gatekeeper behaviors", () => {
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
    using message = await space.post("Working...");
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
    using message = await space.post("Working...");
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

  it("refuses an edit whose prerequisite post was rejected", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = await space.post("Working...");
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
      using message = await space.post("Working...");
      await message.edit("Done.");
      id = (await message.getMetadata()).id;
      await chat.applyAction(1);
    }
    await chat.restart();
    using space = await chat.session();
    using message = await space.getMessage(id);
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
});

const threadName = (id: string) => `${SPACE_NAME}/threads/${id}`;
const messageName = (id: string) => `${SPACE_NAME}/messages/${id}`;

function threadMessage(id: string, thread: string, createTime: string, reply = false): ChatMessageRaw {
  return {name: messageName(id), text: id, thread: {name: threadName(thread)},
    createTime, threadReply: reply};
}

describe("Google Chat thread capabilities", () => {
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
    entries![Symbol.dispose]();
    cursor[Symbol.dispose]();
    space[Symbol.dispose]();

    using root = await thread.getRootMessage();
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
    using response = await thread.post("acknowledged");
    expect((await response.getMetadata()).threadId).toBe(threadName("A"));
    expect(backend.state.creates).toEqual([]);
    await chat.applyAction(1);
    expect(backend.state.creates[0]).toMatchObject({
      replyOption: "REPLY_MESSAGE_OR_FAIL", body: {text: "acknowledged", thread: {name: threadName("A")}},
    });
  });

  it("checks thread ownership and never substitutes a surviving reply for the root", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("reply", "A", "2024-01-02T00:00:00Z", true));
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.getThread("spaces/OTHER/threads/A")))
      .rejects.toThrow(/only covers one/);
    expect(backend.state.lists).toEqual([]);
    using thread = await space.getThread(threadName("A"));
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
    using cursor = await space.listThreads();
    expect(await cursor.next()).toBeNull();
    expect(backend.state.lists).toEqual([]);
    await expect(Promise.resolve(space.getThread(threadName("A")))).rejects.toThrow(/does not support/);
    await expect(Promise.resolve(space.startThread("new topic"))).rejects.toThrow(/does not support/);
    using message = await space.getMessage(messageName("root"));
    await expect(Promise.resolve(message.reply("hello"))).rejects.toThrow(/does not support/);
    expect((await chat.readQueue()).submissions).toEqual([]);
  });

  it("starts a thread ready for posting and keeps its capabilities valid through approval", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using thread = await space.startThread("new topic");
    using root = (await thread.getRootMessage())!;
    const rootInfo = await root.getMetadata();
    expect(rootInfo.threadId).toBe("pending:thread:1");
    using response = await thread.post("first reply");
    using _second = await root.reply("second reply");
    using before = await thread.listMessages();
    using beforePage = await before.next();
    expect(beforePage!.map(entry => entry.info.text)).toEqual(["new topic", "first reply", "second reply"]);
    await expect(chat.applyAction(2)).rejects.toThrow(/root message before/);
    expect(backend.state.creates).toEqual([]);

    await chat.applyAction(1);
    using during = await thread.listMessages();
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
    using root = await space.post("new topic");
    using thread = await space.getThread((await root.getMetadata()).threadId!);
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
      using root = await space.post("persistent topic");
      name = (await root.getMetadata()).threadId!;
      using attachments = await root.listAttachments();
      expect(attachments).toEqual([]);
      await chat.applyAction(1);
    }
    await chat.restart();
    using space = await chat.session();
    using thread = await space.getThread(name);
    using root = await thread.getRootMessage();
    expect((await root!.getMetadata()).text).toBe("persistent topic");
    using reply = await thread.post("after restart");
    expect((await reply.getMetadata()).threadId).toBe(threadName("T1"));
  });
});
