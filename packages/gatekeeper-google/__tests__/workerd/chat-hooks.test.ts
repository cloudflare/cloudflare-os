// Google Chat new-message hooks, end to end inside the gatekeeper worker: a facet restored the way
// the Overseer restores it binds the hook, TestHooks enables it and answers each firing, and Google
// is the fetch mock below, reached by signed Pub/Sub pushes through the worker's own fetch handler.

import {env} from "cloudflare:workers";
import {SELF, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {SignJWT, exportJWK, generateKeyPair} from "jose";
import {afterEach, beforeAll, beforeEach, expect, it, vi} from "vitest";
import type {GoogleChatGatekeeperImplProps} from "../../src/chat";
import type {ChatMessageRaw} from "../../src/chat-api";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  ChatHookDriver: DurableObjectNamespace;
  GoogleChatGatekeeperImpl: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
  UserAccount: DurableObjectNamespace;
};

// Each test watches a fresh space, so that no other test's hooks share its space driver.
let SPACE: string;
let THREAD: string;
const PUSH_ACCOUNT = "push@test.iam.gserviceaccount.com";
const PUSH_URL = "http://localhost:8787/gatekeeper/google/pubsub";
const CREATED = "google.workspace.chat.message.v1.created";
const BATCH_CREATED = "google.workspace.chat.message.v1.batchCreated";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

