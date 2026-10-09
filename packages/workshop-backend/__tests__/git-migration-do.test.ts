// Exercises the git-storage migration through its *real* trigger: the OverseerImpl constructor
// noticing `version` 1 and running migrateToGitStorage under blockConcurrencyWhile, over real
// SQLite DO storage -- complementing git-migration.test.ts's direct migrateCodeLogToGit calls on
// mock storage. Each test seeds a legacy (version-1) workspace into a fresh DO, aborts every DO
// so the next touch re-runs the constructor, then asserts the migrated snapshots against an
// independent replay of the seeded Yjs update log.
//
// This lives in __tests__/ (the unit workerd config), not __integration__/: the TEST_OVERSEER
// DO binding exists only in vitest.config.ts, and no public API path can create a legacy
// workspace anymore (new workspaces are born at version 4), so seeding must reach into
// impl.storage. The public DO surface (open() etc.) is deliberately never called:
// #initializeNewWorkspace would stamp version 4 and shadow the scenario.
//
// The version-3 action-index backfill, the version-4 workpiece-type stamp and the version-5
// blueprint-upstream backfill ride the same constructor trigger, so their tests live here too.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { HISTORY_COMMIT_GAP_MS } from "../src/storage-schema/overseer-git-migration";
import {
  OVERSEER_STORAGE_VERSION, UPSTREAM_BACKFILL_MESSAGE_LIMIT, migrateToBlueprintUpstreams,
} from "../src/storage-schema/overseer-migrations";
import {
  LegacyWorkspace, MINUTE, T0, USER, expectHeadsMatchDoc, readDocFiles, setFile,
} from "./legacy-workspace";
import { makePreIndexActionStorage, putAction } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// With no ownerId seeded, ownerCommitIdentity() resolves to this documented fallback without
// contacting any user DO.
const FALLBACK_OWNER = { name: "Workspace owner", email: "owner@localhost" };

