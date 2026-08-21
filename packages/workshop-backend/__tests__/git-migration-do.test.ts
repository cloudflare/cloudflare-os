// Exercises the git-storage migration through its *real* trigger: the OverseerImpl constructor
// noticing `version` 1 and running #migrateToGitStorage under blockConcurrencyWhile, over real
// SQLite DO storage -- complementing git-migration.test.ts's direct migrateCodeLogToGit calls on
// mock storage. Each test seeds a legacy (version-1) workspace into a fresh DO, aborts every DO
// so the next touch re-runs the constructor, then asserts the migrated snapshots against an
// independent replay of the seeded Yjs update log.
//
// This lives in __tests__/ (the unit workerd config), not __integration__/: the TEST_OVERSEER
// DO binding exists only in vitest.config.ts, and no public API path can create a legacy
// workspace anymore (new workspaces are born at version 2), so seeding must reach into
// impl.storage -- the same pattern as chat-changes.test.ts. The public DO surface (open() etc.)
// is deliberately never called: #initializeNewWorkspace would stamp version 2 and shadow the
// scenario.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { HISTORY_COMMIT_GAP_MS } from "../src/git-migration";
import {
  LegacyWorkspace, MINUTE, T0, USER, expectHeadsMatchDoc, readDocFiles, setFile,
} from "./legacy-workspace";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// With no ownerId seeded, #ownerCommitIdentity() resolves to this documented fallback without
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
    // construction (#migrateStorage returns immediately at version 0 with no ownerId). If a
    // future constructor change starts initializing fresh DOs, this fails loudly and the
    // recipe needs rethinking.
    expect(impl.storage.version.get()).toBe(0);
    ws = new LegacyWorkspace(impl.storage);
    build(ws, impl);
    // ownerId is deliberately never seeded: it keeps #migrateStorage inert on re-entry and
    // makes #ownerCommitIdentity() return its fallback instead of calling a user DO.
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
    });

    await abortAllDurableObjects();

    await inOverseer("git-migration-single", async impl => {
      // The constructor's blockConcurrencyWhile completed before this event was delivered.
      expect(impl.storage.version.get()).toBe(2);

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
      expect(impl.storage.version.get()).toBe(2);

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
