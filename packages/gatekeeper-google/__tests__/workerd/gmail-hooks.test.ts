// Gmail new-message hooks, end to end inside the gatekeeper worker: a facet restored the way the
// Overseer restores it binds the hook, TestHooks enables it and answers each firing, and Gmail is
// the fetch mock below, reached by signed Pub/Sub pushes through the worker's own fetch handler.

import {env} from "cloudflare:workers";
import {SELF, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {SignJWT, exportJWK, generateKeyPair} from "jose";
import {afterEach, beforeAll, beforeEach, expect, it, vi} from "vitest";
import type {GmailGatekeeperImplProps} from "../../src/gmail";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GmailGatekeeperImpl: DurableObjectNamespace;
  GmailHookDriver: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
  UserAccount: DurableObjectNamespace;
};

// Each test watches a fresh mailbox, so that no other test's hooks share its driver.
let MAILBOX: string;
const PUSH_ACCOUNT = "push@test.iam.gserviceaccount.com";
const OTHER_ACCOUNT = "other@example.com";
const PUSH_URL = "http://localhost:8787/gatekeeper/google/pubsub";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLIENTS_LABEL = {id: "Label_7", name: "Clients", type: "user"};

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
  MAILBOX = `${crypto.randomUUID()}@example.com`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Holds a Gmail response until released. Both sides poll, because a promise settled across
 * Durable Objects moves its waiter's I/O to the settler.
 */
type Gate = {started: boolean; released: boolean};

async function pass(gate: Gate | undefined): Promise<void> {
  if (!gate || gate.released) return;
  gate.started = true;
  await vi.waitFor(() => expect(gate.released).toBe(true), {timeout: 10_000, interval: 5});
}

type MockMessage = {id: string; threadId: string; labelIds: string[]; subject: string};

/** Gmail, for one mailbox that every connection reads. */
type MockGmail = {
  /** The address users.getProfile reports, as a reconnect to another account would change it. */
  profileEmail: string;
  historyId: number;
  /** messageAdded records, with the labels each message arrived with. */
  records: Array<{id: string; message: {id: string; threadId: string; labelIds?: string[]}}>;
  messages: Map<string, MockMessage>;
  watches: number;
  /** Statuses the next users.watch calls fail with. */
  watchFailures: number[];
  /** Make history.list answer 404, as for a start history ID too old to read from. */
  historyExpired: boolean;
  /** Holds the next history.list response until released. */
  holdHistory?: Gate;
  /** Holds the next users.getProfile response until released. */
  holdProfile?: Gate;
  /** Access tokens that belong to another Google account, as a reconnect to one leaves them. */
  otherAccountTokens: Set<string>;
  /** Once the next users.getProfile answers, its connection is reconnected to another account. */
  reconnectAfterProfile: boolean;
  /** Every Gmail API request, as `METHOD /path` below `users/me`. */
  requests: string[];
};

