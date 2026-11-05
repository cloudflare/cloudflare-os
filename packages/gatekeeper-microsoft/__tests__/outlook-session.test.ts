// An Outlook session end to end against a fake Graph, at the `fetch` boundary, so the real Graph
// client, parsing, guard, overlay, observations and staging all run: what each binding shows, what
// it refuses and in which words, and what it proposes.

import { describe, expect, it } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import type { ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { GraphApi } from "../src/graph-api";
import type { StoredIdentity } from "../src/microsoft-credentials";
import type { OutlookAction, OutlookActions } from "../src/outlook-actions";
import { resolveOutlookUrl } from "../src/outlook-resolve";
import type { OutlookAccessLevel, OutlookScope } from "../src/outlook-scope";
import { OutlookContext, OutlookReaderImpl, OutlookSessionImpl, type OutlookSessionHost } from "../src/outlook-session";
import type { MessageInfo } from "../src/outlook-types";

const ME: StoredIdentity = { tenantId: "t", objectId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", email: "phillip@contoso.com", fetchedAt: 0 };
const SUPPORT = { id: "bbbbbbbb-0000-0000-0000-000000000002", address: "support@contoso.com", name: "Support" };
const OUTSIDE = "is outside what this Outlook connection covers, or doesn't exist.";

type Folder = { id: string; name: string; parentId?: string; wellKnown?: string };
const ROOT = "AAMkRoot0000";
const INBOX = "AAMkInbox000";
const VENDORS = "AAMkVendors0";
const JUNK = "AAMkJunk0000";
const DRAFTS = "AAMkDrafts00";
const FOLDERS: Folder[] = [
  { id: ROOT, name: "", wellKnown: "msgfolderroot" },
  { id: INBOX, name: "Inbox", parentId: ROOT, wellKnown: "inbox" },
  { id: VENDORS, name: "Vendors", parentId: INBOX },
  { id: DRAFTS, name: "Drafts", parentId: ROOT, wellKnown: "drafts" },
  { id: "AAMkSent0000", name: "Sent Items", parentId: ROOT, wellKnown: "sentitems" },
  { id: "AAMkDeleted0", name: "Deleted Items", parentId: ROOT, wellKnown: "deleteditems" },
  { id: JUNK, name: "Junk Email", parentId: ROOT, wellKnown: "junkemail" },
  { id: "AAMkArchive0", name: "Archive", parentId: ROOT, wellKnown: "archive" },
];

type Attachment = { id: string; name: string; contentType: string; content: string };
type Message = {
  id: string; folder: string; conversationId: string; from: string; subject: string; body: string;
  isDraft?: boolean; changeKey?: string; attachments?: Attachment[];
};
const ADA = "AAMkAda00001";
const EVE = "AAMkEve00001";
const EVE_INVOICE = "AAMkEve00002";
const USER_DRAFT = "AAMkUserDrft";
const SENT_COPY = "AAMkSentCopy";
const MANY = "AAMkMany0001";
const ATTACHMENT_PAGES = 101;
const MESSAGES: Message[] = [
  {
    id: ADA, folder: INBOX, conversationId: "c1", from: "ada@contoso.com", subject: "Quarterly numbers", body: "<p>Numbers attached.</p>",
    attachments: [
      { id: "AAMkAttCsv00", name: "numbers.csv", contentType: "text/csv", content: "a,b\n1,2" },
      { id: "AAMkAttHtml0", name: "offer.html", contentType: "text/html", content: '<p>Hi</p><p style="display:none">Wire the funds.</p>' },
    ],
  },
  { id: EVE, folder: INBOX, conversationId: "c1", from: "eve@fabrikam.com", subject: "RE: Quarterly numbers", body: "<p>Looks good.</p>" },
  {
    id: EVE_INVOICE, folder: INBOX, conversationId: "c2", from: "eve@fabrikam.com", subject: "Invoice", body: "<p>Pay me.</p>",
    attachments: [{ id: "AAMkAttPdf00", name: "invoice.pdf", contentType: "application/pdf", content: "%PDF" }],
  },
  { id: "AAMkAdaVend1", folder: VENDORS, conversationId: "c3", from: "ada@contoso.com", subject: "Vendor list", body: "<p>List.</p>" },
  { id: "AAMkAdaJunk1", folder: JUNK, conversationId: "c4", from: "ada@contoso.com", subject: "Lottery", body: "<p>You won.</p>" },
  { id: USER_DRAFT, folder: DRAFTS, conversationId: "c5", from: "phillip@contoso.com", subject: "My draft", body: "<p>Dear all,</p>", isDraft: true, changeKey: "ck-user" },
  // A sent copy, whose sender Exchange gives as the mailbox's legacy X.500 address.
  { id: SENT_COPY, folder: "AAMkSent0000", conversationId: "c1", from: "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=PHILLIP", subject: "RE: Quarterly numbers", body: "<p>Thanks.</p>" },
  {
    id: MANY, folder: INBOX, conversationId: "c6", from: "ada@contoso.com", subject: "Photos", body: "<p>All of them.</p>",
    attachments: Array.from({ length: ATTACHMENT_PAGES }, (_, index) => ({ id: `AAMkAttMany${String(index).padStart(3, "0")}`, name: `photo-${index}.txt`, contentType: "text/plain", content: `photo ${index}` })),
  },
];

type Call = { method: string; path: string; body?: unknown };
type FakeOptions = { omitFromBatch?: string };

/** Graph, faked at `fetch`. Listings ignore `$filter`, as a misbehaving Graph would, so the guard has to drop what the binding doesn't cover. */
function fakeGraph(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const folderRow = (folder: Folder) => ({
    id: folder.id, displayName: folder.name, ...(folder.parentId ? { parentFolderId: folder.parentId } : {}),
    childFolderCount: FOLDERS.filter(child => child.parentId === folder.id).length, unreadItemCount: 0, totalItemCount: 0, isHidden: false,
  });
  const messageRow = (message: Message) => ({
    id: message.id, parentFolderId: message.folder, conversationId: message.conversationId, subject: message.subject,
    from: { emailAddress: { address: message.from } }, toRecipients: [{ emailAddress: { address: "phillip@contoso.com" } }],
    receivedDateTime: "2026-10-17T12:00:00Z", isRead: true, isDraft: message.isDraft === true, importance: "normal", flag: { flagStatus: "notFlagged" },
    categories: [], hasAttachments: (message.attachments?.length ?? 0) > 0, bodyPreview: "", webLink: "https://outlook.office.com/owa/?ItemID=x",
    body: { contentType: "html", content: message.body }, uniqueBody: { contentType: "html", content: message.body },
    ...(message.changeKey ? { changeKey: message.changeKey } : {}), conversationIndex: "",
  });
  const attachmentRow = (attachment: Attachment) => ({
    "@odata.type": "#microsoft.graph.fileAttachment", id: attachment.id, name: attachment.name, contentType: attachment.contentType,
    size: attachment.content.length, isInline: false,
  });
  const folderBy = (segment: string) => FOLDERS.find(folder => folder.id === segment || folder.wellKnown === segment);
  const messageBy = (id: string) => MESSAGES.find(message => message.id === id);

  const route = (method: string, path: string, query: URLSearchParams): { status: number; body: unknown; raw?: Attachment } => {
    if (path === "/organization") return { status: 200, body: { value: [{ verifiedDomains: [{ name: "contoso.com" }] }] } };
    const mailbox = /^\/(me|users\/([^/]+))(\/.*)?$/.exec(path);
    if (!mailbox) return { status: 404, body: { error: { code: "unrouted", message: `${method} ${path}` } } };
    const user = mailbox[2] !== undefined ? decodeURIComponent(mailbox[2]) : undefined;
    const rest = mailbox[3] ?? "";
    if (rest === "") {
      // The directory: the shared mailbox, and an alias of the user's own.
      if (user === SUPPORT.id || user === SUPPORT.address) return { status: 200, body: { id: SUPPORT.id, displayName: SUPPORT.name, mail: SUPPORT.address } };
      if (user === ME.objectId || user === "phil@contoso.com") return { status: 200, body: { id: ME.objectId, displayName: ME.name, mail: ME.email } };
      return { status: 404, body: {} };
    }
    if (rest === "/mailboxSettings/timeZone") return { status: 200, body: { value: "Pacific Standard Time" } };
    if (rest === "/mailboxSettings") {
      // A schedule set in Outlook: wall times in the mailbox's Windows zone.
      return { status: 200, body: { automaticRepliesSetting: {
        status: "scheduled", externalAudience: "all", internalReplyMessage: "<p>Away</p>", externalReplyMessage: "<p>Away</p>",
        scheduledStartDateTime: { dateTime: "2026-11-02T09:00:00.0000000", timeZone: "Pacific Standard Time" },
        scheduledEndDateTime: { dateTime: "2026-11-06T17:00:00.0000000", timeZone: "Pacific Standard Time" },
      } } };
    }
    if (rest === "/mailFolders") return { status: 200, body: { value: FOLDERS.filter(folder => folder.parentId === ROOT).map(folderRow) } };
    const folder = /^\/mailFolders\/([^/]+)(\/childFolders|\/messages)?$/.exec(rest);
    if (folder) {
      const found = folderBy(decodeURIComponent(folder[1]!));
      if (!found) return { status: 404, body: {} };
      if (folder[2] === "/childFolders") return { status: 200, body: { value: FOLDERS.filter(child => child.parentId === found.id).map(folderRow) } };
      if (folder[2] === "/messages") return { status: 200, body: { value: MESSAGES.filter(message => message.folder === found.id).map(messageRow) } };
      return { status: 200, body: folderRow(found) };
    }
    if (rest === "/messages") {
      const conversation = /conversationId eq '([^']+)'/.exec(query.get("$filter") ?? "")?.[1];
      return { status: 200, body: { value: MESSAGES.filter(message => conversation === undefined || message.conversationId === conversation).map(messageRow) } };
    }
    const message = /^\/messages\/([^/]+)(?:\/attachments(?:\/([^/]+)\/\$value)?)?$/.exec(rest);
    if (message) {
      const found = messageBy(decodeURIComponent(message[1]!));
      if (!found) return { status: 404, body: { error: { code: "ErrorItemNotFound", message: "Not found" } } };
      if (!rest.includes("/attachments")) return { status: 200, body: messageRow(found) };
      if (message[2] !== undefined) {
        const attachment = found.attachments?.find(candidate => candidate.id === decodeURIComponent(message[2]!));
        return attachment ? { status: 200, body: null, raw: attachment } : { status: 404, body: {} };
      }
      const top = Number(query.get("$top") ?? 100);
      const skip = Number(query.get("$skip") ?? 0);
      const all = found.attachments ?? [];
      return {
        status: 200, body: {
          value: all.slice(skip, skip + top).map(attachmentRow),
          ...(all.length > skip + top ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages/${found.id}/attachments?$skip=${skip + top}` } : {}),
        },
      };
    }
    return { status: 404, body: { error: { code: "unrouted", message: `${method} ${path}` } } };
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/v1\.0/, "");
    if (path === "/$batch") {
      const responses = (body as { requests: { id: string; method: string; url: string }[] }).requests.flatMap(request => {
        const inner = new URL(`https://graph.microsoft.com/v1.0/${request.url}`);
        calls.push({ method: request.method, path: inner.pathname.replace(/^\/v1\.0/, "") });
        if (inner.pathname.endsWith(`/mailFolders/${options.omitFromBatch}`)) return [];
        const answer = route(request.method, inner.pathname.replace(/^\/v1\.0/, ""), inner.searchParams);
        return [{ id: request.id, status: answer.status, body: answer.body }];
      });
      return json(200, { responses });
    }
    calls.push({ method, path, body });
    const answer = route(method, path, url.searchParams);
    if (answer.raw) return new Response(answer.raw.content, { status: 200, headers: { "content-type": answer.raw.contentType } });
    return json(answer.status, answer.body);
  };
  return { api: new GraphApi("token", { fetch }), calls };
}

type SessionOptions = FakeOptions & { ownDrafts?: string[] };

/** A session over a scope, recording what it observes and proposes. */
function session(scope: OutlookScope, access: OutlookAccessLevel = "read", options: SessionOptions = {}) {
  const graph = fakeGraph(options);
  const observations: ObservationDescription[] = [];
  const submitted: { kind: keyof OutlookActions; payload: OutlookActions[keyof OutlookActions] }[] = [];
  let sequence = 0;
  const host: OutlookSessionHost = {
    scope, access,
    owner: async () => ME,
    read: op => op(graph.api),
    cached: (_key, _ttl, load) => load(),
    pending: () => submitted.map((action, index) => ({ id: index + 1, action: action as OutlookAction })) as never,
    resolve: id => id,
    allocate: () => `~${++sequence}`,
    submit: async (_queue, kind, payload) => {
      submitted.push({ kind, payload });
      return submitted.length;
    },
    capture: async () => ({ handle: "file" }) as never,
    ownDrafts: () => new Set(options.ownDrafts ?? []),
    subscribe: async () => {},
  };
  const queue = {
    dup() { return queue; },
    authorizeObservation: async (description: ObservationDescription) => { observations.push(description); },
    [Symbol.dispose]() {},
  } as unknown as RpcStub<ApprovalQueue>;
  const observers: ObserverStrategy = {
    aclChecks: "per-read",
    prepare: async () => ({ commit() {} }),
    addObserver: async () => {},
    removeObserver: async () => {},
    prepareWithheld: () => ({ commit() {} }),
  };
  const ctx = new OutlookContext(host, queue, observers);
  const reader = access === "read" ? new OutlookReaderImpl(ctx) : new OutlookSessionImpl(ctx);
  return { reader, writer: reader as OutlookSessionImpl, graph, observations, submitted };
}

const whole = (access: OutlookAccessLevel = "read"): OutlookScope => ({ mailbox: { kind: "me" }, access });
const fromAda = (): OutlookScope => ({ mailbox: { kind: "me" }, senders: ["ada@contoso.com"], access: "read" });

async function all(cursor: { next(): Promise<MessageInfo[] | null> }): Promise<MessageInfo[]> {
  const items: MessageInfo[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) items.push(...page);
  return items;
}

describe("a sender-narrowed binding", () => {
  it("refuses a message outside it and a missing one in the same words, observing nothing", async () => {
    const { reader, observations } = session(fromAda());
    await expect(reader.getMessage(EVE)).rejects.toThrow(`That message ${OUTSIDE}`);
    await expect(reader.getMessage("AAMkNothing0")).rejects.toThrow(`That message ${OUTSIDE}`);
    await expect(reader.readMessage("../users/x")).rejects.toThrow(`That message ${OUTSIDE}`);
    expect(observations).toEqual([]);
  });

  it("refuses to list a folder it doesn't cover", async () => {
    const { reader } = session(fromAda());
    await expect(reader.listMessages({ folderId: JUNK })).rejects.toThrow(`That folder ${OUTSIDE}`);
    await expect(reader.listMessages({ folderId: "junkemail" })).rejects.toThrow(`That folder ${OUTSIDE}`);
  });

  it("drops rows Graph lists from outside the binding", async () => {
    const everything = await all(await session(whole()).reader.listMessages());
    expect(everything.map(message => message.id)).toEqual([ADA, EVE, EVE_INVOICE, MANY]);
    const { reader, observations } = session(fromAda());
    // A sender binding spans the mailbox, so Ada's mail in Vendors is hers too; Eve's is dropped.
    const narrowed = await all(await reader.listMessages());
    expect(narrowed.map(message => message.id)).toEqual([ADA, "AAMkAdaVend1", MANY]);
    expect(JSON.stringify(observations)).not.toContain("Invoice");
  });

  it("refuses an attachment of another message", async () => {
    const { reader } = session(fromAda());
    await expect(reader.readAttachment(ADA, "AAMkAttPdf00")).rejects.toThrow(`That attachment ${OUTSIDE}`);
    await expect(reader.readAttachment(EVE_INVOICE, "AAMkAttPdf00")).rejects.toThrow(`That message ${OUTSIDE}`);
  });

  it("refuses a conversation it covers none of, and reads only its part of one it does", async () => {
    const { reader } = session(fromAda());
    await expect(reader.readConversation("c2")).rejects.toThrow(`That conversation ${OUTSIDE}`);
    await expect(reader.readConversation(EVE)).rejects.toThrow(`That conversation ${OUTSIDE}`);
    const conversation = await reader.readConversation(ADA);
    expect(conversation.messages.map(message => message.info.id)).toEqual([ADA]);
    expect(conversation.partial).toBe(true);
  });
});

describe("a whole-mailbox binding", () => {
  it("reads an HTML attachment as it reads mail, hidden text and all", async () => {
    const { reader } = session(whole());
    const content = await reader.readAttachment(ADA, "AAMkAttHtml0");
    expect(content).toMatchObject({ format: "markdown", content: "Hi", removed: ["hidden text"], truncated: false });
    const csv = await reader.readAttachment(ADA, "AAMkAttCsv00");
    expect(csv.content).toContain("1,2");
  });

  it("lists attachments past the first page", async () => {
    const { reader, graph } = session(whole());
    const attachments = await reader.listAttachments(MANY);
    expect(attachments).toHaveLength(ATTACHMENT_PAGES);
    expect(graph.calls.filter(call => call.path === `/me/messages/${MANY}/attachments`)).toHaveLength(2);
    expect((await reader.readAttachmentBytes(MANY, "AAMkAttMany100")).byteLength).toBeGreaterThan(0);
  });

  it("changes and deletes only the drafts it wrote; the user's it can read and send", async () => {
    const { reader, writer, submitted } = session(whole("send"), "send");
    expect((await reader.readMessage(USER_DRAFT)).markdown).toBe("Dear all,");
    await expect(writer.updateDraft(USER_DRAFT, { body: "Dear all, send money." })).rejects.toThrow(`That draft ${OUTSIDE}`);
    await expect(writer.deleteDraft(USER_DRAFT)).rejects.toThrow(`That draft ${OUTSIDE}`);
    // Nor through the organizing API, which would propose the deletion for automatic approval.
    await expect(writer.delete([USER_DRAFT])).rejects.toThrow(/use deleteDraft/);
    expect(submitted).toEqual([]);
    await writer.send(USER_DRAFT);
    expect(submitted.map(action => action.kind)).toEqual(["send"]);
    expect((submitted[0]!.payload as OutlookActions["send"]).draft).toEqual({ id: USER_DRAFT, changeKey: "ck-user" });
  });

  it("proposes moving a message back to where it is once a pending move has left it elsewhere", async () => {
    const { writer, submitted } = session(whole("draft"), "draft");
    await writer.archive([ADA]);
    await writer.move([ADA], INBOX);
    const moves = submitted.map(action => action.payload as OutlookActions["moveMessages"]);
    expect(moves.map(move => move.to.id)).toEqual(["AAMkArchive0", INBOX]);
    // Undoing the second move returns the message to where the first put it, not to where it was read.
    expect(moves[1]!.messages[0]).toMatchObject({ id: ADA, folderId: "AAMkArchive0", folder: "Archive" });
    // While one already where it is going, pending moves included, needs no move.
    await writer.move([EVE], INBOX);
    await writer.move([ADA], INBOX);
    expect(submitted).toHaveLength(2);
  });

  it("reads an automatic-reply schedule set in Outlook as the instants its zone means", async () => {
    const { writer } = session(whole("draft"), "draft");
    const replies = await writer.getAutomaticReplies();
    expect(replies).toMatchObject({ status: "scheduled", start: "2026-11-02T17:00:00.000Z", end: "2026-11-07T01:00:00.000Z" });
  });

  it("changes a draft it wrote itself", async () => {
    const { writer, submitted } = session(whole("draft"), "draft", { ownDrafts: [USER_DRAFT] });
    await writer.updateDraft(USER_DRAFT, { subject: "Mine" });
    expect(submitted.map(action => action.kind)).toEqual(["updateDraft"]);
    expect((submitted[0]!.payload as OutlookActions["updateDraft"]).changeKey).toBe("ck-user");
    // A second edit would start from the text Outlook still has and be fenced on the version the first moves.
    await expect(writer.updateDraft(USER_DRAFT, { body: "And more" })).rejects.toThrow(/already has an edit waiting/);
    expect(submitted).toHaveLength(1);
  });

  it("creates a folder at the top of the mailbox by the root's real ID as by its name", async () => {
    const { writer, submitted } = session(whole("draft"), "draft");
    await writer.createFolder(ROOT, "Projects");
    await writer.createFolder("msgfolderroot", "Archive 2026");
    expect(submitted.map(action => (action.payload as OutlookActions["createFolder"]).parent.id)).toEqual([ROOT, ROOT]);
  });

  it("shows the approver what a forward carries: the source's text and attachments", async () => {
    const { writer, submitted, observations } = session(whole("send"), "send");
    await writer.forward(ADA, ["grace@contoso.com"], "FYI");
    const { origin } = submitted[0]!.payload as OutlookActions["send"];
    expect(origin).toMatchObject({ kind: "forward", forwarded: { markdown: "Numbers attached.", truncated: false } });
    expect(origin.kind === "forward" ? origin.forwarded.attachments.map(attachment => attachment.name) : []).toEqual(["numbers.csv", "offer.html"]);
    expect(observations.map(observation => observation.title)).toContain("Read an Outlook message");
  });

  it("edits a forward not yet created as its own part alone, so the original Outlook quotes at creation stays", async () => {
    const { writer, submitted } = session(whole("send"), "send");
    const draft = await writer.createForwardDraft(ADA, ["grace@contoso.com"], "FYI");
    await writer.updateDraft(draft.id, { body: "FYI, see Ada's numbers below." });
    expect(submitted[1]).toMatchObject({ kind: "updateDraft", payload: { draftId: draft.id, keepsQuote: true } });
    const own = await writer.createDraft({ to: ["grace@contoso.com"], subject: "Mine", body: "Hello" });
    await writer.updateDraft(own.id, { body: "Hello again" });
    expect(submitted[3]!.payload).not.toHaveProperty("keepsQuote");
  });

  it("counts the message a reply is to as read, since the reply it returns describes it", async () => {
    const { writer, observations } = session(whole("send"), "send");
    const reply = await writer.createReplyDraft(ADA, "Thanks, will do.");
    expect(reply.subject).toMatch(/^RE: /);
    expect(observations.map(observation => observation.title)).toContain("Read an Outlook message");
  });

  it("won't send a reply draft before Outlook has written the quote the approver would be shown", async () => {
    const { writer, submitted } = session(whole("send"), "send");
    const reply = await writer.createReplyDraft(ADA, "Thanks, will do.", { cc: ["outside@example.com"] });
    await expect(writer.send(reply.id)).rejects.toThrow(/hasn't been created yet/);
    expect(submitted.map(action => action.kind)).toEqual(["createDraft"]);
  });

  it("fails rather than guessing when Graph leaves a folder out of the well-known batch", async () => {
    const { reader } = session(fromAda(), "read", { omitFromBatch: "junkemail" });
    await expect(reader.listFolders()).rejects.toThrow(/left a folder out of a batch/);
  });
});

describe("a binding narrowed to the user's own address", () => {
  it("covers their sent mail, whose sender Exchange gives as a legacy address", async () => {
    const { reader } = session({ mailbox: { kind: "me" }, senders: ["phillip@contoso.com"], access: "read" });
    const sent = await reader.getMessage(SENT_COPY);
    expect(sent.from).toEqual({ address: "phillip@contoso.com" });
    await expect(reader.getMessage(ADA)).rejects.toThrow(OUTSIDE);
  });
});

describe("a shared mailbox binding", () => {
  it("names the mailbox by its pinned object ID, never by its address", async () => {
    const { reader, graph } = session({ mailbox: { kind: "shared", ...SUPPORT }, access: "read" });
    const mailbox = await reader.getMailbox();
    expect(mailbox).toMatchObject({ kind: "shared", address: SUPPORT.address, name: SUPPORT.name });
    const lookups = graph.calls.filter(call => /^\/users\/[^/]+$/.test(call.path));
    expect(lookups).toEqual([{ method: "GET", path: `/users/${SUPPORT.id}`, body: undefined }]);
  });
});

describe("resolving a binding URL", () => {
  it("takes a link naming the user by an alias as their own mailbox, not a shared one", async () => {
    const { api } = fakeGraph();
    const own = await resolveOutlookUrl(api, "https://outlook.office.com/mail/phil@contoso.com/inbox", "send", ME.email!, ME.objectId);
    expect(own.mailbox).toEqual({ kind: "me" });
    const shared = await resolveOutlookUrl(api, `https://outlook.office.com/mail/${SUPPORT.address}/inbox`, "send", ME.email!, ME.objectId);
    expect(shared.mailbox).toEqual({ kind: "shared", id: SUPPORT.id, address: SUPPORT.address });
  });
});
