import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiChatMessage, BlueprintMetadata,
} from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage";
import { makeOverseerStorage } from "../src/overseer";
import { GitStore } from "../src/git-store";
import { readDocFiles } from "../src/yjs-files";
import {
  HISTORY_COMMIT_GAP_MS, migrateCodeLogToGit, type GitMigrationHost,
} from "../src/git-migration";
import { legacyChatBaseVersion } from "../src/agent-compaction";

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const OWNER = { name: "Alice", email: "alice@example.com" };

const T0 = Date.UTC(2024, 0, 1);
const MINUTE = 60_000;

/**
 * Builds a synthetic pre-git-storage workspace on mock storage: a legacy code log written the
 * way the old updateCode() wrote it (incremental V2 updates against one workspace-wide doc,
 * versions drawn from the shared change counter -- so `skipVersions` models the gaps that
 * non-code changes left), plus gadget records, chats, and blueprint records.
 */
class LegacyWorkspace {
  storage = makeOverseerStorage(makeMockStorage());
  gitStore = new GitStore(this.storage.gitObjects);

  #doc = new Y.Doc();
  #version = 0;
  #updates: Uint8Array[] = [];
  #sequences = new Map<number, number>();
  #timestamp = 0;

  constructor() {
    // Legacy workspaces always wrote an (often empty) version 1 at initialization.
    this.edit(T0, () => {});
  }

  /** Applies `fn` to the mainline doc and records the resulting update as the next version. */
  edit(timestampMs: number, fn: (doc: Y.Doc) => void): number {
    let captured: Uint8Array[] = [];
    let handler = (update: Uint8Array) => captured.push(update);
    this.#doc.on("updateV2", handler);
    this.#doc.transact(() => fn(this.#doc));
    this.#doc.off("updateV2", handler);
    let update = captured.length > 0
        ? Y.mergeUpdatesV2(captured) : Y.encodeStateAsUpdateV2(new Y.Doc());
    this.#updates.push(update);
    let version = ++this.#version;
    this.storage.code.put({ version, timestamp: new Date(timestampMs), update });
    return version;
  }

  /** Models non-code changes consuming versions from the shared counter (binding edits etc.). */
  skipVersions(count: number): void {
    this.#version += count;
  }

  /** A fresh doc replaying the recorded log through `version` ("current" = all of it). */
  docAt(version: number | "current"): Y.Doc {
    let doc = new Y.Doc();
    let count = version === "current" ? this.#updates.length : version;
    for (let update of this.#updates.slice(0, count)) {
      Y.applyUpdateV2(doc, update);
    }
    return doc;
  }

  addGadget(id: number, bindingName: string): void {
    this.storage.gadgets.put(
        { id, title: bindingName, created: new Date(T0), bindingName, bindings: {} });
  }

  addChat(id: number): void {
    this.storage.chatMeta.put(
        { id, title: "Chat", started: new Date(T0), lastActive: new Date(T0 + id) });
  }

