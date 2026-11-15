// How the actions pending on one Outlook message fold over it: which actions `messageView` files
// under which message, what each does to a message in `messageStore`, and the fold held, over
// generated queues, to a reading of the whole queue from maps.

import { describe, expect, it } from "vitest";
import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { Composed, MessageTarget, OutlookAction, OutlookActions } from "../src/outlook-actions";
import { OutlookOverlay, messageStore, messageView } from "../src/outlook-overlay";
import type { MessageInfo } from "../src/outlook-types";

type Entry = JournalEntry<OutlookAction>;
type Change = OutlookActions["updateMessages"]["change"];

const ME = { kind: "me" } as const;
const DRAFTS = { folder: { id: "drafts", path: "Drafts" }, mailbox: { address: "me@contoso.com" } };
const identity = (id: string) => id;
/** The path a test gives the folder a pending move names. */
const name = (id: string) => `path:${id}`;

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

/** A draft Exchange holds. */
const draft = (id: string, overrides: Partial<MessageInfo> = {}) => info(id, { folderId: "drafts", folder: "Drafts", isDraft: true, isRead: true, ...overrides });

function entry<K extends keyof OutlookActions>(id: number, kind: K, payload: OutlookActions[K]): Entry {
  return { id, action: { kind, payload } } as never;
}

const move = (id: number, messages: string[], to: string, as: OutlookActions["moveMessages"]["as"] = "move") =>
  entry(id, "moveMessages", { mailbox: ME, messages: messages.map(message => target(message)), to: { id: to, name: to, path: to }, as, submittedAt: 0 });

const update = (id: number, messages: string[], change: Change) => entry(id, "updateMessages", {
  mailbox: ME, messages: messages.map(message => ({ ...target(message), before: { isRead: false, flag: { status: "notFlagged" as const }, categories: [] } })), change, submittedAt: 0,
});

const createDraft = (id: number, ref: string, overrides: Partial<Composed> = {}, submittedAt = 0) =>
  entry(id, "createDraft", { mailbox: ME, ref, origin: { kind: "new" }, message: composed(overrides), submittedAt });

function updateDraft(id: number, draftId: string, overrides: Partial<Composed> = {}) {
  const { attachments: _attachments, ...before } = composed();
  return entry(id, "updateDraft", { mailbox: ME, draftId, subject: "s", message: composed(overrides), before, removeAttachments: [], submittedAt: 0 });
}

const deleteDraft = (id: number, draftId: string) => entry(id, "deleteDraft", { mailbox: ME, draftId, subject: "s", submittedAt: 0 });

/** A send of the draft `draftId`, or of a message composed straight to sending. */
const send = (id: number, draftId?: string) => entry(id, "send", {
  mailbox: ME, internetMessageId: `<${id}>`, ...(draftId ? { draft: { id: draftId, created: true as const } } : {}),
  origin: { kind: "new" }, message: composed(), recipients: [], submittedAt: 0,
});

const createFolder = (id: number, ref: string) =>
  entry(id, "createFolder", { mailbox: ME, ref, parent: { id: "inbox", name: "Inbox", path: "Inbox" }, name: "Acme", submittedAt: 0 });

function automaticReplies(id: number) {
  const replies = { status: "alwaysEnabled", internalReply: "Out.", externalReply: "Away.", externalAudience: "all", internalHtml: "", externalHtml: "" } as const;
  return entry(id, "setAutomaticReplies", { mailbox: ME, replies, before: { ...replies, status: "disabled" }, submittedAt: 0 });
}

/**
 * The message `id` with the records of `pending` that target it, less those `keep` leaves out,
 * folded over `base`: a move's folder is the one its ID resolves to, with `name`'s path.
 */
function fold(id: string, base: MessageInfo | undefined, pending: readonly Entry[], resolve = identity, keep: (record: Entry) => boolean = () => true): MessageInfo | undefined {
  const store = messageStore({ destination: named => ({ id: resolve(named), path: name(resolve(named)) }), drafts: DRAFTS });
  return store.fold(id, base, messageView(pending, resolve).forTarget(id).filter(keep)).entity;
}

const ids = (records: readonly Entry[]) => records.map(record => record.id);