let signingKey: CryptoKey;
let jwks: unknown;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  signingKey = keys.privateKey;
  jwks = {keys: [{...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig"}]};
});

beforeEach(() => {
  SPACE = `spaces/${crypto.randomUUID().replaceAll("-", "")}`;
  THREAD = `${SPACE}/threads/T1`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Google, answering as whichever account the bearer token belongs to (`token-<subject>`). */
function mockGoogle() {
  const google = {
    /** Make subscriptions report this authority, as after a reconnect to another account. */
    authority: undefined as string | undefined,
    /** Name new subscriptions this, as Google names each one afresh. */
    subscriptionId: undefined as string | undefined,
    /**
     * When set, subscriptions.get flags that it started and fails once released. Both sides poll,
     * because a promise settled across Durable Objects moves its waiter's I/O to the settler.
     */
    stallGet: undefined as {started: boolean; released: boolean} | undefined,
    /**
     * The account's subscription to the space that Google holds but the driver never learned of,
     * as when a create's response is lost; Google refuses to create another while it exists.
     */
    unrecorded: undefined as {name: string; topic: string; state?: string} | undefined,
    /** Make the conversation a group chat, whose messages have no threads. */
    unthreaded: false,
    messages: new Map<string, ChatMessageRaw>(),
    posted: [] as Array<{text: string; thread?: {name: string}}>,
    /** Subscriptions created, reactivated and deleted, renewal attempts, and how many more renewals fail. */
    creates: 0,
    reactivated: [] as string[],
    deleted: [] as string[],
    renewals: 0,
    failRenewals: 0,
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const subject = new Headers(init.headers).get("Authorization")?.replace("Bearer token-", "");
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return json(jwks);
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") return json({sub: subject});
    if (url.href === "https://workspaceevents.googleapis.com/v1/subscriptions" && method === "POST") {
      if (google.unrecorded) return json({error: {code: 409, status: "ALREADY_EXISTS"}}, 409);
      google.creates++;
      return json({name: "operations/create", done: true, response: {
        name: `subscriptions/${google.subscriptionId ?? subject}`, state: "ACTIVE",
        authority: `users/${google.authority ?? subject}`,
        expireTime: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      }});
    }
    if (url.hostname === "workspaceevents.googleapis.com" && url.pathname === "/v1/subscriptions" && method === "GET") {
      const {name, topic, state = "ACTIVE"} = google.unrecorded ?? {};
      const matches = name && url.searchParams.get("filter")?.includes(`"//chat.googleapis.com/${SPACE}"`);
      return json({subscriptions: matches ? [{name, authority: `users/${subject}`, state,
        expireTime: new Date(Date.now() + 60_000).toISOString(), notificationEndpoint: {pubsubTopic: topic}}] : []});
    }
    const subscription = /^\/v1\/(subscriptions\/[^/:]+)(?::reactivate)?$/.exec(url.pathname)?.[1];
    const live = {name: subscription, authority: `users/${subject}`, state: "ACTIVE",
      expireTime: new Date(Date.now() + 3_600_000).toISOString()};
    if (url.hostname === "workspaceevents.googleapis.com" && subscription && method === "POST") {
      google.reactivated.push(subscription);
      return json({name: "operations/reactivate", done: true, response: live});
    }
    if (url.hostname === "workspaceevents.googleapis.com" && subscription && method === "GET") {
      if (!google.stallGet) return json(live);
      google.stallGet.started = true;
      await vi.waitFor(() => expect(google.stallGet!.released).toBe(true));
      return json({error: {code: 403, status: "PERMISSION_DENIED"}}, 403);
    }
    if (url.hostname === "workspaceevents.googleapis.com" && subscription && method === "DELETE") {
      google.deleted.push(subscription);
      return json({name: "operations/delete", done: true});
    }
    if (url.hostname === "workspaceevents.googleapis.com" && subscription && method === "PATCH") {
      google.renewals++;
      if (google.failRenewals-- > 0) return json({error: {code: 503, status: "UNAVAILABLE"}}, 503);
      return json({name: "operations/renew", done: true, response: live});
    }
    if (url.hostname === "chat.googleapis.com" && url.pathname === `/v1/${SPACE}`) {
      return json({name: SPACE, displayName: "Project", spaceType: google.unthreaded ? "GROUP_CHAT" : "SPACE",
        spaceThreadingState: google.unthreaded ? "UNTHREADED_MESSAGES" : "THREADED_MESSAGES"});
    }
    if (url.hostname === "chat.googleapis.com" && url.pathname === `/v1/${SPACE}/messages` && method === "POST") {
      const body = JSON.parse(init.body as string) as {text: string; thread?: {name: string}};
      google.posted.push(body);
      const posted = {name: `${SPACE}/messages/posted`, ...body, createTime: new Date().toISOString()};
      google.messages.set(posted.name, posted);
      return json(posted);
    }
    const message = url.hostname === "chat.googleapis.com" && google.messages.get(url.pathname.slice("/v1/".length));
    if (message) return json(message);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return google;
}

let nextMessage = 0;
function chatMessage(sender: string, thread = THREAD): ChatMessageRaw {
  return {
    name: `${SPACE}/messages/m${++nextMessage}`, sender: {name: `users/${sender}`, type: "HUMAN"},
    createTime: new Date().toISOString(), text: `hello ${nextMessage}`, thread: {name: thread},
    space: {name: SPACE},
  };
}

/** One person's Chat connection, its hook subscribed through the restored facet and enabled. */
async function connect(subject: string, binding: {threadId?: string} = {}) {
  const name = `chat-hooks-${crypto.randomUUID()}`;
  const userObject = testEnv.UserAccount.get(testEnv.UserAccount.idFromName(name));
  await runInDurableObject(userObject, (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
    // Valid for a day, so faking the clock forward to a renewal needs no token refresh.
    state.storage.kv.put("accessToken", {token: `token-${subject}`, expires: new Date(Date.now() + 24 * 3_600_000)});
  });
  const props: GoogleChatGatekeeperImplProps = {
    userObjectId: userObject.id.toString(), spaceId: SPACE.slice("spaces/".length), ...binding,
  };
  const hooks = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const facet = {facetName: `chat-${name}`, id: testEnv.GoogleChatGatekeeperImpl.idFromName(name).toString(), props};
  await hooks.chatSubscribe(facet);
  return {hooks, ...facet};
}

async function push(subscriber: string, messages: ChatMessageRaw[], {
  audience = PUSH_URL, email = PUSH_ACCOUNT,
}: {audience?: string; email?: string} = {}): Promise<number> {
  const token = await new SignJWT({email, email_verified: true})
    .setProtectedHeader({alg: "RS256", kid: "test"})
    .setIssuer("https://accounts.google.com").setAudience(audience)
    .setIssuedAt().setExpirationTime("5m")
    .sign(signingKey);
  const event = messages.length === 1 ? {message: messages[0]} : {messages: messages.map(message => ({message}))};
  const response = await SELF.fetch(PUSH_URL, {
    method: "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify({message: {
      attributes: {
        "ce-type": messages.length === 1 ? CREATED : BATCH_CREATED,
        "ce-source": `//workspaceevents.googleapis.com/subscriptions/${subscriber}`,
        "ce-subject": `//chat.googleapis.com/${SPACE}`,
      },
      data: btoa(JSON.stringify(event)),
    }}),
  });
  return response.status;
}

const driver = () => testEnv.ChatHookDriver.get(testEnv.ChatHookDriver.idFromName(SPACE));

/**
 * Wait until the space driver has no delivery due: its own alarm runs them, and forcing that alarm
 * here as well would deliver one message twice from two concurrent alarm() calls.
 */
const deliver = () => vi.waitFor(() => runInDurableObject(driver(), (_instance: unknown, state: DurableObjectState) => {
  const due = [...state.storage.kv.list<{at?: number}>({prefix: "msg:"})].filter(([, row]) => row.at! <= Date.now());
  if (due.length > 0) throw new Error(`${due.length} deliveries due`);
}));

it("delivers each new message from someone else once, and the hook's reply applies as an action", async () => {
  const google = mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.setHookBehavior({reply: "On it."});

  const fromBob = chatMessage("bob");
  google.messages.set(fromBob.name!, fromBob);
  // Ada's own post is never echoed back to her, and Pub/Sub may push the same message twice.
  expect(await push("ada", [fromBob, chatMessage("ada")])).toBe(204);
  expect(await push("ada", [fromBob])).toBe(204);
  await deliver();

  const delivered = await ada.hooks.readHook();
  expect(delivered.received.map(info => info.id)).toEqual([fromBob.name]);
  expect(delivered.submissions).toHaveLength(1);
  await ada.hooks.chatApplyAction(ada.facetName, ada.id, ada.props, delivered.submissions[0].actionId);
  expect(google.posted).toEqual([{text: "On it.", thread: {name: THREAD}}]);

  await ada.hooks.chatDisableHook();
  await push("ada", [chatMessage("bob")]);
  await deliver();
  expect((await ada.hooks.readHook()).received).toHaveLength(1);
});

it("lets a hook answer through the conversation it watches, where messages have no threads", async () => {
  const google = mockGoogle();
  google.unthreaded = true;
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.setHookBehavior({post: "On it."});

  await push("ada", [chatMessage("bob")]);
  await deliver();

  const {submissions} = await ada.hooks.readHook();
  await ada.hooks.chatApplyAction(ada.facetName, ada.id, ada.props, submissions[0].actionId);
  expect(google.posted).toEqual([{text: "On it."}]);
});

it("delivers a subscription's events only to hooks of the account that created it", async () => {
  mockGoogle();
  const ada = await connect("ada");
  const bob = await connect("bob");
  await ada.hooks.chatEnableHook();
  await bob.hooks.chatEnableHook();

  await push("ada", [chatMessage("carol")]);
  await deliver();

  expect((await ada.hooks.readHook()).received).toHaveLength(1);
  expect((await bob.hooks.readHook()).received).toEqual([]);
});

it("creates one subscription for an account's hooks in a space, however their enables interleave", async () => {
  const google = mockGoogle();
  const space = await connect("ada");
  const thread = await connect("ada", {threadId: "T1"});

  await Promise.all([space.hooks.chatEnableHook(), thread.hooks.chatEnableHook()]);

  expect(google.creates).toBe(1);
});

it("a thread's hook receives only that thread's messages", async () => {
  mockGoogle();
  const ada = await connect("ada", {threadId: "T1"});
  await ada.hooks.chatEnableHook();

  const inThread = chatMessage("bob");
  await push("ada", [chatMessage("bob", `${SPACE}/threads/T2`), inThread]);
  await deliver();

  expect((await ada.hooks.readHook()).received.map(info => info.id)).toEqual([inThread.name]);
});

it.each([
  ["the hook failed", {failures: 1}],
  ["whose firing the Workshop failed to start", {admissionFailures: 1}],
])("retries a delivery %s", async (_, behavior) => {
  mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.setHookBehavior(behavior);

  await push("ada", [chatMessage("bob")]);
  await deliver();
  expect((await ada.hooks.readHook()).received).toEqual([]);
  // The retry is due only on the faked clock, so the runtime will not wake the driver for it.
  vi.setSystemTime(Date.now() + 60_000);
  try {
    await runDurableObjectAlarm(driver());
  } finally {
    vi.useRealTimers();
  }
  expect((await ada.hooks.readHook()).received).toHaveLength(1);
});

it("drops a message after its eighth failed delivery, and a duplicate push doesn't revive it", async () => {
  mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.setHookBehavior({failures: 8});

  const message = chatMessage("bob");
  await push("ada", [message]);
  await deliver();
  // Backoff never exceeds an hour; the hook would accept a ninth attempt, so none must be made.
  try {
    for (let attempt = 2; attempt <= 9; attempt++) {
      vi.setSystemTime(Date.now() + 3_600_000);
      await runDurableObjectAlarm(driver());
    }
  } finally {
    vi.useRealTimers();
  }
  expect(await ada.hooks.readHook()).toMatchObject({failures: 0, received: []});

  await push("ada", [message]);
  await deliver();
  expect((await ada.hooks.readHook()).received).toEqual([]);
});

it("ends a failing delivery's retries when its hook is disabled, even if it is re-enabled first", async () => {
  mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.setHookBehavior({failures: 1});

  await push("ada", [chatMessage("bob")]);
  await deliver();
  await ada.hooks.chatDisableHook();
  await ada.hooks.chatEnableHook();
  vi.setSystemTime(Date.now() + 60_000);
  try {
    await runDurableObjectAlarm(driver());
  } finally {
    vi.useRealTimers();
  }
  expect((await ada.hooks.readHook()).received).toEqual([]);
});

it("retries a failed subscription renewal before the subscription lapses", async () => {
  const google = mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  google.failRenewals = 1;

  // Renewal is due 3 hours into the subscription's 4; the runtime won't wake for the faked clock.
  vi.setSystemTime(Date.now() + 3 * 3_600_000);
  try {
    await runDurableObjectAlarm(driver());
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await runDurableObjectAlarm(driver());
  } finally {
    vi.useRealTimers();
  }
  expect(google.renewals).toBe(2);
});

it("adopts, and reactivates, the suspended subscription an unanswered earlier create left", async () => {
  const google = mockGoogle();
  google.unrecorded = {name: "subscriptions/unrecorded", topic: "projects/test/topics/chat", state: "SUSPENDED"};
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();

  await push("unrecorded", [chatMessage("bob")]);
  await deliver();
  expect((await ada.hooks.readHook()).received).toHaveLength(1);
  expect(google.reactivated).toEqual(["subscriptions/unrecorded"]);
  // Renewed at once: it may be in its last minutes.
  expect(google.renewals).toBe(1);
});

it("refuses to adopt a subscription that publishes to another topic", async () => {
  const google = mockGoogle();
  google.unrecorded = {name: "subscriptions/elsewhere", topic: "projects/other/topics/chat"};
  const ada = await connect("ada");

  await expect(Promise.resolve(ada.hooks.chatEnableHook())).rejects.toThrow(/ALREADY_EXISTS/);
});

it("keeps the subscription an enable creates while a renewal of the expired one fails", async () => {
  const google = mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  const thread = await connect("ada", {threadId: "T1"});
  google.stallGet = {started: false, released: false};

  // Past expiry, as when renewals failed through the subscription's last hour. The thread's enable
  // replaces it while this renewal attempt is still waiting on Google, and then that attempt fails.
  vi.setSystemTime(Date.now() + 4 * 3_600_000);
  try {
    const renewal = runDurableObjectAlarm(driver());
    await vi.waitFor(() => expect(google.stallGet!.started).toBe(true));
    google.subscriptionId = "replacement";
    await thread.hooks.chatEnableHook();
    google.stallGet.released = true;
    await renewal;
  } finally {
    vi.useRealTimers();
  }

  await push("replacement", [chatMessage("bob")]);
  await deliver();
  expect((await ada.hooks.readHook()).received).toHaveLength(1);
});

it("renews at once a subscription that a re-enabled hook finds past its renewal time", async () => {
  mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();
  await ada.hooks.chatDisableHook();

  // With no hook left, the 3-hour renewal lets the subscription run out its last hour instead.
  vi.setSystemTime(Date.now() + 3 * 3_600_000);
  try {
    await runDurableObjectAlarm(driver());
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await ada.hooks.chatEnableHook();
    const wake = await runInDurableObject(driver(),
      (_instance: unknown, state: DurableObjectState) => state.storage.getAlarm());
    expect(wake).toBeLessThanOrEqual(Date.now());
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to enable a hook whose subscription Google attributes to a different account, and deletes it", async () => {
  const google = mockGoogle();
  const ada = await connect("ada");
  google.authority = "mallory";

  await expect(Promise.resolve(ada.hooks.chatEnableHook())).rejects.toThrow(/different Google account/);
  expect(google.deleted).toEqual(["subscriptions/ada"]);
});

it("rejects pushes not signed for this endpoint by the configured service account", async () => {
  mockGoogle();
  const ada = await connect("ada");
  await ada.hooks.chatEnableHook();

  expect(await push("ada", [chatMessage("bob")], {audience: "https://elsewhere.example/pubsub"})).toBe(401);
  expect(await push("ada", [chatMessage("bob")], {email: "someone@test.iam.gserviceaccount.com"})).toBe(401);
  expect((await SELF.fetch(PUSH_URL, {method: "POST", body: "{}"})).status).toBe(401);
  await deliver();

  expect((await ada.hooks.readHook()).received).toEqual([]);
});