// Mints a fresh stub per call: after abortAllDurableObjects() the previous stub is permanently
// poisoned, and only a fresh stub re-constructs the object.
async function inOverseer(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

// Seeds a legacy workspace into the named DO's real storage and arms the constructor trigger.
// The returned LegacyWorkspace lives in test scope, so its in-memory update log (docAt) survives
// the DO abort and serves as the post-migration oracle.
async function seedLegacyWorkspace(
    name: string, build: (ws: LegacyWorkspace, impl: any) => void): Promise<LegacyWorkspace> {
  let ws!: LegacyWorkspace;
  await inOverseer(name, async impl => {
    // Pins the seeding recipe's precondition: a fresh TEST_OVERSEER DO writes *nothing* at
    // construction (migrateToMultiGadget returns immediately at version 0 with no ownerId). If a
    // future constructor change starts initializing fresh DOs, this fails loudly and the
    // recipe needs rethinking.
    expect(impl.storage.version.get()).toBe(0);
    ws = new LegacyWorkspace(impl.storage);
    build(ws, impl);
    // ownerId is deliberately never seeded: it keeps migrateToMultiGadget inert on re-entry and
    // makes ownerCommitIdentity() return its fallback instead of calling a user DO.
    //
    // Last write: arm the constructor's version-1 git-storage migration trigger.
    impl.storage.version.put(1);
  });
  return ws;
}

describe("git-storage migration via the Overseer constructor", () => {
  it("migrates a single-gadget workspace, preserving content across the batching gap",
      async () => {
    let ws = await seedLegacyWorkspace("git-migration-single", (ws, impl) => {
      ws.addGadget(1, "APP");
      impl.storage.defaultGadgetId.put(1);  // the default gadget's legacy files root is ""

      // A burst of edits (within a minute of the constructor's empty v1, so that v1 doesn't
      // become its own commit point), then non-code versions, then an edit across the one-hour
      // batching boundary.
      ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "", "app.js", "hello\n"));            // v2
      ws.edit(T0 + 2 * MINUTE, doc => setFile(doc, "", "util.js", "util one\n"));        // v3
      ws.skipVersions(2);                                                                // v4-v5
      ws.edit(T0 + 2 * MINUTE + HISTORY_COMMIT_GAP_MS, doc => {
        setFile(doc, "", "app.js", "hello\nworld\n");
        setFile(doc, "", "util.js", "util two\n");
      });                                                                                // v6

      // A pending action written through an index-less view of the same storage, simulating a
      // record that predates the pendingByGatekeeper declaration. The version-3 step (chained
      // after the git migration in the same blockConcurrencyWhile) must backfill it.
      putAction(makePreIndexActionStorage(impl.ctx.storage), 1);
    });

    await abortAllDurableObjects();

    await inOverseer("git-migration-single", async impl => {
      // The constructor's blockConcurrencyWhile completed before this event was delivered,
      // running the whole migration ladder: git storage (2), the action indexes (3), then the
      // workpiece-type stamp (4).
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      expect([...impl.storage.actions.pendingByGatekeeper.list()].map((r: any) => r.id))
          .toEqual([1]);
      // The type stamp (3→4) covered the row the git migration wrote.
      expect(impl.storage.gadgets.get(1)!.type).toBe("gadget");

      await expectHeadsMatchDoc(impl.storage, impl.gitStore, ws.docAt("current"), 1);

      // Chain sanity: an empty parentless root, the pre-gap batch (v1-v3), and the final
      // version, linearly chained and authored as the ownerless fallback identity.
      let head = impl.storage.gadgets.get(1)!.commitId!;
      let log = await impl.gitStore.readCommitLog(head);
      expect(log.length).toBe(3);
      expect(log[0].parents).toEqual([log[1].oid]);
      expect(log[1].parents).toEqual([log[2].oid]);
      expect(log[2].parents).toEqual([]);
      expect(await impl.gitStore.readCommitFiles(log[2].oid)).toEqual(new Map());
      expect(await impl.gitStore.readCommitFiles(log[1].oid)).toEqual(new Map([
        ["app.js", "hello\n"],
        ["util.js", "util one\n"],
      ]));
      for (let entry of log) {
        expect(entry.author).toEqual(FALLBACK_OWNER);
      }
    });
  });

  it("migrates a multi-gadget workspace with per-gadget heads and unpolluted chains",
      async () => {
    let ws = await seedLegacyWorkspace("git-migration-multi", (ws, impl) => {
      ws.addGadget(1, "APP");   // default gadget: legacy files root ""
      ws.addGadget(2, "LEFT");  // root "2"
      ws.addGadget(3, "RIGHT"); // root "3"
      impl.storage.defaultGadgetId.put(1);
      ws.addChat(1);

      ws.edit(T0 + 1 * MINUTE, doc => setFile(doc, "", "app.js", "a one\n"));            // v2
      ws.addMessage(1, USER, { type: "merge", mergeThrough: 0, version: 2 });
      // One version touching two gadgets' roots at once.
      ws.edit(T0 + 2 * MINUTE, doc => {
        setFile(doc, "", "app.js", "a two\n");
        setFile(doc, "2", "left.js", "l one\n");
      });                                                                                // v3
      ws.addMessage(1, USER, { type: "merge", mergeThrough: 1, version: 3 });
      // A gap-spanning burst on gadget 3 alone: v4-v6 batch to one commit, v7 is its own.
      ws.edit(T0 + 3 * MINUTE, doc => setFile(doc, "3", "right.js", "r one\n"));         // v4
      ws.edit(T0 + 4 * MINUTE, doc => setFile(doc, "3", "extra.js", "r extra\n"));       // v5
      ws.edit(T0 + 5 * MINUTE, doc => setFile(doc, "3", "right.js", "r two\n"));         // v6
      ws.edit(T0 + 5 * MINUTE + HISTORY_COMMIT_GAP_MS,
          doc => setFile(doc, "3", "right.js", "r three\n"));                            // v7
    });

    await abortAllDurableObjects();

    await inOverseer("git-migration-multi", async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);

      // Every gadget's head equals its own root's content in an independent replay of the log.
      await expectHeadsMatchDoc(impl.storage, impl.gitStore, ws.docAt("current"), 1);

      // Non-pollution: each chain is the empty root plus that gadget's own commit points,
      // regardless of the others' activity, and carries only its own filenames.
      let logOf = async (gadgetId: number) =>
          await impl.gitStore.readCommitLog(impl.storage.gadgets.get(gadgetId)!.commitId!);
      let appLog = await logOf(1);
      let leftLog = await logOf(2);
      let rightLog = await logOf(3);
      expect(appLog.length).toBe(3);    // empty root + merge points v2 and v3
      expect(leftLog.length).toBe(2);   // empty root + merge point v3
      expect(rightLog.length).toBe(3);  // empty root + pre-gap batch (v6) + final (v7)

      expect(await impl.gitStore.readCommitFiles(appLog[1].oid))
          .toEqual(new Map([["app.js", "a one\n"]]));
      expect(await impl.gitStore.readCommitFiles(leftLog[0].oid))
          .toEqual(new Map([["left.js", "l one\n"]]));
      // Gadget 3's intermediate commit is the batch's end state, checked against the replay.
      expect(await impl.gitStore.readCommitFiles(rightLog[1].oid))
          .toEqual(readDocFiles(ws.docAt(6), "3"));
    });
  });
});

