// Outlook's logic outside workerd: what a binding covers, its URL grammar, the listing queries, how
// pending changes read back, what the approver is shown, sending, and new-message notifications and
// delivery.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApplyError, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";
import { GraphApi, GraphApiError } from "../src/graph-api";
import {
  definitions, replaceOwnPart, requiredAccess, revert, submit, type Composed, type DraftVersion, type MessageTarget, type OutlookAction, type OutlookActions,
} from "../src/outlook-actions";
import { MailApi, parseMessage } from "../src/outlook-graph";
import { OutlookHookDeliveryImpl, OutlookHookDriver, handleOutlookNotification } from "../src/outlook-hooks";
import { decodeMailUnit, encodeMailUnit, isMailUnit, mailUnits, probeMailUnits } from "../src/outlook-observers";
import { OutlookOverlay } from "../src/outlook-overlay";
import { kqlPhrase, listingRequest, passesFilters } from "../src/outlook-query";
import {
  OutlookUrlError, admits, admitsFolder, describeScope, isNarrowed, lowerAccess, outlookUrl, parseOutlookUrl,
  type FolderTree, type GuardedMessage, type OutlookScope,
} from "../src/outlook-scope";
import { OutlookContext, OutlookReaderImpl, OutlookSessionImpl } from "../src/outlook-session";
import type { MessageInfo } from "../src/outlook-types";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ME = { kind: "me" } as const;

// Inbox ─┬─ Vendors ── Acme
//        └─ Team
// Drafts, Junk Email and Deleted Items beside it; Deleted Items holds a deleted folder, Old, and
// Junk Email a Spam subfolder.
const PARENTS: Record<string, string | null> = {
  inbox: null, vendors: "inbox", acme: "vendors", team: "inbox", drafts: null, junk: null, deleted: null, old: "deleted", spam: "junk",
};
const tree: FolderTree = {
  parentOf: async id => PARENTS[id] ?? null,
  privateFolders: async () => new Set(["drafts", "junk", "deleted"]),
};

function message(overrides: Partial<GuardedMessage> = {}): GuardedMessage {
  return {
    id: "m1", parentFolderId: "inbox", conversationId: "c1", from: "ada@contoso.com", isDraft: false, ...overrides,
  };
}

const scope = (overrides: Partial<OutlookScope> = {}): OutlookScope => ({ mailbox: ME, access: "send", ...overrides });

describe("admits", () => {
  it("covers the whole mailbox, Junk and Deleted Items included, when nothing narrows it", async () => {
    expect(isNarrowed(scope())).toBe(false);
    for (const folder of ["inbox", "acme", "junk", "deleted", "drafts"]) {
      expect(await admits(scope(), message({ parentFolderId: folder }), tree)).toBe(true);
    }
  });

  it("a folder binding covers its subfolders only when asked to", async () => {
    const vendors = scope({ folder: { id: "vendors", name: "Vendors", subfolders: true } });
    expect(await admits(vendors, message({ parentFolderId: "acme" }), tree)).toBe(true);
    expect(await admits(vendors, message({ parentFolderId: "team" }), tree)).toBe(false);
    expect(await admits(vendors, message({ parentFolderId: "inbox" }), tree)).toBe(false);
    const only = scope({ folder: { id: "vendors", name: "Vendors", subfolders: false } });
    expect(await admits(only, message({ parentFolderId: "acme" }), tree)).toBe(false);
    expect(await admits(only, message({ parentFolderId: "vendors" }), tree)).toBe(true);
  });

  it("a narrowed binding never reaches into Drafts, Junk or Deleted Items", async () => {
    const fromAda = scope({ senders: ["ada@contoso.com"] });
    expect(await admits(fromAda, message(), tree)).toBe(true);
    for (const folder of ["junk", "deleted", "drafts"]) {
      expect(await admits(fromAda, message({ parentFolderId: folder }), tree)).toBe(false);
    }
  });

  it("nor into a folder the user deleted, which Outlook moved under Deleted Items", async () => {
    const fromAda = scope({ senders: ["ada@contoso.com"] });
    const thread = scope({ conversation: { id: "c1", subject: "x" } });
    expect(await admits(fromAda, message({ parentFolderId: "old" }), tree)).toBe(false);
    expect(await admits(thread, message({ parentFolderId: "old" }), tree)).toBe(false);
    expect(await admits(thread, message({ parentFolderId: "spam" }), tree)).toBe(false);
    // Unnarrowed, or narrowed to Deleted Items itself, the binding reaches it as before.
    expect(await admits(scope(), message({ parentFolderId: "old" }), tree)).toBe(true);
    expect(await admits(scope({ folder: { id: "deleted", name: "Deleted Items", subfolders: true } }), message({ parentFolderId: "old" }), tree)).toBe(true);
  });

  it("matches senders by address or domain, never by a domain's suffix", async () => {
    const domain = scope({ senders: ["@contoso.com"] });
    expect(await admits(domain, message({ from: "grace@contoso.com" }), tree)).toBe(true);
    expect(await admits(domain, message({ from: "eve@evilcontoso.com" }), tree)).toBe(false);
    expect(await admits(domain, message({ from: "eve@contoso.com.evil.com" }), tree)).toBe(false);
    expect(await admits(domain, message({ from: undefined }), tree)).toBe(false);
    expect(await admits(scope({ senders: ["ada@contoso.com"] }), message({ from: "ADA@contoso.com" }), tree)).toBe(true);
  });

  it("narrows by conversation", async () => {
    expect(await admits(scope({ conversation: { id: "c1", subject: "x" } }), message(), tree)).toBe(true);
    expect(await admits(scope({ conversation: { id: "c2", subject: "x" } }), message(), tree)).toBe(false);
  });

  it("covers the drafts the binding wrote itself, whatever its narrowing", async () => {
    const narrow = scope({ conversation: { id: "c9", subject: "x" } });
    const draft = message({ id: "d1", parentFolderId: "drafts", isDraft: true, conversationId: "c5" });
    expect(await admits(narrow, draft, tree)).toBe(false);
    expect(await admits(narrow, draft, tree, { ownDrafts: new Set(["d1"]) })).toBe(true);
    // Only a draft: a sent message with a remembered ID is judged like any other.
    expect(await admits(narrow, { ...draft, isDraft: false }, tree, { ownDrafts: new Set(["d1"]) })).toBe(false);
  });

  it("gives up on a folder tree deeper than it will walk", async () => {
    const deep: FolderTree = { parentOf: async id => `${id}x`, privateFolders: async () => new Set() };
    const bound = scope({ folder: { id: "top", name: "Top", subfolders: true } });
    expect(await admits(bound, message({ parentFolderId: "leaf" }), deep)).toBe(false);
  });

  it("admits folders as it admits their mail", async () => {
    const vendors = scope({ folder: { id: "vendors", name: "Vendors", subfolders: true } });
    expect(await admitsFolder(vendors, "acme", tree)).toBe(true);
    expect(await admitsFolder(vendors, "team", tree)).toBe(false);
    expect(await admitsFolder(scope({ senders: ["@contoso.com"] }), "junk", tree)).toBe(false);
    expect(await admitsFolder(scope({ senders: ["@contoso.com"] }), "spam", tree)).toBe(false);
    expect(await admitsFolder(scope({ senders: ["@contoso.com"] }), "old", tree)).toBe(false);
    expect(await admitsFolder(scope(), "junk", tree)).toBe(true);
    expect(await admitsFolder(scope(), "spam", tree)).toBe(true);
  });
});

