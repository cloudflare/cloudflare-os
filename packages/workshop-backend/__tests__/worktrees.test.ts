import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeChange, type CodeContent, type FileChange }
  from "@gadgets/workshop-shared/code-change";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerDurableObject } from "../src/overseer.js";
import { buildCompactionState } from "../src/agent-compaction";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the worktree workpiece lifecycle against the real OverseerImpl in workerd: the
// version-4 record-type migration, createWorktree (local commits, prefix resolution, pull
// routing), the barrier's creation record + birth pin, lazy worktree content in the chat's
// change stream (edits seed their base texts on demand; untouched files are never
// materialized), revert/deletion cleanup, chat-privacy, and the client delivery filtering that
// keeps worktree content out of everything a client receives. Each test gets a fresh DO, whose
// storage stays at version 0 (never initialized), so records seeded by tests carry their type
// explicitly and migration tests can arm the constructor trigger by hand.

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: USER };

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>, name?: string): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name ?? `worktrees-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

function addChat(impl: any, id: number): void {
  // lastActive varies by id: chatMeta.byLastActive is a unique index.
  impl.storage.chatMeta.put(
      { id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
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

function chatMessages(impl: any, chatId: number): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

// One agent step at the barrier, as the turn_end persister would commit it.
async function barrier(impl: any, chatId: number, step: {
  changes?: { change: CodeChange }[],
  createdWorktrees?: { worktreeId: number, title: string, bindingName: string }[],
  worktreeCommits?: { worktreeId: number, commit: string, previousHead: string }[],
}): Promise<boolean> {
  return await impl.commitAgentStep(chatId, AGENT, [{ type: "message", message: "step" }], {
    changes: step.changes ?? [],
    createdGadgets: [],
    createdWorktrees: step.createdWorktrees ?? [],
    addedBindings: [],
    worktreeCommits: step.worktreeCommits ?? [],
  });
}

// Creates a worktree and commits its creation through the barrier, returning the worktree id,
// its base commit, and the sequence of the "changes" message that recorded the creation.
async function createThroughBarrier(impl: any, chatId: number, commitRef: string,
                                    bindingName = "REPO")
    : Promise<{ id: number, baseCommit: string, stamp: number }> {
  let created = await impl.createWorktree("Repo", chatId, commitRef);
  await barrier(impl, chatId, {
    createdWorktrees: [{ worktreeId: created.id, title: created.title, bindingName }],
  });
  return { id: created.id, baseCommit: created.baseCommit,
           stamp: impl.storage.gadgets.get(created.id)!.pending!.sequence! };
}

// The chat's current content for one workpiece, as a plain object.
async function workpieceContent(
    impl: any, chatId: number, id: number): Promise<Record<string, string>> {
  let content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
  return Object.fromEntries(content.get(id) ?? new Map());
}

// An `edit` FileChange for one worktree file, built the way clients build theirs.
function editChange(id: number, path: string, before: string, after: string): CodeChange {
  let content = (text: string): CodeContent => new Map([[id, new Map([[path, text]])]]);
  let change = diffFiles(content(before), content(after));
  expect("edit" in (change[id][0][1] as object)).toBe(true);  // guard: really an edit, not a set
  return change;
}

describe("the version 3 -> 4 workpiece-type migration", () => {
  it("stamps pre-existing rows, preserving their byBindingName entries", async () => {
    await withImpl(async impl => {
      expect(impl.storage.version.get()).toBe(0);
      // Pre-v4 rows: no `type` discriminant on disk.
      impl.storage.gadgets.put({
        id: 1, title: "App", created: new Date(0), bindingName: "APP", bindings: {},
      });
      impl.storage.gadgets.put({
        id: 2, title: "Tool", created: new Date(0), bindingName: "TOOL", bindings: {},
        pending: { chatId: 1, sequence: 5 },
      });
      // Last write: arm the constructor's version-3 trigger.
      impl.storage.version.put(3);
    }, "worktrees-migration");

    await abortAllDurableObjects();

    await withImpl(async impl => {
      expect(impl.storage.version.get()).toBe(4);
      expect(impl.storage.gadgets.get(1)!.type).toBe("gadget");
      expect(impl.storage.gadgets.get(2)!.type).toBe("gadget");
      // Pending survives the stamp, and the unique index still resolves both names.
      expect(impl.storage.gadgets.get(2)!.pending).toEqual({ chatId: 1, sequence: 5 });
      expect(impl.storage.gadgets.byBindingName.get("APP")!.id).toBe(1);
      expect(impl.storage.gadgets.byBindingName.get("TOOL")!.id).toBe(2);
    }, "worktrees-migration");
  });

  it("leaves a never-initialized DO write-free", async () => {
    await withImpl(async impl => {
      expect(impl.storage.version.get()).toBe(0);
    }, "worktrees-untouched");

    await abortAllDurableObjects();

    await withImpl(async impl => {
      // Re-construction ran every migration guard; none wrote anything.
      expect(impl.storage.version.get()).toBe(0);
      expect([...impl.storage.gadgets.list()]).toEqual([]);
    }, "worktrees-untouched");
  });
});

describe("createWorktree", () => {
  it("creates a chat-private pending record from a local commit, with prefix resolution",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });

    let created = await impl.createWorktree("My Repo", 1, c1.slice(0, 12));
    expect(created.baseCommit).toBe(c1);
    let record = impl.storage.gadgets.get(created.id)!;
    expect(record).toMatchObject({
      type: "worktree", title: "My Repo", chatId: 1,
      baseCommit: c1, headCommit: c1, pinBase: c1,
      pending: { chatId: 1 },
    });
    // A purely local commit has no gatekeeper source.
    expect(record.sourceGatekeeperId).toBeUndefined();
    expect(record.bindingName).toBeUndefined();

    // A second worktree at the same commit is fine: no workspace-level name is claimed.
    let again = await impl.createWorktree("My Repo Again", 1, c1);
    expect(impl.storage.gadgets.get(again.id)!.baseCommit).toBe(c1);
  }));

  it("rejects unknown refs, and surfaces provenance loss from the initial pull",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await expect(impl.createWorktree("W", 1, "feed".repeat(10)))
        .rejects.toThrow(/not known to this workspace/);

    // A commit known only from metadata triggers the initial pull, routed to its recorded
    // source -- here a gatekeeper whose record no longer exists, the actionable error case.
    let oid = "abcd".repeat(10);
    impl.storage.gitObjectMetadata.put(
        { oid, type: "commit", onRemote: [99], pullableFrom: [], pendingPush: [] });
    await expect(impl.createWorktree("W", 1, oid)).rejects.toThrow(/[Rr]econnect/);
  }));

  it("records the first recorded source as sourceGatekeeperId", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    impl.storage.gitObjectMetadata.put(
        { oid: c1, type: "commit", onRemote: [42], pullableFrom: [], pendingPush: [] });
    let created = await impl.createWorktree("W", 1, c1);
    expect(impl.storage.gadgets.get(created.id)!.sourceGatekeeperId).toBe(42);
  }));
});

describe("worktrees in the chat change stream", () => {
  it("records the creation and birth pin at the barrier, and stamps the pending record",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, stamp } = await createThroughBarrier(impl, 1, c1);

    let changes = chatMessages(impl, 1).find(msg => msg.type === "changes")!;
    expect(changes.sequence).toBe(stamp);
    expect(changes.createdWorktrees).toEqual(
        [{ worktreeId: id, title: "Repo", bindingName: "REPO" }]);
    expect(changes.createdGadgets).toBeUndefined();
    // The birth pin is declared on the same message and mirrored into the live code base.
    expect(changes.pins).toEqual([{ gadgetId: id, baseCommit: c1 }]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
  }));

  it("applies agent edits lazily: base texts seed on demand, untouched files never materialize",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl,
        { "a.txt": "one\n", "src/b.txt": "bee\n", "src/c.txt": "sea\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // A later step: a whole-file write (set) plus an edit of a base file the content map has
    // never held -- the edit's base text must seed from the pinned commit.
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["new.txt", { set: "fresh\n" }]] } },
      { change: editChange(id, "a.txt", "one\n", "one!\n") },
    ]});

    expect(await workpieceContent(impl, 1, id)).toEqual({
      "a.txt": "one!\n",
      "new.txt": "fresh\n",
      // src/b.txt and src/c.txt are deliberately absent: worktree content holds only
      // touched/seeded paths, never the whole base tree.
    });

    // Replay determinism: a fresh fold of the log alone reconstructs the same content.
    impl.invalidateChatContent(1);
    expect(await workpieceContent(impl, 1, id)).toEqual({
      "a.txt": "one!\n",
      "new.txt": "fresh\n",
    });
  }));

  it("accepts client-submitted worktree changes, seeding edit bases the same way",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;

    let ack = await impl.submitCodeChange(1, {
      generation: codeBase.generation, revision: codeBase.revision,
      clientId: "cli-w", seq: 1,
      change: editChange(id, "a.txt", "one\n", "one two\n"),
    }, USER, "user-do");
    expect(ack).toEqual({ generation: codeBase.generation, revision: codeBase.revision + 1 });
    expect(await workpieceContent(impl, 1, id)).toEqual({ "a.txt": "one two\n" });
  }));

  it("rejects client-submitted sets and removes over symlink and gitlink base entries",
      () => withImpl(async impl => {
    addChat(impl, 1);
    // The real-git fixture repo, fully local so nothing ever pulls: COMMIT_1 holds a symlink
    // `link.md` (target README.md) and a gitlink `vendored`.
    for (let object of FIXTURE_OBJECTS) {
      if (PACKED_OIDS.includes(object.oid)) {
        await impl.gitCache.putFromGatekeeper(999, object.type, b64Bytes(object.payload));
      }
    }
    let { id } = await createThroughBarrier(impl, 1, COMMIT_1);
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    // A fresh clientId per attempt: a rejected submission never establishes its dedupe session.
    let submit = (n: number, entry: [string, FileChange]) => impl.submitCodeChange(1, {
      generation: codeBase.generation, revision: codeBase.revision,
      clientId: `cli-${n}`, seq: 1,
      change: { [id]: [entry] },
    }, USER, "user-do");

    // The ingestion check mirrors the agent's writeFile tool: a whole-file write or a delete
    // whose path still has a live symlink/gitlink base entry is rejected with the read errors.
    await expect(submit(1, ["link.md", { set: "clobber\n" }]))
        .rejects.toThrow("link.md is a symlink to README.md");
    await expect(submit(2, ["vendored", { remove: true }]))
        .rejects.toThrow(/vendored is a submodule \(gitlink\)/);
    // A directory path rejects both shapes: a write could never commit, and removing a
    // directory isn't a thing -- deleting all its files prunes it from the committed tree.
    await expect(submit(5, ["src", { set: "clobber\n" }]))
        .rejects.toThrow("src is a directory");
    await expect(submit(6, ["src", { remove: true }]))
        .rejects.toThrow("src is a directory");
    // Edits get the same rejection from their base seeding.
    await expect(submit(3, ["link.md", editChange(id, "link.md", "x\n", "y\n")[id][0][1]]))
        .rejects.toThrow("link.md is a symlink to README.md");
    // A new path passes untouched.
    expect(await submit(4, ["notes.txt", { set: "hello\n" }]))
        .toEqual({ generation: codeBase.generation, revision: codeBase.revision + 1 });
  }));

  it("rejects another chat's touches and hides the worktree from other chats",
      () => withImpl(async impl => {
    addChat(impl, 1);
    addChat(impl, 2);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // File tools resolve it only for the owning chat.
    expect(impl.resolveWorkpieceRoot(id, true, 1).workpieceId).toBe(id);
    expect(() => impl.resolveWorkpieceRoot(id, true, 2)).toThrow(/No such gadget/);

    // And a foreign chat's submission is rejected outright.
    await expect(impl.submitCodeChange(2, {
      generation: 0, revision: 0, clientId: "cli-x", seq: 1,
      change: { [id]: [["a.txt", { set: "clobber\n" }]] },
    }, USER, "user-do")).rejects.toThrow(/another chat's worktree/);
  }));

  it("gives gadget-only paths a clear error for worktree ids", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    expect(() => impl.getGadgetRecord(id)).toThrow(/is a worktree, not a gadget/);
    // readGadgetFiles guards independently: it can serve chat content without touching
    // getGadgetRecord, and a worktree id here would hand chat-private content to client paths.
    await expect(impl.readGadgetFiles(id, 1)).rejects.toThrow(/is a worktree, not a gadget/);
  }));
});

describe("worktree lifecycle", () => {
  it("a revert covering the creation deletes the worktree and drops its pin",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, stamp } = await createThroughBarrier(impl, 1, c1);

    await impl.revertChanges(1, stamp, USER);
    expect(impl.storage.gadgets.get(id)).toBeUndefined();
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual([]);
  }));

  it("an unstamped record is a crash orphan that reconciliation reaps",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    // The tool ran (record created) but the step never reached its barrier.
    let created = await impl.createWorktree("Doomed", 1, c1);
    expect(impl.storage.gadgets.get(created.id)!.pending).toEqual({ chatId: 1 });

    await impl.reconcilePendingGadgets(1);
    expect(impl.storage.gadgets.get(created.id)).toBeUndefined();
  }));

  it("an accept promotes a covered creation without committing anything for it",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["new.txt", { set: "fresh\n" }]] } },
    ]});

    expect(await impl.mergeChanges(1, USER_META, "client-user")).toEqual({ outcome: "merged" });
    let record = impl.storage.gadgets.get(id)!;
    expect(record.pending).toBeUndefined();      // promoted: the creation is durable
    expect(record.chatId).toBe(1);               // ...but still chat-private for life
    expect(record.headCommit).toBe(c1);          // no head-commit work for worktrees
    let merge = chatMessages(impl, 1).find(msg => msg.type === "merge")!;
    expect(merge.commits).toEqual([]);           // nothing committed, nothing gated
  }));

  it("chat deletion removes the chat's worktrees, accepted or not",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id: accepted } = await createThroughBarrier(impl, 1, c1);
    await impl.mergeChanges(1, USER_META, "client-user");
    let pending = await impl.createWorktree("Pending", 1, c1);

    await impl.removeChatWorkpieces(1);
    expect(impl.storage.gadgets.get(accepted)).toBeUndefined();
    expect(impl.storage.gadgets.get(pending.id)).toBeUndefined();
  }));
});

describe("client delivery filtering", () => {
  it("strips worktree entries from live changeApplied broadcasts, preserving revisions",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    let received: { revision: number, change: CodeChange }[] = [];
    impl.addChatSubscriber({
      changeApplied: async (_chatId: number, _generation: number, revision: number,
                            _author: unknown, change: CodeChange) => {
        received.push({ revision, change });
      },
      [Symbol.dispose]: () => {},
    });

    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    await impl.submitCodeChange(1, {
      generation: codeBase.generation, revision: codeBase.revision,
      clientId: "cli-w", seq: 1,
      change: { [id]: [["secret.txt", { set: "worktree content\n" }]] },
    }, USER, "user-do");

    // The row was delivered -- its revision advances the stream gaplessly -- but carries no
    // worktree content.
    expect(received).toEqual([{ revision: codeBase.revision + 1, change: {} }]);
    // The stored row itself is intact (stripping is delivery-only).
    expect(await workpieceContent(impl, 1, id)).toEqual({ "secret.txt": "worktree content\n" });
  }));

  it("strips worktree content and pins from delivered messages, keeping ids and watermarks",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let created = await impl.createWorktree("Repo", 1, c1);
    await barrier(impl, 1, {
      createdWorktrees: [{ worktreeId: created.id, title: "Repo", bindingName: "REPO" }],
      changes: [{ change: { [created.id]: [["secret.txt", { set: "worktree content\n" }]] } }],
    });

    let stored = chatMessages(impl, 1).find(msg => msg.type === "changes")!;
    expect(stored.change).toBeDefined();  // storage keeps everything
    expect(stored.pins).toHaveLength(1);

    let delivered = impl.hydrateChatMessageForClient(stored);
    expect(delivered.change).toBeUndefined();          // all-worktree change: dropped outright
    expect(delivered.pins).toBeUndefined();            // the pin is the base-fetch trigger
    expect(delivered.watermark).toEqual(stored.watermark);  // clients still drop their rows
    expect(delivered.createdWorktrees).toEqual(stored.createdWorktrees);  // ids stay visible
    // The stored message was not mutated.
    expect(stored.pins).toHaveLength(1);
  }));

  it("keeps stripping a reverted worktree's content after its record is deleted",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let created = await impl.createWorktree("Repo", 1, c1);
    await barrier(impl, 1, {
      createdWorktrees: [{ worktreeId: created.id, title: "Repo", bindingName: "REPO" }],
      changes: [{ change: { [created.id]: [["secret.txt", { set: "worktree content\n" }]] } }],
    });
    let stamp = impl.storage.gadgets.get(created.id)!.pending!.sequence!;

    // Reverting the creation deletes the registry record...
    await impl.revertChanges(1, stamp, USER);
    expect(impl.storage.gadgets.get(created.id)).toBeUndefined();

    // ...but the reverted "changes" message -- content and pin included -- stays in the log,
    // and a history read after the deletion must strip it exactly as before (the record is
    // gone, so the stripping rests on the deadWorktreeIds tombstone).
    let stored = chatMessages(impl, 1).find(msg => msg.type === "changes")!;
    expect(stored.change).toBeDefined();
    expect(stored.pins).toHaveLength(1);
    let delivered = impl.hydrateChatMessageForClient(stored);
    expect(delivered.change).toBeUndefined();
    expect(delivered.pins).toBeUndefined();
    expect(JSON.stringify(delivered)).not.toContain("worktree content");
  }));

  it("keeps gadget entries while stripping worktree entries from a mixed batch",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let gadget = impl.createGadget("Gadget", "GADGET_X", 1);
    await barrier(impl, 1, { changes: [
      { change: {
        [gadget.id]: [["main.js", { set: "code\n" }]],
        [id]: [["secret.txt", { set: "worktree content\n" }]],
      } },
    ]});

    let stored = chatMessages(impl, 1).filter(msg => msg.type === "changes").at(-1)!;
    let delivered = impl.hydrateChatMessageForClient(stored);
    expect(Object.keys(delivered.change!)).toEqual([`${gadget.id}`]);
    expect(JSON.stringify(delivered)).not.toContain("worktree content");
  }));

  it("strips worktree pins from delivered chat metadata", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    let meta = impl.storage.chatMeta.get(1)!;
    expect(meta.codeBase!.pins.some((pin: any) => pin.gadgetId === id)).toBe(true);
    let delivered = impl.chatMetaForClient(meta);
    expect(delivered.codeBase!.pins).toEqual([]);
    // The stored metadata was not mutated.
    expect(meta.codeBase!.pins).toHaveLength(1);
  }));

  it("worktree-only changes propose nothing: no banner, no chat-scoped gadget loads",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, baseCommit } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [
      { change: { [id]: [["a.txt", { set: "edited\n" }]] } },
    ]});
    await barrier(impl, 1, { worktreeCommits: [{
      worktreeId: id,
      commit: await commitFiles(impl, { "a.txt": "edited\n" }, [baseCommit]),
      previousHead: baseCommit,
    }]});

    // The worktree is created, edited, and committed -- as proposed as a worktree gets -- yet
    // the chat proposes nothing a client could see or act on: worktrees have no UI, so the
    // pending-changes affordances must not prompt for them (see proposedChangeWorkpieceIds; its
    // doc comment covers why worktree pins can never drive this even once worktrees get UI).
    let meta = impl.storage.chatMeta.get(1)!;
    expect(impl.proposedChangeWorkpieceIds(1, meta)).toEqual([]);
    expect(impl.chatMetaForClient(meta).proposedChangeWorkpieces).toBeUndefined();
  }));

  it("a mixed chat proposes only its gadget workpieces", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let gadget = impl.createGadget("Gadget", "GADGET_X", 1);
    await barrier(impl, 1, { changes: [
      { change: {
        [gadget.id]: [["main.js", { set: "code\n" }]],
        [id]: [["secret.txt", { set: "worktree content\n" }]],
      } },
    ]});

    let meta = impl.storage.chatMeta.get(1)!;
    expect(impl.proposedChangeWorkpieceIds(1, meta)).toEqual([gadget.id]);
    expect(impl.chatMetaForClient(meta).proposedChangeWorkpieces).toEqual([gadget.id]);
  }));
});

describe("worktree commit head advancements", () => {
  it("advances headCommit at the barrier, recording ordered worktreeCommits on the message",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Two explicit commits within one step (as two commit() calls in one executeCode would
    // buffer them): the barrier validates the previousHead chain and applies both in order.
    let c2 = await impl.gitStore.writeChangedFilesAsCommit(
        new Map([["a.txt", "two\n"]]),
        { treeBase: c1, parents: [c1], author: { name: "A", email: "a@x" },
          message: "first", timestamp: new Date(1700000000_000) });
    let c3 = await impl.gitStore.writeChangedFilesAsCommit(
        new Map([["a.txt", "three\n"]]),
        { treeBase: c1, parents: [c2], author: { name: "A", email: "a@x" },
          message: "second", timestamp: new Date(1700000001_000) });
    await barrier(impl, 1, { worktreeCommits: [
      { worktreeId: id, commit: c2, previousHead: c1 },
      { worktreeId: id, commit: c3, previousHead: c2 },
    ]});

    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c3);
    let message = chatMessages(impl, 1)
        .findLast(msg => msg.type === "changes" && msg.worktreeCommits !== undefined)!;
    expect(message.worktreeCommits).toEqual([
      { worktreeId: id, commit: c2, previousHead: c1 },
      { worktreeId: id, commit: c3, previousHead: c2 },
    ]);
    // The pin (and hence content reconstruction) is untouched by explicit commits.
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(c1);
  }));

  it("fails the barrier on a broken previousHead chain, leaving the head unchanged",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);

    await expect(barrier(impl, 1, { worktreeCommits: [
      { worktreeId: id, commit: c2, previousHead: c2 },  // wrong: head is c1
    ]})).rejects.toThrow(/head moved during the turn/);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
  }));

  it("rejects advancements for another chat's worktree", () => withImpl(async impl => {
    addChat(impl, 1);
    addChat(impl, 2);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);

    await expect(barrier(impl, 2, { worktreeCommits: [
      { worktreeId: id, commit: c2, previousHead: c1 },
    ]})).rejects.toThrow(/not this chat's worktree/);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
  }));

  it("a revert rolls each affected head back to the earliest reverted previousHead",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    let c2 = await commitFiles(impl, { "a.txt": "two\n" }, [c1]);
    let c3 = await commitFiles(impl, { "a.txt": "three\n" }, [c2]);

    // Two advancements across two steps (separate barriers, like two executeCode calls in one
    // turn -- or two turns).
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c2, previousHead: c1 }]});
    let firstStamp = chatMessages(impl, 1)
        .findLast(msg => msg.type === "changes" && msg.worktreeCommits !== undefined)!.sequence;
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c3, previousHead: c2 }]});
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c3);

    // Reverting a range spanning both advancements returns the head to before the first.
    await impl.revertChanges(1, firstStamp, USER);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
    // The commit objects remain (dangling, like auto-commits).
    expect(impl.gitCache.hasLocalObject(c3)).toBe(true);
  }));
});

describe("epoch reset re-pins worktrees", () => {
  it("auto-commits a dirty worktree and re-pins, preserving content and leaving the head alone",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n", "src/b.txt": "bee\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [
      { change: editChange(id, "a.txt", "one\n", "one!\n") },
      { change: { [id]: [["new.txt", { set: "fresh\n" }]] } },
      { change: { [id]: [["src/b.txt", { remove: true }]] } },
    ]});

    expect(await impl.mergeChanges(1, USER_META, "client-user")).toEqual({ outcome: "merged" });

    // The record re-pinned at a fresh auto-commit; the head (explicit history) is untouched.
    let record = impl.storage.gadgets.get(id)!;
    expect(record.pinBase).not.toBe(c1);
    expect(record.headCommit).toBe(c1);
    expect(record.baseCommit).toBe(c1);

    // The auto-commit captures the overlay exactly: edits, new files, and deletions (whose
    // emptied directory is pruned), parenting on the old pin base.
    expect(await impl.readFileAtCommit(record.pinBase, "a.txt")).toBe("one!\n");
    expect(await impl.readFileAtCommit(record.pinBase, "new.txt")).toBe("fresh\n");
    expect(await impl.readFileAtCommit(record.pinBase, "src/b.txt")).toBeUndefined();
    let [autoCommit] = await impl.gitStore.readCommitLog(record.pinBase, { depth: 1 });
    expect(autoCommit.parents).toEqual([c1]);
    expect(autoCommit.author.name).toBe(USER.name);

    // The merge message records the re-pin, and the live code base re-established it.
    let merge = chatMessages(impl, 1).find(msg => msg.type === "merge")!;
    expect(merge.worktreePins).toEqual([{ worktreeId: id, baseCommit: record.pinBase }]);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: record.pinBase, mergedCommit: record.pinBase }]);

    // Content reconstructs from the log alone in the new epoch: a fresh edit seeds its base
    // from the re-pin, not the stale creation base.
    let codeBase = impl.storage.chatMeta.get(1)!.codeBase!;
    await impl.submitCodeChange(1, {
      generation: codeBase.generation, revision: codeBase.revision,
      clientId: "cli-post", seq: 1,
      change: editChange(id, "a.txt", "one!\n", "one!!\n"),
    }, USER, "user-do");
    expect(await workpieceContent(impl, 1, id)).toEqual({ "a.txt": "one!!\n" });

    // The boundary record marks the worktree bridge-eligible (its re-pin commit is the chat's
    // content at the reset) and not discontinuous.
    let boundary = impl.storage.chatChangeBoundaries.get(1)!;
    expect(boundary.boundaries).toContainEqual({ gadgetId: id, commitId: record.pinBase });
    expect(impl.storage.chatMeta.get(1)!.codeBase!.prior!.discontinuousGadgets).toEqual([]);
  }));

  it("re-pins a clean worktree at its unchanged base, and one matching its head at the head",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Clean: nothing touched this epoch, so the re-pin is the unchanged pin base.
    await impl.mergeChanges(1, USER_META, "client-user");
    expect(impl.storage.gadgets.get(id)!.pinBase).toBe(c1);
    expect(chatMessages(impl, 1).find(msg => msg.type === "merge")!.worktreePins)
        .toEqual([{ worktreeId: id, baseCommit: c1 }]);

    // Edit, then advance the head to a commit capturing exactly that edit (as an explicit
    // commit() would): the accept's flatten equals the head's tree, so the re-pin reuses the
    // head instead of writing an auto-commit.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    let c2 = await impl.gitStore.writeChangedFilesAsCommit(
        new Map([["a.txt", "one!\n"]]),
        { treeBase: c1, parents: [c1], author: { name: "A", email: "a@x" },
          message: "explicit", timestamp: new Date(1700000002_000) });
    await barrier(impl, 1, { worktreeCommits: [{ worktreeId: id, commit: c2, previousHead: c1 }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    let record = impl.storage.gadgets.get(id)!;
    expect(record.pinBase).toBe(c2);
    expect(record.headCommit).toBe(c2);
  }));

  it("squashes auto-commits out of explicit history across accepts", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);

    // Two accepts, each with a dirty epoch: pinBase advances through two auto-commits.
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "two\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "two\n", "three\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    let record = impl.storage.gadgets.get(id)!;
    expect(record.headCommit).toBe(c1);
    expect(record.pinBase).not.toBe(c1);

    // An explicit commit built the way commit() builds one -- tree from pinBase + (empty)
    // overlay, parent on the last explicit head -- skips both auto-commits in its ancestry.
    let explicit = await impl.gitStore.writeChangedFilesAsCommit(
        new Map(), { treeBase: record.pinBase, parents: [record.headCommit],
                     author: { name: "A", email: "a@x" }, message: "explicit",
                     timestamp: new Date(1700000003_000) });
    let [info] = await impl.gitStore.readCommitLog(explicit, { depth: 1 });
    expect(info.parents).toEqual([c1]);
    expect(await impl.readFileAtCommit(explicit, "a.txt")).toBe("three\n");
  }));

  it("carries worktree re-pins into compaction checkpoints", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id } = await createThroughBarrier(impl, 1, c1);
    await barrier(impl, 1, { changes: [{ change: editChange(id, "a.txt", "one\n", "one!\n") }]});
    await impl.mergeChanges(1, USER_META, "client-user");
    let repin = impl.storage.gadgets.get(id)!.pinBase;

    // A checkpoint whose boundary lies past the merge must re-establish the worktree's base
    // from the merge message's worktreePins (pins clear at the boundary).
    let messages = chatMessages(impl, 1);
    let boundary = messages[messages.length - 1].sequence + 1;
    let state = buildCompactionState(messages, boundary, [], undefined);
    expect(state.pins).toContainEqual({ gadgetId: id, baseCommit: repin });
  }));
});