function mockGmail(): MockGmail {
  const gmail: MockGmail = {
    profileEmail: MAILBOX, historyId: 1000, records: [], messages: new Map(), watches: 0,
    watchFailures: [], historyExpired: false, otherAccountTokens: new Set(), reconnectAfterProfile: false,
    requests: [],
  };
  const metadata = ({id, threadId, labelIds, subject}: MockMessage) => ({
    id, threadId, labelIds, internalDate: String(Date.now()), sizeEstimate: 100,
    payload: {headers: [
      {name: "From", value: "Bob <bob@example.com>"}, {name: "To", value: MAILBOX},
      {name: "Subject", value: subject}, {name: "Message-ID", value: `<${id}@example.com>`},
    ]},
  });
  const take = (hold: "holdHistory" | "holdProfile") => {
    const gate = gmail[hold];
    gmail[hold] = undefined;
    return pass(gate);
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const token = new Headers(init.headers).get("Authorization") ?? "";
    const otherAccount = gmail.otherAccountTokens.has(token);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return json(jwks);
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      return json(otherAccount
        ? {sub: "other-subject", email: OTHER_ACCOUNT}
        : {sub: "account-subject", email: MAILBOX});
    }
    if (url.hostname !== "gmail.googleapis.com" || !url.pathname.startsWith("/gmail/v1/users/me/")) {
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    const path = url.pathname.slice("/gmail/v1/users/me".length);
    gmail.requests.push(`${method} ${path}`);
    // Another account's history doesn't reach this mailbox's history IDs, nor its messages.
    if (otherAccount) {
      return path === "/profile"
        ? json({emailAddress: OTHER_ACCOUNT, historyId: "1"})
        : json({error: {code: 404}}, 404);
    }
    if (path === "/profile") {
      // The history ID is read before any hold, as Gmail fixes it when it answers.
      const historyId = String(gmail.historyId);
      await take("holdProfile");
      if (gmail.reconnectAfterProfile) {
        gmail.reconnectAfterProfile = false;
        gmail.otherAccountTokens.add(token);
      }
      return json({emailAddress: gmail.profileEmail, historyId});
    }
    if (path === "/watch" && method === "POST") {
      gmail.watches++;
      const status = gmail.watchFailures.shift();
      if (status !== undefined) return json({error: {code: status}}, status);
      return json({historyId: String(gmail.historyId), expiration: String(Date.now() + 7 * 24 * HOUR)});
    }
    if (path === "/history") {
      await take("holdHistory");
      if (gmail.historyExpired) return json({error: {code: 404}}, 404);
      const start = BigInt(url.searchParams.get("startHistoryId")!);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const pageSize = Number(url.searchParams.get("maxResults"));
      const after = gmail.records.filter(record => BigInt(record.id) > start);
      return json({
        history: after.slice(offset, offset + pageSize)
          .map(record => ({id: record.id, messagesAdded: [{message: record.message}]})),
        historyId: String(gmail.historyId),
        ...(offset + pageSize < after.length ? {nextPageToken: String(offset + pageSize)} : {}),
      });
    }
    if (path === "/labels") {
      return json({labels: [
        ...["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "CATEGORY_PERSONAL"]
          .map(id => ({id, name: id, type: "system"})),
        CLIENTS_LABEL,
      ]});
    }
    const message = /^\/messages\/([a-f0-9]+)$/.exec(path)?.[1];
    if (message !== undefined) {
      const found = gmail.messages.get(message);
      return found ? json(metadata(found)) : json({error: {code: 404}}, 404);
    }
    const thread = /^\/threads\/([a-f0-9]+)$/.exec(path)?.[1];
    if (thread !== undefined) {
      return json({id: thread, messages: [...gmail.messages.values()]
        .filter(candidate => candidate.threadId === thread).map(metadata)});
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return gmail;
}

let nextMessage = 0;

/**
 * A new message lands in the mailbox, carrying `labelIds` now. Its history record says it arrived
 * with `arrivedWith`, which defaults to the same labels; `null` leaves them out of the record.
 */
function arrive(gmail: MockGmail, {threadId, labelIds = ["INBOX", "UNREAD"], arrivedWith}: {
  threadId?: string; labelIds?: string[]; arrivedWith?: string[] | null;
} = {}): string {
  const n = ++nextMessage;
  const id = `aa${n}`;
  const message = {id, threadId: threadId ?? `bb${n}`, labelIds, subject: `Hello ${n}`};
  gmail.historyId += 3;
  gmail.messages.set(id, message);
  const recorded = arrivedWith === undefined ? labelIds : arrivedWith;
  gmail.records.push({id: String(gmail.historyId), message: {
    id, threadId: message.threadId, ...(recorded === null ? {} : {labelIds: recorded}),
  }});
  return id;
}

/** One connection to the mailbox, its hook subscribed through the restored facet. */
async function connect(binding: {labelName?: string; searchQuery?: string; threadId?: string} = {}) {
  const name = `gmail-hooks-${crypto.randomUUID()}`;
  const userObject = testEnv.UserAccount.get(testEnv.UserAccount.idFromName(name));
  await runInDurableObject(userObject, (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
    // Valid for a week, so faking the clock forward to a renewal needs no token refresh.
    state.storage.kv.put("accessToken", {token: `access-token-${name}`, expires: new Date(Date.now() + 7 * 24 * HOUR)});
  });
  const {threadId, ...resource} = binding;
  const props: GmailGatekeeperImplProps = {userObjectId: userObject.id.toString(), ...resource};
  const hooks = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const facet = {facetName: `gmail-${name}`, id: testEnv.GmailGatekeeperImpl.idFromName(name).toString(), props};
  await hooks.gmailSubscribe(facet, threadId);
  return {hooks, ...facet};
}

/** Enable a connection's hook and wait for the driver to finish what that started. */
async function enable(connection: {hooks: DurableObjectStub<TestHooks>}): Promise<void> {
  await connection.hooks.chatEnableHook();
  await settled();
}

async function push(gmail: MockGmail, {
  data = btoa(JSON.stringify({emailAddress: MAILBOX, historyId: gmail.historyId})),
}: {data?: string} = {}): Promise<number> {
  const token = await new SignJWT({email: PUSH_ACCOUNT, email_verified: true})
    .setProtectedHeader({alg: "RS256", kid: "test"})
    .setIssuer("https://accounts.google.com").setAudience(PUSH_URL)
    .setIssuedAt().setExpirationTime("5m")
    .sign(signingKey);
  const response = await SELF.fetch(PUSH_URL, {
    method: "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify({message: {data}}),
  });
  return response.status;
}

const driver = () => testEnv.GmailHookDriver.get(testEnv.GmailHookDriver.idFromName(MAILBOX));

const driverStorage = <T>(key: string) => runInDurableObject(driver(),
  (_instance: unknown, state: DurableObjectState) => state.storage.kv.get<T>(key));

/**
 * Wait until the driver has no history read or delivery due: its own alarm runs them, and forcing
 * that alarm here as well would run it twice concurrently.
 */
const settled = () => vi.waitFor(() => runInDurableObject(driver(), (_instance: unknown, state: DurableObjectState) => {
  const now = Date.now();
  const due = [...state.storage.kv.list<{at?: number}>({prefix: "msg:"})].filter(([, row]) => row.at! <= now);
  const syncAt = state.storage.kv.get<number>("syncAt");
  if (due.length > 0 || (syncAt !== undefined && syncAt <= now)) throw new Error("The driver is still busy.");
}), {timeout: 5_000});

/** Run the driver's alarm on a clock `ms` ahead, which the runtime won't wake it for. */
async function later(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await runDurableObjectAlarm(driver());
}

const receivedIds = async (connection: {hooks: DurableObjectStub<TestHooks>}) =>
  (await connection.hooks.readGmailHook()).received.map(info => info.id).toSorted();

it("delivers each new inbox message once, and the hook's reply is queued for approval", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  await ada.hooks.setGmailHookBehavior({reply: "On it."});

  const message = arrive(gmail);
  const subject = gmail.messages.get(message)!.subject;
  expect(await push(gmail)).toBe(204);
  // Pub/Sub may push twice, and a later read may cover history already read.
  expect(await push(gmail)).toBe(204);
  await settled();
  await runInDurableObject(driver(), (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("cursor", "1000");
  });
  await push(gmail);
  await settled();

  const hook = await ada.hooks.readGmailHook();
  expect(hook.received.map(info => [info.id, info.subject])).toEqual([[message, subject]]);
  expect(hook.observations).toContainEqual(expect.objectContaining({title: `New Gmail message: ${subject}`}));
  expect(hook.submissions).toHaveLength(1);
});

it("never delivers sent mail, drafts, spam or trash, nor mail that skipped the inbox", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);

  for (const labelIds of [["SENT"], ["INBOX", "SENT"], ["DRAFT"], ["SPAM"], ["TRASH"], ["CATEGORY_PERSONAL"]]) {
    arrive(gmail, {labelIds});
  }
  // The facet decides on the labels a message has when delivered, whatever it arrived with.
  arrive(gmail, {labelIds: ["SPAM"], arrivedWith: null});
  arrive(gmail, {labelIds: ["TRASH"], arrivedWith: ["INBOX"]});
  const inbox = arrive(gmail);
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual([inbox]);
});