describe("binding URLs", () => {
  it("reads Outlook on the web's own links", () => {
    expect(parseOutlookUrl("https://outlook.office.com/mail/")).toEqual({ subfolders: true });
    expect(parseOutlookUrl("https://outlook.office.com/mail/inbox/Vendors?subfolders=0")).toMatchObject({ folder: "inbox/Vendors", subfolders: false });
    expect(parseOutlookUrl("https://outlook.office365.com/mail/inbox/id/AAMkAD%2Fx%3D")).toMatchObject({ folder: "inbox", messageId: "AAMkAD-x=" });
    expect(parseOutlookUrl("https://outlook.cloud.microsoft/mail/Shared@Contoso.com/inbox")).toMatchObject({ mailbox: "shared@contoso.com", folder: "inbox" });
    expect(parseOutlookUrl("https://outlook.office.com/mail/?senders=@Contoso.com,ada@x.org&access=draft")).toMatchObject({
      senders: ["@contoso.com", "ada@x.org"], access: "draft",
    });
  });

  it("refuses anything else, saying why", () => {
    const refused = (url: string) => expect(() => parseOutlookUrl(url), url).toThrow(OutlookUrlError);
    refused("https://outlook.evil.com/mail/");
    refused("http://outlook.office.com/mail/");
    refused("https://outlook.office.com/calendar/");
    refused("https://outlook.office.com/mail/secret-folder");
    refused("https://outlook.office.com/mail/?senders=not-an-address");
    refused("https://outlook.office.com/mail/?senders=@evil");
    refused("https://outlook.office.com/mail/?access=organize");
    refused("https://outlook.office.com/mail/?access=admin");
    refused("https://outlook.office.com/mail/inbox/id/");
    refused("https://outlook.office.com/mail/?conversation=a%27b");
  });

  it("writes what it reads", () => {
    const bound: OutlookScope = {
      mailbox: { kind: "shared", id: "u1", address: "support@contoso.com" },
      folder: { id: "AAMk/x+y=", name: "Escalations", subfolders: false },
      senders: ["@fabrikam.com"], access: "draft",
    };
    expect(parseOutlookUrl(outlookUrl(bound))).toEqual({
      mailbox: "support@contoso.com", folder: "id:AAMk/x+y=", subfolders: false, senders: ["@fabrikam.com"], access: "draft",
    });
    const thread = scope({ conversation: { id: "AAQkADVh_x-y=", subject: "Plans" } });
    expect(parseOutlookUrl(outlookUrl(thread)).conversationId).toBe("AAQkADVh_x-y=");
  });

  it("describes the binding in words", () => {
    expect(describeScope(scope(), "Ada")).toBe("All mail in Ada's mailbox");
    expect(describeScope(scope({ senders: ["@contoso.com"], folder: { id: "i", name: "Inbox", subfolders: false } }), "Ada"))
      .toBe("Mail from @contoso.com in Inbox in Ada's mailbox");
  });

  it("access is the lower of what the URL asks and what is allowed", () => {
    expect(lowerAccess("send", "draft")).toBe("draft");
    expect(lowerAccess("read", "send")).toBe("read");
  });
});

