// Outlook against the live tenant: Phillip, Sarah and Bob mail each other, and every message,
// reply and change goes through the gatekeeper the way an agent's would: proposed, simulated,
// approved, applied, read back, and where possible reverted. Each run tags its subjects with a run
// ID, so nothing depends on what earlier runs left in the mailboxes.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AttachmentContent, AttachmentInfo, Conversation, FolderInfo, MailboxInfo, MessageContent, MessageInfo, Person,
} from "../../src/outlook-types";
import type { OutlookScope } from "../../src/outlook-scope";
import type { AnyGatekeeperProps } from "../workerd/worker";
import { account, connect, failure, facet, hooks, live, run, unwrap, walk, type Label } from "./tenant";

const RUN = `run-${Date.now().toString(36)}`;
const OUTSIDE = /is outside what this Outlook connection covers, or doesn't exist/;

type Submitted = { actionId: number; description: { title: string; description: string; fields?: unknown } };

function address(label: Label): string {
  return account(label).username.toLowerCase();
}

async function bindMail(label: Label, url = "https://outlook.office.com/mail/"): Promise<AnyGatekeeperProps> {
  const userObjectId = await connect(label);
  return { userObjectId, scope: unwrap<OutlookScope>(await hooks().resolveOutlook(userObjectId, url)) };
}

async function lastSubmitted(name: string): Promise<Submitted> {
  return (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
}

async function approveLast(name: string, props: AnyGatekeeperProps): Promise<Submitted> {
  const last = await lastSubmitted(name);
  unwrap(await hooks().applyAction(name, props, last.actionId));
  return last;
}

function shown(action: Submitted): string {
  return JSON.stringify(action.description);
}

/** Waits for a message with `subject` to show in a search, as delivery and indexing take a while. */
async function arrival(name: string, props: AnyGatekeeperProps, subject: string, folderId?: string, tries = 30): Promise<MessageInfo> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const listed = await walk<MessageInfo>(name, props, [["listMessages", { pageSize: 50, ...(folderId ? { folderId } : {}) }]], 2);
    const found = listed.find(message => message.subject === subject);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`"${subject}" never arrived`);
}

/** Sends a message as `from` through the gatekeeper and returns its subject. */
async function sendAs(from: Label, to: Label[], subject: string, body: string, extra: Record<string, unknown> = {}): Promise<string> {
  const props = await bindMail(from);
  const name = facet(`send-${from}`);
  const full = `${subject} ${RUN}`;
  unwrap(await run(name, props, [["sendMail", { to: to.map(address), subject: full, body, ...extra }]]));
  await approveLast(name, props);
  return full;
}