  addMessage(chatId: number, author: AiChatAuthorInfo, body: object): number {
    let sequence = this.#sequences.get(chatId) ?? 0;
    this.#sequences.set(chatId, sequence + 1);
    // Legacy bodies (e.g. merge messages without `commits`) are exactly what the migration
    // consumes, so this deliberately bypasses the current wire type.
    this.storage.chats.put({
      chatId, sequence, timestamp: new Date(T0 + ++this.#timestamp), author, ...body,
    } as AiChatMessage);
    return sequence;
  }

  host(defaultGadgetId?: number): GitMigrationHost {
    return {
      storage: this.storage,
      gitStore: this.gitStore,
      ownerIdentity: OWNER,
      defaultGadgetId,
      gadgetRootName: (id) => id === defaultGadgetId ? "" : `${id}`,
      getActiveChatCompaction: (chatId) => {
        let compactedTo = this.storage.chatMeta.get(chatId)?.compactedTo;
        return compactedTo === undefined ? undefined
            : this.storage.chatCompactions.get(
                `${keyString(chatId)}.${keyString(compactedTo)}`);
      },
    };
  }

  mergeMessages(chatId: number): Extract<AiChatMessage, { type: "merge" }>[] {
    return [...this.storage.chats.list({ prefix: `${keyString(chatId)}.` })]
        .filter(msg => msg.type === "merge");
  }
}

function setFile(doc: Y.Doc, root: string, name: string, text: string): void {
  doc.getMap<Y.Text>(root).set(name, new Y.Text(text));
}

// Captures the update of one edit made against `doc` (a chat-local edit, never applied to the
// mainline log).
function captureEdit(doc: Y.Doc, fn: (doc: Y.Doc) => void): Uint8Array {
  let captured: Uint8Array[] = [];
  let handler = (update: Uint8Array) => captured.push(update);
  doc.on("updateV2", handler);
  doc.transact(() => fn(doc));
  doc.off("updateV2", handler);
  return Y.mergeUpdatesV2(captured);
}

describe("migrateCodeLogToGit", () => {
  it("synthesizes commits at merge points and backfills merge messages", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);

    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));           // v2
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 0, version: 2 });
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "10", "app.js", "hello world\n"));     // v3
    ws.edit(T0 + 3 * MINUTE, doc => setFile(doc, "10", "extra.js", "more\n"));          // v4
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 1, version: 4 });
    // A merge that accepted no code recorded the shared counter's value, which has no code
    // entry (versions 5-7 here went to non-code changes).
    ws.skipVersions(3);
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 2, version: 7 });

    let { commits } = await migrateCodeLogToGit(ws.host());
    expect(commits).toBe(3);

    // The head is the merge-point chain's tip: v3 was neither a merge point nor a gap, so it
    // folded into the v4 commit. The chain is rooted at the synthesized version-0 empty-tree
    // commit (every permanent gadget has a head; see GadgetRecord.commitId).
    let head = ws.storage.gadgets.get(10)!.commitId!;
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map([
      ["app.js", "hello world\n"],
      ["extra.js", "more\n"],
    ]));
    let log = await ws.gitStore.readCommitLog(head);
    expect(log.length).toBe(3);
    expect(log[0].parents).toEqual([log[1].oid]);
    expect(log[1].parents).toEqual([log[2].oid]);
    expect(log[2].parents).toEqual([]);
    expect(log[0].author).toEqual(OWNER);
    expect(log[0].timestamp).toEqual(new Date(T0 + 3 * MINUTE));
    expect(log[0].message).toContain("code versions 3-4");
    expect(log[1].message).toContain("code versions 1-2");
    expect(log[2].message).toContain("initial empty state");
    expect(log[2].timestamp).toEqual(new Date(T0));  // the gadget record's creation time
    expect(await ws.gitStore.readCommitFiles(log[1].oid))
        .toEqual(new Map([["app.js", "hello\n"]]));
    expect(await ws.gitStore.readCommitFiles(log[2].oid)).toEqual(new Map());

    // Merge messages carry the commits synthesized at their recorded versions; the no-code
    // merge (version 7, no code entry) correctly backfills to none.
    let merges = ws.mergeMessages(1);
    expect(merges[0].commits).toEqual([{ gadgetId: 10, commitId: log[1].oid }]);
    expect(merges[1].commits).toEqual([{ gadgetId: 10, commitId: head }]);
    expect(merges[2].commits).toEqual([]);

    // The chat's anchor is its highest referenced version (7), which floors to v4's commit. The
    // `legacy` flag marks its Yjs base as the retired code log until its first merge graduates
    // it; generation starts at 0 like any fresh code base.
    expect(ws.storage.chatMeta.get(1)!.codeBase).toEqual({
      legacy: true,
      generation: 0,
      gadgets: [{ gadgetId: 10, filesRoot: "10", mergedCommit: head }],
    });
  });

  it("batches standalone-edit bursts by one-hour gaps", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(20, "APP");

    ws.edit(T0, doc => setFile(doc, "20", "a.js", "one\n"));                             // v2
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "20", "a.js", "two\n"));                // v3
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "20", "a.js", "three\n"));              // v4
    ws.edit(T0 + 2 * MINUTE + HISTORY_COMMIT_GAP_MS,
        doc => setFile(doc, "20", "a.js", "four\n"));                                    // v5

    let { commits } = await migrateCodeLogToGit(ws.host());
    expect(commits).toBe(3);

    let head = ws.storage.gadgets.get(20)!.commitId!;
    let log = await ws.gitStore.readCommitLog(head);
    expect(log.length).toBe(3);  // empty root + one commit per burst
    // The burst v2-v4 (1-minute spacing) folds into one commit at the version before the gap;
    // the final version always commits.
    expect(await ws.gitStore.readCommitFiles(log[1].oid))
        .toEqual(new Map([["a.js", "three\n"]]));
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map([["a.js", "four\n"]]));
  });

  it("keeps untouched gadgets out of each commit point", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(30, "LEFT");
    ws.addGadget(40, "RIGHT");
    ws.addChat(1);

    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "30", "left.js", "l\n"));               // v2
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 0, version: 2 });
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "40", "right.js", "r\n"));              // v3
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 1, version: 3 });

    let { commits } = await migrateCodeLogToGit(ws.host());
    expect(commits).toBe(4);  // two empty roots, two content commits

    // Each gadget's chain has exactly its empty root plus the commit where its own files
    // changed.
    let left = ws.storage.gadgets.get(30)!.commitId!;
    let right = ws.storage.gadgets.get(40)!.commitId!;
    expect((await ws.gitStore.readCommitLog(left)).length).toBe(2);
    expect((await ws.gitStore.readCommitLog(right)).length).toBe(2);

    let merges = ws.mergeMessages(1);
    expect(merges[0].commits).toEqual([{ gadgetId: 30, commitId: left }]);
    expect(merges[1].commits).toEqual([{ gadgetId: 40, commitId: right }]);

    // The chat merged both, so it pins both gadgets -- each at its own chain's floor.
    expect(ws.storage.chatMeta.get(1)!.codeBase!.gadgets).toEqual([
      { gadgetId: 30, filesRoot: "30", mergedCommit: left },
      { gadgetId: 40, filesRoot: "40", mergedCommit: right },
    ]);
  });

  it("pins live chats at their anchored versions", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(50, "APP");
    ws.addGadget(55, "LATER");   // gains its first content only after chat 5's anchor
    ws.addChat(9);   // the chat whose merges advanced mainline
    ws.addChat(5);   // a live chat anchored mid-history
    ws.addChat(6);   // a live chat with no version references at all
    ws.addChat(7);   // a commit-pinned chat: the migration must not touch it

    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "50", "app.js", "one\n"));              // v2
    ws.addMessage(9, USER, { type: "merge", mergeThrough: 0, version: 2 });
    ws.addMessage(5, AGENT, { type: "changes", observedCodeVersion: 2 });
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "50", "app.js", "two\n"));              // v3
    ws.edit(T0 + 3 * MINUTE, doc => setFile(doc, "55", "later.js", "l\n"));              // v4
    ws.addMessage(9, USER, { type: "merge", mergeThrough: 1, version: 4 });

    let seededBase = { gadgets: [], generation: 2, epoch: 5 };
    let seeded = ws.storage.chatMeta.get(7)!;
    seeded.codeBase = seededBase;
    ws.storage.chatMeta.put(seeded);

    await migrateCodeLogToGit(ws.host());

    let head = ws.storage.gadgets.get(50)!.commitId!;
    let log = await ws.gitStore.readCommitLog(head);
    expect(log.length).toBe(3);  // empty root, v2, v3+v4 batch

    let pinFor = (chatId: number, gadgetId: number) =>
        ws.storage.chatMeta.get(chatId)!.codeBase!.gadgets
            .find(pin => pin.gadgetId === gadgetId)!;

    // Chat 5 saw version 2; chat 6 never referenced a version, so it anchors at the tip; chat 9
    // merged through the tip. The commit-seeded chat's codeBase is untouched.
    expect(pinFor(5, 50).mergedCommit).toBe(log[1].oid);
    expect(pinFor(6, 50).mergedCommit).toBe(head);
    expect(pinFor(9, 50).mergedCommit).toBe(head);
    expect(ws.storage.chatMeta.get(7)!.codeBase).toEqual(seededBase);

    // Gadget 55 had no content at chat 5's anchor, so the pin sits at its empty root -- the
    // doc's exact state for that root there -- arming the accept gate instead of leaving the
    // gadget unpinned (which would wedge the chat once mainline moved on it).
    let laterHead = ws.storage.gadgets.get(55)!.commitId!;
    let laterLog = await ws.gitStore.readCommitLog(laterHead);
    expect(laterLog.length).toBe(2);
    expect(pinFor(5, 55).mergedCommit).toBe(laterLog[1].oid);
    expect(await ws.gitStore.readCommitFiles(laterLog[1].oid)).toEqual(new Map());
    expect(pinFor(6, 55).mergedCommit).toBe(laterHead);
  });

  it("rewrites blueprint records to commits, including deleted gadgets'", async () => {
    let ws = new LegacyWorkspace();
    // Gadget 60 is the workspace's default gadget (files root ""), exported by a blueprint that
    // predates gadgetId on blueprint records. Gadget 70 has been deleted from the registry but
    // its blueprint remains.
    ws.addGadget(60, "APP");
    let metadata: BlueprintMetadata = {
      title: "BP", description: "", author: USER, created: new Date(T0),
      version: 1, lastUpdated: new Date(T0), bindings: {},
    };

    ws.edit(T0 + 1 * MINUTE, doc => {
      setFile(doc, "", "app.js", "exported\n");
      setFile(doc, "70", "gone.js", "deleted gadget\n");
    });                                                                                  // v2
    ws.edit(T0 + 2 * MINUTE + HISTORY_COMMIT_GAP_MS,
        doc => setFile(doc, "", "app.js", "changed since export\n"));                    // v3

    ws.storage.blueprints.put({ id: "bp-default", metadata, codeVersion: 2 });
    ws.storage.blueprints.put({ id: "bp-deleted", metadata, gadgetId: 70, codeVersion: 2 });

    await migrateCodeLogToGit(ws.host(60));

    // Each blueprint points at the commit whose tree is exactly the exported snapshot, even
    // though mainline moved on (bp-default) or the gadget is gone (bp-deleted).
    let bpDefault = ws.storage.blueprints.get("bp-default")!;
    expect(bpDefault.codeVersion).toBeUndefined();
    expect(await ws.gitStore.readCommitFiles(bpDefault.commitId!))
        .toEqual(new Map([["app.js", "exported\n"]]));

    let bpDeleted = ws.storage.blueprints.get("bp-deleted")!;
    expect(bpDeleted.codeVersion).toBeUndefined();
    expect(await ws.gitStore.readCommitFiles(bpDeleted.commitId!))
        .toEqual(new Map([["gone.js", "deleted gadget\n"]]));

    // The deleted gadget has no registry record to point at its chain; the default gadget's
    // head is the final version's commit.
    expect(await ws.gitStore.readCommitFiles(ws.storage.gadgets.get(60)!.commitId!))
        .toEqual(new Map([["app.js", "changed since export\n"]]));
  });

  it("anchors chats past user edits stamped later than the agent's lock", async () => {
    // The hazard: a user draft materialized while mainline was ahead of the agent's version
    // lock carries a later stamp, and its update can reference Yjs items the lower-anchored doc
    // lacks -- Yjs parks them as pending structs and the edits silently vanish from flattened
    // content. The anchor rule must pick the *max* referenced version so the chat's accept
    // commits those edits.
    let ws = new LegacyWorkspace();
    ws.addGadget(80, "APP");
    ws.addChat(90);   // another chat, whose merge advances mainline
    ws.addChat(91);   // the chat under test

    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "80", "app.js", "base\n"));             // v2
    ws.addMessage(90, USER, { type: "merge", mergeThrough: 0, version: 2 });

    // The agent edits against version 2 (its lock for the rest of the thread).
    let agentUpdate = captureEdit(ws.docAt(2), doc =>
        doc.getMap<Y.Text>("80").get("app.js")!.insert(5, "agent\n"));
    ws.addMessage(91, AGENT, { type: "changes", update: agentUpdate, observedCodeVersion: 2 });

    // Mainline moves: another chat lands new.js at version 3.
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "80", "new.js", "fresh\n"));            // v3
    ws.addMessage(90, USER, { type: "merge", mergeThrough: 1, version: 3 });

    // The user then edits new.js in chat 91's editor -- a doc built on then-current mainline
    // (v3) plus the chat's proposals -- so the update references v3's items.
    let userDocBase = ws.docAt(3);
    Y.applyUpdateV2(userDocBase, agentUpdate);
    let userUpdate = captureEdit(userDocBase, doc =>
        doc.getMap<Y.Text>("80").get("new.js")!.insert(6, "user\n"));
    ws.addMessage(91, USER, { type: "changes", update: userUpdate, observedCodeVersion: 3 });

    // The anchor is the max referenced version, not the agent's first stamp.
    let messages = [...ws.storage.chats.list({ prefix: `${keyString(91)}.` })];
    expect(legacyChatBaseVersion(undefined, messages)).toBe(3);

    await migrateCodeLogToGit(ws.host());

    // The chat pins mainline's tip (the v3 commit)...
    let head = ws.storage.gadgets.get(80)!.commitId!;
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map([
      ["app.js", "base\n"],
      ["new.js", "fresh\n"],
    ]));
    expect(ws.storage.chatMeta.get(91)!.codeBase!.gadgets)
        .toEqual([{ gadgetId: 80, filesRoot: "80", mergedCommit: head }]);

    // ...and the doc base anchored there keeps both edits, where the agent's lower lock would
    // have dropped the user's (the pending-structs hazard this rule exists to prevent).
    let anchored = ws.docAt(3);
    Y.applyUpdateV2(anchored, agentUpdate);
    Y.applyUpdateV2(anchored, userUpdate);
    expect(readDocFiles(anchored, "80")).toEqual(new Map([
      ["app.js", "base\nagent\n"],
      ["new.js", "fresh\nuser\n"],
    ]));
    let underAnchored = ws.docAt(2);
    Y.applyUpdateV2(underAnchored, agentUpdate);
    Y.applyUpdateV2(underAnchored, userUpdate);
    expect(readDocFiles(underAnchored, "80").get("new.js")).toBeUndefined();
  });

  it("is re-runnable, converging on the same commits", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 0, version: 2 });

    let first = await migrateCodeLogToGit(ws.host());
    let head = ws.storage.gadgets.get(10)!.commitId!;
    let second = await migrateCodeLogToGit(ws.host());

    expect(second.commits).toBe(first.commits);
    expect(ws.storage.gadgets.get(10)!.commitId).toBe(head);
    expect(ws.mergeMessages(1)[0].commits).toEqual([{ gadgetId: 10, commitId: head }]);
  });

  it("gives a gadget the log never gave content an empty-tree head", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.addMessage(1, AGENT, { type: "changes", observedCodeVersion: 1 });

    let { commits } = await migrateCodeLogToGit(ws.host());
    expect(commits).toBe(1);

    // The head is the synthesized empty-tree initial commit (every permanent gadget has a
    // head; see GadgetRecord.commitId)...
    let head = ws.storage.gadgets.get(10)!.commitId!;
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map());
    expect((await ws.gitStore.readCommitLog(head)).length).toBe(1);

    // ...and the legacy chat pins it there, arming the accept gate: edits to the empty gadget
    // fast-forward from it, and a first commit landing from another chat reads as ordinary
    // staleness rather than wedging the chat.
    expect(ws.storage.chatMeta.get(1)!.codeBase!.gadgets).toEqual([
      { gadgetId: 10, filesRoot: "10", mergedCommit: head }]);
  });
});

