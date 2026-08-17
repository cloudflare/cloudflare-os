import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type {
  AiChatAuthorInfo, AiChatMessage, ChatChangesPin,
} from "@gadgets/workshop-shared/api";
import {
  bindLiveDocClientId, seedClientIdForGadget, seedRootFromFiles, seedUpdateHash,
} from "@gadgets/workshop-shared/yjs-seed";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerDurableObject } from "../src/overseer.js";
import { readDocFiles } from "../src/yjs-files.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the chat code-base lifecycle -- lazy pin establishment, generation validation,
// epoch-scoped doc reconstruction, the accept flow's epoch reset, pin rollback on revert/draft
// discard, and update-from-mainline's pinned-only scope -- against the real OverseerImpl running
// in workerd, over real storage and a real git object store. Each test gets a fresh DO.

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: USER };

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-code-base-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

function addGadget(impl: any, id: number, bindingName: string, commitId?: string): void {
  impl.storage.gadgets.put({
    id, title: bindingName, created: new Date(0), bindingName, bindings: {},
    ...(commitId !== undefined ? { commitId } : {}),
  });
}

function addChat(impl: any, id: number): void {
  impl.storage.chatMeta.put(
      { id, title: "Chat", started: new Date(0), lastActive: new Date(0) });
}

async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// A client editor doc for one gadget's root, seeded the way the frontend derives it.
function editorDoc(gadgetId: number, rootName: string, files: Record<string, string>): Y.Doc {
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc,
      seedRootFromFiles(rootName, new Map(Object.entries(files)), seedClientIdForGadget(gadgetId)));
  bindLiveDocClientId(doc);
  return doc;
}

function captureEdit(doc: Y.Doc, fn: () => void): Uint8Array {
  let updates: Uint8Array[] = [];
  let handler = (update: Uint8Array) => updates.push(update);
  doc.on("updateV2", handler);
  doc.transact(fn);
  doc.off("updateV2", handler);
  return Y.mergeUpdatesV2(updates);
}

function chatMessages(impl: any, chatId: number): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

describe("updateCode", () => {
  it("establishes a pin, records the draft, and stamps the declaration at materialization",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    let update = captureEdit(doc, () =>
        doc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "edited\n"));
    await impl.updateCode(update, 1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.generation).toBe(0);  // pin additions do not bump
    expect(codeBase.gadgets).toHaveLength(1);
    let pin = codeBase.gadgets[0];
    expect(pin).toMatchObject({ gadgetId: 1, filesRoot: "1", seedCommit: c1, mergedCommit: c1 });
    // The seed hash is the server's own derivation, never taken from the client.
    expect(pin.seedHash).toBe(await seedUpdateHash(
        seedRootFromFiles("1", new Map([["a.txt", "one\n"]]), seedClientIdForGadget(1))));

    // A follow-up draft to the already-pinned gadget needs no pin declaration.
    let more = captureEdit(doc, () =>
        doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "// top\n"));
    await impl.updateCode(more, 1, { generation: 0 }, USER);

    // Materialization stamps the (previously unlogged) pin onto the "changes" message it
    // writes, closing the meta/log loop; commit-pinned chats never stamp observedCodeVersion.
    impl.materializeChatDraft(1);
    let changes = chatMessages(impl, 1).filter(msg => msg.type === "changes");
    expect(changes).toHaveLength(1);
    expect(changes[0].pins).toEqual([
      { gadgetId: 1, filesRoot: "1", baseCommit: c1, seedHash: pin.seedHash }]);
    expect(changes[0].observedCodeVersion).toBeUndefined();

    // Doc reconstruction: the logged pin's seed plus the update.
    let ydoc = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map([["a.txt", "// top\none\nedited\n"]]));
  }));

  it("accepts a pin at the head's parent but rejects older bases", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    let c3 = await commitFiles(impl, { "a.txt": "three\n" }, [c2]);
    addGadget(impl, 1, "APP", c3);
    addChat(impl, 1);

    let update = captureEdit(editorDoc(1, "1", { "a.txt": "two\n" }), () => {});
    await expect(impl.updateCode(update, 1,
        { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER))
        .rejects.toThrow(/does not match the gadget's current head/);

    // A parent of the head is tolerated: the client raced exactly one merge.
    let doc = editorDoc(1, "1", { "a.txt": "two\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c2 } }, USER);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.gadgets[0].seedCommit).toBe(c2);
  }));

  it("rejects stale generations, conflicting pins, unpinnable gadgets, and in-band authors",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    addGadget(impl, 1, "APP", c2);
    addGadget(impl, 2, "EMPTY");  // no committed code
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "two\n" });
    let update = captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x"));

    await expect(impl.updateCode(update, 1, { generation: 1 }, USER))
        .rejects.toThrow(/code base changed/);

    await expect(impl.updateCode(update, 1,
        { generation: 0, pin: { gadgetId: 2, baseCommit: c2 } }, USER))
        .rejects.toThrow(/no committed code/);

    // A rogue doc authoring under a reserved seed clientID is rejected outright.
    let rogue = new Y.Doc();
    rogue.clientID = seedClientIdForGadget(1);
    let rogueUpdate = captureEdit(rogue, () =>
        rogue.getMap<Y.Text>("1").set("evil.txt", new Y.Text("x")));
    await expect(impl.updateCode(rogueUpdate, 1, { generation: 0 }, USER))
        .rejects.toThrow(/reserved seed clientID/);

    // First pin wins; a racing declaration at a different base is refused (the loser's doc
    // diverges, so its keystrokes must be discarded).
    await impl.updateCode(update, 1, { generation: 0, pin: { gadgetId: 1, baseCommit: c2 } }, USER);
    await expect(impl.updateCode(update, 1,
        { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER))
        .rejects.toThrow(/concurrently pinned/);
    // ...but the identical declaration is shared: both clients derived the same seed.
    await impl.updateCode(update, 1, { generation: 0, pin: { gadgetId: 1, baseCommit: c2 } }, USER);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.gadgets).toHaveLength(1);
  }));
});