it("a thread's hook receives only that thread's new messages, in the inbox or not", async () => {
  const gmail = mockGmail();
  arrive(gmail, {threadId: "cc1"});
  const ada = await connect({threadId: "cc1"});
  await enable(ada);

  const archived = arrive(gmail, {threadId: "cc1", labelIds: ["CATEGORY_PERSONAL"]});
  arrive(gmail);
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual([archived]);
});

it("a label binding's hook receives only new mail carrying the label", async () => {
  const gmail = mockGmail();
  const ada = await connect({labelName: "Clients"});
  await enable(ada);

  arrive(gmail);
  const labeledInbox = arrive(gmail, {labelIds: ["INBOX", CLIENTS_LABEL.id]});
  const labeled = arrive(gmail, {labelIds: [CLIENTS_LABEL.id]});
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual([labeledInbox, labeled].toSorted());
});

it.each(["SPAM", "TRASH"])("never delivers from a %s label binding, even when the history omits labels", async label => {
  const gmail = mockGmail();
  const ada = await connect({labelName: label});
  await enable(ada);

  const message = arrive(gmail, {labelIds: [label], arrivedWith: null});
  await push(gmail);
  await settled();

  // The driver can't prefilter it, so only the facet's check keeps it from the hook.
  expect(gmail.requests).toContain(`GET /messages/${message}`);
  expect(await receivedIds(ada)).toEqual([]);
});

