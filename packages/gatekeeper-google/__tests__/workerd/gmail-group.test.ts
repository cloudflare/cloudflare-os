// A Google Group binding, inside the gatekeeper worker: the owner's mailbox and Cloud Identity are
// the fetch mock below, and members open it through a real GoogleVerifier with their own token.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ActionKind, Cursor, ResourceDescription} from "@gadgets/workshop-shared/gatekeeper";
import type {GmailGatekeeperImplProps} from "../../src/gmail";
import type {
  GmailAttachment, GmailGroupMessage, GmailGroupMessageInfo, GmailGroupSession, GmailGroupThread, GmailGroupThreadEntry,
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
/** Authenticated as from the group's own domain: a colleague's mail. */
const INSIDE_PASS = "mx.google.com; dmarc=pass (p=REJECT) header.from=example.com";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

type Message = {
  id: string; threadId: string; arrived: number; headers: Array<[string, string]>; labelIds?: string[];
  /** Headers in a shape the metadata parser can't read. */
  malformed?: boolean;
  /** The text of a file attached as `notes.txt`. */
  attachment?: string;
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
  direct("a3", "f2", day("2026-06-01"), "Bea <bea@example.com>", GROUP, "Venue", INSIDE_PASS),
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
  /** When Cloud Identity says the group was created. */
  groupCreated: string;
  /** Addresses the group also answers at. */
  groupAliases: string[];
  /** Whether the group has been deleted since. */
  groupDeleted?: boolean;
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
  /** How many times an attachment's bytes were fetched. */
  attachmentReads: number;
};

function harness(binding: Pick<GmailGatekeeperImplProps, "groupOutsideSenders"> = {}) {
  const backend: Backend = {
    members: new Set(), groupAddress: GROUP, groupCreated: "2020-01-01T00:00:00Z", groupAliases: [], identityRequests: 0, accountRequests: 0,
    extra: [], threads: new Map(), observerVerified: true, queries: [], attachmentReads: 0,
  };
  const mailbox = () => [...MAILBOX, ...backend.extra];
  const base64Url = (text: string) => btoa(text).replaceAll("+", "-").replaceAll("/", "_");
  const body = (message: Message) => ({size: 5, data: base64Url(`Body of ${message.id}`)});
  const raw = (message: Message, full: boolean) => ({
    id: message.id, threadId: message.threadId, labelIds: message.labelIds ?? ["INBOX"],
    internalDate: String(message.arrived), snippet: `Opening words of ${message.id}`,
    payload: {
      mimeType: !full ? undefined : message.attachment === undefined ? "text/plain" : "multipart/mixed",
      headers: message.malformed ? {} : message.headers.map(([name, value]) => ({name, value})),
      ...(!full ? {} : message.attachment === undefined ? {body: body(message)} : {parts: [
        {partId: "0", mimeType: "text/plain", body: body(message)},
        {
          partId: "1", mimeType: "text/plain", filename: "notes.txt",
          headers: [{name: "Content-Disposition", value: 'attachment; filename="notes.txt"'}],
          body: {attachmentId: "abc1", size: message.attachment.length},
        },
      ]}),
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
        if (backend.groupDeleted) return json({error: {code: 404}}, 404);
        return json({
          name: GROUP_NAME, groupKey: {id: backend.groupAddress}, displayName: "Team",
          additionalGroupKeys: backend.groupAliases.map(alias => ({id: alias})),
          labels: {"cloudidentity.googleapis.com/groups.discussion_forum": ""},
          createTime: backend.groupCreated,
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
      const attachment = /^\/messages\/(\w+)\/attachments\/abc1$/.exec(path);
      if (attachment) {
        backend.attachmentReads++;
        const found = mailbox().find(candidate => candidate.id === attachment[1]);
        return found?.attachment === undefined
          ? json({error: {code: 404}}, 404)
          : json({size: found.attachment.length, data: base64Url(found.attachment)});
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
    userObjectId: testEnv.UserAccount.idFromName(name).toString(), groupAddress: GROUP, ...binding,
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
      id: "f1", subject: "Launch notes", messageCount: 1, latestMessageId: "a1", snippet: "Opening words of a1",
      timestamp: new Date(day("2026-03-01")), participants: [{address: "ada@example.net", name: "Ada"}, {address: GROUP}],
    });
    expect(JSON.stringify(threads)).not.toMatch(/cy@example\.org|just between us|whole thread|Opening words of a2|INBOX|hidden@/);
    expect(gmail.backend.queries[0]).toBe(
      `{list:${GROUP} to:${GROUP} cc:${GROUP} bcc:${GROUP}} -in:drafts`);

    using thread = await session.getThread("f1") as GmailGroupThread & Disposable;
    using messages = await thread.messages() as never as Array<{info: GmailGroupMessageInfo}> & Disposable;
    expect(messages.map(entry => entry.info.id)).toEqual(["a1"]);
    expect(Object.keys(messages[0].info).toSorted()).toEqual(["cc", "from", "id", "snippet", "subject", "threadId", "timestamp", "to"]);

    for (const observation of await gmail.observations()) {
      // Shared by membership alone: as a mailbox's reads, the group's leave auto-approval on.
      expect(observation).toMatchObject({subresources: [GROUP_SUBRESOURCE]});
      expect(observation).not.toHaveProperty("containsRestrictedData");
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

  it("shows mail from outside the group's domain that only names the group as a reply, never on its own", async () => {
    const gmail = harness();
    // Sent to the owner alone with the group typed in To: the group never delivered it.
    gmail.backend.extra.push(
      direct("b1", "f5", day("2026-06-04"), "Dan <dan@example.org>", GROUP, "Read this"),
      {...direct("b2", "f1", day("2026-03-04"), "Dan <dan@example.org>", OWNER, "Re: Launch notes"),
        headers: [["Authentication-Results", DMARC_PASS], ["From", "Dan <dan@example.org>"], ["Reply-To", "Desk <desk@example.org>"],
          ["To", OWNER], ["Cc", GROUP], ["Subject", "Re: Launch notes"]]});
    using session = await gmail.session();

    const threads = await drain(await session.listThreads() as never);
    expect(threads.map(thread => thread.id)).toEqual(["f2", "f1", "f4"]);
    expect(threads[1]).toMatchObject({messageCount: 2, latestMessageId: "b2", snippet: "Opening words of b2"});
    await expect(Promise.resolve(session.getMessage("b1"))).rejects.toThrow("This isn't one of the group's messages.");
    await expect(Promise.resolve(session.getThread("f5"))).rejects.toThrow("This isn't one of the group's messages.");

    using reply = await session.getMessage("b2") as GmailGroupMessage & Disposable;
    expect(await reply.getMetadata()).toMatchObject({
      from: {address: "dan@example.org", name: "Dan"}, replyTo: [{address: "desk@example.org", name: "Desk"}],
    });
    expect(await reply.getContent()).toEqual({text: "Body of b2"});

    expect(await gmail.screen("b1")).toBe(false);
    expect(await gmail.deliver("b1")).toEqual([]);
    expect(await gmail.screen("b2")).toBe(true);
    expect(await gmail.deliver("b2")).toMatchObject([{id: "b2"}]);

    // Once the conversation's own message is gone, the reply is nobody's again.
    gmail.backend.threads.set("f1", [
      {...MAILBOX[0], labelIds: ["TRASH"]}, gmail.backend.extra[1],
    ]);
    await expect(Promise.resolve(reply.getContent())).rejects.toThrow("This isn't one of the group's messages.");
  });

  it("shows outside mail that names the group at once on a binding that takes any, hooks included", async () => {
    const gmail = harness({groupOutsideSenders: true});
    gmail.backend.extra.push(
      direct("b1", "f5", day("2026-06-04"), "Dan <dan@example.org>", GROUP, "Feedback"),
      direct("b4", "f6", day("2026-06-05"), "Dan <dan@example.org>", OWNER, "Just for you"));
    using session = await gmail.session();

    const threads = await drain(await session.listThreads() as never);
    expect(threads.map(thread => thread.id)).toEqual(["f5", "f2", "f1", "f4"]);
    expect(await gmail.screen("b1")).toBe(true);
    expect(await gmail.deliver("b1")).toMatchObject([{id: "b1", subject: "Feedback"}]);
    // Still only authenticated mail that names the group.
    for (const id of ["b4", "a2", "a4"]) {
      expect(await gmail.screen(id), id).toBe(false);
      await expect(Promise.resolve(session.getMessage(id)), id).rejects.toThrow("This isn't one of the group's messages.");
    }
    expect(await gmail.describe()).toMatchObject({
      url: "https://groups.google.com/a/example.com/g/team?senders=anyone",
    });
  });

  it("shows nothing that arrived before the group was created, at an address an earlier group had", async () => {
    const gmail = harness();
    gmail.backend.groupCreated = "2026-05-01T00:00:00Z";
    using session = await gmail.session();
    const threads = await drain(await session.listThreads() as never);
    expect(threads.map(thread => thread.id)).toEqual(["f2"]);
    await expect(Promise.resolve(session.getMessage("a1"))).rejects.toThrow("This isn't one of the group's messages.");
    expect(await gmail.screen("a1")).toBe(false);
  });

  it("reports the group before telling its name", async () => {
    const gmail = harness();
    using session = await gmail.session();
    expect(await session.getGroupAddress()).toEqual({address: GROUP, name: "Team"});
    expect(await gmail.observations()).toMatchObject([
      {subresources: [GROUP_SUBRESOURCE]},
    ]);
  });

  it("reads an attachment only while its message is still the group's", async () => {
    const gmail = harness();
    const filed = {...delivered("b3", "f5", day("2026-06-05"), "Notes attached"), attachment: "Agenda"};
    gmail.backend.extra.push(filed);
    using session = await gmail.session();
    using message = await session.getMessage("b3") as GmailGroupMessage & Disposable;
    using attachments = await message.attachments() as never as
      Array<{info: {filename?: string; size: number}; attachment: GmailAttachment}> & Disposable;
    expect(attachments.map(entry => entry.info)).toMatchObject([{filename: "notes.txt", size: 6}]);
    const [{attachment}] = attachments;

    expect(new TextDecoder().decode(await attachment.getContent())).toBe("Agenda");
    await expect(Promise.resolve(attachment.readPdf())).rejects.toThrow("This attachment is not a PDF.");
    for (const observation of await gmail.observations()) {
      expect(observation).toMatchObject({subresources: [GROUP_SUBRESOURCE]});
    }

    // The owner bins the message: a capability handed out before reads nothing more of it.
    filed.labelIds = ["TRASH"];
    const reads = gmail.backend.attachmentReads;
    for (const read of [() => attachment.getMetadata(), () => attachment.getContent()]) {
      await expect(Promise.resolve(read())).rejects.toThrow("This isn't one of the group's messages.");
    }
    expect(gmail.backend.attachmentReads).toBe(reads);
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

  it("stops a cursor opened before the group's addresses changed", async () => {
    const gmail = harness();
    using session = await gmail.session();
    using cursor = await session.listThreads() as never as Cursor<GmailGroupThreadEntry> & Disposable;

    // The group is renamed, and its old address may be another group's by now.
    gmail.backend.groupAddress = "renamed@example.com";
    await expect(Promise.resolve(cursor.next())).rejects.toThrow("The connected Google Group's addresses have changed.");

    gmail.backend.groupAddress = GROUP;
    gmail.backend.groupAliases = ["crew@example.com"];
    using again = await session.listThreads() as never as Cursor<GmailGroupThreadEntry> & Disposable;
    await expect(Promise.resolve(again.next())).rejects.toThrow("The connected Google Group's addresses have changed.");
  });

  it("starts no firing, and retries nothing, for a group that has been deleted", async () => {
    const gmail = harness();
    (await gmail.session())[Symbol.dispose]();
    gmail.backend.groupDeleted = true;

    // The delivery finds the group gone and takes the message as nobody's, rather than failing to be tried again.
    expect(await gmail.deliver("a1")).toEqual([]);
    const {identityRequests} = gmail.backend;
    expect(await gmail.screen("a1")).toBe(false);
    expect(gmail.backend.identityRequests).toBe(identityRequests);
    await expect(gmail.session()).rejects.toThrow("The connected Google Group no longer exists.");
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