describe("mergeChanges", () => {
  it("commits, fast-forwards, and closes the epoch", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    let update = captureEdit(doc, () =>
        doc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "edited\n"));
    await impl.updateCode(update, 1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);

    // The accept sweeps the live draft in itself (no prior materialization needed).
    let result = await impl.mergeChanges(1, USER_META, "user-do-id");
    expect(result).toEqual({ outcome: "merged" });

    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(head).not.toBe(c1);
    expect(await impl.gitStore.readCommitFiles(head))
        .toEqual(new Map([["a.txt", "one\nedited\n"]]));
    expect((await impl.gitStore.readCommitLog(head, { depth: 1 }))[0].parents).toEqual([c1]);

    let merges = chatMessages(impl, 1).filter(msg => msg.type === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0].epochBoundary).toBe(true);
    expect(merges[0].commits).toEqual([{ gadgetId: 1, commitId: head }]);

    // Epoch reset: pins evaporate, the generation bumps, drafts are gone, and the doc restarts
    // empty (the merged content lives in commits now).
    expect(impl.storage.chatMeta.get(1)!.codeBase).toEqual(
        { gadgets: [], generation: 1, epoch: merges[0].sequence });
    expect(impl.listChatDraftUpdates(1)).toEqual([]);
    expect(impl.getProposedChanges(1)).toEqual([]);
    let ydoc = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map());

    // A second epoch re-pins lazily against the new head and replays independently.
    let doc2 = editorDoc(1, "1", { "a.txt": "one\nedited\n" });
    await impl.updateCode(
        captureEdit(doc2, () => doc2.getMap<Y.Text>("1").get("a.txt")!.insert(0, "top\n")),
        1, { generation: 1, pin: { gadgetId: 1, baseCommit: head } }, USER);
    impl.materializeChatDraft(1);
    let ydoc2 = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc2, "1")).toEqual(new Map([["a.txt", "top\none\nedited\n"]]));
  }));

  it("returns stale when mainline moved past a pin, with no partial effects",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "mine\n")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);

    // Another chat's accept advances the head.
    let c2 = await commitFiles(impl, { "a.txt": "theirs\n" }, [c1]);
    let record = impl.storage.gadgets.get(1)!;
    record.commitId = c2;
    impl.storage.gadgets.put(record);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "stale" });
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c2);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.generation).toBe(0);
  }));

  it("graduates a legacy chat at its first merge", () => withImpl(async impl => {
    // A pre-git chat: its Yjs base is the legacy code log, its migration-written codeBase
    // carries `legacy` and a mergedCommit-only pin at the synthesized head.
    let base = new Y.Doc();
    impl.storage.code.put(
        { version: 1, timestamp: new Date(0), update: Y.encodeStateAsUpdateV2(new Y.Doc()) });
    let baseUpdate = captureEdit(base, () =>
        base.getMap<Y.Text>("1").set("a.txt", new Y.Text("one\n")));
    impl.storage.code.put({ version: 2, timestamp: new Date(1000), update: baseUpdate });

    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let meta = impl.storage.chatMeta.get(1)!;
    meta.codeBase = { legacy: true, generation: 0,
                      gadgets: [{ gadgetId: 1, filesRoot: "1", mergedCommit: c1 }] };
    impl.storage.chatMeta.put(meta);

    // A proposed change rooted in the legacy doc.
    let legacyDoc = new Y.Doc();
    Y.applyUpdateV2(legacyDoc, baseUpdate);
    bindLiveDocClientId(legacyDoc);
    impl.addChatMessages(1, AGENT, [{
      type: "changes",
      update: captureEdit(legacyDoc, () =>
          legacyDoc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "agent\n")),
      observedCodeVersion: 2,
    }]);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });

    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(await impl.gitStore.readCommitFiles(head))
        .toEqual(new Map([["a.txt", "one\nagent\n"]]));

    // Graduation: the `legacy` flag is gone; the chat is an ordinary commit-pinned chat.
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.legacy).toBeUndefined();
    expect(codeBase).toMatchObject({ gadgets: [], generation: 1 });
  }));

  it("gives up when a draft lands during the accept's awaits, preserving it",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "first\n")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);

    // Race a keystroke into the accept's await window: updateCode() acknowledges it against
    // the pre-reset generation (no lock, no log append), so the accept must neither discard it
    // with the epoch reset nor silently merge the mid-keystroke state -- it gives up, leaving
    // the chat untouched.
    let late = captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "late\n"));
    let origWrite = impl.gitStore.writeFilesAsCommit.bind(impl.gitStore);
    let injected = false;
    impl.gitStore.writeFilesAsCommit = async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        await impl.updateCode(late, 1, { generation: 0 }, USER);
      }
      return await origWrite(...args);
    };

    await expect(impl.mergeChanges(1, USER_META, "user-do-id"))
        .rejects.toThrow(/actively edited/);
    expect(impl.storage.gadgets.get(1)!.commitId).toBe(c1);  // head did not move
    expect(impl.storage.chatMeta.get(1)!.codeBase!.generation).toBe(0);  // no epoch reset
    expect(impl.listChatDraftUpdates(1)).toHaveLength(1);  // the raced draft survived

    // Once the typing settles, a retry merges everything, raced keystroke included.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(impl.listChatDraftUpdates(1)).toEqual([]);
    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(await impl.gitStore.readCommitFiles(head))
        .toEqual(new Map([["a.txt", "late\none\nfirst\n"]]));
  }));
});