describe("listing queries", () => {
  it("leads every filter with receivedDateTime, which Exchange needs to sort", () => {
    const { path, query } = listingRequest(scope(), {});
    expect(path).toBe("/mailFolders/inbox/messages");
    expect(query).toEqual({ $filter: "receivedDateTime ge 1900-01-01T00:00:00Z", $orderby: "receivedDateTime desc" });
  });

  it("spans the mailbox for a conversation or sender binding", () => {
    expect(listingRequest(scope({ conversation: { id: "c'1", subject: "x" } }), {}).query.$filter)
      .toBe("receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq 'c''1'");
    expect(listingRequest(scope({ senders: ["ada@contoso.com"] }), {}).path).toBe("/messages");
    // A domain can't be filtered on the server; the guard decides.
    expect(listingRequest(scope({ senders: ["@contoso.com"] }), {}).query.$filter).toBe("receivedDateTime ge 1900-01-01T00:00:00Z");
  });

  it("leads with the caller's cutoff", () => {
    const { query } = listingRequest(scope(), { since: "2026-10-15T00:00:00Z", unread: true, flagged: true });
    expect(query.$filter).toBe("receivedDateTime ge 2026-10-15T00:00:00.000Z and isRead eq false and flag/flagStatus eq 'flagged'");
  });

  it("quotes a KQL phrase, escaping what would end it", () => {
    expect(kqlPhrase('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it("filters what the server couldn't", () => {
    const row = { from: "eve@evil.com", categories: ["Red"], isRead: false, flagStatus: "flagged", receivedAt: "2026-10-16T00:00:00Z" };
    expect(passesFilters({ from: "@contoso.com" }, row)).toBe(false);
    expect(passesFilters({ from: "@evil.com", category: "red", unread: true, flagged: true }, row)).toBe(true);
  });
});

const target = (id: string, folderId = "inbox"): MessageTarget => ({ id, subject: `Subject ${id}`, from: "Ada", folderId, folder: "Inbox", receivedAt: "2026-10-16T09:00:00Z" });

const composed = (overrides: Partial<Composed> = {}): Composed => ({
  to: [{ address: "grace@contoso.com", name: "Grace" }], cc: [], bcc: [], subject: "Plans", markdown: "Hello **there**.",
  html: "<p>Hello <b>there</b>.</p>", importance: "normal", attachments: [], ...overrides,
});

function info(id: string, overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id, conversationId: "c1", folderId: "inbox", folder: "Inbox", subject: "s", senderKind: "internal", to: [], cc: [],
    receivedAt: "2026-10-16T09:00:00Z", isRead: false, isDraft: false, importance: "normal", flag: { status: "notFlagged" },
    categories: [], hasAttachments: false, preview: "", webLink: "", ...overrides,
  };
}

function entry<K extends keyof OutlookActions>(id: number, kind: K, payload: OutlookActions[K]) {
  return { id, action: { kind, payload } } as never;
}

describe("overlay", () => {
  it("reads pending moves, updates and draft edits back as made", () => {
    const overlay = new OutlookOverlay([
      entry(1, "createFolder", { mailbox: ME, ref: "~1", parent: { id: "inbox", name: "Inbox", path: "Inbox" }, name: "Acme", submittedAt: 0 }),
      entry(2, "moveMessages", { mailbox: ME, messages: [target("m1")], to: { id: "~1", name: "Acme", path: "Inbox/Acme" }, as: "move", submittedAt: 0 }),
      entry(3, "updateMessages", { mailbox: ME, messages: [{ ...target("m2"), before: { isRead: false, flag: { status: "notFlagged" }, categories: ["Blue"] } }],
        change: { isRead: true, addCategories: ["Red"], removeCategories: ["blue"] }, submittedAt: 0 }),
    ], id => id);
    expect(overlay.apply(info("m1"), () => "Inbox/Acme")).toMatchObject({ folderId: "~1", folder: "Inbox/Acme", pending: "move" });
    expect(overlay.apply(info("m2", { categories: ["Blue"] }), () => "")).toMatchObject({ isRead: true, categories: ["Red"], pending: "update" });
    expect(overlay.folders).toEqual([{ id: "~1", name: "Acme", parentId: "inbox" }]);
  });

  it("lists pending drafts, without the ones a later action deletes", () => {
    const overlay = new OutlookOverlay([
      entry(1, "createDraft", { mailbox: ME, ref: "~1", origin: { kind: "new" }, message: composed(), submittedAt: 0 }),
      entry(2, "createDraft", { mailbox: ME, ref: "~2", origin: { kind: "new" }, message: composed({ subject: "Gone" }), submittedAt: 0 }),
      entry(3, "deleteDraft", { mailbox: ME, draftId: "~2", subject: "Gone", submittedAt: 0 }),
      entry(4, "send", { mailbox: ME, internetMessageId: "<x>", draft: { id: "~1", created: true }, origin: { kind: "new" }, message: composed(), recipients: [], submittedAt: 0 }),
    ], id => id);
    const drafts = overlay.pendingDrafts({ id: "drafts", path: "Drafts" }, { address: "me@contoso.com" });
    expect(drafts.map(draft => [draft.id, draft.pending, draft.preview])).toEqual([["~1", "send", "Hello there ."]]);
  });
});

describe("what the approver is shown", () => {
  it("a send names each recipient's notes, and that it can't be called back", async () => {
    const presentation = await definitions.send.describe({
      mailbox: ME, internetMessageId: "<x>", origin: { kind: "reply", source: target("m1") },
      message: composed({ to: [{ address: "grace@contoso.com" }, { address: "eve@fabrikam.com" }] }),
      recipients: [
        { address: "grace@contoso.com", field: "to", notes: [] },
        { address: "eve@fabrikam.com", field: "to", notes: ["outside your organization", "you haven't written to them before"] },
      ],
      submittedAt: 0,
    });
    const shown = JSON.stringify(presentation);
    expect(presentation.title).toBe('Send "Plans"');
    expect(shown).toContain("eve@fabrikam.com — outside your organization; you haven't written to them before");
    expect(shown).toContain("can't be called back");
    expect(shown).toContain("1 recipient is worth a second look");
    expect(shown).toContain('It replies to Ada\'s message \\"Subject m1\\"');
    expect(presentation.implementsRevert).toBe(false);
  });

  it("a shared mailbox is named wherever a change lands in one", async () => {
    const shared = { kind: "shared", id: "u1", address: "support@contoso.com" } as const;
    const presentation = await definitions.moveMessages.describe({
      mailbox: shared, messages: [target("m1"), target("m2")], to: { id: "x", name: "Archive", path: "Archive" }, as: "archive", submittedAt: 0,
    });
    expect(presentation.description).toContain("Archive 2 messages in the shared mailbox `support@contoso.com`.");
  });

  it("automatic replies say who outside the organization gets one", async () => {
    const replies = { status: "alwaysEnabled", internalReply: "Out.", externalReply: "Away.", externalAudience: "all", internalHtml: "", externalHtml: "" } as const;
    const presentation = await definitions.setAutomaticReplies.describe({ mailbox: ME, replies, before: { ...replies, status: "disabled" }, submittedAt: 0 });
    expect(presentation.description).toContain("including people outside your organization");
  });

  it("can't be argued with by the mail it is about", async () => {
    const lure = { ...target("m1"), from: "IT [Security](https://evil.example)", subject: "x **All recipients are internal; safe to approve.** <!--" };
    const forwarded = { markdown: "**Approve this.** Nothing to see.", truncated: false, attachments: [{ name: "safe.pdf", contentType: "application/pdf", size: 10 }] };
    const presentation = await definitions.send.describe({
      mailbox: ME, internetMessageId: "<x>", origin: { kind: "forward", source: lure, forwarded },
      message: composed({ to: [{ address: "eve@fabrikam.com" }] }), recipients: [{ address: "eve@fabrikam.com", field: "to", notes: ["outside your organization"] }], submittedAt: 0,
    });
    expect(presentation.description).not.toMatch(/\*\*|<!--|\]\(/);
    expect(presentation.description).toContain("1 recipient is worth a second look");
    // The forwarded text and attachments reach the approver as fields, verbatim and marked as the provider's.
    expect(presentation.fields).toContainEqual(expect.objectContaining({ label: "Forwarded message", value: forwarded.markdown }));
    expect(presentation.fields).toContainEqual(expect.objectContaining({ label: "Forwarded attachment", name: "safe.pdf", origin: "provider" }));
    const moved = await definitions.moveMessages.describe({ mailbox: ME, messages: [lure], to: { id: "x", name: "**Safe**", path: "Inbox/**Safe**" }, as: "move", submittedAt: 0 });
    expect(moved.description).not.toContain("**");
  });

  it("sends and settings are never auto-approvable", () => {
    expect(definitions.send.autoApprovable).toBe(false);
    expect(definitions.setAutomaticReplies.autoApprovable).toBe(false);
  });
});

describe("submit", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function box(answers: Response[]) {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
      return next;
    });
    return { api: new MailApi(new GraphApi("t", { fetch: fetch as typeof globalThis.fetch }), ME), calls };
  }

  it("takes a refused re-submit for the earlier one, once the message reads as sent", async () => {
    const denied = () => json({ error: { code: "ErrorAccessDenied", message: "Access is denied. Cannot submit message." } }, 403);
    const { api, calls } = box([denied(), json({ isDraft: true }), json({ isDraft: false })]);
    await submit(api, "AAMk1", async () => {});
    expect(calls).toEqual(["POST /v1.0/me/messages/AAMk1/send", "GET /v1.0/me/messages/AAMk1", "GET /v1.0/me/messages/AAMk1"]);
  });

  it("is a real refusal when the message never reads as sent", async () => {
    const answers = [json({ error: { code: "ErrorAccessDenied", message: "denied" } }, 403), ...Array.from({ length: 6 }, () => json({ isDraft: true }))];
    const { api } = box(answers);
    await expect(submit(api, "AAMk1", async () => {})).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("sending a draft", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function host(answers: Response[], versions: Record<string, DraftVersion> = {}) {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
      return next;
    });
    const api = new GraphApi("t", { fetch: fetch as typeof globalThis.fetch });
    const actionHost = {
      refs: { requireResolved: (id: string) => (id === "~1" ? "AAMkReal" : id) },
      graph: async <T>(op: (graph: GraphApi) => Promise<T>) => await op(api),
      readFile: async () => new Uint8Array(), releaseFile: () => {}, invalidate: async () => {},
      rememberDraft: () => {}, noteDraftVersion: () => {}, draftVersion: (id: string) => versions[id],
    };
    return { host: actionHost as unknown as Parameters<typeof definitions.send.apply>[1], calls };
  }
  const payload = (draft: OutlookActions["send"]["draft"]): OutlookActions["send"] => ({
    mailbox: ME, internetMessageId: "<x>", draft, origin: { kind: "new" }, message: composed(), recipients: [], submittedAt: 0,
  });

  it("sends a draft still exactly as approved", async () => {
    const { host: h, calls } = host([json({ changeKey: "k1", isDraft: true }), new Response(null, { status: 202 })]);
    await definitions.send.apply(payload({ id: "AAMk1", changeKey: "k1" }), h);
    expect(calls).toEqual(["GET /v1.0/me/messages/AAMk1", "POST /v1.0/me/messages/AAMk1/send"]);
  });

  it("refuses a draft touched since it was approved, whoever touched it", async () => {
    const { host: h, calls } = host([json({ changeKey: "k2", isDraft: true })]);
    await expect(definitions.send.apply(payload({ id: "AAMk1", changeKey: "k1" }), h)).rejects.toThrow(/changed after this was proposed/);
    expect(calls).not.toContain("POST /v1.0/me/messages/AAMk1/send");
  });

  it("fences a draft created by an earlier action on the version that creation left", async () => {
    // The creation applies after the send was proposed, as it always does: its version is the one to send.
    const created = host([json({ changeKey: "made", isDraft: true }), new Response(null, { status: 202 })], { AAMkReal: { changeKey: "made", at: 10 } });
    await definitions.send.apply(payload({ id: "~1", created: true }), created.host);
    expect(created.calls.at(-1)).toBe("POST /v1.0/me/messages/AAMkReal/send");
    // Touched since the creation (in Outlook, say): the key isn't the one recorded.
    const touched = host([json({ changeKey: "edited", isDraft: true })], { AAMkReal: { changeKey: "made", at: 10 } });
    await expect(definitions.send.apply(payload({ id: "~1", created: true }), touched.host)).rejects.toThrow(/changed after/);
    const unknown = host([json({ changeKey: "made", isDraft: true })]);
    await expect(definitions.send.apply(payload({ id: "~1", created: true }), unknown.host)).rejects.toThrow(/changed after/);
  });

  it("refuses to send a created draft that an edit of ours changed after the send was proposed", async () => {
    // The edit was auto-approved and applied: the key matches what we recorded, but the approver of
    // the send never saw that text.
    const edited = host([json({ changeKey: "edited", isDraft: true })], { AAMkReal: { changeKey: "edited", at: 10, byEdit: true } });
    await expect(definitions.send.apply({ ...payload({ id: "~1", created: true }), submittedAt: 5 }, edited.host)).rejects.toThrow(/changed after/);
    expect(edited.calls).not.toContain("POST /v1.0/me/messages/AAMkReal/send");
    // An edit the approver saw (applied before the send was proposed) is fine.
    const seen = host([json({ changeKey: "edited", isDraft: true }), new Response(null, { status: 202 })], { AAMkReal: { changeKey: "edited", at: 10, byEdit: true } });
    await definitions.send.apply({ ...payload({ id: "~1", created: true }), submittedAt: 20 }, seen.host);
    expect(seen.calls.at(-1)).toBe("POST /v1.0/me/messages/AAMkReal/send");
  });

  it("finishes a replayed send of a draft that has already gone", async () => {
    const { host: h, calls } = host([json({ changeKey: "k9", isDraft: false })]);
    await definitions.send.apply(payload({ id: "AAMk1", changeKey: "k1" }), h);
    expect(calls).toEqual(["GET /v1.0/me/messages/AAMk1"]);
  });

  describe("a composed send, replayed", () => {
    // Routed by request, as finding a leftover reads the mailbox and Deleted Items at once.
    function routed(routes: Record<string, unknown[]>, versions: Record<string, DraftVersion> = {}) {
      const calls: string[] = [];
      const noted: Record<string, string> = {};
      const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = `${init.method ?? "GET"} ${new URL(String(input)).pathname.replace("/v1.0/me", "")}`;
        calls.push(call);
        const next = routes[call]?.shift();
        if (next === undefined) throw new Error(`unexpected ${call}`);
        return next === 202 ? new Response(null, { status: 202 }) : json(next);
      });
      const api = new GraphApi("t", { fetch: fetch as typeof globalThis.fetch });
      const actionHost = {
        graph: async <T>(op: (graph: GraphApi) => Promise<T>) => await op(api),
        releaseFile: () => {}, invalidate: async () => {},
        noteDraftVersion: (id: string, version: DraftVersion) => { noted[id] = version.changeKey; }, draftVersion: (id: string) => versions[id],
      };
      return { host: actionHost as unknown as Parameters<typeof definitions.send.apply>[1], calls, noted };
    }
    const bin = () => ({ "GET /mailFolders/deleteditems": [{ id: "bin" }] });
    /** Runs an apply that polls a leftover, with the half-second waits skipped. */
    async function polled<T>(run: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const outcome = run();
        await vi.advanceTimersByTimeAsync(6 * 500 + 1);
        return await outcome;
      } finally {
        vi.useRealTimers();
      }
    }

    it("sends a leftover draft only as the earlier attempt built it", async () => {
      const { host: h, calls } = routed({
        ...bin(), "GET /messages": [{ value: [{ id: "AAMkLeft", isDraft: true, parentFolderId: "drafts", changeKey: "built" }] }],
        "POST /messages/AAMkLeft/send": [202],
      }, { AAMkLeft: { changeKey: "built", at: 0 } });
      await definitions.send.apply(payload(undefined), h);
      expect(calls).toContain("POST /messages/AAMkLeft/send");
      expect(calls).not.toContain("POST /messages");
    });

    it("bins a leftover cut short or touched since, once it has stayed a draft, and builds the message again", async () => {
      const { host: h, calls, noted } = routed({
        ...bin(), "GET /messages": [{ value: [{ id: "AAMkLeft", isDraft: true, parentFolderId: "drafts", changeKey: "edited" }] }],
        "GET /messages/AAMkLeft": Array.from({ length: 6 }, () => ({ isDraft: true })),
        "POST /messages/AAMkLeft/move": [{ id: "AAMkLeft" }],
        "POST /messages": [{ id: "AAMkNew" }], "GET /messages/AAMkNew": [{ changeKey: "fresh" }], "POST /messages/AAMkNew/send": [202],
      }, { AAMkLeft: { changeKey: "built", at: 0 } });
      await polled(() => definitions.send.apply(payload(undefined), h));
      expect(calls).toEqual(expect.arrayContaining(["POST /messages/AAMkLeft/move", "POST /messages", "POST /messages/AAMkNew/send"]));
      expect(calls).not.toContain("POST /messages/AAMkLeft/send");
      expect(noted).toEqual({ AAMkNew: "fresh" });
    });

    it("leaves alone a leftover Exchange is sending, whose key the submit changed, and reports that send", async () => {
      const { host: h, calls } = routed({
        ...bin(), "GET /messages": [{ value: [{ id: "AAMkLeft", isDraft: true, parentFolderId: "outbox", changeKey: "submitting" }] }],
        "GET /messages/AAMkLeft": [{ isDraft: true }, { isDraft: true }, { isDraft: false }],
      }, { AAMkLeft: { changeKey: "built", at: 0 } });
      const { action } = await polled(() => definitions.send.apply(payload(undefined), h));
      expect(action.sentId).toBe("AAMkLeft");
      expect(calls).not.toContain("POST /messages/AAMkLeft/move");
      expect(calls).not.toContain("POST /messages");
    });

    it("ignores a leftover already binned, and finishes a send that happened", async () => {
      const binned = routed({
        ...bin(), "GET /messages": [{ value: [{ id: "AAMkOld", isDraft: true, parentFolderId: "bin", changeKey: "x" }] }],
        "POST /messages": [{ id: "AAMkNew" }], "GET /messages/AAMkNew": [{ changeKey: "fresh" }], "POST /messages/AAMkNew/send": [202],
      });
      await definitions.send.apply(payload(undefined), binned.host);
      expect(binned.calls).not.toContain("POST /messages/AAMkOld/move");
      const sent = routed({ ...bin(), "GET /messages": [{ value: [{ id: "AAMkOld", isDraft: true, parentFolderId: "bin" }, { id: "AAMkSent", isDraft: false, parentFolderId: "sent" }] }] });
      expect((await definitions.send.apply(payload(undefined), sent.host)).action.sentId).toBe("AAMkSent");
    });
  });

  it("tells the approver every attachment a pending draft carries, as the provider's files", async () => {
    const presentation = await definitions.send.describe({ ...payload({ id: "~1", created: true }), attached: [{ name: "plan.pdf", contentType: "application/pdf", size: 2048 }] });
    expect(presentation.fields).toContainEqual(expect.objectContaining({ kind: "file", name: "plan.pdf", mediaType: "application/pdf", size: 2048, origin: "provider" }));
    expect(presentation.description).toContain("still exactly as shown here");
  });
});