it("refuses to subscribe a search binding", async () => {
  mockGmail();
  await expect(connect({searchQuery: "from:bob"})).rejects.toThrow("search binding can't be watched");
});

it("shares one watch between a mailbox's hooks, renews it daily, and retries a failed renewal hourly", async () => {
  const gmail = mockGmail();
  await enable(await connect());
  await enable(await connect());
  expect(gmail.watches).toBe(1);

  await later(24 * HOUR);
  expect(gmail.watches).toBe(2);

  gmail.watchFailures = [503];
  await later(24 * HOUR);
  expect(gmail.watches).toBe(3);
  await later(HOUR);
  expect(gmail.watches).toBe(4);
});

it("doesn't deliver mail that arrived before the hook was enabled", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  const bob = await connect();
  const before = arrive(gmail);
  await enable(bob);

  const after = arrive(gmail);
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual([before, after].toSorted());
  expect(await receivedIds(bob)).toEqual([after]);
});

it("delivers mail whose push never came from the hourly history read", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);

  const message = arrive(gmail);
  await later(HOUR + MINUTE);

  expect(await receivedIds(ada)).toEqual([message]);
});

it("watches from now once Gmail can't read the history since its cursor", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);

  gmail.historyExpired = true;
  arrive(gmail);
  await push(gmail);
  await settled();
  expect(await receivedIds(ada)).toEqual([]);
  expect(await driverStorage("cursor")).toBe(String(gmail.historyId));

  gmail.historyExpired = false;
  const later = arrive(gmail);
  await push(gmail);
  await settled();
  expect(await receivedIds(ada)).toEqual([later]);
});