describe("revert and draft discard", () => {
  it("rolls back reverted pins, discards drafts, and bumps the generation",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);
    let materialized = impl.materializeChatDraft(1)!;

    // Outstanding drafts recorded after the declaration die with the revert.
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "y")),
        1, { generation: 0 }, USER);

    await impl.revertChanges(1, materialized.sequence, USER);

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.gadgets).toEqual([]);  // the declaring message was reverted
    expect(codeBase.generation).toBe(1);
    expect(impl.listChatDraftUpdates(1)).toEqual([]);

    // The reverted declaration's seed no longer applies during reconstruction.
    let ydoc = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map());
  }));

  it("discardChatDraftChanges drops unlogged pins but keeps declared ones",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Pin 1 is declared in the log (materialized); pin 2 exists only in metadata, backed by
    // drafts that never materialized.
    let doc1 = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc1, () => doc1.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);
    impl.materializeChatDraft(1);
    let doc2 = editorDoc(2, "2", { "b.txt": "bee\n" });
    await impl.updateCode(
        captureEdit(doc2, () => doc2.getMap<Y.Text>("2").get("b.txt")!.insert(0, "y")),
        1, { generation: 0, pin: { gadgetId: 2, baseCommit: d1 } }, USER);

    impl.discardChatDraftChanges(1);

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.gadgets.map((pin: { gadgetId: number }) => pin.gadgetId)).toEqual([1]);
    expect(codeBase.generation).toBe(1);
    expect(impl.listChatDraftUpdates(1)).toEqual([]);
  }));

  it("a revert that affects no materialized changes still discards drafts",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    // One accepted batch, then an outstanding draft (with its unlogged pin) in the new epoch.
    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);
    let materialized = impl.materializeChatDraft(1)!;
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let head = impl.storage.gadgets.get(1)!.commitId!;
    let doc2 = editorDoc(1, "1", { "a.txt": "xone\n" });
    await impl.updateCode(
        captureEdit(doc2, () => doc2.getMap<Y.Text>("1").get("a.txt")!.insert(0, "y")),
        1, { generation: 1, pin: { gadgetId: 1, baseCommit: head } }, USER);
    expect(impl.listChatDraftUpdates(1)).toHaveLength(1);

    // Every message at or after revertFrom is already merged, so no revert message is
    // recorded -- but the drafts are strictly newer than every message, hence inside the
    // reverted range: they are discarded with their unlogged pin, and the generation bumps.
    await impl.revertChanges(1, materialized.sequence, USER);
    expect(chatMessages(impl, 1).filter(msg => msg.type === "revert")).toEqual([]);
    expect(impl.listChatDraftUpdates(1)).toEqual([]);
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.gadgets).toEqual([]);
    expect(codeBase.generation).toBe(2);
  }));
});

