// A Google Group binding, inside the gatekeeper worker: the owner's mailbox and Cloud Identity are
// the fetch mock below, and members open it through a real GoogleVerifier with their own token.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ActionKind, Cursor, ResourceDescription} from "@gadgets/workshop-shared/gatekeeper";
import type {GmailGatekeeperImplProps} from "../../src/gmail";
import type {
  GmailGroupMessage, GmailGroupMessageInfo, GmailGroupSession, GmailGroupThread, GmailGroupThreadEntry,
  GmailGroupThreadInfo,
} from "../../src/types";

type TestHooks = {
  startSession(facetName: string, id: string, props: GmailGatekeeperImplProps, queueId: string): Promise<void>;
  openGmailSession(facetName: string, id: string, props: GmailGatekeeperImplProps, queueId: string):
    Promise<GmailGroupSession & Disposable>;
  gmailVerifyObserverAccess(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      observers: Array<{id: string; userObjectId: string}>, subresources: string[],
  ): Promise<{allowedObserverIds: string[]}>;
  gmailDeliverOnce(
      facetName: string, id: string, props: GmailGatekeeperImplProps, queueId: string,
      messageId: string): Promise<GmailGroupMessageInfo[]>;
  gmailScreen(facetName: string, id: string, props: GmailGatekeeperImplProps, messageId: string): Promise<boolean>;
  describe(facetName: string, id: string, props: GmailGatekeeperImplProps): Promise<ResourceDescription>;
  getAutoApprovableActions(facetName: string, id: string, props: GmailGatekeeperImplProps):
    Promise<ActionKind[]>;
  readQueue(queueId: string): Promise<{observations: unknown[]}>;
};

const testEnv = env as unknown as {
  GmailGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace;
};

const GROUP = "team@example.com";
const GROUP_NAME = "groups/0abc123";
/** What every read of the group reports, and a member's own account is checked against. */
const GROUP_SUBRESOURCE = "gmail/group/0abc123";
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const BOUNCE = "team+bncabc123@example.com";
const SIGNATURE = "J1MSAw4BYwbhRuTjoELVtm2BX1xZDrrrPB2pXf";
const DMARC_PASS = "mx.google.com; dmarc=pass (p=REJECT) header.from=example.org";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

type Message = {
  id: string; threadId: string; arrived: number; headers: Array<[string, string]>; labelIds?: string[];
  /** Headers in a shape the metadata parser can't read. */
  malformed?: boolean;
};

/** A copy Google Groups delivered. */
const delivered = (id: string, threadId: string, arrived: number, subject: string): Message => ({
  id, threadId, arrived, headers: [
    ["Return-Path", `<${BOUNCE}>`],
    ["Authentication-Results",
      `mx.google.com; dkim=pass header.i=@example.com header.b=J1MSAw4B; spf=pass smtp.mailfrom=${BOUNCE}`],
    ["DKIM-Signature", `v=1; d=example.com; s=s1; h=list-id:from:to:subject; b=${SIGNATURE}`],
    ["From", "Ada <ada@example.net>"],
    ["To", GROUP],
    ["Subject", subject],
    ["List-ID", "<team.example.com>"],
  ],
});

/** Mail that reached the owner directly, authenticated as from example.org. */
const direct = (
    id: string, threadId: string, arrived: number, from: string, to: string, subject: string,
    auth = DMARC_PASS): Message => ({
  id, threadId, arrived, headers: [
    ["Authentication-Results", auth], ["From", from], ["To", to], ["Subject", subject],
  ],
});

/**
 * The owner's mailbox: the group's conversations, a private reply in one, a forgery, and the
 * owner's own message to the group with a Bcc members aren't shown.
 */