describe("messageView", () => {
  it("indexes a move and an update under every message they name", () => {
    const view = messageView([move(1, ["m1", "m2"], "archive"), update(2, ["m2", "m3"], { isRead: true }), move(3, ["m3"], "~9")], () => "resolved");
    expect(ids(view.forTarget("m1"))).toEqual([1]);
    expect(ids(view.forTarget("m2"))).toEqual([1, 2]);
    expect(ids(view.forTarget("m3"))).toEqual([2, 3]);
    // A message's ID is Exchange's own, so it is never resolved.
    expect(view.forTarget("resolved")).toEqual([]);
  });

  it("indexes a draft's edit, deletion and send under the ID its temporary ID resolved to, and its creation under the temporary ID", () => {
    const pending = [createDraft(1, "~1"), updateDraft(2, "~1"), deleteDraft(3, "~1"), send(4, "~1"), createDraft(5, "~2"), updateDraft(6, "~2")];
    const view = messageView(pending, id => (id === "~1" ? "real-1" : id));
    expect(ids(view.forTarget("real-1"))).toEqual([2, 3, 4]);
    expect(ids(view.forTarget("~1"))).toEqual([1]);
    expect(ids(view.forTarget("~2"))).toEqual([5, 6]);
  });

  it("indexes folders, automatic replies and a message composed straight to sending under no message", () => {
    const resolved: string[] = [];
    const view = messageView([createFolder(1, "~9"), automaticReplies(2), send(3)], id => {
      resolved.push(id);
      return id;
    });
    expect(view.all()).toHaveLength(3);
    for (const id of ["~9", "inbox", "<3>", ""]) expect(view.forTarget(id)).toEqual([]);
    expect(resolved).toEqual([]);
  });
});