describe("updateChatFromMainline", () => {
  it("merges only pinned-and-behind gadgets, and its batch cannot be reverted",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let d1 = await commitFiles(impl, { "b.txt": "bee\n" });
    addGadget(impl, 1, "APP", c1);
    addGadget(impl, 2, "OTHER", d1);
    addChat(impl, 1);

    // Pin gadget 1 with an edit; leave gadget 2 unpinned.
    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "chat\n")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);
    impl.materializeChatDraft(1);

    // Mainline advances on both gadgets.
    let c2 = await commitFiles(impl, { "a.txt": "one\n", "new.txt": "fresh\n" }, [c1]);
    let record1 = impl.storage.gadgets.get(1)!;
    record1.commitId = c2;
    impl.storage.gadgets.put(record1);
    let d2 = await commitFiles(impl, { "b.txt": "changed\n" }, [d1]);
    let record2 = impl.storage.gadgets.get(2)!;
    record2.commitId = d2;
    impl.storage.gadgets.put(record2);

    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);

    // The pinned gadget merged and its pin advanced; the unpinned gadget was left alone --
    // it tracks head live, and no pin was created for it.
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    expect(codeBase.gadgets).toHaveLength(1);
    expect(codeBase.gadgets[0]).toMatchObject({ gadgetId: 1, mergedCommit: c2 });
    let ydoc = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map([
      ["a.txt", "one\nchat\n"],
      ["new.txt", "fresh\n"],
    ]));
    expect(readDocFiles(ydoc, "2")).toEqual(new Map());

    // The still-proposed mainline-merge batch cannot be reverted: it advanced the pin.
    let mainlineBatch = chatMessages(impl, 1)
        .find(msg => msg.type === "changes" && msg.mainlineMerge !== undefined)!;
    await expect(impl.revertChanges(1, mainlineBatch.sequence, USER))
        .rejects.toThrow(/update from mainline/);
  }));

  it("a gadget with no code pins at its empty-tree head and merges like any other",
      () => withImpl(async impl => {
    // Every permanent gadget has a head -- an empty-tree commit before it has code (see
    // GadgetRecord.commitId) -- so a chat's first edit always has a commit to pin, and losing
    // the race to the gadget's first real content is the ordinary stale/update/retry flow.
    let e0 = await commitFiles(impl, {});
    addGadget(impl, 1, "APP", e0);
    addChat(impl, 1);

    // The first edit pins at the empty tree (its seed is the deterministic empty-map seed).
    let doc = editorDoc(1, "1", {});
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").set("a.txt", new Y.Text("chat\n"))),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: e0 } }, USER);
    impl.materializeChatDraft(1);

    // Another chat wins the race to the gadget's first real content.
    let c1 = await commitFiles(impl, { "b.txt": "mainline\n" }, [e0]);
    let record = impl.storage.gadgets.get(1)!;
    record.commitId = c1;
    impl.storage.gadgets.put(record);

    // The chat can no longer fast-forward...
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "stale" });

    // ...but the normal pinned path covers it: a 3-way merge whose base is the pinned empty
    // tree, advancing the pin to head.
    let { conflictPaths } = await impl.updateChatFromMainline(1, USER);
    expect(conflictPaths).toEqual([]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.gadgets[0]).toMatchObject(
        { gadgetId: 1, seedCommit: e0, mergedCommit: c1 });
    let ydoc = await impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map([
      ["a.txt", "chat\n"],
      ["b.txt", "mainline\n"],
    ]));

    // The accept fast-forwards from the merged head.
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    let head = impl.storage.gadgets.get(1)!.commitId!;
    expect(await impl.gitStore.readCommitFiles(head)).toEqual(new Map([
      ["a.txt", "chat\n"],
      ["b.txt", "mainline\n"],
    ]));
    expect((await impl.gitStore.readCommitLog(head, { depth: 1 }))[0].parents).toEqual([c1]);
  }));
});