describe("action-index backfills via the Overseer constructor", () => {
  it("backfills a version-2 workspace's indexes and stamps version 3", async () => {
    await inOverseer("pending-index-v2", async impl => {
      expect(impl.storage.version.get()).toBe(0);
      // Seed through an index-less view of the same real storage, simulating records written
      // before the action indexes were declared (their entries only exist for writes made after
      // the declarations).
      let legacy = makePreIndexActionStorage(impl.ctx.storage);
      putAction(legacy, 1);
      putAction(legacy, 2, { state: "approved" });
      putAction(legacy, 3, { gatekeeperId: 2 });
      // Last write: arm the constructor's version-2 migration.
      impl.storage.version.put(2);
    });

    await abortAllDurableObjects();

    await inOverseer("pending-index-v2", async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      // The pending index sees exactly the pendings (grouped by gatekeeper, so 1 before 3 here).
      expect([...impl.storage.actions.pendingByGatekeeper.list()].map((r: any) => r.id))
          .toEqual([1, 3]);
      // The history-filter index serves every key over the seeded records.
      expect([...impl.storage.actions.byHistoryFilter.get("action")].map((r: any) => r.id))
          .toEqual([1, 2, 3]);
      expect([...impl.storage.actions.byHistoryFilter.get("pending")].map((r: any) => r.id))
          .toEqual([1, 3]);
      // The last-changed index covers the whole log, in change-time order.
      expect([...impl.storage.actions.byLastChanged.list()].map((r: any) => r.id))
          .toEqual([1, 2, 3]);

      // Resolving a backfilled record must not throw on the index updates -- the failure mode
      // that makes these backfills mandatory rather than an optimization.
      let record = impl.storage.actions.get(1)!;
      record.state = "approved";
      record.appliedAt = new Date();
      impl.storage.actions.put(record);
      expect([...impl.storage.actions.pendingByGatekeeper.list()].map((r: any) => r.id))
          .toEqual([3]);
      expect([...impl.storage.actions.byHistoryFilter.get("pending")].map((r: any) => r.id))
          .toEqual([3]);
      expect([...impl.storage.actions.byLastChanged.list()].map((r: any) => r.id))
          .toEqual([2, 3, 1]);
    });
  });
});