describe("messageStore", () => {
  it("reads a message a pending move files elsewhere from where it is going", () => {
    const base = info("m1");
    expect(fold("m1", base, [move(1, ["m1"], "archive")])).toEqual({ ...base, folderId: "archive", folder: "path:archive", pending: "move" });
    // A folder that is itself pending is read under the ID it resolves to.
    expect(fold("m1", base, [move(1, ["m1"], "~9")])).toMatchObject({ folderId: "~9", folder: "path:~9", pending: "move" });
    expect(fold("m1", base, [move(1, ["m1"], "~9")], id => (id === "~9" ? "acme" : id))).toMatchObject({ folderId: "acme", folder: "path:acme", pending: "move" });
  });

  it("marks a pending deletion as delete, and a later move as move", () => {
    const base = info("m1");
    const deletion = move(1, ["m1"], "deleteditems", "delete");
    expect(fold("m1", base, [deletion])).toEqual({ ...base, folderId: "deleteditems", folder: "path:deleteditems", pending: "delete" });
    expect(fold("m1", base, [deletion, move(2, ["m1"], "archive", "archive")])).toEqual({ ...base, folderId: "archive", folder: "path:archive", pending: "move" });
    expect(fold("m1", base, [move(1, ["m1"], "archive"), move(2, ["m1"], "deleteditems", "delete")])).toMatchObject({ folderId: "deleteditems", pending: "delete" });
  });

  it("reads a message moved away and back as never moved", () => {
    const base = info("m1");
    const entity = fold("m1", base, [move(1, ["m1"], "archive"), move(2, ["m1"], "inbox")]);
    expect(entity).toEqual(base);
    expect(entity).toMatchObject({ folderId: "inbox", folder: "Inbox" });
    expect("pending" in entity!).toBe(false);
    // A move to the folder Exchange holds it in, with no move away before it, changes nothing.
    expect(fold("m1", base, [move(1, ["m1"], "inbox")])).toBe(base);
  });

  it("keeps update on a message moved away and back while it still shows a pending change", () => {
    const base = info("m1", { isRead: false });
    const read = { ...base, isRead: true, pending: "update" };
    expect(fold("m1", base, [update(1, ["m1"], { isRead: true }), move(2, ["m1"], "archive"), move(3, ["m1"], "inbox")])).toEqual(read);
    expect(fold("m1", base, [move(1, ["m1"], "archive"), update(2, ["m1"], { isRead: true }), move(3, ["m1"], "inbox")])).toEqual(read);
  });

  it("shows nothing pending on a message moved away and back whose pending update changes nothing it shows", () => {
    const base = info("m1", { isRead: true });
    const pending = [update(1, ["m1"], { isRead: true }), move(2, ["m1"], "archive"), move(3, ["m1"], "inbox")];
    const entity = fold("m1", base, pending);
    expect(entity).toEqual(base);
    expect("pending" in entity!).toBe(false);
    // A reading from the last move and the list of updates cannot tell that the update shows nothing.
    expect(new OutlookOverlay(pending, identity).apply(base, name).pending).toBe("update");
  });

  it("marks an update that changes nothing the row shows, on a message that was not moved", () => {
    const base = info("m1", { isRead: true });
    const pending = [update(1, ["m1"], { isRead: true })];
    const entity = fold("m1", base, pending);
    expect(entity).toEqual({ ...base, pending: "update" });
    expect(entity).toEqual(new OutlookOverlay(pending, identity).apply(base, name));
  });

  it("never lowers what is pending: an update after a move leaves move, and nothing lowers send", () => {
    expect(fold("m1", info("m1"), [move(1, ["m1"], "archive"), update(2, ["m1"], { isRead: true })]))
      .toMatchObject({ folderId: "archive", isRead: true, pending: "move" });
    const base = draft("d1");
    expect(fold("d1", base, [send(1, "d1"), update(2, ["d1"], { isRead: false }), updateDraft(3, "d1", { subject: "Later" }), move(4, ["d1"], "archive", "delete")]))
      .toMatchObject({ folderId: "archive", isRead: false, subject: "Later", pending: "send" });
    expect(fold("d1", base, [move(1, ["d1"], "archive"), send(2, "d1"), move(3, ["d1"], "drafts")])).toEqual({ ...base, pending: "send" });
  });

  it("applies updates in order: categories without regard to case, read state, and a flag's due date only while flagged", () => {
    const base = info("m1", { categories: ["Blue", "Green"] });
    const flagged = [
      update(1, ["m1"], { addCategories: ["RED"], removeCategories: ["blue"] }),
      update(2, ["m1"], { addCategories: ["red"], isRead: true }),
      update(3, ["m1"], { isRead: false, flag: { status: "flagged", dueAt: "2026-11-01T00:00:00Z" } }),
    ];
    expect(fold("m1", base, flagged)).toEqual({
      ...base, categories: ["Green", "red"], isRead: false, flag: { status: "flagged", dueAt: "2026-11-01T00:00:00Z" }, pending: "update",
    });
    const completed = fold("m1", base, [...flagged, update(4, ["m1"], { flag: { status: "complete", dueAt: "2026-11-01T00:00:00Z" } })]);
    expect(completed?.flag).toEqual({ status: "complete" });
    expect(completed?.flag).not.toHaveProperty("dueAt");
  });

  it("takes the latest edit of a draft, and none on a message that is not a draft", () => {
    const base = draft("d1");
    const edits = [updateDraft(1, "d1", { subject: "First", importance: "high" }), updateDraft(2, "d1", { subject: "Second", markdown: "**Bye**" })];
    expect(fold("d1", base, edits)).toEqual({
      ...base, subject: "Second", to: [{ address: "grace@contoso.com", name: "Grace" }], cc: [], bcc: [], importance: "normal", preview: "Bye",
      hasAttachments: false, pending: "update",
    });
    const message = info("m1");
    expect(fold("m1", message, [updateDraft(1, "m1", { subject: "First" })])).toBe(message);
  });

  it("removes a draft a pending action deletes, whatever follows", () => {
    expect(fold("d1", draft("d1"), [deleteDraft(1, "d1")])).toBeUndefined();
    expect(fold("d1", draft("d1"), [updateDraft(1, "d1"), deleteDraft(2, "d1"), updateDraft(3, "d1", { subject: "Later" }), send(4, "d1")])).toBeUndefined();
    expect(fold("~1", undefined, [createDraft(1, "~1"), deleteDraft(2, "~1"), updateDraft(3, "~1"), send(4, "~1")])).toBeUndefined();
  });

  it("makes a pending draft from its creation, with its later edit and send", () => {
    const submittedAt = Date.parse("2026-10-17T12:00:00Z");
    const created = createDraft(1, "~1", {}, submittedAt);
    const standIn = {
      id: "~1", conversationId: "", folderId: "drafts", folder: "Drafts", subject: "Plans", to: [{ address: "grace@contoso.com", name: "Grace" }], cc: [], bcc: [],
      importance: "normal", preview: "Hello there .", hasAttachments: false, from: { address: "me@contoso.com" }, senderKind: "you",
      receivedAt: "2026-10-17T12:00:00.000Z", isRead: true, isDraft: true, flag: { status: "notFlagged" }, categories: [], webLink: "", pending: "draft",
    };
    expect(fold("~1", undefined, [created])).toEqual(standIn);
    const edited = [created, updateDraft(2, "~1", { subject: "Changed" })];
    expect(fold("~1", undefined, edited)).toEqual({ ...standIn, subject: "Changed" });
    expect(fold("~1", undefined, [...edited, send(3, "~1")])).toEqual({ ...standIn, subject: "Changed", pending: "send" });
    // A reply's draft is in the conversation it answers.
    const reply = entry(1, "createDraft", { mailbox: ME, ref: "~1", origin: { kind: "reply", source: { ...target("m1"), conversationId: "c7" } }, message: composed(), submittedAt });
    expect(fold("~1", undefined, [reply])).toMatchObject({ conversationId: "c7", pending: "draft" });
  });

  it("makes no pending draft without somewhere to list it", () => {
    const view = messageView([createDraft(1, "~1"), updateDraft(2, "~1"), send(3, "~1")], identity);
    const store = messageStore({ destination: id => ({ id, path: name(id) }) });
    expect(store.fold("~1", undefined, view.forTarget("~1")).entity).toBeUndefined();
  });

  it("folds a second send over a draft already being sent", () => {
    const base = draft("d1");
    expect(fold("d1", base, [send(1, "d1"), send(2, "d1")])).toEqual({ ...base, pending: "send" });
  });

  it("leaves the base row untouched", () => {
    const base = draft("d1", { categories: ["Blue"], to: [{ address: "ada@contoso.com" }] });
    const before = structuredClone(base);
    for (const value of [base, base.flag, base.categories, base.to, base.to[0], base.cc]) Object.freeze(value);
    const pending = [
      createFolder(1, "~9"), move(2, ["d1"], "~9"), update(3, ["d1"], { isRead: false, addCategories: ["Red"], removeCategories: ["Blue"], flag: { status: "flagged" } }),
      createDraft(4, "~1"), updateDraft(5, "d1", { subject: "Edited" }), move(6, ["d1"], "drafts"), send(7, "d1"), send(8), automaticReplies(9),
    ];
    expect(fold("d1", base, pending)).toMatchObject({ folderId: "drafts", subject: "Edited", categories: ["Red"], pending: "send" });
    expect(fold("d1", base, [...pending, deleteDraft(10, "d1")])).toBeUndefined();
    expect(base).toEqual(before);
  });
});