const MAILBOX: Message[] = [
  delivered("a1", "f1", day("2026-03-01"), "Launch notes"),
  direct("a2", "f1", day("2026-03-02"), "Cy <cy@example.org>", OWNER, "Re: Launch notes, just between us"),
  direct("a3", "f2", day("2026-06-01"), "Bea <bea@example.org>", GROUP, "Venue"),
  direct("a4", "f3", day("2026-06-02"), "Mallory <mallory@example.org>", GROUP, "Forged",
    "mx.google.com; dmarc=fail header.from=example.org"),
  {id: "a5", threadId: "f4", arrived: day("2026-02-01"), labelIds: ["SENT"], headers: [
    ["From", OWNER], ["To", GROUP], ["Bcc", "hidden@example.org"], ["Subject", "Kickoff"],
  ]},
];

type Backend = {
  /** Direct members; anyone else is not one. */
  members: Set<string>;
  /** The group's primary address as Cloud Identity reports it now. */
  groupAddress: string;
  /** Requests made to Cloud Identity, and to Google's account endpoints. */
  identityRequests: number;
  accountRequests: number;
  /** Messages beyond {@link MAILBOX}. */
  extra: Message[];
  /** What Gmail returns for a thread, in place of the messages that carry its ID. */
  threads: Map<string, Message[]>;
  /** Status Cloud Identity's membership lookups answer with, when not 200. */
  membershipFailure?: number;
  /** Which tokens lack the scope Cloud Identity needs. */
  scopeInsufficient?: "owner" | "observer";
  /** Whether Google has verified the observer's address. */
  observerVerified: boolean;
  /** Every Gmail search, as sent. */
  queries: string[];
};