it("retries a failing hook, and disabling it ends the retries even if it is re-enabled first", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  await ada.hooks.setGmailHookBehavior({failures: 1});

  const retried = arrive(gmail);
  await push(gmail);
  await settled();
  expect(await receivedIds(ada)).toEqual([]);
  await later(MINUTE);
  vi.useRealTimers();
  expect(await receivedIds(ada)).toEqual([retried]);

  await ada.hooks.setGmailHookBehavior({failures: 1});
  arrive(gmail);
  await push(gmail);
  await settled();
  await ada.hooks.chatDisableHook();
  await enable(ada);
  await later(MINUTE);
  expect(await ada.hooks.readGmailHook()).toMatchObject({failures: 0, received: [{id: retried}]});
});

it("refuses a mailbox that now reports another address, retrying its history read only hourly", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  const bob = await connect();
  gmail.profileEmail = "someone-else@example.com";

  await expect(Promise.resolve(bob.hooks.chatEnableHook())).rejects.toThrow("now reads a different address");
  arrive(gmail);
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual([]);
  expect(await driverStorage<number>("syncAt")).toBeGreaterThan(Date.now() + 50 * MINUTE);
});

it("keeps the history cursor when a connection reconnects to another account mid-read", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  const bob = await connect();
  await enable(bob);
  const message = arrive(gmail);

  // The connection that reads the profile is reconnected before the history read that follows.
  gmail.reconnectAfterProfile = true;
  await push(gmail);
  await settled();
  // The retry reads with the connection that still reaches the mailbox.
  await later(5 * MINUTE);

  expect([...await receivedIds(ada), ...await receivedIds(bob)]).toEqual([message]);
});

it("acknowledges pushes it can't use without reading Gmail", async () => {
  const gmail = mockGmail();
  expect(await push(gmail)).toBe(204);
  expect(await push(gmail, {data: btoa("not json")})).toBe(204);
  expect(await push(gmail, {data: "%%% not base64"})).toBe(204);
  expect(await push(gmail, {data: btoa(JSON.stringify({emailAddress: "nobody", historyId: 5}))})).toBe(204);
  expect(gmail.requests).toEqual([]);
});

it("explains a watch Gmail refuses for the deployment's Pub/Sub topic", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  gmail.watchFailures = [400];
  await expect(Promise.resolve(ada.hooks.chatEnableHook())).rejects.toThrow(
    /\[http=400\].*gmail-api-push@system\.gserviceaccount\.com/);
});

it("delivers a burst larger than one alarm run delivers", async () => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);

  const burst = Array.from({length: 25}, () => arrive(gmail));
  await push(gmail);
  await settled();

  expect(await receivedIds(ada)).toEqual(burst.toSorted());
});

it.each([
  ["after the history read finishes", ["history", "profile"]],
  ["before the history read finishes", ["profile", "history"]],
] as const)("delivers mail to a hook whose enable finishes %s that read the mail", async (_, order) => {
  const gmail = mockGmail();
  const ada = await connect();
  await enable(ada);
  const bob = await connect();

  // A push starts a history read, which Gmail holds.
  const history: Gate = gmail.holdHistory = {started: false, released: false};
  await push(gmail, {data: btoa(JSON.stringify({emailAddress: MAILBOX, historyId: gmail.historyId + 1}))});
  await vi.waitFor(() => expect(history.started).toBe(true));
  // Bob's enable reads the history ID it starts from, then waits.
  const profile: Gate = gmail.holdProfile = {started: false, released: false};
  const enabling = bob.hooks.chatEnableHook();
  await vi.waitFor(() => expect(profile.started).toBe(true));
  const message = arrive(gmail);

  for (const held of order) {
    if (held === "history") {
      history.released = true;
      await vi.waitFor(async () => expect(await driverStorage("cursor")).toBe(String(gmail.historyId)));
    } else {
      profile.released = true;
      await enabling;
    }
  }
  await settled();

  expect(await receivedIds(ada)).toEqual([message]);
  expect(await receivedIds(bob)).toEqual([message]);
});