/** A generator of numbers in [0, 1) that gives the same sequence for the same seed. */
const seeded = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The messages Exchange holds in a generated mailbox; `real-1` and `real-2` are what `~1` and `~2` become once created. */
const REAL = ["m1", "m2", "d1", "real-1", "real-2"];
/** Where a generated move goes; `~9` is a folder pending creation. */
const FOLDERS = ["inbox", "archive", "drafts", "~9"];
/** The kinds a generated record is picked from, a kind listed once for each share of the queue it takes. */
const KINDS = [
  "move", "move", "move", "move", "update", "update", "update", "createDraft", "createDraft", "updateDraft", "updateDraft", "deleteDraft",
  "sendDraft", "send", "createFolder", "automaticReplies",
] as const;
/** The changes a generated update is picked from: several show nothing on a row that already reads that way. */
const CHANGES: Change[] = [
  { isRead: true }, { isRead: false }, {}, { flag: { status: "flagged", dueAt: "2026-11-01T00:00:00Z" } }, { flag: { status: "complete", dueAt: "2026-11-01T00:00:00Z" } },
  { addCategories: ["Red"] }, { addCategories: ["red"], isRead: true }, { removeCategories: ["RED"] }, { removeCategories: ["blue"] },
];
/** How many generated queues the fold is compared over. */
const SEEDS = 4_000;
const EDITS: Partial<Composed>[] = [{}, { subject: "Edited" }, { subject: "Edited again", markdown: "Shorter.", importance: "high" }];