describe("the blueprint-upstream backfill via the Overseer constructor", () => {
  const AGENT = { type: "agent", id: "some-model", name: "Agent" };

  function putGadget(impl: any, id: number, extra: object = {}): void {
    impl.storage.gadgets.put({
      type: "gadget", id, title: `Gadget ${id}`, created: new Date(0), bindingName: `G${id}`,
      bindings: {}, ...extra,
    });
  }

  function putChat(impl: any, id: number): void {
    impl.storage.chatMeta.put(
        { id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
  }

  // The agent's message for a step in which it called createGadget, as the log records it. A
  // call that succeeded recorded the gadget it made.
  function putCreation(impl: any, chatId: number, sequence: number,
                       call: { gadgetId?: number, blueprintId?: string, error?: string }): void {
    impl.storage.chats.put({
      chatId, sequence, timestamp: new Date(chatId * 1_000_000 + sequence), author: AGENT,
      type: "message", message: "",
      toolCalls: [{
        toolCallId: `call-${chatId}-${sequence}`, toolName: "createGadget",
        input: {
          title: "Made", bindingName: "MADE",
          ...(call.blueprintId !== undefined ? { blueprintId: call.blueprintId } : {}),
        },
        ...(call.gadgetId !== undefined
            ? { output: { gadgetId: call.gadgetId, changeId: 1 } } : {}),
        ...(call.error !== undefined ? { error: call.error } : {}),
      }],
    });
  }

  // A "changes" message that records the creation of gadgets and nothing else.
  function putCreated(impl: any, chatId: number, sequence: number, author: object,
                      gadgetIds: number[], extra: object = {}): void {
    impl.storage.chats.put({
      chatId, sequence, timestamp: new Date(chatId * 1_000_000 + sequence), author,
      type: "changes",
      createdGadgets: gadgetIds.map(
          gadgetId => ({ gadgetId, title: `Gadget ${gadgetId}`, bindingName: `G${gadgetId}` })),
      ...extra,
    });
  }

  function putText(impl: any, chatId: number, sequence: number): void {
    impl.storage.chats.put({
      chatId, sequence, timestamp: new Date(chatId * 1_000_000 + sequence), author: USER,
      type: "message", message: "And another thing.",
    });
  }

  it("names the blueprint of each gadget an agent created from one, and none for each made " +
      "from scratch", async () => {
    await inOverseer("upstream-backfill", async impl => {
      expect(impl.storage.version.get()).toBe(0);
      putGadget(impl, 1);
      putGadget(impl, 2);
      putGadget(impl, 3, { upstream: { blueprintId: "followed", commitId: "f".repeat(40) } });
      putGadget(impl, 4, { pending: { chatId: 2, sequence: 1 } });
      putGadget(impl, 5);
      putGadget(impl, 6);
      putGadget(impl, 7);
      putGadget(impl, 8);

      putChat(impl, 1);
      putText(impl, 1, 0);
      // Each of the agent's calls is followed by its step's record of the creation, in the
      // agent's name, which tells nothing that the call does not.
      putCreation(impl, 1, 1, { gadgetId: 1, blueprintId: "docs" });
      putCreated(impl, 1, 2, AGENT, [1]);
      putCreation(impl, 1, 3, { gadgetId: 2 });  // created empty
      putCreated(impl, 1, 4, AGENT, [2]);
      putCreation(impl, 1, 5, { gadgetId: 3, blueprintId: "sheets" });
      // A creation since reverted, whose gadget is gone, and a call that failed.
      putCreation(impl, 1, 6, { gadgetId: 99, blueprintId: "docs" });
      putCreation(impl, 1, 7, { blueprintId: "docs", error: "No such blueprint: docs." });
      // What the user created from the workspace UI, with the chat open.
      putCreated(impl, 1, 8, USER, [6]);
      // The message that converted a chat from the storage before git lists again, in the
      // owner's name, the gadgets pending there: whoever created them, and from whatever.
      putCreated(impl, 1, 9, USER, [1, 7], { conversionBoundary: true });
      // An agent's creation whose call is gone from the log, though its record is not.
      putCreated(impl, 1, 10, AGENT, [8]);
      putChat(impl, 2);
      putCreation(impl, 2, 0, { gadgetId: 4, blueprintId: "slides" });
      // Last write: arm the constructor's version-4 migration.
      impl.storage.version.put(4);
    });

    await abortAllDurableObjects();

    await inOverseer("upstream-backfill", async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      let upstreams = [...impl.storage.gadgets.list()].map((gadget: any) => gadget.upstream);
      expect(upstreams).toEqual([
        // The blueprint, and no release: the log does not tell which the gadget took.
        { blueprintId: "docs" },
        // No blueprint: the agent made it from scratch.
        {},
        // What a gadget already follows stands.
        { blueprintId: "followed", commitId: "f".repeat(40) },
        { blueprintId: "slides" },
        // Nothing in the log tells of this one: it was instantiated outside any chat, say, or
        // the chat that created it was deleted.
        undefined,
        // The user made it from scratch.
        {},
        // These two the log lists, but not in a way that tells what they were made from.
        undefined,
        undefined,
      ]);
      // A gadget still pending in its chat stays so.
      expect(impl.storage.gadgets.get(4).pending).toEqual({ chatId: 2, sequence: 1 });
      expect(impl.storage.gadgets.get(99)).toBeUndefined();
    });
  });

  it("reads the start of each chat, within one budget that the chats share", async () => {
    // Two chats, so half the budget each. The first uses two messages of its half and the
    // second gets the rest, which reaches the creation of gadget 1 but not that of gadget 2.
    let reach = UPSTREAM_BACKFILL_MESSAGE_LIMIT - 2;
    await inOverseer("upstream-backfill-budget", async impl => {
      putGadget(impl, 1);
      putGadget(impl, 2);
      putChat(impl, 1);
      putText(impl, 1, 0);
      putText(impl, 1, 1);
      putChat(impl, 2);
      for (let sequence = 0; sequence < reach - 1; sequence++) putText(impl, 2, sequence);
      putCreation(impl, 2, reach - 1, { gadgetId: 1, blueprintId: "docs" });
      putCreation(impl, 2, reach, { gadgetId: 2, blueprintId: "docs" });
      impl.storage.version.put(4);
    });

    await abortAllDurableObjects();

    await inOverseer("upstream-backfill-budget", async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      expect(impl.storage.gadgets.get(1).upstream).toEqual({ blueprintId: "docs" });
      expect(impl.storage.gadgets.get(2).upstream).toBeUndefined();
    });
  });

  // Skipping the scan changes nothing that is stored, so this runs the migration by hand, over
  // chat collections that refuse to be read.
  it.each([
    ["no gadget", (_impl: any) => {}],
    ["no gadget but ones that follow a blueprint already", (impl: any) => {
      putGadget(impl, 1, { upstream: { blueprintId: "followed", commitId: "f".repeat(40) } });
    }],
  ])("reads no chat in a workspace with %s", async (description, seed) => {
    await inOverseer(`upstream-backfill-skip: ${description}`, async impl => {
      expect(impl.storage.version.get()).toBe(0);
      seed(impl);
      putChat(impl, 1);
      putCreation(impl, 1, 0, { gadgetId: 1, blueprintId: "docs" });
      impl.storage.version.put(4);

      let unread = { value: { list: () => { throw new Error("read a chat"); } } };
      let storage = Object.create(impl.storage, { chatMeta: unread, chats: unread });
      migrateToBlueprintUpstreams(Object.create(impl, { storage: { value: storage } }));

      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
    });
  });
});