describe("chat log integrity", () => {
  it("buildChatDoc verifies every logged pin's seed hash, even in closed epochs",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let badPin: ChatChangesPin =
        { gadgetId: 1, filesRoot: "1", baseCommit: c1, seedHash: "0".repeat(64) };
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(1), author: USER,
      type: "changes", pins: [badPin],
    });

    await expect(impl.buildChatDoc(1, impl.storage.chatMeta.get(1)!))
        .rejects.toThrow(/seed derivation mismatch/);
  }));

  it("addChatMessages re-validates and mirrors agent-established pins",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let files = new Map([["a.txt", "one\n"]]);
    let seedHash = await seedUpdateHash(
        seedRootFromFiles("1", files, seedClientIdForGadget(1)));
    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    let update = captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(0, "x"));

    // A pin whose base is no longer the head fails the flush (mid-turn head movement).
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    let record = impl.storage.gadgets.get(1)!;
    record.commitId = c2;
    impl.storage.gadgets.put(record);
    expect(() => impl.addChatMessages(1, AGENT, [{
      type: "changes", update,
      pins: [{ gadgetId: 1, filesRoot: "1", baseCommit: c1, seedHash }],
    }])).toThrow(/no longer the gadget's head/);

    // At the current head it lands and is mirrored into the chat's code base.
    record = impl.storage.gadgets.get(1)!;
    record.commitId = c1;
    impl.storage.gadgets.put(record);
    impl.addChatMessages(1, AGENT, [{
      type: "changes", update,
      pins: [{ gadgetId: 1, filesRoot: "1", baseCommit: c1, seedHash }],
    }]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.gadgets[0]).toMatchObject(
        { gadgetId: 1, filesRoot: "1", seedCommit: c1, seedHash, mergedCommit: c1 });

    // Updates authoring under a reserved seed clientID are rejected at this ingestion point too.
    let rogue = new Y.Doc();
    rogue.clientID = seedClientIdForGadget(1);
    let rogueUpdate = captureEdit(rogue, () =>
        rogue.getMap<Y.Text>("1").set("evil.txt", new Y.Text("x")));
    expect(() => impl.addChatMessages(1, AGENT, [{ type: "changes", update: rogueUpdate }]))
        .toThrow(/reserved seed clientID/);
  }));

  it("buildChatDoc(through) reconstructs the doc as of that sequence, before a later boundary",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);

    let doc = editorDoc(1, "1", { "a.txt": "one\n" });
    await impl.updateCode(
        captureEdit(doc, () => doc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "chat\n")),
        1, { generation: 0, pin: { gadgetId: 1, baseCommit: c1 } }, USER);
    let materialized = impl.materializeChatDraft(1)!;
    // The snapshot a loader captures in the same synchronous step as its cache key.
    let preMeta = structuredClone(impl.storage.chatMeta.get(1)!);

    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });

    // As of `through` the merge hadn't happened: its epoch boundary must not wipe the
    // snapshot it postdates.
    let ydoc = await impl.buildChatDoc(1, preMeta, materialized.sequence);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map([["a.txt", "one\nchat\n"]]));
  }));

  it("buildChatDoc(through) with pre-graduation metadata rebuilds the legacy base",
      () => withImpl(async impl => {
    impl.storage.code.put(
        { version: 1, timestamp: new Date(0), update: Y.encodeStateAsUpdateV2(new Y.Doc()) });
    let base = new Y.Doc();
    let baseUpdate = captureEdit(base, () =>
        base.getMap<Y.Text>("1").set("a.txt", new Y.Text("one\n")));
    impl.storage.code.put({ version: 2, timestamp: new Date(1000), update: baseUpdate });

    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    addGadget(impl, 1, "APP", c1);
    addChat(impl, 1);
    let meta = impl.storage.chatMeta.get(1)!;
    meta.codeBase = { legacy: true, generation: 0,
                      gadgets: [{ gadgetId: 1, filesRoot: "1", mergedCommit: c1 }] };
    impl.storage.chatMeta.put(meta);

    let legacyDoc = new Y.Doc();
    Y.applyUpdateV2(legacyDoc, baseUpdate);
    bindLiveDocClientId(legacyDoc);
    impl.addChatMessages(1, AGENT, [{
      type: "changes",
      update: captureEdit(legacyDoc, () =>
          legacyDoc.getMap<Y.Text>("1").get("a.txt")!.insert(4, "agent\n")),
      observedCodeVersion: 2,
    }]);
    let through = impl.nextChatSequencePeek(1) - 1;
    let preMeta = structuredClone(impl.storage.chatMeta.get(1)!);

    // The graduating merge drops the `legacy` flag from live metadata...
    expect(await impl.mergeChanges(1, USER_META, "user-do-id"))
        .toEqual({ outcome: "merged" });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.legacy).toBeUndefined();

    // ...but a pre-graduation snapshot still reconstructs from the retired code log.
    let ydoc = await impl.buildChatDoc(1, preMeta, through);
    expect(readDocFiles(ydoc, "1")).toEqual(new Map([["a.txt", "one\nagent\n"]]));

    // A compaction advancing after the snapshot must not leak its stamp into the snapshot's
    // legacy anchor: the checkpoint comes from the *passed* meta's compactedTo (absent here),
    // not a fresh read of the live one.
    let v3 = new Y.Doc();
    Y.applyUpdateV2(v3, baseUpdate);
    impl.storage.code.put({
      version: 3, timestamp: new Date(2000),
      update: captureEdit(v3, () => v3.getMap<Y.Text>("1").get("a.txt")!.insert(0, "late\n")),
    });
    impl.storage.chatCompactions.put({
      chatId: 1, compactedTo: through + 1, summary: "s", chatBindings: [], nextChangeId: 1,
      observedCodeVersion: 3,
    });
    let live = impl.storage.chatMeta.get(1)!;
    live.compactedTo = through + 1;
    impl.storage.chatMeta.put(live);
    let again = await impl.buildChatDoc(1, preMeta, through);
    expect(readDocFiles(again, "1")).toEqual(new Map([["a.txt", "one\nagent\n"]]));
  }));
});