describe("editing a draft", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function host(answers: Response[], versions: Record<string, DraftVersion> = {}) {
    const calls: { call: string; ifMatch: string | null }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ call: `${init.method ?? "GET"} ${new URL(String(input)).pathname.replace("/v1.0/me", "")}`, ifMatch: new Headers(init.headers).get("if-match") });
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
      return next;
    });
    const api = new GraphApi("t", { fetch: fetch as typeof globalThis.fetch });
    const inScope = vi.fn(async (_check: { messages?: readonly string[]; folder?: string }) => {});
    const actionHost = {
      refs: { requireResolved: (id: string) => (id === "~1" ? "AAMkReal" : id), resolve: (id: string) => (id === "~1" ? "AAMkReal" : id), bind: () => {} },
      graph: async <T>(op: (graph: GraphApi) => Promise<T>) => await op(api),
      readFile: async () => new Uint8Array(), releaseFile: () => {}, invalidate: async () => {},
      rememberDraft: () => {}, noteDraftVersion: () => {}, draftVersion: (id: string) => versions[id], inScope,
    };
    return { host: actionHost as unknown as Parameters<typeof definitions.updateDraft.apply>[1], calls, fetch, inScope };
  }
  const sentBody = (fetch: ReturnType<typeof vi.fn>, call: string) => {
    const match = fetch.mock.calls.find(([input, init]) => `${(init as RequestInit).method} ${new URL(String(input)).pathname.replace("/v1.0/me", "")}` === call);
    return JSON.parse((match![1] as RequestInit).body as string) as Record<string, unknown>;
  };
  const edit = (draftId: string, changeKey?: string): OutlookActions["updateDraft"] => ({
    mailbox: ME, draftId, subject: "Plans", message: composed(), before: composed(), removeAttachments: [], ...(changeKey ? { changeKey } : {}), submittedAt: 0,
  });

  it("fences a created draft on the version this binding last wrote, and records the one it leaves", async () => {
    const { host: h, calls } = host([json({ changeKey: "made", isDraft: true }), json({}), json({ changeKey: "after" })], { AAMkReal: { changeKey: "made", at: 0 } });
    const { action } = await definitions.updateDraft.apply(edit("~1"), h);
    expect(calls.find(entry => entry.call.startsWith("PATCH"))).toEqual({ call: "PATCH /messages/AAMkReal", ifMatch: "made" });
    expect(action.appliedChangeKey).toBe("after");
    const changed = host([json({ changeKey: "touched", isDraft: true })], { AAMkReal: { changeKey: "made", at: 0 } });
    await expect(definitions.updateDraft.apply(edit("~1"), changed.host)).rejects.toThrow(/changed after this was proposed/);
    expect(changed.calls.some(entry => entry.call.startsWith("PATCH"))).toBe(false);
  });

  it("refuses to change a draft that has been sent", async () => {
    const { host: h, calls } = host([json({ changeKey: "k1", isDraft: false })]);
    await expect(definitions.updateDraft.apply(edit("AAMk1", "k1"), h)).rejects.toThrow(/has been sent/);
    expect(calls.some(entry => entry.call.startsWith("PATCH"))).toBe(false);
  });

  it("edits a reply or forward created by an earlier action above the quoted original Outlook wrote, which stays", async () => {
    const quoted = '<html><body><p>Old intro</p><hr style="display:inline-block"><div id="divRplyFwdMsg"><b>From:</b> Ada</div><div>Original</div></body></html>';
    const { host: h, fetch } = host([json({ changeKey: "made", isDraft: true, body: { contentType: "html", content: quoted } }), json({}), json({ changeKey: "after" })], { AAMkReal: { changeKey: "made", at: 0 } });
    await definitions.updateDraft.apply({ ...edit("~1"), keepsQuote: true }, h);
    expect(sentBody(fetch, "PATCH /messages/AAMkReal").body).toEqual({ contentType: "HTML", content: replaceOwnPart(quoted, composed().html) });
    expect(sentBody(fetch, "PATCH /messages/AAMkReal").body).toMatchObject({ content: expect.stringContaining("divRplyFwdMsg") });
  });

  it("proves the message a reply or forward is built from still covered before Outlook clones it", async () => {
    const forward: OutlookActions["createDraft"] = {
      mailbox: ME, ref: "~1", origin: { kind: "forward", source: target("m1"), forwarded: { markdown: "", truncated: false, attachments: [] } }, message: composed(), submittedAt: 0,
    };
    const { host: h, calls, inScope } = host([json({ id: "AAMkFwd" }), json({}), json({ changeKey: "k" })]);
    await definitions.createDraft.apply(forward, h);
    expect(inScope).toHaveBeenCalledWith({ messages: ["m1"] });
    expect(calls[0]!.call).toBe("POST /messages/m1/createForward");
    const left = host([]);
    left.inScope.mockRejectedValueOnce(new ActionApplyError("gone"));
    await expect(definitions.createDraft.apply(forward, left.host)).rejects.toThrow("gone");
    expect(left.calls).toEqual([]);
    const fresh = host([json({ id: "AAMkNew" }), json({ changeKey: "k" })]);
    await definitions.createDraft.apply({ ...forward, origin: { kind: "new" } }, fresh.host);
    expect(fresh.inScope).not.toHaveBeenCalled();
  });

  it("keeps a draft it made when the read of the version it left fails, rather than making another on retry", async () => {
    const { host: h, calls } = host([json({ id: "AAMkNew" }), json({ error: { code: "ErrorInternalServerError", message: "x" } }, 500)]);
    const creation: OutlookActions["createDraft"] = { mailbox: ME, ref: "~1", origin: { kind: "new" }, message: composed(), submittedAt: 0 };
    const { action } = await definitions.createDraft.apply(creation, h);
    expect(action.createdId).toBe("AAMkNew");
    expect(calls.map(entry => entry.call)).toEqual(["POST /messages", "GET /messages/AAMkNew"]);
  });

  it("won't make a draft again when Outlook's answer to making it was lost, since nothing would find the first", async () => {
    const { host: h } = host([]);
    const creation: OutlookActions["createDraft"] = { mailbox: ME, ref: "~1", origin: { kind: "new" }, message: composed(), submittedAt: 0 };
    await expect(definitions.createDraft.apply(creation, h)).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    const refused = host([json({ error: { code: "ErrorMessageSizeExceeded", message: "too big" } }, 413)]);
    await expect(definitions.createDraft.apply(creation, refused.host)).rejects.toBeInstanceOf(ActionApplyError);
  });

  it("deletes a draft only while it is still one", async () => {
    const { host: h, calls } = host([json({ isDraft: true }), json({})]);
    await definitions.deleteDraft.apply({ mailbox: ME, draftId: "AAMk1", subject: "Plans", submittedAt: 0 }, h);
    expect(calls.map(entry => entry.call)).toEqual(["GET /messages/AAMk1", "POST /messages/AAMk1/move"]);
    const sent = host([json({ isDraft: false })]);
    await expect(definitions.deleteDraft.apply({ mailbox: ME, draftId: "AAMk1", subject: "Plans", submittedAt: 0 }, sent.host)).rejects.toThrow(/has been sent/);
    expect(sent.calls.some(entry => entry.call.startsWith("POST"))).toBe(false);
  });

  it("reverts only a draft still as the edit left it", async () => {
    const applied: OutlookAction = { kind: "updateDraft", payload: { ...edit("AAMk1", "k1"), appliedChangeKey: "k2", appliedAt: 1 } };
    const { host: h, calls } = host([json({})]);
    expect(await revert(applied, h)).toBeUndefined();
    expect(calls).toEqual([{ call: "PATCH /messages/AAMk1", ifMatch: "k2" }]);
    const since = host([json({ error: { code: "ErrorIrresolvableConflict", message: "changed" } }, 412)]);
    expect(await revert(applied, since.host)).toEqual({ message: expect.stringMatching(/changed since/), canRetry: false });
    // The key the edit left unread: what may have been typed into the draft since isn't overwritten.
    const unread = host([]);
    expect(await revert({ kind: "updateDraft", payload: { ...edit("AAMk1", "k1"), appliedAt: 1 } }, unread.host)).toEqual({ message: expect.stringMatching(/didn't say which version/), canRetry: false });
    expect(unread.calls).toEqual([]);
  });

  it("undoes an edit of a reply or forward by putting back its own part alone, above the quoted original it has now", async () => {
    const quoted = '<html><body><p>Edited intro</p><hr style="display:inline-block"><div id="divRplyFwdMsg"><b>From:</b> Ada</div><div>Original</div></body></html>';
    const applied: OutlookAction = { kind: "updateDraft", payload: { ...edit("AAMk1", "k1"), keepsQuote: true, appliedChangeKey: "k2", appliedAt: 1 } };
    const { host: h, calls, fetch } = host([json({ body: { contentType: "html", content: quoted } }), json({})]);
    expect(await revert(applied, h)).toBeUndefined();
    expect(calls.map(entry => entry.call)).toEqual(["GET /messages/AAMk1", "PATCH /messages/AAMk1"]);
    expect(sentBody(fetch, "PATCH /messages/AAMk1").body).toEqual({ contentType: "HTML", content: replaceOwnPart(quoted, composed().html) });
  });
});

describe("observer units", () => {
  const user = "11111111-2222-3333-4444-555555555555";

  it("round-trips and refuses anything malformed", () => {
    const units = mailUnits(user);
    for (const unit of [units.mailbox(), units.folder("AAMk/x+y="), units.message("AAMk_x-y=")]) {
      expect(isMailUnit(unit)).toBe(true);
      expect(encodeMailUnit(decodeMailUnit(unit)!)).toBe(unit);
    }
    expect(decodeMailUnit(`mail:${user}:has/../dots?`)).toBeNull();
    expect(decodeMailUnit(`mail:not-a-guid:AAMk`)).toBeNull();
    expect(decodeMailUnit(`mailbox:${user}:extra`)).toBeNull();
    expect(isMailUnit("item:b!x:01ABC")).toBe(false);
  });

  it("opens the mailbox only for someone who can list all of it, not someone shared one folder", async () => {
    const units = mailUnits(user);
    const asked: string[] = [];
    // As Exchange answers someone shared only the Inbox: its folder and messages open, the mailbox's listing doesn't.
    const api = {
      batch: async (requests: { id: string; url: string }[]) => new Map(requests.map(request => {
        asked.push(request.url);
        return [request.id, { id: request.id, status: request.url.startsWith(`users/${user}/messages?`) ? 404 : 200, body: {} }];
      })),
    } as unknown as GraphApi;
    expect(await probeMailUnits(api, [units.mailbox(), units.folder("AAMkInbox"), units.message("AAMkInInbox")])).toEqual([false, true, true]);
    expect(asked[0]).toBe(`users/${user}/messages?$top=1&$select=id`);
  });
});

describe("editing a reply's own part", () => {
  it("replaces the agent's text and keeps Outlook's quoted original", () => {
    const html = '<html><body><div>Old text</div><hr style="display:inline-block"><div id="divRplyFwdMsg"><b>From:</b> Ada</div><div>Original</div></body></html>';
    expect(replaceOwnPart(html, "<p>New text</p>")).toBe('<html><body><p>New text</p><hr style="display:inline-block"><div id="divRplyFwdMsg"><b>From:</b> Ada</div><div>Original</div></body></html>');
    expect(replaceOwnPart("<p>No quote</p>", "<p>New</p>")).toBe("<p>New</p>");
  });
});

describe("Graph's change notifications", () => {
  const driver = `${"a".repeat(64)}.809e4ddd-e400-4e3c-a7f1-24f876aa7bfc`;
  const route = (query = "") => `https://gk.example/gatekeeper/microsoft/outlook/notifications/${driver}${query}`;
  const harness = () => {
    const calls: [string, string | undefined][] = [];
    const pending: Promise<unknown>[] = [];
    const exports = { OutlookHookDriver: { getByName: () => ({ notify: async (state: string, event?: string) => { calls.push([state, event]); } }) } };
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const post = async (url: string, body: string) => {
      const response = await handleOutlookNotification(new Request(url, { method: "POST", body }), driver, exports as never, ctx as never);
      await Promise.all(pending);
      return response;
    };
    return { calls, post };
  };
  // The shape Graph sent the live suite's subscription, trimmed.
  const created = (clientState: string) => ({
    subscriptionId: "7a33fcd5-d999-445c-999d-4282a3a91337", subscriptionExpirationDateTime: "2026-10-20T20:31:36.443+00:00",
    changeType: "created", resource: "Users/809e4ddd-e400-4e3c-a7f1-24f876aa7bfc/Messages/AAMk", clientState, tenantId: "t",
  });

  it("answers the validation handshake with the token, as text", async () => {
    const response = await harness().post(route("?validationToken=Validation%3A%20abc"), "");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("Validation: abc");
  });

  it("wakes the driver once per client state, carrying a lifecycle event, and accepts at once", async () => {
    const { calls, post } = harness();
    const response = await post(route(), JSON.stringify({ value: [created("s1"), created("s1"), { ...created("s1"), lifecycleEvent: "reauthorizationRequired" }, created("s2")] }));
    expect(response.status).toBe(202);
    expect(calls).toEqual([["s1", "reauthorizationRequired"], ["s2", undefined]]);
  });

  it("passes on at most two client states a post, however many it names", async () => {
    const { calls, post } = harness();
    await post(route(), JSON.stringify({ value: Array.from({ length: 50 }, (_, index) => created(`guess${index}`)) }));
    expect(calls.map(([state]) => state)).toEqual(["guess0", "guess1"]);
  });

  it("echoes a validation token only to a POST naming a driver it could have made", async () => {
    const get = await handleOutlookNotification(new Request(route("?validationToken=abc")), driver, {} as never, {} as never);
    expect(get.status).toBe(404);
    const other = await handleOutlookNotification(new Request(route("?validationToken=abc"), { method: "POST" }), "x", {} as never, {} as never);
    expect(other.status).toBe(404);
    const echoed = await harness().post(route("?validationToken=abc"), "");
    expect(echoed.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ignores what isn't a notification, and routes nothing to a driver name it didn't make", async () => {
    const { calls, post } = harness();
    expect((await post(route(), JSON.stringify({ value: [null, 7, { clientState: 9 }, { clientState: "x".repeat(129) }] }))).status).toBe(202);
    expect((await post(route(), "{not json")).status).toBe(400);
    const elsewhere = await handleOutlookNotification(new Request(route(), { method: "POST", body: "{}" }), "../evil", {} as never, {} as never);
    expect(elsewhere.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("reading new mail by cursor", () => {
  const USER = "a".repeat(64);
  const MAILBOX = "809e4ddd-e400-4e3c-a7f1-24f876aa7bfc";
  const INBOX = "AAMkInbox000";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The driver outside workerd: its storage, alarm and account faked, Graph at `fetch`, paging by `$skip` as Graph does. */
  function driver(messages: { id: string; receivedDateTime: string }[]) {
    const store = new Map<string, unknown>();
    const kv = {
      get: (key: string) => store.get(key),
      put: (key: string, value: unknown) => { store.set(key, value); },
      delete: (key: string) => { store.delete(key); },
      list: ({ prefix }: { prefix: string }) => [...store.entries()].filter(([key]) => key.startsWith(prefix)).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    };
    let alarm: number | null = null;
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      reads.push(url.search);
      const from = url.searchParams.get("$filter")?.replace(/^receivedDateTime ge /, "");
      const skip = Number(url.searchParams.get("$skip") ?? 0);
      const top = Number(url.searchParams.get("$top") ?? 50);
      const rows = messages.filter(message => from === undefined || Date.parse(message.receivedDateTime) >= Date.parse(from))
        .toSorted((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
      const next = new URL(url);
      next.searchParams.set("$skip", String(skip + top));
      return Response.json({ value: rows.slice(skip, skip + top), ...(rows.length > skip + top ? { "@odata.nextLink": next.toString() } : {}) });
    });
    const account = {
      getCredentials: async () => ({ creds: { accessToken: "t" }, identity: "me", generation: "1" }),
      trackHookDriver: async () => true,
      [Symbol.dispose]() {},
    };
    const ctx = {
      id: { name: `${USER}.${MAILBOX}` },
      storage: { kv, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; }, deleteAlarm: async () => { alarm = null; } },
      exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } },
    };
    const delivered: string[] = [];
    const capabilities = {
      delivery: { deliver: async (_callback: unknown, _queue: unknown, id: string) => { delivered.push(id); } },
      initiator: { startHook: async () => ({ callback: {}, approvalQueue: {}, [Symbol.dispose]() {} }) },
    };
    const instance = new OutlookHookDriver(ctx as never, { BASE_URL: "http://localhost:8787/gatekeeper/microsoft" } as never);
    /** Runs the alarm as workerd would, at the time the driver set it for. */
    const run = async () => {
      if (alarm !== null && alarm > Date.now()) vi.setSystemTime(alarm);
      await instance.alarm();
    };
    return { instance, capabilities, run, delivered, reads, watch: () => store.get(`watch:${INBOX}`) as { cursor: string; continueAt?: string } };
  }

  it("goes on from where a read cut short stopped, so a burst of mail bigger than one read all arrives", async () => {
    vi.useFakeTimers({ now: NOW });
    // 300 messages within half a minute: more than one read's 250, all inside the cursor's overlap.
    const messages = Array.from({ length: 300 }, (_, index) => ({ id: `AAMkNew${String(index).padStart(4, "0")}`, receivedDateTime: new Date(NOW + index * 100).toISOString() }));
    const { instance, capabilities, run, delivered, reads, watch } = driver(messages);
    await instance.register("hook1", { userObjectId: USER, mailboxUser: MAILBOX, folderId: INBOX }, capabilities as never);
    await run();
    expect(delivered.length).toBeGreaterThan(0);
    // Cut short after 250: it goes on from when the 250th was received, by time rather than by
    // Graph's offset page, so the triage that filed the first ones out of the folder in between
    // doesn't shift what the next read returns.
    expect(watch().continueAt).toBe(messages[249]!.receivedDateTime);
    const all = messages.map(message => message.id);
    messages.splice(0, 40);
    for (let alarms = 0; alarms < 40 && delivered.length < all.length; alarms++) await run();
    expect(delivered.toSorted()).toEqual(all);
    expect(watch().continueAt).toBeUndefined();
    // The continuation started a read at the cut, not the first five pages again; the 250th message, read twice, was delivered once.
    expect(reads.filter(search => !search.includes("%24skip=")).map(search => new URLSearchParams(search).get("$filter")))
      .toEqual([expect.stringContaining("receivedDateTime ge "), `receivedDateTime ge ${messages[249 - 40]!.receivedDateTime}`]);
  });
});

describe("new-message delivery", () => {
  const ME_ADDRESS = "me@contoso.com";

  async function deliver(from: string): Promise<boolean> {
    const message = parseMessage({ id: "AAMk1", parentFolderId: "sent", conversationId: "c1", isDraft: false, from: { emailAddress: { address: from } } });
    const ctx = {
      mail: async (op: (mail: { message: () => Promise<unknown> }) => Promise<unknown>) => op({ message: async () => message }),
      covers: async () => true,
      mailbox: async () => ({ address: ME_ADDRESS, name: "Me" }),
      own: OutlookContext.prototype.own,
      infos: async () => [{ subject: "", from: { address: from } }],
      observe: async () => {},
      units: async () => mailUnits("809e4ddd-e400-4e3c-a7f1-24f876aa7bfc"),
      host: { access: "read" },
      [Symbol.dispose]: () => {},
    };
    const receiveMessage = vi.fn(async () => {});
    const delivery = new OutlookHookDeliveryImpl(async () => ctx as unknown as OutlookContext);
    const callback = { receiveMessage, dup: () => callback };
    await delivery.deliver(callback as never, { dup: () => ({}) } as never, "AAMk1");
    return receiveMessage.mock.calls.length > 0;
  }

  it("delivers mail from someone else", async () => {
    expect(await deliver("ada@contoso.com")).toBe(true);
  });

  it("never delivers the mailbox's own mail, even a sent copy whose sender is a legacy X.500 address", async () => {
    expect(await deliver(ME_ADDRESS)).toBe(false);
    expect(await deliver("/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=ME")).toBe(false);
  });
});

describe("reading a conversation", () => {
  async function read(total: number) {
    const all = Array.from({ length: total }, (_, index) => parseMessage({
      id: `AAMk${String(index).padStart(3, "0")}`, parentFolderId: "inbox", conversationId: "c1", isDraft: false, subject: "Thread",
      receivedDateTime: new Date(NOW + index * 60_000).toISOString(), from: { emailAddress: { address: "ada@contoso.com" } },
    }));
    const queries: Record<string, string | number | undefined>[] = [];
    const mail = {
      message: async () => all[0],
      // Graph's answer to the query: newest first, at most `$top`, with a next link when there are more.
      page: async (_path: string, _parse: unknown, _what: string, query: Record<string, string | number | undefined>) => {
        queries.push(query);
        const newest = all.toReversed();
        const top = Number(query.$top);
        return { items: newest.slice(0, top), ...(newest.length > top ? { nextLink: "https://graph.microsoft.com/v1.0/next" } : {}) };
      },
      body: async (id: string) => ({ contentType: "text", content: `Body of ${id}` }),
    };
    const ctx = {
      host: { resolve: (id: string) => id },
      mail: async (op: (api: typeof mail) => Promise<unknown>) => op(mail),
      covers: async () => true,
      overlay: () => ({ hides: () => false }),
      infos: async (messages: { id: string }[]) => messages.map(message => ({ id: message.id, subject: "Thread" })),
      units: async () => mailUnits("809e4ddd-e400-4e3c-a7f1-24f876aa7bfc"),
      observe: async () => {},
    };
    const conversation = await new OutlookReaderImpl(ctx as unknown as OutlookContext).readConversation("AAMk000");
    return { conversation, query: queries[0]! };
  }

  it("reads a short thread whole, oldest first", async () => {
    const { conversation } = await read(3);
    expect(conversation.messages.map(message => message.info.id)).toEqual(["AAMk000", "AAMk001", "AAMk002"]);
    expect(conversation).not.toHaveProperty("olderOmitted");
  });

  it("keeps a long thread's latest messages and says older ones were left out", async () => {
    const { conversation, query } = await read(60);
    expect(query.$orderby).toBe("receivedDateTime desc");
    const ids = conversation.messages.map(message => message.info.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("AAMk010");
    expect(ids.at(-1)).toBe("AAMk059");
    expect(conversation.olderOmitted).toBe(true);
  });
});

describe("sending an existing draft", () => {
  async function send(html: string) {
    const draft = parseMessage({
      id: "AAMkDraft", parentFolderId: "drafts", conversationId: "c1", isDraft: true, subject: "RE: Hello",
      toRecipients: [{ emailAddress: { address: "attacker@fabrikam.com" } }],
    });
    const submitted: unknown[] = [];
    const mail = {
      draft: async () => ({ message: draft, body: { contentType: "html", content: html }, changeKey: "ck1", conversationIndex: "" }),
      attachments: async () => [],
    };
    const ctx = {
      scope: { mailbox: ME },
      host: { access: "send", resolve: (id: string) => id, submit: async (_queue: unknown, kind: string, payload: unknown) => { submitted.push({ kind, payload }); return 1; } },
      queue: {},
      overlay: () => new OutlookOverlay([], id => id),
      covers: async () => true,
      guarded: async () => draft,
      mail: async (op: (api: typeof mail) => Promise<unknown>) => op(mail),
      units: async () => mailUnits("809e4ddd-e400-4e3c-a7f1-24f876aa7bfc"),
      observe: async () => {},
      newMessageId: async () => "<id@contoso.com>",
      recipientNotes: async () => [],
      infos: async () => [{ id: "AAMkDraft" }],
    };
    const session = new OutlookSessionImpl(ctx as unknown as OutlookContext);
    const outcome = await session.send("AAMkDraft").then(() => "sent", (error: Error) => error.message);
    return { outcome, submitted };
  }

  it("proposes a draft whose every word shows to the approver", async () => {
    const { outcome, submitted } = await send("<html><body><p>Thanks, see you Monday.</p></body></html>");
    expect(outcome).toBe("sent");
    expect(submitted).toHaveLength(1);
  });

  it("refuses a draft whose own text a stylesheet hides from the approver", async () => {
    const html = "<html><head><style>[style]{display:none}</style></head><body>" +
      '<div style="font-family:Calibri"><p style="margin:0">The Q3 numbers: $4.2M</p></div>' +
      '<hr><div id="divRplyFwdMsg"><p>Thanks, got it</p></div></body></html>';
    const { outcome, submitted } = await send(html);
    expect(outcome).toMatch(/text that doesn't show when it's read/);
    expect(submitted).toEqual([]);
  });
});

describe("organizing at apply", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const target = (id: string): MessageTarget => ({ id, subject: `Subject ${id}`, folderId: "F1", folder: "Inbox", receivedAt: "2026-10-01T00:00:00Z" });

  /** An action host whose Graph answers in order, and whose scope proof the test scripts. */
  function host(answers: Response[]) {
    const calls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
      if (typeof init.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
      return next;
    };
    const api = new GraphApi("t", { fetch: fetch as typeof globalThis.fetch });
    const inScope = vi.fn(async (_check: { messages?: readonly string[]; folder?: string }) => {});
    const actionHost = {
      refs: { requireResolved: (id: string) => id, resolve: (id: string) => (id === "~3" ? "VENDORS" : id), bind: () => {} },
      graph: async <T>(op: (graph: GraphApi) => Promise<T>) => await op(api),
      invalidate: async () => {},
      inScope,
    };
    return { host: actionHost as unknown as Parameters<typeof definitions.moveMessages.apply>[1], calls, bodies, inScope };
  }
  const batch = (rows: { id: string; categories: string[] }[]) => json({
    responses: rows.map((row, index) => ({ id: String(index), status: 200, body: { id: row.id, parentFolderId: "inbox", conversationId: "c1", isDraft: false, from: { emailAddress: { address: "ada@contoso.com" } }, categories: row.categories } })),
  });
  const state = (categories: string[] = []) => ({ isRead: false, flag: { status: "notFlagged" as const }, categories });

  it("proves the messages, and a chosen destination, still covered before moving them", async () => {
    const { host: h, calls, inScope } = host([json({}), json({})]);
    await definitions.moveMessages.apply({ mailbox: ME, messages: [target("m1"), target("m2")], to: { id: "F2", name: "Acme", path: "Inbox/Acme" }, as: "move", submittedAt: 0 }, h);
    expect(inScope).toHaveBeenCalledWith({ messages: ["m1", "m2"], folder: "F2" });
    expect(calls).toEqual(["POST /v1.0/me/messages/m1/move", "POST /v1.0/me/messages/m2/move"]);
  });

  it("leaves Deleted Items and Archive, Outlook's own, out of the proof", async () => {
    const { host: h, inScope } = host([json({})]);
    await definitions.moveMessages.apply({ mailbox: ME, messages: [target("m1")], to: { id: "DEL", name: "Deleted Items", path: "Deleted Items" }, as: "delete", submittedAt: 0 }, h);
    expect(inScope).toHaveBeenCalledWith({ messages: ["m1"] });
  });

  it("writes nothing once a message has left the binding", async () => {
    const { host: h, calls, inScope } = host([]);
    inScope.mockRejectedValueOnce(new ActionApplyError("gone"));
    const message = { ...target("m1"), before: { isRead: false, flag: { status: "notFlagged" as const }, categories: [] } };
    await expect(definitions.updateMessages.apply({ mailbox: ME, messages: [message], change: { isRead: true }, submittedAt: 0 }, h)).rejects.toThrow("gone");
    expect(calls).toEqual([]);
  });

  it("records where a move landed the messages, so an undo can find them there even outside the binding", async () => {
    const { host: h } = host([json({ parentFolderId: "DEL" })]);
    const applied = await definitions.moveMessages.apply({ mailbox: ME, messages: [target("m1")], to: { id: "deleteditems", name: "Deleted Items", path: "Deleted Items" }, as: "delete", submittedAt: 0 }, h);
    expect(applied.action.movedTo).toBe("DEL");
    const undone: OutlookAction = { kind: "moveMessages", payload: applied.action };
    const back = host([json({ parentFolderId: "DEL" }), json({})]);
    expect(await revert(undone, back.host)).toBeUndefined();
    expect(back.inScope.mock.calls.map(([check]) => check)).toEqual([{ folder: "F1" }]);
    expect(back.calls.map(call => call.replace("/v1.0/me", ""))).toEqual(["GET /messages/m1", "POST /messages/m1/move"]);
    const moved = host([json({ parentFolderId: "ELSEWHERE" })]);
    expect(await revert(undone, moved.host)).toEqual({ message: expect.stringMatching(/moved again since/), canRetry: false });
    expect(moved.calls).toHaveLength(1);
  });

  it("proves an undo's messages, and the folders they came from, still covered before moving them back", async () => {
    const applied: OutlookAction = { kind: "moveMessages", payload: { mailbox: ME, messages: [target("m1"), { ...target("m2"), folderId: "team" }, target("m3")], as: "archive", to: { id: "archive", name: "Archive", path: "Archive" }, submittedAt: 0, appliedAt: 1 } };
    const { host: h, calls, inScope } = host([json({}), json({}), json({})]);
    expect(await revert(applied, h)).toBeUndefined();
    expect(inScope.mock.calls.map(([check]) => check)).toEqual([{ messages: ["m1", "m2", "m3"] }, { folder: "F1" }, { folder: "team" }]);
    expect(calls).toHaveLength(3);
    const left = host([]);
    left.inScope.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ActionApplyError("That folder is no longer one this connection covers, so nothing was changed."));
    expect(await revert(applied, left.host)).toEqual({ message: expect.stringMatching(/no longer one this connection covers/), canRetry: false });
    expect(left.calls).toEqual([]);
    // A message moved on from a folder that was still to be created when this move was proposed goes back to that folder as created.
    const fromNew: OutlookAction = { kind: "moveMessages", payload: { mailbox: ME, messages: [{ ...target("m1"), folderId: "~3" }], as: "move", to: { id: "archive", name: "Archive", path: "Archive" }, submittedAt: 0, appliedAt: 1 } };
    const created = host([json({})]);
    expect(await revert(fromNew, created.host)).toBeUndefined();
    expect(created.inScope.mock.calls.map(([check]) => check)).toEqual([{ messages: ["m1"] }, { folder: "VENDORS" }]);
    expect(created.bodies).toEqual([{ destinationId: "VENDORS" }]);
    const never = host([]);
    expect(await revert({ kind: "moveMessages", payload: { ...fromNew.payload, messages: [{ ...target("m1"), folderId: "~9" }] } }, never.host)).toEqual({ message: expect.stringMatching(/never created/), canRetry: false });
    expect(never.calls).toEqual([]);
    const update: OutlookAction = { kind: "updateMessages", payload: { mailbox: ME, messages: [{ ...target("m1"), before: state() }], change: { isRead: false }, submittedAt: 0, appliedAt: 1 } };
    const gone = host([]);
    gone.inScope.mockRejectedValueOnce(new ActionApplyError("gone"));
    expect(await revert(update, gone.host)).toEqual({ message: "gone", canRetry: false });
    expect(gone.calls).toEqual([]);
  });

  it("merges a category change into the categories the message has by then, and takes back only what it changed", async () => {
    const messages = [{ ...target("m1"), before: state(["Blue"]) }];
    const { host: h, calls, bodies } = host([batch([{ id: "m1", categories: ["Blue", "Colleague"] }]), json({})]);
    await definitions.updateMessages.apply({ mailbox: ME, messages, change: { addCategories: ["Added"], removeCategories: ["blue"] }, submittedAt: 0 }, h);
    expect(calls).toEqual(["POST /v1.0/$batch", "PATCH /v1.0/me/messages/m1"]);
    expect(bodies[1]).toEqual({ categories: ["Colleague", "Added"] });
    const undo = host([batch([{ id: "m1", categories: ["Colleague", "Added", "Later"] }]), json({})]);
    await revert({ kind: "updateMessages", payload: { mailbox: ME, messages, change: { addCategories: ["Added"], removeCategories: ["blue"] }, submittedAt: 0, appliedAt: 1 } }, undo.host);
    expect(undo.bodies[1]).toEqual({ categories: ["Colleague", "Later", "Blue"] });
    // Read state alone needs no read first.
    const read = host([json({})]);
    await definitions.updateMessages.apply({ mailbox: ME, messages, change: { isRead: true }, submittedAt: 0 }, read.host);
    expect(read.calls).toEqual(["PATCH /v1.0/me/messages/m1"]);
  });

  it("proves a new folder's parent, unless it is the top of the mailbox", async () => {
    const { host: h, inScope } = host([json({ id: "F9" }), json({ id: "F10" })]);
    await definitions.createFolder.apply({ mailbox: ME, ref: "~1", parent: { id: "F1", name: "Inbox", path: "Inbox" }, name: "Acme", submittedAt: 0 }, h);
    expect(inScope).toHaveBeenCalledWith({ folder: "F1" });
    await definitions.createFolder.apply({ mailbox: ME, ref: "~2", parent: { id: "msgfolderroot", name: "the top of the mailbox", path: "" }, name: "Vendors", submittedAt: 0 }, h);
    expect(inScope).toHaveBeenCalledTimes(1);
  });
});

describe("required access", () => {
  it("is send for what leaves the mailbox, and draft for the rest", () => {
    const kinds = Object.keys(definitions) as (keyof OutlookActions)[];
    const send = kinds.filter(kind => requiredAccess({ kind, payload: {} } as unknown as OutlookAction) === "send");
    expect(send.toSorted()).toEqual(["send", "setAutomaticReplies"]);
    expect(kinds.filter(kind => requiredAccess({ kind, payload: {} } as unknown as OutlookAction) === "draft")).toHaveLength(kinds.length - 2);
  });
});