/** A mailbox, a queue of one to nine pending actions on it, and which temporary IDs have been created, all decided by `seed`. */
function generate(seed: number) {
  const random = seeded(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const bound = new Map<string, string>();
  for (const [ref, id] of [["~1", "real-1"], ["~2", "real-2"], ["~9", "acme"]]) if (random() < 0.5) bound.set(ref, id);
  const rows = [
    info("m1"),
    info("m2", { folderId: "archive", folder: "Archive", isRead: true, categories: ["Blue"] }),
    draft("d1"),
    draft("real-1"),
    random() < 0.5 ? draft("real-2") : info("real-2", { isRead: true }),
  ];
  const pending: Entry[] = [];
  const created: string[] = [];
  // A real message, or a draft an earlier record of the queue creates: an edit never precedes its draft's creation.
  const aDraft = () => (created.length > 0 && random() < 0.5 ? pick(created) : pick(REAL));
  const count = 1 + Math.floor(random() * 9);
  for (let id = 1; id <= count; id++) {
    const kind = pick(KINDS);
    if (kind === "move") {
      const messages = random() < 0.5 ? [pick(REAL)] : [...new Set([pick(REAL), pick(REAL)])];
      pending.push(move(id, messages, pick(FOLDERS), pick(["move", "archive", "delete"] as const)));
    } else if (kind === "update") {
      pending.push(update(id, random() < 0.5 ? [pick(REAL)] : [...new Set([pick(REAL), pick(REAL)])], pick(CHANGES)));
    } else if (kind === "createDraft" && created.length < 3) {
      created.push(`~${created.length + 1}`);
      pending.push(createDraft(id, created.at(-1)!, { subject: `Draft ${id}` }, 1_000 * id));
    } else if (kind === "createDraft" || kind === "updateDraft") {
      pending.push(updateDraft(id, aDraft(), pick(EDITS)));
    } else if (kind === "deleteDraft") {
      pending.push(deleteDraft(id, aDraft()));
    } else if (kind === "sendDraft") {
      pending.push(send(id, aDraft()));
    } else if (kind === "send") {
      pending.push(send(id));
    } else if (kind === "createFolder") {
      pending.push(createFolder(id, "~9"));
    } else {
      pending.push(automaticReplies(id));
    }
  }
  return { rows, pending, created, resolve: (id: string) => bound.get(id) ?? id };
}

/**
 * Whether the queue moves `row` out of the folder Exchange holds it in and its last move puts it
 * back. Read from the queue alone, so it says where the fold may differ without asking the fold.
 */
function movedAwayAndBack(row: MessageInfo, pending: readonly Entry[], resolve: (id: string) => string): boolean {
  const destinations = pending.flatMap(({ action }) =>
    action.kind === "moveMessages" && action.payload.messages.some(message => message.id === row.id) ? [resolve(action.payload.to.id)] : []);
  return destinations.at(-1) === row.folderId && destinations.slice(0, -1).some(to => to !== row.folderId);
}

/** What a message shows beside where it is filed and what is pending on it. */
function shown({ folderId: _folderId, folder: _folder, pending: _pending, ...rest }: MessageInfo): string {
  return JSON.stringify(rest);
}

/**
 * The reading the fold is held to: the whole queue indexed once into maps (each message's last
 * move, its updates in order, each draft's latest edit, what is deleted and what is being sent),
 * and a message read from them.
 */
function reference(pending: readonly Entry[], resolve: (id: string) => string): Pick<OutlookOverlay, "apply" | "hides" | "pendingDrafts"> {
  return new OutlookOverlay(pending, resolve);
}

/** Whether a record is anything but a draft's deletion, which the reads that do not list leave out. */
const notDeletion = ({ action }: Entry) => action.kind !== "deleteDraft";

describe("the fold against a reading of the whole queue from maps", () => {
  it("reads every message and every pending draft of generated queues the same, but a message moved away and back whose pending update shows nothing", () => {
    const counted = { rows: 0, hidden: 0, standIns: 0, updateShownAfterMoveBack: 0, nothingShownAfterMoveBack: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { rows, pending, created, resolve } = generate(seed);
      const maps = reference(pending, resolve);
      for (const row of rows) {
        const at = `seed ${seed}, message ${row.id}`;
        counted.rows++;
        const folded = fold(row.id, row, pending, resolve);
        expect(folded === undefined, at).toBe(maps.hides(row.id));
        if (folded === undefined) counted.hidden++;

        // A draft pending deletion is still read by the reads that do not list.
        const kept = fold(row.id, row, pending, resolve, notDeletion)!;
        const expected = maps.apply(row, name);
        const back = movedAwayAndBack(row, pending, resolve);
        if (back && kept.pending !== expected.pending) {
          // Only the mark differs, and only because nothing the update changed is there to see.
          expect(expected.pending, at).toBe("update");
          expect("pending" in kept, at).toBe(false);
          expect({ ...kept, pending: "update" }, at).toEqual(expected);
          expect(shown(kept), at).toBe(shown(row));
          counted.nothingShownAfterMoveBack++;
        } else {
          expect(kept, at).toEqual(expected);
          if (back && kept.pending === "update") counted.updateShownAfterMoveBack++;
        }
        if (folded !== undefined) expect(folded, at).toEqual(kept);
      }
      const standIns = created.flatMap(ref => fold(ref, undefined, pending, resolve) ?? []);
      expect(standIns, `seed ${seed}`).toEqual(maps.pendingDrafts(DRAFTS.folder, DRAFTS.mailbox));
      counted.standIns += standIns.length;
    }
    // The one stated difference is met, and is too rare to hide another.
    expect(counted.nothingShownAfterMoveBack).toBeGreaterThan(0);
    expect(counted.nothingShownAfterMoveBack).toBeLessThan(counted.rows / 100);
    expect(counted.updateShownAfterMoveBack).toBeGreaterThan(0);
    expect(counted.hidden).toBeGreaterThan(0);
    expect(counted.standIns).toBeGreaterThan(0);
  });
});