describe("legacyChatBaseVersion", () => {
  const base = { chatId: 1, timestamp: new Date(T0), author: USER };

  it("returns the maximum referenced version across all sources", () => {
    let messages = [
      { ...base, sequence: 0, type: "message", message: "",
        toolCalls: [{ toolCallId: "t", toolName: "readFile",
                      input: { filename: "a" }, observedCodeVersion: 4 }] },
      { ...base, sequence: 1, type: "changes", observedCodeVersion: 6 },
      { ...base, sequence: 2, type: "merge", mergeThrough: 1, version: 5 },
    ] as AiChatMessage[];
    expect(legacyChatBaseVersion(undefined, messages)).toBe(6);

    // A checkpoint stamp participates in the max like any other reference.
    let checkpoint = { chatId: 1, compactedTo: 3, summary: "", chatBindings: [],
                       nextChangeId: 0, observedCodeVersion: 7 };
    expect(legacyChatBaseVersion(checkpoint, messages)).toBe(7);
    expect(legacyChatBaseVersion({ ...checkpoint, observedCodeVersion: 2 }, messages)).toBe(6);
  });

  it("returns 'current' when nothing references a version", () => {
    let messages = [
      { ...base, sequence: 0, type: "message", message: "hi" },
    ] as AiChatMessage[];
    expect(legacyChatBaseVersion(undefined, messages)).toBe("current");
  });
});
