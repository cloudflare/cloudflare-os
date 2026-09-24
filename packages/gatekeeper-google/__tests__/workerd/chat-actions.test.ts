// Behavior tests for the Google Chat gatekeeper Durable Object, deliberately few: each pins one
// property that only exists in the DO glue — the Node suites already cover the pure overlay and
// API-mapping logic, and CursorPager has its own tests. What cannot be seen from there is what
// actually leaves for Google and when, and what a real session does across the pager, the store,
// and the approval queue together.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {GoogleChatGatekeeperImpl, GoogleChatGatekeeperImplProps} from "../../src/chat";
import type {GoogleChatMessageInfo} from "../../src/chat-types";

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
  failNextObservation(queueId: string, title: string): void;
  readQueue(queueId: string): Promise<{
    submissions: Array<{actionId: number; description: unknown}>;
    observations: unknown[];
  }>;
};

const testEnv = env as unknown as {
  GoogleChatGatekeeperImpl: DurableObjectNamespace<GoogleChatGatekeeperImpl>;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace;
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
 * The smallest fake of Google Chat these behaviors need: space metadata, a one-page message list,
 * message create and delete. Writes are recorded so the tests can assert exactly what left the
 * gatekeeper and when.
 */
function chatBackend() {
  const state = {
    messages: [] as Array<Record<string, unknown>>,
    deletes: [] as string[],
    /** Message names Chat would refuse to delete without force: they have threaded replies. */
    repliesOn: new Set<string>(),
    creates: [] as Array<{
      requestId: string | null;
      body: {text: string};
    }>,
  };
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname === `/v1/spaces/${SPACE_ID}`) {
      return json({name: SPACE_NAME, displayName: "Project", spaceType: "SPACE"});
    }
    if (url.pathname === `/v1/spaces/${SPACE_ID}/messages`) {
      if (method === "GET") return json({messages: state.messages});
      const body = JSON.parse(init.body as string) as {text: string};
      state.creates.push({requestId: url.searchParams.get("requestId"), body});
      const created = {
        name: `${SPACE_NAME}/messages/M${state.creates.length}`,
        text: body.text,
        createTime: new Date().toISOString(),
        sender: {name: "users/subject-a", type: "HUMAN"},
      };
      state.messages.push(created);
      return json(created);
    }
    const name = url.pathname.slice("/v1/".length);
    const index = state.messages.findIndex(message => message.name === name);
    if (index !== -1) {
      if (method === "GET") return json(state.messages[index]);
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
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
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
    call: (operation: string, args: unknown[] = []): Promise<unknown> => ready.then(() =>
      runHook(hook, instance =>
        instance.runChatOperation(facetName, id, props, queueId, operation, args))),
    applyAction: (actionId: number): Promise<void> => ready.then(() =>
      runHook(hook, instance => instance.chatApplyAction(facetName, id, props, actionId))),
    revertAction: (actionId: number) => ready.then(() =>
      runHook(hook, instance => instance.chatRevertAction(facetName, id, props, actionId))),
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

    const info = await chat.call("space.sendMessage", ["hello"]) as GoogleChatMessageInfo;
    expect(info).toMatchObject({name: "pending:send:1", pending: true, text: "hello"});

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
    await chat.call("space.sendMessage", ["hello"]);
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
    await chat.call("space.sendMessage", ["queued hello"]);

    await chat.failNextObservation("Read Google Chat messages");
    const {firstError, page} = await chat.call(
      "space.listMessagesRetry", [{order: "newestFirst"}]) as {
      firstError: string;
      page: GoogleChatMessageInfo[] | null;
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
});