function harness() {
  const backend: Backend = {
    members: new Set(), groupAddress: GROUP, identityRequests: 0, accountRequests: 0,
    extra: [], threads: new Map(), observerVerified: true, queries: [],
  };
  const mailbox = () => [...MAILBOX, ...backend.extra];
  const raw = (message: Message, full: boolean) => ({
    id: message.id, threadId: message.threadId, labelIds: message.labelIds ?? ["INBOX"],
    internalDate: String(message.arrived), snippet: "Gmail's snippet of the whole thread",
    payload: {
      mimeType: full ? "text/plain" : undefined,
      headers: message.malformed ? {} : message.headers.map(([name, value]) => ({name, value})),
      ...(full ? {body: {size: 5, data: btoa(`Body of ${message.id}`).replaceAll("+", "-").replaceAll("/", "_")}} : {}),
    },
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("Authorization") ?? "";
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      backend.accountRequests++;
      return json(token.endsWith("observer-token")
        ? {sub: "member-subject", email: MEMBER, email_verified: backend.observerVerified}
        : {sub: "owner-subject", email: OWNER, email_verified: true});
    }
    if (url.hostname === "cloudidentity.googleapis.com") {
      backend.identityRequests++;
      const who = token.endsWith("observer-token") ? "observer" : "owner";
      if (backend.scopeInsufficient === who) {
        return json({error: {code: 403, details: [{reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}, 403);
      }
      const path = url.pathname.slice("/v1/".length);
      if (path === "groups:lookup") {
        return url.searchParams.get("groupKey.id") === backend.groupAddress
          ? json({name: GROUP_NAME})
          : json({error: {code: 404}}, 404);
      }
      if (path === GROUP_NAME) {
        return json({
          name: GROUP_NAME, groupKey: {id: backend.groupAddress}, displayName: "Team",
          labels: {"cloudidentity.googleapis.com/groups.discussion_forum": ""},
        });
      }
      if (backend.membershipFailure) return json({error: {code: backend.membershipFailure}}, backend.membershipFailure);
      if (path === `${GROUP_NAME}/memberships:lookup`) {
        // A member's own account asks after itself.
        if (who !== "observer") throw new Error("A membership was looked up with the owner's token.");
        const member = url.searchParams.get("memberKey.id")!;
        return backend.members.has(member)
          ? json({name: `${GROUP_NAME}/memberships/${btoa(member).replaceAll("=", "")}`})
          : json({error: {code: 404}}, 404);
      }
    }
    if (url.hostname === "gmail.googleapis.com") {
      const path = url.pathname.slice("/gmail/v1/users/me".length);
      if (path === "/messages") {
        backend.queries.push(url.searchParams.get("q") ?? "");
        // Gmail's own matching is not modelled: every message is a candidate, newest first, and
        // admission alone decides.
        const after = /after:(\d+)/.exec(url.searchParams.get("q") ?? "");
        const messages = mailbox()
          .filter(message => !after || message.arrived > Number(after[1]) * 1000)
          .toSorted((a, b) => b.arrived - a.arrived)
          .map(({id, threadId}) => ({id, threadId}));
        return json({messages});
      }
      const thread = /^\/threads\/(\w+)$/.exec(path);
      if (thread) {
        const messages = backend.threads.get(thread[1]) ?? mailbox().filter(message => message.threadId === thread[1]);
        return messages.length === 0
          ? json({error: {code: 404}}, 404)
          : json({id: thread[1], snippet: "Gmail's snippet of the whole thread", messages: messages.map(message => raw(message, false))});
      }
      const message = /^\/messages\/(\w+)$/.exec(path);
      if (message) {
        const found = mailbox().find(candidate => candidate.id === message[1]);
        return found ? json(raw(found, url.searchParams.get("format") === "full")) : json({error: {code: 404}}, 404);
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const name = `gmail-group-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GmailGatekeeperImpl.idFromName(name).toString();
  const facetName = `gmail-${name}`;
  const props: GmailGatekeeperImplProps = {
    userObjectId: testEnv.UserAccount.idFromName(name).toString(), groupAddress: GROUP,
  };
  const queueId = `queue-${crypto.randomUUID()}`;
  const observerId = testEnv.UserAccount.idFromName(`${name}-observer`);
  const seed = (userObject: DurableObjectId, token: string) =>
    runInDurableObject(testEnv.UserAccount.get(userObject), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", `${token}-refresh`);
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
    });
  const run = <T>(callback: (instance: TestHooks) => T | Promise<T>) =>
    runInDurableObject(hook, callback as never) as Promise<T>;
  const ready = seed(testEnv.UserAccount.idFromName(name), "access-token")
    .then(() => seed(observerId, "observer-token"))
    .then(() => run(instance => instance.startSession(facetName, id, props, queueId)));
  return {
    backend,
    session: () => ready.then(() => (hook as unknown as TestHooks).openGmailSession(facetName, id, props, queueId)),
    /** Whether the observer's own account may read `subresources`, as the Workshop asks. */
    admits: (subresources = [GROUP_SUBRESOURCE]) => ready
      .then(() => (hook as unknown as TestHooks).gmailVerifyObserverAccess(
        facetName, id, props, [{id: "viewer", userObjectId: observerId.toString()}], subresources))
      .then(({allowedObserverIds}) => allowedObserverIds.includes("viewer")),
    screen: (messageId: string) => ready.then(() =>
      (hook as unknown as TestHooks).gmailScreen(facetName, id, props, messageId)),
    deliver: (messageId: string) => ready.then(() =>
      (hook as unknown as TestHooks).gmailDeliverOnce(facetName, id, props, queueId, messageId)),
    describe: () => ready.then(() => run(instance => instance.describe(facetName, id, props))),
    autoApprovable: () => ready.then(() => run(instance => instance.getAutoApprovableActions(facetName, id, props))),
    observations: () => ready.then(() => run(instance => instance.readQueue(queueId))).then(queue => queue.observations),
  };
}

async function drain(cursor: Cursor<GmailGroupThreadEntry> & Disposable): Promise<GmailGroupThreadInfo[]> {
  const infos: GmailGroupThreadInfo[] = [];
  try {
    for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
      for (const entry of page) {
        infos.push(entry.info);
        (entry.thread as unknown as Disposable)[Symbol.dispose]();
      }
    }
  } finally {
    cursor[Symbol.dispose]();
  }
  return infos;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail group binding", () => {
  it("shows only the group's messages, and describes threads by them alone", async () => {
    const gmail = harness();
    using session = await gmail.session();
    const threads = await drain(await session.listThreads() as never);

    expect(threads.map(thread => thread.id)).toEqual(["f2", "f1", "f4"]);
    expect(threads[1]).toEqual({
      id: "f1", subject: "Launch notes", messageCount: 1, latestMessageId: "a1",
      timestamp: new Date(day("2026-03-01")), participants: [{address: "ada@example.net", name: "Ada"}, {address: GROUP}],
    });
    expect(JSON.stringify(threads)).not.toMatch(/cy@example\.org|just between us|snippet|INBOX|hidden@/);
    expect(gmail.backend.queries[0]).toBe(
      `{list:${GROUP} to:${GROUP} cc:${GROUP} bcc:${GROUP}} -in:drafts`);

    using thread = await session.getThread("f1") as GmailGroupThread & Disposable;
    using messages = await thread.messages() as never as Array<{info: GmailGroupMessageInfo}> & Disposable;
    expect(messages.map(entry => entry.info.id)).toEqual(["a1"]);
    expect(Object.keys(messages[0].info).toSorted()).toEqual(["cc", "from", "id", "subject", "threadId", "timestamp", "to"]);

    for (const observation of await gmail.observations()) {
      expect(observation).toMatchObject({containsRestrictedData: true});
    }
  });

  it("reads a message that isn't the group's the same as one that doesn't exist", async () => {
    const gmail = harness();
    using session = await gmail.session();
    for (const id of ["a2", "a4", "ffff"]) {
      await expect(Promise.resolve(session.getMessage(id)), id).rejects.toThrow("This isn't one of the group's messages.");
    }
    await expect(Promise.resolve(session.getThread("f3"))).rejects.toThrow("This isn't one of the group's messages.");
    await expect(Promise.resolve(session.getThread("ffff"))).rejects.toThrow("This isn't one of the group's messages.");

    using message = await session.getMessage("a3") as GmailGroupMessage & Disposable;
    expect(await message.getContent()).toEqual({text: "Body of a3"});
  });

  it("reads a thread that isn't the group's the same however Gmail answers for it", async () => {
    const gmail = harness();
    const forged = (id: string, threadId: string) =>
      direct(id, threadId, day("2026-06-03"), "Mallory <mallory@example.org>", GROUP, "Forged", "none");
    gmail.backend.threads.set("f6", Array.from({length: 1001}, (_, n) => forged(`c${n.toString(16)}`, "f6")));
    gmail.backend.threads.set("f7", [forged("d1", "f8")]);
    gmail.backend.extra.push({...forged("e1", "f9"), malformed: true});
    using session = await gmail.session();
    for (const id of ["f6", "f7", "f9"]) {
      await expect(Promise.resolve(session.getThread(id)), id).rejects.toThrow("This isn't one of the group's messages.");
    }
    await expect(Promise.resolve(session.getMessage("e1"))).rejects.toThrow("This isn't one of the group's messages.");
  });

  it("drops a message whose headers don't parse rather than failing the page", async () => {
    const gmail = harness();
    gmail.backend.extra.push({...delivered("e2", "f1", day("2026-03-03"), "Unreadable"), malformed: true});
    using session = await gmail.session();
    const threads = await drain(await session.listThreads() as never);
    expect(threads.map(thread => thread.id)).toEqual(["f2", "f1", "f4"]);
    expect(threads[1].latestMessageId).toBe("a1");
  });

  it("refuses searches that test the owner's own labels, stars or folders", async () => {
    const gmail = harness();
    using session = await gmail.session();
    for (const query of ["label:secret", "is:starred", "in:sent", "-category:social", "deliveredto:owner@example.com",
      "bcc:someone@example.com", "has:userlabels", "has:yellow-star", "(launch OR label:x)", "x.label:y"]) {
      await expect(Promise.resolve(session.searchThreads(query)), query).rejects.toThrow(/A group search can't use/);
    }
    for (const query of ["from:ada@example.net", "subject:\"label:x\"", "has:attachment newer_than:7d", "venue 10:30"]) {
      (await session.searchThreads(query) as unknown as Disposable)[Symbol.dispose]();
    }
  });

  it("never lists a conversation in search results because of the owner's hidden Bcc", async () => {
    const gmail = harness();
    using session = await gmail.session();
    // The mock matches every message, as a search for the Bcc'd address would match a5.
    const found = await drain(await session.searchThreads("hidden@example.org") as never);
    expect(found.map(thread => thread.id)).toEqual(["f2", "f1"]);
  });

  it("delivers the group's new mail to hooks, and nothing else", async () => {
    const gmail = harness();
    (await gmail.session())[Symbol.dispose]();
    const {identityRequests, accountRequests} = gmail.backend;
    // Screened before a firing starts, so the rest of the mailbox never wakes the workspace.
    expect(await gmail.screen("a3")).toBe(true);
    expect(await gmail.screen("a2")).toBe(false);
    expect(await gmail.screen("a4")).toBe(false);
    expect(await gmail.screen("ffff")).toBe(false);
    // Screening reads the group and mailbox as last resolved: each of the owner's messages costs only its read.
    expect(gmail.backend.identityRequests).toBe(identityRequests);
    expect(gmail.backend.accountRequests).toBe(accountRequests);
    expect(await gmail.deliver("a3")).toMatchObject([{id: "a3", subject: "Venue"}]);
    expect(await gmail.deliver("a2")).toEqual([]);
    expect(await gmail.deliver("a4")).toEqual([]);
  });

  it("describes a read-only binding", async () => {
    const gmail = harness();
    expect(await gmail.describe()).toMatchObject({
      url: "https://groups.google.com/a/example.com/g/team", title: `Google Group: ${GROUP}`, tsType: "GmailGroupSession",
      hookTsType: "GmailGroupMessageHook", suggestedBindingName: "GMAIL_GROUP",
    });
    expect(await gmail.autoApprovable()).toEqual([]);
  });

  it("asks to connect the group again when the account withdrew group access", async () => {
    const gmail = harness();
    gmail.backend.scopeInsufficient = "owner";
    await expect(gmail.session()).rejects.toThrow(
      "This account no longer lets this app see its groups. Connect the group again.");
  });

  it("refuses a group that now answers at another address", async () => {
    const gmail = harness();
    (await gmail.session())[Symbol.dispose]();
    gmail.backend.groupAddress = "renamed@example.com";
    await expect(gmail.session()).rejects.toThrow("The connected Google Group now answers at another address.");
  });
});

describe("Gmail group members", () => {
  it("reports the group on every read, and admits a direct member to it", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    using session = await gmail.session();
    await drain(await session.listThreads() as never);
    const observations = await gmail.observations() as Array<{subresources?: string[]}>;
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) expect(observation.subresources).toEqual([GROUP_SUBRESOURCE]);

    const {identityRequests} = gmail.backend;
    expect(await gmail.admits()).toBe(true);
    // A member's own lookup alone: nothing is asked with the owner's token.
    expect(gmail.backend.identityRequests).toBe(identityRequests + 1);
  });

  it("refuses anyone who isn't a direct member", async () => {
    expect(await harness().admits()).toBe(false);
  });

  it("refuses a member the group hides its members from", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    gmail.backend.membershipFailure = 403;
    expect(await gmail.admits()).toBe(false);
  });

  it("checks nothing but its own group: not the owner's mailbox, nor another product's resource", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    await expect(gmail.admits(["gmail/user/owner-subject"])).rejects.toThrow(/Not a subresource this Gmail binding reports/);
    await expect(gmail.admits([GROUP_SUBRESOURCE, "chat/space/AAAA"])).rejects.toThrow();
    await expect(gmail.admits(["gmail/group/..%2F0abc123"])).rejects.toThrow();
  });

  it("fails the check for an observer whose address Google hasn't verified", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    gmail.backend.observerVerified = false;
    await expect(gmail.admits()).rejects.toThrow(/no verified email address/);
  });

  it("fails the check, saying what to grant, when a member's account hasn't allowed group access", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    gmail.backend.scopeInsufficient = "observer";
    await expect(gmail.admits()).rejects.toThrow(/hasn't let this app see its groups/);
  });

  it("fails closed when Cloud Identity is down", async () => {
    const gmail = harness();
    gmail.backend.members.add(MEMBER);
    gmail.backend.membershipFailure = 503;
    await expect(gmail.admits()).rejects.toThrow(/Cloud Identity memberships.lookup failed/);
  });
});
