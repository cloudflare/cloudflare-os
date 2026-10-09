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

/** A joined membership of SPACE_NAME, the conversation every lookup and setup answers with. */
const joined = (id: string) => ({
  name: `${SPACE_NAME}/members/${id}`, state: "JOINED", member: {name: `users/${id}`, type: "HUMAN"},
});

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
    /** Fail member lists with this status until cleared. */
    membersFailure: 0,
    /** Whose token Chat refuses the member list to, as a space restricted to managers would. */
    membersRejectedToken: undefined as string | undefined,
    /** How Chat stores submitted text, such as rendering `<users/…>` mentions as `@Name`. */
    storeText: (text: string) => text,
    /** People API profile names by numeric user id. */
    profiles: {} as Record<string, string>,
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
    /**
     * Fail creates with this status until cleared: a 4xx refuses before posting, and a 5xx posts
     * but loses the response, as the retry layer sees an unrecoverable outage.
     */
    createFailure: 0,
    /** With a 5xx `createFailure`, post nothing, as a request that timed out before Google acted on it. */
    createsPostNothing: false,
    /** Message names by the custom name a create gave them. */
    namedMessages: new Map<string, string>(),
    /** Apply edits but lose their responses with this status until cleared. */
    editFailure: 0,
    /** Apply reaction writes but lose their responses with this status until cleared. */
    reactionFailure: 0,
    /** Post replies as new top-level threads, as Google would by ignoring the reply option. */
    misplaceReplies: false,
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
    /** Profiles in the organization's directory, matched by email or name prefix. */
    directory: [] as Array<{id: string; name: string; email: string}>,
    /** External shared contacts, which only a directory search for domain contacts returns. */
    externalContacts: [] as Array<{id: string; name: string; email: string}>,
    /** Group chats findGroupChats returns, a page at a time; each has `members` unless in `otherMembers`. */
    groupChats: [] as string[],
    /** The memberships of a group chat other than the one every send posts in, by its name. */
    otherMembers: new Map<string, ChatMembershipRaw[]>(),
    /** Each new conversation spaces.setup created: as with messages, it is always this space. */
    setups: [] as Array<{requestId: string; spaceType: string; members: string[]}>,
    /** People spaces.setup leaves out of a new group chat, as when one of them blocks the caller. */
    setupOmits: [] as string[],
    /** Create setup conversations but lose their responses with this status until cleared. */
    setupFailure: 0,
  };
  /** A page of `items` no longer than asked for, nor than `state.pageSize`, as Google may return. */
  const pageOf = <T>(items: T[], url: URL) => {
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const end = start + Math.min(Number(url.searchParams.get("pageSize")), state.pageSize);
    return {items: items.slice(start, end), ...(end < items.length ? {nextPageToken: String(end)} : {})};
  };
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.hostname === "people.googleapis.com" && url.pathname === "/v1/people:searchDirectoryPeople") {
      const query = url.searchParams.get("query")!.toLowerCase();
      const sources = url.searchParams.getAll("sources");
      const people = [
        ...state.directory,
        ...(sources.includes("DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT") ? state.externalContacts : []),
      ].filter(person => person.email.startsWith(query) ||
        person.name.toLowerCase().split(" ").some(word => word.startsWith(query)));
      const {items, ...next} = pageOf(people, url);
      return json({
        people: items.map(person => ({
          resourceName: `people/${person.id}`,
          names: [{displayName: person.name, metadata: {primary: true}}],
          emailAddresses: [{value: person.email, metadata: {primary: true}}],
        })),
        ...next,
      });
    }
    if (url.hostname === "people.googleapis.com") {
      return json({responses: url.searchParams.getAll("resourceNames").map(requestedResourceName => {
        const name = state.profiles[requestedResourceName.slice("people/".length)];
        return name
          ? {requestedResourceName, person: {names: [{displayName: name, metadata: {primary: true}}]}}
          : {requestedResourceName, httpStatusCode: 404};
      })});
    }
    if (state.rejectedToken && url.hostname === "chat.googleapis.com" &&
        new Headers(init.headers).get("Authorization") === `Bearer ${state.rejectedToken}`) return json({}, 403);
    if (url.pathname.startsWith("/v1/media/")) {
      state.downloads.push(url.pathname);
      return new Response("attachment bytes");
    }
    const space = {name: SPACE_NAME, displayName: state.spaceName,
      spaceType: state.spaceType, spaceThreadingState: state.spaceThreadingState};
    if (url.pathname === "/v1/spaces") { state.spaceLists++; return json({spaces: [space]}); }
    if (url.pathname === "/v1/spaces:findDirectMessage") {
      return url.searchParams.get("name") === "users/alice@example.com" ? json(space) : json({}, 404);
    }
    if (url.pathname === "/v1/spaces:findGroupChats") {
      const {items, ...next} = pageOf(state.groupChats, url);
      return json({spaces: items.map(name => ({...space, name})), ...next});
    }
    if (url.pathname === "/v1/spaces:setup" && method === "POST") {
      const body = JSON.parse(init.body as string) as {
        requestId: string; space: {spaceType: string}; memberships: Array<{member: {name: string}}>;
      };
      // A replayed request returns the conversation the first one created.
      if (!state.setups.some(setup => setup.requestId === body.requestId)) {
        const members = body.memberships.map(membership => membership.member.name);
        state.setups.push({requestId: body.requestId, spaceType: body.space.spaceType, members});
        Object.assign(state, {spaceType: body.space.spaceType, spaceName: ""});
        state.members = ["users/subject-a", ...members.filter(member => !state.setupOmits.includes(member))]
          .map(member => joined(member.slice("users/".length)));
      }
      if (state.setupFailure) return json({}, state.setupFailure);
      return json({...space, spaceType: state.spaceType, displayName: undefined});
    }
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
    const membersOf = /^\/v1\/(spaces\/[^/]+)\/members$/.exec(url.pathname)?.[1];
    if (membersOf) {
      state.memberRequests++;
      const rejected = new Headers(init.headers).get("Authorization") === `Bearer ${state.membersRejectedToken}`;
      if (state.membersFailure || rejected) return json({}, state.membersFailure || 403);
      const {items, ...next} = pageOf(state.otherMembers.get(membersOf) ?? state.members, url);
      return json({memberships: items, ...next});
    }
    if (url.pathname.startsWith(`/v1/spaces/${SPACE_ID}/members/`)) {
      // A person's email address stands in for their user ID.
      const member = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const id = state.directory.find(person => person.email === member)?.id ?? member;
      const membership = state.members.find(item => item.name === `${SPACE_NAME}/members/${id}`);
      return membership ? json(membership) : json({}, 404);
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
      const refused = state.createFailure >= 400 && state.createFailure < 500;
      if (refused || (state.createFailure && state.createsPostNothing)) return json({}, state.createFailure);
      if (prior) {
        if (state.createFailure) return json({}, state.createFailure);
        // Google echoes the request with its assigned names, not the stored message.
        return json({name: prior, text: body.text, thread: state.messages.find(message => message.name === prior)?.thread});
      }
      if (body.thread && !state.messages.some(message => message.thread?.name === body.thread!.name)) {
        return json({}, 404);
      }
      state.creates.push({requestId: url.searchParams.get("requestId"),
        replyOption: url.searchParams.get("messageReplyOption"), body});
      const thread = state.misplaceReplies ? undefined : body.thread;
      const created = {
        name: `${SPACE_NAME}/messages/M${state.creates.length}`,
        text: state.storeText(body.text),
        createTime: new Date().toISOString(),
        sender: {name: "users/subject-a", type: "HUMAN"},
        thread: thread ?? {name: `${SPACE_NAME}/threads/T${state.creates.length}`},
        threadReply: thread !== undefined,
      };
      state.messages.push(created);
      state.sentRequests.set(requestId, created.name);
      const messageId = url.searchParams.get("messageId");
      if (messageId) state.namedMessages.set(`${SPACE_NAME}/messages/${messageId}`, created.name);
      if (state.createFailure) return json({}, state.createFailure);
      return json(state.echoCreates ? {name: created.name, text: body.text} : created);
    }
    const path = url.pathname.slice("/v1/".length);
    const name = state.namedMessages.get(path) ?? path;
    const reactionParent = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions$/.exec(name)?.[1];
    if (reactionParent) {
      if (!state.messages.some(message => message.name === reactionParent)) return json({}, 404);
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
        return state.reactionFailure ? json({}, state.reactionFailure) : json(reaction);
      }
    }
    const reactionIndex = state.reactions.findIndex(reaction => reaction.name === name);
    if (reactionIndex !== -1 && method === "DELETE") {
      state.reactions.splice(reactionIndex, 1);
      state.reactionWrites.push({method, id: name});
      return state.reactionFailure ? json({}, state.reactionFailure) : json({});
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
        state.messages[index].text = state.storeText(text);
        state.messages[index].lastUpdateTime = new Date().toISOString();
        if (state.editFailure) return json({}, state.editFailure);
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
    binding: "account" | "space" | "thread" = "space",
) {
  // Plain flags rather than promises: the stub runs inside the gatekeeper DO, and a promise made
  // in the test context cannot be awaited there.
  const gate = {
    match: undefined as ((url: URL, method: string) => boolean) | undefined,
    reached: false,
    released: false,
  };
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (gate.match?.(url, (init.method ?? "GET").toUpperCase())) {
      gate.match = undefined;
      gate.reached = true;
      while (!gate.released) await tick();
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
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
    ...(binding === "account" ? {} : {spaceId: SPACE_ID}),
    ...(binding === "thread" ? {threadId: "A"} : {}),
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
    thread: () => ready.then(() => hook.openChatThreadSession(facetName, id, props, queueId)),
    describe: () => ready.then(() => hook.chatDescribe(facetName, id, props)),
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
    /** Hold the next matching request; resolves once it is reached, returning its release. */
    holdNextRequest: async (match: (url: URL, method: string) => boolean): Promise<() => void> => {
      gate.match = match;
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
    const chat = chatHarness(backend, undefined, "account");
    using account = await chat.account();
    using cursor = await account.listSpaces();
    await chat.failNextObservation("List Google Chat conversations");
    await expect(Promise.resolve(cursor.next())).rejects.toThrow(/denied by the test/);
    using page = await cursor.next();
    expect(page![0].info).toMatchObject({id: SPACE_NAME, type: "directMessage"});
    expect(page![0].info.name).toBeUndefined();
    expect(backend.state.memberRequests).toBe(0);
    expect(await page![0].space.getMetadata()).toMatchObject(
      {name: "Alice Smith", peer: {id: "users/123", name: "Alice Smith", type: "human"}});
    expect(backend.state.memberRequests).toBe(1);
  });

  it("browses named conversations by name only, reaching a DM by email without participant lookups", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    using _session = await chat.session();
    const picker = new ChatSpaceConfiguratorUI(async () => ({token: "access-token", expires: new Date(Date.now() + 60_000)}));
    expect(await picker.listChatSpaces("")).toEqual([]);
    expect(await picker.listChatSpaces(" alice@example.com ")).toEqual([
      {value: SPACE_ID, title: "alice@example.com", subtitle: "Direct message"},
    ]);
    expect(await picker.listChatSpaces("bob@example.com")).toEqual([]);
    expect(backend.state.memberRequests).toBe(0);
    Object.assign(backend.state, {spaceType: "SPACE", spaceName: "Project review"});
    const project = {value: SPACE_ID, title: "Project review", subtitle: "Space"};
    expect(await picker.listChatSpaces("")).toEqual([project]);
    expect(await picker.listChatSpaces("review")).toEqual([project]);
    expect(await picker.listChatSpaces(SPACE_ID.toLowerCase())).toEqual([]);
  });

  it("opens an exact conversation reference without scanning the picker listing", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    using _session = await chat.session();
    const picker = new ChatSpaceConfiguratorUI(async () => ({token: "access-token", expires: new Date(Date.now() + 60_000)}));
    expect(await picker.listChatSpaces(SPACE_NAME)).toEqual([
      {value: SPACE_ID, title: "Direct message", subtitle: "Direct message"},
    ]);
    expect(await picker.listChatSpaces(`https://chat.google.com/dm/${SPACE_ID}`)).toHaveLength(1);
    expect(backend.state.spaceLists).toBe(0);
  });

  it("titles a DM connection after its peer, falling back when members are unavailable", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    expect(await chat.describe()).toMatchObject({title: "Alice Smith"});
    backend.state.membersFailure = 403;
    expect(await chat.describe()).toMatchObject({title: "Google Chat direct message"});
    using space = await chat.session();
    using _posted = (await space.post("hi")).message;
    expect((await chat.readQueue()).submissions[0].description)
      .toMatchObject({title: `Send a Google Chat message to ${SPACE_NAME}`});
  });

  it("admits an observer only when their own account can open the conversation", async () => {
    const backend = directMessage();
    const chat = chatHarness(backend);
    backend.state.rejectedToken = "observer-token";
    await expect(chat.addObserver()).rejects.toThrow(/cannot access the Google Chat conversation/);
    backend.state.rejectedToken = undefined;
    await chat.addObserver();
    using space = await chat.session();
    expect(await space.getMetadata()).toMatchObject(
      {name: "Alice Smith", peer: {id: "users/123", name: "Alice Smith", type: "human"}});
  });

  it("admits a space observer only if their account can list its members; a thread needs no list", async () => {
    const backend = chatBackend();
    backend.state.membersRejectedToken = "observer-token";
    await expect(chatHarness(backend).addObserver()).rejects.toThrow(/cannot access .* or its members/);
    await chatHarness(backend, undefined, "thread").addObserver();
  });

  it("names a peer Chat leaves unnamed from People, including in send approvals", async () => {
    const backend = directMessage();
    backend.state.members[1] = {name: `${SPACE_NAME}/members/123`, member: {name: "users/123", type: "HUMAN"}};
    backend.state.profiles["123"] = "Alice Smith";
    const chat = chatHarness(backend);
    using space = await chat.session();
    expect(await space.getMetadata()).toMatchObject(
      {name: "Alice Smith", peer: {id: "users/123", name: "Alice Smith", type: "human"}});
    using _posted = (await space.post("hi")).message;
    const [send] = (await chat.readQueue()).submissions;
    expect(send.description).toMatchObject({
      title: "Send a Google Chat message to Alice Smith",
      description: expect.stringContaining(`a direct message with Alice Smith (${SPACE_NAME})`),
    });
  });

  it("names an unnamed group chat after its members in metadata, approvals and the connection title", async () => {
    const backend = directMessage();
    backend.state.spaceType = "GROUP_CHAT";
    backend.state.members.push({name: `${SPACE_NAME}/members/456`, member: {name: "users/456", type: "HUMAN"}});
    backend.state.profiles["456"] = "Bob";
    const chat = chatHarness(backend);
    expect(await chat.describe()).toMatchObject({title: "Alice Smith and Bob"});
    using space = await chat.session();
    expect(await space.getMetadata()).toEqual(expect.objectContaining({name: "Alice Smith and Bob"}));
    expect((await space.getMetadata()).peer).toBeUndefined();
    using _posted = (await space.post("hi")).message;
    expect((await chat.readQueue()).submissions[0].description)
      .toMatchObject({title: "Send a Google Chat message to Alice Smith and Bob"});
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
    using messages = await space.listMessages({order: "oldestFirst"});
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
    expect(memberPage![0]).toMatchObject({kind: "user", user: expected});
    expect(await space.findMember("users/123")).toMatchObject({kind: "user", user: expected});
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
    using root = (await space.post("root")).message;
    using thread = (await root.getThread()).thread;
    using _reply = (await thread.post("reply")).message;
    // Google may answer a create with only the submitted fields plus the assigned name.
    backend.state.echoCreates = true;
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.creates).toHaveLength(2);
    expect(backend.state.creates[1].body.thread?.name).toBe(threadName("T1"));
  });

  // The overseer checks "still pending" before calling either method, so a reject can land while
  // the create is in flight. It must be refused: the write already left for Google.
  it("refuses to reject an action while its write is in flight", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    await chat.call("space.post", ["hello"]);
    const held = chat.holdNextRequest((url, method) =>
      method === "POST" && url.pathname === `/v1/${SPACE_NAME}/messages`);
    const applying = chat.applyAction(1);
    const release = await held;
    await expect(chat.rejectAction(1)).rejects.toThrow(/being applied/);
    release();
    await applying;
    expect(backend.state.creates).toHaveLength(1);
    await chat.revertAction(1);
    expect(backend.state.messages).toEqual([]);
  });

  it("shows the approver the exact message text", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    const text = "Standup at 3pm <!-- hidden -->\n\n  indented";
    using _posted = (await space.post(text)).message;
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit(text);
    const [send, edit] = (await chat.readQueue()).submissions.map(entry => entry.description);
    expect(send).toMatchObject({
      fields: [{label: "Message", kind: "text", value: text}], descriptionIsComplete: true,
    });
    expect(edit).toMatchObject({fields: [
      {label: "Current", kind: "text", value: "root"},
      {label: "New", kind: "text", value: text},
    ]});
  });

  it("applies queued reactions in submission order and undoes them", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.addReaction("👍");
    await message.removeReaction("👍");
    await expect(chat.applyAction(2)).rejects.toThrow(/earlier queued change/);
    await chat.applyAction(1);
    await chat.applyAction(2);
    await chat.revertAction(2);
    expect(backend.state.reactionWrites.map(write => write.method)).toEqual(["POST", "DELETE", "POST"]);
    // An add whose reaction was already there before it was tried writes nothing, so undoes nothing.
    await message.addReaction("👍");
    await chat.applyAction(3);
    await chat.revertAction(3);
    expect(backend.state.reactionWrites).toHaveLength(3);
    expect(backend.state.reactions.map(reaction => reaction.emoji?.unicode)).toEqual(["👍"]);
  });

  it("undoes reactions whose writes landed but lost their responses", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    const applyLosingResponse = async (id: number) => {
      backend.state.reactionFailure = 503;
      await expect(chat.applyAction(id)).rejects.toThrow(/http=503/);
      backend.state.reactionFailure = 0;
      await chat.applyAction(id);
    };
    const reactions = () => backend.state.reactions.map(reaction => reaction.emoji?.unicode);
    await message.addReaction("👍");
    await applyLosingResponse(1);
    await chat.revertAction(1);
    expect(reactions()).toEqual([]);
    await message.addReaction("👍");
    await chat.applyAction(2);
    await message.removeReaction("👍");
    await applyLosingResponse(3);
    await chat.revertAction(3);
    expect(reactions()).toEqual(["👍"]);
  });

  it("refuses observers on a whole-account binding and checks them on a thread binding", async () => {
    await expect(chatHarness(chatBackend(), undefined, "account").addObserver())
      .rejects.toThrow(/cannot be shared/);
    const backend = chatBackend();
    const chat = chatHarness(backend, undefined, "thread");
    backend.state.rejectedToken = "observer-token";
    await expect(chat.addObserver()).rejects.toThrow(/cannot access the Google Chat conversation/);
    backend.state.rejectedToken = undefined;
    await chat.addObserver();
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
    await expect(chat.revertAction(1)).resolves.toBeUndefined();
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
    using root = (await space.post("root")).message;
    using thread = (await root.getThread()).thread;
    using reply = (await thread.post("reply")).message;
    await chat.rejectAction(1);
    await expect(Promise.resolve(reply.getMetadata())).rejects.toThrow(/first message was rejected/);
    await chat.restart();
    expect(await chat.call("space.listMessages", [{}])).toEqual([]);
    await expect(chat.applyAction(2)).rejects.toThrow(/first message was rejected/);
  });

  it.each(["present", "removed", "tombstoned"])("gates sends and supports undo (message %s)", async state => {
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
    if (state === "removed") backend.state.messages.length = 0;
    if (state === "tombstoned") backend.state.messages[0].deleteTime = new Date().toISOString();

    // Explicit deletion is absent from the message capability, but a send still has an undo.
    expect(await chat.revertAction(1)).toBeUndefined();
    if (state !== "tombstoned") expect(backend.state.messages).toEqual([]);
    expect(backend.state.deletes).toEqual(state === "present" ? [`${SPACE_NAME}/messages/M1`] : []);
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
    await expect(chat.applyAction(2)).rejects.toThrow(/earlier queued change/);
    expect(backend.state.edits).toEqual([]);
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.messages[0].text).toBe("Resolved");
    await expect(chat.revertAction(1)).resolves.toMatchObject({message: expect.stringMatching(/edited again/)});
    await chat.revertAction(2);
    await chat.revertAction(1);
    expect(backend.state.edits.map(edit => edit.text)).toEqual(["Investigating", "Resolved", "Investigating", "root"]);
  });

  it("completes an edit undo retried after its response was lost", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Resolved");
    await chat.applyAction(1);
    backend.state.editFailure = 503;
    await expect(chat.revertAction(1)).rejects.toThrow(/http=503/);
    backend.state.editFailure = 0;
    const writes = backend.state.edits.length;
    await expect(chat.revertAction(1)).resolves.toBeUndefined();
    expect(backend.state.edits).toHaveLength(writes);
    expect(backend.state.messages[0].text).toBe("root");
  });

  it.each(["an edit", "a reaction removal"] as const)("counts undoing %s as done once its message is deleted", async change => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    if (change === "an edit") {
      await message.edit("Resolved");
    } else {
      await message.addReaction("👍");
      await chat.applyAction(1);
      await message.removeReaction("👍");
    }
    const id = change === "an edit" ? 1 : 2;
    await chat.applyAction(id);
    backend.state.messages = [];
    await expect(chat.revertAction(id)).resolves.toBeUndefined();
    await expect(chat.revertAction(id)).resolves.toMatchObject({message: expect.stringMatching(/no longer be undone/)});
  });

  it("asks for a restart only when a later action shares the rejected one's conversation", async () => {
    const chat = chatHarness(chatBackend(), undefined, "account");
    using account = await chat.account();
    using here = (await account.getSpace(SPACE_NAME)).space;
    using there = (await account.getSpace("spaces/BBBB")).space;
    using _first = (await here.post("one")).message;
    using _elsewhere = (await there.post("two")).message;
    using _second = (await here.post("three")).message;
    expect(await chat.rejectAction(2)).toBeUndefined();
    expect(await chat.rejectAction(1)).toEqual({restart: true});
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
    // Nothing reached Google, so the failed change can still be rejected.
    await chat.rejectAction(2);
  });

  it("refuses to reject a send that may have posted until a retry settles it", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using _posted = (await space.post("hello")).message;
    backend.state.createFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    await chat.restart();
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    // A later refusal says nothing about the earlier attempt that may have posted.
    backend.state.createFailure = 403;
    await expect(chat.applyAction(1)).rejects.toThrow();
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    backend.state.createFailure = 0;
    await chat.applyAction(1);
    expect(backend.state.creates).toHaveLength(1);
    await chat.revertAction(1);
    expect(backend.state.deletes).toHaveLength(1);
  });

  it("keeps a send rejectable when Chat definitively refuses its first write", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    using _posted = (await space.post("hello")).message;
    backend.state.createFailure = 403;
    await expect(chat.applyAction(1)).rejects.toThrow();
    expect(backend.state.creates).toEqual([]);
    await chat.rejectAction(1);
  });

  it("rebases queued edits onto the text Chat stored for the send and edits before them", async () => {
    const backend = chatBackend();
    backend.state.storeText = text => text.replace("<users/123>", "@Alice");
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.post("Hi <users/123>")).message;
    await message.edit("Hi <users/123>, done");
    await message.edit("All done");
    await chat.applyAction(1);
    await chat.applyAction(2);
    await chat.applyAction(3);
    expect(backend.state.edits.map(edit => edit.text)).toEqual(["Hi <users/123>, done", "All done"]);
  });

  it("rebases queued edits onto the stored text when a retried send gets its request echoed", async () => {
    const backend = chatBackend();
    backend.state.storeText = text => text.replace("<users/123>", "@Alice");
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.post("Hi <users/123>")).message;
    await message.edit("Hi <users/123>, done");
    backend.state.createFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    backend.state.createFailure = 0;
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.edits.map(edit => edit.text)).toEqual(["Hi <users/123>, done"]);
  });

  it("finishes a retried edit whose lost write Chat stored in rendered form", async () => {
    const backend = chatBackend();
    backend.state.storeText = text => text.replace("<users/123>", "@Alice");
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Hi <users/123>");
    backend.state.editFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow(/http=503/);
    backend.state.editFailure = 0;
    await chat.applyAction(1);
    expect(backend.state.messages[0].text).toBe("Hi @Alice");
    await expect(chat.revertAction(1)).resolves.toBeUndefined();
    expect(backend.state.messages[0].text).toBe("root");
  });

  it("lets an uncertain edit be rejected once its message is deleted", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Resolved");
    backend.state.editFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow(/http=503/);
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    backend.state.messages = [];
    await expect(chat.applyAction(1)).rejects.toThrow(/deleted in Google Chat.*Reject it/);
    await chat.rejectAction(1);
  });

  it.each(["thread", "space"] as const)("takes back a reply Google posts outside its thread from a %s binding, even when re-applied", async binding => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend, undefined, binding);
    if (binding === "thread") {
      using thread = await chat.thread();
      using _reply = (await thread.post("ack")).message;
    } else {
      using space = await chat.session();
      using root = (await space.getMessage(messageName("root"))).message;
      using _reply = (await root.reply("ack")).message;
    }
    backend.state.misplaceReplies = true;
    await expect(chat.applyAction(1)).rejects.toThrow(/posted this reply outside its thread/);
    expect(backend.state.deletes).toEqual([`${SPACE_NAME}/messages/M1`]);
    // Chat now answers the request id with the deleted message.
    await expect(chat.applyAction(1)).rejects.toThrow(/deleted in Google Chat.*Reject it/);
    await chat.rejectAction(1);
  });

  it("keeps a misplaced reply unrejectable while taking it back fails, until it is deleted by hand", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend, undefined, "thread");
    using thread = await chat.thread();
    using _reply = (await thread.post("ack")).message;
    backend.state.misplaceReplies = true;
    backend.state.repliesOn.add(`${SPACE_NAME}/messages/M1`);
    await expect(chat.applyAction(1)).rejects.toThrow(/removing it failed/);
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    backend.state.messages = backend.state.messages.filter(message => message.name !== `${SPACE_NAME}/messages/M1`);
    await expect(chat.applyAction(1)).rejects.toThrow(/deleted in Google Chat.*Reject it/);
    await chat.rejectAction(1);
  });

  it("refuses to apply an edit over text changed in Google Chat since it was queued", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Resolved");
    backend.state.messages[0].text = "Changed by hand";
    await expect(chat.applyAction(1)).rejects.toThrow(/edited in Google Chat after this change was queued/);
    expect(backend.state.edits).toEqual([]);
    await chat.rejectAction(1);
  });

  it("leaves an owner's matching edit alone when undoing an edit that wrote nothing", async () => {
    const backend = chatBackend();
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("root"))).message;
    await message.edit("Resolved");
    backend.state.messages[0].text = "Resolved";
    await chat.applyAction(1);
    await expect(chat.revertAction(1)).resolves.toBeUndefined();
    expect(backend.state.edits).toEqual([]);
    expect(backend.state.messages[0].text).toBe("Resolved");
  });

  it("keeps the owner's read state out of a shareable conversation's search", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    // Not part of ChatSpaceMessageSearch, but RPC validation passes undeclared fields through.
    const query = {text: "report", unreadOnly: true};
    using results = await space.searchMessages(query);
    await results.next();
    expect(backend.state.searches).toHaveLength(1);
    expect(backend.state.searches[0]).not.toContain("is_unread");
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
      threadMessage("later", "A", "2024-01-01T00:00:00Z"),
    );
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.getMessage(messageName("missing")))).rejects.toThrow(/http=404/);
    await expect(Promise.resolve(space.getMessage(messageName("private")))).rejects.toThrow(/not available/);
    await expect(Promise.resolve(space.getMessage(messageName("deleted")))).rejects.toThrow(/has been deleted/);
    using later = (await space.getMessage(messageName("later"))).message;
    backend.state.messages.find(message => message.name === messageName("later"))!.deleteTime =
      "2024-01-02T00:00:00Z";
    await expect(Promise.resolve(later.getMetadata())).rejects.toThrow(/has been deleted/);
    await expect(Promise.resolve(space.getMessage("spaces/OTHER/messages/1")))
      .rejects.toThrow(/different conversation/);
  });

  it("refuses to queue an edit of someone else's message", async () => {
    const backend = chatBackend();
    backend.state.messages.push(
      {...threadMessage("theirs", "A", "2024-01-01T00:00:00Z"), sender: {name: "users/other", type: "HUMAN"}});
    const chat = chatHarness(backend);
    using space = await chat.session();
    using message = (await space.getMessage(messageName("theirs"))).message;
    await expect(Promise.resolve(message.edit("mine now"))).rejects.toThrow(/Only your own/);
    expect((await chat.readQueue()).submissions).toEqual([]);
  });

  it("lists no reactions on a message that is still pending", async () => {
    const chat = chatHarness(chatBackend());
    using space = await chat.session();
    using message = (await space.post("hello")).message;
    using reactions = await message.listReactions();
    expect(await reactions.next()).toBeNull();
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
    createTime, threadReply: reply, sender: {name: "users/subject-a", type: "HUMAN"}};
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

  it("fetches roots outside the scanned page and window for discovery and metadata", async () => {
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
    expect(page![0].info.rootMessage?.text).toBe("root");
    expect(backend.state.lists).toHaveLength(2);
    const rootLookup = backend.state.lists[1];
    expect(rootLookup.searchParams.get("filter")).toContain(`thread.name = ${threadName("A")}`);
    expect(rootLookup.searchParams.get("filter")).not.toContain("createTime");
    expect(rootLookup.searchParams.get("orderBy")).toBe("createTime ASC");
    expect(await page![0].thread.getMetadata()).toMatchObject(
      {latestMessage: {text: "reply"}, rootMessage: {text: "root"}});
    expect(backend.state.gets).toEqual([]);
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
    const results: Array<[string, string, string | undefined]> = [];
    for (let i = 0; i < 10; i++) {
      using page = await cursor.next();
      if (page === null) break;
      for (const entry of page) {
        results.push([entry.info.id, entry.info.latestMessage.text, entry.info.rootMessage?.text]);
      }
    }
    // The old root predates the window, yet is still reported as the thread's first message.
    expect(results).toEqual([
      [threadName("A"), "latest-reply", "old-root"], [threadName("B"), "zero-replies", "zero-replies"],
    ]);
    expect(await cursor.next()).toBeNull();
    const scans = backend.state.lists.filter(url => !(url.searchParams.get("filter") ?? "").includes("thread.name"));
    expect(scans[0].searchParams.get("pageToken")).toBeNull();
    expect(scans[2].searchParams.get("pageToken")).toBeNull();
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
    const fromMessage = await root.getThread();
    using _fromMessageThread = fromMessage.thread;
    expect(fromMessage.info.id).toBe(threadName("A"));
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
    await expect(Promise.resolve(message.getThread())).rejects.toThrow(scopeError);
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

  it("titles a thread binding past a first page of messages hidden from this account", async () => {
    const backend = chatBackend();
    backend.state.pageSize = 2;
    backend.state.messages.push(
      {...threadMessage("private-1", "A", "2024-01-01T00:00:00Z"), privateMessageViewer: {name: "users/1"}},
      {...threadMessage("private-2", "A", "2024-01-01T01:00:00Z", true), privateMessageViewer: {name: "users/1"}},
      threadMessage("visible", "A", "2024-01-02T00:00:00Z", true),
    );
    const chat = chatHarness(backend, undefined, "thread");
    expect(await chat.describe()).toMatchObject({title: "Thread in Project", tsType: "ChatThread"});
  });

  it("binds one thread as the whole session", async () => {
    const backend = chatBackend();
    backend.state.messages.push(
      threadMessage("root", "A", "2024-01-01T00:00:00Z"),
      threadMessage("reply", "A", "2024-01-02T00:00:00Z", true),
      threadMessage("unrelated", "B", "2024-01-03T00:00:00Z"),
    );
    const chat = chatHarness(backend, undefined, "thread");
    expect(await chat.describe()).toMatchObject({
      url: `https://chat.google.com/room/${SPACE_ID}/A`, title: "Project: root",
      suggestedBindingName: "GOOGLE_CHAT_THREAD", tsType: "ChatThread",
    });
    using thread = await chat.thread();
    expect(await thread.getCurrentUser()).toEqual({id: "users/subject-a", name: "Ada", type: "human"});
    expect(await thread.getMetadata()).toMatchObject({
      id: threadName("A"), rootMessage: {text: "root"}, latestMessage: {text: "reply"},
    });
    using history = await thread.listMessages();
    using page = await history.next();
    expect(page!.map(entry => entry.info.text)).toEqual(["root", "reply"]);
    await expect(Promise.resolve(Reflect.get(thread, "listThreads")())).rejects.toThrow(/does not implement/);
    const posted = await thread.post("ack");
    using _posted = posted.message;
    expect(posted.info.threadId).toBe(threadName("A"));
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

  it.each(["DIRECT_MESSAGE", "GROUP_CHAT"])("threads a %s whose threading state is threaded", async spaceType => {
    const backend = chatBackend();
    backend.state.spaceType = spaceType;
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    using threads = await space.listThreads();
    using page = await threads.next();
    expect(page!.map(entry => entry.info.id)).toEqual([threadName("A")]);
    using message = (await space.getMessage(messageName("root"))).message;
    const entry = await message.getThread();
    using _thread = entry.thread;
    expect(entry.info).toMatchObject({id: threadName("A"), rootMessage: {text: "root"}});
    const reply = await message.reply("hello");
    using _reply = reply.message;
    expect(reply.info.threadId).toBe(threadName("A"));
  });

  it("keeps an unthreaded conversation flat", async () => {
    const backend = chatBackend();
    backend.state.spaceThreadingState = "UNTHREADED_MESSAGES";
    backend.state.messages.push(threadMessage("root", "A", "2024-01-01T00:00:00Z"));
    const chat = chatHarness(backend);
    using space = await chat.session();
    await expect(Promise.resolve(space.listThreads())).rejects.toThrow(/does not support/);
    expect(backend.state.lists).toEqual([]);
    await expect(Promise.resolve(space.getThread(threadName("A")))).rejects.toThrow(/does not support/);
    using message = (await space.getMessage(messageName("root"))).message;
    await expect(Promise.resolve(message.getThread())).rejects.toThrow(/does not support/);
    await expect(Promise.resolve(message.reply("hello"))).rejects.toThrow(/does not support/);
    expect((await chat.readQueue()).submissions).toEqual([]);
  });

  it("continues a posted message as a thread through approval", async () => {
    const backend = chatBackend();
    const chat = chatHarness(backend);
    using space = await chat.session();
    const posted = await space.post("new topic");
    using root = posted.message;
    const started = await root.getThread();
    using thread = started.thread;
    const expected = {
      id: "pending:thread:1", spaceId: SPACE_NAME,
      rootMessage: {text: "new topic"}, latestMessage: {text: "new topic"},
    };
    expect(started.info).toMatchObject(expected);
    expect(await thread.getMetadata()).toMatchObject(expected);
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
    await expect(Promise.resolve(thread.getRootMessage())).rejects.toThrow(/first message was rejected/);
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

describe("Starting Google Chat conversations", () => {
  const BOB = {id: "200", name: "Bob Jones", email: "bob@example.com"};
  const CAROL = {id: "300", name: "Carol King", email: "carol@example.com"};
  const CHAT_APP = {...joined("app1"), member: {name: "users/app1", type: "BOT"}};
  /** With `groupChat`, Ada already has the group chat SPACE_NAME with Bob and Carol. */
  const accountChat = ({groupChat = false} = {}) => {
    const backend = chatBackend();
    // Directory profiles carry numeric People ids, the same number as the account's subject.
    backend.state.directory.push({id: "100", name: "Ada", email: "ada@example.com"}, BOB, CAROL);
    backend.state.externalContacts.push({id: "900", name: "Eve Outside", email: "eve@elsewhere.test"});
    if (groupChat) {
      backend.state.groupChats = [SPACE_NAME];
      backend.state.members = ["100", BOB.id, CAROL.id].map(joined);
    }
    return {backend, chat: chatHarness(backend, () => ({sub: "100", name: "Ada"}), "account")};
  };

  it("searches only the organization's directory, recording each page it returns", async () => {
    const {chat} = accountChat();
    using account = await chat.account();
    using cursor = await account.searchPeople("bo");
    await chat.failNextObservation("Search the Google Workspace directory");
    await expect(Promise.resolve(cursor.next())).rejects.toThrow(/denied by the test/);
    expect(await cursor.next()).toEqual([{id: "users/200", name: "Bob Jones", email: "bob@example.com"}]);
    using outside = await account.searchPeople("eve");
    expect(await outside.next()).toBeNull();
  });

  it("posts in an existing direct message or group chat as an ordinary send", async () => {
    const {backend, chat} = accountChat({groupChat: true});
    // Google may list a conversation's members a page at a time.
    backend.state.pageSize = 1;
    using account = await chat.account();
    using _dm = (await account.sendDirectMessage(["alice@example.com"], "hi")).message;
    using _group = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    const {submissions} = await chat.readQueue();
    expect(submissions.map(({description}) => description)).toMatchObject([
      {actionKind: {tag: "chatSendMessage"}}, {actionKind: {tag: "chatSendMessage"}},
    ]);
    await chat.applyAction(1);
    await chat.applyAction(2);
    expect(backend.state.setups).toEqual([]);
    expect(backend.state.creates.map(create => create.body.text)).toEqual(["hi", "hi all"]);
  });

  // Google matches group chats on their human members alone, so a match may also hold a Chat app.
  it("posts in a later group chat with exactly the people named when an earlier match also holds an app", async () => {
    const {backend, chat} = accountChat({groupChat: true});
    backend.state.pageSize = 1;
    backend.state.groupChats.unshift("spaces/WITHAPP");
    backend.state.otherMembers.set("spaces/WITHAPP", [...backend.state.members, CHAT_APP]);
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    await chat.applyAction(1);
    expect(backend.state.setups).toEqual([]);
    expect(backend.state.creates.map(create => create.body.text)).toEqual(["hi all"]);
  });

  // People, Chat apps and Google Groups join a group chat while a send to it awaits approval, so
  // it reaches only those it named.
  it.each([
    ["someone joins", joined("400")],
    ["a Chat app joins", CHAT_APP],
    ["a Google Group joins", {name: `${SPACE_NAME}/members/g1`, state: "JOINED", groupMember: {name: "groups/g1"}}],
  ])("posts nothing, and stays rejectable, when %s an existing group chat", async (_case, member) => {
    const {backend, chat} = accountChat({groupChat: true});
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.members.push(member);
    await expect(chat.applyAction(1)).rejects.toThrow(/no longer holds exactly .* Reject this message/);
    expect(backend.state.creates).toEqual([]);
    await chat.rejectAction(1);
  });

  it.each([["an existing group chat", true], ["the group chat it sets up", false]])(
    "finishes a send to %s whose post landed before its response was lost, whoever has joined since",
    async (_case, groupChat) => {
    const {backend, chat} = accountChat({groupChat});
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    backend.state.createFailure = 0;
    backend.state.members.push(joined("400"));
    await chat.applyAction(1);
    expect(backend.state.creates.map(create => create.body.text)).toEqual(["hi all"]);
  });

  // A name for someone already counted leaves the group chat's last place to someone nobody named.
  it.each([
    ["two of them are the same person", [BOB.email, `users/${BOB.id}`], /email address/],
    ["one of them is you", ["ada@example.com", BOB.email], /yourself/],
  ])("won't take a group chat for one with exactly the people named when %s", async (_case, people, error) => {
    const {backend, chat} = accountChat();
    backend.state.groupChats = [SPACE_NAME];
    backend.state.members = ["100", BOB.id, "400"].map(joined);
    using account = await chat.account();
    await expect(Promise.resolve(account.sendDirectMessage(people, "hi"))).rejects.toThrow(error);
    expect((await chat.readQueue()).submissions).toEqual([]);
  });

  it("creates a direct message with a directory member only once the message is approved", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    const {info, message} = await account.sendDirectMessage(["Bob@Example.com"], "hello");
    using _message = message;
    expect(info).toMatchObject({pending: true, text: "hello", spaceId: expect.stringMatching(/^pending:space:/)});
    expect(info.threadId).toBeUndefined();
    const [start] = (await chat.readQueue()).submissions;
    expect(start.description).toMatchObject({
      title: "Start a Google Chat conversation with Bob Jones",
      actionKind: {tag: "chatStartConversation"},
      autoApprovable: true,
      fields: [
        {label: "People", kind: "list", items: ["Bob Jones <bob@example.com>"]},
        {label: "Message", kind: "text", value: "hello"},
      ],
    });
    expect(backend.state.setups).toEqual([]);
    await expect(Promise.resolve(message.reply("too soon"))).rejects.toThrow(/until the message is committed/);

    await chat.applyAction(1);
    expect(backend.state.setups).toMatchObject([{spaceType: "DIRECT_MESSAGE", members: ["users/200"]}]);
    expect(await message.getMetadata()).toMatchObject({id: messageName("M1"), spaceId: SPACE_NAME, text: "hello"});
    await chat.revertAction(1);
    expect(backend.state.deletes).toEqual([messageName("M1")]);
  });

  it("refuses to start a conversation with anyone outside the directory, or with yourself", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    await expect(Promise.resolve(account.sendDirectMessage(["eve@elsewhere.test"], "hi")))
      .rejects.toThrow(/eve@elsewhere\.test.*directory/);
    await expect(Promise.resolve(account.sendDirectMessage(["users/200"], "hi")))
      .rejects.toThrow(/email address/);
    await expect(Promise.resolve(account.sendDirectMessage([BOB.email, "ada@example.com"], "hi")))
      .rejects.toThrow(/yourself/);
    expect((await chat.readQueue()).submissions).toEqual([]);
    expect(backend.state.setups).toEqual([]);
  });

  it("won't call someone outside the directory when more profiles match than a page holds", async () => {
    const {backend, chat} = accountChat();
    backend.state.pageSize = 1;
    // An address that begins with Bob's, which Google's prefix search can return ahead of his.
    backend.state.directory.unshift({id: "201", name: "Bob Other", email: "bob@example.com.au"});
    using account = await chat.account();
    await expect(Promise.resolve(account.sendDirectMessage([BOB.email], "hi")))
      .rejects.toThrow(/Couldn't confirm that bob@example\.com is in/);
  });

  // Google silently leaves out of a new group chat anyone who blocks the caller, so a post there
  // would reach a different audience than the one approved.
  it("posts nothing, and stays rejectable, when Google leaves someone out of a new group chat", async () => {
    const {backend, chat} = accountChat();
    backend.state.setupOmits = ["users/300"];
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi both")).message;
    expect((await chat.readQueue()).submissions[0].description).toMatchObject({
      title: "Start a Google Chat conversation with Bob Jones and Carol King",
    });
    await expect(chat.applyAction(1)).rejects.toThrow(/left .*Carol King.* out/);
    expect(backend.state.setups).toMatchObject([{spaceType: "GROUP_CHAT", members: ["users/200", "users/300"]}]);
    expect(backend.state.creates).toEqual([]);
    await chat.rejectAction(1);
    // Replaying that setup would return the same group, so a later send sets up its own.
    backend.state.setupOmits = [];
    using _again = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi both")).message;
    await chat.applyAction(2);
    expect(backend.state.setups).toHaveLength(2);
  });

  // With no group chat that has everyone, Google's lookup offers one without whoever blocks you.
  it.each([
    ["left someone out", [joined(BOB.id)]],
    ["put someone else in", [joined(BOB.id), joined("400")]],
    ["put someone else in for someone who left", [
      joined(BOB.id), joined("400"), {...joined(CAROL.id), state: "NOT_A_MEMBER"},
    ]],
  ])("starts a group chat rather than posting where Google's lookup %s", async (_case, others) => {
    const {backend, chat} = accountChat();
    backend.state.groupChats = [SPACE_NAME];
    backend.state.members = [joined("100"), ...others];
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    expect((await chat.readQueue()).submissions[0].description)
      .toMatchObject({actionKind: {tag: "chatStartConversation"}});
    backend.state.setupOmits = [`users/${CAROL.id}`];
    await expect(chat.applyAction(1)).rejects.toThrow(/left .*Carol King.* out/);
    expect(backend.state.creates).toEqual([]);
  });

  it.each([[1, 2], [2, 1]])(
    "creates a group chat once across a lost response when send %i is applied next", async (next, last) => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _first = (await account.sendDirectMessage([BOB.email, CAROL.email], "one")).message;
    using _second = (await account.sendDirectMessage([CAROL.email, BOB.email], "two")).message;
    backend.state.setupFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
    backend.state.setupFailure = 0;
    await chat.applyAction(next);
    await chat.applyAction(last);
    expect(backend.state.setups).toHaveLength(1);
    expect(backend.state.creates.map(create => create.body.text).toSorted()).toEqual(["one", "two"]);
  });

  it("posts nothing where a replayed setup returns a group someone has joined since", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.setupFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    backend.state.setupFailure = 0;
    backend.state.members.push(joined("400"));
    await expect(chat.applyAction(1)).rejects.toThrow(/wasn't approved/);
    expect(backend.state.creates).toEqual([]);
    await chat.rejectAction(1);
  });

  it("sets up one group chat for sends to the same people approved at once", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _first = (await account.sendDirectMessage([BOB.email, CAROL.email], "one")).message;
    using _second = (await account.sendDirectMessage([CAROL.email, BOB.email], "two")).message;
    await Promise.all([chat.applyAction(1), chat.applyAction(2)]);
    expect(backend.state.setups).toHaveLength(1);
    expect(backend.state.creates.map(create => create.body.text).toSorted()).toEqual(["one", "two"]);
  });

  it("sets up a new group chat once someone has left the one it set up", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _first = (await account.sendDirectMessage([BOB.email, CAROL.email], "one")).message;
    await chat.applyAction(1);
    backend.state.members = backend.state.members.filter(member => member.member?.name !== `users/${CAROL.id}`);
    using _second = (await account.sendDirectMessage([BOB.email, CAROL.email], "two")).message;
    await chat.applyAction(2);
    expect(backend.state.setups).toHaveLength(2);
    expect(backend.state.creates.map(create => create.body.text)).toEqual(["one", "two"]);
  });

  it("lists a send in the conversation it set up before its post succeeds", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 403;
    await expect(chat.applyAction(1)).rejects.toThrow(/http=403/);
    using space = (await account.getSpace(SPACE_NAME)).space;
    using cursor = await space.listMessages();
    expect((await cursor.next())?.map(({info}) => [info.text, info.spaceId])).toEqual([["hi all", SPACE_NAME]]);
  });

  it("keeps a send that may have posted in the conversation it set up from being rejected", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 503;
    backend.state.createsPostNothing = true;
    await expect(chat.applyAction(1)).rejects.toThrow();
    // A later refusal says nothing about the earlier attempt that may have posted.
    backend.state.createFailure = 403;
    await expect(chat.applyAction(1)).rejects.toThrow();
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
  });

  it("lets a send be rejected once the post it landed is deleted, whoever has joined since", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow();
    backend.state.createFailure = 0;
    backend.state.messages[0].deletionMetadata = {deletionType: "CREATOR"};
    backend.state.members.push(joined("400"));
    await expect(chat.applyAction(1)).rejects.toThrow(/was deleted/);
    await chat.rejectAction(1);
  });

  it("posts nothing, and stays unrejectable, once someone joins after a post that may not have landed", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 503;
    backend.state.createsPostNothing = true;
    await expect(chat.applyAction(1)).rejects.toThrow();
    backend.state.createFailure = 0;
    backend.state.members.push(joined("400"));
    await expect(chat.applyAction(1)).rejects.toThrow(/no longer holds exactly/);
    expect(backend.state.creates).toEqual([]);
    await expect(chat.rejectAction(1)).rejects.toThrow(/may already have reached Google/);
  });

  it("posts nothing once someone joins the conversation it set up before a refused post", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.createFailure = 403;
    await expect(chat.applyAction(1)).rejects.toThrow(/http=403/);
    backend.state.createFailure = 0;
    backend.state.members.push(joined("400"));
    await expect(chat.applyAction(1)).rejects.toThrow(/no longer holds exactly/);
    expect(backend.state.creates).toEqual([]);
    backend.state.members.pop();
    await chat.applyAction(1);
    expect(backend.state.creates.map(create => create.body.text)).toEqual(["hi all"]);
  });

  it("keeps a send rejectable, and shares its setup, when Google can't list the new group's members", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using _message = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    backend.state.membersFailure = 503;
    await expect(chat.applyAction(1)).rejects.toThrow(/http=503/);
    // Nothing was posted, and an empty conversation shows nobody anything.
    expect(backend.state.creates).toEqual([]);
    await chat.rejectAction(1);
    // The next send to the same people replays that setup rather than making a second group chat.
    backend.state.membersFailure = 0;
    using _again = (await account.sendDirectMessage([BOB.email, CAROL.email], "hi all")).message;
    await chat.applyAction(2);
    expect(backend.state.setups).toHaveLength(1);
  });

  it("carries an edit queued before the conversation exists into it", async () => {
    const {backend, chat} = accountChat();
    using account = await chat.account();
    using message = (await account.sendDirectMessage([BOB.email], "helo")).message;
    await message.edit("hello");
    await expect(chat.applyAction(2)).rejects.toThrow(/Post the message before/);
    await chat.applyAction(1);
    expect(await message.getMetadata()).toMatchObject({id: messageName("M1"), text: "hello"});
    await chat.applyAction(2);
    expect(backend.state.edits).toEqual([{name: messageName("M1"), text: "hello"}]);
  });

  it("restarts the gadget when a start with queued edits is rejected", async () => {
    const {chat} = accountChat();
    using account = await chat.account();
    using message = (await account.sendDirectMessage([BOB.email], "helo")).message;
    await message.edit("hello");
    expect(await chat.rejectAction(1)).toEqual({restart: true});
  });
});