describe.skipIf(!live)("outlook", { timeout: 180_000 }, () => {
  it("describes the mailbox and its folders", async () => {
    const props = await bindMail("phillip");
    const name = facet("mailbox");
    const mailbox = unwrap<MailboxInfo>(await run(name, props, [["getMailbox"]]));
    expect(mailbox).toMatchObject({ address: address("phillip"), kind: "own", access: "send", covers: expect.stringContaining("All mail") });
    expect(mailbox.timeZone).toBeTruthy();
    const folders = unwrap<FolderInfo[]>(await run(name, props, [["listFolders"]]));
    expect(folders.map(folder => folder.wellKnownName)).toEqual(expect.arrayContaining(["inbox", "sentitems", "drafts", "deleteditems"]));
    expect(folders.find(folder => folder.wellKnownName === "inbox")!.path).toBe("Inbox");
  });

  it("sends, and the recipient reads it safely, with who sent it and what it links to", async () => {
    const body = "Hi Sarah,\n\nThe **Apollo** numbers are in. See [the dashboard](https://example.com/apollo).\n\n- Revenue up\n- Costs flat\n";
    const subject = await sendAs("phillip", ["sarah"], "Apollo numbers", body);
    const sarah = await bindMail("sarah");
    const name = facet("read");
    const arrived = await arrival(name, sarah, subject);
    expect(arrived).toMatchObject({ senderKind: "internal", from: { address: expect.stringMatching(new RegExp(address("phillip"), "i")) }, isRead: false });
    const content = unwrap<MessageContent>(await run(name, sarah, [["readMessage", arrived.id]]));
    expect(content.markdown).toContain("**Apollo**");
    expect(content.markdown).toContain("- Revenue up");
    expect(content.links).toEqual([expect.objectContaining({ url: "https://example.com/apollo" })]);
    const observation = (await hooks().queueLog(name)).observations.at(-1)!;
    expect(observation.description).toContain("Apollo numbers");
  });

  it("puts every recipient's notes in front of the approver, and sends exactly once", async () => {
    const props = await bindMail("phillip");
    const name = facet("send-notes");
    const subject = `Notes check ${RUN}`;
    unwrap(await run(name, props, [["sendMail", {
      to: [address("sarah")], cc: ["someone.new@example.com"], subject, body: "Checking the notes.",
    }]]));
    const proposed = await lastSubmitted(name);
    expect(shown(proposed)).toContain("outside your organization");
    expect(shown(proposed)).toContain("can't be called back");
    // Never auto-approvable, whatever the binding allows.
    const auto = unwrap<{ tag: string }[]>(await hooks().autoApprovable(name, props));
    expect(auto.map(kind => kind.tag)).not.toContain("outlook.send");
    // Reject rather than mail a stranger; then send to Sarah alone and check Sent Items holds one copy.
    unwrap(await hooks().rejectAction(name, props, proposed.actionId));
    unwrap(await run(name, props, [["sendMail", { to: [address("sarah")], subject, body: "Checking the notes." }]]));
    await approveLast(name, props);
    await arrival(name, props, subject, "sentitems");
    const sent = await walk<MessageInfo>(name, props, [["listMessages", { folderId: "sentitems", pageSize: 50 }]], 2);
    expect(sent.filter(message => message.subject === subject)).toHaveLength(1);
  });

  it("replies within the conversation, with the original quoted, and notes a new recipient", async () => {
    const subject = await sendAs("phillip", ["sarah"], "Launch date", "Can we move the launch to March 3?");
    const sarah = await bindMail("sarah");
    const name = facet("reply");
    const original = await arrival(name, sarah, subject);
    unwrap(await run(name, sarah, [["reply", original.id, "Yes, March 3 works. Looping in Bob.", { cc: [address("bob")] }]]));
    const proposed = await lastSubmitted(name);
    expect(shown(proposed)).toContain("not already in this conversation");
    expect(shown(proposed)).toContain(`replies to`);
    await approveLast(name, sarah);

    const phillip = await bindMail("phillip");
    const reader = facet("reply-read");
    const reply = await arrival(reader, phillip, `RE: ${subject}`);
    const sentOriginal = await arrival(reader, phillip, subject, "sentitems");
    expect(reply.conversationId).toBe(sentOriginal.conversationId);
    // His own sent mail reads as from him, not from Exchange's internal address for him.
    expect(sentOriginal.senderKind).toBe("you");
    expect(sentOriginal.from?.address.toLowerCase()).toBe(address("phillip"));
    const conversation = unwrap<Conversation>(await run(reader, phillip, [["readConversation", reply.id]]));
    expect(conversation.messages.length).toBeGreaterThanOrEqual(2);
    const latest = conversation.messages.at(-1)!;
    expect(latest.markdown).toContain("March 3 works");
    // Only what the reply added, not the quoted original.
    expect(latest.markdown).not.toContain("Can we move the launch");
    const full = unwrap<MessageContent>(await run(reader, phillip, [["readMessage", reply.id]]));
    expect(full.markdown).toContain("Can we move the launch");

    const bob = await bindMail("bob");
    const bobName = facet("reply-bob");
    expect((await arrival(bobName, bob, `RE: ${subject}`)).cc.map(cc => cc.address.toLowerCase())).toContain(address("bob"));
  });

  it("drafts: pending reads back, applies, edits keep a reply's quote, then sends", async () => {
    const subject = await sendAs("sarah", ["phillip"], "Budget question", "What is the Q3 budget?");
    const props = await bindMail("phillip");
    const name = facet("drafts");
    const original = await arrival(name, props, subject);

    const pending = unwrap<MessageInfo>(await run(name, props, [["createReplyDraft", original.id, "Drafting an answer."]]));
    expect(pending).toMatchObject({ id: expect.stringMatching(/^~/), pending: "draft", isDraft: true });
    const listed = await walk<MessageInfo>(name, props, [["listMessages", { folderId: "drafts" }]], 1);
    expect(listed.map(message => message.id)).toContain(pending.id);
    await approveLast(name, props);
    const real = unwrap<MessageInfo>(await run(name, props, [["getMessage", pending.id]]));
    expect(real).toMatchObject({ isDraft: true, subject: expect.stringContaining(subject) });
    expect(real.id).not.toMatch(/^~/);

    unwrap(await run(name, props, [["updateDraft", pending.id, { body: "The Q3 budget is **$40k**." }]]));
    const edited = unwrap<MessageContent>(await run(name, props, [["readMessage", pending.id]]));
    expect(edited.markdown).toContain("$40k");
    await approveLast(name, props);
    const after = unwrap<MessageContent>(await run(name, props, [["readMessage", pending.id]]));
    expect(after.markdown).toContain("**$40k**");
    expect(after.markdown).toContain("What is the Q3 budget?");

    unwrap(await run(name, props, [["send", pending.id]]));
    const proposed = await lastSubmitted(name);
    expect(shown(proposed)).toContain("$40k");
    await approveLast(name, props);
    const sarah = await bindMail("sarah");
    const answer = await arrival(facet("drafts-sarah"), sarah, `RE: ${subject}`);
    expect(answer.preview).toContain("$40k");
  });

  it("refuses a draft the user edited after it was proposed", async () => {
    const props = await bindMail("phillip");
    const name = facet("draft-fence");
    const pending = unwrap<MessageInfo>(await run(name, props, [["createDraft", { to: [address("sarah")], subject: `Fence ${RUN}`, body: "First." }]]));
    await approveLast(name, props);
    const draft = unwrap<MessageInfo>(await run(name, props, [["getMessage", pending.id]]));
    unwrap(await run(name, props, [["updateDraft", draft.id, { body: "Agent's change." }]]));
    // The user edits it in Outlook meanwhile.
    unwrap(await hooks().graph(props.userObjectId, "PATCH", `/me/messages/${encodeURIComponent(draft.id)}`, { body: { contentType: "Text", content: "User's change." } }));
    const last = await lastSubmitted(name);
    expect(failure(await hooks().applyAction(name, props, last.actionId))).toMatch(/changed after this was proposed/);
    unwrap(await run(name, props, [["deleteDraft", draft.id]]));
    await approveLast(name, props);
  });

  it("sends a draft only as the approver saw it", async () => {
    const props = await bindMail("phillip");
    const name = facet("send-fence");
    // Created and sent in one go: the send waits for the draft, then goes as it was created.
    const made = unwrap<MessageInfo>(await run(name, props, [["createDraft", { to: [address("sarah")], subject: `As approved ${RUN}`, body: "Approved text." }]]));
    unwrap(await run(name, props, [["send", made.id]]));
    expect(failure(await run(name, props, [["updateDraft", made.id, { body: "Swapped text." }]]))).toMatch(/waiting to be sent/);
    const [create, send] = (await hooks().queueLog(name)).submitted.slice(-2) as Submitted[];
    unwrap(await hooks().applyAction(name, props, create!.actionId));
    unwrap(await hooks().applyAction(name, props, send!.actionId));
    const sarah = await bindMail("sarah");
    expect((await arrival(facet("send-fence-sarah"), sarah, `As approved ${RUN}`)).preview).toContain("Approved text.");

    // Anything that touches the draft between proposal and approval, even marking it read, stops the send.
    const second = unwrap<MessageInfo>(await run(name, props, [["createDraft", { to: [address("sarah")], subject: `Touched ${RUN}`, body: "Original." }]]));
    unwrap(await run(name, props, [["send", second.id]]));
    const [create2, send2] = (await hooks().queueLog(name)).submitted.slice(-2) as Submitted[];
    unwrap(await hooks().applyAction(name, props, create2!.actionId));
    const real = unwrap<MessageInfo>(await run(name, props, [["getMessage", second.id]]));
    unwrap(await hooks().graph(props.userObjectId, "PATCH", `/me/messages/${encodeURIComponent(real.id)}`, { body: { contentType: "Text", content: "Changed in Outlook." } }));
    expect(failure(await hooks().applyAction(name, props, send2!.actionId))).toMatch(/changed after this was proposed/);
    unwrap(await run(name, props, [["deleteDraft", real.id]]));
    await approveLast(name, props);
  });

  it("moves mail only into folders the user sees", async () => {
    const props = await bindMail("phillip");
    const name = facet("hidden-folders");
    const [message] = await walk<MessageInfo>(name, props, [["listMessages", { folderId: "inbox", pageSize: 1 }]], 1);
    for (const hidden of ["recoverableitemsdeletions", "msgfolderroot", "syncissues", "outbox", "deleteditems"]) {
      expect(failure(await run(name, props, [["move", [message!.id], hidden]]))).toMatch(/can't be moved into|is outside what this Outlook connection covers/);
    }
    // The root's own ID is the top of the mailbox, as "msgfolderroot" is: a folder made there is a
    // top-level folder the user sees, never one inside a hidden folder.
    const root = unwrap<{ id: string }>(await hooks().graph(props.userObjectId, "GET", "/me/mailFolders/msgfolderroot?$select=id"));
    expect(unwrap<FolderInfo>(await run(name, props, [["createFolder", root.id, `Top ${RUN}`]])))
      .toMatchObject({ path: `Top ${RUN}`, pending: "create" });
    expect(failure(await run(name, props, [["createFolder", "recoverableitemsdeletions", `Sneaky ${RUN}`]]))).toMatch(/can't be moved into|isn't in|is outside/);
  });

  it("organizes: flags, categories and read state read back pending, apply, and revert", async () => {
    const subject = await sendAs("sarah", ["phillip"], "Organize me", "Please file this.");
    const props = await bindMail("phillip");
    const name = facet("organize");
    const message = await arrival(name, props, subject);
    const flagged = unwrap<MessageInfo[]>(await run(name, props, [["flag", [message.id], { status: "flagged", dueAt: "2030-01-15T17:00:00Z" }]]));
    expect(flagged[0]).toMatchObject({ pending: "update", flag: { status: "flagged" } });
    const flag = await approveLast(name, props);
    unwrap(await run(name, props, [["categorize", [message.id], { add: ["Red category"] }]]));
    const categorize = await approveLast(name, props);
    unwrap(await run(name, props, [["markRead", [message.id]]]));
    await approveLast(name, props);
    const now = unwrap<MessageInfo>(await run(facet("organize-check"), props, [["getMessage", message.id]]));
    expect(now).toMatchObject({ isRead: true, flag: { status: "flagged" }, categories: ["Red category"] });
    expect(now.flag.dueAt?.slice(0, 10)).toBe("2030-01-15");
    unwrap(await hooks().revertAction(name, props, categorize.actionId));
    unwrap(await hooks().revertAction(name, props, flag.actionId));
    const reverted = unwrap<MessageInfo>(await run(facet("organize-check"), props, [["getMessage", message.id]]));
    expect(reverted).toMatchObject({ flag: { status: "notFlagged" }, categories: [] });
  });

  it("creates a folder, files into it before it exists, and undoes both", async () => {
    const subject = await sendAs("sarah", ["phillip"], "File me", "Into the new folder.");
    const props = await bindMail("phillip");
    const name = facet("folders");
    const message = await arrival(name, props, subject);
    const folder = unwrap<FolderInfo>(await run(name, props, [["createFolder", "inbox", `Gadgets ${RUN}`]]));
    expect(folder).toMatchObject({ id: expect.stringMatching(/^~/), path: `Inbox/Gadgets ${RUN}`, pending: "create" });
    const moved = unwrap<MessageInfo[]>(await run(name, props, [["move", [message.id], folder.id]]));
    expect(moved[0]).toMatchObject({ pending: "move", folder: `Inbox/Gadgets ${RUN}` });
    const inFolder = await walk<MessageInfo>(name, props, [["listMessages", { folderId: folder.id }]], 1);
    expect(inFolder.map(entry => entry.id)).toContain(message.id);
    const inbox = await walk<MessageInfo>(name, props, [["listMessages", { pageSize: 50 }]], 2);
    expect(inbox.map(entry => entry.id)).not.toContain(message.id);

    const log = (await hooks().queueLog(name)).submitted as Submitted[];
    const [create, move] = log.slice(-2);
    unwrap(await hooks().applyAction(name, props, create!.actionId));
    unwrap(await hooks().applyAction(name, props, move!.actionId));
    const filed = unwrap<MessageInfo>(await run(facet("folders-check"), props, [["getMessage", message.id]]));
    expect(filed.folder).toBe(`Inbox/Gadgets ${RUN}`);

    unwrap(await hooks().revertAction(name, props, move!.actionId));
    unwrap(await hooks().revertAction(name, props, create!.actionId));
    const back = unwrap<MessageInfo>(await run(facet("folders-check"), props, [["getMessage", message.id]]));
    expect(back.folder).toBe("Inbox");
    const folders = unwrap<FolderInfo[]>(await run(facet("folders-check"), props, [["listFolders"]]));
    expect(folders.map(entry => entry.name)).not.toContain(`Gadgets ${RUN}`);
  });

  it("deletes to Deleted Items, from where a revert restores", async () => {
    const subject = await sendAs("sarah", ["phillip"], "Delete me", "Temporary.");
    const props = await bindMail("phillip");
    const name = facet("delete");
    const message = await arrival(name, props, subject);
    unwrap(await run(name, props, [["delete", [message.id]]]));
    const inbox = await walk<MessageInfo>(name, props, [["listMessages", { pageSize: 50 }]], 2);
    expect(inbox.map(entry => entry.id)).not.toContain(message.id);
    const deleted = await approveLast(name, props);
    expect(shown(deleted)).toContain("Deleted Items");
    expect(unwrap<MessageInfo>(await run(facet("delete-check"), props, [["getMessage", message.id]])).folder).toBe("Deleted Items");
    unwrap(await hooks().revertAction(name, props, deleted.actionId));
    expect(unwrap<MessageInfo>(await run(facet("delete-check"), props, [["getMessage", message.id]])).folder).toBe("Inbox");
  });

  it("a conversation binding covers that conversation and nothing else", async () => {
    const subject = await sendAs("sarah", ["phillip"], "Scoped thread", "Only this thread.");
    const other = await sendAs("sarah", ["phillip"], "Unrelated", "Not this one.");
    const all = await bindMail("phillip");
    const scratch = facet("scoped-find");
    const message = await arrival(scratch, all, subject);
    const unrelated = await arrival(scratch, all, other);

    const props = await bindMail("phillip", `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(message.id)}`);
    expect((props.scope as OutlookScope).conversation?.subject).toContain("Scoped thread");
    const name = facet("scoped");
    const listed = await walk<MessageInfo>(name, props, [["listMessages"]], 3);
    expect(listed.map(entry => entry.id)).toEqual([message.id]);
    expect(failure(await run(name, props, [["getMessage", unrelated.id]]))).toMatch(OUTSIDE);
    expect(failure(await run(name, props, [["readMessage", "AAMkAGI2THVSAAA="]]))).toMatch(OUTSIDE);
    const searched = await walk<MessageInfo>(name, props, [["search", "Unrelated"]], 2);
    expect(searched.map(entry => entry.id)).not.toContain(unrelated.id);
    expect(failure(await run(name, props, [["getAutomaticReplies"]]))).toMatch(/whole mailbox/);
    expect(failure(await run(name, props, [["move", [unrelated.id], "archive"]]))).toMatch(OUTSIDE);
    expect(failure(await run(name, props, [["archive", [message.id, unrelated.id]]]))).toMatch(OUTSIDE);
    const mailbox = unwrap<MailboxInfo>(await run(name, props, [["getMailbox"]]));
    expect(mailbox.covers).toContain("Scoped thread");
  });

  it("a sender binding covers only that sender's mail, and a read-only one has no write methods", async () => {
    await sendAs("bob", ["phillip"], "From Bob", "Bob's note.");
    const fromSarah = await sendAs("sarah", ["phillip"], "From Sarah", "Sarah's note.");
    const all = await bindMail("phillip");
    const sarahMessage = await arrival(facet("sender-find"), all, fromSarah);
    const props = await bindMail("phillip", `https://outlook.office.com/mail/?senders=${encodeURIComponent(address("bob"))}&access=read`);
    expect((props.scope as OutlookScope).access).toBe("read");
    const name = facet("sender");
    const listed = await walk<MessageInfo>(name, props, [["listMessages", { pageSize: 50 }]], 2);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every(entry => entry.from?.address.toLowerCase() === address("bob"))).toBe(true);
    expect(failure(await run(name, props, [["getMessage", sarahMessage.id]]))).toMatch(OUTSIDE);
    expect(failure(await run(name, props, [["sendMail", { to: [address("sarah")], subject: "x", body: "x" }]]))).toMatch(/sendMail|not a function|undefined/);
  });

  it("attachments: sent, listed, read as text, and read as bytes", async () => {
    const csv = "name,score\nAda,10\nGrace,9\n";
    const subject = await sendAs("sarah", ["phillip"], "Scores attached", "See attached.", {
      attachments: [{ name: "scores.csv", contentType: "text/csv", content: csv }],
    });
    const props = await bindMail("phillip");
    const name = facet("attachments");
    const message = await arrival(name, props, subject);
    expect(message.hasAttachments).toBe(true);
    const attachments = unwrap<AttachmentInfo[]>(await run(name, props, [["listAttachments", message.id]]));
    expect(attachments).toEqual([expect.objectContaining({ name: "scores.csv", kind: "file" })]);
    const text = unwrap<AttachmentContent>(await run(name, props, [["readAttachment", message.id, attachments[0]!.id]]));
    expect(text.content).toContain("Grace");
    const bytes = unwrap<Uint8Array>(await run(name, props, [["readAttachmentBytes", message.id, attachments[0]!.id]]));
    expect(new TextDecoder().decode(bytes)).toBe(csv);
  });

  it("finds people and lists categories", async () => {
    const props = await bindMail("phillip");
    const name = facet("people");
    const people = unwrap<Person[]>(await run(name, props, [["findPeople", account("sarah").name.split(" ")[0]!]]));
    expect(people.map(person => person.address.toLowerCase())).toContain(address("sarah"));
    expect(people.find(person => person.address.toLowerCase() === address("sarah"))!.external).toBe(false);
    const categories = unwrap<{ name: string }[]>(await run(name, props, [["listCategories"]]));
    expect(categories.length).toBeGreaterThan(0);
  });

  it("sets automatic replies on approval and restores them on revert", async () => {
    const props = await bindMail("bob");
    const name = facet("ooo");
    const before = unwrap<{ status: string }>(await run(name, props, [["getAutomaticReplies"]]));
    unwrap(await run(name, props, [["setAutomaticReplies", {
      status: "scheduled", start: "2030-02-01T08:00:00Z", end: "2030-02-08T17:00:00Z",
      internalReply: "I'm out until **Feb 8**.", externalReply: "I'm away until Feb 8.", externalAudience: "contactsOnly",
    }]]));
    const proposed = await approveLast(name, props);
    expect(shown(proposed)).toContain("only if they are your contacts");
    const set = unwrap<{ status: string; internalReply: string; start?: string }>(await run(facet("ooo-check"), props, [["getAutomaticReplies"]]));
    expect(set.status).toBe("scheduled");
    expect(set.internalReply).toContain("Feb 8");
    expect(set.start?.slice(0, 10)).toBe("2030-02-01");
    unwrap(await hooks().revertAction(name, props, proposed.actionId));
    expect(unwrap<{ status: string }>(await run(facet("ooo-check"), props, [["getAutomaticReplies"]])).status).toBe(before.status);
  });

  it("observers: nobody else sees a read of someone's own mail", async () => {
    const props = await bindMail("phillip");
    const name = facet("observers");
    await walk<MessageInfo>(name, props, [["listMessages", { pageSize: 5 }]], 1);
    expect(failure(await hooks().addObserver(name, props, "bob", await connect("bob")))).toMatch(/can't open in Outlook/);
    // A binding that has read only the mailbox's own description shares it with colleagues.
    const fresh = facet("observers-fresh");
    unwrap(await run(fresh, props, [["getMailbox"]]));
    unwrap(await hooks().addObserver(fresh, props, "sarah", await connect("sarah")));
    // A narrowed binding's description names mail details (here, a person), so it isn't.
    const narrowed = await bindMail("phillip", `https://outlook.office.com/mail/?senders=${address("sarah")}`);
    const named = facet("observers-narrowed");
    unwrap(await run(named, narrowed, [["getMailbox"]]));
    expect(failure(await hooks().addObserver(named, narrowed, "bob", await connect("bob")))).toMatch(/can't open in Outlook/);
  });

  // Fixture: Sarah is a Reviewer of Phillip's Inbox, and of no other folder.
  it("observers: someone shared only the Inbox sees Inbox reads, and nothing beyond it", async () => {
    const sarah = await connect("sarah");
    const inbox = await bindMail("phillip", "https://outlook.office.com/mail/inbox");
    const inboxName = facet("observers-inbox");
    expect((await walk<MessageInfo>(inboxName, inbox, [["listMessages", { pageSize: 3 }]], 1)).length).toBeGreaterThan(0);
    unwrap(await hooks().addObserver(inboxName, inbox, "sarah", sarah));

    const sent = await bindMail("phillip", "https://outlook.office.com/mail/sentitems");
    const sentName = facet("observers-sent");
    expect((await walk<MessageInfo>(sentName, sent, [["listMessages", { pageSize: 3 }]], 1)).length).toBeGreaterThan(0);
    expect(failure(await hooks().addObserver(sentName, sent, "sarah", sarah))).toMatch(/can't open in Outlook/);

    // Opening the Inbox isn't opening the mailbox: a narrowed binding's description is for those who can.
    const narrowed = await bindMail("phillip", `https://outlook.office.com/mail/?senders=${address("bob")}`);
    const named = facet("observers-inbox-narrowed");
    unwrap(await run(named, narrowed, [["getMailbox"]]));
    expect(failure(await hooks().addObserver(named, narrowed, "sarah", sarah))).toMatch(/can't open in Outlook/);
    const folders = facet("observers-inbox-folders");
    unwrap(await run(folders, await bindMail("phillip"), [["listFolders"]]));
    expect(failure(await hooks().addObserver(folders, await bindMail("phillip"), "sarah", sarah))).toMatch(/can't open in Outlook/);
  });

  it("hooks: new mail the binding covers is delivered once, with a session to read it; other mail isn't", async () => {
    const phillip = await bindMail("phillip");
    const thread = await sendAs("sarah", ["phillip"], "Hooked thread", "Start of the thread.");
    const start = await arrival(facet("hook-find"), phillip, thread);
    // One hook on the whole mailbox, one on the thread alone.
    const all = facet("hook-all");
    const scoped = await bindMail("phillip", `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(start.id)}`);
    const one = facet("hook-thread");
    unwrap(await hooks().subscribe(all, phillip, `all-${RUN}`));
    unwrap(await hooks().subscribe(one, scoped, `thread-${RUN}`));
    expect((await hooks().queueLog(all)).hooks.at(-1)!.description.title).toBe("Watch for new Outlook mail");

    // Mail after the hooks were enabled: a reply in the thread (sent from Sarah's side) and an unrelated note.
    const sarah = await bindMail("sarah");
    const sarahName = facet("hook-sarah");
    const sarahCopy = await arrival(sarahName, sarah, thread, "sentitems");
    unwrap(await run(sarahName, sarah, [["reply", sarahCopy.id, "A follow-up in the thread."]]));
    await approveLast(sarahName, sarah);
    const unrelated = await sendAs("bob", ["phillip"], "Not hooked", "Elsewhere.");
    await arrival(facet("hook-find"), phillip, `RE: ${thread}`);
    await arrival(facet("hook-find"), phillip, unrelated);

    const driver = env.OUTLOOK_HOOK_DRIVER.getByName(`${phillip.userObjectId}.${account("phillip").objectId.toLowerCase()}`);
    // Two alarms: the second must deliver nothing again.
    // The pool fired the driver's first alarm when the hooks were enabled, before this mail came;
    // its next poll is a couple of minutes off. Bring it due, twice: the second must deliver nothing again.
    for (let pass = 0; pass < 2; pass++) {
      await runInDurableObject(driver, (_instance, state) => state.storage.kv.put("syncAt", 0));
      await runDurableObjectAlarm(driver);
    }
    const everything = await hooks().hookDeliveries(`all-${RUN}`);
    const threadOnly = await hooks().hookDeliveries(`thread-${RUN}`);
    expect(everything.map(delivery => delivery.subject).toSorted()).toEqual(expect.arrayContaining([`RE: ${thread}`, unrelated]));
    expect(everything.filter(delivery => delivery.subject === unrelated)).toHaveLength(1);
    // Mail from before the hook was enabled isn't delivered.
    expect(everything.map(delivery => delivery.subject)).not.toContain(thread);
    expect(threadOnly.map(delivery => delivery.subject)).toEqual([`RE: ${thread}`]);
    expect(threadOnly[0]!.markdown).toContain("A follow-up in the thread.");

    unwrap(await hooks().unsubscribe(all));
    unwrap(await hooks().unsubscribe(one));
  });
});
