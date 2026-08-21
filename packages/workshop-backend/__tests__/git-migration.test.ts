import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AiChatMessage, BlueprintMetadata } from "@gadgets/workshop-shared/api";
import { HISTORY_COMMIT_GAP_MS, migrateCodeLogToGit } from "../src/git-migration";
import { foldProposedChanges, legacyChatBaseVersion } from "../src/agent-compaction";
import {
  AGENT, LegacyWorkspace, MINUTE, OWNER, T0, USER, captureEdit, expectHeadsMatchDoc, setFile,
} from "./legacy-workspace";

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

    // Every head tree must equal an independent replay of the recorded update log.
    await expectHeadsMatchDoc(ws.storage, ws.gitStore, ws.docAt("current"));

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

    // The chat's every change was merged, so its flatten matches its anchor (its highest
    // referenced version, 7, floored to v4): nothing to convert. The boundary message is still
    // written -- the epoch points at it -- but carries no change and no pins, and proposes nothing.
    let conversion = ws.conversionMessage(1);
    expect(conversion.change).toBeUndefined();
    expect(conversion.pins).toBeUndefined();
    expect(ws.codeBase(1)).toEqual(
        { pins: [], generation: 0, epoch: conversion.sequence, revision: 0 });
    expect(ws.storage.chatMeta.get(1)!.hasProposedChanges).toBeUndefined();
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

    // Every head tree must equal an independent replay of the recorded update log.
    await expectHeadsMatchDoc(ws.storage, ws.gitStore, ws.docAt("current"));

    // Each gadget's chain has exactly its empty root plus the commit where its own files
    // changed.
    let left = ws.storage.gadgets.get(30)!.commitId!;
    let right = ws.storage.gadgets.get(40)!.commitId!;
    expect((await ws.gitStore.readCommitLog(left)).length).toBe(2);
    expect((await ws.gitStore.readCommitLog(right)).length).toBe(2);

    let merges = ws.mergeMessages(1);
    expect(merges[0].commits).toEqual([{ gadgetId: 30, commitId: left }]);
    expect(merges[1].commits).toEqual([{ gadgetId: 40, commitId: right }]);

    // The chat's own merges are all in its anchor: nothing uncommitted, so no pins.
    expect(ws.codeBase(1)!.pins).toEqual([]);
  });

  it("converts uncommitted chat edits into a conversion change pinned at the anchor", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(50, "APP");
    ws.addGadget(55, "OTHER");  // committed but untouched by the chat: must stay unpinned
    ws.addChat(9);   // the chat whose merges advanced mainline
    ws.addChat(5);   // the live chat under test

    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "50", "app.js", "base\n"));             // v2
    ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "55", "other.js", "o\n"));              // v3
    ws.addMessage(9, USER, { type: "merge", mergeThrough: 0, version: 3 });

    // The chat's agent edits app.js against version 3, still unmerged at migration time.
    let update = captureEdit(ws.docAt(3), doc =>
        doc.getMap<Y.Text>("50").get("app.js")!.insert(5, "agent\n"));
    ws.addMessage(5, AGENT, { type: "changes", update, observedCodeVersion: 3 });

    await migrateCodeLogToGit(ws.host());

    // The chat pins only the gadget it touched, base = merged = the anchor (v3) commit, which
    // is the gadget's head here.
    let head = ws.storage.gadgets.get(50)!.commitId!;
    expect(ws.codeBase(5)!.pins).toEqual(
        [{ gadgetId: 50, baseCommit: head, mergedCommit: head }]);
    let conversion = ws.conversionMessage(5);
    expect(conversion.pins).toEqual([{ gadgetId: 50, baseCommit: head }]);
    expect(ws.codeBase(5)).toMatchObject(
        { generation: 0, epoch: conversion.sequence, revision: 0 });
    expect(ws.storage.chatMeta.get(5)!.hasProposedChanges).toBe(true);

    // The change re-creates the chat's uncommitted content on top of the pinned tree.
    expect(await ws.convertedContent(5)).toEqual(new Map([
      [50, new Map([["app.js", "base\nagent\n"]])],
    ]));

    // A non-empty conversion change is one proposed batch (on top of the legacy batch with no
    // change of its own that recorded the original update).
    let proposed = foldProposedChanges(ws.messages(5));
    expect(proposed.map(batch => batch.change !== undefined)).toEqual([false, true]);
  });

  it("converts a read-only chat to an empty boundary that proposes nothing", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));            // v2
    ws.addMessage(1, USER, { type: "message", message: "what does this code do?" });
    ws.addMessage(1, AGENT, { type: "message", message: "it greets", toolCalls: [
      { toolCallId: "t1", toolName: "readFile", input: { filename: "app.js" },
        observedCodeVersion: 2 },
    ] });

    await migrateCodeLogToGit(ws.host());

    // The boundary is written even with nothing to convert -- the epoch points at it, and
    // replay's elision of the pre-conversion read keys on it -- but it proposes nothing.
    let conversion = ws.conversionMessage(1);
    expect(conversion.change).toBeUndefined();
    expect(conversion.pins).toBeUndefined();
    expect(ws.codeBase(1)).toEqual(
        { pins: [], generation: 0, epoch: conversion.sequence, revision: 0 });
    expect(ws.storage.chatMeta.get(1)!.hasProposedChanges).toBeUndefined();
    expect(foldProposedChanges(ws.messages(1))).toEqual([]);
  });

  it("folds outstanding drafts into the conversion change and deletes them", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));            // v2

    // An agent edit recorded as a message, then a user draft typed on top of it, never
    // materialized.
    let base = ws.docAt(2);
    let agentUpdate = captureEdit(base, doc =>
        doc.getMap<Y.Text>("10").get("app.js")!.insert(6, "agent\n"));
    ws.addMessage(1, AGENT, { type: "changes", update: agentUpdate, observedCodeVersion: 2 });
    ws.addDraft(1, captureEdit(base, doc =>
        doc.getMap<Y.Text>("10").get("app.js")!.insert(12, "draft\n")));

    await migrateCodeLogToGit(ws.host());

    expect(await ws.convertedContent(1)).toEqual(new Map([
      [10, new Map([["app.js", "hello\nagent\ndraft\n"]])],
    ]));
    expect([...ws.storage.chatDraftUpdates.list()]).toEqual([]);
  });

  it("skips reverted legacy updates, like the legacy doc construction did", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));            // v2

    let base = ws.docAt(2);
    let reverted = ws.addMessage(1, AGENT, {
      type: "changes", observedCodeVersion: 2,
      update: captureEdit(base, doc =>
          doc.getMap<Y.Text>("10").get("app.js")!.insert(6, "rejected\n")),
    });
    ws.addMessage(1, USER, { type: "revert", revertFrom: reverted });
    // A surviving edit built on a doc that never saw the reverted one.
    let survivor = ws.docAt(2);
    ws.addMessage(1, AGENT, {
      type: "changes", observedCodeVersion: 2,
      update: captureEdit(survivor, doc =>
          doc.getMap<Y.Text>("10").get("app.js")!.insert(0, "kept\n")),
    });

    await migrateCodeLogToGit(ws.host());

    expect(await ws.convertedContent(1)).toEqual(new Map([
      [10, new Map([["app.js", "kept\nhello\n"]])],
    ]));
  });

  it("recovers chat content orphaned by the zero-gadget multi-gadget migration", async () => {
    // A pre-multi-gadget workspace whose only code was proposed-but-unaccepted chat changes: the
    // multi-gadget migration saw no mainline code and created no gadget records, leaving the
    // chat's content orphaned in the legacy root "", which no gadget owns.
    let ws = new LegacyWorkspace();  // code log: only the empty init version
    ws.addChat(1);
    let base = ws.docAt("current");
    ws.addMessage(1, USER, { type: "message", message: "make me a gadget" });
    ws.addMessage(1, AGENT, { type: "changes", observedCodeVersion: 1,
        update: captureEdit(base, doc => setFile(doc, "", "server.js", "hello\n")) });
    ws.addMessage(1, AGENT, { type: "changes", observedCodeVersion: 1,
        update: captureEdit(base, doc => setFile(doc, "", "client.js", "world\n")) });

    await migrateCodeLogToGit(ws.host());

    // The workspace's implicit gadget was created: permanent, headed at the empty tree (nothing
    // was ever accepted), and recorded as the default gadget so legacy references resolve.
    let gadgets = [...ws.storage.gadgets.list()];
    expect(gadgets).toHaveLength(1);
    let gadget = gadgets[0];
    expect(gadget.pending).toBeUndefined();
    expect(ws.storage.defaultGadgetId.get()).toBe(gadget.id);
    expect(await ws.gitStore.readCommitFiles(gadget.commitId!)).toEqual(new Map());

    // The chat converts like any other: pinned at the empty tree, its files as proposed sets.
    let conversion = ws.conversionMessage(1);
    expect(conversion.pins).toEqual([{ gadgetId: gadget.id, baseCommit: gadget.commitId }]);
    expect(ws.codeBase(1)!.pins).toEqual(
        [{ gadgetId: gadget.id, baseCommit: gadget.commitId, mergedCommit: gadget.commitId }]);
    expect(ws.storage.chatMeta.get(1)!.hasProposedChanges).toBe(true);
    expect(await ws.convertedContent(1)).toEqual(new Map([
      [gadget.id, new Map([["server.js", "hello\n"], ["client.js", "world\n"]])],
    ]));
  });

  it("shares one recovered default gadget among all chats proposing legacy-root content",
     async () => {
    let ws = new LegacyWorkspace();
    ws.addChat(1);
    ws.addChat(2);
    ws.addMessage(1, AGENT, { type: "changes", observedCodeVersion: 1,
        update: captureEdit(ws.docAt("current"), doc => setFile(doc, "", "a.js", "one\n")) });
    ws.addMessage(2, AGENT, { type: "changes", observedCodeVersion: 1,
        update: captureEdit(ws.docAt("current"), doc => setFile(doc, "", "b.js", "two\n")) });

    await migrateCodeLogToGit(ws.host());

    // Both chats pin the same permanent gadget at the same empty-tree base: whichever accepts
    // first wins, and the other goes ordinarily stale (update-from-mainline, not data loss).
    let gadgets = [...ws.storage.gadgets.list()];
    expect(gadgets).toHaveLength(1);
    let gadget = gadgets[0];
    for (let chatId of [1, 2]) {
      expect(ws.codeBase(chatId)!.pins).toEqual(
          [{ gadgetId: gadget.id, baseCommit: gadget.commitId, mergedCommit: gadget.commitId }]);
    }
    expect(await ws.convertedContent(1)).toEqual(new Map([
      [gadget.id, new Map([["a.js", "one\n"]])],
    ]));
    expect(await ws.convertedContent(2)).toEqual(new Map([
      [gadget.id, new Map([["b.js", "two\n"]])],
    ]));
  });

  it("does not recover legacy-root content whose proposing changes were all reverted",
     async () => {
    let ws = new LegacyWorkspace();
    ws.addChat(1);
    let reverted = ws.addMessage(1, AGENT, { type: "changes", observedCodeVersion: 1,
        update: captureEdit(ws.docAt("current"), doc => setFile(doc, "", "a.js", "no\n")) });
    ws.addMessage(1, USER, { type: "revert", revertFrom: reverted });

    await migrateCodeLogToGit(ws.host());

    // The user rejected the content, so no gadget materializes and the boundary is empty.
    expect([...ws.storage.gadgets.list()]).toEqual([]);
    expect(ws.storage.defaultGadgetId.get()).toBeUndefined();
    let conversion = ws.conversionMessage(1);
    expect(conversion.change).toBeUndefined();
    expect(conversion.pins).toBeUndefined();
  });

  it("recovers legacy-root content that exists only as an outstanding draft", async () => {
    let ws = new LegacyWorkspace();
    ws.addChat(1);
    ws.addDraft(1, captureEdit(ws.docAt("current"),
        doc => setFile(doc, "", "a.js", "typed\n")));

    await migrateCodeLogToGit(ws.host());

    let gadgets = [...ws.storage.gadgets.list()];
    expect(gadgets).toHaveLength(1);
    expect(await ws.convertedContent(1)).toEqual(new Map([
      [gadgets[0].id, new Map([["a.js", "typed\n"]])],
    ]));
    expect([...ws.storage.chatDraftUpdates.list()]).toEqual([]);
  });

  it("carries a pending gadget's files as plain sets, re-stamping its creation", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addGadget(60, "MINE", { chatId: 1, sequence: 0 });  // pending in the chat under test
    ws.addGadget(70, "THEIRS", { chatId: 2 });   // pending in another chat: not this chat's
    ws.addChat(1);
    ws.addChat(2);

    // The pending gadget's files exist only in the chat's proposed updates.
    ws.addMessage(1, AGENT, {
      type: "changes", observedCodeVersion: 1,
      update: captureEdit(ws.docAt(1), doc => setFile(doc, "60", "mine.js", "mine\n")),
      createdGadgets: [{ gadgetId: 60, title: "MINE", bindingName: "MINE" }],
    });

    await migrateCodeLogToGit(ws.host());

    // No pin for the pending gadget (it has no head to pin); its content rides the change as sets.
    expect(ws.codeBase(1)!.pins).toEqual([]);
    let conversion = ws.conversionMessage(1);
    expect(conversion.pins).toBeUndefined();
    expect(conversion.change).toEqual({ "60": [["mine.js", { set: "mine\n" }]] });
    // The creation is re-recorded on the boundary and the record re-stamped to it, so accept
    // and revert treat creation and content as one (a revert at the boundary rejects the
    // creation rather than stranding a content-less pending gadget).
    expect(conversion.createdGadgets).toEqual(
        [{ gadgetId: 60, title: "MINE", bindingName: "MINE" }]);
    expect(ws.storage.gadgets.get(60)!.pending).toEqual(
        { chatId: 1, sequence: conversion.sequence });
    // Pending gadgets get no synthesized head; the permanent gadget got its empty root.
    expect(ws.storage.gadgets.get(60)!.commitId).toBeUndefined();
    expect(ws.storage.gadgets.get(10)!.commitId).toBeDefined();
    // The other chat's pending gadget is not the converting chat's to carry.
    expect(ws.codeBase(2)!.pins).toEqual([]);
    expect(ws.conversionMessage(2).change).toBeUndefined();
    expect(ws.storage.gadgets.get(70)!.pending).toEqual({ chatId: 2 });
  });

  it("is deterministic: the same log converts to the same change", async () => {
    let build = () => {
      let ws = new LegacyWorkspace();
      ws.addGadget(10, "APP");
      ws.addChat(1);
      ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "one\ntwo\nthree\n"));
      let base = ws.docAt(2);
      ws.addMessage(1, AGENT, {
        type: "changes", observedCodeVersion: 2,
        update: captureEdit(base, doc => {
          setFile(doc, "10", "new.js", "fresh\n");
          doc.getMap<Y.Text>("10").get("app.js")!.insert(4, "1.5\n");
        }),
      });
      return ws;
    };
    let a = build();
    let b = build();
    await migrateCodeLogToGit(a.host());
    await migrateCodeLogToGit(b.host());
    expect(a.conversionMessage(1).change).toBeDefined();
    expect(a.conversionMessage(1).change).toEqual(b.conversionMessage(1).change);
    expect(a.codeBase(1)).toEqual(b.codeBase(1));
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

    // Every head tree must equal an independent replay of the recorded update log (the default
    // gadget's root is "").
    await expectHeadsMatchDoc(ws.storage, ws.gitStore, ws.docAt("current"), 60);

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
    // content. The anchor rule must pick the *max* referenced version so the conversion change
    // carries both edits.
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
    expect(legacyChatBaseVersion(undefined, ws.messages(91))).toBe(3);

    await migrateCodeLogToGit(ws.host());

    // The chat pins mainline's tip (the v3 commit)...
    let head = ws.storage.gadgets.get(80)!.commitId!;
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map([
      ["app.js", "base\n"],
      ["new.js", "fresh\n"],
    ]));
    expect(ws.codeBase(91)!.pins).toEqual(
        [{ gadgetId: 80, baseCommit: head, mergedCommit: head }]);

    // ...and the conversion anchored there keeps both edits, where the agent's lower lock
    // would have dropped the user's (the pending-structs hazard this rule exists to prevent).
    expect(await ws.convertedContent(91)).toEqual(new Map([
      [80, new Map([["app.js", "base\nagent\n"], ["new.js", "fresh\nuser\n"]])],
    ]));
  });

  it("is re-runnable, converging on the same commits and a single conversion", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "10", "app.js", "hello\n"));
    ws.addMessage(1, USER, { type: "merge", mergeThrough: 0, version: 2 });
    ws.addMessage(1, AGENT, {
      type: "changes", observedCodeVersion: 2,
      update: captureEdit(ws.docAt(2), doc =>
          doc.getMap<Y.Text>("10").get("app.js")!.insert(6, "more\n")),
    });

    let first = await migrateCodeLogToGit(ws.host());
    let head = ws.storage.gadgets.get(10)!.commitId!;
    let converted = { message: ws.conversionMessage(1), codeBase: ws.codeBase(1) };
    let second = await migrateCodeLogToGit(ws.host());

    expect(second.commits).toBe(first.commits);
    expect(ws.storage.gadgets.get(10)!.commitId).toBe(head);
    expect(ws.mergeMessages(1)[0].commits).toEqual([{ gadgetId: 10, commitId: head }]);
    // The chat is converted exactly once (a codeBase marks it done).
    expect(ws.conversionMessage(1)).toEqual(converted.message);
    expect(ws.codeBase(1)).toEqual(converted.codeBase);
  });

  it("pins an edit to a never-committed gadget at its empty-tree head", async () => {
    let ws = new LegacyWorkspace();
    ws.addGadget(10, "APP");
    ws.addChat(1);
    ws.addMessage(1, AGENT, {
      type: "changes", observedCodeVersion: 1,
      update: captureEdit(ws.docAt(1), doc => setFile(doc, "10", "app.js", "fresh\n")),
    });

    let { commits } = await migrateCodeLogToGit(ws.host());
    expect(commits).toBe(1);

    // The head is the synthesized empty-tree initial commit (every permanent gadget has a
    // head; see GadgetRecord.commitId)...
    let head = ws.storage.gadgets.get(10)!.commitId!;
    expect(await ws.gitStore.readCommitFiles(head)).toEqual(new Map());
    expect((await ws.gitStore.readCommitLog(head)).length).toBe(1);

    // ...and the chat's uncommitted edit pins there, arming the accept gate: the accept
    // fast-forwards from the empty tree, and a first commit landing from another chat reads as
    // ordinary staleness rather than wedging the chat.
    expect(ws.codeBase(1)!.pins).toEqual(
        [{ gadgetId: 10, baseCommit: head, mergedCommit: head }]);
    expect(await ws.convertedContent(1)).toEqual(new Map([
      [10, new Map([["app.js", "fresh\n"]])],
    ]));
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
